// AetherTerm v0.4: the Milla Workspace is an automatic canvas.
// Anything Milla or the shell produces that renders (HTML, markdown, images, video,
// audio, code, diffs, file previews, CSV/TSV tables, JSON, long command output)
// becomes a canvas "artifact". Text kinds are rendered here into a self-contained,
// script-free HTML page that runs in the same sandboxed iframe as generated apps.
import { codeBlocks, htmlFromReply, titleOf } from './canvas-util';
import { preview as P } from '../theme';

export type ArtifactKind = 'html' | 'markdown' | 'csv' | 'tsv' | 'json' | 'code' | 'diff' | 'output' | 'image' | 'video' | 'audio';
export const MEDIA_KINDS: ArtifactKind[] = ['image', 'video', 'audio'];
export const isMediaKind = (k?: string) => !!k && (MEDIA_KINDS as string[]).includes(k);

export type Artifact = {
  kind: ArtifactKind;
  title: string;
  source: string;           // where it came from ("shell: cat ~/a.csv", "Milla", ...)
  raw?: string;             // original text (markdown, CSV, code, ...)
  html?: string;            // rendered page for the iframe (text kinds)
  url?: string;             // media URL (VFS data URL, web URL, or /api/local/raw in Real mode)
  lang?: string;            // code language
  origin: 'sandbox' | 'real'; // real-file artifacts are hidden while the Sandbox is on
};

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const EXT: Record<string, ArtifactKind> = {
  html: 'html', htm: 'html', xhtml: 'html', svg: 'html',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  csv: 'csv', tsv: 'tsv', json: 'json', diff: 'diff', patch: 'diff',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image',
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video', mov: 'video', mkv: 'video',
  mp3: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', wav: 'audio', flac: 'audio',
};
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'sh', 'bash', 'zsh', 'fish', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'rb', 'php', 'lua', 'css', 'scss', 'sql', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'nix', 'swift', 'cs', 'pl']);
export const extOf = (p: string) => (String(p || '').split(/[?#]/)[0].split('/').pop()?.split('.').slice(1).pop() || '').toLowerCase();
export const kindOfPath = (p: string): ArtifactKind | null => EXT[extOf(p)] || (CODE_EXT.has(extOf(p)) ? 'code' : null);
const baseName = (p: string) => String(p || '').split('/').pop() || p;

// ---------- detection ----------

const SKIP_COMMANDS = new Set(['help', 'clear', 'cd', 'pwd', 'echo', 'ls', 'mkdir', 'touch', 'ollama', 'set-boot', 'edit']);
/** "Trivial" output never auto-opens: short plain text stays in the terminal. */
const isLong = (t: string) => t.split('\n').length >= 12 || t.length >= 700;

function looksCsv(t: string, sep: string): boolean {
  const lines = t.trim().split('\n').filter((l) => l.trim());
  if (lines.length < 3) return false;
  const n = (l: string) => l.split(sep).length - 1;
  const first = n(lines[0]);
  if (first < 1) return false;
  return lines.filter((l) => n(l) === first).length / lines.length >= 0.8;
}
function looksMarkdown(t: string): boolean {
  const lines = t.split('\n');
  if (lines.length < 4) return false;
  let signals = 0;
  if (lines.some((l) => /^#{1,6}\s+\S/.test(l))) signals++;
  if (/```/.test(t)) signals++;
  if (lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= 2) signals++;
  if (lines.filter((l) => /^\s*([-*+]|\d+\.)\s+\S/.test(l)).length >= 2) signals++;
  if (/\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(t)) signals++;
  return signals >= 2;
}
const looksDiff = (t: string) => /^@@ .* @@/m.test(t) && /^(---|\+\+\+) /m.test(t);
const looksHtml = (t: string) => /^\s*(<!doctype html|<html[\s>])/i.test(t);
function looksJson(t: string): boolean {
  const s = t.trim();
  if (s.length < 80 || !/^[[{]/.test(s)) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

/** Decide whether a piece of shell output is worth showing in the canvas. */
export function fromShellOutput(text: string, opts: { path?: string; command?: string; origin: 'sandbox' | 'real' }): Artifact | null {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  const cmd = (opts.command || '').trim().split(/\s+/)[0];
  if (cmd && SKIP_COMMANDS.has(cmd)) return null;
  const src = `shell${opts.command ? `: ${opts.command}` : ''}`;
  if (opts.path) {
    const k = kindOfPath(opts.path);
    if (k && !isMediaKind(k)) return make(k, t, baseName(opts.path), src, opts.origin, extOf(opts.path));
  }
  if (looksHtml(t)) return make('html', t, titleOf(t, 'HTML'), src, opts.origin);
  if (looksDiff(t)) return make('diff', t, 'diff', src, opts.origin);
  if (looksJson(t)) return make('json', t, 'JSON', src, opts.origin);
  if (looksCsv(t, ',')) return make('csv', t, 'table', src, opts.origin);
  if (looksCsv(t, '\t')) return make('tsv', t, 'table', src, opts.origin);
  if (looksMarkdown(t) && isLong(t)) return make('markdown', t, mdTitle(t), src, opts.origin);
  if (isLong(t)) return make('output', t, opts.command ? opts.command.slice(0, 30) : 'output', src, opts.origin);
  return null;
}

/** A file opened in an explorer (VFS or a real folder). Plain text/unknown types stay out. */
export function fromFile(path: string, content: string | null, opts: { url?: string; origin: 'sandbox' | 'real' }): Artifact | null {
  const k = kindOfPath(path);
  if (!k) return null;
  if (isMediaKind(k)) return opts.url ? { kind: k, title: baseName(path), source: `file: ${path}`, url: opts.url, origin: opts.origin } : null;
  if (content == null) return null;
  return make(k, content, baseName(path), `file: ${path}`, opts.origin, extOf(path));
}

/** A Milla reply. Ordinary chat stays in the chat; builds, code and structured answers open. */
export function fromMillaReply(text: string): Artifact | null {
  const t = String(text ?? '');
  const html = htmlFromReply(t);
  if (html) return make('html', html, titleOf(html), 'Milla', 'sandbox');
  const blocks = codeBlocks(t).filter((b) => b.code.split('\n').length >= 4);
  if (blocks.length) {
    const big = blocks.reduce((a, c) => (c.code.length > a.code.length ? c : a));
    if (big.lang === 'diff' || looksDiff(big.code)) return make('diff', big.code, 'diff', 'Milla', 'sandbox');
    if (big.lang === 'csv') return make('csv', big.code, 'table', 'Milla', 'sandbox');
    if (big.lang === 'json') return make('json', big.code, 'JSON', 'Milla', 'sandbox');
    if (big.lang === 'markdown' || big.lang === 'md') return make('markdown', big.code, mdTitle(big.code), 'Milla', 'sandbox');
    return make('code', big.code, big.lang || 'code', 'Milla', 'sandbox', big.lang);
  }
  if (looksMarkdown(t) && (isLong(t) || t.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= 3)) return make('markdown', t, mdTitle(t), 'Milla', 'sandbox');
  return null;
}

export function fromMedia(kind: 'image' | 'video' | 'audio', url: string, title: string, source: string, origin: 'sandbox' | 'real'): Artifact | null {
  return url ? { kind, title: title.slice(0, 40), source, url, origin } : null;
}

const mdTitle = (t: string) => (t.match(/^#{1,6}\s+(.+)$/m)?.[1] || 'notes').slice(0, 40);

function make(kind: ArtifactKind, raw: string, title: string, source: string, origin: 'sandbox' | 'real', lang?: string): Artifact {
  return { kind, raw, title: String(title || kind).slice(0, 40), source, origin, lang, html: renderArtifact(kind, raw, lang) };
}

// ---------- rendering (script-free pages) ----------

const PAGE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px 20px; background: ${P.bg}; color: ${P.text}; font: 14px/1.55 ui-sans-serif, system-ui, sans-serif; }
  pre, code { font: 12.5px/1.5 ui-monospace, "JetBrains Mono", monospace; }
  pre { background: ${P.panel}; border: 1px solid ${P.border}; border-radius: 6px; padding: 10px 12px; overflow: auto; white-space: pre; }
  code { background: ${P.panel}; border-radius: 4px; padding: 1px 4px; }
  pre code { background: none; padding: 0; }
  a { color: ${P.link}; }
  h1, h2, h3, h4 { color: ${P.heading}; margin: 1.1em 0 .45em; line-height: 1.25; }
  h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.12em; }
  blockquote { margin: .6em 0; padding: .2em 1em; border-left: 3px solid ${P.border}; color: ${P.muted}; }
  hr { border: 0; border-top: 1px solid ${P.border}; }
  table { border-collapse: collapse; margin: .6em 0; font-size: 13px; }
  th, td { border: 1px solid ${P.border}; padding: 5px 9px; text-align: left; vertical-align: top; }
  th { background: ${P.panel}; color: ${P.heading}; position: sticky; top: 0; }
  tr:nth-child(even) td { background: ${P.stripe}; }
  .meta { color: ${P.muted}; font-size: 12px; margin-bottom: 8px; }
  .add { color: ${P.add}; background: ${P.addBg}; display: block; }
  .del { color: ${P.del}; background: ${P.delBg}; display: block; }
  .hunk { color: ${P.link}; display: block; }
  .ln { color: ${P.muted}; user-select: none; display: inline-block; width: 3.2em; }
`;
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;

function inline(s: string): string {
  let o = esc(s);
  o = o.replace(/`([^`]+)`/g, '<code>$1</code>');
  o = o.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  o = o.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  // Links are shown, never followed (the iframe has no network and navigation is blocked anyway).
  o = o.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a title="$2">$1</a>');
  return o;
}

/** A small, safe markdown renderer: everything is escaped first, no raw HTML passes through. */
export function markdownToHtml(md: string): string {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```\s*([\w+#.-]*)/);
    if (fence) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*+])\s+/.test(l) || /^\s*\d+\.\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && (/^\s*([-*+])\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s|>\s?|\s*\|.*\|\s*$)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

function parseDelimited(t: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  const s = String(t ?? '').replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && !cell) q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function renderArtifact(kind: ArtifactKind, raw: string, lang?: string): string {
  const t = String(raw ?? '');
  switch (kind) {
    case 'html': return t;
    case 'markdown': return page(markdownToHtml(t));
    case 'csv': case 'tsv': {
      const rows = parseDelimited(t, kind === 'csv' ? ',' : '\t');
      const [head = [], ...body] = rows;
      const shown = body.slice(0, 2000);
      return page(`<div class="meta">${body.length} row${body.length === 1 ? '' : 's'} × ${head.length} column${head.length === 1 ? '' : 's'}${body.length > shown.length ? ` (first ${shown.length} shown)` : ''}</div>`
        + `<table><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${shown.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }
    case 'json': {
      let pretty = t;
      try { pretty = JSON.stringify(JSON.parse(t), null, 2); } catch {}
      return page(`<pre><code>${esc(pretty)}</code></pre>`);
    }
    case 'diff':
      return page(`<pre>${t.split('\n').map((l) => {
        const cls = /^\+(?!\+\+ )/.test(l) ? 'add' : /^-(?!-- )/.test(l) ? 'del' : /^@@/.test(l) ? 'hunk' : '';
        return cls ? `<span class="${cls}">${esc(l) || ' '}</span>` : `${esc(l)}\n`;
      }).join('')}</pre>`);
    case 'code':
      return page(`${lang ? `<div class="meta">${esc(lang)}</div>` : ''}<pre><code>${t.split('\n').map((l, n) => `<span class="ln">${n + 1}</span>${esc(l)}`).join('\n')}</code></pre>`);
    case 'output':
      return page(`<pre>${esc(t)}</pre>`);
    default:
      return page('');
  }
}

/** `canvas <file>`: an explicit request, so it always opens (plain text shows as output). */
export function explicitFile(path: string, content: string, origin: 'sandbox' | 'real', source: string): Artifact {
  const a = fromFile(path, content, { origin });
  if (a) return { ...a, source };
  return make('output', content, baseName(path), source, origin);
}
