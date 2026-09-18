# Artifact conversations

## Working increment

A document can own a **native Codex, Claude Code or Hermes child session** forked from an exact
completed delivery boundary. Subsequent human comments share the child history.
The original session is not prompted. pi remains the standalone editor's agent and is
suppressed for bound documents.

Start from a built checkout:

```sh
node packages/cli/bin/marginote.js /path/to/project --port 0 --no-discover \
  --doc report.md --origin-session EXACT_SESSION_ID --origin-turn EXACT_TURN_ID --open
```

Use IDs obtained from the originating runtime, not the most recently used session.
CLI origin flags connect automatically; `--no-connect` retains a manual button. For an existing MCP
connection, `review_document` creates the same link. Opening a link alone does not fork
or call a model. Connecting forks native history without starting a model turn. New
human comments then use the originating installed/authenticated agent. Codex is the
default. For Claude Code, add `--origin-provider claude-code` and supply its session UUID
and completed assistant message UUID. MCP uses `origin_provider: "claude-code"`.
For Hermes use `--origin-provider hermes` and its native `messages.id` row number as
`--origin-turn`; MCP uses `origin_provider: "hermes"`. The native Hermes plugin must be
enabled in the originating profile, and Marginote must inherit that profile environment.

Inside Hermes, prefer `hermes marginote report.md` in a background terminal. The native
launcher infers the calling session and captures its current message boundary, then waits
for that session's next completed answer before connecting. Finish the launching turn
after sharing the printed URL. It never creates a placeholder chat or chooses a recent
session. The page exposes the inherited model, provider, reasoning effort and history counts.
See the plugin's one-time `--setup` option if the existing Marginote CLI is not on PATH.

## Runtime contract

- In Codex, `thread/read` validates that the delivery turn exists and completed; `thread/fork`
  pins `lastTurnId`. The returned child must be distinct and name the expected parent.
- Every Codex comment run uses `thread/resume` on that child, then `turn/start`. Codex
  0.151.0 can otherwise select the current profile default model on fork/resume. Marginote
  therefore reads the exact delivery's recorded model, provider and explicit reasoning
  effort from the native rollout path returned by `thread/read`, and passes them to both
  operations. The returned model/provider must match before a turn starts. Missing or
  unsupported metadata fails explicitly. No sandbox or approval override is sent.
  History stays in Codex's native store; the rollout is read-only and bounded to 64 MiB.
- Each Codex run attaches a short-lived authenticated loopback MCP server through a
  process-local configuration override. Its two tools read the bound artifact and
  propose exact replacements against a freshly read source revision. Native tool
  discovery must succeed before a Codex model turn starts. Global Codex configuration is
  not edited, and the capability is revoked when the run ends or is cancelled.
- Proposed edits reuse the editor's section locks, read-only policy, character budgets
  and attribution. They appear live as suggestions; disk content changes only when
  a human accepts them. Rejection preserves the original text. A stale revision or an
  ambiguous source passage requires a fresh read instead of guessing an edit target.
- If accepting a replacement deletes a comment's original anchor, its old quote and
  `anchor deleted` label remain visible. New human replies still continue the same
  artifact conversation. Any subsequent edit must locate current source explicitly.
- `.marginote/conversations.json` stores routing, processed comment fingerprints,
  the latest response per comment for crash recovery, and uncertain run state. It is
  private local metadata (0600), excluded from the vault and git. It is not a transcript
  export. Native child sessions remain in their agent's store after disconnection.
- Runs serialize per document. Responses are persisted before publication. On restart,
  an in-flight run is marked uncertain and is **not automatically retried**. A persisted
  response can be restored without repeating its tools.
- Command approval and file changes with reviewable diffs pause in the web interface.
  The human can approve once or decline. Unsupported callbacks (including interactive
  tool questions and permission-profile grants) fail closed and point to the native
  client. No session-wide or automatic approval is emitted.
- Conversation endpoints are loopback-only and protected by the existing host/origin
  checks. Native process launch commands cannot be set by HTTP clients.
- Binding is exclusive. Existing comments are a baseline; only new comments and human
  follow-ups trigger work. Rebinding requires disconnection. Renaming follows the route;
  deletion pauses it so a replacement file does not silently continue old work.
- A runtime lease is acquired on the canonical vault before reading collaboration
  state or dispatching agents. A second server, including one using a symlink alias,
  exits with an ownership error. Closing releases the lease after document flushing.
  A crashed process's lease expires after two minutes. Loss of ownership aborts agent
  work and stops the server. This is a local runtime safeguard, not distributed fencing;
  do not remove the lock manually or run a vault from multiple hosts.

## Evidence and remaining work

### Claude Code adapter

The official `@anthropic-ai/claude-agent-sdk` forks through the exact completed assistant
message with `forkSession(..., { upToMessageId })`. Marginote verifies the inherited
message payloads against the original prefix while allowing native UUID remapping.
Subsequent runs resume that child with the last recorded assistant model, original cwd
and the user's installed `claude` executable. No provider environment, system prompt,
permission mode or settings-source override is applied. Routing is persisted per artifact;
there is no cross-provider fallback.

The same ephemeral artifact MCP tools are attached. Claude initialization must report
them connected; unlike Codex's explicit pre-turn inventory check, this is checked while
consuming the query stream. Native permission requests are shown with their tool name
and exact input for one-time approval. Unsupported interactive questions/plan transitions
fail closed. Existing native permission rules can still authorize filesystem tools.

On 2026-09-16 official SDK 0.3.272 forked an isolated synthetic transcript with exactly the
delivery prefix, remapped UUIDs and byte-for-byte unchanged source. The installed Claude
CLI 2.1.243 also completed the SDK initialization handshake without a prompt or model turn:

```sh
npm run build
MARGINOTE_CLAUDE_PROTOCOL=1 node scripts/check-claude-fork.mjs
# After build:release, verify the bundled CLI's real local binding endpoint too:
MARGINOTE_CLAUDE_RELEASE=1 node scripts/check-claude-fork.mjs
```

The bundled CLI also passed the native fork and HTTP binding check against that isolated
fixture. These checks do not prove live-model continuation. The deterministic browser workflow
uses all three provider routes, including proposals, acceptance and orphaned-comment replies.
The shared plugin includes `.claude-plugin/plugin.json`; it can be checked locally with
`claude plugin validate plugins/marginote`. See the official
[plugin reference](https://code.claude.com/docs/en/plugins-reference) for installation.

On 2026-09-18 `node scripts/check-claude-runtime.mjs` also passed with the installed
Claude Code 2.1.243 and SDK 0.3.272 against a local streaming model fixture. It verifies
the exact inherited history/model, excludes later parent messages, calls the real artifact
read/propose tools, checks disk preservation until acceptance, resumes in another process,
and declines a native deletion request. The original transcript remains byte-identical.
It uses a disposable Claude configuration and synthetic credentials, not an external model.

### Codex and shared workflows

Protocol and lifecycle tests cover fork boundary, child-only resume, early notification
ordering, approval decisions, cancellation, restart recovery, and pi/external routing.
They use deterministic providers and real subprocess protocol fixtures, not live models.

On 2026-09-16 the installed Codex app-server also passed a native fork check: the child
contained exactly the two turns through the selected completed boundary; SHA-256 hashes
of inherited items matched the original prefix, and the original items were unchanged.
The validation child was archived. This check did not invoke a model or verify editing.

The opt-in Chromium test `e2e/codex-live.spec.ts` subsequently passed with the installed
Codex and its real configured model. A synthetic source session recorded a random code;
the code was absent from both the document and the browser's question. The native child
recalled it from inherited history, then answered a second browser follow-up in the same
session. The source's items remained unchanged, and both test sessions were archived.
The extended test also passed on 2026-09-16 after explicit authorization for real model
calls. It verified model-driven read/propose tools, model/author attribution, unchanged
disk content before acceptance, browser acceptance, and a same-child follow-up after
the original comment anchor disappeared. The original conversation's items remained
unchanged. Both synthetic sessions were archived and the temporary report removed.
This is one successful Codex live-model workflow, not evidence of Claude/Hermes live
behavior or enforcement against other native filesystem tools.

The deterministic Chromium workflow verifies suggestion display, disk preservation
before acceptance, acceptance and follow-up on the original orphaned comment. Unit and
protocol tests additionally verify stale reads, locked/read-only documents, attribution,
rejection, request authentication and capability revocation. The installed Codex's own
MCP client has passed read/propose/accept against a temporary report without invoking a
model. From a source checkout, reproduce that local native-protocol check after building:

```sh
node scripts/check-native-tools.mjs
```

An empty native test session has no persisted rollout, so this local check intentionally
does not prove cross-process resume or model-driven tool use.

`node scripts/check-codex-runtime.mjs` adds full local native coverage with Codex 0.151.0:
it creates a real persisted source using a loopback Responses fixture, forks only through
the selected completed turn, exercises native read/propose/accept, and resumes the child
in another app-server process. Changing the profile-default model after delivery must not
change the child's recorded model. The original rollout remains byte-identical and no
real credentials or external model are used. These checks cover native protocol behavior;
the fixture chooses tool calls deterministically, so it does not test model judgment.

### Hermes native adapter

The separate `plugins/marginote-hermes` package now prepares an exact delivery snapshot
through native `SessionDB` APIs. Its child preserves active model context, tool/reasoning
sidecars and searchable compacted history. Source sessions remain independent. Tests run
against temporary native databases and the installed Hermes plugin discovery and TUI lazy
resume paths; no model is started. See the [Hermes plugin contract](../plugins/marginote-hermes/README.md).
The browser now routes Hermes comments to a dedicated `hermes marginote-bridge` process.
This is local stdio JSON-RPC, with native plugin tools; no separately configured MCP
server is needed. Comments get an immediate receipt when processing begins. Resolve/Reopen
preserves the thread instead of deleting it.
It resumes only the verified child through native TUI protocol handlers, validates the
restored model/provider/endpoint, and registers the two artifact tools for that process.
Native Tool Search and existing tool selection remain in use. Tool attribution refreshes
from the current native model before each artifact action, including after native fallback.
Explicit native approval requests become one-time browser decisions; other interactive
requests fail closed. Shutdown interrupts only the bridge's own running session and
does not run the native entry point's profile-wide orphan sweep.

On 2026-09-16 the installed native Hermes CLI, AIAgent and tool system passed an isolated
test against a local fake model: inherited history, real Marginote read/propose tools,
human acceptance, a second-process follow-up, and a denied native terminal permission.
The original session's rows and metadata remained unchanged. Run with Hermes's own Python:

```sh
python3 scripts/check-hermes-protocol.py
/path/to/hermes/venv/bin/python scripts/check-hermes-launcher.py
/path/to/hermes/venv/bin/python scripts/check-hermes-runtime.py
```

This verifies native integration with deterministic model responses, not a real external
model's behavior. Native prompt assembly still applies; copying a cached source system
prompt does not promise that the next model request has byte-identical system instructions.
The adapter depends on native TUI internals and fails closed if compression rotates its
durable child ID. Multiple Hermes profiles in one Marginote server are not supported.

### Opt-in Codex model check

Run this only when real model calls are intended:

```sh
npm run build
MARGINOTE_LIVE_CODEX=1 npx playwright test e2e/codex-live.spec.ts --project=chromium
```

The complete product still needs:

1. Live-model validation and stronger control of native edits. Marginote's edit tools
   are attached and enforce document policies, but native filesystem tools retain their
   original permissions and can bypass those policies. The continuation prompt directs
   artifact changes through Marginote; this instruction is not an OS access boundary.
2. Claude Code and Hermes live-model validation and continued compatibility checks of
   their native interfaces; never silently switch them to Codex or pi.
3. Automatic delivery lifecycle integration and a portable background launcher. The
   current link requires explicit session IDs and a browser connection action.
4. Broader artifact workflows and UI polish. HTML source editing, isolated preview,
   source-mapped annotations and conversation routing are now implemented; see
   [HTML artifacts](html-artifacts.md) for capabilities and boundaries.

The repository plugin under `plugins/marginote` is an initial Codex/Claude skill package,
not a claim that the full cross-agent product is finished.
