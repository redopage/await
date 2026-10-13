import { startHost } from './await-agent-host.mjs';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const state = await mkdtemp(join(tmpdir(), 'await-events-smoke-'));
const configPath = resolve('dist/await_chat_app/events-smoke.json');
const config = JSON.parse(await readFile('dist/await_chat_app/wrangler.json', 'utf8'));
const received = [], verification = [], inboxVerification = [], notices = [];
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const gatewayToken = randomBytes(32).toString('hex');
const gateway = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  try {
    assert.equal(req.headers.authorization, `Bearer ${gatewayToken}`);
    const input = JSON.parse(Buffer.concat(chunks));
    const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${input.headers['webhook-id']}.${input.headers['webhook-timestamp']}.${input.body}`).digest('base64');
    assert.equal(input.headers['webhook-signature'], `v1,${expected}`);
    const body = JSON.parse(input.body);
    let reply;
    const subscription = input.headers['x-mcp-subscription-id'];
    if (body.type === 'verification') { (subscription.startsWith('inbox_') ? inboxVerification : verification).push(body); reply = { status: 200, body: JSON.stringify({ challenge: body.challenge }) }; }
    else if (body.type === 'agent_events') { notices.push({ id: input.headers['webhook-id'], subscription, ...body }); reply = { status: 204, body: '' }; }
    else { received.push({ subscription, ...body }); reply = { status: 204, body: '' }; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply));
  } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ reason: String(error) })); }
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
config.services = [];
config.routes = [];
config.dev = { ...config.dev, ip: '127.0.0.1' };
config.vars = { ...config.vars, DEV_AUTH: '1', EMAIL_ENABLED: '0', AUTH_EMAIL_ENABLED: '0',
  MCP_EVENT_KEY: randomBytes(32).toString('base64'), FILE_LINK_SECRET: randomBytes(32).toString('hex'), MCP_WEBHOOK_GATEWAY_TOKEN: gatewayToken, MCP_WEBHOOK_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}/deliver` };
await writeFile(configPath, JSON.stringify(config));
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
let worker, logs = '';
const command = (args, env = {}) => new Promise((done, reject) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? done(output) : reject(new Error(output)));
});
try {
  await command([wrangler, 'd1', 'migrations', 'apply', 'await-chat', '--local', '--config', configPath, '--persist-to', state]);
  const port = 5187, base = `http://127.0.0.1:${port}`;
  worker = spawn(process.execPath, [wrangler, 'dev', '--config', configPath, '--port', String(port), '--persist-to', state, '--inspector-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  const json = async (path, { cookie, token, body, method = 'GET' } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2026-07-28' } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`); return { response, value };
  };
  let ready = false;
  for (let i = 0; i < 150; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (ready) break; await sleep(100); }
  assert.ok(ready, 'Workers runtime did not start.');
  const login = await json('/api/dev/login', { method: 'POST', body: process.env.MCP_EVENTS_REVIEW === '1' ? { name: 'Reviewer', email: process.env.AWAIT_REVIEW_EMAIL ?? 'reviewer@localhost' } : { name: 'Event smoke owner', email: `events-${Date.now()}@localhost` } });
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  const workspace = (await json('/api/workspaces', { cookie, method: 'POST', body: { name: 'MCP Events smoke' } })).value;
  const agent = (await json(`/api/workspaces/${workspace.id}/agents`, { cookie, method: 'POST', body: { name: 'Event watcher', description: 'Runtime smoke test' } })).value;
  await json(`/api/workspaces/${workspace.id}/channels/${workspace.channel_id}/members`, { cookie, method: 'POST', body: { agent_id: agent.agent_id } });
  const listeningPath = `/api/workspaces/${workspace.id}/agents/${agent.agent_id}/listening/${workspace.channel_id}`;
  await json(listeningPath, { cookie, method: 'PUT', body: { level: 'mentions', include_agent_authors: true } });
  let modelCalls = 0;
  const host = await startHost({ token: agent.token, origin: base, stateDir: join(state, 'host'), respond: async (prompt) => {
    modelCalls++;
    if (prompt.includes('Thread retrieval available: true') && !prompt.includes('"thread_id":null')) return { request_thread: true, reply: false, body: '', notes: '' };
    if (modelCalls > 1) assert.ok(prompt.includes('Push event received by local host.'), 'Follow-up must retrieve the earlier thread reply');
    return { request_thread: false, reply: true, body: 'Push event received by local host.', notes: 'Verified thread context' };
  } });
  try {
    const messagePath = `/api/workspaces/${workspace.id}/channels/${workspace.channel_id}/messages`;
    const root = (await json(messagePath, { cookie, method: 'POST', body: { body: `Local push <@${agent.agent_id}>`, client_id: 'local-push-smoke' } })).value;
    for (let i = 0; i < 100 && host.getState().replies < 1; i++) await sleep(100);
    assert.equal(host.getState().replies, 1); assert.equal(modelCalls, 1);
    assert.equal((await json('/api/agent/events', { token: agent.token })).value.events.length, 0);
    const thread = (await json(`${messagePath}?thread=${root.id}`, { cookie })).value;
    assert.ok(thread.some((message) => message.body === 'Push event received by local host.' && message.author_id === agent.agent_id));
    await json(messagePath, { cookie, method: 'POST', body: { body: `<@${agent.agent_id}> What did you reply earlier?`, thread_id: root.id } });
    for (let i = 0; i < 100 && host.getState().replies < 2; i++) await sleep(100);
    assert.equal(host.getState().replies, 2); assert.equal(modelCalls, 3, 'A follow-up makes one context request then answers');
    await json(listeningPath, { cookie, method: 'PUT', body: { level: 'off', include_agent_authors: true } });
    await json(messagePath, { cookie, method: 'POST', body: { body: `Stopped local push <@${agent.agent_id}>` } });
    await sleep(200); assert.equal(modelCalls, 3);
    console.log('✓ Local host: actual Workers HTTP routes, WebSocket push, preview response, optional thread retrieval, MCP reply, acknowledgement, self suppression and off');
  } finally { host.stop(); }
  // The inbox webhook is verified and rung through the gateway; the inbox stays the record.
  const webhookPath = `/api/workspaces/${workspace.id}/agents/${agent.agent_id}/webhook`;
  const pausePath = `/api/workspaces/${workspace.id}/agents/${agent.agent_id}/pause`;
  const inboxPost = (body) => json(`/api/workspaces/${workspace.id}/channels/${workspace.channel_id}/messages`, { cookie, method: 'POST', body: { body } });
  assert.equal((await json(webhookPath, { cookie, method: 'PUT', body: { url: 'https://receiver.example.com/inbox', secret } })).value.active, true);
  assert.equal(inboxVerification.length, 1);
  await json(listeningPath, { cookie, method: 'PUT', body: { level: 'mentions', include_agent_authors: true } });
  await inboxPost(`Inbox webhook <@${agent.agent_id}>`);
  for (let i = 0; i < 100 && notices.length < 1; i++) await sleep(100);
  assert.equal(notices.length, 1);
  const { id: noticeId, ...notice } = notices[0];
  assert.match(noticeId, /^ring_/);
  assert.deepEqual(notice, { subscription: `inbox_${agent.agent_id}`, type: 'agent_events', workspace_id: workspace.id, agent_id: agent.agent_id });
  const inbox = (await json('/api/agent/events', { token: agent.token })).value.events;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].data.mentions_agent, true);
  await json('/api/agent/events/ack', { token: agent.token, method: 'POST', body: { event_ids: [inbox[0].eventId] } });
  await json(pausePath, { cookie, method: 'POST', body: { paused: true } });
  await inboxPost(`Paused inbox webhook <@${agent.agent_id}>`);
  await sleep(2500); assert.equal(notices.length, 1, 'A paused agent is not rung');
  await json(pausePath, { cookie, method: 'POST', body: { paused: false } });
  await json(listeningPath, { cookie, method: 'PUT', body: { level: 'off', include_agent_authors: true } });
  await json(webhookPath, { cookie, method: 'DELETE' });
  console.log('✓ Workers runtime: inbox webhook verification, a content-free signed notice through the gateway, inbox drain and acknowledgement, pause');
  const rpc = async (method, params) => (await json('/mcp', { token: agent.token, method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } })).value;
  const discovery = await rpc('server/discover'); assert.deepEqual(discovery.result.capabilities.events, {});
  assert.equal((await rpc('events/list')).result.events.length, 10);
  const params = (name) => ({ name, arguments: { channel_id: workspace.channel_id }, delivery: { mode: 'webhook', url: `https://receiver.example.com/${name}`, secret }, cursor: null });
  const messageWatch = await rpc('events/subscribe', params('message.created')); assert.ok(messageWatch.result?.id, JSON.stringify(messageWatch));
  await rpc('events/subscribe', params('message.mentioned'));
  await rpc('events/subscribe', params('message.updated'));
  await rpc('events/subscribe', params('task.created'));
  await rpc('events/subscribe', params('document.updated'));
  assert.equal(verification.length, 5);
  const message = { body: `Runtime event <@${agent.agent_id}>`, client_id: 'runtime-event' };
  const path = `/api/workspaces/${workspace.id}/channels/${workspace.channel_id}/messages`;
  const first = (await json(path, { cookie, method: 'POST', body: message })).value;
  const repeated = (await json(path, { cookie, method: 'POST', body: message })).value; assert.equal(first.id, repeated.id);
  const board = (await json(`/api/workspaces/${workspace.id}/collab/boards`, { cookie, method: 'POST', body: { channel_id: workspace.channel_id, name: 'Runtime board' } })).value;
  await json(`/api/workspaces/${workspace.id}/collab/boards/${board.id}/tasks`, { cookie, method: 'POST', body: { title: 'Runtime task', client_id: 'runtime-task' } });
  const doc = (await json(`/api/workspaces/${workspace.id}/collab/documents`, { cookie, method: 'POST', body: { channel_id: workspace.channel_id, title: 'Runtime document', body: 'Original' } })).value;
  await json(`/api/workspaces/${workspace.id}/collab/documents/${doc.id}`, { cookie, method: 'PUT', body: { body: 'Changed' } });
  for (let i = 0; i < 100 && received.length < 4; i++) await sleep(100);
  assert.deepEqual(received.map((event) => event.name).sort(), ['document.updated', 'message.created', 'message.mentioned', 'task.created']);
  const editPath = `/api/workspaces/${workspace.id}/messages/${first.id}/edit`;
  await json(editPath, { cookie, method: 'POST', body: { body: `Revised runtime request <@${agent.agent_id}>` } });
  for (let i = 0; i < 100 && received.length < 5; i++) await sleep(100);
  assert.equal(received.length, 5); assert.equal(received.at(-1).name, 'message.updated');
  assert.equal(received.at(-1).data.text, `Revised runtime request <@${agent.agent_id}>`);
  await json(editPath, { cookie, method: 'POST', body: { body: `Revised runtime request <@${agent.agent_id}>` } });
  await sleep(200); assert.equal(received.length, 5, 'Unchanged saves are quiet');
  await json(editPath, { cookie, method: 'POST', body: { body: 'Mention removed' } });
  for (let i = 0; i < 100 && received.length < 6; i++) await sleep(100);
  await json(editPath, { cookie, method: 'POST', body: { body: `Retagged runtime request <@${agent.agent_id}>` } });
  for (let i = 0; i < 100 && received.length < 8; i++) await sleep(100);
  assert.equal(received.length, 8);
  assert.equal(received.filter((event) => event.name === 'message.mentioned').length, 2);
  const status = (await json(`/api/workspaces/${workspace.id}/event-subscriptions`, { cookie })).value;
  assert.equal(status.subscriptions.length, 5); assert.ok(status.subscriptions.every((watch) => watch.pending === 0));
  assert.equal(status.subscriptions.flatMap((watch) => watch.receipts).length, received.length);
  for (const watch of status.subscriptions) for (const receipt of watch.receipts) {
    assert.equal(receipt.http_status, 204); assert.equal(receipt.outcome, 'accepted');
    assert.ok(received.some((event) => event.eventId === receipt.event_id));
  }
  assert.equal(JSON.stringify(status).includes(secret), false);
  if (process.env.MCP_EVENTS_REVIEW === '1') {
    // Keep real subscriptions and receipts available for browser checks. No credentials leave the harness.
    const finish = join(state, 'review-finished');
    await writeFile('/tmp/await-events-review.json', JSON.stringify({ workspaceId: workspace.id, channelId: workspace.channel_id, agentId: agent.agent_id, finish }), { mode: 0o600 });
    console.log(`Browser event review ready: http://localhost:${port}/w/${workspace.id}/${workspace.channel_id} (Agents, then the agent's settings)`);
    let finished = false;
    for (let i = 0; i < 1200 && !finished; i++) { await sleep(500); finished = await access(finish).then(() => true, () => false); }
    assert.ok(finished, 'Browser review did not finish within ten minutes.');
  }
  await rpc('events/unsubscribe', params('message.created')); await rpc('events/unsubscribe', params('message.mentioned'));
  await rpc('events/unsubscribe', params('message.updated'));
  await json(path, { cookie, method: 'POST', body: { body: `Stopped <@${agent.agent_id}>` } });
  await sleep(1500); assert.equal(received.length, 8);
  console.log('✓ Workers runtime: discovery, signed verification, message/edit/mention/task/document delivery, quiet retained tags, post deduplication, status and unsubscribe');
  // A real OAuth grant must outlive access-token refresh and stop after revocation.
  const client = (await json('/register', { method: 'POST', body: { client_name: 'Events smoke', redirect_uris: ['http://127.0.0.1:8765/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } })).value;
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:8765/callback', scope: 'read post files', state: 'events', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${base}/mcp` }).toString();
  const consent = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
  const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1]; assert.ok(handle);
  const form = new URLSearchParams({ handle, agent_id: agent.agent_id, workspace_id: workspace.id, decision: 'approve' });
  for (const scope of ['read', 'post', 'files']) form.append('scope', scope);
  const approved = await fetch(`${base}/authorize`, { method: 'POST', headers: { cookie: `${cookie}; ${consent.headers.get('set-cookie').split(';')[0]}`, 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: form, redirect: 'manual' });
  assert.equal(approved.status, 302);
  const exchange = async (body) => {
    const response = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const oauthToken = await exchange({ grant_type: 'authorization_code', code: new URL(approved.headers.get('location')).searchParams.get('code'), redirect_uri: 'http://127.0.0.1:8765/callback', client_id: client.client_id, code_verifier: verifier, resource: `${base}/mcp` });
  const oauthWatch = { ...params('message.created'), delivery: { ...params('message.created').delivery, url: 'https://receiver.example.com/oauth' } };
  const subscribed = (await json('/mcp', { token: oauthToken.access_token, method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'events/subscribe', params: oauthWatch } })).value;
  assert.ok(subscribed.result?.id, JSON.stringify(subscribed));
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: oauthToken.refresh_token, client_id: client.client_id, resource: `${base}/mcp` });
  assert.ok(refreshed.access_token);
  const beforeRefreshDelivery = received.length;
  await json(path, { cookie, method: 'POST', body: { body: 'Grant still valid after refresh' } });
  for (let i = 0; i < 100 && received.length < beforeRefreshDelivery + 1; i++) await sleep(100);
  assert.equal(received.length, beforeRefreshDelivery + 1); assert.equal(received.at(-1).subscription, subscribed.result.id);
  await json(`/api/workspaces/${workspace.id}/agents/${agent.agent_id}/revoke`, { cookie, method: 'POST', body: {} });
  await json(path, { cookie, method: 'POST', body: { body: 'Revoked grant must not receive this' } });
  let revoked;
  for (let i = 0; i < 100; i++) { revoked = (await json(`/api/workspaces/${workspace.id}/event-subscriptions`, { cookie })).value.subscriptions.find((watch) => watch.id === subscribed.result.id); if (!revoked.active) break; await sleep(100); }
  assert.equal(revoked.active, false); assert.match(revoked.last_error, /revoked/); assert.equal(received.length, beforeRefreshDelivery + 1);
  console.log('✓ Workers runtime: real OAuth event authority survives token refresh and stops after revocation');
  // Exercise the full existing OAuth path, including grant-backed agent sessions.
  const oauthOutput = await command([resolve('scripts/oauth-smoke.mjs')], { AWAIT_BASE_URL: base });
  console.log(oauthOutput.trim());
  console.log((await command([resolve('scripts/smoke.mjs')], { AWAIT_SMOKE_ORIGIN: base })).trim());
} catch (error) { await sleep(500); console.error(logs.replace(/^.*env\.\S*(?:KEY|TOKEN|SECRET)\b.*$/gm, '[credential binding hidden]')); throw error; }
finally {
  if (worker) { const exited = new Promise((done) => worker.once('exit', done)); worker.kill('SIGTERM'); await Promise.race([exited, sleep(2000)]); }
  await new Promise((done) => gateway.close(done)); await rm(configPath, { force: true }); await rm(state, { recursive: true, force: true });
}
