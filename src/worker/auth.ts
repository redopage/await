import type { Env } from './env';
import type { EventAuthority } from '../object/event-subscriptions';

export type Account = {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  email: string | null;
  owner_id: string | null;
  description: string;
  avatar_url: string | null;
  auth_version: number;
};

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g)!, (part) => Number.parseInt(part, 16));
}

export async function verifyReviewerPassword(password: string, salt: string, expectedHash: string, iterations: number): Promise<boolean> {
  const saltBytes = hexBytes(salt);
  const expectedBytes = hexBytes(expectedHash);
  if (!saltBytes || saltBytes.length !== 16 || !expectedBytes || expectedBytes.length !== 32 || !Number.isInteger(iterations) || iterations !== 100000) return false;
  const saltBuffer = new ArrayBuffer(saltBytes.length);
  new Uint8Array(saltBuffer).set(saltBytes);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations }, key, 256));
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual[index] ^ expectedBytes[index];
  return mismatch === 0;
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function cookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie') ?? '';
  const item = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(name.length + 1)); }
  catch { return null; }
}

export async function humanSession(env: Env, request: Request): Promise<Account | null> {
  const token = cookie(request, 'await_session');
  if (!token) return null;
  return await env.DB.prepare(`SELECT a.id, a.kind, a.name, a.email, a.owner_id, a.description, a.avatar_url, a.auth_version
    FROM sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND a.kind = 'human'`).bind(await sha256(token), Date.now()).first<Account>();
}

export async function agentSession(env: Env, request: Request): Promise<{ account: Account; workspaceId: string; scopes: string[]; eventAuthority: EventAuthority } | null> {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT a.id, a.kind, a.name, a.email, a.owner_id, a.description, a.avatar_url, a.auth_version,
    t.workspace_id, t.scopes FROM agent_tokens t JOIN accounts a ON a.id = t.account_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND a.kind = 'agent'`).bind(await sha256(token)).first<Account & { workspace_id: string; scopes: string }>();
  if (!row) return null;
  return { account: row, workspaceId: row.workspace_id, scopes: row.scopes.split(' '), eventAuthority: {
    accountId: row.id, workspaceId: row.workspace_id, authVersion: row.auth_version, credential: { kind: 'bearer', tokenHash: await sha256(token) },
  } };
}

export function sessionCookie(token: string, origin: string): string {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `await_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`;
}

export function clearSessionCookie(origin: string): string {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `await_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

export async function createSession(env: Env, accountId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), accountId, Date.now() + 30 * 86400000).run();
  return token;
}

export async function oauthProfile(env: Env, provider: string, code: string, redirectUri: string): Promise<{ email: string; name: string; avatar: string | null }> {
  if (provider === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const body = new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
    const tokenData = await tokenResponse.json<{ access_token?: string; error?: string }>();
    if (!tokenData.access_token) throw new Error(tokenData.error ?? 'Google sign-in failed.');
    const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const user = await userResponse.json<{ email?: string; email_verified?: boolean; name?: string; picture?: string }>();
    if (!user.email || !user.email_verified) throw new Error('Your Google account needs a verified email address.');
    return { email: user.email.toLowerCase(), name: user.name ?? user.email.split('@')[0], avatar: user.picture ?? null };
  }
  throw new Error('This sign-in provider is not configured.');
}
