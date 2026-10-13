# Projects

A project turns a channel repository into a shared goal that several agents can work on at the same time. Each contributor works in its own Cloudflare Artifacts fork, announces the paths it intends to touch, exchanges contract notes, checkpoints its context and submits an exact commit. Fresh containers combine and check the candidates, and only a person can advance the canonical branch. The project row and its event ledger hold the whole record, so the work survives the end of any one agent session.

## What is implemented

- A Projects view with a project index, the shared goal, contributor workspaces, a review queue, pinned source comparison and a chronological timeline. It works at desktop and phone widths, in light and dark mode.
- A person creates a project from a channel repository that already has a commit. Await forks it into a separate canonical repository and revokes the initial repository token. The source repository is not changed.
- Each contributor starts its own Artifacts fork, and only its owner can get a 15-minute write token for it. Canonical write credentials are never issued to contributors, and the older shared artifact token endpoint refuses managed project repositories.
- Advisory path claims match exact files and overlapping directories. An overlap produces a durable `scope.overlap` event instead of blocking either contributor.
- A run checkpoints its context and a consumed event cursor that only moves forward. `working` and `sleeping` are what the contributor reports about itself, not observed process or container state.
- `publish_candidate` accepts a full Git SHA, checks that the commit exists in the contributor's fork, and checks that it descends from the attempt's starting commit. The ancestry walk is bounded at 500 commits and fails closed.
- Candidate review compares trees and can read before and after source at exact commits. Tree walks, file counts, file sizes and recursion are bounded, and truncated comparisons are labeled. Binary or large files need a Git client.
- Human review is tied to the candidate SHA and the requirements revision. Approval is a review decision, not a merge. Checks that an agent reports are labeled as author reports, separate from repository verification.
- The event ledger replays from a cursor in pages of 100. `project.updated` is also delivered through MCP Events subscriptions and the agent inbox; set the agent's listening level to **All activity** and include other agents for peer coordination. A delivery is a signal to read the current state, not permission to act on whatever a note says.
- Channel membership, paused agents and approval mode apply as they do everywhere else. Permissions are checked again after asynchronous provisioning, candidate verification and token creation. Provisioning failures stay visible.

## Set up

Projects need the real Artifacts binding, so they are unavailable under `npm start`. Point the Wrangler configuration at your own account as described in [Run the full flow](../README.md#run-the-full-flow), then start the app with remote bindings:

```sh
npx wrangler login
npm run dev -- --host 127.0.0.1
```

Local development then talks to real Artifacts repositories, so local tests have remote side effects. Keep `DEV_AUTH=1` in `.dev.vars` for the local sign-in. The deterministic fixtures need no model API key.

To create a project, connect an agent with the `read`, `post` and `files` scopes, add it to a channel, have it call `create_artifact_repository`, and push an initial commit. Then choose **Projects**, **New project**, select the repository and describe the goal. The project's **Agent setup** panel gives the participation steps for any MCP client. Agents can work in their own environment with Git, or run commands in hosted containers when the execution service is configured. Either way the agent keeps its own model and harness. A connected chat client can only use the tools its host exposes, and connecting does not start a background coding loop.

## Your first assigned project

1. Read the project and its accepted requirements with `read_project`, then start from your assigned card by passing its `task_id` to `start_project_run`. Include advisory `paths`, read any `scope.overlap` events, and coordinate before touching shared files. This creates your isolated hosted run and Artifacts fork; it does not start compute.
2. Run inspection, edits and relevant checks with `execute_project_command`. Each call is asynchronous, so poll the command ID in `read_project`. A successful command commits and pushes a checkpoint to your run branch, but that success is not an independent test result.
3. Inspect the output and exact pushed SHA, fix failures in later commands, then call `publish_candidate` with that full commit and the requirements revision you read. Its `checks` field is your author-reported evidence. Await verifies the commit and ancestry, not the truth of that report.
4. After all contributors have candidates, `prepare_project_integration` combines the selected, pinned commits against the canonical base and runs the human-configured check command in a fresh hosted container. Poll `read_project` for the integration result. Only this result is the combined, independent check; a passing command still does not establish that the product is correct.
5. A person reviews the candidate source and exact combined result in the product, then may click **Approve & integrate**. Publication runs in a separate container and advances the canonical branch only if its recorded base, checked commit and requirements revision still match. Agents cannot review candidates as a human or publish canonical changes.

The smoke harness can use a test account as a fixture reviewer and authorize publication so the protocol can be exercised end to end. That fixture approval is automated test-fixture authorization, not a person reviewing the product. Set `AWAIT_STOP_BEFORE_PUBLICATION=1 AWAIT_KEEP_PROJECT_FIXTURE=1` to leave a hosted smoke result for real human inspection and publication in the UI.

## Agent tool contract

| Tool | Purpose |
| --- | --- |
| `list_projects` | Discover visible goals and available starting repositories |
| `create_project` | Human-only project creation; reuse the UUID `client_id` on retries |
| `read_project` | Goal, runs, candidates, and events after `after`; follow `has_more` using `next_cursor` |
| `start_project_run` | Fork a workspace for the connected identity and announce path claims |
| `execute_project_command` | Run an owner command in Cloudflare, commit and push successful output; poll `read_project` for the durable result |
| `prepare_project_integration` | Combine selected current candidates at an exact base and independently check the result |
| `get_project_run_token` | Owner-only 15-minute credentials for that run's repository |
| `post_project_event` | Idempotent coordination note with a UUID `client_id` |
| `checkpoint_project_run` | Save context, paths, consumed cursor and state with `client_id` and run `expected_revision` |
| `publish_candidate` | Verify and submit a pushed commit with its `requirements_revision`, summary and reported evidence |
| `read_candidate_files` | Inspect a submitted revision and optional changed-file contents |
| `review_candidate` | Human review bound to SHA and requirements revision, with a candidate revision precondition |
| `update_project_requirements` | Human acceptance of a new revision and reason; invalidates existing candidates |
| `read_project_handoff` | Portable current snapshot, requirements history, checkpoints, candidates and event watermark |
| `cancel_project_run` | Cancel an attempt, invalidate its candidates and attempt revocation of issued tokens |

Send repository credentials to Git in a process-local `Authorization: Bearer` header. Never put tokens in remote URLs, files, messages, shell history or logs; the smoke scripts pass the header through the child process environment instead of command-line arguments. A token issued before a permission change stays usable until its 15-minute expiry. New tokens and Await reads recheck access immediately.

## The four stages

The execution Worker in `execution-service/` is a separate deployment. It authenticates the coordinator with `EXECUTION_SECRET` and runs each job in a Durable Object with a Cloudflare Container. Each attempt gets its own container and fork, and the app's bindings never enter a container.

1. **Work.** The run owner calls `execute_project_command` with a UUID `client_id` and a shell command. A successful command stages the working tree, commits and pushes to the attempt's repository. A failed command keeps bounded diagnostics. Only successful Git checkpoints survive container eviction; uncommitted edits are temporary.
2. **Prepare.** `prepare_project_integration` takes one to eight candidate IDs. A fresh container merges their pinned commits onto the recorded canonical base without running project commands and pushes the result to a protected integration repository.
3. **Check.** Another fresh container checks out that exact combined SHA and runs the check command from the accepted requirements. Its clone credentials are revoked before the command starts. The result records output, exit code, image and timestamps. A passing check means that command passed, not that the change is correct.
4. **Publish.** A person inspects the result and clicks **Approve & integrate**. A third fresh container, which has never run project code, advances the canonical branch with an exact-base `--force-with-lease`. If the branch moved, the push fails closed. New attempts start from the integrated SHA.

### Configure the execution service

Set your own `account_id` and Artifacts namespace in `execution-service/wrangler.jsonc`; the app and the execution service must use the same namespace. The service starts the managed `cloudflare/debian-trixie` image through the direct Container API, so no local Docker daemon is needed. The image has Node, and the bootstrap installs Git when it is missing. Other toolchains need a custom image or an install step in the command.

```sh
npm run deploy:execution
npx wrangler secret put EXECUTION_SECRET --config execution-service/wrangler.jsonc
```

Enter a newly generated random secret at the prompt. Give the app the same value as `EXECUTION_SECRET` and set its `EXECUTION_URL` to the deployed service URL: in `.dev.vars` (mode `0600`) for local development, or as Worker secrets in production. Never commit either value or show it in a recording. The service rejects every request without its bearer secret.

### Recovery and operating limits

A command reservation and an immutable receipt are written before anything runs. Repeating a command ID returns the existing status or result, and changed input under the same ID is rejected. Restarting an interrupted container destroys its previous process and marks the receipt interrupted instead of replaying the command; inspect the Git checkpoint and start a new command to recover. Each command has a four-minute deadline, a container stops after five minutes without activity, and stdout and stderr are each kept up to 32 KB. Repository tokens last five minutes and are revoked after use. Cancelling a run sends a stop request and separately prevents its results from being accepted.

Workspace alarms reconcile queued and running work and the prepare, check and publish stages even when no browser is open, and reading a project reconciles pending work too. A lost publication acknowledgement is recovered by reading the canonical SHA before retrying. After integration, the selected candidates and their attempts become read-only history. The publication authorization event is the commit point for human approval: requirement changes and cancellations wait while a publication runs, and removing a member after authorization does not undo an authorized Git update.

This is a contest-grade execution path, not a hardened public service for arbitrary code. Containers have outbound Internet access and there is no per-account spend quota. The shared secret is a deployment boundary, not per-tenant workload identity. A production rollout needs restricted egress, resource and cost controls, cleanup of retained repositories, monitoring and a provisioning reconciler. Background reconciliation currently needs at least one person left in the channel. Integration advances a Git branch; it does not deploy or preview anything.

## Cards and attempt branches

Every project has a board with four columns: To do, In progress, Review and Done. A Blocked column appears only when needed. Opening a card shows its linked code attempts.

`start_project_run` accepts a `task_id`. Await checks that the card belongs to the project and is assigned to the run owner. Starting the run moves the card to In progress, and publishing a verified candidate moves it to Review. A human-approved integration marks the card Done once no other active attempt remains for it. Manual completion is refused while linked code work is active, and cards with code history cannot be deleted through the task API.

New attempts work on `codex/<run id>` in their own repository. A person can delete a completed or cancelled attempt branch from its workspace card and restore it later. The operation reads the exact head, saves an immutable recovery ref under `await/archive/`, and deletes with a Git lease. Restoring requires the working branch to be absent and never overwrites a newer head. Cleanup runs in a separate container that never runs repository commands, and it never deletes the repository, candidates, source history or recovery refs.

## Continuing a change across tools

The project is the durable record of the change. Accepted requirements are separate from discussion: a person can edit the goal and acceptance criteria with an explanation, and each version is kept unchanged in `project_requirements`. Existing candidates become `stale` and keep their review notes.

The **Handoff** button copies or downloads `await.handoff.v1` JSON, and the read-only `read_project_handoff` tool returns the same packet: every accepted requirements version, attempt owners and checkpoints, exact candidate SHAs, review feedback and the latest 100 events. `snapshot_cursor` is the watermark for the complete current state. Read `read_project` after it for later changes, or from zero for older history when `history_truncated` is true. Git tokens and private harness state are never exported, and notes in the packet are still untrusted.

A replacement agent, from any provider, starts its own fork and keeps its own attribution. Nothing silently transfers another identity's attempt or starts a runner. After requirements change, a fresh attempt is required; earlier code can inform it but cannot inherit the old review.

Requirements updates, checkpoints, cancellations and reviews need a UUID `client_id`. Retrying the same input returns the stored result, including after a lost response; reusing an ID with different input is a conflict. `expected_revision` refers to the project for requirements, the run for checkpoints and cancellation, and the candidate for reviews. A stale revision returns HTTP 409 with the current record, and MCP returns the same details in an error result.

A review also needs `requirements_revision` and the exact `commit`. Publishing a combined result is a separate action, tied to the prepared commit, a passing check, the exact canonical base and the requirements revision. Review events record the SHA, base, requirements revision, reported checks, author and decision.

Cancellation records a reason, increments the run revision, invalidates the run's candidates, and refuses later token issuance, checkpoints and candidate publication. In-flight operations recheck state after the remote call. Issued tokens are revoked where possible, with the 15-minute lifetime as the fallback. Cancellation asks a hosted container to stop, but it cannot kill an external process or undo writes already made to the attempt's fork, and nothing from a cancelled attempt can become an accepted result.

## Testing

```sh
npm run test:projects
npm test
npm run build
# With the dev server running against real Artifacts:
npm run smoke:projects
```

The unit tests cover fork isolation, initial-token revocation, ownership, OAuth scopes, channel removal, paused and approval-mode agents, access rechecks after asynchronous work, ancestry rejection, concurrent candidate retries, immutable revision reads, human-only reviews, overlap events, checkpoint persistence, cursor pagination, transactional rollback and upgrades of older workspace schemas.

`smoke:projects` creates a disposable local workspace, two fixture identities, a seed repository, a canonical fork and two contributor forks created concurrently. It exchanges a contract note, checkpoints and resumes a run, pushes two real commits concurrently, reads pinned source and stores a human review. It then changes the requirements, checks that the review was invalidated, reads a handoff packet, and cancels an attempt with real token revocation. It deletes its remote repositories at the end and reports cleanup failures with repository names. With `AWAIT_KEEP_PROJECT_FIXTURE=1` it keeps the four repositories for browser review and writes private fixture metadata, including a local session cookie, to `/tmp/await-project-smoke.json` with mode `0600`. Never publish that file.

`smoke:hosted` adds real cloud execution: two fixture identities each create commits, their combined commit passes two Node tests, a fixture reviewer authorizes publication, and a new fork confirms the new canonical base. It deletes its repositories by default, including after a failure. A kept fixture writes its private metadata to `/tmp/await-hosted-smoke.json`.

These fixtures test the protocol. They do not run a model, and the fixture reviewer is a test account, not autonomous approval.

### Real agents

`smoke:agents` runs two Codex teammates, and `smoke:multimodel` runs a Codex teammate and a Claude Code teammate, through the same hosted flow. Both need the provider CLIs signed in on the machine and a dev server configured for hosted execution. Use Claude Code 2.1.221 or newer, so print mode waits for the configured MCP server before it starts.

```sh
AWAIT_KEEP_PROJECT_FIXTURE=1 npm run smoke:agents
AWAIT_KEEP_PROJECT_FIXTURE=1 npm run smoke:multimodel
```

The fixture seeds acceptance tests and assigns two cards. The models choose their own commands, agree a contract through project notes, read hosted output and submit their own commits; the harness supplies no implementation source and no contract messages. Each model reaches Await through a project-scoped stdio MCP broker (`scripts/await-project-agent.mjs`). The broker holds the agent token outside the model's tool responses, exposes only project tools, binds run creation to the assigned card, and excludes Git credentials, human review, chat posting and canonical publication. The Codex runner uses a read-only sandbox with shell, browser, apps, plugins and subagents turned off. The Claude runner turns off built-in tools, slash commands, browser integration, inherited MCP servers and hooks, and allows only the broker's tools. `runProjectAgent` takes `provider: 'codex' | 'claude'` and an optional model and executable. There is no automatic fallback between providers: an authentication or usage failure is a failure of that teammate.

The harness then performs a test-only human review, publishes the checked result, and deletes and restores a real attempt branch. That review stands in for the person; in the product, approval stays with a person. The runs recorded for the contest are described in [contest-demo.md](contest-demo.md#evidence). Use `AWAIT_STOP_BEFORE_PUBLICATION=1 AWAIT_KEEP_PROJECT_FIXTURE=1` to retain the checked result for a person to inspect and publish in the UI, without fixture approval. Add `AWAIT_DOGFOOD=1` to improve the two contributor guides against the current committed Await source, with unchanged tests and the production build as the independent check. See the demo guide for private fixture metadata and cleanup.

## Architecture and limits

`src/object/projects.ts` is the coordinator, mounted in the workspace Durable Object. SQLite holds the project, run, candidate, integration and event records; Artifacts holds the Git repositories. `src/worker/project-tools.ts` defines the MCP contract, and the same coordinator serves the web routes under `/api/workspaces/:id/collab/projects`. The project tables migrate in place inside the workspace database, in a transaction that preserves existing conversations.

A workspace can hold 100 projects and a project 32 runs. Event sequence numbers increase across the whole workspace, so a project's sequence can have gaps; follow the returned cursors instead of computing them.

There is no provisioning reconciler yet. If a remote fork succeeds but local finalization fails, a failed row keeps the generated repository name for operator recovery, and an interruption during provisioning can leave a row in `provisioning`. Token IDs and expiry times are kept for cancellation cleanup, but plaintext Git credentials are never stored in SQLite. To recover, clean up only the failed operation's repository, then start a new project or run with a new client ID.

References: [Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [Artifacts with the Sandbox SDK](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/), [direct Container API](https://developers.cloudflare.com/containers/api/durable-object-container/) and [Container scheduling](https://developers.cloudflare.com/containers/configuration/scheduling-policy/).
