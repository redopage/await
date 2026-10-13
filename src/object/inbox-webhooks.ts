import type { Env } from '../worker/env';
import type { Member } from '../shared/types';
import { managesAgent } from '../shared/members';
import { HttpError, forbidden } from '../shared/http';
import { callbackUrl, decryptSecret, deliveryProblem, deliveryVerdict, encryptSecret, EventError, eventsEnabled, retryDelay, sendWebhook, validateSigningSecret, verifyCallback } from '../worker/event-webhooks';
import type { NotificationAccess } from './notifications';
import { Db } from './sql';

type Webhook = {
  agent_id: string; url: string; secret: string; active: number; revision: string; verified_at: number | null;
  ring_id: string | null; ring_at: number | null; ring_attempts: number; ring_seq: number | null; last_delivered_at: number | null; last_error: string | null;
};
type Access = NotificationAccess & { latest(agentId: string): number };

const migrated = 'Await now signs inbox webhooks with Standard Webhooks and sends them through its delivery gateway. Add a whsec_ signing secret and verify the endpoint to turn it back on.';
// Deliveries carry this as x-mcp-subscription-id, and it binds the stored key.
const webhookId = (agentId: string) => `inbox_${agentId}`;

// The inbox webhook: an HTTPS endpoint an owner points an agent's inbox at. When the inbox
// records events, Await rings the endpoint with a signed {type: "agent_events"} notice through
// the gateway. The notice carries no team content. The receiver reads and acknowledges the
// events with wait_for_events and ack_events, so the inbox stays the only record. Each agent has
// at most one pending ring; events recorded while a ring is in flight get another one.
export class InboxWebhooks {
  private db: Db;
  constructor(private ctx: DurableObjectState, private env: Env, private access: Access) { this.db = new Db(ctx.storage.sql); }

  // Schema 17. Legacy agent webhooks were fetched straight from this object with their own
  // signature and a plaintext secret, which cannot carry over. Each endpoint becomes a stopped
  // inbox webhook (never verified) that needs a whsec_ secret and a verified challenge. Queued
  // legacy retries are dropped; the mentions stay in history. The legacy tables stay, emptied,
  // until a later schema drops them, so the previous release still runs after a rollback.
  migrate(): void {
    this.ctx.storage.transactionSync(() => {
      this.db.run(`CREATE TABLE IF NOT EXISTS inbox_webhooks (
        agent_id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, active INTEGER NOT NULL, revision TEXT NOT NULL,
        verified_at INTEGER, ring_id TEXT, ring_at INTEGER, ring_attempts INTEGER NOT NULL DEFAULT 0, ring_seq INTEGER,
        last_delivered_at INTEGER, last_error TEXT)`);
      this.db.run('CREATE INDEX IF NOT EXISTS inbox_webhooks_due ON inbox_webhooks(ring_at) WHERE ring_id IS NOT NULL');
      const legacy = (table: string) => this.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table);
      if (legacy('agent_webhooks')) {
        this.db.run(`INSERT OR IGNORE INTO inbox_webhooks (agent_id, url, secret, active, revision, last_error)
          SELECT w.agent_id, w.url, '', 0, ?, ? FROM agent_webhooks w JOIN members m ON m.account_id = w.agent_id AND m.kind = 'agent'`, crypto.randomUUID(), migrated);
        this.db.run('DELETE FROM agent_webhooks');
      }
      if (legacy('webhook_deliveries')) this.db.run('DELETE FROM webhook_deliveries');
      this.db.setMeta('schema_version', '17');
    });
  }

  private row(agentId: string): Webhook | null { return this.db.one<Webhook>('SELECT * FROM inbox_webhooks WHERE agent_id = ?', agentId); }

  // Only a person who owns the agent, or a workspace owner or admin, can see or change its webhook.
  private manage(viewer: Member, agentId: string): void {
    const agent = this.access.member(agentId);
    if (!agent || agent.kind !== 'agent') throw new HttpError(404, 'Agent not found.');
    if (!managesAgent(viewer, agent)) throw forbidden('You cannot manage this agent.');
  }

  // The signing key is never returned; managers see the URL they configured.
  private view(agentId: string) {
    const row = this.row(agentId);
    return { available: eventsEnabled(this.env), url: row?.url ?? '', active: Boolean(row?.active),
      last_delivered_at: row?.last_delivered_at ?? null, last_error: row?.last_error ?? null, ringing: Boolean(row?.ring_id) };
  }

  status(viewer: Member, agentId: string) { this.manage(viewer, agentId); return this.view(agentId); }

  async save(viewer: Member, agentId: string, input: { url?: unknown; secret?: unknown }) {
    this.manage(viewer, agentId);
    const url = callbackUrl(input.url);
    validateSigningSecret(input.secret);
    if (!eventsEnabled(this.env)) throw new HttpError(409, 'Webhook delivery is not configured on this server.');
    const before = this.row(agentId);
    await verifyCallback(this.env, url, webhookId(agentId), input.secret);
    const encrypted = await encryptSecret(this.env, webhookId(agentId), input.secret);
    // Other requests run while the endpoint answers. Never overwrite a change made meanwhile.
    const actor = this.access.member(viewer.account_id);
    if (!actor) throw forbidden('You cannot manage this agent.');
    this.manage(actor, agentId);
    if ((this.row(agentId)?.revision ?? null) !== (before?.revision ?? null)) throw new HttpError(409, 'The webhook changed while it was being verified. Try again.');
    const now = Date.now();
    this.db.run(`INSERT INTO inbox_webhooks (agent_id, url, secret, active, revision, verified_at) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET url = excluded.url, secret = excluded.secret, active = 1, revision = excluded.revision,
      verified_at = excluded.verified_at, ring_id = NULL, ring_at = NULL, ring_attempts = 0, last_error = NULL`, agentId, url, encrypted, crypto.randomUUID(), now);
    // A legacy webhook woke its agent on every mention by anyone else. Its first verified save
    // keeps that: channels with no listening level yet listen for mentions, agents' included.
    if (before && before.verified_at === null) {
      this.db.run(`INSERT OR IGNORE INTO agent_event_settings (account_id, channel_id, level, include_agent_authors)
        SELECT cm.account_id, cm.channel_id, 'mentions', 1 FROM channel_members cm JOIN channels c ON c.id = cm.channel_id AND c.archived_at IS NULL
        WHERE cm.account_id = ?`, agentId);
    }
    this.ring(agentId); // Events that are already waiting get a ring.
    return this.view(agentId);
  }

  remove(viewer: Member, agentId: string) {
    this.manage(viewer, agentId);
    this.db.run('DELETE FROM inbox_webhooks WHERE agent_id = ?', agentId);
    return this.view(agentId);
  }

  // Called whenever the agent's inbox records an event; joins the pending ring if there is one.
  ring(agentId: string): void {
    if (this.access.member(agentId)?.paused || !this.access.latest(agentId)) return;
    const queued = this.db.one('UPDATE inbox_webhooks SET ring_id = ?, ring_at = ?, ring_attempts = 0, ring_seq = NULL WHERE agent_id = ? AND active = 1 AND ring_id IS NULL RETURNING agent_id',
      `ring_${crypto.randomUUID()}`, Date.now() + 1000, agentId);
    if (queued) this.access.schedule();
  }

  clearRing(agentId: string): void { this.db.run('UPDATE inbox_webhooks SET ring_id = NULL, ring_at = NULL, ring_attempts = 0 WHERE agent_id = ?', agentId); }
  revokeAccount(agentId: string): void { this.db.run('DELETE FROM inbox_webhooks WHERE agent_id = ?', agentId); }

  // A stopped webhook keeps its URL and the reason, scrubs its key, and needs a verified save to ring again.
  private stop(agentId: string, reason: string): void {
    this.db.run("UPDATE inbox_webhooks SET active = 0, secret = '', revision = ?, ring_id = NULL, ring_at = NULL, ring_attempts = 0, last_error = ? WHERE agent_id = ?",
      crypto.randomUUID(), reason, agentId);
  }

  nextAlarm(): number | null {
    return this.db.one<{ due: number | null }>('SELECT MIN(ring_at) AS due FROM inbox_webhooks WHERE ring_id IS NOT NULL')?.due ?? null;
  }

  async flush(): Promise<void> {
    const due = this.db.all<Webhook>('SELECT * FROM inbox_webhooks WHERE ring_id IS NOT NULL AND ring_at <= ? ORDER BY ring_at LIMIT 10', Date.now());
    await Promise.all(due.map(async (row) => {
      const agent = this.access.member(row.agent_id);
      const latest = this.access.latest(row.agent_id);
      // Nothing to announce: the agent was paused or removed, or its inbox is already empty.
      if (!row.active || agent?.kind !== 'agent' || agent.paused || !latest) { this.clearRing(row.agent_id); return; }
      // A ring announces the events its first attempt saw. Its retries keep its webhook-id, which
      // receivers may deduplicate, so later events get a ring of their own once it is accepted.
      const covered = row.ring_seq ?? latest;
      const current = () => {
        const now = this.row(row.agent_id);
        return Boolean(now && now.ring_id === row.ring_id && now.revision === row.revision && !this.access.member(row.agent_id)?.paused);
      };
      let status = 0, reason = 'Webhook unavailable.';
      try {
        const secret = await decryptSecret(this.env, webhookId(row.agent_id), row.secret);
        // During an encryption key rotation, each ring moves its key to the current encryption key.
        if (this.env.MCP_EVENT_PREVIOUS_KEY) {
          const fresh = await encryptSecret(this.env, webhookId(row.agent_id), secret);
          this.db.run('UPDATE inbox_webhooks SET secret = ? WHERE agent_id = ? AND revision = ?', fresh, row.agent_id, row.revision);
        }
        const body = JSON.stringify({ type: 'agent_events', workspace_id: this.db.meta('workspace_id') ?? '', agent_id: row.agent_id });
        const reply = await sendWebhook(this.env, row.url, webhookId(row.agent_id), row.ring_id!, body, [secret], current);
        status = reply.status; reason = `Webhook returned HTTP ${status}.`;
      } catch (error) { reason = error instanceof EventError ? error.reason ?? error.message : 'Webhook delivery failed.'; }
      // A save, removal, pause or newer ring during the attempt owns the row now.
      if (!current()) return;
      const verdict = deliveryVerdict(status, reason, row.ring_attempts);
      if (verdict === 'accepted') {
        this.db.run('UPDATE inbox_webhooks SET ring_id = NULL, ring_at = NULL, ring_attempts = 0, last_delivered_at = ?, last_error = NULL WHERE agent_id = ?', Date.now(), row.agent_id);
        if (this.access.latest(row.agent_id) > covered) this.ring(row.agent_id);
      } else if (verdict === 'retry') {
        this.db.run('UPDATE inbox_webhooks SET ring_attempts = ring_attempts + 1, ring_at = ?, ring_seq = ?, last_error = ? WHERE agent_id = ?',
          Date.now() + retryDelay(row.ring_attempts), covered, deliveryProblem(reason), row.agent_id);
      } else this.stop(row.agent_id, verdict === 'gone' ? 'The endpoint stopped accepting deliveries (HTTP 410). Save the webhook again to turn it back on.'
        : reason === 'key_unavailable' ? `${deliveryProblem(reason)} Save the webhook again with its secret to turn it back on.`
          : `${deliveryProblem(reason)} Delivery stopped; fix the receiver, then save the webhook again.`);
    }));
  }
}
