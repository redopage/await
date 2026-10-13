export const modernProtocol = '2026-07-28';
export const legacyProtocol = '2025-06-18';
export class ProtocolError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

export function requestProtocol(request: Request, input: { method?: string; params?: Record<string, unknown> }): string {
  const meta = input.params?._meta as Record<string, unknown> | undefined;
  const bodyVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
  const headerVersion = request.headers.get('MCP-Protocol-Version');
  if (bodyVersion !== undefined && typeof bodyVersion !== 'string') throw new ProtocolError(-32602, 'Invalid protocol version metadata.');
  if (bodyVersion && headerVersion && bodyVersion !== headerVersion) throw new ProtocolError(-32020, 'Protocol version header and metadata do not match.');
  const version = headerVersion ?? bodyVersion ?? (input.method === 'server/discover' ? modernProtocol : legacyProtocol);
  if (version !== modernProtocol && version !== legacyProtocol) throw new ProtocolError(-32022, 'Unsupported MCP protocol version.');
  const method = request.headers.get('Mcp-Method');
  if (method && method !== input.method) throw new ProtocolError(-32020, 'Mcp-Method does not match the JSON-RPC method.');
  const name = request.headers.get('Mcp-Name');
  if (name && name !== input.params?.name) throw new ProtocolError(-32020, 'Mcp-Name does not match the JSON-RPC name.');
  return version;
}

export function protocolResult(id: unknown, result: Record<string, unknown>, version: string): Response {
  const wrapped = version === modernProtocol ? { ...result, resultType: 'complete', _meta: {
    ...(result._meta as Record<string, unknown> | undefined), 'io.modelcontextprotocol/serverInfo': { name: 'await.chat', version: '0.2.0' },
  } } : result;
  return Response.json({ jsonrpc: '2.0', id, result: wrapped }, { headers: { 'MCP-Protocol-Version': version } });
}
