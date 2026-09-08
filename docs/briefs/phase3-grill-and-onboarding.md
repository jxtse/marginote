# Phase 3: "Grill me" review + out-of-the-box experience

## Part A — Grill me (document review by the embedded agent)

### UX
- A "Grill me" button in the editor top bar (next to existing controls; match
  the app's visual language). Disabled with a tooltip when the agent is
  unconfigured; shows a subtle working state while a run is active.
- Clicking it starts an agent run over the CURRENT document (Phase 2 engine,
  same queue — a grill counts as the document's one concurrent run).
- The agent posts its findings as COMMENTS anchored to the exact text each
  finding concerns (CommentStore.add with the resolved range), so the review
  lands in the margin where it belongs. Cross-cutting findings (structure,
  missing sections) go in one summary comment anchored to the title/first
  heading. The human replies on any thread to push back — Phase 2's reply
  handling continues the conversation.
- Cap: at most 8 anchored findings per grill (forces prioritization).

### The grill prompt (adapted, credit Matt Pocock's `grilling` skill, MIT)
The original grills a PLAN by walking a design tree in rounds. Ours grills a
finished DRAFT. Keep its spirit — relentless, specific, recommendation-first,
never vague — but adapt:

```
You are grilling a draft, not reviewing it politely. The author wants the
problems found now, by you, rather than later, by readers.

Map the draft as a claim tree: the piece's central claim, the supporting
claims it hangs on, and the evidence each one stands on. Then interrogate it:

- UNSUPPORTED: claims with no evidence, or evidence that doesn't carry the
  weight. Quote the exact sentence.
- LOGIC GAPS: places where the argument jumps — a reader must invent the
  missing step themselves.
- STRUCTURE: does the piece open with what matters? Does each section earn
  its place? What would you cut entirely?
- CONFUSION: sentences a careful reader must re-read. Jargon used before
  it's defined. Ambiguous pronouns and referents.
- COUNTERARGUMENTS: the strongest objection the author ignores. Steelman it.
- FACTS: anything checkable that looks wrong. Verify with web_search before
  alleging an error; cite what you found.

Rules, kept from the grilling tradition:
- Every finding names the exact text it concerns (quote it) — no vague
  "the middle section drags".
- Every finding comes with a recommended fix, not just the complaint.
- Facts are YOUR job: look them up with your tools; never ask the author to
  check something you can check yourself.
- Prioritize ruthlessly: the 8 findings that most change the piece, not 30
  nitpicks. Typos and grammar only if egregious (suggest_edit those directly).
- Be direct. The author asked to be grilled; politeness that hides a problem
  is a disservice.

Deliver each finding as an anchored comment on the exact text (use
reply_comment/create_comment tooling as instructed), and finish with one
summary comment: the draft's single biggest weakness, its single biggest
strength, and the three fixes you'd make first, as a numbered list.
```

Implementation: a `grill` entry point in packages/agent that composes this
with the Phase 2 system prompt/context and gives the agent one extra tool for
the run: `create_comment({ quote, body })` — anchors a new thread on the first
exact match of `quote` in the committed text (error if not found/ambiguous:
tell the agent to adjust the quote). Unit-test the anchoring (match, no-match,
multiple-match).
- Server route `POST /api/agent/grill { doc }` -> 202 + run enqueued; button
  calls it. Status surfaced like any agent run (Phase 2 status endpoint).
- Credit: add a line in README acknowledgements — the grill prompt is adapted
  from Matt Pocock's MIT-licensed `grilling` skill (link
  https://github.com/mattpocock/skills).

## Part B — Out-of-the-box experience

### Default vault
- `marginote` with NO directory argument: use `~/Documents/Marginote` —
  create it if missing and seed it ONCE with a `welcome.md` (short, friendly,
  explains: select text → comment → the agent responds; Grill me button;
  Settings for API key; point at any folder with `marginote <dir>`). If the
  dir exists, never re-seed or touch existing files.
- Keep every existing flag working exactly as now (`marginote <dir>`,
  `--port`, `--demo`, etc.). Update `--help` text accordingly: the default-dir
  behavior is documented first, flags remain the advanced path.

### First-run flow in the web UI
- If the agent is unconfigured, show a dismissible one-line banner linking to
  the settings panel ("Add an API key to wake the margin agent"). No modal, no
  nag: dismiss persists (localStorage).

### README rewrite (docs/ can stay largely as-is; README is the storefront)
Rewrite README.md for Marginote:
- What it is: local-first collaborative Markdown, forked from Quire, plus an
  embedded agent that answers your margin comments and grills your drafts.
- Quick start: `npx marginote` → opens `~/Documents/Marginote` → add API key
  in Settings → select text, comment, watch the margin answer. GIF placeholder.
- Features: source↔preview sync navigation (double-click / cursor follow),
  comment-triggered agent, Grill me, suggest-mode edits with attribution,
  everything from upstream (CRDT collab, git-friendly plain files, no cloud).
- Honest fork acknowledgement up top: "Marginote is a fork of
  [Quire](https://github.com/heetdalsania/quire) by Heet Dalsania (AGPL-3.0);
  the collaborative core is his work. Marginote adds the embedded agent and
  navigation layer." Keep LICENSE as AGPL-3.0-or-later; keep upstream
  CHANGELOG history intact (append a Marginote section on top).
- Update package.json repository/homepage/bugs URLs to jxtse/marginote; author
  field: keep original contributors, add Marginote maintainer line.

## Constraints
- typecheck + all unit tests green; do NOT commit.
- Playwright: extend e2e with (a) default-vault CLI boot test if feasible in
  the harness (skip cleanly if the harness pins a fixture dir), (b) grill
  button visible & disabled when unconfigured, (c) settings panel opens,
  saves, and masks the key (mock the provider with a tiny local HTTP stub if
  a test needs a "valid" key — never a real key in tests).
