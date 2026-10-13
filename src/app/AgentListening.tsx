import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { AgentEventSettings } from '../shared/agent-events';

type Channel = AgentEventSettings & { channel_id: string; channel_name: string; pending: number; last_received_at: number | null; last_completed_at: number | null; last_error: string | null };
export default function AgentListening({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const path = `/workspaces/${workspaceId}/agents/${agentId}/listening`;
  const query = useQuery({ queryKey: ['agent-listening', workspaceId, agentId], queryFn: () => api<{ channels: Channel[] }>(path), refetchInterval: 10000 });
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  async function save(channel: Channel, change: Partial<AgentEventSettings>) {
    setBusy(channel.channel_id); setError('');
    try {
      await api(`${path}/${encodeURIComponent(channel.channel_id)}`, { method: 'PUT', body: JSON.stringify({ level: channel.level, include_agent_authors: channel.include_agent_authors, ...change }) });
      await query.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save listening level.'); }
    finally { setBusy(''); }
  }
  return <section className="agent-webhook-setting" aria-label="Local agent listening">
    <h3>Listening level</h3>
    <p>Choose what reaches your connected agent in each channel. Its host must be running to respond.</p>
    {query.isPaused && <p role="status">You are offline. Reconnect to update listening levels.</p>}
    {query.isPending && !query.isPaused && <p role="status">Loading listening levels…</p>}
    {query.isError && <p role="alert">Could not load listening levels. <button type="button" className="text-button" onClick={() => void query.refetch()}>Try again</button></p>}
    {query.data?.channels.length === 0 && <p>Add this agent to a channel to choose its listening level.</p>}
    <div className="agent-listening-channels">{query.data?.channels.map((channel) => <article key={channel.channel_id} className="agent-listening-channel" aria-label={`Listening in ${channel.channel_name}`}>
      <label className="agent-listening-name" htmlFor={`listening-${agentId}-${channel.channel_id}`}>#{channel.channel_name}</label>
        <select id={`listening-${agentId}-${channel.channel_id}`} aria-label={`Listening level for ${channel.channel_name}`} value={channel.level} disabled={Boolean(busy)} onChange={(event) => void save(channel, { level: event.target.value as Channel['level'] })}>
          <option value="off">Off</option><option value="mentions">Mentions only</option><option value="messages">All messages</option><option value="activity">All activity</option>
        </select>
        <label className="agent-listening-agents"><input type="checkbox" aria-label={`Include other agents in ${channel.channel_name}`} checked={channel.include_agent_authors} disabled={Boolean(busy)} onChange={(event) => void save(channel, { include_agent_authors: event.target.checked })} /> Include other agents</label>
        <div className="agent-listening-status">
        {busy === channel.channel_id && <p role="status">Saving…</p>}
        {channel.pending > 0 && <p>{channel.pending} pending</p>}
        {channel.last_completed_at && <p>Last handled {new Date(channel.last_completed_at).toLocaleString()}</p>}
        {channel.last_error && <p role="status" className="agent-webhook-error">{channel.last_error}</p>}
        </div>
    </article>)}</div>
    <details><summary>How listening works</summary><p>The agent’s own changes never wake it. Changing a listening setting clears queued events for that channel.</p></details>
    {error && <p role="alert">{error}</p>}
  </section>;
}
