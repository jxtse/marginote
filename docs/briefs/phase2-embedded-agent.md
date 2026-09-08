# Phase 2: Embedded pi agent — comments become conversations

## Goal
Marginote's differentiator: an AI agent lives INSIDE the server process. When a
human leaves a comment, the agent reads it immediately (like a chat app "read"
receipt), works on it (multi-step reasoning, tool calls, optional web search),
and answers — either as a reply on the comment thread, or as a suggest-mode
edit the human accepts/rejects in the browser. No external process, no MCP
client wiring, no copy-paste round trip.

## Architecture (required)
New workspace package `packages/agent` (`@marginote/agent`), a dependency of
`@marginote/server`. It embeds the pi coding agent SDK:

- Dependency: `@earendil-works/pi-coding-agent` (verify the installed version
  with `npm view @earendil-works/pi-coding-agent version`; it exports a
  programmatic SDK from its root entry).
- Key SDK surface (from `dist/core/sdk.d.ts`):
  ```ts
  import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
  const { session } = await createAgentSession({
    model,                          // Model object; see "Model config" below
    thinkingLevel: "medium",
    noTools: "all",                // CRITICAL: disable read/bash/edit/write
    customTools: [...],            // our sandboxed tools only
    sessionManager: SessionManager.inMemory(),
  });
  ```
  Tools are created with `defineTool({ name, label, description, parameters
  (TypeBox schema), execute })`. Explore the .d.ts of the installed package
  under node_modules for exact signatures. AgentSession has a `prompt(text)`
  (and event subscription) API — explore `dist/core/agent-session.d.ts`.
- IMPORTANT: `noTools: "all"` (or the equivalent allowlist) so the agent has
  NO bash/read/edit/write access to the host. Assert in a unit test that the
  session's enabled tools are exactly our custom set.

## Model configuration
- Server-side store: `<vault>/.marginote/agent.json` (add `.marginote/` to the
  vault's ignore behaviors if any; never sync it as a document). Shape:
  ```json
  { "provider": "openai-compatible", "baseUrl": "https://api...", "apiKey": "sk-...",
    "model": "gpt-x", "agentName": "Margin", "webSearch": { "provider": "auto", "apiKey": null } }
  ```
- REST endpoints on the existing server (follow the style of server.ts route
  handling): `GET /api/agent/config` (apiKey masked, e.g. "sk-…abc"), `POST
  /api/agent/config` (updates; loopback-only like everything else), `GET
  /api/agent/status` (configured/idle/working + last error), `POST
  /api/agent/test` (round-trip a 1-token completion to validate credentials —
  real call, surface the provider error verbatim on failure).
- Construct the pi `Model` object directly for an OpenAI-compatible endpoint:
  explore `@earendil-works/pi-ai` types (Model has api/provider/baseUrl/id
  fields; use api "openai-completions" or "openai-responses" — pick
  openai-completions for maximal third-party compat). If direct construction
  fights the SDK, use ModelRegistry/ModelRuntime registerProvider with a
  ProviderConfigInput. Choose whichever is simplest and test it.
- Web UI: a settings panel (gear icon in the top bar, or extend an existing
  settings/menus surface — follow existing UI patterns in menus.ts/layout.ts).
  Fields: Base URL, API key (password input), Model id, Agent display name,
  optional web-search key. Saves via POST, shows "test connection" button with
  the /api/agent/test result. Style must match the existing design language
  (see style.css, themes.ts — use CSS variables, no hardcoded colors).

## Comment-triggered agent loop (the core UX)
In the server: for each open document room, observe the CommentStore Y.Array
(bridge exports it; see packages/bridge/src/comments.ts and how the MCP
package's AgentSession connects as a peer over /sync — the in-process agent
should join the SAME way a peer does, via the room's Y.Doc directly, kind
"agent", so all existing leash/attribution/policy machinery applies. Explore
packages/server/src/room.ts).

Trigger rules:
- New top-level comment by a HUMAN author (kind !== "agent"), not resolved,
  not orphaned → agent handles it.
- New human REPLY on a thread the agent has participated in → agent handles it
  (continue that thread's pi session if still in memory, else start fresh with
  the thread history in the prompt).
- Ignore agent-authored events (no self-loops). Debounce 400ms so a burst of
  CRDT updates for one comment fires once. Queue: max 1 concurrent agent run
  per document, FIFO for the rest; drop duplicate triggers for the same thread.
- If the agent is unconfigured (no API key), do nothing silently EXCEPT post
  one gentle reply the FIRST time a comment is created in a session:
  "I'm Margin, this workspace's agent — add an API key in Settings and I'll
  respond to comments like this one." (only once per server run, not per doc).

Read receipt & lifecycle (chat-app feel):
1. Immediately on pickup: add reply "👀 reading…" (or set a dedicated
   `agentStatus` field on the thread if that's cleaner — but the reply is
   simpler and visible in the existing rail UI; replies are already rendered).
   Keep this message SHORT and replace/append the final answer later: since
   replies are append-only, post the receipt as a reply, then post the final
   answer as a second reply. Do not delete the receipt (attribution honesty).
2. Run the pi session (see prompt below).
3. Outcome A — the agent made a suggestion: it posts a reply summarizing what
   it suggested ("Suggested an edit: …one line…"). Outcome B — question/no
   edit needed: it posts the answer as a reply. Outcome C — error: reply with
   a short apology + the error class (full detail to server log), e.g.
   "I hit an error (401 from provider). Check Settings → Agent."
4. Timeout: hard-cap a run at 3 minutes; on timeout post outcome C reply.

## System prompt & context (write it well; this is product copy too)
System prompt must tell the agent:
- It is "«agentName», an AI collaborator living inside Marginote, a real-time
  collaborative Markdown editor. Humans and agents edit the same live
  document; your edits are attributed to you. Prefer SUGGESTING edits over
  direct edits — a human reviews every suggestion in the margin."
- The workspace root ("vault") and the current document path.
- Document delivery: if committed text ≤ ~24k chars, inline the full document
  in the first user message. Otherwise inline the first ~8k chars plus an
  outline (use `sections`/`summarise` from @marginote/bridge — explore what
  exists) and tell it to use read_document for the rest.
- The comment: quote text, anchored range, author name, thread history if any.
- House rules: keep replies concise; never invent citations; when web results
  inform an edit, mention sources in the reply (not inside the document unless
  asked); respect locked sections (the tool will refuse; don't fight it).

## Custom tools (all sandboxed to the vault; TypeBox schemas; unit-tested)
1. `read_document({ path?, offsetChars?, limitChars? })` — committed text of
   any doc in the vault (default: current doc). Path must resolve inside the
   vault (reuse/extend packages/server/src/security.ts realpath checks).
2. `list_documents()` — same listing the server exposes.
3. `read_image({ path })` — read an image referenced from a vault document;
   ONLY allow: (a) path inside the vault, OR (b) path outside vault but
   directly referenced by an `![](...)` link in some vault document (resolve
   relative to that document, realpath-verify, no symlink escape; reject
   anything else). Return as a pi image attachment so vision models can see it
   — explore how pi tool results carry images (AgentToolResult content types).
   Cap file size (5 MB) and allow only png/jpeg/webp/gif by magic bytes.
4. `suggest_edit({ from, to, replacement, note? })` — offsets in COMMITTED
   text; map to full offsets via the bridge mapping helpers (Phase 1 added
   committedToFull) and apply as suggest-mode ops using the same primitives
   the MCP server uses (`proposeDelete`, `insertAttributed` with suggest flag
   — explore packages/mcp/src/server.ts for the exact pattern, including
   politeness/lock checks and refusal surfacing). Returns what was applied or
   the refusal reason verbatim.
5. `reply_comment({ threadId, body })` — reply on a thread (CommentStore).
6. `web_search({ query, limit? })` — see below.

## Web search: no-key default, optional key upgrade
- Default (no key): DuckDuckGo HTML endpoint (`https://html.duckduckgo.com/html/?q=...`)
  parsed with a tolerant regex/cheerio-free parser (no new heavy deps; write a
  small parser with tests against a saved fixture). Return title/url/snippet,
  max 8. Add a 10s timeout and a clear error when DDG blocks (agent should
  degrade gracefully: report "search unavailable" rather than fabricate).
  Follow-up page fetch: `fetch_page({ url })` tool — GET with 10s timeout,
  text/html only, strip tags to readable text, cap 40k chars. ONLY http/https,
  and block requests to localhost/private ranges (SSRF guard: resolve DNS and
  reject private/loopback/link-local IPs — important because the server holds
  a loopback-trust security model).
- With key: if `webSearch.apiKey` is set and provider is "tavily" or "exa",
  use their REST APIs instead (simple fetch, no SDK deps). Config field
  `webSearch.provider`: "auto" (ddg unless key present), "ddg", "tavily", "exa".

## Constraints
- No shell access for the agent, ever. No filesystem outside the rules above.
- All new code TypeScript strict, existing code style (WHY-comments).
- Unit tests: config store (masking, roundtrip), trigger rules (human vs
  agent author, debounce, queue), sandbox path checks (escape attempts,
  symlink), suggest_edit offset mapping, DDG parser fixture, SSRF guard.
- `npm run typecheck` and `npm test` green. Do NOT commit.
- The pi dependency adds ~22MB unpacked — acceptable, it ships the product.
- If the CLI-installed pi version's SDK differs from the npm-published one,
  install the npm version into the workspace and code against THAT.
