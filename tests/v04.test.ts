// Unit tests for the v0.4 helpers. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeV, resolveV, displayV, VIRTUAL_HOME } from '../vhome';
import { fromShellOutput, fromFile, fromMillaReply, renderArtifact, markdownToHtml, kindOfPath } from '../src/desktop/artifact';

test('virtual home paths', () => {
  assert.equal(VIRTUAL_HOME, '/home/danny');
  assert.equal(resolveV('~', '/tmp'), '/home/danny');
  assert.equal(resolveV('~/docs', '/'), '/home/danny/docs');
  assert.equal(resolveV('..', '/home/danny'), '/home');
  assert.equal(resolveV('../../..', '/home/danny'), '/');
  assert.equal(normalizeV('/a//b/./c/'), '/a/b/c');
  assert.equal(displayV('/home/danny/x'), '~/x');
});

test('kinds by extension', () => {
  assert.equal(kindOfPath('a/b/report.html'), 'html');
  assert.equal(kindOfPath('notes.md'), 'markdown');
  assert.equal(kindOfPath('data.csv'), 'csv');
  assert.equal(kindOfPath('x.png'), 'image');
});

test('trivial shell output does not open the canvas', () => {
  assert.equal(fromShellOutput('ok', { command: 'echo ok', origin: 'sandbox' }), null);
  assert.equal(fromShellOutput('/home/danny', { command: 'pwd', origin: 'sandbox' }), null);
});

test('renderable file output becomes an artifact', () => {
  const csv = fromShellOutput('a,b\n1,2\n3,4', { path: '/home/danny/t.csv', command: 'cat t.csv', origin: 'sandbox' });
  assert.equal(csv?.kind, 'csv');
  const md = fromFile('/home/danny/r.md', '# Title\n\n- one', { origin: 'real' });
  assert.equal(md?.kind, 'markdown');
  assert.equal(md?.origin, 'real');
});

test('Milla reply with an HTML block becomes an html artifact', () => {
  const a = fromMillaReply('Here:\n```html\n<!doctype html><h1>Hi</h1>\n```');
  assert.equal(a?.kind, 'html');
});

test('rendered previews are script-free and escaped', () => {
  const md = markdownToHtml('# Hi <script>alert(1)</script>');
  assert.ok(!md.includes('<script>alert'));
  const table = renderArtifact('csv', 'name,v\n<b>x</b>,1');
  assert.ok(table.includes('<table'));
  assert.ok(!table.includes('<b>x</b>'));
});
