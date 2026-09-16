---
name: artifact-review
description: Open a delivered Markdown, HTML or LaTeX artifact in Marginote for local annotation and conversation with its original Codex, Claude Code or Hermes session. Use when the user asks to review, discuss, or collaborate on a delivered document in Marginote.
---

# Artifact review

Use the existing Marginote installation or this repository's built CLI. Do not install
packages globally, change provider settings, copy credentials, or restart unrelated agents.

## Open the document

1. Identify the existing artifact and the directory that should be the vault. Keep its
   project dependencies together. Markdown, HTML and LaTeX are supported. HTML reports
   retain local styles and scripts in an isolated preview; bundle remote dependencies
   locally when they are required. Select static rendered text or source to annotate.
2. Use an existing running Marginote server for that directory if its ownership and root
   are known. If its MCP tools are connected, `review_document` returns the review URL.
3. Otherwise start the installed `marginote` CLI with the directory, `--doc` (vault-relative
   path), `--port 0`, `--no-discover`, and `--open`. In a source checkout, build first with
   `npm run build` and use `node packages/cli/bin/marginote.js`. Keep the server running in
   the agent's supported persistent/background terminal. Give the user its printed URL
   and the stop command or terminal reference.

## Continue the original conversation

- Obtain the exact originating session ID and completed delivery boundary from the current
  runtime: a Codex turn ID, a Claude Code assistant message UUID, or a Hermes native
  `messages.id` row number for a completed active assistant answer. Never guess an ID, choose an unrelated
  recent session, or represent a summary as the original history.
- Add `--origin-session ID --origin-turn ID` to the launch command, or provide those IDs
  to `review_document` as `origin_session` and `origin_turn`. For Claude Code also pass
  `--origin-provider claude-code` (MCP: `origin_provider: "claude-code"`). Use proper shell quoting.
- For Hermes use `--origin-provider hermes` (MCP: `origin_provider: "hermes"`). The sibling
  `marginote-hermes` native plugin must be installed and enabled in the originating
  Hermes profile. Launch Marginote with that same profile environment; do not search
  other profiles or substitute a message ordinal for its native SQLite row ID.
- The human clicks **Connect conversation** after that delivery turn has completed.
  The server verifies the boundary, forks the native history, and saves the child ID.
  A currently active delivery turn cannot be attached yet; let the turn finish.
- If the exact IDs are unavailable, open the standalone editor and explain that the
  original conversation is not attached. Do not claim a completed conversation handoff.
- Human comments and follow-ups continue one child session per artifact. Respect
  existing model and tool permissions. Never answer your own approval requests.
- The native continuation attaches `marginote_read_document` and `marginote_suggest_edit`
  automatically. Read the current revision, then propose a unique exact replacement.
  Document locks, budgets and attribution apply; the human accepts or rejects it in
  the browser. Use these tools for artifact changes instead of filesystem edits, which
  do not enforce the editor's policies. Never claim an unaccepted suggestion is saved.
  Hermes may defer these schemas: use native `tool_search`/`tool_describe` to discover
  them and `tool_call` with their exact names when needed.
- Keep discussing a thread after its original passage is replaced. Its historical quote
  remains labelled as deleted; new edits must locate the current source explicitly.
- On an interrupted/uncertain turn, inspect the child session before retrying because
  its tools may already have run. Do not reconnect to the parent as a fallback.

## Current boundaries

This plugin includes Codex and Claude Code entry points. Claude's native fork and SDK/CLI
initialization are verified with synthetic sessions; live-model continuation is still
unverified. Hermes has native snapshot and continuation checks using a local fake model,
including real artifact tools and a denied native permission. Its external-model workflow,
automatic delivery hooks and enforced native edit routing remain unverified or unfinished.
The standalone editor keeps its optional pi agent mode.
