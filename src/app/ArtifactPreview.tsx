import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowPathIcon, ArrowTopRightOnSquareIcon, ArrowsPointingOutIcon, CheckIcon, ClipboardIcon, CodeBracketIcon, DocumentIcon, PlayIcon, XMarkIcon } from '@heroicons/react/16/solid';
import { artifactName, type ArtifactContents, type SharedLink } from '../shared/workspace-library';
import { api } from './api';
import Modal from './Modal';

function useRepository(link: SharedLink, workspaceId: string, messageId: string, enabled: boolean) {
  const [path, setPath] = useState('');
  const [ref, setRef] = useState('');
  const [branch, setBranch] = useState('');
  const [filePath, setFilePath] = useState('');
  const query = useQuery({ queryKey: ['artifact', workspaceId, messageId, link.url, ref, path], queryFn: () => api<ArtifactContents>(`/workspaces/${workspaceId}/artifacts?${new URLSearchParams({ message_id: messageId, url: link.url, ...(ref ? { ref } : {}), ...(path ? { path } : {}) })}`), enabled: enabled && link.preview === 'repository', placeholderData: keepPreviousData, staleTime: 0, gcTime: 0, retry: false, refetchInterval: enabled ? 25 * 60_000 : false });
  // The last listing that loaded keeps the title and file list in place while a file fails to open.
  const [listed, setListed] = useState<ArtifactContents>();
  useEffect(() => { if (query.data && !query.isPlaceholderData) setListed(query.data); }, [query.data, query.isPlaceholderData]);
  function reset() { setRef(''); setBranch(''); setPath(''); setFilePath(''); if (!ref && !path) void query.refetch(); }
  return { query, listing: query.data ?? listed, path, setPath, ref, setRef, branch, setBranch, filePath, setFilePath, reset };
}

function ArtifactFrame({ src, title }: { src: string; title: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setLoaded(false); setFailed(false); }, [src]);
  return <div className="artifact-frame-wrap" aria-busy={!loaded && !failed}>
    {!loaded && !failed && <p className="artifact-frame-status" role="status">Loading preview…</p>}
    {failed && <div className="artifact-notice" role="alert"><p>The preview could not load.</p><button type="button" className="button secondary" onClick={() => { setFailed(false); setLoaded(false); setAttempt(attempt + 1); }}>Try again</button></div>}
    <iframe key={`${src}-${attempt}`} className="artifact-frame" src={src} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
  </div>;
}

// The file in view, or why there is none.
function RepositoryFile({ repository }: { repository: ReturnType<typeof useRepository> }) {
  const { query, path, ref, reset } = repository;
  const data = query.data;
  if (!data && query.isError) return <div className="artifact-notice" role="alert"><p>{query.error.message}</p><div className="artifact-recovery">
    <button type="button" className="button secondary" onClick={() => void query.refetch()}>Try again</button>
    {(path || ref) && <button type="button" className="button secondary" onClick={reset}>Back to the default preview</button>}
  </div></div>;
  if (!data) return <p className="artifact-notice" role="status">{query.isPaused ? 'You are offline. Reconnect to load this artifact.' : 'Loading repository…'}</p>;
  if (!data.commit) return <div className="artifact-notice"><p>{ref ? 'This branch or commit was not found.' : 'Push a first commit to see the preview here.'}</p>{ref && <button type="button" className="button secondary" onClick={reset}>Back to the default branch</button>}</div>;
  if (!data.path) return <p className="artifact-notice">This revision has no files.</p>;
  if (data.previewUrl) return /\.(?:png|jpe?g|gif|webp)$/i.test(data.path) ? <img className="artifact-image" src={data.previewUrl} alt={data.path} /> : <ArtifactFrame src={data.previewUrl} title={`Preview of ${data.path}`} />;
  if (data.content !== null) return <pre className="artifact-source"><code>{data.content}</code></pre>;
  return <p className="artifact-notice">This file type has no preview. Choose another file.</p>;
}

function RepositoryPreview({ repository }: { repository: ReturnType<typeof useRepository> }) {
  const { query, listing, path, setPath, ref, setRef, branch, setBranch, filePath, setFilePath, reset } = repository;
  const [choosingRef, setChoosingRef] = useState(false);
  const refButton = useRef<HTMLButtonElement>(null);
  const refClosed = useRef(false);
  const data = query.data, current = path || listing?.path || '';
  // Closing the branch field puts focus back on the button that opened it.
  function closeRef() { refClosed.current = true; setChoosingRef(false); }
  useEffect(() => { if (!choosingRef && refClosed.current) { refClosed.current = false; refButton.current?.focus(); } }, [choosingRef]);
  function showRef(event: FormEvent) {
    event.preventDefault();
    const next = branch.trim();
    setRef(next); setPath(''); setFilePath(''); closeRef();
    if (next === ref && !path) void query.refetch();
  }
  function openPath(event: FormEvent) {
    event.preventDefault();
    const next = filePath.trim();
    if (next === path) void query.refetch(); else if (next) setPath(next);
  }
  return <div className="artifact-browser" aria-busy={query.isFetching}>
    <div className="artifact-toolbar">
      {listing && listing.files.length > 0 && <label className="artifact-file"><DocumentIcon aria-hidden="true" />
        <select aria-label="Artifact file" disabled={query.isFetching} value={current} onChange={(event) => { setPath(event.target.value); setFilePath(event.target.value); }}>
          {listing.files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
          {current && !listing.files.some((file) => file.path === current) && <option value={current}>{current}</option>}
        </select>
      </label>}
      {choosingRef
        ? <form className="artifact-ref-form" onSubmit={showRef}>
          <input autoFocus aria-label="Branch or commit" value={branch} placeholder={data?.branch ?? 'Branch or commit'} onChange={(event) => setBranch(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeRef(); } }} />
          <button type="submit" className="button secondary" disabled={query.isFetching}>Show</button>
        </form>
        : <button ref={refButton} type="button" className="artifact-ref" title="Show another branch or commit" onClick={() => { setBranch(ref); setChoosingRef(true); }}>
          {data ? <>{data.branch}{data.commit && <span>{data.commit.slice(0, 7)}</span>}</> : ref || listing?.branch || 'Default branch'}
        </button>}
      <span className="artifact-toolbar-actions">
        <button type="button" className="icon-button" aria-label="Refresh artifact" title="Refresh" disabled={query.isFetching} onClick={() => void query.refetch()}><ArrowPathIcon className={query.isFetching ? 'is-refreshing' : ''} /></button>
        {data?.previewUrl && <a className="icon-button" href={data.previewUrl} target="_blank" rel="noopener noreferrer" aria-label="Open this file in a new tab" title="Open in a new tab"><ArrowTopRightOnSquareIcon /></a>}
      </span>
    </div>
    {/* The file list stops at 200 files; anything further opens by path. */}
    {listing?.truncated && listing.commit && <form className="artifact-path" onSubmit={openPath}>
      <label>More files<input name="path" aria-label="Repository file path" value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="path/to/file.html" /></label>
      <button type="submit" className="button secondary" disabled={!filePath.trim() || query.isFetching}>Open</button>
    </form>}
    {query.isError && data && <div className="artifact-alert" role="alert"><p>{query.error.message}</p><button type="button" className="text-button" onClick={() => void query.refetch()}>Try again</button></div>}
    <div className={query.isPlaceholderData ? 'artifact-stage is-loading' : 'artifact-stage'}>
      {query.isFetching && data && <span className="artifact-progress" role="status"><span className="sr-only">{query.isPlaceholderData ? 'Opening file…' : 'Refreshing preview…'}</span></span>}
      <RepositoryFile repository={repository} />
    </div>
    {data?.contentTruncated && <p className="artifact-caption">Showing the first 200,000 characters of this file.</p>}
  </div>;
}

export default function ArtifactPreview({ link, workspaceId, messageId, expandRequested = false, onExpandDismiss }: { link: SharedLink; workspaceId: string; messageId: string; expandRequested?: boolean; onExpandDismiss?: () => void }) {
  const [open, setOpen] = useState(false);
  const [expandedLocally, setExpanded] = useState(false);
  const expanded = expandedLocally || expandRequested;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const regionId = useId();
  const repository = useRepository(link, workspaceId, messageId, open || expanded);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 2500); return () => window.clearTimeout(timer); }, [copied]);
  async function copyRemote() {
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setCopyError(''); }
    catch { setCopyError('Could not copy automatically. Copy the Git remote below.'); }
  }
  function dismiss() { setExpanded(false); onExpandDismiss?.(); }
  // A project repository reads as its kind until the server reports the project's or workspace's title.
  const { name, kind } = artifactName(link, workspaceId);
  const listing = repository.listing;
  const repo = link.preview === 'repository';
  const title = repo ? listing?.title ?? kind ?? name : link.title;
  const header = (close?: () => void) => <div className="artifact-card-header">
    <CodeBracketIcon className="artifact-card-icon" aria-hidden="true" />
    <div>{close ? <h2 title={title}>{title}</h2> : <strong title={title}>{title}</strong>}</div>
    <span className="artifact-header-actions">
      {repo ? <button type="button" className="icon-button" aria-label={copied ? 'Git remote copied' : 'Copy Git remote'} title={copied ? 'Copied' : 'Copy Git remote'} onClick={() => void copyRemote()}>{copied ? <CheckIcon /> : <ClipboardIcon />}</button>
        : <a className="icon-button" href={link.url} target="_blank" rel="noopener noreferrer" aria-label="Open preview in a new tab" title="Open in a new tab"><ArrowTopRightOnSquareIcon /></a>}
      {close && <button type="button" className="icon-button" aria-label="Close" onClick={close}><XMarkIcon /></button>}
    </span>
  </div>;
  const notices = <>
    {copied && <span className="sr-only" role="status">Git remote copied</span>}
    {copyError && <div className="artifact-alert" role="alert"><p>{copyError}</p><input className="artifact-remote-fallback" aria-label="Git remote" readOnly value={link.url} onFocus={(event) => event.currentTarget.select()} /></div>}
  </>;
  const region = <div id={regionId} className="artifact-region">{repo ? <RepositoryPreview repository={repository} />
    : <><div className="artifact-stage"><ArtifactFrame src={link.url} title={`Preview of ${title}`} /></div><p className="artifact-caption">If this site blocks embedded previews, open it in a new tab.</p></>}</div>;
  return <section className={`artifact-card ${open ? 'is-open' : ''}`} aria-label={`Cloudflare artifact: ${title}`}>
    {header()}
    {!expanded && notices}
    <div className="artifact-actions"><button type="button" className="button secondary" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen(!open)}><PlayIcon />{open ? 'Hide' : 'Preview'}</button><button type="button" className="button secondary" onClick={() => setExpanded(true)}><ArrowsPointingOutIcon /> Expand</button></div>
    {open && !expanded && region}
    {expanded && <Modal title={title} className="artifact-modal" hideHeader onClose={dismiss}>{header(dismiss)}{notices}{region}</Modal>}
  </section>;
}
