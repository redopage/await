import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ServerFrame } from '../shared/live';
import type { ChatMessage } from '../shared/types';
import { tagText } from '../shared/tags';
import { navigate } from './api';
import { conversationKey, mergeMessageList, type Snapshot } from './messageCache';

export type TypingEntry = { accountId: string; channelId: string; threadId: string | null };
type Options = {
  workspaceId: string;
  selfId: string;
  queryClient: QueryClient;
  // Called when the current channel is no longer accessible, before navigating away.
  onLeaveChannel: () => void;
  // Called with a short notice the person should see (a socket error, agents being held).
  onNotice: (text: string) => void;
};

// Query keys that depend on channel membership and shared work.
const workKeys = ['workspace-overview', 'boards', 'documents', 'file-library', 'projects', 'project', 'candidate-files'];

// Best effort: iOS Safari has no Notification, and Android Chrome rejects the constructor.
function desktopAlert(title: string, body: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title, { body }); } catch { /* No alert on this browser. */ }
}

// One hibernating socket per workspace. Reconnects with backoff, asks for a paged catch-up from
// the newest message it has seen, and turns every server frame into query-cache updates.
export function useWorkspaceSocket({ workspaceId, selfId, queryClient, onLeaveChannel, onNotice }: Options): {
  socket: WebSocket | null; connected: boolean; onlineIds: Set<string>; typingEntries: Record<string, TypingEntry>; lastId: MutableRefObject<string>;
} {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [typingEntries, setTypingEntries] = useState<Record<string, TypingEntry>>({});
  const typingTimers = useRef<Map<string, number>>(new Map());
  const lastId = useRef('');
  const callbacks = useRef({ onLeaveChannel, onNotice });
  callbacks.current = { onLeaveChannel, onNotice };

  useEffect(() => {
    let stopped = false;
    let current: WebSocket | null = null;
    let timer: number | undefined;
    let snapshotTimer: number | undefined;
    let retry = 0;
    lastId.current = '';
    const invalidate = (...key: unknown[]) => { void queryClient.invalidateQueries({ queryKey: key }); };
    const refreshSnapshot = () => {
      if (snapshotTimer !== undefined) return;
      snapshotTimer = window.setTimeout(() => { snapshotTimer = undefined; invalidate('snapshot', workspaceId); }, 120);
    };
    const refreshLibrary = () => { invalidate('workspace-overview', workspaceId); invalidate('file-library', workspaceId); };
    const refreshConversation = (channelId: string) => { refreshLibrary(); invalidate('messages', workspaceId, channelId); invalidate('thread', workspaceId, channelId); };
    const store = (message: ChatMessage) => {
      if (message.id > lastId.current) lastId.current = message.id;
      queryClient.setQueryData<ChatMessage[]>(conversationKey(workspaceId, message), (old) => mergeMessageList(old, message));
      if (message.thread_id) invalidate('messages', workspaceId, message.channel_id);
    };
    const dropTyping = (key: string) => {
      setTypingEntries((entries) => { const next = { ...entries }; delete next[key]; return next; });
      typingTimers.current.delete(key);
    };
    const reset = () => { setConnected(false); setSocket(null); setOnlineIds(new Set()); setTypingEntries({}); };

    const handlers: { [K in ServerFrame['type']]?: (frame: Extract<ServerFrame, { type: K }>) => void } = {
      ready: (frame) => {
        queryClient.setQueryData<Snapshot>(['snapshot', workspaceId], { channels: frame.channels, members: frame.members, former_members: frame.former_members });
        setOnlineIds(new Set(frame.online_ids));
      },
      presence: (frame) => setOnlineIds((ids) => { const next = new Set(ids); if (frame.online) next.add(frame.account_id); else next.delete(frame.account_id); return next; }),
      typing: (frame) => {
        const key = `${frame.channel_id}|${frame.thread_id ?? ''}|${frame.account_id}`;
        const pending = typingTimers.current.get(key);
        if (pending) window.clearTimeout(pending);
        if (!frame.active) { dropTyping(key); return; }
        setTypingEntries((entries) => ({ ...entries, [key]: { accountId: frame.account_id, channelId: frame.channel_id, threadId: frame.thread_id ?? null } }));
        typingTimers.current.set(key, window.setTimeout(() => dropTyping(key), 4000));
      },
      message: ({ message }) => {
        store(message);
        refreshLibrary();
        refreshSnapshot();
        if (!document.hidden || message.author_id === selfId) return;
        const channel = queryClient.getQueryData<Snapshot>(['snapshot', workspaceId])?.channels.find((item) => item.id === message.channel_id);
        const alerted = channel?.notify === 'all' || (channel?.notify !== 'none' && (channel?.is_dm || message.body.includes(tagText('mention', selfId))));
        if (alerted) desktopAlert(channel?.is_dm ? 'New direct message in Await' : `New message in #${channel?.name ?? 'Await'}`, message.body.slice(0, 180));
      },
      sync: (frame) => {
        for (const message of frame.messages) store(message);
        if (frame.done || !frame.next) return;
        try { current?.send(JSON.stringify({ type: 'sync', after: frame.next })); } catch { /* A closing socket reconnects and resumes from lastId. */ }
      },
      edit: (frame) => refreshConversation(frame.message.channel_id),
      delete: (frame) => refreshConversation(frame.channel_id),
      reaction: (frame) => { invalidate('messages', workspaceId, frame.channel_id); if (frame.thread_id) invalidate('thread', workspaceId, frame.channel_id, frame.thread_id); },
      read: refreshSnapshot,
      thread_read: (frame) => { refreshSnapshot(); invalidate('messages', workspaceId, frame.channel_id); },
      channel_notify: refreshSnapshot,
      member_removed: refreshSnapshot,
      channels_changed: () => { refreshSnapshot(); invalidate('channel-members', workspaceId); for (const key of workKeys) invalidate(key, workspaceId); },
      settings_changed: () => invalidate('workspace-settings', workspaceId),
      member: ({ member }) => {
        if (!member) return;
        queryClient.setQueryData<Snapshot>(['snapshot', workspaceId], (old) => old && {
          ...old,
          members: [...old.members.filter((item) => item.account_id !== member.account_id), member],
          former_members: old.former_members.filter((item) => item.account_id !== member.account_id),
        });
      },
      agent_pending: (frame) => { refreshSnapshot(); invalidate('agent-pending', workspaceId, frame.agent_id); invalidate('agent-activity', workspaceId, frame.agent_id); },
      board_changed: (frame) => { invalidate('channel-tasks', workspaceId); invalidate('task-references', workspaceId); invalidate('boards', workspaceId); invalidate('board', workspaceId, frame.board_id); },
      document_changed: (frame) => { invalidate('documents', workspaceId); invalidate('document', workspaceId, frame.document_id); },
      projects_changed: () => { invalidate('projects', workspaceId); invalidate('project', workspaceId); },
      channel_access_removed: ({ channel_id: removedId }) => {
        for (const key of workKeys) queryClient.removeQueries({ queryKey: [key, workspaceId] });
        const fallback = queryClient.getQueryData<Snapshot>(['snapshot', workspaceId])?.channels.find((item) => item.id !== removedId && item.joined);
        queryClient.setQueryData<Snapshot>(['snapshot', workspaceId], (old) => old && { ...old, channels: old.channels.filter((item) => item.id !== removedId) });
        queryClient.removeQueries({ queryKey: ['messages', workspaceId, removedId] });
        if (window.location.pathname.split('/')[3] === removedId) {
          callbacks.current.onLeaveChannel();
          navigate(fallback ? `/w/${workspaceId}/${fallback.id}` : `/w/${workspaceId}`);
        }
        refreshSnapshot();
      },
      access_removed: () => { stopped = true; current?.close(); invalidate('me'); navigate('/'); },
      error: (frame) => { if (!frame.client_id) callbacks.current.onNotice(frame.error); },
      held: () => callbacks.current.onNotice('Agents in this channel are holding until a person replies.'),
    };

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/workspaces/${workspaceId}/ws`);
      current = ws;
      ws.onopen = () => {
        retry = 0; setConnected(true); setSocket(ws);
        if (lastId.current) ws.send(JSON.stringify({ type: 'sync', after: lastId.current }));
      };
      // A socket from an earlier workspace can close after its replacement opened; ignore it.
      ws.onclose = () => {
        if (stopped) return;
        reset();
        timer = window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
      };
      ws.onmessage = (incoming) => {
        let frame: ServerFrame;
        try { frame = JSON.parse(incoming.data) as ServerFrame; } catch { return; }
        (handlers[frame.type] as ((event: ServerFrame) => void) | undefined)?.(frame);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer); window.clearTimeout(snapshotTimer);
      for (const pending of typingTimers.current.values()) window.clearTimeout(pending);
      typingTimers.current.clear();
      current?.close();
      reset();
    };
  }, [workspaceId, selfId, queryClient]);

  return { socket, connected, onlineIds, typingEntries, lastId };
}
