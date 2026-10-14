import { RUN_REPOSITORY_LIMITS as limits, type RunEntryType, type RunFileRead, type RunFileReason, type RunTreeEntry, type RunTreeListing } from '../shared/project-repository';

// Pinned, read-only views of a run repository. Only readCommit, readTree and readBlob are called, so these reads never
// touch refs, tokens or work state, and symbolic links and submodules are reported as entries rather than followed.
export class RunRepositoryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

type Located = { type: RunEntryType; oid: string };

const commitHash = (value: string | null): string => {
  if (!value || !/^[a-f0-9]{40}$/.test(value)) throw new RunRepositoryError('Provide a full 40-character Git commit hash.');
  return value;
};
const integer = (value: string | null, fallback: number, min: number, max: number, name: string): number => {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new RunRepositoryError(`Provide ${name} as an integer from ${min} to ${max}.`);
  return Number(value);
};
const segments = (value: string | null): string[] => {
  if (!value) return [];
  const parts = value.split('/');
  if (parts.length > limits.pathSegments) throw new RunRepositoryError(`Paths may have at most ${limits.pathSegments} segments.`);
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 255 || /[\\\u0000-\u001f\u007f]/.test(part))) {
    throw new RunRepositoryError('Provide a safe relative path without empty, ".", ".." or control-character segments.');
  }
  return parts;
};

// Mirrors the coordinator's candidate proof: walk parents from the commit, reading at most 500 commits.
async function proven(repo: ArtifactsRepo, base: string, commit: string): Promise<ArtifactsCommitMetadata> {
  const head = await repo.readCommit(commit);
  if (!head) throw new RunRepositoryError('This commit is not present in the run repository.', 404);
  const pending = [commit], seen = new Set<string>();
  while (pending.length && seen.size < limits.proofCommits) {
    const hash = pending.pop()!; if (hash === base) return head; if (seen.has(hash)) continue; seen.add(hash);
    const node = hash === commit ? head : await repo.readCommit(hash); if (node) pending.push(...node.parents);
  }
  throw new RunRepositoryError(`Could not verify this commit is the run base or descends from it within ${limits.proofCommits} commits.`, 409);
}

// Resolves a path through trees only. A symbolic link or submodule on the way is refused, never dereferenced.
async function locate(repo: ArtifactsRepo, root: string, path: string[]): Promise<Located> {
  let current: Located = { type: 'tree', oid: root };
  for (const name of path) {
    if (current.type === 'symlink' || current.type === 'gitlink') throw new RunRepositoryError(`The path passes through a ${current.type === 'symlink' ? 'symbolic link' : 'submodule'}, which is never followed.`);
    if (current.type !== 'tree') throw new RunRepositoryError('This path does not exist at the pinned commit.', 404);
    const entry = (await repo.readTree(current.oid))?.find((candidate) => candidate.name === name);
    if (!entry) throw new RunRepositoryError('This path does not exist at the pinned commit.', 404);
    current = { type: entry.type, oid: entry.hash };
  }
  return current;
}

async function listing(repo: ArtifactsRepo, commit: string, path: string, target: Located, offset: number, limit: number): Promise<RunTreeListing> {
  if (target.type !== 'tree') throw new RunRepositoryError('This path is not a directory. Read it with read_project_run_file.');
  const tree = await repo.readTree(target.oid);
  if (!tree) throw new RunRepositoryError('This directory is missing from the run repository.', 404);
  const all = tree.map((entry): RunTreeEntry => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name, type: entry.type, oid: entry.hash }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const has_more = offset + limit < all.length;
  return { commit, path, entries: all.slice(offset, offset + limit), offset, limit, total: all.length, has_more, next_offset: has_more ? offset + limit : null };
}

async function file(repo: ArtifactsRepo, commit: string, path: string, target: Located): Promise<RunFileRead> {
  if (target.type === 'tree') throw new RunRepositoryError('This path is a directory. List it with list_project_run_files.');
  const type = target.type;
  const metadata = (reason: RunFileReason, size: number | null): RunFileRead => ({ commit, path, type, oid: target.oid, size, content: null, metadata_only: true, reason });
  if (type === 'symlink' || type === 'gitlink') return metadata(type, null);
  const blob = await repo.readBlob(target.oid);
  if (!blob) throw new RunRepositoryError('This file is missing from the run repository.', 404);
  if (blob.size > limits.fileBytes) return metadata('too_large', blob.size);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength > limits.fileBytes) return metadata('too_large', bytes.byteLength);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return metadata('binary', bytes.byteLength); }
  if (content.includes('\0')) return metadata('binary', bytes.byteLength);
  return { commit, path, type, oid: target.oid, size: bytes.byteLength, content, metadata_only: false, reason: null };
}

// Serves GET runs/:id/tree (mode 'tree') and runs/:id/source-file (mode 'file') from the commit, path, offset and limit
// query parameters. Input is validated before any repository read; callers recheck access after this resolves.
export function readRunRepository(repo: ArtifactsRepo, baseCommit: string, url: URL, mode: 'tree'): Promise<RunTreeListing>;
export function readRunRepository(repo: ArtifactsRepo, baseCommit: string, url: URL, mode: 'file'): Promise<RunFileRead>;
export function readRunRepository(repo: ArtifactsRepo, baseCommit: string, url: URL, mode: 'tree' | 'file'): Promise<RunTreeListing | RunFileRead>;
export async function readRunRepository(repo: ArtifactsRepo, baseCommit: string, url: URL, mode: 'tree' | 'file'): Promise<RunTreeListing | RunFileRead> {
  const params = url.searchParams, commit = commitHash(params.get('commit')), path = segments(params.get('path'));
  if (mode === 'file' && !path.length) throw new RunRepositoryError('Provide the path of a file to read.');
  const offset = mode === 'tree' ? integer(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER, 'offset') : 0;
  const limit = mode === 'tree' ? integer(params.get('limit'), limits.pageDefault, 1, limits.pageMax, 'limit') : 0;
  const head = await proven(repo, commitHash(baseCommit), commit);
  const target = await locate(repo, head.treeHash, path);
  return mode === 'tree' ? listing(repo, commit, path.join('/'), target, offset, limit) : file(repo, commit, path.join('/'), target);
}
