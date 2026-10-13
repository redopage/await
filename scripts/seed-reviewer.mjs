// Seeds the plugin-review workspace. Usage: node scripts/seed-reviewer.mjs --credentials <reviewer.json> --agent-output <agent.json>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const valueAfter = (flag) => {
  const position = process.argv.indexOf(flag);
  return position < 0 ? null : process.argv[position + 1];
};
const credentialsPath = valueAfter('--credentials');
const agentOutput = valueAfter('--agent-output');
if (!credentialsPath || !agentOutput) throw new Error('Usage: node scripts/seed-reviewer.mjs --credentials /private/reviewer.json --agent-output /private/agent.json');
const agentOutputPath = resolve(agentOutput);
const credentials = JSON.parse(readFileSync(resolve(credentialsPath), 'utf8'));
const base = new URL(credentials.login_url).origin;

async function json(path, method = 'GET', body, cookie) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${data.error || 'Unknown error'}`);
  return data;
}

const login = await fetch(new URL('/api/auth/reviewer', base), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: credentials.email, password: credentials.password }),
});
if (!login.ok) throw new Error(`Reviewer sign-in failed with ${login.status}`);
const session = (login.headers.get('set-cookie') || '').split(';')[0];
if (!session.startsWith('await_session=')) throw new Error('Reviewer sign-in did not return a session');
const me = await json('/api/me', 'GET', undefined, session);
if (me.account?.email !== credentials.email || me.workspaces?.length !== 1 || me.workspaces[0].name !== 'Await Plugin Review') throw new Error('The reviewer account must have exactly one isolated sample workspace.');
const workspaceId = me.workspaces[0].id;
const workspace = (path) => `/api/workspaces/${workspaceId}${path}`;
const snapshot = await json(workspace('/snapshot'), 'GET', undefined, session);
const general = snapshot.channels.find((channel) => channel.name === 'general');
if (!general) throw new Error('Sample workspace is missing #general');
let launch = snapshot.channels.find((channel) => channel.name === 'launch-plan');
if (!launch) launch = await json(workspace('/channels'), 'POST', { name: 'launch-plan', description: 'A sample space for channel, agent, and shared-work review.' }, session);

async function ensureMessage(channelId, body) {
  const path = workspace(`/channels/${channelId}/messages`);
  const messages = await json(path, 'GET', undefined, session);
  if (!messages.some((message) => message.body === body)) await json(path, 'POST', { body }, session);
}
await ensureMessage(general.id, 'Welcome to the Await plugin review workspace. Everything here is sample content. Open #launch-plan to see an agent, a task board, and a document beside the conversation.');
await ensureMessage(launch.id, 'Let’s track the launch work here. Tasks and the brief are shared with this channel, so the conversation keeps its context.');
await ensureMessage(launch.id, 'The launch checklist is ready for review. Open the task board beside this conversation to see the next steps.');

const boards = await json(workspace(`/collab/boards?channel=${launch.id}`), 'GET', undefined, session);
let board = boards.find((item) => item.name === 'Launch checklist');
if (!board) board = await json(workspace('/collab/boards'), 'POST', { channel_id: launch.id, name: 'Launch checklist' }, session);
const boardDetail = await json(workspace(`/collab/boards/${board.id}`), 'GET', undefined, session);
for (const task of [
  { title: 'Draft release notes', status: 'todo', priority: 2 },
  { title: 'Review onboarding copy', status: 'doing', priority: 3 },
  { title: 'Check phone accessibility', status: 'done', priority: 2 },
]) {
  if (!boardDetail.tasks.some((item) => item.title === task.title)) await json(workspace(`/collab/boards/${board.id}/tasks`), 'POST', task, session);
}
const documents = await json(workspace(`/collab/documents?channel=${launch.id}`), 'GET', undefined, session);
if (!documents.some((item) => item.title === 'Launch brief')) await json(workspace('/collab/documents'), 'POST', {
  channel_id: launch.id, title: 'Launch brief',
  body: 'Goal: make it easy for people and named agents to collaborate in channels.\n\nReview the conversation, open the task board, and edit this brief. All content in this workspace is sample data.',
}, session);

let agent = snapshot.members.find((member) => member.kind === 'agent' && member.name === 'Scout');
if (agent && !existsSync(agentOutputPath)) throw new Error('Scout already exists, but its saved token is missing. Rotate the token before seeding again.');
if (!agent && existsSync(agentOutputPath)) throw new Error('The agent token file already exists, but Scout is missing. Choose a new private output path.');
if (!agent) {
  const created = await json(workspace('/agents'), 'POST', { name: 'Scout', description: 'Sample agent for plugin review. It can read and post in #launch-plan.' }, session);
  writeFileSync(agentOutputPath, JSON.stringify({ agent_id: created.agent_id, token: created.token, mcp_url: created.mcp_url }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  agent = { account_id: created.agent_id, name: 'Scout', kind: 'agent' };
}
await json(workspace(`/channels/${launch.id}/members`), 'POST', { agent_id: agent.account_id }, session);

if (agent?.account_id && agentOutput) {
  const savedAgent = JSON.parse(readFileSync(agentOutputPath, 'utf8'));
  if (savedAgent.agent_id !== agent.account_id) throw new Error('Saved agent token does not belong to Scout.');
  const token = savedAgent.token;
  const messages = await json(workspace(`/channels/${launch.id}/messages`), 'GET', undefined, session);
  const body = 'I’m a sample named agent. My channel access is explicit, and the workspace owner can pause or limit me. Ask me to help with a task after connecting an agent of your own.';
  if (!messages.some((message) => message.body === body)) {
    await agentTool(token, 'post_message', { channel_id: launch.id, body });
  }
  if (!savedAgent.private_channel_id) {
    const privateChannel = await agentTool(token, 'create_channel', { name: 'leadership', is_private: true });
    if (!privateChannel?.id) throw new Error('Could not create the private sample channel.');
    savedAgent.private_channel_id = privateChannel.id;
    writeFileSync(agentOutputPath, JSON.stringify(savedAgent, null, 2) + '\n', { mode: 0o600 });
    await agentTool(token, 'post_message', { channel_id: privateChannel.id, body: 'Private sample content for access-control review.' });
  }
  const forbidden = await fetch(new URL(workspace(`/channels/${savedAgent.private_channel_id}/messages`), base), { headers: { cookie: session } });
  const denial = await forbidden.json();
  if (![400, 403].includes(forbidden.status) || denial.error !== 'You are not a member of this channel.') throw new Error(`Private-channel isolation failed with ${forbidden.status}`);
}
console.log(JSON.stringify({ workspace_id: workspaceId, channel_id: launch.id, board_id: board.id, agent_id: agent.account_id, seeded: true }));

async function agentTool(token, name, args) {
  const response = await fetch(new URL('/mcp', base), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const result = await response.json();
  if (!response.ok || result.error || result.result?.isError) throw new Error(`Sample agent ${name} failed with ${response.status}`);
  return result.result?.structuredContent?.result;
}
