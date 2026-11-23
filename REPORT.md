# AetherTerm as a Linux app: report (Nov 22, 2026)

## What the source is
- `/home/milla/AetherTerm` is a clone of `github.com/mrdannyclark82/Aetherboot.git` (the folder name doesn't match the repo name).
  It has 4 commits (2f2530c → 27ad217, May 24 to Jun 30, 2026). GitHub `main` (47b67d1) is 2 commits ahead, and GitHub also has 18 `cursor/*` security branches.
- It is not the 108-commit Python AetherTerm, which is a different project that happens to share the name.
- Stack: React 19 + Vite 6 + Tailwind 4 front end (`src/App.tsx`). The back end is Express + Socket.IO (`server.ts`, port 3333 by default) plus `diskSync.ts`.
  The back end handles Ollama chat (127.0.0.1:11434), optional Gemini/OpenAI/Anthropic, a virtual file system with two-way disk sync, and Firestore history.
- Before this work there was no launcher. You ran it with `npm run dev` (tsx) or `vite preview` (front end only, which is what Danny has running on [::1]:4173).
- Danny's uncommitted work (8 modified, 14 untracked files):
  - It rebrands the app to "Milla Rayne OS" and replaces the old AI Studio `.env.example` with a list of variable names.
  - It rewrites `server.ts` (about 2,600 lines changed). Ollama becomes the main model, Milla joins as a chat participant, it adds `generate-app`, image and Veo video jobs, uploads over the socket (25 MB), and the `diskSync.ts` two-way sync to `/home/milla/aetherterm-files`. Host shell execution is gone: `exec` is imported but never called.
  - It expands `App.tsx` with settings, a provider picker, a workspace chat and a boot video.
  - It adds the `googleapis` and `@google-cloud/local-auth` deps (imported but not used), plus notes (GEMINI.md, SARII.md, StateOfProject.md, DISK_SYNC.md), `public/` media, and `.bak` copies.
  - **`firebase-blueprint.json` was replaced with a Firebase Admin service-account key** (it holds private_key and client_email; values not read). This change was NOT brought into the copy.
- Builds and runs: `vite build` works, `tsc --noEmit` is clean, and the server starts. Firestore returns NOT_FOUND (the database doesn't exist), so cloud history doesn't work. Local mode works.

## What was built
- Copy: `~/projects/aetherterm-app`, branch `app/linux-desktop`. The live tree was not touched (same HEAD, same 22 dirty files, diff sha256 unchanged).
  - `a12de63`: Danny's WIP, except the service-account key. The original patch is kept in `.wip-archive/`, which is untracked.
  - `24463c0`: Electron shell (`desktop/main.mjs`) and the server changes for packaging. All server changes are env-gated, so `npm run dev` behaves as before.
  - `1180afc`, `dc80e89`: GitHub main's two fixes, cherry-picked: an opaque-origin sandbox iframe, and Firestore data scoped per user.
  - `eee5d75`, `f1b3114`: a Socket.IO Origin+Host guard, the PKGBUILD, and the install/uninstall scripts.
- Why a PKGBUILD rather than an AppImage: this is a Node/Electron app, and Garuda already has `electron39` from the repos.
  - The package carries only the app (38 MB .pkg.tar.zst, 269 MB unpacked) and uses the distro's Electron, which gets security updates through pacman.
  - pacman tracks every file, so uninstalling is clean.
  - An AppImage would bundle its own unpatched Electron (about 100 MB more) and needs FUSE.
  - The same package also installs per user with no root (`install-user.sh`).
- How it runs: Electron spawns the bundled server (`server/server.mjs`, built with esbuild) as a child process with `ELECTRON_RUN_AS_NODE`.
  - The server binds to 127.0.0.1:47333 only. If that port is busy it tries the next one, and you can set it with `AETHERTERM_PORT`. It never uses 3333 or 4173.
  - The server is killed when the app quits. There is a single-instance lock.
  - Window, app_id and the .desktop file all use the name `aetherterm`.
- XDG state:
  - `~/.config/aetherterm/`: `aetherterm.env` (0600, a template with names only), `window-state.json`, and the browser profile (localStorage).
  - `~/.local/share/aetherterm/files` (synced file tree) and `~/.local/share/aetherterm/vfs` (generated media).
  - `~/.local/state/aetherterm/server.log`.
- Credentials are read at run time:
  - `AETHERTERM_SERVICE_ACCOUNT` (default `~/.config/aetherterm/firebase-service-account.json`). If it's missing, the app runs and everyone joins as a guest.
  - API keys come from `aetherterm.env`.
  - The build refuses to run if a `.env` is present, because `vite.config.ts` would bake GEMINI_API_KEY into the JS. I checked the package: it contains no blueprint, .env or key file.

## Files
- Package: `~/projects/aetherterm-app/packaging/arch/aetherterm-0.1.0.r10.gf1b3114-1-x86_64.pkg.tar.zst`. The older r9 build sits beside it.
- `packaging/aetherterm.desktop`, `packaging/icons/aetherterm.svg` (+ PNGs from 16 to 512; it's a new neutral icon because the repo had none), `packaging/aetherterm.sh`, `packaging/build-app.sh`, `packaging/install-user.sh`, `packaging/uninstall-user.sh`.
- Installed (user level):
  - `~/.local/lib/aetherterm/`
  - `~/.local/bin/aetherterm`
  - `~/.local/share/applications/aetherterm.desktop`
  - `~/.local/share/icons/hicolor/*/apps/aetherterm.*`
  - The first-install files were backed up as `*.bak-20261122-160246` when I reinstalled r10.

## Commands
```bash
# build (no install)
cd ~/projects/aetherterm-app/packaging/arch && makepkg -f
# user install (no root)
~/projects/aetherterm-app/packaging/install-user.sh ~/projects/aetherterm-app/packaging/arch/aetherterm-0.1.0.r10.gf1b3114-1-x86_64.pkg.tar.zst
# user uninstall (moves files to ~/archive/aetherterm-uninstall-<ts>; keeps settings/data unless --archive-data)
~/projects/aetherterm-app/packaging/uninstall-user.sh
# system install, only with Danny's yes:   sudo pacman -U <pkg>     system uninstall:  sudo pacman -R aetherterm
```

## Tests (in a headless labwc compositor on its own wayland-1 socket; Danny's Cinnamon session was not touched)
- `desktop-file-validate` passes. GIO resolves `aetherterm.desktop` (Exec, Icon, shown), and **the Cinnamon menu tree lists it under Programming**.
- Launched with `gtk-launch aetherterm`. The window shows the icon in the title bar, and the boot screen, welcome dialog and main terminal all render. `ollama list` returned the local models through the app.
- Restart: I wrote a file through the app, quit (SIGTERM, which is a clean quit: server child exited and the port was freed), and relaunched with gtk-launch. The file was still in the VFS.
  I relaunched again: localStorage (`aetherterm_setup_complete`, plus a probe key) survived, the welcome dialog did not reappear, and `ls /persist-check` listed `note.txt`. Window size is saved.
- Security: a foreign Origin is rejected with 403, a rebinding Host header gets 403, and same-origin gets 200. The server is not reachable from the LAN or Tailscale.
- Uninstall was tested in a throwaway HOME: everything was archived and settings were kept.

## GitHub security branches (reviewed, read-only)
- Applied: main's #14 (sandbox iframe can no longer read the app's localStorage, which can hold API keys) and #9 (per-user Firestore paths plus rules).
- Not applied, because they target the old server.ts that Danny already rewrote, and they don't cherry-pick:
  - remove-host-command-execution and sandbox-bubblewrap-isolation / sandbox-kill-session-pids: Danny's server no longer runs host commands.
  - fix-vfs-host-write: Danny's diskSync has a `safeResolve` containment check instead.
  - gemini-socket-auth-budget, bound-socket-session-state, persist-only-own-room-events: these matter when other people can connect. The desktop build binds to localhost with an origin guard, so they become optional hardening.
  - The other `*-tests` branches only add failing tests for those issues.

## Open risks
- A Firebase Admin private key sits in plain text in `/home/milla/AetherTerm/firebase-blueprint.json`, a tracked file. It must never be committed or pushed. It's worth rotating, and moving to `~/.config/aetherterm/firebase-service-account.json` (0600) if sign-in is wanted.
- Danny's own `dist/` was built from the same front end, so the same Firebase web config is baked in, which is normal for a web key. Any future build in the live tree with a `.env` present would bake in GEMINI_API_KEY.
- I only tested headless, on labwc/wlroots. I have not seen it on Danny's real Cinnamon-Wayland display (title bar, GPU, IME, file dialogs). The app_id/StartupWMClass grouping in the Cinnamon panel is unverified.
- The installed app expects `electron39` from the repos. If pacman removes or upgrades it, the launcher breaks; override with `AETHERTERM_ELECTRON=electron42`.
- Firestore returns NOT_FOUND, so cloud history and the collaborator features don't work until the Firebase project or database exists. The sidebar file tree in Local Mode doesn't show server-side VFS files (the terminal `ls` does).
- The app still runs an Express server on a local port. Any local process can reach it; browsers are blocked by the origin guard.
- API keys typed into the in-app Settings are kept in localStorage under `~/.config/aetherterm`, in plain text, with mode 0700.
- `makepkg` needs network for `npm ci`. That's fine locally, but not a clean-chroot build.
- The license is unknown (there's no LICENSE file); the PKGBUILD says `LicenseRef-AetherTerm`.
- A system install (`sudo pacman -U`) also needs the user-level copy uninstalled first, or there will be two menu entries.

---

# v0.2: local files, real shell, no Firebase, Milla as the AI (Nov 22, 2026)

Branch `app/v0.2-local-files-shell` (off `app/linux-desktop`), in the copy `~/projects/aetherterm-app`. Nothing pushed. The live `/home/milla/AetherTerm` was not touched (still 22 dirty files, same diff hash), and neither was vite preview PID 2149425 or Ollama.

Package: `packaging/arch/aetherterm-0.2.0.r15.g0d8b1b0-1-x86_64.pkg.tar.zst`, installed in `~/.local` with backups `~/.local/{lib/aetherterm,bin/aetherterm,share/applications/aetherterm.desktop}.bak-<timestamp>`.

## What's new

- **Local folders.** The "LOCAL FOLDERS" sidebar maps real folders (`/home/milla` by default; the folder button adds more). You can open, edit and save, create files and folders, and rename. Delete asks "Move to Trash?" first and then moves the item to the XDG Trash (`gio trash`, with Electron's trashItem as fallback). It never hard-deletes. Mapped folders are saved in `~/.config/aetherterm/folders.json`. Dotfiles are hidden by default, with a toggle.
- **Path safety.** Every path is resolved against the real path of a mapped folder and checked before and after following symlinks. `../` escapes, absolute paths, unmapped roots and symlinks that point outside are refused (403). Links that stay inside, like `link-inside → sub`, work. Reads are capped at 5 MB, binary files aren't opened, and create/rename never overwrite.
- **Real shell.** The "Local Shell" view runs your login shell (`/bin/bash -l`, with your starship prompt and .bashrc) in a real PTY (node-pty built for electron39). It starts in the folder selected in the explorer. **Shell ON/OFF** toggle, ON at launch: turning it OFF kills open shells, and the server then refuses new ones. The shell environment is stripped of AETHERTERM_* and the app's *_API_KEY/_TOKEN/_SECRET values (your own .bashrc exports still apply, as in any terminal).
- **Lockdown.** The server listens on 127.0.0.1 only. Each launch, Electron main makes a random 256-bit token and passes it to the server through the environment (removed from the server's env after it is read). The renderer gets it as an HttpOnly, SameSite=Strict cookie, so page JS can't read it. It never appears in the URL or logs. Every HTTP route, the Socket.IO handshake (polling and websocket) and both namespaces require it. The Origin and Host checks from v0.1 are still there.
- **Firebase removed.** No Firestore, client or Admin SDK, Google sign-in, blueprint loading or `AETHERTERM_SERVICE_ACCOUNT`. `firebase`, `firebase-admin`, `googleapis` and `@google-cloud/local-auth` are gone from package.json and the lock. History is saved to `~/.local/share/aetherterm/history.json` (0600, last 500 entries, autosaved and saved on exit). There's no login: one local user, Danny ("Danny · local" in the sidebar).
- **Milla is the AI.** Every model path (local Ollama, Gemini if a key is set) uses one system prompt: answer as Milla, Danny's partner, warm and direct, running locally, and never name the underlying model or company. "Milla's thinking" and "Milla is processing thoughts..." are replaced by three animated dots, and the model name is gone from the workspace header. The model picker stays in Settings (default `devmilla:latest`).

## Firebase, briefly

It came from the AI Studio template. The browser used Firebase Auth (Google sign-in, "Cloud Sync") and Firestore to keep your files and history in Google's cloud. The server used Firestore to load and save history, and the Admin SDK (with the service-account key in `firebase-blueprint.json`) only to check sign-in tokens. The database returned NOT_FOUND, so in practice it never worked. All of it is now removed from the copy, and nothing leaves the machine except calls to a cloud model if you pick one. The admin key isn't needed any more. It is still sitting in the live tree's `firebase-blueprint.json` (untouched, never read), so it's worth revoking it in the Google Cloud console (IAM → Service accounts → Keys).

Remaining references, by file name only:
- **Copy:** comments in server.ts and localStore.ts, a `.gitignore` pattern, and docs (GEMINI.md, StateOfProject.md, this report). None in the installed app or node_modules.
- **Live tree (read-only):** firebase-blueprint.json, firebase-applet-config.json, firestore.rules, src/firebase.ts, src/App.tsx, server.ts, server.ts.bak-*, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, GEMINI.md, StateOfProject.md, server-restart.log, sarii/research-cycle*.{md,json}, sarii/index.json.

## Commands

```
cd ~/projects/aetherterm-app/packaging/arch && makepkg -f                                     # build
~/projects/aetherterm-app/packaging/install-user.sh packaging/arch/aetherterm-0.2.0.r15.g0d8b1b0-1-x86_64.pkg.tar.zst   # install (backs up)
~/projects/aetherterm-app/packaging/uninstall-user.sh [--archive-data]                         # uninstall (archives, never deletes)
```

## Tests (headless labwc on wayland-1, isolated XDG dirs, no D-Bus session)

- Opened a folder: it was added to folders.json and survived two relaunches.
- Created `notes-from-aetherterm.txt` in the app, typed into it and saved; the text was correct on disk. Renaming it to `renamed-notes.txt` showed on disk.
- Delete showed the "Move to Trash?" prompt, and the file stayed on disk while the prompt was open. After confirming, it was in Trash with a valid .trashinfo.
- Traversal and symlinks, all refused with 403: `../../../etc/passwd`, write or list through `link-to-etc`, rename to `../escaped.txt`, mkdir `sub/../../x`, and an unmapped root `/etc`. `link-inside` lists fine.
- Shell ran `pwd`, `ls -la ..`, `uname -a`, `tty` (/dev/pts) and `htop` (quit with q).
- Shell OFF killed the running PTY. A start request sent straight to the socket got "Shell is turned off.", and its command never ran. Turning it back ON works.
- Token, with no token, a wrong header or a wrong cookie:
  - all `/api/local/*` routes (read, list, write, shell, shell enable) and `/` return 401;
  - the Engine.IO handshake returns 403, and the websocket upgrade 400;
  - socket.io-client on `/pty` and `/`, over polling and websocket, with no token or a wrong one, is refused;
  - a bad Host header returns 403;
  - no file was written.
- Milla on local `llama3.2:latest`:
  - "who are you?" → "I'm Milla, Danny's partner…";
  - "what model are you? Which company made you?" → "I'm Milla, running locally on Danny's machine. I don't really know what model I am… it's about us";
  - the typing dots show and no model name appears.
- History survived a relaunch.
- Quitting with a shell open left no processes behind (main, server, bash) and no port listening.

## Open risks

- **Blast radius.** A real shell plus your whole home folder means anything in the app that's tricked into running something can do whatever you can: delete files, read keys, push code. The token keeps *other* things out, but it can't stop a compromised renderer. Examples are a malicious generated app, a hostile web page shown in the app, or an XSS in chat markdown. Keep the shell OFF when you don't need it, and only map the folders you need.
- **What the token covers.** It blocks other websites in your browser (no token, and Origin/Host checks), other users, and other machines (127.0.0.1 only). It does **not** protect against code already running as `milla`, which can read the server's `/proc/<pid>/environ` or the cookie store in `~/.config/aetherterm`. A shell is also only as safe as the account.
- **Delete confirmation lives in the app UI.** The server itself doesn't ask. Trash is recoverable; overwriting a file you saved is not (no undo).
- **Test hooks.** `AETHERTERM_TEST_PICK_FOLDER` (it skips the folder dialog) and `window.__aetherShell` exist for testing. The env hook only matters if something can already set your env.
- **The real folder dialog was only exercised through that hook**, because headless runs have no portal. Try the folder button once on your desktop.
- **node-pty is built for electron39's ABI.** If Arch updates electron39 to a new major, rebuild with `makepkg -f`.
- **Trash across filesystems.** Deleting from a folder on another drive needs a `.Trash-1000` folder on that drive, or it fails with an error and nothing is deleted.

---

# v0.3: Sandbox vs Real mode, media fix, Milla Workspace canvas (Nov 22, 2026)

Branch `app/v0.3-media-canvas` (off `app/v0.2-local-files-shell`), in the copy only. Nothing pushed, nothing installed over `~/.local`. Danny's AetherTerm v0.2 was running (PID 2250624, server 2251141, started 16:45 CST), so v0.3 was built and tested from a separate test prefix, `~/.cache/aeth-test-prefix`, with separate config folders. The live `/home/milla/AetherTerm`, his vite preview and Ollama were not touched.

## 1. What the old VFS and SANDBOX toggle actually did (read from the code)

- **The SANDBOX ON/OFF button gated nothing.** `sandboxEnabled` in App.tsx was only read to colour the button. No server code, iframe or shell looked at it.
- **The VFS** (`/`, `bin`, `home` in the top sidebar) is a virtual file tree kept by the server. It's mirrored two-way to one real folder, `~/.local/share/aetherterm/files` (diskSync.ts, path-confined). Milla's generated apps and images are written to `~/.local/share/aetherterm/vfs` and served at `/vfs`. The `nexus@rayne` command line (`ls`, `cat`, `mkdir`, `touch`, `edit`, …) only ever touches the VFS.
- **Generated-app iframes** were always `sandbox="allow-scripts"`, whatever the toggle said. There's no bubblewrap or container anywhere.
- **Dead code:** the editor's "Run" button for .js/.py/.sh sends a `sandbox run` command that has no server handler. The "Sandbox Integrity Auditor" panel waits for metrics nobody sends and shows a hard-coded 12.4% CPU.
- **Milla's file actions** only write into the VFS: generate-app, generate-image and github clone/sync. Milla never touches real files or the real shell, in either mode.

## 2. What SANDBOX means now (Danny's call, built and enforced server-side)

- **SANDBOX (default for a fresh install):**
  - the sidebar shows only "SANDBOX FILES" (the VFS);
  - the shell is the virtual `nexus@rayne` command line;
  - Milla and generated apps stay in the VFS;
  - an amber banner says so.
- **REAL FILES + SHELL:**
  - the sidebar shows only "LOCAL FOLDERS";
  - the Local Shell button (real bash in a PTY) appears;
  - the banner is red with a "Back to Sandbox" button. The banner also shows on the Local Shell view.
- **Switching:**
  - Leaving the Sandbox needs a deliberate click on a "Leave the Sandbox?" dialog that lists what it unlocks. The server also requires an unlock phrase, so a stray API call can't flip it.
  - Going back to Sandbox is one click. It kills any real shell straight away.
- **Remembered** in `~/.config/aetherterm/mode.json` (0600). Missing or broken means Sandbox.
- **Enforcement while in Sandbox:**
  - every real-file route returns 403 *even with a valid token*: `/api/local/{roots,list,read,write,mkdir,rename,raw,shell}`;
  - `/pty` refuses to start a shell;
  - Electron main refuses `pick-folder`, `remove-folder` and `trash`.
- **The v0.2 "Shell ON/OFF" toggle is folded in and removed.** Real mode means files *and* shell together, which is simpler than a second switch.
- **"Import folder" button:** the VFS header's button now says what it does, "Import a copy of a folder into the sandbox VFS". It copies text files on an explicit pick and is not live access.

## 3. Media playback bug

- **Root cause:** the data shape didn't match. Danny's uncommitted WIP changed the server's `play`/`view`/`pip` output from `{type:'video'|'image', url}` to `{type:'output', text:'Loading video...', mediaUrl, mediaType}`, but the terminal renderer only draws media for `type:'video'|'image'`. So every play/view just printed "Loading video…". It is not CSP, the token, Electron webSecurity, Firebase or codecs; electron39 plays H.264/AAC and VP9/Opus fine. The live tree has the same bug.
- **Fix:**
  - the server emits the renderer's shape again;
  - the renderer also draws `output` entries that carry `mediaUrl` (generated images);
  - aliases `video`, `image` and `listen` were added;
  - a clear message appears if a video can't play.
- **Local files:** `play ~/…` / `view ~/…` in Real mode go through a new `/api/local/raw` route:
  - it uses the same token cookie (media tags send it on same-origin requests) and the same path and symlink checks;
  - it only serves image, audio and video types, and returns 415 for anything else;
  - it supports Range requests;
  - responses carry `CSP: default-src 'none'; sandbox` and nosniff, so a file can never run as a page in the app's origin;
  - it is 401 without the token and 403 in Sandbox.
- **Explorer:** clicking a media file in Local Folders opens a viewer.
- **In Sandbox:** `play ~/…` explains that real files are locked; web URLs and VFS files still play.

## 4. Canvas (Milla Workspace)

- **Plan:** PLAN-canvas.md.
- **Reused** `canvas-util.mjs` from candy/local-chat-shell-v2 (MIT, Danny's), ported to TS. `Canvas.jsx` was too tied to candy's database, streaming and CSS, so the panel is new and follows candy's UX.
- **Features:**
  - every Generate App result, chat reply with an HTML block ("Open in canvas"), VFS editor preview and terminal "Open Sandbox" becomes a version;
  - version tabs, last 20 kept across restarts;
  - Preview, Re-run (fresh state), Source edit → "Save as new version", Compare (two versions side by side plus a line diff);
  - "Ask Milla to change vN" → a new version;
  - a network toggle (offline by default; https: only when on).
- **Sandboxing:**
  - the iframe is `sandbox="allow-scripts"` only: opaque origin, no same-origin with the app, no popups, no forms, no top navigation;
  - a CSP is injected: no network by default, and https: only when the toggle is on, so the app's http://127.0.0.1 server is never reachable;
  - Electron main cancels any subframe navigation that isn't about:/data:/blob:.

## Commands

```
cd ~/projects/aetherterm-app/packaging/arch && makepkg -f
# install for real (when AetherTerm is closed; backs up the v0.2 install first):
~/projects/aetherterm-app/packaging/install-user.sh ~/projects/aetherterm-app/packaging/arch/aetherterm-0.3.0.r22.g7b85685-1-x86_64.pkg.tar.zst
# uninstall: ~/projects/aetherterm-app/packaging/uninstall-user.sh [--archive-data]
```

Package: `packaging/arch/aetherterm-0.3.0.r22.g7b85685-1-x86_64.pkg.tar.zst`. **Not installed into ~/.local**, because AetherTerm v0.2 was open. Close AetherTerm first, then run the install line above. It backs up the v0.2 files as `*.bak-<timestamp>`, and the first launch will be in Sandbox (no mode.json yet).

## Tests (headless labwc, separate config folders, test install in ~/.cache/aeth-test-prefix)

- **Fresh start:** mode is Sandbox. The amber banner shows, only the VFS tree is listed, and there's no Local Folders and no Local Shell button.
- **Sandbox with a valid token:**
  - `roots`, `list`, `read`, `write`, `mkdir`, `rename`, `raw` and `shell` all return 403;
  - the old `POST /shell enable` returns 403;
  - `/pty` connects but refuses to start ("Sandbox is on…"), and its typed command never ran;
  - IPC `trash` and `pick-folder` are refused;
  - unlocking without the phrase, or with a wrong one, returns 400;
  - no file was created.
- **Leaving the Sandbox:**
  - the "Leave the Sandbox?" dialog appears; Cancel keeps Sandbox, client and server;
  - Confirm switches to Real: the red banner shows, only Local Folders is listed, and the Local Shell button appears;
  - mode.json is 0600.
- **Real mode:** bash ran in the test folder (`pwd`, `ls`, `whoami`).
- **Back to Sandbox:** one click killed the PTY at once, and real routes went back to 403.
- **Restart:** Real was remembered across a quit, rebuild and relaunch, and so was Sandbox.
- **Media:**
  - In Sandbox, the MDN `flower.mp4` played (readyState 4, 960 px wide) and the MDN grapefruit JPEG loaded. `play ~/…` gave the "real files are locked" message.
  - In Real mode, `play ~/aetherterm-v02-test/local-test-clip.mp4` (H.264/AAC, made with ffmpeg) played, `view …/local-test-image.png` loaded, and the explorer viewer played `local-test-clip.webm` (VP9/Opus).
  - `raw` refused `/etc/passwd` (403, not mapped), `readme.txt` (415), and `link-to-etc/hostname` (403). Range requests return 206 with Content-Range and CSP sandbox. With no token it returns 401.
- **Canvas:**
  - Generate App on local `qwen2.5-coder:7b` produced v1 in the canvas.
  - A source edit was saved as v3, and Compare showed v1 and v3 side by side with a diff.
  - "Ask Milla to change v3: hot pink digits + Lap button" produced v4. Re-run worked.
  - A security probe page in the canvas ran with origin `null`. These were all blocked:
    - cookie, parent DOM, localStorage and the desktop bridge;
    - fetch to `/api/local/mode`, `127.0.0.1:/api/local/roots` and `https://example.com`;
    - window.open and top navigation;
    - its own `location.href = https://example.com` (the frame stayed put), with network off and on.
  - A raw sandboxed iframe *without* the CSP also couldn't read `/api/local/*` or `/socket.io`.
- **Quit:** no processes left, and the port closed.

Screenshots: `/workspace/aetherterm/v0.3/` (01–13, listed in the final report).

## Fixed along the way

- **Ollama calls timed out after 5 minutes.** They now stream over node:http. Danny's core_os agents (`agent_seat.py`, `memory_agent_cli.py`) keep the local Ollama busy at about 2.4 tok/s, so AetherTerm requests can wait in its queue for minutes. Node's fetch gave up after 5 minutes ("fetch failed"). The revise test then took about 11 minutes, all of it queue time.
- **Layout:** the main area now shrinks beside the wider canvas panel.

## Open risks (v0.3)

- **Real mode is as powerful as v0.2.** The Sandbox protects you only while it's on. The confirmation lives in the app UI. The server also requires the unlock phrase, but anything holding the token (code running as milla, see v0.2 risks) could send it.
- **What the Sandbox covers.** It covers the explorer, Local Shell, real-file media and Trash. It does not cover:
  - the VFS's own disk folder (`~/.local/share/aetherterm/files`), which is real disk, by design;
  - "Import a copy of a folder", which reads a folder you pick into the VFS;
  - outgoing calls to a cloud model, if you pick one.
- **Canvas with network on** can load https: scripts from anywhere and send data out through image URLs. It still can't reach the app or your files. Default is off.
- **Inline JS in previews runs with `unsafe-eval`.** It's confined to the opaque-origin frame.
- **Still dead:** the "Run" button and the Sandbox Integrity Auditor panel, which shows fake numbers. Remove them or build real ones later.
- **Same bug in the live tree:** `/home/milla/AetherTerm` still has the media bug, untouched.
- **v0.2 risks still apply.**
