# Plan: Milla Workspace as a live canvas (v0.3)

## Goal
When Milla builds something (Generate App, a chat reply with an HTML block, an HTML file from the VFS editor, `generate-app` in the terminal), show it as a live preview beside the chat. You can flip between versions, re-run it, edit the source, ask Milla to revise it, and compare two versions.

## Reuse from candy/local-chat-shell-v2 (branch v2, MIT, Danny's own)
- **Ported:** `packages/shell-next/src/canvas-util.mjs` becomes `src/desktop/canvas-util.ts`, covering `codeBlocks`, the preview CSP and `previewDoc`, and `diffLines`. Same logic, typed, with the attribution kept.
- **Not reused:** `Canvas.jsx`. It's built around candy's project database, NDJSON streaming, its Markdown component and its CSS. AetherTerm talks over Socket.IO and uses Tailwind, so a small new React component (`src/desktop/canvas.tsx`) is less work than adapting it. The UX follows candy: preview, source, compare, versions, re-run, revise.

## Design
- **Where versions come from:**
  - Generate App replies (`gemini_generate_code_response`);
  - chat replies that contain a fenced ```html block ("Open in canvas" button);
  - the VFS editor's live preview;
  - the terminal's "Open Sandbox" entries.
- **What a version holds:** `{ id, n, title, html, source, at }`. Versions are kept in the renderer and in localStorage (last 20), so they survive a restart.
- **Tabs:**
  - **Preview:** a sandboxed iframe.
  - **Source:** an editable textarea. "Save as new version" adds a version; editing never overwrites one.
  - **Compare:** two versions side by side (A and B pickers), each in its own sandboxed iframe, plus a line diff.
- **Actions:**
  - **Re-run:** remounts the iframe with fresh state.
  - **Copy.**
  - **Revise:** asks Milla to change the page. The new `canvas_revise` socket event runs the same local-first generator as Generate App, and the result becomes a new version.
  - **Network toggle:** off by default.
- **The Milla Workspace panel:** it gets wider (about 55%) and splits into the canvas on top and the chat below. With no versions it's the chat alone, as before.

## Security (generated code stays sandboxed)
- The iframe is `sandbox="allow-scripts"` only: no `allow-same-origin`, so it gets an opaque origin. It can't read the app's DOM, storage or cookies, can't navigate the top window, and can't open popups or submit forms.
- The token cookie is HttpOnly and SameSite=Strict, so it's never sent from the opaque-origin frame. The server also requires the token plus Host/Origin checks on every route and socket. A fetch to `/api/local/*` or `/pty` from a preview gets refused (tested).
- **Preview CSP** (a meta tag injected into the document):
  - Default: no network at all (`default-src 'none'`); only inline script and style, plus data: and blob: media.
  - With "Allow network" on: https: only (for CDN scripts, fonts and images). Plain http:, including the app's own 127.0.0.1 server, stays blocked, and `form-action 'none'` stays on.
- **Navigation:** Electron main's `will-frame-navigate` cancels any subframe navigation that isn't about:, data: or blob:. A preview can't load an outside page or the app's own server inside the frame. Popups are already denied by the sandbox flags and by `setWindowOpenHandler`.

## Out of scope (later)
- Multi-file projects.
- Running non-HTML code. The old "Run" button has no server handler; it's a separate task.
- Saving canvases into the VFS as files. Generate App already writes `/home/Milla-Rayne/sandbox/app-*.html`.

## Estimate
About 2–3 hours, including tests. Built in this branch.
