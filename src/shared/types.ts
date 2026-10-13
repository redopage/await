export type Member = {
  account_id: string;
  kind: 'human' | 'agent';
  name: string;
  avatar_url: string | null;
  role: 'owner' | 'admin' | 'member';
  owner_id?: string | null;
  description?: string;
  paused: number;
  approval_mode?: number;
  all_channels?: number;
  pending_count?: number;
  muted?: number;
  last_active_at?: number | null;
};

export type AgentActivity = {
  id: string;
  agent_id: string;
  action: 'list_channels' | 'list_members' | 'read_messages' | 'read_thread' | 'show_channel' | 'get_attachment' | 'post_message' | 'request_post' | 'get_mentions' | 'mark_read';
  channel_id: string | null;
  target_id: string | null;
  target_name?: string | null;
  created_at: number;
};

export type PendingAgentPost = { id: string; agent_id: string; channel_id: string; thread_id: string | null; body: string; client_id: string | null; attachment_ids: string; attachment_names?: string[]; created_at: number; status: 'pending' | 'approved' | 'rejected'; posted_id: string | null };

export type Channel = {
  id: string;
  name: string;
  description: string;
  is_private: number;
  is_dm: number;
  dm_key: string | null;
  created_by: string;
  created_at: number;
  archived_at: number | null;
  joined: number;
  unread: number;
  last_read_id: string | null;
  mentions: number;
  notify: 'all' | 'mentions' | 'none';
};

export type ChatMessage = {
  id: string;
  client_id?: string | null;
  channel_id: string;
  thread_id: string | null;
  author_id: string;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  reply_count?: number;
  unread_mentions?: number;
  reactions?: Array<{ emoji: string; count: number; mine: number }>;
  attachments?: Attachment[];
  // Kanban cards referenced in the body as <task:id>, resolved for the reader.
  tasks?: TaskRef[];
  delivery?: 'sending';
};

export type TaskRef = { id: string; title: string; status: TaskStatus; board_id: string };

export type Attachment = {
  id: string;
  message_id: string;
  channel_id: string;
  kind: 'file' | 'image' | 'drawing';
  mime: string;
  size: number;
  filename: string;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member';
};

export type MeResponse = {
  account: { id: string; name: string; email: string; avatar_url: string | null } | null;
  workspaces: WorkspaceSummary[];
  providers: string[];
  can_create_workspace: boolean;
  signup_open: boolean;
  can_dev_login: boolean;
};

export type TaskBoard = { id: string; channel_id: string; name: string; created_by: string; created_at: number };
// The one list of Kanban columns. Order matters: the table view sorts by it.
export const taskStatuses = [
  { id: 'todo', name: 'To do' },
  { id: 'doing', name: 'In progress' },
  { id: 'blocked', name: 'Blocked' },
  { id: 'review', name: 'Review' },
  { id: 'done', name: 'Done' },
] as const;
export type TaskStatus = typeof taskStatuses[number]['id'];
export const taskStatusIds: readonly TaskStatus[] = taskStatuses.map((status) => status.id);
export type TeamTask = { id: string; board_id: string; title: string; description: string; status: TaskStatus; priority: number; assignee_id: string | null; due_at: number | null; created_by: string; created_at: number; updated_at: number; completed_at: number | null; reference_count?: number };
// A conversation message that references a task, for the card's "Referenced in" list.
export type TaskReference = { message_id: string; channel_id: string; thread_id: string | null; author_id: string; created_at: number; excerpt: string };
export type TeamDocument = { id: string; channel_id: string; title: string; body: string; created_by: string; updated_by: string; created_at: number; updated_at: number };
