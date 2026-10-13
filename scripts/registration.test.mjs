import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'await-registration-test-'));
const compiled = await build({ stdin: { contents: "export { default as worker } from './src/worker/index'; export { reserveRequests } from './src/worker/request-controls';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'test-worker-host', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'base', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {} export class WorkerEntrypoint {}' }));
    builder.onResolve({ filter: /(?:virtual:await-workspace-widget|\.html\?raw)$/ }, () => ({ path: 'widget', namespace: 'widget' }));
    builder.onLoad({ filter: /.*/, namespace: 'widget' }, () => ({ contents: 'export default "<html></html>";' }));
  } }] });
await writeFile(join(directory, 'worker.mjs'), compiled.outputFiles[0].contents);
const { worker, reserveRequests } = await import(join(directory, 'worker.mjs'));
await rm(directory, { recursive: true, force: true });
const migrations = await Promise.all((await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort().map((name) => readFile(join('migrations', name), 'utf8')));
const realFetch = globalThis.fetch;

function fixture(mode = 'invite') {
  const database = new DatabaseSync(':memory:');
  for (const migration of migrations) database.exec(migration);
  const prepare = (query) => {
    let params = [];
    return { bind(...values) { params = values; return this; },
      first: async () => database.prepare(query).get(...params) ?? null,
      all: async () => ({ results: database.prepare(query).all(...params) }),
      run: async () => database.prepare(query).run(...params),
      execute: () => {
        const results = database.prepare(query).all(...params);
        return { results, meta: { changes: database.prepare('SELECT changes() AS changes').get().changes } };
      },
    };
  };
  const DB = { prepare, batch: async (statements) => {
    database.exec('BEGIN');
    try { const results = statements.map((statement) => statement.execute()); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  let profile = { email: 'new@example.com', email_verified: true, name: 'New person' }, upstreamCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    upstreamCalls++;
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fake-test-access-token' });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json(profile);
    throw new Error('Unexpected upstream URL');
  };
  const env = { DB, OAUTH_KV: {}, WORKSPACE_CREATION: mode, APP_ORIGIN: 'https://await.chat', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'fake-test-secret',
    WORKSPACES: { idFromName: (id) => id, get: () => ({ fetch: async (request) => {
      if (new URL(request.url).pathname === '/snapshot') return Response.json({ channels: [{ id: 'general', name: 'general', is_private: 0, is_dm: 0 }] });
      return Response.json({ ok: true });
    } }) },
  };
  const send = (path, cookie) => worker.fetch(new Request(`https://await.chat${path}`, { headers: cookie ? { cookie } : {} }), env, { waitUntil() {} });
  const start = async (query = '') => {
    const response = await send(`/api/auth/google/start${query}`);
    assert.equal(response.status, 302);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax;.*Secure/);
    return { cookie: response.headers.get('set-cookie').split(';')[0], state: new URL(response.headers.get('location')).searchParams.get('state') };
  };
  const callback = ({ cookie, state }) => send(`/api/auth/google/callback?code=test-code&state=${state}`, cookie);
  return { database, DB, env, send, start, callback, profile: (value) => { profile = value; }, get upstreamCalls() { return upstreamCalls; },
    dispose() { database.close(); globalThis.fetch = realFetch; } };
}

test('request budgets stay atomic, saturate, and reset after expiry', async () => {
  const f = fixture();
  try {
    const budget = [{ key: 'test', maximum: 3, windowMs: 1000 }];
    const attempts = await Promise.all(Array.from({ length: 20 }, () => reserveRequests(f.DB, budget, 10000)));
    assert.equal(attempts.filter((attempt) => attempt.allowed).length, 3);
    assert.equal(f.database.prepare('SELECT used FROM request_limits').get().used, 4);
    assert.equal(attempts.at(-1).retryAfter, 1);
    assert.equal((await reserveRequests(f.DB, budget, 11000)).allowed, true);
    assert.equal(f.database.prepare('SELECT used FROM request_limits').get().used, 1);
  } finally { f.dispose(); }
});

test('Google requires the originating browser, consumes state once, and enforces invite-only registration', async () => {
  const f = fixture();
  try {
    const started = await f.start();
    const missing = await f.callback({ ...started, cookie: undefined });
    assert.equal(new URL(missing.headers.get('location'), f.env.APP_ORIGIN).searchParams.get('error'), 'state');
    assert.equal(f.upstreamCalls, 0);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM oauth_states').get().n, 1);
    const denied = await f.callback(started);
    assert.equal(new URL(denied.headers.get('location'), f.env.APP_ORIGIN).searchParams.get('error'), 'Use a team invitation to join Await.');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
    const replay = await f.callback(started);
    assert.equal(new URL(replay.headers.get('location'), f.env.APP_ORIGIN).searchParams.get('error'), 'state');
    assert.equal(f.upstreamCalls, 2);
  } finally { f.dispose(); }
});

test('open Google registration creates an isolated verified account, and concurrent callbacks create one session', async () => {
  const f = fixture('open');
  try {
    const started = await f.start();
    const responses = await Promise.all([f.callback(started), f.callback(started)]);
    const signedIn = responses.find((response) => /await_session=/.test(response.headers.get('set-cookie') ?? ''));
    assert.ok(signedIn);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM accounts').get().n, 1);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
    const me = await f.send('/api/me', signedIn.headers.get('set-cookie').match(/await_session=[^;,]+/)[0]);
    const data = await me.json();
    assert.equal(data.account.email, 'new@example.com');
    assert.equal(data.can_create_workspace, true);
    assert.deepEqual(data.workspaces, []);
  } finally { f.dispose(); }
});

test('an unverified Google email cannot register even with open signup', async () => {
  const f = fixture('open');
  try {
    f.profile({ email: 'new@example.com', email_verified: false });
    const response = await f.callback(await f.start());
    assert.match(response.headers.get('location'), /error=/);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  } finally { f.dispose(); }
});

test('Google sign-in with a valid invite joins only the invited workspace', async () => {
  const f = fixture();
  try {
    const owner = 'owner';
    f.database.prepare("INSERT INTO accounts (id, kind, name, email, created_at) VALUES (?, 'human', 'Owner', 'owner@example.com', ?)").run(owner, Date.now());
    for (const workspace of ['invited-team', 'other-team']) f.database.prepare('INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(workspace, workspace, workspace, owner, Date.now());
    const token = 'test-invite-token-123456789';
    const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
    f.database.prepare('INSERT INTO invites (token_hash, workspace_id, created_by, expires_at, uses_left) VALUES (?, ?, ?, ?, 1)').run(tokenHash, 'invited-team', owner, Date.now() + 600000);
    const signedIn = await f.callback(await f.start(`?invite=${token}`));
    assert.match(signedIn.headers.get('set-cookie'), /await_session=/);
    const memberships = f.database.prepare('SELECT workspace_id, role FROM workspace_members').all();
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].workspace_id, 'invited-team');
    assert.equal(memberships[0].role, 'member');
    assert.equal(f.database.prepare('SELECT uses_left FROM invites').get().uses_left, 0);
  } finally { f.dispose(); }
});
