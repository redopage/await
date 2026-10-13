import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, navigate } from './api';
import { ArrowPathIcon } from '@heroicons/react/16/solid';
import { eventWatchStatus } from './eventStatus';
import type { EventArguments } from '../shared/mcp-events';

type Receipt = { event_id: string; message_id: string | null; occurred_at: number; attempted_at: number; attempts: number; http_status: number | null; outcome: 'accepted' | 'retrying' | 'stopped'; payload_bytes: number };
type Watch = { id: string; name: string; arguments: EventArguments; account_name: string; channel_name: string; destination: string; active: boolean; paused: boolean; pending: number; last_error: string | null; last_delivered_at: number | null; expires_at: number; receipts: Receipt[] };
const labels: Record<string, string> = { 'project.updated': 'Project coordination', 'message.created': 'New messages', 'message.updated': 'Message edits', 'message.mentioned': 'Mentions', 'task.created': 'New tasks', 'task.updated': 'Task changes', 'task.deleted': 'Deleted tasks', 'document.created': 'New documents', 'document.updated': 'Document changes', 'document.deleted': 'Deleted documents' };

export default function EventSubscriptions({ workspaceId, accountId }: { workspaceId: string; accountId?: string }) {
  const path = `/workspaces/${workspaceId}/event-subscriptions`;
  const query = useQuery({ queryKey: ['event-subscriptions', workspaceId, accountId], queryFn: () => api<{ available: boolean; subscriptions: Watch[] }>(`${path}${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''}`), refetchInterval: 10000 });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function stop(id: string) {
    setBusy(id); setError('');
    try { await api(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }); await query.refetch(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not stop monitoring.'); }
    finally { setBusy(''); }
  }
  return <section className="agent-webhook-setting" aria-label="Event monitoring">
    <div className="event-monitoring-heading"><h3>Event monitoring</h3><button type="button" className="icon-button" aria-label="Refresh event watches" title="Refresh event watches" disabled={query.isFetching} onClick={() => void query.refetch()}><ArrowPathIcon className={query.isFetching ? 'is-refreshing' : ''} /></button></div>
    {query.data?.available && <p>Ask a connected agent to watch mentions or activity in selected channels, or in all workspace channels if it is allowed to. Other people’s changes trigger it by default.</p>}
    {query.data && !query.data.available && <p>MCP event monitoring is unavailable right now.</p>}
    {query.isPaused && <p role="status">You are offline. Reconnect to update event watches.</p>}
    {query.isPending && !query.isPaused && <p role="status">Loading watches…</p>}
    {query.isError && <p role="alert">Could not load watches. <button type="button" className="text-button" onClick={() => void query.refetch()}>Try again</button></p>}
    {query.data?.available && query.data.subscriptions.length === 0 && <div className="event-empty"><strong>No MCP watches yet</strong><p>Ask your connected agent to watch a channel or your mentions. Its watches and delivery updates will appear here.</p></div>}
    {Boolean(query.data?.subscriptions.length) && <p className="event-watch-summary">{query.data!.subscriptions.filter(watch => watch.active && !watch.paused).length} active · {query.data!.subscriptions.filter(watch => watch.active && watch.paused).length} paused · {query.data!.subscriptions.filter(watch => !watch.active).length} stopped</p>}
    {query.data?.subscriptions.map((watch) => { const status = eventWatchStatus(watch); return <article key={watch.id} className="agent-watch-card" aria-label={`${watch.name} in ${watch.channel_name}`}>
      <div className="event-watch-copy"><div className="event-watch-title"><strong>{watch.account_name}: {labels[watch.name] ?? watch.name}</strong><span className={`event-watch-status tone-${status.tone}`}>{status.label}</span></div><p>{watch.arguments.channel_id === '*' ? watch.channel_name : `#${watch.channel_name}`} · {watch.destination}{watch.pending ? ` · ${watch.pending} queued` : ''}</p>
        {(watch.arguments.thread_id || watch.arguments.task_id || watch.arguments.board_id || watch.arguments.document_id) && <p>Limited to one {watch.arguments.thread_id ? 'thread' : watch.arguments.task_id ? 'task' : watch.arguments.board_id ? 'board' : 'document'}.</p>}
        {watch.arguments.include_agent_authors && <p>Includes changes from other agents.</p>}
        {watch.last_delivered_at && <p>Last delivery confirmed {new Date(watch.last_delivered_at).toLocaleString()}</p>}
        {watch.active && <p>Expires <time dateTime={new Date(watch.expires_at).toISOString()}>{new Date(watch.expires_at).toLocaleString()}</time>. Your agent can renew it.</p>}
        {watch.arguments.channel_id !== '*' && <button type="button" className="text-button event-conversation-link" onClick={() => navigate(`/w/${workspaceId}/${watch.arguments.channel_id}${watch.arguments.thread_id ? `?thread=${watch.arguments.thread_id}` : ''}`)}>{watch.arguments.thread_id ? 'Open thread' : 'Open channel'}</button>}
        {watch.receipts?.length > 0 && <details className="agent-delivery-details"><summary>Delivery details</summary><p>Delivery confirms the event reached your agent. Check the conversation for its response.</p><p>Watch <code>{watch.id}</code></p><ol>{watch.receipts.map((receipt) => <li key={receipt.event_id}><p>{new Date(receipt.attempted_at).toLocaleString()} · {receipt.http_status ? `HTTP ${receipt.http_status}` : 'No HTTP response'} · {receipt.outcome === 'accepted' ? 'Delivered' : receipt.outcome === 'retrying' ? 'Retrying' : 'Stopped'} · Attempt {receipt.attempts}</p><code>{receipt.event_id}</code>{receipt.message_id && <p>Message <code>{receipt.message_id}</code></p>}</li>)}</ol></details>}
        {watch.last_error && <p className="agent-webhook-error" role="status">{watch.last_error}</p>}
      </div>
      {watch.active && <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void stop(watch.id)}>{busy === watch.id ? 'Stopping…' : 'Stop monitoring'}</button>}
    </article>; })}
    {error && <p role="alert">{error}</p>}
  </section>;
}
