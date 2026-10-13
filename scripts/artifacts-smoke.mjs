import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const origin = 'http://127.0.0.1:5173';
const stamp = Date.now();
const dir = await mkdtemp(join(tmpdir(), 'artifact-smoke-'));
const output = '/tmp/await-artifact-smoke.json';
let repoName;
async function api(path, cookie, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(origin + '/api' + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return { response, data };
}
function git(args, extraEnv = {}) {
  const result = spawnSync('git', args, { cwd: dir, env: { ...process.env, ...extraEnv }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Git smoke operation failed.');
  return result.stdout.trim();
}
try {
  const logged = await api('/dev/login', null, { name: 'Artifact designer', email: `artifact-${stamp}@localhost` });
  const cookie = logged.response.headers.get('set-cookie').split(';')[0];
  const { data: workspace } = await api('/workspaces', cookie, { name: 'Artifact studio' });
  const { data: snapshot } = await api(`/workspaces/${workspace.id}/snapshot`, cookie);
  const channel = snapshot.channels.find((item) => item.name === 'general');
  const { data: agent } = await api(`/workspaces/${workspace.id}/agents`, cookie, { name: 'Artifact builder' });
  await api(`/workspaces/${workspace.id}/channels/${channel.id}/members`, cookie, { agent_id: agent.agent_id });
  async function rpc(name, args) {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const data = await response.json(); assert.ok(!data.error && !data.result?.isError, JSON.stringify(data));
    return data.result.structuredContent?.result ?? JSON.parse(data.result.content[0].text);
  }
  const created = await rpc('create_artifact_repository', { channel_id: channel.id, name: `preview-${stamp}`, description: 'Temporary integration verification' });
  assert.ok(created.remote && created.token); repoName = `${workspace.id}-preview-${stamp}`;
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Artifact smoke']); git(['config', 'user.email', 'test@example.com']);
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><title>Project preview</title><link rel="stylesheet" href="/assets/style.css"></head><body><main><small>PROJECT PREVIEW</small><h1>Ideas become shared work.</h1><p>Live HTML from a private Cloudflare Artifacts repository.</p><button id="count">Try the interaction</button><p id="status">Ready</p></main><script type="module" src="/assets/app.js"></script></body></html>');
  await writeFile(join(dir, 'assets/style.css'), 'body{margin:0;background:#f2efe7;color:#243e31;font:16px system-ui}main{padding:40px;max-width:700px}h1{font-size:36px;letter-spacing:-1px}small{letter-spacing:2px;font-size:11px}button{border:0;border-radius:6px;background:#27513e;color:white;padding:12px 18px;cursor:pointer}p{line-height:1.5}');
  await writeFile(join(dir, 'assets/app.js'), 'document.getElementById("count").onclick=()=>document.getElementById("status").textContent="Interaction works inside the preview";');
  await writeFile(join(dir, 'README.md'), '# Preview project\n\nA versioned artifact shared with the team.');
  git(['add', '.']); git(['commit', '-m', 'Add preview fixture']);
  const hash = git(['rev-parse', 'HEAD']);
  git(['push', created.remote, 'main'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${created.token}` });
  console.log('✓ Native Artifacts repository created and Git push accepted');
  const { data: message } = await api(`/workspaces/${workspace.id}/channels/${channel.id}/messages`, cookie, { body: `A project for the team to review.\n\n${created.remote}` });
  const { data: reply } = await api(`/workspaces/${workspace.id}/channels/${channel.id}/messages`, cookie, { body: `The same artifact is available here in the thread.\n\n${created.remote}`, thread_id: message.id });
  const query = new URLSearchParams({ message_id: message.id, url: created.remote });
  const { data: preview } = await api(`/workspaces/${workspace.id}/artifacts?${query}`, cookie);
  assert.equal(preview.commit, hash); assert.equal(preview.path, 'index.html'); assert.ok(preview.files.some((file) => file.path === 'README.md'));
  const page = await fetch(origin + preview.previewUrl); assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /<base href=/); assert.match(html, /artifact-previews\/.+\/files\/assets\/app.js/);
  assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const js = await fetch(origin + preview.previewUrl.replace('index.html', 'assets/app.js')); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  console.log('✓ Pinned HTML preview, styles, module scripts, sandbox and file tree verified');
  query.set('path', 'README.md'); const { data: source } = await api(`/workspaces/${workspace.id}/artifacts?${query}`, cookie); assert.match(source.content, /Preview project/);
  const { data: overview } = await api(`/workspaces/${workspace.id}/collab/overview`, cookie); assert.ok(overview.links.some((link) => link.preview === 'repository' && link.url === created.remote));
  console.log('✓ Source previews and Git discovery verified');
  const renewed = await rpc('get_artifact_write_token', { message_id: message.id, url: created.remote });
  assert.ok(renewed.token && renewed.expires_at);
  console.log('✓ Scoped Git credentials can be renewed for later updates');
  if (process.env.ARTIFACT_KEEP_FIXTURE === '1') {
    const { data: invite } = await api(`/workspaces/${workspace.id}/invites`, cookie, {});
    const tester = await api('/dev/login', null, { name: 'Reviewer', email: process.env.AWAIT_REVIEW_EMAIL ?? 'reviewer@localhost' });
    await api('/invites/accept', tester.response.headers.get('set-cookie').split(';')[0], { token: new URL(invite.url).pathname.split('/').pop() });
  }
  await writeFile(output, JSON.stringify({ workspaceId: workspace.id, channelId: channel.id, messageId: message.id, replyId: reply.id, remote: created.remote, repoName, cookie }), { mode: 0o600 });
  console.log(`Browser fixture ready: /w/${workspace.id}/${channel.id}?thread=${message.id}`);
  if (process.env.ARTIFACT_KEEP_FIXTURE !== '1') {
    await api(`/workspaces/${workspace.id}/messages/${message.id}/delete`, cookie, {}, 'POST');
    assert.equal((await fetch(origin + preview.previewUrl)).status, 404);
    console.log('✓ Deleted messages revoke previously issued preview links');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
  if (repoName && process.env.ARTIFACT_KEEP_FIXTURE !== '1') {
    const deleted = spawnSync('npx', ['wrangler', 'artifacts', 'repos', 'delete', repoName, '--namespace', 'workspace-artifacts', '--force'], { encoding: 'utf8' });
    if (deleted.status !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const retry = spawnSync('npx', ['wrangler', 'artifacts', 'repos', 'delete', repoName, '--namespace', 'workspace-artifacts', '--force'], { encoding: 'utf8' });
      if (retry.status !== 0) throw new Error('Temporary artifact repository cleanup failed.');
    }
  }
}
