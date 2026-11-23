#!/usr/bin/env bash
# Build the self-contained AetherTerm app folder (what goes in /usr/lib/aetherterm).
# Usage: packaging/build-app.sh [OUTDIR]   (default: ./stage/aetherterm)
# Needs: node >= 20, npm. Network for `npm ci` unless the npm cache is warm.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$repo/stage/aetherterm}"
cd "$repo"

if [[ -e .env || -e .env.local ]]; then
  echo "Refusing to build: a .env file is present and vite.config.ts would bake GEMINI_API_KEY into the web bundle." >&2
  exit 1
fi
[[ -d node_modules ]] || npm ci --no-audit --no-fund

version="$(node -p "require('./packaging/app-package.json').version")"
rm -rf "$out"
mkdir -p "$out"/{server,desktop}

npx vite build --outDir "$out/dist" --emptyOutDir
npx esbuild server.ts --bundle --platform=node --format=esm --target=node22 \
  --packages=external --outfile="$out/server/server.mjs" --log-level=warning

cp desktop/main.mjs desktop/preload.cjs desktop/safe-path.mjs "$out/desktop/"
# v0.4: `canvas FILE` helper for the real shell (put on its PATH by the server).
mkdir -p "$out/bin" && install -m755 packaging/bin/canvas "$out/bin/canvas"
cp packaging/icons/aetherterm-256.png "$out/desktop/aetherterm.png"
cp packaging/app-package.json "$out/package.json"
cp package-lock.json "$out/package-lock.json"
cp -r shims "$out/shims"
# Runtime deps only. npm 12 blocks install scripts; none are needed at runtime.
(cd "$out" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts >/dev/null)
rm -f "$out/package-lock.json"
# node-pty is native: build it against the Electron that will run the server.
electron_bin="${AETHERTERM_ELECTRON:-electron39}"
electron_ver="$(ELECTRON_RUN_AS_NODE=1 "$electron_bin" -p process.versions.electron)"
(cd "$out/node_modules/node-pty" && PYTHON="${PYTHON:-/usr/bin/python3}" npx --yes node-gyp@11 rebuild \
   --runtime=electron --target="$electron_ver" --dist-url=https://electronjs.org/headers >/dev/null)
find "$out/node_modules/node-pty/build" -mindepth 1 -maxdepth 1 ! -name Release -exec rm -rf {} +
find "$out/node_modules/node-pty/build/Release" -mindepth 1 ! -name pty.node -exec rm -rf {} +
rm -rf "$out/node_modules/node-pty/"{deps,src,third_party,prebuilds} "$out/node_modules/node-addon-api"
(cd "$out" && ELECTRON_RUN_AS_NODE=1 "$electron_bin" -e "
  const p=require('node-pty'); const t=p.spawn('/bin/sh',['-c','exit 7'],{});
  t.onExit(e=>{ if(e.exitCode!==7){console.error('node-pty self-test failed');process.exit(1)} console.log('node-pty OK for electron $electron_ver'); });")
# Drop packages the server bundle never loads: build tools, browser-only UI libs
# (already inside dist/).
rm -rf "$out"/node_modules/{vite,@vitejs,@tailwindcss,tailwindcss,lightningcss*,@esbuild,esbuild,rollup,@rollup,@babel} \
       "$out"/node_modules/{lucide-react,react,react-dom,motion,framer-motion,socket.io-client,clsx,tailwind-merge,@xterm}
# Fail the build if the server bundle needs something we removed.
(cd "$out" && ELECTRON_RUN_AS_NODE=1 node --input-type=module -e "
  const src = (await import('node:fs')).readFileSync('server/server.mjs','utf8');
  const mods = [...new Set([...src.matchAll(/from \"([^\".][^\"]*)\"/g)].map(m=>m[1]).filter(m=>!m.startsWith('node:') && !['fs','fs/promises','path','http','crypto','child_process','os','url'].includes(m)))];
  for (const m of mods) await import(m);
  console.log('server deps resolve:', mods.join(', '));
")
echo "Built AetherTerm $version in $out ($(du -sh "$out" | cut -f1))"
