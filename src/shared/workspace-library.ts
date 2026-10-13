export type SharedLink = { url: string; kind: 'git' | 'artifact'; title: string; preview?: 'site' | 'repository'; repository?: string; namespace?: string; account?: string };

export function workLinks(body: string): SharedLink[] {
  const found = new Map<string, SharedLink>();
  for (const match of body.matchAll(/https:\/\/[^\s<>"\])]+/g)) {
    try {
      const url = new URL(match[0].replace(/[.,;!?]+$/, ''));
      if (url.username || url.password || url.port) continue;
      const host = url.hostname.toLowerCase();
      const git = host === 'github.com' || host === 'gitlab.com';
      const site = host.endsWith('.pages.dev') || host.endsWith('.workers.dev');
      const repo = /^([a-f0-9]{32})\.artifacts\.cloudflare\.net$/.exec(host);
      const path = /^\/git\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\.git$/.exec(url.pathname);
      if (repo && path && !url.search && !url.hash) {
        found.set(url.href, { url: url.href, kind: 'artifact', preview: 'repository', account: repo[1], namespace: path[1], repository: path[2], title: `${path[1]}/${path[2]}` });
      } else if (git || site || host === 'dash.cloudflare.com') {
        found.set(url.href, { url: url.href, kind: git ? 'git' : 'artifact', ...(site ? { preview: 'site' as const } : {}), title: git ? decodeURIComponent(url.pathname.slice(1)) || host : host + (url.pathname === '/' ? '' : url.pathname) });
      }
    } catch { /* Ignore malformed links in messages. */ }
  }
  return [...found.values()];
}

// A shared repository's name in its workspace, and which kind of project repository it is: Await
// names a project's repository p-<id>, an agent's workspace r-<id>, and integration repositories
// after the project's. Previews replace the name with the title the server reports.
const projectRepositories: [RegExp, string][] = [
  [/^p-[a-f0-9-]{36}-(?:prepare|check|publish)$/, 'Integration check'],
  [/^p-[a-f0-9-]{36}$/, 'Project repository'],
  [/^r-[a-f0-9-]{36}$/, 'Agent workspace'],
];
export function artifactName(link: SharedLink, workspaceId: string): { name: string; kind: string | null } {
  const name = (link.repository ?? link.title).replace(`${workspaceId}-`, '');
  return { name, kind: projectRepositories.find(([pattern]) => pattern.test(name))?.[1] ?? null };
}

export type ArtifactContents = { name: string; title: string; description: string | null; branch: string; commit: string | null; files: { path: string; type: string }[]; truncated: boolean; path: string | null; mime: string | null; content: string | null; contentTruncated: boolean; previewUrl: string | null };
