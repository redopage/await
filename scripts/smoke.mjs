import WebSocket from 'ws';

const origin = process.env.AWAIT_SMOKE_ORIGIN ?? 'http://127.0.0.1:5173';
const stamp = Date.now();

async function request(path, { cookie, body, method = 'GET', headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body && typeof body === 'object' && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body && typeof body === 'object' && !(body instanceof Blob) ? JSON.stringify(body) : body,
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function login(name, email) {
  const { response } = await request('/api/dev/login', { method: 'POST', body: { name, email } });
  if (!response.ok) throw new Error(`Dev login failed: ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}

function check(ok, description) {
  if (!ok) throw new Error(description);
  console.log(`✓ ${description}`);
}

function nextSocketEvent(socket, matches, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Socket event timed out.')); }, timeout);
    const receive = (raw) => {
      const event = JSON.parse(raw.toString());
      if (!matches(event)) return;
      clearTimeout(timer);
      socket.off('message', receive);
      resolve(event);
    };
    socket.on('message', receive);
  });
}

// Dev sign-in lets @localhost accounts create workspaces, so the suite needs no bootstrap domain.
const owner = await login('Smoke owner', `smoke-${stamp}@localhost`);
const bob = await login('Bob', `bob-${stamp}@example.com`);
const outsider = await login('Outsider', `outsider-${stamp}@example.com`);
const malformedSession = await request('/api/me', { headers: { cookie: 'await_session=%ZZ' } });
check(malformedSession.response.ok && malformedSession.data.account === null, 'Malformed session cookies are treated as signed out');
const ownerAccount = await request('/api/me', { cookie: owner });
const originalNotifications = await request('/api/notifications', { cookie: owner });
check(originalNotifications.response.ok && originalNotifications.data.email_mentions === false && originalNotifications.data.email_dms === false, 'Email notifications require opt-in');
const savedNotifications = await request('/api/notifications', { cookie: owner, method: 'POST', body: { email_mentions: true, email_dms: false } });
check(savedNotifications.response.ok && savedNotifications.data.email_mentions === true, 'Notification preferences save');
await request('/api/notifications', { cookie: owner, method: 'POST', body: { email_mentions: originalNotifications.data.email_mentions, email_dms: originalNotifications.data.email_dms } });

const deniedCreate = await request('/api/workspaces', { cookie: bob, method: 'POST', body: { name: 'Unauthorized workspace' } });
check(deniedCreate.response.status === 403, 'Invite-only workspace creation');

const created = await request('/api/workspaces', { cookie: owner, method: 'POST', body: { name: `Smoke ${stamp}` } });
check(created.response.status === 201, 'Owner creates workspace');
const workspaceId = created.data.id;
const generalId = created.data.channel_id;
const gifConfig = await request(`/api/workspaces/${workspaceId}/gifs/config`, { cookie: owner });
const hiddenGifConfig = await request(`/api/workspaces/${workspaceId}/gifs/config`, { cookie: outsider });
check(gifConfig.response.ok && typeof gifConfig.data.enabled === 'boolean' && !('key' in gifConfig.data) && hiddenGifConfig.response.status === 404, 'GIF availability stays private and never exposes the provider key');
const hiddenGifSearch = await request(`/api/workspaces/${workspaceId}/gifs/search?q=hello`, { cookie: outsider });
check(hiddenGifSearch.response.status === 404, 'GIF search requires workspace access');
const defaultAgentLimits = await request(`/api/workspaces/${workspaceId}/settings`, { cookie: owner });
check(defaultAgentLimits.response.ok && defaultAgentLimits.data.rate_per_minute === 20 && defaultAgentLimits.data.turn_cap === 10, 'Workspace starts with safe agent limits');
const badProfile = await request('/api/me', { cookie: owner, method: 'PATCH', body: { name: 'x' } });
check(badProfile.response.status === 400, 'Display names require a useful length');
const savedProfile = await request('/api/me', { cookie: owner, method: 'PATCH', body: { name: '  Smoke   Teammate  ' } });
const renamedAccount = await request('/api/me', { cookie: owner });
const renamedSnapshot = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(savedProfile.response.ok && renamedAccount.data.account.name === 'Smoke Teammate' && renamedSnapshot.data.members.find((member) => member.account_id === ownerAccount.data.account.id)?.name === 'Smoke Teammate', 'Profile name syncs to workspace members');

const invite = await request(`/api/workspaces/${workspaceId}/invites`, { cookie: owner, method: 'POST', body: {} });
check(invite.response.ok && invite.data.url, 'Owner creates invite');
const token = invite.data.url.split('/').at(-1);
const joined = await request('/api/invites/accept', { cookie: bob, method: 'POST', body: { token } });
check(joined.response.ok && joined.data.workspace_id === workspaceId, 'Teammate joins through invite');
const snapshot = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: bob });
check(snapshot.data.channels.some((channel) => channel.id === generalId && channel.joined), 'Invite joins general channel');
const memberLimits = await request(`/api/workspaces/${workspaceId}/settings`, { cookie: bob });
const deniedLimitChange = await request(`/api/workspaces/${workspaceId}/settings`, { cookie: bob, method: 'PUT', body: { rate_per_minute: 2, turn_cap: 2 } });
const invalidLimits = await request(`/api/workspaces/${workspaceId}/settings`, { cookie: owner, method: 'PUT', body: { rate_per_minute: 0, turn_cap: 2 } });
check(memberLimits.response.status === 403 && deniedLimitChange.response.status === 403 && invalidLimits.response.status === 400, 'Only admins can save valid agent limits');
for (let index = 0; index < 8; index += 1) {
  const teammate = await login(`Invite teammate ${index}`, `invite-${index}-${stamp}@example.com`);
  const accepted = await request('/api/invites/accept', { cookie: teammate, method: 'POST', body: { token } });
  check(accepted.response.ok, `Invite accepts teammate ${index + 2} of 10`);
}
const finalClaimants = await Promise.all([
  login('Final claimant A', `invite-final-a-${stamp}@example.com`),
  login('Final claimant B', `invite-final-b-${stamp}@example.com`),
]);
const finalClaims = await Promise.all(finalClaimants.map((cookie) => request('/api/invites/accept', { cookie, method: 'POST', body: { token } })));
check(finalClaims.filter((result) => result.response.ok).length === 1, 'Only one concurrent join claims the last invite use');
const exhaustedInvite = await request('/api/invites/accept', { cookie: outsider, method: 'POST', body: { token } });
check(exhaustedInvite.response.status === 400, 'Invite rejects a new member after its last use');
const retriedInvite = await request('/api/invites/accept', { cookie: bob, method: 'POST', body: { token } });
const retriedSnapshot = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: bob });
check(retriedInvite.response.ok && retriedSnapshot.data.channels.some((item) => item.id === generalId && item.joined), 'Existing member can retry an exhausted invite');
const ownerRetry = await request('/api/invites/accept', { cookie: owner, method: 'POST', body: { token } });
const ownerRetrySnapshot = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(ownerRetry.response.ok && ownerRetrySnapshot.data.members.find((member) => member.account_id === ownerAccount.data.account.id)?.role === 'owner', 'Invite retry preserves an existing owner role');

const channel = await request(`/api/workspaces/${workspaceId}/channels`, { cookie: owner, method: 'POST', body: { name: 'agent-work' } });
check(channel.response.ok && channel.data.id, 'Create channel');
const channelId = channel.data.id;
const bobJoin = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/join`, { cookie: bob, method: 'POST', body: {} });
check(bobJoin.response.ok, 'Teammate joins public channel');
const allAlerts = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/notify`, { cookie: owner, method: 'POST', body: { notify: 'all' } });
const ownerAlertSnapshot = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
const bobAlertSnapshot = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: bob });
check(allAlerts.response.ok && ownerAlertSnapshot.data.channels.find((item) => item.id === channelId)?.notify === 'all' && bobAlertSnapshot.data.channels.find((item) => item.id === channelId)?.notify === 'mentions', 'Channel alert preference belongs to each member');
const quietAlerts = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/notify`, { cookie: owner, method: 'POST', body: { notify: 'none' } });
const deniedAlerts = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/notify`, { cookie: outsider, method: 'POST', body: { notify: 'all' } });
check(quietAlerts.data.notify === 'none' && !deniedAlerts.response.ok, 'Channel alerts can be quieted only by a channel member');
await request(`/api/workspaces/${workspaceId}/channels/${channelId}/notify`, { cookie: owner, method: 'POST', body: { notify: 'mentions' } });

const socketUrl = `${origin.replace(/^http/, 'ws')}/api/workspaces/${workspaceId}/ws`;
const ownerSocket = new WebSocket(socketUrl, { headers: { cookie: owner, origin } });
const ownerReady = nextSocketEvent(ownerSocket, (event) => event.type === 'ready');
await new Promise((resolve, reject) => { ownerSocket.once('open', resolve); ownerSocket.once('error', reject); });
check((await ownerReady).online_ids.includes(ownerAccount.data.account.id), 'Presence includes the connected person');
const bobOnline = nextSocketEvent(ownerSocket, (event) => event.type === 'presence' && event.online && event.account_id !== ownerAccount.data.account.id);
const bobSocket = new WebSocket(socketUrl, { headers: { cookie: bob, origin } });
const bobReady = nextSocketEvent(bobSocket, (event) => event.type === 'ready');
await new Promise((resolve, reject) => { bobSocket.once('open', resolve); bobSocket.once('error', reject); });
const bobReadyEvent = await bobReady;
check(bobReadyEvent.online_ids.includes(ownerAccount.data.account.id) && (await bobOnline).account_id === bobReadyEvent.account_id, 'Joining teammate appears online');
for (const malformed of ['null', '[]', 'false']) {
  const rejected = nextSocketEvent(bobSocket, (event) => event.type === 'error' && event.error === 'Invalid event.');
  bobSocket.send(malformed);
  check(Boolean(await rejected), `Malformed socket event ${malformed} is rejected without disconnecting`);
}
const oversized = nextSocketEvent(bobSocket, (event) => event.type === 'error' && event.error === 'Message is too large.');
bobSocket.send(' '.repeat(65_537));
check(Boolean(await oversized), 'Oversized socket event is rejected without disconnecting');
const typingSeen = nextSocketEvent(ownerSocket, (event) => event.type === 'typing' && event.account_id === bobReadyEvent.account_id && event.channel_id === channelId && event.active);
bobSocket.send(JSON.stringify({ type: 'typing', channel_id: channelId, active: true }));
check((await typingSeen).thread_id === null, 'Typing reaches conversation members');
const typingStopped = nextSocketEvent(ownerSocket, (event) => event.type === 'typing' && event.account_id === bobReadyEvent.account_id && event.active === false);
bobSocket.send(JSON.stringify({ type: 'typing', channel_id: channelId, active: false }));
check((await typingStopped).channel_id === channelId, 'Typing can clear without a message');
const deniedTyping = nextSocketEvent(bobSocket, (event) => event.type === 'error' && String(event.error).includes('not a member'));
bobSocket.send(JSON.stringify({ type: 'typing', channel_id: crypto.randomUUID(), active: true }));
check(Boolean(await deniedTyping), 'Typing follows channel membership');
const liveMessage = `Live delivery ${stamp}`;
const liveClientId = crypto.randomUUID();
const received = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Live message timed out.')), 4000);
  ownerSocket.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'message' && event.message.body === liveMessage) { clearTimeout(timer); resolve(event.message); } });
});
bobSocket.send(JSON.stringify({ type: 'send', channel_id: channelId, body: liveMessage, client_id: liveClientId }));
const firstLive = await received;
check(firstLive.body === liveMessage, 'One socket delivers live messages to another member');
check(firstLive.client_id === liveClientId, 'Live broadcast carries the client id for optimistic reconciliation');
const threadTyping = nextSocketEvent(ownerSocket, (event) => event.type === 'typing' && event.thread_id === firstLive.id && event.account_id === bobReadyEvent.account_id);
bobSocket.send(JSON.stringify({ type: 'typing', channel_id: channelId, thread_id: firstLive.id, active: true }));
check((await threadTyping).active, 'Thread typing identifies its parent message');
const invalidThreadTyping = nextSocketEvent(bobSocket, (event) => event.type === 'error' && String(event.error).includes('Thread not found'));
bobSocket.send(JSON.stringify({ type: 'typing', channel_id: channelId, thread_id: crypto.randomUUID(), active: true }));
check(Boolean(await invalidThreadTyping), 'Typing rejects a missing thread');
const beforeRead = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(beforeRead.data.channels.find((item) => item.id === channelId)?.last_read_id === null, 'Conversation exposes the previous read position');
const markedRead = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/read`, { cookie: owner, method: 'POST', body: { message_id: firstLive.id } });
const afterRead = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(markedRead.response.ok && afterRead.data.channels.find((item) => item.id === channelId)?.last_read_id === firstLive.id, 'Conversation exposes the updated read position');
const liveReaction = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Reaction event timed out.')), 4000);
  ownerSocket.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'reaction' && event.message_id === firstLive.id) { clearTimeout(timer); resolve(event); } });
});
const bobReaction = await request(`/api/workspaces/${workspaceId}/messages/${firstLive.id}/reactions`, { cookie: bob, method: 'POST', body: { emoji: '👍' } });
check(bobReaction.data.active && (await liveReaction).channel_id === channelId, 'Reaction updates live for channel members');
const ownerOffline = nextSocketEvent(bobSocket, (event) => event.type === 'presence' && event.account_id === ownerAccount.data.account.id && !event.online);
ownerSocket.close();
await new Promise((resolve) => ownerSocket.once('close', resolve));
check(Boolean(await ownerOffline), 'Presence clears when the last connection closes');
const missedBody = `Missed while disconnected ${stamp}`;
const missedId = crypto.randomUUID();
const missedAck = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Missed message ack timed out.')), 4000);
  bobSocket.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'ack' && event.client_id === missedId) { clearTimeout(timer); resolve(event.message); } });
});
bobSocket.send(JSON.stringify({ type: 'send', channel_id: channelId, body: missedBody, client_id: missedId }));
await missedAck;
const ownerBackOnline = nextSocketEvent(bobSocket, (event) => event.type === 'presence' && event.account_id === ownerAccount.data.account.id && event.online);
const restoredSocket = new WebSocket(socketUrl, { headers: { cookie: owner, origin } });
await new Promise((resolve, reject) => { restoredSocket.once('open', resolve); restoredSocket.once('error', reject); });
check(Boolean(await ownerBackOnline), 'Presence returns after reconnect');
const caughtUp = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Reconnect sync timed out.')), 4000);
  restoredSocket.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'sync') { clearTimeout(timer); resolve(event.messages); } });
});
restoredSocket.send(JSON.stringify({ type: 'sync', after: firstLive.id }));
const caughtUpMessages = await caughtUp;
check(caughtUpMessages.some((message) => message.body === missedBody), 'Reconnect catches up without losing messages');
// A large gap arrives in pages that each fit inside the socket frame limit, with files and reactions attached.
const burstCursor = caughtUpMessages.at(-1).id;
const burstChannel = await request(`/api/workspaces/${workspaceId}/channels`, { cookie: owner, method: 'POST', body: { name: 'burst-lab' } });
await request(`/api/workspaces/${workspaceId}/channels/${burstChannel.data.id}/join`, { cookie: bob, method: 'POST', body: {} });
for (let batch = 0; batch < 13; batch++) await Promise.all(Array.from({ length: 10 }, (_, index) => request(`/api/workspaces/${workspaceId}/channels/${burstChannel.data.id}/messages`, { cookie: bob, method: 'POST', body: { body: `burst ${batch * 10 + index}`, client_id: `burst-${stamp}-${batch * 10 + index}` } })));
const syncPages = [];
const pagedSync = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Paged sync timed out.')), 8000);
  restoredSocket.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type !== 'sync') return; syncPages.push(event); if (event.done) { clearTimeout(timer); resolve(syncPages); } else restoredSocket.send(JSON.stringify({ type: 'sync', after: event.next })); });
});
restoredSocket.send(JSON.stringify({ type: 'sync', after: burstCursor }));
const pages = await pagedSync;
const pagedTotal = pages.reduce((count, page) => count + page.messages.length, 0);
check(pages.length === 2 && pages[0].messages.length === 100 && pages[0].done === false && pages[0].next === pages[0].messages.at(-1).id && pagedTotal === 130 && pages[1].done === true && Array.isArray(pages[0].messages[0].attachments) && Array.isArray(pages[0].messages[0].reactions), 'Reconnect catch-up pages large gaps and hydrates every page');
restoredSocket.close(); bobSocket.close();
const reactedMessages = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob });
check(reactedMessages.data.find((item) => item.id === firstLive.id)?.reactions?.find((item) => item.emoji === '👍')?.mine === 1, 'Reactions show who participated');
const outsiderReaction = await request(`/api/workspaces/${workspaceId}/messages/${firstLive.id}/reactions`, { cookie: outsider, method: 'POST', body: { emoji: '👍' } });
check(!outsiderReaction.response.ok, 'Reaction follows channel membership');
const removedReaction = await request(`/api/workspaces/${workspaceId}/messages/${firstLive.id}/reactions`, { cookie: bob, method: 'POST', body: { emoji: '👍' } });
check(removedReaction.data.active === false, 'A member can remove their reaction');
const ownerMessage = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: 'An owner note.' } });
const deniedModeration = await request(`/api/workspaces/${workspaceId}/messages/${ownerMessage.data.id}/delete`, { cookie: bob, method: 'POST', body: {} });
const moderated = await request(`/api/workspaces/${workspaceId}/messages/${firstLive.id}/delete`, { cookie: owner, method: 'POST', body: {} });
const moderatedHistory = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob });
check(!deniedModeration.response.ok && moderated.response.ok && moderatedHistory.data.find((message) => message.id === firstLive.id)?.deleted_at, 'Admins can remove a teammate message; members cannot');

const agent = await request(`/api/workspaces/${workspaceId}/agents`, { cookie: owner, method: 'POST', body: { name: 'Research agent', description: 'Answers questions' } });
check(agent.response.ok && agent.data.token, 'Create named agent and token');
const agentId = agent.data.agent_id;
const addAgent = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/members`, { cookie: owner, method: 'POST', body: { agent_id: agentId } });
check(addAgent.response.ok, 'Human adds agent to channel');
const teammatePause = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: bob, method: 'POST', body: { paused: true } });
const pausedForTeam = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(teammatePause.response.ok && pausedForTeam.data.members.find((member) => member.account_id === agentId)?.paused === 1, 'Any teammate can pause an agent');
const deniedTokenRotation = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/rotate`, { cookie: bob, method: 'POST', body: {} });
check(deniedTokenRotation.response.status === 403, 'Pausing an agent does not grant access to its credentials');
const deniedResume = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: bob, method: 'POST', body: { paused: false } });
check(deniedResume.response.status === 403, 'Only the owner or an admin can resume a paused agent');
const teammateResume = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: owner, method: 'POST', body: { paused: false } });
check(teammateResume.response.ok && teammateResume.data.paused === 0, 'The owner can resume an agent');
const invalidPause = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: bob, method: 'POST', body: { paused: 'true' } });
check(invalidPause.response.status === 400, 'Pause requires an explicit boolean');

const bobId = snapshot.data.members.find((member) => member.name === 'Bob')?.account_id;
const dm = await request(`/api/workspaces/${workspaceId}/dms`, { cookie: owner, method: 'POST', body: { other_id: bobId } });
check(dm.response.status === 201 && dm.data.id, 'Owner starts a direct message');
const sameDm = await request(`/api/workspaces/${workspaceId}/dms`, { cookie: bob, method: 'POST', body: { other_id: ownerAccount.data.account.id } });
check(sameDm.data.id === dm.data.id, 'Direct message is shared without duplicates');
const bobDm = await request(`/api/workspaces/${workspaceId}/channels/${dm.data.id}/messages`, { cookie: bob, method: 'POST', body: { body: 'Private hello' } });
check(bobDm.response.ok, 'Teammate can send a direct message');
const agentDm = await request(`/api/workspaces/${workspaceId}/channels/${dm.data.id}/messages`, { cookie: owner, method: 'GET' });
check(agentDm.data.some((message) => message.body === 'Private hello'), 'Owner can read the direct message');
const outsiderDm = await request(`/api/workspaces/${workspaceId}/channels/${dm.data.id}/messages`, { cookie: outsider });
check(!outsiderDm.response.ok, 'Direct message stays private');

async function mcp(tokenValue, name, args = {}) {
  const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokenValue}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
  return { response, data: await response.json().catch(() => ({})) };
}

const codingAgent = await request(`/api/workspaces/${workspaceId}/agents`, { cookie: owner, method: 'POST', body: { name: 'Coding agent', description: 'Builds features' } });
check(codingAgent.response.ok && codingAgent.data.token, 'Human creates a second agent');
const addCodingAgent = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/members`, { cookie: owner, method: 'POST', body: { agent_id: codingAgent.data.agent_id } });
check(addCodingAgent.response.ok, 'Human adds second agent to channel');
const handoff = await mcp(codingAgent.data.token, 'post_message', { channel_id: channelId, body: `Research agent, what should I check? <@${agentId}>` });
const handoffId = handoff.data.result?.structuredContent?.result?.id;
check(Boolean(handoffId), 'Coding agent asks research agent in channel');
const mentions = await mcp(agent.data.token, 'get_mentions');
check(mentions.data.result?.structuredContent?.result?.some((message) => message.id === handoffId), 'Research agent receives the handoff mention');
const awaitedMention = mcp(agent.data.token, 'wait_for_mentions', { after: handoffId, timeout_ms: 2500 });
const followupMention = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: `A second question for <@${agentId}>` } });
const waited = await awaitedMention;
check(waited.data.result?.structuredContent?.result?.some((message) => message.id === followupMention.data.id), 'Agent wait returns when a new mention arrives');
const timedOut = await mcp(agent.data.token, 'wait_for_mentions', { after: followupMention.data.id, timeout_ms: 100 });
check(Array.isArray(timedOut.data.result?.structuredContent?.result) && timedOut.data.result.structuredContent.result.length === 0, 'Agent wait returns an empty list at timeout');
await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: owner, method: 'POST', body: { paused: true } });
const pausedMention = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: `Are you there, <@${agentId}>?` } });
const pausedWait = await mcp(agent.data.token, 'wait_for_mentions', { after: followupMention.data.id, timeout_ms: 100 });
const pausedLookup = await mcp(agent.data.token, 'get_mentions', { after: followupMention.data.id });
await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: owner, method: 'POST', body: { paused: false } });
check(pausedWait.data.result?.structuredContent?.result?.length === 0 && pausedLookup.data.result?.structuredContent?.result?.some((message) => message.id === pausedMention.data.id), 'A paused agent is not woken by mentions but can still look them up');
const handoffReply = await mcp(agent.data.token, 'post_message', { channel_id: channelId, thread_id: handoffId, body: 'Check the invite and member permissions first.' });
check(handoffReply.data.result?.structuredContent?.result?.thread_id === handoffId, 'Research agent answers in the thread');
const humanReview = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages?thread=${handoffId}`, { cookie: bob });
check(humanReview.data.length === 2 && humanReview.data[1].body.includes('permissions'), 'Human sees both agent messages');
const threadMention = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob, method: 'POST', body: { body: `Andrew, can you review? <@${ownerAccount.data.account.id}>`, thread_id: handoffId } });
await request(`/api/workspaces/${workspaceId}/channels/${channelId}/read`, { cookie: owner, method: 'POST', body: { message_id: handoffId } });
const unreadThread = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner });
const ownerUnread = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(unreadThread.data.find((message) => message.id === handoffId)?.unread_mentions === 1 && ownerUnread.data.channels.find((item) => item.id === channelId)?.mentions === 1, 'Thread mention identifies the conversation to read');
const outsiderThreadRead = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/threads/${handoffId}/read`, { cookie: outsider, method: 'POST', body: { message_id: threadMention.data.id } });
check(!outsiderThreadRead.response.ok, 'Outsider cannot mark a private thread read');
const readThreadMention = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/threads/${handoffId}/read`, { cookie: owner, method: 'POST', body: { message_id: threadMention.data.id } });
const clearedThread = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner });
const clearedSidebar = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(readThreadMention.response.ok && clearedThread.data.find((message) => message.id === handoffId)?.unread_mentions === 0 && clearedSidebar.data.channels.find((item) => item.id === channelId)?.mentions === 0, 'Opening a thread clears its mention');
await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob, method: 'POST', body: { body: 'Thanks, please continue with that check.', thread_id: handoffId } });

const agentViewer = new WebSocket(socketUrl, { headers: { cookie: owner, origin } });
const agentViewerReady = nextSocketEvent(agentViewer, (event) => event.type === 'ready');
await new Promise((resolve, reject) => { agentViewer.once('open', resolve); agentViewer.once('error', reject); });
await agentViewerReady;
const agentBody = `Research agent reporting in ${stamp}.`;
const startedAt = performance.now();
const agentDelivery = nextSocketEvent(agentViewer, (event) => event.type === 'message' && event.message.body === agentBody)
  .then((event) => ({ event, elapsedMs: performance.now() - startedAt }));
const agentPostPromise = mcp(agent.data.token, 'post_message', { channel_id: channelId, body: agentBody });
const deliveredAgentMessage = await agentDelivery;
const agentPost = await agentPostPromise;
agentViewer.close();
check(!agentPost.data.result?.isError && agentPost.data.result?.structuredContent?.result?.id === deliveredAgentMessage.event.message.id, 'Agent posts through MCP and reaches an open WebSocket');
check(deliveredAgentMessage.elapsedMs < 1000, `Agent WebSocket delivery is prompt (${Math.round(deliveredAgentMessage.elapsedMs)} ms locally)`);
const rootId = agentPost.data.result.structuredContent.result.id;
const reply = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob, method: 'POST', body: { body: 'A human reply.', thread_id: rootId } });
check(reply.response.ok && reply.data.thread_id === rootId, 'Human replies in thread');
const thread = await mcp(agent.data.token, 'read_thread', { channel_id: channelId, thread_id: rootId });
check(thread.data.result?.structuredContent?.result?.length === 2, 'Agent reads thread');
const latestReply = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob, method: 'POST', body: { body: 'Another reply.', thread_id: rootId } });
const compactThread = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages?thread=${rootId}&limit=2`, { cookie: bob });
check(compactThread.response.ok && compactThread.data.length === 2 && compactThread.data[0].id === rootId && compactThread.data[0].reply_count === 2 && compactThread.data[1].id === latestReply.data.id, 'A limited thread keeps its original message, reply count, and newest reply');
const activity = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/activity`, { cookie: owner });
check(activity.response.ok && activity.data.last_active_at > 0 && activity.data.entries.some((entry) => entry.action === 'post_message' && entry.target_id === rootId) && activity.data.entries.some((entry) => entry.action === 'read_thread' && entry.target_id === rootId), 'Owner sees agent post and read activity');
const deniedActivity = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/activity`, { cookie: bob });
check(deniedActivity.response.status === 400 || deniedActivity.response.status === 403, 'Another member cannot inspect agent activity');
const approvalOn = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/approval`, { cookie: owner, method: 'POST', body: { enabled: true } });
check(approvalOn.response.ok && approvalOn.data.approval_mode === 1, 'Owner enables agent post approval');
const deniedApprovalSetting = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/approval`, { cookie: bob, method: 'POST', body: { enabled: false } });
check(!deniedApprovalSetting.response.ok, 'Another member cannot change agent approval mode');
const proposedBody = `Proposed answer ${stamp}`;
const proposedClientId = crypto.randomUUID();
const proposed = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: proposedBody, client_id: proposedClientId });
const proposedId = proposed.data.result?.structuredContent?.result?.id;
const retryProposal = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: proposedBody, client_id: proposedClientId });
const beforeApproval = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob });
check(proposed.data.result?.structuredContent?.result?.pending === true && retryProposal.data.result?.structuredContent?.result?.id === proposedId && !beforeApproval.data.some((message) => message.body === proposedBody), 'Proposed agent post is private and retry-safe');
const pendingStatus = await mcp(agent.data.token, 'get_post_status', { post_id: proposedId });
const deniedStatus = await mcp(codingAgent.data.token, 'get_post_status', { post_id: proposedId });
const ownerQueue = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pending`, { cookie: owner });
const deniedQueue = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pending`, { cookie: bob });
check(pendingStatus.data.result?.structuredContent?.result?.status === 'pending' && deniedStatus.data.result?.isError && ownerQueue.data.some((item) => item.id === proposedId) && !deniedQueue.response.ok, 'Owner alone sees agent approval queue');
await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: owner, method: 'POST', body: { paused: true } });
const heldApproval = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pending/${proposedId}`, { cookie: owner, method: 'POST', body: { decision: 'approve' } });
check(!heldApproval.response.ok, 'A paused agent cannot be published through approval');
await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: owner, method: 'POST', body: { paused: false } });
const approvedPost = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pending/${proposedId}`, { cookie: owner, method: 'POST', body: { decision: 'approve' } });
const postedStatus = await mcp(agent.data.token, 'get_post_status', { post_id: proposedId });
const afterApproval = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob });
check(approvedPost.response.ok && postedStatus.data.result?.structuredContent?.result?.status === 'approved' && afterApproval.data.some((message) => message.body === proposedBody && message.author_id === agentId), 'Approval publishes as the agent and updates status');
const retryAfterApproval = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: proposedBody, client_id: proposedClientId });
check(retryAfterApproval.data.result?.structuredContent?.result?.id === approvedPost.data.message.id, 'Approved post remains idempotent on retry');
const rejectedProposal = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: `Reject me ${stamp}`, client_id: crypto.randomUUID() });
const rejectedId = rejectedProposal.data.result?.structuredContent?.result?.id;
const rejectedPost = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pending/${rejectedId}`, { cookie: owner, method: 'POST', body: { decision: 'reject' } });
const rejectedStatus = await mcp(agent.data.token, 'get_post_status', { post_id: rejectedId });
check(rejectedPost.data.status === 'rejected' && rejectedStatus.data.result?.structuredContent?.result?.status === 'rejected', 'Rejected proposal never posts and agent can see its status');
const proposalFile = await request(`/api/agent/channels/${channelId}/files`, { method: 'POST', body: new Blob(['Review this attachment'], { type: 'text/plain' }), headers: { authorization: `Bearer ${agent.data.token}`, 'content-type': 'text/plain', 'x-file-name': 'proposal.txt' } });
const withFile = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: 'Proposed file', attachment_ids: [proposalFile.data.id] });
const withFileId = withFile.data.result?.structuredContent?.result?.id;
const filePreviewPath = `/api/workspaces/${workspaceId}/agents/${agentId}/pending/${withFileId}/files/${proposalFile.data.id}`;
const ownerPreview = await fetch(`${origin}${filePreviewPath}`, { headers: { cookie: owner } });
const bobPreview = await fetch(`${origin}${filePreviewPath}`, { headers: { cookie: bob } });
check(ownerPreview.status === 200 && await ownerPreview.text() === 'Review this attachment' && !bobPreview.ok, 'Owner previews a queued file without exposing it to teammates');
const approvedFile = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pending/${withFileId}`, { cookie: owner, method: 'POST', body: { decision: 'approve' } });
check(approvedFile.response.ok && approvedFile.data.message?.attachments?.[0]?.id === proposalFile.data.id, 'Approved file becomes a normal channel attachment');
const approvalOff = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/approval`, { cookie: owner, method: 'POST', body: { enabled: false } });
check(approvalOff.response.ok && approvalOff.data.approval_mode === 0, 'Owner disables approval mode');
await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: 'Human resets the agent turn after review.' } });

const paused = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: owner, method: 'POST', body: { paused: true } });
const blocked = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: 'This must fail.' });
check(paused.data.paused === 1 && blocked.data.result?.isError, 'Pause stops agent posts');
const sampleSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="green"/></svg>';
const blockedSvg = await mcp(agent.data.token, 'post_svg', { channel_id: channelId, svg: sampleSvg });
check(blockedSvg.data.result?.isError, 'Pause also stops an agent SVG post');
const avatarBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9wPikAAAAASUVORK5CYII=', 'base64');
const avatar = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/avatar`, { cookie: owner, method: 'POST', body: new Blob([avatarBytes], { type: 'image/png' }), headers: { 'content-type': 'image/png' } });
check(avatar.response.ok && avatar.data.avatar_url?.includes(agentId), 'Owner uploads an agent avatar');
const avatarForMember = await fetch(`${origin}${avatar.data.avatar_url}`, { headers: { cookie: bob } });
const avatarForOutsider = await fetch(`${origin}${avatar.data.avatar_url}`, { headers: { cookie: outsider } });
check(avatarForMember.status === 200 && avatarForOutsider.status === 404, 'Agent avatar follows workspace access');
const afterAvatar = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(afterAvatar.data.members.find((member) => member.account_id === agentId)?.paused === 1, 'Changing an avatar preserves the pause state');
await request(`/api/workspaces/${workspaceId}/agents/${agentId}/pause`, { cookie: owner, method: 'POST', body: { paused: false } });
const addAgentToGeneral = await request(`/api/workspaces/${workspaceId}/channels/${generalId}/members`, { cookie: owner, method: 'POST', body: { agent_id: agentId } });
check(addAgentToGeneral.response.ok, 'Agent can belong to more than one channel');
const deniedMute = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/mute`, { cookie: bob, method: 'POST', body: { agent_id: agentId, muted: true } });
check(!deniedMute.response.ok, 'A member cannot mute another human’s agent');
const mutedAgent = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/mute`, { cookie: owner, method: 'POST', body: { agent_id: agentId, muted: true } });
const channelRoster = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/members`, { cookie: owner });
const generalRoster = await request(`/api/workspaces/${workspaceId}/channels/${generalId}/members`, { cookie: owner });
const mutedPost = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: 'Muted agent must not post.' });
check(mutedAgent.response.ok && channelRoster.data.find((member) => member.account_id === agentId)?.muted === 1 && generalRoster.data.find((member) => member.account_id === agentId)?.muted === 0 && mutedPost.data.result?.isError, 'Channel mute blocks only that agent in that channel');
const unmutedAgent = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/mute`, { cookie: owner, method: 'POST', body: { agent_id: agentId, muted: false } });
check(unmutedAgent.response.ok && unmutedAgent.data.muted === false, 'Owner restores agent posting in channel');

for (let index = 0; index < 10; index++) {
  const turn = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: `Agent turn ${index + 1}` });
  check(!turn.data.result?.isError, `Agent turn ${index + 1} accepted`);
}
const held = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: 'Blocked by turn cap' });
check(held.data.result?.isError && held.data.result.content[0].text.includes('held'), 'Agent turn cap stops loops');
await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: 'Human stepping in.' } });
const svgPost = await mcp(agent.data.token, 'post_svg', { channel_id: channelId, svg: sampleSvg, caption: 'Agent sketch' });
const svgMessage = svgPost.data.result?.structuredContent?.result;
const svgFile = svgMessage?.attachments?.[0];
const agentSvgDownload = svgFile && await fetch(`${origin}/api/workspaces/${workspaceId}/files/${svgFile.id}`, { headers: { cookie: bob } });
const agentSvgDenied = svgFile && await fetch(`${origin}/api/workspaces/${workspaceId}/files/${svgFile.id}`, { headers: { cookie: outsider } });
check(svgFile?.mime === 'image/svg+xml' && agentSvgDownload?.status === 200 && await agentSvgDownload.text() === sampleSvg && agentSvgDownload.headers.get('content-disposition')?.startsWith('attachment') && agentSvgDenied?.status === 404, 'Agent SVG is a private downloadable drawing file');
const pngPost = await mcp(agent.data.token, 'post_file', { channel_id: channelId, filename: 'preview.png', mime: 'image/png', content_base64: avatarBytes.toString('base64') });
const pngMessage = pngPost.data.result?.structuredContent?.result;
const pngFile = pngMessage?.attachments?.[0];
check(pngFile?.kind === 'image', 'MCP raster upload becomes an image preview');
const pngDownload = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${pngFile.id}`, { headers: { cookie: bob } });
check(pngDownload.ok && pngDownload.headers.get('content-type') === 'image/png' && pngDownload.headers.get('content-disposition')?.startsWith('inline') && Buffer.from(await pngDownload.arrayBuffer()).equals(avatarBytes), 'MCP image preview downloads intact with inline image headers');
const pngShare = await mcp(agent.data.token, 'share_file', { channel_id: channelId, attachment_id: pngFile.id });
check(pngShare.data.result?.structuredContent?.result?.attachments?.[0]?.kind === 'image', 'Sharing an MCP image preserves its preview');
const pngHistory = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob });
const pngLibrary = await request(`/api/workspaces/${workspaceId}/files?q=preview.png`, { cookie: bob });
check(pngHistory.data.find((message) => message.id === pngMessage.id)?.attachments?.[0]?.kind === 'image' && pngLibrary.data.find((file) => file.id === pngFile.id)?.kind === 'image', 'Image preview classification survives message history and file picker reads');
const afterHuman = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: 'Back on track.' });
check(!afterHuman.data.result?.isError, 'Human message releases agent turn cap');

const payload = new Blob(['Smoke test file'], { type: 'text/plain' });
const uploaded = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/files`, { cookie: owner, method: 'POST', body: payload, headers: { 'content-type': 'text/plain', 'x-file-name': 'smoke.txt' } });
check(uploaded.response.ok && uploaded.data.id, 'Upload private file');
const oversizedBody = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(25 * 1024 * 1024 + 1)); controller.close(); } });
const oversizedUpload = await fetch(`${origin}/api/workspaces/${workspaceId}/channels/${channelId}/files`, {
  method: 'POST', headers: { cookie: owner, 'content-type': 'application/octet-stream', 'x-file-name': 'too-large.bin' }, body: oversizedBody, duplex: 'half',
});
check(oversizedUpload.status === 413, 'Chunked upload stops at the 25 MB limit');
const fileMessage = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: 'Shared a file.', attachment_ids: [uploaded.data.id] } });
check(fileMessage.response.ok && fileMessage.data.attachments?.length === 1, 'Attach file to message');
const agentReadFile = await mcp(agent.data.token, 'get_attachment', { attachment_id: uploaded.data.id });
check(agentReadFile.data.result?.structuredContent?.result?.content === 'Smoke test file', 'Agent reads shared text attachment through MCP');
const allowedFile = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${uploaded.data.id}`, { headers: { cookie: bob } });
const deniedFile = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${uploaded.data.id}`, { headers: { cookie: outsider } });
check(allowedFile.status === 200 && deniedFile.status === 404, 'File access follows channel membership');
const svgUpload = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/files`, { cookie: owner, method: 'POST', body: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' }), headers: { 'content-type': 'image/svg+xml', 'x-file-name': 'diagram.svg' } });
await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: 'Shared an SVG.', attachment_ids: [svgUpload.data.id] } });
const svgDownload = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${svgUpload.data.id}`, { headers: { cookie: bob } });
check(svgUpload.data.kind === 'file' && svgDownload.headers.get('content-disposition')?.startsWith('attachment;') && svgDownload.headers.get('content-security-policy') === 'sandbox', 'Executable file types download without inline execution');
const filesForBob = await request(`/api/workspaces/${workspaceId}/files`, { cookie: bob });
check(filesForBob.response.ok && filesForBob.data.some((file) => file.id === uploaded.data.id && file.channel_name === 'agent-work'), 'Uploaded file appears in the member file picker');
const searchedFiles = await request(`/api/workspaces/${workspaceId}/files?q=smoke`, { cookie: bob });
check(searchedFiles.data.some((file) => file.id === uploaded.data.id), 'File picker searches uploaded filenames');
const reused = await request(`/api/workspaces/${workspaceId}/channels/${generalId}/files/reuse`, { cookie: owner, method: 'POST', body: { file_id: uploaded.data.id } });
check(reused.response.ok && reused.data.id !== uploaded.data.id, 'Previously shared file can be added to another channel');
const reusedMessage = await request(`/api/workspaces/${workspaceId}/channels/${generalId}/messages`, { cookie: owner, method: 'POST', body: { body: 'Shared the file again.', attachment_ids: [reused.data.id] } });
const reusedDownload = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${reused.data.id}`, { headers: { cookie: bob } });
check(reusedMessage.response.ok && reusedMessage.data.attachments?.[0]?.id === reused.data.id && await reusedDownload.text() === 'Smoke test file', 'Reused file remains in private storage and downloads correctly');
const deletedFileMessage = await request(`/api/workspaces/${workspaceId}/messages/${fileMessage.data.id}/delete`, { cookie: owner, method: 'POST', body: {} });
const hiddenOriginal = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${uploaded.data.id}`, { headers: { cookie: bob } });
const hiddenFromAgent = await mcp(agent.data.token, 'get_attachment', { attachment_id: uploaded.data.id });
const copyStillAvailable = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${reused.data.id}`, { headers: { cookie: bob } });
check(deletedFileMessage.response.ok && hiddenOriginal.status === 404 && hiddenFromAgent.data.result?.isError && copyStillAvailable.status === 200, 'Deleting a message hides its files while independent copies remain available');
const storageObjects = async (fileId, fileChannelId) => {
  if (!new URL(origin).hostname.match(/^(localhost|127\.0\.0\.1)$/)) return null;
  const prefix = `${workspaceId}/${fileChannelId}/${fileId}/`;
  const response = await fetch(`${origin}/cdn-cgi/local/explorer/api/r2/buckets/await-chat-files/objects?prefix=${encodeURIComponent(prefix)}`);
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
  return (await response.json()).result;
};
const deletedOriginalObjects = await storageObjects(uploaded.data.id, channelId);
if (deletedOriginalObjects) check(deletedOriginalObjects.length === 0 && (await storageObjects(reused.data.id, generalId)).length === 1, 'Deleting a message releases its R2 file while keeping an independent copy');
const unusedUpload = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/files`, { cookie: owner, method: 'POST', body: new Blob(['Unused draft'], { type: 'text/plain' }), headers: { 'content-type': 'text/plain', 'x-file-name': 'unused.txt' } });
const deniedDraftRemoval = await request(`/api/workspaces/${workspaceId}/files/${unusedUpload.data.id}`, { cookie: bob, method: 'DELETE' });
const removedDraft = await request(`/api/workspaces/${workspaceId}/files/${unusedUpload.data.id}`, { cookie: owner, method: 'DELETE' });
check(deniedDraftRemoval.response.status === 404 && removedDraft.response.ok, 'Only the uploader can remove an unsent file');
const unusedObjects = await storageObjects(unusedUpload.data.id, channelId);
if (unusedObjects) check(unusedObjects.length === 0, 'Removing an unsent file releases its R2 copy');
const privateChannel = await request(`/api/workspaces/${workspaceId}/channels`, { cookie: owner, method: 'POST', body: { name: 'private-files', is_private: true } });
const privateUpload = await request(`/api/workspaces/${workspaceId}/channels/${privateChannel.data.id}/files`, { cookie: owner, method: 'POST', body: new Blob(['Private report'], { type: 'text/plain' }), headers: { 'content-type': 'text/plain', 'x-file-name': 'private-report.txt' } });
await request(`/api/workspaces/${workspaceId}/channels/${privateChannel.data.id}/messages`, { cookie: owner, method: 'POST', body: { body: 'Private report', attachment_ids: [privateUpload.data.id] } });
const bobFiles = await request(`/api/workspaces/${workspaceId}/files`, { cookie: bob });
const deniedReuse = await request(`/api/workspaces/${workspaceId}/channels/${generalId}/files/reuse`, { cookie: bob, method: 'POST', body: { file_id: privateUpload.data.id } });
check(!bobFiles.data.some((file) => file.id === privateUpload.data.id) && !deniedReuse.response.ok, 'Private channel files stay out of other members’ picker and cannot be reused');
const agentDeniedPrivate = await mcp(agent.data.token, 'get_attachment', { attachment_id: privateUpload.data.id });
check(agentDeniedPrivate.data.result?.isError, 'Agent cannot read a private-channel attachment without membership');
const bobAccount = await request('/api/me', { cookie: bob });
const deniedPrivateAdd = await request(`/api/workspaces/${workspaceId}/channels/${privateChannel.data.id}/members`, { cookie: bob, method: 'POST', body: { account_id: bobAccount.data.account.id } });
const deniedOutsiderAdd = await request(`/api/workspaces/${workspaceId}/channels/${privateChannel.data.id}/members`, { cookie: owner, method: 'POST', body: { account_id: (await request('/api/me', { cookie: outsider })).data.account.id } });
check(!deniedPrivateAdd.response.ok && !deniedOutsiderAdd.response.ok, 'Private membership requires a channel member and workspace teammate');
const addedBob = await request(`/api/workspaces/${workspaceId}/channels/${privateChannel.data.id}/members`, { cookie: owner, method: 'POST', body: { account_id: bobAccount.data.account.id } });
const addedBobAgain = await request(`/api/workspaces/${workspaceId}/channels/${privateChannel.data.id}/members`, { cookie: owner, method: 'POST', body: { account_id: bobAccount.data.account.id } });
const bobPrivateFile = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${privateUpload.data.id}`, { headers: { cookie: bob } });
check(addedBob.response.ok && addedBobAgain.data.already_member && bobPrivateFile.status === 200, 'A teammate can be added to a private channel and read its shared file');
const deniedKick = await request(`/api/workspaces/${workspaceId}/channels/${privateChannel.data.id}/members/${ownerAccount.data.account.id}`, { cookie: bob, method: 'DELETE' });
const removedBob = await request(`/api/workspaces/${workspaceId}/channels/${privateChannel.data.id}/members/${bobAccount.data.account.id}`, { cookie: owner, method: 'DELETE' });
const bobPrivateAfterRemoval = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${privateUpload.data.id}`, { headers: { cookie: bob } });
check(!deniedKick.response.ok && removedBob.response.ok && bobPrivateAfterRemoval.status !== 200, 'Channel creator can revoke a teammate without losing private file protection');
const agentPrivate = await mcp(agent.data.token, 'create_channel', { name: 'agent-private-home', is_private: true });
const agentPrivateId = agentPrivate.data.result?.structuredContent?.result?.id;
const ownerAfterAgentPrivate = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(agentPrivate.response.ok && agentPrivateId && ownerAfterAgentPrivate.data.channels.some((item) => item.id === agentPrivateId && item.joined), 'An agent-created private channel includes its human owner');

const agentUpload = await request(`/api/agent/channels/${channelId}/files`, { method: 'POST', body: new Blob(['Agent report'], { type: 'text/plain' }), headers: { authorization: `Bearer ${agent.data.token}`, 'content-type': 'text/plain', 'x-file-name': 'agent-report.txt' } });
check(agentUpload.response.status === 200 && agentUpload.data.id, 'Agent uploads a file with its scoped token');
const agentUnused = await request(`/api/agent/channels/${channelId}/files`, { method: 'POST', body: new Blob(['Discard me'], { type: 'text/plain' }), headers: { authorization: `Bearer ${agent.data.token}`, 'content-type': 'text/plain', 'x-file-name': 'agent-unused.txt' } });
const agentRemoved = await request(`/api/agent/files/${agentUnused.data.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${agent.data.token}` } });
check(agentUnused.response.ok && agentRemoved.response.ok, 'Agent can discard its own unsent file');
const agentUnusedObjects = await storageObjects(agentUnused.data.id, channelId);
if (agentUnusedObjects) check(agentUnusedObjects.length === 0, 'Agent draft removal releases its R2 copy');
const agentFilePost = await mcp(agent.data.token, 'post_message', { channel_id: channelId, body: 'Attached my report.', attachment_ids: [agentUpload.data.id] });
check(agentFilePost.data.result?.structuredContent?.result?.attachments?.length === 1, 'Agent shares its uploaded file through MCP');
const agentDownload = await fetch(`${origin}/api/agent/files/${agentUpload.data.id}`, { headers: { authorization: `Bearer ${agent.data.token}` } });
check(agentDownload.status === 200 && await agentDownload.text() === 'Agent report', 'Agent reads a member-only file');
const fileActivity = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/activity`, { cookie: owner });
check(fileActivity.data.entries.some((entry) => entry.action === 'get_attachment' && entry.target_id === agentUpload.data.id && entry.target_name === 'agent-report.txt'), 'Agent file reads appear in owner activity');

const drawingScene = new Blob([JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} })], { type: 'application/vnd.excalidraw+json' });
const drawingPreview = new Blob([avatarBytes], { type: 'image/png' });
const firstScene = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/files`, { cookie: owner, method: 'POST', body: drawingScene, headers: { 'content-type': drawingScene.type, 'x-file-name': 'Drawing.excalidraw' } });
const firstPreview = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/files`, { cookie: owner, method: 'POST', body: drawingPreview, headers: { 'content-type': drawingPreview.type, 'x-file-name': 'Drawing-preview.png' } });
const drawingRoot = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: 'Shared a drawing', attachment_ids: [firstPreview.data.id, firstScene.data.id] } });
const sceneDownload = await fetch(`${origin}/api/workspaces/${workspaceId}/files/${firstScene.data.id}`, { headers: { cookie: bob } });
check(drawingRoot.response.ok && firstPreview.data.kind === 'image' && drawingRoot.data.attachments?.some((item) => item.kind === 'drawing') && (await sceneDownload.json()).type === 'excalidraw', 'Posted drawing keeps an editable scene beside its image preview');
const agentReadScene = await mcp(agent.data.token, 'get_attachment', { attachment_id: firstScene.data.id });
check(agentReadScene.data.result?.structuredContent?.result?.content?.includes('"type":"excalidraw"'), 'Agent reads shared drawing scene through MCP');
const updatedScene = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/files`, { cookie: bob, method: 'POST', body: drawingScene, headers: { 'content-type': drawingScene.type, 'x-file-name': 'Drawing.excalidraw' } });
const updatedPreview = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/files`, { cookie: bob, method: 'POST', body: drawingPreview, headers: { 'content-type': drawingPreview.type, 'x-file-name': 'Drawing-preview.png' } });
const drawingUpdate = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob, method: 'POST', body: { body: 'Updated drawing', thread_id: drawingRoot.data.id, attachment_ids: [updatedPreview.data.id, updatedScene.data.id] } });
const drawingThread = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages?thread=${drawingRoot.data.id}`, { cookie: owner });
check(drawingUpdate.response.ok && drawingThread.data.some((item) => item.id === drawingUpdate.data.id && item.thread_id === drawingRoot.data.id && item.attachments?.some((file) => file.kind === 'drawing')), 'Drawing update appears as a new editable version in its thread');

const board = await request(`/api/workspaces/${workspaceId}/collab/boards`, { cookie: owner, method: 'POST', body: { channel_id: channelId, name: 'Team plan' } });
check(board.response.status === 201 && board.data.id, 'Create a task board in a channel');
const restrictedBoard = await request(`/api/workspaces/${workspaceId}/collab/boards/${board.data.id}`, { cookie: outsider });
check(restrictedBoard.response.status === 404, 'Task board stays private to channel members');
const task = await request(`/api/workspaces/${workspaceId}/collab/boards/${board.data.id}/tasks`, { cookie: bob, method: 'POST', body: { title: 'Ship launch page', assignee_id: ownerAccount.data.account.id, priority: 3, due_at: Date.now() + 86400000 } });
check(task.response.status === 201 && task.data.assignee_id === ownerAccount.data.account.id, 'Teammate creates and assigns a task');
const movedTask = await request(`/api/workspaces/${workspaceId}/collab/tasks/${task.data.id}`, { cookie: owner, method: 'PATCH', body: { status: 'doing' } });
check(movedTask.data.status === 'doing', 'Task status updates');
const boardDetail = await request(`/api/workspaces/${workspaceId}/collab/boards/${board.data.id}`, { cookie: bob });
check(boardDetail.data.tasks?.[0]?.status === 'doing', 'Task board reflects teammate changes');

const taskReference = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob, method: 'POST', body: { body: `Started on <task:${task.data.id}> this morning <task:not-a-task>`, client_id: `task-ref-${stamp}` } });
check(taskReference.response.ok && taskReference.data.tasks?.length === 1 && taskReference.data.tasks[0].title === 'Ship launch page' && taskReference.data.tasks[0].status === 'doing', 'A message can reference a Kanban card inline and receives the resolved card');
const referencedTask = await request(`/api/workspaces/${workspaceId}/collab/tasks/${task.data.id}`, { cookie: owner });
check(referencedTask.response.ok && referencedTask.data.references?.length === 1 && referencedTask.data.references[0].message_id === taskReference.data.id && referencedTask.data.references[0].excerpt.includes('#Ship launch page'), 'The card lists the message that referenced it with a readable excerpt');
const countedBoard = await request(`/api/workspaces/${workspaceId}/collab/boards/${board.data.id}`, { cookie: bob });
check(countedBoard.data.tasks.find((item) => item.id === task.data.id)?.reference_count === 1, 'Board tasks carry their reference count');
const channelTasks = await request(`/api/workspaces/${workspaceId}/collab/tasks?channel=${channelId}`, { cookie: bob });
check(channelTasks.response.ok && channelTasks.data.some((item) => item.id === task.data.id && item.board_name === 'Team plan'), 'The channel task list feeds composer suggestions');
check(!(await request(`/api/workspaces/${workspaceId}/collab/tasks?channel=${channelId}`, { cookie: outsider })).response.ok, 'Outsiders cannot list channel tasks');
const privateBoard = await request(`/api/workspaces/${workspaceId}/collab/boards`, { cookie: owner, method: 'POST', body: { channel_id: privateChannel.data.id, name: 'Private plan' } });
const privateTask = await request(`/api/workspaces/${workspaceId}/collab/boards/${privateBoard.data.id}/tasks`, { cookie: owner, method: 'POST', body: { title: 'Private launch task' } });
const finishedTask = await request(`/api/workspaces/${workspaceId}/collab/boards/${board.data.id}/tasks`, { cookie: owner, method: 'POST', body: { title: 'Finished launch task' } });
await request(`/api/workspaces/${workspaceId}/collab/tasks/${finishedTask.data.id}`, { cookie: owner, method: 'PATCH', body: { status: 'done' } });
const ownerOpenTasks = (await request(`/api/workspaces/${workspaceId}/collab/tasks`, { cookie: owner })).data;
const bobOpenTasks = (await request(`/api/workspaces/${workspaceId}/collab/tasks`, { cookie: bob })).data;
const listed = (tasks, id) => Array.isArray(tasks) && tasks.some((item) => item.id === id);
check(listed(ownerOpenTasks, task.data.id) && listed(ownerOpenTasks, privateTask.data.id) && !listed(ownerOpenTasks, finishedTask.data.id)
  && ownerOpenTasks.find((item) => item.id === task.data.id)?.channel_id === channelId, 'The Tasks page lists open tasks across the reader’s channels');
check(listed(bobOpenTasks, task.data.id) && !listed(bobOpenTasks, privateTask.data.id), 'The Tasks page leaves out tasks from channels the reader is not in');
check(!(await request(`/api/workspaces/${workspaceId}/collab/tasks`, { cookie: outsider })).response.ok, 'Outsiders cannot list workspace tasks');
const editedReference = await request(`/api/workspaces/${workspaceId}/messages/${taskReference.data.id}/edit`, { cookie: bob, method: 'POST', body: { body: 'Started on it this morning' } });
check(editedReference.response.ok && (await request(`/api/workspaces/${workspaceId}/collab/tasks/${task.data.id}`, { cookie: owner })).data.references.length === 0, 'Editing the tag out of a message removes the reference');
const doc = await request(`/api/workspaces/${workspaceId}/collab/documents`, { cookie: owner, method: 'POST', body: { channel_id: channelId, title: 'Launch notes' } });
check(doc.response.status === 201 && doc.data.id, 'Create a shared document');
const savedDoc = await request(`/api/workspaces/${workspaceId}/collab/documents/${doc.data.id}`, { cookie: bob, method: 'PUT', body: { title: 'Launch notes', body: '# Ready\n\nWorking together.' } });
check(savedDoc.data.body.includes('Working together.'), 'Teammate saves a document');
const restrictedDoc = await request(`/api/workspaces/${workspaceId}/collab/documents/${doc.data.id}`, { cookie: outsider });
check(restrictedDoc.response.status === 404, 'Document stays private to channel members');

const indexedWork = await mcp(agent.data.token, 'search_workspace', { query: 'launch', kinds: ['task', 'document'], limit: 3 });
const indexedItems = indexedWork.data.result?.structuredContent?.result?.items;
check(indexedWork.response.ok && indexedItems?.some((item) => item.id === task.data.id) && indexedItems?.some((item) => item.id === doc.data.id), 'Workers FTS5 searches task and document text');
check(indexedItems?.every((item) => item.excerpt.length <= 320 && item.url.includes(workspaceId)), 'Search returns bounded excerpts and canonical links');
const oneTask = await mcp(agent.data.token, 'read_task', { task_id: task.data.id });
check(oneTask.data.result?.structuredContent?.result?.id === task.data.id, 'MCP reads one task without loading its board');
await request(`/api/workspaces/${workspaceId}/collab/tasks/${task.data.id}`, { cookie: owner, method: 'PATCH', body: { status: 'done' } });
const activeSearch = await mcp(agent.data.token, 'search_workspace', { query: 'launch', kinds: ['task'] });
const doneSearch = await mcp(agent.data.token, 'search_workspace', { query: 'launch is:done', kinds: ['task'] });
check(!activeSearch.data.result?.structuredContent?.result?.items.some((item) => item.id === task.data.id) && doneSearch.data.result?.structuredContent?.result?.items.some((item) => item.id === task.data.id), 'FTS5 defaults to active tasks and supports completed discovery');
const privateSearch = await mcp(codingAgent.data.token, 'search_workspace', { query: 'Private hello' });
check(privateSearch.data.result?.structuredContent?.result?.items.length === 0, 'Indexed discovery does not expose another member’s DM');

for (let index = 0; index < 52; index++) {
  const added = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: owner, method: 'POST', body: { body: `History item ${index}`, client_id: crypto.randomUUID() } });
  if (!added.response.ok) throw new Error(`History seed ${index} failed.`);
}
const newestPage = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, { cookie: bob });
const olderPage = await request(`/api/workspaces/${workspaceId}/channels/${channelId}/messages?before=${newestPage.data[0].id}`, { cookie: bob });
check(newestPage.data.length === 50 && olderPage.data.length > 0 && olderPage.data.at(-1).id < newestPage.data[0].id, 'Channel history pages backward without overlap');

const temporaryChannel = await request(`/api/workspaces/${workspaceId}/channels`, { cookie: owner, method: 'POST', body: { name: 'temporary' } });
await request(`/api/workspaces/${workspaceId}/channels/${temporaryChannel.data.id}/join`, { cookie: bob, method: 'POST', body: {} });
const renamedChannel = await request(`/api/workspaces/${workspaceId}/channels/${temporaryChannel.data.id}/rename`, { cookie: owner, method: 'POST', body: { name: 'renamed' } });
check(renamedChannel.response.ok, 'Channel can be renamed');
const smuggled = await request(`/api/workspaces/${workspaceId}/channels/${encodeURIComponent('x/../../members/upsert?')}/messages`, { cookie: bob, method: 'POST', body: { account_id: bobId, kind: 'human', name: 'Bob', avatar_url: null, role: 'owner', owner_id: null, description: null, paused: 0 } });
const bobRole = (await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: bob })).data.members.find((member) => member.account_id === bobId)?.role;
check(smuggled.response.status === 404 && bobRole === 'member', 'Encoded path params cannot reach internal routes');
const teammateArchive = await request(`/api/workspaces/${workspaceId}/channels/${temporaryChannel.data.id}/archive`, { cookie: bob, method: 'POST', body: {} });
check(teammateArchive.response.status === 403, 'Only the channel creator or an admin can archive a channel');
const duplicateName = await request(`/api/workspaces/${workspaceId}/channels/${temporaryChannel.data.id}/rename`, { cookie: owner, method: 'POST', body: { name: 'general' } });
check(!duplicateName.response.ok && /exists/.test(duplicateName.data.error ?? ''), 'Renaming to a taken channel name explains the conflict');
const protectedGeneral = await request(`/api/workspaces/${workspaceId}/channels/${generalId}/rename`, { cookie: owner, method: 'POST', body: { name: 'renamed-general' } });
check(!protectedGeneral.response.ok, 'General channel keeps its protected name');
const leftChannel = await request(`/api/workspaces/${workspaceId}/channels/${temporaryChannel.data.id}/leave`, { cookie: bob, method: 'POST', body: {} });
check(leftChannel.response.ok, 'Member can leave a channel');
const archivedChannel = await request(`/api/workspaces/${workspaceId}/channels/${temporaryChannel.data.id}/archive`, { cookie: owner, method: 'POST', body: {} });
check(archivedChannel.response.ok, 'Channel can be archived');

const rotated = await request(`/api/workspaces/${workspaceId}/agents/${agentId}/rotate`, { cookie: owner, method: 'POST', body: {} });
const oldToken = await mcp(agent.data.token, 'list_channels');
const newToken = await mcp(rotated.data.token, 'list_channels');
check(oldToken.response.status === 401 && newToken.response.ok, 'Token rotation revokes old token immediately');

const removalInvite = await request(`/api/workspaces/${workspaceId}/invites`, { cookie: owner, method: 'POST', body: {} });
const removalToken = removalInvite.data.url.split('/').at(-1);
const leaving = await login('Leaving teammate', `leaving-${stamp}@example.com`);
await request('/api/invites/accept', { cookie: leaving, method: 'POST', body: { token: removalToken } });
const leavingAccount = await request('/api/me', { cookie: leaving });
const leavingId = leavingAccount.data.account.id;
const leavingMessage = await request(`/api/workspaces/${workspaceId}/channels/${generalId}/messages`, { cookie: leaving, method: 'POST', body: { body: 'A note that should retain its author.' } });
check(leavingMessage.response.ok, 'Teammate contributes before removal');
const leavingAgent = await request(`/api/workspaces/${workspaceId}/agents`, { cookie: leaving, method: 'POST', body: { name: 'Leaving agent' } });
check(leavingAgent.response.status === 201, 'Teammate can create an agent before removal');
const deniedRemoval = await request(`/api/workspaces/${workspaceId}/members/${ownerAccount.data.account.id}`, { cookie: leaving, method: 'DELETE' });
const deniedSelfRemoval = await request(`/api/workspaces/${workspaceId}/members/${ownerAccount.data.account.id}`, { cookie: owner, method: 'DELETE' });
check(deniedRemoval.response.status === 403 && !deniedSelfRemoval.response.ok, 'Members cannot remove an owner and owners cannot remove themselves');
const leavingSocket = new WebSocket(socketUrl, { headers: { cookie: leaving, origin } });
await new Promise((resolve, reject) => { leavingSocket.once('open', resolve); leavingSocket.once('error', reject); });
const removedPerson = await request(`/api/workspaces/${workspaceId}/members/${leavingId}`, { cookie: owner, method: 'DELETE' });
check(removedPerson.response.ok && removedPerson.data.connections_targeted === 1, 'Owner removes teammate and targets their active connection');
leavingSocket.close();
const deniedWorkspace = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: leaving });
const deniedAgent = await mcp(leavingAgent.data.token, 'list_channels');
const expiredInvite = await request('/api/invites/accept', { cookie: outsider, method: 'POST', body: { token: removalToken } });
const afterRemoval = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(deniedWorkspace.response.status === 404 && deniedAgent.response.status === 401 && expiredInvite.response.status === 400 && !afterRemoval.data.members.some((member) => [leavingId, leavingAgent.data.agent_id].includes(member.account_id)), 'Removing a teammate revokes owned agents and old invites and keeps them out of the workspace');
const formerMessage = await request(`/api/workspaces/${workspaceId}/channels/${generalId}/messages`, { cookie: owner });
check(afterRemoval.data.former_members.some((member) => member.account_id === leavingId && member.name === 'Leaving teammate') && formerMessage.data.some((message) => message.id === leavingMessage.data.id && message.author_id === leavingId), 'Historical messages retain a former teammate’s name');
const returnInvite = await request(`/api/workspaces/${workspaceId}/invites`, { cookie: owner, method: 'POST', body: {} });
const rejoined = await request('/api/invites/accept', { cookie: leaving, method: 'POST', body: { token: returnInvite.data.url.split('/').at(-1) } });
const afterRejoin = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(rejoined.response.ok && afterRejoin.data.members.some((member) => member.account_id === leavingId) && !afterRejoin.data.former_members.some((member) => member.account_id === leavingId), 'A fresh invite restores a person without duplicate former-member entries');

const ownAgent = await request(`/api/workspaces/${workspaceId}/agents`, { cookie: leaving, method: 'POST', body: { name: 'Temporary agent' } });
await request(`/api/workspaces/${workspaceId}/channels/${generalId}/members`, { cookie: owner, method: 'POST', body: { agent_id: ownAgent.data.agent_id } });
const deniedAgentRemoval = await request(`/api/workspaces/${workspaceId}/agents/${agentId}`, { cookie: leaving, method: 'DELETE' });
const removedOwnAgent = await request(`/api/workspaces/${workspaceId}/agents/${ownAgent.data.agent_id}`, { cookie: leaving, method: 'DELETE' });
const removedAgentToken = await mcp(ownAgent.data.token, 'list_channels');
const afterAgentRemoval = await request(`/api/workspaces/${workspaceId}/snapshot`, { cookie: owner });
check(deniedAgentRemoval.response.status === 403 && removedOwnAgent.response.ok && removedAgentToken.response.status === 401 && !afterAgentRemoval.data.members.some((member) => member.account_id === ownAgent.data.agent_id) && afterAgentRemoval.data.former_members.some((member) => member.account_id === ownAgent.data.agent_id), 'An agent owner can retire its identity and credentials while past authorship remains');

const limitedAgent = await request(`/api/workspaces/${workspaceId}/agents`, { cookie: owner, method: 'POST', body: { name: 'Limited agent' } });
await request(`/api/workspaces/${workspaceId}/channels/${generalId}/members`, { cookie: owner, method: 'POST', body: { agent_id: limitedAgent.data.agent_id } });
const lowRate = await request(`/api/workspaces/${workspaceId}/settings`, { cookie: owner, method: 'PUT', body: { rate_per_minute: 2, turn_cap: 3 } });
const limitedFirst = await mcp(limitedAgent.data.token, 'post_message', { channel_id: generalId, body: 'First limited message' });
await request(`/api/workspaces/${workspaceId}/channels/${generalId}/messages`, { cookie: owner, method: 'POST', body: { body: 'Continue.' } });
const limitedSecond = await mcp(limitedAgent.data.token, 'post_message', { channel_id: generalId, body: 'Second limited message' });
await request(`/api/workspaces/${workspaceId}/channels/${generalId}/messages`, { cookie: owner, method: 'POST', body: { body: 'Continue again.' } });
const rateBlocked = await mcp(limitedAgent.data.token, 'post_message', { channel_id: generalId, body: 'Rate blocked' });
check(lowRate.response.ok && !limitedFirst.data.result?.isError && !limitedSecond.data.result?.isError && rateBlocked.data.result?.isError && rateBlocked.data.result.content[0].text.includes('rate limit'), 'Custom per-agent rate limit is enforced');
const lowTurnCap = await request(`/api/workspaces/${workspaceId}/settings`, { cookie: owner, method: 'PUT', body: { rate_per_minute: 20, turn_cap: 2 } });
const turnFirst = await mcp(limitedAgent.data.token, 'post_message', { channel_id: generalId, body: 'First agent turn' });
const turnSecond = await mcp(limitedAgent.data.token, 'post_message', { channel_id: generalId, body: 'Second agent turn' });
const turnBlocked = await mcp(limitedAgent.data.token, 'post_message', { channel_id: generalId, body: 'Turn blocked' });
check(lowTurnCap.data.turn_cap === 2 && !turnFirst.data.result?.isError && !turnSecond.data.result?.isError && turnBlocked.data.result?.isError && turnBlocked.data.result.content[0].text.includes('held'), 'Custom agent turn cap is enforced');

const webhookPath = `/api/workspaces/${workspaceId}/agents/${agentId}/webhook`;
const webhookSecret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;
const webhookAt = (url, secret = webhookSecret) => request(webhookPath, { cookie: owner, method: 'PUT', body: { url, secret } });
const deniedWebhook = await request(webhookPath, { cookie: bob });
const rejectedWebhooks = await Promise.all([webhookAt('http://localhost:8787/hook'), webhookAt('https://localhost./hook'), webhookAt('https://name:pass@example.com/hook'), webhookAt('https://receiver.example.com/hook', 'plain-secret')]);
check(deniedWebhook.response.status === 403 && rejectedWebhooks.every(({ response }) => response.status === 400), 'Only an owner or admin can point an inbox webhook at a public HTTPS endpoint with a whsec_ secret');
const unverifiedWebhook = await webhookAt('https://receiver.example.com/hook');
const savedWebhook = await request(webhookPath, { cookie: owner });
check(!unverifiedWebhook.response.ok && savedWebhook.response.ok && !savedWebhook.data.active && !JSON.stringify(savedWebhook.data).includes(webhookSecret.slice(6)), 'An inbox webhook turns on only after its endpoint echoes a signed challenge through the gateway');
const removedWebhook = await request(webhookPath, { cookie: owner, method: 'DELETE' });
check(removedWebhook.response.ok && !removedWebhook.data.active && removedWebhook.data.url === '', 'An owner can remove an inbox webhook');

const signoutSocket = new WebSocket(socketUrl, { headers: { cookie: owner, origin } });
await new Promise((resolve, reject) => { signoutSocket.once('open', resolve); signoutSocket.once('error', reject); });
const signedOut = await request('/api/logout', { cookie: owner, method: 'POST', body: {} });
const anonymous = await request('/api/me', { cookie: owner });
check(signedOut.response.ok && signedOut.data.connections_targeted === 1 && anonymous.data.account === null, 'Sign-out targets the open connection and revokes the session');
signoutSocket.close();

console.log('All core smoke checks passed.');
