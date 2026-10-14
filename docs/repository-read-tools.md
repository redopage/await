# Repository read tools

`list_project_run_files` and `read_project_run_file` let a project contributor inspect source in a run repository at a pinned commit without starting a hosted job. Both are served by `readRunRepository(repo, baseCommit, url, mode)` in `src/object/project-repository.ts`, with result types in `src/shared/project-repository.ts`. The coordinator owns routing (`GET runs/:id/tree` and `GET runs/:id/source-file`), scopes, owner-only agent access, and the channel access recheck after the helper resolves.

## Inputs

| Query parameter | Tree mode | File mode |
| --- | --- | --- |
| `commit` | Required full 40-character lowercase hash | Required |
| `path` | Optional, empty for the root | Required |
| `offset` | Integer, at least 0, default 0 | Ignored |
| `limit` | Integer from 1 to 200, default 100 | Ignored |
| `start_line` | Ignored | Optional integer, at least 1. Default 1 in range mode |
| `line_limit` | Ignored | Optional integer from 1 to 200. Default 100 in range mode |

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
| `too_large` | More than 200000 bytes. Content is not decoded or returned. | Byte size |
| `binary` | Not strict UTF-8, or contains a NUL byte. | Byte size |
| `symlink` | A symbolic link. Its target is never read or followed. | `null` |
| `gitlink` | A submodule. The referenced commit is never read. | `null` |
| `line_too_large` | Range mode only. The first requested line exceeds 16000 bytes. | Byte size |

A path that passes through a symbolic link or submodule is refused rather than resolved.

## Line ranges

Prefer a bounded range read for large text: pass `start_line`, `line_limit` or both. Without either parameter the result is exactly the full-file shape above. With either, the result adds:

```json
{ "start_line": 1, "line_limit": 100, "total_lines": 250, "end_line": 100, "has_more": true, "next_line": 101, "line_too_large": null }
```

- Lines are 1-based. A line ends after each LF byte and keeps it, so CRLF, a lone CR, multibyte UTF-8 and a leading byte order mark round-trip exactly when pages are joined. (Whole-file reads still drop a leading byte order mark, as before.) A trailing LF does not add an empty line, and a final line without LF still counts.
- `content` holds complete lines from `start_line`: at most `line_limit` of them and at most 16000 UTF-8 bytes. A line is never cut. The page ends before any line that would pass the byte cap, and `next_line` names it.
- `size` is still the size of the whole file.
- `next_line` is the next unread line when `has_more` is true, otherwise null. Read the next page with `start_line=next_line`.
- An empty file, or a `start_line` beyond the last line, returns `content: ""`, `end_line: null`, `has_more: false` and `next_line: null`.
- If the first requested line alone exceeds 16000 bytes, the result is `metadata_only: true`, `content: null`, `reason: "line_too_large"` and `line_too_large` set to that line number. `has_more` is true and `next_line` stays on that unread line rather than skipping it. Stop paging on `metadata_only`, inspect the line with a bounded hosted command, and pass a later `start_line` explicitly to continue.
- The 200000-byte file cap and the `too_large`, `binary`, `symlink` and `gitlink` results apply unchanged. In range mode they also carry `total_lines: null`, `end_line: null`, `has_more: false`, `next_line: null` and `line_too_large: null`, so they never imply content was returned.

## Errors

The helper throws `RunRepositoryError` with a `status`:

- 400: malformed commit, path, offset, limit, start_line or line_limit (an empty range value is malformed); a directory in file mode; a non-directory in tree mode; a path through a symbolic link or submodule.
- 404: the commit, a path segment, or an object is absent.
- 409: the commit is not provably the run base or a descendant within 500 commits.

`validateRunFileRange(url: URL): void` checks only `start_line` and `line_limit`, using the same parser as `readRunRepository`. It is synchronous, takes no repository, and throws the same 400 `RunRepositoryError` a file read would, so the coordinator can refuse an invalid range before opening a repository handle. `readRunRepository` still validates on its own.

## Side effects

The helper calls only `readCommit`, `readTree` and `readBlob`. It never reads refs, issues or revokes tokens, forks, writes, starts containers or jobs, or records events or checkpoints. `scripts/project-repository.test.mjs` checks this with a repository proxy that rejects any other access.
