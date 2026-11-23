// v0.4: binary files (generated images/videos) stay in the VFS across restarts and are never blanked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aeth-bin-test-'));
process.env.AETHERTERM_SYNC_ROOT = ROOT;
const ds = await import('../diskSync');

test('binary files are kept in the scan and protected from empty writes', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 1, 2, 3]);
  assert.ok(await ds.writeBinaryThrough('/home/danny/milla/media/a.png', png));
  const nodes = await ds.scanDisk();
  const n = nodes.get('/home/danny/milla/media/a.png');
  assert.equal(n?.binary, true);
  assert.equal(n?.content, '');
  assert.ok(nodes.get('/home/danny/milla/media')?.children?.includes('/home/danny/milla/media/a.png'));
  await ds.writeThrough('/home/danny/milla/media/a.png', { type: 'file', content: '' });
  assert.deepEqual(fs.readFileSync(path.join(ROOT, 'home/danny/milla/media/a.png')), png, 'bytes survive an empty text write');
  await ds.writeThrough('/home/danny/t.txt', { type: 'file', content: 'hi' });
  await ds.writeThrough('/home/danny/t.txt', { type: 'file', content: '' });
  assert.equal(fs.readFileSync(path.join(ROOT, 'home/danny/t.txt'), 'utf8'), '', 'text files can still be emptied');
  fs.rmSync(ROOT, { recursive: true, force: true });
});
