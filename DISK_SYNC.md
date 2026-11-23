# AetherTerm Two-Way Disk Sync

## What it does
Syncs the terminal's virtual file system (VFS) bidirectionally with a real
directory on local disk:

- **Disk → Terminal**: create/edit/delete a file in the sync folder and it
  appears in AetherTerm within ~250ms.
- **Terminal → Disk**: create/edit/delete in the terminal and it's written
  straight to disk.

## Configuration
| Env var | Default | Purpose |
|---|---|---|
| `AETHERTERM_SYNC_ROOT` | `/home/milla/aetherterm-files` | Local directory synced with the VFS |

Set it before starting the server:
```bash
AETHERTERM_SYNC_ROOT=/path/to/folder ./node_modules/.bin/tsx server.ts
```

## Security
- Every client-supplied path is validated by `safeResolve()` in `diskSync.ts`:
  rejects `..` segments, absolute paths, null bytes, and anything escaping
  the sync root. The sync root itself can never be deleted via the API.
- Binary files and files >2MB are skipped (not synced into the VFS).
- Symlinks and dotfiles are ignored on disk scan.

## Conflicts
Last-write-wins. Every write is logged with `[diskSync]` prefix. No merge
attempts — simple and predictable.

## Files
- `diskSync.ts` — the sync engine (watcher, path validation, read/write-through)
- `server.ts` — integration: VFS seeding from disk, write-through on
  `vfs_create`/`vfs_update`/`vfs_delete`, `sync_vfs_batch` handler for the
  browser File System Access API mount, watcher startup.
- `server.ts.bak-disksync` — pre-change backup.
