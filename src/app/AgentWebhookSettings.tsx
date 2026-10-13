import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import EventSubscriptions from './EventSubscriptions';
import AgentListening from './AgentListening';

type InboxWebhook = {
  available: boolean;
  url: string;
  active: boolean;
  last_delivered_at: number | null;
  last_error: string | null;
  ringing: boolean;
};

// A Standard Webhooks key made in the browser. The receiver keeps it; Await stores it encrypted.
function newSigningSecret(): string {
  return `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
}

export default function AgentWebhookSettings({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const path = `/workspaces/${workspaceId}/agents/${agentId}/webhook`;
  const listeningPath = `/workspaces/${workspaceId}/agents/${agentId}/listening`;
  const webhook = useQuery({ queryKey: ['agent-webhook', workspaceId, agentId], queryFn: () => api<InboxWebhook>(path), refetchInterval: 10000 });
  // Shares the listening section's cached query to warn when nothing can ring.
  const listening = useQuery({ queryKey: ['agent-listening', workspaceId, agentId], queryFn: () => api<{ channels: { level: string }[] }>(listeningPath) });
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (webhook.data) setUrl(webhook.data.url); }, [webhook.data?.url]);
  const status = webhook.data;
  const listeningChannels = listening.data?.channels.filter((channel) => channel.level !== 'off').length ?? 0;

  async function change(init: RequestInit, failure: string) {
    setBusy(true); setError('');
    try { await api<InboxWebhook>(path, init); setSecret(''); setCopied(false); await webhook.refetch(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : failure); }
    finally { setBusy(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void change({ method: 'PUT', body: JSON.stringify({ url: url.trim(), secret: secret.trim() }) }, 'Could not verify the webhook.');
  }

  return <><AgentListening workspaceId={workspaceId} agentId={agentId} /><EventSubscriptions workspaceId={workspaceId} accountId={agentId} /><section className="agent-webhook-setting" aria-label="Inbox webhook">
    <h3>Inbox webhook</h3>
    <p>Ring an HTTPS endpoint when this agent’s inbox has events, so an agent without a live connection can sleep until there is work. The signed notice contains no messages: the receiver reads and acknowledges events with <code>wait_for_events</code> and <code>ack_events</code>.</p>
    {webhook.isError && <p role="alert">Could not load the inbox webhook. <button type="button" className="text-button" onClick={() => void webhook.refetch()}>Try again</button></p>}
    {status && !status.available && <p>Webhook delivery is unavailable on this server.</p>}
    {status?.available && <form onSubmit={save}>
      <label htmlFor={`webhook-url-${agentId}`}>HTTPS endpoint</label>
      <div className="agent-webhook-input"><input id={`webhook-url-${agentId}`} type="url" inputMode="url" placeholder="https://your-agent.example/await" value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} /></div>
      <label htmlFor={`webhook-secret-${agentId}`}>Signing secret</label>
      <div className="agent-webhook-input">
        <input id={`webhook-secret-${agentId}`} type="text" autoComplete="off" spellCheck={false} placeholder="whsec_…" value={secret} onChange={(event) => { setSecret(event.target.value); setCopied(false); }} disabled={busy} />
        <button type="button" className="button secondary" disabled={busy} onClick={() => { setSecret(newSigningSecret()); setCopied(false); }}>Generate</button>
        <button type="button" className="button secondary" disabled={busy || !secret} onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true), () => setError('Could not copy the secret. Select it instead.'))}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p>Give your receiver this secret first. Saving sends it a signed challenge to echo back.</p>
      <button type="submit" className="button secondary" disabled={busy || !url.trim() || !secret.trim()}>{busy ? 'Verifying…' : status.active ? 'Verify and replace' : 'Verify and turn on'}</button>
    </form>}
    {status?.url && <div className="agent-webhook-meta"><span>{status.active ? 'On' : 'Stopped'}</span>{status.ringing && <span>Ring queued</span>}{status.last_delivered_at && <span>Last rang {new Date(status.last_delivered_at).toLocaleString()}</span>}<button type="button" className="text-button" disabled={busy} onClick={() => void change({ method: 'DELETE' }, 'Could not remove the webhook.')}>Remove</button></div>}
    {status?.active && listening.isSuccess && listeningChannels === 0 && <p role="status">No channel is listening yet, so nothing will ring. Choose a listening level above.</p>}
    {status?.last_error && <p className="agent-webhook-error" role="status">{status.last_error}</p>}
    {error && <p className="agent-webhook-error" role="alert">{error}</p>}
    <details><summary>Notice format and signature</summary><p>Await POSTs <code>{'{"type":"agent_events","workspace_id":…,"agent_id":…}'}</code> through its delivery gateway with Standard Webhooks headers. <code>webhook-signature</code> is <code>v1,</code> and the base64 HMAC-SHA256 of <code>webhook-id</code>, <code>webhook-timestamp</code> and the body joined by periods, keyed with the decoded secret. Check that the timestamp is recent and ignore a repeated <code>webhook-id</code>. A verification request carries <code>{'{"type":"verification","challenge":…}'}</code>; reply with that challenge as JSON. Any 2xx confirms a notice. Failures retry with backoff for a few hours; HTTP 410, a rejection or exhausted retries stop the webhook until it is saved again.</p></details>
  </section></>;
}
