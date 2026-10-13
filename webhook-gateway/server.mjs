import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DestinationError, forward } from './forward.mjs';

const token = process.env.AWAIT_WEBHOOK_GATEWAY_TOKEN;
if (!token || token.length < 32) throw new Error('Set AWAIT_WEBHOOK_GATEWAY_TOKEN to at least 32 characters.');
let running = 0;
const server = createServer(async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const received = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) { reply(401, { reason: 'unauthorized' }); req.resume(); return; }
  if (req.method !== 'POST' || req.url !== '/deliver') { reply(404, { reason: 'not_found' }); req.resume(); return; }
  if (running >= 32) { reply(503, { reason: 'busy' }); req.resume(); return; }
  running += 1;
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { reply(413, { reason: 'payload_too_large' }); return; }
      chunks.push(chunk);
    }
    const delivery = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    reply(200, await forward(delivery));
  } catch (error) {
    reply(error instanceof DestinationError || error instanceof SyntaxError ? 400 : 200,
      { reason: error instanceof DestinationError ? error.message : 'connection_failed' });
  } finally { running -= 1; }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT ?? 8789), '0.0.0.0');
