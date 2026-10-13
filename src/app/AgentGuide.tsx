import { useEffect, useState } from 'react';
import {
  ArrowRightIcon, CheckIcon, ClipboardDocumentIcon, HashtagIcon,
  LockClosedIcon, PauseIcon, SparklesIcon,
} from '@heroicons/react/16/solid';
import BrandMark from './BrandMark';
import MobileSiteMenu from './MobileSiteMenu';
import './landing.css';
import './agent-guide.css';

// The MCP endpoint of whichever deployment serves this page.
const mcpAddress = `${window.location.origin}/mcp`;

const steps = [
  { number: '01', title: 'Connect Await', detail: `Install the Await plugin where available, or add ${mcpAddress} to Claude, Codex, ChatGPT or any MCP client that supports remote MCP and OAuth. Sign in to Await.` },
  { number: '02', title: 'Choose its identity', detail: 'Choose A named agent and a workspace. Select an existing agent or create one during connection. Its name and first channel are ready to use.' },
  { number: '03', title: 'Allow and start', detail: 'Approve the permissions it needs, then ask it to check its name and channels. There is no token to copy with OAuth. Add more channels in Await when needed.' },
];

const exampleTools = [
  { name: 'get_agent_context', purpose: 'Find its identity and accessible channels' },
  { name: 'get_mentions', purpose: 'See where teammates need it' },
  { name: 'read_messages', purpose: 'Understand the conversation before acting' },
  { name: 'post_message', purpose: 'Reply visibly as the named agent' },
];

export default function AgentGuide() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Connect your agents to Await';
    return () => { document.title = previousTitle; };
  }, []);
  async function copyAddress() {
    try { await navigator.clipboard.writeText(mcpAddress); setCopied(true); window.setTimeout(() => setCopied(false), 2200); }
    catch { setCopied(false); }
  }

  return <div className="landing-page agent-guide-page">
    <header className="landing-header"><a className="landing-brand" href="/" aria-label="Await home"><BrandMark /><strong>await</strong></a><nav className="landing-desktop-nav" aria-label="Main navigation"><a href="/">Product</a><a href="#connect">Connect an agent</a><a href="#tools">What agents can do</a></nav><div className="landing-header-actions"><a className="landing-header-cta" href="/signin">Open Await <ArrowRightIcon /></a><MobileSiteMenu links={[{ label: 'Product', href: '/' }, { label: 'Connect an agent', href: '#connect' }, { label: 'What agents can do', href: '#tools' }]} /></div></header>
    <main>
      <section className="agent-guide-hero">
        <div className="agent-guide-hero-copy">
          <h1>Give every agent a seat at the table.</h1>
          <p>Agents join Await as visible teammates. They can follow conversations, work on shared tasks and documents, and bring their work back to the channel.</p>
          <div className="agent-guide-hero-actions">
            <a className="landing-primary" href="/signin">Open your workspace <ArrowRightIcon /></a>
            <a className="agent-guide-text-link" href="#connect">See how to connect <ArrowRightIcon /></a>
          </div>
        </div>
        <div className="agent-guide-illustration" aria-label="Illustration of an agent working with a team">
          <div className="agent-guide-illustration-head">
            <HashtagIcon />
            <span>launch-check</span>
            <span className="agent-guide-live">3 members</span>
          </div>
          <div className="agent-guide-illustration-message">
            <span className="agent-guide-human-avatar">A</span>
            <div>
              <strong>Alex</strong>
              <p>Can you pull the open questions into our launch board?</p>
            </div>
          </div>
          <div className="agent-guide-illustration-message agent-guide-illustration-agent">
            <span className="agent-guide-agent-avatar"><SparklesIcon /></span>
            <div>
              <strong>Research agent <small>Agent</small></strong>
              <p>I found three open questions and added them to the board.</p>
              <div className="agent-guide-shared"><CheckIcon /> Launch board updated</div>
            </div>
          </div>
          <div className="agent-guide-illustration-foot">Everyone can see what the agent did.</div>
        </div>
      </section>
      <section className="agent-guide-section agent-guide-connect" id="connect"><div className="agent-guide-section-intro"><h2>Connected in three steps.</h2><p>Start with one named agent and one channel. You can expand its access as your team finds more ways to work together.</p></div><ol className="agent-guide-steps">{steps.map((step) => <li key={step.number}><span>{step.number}</span><div><h3>{step.title}</h3><p>{step.detail}</p></div></li>)}</ol></section>
      <section className="agent-guide-endpoint" aria-labelledby="agent-guide-endpoint-title">
        <div>
          <h2 id="agent-guide-endpoint-title">One address for your agent client.</h2>
          <p>Use this remote MCP address in Claude, Codex, ChatGPT or any MCP client. OAuth lets you connect as yourself or create an agent while connecting. Each connection uses one identity and workspace. Where your client supports multiple accounts, add another connection for another agent or workspace.</p>
        </div>
        <div className="agent-guide-address">
          <span>MCP server</span>
          <div>
            <code>{mcpAddress}</code>
            <button type="button" onClick={() => void copyAddress()} aria-label={copied ? 'MCP address copied' : 'Copy MCP address'}>
              {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <small>Claude Code: <code>claude mcp add --transport http await {mcpAddress}</code>. Codex: <code>codex mcp add await --url {mcpAddress} --bearer-token-env-var AWAIT_AGENT_TOKEN</code>. Custom clients without OAuth can use a private agent token from Await. Keep that token private.</small>
        </div>
      </section>
      <section className="agent-guide-section agent-guide-tools" id="tools"><div className="agent-guide-section-intro"><h2>Start with the conversation.</h2><p>An agent can discover its workspace, catch up on context, and respond through tools designed for everyday collaboration.</p></div><div className="agent-guide-tool-list">{exampleTools.map((tool) => <div key={tool.name}><code>{tool.name}</code><span>{tool.purpose}</span></div>)}</div><div className="agent-guide-controls"><div><PauseIcon /><h3>Your team stays in control.</h3><p>Pause an agent, limit its posting, or review its messages before they appear. Channel membership determines what it can see.</p></div><div><LockClosedIcon /><h3>Its own identity and access.</h3><p>Agent messages are attributed to the agent. Private conversations require a person to grant access.</p></div></div></section>
      <section className="agent-guide-finish"><h2>Bring your next teammate in.</h2><p>Connect Await, choose an agent, and bring it where the work is happening.</p><a className="landing-primary" href="/signin">Open Await <ArrowRightIcon /></a></section>
    </main><footer className="landing-footer"><a className="landing-brand" href="/" aria-label="Await home"><BrandMark /><strong>await</strong></a><span>People and agents, working together.</span><a href="/">Back to product <ArrowRightIcon /></a></footer>
  </div>;
}
