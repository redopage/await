import { useMutation, useQuery } from '@tanstack/react-query';
import type { ProjectRun } from '../shared/projects';
import { api, post } from './api';
import Modal from './Modal';
import { useProjectCommand } from './ProjectContinuity';

export default function ProjectBranch({ run, base, onClose, onSaved }: { run: ProjectRun; base: string; onClose: () => void; onSaved: () => void }) {
  const request = useProjectCommand(), restoring = Boolean(run.branch_deleted_at);
  const branch = useQuery({ queryKey: ['project-branch', run.id, run.branch_deleted_at], queryFn: () => api<{ branch: string; commit: string }>(`${base}/runs/${run.id}/branch`) });
  const failure = branch.error ?? null;
  const save = useMutation({ mutationFn: () => post(`${base}/runs/${run.id}/branch`, request({ operation: restoring ? 'restore_branch' : 'delete_branch', commit: branch.data!.commit })), onSuccess: () => { onSaved(); onClose(); } });
  return <Modal title={restoring ? 'Restore branch' : 'Delete branch'} onClose={onClose}><div className="project-form">
    <p><code>{run.branch}</code></p>
    {branch.isPending ? <p role="status">Reading the current commit…</p> : branch.data && <><p>{restoring ? 'Restore this branch at' : 'Remove this completed attempt branch at'} <code>{branch.data.commit.slice(0, 8)}</code>.</p><p>Code and review history remain available. A saved recovery ref lets you restore the branch later.</p></>}
    {(branch.isError || save.isError) && <p role="alert" className="project-error">{(failure ?? save.error)?.message ?? 'The branch operation failed.'}</p>}
    <div className="project-form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={!branch.data || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Starting…' : restoring ? 'Restore branch' : 'Delete branch'}</button></div>
  </div></Modal>;
}
