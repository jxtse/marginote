# LaTeX and vault images

Marginote indexes and edits `.tex`, `.md`, and `.markdown` files. TeX uses a
CodeMirror StreamLanguage mode; Markdown retains its existing renderer and source
navigation. Open a TeX **entry point** (for example `manuscript/main.tex`) to compile
the paper, including its inputs, macros, bibliography, tables, and PDF figures.
Included fragments without a document class are editable, but are not standalone
entry points.

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
- There is at most one compiler process tree per server. Concurrent requests for
  the same entry share an in-flight result; another entry receives `429`. When every
  requester disconnects (navigation, edit debounce, tab close) the compiler is killed
  so an abandoned job cannot hold the slot.
- Compilation has a 120-second timeout and 256 KiB stdout/stderr ceiling. A project
  snapshot is limited to 5,000 supported files, 50,000 directory entries and 256 MiB;
  returned PDFs/assets are limited to 64 MiB. Before the compiler starts, the OS
  applies `RLIMIT_FSIZE` (exactly 128 MiB per file; the shell's `ulimit -f` unit is
  probed once so the value is not off by 2×) and, on Linux, `RLIMIT_AS` (4 GiB) so
  those ceilings hold at every instant. While it runs, two independent samplers poll
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
- Errors are JSON `{ code, error, log }`; missing files return `404`, invalid paths
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
  hash. The resulting Blob is displayed by the browser's built-in PDF viewer; Chromium
  does not render its PDF plugin inside a sandboxed iframe, so compiler isolation and
  the browser PDF viewer are the active-content boundaries.

The preview debounces edits by 650 ms, rejects obsolete async results, compares a
source SHA-256 with the server response, and revokes old Blob URLs. While the single
compile slot is busy (`429`) the preview keeps waiting with geometric back-off (up to
5 s) for about 140 s, slightly longer than the server's compile timeout; stale-hash or
`409` responses retry at most eight times. Native browser
PDF support supplies page navigation and zoom; **Open PDF** is available when an
embedded viewer is unsupported. TeX source-to-PDF SyncTeX navigation is not yet
implemented. Historical replay shows TeX source rather than compiling old source
against current includes. Edits to an included file require reopening/retrying the
entry point to update its PDF.

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
npm test -- packages/server/test/media.test.ts packages/server/test/latex-process.test.ts packages/web/test/media.test.ts packages/web/test/latex-preview.test.ts
npm test
npm run verify
npm run test:e2e -- e2e/media.spec.ts e2e/sync-nav.spec.ts
```

Unit tests and the browser fixture use deterministic compiler output and do not
require TeX downloads. For a real paper, start with `--no-persist --no-discover`
and no `--git`. Do not edit during read-only acceptance. The existing agent settings
loader may try to create `.marginote` even with `--no-persist`; use a read-only mount
or a disposable copy if the entire directory must remain strictly unchanged.
