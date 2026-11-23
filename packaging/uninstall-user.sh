#!/usr/bin/env bash
# Remove the user-level AetherTerm install made by install-user.sh.
# Program files are moved to an archive folder, not deleted. Your settings and
# data (~/.config/aetherterm, ~/.local/share/aetherterm, ~/.local/state/aetherterm)
# are kept unless you pass --archive-data, which moves them into the archive too.
set -euo pipefail
prefix="${AETHERTERM_PREFIX:-$HOME/.local}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
state="${XDG_STATE_HOME:-$HOME/.local/state}"
archive="$HOME/archive/aetherterm-uninstall-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$archive"
move() { if [[ -e "$1" || -L "$1" ]]; then mkdir -p "$archive/$(dirname "${1#$HOME/}")"; mv "$1" "$archive/${1#$HOME/}"; echo "archived $1"; fi; }

pkill -u "$USER" -f "$prefix/lib/aetherterm" 2>/dev/null && sleep 1 || true
move "$prefix/lib/aetherterm"
move "$prefix/bin/aetherterm"
move "$data/applications/aetherterm.desktop"
while IFS= read -r -d '' f; do move "$f"; done < <(find "$data/icons/hicolor" -name 'aetherterm.*' -print0 2>/dev/null)
if [[ "${1:-}" == "--archive-data" ]]; then
  move "$config/aetherterm"; move "$data/aetherterm"; move "$state/aetherterm"
fi
command -v update-desktop-database >/dev/null && update-desktop-database "$data/applications" || true
echo "AetherTerm removed. Archived files: $archive"
