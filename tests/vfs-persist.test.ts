// v0.4: the VFS is the single source of truth for the Sandbox.
// Starts the real server twice on a throwaway sync root and checks that what the
// virtual shell creates (mkdir/touch) is on disk and still there after a restart,
// and that Milla's output goes under the Sandbox home (~/milla/...), not /home/Milla-Rayne.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { millaPath, MILLA_DIRS, VIRTUAL_HOME } from '../vhome';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aeth-vfs-test-'));
const SYNC = path.join(ROOT, 'files');
const PORT = 47600 + Math.floor(Math.random() * 300);
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const procs: ChildProcess[] = [];

function startServer(): Promise<ChildProcess> {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'dist', 'index.html'), '<!doctype html><title>test</title>');
  fs.writeFileSync(path.join(ROOT, 'empty.env'), '');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production',
    PORT: String(PORT), HOST: '127.0.0.1', AETHERTERM_TOKEN: TOKEN,
    AETHERTERM_ALLOWED_ORIGINS: `http://127.0.0.1:${PORT}`,
    AETHERTERM_SYNC_ROOT: SYNC, AETHERTERM_VFS_ROOT: path.join(ROOT, 'vfs'),
    AETHERTERM_HISTORY_FILE: path.join(ROOT, 'history.json'),
    AETHERTERM_MODE_FILE: path.join(ROOT, 'mode.json'), AETHERTERM_FOLDERS_FILE: path.join(ROOT, 'folders.json'),
    AETHERTERM_ENV_FILE: path.join(ROOT, 'empty.env'), AETHERTERM_DIST_DIR: path.join(ROOT, 'dist'),
    OLLAMA_URL: 'http://127.0.0.1:9', // never reach a real model from tests
  };
  const p = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { env, cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30000);
    const onData = (b: Buffer) => { if (/running on|listening|http:\/\/127\.0\.0\.1/i.test(String(b))) { clearTimeout(t); resolve(p); } };
    p.stdout!.on('data', onData); p.stderr!.on('data', onData);
    p.on('exit', (c) => { clearTimeout(t); reject(new Error('server exited ' + c)); });
  });
}
function stop(p: ChildProcess) { return new Promise<void>((r) => { p.removeAllListeners('exit'); p.once('exit', () => r()); p.kill('SIGTERM'); setTimeout(() => { p.kill('SIGKILL'); r(); }, 5000); }); }

const seen = new Set<string>(); // VFS paths the client received
async function shell(cmds: string[]): Promise<string[]> {
  const s = connect(`http://127.0.0.1:${PORT}`, { auth: { token: TOKEN }, extraHeaders: { 'x-aetherterm-token': TOKEN }, transports: ['websocket'] });
  const out: string[] = [];
  seen.clear();
  s.on('sync_vfs', (nodes: any[]) => { for (const n of nodes || []) seen.add(n.path); });
  s.on('sync_history', (e: any) => { if (e?.text) out.push(String(e.text)); });
  await new Promise<void>((r, j) => { s.on('connect', () => r()); s.on('connect_error', j); });
  for (const c of cmds) { s.emit('input', { text: c }); await new Promise((r) => setTimeout(r, 400)); }
  s.close();
  return out;
}

after(async () => { for (const p of procs) if (p.exitCode === null) await stop(p); fs.rmSync(ROOT, { recursive: true, force: true }); });

test("Milla's folders are under the Sandbox home", () => {
  assert.equal(MILLA_DIRS.apps, `${VIRTUAL_HOME}/milla/apps`);
  assert.equal(millaPath('apps', 'app-1.html'), '/home/danny/milla/apps/app-1.html');
  const evil = millaPath('media', '../../etc/passwd');
  assert.ok(evil.startsWith(MILLA_DIRS.media + '/') && !evil.slice(MILLA_DIRS.media.length + 1).includes('/'), evil);
  assert.ok(!millaPath('media', 'x.png').includes('Milla-Rayne'));
});

test('mkdir/touch in the Sandbox shell persist on disk and across a restart', async () => {
  let p = await startServer();
  const out1 = await shell(['mkdir -p ~/proj/sub', 'touch ~/proj/sub/notes.md ~/proj/readme.txt', 'mkdir ~/proj']);
  assert.ok(fs.statSync(path.join(SYNC, 'home/danny/proj/sub')).isDirectory(), 'dir on disk');
  assert.ok(fs.existsSync(path.join(SYNC, 'home/danny/proj/sub/notes.md')), 'file on disk');
  assert.ok(fs.existsSync(path.join(SYNC, 'home/danny/proj/readme.txt')), 'second file on disk');
  assert.ok(out1.some((t) => /File exists/.test(t)), 'mkdir without -p on an existing dir still errors');
  await stop(p);

  p = await startServer();
  const out2 = await shell(['ls ~/proj', 'ls ~/proj/sub']);
  const joined = out2.join('\n');
  assert.match(joined, /sub/);
  assert.match(joined, /readme\.txt/);
  assert.match(joined, /notes\.md/);
  // the explorer gets the whole tree on connect (it used to see only session changes)
  for (const p2 of ['/home/danny', '/home/danny/proj', '/home/danny/proj/sub/notes.md']) assert.ok(seen.has(p2), `client got ${p2}`);
  await stop(p);
});
