import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'await-event-tests-'));
const compiled = await build({ stdin: { contents: `export { Computer } from './execution-service/index'; export { Workspace } from './src/object/workspace'; export { handleMcp } from './src/worker/mcp'; export * from './src/shared/mcp-events'; export * from './src/shared/json'; export * from './src/app/eventStatus'; export * from './src/shared/workspace-library'; export * from './src/worker/artifacts'; export * from './src/worker/event-webhooks';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'worker-test-host', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'worker-base', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' }));
    builder.onResolve({ filter: /(?:virtual:await-workspace-widget|\.html\?raw)$/ }, () => ({ path: 'widget', namespace: 'widget' }));
    builder.onLoad({ filter: /.*/, namespace: 'widget' }, () => ({ contents: 'export default "<html></html>";' }));
  } }] });
await writeFile(join(dir, 'runtime.mjs'), compiled.outputFiles[0].contents);
const { Computer, Workspace, handleMcp, eventWatchStatus, workLinks, artifactName, artifactContents, artifactFile, artifactPath, eventDefinitions, parseEventArguments, canonicalJson, signWebhook, decryptSecret } = await import(join(dir, 'runtime.mjs'));
await rm(dir, { recursive: true, force: true });
globalThis.WebSocketRequestResponsePair = class {};

const secret = `whsec_${Buffer.alloc(32, 42).toString('base64')}`;
const newSecret = `whsec_${Buffer.alloc(32, 43).toString('base64')}`;
const realFetch = globalThis.fetch;

function fixture() {
  const database = new DatabaseSync(':memory:');
  let savepoint = 0, alarm = null;
  const promises = [], values = new Map();
  const sql = { exec: (query, ...params) => database.prepare(query).all(...params) };
  const ctx = { blockConcurrencyWhile: (fn) => promises.push(fn()), storage: { sql, get: async key => values.get(key), put: async (key,value) => values.set(key,value), transactionSync: (fn) => {
    const name = `s${savepoint++}`; database.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); database.exec(`RELEASE ${name}`); return result; }
    catch (error) { database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }, getAlarm: async () => alarm, setAlarm: async (value) => { alarm = value; }, deleteAlarm: async () => { alarm = null; } },
  waitUntil: (promise) => promises.push(promise), getWebSockets: () => [], setWebSocketAutoResponse: () => {} };
  const calls = [];
  const grants = new Map();
  let authVersion = 0, readAccess = true, callback = () => ({ status: 204, body: '' });
  const env = { APP_ORIGIN: 'https://await.chat', EMAIL_ENABLED: '0', MCP_EVENT_KEY: Buffer.alloc(32, 9).toString('base64'),
    MCP_WEBHOOK_GATEWAY_URL: 'https://gateway.example.com/deliver', MCP_WEBHOOK_GATEWAY_TOKEN: 'gateway-auth-token-for-testing-only',
    DB: { prepare: (query) => ({ bind: (...params) => ({ first: async () => {
      if (query.includes('SELECT a.auth_version')) return { auth_version: authVersion };
      if (query.includes('SELECT scopes FROM agent_tokens')) return readAccess ? { scopes: 'read post files' } : null;
      return null;
    } }) }) }, OAUTH_KV: { get: async (key) => grants.get(key) ?? null }, FILES: { delete: async () => {} },
  };
  globalThis.fetch = async (url, options) => {
    const request = url instanceof Request ? url : new Request(url, options);
    assert.equal(request.url, env.MCP_WEBHOOK_GATEWAY_URL);
    assert.equal(request.redirect, 'manual'); // Workers does not implement redirect: 'error'.
    assert.equal(request.headers.get('authorization'), `Bearer ${env.MCP_WEBHOOK_GATEWAY_TOKEN}`);
    const input = JSON.parse(await request.text());
    calls.push(input);
    const body = JSON.parse(input.body);
    if (body.type === 'verification') return Response.json({ status: 200, body: JSON.stringify({ challenge: body.challenge }) });
    return Response.json(await callback(input));
  };
  let workspace = new Workspace(ctx, env);
  sql.exec("INSERT INTO meta (key, value) VALUES ('workspace_id', 'w')");
  for (const [id, kind, role] of [['alice', 'human', 'owner'], ['bob', 'human', 'member'], ['watcher', 'agent', 'member'], ['other-agent', 'agent', 'member']]) {
    sql.exec("INSERT INTO members (account_id, name, kind, role, owner_id) VALUES (?, ?, ?, ?, 'alice')", id, id, kind, role);
  }
  for (const id of ['c', 'other-channel']) sql.exec("INSERT INTO channels (id, name, created_by, created_at) VALUES (?, ?, 'alice', ?)", id, id, Date.now());
  for (const id of ['alice', 'bob', 'watcher', 'other-agent']) sql.exec('INSERT INTO channel_members (channel_id, account_id) VALUES (?, ?)', 'c', id);
  const authority = { accountId: 'watcher', workspaceId: 'w', authVersion: 0, credential: { kind: 'bearer', tokenHash: 'watcher-hash' } };
  const params = (url = 'https://receiver.example.com/watch', name = 'message.created', args = { channel_id: 'c' }) => ({ name, arguments: args, delivery: { mode: 'webhook', url, secret }, cursor: null });
  const settle = async () => { while (promises.length) await Promise.all(promises.splice(0)); };
  const inside = async (_env, _workspace, accountId, path, init = {}) => workspace.fetch(new Request(`https://workspace.internal${path}`, { ...init, headers: { ...init.headers, 'x-account-id': accountId, 'x-workspace-id': 'w' } }));
  const rpc = async (method, value, actor = { accountId: 'watcher', workspaceId: 'w', scopes: ['read', 'post'], eventAuthority: authority }, headers = {}) => {
    const response = await handleMcp(env, new Request('https://await.chat/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: value }) }), inside, actor, ctx);
    await settle(); return response.json();
  };
  const post = async (actor, body, clientId, threadId) => {
    const response = await inside(env, 'w', actor, '/channels/c/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, client_id: clientId, thread_id: threadId }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); await settle(); return result;
  };
  const flush = async () => { sql.exec('UPDATE event_deliveries SET next_attempt_at = ?', Date.now() - 1); await workspace.alarm(); await settle(); };
  return { sql, env, ctx, authority, params, rpc, post, inside, flush, calls, grants, settle,
    get workspace() { return workspace; }, restart: () => { workspace = new Workspace(ctx, env); },
    callback: (fn) => { callback = fn; }, version: (n) => { authVersion = n; }, readAccess: (allowed) => { readAccess = allowed; },
    dispose: async () => { await settle(); database.close(); globalThis.fetch = realFetch; },
  };
}

test('workspace-wide agent access covers current and future private channels, excludes DMs, and revokes only automatic membership', async () => {
  const f = fixture();
  try {
    const change = (actor, value) => f.inside(f.env, 'w', actor, '/members/channel-access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'watcher', all_channels: value }) });
    f.sql.exec("UPDATE channels SET is_private=1 WHERE id='other-channel'");
    f.sql.exec("INSERT INTO channels(id,name,is_dm,created_by,created_at) VALUES ('dm','dm',1,'alice',?)", Date.now());
    f.sql.exec("INSERT INTO channels(id,name,archived_at,created_by,created_at) VALUES ('old','old',?,'alice',?)", Date.now(), Date.now());
    assert.equal((await change('bob', true)).status, 403);
    assert.equal((await change('watcher', true)).status, 403);
    assert.equal((await change('alice', true)).status, 200);
    assert.equal(f.workspace.member('watcher').all_channels, 1);
    const joined = () => f.sql.exec("SELECT channel_id FROM channel_members WHERE account_id='watcher' ORDER BY channel_id").map(row => row.channel_id);
    assert.deepEqual(joined(), ['c', 'other-channel']);
    f.sql.exec("INSERT INTO channels(id,name,is_private,created_by,created_at) VALUES ('future','future',1,'alice',?)", Date.now());
    f.sql.exec("INSERT INTO channel_members(channel_id,account_id) VALUES ('future','alice')");
    f.restart();
    assert.deepEqual(joined(), ['c', 'future', 'other-channel']);
    const read = await f.inside(f.env, 'w', 'watcher', '/channels/future/messages');
    assert.equal(read.status, 200);
    assert.notEqual((await f.inside(f.env, 'w', 'watcher', '/channels/dm/messages')).status, 200);
    // An explicit invitation must survive removal of the broader grant.
    assert.equal((await f.inside(f.env, 'w', 'alice', '/channels/future/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'watcher' }) })).status, 200);
    assert.equal((await change('alice', false)).status, 200);
    assert.deepEqual(joined(), ['c', 'future']);
    assert.equal(f.workspace.member('watcher').all_channels, 0);
    assert.notEqual((await f.inside(f.env, 'w', 'watcher', '/channels/other-channel/messages')).status, 200);
    f.sql.exec("INSERT INTO channels(id,name,created_by,created_at) VALUES ('later','later','alice',?)", Date.now());
    assert.deepEqual(joined(), ['c', 'future']);
  } finally { await f.dispose(); }
});

test('all-channel native watches include future mentions, exclude DMs and self, and stop queued delivery on revocation', async () => {
  const f = fixture();
  try {
    const p = f.params(undefined, 'message.mentioned', { channel_id: '*', include_agent_authors: true });
    assert.ok((await f.rpc('events/subscribe', p)).error, 'Selected-channel agents cannot request a wildcard');
    const change = value => f.inside(f.env, 'w', 'alice', '/members/channel-access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'watcher', all_channels: value }) });
    await change(true);
    const subscription = await f.rpc('events/subscribe', p);
    assert.ok(subscription.result?.id, JSON.stringify(subscription));
    assert.ok((await f.rpc('events/subscribe', f.params(undefined, 'message.created', { channel_id: '*', thread_id: 'missing' }))).error);
    f.sql.exec("INSERT INTO channels(id,name,is_private,created_by,created_at) VALUES ('future','future',1,'alice',?)", Date.now());
    f.sql.exec("INSERT INTO channel_members(channel_id,account_id) VALUES ('future','alice')");
    f.sql.exec("INSERT INTO channels(id,name,is_dm,created_by,created_at) VALUES ('dm','dm',1,'alice',?)", Date.now());
    for (const id of ['alice', 'watcher']) f.sql.exec("INSERT INTO channel_members(channel_id,account_id) VALUES ('dm',?)", id);
    const send = async (channel, actor, body) => {
      const response = await f.inside(f.env, 'w', actor, `/channels/${channel}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
      assert.equal(response.status, 200, JSON.stringify(await response.json())); await f.settle();
    };
    await send('dm', 'alice', 'Private mention <@watcher>');
    await send('c', 'watcher', 'Own mention <@watcher>');
    await send('c', 'alice', 'No mention');
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
    await send('future', 'alice', 'Future private mention <@watcher>');
    await send('c', 'other-agent', 'Agent handoff <@watcher>');
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 2);
    await f.flush(); await f.flush();
    assert.equal(f.calls.filter(call => JSON.parse(call.body).eventId).length, 2);
    await send('future', 'alice', 'Queued mention <@watcher>');
    await change(false); await f.flush();
    assert.equal(f.calls.filter(call => JSON.parse(call.body).eventId).length, 2);
    assert.equal(f.sql.exec('SELECT active FROM event_subscriptions WHERE id=?', subscription.result.id)[0].active, 0);
  } finally { await f.dispose(); }
});

test('legacy image attachments preview in messages, threads, metadata and the file picker', async () => {
  const f = fixture();
  try {
    const register = await f.inside(f.env, 'w', 'alice', '/channels/c/attachments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'legacy-image', kind: 'file', mime: 'Image/PNG; charset=binary', r2_key: 'image-key', size: 69, filename: 'download.png' }) });
    assert.ok(register.ok);
    assert.equal(f.sql.exec('SELECT kind FROM attachments WHERE id = ?', 'legacy-image')[0].kind, 'image');
    // Reproduce the metadata stored by MCP before image classification was fixed.
    f.sql.exec("UPDATE attachments SET kind = 'file' WHERE id = ?", 'legacy-image');
    const posted = await f.inside(f.env, 'w', 'alice', '/channels/c/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Shared download.png', attachment_ids: ['legacy-image'] }) });
    const message = await posted.json();
    assert.ok(posted.ok, JSON.stringify(message));
    assert.equal(message.attachments[0].kind, 'image');
    for (const path of ['/channels/c/messages', `/channels/c/messages?thread=${message.id}`]) {
      const messages = await (await f.inside(f.env, 'w', 'bob', path)).json();
      assert.equal(messages.find((item) => item.id === message.id).attachments[0].kind, 'image');
    }
    assert.equal((await (await f.inside(f.env, 'w', 'bob', '/attachments/legacy-image')).json()).kind, 'image');
    const files = await (await f.inside(f.env, 'w', 'bob', '/attachments/library?q=download.png')).json();
    assert.equal(files[0].kind, 'image');
  } finally { await f.dispose(); }
});

test('MCP 2 discovery and envelopes coexist with existing tool clients', async () => {
  const f = fixture();
  try {
    const discovery = await f.rpc('server/discover');
    assert.equal(discovery.result.resultType, 'complete'); assert.deepEqual(discovery.result.capabilities.events, {});
    assert.equal(discovery.result._meta['io.modelcontextprotocol/serverInfo'].name, 'await.chat');
    assert.ok((await f.rpc('tools/list')).result.tools.some((tool) => tool.name === 'post_message'));
    assert.equal((await f.rpc('events/list')).result.events.length, 10);
    assert.equal((await f.rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } })).error.code, -32020);
    assert.equal((await f.rpc('tools/list', {}, undefined, { 'Mcp-Method': 'events/list' })).error.code, -32020);
    assert.equal((await f.rpc('tools/list', {}, undefined, { 'MCP-Protocol-Version': '2099-01-01' })).error.code, -32022);
    const legacy = await f.rpc('initialize', {}, undefined, { 'MCP-Protocol-Version': '2025-06-18' });
    assert.equal(legacy.result.protocolVersion, '2025-06-18'); assert.equal(legacy.result.resultType, undefined);
  } finally { await f.dispose(); }
});

test('OAuth scope discovery and upgrade challenges protect writes before execution', async () => {
  const f = fixture();
  try {
    const { result: { tools } } = await f.rpc('tools/list');
    for (const [name, scopes] of [
      ['read_messages', ['read']], ['get_live_ticket', ['read']],
      ['post_message', ['read', 'post']], ['create_document', ['read', 'post']],
      ['post_file', ['read', 'post', 'files']], ['get_file', ['read', 'files']],
    ]) {
      const tool = tools.find((tool) => tool.name === name);
      assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes }]);
      assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
    }
    const readOnly = { accountId: 'watcher', workspaceId: 'w', scopes: ['read'], eventAuthority: f.authority };
    const args = { channel_id: 'c', title: 'OAuth write check', body: 'Requires consent' };
    const blocked = await f.rpc('tools/call', { name: 'create_document', arguments: args }, readOnly);
    assert.equal(blocked.result.isError, true);
    const challenge = blocked.result._meta['mcp/www_authenticate'][0];
    assert.match(challenge, /error="insufficient_scope"/);
    assert.match(challenge, /scope="read post"/);
    assert.match(challenge, /resource_metadata="https:\/\/await.chat\/\.well-known\/oauth-protected-resource\/mcp"/);
    const transport = await handleMcp(f.env, new Request('https://await.chat/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'create_document', arguments: args } }),
    }), f.inside, readOnly, f.ctx);
    assert.equal(transport.status, 403);
    assert.equal(transport.headers.get('WWW-Authenticate'), challenge);
    assert.equal(transport.headers.get('Cache-Control'), 'no-store');
    assert.equal((await transport.json()).result.isError, true);
    assert.equal(f.sql.exec('SELECT * FROM documents').length, 0);
    const allowed = await f.rpc('tools/call', { name: 'create_document', arguments: args });
    assert.ok(!allowed.result.isError, JSON.stringify(allowed));
    assert.equal(f.sql.exec('SELECT * FROM documents').length, 1);
    const file = await f.rpc('tools/call', { name: 'post_file', arguments: {} });
    assert.equal(file.result.isError, true);
    assert.match(file.result._meta['mcp/www_authenticate'][0], /scope="read post files"/);
    // Monitoring needs read access and a named identity; writing is a separate grant.
    const watch = await f.rpc('events/subscribe', f.params(), readOnly);
    assert.ok(watch.result.id, JSON.stringify(watch));
  } finally { await f.dispose(); }
});

test('callback verification, deterministic identity, encrypted keys and rotation', async () => {
  const f = fixture();
  try {
    const p = f.params(undefined, 'message.created', { channel_id: 'c', include_agent_authors: true });
    const first = await f.rpc('events/subscribe', p); assert.ok(first.result, JSON.stringify(first));
    const id = first.result.id; assert.equal(first.result.cursor, null);
    const verification = f.calls[0];
    const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${verification.headers['webhook-id']}.${verification.headers['webhook-timestamp']}.${verification.body}`).digest('base64');
    assert.equal(verification.headers['webhook-signature'], `v1,${expected}`);
    const verifiedAt = Date.now() - 299000;
    f.sql.exec('UPDATE event_subscriptions SET verified_at = ?', verifiedAt);
    const second = await f.rpc('events/subscribe', { ...p, arguments: { include_agent_authors: true, channel_id: 'c' }, ttlMs: 120000 });
    assert.equal(second.result.id, id); assert.equal(f.calls.length, 1);
    assert.equal(f.sql.exec('SELECT verified_at FROM event_subscriptions')[0].verified_at, verifiedAt);
    const encrypted = f.sql.exec('SELECT secret FROM event_subscriptions')[0].secret;
    assert.notEqual(encrypted, secret); assert.equal(await decryptSecret(f.env, id, encrypted), secret);
    await f.rpc('events/subscribe', { ...p, delivery: { ...p.delivery, secret: newSecret } });
    assert.equal(f.calls.length, 2);
    await f.post('alice', 'Rotate test', 'rotate'); await f.flush();
    const signatures = f.calls.at(-1).headers['webhook-signature'].split(' '); assert.equal(signatures.length, 2);
    for (const key of [secret, newSecret]) assert.ok(signatures.includes(await signWebhook(key, f.calls.at(-1).headers['webhook-id'], f.calls.at(-1).headers['webhook-timestamp'], f.calls.at(-1).body)));
    const list = f.workspace.notifications.watches.list(f.workspace.member('alice'));
    assert.equal(JSON.stringify(list).includes('whsec_'), false); assert.equal(JSON.stringify(list).includes('/watch'), false);
  } finally { await f.dispose(); }
});

test('filters reject inaccessible resources before any callback; TTL and cursor are explicit', async () => {
  const f = fixture();
  try {
    for (const args of [{ channel_id: 'other-channel' }, { channel_id: 'c', thread_id: 'missing' }, { channel_id: 'c', unsupported: true }]) assert.ok((await f.rpc('events/subscribe', f.params(undefined, 'message.created', args))).error);
    assert.equal(f.calls.length, 0);
    assert.ok((await f.rpc('events/subscribe', { ...f.params(), cursor: 'old-position' })).error);
    assert.ok((await f.rpc('events/subscribe', { ...f.params(), ttlMs: -1 })).error);
    const subscribed = await f.rpc('events/subscribe', { ...f.params(), ttlMs: null });
    assert.ok(subscribed.result.refreshBefore); // Infinite watches are not granted.
    const badSecret = await f.rpc('events/subscribe', { ...f.params('https://receiver.example.com/bad'), delivery: { ...f.params().delivery, secret: 'whsec_bad' } });
    assert.equal(badSecret.error.code, -32602);
  } finally { await f.dispose(); }
});

test('background subscriptions require a named agent and encrypted keys survive operator rotation', async () => {
  const f = fixture();
  try {
    const authority = { ...f.authority, accountId: 'alice' };
    const human = await f.rpc('events/subscribe', f.params(), { accountId: 'alice', workspaceId: 'w', scopes: ['read'], eventAuthority: authority });
    assert.equal(human.error.code, -32012); assert.match(human.error.message, /named Await agent/); assert.equal(f.calls.length, 0);
    const subscribed = await f.rpc('events/subscribe', f.params());
    f.env.MCP_EVENT_PREVIOUS_KEY = f.env.MCP_EVENT_KEY;
    f.env.MCP_EVENT_KEY = Buffer.alloc(32, 10).toString('base64');
    f.restart(); await f.post('alice', 'Old encrypted key', 'old-key'); await f.flush();
    assert.equal(f.calls.length, 2);
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
    await f.rpc('events/subscribe', f.params());
    delete f.env.MCP_EVENT_PREVIOUS_KEY;
    await f.post('alice', 'Refreshed encrypted key', 'new-key'); await f.flush();
    assert.equal(f.calls.length, 3);
    assert.ok(f.workspace.notifications.watches.list(f.workspace.member('alice')).find((row) => row.id === subscribed.result.id).active);
  } finally { await f.dispose(); }
});

test('message fanout excludes self and agents, matches mentions, and deduplicates retried posts', async () => {
  const f = fixture();
  try {
    await f.rpc('events/subscribe', f.params());
    await f.rpc('events/subscribe', f.params('https://receiver.example.com/mentions', 'message.mentioned'));
    await f.post('watcher', 'Own output', 'own'); await f.post('other-agent', 'Other agent', 'other');
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
    const posted = await f.post('alice', 'Please help <@watcher>', 'human');
    assert.equal((await f.post('alice', 'Please help <@watcher>', 'human')).id, posted.id);
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 2);
    f.restart(); await f.flush();
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
    const events = f.calls.filter((call) => JSON.parse(call.body).eventId).map((call) => JSON.parse(call.body));
    assert.deepEqual(events.map((event) => event.name).sort(), ['message.created', 'message.mentioned']);
    assert.equal(events[0].data.actor_name, 'alice'); assert.equal(events[0].data.message_id, posted.id);
    assert.ok(events[0].data.url.includes('?thread='));
  } finally { await f.dispose(); }
});

test('delivery receipts correlate accepted and retried events without exposing content or callback credentials', async () => {
  const f = fixture();
  try {
    const subscribed = await f.rpc('events/subscribe', f.params());
    const list = async (viewer = 'alice', suffix = '') => {
      const response = await f.inside(f.env, 'w', viewer, `/event-subscriptions${suffix}`);
      return { status: response.status, value: await response.json() };
    };
    assert.deepEqual((await list()).value.subscriptions[0].receipts, [], 'Verification is not an application delivery');
    f.callback(() => ({ status: 503, body: 'Never persist receiver secret or diagnostics' }));
    const root = await f.post('bob', 'Private message contents stay out of receipts', 'receipt-root');
    await f.flush();
    let receipt = (await list()).value.subscriptions[0].receipts[0];
    const eventId = f.calls.find((call) => JSON.parse(call.body).name === 'message.created').headers['webhook-id'];
    assert.equal(receipt.event_id, eventId); assert.equal(receipt.message_id, root.id);
    assert.equal(receipt.http_status, 503); assert.equal(receipt.outcome, 'retrying'); assert.equal(receipt.attempts, 1);
    f.callback(() => ({ status: 202, body: `Never persist ${secret}` }));
    await f.flush();
    const visible = (await list()).value;
    assert.equal(visible.subscriptions[0].receipts.length, 1);
    receipt = visible.subscriptions[0].receipts[0];
    assert.equal(receipt.event_id, eventId); assert.equal(receipt.http_status, 202);
    assert.equal(receipt.outcome, 'accepted'); assert.equal(receipt.attempts, 2); assert.ok(receipt.payload_bytes > 0);
    for (const hidden of [secret, 'Never persist', root.body, '/watch']) assert.equal(JSON.stringify(visible).includes(hidden), false);
    assert.deepEqual((await list('bob')).value.subscriptions, []);
    assert.notEqual((await list('bob', '?account_id=watcher')).status, 200);
    f.restart(); assert.equal((await list()).value.subscriptions[0].receipts[0].event_id, eventId);
    assert.equal(f.sql.exec('SELECT count(*) AS n FROM event_deliveries')[0].n, 0);
    assert.equal(subscribed.result.id, visible.subscriptions[0].id);
  } finally { await f.dispose(); }
});

test('delivery receipts retain ten events, expire, and migrate atomically without resetting watches', async () => {
  const f = fixture();
  try {
    const subscribed = await f.rpc('events/subscribe', f.params());
    f.sql.exec('DROP TABLE event_receipts');
    f.sql.exec("UPDATE meta SET value='7' WHERE key='schema_version'");
    const exec = f.ctx.storage.sql.exec;
    f.ctx.storage.sql.exec = (query, ...params) => {
      if (query.startsWith('CREATE INDEX IF NOT EXISTS event_receipts_expiry')) throw new Error('receipt migration failure');
      return exec(query, ...params);
    };
    assert.throws(() => f.restart(), /receipt migration failure/);
    f.ctx.storage.sql.exec = exec;
    assert.equal(f.sql.exec("SELECT value FROM meta WHERE key='schema_version'")[0].value, '7');
    assert.equal(f.sql.exec("SELECT name FROM sqlite_master WHERE name='event_receipts'").length, 0);
    f.restart();
    assert.equal(f.sql.exec("SELECT value FROM meta WHERE key='schema_version'")[0].value, '17');
    assert.equal(f.sql.exec('SELECT id, active FROM event_subscriptions')[0].id, subscribed.result.id);
    assert.equal(f.sql.exec('SELECT active FROM event_subscriptions')[0].active, 1);
    for (let index = 0; index < 12; index++) { await f.post('bob', `Receipt event ${index}`, `bounded-receipt-${index}`); await f.flush(); }
    assert.equal(f.sql.exec('SELECT count(*) AS n FROM event_receipts')[0].n, 10);
    const firstEvent = f.calls.find((call) => JSON.parse(call.body).name === 'message.created').headers['webhook-id'];
    assert.equal(f.sql.exec('SELECT event_id FROM event_receipts WHERE event_id=?', firstEvent).length, 0);
    f.sql.exec('UPDATE event_receipts SET attempted_at=?', Date.now() - 7 * 86400000);
    await f.flush();
    assert.equal(f.sql.exec('SELECT count(*) AS n FROM event_receipts')[0].n, 0);
  } finally { await f.dispose(); }
});

test('edited mentions wake once with current text and unchanged saves stay quiet', async () => {
  const f = fixture();
  const edit = (id, body, actor = 'alice') => f.inside(f.env, 'w', actor, `/messages/${id}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
  try {
    await f.rpc('events/subscribe', f.params('https://receiver.example.com/mentions', 'message.mentioned'));
    await f.rpc('events/subscribe', f.params('https://receiver.example.com/edits', 'message.updated'));
    await f.inside(f.env, 'w', 'alice', '/agents/watcher/listening/c', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'mentions', include_agent_authors: false }) });
    const root = await f.post('alice', 'Draft request', 'edit-mention-root');
    const reply = await f.post('alice', 'Follow up', 'edit-mention-reply', root.id);
    assert.ok((await edit(reply.id, 'Please investigate <@watcher>')).ok);
    const local = (await (await f.inside(f.env, 'w', 'watcher', '/agent-events')).json()).events;
    assert.equal(local.length, 1); assert.equal(local[0].name, 'message.updated');
    assert.equal(local[0].data.thread_id, root.id); assert.equal(local[0].data.reply_count, 1);
    assert.equal(local[0].data.text, 'Please investigate <@watcher>');
    await f.inside(f.env, 'w', 'watcher', '/agent-events/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: local[0].eventId, outcome: 'completed' }) });
    await f.flush();
    const delivered = () => f.calls.filter((call) => JSON.parse(call.body).eventId).map((call) => JSON.parse(call.body));
    assert.deepEqual(delivered().map((event) => event.name).sort(), ['message.mentioned', 'message.updated']);
    assert.ok((await edit(reply.id, 'Please investigate <@watcher>  ')).ok);
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
    assert.ok((await edit(reply.id, 'Changed request <@watcher>')).ok);
    assert.deepEqual((await (await f.inside(f.env, 'w', 'watcher', '/agent-events')).json()).events, []);
    await f.flush();
    assert.equal(delivered().filter((event) => event.name === 'message.mentioned').length, 1);
    assert.equal(delivered().filter((event) => event.name === 'message.updated').length, 2);
    assert.equal((await edit(reply.id, 'Another author', 'bob')).ok, false);
  } finally { await f.dispose(); }
});

test('edits keep queued message.created deliveries with the current text', async () => {
  const f = fixture();
  try {
    await f.rpc('events/subscribe', f.params(undefined, 'message.created'));
    const post = await f.post('alice', 'First draft', 'created-then-edited');
    assert.ok((await f.inside(f.env, 'w', 'alice', `/messages/${post.id}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Final wording' }) })).ok);
    await f.flush();
    const delivered = f.calls.map((call) => JSON.parse(call.body)).filter((body) => body.name === 'message.created');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].data.text, 'Final wording');
    assert.equal(delivered[0].data.text_truncated, false);
  } finally { await f.dispose(); }
});

test('edits replace queued mention snapshots, remove withdrawn tags and roll back atomically', async () => {
  const f = fixture();
  const edit = (id, body) => f.inside(f.env, 'w', 'alice', `/messages/${id}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
  const pending = async () => (await (await f.inside(f.env, 'w', 'watcher', '/agent-events')).json()).events;
  try {
    const subscription = await f.rpc('events/subscribe', f.params(undefined, 'message.mentioned'));
    await f.inside(f.env, 'w', 'alice', '/agents/watcher/listening/c', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'mentions', include_agent_authors: true }) });
    const post = await f.post('alice', 'Original request <@watcher>', 'pending-edit');
    const originalId = f.sql.exec('SELECT event_id FROM event_deliveries')[0].event_id;
    assert.ok((await edit(post.id, 'Revised request <@watcher>')).ok);
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 1);
    assert.notEqual(f.sql.exec('SELECT event_id FROM event_deliveries')[0].event_id, originalId);
    assert.equal((await pending())[0].data.text, 'Revised request <@watcher>');
    const queuedBeforeFailure = f.sql.exec('SELECT * FROM event_deliveries');
    const emit = f.workspace.notifications.watches.emit.bind(f.workspace.notifications.watches);
    f.workspace.notifications.watches.emit = () => { throw new Error('simulate event write failure'); };
    assert.equal((await edit(post.id, 'Failed update')).ok, false);
    f.workspace.notifications.watches.emit = emit;
    assert.equal(f.sql.exec('SELECT body FROM messages WHERE id=?', post.id)[0].body, 'Revised request <@watcher>');
    assert.deepEqual(f.sql.exec('SELECT * FROM event_deliveries'), queuedBeforeFailure);
    assert.equal((await pending())[0].data.text, 'Revised request <@watcher>');
    assert.ok((await edit(post.id, 'Mention withdrawn')).ok);
    assert.deepEqual(await pending(), []); await f.flush();
    assert.equal(f.calls.filter((call) => JSON.parse(call.body).eventId).length, 0);
    assert.equal(f.sql.exec('SELECT active FROM event_subscriptions WHERE id=?', subscription.result.id)[0].active, 1);
    assert.ok((await edit(post.id, 'Retagged <@watcher>')).ok);
    f.restart(); await f.flush();
    assert.equal(JSON.parse(f.calls.at(-1).body).data.text, 'Retagged <@watcher>');
  } finally { await f.dispose(); }
});

test('an edit during asynchronous delivery authorization cannot send a superseded snapshot or stop its watch', async () => {
  const f = fixture();
  try {
    const subscription = await f.rpc('events/subscribe', f.params(undefined, 'message.mentioned'));
    const message = await f.post('alice', 'Withdraw this <@watcher>', 'in-flight-edit');
    const prepare = f.env.DB.prepare;
    let release, reached;
    const entered = new Promise((resolve) => { reached = resolve; });
    f.env.DB.prepare = (query) => query.includes('SELECT a.auth_version') ? { bind: () => ({ first: () => new Promise((resolve) => { release = () => resolve({ auth_version: 0 }); reached(); }) }) } : prepare(query);
    const flushing = f.flush();
    await entered;
    const edited = await f.inside(f.env, 'w', 'alice', `/messages/${message.id}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Withdrawn while delivery waits' }) });
    assert.ok(edited.ok);
    release(); await flushing;
    assert.equal(f.calls.filter((call) => JSON.parse(call.body).eventId).length, 0);
    assert.equal(f.sql.exec('SELECT active FROM event_subscriptions WHERE id=?', subscription.result.id)[0].active, 1);
  } finally { await f.dispose(); }
});

test('message events and channel reads expose thread counts without including replies', async () => {
  const f = fixture();
  try {
    await f.rpc('events/subscribe', f.params());
    assert.ok((await f.inside(f.env, 'w', 'alice', '/agents/watcher/listening/c', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'messages', include_agent_authors: false }) })).ok);
    const root = await f.post('alice', 'Root discussion', 'thread-root');
    const reply = await f.post('bob', 'Thread reply', 'thread-reply', root.id);
    const local = (await (await f.inside(f.env, 'w', 'watcher', '/agent-events')).json()).events;
    assert.deepEqual(local.map((event) => [event.data.thread_id, event.data.reply_count]), [[null, 0], [root.id, 1]]);
    await f.flush(); await f.flush();
    const delivered = f.calls.filter((call) => JSON.parse(call.body).eventId).map((call) => JSON.parse(call.body));
    assert.deepEqual(delivered.map((event) => [event.data.thread_id, event.data.reply_count]), [[null, 0], [root.id, 1]]);
    const channel = await (await f.inside(f.env, 'w', 'watcher', '/channels/c/messages')).json();
    assert.equal(channel.length, 1); assert.equal(channel[0].id, root.id); assert.equal(channel[0].reply_count, 1);
    const thread = await (await f.inside(f.env, 'w', 'watcher', `/channels/c/messages?thread=${root.id}`)).json();
    assert.deepEqual(thread.map((message) => message.id), [root.id, reply.id]);
    assert.ok(eventDefinitions.find((event) => event.name === 'message.created').payloadSchema.properties.reply_count);
  } finally { await f.dispose(); }
});

test('a failed event retries with its identity and prevents later events from overtaking it', async () => {
  const f = fixture();
  try {
    await f.rpc('events/subscribe', f.params()); await f.post('alice', 'First', 'first'); await f.post('alice', 'Second', 'second');
    f.callback(() => ({ status: 503, body: '' })); await f.flush();
    assert.equal(f.calls.filter((call) => JSON.parse(call.body).eventId).length, 1);
    const original = f.calls.at(-1);
    const alarm = f.workspace.notifications.watches.nextAlarm(); assert.ok(alarm > Date.now(), 'later queued events must not make the alarm spin');
    f.callback(() => ({ status: 204, body: '' })); f.restart(); await f.flush();
    assert.equal(f.calls.at(-1).headers['webhook-id'], original.headers['webhook-id']); assert.equal(f.calls.at(-1).body, original.body);
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 1); await f.flush();
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
  } finally { await f.dispose(); }
});

test('410 and 413 stop delivery without retrying; failure is visible and keys are scrubbed', async () => {
  for (const status of [410, 413]) {
    const f = fixture();
    try {
      await f.rpc('events/subscribe', f.params()); await f.post('alice', 'Will fail', 'fail');
      f.callback(() => ({ status, body: '' })); await f.flush(); await f.flush();
      const row = f.sql.exec('SELECT * FROM event_subscriptions')[0]; assert.equal(row.active, 0); assert.equal(row.secret, ''); assert.ok(row.last_error.includes(String(status)));
      assert.equal(f.calls.filter((call) => JSON.parse(call.body).eventId).length, 1);
    } finally { await f.dispose(); }
  }
});

test('unsubscribe is idempotent and cancellation during verification cannot resurrect a watch', async () => {
  const f = fixture();
  try {
    const p = f.params(); await f.rpc('events/subscribe', p); await f.post('alice', 'Queued', 'queued');
    await f.rpc('events/unsubscribe', p); await f.rpc('events/unsubscribe', p); await f.flush();
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async (url, options) => {
      if (!cancelled) { cancelled = true; await f.workspace.notifications.watches.unsubscribe(f.authority, p); }
      return originalFetch(url, options);
    };
    const result = await f.rpc('events/subscribe', p); assert.equal(result.error.data.reason, 'subscription_changed');
    assert.equal(f.sql.exec('SELECT active FROM event_subscriptions')[0].active, 0);
  } finally { await f.dispose(); }
});

test('channel removal, pause, token rotation and grant revocation suppress delivery', async () => {
  for (const action of ['remove', 'pause', 'rotate', 'revoke-token', 'revoke-grant']) {
    const f = fixture();
    try {
      const authority = action === 'revoke-grant' ? { ...f.authority, credential: { kind: 'oauth', userId: 'alice', grantId: 'grant-1' } } : f.authority;
      f.grants.set('grant:alice:grant-1', { id: 'grant-1', userId: 'alice', scope: ['read'] });
      const actor = { accountId: 'watcher', workspaceId: 'w', scopes: ['read'], eventAuthority: authority };
      await f.rpc('events/subscribe', f.params(), actor); await f.post('alice', 'Private wake', 'wake');
      if (action === 'remove') f.sql.exec("DELETE FROM channel_members WHERE account_id = 'watcher'");
      if (action === 'pause') f.sql.exec("UPDATE members SET paused = 1 WHERE account_id = 'watcher'");
      if (action === 'rotate') f.version(1);
      if (action === 'revoke-token') f.readAccess(false);
      if (action === 'revoke-grant') f.grants.clear();
      await f.flush(); assert.equal(f.calls.filter((call) => JSON.parse(call.body).eventId).length, 0, action);
      assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0, action);
    } finally { await f.dispose(); }
  }
});

test('task and document writes atomically queue events through real workspace handlers', async () => {
  const f = fixture();
  try {
    for (const name of ['task.created', 'task.updated', 'task.deleted', 'document.created', 'document.updated', 'document.deleted']) await f.rpc('events/subscribe', f.params(`https://receiver.example.com/${name}`, name));
    const write = async (path, body, method = 'POST') => {
      const response = await f.inside(f.env, 'w', 'alice', path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); await f.settle(); return result;
    };
    const board = await write('/boards', { channel_id: 'c', name: 'Work' });
    const taskInput = { title: 'Triage', status: 'todo', client_id: 'event-task' };
    const task = await write(`/boards/${board.id}/tasks`, taskInput);
    assert.equal((await write(`/boards/${board.id}/tasks`, taskInput)).id, task.id);
    await write(`/tasks/${task.id}`, { status: 'todo' }, 'PATCH');
    await write(`/tasks/${task.id}`, { status: 'done' }, 'PATCH'); await write(`/tasks/${task.id}`, undefined, 'DELETE');
    const docInput = { channel_id: 'c', title: 'Notes', body: 'Private document content', client_id: 'event-doc' };
    const document = await write('/documents', docInput);
    assert.equal((await write('/documents', docInput)).id, document.id);
    await write(`/documents/${document.id}`, { body: 'Private document content' }, 'PUT');
    await write(`/documents/${document.id}`, { body: 'Changed document content' }, 'PUT');
    await write(`/documents/${document.id}`, undefined, 'DELETE');
    const bodies = f.sql.exec('SELECT body FROM event_deliveries').map(({ body }) => JSON.parse(body));
    assert.equal(bodies.length, 6); assert.equal(JSON.stringify(bodies).includes('Private document content'), false);
    await f.flush(); assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
  } finally { await f.dispose(); }
});

test('approval holds posts until published and rejected work produces no event', async () => {
  const f = fixture();
  try {
    await f.rpc('events/subscribe', f.params(undefined, 'message.created', { channel_id: 'c', include_agent_authors: true }));
    f.sql.exec("UPDATE members SET approval_mode = 1 WHERE account_id = 'other-agent'");
    const pending = await f.post('other-agent', 'Needs approval', 'approval'); assert.equal(pending.pending, true);
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
    const response = await f.inside(f.env, 'w', 'alice', `/agents/other-agent/pending/${pending.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) });
    assert.ok(response.ok, JSON.stringify(await response.json())); await f.settle();
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 1);
  } finally { await f.dispose(); }
});

test('event queue and workspace mutation roll back together on a failed commit', async () => {
  const f = fixture();
  try {
    await f.rpc('events/subscribe', f.params());
    const original = f.workspace.notifications.watches.emit.bind(f.workspace.notifications.watches);
    f.workspace.notifications.watches.emit = (event) => { original(event); throw new Error('Injected failure'); };
    const response = await f.inside(f.env, 'w', 'alice', '/channels/c/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Must roll back', client_id: 'rollback' }) });
    assert.equal(response.ok, false);
    assert.equal(f.sql.exec("SELECT * FROM messages WHERE client_id = 'rollback'").length, 0);
    assert.equal(f.sql.exec('SELECT * FROM event_deliveries').length, 0);
  } finally { await f.dispose(); }
});

test('expiration scrubs signing secrets and an owner can stop watches without seeing credentials', async () => {
  const f = fixture();
  try {
    const subscribed = await f.rpc('events/subscribe', f.params()); await f.post('alice', 'Expiring', 'expiry');
    assert.throws(() => f.workspace.notifications.watches.cancel(f.workspace.member('bob'), subscribed.result.id));
    f.sql.exec('UPDATE event_subscriptions SET expires_at = ?', Date.now() - 1); await f.flush();
    const row = f.sql.exec('SELECT * FROM event_subscriptions')[0]; assert.equal(row.active, 0); assert.equal(row.secret, '');
    assert.equal(f.calls.filter((call) => JSON.parse(call.body).eventId).length, 0);
    assert.ok(row.last_error.includes('expired'));
    assert.ok(f.workspace.notifications.watches.nextAlarm() > Date.now());
  } finally { await f.dispose(); }
});

test('schemas and canonical identity preserve the declared event contract', () => {
  assert.equal(canonicalJson({ b: true, a: { d: 1, c: 2 } }), canonicalJson({ a: { c: 2, d: 1 }, b: true }));
  assert.throws(() => parseEventArguments('task.updated', { channel_id: 'c', thread_id: 'root' }));
  for (const event of eventDefinitions) { assert.deepEqual(event.delivery, ['webhook']); assert.equal(event.inputSchema.additionalProperties, false); assert.equal(event.payloadSchema.additionalProperties, false); }
});

test('local listening levels deliver human and agent mentions once, survive restart and acknowledge safely', async () => {
  const f = fixture();
  const listening = '/agents/watcher/listening/c';
  const set = async (level, include = true, actor = 'alice') => f.inside(f.env, 'w', actor, listening, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level, include_agent_authors: include }) });
  const pending = async (actor = 'watcher') => (await (await f.inside(f.env, 'w', actor, '/agent-events')).json()).events;
  try {
    assert.equal((await set('mentions', true, 'other-agent')).ok, false);
    assert.ok((await set('mentions')).ok);
    await f.post('bob', 'Ordinary message', 'local-ordinary');
    assert.deepEqual(await pending(), []);
    const human = await f.post('bob', 'Hello <@watcher>', 'local-human-mention');
    await f.post('bob', 'Hello <@watcher>', 'local-human-mention');
    await f.post('other-agent', 'Hello from another agent <@watcher>', 'local-agent-mention');
    await f.post('watcher', 'My own <@watcher>', 'local-self');
    f.restart();
    const events = await pending(); assert.equal(events.length, 2);
    assert.equal(events[0].data.message_id, human.id); assert.equal(events[1].data.actor_kind, 'agent');
    assert.equal(events[1].data.mentions_agent, true);
    const ack = await f.inside(f.env, 'w', 'other-agent', '/agent-events/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: events[0].eventId, outcome: 'completed' }) });
    assert.ok(ack.ok); assert.equal((await pending()).length, 2, 'cannot acknowledge another agent inbox');
    await f.inside(f.env, 'w', 'watcher', '/agent-events/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: events[0].eventId, outcome: 'completed' }) });
    assert.equal((await pending()).length, 1);
    await set('messages', false); assert.equal((await pending()).length, 0, 'switching clears pending');
    await f.post('other-agent', 'Should be excluded <@watcher>', 'local-excluded-agent');
    await f.post('bob', 'All messages', 'local-all-message');
    assert.equal((await pending()).length, 1);
    await set('off'); await f.post('bob', 'Off <@watcher>', 'local-off'); assert.deepEqual(await pending(), []);
    await set('mentions'); await f.post('bob', 'Deleted <@watcher>', 'local-deleted');
    f.sql.exec('UPDATE messages SET deleted_at = ? WHERE client_id = ?', Date.now(), 'local-deleted'); assert.deepEqual(await pending(), []);
    await f.post('bob', 'Pause <@watcher>', 'local-pause');
    await f.inside(f.env, 'w', 'alice', '/members/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'watcher', paused: true }) });
    assert.deepEqual(await pending(), []);
    assert.equal(f.sql.exec('SELECT * FROM agent_event_inbox').length, 0);
    await f.post('bob', 'While paused <@watcher>', 'local-paused'); assert.deepEqual(await pending(), []);
  } finally { await f.dispose(); }
});

test('all activity local level collects effective task and document changes and clears on channel removal', async () => {
  const f = fixture();
  try {
    const settingsPath = '/agents/watcher/listening/c';
    assert.ok((await f.inside(f.env, 'w', 'alice', settingsPath, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'activity', include_agent_authors: true }) })).ok);
    const boardResponse = await f.inside(f.env, 'w', 'alice', '/boards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel_id: 'c', name: 'Local work' }) });
    const board = await boardResponse.json();
    await f.inside(f.env, 'w', 'bob', `/boards/${board.id}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Local task', client_id: 'local-task' }) });
    await f.inside(f.env, 'w', 'other-agent', '/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel_id: 'c', title: 'Agent document', body: 'Hello', client_id: 'local-document' }) });
    const result = await (await f.inside(f.env, 'w', 'watcher', '/agent-events')).json();
    assert.deepEqual(result.events.map((event) => event.name), ['task.created', 'document.created']);
    await f.inside(f.env, 'w', 'alice', '/channels/c/members/watcher', { method: 'DELETE' });
    const after = await (await f.inside(f.env, 'w', 'watcher', '/agent-events')).json();
    assert.deepEqual(after.events, []);
    assert.equal(f.sql.exec('SELECT * FROM agent_event_settings').length, 0);
  } finally { await f.dispose(); }
});

function inboxWebhook(f) {
  const send = (actor, method, body) => f.inside(f.env, 'w', actor, '/agents/watcher/webhook', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    save: (actor = 'alice', body = { url: 'https://receiver.example.com/inbox', secret }) => send(actor, 'PUT', body),
    status: async (actor = 'alice') => (await send(actor, 'GET')).json(),
    remove: (actor = 'alice') => send(actor, 'DELETE'),
    listen: (level, include = false) => f.inside(f.env, 'w', 'alice', '/agents/watcher/listening/c', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level, include_agent_authors: include }) }),
    pending: async () => (await (await f.inside(f.env, 'w', 'watcher', '/agent-events')).json()).events,
    row: () => f.sql.exec('SELECT * FROM inbox_webhooks')[0],
    rings: () => f.calls.filter((call) => JSON.parse(call.body).type === 'agent_events'),
    ring: async () => { f.sql.exec('UPDATE inbox_webhooks SET ring_at = ? WHERE ring_id IS NOT NULL', Date.now() - 1); await f.workspace.alarm(); await f.settle(); },
  };
}

test('inbox webhooks verify their endpoint, keep the key encrypted and ring through the gateway without team content', async () => {
  const f = fixture();
  const hook = inboxWebhook(f);
  const destinations = [];
  const gatewayFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { destinations.push(url instanceof Request ? url.url : String(url)); return gatewayFetch(url, options); };
  try {
    assert.equal((await hook.save('bob')).status, 403, 'a teammate who does not own the agent');
    assert.equal((await hook.save('watcher')).status, 403, 'the agent itself');
    assert.equal((await hook.save('alice', { url: 'http://receiver.example.com/inbox', secret })).status, 400);
    assert.equal((await hook.save('alice', { url: 'https://localhost./inbox', secret })).status, 400);
    assert.equal((await hook.save('alice', { url: 'https://receiver.example.com/inbox', secret: 'not-a-signing-secret' })).status, 400);
    assert.equal(f.calls.length, 0, 'invalid input never reaches the gateway');
    const saved = await hook.save();
    const status = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(status));
    assert.equal(status.active, true); assert.equal(JSON.stringify(status).includes(secret.slice(6)), false);
    assert.deepEqual(f.calls.map((call) => JSON.parse(call.body).type), ['verification']);
    assert.equal(f.calls[0].headers['x-mcp-subscription-id'], 'inbox_watcher');
    const stored = hook.row().secret;
    assert.equal(stored.includes(secret.slice(6)), false);
    assert.equal(await decryptSecret(f.env, 'inbox_watcher', stored), secret);

    await hook.listen('mentions');
    await f.post('bob', 'Nothing for the agent', 'inbox-quiet');
    assert.equal(hook.row().ring_id, null, 'nothing recorded, nothing rings');
    await f.post('bob', 'Can you check this <@watcher>?', 'inbox-first');
    await f.post('bob', 'And this one <@watcher>', 'inbox-second');
    await hook.ring();
    assert.equal(hook.rings().length, 1, 'a burst coalesces into one ring');
    const [notice] = hook.rings();
    assert.deepEqual(JSON.parse(notice.body), { type: 'agent_events', workspace_id: 'w', agent_id: 'watcher' });
    assert.equal(notice.headers['x-mcp-subscription-id'], 'inbox_watcher');
    const signed = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${notice.headers['webhook-id']}.${notice.headers['webhook-timestamp']}.${notice.body}`).digest('base64');
    assert.equal(notice.headers['webhook-signature'], `v1,${signed}`);
    assert.equal((await hook.pending()).length, 2, 'the inbox keeps events until the agent acknowledges them');
    assert.ok(hook.row().last_delivered_at);

    // An event recorded while a ring is in flight gets a ring of its own.
    let posted = false;
    f.callback(async () => {
      if (!posted) { posted = true; await f.post('bob', 'Arrived during the ring <@watcher>', 'inbox-during'); }
      return { status: 204, body: '' };
    });
    await f.post('bob', 'Another one <@watcher>', 'inbox-third');
    await hook.ring();
    assert.equal(hook.rings().length, 2);
    assert.ok(hook.row().ring_id, 'a new ring is queued for the event that arrived meanwhile');
    await hook.ring();
    assert.equal(hook.rings().length, 3);
    assert.notEqual(hook.rings()[1].headers['webhook-id'], hook.rings()[2].headers['webhook-id']);

    // Acknowledged or deleted events leave nothing to announce.
    const events = await hook.pending();
    await f.inside(f.env, 'w', 'watcher', '/agent-events/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_ids: events.map((event) => event.eventId) }) });
    const deleted = await f.post('bob', 'About to be deleted <@watcher>', 'inbox-deleted');
    await f.inside(f.env, 'w', 'bob', `/messages/${deleted.id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(f.sql.exec('SELECT * FROM agent_event_inbox').length, 0);
    await hook.ring();
    assert.equal(hook.rings().length, 3);
    assert.equal(hook.row().ring_id, null);
    assert.ok(destinations.length > 0 && destinations.every((value) => value === f.env.MCP_WEBHOOK_GATEWAY_URL), 'every request goes to the gateway');
  } finally { await f.dispose(); }
});

test('inbox webhook rings retry with one identity across restart, stop visibly, and resume only after a verified save', async () => {
  const f = fixture();
  const hook = inboxWebhook(f);
  try {
    await hook.listen('mentions');
    assert.equal((await hook.save()).status, 200);
    await f.post('bob', 'Please look <@watcher>', 'retry-first');
    f.callback(() => ({ status: 503, body: '' }));
    await hook.ring();
    const first = hook.rings().at(-1);
    const backoff = hook.row();
    assert.equal(backoff.ring_attempts, 1); assert.ok(backoff.ring_at > Date.now() + 1000); assert.match(backoff.last_error, /503/);
    await f.post('bob', 'A newer event joins the pending ring <@watcher>', 'retry-joins');
    assert.equal(hook.row().ring_id, backoff.ring_id); assert.equal(hook.row().ring_at, backoff.ring_at, 'new events never cut a backoff short');
    f.restart();
    f.callback(() => ({ status: 401, body: '' }));
    await hook.ring();
    assert.equal(hook.rings().length, 2);
    assert.equal(hook.rings().at(-1).headers['webhook-id'], first.headers['webhook-id']);
    assert.equal(hook.rings().at(-1).body, first.body);
    const stopped = hook.row();
    assert.equal(stopped.active, 0); assert.equal(stopped.secret, ''); assert.match(stopped.last_error, /401/);
    const visible = await hook.status();
    assert.equal(visible.active, false); assert.match(visible.last_error, /save the webhook again/);
    await f.post('bob', 'While the webhook is stopped <@watcher>', 'retry-waiting');
    await hook.ring();
    assert.equal(hook.rings().length, 2, 'a stopped webhook stays quiet');
    assert.equal((await hook.pending()).length, 3, 'events wait in the inbox');
    f.callback(() => ({ status: 204, body: '' }));
    assert.equal((await hook.save()).status, 200);
    await hook.ring();
    assert.equal(hook.rings().length, 3, 'a verified save rings for events already waiting');
    f.callback(() => ({ status: 410, body: '' }));
    await f.post('bob', 'One more <@watcher>', 'retry-gone');
    await hook.ring();
    assert.equal(hook.row().active, 0); assert.match(hook.row().last_error, /410/);
    f.callback(() => ({ status: 204, body: '' }));
    await hook.save();
    // The owner saves a fixed endpoint while a failing ring is in flight; the late failure cannot stop it.
    let resaved = false;
    f.callback(async () => {
      if (resaved) return { status: 204, body: '' };
      resaved = true;
      assert.equal((await hook.save()).status, 200);
      return { status: 401, body: '' };
    });
    await f.post('bob', 'Ring during a save <@watcher>', 'retry-race');
    await hook.ring();
    assert.equal(hook.row().active, 1); assert.equal(hook.row().last_error, null);
    const racing = hook.rings().length;
    await hook.ring();
    assert.equal(hook.rings().length, racing + 1, 'the saved endpoint rings for the waiting events');
    // A removal while another save is verifying is not undone by that save.
    const gatewayFetch = globalThis.fetch;
    let removedDuringVerification = false;
    globalThis.fetch = async (url, options) => {
      if (!removedDuringVerification) { removedDuringVerification = true; assert.equal((await hook.remove()).status, 200); }
      return gatewayFetch(url, options);
    };
    assert.equal((await hook.save()).status, 409);
    globalThis.fetch = gatewayFetch;
    assert.equal(hook.row(), undefined);
    assert.equal((await hook.status()).url, '');
  } finally { await f.dispose(); }
});

test('pause and removal clear inbox webhook rings, and pause holds every wait while lookups still read', async () => {
  const f = fixture();
  const hook = inboxWebhook(f);
  const pause = (paused) => f.inside(f.env, 'w', 'alice', '/members/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'watcher', paused }) });
  const lookup = async (path) => (await f.inside(f.env, 'w', 'watcher', path)).json();
  try {
    await hook.listen('mentions');
    assert.equal((await hook.save()).status, 200);
    const before = await f.post('bob', 'Before the pause <@watcher>', 'pause-before');
    assert.ok(hook.row().ring_id);
    await pause(true);
    assert.equal(hook.row().ring_id, null); assert.deepEqual(await hook.pending(), []);
    const during = await f.post('bob', 'While paused <@watcher>', 'pause-during');
    await hook.ring();
    assert.equal(hook.rings().length, 0, 'a paused agent is never rung');
    assert.ok((await lookup(`/mentions?after=${before.id}`)).some((message) => message.id === during.id), 'lookups read mention history while paused');
    assert.deepEqual(await lookup(`/mentions/wait?after=${before.id}&timeout=50`), [], 'waits hold and return nothing while paused');
    assert.deepEqual(await lookup('/agent-events/wait?timeout=50'), { events: [] });
    await pause(false);
    assert.deepEqual(await hook.pending(), [], 'resuming replays nothing');
    assert.ok((await lookup(`/mentions/wait?after=${before.id}&timeout=50`)).some((message) => message.id === during.id));
    await f.post('bob', 'After the pause <@watcher>', 'pause-after');
    await hook.ring();
    assert.equal(hook.rings().length, 1);
    const removed = await f.inside(f.env, 'w', 'alice', '/members/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_id: 'watcher' }) });
    assert.ok(removed.ok);
    assert.equal(hook.row(), undefined);
  } finally { await f.dispose(); }
});

test('a retried ring keeps its webhook-id, and events from its backoff get a ring of their own', async () => {
  const f = fixture();
  const hook = inboxWebhook(f);
  try {
    await hook.listen('mentions');
    assert.equal((await hook.save()).status, 200);
    await f.post('bob', 'First <@watcher>', 'covered-first');
    f.callback(() => ({ status: 503, body: '' }));
    await hook.ring();
    await f.post('bob', 'During the backoff <@watcher>', 'covered-backoff');
    f.callback(() => ({ status: 204, body: '' }));
    await hook.ring();
    const [first, retry] = hook.rings();
    assert.equal(retry.headers['webhook-id'], first.headers['webhook-id'], 'a retry is the same notice, which a receiver may ignore');
    assert.ok(hook.row().ring_id, 'so the event from the backoff gets a ring of its own');
    await hook.ring();
    assert.equal(hook.rings().length, 3);
    assert.notEqual(hook.rings()[2].headers['webhook-id'], first.headers['webhook-id']);
    await hook.ring();
    assert.equal(hook.rings().length, 3, 'nothing newer, no further ring');
  } finally { await f.dispose(); }
});

test('changing a listening level wakes waits but never rings for events already announced', async () => {
  const f = fixture();
  const hook = inboxWebhook(f);
  try {
    f.sql.exec("INSERT INTO channel_members (channel_id, account_id) VALUES ('other-channel', 'watcher')");
    await hook.listen('mentions');
    assert.equal((await hook.save()).status, 200);
    await f.post('bob', 'Look <@watcher>', 'level-first');
    await hook.ring();
    assert.equal(hook.rings().length, 1);
    const changed = await f.inside(f.env, 'w', 'alice', '/agents/watcher/listening/other-channel', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'messages', include_agent_authors: false }) });
    assert.ok(changed.ok);
    assert.equal(hook.row().ring_id, null);
    await hook.ring();
    assert.equal(hook.rings().length, 1);
  } finally { await f.dispose(); }
});

test('gateway outages retry without stopping an inbox webhook, and a key Await cannot read stops it at once', async () => {
  const f = fixture();
  const hook = inboxWebhook(f);
  const gatewayFetch = globalThis.fetch;
  try {
    await hook.listen('mentions');
    assert.equal((await hook.save()).status, 200);
    await f.post('bob', 'During an outage <@watcher>', 'outage');
    globalThis.fetch = async () => new Response('busy', { status: 503 });
    for (let attempt = 0; attempt < 9; attempt++) await hook.ring();
    assert.equal(hook.row().active, 1, "Await's own outage never stops the webhook");
    assert.equal(hook.row().ring_attempts, 9);
    assert.ok(hook.row().ring_at > Date.now() + 3 * 3600000 - 1000, 'it keeps retrying at the longest delay');
    assert.equal((await hook.status()).last_error, 'Await could not reach its delivery gateway.');
    globalThis.fetch = gatewayFetch;
    await hook.ring();
    assert.equal(hook.row().ring_id, null); assert.equal(hook.row().last_error, null);
    // The operator replaced the encryption key without keeping the previous one.
    f.env.MCP_EVENT_KEY = Buffer.alloc(32, 11).toString('base64');
    await f.post('bob', 'After the key changed <@watcher>', 'lost-key');
    const rings = hook.rings().length;
    await hook.ring();
    assert.equal(hook.rings().length, rings);
    const stopped = await hook.status();
    assert.equal(stopped.active, false);
    assert.equal(stopped.last_error, 'Await can no longer read the signing key. Save the webhook again with its secret to turn it back on.');
    assert.equal(hook.row().secret, '');
  } finally { globalThis.fetch = gatewayFetch; await f.dispose(); }
});

test('inbox webhook keys move to the current encryption key while a rotation is under way', async () => {
  const f = fixture();
  const hook = inboxWebhook(f);
  try {
    await hook.listen('mentions');
    assert.equal((await hook.save()).status, 200);
    f.env.MCP_EVENT_PREVIOUS_KEY = f.env.MCP_EVENT_KEY;
    f.env.MCP_EVENT_KEY = Buffer.alloc(32, 10).toString('base64');
    await f.post('bob', 'During the rotation <@watcher>', 'rotation-ring');
    await hook.ring();
    assert.equal(hook.rings().length, 1);
    delete f.env.MCP_EVENT_PREVIOUS_KEY;
    assert.equal(await decryptSecret(f.env, 'inbox_watcher', hook.row().secret), secret, 'the stored key opens with the new encryption key alone');
    await f.post('bob', 'After the rotation <@watcher>', 'rotation-after');
    await hook.ring();
    assert.equal(hook.rings().length, 2);
  } finally { await f.dispose(); }
});

test('legacy agent webhooks become stopped inbox webhooks that wake on mentions once saved, and nothing is fetched directly', async () => {
  const f = fixture();
  const hook = inboxWebhook(f);
  const destinations = [];
  const gatewayFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { destinations.push(url instanceof Request ? url.url : String(url)); return gatewayFetch(url, options); };
  const levels = () => Object.fromEntries(f.sql.exec('SELECT channel_id, level, include_agent_authors FROM agent_event_settings').map((row) => [row.channel_id, [row.level, row.include_agent_authors]]));
  try {
    f.sql.exec("INSERT INTO channel_members (channel_id, account_id) VALUES ('other-channel', 'watcher')");
    f.sql.exec("INSERT INTO agent_event_settings (account_id, channel_id, level, include_agent_authors) VALUES ('watcher', 'other-channel', 'off', 0)");
    f.sql.exec("INSERT INTO agent_webhooks (agent_id, url, secret, updated_at) VALUES ('watcher', 'https://legacy.example.com/hook', ?, ?)", 'a'.repeat(64), Date.now());
    f.sql.exec("INSERT INTO webhook_deliveries (agent_id, message_id, channel_id, next_attempt_at) VALUES ('watcher', 'queued', 'c', ?)", Date.now() - 1);
    f.sql.exec("UPDATE meta SET value='16' WHERE key='schema_version'");
    f.restart();
    assert.equal(f.sql.exec("SELECT value FROM meta WHERE key='schema_version'")[0].value, '17');
    // The previous release reads these tables, so they stay, emptied, in case it is rolled back.
    assert.deepEqual({ ...f.sql.exec('SELECT (SELECT COUNT(*) FROM agent_webhooks) AS hooks, (SELECT COUNT(*) FROM webhook_deliveries) AS deliveries')[0] }, { hooks: 0, deliveries: 0 });
    const migrated = hook.row();
    assert.equal(migrated.url, 'https://legacy.example.com/hook'); assert.equal(migrated.active, 0); assert.equal(migrated.secret, '');
    f.restart();
    assert.equal(hook.row().url, 'https://legacy.example.com/hook', 'running the migration again is harmless');
    const status = await hook.status();
    assert.equal(status.active, false); assert.match(status.last_error, /whsec_/);
    await f.post('other-agent', 'Before the webhook is saved <@watcher>', 'legacy-unsaved');
    assert.deepEqual(await hook.pending(), [], 'nothing piles up before an owner turns it back on');
    await hook.ring(); await f.workspace.alarm(); await f.settle();
    assert.equal(destinations.length, 0, 'the stopped webhook and the dropped legacy retry fetch nothing');
    assert.equal((await hook.save()).status, 200);
    assert.deepEqual(levels(), { c: ['mentions', 1], 'other-channel': ['off', 0] }, 'unset channels listen for mentions from anyone; explicit levels stay');
    await f.post('other-agent', 'An agent asks <@watcher>', 'legacy-agent-mention');
    assert.equal((await hook.pending()).length, 1, 'mentions by other agents reach the agent');
    f.sql.exec('DELETE FROM agent_event_settings');
    assert.equal((await hook.save()).status, 200);
    assert.deepEqual(levels(), {}, 'only the first verified save sets listening levels');
    assert.ok(destinations.every((value) => value === f.env.MCP_WEBHOOK_GATEWAY_URL), 'every request goes to the gateway');
  } finally { await f.dispose(); }
});

test('indexed discovery enforces channel access, active tasks, dates and bounded excerpts', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.sql.exec("INSERT INTO boards VALUES ('board','c','Orbit planning','alice',?)", now);
    for (const [id, state] of [['active', 'doing'], ['done', 'done']]) f.sql.exec("INSERT INTO tasks(id,board_id,title,description,status,created_by,created_at,updated_at) VALUES (?, 'board', ?, ?, ?, 'alice', ?, ?)", id, `Orbit ${id}`, 'Migration implementation', state, now, now);
    f.sql.exec("INSERT INTO documents VALUES ('doc', 'c', 'Orbit notes', ?, 'alice', 'alice', ?, ?)", 'Orbit '.repeat(1000), now, now);
    f.sql.exec("INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES ('secret','other-channel','bob','Orbit classified',?)", now);
    const root = await f.post('bob', 'Orbit handoff', 'search-root');
    await f.post('alice', 'Orbit reply', 'search-reply', root.id);
    const search = async (args) => {
      const result = await f.rpc('tools/call', { name: 'search_workspace', arguments: { query: 'orbit', ...args } });
      assert.ok(!result.result.isError, JSON.stringify(result));
      return result.result.structuredContent.result;
    };
    const result = await search({});
    assert.ok(result.items.some((item) => item.id === 'active'));
    assert.ok(!result.items.some((item) => ['secret', 'done'].includes(item.id)));
    assert.ok(result.items.every((item) => item.excerpt.length <= 320 && item.url.startsWith('https://await.chat/w/w/c')));
    assert.equal(result.items.find((item) => item.id === root.id).reply_count, 1);
    assert.deepEqual((await search({ query: 'orbit is:done', kinds: ['task'] })).items.map((item) => item.id), ['done']);
    assert.equal((await search({ query: 'orbi*', kinds: ['task'], task_state: 'all' })).items.length, 2);
    assert.equal((await search({ after: now + 10000 })).items.length, 0);
    const page = await search({ limit: 1 });
    assert.equal(page.items.length, 1); assert.equal(page.has_more, true); assert.equal(page.next_offset, 1);
    const next = await search({ limit: 1, offset: page.next_offset });
    assert.notEqual(next.items[0].id, page.items[0].id);
    for (const args of [{ limit: 51 }, { offset: 501 }, { kinds: ['wrong'] }, { kinds: ['task', 'task'] }, { before: now, after: now }, { query: 'one two three four five six seven eight nine' }]) {
      const invalid = await f.rpc('tools/call', { name: 'search_workspace', arguments: { query: 'orbit', ...args } });
      assert.equal(invalid.result.isError, true);
    }
    const mention = await (await f.inside(f.env, 'w', 'watcher', '/mention-search?q=orbi')).json();
    assert.ok(mention.some((item) => item.id === 'active'));
    assert.ok(!mention.some((item) => item.id === 'done'));
    const completed = await (await f.inside(f.env, 'w', 'watcher', '/mention-search?q=orbit%20is:done')).json();
    assert.ok(completed.some((item) => item.id === 'done'));
    const task = await f.rpc('tools/call', { name: 'read_task', arguments: { task_id: 'active' } });
    assert.equal(task.result.structuredContent.result.id, 'active');
    f.sql.exec("DELETE FROM channel_members WHERE account_id='watcher'");
    assert.equal((await search({})).items.length, 0);
  } finally { await f.dispose(); }
});

test('search index follows edits, soft deletes, work deletion and restarts atomically', async () => {
  const f = fixture();
  try {
    const root = await f.post('bob', 'Nebula launch', 'search-edit');
    const search = async (query) => (await (await f.inside(f.env, 'w', 'watcher', `/search-workspace?q=${encodeURIComponent(query)}`)).json()).items;
    assert.equal((await search('nebula')).length, 1);
    f.sql.exec('UPDATE messages SET body=? WHERE id=?', 'Quasar launch', root.id);
    assert.equal((await search('nebula')).length, 0);
    assert.equal((await search('quasar')).length, 1);
    f.restart(); assert.equal((await search('quasar')).length, 1);
    f.sql.exec('UPDATE messages SET deleted_at=? WHERE id=?', Date.now(), root.id);
    assert.equal((await search('quasar')).length, 0);
    const now = Date.now();
    f.sql.exec("INSERT INTO boards VALUES ('b','c','Quasar board','alice',?)", now);
    f.sql.exec("INSERT INTO tasks(id,board_id,title,created_by,created_at,updated_at) VALUES ('t','b','Quasar task','alice',?,?)", now, now);
    assert.equal((await search('quasar')).length, 2);
    assert.throws(() => f.ctx.storage.transactionSync(() => {
      f.sql.exec("UPDATE tasks SET title='Nebula task' WHERE id='t'");
      throw new Error('rollback');
    }));
    assert.equal((await search('nebula')).length, 0);
    assert.equal((await search('quasar')).length, 2);
    f.sql.exec("DELETE FROM boards WHERE id='b'");
    assert.equal((await search('quasar')).length, 0);
    for (const query of ['" OR *', 'NEAR(orbit)', 'x"; DROP TABLE messages;--']) {
      const response = await f.inside(f.env, 'w', 'watcher', `/search-workspace?q=${encodeURIComponent(query)}`);
      assert.equal(response.status, 200);
    }
    assert.equal(f.sql.exec("SELECT COUNT(*) AS n FROM messages")[0].n, 1);
    f.sql.exec("INSERT INTO search_fts(search_fts, rank) VALUES ('integrity-check', 1)");
  } finally { await f.dispose(); }
});

test('schema upgrade backfills existing work once and index corruption cannot leave a partial migration', async () => {
  const f = fixture();
  try {
    await f.post('bob', 'Backfill comet', 'migration-root');
    const removeSearch = () => {
      for (const { name } of f.sql.exec("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'search_%'")) f.sql.exec(`DROP TRIGGER ${name}`);
      f.sql.exec('DROP TABLE search_fts'); f.sql.exec('DROP TABLE search_records');
      f.sql.exec('DROP TRIGGER agent_access_new_channel');
      f.sql.exec('DROP TRIGGER agent_access_removed_member');
      f.sql.exec('DROP TABLE agent_channel_access');
      f.sql.exec('ALTER TABLE channel_members DROP COLUMN access_grant');
      f.sql.exec("UPDATE meta SET value='5' WHERE key='schema_version'");
    };
    removeSearch();
    const exec = f.ctx.storage.sql.exec;
    f.ctx.storage.sql.exec = (query, ...params) => {
      if (query.startsWith('CREATE VIRTUAL')) throw new Error('migration failure');
      return exec(query, ...params);
    };
    assert.throws(() => f.restart(), /migration failure/);
    f.ctx.storage.sql.exec = exec;
    assert.equal(f.sql.exec("SELECT value FROM meta WHERE key='schema_version'")[0].value, '5');
    assert.equal(f.sql.exec("SELECT name FROM sqlite_master WHERE name='search_records'").length, 0);
    f.restart();
    const read = async () => (await (await f.inside(f.env, 'w', 'watcher', '/search-workspace?q=comet')).json()).items;
    assert.equal((await read()).length, 1);
    f.restart(); assert.equal((await read()).length, 1);
    assert.equal(f.sql.exec('SELECT count(*) AS n FROM search_records WHERE kind=\'message\'')[0].n, 1);
  } finally { await f.dispose(); }
});

test('MCP reads one current message without its thread and denies private, missing and deleted records', async () => {
  const f = fixture();
  try {
    const root = await f.post('bob', 'Original', 'single-root');
    const reply = await f.post('bob', 'Reply', 'single-reply', root.id);
    await f.inside(f.env, 'w', 'bob', `/messages/${reply.id}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Current reply' }) });
    const read = (id, actor) => f.rpc('tools/call', { name: 'read_message', arguments: { message_id: id } }, actor);
    const result = (await read(reply.id)).result.structuredContent.result;
    assert.equal(result.id, reply.id); assert.equal(result.body, 'Current reply');
    assert.equal(result.thread_id, root.id); assert.equal(result.reply_count, 1);
    assert.ok(result.edited_at); assert.equal(result.author.name, 'bob'); assert.equal(result.author.kind, 'human');
    assert.equal(result.url, `https://await.chat/w/w/c?thread=${root.id}`);
    assert.equal(Array.isArray(result), false); assert.equal('replies' in result, false);
    f.sql.exec('DELETE FROM channel_members WHERE channel_id=? AND account_id=?', 'c', 'watcher');
    assert.equal((await read(reply.id)).result.isError, true);
    f.sql.exec('INSERT INTO channel_members(channel_id,account_id) VALUES (?,?)', 'c', 'watcher');
    f.sql.exec('UPDATE messages SET deleted_at=? WHERE id=?', Date.now(), reply.id);
    assert.equal((await read(reply.id)).result.isError, true);
    assert.equal((await read('missing')).result.isError, true);
    const readonly = { accountId: 'watcher', workspaceId: 'w', scopes: ['read'], eventAuthority: f.authority };
    assert.equal((await read(root.id, readonly)).result.structuredContent.result.body, 'Original');
  } finally { await f.dispose(); }
});

test('MCP chat reads support small pages and post links preserve the root thread', async () => {
  const f = fixture();
  try {
    const root = await f.post('bob', 'Root context', 'small-root');
    const replies = [];
    for (let i = 0; i < 4; i++) replies.push(await f.post('bob', `Reply ${i}`, `small-${i}`, root.id));
    const read = async (name, args) => {
      const value = await f.rpc('tools/call', { name, arguments: { channel_id: 'c', ...args } });
      assert.ok(!value.result.isError, JSON.stringify(value));
      return value.result.structuredContent.result;
    };
    assert.equal((await read('read_messages', { limit: 1 })).length, 1);
    const recent = await read('read_thread', { thread_id: root.id, limit: 2 });
    assert.deepEqual(recent.map((message) => message.id), [root.id, replies.at(-1).id]);
    const older = await read('read_thread', { thread_id: root.id, limit: 2, before: replies.at(-1).id });
    assert.equal(older.length, 2);
    assert.ok(older.every((message) => message.id < replies.at(-1).id && message.id !== root.id));
    const post = await f.rpc('tools/call', { name: 'post_message', arguments: { channel_id: 'c', thread_id: root.id, body: 'Verified reply', client_id: 'link-retry' } });
    assert.equal(post.result.structuredContent.result.url, `https://await.chat/w/w/c?thread=${root.id}`);
    const invalid = await f.rpc('tools/call', { name: 'read_messages', arguments: { channel_id: 'c', limit: 51 } });
    assert.equal(invalid.result.isError, true);
  } finally { await f.dispose(); }
});

test('workspace libraries show only joined active channels and remove deleted work and links', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.sql.exec("INSERT INTO channel_members(channel_id,account_id) VALUES ('other-channel','alice')");
    f.sql.exec("UPDATE channels SET is_private=1 WHERE id='other-channel'");
    for (const [id, channel] of [['visible', 'c'], ['private', 'other-channel']]) {
      f.sql.exec('INSERT INTO boards(id,channel_id,name,created_by,created_at) VALUES (?,?,?,?,?)', id, channel, `${id} board`, 'alice', now);
      f.sql.exec('INSERT INTO tasks(id,board_id,title,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', `${id}-task`, id, 'Do work', 'done', 'alice', now, now);
      f.sql.exec('INSERT INTO documents(id,channel_id,title,body,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, channel, `${id} document`, 'Notes', 'alice', 'alice', now, now);
      f.sql.exec('INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES (?,?,?,?,?)', `${id}-root`, channel, 'alice', `https://github.com/team/${id}/pull/1 https://${id}.pages.dev`, now);
      f.sql.exec('INSERT INTO messages(id,channel_id,author_id,body,thread_id,created_at) VALUES (?,?,?,?,?,?)', `${id}-reply`, channel, 'alice', 'Reply', `${id}-root`, now + 1);
    }
    const get = async (actor, path) => (await f.inside(f.env, 'w', actor, path)).json();
    const boards = await get('bob', '/boards');
    assert.deepEqual(boards.map(item => item.id), ['visible']);
    assert.equal(boards[0].task_count, 1); assert.equal(boards[0].completed_count, 1);
    assert.deepEqual((await get('bob', '/documents')).map(item => item.id), ['visible']);
    const overview = await get('bob', '/overview');
    assert.deepEqual(overview.threads.map(item => item.id), ['visible-root']);
    assert.equal(overview.threads[0].reply_count, 1);
    assert.deepEqual(overview.links.map(item => item.kind), ['git', 'artifact']);
    assert.equal((await get('alice', '/overview')).links.length, 4);
    f.sql.exec("UPDATE messages SET deleted_at=? WHERE id='visible-root'", now);
    assert.equal((await get('bob', '/overview')).links.length, 0);
    assert.equal((await get('bob', '/overview')).threads.length, 0);
    f.sql.exec("UPDATE channels SET archived_at=? WHERE id='c'", now);
    assert.equal((await get('bob', '/boards')).length, 0);
    assert.equal((await get('bob', '/documents')).length, 0);
    assert.equal((await f.inside(f.env, 'w', 'outsider', '/overview')).ok, false);
  } finally { await f.dispose(); }
});


test('work links recognize Git and Cloudflare previews without accepting spoofed hosts or credentials', () => {
  assert.deepEqual(workLinks('[PR](https://github.com/team/app/pull/42) Preview: https://demo.pages.dev.').map(link => link.kind), ['git', 'artifact']);
  assert.equal(workLinks('https://github.com/team/app https://github.com/team/app').length, 1);
  assert.equal(workLinks('https://github.com.evil.example/team https://github.com@evil.example/app https://user:secret@github.com/team https://demo.pages.dev.evil.example http://demo.pages.dev').length, 0);
  assert.equal(workLinks('https://github.com/team/%E0%A4%A https://demo.workers.dev').length, 1);
});

test('shared repositories read as their kind until a preview reports their title', () => {
  const id = 'df205081-a4c2-427c-992c-2e49be2ecbf1';
  const named = (repository) => artifactName(workLinks(`https://${'a'.repeat(32)}.artifacts.cloudflare.net/git/space/w-${repository}.git`)[0], 'w');
  assert.deepEqual(named(`p-${id}`), { name: `p-${id}`, kind: 'Project repository' });
  assert.deepEqual(named(`r-${id}`), { name: `r-${id}`, kind: 'Agent workspace' });
  assert.deepEqual(named(`p-${id}-check`), { name: `p-${id}-check`, kind: 'Integration check' });
  assert.deepEqual(named('landing-page'), { name: 'landing-page', kind: null });
});


test('HTML artifacts give MCP reviewers pinned source as well as a browser preview, with a source limit', async () => {
  const f = fixture();
  try {
    const account = 'a'.repeat(32), commit = 'b'.repeat(40);
    const remote = `https://${account}.artifacts.cloudflare.net/git/workspace-artifacts/w-review.git`;
    const grants = new Map();
    let html = '<!doctype html><html><body><button>Try the demo</button></body></html>';
    f.env.ARTIFACT_ACCOUNT_ID = account; f.env.ARTIFACT_NAMESPACE = 'workspace-artifacts';
    f.env.OAUTH_KV = { put: async (key, value) => grants.set(key, JSON.parse(value)) };
    f.env.ARTIFACTS = { get: async () => ({
      info: async () => ({ name: 'w-review', defaultBranch: 'main' }),
      log: async () => [{ hash: commit, treeHash: 'c'.repeat(40) }],
      readTree: async () => [{ name: 'index.html', type: 'blob' }],
      readFile: async ({ ref, path }) => { assert.equal(ref, commit); assert.equal(path, 'index.html'); return new Blob([html]); },
      [Symbol.dispose]: () => {},
    }) };
    f.sql.exec("INSERT INTO artifact_repositories(name,channel_id,created_by,created_at) VALUES('w-review','c','alice',?)", Date.now());
    const message = await f.post('alice', remote, 'html-review');
    const result = await artifactContents(f.env, f.inside, 'w', 'bob', message.id, remote, commit, 'index.html');
    assert.equal(result.content, html);
    assert.equal(result.contentTruncated, false);
    assert.equal(result.commit, commit);
    assert.match(result.previewUrl, /^\/api\/artifact-previews\/[a-f0-9-]+\/files\/index\.html$/);
    assert.equal([...grants.values()][0].commit, commit);
    html += 'x'.repeat(200_000);
    const large = await artifactContents(f.env, f.inside, 'w', 'bob', message.id, remote, commit, 'index.html');
    assert.equal(large.content.length, 200_000);
    assert.equal(large.contentTruncated, true);
    assert.equal(large.content, html.slice(0, 200_000));
    assert.ok(large.previewUrl);
  } finally { await f.dispose(); }
});

test('native artifact previews pin commits, require a current shared message and revoke with access', async () => {
  const f = fixture();
  try {
    const account = 'a'.repeat(32), remote = `https://${account}.artifacts.cloudflare.net/git/workspace-artifacts/w-project.git`;
    const values = new Map(); let reads = 0, disposed = 0;
    f.env.ARTIFACT_ACCOUNT_ID = account; f.env.ARTIFACT_NAMESPACE = 'workspace-artifacts';
    f.env.OAUTH_KV = { put: async (key, value) => values.set(key, value), get: async (key) => values.get(key) ?? null };
    f.env.ARTIFACTS = { get: async (name) => { assert.equal(name, 'w-project'); return {
      info: async () => ({ name, description: null, defaultBranch: 'main' }),
      log: async () => [{ hash: 'b'.repeat(40), treeHash: 'c'.repeat(40) }],
      readTree: async () => [{ name: 'README.md', type: 'blob' }],
      readFile: async ({ ref, path }) => { reads++; assert.equal(ref, 'b'.repeat(40)); assert.equal(path, 'README.md'); return new Blob(['# Shared project'], { type: 'text/plain' }); },
      [Symbol.dispose]: () => { disposed++; },
    }; } };
    f.sql.exec("INSERT INTO artifact_repositories(name,channel_id,created_by,created_at) VALUES('w-project','c','alice',?)", Date.now());
    const root = await f.post('alice', 'Review the artifact', 'artifact-root');
    const reply = await f.post('alice', remote, 'artifact-reply', root.id);
    const data = await artifactContents(f.env, f.inside, 'w', 'bob', reply.id, remote);
    assert.equal(data.commit, 'b'.repeat(40)); assert.equal(data.content, '# Shared project'); assert.equal(disposed, 1);
    assert.equal(data.title, 'project', 'a repository outside projects keeps its name');
    await assert.rejects(artifactContents(f.env, f.inside, 'w', 'bob', root.id, remote), /no longer shared/);
    f.sql.exec("UPDATE messages SET body='Link withdrawn' WHERE id=?", reply.id);
    await assert.rejects(artifactContents(f.env, f.inside, 'w', 'bob', reply.id, remote), /no longer shared/);
    f.sql.exec('UPDATE messages SET body=? WHERE id=?', remote, reply.id);
    f.sql.exec("DELETE FROM channel_members WHERE channel_id='c' AND account_id='bob'");
    await assert.rejects(artifactContents(f.env, f.inside, 'w', 'bob', reply.id, remote), /no longer shared/);
    assert.equal(reads, 1);
    // A known remote reposted elsewhere cannot widen the original channel's access.
    f.sql.exec("INSERT INTO channel_members(channel_id,account_id) VALUES('other-channel','bob')");
    const copied = await f.inside(f.env, 'w', 'bob', '/channels/other-channel/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: remote }) });
    const copiedMessage = await copied.json();
    await assert.rejects(artifactContents(f.env, f.inside, 'w', 'bob', copiedMessage.id, remote), /not shared with your channels/);
    const ticket = '11111111-1111-1111-1111-111111111111';
    values.set(`artifact-preview:${ticket}`, JSON.stringify({ workspaceId: 'w', accountId: 'bob', messageId: reply.id, url: remote, repository: 'w-project', commit: 'b'.repeat(40), expiresAt: Date.now() + 10000 }));
    assert.equal((await artifactFile(f.env, f.inside, ticket, 'README.md')).status, 404);
    f.sql.exec("INSERT INTO channel_members(channel_id,account_id) VALUES('c','bob')");
    f.sql.exec('UPDATE messages SET deleted_at=? WHERE id=?', Date.now(), reply.id);
    assert.equal((await artifactFile(f.env, f.inside, ticket, 'README.md')).status, 404);
    f.sql.exec('UPDATE messages SET deleted_at=NULL WHERE id=?', reply.id);
    f.env.ARTIFACT_NAMESPACE = 'different-namespace';
    await assert.rejects(artifactContents(f.env, f.inside, 'w', 'bob', reply.id, remote), /not connected/);
    for (const path of ['../secret', '/index.html', 'a/../b', 'a\\b', 'a//b', '']) assert.throws(() => artifactPath(path));
  } finally { await f.dispose(); }
});

test('artifact creation requires file and post scopes plus channel and agent write permission before Cloudflare', async () => {
  const f = fixture();
  try {
    let calls = 0; f.env.ARTIFACTS = { create: async () => { calls++; throw new Error('unexpected create'); } };
    const args = { name: 'create_artifact_repository', arguments: { channel_id: 'c', name: 'project' } };
    assert.ok((await f.rpc('tools/call', args)).result.isError);
    const actor = { accountId: 'watcher', workspaceId: 'w', scopes: ['read', 'post', 'files'] };
    f.sql.exec("UPDATE members SET paused=1 WHERE account_id='watcher'");
    assert.ok((await f.rpc('tools/call', args, actor)).result.isError);
    f.sql.exec("UPDATE members SET paused=0,approval_mode=1 WHERE account_id='watcher'");
    assert.ok((await f.rpc('tools/call', args, actor)).result.isError);
    f.sql.exec("UPDATE members SET approval_mode=0 WHERE account_id='watcher'");
    assert.ok((await f.rpc('tools/call', { ...args, arguments: { ...args.arguments, channel_id: 'other-channel' } }, actor)).result.isError);
    assert.equal(calls, 0);
  } finally { await f.dispose(); }
});

test('Artifacts remotes reject credential links, foreign URL shapes and lookalike domains', () => {
  const host = `${'a'.repeat(32)}.artifacts.cloudflare.net`;
  assert.equal(workLinks(`https://${host}/git/workspace-artifacts/project.git`)[0].preview, 'repository');
  for (const url of [`https://token@${host}/git/n/r.git`, `https://${host}/git/n/r.git?token=secret`, `https://${host}.evil.com/git/n/r.git`, `https://${host}/git/n/r.git#fragment`, `https://${host}/git/n/r`]) assert.deepEqual(workLinks(url), []);
});


test('event watch labels distinguish queued, retrying, paused, stopped and expired delivery', () => {
  const now = 1000;
  const monitoring = { active: true, paused: false, pending: 0, expires_at: 2000, last_error: null };
  assert.equal(eventWatchStatus(monitoring, now).label, 'Monitoring');
  assert.equal(eventWatchStatus({ ...monitoring, pending: 1 }, now).label, 'Queued');
  assert.deepEqual(eventWatchStatus({ ...monitoring, pending: 1, last_error: 'HTTP 503' }, now), { label: 'Retrying', tone: 'warning' });
  assert.equal(eventWatchStatus({ ...monitoring, paused: true, last_error: 'HTTP 503' }, now).label, 'Paused');
  assert.equal(eventWatchStatus({ ...monitoring, active: false, last_error: 'Stopped monitoring.' }, now).label, 'Stopped');
  assert.equal(eventWatchStatus({ ...monitoring, active: false, expires_at: 500 }, now).label, 'Expired');
  assert.equal(eventWatchStatus({ ...monitoring, active: false, expires_at: 500, last_error: 'Stopped monitoring.' }, now).label, 'Stopped');
  assert.equal(eventWatchStatus({ ...monitoring, active: false, last_error: 'Subscription expired.' }, now).label, 'Expired');
});

function projectArtifacts(f) {
  const root = 'a'.repeat(40), head = 'b'.repeat(40), foreign = 'c'.repeat(40);
  const rootTree = 'd'.repeat(40), headTree = 'e'.repeat(40);
  const repos = new Map([['w-source', { branch: 'main', head: root }]]), tokens = [], revoked = [];
  f.sql.exec("INSERT INTO artifact_repositories VALUES('w-source','c','alice',1)");
  f.env.ARTIFACTS = {
    get: async (name) => {
      if (!repos.has(name)) throw new Error('Missing repository');
      return {
        info: async () => ({ name, defaultBranch: 'main', remote: `https://example.artifacts.cloudflare.net/git/test/${name}.git` }),
        fork: async (target) => { assert.ok(!repos.has(target)); repos.set(target, { ...repos.get(name) }); return { name: target, token: `initial-${target}` }; },
        revokeToken: async (token) => { revoked.push(token); return true; },
        createToken: async (scope, ttl) => { tokens.push({ name, scope, ttl }); return { id: 'issued-token', plaintext: 'private-token', expiresAt: '2026-10-11' }; },
        log: async () => [{ hash: repos.get(name).head }],
        readCommit: async (hash) => hash === root ? { hash, treeHash: rootTree, parents: [] } : hash === head ? { hash, treeHash: headTree, parents: [root] } : hash === foreign ? { hash, treeHash: headTree, parents: [] } : null,
        readTree: async (hash) => [{ name: 'auth.ts', type: 'blob', hash: hash === rootTree ? '1'.repeat(40) : '2'.repeat(40), size: 26 }],
        readBlob: async (hash) => new Blob([hash === '1'.repeat(40) ? 'export const expiry = 0;' : 'export const expiry = 900;']),
        readFile: async ({ ref }) => new Blob([ref === root ? 'export const expiry = 0;' : 'export const expiry = 900;']),
        [Symbol.dispose]() {},
      };
    },
  };
  const request = async (actor, path, body) => {
    const response = await f.inside(f.env, 'w', actor, path, body ? { method: 'POST', body: JSON.stringify(body) } : {});
    return { status: response.status, data: await response.json() };
  };
  const create = async () => { const input = { client_id: crypto.randomUUID(), channel_id: 'c', title: 'Reset passwords', goal: 'API and UI agree on expiry.', repository: 'w-source' }; const result = await request('alice', '/projects', input); assert.equal(result.status, 201, JSON.stringify(result)); return { project: result.data, input }; };
  return { root, head, foreign, repos, tokens, revoked, request, create };
}

test('projects isolate forks, verify ancestry, surface overlap, replay across restart, and pin human reviews', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project, input } = await a.create();
    assert.equal((await a.request('alice', '/projects', input)).data.id, project.id);
    assert.ok(a.revoked.includes(`initial-${project.repository}`));
    const start = async (actor, paths) => {
      const result = await a.request(actor, `/projects/${project.id}/runs`, { client_id: crypto.randomUUID(), title: actor, paths });
      assert.equal(result.status, 201, JSON.stringify(result)); return result.data;
    };
    const [one, two] = await Promise.all([start('watcher', ['src/auth']), start('other-agent', ['src/auth/session.ts'])]);
    assert.notEqual(one.repository, two.repository); assert.notEqual(one.repository, project.repository);
    // Previews name a project repository after its project and a workspace after its run.
    const titled = async (repository) => (await (await f.inside(f.env, 'w', 'alice', `/artifact-repositories/${repository}`)).json()).title;
    assert.equal(await titled(project.repository), input.title);
    assert.equal(await titled(one.repository), 'watcher');
    let detail = (await a.request('watcher', `/projects/${project.id}`)).data;
    assert.ok(detail.events.some((event) => event.type === 'scope.overlap'));
    const cursor = detail.next_cursor;
    const note = { client_id: crypto.randomUUID(), body: 'Token expiry is 15 minutes.' };
    await a.request('watcher', `/projects/${project.id}/events`, note); await a.request('watcher', `/projects/${project.id}/events`, note);
    assert.equal((await a.request('watcher', `/projects/${project.id}/events`, { ...note, body: 'Changed' })).status, 400);
    assert.equal((await a.request('other-agent', `/projects/${project.id}/runs/${one.id}/token`, {})).status, 403);
    assert.equal(a.tokens.length, 0);
    const grant = (await a.request('watcher', `/projects/${project.id}/runs/${one.id}/token`, {})).data;
    assert.equal(grant.token, 'private-token');
    assert.equal(grant.branch, one.branch, 'Local contributors must receive their assigned attempt branch.');
    assert.notEqual(grant.branch, project.branch);
    assert.deepEqual(a.tokens, [{ name: one.repository, scope: 'write', ttl: 900 }]);
    const checkpoint = { client_id: crypto.randomUUID(), expected_revision: one.revision, status: 'sleeping', checkpoint: 'Awaiting the expiry contract.', cursor };
    assert.equal((await a.request('watcher', `/projects/${project.id}/runs/${one.id}/checkpoint`, checkpoint)).status, 200);
    f.restart();
    detail = (await a.request('watcher', `/projects/${project.id}?after=${cursor}`)).data;
    assert.equal(detail.events.filter((e) => e.type === 'coordination.note').length, 1);
    assert.equal(detail.runs.find((r) => r.id === one.id).checkpoint, checkpoint.checkpoint);
    assert.equal((await a.request('watcher', `/projects/${project.id}/runs/${one.id}/checkpoint`, { ...checkpoint, client_id: crypto.randomUUID(), expected_revision: 2, cursor: cursor - 1 })).status, 400);
    const route = `/projects/${project.id}/runs/${one.id}/candidates`;
    for (const commit of ['f'.repeat(40), a.root, a.foreign]) assert.equal((await a.request('watcher', route, { commit, requirements_revision: 1, summary: 'Unverified' })).status, 400);
    const [published, retried] = await Promise.all([a.request('watcher', route, { commit: a.head, requirements_revision: 1, summary: 'API ready', checks: 'node --test: passed (reported)' }), a.request('watcher', route, { commit: a.head, requirements_revision: 1, summary: 'API ready', checks: 'node --test: passed (reported)' })]);
    assert.equal(published.data.id, retried.data.id);
    const candidate = published.data;
    const files = (await a.request('alice', `/projects/${project.id}/runs/${one.id}/files?commit=${a.head}&path=auth.ts`)).data;
    assert.equal(files.commit, a.head); assert.equal(files.before, 'export const expiry = 0;'); assert.equal(files.after, 'export const expiry = 900;');
    assert.equal((await a.request('alice', `/projects/${project.id}/runs/${one.id}/files?commit=${a.head}&path=../secret`)).status, 400);
    const review = `/projects/${project.id}/candidates/${candidate.id}/review`;
    assert.equal((await a.request('watcher', review, { client_id: crypto.randomUUID(), expected_revision: 1, requirements_revision: 1, commit: a.head, status: 'approved' })).status, 400);
    assert.equal((await a.request('alice', review, { client_id: crypto.randomUUID(), expected_revision: 1, requirements_revision: 1, commit: a.foreign, status: 'approved' })).status, 400);
    assert.equal((await a.request('alice', review, { client_id: crypto.randomUUID(), expected_revision: 1, requirements_revision: 1, commit: a.head, status: 'changes_requested' })).status, 400);
    assert.equal((await a.request('alice', review, { client_id: crypto.randomUUID(), expected_revision: 1, requirements_revision: 1, commit: a.head, status: 'approved', note: 'Reviewed expiry handling.' })).data.status, 'approved');
    assert.equal(a.repos.get(project.repository).head, a.root);
    f.sql.exec("DELETE FROM channel_members WHERE account_id='watcher'");
    assert.equal((await a.request('watcher', `/projects/${project.id}`)).status, 400);
    assert.equal((await a.request('watcher', '/projects')).data.projects.length, 0);
  } finally { await f.dispose(); }
});

test('project MCP tools enforce scopes, pause/approval gates and durable project update delivery', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create();
    const actor = { accountId: 'watcher', workspaceId: 'w', scopes: ['read', 'post', 'files'] };
    const args = { name: 'start_project_run', arguments: { project_id: project.id, client_id: crypto.randomUUID(), title: 'API', paths: ['src'] } };
    for (const scopes of [['read'], ['read', 'post'], ['post', 'files']]) assert.ok((await f.rpc('tools/call', args, { ...actor, scopes })).result.isError);
    f.sql.exec("UPDATE members SET paused=1 WHERE account_id='watcher'");
    assert.ok((await f.rpc('tools/call', args, actor)).result.isError);
    f.sql.exec("UPDATE members SET paused=0,approval_mode=1 WHERE account_id='watcher'");
    assert.ok((await f.rpc('tools/call', args, actor)).result.isError);
    f.sql.exec("UPDATE members SET approval_mode=0 WHERE account_id='watcher'");
    const result = await f.rpc('tools/call', args, actor); assert.ok(!result.result.isError, JSON.stringify(result));
    await f.inside(f.env, 'w', 'alice', '/agents/other-agent/listening/c', { method: 'PUT', body: JSON.stringify({ level: 'activity', include_agent_authors: true }) });
    await a.request('watcher', `/projects/${project.id}/events`, { client_id: crypto.randomUUID(), body: 'A durable contract proposal.' });
    f.restart();
    const inbox = await f.inside(f.env, 'w', 'other-agent', '/agent-events');
    const events = (await inbox.json()).events;
    assert.ok(events.some((event) => event.name === 'project.updated' && event.data.project_id === project.id));
    const info = (await f.inside(f.env, 'w', 'watcher', `/artifact-repositories/${project.repository}`));
    assert.equal((await info.json()).managed, true);
  } finally { await f.dispose(); }
});

test('project provisioning rechecks authorization after remote work and keeps failures inspectable', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create();
    const get = f.env.ARTIFACTS.get;
    f.env.ARTIFACTS.get = async (name) => {
      const repo = await get(name), fork = repo.fork;
      repo.fork = async (...args) => { const result = await fork(...args); f.sql.exec("DELETE FROM channel_members WHERE account_id='watcher'"); return result; };
      return repo;
    };
    const runId = crypto.randomUUID();
    assert.equal((await a.request('watcher', `/projects/${project.id}/runs`, { client_id: runId, title: 'Lost access', paths: [] })).status, 400);
    assert.equal(f.sql.exec('SELECT status FROM project_runs WHERE id=?', runId)[0].status, 'failed');
    assert.equal(a.tokens.length, 0);
  } finally { await f.dispose(); }
});

test('project upgrade repairs the missing legacy artifact registry without losing workspace content', async () => {
  const f = fixture();
  try {
    await f.post('alice', 'Retain this older conversation.', 'before-project-upgrade');
    f.sql.exec('DROP TABLE artifact_repositories');
    f.sql.exec("UPDATE meta SET value='8' WHERE key='schema_version'");
    f.restart();
    assert.equal(f.sql.exec("SELECT value FROM meta WHERE key='schema_version'")[0].value, '17');
    assert.equal(f.sql.exec("SELECT body FROM messages WHERE client_id='before-project-upgrade'")[0].body, 'Retain this older conversation.');
    const response = await f.inside(f.env, 'w', 'alice', '/projects');
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).repositories, []);
    f.restart();
    assert.equal(f.sql.exec("SELECT body FROM messages WHERE client_id='before-project-upgrade'").length, 1);
  } finally { await f.dispose(); }
});

test('project cursors paginate without gaps and coordination failure rolls back the ledger', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create();
    for (let n = 0; n < 103; n++) await a.request('watcher', `/projects/${project.id}/events`, { client_id: crypto.randomUUID(), body: `Decision ${n}` });
    const page = (await a.request('watcher', `/projects/${project.id}`)).data;
    const rest = (await a.request('watcher', `/projects/${project.id}?after=${page.next_cursor}`)).data;
    assert.equal(page.events.length, 100); assert.equal(page.has_more, true); assert.equal(rest.events.length, 4); assert.equal(rest.has_more, false);
    assert.equal(new Set([...page.events, ...rest.events].map((e) => e.seq)).size, 104);
    assert.equal((await a.request('watcher', `/projects/${project.id}?after=-1`)).status, 400);
    const exec = f.ctx.storage.sql.exec;
    f.ctx.storage.sql.exec = (query, ...args) => { if (query.startsWith('UPDATE projects SET updated_at=')) throw new Error('Storage fault'); return exec(query, ...args); };
    const result = await a.request('watcher', `/projects/${project.id}/events`, { client_id: crypto.randomUUID(), body: 'Must roll back.' });
    assert.equal(result.status, 400);
    f.ctx.storage.sql.exec = exec;
    assert.equal(f.sql.exec('SELECT COUNT(*) AS n FROM project_events WHERE project_id=?', project.id)[0].n, 104);
  } finally { await f.dispose(); }
});

test('project requirements use revision preconditions, preserve decisions, and invalidate exact reviews', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create(), base = `/projects/${project.id}`;
    const run = (await a.request('watcher', `${base}/runs`, { client_id: crypto.randomUUID(), title: 'API', paths: [] })).data;
    const candidate = (await a.request('watcher', `${base}/runs/${run.id}/candidates`, { requirements_revision: 1, commit: a.head, summary: 'Ready', checks: 'Reported only' })).data;
    const review = { client_id: crypto.randomUUID(), expected_revision: 1, requirements_revision: 1, commit: a.head, status: 'approved', note: 'Reviewed r1' };
    assert.equal((await a.request('alice', `${base}/candidates/${candidate.id}/review`, review)).data.revision, 2);
    assert.equal((await a.request('alice', `${base}/candidates/${candidate.id}/review`, review)).data.revision, 2);
    const raced = await a.request('bob', `${base}/candidates/${candidate.id}/review`, { ...review, client_id: crypto.randomUUID() });
    assert.equal(raced.status, 409); assert.equal(raced.data.current.revision, 2);
    const change = { client_id: crypto.randomUUID(), expected_revision: 1, title: project.title, goal: project.goal, acceptance_criteria: 'Tokens expire after 7 days. Invalid timestamps fail closed.', reason: 'Product clarified expiry.' };
    assert.equal((await a.request('watcher', `${base}/requirements`, change)).status, 400);
    const updated = await a.request('alice', `${base}/requirements`, change);
    assert.equal(updated.data.revision, 2);
    assert.deepEqual((await a.request('alice', `${base}/requirements`, change)).data, updated.data);
    assert.equal((await a.request('alice', `${base}/requirements`, { ...change, reason: 'Another reason' })).status, 409);
    const conflict = await a.request('bob', `${base}/requirements`, { ...change, client_id: crypto.randomUUID() });
    assert.equal(conflict.status, 409); assert.equal(conflict.data.current.acceptance_criteria, change.acceptance_criteria);
    const detail = (await a.request('alice', base)).data;
    assert.equal(detail.requirements.length, 2); assert.equal(detail.requirements[0].goal, project.goal);
    assert.equal(detail.candidates[0].status, 'stale'); assert.equal(detail.candidates[0].review_note, 'Reviewed r1');
    assert.equal(detail.events.filter(e => e.type === 'candidate.reviewed').length, 1);
    assert.equal(detail.events.find(e => e.type === 'candidate.reviewed').data.requirements_revision, 1);
    assert.equal((await a.request('alice', `${base}/candidates/${candidate.id}/review`, { ...review, client_id: crypto.randomUUID(), expected_revision: 3, requirements_revision: 2 })).status, 400);
    assert.equal((await a.request('watcher', `${base}/runs/${run.id}/candidates`, { requirements_revision: 1, commit: a.head, summary: 'Ready', checks: 'Reported only' })).status, 400);
    const next = (await a.request('other-agent', `${base}/runs`, { client_id: crypto.randomUUID(), title: 'Revised API', paths: [] })).data;
    assert.equal(next.requirements_revision, 2);
    f.restart();
    const packet = (await a.request('other-agent', `${base}/handoff`)).data;
    assert.equal(packet.format, 'await.handoff.v1'); assert.equal(packet.project.revision, 2); assert.equal(packet.requirements.length, 2);
    assert.equal(packet.candidates[0].status, 'stale'); assert.equal(packet.snapshot_cursor, packet.recent_events.at(-1).seq);
    assert.ok(!JSON.stringify(packet).includes('private-token'));
    f.sql.exec("DELETE FROM channel_members WHERE account_id='other-agent'");
    assert.equal((await a.request('other-agent', `${base}/handoff`)).status, 400);
  } finally { await f.dispose(); }
});

test('project checkpoints detect stale writes and cancellation fences tokens and late candidates', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create(), base = `/projects/${project.id}`;
    const run = (await a.request('watcher', `${base}/runs`, { client_id: crypto.randomUUID(), title: 'API', paths: [] })).data;
    const route = `${base}/runs/${run.id}`;
    const checkpoint = { client_id: crypto.randomUUID(), expected_revision: 1, status: 'sleeping', checkpoint: 'Resume at tests.', cursor: 0 };
    assert.equal((await a.request('watcher', `${route}/checkpoint`, checkpoint)).data.revision, 2);
    assert.equal((await a.request('watcher', `${route}/checkpoint`, checkpoint)).data.revision, 2);
    assert.equal((await a.request('watcher', `${route}/checkpoint`, { ...checkpoint, client_id: crypto.randomUUID(), checkpoint: 'Old session overwrites' })).status, 409);
    await a.request('watcher', `${route}/token`, {});
    const cancel = { client_id: crypto.randomUUID(), expected_revision: 2, reason: 'Hand off to another teammate.' };
    assert.equal((await a.request('other-agent', `${route}/cancel`, cancel)).status, 403);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const get = f.env.ARTIFACTS.get;
    f.env.ARTIFACTS.get = async (name) => { const repo = await get(name), read = repo.readCommit; repo.readCommit = async (hash) => { entered(); await gate; return read(hash); }; return repo; };
    const pending = a.request('watcher', `${route}/candidates`, { requirements_revision: 1, commit: a.head, summary: 'Late result' });
    await started;
    const cancelled = await a.request('alice', `${route}/cancel`, cancel);
    assert.equal(cancelled.data.status, 'cancelled'); assert.ok(a.revoked.includes('issued-token'));
    release();
    assert.equal((await pending).status, 400);
    assert.deepEqual((await a.request('alice', `${route}/cancel`, cancel)).data, cancelled.data);
    f.restart();
    assert.equal((await a.request('watcher', `${route}/token`, {})).status, 400);
    assert.equal((await a.request('watcher', `${route}/checkpoint`, { ...checkpoint, client_id: crypto.randomUUID(), expected_revision: 3 })).status, 400);
    const detail = (await a.request('alice', base)).data;
    assert.equal(detail.candidates.length, 0); assert.equal(detail.runs[0].checkpoint, 'Resume at tests.'); assert.equal(detail.events.filter(e => e.type === 'run.cancelled').length, 1);
  } finally { await f.dispose(); }
});

test('project cancellation while token issuance waits revokes the new token before returning it', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create(), base = `/projects/${project.id}`;
    const run = (await a.request('watcher', `${base}/runs`, { client_id: crypto.randomUUID(), title: 'API', paths: [] })).data;
    const route = `${base}/runs/${run.id}`;
    const get = f.env.ARTIFACTS.get;
    f.env.ARTIFACTS.get = async (name) => { const repo = await get(name), create = repo.createToken; repo.createToken = async (...args) => { await a.request('alice', `${route}/cancel`, { client_id: crypto.randomUUID(), expected_revision: 1, reason: 'Stop this attempt.' }); return create(...args); }; return repo; };
    const result = await a.request('watcher', `${route}/token`, {});
    assert.equal(result.status, 400); assert.ok(!result.data.token); assert.ok(a.revoked.includes('issued-token'));
  } finally { await f.dispose(); }
});

test('project event pages preserve compact and legacy defaults, traversal, and future cursor recovery', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create(), base = `/projects/${project.id}`;
    const longBody = 'complete-note-' + 'x'.repeat(2048);
    for (let n = 0; n < 104; n++) f.sql.exec(
      'INSERT INTO project_events(id,project_id,actor_id,type,run_id,data,client_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
      crypto.randomUUID(), project.id, 'watcher', 'coordination.note', null,
      JSON.stringify({ body: n === 17 ? longBody : `Page note ${n}` }), crypto.randomUUID(), Date.now() + n);
    const expected = f.sql.exec('SELECT seq FROM project_events WHERE project_id=? ORDER BY seq', project.id).map(row => row.seq);

    const compact = (await a.request('watcher', `${base}?include_job_output=false`)).data;
    assert.equal(compact.events.length, 20); assert.equal(compact.has_more, true);
    assert.equal(compact.events.find(event => event.data.body === longBody)?.data.body, longBody);
    const legacy = (await a.request('watcher', base)).data;
    assert.equal(legacy.events.length, 100); assert.equal(legacy.has_more, true);
    const explicit = (await a.request('watcher', `${base}?include_job_output=false&event_limit=7`)).data;
    assert.equal(explicit.events.length, 7); assert.equal(explicit.has_more, true);
    assert.equal((await a.request('watcher', `${base}?event_limit=101`)).status, 400);
    assert.equal((await a.request('watcher', `${base}?event_limit=0`)).status, 400);

    const seen = []; let after = 0, page;
    do {
      page = (await a.request('watcher', `${base}?include_job_output=false&event_limit=20&after=${after}`)).data;
      seen.push(...page.events.map(event => event.seq));
      after = page.next_cursor;
    } while (page.has_more);
    assert.deepEqual(seen, expected);

    const future = (await a.request('watcher', `${base}?include_job_output=false&after=999999999`)).data;
    assert.deepEqual(future.events, []); assert.equal(future.has_more, false);
    assert.equal(future.next_cursor, future.snapshot_cursor);
    await a.request('watcher', `${base}/events`, { client_id: crypto.randomUUID(), body: 'Visible after future cursor recovery' });
    const recovered = (await a.request('watcher', `${base}?include_job_output=false&after=${future.next_cursor}`)).data;
    assert.equal(recovered.events.length, 1);
    assert.equal(recovered.events[0].data.body, 'Visible after future cursor recovery');
  } finally { await f.dispose(); }
});

test('project handoff paginates context honestly and requirement failure rolls back revisions', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create(), base = `/projects/${project.id}`;
    for (let n = 0; n < 101; n++) await a.request('watcher', `${base}/events`, { client_id: crypto.randomUUID(), body: `Note ${n}` });
    const packet = (await a.request('alice', `${base}/handoff`)).data;
    assert.equal(packet.recent_events.length, 100); assert.equal(packet.history_truncated, true);
    assert.equal(packet.snapshot_cursor, packet.recent_events.at(-1).seq);
    await a.request('watcher', `${base}/events`, { client_id: crypto.randomUUID(), body: 'After snapshot' });
    assert.equal((await a.request('watcher', `${base}?after=${packet.snapshot_cursor}`)).data.events[0].data.body, 'After snapshot');
    const exec = f.ctx.storage.sql.exec;
    f.ctx.storage.sql.exec = (query, ...args) => { if (query.startsWith('INSERT INTO project_events(')) throw new Error('Storage fault'); return exec(query, ...args); };
    const result = await a.request('alice', `${base}/requirements`, { client_id: crypto.randomUUID(), expected_revision: 1, title: project.title, goal: project.goal, acceptance_criteria: 'New criteria', reason: 'Test rollback' });
    f.ctx.storage.sql.exec = exec;
    assert.equal(result.status, 400);
    const detail = (await a.request('alice', base)).data;
    assert.equal(detail.project.revision, 1); assert.equal(detail.requirements.length, 1);
    assert.equal(f.sql.exec('SELECT COUNT(*) AS n FROM project_commands')[0].n, 0);
  } finally { await f.dispose(); }
});

test('ticket and legacy sockets cannot mutate, while explicit browser sockets retain chat writes', async () => {
  const f = fixture();
  try {
    const messages = [];
    const socket = (attachment) => ({ deserializeAttachment: () => attachment, send: (data) => messages.push(JSON.parse(data)), close() {} });
    for (const attachment of [{ accountId: 'watcher', canWrite: false }, { accountId: 'alice' }]) {
      await f.workspace.webSocketMessage(socket(attachment), JSON.stringify({ type: 'send', channel_id: 'c', body: 'Forbidden' }));
      assert.match(messages.at(-1).error, /receive-only/);
      await f.workspace.webSocketMessage(socket(attachment), JSON.stringify({ type: 'sync', after: '' }));
      assert.equal(messages.at(-1).type, 'sync');
    }
    assert.equal(f.sql.exec('SELECT COUNT(*) AS n FROM messages')[0].n, 0);
    await f.workspace.webSocketMessage(socket({ accountId: 'alice', canWrite: true }), JSON.stringify({ type: 'send', channel_id: 'c', body: 'Browser chat', client_id: 'browser-chat' }));
    assert.equal(messages.at(-1).type, 'ack'); assert.equal(f.sql.exec('SELECT COUNT(*) AS n FROM messages')[0].n, 1);
  } finally { await f.dispose(); }
});

test('project MCP conflicts carry the current record and read-only handoffs require channel access', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create();
    const run = (await a.request('watcher', `/projects/${project.id}/runs`, { client_id: crypto.randomUUID(), title: 'API', paths: [] })).data;
    const actor = { accountId: 'watcher', workspaceId: 'w', scopes: ['read', 'post'] };
    const args = { project_id: project.id, run_id: run.id, client_id: crypto.randomUUID(), expected_revision: 999, status: 'sleeping', checkpoint: 'Old session' };
    const conflict = (await f.rpc('tools/call', { name: 'checkpoint_project_run', arguments: args }, actor)).result;
    assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.status, 409); assert.equal(conflict.structuredContent.current.revision, 1);
    assert.ok((await f.rpc('tools/call', { name: 'cancel_project_run', arguments: { project_id: project.id, run_id: run.id, client_id: crypto.randomUUID(), expected_revision: 1, reason: 'Stop' } }, { ...actor, scopes: ['read'] })).result.isError);
    const handoff = await f.rpc('tools/call', { name: 'read_project_handoff', arguments: { project_id: project.id } }, { ...actor, scopes: ['read'] });
    assert.equal(handoff.result.structuredContent.result.project.id, project.id);
    f.sql.exec("DELETE FROM channel_members WHERE account_id='watcher'");
    assert.ok((await f.rpc('tools/call', { name: 'read_project_handoff', arguments: { project_id: project.id } }, { ...actor, scopes: ['read'] })).result.isError);
  } finally { await f.dispose(); }
});

test('project publication rejects a requirements change while ancestry verification is in flight', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create(), base = `/projects/${project.id}`;
    const run = (await a.request('watcher', `${base}/runs`, { client_id: crypto.randomUUID(), title: 'API', paths: [] })).data;
    const get = f.env.ARTIFACTS.get; let changed = false;
    f.env.ARTIFACTS.get = async (name) => { const repo = await get(name), read = repo.readCommit; repo.readCommit = async (hash) => { if (!changed) { changed = true; await a.request('alice', `${base}/requirements`, { client_id: crypto.randomUUID(), expected_revision: 1, title: project.title, goal: project.goal, acceptance_criteria: 'Changed while checking.', reason: 'New decision' }); } return read(hash); }; return repo; };
    const result = await a.request('watcher', `${base}/runs/${run.id}/candidates`, { requirements_revision: 1, commit: a.head, summary: 'Late revision 1 result' });
    assert.equal(result.status, 400); assert.match(result.data.error, /Requirements changed/);
    assert.equal((await a.request('alice', base)).data.candidates.length, 0);
  } finally { await f.dispose(); }
});

function hostedService(f, a) {
  const jobs = new Map(), calls = [], merged = 'f'.repeat(40);
  f.env.EXECUTION_URL = 'https://execution.example.com'; f.env.EXECUTION_SECRET = 'test-service-secret';
  const previousFetch = globalThis.fetch;
  let failChecks = false, loseAck = false, conflict = false;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(f.env.EXECUTION_URL)) return previousFetch(url, options);
    assert.equal(options.headers.Authorization, 'Bearer test-service-secret'); assert.equal(options.redirect, 'manual');
    const input = JSON.parse(options.body); calls.push({path:new URL(url).pathname,...input});
    if (url.endsWith('/status')) return Response.json(jobs.get(input.id) ?? {status:'missing'});
    if (url.endsWith('/stop')) return Response.json({stopped:true});
    const result = {status:'complete',exit_code:0,commit:input.kind==='execute'?a.head:merged,stdout:'passed',stderr:'',image:'test-container'};
    if (input.kind==='check' && failChecks) Object.assign(result,{status:'failed',exit_code:1,stdout:'assertion failed'});
    if (input.kind==='publish') {
      if (conflict) Object.assign(result,{status:'failed',exit_code:1,stderr:'stale target'});
      else a.repos.get(input.target).head=input.commit;
    }
    if (!jobs.has(input.id)) jobs.set(input.id,result);
    if (input.kind==='publish' && loseAck) throw new Error('Lost acknowledgement');
    return Response.json({status:'running'}, {status:202});
  };
  return {jobs,calls,merged,failChecks:()=>{failChecks=true;},loseAck:()=>{loseAck=true;},conflict:()=>{conflict=true;}};
}
async function hostedCandidate(a, project) {
  const run=(await a.request('watcher',`/projects/${project.id}/runs`,{client_id:crypto.randomUUID(),title:'API',paths:[]})).data;
  const candidate=(await a.request('watcher',`/projects/${project.id}/runs/${run.id}/candidates`,{commit:a.head,requirements_revision:project.revision,summary:'Ready'})).data;
  return {run,candidate};
}
test('project Kanban ties assigned tasks to verified integration and preserves code history', async () => {
  const f=fixture();
  try {
    const a=projectArtifacts(f), {project}=await a.create(), base=`/projects/${project.id}`;
    assert.equal(f.sql.exec('SELECT id FROM boards WHERE id=?',project.board_id)[0].id,project.board_id);
    const task=(await a.request('alice',`/boards/${project.board_id}/tasks`,{title:'API',assignee_id:'watcher'})).data;
    const start={client_id:crypto.randomUUID(),title:'Implement API',task_id:task.id,paths:[]};
    assert.equal((await a.request('other-agent',`${base}/runs`,start)).status,400);
    assert.equal((await a.request('watcher',`${base}/runs`,{...start,task_id:crypto.randomUUID()})).status,400);
    const run=(await a.request('watcher',`${base}/runs`,start)).data;
    assert.equal((await a.request('watcher',base)).data.tasks[0].status,'doing');
    const candidate=(await a.request('watcher',`${base}/runs/${run.id}/candidates`,{commit:a.head,requirements_revision:1,summary:'Ready'})).data;
    assert.equal((await a.request('watcher',base)).data.tasks[0].status,'review');
    const patch=await f.inside(f.env,'w','alice',`/tasks/${task.id}`,{method:'PATCH',body:JSON.stringify({status:'done'})});
    assert.equal(patch.status,400);
    const remove=await f.inside(f.env,'w','alice',`/tasks/${task.id}`,{method:'DELETE'});
    assert.equal(remove.status,400);
    f.sql.exec("UPDATE projects SET check_command='node --test' WHERE id=?",project.id);
    const h=hostedService(f,a), integration=(await a.request('watcher',`${base}/integrations`,{client_id:crypto.randomUUID(),candidate_ids:[candidate.id]})).data;
    await a.request('alice',base); await a.request('alice',base);
    await a.request('alice',`${base}/integrations/${integration.id}/publish`,{commit:h.merged,base_commit:a.root,requirements_revision:1});
    const final=(await a.request('alice',base)).data;
    assert.equal(final.tasks[0].status,'done'); assert.ok(final.tasks[0].completed_at);
    assert.equal(final.runs[0].task_id,task.id);
    f.restart(); assert.equal((await a.request('alice',base)).data.tasks[0].status,'done');
  } finally { await f.dispose(); }
});

test('project branch cleanup requires a human, a completed attempt and the current commit, then supports restoration',async()=>{
  const f=fixture();
  try {
    const a=projectArtifacts(f), {project}=await a.create(), base=`/projects/${project.id}`;
    const run=(await a.request('watcher',`${base}/runs`,{client_id:crypto.randomUUID(),title:'API',paths:[]})).data;
    assert.match(run.branch,/^codex\//);
    const h=hostedService(f,a), route=`${base}/runs/${run.id}/branch`;
    const deletion={client_id:crypto.randomUUID(),operation:'delete_branch',commit:a.root};
    assert.equal((await a.request('alice',route,deletion)).status,400);
    f.sql.exec("UPDATE project_runs SET status='integrated' WHERE id=?",run.id);
    assert.equal((await a.request('watcher',`${base}/runs/${run.id}/checkpoint`,{client_id:crypto.randomUUID(),expected_revision:run.revision,status:'sleeping',checkpoint:'Done.'})).status,400);
    assert.equal((await a.request('watcher',`${base}/runs/${run.id}/token`,{})).status,400);
    assert.equal((await a.request('watcher',route,deletion)).status,400);
    assert.equal((await a.request('alice',route,{...deletion,commit:a.head})).status,400);
    assert.equal(h.calls.filter(c=>c.kind==='delete_branch').length,0);
    assert.equal((await a.request('alice',route,deletion)).status,202);
    const complete=(await a.request('alice',base)).data.runs[0];
    assert.ok(complete.branch_deleted_at); assert.equal(complete.branch_deleted_commit,a.root);
    assert.equal((await a.request('alice',route,deletion)).data.status,'complete');
    assert.equal(h.calls.filter(c=>c.kind==='delete_branch').length,1);
    assert.equal((await a.request('alice',route,{client_id:crypto.randomUUID(),operation:'restore_branch',commit:a.head})).status,400);
    assert.equal((await a.request('alice',route,{client_id:crypto.randomUUID(),operation:'restore_branch',commit:a.root})).status,202);
    const restored=(await a.request('alice',base)).data.runs[0];
    assert.equal(restored.branch_deleted_at,null); assert.equal(restored.status,'integrated');
  }finally {await f.dispose();}
});
test('hosted integration checks a combined revision, requires human approval and reconciles lost publication acknowledgement',async()=>{
  const f=fixture();
  try {
    const a=projectArtifacts(f),{project}=await a.create(),base=`/projects/${project.id}`;
    f.sql.exec("UPDATE projects SET check_command='node --test' WHERE id=?",project.id);
    const {candidate}=await hostedCandidate(a,project), h=hostedService(f,a);
    const input={client_id:crypto.randomUUID(),candidate_ids:[candidate.id]};
    let result=await a.request('watcher',`${base}/integrations`,input);
    assert.equal(result.status,202); const integrationId=result.data.id;
    assert.equal((await a.request('watcher',`${base}/integrations`,input)).data.id,integrationId);
    await a.request('alice',base); // prepare -> check
    const ready=(await a.request('alice',base)).data.integrations[0];
    assert.equal(ready.status,'ready'); assert.equal(ready.commit_hash,h.merged);
    assert.equal(h.calls.find(c=>c.kind==='check').base,h.merged);
    assert.notEqual(h.calls.find(c=>c.kind==='prepare').id,h.calls.find(c=>c.kind==='check').id);
    const publish={commit:h.merged,base_commit:a.root,requirements_revision:1};
    assert.equal((await a.request('watcher',`${base}/integrations/${integrationId}/publish`,publish)).status,400);
    assert.equal((await a.request('alice',`${base}/integrations/${integrationId}/publish`,{...publish,commit:a.head})).status,400);
    h.loseAck();
    assert.equal((await a.request('alice',`${base}/integrations/${integrationId}/publish`,publish)).data.status,'publishing');
    assert.equal((await a.request('alice',`${base}/requirements`,{client_id:crypto.randomUUID(),expected_revision:1,title:'Changed',goal:'Changed',acceptance_criteria:'Changed',reason:'Race'})).status,400);
    f.restart();
    const complete=(await a.request('alice',base)).data;
    assert.equal(complete.integrations[0].status,'integrated'); assert.equal(complete.project.base_commit,h.merged);
    assert.equal(complete.events.filter(e=>e.type==='integration.published').length,1);
    assert.equal(complete.candidates[0].status,'integrated');
    assert.equal(complete.runs[0].status,'integrated');
    f.sql.exec("UPDATE project_candidates SET status='approved' WHERE id=?",candidate.id);
    f.sql.exec("UPDATE project_runs SET status='submitted' WHERE id=?",candidate.run_id);
    f.sql.exec("UPDATE meta SET value='12' WHERE key='schema_version'");
    f.restart();
    const repaired=(await a.request('alice',base)).data;
    assert.equal(repaired.candidates[0].status,'integrated');
    assert.equal(repaired.runs[0].status,'integrated');
    assert.equal((await a.request('alice',`${base}/integrations/${integrationId}/publish`,publish)).data.status,'integrated');
  } finally {await f.dispose();}
});
test('hosted check failure and stale targets cannot advance canonical code',async()=>{
  for(const mode of ['checks','target','requirements']) {
    const f=fixture();
    try {
      const a=projectArtifacts(f),{project}=await a.create(),base=`/projects/${project.id}`;
      f.sql.exec("UPDATE projects SET check_command='node --test' WHERE id=?",project.id);
      const {candidate}=await hostedCandidate(a,project),h=hostedService(f,a);
      if(mode==='checks')h.failChecks();
      const integration=(await a.request('watcher',`${base}/integrations`,{client_id:crypto.randomUUID(),candidate_ids:[candidate.id]})).data;
      await a.request('alice',base); await a.request('alice',base);
      if(mode==='requirements') await a.request('alice',`${base}/requirements`,{client_id:crypto.randomUUID(),expected_revision:1,title:project.title,goal:project.goal,acceptance_criteria:'New criteria',reason:'Changed'});
      if(mode==='target')h.conflict();
      const published=await a.request('alice',`${base}/integrations/${integration.id}/publish`,{commit:h.merged,base_commit:a.root,requirements_revision:1});
      assert.equal(published.status,mode==='target'?202:400);
      const detail=(await a.request('alice',base)).data;
      assert.equal(detail.project.base_commit,a.root); assert.notEqual(detail.integrations[0].status,'integrated');
      assert.equal(a.repos.get(project.repository).head,a.root);
    } finally {await f.dispose();}
  }
});
test('hosted commands keep owner authority, retry once, and preserve output as author evidence',async()=>{
  const f=fixture();
  try {
    const a=projectArtifacts(f),{project}=await a.create(),base=`/projects/${project.id}`;
    const {run}=await hostedCandidate(a,project),h=hostedService(f,a),route=`${base}/runs/${run.id}/execute`;
    const input={client_id:crypto.randomUUID(),command:'npm test'};
    assert.equal((await a.request('other-agent',route,input)).status,403);
    assert.equal((await a.request('watcher',route,input)).status,202);
    assert.equal((await a.request('watcher',route,input)).status,202);
    assert.equal(h.calls.filter(c=>c.kind==='execute').length,1);
    assert.equal((await a.request('watcher',route,{...input,command:'changed'})).status,400);
    const detail=(await a.request('watcher',base)).data;
    assert.equal(detail.jobs[0].status,'complete'); assert.equal(detail.jobs[0].result.commit,a.head);
    assert.equal(detail.candidates[0].checks,'');
    assert.equal(detail.events.filter(e=>e.type==='execution.finished').length,1);
  }finally {await f.dispose();}
});

test('hosted integration advances on durable alarms without a browser polling',async()=>{
  const f=fixture();
  try {
    const a=projectArtifacts(f),{project}=await a.create(),base=`/projects/${project.id}`;
    f.sql.exec("UPDATE projects SET check_command='node --test' WHERE id=?",project.id);
    const {candidate}=await hostedCandidate(a,project);hostedService(f,a);
    const integration=(await a.request('watcher',`${base}/integrations`,{client_id:crypto.randomUUID(),candidate_ids:[candidate.id]})).data;
    await f.workspace.alarm(); await f.workspace.alarm();
    assert.equal(f.sql.exec('SELECT status FROM project_integrations WHERE id=?',integration.id)[0].status,'ready');
    assert.equal(f.sql.exec('SELECT COUNT(*) AS n FROM project_events WHERE type=?','integration.checked')[0].n,1);
  }finally {await f.dispose();}
});
test('hosted computer receipts prevent arbitrary command replay and isolate trust scopes',async()=>{
  const f=fixture();
  try {
    let launches=0, destroyed=0;
    f.ctx.container={running:true,setInactivityTimeout:async()=>{},destroy:async()=>{destroyed++;}};
    const computer=new Computer(f.ctx,f.env);
    computer.perform=async(input)=>{launches++; f.sql.exec('UPDATE jobs SET result=? WHERE id=?',JSON.stringify({status:'complete',exit_code:0}),input.command_id);computer.busy=false;};
    const input={id:'run-test',command_id:'first',kind:'execute',repository:'repo',branch:'main',base:'a'.repeat(40),command:'echo test'};
    const send=body=>computer.fetch(new Request('https://computer/job',{method:'POST',body:JSON.stringify(body)}));
    assert.equal((await send(input)).status,202);await f.settle();
    assert.equal((await(await send(input)).json()).status,'complete');assert.equal(launches,1);
    assert.equal((await send({...input,command:'different'})).status,409);
    assert.equal((await send({...input,command_id:'second',kind:'publish'})).status,409);
    assert.equal(launches,1);
    f.sql.exec('INSERT INTO jobs VALUES(?,?,NULL,?)','interrupted',JSON.stringify(input),Date.now());
    new Computer(f.ctx,f.env);await f.settle();
    assert.equal(destroyed,1);assert.equal(JSON.parse(f.sql.exec("SELECT result FROM jobs WHERE id='interrupted'")[0].result).status,'interrupted');
  }finally {await f.dispose();}
});


test('project compact polling and targeted job receipt agree on metadata', async () => {
  const f = fixture();
  try {
    const a = projectArtifacts(f), { project } = await a.create();
    const runId = crypto.randomUUID(), jobId = crypto.randomUUID();
    assert.equal((await a.request('watcher', `/projects/${project.id}/runs`, { client_id: runId, title: 'receipt', paths: ['src'] })).status, 201);
    const result = { status: 'complete', exit_code: 0, commit: a.head, stdout: 'complete output', stderr: '', image: 'test', started_at: 1, finished_at: 2 };
    f.sql.exec('INSERT INTO project_hosted_jobs(id,project_id,run_id,actor_id,command,status,result,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?)', jobId, project.id, runId, 'watcher', 'npm test', 'complete', JSON.stringify(result), Date.now(), 'execute');
    const compact = (await a.request('watcher', `/projects/${project.id}?include_job_output=false`)).data.jobs[0];
    assert.equal(compact.command_omitted, true); assert.equal(compact.result.output_omitted, true);
    assert.equal(compact.result.exit_code, 0); assert.equal('stdout' in compact.result, false); assert.equal('command' in compact, false);
    const full = (await a.request('watcher', `/projects/${project.id}/jobs/${jobId}`)).data;
    assert.equal(full.command, 'npm test'); assert.equal(full.result.stdout, 'complete output'); assert.equal(full.result.commit, compact.result.commit);
    assert.equal((await a.request('watcher', `/projects/${project.id}/jobs/${crypto.randomUUID()}`)).status, 404);
  } finally { await f.dispose(); }
});


test('integration receipts and compact snapshots preserve scoped metadata without output', async () => {
  const f=fixture(); try {
    const a=projectArtifacts(f),{project}=await a.create(),second=(await a.create()).project;
    const runId=crypto.randomUUID(),foreignRun=crypto.randomUUID(),jobId=crypto.randomUUID(),foreignJobId=crypto.randomUUID();
    assert.equal((await a.request('watcher',`/projects/${project.id}/runs`,{client_id:runId,title:'receipt',paths:['src']})).status,201);
    f.sql.exec('INSERT INTO project_runs(id,project_id,actor_id,title,repository,remote,branch,base_commit,status,paths,checkpoint,cursor,created_at,updated_at,requirements_revision,revision,cancellation_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',foreignRun,second.id,'watcher','foreign','foreign-repo','','main',a.root,'working','[]','',0,Date.now(),Date.now(),1,1,'');
    const command='COMMAND_SENTINEL_RECEIPT_42',stdout='STDOUT_SENTINEL_RECEIPT_43',stderr='STDERR_SENTINEL_RECEIPT_44',error='ERROR_SENTINEL_RECEIPT_45';
    const jobResult={status:'complete',exit_code:0,commit:a.head,stdout,stderr,error,image:'job-image',started_at:1,finished_at:2};
    const insertJob=(id,projectId,run)=>f.sql.exec('INSERT INTO project_hosted_jobs(id,project_id,run_id,actor_id,command,status,result,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?)',id,projectId,run,'watcher',command,'complete',JSON.stringify(jobResult),Date.now(),'execute');
    insertJob(jobId,project.id,runId); insertJob(foreignJobId,second.id,foreignRun);
    const integrationId=crypto.randomUUID(),foreignIntegrationId=crypto.randomUUID(),checks='CHECKS_SENTINEL_RECEIPT_46';
    const integrationResult={status:'failed',exit_code:7,commit:a.head,stdout,stderr,error,image:'integration-image',started_at:3,finished_at:4};
    const insertIntegration=(id,projectId)=>f.sql.exec('INSERT INTO project_integrations(id,project_id,actor_id,repository,candidate_ids,base_commit,commit_hash,requirements_revision,check_command,status,result,created_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,projectId,'watcher',`repo-${id}`,'[]',a.root,a.head,1,command,'failed',JSON.stringify(integrationResult),Date.now(),null);
    insertIntegration(integrationId,project.id); insertIntegration(foreignIntegrationId,second.id);
    const event=(type,data,run=null)=>f.sql.exec('INSERT INTO project_events(id,project_id,actor_id,type,run_id,data,client_id,created_at) VALUES(?,?,?,?,?,?,?,?)',crypto.randomUUID(),project.id,'watcher',type,run,JSON.stringify(data),null,Date.now());
    event('execution.started',{job_id:jobId,command},runId); event('integration.authorized',{integration_id:integrationId,checks});
    const compact=(await a.request('watcher',`/projects/${project.id}?include_job_output=false&event_limit=100`)).data;
    const full=(await a.request('watcher',`/projects/${project.id}?include_job_output=true&event_limit=100`)).data;
    const browser=(await a.request('watcher',`/projects/${project.id}?event_limit=100`)).data;
    const cj=compact.jobs.find(x=>x.id===jobId),fj=full.jobs.find(x=>x.id===jobId),ci=compact.integrations.find(x=>x.id===integrationId),fi=full.integrations.find(x=>x.id===integrationId);
    for(const key of ['id','project_id','run_id','actor_id','kind','status','created_at']) assert.deepEqual(cj[key],fj[key]);
    for(const key of ['status','exit_code','commit','image','started_at','finished_at']) assert.deepEqual(cj.result[key],fj.result[key]);
    for(const key of ['id','project_id','actor_id','repository','candidate_ids','base_commit','commit_hash','requirements_revision','status','created_at','reviewed_by']) assert.deepEqual(ci[key],fi[key]);
    for(const key of ['status','exit_code','commit','image','started_at','finished_at']) assert.deepEqual(ci.result[key],fi.result[key]);
    const compactJson=JSON.stringify(compact); assert.equal(compactJson.includes(command),false); assert.equal(compactJson.includes(checks),false);
    for(const detail of [full,browser]) { const json=JSON.stringify(detail); assert.ok(json.includes(command)); assert.ok(json.includes(checks)); }
    const jr=(await a.request('watcher',`/projects/${project.id}/jobs/${jobId}`)).data;
    assert.equal(jr.command,command); assert.equal(jr.result.stdout,stdout); assert.equal(jr.result.stderr,stderr); assert.equal(jr.result.error,error);
    const ir=(await a.request('watcher',`/projects/${project.id}/integrations/${integrationId}`)).data;
    assert.equal(ir.check_command,command); assert.equal(ir.result.stdout,stdout); assert.equal(ir.result.stderr,stderr); assert.equal(ir.result.error,error);
    assert.equal((await a.request('watcher',`/projects/${project.id}/jobs/${foreignJobId}`)).status,404);
    assert.equal((await a.request('watcher',`/projects/${project.id}/integrations/${foreignIntegrationId}`)).status,404);
  } finally {await f.dispose();}
});

test('run source reads enforce owner, human, revocation, project bounds and no durable mutations', async () => {
  const f=fixture(); try {
    const a=projectArtifacts(f),{project}=await a.create();
    const run=(await a.request('watcher',`/projects/${project.id}/runs`,{client_id:crypto.randomUUID(),title:'source',paths:[]})).data;
    const base=`/projects/${project.id}/runs/${run.id}`, count=()=>({tokens:a.tokens.length,revoked:a.revoked.length,jobs:f.sql.exec('SELECT * FROM project_hosted_jobs').length,events:f.sql.exec('SELECT * FROM project_events').length,checkpoint:f.sql.exec('SELECT checkpoint FROM project_runs WHERE id=?',run.id)[0].checkpoint});
    const before=count();
    assert.equal((await a.request('watcher',`${base}/tree?commit=${a.root}`)).status,200);
    assert.equal((await a.request('watcher',`${base}/source-file?commit=${a.root}&path=auth.ts`)).data.content,'export const expiry = 0;');
    const ranged=(await a.request('watcher',`${base}/source-file?commit=${a.root}&path=auth.ts&start_line=1&line_limit=1`)).data;
    assert.equal(ranged.content,'export const expiry = 0;'); assert.equal(ranged.start_line,1); assert.equal(ranged.line_limit,1); assert.equal(ranged.total_lines,1); assert.equal(ranged.has_more,false); assert.equal(ranged.next_line,null);
    const sourceArgs={name:'read_project_run_file',arguments:{project_id:project.id,run_id:run.id,commit:a.root,path:'auth.ts',start_line:1,line_limit:1}};
    const getBeforeScopes=f.env.ARTIFACTS.get; let scopedGets=0; f.env.ARTIFACTS.get=async name=>{scopedGets++;return getBeforeScopes(name);};
    for(const scopes of [['read'],['files']]) { const denied=await f.rpc('tools/call',sourceArgs,{accountId:'watcher',workspaceId:'w',scopes,eventAuthority:f.authority}); assert.ok(denied.result.isError); assert.equal(scopedGets,0); }
    const scopedAllowed=await f.rpc('tools/call',sourceArgs,{accountId:'watcher',workspaceId:'w',scopes:['read','files'],eventAuthority:f.authority}); assert.ok(!scopedAllowed.result.isError,JSON.stringify(scopedAllowed)); assert.ok(scopedGets>0);
    const mcpRange=JSON.parse(scopedAllowed.result.content[0].text);
    assert.equal(mcpRange.content,'export const expiry = 0;'); assert.equal(mcpRange.start_line,1); assert.equal(mcpRange.line_limit,1); assert.equal(mcpRange.total_lines,1); assert.equal(mcpRange.has_more,false); assert.equal(mcpRange.next_line,null); assert.equal(mcpRange.metadata_only,false);
    const readsAfterValid=scopedGets;
    for(const arguments_ of [{...sourceArgs.arguments,start_line:0},{...sourceArgs.arguments,line_limit:201}]) {
      const invalid=await f.rpc('tools/call',{name:'read_project_run_file',arguments:arguments_},{accountId:'watcher',workspaceId:'w',scopes:['read','files'],eventAuthority:f.authority});
      assert.ok(invalid.result.isError,JSON.stringify(invalid)); assert.equal(scopedGets,readsAfterValid);
    }
    for(const query of ['start_line=0','line_limit=201']) { assert.equal((await a.request('watcher',base+'/source-file?commit='+a.root+'&path=auth.ts&'+query)).status,400); assert.equal(scopedGets,readsAfterValid); }
    const listed=(await f.rpc('tools/list',{}, {accountId:'watcher',workspaceId:'w',scopes:['read','files'],eventAuthority:f.authority})).result.tools;
    for(const name of ['list_project_run_files','read_project_run_file']) assert.equal(listed.find(tool=>tool.name===name).annotations.readOnlyHint,true);
    const rangeSchema=listed.find(tool=>tool.name==='read_project_run_file').inputSchema.properties; assert.deepEqual(rangeSchema.start_line,{type:'integer',minimum:1}); assert.deepEqual(rangeSchema.line_limit,{type:'integer',minimum:1,maximum:200});
    const get=f.env.ARTIFACTS.get; let calls=0; f.env.ARTIFACTS.get=async name=>{calls++;return get(name);};
    assert.equal((await a.request('other-agent',`${base}/tree?commit=${a.root}`)).status,403); assert.equal(calls,0);
    assert.equal((await a.request('alice',`${base}/tree?commit=${a.root}`)).status,200);
    f.sql.exec("DELETE FROM channel_members WHERE channel_id='c' AND account_id='alice'"); assert.notEqual((await a.request('alice',`${base}/tree?commit=${a.root}`)).status,200);
    assert.notEqual((await a.request('watcher',`${base}/tree?commit=${a.foreign}`)).status,200);
    assert.notEqual((await a.request('watcher',`/projects/${crypto.randomUUID()}/runs/${run.id}/tree?commit=${a.root}`)).status,200);
    assert.deepEqual(count(),before);
  } finally {await f.dispose();}
});

test('run source reads recheck access after every awaited repository success and error',async()=>{
  for(const method of ['readCommit','readTree','readBlob']) for(const fail of [false,true]) { const f=fixture(); try {
    const a=projectArtifacts(f),{project}=await a.create(),run=(await a.request('watcher',`/projects/${project.id}/runs`,{client_id:crypto.randomUUID(),title:'source',paths:[]})).data;
    const get=f.env.ARTIFACTS.get; let enter,release; const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
    f.env.ARTIFACTS.get=async name=>{const repo=await get(name),original=repo[method];repo[method]=async(...args)=>{enter();await gate;if(fail)throw Error('read failed');return original(...args);};return repo;};
    const file=method==='readBlob',pending=a.request('watcher',`/projects/${project.id}/runs/${run.id}/${file?'source-file':'tree'}?commit=${a.root}${file?'&path=auth.ts':''}`); await entered;
    f.sql.exec("DELETE FROM channel_members WHERE channel_id='c' AND account_id='watcher'"); release(); const denied=await pending; assert.equal(denied.data.error,'You are not a member of this channel.',`${method} ${fail}`); assert.doesNotMatch(JSON.stringify(denied.data),/read failed/,`${method} ${fail}`);
  } finally {await f.dispose();} }
});


test('compact project job metadata pages deterministically without mutating work', async () => {
  const f=fixture(); try {
    const a=projectArtifacts(f),{project}=await a.create(),base=`/projects/${project.id}`,runId=crypto.randomUUID();
    assert.equal((await a.request('watcher',`${base}/runs`,{client_id:runId,title:'paged receipts',paths:[]})).status,201);
    const ids=[],created=1700000000000;
    for(let i=0;i<45;i++){const id=crypto.randomUUID(),result={status:'complete',exit_code:i%4,commit:a.head,stdout:`stdout-${i}`,stderr:`stderr-${i}`,error:`error-${i}`,image:`image-${i}`,started_at:i,finished_at:i+1};ids.push(id);f.sql.exec('INSERT INTO project_hosted_jobs(id,project_id,run_id,actor_id,command,status,result,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?)',id,project.id,runId,'watcher',`command-${i}`,'complete',JSON.stringify(result),created+Math.floor(i/3),'execute');}
    const state=()=>({jobs:f.sql.exec('SELECT COUNT(*) AS n FROM project_hosted_jobs')[0].n,events:f.sql.exec('SELECT COUNT(*) AS n FROM project_events')[0].n,checkpoints:f.sql.exec("SELECT COUNT(*) AS n FROM project_runs WHERE checkpoint!=''")[0].n,tokens:f.sql.exec('SELECT COUNT(*) AS n FROM project_run_tokens')[0].n}),before=state();
    const read=async suffix=>(await a.request('watcher',`${base}?include_job_output=false${suffix}`)).data;
    const first=await read(''),second=await read('&job_offset=20'),last=await read('&job_offset=40'),empty=await read('&job_offset=99');
    assert.equal(first.jobs.length,20);assert.deepEqual(first.jobs_page,{offset:0,limit:20,total:45,has_more:true,next_offset:20});
    assert.equal(second.jobs.length,20);assert.deepEqual(second.jobs_page,{offset:20,limit:20,total:45,has_more:true,next_offset:40});
    assert.equal(last.jobs.length,5);assert.deepEqual(last.jobs_page,{offset:40,limit:20,total:45,has_more:false,next_offset:null});
    assert.equal(empty.jobs.length,0);assert.deepEqual(empty.jobs_page,{offset:99,limit:20,total:45,has_more:false,next_offset:null});
    const traversed=[...first.jobs,...second.jobs,...last.jobs],expected=f.sql.exec('SELECT id FROM project_hosted_jobs WHERE project_id=? ORDER BY created_at DESC,id DESC',project.id).map(row=>row.id);
    assert.deepEqual(traversed.map(j=>j.id),expected);assert.equal(new Set(traversed.map(j=>j.id)).size,45);
    const full=(await a.request('watcher',`${base}?include_job_output=true`)).data;assert.equal('jobs_page' in full,false);assert.equal(full.jobs.length,45);
    for(const compact of traversed){const complete=full.jobs.find(j=>j.id===compact.id),target=(await a.request('watcher',`${base}/jobs/${compact.id}`)).data;for(const key of ['id','project_id','run_id','actor_id','kind','status','created_at'])assert.deepEqual(compact[key],complete[key]);for(const key of ['status','exit_code','commit','image','started_at','finished_at'])assert.deepEqual(compact.result[key],complete.result[key]);assert.deepEqual(target,complete);assert.equal(compact.command_omitted,true);assert.equal(compact.result.output_omitted,true);assert.equal('command' in compact,false);for(const key of ['stdout','stderr','error'])assert.equal(key in compact.result,false);}
    assert.equal((await a.request('watcher',`${base}/jobs/${last.jobs[0].id}`)).data.id,last.jobs[0].id);
    for(const suffix of ['&job_limit=0','&job_limit=101','&job_limit=1.5','&job_offset=-1','&job_offset=1.5'])assert.equal((await a.request('watcher',`${base}?include_job_output=false${suffix}`)).status,400);
    assert.equal((await a.request('watcher',`${base}?include_job_output=true&job_limit=20`)).status,400);assert.equal((await a.request('watcher',`${base}?job_offset=1`)).status,400);
    const actor={accountId:'watcher',workspaceId:'w',scopes:['read'],eventAuthority:f.authority};
    for(const args of [{job_limit:0},{job_limit:101},{job_offset:-1},{job_limit:1.5}])assert.ok((await f.rpc('tools/call',{name:'read_project',arguments:{project_id:project.id,...args}},actor)).result.isError);
    const mcp=(await f.rpc('tools/call',{name:'read_project',arguments:{project_id:project.id,job_limit:5,job_offset:20}},actor)).result.structuredContent.result;assert.deepEqual(mcp.jobs.map(j=>j.id),second.jobs.slice(0,5).map(j=>j.id));assert.deepEqual(mcp.jobs_page,{offset:20,limit:5,total:45,has_more:true,next_offset:25});assert.deepEqual(state(),before);
    for(let i=45;i<105;i++)f.sql.exec('INSERT INTO project_hosted_jobs(id,project_id,run_id,actor_id,command,status,result,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?)',crypto.randomUUID(),project.id,runId,'watcher',`legacy-${i}`,'complete',JSON.stringify({status:'complete',stdout:`full-${i}`,stderr:'',error:''}),created+i,'execute');
    for(const legacy of [(await a.request('watcher',base)).data,(await a.request('watcher',`${base}?include_job_output=true`)).data]){assert.equal(legacy.jobs.length,100);assert.equal('jobs_page' in legacy,false);assert.ok(legacy.jobs.every(j=>'command' in j&&'stdout' in j.result&&'stderr' in j.result&&'error' in j.result));}
  } finally {await f.dispose();}
});
