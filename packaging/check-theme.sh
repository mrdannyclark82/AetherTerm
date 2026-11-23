#!/usr/bin/env bash
# Fails if a component hard-codes a colour instead of using a theme token (see THEMING.md).
# Allowed: src/theme.css and src/theme.ts (the theme itself).
set -uo pipefail
cd "$(dirname "$0")/.."
files=$(git ls-files 'src/*.tsx' 'src/*.ts' 'src/*.css' 'src/**/*.tsx' 'src/**/*.ts' 'src/**/*.css' | grep -vE '^src/theme\.(ts|css)$' | sort -u)
palette='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white'
prefix='bg|text|border|from|via|to|ring|shadow|fill|stroke|placeholder|accent|outline|divide|decoration|caret'
bad=0
if grep -nE "#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(" $files; then echo "^ hard-coded colour values"; bad=1; fi
if grep -nE "\b($prefix)-($palette)(-[0-9]{2,3})?(/[0-9]+)?\b" $files | grep -vE 'back-to-sandbox'; then echo "^ Tailwind palette colour classes"; bad=1; fi
[ $bad = 0 ] && echo "theme check OK: no hard-coded colours outside src/theme.css and src/theme.ts ($(echo $files | wc -w) files checked)"
exit $bad
