import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'await-repository-tests-'));
const compiled = await build({ stdin: { contents: `export * from './src/object/project-repository'; export * from './src/shared/project-repository';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(join(dir, 'runtime.mjs'), compiled.outputFiles[0].contents);
const { readRunRepository, validateRunFileRange, RunRepositoryError, RUN_REPOSITORY_LIMITS } = await import(join(dir, 'runtime.mjs'));
await rm(dir, { recursive: true, force: true });

const hash = (...parts) => createHash('sha1').update(parts.join('\0')).digest('hex');
const modes = { tree: '40000', blob: '100644', exec: '100755', symlink: '120000', gitlink: '160000' };
const entry = (name, oid, type) => ({ name, mode: modes[type], hash: oid, type });

// An in-memory Artifacts repository that records every call and refuses anything other than the three object reads.
function memoryRepo() {
  const commits = new Map(), trees = new Map(), blobs = new Map(), calls = [];
  let bodies = 0;
  const api = {
    readCommit: async (oid) => commits.get(oid) ?? null,
    readTree: async (oid) => trees.get(oid)?.map((item) => ({ ...item })) ?? null,
    readBlob: async (oid) => {
      const bytes = blobs.get(oid); if (!bytes) return null;
      const blob = new Blob([bytes]);
      return { size: blob.size, arrayBuffer: () => { bodies++; return blob.arrayBuffer(); }, text: () => { bodies++; return blob.text(); } };
    },
  };
  const repo = new Proxy({}, { get: (_, name) => {
    if (!Object.hasOwn(api, name)) throw new Error(`Unexpected repository access: ${String(name)}`);
    return (...args) => { calls.push([name, ...args]); return api[name](...args); };
  } });
  const blob = (content) => { const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content; const oid = hash('blob', Buffer.from(bytes).toString('hex')); blobs.set(oid, bytes); return oid; };
  const tree = (items) => { const oid = hash('tree', JSON.stringify(items)); trees.set(oid, items); return oid; };
  const commit = (treeHash, parents = [], salt = '') => { const oid = hash('commit', treeHash, parents.join(), salt); commits.set(oid, { hash: oid, treeHash, parents }); return oid; };
  return { repo, calls, blob, tree, commit, bodies: () => bodies };
}

function fixture() {
  const r = memoryRepo();
  const submodule = hash('a commit in another repository'), link = r.blob('src'), escape = r.blob('../../../etc/passwd');
  const nested = r.tree([entry('index.ts', r.blob('export const answer = 42;\n'), 'blob')]);
  const root = r.tree([
    entry('src', nested, 'tree'),
    entry('README.md', r.blob('# Hello\n'), 'blob'),
    entry('run.sh', r.blob('#!/bin/sh\necho ok\n'), 'exec'),
    entry('linked', link, 'symlink'),
    entry('escape', escape, 'symlink'),
    entry('vendor', submodule, 'gitlink'),
    entry('logo.png', r.blob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])), 'blob'),
    entry('latin1.txt', r.blob(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), 'blob'),
    entry('large.txt', r.blob('a'.repeat(200_001)), 'blob'),
    entry('limit.txt', r.blob('é'.repeat(100_000)), 'blob'),
  ]);
  const base = r.commit(root);
  const child = r.commit(r.tree([entry('README.md', r.blob('# Changed\n'), 'blob')]), [base]);
  const foreign = r.commit(root, [], 'foreign');
  return { ...r, root, base, child, foreign, submodule, link, escape };
}

const url = (mode, params) => {
  const value = new URL(`https://await.test/api/projects/p/runs/r/${mode === 'tree' ? 'tree' : 'source-file'}`);
  for (const [key, item] of Object.entries(params)) value.searchParams.set(key, String(item));
  return value;
};
const read = (f, mode, params, base = f.base) => readRunRepository(f.repo, base, url(mode, params), mode);
const rejects = (promise, status, pattern) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof RunRepositoryError, error.message); assert.equal(error.status, status); assert.match(error.message, pattern); return true;
});

test('run repository listing is pinned, sorted and paginated', async () => {
  const f = fixture();
  const first = await read(f, 'tree', { commit: f.base, limit: 4 });
  assert.deepEqual({ commit: first.commit, path: first.path, offset: first.offset, limit: first.limit, total: first.total, has_more: first.has_more, next_offset: first.next_offset },
    { commit: f.base, path: '', offset: 0, limit: 4, total: 10, has_more: true, next_offset: 4 });
  assert.deepEqual(first.entries.map((e) => e.name), ['README.md', 'escape', 'large.txt', 'latin1.txt']);
  const middle = await read(f, 'tree', { commit: f.base, offset: first.next_offset, limit: 4 });
  assert.deepEqual(middle.entries.map((e) => e.name), ['limit.txt', 'linked', 'logo.png', 'run.sh']);
  const last = await read(f, 'tree', { commit: f.base, offset: middle.next_offset, limit: 4 });
  assert.deepEqual(last.entries.map((e) => e.name), ['src', 'vendor']);
  assert.equal(last.has_more, false); assert.equal(last.next_offset, null);
  const beyond = await read(f, 'tree', { commit: f.base, offset: 50 });
  assert.deepEqual([beyond.entries, beyond.has_more, beyond.next_offset], [[], false, null]);

  const all = await read(f, 'tree', { commit: f.base });
  assert.equal(all.limit, RUN_REPOSITORY_LIMITS.pageDefault); assert.equal(all.entries.length, 10);
  assert.deepEqual(Object.fromEntries(all.entries.map((e) => [e.name, e.type])), {
    'README.md': 'blob', escape: 'symlink', 'large.txt': 'blob', 'latin1.txt': 'blob', 'limit.txt': 'blob', linked: 'symlink', 'logo.png': 'blob', 'run.sh': 'exec', src: 'tree', vendor: 'gitlink' });
  assert.deepEqual(JSON.parse(JSON.stringify(all)), all);

  const nested = await read(f, 'tree', { commit: f.base, path: 'src' });
  assert.equal(nested.path, 'src');
  assert.deepEqual(nested.entries.map(({ name, path, type }) => ({ name, path, type })), [{ name: 'index.ts', path: 'src/index.ts', type: 'blob' }]);
  const changed = await read(f, 'tree', { commit: f.child });
  assert.deepEqual(changed.entries.map((e) => e.name), ['README.md']);
});

test('run repository files return text or explicit metadata-only results', async () => {
  const f = fixture();
  const text = await read(f, 'file', { commit: f.base, path: 'src/index.ts' });
  assert.deepEqual({ ...text, oid: undefined }, { commit: f.base, path: 'src/index.ts', type: 'blob', oid: undefined, size: 26, content: 'export const answer = 42;\n', metadata_only: false, reason: null });
  assert.deepEqual(JSON.parse(JSON.stringify(text)), text);
  const script = await read(f, 'file', { commit: f.base, path: 'run.sh' });
  assert.equal(script.type, 'exec'); assert.equal(script.content, '#!/bin/sh\necho ok\n');
  const limit = await read(f, 'file', { commit: f.base, path: 'limit.txt' });
  assert.equal(limit.size, RUN_REPOSITORY_LIMITS.fileBytes); assert.equal(limit.content.length, 100_000); assert.equal(limit.metadata_only, false);

  const before = f.bodies();
  const large = await read(f, 'file', { commit: f.base, path: 'large.txt' });
  assert.deepEqual([large.size, large.content, large.metadata_only, large.reason], [200_001, null, true, 'too_large']);
  assert.equal(f.bodies(), before, 'oversized content is never downloaded');
  for (const path of ['logo.png', 'latin1.txt']) {
    const binary = await read(f, 'file', { commit: f.base, path });
    assert.deepEqual([binary.content, binary.metadata_only, binary.reason, binary.type], [null, true, 'binary', 'blob']);
    assert.equal(typeof binary.size, 'number');
  }
  for (const [path, type, oid] of [['linked', 'symlink', f.link], ['escape', 'symlink', f.escape], ['vendor', 'gitlink', f.submodule]]) {
    const result = await read(f, 'file', { commit: f.base, path });
    assert.deepEqual(result, { commit: f.base, path, type, oid, size: null, content: null, metadata_only: true, reason: type });
  }
  assert.deepEqual(f.calls.filter(([, oid]) => [f.link, f.escape, f.submodule].includes(oid)), [], 'link targets and submodules are never read');
});

test('run repository paths never traverse symbolic links or submodules', async () => {
  const f = fixture();
  await rejects(read(f, 'file', { commit: f.base, path: 'linked/index.ts' }), 400, /symbolic link/);
  await rejects(read(f, 'tree', { commit: f.base, path: 'escape/passwd' }), 400, /symbolic link/);
  await rejects(read(f, 'file', { commit: f.base, path: 'vendor/README.md' }), 400, /submodule/);
  await rejects(read(f, 'tree', { commit: f.base, path: 'linked' }), 400, /not a directory/);
  await rejects(read(f, 'tree', { commit: f.base, path: 'vendor' }), 400, /not a directory/);
  assert.deepEqual(f.calls.filter(([, oid]) => [f.link, f.escape, f.submodule].includes(oid)), []);
});

test('run repository rejects unsafe paths before any repository read', async () => {
  const f = fixture();
  const unsafe = ['/etc/passwd', '../secret', 'src/../README.md', './README.md', 'src/./index.ts', 'src//index.ts', 'src/', 'src\\index.ts', 'a\u0000b', 'a\nb', 'x'.repeat(256), Array(13).fill('a').join('/')];
  for (const path of unsafe) {
    await rejects(read(f, 'file', { commit: f.base, path }), 400, /segments/);
    await rejects(read(f, 'tree', { commit: f.base, path }), 400, /segments/);
  }
  assert.deepEqual(f.calls, []);
  await rejects(read(f, 'file', { commit: f.base, path: Array(12).fill('a').join('/') }), 404, /does not exist/);
  await rejects(read(f, 'file', { commit: f.base, path: 'missing.txt' }), 404, /does not exist/);
  await rejects(read(f, 'file', { commit: f.base, path: 'README.md/child' }), 404, /does not exist/);
  await rejects(read(f, 'file', { commit: f.base }), 400, /path of a file/);
  await rejects(read(f, 'file', { commit: f.base, path: '' }), 400, /path of a file/);
  await rejects(read(f, 'file', { commit: f.base, path: 'src' }), 400, /directory/);
  await rejects(read(f, 'tree', { commit: f.base, path: 'README.md' }), 400, /not a directory/);
});

test('run repository commits must exist and be the base or a descendant', async () => {
  const f = fixture();
  for (const commit of ['', 'abc', f.base.toUpperCase(), `${f.base}0`, 'g'.repeat(40)]) await rejects(read(f, 'tree', { commit }), 400, /40-character/);
  await rejects(readRunRepository(f.repo, f.base, url('tree', {}), 'tree'), 400, /40-character/);
  assert.deepEqual(f.calls, []);
  await rejects(read(f, 'tree', { commit: hash('missing') }), 404, /not present/);
  await rejects(read(f, 'file', { commit: f.foreign, path: 'README.md' }), 409, /descends/);
  assert.equal((await read(f, 'file', { commit: f.child, path: 'README.md' })).content, '# Changed\n');
  const merge = f.commit(f.root, [f.foreign, f.child], 'merge');
  assert.equal((await read(f, 'tree', { commit: merge })).commit, merge);
});

test('run repository ancestry proof reads at most 500 commits', async () => {
  const f = fixture();
  let tip = f.base;
  for (let i = 0; i < RUN_REPOSITORY_LIMITS.proofCommits - 1; i++) tip = f.commit(f.root, [tip], `step ${i}`);
  const commitReads = () => f.calls.filter(([name]) => name === 'readCommit').length;
  assert.equal((await read(f, 'tree', { commit: tip, limit: 1 })).commit, tip);
  assert.ok(commitReads() <= RUN_REPOSITORY_LIMITS.proofCommits);
  f.calls.length = 0;
  const far = f.commit(f.root, [tip], 'one too far');
  await rejects(read(f, 'tree', { commit: far }), 409, /within 500 commits/);
  assert.ok(commitReads() <= RUN_REPOSITORY_LIMITS.proofCommits, `${commitReads()} commit reads`);
});

test('run repository offset and limit are bounded integers', async () => {
  const f = fixture();
  for (const limit of ['0', '201', 'abc', '1.5', '-1', '1e2', ' 5']) await rejects(read(f, 'tree', { commit: f.base, limit }), 400, /limit/);
  for (const offset of ['-1', '2.5', 'x', '1e3']) await rejects(read(f, 'tree', { commit: f.base, offset }), 400, /offset/);
  assert.deepEqual(f.calls, []);
  assert.equal((await read(f, 'tree', { commit: f.base, limit: 200 })).limit, 200);
  assert.equal((await read(f, 'tree', { commit: f.base, limit: 1, offset: 9 })).entries[0].name, 'vendor');
});

test('run repository reads use only object reads and never mutate work', async () => {
  const f = fixture();
  await read(f, 'tree', { commit: f.child });
  await read(f, 'tree', { commit: f.base, path: 'src' });
  for (const path of ['README.md', 'large.txt', 'logo.png', 'linked', 'vendor']) await read(f, 'file', { commit: f.base, path });
  await rejects(read(f, 'file', { commit: f.foreign, path: 'README.md' }), 409, /descends/);
  assert.deepEqual([...new Set(f.calls.map(([name]) => name))].sort(), ['readBlob', 'readCommit', 'readTree']);
  assert.throws(() => f.repo.createToken, /Unexpected repository access/);
});

// Bounded line pages: start_line and line_limit on file reads.
function textFixture(files) {
  const r = memoryRepo();
  const base = r.commit(r.tree(Object.entries(files).map(([name, content]) => entry(name, r.blob(content), 'blob'))));
  return { ...r, base };
}
const page = (f, path, params) => read(f, 'file', { commit: f.base, path, ...params });
const window = ({ content, start_line, line_limit, total_lines, end_line, has_more, next_line, metadata_only, reason, line_too_large }) =>
  ({ content, start_line, line_limit, total_lines, end_line, has_more, next_line, metadata_only, reason, line_too_large });
const bytes = (text) => Buffer.byteLength(text, 'utf8');
// Follows next_line from line 1 and returns the pages, checking each is complete, bounded and contiguous.
async function collect(f, path, line_limit) {
  const parts = [];
  for (let start = 1; ;) {
    const result = await page(f, path, { start_line: start, line_limit });
    assert.equal(result.metadata_only, false); assert.equal(result.start_line, start);
    assert.ok(bytes(result.content) <= RUN_REPOSITORY_LIMITS.rangeBytes);
    parts.push(result.content);
    if (!result.has_more) { assert.equal(result.next_line, null); return parts; }
    assert.equal(result.next_line, result.end_line + 1); start = result.next_line;
  }
}

test('run repository line pages are contiguous, complete and default to 100 lines', async () => {
  const five = 'one\ntwo\nthree\nfour\nfive\n';
  const f = textFixture({ 'five.txt': five, 'open.txt': 'a\nb', 'blank.txt': '\n\n', 'long.txt': Array.from({ length: 250 }, (_, i) => `line ${i + 1}\n`).join('') });
  const first = await page(f, 'five.txt', { line_limit: 2 });
  assert.deepEqual(window(first), { content: 'one\ntwo\n', start_line: 1, line_limit: 2, total_lines: 5, end_line: 2, has_more: true, next_line: 3, metadata_only: false, reason: null, line_too_large: null });
  assert.equal(first.size, bytes(five), 'size stays the whole file size');
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.deepEqual(window(await page(f, 'five.txt', { start_line: 3, line_limit: 2 })), { ...window(first), content: 'three\nfour\n', start_line: 3, end_line: 4, next_line: 5 });
  assert.deepEqual(window(await page(f, 'five.txt', { start_line: 5, line_limit: 2 })), { ...window(first), content: 'five\n', start_line: 5, end_line: 5, has_more: false, next_line: null });
  assert.equal((await collect(f, 'five.txt', 2)).join(''), five);

  const defaults = await page(f, 'long.txt', { start_line: 1 });
  assert.deepEqual([defaults.line_limit, defaults.end_line, defaults.next_line, defaults.total_lines], [RUN_REPOSITORY_LIMITS.lineDefault, 100, 101, 250]);
  assert.ok(defaults.content.startsWith('line 1\n') && defaults.content.endsWith('line 100\n'));
  const onlyLimit = await page(f, 'long.txt', { line_limit: 200 });
  assert.deepEqual([onlyLimit.start_line, onlyLimit.end_line, onlyLimit.next_line], [1, 200, 201]);
  assert.equal((await page(f, 'long.txt', { start_line: 201, line_limit: 200 })).content.split('\n').length - 1, 50);

  const open = await page(f, 'open.txt', { start_line: 2 });
  assert.deepEqual([open.content, open.total_lines, open.end_line, open.has_more], ['b', 2, 2, false]);
  assert.equal((await page(f, 'five.txt', { start_line: 1 })).total_lines, 5, 'a trailing newline adds no empty line');
  const blank = await page(f, 'blank.txt', { start_line: 2, line_limit: 5 });
  assert.deepEqual([blank.content, blank.total_lines, blank.end_line], ['\n', 2, 2]);
});

test('run repository line pages report empty files and starts beyond EOF without a next page', async () => {
  const f = textFixture({ 'empty.txt': '', 'five.txt': 'one\ntwo\nthree\nfour\nfive\n' });
  const none = { content: '', end_line: null, has_more: false, next_line: null, metadata_only: false, reason: null, line_too_large: null };
  assert.deepEqual(window(await page(f, 'empty.txt', { start_line: 1 })), { ...none, start_line: 1, line_limit: 100, total_lines: 0 });
  assert.deepEqual(window(await page(f, 'empty.txt', { start_line: 7, line_limit: 3 })), { ...none, start_line: 7, line_limit: 3, total_lines: 0 });
  assert.deepEqual(window(await page(f, 'five.txt', { start_line: 6 })), { ...none, start_line: 6, line_limit: 100, total_lines: 5 });
  const far = await page(f, 'five.txt', { start_line: Number.MAX_SAFE_INTEGER, line_limit: 1 });
  assert.deepEqual([far.content, far.has_more, far.next_line, far.total_lines], ['', false, null, 5]);
});

test('run repository line pages round-trip multibyte UTF-8 and CRLF exactly', async () => {
  const mixed = 'café\r\n中文 😀\r\nlone\rreturn\n\r\nééé\r\nlast 😀 no newline';
  const wide = Array.from({ length: 30 }, (_, i) => `${'é'.repeat(998)}${i % 10}\r\n`).join('');
  const f = textFixture({ 'mixed.txt': mixed, 'wide.txt': wide });
  for (const limit of [1, 2, 3, 200]) assert.equal((await collect(f, 'mixed.txt', limit)).join(''), mixed);
  assert.deepEqual((await collect(f, 'mixed.txt', 1)).slice(0, 3), ['café\r\n', '中文 😀\r\n', 'lone\rreturn\n'], 'only LF ends a line');
  assert.equal((await page(f, 'mixed.txt', { start_line: 1 })).total_lines, 6);
  const bom = textFixture({ 'bom.txt': '\ufeffhead\r\nbody\n' });
  assert.deepEqual(await collect(bom, 'bom.txt', 1), ['\ufeffhead\r\n', 'body\n'], 'a leading BOM is kept in range mode');
  assert.equal((await read(bom, 'file', { commit: bom.base, path: 'bom.txt' })).content, 'head\r\nbody\n', 'whole-file decoding is unchanged');

  const pages = await collect(f, 'wide.txt', 200);
  assert.equal(pages.join(''), wide);
  assert.deepEqual(pages.map(bytes), [15992, 15992, 15992, 11994], 'eight 1999-byte lines fit a 16000-byte page');
});

test('run repository line pages end before a line that would pass the byte cap', async () => {
  const cap = RUN_REPOSITORY_LIMITS.rangeBytes;
  assert.equal(cap, 16_000);
  const half = `${'a'.repeat(cap / 2 - 1)}\n`, exact = `${'x'.repeat(cap - 1)}\n`, euro = `${'€'.repeat(5333)}\n`;
  const f = textFixture({ 'halves.txt': half + half + half, 'exact.txt': `${exact}tail\n`, 'euro.txt': `${euro}${euro}` });
  const halves = await page(f, 'halves.txt', { start_line: 1, line_limit: 3 });
  assert.deepEqual([bytes(halves.content), halves.end_line, halves.has_more, halves.next_line], [cap, 2, true, 3]);
  const rest = await page(f, 'halves.txt', { start_line: 3 });
  assert.deepEqual([rest.content, rest.has_more, rest.next_line], [half, false, null]);
  const exactly = await page(f, 'exact.txt', { start_line: 1 });
  assert.deepEqual([exactly.content, exactly.end_line, exactly.next_line, exactly.metadata_only], [exact, 1, 2, false]);
  assert.equal(bytes(euro), cap);
  const euros = await page(f, 'euro.txt', { start_line: 1 });
  assert.deepEqual([euros.content, euros.next_line], [euro, 2]);
});

test('run repository line pages report a first line over the byte cap as metadata only', async () => {
  const cap = RUN_REPOSITORY_LIMITS.rangeBytes, huge = `${'y'.repeat(cap)}\n`, euro = `${'€'.repeat(5334)}\n`;
  const f = textFixture({ 'mixed.txt': `short\n${huge}tail\n`, 'last.txt': `ok\n${'z'.repeat(cap + 1)}`, 'euro.txt': euro });
  const before = await page(f, 'mixed.txt', { start_line: 1, line_limit: 3 });
  assert.deepEqual([before.content, before.end_line, before.has_more, before.next_line], ['short\n', 1, true, 2]);
  const skipped = await page(f, 'mixed.txt', { start_line: 2, line_limit: 3 });
  assert.deepEqual(window(skipped), { content: null, start_line: 2, line_limit: 3, total_lines: 3, end_line: null, has_more: true, next_line: 2, metadata_only: true, reason: 'line_too_large', line_too_large: 2 });
  assert.equal(skipped.size, bytes(`short\n${huge}tail\n`));
  assert.equal((await page(f, 'mixed.txt', { start_line: 3 })).content, 'tail\n', 'a caller may explicitly choose a later line');
  const last = await page(f, 'last.txt', { start_line: 2 });
  assert.deepEqual([last.content, last.metadata_only, last.reason, last.line_too_large, last.has_more, last.next_line], [null, true, 'line_too_large', 2, true, 2]);
  const multibyte = await page(f, 'euro.txt', { line_limit: 1 });
  assert.deepEqual([multibyte.content, multibyte.reason, multibyte.line_too_large, multibyte.next_line], [null, 'line_too_large', 1, 1]);
});

test('run repository rejects invalid line ranges before any repository read', async () => {
  const f = fixture();
  for (const start_line of ['0', '-1', '1.5', 'abc', '', ' 1', '1e2', '0x10', '9007199254740992']) await rejects(read(f, 'file', { commit: f.base, path: 'README.md', start_line }), 400, /start_line/);
  for (const line_limit of ['0', '201', '', 'x', '2.5', '-3', '1e1']) await rejects(read(f, 'file', { commit: f.base, path: 'README.md', line_limit }), 400, /line_limit/);
  await rejects(read(f, 'file', { commit: f.base, path: 'README.md', start_line: '1', line_limit: '500' }), 400, /line_limit/);
  assert.deepEqual(f.calls, []);
  assert.equal((await read(f, 'file', { commit: f.base, path: 'README.md', start_line: '0001', line_limit: '200' })).line_limit, 200);
});

test('run repository range reads keep metadata results honest and old reads unchanged', async () => {
  const f = fixture();
  const legacy = await read(f, 'file', { commit: f.base, path: 'README.md' });
  assert.deepEqual(Object.keys(legacy), ['commit', 'path', 'type', 'oid', 'size', 'content', 'metadata_only', 'reason']);
  const ranged = await read(f, 'file', { commit: f.base, path: 'README.md', start_line: 1 });
  const { start_line, line_limit, total_lines, end_line, has_more, next_line, line_too_large, ...rest } = ranged;
  assert.deepEqual(rest, legacy);
  assert.deepEqual([start_line, line_limit, total_lines, end_line, has_more, next_line, line_too_large], [1, 100, 1, 1, false, null, null]);

  const before = f.bodies();
  const large = await read(f, 'file', { commit: f.base, path: 'large.txt', line_limit: 5 });
  assert.equal(f.bodies(), before, 'oversized content is never downloaded in range mode');
  const unpaged = { content: null, metadata_only: true, start_line: 1, line_limit: 5, total_lines: null, end_line: null, has_more: false, next_line: null, line_too_large: null };
  assert.deepEqual(window(large), { ...unpaged, reason: 'too_large' });
  assert.equal(large.size, 200_001);
  for (const [path, reason] of [['logo.png', 'binary'], ['latin1.txt', 'binary'], ['linked', 'symlink'], ['escape', 'symlink'], ['vendor', 'gitlink']]) {
    assert.deepEqual(window(await read(f, 'file', { commit: f.base, path, line_limit: 5 })), { ...unpaged, reason });
  }
  assert.deepEqual(f.calls.filter(([, oid]) => [f.link, f.escape, f.submodule].includes(oid)), []);
  const limit = await read(f, 'file', { commit: f.base, path: 'limit.txt', start_line: 1 });
  assert.deepEqual([limit.size, limit.content, limit.reason, limit.line_too_large, limit.total_lines, limit.next_line], [200_000, null, 'line_too_large', 1, 1, 1]);

  assert.equal((await read(f, 'tree', { commit: f.base, start_line: 'ignored' })).total, 10, 'tree listings ignore line range parameters');
  assert.deepEqual([...new Set(f.calls.map(([name]) => name))].sort(), ['readBlob', 'readCommit', 'readTree']);
});

test('run file range validation is pure and refuses exactly what a source-file read refuses', async () => {
  const f = fixture();
  const ranged = (params) => url('file', { commit: f.base, path: 'README.md', ...params });
  for (const params of [{}, { start_line: '1' }, { line_limit: '200' }, { start_line: '0001', line_limit: '1' }, { start_line: String(Number.MAX_SAFE_INTEGER) }]) {
    assert.equal(validateRunFileRange(ranged(params)), undefined);
  }
  assert.equal(validateRunFileRange(new URL('https://await.test/source-file?commit=bad&path=../x&limit=0')), undefined, 'only range parameters are checked');
  const invalid = [
    ...['0', '-1', '1.5', 'abc', '', ' 1', '1e2', '0x10', '9007199254740992'].map((start_line) => ({ start_line })),
    ...['0', '201', '', 'x', '2.5', '-3', '1e1'].map((line_limit) => ({ line_limit })),
    { start_line: '1', line_limit: '500' }, { start_line: '0', line_limit: '5' },
  ];
  for (const params of invalid) {
    let thrown;
    assert.throws(() => validateRunFileRange(ranged(params)), (error) => { thrown = error; return error instanceof RunRepositoryError && error.status === 400; });
    assert.match(thrown.message, 'start_line' in params && params.start_line !== '1' ? /start_line/ : /line_limit/);
    await assert.rejects(read(f, 'file', { commit: f.base, path: 'README.md', ...params }), (error) => error instanceof RunRepositoryError && error.status === 400 && error.message === thrown.message);
  }
  assert.deepEqual(f.calls, [], 'validation and refused reads never touch the repository');
});
