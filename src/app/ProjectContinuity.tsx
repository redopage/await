import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Project, ProjectHandoff, ProjectRun, RequirementsRevision } from '../shared/projects';
import { api, ApiError, post } from './api';
import Modal from './Modal';

function ErrorMessage({ error }: { error: unknown }) {
  return <p role="alert" className="project-error">{error instanceof Error ? error.message : 'The request failed.'}</p>;
}
// Retain the exact command across an uncertain network response, but not across edited input.
export function useProjectCommand() {
  const request = useRef<{ payload: string; id: string }>();
  return (input: Record<string, unknown>) => {
    const payload = JSON.stringify(input);
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    return { ...input, client_id: request.current.id };
  };
}

export function RequirementsEditor({ project, base, onClose, onSaved }: { project: Project; base: string; onClose: () => void; onSaved: () => void }) {
  const [revision, setRevision] = useState(project.revision);
  const [title, setTitle] = useState(project.title), [goal, setGoal] = useState(project.goal);
  const [checkCommand,setCheckCommand]=useState(project.check_command);
  const [criteria, setCriteria] = useState(project.acceptance_criteria), [reason, setReason] = useState('');
  const [current, setCurrent] = useState<Project | null>(null);
  const command = useProjectCommand();
  const save = useMutation({ mutationFn: () => post(`${base}/requirements`, command({ expected_revision: revision, title, goal, acceptance_criteria: criteria, check_command: checkCommand, reason })),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (error) => { if (error instanceof ApiError && error.status === 409 && error.current) setCurrent(error.current as Project); },
  });
  return <Modal title="Update accepted requirements" onClose={() => { if (!save.isPending) onClose(); }}><form className="project-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <p>Editing revision {revision}. Saving preserves this version and marks unfinished candidates as outdated. Teammates must start a new attempt against the new requirements.</p>
    <label>Project name<input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
    <label>Desired outcome<textarea required rows={3} maxLength={6000} value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
    <label>Acceptance criteria<textarea rows={5} maxLength={6000} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="Describe the behaviors a reviewer should be able to verify. One criterion per line." /></label>
    <label>Check command<textarea rows={2} maxLength={4000} value={checkCommand} onChange={e=>setCheckCommand(e.target.value)} placeholder="npm ci && npm test && npm run build" /></label>
    <label>Why is this changing?<textarea required rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Record the decision for the next person or agent." /></label>
    {save.isError && <ErrorMessage error={save.error} />}
    {current && <section className="project-conflict"><h3>Someone saved revision {current.revision}</h3><p>Your draft is preserved above. Compare it with the accepted version before trying again.</p><strong>{current.title}</strong><p>{current.goal}</p><pre>{current.acceptance_criteria || 'No acceptance criteria recorded.'}</pre><button className="button secondary" type="button" onClick={() => { setRevision(current.revision); setCurrent(null); save.reset(); }}>I compared the versions, keep my draft</button></section>}
    <div className="project-form-actions"><button type="button" className="button secondary" disabled={save.isPending} onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={save.isPending || !!current || !title.trim() || !goal.trim() || !reason.trim()}>{save.isPending ? 'Saving…' : 'Save new revision'}</button></div>
  </form></Modal>;
}

export function RequirementsHistory({ revisions, onClose }: { revisions: RequirementsRevision[]; onClose: () => void }) {
  return <Modal title="Requirements history" onClose={onClose}><div className="project-form">{[...revisions].reverse().map((revision) => <article className="project-requirement-version" key={revision.revision}><h3>Revision {revision.revision}: {revision.title}</h3><p>{revision.goal}</p><pre>{revision.acceptance_criteria || 'No acceptance criteria recorded.'}</pre>{revision.check_command&&<pre>{revision.check_command}</pre>}<p><strong>Decision:</strong> {revision.reason}</p><small>{new Date(revision.created_at).toLocaleString()}</small></article>)}</div></Modal>;
}

export function CancelAttempt({ run, base, onClose, onSaved }: { run: ProjectRun; base: string; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const command = useProjectCommand();
  const cancel = useMutation({ mutationFn: () => post(`${base}/runs/${run.id}/cancel`, command({ expected_revision: run.revision, reason })), onSuccess: () => { onSaved(); onClose(); } });
  return <Modal title="Cancel this attempt" onClose={() => { if (!cancel.isPending) onClose(); }}>
    <form className="project-form" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
      <h3>{run.title}</h3>
      <p>Its code and checkpoints stay in the project. Await will reject new results from this attempt and mark its candidates outdated.</p>
      <p>This does not stop a process running in another tool. Git token revocation is attempted; existing access to this isolated fork expires within 15 minutes.</p>
      <label>Reason<textarea required rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain what should happen next." /></label>
      {cancel.isError && <ErrorMessage error={cancel.error} />}
      <div className="project-form-actions">
        <button type="button" className="button secondary" disabled={cancel.isPending} onClick={onClose}>Keep attempt</button>
        <button type="submit" className="button primary" disabled={cancel.isPending || !reason.trim()}>
          {cancel.isPending ? 'Cancelling…' : 'Cancel attempt'}
        </button>
      </div>
    </form>
  </Modal>;
}

export function HandoffDialog({ workspaceId, project, base, onClose }: { workspaceId: string; project: Project; base: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState<unknown>(null);
  const packet = useQuery({ queryKey: ['project', workspaceId, project.id, 'handoff'], queryFn: () => api<ProjectHandoff>(`${base}/handoff`), staleTime: 0 });
  const serialized = packet.data ? JSON.stringify(packet.data, null, 2) : '';
  const download = () => {
    const url = URL.createObjectURL(new Blob([serialized + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `await-handoff-${project.id}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(serialized); setCopied(true); setCopyError(null); }
    catch (error) { setCopyError(error); }
  };
  return <Modal title="Continue in another tool" onClose={onClose}><div className="project-form">
    <p>Take the accepted requirements, saved checkpoints, candidate commits, and review feedback into your next session. No Git tokens are included.</p>
    {packet.isPending && <p role="status">Preparing the current handoff…</p>}{packet.isError && <><ErrorMessage error={packet.error} /><button type="button" className="button secondary" onClick={() => void packet.refetch()}>Try again</button></>}
    {packet.data && <>
      <div className="project-handoff-summary">
        <strong>{packet.data.project.title}</strong>
        <span>Requirements r{packet.data.project.revision} · {packet.data.runs.length} attempts · {packet.data.candidates.length} candidates</span>
        <span>History through event #{packet.data.snapshot_cursor}</span>
      </div>
      <ol className="project-handoff-steps">
        <li>Connect the next named agent to this project’s channel.</li>
        <li>Give it this packet and the task you want it to perform.</li>
        <li>Have it read <code>read_project</code> after cursor <strong>{packet.data.snapshot_cursor}</strong>, then start its own attempt.</li>
      </ol>
      <p>Existing attempts keep their original owner. The next agent receives the shared work context, including earlier decisions and checkpoints.</p>
      {packet.data.history_truncated && <p>The packet includes the latest 100 events. Full history remains available through <code>read_project</code>.</p>}
      <details>
        <summary>Inspect handoff packet</summary>
        <pre className="project-handoff-json">{serialized}</pre>
      </details>
      {copyError && <ErrorMessage error={copyError} />}
      {copied && <p role="status">Handoff copied.</p>}
      <div className="project-form-actions">
        <button type="button" className="button secondary" onClick={download}>Download JSON</button>
        <button type="button" className="button primary" onClick={() => void copy()}>
          {copied ? 'Copy again' : 'Copy handoff'}
        </button>
      </div>
    </>}
  </div></Modal>;
}
