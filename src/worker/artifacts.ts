import type { Env } from './env';
import { workLinks, type SharedLink, type ArtifactContents } from '../shared/workspace-library';

export type ArtifactInside = (env: Env, workspaceId: string, accountId: string, path: string, init?: RequestInit) => Promise<Response>;
export type ArtifactGrant = { workspaceId: string; accountId: string; messageId: string; url: string; repository: string; commit: string; root: string; expiresAt: number };
const previewMimes: Record<string, string> = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2', ico: 'image/x-icon' };
const fileMime = (path: string, fallback: string) => previewMimes[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? fallback ?? 'application/octet-stream';
const maxFileBytes = 5 * 1024 * 1024;

export function artifactRepository(env: Env, workspaceId: string, url: string): SharedLink {
  const link = workLinks(url).find((item) => item.url === url && item.preview === 'repository');
  if (!link || link.account !== env.ARTIFACT_ACCOUNT_ID || link.namespace !== env.ARTIFACT_NAMESPACE || !link.repository?.startsWith(`${workspaceId}-`)) throw new Error('This repository is not connected to this workspace.');
  return link;
}

// The repository's record in the workspace: its channel, and for project repositories a title.
type ArtifactSource = { channel_id: string; managed: boolean; title: string | null };

export async function authorizeArtifact(env: Env, inside: ArtifactInside, workspaceId: string, accountId: string, messageId: string, url: string): Promise<{ link: SharedLink; source: ArtifactSource }> {
  const response = await inside(env, workspaceId, accountId, `/messages/${encodeURIComponent(messageId)}`);
  if (!response.ok) throw new Error('This artifact is no longer shared with you.');
  const message = await response.json<{ body: string }>();
  if (!workLinks(message.body).some((link) => link.url === url)) throw new Error('This artifact is no longer shared with you.');
  const link = artifactRepository(env, workspaceId, url);
  const source = await inside(env, workspaceId, accountId, `/artifact-repositories/${encodeURIComponent(link.repository!)}`);
  if (!source.ok) throw new Error('This repository is not shared with your channels.');
  return { link, source: await source.json<ArtifactSource>() };
}

export function artifactPath(path: string): string {
  if (!path || path.length > 1000 || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(path)) throw new Error('Choose a repository file.');
  return path;
}

export async function artifactContents(env: Env, inside: ArtifactInside, workspaceId: string, accountId: string, messageId: string, url: string, ref?: string, selectedPath?: string): Promise<ArtifactContents> {
  const { link, source } = await authorizeArtifact(env, inside, workspaceId, accountId, messageId, url);
  if (!env.ARTIFACTS) throw new Error('Cloudflare Artifacts is unavailable.');
  const repo = await env.ARTIFACTS.get(link.repository!);
  try {
    const info = await repo.info();
    const branch = ref?.trim() || info.defaultBranch;
    if (branch.length > 256 || /[\x00-\x1f]/.test(branch)) throw new Error('Choose a branch or commit.');
    const [commit] = await repo.log({ ref: branch, limit: 1 });
    const files: ArtifactContents['files'] = [];
    let trees = 0, truncated = false;
    async function walk(hash: string, prefix: string, depth: number): Promise<void> {
      if (++trees > 40 || depth > 8 || files.length >= 200) { truncated = true; return; }
      for (const entry of await repo.readTree(hash) ?? []) {
        if (files.length >= 200) { truncated = true; break; }
        const path = `${prefix}${entry.name}`;
        if (entry.type === 'tree') await walk(entry.hash, `${path}/`, depth + 1);
        else if (entry.type === 'blob' || entry.type === 'exec') files.push({ path, type: entry.type });
      }
    }
    if (commit) await walk(commit.treeHash, '', 0);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const path = selectedPath ? artifactPath(selectedPath) : ['index.html', 'dist/index.html', 'public/index.html', 'README.md'].find((candidate) => files.some((file) => file.path === candidate)) ?? files[0]?.path ?? null;
    let contentTruncated = false;
    let mime: string | null = null, content: string | null = null, previewUrl: string | null = null;
    if (path && commit) {
      const file = await repo.readFile({ ref: commit.hash, path });
      if (!file) throw new Error('This file was not found in that revision.');
      if (file.size > maxFileBytes) throw new Error('This file is too large to preview. Open a file smaller than 5 MB.');
      mime = fileMime(path, file.type || 'application/octet-stream');
      if (/\.(?:html?|svg|png|jpe?g|gif|webp|pdf)$/i.test(path)) {
        const ticket = crypto.randomUUID();
        const grant: ArtifactGrant = { workspaceId, accountId, messageId, url, repository: link.repository!, commit: commit.hash, root: /^(?:dist|public)\//.test(path) ? `${path.split('/')[0]}/` : '', expiresAt: Date.now() + 30 * 60_000 };
        await env.OAUTH_KV.put(`artifact-preview:${ticket}`, JSON.stringify(grant), { expirationTtl: 1800 });
        previewUrl = `/api/artifact-previews/${ticket}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
      }
      // HTML needs both a browser preview and bounded source for MCP reviewers.
      if (/^(text\/|application\/(json|javascript|xml))/.test(mime) || /\.(?:md|tsx?|jsx?|css|json|txt|yaml|yml|toml|py|rs|go|sh)$/i.test(path)) { const text = await file.text(); content = text.slice(0, 200_000); contentTruncated = text.length > 200_000; }
    }
    const name = info.name.replace(`${workspaceId}-`, '');
    return { name, title: source.title ?? name, description: info.description, branch, commit: commit?.hash ?? null, files, truncated, path, mime, content, contentTruncated, previewUrl };
  } finally { repo[Symbol.dispose](); }
}

export async function artifactFile(env: Env, inside: ArtifactInside, ticket: string, path: string): Promise<Response> {
  const denied = () => new Response('This preview expired or access was removed. Reopen the artifact to refresh it.', { status: 404 });
  if (!/^[a-f0-9-]{36}$/.test(ticket)) return denied();
  const saved = await env.OAUTH_KV.get(`artifact-preview:${ticket}`);
  if (!saved || !env.ARTIFACTS) return denied();
  const grant = JSON.parse(saved) as ArtifactGrant;
  if (grant.expiresAt < Date.now()) return denied();
  try { await authorizeArtifact(env, inside, grant.workspaceId, grant.accountId, grant.messageId, grant.url); artifactPath(path); } catch { return denied(); }
  const repo = await env.ARTIFACTS.get(grant.repository);
  try {
    const file = await repo.readFile({ ref: grant.commit, path });
    if (!file || file.size > maxFileBytes) return new Response('File not found or too large to preview.', { status: 404 });
    const headers = new Headers({ 'Content-Type': fileMime(path, file.type || 'application/octet-stream'), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    // Sandboxing applies even if an artifact file is opened directly in a tab.
    headers.set('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src https:; media-src 'self' blob: https:; frame-src https:; form-action 'none'; frame-ancestors 'self'; base-uri 'self'");
    if (/\.html?$/i.test(path)) {
      headers.set('Content-Type', 'text/html; charset=utf-8');
      const fileBase = `/api/artifact-previews/${ticket}/files/`;
      const base = `${fileBase}${grant.root ?? ''}`;
      const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1).split('/').map(encodeURIComponent).join('/') : '';
      // URL-like module specifiers are normalized before prefix matching. Keep
      // already ticket-scoped relative imports from being remapped by '/'.
      const imports = { '/': base, [fileBase]: fileBase };
      return new HTMLRewriter().on('head', { element(element) { element.prepend(`<base href="${fileBase}${directory}"><script type="importmap">${JSON.stringify({ imports })}</script>`, { html: true }); } }).on('[src], [href]', { element(element) {
        for (const name of ['src', 'href']) { const value = element.getAttribute(name); if (value?.startsWith('/') && !value.startsWith('//')) element.setAttribute(name, `${base}${value.slice(1)}`); }
      } }).transform(new Response(file, { headers }));
    }
    if (/\.css$/i.test(path)) {
      const base = `/api/artifact-previews/${ticket}/files/${grant.root ?? ''}`;
      const css = (await file.text()).replace(/(url\(\s*["']?|@import\s+["'])\/(?!\/)/g, `$1${base}`);
      return new Response(css, { headers });
    }
    return new Response(file, { headers });
  } finally { repo[Symbol.dispose](); }
}

export async function createArtifactRepository(env: Env, inside: ArtifactInside, workspaceId: string, accountId: string, channelId: string, name: string, description: string): Promise<unknown> {
  const checked = await inside(env, workspaceId, accountId, `/channels/${encodeURIComponent(channelId)}/artifact-access`, { method: 'POST' });
  if (!checked.ok) throw new Error((await checked.json<{ error: string }>()).error);
  if (!env.ARTIFACTS) throw new Error('Cloudflare Artifacts is unavailable.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('Use a repository name with 1 to 64 letters, numbers, dots, underscores, or hyphens.');
  const created = await env.ARTIFACTS.create(`${workspaceId}-${name}`, { description: description.slice(0, 500), setDefaultBranch: 'main' });
  const repo = await env.ARTIFACTS.get(created.name);
  try {
    const token = await repo.createToken('write', 900);
    await repo.revokeToken(created.token);
    const registered = await inside(env, workspaceId, accountId, '/artifact-repositories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: created.name, channel_id: channelId }) });
    if (!registered.ok) throw new Error('Could not connect this repository to its channel.');
    return { name, remote: created.remote, branch: created.defaultBranch, token: token.plaintext, expires_at: token.expiresAt, instructions: 'Keep this token private. Push files with Git using the Authorization bearer header, then post the credential-free remote URL in the channel or thread. HTML, images, PDFs, and source files can be previewed there and found under Git.' };
  } catch (cause) {
    await env.ARTIFACTS.delete(created.name).catch(() => {});
    throw cause;
  } finally { repo[Symbol.dispose](); }
}

export async function artifactWriteToken(env: Env, inside: ArtifactInside, workspaceId: string, accountId: string, messageId: string, url: string): Promise<unknown> {
  const { link, source: { channel_id: channelId, managed } } = await authorizeArtifact(env, inside, workspaceId, accountId, messageId, url);
  if (managed) throw new Error('Project repositories use owner-scoped run credentials. Request a project workspace token instead.');
  const checked = await inside(env, workspaceId, accountId, `/channels/${encodeURIComponent(channelId)}/artifact-access`, { method: 'POST' });
  if (!checked.ok) throw new Error((await checked.json<{ error: string }>()).error);
  if (!env.ARTIFACTS) throw new Error('Cloudflare Artifacts is unavailable.');
  const repo = await env.ARTIFACTS.get(link.repository!);
  try {
    const token = await repo.createToken('write', 900);
    return { remote: url, token: token.plaintext, expires_at: token.expiresAt, instructions: 'Keep this token private. Use it only as the Git Authorization bearer header.' };
  } finally { repo[Symbol.dispose](); }
}
