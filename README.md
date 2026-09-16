# Marginote

[![CI](https://github.com/jxtse/marginote/actions/workflows/ci.yml/badge.svg)](https://github.com/jxtse/marginote/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)

[中文入门指南](README.zh-CN.md)

**Open a local document in your browser, comment on a passage, and review an AI's proposed changes.**

Marginote runs on your computer. A **vault** is just the folder containing your documents;
you do not need to upload or import them. You can edit and annotate without an AI account.
To get AI replies, configure a model in Settings or connect a supported existing agent conversation.

![Marginote: document, preview, and discussion in the margin](docs/product-screenshot.png)

## 1. Start Marginote

You need **Node.js 22 or newer**, including npm. Run `node --version` in Terminal
(macOS/Linux) or PowerShell (Windows) to check. The commands below go in that terminal,
not in your browser's address bar.

**Choose one starting point:**

| What you want | Use |
| --- | --- |
| Try Markdown editing, comments and the built-in AI | The npm demo below |
| Use HTML, LaTeX, or continue a Codex/Claude Code/Hermes conversation | Build the current source below |

**Version note:** checked on 2026-09-16, npm's `latest` is `0.2.0-beta.1`, an older
Markdown release. This checkout uses the same version string but contains newer features.
The published CLI does **not** include `--doc`, `--open`, or `--origin-*`. Use the source
build for those instructions; `npx marginote@latest` does not run your local checkout.

### Try the npm demo

```bash
npx marginote@latest --demo
```

If npm asks to install the package, confirm. Keep the terminal running and open the
`local` URL it prints, normally **http://127.0.0.1:4321/**, in your browser.
You should see a file list including `welcome.md`. Click it, then follow step 2 below.

The demo is temporary: **its files, comments and settings are deleted when you stop it**.
For documents you want to keep, press `Ctrl+C`, then run:

```bash
npx marginote@latest
```

This opens `~/Documents/Marginote`, creating a welcome document if that folder does not
already exist. Or open your own existing folder with `npx marginote@latest "/path/to/notes"`
(replace the path; on Windows use a path such as `"C:\Users\YourName\Documents\notes"`).

### Build the current source

You also need Git. In a directory where you keep projects, run:

```bash
git clone https://github.com/jxtse/marginote.git
cd marginote
npm ci
npm run build
node packages/cli/bin/marginote.js --demo --open
```

The last command opens a disposable demo in your browser. If the browser does not open,
use the terminal's `local` URL. After trying it, stop with `Ctrl+C`. To open a persistent
workspace using this build, run from the same `marginote` checkout:

```bash
node packages/cli/bin/marginote.js --open
```

To open a particular file, keep it in an existing folder and pass its path relative to
that folder. For example, if `/path/to/notes/report.md` exists:

```bash
node packages/cli/bin/marginote.js "/path/to/notes" --doc report.md --open
```

Replace `/path/to/notes` with your actual folder. The same command accepts an HTML or TeX
file in place of `report.md`. LaTeX PDF preview requires the additional
[compiler and sandbox setup](docs/latex-and-images.md); basic Markdown does not.

## 2. Try one comment

1. Click `welcome.md` in the file list on the left.
2. Select a sentence in the **source editor**, then click **Comment** in the top toolbar.
   If the source is hidden, click **Show the document source** first.
3. Type **“What is unclear about this sentence?”**, then click **Comment** in the composer.
   Your comment appears in the margin. Without a configured AI, it remains a human annotation.
4. Use **Reply** → **Send reply** to continue that discussion.

Your direct edits save to the underlying file automatically. To make your own edits
reviewable first, turn on **Suggesting**. Suggestions appear as cards with **Accept** and
**Reject**; accepting writes the proposed change, while rejecting keeps the original.

For HTML, you can also select static text in the rendered report and click
**Comment selected text** above the preview. See [HTML usage](docs/html-artifacts.md).

## 3. Get your first AI reply

For the built-in AI, click **Settings** in the top toolbar and fill in:

| Field | What to enter |
| --- | --- |
| **Base URL** | Your provider's OpenAI-compatible API base, often ending in `/v1`. Do not include `/chat/completions`; Marginote appends it. |
| **API key** | An API key from that provider. |
| **Model id** | The exact model identifier available through that API key, not a display nickname. |
| **Agent display name** | Keep `Margin`, or choose a name for replies. |

Leave the optional web-search key blank to begin. Click **Save & test connection** and
wait for **Connection successful.** This makes a small real API request; provider charges
may apply. A successful connection test checks connectivity, not every model/tool capability.

Now create a **new** comment, for example:

> Rewrite this sentence more clearly. Propose the change for me to review.

The AI replies in that comment thread. If it proposes an edit, inspect its suggestion
card and click **Accept** or **Reject**. A reply alone is not a saved edit. Ask follow-up
questions with **Reply**. For a review of the whole document, click **Grill me**.

Settings configure a separate built-in collaborator. They do not attach a previous
Codex, Claude Code or Hermes chat. Use the next section when that history matters.

## 4. Continue the conversation that produced a document

This is an optional **source-build preview**, not required for the workflow above.
The originating agent must be installed and authenticated on the machine running
Marginote. It uses that agent's existing configuration, rather than the Settings model.

You need the exact originating session ID and its **completed delivery** ID:

| Agent | `--origin-provider` | `--origin-turn` means |
| --- | --- | --- |
| Codex | `codex` | Completed native turn ID |
| Claude Code | `claude-code` | Completed assistant message UUID |
| Hermes | `hermes` | Native `messages.id` row number, not the displayed message number |

Obtain these from the originating runtime. If they are unavailable, open the document
normally; its original conversation is not connected. Hermes additionally needs the
[native plugin enabled in that same profile](plugins/marginote-hermes/README.md).

From the built checkout, substitute your real folder, file and IDs:

```bash
node packages/cli/bin/marginote.js "/path/to/project" --doc report.md --port 0 --open --origin-provider codex --origin-session EXACT_SESSION_ID --origin-turn EXACT_COMPLETED_TURN_ID
```

1. Open the printed review link and wait for the original agent's delivery to finish.
2. Click **Connect conversation**. Confirm the panel says **Codex conversation · Ready**
   (or the provider you selected).
3. Add a **new** comment. It continues a separate child conversation with the inherited
   history; it does not send your question back to the original chat.
4. Review proposed edits with **Accept**/**Reject**. If the panel says **Your approval
   needed**, inspect the action and choose **Approve once** or **Decline**.

Only new comments and follow-ups trigger work after connection. **Grill me** is hidden
for connected documents. Opening a review link or connecting alone does not start a model
turn. One server owns each folder: if it is already open, reuse that server and its
`review_document` MCP tool rather than starting a second copy.

Codex has a verified live-model workflow. Claude Code and Hermes have native integration
checks, but their external-model continuation remains unverified. Suggestions sent through
Marginote require acceptance; other native filesystem tools retain the originating agent's
permissions. See [conversation setup and limitations](docs/artifact-conversations.md)
and the [agent launcher skill](plugins/marginote/skills/artifact-review/SKILL.md).

## Common problems

| What you see | What to do |
| --- | --- |
| `node` or `npx` is not recognized | Install Node.js 22+ with npm, then reopen the terminal. |
| The browser cannot connect | Keep the launch terminal running and use its exact `local` URL. If port 4321 is busy, add `--port 4322`. |
| No documents are listed | Put a supported file inside the folder you launched. The npm release handles Markdown; use the source build for HTML/LaTeX. |
| **Comment** is disabled | Select text in the source editor first. |
| Comments receive no AI reply | For the built-in AI, test Settings, then post a new comment. For an attached agent, check its **Ready**, approval or error status. |
| No **Connect conversation** button | Use the source build and the full review URL containing the document and exact origin IDs. Ordinary editor links do not offer this button. |
| `Web client not found` | Run `npm ci` and `npm run build` in the cloned repository. |
| The folder is already owned by another runtime | Reuse its URL or stop that server with `Ctrl+C`. After a crash, allow up to two minutes for ownership to expire. |
| HTML assets or a PDF preview are missing | See [HTML boundaries](docs/html-artifacts.md) or [LaTeX prerequisites](docs/latex-and-images.md). |

## Files and privacy

Documents stay in the folder you opened. Comments, AI settings and conversation routing
are stored under its `.marginote/` directory; keep that private and out of version control.
API keys are stored with owner-only permissions and masked in API responses.

AI requests send document context to the configured provider. Optional search/discovery
can contact public services. The default server address is local loopback; deliberately
sharing it over a network needs separate configuration. See [SECURITY.md](SECURITY.md).
Stop the server with `Ctrl+C`; persistent workspace files remain, while demo files are removed.

## Development and Docker

From a cloned, installed checkout:

```bash
npm run verify
npx playwright install
npm run test:e2e
```

`npm run verify` runs typecheck, unit tests, release build and release checks. Browser tests
use deterministic fixtures by default; real-model and real-TeX checks are opt-in.
`node packages/cli/bin/marginote.js --help` lists additional CLI options, including `--git`,
`--history` and `--no-discover`.

For Docker, create a `notes` directory containing a document first. Run these commands
in the cloned repository using a macOS/Linux shell:

```bash
mkdir -p notes
docker build -t marginote:local .
docker run --rm --user "$(id -u):$(id -g)" -p 127.0.0.1:4321:4321 -v "$PWD/notes:/vault" marginote:local
```

Open **http://127.0.0.1:4321/**. Linux mounts retain host ownership: the container's UID/GID
must be able to write the folder and `.marginote`. This image does not bundle your native
Codex/Claude/Hermes installations or the LaTeX toolchain; use a host source build for
those workflows. The commands publish the service only on local loopback.

## Acknowledgements and license

Marginote is a fork of [Quire](https://github.com/heetdalsania/quire) by Heet Dalsania and
contributors. The grill prompt is adapted from Matt Pocock's MIT-licensed
[`grilling` skill](https://github.com/mattpocock/skills). Marginote maintainer: [jxtse](https://github.com/jxtse).

Marginote remains **AGPL-3.0-or-later**. See [LICENSE](LICENSE) and [CHANGELOG.md](CHANGELOG.md).
