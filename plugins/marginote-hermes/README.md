# Marginote Hermes integration

This development plugin implements native delivery snapshots and browser conversation
continuation, including scoped artifact tools and one-time native permission decisions.
The Codex/Claude launcher skill is in the sibling `marginote` directory.

## Local setup

Place this entire directory at `plugins/marginote-hermes` under the **originating Hermes
profile's home**, then run `hermes plugins list` and `hermes plugins enable marginote-hermes`
in that profile. Keep any existing installation until you have reviewed an update. The
current checkout has only been installed in disposable test profiles, not a real profile.

Start Marginote from the same profile environment, with `hermes` on PATH:

```sh
marginote /path/to/project --doc report.md --port 0 --no-discover --open \
  --origin-provider hermes --origin-session EXACT_SESSION_ID --origin-turn EXACT_ROW_ID
```

The native CLI selects the profile normally, including inherited `HERMES_HOME`. The
adapter does not scan other profiles, copy credentials or restart a gateway. One server
uses one Hermes profile. Use IDs from the actual delivery runtime and connect only after
the assistant answer has completed. Missing native APIs or profile data fail explicitly.

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

The first response declares `protocolVersion: 1` and `capabilities: ["fork_delivery", "prompt"]`.
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
/path/to/hermes/venv/bin/python scripts/check-hermes-fork.py
/path/to/hermes/venv/bin/python scripts/check-hermes-runtime.py
```

The check creates isolated temporary Hermes profiles and native SQLite sessions. It covers
delivery boundaries, exact sidecars, active/compacted history, legacy compression ancestry,
invalid metadata, concurrent parent updates, rollback, discovery through the installed
`hermes` CLI, and lazy restoration through the real TUI dispatcher without building an
agent. It never reads real sessions or submits a model prompt.

The runtime check uses the installed CLI, native AIAgent and native tool system against
an isolated loopback fake model. It verifies inherited history, actual Marginote
read/propose/accept behavior, another-process follow-up and rejection of a native terminal
permission request. It independently checks the original session's rows and metadata.
Auxiliary native title requests are distinguished from discussion requests. No real
conversation, provider credential or external model is used.

Protocol unit tests cover bad child IDs, missing model identity, unsupported bridge
versions, permission denial and cancellation. Deterministic Chromium tests cover browser
binding, replies, proposals, acceptance and follow-up after the old anchor disappears.
These checks do not prove a real external model's behavior. Do not route `hermes` origins
to Codex, Claude or pi as a substitute.
