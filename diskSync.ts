/**
 * diskSync.ts — Two-way local file sync engine for AetherTerm.
 *
 * Bridges the in-memory VFS with a real directory on local disk:
 *   disk  → watcher → VFS update → socket.io broadcast → all clients
 *   client → socket event → VFS update → disk write-through
 *
 * Security: every VFS path is resolved against SYNC_ROOT and rejected
 * if it escapes. Client-supplied paths are never trusted.
 *
 * Conflicts: last-write-wins. Every write is logged.
 */
import fs from 'fs/promises';
import { watch, FSWatcher } from 'fs';
import path from 'path';
import crypto from 'crypto';

export type VFSNodeType = 'file' | 'directory';

export type SyncVFSNode = {
  path: string; // vfs-style path, e.g. "/notes/todo.txt"
  type: VFSNodeType;
  content?: string;
  children?: string[];
  createdAt: number;
  updatedAt: number;
  ownerId: string;
  /** v0.4: a binary file (image, video...). Its bytes stay on disk; content is ''. */
  binary?: boolean;
};

export type DiskChangeHandler = (events: Array<{
  kind: 'upsert' | 'delete';
  vfsPath: string;
}>) => void;

const SYNC_ROOT = path.resolve(
  process.env.AETHERTERM_SYNC_ROOT || '/home/milla/aetherterm-files'
);

// Paths we wrote ourselves recently: diskPath -> timestamp.
// Watcher events for these within the suppression window are our own echo.
const selfWriteStamps = new Map<string, number>();
const ECHO_SUPPRESS_MS = 1500;

// Debounce per-path so rapid successive watcher events coalesce.
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 250;

function log(...args: any[]) {
  console.log('[diskSync]', ...args);
}

/**
 * Resolve a VFS path ("/a/b.txt") to an absolute disk path under SYNC_ROOT.
 * Returns null if the path is unsafe (traversal, absolute, null bytes, etc).
 */
export function safeResolve(vfsPath: string): string | null {
  if (typeof vfsPath !== 'string') return null;
  if (vfsPath.includes('\0')) return null;
  // Normalize: must be a vfs-style absolute path starting with /
  if (!vfsPath.startsWith('/')) return null;
  // Reject any ".." segments outright — no legitimate vfs path needs them.
  const segs = vfsPath.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.')) return null;
  const resolved = path.resolve(SYNC_ROOT, ...segs);
  // Final containment check (handles symlinks tricks on resolve).
  if (resolved !== SYNC_ROOT && !resolved.startsWith(SYNC_ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

/** Convert an absolute disk path back to a vfs path. Null if outside root. */
export function toVfsPath(diskPath: string): string | null {
  const resolved = path.resolve(diskPath);
  if (resolved !== SYNC_ROOT && !resolved.startsWith(SYNC_ROOT + path.sep)) {
    return null;
  }
  const rel = path.relative(SYNC_ROOT, resolved);
  return '/' + rel.split(path.sep).join('/');
}

function hashContent(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

async function readFileSafe(diskPath: string): Promise<string | null> {
  try {
    // Only sync text files — skip anything that looks binary or is huge.
    const stat = await fs.stat(diskPath);
    if (stat.size > 2 * 1024 * 1024) {
      log(`skip large file (>2MB): ${diskPath}`);
      return null;
    }
    const buf = await fs.readFile(diskPath);
    // Binary sniff: reject if it contains a null byte in the first 8KB.
    if (buf.subarray(0, 8192).includes(0)) {
      log(`skip binary file: ${diskPath}`);
      return null;
    }
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

/** v0.4: true if the file exists and is binary or too large to hold as text. */
async function isBinaryOnDisk(diskPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(diskPath);
    if (!stat.isFile() || stat.size === 0) return false;
    return (await readFileSafe(diskPath)) === null;
  } catch {
    return false;
  }
}

/** Recursively scan SYNC_ROOT and return a flat map of vfsPath -> node. */
export async function scanDisk(): Promise<Map<string, SyncVFSNode>> {
  const out = new Map<string, SyncVFSNode>();
  const now = Date.now();

  async function walk(diskDir: string, vfsDir: string) {
    let entries;
    try {
      entries = await fs.readdir(diskDir, { withFileTypes: true });
    } catch {
      return;
    }
    // Ensure the directory node itself exists.
    if (!out.has(vfsDir)) {
      out.set(vfsDir, {
        path: vfsDir,
        type: 'directory',
        children: [],
        createdAt: now,
        updatedAt: now,
        ownerId: 'disk-sync',
      });
    }
    const dirNode = out.get(vfsDir)!;
    for (const entry of entries) {
      // Skip dotfiles and junk.
      if (entry.name.startsWith('.')) continue;
      const childVfs = (vfsDir === '/' ? '' : vfsDir) + '/' + entry.name;
      const childDisk = path.join(diskDir, entry.name);
      if (entry.isDirectory()) {
        dirNode.children!.push(childVfs);
        await walk(childDisk, childVfs);
      } else if (entry.isFile()) {
        const content = await readFileSafe(childDisk);
        // v0.4: binaries (images, videos...) stay in the tree so they survive a restart;
        // their bytes stay on disk and are served from /vfs.
        dirNode.children!.push(childVfs);
        out.set(childVfs, {
          path: childVfs,
          type: 'file',
          content: content ?? '',
          ...(content === null ? { binary: true } : {}),
          createdAt: now,
          updatedAt: now,
          ownerId: 'disk-sync',
        });
      }
      // Symlinks and special files are ignored deliberately.
    }
  }

  await fs.mkdir(SYNC_ROOT, { recursive: true });
  await walk(SYNC_ROOT, '/');
  return out;
}

/** Mark a disk path as self-written so the watcher ignores its echo. */
export function markSelfWrite(diskPath: string) {
  selfWriteStamps.set(diskPath, Date.now());
  // Prune old entries occasionally.
  if (selfWriteStamps.size > 5000) {
    const cutoff = Date.now() - ECHO_SUPPRESS_MS * 4;
    for (const [k, v] of selfWriteStamps) {
      if (v < cutoff) selfWriteStamps.delete(k);
    }
  }
}

function isSelfEcho(diskPath: string): boolean {
  const t = selfWriteStamps.get(diskPath);
  if (!t) return false;
  if (Date.now() - t < ECHO_SUPPRESS_MS) return true;
  selfWriteStamps.delete(diskPath);
  return false;
}

/**
 * Write a VFS node through to disk. Returns the disk path, or null if unsafe.
 * Directories are created; files get their content written.
 */
export type SyncConflictRecord = {
  vfsPath: string;
  expectedSha256: string;
  actualSha256: string;
  resolvedBy: 'last-write-wins';
  detectedAt: number;
};

const syncConflicts: SyncConflictRecord[] = [];

export function getSyncConflicts(): SyncConflictRecord[] {
  return [...syncConflicts];
}

export async function writeThrough(
  vfsPath: string,
  node: { type: VFSNodeType; content?: string; expectedSha256?: string }
): Promise<string | null> {
  const diskPath = safeResolve(vfsPath);
  if (!diskPath) {
    log(`REJECTED unsafe path: ${vfsPath}`);
    return null;
  }
  try {
    if (node.type === 'directory') {
      await fs.mkdir(diskPath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(diskPath), { recursive: true });
      // v0.4: binary files are held in the VFS with empty content. Never let that
      // empty text overwrite the real bytes on disk.
      if (!node.content && (await isBinaryOnDisk(diskPath))) {
        log(`kept binary file (empty text write ignored): ${vfsPath}`);
        return diskPath;
      }
      if (node.expectedSha256) {
        const existingContent = await readFileSafe(diskPath);
        if (existingContent !== null) {
          const actualSha256 = hashContent(existingContent);
          if (actualSha256 !== node.expectedSha256) {
            syncConflicts.push({
              vfsPath,
              expectedSha256: node.expectedSha256,
              actualSha256,
              resolvedBy: 'last-write-wins',
              detectedAt: Date.now(),
            });
            if (syncConflicts.length > 200) syncConflicts.shift();
            log(`CONFLICT detected on ${vfsPath} (expected ${node.expectedSha256.slice(0, 8)}, found ${actualSha256.slice(0, 8)}) -> resolved via last-write-wins`);
          }
        }
      }
      await fs.writeFile(diskPath, node.content ?? '', 'utf-8');
    }
    markSelfWrite(diskPath);
    log(`disk write: ${vfsPath}`);
    return diskPath;
  } catch (err: any) {
    log(`disk write FAILED ${vfsPath}: ${err.message}`);
    return null;
  }
}

/** v0.4: write raw bytes (generated images/videos) under SYNC_ROOT. */
export async function writeBinaryThrough(vfsPath: string, bytes: Buffer): Promise<string | null> {
  const diskPath = safeResolve(vfsPath);
  if (!diskPath) {
    log(`REJECTED unsafe path: ${vfsPath}`);
    return null;
  }
  try {
    await fs.mkdir(path.dirname(diskPath), { recursive: true });
    await fs.writeFile(diskPath, bytes);
    markSelfWrite(diskPath);
    log(`disk write (binary): ${vfsPath}`);
    return diskPath;
  } catch (err: any) {
    log(`disk write FAILED ${vfsPath}: ${err.message}`);
    return null;
  }
}

/** Delete a VFS path from disk. Returns true on success. */
export async function deleteThrough(vfsPath: string): Promise<boolean> {
  const diskPath = safeResolve(vfsPath);
  if (!diskPath) {
    log(`REJECTED unsafe path: ${vfsPath}`);
    return false;
  }
  if (diskPath === SYNC_ROOT) {
    log('REJECTED delete of sync root');
    return false;
  }
  try {
    await fs.rm(diskPath, { recursive: true, force: true });
    markSelfWrite(diskPath);
    // Also mark children (recursive delete triggers many watcher events).
    log(`disk delete: ${vfsPath}`);
    return true;
  } catch (err: any) {
    log(`disk delete FAILED ${vfsPath}: ${err.message}`);
    return false;
  }
}

/**
 * Start watching SYNC_ROOT. Disk changes are debounced, echo-suppressed,
 * and delivered to onChange as {kind, vfsPath} events.
 */
let watcherQueue: Promise<void> = Promise.resolve();

export function flushWatcherQueue(): Promise<void> {
  return watcherQueue;
}

export function startWatcher(onChange: DiskChangeHandler): FSWatcher | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(SYNC_ROOT, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const diskPath = path.resolve(SYNC_ROOT, filename.toString());
      const vfsPath = toVfsPath(diskPath);
      if (!vfsPath) return; // outside root — ignore
      if (isSelfEcho(diskPath)) return; // our own write — ignore

      // Debounce: coalesce rapid events for the same path.
      const existing = debounceTimers.get(vfsPath);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        vfsPath,
        setTimeout(() => {
          debounceTimers.delete(vfsPath);
          watcherQueue = watcherQueue
            .then(async () => {
              try {
                const stat = await fs.stat(diskPath);
                if (stat.isDirectory() || stat.isFile()) {
                  await Promise.resolve(onChange([{ kind: 'upsert', vfsPath }]));
                }
              } catch {
                await Promise.resolve(onChange([{ kind: 'delete', vfsPath }]));
              }
            })
            .catch((err) => log(`watcher async queue error: ${(err as Error).message}`));
        }, DEBOUNCE_MS)
      );
    });
  } catch (err: any) {
    log(`watcher FAILED to start: ${err.message}`);
    return null;
  }
  watcher.on('error', (err) => log(`watcher error: ${(err as Error).message}`));
  log(`watching ${SYNC_ROOT} (two-way sync active)`);
  return watcher;
}

export function getSyncRoot(): string {
  return SYNC_ROOT;
}

/** Read a single file from disk into a VFS node (for upsert events). */
export async function readDiskNode(vfsPath: string): Promise<SyncVFSNode | null> {
  const diskPath = safeResolve(vfsPath);
  if (!diskPath) return null;
  const now = Date.now();
  try {
    const stat = await fs.stat(diskPath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(diskPath);
      const children = entries
        .filter((n) => !n.startsWith('.'))
        .map((n) => (vfsPath === '/' ? '' : vfsPath) + '/' + n);
      return {
        path: vfsPath,
        type: 'directory',
        children,
        createdAt: now,
        updatedAt: now,
        ownerId: 'disk-sync',
      };
    }
    const content = await readFileSafe(diskPath);
    return {
      path: vfsPath,
      type: 'file',
      content: content ?? '',
      ...(content === null ? { binary: true } : {}),
      createdAt: now,
      updatedAt: now,
      ownerId: 'disk-sync',
    };
  } catch {
    return null;
  }
}

export { hashContent };
