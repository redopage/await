import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/object/router.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { Router } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const router = new Router([
  ['GET', '/attachments/library', 'library'],
  ['DELETE', '/attachments/:attachment', 'remove'],
  ['*', '/attachments/:attachment', 'read'],
  ['POST', '/channels/:channel/threads/:thread/read', 'thread read'],
  ['*', '/projects', 'projects'],
  ['*', '/projects/*', 'projects'],
]);
const answer = (method, path) => router.match(method, path)?.handler ?? null;

test('literal segments and params match whole segments only', () => {
  assert.deepEqual(router.match('POST', '/channels/c1/threads/t1/read'), { handler: 'thread read', params: { channel: 'c1', thread: 't1' } });
  assert.equal(answer('POST', '/channels/c1/threads/t1/read/'), null);
  assert.equal(answer('POST', '/channels//threads/t1/read'), null);
  assert.equal(answer('POST', '/channels/c1/threads/t1'), null);
  assert.equal(answer('POST', '/channels/c1/threads/t1/read/more'), null);
});

test('routes match raw segments, then params decode once', () => {
  assert.deepEqual(router.match('GET', '/attachments/a%2F..%2Fx'), { handler: 'read', params: { attachment: 'a/../x' } });
  assert.deepEqual(router.match('GET', '/attachments/%2541').params, { attachment: '%41' });
  assert.equal(answer('GET', '/attachments/librar%79'), 'read');
  assert.throws(() => router.match('GET', '/attachments/%zz'), URIError);
});

test('the first route whose method and path match answers', () => {
  assert.equal(answer('GET', '/attachments/library'), 'library');
  assert.equal(answer('POST', '/attachments/library'), 'read');
  assert.equal(answer('DELETE', '/attachments/library'), 'remove');
  assert.equal(answer('HEAD', '/attachments/a1'), 'read');
  assert.equal(answer('GET', '/channels/c1/threads/t1/read'), null);
});

test('a final * matches everything below its prefix but not the prefix itself', () => {
  for (const path of ['/projects', '/projects/', '/projects/p1', '/projects/p1/runs/r1']) assert.equal(answer('PATCH', path), 'projects', path);
  assert.equal(answer('GET', '/projectsx'), null);
  assert.equal(new Router([['GET', '/projects/*', 'below']]).match('GET', '/projects'), null);
});
