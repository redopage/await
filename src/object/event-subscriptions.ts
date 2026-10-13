import type { Env } from '../worker/env';
import type { Member } from '../shared/types';
import { managesAgent } from '../shared/members';
import { sha256 } from '../worker/auth';
import { callbackUrl, decryptSecret, deliveryProblem, deliveryVerdict, encryptSecret, EventError, eventsEnabled, retryDelay, sendWebhook, validateSigningSecret, verifyCallback } from '../worker/event-webhooks';
import { canonicalJson } from '../shared/json';
import { matchesEvent, parseEventArguments, type EventArguments, type EventOccurrence } from '../shared/mcp-events';
import type { NotificationAccess } from './notifications';
import { Db } from './sql';

// One subscription per identity, callback and filter, so subscribing again updates the same watch.
async function subscriptionId(authority: EventAuthority, url: string, parsed: { name: string; arguments: unknown }): Promise<string> {
  return `sub_${await sha256(canonicalJson([authority.workspaceId, authority.accountId, url, parsed.name, parsed.arguments]))}`;
}

export type EventAuthority = {
  accountId: string; workspaceId: string; authVersion: number;
  credential: { kind: 'bearer'; tokenHash: string } | { kind: 'oauth'; userId: string; grantId: string };
};
type Subscription = {
  id: string; account_id: string; name: string; arguments: string; channel_id: string; callback_url: string;
  secret: string; previous_secret: string | null; rotation_until: number | null; secret_hash: string;
  authority: string; expires_at: number; active: number; generation: string; verified_at: number;
  created_at: number; updated_at: number; last_delivered_at: number | null; last_error: string | null;
};
const DAY = 86400000;

// MCP Events watches: a host subscribes a named agent with its own filters and callback.
// Each watch has its own ordered outbox; the recipient rules and transport are shared.
export class EventSubscriptions {
  private db: Db;
  constructor(private ctx: DurableObjectState, private env: Env, private access: NotificationAccess) { this.db = new Db(ctx.storage.sql); }

  migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS event_subscriptions (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, channel_id TEXT NOT NULL,
      callback_url TEXT NOT NULL, secret TEXT NOT NULL, previous_secret TEXT, rotation_until INTEGER, secret_hash TEXT NOT NULL,
      authority TEXT NOT NULL, expires_at INTEGER NOT NULL, active INTEGER NOT NULL, generation TEXT NOT NULL, verified_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_delivered_at INTEGER, last_error TEXT)`);
    this.db.run('CREATE INDEX IF NOT EXISTS event_subscriptions_channel ON event_subscriptions(channel_id, name, active)');
    this.db.run(`CREATE TABLE IF NOT EXISTS event_deliveries (
      subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, channel_id TEXT NOT NULL,
      message_id TEXT, next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (subscription_id, event_id))`);
    this.db.run('CREATE INDEX IF NOT EXISTS event_deliveries_due ON event_deliveries(next_attempt_at)');
  }

  migrateReceipts(): void {
    this.ctx.storage.transactionSync(() => {
      this.db.run(`CREATE TABLE IF NOT EXISTS event_receipts (
        subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, message_id TEXT,
        occurred_at INTEGER NOT NULL, attempted_at INTEGER NOT NULL, attempts INTEGER NOT NULL,
        http_status INTEGER, outcome TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
        PRIMARY KEY (subscription_id, event_id))`);
      this.db.run('CREATE INDEX IF NOT EXISTS event_receipts_expiry ON event_receipts(attempted_at)');
      this.db.setMeta('schema_version', '8');
    });
  }

  private receipt(item: { subscription_id: string; event_id: string; body: string; message_id: string | null; attempts: number }, status: number, outcome: string): void {
    // Retain correlation metadata only. Never persist callback responses,
    // signing headers, callback paths, credentials, or message contents.
    const occurredAt = Date.parse(JSON.parse(item.body).timestamp);
    this.db.run(`INSERT INTO event_receipts (subscription_id, event_id, message_id, occurred_at, attempted_at, attempts, http_status, outcome, payload_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subscription_id, event_id) DO UPDATE SET
      attempted_at=excluded.attempted_at, attempts=excluded.attempts, http_status=excluded.http_status, outcome=excluded.outcome`,
      item.subscription_id, item.event_id, item.message_id, occurredAt, Date.now(), item.attempts + 1, status || null, outcome, new TextEncoder().encode(item.body).length);
    this.db.run(`DELETE FROM event_receipts WHERE subscription_id=? AND event_id NOT IN
      (SELECT event_id FROM event_receipts WHERE subscription_id=? ORDER BY attempted_at DESC, rowid DESC LIMIT 10)`, item.subscription_id, item.subscription_id);
  }

  private subscription(id: string): Subscription | null { return this.db.one<Subscription>('SELECT * FROM event_subscriptions WHERE id = ?', id); }
  private eligible(row: Subscription): boolean {
    return Boolean(row.active && row.expires_at > Date.now() && this.access.recipient(row.account_id, row.channel_id));
  }

  private async authorized(authority: EventAuthority): Promise<boolean> {
    const account = await this.env.DB.prepare(`SELECT a.auth_version FROM accounts a JOIN workspace_members w ON w.account_id = a.id
      WHERE a.id = ? AND w.workspace_id = ?`).bind(authority.accountId, authority.workspaceId).first<{ auth_version: number }>();
    if (!account || account.auth_version !== authority.authVersion) return false;
    const credential = authority.credential;
    if (credential.kind === 'bearer') {
      const token = await this.env.DB.prepare('SELECT scopes FROM agent_tokens WHERE token_hash = ? AND account_id = ? AND workspace_id = ? AND revoked_at IS NULL')
        .bind(credential.tokenHash, authority.accountId, authority.workspaceId).first<{ scopes: string }>();
      return Boolean(token?.scopes.split(' ').includes('read'));
    }
    // Isolated adapter for workers-oauth-provider's grant storage. Grant identity
    // survives access-token refresh; storing access tokens would expire watches.
    const grant = await this.env.OAUTH_KV.get<{ id: string; userId: string; scope: string[]; expiresAt?: number }>(`grant:${credential.userId}:${credential.grantId}`, 'json');
    return Boolean(grant && grant.id === credential.grantId && grant.userId === credential.userId && grant.scope.includes('read')
      && (grant.expiresAt === undefined || grant.expiresAt * 1000 > Date.now()));
  }

  private deactivate(id: string, reason: string): void {
    this.db.run('UPDATE event_subscriptions SET active = 0, secret = ?, previous_secret = NULL, secret_hash = ?, last_error = ?, updated_at = ?, generation = ? WHERE id = ?',
      '', '', reason, Date.now(), crypto.randomUUID(), id);
    this.db.run('DELETE FROM event_deliveries WHERE subscription_id = ?', id);
  }

  async subscribe(authority: EventAuthority, params: Record<string, unknown>): Promise<unknown> {
    if (!eventsEnabled(this.env)) throw new EventError(-32014, 'MCP Events delivery is not configured.');
    const parsed = this.filters(params);
    const delivery = params.delivery as { mode?: unknown; url?: unknown; secret?: unknown } | undefined;
    if (delivery?.mode !== 'webhook') throw new EventError(-32014, 'Await supports webhook event delivery only.');
    const url = callbackUrl(delivery.url);
    validateSigningSecret(delivery.secret);
    if (params.cursor !== undefined && params.cursor !== null) throw new EventError(-32014, 'Await does not support historical event replay.', 'cursor');
    if (params.ttlMs !== undefined && params.ttlMs !== null && (typeof params.ttlMs !== 'number' || !Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)) throw new EventError(-32602, 'ttlMs must be a positive integer or null.');
    const ttl = Math.max(60000, Math.min(DAY, typeof params.ttlMs === 'number' ? params.ttlMs : DAY));
    this.requireAccess(authority.accountId, parsed.arguments);
    this.requireAgent(authority.accountId);
    if (!await this.authorized(authority)) throw new EventError(-32012, 'This connection no longer has read access.');
    const args = canonicalJson(parsed.arguments);
    const id = await subscriptionId(authority, url, parsed);
    const existing = this.subscription(id);
    const secretHash = await sha256(delivery.secret);
    // Verification is reusable only for this principal, destination AND secret.
    // A fresh secret must prove callback ownership again before it replaces a key.
    const needsVerification = !existing?.active || existing.verified_at < Date.now() - 300000 || existing.secret_hash !== secretHash;
    if (needsVerification) await verifyCallback(this.env, url, id, delivery.secret);
    const encrypted = await encryptSecret(this.env, id, delivery.secret);
    // The DO can process another request while verification/network work awaits.
    // Do not resurrect a watch unsubscribed or cancelled during verification.
    const current = this.subscription(id);
    if ((existing?.generation ?? null) !== (current?.generation ?? null)) throw new EventError(-32015, 'The subscription changed during callback verification. Retry subscribing.', 'subscription_changed');
    if (!await this.authorized(authority)) throw new EventError(-32012, 'This connection no longer has read access.');
    this.requireAccess(authority.accountId, parsed.arguments);
    this.requireAgent(authority.accountId);
    const latest = this.subscription(id);
    if ((current?.generation ?? null) !== (latest?.generation ?? null)) throw new EventError(-32015, 'The subscription changed. Retry subscribing.', 'subscription_changed');
    const activeCount = this.db.one<{ total: number }>('SELECT COUNT(*) AS total FROM event_subscriptions WHERE active = 1 AND expires_at > ?', Date.now())?.total ?? 0;
    const ownerCount = this.db.one<{ total: number }>('SELECT COUNT(*) AS total FROM event_subscriptions WHERE account_id = ? AND active = 1 AND expires_at > ?', authority.accountId, Date.now())?.total ?? 0;
    if (!current?.active && (activeCount >= 200 || ownerCount >= 50)) throw new EventError(-32014, 'Await allows 50 active subscriptions per identity and 200 per workspace.');
    const now = Date.now(), expiresAt = now + ttl;
    const rotated = Boolean(current?.active && current.secret_hash !== secretHash);
    this.db.run(`INSERT INTO event_subscriptions (id, account_id, name, arguments, channel_id, callback_url, secret, previous_secret, rotation_until, secret_hash, authority, expires_at, active, generation, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, previous_secret = excluded.previous_secret, rotation_until = excluded.rotation_until, secret_hash = excluded.secret_hash,
      authority = excluded.authority, expires_at = excluded.expires_at, active = 1, generation = excluded.generation, verified_at = excluded.verified_at, updated_at = excluded.updated_at, last_error = NULL`,
    id, authority.accountId, parsed.name, args, parsed.arguments.channel_id, url, encrypted,
    rotated ? current!.secret : current?.previous_secret ?? null, rotated ? now + 300000 : current?.rotation_until ?? null,
    secretHash, JSON.stringify(authority), expiresAt, crypto.randomUUID(), needsVerification ? now : existing!.verified_at, now, now);
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }

  // Background watches belong to named agents that are not paused.
  private requireAgent(accountId: string): void {
    const member = this.access.member(accountId);
    if (member?.kind !== 'agent') throw new EventError(-32012, 'Connect a named Await agent to monitor events. Background work uses its channel access, pause controls and post approval.');
    if (member.paused) throw new EventError(-32012, 'This agent is paused.');
  }

  private filters(params: Record<string, unknown>) {
    try { return parseEventArguments(params.name, params.arguments); }
    catch (error) { throw new EventError(-32602, error instanceof Error ? error.message : 'Invalid event filters.'); }
  }
  private requireAccess(accountId: string, args: EventArguments): void {
    if (!this.access.member(accountId) || !this.access.channel(args.channel_id, accountId)) throw new EventError(-32012, 'You must belong to the subscribed channel.');
    try { this.access.validateFilters(accountId, args); }
    catch { throw new EventError(-32012, 'The subscribed resource is unavailable in this channel.'); }
  }

  async unsubscribe(authority: EventAuthority, params: Record<string, unknown>): Promise<void> {
    const parsed = this.filters(params);
    const delivery = params.delivery as { mode?: unknown; url?: unknown } | undefined;
    if (delivery?.mode !== 'webhook') throw new EventError(-32602, 'Specify webhook delivery.');
    const url = callbackUrl(delivery.url);
    const id = await subscriptionId(authority, url, parsed);
    // Keep a tombstone so an in-flight verification cannot resurrect the watch.
    const now = Date.now();
    if (!this.subscription(id)) this.db.run(`INSERT INTO event_subscriptions (id, account_id, name, arguments, channel_id, callback_url, secret, secret_hash, authority, expires_at, active, generation, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, 0, ?, 0, ?, ?)`, id, authority.accountId, parsed.name, canonicalJson(parsed.arguments), parsed.arguments.channel_id, url, JSON.stringify(authority), now, crypto.randomUUID(), now, now);
    this.deactivate(id, 'Stopped monitoring.');
  }

  emit(event: EventOccurrence): void {
    const subscriptions = this.db.all<Subscription>("SELECT * FROM event_subscriptions WHERE active = 1 AND channel_id IN (?, '*') AND name = ?", event.channelId, event.name);
    if (!subscriptions.length) return;
    const inDm = Boolean(this.db.one('SELECT 1 FROM channels WHERE id=? AND is_dm=1', event.channelId));
    const eventId = `evt_${crypto.randomUUID()}`;
    const body = JSON.stringify({ eventId, name: event.name, timestamp: new Date(event.occurredAt).toISOString(), data: event.data, cursor: null });
    for (const row of subscriptions) {
      if (!this.eligible(row) || !this.access.recipient(row.account_id, event.channelId)
        || !matchesEvent(row.name, JSON.parse(row.arguments), row.account_id, event)) continue;
      // Workspace-wide watches never include direct messages.
      if (row.channel_id === '*' && inDm) continue;
      const count = this.db.one<{ total: number }>('SELECT COUNT(*) AS total FROM event_deliveries WHERE subscription_id = ?', row.id)?.total ?? 0;
      if (count >= 1000) { this.deactivate(row.id, 'Delivery backlog exceeded 1,000 events. Start a new watch after checking channel history.'); continue; }
      this.db.run('INSERT OR IGNORE INTO event_deliveries (subscription_id, event_id, body, channel_id, message_id, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)',
        row.id, eventId, body, event.channelId, typeof event.data.message_id === 'string' ? event.data.message_id : null, Date.now() + 1000);
    }
  }

  nextAlarm(): number | null {
    const delivery = this.db.one<{ due: number | null }>(`SELECT MIN(d.next_attempt_at) AS due FROM event_deliveries d WHERE NOT EXISTS
      (SELECT 1 FROM event_deliveries earlier WHERE earlier.subscription_id = d.subscription_id AND earlier.rowid < d.rowid)`)?.due;
    const expiry = this.db.one<{ due: number | null }>('SELECT MIN(expires_at) AS due FROM event_subscriptions WHERE active = 1')?.due;
    const cleanup = this.db.one<{ due: number | null }>('SELECT MIN(updated_at + ?) AS due FROM event_subscriptions WHERE active = 0', 7 * DAY)?.due;
    const receipts = this.db.one<{ due: number | null }>('SELECT MIN(attempted_at + ?) AS due FROM event_receipts', 7 * DAY)?.due;
    const next = Math.min(delivery ?? Infinity, expiry ?? Infinity, cleanup ?? Infinity, receipts ?? Infinity);
    return Number.isFinite(next) ? next : null;
  }

  // An edit replaces queued snapshots of a message. The caller re-emits updated and mentioned events; queued
  // `message.created` deliveries keep their place but carry the new text, so stale text is never sent.
  supersedeMessage(messageId: string, text: string, truncated: boolean): string[] {
    const mentioned = this.db.all<{ account_id: string }>(`SELECT DISTINCT s.account_id FROM event_deliveries d
      JOIN event_subscriptions s ON s.id = d.subscription_id WHERE d.message_id = ? AND s.name = 'message.mentioned'`, messageId).map((row) => row.account_id);
    const created = "SELECT id FROM event_subscriptions WHERE name = 'message.created'";
    this.db.run(`UPDATE event_deliveries SET body = json_set(body, '$.data.text', ?, '$.data.text_truncated', json(?)) WHERE message_id = ? AND subscription_id IN (${created})`, text, String(truncated), messageId);
    this.db.run(`DELETE FROM event_deliveries WHERE message_id = ? AND subscription_id NOT IN (${created})`, messageId);
    return mentioned;
  }

  async flush(): Promise<void> {
    for (const row of this.db.all<{ id: string }>('SELECT id FROM event_subscriptions WHERE active = 1 AND expires_at <= ?', Date.now())) this.deactivate(row.id, 'Subscription expired.');
    const due = this.db.all<{ subscription_id: string; event_id: string; body: string; channel_id: string; message_id: string | null; attempts: number }>(
      `SELECT d.* FROM event_deliveries d WHERE d.next_attempt_at <= ? AND NOT EXISTS
       (SELECT 1 FROM event_deliveries earlier WHERE earlier.subscription_id = d.subscription_id AND earlier.rowid < d.rowid)
       ORDER BY d.next_attempt_at LIMIT 10`, Date.now());
    await Promise.all(due.map(async (item) => {
      const row = this.subscription(item.subscription_id);
      if (!row) { this.db.run('DELETE FROM event_deliveries WHERE subscription_id = ?', item.subscription_id); return; }
      if (!this.eligible(row)) {
        if (!this.access.channel(row.channel_id, row.account_id) || !this.access.member(row.account_id)) this.deactivate(row.id, 'Channel or workspace access was removed.');
        else this.db.run('DELETE FROM event_deliveries WHERE subscription_id = ?', row.id); // Pause drops queued wakes.
        return;
      }
      if (!this.access.channel(item.channel_id, row.account_id)) {
        this.db.run('DELETE FROM event_deliveries WHERE subscription_id=? AND event_id=?', row.id, item.event_id); return;
      }
      let status = 0, reason = 'Callback unavailable.';
      try {
        if (!await this.authorized(JSON.parse(row.authority))) { this.deactivate(row.id, 'Connection access was revoked.'); return; }
        if (item.message_id && !this.db.one('SELECT 1 FROM messages WHERE id = ? AND deleted_at IS NULL', item.message_id)) {
          this.db.run('DELETE FROM event_deliveries WHERE subscription_id = ? AND event_id = ?', row.id, item.event_id); return;
        }
        const secrets = [await decryptSecret(this.env, row.id, row.secret)];
        if (row.previous_secret && row.rotation_until! > Date.now()) secrets.push(await decryptSecret(this.env, row.id, row.previous_secret));
        const reply = await sendWebhook(this.env, row.callback_url, row.id, item.event_id, item.body, secrets, () => {
          const current = this.subscription(row.id);
          return Boolean(current && current.generation === row.generation && this.eligible(current) && this.access.channel(item.channel_id, row.account_id)
            && this.db.one('SELECT 1 FROM event_deliveries WHERE subscription_id = ? AND event_id = ?', row.id, item.event_id)
            && (!item.message_id || this.db.one('SELECT 1 FROM messages WHERE id = ? AND deleted_at IS NULL', item.message_id)));
        });
        status = reply.status; reason = `Callback returned HTTP ${status}.`;
      } catch (error) { reason = error instanceof EventError ? error.reason ?? error.message : 'Callback delivery failed.'; }
      if (this.subscription(row.id)?.generation !== row.generation) return;
      if (!this.db.one('SELECT 1 FROM event_deliveries WHERE subscription_id = ? AND event_id = ?', row.id, item.event_id)) return;
      const verdict = deliveryVerdict(status, reason, item.attempts);
      if (verdict === 'gone') { this.receipt(item, status, 'stopped'); this.deactivate(row.id, 'The callback stopped accepting this subscription (HTTP 410).'); return; }
      if (verdict === 'accepted') {
        this.receipt(item, status, 'accepted');
        this.db.run('DELETE FROM event_deliveries WHERE subscription_id = ? AND event_id = ?', row.id, item.event_id);
        this.db.run('UPDATE event_subscriptions SET last_delivered_at = ?, last_error = NULL WHERE id = ?', Date.now(), row.id);
      } else if (verdict === 'stop') {
        this.receipt(item, status, 'stopped');
        // Make a failed watch visible rather than silently skipping an event.
        this.deactivate(row.id, `${deliveryProblem(reason)} Monitoring stopped; inspect channel history and start a new watch.`);
      } else {
        this.receipt(item, status, 'retrying');
        this.db.run('UPDATE event_deliveries SET attempts = attempts + 1, next_attempt_at = ? WHERE subscription_id = ? AND event_id = ?', Date.now() + retryDelay(item.attempts), row.id, item.event_id);
        this.db.run('UPDATE event_subscriptions SET last_error = ? WHERE id = ?', deliveryProblem(reason), row.id);
      }
    }));
    // Keep cancellation tombstones long enough to defeat in-flight verification.
    this.db.run('DELETE FROM event_subscriptions WHERE active = 0 AND updated_at < ?', Date.now() - 7 * DAY);
    this.db.run('DELETE FROM event_receipts WHERE attempted_at <= ? OR NOT EXISTS (SELECT 1 FROM event_subscriptions s WHERE s.id=event_receipts.subscription_id)', Date.now() - 7 * DAY);
    this.db.run('UPDATE event_subscriptions SET previous_secret = NULL, rotation_until = NULL WHERE rotation_until <= ?', Date.now());
  }

  revokeChannel(channelId: string, accountId?: string): void {
    const rows = accountId ? this.db.all<{ id: string }>('SELECT id FROM event_subscriptions WHERE channel_id = ? AND account_id = ? AND active = 1', channelId, accountId)
      : this.db.all<{ id: string }>('SELECT id FROM event_subscriptions WHERE channel_id = ? AND active = 1', channelId);
    for (const row of rows) this.deactivate(row.id, 'Channel access was removed.');
  }
  revokeAccount(accountId: string): void { for (const row of this.db.all<{ id: string }>('SELECT id FROM event_subscriptions WHERE account_id = ? AND active = 1', accountId)) this.deactivate(row.id, 'Workspace access was removed.'); }
  pauseAccount(accountId: string): void { this.db.run('DELETE FROM event_deliveries WHERE subscription_id IN (SELECT id FROM event_subscriptions WHERE account_id = ?)', accountId); }

  // A removed agent's watches stay visible to workspace owners and admins.
  private canManage(viewer: Member, accountId: string): boolean {
    return managesAgent(viewer, this.access.member(accountId) ?? { owner_id: null });
  }
  list(viewer: Member, accountId?: string): unknown[] {
    if (accountId && !this.canManage(viewer, accountId)) throw new EventError(-32012, 'You cannot manage these subscriptions.');
    return this.db.all<Subscription>('SELECT * FROM event_subscriptions ORDER BY created_at DESC').filter((row) => (!accountId || row.account_id === accountId) && this.canManage(viewer, row.account_id))
      .map((row) => ({ id: row.id, account_id: row.account_id, name: row.name, arguments: JSON.parse(row.arguments),
        account_name: this.access.member(row.account_id)?.name ?? 'Former teammate', paused: Boolean(this.access.member(row.account_id)?.paused),
        channel_name: row.channel_id === '*' ? 'All workspace channels' : this.db.one<{ name: string }>('SELECT name FROM channels WHERE id = ?', row.channel_id)?.name ?? 'Former channel',
        destination: new URL(row.callback_url).hostname, active: Boolean(row.active && row.expires_at > Date.now()), expires_at: row.expires_at,
        last_delivered_at: row.last_delivered_at, last_error: row.last_error,
        receipts: this.db.all('SELECT event_id, message_id, occurred_at, attempted_at, attempts, http_status, outcome, payload_bytes FROM event_receipts WHERE subscription_id=? ORDER BY attempted_at DESC, rowid DESC LIMIT 10', row.id),
        pending: this.db.one<{ total: number }>('SELECT COUNT(*) AS total FROM event_deliveries WHERE subscription_id = ?', row.id)?.total ?? 0 }));
  }
  cancel(viewer: Member, id: string): void {
    const row = this.subscription(id);
    if (!row || !this.canManage(viewer, row.account_id)) throw new EventError(-32012, 'Subscription not found.');
    this.deactivate(id, 'Stopped in Await.');
  }
}
