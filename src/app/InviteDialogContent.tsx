import { useState } from 'react';
import { CheckIcon, ClipboardDocumentIcon, LinkIcon } from '@heroicons/react/16/solid';

export default function InviteDialogContent({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState('');
  async function copy() {
    setCopying(true);
    setError('');
    try { await navigator.clipboard.writeText(url); setCopied(true); }
    catch { setCopied(false); setError('Could not copy automatically. Select the invite link and copy it manually.'); }
    finally { setCopying(false); }
  }
  return <div className="modal-form">
    <p>Share this link with teammates. It expires in seven days and allows up to ten people to join.</p>
    <div className="invite-link"><LinkIcon /><input name="invite-link" aria-label="Invite link" readOnly value={url} onFocus={(event) => event.currentTarget.select()} /></div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="button primary" disabled={copying} onClick={() => void copy()}>{copied ? <CheckIcon /> : <ClipboardDocumentIcon />}{copying ? 'Copying…' : copied ? 'Copied' : 'Copy link'}</button></div>
    {copied && <span className="sr-only" role="status">Invite link copied.</span>}
  </div>;
}
