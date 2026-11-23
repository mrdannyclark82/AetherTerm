// Canvas helpers, ported from candy/local-chat-shell-v2 packages/shell-next/src/canvas-util.mjs
// (MIT, Copyright (c) 2026 Danny Clark). Typed for AetherTerm; the preview CSP is stricter
// in network mode (https: only, so the app's own http://127.0.0.1 server stays unreachable).

const FENCE = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g;

export function codeBlocks(text: string): { lang: string; code: string }[] {
  const out: { lang: string; code: string }[] = [];
  for (const m of String(text || '').matchAll(FENCE)) out.push({ lang: (m[1] || '').toLowerCase(), code: m[2].replace(/\n$/, '') });
  return out;
}

/** The largest HTML-looking block in a reply, or null. */
export function htmlFromReply(text: string): string | null {
  const blocks = codeBlocks(text).filter((b) => ['html', 'htm', 'xhtml', 'svg'].includes(b.lang) || (!b.lang && /^\s*<(!doctype|html|body|div|svg)/i.test(b.code)));
  if (blocks.length) return blocks.reduce((a, c) => (c.code.length > a.code.length ? c : a)).code;
  const raw = String(text || '').trim();
  return /^<!doctype html|^<html/i.test(raw) ? raw : null;
}

export function titleOf(html: string, fallback = 'App'): string {
  const t = html.match(/<title>([^<]*)<\/title>/i)?.[1] || html.match(/<h1[^>]*>([^<]*)<\/h1>/i)?.[1];
  return (t || fallback).trim().slice(0, 40) || fallback;
}

export function previewCsp(allowNetwork = false): string {
  return allowNetwork
    ? "default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src https:; form-action 'none'; base-uri 'none'"
    : "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";
}

export function previewDoc(html: string, allowNetwork = false): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${previewCsp(allowNetwork)}">`;
  const src = String(html || '');
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (h) => h + meta);
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (h) => h + '<head>' + meta + '</head>');
  return `<!doctype html><html><head>${meta}</head><body>${src}</body></html>`;
}

export function diffLines(a: string, b: string): { op: ' ' | '-' | '+'; line: string }[] {
  const A = String(a ?? '').split('\n');
  const B = String(b ?? '').split('\n');
  if (A.length * B.length > 4e6) return [...A.map((line) => ({ op: '-' as const, line })), ...B.map((line) => ({ op: '+' as const, line }))];
  const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0; let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push({ op: ' ', line: A[i++] }); j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', line: A[i++] });
    else out.push({ op: '+', line: B[j++] });
  }
  while (i < A.length) out.push({ op: '-', line: A[i++] });
  while (j < B.length) out.push({ op: '+', line: B[j++] });
  return out;
}
