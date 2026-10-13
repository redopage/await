import type { Env } from '../worker/env';
import type { EventArguments, EventOccurrence } from '../shared/mcp-events';
import type { Member } from '../shared/types';
import { AgentEvents } from './agent-events';
import { EventSubscriptions } from './event-subscriptions';
import { InboxWebhooks } from './inbox-webhooks';

export type NotificationAccess = {
  member(accountId: string): Member | null;
  // A channel the account can read: joined and not archived, or * with all-channel access.
  channel(channelId: string, accountId: string): boolean;
  // A current, unpaused named agent that can read the channel. Every path checks this.
  recipient(accountId: string, channelId: string): boolean;
  validateFilters(accountId: string, args: EventArguments): void;
  // Wakes held waits and sends the socket's agent_events frame.
  signal(accountId: string): void;
  // Recomputes the alarm once the current request has written its rows.
  schedule(): void;
};

// Every way Await tells a named agent about workspace activity goes through here. A change
// becomes one occurrence, the same recipient and author rules apply to every path, and two
// queues hold the result:
// - the agent inbox (agent-events.ts), the record its owner shapes with listening levels. A held
//   wait_for_events, the socket frame and the inbox webhook (inbox-webhooks.ts) announce it.
// - MCP Events watches (event-subscriptions.ts), which a host subscribes with its own filters.
// Webhooks of both kinds leave the object only through the delivery gateway.
export class Notifications {
  readonly inbox: AgentEvents;
  readonly watches: EventSubscriptions;
  readonly webhooks: InboxWebhooks;
  private schedule: () => void;

  constructor(ctx: DurableObjectState, env: Env, workspace: Omit<NotificationAccess, 'recipient'>) {
    const access: NotificationAccess = { ...workspace, recipient: (accountId, channelId) => {
      const member = workspace.member(accountId);
      return Boolean(member?.kind === 'agent' && !member.paused && workspace.channel(channelId, accountId));
    } };
    this.inbox = new AgentEvents(ctx, { ...access, recorded: (accountId) => { workspace.signal(accountId); this.webhooks.ring(accountId); } });
    this.watches = new EventSubscriptions(ctx, env, access);
    this.webhooks = new InboxWebhooks(ctx, env, { ...access, latest: (accountId) => this.inbox.latest(accountId) });
    this.schedule = workspace.schedule;
  }

  // Call inside the transaction that commits the change, so the queues commit with it.
  emit(...events: EventOccurrence[]): void {
    for (const event of events) { this.watches.emit(event); this.inbox.emit(event); }
    this.schedule();
  }

  // An edit replaces the message's queued snapshots in both queues, then announces the current
  // text. A mention counts as new when the old text lacked it or its wake was still queued.
  editMessage(messageId: string, text: string, occurrence: Omit<EventOccurrence, 'name' | 'mentions'>, previous: Set<string>, current: Set<string>): void {
    const queuedWatches = new Set(this.watches.supersedeMessage(messageId, text.slice(0, 4000), text.length > 4000));
    const queuedInbox = new Set(this.inbox.supersedeMessage(messageId));
    const fresh = (queued: Set<string>) => [...current].filter((id) => !previous.has(id) || queued.has(id));
    this.watches.emit({ ...occurrence, name: 'message.updated' });
    this.watches.emit({ ...occurrence, name: 'message.mentioned', mentions: fresh(queuedWatches) });
    this.inbox.emit({ ...occurrence, name: 'message.updated', mentions: fresh(queuedInbox) });
    this.schedule();
  }

  // Watches skip deleted messages when they deliver; the inbox forgets them now.
  forgetMessage(messageId: string): void { this.inbox.forgetMessage(messageId); }

  // Pausing drops everything queued for the agent. Resuming replays nothing.
  pause(agentId: string): void {
    this.watches.pauseAccount(agentId);
    this.inbox.clear(agentId);
    this.webhooks.clearRing(agentId);
  }

  revokeChannel(channelId: string, accountId?: string): void {
    this.watches.revokeChannel(channelId, accountId);
    this.inbox.revokeChannel(channelId, accountId ?? null);
  }

  revokeAccount(accountId: string): void {
    this.watches.revokeAccount(accountId);
    this.inbox.revokeAccount(accountId);
    this.webhooks.revokeAccount(accountId);
  }

  nextAlarm(): number | null {
    const next = Math.min(this.watches.nextAlarm() ?? Infinity, this.webhooks.nextAlarm() ?? Infinity);
    return Number.isFinite(next) ? next : null;
  }

  async flush(): Promise<void> {
    await this.watches.flush();
    await this.webhooks.flush();
  }
}
