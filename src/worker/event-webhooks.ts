import type { Env } from './env';
import { publicHttpsUrl } from '../shared/urls';
import { sameSecret } from '../shared/http';

// The transport every Await webhook shares: MCP Events watches and agent inbox webhooks are
// signed with Standard Webhooks, prove their endpoint with a challenge, retry on one schedule,
// and leave the Durable Object only through the delivery gateway.
const encoder = new TextEncoder();
export class EventError extends Error {
  constructor(public code: number, message: string, public reason?: string) { super(message); }
}

export function eventsEnabled(env: Env): boolean {
  if (!(env.MCP_WEBHOOK_GATEWAY || env.MCP_WEBHOOK_GATEWAY_URL) || (env.MCP_WEBHOOK_GATEWAY_TOKEN?.length ?? 0) < 32) return false;
  try { return unbase64(env.MCP_EVENT_KEY ?? '').length === 32; }
  catch { return false; }
}

export function callbackUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new EventError(-32602, 'Use a public HTTPS callback URL.');
  const url = publicHttpsUrl(value);
  if (!url) throw new EventError(-32602, 'Use a public HTTPS callback URL without credentials, a fragment, or a custom port.');
  return url;
}

function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
function secretBytes(secret: unknown): Uint8Array {
  try {
    if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error();
    const bytes = unbase64(secret.slice(6));
    if (bytes.length < 24 || bytes.length > 64 || base64(bytes) !== secret.slice(6)) throw new Error();
    return bytes;
  } catch { throw new EventError(-32602, 'Use a whsec_ signing secret containing a base64-encoded key of 24 to 64 bytes.'); }
}
export function validateSigningSecret(secret: unknown): asserts secret is string { secretBytes(secret); }

async function encryptionKey(env: Env): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try { bytes = unbase64(env.MCP_EVENT_KEY ?? ''); } catch { throw new EventError(-32014, 'Event secret encryption is not configured.'); }
  if (bytes.length !== 32) throw new EventError(-32014, 'Event secret encryption is not configured.');
  return crypto.subtle.importKey('raw', bytes as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(env: Env, subscriptionId: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(subscriptionId) }, await encryptionKey(env), encoder.encode(secret));
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
export async function decryptSecret(env: Env, subscriptionId: string, value: string): Promise<string> {
  const [iv, data] = value.split('.');
  for (const key of [env.MCP_EVENT_KEY, env.MCP_EVENT_PREVIOUS_KEY].filter(Boolean)) {
    try {
      const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv) as Uint8Array<ArrayBuffer>, additionalData: encoder.encode(subscriptionId) }, await encryptionKey({ ...env, MCP_EVENT_KEY: key }), unbase64(data) as Uint8Array<ArrayBuffer>);
      return new TextDecoder().decode(bytes);
    } catch { /* Keep old watches readable during an encryption-key rotation. */ }
  }
  throw new EventError(-32014, 'The subscription signing key could not be decrypted.', 'key_unavailable');
}

export async function signWebhook(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secretBytes(secret) as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${timestamp}.${body}`));
  return `v1,${base64(new Uint8Array(signature))}`;
}

export type WebhookReply = { status: number; body: string };
export async function sendWebhook(env: Env, destination: string, subscriptionId: string, id: string, body: string, secrets: string[], stillAllowed: () => boolean = () => true): Promise<WebhookReply> {
  if (!eventsEnabled(env)) throw new EventError(-32014, 'MCP Events delivery is not configured.', 'gateway_unavailable');
  if (encoder.encode(body).length > 262144) throw new EventError(-32602, 'Event payload exceeds 256 KiB.');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatures = await Promise.all(secrets.map((secret) => signWebhook(secret, id, timestamp, body)));
  if (!stillAllowed()) throw new EventError(-32012, 'The subscription is no longer active.');
  // The gateway resolves, rejects non-public addresses and pins the TLS connection.
  // No signing secret or Await credential is sent to the callback destination.
  let response: Response;
  try {
    const request = new Request(env.MCP_WEBHOOK_GATEWAY ? 'https://gateway.internal/deliver' : env.MCP_WEBHOOK_GATEWAY_URL!, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: { authorization: `Bearer ${env.MCP_WEBHOOK_GATEWAY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: callbackUrl(destination), body, headers: { 'content-type': 'application/json', 'webhook-id': id,
        'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '), 'x-mcp-subscription-id': subscriptionId } }) });
    response = env.MCP_WEBHOOK_GATEWAY ? await env.MCP_WEBHOOK_GATEWAY.fetch(request) : await fetch(request);
  // The gateway answers within ten seconds, whatever the endpoint does, so silence is its own failure.
  } catch { throw new EventError(-32015, 'The callback gateway did not answer.', 'gateway_unavailable'); }
  if (!response.ok) { await response.body?.cancel(); throw new EventError(-32015, 'The callback gateway rejected delivery.', response.status === 400 ? 'invalid_destination' : 'gateway_unavailable'); }
  const result = await response.json<{ status?: number; body?: string; reason?: string }>();
  if (result.reason) throw new EventError(-32015, 'The callback endpoint could not be reached.', result.reason);
  if (!Number.isInteger(result.status) || result.status! < 100 || result.status! > 599 || typeof result.body !== 'string' || result.body.length > 16384) throw new EventError(-32015, 'Invalid callback gateway response.', 'gateway_unavailable');
  return result as WebhookReply;
}

// Proves the endpoint holds the signing secret: it must echo a signed random challenge.
export async function verifyCallback(env: Env, destination: string, subscriptionId: string, secret: string): Promise<void> {
  const challenge = crypto.randomUUID();
  const reply = await sendWebhook(env, destination, subscriptionId, `verification_${crypto.randomUUID()}`, JSON.stringify({ type: 'verification', challenge }), [secret]);
  let echoed: unknown;
  try { echoed = JSON.parse(reply.body).challenge; } catch { /* Verification must return JSON. */ }
  if (reply.status < 200 || reply.status >= 300 || !sameSecret(typeof echoed === 'string' ? echoed : null, challenge)) throw new EventError(-32015, 'Callback verification failed.', 'challenge_failed');
}

const RETRY_DELAYS = [5000, 30000, 120000, 600000, 1800000, 3600000, 10800000];

// What to do after an attempt: 2xx accepts, 410 means the endpoint is gone, transient failures
// back off until the delays run out, and anything else stops delivery visibly. Await's own
// failures never spend the receiver's retries: an unavailable gateway keeps retrying at the
// longest delay, and a signing key Await can no longer read stops at once.
export function deliveryVerdict(status: number, reason: string, attempts: number): 'accepted' | 'gone' | 'retry' | 'stop' {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 410) return 'gone';
  if (reason === 'gateway_unavailable') return 'retry';
  const transient = reason !== 'invalid_destination' && reason !== 'key_unavailable' && (status === 0 || status === 408 || status === 429 || status >= 500);
  return transient && attempts < RETRY_DELAYS.length ? 'retry' : 'stop';
}

export function retryDelay(attempts: number): number {
  return RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length - 1)] + Math.floor(Math.random() * 1000);
}

// A failed attempt as people read it: the gateway's reason codes become sentences, and HTTP
// statuses and other failures already are.
const problems: Record<string, string> = {
  connection_failed: 'The endpoint could not be reached.',
  invalid_destination: 'The endpoint address is not allowed.',
  gateway_unavailable: 'Await could not reach its delivery gateway.',
  key_unavailable: 'Await can no longer read the signing key.',
};
export function deliveryProblem(reason: string): string {
  return problems[reason] ?? reason;
}
