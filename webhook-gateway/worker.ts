import { WorkerEntrypoint } from 'cloudflare:workers';
import { Container } from '@cloudflare/containers';

interface Env {
  WEBHOOK_CONTAINER: DurableObjectNamespace<WebhookContainer>;
  MCP_WEBHOOK_GATEWAY_TOKEN: string;
}

export class WebhookContainer extends Container<Env> {
  defaultPort = 8789;
  sleepAfter = '1m';
  envVars = { AWAIT_WEBHOOK_GATEWAY_TOKEN: this.env.MCP_WEBHOOK_GATEWAY_TOKEN };
}

// Only an explicitly configured service binding can call this entrypoint.
// The public Worker endpoint below never exposes the forwarding service.
export class WebhookGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/deliver') return new Response('Not found', { status: 404 });
    return this.env.WEBHOOK_CONTAINER.getByName('mcp-events').fetch(request);
  }
}

export default { fetch: () => new Response('Not found', { status: 404 }) };
