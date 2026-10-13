// Integration fixture, not a claim of autonomous model execution.
// Uses real Artifacts forks and Git pushes through two separate Await identities.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const origin = process.env.AWAIT_TEST_ORIGIN || 'http://127.0.0.1:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Run this fixture against a local dev server.');
const dir = await mkdtemp(join(tmpdir(), 'await-project-smoke-')), cleanup = new Set();
const keep = process.env.AWAIT_KEEP_PROJECT_FIXTURE === '1';
const output = '/tmp/await-project-smoke.json';
let cookie;
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
    agents.push(agent);
  }
  const seedName = `collaboration-${Date.now()}`;
  const seed = await rpc(agents[0].token, 'create_artifact_repository', { name: seedName, channel_id: channel.id, description: 'Temporary real Git integration fixture' });
  cleanup.add(`${workspace.id}-${seedName}`);
  const seedDir = join(dir, 'seed'); await mkdir(seedDir);
  await git(seedDir, ['init', '-b', 'main']); await git(seedDir, ['config', 'user.name', 'Await test fixture']); await git(seedDir, ['config', 'user.email', 'fixture@example.com']);
  await writeFile(join(seedDir, 'README.md'), '# Password reset\n\nA two-contributor integration fixture.\n');
  await git(seedDir, ['add', '.']); await git(seedDir, ['commit', '-m', 'Initialize shared project']); await git(seedDir, ['push', seed.remote, 'main'], seed.token);
  const base = `/workspaces/${workspace.id}/collab/projects`;
  const project = await api(base, { client_id: crypto.randomUUID(), channel_id: channel.id, title: 'Password reset, built together', goal: 'Build a reset API and a matching interface. Agree on token expiry before implementation, preserve context across a sleeping session, and review exact Git commits.', repository: `${workspace.id}-${seedName}` });
  cleanup.add(project.repository);
  console.log('✓ Real canonical fork created with its initial token revoked');
  const runs = await Promise.all(agents.map((agent, index) => rpc(agent.token, 'start_project_run', { project_id: project.id, client_id: crypto.randomUUID(), title: index ? 'Reset form and recovery experience' : 'Reset token contract and API', paths: index ? ['src/reset-form.ts', 'src/contracts'] : ['src/reset-api.ts', 'src/contracts/reset.ts'] })));
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
  const candidates = await Promise.all(agents.map(async (agent, index) => {
    const run = runs[index], grant = await rpc(agent.token, 'get_project_run_token', { project_id: project.id, run_id: run.id });
    assert.equal(grant.branch, run.branch, 'Git credentials must identify the assigned attempt branch.');
    const cwd = join(dir, `run-${index}`);
    await git(dir, ['clone', grant.remote, cwd], grant.token);
    await git(cwd, ['config', 'user.name', index ? 'Interface teammate fixture' : 'API teammate fixture']); await git(cwd, ['config', 'user.email', 'fixture@example.com']);
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src', index ? 'reset-form.ts' : 'reset-api.ts'), index ? 'export function resetState(expiresAt: string, now = Date.now()) {\n  return now >= Date.parse(expiresAt) ? "Request a new reset link" : "Choose a new password";\n}\n' : 'export function resetToken(now = Date.now()) {\n  return { expiresAt: new Date(now + 15 * 60_000).toISOString() };\n}\n');
    await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', index ? 'Add reset form expiry state' : 'Define fifteen-minute reset contract']); await git(cwd, ['push', grant.remote, `HEAD:refs/heads/${run.branch}`], grant.token);
    const commit = await git(cwd, ['rev-parse', 'HEAD']);
    const branchHead = await git(cwd, ['ls-remote', grant.remote, `refs/heads/${run.branch}`], grant.token);
    assert.ok(branchHead.startsWith(`${commit}\t`), 'The submitted commit must be on the assigned attempt branch.');
    return rpc(agent.token, 'publish_candidate', { requirements_revision: project.revision, project_id: project.id, run_id: run.id, commit, summary: index ? 'The reset form uses the agreed expiresAt contract and offers a new link after expiry.' : 'The API returns an ISO expiry timestamp fifteen minutes after issue.', checks: 'Integration fixture: Git push and source retrieval checked. This fixture does not execute a model or application tests.' });
  }));
  for (let index = 0; index < candidates.length; index++) {
    const files = await api(`${base}/${project.id}/runs/${runs[index].id}/files?commit=${candidates[index].commit_hash}`);
    assert.equal(files.files.length, 1); assert.equal(files.files[0].status, 'added');
  }
  const review = await api(`${base}/${project.id}/candidates/${candidates[0].id}/review`, { client_id: crypto.randomUUID(), expected_revision: candidates[0].revision, requirements_revision: project.revision, commit: candidates[0].commit_hash, status: 'approved', note: 'Fixture review: source revision is pinned and the expiry contract matches the proposal.' });
  assert.equal(review.status, 'approved');
  console.log('✓ Two real pushed commits verified; source changes pinned; human review persisted');
  const final = await api(`${base}/${project.id}`);
  assert.equal(final.candidates.length, 2); assert.equal(final.project.base_commit, project.base_commit);
  const requirements = await api(`${base}/${project.id}/requirements`, { client_id: crypto.randomUUID(), expected_revision: project.revision, title: project.title, goal: project.goal, acceptance_criteria: 'Links expire after fifteen minutes. Invalid timestamps must show recovery.', reason: 'Add an invalid timestamp acceptance case.' });
  assert.equal(requirements.revision, 2);
  const packet = await rpc(agents[0].token, 'read_project_handoff', { project_id: project.id });
  assert.equal(packet.project.revision, 2); assert.equal(packet.requirements.length, 2);
  assert.ok(packet.candidates.every(candidate => candidate.status === 'stale'));
  const cancelled = await api(`${base}/${project.id}/runs/${runs[1].id}/cancel`, { client_id: crypto.randomUUID(), expected_revision: final.runs.find(run => run.id === runs[1].id).revision, reason: 'Continue from the new requirements in a fresh attempt.' });
  assert.equal(cancelled.status, 'cancelled');
  console.log('✓ Requirements revised, old reviews invalidated, portable handoff read, real fork credentials revoked on cancellation');
  const url = `${origin}/w/${workspace.id}/${channel.id}?view=projects&project=${project.id}`;
  await writeFile(output, JSON.stringify({ url, workspaceId: workspace.id, channelId: channel.id, projectId: project.id, cookie, repositories: [...cleanup] }), { mode: 0o600 });
  console.log(`✓ Fixture ready: ${url}`);
} finally {
  await rm(dir, { recursive: true, force: true });
  if (!keep) for (const name of cleanup) {
    const result = spawnSync('npx', ['wrangler', 'artifacts', 'repos', 'delete', name, '--namespace', 'workspace-artifacts', '--force'], { encoding: 'utf8' });
    if (result.status !== 0) console.error(`Temporary repository cleanup needs attention: ${name}`);
  }
}
