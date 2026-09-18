# Repository layout

Marginote is a workspace for development and a single bundled package for installation.
A folder not used directly by the browser can still be needed for verification,
integrations or publishing.

## Application packages

| Path | Responsibility |
| --- | --- |
| `packages/web/` | Browser editor, previews, comments, suggestions and conversation UI. |
| `packages/server/` | Local HTTP/WebSocket server, vault ownership, assets, Discover and LaTeX compilation. |
| `packages/server/data/registry.json` | Curated public-document index for Discover, not an npm registry or installed-package list. |
| `packages/bridge/` | Shared CRDT state, filesystem synchronization, comments, policies and attribution. |
| `packages/agent/` | Built-in AI and native Codex, Claude Code and Hermes continuation. |
| `packages/cli/` | User-facing CLI and staging area for the standalone npm release. |
| `packages/mcp/` | Optional external-agent interface, exposed by the published `marginote-mcp` command. |
| `plugins/` | Codex/Claude launcher skill and native Hermes plugin. |

In a checkout the CLI reads the Discover index from the server package. Release assembly
copies it to `packages/cli/registry/index.json`, beside the bundled application. Keeping
the installed layout stable avoids changing the published package's asset lookup.
`--no-discover` disables the feature at launch; it does not make its source data unused.

## Two MCP uses

`packages/mcp` implements the optional **standalone stdio integration**. An external
agent can join a running Marginote workspace, read/comment/edit under its document
policies, or create a review link with `review_document`. It is a supported entry point
in the released package, even when a particular user has not configured it.

Separately, `packages/agent/src/conversation-mcp.ts` implements a short-lived,
authenticated local MCP endpoint for **native Codex and Claude Code continuation**.
It exposes the two artifact tools that read a document and propose an edit. The native
adapters configure this endpoint themselves; users need no separate MCP setup.

Hermes uses its plugin's local stdio JSON-RPC bridge and native tool registration.
It does not need the standalone MCP integration or the Codex/Claude MCP endpoint.
Launching through a CLI and communicating through MCP are compatible: the CLI starts
the integration, while the protocol carries tool requests.

Removing the standalone MCP command would be a deliberate feature/API removal, not
dead-file cleanup. Removing MCP support altogether would also break the native
Codex/Claude artifact tools.

## Tests and maintenance

| Path | Purpose | Command |
| --- | --- | --- |
| `packages/*/test/` | Unit, server and protocol regression tests. | `npm test` |
| `e2e/` | Real-browser workflows: editing, annotations, suggestions, HTML/LaTeX and conversations. | `npm run test:e2e` |
| `scripts/check-*.{mjs,py}` | Package validation and isolated checks against installed native agents. | See [conversation checks](artifact-conversations.md) and [release guide](releasing.md). |
| `scripts/build-release.mjs` | Assemble the standalone publishable package. | `npm run build:release` |
| `scripts/recorder/` | Optional demo recording and screenshot generation. | See its own README. |
| `docs/` | Usage guides, architecture, release process and historical design briefs. | — |

Browser tests use temporary fixtures. Real-model and real-TeX cases are opt-in, so a
regular run does not prove external-model behavior. Browser tests and maintenance
scripts are not included in the installed npm package.

## Root files and generated output

Keep package manifests, lockfiles, TypeScript/test configuration, Docker entry points,
the two READMEs, changelog and licence/security/contribution documents at the root.
Those are conventional entry points for users, GitHub and build tools.

`node_modules/`, `packages/*/dist/`, the staged files under `packages/cli/`,
`test-results/`, `playwright-report/`, recorder frames and local `.smoke/` scratch scripts
are ignored development artifacts. They are not extra application modules. Preserve
local scratch work until it is reviewed, and avoid deleting built assets while a
running source installation may still serve them. Disposable logs are ignored too.
