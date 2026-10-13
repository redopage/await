import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCall, allowedTools, providerFailure, runProjectAgent } from './await-project-agent.mjs';

test('project broker denies cross-project commands and credential or approval tools', () => {
  const config = { projectId: 'assigned' };
  validateCall(config, 'execute_project_command', { project_id: 'assigned' });
  assert.throws(() => validateCall(config, 'execute_project_command', { project_id: 'other' }));
  for (const name of ['get_project_run_token', 'review_candidate', 'create_project', 'post_message']) {
    assert.equal(allowedTools.has(name), false);
    assert.throws(() => validateCall(config, name, { project_id: 'assigned' }));
  }
});

test('project broker requires the assigned Kanban card on run creation',()=>{
  const config={projectId:'assigned',taskId:'ticket'};
  assert.throws(()=>validateCall(config,'start_project_run',{project_id:'assigned'}));
  assert.throws(()=>validateCall(config,'start_project_run',{project_id:'assigned',task_id:'other'}));
  validateCall(config,'start_project_run',{project_id:'assigned',task_id:'ticket'});
});

test('provider failures are classified from private diagnostics into actionable messages', () => {
  for (const [category, diagnostics] of [
    ['authentication', 'OAuth token expired. Please log in again'],
    ['authentication', 'HTTP 401 Unauthorized'],
    ['usage', 'Rate limit exceeded; insufficient credit balance'],
    ['usage', 'HTTP 429 Too Many Requests'],
    ['connectivity', 'MCP connection failed: ECONNREFUSED'],
    ['connectivity', 'timeout'],
    ['unknown', 'Unexpected internal failure'],
    ['unknown', ''],
  ]) {
    const error = providerFailure('codex', `${diagnostics} /private/provider/config raw-transport-SECRET`, 1);
    assert.equal(error.category, category, diagnostics);
    assert.match(error.message, new RegExp(`^codex project agent failed: ${category}\\. .*then retry`), diagnostics);
    assert.equal(error.message.includes('SECRET'), false, diagnostics);
    assert.equal(error.exitCode, 1);
  }
  assert.equal('exitCode' in providerFailure('claude', 'ENOENT', null), false);
});

// One real process per transport: a failure printed to stderr, to stdout, or as a stream event.
for (const [transport, provider, body, category, exitCode] of [
  ['stderr', 'codex', `process.stderr.write('OAuth token expired. Please log in again\\n'); process.exitCode = 1;`, 'authentication', 1],
  ['stdout', 'claude', `process.stdout.write('Rate limit exceeded\\n'); process.exitCode = 1;`, 'usage', 1],
  ['event', 'codex', `console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'MCP connection failed: ECONNREFUSED' } }));`, 'connectivity', 0],
]) {
  test(`a ${provider} failure reported on ${transport} is classified and its output is not forwarded`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'await-cli-test-'));
    const executable = join(dir, 'provider');
    await writeFile(executable, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { ${body} });\n`, { mode: 0o700 });
    const progress = [];
    try {
      await assert.rejects(runProjectAgent({ provider, executable, origin: 'http://127.0.0.1:5173', token: 'secret',
        projectId: 'assigned', assignment: 'test', onProgress: (event) => progress.push(event) }), (error) => {
        assert.equal(error.category, category);
        assert.equal(error.exitCode, exitCode);
        return true;
      });
      assert.deepEqual(progress, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('project provider launch failure does not expose executable paths', async () => {
  await assert.rejects(runProjectAgent({ executable: '/private/missing-provider', provider: 'claude',
    origin: 'http://127.0.0.1:5173', token: 'secret', projectId: 'assigned', assignment: 'test' }), error => {
    assert.equal(error.category, 'unknown');
    assert.equal(error.message.includes('/private'), false);
    return true;
  });
});

test('project Claude error remains a failure after a later success result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'await-cli-test-'));
  const executable = join(dir, 'provider');
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({type: 'result', is_error: true, result: 'OAuth token expired PRIVATE'}));
  console.log(JSON.stringify({type: 'result', is_error: false, result: 'done'}));
});
`, { mode: 0o700 });
  try {
    await assert.rejects(runProjectAgent({ provider: 'claude', executable, origin: 'http://127.0.0.1:5173',
      token: 'secret', projectId: 'assigned', assignment: 'test' }), error => error.category === 'authentication');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
