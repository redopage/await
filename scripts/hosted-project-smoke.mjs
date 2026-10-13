// Integration fixture, not a claim of autonomous model execution.
// Uses real Artifacts forks and Git pushes through two separate Await identities.
import assert from 'node:assert/strict';
import { runProjectAgent, projectToolCalls } from './await-project-agent.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const origin = process.env.AWAIT_TEST_ORIGIN || 'http://127.0.0.1:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Run this fixture against a local dev server.');
const keep = process.env.AWAIT_KEEP_PROJECT_FIXTURE === '1';
const autonomous = process.env.AWAIT_REAL_AGENTS === '1';
const stopBeforePublication = process.env.AWAIT_STOP_BEFORE_PUBLICATION === '1';
const dogfood = process.env.AWAIT_DOGFOOD === '1';
if (stopBeforePublication && !keep) throw new Error('Human review mode needs AWAIT_KEEP_PROJECT_FIXTURE=1 so the checked result remains available.');
if (dogfood && !autonomous) throw new Error('Dogfood mode needs AWAIT_REAL_AGENTS=1; model-authored work is required.');
const providers = (process.env.AWAIT_AGENT_PROVIDERS || 'codex,codex').split(',');
if (providers.length !== 2 || providers.some(provider => !['codex','claude'].includes(provider))) throw new Error('Choose two providers: codex,codex or codex,claude.');
const dir = await mkdtemp(join(tmpdir(), 'await-project-smoke-')), cleanup = new Set();
// Real-agent runs record evidence in the ignored private/ folder. Set AWAIT_EVIDENCE_PATH to
// refresh a committed record, such as docs/multimodel-project-agents-live-test.json.
const evidencePath = process.env.AWAIT_EVIDENCE_PATH || join('private', 'evidence', providers.includes('claude') ? 'multimodel-project-agents-live-test.json' : 'connected-project-agents-live-test.json');
const output = process.env.AWAIT_FIXTURE_PATH || '/tmp/await-hosted-smoke.json';
let cookie, completed = false, fixtureProjectPath;
async function saveFixture(url, workspace, channel, project, agents, repositories) {
  await writeFile(output, JSON.stringify({ url, reviewerEmail:(await api('/me')).account.email, workspaceId:workspace.id, channelId:channel.id, projectId:project.id, cookie, ...(stopBeforePublication ? {agents} : {}), repositories }), {mode:0o600});
}
async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!cookie && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json(); assert.ok(response.ok, data.error || `HTTP ${response.status}`); return data;
}
async function rpc(token, name, args) {
  const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const data = await response.json();
  assert.ok(!data.error && !data.result?.isError, data.error?.message || data.result?.content?.[0]?.text || 'MCP request failed.');
  return data.result.structuredContent?.result ?? JSON.parse(data.result.content[0].text);
}
function git(cwd, args, token) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', (data) => { stdout += data; }); child.stderr.resume();
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Git ${args[0]} failed (${code}). Credentials omitted.`)));
  });
}
try {
  await api('/dev/login', { name: 'Project reviewer', email: `projects-${Date.now()}@localhost` });
  const workspace = await api('/workspaces', { name: 'Await collaboration lab' });
  const snapshot = await api(`/workspaces/${workspace.id}/snapshot`), channel = snapshot.channels.find((c) => c.name === 'general');
  const agents = [];
  for (const name of ['API teammate', 'Interface teammate']) {
    const agent = await api(`/workspaces/${workspace.id}/agents`, { name });
    await api(`/workspaces/${workspace.id}/channels/${channel.id}/members`, { agent_id: agent.agent_id });
    await api(`/workspaces/${workspace.id}/agents/${agent.agent_id}/listening/${channel.id}`, { level: 'activity', include_agent_authors: true }, 'PUT');
    agents.push({...agent,name});
  }
  const seedName = `collaboration-${Date.now()}`;
  const seed = await rpc(agents[0].token, 'create_artifact_repository', { name: seedName, channel_id: channel.id, description: 'Temporary real Git integration fixture' });
  cleanup.add(`${workspace.id}-${seedName}`);
  const seedDir = join(dir, 'seed'); await mkdir(seedDir);
  await git(seedDir, ['init', '-b', 'main']); await git(seedDir, ['config', 'user.name', 'Await test fixture']); await git(seedDir, ['config', 'user.email', 'fixture@example.com']);
  if (dogfood) {
    // Archive committed source only: credentials, local state and generated output stay out.
    const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 });
    assert.equal(archive.status, 0, 'Could not archive the committed Await revision.');
    const extracted = spawnSync('tar', ['-xf', '-', '-C', seedDir], { input: archive.stdout });
    assert.equal(extracted.status, 0, 'Could not extract the committed Await source.');
  } else {
    await writeFile(join(seedDir, 'README.md'), '# Password reset\n\nA two-contributor integration fixture.\n');
    await writeFile(join(seedDir, 'package.json'), JSON.stringify({type:'module'}));
    await writeFile(join(seedDir, 'reset.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';
import {resetToken} from './src/reset-api.ts';\nimport {resetState} from './src/reset-form.ts';\ntest('API and form agree on expiry',()=>{const t=resetToken(0);assert.equal(t.expiresAt,new Date(900000).toISOString());assert.equal(resetState(t.expiresAt,899999),'Choose a new password');assert.equal(resetState(t.expiresAt,900000),'Request a new reset link');});\ntest('Invalid timestamp recovers',()=>assert.equal(resetState('invalid',0),'Request a new reset link'));\n`);
  }
  await git(seedDir, ['add', '.']); await git(seedDir, ['commit', '-m', 'Initialize shared project']); await git(seedDir, ['push', seed.remote, 'main'], seed.token);
  const base = `/workspaces/${workspace.id}/collab/projects`;
  const project = await api(base, { client_id: crypto.randomUUID(), channel_id: channel.id, repository: `${workspace.id}-${seedName}`, ...(dogfood ? {
    title: 'Await improves its own contributor guide',
    goal: 'Use the actual committed Await source to improve two contributor guides. Read the implementation, agree on terminology, and preserve all runtime source, tests and configuration.',
    acceptance_criteria: 'Only docs/projects.md and docs/architecture.md may change. Instructions must match the actual tools and permissions. Model and human responsibilities must be explicit. Existing tests and the production build must pass unchanged.',
    check_command: 'npm ci && npm ci --prefix webhook-gateway && npm test && npm run build && git diff --check',
  } : { title: 'Password reset, built together', goal: 'Build a reset API and a matching interface. Agree on token expiry before implementation, preserve context across a sleeping session, and review exact Git commits.', acceptance_criteria: 'The API returns an ISO timestamp exactly 15 minutes ahead. The form accepts links before expiry and offers recovery at expiry or for invalid timestamps. The combined commit passes both tests.', check_command: 'node --test reset.test.mjs' }) });
  fixtureProjectPath = `${base}/${project.id}`;
  cleanup.add(project.repository);
  if (keep) {
    const url = `${origin}/w/${workspace.id}/${channel.id}?view=projects&project=${project.id}`;
    await saveFixture(url, workspace, channel, project, agents, [...cleanup]);
    console.log(`Project in progress: ${url}`);
  }
  const tasks = autonomous ? await Promise.all(agents.map((agent,index)=>api(`/workspaces/${workspace.id}/collab/boards/${project.board_id}/tasks`,{title:dogfood ? (index?'Repository architecture guide':'First project walkthrough') : (index?'Reset form and recovery':'Reset API and expiry'),assignee_id:agent.agent_id,description:dogfood ? `Improve docs/${index?'architecture':'projects'}.md from the actual implementation.` : (index?'Use the agreed expiry contract and recover from invalid or expired links.':'Return an ISO timestamp exactly 15 minutes after issue.')}))) : [];
  console.log('✓ Real canonical fork created with its initial token revoked');
  let runs, candidates;
  if (autonomous) {
    console.log(`Running authenticated ${providers.join(' and ')} agents. They choose their own commands and implementation.`);
    const reportResults = await Promise.allSettled(agents.map((agent, index) => runProjectAgent({ provider: providers[index], origin, token: agent.token, projectId: project.id, taskId: tasks[index].id,
      assignment: dogfood ? (index ? 'Improve docs/architecture.md only: explain repository inspection through the Artifacts binding, what still needs a checkout, and current workspace and integration scaling boundaries. Read the actual implementation first. Agree on terminology with the guide teammate. Do not change source, tests, lockfiles or configuration. Submit a concise factual documentation change.' : 'Improve docs/projects.md only: add a concise first-project walkthrough from an assigned card through hosted work, an exact candidate, combined checks and human publication. Read the actual tool contract first and agree on terminology with the architecture teammate. Clearly distinguish fixture approval from a person reviewing the product. Do not change source, tests, lockfiles or configuration.') : (index ? 'Build src/reset-form.ts exporting resetState(expiresAt, now). Coordinate with the API teammate on the expiry contract, handle invalid timestamps, and submit your implementation.' : 'Build src/reset-api.ts exporting resetToken(now). Coordinate with the interface teammate on the expiry contract and submit your implementation.'),
      onProgress: event => { if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') console.log(`Agent ${index + 1}: ${event.item.tool} ${event.item.status}`); }
    })));
    const failures = reportResults.filter(result => result.status === 'rejected');
    if (failures.length) throw failures[0].reason;
    const reports = reportResults.map(result => result.value);
    await writeFile('/tmp/await-project-agent-reports.json', JSON.stringify(reports.map(({provider,report,events}) => ({provider,report,tool_calls:projectToolCalls(events)}))), {mode:0o600});
    const detail = await api(`${base}/${project.id}`);
    runs = agents.map(agent => detail.runs.find(run => run.actor_id === agent.agent_id
      && !['cancelled','failed'].includes(run.status)
      && detail.candidates.some(candidate => candidate.run_id === run.id && ['pending','approved'].includes(candidate.status))));
    assert.ok(runs.every(Boolean), 'Each real agent must submit a verified candidate from its own run.');
    runs.forEach(run => cleanup.add(run.repository));
    candidates = runs.map(run => detail.candidates.find(candidate => candidate.run_id === run.id));
    assert.ok(candidates.every(Boolean), 'Each real agent must submit a verified commit.');
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ executed_at: new Date().toISOString(), origin, project_id: project.id, agents: agents.map((a,index) => ({ id: a.agent_id, name: a.name, provider:providers[index] })), outcome:'submitted_pending_checks', execution:`Authenticated ${providers.join(' and ')} CLI models, project-scoped MCP tools, Cloudflare hosted workspaces`, approval:stopBeforePublication ? 'No approval granted; waiting for a person to inspect the checked result in the UI' : 'Test harness acting as the local human fixture reviewer', scenario:dogfood?'await_contributor_guides':'reset_contract', source_commit:dogfood ? spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim() : null, acceptance_tests_unchanged:true, reports:reports.map(({provider,report,events})=>({provider,report,tool_calls:projectToolCalls(events)})) }, null, 2));
    console.log('✓ Two real connected agents independently submitted pushed commits');
  } else {
  runs = await Promise.all(agents.map((agent, index) => rpc(agent.token, 'start_project_run', { project_id: project.id, client_id: crypto.randomUUID(), title: index ? 'Reset form and recovery experience' : 'Reset token contract and API', paths: index ? ['src/reset-form.ts', 'src/contracts'] : ['src/reset-api.ts', 'src/contracts/reset.ts'] })));
  runs.forEach((run) => cleanup.add(run.repository));
  const initial = await rpc(agents[0].token, 'read_project', { project_id: project.id });
  assert.ok(initial.events.some((event) => event.type === 'scope.overlap'));
  console.log('✓ Two independent forks created concurrently; intersecting scope detected');
  await rpc(agents[1].token, 'checkpoint_project_run', { project_id: project.id, run_id: runs[1].id, client_id: crypto.randomUUID(), expected_revision: 1, status: 'sleeping', checkpoint: 'Waiting for the API expiry contract before building the form.', cursor: initial.next_cursor });
  await rpc(agents[0].token, 'post_project_event', { project_id: project.id, client_id: crypto.randomUUID(), body: 'Contract proposal: reset tokens expire after 15 minutes. The API returns expiresAt as an ISO timestamp. The form should show an expired-link recovery action.' });
  const resumed = await rpc(agents[1].token, 'read_project', { project_id: project.id, after: initial.next_cursor });
  assert.ok(resumed.events.some((event) => event.type === 'coordination.note'));
  await rpc(agents[1].token, 'checkpoint_project_run', { project_id: project.id, run_id: runs[1].id, client_id: crypto.randomUUID(), expected_revision: 2, status: 'working', checkpoint: 'Recovered the proposed contract. Building the expired-link recovery action.', cursor: resumed.next_cursor, paths: ['src/reset-form.ts'] });
  console.log('✓ Sleeping workspace recovered its checkpoint and unread contract events');
  candidates = await Promise.all(agents.map(async (agent, index) => {
    const run = runs[index];
    const code = index ? 'export function resetState(expiresAt: string, now = Date.now()) {\n  const expiry = Date.parse(expiresAt);\n  return !Number.isFinite(expiry) || now >= expiry ? "Request a new reset link" : "Choose a new password";\n}\n' : 'export function resetToken(now = Date.now()) {\n  return { expiresAt: new Date(now + 15 * 60_000).toISOString() };\n}\n';
    const commandId = crypto.randomUUID();
    await rpc(agent.token, 'execute_project_command', { project_id: project.id, run_id: run.id, client_id: commandId, command: `mkdir -p src\ncat > src/${index ? 'reset-form.ts' : 'reset-api.ts'} <<'AWAIT_SOURCE'\n${code}AWAIT_SOURCE\nnode --version` });
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve,3000));
      job = (await rpc(agent.token, 'read_project', {project_id:project.id})).jobs.find(j=>j.id===commandId);
      if (!['queued','running'].includes(job.status)) break;
    }
    assert.equal(job.status,'complete',JSON.stringify(job));
    const commit = job.result.commit;
    console.log(`✓ Hosted teammate ${index+1} saved ${commit.slice(0,8)}`);
    return rpc(agent.token, 'publish_candidate', { requirements_revision: project.revision, project_id: project.id, run_id: run.id, commit, summary: index ? 'The reset form uses the agreed expiresAt contract and offers a new link after expiry.' : 'The API returns an ISO expiry timestamp fifteen minutes after issue.', checks: 'Integration fixture: Git push and source retrieval checked. This fixture does not execute a model or application tests.' });
  }));
  }
  for (let index = 0; index < candidates.length; index++) {
    const files = await api(`${base}/${project.id}/runs/${runs[index].id}/files?commit=${candidates[index].commit_hash}`);
    assert.ok(files.files.length > 0); assert.equal(files.truncated, false, 'Review must account for every changed path.'); assert.ok(!files.files.some(file=>file.path==='reset.test.mjs'), 'Acceptance tests must remain unchanged.');
    if (dogfood) assert.deepEqual(files.files.map(file=>file.path), [`docs/${index?'architecture':'projects'}.md`], 'Dogfood work must stay within the assigned documentation path.');
    if (!autonomous) { assert.equal(files.files.length, 1); assert.equal(files.files[0].status, 'added'); }
  }
  if (!stopBeforePublication) {
    const review = await api(`${base}/${project.id}/candidates/${candidates[0].id}/review`, { client_id: crypto.randomUUID(), expected_revision: candidates[0].revision, requirements_revision: project.revision, commit: candidates[0].commit_hash, status: 'approved', note: 'Fixture review: source revision is pinned and the expiry contract matches the proposal.' });
    assert.equal(review.status, 'approved');
    console.log('✓ Two real pushed commits verified; test-fixture review persisted');
  }
  const final = await api(`${base}/${project.id}`);
  assert.equal(final.candidates.length, 2); assert.equal(final.project.base_commit, project.base_commit);
  let integration = final.integrations.find(i=>['preparing','checking','ready'].includes(i.status)&&i.candidate_ids.length===candidates.length&&candidates.every(c=>i.candidate_ids.includes(c.id))) ?? await rpc(agents[0].token,'prepare_project_integration',{project_id:project.id,client_id:crypto.randomUUID(),candidate_ids:candidates.map(c=>c.id)});
  cleanup.add(integration.repository);
  for (let attempt=0;attempt<160;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,3000));
    integration=(await api(`${base}/${project.id}`)).integrations.find(i=>i.id===integration.id);
    if (!['preparing','checking'].includes(integration.status)) break;
  }
  assert.equal(integration.status,'ready',JSON.stringify(integration));
  assert.equal(integration.result.exit_code,0);
  const prepared=integration.commit_hash;
  console.log(`✓ Combined commit ${prepared.slice(0,8)} passed fresh hosted checks`);
  if (stopBeforePublication) {
    const pending = await api(`${base}/${project.id}`);
    assert.equal(pending.project.base_commit, project.base_commit, 'Human review mode must not advance the canonical branch.');
    assert.ok(pending.tasks.every(task=>task.status!=='done'), 'Checked work must not be marked Done before publication.');
    assert.ok(pending.candidates.every(candidate=>candidate.reviewed_by===null), 'Human review mode must not manufacture a reviewer.');
    if (autonomous) {
      const {readFile}=await import('node:fs/promises');
      const evidence=JSON.parse(await readFile(evidencePath,'utf8'));
      await writeFile(evidencePath,JSON.stringify({...evidence,outcome:'ready_for_human_review',integration,base_commit:pending.project.base_commit,tasks:pending.tasks,execution_receipts:pending.jobs.map(job=>({id:job.id,run_id:job.run_id,status:job.status,started_at:job.result?.started_at,finished_at:job.result?.finished_at,exit_code:job.result?.exit_code,commit:job.result?.commit}))},null,2));
    }
    console.log('✓ Checked result retained for human review; canonical branch and approval remain unchanged');
  } else {
    await api(`${base}/${project.id}/integrations/${integration.id}/publish`,{commit:prepared,base_commit:integration.base_commit,requirements_revision:integration.requirements_revision});
    let finished;
    for(let attempt=0;attempt<100;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,3000));
      finished=await api(`${base}/${project.id}`);
      integration=finished.integrations.find(i=>i.id===integration.id);
      if(integration.status!=='publishing')break;
    }
    assert.equal(integration.status,'integrated',JSON.stringify(integration));
    assert.equal(finished.project.base_commit,prepared);
    if (autonomous) {
      assert.ok(finished.tasks.every(task=>task.status==='done'), 'Integrated agent tasks must complete automatically.');
      const {readFile}=await import('node:fs/promises');
      const evidence=JSON.parse(await readFile(evidencePath,'utf8'));
      await writeFile(evidencePath,JSON.stringify({...evidence,outcome:'integrated',integration,base_commit:prepared,tasks:finished.tasks},null,2));
    }
    if (autonomous) {
      const run=runs[0], branchPath=`${base}/${project.id}/runs/${run.id}/branch`;
      const branch=await api(branchPath);
      const operations=[];
      for (const operation of ['delete_branch','restore_branch']) {
        const job=await api(branchPath,{client_id:crypto.randomUUID(),operation,commit:branch.commit});
        let result;
        for(let attempt=0;attempt<100;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,3000));
          result=(await api(`${base}/${project.id}`)).jobs.find(j=>j.id===job.id);
          if(!['queued','running'].includes(result.status))break;
        }
        assert.equal(result.status,'complete',JSON.stringify(result));
        const branchLine=result.result.stdout.split('\n').find(line=>line.endsWith(`\trefs/heads/${run.branch}`));
        if(operation==='delete_branch')assert.equal(branchLine,undefined,'Working branch must actually be absent.');
        else assert.ok(branchLine?.startsWith(branch.commit),'Restored branch must point at the saved commit.');
        operations.push(result);
      }
      const {readFile}=await import('node:fs/promises');
      const evidence=JSON.parse(await readFile(evidencePath,'utf8'));
      await writeFile(evidencePath,JSON.stringify({...evidence,branch_operations:operations},null,2));
      console.log('✓ Real Git branch deleted, recovery ref retained, and exact commit restored');
    }
    const nextRun=await rpc(agents[0].token,'start_project_run',{project_id:project.id,client_id:crypto.randomUUID(),title:'Continue from integrated result',paths:[]});
    cleanup.add(nextRun.repository);
    assert.equal(nextRun.base_commit,prepared);
    console.log('✓ Exact checked commit published; next attempt forks the integrated result');
    await api(`${base}/${project.id}/runs/${nextRun.id}/cancel`,{client_id:crypto.randomUUID(),expected_revision:nextRun.revision,reason:'Verified continuation from the integrated result. Diagnostic attempt complete.'});
  }
  const url = `${origin}/w/${workspace.id}/${channel.id}?view=projects&project=${project.id}`;
  await saveFixture(url, workspace, channel, project, agents, [...cleanup]);
  completed = true;
  console.log(`✓ Fixture ready: ${url}`);
} finally {
  if (fixtureProjectPath) try {
    const detail = await api(fixtureProjectPath);
    for (const run of detail.runs ?? []) cleanup.add(run.repository);
    for (const integration of detail.integrations ?? []) cleanup.add(integration.repository);
  } catch { /* Generated repository names remain in diagnostics for operator recovery. */ }
  await rm(dir, { recursive: true, force: true });
  if (!keep || !completed) for (const name of cleanup) {
    const result = spawnSync('npx', ['wrangler', 'artifacts', 'repos', 'delete', name, '--namespace', 'workspace-artifacts', '--force'], { encoding: 'utf8' });
    if (result.status !== 0) console.error(`Temporary repository cleanup needs attention: ${name}`);
  }
}
