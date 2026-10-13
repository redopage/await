# Applying the Scion lessons to Await

Reviewed October 13, 2026 against Await revision 287c493 and the current implementation. Source: [Redesigning source control at Anthropic](https://www.anthropic.com/engineering/redesigning-source-control).

## What the article establishes

Anthropic describes a workload growing from about 2,500 to more than 30,000 daily merges. Scion assumes online consumers, moves repository operations to server APIs, stores immutable content-addressed data, and makes working copies optional and sparse. Its changesets record changed files; derived indexes accelerate queries. Shared ref updates are separate compare-and-swap operations. Independent cache tiers isolate failures. The team also shifted testing toward post-merge and pre-deploy checks at its scale, and uses component-focused agents to inspect telemetry. Anthropic explicitly limits the applicability of its replacement system and encourages adapting lessons to Git.

These are reported properties of Anthropic's system, not measured properties of Await. Its performance gains are not a forecast for us. Its token budget, fleet topology and monorepo workload differ substantially from ours.

## Our product thesis

Await should make the software change durable across people, agents and tools. The shared record connects the requested outcome, accepted requirements, assigned card, attempt, code revision, evidence, decision and publication. A person should be able to answer why a change exists, what was verified, and what remains unresolved without reconstructing multiple transcripts.

Git and Artifacts remain our storage and interchange foundation. We can improve the coordination and query layer incrementally. A replacement VCS would consume effort before we have measured the bottleneck it solves.

## The current boundaries

| Area | Existing implementation | Practical implication |
| --- | --- | --- |
| Repository queries | Candidate ancestry and changed-tree inspection run through Artifacts RPCs in src/object/projects.ts | Read-only questions already avoid containers, but traversal cost remains repeated |
| Ancestry | Sequential readCommit traversal, capped at 500 visited commits | Large histories can reject valid candidates; distinguish an exceeded proof budget from unrelated history |
| Changed files | Equal tree hashes prune work; traversal is capped at 80 trees, depth 12 and 300 files | Never describe a truncated comparison as a complete review |
| Hosted checkout | Ordinary clone with no checkout, followed by checkout | Fresh trust scopes currently pay repeated repository-transfer cost |
| Coordination | Advisory file and directory claims, free-text project notes | File overlap does not capture incompatible behavior in different files |
| Integration | One active preparation/check/publication per project; up to eight candidates | More contributors eventually wait on integration throughput |
| Coordination storage | One SQLite Durable Object per workspace | Chat, notifications and repository coordination share a throughput boundary |
| History budgets | 32 total attempts and 50 total integrations per project | These are cumulative prototype limits, not simultaneous-agent limits |
| Handoff | Versioned requirements, checkpoints, candidates and an event watermark | Durable context exists; decisions and unresolved dependencies are still mostly free text |
| Recovery | Receipts and alarms recover execution; provisioning lacks a reconciler | A remote fork and a local state transition can be interrupted between systems |

## Experiments, in order

### 1. Establish an honest dogfood baseline

Use the actual Await source with two authenticated providers. Assign useful, bounded tasks and preserve tests. Record exact base and candidate SHAs, actual tool calls, command receipts, combined checks and the human decision. Have a replacement agent read the handoff and perform a follow-up from the published revision.

Collect task-start-to-candidate time, hosted-command duration, repository-query latency, failed/retried calls, polling calls, time waiting on another contributor, review time and recovered work after interruption. Duration includes startup, Git operations and user commands; do not label it model time or clone time without separate instrumentation.

First run: contributor guide improvements in docs/projects.md and docs/architecture.md. This is documentation work on our real platform, not evidence that two agents shipped a new runtime feature. Next run should be a small product feature with independent acceptance checks and a usable browser result. Keep the reset fixture as a fast protocol check.

Success means both agents submit useful scoped changes, the independent check passes unchanged tests, a person can review the result, and the evidence explains any friction. A polished video alone is not the success criterion.

### 2. Make common repository answers cheap

Start with exact-revision file reads, changed paths and ancestry. Introduce a repository-query interface without changing the MCP contract. Measure RPC count and latency on small, medium and long histories before adding caching or indexes.

Cache keys must include repository identity, immutable SHA, query inputs and algorithm version. Recheck channel access on every request, including cache hits. Do not use a branch name as an immutable cache key. Successful ancestry proofs can be reused; incomplete traversal is not proof of non-ancestry.

Acceptance: responses match a Git oracle, request bounds remain explicit, revoked users cannot read cached results, and warm queries make fewer remote calls. Add access-revocation and history-boundary cases alongside performance measurements.

### 3. Reduce checkout cost while preserving trust scopes

Instrument container startup, Git fetch, checkout, dependency installation and the actual command separately. Verify which Git capabilities Artifacts supports before selecting filters or shallow fetches. Prepare and publication need enough history for merge and ancestry operations; a shallow optimization must not silently weaken either.

Try targeted fetches before building a cache service. If a shared cache is justified, reuse immutable objects only. Preserve separate writable directories, job identity and credentials for work, check and publication. Use bounded upstream concurrency so a cache failure cannot overload repository access.

Acceptance: transfer and startup measurements improve on representative repositories, merge results are identical, and a malicious working directory cannot influence the publication container.

### 4. Represent coordination beyond path overlap

Add explicit candidate relationships: complementary, alternative, dependent and superseded. Introduce versioned interface agreements only for contracts that real dogfood tasks need. Agreements should reference participants, requirements and tests; changes should make dependent candidates visibly outdated.

Do not guess correctness from disjoint files. A server and a client can be incompatible without editing the same path. Surface compatibility evidence from combined checks and attributable decisions.

Acceptance: two competing candidates cannot be accidentally combined as complementary work, dependencies are visible, and a changed contract produces an actionable next step.

### 5. Help a person review intent and evidence

Connect acceptance criteria to changed behavior, pinned source and check receipts. Keep author statements, automated analysis, independent checks and human decisions visibly distinct. Record unresolved assumptions rather than presenting a model summary as verification.

Preserve the exact-base publication lease. At our current workload, relaxing pre-publication checks would discard an existing protection without evidence of a throughput need. Selective checks need a measured dependency model; post-publication tests can add confidence without weakening publication rules.

Acceptance: a reviewer can identify what passed, what was not tested, which requirements apply and exactly what will publish. Measure review effort with actual users.

### 6. Recover partial operations and contain costs

Prioritize provisioning reconciliation, repository retention and per-workspace execution budgets before expanding unrestricted usage. Reserve stable operation IDs, inspect remote outcomes after uncertain responses, and distinguish retryable interruption from a terminal refusal. Recover an existing fork instead of creating another one when its identity is known.

Component health views should begin with ordinary counters: provisioning age, queued-job age, reconciliation errors, Git failures, stale integrations, event lag and spend. A focused agent can investigate telemetry and propose an action; automated repairs need separately bounded authority.

Acceptance: injected interruption after a remote fork does not strand work permanently or duplicate repositories, and quotas fail with a usable explanation and preserved state.

## What we should not extrapolate

A race-free publication path is not proof of semantic correctness. A successful provider run is not proof of broad usability. A fresh-container check only proves that its configured command passed against that pinned revision. Documentation dogfood is not a runtime-feature demonstration. Agent-reported presence is not observed execution state. Advisory path claims are not access controls.

Do not advertise thousands of contributors from our current cumulative limits. Do not reuse Anthropic's performance ratios as our expected savings. Do not remove human approval merely because producing more code is cheap.

## Recording and adoption

Tell one coherent story: a real request creates assigned work; two agents coordinate and submit; the checked result is reviewed by a person; the next agent continues from the record. Include one failure or correction so the audience sees how work recovers. Preserve the original evidence and label any edited recording or reused fixture.

After each real use, record the awkward steps, missed context, repeated operations and reviewer questions. Use those observations to choose the next improvement. The competition is a deadline for demonstrating the product; continued usefulness is the product goal.

## Observations from the October 13 dogfood run

Two authenticated providers worked on the actual committed Await contributor guides. Both submitted a candidate after agreeing on terminology. One observed project response was 127,674 UTF-8 bytes after 19 jobs, of which 57,741 bytes were stored command output. This is one local observation, not a throughput benchmark. `read_project` returns accumulated job receipts even when its event cursor advances.

Inspection commands also create empty Git checkpoints when they succeed. That adds history and makes source discovery look like authored progress. This strengthens the case for a read-only run-file tool and a narrow receipt read before introducing a distributed cache.

The Codex contributor corrected two invalid request-ID calls. The Claude contributor used nonzero exit-code probes for some diagnostics; those jobs correctly appeared as failures, but the UI misleadingly said "Waiting for output" when no output was captured. The UI now distinguishes pending output from a finished command and displays the exit code.

Review also exposed that `get_project_run_token` returned the canonical branch name instead of the run's branch. A regression assertion reproduced the mismatch and the response now returns `run.branch`. The real Git smoke test verifies the credential response and the pushed attempt ref.

The model-authored documentation required review: checkout language was too broad, and cumulative history limits needed to be distinguished from concurrency. The consolidated guides correct both. A passing build alone would not catch those documentation errors.
