# Marginote Hermes integration

This experimental plugin, included in Marginote 0.2.0, implements native delivery snapshots and browser conversation
continuation, including scoped artifact tools and one-time native permission decisions.
The Codex/Claude launcher skill is in the sibling `marginote` directory.

## Local setup

Install a persistent CLI with `npm install -g marginote@0.2.0`. Run `npm root -g` to
locate the installed packages; this plugin is the `marginote/plugins/marginote-hermes`
directory under that path. Copy the whole plugin directory, not just `__init__.py`.
For a source installation, use `plugins/marginote-hermes` in the checkout instead.

Place this entire directory at `plugins/marginote-hermes` under the **originating Hermes
profile's home**, then run `hermes plugins list` and `hermes plugins enable marginote-hermes`
in that profile. Keep any existing installation until you have reviewed an update. The
checks use disposable profiles; updating this checkout does not update an installed plugin.
The default profile home is `~/.hermes`; named/custom profiles must use their own home.
Installing a newer npm package does not replace a previously copied Hermes plugin;
update that copy separately, preserving any local changes.

Inside the originating Hermes conversation, ask the agent to run this in a background terminal:

```sh
hermes marginote report.md
```

The launcher uses `HERMES_SESSION_ID` from that command's native session environment,
keeps the profile, chooses a free local port, opens the document and connects automatically
after the current answer is saved. The agent should give you the printed URL and finish its
answer, not wait for connection in the launching turn. The page displays Connecting, then
Ready, the inherited model/provider/reasoning level and the copied history counts.
Do not create a throwaway `hermes chat` just to obtain session IDs: that only inherits the
throwaway chat's history. Existing comments are not replayed; comments posted while connecting
are queued. Each new request gets a `👀 received · reading…` receipt, followed by the answer.

If `marginote` is not on PATH, point the plugin at the existing built installation **once**:

```sh
hermes marginote --setup /path/to/marginote/packages/cli/bin/marginote.js
```

This records only the plugin's CLI command in the current profile's settings. It does not
install packages or change model settings. Use `--root /path/to/project` when dependencies
need a larger vault, or `--no-open` to print the URL without opening a browser. Outside an
active Hermes turn, supply `--session EXACT_ID --turn COMPLETED_ROW`; absent identity fails
explicitly. The launcher never chooses a most-recent session. A vault already served by
Marginote must reuse that server's URL or be stopped before launching another server.

The lower-level CLI still accepts `--origin-provider hermes --origin-session EXACT_ID
--origin-turn COMPLETED_ROW`, paired with `--doc`. Origin flags now auto-connect;
`--no-connect` retains the manual Connect button. No separate MCP configuration is required:
the server invokes `hermes marginote-bridge` over local stdio JSON-RPC, and the plugin adds
the two artifact tools directly to the native agent.

The native CLI selects the profile normally, including inherited `HERMES_HOME`. The
adapter does not scan other profiles, copy credentials or restart a gateway. One server
uses one Hermes profile. The launcher waits for a completed answer in that exact session;
if compression rotates it while waiting, reopen review from its current session. Missing
native APIs or profile data fail explicitly.

## Native preparation contract

The plugin registers `hermes marginote-bridge` using Hermes's native plugin API. It reads
the current profile's existing `state.db` through `SessionDB`. A client supplies the exact
session ID and a positive integer `messages.id` for a completed active assistant answer.
Do not substitute a display ordinal, session title or most-recent session.

Each fork creates a separate native child with the source's recorded model, routable
provider, runtime configuration, working directory and cached system prompt. Source rows
through the delivery retain their payloads, tool calls/results, reasoning sidecars and
API content. Compacted rows, including old compression ancestors, are copied as searchable
archives; they are not reactivated as model context. Undo/rewind rows stay excluded.
The child is marked as an explicit branch so later parent messages cannot enter its history.

Every copied payload is checked against the source. A concurrent source change or native
serializer mismatch discards the newly created child and reports failure. The source is
never ended, rewound, reparented or prompted. Required native APIs and provider metadata
must exist; missing information does not select another provider. Limits are 20,000 rows,
64 MiB and 100 compression ancestors. A delivery already compacted away is refused because
the current native store cannot prove its original live-context boundary.

The protocol is local stdio JSON-RPC, one object per line, requests at most 1 MiB:

```json
{"id":1,"method":"initialize"}
{"id":2,"method":"fork_delivery","params":{"sessionId":"EXACT_ID","messageId":123}}
```

The first response declares `protocolVersion: 1` and `capabilities: ["fork_delivery", "wait_delivery", "prompt"]`.
The second returns the new `sessionId`, origin, delivery row, model, cwd and message counts.
It never returns credentials or transcript contents. Clients cannot choose a database path.

## Native continuation contract

`prompt` resumes only the verified child, using a dedicated native TUI dispatcher process
and eager agent construction. It validates the restored model, provider and endpoint.
It preserves native tool selection and adds only the process-local `marginote-artifact`
toolset. Deferred tools remain available through native Tool Search. Reverse RPC calls
`marginote/model`, `marginote/tool` and `marginote/approve` route attribution, the two shared
artifact tools and reviewable native permission requests to Marginote.

Changes proposed through `marginote_suggest_edit` remain pending until the human accepts
them. Native approval requests receive only `once` or `deny`, scoped to the exact request;
unsupported interactive requests fail closed. No session-wide approval is emitted.
Both peer JSON-RPC `approval` requests and legacy `approval.request` events are supported.
Peer responses use the incoming wire ID; the distinct approval queue ID identifies the
human review. Registering the two artifact tools does not require `tools.override` permission.
Cancellation revokes callbacks and stops only the owned native turn/process. This plugin
does not invoke the TUI entry point that also schedules profile-wide orphan cleanup.

The cached source system prompt is copied into the snapshot, but the resumed native agent
uses Hermes's current prompt assembly. Byte-identical future system instructions are not
promised. Existing native filesystem tools retain their original permissions; only the
Marginote tools enforce editor locks and suggestion acceptance. Native fallback routing
is unchanged, and each artifact action reports the current native model for attribution.

This adapter uses native TUI internals as well as the public plugin API. Hermes upgrades
require the native checks below. If legacy compression rotates the durable child ID,
the turn fails closed for manual inspection; automatic route migration is not implemented.

## Verification

From the source checkout, use the Python interpreter belonging to the user's installed
Hermes environment (no global package installation):

```sh
python3 scripts/check-hermes-protocol.py
/path/to/hermes/venv/bin/python scripts/check-hermes-fork.py
/path/to/hermes/venv/bin/python scripts/check-hermes-launcher.py
/path/to/hermes/venv/bin/python scripts/check-hermes-runtime.py
```

The protocol check uses only the Python standard library and covers request correlation,
one-time consent, denial, cancellation and rejection of unsupported or foreign-session
requests. The fork check creates isolated temporary Hermes profiles and native SQLite sessions. It covers
delivery boundaries, exact sidecars, active/compacted history, legacy compression ancestry,
invalid metadata, concurrent parent updates, rollback, discovery through the installed
`hermes` CLI, and lazy restoration through the real TUI dispatcher without building an
agent. It never reads real sessions or submits a model prompt.

The launcher check runs the short command, verifies the pending connection, completes only
the calling session's delivery and checks automatic binding and inherited metadata without
starting a model. The runtime check uses the installed CLI, native AIAgent and native tool system against
an isolated loopback fake model. It verifies inherited history, actual Marginote
read/propose/accept behavior, another-process follow-up and rejection of a native terminal
permission request. It independently checks the original session's rows and metadata.
Auxiliary native title requests are distinguished from discussion requests. No real
conversation, provider credential or external model is used. Its profile default model
deliberately differs from the delivery model to detect accidental global-default restoration.
The synthetic profile selects manual approvals and disables optional Tirith downloads;
the native dangerous-command approval gate remains active. Failed runs retain their
synthetic profile and logs at the printed path, so cleanup cannot remove a database
still held by an exiting native process. Successful runs remove their temporary profile.

Protocol unit tests cover bad child IDs, missing model identity, unsupported bridge
versions, permission denial and cancellation. Deterministic Chromium tests cover browser
binding, replies, proposals, acceptance and follow-up after the old anchor disappears.
These checks do not prove a real external model's behavior. Do not route `hermes` origins
to Codex, Claude or pi as a substitute.
