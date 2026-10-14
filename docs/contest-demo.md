# Contest demo

The recording shows one change reaching a verified finish, with the source and receipts on screen. Five chapters map to the judging rubric: agent-oriented collaboration (50%), multi-agent concurrency, coordination, context preservation, review and conflict handling (25%), and ease of use (25%). Target six to seven minutes.

## Rules for the recording

- Show real agents doing real work. The deterministic fixtures (`smoke:projects`, `smoke:hosted`) are protocol tests and must not be presented as model reasoning. Use `smoke:multimodel` or live clients for every chapter that involves a model.
- Author-reported checks are claims. Only the fresh-container check is verification, and the person on screen clicks **Approve & integrate**. Do not let a harness approve.
- Do not record tokens, `.dev.vars`, private transport files or the environment-secret panel. Create a demo workspace and demo repositories for the recording.
- Say what each proof is: a pinned SHA, a check receipt, a refusal, a cursor. Keep narration short.
- If the Codex Cloud task that built and tested this repository comes up, say that it ran in local mode without Artifacts or execution credentials, so it is not part of the multi-agent flow.

## Prepare a result for a person to review

Start a local server against real Artifacts and the configured execution service, then run:

```sh
AWAIT_KEEP_PROJECT_FIXTURE=1 AWAIT_STOP_BEFORE_PUBLICATION=1 npm run smoke:multimodel
```

This starts two real providers, verifies their candidates and runs independent combined checks. It does not review candidates or authorize publication. The canonical base remains unchanged and the cards remain unfinished. Open the printed fixture URL, type `Project reviewer <reviewerEmail>` in the Local development account field, using the reviewer email stored in `/tmp/await-hosted-smoke.json`, and review the checked result. That file is private and includes the session cookie and agent tokens. Never upload it or show it in the recording. The project URL and private metadata are saved as soon as the project is created so you can watch the actual work in progress. Development sign-in is restricted to localhost. Set `AWAIT_FIXTURE_PATH` to use a separate private metadata file for each simultaneous rehearsal.

To work on Await itself instead of the small reset fixture:

```sh
AWAIT_DOGFOOD=1 AWAIT_KEEP_PROJECT_FIXTURE=1 AWAIT_STOP_BEFORE_PUBLICATION=1 npm run smoke:multimodel
```

Dogfood mode archives the current committed source only. Two providers improve `docs/projects.md` and `docs/architecture.md` in separate forks after reading the implementation and agreeing on terminology. The harness verifies the exact allowed paths; unchanged tests and the production build run in the fresh check container. Describe this honestly as contributor documentation work on Await, not a new runtime feature. Evidence is saved under ignored `private/evidence/`. Kept repositories need deliberate cleanup after recording; branch cleanup does not remove repositories.

The ordinary `smoke:hosted` and `smoke:multimodel` commands still run a fixture reviewer and publish automatically as a protocol test. Do not use that approval as footage of a person deciding to ship.

## Recording: one useful change, six to seven minutes

| Time | On screen | What the viewer should learn |
| --- | --- | --- |
| 0:00-0:40 | Goal, assigned cards, linked conversation | A change has one shared record; show the exact real task being demonstrated |
| 0:40-2:00 | Both providers' attempts, actual coordination notes and candidate SHAs | Separate agents coordinate and submit code or documentation in isolated forks |
| 2:00-3:40 | Combined source and fresh check receipt, then a person clicks Approve & integrate | Agent claims, independent verification and the publication decision are separate |
| 3:40-4:30 | A stale result or changed requirements, with the actual refusal | Await preserves the evidence and requires a fresh result when its assumptions change |
| 4:30-5:40 | Handoff, a replacement agent's new attempt and follow-up | Accepted requirements, decisions and exact revisions survive a model or tool change |
| 5:40-6:30 | Agent connection, source license and clean-checkout instructions | A viewer can try the product and understand what needs a Cloudflare account |

Use the real event history and receipts, not recreated dialogue. If agents chose disjoint paths, show their interface agreement; do not claim an overlap event occurred. A green conversational-host presence dot does not prove that a coding command is running. Show execution receipts for that claim.

Prepare an older ready integration before publishing the selected result if recording the stale-result refusal. Only one integration can prepare/check/publish at a time. Once the selected result publishes, the old prepared result is outdated. Show the actual response, not a staged caption. If this demonstration is not performed, omit the claim.

A replacement agent must actually read the handoff and start its own attributed attempt. Do not describe an exported packet alone as a completed continuation. Avoid adding inbox-host restart choreography to the core recording unless it has been rehearsed separately; the software-change lifecycle is the main story.

Suggested opening:

> We built Await because useful agent work needs a shared record that survives the agent session. Here are two providers working on one outcome, the evidence for their combined result, and the person deciding what ships.

Suggested closing:

> The next agent can continue from the accepted requirements, exact commits and decisions. We are using this workflow on Await itself and recording where it helps and where it still creates friction.

Before recording, confirm the printed project URL is usable, the result is ready for review, secrets are out of view, and the selected task can be explained in one sentence. Preserve the original run evidence alongside the video. Record source revision and which portions of the flow were live, prerecorded or not demonstrated.

## Evidence

The two October 11 recorded runs below ran against a local dev server with real Artifacts repositories and Cloudflare containers. In both, the final approval came from the test harness acting as the local human reviewer. That stands in for the person the product requires; it is not autonomous approval.

- [multimodel-project-agents-live-test.json](multimodel-project-agents-live-test.json): a Codex teammate and a Claude Code teammate each took a card. Each proposed an expiry contract through project notes, the proposals matched, and the Claude teammate posted a correction after reading the acceptance test. Each submitted its own commit from its own fork. The Claude teammate prepared the integration, and `node --test reset.test.mjs` passed 2 of 2 in a fresh container against the combined commit. After approval both cards reached Done, and a real attempt branch was deleted and restored with its Git refs recorded.
- [provider-continuity-live-test.json](provider-continuity-live-test.json): a Claude Code teammate picked up a project that two Codex teammates had integrated in an earlier run. It read the handoff packet, started its own fork from the integrated commit, added a document describing the agreed contract, and submitted it with an author-reported passing test run. An independent integration check then passed 2 of 2, and after approval its card reached Done.

A new [October 13 real-source dogfood record](2026-10-13-dogfood-validation.json) records two providers improving Await's own guides. The combined commit passed 155 unchanged tests and the production build in a fresh Cloudflare container. It remains ready for human review, with no approval or canonical publication. The consolidated source includes reviewed factual corrections to the model-authored guides. Raw transcripts and credentials stay in ignored private storage.

Inspect the outcome and the receipts in each file before calling a run complete.

## After the recording

Verify the official rules and submission form, confirm the public repository and the license, and link the video, the README and this document. The deployed service and the demo channel are separate from any production workspace.


## Repository tools walkthrough

Use the actual repository-tools dogfood run as the main walkthrough. It demonstrates a runtime feature built by Claude and Codex, followed by both providers using that feature. See [the evidence report](evidence/2026-10-13-repository-tools-dogfood.md) for pinned revisions, checks, measured payloads and observed failures.

1. Open the project named **Read repositories without running commands**. Show the two assigned cards, accepted requirements and provider-owned attempts.
2. Show the helper contract note and the resulting pinned source. Explain that a source read uses immutable Artifacts objects and creates no job, Git token or empty checkpoint.
3. Show a default compact poll with 20 recent job summaries and explicit paging. Fetch one real full job receipt by its ID, then show the successful integration receipt for `3993ed8e6da8133a596efccf3c86ba61b4a47789`.
4. Show the earlier TypeScript failure and corrected candidate. Keep author-reported checks and the independent fresh-container result distinguishable.
5. Show both real providers' read-only verification. Claude's earlier output overflow led to job metadata paging; the final defaults were readable by both providers. Use the measured 45 KB versus 967 KB observation, and label it as this project's payload comparison.
6. Let a person inspect the exact combined result in Await. Record their actual publication decision if they approve it. Until then, the outcome is a checked result ready for human review.

Keep the original tool traces private because they include fixture and transport context. The public evidence report summarizes them without credentials. Source branches and recorded checks do not imply a production deployment.
