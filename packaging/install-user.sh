#!/usr/bin/env bash
# Install AetherTerm for the current user only (no root, nothing system-wide).
# Usage: packaging/install-user.sh path/to/aetherterm-*.pkg.tar.zst
# Puts files under ~/.local (lib, bin, share/applications, share/icons).
# Any file it would replace is first backed up next to itself as *.bak-<timestamp>.
set -euo pipefail
pkg="$(readlink -f "${1:?usage: install-user.sh aetherterm-*.pkg.tar.zst}")"
prefix="${AETHERTERM_PREFIX:-$HOME/.local}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
ts="$(date +%Y%m%d-%H%M%S)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
bsdtar -xf "$pkg" -C "$tmp" usr

backup() { if [[ -e "$1" || -L "$1" ]]; then mv "$1" "$1.bak-$ts"; echo "backed up $1 -> $1.bak-$ts"; fi; }

mkdir -p "$prefix/lib" "$prefix/bin" "$data/applications"
backup "$prefix/lib/aetherterm"
cp -a "$tmp/usr/lib/aetherterm" "$prefix/lib/aetherterm"
backup "$prefix/bin/aetherterm"
install -m755 "$tmp/usr/bin/aetherterm" "$prefix/bin/aetherterm"
# Absolute Exec so the menu works even when ~/.local/bin is not on the session PATH.
backup "$data/applications/aetherterm.desktop"
sed "s#^Exec=aetherterm#Exec=$prefix/bin/aetherterm#" "$tmp/usr/share/applications/aetherterm.desktop" > "$data/applications/aetherterm.desktop"
chmod 644 "$data/applications/aetherterm.desktop"
(cd "$tmp/usr/share/icons" && find hicolor -name 'aetherterm.*' -print0) | while IFS= read -r -d '' f; do
  install -Dm644 "$tmp/usr/share/icons/$f" "$data/icons/$f"
done
command -v update-desktop-database >/dev/null && update-desktop-database "$data/applications" || true
command -v gtk-update-icon-cache >/dev/null && [[ -f "$data/icons/hicolor/index.theme" ]] && gtk-update-icon-cache -q -t "$data/icons/hicolor" || true
echo "Installed AetherTerm for $USER. Launch it from the app menu or run: $prefix/bin/aetherterm"
