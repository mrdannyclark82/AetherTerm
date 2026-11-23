# Theming AetherTerm

All UI colours live in two files. Components only use named tokens, never hex values or
Tailwind's built-in palette (`bg-red-500`, `text-gray-400`, ...).

| File | What it holds |
|---|---|
| `src/theme.css` | Every UI colour as a CSS variable inside Tailwind 4's `@theme` block, plus the two CSS-only effects (boot scanlines, ASCII banner glow). |
| `src/theme.ts` | The colours JavaScript has to pass on directly: the xterm.js terminal palette (Real mode bash) and the canvas preview pages (markdown, tables, code, diffs), which render in a sandboxed iframe that can't read CSS variables. |

`src/index.css` just imports Tailwind and `theme.css`.

Justified exception: `desktop/main.mjs` keeps two constants, `WINDOW_BG` and `WINDOW_TEXT`, for the
window background and the "starting" splash shown before the web UI loads. Electron's main process
can't read the renderer's CSS, so they mirror `--color-surface-0` and `--color-glow-300` by hand.

## How the tokens work

Each `--color-<name>` in `@theme` becomes a set of Tailwind utilities: `bg-<name>`, `text-<name>`,
`border-<name>`, `ring-<name>` and so on, including opacity modifiers like `bg-real-900/50`.
`--color-*: initial;` at the top switches Tailwind's default palette off, so a stray palette
class renders nothing instead of a surprise colour.

| Token family | Used for | Default |
|---|---|---|
| `surface-0..3`, `void`, `bright` | backgrounds from darkest to lightest; deepest black; text on filled buttons | near-black greys |
| `ink-100..900` | neutral text, borders, dividers | cool grey |
| `glow-*` | the app accent: titles, focus rings, links, the virtual shell prompt | soft cyan |
| `brand-*` | AetherTerm / Milla Workspace, the canvas, your chat bubbles | soft lavender |
| `milla-*` | Milla's chat bubbles | dusty rose |
| `sandbox-*` | the Sandbox badge and banner | warm amber |
| `real-*` | the Real files + shell badge, banner, unlock button and the real bash header | calm slate-blue |
| `danger-*` | errors, delete, kill, diff removals | muted clay |
| `ok-*` | success, running, diff additions | sage green |
| `info-*` | the code editor and neutral notices | soft blue |
| `folder-*` | folder icons | muted gold |

Real mode used to be red. It's now slate-blue, which is easy on the eyes and still clearly
different from the Sandbox's amber. Errors use a muted clay instead of alarm red.

## Changing a colour

1. Edit the value in `src/theme.css`, for example make Real mode teal:
   ```css
   --color-real-500: #4f9e98;
   ```
   Change the neighbouring shades (`-200` to `-950`) the same way so hovers and tints match.
2. If the token also appears in `src/theme.ts` (the comments there name the CSS token each
   value mirrors), change it there too. That covers the terminal and canvas previews.
3. Rebuild (`npm run build`, or `cd packaging/arch && makepkg -f` for the package).

## Adding a colour

Add a new `--color-<name>-<shade>` to `@theme` and use it as `bg-<name>-<shade>`. Don't add
hex values or palette classes to components; `packaging/check-theme.sh` fails the check if you do.

## Checking

```bash
packaging/check-theme.sh
```
It greps every file under `src/` except the two theme files for hex/rgb/hsl/oklch values and
Tailwind palette classes. Known false positive it skips: the `back-to-sandbox` test id.
