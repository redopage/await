import { sameSecret } from '../src/shared/http';

interface Env {
  EMAIL: SendEmail;
  EMAIL_GATEWAY_SECRET: string;
  EMAIL_FROM?: string;
}

type Outgoing = { to: string; from: string; subject: string; html: string; text: string };

function validMessage(value: unknown, from: string): value is Outgoing {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Outgoing>;
  return typeof message.to === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to)
    && message.from === from
    && typeof message.subject === 'string' && message.subject.length > 0 && message.subject.length <= 180
    && typeof message.html === 'string' && message.html.length <= 16000
    && typeof message.text === 'string' && message.text.length <= 16000;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
    if (url.pathname !== '/send' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (!sameSecret(request.headers.get('authorization'), env.EMAIL_GATEWAY_SECRET && `Bearer ${env.EMAIL_GATEWAY_SECRET}`)) return new Response('Unauthorized', { status: 401 });
    if (Number(request.headers.get('content-length') ?? 0) > 32000) return new Response('Too large', { status: 413 });
    let message: unknown;
    try { message = await request.json(); }
    catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!validMessage(message, env.EMAIL_FROM || 'notifications@mail.awaitchat.com')) return new Response('Invalid email', { status: 400 });
    try {
      const result = await env.EMAIL.send(message);
      return Response.json({ messageId: result.messageId });
    } catch (error) {
      console.error('Email delivery failed', error);
      return new Response('Email delivery failed', { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
