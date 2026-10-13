import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'await-magic-link-'));
let delivered, failDelivery = false;
const deliveries = [];
let publicSignupFixture;
const signupOpen = process.env.AWAIT_SIGNUP_MODE === 'open';
const gateway = createServer(async (request, response) => {
  if (request.url !== '/send' || request.method !== 'POST' || request.headers.authorization !== 'Bearer test-gateway-secret') {
    response.writeHead(403).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  delivered = JSON.parse(Buffer.concat(chunks).toString());
  deliveries.push(delivered);
  if (failDelivery) { response.writeHead(502).end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const gatewayPort = gateway.address().port;
const reserved = createServer();
await new Promise((resolve) => reserved.listen(0, '127.0.0.1', resolve));
const port = reserved.address().port;
await new Promise((resolve) => reserved.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const config = join(temp, 'wrangler.json');
const state = join(temp, 'state');
const wrangler = join(root, 'node_modules/.bin/wrangler');
await writeFile(config, JSON.stringify({
  name: 'await-magic-link-smoke',
  main: join(root, 'dist/await_chat_app/index.js'),
  compatibility_date: '2026-10-06',
  d1_databases: [{ binding: 'DB', database_name: 'await-chat', database_id: 'f0c7de24-7ff1-409d-be9f-c51386737883', migrations_dir: join(root, 'migrations') }],
  durable_objects: { bindings: [{ name: 'WORKSPACES', class_name: 'Workspace' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Workspace'] }],
  kv_namespaces: [{ binding: 'OAUTH_KV', id: 'c797be545b544fa9acd147f829701ed4' }],
  vars: {
    APP_ORIGIN: origin, WORKSPACE_CREATION: signupOpen ? 'open' : 'invite', BOOTSTRAP_EMAILS: 'magic-test@example.com',
    AUTH_EMAIL_ENABLED: '1', EMAIL_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    EMAIL_GATEWAY_SECRET: 'test-gateway-secret',
  },
}));
const applied = spawnSync(wrangler, ['d1', 'migrations', 'apply', 'await-chat', '--local', '--persist-to', state, '--config', config], { cwd: root, encoding: 'utf8' });
if (applied.status !== 0) throw new Error(`Could not prepare test database: ${applied.stderr || applied.stdout}`);
const worker = spawn(wrangler, ['dev', '--config', config, '--port', String(port), '--persist-to', state, '--local', '--show-interactive-dev-session=false'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let workerOutput = '';
worker.stdout.on('data', (data) => { workerOutput += data.toString(); });
worker.stderr.on('data', (data) => { workerOutput += data.toString(); });

async function waitForWorker() {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (worker.exitCode !== null) throw new Error(`Test Worker stopped before startup: ${workerOutput}`);
    try { if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Test Worker did not start: ${workerOutput}`);
}

async function post(path, body, cookie, headers = {}) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) });
  return { response, data: await response.json() };
}

function tokenFromEmail(expectedEmail = 'magic-test@example.com') {
  assert.equal(delivered?.to, expectedEmail);
  assert.equal(delivered?.subject, 'Sign in to Await');
  const url = delivered.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(url, 'Email must contain a sign-in URL');
  const parsed = new URL(url);
  assert.equal(parsed.origin, origin);
  assert.equal(parsed.pathname, '/signin/verify');
  const token = new URLSearchParams(parsed.hash.slice(1)).get('token');
  assert.match(token, /^[a-f0-9]{64}$/);
  return token;
}

try {
  await waitForWorker();
  const anonymous = await fetch(`${origin}/api/me`);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  const anonymousData = await anonymous.json();
  assert.equal(anonymousData.signup_open, signupOpen);
  assert.equal(anonymousData.can_dev_login, false);
  const malformed = await post('/api/auth/email/start', { email: { invalid: true } });
  assert.equal(malformed.response.status, 400);
  const oversized = await post('/api/auth/email/start', { email: 'x'.repeat(9000) });
  assert.equal(oversized.response.status, 413);
  const crossSite = await post('/api/auth/email/start', { email: 'magic-test@example.com' }, undefined, { origin: 'https://untrusted.example' });
  assert.equal(crossSite.response.status, 403);
  const fetchSite = await post('/api/auth/email/start', { email: 'magic-test@example.com' }, undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(fetchSite.response.status, 403);
  const unknown = await post('/api/auth/email/start', { email: 'new-person@example.com' });
  assert.equal(unknown.response.status, signupOpen ? 200 : 403);
  if (signupOpen) {
    const newSignin = await post('/api/auth/email/consume', { token: tokenFromEmail('new-person@example.com') });
    assert.equal(newSignin.response.status, 200);
    const newCookie = newSignin.response.headers.get('set-cookie').split(';')[0];
    const newMe = await fetch(`${origin}/api/me`, { headers: { cookie: newCookie } });
    const profile = await newMe.json();
    assert.deepEqual(profile.workspaces, [], 'New public accounts inherit no team membership');
    assert.equal(profile.can_create_workspace, true);
    const newWorkspace = await post('/api/workspaces', { name: 'Public signup isolated team' }, newCookie);
    assert.equal(newWorkspace.response.status, 201);
    // Retain only the test fixture identifiers, not sign-in secrets.
    publicSignupFixture = { cookie: newCookie, workspaceId: newWorkspace.data.id };
  }
  const started = await post('/api/auth/email/start', { email: 'magic-test@example.com' });
  assert.equal(started.response.status, 200);
  const firstToken = tokenFromEmail();
  const secondStart = await post('/api/auth/email/start', { email: 'magic-test@example.com' });
  assert.equal(secondStart.response.status, 200);
  const secondToken = tokenFromEmail();
  const old = await post('/api/auth/email/consume', { token: firstToken });
  assert.equal(old.response.status, 401, 'Requesting another link must revoke the old link');
  const signedIn = await post('/api/auth/email/consume', { token: secondToken });
  assert.equal(signedIn.response.status, 200);
  assert.equal(signedIn.data.next, '/');
  const session = signedIn.response.headers.get('set-cookie');
  assert.match(session, /await_session=[^;]+; HttpOnly; SameSite=Lax/);
  const me = await fetch(`${origin}/api/me`, { headers: { cookie: session.split(';')[0] } });
  assert.equal((await me.json()).account.email, 'magic-test@example.com');
  const ownerCookie = session.split(';')[0];
  const badWorkspace = await post('/api/workspaces', { name: { invalid: true } }, ownerCookie);
  assert.equal(badWorkspace.response.status, 400);
  const workspace = await post('/api/workspaces', { name: 'Magic link team' }, ownerCookie);
  assert.equal(workspace.response.status, 201);
  if (signupOpen) {
    const fixture = publicSignupFixture;
    for (const [workspaceId, cookie] of [[workspace.data.id, fixture.cookie], [fixture.workspaceId, ownerCookie]]) {
      const hidden = await fetch(`${origin}/api/workspaces/${workspaceId}/snapshot`, { headers: { cookie } });
      assert.equal(hidden.status, 404, 'Public workspace signup does not grant access to another team');
    }
  }
  const invite = await post(`/api/workspaces/${workspace.data.id}/invites`, {}, ownerCookie);
  assert.equal(invite.response.status, 200);
  const inviteToken = invite.data.url.split('/').at(-1);
  const guestStart = await post('/api/auth/email/start', { email: 'guest@example.com', invite: inviteToken });
  assert.equal(guestStart.response.status, 200);
  const guestToken = tokenFromEmail('guest@example.com');
  const guestSignin = await post('/api/auth/email/consume', { token: guestToken });
  assert.equal(guestSignin.response.status, 200);
  const guestMe = await fetch(`${origin}/api/me`, { headers: { cookie: guestSignin.response.headers.get('set-cookie').split(';')[0] } });
  assert.ok((await guestMe.json()).workspaces.some((item) => item.id === workspace.data.id));
  const reused = await post('/api/auth/email/consume', { token: secondToken });
  assert.equal(reused.response.status, 401, 'A sign-in link must work only once');
  const thirdStart = await post('/api/auth/email/start', { email: 'magic-test@example.com' });
  assert.equal(thirdStart.response.status, 200);
  const limited = await post('/api/auth/email/start', { email: 'magic-test@example.com' });
  assert.equal(limited.response.status, 429, 'Repeated sign-in requests must be rate limited');
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  const raceEmail = signupOpen ? 'concurrent@example.com' : 'magic-test@example.com';
  // A separate bootstrap fixture avoids a used budget in invite-only mode.
  if (!signupOpen) {
    const raced = await Promise.all(Array.from({ length: 8 }, () => post('/api/auth/email/start', { email: 'concurrent@example.com', invite: inviteToken })));
    assert.equal(raced.filter(({ response }) => response.status === 200).length, 3);
    assert.equal(raced.filter(({ response }) => response.status === 429).length, 5);
  } else {
    const before = deliveries.length;
    const raced = await Promise.all(Array.from({ length: 8 }, () => post('/api/auth/email/start', { email: raceEmail })));
    assert.equal(raced.filter(({ response }) => response.status === 200).length, 3);
    assert.equal(raced.filter(({ response }) => response.status === 429).length, 5);
    const tokens = deliveries.slice(before).map((message) => new URLSearchParams(new URL(message.text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get('token'));
    const consumed = await Promise.all(tokens.map((token) => post('/api/auth/email/consume', { token })));
    assert.equal(consumed.filter(({ response }) => response.status === 200).length, 1, 'Concurrent link requests leave only one valid link');
  }
  failDelivery = true;
  for (let index = 0; index < 3; index++) {
    const failed = await post('/api/auth/email/start', { email: 'delivery-failure@example.com', invite: inviteToken });
    assert.equal(failed.response.status, 502);
  }
  const failedLimit = await post('/api/auth/email/start', { email: 'delivery-failure@example.com', invite: inviteToken });
  assert.equal(failedLimit.response.status, 429, 'Failed sends remain rate limited');
  failDelivery = false;
  const workspaceRace = await Promise.all(Array.from({ length: 12 }, (_, index) => post('/api/workspaces', { name: `Quota test ${index}` }, ownerCookie)));
  assert.equal(workspaceRace.filter(({ response }) => response.status === 201).length, 9, 'Ten creations per account per day, including the first workspace');
  assert.equal(workspaceRace.filter(({ response }) => response.status === 429).length, 3);
  console.log(`Magic links, input bounds, origin checks, concurrent limits, failed sends, creation quotas, invites, and ${signupOpen ? 'open signup isolation' : 'invite-only registration'} passed.`);
} finally {
  worker.kill('SIGTERM');
  gateway.close();
  await rm(temp, { recursive: true, force: true });
}
