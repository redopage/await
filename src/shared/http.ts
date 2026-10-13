// One JSON response shape for the Worker, the Durable Objects and the hosted services.
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function failure(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `${what} not found.`);
}

export function forbidden(message: string): HttpError {
  return new HttpError(403, message);
}

// Constant-time comparison for shared secrets and bearer headers.
export function sameSecret(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const a = new TextEncoder().encode(presented), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
