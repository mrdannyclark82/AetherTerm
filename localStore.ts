// Local-only persistence for chat/terminal history (replaces Firestore).
// File: $AETHERTERM_HISTORY_FILE or ~/.local/share/aetherterm/history.json
import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_ENTRIES = 500;
export const HISTORY_FILE = process.env.AETHERTERM_HISTORY_FILE ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'aetherterm', 'history.json');

export function loadHistory<T>(): T[] {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(j.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

export function saveHistory<T>(entries: T[]) {
  const keep = entries.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${HISTORY_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries: keep }), { mode: 0o600 });
  fs.renameSync(tmp, HISTORY_FILE);
}

/** Save whenever the array changes (checked every 2s) and once more on exit. */
export function autosaveHistory<T extends { id?: string }>(get: () => T[]) {
  let sig = '';
  const signature = () => { const h = get(); return `${h.length}:${h[h.length - 1]?.id ?? ''}`; };
  sig = signature();
  const tick = () => {
    const s = signature();
    if (s === sig) return;
    sig = s;
    try { saveHistory(get()); } catch (e) { console.error('[history] save failed:', e); }
  };
  setInterval(tick, 2000).unref();
  process.on('exit', tick);
}
