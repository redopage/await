import { RUN_REPOSITORY_LIMITS as limits, type RunEntryType, type RunFileRange, type RunFileRangeRead, type RunFileRead, type RunFileReason, type RunTreeEntry, type RunTreeListing } from '../shared/project-repository';

// Pinned, read-only views of a run repository. Only readCommit, readTree and readBlob are called, so these reads never
// touch refs, tokens or work state, and symbolic links and submodules are reported as entries rather than followed.
export class RunRepositoryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

type Located = { type: RunEntryType; oid: string };
type LineRange = { start: number; limit: number };

const commitHash = (value: string | null): string => {
  if (!value || !/^[a-f0-9]{40}$/.test(value)) throw new RunRepositoryError('Provide a full 40-character Git commit hash.');
  return value;
};
const integer = (value: string | null, fallback: number, min: number, max: number, name: string): number => {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new RunRepositoryError(`Provide ${name} as an integer from ${min} to ${max}.`);
  return Number(value);
};
// Range mode starts when either parameter is present. Unlike offset and limit, an empty value is refused, not defaulted.
const lineRange = (params: URLSearchParams): LineRange | null => {
  if (!params.has('start_line') && !params.has('line_limit')) return null;
  const bounded = (name: string, fallback: number, max: number): number => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new RunRepositoryError(`Provide ${name} as an integer from 1 to ${max}.`);
    return Number(value);
  };
  return { start: bounded('start_line', 1, Number.MAX_SAFE_INTEGER), limit: bounded('line_limit', limits.lineDefault, limits.lineMax) };
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

// Returns complete lines from range.start, stopping at range.limit lines or before a line that would pass rangeBytes.
// LF bytes never occur inside a multibyte UTF-8 sequence, so slicing after each LF keeps characters whole.
function page(file: RunFileRead, bytes: Uint8Array, range: LineRange): RunFileRangeRead {
  const ends: number[] = [];
  for (let i = 0; i < bytes.byteLength; i++) if (bytes[i] === 0x0a) ends.push(i + 1);
  if (bytes.byteLength && bytes[bytes.byteLength - 1] !== 0x0a) ends.push(bytes.byteLength);
  const total = ends.length, first = range.start - 1, paging = { start_line: range.start, line_limit: range.limit, total_lines: total, line_too_large: null };
  if (first >= total) return { ...file, content: '', ...paging, end_line: null, has_more: false, next_line: null };
  const from = first ? ends[first - 1] : 0;
  let next = first;
  while (next < total && next - first < range.limit && ends[next] - from <= limits.rangeBytes) next++;
  // The first line alone passes the cap. It stays the next unread line; callers choose a later start_line explicitly.
  if (next === first) return { ...file, content: null, metadata_only: true, reason: 'line_too_large', ...paging, line_too_large: range.start, end_line: null, has_more: true, next_line: range.start };
  // ignoreBOM keeps a leading byte order mark, so joined pages reproduce the original bytes.
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(from, ends[next - 1]));
  return { ...file, content, ...paging, end_line: next, has_more: next < total, next_line: next < total ? next + 1 : null };
}

async function file(repo: ArtifactsRepo, commit: string, path: string, target: Located, range: LineRange | null): Promise<RunFileRead> {
  if (target.type === 'tree') throw new RunRepositoryError('This path is a directory. List it with list_project_run_files.');
  const type = target.type;
  const unpaged = (): RunFileRange | null => range && { start_line: range.start, line_limit: range.limit, total_lines: null, end_line: null, has_more: false, next_line: null, line_too_large: null };
  const metadata = (reason: RunFileReason, size: number | null): RunFileRead => ({ commit, path, type, oid: target.oid, size, content: null, metadata_only: true, reason, ...unpaged() });
  if (type === 'symlink' || type === 'gitlink') return metadata(type, null);
  const blob = await repo.readBlob(target.oid);
  if (!blob) throw new RunRepositoryError('This file is missing from the run repository.', 404);
  if (blob.size > limits.fileBytes) return metadata('too_large', blob.size);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength > limits.fileBytes) return metadata('too_large', bytes.byteLength);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return metadata('binary', bytes.byteLength); }
  if (content.includes('\0')) return metadata('binary', bytes.byteLength);
  const read: RunFileRead = { commit, path, type, oid: target.oid, size: bytes.byteLength, content, metadata_only: false, reason: null };
  return range ? page(read, bytes, range) : read;
}

// Checks only the start_line and line_limit query parameters with the same parser readRunRepository uses, so a caller
// can refuse an invalid range before opening a repository. Throws the same RunRepositoryError (400) a read would.
export function validateRunFileRange(url: URL): void {
  lineRange(url.searchParams);
}

// Serves GET runs/:id/tree (mode 'tree') and runs/:id/source-file (mode 'file') from the commit, path, offset and limit
// query parameters, plus start_line and line_limit for a bounded page of file lines. Input is validated before any repository read; callers recheck access after this resolves.
export function readRunRepository(repo: ArtifactsRepo, baseCommit: string, url: URL, mode: 'tree'): Promise<RunTreeListing>;
export function readRunRepository(repo: ArtifactsRepo, baseCommit: string, url: URL, mode: 'file'): Promise<RunFileRead>;
export function readRunRepository(repo: ArtifactsRepo, baseCommit: string, url: URL, mode: 'tree' | 'file'): Promise<RunTreeListing | RunFileRead>;
export async function readRunRepository(repo: ArtifactsRepo, baseCommit: string, url: URL, mode: 'tree' | 'file'): Promise<RunTreeListing | RunFileRead> {
  const params = url.searchParams, commit = commitHash(params.get('commit')), path = segments(params.get('path'));
  if (mode === 'file' && !path.length) throw new RunRepositoryError('Provide the path of a file to read.');
  const offset = mode === 'tree' ? integer(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER, 'offset') : 0;
  const limit = mode === 'tree' ? integer(params.get('limit'), limits.pageDefault, 1, limits.pageMax, 'limit') : 0;
  const range = mode === 'file' ? lineRange(params) : null;
  const head = await proven(repo, commitHash(baseCommit), commit);
  const target = await locate(repo, head.treeHash, path);
  return mode === 'tree' ? listing(repo, commit, path.join('/'), target, offset, limit) : file(repo, commit, path.join('/'), target, range);
}
