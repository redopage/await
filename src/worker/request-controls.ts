import { readLimitedBody } from './limited-body';

export async function readJsonObject(request: Request, maximum = 8192): Promise<Record<string, unknown> | Response> {
  const bytes = await readLimitedBody(request.body, maximum);
  if (!bytes) return Response.json({ error: 'Request is too large.' }, { status: 413 });
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Malformed JSON is a client error. */ }
  return Response.json({ error: 'Send a JSON object.' }, { status: 400 });
}

type RequestBudget = { key: string; maximum: number; windowMs: number };

// Each UPSERT reserves an attempt atomically. Keep failed sends in the budget,
// and saturate denied counters so repeated abuse cannot grow them indefinitely.
export async function reserveRequests(db: D1Database, budgets: RequestBudget[], now = Date.now()): Promise<{ allowed: boolean; retryAfter: number }> {
  const results = await db.batch<{ used: number; expires_at: number }>([
    db.prepare('DELETE FROM request_limits WHERE expires_at <= ?').bind(now),
    ...budgets.map(({ key, maximum, windowMs }) => db.prepare(`INSERT INTO request_limits (key, used, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET used = min(request_limits.used + 1, ?)
      RETURNING used, expires_at`).bind(key, now + windowMs, maximum + 1)),
  ]);
  const denied = budgets.flatMap((budget, index) => {
    const row = results[index + 1].results[0];
    if (!row) throw new Error('Could not reserve request budget.');
    return row.used > budget.maximum ? [Math.max(1, Math.ceil((row.expires_at - now) / 1000))] : [];
  });
  return { allowed: denied.length === 0, retryAfter: denied.length ? Math.max(...denied) : 0 };
}
