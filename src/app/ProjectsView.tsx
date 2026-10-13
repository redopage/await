import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, ArrowPathIcon, ArrowRightIcon, CheckCircleIcon, CodeBracketIcon, CommandLineIcon, ExclamationTriangleIcon, MoonIcon, PlusIcon, RectangleStackIcon } from '@heroicons/react/16/solid';
import type { Channel, Member } from '../shared/types';
import type { Candidate, Project, ProjectDetail, ProjectEvent, ProjectRepository, ProjectRun } from '../shared/projects';
import { api, navigate, post } from './api';
import Modal from './Modal';
import TasksView from './TasksView';
import ProjectBranch from './ProjectBranch';
import ProjectExecution, { HostedCommand, NewWorkspace, SubmitHostedCandidate } from './ProjectExecution';
import { RequirementsEditor, RequirementsHistory, HandoffDialog, CancelAttempt, useProjectCommand } from './ProjectContinuity';

type Props = { workspaceId: string; selfId: string; channels: Channel[]; members: Member[] };
type ProjectList = { available: boolean; projects: Project[]; repositories: ProjectRepository[] };
const stamp = (time: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(time);
const statusLabel: Record<string, string> = { integrated: 'Integrated', cancelled: 'Cancelled', stale: 'Outdated', active: 'Open', provisioning: 'Provisioning', working: 'Working', sleeping: 'Sleeping', submitted: 'In review', failed: 'Needs recovery', pending: 'Needs review', approved: 'Approved', changes_requested: 'Changes requested' };
function Status({ value }: { value: string }) { return <span className={`project-status status-${value}`}>{value === 'sleeping' ? <MoonIcon aria-hidden="true" /> : value === 'approved' ? <CheckCircleIcon aria-hidden="true" /> : null}{statusLabel[value] ?? value}</span>; }
function Failure({ error, retry }: { error: unknown; retry?: () => void }) { return <div className="project-error" role="alert"><ExclamationTriangleIcon /><p>{error instanceof Error ? error.message : 'This request could not complete.'}</p>{retry && <button type="button" className="button secondary" onClick={retry}>Try again</button>}</div>; }
function eventText(event: ProjectEvent): string {
  const data = event.data;
  switch (event.type) {
    case 'branch.cleanup_started': return `${data.operation === 'restore_branch' ? 'Restoring' : 'Deleting'} the completed attempt branch.`;
    case 'branch.cleanup_finished': return `Branch ${data.operation === 'restore_branch' ? 'restoration' : 'cleanup'} ${data.status}.`;
    case 'execution.started': return 'Started a hosted command.';
    case 'execution.finished': return `Hosted command ${data.status}${data.commit ? `, saved ${String(data.commit).slice(0,8)}` : ''}.`;
    case 'integration.started': return 'Preparing the combined result.';
    case 'integration.checked': return 'The combined result passed hosted checks.';
    case 'integration.authorized': return 'Approved the checked result for integration.';
    case 'integration.published': return `Integrated ${String(data.commit).slice(0,8)}. New workspaces start here.`;
    case 'requirements.updated': return `Accepted requirements revision ${data.revision}. ${data.reason}`;
    case 'run.cancelled': return `Cancelled this attempt. ${data.reason}`;
    case 'project.created': return 'Created the shared goal and canonical repository.';
    case 'run.started': return `Started a separate workspace: ${data.title}.`;
    case 'run.sleeping': return `Saved a checkpoint and went to sleep. ${data.checkpoint || ''}`;
    case 'run.resumed': return `Resumed work. ${data.checkpoint || ''}`;
    case 'scope.overlap': return `Flagged overlapping scope: ${(data.paths as string[]).join(', ')}. Coordinate before editing.`;
    case 'coordination.note': return String(data.body);
    case 'candidate.published': return `Submitted ${String(data.commit).slice(0, 8)} for review. ${data.summary}`;
    case 'candidate.reviewed': return `${data.status === 'approved' ? 'Approved' : 'Requested changes on'} ${String(data.commit).slice(0, 8)}. ${data.note || ''}`;
    default: return event.type;
  }
}
export default function ProjectsView({ workspaceId, selfId, channels, members }: Props) {
  const client = useQueryClient(), base = `/workspaces/${workspaceId}/collab/projects`;
  const projectId = new URLSearchParams(window.location.search).get('project');
  const [creating, setCreating] = useState(false), [guide, setGuide] = useState(false), [search, setSearch] = useState('');
  const [review, setReview] = useState<Candidate | null>(null), [note, setNote] = useState('');
  const [editingRequirements, setEditingRequirements] = useState(false), [showRequirementsHistory, setShowRequirementsHistory] = useState(false), [handoff, setHandoff] = useState(false), [cancelling, setCancelling] = useState<ProjectRun | null>(null);
  const canReview = members.find((m) => m.account_id === selfId)?.kind === 'human';
  const [hostedRun,setHostedRun]=useState<ProjectRun|null>(null),[newWorkspace,setNewWorkspace]=useState(false);
  const [branchRun,setBranchRun]=useState<ProjectRun|null>(null);
  const [submission,setSubmission]=useState<{run:ProjectRun;commit:string}|null>(null);
  const noteRequest = useRef<{ body: string; id: string } | null>(null);
  const [after, setAfter] = useState(0), [history, setHistory] = useState<ProjectEvent[]>([]);
  const list = useQuery({ queryKey: ['projects', workspaceId], queryFn: () => api<ProjectList>(base) });
  const detail = useQuery({ queryKey: ['project', workspaceId, projectId, after], queryFn: () => api<ProjectDetail>(`${base}/${projectId}?after=${after}`), enabled: Boolean(projectId), refetchInterval: 3_000, placeholderData: (previous) => previous?.project.id === projectId ? previous : undefined });
  useEffect(() => { setAfter(0); setHistory([]); setNote(''); }, [projectId]);
  const invalidate = () => { void client.invalidateQueries({ queryKey: ['projects', workspaceId] }); void client.invalidateQueries({ queryKey: ['project', workspaceId, projectId] }); };
  const send = useMutation({ mutationFn: (body: string) => { if (noteRequest.current?.body !== body) noteRequest.current = { body, id: crypto.randomUUID() }; return post(`${base}/${projectId}/events`, { body, client_id: noteRequest.current.id }); }, onSuccess: () => { noteRequest.current = null; setNote(''); invalidate(); } });
  const open = (project?: Project) => { const channel = project?.channel_id ?? channels.find((c) => c.joined)?.id; if (channel) navigate(`/w/${workspaceId}/${channel}?view=projects${project ? `&project=${project.id}` : ''}`); };
  const name = (actor: string) => members.find((m) => m.account_id === actor)?.name ?? 'Former teammate';
  const project = detail.data?.project;
  const runs = [...(detail.data?.runs ?? [])].sort((a,b) => Number(['integrated','cancelled'].includes(a.status))-Number(['integrated','cancelled'].includes(b.status)) || b.created_at-a.created_at);
  const events = [...new Map([...history, ...(detail.data?.events ?? [])].map((e) => [e.seq, e])).values()].sort((a, b) => b.seq - a.seq);
  // Events page oldest first, so follow the cursor until the newest page is the one being polled.
  useEffect(() => { if (detail.data?.has_more) { setHistory(events); setAfter(detail.data.next_cursor); } }, [detail.data]);
  return <div className="projects-view antialiased isolate">
    {projectId ? <>
      <div className="project-topline"><button type="button" className="button subtle" onClick={() => open()}><ArrowLeftIcon /> All projects</button><div className="project-top-actions">{project && <button type="button" className="button secondary" onClick={() => setHandoff(true)}>Handoff <ArrowRightIcon /></button>}<button type="button" className="button secondary" onClick={() => setGuide(true)}><CommandLineIcon /> Agent setup</button></div></div>
      {detail.isPending && <p role="status">Loading project…</p>}
      {detail.isError && <Failure error={detail.error} retry={() => void detail.refetch()} />}
      {project && detail.data && <>
        <header className="project-heading"><h2>{project.title}</h2><p>{project.goal}</p><div className="project-heading-meta"><Status value={project.status} /><span>#{channels.find((c) => c.id === project.channel_id)?.name ?? 'channel'}</span><span><CodeBracketIcon /> {project.branch} <code>{project.base_commit.slice(0, 8)}</code></span></div></header>
        {project.status === 'failed' && <Failure error={new Error('Repository provisioning did not finish. The source is unchanged. Check the Artifacts connection and create a new project.')} />}

        <details className="project-requirements" open><summary>Acceptance criteria · r{project.revision}</summary><div className="project-section-heading"><div className="project-top-actions"><button type="button" className="button subtle" onClick={() => setShowRequirementsHistory(true)}>History · r{project.revision}</button>{canReview && <button type="button" className="button secondary" onClick={() => setEditingRequirements(true)}>Edit requirements</button>}</div></div>{project.acceptance_criteria ? <p>{project.acceptance_criteria}</p> : <p className="project-caption">Add acceptance criteria so every teammate and reviewer knows which behaviors to verify.</p>}</details>

        {project.board_id && <TasksView key={project.board_id} workspaceId={workspaceId} channelId={project.channel_id} members={members} requestedBoardId={project.board_id} projectRuns={detail.data.runs} embedded />}
        <div className="project-columns"><div className="project-main-column">
          <section className="project-section"><div className="project-section-heading"><h3>Workspaces</h3><button type="button" className="button secondary" onClick={()=>setNewWorkspace(true)}>New workspace</button></div>
            {!detail.data.runs.length && <div className="project-empty-inline"><p>Give each teammate a piece of the goal.</p><p>Agents claim paths, work in separate Git repositories, and bring their results back here.</p><button type="button" className="button secondary" onClick={() => setGuide(true)}>Get agent instructions <ArrowRightIcon /></button></div>}
            <div className="project-run-list">
              {runs.map((run) => <article className="project-run" key={run.id} id={`project-run-${run.id}`}>
                <div className="project-run-heading">
                  <div>
                    <p className="project-person">{name(run.actor_id)}</p>
                    <h4>{run.title}</h4>
                  </div>
                  <Status value={run.status} />
                </div>
                {detail.data.hosted_available && run.actor_id===selfId && !['cancelled','integrated'].includes(run.status) && run.requirements_revision===project.revision && <button type="button" className="button secondary" onClick={()=>setHostedRun(run)}>Run command</button>}
                <div className="project-claims">
                  {run.paths.length ? run.paths.map((path) => <code key={path}>{path}</code>) : <p>No paths claimed yet.</p>}
                </div>
                {run.checkpoint && <blockquote>{run.checkpoint}</blockquote>}
                <div className="project-run-footer">
                  <span>Base <code>{run.base_commit.slice(0, 8)}</code></span>
                  <span>Requirements r{run.requirements_revision}</span>
                  <code>{run.branch}</code>
                </div>
                {canReview && ['integrated','cancelled'].includes(run.status) && run.branch.startsWith('codex/') && (run.branch_deleted_at || detail.data.jobs.some(j=>j.run_id===run.id && j.kind==='execute' && j.result.commit) || detail.data.candidates.some(c=>c.run_id===run.id)) && <button type="button" className="button subtle" disabled={detail.data.jobs.some(j=>j.run_id===run.id&&['queued','running'].includes(j.status))} onClick={()=>setBranchRun(run)}>
                  {detail.data.jobs.some(j=>j.run_id===run.id&&j.kind!=='execute'&&['queued','running'].includes(j.status)) ? 'Updating branch…' : run.branch_deleted_at ? 'Restore branch' : 'Delete branch'}
                </button>}
                {detail.data.jobs.filter(j=>j.run_id===run.id&&j.kind!=='execute'&&['failed','interrupted'].includes(j.status)).slice(0,1).map(job=><p key={job.id} className="project-error" role="alert">Branch cleanup needs attention: {job.result.stderr||job.result.error||'Refresh the branch and try again.'}</p>)}
                {!['integrated','cancelled'].includes(run.status) && run.requirements_revision !== project.revision && <p className="project-stale-notice">Requirements changed. Start a new attempt from the current handoff.</p>}
                {detail.data.jobs.filter(j=>j.run_id===run.id && j.kind==='execute').slice(0,3).map(job=><details className="project-job" key={job.id}>
                  <summary>
                    {['running','queued'].includes(job.status)?'Running in Cloudflare…':job.status==='complete'?`Saved ${job.result.commit?.slice(0,8)}`:'Command needs attention'}
                  </summary>
                  <pre>{job.command}</pre>
                  <pre>{[job.result.stdout,job.result.stderr,job.result.error].filter(Boolean).join('\n')||(['queued','running'].includes(job.status)?'Waiting for output…':'No output was captured.')}</pre>
                  {job.result.exit_code!==undefined&&<p>Exit code {job.result.exit_code}</p>}
                  {job.status==='complete' && job.result.commit && run.actor_id===selfId && !['cancelled','integrated'].includes(run.status) && run.requirements_revision===project.revision && !detail.data.candidates.some(c=>c.run_id===run.id&&c.commit_hash===job.result.commit) && <button type="button" className="button secondary" onClick={()=>setSubmission({run,commit:job.result.commit!})}>Submit result</button>}
                </details>)}
                {run.cancellation_reason && <p className="project-caption">Cancelled: {run.cancellation_reason}</p>}
                {!['cancelled','integrated'].includes(run.status) && (canReview || run.actor_id === selfId) && <button type="button" className="button subtle project-run-cancel" onClick={() => setCancelling(run)}>Cancel attempt</button>}
              </article>)}
            </div>
          </section>
          <section className="project-section"><div className="project-section-heading"><h3>Candidates</h3><span>{detail.data.candidates.length} {detail.data.candidates.length === 1 ? 'candidate' : 'candidates'}</span></div>{!detail.data.candidates.length && <div className="project-empty-inline"><CheckCircleIcon /><p>Pushed commits arrive here with verified ancestry and an exact revision to review.</p></div>}
            <div className="project-candidates">{detail.data.candidates.map((candidate) => <article className="project-candidate" key={candidate.id}><div className="project-run-heading"><p className="project-person">{name(candidate.actor_id)} <code>{candidate.commit_hash.slice(0, 8)}</code></p><Status value={candidate.status} /></div><p className="project-candidate-summary">{candidate.summary}</p><div className="project-evidence"><span><CheckCircleIcon /> Commit verified</span><span>Requirements r{candidate.requirements_revision}</span><span>{candidate.checks ? 'Checks reported by author' : 'No checks reported'}</span></div><button type="button" className="button secondary" onClick={() => setReview(candidate)}>Inspect changes <ArrowRightIcon /></button>{candidate.reviewed_by && <p className="project-caption">Reviewed by {name(candidate.reviewed_by)}. {candidate.review_note}</p>}</article>)}</div>
          </section>
          <ProjectExecution detail={detail.data} base={`${base}/${project.id}`} workspaceId={workspaceId} canReview={canReview} onSaved={invalidate}/>
        </div><aside className="project-timeline"><div className="project-section-heading"><h3>Activity</h3><button type="button" className="icon-button" aria-label="Refresh project" onClick={invalidate}><ArrowPathIcon /></button></div>
          <form className="project-note" onSubmit={(e) => { e.preventDefault(); send.mutate(note); }}><label className="sr-only" htmlFor="coordination-note">Coordination note</label><textarea id="coordination-note" name="coordination-note" maxLength={6000} rows={3} placeholder="Ask a question or propose a change…" value={note} onChange={(e) => setNote(e.target.value)} /><button type="submit" className="button secondary" disabled={!note.trim() || send.isPending}>{send.isPending ? 'Saving…' : 'Post note'}</button>{send.isError && <Failure error={send.error} />}</form>
          <ol className="project-events" role="list">{events.map((event) => <li key={event.id} className={event.type === 'scope.overlap' ? 'project-overlap' : ''}><div className="project-event-meta"><strong>{name(event.actor_id)}</strong><time dateTime={new Date(event.created_at).toISOString()}>{stamp(event.created_at)}</time></div><p>{eventText(event)}</p></li>)}</ol>
        </aside></div>
      </>}
    </> : <>
      <header className="project-index-heading">{!!list.data?.projects.length && <input className="project-search" name="project-search" type="search" aria-label="Find a project" placeholder="Search projects" value={search} onChange={(e) => setSearch(e.target.value)} />}<button type="button" className="button secondary" disabled={!list.data?.available} onClick={() => setCreating(true)}><PlusIcon /> New project</button></header>
      {list.isPending && <p role="status">Loading projects…</p>}{list.isError && <Failure error={list.error} retry={() => void list.refetch()} />}
      {list.data && !list.data.available && <Failure error={new Error('Connect a Cloudflare Artifacts binding to create project repositories.')} />}
      {!!list.data?.projects.length && <><div className="project-index-list">{list.data.projects.filter((p) => `${p.title} ${p.goal}`.toLowerCase().includes(search.toLowerCase())).map((p) => <button type="button" className="project-index-row" key={p.id} onClick={() => open(p)}><div><h3>{p.title}</h3><p>{p.goal}</p><div className="project-index-meta"><Status value={p.status} /><span>#{channels.find((c) => c.id === p.channel_id)?.name ?? 'channel'}</span><span>Updated {stamp(p.updated_at)}</span></div></div><ArrowRightIcon /></button>)}</div>{!list.data.projects.some((p) => `${p.title} ${p.goal}`.toLowerCase().includes(search.toLowerCase())) && <p>No projects match this search.</p>}</>}
      {list.data && !list.data.projects.length && <div className="workspace-empty"><RectangleStackIcon aria-hidden="true" /><h2>No projects yet</h2><p>A project gives each agent its own copy of a repository, then brings their work back for review.</p><button type="button" className="button secondary" onClick={() => setGuide(true)}>How agents take part</button></div>}
    </>}
    {creating && list.data && <CreateProject repositories={list.data.repositories} channels={channels} workspaceId={workspaceId} base={base} onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); invalidate(); open(p); }} />}
    {guide && <Modal title="Bring an agent into the project" onClose={() => setGuide(false)}>
      <div className="project-guide">
        <p>Use Codex, Claude, or another MCP client. Connect each teammate as its own Await agent with read, post, and files access, then add it to this channel.</p>
        <pre>
          {project ? `Project: ${project.title}\nProject ID: ${project.id}\n\n` : ''}
          {`1. Read the goal with read_project.\n2. Call start_project_run with a fresh client_id,\n   your assignment, task_id from its card,\n   and relative file paths.\n3. Read scope.overlap events. Coordinate using\n   post_project_event before changing contracts.\n4. Use execute_project_command to build in a\n   hosted workspace. Poll read_project for results.\n   Or use get_project_run_token to work locally,\n   pushing to run.branch in your separate fork.\n5. Push your commit, then publish_candidate\n   with its full hash, requirements_revision,\n   and reported checks.\n6. Save context with checkpoint_project_run,\n   client_id, and the run's expected_revision.\n   Resume using read_project after your cursor.\n7. Use prepare_project_integration to combine\n   candidates and run independent hosted checks.\n   A person reviews and integrates the result.\n8. Use read_project_handoff to continue elsewhere.\n   Changed requirements need a new attempt.`}
        </pre>
        <p>For event delivery, turn on the agent’s listening in its settings with agent-authored events, or subscribe to <code>project.updated</code>. Read project history after reconnecting.</p>
        <p>Hosted workspaces run commands in Cloudflare. Your connected agent chooses the commands; no model credentials are copied into the workspace.</p>
      </div>
    </Modal>}
    {submission && project && <SubmitHostedCandidate run={submission.run} commit={submission.commit} base={`${base}/${project.id}`} onClose={()=>setSubmission(null)} onSaved={invalidate}/>}
    {hostedRun && project && <HostedCommand run={hostedRun} base={`${base}/${project.id}`} onClose={()=>setHostedRun(null)} onSaved={invalidate}/>}
    {branchRun && project && <ProjectBranch run={branchRun} base={`${base}/${project.id}`} onClose={()=>setBranchRun(null)} onSaved={invalidate}/>}
    {newWorkspace && project && <NewWorkspace tasks={detail.data?.tasks ?? []} selfId={selfId} base={`${base}/${project.id}`} onClose={()=>setNewWorkspace(false)} onSaved={invalidate}/>}
    {editingRequirements && project && <RequirementsEditor project={project} base={`${base}/${project.id}`} onClose={() => setEditingRequirements(false)} onSaved={invalidate} />}
    {showRequirementsHistory && detail.data && <RequirementsHistory revisions={detail.data.requirements} onClose={() => setShowRequirementsHistory(false)} />}
    {handoff && project && <HandoffDialog workspaceId={workspaceId} project={project} base={`${base}/${project.id}`} onClose={() => setHandoff(false)} />}
    {cancelling && project && <CancelAttempt run={cancelling} base={`${base}/${project.id}`} onClose={() => setCancelling(null)} onSaved={invalidate} />}
    {review && project && <CandidateReview requirementsRevision={project.revision} workspaceId={workspaceId} key={review.id} candidate={detail.data?.candidates.find((c) => c.id === review.id) ?? review} base={`${base}/${project.id}`} canReview={canReview} onClose={() => setReview(null)} onSaved={invalidate} />}
  </div>;
}
function CreateProject({ repositories, channels, workspaceId, base, onClose, onCreated }: { repositories: ProjectRepository[]; channels: Channel[]; workspaceId: string; base: string; onClose: () => void; onCreated: (p: Project) => void }) {
  const [requestId] = useState(() => crypto.randomUUID()), [repository, setRepository] = useState(repositories[0]?.name ?? ''), [title, setTitle] = useState(''), [goal, setGoal] = useState(''), [criteria, setCriteria] = useState(''), [checkCommand, setCheckCommand] = useState('');
  const create = useMutation({ mutationFn: () => post<Project>(base, { client_id: requestId, title, goal, acceptance_criteria: criteria, check_command: checkCommand, repository, channel_id: repositories.find((r) => r.name === repository)?.channel_id }), onSuccess: onCreated });
  return <Modal title="Create a shared project" onClose={() => { if (!create.isPending) onClose(); }}>
    <form className="project-form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <p>Await creates a separate canonical fork. Your source repository stays available for its existing workflow.</p>
      <label>Project name<input name="project-title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Password reset, end to end" /></label>
      <label>Shared goal<textarea name="project-goal" required maxLength={6000} rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Describe the outcome, constraints, and what success looks like." /></label>
      <label>Acceptance criteria<textarea name="project-criteria" maxLength={6000} rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="Which behaviors must the result demonstrate?" /></label>
      <label>Check command<input name="project-check-command" maxLength={4000} value={checkCommand} onChange={(e) => setCheckCommand(e.target.value)} placeholder="npm ci && npm test" /></label>
      <label>Starting repository<select name="project-repository" required value={repository} onChange={(e) => setRepository(e.target.value)}>
          <option value="" disabled>Select a channel repository</option>
          {repositories.map((r) => <option key={r.name} value={r.name}>#{channels.find((c) => c.id === r.channel_id)?.name} / {r.name.replace(`${workspaceId}-`, '')}</option>)}
        </select></label>
      {!repositories.length && <p className="project-caption">Ask your connected agent to use <code>create_artifact_repository</code> in a channel and push an initial commit. It will then appear here.</p>}
      {create.isError && <Failure error={create.error} />}
      <div className="project-form-actions">
        <button type="button" className="button secondary" disabled={create.isPending} onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={create.isPending || !repository || !title.trim() || !goal.trim()}>
          {create.isPending ? 'Creating repository…' : 'Create project'}
        </button>
      </div>
    </form>
  </Modal>;
}
type Changes = { commit: string; base_commit: string; files: Array<{ path: string; status: string }>; truncated: boolean; path: string | null; before: string | null; after: string | null; binary: boolean };
function CandidateReview({ requirementsRevision, workspaceId, candidate, base, canReview, onClose, onSaved }: { requirementsRevision: number; workspaceId: string; candidate: Candidate; base: string; canReview: boolean; onClose: () => void; onSaved: () => void }) {
  const [path, setPath] = useState(''), [note, setNote] = useState(candidate.review_note), [tab, setTab] = useState<'changes' | 'evidence'>('changes');
  const changes = useQuery({ queryKey: ['candidate-files', workspaceId, base, candidate.id, path], placeholderData: (previous) => previous, queryFn: () => api<Changes>(`${base}/runs/${candidate.run_id}/files?commit=${candidate.commit_hash}${path ? `&path=${encodeURIComponent(path)}` : ''}`) });
  const command = useProjectCommand();
  const outdated = ['stale','integrated'].includes(candidate.status) || candidate.requirements_revision !== requirementsRevision;
  const [reviewRevision] = useState(candidate.revision);
  const reviewChanged = candidate.revision !== reviewRevision;
  const save = useMutation({ mutationFn: (status: string) => post(`${base}/candidates/${candidate.id}/review`, command({ commit: candidate.commit_hash, status, note, expected_revision: reviewRevision, requirements_revision: requirementsRevision })), onSuccess: onSaved });
  return <Modal title="Review candidate" className="project-review-modal" onClose={onClose}><div className="project-review"><div className="project-review-summary"><Status value={candidate.status} /><p>{candidate.summary}</p><div className="project-evidence"><span><CheckCircleIcon /> Repository verified</span><code>{candidate.commit_hash}</code></div><p className="project-caption">Commit exists in the contributor’s fork and descends from <code>{candidate.base_commit.slice(0, 8)}</code>.</p></div><div className="library-tabs" aria-label="Review sections"><button type="button" aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}>Source changes</button><button type="button" aria-pressed={tab === 'evidence'} onClick={() => setTab('evidence')}>Reported checks</button></div>
    {tab === 'evidence' ? <section className="project-reported">
      <h3>Author-reported evidence</h3>
      <p>These checks were supplied by the author. Await has not independently executed them.</p>
      <pre>{candidate.checks || 'No test evidence was supplied.'}</pre>
    </section> : <>
      {changes.isPending && <p role="status">Reading pinned revisions…</p>}
      {changes.isError && <Failure error={changes.error} retry={() => void changes.refetch()} />}
      {changes.data && <>
        <div className="project-changes">
          <nav className="project-file-list" aria-label="Changed files">
            {changes.data.files.map((file) => <button type="button" aria-current={path === file.path ? 'true' : undefined} key={file.path} onClick={() => setPath(file.path)}>
              <span className={`file-status file-${file.status}`}>
                {file.status === 'added' ? '+' : file.status === 'deleted' ? '−' : '~'}
              </span>
              <code>{file.path}</code>
            </button>)}
            {!changes.data.files.length && <p>No source changes from the base revision.</p>}
          </nav>
          <div className="project-source">
            {changes.isPlaceholderData ? <p role="status">Reading pinned source…</p> : !path ? <p>Select a file to compare its pinned revisions.</p> : changes.data.binary ? <p>This file is binary or exceeds the 200 KB source preview limit. Inspect it in your Git client.</p> : <div className="project-source-panes">
              <section>
                <h4>Before · {candidate.base_commit.slice(0, 8)}</h4>
                <pre>{changes.data.before ?? 'File does not exist in this revision.'}</pre>
              </section>
              <section>
                <h4>After · {candidate.commit_hash.slice(0, 8)}</h4>
                <pre>{changes.data.after ?? 'File does not exist in this revision.'}</pre>
              </section>
            </div>}
          </div>
        </div>
        {changes.data.truncated && <p className="project-caption">This change list is truncated. Inspect the full commit in a Git client before approving.</p>}
      </>}
    </>}
    {outdated && <p className="project-stale-notice">This candidate is historical. It was integrated or its inputs changed. Start a new attempt to submit a result for the current requirements.</p>}
    {reviewChanged && !save.isSuccess && <p className="project-stale-notice">This review changed while you were reading. Close and reopen it to review the current decision.</p>}
    {canReview && !outdated && <form className="project-review-actions" onSubmit={(e) => { e.preventDefault(); save.mutate('approved'); }}><label>Review note<textarea name="review-note" rows={2} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you verify? What needs attention?" /></label>{save.isError && <Failure error={save.error} />}{save.isSuccess && <p role="status">Review saved for {candidate.commit_hash.slice(0, 8)}.</p>}<div className="project-form-actions"><p>Approval records your review. It does not merge.</p><button type="button" className="button secondary" disabled={save.isPending || reviewChanged || !note.trim()} onClick={() => save.mutate('changes_requested')}>Request changes</button><button type="submit" className="button primary" disabled={save.isPending || reviewChanged}>{save.isPending ? 'Saving…' : 'Approve revision'}</button></div></form>}
  </div></Modal>;
}
