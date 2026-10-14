# Repository tools dogfood, October 13, 2026

This is a development run on actual Await source, using authenticated Claude and Codex CLIs through a project-scoped Await MCP broker. The models ran outside the hosted containers. They received real assignments and wrote code through Await hosted commands. The local test workspace used a fixture reviewer identity; it did not represent a person's publication approval.

## Source and contributions

Source baseline: `ef65a4c6dbb6d4c367d584f27574567d4e38ae68`. The committed source was archived without credentials or generated output and seeded into Artifacts. Its Artifacts base was `3d2e422bf2c6d860fcd7c55b12e6241975987a39`.

Claude implemented the pinned repository reader, result types, eight focused tests, and the tool contract documentation. Its candidate was `49af7ad221df8e961d694cdf91286490c709fd86`. Codex implemented coordinator routing, compact receipts, MCP schemas and routes, and the read-only provider broker. Its initial candidate was `44fbaf8f093a5e1e0be2907f5a7e80500d5d7c7a`.

The first combined revision, `dd9167518938365feee9f21964723504181fd2c9`, passed `npm ci && npm ci --prefix webhook-gateway && npm test && npm run build && git diff --check` in a fresh hosted checkout. It passed 161 main tests and 4 gateway tests. The independent check does not establish that all accepted cases are covered: the harness review requested further authorization, revocation, receipt and broker tests.

## Observed friction and corrections

- Early mutation commands returned shell exit zero despite a failed edit earlier in the command. The harness recorded the issue in Await and requested fail-fast commands, source inspection and independent combined checks. A job receipt proves the shell result; it is not semantic evidence that every intended edit occurred.
- The two contributors briefly disagreed on the helper result shape. One wired the first proposed contract after Claude had changed it. The harness identified the mismatch; the final direct result and thrown error contract was used in the checked integration.
- The original project responses became too large for Claude to read. It retrieved specific job receipts by retrying identical command IDs. Dedicated stored receipt reads remove that workaround.
- On the same project, an initial compact response measured 75,416 UTF-8 bytes against 419,740 full bytes, about 82% smaller. This is one payload observation, not a latency or scaling benchmark.
- A compact response with the entire event history still overflowed Claude's client output limit. Advancing a cursor reduced the response, but an artificially future cursor would miss future coordination. Bounded event pages and a safe cursor were requested after this actual verification.
- The hosted Debian runtime had no `rg` or `apply_patch` binary. Several model commands failed before the model used available Node and ordinary shell tools. Remote capabilities need explicit guidance; local model tool helpers are not automatically present in a container.
- A successful command creates its Git checkpoint after the shell exits. A `git log` printed inside the command therefore names the preceding HEAD. The receipt SHA names the new checkpoint. This difference is expected.

## Final reviewed revision

Codex's final candidate is `326701abada058c0be1eb9316d107a86ecbb5a62`. Await combined it with Claude's candidate into `3993ed8e6da8133a596efccf3c86ba61b4a47789`, integration `30bebf44-413a-48de-ac90-29f148fe7c83`. That exact combined revision passed the unchanged configured check command in a fresh hosted checkout: **168 main tests, 4 gateway tests, TypeScript and the production build, and the final diff check**.

An earlier combined check passed its tests but failed TypeScript on duplicate declarations left by an edit retry. The failure blocked that revision. Subsequent candidates corrected the declarations and used real full/compact object branches instead of type intersections. Live HTTP checks also caught the Worker edge allowlist rejecting new browser URLs; the reviewed version admits exactly the new tree, source-file, job and integration receipt shapes.

The final compact snapshot uses explicit pages: 20 events and 20 job summaries by default. Jobs have a separate jobs_page record and deterministic ordering, and older jobs remain readable by exact ID. Legacy full-output and browser snapshots retain their original defaults. A 45-job fixture verifies page boundaries, tied timestamps, no duplicates or gaps, metadata equivalence, older receipt reads, input bounds, and unchanged legacy behavior up to its 100-job cap.

## Read-only provider verification

Both providers then used all four new tools against their own pinned candidates and read the successful combined integration receipt. The harness exposed only read tools, bound each provider to its existing run, and checked the actual provider traces for output overflows and built-in tool attempts.

| Provider | Source SHA | Actual read-tool requests | Outcome |
| --- | --- | --- | --- |
| Claude | `49af7ad221df8e961d694cdf91286490c709fd86` | identity 1, compact project 1, tree pages 2, file 1, job receipt 1, integration receipt 1 | All requested checks verified; no MCP output overflow; no built-in requests |
| Codex | `326701abada058c0be1eb9316d107a86ecbb5a62` | identity 1, compact project/event pages 10, tree pages 2, file 1, job receipt 1, integration receipt 1 | All requested checks verified; no MCP output overflow; no built-in requests |

Each provider's jobs, run and candidates were unchanged across verification. Claude's earlier attempts had truthfully left compact metadata unverified because it could not read the output. Event pagination alone was insufficient at 66 jobs. Paging job metadata made the final default response consumable without increasing client limits or enabling built-in tools.

## Independent live acceptance

The harness checked the actual local HTTP and MCP endpoints against real Artifacts and hosted receipts after all jobs settled:

- The default compact snapshot was **45,166 UTF-8 bytes**, compared with **967,188 bytes** for the legacy full-output snapshot: **95.33% smaller** on this project. These defaults page different amounts of event/job metadata; this comparison measures the resulting response, not an isolated compression algorithm.
- All 73 job metadata records were traversed without duplicates and compared with full stored receipts. All 5 integration receipts matched the legacy snapshot. Status, commit, exit code, image and timestamps were preserved, and compact commands/stdout/stderr/error were absent with explicit omission markers.
- All 193 project events were traversed without duplicates. Compact event pages omitted execution commands, and an artificially future cursor returned the current watermark.
- Directory pages and source content were pinned to the exact full SHA. Six unsafe paths, four invalid commit/pagination inputs, a peer agent's active-run read, and another project's job and integration IDs were refused.
- A human channel member could inspect the run through authenticated browser HTTP. All four new browser endpoint shapes returned successfully. The browser project snapshot retained full commands and receipts.
- A 352,240-byte font returned `too_large` metadata, and the 7,808-byte favicon returned `binary` metadata. Neither returned partial text.
- Project jobs, runs, candidates, integrations and the event watermark were unchanged across the read-only acceptance checks. Unit tests separately assert no token issuance or revocation and force channel removal during successful and failing repository calls.

The public review branch also passed tests and the production build in a separate checkout with dependencies installed from the lockfile. The same functional files were compared with the pinned Await result before copying. The public branch includes this report and recording guidance as reviewer-authored documentation.

## Limits

This run is local development against real Artifacts and hosted execution. It is not a production deployment, a general performance benchmark, or a proof of arbitrary agent scale. The exact Await integration remains available for a person to review; the harness does not approve publication on their behalf. Private transport configuration and tokens are excluded from this report.
