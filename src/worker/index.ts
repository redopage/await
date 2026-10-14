import { Hono } from 'hono';
import type { Context } from 'hono';
import { OAuthProvider, AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { Workspace } from '../object/workspace';
import type { Member } from '../shared/types';
import { attachmentKind } from '../shared/attachments';
import type { Env } from './env';
import { agentSession, clearSessionCookie, cookie, createSession, humanSession, oauthProfile, randomToken, sessionCookie, sha256, verifyReviewerPassword, type Account } from './auth';
import { handleMcp } from './mcp';
import { renderConsentPage } from './oauth-consent';
import { deleteFile, getFile, putFile } from './files';
import { readLimitedBody } from './limited-body';
import { readJsonObject, reserveRequests } from './request-controls';
import { emailAvailable, sendSigninLink } from './email';
import { createNamedAgent, requireManagedAgent, revokeNamedAgentTokens, revokeStatements, rotateNamedAgentToken } from './agent-admin';
import { searchGifs } from './giphy';
import { artifactContents, artifactFile } from './artifacts';
import { verifyFileLink } from './file-links';
import { failure as error, HttpError } from '../shared/http';

type AppContext = Context<{ Bindings: Env }>;
type WorkspaceRole = { role: 'owner' | 'admin' | 'member' };

const app = new Hono<{ Bindings: Env }>();

function publicMember(account: Account, role: WorkspaceRole['role']): Member {
  return { account_id: account.id, kind: account.kind, name: account.name, avatar_url: account.avatar_url, role, owner_id: account.owner_id, description: account.description, paused: 0 };
}

async function requireHuman(c: AppContext): Promise<Account | Response> {
  const account = await humanSession(c.env, c.req.raw);
  return account ?? error('Sign in to continue.', 401);
}

async function workspaceRole(env: Env, workspaceId: string, accountId: string): Promise<WorkspaceRole | null> {
  return await env.DB.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND account_id = ?').bind(workspaceId, accountId).first<WorkspaceRole>();
}

async function requireWorkspace(c: AppContext, workspaceId: string): Promise<{ account: Account; role: WorkspaceRole['role'] } | Response> {
  const account = await requireHuman(c);
  if (account instanceof Response) return account;
  const membership = await workspaceRole(c.env, workspaceId, account.id);
  return membership ? { account, role: membership.role } : error('Workspace not found.', 404);
}

function stub(env: Env, workspaceId: string): DurableObjectStub {
  return env.WORKSPACES.get(env.WORKSPACES.idFromName(workspaceId));
}

async function inside(env: Env, workspaceId: string, accountId: string, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`https://workspace.internal${path}`);
  // Paths carry request values; refuse any that URL parsing would rewrite, such as dot segments.
  if (`${url.pathname}${url.search}` !== path) throw new HttpError(400, 'Invalid request path.');
  return stub(env, workspaceId).fetch(new Request(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'x-account-id': accountId, 'x-workspace-id': workspaceId },
  }));
}

async function insideJson(env: Env, workspaceId: string, accountId: string, path: string, body?: unknown, method = 'POST'): Promise<Response> {
  return inside(env, workspaceId, accountId, path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

function checkOrigin(request: Request): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

// Sign-in links and OAuth callbacks are only issued for the configured app origin,
// a *.workers.dev preview of it, or local development.
function signinOrigin(env: Env, request: Request): string | null {
  const url = new URL(request.url);
  if (url.protocol === 'https:' && (url.origin === env.APP_ORIGIN || url.hostname.endsWith('.workers.dev'))) return url.origin;
  if (['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:') return url.origin;
  return null;
}

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !checkOrigin(c.req.raw)) return c.json({ error: 'Invalid request origin.' }, 403);
  // Route params are pasted into Durable Object paths. Ids never need percent-encoding, so refusing it
  // keeps a param from smuggling '/', '?' or dot segments into an internal route.
  if (/^\/api\/(?:workspaces|agent)\//.test(c.req.path) && new URL(c.req.url).pathname.includes('%')) return c.json({ error: 'Not found.' }, 404);
  await next();
  // Durable Object fetch responses have immutable headers. Preserve WebSocket
  // upgrades; clone ordinary responses before applying the API cache policy.
  if (c.res.status !== 101) {
    const headers = new Headers(c.res.headers);
    headers.set('Cache-Control', 'no-store');
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
  }
});

app.get('/api/workspaces/:id/artifacts', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  try { return c.json(await artifactContents(c.env, inside, c.req.param('id'), access.account.id, c.req.query('message_id') ?? '', c.req.query('url') ?? '', c.req.query('ref'), c.req.query('path'))); }
  catch (cause) { return error(cause instanceof Error ? cause.message : 'Could not load this artifact.', 400); }
});
app.get('/api/artifact-previews/:ticket/files/*', async (c) => {
  const marker = '/files/';
  try {
    const path = decodeURIComponent(new URL(c.req.url).pathname.split(marker).slice(1).join(marker));
    return await artifactFile(c.env, inside, c.req.param('ticket'), path);
  }
  catch { return error('This artifact preview could not load.', 404); }
});

app.get('/api/health', (c) => c.json({ ok: true }));

// Filenames arrive percent-encoded; malformed encodings and control characters never reach storage or headers.
function uploadFilename(header: string | undefined): string {
  let decoded = 'file';
  try { decoded = decodeURIComponent(header ?? 'file'); } catch { /* keep the fallback name */ }
  const cleaned = decoded.replace(/[\x00-\x1f\\/:]/g, '_').trim().slice(0, 180);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

function canCreateWorkspace(env: Env, emailValue: string | null | undefined): boolean {
  const email = emailValue?.toLowerCase() ?? '';
  if (!email) return false;
  if (env.WORKSPACE_CREATION === 'open') return true;
  // Local development accounts (name@localhost from the dev login) can always start a workspace.
  if (env.DEV_AUTH === '1' && email.endsWith('@localhost')) return true;
  const allowedEmails = (env.BOOTSTRAP_EMAILS ?? '').toLowerCase().split(',').map((item) => item.trim()).filter(Boolean);
  const allowedDomains = (env.BOOTSTRAP_DOMAINS ?? '').toLowerCase().split(',').map((item) => item.trim());
  return allowedEmails.includes(email) || allowedDomains.some((domain) => domain && email.endsWith(`@${domain}`));
}

app.get('/api/me', async (c) => {
  const account = await humanSession(c.env, c.req.raw);
  const providers = [c.env.AUTH_EMAIL_ENABLED === '1' && 'email', c.env.GOOGLE_CLIENT_ID && 'google'].filter(Boolean);
  const signupOpen = c.env.WORKSPACE_CREATION === 'open';
  const canDevLogin = c.env.DEV_AUTH === '1' && ['localhost', '127.0.0.1'].includes(new URL(c.req.url).hostname);
  if (!account) return c.json({ account: null, workspaces: [], providers, can_create_workspace: false, signup_open: signupOpen, can_dev_login: canDevLogin });
  const workspaces = await c.env.DB.prepare(`SELECT w.id, w.name, w.slug, wm.role FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.account_id = ? ORDER BY w.created_at`).bind(account.id).all();
  return c.json({ account: { id: account.id, name: account.name, email: account.email, avatar_url: account.avatar_url }, workspaces: workspaces.results, providers, can_create_workspace: canCreateWorkspace(c.env, account.email), signup_open: signupOpen, can_dev_login: canDevLogin });
});

app.patch('/api/me', async (c) => {
  const account = await requireHuman(c);
  if (account instanceof Response) return account;
  const input = await c.req.json<{ name?: string }>().catch((): { name?: string } => ({}));
  const name = input.name?.trim().replace(/\s+/g, ' ') ?? '';
  if (name.length < 2 || name.length > 80) return error('Use a name between 2 and 80 characters.');
  const memberships = await c.env.DB.prepare('SELECT workspace_id, role FROM workspace_members WHERE account_id = ?').bind(account.id).all<{ workspace_id: string; role: WorkspaceRole['role'] }>();
  await c.env.DB.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(name, account.id).run();
  const updated = { ...account, name };
  const synced = await Promise.all(memberships.results.map(({ workspace_id, role }) => insideJson(c.env, workspace_id, account.id, '/members/upsert', publicMember(updated, role))));
  if (synced.some((response) => !response.ok)) return error('Name saved, but a workspace could not refresh. Reload to retry.', 500);
  return c.json({ name });
});

app.get('/api/notifications', async (c) => {
  const account = await requireHuman(c);
  if (account instanceof Response) return account;
  const saved = await c.env.DB.prepare('SELECT email_mentions, email_dms FROM notification_preferences WHERE account_id = ?').bind(account.id).first<{ email_mentions: number; email_dms: number }>();
  return c.json({ email_mentions: saved?.email_mentions === 1, email_dms: saved?.email_dms === 1, email_available: emailAvailable(c.env) });
});

app.post('/api/notifications', async (c) => {
  const account = await requireHuman(c);
  if (account instanceof Response) return account;
  const input = await c.req.json<{ email_mentions?: boolean; email_dms?: boolean }>();
  if (typeof input.email_mentions !== 'boolean' || typeof input.email_dms !== 'boolean') return error('Choose notification settings.');
  await c.env.DB.prepare(`INSERT INTO notification_preferences (account_id, email_mentions, email_dms, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET email_mentions = excluded.email_mentions, email_dms = excluded.email_dms, updated_at = excluded.updated_at`).bind(account.id, input.email_mentions ? 1 : 0, input.email_dms ? 1 : 0, Date.now()).run();
  return c.json({ email_mentions: input.email_mentions, email_dms: input.email_dms, email_available: emailAvailable(c.env) });
});

app.post('/api/auth/email/start', async (c) => {
  if (!emailAvailable(c.env, c.env.AUTH_EMAIL_ENABLED)) return error('Email sign-in is not available yet.', 503);
  const origin = signinOrigin(c.env, c.req.raw);
  if (!origin) return error('Email sign-in is not available on this address.', 403);
  const input = await readJsonObject(c.req.raw);
  if (input instanceof Response) return input;
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error('Enter a valid email address.');
  const now = Date.now();
  await c.env.DB.prepare('DELETE FROM email_signin_links WHERE expires_at < ?').bind(now - 86400000).run();
  const ipHash = await sha256(c.req.header('cf-connecting-ip') ?? 'local');
  const budget = await reserveRequests(c.env.DB, [
    { key: `signin-email:${await sha256(email)}`, maximum: 3, windowMs: 900000 },
    { key: `signin-ip:${ipHash}`, maximum: 20, windowMs: 900000 },
  ], now);
  if (!budget.allowed) return c.json({ error: 'Too many links requested. Try again in 15 minutes.' }, 429, { 'Retry-After': String(budget.retryAfter) });
  const existing = await c.env.DB.prepare('SELECT id FROM accounts WHERE email = ? AND kind = ?').bind(email, 'human').first<{ id: string }>();
  let inviteValid = false;
  if (typeof input.invite === 'string' && input.invite.length >= 16 && input.invite.length <= 200) {
    const invite = await c.env.DB.prepare('SELECT token_hash FROM invites WHERE token_hash = ? AND expires_at > ? AND uses_left > 0').bind(await sha256(input.invite), now).first();
    inviteValid = Boolean(invite);
  }
  if (!existing && !canCreateWorkspace(c.env, email) && !inviteValid) return error('Use a team invitation to join Await.', 403);
  const token = randomToken();
  const tokenHash = await sha256(token);
  const returnTo = typeof input.next === 'string' && input.next.startsWith('/authorize?') ? input.next.slice(0, 4000) : null;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE email_signin_links SET used_at = ? WHERE email = ? AND used_at IS NULL').bind(now, email),
    c.env.DB.prepare('INSERT INTO email_signin_links (token_hash, email, invite_token, return_to, ip_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(tokenHash, email, inviteValid ? input.invite : null, returnTo, ipHash, now, now + 600000),
  ]);
  const link = `${origin}/signin/verify#token=${token}`;
  try { await sendSigninLink(c.env, email, link); }
  catch (cause) {
    await c.env.DB.prepare('DELETE FROM email_signin_links WHERE token_hash = ?').bind(tokenHash).run();
    return error(cause instanceof Error ? cause.message : 'Could not send the sign-in link.', 502);
  }
  return c.json({ ok: true });
});

app.post('/api/auth/email/consume', async (c) => {
  const input = await readJsonObject(c.req.raw, 1024);
  if (input instanceof Response) return input;
  if (typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) return error('This sign-in link is invalid. Request a new one.', 401);
  const now = Date.now();
  const saved = await c.env.DB.prepare('UPDATE email_signin_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, invite_token, return_to').bind(now, await sha256(input.token!), now).first<{ email: string; invite_token: string | null; return_to: string | null }>();
  if (!saved) return error('This sign-in link expired or was already used. Request a new one.', 401);
  let account = await c.env.DB.prepare('SELECT * FROM accounts WHERE email = ? AND kind = ?').bind(saved.email, 'human').first<Account>();
  if (!account) {
    const id = crypto.randomUUID();
    const name = saved.email.split('@')[0];
    await c.env.DB.prepare('INSERT OR IGNORE INTO accounts (id, kind, name, email, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, 'human', name, saved.email, Date.now()).run();
    account = await c.env.DB.prepare("SELECT * FROM accounts WHERE email = ? AND kind = 'human'").bind(saved.email).first<Account>();
  }
  if (!account) return error('Could not create your account.', 500);
  const session = await createSession(c.env, account.id);
  let next = saved.return_to ?? '/';
  if (saved.invite_token) {
    try { await acceptInvite(c.env, account, saved.invite_token); }
    catch { next = `/invite/${saved.invite_token}`; }
  }
  c.header('Set-Cookie', sessionCookie(session, new URL(c.req.url).origin));
  return c.json({ ok: true, next });
});

app.post('/api/auth/reviewer', async (c) => {
  if (!signinOrigin(c.env, c.req.raw)) return error('Sign-in is not available on this address.', 403);
  const body = await readLimitedBody(c.req.raw.body, 2048);
  if (!body) return error('Sign-in request is too large.', 413);
  let input: { email?: string; password?: string; next?: string };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return error('Enter your reviewer email and password.');
    input = parsed as typeof input;
  }
  catch { return error('Enter your reviewer email and password.'); }
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 1 || password.length > 256) return error('Incorrect email or password.', 401);
  const now = Date.now();
  const ipKey = `ip:${await sha256(c.req.header('cf-connecting-ip') ?? 'local')}`;
  const accountKey = `account:${await sha256(email)}`;
  const limits = await Promise.all([ipKey, accountKey].map((key) => c.env.DB.prepare('SELECT failures, expires_at FROM reviewer_login_attempts WHERE key = ?').bind(key).first<{ failures: number; expires_at: number }>()));
  if (limits.some((limit) => limit && limit.expires_at > now && limit.failures >= 8)) return error('Too many sign-in attempts. Try again in 15 minutes.', 429);
  const credential = await c.env.DB.prepare(`SELECT a.id, a.kind, a.name, a.email, a.owner_id, a.description, a.avatar_url, a.auth_version,
    r.salt, r.password_hash, r.iterations FROM reviewer_credentials r JOIN accounts a ON a.id = r.account_id
    WHERE a.email = ? AND a.kind = 'human' AND r.disabled_at IS NULL`).bind(email).first<Account & { salt: string; password_hash: string; iterations: number }>();
  const valid = await verifyReviewerPassword(password, credential?.salt ?? '00000000000000000000000000000000', credential?.password_hash ?? '0000000000000000000000000000000000000000000000000000000000000000', credential?.iterations ?? 100000);
  if (!credential || !valid) {
    const windowEnd = now + 900000;
    const failure = `INSERT INTO reviewer_login_attempts (key, failures, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET failures = CASE WHEN expires_at <= ? THEN 1 ELSE failures + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END`;
    await c.env.DB.batch([ipKey, accountKey].map((key) => c.env.DB.prepare(failure).bind(key, windowEnd, now, now, windowEnd)));
    return error('Incorrect email or password.', 401);
  }
  await c.env.DB.batch([ipKey, accountKey].map((key) => c.env.DB.prepare('DELETE FROM reviewer_login_attempts WHERE key = ?').bind(key)));
  const session = await createSession(c.env, credential.id);
  const next = typeof input.next === 'string' && input.next.startsWith('/authorize?') ? input.next.slice(0, 4000) : '/';
  c.header('Set-Cookie', sessionCookie(session, new URL(c.req.url).origin));
  return c.json({ ok: true, next });
});

app.get('/api/auth/:provider/start', async (c) => {
  const provider = c.req.param('provider');
  if (provider !== 'google') return error('Unknown provider.', 404);
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) return error('Provider not configured.', 503);
  const state = randomToken();
  const stateHash = await sha256(state);
  const origin = signinOrigin(c.env, c.req.raw);
  if (!origin) return error('Sign-in is not available on this address.', 403);
  const budget = await reserveRequests(c.env.DB, [{ key: `google-start:${await sha256(c.req.header('cf-connecting-ip') ?? 'local')}`, maximum: 20, windowMs: 900000 }]);
  if (!budget.allowed) return c.json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429, { 'Retry-After': String(budget.retryAfter) });
  const next = c.req.query('next') ?? '';
  const returnTo = next.startsWith('/authorize?') ? next.slice(0, 4000) : null;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(Date.now()),
    c.env.DB.prepare('INSERT INTO oauth_states (state_hash, provider, invite_token, return_to, expires_at) VALUES (?, ?, ?, ?, ?)').bind(stateHash, provider, c.req.query('invite') ?? null, returnTo, Date.now() + 600000),
  ]);
  c.header('Set-Cookie', `await_google_${stateHash.slice(0, 16)}=${stateHash}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=600${origin.startsWith('https:') ? '; Secure' : ''}`);
  const redirectUri = `${origin}/api/auth/${provider}/callback`;
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/:provider/callback', async (c) => {
  const provider = c.req.param('provider');
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (provider !== 'google' || !code || !state || !/^[a-f0-9]{64}$/.test(state)) return c.redirect('/?error=signin');
  const stateHash = await sha256(state);
  const cookieName = `await_google_${stateHash.slice(0, 16)}`;
  if (cookie(c.req.raw, cookieName) !== stateHash) return c.redirect('/?error=state');
  c.header('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=0${new URL(c.req.url).protocol === 'https:' ? '; Secure' : ''}`);
  const saved = await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING provider, invite_token, return_to').bind(stateHash, Date.now()).first<{ provider: string; invite_token: string | null; return_to: string | null }>();
  if (!saved || saved.provider !== provider) return c.redirect('/?error=state');
  try {
    const origin = new URL(c.req.url).origin;
    const profile = await oauthProfile(c.env, provider, code, `${origin}/api/auth/${provider}/callback`);
    let account = await c.env.DB.prepare('SELECT * FROM accounts WHERE email = ? AND kind = ?').bind(profile.email, 'human').first<Account>();
    const inviteValid = saved.invite_token && await c.env.DB.prepare('SELECT token_hash FROM invites WHERE token_hash = ? AND expires_at > ? AND uses_left > 0').bind(await sha256(saved.invite_token), Date.now()).first();
    if (!account && !canCreateWorkspace(c.env, profile.email) && !inviteValid) return c.redirect('/?error=' + encodeURIComponent('Use a team invitation to join Await.'));
    if (!account) {
      const id = crypto.randomUUID();
      await c.env.DB.prepare('INSERT OR IGNORE INTO accounts (id, kind, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, 'human', profile.name, profile.email, profile.avatar, Date.now()).run();
      account = await c.env.DB.prepare("SELECT * FROM accounts WHERE email = ? AND kind = 'human'").bind(profile.email).first<Account>();
    } else {
      await c.env.DB.prepare('UPDATE accounts SET name = ?, avatar_url = ? WHERE id = ?').bind(profile.name, profile.avatar, account.id).run();
      account = { ...account, name: profile.name, avatar_url: profile.avatar };
    }
    if (!account) throw new Error('Could not create account.');
    if (saved.invite_token) await acceptInvite(c.env, account, saved.invite_token);
    const session = await createSession(c.env, account.id);
    const response = c.redirect(saved.return_to ?? '/');
    response.headers.append('Set-Cookie', sessionCookie(session, origin));
    return response;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'Sign-in failed.';
    return c.redirect(`/?error=${encodeURIComponent(reason)}`);
  }
});

app.post('/api/logout', async (c) => {
  const token = cookie(c.req.raw, 'await_session');
  const account = token ? await humanSession(c.env, c.req.raw) : null;
  let connectionsTargeted = 0;
  if (account) {
    const memberships = await c.env.DB.prepare('SELECT workspace_id FROM workspace_members WHERE account_id = ?').bind(account.id).all<{ workspace_id: string }>();
    try {
      const closed = await Promise.all(memberships.results.map(({ workspace_id }) => insideJson(c.env, workspace_id, account.id, '/connections/close', {})));
      if (closed.some((result) => !result.ok)) return error('Could not sign out of an open workspace. Try again.', 500);
      const details = await Promise.all(closed.map((result) => result.json<{ connections_targeted: number }>()));
      connectionsTargeted = details.reduce((sum, item) => sum + item.connections_targeted, 0);
    } catch { return error('Could not sign out of an open workspace. Try again.', 500); }
  }
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  c.header('Set-Cookie', clearSessionCookie(new URL(c.req.url).origin));
  return c.json({ ok: true, connections_targeted: connectionsTargeted });
});

app.post('/api/dev/login', async (c) => {
  const host = new URL(c.req.url).hostname;
  if (c.env.DEV_AUTH !== '1' || !['localhost', '127.0.0.1'].includes(host)) return error('Not found.', 404);
  const input = await c.req.json<{ name?: string; email?: string }>();
  const email = String(input.email ?? 'builder@localhost').toLowerCase();
  let account = await c.env.DB.prepare('SELECT * FROM accounts WHERE email = ?').bind(email).first<Account>();
  if (!account) {
    const id = crypto.randomUUID();
    await c.env.DB.prepare('INSERT INTO accounts (id, kind, name, email, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, 'human', String(input.name ?? 'Builder'), email, Date.now()).run();
    account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>();
  }
  if (!account) return error('Could not sign in.', 500);
  c.header('Set-Cookie', sessionCookie(await createSession(c.env, account.id), new URL(c.req.url).origin));
  return c.json({ ok: true });
});

app.post('/api/workspaces', async (c) => {
  const account = await requireHuman(c);
  if (account instanceof Response) return account;
  const input = await readJsonObject(c.req.raw, 1024);
  if (input instanceof Response) return input;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 2 || name.length > 70) return error('Choose a workspace name between 2 and 70 characters.');
  if (!canCreateWorkspace(c.env, account.email)) return error('Workspace creation is invite only.', 403);
  const budget = await reserveRequests(c.env.DB, [{ key: `workspace-create:${account.id}`, maximum: 10, windowMs: 86400000 }]);
  if (!budget.allowed) return c.json({ error: 'Workspace creation limit reached. Try again tomorrow.' }, 429, { 'Retry-After': String(budget.retryAfter) });
  const id = crypto.randomUUID();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'workspace'}-${id.slice(0, 6)}`;
  const channelId = crypto.randomUUID();
  const bootstrap = { member: publicMember(account, 'owner'), channel: { id: channelId, name: 'general' } };
  let initialized = false;
  for (let attempt = 0; attempt < 2 && !initialized; attempt += 1) {
    try {
      const result = await insideJson(c.env, id, account.id, '/bootstrap', bootstrap);
      initialized = result.ok;
    } catch { /* Bootstrap is idempotent, so a lost response can be retried safely. */ }
  }
  if (!initialized) return error('Workspace storage could not be initialized. Try again.', 503);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, slug, name, account.id, Date.now()),
    c.env.DB.prepare('INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (?, ?, ?)').bind(id, account.id, 'owner'),
  ]);
  return c.json({ id, slug, name, channel_id: channelId }, 201);
});

async function acceptInvite(env: Env, account: Account, token: string): Promise<string> {
  const tokenHash = await sha256(token);
  const invite = await env.DB.prepare('SELECT workspace_id, expires_at, uses_left FROM invites WHERE token_hash = ?').bind(tokenHash).first<{ workspace_id: string; expires_at: number; uses_left: number }>();
  if (!invite) throw new Error('This invite link has expired.');
  let existing = await workspaceRole(env, invite.workspace_id, account.id);
  if (!existing) {
    if (invite.expires_at <= Date.now() || invite.uses_left <= 0) throw new Error('This invite link has expired.');
    const claim = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO workspace_members (workspace_id, account_id, role)
        SELECT workspace_id, ?, 'member' FROM invites WHERE token_hash = ? AND expires_at > ? AND uses_left > 0`).bind(account.id, tokenHash, Date.now()),
      env.DB.prepare('UPDATE invites SET uses_left = uses_left - 1 WHERE token_hash = ? AND changes() = 1').bind(tokenHash),
    ]);
    if (claim[0].meta.changes !== 1) {
      existing = await workspaceRole(env, invite.workspace_id, account.id);
      if (!existing) throw new Error('This invite link has expired.');
    }
  }
  const synced = await insideJson(env, invite.workspace_id, account.id, '/members/upsert', publicMember(account, existing?.role ?? 'member'));
  if (!synced.ok) throw new Error('Could not finish joining the workspace. Try your invite link again.');
  const snapshot = await inside(env, invite.workspace_id, account.id, '/snapshot');
  if (!snapshot.ok) throw new Error('Could not finish joining the workspace. Try your invite link again.');
  const data = await snapshot.json<{ channels: Array<{ id: string; name: string }> }>();
  const general = data.channels.find((channel) => channel.name === 'general');
  if (general) {
    const joined = await insideJson(env, invite.workspace_id, account.id, `/channels/${general.id}/join`, {});
    if (!joined.ok) throw new Error('Could not finish joining the general channel. Try your invite link again.');
  }
  return invite.workspace_id;
}

app.post('/api/invites/accept', async (c) => {
  const account = await requireHuman(c);
  if (account instanceof Response) return account;
  const { token } = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) return error('Invalid invite link.');
  try { return c.json({ workspace_id: await acceptInvite(c.env, account, token) }); }
  catch (cause) { return error(cause instanceof Error ? cause.message : 'Invalid invite.'); }
});

app.post('/api/workspaces/:id/invites', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  if (access.role === 'member') return error('Only workspace admins can invite people.', 403);
  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO invites (token_hash, workspace_id, created_by, expires_at, uses_left) VALUES (?, ?, ?, ?, ?)').bind(await sha256(token), c.req.param('id'), access.account.id, Date.now() + 7 * 86400000, 10).run();
  return c.json({ url: `${new URL(c.req.url).origin}/invite/${token}` });
});

app.delete('/api/workspaces/:id/members/:account', async (c) => {
  const workspaceId = c.req.param('id');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  if (access.role === 'member') return error('Only workspace admins can remove people.', 403);
  const targetId = c.req.param('account');
  if (targetId === access.account.id) return error('You cannot remove yourself.');
  const target = await c.env.DB.prepare(`SELECT a.kind, wm.role FROM workspace_members wm
    JOIN accounts a ON a.id = wm.account_id WHERE wm.workspace_id = ? AND wm.account_id = ?`)
    .bind(workspaceId, targetId).first<{ kind: string; role: WorkspaceRole['role'] }>();
  if (!target || target.kind !== 'human') return error('Person not found in this workspace.', 404);
  if (target.role === 'owner' || (access.role === 'admin' && target.role === 'admin')) return error('You cannot remove this person.', 403);

  const ownedAgents = await c.env.DB.prepare(`SELECT a.id FROM accounts a JOIN workspace_members wm ON wm.account_id = a.id
    WHERE wm.workspace_id = ? AND a.kind = 'agent' AND a.owner_id = ?`).bind(workspaceId, targetId).all<{ id: string }>();
  for (const agent of ownedAgents.results) {
    const removed = await insideJson(c.env, workspaceId, access.account.id, '/members/remove', { account_id: agent.id });
    if (!removed.ok) return error('Could not remove this person’s agents. Please try again.', 500);
  }
  const removed = await insideJson(c.env, workspaceId, access.account.id, '/members/remove', { account_id: targetId });
  if (!removed.ok) return error('Could not remove this person. Please try again.', 500);
  const socketResult = await removed.json<{ connections_targeted?: number }>();

  await c.env.DB.batch([
    ...ownedAgents.results.flatMap((agent) => [
      ...revokeStatements(c.env, workspaceId, agent.id),
      c.env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND account_id = ?').bind(workspaceId, agent.id),
    ]),
    c.env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND account_id = ?').bind(workspaceId, targetId),
    c.env.DB.prepare('DELETE FROM invites WHERE workspace_id = ?').bind(workspaceId),
  ]);
  return c.json({ ok: true, agents_removed: ownedAgents.results.length, invite_links_revoked: true, connections_targeted: socketResult.connections_targeted ?? 0 });
});

app.get('/api/workspaces/:id/snapshot', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, '/snapshot');
});

app.get('/api/workspaces/:id/settings', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  if (access.role === 'member') return error('Only workspace admins can manage settings.', 403);
  return inside(c.env, c.req.param('id'), access.account.id, '/settings');
});

app.put('/api/workspaces/:id/settings', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  if (access.role === 'member') return error('Only workspace admins can manage settings.', 403);
  return insideJson(c.env, c.req.param('id'), access.account.id, '/settings', await c.req.json(), 'PUT');
});

app.all('/api/workspaces/:id/collab/*', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  const suffix = new URL(c.req.url).pathname.split('/collab')[1] ?? '';
  if (!/^\/(?:projects(?:\/[a-f0-9-]{36}(?:\/(?:integrations(?:\/[a-f0-9-]{36}(?:\/(?:files|publish))?)?|jobs\/[a-f0-9-]{36}|requirements|handoff|events|runs(?:\/[a-f0-9-]{36}\/(?:branch|execute|cancel|token|checkpoint|candidates|files|tree|source-file))?|candidates\/[a-f0-9-]{36}\/review))?)?|overview|boards(?:\/[a-f0-9-]{36}(?:\/tasks)?)?|tasks(?:\/[a-f0-9-]{36})?|documents(?:\/[a-f0-9-]{36})?)$/.test(suffix)) return error('Not found.', 404);
  const path = `${suffix}${new URL(c.req.url).search}`;
  const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text();
  return inside(c.env, c.req.param('id'), access.account.id, path, { method: c.req.method, headers: { 'content-type': 'application/json' }, body });
});

app.get('/api/workspaces/:id/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return error('WebSocket upgrade required.', 426);
  const ticket = new URL(c.req.url).searchParams.get('ticket');
  if (ticket) {
    if (!/^[a-f0-9]{64}$/.test(ticket)) return error('Invalid live connection.', 401);
    // Only existing workspaces get a Durable Object; random ids must not create storage.
    if (!await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(c.req.param('id')).first()) return error('Invalid live connection.', 401);
    const request = new Request(`https://workspace.internal/socket?ticket=${ticket}`, { headers: { Upgrade: 'websocket', 'x-workspace-id': c.req.param('id') } });
    return stub(c.env, c.req.param('id')).fetch(request);
  }
  if (!checkOrigin(c.req.raw)) return error('Invalid connection origin.', 403);
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  const request = new Request('https://workspace.internal/socket', { headers: { Upgrade: 'websocket', 'x-account-id': access.account.id, 'x-workspace-id': c.req.param('id') } });
  return stub(c.env, c.req.param('id')).fetch(request);
});

app.get('/api/workspaces/:id/channels/:channel/messages', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/channels/${c.req.param('channel')}/messages${new URL(c.req.url).search}`);
});

app.post('/api/workspaces/:id/channels/:channel/messages', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return insideJson(c.env, c.req.param('id'), access.account.id, `/channels/${c.req.param('channel')}/messages`, await c.req.json());
});

app.post('/api/workspaces/:id/channels/:channel/threads/:thread/read', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return insideJson(c.env, c.req.param('id'), access.account.id, `/channels/${c.req.param('channel')}/threads/${c.req.param('thread')}/read`, await c.req.json());
});

app.get('/api/workspaces/:id/channels/:channel/members', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/channels/${c.req.param('channel')}/members`);
});

app.post('/api/workspaces/:id/channels/:channel/members', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return insideJson(c.env, c.req.param('id'), access.account.id, `/channels/${c.req.param('channel')}/members`, await c.req.json());
});

app.delete('/api/workspaces/:id/channels/:channel/members/:member', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/channels/${c.req.param('channel')}/members/${c.req.param('member')}`, { method: 'DELETE' });
});

app.post('/api/workspaces/:id/channels/:channel/mute', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return insideJson(c.env, c.req.param('id'), access.account.id, `/channels/${c.req.param('channel')}/mute`, await c.req.json());
});

app.post('/api/workspaces/:id/channels', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return insideJson(c.env, c.req.param('id'), access.account.id, '/channels', await c.req.json());
});

app.post('/api/workspaces/:id/dms', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return insideJson(c.env, c.req.param('id'), access.account.id, '/dms', await c.req.json());
});

for (const action of ['join', 'leave', 'archive', 'rename', 'read', 'notify'] as const) {
  app.post(`/api/workspaces/:id/channels/:channel/${action}`, async (c) => {
    const access = await requireWorkspace(c, c.req.param('id'));
    if (access instanceof Response) return access;
    return insideJson(c.env, c.req.param('id'), access.account.id, `/channels/${c.req.param('channel')}/${action}`, await c.req.json().catch(() => ({})));
  });
}

for (const action of ['edit', 'delete', 'reactions'] as const) {
  app.post(`/api/workspaces/:id/messages/:message/${action}`, async (c) => {
    const access = await requireWorkspace(c, c.req.param('id'));
    if (access instanceof Response) return access;
    return insideJson(c.env, c.req.param('id'), access.account.id, `/messages/${c.req.param('message')}/${action}`, await c.req.json().catch(() => ({})));
  });
}

app.post('/api/workspaces/:id/agents/:agent/channel-access', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return insideJson(c.env, c.req.param('id'), access.account.id, '/members/channel-access',
    { ...(await c.req.json<{ all_channels: boolean }>()), agent_id: c.req.param('agent') });
});

app.post('/api/workspaces/:id/agents', async (c) => {
  const workspaceId = c.req.param('id');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  const input = await c.req.json<{ name?: string; description?: string }>();
  return c.json(await createNamedAgent(c.env, new URL(c.req.url).origin, workspaceId, access.account.id, String(input.name ?? ''), String(input.description ?? ''), inside), 201);
});

function avatarType(contentType: string): { extension: string; mime: string } | null {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'image/png') return { extension: 'png', mime };
  if (mime === 'image/jpeg') return { extension: 'jpg', mime };
  if (mime === 'image/webp') return { extension: 'webp', mime };
  return null;
}

function validAvatar(bytes: Uint8Array, extension: string): boolean {
  if (extension === 'png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((part, index) => bytes[index] === part);
  if (extension === 'jpg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
}

app.post('/api/workspaces/:id/agents/:agent/avatar', async (c) => {
  const workspaceId = c.req.param('id');
  const agentId = c.req.param('agent');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  const agent = await c.env.DB.prepare(`SELECT a.* FROM accounts a JOIN workspace_members wm ON wm.account_id = a.id
    WHERE wm.workspace_id = ? AND a.id = ? AND a.kind = 'agent'`).bind(workspaceId, agentId).first<Account>();
  if (!agent) return error('Agent not found.', 404);
  if (access.role === 'member' && agent.owner_id !== access.account.id) return error('You cannot manage this agent.', 403);
  const type = avatarType(c.req.header('content-type') ?? '');
  if (!type) return error('Choose a PNG, JPEG, or WebP image.');
  const bytes = await readLimitedBody(c.req.raw.body, 2 * 1024 * 1024);
  if (!bytes) return error('Avatars are limited to 2 MB.', 413);
  if (!validAvatar(bytes, type.extension)) return error('The image file is invalid.');
  const fileId = crypto.randomUUID();
  const filename = `avatar.${type.extension}`;
  const key = `${workspaceId}/${agentId}/${fileId}/${filename}`;
  const avatarUrl = `/api/workspaces/${workspaceId}/agents/${agentId}/avatar/${fileId}.${type.extension}`;
  await putFile(c.env, key, bytes, type.mime);
  try {
    await c.env.DB.prepare('UPDATE accounts SET avatar_url = ? WHERE id = ?').bind(avatarUrl, agentId).run();
    const refreshed = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(agentId).first<Account>();
    if (!refreshed) throw new Error('Agent not found after upload.');
    const synced = await insideJson(c.env, workspaceId, access.account.id, '/members/upsert', publicMember(refreshed, 'member'));
    if (!synced.ok) throw new Error('Could not update the agent profile.');
  } catch (cause) {
    await c.env.DB.prepare('UPDATE accounts SET avatar_url = ? WHERE id = ?').bind(agent.avatar_url, agentId).run();
    await deleteFile(c.env, key);
    return error(cause instanceof Error ? cause.message : 'Avatar upload failed.', 500);
  }
  if (agent.avatar_url?.startsWith(`/api/workspaces/${workspaceId}/agents/${agentId}/avatar/`)) {
    const oldFile = agent.avatar_url.split('/').at(-1)?.match(/^([a-f0-9-]{36})\.(png|jpg|webp)$/);
    if (oldFile) await deleteFile(c.env, `${workspaceId}/${agentId}/${oldFile[1]}/avatar.${oldFile[2]}`).catch(() => {});
  }
  return c.json({ avatar_url: avatarUrl });
});

app.get('/api/workspaces/:id/agents/:agent/avatar/:file', async (c) => {
  const workspaceId = c.req.param('id');
  const agentId = c.req.param('agent');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  const filename = c.req.param('file');
  const matched = filename.match(/^([a-f0-9-]{36})\.(png|jpg|webp)$/);
  if (!matched) return error('Avatar not found.', 404);
  const expectedUrl = `/api/workspaces/${workspaceId}/agents/${agentId}/avatar/${filename}`;
  const agent = await c.env.DB.prepare(`SELECT a.avatar_url FROM accounts a JOIN workspace_members wm ON wm.account_id = a.id
    WHERE wm.workspace_id = ? AND a.id = ? AND a.kind = 'agent'`).bind(workspaceId, agentId).first<{ avatar_url: string | null }>();
  if (agent?.avatar_url !== expectedUrl) return error('Avatar not found.', 404);
  const stream = await getFile(c.env, `${workspaceId}/${agentId}/${matched[1]}/avatar.${matched[2]}`);
  if (!stream) return error('Avatar not found.', 404);
  const mime = matched[2] === 'jpg' ? 'image/jpeg' : `image/${matched[2]}`;
  return new Response(stream, { headers: { 'content-type': mime, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
});

app.get('/api/workspaces/:id/agents/:agent/activity', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/agents/${encodeURIComponent(c.req.param('agent'))}/activity`);
});

app.get('/api/workspaces/:id/agents/:agent/webhook', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/agents/${encodeURIComponent(c.req.param('agent'))}/webhook`);
});

app.put('/api/workspaces/:id/agents/:agent/webhook', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  // Each save holds a delivery gateway connection while the endpoint answers its challenge.
  const budget = await reserveRequests(c.env.DB, [{ key: `webhook-verify:${access.account.id}`, maximum: 20, windowMs: 900000 }]);
  if (!budget.allowed) return c.json({ error: 'Too many webhook verifications. Try again in 15 minutes.' }, 429, { 'Retry-After': String(budget.retryAfter) });
  const input: { url?: unknown; secret?: unknown } = await c.req.json().catch(() => ({}));
  return insideJson(c.env, c.req.param('id'), access.account.id, `/agents/${encodeURIComponent(c.req.param('agent'))}/webhook`, { url: input.url, secret: input.secret }, 'PUT');
});

app.delete('/api/workspaces/:id/agents/:agent/webhook', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/agents/${encodeURIComponent(c.req.param('agent'))}/webhook`, { method: 'DELETE' });
});

app.all('/api/workspaces/:id/agents/:agent/listening/:channel?', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  const channel = c.req.param('channel');
  const path = `/agents/${encodeURIComponent(c.req.param('agent'))}/listening${channel ? `/${encodeURIComponent(channel)}` : ''}`;
  if (c.req.method === 'GET' && !channel) return inside(c.env, c.req.param('id'), access.account.id, path);
  if (c.req.method === 'PUT' && channel) return insideJson(c.env, c.req.param('id'), access.account.id, path, await c.req.json(), 'PUT');
  return error('Not found.', 404);
});

app.all('/api/agent/events/:action?', async (c) => {
  const session = await agentSession(c.env, c.req.raw);
  if (!session || !session.scopes.includes('read')) return error('Agent read access is required.', 401);
  if (!await workspaceRole(c.env, session.workspaceId, session.account.id)) return error('Workspace access was removed.', 403);
  if (c.req.method === 'GET' && !c.req.param('action')) return inside(c.env, session.workspaceId, session.account.id, '/agent-events');
  if (c.req.method === 'POST' && c.req.param('action') === 'ack') return insideJson(c.env, session.workspaceId, session.account.id, '/agent-events/ack', await c.req.json());
  return error('Not found.', 404);
});

app.get('/api/workspaces/:id/event-subscriptions', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  const accountId = c.req.query('account_id');
  return inside(c.env, c.req.param('id'), access.account.id, `/event-subscriptions${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''}`);
});

app.delete('/api/workspaces/:id/event-subscriptions/:subscription', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/event-subscriptions/${encodeURIComponent(c.req.param('subscription'))}`, { method: 'DELETE' });
});

app.post('/api/workspaces/:id/agents/:agent/approval', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  return insideJson(c.env, c.req.param('id'), access.account.id, '/members/approval', { agent_id: c.req.param('agent'), enabled });
});

app.get('/api/workspaces/:id/agents/:agent/pending', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/agents/${encodeURIComponent(c.req.param('agent'))}/pending`);
});

function privateFileHeaders(mime: string, filename: string): HeadersInit {
  const type = mime.toLowerCase().split(';')[0];
  const inline = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', 'text/plain'].includes(type);
  return { 'Content-Type': mime, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/["\\]/g, '')}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Referrer-Policy': 'no-referrer' };
}

app.get('/api/workspaces/:id/agents/:agent/pending/:post/files/:file', async (c) => {
  const workspaceId = c.req.param('id');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  const metadata = await inside(c.env, workspaceId, access.account.id, `/agents/${encodeURIComponent(c.req.param('agent'))}/pending/${encodeURIComponent(c.req.param('post'))}/files/${encodeURIComponent(c.req.param('file'))}`);
  if (!metadata.ok) return metadata;
  const attachment = await metadata.json<{ r2_key: string; mime: string; filename: string }>();
  const body = await getFile(c.env, attachment.r2_key);
  if (!body) return error('File not found.', 404);
  return new Response(body, { headers: privateFileHeaders(attachment.mime, attachment.filename) });
});

app.post('/api/workspaces/:id/agents/:agent/pending/:post', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return insideJson(c.env, c.req.param('id'), access.account.id, `/agents/${encodeURIComponent(c.req.param('agent'))}/pending/${encodeURIComponent(c.req.param('post'))}`, await c.req.json());
});

app.post('/api/workspaces/:id/agents/:agent/pause', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  const { paused } = await c.req.json<{ paused: boolean }>();
  if (typeof paused !== 'boolean') return error('Choose whether the agent is paused.');
  return insideJson(c.env, c.req.param('id'), access.account.id, '/members/pause', { agent_id: c.req.param('agent'), paused });
});

app.post('/api/workspaces/:id/agents/:agent/rotate', async (c) => {
  const workspaceId = c.req.param('id');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  return c.json(await rotateNamedAgentToken(c.env, new URL(c.req.url).origin, workspaceId, c.req.param('agent'), access.account.id, access.role, inside));
});

app.post('/api/workspaces/:id/agents/:agent/revoke', async (c) => {
  const workspaceId = c.req.param('id');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  await requireManagedAgent(c.env, workspaceId, c.req.param('agent'), access.account.id, access.role);
  return c.json({ ok: true, ...(await revokeNamedAgentTokens(c.env, workspaceId, c.req.param('agent'), inside)) });
});

app.delete('/api/workspaces/:id/agents/:agent', async (c) => {
  const workspaceId = c.req.param('id');
  const agentId = c.req.param('agent');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  await requireManagedAgent(c.env, workspaceId, agentId, access.account.id, access.role);
  const removed = await insideJson(c.env, workspaceId, access.account.id, '/members/remove', { account_id: agentId });
  if (!removed.ok) return removed;
  await c.env.DB.batch([...revokeStatements(c.env, workspaceId, agentId), c.env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND account_id = ?').bind(workspaceId, agentId)]);
  return c.json({ ok: true });
});

async function uploadAttachment(c: AppContext, workspaceId: string, channelId: string, accountId: string): Promise<Response> {
  const allowed = await inside(c.env, workspaceId, accountId, `/channels/${channelId}/access`);
  if (!allowed.ok) return allowed;
  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  const name = uploadFilename(c.req.header('x-file-name'));
  const size = Number(c.req.header('content-length') ?? 0);
  if (size > 25 * 1024 * 1024) return error('Files are limited to 25 MB.', 413);
  const bytes = await readLimitedBody(c.req.raw.body, 25 * 1024 * 1024);
  if (!bytes) return error('Files are limited to 25 MB.', 413);
  const id = crypto.randomUUID();
  const key = `${workspaceId}/${channelId}/${id}/${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  await putFile(c.env, key, bytes, contentType);
  const kind = attachmentKind(contentType);
  const registered = await insideJson(c.env, workspaceId, accountId, `/channels/${channelId}/attachments`, { id, kind, r2_key: key, mime: contentType, size: bytes.byteLength, filename: name });
  if (!registered.ok) { await deleteFile(c.env, key); return registered; }
  return c.json({ id, kind, mime: contentType, size: bytes.byteLength, filename: name });
}

app.post('/api/workspaces/:id/channels/:channel/files', async (c) => {
  const workspaceId = c.req.param('id');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  return uploadAttachment(c, workspaceId, c.req.param('channel'), access.account.id);
});

app.get('/api/workspaces/:id/files', async (c) => {
  const workspaceId = c.req.param('id');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  const query = (c.req.query('q') ?? '').trim().slice(0, 80);
  return inside(c.env, workspaceId, access.account.id, `/attachments/library?q=${encodeURIComponent(query)}`);
});

app.post('/api/workspaces/:id/channels/:channel/files/reuse', async (c) => {
  const workspaceId = c.req.param('id');
  const channelId = c.req.param('channel');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  const allowed = await inside(c.env, workspaceId, access.account.id, `/channels/${channelId}/access`);
  if (!allowed.ok) return allowed;
  const input = await c.req.json<{ file_id?: string }>().catch((): { file_id?: string } => ({}));
  if (!input.file_id || !/^[a-f0-9-]{36}$/i.test(input.file_id)) return error('Choose a file.');
  const sourceResponse = await inside(c.env, workspaceId, access.account.id, `/attachments/${input.file_id}`);
  if (!sourceResponse.ok) return sourceResponse;
  const source = await sourceResponse.json<{ r2_key: string; kind: string; mime: string; size: number; filename: string }>();
  const body = await getFile(c.env, source.r2_key);
  if (!body) return error('File not found.', 404);
  const bytes = await readLimitedBody(body, 25 * 1024 * 1024);
  if (!bytes) return error('Files are limited to 25 MB.', 413);
  const id = crypto.randomUUID();
  const key = `${workspaceId}/${channelId}/${id}/${source.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  await putFile(c.env, key, bytes, source.mime);
  const registered = await insideJson(c.env, workspaceId, access.account.id, `/channels/${channelId}/attachments`, { id, kind: source.kind, r2_key: key, mime: source.mime, size: bytes.byteLength, filename: source.filename });
  if (!registered.ok) { await deleteFile(c.env, key); return registered; }
  return c.json({ id, kind: source.kind, mime: source.mime, size: bytes.byteLength, filename: source.filename });
});

app.get('/api/workspaces/:id/gifs/config', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return c.json({ enabled: Boolean(c.env.GIPHY_API_KEY) });
});

app.get('/api/workspaces/:id/gifs/search', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  if (!c.env.GIPHY_API_KEY) return error('GIF search is not available.', 503);
  try {
    const results = await searchGifs(c.env, c.req.query('q') ?? '');
    return c.json(results, 200, { 'Cache-Control': 'private, max-age=60' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'GIF search is temporarily unavailable.';
    return error(message, message.includes('busy') ? 429 : 502);
  }
});

app.post('/api/workspaces/:id/channels/:channel/gifs', async (c) => {
  const workspaceId = c.req.param('id');
  const channelId = c.req.param('channel');
  const access = await requireWorkspace(c, workspaceId);
  if (access instanceof Response) return access;
  const allowed = await inside(c.env, workspaceId, access.account.id, `/channels/${channelId}/access`);
  if (!allowed.ok) return allowed;
  const input = await c.req.json<{ url?: string }>().catch((): { url?: string } => ({}));
  let url: URL;
  try { url = new URL(input.url ?? ''); }
  catch { return error('Choose a direct Tenor GIF link.'); }
  if (url.protocol !== 'https:' || !/^media\.tenor\.com$/i.test(url.hostname)) return error('Choose a direct Tenor GIF link.');
  const response = await fetch(url, { redirect: 'manual' }).catch(() => null);
  if (!response) return error('GIF could not be downloaded.', 502);
  if (!response.ok) return error('GIF could not be downloaded.', 502);
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase();
  if (mime !== 'image/gif') return error('The link must point directly to a GIF.');
  if (Number(response.headers.get('content-length') ?? 0) > 25 * 1024 * 1024) return error('GIFs are limited to 25 MB.', 413);
  const bytes = await readLimitedBody(response.body, 25 * 1024 * 1024);
  if (!bytes) return error('GIFs are limited to 25 MB.', 413);
  const id = crypto.randomUUID();
  const filename = `gif-${id.slice(0, 8)}.gif`;
  const key = `${workspaceId}/${channelId}/${id}/${filename}`;
  await putFile(c.env, key, bytes, mime);
  const registered = await insideJson(c.env, workspaceId, access.account.id, `/channels/${channelId}/attachments`, { id, kind: 'image', r2_key: key, mime, size: bytes.byteLength, filename });
  if (!registered.ok) { await deleteFile(c.env, key); return registered; }
  return c.json({ id, kind: 'image', mime, size: bytes.byteLength, filename });
});

app.post('/api/agent/channels/:channel/files', async (c) => {
  const session = await agentSession(c.env, c.req.raw);
  if (!session) return error('Agent token required.', 401);
  if (!session.scopes.includes('files')) return error('This agent cannot upload files.', 403);
  return uploadAttachment(c, session.workspaceId, c.req.param('channel'), session.account.id);
});

async function downloadAttachment(c: AppContext, workspaceId: string, accountId: string, fileId: string): Promise<Response> {
  const response = await inside(c.env, workspaceId, accountId, `/attachments/${fileId}`);
  if (!response.ok) return response;
  const attachment = await response.json<{ r2_key: string; mime: string; filename: string }>();
  const body = await getFile(c.env, attachment.r2_key);
  if (!body) return error('File not found.', 404);
  return new Response(body, { headers: privateFileHeaders(attachment.mime, attachment.filename) });
}

app.get('/api/file-links/:token', async (c) => {
  const grant = await verifyFileLink(c.env, c.req.param('token'));
  if (!grant) return error('File link expired or invalid.', 404);
  return downloadAttachment(c, grant.workspaceId, grant.accountId, grant.attachmentId);
});

app.get('/api/workspaces/:id/files/:file', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return downloadAttachment(c, c.req.param('id'), access.account.id, c.req.param('file'));
});

app.delete('/api/workspaces/:id/files/:file', async (c) => {
  const access = await requireWorkspace(c, c.req.param('id'));
  if (access instanceof Response) return access;
  return inside(c.env, c.req.param('id'), access.account.id, `/attachments/${c.req.param('file')}`, { method: 'DELETE' });
});

app.get('/api/agent/files/:file', async (c) => {
  const session = await agentSession(c.env, c.req.raw);
  if (!session) return error('Agent token required.', 401);
  if (!session.scopes.includes('files')) return error('This agent cannot read files.', 403);
  const result = await downloadAttachment(c, session.workspaceId, session.account.id, c.req.param('file'));
  if (result.ok) await insideJson(c.env, session.workspaceId, session.account.id, '/agent-activity', { action: 'get_attachment', target_id: c.req.param('file') });
  return result;
});

app.delete('/api/agent/files/:file', async (c) => {
  const session = await agentSession(c.env, c.req.raw);
  if (!session) return error('Agent token required.', 401);
  if (!session.scopes.includes('files')) return error('This agent cannot delete files.', 403);
  return inside(c.env, session.workspaceId, session.account.id, `/attachments/${c.req.param('file')}`, { method: 'DELETE' });
});

app.all('/authorize', async (c) => {
  if (c.req.method === 'POST' && !checkOrigin(c.req.raw)) return error('Invalid request origin.', 403);
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return error('OAuth is unavailable.', 503);
  const human = await humanSession(c.env, c.req.raw);
  if (!human) {
    const next = encodeURIComponent(`/authorize${new URL(c.req.url).search}`);
    const providers = [c.env.GOOGLE_CLIENT_ID && 'google'].filter(Boolean);
    const links = `${c.env.AUTH_EMAIL_ENABLED === '1' ? `<a class="primary" href="/signin?next=${next}">Continue with email <span aria-hidden="true">↗</span></a>` : ''}${providers.map((provider) => `<a class="secondary" href="/api/auth/${provider}/start?next=${next}">Continue with Google</a>`).join('')}`;
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Await</title><link rel="icon" type="image/x-icon" href="/favicon.ico"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/plugin-icon.png"><style>
      :root{color-scheme:light dark;font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:#f8faf7;--surface:#fff;--text:#23392f;--muted:#66776c;--line:#dce6dc;--strong:#254f40}
      @media(prefers-color-scheme:dark){:root{--bg:#141715;--surface:#1d211e;--text:#e8efe9;--muted:#a1afa4;--line:#39443b;--strong:#b9ddc3}}
      *{box-sizing:border-box}body{min-height:100dvh;margin:0;background:var(--bg);color:var(--text)}main{width:min(100% - 36px,420px);margin:min(12vh,88px) auto 32px}.brand{color:var(--text);font-size:19px;font-weight:700;letter-spacing:-.045em;text-decoration:none}.card{margin-top:46px;border:1px solid var(--line);border-radius:18px;padding:30px;background:var(--surface)}h1{margin:0;font-size:27px;font-weight:600;letter-spacing:-.045em}p{margin:10px 0 0;color:var(--muted);font-size:14px;line-height:1.6}.actions{display:grid;gap:10px;margin-top:27px}.actions a{display:flex;align-items:center;justify-content:space-between;min-height:42px;border-radius:9px;padding:9px 12px;font-size:14px;font-weight:600;text-decoration:none}.actions a:focus-visible,.reviewer:focus-visible{outline:2px solid var(--strong);outline-offset:2px}.primary{background:var(--text);color:var(--surface)}.primary:hover{opacity:.86}.secondary{border:1px solid var(--line);color:var(--text)}.secondary:hover{background:var(--bg)}.reviewer{display:inline-block;margin-top:24px;color:var(--muted);font-size:13px;text-decoration:none}.reviewer:hover{text-decoration:underline}@media(max-width:480px){main{margin-top:32px}.card{margin-top:34px;padding:25px}}
    </style></head><body><main><a class="brand" href="/" aria-label="Await home">await</a><section class="card"><h1>Connect your workspace</h1><p>Sign in to choose whether Await connects as you or one of your agents.</p><div class="actions">${links || '<p>Sign-in is being configured.</p>'}</div><a class="reviewer" href="/signin/reviewer?next=${next}">Plugin reviewer access</a></section></main></body></html>`);
  }
  try {
    if (c.req.method === 'GET') {
      const parsed = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(parsed);
      const [agents, workspaces] = await Promise.all([
        c.env.DB.prepare(`SELECT a.id, a.name, w.id AS workspace_id FROM accounts a JOIN workspace_members wm ON wm.account_id = a.id JOIN workspaces w ON w.id = wm.workspace_id JOIN workspace_members owner_membership ON owner_membership.workspace_id = w.id AND owner_membership.account_id = a.owner_id WHERE a.owner_id = ? AND a.kind = 'agent' ORDER BY w.name, a.name`).bind(human.id).all<{ id: string; name: string; workspace_id: string }>(),
        c.env.DB.prepare(`SELECT w.id, w.name, wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.account_id = ? ORDER BY w.name`).bind(human.id).all<{ id: string; name: string; role: string }>(),
      ]);
      const channelGroups = await Promise.all(workspaces.results.map(async (workspace) => {
        const response = await inside(c.env, workspace.id, human.id, '/snapshot');
        if (!response.ok) return { workspace, channels: [] as Array<{ id: string; name: string }> };
        const snapshot = await response.json<{ channels?: Array<{ id: string; name: string; joined: number; is_dm: number }> }>();
        return { workspace, channels: (snapshot.channels ?? []).filter((channel) => channel.joined && !channel.is_dm).map(({ id, name }) => ({ id, name })) };
      }));
      const consent = await oauth.beginConsent(parsed);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      const page = renderConsentPage({ ...details, handle: consent.handle, agents: agents.results, workspaces: workspaces.results, channelGroups });
      return new Response(page, { headers: consent.headers });
    }
    if (c.req.method !== 'POST') return error('Method not allowed.', 405);
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const selectedId = String(form.get('agent_id') ?? '');
    const newName = String(form.get('new_agent_name') ?? '').trim().slice(0, 60) || 'Await agent';
    const selectedWorkspace = String(form.get('workspace_id') ?? '');
    const initialChannelId = String(form.get('initial_channel_id') ?? '');
    const identityMode = String(form.get('identity_mode') ?? 'agent');
    const channelAccess = String(form.get('channel_access') ?? 'current');
    if (!['current', 'all'].includes(channelAccess)) return error('Choose valid channel access.');
    if (identityMode !== 'agent' && channelAccess === 'all') return error('All-channel authorization requires a named agent.');
    if (channelAccess === 'all') {
      const role = await workspaceRole(c.env, selectedWorkspace, human.id);
      if (!role || role.role === 'member') return error('Only workspace owners and admins can grant all-channel access.', 403);
    }
    if (identityMode !== 'agent' && identityMode !== 'human') return error('Choose how to connect.');
    let agent: Account | null = null;
    let workspaceId = '';
    if (identityMode === 'human') {
      const member = await workspaceRole(c.env, selectedWorkspace, human.id);
      if (!member) return error('Choose one of your workspaces.');
      workspaceId = selectedWorkspace;
    } else if (selectedId) {
      agent = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ? AND owner_id = ? AND kind = ?').bind(selectedId, human.id, 'agent').first<Account>();
      const ownerMembership = await workspaceRole(c.env, selectedWorkspace, human.id);
      const agentMembership = agent && await workspaceRole(c.env, selectedWorkspace, agent.id);
      if (!ownerMembership || !agentMembership) return error('Choose an agent in this workspace that you own.');
      workspaceId = selectedWorkspace;
    } else {
      if (newName.length < 2) return error('Enter a new agent name with at least two characters.');
      const member = await workspaceRole(c.env, selectedWorkspace, human.id);
      if (!member) return error('Choose one of your workspaces.');
      workspaceId = selectedWorkspace;
      if (channelAccess !== 'all' && !initialChannelId) return error('Choose a first channel for this agent.');
      const available = await inside(c.env, workspaceId, human.id, '/snapshot');
      if (!available.ok) return error('Choose a channel you can access.');
      const availableChannels = (await available.json<{ channels?: Array<{ id: string; joined: number; is_dm: number }> }>()).channels ?? [];
      if (channelAccess !== 'all' && !availableChannels.some((channel) => channel.id === initialChannelId && channel.joined && !channel.is_dm)) return error('Choose a channel you can access.');
    }
    if (!workspaceId || (identityMode === 'agent' && selectedId && !agent)) return error('Choose an agent you own.');
    const selectedScopes = form.getAll('scope').map(String);
    if (selectedScopes.some((scope) => !['read', 'post', 'files'].includes(scope))) return error('Invalid permission requested.');
    if (!selectedScopes.includes('read')) return error('Reading channels is required for this connection.');
    const approved = await oauth.approveConsent(c.req.raw, handle);
    if (selectedScopes.some((scope) => !approved.request.scope.includes(scope))) return error('This app did not request one of those permissions.');
    if (identityMode === 'agent' && !agent) {
      const id = crypto.randomUUID();
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO accounts (id, kind, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, 'agent', newName, human.id, Date.now()),
        c.env.DB.prepare('INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (?, ?, ?)').bind(workspaceId, id, 'member'),
      ]);
      agent = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>();
      if (!agent) throw new Error('Could not create agent.');
      const added = await insideJson(c.env, workspaceId, human.id, '/members/upsert', publicMember(agent, 'member'));
      if (!added.ok) throw new Error('Could not add the agent to the workspace.');
      if (channelAccess !== 'all') {
        const joined = await insideJson(c.env, workspaceId, human.id, `/channels/${encodeURIComponent(initialChannelId)}/members`, { agent_id: agent.id });
        if (!joined.ok) throw new Error('Could not add the agent to its first channel.');
      }
    }
    if (channelAccess === 'all' && agent) {
      const granted = await insideJson(c.env, workspaceId, human.id, '/members/channel-access', { agent_id: agent.id, all_channels: true });
      if (!granted.ok) throw new Error('Could not grant all-channel access.');
    }
    const connectedAccount = identityMode === 'human' ? human : agent;
    if (!connectedAccount) throw new Error('Could not connect this identity.');
    const complete = await oauth.completeAuthorization({ request: { ...approved.request, scope: selectedScopes }, userId: human.id, metadata: { account_id: connectedAccount.id, workspace_id: workspaceId, kind: identityMode }, scope: selectedScopes, revokeExistingGrants: false,
      props: { account_id: connectedAccount.id, kind: identityMode, workspace_id: workspaceId, auth_version: connectedAccount.auth_version } });
    approved.headers.set('Location', complete.redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (cause) {
    if (cause instanceof AuthorizationError && cause.redirectTo) return Response.redirect(cause.redirectTo, 302);
    if (cause instanceof AuthorizationError || cause instanceof CimdFetchError) return new Response(cause instanceof AuthorizationError ? cause.description : 'This app could not be verified.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    throw cause;
  }
});

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  const appRoute = path === '/signin' || path === '/signin/verify' || /^\/invite\/[^/]+$/.test(path) || /^\/w\/[^/]+(?:\/[^/]+)?$/.test(path);
  if (c.req.method === 'GET' && appRoute && c.env.ASSETS) {
    return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url), { headers: { accept: 'text/html' } }));
  }
  return error('Not found.', 404);
});
app.onError((cause) => {
  if (cause instanceof HttpError) return error(cause.message, cause.status);
  if (cause instanceof SyntaxError) return error('Send a valid JSON body.', 400);
  console.error(cause);
  return error('Unexpected server error.', 500);
});

type AwaitGrant = { account_id?: string; agent_id?: string; kind?: 'human' | 'agent'; workspace_id: string; auth_version: number };

function oauthProvider(origin: string): OAuthProvider<Env> { return new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: {
    async fetch(request, env, ctx) {
      const grant = ctx.props as AwaitGrant | undefined;
      const accountId = grant?.account_id ?? grant?.agent_id;
      const kind = grant?.kind ?? 'agent';
      if (!accountId || !grant?.workspace_id || !['human', 'agent'].includes(kind)) return error('Invalid Await grant.', 401);
      const account = await env.DB.prepare('SELECT id, kind, auth_version FROM accounts WHERE id = ?').bind(accountId).first<{ id: string; kind: string; auth_version: number }>();
      const membership = await workspaceRole(env, grant.workspace_id, accountId);
      if (!account || account.kind !== kind || account.auth_version !== grant.auth_version || !membership) return error('Await access has been revoked.', 401);
      const scopes = (ctx as ExecutionContext<AwaitGrant> & { auth?: { scope: string[] } }).auth?.scope ?? [];
      if (!scopes.includes('read')) return error('Reading channels is required.', 403);
      return handleMcp(env, request, inside, { accountId, workspaceId: grant.workspace_id, scopes, getEventAuthority: async () => {
        const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
        if (!token || !env.OAUTH_PROVIDER) return undefined;
        const summary = await env.OAUTH_PROVIDER.unwrapToken(token);
        if (!summary || !summary.scope.includes('read')) return undefined;
        return { accountId, workspaceId: grant.workspace_id, authVersion: account.auth_version,
          credential: { kind: 'oauth', userId: summary.userId, grantId: summary.grantId } };
      } }, ctx);
    },
  },
  defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['read', 'post', 'files'],
  requiredScopes: ['read'],
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Await Chat' },
}); }

export { Workspace };
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/mcp' && /^Bearer\s+awc_/i.test(request.headers.get('authorization') ?? '')) {
      const session = await agentSession(env, request);
      if (!session) return new Response('Agent token required.', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="await.chat"' } });
      return handleMcp(env, request, inside, { accountId: session.account.id, workspaceId: session.workspaceId, scopes: session.scopes, eventAuthority: session.eventAuthority }, ctx);
    }
    return oauthProvider(new URL(request.url).origin).fetch(request, env, ctx);
  },
};
