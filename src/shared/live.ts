// The live protocol: one hibernating WebSocket per client per workspace.
// Every frame the Workspace Durable Object sends or accepts is listed here, so the server,
// the web app, the MCP widget and agent hosts share one definition. See docs/live-protocol.md.

import type { Channel, ChatMessage, Member } from './types';

// Frames sent by the server.
export type ServerFrame =
  // Sent once after the socket is accepted. `online_ids` includes connected agent hosts.
  | { type: 'ready'; account_id: string; channels: Channel[]; members: Member[]; former_members: Member[]; online_ids: string[] }
  // Conversation changes in channels the client belongs to.
  | { type: 'message'; message: ChatMessage }
  | { type: 'edit'; message: ChatMessage }
  | { type: 'delete'; message_id: string; channel_id: string }
  | { type: 'reaction'; channel_id: string; message_id: string; thread_id: string | null }
  | { type: 'typing'; channel_id: string; thread_id: string | null; account_id: string; active: boolean }
  // A page of catch-up after `sync`; keep sending `sync` with `after: next` until `done`.
  | { type: 'sync'; messages: ChatMessage[]; next: string | null; done: boolean }
  // Acknowledges a `send` by its client_id.
  | { type: 'ack'; client_id?: string; message: ChatMessage }
  | { type: 'error'; client_id?: string; error: string }
  // Presence for people and agent hosts alike.
  | { type: 'presence'; account_id: string; kind: Member['kind']; online: boolean }
  // Per-client read state.
  | { type: 'read'; channel_id: string; message_id: string }
  | { type: 'thread_read'; channel_id: string; thread_id: string; message_id: string }
  | { type: 'channel_notify'; channel_id: string; notify: Channel['notify'] }
  // Membership and directory changes. `channels_changed` asks the client to refetch its snapshot.
  | { type: 'channels_changed' }
  | { type: 'member'; member: Member | null }
  | { type: 'member_removed'; account_id: string }
  | { type: 'channel_access_removed'; channel_id: string }
  | { type: 'access_removed' }
  | { type: 'settings_changed' }
  // Shared work changed; clients refetch the named board, document or project list.
  | { type: 'board_changed'; channel_id: string; board_id: string }
  | { type: 'document_changed'; channel_id: string; document_id: string }
  | { type: 'projects_changed' }
  // Agent signals: a post awaits approval (sent to the owner), the inbox has events (sent to the agent),
  // or agents in a channel are held until a person replies.
  | { type: 'agent_pending'; agent_id: string; id?: string }
  | { type: 'agent_events' }
  | { type: 'held'; channel_id: string };

export type ServerFrameType = ServerFrame['type'];

// Frames accepted from the client. Ticket sockets may only `sync`.
export type ClientFrame =
  | { type: 'send'; channel_id: string; body: string; thread_id?: string | null; client_id?: string; attachment_ids?: string[] }
  | { type: 'read'; channel_id: string; message_id: string }
  | { type: 'typing'; channel_id: string; thread_id?: string | null; active: boolean }
  | { type: 'sync'; after?: string };

export const clientFrameTypes: readonly ClientFrame['type'][] = ['send', 'read', 'typing', 'sync'];

// Hibernation-safe limits shared by both ends.
export const liveLimits = {
  clientFrameBytes: 65_536,
  syncPageMessages: 100,
  syncPageBytes: 400_000,
  pingAutoResponse: ['ping', 'pong'] as const,
  closeSignedOut: 4001,
  closeInvalid: 4003,
} as const;

export function parseClientFrame(raw: string | ArrayBuffer): ClientFrame {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid event.');
  const frame = parsed as Record<string, unknown>;
  if (!clientFrameTypes.includes(frame.type as ClientFrame['type'])) throw new Error('Unknown event.');
  return frame as ClientFrame;
}
