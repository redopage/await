import GiphyAttribution from './GiphyAttribution';
import { Component, Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import messageTags, { taskLinkPattern } from './messageTags';
import './references.css';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import giphyCredits from './giphyCredits';
import { RectangleStackIcon,
  ArrowLeftIcon, ArrowRightIcon, Bars3Icon, BellIcon, ChatBubbleLeftRightIcon, CheckIcon,
  ChevronDownIcon, Cog6ToothIcon, DocumentIcon, EllipsisHorizontalIcon, HashtagIcon, Squares2X2Icon,
  HomeIcon, FolderOpenIcon, CodeBracketIcon, InboxIcon,
  LockClosedIcon, MagnifyingGlassIcon, PaperAirplaneIcon, PaperClipIcon,
  PencilSquareIcon, PlusIcon, SparklesIcon, UserGroupIcon, XMarkIcon,
} from '@heroicons/react/16/solid';
import { FaceSmileIcon, HashtagIcon as ChannelSectionIcon, ChatBubbleLeftRightIcon as DmSectionIcon } from '@heroicons/react/24/outline';
import type { AgentActivity, Attachment, Channel, ChatMessage, MeResponse, Member, PendingAgentPost, TaskRef, WorkspaceSummary } from '../shared/types';
import { taskStatuses } from '../shared/types';
import { dmPartnerId, initials } from '../shared/members';
import { tagText } from '../shared/tags';
import { useWorkspaceSocket } from './useWorkspaceSocket';
import { conversationKey, lastStoredMessage, mergeMessageList, type Snapshot } from './messageCache';
import { formatBytes, normalizeAttachment } from '../shared/attachments';
import { api, ApiError, navigate, post } from './api';
import TasksView from './TasksView';
import WorkspaceViews, { viewTitles, type WorkspaceView } from './WorkspaceViews';
import DocsView from './DocsView';
import Composer from './Composer';
import InlineMessageEditor from './InlineMessageEditor';
import CreateMenu from './CreateMenu';
import InviteDialogContent from './InviteDialogContent';
import Modal from './Modal';
import SettingsDialog, { type SettingsSection } from './SettingsDialog';
import usePopupMenu from './usePopupMenu';
import { usePageVisibility, useTabStatus } from './useTabStatus';
import AgentSetup from './AgentSetup';
import AgentWebhookSettings from './AgentWebhookSettings';
import AgentChannelAccess from './AgentChannelAccess';
import SidebarSection from './SidebarSection';
import Landing from './Landing';
import AgentGuide from './AgentGuide';
import BrandMark from './BrandMark';
import ArtifactPreview from './ArtifactPreview';
import { artifactName, workLinks } from '../shared/workspace-library';
import LoadNotice from './LoadNotice';
import type { DrawingScene } from './Drawing';

const Drawing = lazy(() => import('./Drawing'));
const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

function useLocation() {
  const [location, setLocation] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const update = () => setLocation(window.location.pathname + window.location.search);
    window.addEventListener('popstate', update);
    window.addEventListener('await:navigate', update);
    return () => { window.removeEventListener('popstate', update); window.removeEventListener('await:navigate', update); };
  }, []);
  return location;
}

function timeLabel(time: number) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(time); }
function dateLabel(time: number) { return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(time); }
function shortTime(time: number) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(time); }
function calendarDay(time: number) { return new Date(time).toDateString(); }
function beginsCalendarDay(messages: ChatMessage[], index: number) { return index === 0 || calendarDay(messages[index].created_at) !== calendarDay(messages[index - 1].created_at); }
function timelineDayLabel(time: number) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (calendarDay(time) === today.toDateString()) return 'Today';
  if (calendarDay(time) === yesterday.toDateString()) return 'Yesterday';
  return dateLabel(time);
}

function Avatar({ member, size = 'normal' }: { member?: Member; size?: 'normal' | 'small' }) {
  return <div className={`avatar ${size === 'small' ? 'avatar-small' : ''} ${member?.kind === 'agent' ? 'avatar-agent' : ''}`} aria-hidden="true">
    {member?.avatar_url ? <img src={member.avatar_url} alt="" /> : initials(member?.name ?? '?')}
  </div>;
}

class DrawingBoundary extends Component<{ children: React.ReactNode; onClose: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="drawing-error" role="alert"><strong>Drawing could not open</strong><p>Close the editor and try again.</p><button type="button" className="button primary" onClick={this.props.onClose}>Close editor</button></div>;
  }
}

function SignIn({ providers, invite, error, signupOpen, canDevLogin }: { providers: string[]; invite: string | null; error: string | null; signupOpen: boolean; canDevLogin: boolean }) {
  const [devName, setDevName] = useState('Builder');
  const [working, setWorking] = useState(false);
  const [email, setEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);
  const [emailError, setEmailError] = useState('');
  async function devLogin() {
    setWorking(true);
    // Local accounts are name@localhost unless an email is typed in the same box ("Ada <ada@example.com>" or a bare address).
    const typed = devName.trim();
    const address = typed.match(/<([^>]+@[^>]+)>$/)?.[1] ?? (typed.includes('@') ? typed : null);
    const name = address ? typed.replace(/<[^>]+>$/, '').trim() || address.split('@')[0] : typed || 'Builder';
    try { await post('/dev/login', { name, email: address ?? `${name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'builder'}@localhost` }); window.location.reload(); }
    catch { setWorking(false); }
  }
  async function emailLogin(event: React.FormEvent) {
    event.preventDefault(); setWorking(true); setEmailError('');
    try {
      await post('/auth/email/start', { email, invite, next: new URLSearchParams(window.location.search).get('next') });
      setLinkSent(true);
    } catch (cause) { setEmailError(cause instanceof Error ? cause.message : 'Could not sign in.'); }
    finally { setWorking(false); }
  }
  return <div className="sign-page">
    <a className="sign-wordmark" href="/"><BrandMark /><strong>await</strong></a>
    <div className="sign-grid"><div className="sign-story"><h1>{signupOpen ? 'Your team’s next conversation starts here.' : 'Welcome back to the conversation.'}</h1><p>{signupOpen ? 'Create a workspace, join your team, or return to the conversation.' : 'Sign in to return to your workspace or accept an invitation from your team.'}</p><div className="story-card"><div className="story-avatars"><span>A</span><span>R</span><span>M</span></div><div><strong>People and agents, working together</strong><p>Your channels, threads, and shared work are waiting.</p></div></div></div>
      <div className="sign-card"><h2>Sign in to Await</h2><p>{linkSent ? `We sent a sign-in link to ${email}. Open it from your email to continue.` : 'Use your email to continue.'}</p>{error && <p className="error-banner">{error}</p>}{emailError && <p className="error-banner" role="alert">{emailError}</p>}
        <div className="sign-buttons">{providers.includes('email') && <form className="email-signin" onSubmit={(event) => void emailLogin(event)}>{linkSent ? <><p className="hint">The link expires in ten minutes and works once.</p><button type="button" className="text-button" onClick={() => { setLinkSent(false); setEmailError(''); }}>Use a different email</button></> : <><label htmlFor="signin-email">Email address</label><input id="signin-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" autoFocus required /></>}<button type="submit" className={`button ${linkSent ? 'secondary' : 'primary'}`} disabled={working}>{working ? 'Please wait…' : linkSent ? 'Send another link' : 'Email me a sign-in link'}</button></form>}
          {providers.includes('google') && <a className="button signin-button" href={`/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`}>Continue with Google <ArrowRightIcon /></a>}
          {canDevLogin && <div className="dev-login"><label htmlFor="dev-name">Local development account</label><div className="flex gap-2"><input id="dev-name" name="dev-name" value={devName} placeholder="Your name, or name <you@example.com>" onChange={(event) => setDevName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !working) { event.preventDefault(); void devLogin(); } }} /><button type="button" className="button secondary" disabled={working} onClick={devLogin}>Continue</button></div></div>}
          {providers.length === 0 && !canDevLogin && <p className="hint">Sign-in is being configured. Please return shortly.</p>}
        </div><p className="sign-footnote">{signupOpen ? 'Verify your email to create a workspace. Joining an existing team requires an invitation.' : 'New workspaces are available to approved accounts. Your team can invite you to join theirs.'}</p>
      </div></div>
  </div>;
}

function ReviewerSignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setWorking(true); setError('');
    try {
      const result = await post<{ next: string }>('/auth/reviewer', { email, password, next: new URLSearchParams(window.location.search).get('next') });
      window.location.replace(result.next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign in.'); setWorking(false); }
  }
  return <div className="sign-page reviewer-page">
    <a className="sign-wordmark" href="/" aria-label="Await home"><BrandMark /><strong>await</strong></a>
    <div className="sign-card reviewer-card"><h1>Review access</h1><p>Sign in to the sample workspace with the credentials provided for plugin review.</p>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <form className="email-signin reviewer-form" onSubmit={(event) => void signIn(event)}>
        <label htmlFor="reviewer-email">Email address</label><input id="reviewer-email" name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
        <label htmlFor="reviewer-password">Password</label><input id="reviewer-password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <button type="submit" className="button primary" disabled={working}>{working ? 'Signing in…' : 'Sign in'}</button>
      </form><a className="reviewer-back" href={`/signin${new URLSearchParams(window.location.search).get('next') ? `?next=${encodeURIComponent(new URLSearchParams(window.location.search).get('next')!)}` : ''}`}>Use an email link instead</a>
    </div>
  </div>;
}

function MagicLinkSignIn() {
  const started = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState({}, '', '/signin/verify');
    if (!token) { setError('This sign-in link is invalid. Request a new one.'); return; }
    void post<{ next: string }>('/auth/email/consume', { token })
      .then(({ next }) => window.location.replace(next))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not sign in. Request a new link.'));
  }, []);
  return <div className="loading-page"><BrandMark /><p>{error || 'Signing you in…'}</p>{error && <a className="button secondary" href="/signin">Request a new link</a>}</div>;
}

function CreateWorkspace({ onCreated, canCreate }: { onCreated: (workspace: { id: string; channel_id: string }) => void; canCreate: boolean }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try { onCreated(await post('/workspaces', { name })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create workspace.'); setSaving(false); }
  }
  return <div className="create-page">
    <div className="sign-wordmark">
      <BrandMark />
      <strong>await</strong>
    </div>
    {canCreate ? <form className="create-card" onSubmit={create}>
      <h1>Give your team a place to think together.</h1>
      <p>Start with a general channel. Add teammates and agents when you are ready.</p>
      <label htmlFor="workspace-name">Workspace name</label>
      <input id="workspace-name" name="workspace-name" placeholder="Acme Studio" value={name} onChange={(event) => setName(event.target.value)} autoFocus required minLength={2} />
      {error && <p className="error-banner" role="alert">{error}</p>}
      <button type="submit" className="button primary" disabled={saving}>{saving ? 'Creating…' : 'Create workspace'} <ArrowRightIcon /></button>
    </form> : <div className="create-card">
      <h1>Join your team on Await.</h1>
      <p>Ask a teammate for an invite link, then open it while signed in. New workspaces are currently limited to approved accounts.</p>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <button type="button" className="button secondary" onClick={() => void post('/logout').then(() => window.location.reload()).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not sign out. Try again.'))}>Sign out</button>
    </div>}
  </div>;
}

function MissingChannel({ workspaceId, channelId, channels }: { workspaceId: string; channelId: string; channels: Channel[] }) {
  if (!channelId) return <div className="empty-state">Select a channel to start.</div>;
  const fallback = channels.find((channel) => channel.joined) ?? channels[0];
  return <div className="empty-channel" role="status">
    <div className="empty-icon"><ChatBubbleLeftRightIcon /></div>
    <h2>Conversation unavailable</h2>
    <p>This conversation may have been archived, or you may no longer have access.</p>
    {fallback && <button type="button" className="button secondary" onClick={() => navigate(`/w/${workspaceId}/${fallback.id}`)}>Open {fallback.is_dm ? 'a conversation' : `#${fallback.name}`}</button>}
  </div>;
}

function AgentLimitsSettings({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['workspace-settings', workspaceId], queryFn: () => api<{ rate_per_minute: number; turn_cap: number }>(`/workspaces/${workspaceId}/settings`) });
  const [rate, setRate] = useState('');
  const [turns, setTurns] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (settings.data) { setRate(String(settings.data.rate_per_minute)); setTurns(String(settings.data.turn_cap)); }
  }, [settings.data]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const updated = await api<{ rate_per_minute: number; turn_cap: number }>(`/workspaces/${workspaceId}/settings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rate_per_minute: Number(rate), turn_cap: Number(turns) }),
      });
      queryClient.setQueryData(['workspace-settings', workspaceId], updated);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save agent limits.'); }
    finally { setSaving(false); }
  }
  if (settings.isPending) return <p className="modal-form">Loading agent limits…</p>;
  if (settings.isError) return <div className="modal-form"><p role="alert">Agent limits could not load.</p><button type="button" className="button secondary" onClick={() => void settings.refetch()}>Try again</button></div>;
  return <form className="modal-form" onSubmit={(event) => void save(event)}>
    <p>Keep agent conversations useful and prevent runaway loops. These limits apply across this workspace.</p>
    <label htmlFor="agent-rate-limit">Messages per agent each minute</label>
    <input id="agent-rate-limit" name="agent-rate-limit" type="number" min={1} max={100} step={1} value={rate} onChange={(event) => setRate(event.target.value)} required />
    <label htmlFor="agent-turn-cap">Agent messages in a row per conversation</label>
    <input id="agent-turn-cap" name="agent-turn-cap" type="number" min={1} max={50} step={1} value={turns} onChange={(event) => setTurns(event.target.value)} required />
    <p className="hint">A person replying resets the conversation limit.</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save limits'}</button></div>
  </form>;
}

// Same-origin app links stay inside the single-page app so the live socket survives the click.
function openAppLink(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(href);
}

function MessageBody({ body, members, channels, workspaceId, channelId, messageId, tasks }: { body: string; members: Member[]; channels: Channel[]; workspaceId: string; channelId: string; messageId: string; tasks?: TaskRef[] }) {
  const [artifactToOpen, setArtifactToOpen] = useState<string | null>(null);
  const shared = /^Shared a (task|board|document): \[([^\]]+)\]\((\/w\/[^\s)]+)\)$/.exec(body);
  if (shared) return <a className="shared-work-card" href={shared[3]} onClick={(event) => openAppLink(event, shared[3])}><span className="shared-work-icon">{shared[1] === 'document' ? <DocumentIcon /> : shared[1] === 'board' ? <Squares2X2Icon /> : <CheckIcon />}</span><span><small>{shared[1]}</small><strong>{shared[2]}</strong><em>Open {shared[1]}</em></span><ArrowRightIcon /></a>;
  return <div className="message-body"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, [messageTags, { members, channels, tasks, workspaceId, channelId }], giphyCredits]} components={{ a: ({ href, children }) => {
    const link = workLinks(href ?? '').find((item) => item.preview === 'repository');
    const shown = link && typeof children === 'string' && children === href ? artifactName(link, workspaceId) : null;
    const label = shown ? shown.kind ?? shown.name : children;
    if (link) return <button type="button" className="artifact-inline-link" onClick={() => setArtifactToOpen(link.url)}>{label}</button>;
    const taskId = href?.match(taskLinkPattern)?.[1];
    const task = taskId ? tasks?.find((item) => item.id === decodeURIComponent(taskId)) : undefined;
    if (task && href) return <a className={`task-chip status-${task.status}`} href={href} title={`Task · ${taskStatuses.find((status) => status.id === task.status)?.name ?? task.status}`} onClick={(event) => openAppLink(event, href)}>{task.status === 'done' ? <CheckIcon aria-hidden="true" /> : <span className="task-chip-dot" aria-hidden="true" />}{label}</a>;
    return href?.startsWith('/w/') ? <a href={href} onClick={(event) => openAppLink(event, href)}>{label}</a> : <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
  }, img: ({ src, alt, node }) => {
    const isGiphy = /^https:\/\/(?:media[0-9]*|i)\.giphy\.com\//i.test(src ?? '');
    const pageUrl = node?.properties['data-giphy-page'];
    const credit = node?.properties['data-giphy-credit'];
    return isGiphy ? <span className="giphy-message"><img src={src} alt={alt ?? 'GIF'} loading="lazy" /><span className="giphy-credit"><GiphyAttribution className="giphy-attribution" />{typeof pageUrl === 'string' && <a href={pageUrl} target="_blank" rel="noreferrer">{typeof credit === 'string' ? credit : 'View on GIPHY'}</a>}</span></span> : <img src={src} alt={alt ?? ''} loading="lazy" />;
  } }}>{body}</ReactMarkdown>{workLinks(body).filter((link) => link.preview).map((link) => <ArtifactPreview key={link.url} link={link} workspaceId={workspaceId} messageId={messageId} expandRequested={artifactToOpen === link.url} onExpandDismiss={() => setArtifactToOpen(null)} />)}</div>;
}

function AttachmentView({ attachment, workspaceId, onEditDrawing }: { attachment: Attachment; workspaceId: string; onEditDrawing?: () => void }) {
  attachment = normalizeAttachment(attachment);
  const url = `/api/workspaces/${workspaceId}/files/${attachment.id}`;
  if (attachment.kind === 'image') return <a className="image-attachment" href={url} target="_blank" rel="noreferrer"><img src={url} alt={attachment.filename} /><span>{attachment.filename}</span></a>;
  if (attachment.kind === 'drawing') return <div className="drawing-attachment"><a className="file-attachment" href={url} target="_blank" rel="noreferrer"><DocumentIcon /><span><strong>{attachment.filename}</strong><small>Drawing scene</small></span><ArrowRightIcon /></a>{onEditDrawing && <button type="button" className="button secondary" onClick={onEditDrawing}>Edit drawing</button>}</div>;
  return <a className="file-attachment" href={url} target="_blank" rel="noreferrer"><DocumentIcon /><span><strong>{attachment.filename}</strong><small>{formatBytes(attachment.size)}</small></span><ArrowRightIcon /></a>;
}

function MessageItem({ message, members, channels, workspaceId, selfId, canModerate, onThread, onAgent, onEdit, onDelete, onReact, onEditDrawing }: { message: ChatMessage; members: Member[]; channels: Channel[]; workspaceId: string; selfId: string; canModerate: boolean; onThread?: (id: string, focusReply?: boolean) => void; onAgent?: (agent: Member) => (() => void) | null; onEdit: (message: ChatMessage, body: string) => Promise<void>; onDelete: (message: ChatMessage) => void; onReact: (message: ChatMessage, emoji: string) => void; onEditDrawing: (message: ChatMessage, attachment: Attachment) => void }) {
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const [returnEditFocus, setReturnEditFocus] = useState(false);
  function finishEdit() { setReturnEditFocus(true); setEditing(false); requestAnimationFrame(() => editButton.current?.focus()); }
  const author = members.find((member) => member.account_id === message.author_id);
  // An agent's name opens its controls for the people who manage it.
  const openAgent = author?.kind === 'agent' ? onAgent?.(author) : null;
  const hasThread = Boolean(!editing && onThread && message.reply_count && !message.deleted_at && message.delivery !== 'sending');
  return <article className={`message ${editing ? 'message-editing' : ''} ${returnEditFocus ? 'message-edit-return-focus' : ''} ${hasThread ? 'message-threaded' : ''} ${message.deleted_at ? 'message-deleted' : ''} ${message.delivery === 'sending' ? 'message-sending' : ''}`}
    tabIndex={hasThread ? 0 : undefined}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setReturnEditFocus(false); }}
    onClick={(event) => {
      if (!hasThread || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if ((event.target as Element).closest('a, button, input, textarea, select, [role="button"], [contenteditable="true"]')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      onThread?.(message.id);
    }}
    onKeyDown={(event) => { if (hasThread && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onThread?.(message.id); } }}>
    <Avatar member={author} />
    <div className="message-content">
      <div className="message-meta">{openAgent ? <button type="button" className="message-author" title={`Manage ${author!.name}`} onClick={openAgent}><strong>{author!.name}</strong></button> : <strong>{author?.name ?? 'Former member'}</strong>}{author?.kind === 'agent' && <span className="agent-badge"><SparklesIcon /> Agent</span>}<time title={dateLabel(message.created_at)}>{timeLabel(message.created_at)}</time>{message.edited_at && <span className="edited-label">edited</span>}{message.delivery === 'sending' && <span className="delivery-label">Sending…</span>}</div>
      {message.deleted_at ? <p className="deleted-label">This message was deleted.</p> : <>
        {editing ? <InlineMessageEditor message={message} members={members} channels={channels} workspaceId={workspaceId} onCancel={finishEdit} onSave={async (body) => { await onEdit(message, body); finishEdit(); }} /> : <MessageBody messageId={message.id} body={message.body} members={members} channels={channels} workspaceId={workspaceId} channelId={message.channel_id} tasks={message.tasks} />}
        {message.attachments?.map(normalizeAttachment).sort((left, right) => Number(right.kind === 'image') - Number(left.kind === 'image')).map((attachment) => <AttachmentView key={attachment.id} attachment={attachment} workspaceId={workspaceId} onEditDrawing={attachment.kind === 'drawing' ? () => onEditDrawing(message, attachment) : undefined} />)}
        {Boolean(message.reactions?.length) && <div className="reaction-list">
          {message.reactions?.map((reaction) => <button type="button" key={reaction.emoji} className={`reaction-pill ${reaction.mine ? 'active' : ''}`} aria-label={`${reaction.emoji} reaction, ${reaction.count} ${reaction.count === 1 ? 'person' : 'people'}. ${reaction.mine ? 'Remove yours' : 'Add yours'}.`} onClick={() => onReact(message, reaction.emoji)}>
            {reaction.emoji}
            <span>{reaction.count}</span>
          </button>)}
        </div>}
      </>}
      {onThread && Boolean(message.reply_count) && !message.deleted_at && message.delivery !== 'sending' && <button type="button" className="reply-link" onClick={() => onThread(message.id, true)}>{`${message.reply_count} ${message.reply_count === 1 ? 'reply' : 'replies'}`}{Boolean(message.unread_mentions) && <span className="thread-mention-pill">{message.unread_mentions} {message.unread_mentions === 1 ? 'mention' : 'mentions'}</span>}</button>}
    </div>
    {!editing && !message.deleted_at && message.delivery !== 'sending' && <>
      <div className="message-actions">
        {onThread && <button type="button" aria-label="Reply in thread" title="Reply in thread" onClick={() => onThread(message.id, true)}>
          <ChatBubbleLeftRightIcon />
        </button>}
        <button type="button" aria-label="Add reaction" title="Add reaction" aria-expanded={reactionPickerOpen} onClick={() => setReactionPickerOpen((open) => !open)}>
          <FaceSmileIcon />
        </button>
        {message.author_id === selfId && <button type="button" ref={editButton} aria-label="Edit message" title="Edit message" onClick={() => { setReactionPickerOpen(false); setEditing(true); }}>
          <PencilSquareIcon />
        </button>}
        {(message.author_id === selfId || canModerate) && <button type="button" aria-label={message.author_id === selfId ? 'Delete message' : 'Remove message'} title={message.author_id === selfId ? 'Delete message' : 'Remove message'} onClick={() => onDelete(message)}>
          <XMarkIcon />
        </button>}
      </div>
      {reactionPickerOpen && <div className="reaction-picker" role="group" aria-label="Choose a reaction">
        {REACTION_EMOJIS.map((emoji) => <button type="button" key={emoji} aria-label={`React ${emoji}`} onClick={() => { onReact(message, emoji); setReactionPickerOpen(false); }}>
          {emoji}
        </button>)}
      </div>}
    </>}
  </article>;
}

function WorkspaceApp({ workspace, workspaces, selfId, selfEmail }: { workspace: WorkspaceSummary; workspaces: WorkspaceSummary[]; selfId: string; selfEmail: string }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const parts = location.split('?')[0].split('/');
  const channelId = parts[3] || '';
  const threadId = new URLSearchParams(window.location.search).get('thread') ?? undefined;
  const view = new URLSearchParams(window.location.search).get('view') ?? 'chat';
  const libraryView = Object.hasOwn(viewTitles, view) ? view as WorkspaceView : null;
  function openWorkspaceView(next: WorkspaceView | 'chat') {
    setMobileMenu(false); setError('');
    navigate(`/w/${workspace.id}/${channelId || ''}${next === 'chat' ? '' : `?view=${next}`}`);
  }
  const [mobileMenu, setMobileMenu] = useState(false);
  const [mobileMore, setMobileMore] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<'tasks' | 'docs' | null>(null);
  const [createRequest, setCreateRequest] = useState<{ kind: 'tasks' | 'docs'; id: number } | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [workMenuOpen, setWorkMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [modal, setModal] = useState<'settings' | 'channel' | 'channelSettings' | 'channelNotifications' | 'dm' | 'agent' | 'agentActivity' | 'invite' | 'members' | 'people' | 'profile' | 'workspaceSettings' | 'drawing' | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [reviewingPostId, setReviewingPostId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [mutingAgentId, setMutingAgentId] = useState<string | null>(null);
  const [pausingAgentId, setPausingAgentId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [channelMemberToAdd, setChannelMemberToAdd] = useState('');
  const [savingChannelMemberId, setSavingChannelMemberId] = useState<string | null>(null);
  const [agentSetup, setAgentSetup] = useState<{ agentId: string; token: string; mcpUrl: string } | null>(null);
  const [inviteUrl, setInviteUrl] = useState('');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [newChannel, setNewChannel] = useState('');
  const [channelRename, setChannelRename] = useState('');
  const [privateChannel, setPrivateChannel] = useState(false);
  const [newAgent, setNewAgent] = useState('');
  const [agentDescription, setAgentDescription] = useState('');
  const [addingAgent, setAddingAgent] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [drawingDraft, setDrawingDraft] = useState<{ channelId: string; threadId?: string; scene?: DrawingScene } | null>(null);
  const [hasEarlier, setHasEarlier] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the reader is at the newest message. Refetches only follow new activity while they are.
  const atBottom = useRef(true);
  const scrolledConversation = useRef('');
  const [unreadBoundary, setUnreadBoundary] = useState<{ channelId: string; lastReadId: string | null; unread: number } | null>(null);
  const [replyFocus, setReplyFocus] = useState<{ channelId: string; threadId: string; sequence: number } | null>(null);
  const createMenuRef = usePopupMenu(createMenuOpen, setCreateMenuOpen);
  const workspaceMenuRef = usePopupMenu(workspaceMenuOpen, setWorkspaceMenuOpen);
  const workMenuRef = usePopupMenu(workMenuOpen, setWorkMenuOpen);
  const headerMenuRef = usePopupMenu(headerMenuOpen, setHeaderMenuOpen);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const snapshot = useQuery({ queryKey: ['snapshot', workspace.id], queryFn: () => api<Snapshot>(`/workspaces/${workspace.id}/snapshot`) });
  const notificationSettings = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ email_mentions: boolean; email_dms: boolean; email_available: boolean }>('/notifications'), enabled: modal === 'profile' });
  const channels = snapshot.data?.channels ?? [];
  const pageVisible = usePageVisibility();
  const members = snapshot.data?.members ?? [];
  const agents = members.filter((member) => member.kind === 'agent');
  const pendingAgentCount = agents.reduce((sum, agent) => sum + Number(agent.pending_count ?? 0), 0);
  const selectedAgent = agents.find((agent) => agent.account_id === selectedAgentId);
  const showAgentForm = addingAgent || (agents.length === 0 && !agentSetup);
  const displayMembers = useMemo(() => [...members, ...(snapshot.data?.former_members ?? [])], [members, snapshot.data?.former_members]);
  const activeChannel = channels.find((channel) => channel.id === channelId);
  useEffect(() => {
    if (activeChannel && unreadBoundary?.channelId !== activeChannel.id) {
      setUnreadBoundary({ channelId: activeChannel.id, lastReadId: activeChannel.last_read_id, unread: activeChannel.unread });
    }
  }, [activeChannel, unreadBoundary?.channelId]);
  const messages = useQuery({ queryKey: ['messages', workspace.id, channelId], queryFn: () => api<ChatMessage[]>(`/workspaces/${workspace.id}/channels/${channelId}/messages`), enabled: Boolean(activeChannel?.joined) });
  const unreadStartIndex = unreadBoundary?.channelId === channelId && unreadBoundary.unread > 0
    ? (messages.data?.findIndex((message) => message.id > (unreadBoundary.lastReadId ?? '') && message.author_id !== selfId) ?? -1)
    : -1;
  const thread = useQuery({ queryKey: ['thread', workspace.id, channelId, threadId], queryFn: () => api<ChatMessage[]>(`/workspaces/${workspace.id}/channels/${channelId}/messages?thread=${threadId}`), enabled: Boolean(activeChannel?.joined && threadId) });
  const channelMembers = useQuery({ queryKey: ['channel-members', workspace.id, channelId], queryFn: () => api<Member[]>(`/workspaces/${workspace.id}/channels/${channelId}/members`), enabled: Boolean(activeChannel?.joined && (modal === 'members' || (modal === 'agent' && agentSetup && !activeChannel?.is_dm))) });
  const agentActivity = useQuery({ queryKey: ['agent-activity', workspace.id, selectedAgentId], queryFn: () => api<{ agent_id: string; owner_id: string; last_active_at: number | null; entries: AgentActivity[] }>(`/workspaces/${workspace.id}/agents/${selectedAgentId}/activity`), enabled: Boolean(selectedAgentId && modal === 'agentActivity'), staleTime: 0 });
  const pendingPosts = useQuery({ queryKey: ['agent-pending', workspace.id, selectedAgentId], queryFn: () => api<PendingAgentPost[]>(`/workspaces/${workspace.id}/agents/${selectedAgentId}/pending`), enabled: Boolean(selectedAgentId && modal === 'agentActivity'), staleTime: 0 });
  useEffect(() => { setHasEarlier(true); scrollAnchor.current = null; setHeaderMenuOpen(false); setWorkMenuOpen(false); setChannelMemberToAdd(''); }, [channelId]);
  useEffect(() => {
    if (modal !== 'agent' || !addingAgent) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById('add-agent-form')?.scrollIntoView({ block: 'nearest' });
      document.getElementById('agent-name')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [modal, addingAgent]);
  useEffect(() => {
    if (!profileMenuOpen) return;
    const close = (event: PointerEvent) => { if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setProfileMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [profileMenuOpen]);


  async function loadEarlier() {
    const oldest = messages.data?.[0]?.id;
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    if (scrollRef.current) scrollAnchor.current = { height: scrollRef.current.scrollHeight, top: scrollRef.current.scrollTop };
    try {
      const older = await api<ChatMessage[]>(`/workspaces/${workspace.id}/channels/${channelId}/messages?before=${encodeURIComponent(oldest)}`);
      if (older.length < 50) setHasEarlier(false);
      if (older.length) queryClient.setQueryData<ChatMessage[]>(['messages', workspace.id, channelId], (current) => [...older.filter((item) => !current?.some((existing) => existing.id === item.id)), ...(current ?? [])]);
      else scrollAnchor.current = null;
    } catch (cause) { scrollAnchor.current = null; setError(cause instanceof Error ? cause.message : 'Could not load older messages.'); }
    finally { setLoadingEarlier(false); }
  }

  useEffect(() => {
    if (!channelId && channels.length && !libraryView) navigate(`/w/${workspace.id}/${(channels.find((channel) => channel.joined) ?? channels[0]).id}`);
  }, [channelId, channels, workspace.id, libraryView]);

  const { socket, connected, onlineIds, typingEntries, lastId } = useWorkspaceSocket({ workspaceId: workspace.id, selfId, queryClient, onLeaveChannel: () => setModal(null), onNotice: setError });

  useEffect(() => {
    if (!messages.data?.length || unreadBoundary?.channelId !== channelId) return;
    const latestStored = lastStoredMessage(messages.data);
    if (latestStored && latestStored.id > lastId.current) lastId.current = latestStored.id;
    if (scrollAnchor.current && scrollRef.current) {
      const anchor = scrollAnchor.current;
      scrollRef.current.scrollTop = anchor.top + scrollRef.current.scrollHeight - anchor.height;
      scrollAnchor.current = null;
    } else if (scrolledConversation.current !== channelId) {
      scrolledConversation.current = channelId;
      const marker = unreadStartIndex >= 0 ? scrollRef.current?.querySelector('.unread-divider') : null;
      if (marker) marker.scrollIntoView({ block: 'center' });
      else scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    } else if (atBottom.current || messages.data[messages.data.length - 1].author_id === selfId) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.data, channelId, unreadBoundary?.channelId, unreadStartIndex]);
  const latestStored = lastStoredMessage(messages.data);
  const latestStoredReply = lastStoredMessage(thread.data);
  useEffect(() => { if (pageVisible && view === 'chat' && activeChannel?.joined && latestStored && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'read', channel_id: activeChannel.id, message_id: latestStored.id })); }, [pageVisible, view, activeChannel?.id, activeChannel?.joined, latestStored?.id, socket]);
  useEffect(() => { if (pageVisible && view === 'chat' && activeChannel?.joined && threadId && latestStoredReply) { void post(`/workspaces/${workspace.id}/channels/${activeChannel.id}/threads/${threadId}/read`, { message_id: latestStoredReply.id }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not mark the thread read.')); } }, [pageVisible, view, workspace.id, activeChannel?.id, activeChannel?.joined, threadId, latestStoredReply?.id]);

  function optimisticSend(message: ChatMessage) {
    queryClient.setQueryData<ChatMessage[]>(conversationKey(workspace.id, message), (current) => [...(current ?? []), message]);
  }
  function settleSend(clientId: string, message: ChatMessage | null) {
    const keys = [
      ['messages', workspace.id, channelId],
      ...(threadId ? [['thread', workspace.id, channelId, threadId]] : []),
    ];
    for (const key of keys) queryClient.setQueryData<ChatMessage[]>(key, (current) => {
      if (!current) return current;
      const withoutDraft = current.filter((item) => !(item.delivery === 'sending' && item.client_id === clientId));
      if (!message || (message.thread_id ? key[0] !== 'thread' : key[0] !== 'messages')) return withoutDraft;
      return mergeMessageList(withoutDraft, message, clientId);
    });
  }

  function selectChannel(channel: Channel) { navigate(`/w/${workspace.id}/${channel.id}`); setMobileMenu(false); setError(''); }
  function openThread(id: string, focusReply = false) {
    setReplyFocus((previous) => focusReply ? { channelId, threadId: id, sequence: (previous?.sequence ?? 0) + 1 } : null);
    navigate(`/w/${workspace.id}/${channelId}?thread=${id}`);
  }
  async function action(path: string, body: unknown = {}): Promise<boolean> { try { setError(''); await post(`/workspaces/${workspace.id}${path}`, body); await queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] }); return true; } catch (cause) { setError(cause instanceof Error ? cause.message : 'Action failed.'); return false; } }
  async function reviewAgentPost(postId: string, decision: 'approve' | 'reject') {
    if (!selectedAgentId) return;
    setReviewingPostId(postId); setError('');
    try {
      await post(`/workspaces/${workspace.id}/agents/${selectedAgentId}/pending/${postId}`, { decision });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['agent-pending', workspace.id, selectedAgentId] }), queryClient.invalidateQueries({ queryKey: ['agent-activity', workspace.id, selectedAgentId] }), queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] })]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not review this post.'); }
    finally { setReviewingPostId(null); }
  }
  async function setAgentPaused(agentId: string, paused: boolean) {
    setPausingAgentId(agentId);
    try { await action(`/agents/${agentId}/pause`, { paused }); }
    finally { setPausingAgentId(null); }
  }
  async function setAgentMute(agentId: string, muted: boolean) {
    setMutingAgentId(agentId);
    try {
      if (await action(`/channels/${channelId}/mute`, { agent_id: agentId, muted })) await queryClient.invalidateQueries({ queryKey: ['channel-members', workspace.id, channelId] });
    } finally { setMutingAgentId(null); }
  }
  async function createChannel(event: React.FormEvent) { event.preventDefault(); try { const channel = await post<{ id: string }>(`/workspaces/${workspace.id}/channels`, { name: newChannel, is_private: privateChannel }); setModal(null); setNewChannel(''); navigate(`/w/${workspace.id}/${channel.id}`); void queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] }); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create channel.'); } }
  async function createDm(otherId: string) { try { const dm = await post<{ id: string }>(`/workspaces/${workspace.id}/dms`, { other_id: otherId }); setModal(null); navigate(`/w/${workspace.id}/${dm.id}`); void queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] }); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start direct message.'); } }
  async function renameChannel(event: React.FormEvent) { event.preventDefault(); if (await action(`/channels/${channelId}/rename`, { name: channelRename })) setModal(null); }
  async function leaveChannel() { if (await action(`/channels/${channelId}/leave`)) { setModal(null); navigate(`/w/${workspace.id}`); } }
  async function archiveChannel() { if (!window.confirm(`Archive #${activeChannel?.name}?`)) return; if (await action(`/channels/${channelId}/archive`)) { setModal(null); navigate(`/w/${workspace.id}`); } }
  async function uploadAgentAvatar(agentId: string, file: File) {
    try { await api(`/workspaces/${workspace.id}/agents/${agentId}/avatar`, { method: 'POST', body: file, headers: { 'content-type': file.type } }); void queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not upload agent avatar.'); }
  }
  async function createAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creatingAgent) return;
    const form = event.currentTarget;
    const avatar = new FormData(form).get('agent-avatar');
    setCreatingAgent(true); setError('');
    try {
      const result = await post<{ token: string; agent_id: string; mcp_url: string }>(`/workspaces/${workspace.id}/agents`, { name: newAgent, description: agentDescription });
      setAgentSetup({ agentId: result.agent_id, token: result.token, mcpUrl: result.mcp_url });
      setNewAgent(''); setAgentDescription(''); form.reset();
      if (avatar instanceof File && avatar.size > 0) void uploadAgentAvatar(result.agent_id, avatar);
      setAddingAgent(false);
      void queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create agent.'); }
    finally { setCreatingAgent(false); }
  }
  async function rotateAgentToken(agent: Member) {
    if (!window.confirm(`Rotate ${agent.name}'s token? The old token will stop working.`)) return;
    setError('');
    try {
      const result = await post<{ token: string; mcp_url: string }>(`/workspaces/${workspace.id}/agents/${agent.account_id}/rotate`);
      setAgentSetup({ agentId: agent.account_id, token: result.token, mcpUrl: result.mcp_url });
      setAddingAgent(false); setModal('agent');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rotate agent token.'); }
  }
  async function addSetupAgentToChannel(targetChannelId: string): Promise<boolean> {
    if (!agentSetup || !channels.some((item) => item.id === targetChannelId && item.joined && !item.is_dm)) return false;
    const added = await action(`/channels/${targetChannelId}/members`, { agent_id: agentSetup.agentId });
    if (added) await queryClient.invalidateQueries({ queryKey: ['channel-members', workspace.id, targetChannelId] });
    return added;
  }
  async function addChannelTeammate(event: React.FormEvent) {
    event.preventDefault();
    if (!channelMemberToAdd) return;
    setSavingChannelMemberId(channelMemberToAdd);
    try {
      if (await action(`/channels/${channelId}/members`, { account_id: channelMemberToAdd })) {
        setChannelMemberToAdd('');
        await queryClient.invalidateQueries({ queryKey: ['channel-members', workspace.id, channelId] });
      }
    } finally { setSavingChannelMemberId(null); }
  }
  async function removeChannelMember(member: Member) {
    if (!window.confirm(`Remove ${member.name} from #${activeChannel?.name}? They will lose access to its messages and files.`)) return;
    setSavingChannelMemberId(member.account_id);
    setError('');
    try {
      await api(`/workspaces/${workspace.id}/channels/${channelId}/members/${member.account_id}`, { method: 'DELETE' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['channel-members', workspace.id, channelId] }),
        queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] }),
      ]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove this member.'); }
    finally { setSavingChannelMemberId(null); }
  }
  async function invite() {
    if (workspace.role === 'member' || creatingInvite) return;
    setCreatingInvite(true);
    setError('');
    try { const result = await post<{ url: string }>(`/workspaces/${workspace.id}/invites`); setInviteUrl(result.url); setModal('invite'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create invite.'); }
    finally { setCreatingInvite(false); }
  }
  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setProfileSaving(true); setProfileSaved(false);
    setError('');
    try {
      await api('/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: profileName }) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['me'] }),
        queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] }),
      ]);
      setProfileSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save your name.'); }
    finally { setProfileSaving(false); }
  }
  async function removePerson(member: Member) {
    if (!window.confirm(`Remove ${member.name} from ${workspace.name}? Their agents will lose access, and existing invite links will expire.`)) return;
    setRemovingMemberId(member.account_id);
    setError('');
    try {
      await api(`/workspaces/${workspace.id}/members/${member.account_id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove this person.'); }
    finally { setRemovingMemberId(null); }
  }
  async function removeAgent(agent: Member) {
    if (!window.confirm(`Remove ${agent.name} from ${workspace.name}? Its tokens and MCP connections will stop working. Past messages will remain.`)) return;
    setRemovingMemberId(agent.account_id);
    setError('');
    try {
      await api(`/workspaces/${workspace.id}/agents/${agent.account_id}`, { method: 'DELETE' });
      setAgentSetup(null);
      setSelectedAgentId(null);
      setModal('agent');
      await queryClient.invalidateQueries({ queryKey: ['snapshot', workspace.id] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove this agent.'); }
    finally { setRemovingMemberId(null); }
  }
  function openWorkCreation(kind: 'tasks' | 'docs', targetId: string) {
    setCreateTarget(null);
    setCreateMenuOpen(false);
    setMobileMenu(false);
    setCreateRequest({ kind, id: Date.now() });
    navigate(`/w/${workspace.id}/${targetId}?view=${kind}`);
  }
  function startWorkCreation(kind: 'tasks' | 'docs') {
    setCreateMenuOpen(false);
    if (activeChannel?.joined && !activeChannel.is_dm) openWorkCreation(kind, activeChannel.id);
    else setCreateTarget(kind);
  }
  function chooseCreate(action: 'message' | 'channel' | 'document' | 'board' | 'agent' | 'invite') {
    setCreateMenuOpen(false);
    setMobileMenu(false);
    setError('');
    if (action === 'document' || action === 'board') { startWorkCreation(action === 'document' ? 'docs' : 'tasks'); return; }
    if (action === 'invite') { void invite(); return; }
    if (action === 'agent') { setAgentSetup(null); setAddingAgent(true); }
    setModal(action === 'message' ? 'dm' : action);
  }
  async function updateNotifications(key: 'email_mentions' | 'email_dms', checked: boolean) {
    const current = notificationSettings.data;
    if (!current || notificationSaving) return;
    setNotificationSaving(true); setError('');
    try {
      const updated = await post<typeof current>('/notifications', { email_mentions: key === 'email_mentions' ? checked : current.email_mentions, email_dms: key === 'email_dms' ? checked : current.email_dms });
      queryClient.setQueryData(['notifications'], updated);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save notification settings.'); }
    finally { setNotificationSaving(false); }
  }
  function openSettingsSection(section: SettingsSection) {
    setError('');
    if (section === 'account') { setProfileName(members.find((member) => member.account_id === selfId)?.name ?? ''); setProfileSaved(false); }
    setModal(section === 'appearance' ? 'settings' : section === 'team' ? 'people' : 'profile');
  }

  async function saveEdit(message: ChatMessage, body: string) {
    if (body === message.body) return;
    const updated = await post<ChatMessage>(`/workspaces/${workspace.id}/messages/${message.id}/edit`, { body });
    for (const key of ['messages', 'thread']) queryClient.setQueriesData<ChatMessage[]>({ queryKey: [key, workspace.id, message.channel_id] }, (current) => current?.map((item) => item.id === updated.id ? updated : item));
  }
  async function toggleReaction(message: ChatMessage, emoji: string) { try { await post(`/workspaces/${workspace.id}/messages/${message.id}/reactions`, { emoji }); void queryClient.invalidateQueries({ queryKey: ['messages', workspace.id, message.channel_id] }); if (message.thread_id) void queryClient.invalidateQueries({ queryKey: ['thread', workspace.id, message.channel_id, message.thread_id] }); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update reaction.'); } }
  async function openDrawing(message: ChatMessage, attachment: Attachment) {
    try {
      setError('');
      const scene = await api<DrawingScene>(`/workspaces/${workspace.id}/files/${attachment.id}`);
      if (scene.type !== 'excalidraw' || !Array.isArray(scene.elements) || !scene.appState || !scene.files) throw new Error('This drawing cannot be opened.');
      setDrawingDraft({ channelId: message.channel_id, threadId: message.thread_id ?? message.id, scene });
      setModal('drawing');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open drawing.'); }
  }
  async function uploadDrawing(scene: Blob, preview: Blob) {
    if (!drawingDraft) throw new Error('Choose a conversation for this drawing.');
    const { channelId: destinationId, threadId: destinationThreadId } = drawingDraft;
    const upload = async (blob: Blob, name: string) => api<{ id: string }>(`/workspaces/${workspace.id}/channels/${destinationId}/files`, { method: 'POST', body: blob, headers: { 'content-type': blob.type, 'x-file-name': encodeURIComponent(name) } });
    const [sceneFile, previewFile] = await Promise.all([upload(scene, 'Drawing.excalidraw'), upload(preview, 'Drawing preview.png')]);
    await post(`/workspaces/${workspace.id}/channels/${destinationId}/messages`, { body: destinationThreadId ? 'Updated drawing' : 'Shared a drawing', thread_id: destinationThreadId, attachment_ids: [previewFile.id, sceneFile.id], client_id: crypto.randomUUID() });
    void queryClient.invalidateQueries({ queryKey: ['messages', workspace.id, destinationId] });
    if (destinationThreadId) {
      void queryClient.invalidateQueries({ queryKey: ['thread', workspace.id, destinationId, destinationThreadId] });
      navigate(`/w/${workspace.id}/${destinationId}?thread=${destinationThreadId}`);
    }
    setModal(null);
    setDrawingDraft(null);
  }
  const dmPartner = (channel: Channel) => displayMembers.find((member) => member.account_id === dmPartnerId(channel.dm_key, selfId));
  const place = libraryView ? viewTitles[libraryView] : activeChannel ? activeChannel.is_dm ? dmPartner(activeChannel)?.name ?? 'Direct message' : `#${activeChannel.name}` : '';
  useTabStatus(channels, [place, workspace.name].filter(Boolean).join(' · '));
  const canManageAgent = (agent: Member) => workspace.role !== 'member' || agent.owner_id === selfId;
  const typingLabel = (targetChannel: string, targetThread: string | null) => {
    const names = Object.values(typingEntries)
      .filter((entry) => entry.channelId === targetChannel && entry.threadId === targetThread && entry.accountId !== selfId)
      .map((entry) => members.find((member) => member.account_id === entry.accountId)?.name ?? 'Someone');
    if (!names.length) return '';
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return `${names[0]} and ${names.length - 1} others are typing…`;
  };
  const filteredChannels = channels.filter((channel) => !channel.is_dm && channel.name.includes(search.toLowerCase()));
  const filteredDms = channels.filter((channel) => channel.is_dm && (dmPartner(channel)?.name.toLowerCase().includes(search.toLowerCase()) ?? false));
  const activePartner = activeChannel?.is_dm ? dmPartner(activeChannel) : undefined;
  const channelList = <>
    <SidebarSection key={`${workspace.id}-${selfId}-channels`} id="sidebar-channels" title="Channels" icon={<ChannelSectionIcon />} preferenceKey={`await.sidebar.${selfId}.${workspace.id}.channels`} forceOpen={Boolean(search.trim())} count={channels.filter((item) => !item.is_dm).reduce((sum, item) => sum + item.unread, 0)} countLabel="Unread channel messages" action={<button type="button" className="icon-button" title="New channel" aria-label="New channel" onClick={() => { setError(''); setModal('channel'); }}><PlusIcon /></button>}>
    <nav className="channel-nav" aria-label="Channels">{filteredChannels.map((channel) => <button type="button" key={channel.id} aria-current={channel.id === channelId ? 'page' : undefined} className={`channel-item ${channel.id === channelId ? 'active' : ''} ${channel.joined ? '' : 'unjoined'} ${channel.mentions > 0 ? 'mentioned' : ''}`} onClick={() => selectChannel(channel)}>{channel.is_private ? <LockClosedIcon /> : <HashtagIcon />}<span>{channel.name}</span>{channel.unread > 0 && <b>{channel.unread}</b>}</button>)}</nav>
    </SidebarSection>
    <SidebarSection key={`${workspace.id}-${selfId}-dms`} id="sidebar-dms" title="Direct messages" icon={<DmSectionIcon />} preferenceKey={`await.sidebar.${selfId}.${workspace.id}.dms`} forceOpen={Boolean(search.trim())} count={channels.filter((item) => item.is_dm).reduce((sum, item) => sum + item.unread, 0)} countLabel="Unread direct messages" action={<button type="button" className="icon-button" title="New direct message" aria-label="New direct message" onClick={() => { setError(''); setModal('dm'); }}><PlusIcon /></button>}>
    <nav className="dm-nav" aria-label="Direct messages">{filteredDms.map((channel) => <button type="button" key={channel.id} aria-current={channel.id === channelId ? 'page' : undefined} className={`dm-item ${channel.id === channelId ? 'active' : ''}`} onClick={() => selectChannel(channel)}><Avatar member={dmPartner(channel)} size="small" /><span>{dmPartner(channel)?.name ?? 'Teammate'}</span>{channel.unread > 0 && <b>{channel.unread}</b>}</button>)}</nav>
    </SidebarSection>
  </>;

  function focusComposer() {
    document.querySelector<HTMLElement>('.chat-pane .composer-edit-area .ProseMirror')?.focus();
  }

  async function shareWork(kind: 'task' | 'board' | 'document', title: string, url: string) {
    if (!activeChannel) return;
    const safeTitle = title.replace(/[\[\]\n]/g, ' ').trim();
    // A card from this channel's boards becomes a live reference chip; boards and documents keep a link card.
    const taskId = kind === 'task' ? url.match(taskLinkPattern)?.[1] : undefined;
    const body = taskId && url.startsWith(`/w/${workspace.id}/${activeChannel.id}?`) ? tagText('task', decodeURIComponent(taskId)) : `Shared a ${kind}: [${safeTitle}](${url})`;
    await post(`/workspaces/${workspace.id}/channels/${activeChannel.id}/messages`, { body, client_id: crypto.randomUUID() });
    void queryClient.invalidateQueries({ queryKey: ['messages', workspace.id, activeChannel.id] });
    navigate(`/w/${workspace.id}/${activeChannel.id}`);
  }
  const agentDirectoryContent = <>
      <div className="agent-directory-intro"><div className="agent-directory-toolbar">{workspace.role !== 'member' && <button type="button" className="button subtle" onClick={() => { setError(''); setModal('workspaceSettings'); }}>Agent limits</button>}<button type="button" className="button secondary" aria-expanded={showAgentForm} aria-controls="add-agent-form" onClick={() => { setError(''); setAddingAgent(true); }}><PlusIcon /> Add agent</button></div></div>
      {agents.length > 0 ? <ul className="agent-directory-list" role="list">{agents.map((agent) => <li className="agent-directory-row" key={agent.account_id}>
        <Avatar member={agent} />
        <div className="agent-directory-info"><div className="agent-directory-name"><strong>{agent.name}</strong><span className={`agent-status ${agent.paused ? 'paused' : onlineIds.has(agent.account_id) ? 'connected' : ''}`}>{agent.paused ? 'Paused' : onlineIds.has(agent.account_id) ? 'Connected' : 'Active'}</span></div><p>{agent.description || `Owned by ${members.find((member) => member.account_id === agent.owner_id)?.name ?? 'a teammate'}`}</p></div>
        <div className="agent-directory-actions">{canManageAgent(agent) && <button type="button" className="button secondary" aria-label={`Manage ${agent.name}${Number(agent.pending_count) > 0 ? `, ${agent.pending_count} posts awaiting review` : ''}`} onClick={() => { setError(''); setSelectedAgentId(agent.account_id); setModal('agentActivity'); }}>{Number(agent.pending_count) > 0 ? <>Review <span className="agent-review-count">{agent.pending_count}</span></> : 'Manage'}</button>}<button type="button" className="button subtle" aria-label={`${agent.paused ? 'Resume' : 'Pause'} ${agent.name}`} disabled={pausingAgentId === agent.account_id} onClick={() => void setAgentPaused(agent.account_id, !agent.paused)}>{pausingAgentId === agent.account_id ? 'Saving…' : agent.paused ? 'Resume' : 'Pause'}</button></div>
      </li>)}</ul> : <div className="agent-directory-empty"><strong>Add your first agent teammate</strong><p>Give it a name and a role, then connect it to your workspace.</p></div>}
      {agentSetup && <AgentSetup key={agentSetup.token} token={agentSetup.token} mcpUrl={agentSetup.mcpUrl} channels={channels.filter((item) => item.joined && !item.is_dm)} initialChannelId={activeChannel?.joined && !activeChannel.is_dm ? activeChannel.id : channels.find((item) => item.joined && !item.is_dm)?.id} alreadyInInitialChannel={activeChannel?.joined && !activeChannel.is_dm ? channelMembers.data?.some((member) => member.account_id === agentSetup.agentId) : false} onAddToChannel={addSetupAgentToChannel} />}
      {showAgentForm && <form id="add-agent-form" className="modal-form agent-create-form" onSubmit={createAgent}>
        <div className="agent-create-heading"><h3>Add an agent</h3>{agents.length > 0 && <button type="button" className="icon-button" aria-label="Cancel adding agent" disabled={creatingAgent} onClick={() => setAddingAgent(false)}><XMarkIcon /></button>}</div>
        <label htmlFor="agent-name">Name</label><input id="agent-name" name="agent-name" placeholder="Research agent" value={newAgent} onChange={(event) => setNewAgent(event.target.value)} required />
        <label htmlFor="agent-description">What does it do?</label><input id="agent-description" name="agent-description" placeholder="Finds evidence and answers questions" value={agentDescription} onChange={(event) => setAgentDescription(event.target.value)} />
        <label htmlFor="agent-avatar">Photo <span className="agent-field-optional">(optional)</span></label><input id="agent-avatar" name="agent-avatar" type="file" accept="image/png,image/jpeg,image/webp" />
        <div className="modal-actions">{agents.length > 0 && <button type="button" className="button secondary" disabled={creatingAgent} onClick={() => setAddingAgent(false)}>Cancel</button>}<button type="submit" className="button primary" disabled={creatingAgent}>{creatingAgent ? 'Creating…' : 'Create agent'}</button></div>
      </form>}
      {error && <p className="error-banner agent-directory-error" role="alert">{error}</p>}
    </>;
  const agentDetailContent = selectedAgentId ? <>
      <div className="agent-activity-modal">
        <button type="button" className="text-button" onClick={() => setModal('agent')}>← All agents</button>
        <div className="agent-activity-profile"><Avatar member={members.find((member) => member.account_id === selectedAgentId)} /><div><strong>{members.find((member) => member.account_id === selectedAgentId)?.name}</strong><p>{selectedAgent?.owner_id === selfId ? 'Owned by you' : `Owned by ${displayMembers.find((member) => member.account_id === selectedAgent?.owner_id)?.name ?? 'a former teammate'}`}</p>{agentActivity.data && <p>{agentActivity.data.last_active_at ? `Last active ${shortTime(agentActivity.data.last_active_at)}` : 'No activity yet'}</p>}</div></div>
        <div className="agent-profile-actions">{selectedAgent && canManageAgent(selectedAgent) && <><label className="agent-photo-button">Change photo<input type="file" name="agent-photo" accept="image/png,image/jpeg,image/webp" aria-label={`Change ${selectedAgent.name} photo`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAgentAvatar(selectedAgent.account_id, file); event.target.value = ''; }} /></label><button type="button" className="button secondary" onClick={() => void rotateAgentToken(selectedAgent)}>Rotate token</button></>}{selectedAgent && <button type="button" className="button secondary" disabled={pausingAgentId === selectedAgentId} onClick={() => void setAgentPaused(selectedAgentId, !selectedAgent.paused)}>{pausingAgentId === selectedAgentId ? 'Saving…' : selectedAgent.paused ? 'Resume agent' : 'Pause agent'}</button>}</div>
        {/* Posts waiting for approval come first: the Inbox sends reviewers here. */}
        {Boolean(pendingPosts.data?.length) && <h3>To review <span className="agent-review-count">{pendingPosts.data!.length}</span></h3>}
        {pendingPosts.isError && <p role="alert">Could not load proposed posts. <button type="button" className="text-button" onClick={() => void pendingPosts.refetch()}>Try again</button></p>}
        <div className="agent-pending-list">
          {pendingPosts.data?.map((item) => <div className="agent-pending-card" key={item.id}>
            <div className="agent-pending-meta">
              <strong>
                {channels.find((channel) => channel.id === item.channel_id) ? `#${channels.find((channel) => channel.id === item.channel_id)?.name}` : 'Private channel'}
              </strong>
              <time>{shortTime(item.created_at)}</time>
            </div>
            <p className="agent-pending-body">{item.body || 'File attachment'}</p>
            {Boolean(item.attachment_names?.length) && <div className="agent-pending-files">
              {(JSON.parse(item.attachment_ids) as string[]).map((fileId, index) => <a key={fileId} href={`/api/workspaces/${workspace.id}/agents/${selectedAgentId}/pending/${item.id}/files/${fileId}`} target="_blank" rel="noreferrer">
                {item.attachment_names?.[index] ?? "File"}
              </a>)}
            </div>}
            <div className="agent-pending-actions">
              <button type="button" className="button secondary" disabled={reviewingPostId === item.id} onClick={() => void reviewAgentPost(item.id, 'reject')}>Reject</button>
              <button type="button" className="button primary" disabled={reviewingPostId === item.id} onClick={() => void reviewAgentPost(item.id, 'approve')}>
                {reviewingPostId === item.id ? 'Reviewing…' : 'Approve and post'}
              </button>
            </div>
          </div>)}
        </div>
        <AgentChannelAccess workspaceId={workspace.id} agentId={selectedAgentId} allChannels={Boolean(members.find((member) => member.account_id === selectedAgentId)?.all_channels)} canManage={workspace.role !== 'member'} />
        <div className="agent-approval-setting"><div><strong>Approve posts before sharing</strong><p>Proposed messages stay private until an owner approves them.</p></div><label className="agent-approval-toggle"><input type="checkbox" checked={Boolean(members.find((member) => member.account_id === selectedAgentId)?.approval_mode)} onChange={(event) => void action(`/agents/${selectedAgentId}/approval`, { enabled: event.target.checked })} /><span>Require approval</span></label></div>
        <AgentWebhookSettings workspaceId={workspace.id} agentId={selectedAgentId} />
        {error && <p className="error-banner" role="alert">{error}</p>}
        <h3>Recent activity</h3>
        {agentActivity.isPending && <p>Loading activity…</p>}
        {agentActivity.isError && <p role="alert">Could not load activity. <button type="button" className="text-button" onClick={() => void agentActivity.refetch()}>Try again</button></p>}
        {agentActivity.data?.entries.length === 0 && <p>This agent has not used its tools yet.</p>}
        <div className="agent-activity-list">{agentActivity.data?.entries.map((entry) => {
          const channel = channels.find((item) => item.id === entry.channel_id);
          const place = channel ? `#${channel.name}` : entry.channel_id ? 'a private channel' : 'the workspace';
          const label = ({ list_channels: 'Listed channels', list_members: 'Viewed members', read_messages: 'Read messages', read_thread: 'Read a thread', show_channel: 'Viewed a channel', get_agent_context: 'Checked agent context', 'settings.read': 'Viewed agent settings', 'settings.update': 'Updated agent settings', list_files: 'Listed files', get_file: 'Read a file', read_board: 'Viewed a board', list_boards: 'Listed boards', list_documents: 'Listed documents', read_document: 'Read a document', get_attachment: 'Read a file', post_message: 'Posted a message', request_post: 'Proposed a message', get_mentions: 'Checked mentions', mark_read: 'Marked messages read' } as Record<string, string>)[entry.action] ?? entry.action.replace(/[._]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
          const detail = entry.target_name ? `${place} · ${entry.target_name}` : place;
          const targetUrl = channel && entry.target_id && ['post_message', 'read_thread'].includes(entry.action) ? `/w/${workspace.id}/${entry.channel_id}?thread=${entry.target_id}` : null;
          return <div className="agent-activity-item" key={entry.id}><span className={`agent-activity-mark ${entry.action === 'post_message' ? 'posted' : ''}`}>{entry.action === 'post_message' ? <PaperAirplaneIcon /> : <DocumentIcon />}</span><div><strong>{label}</strong><p>{detail}</p></div><time title={new Date(entry.created_at).toLocaleString()}>{shortTime(entry.created_at)}</time>{targetUrl && <a href={targetUrl} aria-label={`Open ${label.toLowerCase()} in ${place}`} onClick={(event) => { setModal(null); openAppLink(event, targetUrl); }}><ArrowRightIcon /></a>}</div>;
        })}</div>
        {members.find((member) => member.account_id === selectedAgentId && canManageAgent(member)) && <button type="button" className="button danger" disabled={removingMemberId === selectedAgentId} onClick={() => { const agent = members.find((member) => member.account_id === selectedAgentId); if (agent) void removeAgent(agent); }}>{removingMemberId === selectedAgentId ? 'Removing…' : 'Remove agent'}</button>}
      </div>
    </> : null;
  const peopleSettingsContent = <>
      <div className="people-modal-intro">{workspace.role !== 'member' && <button type="button" className="button secondary" disabled={creatingInvite} onClick={() => void invite()}><PlusIcon /> {creatingInvite ? 'Creating invite…' : 'Invite people'}</button>}</div>
      <div className="member-list people-list">{members.filter((member) => member.kind === 'human').map((member) => <div key={member.account_id} className="member-row"><Avatar member={member} /><div><div className="member-name-line"><strong>{member.name}</strong>{member.account_id === selfId && <span className="people-you">You</span>}</div><p>{member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'Member'}</p></div>{workspace.role !== 'member' && member.account_id !== selfId && member.role !== 'owner' && (workspace.role === 'owner' || member.role !== 'admin') && <button type="button" className="button secondary people-remove" disabled={removingMemberId === member.account_id} onClick={() => void removePerson(member)}>{removingMemberId === member.account_id ? 'Removing…' : 'Remove'}</button>}</div>)}</div>
      {error && <p className="error-banner people-error" role="alert">{error}</p>}
    </>;
  const accountSettingsContent = <div className="account-settings">
    <div className="settings-section-heading"><h3>Your account</h3></div>
    <form className="modal-form settings-profile-form" onSubmit={(event) => void saveProfile(event)}>
      <label htmlFor="profile-name">Display name</label><input id="profile-name" name="profile-name" value={profileName} onChange={(event) => { setProfileName(event.target.value); setProfileSaved(false); }} minLength={2} maxLength={80} required />
      <p>This is how teammates see your name in messages and mentions.</p>
      <div className="settings-profile-actions"><button type="submit" className="button primary" disabled={profileSaving}>{profileSaving ? 'Saving…' : 'Save name'}</button>{profileSaved && <p role="status"><CheckIcon /> Profile saved.</p>}</div>
    </form>
    <section className="settings-notifications" aria-labelledby="settings-notifications-heading"><h4 id="settings-notifications-heading">Notifications</h4><p>Choose what reaches your inbox when you are away.</p>
      {notificationSettings.isPending && <p>Loading preferences…</p>}
      {notificationSettings.isError && <p role="alert">Preferences could not load. <button type="button" className="text-button" onClick={() => void notificationSettings.refetch()}>Try again</button></p>}
      {notificationSettings.data && <><label><input type="checkbox" name="email-mentions" checked={notificationSettings.data.email_mentions} disabled={notificationSaving} onChange={(event) => void updateNotifications('email_mentions', event.target.checked)} /><span><strong>Mentions</strong><small>Email me when someone mentions me.</small></span></label><label><input type="checkbox" name="email-dms" checked={notificationSettings.data.email_dms} disabled={notificationSaving} onChange={(event) => void updateNotifications('email_dms', event.target.checked)} /><span><strong>Direct messages</strong><small>Email me when someone sends a direct message.</small></span></label>{!notificationSettings.data.email_available && <p className="hint">Email delivery is being set up.</p>}</>}
      {typeof Notification !== 'undefined' && <button type="button" className="button secondary" onClick={() => void Notification.requestPermission()}>Enable browser alerts</button>}
    </section>
    {error && <p className="error-banner" role="alert">{error}</p>}
  </div>;
  // Phones show the first four and keep the rest under More.
  const railItems = [
    { id: 'chat', label: 'Home', icon: HomeIcon },
    { id: 'boards', label: 'Tasks', icon: Squares2X2Icon },
    { id: 'projects', label: 'Projects', icon: RectangleStackIcon },
    { id: 'inbox', label: 'Inbox', icon: InboxIcon },
    { id: 'git', label: 'Git', icon: CodeBracketIcon },
    { id: 'files', label: 'Files', icon: FolderOpenIcon },
  ] as const;
  const primaryRail: readonly string[] = ['chat', 'boards', 'projects', 'inbox'];
  const inboxCount = pendingAgentCount + channels.reduce((sum, channel) => sum + (channel.joined ? channel.mentions : 0), 0);
  const railView = view === 'tasks' ? 'boards' : view === 'docs' ? 'files' : libraryView === 'threads' || libraryView === 'drafts' ? 'chat' : libraryView ?? 'chat';
  return <div className="app-shell workspace-shell isolate">
    <nav className="workspace-rail" aria-label="Workspace navigation">
      <div className="rail-links">{railItems.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={`rail-item ${primaryRail.includes(id) ? 'rail-primary' : 'rail-secondary'} ${railView === id ? 'selected' : ''}`} aria-current={railView === id ? 'page' : undefined} onClick={() => openWorkspaceView(id)}><span className="rail-icon"><Icon aria-hidden="true" />{id === 'inbox' && inboxCount > 0 && <span className="rail-badge" aria-label={`${inboxCount} waiting in your inbox`}>{inboxCount}</span>}</span><span>{label}</span></button>)}<button type="button" className={`rail-item rail-more ${!primaryRail.includes(railView) ? 'selected' : ''}`} aria-haspopup="dialog" aria-expanded={mobileMore} onClick={() => setMobileMore(true)}><span className="rail-icon"><EllipsisHorizontalIcon aria-hidden="true" /></span><span>More</span></button></div>
      <button type="button" className="rail-settings" aria-label="Settings" title="Settings" onClick={() => openSettingsSection('appearance')}><Cog6ToothIcon /></button>
      <button type="button" className="rail-profile" aria-label="Your account" title="Your account" onClick={() => openSettingsSection('account')}><Avatar member={members.find((member) => member.account_id === selfId)} size="small" /></button>
    </nav>
    {mobileMore && <Modal title="More" className="mobile-more-modal" onClose={() => setMobileMore(false)}><nav className="mobile-more-links" aria-label="More destinations">{railItems.filter(({ id }) => !primaryRail.includes(id)).map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={railView === id ? 'page' : undefined} onClick={() => { setMobileMore(false); openWorkspaceView(id); }}><Icon aria-hidden="true" /><span>{label}</span>{railView === id && <CheckIcon aria-hidden="true" />}</button>)}<button type="button" onClick={() => { setMobileMore(false); openSettingsSection('appearance'); }}><Cog6ToothIcon aria-hidden="true" /><span>Settings</span></button></nav></Modal>}
    <div className="body-layout">
      <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <div className="workspace-picker" ref={workspaceMenuRef}>
            <button type="button" className="workspace-button" aria-label="Choose workspace" aria-haspopup="menu" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}>
              <span className="workspace-badge">{workspace.name.slice(0, 1).toUpperCase()}</span>
              <span className="workspace-name">{workspace.name}</span>
              <ChevronDownIcon />
            </button>
            {workspaceMenuOpen && <div className="workspace-menu" role="menu">
              {workspaces.map((item) => <button type="button" role="menuitem" tabIndex={-1} key={item.id} className={item.id === workspace.id ? "selected" : ""} onClick={() => { setWorkspaceMenuOpen(false); setMobileMenu(false); navigate(`/w/${item.id}`); }}>
                {item.name}
                {item.id === workspace.id && <CheckIcon />}
              </button>)}
              <div className="workspace-menu-divider" />
              <button type="button" role="menuitem" tabIndex={-1} className="workspace-menu-action" onClick={() => { setWorkspaceMenuOpen(false); setMobileMenu(false); setError(''); setModal('people'); }}><UserGroupIcon /> Manage people</button>
              {workspace.role !== 'member' && <button type="button" role="menuitem" tabIndex={-1} className="workspace-menu-action" onClick={() => { setWorkspaceMenuOpen(false); setMobileMenu(false); setModal('workspaceSettings'); }}><SparklesIcon /> Agent limits</button>}
            </div>}
          </div>
          <button type="button" className="icon-button mobile-sidebar-close" aria-label="Close navigation" onClick={() => setMobileMenu(false)}>
            <XMarkIcon />
          </button>
        </div>
        <div className="sidebar-search">
          <MagnifyingGlassIcon />
          <input name="channel-search" aria-label="Find a conversation" placeholder="Find a conversation" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearch(''); event.currentTarget.blur(); setMobileMenu(false); } else if (event.key === 'Enter') { const first = filteredChannels[0] ?? filteredDms[0]; if (first) { event.preventDefault(); selectChannel(first); setSearch(''); } } }} />
        </div>
        <div className="sidebar-scroll">
          <nav className="sidebar-shortcuts" aria-label="Conversation tools">
            <button type="button" className={view === 'threads' ? 'selected' : ''} onClick={() => openWorkspaceView('threads')}><ChatBubbleLeftRightIcon /> Threads</button>
            <button type="button" className={view === 'drafts' ? 'selected' : ''} onClick={() => openWorkspaceView('drafts')}><PencilSquareIcon /> Drafts</button>
            <button type="button" onClick={() => { setMobileMenu(false); setModal('agent'); }}><SparklesIcon /> Agents{pendingAgentCount > 0 && <b>{pendingAgentCount}</b>}</button>
          </nav>
          {snapshot.isPaused && !snapshot.data ? <LoadNotice compact title="You are offline" detail="Reconnect to load channels." onRetry={() => void snapshot.refetch()} /> : snapshot.isError && !snapshot.data ? <LoadNotice compact title="Channels could not load" detail={snapshot.error instanceof ApiError ? snapshot.error.message : 'Check your connection and try again.'} onRetry={() => void snapshot.refetch()} /> : channelList}
        </div>
        <div className="sidebar-footer">
          {!connected && <p className="sidebar-connection" role="status">Reconnecting…</p>}
          <button type="button" className="sidebar-settings-button" aria-haspopup="dialog" onClick={() => { setAgentSetup(null); setAddingAgent(false); setMobileMenu(false); openSettingsSection('appearance'); }}>
            <span className="sidebar-settings-icon"><Cog6ToothIcon /></span>
            <span>Settings</span>
            {pendingAgentCount > 0 && <b className="sidebar-section-count" aria-label={`${pendingAgentCount} agent posts awaiting review`}>
              {pendingAgentCount}
            </b>}
          </button>
          <div className="create-menu-anchor" ref={createMenuRef}>
            <CreateMenu canInvite={workspace.role !== 'member'} open={createMenuOpen} onToggle={() => setCreateMenuOpen((open) => !open)} onChoose={chooseCreate} />
          </div>
          <div className="profile-menu-anchor" ref={profileMenuRef}>
            {profileMenuOpen && <div className="profile-popover" role="group" aria-label="Account menu">
              <div className="profile-popover-heading">
                <Avatar member={members.find((member) => member.account_id === selfId)} />
                <div>
                  <strong>{members.find((member) => member.account_id === selfId)?.name ?? 'You'}</strong>
                  <small>{selfEmail}</small>
                </div>
              </div>
              <button type="button" className="profile-menu-item" onClick={() => { setProfileMenuOpen(false); openSettingsSection('account'); }}><Cog6ToothIcon /> Your account</button>
              <button type="button" className="profile-menu-item" onClick={() => void post('/logout').then(() => window.location.reload()).catch((cause) => { setProfileMenuOpen(false); setError(cause instanceof Error ? cause.message : 'Could not sign out. Try again.'); })}>Sign out</button>
            </div>}
            <button type="button" className="profile-row" aria-label="Account menu" aria-expanded={profileMenuOpen} onClick={() => { setProfileMenuOpen((open) => !open); }}>
              <Avatar member={members.find((member) => member.account_id === selfId)} size="small" />
              <span>{members.find((member) => member.account_id === selfId)?.name ?? 'You'}</span>
              <ChevronDownIcon />
            </button>
          </div>
        </div>
      </aside>
      {mobileMenu && <button type="button" className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}

      <main className="chat-pane">
        {libraryView ? <>
          <div className="chat-header workspace-page-header">
            <button type="button" className="icon-button mobile-toggle" aria-label="Open navigation" onClick={() => setMobileMenu(true)}>
              <Bars3Icon />
            </button>
            <h1>{viewTitles[libraryView]}</h1>
          </div>
          <WorkspaceViews key={`${workspace.id}-${libraryView}`} view={libraryView} workspaceId={workspace.id} selfId={selfId} channels={channels} members={members} role={workspace.role} onCreate={(kind) => { setCreateTarget(kind); }} onAgent={(id) => { setSelectedAgentId(id ?? null); setModal(id ? 'agentActivity' : 'agent'); }} />
        </> : activeChannel ? <>
          <div className="chat-header">
            <button type="button" className="icon-button mobile-toggle" aria-label="Open navigation" onClick={() => setMobileMenu(true)}>
              <Bars3Icon />
            </button>
            <div className="chat-heading">
              <div className="chat-title">
                {activeChannel.is_dm ? <Avatar member={activePartner} size="small" /> : activeChannel.is_private ? <LockClosedIcon /> : <HashtagIcon />}
                <h1>{activeChannel.is_dm ? activePartner?.name ?? "Direct message" : activeChannel.name}</h1>
              </div>
              {activeChannel.description && <p className="channel-description">{activeChannel.description}</p>}
            </div>
            <div className="header-actions">
              {!activeChannel.is_dm && activeChannel.joined && (view === 'chat' ? <div className="header-menu-anchor" ref={workMenuRef}>
                <button type="button" aria-haspopup="menu" className="button subtle work-button" aria-expanded={workMenuOpen} onClick={() => { setWorkMenuOpen((open) => !open); setHeaderMenuOpen(false); }}>In this channel <ChevronDownIcon /></button>
                {workMenuOpen && <div className="header-menu" role="menu">
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setWorkMenuOpen(false); navigate(`/w/${workspace.id}/${channelId}?view=tasks`); }}><Squares2X2Icon /> Task boards</button>
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setWorkMenuOpen(false); navigate(`/w/${workspace.id}/${channelId}?view=docs`); }}><DocumentIcon /> Documents</button>
                </div>}
              </div> : <button type="button" className="button subtle back-chat-button" onClick={() => navigate(`/w/${workspace.id}/${channelId}`)}><ArrowLeftIcon /> Chat</button>)}
              {activeChannel.joined ? <button type="button" className="button subtle members-button" onClick={() => setModal('members')}><UserGroupIcon /> Members</button> : <button type="button" className="button primary" onClick={() => void action(`/channels/${activeChannel.id}/join`)}>Join channel</button>}
              {activeChannel.joined && <div className="header-menu-anchor" ref={headerMenuRef}>
                <button type="button" aria-haspopup="menu" className="icon-button more-button" title="More options" aria-label="More options" aria-expanded={headerMenuOpen} onClick={() => { setHeaderMenuOpen((open) => !open); setWorkMenuOpen(false); }}>
                  <EllipsisHorizontalIcon />
                </button>
                {headerMenuOpen && <div className="header-menu" role="menu">
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setHeaderMenuOpen(false); setModal('members'); }}><UserGroupIcon /> Members</button>
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setHeaderMenuOpen(false); setModal('channelNotifications'); }}><BellIcon /> Notifications</button>
                  {!activeChannel.is_dm && <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setHeaderMenuOpen(false); setChannelRename(activeChannel.name); setModal('channelSettings'); }}><EllipsisHorizontalIcon /> Channel settings</button>}
                </div>}
              </div>}
            </div>
          </div>
          {error && <div className="inline-error" role="alert">
            {error}
            <button type="button" onClick={() => setError('')} aria-label="Dismiss"><XMarkIcon /></button>
          </div>}
          {activeChannel.joined ? view === 'tasks' ? <TasksView key={`${workspace.id}-${channelId}`} workspaceId={workspace.id} channelId={channelId} members={members} createSignal={createRequest?.kind === 'tasks' ? createRequest.id : 0} onCreateHandled={() => setCreateRequest(null)} requestedBoardId={new URLSearchParams(window.location.search).get('board') ?? undefined} requestedTaskId={new URLSearchParams(window.location.search).get('task') ?? undefined} onShare={shareWork} /> : view === 'docs' ? <DocsView key={`${workspace.id}-${channelId}`} workspaceId={workspace.id} channelId={channelId} members={members} createSignal={createRequest?.kind === 'docs' ? createRequest.id : 0} onCreateHandled={() => setCreateRequest(null)} requestedDocumentId={new URLSearchParams(window.location.search).get('doc') ?? undefined} onShare={shareWork} /> : <>
            <div className="message-scroll" ref={scrollRef} onScroll={(event) => { const pane = event.currentTarget; atBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80; }}>
              {messages.isPaused && !messages.data && <LoadNotice title="You are offline" detail="Reconnect to load this conversation." onRetry={() => void messages.refetch()} />}
              {messages.isPending && !messages.isPaused && <div className="empty-state">Loading conversation…</div>}
              {messages.isError && !messages.data && <LoadNotice title="Conversation could not load" detail="Your messages are still here. Try loading them again." onRetry={() => void messages.refetch()} />}
              {hasEarlier && (messages.data?.length ?? 0) >= 50 && <div className="history-actions">
                <button type="button" className="button secondary" disabled={loadingEarlier} onClick={() => void loadEarlier()}>
                  {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>}
              {messages.data && messages.data.length > 0 && <div className="conversation">
                <div className="channel-intro">
                  <span className="channel-intro-icon">{activeChannel.is_dm ? <ChatBubbleLeftRightIcon /> : <HashtagIcon />}</span>
                  <h2>
                    {activeChannel.is_dm ? `Your conversation with ${activePartner?.name ?? "a teammate"}` : `Welcome to #${activeChannel.name}`}
                  </h2>
                  <p>
                    {activeChannel.is_dm ? "Only the people in this direct message can see it." : "This is the start of your team’s conversation."}
                  </p>
                </div>
                {messages.data.map((message, index) => <Fragment key={message.id}>
                  {beginsCalendarDay(messages.data, index) && index !== unreadStartIndex && <div className="date-separator" role="separator" aria-label={timelineDayLabel(message.created_at)}>
                    <span>{timelineDayLabel(message.created_at)}</span>
                  </div>}
                  {index === unreadStartIndex && <div className="unread-divider" role="separator" aria-label="New messages">
                    <span>
                      {beginsCalendarDay(messages.data, index) ? `${timelineDayLabel(message.created_at)} · New messages` : "New messages"}
                    </span>
                  </div>}
                  <MessageItem message={message} members={displayMembers} channels={channels} workspaceId={workspace.id} selfId={selfId} canModerate={workspace.role !== 'member'} onThread={openThread} onAgent={(agent) => canManageAgent(agent) ? () => { setError(''); setSelectedAgentId(agent.account_id); setModal('agentActivity'); } : null} onEdit={saveEdit} onDelete={(item) => { if (window.confirm('Delete this message?')) void action(`/messages/${item.id}/delete`); }} onReact={toggleReaction} onEditDrawing={(message, attachment) => void openDrawing(message, attachment)} />
                </Fragment>)}
              </div>}
              {messages.data?.length === 0 && <div className="empty-channel">
                <div className="empty-icon"><ChatBubbleLeftRightIcon /></div>
                <h2>{activeChannel.is_dm ? 'A space for this conversation' : `Welcome to #${activeChannel.name}`}</h2>
                <p>
                  {activeChannel.is_dm ? 'Send the first message to get the conversation going.' : 'Start with a message, then bring tasks, documents, and agents into the discussion.'}
                </p>
                <div className="empty-channel-actions">
                  <button type="button" className="button primary" onClick={focusComposer}><ChatBubbleLeftRightIcon /> Write a message</button>
                  {!activeChannel.is_dm && <button type="button" className="button secondary" onClick={() => startWorkCreation('tasks')}><Squares2X2Icon /> Create a task board</button>}
                </div>
              </div>}
            </div>
            <Composer key={`${channelId}-main`} channel={activeChannel.is_dm ? { ...activeChannel, name: activePartner?.name ?? "teammate" } : activeChannel} channels={channels} workspaceId={workspace.id} selfId={selfId} members={members} socket={socket} onOptimistic={optimisticSend} onSettled={settleSend} typingLabel={typingLabel(channelId, null)} onSent={(transport) => { if (transport === 'http' || !queryClient.getQueryData(['messages', workspace.id, channelId])) void queryClient.invalidateQueries({ queryKey: ['messages', workspace.id, channelId] }); }} onDraw={() => { setDrawingDraft({ channelId }); setModal('drawing'); }} />
          </> : <div className="empty-state">Join this channel to read and participate.</div>}
        </> : snapshot.isPaused && !snapshot.data ? <LoadNotice title="You are offline" detail="Reconnect to load this workspace." onRetry={() => void snapshot.refetch()} /> : snapshot.isError && !snapshot.data ? <LoadNotice title="Workspace could not load" detail={snapshot.error instanceof ApiError ? snapshot.error.message : 'Check your connection and try again.'} onRetry={() => void snapshot.refetch()} /> : <MissingChannel workspaceId={workspace.id} channelId={channelId} channels={channels} />}
      </main>

      {view === 'chat' && threadId && activeChannel && <aside className="thread-pane">
        <div className="thread-header">
          <div className="thread-heading">
            <h2>Thread</h2>
            <span>{activeChannel.is_dm ? activePartner?.name ?? "Direct message" : `#${activeChannel.name}`}</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close thread" onClick={() => navigate(`/w/${workspace.id}/${channelId}`)}>
            <XMarkIcon />
          </button>
        </div>
        <div className="thread-scroll">
          {thread.isPaused && !thread.data && <LoadNotice title="You are offline" detail="Reconnect to load this thread." onRetry={() => void thread.refetch()} />}
          {thread.isPending && !thread.isPaused && <div className="empty-state">Loading thread…</div>}
          {thread.isError && !thread.data && <LoadNotice title="Thread could not load" detail="Try opening these replies again." onRetry={() => void thread.refetch()} />}
          {thread.data?.map((message, index) => <Fragment key={message.id}>
            {beginsCalendarDay(thread.data, index) && <div className="date-separator" role="separator" aria-label={timelineDayLabel(message.created_at)}>
              <span>{timelineDayLabel(message.created_at)}</span>
            </div>}
            <MessageItem message={message} members={displayMembers} channels={channels} workspaceId={workspace.id} selfId={selfId} canModerate={workspace.role !== 'member'} onAgent={(agent) => canManageAgent(agent) ? () => { setError(''); setSelectedAgentId(agent.account_id); setModal('agentActivity'); } : null} onEdit={saveEdit} onDelete={(item) => { if (window.confirm('Delete this message?')) void action(`/messages/${item.id}/delete`); }} onReact={toggleReaction} onEditDrawing={(message, attachment) => void openDrawing(message, attachment)} />
          </Fragment>)}
          {thread.data?.length === 1 && <p className="thread-prompt">Be the first to reply.</p>}
        </div>
        <Composer key={`${channelId}-${threadId}`} channel={activeChannel.is_dm ? { ...activeChannel, name: activePartner?.name ?? "teammate" } : activeChannel} channels={channels} threadId={threadId} focusRequest={replyFocus?.channelId === channelId && replyFocus.threadId === threadId ? replyFocus.sequence : 0} workspaceId={workspace.id} selfId={selfId} members={members} socket={socket} onOptimistic={optimisticSend} onSettled={settleSend} typingLabel={typingLabel(channelId, threadId)} onSent={(transport) => { if (transport === 'http' || !queryClient.getQueryData(['thread', workspace.id, channelId, threadId])) void queryClient.invalidateQueries({ queryKey: ['thread', workspace.id, channelId, threadId] }); }} onDraw={() => { setDrawingDraft({ channelId, threadId }); setModal('drawing'); }} />
      </aside>}
    </div>
    {createTarget && <Modal title="Choose a channel" onClose={() => setCreateTarget(null)}><div className="modal-form"><p>{createTarget === 'docs' ? 'Choose where this document belongs.' : 'Choose where this task board belongs.'}</p><div className="create-channel-choices">{channels.filter((item) => item.joined && !item.is_dm && !item.archived_at).map((item) => <button type="button" key={item.id} onClick={() => openWorkCreation(createTarget, item.id)}><HashtagIcon /><span>{item.name}</span><ArrowRightIcon /></button>)}</div></div></Modal>}
    {modal === 'channel' && <Modal title="Create a channel" onClose={() => setModal(null)}><form className="modal-form" onSubmit={createChannel}><p>Give this conversation a clear purpose. People can join public channels on their own.</p><label htmlFor="channel-name">Channel name</label><input id="channel-name" name="channel-name" placeholder="product-design" value={newChannel} onChange={(event) => setNewChannel(event.target.value)} required /><label className="check-row"><input type="checkbox" name="private" checked={privateChannel} onChange={(event) => setPrivateChannel(event.target.checked)} /><span>Private channel</span></label>{error && <p className="error-banner">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button primary">Create channel</button></div></form></Modal>}
    {modal === 'dm' && <Modal title="New direct message" onClose={() => setModal(null)}><div className="modal-form"><p>Choose a teammate or agent. This conversation will be private to the two of you.</p>{error && <p className="error-banner">{error}</p>}<div className="dm-choices">{members.filter((member) => member.account_id !== selfId).map((member) => <button type="button" key={member.account_id} onClick={() => void createDm(member.account_id)}><Avatar member={member} size="small" /><span>{member.name}</span>{member.kind === 'agent' && <small>Agent</small>}</button>)}</div></div></Modal>}
    {modal === 'channelSettings' && activeChannel && <Modal title={`#${activeChannel.name} settings`} onClose={() => setModal(null)}><form className="modal-form" onSubmit={(event) => void renameChannel(event)}><p>Update this channel's name or manage your membership.</p><label htmlFor="rename-channel">Channel name</label><input id="rename-channel" name="rename-channel" value={channelRename} onChange={(event) => setChannelRename(event.target.value)} required />{error && <p className="error-banner">{error}</p>}<div className="modal-actions"><button type="submit" className="button primary">Save name</button></div><div className="channel-settings-actions">{activeChannel.name !== 'general' && <button type="button" className="button secondary" onClick={() => void leaveChannel()}>Leave channel</button>}{activeChannel.name !== 'general' && <button type="button" className="button danger" onClick={() => void archiveChannel()}>Archive channel</button>}</div></form></Modal>}
    {modal === 'channelNotifications' && activeChannel && <Modal title="Conversation notifications" onClose={() => setModal(null)}>
      <div className="channel-notification-options">
        <p>Choose which messages can alert you while Await is open in a background tab.</p>
        {(['all', 'mentions', 'none'] as const).map((choice) => <button type="button" key={choice} className={activeChannel.notify === choice ? 'selected' : ''} aria-pressed={activeChannel.notify === choice} onClick={() => void action(`/channels/${activeChannel.id}/notify`, { notify: choice })}>
          <span>
            <strong>
              {choice === 'all' ? 'All messages' : choice === 'mentions' ? activeChannel.is_dm ? 'Direct messages' : 'Mentions only' : 'None'}
            </strong>
            <small>
              {choice === 'all' ? 'Alert me for every new message.' : choice === 'mentions' ? activeChannel.is_dm ? 'Alert me when this person messages me.' : 'Alert me when someone mentions me.' : 'Keep this conversation quiet.'}
            </small>
          </span>
          {activeChannel.notify === choice && <CheckIcon />}
        </button>)}
        {error && <p className="error-banner" role="alert">{error}</p>}
      </div>
    </Modal>}
    {modal && ['settings', 'agent', 'agentActivity', 'people', 'profile', 'workspaceSettings'].includes(modal) && <SettingsDialog section={modal === 'settings' ? 'appearance' : modal === 'profile' ? 'account' : 'team'} onSectionChange={openSettingsSection} workspaceName={workspace.name} pendingCount={pendingAgentCount} onClose={() => { setAgentSetup(null); setModal(null); }}>
      {modal === 'profile' ? accountSettingsContent : <div className="settings-team">
        <div className="settings-section-heading"><h3>Members & agents</h3></div>
        <div className="settings-team-tabs" role="tablist" aria-label="Workspace teammates" onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'people' : event.key === 'End' ? 'agent' : modal === 'people' ? 'agent' : 'people';
          setError(''); setModal(next);
          const tabs = event.currentTarget;
          window.requestAnimationFrame(() => tabs.querySelector<HTMLButtonElement>(`[data-team-tab="${next}"]`)?.focus());
        }}>
          <button type="button" role="tab" id="settings-people-tab" data-team-tab="people" aria-selected={modal === 'people'} aria-controls="settings-team-panel" tabIndex={modal === 'people' ? 0 : -1} onClick={() => { setError(''); setModal('people'); }}>Members <span>{members.filter((member) => member.kind === 'human').length}</span></button>
          <button type="button" role="tab" id="settings-agents-tab" data-team-tab="agent" aria-selected={modal !== 'people'} aria-controls="settings-team-panel" tabIndex={modal !== 'people' ? 0 : -1} onClick={() => { setError(''); setModal('agent'); }}>Agents <span>{agents.length}</span>{pendingAgentCount > 0 && <b className="settings-pending-count" aria-label={`${pendingAgentCount} posts awaiting review`}>{pendingAgentCount}</b>}</button>
        </div>
        <div id="settings-team-panel" role="tabpanel" aria-labelledby={modal === 'people' ? 'settings-people-tab' : 'settings-agents-tab'}>
          {modal === 'people' ? peopleSettingsContent : modal === 'agentActivity' ? agentDetailContent : modal === 'workspaceSettings' ? <><button type="button" className="text-button settings-back" onClick={() => { setError(''); setModal('agent'); }}><ArrowLeftIcon /> All agents</button><h4 className="settings-detail-heading">Agent limits</h4><AgentLimitsSettings workspaceId={workspace.id} onClose={() => setModal('agent')} /></> : agentDirectoryContent}
        </div>
      </div>}
    </SettingsDialog>}
    {modal === 'invite' && <Modal title="Invite teammates" onClose={() => setModal(null)}><InviteDialogContent key={inviteUrl} url={inviteUrl} /></Modal>}
    {modal === 'members' && activeChannel && <Modal title={`#${activeChannel.name} members`} onClose={() => setModal(null)}>
      <div className="member-list">{channelMembers.data?.map((member) => <div key={member.account_id} className="member-row">
        <Avatar member={member} />
        <div><div className="member-name-line"><strong>{member.name}</strong>{member.kind === 'agent' && <span className="agent-badge"><SparklesIcon /> Agent</span>}</div><p>{member.kind === 'agent' ? member.muted ? 'Muted in this channel' : `Owned by ${members.find((item) => item.account_id === member.owner_id)?.name ?? 'a teammate'}` : `${member.role} · ${onlineIds.has(member.account_id) ? 'Online' : 'Offline'}`}</p></div>
        <div className="channel-member-actions">
          {member.kind === 'agent' && (workspace.role !== 'member' || member.owner_id === selfId) && <button type="button" className="button secondary agent-mute-button" disabled={mutingAgentId === member.account_id} onClick={() => void setAgentMute(member.account_id, !member.muted)}>{mutingAgentId === member.account_id ? 'Saving…' : member.muted ? 'Unmute' : 'Mute here'}</button>}
          {!activeChannel.is_dm && activeChannel.name !== 'general' && member.account_id !== selfId && (workspace.role !== 'member' || activeChannel.created_by === selfId || members.some((creator) => creator.account_id === activeChannel.created_by && creator.kind === 'agent' && creator.owner_id === selfId) || (member.kind === 'agent' && member.owner_id === selfId)) && <button type="button" className="button secondary channel-member-remove" aria-label={`Remove ${member.name} from #${activeChannel.name}`} disabled={savingChannelMemberId === member.account_id} onClick={() => void removeChannelMember(member)}>{savingChannelMemberId === member.account_id ? 'Removing…' : 'Remove'}</button>}
        </div>
      </div>)}</div>
      {!activeChannel.is_dm && channelMembers.data && members.some((member) => member.kind === 'human' && !channelMembers.data?.some((joined) => joined.account_id === member.account_id)) && <form className="modal-form" onSubmit={(event) => void addChannelTeammate(event)}>
        <h3>Add a teammate</h3>
        <p>They can read this channel's messages and files.</p>
        <div className="channel-member-add">
          <label className="sr-only" htmlFor="channel-member-select">Teammate</label>
          <select id="channel-member-select" name="channel-member" value={channelMemberToAdd} onChange={(event) => setChannelMemberToAdd(event.target.value)}>
            <option value="">Choose teammate</option>
            {members.filter((member) => member.kind === 'human' && !channelMembers.data?.some((joined) => joined.account_id === member.account_id)).map((member) => <option key={member.account_id} value={member.account_id}>{member.name}</option>)}
          </select>
          <button type="submit" className="button secondary" disabled={!channelMemberToAdd || Boolean(savingChannelMemberId)}>Add</button>
        </div>
      </form>}
      {!activeChannel.is_dm && members.some((member) => member.kind === 'agent' && !channelMembers.data?.some((joined) => joined.account_id === member.account_id)) && <div className="modal-form"><h3>Add an agent</h3><div className="agent-options">{members.filter((member) => member.kind === 'agent' && !channelMembers.data?.some((joined) => joined.account_id === member.account_id)).map((agent) => <button type="button" className="button secondary" key={agent.account_id} onClick={() => void action(`/channels/${channelId}/members`, { agent_id: agent.account_id }).then(() => void queryClient.invalidateQueries({ queryKey: ['channel-members', workspace.id, channelId] }))}><PlusIcon /> {agent.name}</button>)}</div></div>}
      {error && <p className="error-banner" role="alert">{error}</p>}
    </Modal>}
    {modal === 'drawing' && <DrawingBoundary onClose={() => { setModal(null); setDrawingDraft(null); }}><Suspense fallback={<div className="drawing-loading">Opening drawing editor…</div>}><Drawing onCancel={() => { setModal(null); setDrawingDraft(null); }} onSave={uploadDrawing} initialScene={drawingDraft?.scene} /></Suspense></DrawingBoundary>}
  </div>;
}

export default function App() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const isPublicGuide = /^\/agents\/?(?:\?|$)/.test(location);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/me'), enabled: !isPublicGuide });
  const invite = location.match(/^\/invite\/([^/?]+)/)?.[1] ?? null;
  const [inviteError, setInviteError] = useState('');
  useEffect(() => {
    if (!invite || !me.data?.account) return;
    void post<{ workspace_id: string }>('/invites/accept', { token: invite }).then(async (result) => { await queryClient.invalidateQueries({ queryKey: ['me'] }); navigate(`/w/${result.workspace_id}`); }).catch((cause) => setInviteError(cause.message));
  }, [invite, me.data?.account?.id, queryClient]);
  if (isPublicGuide) return <AgentGuide />;
  if (location.startsWith('/signin/verify')) return <MagicLinkSignIn />;
  if (me.isLoading) return <div className="loading-page"><BrandMark /><p>Opening Await…</p></div>;
  if (me.error) return <div className="loading-page"><p>Could not load Await.</p><button type="button" className="button secondary" onClick={() => void me.refetch()}>Try again</button></div>;
  if (!me.data?.account) return location.startsWith('/signin/reviewer') ? <ReviewerSignIn /> : location.startsWith('/signin') || invite || new URLSearchParams(window.location.search).has('error') ? <SignIn providers={me.data?.providers ?? []} invite={invite} error={new URLSearchParams(window.location.search).get('error')} signupOpen={me.data?.signup_open ?? false} canDevLogin={me.data?.can_dev_login ?? false} /> : <Landing />;
  if (invite && inviteError) return <div className="loading-page"><p>{inviteError}</p><button type="button" className="button secondary" onClick={() => navigate('/')}>Go to workspaces</button></div>;
  if (invite) return <div className="loading-page"><BrandMark /><p role="status">Joining the workspace…</p></div>;
  const workspaceId = location.match(/^\/w\/([^/]+)/)?.[1];
  const workspace = me.data.workspaces.find((item) => item.id === workspaceId) ?? me.data.workspaces[0];
  if (!workspace) return <CreateWorkspace canCreate={me.data.can_create_workspace} onCreated={(created) => { void queryClient.invalidateQueries({ queryKey: ['me'] }); navigate(`/w/${created.id}/${created.channel_id}`); }} />;
  if (!workspaceId) { navigate(`/w/${workspace.id}`); return null; }
  return <WorkspaceApp key={workspace.id} workspace={workspace} workspaces={me.data.workspaces} selfId={me.data.account.id} selfEmail={me.data.account.email} />;
}
