// Result shapes for pinned, read-only run repository reads (list_project_run_files and read_project_run_file).
export const RUN_REPOSITORY_LIMITS = { pageDefault: 100, pageMax: 200, pathSegments: 12, fileBytes: 200_000, proofCommits: 500, lineDefault: 100, lineMax: 200, rangeBytes: 16_000 } as const;

export type RunEntryType = 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink';
export type RunTreeEntry = { name: string; path: string; type: RunEntryType; oid: string };
export type RunTreeListing = { commit: string; path: string; entries: RunTreeEntry[]; offset: number; limit: number; total: number; has_more: boolean; next_offset: number | null };

// Content is present only when metadata_only is false; reason explains every metadata-only result.
export type RunFileReason = 'binary' | 'too_large' | 'symlink' | 'gitlink' | 'line_too_large';
export type RunFileRead = { commit: string; path: string; type: Exclude<RunEntryType, 'tree'>; oid: string; size: number | null; content: string | null; metadata_only: boolean; reason: RunFileReason | null };

// Added to file reads that ask for start_line or line_limit. Lines are 1-based and end after each LF, so CRLF and a final
// unterminated line round-trip exactly. next_line is the next unread line when has_more is true, otherwise null, and
// line_too_large names a first requested line that alone exceeds rangeBytes. That line is reported and stays next_line;
// it is never cut or skipped.
export type RunFileRange = { start_line: number; line_limit: number; total_lines: number | null; end_line: number | null; has_more: boolean; next_line: number | null; line_too_large: number | null };
export type RunFileRangeRead = RunFileRead & RunFileRange;
