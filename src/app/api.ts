export class ApiError extends Error { constructor(message: string, public status: number, public current?: unknown) { super(message); } }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body && !(init.body instanceof Blob) && !(init.body instanceof ArrayBuffer) ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({})) as { error?: string; current?: unknown };
  if (!response.ok) throw new ApiError(data.error ?? 'The request failed.', response.status, data.current);
  return data as T;
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new Event('await:navigate'));
}
