# Phase 1: Overleaf-style bidirectional source/preview navigation

## Goal
Like Overleaf's PDF<->source sync: the user can navigate between the Markdown
source (CodeMirror editor, left) and the rendered preview (right) at matching
positions, in both directions.

## Required behaviors
1. **Preview -> source**: double-clicking any block in the preview scrolls the
   editor to the corresponding source position, places the cursor there, and
   briefly highlights the target line(s) in the editor (a short fade-out flash).
   Double-click must NOT interfere with existing click handlers (wikilink
   navigation, Run buttons on code blocks) and must not select-all or otherwise
   damage UX. Text selection caused by dblclick in the preview should be cleared.
2. **Source -> preview**: when the editor cursor moves (selection change), the
   preview auto-scrolls so the block containing the cursor is visible, and that
   block gets a subtle transient highlight. This must be debounced (~150ms) and
   must NOT hijack the preview scroll while the user is actively scrolling the
   preview themselves (suppress for ~1s after a user-initiated preview scroll).
   Also do NOT auto-scroll the preview on mere typing bursts in a block already
   visible — only scroll when the target block is outside the preview viewport.

## Implementation approach (required)
- `packages/web/src/preview.ts` currently renders with `marked.parse(whole doc)`.
  Change to: `marked.lexer(source)` to get top-level tokens; each token has
  `.raw`, so a cumulative sum of `.raw.length` gives the starting character
  offset of each top-level block within the SOURCE string passed in. Render
  token-by-token (`marked.parser([token], ...)` or equivalent) wrapping each
  block's HTML in its natural top element annotated with
  `data-src-start` / `data-src-end` (character offsets). If per-token rendering
  breaks reference links or list continuity, an acceptable alternative is
  rendering the full doc once but walking tokens and matching top-level output
  elements in order (marked emits one top-level element per block token for
  paragraphs/headings/lists/code/blockquote/table; verify and handle `space`
  tokens which emit nothing).
- Keep the existing wikilink rewriting and mermaid rendering intact. Note that
  wikilink rewriting happens BEFORE parsing and changes string offsets — compute
  offsets against the ORIGINAL source, not the rewritten one. The cleanest way:
  lex the original source for offsets, and apply wikilink rewriting per-block at
  render time instead of globally, or compute an offset correction map. Choose
  the simplest correct approach and document it in a comment.
- **Critical offset mapping**: the preview is rendered from
  `committedTextOf(ytext)` (see `packages/web/src/rail.ts` and
  `packages/bridge/src/attribution.ts`), which EXCLUDES pending suggest-insert
  spans present in the editor's full document. So a character offset in the
  preview source is a *committed* offset, and the editor works in *full*
  offsets. Use/extend the existing machinery in
  `packages/bridge/src/attribution.ts` (`visibleRuns` is private; export a
  mapping helper e.g. `committedToFull(text, offset)` and `fullToCommitted`)
  with unit tests. Comments code already does similar mapping — reuse if
  something exists.
- Editor scroll/flash: use `scrollTo` from rail.ts or dispatch with
  `scrollIntoView`, plus a CodeMirror decoration or a transient DOM class for
  the flash. Preview flash: a CSS class with a ~1.2s fade, consistent with the
  app's existing visual language (see style.css / themes.ts; use theme accent
  color at low alpha, works in both light and dark).
- Cursor->preview mapping: binary search over the block offset table for the
  block containing `fullToCommitted(cursorPos)`.

## Constraints
- TypeScript strict; follow the existing code style (comments explain WHY).
- No new dependencies unless truly necessary (prefer none; marked lexer is
  already available).
- Do not break: suggesting mode, comments anchoring, mermaid, wikilinks,
  Run buttons, export, replay view.
- All existing unit tests must stay green (`npm test`), typecheck clean.
- Add unit tests for: offset table construction from lexer tokens (headings,
  paragraphs, fenced code, lists, blockquotes, mermaid block, wikilinks doc),
  and committed<->full mapping with pending suggestions present.
- Add a Playwright e2e test in `e2e/` following existing patterns
  (see existing specs there): open a doc, double-click a preview paragraph,
  assert editor selection moved to the right line; move editor cursor, assert
  preview scrolled/highlighted block matches.
- Do NOT commit or push. Leave the working tree dirty for review.
