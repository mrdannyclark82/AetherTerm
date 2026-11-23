// AetherTerm v0.3: Milla Workspace canvas. Live, sandboxed previews of what Milla builds,
// with versions, re-run, source editing, revise-with-Milla and Comparison mode.
// v0.4: an automatic canvas. Shell output, Milla replies, media and file previews land here
// as versions of any kind (see artifact.ts). "Follow" decides whether new output takes over
// the view; when paused, new items wait as unseen versions and nothing steals focus.
// UX follows candy/local-chat-shell-v2's Canvas (MIT, Danny Clark); see PLAN-canvas.md.
import React, { useEffect, useMemo, useState } from 'react';
import { Play, RotateCcw, Copy, Columns2, Code2, Eye, Globe, GlobeLock, Save, Trash2, Wand2, X, Pin, Radio } from 'lucide-react';
import { diffLines, previewDoc } from './canvas-util';
import { Artifact, ArtifactKind, isMediaKind, renderArtifact } from './artifact';

export type CanvasVersion = {
  id: string; n: number; title: string; html: string; source: string; at: number;
  kind?: ArtifactKind; raw?: string; url?: string; lang?: string; origin?: 'sandbox' | 'real';
};
const kindOf = (v: CanvasVersion): ArtifactKind => v.kind || 'html';
/** The editable text of a version: the original markdown/CSV/code, or the HTML. */
const textOf = (v: CanvasVersion) => (isMediaKind(kindOf(v)) ? v.url || '' : v.raw ?? v.html);
const KEY = 'aetherterm_canvas_versions';
const MAX = 20;

export function loadVersions(): CanvasVersion[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.slice(-MAX) : []; } catch { return []; }
}
export function saveVersions(v: CanvasVersion[]) {
  try { localStorage.setItem(KEY, JSON.stringify(v.slice(-MAX))); } catch {}
}
export function addVersion(list: CanvasVersion[], html: string, title: string, source: string): CanvasVersion[] {
  return addArtifact(list, { kind: 'html', html, raw: html, title, source, origin: 'sandbox' });
}
/** Add any artifact as a new version. Returns the list unchanged if it repeats the newest version. */
export function addArtifact(list: CanvasVersion[], a: Artifact): CanvasVersion[] {
  const last = list[list.length - 1];
  const html = isMediaKind(a.kind) ? '' : (a.html ?? renderArtifact(a.kind, a.raw || '', a.lang));
  if (last && kindOf(last) === a.kind && (last.raw ?? last.html) === (a.raw ?? html) && (last.url || '') === (a.url || '')) return list;
  const n = (list.length ? Math.max(...list.map((v) => v.n)) : 0) + 1;
  return [...list, { id: `${Date.now()}-${n}`, n, title: a.title, html, source: a.source, at: Date.now(), kind: a.kind, raw: a.raw, url: a.url, lang: a.lang, origin: a.origin }].slice(-MAX);
}

/** One preview. sandbox="allow-scripts" only: opaque origin, no same-origin with the app,
 *  no top navigation, no popups, no forms. CSP is injected into the document. */
function Frame({ html, net, runKey, label }: { html: string; net: boolean; runKey: number; label: string }) {
  const doc = useMemo(() => previewDoc(html, net), [html, net]);
  return <iframe key={runKey} title={label} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc}
    className="w-full h-full border-0 bg-bright" data-testid="canvas-frame" />;
}
/** Images, video and audio render directly (media tags run no script). */
function MediaView({ v, runKey }: { v: CanvasVersion; runKey: number }) {
  const k = kindOf(v);
  return (
    <div key={runKey} className="w-full h-full flex items-center justify-center bg-void p-2" data-testid="canvas-media">
      {k === 'image' && <img src={v.url} alt={v.title} className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" />}
      {k === 'video' && <video src={v.url} controls muted playsInline className="max-w-full max-h-full" />}
      {k === 'audio' && <audio src={v.url} controls />}
    </div>
  );
}
function View({ v, net, runKey, label }: { v: CanvasVersion; net: boolean; runKey: number; label: string }) {
  return isMediaKind(kindOf(v)) ? <MediaView v={v} runKey={runKey} /> : <Frame html={v.html} net={net} runKey={runKey} label={label} />;
}

type Props = {
  versions: CanvasVersion[];
  setVersions: (v: CanvasVersion[]) => void;
  activeId: string | null; setActiveId: (id: string | null) => void;
  onRevise: (html: string, request: string) => void; revising: boolean;
  onClose: () => void;
  follow: boolean; setFollow: (v: boolean) => void; unseen: number; onSeen: () => void;
};

export function Canvas({ versions, setVersions, activeId, setActiveId, onRevise, revising, onClose, follow, setFollow, unseen, onSeen }: Props) {
  const active = versions.find((v) => v.id === activeId) || versions[versions.length - 1];
  const [tab, setTab] = useState<'preview' | 'source' | 'compare'>('preview');
  const [runKey, setRunKey] = useState(0);
  const [net, setNet] = useState(false);
  const [draft, setDraft] = useState(active ? textOf(active) : '');
  const [ask, setAsk] = useState('');
  const [aId, setAId] = useState<string | null>(null);
  const [bId, setBId] = useState<string | null>(null);
  useEffect(() => { setDraft(active ? textOf(active) : ''); }, [active?.id]);
  useEffect(() => { (window as any).__aetherCanvas = { tab, setTab, rerun: () => setRunKey((k) => k + 1) }; }, [tab]);
  if (!active) return null;
  const A = versions.find((v) => v.id === aId) || versions[Math.max(0, versions.length - 2)];
  const B = versions.find((v) => v.id === bId) || active;
  const dirty = draft !== textOf(active);
  const media = isMediaKind(kindOf(active));
  const tabBtn = (id: typeof tab, icon: React.ReactNode, label: string) => (
    <button type="button" onClick={() => setTab(id)} data-testid={`canvas-tab-${id}`}
      className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 ${tab === id ? 'bg-brand-600 text-bright' : 'text-ink-400 hover:bg-ink-800'}`}>{icon}{label}</button>
  );
  const btn = 'px-2 py-1 rounded text-[11px] flex items-center gap-1 text-ink-300 border border-ink-700 hover:bg-ink-800 disabled:opacity-40';

  return (
    <div className="flex flex-col min-h-0 h-full border-b border-ink-800 bg-surface-1" data-testid="canvas">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-ink-800 bg-surface-2 flex-wrap">
        <span className="text-[10px] font-bold tracking-widest text-brand-300 mr-1">CANVAS</span>
        {tabBtn('preview', <Eye size={12} />, 'Preview')}
        {tabBtn('source', <Code2 size={12} />, 'Source')}
        {tabBtn('compare', <Columns2 size={12} />, 'Compare')}
        <span className="flex-1" />
        <button type="button" className={btn} onClick={() => setRunKey((k) => k + 1)} title="Re-run (fresh state)" data-testid="canvas-rerun"><RotateCcw size={12} /> Re-run</button>
        <button type="button" className={`${btn} ${follow ? 'border-glow-500/50 text-glow-200' : ''}`} onClick={() => { setFollow(!follow); if (!follow) { setActiveId(versions[versions.length - 1]?.id || null); onSeen(); } }} data-testid="canvas-follow" data-follow={follow ? '1' : '0'}
          title={follow ? 'Following: new shell output and Milla results open here automatically. Click to pin the current view.' : 'Pinned: new output is kept as versions but does not take over the view. Click to follow again.'}>
          {follow ? <Radio size={12} /> : <Pin size={12} />}{follow ? 'follow' : 'pinned'}
          {!follow && unseen > 0 && <span className="ml-1 px-1 rounded bg-brand-700 text-bright" data-testid="canvas-unseen">{unseen} new</span>}
        </button>
        <button type="button" className={btn} onClick={() => navigator.clipboard?.writeText(textOf(active))} title="Copy source"><Copy size={12} /></button>
        <button type="button" className={`${btn} ${net ? 'border-sandbox-500/60 text-sandbox-300' : ''}`} onClick={() => setNet(!net)} data-testid="canvas-net"
          title={net ? 'Network ON: https: only (CDNs). Your local server stays blocked.' : 'Network OFF: the preview cannot load or send anything.'}>
          {net ? <Globe size={12} /> : <GlobeLock size={12} />}{net ? 'https on' : 'offline'}
        </button>
        <button type="button" className="p-1 text-ink-500 hover:text-bright" onClick={onClose} title="Hide canvas"><X size={14} /></button>
      </div>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-ink-800 overflow-x-auto" data-testid="canvas-versions">
        {versions.map((v) => (
          <button type="button" key={v.id} data-kind={kindOf(v)} onClick={() => { setActiveId(v.id); if (v.id === versions[versions.length - 1].id) onSeen(); }} title={`${kindOf(v)} · ${v.title} · ${v.source} · ${new Date(v.at).toLocaleTimeString()}`}
            className={`px-2 py-0.5 rounded text-[10px] whitespace-nowrap border ${v.id === active.id ? 'bg-brand-900/60 border-brand-500 text-brand-100' : 'border-ink-700 text-ink-400 hover:text-ink-200'}`}>
            v{v.n} <span className="opacity-60">{kindOf(v)}</span> {v.title}
          </button>
        ))}
        <button type="button" className="ml-auto p-1 text-ink-600 hover:text-danger-400" title="Delete this version"
          onClick={() => { const rest = versions.filter((v) => v.id !== active.id); setVersions(rest); setActiveId(rest[rest.length - 1]?.id || null); }}><Trash2 size={11} /></button>
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'preview' && <View v={active} net={net} runKey={runKey} label={`Preview v${active.n}`} />}
        {tab === 'source' && (
          <div className="h-full flex flex-col">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} data-testid="canvas-source" readOnly={media}
              className="flex-1 min-h-0 w-full resize-none bg-surface-2 text-ink-100 p-2 text-[11px] font-mono outline-none" />
            <div className="flex items-center gap-2 p-1.5 border-t border-ink-800">
              <button type="button" className={btn} disabled={!dirty} data-testid="canvas-save-version"
                onClick={() => { const k = kindOf(active); const next = addArtifact(versions, { kind: k, raw: draft, html: renderArtifact(k, draft, active.lang), lang: active.lang, title: active.title, source: `edited v${active.n}`, origin: active.origin || 'sandbox' }); setVersions(next); setActiveId(next[next.length - 1].id); setTab('preview'); }}>
                <Save size={12} /> Save as new version
              </button>
              <button type="button" className={btn} disabled={!dirty} onClick={() => setDraft(textOf(active))}>Discard edits</button>
              <span className="text-[10px] text-ink-500">{dirty ? 'Edited (not saved)' : `v${active.n} · ${kindOf(active)} · ${active.source}`}</span>
            </div>
          </div>
        )}
        {tab === 'compare' && (
          <div className="h-full flex flex-col" data-testid="canvas-compare">
            <div className="flex items-center gap-2 px-2 py-1 text-[10px] text-ink-400 border-b border-ink-800">
              A <select className="bg-void border border-ink-700 rounded" value={A.id} onChange={(e) => setAId(e.target.value)}>
                {versions.map((v) => <option key={v.id} value={v.id}>v{v.n} {v.title}</option>)}</select>
              B <select className="bg-void border border-ink-700 rounded" value={B.id} onChange={(e) => setBId(e.target.value)}>
                {versions.map((v) => <option key={v.id} value={v.id}>v{v.n} {v.title}</option>)}</select>
            </div>
            <div className="flex-1 min-h-0 grid grid-cols-2 gap-px bg-ink-800">
              <div className="min-h-0 flex flex-col"><div className="text-[10px] px-1 bg-surface-2 text-ink-400">A · v{A.n}</div><div className="flex-1 min-h-0"><View v={A} net={net} runKey={runKey} label={`Compare A v${A.n}`} /></div></div>
              <div className="min-h-0 flex flex-col"><div className="text-[10px] px-1 bg-surface-2 text-ink-400">B · v{B.n}</div><div className="flex-1 min-h-0"><View v={B} net={net} runKey={runKey} label={`Compare B v${B.n}`} /></div></div>
            </div>
            <pre className="h-[28%] overflow-auto text-[10px] leading-tight p-1 bg-void border-t border-ink-800" data-testid="canvas-diff">
              {diffLines(textOf(A), textOf(B)).filter((d, i, all) => d.op !== ' ' || all[i - 1]?.op !== ' ' || all[i + 1]?.op !== ' ').map((d, i) => (
                <div key={i} className={d.op === '+' ? 'text-ok-300 bg-ok-950/40' : d.op === '-' ? 'text-danger-300 bg-danger-950/40' : 'text-ink-500'}>{d.op} {d.line}</div>
              ))}
            </pre>
          </div>
        )}
      </div>

      <form className="flex gap-1.5 p-1.5 border-t border-ink-800 bg-surface-1" onSubmit={(e) => { e.preventDefault(); if (ask.trim() && !revising) { onRevise(active.html, ask.trim()); setAsk(''); } }}>
        <input value={ask} onChange={(e) => setAsk(e.target.value)} disabled={revising || media} data-testid="canvas-revise-input"
          placeholder={media ? 'Media can\'t be revised here' : revising ? 'Milla is revising…' : `Ask Milla to change v${active.n}…`}
          className="flex-1 bg-void text-ink-200 text-[11px] font-mono px-2 py-1 rounded outline-none border border-ink-800 focus:border-brand-500/50" />
        <button type="submit" disabled={revising || !ask.trim()} className="px-2 rounded bg-brand-700 text-bright text-[11px] flex items-center gap-1 disabled:opacity-40"><Wand2 size={12} /> Revise</button>
        <button type="button" className={btn} onClick={() => { setTab('preview'); setRunKey((k) => k + 1); }}><Play size={12} /></button>
      </form>
    </div>
  );
}
