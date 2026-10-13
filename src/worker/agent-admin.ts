import type { Member } from '../shared/types';
import { randomToken, sha256, type Account } from './auth';
import type { Env } from './env';
import { HttpError } from '../shared/http';

type InternalFetch = (env: Env, workspaceId: string, accountId: string, path: string, init?: RequestInit) => Promise<Response>;
type Role = 'owner' | 'admin' | 'member';

function insertToken(env: Env, workspaceId: string, agentId: string, tokenHash: string): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO agent_tokens (token_hash, account_id, workspace_id, scopes, created_at) VALUES (?, ?, ?, ?, ?)').bind(tokenHash, agentId, workspaceId, 'read post files', Date.now());
}

export async function createNamedAgent(env: Env, origin: string, workspaceId: string, ownerId: string, rawName: string, rawDescription: string, inside: InternalFetch) {
  const name = rawName.trim().slice(0, 60);
  if (name.length < 2) throw new HttpError(400, 'Agent name must be at least two characters.');
  const description = rawDescription.slice(0, 500);
  const id = crypto.randomUUID();
  const token = `awc_${randomToken()}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO accounts (id, kind, name, owner_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, 'agent', name, ownerId, description, Date.now()),
    env.DB.prepare('INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (?, ?, ?)').bind(workspaceId, id, 'member'),
    insertToken(env, workspaceId, id, await sha256(token)),
  ]);
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>();
  const member: Member | null = account ? { account_id: account.id, kind: account.kind, name: account.name, avatar_url: account.avatar_url, role: 'member', owner_id: account.owner_id, description: account.description, paused: 0 } : null;
  if (!member) throw new Error('Agent could not be created.');
  const synced = await inside(env, workspaceId, ownerId, '/members/upsert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(member) });
  if (!synced.ok) throw new HttpError(500, 'Agent was created, but could not be added to the workspace. Refresh and try again.');
  return { agent_id: id, token, mcp_url: `${origin}/mcp` };
}

export async function requireManagedAgent(env: Env, workspaceId: string, agentId: string, actorId: string, actorRole: Role) {
  const agent = await env.DB.prepare(`SELECT a.owner_id FROM accounts a
    JOIN workspace_members wm ON wm.account_id = a.id
    WHERE wm.workspace_id = ? AND a.id = ? AND a.kind = 'agent'`)
    .bind(workspaceId, agentId).first<{ owner_id: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found in this workspace.');
  if (actorRole === 'member' && agent.owner_id !== actorId) throw new HttpError(403, 'You cannot manage this agent.');
  return agent;
}

// Invalidates every token and OAuth grant the agent holds in this workspace.
export function revokeStatements(env: Env, workspaceId: string, agentId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE account_id = ? AND workspace_id = ? AND revoked_at IS NULL').bind(Date.now(), agentId, workspaceId),
    env.DB.prepare('UPDATE accounts SET auth_version = auth_version + 1 WHERE id = ?').bind(agentId),
  ];
}

// Drops the agent's sockets, unused live tickets and held long-polls, so a revoked token cannot keep a feed open.
async function closeConnections(env: Env, workspaceId: string, agentId: string, inside: InternalFetch): Promise<number> {
  const closed = await inside(env, workspaceId, agentId, '/connections/close', { method: 'POST' });
  if (!closed.ok) throw new HttpError(502, 'The token was revoked, but open connections could not be closed. Try again.');
  return (await closed.json<{ connections_targeted: number }>()).connections_targeted;
}

export async function revokeNamedAgentTokens(env: Env, workspaceId: string, agentId: string, inside: InternalFetch): Promise<{ connections_closed: number }> {
  await env.DB.batch(revokeStatements(env, workspaceId, agentId));
  return { connections_closed: await closeConnections(env, workspaceId, agentId, inside) };
}

export async function rotateNamedAgentToken(env: Env, origin: string, workspaceId: string, agentId: string, actorId: string, actorRole: Role, inside: InternalFetch) {
  await requireManagedAgent(env, workspaceId, agentId, actorId, actorRole);
  const token = `awc_${randomToken()}`;
  await env.DB.batch([...revokeStatements(env, workspaceId, agentId), insertToken(env, workspaceId, agentId, await sha256(token))]);
  await closeConnections(env, workspaceId, agentId, inside);
  return { agent_id: agentId, token, mcp_url: `${origin}/mcp` };
}
