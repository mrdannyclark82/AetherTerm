#!/usr/bin/env bash
# AetherTerm launcher. Works from /usr/bin (pacman package) or ~/.local/bin (user install).
set -euo pipefail
self="$(readlink -f "${BASH_SOURCE[0]}")"
appdir="$(cd "$(dirname "$self")/../lib/aetherterm" && pwd)"
electron="${AETHERTERM_ELECTRON:-electron39}"
exec "$electron" "$appdir" "$@"
