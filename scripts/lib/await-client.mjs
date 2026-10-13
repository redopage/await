// Minimal Await client for a named agent: MCP tools/call over HTTP, the durable
// event inbox, and the ticket-authenticated live WebSocket.
//
// It depends only on fetch and WebSocket, so the same module runs in Node 20+
// (pass the `ws` package as `WebSocket` where the global is missing) and in a
// Cloudflare Worker. No Node built-ins are imported here.

export const defaultOrigin = 'https://await.chat';

export class AwaitError extends Error {
  constructor(message, { status, code, tool, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AwaitError';
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
    if (tool !== undefined) this.tool = tool;
  }
}

const textOf = (result) => result?.content?.find?.((block) => block?.type === 'text')?.text ?? '';

function unwrap(result) {
  const text = textOf(result);
  if (text) { try { return JSON.parse(text); } catch { return text; } }
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured) && Object.keys(structured).length === 1 && 'result' in structured) return structured.result;
  return structured ?? null;
}

function errorDetail(value) {
  if (!value || typeof value !== 'object') return '';
  if (value.error?.message) return String(value.error.message);
  if (value.result?.isError) return textOf(value.result);
  if (typeof value.error === 'string') return value.error;
  return '';
}

// Accept { events }, a bare array, or a wrapped result and always return
// { events: [...] } where every event carries eventId and data.
export function normalizeInbox(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.events) ? value.events : Array.isArray(value?.result?.events) ? value.result.events : [];
  const events = list.filter((event) => event && typeof event === 'object').map((event) => {
    const eventId = event.eventId ?? event.event_id ?? event.id;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    return { ...event, ...(eventId === undefined ? {} : { eventId: String(eventId) }), data };
  });
  const rest = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { ...rest, events };
}

export function createAwaitClient({ origin = defaultOrigin, token, fetch: fetchImpl, WebSocket: WebSocketImpl = globalThis.WebSocket, timeoutMs = 30000 } = {}) {
  if (typeof token !== 'string' || !token) throw new AwaitError('An Await agent token is required.');
  const base = new URL(origin);
  if (!/^https?:$/.test(base.protocol)) throw new AwaitError('Invalid Await origin.');
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  if (typeof doFetch !== 'function') throw new AwaitError('A fetch implementation is required.');
  const root = base.origin;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let nextId = 1;

  async function request(path, { method = 'GET', body, timeout = timeoutMs } = {}) {
    let response;
    try {
      response = await doFetch(`${root}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      throw new AwaitError(`Await request failed: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message || 'network error'}.`, { cause: error });
    }
    const text = await response.text();
    let value = null;
    if (text) { try { value = JSON.parse(text); } catch { value = null; } }
    if (!response.ok) {
      const detail = errorDetail(value);
      throw new AwaitError(`Await request failed (${response.status})${detail ? `: ${detail}` : '.'}`, { status: response.status, code: value?.error?.code });
    }
    return value;
  }

  // MCP tools/call. Returns the tool's JSON result and throws AwaitError on failure.
  async function call(name, args = {}, { timeout } = {}) {
    const value = await request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args ?? {} } }, timeout });
    if (value?.error) throw new AwaitError(`Await tool ${name} failed: ${value.error.message ?? 'unknown error'}`, { code: value.error.code, tool: name });
    const result = value?.result;
    if (!result || typeof result !== 'object') throw new AwaitError(`Await tool ${name} returned no result.`, { tool: name });
    if (result.isError) throw new AwaitError(`Await tool ${name} failed: ${textOf(result) || 'unknown error'}`, { tool: name });
    return unwrap(result);
  }

  const context = () => call('get_agent_context', {});

  // Pending inbox events through wait_for_events. With timeout_ms the server holds
  // the request until an event is queued or the wait expires.
  async function inbox({ timeout_ms = 0, limit = 50 } = {}) {
    // The server validates integer ranges: timeout_ms 0 to 25000 and limit 1 to 50.
    const toolArgs = { timeout_ms: Math.min(25000, Math.round(Math.max(0, Number(timeout_ms) || 0))), limit: Math.min(50, Math.max(1, Math.round(Number(limit) || 50))) };
    return normalizeInbox(await call('wait_for_events', toolArgs, { timeout: timeoutMs + toolArgs.timeout_ms }));
  }

  // Acknowledge handled events through ack_events. `error` is only sent with a
  // failed outcome.
  async function ack(ids, outcome = 'completed', error) {
    const eventIds = (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string' && id);
    if (!['completed', 'failed'].includes(outcome)) throw new AwaitError('Choose a completed or failed outcome.');
    if (!eventIds.length) return { ok: true, event_ids: [] };
    const detail = outcome === 'failed' && typeof error === 'string' && error ? { error: error.slice(0, 300) } : {};
    const value = await call('ack_events', { event_ids: eventIds, outcome, ...detail });
    return value && typeof value === 'object' ? value : { ok: true, event_ids: eventIds };
  }

  // Live push signals. Fetches a one-use ticket, opens the workspace socket,
  // keeps it alive with application pings, and reconnects with backoff.
  function openLive(onEvent, { onOpen, onClose, onError, pingMs = 20000, backoffMs = 5000, maxBackoffMs = 60000, workspaceId } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new AwaitError('No WebSocket implementation is available. Pass WebSocket to createAwaitClient.');
    if (typeof onEvent !== 'function') throw new AwaitError('openLive needs an onEvent function.');
    let socket = null, timer = null, ping = null, attempts = 0, closed = false;
    const report = (error) => { try { onError?.(error); } catch { /* Listener errors never break the connection loop. */ } };
    const schedule = () => {
      if (closed || timer) return;
      const delay = Math.min(maxBackoffMs, backoffMs * 2 ** Math.min(attempts, 8)) * (0.75 + Math.random() * 0.5);
      attempts++;
      timer = setTimeout(() => { timer = null; void connect(); }, delay);
    };
    const dropped = (current, detail) => {
      if (current !== socket) return;
      socket = null; clearInterval(ping); ping = null;
      try { onClose?.(detail); } catch (error) { report(error); }
      schedule();
    };
    const connect = async () => {
      if (closed) return;
      try {
        const ticket = await call('get_live_ticket', {});
        const id = workspaceId ?? ticket?.workspace_id ?? (await context()).workspace_id;
        if (!id || !ticket?.ticket) throw new AwaitError('Await did not return a live ticket.');
        const url = new URL(`/api/workspaces/${encodeURIComponent(id)}/ws`, root);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('ticket', ticket.ticket);
        if (closed) return;
        const current = new WebSocketImpl(url.toString());
        socket = current;
        let alive = true;
        current.addEventListener('open', () => {
          if (current !== socket) return;
          attempts = 0;
          clearInterval(ping);
          ping = setInterval(() => {
            if (alive) { alive = false; try { current.send('ping'); } catch { /* close follows */ } return; }
            // No pong since the last ping: drop the socket and reconnect.
            try { typeof current.terminate === 'function' ? current.terminate() : current.close(); } catch { /* already closed */ }
            // Some implementations only emit close after a handshake; do not wait on a dead peer.
            setTimeout(() => dropped(current, { code: 4000, reason: 'ping timeout' }), 5000)?.unref?.();
          }, pingMs);
          try { onOpen?.(); } catch (error) { report(error); }
        });
        current.addEventListener('message', (message) => {
          alive = true;
          const text = typeof message?.data === 'string' ? message.data : '';
          if (!text || text === 'pong') return;
          let frame;
          try { frame = JSON.parse(text); } catch { return; }
          try { onEvent(frame); } catch (error) { report(error); }
        });
        current.addEventListener('error', () => { /* The close event follows and schedules a reconnect. */ });
        current.addEventListener('close', (event) => dropped(current, { code: event?.code, reason: event?.reason }));
      } catch (error) { report(error); schedule(); }
    };
    void connect();
    return {
      close() { closed = true; clearTimeout(timer); timer = null; clearInterval(ping); ping = null; const current = socket; socket = null; try { current?.close(); } catch { /* already closed */ } },
      get connected() { return socket?.readyState === 1; },
    };
  }

  return { origin: root, request, call, context, inbox, ack, openLive };
}
