import type { Env } from './env';

export async function putFile(env: Env, key: string, bytes: Uint8Array, mime: string): Promise<void> {
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
}

export async function getFile(env: Env, key: string): Promise<ReadableStream | null> {
  return (await env.FILES.get(key))?.body ?? null;
}

export async function deleteFile(env: Env, key: string): Promise<void> {
  await env.FILES.delete(key);
}
