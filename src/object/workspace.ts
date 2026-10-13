import { Projects } from './projects';
import { workLinks } from '../shared/workspace-library';
import { DurableObject } from 'cloudflare:workers';
import type { Attachment, Channel, ChatMessage, Member, PendingAgentPost, TaskRef, TaskReference } from '../shared/types';
import { taskStatusIds } from '../shared/types';
import { TAG_PATTERN, mentionIds, taskIds } from '../shared/tags';
import { liveLimits, parseClientFrame, type ClientFrame, type ServerFrame } from '../shared/live';
import { attachmentKind, normalizeAttachment } from '../shared/attachments';
import type { Env } from '../worker/env';
import { emailAvailable, sendChatNotice } from '../worker/email';
import type { EventAuthority } from './event-subscriptions';
import { EventError, eventsEnabled } from '../worker/event-webhooks';
import type { EventName } from '../shared/mcp-events';
import { canonicalJson } from '../shared/json';
import { Notifications } from './notifications';
import { migrateSearch, parseSearchQuery, searchKinds, searchWorkspace, type SearchOptions } from './search';
import { migrateAgentAccess } from './agent-access';
import { Db } from './sql';
import { Router } from './router';
import { HttpError, failure, forbidden, json, notFound } from '../shared/http';
import { managesAgent } from '../shared/members';
import { randomToken } from '../worker/auth';

type Row = Record<string, unknown>;
// `approved` is internal: set only when a person approves a queued agent post.
type PostInput = { channel_id: string; body: string; thread_id?: string | null; client_id?: string; attachment_ids?: string[]; approved?: boolean };
type PostResult = ChatMessage | { pending: true; id: string; status: 'pending' };
type TaskInput = { title?: string; description?: string; status?: string; priority?: number; assignee_id?: string | null; due_at?: number | null };
type SocketAttachment = { accountId: string; kind: Member['kind']; canWrite: boolean };
// What a route handler gets. `accountId` is the caller the Worker named ('' for a ticketed socket),
// and `params` holds the route's path segments, decoded.
type RouteContext = { request: Request; url: URL; accountId: string; workspaceId: string | null; params: Record<string, string> };
type RouteHandler = (this: Workspace, context: RouteContext) => Response | undefined | Promise<Response | undefined>;

// Long-poll timeout from `?timeout=` in milliseconds, capped below the 30 s request budget.
function waitTimeout(url: URL): number {
  return Math.min(25_000, Math.max(0, Number(url.searchParams.get('timeout') ?? 25_000) || 0));
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function attachmentOf(socket: WebSocket): SocketAttachment | null {
  const value = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
  return value?.accountId ? { accountId: value.accountId, kind: value.kind ?? 'human', canWrite: value.canWrite === true } : null;
}

export class Workspace extends DurableObject<Env> {
  private db: Db;
  private projects: Projects;
  private notifications: Notifications;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Db(this.ctx.storage.sql);
    let schemaVersion: string | undefined;
    try { schemaVersion = this.db.meta('schema_version') ?? undefined; }
    catch { /* A new workspace has no meta table yet. */ }
    // Constructors run again after hibernation. Bump the version when changing this schema.
    if (!schemaVersion || Number(schemaVersion) < 1) {
      const statements = [
        `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS members (account_id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, avatar_url TEXT, role TEXT NOT NULL, owner_id TEXT, description TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS former_members (account_id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, avatar_url TEXT, role TEXT NOT NULL, owner_id TEXT, description TEXT NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', is_private INTEGER NOT NULL DEFAULT 0, is_dm INTEGER NOT NULL DEFAULT 0, dm_key TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER, agent_streak INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS channel_members (channel_id TEXT NOT NULL, account_id TEXT NOT NULL, last_read_id TEXT, notify TEXT NOT NULL DEFAULT 'mentions', muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_id, account_id))`,
        `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL, client_id TEXT, created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER)`,
        `CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id)`,
        `CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id) WHERE thread_id IS NOT NULL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS messages_retry ON messages(author_id, client_id) WHERE client_id IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS mentions (message_id TEXT NOT NULL, account_id TEXT NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY (message_id, account_id))`,
        `CREATE INDEX IF NOT EXISTS mentions_account ON mentions(account_id, message_id)`,
        `CREATE TABLE IF NOT EXISTS thread_reads (thread_id TEXT NOT NULL, account_id TEXT NOT NULL, last_read_id TEXT NOT NULL, PRIMARY KEY (thread_id, account_id))`,
        `CREATE TABLE IF NOT EXISTS reactions (message_id TEXT NOT NULL, account_id TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (message_id, account_id, emoji))`,
        `CREATE INDEX IF NOT EXISTS reactions_message ON reactions(message_id)`,
        `CREATE TABLE IF NOT EXISTS artifact_repositories (name TEXT PRIMARY KEY, channel_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, uploader_id TEXT NOT NULL, message_id TEXT, kind TEXT NOT NULL, r2_key TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id)`,
        `CREATE TABLE IF NOT EXISTS agent_posts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS agent_posts_account ON agent_posts(account_id, created_at)`,
        `CREATE TABLE IF NOT EXISTS agent_activity (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, action TEXT NOT NULL, channel_id TEXT, target_id TEXT, created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS agent_activity_agent ON agent_activity(agent_id, id)`,
        `CREATE TABLE IF NOT EXISTS pending_agent_posts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, body TEXT NOT NULL, client_id TEXT, attachment_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', posted_id TEXT)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS pending_agent_posts_retry ON pending_agent_posts(agent_id, client_id) WHERE client_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS pending_agent_posts_agent ON pending_agent_posts(agent_id, status, id)`,
        `CREATE TABLE IF NOT EXISTS email_notifications (account_id TEXT NOT NULL, channel_id TEXT NOT NULL, last_sent_at INTEGER NOT NULL, PRIMARY KEY (account_id, channel_id))`,
        // Legacy agent webhooks: emptied by schema 17 and kept so the previous release can still run.
        `CREATE TABLE IF NOT EXISTS agent_webhooks (agent_id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, updated_at INTEGER NOT NULL, last_delivered_at INTEGER, last_error TEXT)`,
        `CREATE TABLE IF NOT EXISTS webhook_deliveries (agent_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, message_id))`,
        `CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(next_attempt_at)`,
        `CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS boards_channel ON boards(channel_id, created_at)`,
        `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2, assignee_id TEXT, due_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER)`,
        `CREATE INDEX IF NOT EXISTS tasks_board ON tasks(board_id, status, created_at)`,
        `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS documents_channel ON documents(channel_id, updated_at)`,
      ];
      for (const statement of statements) this.db.run(statement);
      const channelColumns = this.db.all<{ name: string }>('PRAGMA table_info(channels)');
      if (!channelColumns.some((column) => column.name === 'is_dm')) this.db.run('ALTER TABLE channels ADD COLUMN is_dm INTEGER NOT NULL DEFAULT 0');
      if (!channelColumns.some((column) => column.name === 'dm_key')) this.db.run('ALTER TABLE channels ADD COLUMN dm_key TEXT');
      const memberColumns = this.db.all<{ name: string }>('PRAGMA table_info(members)');
      if (!memberColumns.some((column) => column.name === 'last_active_at')) this.db.run('ALTER TABLE members ADD COLUMN last_active_at INTEGER');
      if (!memberColumns.some((column) => column.name === 'approval_mode')) this.db.run('ALTER TABLE members ADD COLUMN approval_mode INTEGER NOT NULL DEFAULT 0');
      this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_key ON channels(dm_key) WHERE dm_key IS NOT NULL');
      this.db.setMeta('schema_version', '1');
    }
    if (!schemaVersion || Number(schemaVersion) < 2) {
      this.db.run('CREATE TABLE IF NOT EXISTS live_tickets (ticket TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
      this.db.setMeta('schema_version', '2');
    }
    if (!schemaVersion || Number(schemaVersion) < 3) {
      this.db.run('CREATE TABLE IF NOT EXISTS file_deletions (r2_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL)');
      this.db.run('CREATE INDEX IF NOT EXISTS file_deletions_due ON file_deletions(next_attempt_at)');
      this.db.run('INSERT OR IGNORE INTO file_deletions (r2_key, next_attempt_at) SELECT a.r2_key, ? FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.deleted_at IS NOT NULL', Date.now());
      this.db.run('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE deleted_at IS NOT NULL)');
      this.db.setMeta('schema_version', '3');
      this.touchAlarm();
    }
    this.notifications = new Notifications(ctx, env, {
      member: (id) => this.member(id),
      channel: (id, accountId) => id === '*' ? this.allChannels(accountId)
        : Boolean(this.channelMember(id, accountId) && this.db.one('SELECT 1 FROM channels WHERE id = ? AND archived_at IS NULL', id)),
      validateFilters: (_accountId, args) => {
        if (args.channel_id === '*' && (args.thread_id || args.board_id || args.task_id || args.document_id)) throw new Error();
        if (args.thread_id && !this.db.one('SELECT 1 FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL AND deleted_at IS NULL', args.thread_id, args.channel_id)) throw new Error();
        if (args.board_id && !this.db.one('SELECT 1 FROM boards WHERE id = ? AND channel_id = ?', args.board_id, args.channel_id)) throw new Error();
        if (args.task_id && !this.db.one('SELECT 1 FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND b.channel_id = ? AND (? IS NULL OR b.id = ?)', args.task_id, args.channel_id, args.board_id ?? null, args.board_id ?? null)) throw new Error();
        if (args.document_id && !this.db.one('SELECT 1 FROM documents WHERE id = ? AND channel_id = ?', args.document_id, args.channel_id)) throw new Error();
      },
      signal: (id) => { this.wake(id); this.ctx.waitUntil(Promise.resolve().then(() => this.sendTo(id, { type: 'agent_events' }))); },
      schedule: () => this.touchAlarm(),
    });
    if (!schemaVersion || Number(schemaVersion) < 4) {
      this.notifications.watches.migrate();
      this.db.run('CREATE TABLE IF NOT EXISTS work_creation_keys (account_id TEXT NOT NULL, operation TEXT NOT NULL, client_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (account_id, operation, client_id))');
      this.db.setMeta('schema_version', '4');
    }
    if (!schemaVersion || Number(schemaVersion) < 5) {
      this.notifications.inbox.migrate();
      this.db.setMeta('schema_version', '5');
    }
    if (!schemaVersion || Number(schemaVersion) < 6) migrateSearch(this.ctx.storage);
    if (!schemaVersion || Number(schemaVersion) < 7) migrateAgentAccess(this.ctx.storage);
    if (!schemaVersion || Number(schemaVersion) < 8) this.notifications.watches.migrateReceipts();
    this.projects = new Projects(ctx, env, { member: (actor) => this.requireMember(actor), channel: (channel, actor) => { this.requireChannel(channel, actor); }, writer: (actor) => this.requireWorkWriter(actor), taskChanged: (project, actor, task, previous) => {
      this.emitWorkEvent('task.updated', project.channel_id, actor, task, previous);
      this.broadcast({ type: 'board_changed', channel_id: project.channel_id, board_id: project.board_id }, this.channelRecipients(project.channel_id));
    }, signal: (project, actor, type, runId) => {
      this.broadcast({ type: 'projects_changed' }, this.channelRecipients(project.channel_id));
      const common = this.eventContext(project.channel_id, actor);
      this.notifications.emit({ name: 'project.updated', channelId: project.channel_id, actorId: actor, actorKind: common.actor_kind, occurredAt: Date.now(), data: { ...common, project_id: project.id, title: project.title, event_type: type, run_id: runId, url: `${common.url}?view=projects&project=${project.id}` } });
    } });
    if (!schemaVersion || Number(schemaVersion) < 15) this.projects.migrate();
    if (!schemaVersion || Number(schemaVersion) < 16) this.migrateReferences();
    if (!schemaVersion || Number(schemaVersion) < 17) this.notifications.webhooks.migrate();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(...liveLimits.pingAutoResponse));
  }

  private member(accountId: string): Member | null {
    return this.db.one<Member>('SELECT m.*, EXISTS(SELECT 1 FROM agent_channel_access a WHERE a.account_id=m.account_id) AS all_channels FROM members m WHERE m.account_id = ?', accountId);
  }

  private allChannels(accountId: string): boolean {
    return Boolean(this.db.one('SELECT 1 FROM agent_channel_access a JOIN members m ON m.account_id=a.account_id WHERE a.account_id=? AND m.kind=?', accountId, 'agent'));
  }

  private listMembers(): Member[] {
    return this.db.all<Member>(`SELECT m.*, EXISTS(SELECT 1 FROM agent_channel_access a WHERE a.account_id=m.account_id) AS all_channels, CASE WHEN m.kind = 'agent' THEN
      (SELECT COUNT(*) FROM pending_agent_posts p WHERE p.agent_id = m.account_id AND p.status = 'pending') ELSE 0 END AS pending_count
      FROM members m ORDER BY m.kind, m.name`);
  }

  private listFormerMembers(): Member[] {
    return this.db.all<Member>(`SELECT account_id, kind, name, avatar_url, role, owner_id, description, 0 AS paused
      FROM former_members ORDER BY name`);
  }

  private channelMember(channelId: string, accountId: string): Row | null {
    return this.db.one<Row>('SELECT * FROM channel_members WHERE channel_id = ? AND account_id = ?', channelId, accountId);
  }

  private requireMember(accountId: string): Member {
    const member = this.member(accountId);
    if (!member) throw new Error('You are not a member of this workspace.');
    return member;
  }

  private requireWorkWriter(accountId: string): void {
    const member = this.requireMember(accountId);
    if (member.kind === 'agent' && member.paused) throw forbidden('This agent is paused.');
    if (member.kind === 'agent' && member.approval_mode) throw forbidden('This agent requires approval for posts. A human must turn off approval mode before it can change workspace content.');
  }

  // A channel's creator, the owner of the agent that created it, and workspace admins manage it.
  private canManageChannel(channel: Row, actor: Member): boolean {
    if (actor.role === 'owner' || actor.role === 'admin' || channel.created_by === actor.account_id) return true;
    const creator = this.member(String(channel.created_by ?? ''));
    return creator?.kind === 'agent' && creator.owner_id === actor.account_id;
  }

  // Channel names are lowercase slugs, unique in the workspace.
  private channelName(raw: unknown, exceptId = ''): string {
    const name = typeof raw === 'string' ? raw.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-') : '';
    if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(name)) throw new Error('Use 2 to 50 letters, numbers, or hyphens.');
    if (this.db.one('SELECT id FROM channels WHERE name = ? AND id != ?', name, exceptId)) throw new Error('A channel with that name exists.');
    return name;
  }

  private requireChannel(channelId: string, accountId: string): { channel: Row; member: Member } {
    const member = this.requireMember(accountId);
    const channel = this.db.one<Row>('SELECT * FROM channels WHERE id = ? AND archived_at IS NULL', channelId);
    if (!channel || !this.channelMember(channelId, accountId)) throw new Error('You are not a member of this channel.');
    return { channel, member };
  }

  // A channel that exists and is not archived. Channel actions check this before membership, so a
  // missing channel is a 404 rather than a membership error.
  private liveChannel(channelId: string): Row {
    const channel = this.db.one<Row>('SELECT * FROM channels WHERE id = ? AND archived_at IS NULL', channelId);
    if (!channel) throw notFound('Channel');
    return channel;
  }

  // A live channel and the caller, who must belong to it.
  private requireLiveChannel(channelId: string, accountId: string): { channel: Row; member: Member } {
    const channel = this.liveChannel(channelId);
    const member = this.requireMember(accountId);
    if (!this.channelMember(channelId, accountId)) throw new Error('You are not a member of this channel.');
    return { channel, member };
  }

  private nextId(): string {
    const last = this.db.meta('last_id') ?? '';
    const now = Date.now().toString(36).padStart(10, '0');
    const previousTime = last.slice(0, 10);
    const time = now > previousTime ? now : previousTime;
    const sequence = time === previousTime ? Number.parseInt(last.slice(10), 36) + 1 : 0;
    const id = `${time}${sequence.toString(36).padStart(5, '0')}`;
    this.db.setMeta('last_id', id);
    return id;
  }

  // Schema 16: an index of inline references (today only Kanban cards) plus the indexes the
  // sidebar and board queries were missing. Keyed by channel so it shards with everything else.
  private migrateReferences(): void {
    this.ctx.storage.transactionSync(() => {
      this.db.run('CREATE TABLE IF NOT EXISTS message_references (kind TEXT NOT NULL, target_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (kind, target_id, message_id))');
      this.db.run('CREATE INDEX IF NOT EXISTS message_references_message ON message_references(message_id)');
      this.db.run('CREATE INDEX IF NOT EXISTS messages_channel_root ON messages(channel_id, id) WHERE thread_id IS NULL');
      this.db.run('CREATE INDEX IF NOT EXISTS mentions_account_channel ON mentions(account_id, channel_id, message_id)');
      this.db.run('CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id, status, updated_at) WHERE assignee_id IS NOT NULL');
      this.db.run('CREATE INDEX IF NOT EXISTS project_runs_task ON project_runs(task_id, status) WHERE task_id IS NOT NULL');
      this.db.setMeta('schema_version', '16');
    });
  }

  // Only cards on boards in the message's own channel can be referenced, so anyone who can
  // read the message can already see the card. Unknown ids stay literal text.
  private indexTaskReferences(messageId: string, channelId: string, body: string): void {
    this.db.run("DELETE FROM message_references WHERE message_id = ? AND kind = 'task'", messageId);
    for (const taskId of taskIds(body)) {
      if (this.db.one('SELECT 1 FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND b.channel_id = ?', taskId, channelId)) {
        this.db.run("INSERT OR IGNORE INTO message_references (kind, target_id, message_id, channel_id, created_at) VALUES ('task', ?, ?, ?, ?)", taskId, messageId, channelId, Date.now());
      }
    }
  }

  private attachTaskRefs(messages: ChatMessage[]): void {
    const tagged = messages.filter((message) => message.body.includes('<task:'));
    const rows: (TaskRef & { message_id: string })[] = [];
    for (const ids of chunk(tagged.map((message) => message.id), 50)) rows.push(...this.db.all<TaskRef & { message_id: string }>(`SELECT r.message_id, t.id, t.title, t.status, t.board_id FROM message_references r JOIN tasks t ON t.id = r.target_id WHERE r.kind = 'task' AND r.message_id IN (${ids.map(() => '?').join(',')})`, ...ids));
    for (const message of tagged) message.tasks = rows.filter((row) => row.message_id === message.id).map(({ message_id: _message, ...task }) => task);
  }

  // One-line previews for a card's "Referenced in" list. Tags resolve the way the chat shows them to this
  // viewer: private channels they have not joined stay "#channel", and only cards indexed from the message get titles.
  private taskReferences(taskId: string, viewerId: string): TaskReference[] {
    const rows = this.db.all<Omit<TaskReference, 'excerpt'> & { body: string }>(`SELECT m.id AS message_id, m.channel_id, m.thread_id, m.author_id, m.created_at, m.body FROM message_references r JOIN messages m ON m.id = r.message_id
      WHERE r.kind = 'task' AND r.target_id = ? AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 50`, taskId);
    const cards = new Map<string, string>();
    for (const ids of chunk(rows.map((row) => row.message_id), 50)) {
      for (const card of this.db.all<{ id: string; title: string }>(`SELECT t.id, t.title FROM message_references r JOIN tasks t ON t.id = r.target_id WHERE r.kind = 'task' AND r.message_id IN (${ids.map(() => '?').join(', ')})`, ...ids)) cards.set(card.id, card.title);
    }
    const channels = new Map<string, string>();
    const channelName = (id: string) => {
      if (!channels.has(id)) {
        const channel = this.db.one<Row>('SELECT name, is_private, is_dm FROM channels WHERE id = ? AND archived_at IS NULL', id);
        channels.set(id, channel && !channel.is_dm && (!channel.is_private || this.channelMember(id, viewerId)) ? String(channel.name) : 'channel');
      }
      return channels.get(id);
    };
    return rows.map(({ body, ...row }) => {
      const text = body.slice(0, 600).replace(TAG_PATTERN, (_tag, sigil: string, id: string) => sigil === '@' ? `@${this.member(id)?.name ?? 'someone'}`
        : sigil === '#' ? `#${channelName(id)}` : `#${cards.get(id) ?? 'task'}`)
        // Plain text: link labels without targets, and no bold, strike or code markers (single _ stays for snake_case).
        // A code span keeps its content as written, so `src/**` stays whole.
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/(`+)([^`]+?)\1|\*\*|__|~~/g, (_marker, ticks?: string, code?: string) => ticks ? code! : '')
        .replace(/`+/g, '').replace(/\s+/g, ' ').trim();
      return { ...row, excerpt: text.length > 160 ? `${text.slice(0, 159)}…` : text };
    });
  }

  private recordAgentActivity(agentId: string, action: string, channelId: string | null, targetId: string | null, active = true): void {
    const now = Date.now();
    this.db.run('INSERT INTO agent_activity (id, agent_id, action, channel_id, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', this.nextId(), agentId, action, channelId, targetId, now);
    if (active) this.db.run('UPDATE members SET last_active_at = ? WHERE account_id = ?', now, agentId);
    this.db.run('DELETE FROM agent_activity WHERE agent_id = ? AND id NOT IN (SELECT id FROM agent_activity WHERE agent_id = ? ORDER BY id DESC LIMIT 500)', agentId, agentId);
  }

  // Sends to the open sockets of the given accounts, or of everyone connected. Sockets are tagged by account id.
  private broadcast(event: ServerFrame, recipients?: string[]): void {
    const data = JSON.stringify(event);
    const sockets = recipients ? recipients.flatMap((id) => this.ctx.getWebSockets(id)) : this.ctx.getWebSockets();
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }

  private sendTo(accountId: string, event: ServerFrame): void {
    this.broadcast(event, [accountId]);
  }

  private isOnline(accountId: string, except?: WebSocket): boolean {
    return this.ctx.getWebSockets(accountId).some((socket) => socket !== except && socket.readyState === WebSocket.OPEN);
  }

  private channelRecipients(channelId: string): string[] {
    return this.db.all<{ account_id: string }>('SELECT account_id FROM channel_members WHERE channel_id = ?', channelId).map((row) => row.account_id);
  }

  // People and connected agent hosts both count as online; the client knows each member's kind.
  private onlineIds(): string[] {
    const online = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const id = socket.readyState === WebSocket.OPEN ? attachmentOf(socket)?.accountId : undefined;
      if (id) online.add(id);
    }
    return [...online];
  }

  // Long-poll support: MCP clients wait here for inbox events or mentions instead of polling.
  // Held long-poll requests per account. A wake re-checks for data; `closed` ends them (sign-out, token revoke).
  private waiters = new Map<string, Set<(closed: boolean) => void>>();
  private wake(accountId: string, closed = false): void {
    const pending = this.waiters.get(accountId);
    if (!pending) return;
    this.waiters.delete(accountId);
    for (const resolve of pending) resolve(closed);
  }
  private waitFor(accountId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (closed: boolean) => {
        clearTimeout(timer);
        const pending = this.waiters.get(accountId);
        pending?.delete(done);
        if (pending?.size === 0) this.waiters.delete(accountId);
        resolve(closed);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      if (!this.waiters.has(accountId)) this.waiters.set(accountId, new Set());
      this.waiters.get(accountId)!.add(done);
    });
  }
  // Returns as soon as `read` finds something, otherwise when the timeout passes.
  private async longPoll<T>(accountId: string, timeoutMs: number, read: () => T[]): Promise<T[]> {
    const deadline = Date.now() + timeoutMs;
    let found = read();
    while (!found.length && Date.now() < deadline) {
      if (await this.waitFor(accountId, deadline - Date.now())) throw new HttpError(401, 'This connection was closed.');
      found = read();
    }
    return found;
  }

  private async scheduleAlarm(): Promise<void> {
    const file = this.db.one<{ due: number | null }>('SELECT MIN(next_attempt_at) AS due FROM file_deletions')?.due;
    const next = Math.min(file ?? Infinity, this.notifications?.nextAlarm() ?? Infinity, this.projects?.nextAlarm() ?? Infinity);
    const alarm = await this.ctx.storage.getAlarm();
    if (!Number.isFinite(next)) { if (alarm != null) await this.ctx.storage.deleteAlarm(); return; }
    if (alarm == null || alarm <= Date.now() || next < alarm) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }

  // Recompute the alarm once the current request has settled its writes.
  private touchAlarm(): void {
    this.ctx.waitUntil(Promise.resolve().then(() => this.scheduleAlarm()));
  }

  private async flushFileDeletions(): Promise<void> {
    const due = this.db.all<{ r2_key: string; attempts: number }>('SELECT r2_key, attempts FROM file_deletions WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 100', Date.now());
    if (due.length) {
      try {
        await this.env.FILES.delete(due.map((item) => item.r2_key));
        for (const item of due) this.db.run('DELETE FROM file_deletions WHERE r2_key = ?', item.r2_key);
      } catch {
        for (const item of due) this.db.run('UPDATE file_deletions SET attempts = ?, next_attempt_at = ? WHERE r2_key = ?',
          item.attempts + 1, Date.now() + Math.min(86400000, 2000 * 2 ** Math.min(item.attempts, 16)), item.r2_key);
      }
    }
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    await this.notifications.flush();
    await this.projects.flush();
    await this.flushFileDeletions();
  }

  private agentLimits(): { rate_per_minute: number; turn_cap: number } {
    const saved = new Map(this.db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('agent_rate_limit', 'agent_turn_cap')").map((item) => [item.key, Number(item.value)]));
    const rate = saved.get('agent_rate_limit');
    const turns = saved.get('agent_turn_cap');
    return {
      rate_per_minute: Number.isInteger(rate) && rate! >= 1 && rate! <= 100 ? rate! : 20,
      turn_cap: Number.isInteger(turns) && turns! >= 1 && turns! <= 50 ? turns! : 10,
    };
  }

  private listChannels(accountId: string): Channel[] {
    return this.db.all<Channel>(`SELECT c.id, c.name, c.description, c.is_private, c.is_dm, c.dm_key, c.created_by, c.created_at, c.archived_at,
      CASE WHEN cm.account_id IS NULL THEN 0 ELSE 1 END AS joined,
      cm.last_read_id,
      COALESCE(cm.notify, 'mentions') AS notify,
      CASE WHEN cm.account_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.thread_id IS NULL AND m.deleted_at IS NULL AND m.author_id != ? AND (cm.last_read_id IS NULL OR m.id > cm.last_read_id)) END AS unread,
      CASE WHEN cm.account_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM mentions t JOIN messages m ON m.id = t.message_id LEFT JOIN thread_reads tr ON tr.thread_id = m.thread_id AND tr.account_id = t.account_id WHERE t.channel_id = c.id AND t.account_id = ? AND m.deleted_at IS NULL AND ((m.thread_id IS NULL AND (cm.last_read_id IS NULL OR m.id > cm.last_read_id)) OR (m.thread_id IS NOT NULL AND (tr.last_read_id IS NULL OR m.id > tr.last_read_id)))) END AS mentions
      FROM channels c LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.account_id = ?
      WHERE c.archived_at IS NULL AND (c.is_private = 0 OR cm.account_id IS NOT NULL)
      ORDER BY c.created_at, c.name`, accountId, accountId, accountId);
  }

  private getMessages(channelId: string, accountId: string, before?: string, threadId?: string, limit = 50): ChatMessage[] {
    this.requireChannel(channelId, accountId);
    const capped = Math.min(Math.max(limit, 1), 100);
    const query = `SELECT m.*, (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id AND r.deleted_at IS NULL) AS reply_count,
        (SELECT COUNT(*) FROM mentions t JOIN messages r ON r.id = t.message_id LEFT JOIN thread_reads tr ON tr.thread_id = r.thread_id AND tr.account_id = t.account_id
          WHERE r.thread_id = m.id AND t.account_id = ? AND r.deleted_at IS NULL AND (tr.last_read_id IS NULL OR r.id > tr.last_read_id)) AS unread_mentions
        FROM messages m WHERE m.channel_id = ? AND m.thread_id IS NULL AND (? = '' OR m.id < ?) ORDER BY m.id DESC LIMIT ?`;
    const root = threadId && !before ? this.db.one<ChatMessage>('SELECT m.*, (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id AND r.deleted_at IS NULL) AS reply_count FROM messages m WHERE m.channel_id = ? AND m.id = ? AND m.thread_id IS NULL', channelId, threadId) : null;
    const messages = threadId
      ? [...this.db.all<ChatMessage>("SELECT m.*, 0 AS reply_count FROM messages m WHERE m.channel_id = ? AND m.thread_id = ? AND (? = '' OR m.id < ?) ORDER BY m.id DESC LIMIT ?", channelId, threadId, before ?? '', before ?? '', capped - (root ? 1 : 0)), ...(root ? [root] : [])]
      : this.db.all<ChatMessage>(query, accountId, channelId, before ?? '', before ?? '', capped);
    return this.hydrate(messages, accountId).reverse();
  }

  // Attach files, reactions and card references for a page of messages. SQLite binds at most
  // 100 variables per statement here, so ids are looked up in chunks.
  private hydrate(messages: ChatMessage[], accountId: string): ChatMessage[] {
    const attachments: Attachment[] = [], reactions: { message_id: string; emoji: string; count: number; mine: number }[] = [];
    for (const ids of chunk(messages.map((m) => m.id), 50)) {
      const placeholders = ids.map(() => '?').join(',');
      attachments.push(...this.db.all<Attachment>(`SELECT id, message_id, channel_id, kind, mime, size, filename FROM attachments WHERE message_id IN (${placeholders})`, ...ids).map(normalizeAttachment));
      reactions.push(...this.db.all<{ message_id: string; emoji: string; count: number; mine: number }>(`SELECT message_id, emoji, COUNT(*) AS count, MAX(CASE WHEN account_id = ? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE message_id IN (${placeholders}) GROUP BY message_id, emoji ORDER BY count DESC, emoji`, accountId, ...ids));
    }
    for (const message of messages) {
      message.attachments = attachments.filter((item) => item.message_id === message.id);
      message.reactions = reactions.filter((item) => item.message_id === message.id).map(({ emoji, count, mine }) => ({ emoji, count, mine }));
    }
    this.attachTaskRefs(messages);
    return messages;
  }

  // Reconnect catch-up: messages after a cursor in frames that stay well under the 1 MiB socket limit.
  private syncPage(accountId: string, after: string): { messages: ChatMessage[]; next: string | null; done: boolean } {
    const { syncPageMessages, syncPageBytes } = liveLimits;
    const rows = this.db.all<ChatMessage>('SELECT m.* FROM messages m JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.account_id = ? WHERE m.id > ? ORDER BY m.id LIMIT ?', accountId, after, syncPageMessages + 1);
    const page: ChatMessage[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, syncPageMessages)) {
      bytes += row.body.length + 400;
      if (page.length && bytes > syncPageBytes) break;
      page.push(row);
    }
    const done = rows.length <= syncPageMessages && page.length === rows.length;
    return { messages: this.hydrate(page, accountId), next: page.length ? page[page.length - 1].id : null, done };
  }

  private messageWithAttachments(message: ChatMessage): ChatMessage {
    message.attachments = this.db.all<Attachment>('SELECT id, message_id, channel_id, kind, mime, size, filename FROM attachments WHERE message_id = ?', message.id).map(normalizeAttachment);
    this.attachTaskRefs([message]);
    return message;
  }

  private async notifyByEmail(message: ChatMessage, channel: Row, sender: Member, recipients: string[], mentioned: string[]): Promise<void> {
    if (!emailAvailable(this.env)) return;
    const eligible = recipients.filter((recipientId) => {
      if (recipientId === sender.account_id || (!channel.is_dm && !mentioned.includes(recipientId))) return false;
      if (this.member(recipientId)?.kind !== 'human' || this.isOnline(recipientId)) return false;
      const membership = this.channelMember(message.channel_id, recipientId);
      return Boolean(membership && !membership.muted && membership.notify !== 'none');
    });
    if (!eligible.length) return;
    const workspaceId = this.db.meta('workspace_id');
    if (!workspaceId) return;
    let workspaceName: string | null = null;
    const now = Date.now();
    for (const recipientId of eligible) {
      const last = this.db.one<{ last_sent_at: number }>('SELECT last_sent_at FROM email_notifications WHERE account_id = ? AND channel_id = ?', recipientId, message.channel_id);
      if (last && now - last.last_sent_at < 300000) continue;
      const preferences = await this.env.DB.prepare('SELECT email_mentions, email_dms FROM notification_preferences WHERE account_id = ?').bind(recipientId).first<{ email_mentions: number; email_dms: number }>();
      if (channel.is_dm ? preferences?.email_dms !== 1 : preferences?.email_mentions !== 1) continue;
      const account = await this.env.DB.prepare('SELECT email FROM accounts WHERE id = ? AND kind = ?').bind(recipientId, 'human').first<{ email: string }>();
      if (!account?.email) continue;
      if (!workspaceName) workspaceName = (await this.env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(workspaceId).first<{ name: string }>())?.name ?? null;
      if (!workspaceName) return;
      const link = `${this.env.APP_ORIGIN}/w/${workspaceId}/${message.channel_id}${message.thread_id ? `?thread=${message.thread_id}` : ''}`;
      try {
        if (await sendChatNotice(this.env, { to: account.email, workspace: workspaceName, sender: sender.name, channel: String(channel.name), link, isDm: Boolean(channel.is_dm) })) {
          this.db.run('INSERT INTO email_notifications (account_id, channel_id, last_sent_at) VALUES (?, ?, ?) ON CONFLICT(account_id, channel_id) DO UPDATE SET last_sent_at = excluded.last_sent_at', recipientId, message.channel_id, now);
        }
      } catch (cause) { console.error('Notification email failed:', cause instanceof Error ? cause.message : 'unknown error'); }
    }
  }

  private post(accountId: string, input: PostInput): PostResult {
    return this.ctx.storage.transactionSync(() => this.postInsideTransaction(accountId, input));
  }

  // Payload shared by message.created, message.updated and message.mentioned events.
  private messageEventData(message: { id: string; channel_id: string; thread_id: string | null }, body: string, actorId: string) {
    const common = this.eventContext(message.channel_id, actorId);
    const root = message.thread_id ?? message.id;
    const replyCount = this.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND deleted_at IS NULL', root)?.count ?? 0;
    return { ...common, message_id: message.id, thread_id: message.thread_id, reply_count: replyCount, text: body.slice(0, 4000), text_truncated: body.length > 4000, url: `${common.url}?thread=${encodeURIComponent(root)}` };
  }

  private postInsideTransaction(accountId: string, input: PostInput): PostResult {
    const { channel, member } = this.requireChannel(input.channel_id, accountId);
    const body = input.body?.trim() ?? '';
    const attachmentIds = input.attachment_ids ?? [];
    if (body.length > 12000) throw new Error('Messages are limited to 12,000 characters.');
    if (!body && attachmentIds.length === 0) throw new Error('Write a message or attach a file.');
    if (attachmentIds.length > 10) throw new Error('A message can include up to ten files.');
    if (input.client_id) {
      const existing = this.db.one<ChatMessage>('SELECT * FROM messages WHERE author_id = ? AND client_id = ?', accountId, input.client_id);
      if (existing) return this.messageWithAttachments(existing);
      const queued = this.db.one<PendingAgentPost>('SELECT * FROM pending_agent_posts WHERE agent_id = ? AND client_id = ?', accountId, input.client_id);
      if (queued && !input.approved) {
        if (queued.status === 'rejected') throw new Error('This proposed message was rejected. Use a new client id to revise it.');
        return { pending: true, id: queued.id, status: 'pending' };
      }
    }
    if (input.thread_id) {
      const root = this.db.one<ChatMessage>('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL AND deleted_at IS NULL', input.thread_id, input.channel_id);
      if (!root) throw new HttpError(404, 'The thread could not be found.');
    }
    if (member.kind === 'agent') {
      if (member.paused) throw forbidden('This agent is paused.');
      const membership = this.channelMember(input.channel_id, accountId);
      if (membership?.muted) throw new Error('This agent is muted in this channel.');
      const limits = this.agentLimits();
      if (Number(channel.agent_streak) >= limits.turn_cap) throw new Error('Agents are held until a human replies.');
      const recent = this.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM agent_posts WHERE account_id = ? AND created_at > ?', accountId, Date.now() - 60000)?.count ?? 0;
      if (recent >= limits.rate_per_minute) throw new Error('Agent rate limit reached. Try again in a minute.');
    }
    for (const attachmentId of attachmentIds) {
      const attachment = this.db.one<Row>('SELECT * FROM attachments WHERE id = ? AND channel_id = ? AND uploader_id = ? AND message_id IS NULL', attachmentId, input.channel_id, accountId);
      if (!attachment) throw new Error('An attachment is missing or belongs to another channel.');
    }
    if (member.kind === 'agent' && member.approval_mode && !input.approved) {
      this.db.run("DELETE FROM pending_agent_posts WHERE agent_id = ? AND status != 'pending' AND created_at < ?", accountId, Date.now() - 30 * 86400000);
      const queuedCount = this.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM pending_agent_posts WHERE agent_id = ? AND status = 'pending'", accountId)?.count ?? 0;
      if (queuedCount >= 20) throw new Error('This agent has 20 messages awaiting review.');
      const id = this.nextId();
      this.db.run('INSERT INTO pending_agent_posts (id, agent_id, channel_id, thread_id, body, client_id, attachment_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, accountId, input.channel_id, input.thread_id ?? null, body, input.client_id ?? null, JSON.stringify(attachmentIds), Date.now());
      if (member.owner_id) this.sendTo(member.owner_id, { type: 'agent_pending', agent_id: accountId, id });
      return { pending: true, id, status: 'pending' };
    }
    const id = this.nextId();
    const createdAt = Date.now();
    this.db.run('INSERT INTO messages (id, channel_id, thread_id, author_id, body, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.channel_id, input.thread_id ?? null, accountId, body, input.client_id ?? null, createdAt);
    for (const attachmentId of attachmentIds) this.db.run('UPDATE attachments SET message_id = ? WHERE id = ?', id, attachmentId);
    const recipients = this.channelRecipients(input.channel_id);
    const mentioned = mentionIds(body);
    this.indexTaskReferences(id, input.channel_id, body);
    const posted = { id, channel_id: input.channel_id, thread_id: input.thread_id ?? null };
    for (const mentionedId of new Set(mentioned)) {
      if (!recipients.includes(mentionedId)) continue;
      this.db.run('INSERT OR IGNORE INTO mentions (message_id, account_id, channel_id) VALUES (?, ?, ?)', id, mentionedId, input.channel_id);
      this.wake(mentionedId);
    }
    if (member.kind === 'agent') {
      this.db.run('INSERT INTO agent_posts (id, account_id, created_at) VALUES (?, ?, ?)', id, accountId, createdAt);
      this.db.run('UPDATE channels SET agent_streak = agent_streak + 1 WHERE id = ?', input.channel_id);
    } else {
      // Skip no-op writes: any channel update also rewrites its search index entry.
      this.db.run('UPDATE channels SET agent_streak = 0 WHERE id = ? AND agent_streak != 0', input.channel_id);
    }
    this.db.run('DELETE FROM agent_posts WHERE created_at < ?', createdAt - 60000);
    const message = this.messageWithAttachments({ id, client_id: input.client_id ?? null, channel_id: input.channel_id, thread_id: input.thread_id ?? null, author_id: accountId, body, created_at: createdAt, edited_at: null, deleted_at: null });
    const occurrence = { occurredAt: createdAt, channelId: input.channel_id, actorId: accountId, actorKind: member.kind, mentions: mentioned, data: this.messageEventData(posted, body, accountId) };
    this.notifications.emit({ ...occurrence, name: 'message.created' }, { ...occurrence, name: 'message.mentioned' });
    this.broadcast({ type: 'message', message }, recipients);
    this.ctx.waitUntil(Promise.resolve().then(() => this.notifyByEmail(message, channel, member, recipients, mentioned)));
    if (member.kind === 'agent' && Number(channel.agent_streak) === this.agentLimits().turn_cap - 1) this.broadcast({ type: 'held', channel_id: input.channel_id }, recipients);
    return message;
  }

  private eventContext(channelId: string, accountId: string): Record<string, string> {
    const workspaceId = this.db.meta('workspace_id') ?? '';
    const member = this.requireMember(accountId);
    const channel = this.db.one<{ name: string }>('SELECT name FROM channels WHERE id = ?', channelId);
    return { workspace_id: workspaceId, channel_id: channelId, channel_name: channel?.name ?? '', actor_id: accountId, actor_name: member.name, actor_kind: member.kind,
      url: `${this.env.APP_ORIGIN}/w/${encodeURIComponent(workspaceId)}/${encodeURIComponent(channelId)}` };
  }

  private emitWorkEvent(name: EventName, channelId: string, accountId: string, record: Row, previous?: Row): void {
    const content = (value: Row) => Object.fromEntries(Object.entries(value).filter(([key]) => !['updated_at', 'updated_by', 'completed_at'].includes(key)));
    if (previous && canonicalJson(content(previous)) === canonicalJson(content(record))) return;
    const common = this.eventContext(channelId, accountId);
    const task = name.startsWith('task.');
    const data = task ? { ...common, task_id: String(record.id), board_id: String(record.board_id), title: String(record.title), status: String(record.status), assignee_id: record.assignee_id as string | null,
      url: `${common.url}?view=tasks&board=${encodeURIComponent(String(record.board_id))}&task=${encodeURIComponent(String(record.id))}` }
      : { ...common, document_id: String(record.id), title: String(record.title), url: `${common.url}?view=docs&doc=${encodeURIComponent(String(record.id))}` };
    this.notifications.emit({ name, channelId, actorId: accountId, actorKind: common.actor_kind, occurredAt: Date.now(), data });
  }

  private existingWorkCreation(accountId: string, operation: string, clientId: unknown, request: unknown): Row | null {
    if (clientId === undefined) return null;
    if (typeof clientId !== 'string' || !clientId || clientId.length > 200) throw new Error('Use a client_id containing 1 to 200 characters.');
    const row = this.db.one<{ request: string; result: string }>('SELECT request, result FROM work_creation_keys WHERE account_id = ? AND operation = ? AND client_id = ?', accountId, operation, clientId);
    if (!row) return null;
    if (row.request !== canonicalJson(request)) throw new Error('This client_id was already used for a different creation request.');
    return JSON.parse(row.result) as Row;
  }

  private rememberWorkCreation(accountId: string, operation: string, clientId: string | undefined, request: unknown, result: Row): void {
    if (clientId) this.db.run('INSERT INTO work_creation_keys (account_id, operation, client_id, request, result) VALUES (?, ?, ?, ?, ?)', accountId, operation, clientId, canonicalJson(request), JSON.stringify(result));
  }

  // Validation shared by card creation and PATCH. With `existing`, omitted fields keep their saved
  // values and a done card keeps its completion time; a new card gets the defaults.
  private taskInput(input: TaskInput, channelId: string, now: number, existing?: Row): Row {
    const status = existing ? (input.status === undefined ? existing.status : input.status) : taskStatusIds.includes(input.status as never) ? input.status : 'todo';
    if (!taskStatusIds.includes(status as never)) throw new Error('Invalid task status.');
    // Agents send JSON straight from tool calls, so check types rather than trusting TaskInput.
    const text = (value: unknown, field: string): string => { if (typeof value !== 'string') throw new Error(`The task ${field} must be text.`); return value; };
    const title = input.title === undefined ? existing?.title : text(input.title, 'title').trim().slice(0, 240);
    if (!title) throw new Error('Task title is required.');
    if (input.priority != null && !(Number.isInteger(input.priority) && input.priority >= 1 && input.priority <= 3)) throw new Error('Priority must be 1, 2 or 3.');
    if (input.due_at != null && !Number.isSafeInteger(input.due_at)) throw new Error('The due date must be a time in milliseconds.');
    if (existing && status === 'done' && this.db.one("SELECT 1 FROM project_runs WHERE task_id=? AND status NOT IN ('integrated','cancelled','failed') LIMIT 1", existing.id)) throw new Error('Integrate the submitted code before completing this task.');
    const assignee = input.assignee_id === undefined ? existing?.assignee_id ?? null : input.assignee_id;
    if (assignee && !this.channelMember(channelId, String(assignee))) throw new Error('Assignee must be in the channel.');
    return { title, status, assignee_id: assignee ?? null,
      description: input.description === undefined ? existing?.description ?? '' : text(input.description ?? '', 'description').slice(0, 4000),
      priority: input.priority == null ? existing?.priority ?? 2 : input.priority,
      due_at: input.due_at === undefined ? existing?.due_at ?? null : input.due_at ?? null,
      completed_at: status === 'done' ? existing?.completed_at ?? now : null };
  }

  // Validation shared by document creation and PUT; an update keeps whichever field was omitted.
  private documentInput(input: { title?: string; body?: string }, existing?: Row): { title: string; body: string } {
    const title = (input.title ?? (existing ? String(existing.title) : '')).trim().slice(0, 120);
    if (!title) throw new Error(existing ? 'Document is too large or missing a title.' : 'Document title is required.');
    const body = input.body ?? (existing ? String(existing.body) : '');
    if (typeof body !== 'string' || body.length > 250000) throw new Error(existing ? 'Document is too large or missing a title.' : 'Document is too large.');
    return { title, body };
  }

  private updateMessage(accountId: string, messageId: string, body: string): ChatMessage {
    return this.ctx.storage.transactionSync(() => this.updateMessageInsideTransaction(accountId, messageId, body));
  }

  private updateMessageInsideTransaction(accountId: string, messageId: string, body: string): ChatMessage {
    this.requireWorkWriter(accountId);
    const message = this.db.one<ChatMessage>('SELECT * FROM messages WHERE id = ?', messageId);
    if (!message || message.deleted_at) throw notFound('Message');
    const member = this.requireChannel(message.channel_id, accountId).member;
    if (message.author_id !== accountId) throw forbidden('Only the author can edit a message.');
    if (typeof body !== 'string' || !body.trim() || body.length > 12000) throw new Error('Message text is invalid.');
    body = body.trim();
    if (message.body === body) return this.messageWithAttachments(message);
    const now = Date.now();
    const previousMentions = new Set(this.db.all<{ account_id: string }>('SELECT account_id FROM mentions WHERE message_id = ?', messageId).map((item) => item.account_id));
    this.db.run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', body, now, messageId);
    this.db.run('DELETE FROM mentions WHERE message_id = ?', messageId);
    const recipients = this.channelRecipients(message.channel_id);
    const currentMentions = new Set(mentionIds(body).filter((id) => recipients.includes(id)));
    this.indexTaskReferences(messageId, message.channel_id, body);
    for (const mentionedId of currentMentions) {
      this.db.run('INSERT OR IGNORE INTO mentions (message_id, account_id, channel_id) VALUES (?, ?, ?)', messageId, mentionedId, message.channel_id);
      if (!previousMentions.has(mentionedId)) this.wake(mentionedId);
    }
    const updated = this.messageWithAttachments({ ...message, body, edited_at: now });
    // Queued snapshots of the message are replaced. A callback already accepted by its destination cannot be recalled.
    this.notifications.editMessage(messageId, body, { occurredAt: now, channelId: message.channel_id, actorId: accountId, actorKind: member.kind,
      data: this.messageEventData(message, body, accountId) }, previousMentions, currentMentions);
    this.broadcast({ type: 'edit', message: updated }, recipients);
    return updated;
  }

  private async deleteMessage(accountId: string, messageId: string): Promise<void> {
    this.requireWorkWriter(accountId);
    const message = this.db.one<ChatMessage>('SELECT * FROM messages WHERE id = ?', messageId);
    if (!message || message.deleted_at) throw notFound('Message');
    const member = this.requireChannel(message.channel_id, accountId).member;
    if (message.author_id !== accountId && !['owner', 'admin'].includes(member.role)) throw forbidden('You cannot delete this message.');
    this.ctx.storage.transactionSync(() => {
      this.db.run("UPDATE messages SET body = '', deleted_at = ? WHERE id = ?", Date.now(), messageId);
      this.db.run('DELETE FROM mentions WHERE message_id = ?', messageId);
      this.db.run('DELETE FROM message_references WHERE message_id = ?', messageId);
      this.notifications.forgetMessage(messageId);
      this.db.run('DELETE FROM reactions WHERE message_id = ?', messageId);
      this.db.run('INSERT OR IGNORE INTO file_deletions (r2_key, next_attempt_at) SELECT r2_key, ? FROM attachments WHERE message_id = ?', Date.now(), messageId);
      this.db.run('DELETE FROM attachments WHERE message_id = ?', messageId);
    });
    this.broadcast({ type: 'delete', message_id: messageId, channel_id: message.channel_id }, this.channelRecipients(message.channel_id));
    await this.flushFileDeletions();
  }

  private toggleReaction(accountId: string, messageId: string, emoji: string): { emoji: string; active: boolean } {
    this.requireWorkWriter(accountId);
    const allowed = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];
    if (!allowed.includes(emoji)) throw new Error('Choose a supported reaction.');
    const message = this.db.one<ChatMessage>('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', messageId);
    if (!message) throw notFound('Message');
    this.requireChannel(message.channel_id, accountId);
    const existing = this.db.one('SELECT 1 FROM reactions WHERE message_id = ? AND account_id = ? AND emoji = ?', messageId, accountId, emoji);
    if (existing) this.db.run('DELETE FROM reactions WHERE message_id = ? AND account_id = ? AND emoji = ?', messageId, accountId, emoji);
    else this.db.run('INSERT INTO reactions (message_id, account_id, emoji) VALUES (?, ?, ?)', messageId, accountId, emoji);
    this.broadcast({ type: 'reaction', channel_id: message.channel_id, message_id: messageId, thread_id: message.thread_id }, this.channelRecipients(message.channel_id));
    return { emoji, active: !existing };
  }

  // Advances the reader's channel cursor; reached from the HTTP route and the live 'read' frame.
  private markRead(accountId: string, channelId: string, messageId: string): void {
    this.requireChannel(channelId, accountId);
    if (!this.db.one('SELECT id FROM messages WHERE id = ? AND channel_id = ?', messageId, channelId)) throw notFound('Message');
    this.db.run('UPDATE channel_members SET last_read_id = ? WHERE channel_id = ? AND account_id = ? AND (last_read_id IS NULL OR last_read_id < ?)', messageId, channelId, accountId, messageId);
    this.sendTo(accountId, { type: 'read', channel_id: channelId, message_id: messageId });
  }

  // The object's internal HTTP surface, by area. Only the Worker reaches it: the Worker authenticates
  // the caller, names them in x-account-id and refuses client paths that would decode into another
  // route. Handlers authorize that account against this workspace's own members and channels.
  private readonly routes = new Router<RouteHandler>([
    // Worker-only. The Worker sends these from its own flows and never with a client's path or body,
    // because each takes the Worker's word for something: a member's record and role, whose sessions
    // to end, which tool an agent ran, or that D1 membership goes with the removal.
    ['POST', '/bootstrap', this.bootstrap],
    ['POST', '/members/upsert', this.upsertMember],
    ['POST', '/members/remove', this.removeMember],
    ['POST', '/connections/close', this.closeConnections],
    ['POST', '/agent-activity', this.recordToolActivity],
    // The live socket. A session's socket can write; one opened with a ticket only receives.
    ['POST', '/live-ticket', this.issueLiveTicket],
    ['*', '/socket', this.openSocket],
    // Long-polls and the inboxes they wait on. A /wait route answers as soon as something arrives, or
    // empty after ?timeout= ms (25 s at most); closing the account's connections ends it with a 401.
    ['GET', '/agent-events', this.agentInbox],
    ['GET', '/agent-events/wait', this.waitForAgentEvents],
    ['POST', '/agent-events/ack', this.acknowledgeAgentEvents],
    ['GET', '/mentions', this.mentions],
    ['GET', '/mentions/wait', this.waitForMentions],
    // MCP event subscriptions. The Worker resolves the caller's credential into the authority it sends.
    ['POST', '/events', this.eventSubscriptionCall],
    ['GET', '/event-subscriptions', this.listEventSubscriptions],
    ['DELETE', '/event-subscriptions/:subscription', this.cancelEventSubscription],
    // Members and agents.
    ['GET', '/members', this.showMembers],
    ['POST', '/members/channel-access', this.setChannelAccess],
    ['POST', '/members/pause', this.pauseAgent],
    ['POST', '/members/approval', this.setApprovalMode],
    ['GET', '/agents/:agent/listening', this.showListening],
    ['PUT', '/agents/:agent/listening/:channel', this.setListening],
    ['GET', '/agents/:agent/activity', this.showAgentActivity],
    ['GET', '/agents/:agent/webhook', this.showWebhook],
    ['PUT', '/agents/:agent/webhook', this.setWebhook],
    ['DELETE', '/agents/:agent/webhook', this.removeWebhook],
    // Posts an agent in approval mode proposes, held until a person decides.
    ['GET', '/agents/:agent/pending', this.listPendingPosts],
    ['POST', '/agents/:agent/pending/:post', this.decidePendingPost],
    ['GET', '/agents/:agent/pending/:post/files/:file', this.pendingPostFile],
    ['GET', '/agent-posts/:post/status', this.pendingPostStatus],
    // Workspace-wide views, search and settings.
    ['GET', '/snapshot', this.showSnapshot],
    ['GET', '/overview', this.showOverview],
    ['GET', '/settings', this.showSettings],
    ['PUT', '/settings', this.saveSettings],
    ['GET', '/search', this.searchMessages],
    ['GET', '/search-workspace', this.workspaceSearch],
    ['GET', '/mention-search', this.mentionSearch],
    // Channels and direct messages.
    ['POST', '/channels', this.createChannel],
    ['POST', '/dms', this.openDm],
    ['POST', '/channels/:channel/join', this.joinChannel],
    ['POST', '/channels/:channel/leave', this.leaveChannel],
    ['POST', '/channels/:channel/rename', this.renameChannel],
    ['POST', '/channels/:channel/archive', this.archiveChannel],
    ['GET', '/channels/:channel/members', this.listChannelMembers],
    ['POST', '/channels/:channel/members', this.addChannelMember],
    ['DELETE', '/channels/:channel/members/:member', this.removeChannelMember],
    ['POST', '/channels/:channel/mute', this.muteAgent],
    ['POST', '/channels/:channel/notify', this.setChannelNotify],
    ['*', '/channels/:channel/access', this.checkChannelAccess],
    // Messages and threads.
    ['GET', '/channels/:channel/messages', this.readMessages],
    ['POST', '/channels/:channel/messages', this.postMessage],
    ['POST', '/channels/:channel/read', this.markChannelRead],
    ['POST', '/channels/:channel/threads/:thread/read', this.markThreadRead],
    ['GET', '/messages/:message', this.readMessage],
    ['POST', '/messages/:message/edit', this.editMessage],
    ['POST', '/messages/:message/delete', this.removeMessage],
    ['POST', '/messages/:message/reactions', this.reactToMessage],
    // Boards and tasks.
    ['GET', '/tasks', this.listChannelTasks],
    ['GET', '/boards', this.listBoards],
    ['POST', '/boards', this.createBoard],
    ['GET', '/boards/:board', this.showBoard],
    ['GET', '/boards/:board/tasks', this.showBoard],
    ['POST', '/boards/:board/tasks', this.createTask],
    ['GET', '/tasks/:task', this.showTask],
    ['PATCH', '/tasks/:task', this.updateTask],
    ['DELETE', '/tasks/:task', this.deleteTask],
    // Documents.
    ['GET', '/documents', this.listDocuments],
    ['POST', '/documents', this.createDocument],
    ['GET', '/documents/:document', this.showDocument],
    ['PUT', '/documents/:document', this.updateDocument],
    ['DELETE', '/documents/:document', this.deleteDocument],
    // The collab proxy passes the browser's method through to boards, tasks and documents. Any other
    // method still gets that path's lookup and channel check before its 404.
    ['*', '/boards/:board', this.checkBoard],
    ['*', '/boards/:board/tasks', this.checkBoard],
    ['*', '/tasks/:task', this.checkTask],
    ['*', '/documents/:document', this.checkDocument],
    // Files and Artifacts repositories. The Worker stores the bytes in R2 and creates the repositories,
    // then records them here, so only the Worker may name an R2 key or a repository.
    ['POST', '/channels/:channel/attachments', this.registerAttachment],
    ['GET', '/attachments/library', this.fileLibrary],
    ['DELETE', '/attachments/:attachment', this.deleteUnsentAttachment],
    ['*', '/attachments/:attachment', this.showAttachment],
    ['POST', '/artifact-repositories', this.registerArtifactRepository],
    ['GET', '/artifact-repositories/:repository', this.showArtifactRepository],
    ['POST', '/channels/:channel/artifact-access', this.checkArtifactAccess],
    // Projects have their own router (src/object/projects.ts), which takes every method.
    ['*', '/projects', this.projectRoutes],
    ['*', '/projects/*', this.projectRoutes],
  ]);

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const accountId = request.headers.get('x-account-id') ?? '';
    const workspaceId = request.headers.get('x-workspace-id');
    if (workspaceId) this.db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('workspace_id', ?)", workspaceId);
    try {
      const route = this.routes.match(request.method, url.pathname);
      const response = route && await route.handler.call(this, { request, url, accountId, workspaceId, params: route.params });
      return response ?? failure('Not found.', 404);
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'Request failed.', error instanceof HttpError ? error.status : 400);
    }
  }

  // Worker-only: the founding owner and #general of a workspace the Worker just created. It only
  // inserts what is missing, so the Worker can retry it.
  private async bootstrap({ request }: RouteContext): Promise<Response> {
    const { member, channel } = await request.json<{ member: Member; channel: { id: string; name: string } }>();
    this.db.run('INSERT OR IGNORE INTO members (account_id, kind, name, avatar_url, role, owner_id, description) VALUES (?, ?, ?, ?, ?, ?, ?)', member.account_id, member.kind, member.name, member.avatar_url, member.role, member.owner_id ?? null, member.description ?? '');
    this.db.run('INSERT OR IGNORE INTO channels (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', channel.id, channel.name, member.account_id, Date.now());
    this.db.run('INSERT OR IGNORE INTO channel_members (channel_id, account_id) VALUES (?, ?)', channel.id, member.account_id);
    return json({ ok: true });
  }

  // Worker-only: the member record the Worker settled on, role and owner included, after someone
  // joins, edits their profile, or creates or authorizes an agent.
  private async upsertMember({ request }: RouteContext): Promise<Response> {
    const member = await request.json<Member>();
    this.db.run(`INSERT INTO members (account_id, kind, name, avatar_url, role, owner_id, description, paused) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url, role = excluded.role, owner_id = excluded.owner_id, description = excluded.description`, member.account_id, member.kind, member.name, member.avatar_url, member.role, member.owner_id ?? null, member.description ?? '', member.paused ?? 0);
    this.db.run('DELETE FROM former_members WHERE account_id = ?', member.account_id);
    this.broadcast({ type: 'member', member: this.member(member.account_id) });
    return json({ ok: true });
  }

  // Worker-only: the Worker checks its own records first and deletes the D1 membership afterwards.
  // The actor's rights are checked again here before the member's channel state and sessions go.
  private async removeMember({ request, accountId }: RouteContext): Promise<Response> {
    const { account_id } = await request.json<{ account_id: string }>();
    const actor = this.requireMember(accountId);
    if (account_id === accountId) return failure('You cannot remove yourself.');
    const target = this.member(account_id);
    if (!target) return json({ ok: true });
    if (actor.kind !== 'human' || (actor.role === 'member' && !(target.kind === 'agent' && target.owner_id === accountId))) return failure('You cannot remove this member.', 403);
    if (target.role === 'owner' || (actor.role === 'admin' && target.role === 'admin')) return failure('You cannot remove this person.', 403);
    this.db.run('DELETE FROM channel_members WHERE account_id = ?', account_id);
    this.db.run('DELETE FROM thread_reads WHERE account_id = ?', account_id);
    this.db.run('DELETE FROM mentions WHERE account_id = ?', account_id);
    this.db.run('DELETE FROM email_notifications WHERE account_id = ?', account_id);
    this.notifications.revokeAccount(account_id);
    this.db.run(`INSERT INTO former_members (account_id, kind, name, avatar_url, role, owner_id, description)
      SELECT account_id, kind, name, CASE WHEN kind = 'agent' THEN NULL ELSE avatar_url END, role, owner_id, description
      FROM members WHERE account_id = ?
      ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url, role = excluded.role, description = excluded.description`, account_id);
    this.db.run('DELETE FROM members WHERE account_id = ?', account_id);
    const sockets = this.ctx.getWebSockets(account_id);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'access_removed' }));
      socket.close(liveLimits.closeInvalid, 'Access removed');
    }
    this.db.run('DELETE FROM live_tickets WHERE account_id = ?', account_id);
    this.wake(account_id, true);
    this.broadcast({ type: 'member_removed', account_id });
    return json({ ok: true, connections_targeted: sockets.length });
  }

  // Worker-only: sign-out and token revocation end every socket and long-poll of the account the
  // Worker names, which for a revoked agent token is the agent, not the person revoking it.
  private closeConnections({ accountId }: RouteContext): Response {
    // Unused tickets die with the sockets, so a revoked credential cannot reopen a feed.
    this.db.run('DELETE FROM live_tickets WHERE account_id = ?', accountId);
    const sockets = this.ctx.getWebSockets(accountId);
    for (const socket of sockets) socket.close(liveLimits.closeSignedOut, 'Signed out');
    this.wake(accountId, true);
    return json({ ok: true, connections_targeted: sockets.length });
  }

  // Worker-only: the Worker reports each tool an agent used, for the activity log its owner reads.
  private async recordToolActivity({ request, accountId }: RouteContext): Promise<Response> {
    const agent = this.requireMember(accountId);
    if (agent.kind !== 'agent') return failure('Only agents have tool activity.', 403);
    const input = await request.json<{ action?: string; channel_id?: string; target_id?: string; project_id?: string }>();
    // Internal route: the Worker names the tool, so check its shape rather than mirroring the tool list.
    if (!input.action || !/^[a-z_]{2,64}$/.test(input.action)) return failure('Invalid agent activity.', 400);
    let channelId = input.channel_id || null;
    if ((input.action === 'get_attachment' || input.action === 'get_file') && input.target_id) {
      const attachment = this.db.one<{ channel_id: string }>('SELECT channel_id FROM attachments WHERE id = ? AND message_id IS NOT NULL', input.target_id);
      if (!attachment) return failure('Attachment not found.', 404);
      channelId = attachment.channel_id;
    }
    if (input.project_id) {
      const project = this.db.one<{ channel_id: string }>('SELECT channel_id FROM projects WHERE id=?', input.project_id);
      if (!project) return failure('Project not found.', 404);
      channelId = project.channel_id;
    }
    if (channelId) this.requireChannel(channelId, accountId);
    this.recordAgentActivity(accountId, input.action, channelId, input.target_id || null);
    return json({ ok: true });
  }

  // An MCP client without a session cookie trades this one-minute ticket for a receive-only socket.
  private issueLiveTicket({ accountId }: RouteContext): Response {
    this.requireMember(accountId);
    const ticket = randomToken();
    const expiresAt = Date.now() + 60_000;
    this.db.run('DELETE FROM live_tickets WHERE expires_at < ?', Date.now());
    this.db.run('INSERT INTO live_tickets (ticket, account_id, expires_at) VALUES (?, ?, ?)', ticket, accountId, expiresAt);
    return json({ ticket, expires_at: expiresAt });
  }

  // Any method: only the upgrade header and, for a ticketed socket, the ticket decide.
  private openSocket({ request, url, accountId }: RouteContext): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return failure('WebSocket upgrade required.', 426);
    let connectedAccountId = accountId;
    const ticket = url.searchParams.get('ticket');
    if (ticket) {
      const row = this.db.one<{ account_id: string }>('DELETE FROM live_tickets WHERE ticket = ? AND expires_at >= ? RETURNING account_id', ticket, Date.now());
      if (!row) return failure('This live connection has expired.', 401);
      connectedAccountId = row.account_id;
    }
    const member = this.requireMember(connectedAccountId);
    const wasOnline = this.isOnline(connectedAccountId);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [connectedAccountId]);
    // The attachment survives hibernation; presence and write checks never need SQL.
    server.serializeAttachment({ accountId: connectedAccountId, kind: member.kind, canWrite: !ticket } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: 'ready', channels: this.listChannels(connectedAccountId), members: this.listMembers(), former_members: this.listFormerMembers(), account_id: member.account_id, online_ids: this.onlineIds() } satisfies ServerFrame));
    if (!wasOnline) this.broadcast({ type: 'presence', account_id: connectedAccountId, kind: member.kind, online: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  private agentInbox({ accountId }: RouteContext): Response {
    return json({ events: this.notifications.inbox.pending(accountId) });
  }

  private async waitForAgentEvents({ url, accountId }: RouteContext): Promise<Response> {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    return json({ events: await this.longPoll(accountId, waitTimeout(url), () => this.notifications.inbox.pending(accountId, limit)) });
  }

  private async acknowledgeAgentEvents({ request, accountId }: RouteContext): Promise<Response> {
    const input = await request.json<{ event_id?: unknown; event_ids?: unknown; outcome?: unknown; error?: unknown }>();
    const ids = Array.isArray(input.event_ids) ? input.event_ids : [input.event_id];
    const outcome = input.outcome === undefined ? 'completed' : String(input.outcome);
    if (!ids.length || ids.length > 50 || ids.some((value) => typeof value !== 'string') || !['completed', 'failed'].includes(outcome)) return failure('Choose up to 50 event ids and a completed or failed outcome.');
    for (const eventId of ids as string[]) this.notifications.inbox.acknowledge(accountId, eventId, outcome as 'completed' | 'failed', typeof input.error === 'string' ? input.error : undefined);
    return json({ ok: true, acknowledged: ids.length });
  }

  private mentions({ url, accountId }: RouteContext): Response {
    this.requireMember(accountId);
    return json(this.mentionsAfter(accountId, url.searchParams.get('after') ?? ''));
  }

  private async waitForMentions({ url, accountId }: RouteContext): Promise<Response> {
    this.requireMember(accountId);
    const after = url.searchParams.get('after') ?? '';
    // A lookup reads history; a wait is a wake, so a paused agent's wait holds and returns nothing, as wait_for_events does.
    return json(await this.longPoll(accountId, waitTimeout(url), () => this.member(accountId)?.paused ? [] : this.mentionsAfter(accountId, after)));
  }

  // The account's mentions after a message id, in channels it still belongs to.
  private mentionsAfter(accountId: string, after: string): ChatMessage[] {
    return this.db.all<ChatMessage>('SELECT m.* FROM mentions t JOIN messages m ON m.id = t.message_id JOIN channel_members cm ON cm.channel_id = t.channel_id AND cm.account_id = ? WHERE t.account_id = ? AND m.id > ? AND m.deleted_at IS NULL ORDER BY m.id LIMIT 100', accountId, accountId, after);
  }

  // MCP events/subscribe and events/unsubscribe. Their EventErrors come back as `eventError`, which
  // the Worker relays as JSON-RPC errors.
  private async eventSubscriptionCall({ request, accountId, workspaceId }: RouteContext): Promise<Response> {
    const input = await request.json<{ method: string; params: Record<string, unknown>; authority: EventAuthority }>();
    if (input.authority.accountId !== accountId || input.authority.workspaceId !== workspaceId) throw new EventError(-32012, 'Subscription identity mismatch.');
    try {
      const result = input.method === 'events/subscribe' ? await this.notifications.watches.subscribe(input.authority, input.params)
        : input.method === 'events/unsubscribe' ? await this.notifications.watches.unsubscribe(input.authority, input.params).then(() => ({}))
        : (() => { throw new EventError(-32601, 'Unknown event method.'); })();
      await this.scheduleAlarm();
      return json({ result });
    } catch (error) {
      if (error instanceof EventError) return json({ eventError: { code: error.code, message: error.message, reason: error.reason } });
      throw error;
    }
  }

  private listEventSubscriptions({ url, accountId }: RouteContext): Response {
    return json({ available: eventsEnabled(this.env), subscriptions: this.notifications.watches.list(this.requireMember(accountId), url.searchParams.get('account_id') ?? undefined) });
  }

  private async cancelEventSubscription({ params, accountId }: RouteContext): Promise<Response> {
    this.notifications.watches.cancel(this.requireMember(accountId), params.subscription);
    await this.scheduleAlarm();
    return json({ ok: true });
  }

  private showMembers({ accountId }: RouteContext): Response {
    this.requireMember(accountId);
    return json(this.listMembers());
  }

  private async setChannelAccess({ request, accountId }: RouteContext): Promise<Response> {
    const actor = this.requireMember(accountId);
    const { agent_id, all_channels } = await request.json<{ agent_id: string; all_channels: boolean }>();
    const agent = this.member(agent_id);
    if (actor.kind !== 'human' || actor.role === 'member') return failure('Only workspace owners and admins can grant all-channel access.', 403);
    if (!agent || agent.kind !== 'agent') return failure('Agent not found.', 404);
    if (typeof all_channels !== 'boolean') return failure('Choose whether this agent can access all channels.');
    if (all_channels === this.allChannels(agent_id)) return json({ all_channels });
    const removed = all_channels ? [] : this.db.all<{ channel_id: string }>('SELECT channel_id FROM channel_members WHERE account_id=? AND access_grant=1', agent_id);
    this.ctx.storage.transactionSync(() => {
      if (all_channels) {
        this.db.run('INSERT INTO agent_channel_access(account_id,granted_by,created_at) VALUES (?,?,?)', agent_id, accountId, Date.now());
        this.db.run(`INSERT OR IGNORE INTO channel_members(channel_id,account_id,access_grant)
          SELECT id, ?, 1 FROM channels WHERE is_dm=0 AND archived_at IS NULL`, agent_id);
      } else {
        this.db.run('DELETE FROM agent_channel_access WHERE account_id=?', agent_id);
        this.db.run('DELETE FROM channel_members WHERE account_id=? AND access_grant=1', agent_id);
        // Watches on channels the agent still belongs to keep running; workspace-wide ones need the grant.
        this.notifications.revokeChannel('*', agent_id);
        for (const row of removed) this.notifications.revokeChannel(row.channel_id, agent_id);
      }
    });
    for (const row of removed) this.sendTo(agent_id, { type: 'channel_access_removed', channel_id: row.channel_id });
    this.broadcast({ type: 'member', member: this.member(agent_id) });
    this.broadcast({ type: 'channels_changed' });
    return json({ all_channels });
  }

  private async pauseAgent({ request, accountId }: RouteContext): Promise<Response> {
    const { agent_id, paused } = await request.json<{ agent_id: string; paused: boolean }>();
    const actor = this.requireMember(accountId);
    if (actor.kind !== 'human') return failure('Only people can pause agents.', 403);
    const agent = this.member(agent_id);
    if (!agent || agent.kind !== 'agent') return failure('Agent not found.', 404);
    if (typeof paused !== 'boolean') return failure('Choose whether the agent is paused.');
    // Any person can stop an agent. Only its owner or a workspace admin can start it again.
    if (!paused && !managesAgent(actor, agent)) return failure('Only the agent owner or a workspace admin can resume this agent.', 403);
    this.db.run('UPDATE members SET paused = ? WHERE account_id = ?', paused ? 1 : 0, agent_id);
    if (paused) this.notifications.pause(agent_id);
    const updated = this.member(agent_id);
    this.broadcast({ type: 'member', member: updated });
    return json(updated);
  }

  private async setApprovalMode({ request, accountId }: RouteContext): Promise<Response> {
    const actor = this.requireMember(accountId);
    if (actor.kind === 'agent') return failure('Only humans can manage agents.', 403);
    const { agent_id, enabled } = await request.json<{ agent_id: string; enabled: boolean }>();
    const agent = this.member(agent_id);
    if (!agent || agent.kind !== 'agent') return failure('Agent not found.', 404);
    if (!managesAgent(actor, agent)) return failure('You cannot manage this agent.', 403);
    if (typeof enabled !== 'boolean') return failure('Choose whether posts require approval.');
    this.db.run('UPDATE members SET approval_mode = ? WHERE account_id = ?', enabled ? 1 : 0, agent_id);
    const updated = this.member(agent_id);
    this.broadcast({ type: 'member', member: updated });
    return json(updated);
  }

  // Which channels wake an agent, and how. The Worker encodes both ids in the path.
  private showListening({ params: { agent: agentId }, accountId }: RouteContext): Response {
    return json({ channels: this.notifications.inbox.settings(this.requireMember(accountId), agentId) });
  }

  private async setListening({ request, params: { agent: agentId, channel: channelId }, accountId }: RouteContext): Promise<Response> {
    const viewer = this.requireMember(accountId);
    this.notifications.inbox.set(viewer, agentId, channelId, await request.json());
    return json({ channels: this.notifications.inbox.settings(viewer, agentId) });
  }

  private showAgentActivity({ params, accountId }: RouteContext): Response {
    const actor = this.requireMember(accountId);
    const agent = this.member(params.agent);
    if (!agent || agent.kind !== 'agent') return failure('Agent not found.', 404);
    if (!managesAgent(actor, agent)) return failure('You cannot view this agent activity.', 403);
    return json({ agent_id: agent.account_id, owner_id: agent.owner_id, last_active_at: agent.last_active_at ?? null,
      entries: this.db.all<Row>(`SELECT a.*, f.filename AS target_name FROM agent_activity a
        LEFT JOIN attachments f ON a.action = 'get_attachment' AND f.id = a.target_id
        WHERE a.agent_id = ? ORDER BY a.id DESC LIMIT 100`, agent.account_id) });
  }

  // The agent's inbox webhook (inbox-webhooks.ts checks who may manage it).
  private showWebhook({ params, accountId }: RouteContext): Response {
    return json(this.notifications.webhooks.status(this.requireMember(accountId), params.agent));
  }

  private async setWebhook({ request, params, accountId }: RouteContext): Promise<Response> {
    const input = await request.json<{ url?: unknown; secret?: unknown }>().catch(() => ({}));
    return json(await this.notifications.webhooks.save(this.requireMember(accountId), params.agent, input));
  }

  private removeWebhook({ params, accountId }: RouteContext): Response {
    return json(this.notifications.webhooks.remove(this.requireMember(accountId), params.agent));
  }

  // Proposed posts are reviewed by a person who owns the agent or administers the workspace.
  private reviewableAgent(agentId: string, accountId: string): Member {
    const actor = this.requireMember(accountId);
    const agent = this.member(agentId);
    if (!agent || agent.kind !== 'agent') throw notFound('Agent');
    if (!managesAgent(actor, agent)) throw forbidden('You cannot review this agent.');
    return agent;
  }

  private listPendingPosts({ params, accountId }: RouteContext): Response {
    const agent = this.reviewableAgent(params.agent, accountId);
    const pending = this.db.all<PendingAgentPost>("SELECT * FROM pending_agent_posts WHERE agent_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 20", agent.account_id);
    return json(pending.map((item) => ({ ...item, attachment_names: (JSON.parse(item.attachment_ids) as string[]).map((id) => this.db.one<{ filename: string }>('SELECT filename FROM attachments WHERE id = ? AND uploader_id = ?', id, agent.account_id)?.filename ?? 'File') })));
  }

  private async decidePendingPost({ request, params, accountId }: RouteContext): Promise<Response> {
    const agent = this.reviewableAgent(params.agent, accountId);
    // Decide before loading the post, so two concurrent approvals cannot both see it pending.
    const { decision } = await request.json<{ decision: 'approve' | 'reject' }>();
    const queued = this.db.one<PendingAgentPost>('SELECT * FROM pending_agent_posts WHERE id = ? AND agent_id = ?', params.post, agent.account_id);
    if (!queued || queued.status !== 'pending') return failure('Proposed post is no longer pending.', 404);
    if (decision === 'reject') {
      this.db.run("UPDATE pending_agent_posts SET status = 'rejected' WHERE id = ?", queued.id);
      if (agent.owner_id) this.sendTo(agent.owner_id, { type: 'agent_pending', agent_id: agent.account_id });
      return json({ id: queued.id, status: 'rejected' });
    }
    if (decision !== 'approve') return failure('Choose approve or reject.');
    const posted = this.post(agent.account_id, { channel_id: queued.channel_id, thread_id: queued.thread_id, body: queued.body,
      client_id: queued.client_id ?? undefined, attachment_ids: JSON.parse(queued.attachment_ids) as string[], approved: true });
    if ('pending' in posted) throw new Error('Could not approve this post.');
    this.db.run("UPDATE pending_agent_posts SET status = 'approved', posted_id = ? WHERE id = ?", posted.id, queued.id);
    this.recordAgentActivity(agent.account_id, 'post_message', posted.channel_id, posted.thread_id ?? posted.id, false);
    if (agent.owner_id) this.sendTo(agent.owner_id, { type: 'agent_pending', agent_id: agent.account_id });
    return json({ id: queued.id, status: 'approved', message: posted });
  }

  private pendingPostFile({ params, accountId }: RouteContext): Response {
    const agent = this.reviewableAgent(params.agent, accountId);
    const queued = this.db.one<PendingAgentPost>('SELECT * FROM pending_agent_posts WHERE id = ? AND agent_id = ? AND status = ?', params.post, agent.account_id, 'pending');
    if (!queued || !(JSON.parse(queued.attachment_ids) as string[]).includes(params.file)) return failure('Proposed file not found.', 404);
    const file = this.db.one<Attachment & { r2_key: string }>('SELECT * FROM attachments WHERE id = ? AND channel_id = ? AND uploader_id = ? AND message_id IS NULL', params.file, queued.channel_id, agent.account_id);
    return file ? json(file) : failure('Proposed file not found.', 404);
  }

  // The agent itself asks whether a post it proposed went out.
  private pendingPostStatus({ params, accountId }: RouteContext): Response {
    const actor = this.requireMember(accountId);
    if (actor.kind !== 'agent') return failure('Only agents can check their proposed posts.', 403);
    const pending = this.db.one<PendingAgentPost>('SELECT * FROM pending_agent_posts WHERE id = ? AND agent_id = ?', params.post, accountId);
    if (!pending) return failure('Proposed post not found.', 404);
    return json({ id: pending.id, status: pending.status, message_id: pending.posted_id });
  }

  private showSnapshot({ accountId }: RouteContext): Response {
    this.requireMember(accountId);
    return json({ channels: this.listChannels(accountId), members: this.listMembers(), former_members: this.listFormerMembers() });
  }

  // Recent threads and the work links shared in the account's channels.
  private showOverview({ accountId }: RouteContext): Response {
    this.requireMember(accountId);
    const threads = this.db.all<Row>(`
      SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, c.name AS channel_name, c.is_dm,
        COUNT(r.id) AS reply_count, MAX(r.created_at) AS updated_at
      FROM messages m JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.account_id = ?
      JOIN channels c ON c.id = m.channel_id AND c.archived_at IS NULL
      JOIN messages r ON r.thread_id = m.id AND r.deleted_at IS NULL
      WHERE m.thread_id IS NULL AND m.deleted_at IS NULL GROUP BY m.id ORDER BY updated_at DESC LIMIT 100`, accountId);
    const messages = this.db.all<{ id: string; channel_id: string; channel_name: string; is_dm: number; thread_id: string | null; body: string; created_at: number }>(`
      SELECT m.id, m.channel_id, c.name AS channel_name, c.is_dm, m.thread_id, m.body, m.created_at FROM messages m
      JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.account_id = ?
      JOIN channels c ON c.id = m.channel_id AND c.archived_at IS NULL
      WHERE m.deleted_at IS NULL AND m.body LIKE '%https://%' ORDER BY m.created_at DESC LIMIT 500`, accountId);
    const seen = new Set<string>();
    const links = messages.flatMap((message) => workLinks(message.body).filter((link) => {
      if (seen.has(link.url)) return false;
      seen.add(link.url); return true;
    }).map((link) => ({ ...link, message_id: message.id, thread_id: message.thread_id, channel_id: message.channel_id, channel_name: message.channel_name, is_dm: message.is_dm, created_at: message.created_at })));
    return json({ threads, links });
  }

  // Agent rate limits and turn caps are for workspace owners and admins.
  private settingsAdmin(accountId: string): void {
    const actor = this.requireMember(accountId);
    if (actor.kind !== 'human' || actor.role === 'member') throw forbidden('Only workspace admins can manage settings.');
  }

  private showSettings({ accountId }: RouteContext): Response {
    this.settingsAdmin(accountId);
    return json(this.agentLimits());
  }

  private async saveSettings({ request, accountId }: RouteContext): Promise<Response> {
    this.settingsAdmin(accountId);
    const input = await request.json<{ rate_per_minute?: number; turn_cap?: number }>();
    if (!Number.isInteger(input.rate_per_minute) || input.rate_per_minute! < 1 || input.rate_per_minute! > 100) return failure('Choose 1 to 100 agent messages per minute.');
    if (!Number.isInteger(input.turn_cap) || input.turn_cap! < 1 || input.turn_cap! > 50) return failure('Choose 1 to 50 agent messages per turn.');
    this.db.run(`INSERT INTO meta (key, value) VALUES ('agent_rate_limit', ?), ('agent_turn_cap', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(input.rate_per_minute), String(input.turn_cap));
    this.broadcast({ type: 'settings_changed' });
    return json(this.agentLimits());
  }

  private searchMessages({ url, accountId }: RouteContext): Response {
    this.requireMember(accountId);
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    const channelId = url.searchParams.get('channel') ?? '';
    if (query.length < 2) return failure('Search for at least two characters.');
    if (channelId) this.requireChannel(channelId, accountId);
    const matches = this.db.all<ChatMessage & { channel_name: string; author_name: string; author_kind: string }>(`SELECT m.*, c.name AS channel_name,
      COALESCE(a.name, f.name, 'Former member') AS author_name,
      COALESCE(a.kind, f.kind, 'unknown') AS author_kind FROM messages m
      JOIN channels c ON c.id = m.channel_id AND c.archived_at IS NULL
      JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.account_id = ?
      LEFT JOIN members a ON a.account_id = m.author_id
      LEFT JOIN former_members f ON f.account_id = m.author_id
      WHERE m.deleted_at IS NULL AND instr(lower(m.body), lower(?)) > 0 AND (? = '' OR m.channel_id = ?)
      ORDER BY m.id DESC LIMIT 50`, accountId, query, channelId, channelId);
    return json(matches.map(({ author_name, author_kind, ...message }) => ({ ...message,
      author: { account_id: message.author_id, name: author_name, kind: author_kind } })));
  }

  // Messages, channels, boards, cards and documents in one ranked search.
  private workspaceSearch({ url, accountId }: RouteContext): Response {
    this.requireMember(accountId);
    const channelId = url.searchParams.get('channel') || undefined;
    if (channelId) this.requireChannel(channelId, accountId);
    const numeric = (key: string) => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined;
    return json(searchWorkspace(this.ctx.storage.sql, accountId, {
      query: url.searchParams.get('q') ?? '', channelId,
      kinds: url.searchParams.has('kinds') ? url.searchParams.get('kinds')!.split(',') as SearchOptions['kinds'] : [...searchKinds],
      taskState: (url.searchParams.get('task_state') ?? undefined) as SearchOptions['taskState'],
      after: numeric('after'), before: numeric('before'), limit: numeric('limit'), offset: numeric('offset'),
    }));
  }

  // Channels, then boards, cards and documents, whose names match a # reference being typed.
  private mentionSearch({ url, accountId }: RouteContext): Response {
    this.requireMember(accountId);
    const parsed = parseSearchQuery((url.searchParams.get('q') ?? '').trim().replace(/^#/, '').slice(0, 80));
    const query = parsed.text.toLowerCase();
    type MentionItem = { kind: 'channel' | 'board' | 'task' | 'document'; id: string; name: string; description: string; channel_id: string; channel_name: string; board_id?: string };
    const channels = this.db.all<MentionItem>(
      `SELECT 'channel' AS kind, c.id, c.name, c.description, c.id AS channel_id, c.name AS channel_name FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
       WHERE cm.account_id = ? AND c.archived_at IS NULL AND c.is_dm = 0 AND instr(lower(c.name), ?) > 0
       ORDER BY CASE WHEN instr(lower(c.name), ?) = 1 THEN 0 ELSE 1 END, c.name LIMIT ?`,
      accountId, query, query, query.length >= 2 ? 6 : 12);
    if (query.length < 2) return json(channels);
    const work = searchWorkspace(this.ctx.storage.sql, accountId, {
      query: `${query}*`, kinds: ['board', 'task', 'document'], taskState: parsed.state, limit: 6,
    }).items.map((item) => ({ kind: item.kind, id: item.id, name: item.title,
      description: item.status ? `Status: ${item.status}` : '', channel_id: item.channel_id,
      channel_name: item.channel_name, ...(item.board_id ? { board_id: item.board_id } : {}) }));
    return json([...channels, ...work].slice(0, 12));
  }

  private async createChannel({ request, accountId }: RouteContext): Promise<Response> {
    this.requireWorkWriter(accountId);
    const input = await request.json<{ name: string; description?: string; is_private?: boolean }>();
    const name = this.channelName(input.name);
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO channels (id, name, description, is_private, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, (input.description ?? '').slice(0, 300), input.is_private ? 1 : 0, accountId, Date.now());
    this.db.run('INSERT OR IGNORE INTO channel_members (channel_id, account_id) VALUES (?, ?)', id, accountId);
    this.db.run('UPDATE channel_members SET access_grant=0 WHERE channel_id=? AND account_id=?', id, accountId);
    const creator = this.member(accountId);
    if (creator?.kind === 'agent' && creator.owner_id && this.member(creator.owner_id)) {
      this.db.run('INSERT OR IGNORE INTO channel_members (channel_id, account_id) VALUES (?, ?)', id, creator.owner_id);
    }
    this.broadcast({ type: 'channels_changed' });
    return json({ id, name });
  }

  // The DM between two members, created the first time either opens it.
  private async openDm({ request, accountId }: RouteContext): Promise<Response> {
    this.requireWorkWriter(accountId);
    const { other_id } = await request.json<{ other_id: string }>();
    const other = this.member(other_id);
    if (!other || other.account_id === accountId) throw new Error('Choose another workspace member.');
    const dmKey = [accountId, other.account_id].sort().join(':');
    const existing = this.db.one<{ id: string }>('SELECT id FROM channels WHERE dm_key = ? AND archived_at IS NULL', dmKey);
    if (existing) return json(existing);
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO channels (id, name, description, is_private, is_dm, dm_key, created_by, created_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?)', id, `dm-${id}`, '', dmKey, accountId, Date.now());
    this.db.run('INSERT INTO channel_members (channel_id, account_id) VALUES (?, ?), (?, ?)', id, accountId, id, other.account_id);
    this.broadcast({ type: 'channels_changed' }, [accountId, other.account_id]);
    return json({ id }, 201);
  }

  private joinChannel({ params: { channel: channelId }, accountId }: RouteContext): Response {
    const channel = this.liveChannel(channelId);
    this.requireWorkWriter(accountId);
    if (channel.is_private) throw new Error('This is a private channel.');
    this.db.run('INSERT OR IGNORE INTO channel_members (channel_id, account_id) VALUES (?, ?)', channelId, accountId);
    this.broadcast({ type: 'channels_changed' });
    return json({ ok: true });
  }

  private leaveChannel({ params: { channel: channelId }, accountId }: RouteContext): Response {
    const channel = this.liveChannel(channelId);
    if (this.allChannels(accountId) && !channel.is_dm) return failure('Turn off all-channel access before leaving a channel.');
    this.requireWorkWriter(accountId);
    this.requireChannel(channelId, accountId);
    if (channel.is_dm) throw new Error('Direct messages cannot be left.');
    if (channel.name === 'general') throw forbidden('You cannot leave the general channel.');
    this.db.run('DELETE FROM channel_members WHERE channel_id = ? AND account_id = ?', channelId, accountId);
    this.notifications.revokeChannel(channelId, accountId);
    this.broadcast({ type: 'channels_changed' });
    return json({ ok: true });
  }

  // Renaming and archiving take write access and the right to manage the channel; DMs allow neither.
  private manageableChannel(channelId: string, accountId: string): Row {
    const channel = this.liveChannel(channelId);
    this.requireWorkWriter(accountId);
    const { member: actor } = this.requireChannel(channelId, accountId);
    if (channel.is_dm) throw new Error('Direct messages cannot be renamed or archived.');
    if (!this.canManageChannel(channel, actor)) throw forbidden('Only the channel creator or a workspace admin can rename or archive it.');
    return channel;
  }

  private async renameChannel({ request, params: { channel: channelId }, accountId }: RouteContext): Promise<Response> {
    const channel = this.manageableChannel(channelId, accountId);
    if (channel.name === 'general') throw new Error('The general channel cannot be renamed.');
    const { name } = await request.json<{ name: unknown }>();
    this.db.run('UPDATE channels SET name = ? WHERE id = ?', this.channelName(name, channelId), channelId);
    this.broadcast({ type: 'channels_changed' });
    return json({ ok: true });
  }

  private archiveChannel({ params: { channel: channelId }, accountId }: RouteContext): Response {
    const channel = this.manageableChannel(channelId, accountId);
    if (channel.name === 'general') throw new Error('The general channel cannot be archived.');
    this.db.run('UPDATE channels SET archived_at = ? WHERE id = ?', Date.now(), channelId);
    this.notifications.revokeChannel(channelId);
    this.broadcast({ type: 'channels_changed' });
    return json({ ok: true });
  }

  private listChannelMembers({ params: { channel: channelId }, accountId }: RouteContext): Response {
    this.requireLiveChannel(channelId, accountId);
    return json(this.db.all<Member & { muted: number }>('SELECT m.*, cm.muted FROM members m JOIN channel_members cm ON cm.account_id = m.account_id WHERE cm.channel_id = ? ORDER BY m.kind, m.name', channelId));
  }

  private async addChannelMember({ request, params: { channel: channelId }, accountId }: RouteContext): Promise<Response> {
    const { channel, member: actor } = this.requireLiveChannel(channelId, accountId);
    if (channel.is_dm) throw new Error('Direct messages have fixed participants.');
    if (actor.kind === 'agent') throw new Error('Agents cannot add members.');
    const { agent_id, account_id } = await request.json<{ agent_id?: string; account_id?: string }>();
    if (Boolean(agent_id) === Boolean(account_id)) return failure('Choose one workspace member.');
    const target = this.member(agent_id ?? account_id ?? '');
    if (!target || (agent_id && target.kind !== 'agent') || (account_id && target.kind !== 'human')) return failure('Workspace member not found.', 404);
    if (target.kind === 'agent' && !managesAgent(actor, target)) throw forbidden('You cannot add this agent.');
    if (this.channelMember(channelId, target.account_id)) {
      this.db.run('UPDATE channel_members SET access_grant=0 WHERE channel_id=? AND account_id=?', channelId, target.account_id);
      return json({ ok: true, already_member: true });
    }
    this.db.run('INSERT INTO channel_members (channel_id, account_id) VALUES (?, ?)', channelId, target.account_id);
    this.broadcast({ type: 'channels_changed' }, this.channelRecipients(channelId));
    return json({ ok: true, account_id: target.account_id });
  }

  private removeChannelMember({ params: { channel: channelId, member: targetId }, accountId }: RouteContext): Response {
    const { channel, member: actor } = this.requireChannel(channelId, accountId);
    if (actor.kind !== 'human') return failure('Only a person can manage channel members.', 403);
    if (channel.is_dm || channel.name === 'general') return failure('Members cannot be removed from this conversation.', 403);
    if (targetId === accountId) return failure('Use Leave channel to remove yourself.');
    const target = this.member(targetId);
    if (!target || !this.channelMember(channelId, targetId)) return failure('This person is not in the channel.', 404);
    if (this.allChannels(targetId) && !channel.is_dm) return failure('Turn off all-channel access before removing this agent from a channel.');
    if (!this.canManageChannel(channel, actor) && !(target.kind === 'agent' && target.owner_id === accountId)) return failure('Only a channel creator or workspace admin can remove a member.', 403);
    this.db.run('DELETE FROM channel_members WHERE channel_id = ? AND account_id = ?', channelId, targetId);
    this.notifications.revokeChannel(channelId, targetId);
    this.sendTo(targetId, { type: 'channel_access_removed', channel_id: channelId });
    this.broadcast({ type: 'channels_changed' }, [...new Set([...this.channelRecipients(channelId), targetId])]);
    return json({ ok: true });
  }

  private async muteAgent({ request, params: { channel: channelId }, accountId }: RouteContext): Promise<Response> {
    const actor = this.requireLiveChannel(channelId, accountId).member;
    if (actor.kind === 'agent') throw new Error('Agents cannot mute other agents.');
    const { agent_id, muted } = await request.json<{ agent_id: string; muted: boolean }>();
    if (typeof muted !== 'boolean') throw new Error('Choose whether to mute this agent.');
    const agent = this.member(agent_id);
    if (!agent || agent.kind !== 'agent' || !this.channelMember(channelId, agent_id)) throw new HttpError(404, 'Agent not found in this channel.');
    if (!managesAgent(actor, agent)) throw forbidden('You cannot manage this agent.');
    this.db.run('UPDATE channel_members SET muted = ? WHERE channel_id = ? AND account_id = ?', muted ? 1 : 0, channelId, agent_id);
    this.broadcast({ type: 'channels_changed' });
    return json({ agent_id, channel_id: channelId, muted });
  }

  private async setChannelNotify({ request, params: { channel: channelId }, accountId }: RouteContext): Promise<Response> {
    this.requireLiveChannel(channelId, accountId);
    const { notify } = await request.json<{ notify: string }>();
    if (!['all', 'mentions', 'none'].includes(notify)) return failure('Choose a notification setting.');
    this.db.run('UPDATE channel_members SET notify = ? WHERE channel_id = ? AND account_id = ?', notify, channelId, accountId);
    this.sendTo(accountId, { type: 'channel_notify', channel_id: channelId, notify: notify as Channel['notify'] });
    return json({ channel_id: channelId, notify });
  }

  // The Worker asks before it stores a file for a channel. Any method.
  private checkChannelAccess({ params: { channel: channelId }, accountId }: RouteContext): Response {
    this.requireLiveChannel(channelId, accountId);
    return json({ ok: true });
  }

  private readMessages({ url, params: { channel: channelId }, accountId }: RouteContext): Response {
    this.liveChannel(channelId);
    return json(this.getMessages(channelId, accountId, url.searchParams.get('before') ?? undefined, url.searchParams.get('thread') ?? undefined, Number(url.searchParams.get('limit') ?? 50)));
  }

  private async postMessage({ request, params: { channel: channelId }, accountId }: RouteContext): Promise<Response> {
    this.liveChannel(channelId);
    const input = await request.json<{ body: string; thread_id?: string; client_id?: string; attachment_ids?: string[] }>();
    // Name each field: `approved` is internal and must never come from a request body.
    return json(this.post(accountId, { channel_id: channelId, body: input.body, thread_id: input.thread_id, client_id: input.client_id, attachment_ids: input.attachment_ids }));
  }

  private async markChannelRead({ request, params: { channel: channelId }, accountId }: RouteContext): Promise<Response> {
    this.liveChannel(channelId);
    const { message_id } = await request.json<{ message_id: string }>();
    this.markRead(accountId, channelId, message_id);
    return json({ ok: true });
  }

  private async markThreadRead({ request, params: { channel: channelId, thread: threadId }, accountId }: RouteContext): Promise<Response> {
    this.requireChannel(channelId, accountId);
    if (!this.db.one('SELECT id FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL AND deleted_at IS NULL', threadId, channelId)) return failure('Thread not found.', 404);
    const { message_id } = await request.json<{ message_id: string }>();
    if (!this.db.one('SELECT id FROM messages WHERE id = ? AND channel_id = ? AND (id = ? OR thread_id = ?)', message_id, channelId, threadId, threadId)) return failure('Message not found in thread.', 404);
    this.db.run(`INSERT INTO thread_reads (thread_id, account_id, last_read_id) VALUES (?, ?, ?)
      ON CONFLICT(thread_id, account_id) DO UPDATE SET last_read_id = MAX(thread_reads.last_read_id, excluded.last_read_id)`, threadId, accountId, message_id);
    this.sendTo(accountId, { type: 'thread_read', channel_id: channelId, thread_id: threadId, message_id });
    return json({ ok: true });
  }

  // One message with its author, reply count and link, for MCP tools and Artifacts links.
  private readMessage({ params, accountId }: RouteContext): Response {
    this.requireMember(accountId);
    const message = this.db.one<ChatMessage>(`SELECT m.* FROM messages m JOIN channel_members cm ON cm.channel_id=m.channel_id
      JOIN channels c ON c.id=m.channel_id WHERE m.id=? AND cm.account_id=? AND c.archived_at IS NULL AND m.deleted_at IS NULL`, params.message, accountId);
    if (!message) return failure('Message not found.', 404);
    const author = this.member(message.author_id);
    const replyCount = this.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM messages WHERE thread_id=? AND deleted_at IS NULL', message.thread_id ?? message.id)?.count ?? 0;
    const workspaceId = this.db.meta('workspace_id') ?? '';
    return json({ ...this.messageWithAttachments(message), reply_count: replyCount,
      author: { account_id: message.author_id, name: author?.name ?? 'Former member', kind: author?.kind ?? 'unknown' },
      url: `${this.env.APP_ORIGIN}/w/${encodeURIComponent(workspaceId)}/${encodeURIComponent(message.channel_id)}?thread=${encodeURIComponent(message.thread_id ?? message.id)}` });
  }

  private async editMessage({ request, params, accountId }: RouteContext): Promise<Response> {
    return json(this.updateMessage(accountId, params.message, (await request.json<{ body: string }>()).body));
  }

  private async removeMessage({ params, accountId }: RouteContext): Promise<Response> {
    await this.deleteMessage(accountId, params.message);
    return json({ ok: true });
  }

  private async reactToMessage({ request, params, accountId }: RouteContext): Promise<Response> {
    return json(this.toggleReaction(accountId, params.message, (await request.json<{ emoji: string }>()).emoji));
  }

  // Cards in a channel, for the composer's # suggestions. Open work first, then recent.
  private listChannelTasks({ url, accountId }: RouteContext): Response {
    const channelId = url.searchParams.get('channel') ?? '';
    // Without a channel: the open tasks on every board in the reader's channels, for the Tasks page.
    if (!channelId) {
      this.requireMember(accountId);
      return json(this.db.all<Row>(`SELECT t.id, t.title, t.status, t.priority, t.board_id, b.name AS board_name, b.channel_id, c.name AS channel_name,
        t.assignee_id, t.due_at, t.updated_at FROM tasks t JOIN boards b ON b.id = t.board_id
        JOIN channel_members cm ON cm.channel_id = b.channel_id AND cm.account_id = ? JOIN channels c ON c.id = b.channel_id AND c.archived_at IS NULL
        WHERE t.status != 'done' ORDER BY t.updated_at DESC LIMIT 300`, accountId));
    }
    this.requireChannel(channelId, accountId);
    return json(this.db.all<Row>(`SELECT t.id, t.title, t.status, t.board_id, b.name AS board_name, t.assignee_id, t.updated_at FROM tasks t JOIN boards b ON b.id = t.board_id
      WHERE b.channel_id = ? ORDER BY (t.status = 'done'), t.updated_at DESC LIMIT 300`, channelId));
  }

  private listBoards({ url, accountId }: RouteContext): Response {
    const channelId = url.searchParams.get('channel') ?? '';
    if (channelId) {
      this.requireChannel(channelId, accountId);
      return json(this.db.all<Row>('SELECT * FROM boards WHERE channel_id = ? ORDER BY created_at', channelId));
    }
    this.requireMember(accountId);
    return json(this.db.all<Row>(`SELECT b.*, c.name AS channel_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.status = 'done') AS completed_count
      FROM boards b JOIN channel_members cm ON cm.channel_id = b.channel_id AND cm.account_id = ?
      JOIN channels c ON c.id = b.channel_id AND c.archived_at IS NULL ORDER BY b.created_at DESC`, accountId));
  }

  private async createBoard({ request, accountId }: RouteContext): Promise<Response> {
    this.requireWorkWriter(accountId);
    const input = await request.json<{ channel_id: string; name: string }>();
    this.requireChannel(input.channel_id, accountId);
    const name = input.name?.trim().slice(0, 90);
    if (!name || name.length < 2) throw new Error('Board name is too short.');
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO boards (id, channel_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)', id, input.channel_id, name, accountId, Date.now());
    this.broadcast({ type: 'board_changed', channel_id: input.channel_id, board_id: id }, this.channelRecipients(input.channel_id));
    return json({ id, channel_id: input.channel_id, name }, 201);
  }

  // A board, if the account belongs to its channel.
  private channelBoard(boardId: string, accountId: string): Row {
    const board = this.db.one<Row>('SELECT * FROM boards WHERE id = ?', boardId);
    if (!board) throw notFound('Board');
    this.requireChannel(String(board.channel_id), accountId);
    return board;
  }

  private showBoard({ params, accountId }: RouteContext): Response {
    const board = this.channelBoard(params.board, accountId);
    return json({ ...board, tasks: this.db.all<Row>("SELECT t.*, (SELECT COUNT(*) FROM message_references r WHERE r.kind = 'task' AND r.target_id = t.id) AS reference_count FROM tasks t WHERE t.board_id = ? ORDER BY t.created_at", board.id) });
  }

  private async createTask({ request, params, accountId }: RouteContext): Promise<Response> {
    const board = this.channelBoard(params.board, accountId);
    this.requireWorkWriter(accountId);
    const input = await request.json<TaskInput & { client_id?: string }>();
    const creationRequest = { board_id: board.id, ...input };
    const existing = this.existingWorkCreation(accountId, 'create_task', input.client_id, creationRequest);
    if (existing) return json(existing, 201);
    const now = Date.now();
    const fields = this.taskInput(input, String(board.channel_id), now);
    const id = crypto.randomUUID();
    const task = this.ctx.storage.transactionSync(() => {
      this.db.run('INSERT INTO tasks (id, board_id, title, description, status, priority, assignee_id, due_at, created_by, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, board.id, fields.title, fields.description, fields.status, fields.priority, fields.assignee_id, fields.due_at, accountId, now, now, fields.completed_at);
      const created = this.db.one<Row>('SELECT * FROM tasks WHERE id = ?', id)!;
      this.emitWorkEvent('task.created', String(board.channel_id), accountId, created);
      this.rememberWorkCreation(accountId, 'create_task', input.client_id, creationRequest, created);
      return created;
    });
    this.broadcast({ type: 'board_changed', channel_id: String(board.channel_id), board_id: String(board.id) }, this.channelRecipients(String(board.channel_id)));
    return json(task, 201);
  }

  // A card and its board, if the account belongs to the board's channel.
  private channelTask(taskId: string, accountId: string): { task: Row; board: Row } {
    const task = this.db.one<Row>('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!task) throw notFound('Task');
    const board = this.db.one<Row>('SELECT * FROM boards WHERE id = ?', String(task.board_id));
    if (!board) throw notFound('Board');
    this.requireChannel(String(board.channel_id), accountId);
    return { task, board };
  }

  private showTask({ params, accountId }: RouteContext): Response {
    const { task, board } = this.channelTask(params.task, accountId);
    return json({ ...task, channel_id: board.channel_id, references: this.taskReferences(String(task.id), accountId) });
  }

  private async updateTask({ request, params, accountId }: RouteContext): Promise<Response | undefined> {
    // Read the body before the row: other requests run while a body arrives, so a row read first could be stale.
    const input = await request.json<TaskInput>();
    const { task, board } = this.channelTask(params.task, accountId);
    if (!input) return; // JSON null is not an update, so it gets the 404 an unsupported request does.
    this.requireWorkWriter(accountId);
    const now = Date.now();
    const fields = this.taskInput(input, String(board.channel_id), now, task);
    const updated = this.ctx.storage.transactionSync(() => {
      this.db.run('UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, due_at = ?, updated_at = ?, completed_at = ? WHERE id = ?', fields.title, fields.description, fields.status, fields.priority, fields.assignee_id, fields.due_at, now, fields.completed_at, task.id);
      const row = this.db.one<Row>('SELECT * FROM tasks WHERE id = ?', String(task.id))!;
      this.emitWorkEvent('task.updated', String(board.channel_id), accountId, row, task);
      return row;
    });
    this.broadcast({ type: 'board_changed', channel_id: String(board.channel_id), board_id: String(board.id) }, this.channelRecipients(String(board.channel_id)));
    return json(updated);
  }

  private deleteTask({ params, accountId }: RouteContext): Response {
    const { task, board } = this.channelTask(params.task, accountId);
    this.requireWorkWriter(accountId);
    if (this.db.one('SELECT 1 FROM project_runs WHERE task_id=? LIMIT 1',task.id)) throw new Error('Keep this task to preserve its code and review history.');
    this.ctx.storage.transactionSync(() => {
      this.db.run('DELETE FROM tasks WHERE id = ?', task.id);
      this.db.run("DELETE FROM message_references WHERE kind = 'task' AND target_id = ?", task.id);
      this.emitWorkEvent('task.deleted', String(board.channel_id), accountId, task);
    });
    this.broadcast({ type: 'board_changed', channel_id: String(board.channel_id), board_id: String(board.id) }, this.channelRecipients(String(board.channel_id)));
    return json({ ok: true });
  }

  private checkBoard({ params, accountId }: RouteContext): undefined {
    this.channelBoard(params.board, accountId);
  }

  private checkTask({ params, accountId }: RouteContext): undefined {
    this.channelTask(params.task, accountId);
  }

  private listDocuments({ url, accountId }: RouteContext): Response {
    const channelId = url.searchParams.get('channel') ?? '';
    if (channelId) {
      this.requireChannel(channelId, accountId);
      return json(this.db.all<Row>('SELECT id, channel_id, title, created_by, updated_by, created_at, updated_at FROM documents WHERE channel_id = ? ORDER BY updated_at DESC', channelId));
    }
    this.requireMember(accountId);
    return json(this.db.all<Row>(`SELECT d.id, d.channel_id, d.title, d.created_by, d.updated_by, d.created_at, d.updated_at, c.name AS channel_name
      FROM documents d JOIN channel_members cm ON cm.channel_id = d.channel_id AND cm.account_id = ?
      JOIN channels c ON c.id = d.channel_id AND c.archived_at IS NULL ORDER BY d.updated_at DESC`, accountId));
  }

  private async createDocument({ request, accountId }: RouteContext): Promise<Response> {
    this.requireWorkWriter(accountId);
    const input = await request.json<{ channel_id: string; title: string; body?: string; client_id?: string }>();
    this.requireChannel(input.channel_id, accountId);
    const existing = this.existingWorkCreation(accountId, 'create_document', input.client_id, input);
    if (existing) return json(existing, 201);
    const { title, body } = this.documentInput(input);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.db.run('INSERT INTO documents (id, channel_id, title, body, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, input.channel_id, title, body, accountId, accountId, now, now);
      this.emitWorkEvent('document.created', input.channel_id, accountId, { id, title });
      this.rememberWorkCreation(accountId, 'create_document', input.client_id, input, this.db.one<Row>('SELECT * FROM documents WHERE id = ?', id)!);
    });
    this.broadcast({ type: 'document_changed', channel_id: input.channel_id, document_id: id }, this.channelRecipients(input.channel_id));
    return json(this.db.one<Row>('SELECT * FROM documents WHERE id = ?', id), 201);
  }

  // A document, if the account belongs to its channel.
  private channelDocument(documentId: string, accountId: string): Row {
    const document = this.db.one<Row>('SELECT * FROM documents WHERE id = ?', documentId);
    if (!document) throw notFound('Document');
    this.requireChannel(String(document.channel_id), accountId);
    return document;
  }

  private showDocument({ params, accountId }: RouteContext): Response {
    return json(this.channelDocument(params.document, accountId));
  }

  private async updateDocument({ request, params, accountId }: RouteContext): Promise<Response | undefined> {
    // Read the body before the row, as for tasks.
    const input = await request.json<{ title?: string; body?: string }>();
    const document = this.channelDocument(params.document, accountId);
    if (!input) return; // JSON null is not an update, so it gets the 404 an unsupported request does.
    this.requireWorkWriter(accountId);
    const { title, body } = this.documentInput(input, document);
    this.ctx.storage.transactionSync(() => {
      this.db.run('UPDATE documents SET title = ?, body = ?, updated_by = ?, updated_at = ? WHERE id = ?', title, body, accountId, Date.now(), document.id);
      this.emitWorkEvent('document.updated', String(document.channel_id), accountId, { ...document, title, body }, document);
    });
    this.broadcast({ type: 'document_changed', channel_id: String(document.channel_id), document_id: String(document.id) }, this.channelRecipients(String(document.channel_id)));
    return json(this.db.one<Row>('SELECT * FROM documents WHERE id = ?', document.id));
  }

  private deleteDocument({ params, accountId }: RouteContext): Response {
    const document = this.channelDocument(params.document, accountId);
    this.requireWorkWriter(accountId);
    this.ctx.storage.transactionSync(() => {
      this.db.run('DELETE FROM documents WHERE id = ?', document.id);
      this.emitWorkEvent('document.deleted', String(document.channel_id), accountId, document);
    });
    this.broadcast({ type: 'document_changed', channel_id: String(document.channel_id), document_id: String(document.id) }, this.channelRecipients(String(document.channel_id)));
    return json({ ok: true });
  }

  private checkDocument({ params, accountId }: RouteContext): undefined {
    this.channelDocument(params.document, accountId);
  }

  // An upload the Worker stored in R2, kept as the uploader's unsent file until a message claims it.
  private async registerAttachment({ request, params: { channel: channelId }, accountId }: RouteContext): Promise<Response> {
    this.requireLiveChannel(channelId, accountId);
    const attachment = await request.json<{ id: string; kind: string; r2_key: string; mime: string; size: number; filename: string }>();
    this.db.run('INSERT INTO attachments (id, channel_id, uploader_id, kind, r2_key, mime, size, filename, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', attachment.id, channelId, accountId, attachmentKind(attachment.mime), attachment.r2_key, attachment.mime, attachment.size, attachment.filename, Date.now());
    return json({ id: attachment.id });
  }

  // Files posted in the account's channels, newest first, filtered by file or channel name.
  private fileLibrary({ url, accountId }: RouteContext): Response {
    this.requireMember(accountId);
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
    return json(this.db.all<{ id: string; filename: string; kind: string; mime: string; size: number; created_at: number; channel_id: string; channel_name: string }>(`
      SELECT a.id, a.filename, a.kind, a.mime, a.size, a.created_at, a.channel_id, c.name AS channel_name
      FROM attachments a
      JOIN channel_members cm ON cm.channel_id = a.channel_id AND cm.account_id = ?
      JOIN channels c ON c.id = a.channel_id AND c.archived_at IS NULL
      JOIN messages m ON m.id = a.message_id AND m.deleted_at IS NULL
      WHERE (? = '' OR instr(lower(a.filename), lower(?)) > 0 OR instr(lower(c.name), lower(?)) > 0)
      ORDER BY a.created_at DESC LIMIT 100`, accountId, query, query, query).map(normalizeAttachment));
  }

  // Only the uploader can delete a file, and only while no message has claimed it.
  private async deleteUnsentAttachment({ params, accountId }: RouteContext): Promise<Response> {
    const attachment = this.db.one<{ uploader_id: string; message_id: string | null; r2_key: string }>('SELECT uploader_id, message_id, r2_key FROM attachments WHERE id = ?', params.attachment);
    if (!attachment || attachment.uploader_id !== accountId || attachment.message_id) return failure('Attachment not found.', 404);
    this.ctx.storage.transactionSync(() => {
      this.db.run('INSERT OR IGNORE INTO file_deletions (r2_key, next_attempt_at) VALUES (?, ?)', attachment.r2_key, Date.now());
      this.db.run('DELETE FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL', params.attachment, accountId);
    });
    await this.flushFileDeletions();
    return json({ ok: true });
  }

  // A posted file's details, for members of its channel. Any method but DELETE.
  private showAttachment({ params, accountId }: RouteContext): Response {
    const attachment = this.db.one<Attachment & { r2_key: string }>(`SELECT a.* FROM attachments a
      JOIN messages m ON m.id = a.message_id AND m.deleted_at IS NULL WHERE a.id = ?`, params.attachment);
    if (!attachment) return failure('Attachment not found.', 404);
    this.requireChannel(attachment.channel_id, accountId);
    return json(normalizeAttachment(attachment));
  }

  private async registerArtifactRepository({ request, accountId }: RouteContext): Promise<Response> {
    this.requireWorkWriter(accountId);
    const input = await request.json<{ name: string; channel_id: string }>();
    this.requireChannel(input.channel_id, accountId);
    const workspaceId = this.db.meta('workspace_id');
    if (!workspaceId || !input.name?.startsWith(`${workspaceId}-`) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.name)) return failure('Invalid artifact repository.');
    this.db.run('INSERT INTO artifact_repositories(name, channel_id, created_by, created_at) VALUES(?,?,?,?)', input.name, input.channel_id, accountId, Date.now());
    return json({ ok: true });
  }

  private showArtifactRepository({ params, accountId }: RouteContext): Response {
    const repo = this.db.one<{ channel_id: string }>('SELECT channel_id FROM artifact_repositories WHERE name=?', params.repository);
    if (!repo) return failure('Artifact repository not found.', 404);
    this.requireChannel(repo.channel_id, accountId);
    const title = this.projects.repositoryTitle(params.repository);
    return json({ ...repo, managed: title !== null, title });
  }

  // The Worker asks before it creates a repository or a write token for the channel.
  private checkArtifactAccess({ params: { channel: channelId }, accountId }: RouteContext): Response {
    this.requireWorkWriter(accountId);
    this.requireChannel(channelId, accountId);
    return json({ ok: true });
  }

  private projectRoutes({ request, accountId, workspaceId }: RouteContext): Promise<Response> {
    return this.projects.handle(request, accountId, workspaceId ?? this.db.meta('workspace_id') ?? '');
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentOf(socket);
    const accountId = attachment?.accountId;
    if (!accountId) { socket.close(liveLimits.closeInvalid, 'Invalid connection'); return; }
    if (!this.member(accountId)) { socket.close(liveLimits.closeInvalid, 'Access removed'); return; }
    if ((typeof data === 'string' ? data.length : data.byteLength) > liveLimits.clientFrameBytes) {
      socket.send(JSON.stringify({ type: 'error', error: 'Message is too large.' } satisfies ServerFrame));
      return;
    }
    let event: ClientFrame;
    try { event = parseClientFrame(data); }
    catch (cause) {
      socket.send(JSON.stringify({ type: 'error', error: cause instanceof Error && cause.message === 'Unknown event.' ? 'Unknown event.' : 'Invalid event.' } satisfies ServerFrame));
      return;
    }
    const clientId = 'client_id' in event && typeof event.client_id === 'string' ? event.client_id : undefined;
    try {
      if (event.type !== 'sync' && !attachment?.canWrite) throw new Error('This live connection is receive-only. Use authenticated MCP tools to make changes.');
      if (event.type === 'send') {
        const message = this.post(accountId, { channel_id: String(event.channel_id), body: String(event.body ?? ''), thread_id: event.thread_id ? String(event.thread_id) : null, client_id: clientId, attachment_ids: Array.isArray(event.attachment_ids) ? event.attachment_ids.map(String) : [] });
        if ('pending' in message) throw new Error('This post needs approval before it appears.');
        socket.send(JSON.stringify({ type: 'ack', client_id: clientId, message } satisfies ServerFrame));
      } else if (event.type === 'read') {
        this.markRead(accountId, String(event.channel_id), String(event.message_id));
      } else if (event.type === 'typing') {
        const channelId = String(event.channel_id ?? '');
        const actor = this.requireChannel(channelId, accountId).member;
        if (actor.kind !== 'human') throw new Error('Only people can send typing indicators.');
        if (typeof event.active !== 'boolean') throw new Error('Invalid typing indicator.');
        const threadId = event.thread_id ? String(event.thread_id) : null;
        if (threadId && !this.db.one('SELECT id FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL AND deleted_at IS NULL', threadId, channelId)) throw new Error('Thread not found.');
        this.broadcast({ type: 'typing', channel_id: channelId, thread_id: threadId, account_id: accountId, active: event.active }, this.channelRecipients(channelId).filter((id) => id !== accountId));
      } else {
        socket.send(JSON.stringify({ type: 'sync', ...this.syncPage(accountId, String(event.after ?? '')) } satisfies ServerFrame));
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', client_id: clientId, error: error instanceof Error ? error.message : 'Request failed.' } satisfies ServerFrame));
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = attachmentOf(socket);
    if (!attachment) return;
    if (!this.isOnline(attachment.accountId, socket)) this.broadcast({ type: 'presence', account_id: attachment.accountId, kind: attachment.kind, online: false });
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }
}
