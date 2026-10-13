import type { Member } from './types';

// Helpers shared by the server, the web app and the MCP widget for member display.

// Direct-message channels carry dm_key = the two account ids sorted and joined with ':'.
export function dmKey(accountA: string, accountB: string): string {
  return [accountA, accountB].sort().join(':');
}

export function dmPartnerId(dmKeyValue: string | null | undefined, selfId: string): string | null {
  const ids = (dmKeyValue ?? '').split(':').filter(Boolean);
  return ids.find((id) => id !== selfId) ?? ids[0] ?? null;
}

// First letters of the first two words: "Ada Lovelace" -> "AL", "Builder" -> "B".
export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase() || '?';
}

// An agent's managers: the person who owns it and the workspace's owners and admins.
export function managesAgent(viewer: Pick<Member, 'kind' | 'role' | 'account_id'>, agent: Pick<Member, 'owner_id'>): boolean {
  return viewer.kind === 'human' && (viewer.role !== 'member' || agent.owner_id === viewer.account_id);
}
