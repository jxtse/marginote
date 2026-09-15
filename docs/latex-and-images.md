# LaTeX and vault images

Marginote indexes and edits `.tex`, `.md`, and `.markdown` files. TeX uses a
CodeMirror StreamLanguage mode; Markdown retains its existing renderer and source
navigation. Open a TeX entry point or an included chapter to preview the whole paper,
including its inputs, macros, bibliography, tables, and PDF figures. The main document
selector uses a `% !TEX root = ../main.tex` directive first, otherwise the current
document class or a unique main file that includes the chapter. When there are multiple
candidates it asks for a main file instead of guessing. Explicit selections are saved
in this browser. Literal `input`, `include`, and `subfile` references are recognized;
computed paths and custom include macros may need manual selection. The main file's
directory is the snapshot root: dependencies above it are not included.

The editor completes common commands, environments, labels and bibliography keys
(Ctrl-Space also opens completion). Compiler diagnostics with a `.tex` file and line
number appear as clickable source links and editor markers. Locations are only applied
when the source still matches the compiled revision.

## Runtime requirements

Install `tectonic` on the server's PATH. macOS also needs its system
`/usr/bin/sandbox-exec`; Linux needs `bwrap` (bubblewrap) and permission to create
its namespaces. Other platforms fail closed with a structured error. A restricted
container may prohibit these sandboxes even when the commands are installed.

Compilation is offline (`--only-cached`). Populate Tectonic's resource cache by
compiling a **trusted** paper yourself before using preview. Marginote neither
downloads TeX packages nor silently falls back to unrestricted execution. Tectonic
and the OS isolation utility are external runtime prerequisites, not npm binaries.
All JavaScript and highlighting assets ship through `npm run build:release`.

Use **Check LaTeX setup** in the preview toolbar to compile a synthetic document with
text, headings, bold/italic fonts and math in the actual offline sandbox. The check
shares the compiler slot, resource limits and cancellation lifecycle with preview.
A successful check establishes basic runtime readiness, not compatibility with every
paper. Missing fonts/packages and sandbox errors show a setup explanation and log.
To populate missing cache resources, compile a **trusted copy** of your project with
`tectonic --untrusted main.tex` on the server, then retry the offline check. That manual
preparation may download resources; the preview and setup-check endpoints do not.

On macOS the sandbox read allow-list is fixed to the Tectonic binary found on PATH
plus the Homebrew dynamic libraries it links against under `/opt/homebrew` (ICU,
HarfBuzz, FreeType, Graphite2, libpng, GLib, gettext, PCRE2), resolved to their real
`Cellar` paths at compile time. Apple-silicon Homebrew is the supported and tested
layout. Other layouts (Intel Homebrew under `/usr/local`, MacPorts, a self-built
binary) are unverified; if such a binary needs a dynamic library outside the
allow-list, the compile fails with a `dyld` "Library not loaded" log rather than
widening the sandbox. Open an issue with the log if you need a layout added.

## API and limits

- `POST /api/latex?doc=manuscript%2Fmain.tex` flushes the live vault projection,
  copies the entry point's project directory into a bounded immutable snapshot,
  invokes Tectonic with direct argv, `--untrusted`, SyncTeX, and a separate temporary
  output directory, then returns a fresh `application/pdf`. No existing vault PDF
  is used as fallback. Snapshots and outputs are removed on success and failure.
- `GET /api/latex/project?doc=...&entry=...` resolves the main document and returns
  labels, citation keys, source hashes and a content hash of all supported project
  dependencies. `entry` is optional. Discovery allows at most 1,000 TeX documents and
  32 MiB of source text; project inspection is single-flight and otherwise returns `429`.
- `POST /api/latex/check` runs the offline setup check. `GET /api/latex/mapping?id=...`
  returns the navigation data for a completed compile. PDF responses include
  `x-source-hash`, `x-project-hash` and `x-compile-id`. At most four navigation maps
  are retained, with a 30-minute access lifetime. Maps are limited to 50,000 locations;
  SyncTeX input is bounded to 8 MiB compressed and 16 MiB decompressed. Original
  temporary snapshot paths are never returned as navigation destinations.
- There is at most one compiler process tree per server. Concurrent requests for
  the same entry share an in-flight result; another entry receives `429`. When every
  requester disconnects (navigation, edit debounce, tab close) the compiler is killed
  so an abandoned job cannot hold the slot.
- Compilation has a 120-second timeout and 256 KiB stdout/stderr ceiling. A project
  snapshot is limited to 5,000 supported files, 50,000 directory entries and 256 MiB;
  returned PDFs/assets are limited to 64 MiB. Before the compiler starts, the OS
  applies `RLIMIT_FSIZE` (exactly 128 MiB per file; the shell's `ulimit -f` unit is
  probed once per server process by asking the kernel: under `ulimit -f 1` a fresh
  O_EXCL file receives one 1024-byte `write(2)`, and only a short count of 1024 or 512
  followed by `EFBIG` on the next byte identifies KiB or 512-byte blocks. Any other
  outcome is "unknown", is not cached, and the compiler is not started, returning
  `503 sandbox_unavailable`) and, on Linux, `RLIMIT_AS` (4 GiB) so
  those ceilings hold at every instant. Process accounting is checked before Tectonic
  starts; inability to inspect processes disables compilation. While it runs, two independent samplers poll
  every 250 ms: one sums the resident memory of every process still reachable from the
  compiler through the parent chain (so `bwrap --new-session` children are counted), the
  other measures the output directory (also the compiler's `TMPDIR`) with a bounded,
  early-exiting scan. Exceeding 512 MiB of generated data or 2 GiB RSS kills those
  descendants, then the process group. Termination is idempotent and enumerates
  descendants before signalling. If process accounting itself fails while the compiler
  is alive the job is killed rather than left unbounded; a memory sample that returns
  over budget after the compiler already exited still fails the job, and the output
  size is re-checked once after exit so a burst between samples is rejected. A
  descendant that double-forks and whose intermediate parent exits before enumeration
  is no longer reachable through the parent chain; on Linux, bwrap's PID namespace
  ends it with the sandbox, on macOS such a process is outside what Marginote can
  track. Server shutdown cancels compilation and waits for temp cleanup.
- Errors are JSON `{ code, error, log, diagnostics? }`; missing files return `404`, invalid paths
  `400`, compiler failures `422`, and missing runtimes `503`. Logs render as text,
  never HTML. Existing host/origin checks apply to both APIs.
- The OS sandbox denies network access and filesystem access outside the snapshot,
  temporary output, and explicitly permitted system/compiler/cache resources. It
  allows writes only to the temporary output. This is a defense-in-depth boundary,
  not a multi-user resource-quota system; run under a low-privilege account for
  hostile workloads. The local OS account and other same-user processes are trusted;
  Marginote does not claim to withstand an adversarial process racing filesystem
  pathnames while the server reads them. Vault files must not contain secrets that
  readers should not see. The entry file and its supported local dependencies are
  compiled from the same immutable snapshot used to calculate the response source
  hash. PDF.js renders the resulting Blob in a canvas with a selectable text layer.
  Its worker, fonts, CMaps and WASM assets ship locally; viewing requires no CDN.
  The embedded viewer does not execute PDF document actions or XFA forms.

The preview resolves the project after a 200 ms debounce and compiles after a further
650 ms. It rejects obsolete async results, compares source and project SHA-256 hashes
with the server response, and revokes replaced Blob URLs. While the single
compile slot is busy (`429`) the preview keeps waiting with geometric back-off (up to
5 s) for about 140 s, slightly longer than the server's compile timeout; stale-hash or
`409` responses retry at most eight times. Changes to chapters, bibliography, figures
and other supported dependencies trigger a project refresh through server events;
a visible-tab refresh every 15 seconds covers missed events. **Recompile** is always
available. During compilation or a source error the last successful PDF remains
visible with a stale status; new pages replace it only after rendering. Page number,
zoom and scroll offsets survive updates within the same project. Switching projects
or emptying a synced document clears the previous preview. Only one page is rendered
at a time, with a 12-megapixel canvas budget.

**Find in PDF** locates the current source line; double-clicking a PDF page locates
its source. Navigation uses a bounded index of Tectonic's SyncTeX v1 line boxes and
source marks, so it is approximate at line level, especially around macros, whitespace
and mixed-source paragraphs. Unsupported versions, nonempty post-processing transforms
and missing maps disable navigation while leaving the PDF available. This does not
implement the full native SyncTeX query algorithm. Source hashes prevent applying
positions from a different revision. **Open PDF** opens the file in the browser's
viewer for full native PDF functionality. Historical replay still shows TeX source
rather than compiling old source against current includes.

## Markdown images

`![Figure](figures/result.png)` resolves relative to the open document through
`GET /api/assets?path=...`. PNG, JPEG, GIF, WebP, SVG, and PDF are supported, with
correct MIME types and `nosniff`, same-origin resource policy, and sandbox CSP.
PDF image references use an object with a fallback link. Images scale to the pane.
Raw-HTML `<img srcset>` candidates are rewritten through the same resolver; unsafe
candidates are dropped individually. `.tex` sources are included in full-text search.
HTTP(S), protocol-relative, anchor, and data references remain unchanged.

Absolute filesystem paths, `..` traversal (including encoded traversal), backslash
paths, unsupported extensions, and symlink paths are rejected. Use vault-local
ordinary files. A leading `./` is supported in Markdown references; parent-relative
images are intentionally not supported. Markdown source/preview navigation is
unchanged; PDF figures themselves do not have Markdown source positions.

## Verification

```sh
npm test -- packages/server/test/media.test.ts packages/server/test/latex-process.test.ts packages/server/test/latex-project.test.ts packages/web/test/media.test.ts packages/web/test/latex-preview.test.ts packages/web/test/latex-editor.test.ts
npm test
npm run verify
npm run test:e2e -- e2e/media.spec.ts e2e/sync-nav.spec.ts
# Opt-in: requires Tectonic and a cache prepared for the synthetic article/BibTeX fixture.
MARGINOTE_REAL_LATEX=1 npm run test:e2e -- e2e/media.spec.ts --project chromium
```

Unit tests and the browser fixture use deterministic compiler output and do not
require TeX downloads. For a real paper, start with `--no-persist --no-discover`
and no `--git`. Do not edit during read-only acceptance. The existing agent settings
loader may try to create `.marginote` even with `--no-persist`; use a read-only mount
or a disposable copy if the entire directory must remain strictly unchanged.
