import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TeamTask } from '../shared/types';
import type { ProjectDetail, ProjectRun } from '../shared/projects';
import type { Integration } from '../shared/execution';
import { api, post } from './api';
import Modal from './Modal';
import { useProjectCommand } from './ProjectContinuity';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request failed.';
export function HostedCommand({ run, base, onClose, onSaved }: { run: ProjectRun; base: string; onClose: () => void; onSaved: () => void }) {
  const [command, setCommand] = useState(''), request = useProjectCommand();
  const send = useMutation({ mutationFn: () => post(`${base}/runs/${run.id}/execute`, request({ command })), onSuccess: () => { onSaved(); onClose(); } });
  return <Modal title="Run in Cloudflare" onClose={onClose}><form className="project-form" onSubmit={e => { e.preventDefault(); send.mutate(); }}><p>Run a command in your isolated workspace. Successful commands commit and push a checkpoint. Commands stop after four minutes.</p><label>Command<textarea required rows={8} maxLength={12000} value={command} onChange={e=>setCommand(e.target.value)} placeholder="npm ci && npm test" /></label>{send.isError && <p role="alert" className="project-error">{errorText(send.error)}</p>}<div className="project-form-actions"><button type="submit" className="button primary" disabled={send.isPending || !command.trim()}>{send.isPending?'Starting…':'Run command'}</button></div></form></Modal>;
}
export function NewWorkspace({ base, onClose, onSaved, tasks, selfId }: { tasks: TeamTask[]; selfId: string; base: string; onClose: () => void; onSaved: () => void }) {
  const [title,setTitle]=useState(''),[taskId,setTaskId]=useState(''),request=useProjectCommand();
  const start=useMutation({mutationFn:()=>post(`${base}/runs`,request({title,paths:[], ...(taskId ? {task_id:taskId} : {})})),onSuccess:()=>{onSaved();onClose();}});
  return <Modal title="New workspace" onClose={onClose}><form className="project-form" onSubmit={e=>{e.preventDefault();start.mutate();}}><p>Start from the latest integrated code in a separate repository.</p><label>Task<select value={taskId} onChange={e=>{setTaskId(e.target.value);const task=tasks.find(t=>t.id===e.target.value);if(task)setTitle(task.title);}}><option value="">Choose a task (optional)</option>{tasks.filter(t=>t.status!=='done'&&(!t.assignee_id||t.assignee_id===selfId)).map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label><label>What will you work on?<input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)} /></label>{start.isError&&<p className="project-error" role="alert">{errorText(start.error)}</p>}<button className="button primary" disabled={start.isPending||!title.trim()}>{start.isPending?'Creating…':'Create workspace'}</button></form></Modal>;
}
export default function ProjectExecution({ detail, base, workspaceId, canReview, onSaved }: { detail: ProjectDetail; base: string; workspaceId: string; canReview: boolean; onSaved: () => void }) {
  const [selected,setSelected]=useState<string[]>([]),[review,setReview]=useState<string|null>(null),request=useProjectCommand();
  const available=detail.candidates.filter(c=>!['stale','integrated'].includes(c.status)&&c.requirements_revision===detail.project.revision);
  const selectedIds=selected.filter(id=>available.some(c=>c.id===id));
  const prepare=useMutation({mutationFn:()=>post(`${base}/integrations`,request({candidate_ids:selectedIds})),onSuccess:()=>{setSelected([]);onSaved();}});
  const busy=detail.integrations.some(i=>['preparing','checking','publishing'].includes(i.status));
  const current=detail.integrations.find(i=>i.id===review);
  return <section className="project-section project-finish"><div className="project-section-heading"><h3>Finish the change</h3></div>
    {!detail.hosted_available&&<p className="project-caption">Hosted execution is unavailable. You can still work locally and submit commits.</p>}
    {!detail.project.check_command&&<p className="project-caption">Set a check command in requirements to verify the combined result.</p>}
    {available.length>0&&<><div className="project-combine-list">{available.map(c=><label key={c.id}><input type="checkbox" checked={selected.includes(c.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,c.id]:ids.filter(id=>id!==c.id))} disabled={busy||prepare.isPending}/><span>{c.summary}</span></label>)}</div><button type="button" className="button secondary" disabled={!selectedIds.length||!detail.hosted_available||!detail.project.check_command||busy||prepare.isPending} onClick={()=>prepare.mutate()}>{prepare.isPending?'Starting…':'Check together'}</button></>}
    {!available.length&&!detail.integrations.length&&<p className="project-caption">Submit a candidate, then check the combined result here.</p>}
    {prepare.isError&&<p className="project-error" role="alert">{errorText(prepare.error)}</p>}
    <div className="project-integration-list">{detail.integrations.map(i=><article key={i.id} className="project-integration"><div><strong>{i.status==='integrated'?'Integrated':i.status==='ready'?'Ready to integrate':i.status==='preparing'?'Combining changes…':i.status==='checking'?'Running checks…':i.status==='publishing'?'Integrating…':i.status==='stale'?'Outdated':'Needs attention'}</strong><p>{i.commit_hash?i.commit_hash.slice(0,8):`${i.candidate_ids.length} ${i.candidate_ids.length===1?'candidate':'candidates'}`}{i.status==='ready'?' · Checks passed':''}</p></div><button type="button" className="button secondary" onClick={()=>setReview(i.id)}>{i.status==='ready'?'Review result':'Details'}</button></article>)}</div>
    {current&&<IntegrationReview integration={current} workspaceId={workspaceId} base={base} canReview={canReview} onClose={()=>setReview(null)} onSaved={onSaved}/>}
  </section>;
}
type Files = { files: {path:string;status:string}[]; before:string|null; after:string|null; binary:boolean; truncated:boolean };
function IntegrationReview({integration,workspaceId,base,canReview,onClose,onSaved}:{integration:Integration;workspaceId:string;base:string;canReview:boolean;onClose:()=>void;onSaved:()=>void}) {
  const [path,setPath]=useState(''), [section,setSection]=useState<'checks'|'files'>('checks');
  const files=useQuery({queryKey:['candidate-files',workspaceId,integration.id,path],enabled:!!integration.commit_hash&&section==='files',queryFn:()=>api<Files>(`${base}/integrations/${integration.id}/files?path=${encodeURIComponent(path)}`)});
  const publish=useMutation({mutationFn:()=>post(`${base}/integrations/${integration.id}/publish`,{commit:integration.commit_hash,base_commit:integration.base_commit,requirements_revision:integration.requirements_revision}),onSuccess:onSaved});
  return <Modal title="Combined result" className="project-review-modal" onClose={onClose}><div className="project-review"><p>{integration.candidate_ids.length} {integration.candidate_ids.length===1?'candidate':'candidates'} combined against <code>{integration.base_commit.slice(0,8)}</code>. Requirements r{integration.requirements_revision}.</p>{integration.commit_hash&&<code>{integration.commit_hash}</code>}<div className="library-tabs"><button type="button" aria-pressed={section==='checks'} onClick={()=>setSection('checks')}>Checks</button><button type="button" aria-pressed={section==='files'} disabled={!integration.commit_hash} onClick={()=>setSection('files')}>Changes</button></div>
    {section==='checks'?<div className="project-reported">
      <p>
        {integration.commit_hash?'Check runs in a fresh Cloudflare container against this exact commit.':'Preparing the combined commit before running checks.'}
      </p>
      <pre>{integration.check_command}</pre>
      <pre>
        {integration.result.stdout||integration.result.stderr||integration.result.error||(['preparing','checking','publishing'].includes(integration.status)?'Waiting for the hosted job…':'No output was captured.')}
        {integration.result.stdout&&integration.result.stderr?`\n${integration.result.stderr}`:''}
      </pre>
      {integration.result.exit_code!==undefined&&<p>Exit code {integration.result.exit_code}</p>}
    </div>:<>
      {files.isPending&&<p role="status">Loading changes…</p>}
      {files.isError&&<p role="alert" className="project-error">{errorText(files.error)}</p>}
      {files.data&&<>
        <div className="project-changes">
          <nav className="project-file-list" aria-label="Combined changed files">
            {files.data.files.map(f=><button key={f.path} type="button" aria-current={path===f.path?'true':undefined} onClick={()=>setPath(f.path)}>
              {f.path}
            </button>)}
          </nav>
          <div className="project-source">
            {!path?<p>Select a file.</p>:files.data.binary?<p>Inspect this large or binary file with Git.</p>:<div className="project-source-panes">
              <section>
                <h4>Before</h4>
                <pre>{files.data.before??'New file'}</pre>
              </section>
              <section>
                <h4>After</h4>
                <pre>{files.data.after??'Deleted file'}</pre>
              </section>
            </div>}
          </div>
        </div>
        {files.data.truncated&&<p>Change list truncated. Inspect the complete commit with Git.</p>}
      </>}
    </>}
    {publish.isError&&<p role="alert" className="project-error">{errorText(publish.error)}</p>}
    <div className="project-form-actions">{integration.status==='ready'&&canReview?<><p>Publish this exact checked commit to the project.</p><button type="button" className="button primary" disabled={publish.isPending} onClick={()=>publish.mutate()}>{publish.isPending?'Starting…':'Approve & integrate'}</button></>:<p role="status">{integration.status==='integrated'?'This commit is now the project base.':integration.status==='publishing'?'Publishing the approved commit…':integration.status==='stale'?'The inputs changed. Prepare a new result.':'This result is not ready to publish.'}</p>}</div>
  </div></Modal>;
}
export function SubmitHostedCandidate({run,commit,base,onClose,onSaved}:{run:ProjectRun;commit:string;base:string;onClose:()=>void;onSaved:()=>void}) {
  const [summary,setSummary]=useState(run.title);
  const send=useMutation({mutationFn:()=>post(`${base}/runs/${run.id}/candidates`,{commit,requirements_revision:run.requirements_revision,summary,checks:'Created in a hosted workspace. Independent checks are run when preparing integration.'}),onSuccess:()=>{onSaved();onClose();}});
  return <Modal title="Submit result" onClose={onClose}><form className="project-form" onSubmit={e=>{e.preventDefault();send.mutate();}}><p>Submit <code>{commit.slice(0,8)}</code> for review and integration.</p><label>What changed?<textarea required rows={4} maxLength={6000} value={summary} onChange={e=>setSummary(e.target.value)}/></label>{send.isError&&<p className="project-error" role="alert">{errorText(send.error)}</p>}<button className="button primary" disabled={send.isPending||!summary.trim()}>{send.isPending?'Submitting…':'Submit result'}</button></form></Modal>;
}
