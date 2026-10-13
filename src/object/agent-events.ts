import { agentEventSettings, matchesAgentLevel, type AgentEventSettings } from '../shared/agent-events';
import type { EventOccurrence } from '../shared/mcp-events';
import type { Member } from '../shared/types';
import { forbidden } from '../shared/http';
import { managesAgent } from '../shared/members';
import type { NotificationAccess } from './notifications';
import { Db } from './sql';

type Preference = AgentEventSettings & { account_id: string; channel_id: string };

// The agent inbox: the durable record of what a named agent should react to. Its owner's
// listening levels decide what it records. An event stays until the agent acknowledges it,
// whether the agent heard through a held wait_for_events, the socket signal or its inbox webhook.
// `recorded` announces a new event; `signal` only wakes waits, as when a level change drops some.
export class AgentEvents {
  private db: Db;
  constructor(private ctx: DurableObjectState, private access: NotificationAccess & { recorded(accountId: string): void }) { this.db = new Db(ctx.storage.sql); }
  migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS agent_event_settings (
      account_id TEXT NOT NULL, channel_id TEXT NOT NULL, level TEXT NOT NULL, include_agent_authors INTEGER NOT NULL,
      last_received_at INTEGER, last_completed_at INTEGER, last_error TEXT, PRIMARY KEY (account_id, channel_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS agent_event_inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      message_id TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run('CREATE INDEX IF NOT EXISTS agent_event_inbox_account ON agent_event_inbox(account_id, seq)');
  }
  private agent(id: string): Member {
    const agent = this.access.member(id);
    if (!agent || agent.kind !== 'agent') throw new Error('A named agent is required.');
    return agent;
  }
  private manage(viewer: Member, id: string): void {
    const agent = this.agent(id);
    if (!managesAgent(viewer, agent)) throw forbidden('Only the agent owner or a workspace admin can change listening levels.');
  }
  settings(viewer: Member, id: string): unknown[] {
    if (viewer.account_id !== id) this.manage(viewer, id); else this.agent(id);
    return this.db.all<{ channel_id: string; channel_name: string; level: string | null; include_agent_authors: number | null; pending: number; last_received_at: number | null; last_completed_at: number | null; last_error: string | null }>(
      `SELECT c.id AS channel_id, c.name AS channel_name, s.level, s.include_agent_authors, s.last_received_at, s.last_completed_at, s.last_error,
        (SELECT COUNT(*) FROM agent_event_inbox i WHERE i.account_id = cm.account_id AND i.channel_id = c.id) AS pending
      FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
      LEFT JOIN agent_event_settings s ON s.account_id = cm.account_id AND s.channel_id = c.id
      WHERE cm.account_id = ? AND c.archived_at IS NULL ORDER BY c.name`, id)
      .map((row) => ({ ...row, level: row.level ?? 'off', include_agent_authors: Boolean(row.include_agent_authors) }));
  }
  set(viewer: Member, id: string, channelId: string, input: unknown): void {
    this.manage(viewer, id);
    // Levels belong to joined channels; * is only a watch filter.
    if (channelId === '*' || !this.access.channel(channelId, id)) throw new Error('Add the agent to this channel first.');
    const settings = agentEventSettings.parse(input);
    this.ctx.storage.transactionSync(() => {
      this.db.run(`INSERT INTO agent_event_settings (account_id, channel_id, level, include_agent_authors) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, channel_id) DO UPDATE SET level = excluded.level, include_agent_authors = excluded.include_agent_authors, last_error = NULL`, id, channelId, settings.level, Number(settings.include_agent_authors));
      // Switching levels discards old queued wakes; the new level covers future activity.
      this.db.run('DELETE FROM agent_event_inbox WHERE account_id = ? AND channel_id = ?', id, channelId);
    });
    this.access.signal(id);
  }
  emit(event: EventOccurrence): void {
    for (const row of this.db.all<Preference>('SELECT * FROM agent_event_settings WHERE channel_id = ? AND level != ?', event.channelId, 'off')) {
      if (!this.access.recipient(row.account_id, event.channelId) || !matchesAgentLevel(row, row.account_id, event)) continue;
      const count = this.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM agent_event_inbox WHERE account_id = ?', row.account_id)?.n ?? 0;
      if (count >= 1000) {
        this.db.run("UPDATE agent_event_settings SET level = 'off', last_error = 'Inbox exceeded 1,000 events. Listening stopped; inspect channel history.' WHERE account_id = ?", row.account_id);
        this.clear(row.account_id); continue;
      }
      const eventId = `local_${crypto.randomUUID()}`;
      const body = JSON.stringify({ eventId, name: event.name, timestamp: new Date(event.occurredAt).toISOString(),
        data: { ...event.data, mentions_agent: Boolean(event.mentions?.includes(row.account_id)) } });
      this.db.run('INSERT INTO agent_event_inbox (event_id, account_id, channel_id, message_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', eventId, row.account_id, event.channelId, event.data.message_id ?? null, body, Date.now());
      this.access.recorded(row.account_id);
    }
  }
  pending(id: string, limit = 50): unknown[] {
    const agent = this.agent(id);
    if (agent.paused) return [];
    const rows = this.db.all<{ event_id: string; channel_id: string; message_id: string | null; body: string }>('SELECT * FROM agent_event_inbox WHERE account_id = ? ORDER BY seq LIMIT ?', id, Math.min(50, Math.max(1, limit)));
    const events: unknown[] = [];
    for (const row of rows) {
      const visible = !row.message_id || this.db.one('SELECT 1 FROM messages WHERE id = ? AND deleted_at IS NULL', row.message_id);
      if (!this.access.channel(row.channel_id, id) || !visible) { this.db.run('DELETE FROM agent_event_inbox WHERE event_id = ?', row.event_id); continue; }
      events.push(JSON.parse(row.body));
      this.db.run('UPDATE agent_event_settings SET last_received_at = ? WHERE account_id = ? AND channel_id = ?', Date.now(), id, row.channel_id);
    }
    return events;
  }
  // The newest queued event for an agent, 0 when its inbox is empty.
  latest(id: string): number {
    return this.db.one<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM agent_event_inbox WHERE account_id = ?', id)?.seq ?? 0;
  }
  // A deleted message leaves the record at once, so counts and webhook rings stay accurate.
  forgetMessage(messageId: string): void { this.db.run('DELETE FROM agent_event_inbox WHERE message_id = ?', messageId); }
  supersedeMessage(messageId: string): string[] {
    const mentioned = this.db.all<{ account_id: string; body: string }>('SELECT account_id, body FROM agent_event_inbox WHERE message_id = ?', messageId)
      .filter((row) => JSON.parse(row.body).data.mentions_agent).map((row) => row.account_id);
    this.db.run('DELETE FROM agent_event_inbox WHERE message_id = ?', messageId);
    return mentioned;
  }
  acknowledge(id: string, eventId: string, outcome: 'completed' | 'failed', error?: string): void {
    this.agent(id);
    this.ctx.storage.transactionSync(() => {
      const row = this.db.one<{ channel_id: string }>('DELETE FROM agent_event_inbox WHERE account_id = ? AND event_id = ? RETURNING channel_id', id, eventId);
      if (!row) return;
      this.db.run('UPDATE agent_event_settings SET last_completed_at = ?, last_error = ? WHERE account_id = ? AND channel_id = ?',
        Date.now(), outcome === 'failed' ? (error ?? 'The local agent could not handle this event.').slice(0, 300) : null, id, row.channel_id);
    });
  }
  clear(id: string): void { this.db.run('DELETE FROM agent_event_inbox WHERE account_id = ?', id); }
  revokeChannel(channelId: string, id: string | null = null): void {
    this.db.run('DELETE FROM agent_event_settings WHERE channel_id = ? AND (? IS NULL OR account_id = ?)', channelId, id, id);
    this.db.run('DELETE FROM agent_event_inbox WHERE channel_id = ? AND (? IS NULL OR account_id = ?)', channelId, id, id);
  }
  revokeAccount(id: string): void { this.clear(id); this.db.run('DELETE FROM agent_event_settings WHERE account_id = ?', id); }
}
