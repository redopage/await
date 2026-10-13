export type EventWatchState = { active: boolean; paused: boolean; pending: number; expires_at: number; last_error: string | null };
export function eventWatchStatus(watch: EventWatchState, now = Date.now()): { label: string; tone: 'neutral' | 'success' | 'warning' } {
  if (!watch.active) return { label: watch.last_error === 'Subscription expired.' || (!watch.last_error && watch.expires_at <= now) ? 'Expired' : 'Stopped', tone: 'neutral' };
  if (watch.paused) return { label: 'Paused', tone: 'warning' };
  if (watch.last_error) return { label: 'Retrying', tone: 'warning' };
  return { label: watch.pending ? 'Queued' : 'Monitoring', tone: 'success' };
}
