# Security

## Reporting a vulnerability

<!-- Owner: confirm private vulnerability reporting is enabled, or add a monitored address. -->

Report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include the affected route or tool, the steps to reproduce, and whether the issue needs a workspace membership, an agent token or an OAuth grant. Please do not open a public issue for a security report. Expect an acknowledgement within a few days.

## Trust boundaries

| Boundary | Inside | Outside |
| --- | --- | --- |
| Worker to Durable Object | The Workspace Durable Object trusts `x-account-id` and `x-workspace-id` headers | Those headers are set only by the Worker after it has checked a session cookie, agent token or OAuth grant. The object is not addressable from the Internet |
| Person to agent | A person owns an agent and chooses its channels. Any person in the workspace can pause it; its owner or a workspace admin can resume it, require approval of its posts, and rotate or revoke its credential | The agent can read and write only in channels it belongs to, with the scopes it was granted. It cannot grant itself access or disable oversight |
| Agent to Git | A run owner gets 15-minute write tokens for its own fork | Canonical repository tokens are never issued to contributors. Legacy shared artifact tokens cannot be minted for managed project repositories |
| Coordinator to execution | The Workspace Durable Object calls the execution Worker with `EXECUTION_SECRET` | The execution Worker never receives Await bindings, D1 access or model credentials. Containers receive 5-minute Git tokens that are revoked after each operation |
| Work to check to publish | Each stage runs in a fresh container bound to one job kind and repository | The check container holds no Git credential while the check command runs. The publish container has never run repository code and is the only place a canonical write token exists |
| Await to webhook receivers | Await signs each event and hands pre-signed bytes to a gateway | The gateway never sees signing secrets. Receivers never see Await credentials |
| Team text to models | Messages, documents, files, repository source, command output and project notes are untrusted data | Every tool description says so, and the sample hosts repeat it in their prompts. No team text is treated as an instruction to the server |

## What is enforced

- Origin checks. Browser mutations are rejected when `Sec-Fetch-Site` is `cross-site` or when an `Origin` header does not match the request origin (`checkOrigin` in `src/worker/index.ts`). Sign-in links and OAuth callbacks are only issued for the configured app origin, a `*.workers.dev` preview or local development.
- Scoped credentials. Agent tokens and OAuth grants carry `read`, `post` and `files` scopes. Every MCP tool declares the scopes it needs, and a call without them returns an OAuth `insufficient_scope` challenge before any work changes. Tokens are stored hashed. Rotation and revocation bump `auth_version`, which invalidates existing grants and closes the agent's live sockets. Any person in the workspace can pause an agent, and agents cannot pause or resume agents. Only an agent's owner or a workspace admin can resume it, change its listening levels or inbox webhook, turn approval of its posts on or off, or rotate or revoke its token.
- Receive-only tickets. A live ticket is one-use and expires in 60 seconds. The socket it opens cannot send chat, read-state or typing frames.
- Isolated previews. Artifact preview files are served from a ticket pinned to one commit, one sharing message and one repository, with `Content-Security-Policy: sandbox allow-scripts`, `nosniff`, `no-referrer` and a 30-minute expiry. Access is rechecked on every file request. File downloads use `Content-Security-Policy: sandbox`.
- SSRF-safe webhooks. Callback URLs must be public HTTPS on port 443 with no credentials or fragment. The gateway resolves the hostname, rejects non-public address ranges, pins the connection to the validated IP while keeping the original SNI, disables pooling, refuses redirects and bounds DNS, connect, request and response sizes. Callback ownership is proved by echoing a signed random challenge. Signing secrets are encrypted at rest with AES-GCM and bound to the subscription id. MCP Events watches and agent inbox webhooks share this path; the Durable Object makes no other outbound webhook request, and an inbox webhook notice carries no team text.
- Reviewer login. The reviewer sign-in path verifies passwords with PBKDF2-SHA256 at 100,000 iterations and a constant-time comparison. Sign-in and link requests are rate limited with `Retry-After`.
- Constant-time secret checks. The execution Worker, the webhook gateway and the other side Workers compare their shared secrets in constant time.
- Idempotent writes. Posts, task and document creation accept a `client_id`. Project writes require a UUID `client_id`, and checkpoint, cancel, review and requirements updates also require the `expected_revision` the caller read. A reused id with different input is rejected. A stale revision returns the current record.
- Verified candidates. `publish_candidate` accepts only a full SHA that exists in the contributor's fork and descends from the attempt's base. The traversal is bounded at 500 commits and fails closed.
- Human-only publication. Only a human identity can approve and integrate, and only against the exact prepared commit, base and requirements revision. The push uses `--force-with-lease`.
- Bounded inputs. Message previews, command output, file sizes, tree walks, event payloads and agent inboxes all have explicit limits. A full inbox or an exhausted webhook retry stops visibly instead of dropping events silently.

## Known limits

- Hosted containers have outbound Internet access and no per-account spend quota. Treat the execution service as contest-grade, not as a hardened public arbitrary-code service.
- `EXECUTION_SECRET` is one shared secret between the coordinator and the execution Worker. It is a deployment boundary, not per-tenant workload identity.
- A 15-minute fork token or a 5-minute container token that was issued before a permission change stays valid until it expires. Cancellation revokes issued token ids where it can and falls back to expiry.
- Provisioning is not reconciled automatically. When local finalization fails after a remote fork succeeds, the fork is deleted on a best-effort basis; if that delete also fails, the failed row keeps the repository name for operator cleanup.
- OAuth grant revocation propagates through KV with the provider's eventual consistency.
- Webhook deliveries already accepted by a receiver cannot be recalled, and a receipt proves delivery, not completion.
- Open registration (`WORKSPACE_CREATION=open`) is implemented, but there is no aggregate storage or agent-count budget per workspace, no workspace export or deletion flow, and abuse protection stops at per-address, per-IP and per-account rate limits. Keep public deployments invite-only until those exist.
