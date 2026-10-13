import { useState } from 'react';
import { ArrowUpTrayIcon, DocumentIcon, MagnifyingGlassIcon, PhotoIcon, XMarkIcon } from '@heroicons/react/16/solid';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { attachmentKind, formatBytes } from '../shared/attachments';

type UploadedFile = {
  id: string;
  filename: string;
  kind: string;
  mime: string;
  size: number;
  created_at: number;
  channel_id: string;
  channel_name: string;
};

export default function FilePicker({ workspaceId, onChoose, onUpload, onClose, busy }: {
  workspaceId: string;
  onChoose: (file: UploadedFile) => void;
  onUpload: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [search, setSearch] = useState('');
  const files = useQuery({ queryKey: ['file-library', workspaceId, search], queryFn: () => api<UploadedFile[]>(`/workspaces/${workspaceId}/files?q=${encodeURIComponent(search)}`), staleTime: 0 });
  const matches = files.data ?? [];
  return <div className="file-picker" role="dialog" aria-label="Choose an uploaded file">
    <div className="file-picker-head"><strong>Files</strong><button type="button" aria-label="Close files" onClick={onClose}><XMarkIcon /></button></div>
    <label className="file-picker-search"><MagnifyingGlassIcon /><input autoFocus aria-label="Search uploaded files" placeholder="Search uploaded files" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="file-picker-list">
      {files.isLoading && <p className="file-picker-empty">Loading files…</p>}
      {files.isError && <p className="file-picker-empty">Files could not load. <button type="button" onClick={() => void files.refetch()}>Try again</button></p>}
      {!files.isLoading && !files.isError && !matches.length && <p className="file-picker-empty">{search ? 'No matching files.' : 'No files shared yet. Upload one to get started.'}</p>}
      {matches.map((file) => <button type="button" className="file-picker-item" key={file.id} disabled={busy} onClick={() => onChoose(file)}>
        <span className="file-picker-icon">{attachmentKind(file.mime) === 'image' ? <PhotoIcon /> : <DocumentIcon />}</span>
        <span className="file-picker-copy"><strong title={file.filename}>{file.filename}</strong><small>{file.channel_name.startsWith('dm-') ? 'Direct message' : `#${file.channel_name}`} · {formatBytes(file.size)}</small></span>
      </button>)}
    </div>
    <button type="button" className="file-picker-upload" disabled={busy} onClick={onUpload}><ArrowUpTrayIcon /> Upload from your computer</button>
  </div>;
}
