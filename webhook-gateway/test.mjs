import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { destinationUrl, forward, isPublicAddress, validateDelivery } from './forward.mjs';

const delivery = () => ({ url: 'https://receiver.example.com/callback', body: '{"hello":"world"}', headers: {
  'content-type': 'application/json', 'webhook-id': 'evt_1', 'webhook-timestamp': '123', 'webhook-signature': 'v1,signature', 'x-mcp-subscription-id': 'sub_1',
} });

test('rejects non-public IPv4, IPv6 and IPv4-mapped addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.2.1', '::', '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '::ffff:127.0.0.1', 'bad-address']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('rejects URL tricks and header injection', () => {
  for (const url of ['http://receiver.example.com', 'https://user:pass@receiver.example.com', 'https://receiver.example.com:8443', 'https://receiver.example.com/#secret', 'https://127.1/', 'https://0x7f000001/', 'https://[::1]/', 'https://localhost./', 'https://example.internal/']) assert.throws(() => destinationUrl(url), undefined, url);
  assert.throws(() => validateDelivery({ ...delivery(), headers: { ...delivery().headers, authorization: 'secret' } }));
  assert.throws(() => validateDelivery({ ...delivery(), headers: { ...delivery().headers, 'webhook-id': 'one\r\nInjected: header' } }));
  assert.throws(() => validateDelivery({ ...delivery(), body: 'x'.repeat(262145) }));
});

test('rejects private DNS and mixed public/private answers before connecting', async () => {
  let connected = false;
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    await assert.rejects(forward(delivery(), { resolve: async () => addresses, httpsRequest: () => { connected = true; } }), /invalid_destination/);
  }
  assert.equal(connected, false);
});

test('pins DNS, preserves TLS identity and body, and does not follow redirects', async () => {
  let calls = 0;
  const input = delivery();
  const result = await forward(input, { resolve: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: (options, responseCallback) => {
    calls += 1;
    assert.equal(options.hostname, 'receiver.example.com');
    assert.equal(options.servername, 'receiver.example.com');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    options.lookup(options.hostname, {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    options.lookup(options.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => {
      assert.equal(body, input.body);
      queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 302; res.headers = { location: 'https://127.0.0.1/' }; responseCallback(res); res.emit('data', Buffer.from('redirect')); res.emit('end'); });
    };
    return req;
  } });
  assert.deepEqual(result, { status: 302, body: 'redirect' });
  assert.equal(calls, 1);
});
