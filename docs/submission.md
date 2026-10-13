# Await submission packet

Prepared October 13, 2026. Public source: https://github.com/redopage/await. This file is a draft for the official submission form, not a submitted entry.

## Project vision

Await gives people and named AI agents one durable record of a software change, from the first conversation to the independently checked commit. Agents from different providers work in isolated repositories, agree on interfaces, submit exact revisions and preserve context for the next session. A person reviews the combined result and authorizes publication. We are using the workflow on Await itself and measuring the friction it exposes, so the product grows from real collaboration rather than a scripted demonstration.

## How we used Cloudflare

Workers serve the application, HTTP API, OAuth and remote MCP tools. A SQLite-backed Durable Object owns each workspace's conversations, cards, requirements, agent inboxes and project event ledger. Artifacts stores the source, canonical project repository, isolated contributor forks and prepared integrations. Containers run work, preparation, independent checks and publication in separate trust scopes. Canonical writes use an exact-base Git lease. D1 holds identity, KV holds OAuth and preview grants, and R2 stores files.

## Instructions to run

Follow the [README quick start](../README.md#quick-start): Node 22.13 or newer, `npm run setup`, then `npm start`. This runs collaboration and MCP locally without Cloudflare credentials. For Git projects and hosted execution, replace the example Cloudflare identifiers with your own resources and follow [Run the full flow](../README.md#run-the-full-flow).

The public configuration uses example values. A plain clone never supplies maintainer deployment credentials. Model sign-in stays in the provider client. The real-source rehearsal is in [contest-demo.md](contest-demo.md#prepare-a-result-for-a-person-to-review).

## Evidence we can claim

- Credential-free fresh-checkout setup, all nine local migrations, 196 core smoke checks and browser sign-in/workspace/board/task creation succeeded.
- The reviewed source passed 151 main tests, four gateway tests and a production build. The dependency update reports zero known npm vulnerabilities.
- Real Artifacts protocol checks covered concurrent forks, assigned-branch pushes, checkpoints, requirement invalidation, handoff and cancellation.
- The hosted fixture combined and checked exact commits, exercised fixture-authorized publication and confirmed a new run began at the integrated revision.
- Two authenticated providers improved Await's actual contributor guides; a fresh check container passed 155 unchanged tests and the build. [Sanitized record](2026-10-13-dogfood-validation.json).
- That new dogfood result is awaiting a person. We cannot claim human approval, publication or a completed replacement-agent follow-up for it.

## Remaining submission work

Record and upload the five-to-ten-minute demo, using the [rehearsal](contest-demo.md). Show the person inspecting and approving the exact result. Complete a real replacement-agent follow-up if the recording claims continuation. Enter team and attendee details, review the official rules, and submit the form yourself. The rules prohibit automated entries.

The official deadline is October 14, 2026 at 11:59 p.m. Pacific (October 15 at 1:59 a.m. Chicago time). The form accepts MP4, WebM or MOV up to 2 GiB. See [the submission form](https://www.cloudflare.com/git-competition/submit/) and [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf).

## Product limits

The execution path remains an early preview: provisioning reconciliation, cost quotas, restricted egress and retained-repository cleanup need more work. Coordination currently shares one Durable Object per workspace. History budgets are cumulative. Passing checks establish the configured command passed, not semantic correctness. See [SECURITY.md](../SECURITY.md), [Projects](projects.md), and the [Scion review and experiments](anthropic-source-control-review.md).
