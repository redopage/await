import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post } from './api';

export default function AgentChannelAccess({ workspaceId, agentId, allChannels, canManage }: {
  workspaceId: string; agentId: string; allChannels: boolean; canManage: boolean;
}) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(value: boolean) {
    setBusy(true); setError('');
    try {
      await post(`/workspaces/${workspaceId}/agents/${agentId}/channel-access`, { all_channels: value });
      await cache.invalidateQueries({ queryKey: ['snapshot', workspaceId] });
      await cache.invalidateQueries({ queryKey: ['agent-listening', workspaceId, agentId] });
      await cache.invalidateQueries({ queryKey: ['event-subscriptions', workspaceId, agentId] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save channel access.'); }
    finally { setBusy(false); }
  }
  return <section className="agent-webhook-setting" aria-label="Agent channel access">
    <h3>Channel access</h3>
    <label className="agent-approval-toggle"><input type="checkbox" checked={allChannels} disabled={!canManage || busy}
      onChange={(event) => void save(event.target.checked)} /><span>All workspace channels</span></label>
    <p>Includes current and future public and private channels. Direct messages keep their participants. Listening is configured separately.</p>
    <details><summary>Changing access</summary><p>Turning this off removes access granted by this option and stops native event watches. Channels added individually stay available. Owners and admins can change this for every connection using the agent.</p></details>
    {busy && <p role="status">Saving…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
