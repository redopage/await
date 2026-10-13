// Checks the production plugin-review agent. Usage: node scripts/production-agent-smoke.mjs --credentials <reviewer.json> --agent <agent.json>
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : process.argv[index + 1];
};
const credentialsPath = valueAfter('--credentials');
const agentPath = valueAfter('--agent');
if (!credentialsPath || !agentPath) throw new Error('Usage: node scripts/production-agent-smoke.mjs --credentials /private/reviewer.json --agent /private/agent.json');

const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
const agent = JSON.parse(readFileSync(agentPath, 'utf8'));
const origin = new URL(credentials.login_url).origin;
if (origin !== 'https://await.chat' || !agent.agent_id || !agent.token) throw new Error('Expected the production Await reviewer credentials and agent token.');

async function api(path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function agentTool(name, args = {}) {
  const response = await fetch(new URL('/mcp', origin), {
    method: 'POST',
    headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`${name} failed with HTTP ${response.status}.`);
  return data.result;
}

function waitForMessage(socket, matches, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('message', onMessage); socket.off('error', onError); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Production WebSocket delivery timed out.')); }, timeout);
    const onError = (error) => { cleanup(); reject(error); };
    const onMessage = (raw) => {
      const event = JSON.parse(String(raw));
      if (!matches(event)) return;
      cleanup();
      resolve(event);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

const login = await api('/api/auth/reviewer', { method: 'POST', body: { email: credentials.email, password: credentials.password } });
if (!login.response.ok) throw new Error(`Reviewer sign-in failed with HTTP ${login.response.status}.`);
const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
if (!cookie?.startsWith('await_session=')) throw new Error('Reviewer sign-in did not return a session.');
const me = await api('/api/me', { cookie });
if (me.data.account?.email !== credentials.email || me.data.workspaces?.length !== 1 || me.data.workspaces[0].name !== 'Await Plugin Review') throw new Error('Reviewer account is not isolated to its sample workspace.');
const workspaceId = me.data.workspaces[0].id;
const snapshot = await api(`/api/workspaces/${workspaceId}/snapshot`, { cookie });
if (!snapshot.response.ok) throw new Error('Could not read the reviewer workspace.');
const launch = snapshot.data.channels?.find((channel) => channel.name === 'launch-plan' && channel.joined);
const scout = snapshot.data.members?.find((member) => member.account_id === agent.agent_id);
if (!launch || !scout || scout.paused) throw new Error('Reviewer agent is missing, paused, or lacks the launch channel.');
const context = await agentTool('get_agent_context');
if (context?.isError || context?.structuredContent?.result?.agent?.id !== agent.agent_id) throw new Error('Agent identity did not match its saved token.');

let socket;
let postedId;
let paused = false;
try {
  socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/workspaces/${workspaceId}/ws`, { headers: { cookie, origin } });
  const ready = await waitForMessage(socket, (event) => event.type === 'ready');
  if (ready.account_id !== me.data.account.id) throw new Error('Production WebSocket opened as the wrong person.');
  const body = `Production agent delivery check ${randomUUID()}`;
  const delivery = waitForMessage(socket, (event) => event.type === 'message' && event.message?.body === body);
  delivery.catch(() => {});
  const post = await agentTool('post_message', { channel_id: launch.id, body, client_id: randomUUID() });
  if (post?.isError || !post?.structuredContent?.result?.id) throw new Error('Agent could not post to the sample channel.');
  postedId = post.structuredContent.result.id;
  const event = await delivery;
  if (event.message.author_id !== agent.agent_id || event.message.id !== postedId) throw new Error('Live message had the wrong agent author or ID.');
  console.log('✓ Production agent post reached the reviewer WebSocket');

  const removed = await agentTool('delete_message', { message_id: postedId });
  if (removed?.isError) throw new Error('Could not remove the temporary review message.');
  postedId = undefined;

  const hold = await api(`/api/workspaces/${workspaceId}/agents/${agent.agent_id}/pause`, { method: 'POST', cookie, body: { paused: true } });
  if (!hold.response.ok) throw new Error('Reviewer could not pause the agent.');
  paused = true;
  const readable = await agentTool('read_messages', { channel_id: launch.id });
  if (readable?.isError) throw new Error('A paused agent lost permitted read access.');
  const denied = await agentTool('post_message', { channel_id: launch.id, body: `This must stay blocked ${randomUUID()}` });
  if (!denied?.isError || !/paused/i.test(denied.content?.[0]?.text || '')) throw new Error('A paused agent was able to post.');
  console.log('✓ Human pause blocked agent posting while reads stayed available');

  if (agent.private_channel_id) {
    const privateRead = await api(`/api/workspaces/${workspaceId}/channels/${agent.private_channel_id}/messages`, { cookie });
    if (![400, 403].includes(privateRead.response.status)) throw new Error('Reviewer could read the agent-only private channel.');
    console.log('✓ Reviewer remained outside the agent-only private channel');
  }
} finally {
  socket?.close();
  if (paused) {
    const resumed = await api(`/api/workspaces/${workspaceId}/agents/${agent.agent_id}/pause`, { method: 'POST', cookie, body: { paused: false } });
    if (!resumed.response.ok) throw new Error('Could not resume the reviewer agent after the test.');
  }
  if (postedId) await agentTool('delete_message', { message_id: postedId }).catch(() => {});
}
console.log('✓ Production reviewer agent restored');
