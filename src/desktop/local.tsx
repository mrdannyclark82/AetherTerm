// AetherTerm desktop features: mapped local folders + a real PTY shell.
// Renders nothing outside the Electron app (window.aetherDesktop missing).
// v0.4: the terminal is always on screen. In Real mode <RealShell/> is that terminal
// (it starts by itself in your home folder); the explorer's Home follows the mode.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminal as terminalTheme } from '../theme';
import { Folder, FolderOpen, File, FilePlus, FolderPlus, Pencil, Trash2, Save, X, ChevronRight, ChevronDown, TerminalSquare, Power, Link2, RefreshCw, HardDrive, Eye, EyeOff, Shield, ShieldOff, Home } from 'lucide-react';

type Bridge = {
  isDesktop: true;
  folders: () => Promise<string[]>;
  pickFolder: () => Promise<{ added: string | null; folders: string[] }>;
  removeFolder: (f: string) => Promise<string[]>;
  trash: (root: string, rel: string) => Promise<{ ok: boolean }>;
};
const bridge: Bridge | undefined = (window as any).aetherDesktop;
export const isDesktop = !!bridge;

type Entry = { name: string; type: 'dir' | 'file' | 'other'; link: boolean; outside: boolean; size: number };
type Sel = { root: string; rel: string; type: 'dir' | 'file' };
type Dialog =
  | { kind: 'name'; title: string; initial: string; onOk: (v: string) => Promise<void> }
  | { kind: 'confirm'; title: string; body: string; okLabel: string; onOk: () => Promise<void> };

async function api<T = any>(url: string, body?: any): Promise<T> {
  const res = await fetch(url, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
const parent = (rel: string) => rel.split('/').slice(0, -1).join('/');

type Ctx = {
  roots: { path: string; name: string }[];
  sel: Sel | null; setSel: (s: Sel | null) => void;
  cwd: { root: string; rel: string } | null;
  home: string;
  file: { root: string; rel: string; content: string; saved: string; media?: 'image' | 'video' | 'audio'; url?: string } | null;
  openFile: (root: string, rel: string) => Promise<void>;
  setContent: (c: string) => void; save: () => Promise<void>; closeFile: () => void;
  mode: Mode; requestMode: (m: Mode) => void; shellEnabled: boolean;
  tick: number; refresh: () => void; reloadRoots: () => Promise<void>;
  setDialog: (d: Dialog | null) => void; notice: string; setNotice: (s: string) => void;
  showHidden: boolean; setShowHidden: (v: boolean) => void;
};
const LocalCtx = createContext<Ctx | null>(null);
const useLocal = () => useContext(LocalCtx);
export type Mode = 'sandbox' | 'real';
const UNLOCK_PHRASE = 'unlock-real-files-and-shell'; // must match localAccess.ts
/** 'sandbox' (VFS only) or 'real' (mapped folders + real shell). Outside the desktop app: always 'sandbox'. */
export const useMode = (): Mode => useLocal()?.mode ?? 'sandbox';
const MEDIA: Record<string, 'image' | 'video' | 'audio'> = {
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video', mov: 'video', mkv: 'video',
  mp3: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', wav: 'audio', flac: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image',
};
const mediaKind = (rel: string) => MEDIA[(rel.split('.').pop() || '').toLowerCase()];

export function LocalProvider({ children }: { children: React.ReactNode }) {
  const [roots, setRoots] = useState<{ path: string; name: string }[]>([]);
  const [sel, setSelRaw] = useState<Sel | null>(null);
  const [cwd, setCwd] = useState<{ root: string; rel: string } | null>(null);
  const [home, setHome] = useState('');
  const [file, setFile] = useState<Ctx['file']>(null);
  const [mode, setModeState] = useState<Mode>('sandbox');
  const [tick, setTick] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState('');
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem('aetherterm_show_hidden') === '1');
  useEffect(() => { localStorage.setItem('aetherterm_show_hidden', showHidden ? '1' : '0'); }, [showHidden]);

  const reloadRoots = useCallback(async () => {
    const r = await api<{ home: string; roots: { path: string; name: string }[] }>('/api/local/roots');
    setRoots(r.roots); setHome(r.home);
    setCwd((c) => c || (r.roots[0] ? { root: r.roots[0].path, rel: '' } : null));
  }, []);
  useEffect(() => {
    if (!isDesktop) return;
    api<{ mode: Mode }>('/api/local/mode').then((m) => setModeState(m.mode)).catch((e) => setNotice(String(e.message || e)));
  }, []);
  useEffect(() => {
    if (!isDesktop) return;
    if (mode === 'real') { reloadRoots().catch((e) => setNotice(String(e.message || e))); }
    else { setFile(null); setSelRaw(null); setRoots([]); setCwd(null); setHome(''); }
  }, [mode, reloadRoots]);
  const applyMode = async (m: Mode) => {
    const r = await api<{ mode: Mode }>('/api/local/mode', m === 'real' ? { mode: m, confirm: UNLOCK_PHRASE } : { mode: m });
    setModeState(r.mode);
    setNotice(r.mode === 'real' ? 'Real files and shell unlocked.' : 'Sandbox is on. Real files and shell are locked.');
  };
  const requestMode = (m: Mode) => {
    if (m === mode) return;
    if (m === 'sandbox') { applyMode('sandbox').catch((e) => setNotice(String(e.message || e))); return; }
    setDialog({
      kind: 'confirm', title: 'Leave the Sandbox?', okLabel: 'Unlock real files and shell',
      body: 'This unlocks:\n\n'
        + '•  Your real folders (starting with your home folder): read, edit, rename and move to Trash.\n'
        + '•  A real terminal running your login shell as you. Commands there can change or delete anything you can.\n\n'
        + 'The terminal switches to real bash and Home becomes your real home folder. Milla and generated apps still stay in the sandbox VFS. Switching back to Sandbox is one click and closes any real shell.',
      onOk: () => applyMode('real'),
    });
  };

  const setSel = (s: Sel | null) => {
    setSelRaw(s);
    if (s) setCwd({ root: s.root, rel: s.type === 'dir' ? s.rel : parent(s.rel) });
  };
  const openFile = async (root: string, rel: string) => {
    const kind = mediaKind(rel);
    const opened = (detail: { root: string; rel: string; content: string | null; url?: string }) => window.dispatchEvent(new CustomEvent('aether-file-opened', { detail }));
    if (kind) { const url = `/api/local/raw?${q({ root, path: rel })}`; setFile({ root, rel, content: '', saved: '', media: kind, url }); opened({ root, rel, content: null, url }); return; }
    const r = await api<{ binary: boolean; tooLarge?: boolean; content: string | null }>(`/api/local/read?${q({ root, path: rel })}`);
    if (r.binary) { setNotice(r.tooLarge ? 'File is too large to edit here (over 5 MB).' : 'Binary file, not opened.'); return; }
    setFile({ root, rel, content: r.content || '', saved: r.content || '' });
    opened({ root, rel, content: r.content || '' });
  };
  const save = async () => {
    if (!file) return;
    await api('/api/local/write', { root: file.root, path: file.rel, content: file.content });
    setFile({ ...file, saved: file.content });
    setNotice(`Saved ${file.rel}`);
    setTick((t) => t + 1);
  };

  if (!isDesktop) return <>{children}</>;
  return (
    <LocalCtx.Provider value={{
      roots, sel, setSel, cwd, home, file, openFile,
      setContent: (c) => file && setFile({ ...file, content: c }), save, closeFile: () => setFile(null),
      mode, requestMode, shellEnabled: mode === 'real', tick, refresh: () => setTick((t) => t + 1), reloadRoots, setDialog, notice, setNotice, showHidden, setShowHidden,
    }}>
      {children}
      {dialog && <DialogView d={dialog} close={() => setDialog(null)} setNotice={setNotice} />}
    </LocalCtx.Provider>
  );
}

function DialogView({ d, close, setNotice }: { d: Dialog; close: () => void; setNotice: (s: string) => void }) {
  const [v, setV] = useState(d.kind === 'name' ? d.initial : '');
  const [busy, setBusy] = useState(false);
  const ok = async () => {
    setBusy(true);
    try { d.kind === 'name' ? await d.onOk(v.trim()) : await d.onOk(); close(); }
    catch (e: any) { setNotice(String(e.message || e)); setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[200] bg-void/70 flex items-center justify-center" data-testid="local-dialog">
      <div className="bg-surface-1 border border-glow-500/40 rounded-lg p-5 w-[440px] shadow-2xl">
        <div className="text-glow-300 font-bold mb-3">{d.title}</div>
        {d.kind === 'name' ? (
          <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok()}
            className="w-full bg-void border border-ink-700 rounded px-2 py-1 text-ink-100 outline-none focus:border-glow-500" />
        ) : <div className="text-ink-300 text-sm whitespace-pre-wrap">{d.body}</div>}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={close} className="px-3 py-1 text-sm rounded border border-ink-700 text-ink-300 hover:bg-ink-800">Cancel</button>
          <button disabled={busy} onClick={ok} data-testid="dialog-ok"
            className={`px-3 py-1 text-sm rounded text-bright ${d.kind === 'confirm' ? 'bg-real-700 hover:bg-real-600' : 'bg-glow-700 hover:bg-glow-600'}`}>
            {d.kind === 'confirm' ? d.okLabel : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Node({ root, rel, name, type, link, outside, depth }: { key?: string; root: string; rel: string; name: string; type: 'dir' | 'file' | 'other'; link?: boolean; outside?: boolean; depth: number }) {
  const c = useLocal()!;
  const [expanded, setExpanded] = useState(depth === 0);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState('');
  const selected = c.sel && c.sel.root === root && c.sel.rel === rel;
  useEffect(() => {
    if (type !== 'dir' || !expanded || outside) return;
    api<{ entries: Entry[] }>(`/api/local/list?${q({ root, path: rel })}`)
      .then((r) => { setEntries(r.entries); setErr(''); }).catch((e) => setErr(String(e.message || e)));
  }, [expanded, c.tick, root, rel, type, outside]);
  const click = () => {
    if (outside) { c.setNotice(`${name} links outside the mapped folder and is not opened.`); return; }
    c.setSel({ root, rel, type: type === 'dir' ? 'dir' : 'file' });
    if (type === 'dir') setExpanded(!expanded); else c.openFile(root, rel).catch((e) => c.setNotice(String(e.message || e)));
  };
  const hidden = name.startsWith('.') && depth > 0;
  return (
    <div>
      <div data-path={`${root}::${rel}`} onClick={click}
        className={`flex items-center gap-1 py-0.5 text-xs cursor-pointer rounded px-1 ${selected ? 'bg-glow-900/40 text-glow-200' : 'hover:text-glow-300'} ${hidden ? 'opacity-60' : ''}`}
        style={{ paddingLeft: depth * 12 + 4 }}>
        {type === 'dir' ? (expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : <span className="w-[11px]" />}
        {depth === 0 ? <HardDrive size={13} className="text-glow-400 shrink-0" /> : type === 'dir' ? (expanded ? <FolderOpen size={13} className="text-folder-500 shrink-0" /> : <Folder size={13} className="text-folder-500 shrink-0" />) : <File size={13} className="text-ink-400 shrink-0" />}
        <span className="truncate">{name}</span>
        {link && <Link2 size={10} className={outside ? 'text-danger-400' : 'text-ink-500'} />}
      </div>
      {type === 'dir' && expanded && (
        <div>
          {err && <div className="text-danger-400 text-[10px] pl-6">{err}</div>}
          {entries?.filter((e) => c.showHidden || !e.name.startsWith('.')).map((e) => (
            <Node key={e.name} root={root} rel={join(rel, e.name)} name={e.name} type={e.type} link={e.link} outside={e.outside} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Sidebar section: mapped folders with create / rename / delete. */
export function LocalExplorer() {
  const c = useLocal();
  if (!c || c.mode !== 'real') return null;
  const base = c.sel ? (c.sel.type === 'dir' ? c.sel : { ...c.sel, rel: parent(c.sel.rel) }) : c.cwd;
  const create = (kind: 'file' | 'folder') => base && c.setDialog({
    kind: 'name', title: `New ${kind} in ${base.rel || base.root}`, initial: '',
    onOk: async (name) => {
      const rel = join(base.rel, name);
      await api(kind === 'file' ? '/api/local/write' : '/api/local/mkdir', { root: base.root, path: rel, content: '', create: true });
      c.refresh();
      if (kind === 'file') await c.openFile(base.root, rel);
    },
  });
  const rename = () => c.sel && c.sel.rel && c.setDialog({
    kind: 'name', title: `Rename ${c.sel.rel}`, initial: c.sel.rel.split('/').pop() || '',
    onOk: async (name) => {
      const to = join(parent(c.sel!.rel), name);
      await api('/api/local/rename', { root: c.sel!.root, from: c.sel!.rel, to });
      if (c.file && c.file.root === c.sel!.root && c.file.rel === c.sel!.rel) c.closeFile();
      c.setSel({ ...c.sel!, rel: to }); c.refresh();
    },
  });
  const del = () => c.sel && c.sel.rel && c.setDialog({
    kind: 'confirm', title: 'Move to Trash?', okLabel: 'Move to Trash',
    body: `${c.sel.root}/${c.sel.rel}\n\nThis moves the ${c.sel.type === 'dir' ? 'folder and everything in it' : 'file'} to your Trash. You can restore it from the Trash in your file manager.`,
    onOk: async () => {
      await bridge!.trash(c.sel!.root, c.sel!.rel);
      if (c.file && c.file.root === c.sel!.root && c.file.rel.startsWith(c.sel!.rel)) c.closeFile();
      c.setNotice(`Moved ${c.sel!.rel} to Trash`); c.setSel(null); c.refresh();
    },
  });
  const pick = async () => { const r = await bridge!.pickFolder(); await c.reloadRoots(); if (r.added) c.setNotice(`Opened ${r.added}`); };
  const btn = 'p-1 rounded hover:bg-ink-800 hover:text-glow-300 disabled:opacity-30';
  const canEdit = !!(c.sel && c.sel.rel);
  return (
    <div className="border-t border-ink-800 flex flex-col min-h-0 flex-1" data-testid="local-explorer">
      <div className="px-3 py-2 flex items-center justify-between text-glow-400">
        <span className="font-bold tracking-wider text-xs flex items-center gap-1"><HardDrive size={13} /> LOCAL FOLDERS</span>
        <div className="flex items-center text-ink-400">
          <button className={btn} title="Open folder" onClick={pick} data-testid="open-folder"><FolderOpen size={14} /></button>
          <button className={btn} title="New file" onClick={() => create('file')} data-testid="new-file"><FilePlus size={14} /></button>
          <button className={btn} title="New folder" onClick={() => create('folder')}><FolderPlus size={14} /></button>
          <button className={btn} title="Rename" disabled={!canEdit} onClick={rename} data-testid="rename"><Pencil size={13} /></button>
          <button className={btn} title="Move to Trash" disabled={!canEdit} onClick={del} data-testid="delete"><Trash2 size={13} /></button>
          <button className={btn} title={c.showHidden ? 'Hide dotfiles' : 'Show dotfiles'} onClick={() => c.setShowHidden(!c.showHidden)}>{c.showHidden ? <Eye size={13} /> : <EyeOff size={13} />}</button>
          <button className={btn} title="Refresh" onClick={c.refresh}><RefreshCw size={12} /></button>
        </div>
      </div>
      <button type="button" data-testid="explorer-home" data-home={c.home} title="Home follows the mode: in Real mode it is your real home folder"
        onClick={() => c.home && c.setSel({ root: c.home, rel: '', type: 'dir' })}
        className="mx-2 mb-1 px-2 py-1 rounded text-[11px] text-left border border-ink-800 hover:border-glow-500/40 flex items-center gap-1.5">
        <Home size={12} className="text-glow-400 shrink-0" /> <span className="text-ink-400">Home</span> <span className="text-ink-200 truncate">{c.home || '…'}</span>
      </button>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {c.roots.map((r) => <Node key={r.path} root={r.path} rel="" name={r.name} type="dir" depth={0} />)}
      </div>
      {c.notice && <div className="px-3 py-1 text-[10px] text-sandbox-300 border-t border-ink-800 truncate" title={c.notice} data-testid="local-notice">{c.notice}</div>}
    </div>
  );
}

/** The real bash terminal (Real mode only). Starts by itself in your home folder. */
export function RealShell() {
  const c = useLocal()!;
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sockRef = useRef<Socket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const term = new Terminal({ fontFamily: 'ui-monospace, "JetBrains Mono", monospace', fontSize: 13, cursorBlink: true, theme: terminalTheme });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); fit.fit();
    termRef.current = term; fitRef.current = fit;
    const sock = io('/pty', { transports: ['websocket'], withCredentials: true });
    sockRef.current = sock;
    sock.on('connect_error', (e) => setStatus(`Shell connection refused: ${e.message}`));
    sock.on('data', (d: string) => term.write(d));
    sock.on('started', (s: { shell: string; cwd: string; pid: number }) => setStatus(`${s.shell} in ${s.cwd} (pid ${s.pid})`));
    sock.on('refused', (r: { reason: string }) => { setStatus(`Refused: ${r.reason}`); term.write(`\r\n\x1b[31m[${r.reason}]\x1b[0m\r\n`); });
    sock.on('exit', (e: { exitCode: number }) => { setStatus(`Shell exited (${e.exitCode})`); term.write(`\r\n[shell exited ${e.exitCode}]\r\n`); });
    term.onData((d) => sock.emit('input', d));
    // v0.4: `canvas FILE` in bash prints OSC 7337 ("canvas;<absolute path>"); show that file in the Workspace canvas.
    const osc = term.parser.registerOscHandler(7337, (data) => {
      const [cmd, ...rest] = data.split(';');
      if (cmd === 'canvas' && rest.length) window.dispatchEvent(new CustomEvent('aether-canvas-file', { detail: { abs: rest.join(';') } }));
      return true;
    });
    term.onResize(({ cols, rows }) => sock.emit('resize', { cols, rows }));
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(host.current!);
    (window as any).__aetherShell = { term, get sock() { return sockRef.current; } }; // lets packaging tests read the screen buffer
    return () => { osc.dispose(); ro.disconnect(); sock.close(); term.dispose(); };
  }, []);

  const start = () => {
    const t = termRef.current!; const cwd = c.cwd;
    t.reset(); setStatus('Starting…');
    sockRef.current?.emit('stop');
    setTimeout(() => sockRef.current?.emit('start', { root: cwd?.root, path: cwd?.rel || '', cols: t.cols, rows: t.rows }), 100);
    t.focus();
  };
  useEffect(() => { const id = setTimeout(() => { if (c.shellEnabled) start(); }, 400); return () => clearTimeout(id); }, []); // first shell

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-2 py-1 bg-surface-1 border-b border-ink-800 text-xs">
        <TerminalSquare size={13} className="text-real-400" />
        <span className="text-ink-400 truncate flex-1" data-testid="shell-status">{status}</span>
        <button onClick={start} disabled={!c.shellEnabled} data-testid="shell-here"
          className="px-2 py-0.5 rounded border border-real-600/40 text-real-300 hover:bg-real-900/40 disabled:opacity-30">
          New shell in {c.cwd ? (c.cwd.rel || c.roots.find((r) => r.path === c.cwd!.root)?.name || c.cwd.root) : '~'}
        </button>
        <span className="flex items-center gap-1 text-real-300" title="Real shell: runs as you, outside the sandbox" data-testid="real-shell-label"><Power size={12} className="text-real-400" /> Real bash</span>
      </div>
      <div ref={host} className="flex-1 min-h-0 p-1 bg-surface-0" data-testid="xterm-host" />
    </div>
  );
}

/** Real mode: the file opened from LOCAL FOLDERS, shown above the always-on terminal. */
export function LocalFilePane() {
  const c = useLocal();
  if (!c || c.mode !== 'real' || !c.file) return null;
  const f = c.file;
  const dirty = f.content !== f.saved;
  return (
    <div className="h-[42%] min-h-[140px] shrink-0 flex flex-col border-b border-ink-800 bg-surface-0" data-testid="local-workspace">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-ink-800 bg-surface-1 text-xs">
        <FolderOpen size={14} className="text-glow-400" />
        <span className="text-ink-300 truncate flex-1">{`${f.root}/${f.rel}${dirty ? ' •' : ''}`}</span>
        {!f.media && <button onClick={() => c.save().catch((e) => c.setNotice(String(e.message || e)))} disabled={!dirty} data-testid="save"
          className="px-2 py-0.5 rounded bg-glow-700 text-bright disabled:opacity-30 flex items-center gap-1"><Save size={12} /> Save</button>}
        <button onClick={c.closeFile} className="p-1 text-ink-400 hover:text-bright" title="Close file" data-testid="close-file"><X size={13} /></button>
      </div>
      {f.media && (
        <div className="flex-1 min-h-0 w-full flex items-center justify-center bg-void p-2" data-testid="local-media">
          {f.media === 'image' && <img src={f.url} alt={f.rel} className="max-h-full max-w-full object-contain" />}
          {f.media === 'video' && <video src={f.url} controls autoPlay muted playsInline className="max-h-full max-w-full" />}
          {f.media === 'audio' && <audio src={f.url} controls autoPlay />}
        </div>
      )}
      {!f.media && (
        <textarea value={f.content} spellCheck={false} data-testid="editor"
          onChange={(e) => c.setContent(e.target.value)}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); c.save().catch(() => {}); } }}
          className="flex-1 min-h-0 w-full resize-none bg-surface-2 text-ink-100 p-3 text-sm outline-none font-mono" />
      )}
    </div>
  );
}

/** Header control: shows the current mode and switches it (OFF needs the confirm dialog). */
export function ModeSwitch() {
  const c = useLocal();
  if (!c) return null;
  const real = c.mode === 'real';
  return (
    <div className="flex items-center gap-1" data-testid="mode-switch" data-mode={c.mode}>
      <button type="button" onClick={() => c.requestMode(real ? 'sandbox' : 'real')} data-testid="mode-button"
        title={real ? 'Real files and shell are unlocked. Click to go back to the Sandbox (closes any real shell).' : 'Sandbox: Milla, the shell and files are confined to the virtual file system. Click to unlock real files and shell.'}
        className={`px-2.5 py-1 rounded text-xs font-mono font-bold flex items-center gap-1.5 border transition-colors ${real
          ? 'bg-real-900/50 text-real-200 border-real-500/60 hover:bg-real-800/60'
          : 'bg-sandbox-900/30 text-sandbox-200 border-sandbox-500/50 hover:bg-sandbox-800/40'}`}>
        {real ? <ShieldOff size={13} /> : <Shield size={13} />}
        {real ? 'REAL FILES + SHELL' : 'SANDBOX'}
      </button>
    </div>
  );
}

/** Thin banner under the header so the mode is never ambiguous. */
export function ModeBanner() {
  const c = useLocal();
  if (!c) return null;
  const real = c.mode === 'real';
  return (
    <div data-testid="mode-banner" className={`px-4 py-1 text-[11px] font-mono flex items-center gap-2 border-b ${real
      ? 'bg-real-950/60 text-real-200 border-real-800/60'
      : 'bg-sandbox-950/40 text-sandbox-200 border-sandbox-800/50'}`}>
      {real ? <ShieldOff size={12} /> : <Shield size={12} />}
      {real
        ? <span><b>Real files and shell.</b> The terminal is real bash and Home is {c.home || 'your home folder'}. Milla and generated apps stay in the VFS.</span>
        : <span><b>Sandbox.</b> The terminal, files and Milla only see the virtual file system. Your real folders and bash are locked.</span>}
      {real && <button type="button" onClick={() => c.requestMode('sandbox')} data-testid="back-to-sandbox"
        className="ml-auto px-2 py-0.5 rounded border border-sandbox-500/50 text-sandbox-200 hover:bg-sandbox-900/40">Back to Sandbox</button>}
    </div>
  );
}
