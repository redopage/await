// Result shapes for pinned, read-only run repository reads (list_project_run_files and read_project_run_file).
export const RUN_REPOSITORY_LIMITS = { pageDefault: 100, pageMax: 200, pathSegments: 12, fileBytes: 200_000, proofCommits: 500 } as const;

export type RunEntryType = 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink';
export type RunTreeEntry = { name: string; path: string; type: RunEntryType; oid: string };
export type RunTreeListing = { commit: string; path: string; entries: RunTreeEntry[]; offset: number; limit: number; total: number; has_more: boolean; next_offset: number | null };

// Content is present only when metadata_only is false; reason explains every metadata-only result.
export type RunFileReason = 'binary' | 'too_large' | 'symlink' | 'gitlink';
export type RunFileRead = { commit: string; path: string; type: Exclude<RunEntryType, 'tree'>; oid: string; size: number | null; content: string | null; metadata_only: boolean; reason: RunFileReason | null };
