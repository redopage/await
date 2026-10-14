# Repository read tools

`list_project_run_files` and `read_project_run_file` let a project contributor inspect source in a run repository at a pinned commit without starting a hosted job. Both are served by `readRunRepository(repo, baseCommit, url, mode)` in `src/object/project-repository.ts`, with result types in `src/shared/project-repository.ts`. The coordinator owns routing (`GET runs/:id/tree` and `GET runs/:id/source-file`), scopes, owner-only agent access, and the channel access recheck after the helper resolves.

## Inputs

| Query parameter | Tree mode | File mode |
| --- | --- | --- |
| `commit` | Required full 40-character lowercase hash | Required |
| `path` | Optional, empty for the root | Required |
| `offset` | Integer, at least 0, default 0 | Ignored |
| `limit` | Integer from 1 to 200, default 100 | Ignored |

Paths are relative and slash separated, with at most 12 segments. Empty, `.` and `..` segments, leading or trailing slashes, backslashes, control characters and segments longer than 255 characters are rejected before any repository read.

## Pinning and ancestry

The commit must exist in the run repository and be the run base or descend from it. The proof walks parents from the requested commit and reads at most 500 commits, the same bound the coordinator uses for candidates. A commit from another history, or one further than the bound, is refused with status 409.

## Results

Tree mode returns:

```json
{ "commit": "<sha>", "path": "src", "entries": [{ "name": "index.ts", "path": "src/index.ts", "type": "blob", "oid": "<sha>" }],
  "offset": 0, "limit": 100, "total": 1, "has_more": false, "next_offset": null }
```

Entries are sorted by name. `type` is one of `tree`, `blob`, `exec`, `symlink` or `gitlink`. Request the next page with `offset=next_offset` until `has_more` is false.

File mode returns:

```json
{ "commit": "<sha>", "path": "src/index.ts", "type": "blob", "oid": "<sha>", "size": 26,
  "content": "export const answer = 42;\n", "metadata_only": false, "reason": null }
```

`content` is present only when `metadata_only` is false. Otherwise `reason` says why:

| `reason` | Meaning | `size` |
| --- | --- | --- |
| `too_large` | More than 200000 bytes. Content is not downloaded or truncated. | Byte size |
| `binary` | Not strict UTF-8, or contains a NUL byte. | Byte size |
| `symlink` | A symbolic link. Its target is never read or followed. | `null` |
| `gitlink` | A submodule. The referenced commit is never read. | `null` |

A path that passes through a symbolic link or submodule is refused rather than resolved.

## Errors

The helper throws `RunRepositoryError` with a `status`:

- 400: malformed commit, path, offset or limit; a directory in file mode; a non-directory in tree mode; a path through a symbolic link or submodule.
- 404: the commit, a path segment, or an object is absent.
- 409: the commit is not provably the run base or a descendant within 500 commits.

## Side effects

The helper calls only `readCommit`, `readTree` and `readBlob`. It never reads refs, issues or revokes tokens, forks, writes, starts containers or jobs, or records events or checkpoints. `scripts/project-repository.test.mjs` checks this with a repository proxy that rejects any other access.
