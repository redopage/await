# Production dogfood: bounded source pages

Run date: October 14, 2026 UTC (October 13 in Chicago).

PR #1 was reviewed, merged into public main at 3ecf144ac3995ea56c16d8baa1e4f5fdd63419c4 and deployed to https://await.chat as Worker version fc9a573b-cdb5-4705-b04a-06bf8af80542. Live discovery exposed the four repository/receipt tools. Real production source reads succeeded for their owners and rejected peer-run and unsafe-path access; compact status and exact job receipts worked.

The next task used that deployed HTTPS service, actual Cloudflare Artifacts repositories and hosted containers. It imported the merged public source into the existing isolated Await Plugin Review workspace and a private runtime-dogfood channel. Setup used the existing test reviewer account to create requirements and assign cards. Actual Claude and Codex CLI sessions authored and tested implementation changes in separate owned runs. Their model processes stayed outside the containers and received only project-scoped Await tools. No model was replaced by a deterministic fixture.

The task fixed a usability problem from the prior rehearsal: whole-file source reads can exceed provider output limits. Optional start_line and line_limit now return complete original lines, capped at 200 lines and 16000 UTF-8 bytes, at an exact commit. The legacy whole-file response remains unchanged. Oversized first lines are explicit metadata-only results and retain the unread cursor; clients stop before choosing a later line. UTF-8, CRLF and BOM bytes round-trip. A shared validator rejects bad ranges before a repository handle is opened.

| Contributor | Owned work | Final candidate source SHA |
| --- | --- | --- |
| Claude runtime engineer | Helper, shared types, helper tests and reader guide | 0b1a3f74aa9a7390852fb19cced4f84d7d714f5d |
| Codex runtime engineer | MCP parameters, coordinator prevalidation, broker guidance, access tests and contributor guide | f563a994622db134dd91e804b8304a054b96ae6c |

The coordinator supplied assignments and review clarifications, including unread-line semantics and byte-order-mark preservation. The contributors exchanged and acknowledged contracts through Await project events. Reviewer-guided changes are part of this record, rather than evidence of an unattended implementation.

## Checks and failures

- Final production integration: 1066c515-41eb-4087-898f-4c5edd9a94fd, checked combined SHA ecfc6d0244d2c45c9d62ad69b2c20ab09a1821d0, ready with exit code 0. The configured fresh-container command was npm ci && npm ci --prefix webhook-gateway && npm test && npm run build && git diff --check.
- All 177 main tests and 4 gateway tests passed, followed by TypeScript and the production build. The separate public checkout also passed lockfile installation, the complete suite and build. All ten model-authored source files matched the exact combined result before adding this evidence documentation.
- An independent randomized exercise of the unchanged paging algorithm round-tripped 150 text files across 404 pages using seed 123456, including Unicode, BOMs and mixed newline bytes.
- A build first failed because the compiler was absent. A subsequent install/build job hit its four-minute deadline and retained a failed receipt with Network connection lost. An edit heredoc also failed with a ReferenceError; a later command repaired it.
- One diagnostic checkpoint exited 0 after bare npx tsc downloaded an unrelated package. It was not accepted as build evidence. The later repository compiler and independent combined checks established build success. Guidance now distinguishes warm container reuse from the loss of untracked dependencies on a cold restart.
- Integration c1766632-291b-4292-99bf-5660d11ca4e0 failed a new strict access test with 2 !== 1: bad range arguments reached Artifacts.get. Claude and Codex retained that assertion and added shared prevalidation before the handle opens. Later integrations passed.
- Initial read-only Codex verification passed. Claude consumed the default compact snapshot, then requested 100 events after cursor 20 with one job row. The 55459-character response exceeded its client output limit; it then skipped events 21 through 56. This failed our verification, despite its otherwise positive report. We preserved private failure evidence, added smaller-page and same-cursor recovery guidance for both roles, and required complete sequential event coverage in the retry. We did not raise the provider output limit or enable built-in tools.

## Final production read-only verification

Both actual providers used all four deployed tools, plus identity and compact status reads. They listed a pinned root in two pages, read their own exact candidate source, retrieved their successful exact job receipt, and inspected the final independent integration receipt. The verifier checked tool arguments, event coverage, client overflow, built-in attempts and unchanged owned jobs, runs and candidates.

| Provider | Events read sequentially | Identity | Compact status | Directory pages | Source reads | Job receipts | Integration receipts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude | 85 | 1 | 9 | 2 | 1 | 1 | 1 |
| codex | 85 | 1 | 18 | 2 | 1 | 1 | 1 |

Final verification began with event_limit 10 and job_limit 5. Claude read all 85 events with no overflow. Codex reported combined output clipping around cursor 40, then replayed every remaining range with five-event pages from that same cursor. Both consumed the complete timeline, with no built-in attempts or owned work-state mutations. We reviewed model reports as well as SDK envelopes, because a completed tool call alone does not prove the model saw all of its output. Optional pages remain bounded by row count, not a guaranteed provider token budget.

The new line-range parameters are present in this follow-up source and its fresh-container API tests. They are not deployed by this record; live production remains the PR #1 release. The final Await result stays ready for human review, with reviewed_by null and no canonical publication. Test account setup and machine checks do not stand in for a person approving it.

## Lessons carried forward

- Keep source, shared contracts and checks pinned to exact commits. A successful edit checkpoint is not proof of combined correctness.
- Treat tool output size and cursor recovery as product behavior. Optional large pages can overwhelm a client even when default compact snapshots work.
- Use bounded file reads for inspection and exact receipts for results, keeping model context separate from container execution.
- Add waitable job status next. The coding sessions spent many calls polling asynchronous commands; receipts preserve the outcome but do not yet provide an efficient wait primitive.

Raw model transcripts, reviewer credentials, session cookies and agent tokens remain in ignored private storage. This report contains source revisions and summarized evidence only.
