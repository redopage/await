import type { Env } from './env';

type FileGrant = { workspaceId: string; accountId: string; attachmentId: string; expiresAt: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function signingKey(env: Env): Promise<CryptoKey> {
  const secret = env.FILE_LINK_SECRET;
  if (!secret || secret.length < 32) throw new Error('Private file links are not configured.');
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, key);
  }
  return key;
}

export async function createFileLink(env: Env, origin: string, workspaceId: string, accountId: string, attachmentId: string): Promise<string> {
  const grant: FileGrant = { workspaceId, accountId, attachmentId, expiresAt: Date.now() + 90_000 };
  const payload = encode(encoder.encode(JSON.stringify(grant)));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload))));
  return `${origin}/api/file-links/${payload}.${signature}`;
}

export async function verifyFileLink(env: Env, token: string): Promise<FileGrant | null> {
  const [payload, signature, extra] = token.split('.');
  if (extra || !payload || !signature || payload.length > 500 || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await signingKey(env), new Uint8Array(decode(signature)), encoder.encode(payload));
    if (!valid) return null;
    const grant = JSON.parse(decoder.decode(decode(payload))) as Partial<FileGrant>;
    if (!grant || !idPattern.test(grant.workspaceId ?? '') || !idPattern.test(grant.accountId ?? '') || !idPattern.test(grant.attachmentId ?? '') ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt! <= Date.now() || grant.expiresAt! > Date.now() + 90_000) return null;
    return grant as FileGrant;
  } catch { return null; }
}
