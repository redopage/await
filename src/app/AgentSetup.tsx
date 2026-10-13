import { useEffect, useState } from 'react';
import { CheckIcon, ChevronDownIcon, ClipboardDocumentIcon, PlusIcon } from '@heroicons/react/16/solid';

type Props = {
  token: string;
  mcpUrl: string;
  channels: Array<{ id: string; name: string }>;
  initialChannelId?: string;
  alreadyInInitialChannel?: boolean;
  onAddToChannel: (channelId: string) => Promise<boolean>;
};

export default function AgentSetup({ token, mcpUrl, channels, initialChannelId, alreadyInInitialChannel, onAddToChannel }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState('');
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('');
  const [addedChannelIds, setAddedChannelIds] = useState<string[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState(initialChannelId ?? channels[0]?.id ?? '');
  useEffect(() => {
    if (!channels.some((channel) => channel.id === selectedChannelId)) setSelectedChannelId(channels.find((channel) => channel.id === initialChannelId)?.id ?? channels[0]?.id ?? '');
  }, [channels, initialChannelId, selectedChannelId]);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const origin = mcpUrl.replace(/\/mcp$/, '');
  // Paste-ready setup. The local host reads the token from a private env file, so it stays out of shell history.
  const recipes = [
    { id: 'claude', label: 'Claude Code', command: `claude mcp add --transport http await ${mcpUrl} --header "Authorization: Bearer ${token}"` },
    { id: 'codex', label: 'Codex CLI (export AWAIT_AGENT_TOKEN where Codex runs)', command: `codex mcp add await --url ${mcpUrl} --bearer-token-env-var AWAIT_AGENT_TOKEN` },
    { id: 'env', label: 'Local host: save as .env.await-bot, then chmod 600', command: `AWAIT_AGENT_TOKEN=${token}\nAWAIT_ORIGIN=${origin}` },
    { id: 'host', label: 'Local host: run with push events', command: 'npm run agent:host -- --runner claude' },
  ];
  const isJoined = addedChannelIds.includes(selectedChannelId) || (selectedChannelId === initialChannelId && alreadyInInitialChannel);

  async function copy(value: string, item: string) {
    try { await navigator.clipboard.writeText(value); setCopied(item); setCopyError(''); }
    catch { setCopyError('Could not copy automatically. Select the value above to copy it.'); }
  }

  async function addToChannel() {
    if (!selectedChannelId) return;
    setAdding(true);
    try { if (await onAddToChannel(selectedChannelId)) setAddedChannelIds((current) => [...current, selectedChannelId]); }
    finally { setAdding(false); }
  }

  async function testConnection() {
    setTesting(true); setConnectionStatus('');
    try {
      const response = await fetch(mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_agent_context', arguments: {} } }) });
      const result = await response.json() as { result?: { isError?: boolean; structuredContent?: { result?: { agent?: { name?: string }; channels?: Array<{ name: string }> } } } };
      if (!response.ok || result.result?.isError) throw new Error('The agent could not connect. Try rotating its token.');
      const context = result.result?.structuredContent?.result;
      if (!context?.agent?.name) throw new Error('The agent did not return its identity.');
      setConnectionStatus(context.channels?.length ? `${context.agent.name} is connected and can work in ${context.channels.map((channel) => `#${channel.name}`).join(', ')}.` : `${context.agent.name} is connected. Add it to a channel to start collaborating.`);
    } catch (cause) { setConnectionStatus(cause instanceof Error ? cause.message : 'Could not test the connection.'); }
    finally { setTesting(false); }
  }

  return <section className="agent-setup" aria-label="Connect your agent">
    <h3>Connect your agent</h3>
    <p>Connect through Claude Code, Claude Desktop, Codex, ChatGPT, or any MCP client. Give each teammate its own agent and channel access.</p>
    <div className="agent-setup-channel"><div><strong>Channel access</strong><p>Choose where this agent can work.</p>{channels.length > 0 && <span className="agent-setup-select"><select name="agent-channel" aria-label="Channel to add agent to" value={selectedChannelId} onChange={(event) => setSelectedChannelId(event.target.value)}>{channels.map((channel) => <option key={channel.id} value={channel.id}># {channel.name}</option>)}</select><ChevronDownIcon aria-hidden="true" /></span>}</div>{selectedChannel && (isJoined ? <span className="agent-setup-joined"><CheckIcon /> In #{selectedChannel.name}</span> : <button type="button" className="button secondary" disabled={adding} onClick={() => void addToChannel()}><PlusIcon /> {adding ? 'Adding…' : 'Add agent'}</button>)}</div>
    <p>Add this MCP address in your client. During OAuth, choose A named agent and select this agent in its workspace; OAuth needs no token. Clients without OAuth use the token below, and the commands further down paste it in for you.</p>
    <div className="agent-setup-field"><span>MCP address</span><code>{mcpUrl}</code><button type="button" className="button secondary" onClick={() => void copy(mcpUrl, 'url')}>{copied === 'url' ? <CheckIcon /> : <ClipboardDocumentIcon />}{copied === 'url' ? 'Copied' : 'Copy address'}</button></div>
    <div className="agent-setup-field"><span>Agent token (shown once)</span><code>{token}</code><button type="button" className="button secondary" onClick={() => void copy(token, 'token')}>{copied === 'token' ? <CheckIcon /> : <ClipboardDocumentIcon />}{copied === 'token' ? 'Copied' : 'Copy token'}</button></div>
    <p className="agent-setup-note">Save the token now. Await will not show it again. After connecting, ask the agent to call <code>get_agent_context</code> to confirm its name and channels.</p>
    <p className="agent-setup-note">The Claude Code command and the env file carry the token. Keep them out of shared chats and scripts.</p>
    {recipes.map((recipe) => <div className="agent-setup-field" key={recipe.id}><span>{recipe.label}</span><code>{recipe.command}</code><button type="button" className="button secondary" onClick={() => void copy(recipe.command, recipe.id)}>{copied === recipe.id ? <CheckIcon /> : <ClipboardDocumentIcon />}{copied === recipe.id ? 'Copied' : 'Copy command'}</button></div>)}
    <a className="agent-setup-guide" href="/agents" target="_blank" rel="noopener noreferrer">Read the agent connection guide</a>
    <button type="button" className="button secondary" disabled={testing} onClick={() => void testConnection()}>{testing ? 'Checking…' : 'Test connection'}</button>
    {connectionStatus && <p role="status">{connectionStatus}</p>}
    {copyError && <p className="agent-setup-error" role="alert">{copyError}</p>}
  </section>;
}
