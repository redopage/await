import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { respondToEvent, eventPrompt, runClaude, claudeArgs, parseClaudeResult, extractJsonObject, validateReply, startHost, runners, bodyLimit } from './await-agent-host.mjs';
import { createAwaitClient, normalizeInbox, AwaitError } from './lib/await-client.mjs';
import { selectRunner, parseArgs, parseEnvFile, defaultStateDir, defaultLaunchLabel, serviceEnvironment, slugify, usage } from './lib/await-host-config.mjs';
import { childEnvironment, codexArgs, isOnPath, resolveExecutable, runCli } from './lib/model-cli.mjs';

const identity = { name: 'Test bot', description: 'Thread context test' };
const event = { name: 'message.created', data: { channel_id: 'c', message_id: 'reply', thread_id: 'root', reply_count: 3, text: 'What did we decide earlier?', mentions_agent: true } };
const response = (input = {}) => ({ reply: true, body: 'Answer', notes: 'Memory', request_thread: false, ...input });

test('standalone events use previews without fetching a thread', async () => {
  const result = await respondToEvent({ identity, event: { ...event, data: { ...event.data, message_id: 'root', thread_id: null, reply_count: 0 } },
    respond: async (prompt) => { assert.ok(prompt.includes('Conversation: null')); return response(); },
    readThread: async () => { assert.fail('Unnecessary thread read'); } });
  assert.equal(result.response.reply, true); assert.equal(result.threadId, 'root');
});

test('the model can fetch context once and answer in the original thread', async () => {
  let calls = 0, reads = 0;
  const result = await respondToEvent({ identity, event, memory: 'Earlier memory',
    respond: async (prompt) => {
      calls++;
      if (calls === 1) { assert.ok(prompt.includes('"reply_count":3')); assert.ok(prompt.includes('Thread retrieval available: true')); return response({ request_thread: true, reply: false, body: '' }); }
      assert.ok(prompt.includes('Earlier memory')); assert.ok(prompt.includes('We chose Friday')); assert.ok(prompt.includes('Thread retrieval available: false'));
      return response({ body: 'Friday' });
    }, readThread: async (args) => { reads++; assert.deepEqual(args, { channel_id: 'c', thread_id: 'root' }); return [{ body: 'We chose Friday' }]; } });
  assert.equal(calls, 2); assert.equal(reads, 1); assert.equal(result.response.body, 'Friday'); assert.equal(result.threadId, 'root');
});

test('broad listening can retrieve context quietly and cannot authorize a reply', async () => {
  let calls = 0;
  const result = await respondToEvent({ identity, event: { ...event, data: { ...event.data, mentions_agent: false } },
    respond: async () => response({ request_thread: ++calls === 1 }), readThread: async () => [] });
  assert.equal(calls, 2); assert.equal(result.response.reply, false);
});

test('non-message events cannot read a thread and retrieval cannot loop', async () => {
  let reads = 0;
  const respond = async () => response({ request_thread: true });
  const readThread = async () => { reads++; return []; };
  const noThread = await respondToEvent({ identity, event: { name: 'document.updated', data: { channel_id: 'c' } }, respond, readThread });
  assert.equal(reads, 0); assert.equal(noThread.response.reply, false);
  const repeated = await respondToEvent({ identity, event, respond, readThread });
  assert.equal(reads, 1); assert.equal(repeated.response.reply, false);
});

test('the prompt names the owner from agent context instead of a fixed person', () => {
  const owned = eventPrompt({ ...identity, owner: { id: 'o', name: 'Priya' } }, event, null);
  assert.ok(owned.includes('an Await bot owned by Priya.'));
  const anonymous = eventPrompt(identity, event, null);
  assert.ok(anonymous.includes('owned by a person on this team.'));
});

// Runner selection

test('runner selection honours the flag, the environment value and PATH availability', () => {
  assert.equal(selectRunner({ runner: 'claude', available: () => true }), 'claude');
  assert.equal(selectRunner({ runner: ' Codex ', available: () => false }), 'codex');
  assert.equal(selectRunner({ available: (name) => name === 'codex' }), 'codex');
  assert.equal(selectRunner({ available: () => false }), 'claude');
  assert.equal(selectRunner({ runner: '', available: () => false }), 'claude');
  assert.throws(() => selectRunner({ runner: 'gemini' }), /Choose --runner claude or --runner codex/);
  assert.deepEqual(Object.keys(runners).sort(), ['claude', 'codex']);
});

test('host arguments parse runner, state directory and help', () => {
  assert.deepEqual(parseArgs(['--runner', 'claude', '--state-dir=/tmp/x']), { _: [], runner: 'claude', 'state-dir': '/tmp/x' });
  assert.equal(parseArgs(['-h']).help, true);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option --bogus/);
  assert.throws(() => parseArgs(['--runner']), /needs a value/);
  const installer = parseArgs(['.env.bot', 'com.await.bot', '--runner', 'codex'], { flags: ['runner', 'state-dir'] });
  assert.deepEqual(installer, { _: ['.env.bot', 'com.await.bot'], runner: 'codex' });
  for (const needle of ['AWAIT_AGENT_TOKEN', 'AWAIT_ORIGIN', '--runner', '--state-dir', 'one host per agent']) assert.ok(usage().includes(needle), needle);
});

test('state directories and service labels derive from the agent name', () => {
  const agent = { id: 'agt_123', name: 'Release Bot!' };
  assert.equal(slugify('Café Bot 2'), 'cafe-bot-2');
  assert.equal(defaultStateDir(agent, '/home/u'), join('/home/u', '.await', 'hosts', 'release-bot'));
  assert.equal(defaultLaunchLabel(agent), 'com.await.release-bot');
  assert.equal(defaultLaunchLabel({ id: 'agt_123', name: '???' }), 'com.await.agt-123');
  assert.deepEqual(parseEnvFile('# comment\nAWAIT_AGENT_TOKEN="secret value"\nexport AWAIT_ORIGIN=http://127.0.0.1:5173 # local\n\nBAD LINE\n'), { AWAIT_AGENT_TOKEN: 'secret value', AWAIT_ORIGIN: 'http://127.0.0.1:5173' });
});

test('the installer resolves the runner CLI to an absolute path and leads the service PATH with Node', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-install-test-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(join(bin, 'folder'), { recursive: true });
    await writeFile(join(bin, 'codex'), '#!/usr/bin/env node\n', { mode: 0o755 });
    await writeFile(join(bin, 'plain'), 'not executable', { mode: 0o644 });
    const env = { PATH: ['/definitely/missing', bin].join(delimiter) };
    assert.equal(resolveExecutable('codex', env), join(bin, 'codex'));
    assert.equal(resolveExecutable(join(bin, 'codex'), {}), join(bin, 'codex'));
    for (const name of ['claude', 'plain', 'folder', join(bin, 'plain'), '']) assert.equal(resolveExecutable(name, env), null, name);
    assert.equal(isOnPath('codex', env), true);
    assert.equal(isOnPath('codex', { PATH: '' }), false);
    const service = serviceEnvironment({ runner: 'codex', executable: join(bin, 'codex'), stateDir: '/state', home: '/home/u', execPath: '/nvm/v22/bin/node' });
    assert.deepEqual(Object.keys(service).sort(), ['AWAIT_CODEX_EXECUTABLE', 'AWAIT_HOST_STATE', 'PATH']);
    assert.equal(service.AWAIT_CODEX_EXECUTABLE, join(bin, 'codex'));
    assert.equal(service.AWAIT_HOST_STATE, '/state');
    assert.deepEqual(service.PATH.split(':').slice(0, 3), ['/nvm/v22/bin', bin, '/home/u/.local/bin']);
    assert.ok(service.PATH.endsWith(':/usr/bin:/bin'));
    assert.equal(serviceEnvironment({ runner: 'claude', executable: '/usr/local/bin/claude', stateDir: '/s', home: '/h', execPath: '/usr/local/bin/node' }).PATH.split(':').filter((item) => item === '/usr/local/bin').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runCli reports exit codes, timeouts and missing executables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-host-test-'));
  try {
    const script = join(dir, 'cli');
    await writeFile(script, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (input === 'hang') { setInterval(() => {}, 1000); return; }
  process.stdout.write('out:' + input); process.stderr.write('err'); process.exitCode = 3;
});
`, { mode: 0o700 });
    let stdout = '', stderr = '';
    assert.deepEqual(await runCli(script, [], { input: 'é', timeoutMs: 5000, onStdout: (text) => { stdout += text; }, onStderr: (text) => { stderr += text; } }), { code: 3, signal: null, timedOut: false });
    assert.equal(stdout, 'out:é'); assert.equal(stderr, 'err');
    assert.deepEqual(await runCli(script, [], { input: 'hang', timeoutMs: 50 }), { code: null, signal: 'SIGTERM', timedOut: true });
    await assert.rejects(runCli(join(dir, 'missing'), [], { timeoutMs: 1000 }), (error) => error.code === 'ENOENT');
    assert.throws(() => runCli(script, []), /positive timeoutMs/);
    const args = codexArgs(['-']);
    assert.deepEqual(args.slice(0, 6), ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only']);
    for (const setting of ['features.shell_tool=false', 'features.plugins=false', 'web_search="disabled"']) assert.equal(args[args.indexOf(setting) - 1], '-c', setting);
    assert.equal(args.at(-1), '-');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Claude runner

const fakeClaude = async (dir, body) => {
  const executable = join(dir, 'claude');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(join(dir, 'capture.json'))}, JSON.stringify({ args: process.argv.slice(2), prompt, awaitKeys: Object.keys(process.env).filter((key) => key.startsWith('AWAIT_')) }));
  ${body}
});
`, { mode: 0o700 });
  return executable;
};

test('runClaude restricts the CLI, strips Await credentials and reads structured output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-host-test-'));
  process.env.AWAIT_TEST_SECRET = 'must-not-leak';
  try {
    const envelope = { type: 'result', subtype: 'success', is_error: false, result: '{"reply":true,"body":"pong — ok","notes":"n","request_thread":false}', structured_output: { reply: true, body: 'pong — ok', notes: 'n'.repeat(2500), request_thread: false } };
    const executable = await fakeClaude(dir, `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});`);
    const result = await runClaude('The prompt', dir, executable, { model: 'haiku' });
    assert.deepEqual(result, { reply: true, request_thread: false, notes: 'n'.repeat(2000), body: 'pong , ok' });
    const capture = JSON.parse(await readFile(join(dir, 'capture.json'), 'utf8'));
    assert.equal(capture.prompt, 'The prompt');
    assert.deepEqual(capture.awaitKeys, []);
    assert.deepEqual(capture.args, claudeArgs('haiku'));
    const args = capture.args;
    for (const pair of [['--output-format', 'json'], ['--tools', ''], ['--permission-prompts', 'none'], ['--model', 'haiku']]) assert.equal(args[args.indexOf(pair[0]) + 1], pair[1], pair.join(' '));
    for (const flag of ['--print', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
    assert.equal(JSON.parse(args[args.indexOf('--json-schema') + 1]).required.length, 4);
    assert.equal(args.includes('--mcp-config'), false);
    assert.equal(claudeArgs().includes('--model'), false);
  } finally { delete process.env.AWAIT_TEST_SECRET; await rm(dir, { recursive: true, force: true }); }
});

test('runClaude extracts the first JSON object when structured output is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-host-test-'));
  try {
    const text = 'Here is my answer:\n```json\n{"reply": false, "body": "", "notes": "A {nested} \\"quote\\" and }", "request_thread": true}\n```\nTrailing {"reply":true}';
    const executable = await fakeClaude(dir, `console.log('starting up'); console.log(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }))});`);
    assert.deepEqual(await runClaude('p', dir, executable), { reply: false, request_thread: true, notes: 'A {nested} "quote" and }', body: '' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runClaude reports CLI failures, exits and invalid replies without a reply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-host-test-'));
  try {
    const failing = await fakeClaude(dir, `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'You have hit your usage limit' }))});`);
    await assert.rejects(runClaude('p', dir, failing), /Claude response process failed \(error_during_execution\)\. Check Claude usage limits\./);
    const exiting = await fakeClaude(dir, `process.stderr.write('not logged in'); process.exit(1);`);
    await assert.rejects(runClaude('p', dir, exiting), /Claude response process failed \(1\)\. Check Claude login/);
    const malformed = await fakeClaude(dir, `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'I cannot answer in JSON.' }))});`);
    await assert.rejects(runClaude('p', dir, malformed), /Invalid agent reply/);
    await assert.rejects(runClaude('p', dir, join(dir, 'missing-cli')), /Claude could not start \(ENOENT\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Claude envelope parsing and reply validation guard the shape and size', () => {
  assert.deepEqual(parseClaudeResult(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { reply: false, body: '', notes: '', request_thread: false } })), { reply: false, body: '', notes: '', request_thread: false });
  assert.deepEqual(parseClaudeResult(`log line\n${JSON.stringify({ type: 'system' })}\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok {"reply":false,"body":"","notes":"x","request_thread":false}' })}\n`).notes, 'x');
  assert.throws(() => parseClaudeResult(''), /no result envelope/);
  assert.throws(() => parseClaudeResult(JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: '' })), /failed \(error_max_turns\)/);
  assert.equal(extractJsonObject('no objects here'), null);
  assert.deepEqual(extractJsonObject('{ broken {"a":1}'), { a: 1 });
  assert.throws(() => validateReply({ reply: true, body: '', notes: '', request_thread: false }), /Invalid agent reply/);
  assert.throws(() => validateReply({ reply: true, body: 'x'.repeat(bodyLimit + 1), notes: '', request_thread: false }), /Invalid agent reply/);
  assert.equal(validateReply({ reply: false, body: 'x'.repeat(bodyLimit + 1), notes: '', request_thread: false }).body.length, bodyLimit + 1);
  assert.throws(() => validateReply('{"reply":true}'), /Invalid agent reply/);
  assert.deepEqual(Object.keys(childEnvironment({ AWAIT_AGENT_TOKEN: 't', AWAIT_ORIGIN: 'o', PATH: '/bin', HOME: '/h' })).sort(), ['HOME', 'PATH']);
});

// Client library

function mockFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(request);
    const outcome = await handler(request, calls.length);
    const [status, body] = Array.isArray(outcome) ? outcome : [200, outcome];
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  return { fetch, calls };
}
const toolResult = (result) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } } });
const unknownTool = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool.' } };
const toolName = (request) => request.body?.params?.name;
const origin = 'http://127.0.0.1:5173';

test('client call posts JSON-RPC with the bearer token and unwraps tool results', async () => {
  const { fetch, calls } = mockFetch((request) => {
    if (toolName(request) === 'post_message') return toolResult({ id: 'm1' });
    if (toolName(request) === 'get_profile') return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"id":"p"}' }], structuredContent: { id: 'p' } } };
    if (toolName(request) === 'bare') return { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: { result: 'https://x' } } };
    if (toolName(request) === 'failing') return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Agent is paused.' }], isError: true } };
    if (toolName(request) === 'forbidden') return [403, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Reconnect Await and approve post access.' }], isError: true } }];
    return unknownTool;
  });
  const client = createAwaitClient({ origin: `${origin}/`, token: 'tok', fetch });
  assert.equal(client.origin, origin);
  assert.deepEqual(await client.call('post_message', { channel_id: 'c', body: 'hi' }), { id: 'm1' });
  assert.equal(calls[0].url, `${origin}/mcp`); assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(calls[0].body, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_message', arguments: { channel_id: 'c', body: 'hi' } } });
  assert.deepEqual(await client.call('get_profile'), { id: 'p' });
  assert.equal(await client.call('bare'), 'https://x');
  assert.equal(calls.at(-1).body.id, 3);
  await assert.rejects(client.call('failing'), (error) => error instanceof AwaitError && /Await tool failing failed: Agent is paused/.test(error.message));
  await assert.rejects(client.call('forbidden'), /Await request failed \(403\): Reconnect Await/);
  await assert.rejects(client.call('nope'), (error) => error instanceof AwaitError && error.code === -32602 && error.tool === 'nope');
  assert.throws(() => createAwaitClient({ origin, token: '' }), /token is required/);
  assert.throws(() => createAwaitClient({ origin: 'ftp://x', token: 't' }), /Invalid Await origin/);
});

test('client inbox calls wait_for_events with bounded arguments and normalizes events', async () => {
  const seen = [];
  const { fetch, calls } = mockFetch((request) => {
    assert.equal(toolName(request), 'wait_for_events'); seen.push(request.body.params.arguments);
    return toolResult({ events: [{ event_id: 'e2', name: 'task.updated' }, null], timed_out: false });
  });
  const client = createAwaitClient({ origin, token: 'tok', fetch });
  const inbox = await client.inbox({ timeout_ms: 1500, limit: 10 });
  assert.deepEqual(inbox, { events: [{ event_id: 'e2', eventId: 'e2', name: 'task.updated', data: {} }], timed_out: false });
  await client.inbox();
  await client.inbox({ timeout_ms: 90000, limit: 500 });
  // The server accepts timeout_ms 0 to 25000 and limit 1 to 50.
  assert.deepEqual(seen, [{ timeout_ms: 1500, limit: 10 }, { timeout_ms: 0, limit: 50 }, { timeout_ms: 25000, limit: 50 }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(normalizeInbox([{ id: 7, data: { channel_id: 'c' } }]).events, [{ id: 7, eventId: '7', data: { channel_id: 'c' } }]);
  assert.deepEqual(normalizeInbox(null), { events: [] });
});

test('client ack sends ack_events and includes an error only for failed events', async () => {
  const { fetch, calls } = mockFetch(() => toolResult({ acknowledged: 2 }));
  const client = createAwaitClient({ origin, token: 'tok', fetch });
  assert.deepEqual(await client.ack(['e1', 'e2'], 'failed', 'Boom'), { acknowledged: 2 });
  assert.equal(toolName(calls[0]), 'ack_events');
  assert.deepEqual(calls[0].body.params.arguments, { event_ids: ['e1', 'e2'], outcome: 'failed', error: 'Boom' });
  await client.ack('e3', 'completed', 'ignored');
  assert.deepEqual(calls[1].body.params.arguments, { event_ids: ['e3'], outcome: 'completed' });
  assert.deepEqual(await client.ack([]), { ok: true, event_ids: [] });
  await assert.rejects(client.ack(['e4'], 'done'), /completed or failed/);
  assert.equal(calls.length, 2);
});

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.listeners = {}; FakeSocket.instances.push(this); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  emit(type, payload = {}) { for (const listener of this.listeners[type] ?? []) listener(payload); }
  open() { this.readyState = 1; this.emit('open'); }
  send(data) { this.sent.push(data); }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', { code, reason }); }
}
const until = async (check, ms = 2000) => { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting.'); await new Promise((accept) => setTimeout(accept, 5)); } };

test('client openLive opens a ticket socket, pings, forwards frames and reconnects with backoff', async () => {
  FakeSocket.instances = [];
  let tickets = 0;
  const { fetch } = mockFetch((request) => { assert.equal(toolName(request), 'get_live_ticket'); return toolResult({ ticket: `t${++tickets}`, expires_at: 1, workspace_id: 'ws1' }); });
  const client = createAwaitClient({ origin, token: 'tok', fetch, WebSocket: FakeSocket });
  const frames = [], opens = [], closes = [];
  const live = client.openLive((frame) => frames.push(frame), { onOpen: () => opens.push(Date.now()), onClose: (detail) => closes.push(detail), pingMs: 20, backoffMs: 5, maxBackoffMs: 10 });
  await until(() => FakeSocket.instances.length === 1);
  const first = FakeSocket.instances[0];
  assert.equal(first.url, `ws://127.0.0.1:5173/api/workspaces/ws1/ws?ticket=t1`);
  assert.equal(live.connected, false);
  first.open();
  assert.equal(live.connected, true); assert.equal(opens.length, 1);
  first.emit('message', { data: 'pong' });
  first.emit('message', { data: 'not json' });
  first.emit('message', { data: JSON.stringify({ type: 'agent_events' }) });
  assert.deepEqual(frames, [{ type: 'agent_events' }]);
  await until(() => first.sent.includes('ping'));
  first.close(1006, 'lost');
  assert.deepEqual(closes, [{ code: 1006, reason: 'lost' }]);
  await until(() => FakeSocket.instances.length === 2);
  const second = FakeSocket.instances[1];
  assert.equal(second.url.endsWith('ticket=t2'), true);
  second.open();
  assert.equal(opens.length, 2);
  // A ping without a pong drops the socket and reconnects.
  await until(() => second.sent.includes('ping'));
  await until(() => second.readyState === 3);
  await until(() => FakeSocket.instances.length === 3);
  assert.equal(closes.length, 2);
  FakeSocket.instances[2].open();
  live.close();
  assert.equal(FakeSocket.instances[2].readyState, 3);
  await new Promise((accept) => setTimeout(accept, 60));
  assert.equal(FakeSocket.instances.length, 3);
  assert.equal(live.connected, false);
  assert.equal(closes.length, 2, 'closing the handle is not reported as a dropped connection');
  assert.throws(() => createAwaitClient({ origin, token: 'tok', fetch, WebSocket: null }).openLive(() => {}), /No WebSocket implementation/);
});

// Host loop with a mock client

function mockClient(pending) {
  const calls = [];
  return { calls, setPending: (list) => { pending = list; },
    context: async () => ({ kind: 'agent', workspace_id: 'ws1', agent: { id: 'agt_1', name: 'Loop Bot', description: 'd', owner: { id: 'o', name: 'Owner' } } }),
    call: async (name, args) => { calls.push([name, args]); return name === 'read_thread' ? [{ body: 'context' }] : { id: 'm1' }; },
    inbox: async () => ({ events: pending }),
    ack: async (ids, outcome, error) => { calls.push(['ack', ids, outcome, error]); pending = pending.filter((item) => !ids.includes(item.eventId)); return { ok: true }; },
    openLive: () => ({ close() {} }) };
}

test('the host drains the inbox, posts replies with a stable client_id, acks and persists memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-host-test-'));
  const mention = { eventId: 'evt1', name: 'message.created', data: { channel_id: 'c', message_id: 'root', thread_id: null, reply_count: 0, text: 'hi', mentions_agent: true, actor_name: 'Pat', actor_kind: 'human' } };
  const quiet = { eventId: 'evt2', name: 'message.created', data: { channel_id: 'c', message_id: 'm2', thread_id: null, mentions_agent: false, actor_name: 'Sam' } };
  const client = mockClient([mention, quiet]);
  const prompts = [], logs = [];
  const host = await startHost({ client, stateDir: dir, env: {}, runner: 'claude', token: 'tok', log: (line) => logs.push(line), warn: () => {},
    respond: async (prompt) => { prompts.push(prompt); return { reply: true, body: 'Hello Pat', notes: `memory ${prompts.length}`, request_thread: false }; } });
  try {
    assert.equal(host.runner, 'claude'); assert.equal(host.stateDir, dir);
    assert.match(logs[0], /Loop Bot host ready with the claude runner/);
    await host.drain();
    assert.ok(prompts[0].includes('owned by Owner.'));
    assert.deepEqual(client.calls, [
      ['post_message', { channel_id: 'c', thread_id: 'root', body: 'Hello Pat', client_id: 'evt1:reply' }],
      ['ack', ['evt1'], 'completed', undefined],
      ['ack', ['evt2'], 'completed', undefined]]);
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.handled, 2); assert.equal(state.replies, 1); assert.equal(state.memories.c, 'memory 2');
    assert.deepEqual(state.pending, {}); assert.equal(state.last_event.eventId, 'evt2');
  } finally { host.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('the host marks an event failed after three attempts and keeps going', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-host-test-'));
  const client = mockClient([{ eventId: 'bad', name: 'message.created', data: { channel_id: 'c', message_id: 'x', mentions_agent: true, actor_name: 'Pat' } }]);
  const warnings = [];
  const host = await startHost({ client, stateDir: dir, env: { AWAIT_RUNNER: 'codex' }, token: 'tok', log: () => {}, warn: (line) => warnings.push(line), respond: async () => { throw new Error('model down'); } });
  try {
    assert.equal(host.runner, 'codex');
    // The first call joins the drain the host started on its own.
    await host.drain(); await host.drain();
    assert.deepEqual(client.calls, []); assert.equal(host.getState().failures.bad, 2);
    assert.deepEqual(warnings, ['model down', 'model down']);
    await host.drain();
    assert.deepEqual(client.calls, [['ack', ['bad'], 'failed', 'The local host could not handle this event after three attempts. Check its log and retry the request.']]);
    assert.equal(host.getState().last_error, 'Event handling failed after three attempts.');
    assert.deepEqual(host.getState().failures, {});
  } finally { host.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('the host drains at startup, on reconnect and while disconnected, and forgets a removed channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-host-test-'));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ memories: { gone: 'old notes', kept: 'kept notes' },
    pending: { stale: { response: { reply: false, body: '', notes: 'pending notes', request_thread: false }, threadId: null, channelId: 'gone' } } }));
  const client = mockClient([]);
  let inboxCalls = 0, live;
  client.inbox = async () => { inboxCalls++; return { events: [] }; };
  client.openLive = (onEvent, options) => (live = { onEvent, options, connected: true, closed: false, close() { this.closed = true; } });
  const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
  const host = await startHost({ client, stateDir: dir, env: {}, runner: 'claude', token: 'tok', log: () => {}, warn: () => {}, pollMs: 10, respond: async () => response() });
  try {
    await until(() => inboxCalls === 1);
    await sleep(50);
    assert.equal(inboxCalls, 1, 'one startup drain and no polling while the socket is connected');
    live.options.onOpen();
    await until(() => inboxCalls === 2);
    live.connected = false;
    await until(() => inboxCalls >= 4);
    live.connected = true;
    live.onEvent({ type: 'channel_access_removed', channel_id: 'gone' });
    assert.deepEqual(host.getState().memories, { kept: 'kept notes' });
    assert.deepEqual(host.getState().pending, {});
    let saved;
    for (let attempt = 0; attempt < 200; attempt++) {
      saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
      if (!('gone' in saved.memories)) break;
      await sleep(5);
    }
    assert.deepEqual(saved.memories, { kept: 'kept notes' });
    assert.deepEqual(saved.pending, {});
  } finally { host.stop(); await rm(dir, { recursive: true, force: true }); }
  assert.equal(live.closed, true);
  const stopped = inboxCalls;
  await sleep(50);
  assert.equal(inboxCalls, stopped, 'stop ends polling');
});

test('the host refuses people, bad origins and missing runner CLIs up front', async () => {
  await assert.rejects(startHost({ env: {}, token: 'tok', client: { ...mockClient([]), context: async () => ({ kind: 'human' }) } }), /named Await agent is required/);
  await assert.rejects(startHost({ env: {}, token: 'tok', origin: 'file:///x', client: mockClient([]) }), /Invalid Await origin/);
  await assert.rejects(startHost({ env: {} }), /Set AWAIT_AGENT_TOKEN/);
  await assert.rejects(startHost({ env: { AWAIT_CLAUDE_EXECUTABLE: '/definitely/missing/claude' }, token: 'tok', runner: 'claude', client: mockClient([]) }), /claude CLI \(\/definitely\/missing\/claude\) is not on PATH/);
  await assert.rejects(startHost({ env: {}, token: 'tok', runner: 'gemini', client: mockClient([]) }), /Unknown runner "gemini"/);
});
