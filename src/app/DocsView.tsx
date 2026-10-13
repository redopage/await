import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DocumentTextIcon, EyeIcon, PencilSquareIcon, PlusIcon, ShareIcon, XMarkIcon } from '@heroicons/react/16/solid';
import type { Member, TeamDocument } from '../shared/types';
import { api, post } from './api';
import LoadNotice from './LoadNotice';

type Props = { workspaceId: string; channelId: string; members: Member[]; createSignal?: number; onCreateHandled?: () => void; requestedDocumentId?: string; onShare: (kind: 'task' | 'board' | 'document', title: string, url: string) => Promise<void> };

export default function DocsView({ workspaceId, channelId, members, createSignal, onCreateHandled, requestedDocumentId, onShare }: Props) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (createSignal) { setCreating(true); onCreateHandled?.(); } }, [createSignal]);
  const [newTitle, setNewTitle] = useState('');
  const documents = useQuery({ queryKey: ['documents', workspaceId, channelId], queryFn: () => api<TeamDocument[]>(`/workspaces/${workspaceId}/collab/documents?channel=${channelId}`) });
  const document = useQuery({ queryKey: ['document', workspaceId, selectedId], queryFn: () => api<TeamDocument>(`/workspaces/${workspaceId}/collab/documents/${selectedId}`), enabled: Boolean(selectedId) });
  useEffect(() => { if (documents.data?.length && !selectedId) setSelectedId(documents.data.find((item) => item.id === requestedDocumentId)?.id ?? documents.data[0].id); }, [documents.data, selectedId, requestedDocumentId]);
  useEffect(() => { if (document.data && !dirty) { setTitle(document.data.title); setBody(document.data.body); } }, [document.data?.id, document.data?.updated_at, dirty]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    try { const item = await post<TeamDocument>(`/workspaces/${workspaceId}/collab/documents`, { channel_id: channelId, title: newTitle.trim() }); setSelectedId(item.id); setDirty(false); setPreview(false); setCreating(false); setNewTitle(''); void queryClient.invalidateQueries({ queryKey: ['documents', workspaceId, channelId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create document.'); }
  }

  async function save() {
    if (!selectedId) return;
    setSaving(true); setError('');
    try { await api(`/workspaces/${workspaceId}/collab/documents/${selectedId}`, { method: 'PUT', body: JSON.stringify({ title, body }) }); setDirty(false); void queryClient.invalidateQueries({ queryKey: ['documents', workspaceId, channelId] }); void queryClient.invalidateQueries({ queryKey: ['document', workspaceId, selectedId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save document.'); }
    finally { setSaving(false); }
  }

  function select(id: string) {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setSelectedId(id); setDirty(false); setPreview(false); setError('');
  }

  async function share() {
    if (!document.data || dirty) return;
    try { await onShare('document', document.data.title, `/w/${workspaceId}/${channelId}?view=docs&doc=${document.data.id}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not share in chat.'); }
  }

  return <div className="docs-layout">
    <aside className="docs-sidebar">
      <div className="docs-sidebar-header">
        <div><h2>Documents</h2></div>
        <button type="button" className="icon-button" aria-label="New document" title="New document" onClick={() => setCreating(true)}>
          <PlusIcon />
        </button>
      </div>
      <div className="docs-list">
        {documents.isPaused && !documents.data && <p className="docs-list-status">Offline. Reconnect to load documents.</p>}
        {documents.isPending && !documents.isPaused && <p className="docs-list-status">Loading documents…</p>}
        {documents.isError && !documents.data && <LoadNotice compact title="Documents could not load" detail="Try loading this channel again." onRetry={() => void documents.refetch()} />}
        {documents.data?.map((item) => <button type="button" className={item.id === selectedId ? 'selected' : ''} key={item.id} onClick={() => select(item.id)}>
          <DocumentTextIcon />
          <span>
            <strong>{item.title}</strong>
            <small>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(item.updated_at)}</small>
          </span>
        </button>)}
      </div>
    </aside>
    <main className="doc-editor">
      {documents.isPaused && !documents.data ? <LoadNotice title="You are offline" detail="Reconnect to load documents." onRetry={() => void documents.refetch()} /> : document.isPaused && !document.data ? <LoadNotice title="You are offline" detail="Reconnect to load this document." onRetry={() => void document.refetch()} /> : documents.isPending || document.isPending && selectedId ? <div className="empty-state">Loading documents…</div> : documents.isError && !documents.data ? <LoadNotice title="Documents could not load" detail="Try loading this channel again." onRetry={() => void documents.refetch()} /> : document.isError && !document.data ? <LoadNotice title="Document could not load" detail="Try opening this document again." onRetry={() => void document.refetch()} /> : selectedId && document.data ? <>
        <div className="doc-toolbar">
          <div>
            <p>Last edited by {members.find((member) => member.account_id === document.data.updated_by)?.name ?? 'a teammate'}.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="button subtle" disabled={dirty} title={dirty ? 'Save changes before sharing' : 'Share in chat'} onClick={() => void share()}><ShareIcon /> Share in chat</button>
            <button type="button" className={`view-tab ${preview ? 'selected' : ''}`} onClick={() => setPreview(!preview)}>{preview ? <PencilSquareIcon /> : <EyeIcon />} {preview ? 'Edit' : 'Preview'}</button>
            <button type="button" className="button primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
          </div>
        </div>
        {error && <p className="error-banner collab-error">{error}</p>}
        {preview ? <div className="doc-preview">
          <h1>{title}</h1>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || '_This document is empty._'}</ReactMarkdown>
        </div> : <div className="doc-fields">
          <input name="document-title" aria-label="Document title" value={title} onChange={(event) => { setTitle(event.target.value); setDirty(true); }} />
          <textarea name="document-body" aria-label="Document content" placeholder="Write notes, decisions, and context for your team…" value={body} onChange={(event) => { setBody(event.target.value); setDirty(true); }} />
        </div>}
      </> : <div className="collab-empty">
        <DocumentTextIcon />
        <h3>Keep shared context close</h3>
        <p>Create a document for notes, decisions, or project plans.</p>
        <button type="button" className="button primary" onClick={() => setCreating(true)}><PlusIcon /> New document</button>
      </div>}
    </main>
    {creating && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false); }}>
      <form className="modal" onSubmit={(event) => void create(event)}>
        <div className="modal-header">
          <h2>New document</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={() => setCreating(false)}>
            <XMarkIcon />
          </button>
        </div>
        <div className="modal-form">
          <label htmlFor="new-document-title">Document title</label>
          <input id="new-document-title" name="new-document-title" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Project brief" autoFocus required />
          {error && <p className="error-banner">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setCreating(false)}>Cancel</button>
            <button type="submit" className="button primary">Create document</button>
          </div>
        </div>
      </form>
    </div>}
  </div>;
}
