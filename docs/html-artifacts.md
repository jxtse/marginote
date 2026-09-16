# HTML artifacts

Open `.html` or `.htm` files through the same vault, CLI and `review_document` MCP tool
as Markdown and LaTeX. The source is edited collaboratively with HTML syntax support.
The preview preserves the report's own layout, inline scripts and styles. It supports
relative local CSS, JavaScript entry files, images, responsive images and fonts. CSS
dependencies resolve against the stylesheet's directory and may use parent references
as long as the result remains inside the vault. Changes to loaded assets refresh the
preview. Source edits reload the report; JavaScript state in the frame is transient.

## Discuss a passage

1. Select text in the rendered report, then click **Comment selected text** above it.
2. Add the question in the margin. A connected artifact conversation receives the
   anchored source passage, the current HTML source and its inherited native history.
3. Use **Reply** on the same comment for follow-ups.

The mapping uses the HTML parser's source locations, preserves UTF-16/CRLF and entity
boundaries, and distinguishes repeated passages. Selecting rendered `&` anchors its
source `&amp;`. A selection across inline formatting includes the intervening tags in
the source quote. Comments remain Yjs relative anchors, just like other documents.

**Find in HTML** locates the current source selection in the report. Double-clicking
a static report element moves the source cursor to that element. Text created or
changed by JavaScript is not silently attached to unrelated source: select the source
to discuss it if the rendered text no longer maps. The preview also refuses stale
selection messages after source changes or document navigation.

The export menu downloads/copies the original HTML source, without preview markers,
transformed assets, the injected bridge or Marginote's interface. LaTeX source export
also preserves `.tex` instead of mislabelling it as Markdown.

## Runtime boundaries

HTML is rendered in a `srcdoc` iframe with `allow-scripts` and an opaque origin. It has
no same-origin access to the editor, credentials or agent endpoints. Its CSP allows
inline/data scripts and local assets embedded as data URLs, but blocks API connections,
remote resources, workers, nested frames, objects, forms and base-URL changes. The
editor's CSP also blocks frame navigation to other resources. If a report attempts such
a navigation, the browser may clear its frame; **Reload preview** restores the report.
These controls follow the [iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
and [CSP frame navigation](https://www.w3.org/TR/CSP/#directive-frame-src) contracts.

Normal links are presented through **Open selected link** in the trusted toolbar:
local documents open in the editor, and HTTP(S) links open separately after the user's
click. Frame messages can select source and describe a link; they cannot create a
comment, edit source, approve an agent action or navigate the editor on their own.

The preview reads at most 64 local asset files, 16 MiB of combined asset data, four
levels of CSS dependency nesting, 2 MiB of source and 20,000 mapped nodes. Missing or
external dependencies are reported. JS module imports, dynamic fetches and worker
dependencies are not rewritten; use bundled, self-contained reports for these cases.
The sandbox is browser isolation, not a CPU quota for report scripts.

Validation includes rendered styles, local scripts/images, repeated/entity-containing
text selection, native-conversation routing with a deterministic provider, follow-up
replies, asset refresh, source editing, navigation, source export and blocked parent/API
access and external navigation. This HTML-specific test does not invoke a real model;
the shared native Codex continuation path has a separate opt-in live test.
