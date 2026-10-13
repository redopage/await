import ProjectsView from './ProjectsView';
import { dmPartnerId, initials } from '../shared/members';
import { formatBytes } from '../shared/attachments';
import { TAG_PATTERN } from '../shared/tags';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowTopRightOnSquareIcon, ChatBubbleLeftRightIcon, CheckIcon, CodeBracketIcon, DocumentIcon, FolderOpenIcon, HashtagIcon, MagnifyingGlassIcon, PhotoIcon, PlusIcon, Squares2X2Icon } from '@heroicons/react/16/solid';
import { taskStatuses, type Channel, type Member, type TaskBoard, type TaskStatus, type TeamDocument } from '../shared/types';
import type { SharedLink } from '../shared/workspace-library';
import { api, navigate } from './api';
import LoadNotice from './LoadNotice';
import ArtifactPreview from './ArtifactPreview';
import { listDrafts } from './drafts';

export type WorkspaceView = 'boards' | 'projects' | 'inbox' | 'git' | 'files' | 'threads' | 'drafts';
export const viewTitles: Record<WorkspaceView, string> = { boards: 'Tasks', projects: 'Projects', inbox: 'Inbox', git: 'Git', files: 'Files', threads: 'Threads', drafts: 'Drafts' };
type LibraryFile = { id: string; filename: string; mime: string; size: number; channel_id: string; channel_name: string; created_at: number };
type LibraryBoard = TaskBoard & { channel_name: string; task_count: number; completed_count: number };
type OpenTask = { id: string; title: string; status: TaskStatus; priority: number; board_id: string; board_name: string; channel_id: string; channel_name: string; assignee_id: string | null; due_at: number | null; updated_at: number };
type LibraryDocument = TeamDocument & { channel_name: string };
type Thread = { id: string; channel_id: string; channel_name: string; is_dm: number; author_id: string; body: string; reply_count: number; updated_at: number };
type Link = SharedLink & { message_id: string; thread_id: string | null; channel_id: string; channel_name: string; is_dm: number; created_at: number };
const relativeDate = (time: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(time);
const summary = (body: string, members: Member[], channels: Channel[]) => body.replace(TAG_PATTERN, (_, sigil: string, id: string) => sigil === '@' ? `@${members.find((member) => member.account_id === id)?.name ?? 'teammate'}` : sigil === '#' ? `#${channels.find((channel) => channel.id === id)?.name ?? 'channel'}` : 'a task').replace(/<((?:https?:\/\/|mailto:)[^\s<>]+|[^\s@<>]+@[^\s@<>]+)>/g, '$1').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/[*_`]/g, '').slice(0, 220);

function Empty({ icon: Icon, title, detail, action }: { icon: typeof FolderOpenIcon; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="workspace-empty"><Icon aria-hidden="true" /><h2>{title}</h2><p>{detail}</p>{action}</div>;
}
function QueryState({ query }: { query: { isPending: boolean; isPaused: boolean; isError: boolean; data?: unknown; refetch: () => unknown } }) {
  if (query.data) return null;
  if (query.isPaused || query.isError) return <LoadNotice title={query.isPaused ? 'You are offline' : 'This view could not load'} detail="Try again to load your workspace." onRetry={() => void query.refetch()} />;
  return query.isPending ? <p className="workspace-loading" role="status">Loading…</p> : null;
}

// One open task: its status, title and where it lives. Agent rows show who has it.
function TaskRow({ task, assignee, onOpen }: { task: OpenTask; assignee?: Member; onOpen: () => void }) {
  return <button type="button" className="library-row task-row" onClick={onOpen}>
    <span className={`task-check status-${task.status}`} aria-hidden="true" />
    <span>
      <strong>{task.title}</strong>
      <small>{[assignee?.name, taskStatuses.find((status) => status.id === task.status)?.name, `#${task.channel_name}`].filter(Boolean).join(' · ')}</small>
    </span>
    {task.due_at && <time>{relativeDate(task.due_at)}</time>}
  </button>;
}

export default function WorkspaceViews({ view, workspaceId, selfId, channels, members, role, onCreate, onAgent }: { view: WorkspaceView; workspaceId: string; selfId: string; channels: Channel[]; members: Member[]; role: string; onCreate: (kind: 'tasks' | 'docs') => void; onAgent: (id?: string) => void }) {
  const [search, setSearch] = useState('');
  const [fileTab, setFileTab] = useState<'all' | 'docs' | 'media'>('all');
  const [linkTab, setLinkTab] = useState<'all' | 'git' | 'artifact'>('all');
  const [, setDraftVersion] = useState(0);
  useEffect(() => { const update = () => setDraftVersion((value) => value + 1); window.addEventListener('await:drafts', update); window.addEventListener('storage', update); return () => { window.removeEventListener('await:drafts', update); window.removeEventListener('storage', update); }; }, []);
  const boards = useQuery({ queryKey: ['boards', workspaceId, 'all'], queryFn: () => api<LibraryBoard[]>(`/workspaces/${workspaceId}/collab/boards`), enabled: view === 'boards' });
  // Under the boards key, so every board change and reconnect refreshes it too.
  const openTasks = useQuery({ queryKey: ['boards', workspaceId, 'open-tasks'], queryFn: () => api<OpenTask[]>(`/workspaces/${workspaceId}/collab/tasks`), enabled: view === 'boards' });
  const files = useQuery({ queryKey: ['file-library', workspaceId, search], queryFn: () => api<LibraryFile[]>(`/workspaces/${workspaceId}/files?q=${encodeURIComponent(search)}`), enabled: view === 'files' });
  const documents = useQuery({ queryKey: ['documents', workspaceId, 'all'], queryFn: () => api<LibraryDocument[]>(`/workspaces/${workspaceId}/collab/documents`), enabled: view === 'files' });
  const overview = useQuery({ queryKey: ['workspace-overview', workspaceId], queryFn: () => api<{ threads: Thread[]; links: Link[] }>(`/workspaces/${workspaceId}/collab/overview`), enabled: view === 'threads' || view === 'git' });
  // Agents whose posts wait for this reader's review.
  const reviews = members.filter((member) => member.kind === 'agent' && Number(member.pending_count) > 0 && (member.owner_id === selfId || role !== 'member'));
  const unread = channels.filter((channel) => channel.joined && (channel.unread || channel.mentions)).sort((a, b) => b.mentions - a.mentions || b.unread - a.unread);
  const term = search.toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(term);
  const open = (channelId: string, query = '') => navigate(`/w/${workspaceId}/${channelId}${query}`);
  const channelName = (channelId: string) => { const channel = channels.find((item) => item.id === channelId); return channel?.is_dm ? 'Direct message' : `#${channel?.name ?? 'channel'}`; };
  const partner = (channel: Channel) => members.find((member) => member.account_id === dmPartnerId(channel.dm_key, selfId));
  const drafts = listDrafts(workspaceId, selfId).filter((draft) => channels.some((channel) => channel.id === draft.channelId && channel.joined));
  const visibleTasks = openTasks.data?.filter((task) => matches(`${task.title} ${task.board_name} ${task.channel_name}`)) ?? [];
  const member = (id: string | null) => members.find((item) => item.account_id === id);
  const yours = visibleTasks.filter((task) => task.assignee_id === selfId);
  const withAgents = visibleTasks.filter((task) => member(task.assignee_id)?.kind === 'agent');
  const openTask = (task: OpenTask) => open(task.channel_id, `?view=tasks&board=${task.board_id}&task=${task.id}`);
  const visibleBoards = boards.data?.filter((board) => matches(`${board.name} ${board.channel_name}`)) ?? [];
  const visibleDocs = documents.data?.filter((doc) => matches(`${doc.title} ${doc.channel_name}`)) ?? [];
  const visibleFiles = files.data?.filter((file) => fileTab === 'all' || (fileTab === 'media' ? /^(image|video|audio)\//.test(file.mime) : !/^(image|video|audio)\//.test(file.mime))) ?? [];
  const links = overview.data?.links.filter((link) => (linkTab === 'all' || link.kind === linkTab) && matches(`${link.title} ${link.channel_name}`)) ?? [];
  if (view === 'projects') return <ProjectsView workspaceId={workspaceId} selfId={selfId} channels={channels} members={members} />;
  return <div className="workspace-view">
    {view !== 'inbox' && <div className="library-toolbar"><label className="library-search"><MagnifyingGlassIcon /><span className="sr-only">Search {viewTitles[view]}</span><input name="library-search" value={search} placeholder={`Search ${viewTitles[view].toLowerCase()}`} onChange={(event) => setSearch(event.target.value)} /></label>
      {view === 'files' && <div className="library-tabs" aria-label="File types">{(['all', 'docs', 'media'] as const).map((tab) => <button type="button" key={tab} aria-pressed={fileTab === tab} onClick={() => setFileTab(tab)}>{tab === 'all' ? 'All' : tab === 'docs' ? 'Documents' : 'Media'}</button>)}</div>}
      {view === 'git' && <div className="library-tabs" aria-label="Link types">{(['all', 'git', 'artifact'] as const).map((tab) => <button type="button" key={tab} aria-pressed={linkTab === tab} onClick={() => setLinkTab(tab)}>{tab === 'all' ? 'All' : tab === 'git' ? 'Git' : 'Artifacts'}</button>)}</div>}
      {view === 'boards' ? <button type="button" className="button secondary library-action" onClick={() => onCreate('tasks')}><PlusIcon /> New board</button> : view === 'files' ? <button type="button" className="button secondary library-action" onClick={() => onCreate('docs')}><PlusIcon /> New document</button> : null}
    </div>}
    {view === 'boards' && <>
      <QueryState query={boards} />
      {boards.data && <QueryState query={openTasks} />}
      {yours.length > 0 && <section className="library-section" aria-labelledby="tasks-yours"><h3 id="tasks-yours">Yours <span>{yours.length}</span></h3>
        <div className="library-list">{yours.map((task) => <TaskRow key={task.id} task={task} onOpen={() => openTask(task)} />)}</div></section>}
      {withAgents.length > 0 && <section className="library-section" aria-labelledby="tasks-agents"><h3 id="tasks-agents">With agents <span>{withAgents.length}</span></h3>
        <div className="library-list">{withAgents.map((task) => <TaskRow key={task.id} task={task} assignee={member(task.assignee_id)} onOpen={() => openTask(task)} />)}</div></section>}
      {visibleBoards.length > 0 && <section className="library-section" aria-labelledby="tasks-boards"><h3 id="tasks-boards">Boards</h3>
        <div className="board-library">{visibleBoards.map((board) => <button type="button" className="board-library-item" key={board.id} onClick={() => open(board.channel_id, `?view=tasks&board=${board.id}`)}><h4>{board.name}</h4><p>#{board.channel_name}</p><div className="board-library-progress"><span>{board.completed_count} of {board.task_count} done</span></div><progress max={Math.max(1, board.task_count)} value={board.completed_count} aria-label={`${board.name} completion`} /></button>)}</div></section>}
      {boards.data && !visibleBoards.length && <Empty icon={Squares2X2Icon} title={search ? 'Nothing found' : 'No boards yet'} detail={search ? 'Try a different search.' : 'Create a board in a channel, then give tasks to people or agents.'} />}
    </>}
    {view === 'files' && <>
      <QueryState query={files} />
      <QueryState query={documents} />
      <div className="library-list">
        {fileTab !== 'media' && visibleDocs.map((doc) => <button type="button" className="library-row" key={doc.id} onClick={() => open(doc.channel_id, `?view=docs&doc=${doc.id}`)}>
          <DocumentIcon />
          <span>
            <strong>{doc.title}</strong>
            <small>Document · #{doc.channel_name}</small>
          </span>
          <time>{relativeDate(doc.updated_at)}</time>
          <ArrowTopRightOnSquareIcon />
        </button>)}
        {visibleFiles.map((file) => <a className="library-row" key={file.id} href={`/api/workspaces/${workspaceId}/files/${file.id}`} target="_blank" rel="noopener noreferrer">
          {/^image\//.test(file.mime) ? <PhotoIcon /> : <DocumentIcon />}
          <span>
            <strong>{file.filename}</strong>
            <small>{channelName(file.channel_id)} · {formatBytes(file.size)}</small>
          </span>
          <time>{relativeDate(file.created_at)}</time>
          <ArrowTopRightOnSquareIcon />
        </a>)}
      </div>
      {files.data && documents.data && !(visibleFiles.length || (fileTab !== 'media' && visibleDocs.length)) && <Empty icon={FolderOpenIcon} title={search ? 'No files found' : 'A home for your shared files'} detail={search ? 'Try a different search or file type.' : 'Upload files in a conversation, or create a document. They will appear here.'} />}
    </>}
    {view === 'git' && <>
      <QueryState query={overview} />
      <div className="library-list">
        {links.map((link) => <article className={`library-row ${link.preview ? "artifact-library-row" : ""}`} key={link.url}>
          {link.preview ? <div className="artifact-library-entry">
            <ArtifactPreview link={link} workspaceId={workspaceId} messageId={link.message_id} />
            <small className="artifact-origin">
              <button type="button" onClick={() => open(link.channel_id, `?thread=${link.thread_id ?? link.message_id}`)}>Shared in {channelName(link.channel_id)}</button>
              <time>{relativeDate(link.created_at)}</time>
            </small>
          </div> : <>
            <CodeBracketIcon />
            <span>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                <strong>{link.title}</strong>
                <ArrowTopRightOnSquareIcon />
              </a>
              <small>{link.kind === 'git' ? 'Git' : 'Cloudflare artifact'} · <button type="button" onClick={() => open(link.channel_id, link.thread_id ? `?thread=${link.thread_id}` : '')}>
                  {channelName(link.channel_id)}
                </button></small>
            </span>
            <time>{relativeDate(link.created_at)}</time>
          </>}
        </article>)}
      </div>
      {overview.data && !links.length && <Empty icon={CodeBracketIcon} title={search ? 'No matching links' : 'Bring the work into the conversation'} detail="Share a GitHub, GitLab, or Cloudflare Artifacts repository, or a Pages or Workers preview. Find it here alongside its conversation." />}
    </>}
    {view === 'threads' && <>
      <QueryState query={overview} />
      <div className="library-list">
        {overview.data?.threads.filter((thread) => matches(`${thread.body} ${thread.channel_name}`)).map((thread) => <button type="button" className="library-row thread-library-row" key={thread.id} onClick={() => open(thread.channel_id, `?thread=${thread.id}`)}>
          <ChatBubbleLeftRightIcon />
          <span>
            <small>{channelName(thread.channel_id)} · {members.find((member) => member.account_id === thread.author_id)?.name ?? 'Teammate'}</small>
            <strong>{summary(thread.body, members, channels) || 'Shared an attachment'}</strong>
            <small>{thread.reply_count} {thread.reply_count === 1 ? 'reply' : 'replies'}</small>
          </span>
          <time>{relativeDate(thread.updated_at)}</time>
        </button>)}
      </div>
      {overview.data && !overview.data.threads.some((thread) => matches(`${thread.body} ${thread.channel_name}`)) && <Empty icon={ChatBubbleLeftRightIcon} title="No threads here yet" detail="Reply to a message in a thread to keep a discussion together." />}
    </>}
    {view === 'drafts' && <><div className="library-list">{drafts.filter((draft) => matches(draft.body)).map((draft) => <button type="button" className="library-row thread-library-row" key={`${draft.channelId}-${draft.threadId ?? 'main'}`} onClick={() => open(draft.channelId, draft.threadId ? `?thread=${draft.threadId}` : '')}><DocumentIcon /><span><small>{channelName(draft.channelId)}{draft.threadId ? ' · Thread reply' : ''}</small><strong>{summary(draft.body, members, channels)}</strong></span><time>{relativeDate(draft.updatedAt)}</time></button>)}</div>{!drafts.some((draft) => matches(draft.body)) && <Empty icon={DocumentIcon} title="All caught up" detail="Start writing a message. Your text will wait here if you leave the conversation." />}</>}
    {view === 'inbox' && <>
      {reviews.length > 0 && <section className="library-section" aria-labelledby="inbox-review"><h3 id="inbox-review">To review</h3>
        <div className="library-list">{reviews.map((agent) => <button type="button" className="library-row" key={agent.account_id} onClick={() => onAgent(agent.account_id)}>
          <span className="avatar avatar-small">{agent.avatar_url ? <img src={agent.avatar_url} alt="" /> : initials(agent.name)}</span>
          <span><strong>{agent.name}</strong><small>{agent.pending_count} {Number(agent.pending_count) === 1 ? 'post waits' : 'posts wait'} for your review</small></span>
        </button>)}</div></section>}
      {unread.length > 0 && <section className="library-section" aria-labelledby="inbox-unread"><h3 id="inbox-unread">Unread</h3>
        <div className="library-list">{unread.map((channel) => <button type="button" className="library-row" key={channel.id} onClick={() => open(channel.id)}>
          {channel.is_dm ? <ChatBubbleLeftRightIcon /> : <HashtagIcon />}
          <span>
            <strong>{channel.is_dm ? partner(channel)?.name ?? 'Direct message' : channel.name}</strong>
            <small>{[channel.mentions ? `${channel.mentions} ${channel.mentions === 1 ? 'mention' : 'mentions'}` : '', channel.unread ? `${channel.unread} unread` : ''].filter(Boolean).join(' · ')}</small>
          </span>
        </button>)}</div></section>}
      {!reviews.length && !unread.length && <Empty icon={CheckIcon} title="All caught up" detail="Mentions, unread messages and agent posts to review show up here." />}
    </>}
  </div>;
}
