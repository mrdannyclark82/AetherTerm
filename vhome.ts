// AetherTerm v0.4: "Home follows the mode".
// Sandbox: ~ and every default path resolve to the virtual home inside the VFS.
// Real:    ~ is the real home folder (os.homedir(), e.g. /home/milla).
import path from 'path';

/** Normalise a VFS path: always absolute, no "..", no trailing slash. Can't climb above "/". */
export function normalizeV(p: string): string {
  let n = path.posix.normalize('/' + String(p || ''));
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

/** The sandbox home inside the VFS (AETHERTERM_VIRTUAL_HOME, default /home/danny). */
export const VIRTUAL_HOME = normalizeV(process.env.AETHERTERM_VIRTUAL_HOME || '/home/danny');

/** Resolve what was typed in the virtual shell against its cwd. "~" is the virtual home. */
export function resolveV(input: string, cwd: string): string {
  const s = String(input || '').trim();
  if (!s || s === '~') return VIRTUAL_HOME;
  if (s.startsWith('~/')) return normalizeV(`${VIRTUAL_HOME}/${s.slice(2)}`);
  if (s.startsWith('/')) return normalizeV(s);
  return normalizeV(`${cwd || VIRTUAL_HOME}/${s}`);
}

/** Show a VFS path the way a shell prompt does (~ for the virtual home). */
export function displayV(p: string): string {
  if (p === VIRTUAL_HOME) return '~';
  if (p.startsWith(VIRTUAL_HOME + '/')) return '~' + p.slice(VIRTUAL_HOME.length);
  return p;
}

/** Where Milla's own output lives in the Sandbox: inside ~ (it used to go to /home/Milla-Rayne). */
export const MILLA_DIRS = {
  apps: `${VIRTUAL_HOME}/milla/apps`,      // Generate App / canvas saves
  media: `${VIRTUAL_HOME}/milla/media`,    // generated images and videos
  synced: `${VIRTUAL_HOME}/milla/synced`,  // github-sync
} as const;

/** VFS path for a file Milla generates, e.g. millaPath('apps', 'app-1.html') -> ~/milla/apps/app-1.html. */
export function millaPath(kind: keyof typeof MILLA_DIRS, name: string): string {
  const safe = String(name || 'untitled').replace(/[\/\0]/g, '_').replace(/^\.+/, '_');
  return normalizeV(`${MILLA_DIRS[kind]}/${safe}`);
}
