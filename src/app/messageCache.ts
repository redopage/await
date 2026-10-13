import type { Channel, ChatMessage, Member } from '../shared/types';

// The workspace snapshot query, kept current by live frames.
export type Snapshot = { channels: Channel[]; members: Member[]; former_members: Member[] };

// Messages are cached per channel, and thread replies per thread.
export function conversationKey(workspaceId: string, message: Pick<ChatMessage, 'channel_id' | 'thread_id'>): unknown[] {
  return message.thread_id ? ['thread', workspaceId, message.channel_id, message.thread_id] : ['messages', workspaceId, message.channel_id];
}

export function lastStoredMessage(messages: ChatMessage[] | undefined): ChatMessage | undefined {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) if (messages?.[index].delivery !== 'sending') return messages?.[index];
  return undefined;
}

// Inserts or replaces a message, dropping the optimistic copy that shares its client_id.
export function mergeMessageList(current: ChatMessage[] | undefined, message: ChatMessage, clientId = message.client_id): ChatMessage[] | undefined {
  if (!current) return current;
  const kept = current.filter((item) => item.id !== message.id && !(item.delivery === 'sending' && clientId && item.client_id === clientId));
  return [...kept, message].sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
}
