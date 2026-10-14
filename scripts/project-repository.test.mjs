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
const { readRunRepository, RunRepositoryError, RUN_REPOSITORY_LIMITS } = await import(join(dir, 'runtime.mjs'));
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
