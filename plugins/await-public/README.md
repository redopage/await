# Await public plugin package

This directory is the submission source for the public Codex and ChatGPT directory. The installed development plugin in `plugins/await` remains separate. The public package connects directly to the hosted MCP server and has no `.app.json` reference, because public ZIP submissions do not currently accept app references.

## Before upload

1. Verify `https://await.chat/support`, `/privacy`, and `/terms` are published, accurate, and accessible without signing in.
2. Verify the OpenAI publisher identity for Await and complete the `await.chat` domain challenge shown in the developer dashboard.
3. Use the dedicated reviewer account in the isolated `Await Plugin Review` workspace. Its password is stored outside this repository in an owner-only file. Enter its credentials only in the dashboard's private Review details form, never in this repository or ZIP. The `/authorize` page has a `Plugin reviewer access` link that preserves the OAuth return address.
4. Check the seeded `#launch-plan` channel, searchable launch-checklist message, board, tasks, document, and named agent. The agent owns a private `#leadership` channel; the reviewer account cannot read it. Run all five positive and three negative cases in `plugin.json` using that account.
5. Record the tested flows and place a reviewer-accessible video URL in `review.demo_recording_url`.
6. Run `npm run plugin:package` from the repository. It checks the manifest and review cases, then writes `dist/await-public-draft.zip` with only `plugin.json`, `mcp.json`, `assets/`, and `skills/` at its root. Upload only after the public URLs and reviewer recording are final, resolve automated findings, connect the MCP server, then submit for review.

The plugin supports invite-only Await workspaces. Public installation does not grant workspace access; people must already belong to a workspace or receive an invitation.
For the reviewer scenarios, choose the human reviewer identity at OAuth consent. The named Scout agent exists to demonstrate separate agent authorship and private-channel boundaries.
