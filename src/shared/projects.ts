import type { TeamTask } from './types';
import type { CompactHostedJob, CompactIntegration, HostedJob, Integration } from './execution';
export type Project = {
  id: string; channel_id: string; title: string; goal: string; repository: string; source_repository: string;
  remote: string; branch: string; base_commit: string; status: 'provisioning' | 'active' | 'failed';
  board_id: string; revision: number; acceptance_criteria: string; check_command: string;
  created_by: string; created_at: number; updated_at: number;
};
export type ProjectRun = {
  id: string; project_id: string; actor_id: string; title: string; repository: string; remote: string;
  base_commit: string; status: 'provisioning' | 'working' | 'sleeping' | 'submitted' | 'failed' | 'cancelled' | 'integrated';
  branch: string; branch_deleted_at: number | null; branch_deleted_commit: string; task_id: string | null; requirements_revision: number; revision: number; cancellation_reason: string;
  paths: string[]; checkpoint: string; cursor: number; created_at: number; updated_at: number;
};
export type Candidate = {
  id: string; project_id: string; run_id: string; actor_id: string; commit_hash: string; base_commit: string;
  summary: string; checks: string; status: 'pending' | 'approved' | 'changes_requested' | 'stale' | 'integrated';
  requirements_revision: number; revision: number; reviewed_requirements_revision: number | null;
  reviewed_by: string | null; review_note: string; verified_at: number; created_at: number;
};
export type ProjectEvent = {
  seq: number; id: string; project_id: string; actor_id: string; type: string;
  run_id: string | null; data: Record<string, unknown>; created_at: number;
};
export type RequirementsRevision = { project_id: string; revision: number; title: string; goal: string; acceptance_criteria: string; check_command: string; reason: string; actor_id: string; created_at: number };
export type ProjectHandoff = { format: 'await.handoff.v1'; project: Project; tasks: TeamTask[]; requirements: RequirementsRevision[]; runs: ProjectRun[]; candidates: Candidate[]; recent_events: ProjectEvent[]; snapshot_cursor: number; history_truncated: boolean; next_actions: string[]; limitations: string[] };
export type ProjectDetail = { hosted_available: boolean; jobs: HostedJob[]; integrations: Integration[]; project: Project; tasks: TeamTask[]; runs: ProjectRun[]; candidates: Candidate[]; requirements: RequirementsRevision[]; snapshot_cursor: number; events: ProjectEvent[]; next_cursor: number; has_more: boolean };
export type CompactProjectDetail = Omit<ProjectDetail, 'jobs' | 'integrations'> & { jobs: CompactHostedJob[]; jobs_page: { offset: number; limit: number; total: number; has_more: boolean; next_offset: number | null }; integrations: CompactIntegration[] };
export type ProjectRepository = { name: string; channel_id: string };

export function claimPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30 || value.some((p) => typeof p !== 'string')) throw new Error('Choose up to 30 relative file or directory paths.');
  const paths = [...new Set(value.map((path: string) => path.trim().replace(/\/$/, '')))];
  if (paths.some((path) => !path || path.length > 240 || path.startsWith('/') || /[\\*?\x00-\x1f]/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..'))) throw new Error('Use relative paths without wildcards or parent directories.');
  return paths;
}
export function overlappingPaths(left: string[], right: string[]): string[] {
  return left.filter((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}
