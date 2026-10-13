import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpTrayIcon, AtSymbolIcon, CheckIcon, DocumentIcon, FolderOpenIcon, HashtagIcon, PaperAirplaneIcon, PencilSquareIcon, PlusIcon, XMarkIcon } from '@heroicons/react/16/solid';
import { FaceSmileIcon } from '@heroicons/react/24/outline';
import { Fragment, Slice, type Node as ProseNode } from 'prosemirror-model';
import type { Channel, ChatMessage, Member } from '../shared/types';
import { formatBytes } from '../shared/attachments';
import { initials } from '../shared/members';
import { api, post } from './api';
import MediaPicker from './MediaPicker';
import FilePicker from './FilePicker';
import { draftKey, readDraft, saveDraft } from './drafts';
import { messageSchema as schema, parseMessage, serializeMessage } from './messageRichText';
import { startCodeBlock, startSuggestion } from './messageEditing';
import useMessageEditor, { FormatButtons } from './useMessageEditor';
import './messageEditor.css';

type DraftAttachment = { id: string; filename: string; kind: string; mime: string; size: number; previewUrl?: string };

function highlightedName(name: string, query: string) {
  if (!query) return name;
  const index = name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return name;
  return <>{name.slice(0, index)}<mark>{name.slice(index, index + query.length)}</mark>{name.slice(index + query.length)}</>;
}

// The placeholder shows only over a truly empty message, not over spaces or an empty code block.
const isBlank = (doc: ProseNode) => doc.childCount === 1 && doc.firstChild!.type === schema.nodes.paragraph && !doc.firstChild!.content.size;

export default function Composer({ channel, channels, threadId, focusRequest = 0, workspaceId, selfId, members, socket, typingLabel, onSent, onOptimistic, onSettled, onDraw }: { channel: Channel; channels: Channel[]; threadId?: string; focusRequest?: number; workspaceId: string; selfId: string; members: Member[]; socket: WebSocket | null; typingLabel?: string; onSent: (transport: 'socket' | 'http') => void; onOptimistic: (message: ChatMessage) => void; onSettled: (clientId: string, message: ChatMessage | null) => void; onDraw: () => void }) {
  const storageKey = draftKey(workspaceId, selfId, channel.id, threadId);
  const listId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const localPreviews = useRef(new Set<string>());
  const pickerAnchor = useRef<HTMLDivElement>(null);
  const actionsAnchor = useRef<HTMLDivElement>(null);
  const latest = useRef({ socket, onSent });
  const sendingRef = useRef(false);
  const lastTypingSent = useRef(0);
  const suggestionList = useRef<HTMLDivElement>(null);
  const [body, setBody] = useState('');
  const [blank, setBlank] = useState(true);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<'actions' | 'files' | 'emoji' | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  latest.current = { socket, onSent };
  useEffect(() => () => { for (const url of localPreviews.current) URL.revokeObjectURL(url); localPreviews.current.clear(); }, []);
  const releasePreview = (item: DraftAttachment) => { if (item.previewUrl?.startsWith('blob:')) { URL.revokeObjectURL(item.previewUrl); localPreviews.current.delete(item.previewUrl); } };

  useEffect(() => {
    lastTypingSent.current = 0;
    return () => {
      if (lastTypingSent.current && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'typing', channel_id: channel.id, thread_id: threadId, active: false }));
      lastTypingSent.current = 0;
    };
  }, [socket, channel.id, threadId]);

  useEffect(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const signal = (active: boolean) => socket.send(JSON.stringify({ type: 'typing', channel_id: channel.id, thread_id: threadId, active }));
    if (!body.trim()) {
      if (lastTypingSent.current) { signal(false); lastTypingSent.current = 0; }
      return;
    }
    if (Date.now() - lastTypingSent.current >= 2000) { signal(true); lastTypingSent.current = Date.now(); }
    const idle = window.setTimeout(() => { if (lastTypingSent.current) { signal(false); lastTypingSent.current = 0; } }, 3000);
    return () => window.clearTimeout(idle);
  }, [body, socket, channel.id, threadId]);

  // Keeps the send button, typing signal, placeholder and saved draft in step with the message.
  function syncDraft(doc: ProseNode) {
    const text = serializeMessage(doc);
    setBody(text);
    setBlank(isBlank(doc));
    saveDraft(storageKey, { channelId: channel.id, threadId, body: text, doc: doc.toJSON(), updatedAt: Date.now() });
  }

  const editor = useMessageEditor({
    workspaceId, channelId: channel.id, dm: Boolean(channel.is_dm), channels,
    doc: () => {
      let restoredDoc: ProseNode | undefined;
      const saved = readDraft(storageKey);
      try { if (saved?.doc) { restoredDoc = schema.nodeFromJSON(saved.doc); if (restoredDoc.type !== schema.nodes.doc) throw new Error('Invalid draft'); restoredDoc.check(); } }
      catch { restoredDoc = saved?.body ? parseMessage(saved.body, members, channels) : undefined; }
      if (restoredDoc) { setBody(serializeMessage(restoredDoc)); setBlank(isBlank(restoredDoc)); }
      return restoredDoc;
    },
    keys: {
      // In a code block, or on a line that starts one, Enter writes code; Mod-Enter sends from anywhere.
      Enter: (state) => {
        if (editor.suggesting()) return true;
        if (state.selection.$from.parent.type.spec.code || startCodeBlock(state)) return false;
        void send();
        return true;
      },
      'Mod-Enter': () => { void send(); return true; },
      'Mod-Shift-m': () => { insertText('@'); return true; },
    },
    attributes: { role: 'textbox', 'aria-label': threadId ? 'Reply to thread' : `Message ${channel.name}`, 'aria-multiline': 'true', 'aria-autocomplete': 'list', 'aria-haspopup': 'listbox', 'aria-controls': listId, 'aria-expanded': 'false', 'data-testid': 'message-editor' },
    onDocChange: syncDraft,
  });
  const { suggestion, selected, matches } = editor;

  useEffect(() => {
    suggestionList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    setUploading(true); setError('');
    try {
      for (const file of files) {
        const result = await api<DraftAttachment>(`/workspaces/${workspaceId}/channels/${channel.id}/files`, { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) } });
        const previewUrl = result.kind === 'image' ? URL.createObjectURL(file) : undefined;
        if (previewUrl) localPreviews.current.add(previewUrl);
        setAttachments((current) => [...current, { ...result, previewUrl }]);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Upload failed.'); }
    finally { setUploading(false); }
  }

  async function reuseFile(file: DraftAttachment) {
    setUploading(true); setError('');
    try {
      const result = await post<DraftAttachment>(`/workspaces/${workspaceId}/channels/${channel.id}/files/reuse`, { file_id: file.id });
      setAttachments((current) => [...current, { ...result, previewUrl: result.kind === 'image' ? `/api/workspaces/${workspaceId}/files/${file.id}` : undefined }]);
      setMenu(null);
      editor.view.current?.focus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'File could not be attached.'); }
    finally { setUploading(false); }
  }

  async function removeAttachment(item: DraftAttachment) {
    if (removingId || sendingRef.current) return;
    setRemovingId(item.id); setError('');
    try {
      await api(`/workspaces/${workspaceId}/files/${item.id}`, { method: 'DELETE' });
      releasePreview(item);
      setAttachments((current) => current.filter((part) => part.id !== item.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'File could not be removed.'); }
    finally { setRemovingId(null); }
  }

  async function deliver(input: { type: string; channel_id: string; thread_id?: string; body: string; attachment_ids: string[]; client_id: string }): Promise<{ transport: 'socket' | 'http'; message: ChatMessage }> {
    const path = `/workspaces/${workspaceId}/channels/${channel.id}/messages`;
    const socket = latest.current.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return { transport: 'http', message: await post<ChatMessage>(path, input) };
    return await new Promise<{ transport: 'socket' | 'http'; message: ChatMessage }>((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        window.clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', fallback);
      };
      const finish = (message?: ChatMessage, error?: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error); else if (message) resolve({ transport: 'socket', message });
      };
      const fallback = () => {
        if (finished) return;
        finished = true;
        cleanup();
        // The client id makes this retry safe even if the socket post succeeded before closing.
        void post<ChatMessage>(path, input).then((message) => resolve({ transport: 'http', message }), (cause) => reject(cause));
      };
      const onMessage = (event: MessageEvent) => {
        let response: { type?: string; client_id?: string; error?: string; message?: ChatMessage };
        try { response = JSON.parse(event.data); } catch { return; }
        if (response.client_id !== input.client_id) return;
        if (response.type === 'ack' && response.message) finish(response.message);
        if (response.type === 'error') finish(undefined, new Error(response.error || 'Message failed.'));
      };
      const timer = window.setTimeout(fallback, 5000);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', fallback, { once: true });
      try { socket.send(JSON.stringify(input)); } catch { fallback(); }
    });
  }

  async function send() {
    const view = editor.view.current;
    const sentDoc = view?.state.doc;
    const text = sentDoc ? serializeMessage(sentDoc) : body;
    if ((!text.trim() && !attachments.length) || uploading || removingId || sendingRef.current) return;
    const input = { type: 'send', channel_id: channel.id, thread_id: threadId, body: text, attachment_ids: attachments.map((item) => item.id), client_id: crypto.randomUUID() };
    const sentAttachments = attachments;
    sendingRef.current = true;
    setSending(true); setError('');
    onOptimistic({ id: `optimistic:${input.client_id}`, client_id: input.client_id, channel_id: channel.id, thread_id: threadId ?? null, author_id: selfId, body: text || (sentAttachments.length === 1 ? `Sending ${sentAttachments[0].filename}` : `Sending ${sentAttachments.length} files`), created_at: Date.now(), edited_at: null, deleted_at: null, delivery: 'sending' });
    if (view && editor.view.current === view) editor.replace();
    setAttachments((current) => current.filter((item) => !input.attachment_ids.includes(item.id)));
    editor.close(); setMenu(null);
    try {
      const { transport, message } = await deliver(input);
      onSettled(input.client_id, message);
      for (const item of sentAttachments) releasePreview(item);
      latest.current.onSent(transport);
      view?.focus();
    } catch (cause) {
      onSettled(input.client_id, null);
      // Put the failed message back, ahead of anything typed since.
      if (view && editor.view.current === view && sentDoc) {
        const newer = view.state.doc;
        editor.replace(serializeMessage(newer).trim() ? sentDoc.copy(sentDoc.content.append(newer.content)) : sentDoc);
      }
      setAttachments((current) => [...sentAttachments.filter((item) => !current.some((other) => other.id === item.id)), ...current]);
      setError(cause instanceof Error ? cause.message : 'Message failed. Your draft is still here.');
    }
    finally { sendingRef.current = false; setSending(false); }
  }
  useEffect(() => { if (focusRequest > 0) editor.view.current?.focus(); }, [focusRequest]);

  function insertText(value: string) {
    const view = editor.view.current;
    if (!view) return;
    view.dispatch(value === '@' || value === '#' ? startSuggestion(view.state, value) : view.state.tr.insertText(value));
    view.focus();
    setMenu(null);
  }

  async function insertGif(url: string, source: 'giphy' | 'link' = 'link', attribution?: { pageUrl: string; creator: string }) {
    if (source === 'giphy' || /^https:\/\/(?:media[0-9]*|i)\.giphy\.com\//i.test(url)) {
      // Brackets in the name would end the credit's link text.
      const creator = attribution?.creator.replace(/[\[\]()]/g, '').slice(0, 80);
      const pageUrl = attribution?.pageUrl.startsWith('https://giphy.com/') ? attribution.pageUrl : null;
      // The GIF and its GIPHY credit get paragraphs of their own, followed by an empty one to keep writing in.
      const blocks = [schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: url, alt: 'GIF' }))];
      if (pageUrl) blocks.push(schema.nodes.paragraph.create(null, schema.text(`${creator ? `GIF by ${creator}` : 'View GIF'} on GIPHY`, [schema.marks.link.create({ href: pageUrl })])));
      const view = editor.view.current;
      view?.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from([...blocks, schema.nodes.paragraph.create()]), 0, 0)).scrollIntoView());
      view?.focus();
      setMenu(null);
      return;
    }
    setUploading(true);
    try {
      const result = await post<DraftAttachment>(`/workspaces/${workspaceId}/channels/${channel.id}/gifs`, { url });
      setAttachments((current) => [...current, result]);
      setMenu(null);
      editor.view.current?.focus();
    } finally { setUploading(false); }
  }

  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    const closeOnOutside = (event: PointerEvent) => {
      const anchor = menu === 'emoji' ? pickerAnchor : actionsAnchor;
      if (!anchor.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', closeOnOutside);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', closeOnOutside); };
  }, [menu]);

  useEffect(() => {
    const dom = editor.view.current?.dom;
    if (!dom) return;
    const visible = Boolean(suggestion && (suggestion.kind === 'mention' || matches.length));
    dom.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (visible && matches[selected]) dom.setAttribute('aria-activedescendant', `${listId}-${selected}`);
    else dom.removeAttribute('aria-activedescendant');
  }, [suggestion, selected, editor.members.data, editor.tasks.data, listId]);
  return <div
    className={`composer-wrap ${dropActive ? 'composer-drop-active' : ''}`}
    aria-busy={sending}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropActive(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }}
    onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDropActive(false); void uploadFiles(Array.from(event.dataTransfer.files)); } }}
    onPasteCapture={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void uploadFiles(files); } }}
  >
    <div className="composer-typing" aria-live="polite">{typingLabel}</div>
    <div className={`composer-rich ${formatOpen ? 'formatting-open' : ''}`}>
      {dropActive && <div className="composer-drop-hint" aria-hidden="true"><ArrowUpTrayIcon /> Drop files to attach</div>}
      {formatOpen && <div className="composer-formatting-row" role="toolbar" aria-label="Text formatting">
        <FormatButtons editor={editor} />
      </div>}
      {attachments.length > 0 && <div className="composer-attachments" aria-label="Files ready to send">{attachments.map((item) => <div className="composer-attachment" key={item.id}>
        <span className="composer-attachment-preview" aria-hidden="true">{item.previewUrl ? <img src={item.previewUrl} alt="" /> : <DocumentIcon />}</span>
        <span className="composer-attachment-copy"><strong title={item.filename}>{item.filename}</strong><small>{item.mime.split('/')[1]?.toUpperCase() || 'File'} · {formatBytes(item.size)}</small></span>
        <button type="button" aria-label={`Remove ${item.filename}`} disabled={Boolean(removingId) || sending} onClick={() => void removeAttachment(item)}><XMarkIcon /></button>
      </div>)}</div>}
      <div className="composer-edit-area">
        {blank && <div className="composer-placeholder" aria-hidden="true">{threadId ? 'Reply to thread' : channel.is_dm ? `Message ${channel.name}` : `Message #${channel.name}`}</div>}
        <div ref={editor.mount} />
      </div>
      {suggestion && (suggestion.kind === 'mention' || matches.length > 0) && <div className="mention-popover">
        <div className="mention-popover-heading"><strong>{suggestion.kind === 'mention' ? channel.is_dm ? 'Mention in this conversation' : `Mention in #${channel.name}` : editor.tasks.data?.length ? 'Link a channel or task' : 'Link a channel'}</strong><span>{suggestion.kind === 'mention' ? editor.members.data?.length ?? 0 : matches.length}</span></div>
        <div className="mention-list" id={listId} ref={suggestionList} role="listbox" aria-label={suggestion.kind === 'mention' ? channel.is_dm ? 'People in this conversation' : `Members of ${channel.name}` : 'Channels'}>
          {suggestion.kind === 'mention' && editor.members.isLoading && <p className="mention-empty">Loading members…</p>}
          {suggestion.kind === 'mention' && editor.members.isError && <p className="mention-empty">Members could not load. <button type="button" onClick={() => void editor.members.refetch()}>Try again</button></p>}
          {!editor.members.isLoading && !editor.members.isError && !matches.length && <p className="mention-empty">No matching members in this channel.</p>}
          {matches.map((item, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={index === selected} className={index === selected ? 'selected' : ''} key={item.id} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => editor.select(index)} onClick={() => editor.insert(item)}>
            {suggestion.kind === 'mention' ? <span className={`mention-avatar ${item.kind === 'agent' ? 'agent' : ''}`} aria-hidden="true"><span>{initials(item.label)}</span>{item.avatar && <img src={item.avatar} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}</span> : item.node === 'task' ? <span className={`mention-channel-icon task-icon status-${item.status}`}><CheckIcon /></span> : <span className="mention-channel-icon"><HashtagIcon /></span>}
            <span className="mention-name">{highlightedName(item.label, suggestion.query)}</span>{item.detail && <small>{item.detail}</small>}
          </button>)}
        </div>
        <div className="mention-shortcuts"><span>↑ ↓ navigate</span><span>Enter or Tab select</span><span>Esc close</span></div>
      </div>}
      <div className="composer-toolbar">
        <div className="composer-tools">
          <div className="composer-menu-anchor" ref={actionsAnchor}>
            <button type="button" className="composer-add" aria-label="More message options" aria-expanded={menu === 'actions' || menu === 'files'} onClick={() => setMenu((current) => current === 'actions' ? null : 'actions')}><PlusIcon /></button>
            {menu === 'actions' && <div className="composer-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => setMenu('files')}><FolderOpenIcon /> Choose from uploaded files</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(null); fileInput.current?.click(); }}><ArrowUpTrayIcon /> Upload from your computer</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(null); onDraw(); }}><PencilSquareIcon /> Add a drawing</button>
              <button type="button" role="menuitem" onClick={() => insertText('@')}><AtSymbolIcon /> Mention someone</button>
              <button type="button" role="menuitem" onClick={() => insertText('#')}><HashtagIcon /> Link a channel</button>
            </div>}
            {menu === 'files' && <FilePicker workspaceId={workspaceId} busy={uploading} onChoose={(file) => void reuseFile(file)} onUpload={() => { setMenu(null); fileInput.current?.click(); }} onClose={() => setMenu(null)} />}
          </div>
          <button type="button" className={`composer-style-toggle ${formatOpen ? 'active' : ''}`} aria-label={formatOpen ? 'Hide formatting' : 'Show formatting'} aria-expanded={formatOpen} title="Formatting" onMouseDown={(event) => event.preventDefault()} onClick={() => { setFormatOpen((open) => !open); setMenu(null); editor.view.current?.focus(); }}>Aa</button>
          <div className="composer-menu-anchor" ref={pickerAnchor}>
            <button type="button" className="composer-tool-button" aria-label="Add emoji" aria-expanded={menu === 'emoji'} title="Add emoji" onClick={() => setMenu((current) => current === 'emoji' ? null : 'emoji')}><FaceSmileIcon strokeWidth={2} /></button>
            {menu === 'emoji' && <MediaPicker workspaceId={workspaceId} onEmoji={insertText} onGif={insertGif} />}
          </div>
          <button type="button" className="composer-tool-button" aria-label="Mention someone" title="Mention someone (⌘/Ctrl + Shift + M)" onClick={() => insertText('@')}><AtSymbolIcon /></button>
          <span className="composer-tool-divider" />
          <button type="button" className="composer-tool-button composer-drawing-button" aria-label="Add a drawing" title="Add a drawing" onClick={onDraw}><PencilSquareIcon /></button>
        </div>
        <button type="button" className="send-button" aria-label={sending ? 'Sending message' : 'Send message'} title={sending ? 'Sending message' : 'Send message'} disabled={(!body.trim() && !attachments.length) || uploading || Boolean(removingId) || sending} onClick={() => void send()}><PaperAirplaneIcon /></button>
      </div>
      <input type="file" name="file" ref={fileInput} className="hidden" multiple onChange={(event) => { void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    </div>
    {uploading && <p className="composer-note">Uploading file…</p>}
    {sending && <p className="composer-note" role="status">Sending message…</p>}
    {error && <p className="composer-error" role="alert">{error}</p>}
  </div>;
}
