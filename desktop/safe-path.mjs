// Shared by the Electron main process and the server: resolve a path the
// renderer asked for, and refuse anything outside the folders Danny mapped.
//   mode 'follow': the final target (after symlinks) must be inside the root.
//                  Used for list/read/write and the shell's start folder.
//   mode 'entry' : the entry itself is acted on (rename/trash), so only its
//                  parent folder (after symlinks) must be inside the root; a
//                  symlink pointing elsewhere can be renamed or trashed, but
//                  never followed.
import fs from 'node:fs/promises';
import path from 'node:path';

export class PathError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}

function inside(base, p) {
  return p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

/**
 * @param {string[]} roots  mapped folders (absolute)
 * @param {string} root     the root the request names (must be one of roots)
 * @param {string} rel      path relative to that root ('' = the root)
 * @param {{mode?: 'follow'|'entry', mustExist?: boolean}} [opts]
 * @returns {Promise<{rootReal: string, target: string, real: string|null, exists: boolean}>}
 */
export async function resolveInRoot(roots, root, rel, opts = {}) {
  const mode = opts.mode || 'follow';
  const mustExist = opts.mustExist !== false;
  if (typeof root !== 'string' || typeof rel !== 'string') throw new PathError('Bad path.', 400);
  if (root.includes('\0') || rel.includes('\0')) throw new PathError('Bad path.', 400);
  const wanted = path.resolve(root);
  if (!roots.map((r) => path.resolve(r)).includes(wanted)) throw new PathError('That folder is not mapped.');
  let rootReal;
  try { rootReal = await fs.realpath(wanted); } catch { throw new PathError('Mapped folder is missing.', 404); }

  const cleanRel = rel.replace(/^[/\\]+/, '');
  const target = path.resolve(rootReal, cleanRel);
  if (!inside(rootReal, target)) throw new PathError('Path escapes the mapped folder.');

  const there = await exists(target);
  if (!there && mustExist) throw new PathError('Not found.', 404);

  if (mode === 'entry') {
    if (target === rootReal) throw new PathError('Cannot change the mapped folder itself.');
    const parentReal = await fs.realpath(path.dirname(target)).catch(() => null);
    if (!parentReal || !inside(rootReal, parentReal)) throw new PathError('Path escapes the mapped folder.');
    return { rootReal, target: path.join(parentReal, path.basename(target)), real: null, exists: there };
  }

  if (there) {
    const real = await fs.realpath(target).catch(() => null);
    if (!real || !inside(rootReal, real)) throw new PathError('That link points outside the mapped folder.');
    return { rootReal, target, real, exists: true };
  }
  // New file/folder: the parent must exist and resolve inside the root.
  const parentReal = await fs.realpath(path.dirname(target)).catch(() => null);
  if (!parentReal || !inside(rootReal, parentReal)) throw new PathError('Path escapes the mapped folder.');
  return { rootReal, target: path.join(parentReal, path.basename(target)), real: null, exists: false };
}

export function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 &&
    name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

export async function readFolders(file, fallback) {
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    const list = Array.isArray(j.folders) ? j.folders.filter((f) => typeof f === 'string' && path.isAbsolute(f)) : [];
    return list.length ? list : [fallback];
  } catch {
    return [fallback];
  }
}
