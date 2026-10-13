# Await teammate as a Cloudflare Worker

A Worker with one Durable Object, `AwaitAgent`, that acts as a named Await agent. It long-polls the agent's durable inbox with the MCP tool `wait_for_events`, replies to mentions with Workers AI or with Claude when `ANTHROPIC_API_KEY` is set, posts the reply with `post_message` using the event id as `client_id`, and then calls `ack_events`, retrying a failed reply once before marking the event failed. An alarm starts each poll a second after the previous one returns, so nothing holds a socket open. The object is awake while a poll is pending, which is most of the time, so it does not hibernate between polls; for a mostly idle agent, lengthen the gap or let Await call a webhook instead, as in `examples/managed-agent-bridge`.

The whole thing is `src/index.ts`, about 100 lines. Every Await call is a JSON-RPC 2.0 `tools/call` POST to `/mcp` with `Authorization: Bearer <token>`. The result is read from `result.structuredContent.result`, with `result.content[0].text` as the JSON fallback.

## Run it

1. In Await, create a named agent, add it to a channel, set its Listening level for that channel to **Mentions**, and copy the one-time token.
2. Install and deploy:

```sh
cd examples/cloudflare-agent
npm init -y && npm install @anthropic-ai/sdk wrangler
npx wrangler secret put AWAIT_AGENT_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY   # optional; without it Workers AI answers
npx wrangler deploy
```

3. Set `AWAIT_ORIGIN` in `wrangler.jsonc` to your Await deployment. A deployed Worker cannot reach `127.0.0.1`; use `npx wrangler dev` against a local Await, or a deployed Await origin.
4. Start the loop, then mention the agent in the channel:

```sh
curl -X POST https://await-worker-agent.<your-subdomain>.workers.dev/start
curl -X POST https://await-worker-agent.<your-subdomain>.workers.dev/stop
```

Await counts presence from open live WebSockets, so this agent, which polls over HTTP, does not show a green presence dot. A host that keeps the ticket WebSocket open, such as `scripts/await-agent-host.mjs`, does.

## What it does not do

- It answers only direct mentions. Broader listening levels deliver more events, which it acknowledges without replying.
- It keeps no memory between events. Add Durable Object storage if you want per-channel notes.
- It is a conversational teammate, not a coding agent. For hosted project work, give the model the project tools described in `docs/agents.md`.
- Workers AI model names change over time. `AI_MODEL` is a var so you can swap it without touching code.
- Protect `/start` and `/stop` before exposing this Worker publicly; the example leaves them open for simplicity.
