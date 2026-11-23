// AetherTerm desktop shell (Electron main process).
// Runs the AetherTerm server (server/server.mjs) as a child process bound to
// 127.0.0.1 and shows it in a normal app window. All user state lives in XDG
// folders so it survives a quit, relaunch or reboot:
//   config  $XDG_CONFIG_HOME/aetherterm   aetherterm.env, window-state.json, browser profile (localStorage)
//   data    $XDG_DATA_HOME/aetherterm     files/ (two-way synced VFS), vfs/ (generated media)
//   state   $XDG_STATE_HOME/aetherterm    server.log
import { app, BrowserWindow, Menu, shell, dialog, ipcMain, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { resolveInRoot, readFolders } from './safe-path.mjs';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const xdg = (name, fallback) => process.env[name] || path.join(HOME, fallback);
const CONFIG_DIR = path.join(xdg('XDG_CONFIG_HOME', '.config'), 'aetherterm');
const DATA_DIR = path.join(xdg('XDG_DATA_HOME', '.local/share'), 'aetherterm');
const STATE_DIR = path.join(xdg('XDG_STATE_HOME', '.local/state'), 'aetherterm');
const ENV_FILE = path.join(CONFIG_DIR, 'aetherterm.env');
const WINDOW_STATE = path.join(CONFIG_DIR, 'window-state.json');
const LOG_FILE = path.join(STATE_DIR, 'server.log');
const DEFAULT_PORT = 47333;
const FOLDERS_FILE = path.join(CONFIG_DIR, 'folders.json');
// v0.3: 'sandbox' (default) or 'real'. The server owns and writes it; main only reads it.
const MODE_FILE = path.join(CONFIG_DIR, 'mode.json');
function isRealMode() {
  try { return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode === 'real'; } catch { return false; }
}
const SANDBOX_LOCKED = 'Sandbox is on: real files are locked. Switch to Real files and shell first.';
// Per-launch secret. Goes to the server child (env, deleted there on read) and
// to the window as an HttpOnly cookie, so page scripts can't read it either.
const TOKEN = randomBytes(32).toString('base64url');
let appOrigin = '';

for (const dir of [CONFIG_DIR, DATA_DIR, STATE_DIR, path.join(DATA_DIR, 'files'), path.join(DATA_DIR, 'vfs')]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Same name everywhere: WM_CLASS / Wayland app_id match the .desktop file.
app.setName('AetherTerm');
app.setPath('userData', CONFIG_DIR);
process.env.CHROME_DESKTOP = 'aetherterm.desktop';
app.commandLine.appendSwitch('class', 'aetherterm');
if (typeof app.setDesktopName === 'function') app.setDesktopName('aetherterm.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ENV_TEMPLATE = `# AetherTerm settings. Read at every launch. Keep this file private (chmod 600).
# Uncomment and fill in only what you use. Local chat needs nothing here.
#
# OLLAMA_URL=http://127.0.0.1:11434
# OLLAMA_MODEL=devmilla:latest
# OLLAMA_FAST_MODEL=
#
# Optional cloud providers:
# GEMINI_API_KEY=
# GEMINI_MODEL=
# GEMINI_IMAGE_MODEL=
# GEMINI_VIDEO_MODEL=
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GITHUB_TOKEN=
#
# Folder synced with the in-app file tree (default: ~/.local/share/aetherterm/files)
# AETHERTERM_SYNC_ROOT=
# Local port for the app's built-in server (default ${DEFAULT_PORT})
# AETHERTERM_PORT=
`;
if (!fs.existsSync(ENV_FILE)) fs.writeFileSync(ENV_FILE, ENV_TEMPLATE, { mode: 0o600 });

function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch {}
  return out;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 20; p++) if (await portFree(p)) return p;
  throw new Error(`No free port between ${preferred} and ${preferred + 19}.`);
}

function waitForServer(port, child, timeoutMs = 90000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let exited = false;
    child.once('exit', (code) => { exited = true; reject(new Error(`AetherTerm server exited (code ${code}).`)); });
    const tick = () => {
      if (exited) return;
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error('AetherTerm server did not start in time.'));
      else setTimeout(tick, 300);
    };
    tick();
  });
}

let serverChild = null;
let mainWindow = null;

function startServer(port, userEnv) {
  const log = fs.openSync(LOG_FILE, 'a', 0o600);
  fs.writeSync(log, `\n=== ${new Date().toISOString()} starting AetherTerm on 127.0.0.1:${port}\n`);
  const env = {
    ...process.env,
    ...userEnv,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    AETHERTERM_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    AETHERTERM_TOKEN: TOKEN,
    AETHERTERM_FOLDERS_FILE: FOLDERS_FILE,
    AETHERTERM_MODE_FILE: MODE_FILE,
    PORT: String(port),
    AETHERTERM_ENV_FILE: ENV_FILE,
    AETHERTERM_DIST_DIR: path.join(APP_DIR, 'dist'),
    AETHERTERM_VFS_ROOT: userEnv.AETHERTERM_VFS_ROOT || path.join(DATA_DIR, 'vfs'),
    AETHERTERM_SYNC_ROOT: userEnv.AETHERTERM_SYNC_ROOT || path.join(DATA_DIR, 'files'),
    AETHERTERM_HISTORY_FILE: path.join(DATA_DIR, 'history.json'),
    AETHERTERM_HELPER_BIN: path.join(APP_DIR, 'bin'),
  };
  serverChild = spawn(process.execPath, [path.join(APP_DIR, 'server', 'server.mjs')], {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', log, log],
  });
  return serverChild;
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE, 'utf8'));
    if (s.width > 200 && s.height > 200) return s;
  } catch {}
  return { width: 1280, height: 820 };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  const s = { ...b, maximized: win.isMaximized(), savedAt: new Date().toISOString() };
  fs.writeFileSync(WINDOW_STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// Window colours shown before the web UI loads (Electron main can't read the renderer's CSS).
// They mirror src/theme.css: --color-surface-0 and --color-glow-300. See THEMING.md.
const WINDOW_BG = '#0a0b0d';
const WINDOW_TEXT = '#9dd3dd';

function splash(text) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    `<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:${WINDOW_BG};color:${WINDOW_TEXT};font:15px ui-monospace,monospace"><div>${text}</div></body></html>`);
}

async function createWindow() {
  const state = loadWindowState();
  const iconPng = path.join(APP_DIR, 'desktop', 'aetherterm.png');
  mainWindow = new BrowserWindow({
    title: 'AetherTerm',
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: WINDOW_BG,
    icon: fs.existsSync(iconPng) ? iconPng : undefined,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(APP_DIR, 'desktop', 'preload.cjs') },
  });
  if (state.maximized) mainWindow.maximize();
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(splash('Starting AetherTerm…'));

  const userEnv = readEnvFile(ENV_FILE);
  const port = await pickPort(Number(process.env.AETHERTERM_PORT || userEnv.AETHERTERM_PORT || DEFAULT_PORT));
  const origin = `http://127.0.0.1:${port}`;
  appOrigin = origin;

  // Keep the app inside its own origin; send other links to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin) || url.startsWith('blob:') || url === 'about:blank') return { action: 'allow' };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  // v0.3 canvas: previews live in sandboxed srcdoc iframes. They may not navigate
  // anywhere real (outside sites or the app's own server); only about:/data:/blob:.
  mainWindow.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    if (!/^(about:(blank|srcdoc)|data:|blob:)/i.test(e.url)) e.preventDefault();
  });

  try {
    const child = startServer(port, userEnv);
    await waitForServer(port, child);
    await session.defaultSession.cookies.set({ url: origin, name: 'aetherterm_token', value: TOKEN, httpOnly: true, sameSite: 'strict', path: '/' });
    await mainWindow.loadURL(origin + '/');
  } catch (err) {
    await mainWindow.loadURL(splash(`AetherTerm could not start: ${String(err.message || err)}<br><br>Log: ${LOG_FILE}`));
    return;
  }

  // Optional self-test hook for packaging checks: AETHERTERM_SCREENSHOT=/path.png
  if (process.env.AETHERTERM_SCREENSHOT) {
    setTimeout(async () => {
      try {
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.AETHERTERM_SCREENSHOT, img.toPNG());
      } catch (e) { console.error('screenshot failed', e); }
      if (process.env.AETHERTERM_QUIT_AFTER_SHOT === '1') app.quit();
    }, Number(process.env.AETHERTERM_SCREENSHOT_DELAY || 6000));
  }
}

// ---- v0.2 IPC: folder picker, mapped folders, move to trash ----------------
const fromApp = (e) => {
  const url = e.senderFrame?.url || '';
  return !!appOrigin && (url === appOrigin || url.startsWith(appOrigin + '/')) && e.senderFrame === mainWindow?.webContents.mainFrame;
};
async function currentFolders() { return readFolders(FOLDERS_FILE, HOME); }
function saveFolders(list) {
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify({ folders: [...new Set(list)] }, null, 2), { mode: 0o600 });
}
if (!fs.existsSync(FOLDERS_FILE)) saveFolders([HOME]);

ipcMain.handle('aether:folders', async (e) => { if (!fromApp(e)) throw new Error('denied'); return currentFolders(); });
ipcMain.handle('aether:pick-folder', async (e) => {
  if (!fromApp(e)) throw new Error('denied');
  if (!isRealMode()) throw new Error(SANDBOX_LOCKED);
  let picked = null;
  if (process.env.AETHERTERM_TEST_PICK_FOLDER) {
    picked = process.env.AETHERTERM_TEST_PICK_FOLDER; // packaging self-test only
  } else {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Open folder in AetherTerm', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { added: null, folders: await currentFolders() };
    picked = r.filePaths[0];
  }
  const real = fs.realpathSync(picked);
  const list = await currentFolders();
  if (!list.includes(real)) list.push(real);
  saveFolders(list);
  return { added: real, folders: list };
});
ipcMain.handle('aether:remove-folder', async (e, folder) => {
  if (!fromApp(e)) throw new Error('denied');
  if (!isRealMode()) throw new Error(SANDBOX_LOCKED);
  const list = (await currentFolders()).filter((f) => f !== folder);
  saveFolders(list.length ? list : [HOME]);
  return currentFolders();
});
// XDG Trash: `gio trash` (GLib, follows the freedesktop Trash spec, no D-Bus
// needed), then Electron's own trashItem. Never a hard delete.
function moveToTrash(target) {
  return new Promise((resolve, reject) => {
    execFile('gio', ['trash', '--', target], { timeout: 15000 }, async (err) => {
      if (!err) return resolve();
      try { await shell.trashItem(target); resolve(); }
      catch (e) { reject(new Error(`Could not move to Trash (${err.message.split('\n')[0]}; ${e.message})`)); }
    });
  });
}

ipcMain.handle('aether:trash', async (e, root, rel) => {
  if (!fromApp(e)) throw new Error('denied');
  if (!isRealMode()) throw new Error(SANDBOX_LOCKED);
  // The renderer has already shown the confirmation; re-check the path here.
  const r = await resolveInRoot(await currentFolders(), root, rel, { mode: 'entry' });
  await moveToTrash(r.target);
  return { ok: true, trashed: r.target };
});

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

function stopServer() {
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    const c = serverChild;
    setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL'); }, 3000).unref();
  }
}
app.on('before-quit', () => { if (mainWindow) saveWindowState(mainWindow); });
app.on('will-quit', stopServer);
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open Settings File', click: () => shell.openPath(ENV_FILE) },
      { label: 'Open Files Folder', click: () => shell.openPath(readEnvFile(ENV_FILE).AETHERTERM_SYNC_ROOT || path.join(DATA_DIR, 'files')) },
      { label: 'Open Log', click: () => shell.openPath(LOG_FILE) },
      { type: 'separator' }, { role: 'quit' } ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'About AetherTerm', click: () => dialog.showMessageBox({ message: `AetherTerm ${app.getVersion()}`, detail: `Settings: ${ENV_FILE}\nData: ${DATA_DIR}\nLog: ${LOG_FILE}` }) }] },
  ]));
  return createWindow();
});
