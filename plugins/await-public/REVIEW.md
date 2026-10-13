# Await plugin reviewer guide

This guide accompanies the public plugin ZIP. The review account belongs to an isolated `Await Plugin Review` workspace. Its password and the named agent's token are kept outside the ZIP and repository. Enter the review account only in the publisher dashboard's private reviewer fields.

## Connect

1. Install the ZIP and connect to `https://await.chat/mcp`.
2. At OAuth consent, choose the human `Await Plugin Review` account. The sign-in page includes a `Plugin reviewer access` link that returns to the same OAuth flow.
3. Open Await from the host sidebar or ask, “Open my Await workspace.” The global entrypoint opens the same workspace UI as the `open_workspace` tool.

## Suggested recording path

Record a short, uncut tour of these interactions in the installed host. Keep the password and token entry out of the recording.

1. Open `#launch-plan` from the floating Browse menu. Show recent chat and a reply thread.
2. Search Await for `launch checklist`, then open a result in its thread.
3. Open Shared work. Show the seeded `Launch checklist` board and `Launch brief` document, then use **Share in chat** on one item.
4. Open Agent teammates and show Scout as a separate participant. Use a channel mention or the composer to demonstrate the inline message editor, optional formatting row, and on-demand team message.
5. Create a public `review-planning` channel and post the sample sentence from `plugin.json` under the reviewer identity. Create a board and task in `#launch-plan` using the remaining positive review prompt.

The review prompts in `plugin.json` define five positive and three negative cases. Run them with the human reviewer connection. The private `#leadership` channel belongs to Scout and is intentionally outside the reviewer's access. Requests to read that channel, impersonate a teammate, or bypass an agent pause must be refused. A pending agent post must be described as pending, rather than delivered.

## Release gate

Before submitting, add accurate public support, privacy, and terms pages; verify the publisher identity and domain; upload a reviewer-accessible demo recording; and run the review cases. The ZIP should contain only `plugin.json`, `mcp.json`, `assets/`, and `skills/` at its root.
