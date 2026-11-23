import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { ViteDevServer } from 'vite';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import {
  GoogleGenAI,
  HarmCategory,
  HarmBlockThreshold,
} from '@google/genai';
import { config } from 'dotenv';
import {
  scanDisk,
  startWatcher,
  writeThrough,
  markSelfWrite,
  deleteThrough,
  readDiskNode,
  getSyncRoot,
  safeResolve,
  writeBinaryThrough,
  type SyncVFSNode,
} from './diskSync.js';
import OpenAI from 'openai';
import { installLocalAccess, localMode, mediaTypeOf, homeFor, onModeChange } from './localAccess.js';
import { VIRTUAL_HOME, resolveV, displayV, millaPath, MILLA_DIRS } from './vhome.js';
import { asMilla } from './milla.js';
import { loadHistory, autosaveHistory, HISTORY_FILE } from './localStore.js';
import Anthropic from '@anthropic-ai/sdk';

// Desktop app: AETHERTERM_ENV_FILE points at ~/.config/aetherterm/aetherterm.env.
// Unset (dev), dotenv reads ./.env exactly as before.
config({ ...(process.env.AETHERTERM_ENV_FILE ? { path: process.env.AETHERTERM_ENV_FILE } : {}), override: true });
// @google/genai warns and prefers GOOGLE_API_KEY whenever both names exist.
const geminiKeyFromEnv = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.AI_STUDIO_API_KEY;
if (geminiKeyFromEnv) {
  process.env.GEMINI_API_KEY = geminiKeyFromEnv;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.AI_STUDIO_API_KEY;
}

const app = express();
const httpServer = createServer(app);
// Desktop app: only the app's own window may open a socket. Without this, any web
// page in a browser on this machine could connect to 127.0.0.1 and drive the
// terminal. Unset (dev), behaviour is unchanged.
const allowedOrigins = (process.env.AETHERTERM_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : '*',
  },
  ...(allowedOrigins.length ? {
    allowRequest: (req: any, callback: (err: string | null | undefined, ok: boolean) => void) => {
      // Browsers always send Origin on cross-site requests and WebSockets; same-origin
      // polling GETs may omit it. The Host check also blocks DNS-rebinding pages.
      const origin = req.headers.origin;
      const host = req.headers.host;
      const originOk = origin === undefined || allowedOrigins.includes(origin);
      const hostOk = typeof host === 'string' && allowedOrigins.some((o) => o.replace(/^https?:\/\//, '') === host);
      callback(null, originOk && hostOk);
    },
  } : {}),
  // Uploads arrive as base64 data URLs over the socket; the socket.io
  // default buffer (1MB) silently drops anything bigger.
  maxHttpBufferSize: 25 * 1024 * 1024,
});

// v0.2 desktop: token lockdown, local folders and a real shell (no-op without AETHERTERM_TOKEN).
installLocalAccess(app, io, allowedOrigins);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.AI_STUDIO_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let genAI: GoogleGenAI | null = null;
let openAI: OpenAI | null = null;
let anthropic: Anthropic | null = null;

const geminiSafety = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

if (GEMINI_API_KEY) {
  genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

async function geminiText(prompt: string, systemInstruction?: string, maxOutputTokens = 800): Promise<string> {
  if (!genAI) throw new Error('Gemini API key not configured.');
  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      systemInstruction,
      maxOutputTokens,
      temperature: 0.7,
      topP: 0.8,
      topK: 40,
      thinkingConfig: { thinkingBudget: 0 },
      safetySettings: geminiSafety,
    },
  });
  return response.text || '';
}

const MILLA_NAME = 'Milla';
const collabTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
const videoOps = new Map<string, any>();

async function ollamaChat(messages: Array<{ role: string; content: string }>, model = activeModel): Promise<string> {
  // node:http, streamed: Ollama only sends headers once a request reaches the front of
  // its queue, and fetch() gives up after 5 minutes ("fetch failed") when other apps keep
  // the local model busy. Here the only limit is a 15-minute overall cap.
  const url = new URL('/api/chat', OLLAMA_URL);
  const body = JSON.stringify({ model, messages, stream: true });
  const lib = url.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return new Promise<string>((resolve, reject) => {
    let out = ''; let buf = '';
    const req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      if ((res.statusCode || 500) >= 400) { res.resume(); return reject(new Error(`Ollama returned status ${res.statusCode}`)); }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (j.error) { req.destroy(); return reject(new Error(`Ollama: ${j.error}`)); }
            out += j.message?.content || '';
          } catch { /* partial line */ }
        }
      });
      res.on('end', () => resolve(out));
      res.on('error', reject);
    });
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('The local model took longer than 15 minutes (Ollama may be busy with other apps).')));
    req.on('error', (e: any) => reject(new Error(e?.code === 'ECONNREFUSED' ? 'Ollama is not running on ' + OLLAMA_URL : e?.message || String(e))));
    req.end(body);
  });
}

function extractHtml(text: string): string {
  let html = text.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
  const doc = html.search(/<!doctype html|<html/i);
  if (doc > 0) html = html.slice(doc);
  const end = html.toLowerCase().lastIndexOf('</html>');
  if (end >= 0) html = html.slice(0, end + '</html>'.length);
  return html;
}

async function generateAppHtml(prompt: string): Promise<string> {
  const system = 'You are Milla, building a single self-contained HTML page with embedded CSS and JavaScript. Return only the document, starting with <!DOCTYPE html> and ending with </html>. No markdown fences and no explanation.';
  try {
    if (genAI) {
      const html = extractHtml(await geminiText(prompt, system, 8192));
      if (/<html/i.test(html)) return html;
    }
  } catch (error) {
    console.error('Gemini app generation failed, trying local Ollama:', error);
  }
  const html = extractHtml(await ollamaChat([
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ]));
  if (!/<html/i.test(html)) throw new Error('The model did not return an HTML document.');
  return html;
}

if (OPENAI_API_KEY) {
  openAI = new OpenAI({ apiKey: OPENAI_API_KEY });
}

if (ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

// Firebase (cloud sign-in, Firestore history, Admin SDK) was removed in v0.2.
// Everything is local: files via diskSync, history in localStore.ts.

let onlineUsers = new Set<string>();

function presenceNames() {
  return [MILLA_NAME, ...Array.from(onlineUsers).filter((name) => name !== MILLA_NAME)];
}

const VFS_ROOT = process.env.AETHERTERM_VFS_ROOT || path.join(import.meta.dirname, '.vfs_workspace');

type VFSNode = {
  path: string;
  type: 'file' | 'directory';
  content?: string;
  children?: string[];
  createdAt: number;
  updatedAt: number;
  ownerId: string;
  binary?: boolean;
};

let vfs: { [path: string]: VFSNode } = {};

/**
 * v0.4: the one way the server adds or changes a Sandbox file or folder.
 * The VFS and its disk mirror (SYNC_ROOT) always change together, so whatever
 * the shell or Milla creates is still there after a restart. Missing parent
 * folders are created too. Returns the nodes that changed (already broadcast).
 */
async function vfsPut(
  p: string,
  node: { type: 'file' | 'directory'; content?: string; bytes?: Buffer },
  ownerId = 'system',
): Promise<VFSNode[] | null> {
  if (!safeResolve(p)) return null;
  const now = Date.now();
  const changed: VFSNode[] = [];
  // 1. parents, top-down
  const segs = p.split('/').filter(Boolean);
  let parent = '/';
  if (!vfs['/']) vfs['/'] = { path: '/', type: 'directory', children: [], createdAt: now, updatedAt: now, ownerId: 'system' };
  for (let i = 0; i < segs.length - 1; i++) {
    const dir = '/' + segs.slice(0, i + 1).join('/');
    if (!vfs[dir]) {
      vfs[dir] = { path: dir, type: 'directory', children: [], createdAt: now, updatedAt: now, ownerId };
      changed.push(vfs[dir]);
    } else if (vfs[dir].type !== 'directory') {
      return null;
    }
    const par = vfs[parent];
    if (par && !par.children?.includes(dir)) { (par.children = par.children || []).push(dir); if (!changed.includes(par)) changed.push(par); }
    parent = dir;
  }
  // 2. the node itself
  const prev = vfs[p];
  const next: VFSNode = node.type === 'directory'
    ? { path: p, type: 'directory', children: prev?.children || [], createdAt: prev?.createdAt ?? now, updatedAt: now, ownerId: prev?.ownerId ?? ownerId }
    : { path: p, type: 'file', content: node.bytes ? '' : (node.content ?? prev?.content ?? ''), ...(node.bytes ? { binary: true } : {}), createdAt: prev?.createdAt ?? now, updatedAt: now, ownerId: prev?.ownerId ?? ownerId };
  vfs[p] = next;
  changed.push(next);
  const par = vfs[parent];
  if (par && p !== '/' && !par.children?.includes(p)) { (par.children = par.children || []).push(p); if (!changed.includes(par)) changed.push(par); }
  // 3. disk
  const ok = node.bytes
    ? await writeBinaryThrough(p, node.bytes)
    : await writeThrough(p, { type: next.type, content: next.content });
  if (!ok) return null;
  io.emit('sync_vfs', changed);
  return changed;
}

async function initializeVFS() {
  // Primary source of truth: local disk sync root (two-way sync).
  console.log(`Initializing VFS from disk sync root: ${getSyncRoot()}`);
  try {
    const diskNodes = await scanDisk();
    for (const [vfsPath, node] of diskNodes) {
      // Only fill gaps — do not clobber anything already in memory.
      if (!vfs[vfsPath]) {
        vfs[vfsPath] = node as unknown as VFSNode;
      }
    }
    console.log(`VFS seeded from disk: ${diskNodes.size} nodes.`);
  } catch (error) {
    console.error('Disk scan failed during VFS init:', error);
  }

}

/**
 * Disk → VFS → clients propagation.
 * Called by the file watcher when something changes on local disk.
 * Last-write-wins: the disk state is authoritative here.
 */
async function applyDiskChange(kind: 'upsert' | 'delete', vfsPath: string) {
  if (kind === 'delete') {
    if (vfs[vfsPath]) {
      delete vfs[vfsPath];
      // Prune from parent children lists.
      const parentPath = path.dirname(vfsPath).replace(/\\/g, '/');
      const parent = vfs[parentPath];
      if (parent && parent.type === 'directory' && parent.children) {
        parent.children = parent.children.filter((c) => c !== vfsPath && !c.startsWith(vfsPath + '/'));
        io.emit('sync_vfs', [parent]);
      }
      io.emit('purge_vfs_paths', [vfsPath]);
      console.log(`[diskSync] disk delete propagated: ${vfsPath}`);
    }
    return;
  }
  // upsert
  const diskNode = await readDiskNode(vfsPath);
  if (!diskNode) return; // unreadable (binary/too large) — leave VFS alone
  const prev = vfs[vfsPath];
  vfs[vfsPath] = { ...(diskNode as unknown as VFSNode), updatedAt: Date.now() };
  // Ensure parent linkage.
  const parentPath = path.dirname(vfsPath).replace(/\\/g, '/');
  if (parentPath !== vfsPath && vfs[parentPath] && vfs[parentPath].type === 'directory') {
    if (!vfs[parentPath].children?.includes(vfsPath)) {
      vfs[parentPath].children!.push(vfsPath);
      io.emit('sync_vfs', [vfs[parentPath]]);
    }
  }
  if (prev && prev.type === 'file' && diskNode.type === 'file' && prev.content !== diskNode.content) {
    console.log(`[diskSync] disk edit propagated (last-write-wins): ${vfsPath}`);
  } else if (!prev) {
    console.log(`[diskSync] disk create propagated: ${vfsPath}`);
  }
  io.emit('sync_vfs', [vfs[vfsPath]]);
}

async function ensureDir(dirPath: string) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    // ignore if dir exists
  }
}

async function syncVFSFromLocal(dirPath: string, vfsPathPrefix = '') {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const vfsPath = vfsPathPrefix || '/';
  
  if (!vfs[vfsPath]) {
    vfs[vfsPath] = {
      path: vfsPath,
      type: 'directory',
      children: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ownerId: 'system',
    };
  }

  for (const entry of entries) {
    const localPath = path.join(dirPath, entry.name);
    const currentVfsPath = path.join(vfsPath, entry.name).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (!vfs[currentVfsPath]) {
        vfs[currentVfsPath] = {
          path: currentVfsPath,
          type: 'directory',
          children: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ownerId: 'system',
        };
      }
      if (vfs[vfsPath] && vfs[vfsPath].type === 'directory' && !vfs[vfsPath].children?.includes(currentVfsPath)) {
        vfs[vfsPath].children?.push(currentVfsPath);
      }
      await syncVFSFromLocal(localPath, currentVfsPath);
    } else {
      if (!vfs[currentVfsPath]) {
         const content = await fs.readFile(localPath, 'utf-8');
         vfs[currentVfsPath] = {
          path: currentVfsPath,
          type: 'file',
          content,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ownerId: 'system',
        };
      }
       if (vfs[vfsPath] && vfs[vfsPath].type === 'directory' && !vfs[vfsPath].children?.includes(currentVfsPath)) {
        vfs[vfsPath].children?.push(currentVfsPath);
      }
    }
  }
}


// VFS changes already reach disk through diskSync's writeThrough; nothing else to persist.
async function persistVFSNode(_node: VFSNode, _user: any) {}
async function deleteVFSNode(_path: string, _user: any) {}

type HistoryEntry = {
    id: string;
    type: 'input' | 'output' | 'error';
    text: string;
    user: string;
    timestamp: number;
    isError?: boolean;
    isChat?: boolean;
    sender?: string;
};

let history: HistoryEntry[] = [];

async function initializeHistory() {
  history = loadHistory<HistoryEntry>();
  for (const e of history.filter((h) => h.isChat).slice(-8)) {
    collabTurns.push(e.sender === MILLA_NAME ? { role: 'assistant', content: e.text } : { role: 'user', content: `${e.sender || 'Danny'}: ${e.text}` });
  }
  autosaveHistory(() => history);
  console.log(`History: ${history.length} entries from ${HISTORY_FILE}`);
}

// Saved automatically by autosaveHistory (local file), so nothing to do per entry.
function persistHistoryEntry(_entry: HistoryEntry, _user: any) {}

const OLLAMA_URL = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'devmilla:latest';
// true/false if Ollama answered, null if it could not be reached (then trust the pick).
async function ollamaHasModel(name: string): Promise<boolean | null> {
  try {
    const r = await fetch(new URL('/api/tags', OLLAMA_URL), { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const want = name.includes(':') ? name : name + ':latest';
    return Array.isArray(j?.models) && j.models.some((x: any) => x?.name === want || x?.model === want);
  } catch { return null; }
}
// The model Danny picked in Settings (sent by the app); Milla's voice stays the same either way.
let activeModel = OLLAMA_MODEL;

// v0.4: the virtual shell's working directory, per window. Starts at the virtual home.
const shellCwd = new Map<string, string>();
const shellState = (id: string) => {
  const cwd = shellCwd.get(id) || VIRTUAL_HOME;
  const mode = localMode();
  return { mode, home: homeFor(mode), virtualHome: VIRTUAL_HOME, cwd, display: displayV(cwd) };
};
// Home follows the mode: on every switch the virtual shell goes back to its home and
// every window is told where Home is now (no restart needed).
onModeChange((mode) => {
  for (const id of shellCwd.keys()) shellCwd.set(id, VIRTUAL_HOME);
  for (const [id, s] of io.of('/').sockets) s.emit('shell_home', { ...shellState(id), mode });
  console.log(`[aetherterm] mode ${mode}: home is ${homeFor(mode)}`);
});

io.on('connection', async (socket) => {
  console.log('a user connected');
  shellCwd.set(socket.id, VIRTUAL_HOME);
  socket.emit('shell_home', shellState(socket.id));
  // v0.4: send the whole Sandbox VFS on connect. The explorer used to show only what
  // changed during the session, so after a restart ~ and its files were missing from it.
  socket.emit('sync_vfs', Object.values(vfs));
  socket.on('shell_state', () => socket.emit('shell_home', shellState(socket.id)));
  let currentUser: any = null;
  socket.emit('ollama_defaults', { model: OLLAMA_MODEL, url: OLLAMA_URL });
  socket.emit('users_update', presenceNames());

  socket.on('join', (data: { username?: string }) => {
    const name = (data?.username || 'Danny').trim() || 'Danny';
    if (currentUser?.displayName && currentUser.displayName !== name) {
      onlineUsers.delete(currentUser.displayName);
    }
    currentUser = { uid: currentUser?.uid || socket.id, displayName: name };
    if (name !== MILLA_NAME) onlineUsers.add(name);
    io.emit('users_update', presenceNames());
    socket.emit('sync_all_history', history.slice(-200));
  });

  socket.on('use_model', async (data: { model?: string }) => {
    const m = typeof data?.model === 'string' ? data.model.trim() : '';
    if (!m || m.length >= 200) return;
    // A model saved in Settings may not exist on this Ollama (e.g. a smaller Ollama instance
    // only holds small models). Fall back to the configured default instead of failing.
    const has = await ollamaHasModel(m);
    if (has === false) {
      console.warn(`Model ${m} is not on ${OLLAMA_URL}; using ${OLLAMA_MODEL}.`);
      activeModel = OLLAMA_MODEL;
      socket.emit('ollama_model_fallback', { requested: m, model: OLLAMA_MODEL, url: OLLAMA_URL });
    } else {
      activeModel = m;
    }
  });

  socket.on('chat_message', async (data: { message?: string }) => {
    const text = (data?.message || '').trim();
    if (!text) return;
    const sender = currentUser?.displayName || 'Danny';
    const spoken: HistoryEntry = {
      id: `${Date.now()}-${Math.random()}`,
      type: 'output',
      text,
      user: sender,
      isChat: true,
      sender,
      timestamp: Date.now(),
    };
    history.push(spoken);
    io.emit('sync_history', spoken);
    if (sender === MILLA_NAME) return;

    collabTurns.push({ role: 'user', content: `${sender}: ${text}` });
    const recent = collabTurns.slice(-8);
    io.emit('milla_typing', true);
    try {
      const reply = await ollamaChat([
        {
          role: 'system',
          content: asMilla('You are in the AetherTerm room chat with Danny and anyone he invites. Two or three sentences.'),
        },
        ...recent,
      ]);
      const said = reply.trim() || 'I\'m here.';
      collabTurns.push({ role: 'assistant', content: said });
      const mine: HistoryEntry = {
        id: `${Date.now()}-milla`,
        type: 'output',
        text: said,
        user: MILLA_NAME,
        isChat: true,
        sender: MILLA_NAME,
        timestamp: Date.now(),
      };
      history.push(mine);
      io.emit('sync_history', mine);
    } catch (error: any) {
      const mine: HistoryEntry = {
        id: `${Date.now()}-milla-err`,
        type: 'output',
        text: 'Sorry, Danny, I can\'t answer right now. The local AI service isn\'t responding (is Ollama running?).',
        user: MILLA_NAME,
        isChat: true,
        sender: MILLA_NAME,
        timestamp: Date.now(),
      };
      history.push(mine);
      io.emit('sync_history', mine);
      console.error('[milla] chat failed:', error?.message);
    } finally {
      io.emit('milla_typing', false);
    }
  });

  // No sign-in any more: AetherTerm is single-user and local, and the user is Danny.
  socket.on('authenticate', async () => {
    currentUser = { uid: 'danny', displayName: 'Danny' };
    onlineUsers.add('Danny');
    io.emit('users_update', presenceNames());
    socket.emit('vfs_load', Object.values(vfs));
    socket.emit('history_load', history);
    socket.emit('user_info', currentUser);
  });
  
  socket.on('disconnect', () => {
    console.log('user disconnected');
    shellCwd.delete(socket.id);
    if (currentUser && currentUser.displayName) {
        onlineUsers.delete(currentUser.displayName);
        io.emit('users_update', presenceNames());
        console.log(`User ${currentUser.displayName} removed from online users.`);
    }
  });

  socket.on('input', async (data) => {
    const userName = currentUser ? (currentUser.displayName) : 'Local User';
    const text = String(data?.text ?? '');
    // The command was submitted, so everyone's shared input line is now empty (it used to be refilled with the command).
    io.emit('sync_input', {text: '', user: userName});
    const emit = (entry: any) => io.emit('sync_history', entry);
    // v0.4: Real mode runs real bash; the virtual shell only works in the Sandbox.
    if (localMode() === 'real') {
      emit({ type: 'error', text: 'Real mode is on: commands run in the real bash shell. Switch back to Sandbox for the virtual shell.', id: Date.now().toString() + Math.random() });
      return;
    }
    const echo = { type: 'command', text: `${displayV(shellCwd.get(socket.id) || VIRTUAL_HOME)} $ ${text}`, id: Date.now().toString() + Math.random() };
    emit(echo); history.push(echo as any);
    // `a && b` / `a; b` run one after another (the virtual shell has no pipes).
    for (const part of text.split(/\s*(?:&&|;)\s*/).filter(Boolean)) {
      await handleCommand(part, emit, socket, currentUser);
    }
  });
  
  socket.on('vfs_create', async (node: VFSNode) => {
    if (vfs[node.path]) return; // prevent overwrite
    if (!safeResolve(node.path)) {
      console.log(`[diskSync] REJECTED create with unsafe path: ${node.path}`);
      return;
    }
    vfs[node.path] = node;
    // Write through to local disk (two-way sync).
    await writeThrough(node.path, { type: node.type, content: node.content });
    const parentPath = path.dirname(node.path).replace(/\\/g, '/');
    if (vfs[parentPath] && vfs[parentPath].type === 'directory') {
        vfs[parentPath].children?.push(node.path);
        io.emit('sync_vfs', [vfs[parentPath]]);
        persistVFSNode(vfs[parentPath], currentUser);
    }
    io.emit('sync_vfs', [node]);
    persistVFSNode(node, currentUser);
  });

  socket.on('vfs_update', async (node: VFSNode) => {
    if (!vfs[node.path]) return;
    if (!safeResolve(node.path)) {
      console.log(`[diskSync] REJECTED update with unsafe path: ${node.path}`);
      return;
    }
    vfs[node.path] = { ...vfs[node.path], ...node, updatedAt: Date.now() };
    // Write through to local disk (two-way sync).
    await writeThrough(node.path, { type: vfs[node.path].type, content: vfs[node.path].content });
    io.emit('sync_vfs', [vfs[node.path]]);
    persistVFSNode(vfs[node.path], currentUser);
  });
  
  socket.on('vfs_delete', async (nodePath: string) => {
     if (!vfs[nodePath]) return;
     if (!safeResolve(nodePath)) {
       console.log(`[diskSync] REJECTED delete with unsafe path: ${nodePath}`);
       return;
     }
     // Delete through to local disk first (two-way sync).
     await deleteThrough(nodePath);

     const pathsToDelete = [nodePath];
     const queue = [nodePath];

     while (queue.length > 0) {
         const currentPath = queue.shift()!;
         const node = vfs[currentPath];
         if (node && node.type === 'directory' && node.children) {
             for(const child of node.children) {
                 pathsToDelete.push(child);
                 queue.push(child);
             }
         }
     }
     
     for (const p of pathsToDelete.reverse()) {
         delete vfs[p];
         const parentPath = path.dirname(p).replace(/\\/g, '/');
         const parentNode = vfs[parentPath];
         if (parentNode && parentNode.type === 'directory' && parentNode.children) {
             parentNode.children = parentNode.children.filter(child => child !== p);
         }
         deleteVFSNode(p, currentUser);
     }
     
     const rootParent = path.dirname(nodePath).replace(/\\/g, '/');
     if(vfs[rootParent]) {
       io.emit('sync_vfs', [vfs[rootParent]]);
       persistVFSNode(vfs[rootParent], currentUser);
     }
     
     io.emit('purge_vfs_paths', pathsToDelete);
  });

  // Browser local-folder mount: client sends nodes it read via the
  // File System Access API. We validate each path and write through to disk.
  socket.on('sync_vfs_batch', async (data: { nodes: VFSNode[] }) => {
    if (!data || !Array.isArray(data.nodes)) return;
    const synced: VFSNode[] = [];
    for (const node of data.nodes) {
      if (!node || typeof node.path !== 'string') continue;
      if (!safeResolve(node.path)) {
        console.log(`[diskSync] REJECTED batch node with unsafe path: ${node.path}`);
        continue;
      }
      // Last-write-wins: incoming batch node overwrites VFS.
      vfs[node.path] = { ...node, updatedAt: Date.now() };
      await writeThrough(node.path, { type: node.type, content: node.content });
      synced.push(vfs[node.path]);
      // Ensure parent linkage.
      const parentPath = path.dirname(node.path).replace(/\\/g, '/');
      if (parentPath !== node.path && vfs[parentPath] && vfs[parentPath].type === 'directory') {
        if (!vfs[parentPath].children?.includes(node.path)) {
          vfs[parentPath].children!.push(node.path);
        }
      }
    }
    if (synced.length > 0) {
      io.emit('sync_vfs', synced);
      console.log(`[diskSync] batch sync: ${synced.length} nodes written through to disk.`);
    }
  });

  // File upload from the browser: the client reads the picked file as a
  // data URL and emits it here. (This handler was missing — uploads
  // silently went nowhere.) Text payloads join the VFS as text and
  // write through like any edit; binaries are written to disk
  // byte-for-byte and registered as file nodes so they show in the tree.
  socket.on('upload_file', async (data: { path?: string; content?: string }) => {
    const fail = (msg: string) => {
      console.log(`[upload] REJECTED ${data?.path}: ${msg}`);
      socket.emit('upload_file_result', { path: data?.path, ok: false, error: msg });
    };
    if (!data || typeof data.path !== 'string' || typeof data.content !== 'string') {
      return fail('malformed payload');
    }
    const diskPath = safeResolve(data.path);
    if (!diskPath) return fail('unsafe path');

    const m = data.content.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
    if (!m) return fail('expected a data URL');
    let buf: Buffer;
    try {
      buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf-8');
    } catch {
      return fail('could not decode payload');
    }
    if (buf.length > 16 * 1024 * 1024) return fail('file too large (16MB cap)');

    // Text iff the bytes round-trip through UTF-8 exactly.
    const asText = buf.toString('utf-8');
    const text = Buffer.from(asText, 'utf-8').equals(buf) ? asText : null;

    const now = Date.now();
    const existing = vfs[data.path];
    const node: VFSNode = {
      path: data.path,
      type: 'file',
      content: text ?? existing?.content ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ownerId: existing?.ownerId ?? currentUser?.uid ?? '',
    };
    vfs[data.path] = node;

    if (text !== null) {
      await writeThrough(data.path, { type: 'file', content: text });
    } else {
      try {
        await fs.mkdir(path.dirname(diskPath), { recursive: true });
        await fs.writeFile(diskPath, buf);
        markSelfWrite(diskPath);
      } catch (err: any) {
        return fail(`disk write failed: ${err.message}`);
      }
    }

    const parentPath = path.dirname(data.path).replace(/\\/g, '/');
    if (parentPath !== data.path && vfs[parentPath] && vfs[parentPath].type === 'directory') {
      if (!vfs[parentPath].children?.includes(data.path)) {
        vfs[parentPath].children!.push(data.path);
      }
      io.emit('sync_vfs', [vfs[parentPath]]);
      persistVFSNode(vfs[parentPath], currentUser);
    }
    io.emit('sync_vfs', [node]);
    persistVFSNode(node, currentUser);
    socket.emit('upload_file_result', { path: data.path, ok: true, bytes: buf.length, binary: text === null });
    console.log(`[upload] ${data.path} (${buf.length} bytes, ${text === null ? 'binary' : 'text'})`);
  });

  socket.on('request_local_llm', async (data) => {
      try {
        const ollamaUrl = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        const model = (data && data.model) || process.env.OLLAMA_MODEL || 'devmilla:latest';
        
        void ollamaUrl;
        const text = await ollamaChat([{ role: 'system', content: asMilla() }, { role: 'user', content: String(data.prompt || '') }], model);
        socket.emit(`response_local_llm_${data.id}`, { text });
      } catch (err) {
           socket.emit(`response_local_llm_${data.id}`, {error: `Could not connect to Ollama. Make sure it is running locally and that CORS is configured if AetherTerm is not running on localhost.`});
      }
  });

  const answerWorkspaceChat = async (data: { prompt?: string; message?: string; systemInstruction?: string; provider?: string; model?: string; history?: Array<{ role: string; content: string }> }) => {
      const asked = data.prompt || data.message || '';
      const turns = (data.history || []).slice(-8);
      const provider = resolveProvider(data.provider);
      try {
        let result: string;
        if (provider === 'local') {
          result = await ollamaChat([
            { role: 'system', content: asMilla('You are in the Milla Workspace panel helping Danny.') },
            ...turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.content })),
            { role: 'user', content: asked },
          ], typeof data.model === 'string' && data.model ? data.model : activeModel);
        } else {
          const prior = turns.map((t) => `${t.role === 'user' ? 'Danny' : 'Milla'}: ${t.content}`).join('\n');
          result = await getLlmResponse(prior ? `${prior}\nDanny: ${asked}` : asked, 'You are in the Milla Workspace panel helping Danny.', provider);
        }
        socket.emit('gemini_chat_response', { text: result });
      } catch (error: any) {
        console.error('[milla] workspace chat failed:', error?.message);
        socket.emit('gemini_chat_response', { error: 'I can\'t answer right now. Check that Ollama is running, or pick another model in Settings.' });
      }
  };
  socket.on('gemini_chat_message', answerWorkspaceChat);
  socket.on('gemini_chat', answerWorkspaceChat);

  socket.on('gemini_generate_code', async (data: { prompt?: string }) => {
      try {
        const html = await generateAppHtml(data.prompt || '');
        // v0.4: Milla's apps land in the Sandbox home (~/milla/apps), in the VFS and on disk.
        const vfsPath = millaPath('apps', `app-${Date.now()}.html`);
        await vfsPut(vfsPath, { type: 'file', content: html }, currentUser?.uid || 'system');
        socket.emit('gemini_generate_code_response', { code: html, filepath: vfsPath });
      } catch (error: any) {
        socket.emit('gemini_generate_code_response', { error: error.message });
      }
  });

  // v0.3 canvas: revise the current preview. Same local-first generator as Generate App.
  socket.on('canvas_revise', async (data: { html?: string; request?: string }) => {
      const html = String(data?.html || '').slice(0, 200_000);
      const request = String(data?.request || '').slice(0, 2000);
      try {
        if (!html || !request) throw new Error('Nothing to revise.');
        const code = await generateAppHtml(`Here is the current single-file HTML app:\n\n${html}\n\nChange it as follows: ${request}\n\nReturn the complete updated document.`);
        socket.emit('canvas_revise_response', { code, request });
      } catch (error: any) {
        socket.emit('canvas_revise_response', { error: error.message, request });
      }
  });

  socket.on('gemini_generate_video', async (data: { prompt?: string }) => {
      const model = process.env.GEMINI_VIDEO_MODEL;
      if (!genAI) {
        socket.emit('gemini_generate_video_response', { error: 'Gemini API key not configured.' });
        return;
      }
      if (!model) {
        socket.emit('gemini_generate_video_response', {
          error: 'Veo is not available on this Studio key. The model list has image and text models, and no Veo model. Generate App and text-to-image can run. Set GEMINI_VIDEO_MODEL if a Veo model is added later.',
        });
        return;
      }
      try {
        const operation = await genAI.models.generateVideos({
          model,
          source: { prompt: data.prompt || '' },
          config: { numberOfVideos: 1 },
        });
        const operationName = operation.name || `${Date.now()}`;
        videoOps.set(operationName, operation);
        socket.emit('gemini_generate_video_response', { operationName });
      } catch (error: any) {
        socket.emit('gemini_generate_video_response', { error: error.message });
      }
  });

  socket.on('gemini_get_video_status', async (data: { operationName?: string }) => {
      const current = data.operationName ? videoOps.get(data.operationName) : null;
      if (!genAI || !current) {
        socket.emit('gemini_get_video_status_response', { error: 'That video job is not running.' });
        return;
      }
      try {
        const updated = await genAI.operations.getVideosOperation({ operation: current });
        videoOps.set(data.operationName as string, updated);
        if (!updated.done) return;
        const video = updated.response?.generatedVideos?.[0]?.video;
        const bytes = video?.videoBytes;
        if (!bytes) {
          socket.emit('gemini_get_video_status_response', { error: video?.uri ? `Video finished at ${video.uri}` : 'Veo finished without video bytes.' });
          return;
        }
        const vfsPath = millaPath('media', `generated-video-${Date.now()}.mp4`);
        if (!(await vfsPut(vfsPath, { type: 'file', bytes: Buffer.from(bytes, 'base64') }, currentUser?.uid || 'system'))) throw new Error('Could not save the video.');
        socket.emit('gemini_get_video_status_response', { done: true, filepath: vfsPath, url: `/vfs${vfsPath}` });
      } catch (error: any) {
        socket.emit('gemini_get_video_status_response', { error: error.message });
      }
  });

  socket.on('gemini_generate_image', async(data) => {
      const prompt = data.prompt || '';
      
      try {
        if (!genAI) throw new Error("Gemini API key not configured.");

        const response = await genAI.models.generateContent({
          model: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
          contents: prompt,
          config: { responseModalities: ['IMAGE', 'TEXT'] },
        });
        const base64Data = response.data;

        if (base64Data) {
            const buffer = Buffer.from(base64Data, 'base64');
            const vfsPath = millaPath('media', `generated-image-${Date.now()}.png`);
            if (!(await vfsPut(vfsPath, { type: 'file', bytes: buffer }, currentUser?.uid || 'system'))) throw new Error('Could not save the image.');

            socket.emit('gemini_generate_image_response', { filepath: vfsPath, url: `/vfs${vfsPath}` });
        } else {
            throw new Error("No image data received from Gemini.");
        }
    } catch(err: any) {
        const raw = err?.message || String(err);
        const retry = raw.match(/retry in ([^.\n]+)/i);
        const error = /quota|RESOURCE_EXHAUSTED/i.test(raw)
          ? `Image quota on the free Studio tier is used up${retry ? `. Retry in ${retry[1].trim()}` : ''}. Generate App still runs on the text model. Veo is not on this key.`
          : raw.slice(0, 500);
        socket.emit('gemini_generate_image_response', { error });
    }
  });
  
});

// AetherTerm Command Processing System

const commandQueue: { command: string, callback: (emitHistory: (entry: any) => void) => Promise<void> }[] = [];
let isProcessing = false;

async function processQueue(emitHistory: (entry: any) => void) {
    if (isProcessing || commandQueue.length === 0) return;
    isProcessing = true;
    
    const { command, callback } = commandQueue.shift()!;
    
    try {
        await callback(emitHistory);
    } catch (error: any) {
        emitHistory({ type: 'error', text: `Failed to execute command "${command}": ${error.message}`, id: Date.now().toString() + Math.random() });
    }
    
    isProcessing = false;
    processQueue(emitHistory);
}

function emitAndQueue(inputEntry: any, callback: (emitHistory: (entry: any) => void) => Promise<void>) {
    io.emit('sync_history', inputEntry);
    history.push(inputEntry);
    persistHistoryEntry(inputEntry, null);

    commandQueue.push({ command: inputEntry.text, callback });
    processQueue((entry) => {
        io.emit('sync_history', entry);
        history.push(entry);
        persistHistoryEntry(entry, null);
    });
}

// Global LLM Response Function
function resolveProvider(p?: string): string {
  if (!p || p === 'auto') return genAI ? 'gemini' : 'local';
  return p;
}

async function getLlmResponse(prompt: string, task?: string, wanted: string = 'auto'): Promise<string> {
    const provider = resolveProvider(wanted);
    const systemInstruction = asMilla(task);
    if (provider === 'local') {
      return ollamaChat([{ role: 'system', content: systemInstruction }, { role: 'user', content: prompt }]);
    }
    if (!genAI && provider === 'gemini') throw new Error("Gemini API key not configured.");
    if (!openAI && provider === 'openai') throw new Error("OpenAI API key not configured.");
    if (!anthropic && provider === 'anthropic') throw new Error("Anthropic API key not configured.");
  
    try {
      if (provider === 'openai' && openAI) {
          const messages: any[] = [];
          if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
          messages.push({ role: 'user', content: prompt });
          
          const completion = await openAI.chat.completions.create({
            model: 'gpt-4o',
            messages,
          });
          return completion.choices[0]?.message?.content || '';

      } else if (provider === 'anthropic' && anthropic) {
          const msg = await anthropic.messages.create({
              model: 'claude-3-5-sonnet-20240620',
              max_tokens: 4096,
              system: systemInstruction,
              messages: [{role: 'user', content: prompt}],
          });
          return (msg.content[0] as any).text || '';
          
      } else {
          return await geminiText(prompt, systemInstruction);
      }
    } catch (e: any) {
        throw new Error(`LLM Error (${provider}): ${e.message}`);
    }
}

async function callLocalLLM(prompt: string, task?: string, provider: string = 'local'): Promise<string> {
  return getLlmResponse(prompt, task, provider);
}


const agents: { [key: string]: string } = {
  'coder': `You are an expert software developer. You are helping a user to write code. Provide code examples and explain them clearly. You can also help with debugging and refactoring. Your response should be in markdown format.`,
  'researcher': `You are a research assistant. You are helping a user to find information on a topic. Provide a summary of the information you find, and include links to the sources. Your response should be in markdown format.`,
  'system': `You are a system administrator. You are helping a user with a system administration task. Provide clear instructions and commands. Your response should be in markdown format.`
};


async function handleCommand(
  inputText: string, 
  emitHistory: (entry: any) => void,
  socket: any,
  user: any
) {
    const [command, ...args] = inputText.trim().split(/\s+/);
    // v0.4: paths are relative to this window's virtual cwd; ~ is the virtual home.
    const cwd = shellCwd.get(socket?.id) || VIRTUAL_HOME;
    const R = (p?: string) => (p ? resolveV(p, cwd) : '');

    const emitAndQueue = (inputEntry: any, callback: (emitHistory: (entry: any) => void) => Promise<void>) => {
      const fullEntry = { ...inputEntry, user: user?.displayName || 'Local User' };
      io.emit('sync_history', fullEntry);
      history.push(fullEntry);
      persistHistoryEntry(fullEntry, user);

      commandQueue.push({ command: inputEntry.text, callback: (cb_emitHistory) => callback(cb_emitHistory) });
      processQueue((entry) => {
          const fullOutputEntry = { ...entry, user: 'AetherTerm' };
          io.emit('sync_history', fullOutputEntry);
          history.push(fullOutputEntry);
          persistHistoryEntry(fullOutputEntry, user);
      });
    }

    if (command) {
      if (command === 'cd') {
        const target = resolveV(args[0] || '~', cwd);
        const node = vfs[target];
        if (target === '/' || (node && node.type === 'directory')) {
          shellCwd.set(socket.id, target);
          socket.emit('shell_home', shellState(socket.id));
        } else {
          emitHistory({ type: 'output', text: `cd: ${args[0] || '~'}: No such directory`, isError: true, id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'canvas') {
        // v0.4: show a VFS file in the Milla Workspace canvas.
        const file = R(args[0]);
        const node = file ? vfs[file] : undefined;
        if (!file) emitHistory({ type: 'output', text: 'Usage: canvas <file>', id: Date.now().toString() + Math.random() });
        else if (node && node.type === 'file') socket.emit('sync_history', { type: 'output', canvas: true, path: file, text: node.content ?? '', id: Date.now().toString() + Math.random() });
        else emitHistory({ type: 'output', text: `canvas: ${args[0]}: No such file`, isError: true, id: Date.now().toString() + Math.random() });
      } else if (command === 'pwd') {
        emitHistory({ type: 'output', text: cwd, id: Date.now().toString() + Math.random() });
      } else if (command === 'help') {
          const helpText = `Available commands:
  help                    - Show this help message
  clear                   - Clear the terminal
  cd [dir]                - Change directory (~ is your home: ${VIRTUAL_HOME} in the Sandbox)
  pwd                     - Print the current directory
  canvas <file>           - Show a file in the Milla Workspace canvas (in Real mode: canvas FILE in bash)
  ls [dir]                - List directory contents
  cat <file>              - View file contents
  mkdir <dir>             - Create a directory
  touch <file>            - Create an empty file
  echo <text>             - Print text
  play <url|path>         - Play a video or audio file inline (alias: video, listen)
  pip <url|path>          - Play a video in Picture-in-Picture mode
  view <url|path>         - View an image or GIF (alias: image)
                            Paths: VFS paths in Sandbox; ~/... in your folders in Real mode
  ask <prompt>            - Ask Gemini AI a question
  generate-app <prompt>   - Generate an HTML/JS/CSS app and open in Sandbox
  generate-image <prompt> - Generate an image using AI
  github clone <repo>     - Clone a GitHub repository (e.g., octocat/Hello-World)
  github-sync <url>       - Sync full nested file structure from a GitHub repo URL or owner/repo slug
  agent <name> <prompt>   - Ask a specific AI agent (coder, researcher, system)
  local-ask <prompt>      - Ask a local LLM via Ollama (127.0.0.1:11434 by default)
  ollama list             - List available Ollama models
  ollama use <model_name> - Set the Ollama model to use
  set-boot <url>          - Set a custom boot screen video (URL or VFS path)
  edit <file>             - Open file in the custom code editor
  nix search <pkg>        - Search for a Nix package
  nix run <pkg>           - Run a Nix package (simulated)
  pkg install <name>      - Install a new package/command (e.g., cowsay, weather, joke)

Examples:
  view https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif
  play https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
  generate-image a cute cat in space`;
          const output = { type: 'output', text: helpText, id: Date.now().toString() + Math.random() };
          emitHistory(output);
        } else if (command === 'ls') {
          const dir = args[0] ? R(args[0]) : cwd;
          const node = vfs[dir];

          if (node && node.type === 'directory' && node.children) {
              const text = node.children.map(p => {
                  const childNode = vfs[p];
                  return `${childNode.type === 'directory' ? 'd' : '-'} ${p.split('/').pop()}`;
              }).join('\n');
              emitHistory({ type: 'output', text: text || 'Directory is empty.', id: Date.now().toString() + Math.random() });
          } else {
              emitHistory({ type: 'output', text: `ls: ${dir}: No such file or directory`, isError: true, id: Date.now().toString() + Math.random() });
          }
      } else if (command === 'cat') {
        const file = R(args[0]);
        if (file) {
          const node = vfs[file];
          if (node && node.type === 'file') {
            emitHistory({ type: 'output', text: node.content, path: file, id: Date.now().toString() + Math.random() });
          } else {
            emitHistory({ type: 'output', text: `cat: ${file}: No such file`, isError: true, id: Date.now().toString() + Math.random() });
          }
        } else {
            emitHistory({ type: 'output', text: 'Usage: cat <file>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'mkdir') {
          // v0.4: mkdir [-p] <dir>...; written to the VFS and its disk mirror, so it survives a restart.
          const parents = args.includes('-p');
          const dirs = args.filter((a) => a !== '-p').map((a) => R(a));
          if (!dirs.length) {
            emitHistory({ type: 'output', text: 'Usage: mkdir [-p] <directory>', id: Date.now().toString() + Math.random() });
            return;
          }
          const errs: string[] = [];
          for (const dir of dirs) {
            if (vfs[dir]) { if (!(parents && vfs[dir].type === 'directory')) errs.push(`mkdir: ${dir}: File exists`); continue; }
            const parentPath = path.posix.dirname(dir);
            if (!parents && (!vfs[parentPath] || vfs[parentPath].type !== 'directory')) { errs.push(`mkdir: ${parentPath}: No such file or directory`); continue; }
            if (!(await vfsPut(dir, { type: 'directory' }, user?.uid || 'system'))) errs.push(`mkdir: ${dir}: could not create`);
          }
          emitHistory({ type: 'output', text: errs.join('\n'), ...(errs.length ? { isError: true } : {}), id: Date.now().toString() + Math.random() });
      } else if (command === 'touch') {
          // v0.4: touch <file>...; new files are written to the VFS and its disk mirror.
          const files = args.map((a) => R(a));
          if (!files.length) {
            emitHistory({ type: 'output', text: 'Usage: touch <file>', id: Date.now().toString() + Math.random() });
            return;
          }
          const errs: string[] = [];
          for (const file of files) {
            if (vfs[file]) {
              vfs[file].updatedAt = Date.now();
              const disk = safeResolve(file);
              if (disk) { const t = new Date(); await fs.utimes(disk, t, t).catch(() => null); markSelfWrite(disk); }
              io.emit('sync_vfs', [vfs[file]]);
              continue;
            }
            const parentPath = path.posix.dirname(file);
            if (!vfs[parentPath] || vfs[parentPath].type !== 'directory') { errs.push(`touch: ${parentPath}: No such file or directory`); continue; }
            if (!(await vfsPut(file, { type: 'file', content: '' }, user?.uid || 'system'))) errs.push(`touch: ${file}: could not create`);
          }
          emitHistory({ type: 'output', text: errs.join('\n'), ...(errs.length ? { isError: true } : {}), id: Date.now().toString() + Math.random() });
      } else if (command === 'echo') {
        const text = args.join(' ');
        emitHistory({ type: 'output', text, id: Date.now().toString() + Math.random() });
      } else if (['play', 'pip', 'video', 'view', 'image', 'listen'].includes(command)) {
        // v0.3 fix: the renderer draws {type:'video'|'image', url}; the WIP had switched
        // this to {type:'output', mediaUrl}, which the terminal never rendered.
        const raw = args.join(' ').trim().replace(/^["']|["']$/g, '');
        const id = Date.now().toString() + Math.random();
        if (!raw) {
          emitHistory({ type: 'output', text: `Usage: ${command} <url | VFS path${localMode() === 'real' ? ' | ~/file in a mapped folder' : ''}>`, id });
        } else {
          let url = raw;
          let err = '';
          // Sandbox: ~ and relative paths are VFS paths under the virtual home. Real: ~ is the real home.
          const vfsPath = localMode() === 'real' ? raw : (/^(https?:|data:|blob:)/i.test(raw) ? raw : R(raw));
          const inVfs = !!vfs[vfsPath];
          if (inVfs) url = vfsPath;
          if (!inVfs && /^(~|\/)/.test(raw)) {
            if (localMode() === 'real') url = `/api/local/raw?abs=${encodeURIComponent(raw)}`;
            else err = `Sandbox is on: ${command} can open web URLs and VFS files (${raw} is not in the VFS). Switch to Real files and shell to play files from your folders.`;
          } else if (!inVfs && !/^(https?:|data:|blob:)/i.test(raw)) {
            err = `${command}: ${raw} is not a web URL or a file path.`;
          }
          const mt = mediaTypeOf(raw.split(/[?#]/)[0]);
          const isImage = command === 'view' || command === 'image' || (mt.startsWith('image/') && command !== 'play' && command !== 'pip');
          if (err) emitHistory({ type: 'error', text: err, id });
          else emitHistory({ type: isImage ? 'image' : 'video', url, pip: command === 'pip', id });
        }
      } else if (command === 'ask') {
        const prompt = args.join(' ');
        if (prompt) {
          emitAndQueue(
            { type: 'input', text: `ask ${prompt}`, id: Date.now().toString() + Math.random() },
            async (emitHistory) => {
              try {
                const result = await getLlmResponse(prompt);
                emitHistory({ type: 'output', text: result, id: Date.now().toString() + Math.random() });
              } catch (error: any) {
                emitHistory({ type: 'output', text: `Error: ${error.message}`, isError: true, id: Date.now().toString() + Math.random() });
              }
            }
          );
        } else {
          emitHistory({ type: 'output', text: 'Usage: ask <prompt>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'generate-app') {
          const prompt = args.join(' ');
           if (prompt) {
            emitAndQueue(
                { type: 'input', text: `generate-app ${prompt}`, id: Date.now().toString() + Math.random() },
                async (emitHistory) => {
                  try {
                      const systemPrompt = `You are an expert web developer. Create a single HTML file with embedded CSS and JavaScript that fulfills the user's request: "${prompt}". The HTML file should be self-contained and not require any external dependencies. The design should be clean, modern, and responsive. Use a professional color palette and layout. Your response MUST be only the raw HTML code for the file, starting with \`<!DOCTYPE html>\` and ending with \`</html>\`. Do not include any markdown formatting, explanations, or any other text outside of the HTML code itself.`;
                      const appCode = await getLlmResponse(systemPrompt, 'Return only the HTML document.', 'auto');
                      
                      // v0.4: saved under the Sandbox home (~/milla/apps), in the VFS and on disk.
                      const vfsPath = millaPath('apps', `app-${Date.now()}.html`);
                      if (!(await vfsPut(vfsPath, { type: 'file', content: appCode }, user?.uid || 'system'))) throw new Error('Could not save the app.');

                      emitHistory({ type: 'output', text: `App generated: ${displayV(vfsPath)}`, sandboxUrl: `/vfs${vfsPath}`, id: Date.now().toString() + Math.random() });
                      // Open the saved app itself in the canvas (not the status line).
                      socket.emit('sync_history', { type: 'output', canvas: true, path: vfsPath, text: appCode, id: Date.now().toString() + Math.random() });

                  } catch (error: any) {
                      emitHistory({ type: 'output', text: `Error generating app: ${error.message}`, isError: true, id: Date.now().toString() + Math.random() });
                  }
                }
            );
        } else {
          emitHistory({ type: 'output', text: 'Usage: generate-app <description_of_app>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'generate-image') {
        const prompt = args.join(' ');
        if (prompt) {
          emitAndQueue(
            { type: 'input', text: `generate-image ${prompt}`, id: Date.now().toString() + Math.random() },
            async (emitHistory) => {
              try {
                if (!genAI) throw new Error("Gemini API key not configured.");
                const requestId = Date.now().toString();
                socket.emit('gemini_generate_image', { id: requestId, prompt });
                
                socket.once(`gemini_generate_image_response_${requestId}`, (data:any) => {
                    if (data.error) {
                        emitHistory({ type: 'output', text: `Error: ${data.error}`, isError: true, id: Date.now().toString() + Math.random() });
                    } else {
                        emitHistory({ type: 'output', text: `Image generated: [File: ${data.filepath}]`, mediaUrl: data.url, mediaType: 'image', id: Date.now().toString() + Math.random() });
                    }
                });
              } catch(e: any) {
                  emitHistory({ type: 'output', text: `Error: ${e.message}`, isError: true, id: Date.now().toString() + Math.random() });
              }
            }
          );
        } else {
          emitHistory({ type: 'output', text: 'Usage: generate-image <prompt>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'github' && args[0] === 'clone') {
          const repo = args[1];
          if (repo) {
              const output = { type: 'output', text: `Cloning ${repo}... (not really, this is a simulation)`, id: Date.now().toString() + Math.random() };
              emitHistory(output);
          } else {
              emitHistory({ type: 'output', text: 'Usage: github clone <owner/repo>', id: Date.now().toString() + Math.random() });
          }
      } else if (command === 'github-sync') {
          const repoUrl = args[0];
          if (repoUrl) {
              emitAndQueue(
                { type: 'input', text: `github-sync ${repoUrl}`, id: Date.now().toString() + Math.random() },
                async (emitHistory) => {
                    try {
                        emitHistory({ type: 'output', text: `Syncing from ${repoUrl}...`, id: Date.now().toString() + Math.random()});

                        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
                        const headers: HeadersInit = GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {};
                        
                        let apiUrl = '';
                        const match = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
                        if (match) {
                            apiUrl = `https://api.github.com/repos/${match[1]}/contents`;
                        } else if (repoUrl.match(/[^/]+\/[^/]+/)) {
                            apiUrl = `https://api.github.com/repos/${repoUrl}/contents`;
                        } else {
                            throw new Error("Invalid GitHub URL or repo slug.");
                        }

                        const newNodes: VFSNode[] = [];
                        
                        async function fetchRepoContents(url: string, targetPath: string) {
                            const response = await fetch(url, { headers });
                            if (!response.ok) {
                                throw new Error(`GitHub API error: ${response.statusText}`);
                            }
                            const contents = await response.json();

                            if (!vfs[targetPath]) {
                                const dirNode: VFSNode = { path: targetPath, type: 'directory', children: [], createdAt: Date.now(), updatedAt: Date.now(), ownerId: user?.uid || 'system'};
                                vfs[targetPath] = dirNode;
                                newNodes.push(dirNode);
                            }
                            const parentNode = vfs[targetPath];
                            if(parentNode.type !== 'directory') throw new Error("Target path is not a directory");


                            for (const item of contents) {
                                const itemVFSPath = path.join(targetPath, item.name).replace(/\\/g, '/');
                                if (item.type === 'dir') {
                                    await fetchRepoContents(item.url, itemVFSPath);
                                } else if (item.type === 'file') {
                                    const fileResponse = await fetch(item.download_url!);
                                    const fileContent = await fileResponse.text();
                                    const fileNode: VFSNode = {
                                        path: itemVFSPath,
                                        type: 'file',
                                        content: fileContent,
                                        createdAt: Date.now(),
                                        updatedAt: Date.now(),
                                        ownerId: user?.uid || 'system'
                                    };
                                    vfs[itemVFSPath] = fileNode;
                                    newNodes.push(fileNode);
                                }
                                if(!parentNode.children?.includes(itemVFSPath)){
                                  parentNode.children?.push(itemVFSPath);
                                }
                            }
                            if(newNodes.find(n => n.path === parentNode.path)){
                               const index = newNodes.findIndex(n => n.path === parentNode.path);
                               newNodes[index] = parentNode;
                            } else {
                               newNodes.push(parentNode);
                            }
                        }
                        
                        const repoName = repoUrl.split('/').pop() || 'synced-repo';
                        const targetDir = `${MILLA_DIRS.synced}/${repoName.replace(/[^\w.-]/g, '_')}`;
                        await fetchRepoContents(apiUrl, targetDir);

                        // v0.4: write every synced node through vfsPut (VFS + disk, parents created).
                        for (const node of newNodes) {
                            await vfsPut(node.path, node.type === 'directory' ? { type: 'directory' } : { type: 'file', content: node.content || '' }, user?.uid || 'system');
                        }

                        emitHistory({ type: 'output', text: `Sync complete! Files are in ${displayV(targetDir)}`, id: Date.now().toString() + Math.random() });
                    } catch (error: any) {
                        emitHistory({ type: 'output', text: `Error syncing from GitHub: ${error.message}`, isError: true, id: Date.now().toString() + Math.random() });
                    }
                }
            );
          } else {
               emitHistory({ type: 'output', text: 'Usage: github-sync <url_or_owner/repo>', id: Date.now().toString() + Math.random() });
          }
      } else if (command === 'clear') {
        io.emit('clear_history');
        history = [];
      } else if (command === 'edit') {
        const file = R(args[0]);
        if (file) {
          const node = vfs[file];
          if (node && node.type === 'file') {
            socket.emit('open_editor', { path: node.path, content: node.content });
          } else {
            emitHistory({ type: 'output', text: `edit: ${file}: No such file`, isError: true, id: Date.now().toString() + Math.random() });
          }
        } else {
          emitHistory({ type: 'output', text: 'Usage: edit <file>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'agent') {
        const agentName = args[0];
        const prompt = args.slice(1).join(' ');

        if (agentName && agents[agentName] && prompt) {
          emitAndQueue(
            { type: 'input', text: `agent ${agentName} ${prompt}`, id: Date.now().toString() + Math.random() },
            async (emitHistory) => {
              try {
                const result = await getLlmResponse(prompt, agents[agentName]);
                emitHistory({ type: 'output', text: `**Agent ${agentName}:**\n\n${result}`, id: Date.now().toString() + Math.random() });
              } catch (error: any) {
                emitHistory({ type: 'output', text: `Error: ${error.message}`, isError: true, id: Date.now().toString() + Math.random() });
              }
            }
          );
        } else if (!agentName || !agents[agentName]) {
          emitHistory({ type: 'output', text: `Unknown agent: ${agentName}. Available agents: ${Object.keys(agents).join(', ')}`, id: Date.now().toString() + Math.random() });
        } else {
          emitHistory({ type: 'output', text: 'Usage: agent <name> <prompt>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'nix') {
        const subCommand = args[0];
        const pkg = args[1];
        if (subCommand === 'search' && pkg) {
           emitHistory({ type: 'output', text: `Searching for ${pkg} in Nix registry... (simulated)`, id: Date.now().toString() + Math.random() });
        } else if (subCommand === 'run' && pkg) {
           emitHistory({ type: 'output', text: `Running ${pkg} via Nix... (simulated)`, id: Date.now().toString() + Math.random() });
        } else {
           emitHistory({ type: 'output', text: 'Usage: nix <search|run> <package>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'pkg' && args[0] === 'install') {
        const pkgName = args[1];
        if (pkgName) {
           emitHistory({ type: 'output', text: `Installing ${pkgName}... (simulated)`, id: Date.now().toString() + Math.random() });
        } else {
           emitHistory({ type: 'output', text: 'Usage: pkg install <package_name>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'set-boot') {
        const url = args[0];
        if (url) {
            emitHistory({ type: 'output', text: `Setting boot video to ${url}...`, id: Date.now().toString() + Math.random() });
            io.emit('set_boot_video', url);
        } else {
            emitHistory({ type: 'output', text: 'Usage: set-boot <url_or_vfs_path>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'local-ask') {
        const prompt = args.join(' ');
        if (prompt) {
          emitAndQueue(
            { type: 'input', text: `local-ask ${prompt}`, id: Date.now().toString() + Math.random() },
            async (emitHistory) => {
              try {
                const result = await callLocalLLM(prompt);
                emitHistory({ type: 'output', text: result, id: Date.now().toString() + Math.random() });
              } catch (error: any) {
                emitHistory({ type: 'output', text: `Error: ${error.message}`, isError: true, id: Date.now().toString() + Math.random() });
              }
            }
          );
        } else {
          emitHistory({ type: 'output', text: 'Usage: local-ask <prompt>', id: Date.now().toString() + Math.random() });
        }
      } else if (command === 'ollama') {
        console.log('ollama command received:', args);
        const subCommand = args[0];
        if (subCommand === 'list') {
          emitAndQueue(
            { type: 'input', text: 'ollama list', id: Date.now().toString() + Math.random() },
            async (emitHistory) => {
              try {
                const models = await new Promise<any[]>((resolve, reject) => {
                  const requestId = Date.now().toString() + Math.random();
                  const timeout = setTimeout(() => {
                    socket.removeAllListeners(`response_ollama_models_${requestId}`);
                    reject(new Error("Ollama model list request timed out."));
                  }, 5000);

                  socket.once(`response_ollama_models_${requestId}`, (data) => {
                    console.log('response_ollama_models received:', data);
                    clearTimeout(timeout);
                    if (data.error) reject(new Error(data.error));
                    else resolve(data.models);
                  });
                  console.log('emitting request_ollama_models');
                  socket.emit('request_ollama_models', { id: requestId });
                });
                emitHistory({ type: 'output', text: `Available Ollama models:\n${models.map((m: any) => `- ${m.name}`).join('\n')}`, id: Date.now().toString() + Math.random() });
              } catch (error: any) {
                emitHistory({ type: 'output', text: `Error: ${error.message}`, isError: true, id: Date.now().toString() + Math.random() });
              }
            }
          );
        } else if (subCommand === 'use') {
          const modelName = args[1];
          if (modelName) {
            emitAndQueue(
              { type: 'input', text: `ollama use ${modelName}`, id: Date.now().toString() + Math.random() },
              async (emitHistory) => {
                socket.emit('set_ollama_model', { model: modelName });
                emitHistory({ type: 'output', text: `Ollama model set to: ${modelName}`, id: Date.now().toString() + Math.random() });
              }
            );
          } else {
            emitHistory({ type: 'output', text: 'Usage: ollama use <model_name>', id: Date.now().toString() + Math.random() });
          }
        } else {
            emitHistory({ type: 'output', text: 'Usage: ollama <list|use>', id: Date.now().toString() + Math.random() });
        }
      } else {
        const output = { type: 'output', text: `Unknown command: ${command}`, isError: true, id: Date.now().toString() + Math.random() };
        emitHistory(output);
      }
    }
}

// v0.4: /vfs serves the Sandbox files (the VFS disk mirror); the old VFS_ROOT is a read-only fallback.
// Locked to the Sandbox: in Real mode the page uses /api/local instead.
function vfsStatic() {
  const stat = express.static(getSyncRoot(), { dotfiles: 'deny', index: false });
  return (req: any, res: any, next: any) => stat(req, res, next);
}

async function startServer() {
  // v0.4: the Sandbox home (~) always exists in the VFS.
  await writeThrough(VIRTUAL_HOME, { type: 'directory' }).catch(() => null);
  await initializeVFS();

  // Start two-way disk sync watcher (disk → VFS → clients).
  startWatcher((events) => {
    for (const ev of events) {
      applyDiskChange(ev.kind, ev.vfsPath).catch((err) =>
        console.error('[diskSync] applyDiskChange failed:', err)
      );
    }
  });
  await initializeHistory();

  if (process.env.NODE_ENV === 'development') {
    const vite = await import('vite');
    const viteDevServer = await vite.createServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(viteDevServer.middlewares);
    app.use('/vfs', vfsStatic(), express.static(VFS_ROOT));
  } else {
    const distDir = path.resolve(process.env.AETHERTERM_DIST_DIR || 'dist');
    app.use(express.static(distDir));
    app.use('/vfs', vfsStatic(), express.static(VFS_ROOT));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = process.env.PORT || 3333;
  // The desktop app sets HOST=127.0.0.1 so the server is not reachable from the LAN.
  const host = process.env.HOST;
  const onListen = () => console.log(`Server listening on ${host || '*'}:${port}`);
  if (host) httpServer.listen(Number(port), host, onListen);
  else httpServer.listen(port, onListen);
}

startServer();
