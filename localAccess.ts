// AetherTerm v0.2: real local files and a real shell, desktop app only.
// Active only when Electron main passes AETHERTERM_TOKEN; in `npm run dev` none
// of this is mounted and nothing else changes.
//
// Lockdown: every HTTP request and every Socket.IO connection must carry the
// per-launch token, either in the HttpOnly cookie Electron sets for the app
// window or in the X-AetherTerm-Token header. The token is never logged.
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import type { Server, Socket } from 'socket.io';
import { timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import { readFileSync, writeFileSync, renameSync } from 'fs';
import os from 'os';
import path from 'path';
import { resolveInRoot, validName, readFolders, PathError } from './desktop/safe-path.mjs';
import { VIRTUAL_HOME } from './vhome.js';

const COOKIE = 'aetherterm_token';
export type Mode = 'sandbox' | 'real';
let currentMode: Mode = 'sandbox';
/** Current mode, for the rest of the server (e.g. media commands). */
export const localMode = (): Mode => currentMode;
/** v0.4: Home follows the mode. Sandbox = the virtual home in the VFS; Real = the real home folder. */
export const homeFor = (m: Mode = currentMode): string => (m === 'real' ? os.homedir() : VIRTUAL_HOME);
const modeListeners: Array<(m: Mode) => void> = [];
/** Called after every mode switch (the server uses it to move the virtual shell home and tell all windows). */
export const onModeChange = (fn: (m: Mode) => void) => { modeListeners.push(fn); };
export const UNLOCK_PHRASE = 'unlock-real-files-and-shell';
const LOCKED = 'Sandbox is on: real files and the real shell are locked.';
const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
};
export const mediaTypeOf = (p: string) => MEDIA_TYPES[path.extname(p).toLowerCase()] || '';
const MAX_READ = 5 * 1024 * 1024;

function tokenOk(expected: Buffer, given: unknown): boolean {
  if (typeof given !== 'string' || !given) return false;
  const b = Buffer.from(given);
  return b.length === expected.length && timingSafeEqual(b, expected);
}

function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function hostOk(host: string | undefined, allowedHosts: string[]): boolean {
  return !allowedHosts.length || (typeof host === 'string' && allowedHosts.includes(host));
}

export function installLocalAccess(app: Express, io: Server, allowedOrigins: string[]) {
  const secret = process.env.AETHERTERM_TOKEN;
  if (!secret) return false;
  delete process.env.AETHERTERM_TOKEN; // keep it out of anything the server spawns
  const expected = Buffer.from(secret);
  const allowedHosts = allowedOrigins.map((o) => o.replace(/^https?:\/\//, ''));
  const home = os.homedir();
  const foldersFile = process.env.AETHERTERM_FOLDERS_FILE || path.join(home, '.config', 'aetherterm', 'folders.json');
  const roots = () => readFolders(foldersFile, home);
  // v0.3 mode: 'sandbox' (default, VFS only) or 'real' (mapped folders + real shell).
  // Replaces the v0.2 shell toggle. Remembered across restarts in mode.json.
  const modeFile = process.env.AETHERTERM_MODE_FILE || path.join(home, '.config', 'aetherterm', 'mode.json');
  let mode: Mode = 'sandbox';
  try { mode = JSON.parse(readFileSync(modeFile, 'utf8')).mode === 'real' ? 'real' : 'sandbox'; } catch {}
  currentMode = mode;
  const setMode = (m: Mode) => {
    mode = m; currentMode = m;
    const tmp = `${modeFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mode: m, changed: new Date().toISOString() }) + '\n', { mode: 0o600 });
    renameSync(tmp, modeFile);
    if (m === 'sandbox') for (const s of sessions) s.kill('Sandbox is on: the real shell was closed.');
    for (const fn of modeListeners) { try { fn(m); } catch (e) { console.error('[aetherterm] mode listener failed:', e); } }
  };
  const isReal = () => mode === 'real';

  const authed = (headers: Record<string, any>) =>
    tokenOk(expected, headers['x-aetherterm-token']) || tokenOk(expected, cookieToken(headers.cookie));

  // 1. Gate every HTTP request (pages, /vfs files, /api) on token + Host.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!hostOk(req.headers.host, allowedHosts)) return res.status(403).json({ error: 'Forbidden host.' });
    if (!authed(req.headers)) return res.status(401).json({ error: 'AetherTerm token required.' });
    next();
  });

  // 2. Gate every Socket.IO namespace the same way.
  const gate = (socket: Socket, next: (err?: Error) => void) => {
    const h = socket.handshake.headers as Record<string, any>;
    if (!hostOk(h.host, allowedHosts)) return next(new Error('forbidden'));
    if (authed(h) || tokenOk(expected, (socket.handshake.auth as any)?.token)) return next();
    next(new Error('unauthorized'));
  };
  io.use(gate);
  // Also refuse at the Engine.IO transport level, so a client without the token
  // can't even complete the low-level handshake.
  const engine: any = (io as any).engine;
  const prevAllow = engine?.opts?.allowRequest;
  if (engine?.opts) {
    engine.opts.allowRequest = (req: any, cb: (err: string | null | undefined, ok: boolean) => void) => {
      if (!hostOk(req.headers.host, allowedHosts) || !authed(req.headers)) return cb('unauthorized', false);
      return prevAllow ? prevAllow(req, cb) : cb(null, true);
    };
  }
  const ptyNs = io.of('/pty');
  ptyNs.use(gate);

  // 3. File API.
  const api = express.Router();
  api.use(express.json({ limit: '25mb' }));

  // Mode switch. Going to 'real' needs the explicit unlock phrase (the UI only
  // sends it from the confirmation dialog); going back to 'sandbox' is one call.
  api.get('/mode', (_req, res) => res.json({ mode, home: homeFor(mode), virtual: mode === 'sandbox' }));
  // v0.4: where "Home" is right now. Sandbox: the virtual home (a VFS path); Real: the real home folder.
  api.get('/home', (_req, res) => res.json({ mode, home: homeFor(mode), virtual: mode === 'sandbox', virtualHome: VIRTUAL_HOME }));
  api.post('/mode', (req, res) => {
    const want = req.body?.mode;
    if (want === 'sandbox') { setMode('sandbox'); return res.json({ mode, home: homeFor(mode) }); }
    if (want === 'real') {
      if (req.body?.confirm !== UNLOCK_PHRASE) return res.status(400).json({ error: 'Confirmation required to unlock real files and shell.' });
      setMode('real'); return res.json({ mode, home: homeFor(mode) });
    }
    res.status(400).json({ error: 'mode must be sandbox or real' });
  });
  // Everything else under /api/local touches real files: refused in sandbox.
  api.use((_req, res, next) => (isReal() ? next() : res.status(403).json({ error: LOCKED, sandbox: true })));
  const fail = (res: Response, e: any) => {
    const status = e instanceof PathError ? e.status : e?.code === 'EEXIST' ? 409 : e?.code === 'ENOENT' ? 404 : e?.code === 'EACCES' ? 403 : 500;
    res.status(status).json({ error: e?.message || String(e) });
  };

  api.get('/roots', async (_req, res) => {
    const list = await roots();
    res.json({ home, roots: list.map((p) => ({ path: p, name: p === home ? `~ (${path.basename(home)})` : path.basename(p) || p })) });
  });

  api.get('/list', async (req, res) => {
    try {
      const list = await roots();
      const r = await resolveInRoot(list, String(req.query.root), String(req.query.path || ''));
      const dirents = await fs.readdir(r.real!, { withFileTypes: true });
      const entries = await Promise.all(dirents.map(async (d) => {
        const full = path.join(r.real!, d.name);
        let type: string = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'link' : 'other';
        let outside = false; let size = 0; let mtime = 0;
        try {
          const st = await fs.stat(full); size = st.size; mtime = st.mtimeMs;
          if (type === 'link') {
            const real = await fs.realpath(full);
            outside = !(real === r.rootReal || real.startsWith(r.rootReal + path.sep));
            type = st.isDirectory() ? 'dir' : 'file';
          }
        } catch { if (type === 'link') { outside = true; type = 'file'; } }
        return { name: d.name, type, link: d.isSymbolicLink(), outside, size, mtime };
      }));
      entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
      res.json({ path: path.relative(r.rootReal, r.real!), entries });
    } catch (e) { fail(res, e); }
  });

  // v0.4: `canvas <file>` in the real shell names an absolute path; map it to its mapped folder.
  const ownerOf = (list: string[], absIn: string) => {
    const abs = path.resolve(String(absIn).replace(/^~(?=$|\/)/, home));
    const owner = list.filter((r) => abs === r || abs.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
    if (!owner) throw new PathError('That file is not in a mapped folder.', 403);
    return { root: owner, rel: path.relative(owner, abs) };
  };

  api.get('/read', async (req, res) => {
    try {
      const list = await roots();
      const where = req.query.abs ? ownerOf(list, String(req.query.abs)) : { root: String(req.query.root), rel: String(req.query.path || '') };
      const r = await resolveInRoot(list, where.root, where.rel);
      const st = await fs.stat(r.real!);
      if (!st.isFile()) throw new PathError('Not a file.', 400);
      if (st.size > MAX_READ) return res.json({ binary: true, tooLarge: true, size: st.size });
      const buf = await fs.readFile(r.real!);
      const binary = buf.includes(0);
      res.json({ binary, size: st.size, mtime: st.mtimeMs, content: binary ? null : buf.toString('utf8') });
    } catch (e) { fail(res, e); }
  });

  api.post('/write', async (req, res) => {
    try {
      const { root, path: rel, content, create } = req.body || {};
      if (typeof content !== 'string') throw new PathError('content must be text.', 400);
      const r = await resolveInRoot(await roots(), root, rel, { mustExist: !create });
      if (create && r.exists) throw Object.assign(new Error('Already exists.'), { code: 'EEXIST' });
      if (r.exists) {
        const st = await fs.stat(r.real!);
        if (!st.isFile()) throw new PathError('Not a file.', 400);
        await fs.writeFile(r.real!, content, 'utf8');
      } else {
        if (!validName(path.basename(r.target))) throw new PathError('Bad name.', 400);
        await fs.writeFile(r.target, content, { encoding: 'utf8', flag: 'wx' });
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  api.post('/mkdir', async (req, res) => {
    try {
      const { root, path: rel } = req.body || {};
      const r = await resolveInRoot(await roots(), root, rel, { mustExist: false });
      if (r.exists) throw Object.assign(new Error('Already exists.'), { code: 'EEXIST' });
      if (!validName(path.basename(r.target))) throw new PathError('Bad name.', 400);
      await fs.mkdir(r.target);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  api.post('/rename', async (req, res) => {
    try {
      const { root, from, to } = req.body || {};
      const list = await roots();
      const a = await resolveInRoot(list, root, from, { mode: 'entry' });
      const b = await resolveInRoot(list, root, to, { mode: 'entry', mustExist: false });
      if (b.exists) throw Object.assign(new Error('A file with that name already exists.'), { code: 'EEXIST' });
      if (!validName(path.basename(b.target))) throw new PathError('Bad name.', 400);
      await fs.rename(a.target, b.target);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  api.get('/shell', (_req, res) => res.json({ enabled: isReal(), shell: loginShell() }));

  // Media from a mapped folder for <video>/<img>/<audio>. Same token cookie as every
  // other route (media tags send it on same-origin requests), same path checks,
  // media types only, Range support, and never rendered as a page.
  api.get('/raw', async (req, res) => {
    try {
      const list = await roots();
      let root = String(req.query.root || ''); let rel = String(req.query.path || '');
      if (req.query.abs) ({ root, rel } = ownerOf(list, String(req.query.abs)));
      const r = await resolveInRoot(list, root, rel);
      const type = mediaTypeOf(r.real!);
      if (!type) throw new PathError('Only images, audio and video can be opened this way.', 415);
      res.sendFile(r.real!, { dotfiles: 'allow', headers: {
        'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
      } }, (err) => { if (err && !res.headersSent) fail(res, err); });
    } catch (e) { fail(res, e); }
  });
  app.use('/api/local', api);

  // 4. Real PTY shell on the /pty namespace.
  let pty: typeof import('node-pty') | null = null;
  let ptyError = '';
  const loadPty = async () => {
    if (pty || ptyError) return pty;
    try { pty = await import('node-pty'); } catch (e: any) { ptyError = e?.message || String(e); }
    return pty;
  };

  // Strip the app's own settings and keys before handing the env to a shell.
  const secretNames = new Set<string>(['ELECTRON_RUN_AS_NODE', 'NODE_ENV', 'HOST', 'PORT', 'GOOGLE_API_KEY', 'AI_STUDIO_API_KEY']);
  try {
    const envFile = process.env.AETHERTERM_ENV_FILE;
    if (envFile) for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/); if (m) secretNames.add(m[1]);
    }
  } catch {}
  const shellEnv = () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || secretNames.has(k) || k.startsWith('AETHERTERM_') || /(_API_KEY|_TOKEN|_SECRET)$/.test(k)) continue;
      env[k] = v;
    }
    env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor'; env.TERM_PROGRAM = 'AetherTerm';
    env.HOME = home; // Real mode: ~ is the real home folder.
    // `canvas <file>` in the real shell: a tiny helper that asks AetherTerm to show the file in the Workspace canvas.
    if (process.env.AETHERTERM_HELPER_BIN) env.PATH = `${process.env.AETHERTERM_HELPER_BIN}:${env.PATH || '/usr/bin:/bin'}`;
    return env;
  };

  const sessions = new Set<{ kill: (why: string) => void }>();
  ptyNs.on('connection', (socket) => {
    let term: any = null;
    const session = {
      kill: (why: string) => {
        if (term) { try { term.kill(); } catch {} term = null; }
        socket.emit('refused', { reason: why });
      },
    };
    sessions.add(session);

    socket.on('start', async (opts: { root?: string; path?: string; cols?: number; rows?: number }) => {
      if (!isReal()) return socket.emit('refused', { reason: LOCKED });
      if (term) return;
      const p = await loadPty();
      if (!p) return socket.emit('refused', { reason: `Shell unavailable: ${ptyError}` });
      let cwd = home;
      try {
        const r = await resolveInRoot(await roots(), String(opts?.root || home), String(opts?.path || ''));
        const st = await fs.stat(r.real!);
        cwd = st.isDirectory() ? r.real! : path.dirname(r.real!);
      } catch (e: any) { return socket.emit('refused', { reason: e?.message || 'Bad folder.' }); }
      const shell = loginShell();
      term = p.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: Math.max(20, Math.min(500, Number(opts?.cols) || 100)),
        rows: Math.max(5, Math.min(200, Number(opts?.rows) || 30)),
        cwd, env: shellEnv(),
      });
      const mine = term;
      socket.emit('started', { shell, cwd, pid: mine.pid });
      mine.onData((d: string) => socket.emit('data', d));
      mine.onExit(({ exitCode }: { exitCode: number }) => { if (term === mine) term = null; socket.emit('exit', { exitCode }); });
    });
    socket.on('input', (d: unknown) => {
      if (!isReal()) return session.kill(LOCKED);
      if (term && typeof d === 'string') term.write(d);
    });
    socket.on('resize', (s: { cols?: number; rows?: number }) => {
      if (term && s?.cols && s?.rows) try { term.resize(Math.min(500, s.cols), Math.min(200, s.rows)); } catch {}
    });
    socket.on('stop', () => { if (term) { try { term.kill(); } catch {} term = null; } });
    socket.on('disconnect', () => { if (term) { try { term.kill(); } catch {} term = null; } sessions.delete(session); });
  });

  const shutdown = () => {
    for (const s of sessions) { try { s.kill('AetherTerm is closing.'); } catch {} }
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log('[aetherterm] Local files and shell enabled (token required).');
  return true;
}

function loginShell(): string {
  try { const s = os.userInfo().shell; if (s) return s; } catch {}
  return process.env.SHELL || '/bin/bash';
}
