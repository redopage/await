import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';

export class DestinationError extends Error {}

export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}

export function destinationUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new DestinationError('invalid_destination');
  let url;
  try { url = new URL(value); } catch { throw new DestinationError('invalid_destination'); }
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || !host.includes('.') || ipaddr.isValid(host) || host.includes(':') || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw new DestinationError('invalid_destination');
  return url;
}

const allowedHeaders = new Set(['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id']);
export function validateDelivery(input) {
  if (!input || typeof input !== 'object') throw new DestinationError('invalid_request');
  const url = destinationUrl(input.url);
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > 262144) throw new DestinationError('payload_too_large');
  if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)) throw new DestinationError('invalid_headers');
  for (const [key, value] of Object.entries(input.headers)) {
    if (!allowedHeaders.has(key) || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw new DestinationError('invalid_headers');
  }
  if (input.headers['content-type'] !== 'application/json' || !input.headers['webhook-id'] || !input.headers['webhook-timestamp'] || !input.headers['webhook-signature'] || !input.headers['x-mcp-subscription-id']) throw new DestinationError('invalid_headers');
  return url;
}

// Dependency injection is only a test seam. The production server always uses
// system DNS and Node's HTTPS client. Every delivery gets a new pinned connection.
export async function forward(input, { resolve = lookup, httpsRequest = request } = {}) {
  const url = validateDelivery(input);
  let timer;
  let addresses;
  try {
    addresses = await Promise.race([resolve(url.hostname, { all: true, verbatim: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 2000); })]);
  } finally { clearTimeout(timer); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(({ address, family }) => ![4, 6].includes(family) || !isPublicAddress(address))) throw new DestinationError('invalid_destination');
  const selected = addresses[0];
  return new Promise((resolveReply, reject) => {
    let settled = false;
    const finish = (error, reply) => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(error) : resolveReply(reply); };
    // Preserve Host and SNI, validate the certificate for the original hostname,
    // and supply only the already-validated IP to DNS lookup. Never use a pool.
    const req = httpsRequest({ protocol: 'https:', hostname: url.hostname, servername: url.hostname, port: 443,
      method: 'POST', path: `${url.pathname}${url.search}`, agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
      lookup: (_host, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      headers: { ...input.headers, host: url.host, 'content-length': String(Buffer.byteLength(input.body, 'utf8')), 'user-agent': 'Await-MCP-Events/1', 'accept-encoding': 'identity' },
    }, (response) => {
      let total = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > 16384) { finish(new Error('Callback response exceeds limit')); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('error', (error) => finish(error));
      response.on('end', () => finish(null, { status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      // Node https.request never follows a Location header. A redirect is returned
      // as a failed callback response, and no second destination is contacted.
    });
    const deadline = setTimeout(() => { finish(new Error('Callback timeout')); req.destroy(); }, 8000);
    req.on('error', (error) => finish(error));
    req.end(input.body);
  });
}
