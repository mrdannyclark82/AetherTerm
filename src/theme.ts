// AetherTerm theme, JavaScript side. See THEMING.md.
// Most colours are CSS tokens in src/theme.css. These are the few that JavaScript has
// to hand over directly: the xterm.js terminal and the canvas preview pages (which
// render inside a sandboxed iframe that can't see the app's CSS variables).
// Values mirror the tokens named in the comments; change both together.

/** xterm.js colours for the real bash terminal (Real mode). */
export const terminal = {
  background: '#0a0b0d',          // --color-surface-0
  foreground: '#d3d8de',          // --color-ink-200
  cursor: '#a9bbe6',              // --color-real-300
  cursorAccent: '#0a0b0d',
  selectionBackground: '#3a4b7799', // --color-real-800 at 60%
  black: '#1c2026', brightBlack: '#58616e',
  red: '#c98c83', brightRed: '#ddaaa2',          // muted clay, not alarm red (--color-danger-400/300)
  green: '#93c19a', brightGreen: '#b3d6b8',      // --color-ok-400/300
  yellow: '#e6c47f', brightYellow: '#f1dcae',    // --color-sandbox-300/200
  blue: '#8aa2d9', brightBlue: '#a9bbe6',        // --color-real-400/300
  magenta: '#a690d6', brightMagenta: '#bfaee4',  // --color-brand-400/300
  cyan: '#78bfcc', brightCyan: '#9dd3dd',        // --color-glow-400/300
  white: '#d3d8de', brightWhite: '#f5f7fa',
};

/** Colours inside canvas previews of markdown, tables, code, diffs and command output. */
export const preview = {
  bg: '#0a0b0d',      // --color-surface-0
  panel: '#161a20',   // --color-surface-2
  border: '#2e343c',  // --color-ink-800
  stripe: '#111317',  // --color-surface-1
  text: '#d3d8de',    // --color-ink-200
  muted: '#929ba8',   // --color-ink-400
  heading: '#e7eaee', // --color-ink-100
  link: '#78bfcc',    // --color-glow-400
  add: '#b3d6b8', addBg: '#172219', // --color-ok-300 / ok-950
  del: '#ddaaa2', delBg: '#2a1b19', // --color-danger-300 / danger-950
};
