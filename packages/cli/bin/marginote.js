#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MarginoteServer } from "@marginote/server";
import { spawn } from "node:child_process";
import { defaultVault } from "./default-vault.js";

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));

/**
 * Find an asset in both layouts.
 *
 * In the repository the web client and registry live in sibling packages; in the published
 * package they sit beside the bundled entry point. Checking both means one binary works
 * from a clone and from `npx marginote` without a build-time substitution.
 */
const locate = (...candidates) => candidates.map((c) => resolve(here, c)).find(existsSync) ?? null;
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  marginote                   Open ~/Documents/Marginote; create it with a welcome
                              document only when the folder does not exist.
  marginote <directory>       Use an existing Markdown/HTML folder or LaTeX project.
  marginote --demo             Try Marginote in a disposable sample vault.

    -v, --version         Print the installed Marginote version
    --demo                Create sample Markdown in a temporary folder, then remove it
                          when Marginote stops. No existing files are read or changed.
    --port <n>            Port to listen on (default 4321)
    --doc <path>          Open this vault-relative artifact
    --origin-provider <id> codex (default), claude-code, or hermes
    --origin-session <id> Attach the original native session to the review link
    --origin-turn <id>    Exact delivery turn; pair with --origin-session and --doc
    --origin-after <row>  Hermes only: wait for this session's next completed answer
    --no-connect          Keep a manual Connect button instead of connecting the origin
    --open                Open the review link in the default browser
    --host <addr>         Bind address (default 127.0.0.1, local only)
    --allow-host <name>   Additionally trust this hostname (repeatable). Needed only
                          when deliberately exposing the vault, e.g. via a tunnel.
    --git                 Opt in to periodic git snapshots of documents changed by Marginote
    --no-discover         Disable the Discover tab (no discovery requests)
    --no-search           Keep the curated index, but disable live GitHub search
    --no-persist          Do not save collaboration state. Comments, attribution and
                          policy then last only as long as the server runs.
    --history             Retain edit history so documents can be replayed. Off by
                          default: keeping it makes document state grow with edit
                          volume rather than with document size.
    --allow-exec          Allow running fenced code blocks from documents. Off by
                          default. Runs arbitrary code as you; refused whenever the
                          server is bound beyond localhost.

  Requests are refused unless they come from loopback or an allowed host, so a web page
  you happen to have open cannot reach into your vault.

  No account, no signup, no telemetry. Core editing stays local. Discover and direct
  peer setup contact public services only when you choose those features.
`);
  process.exit(0);
}

const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const valueFlags = new Set(["--port", "--host", "--allow-host", "--doc", "--origin-provider", "--origin-session", "--origin-turn", "--origin-after"]);
const documentPath = flag("--doc", null);
const originSession = flag("--origin-session", null);
const originAfter = flag("--origin-after", null);
const originTurn = flag("--origin-turn", null) ?? (originAfter !== null ? `after-${originAfter}` : null);
const originProvider = flag("--origin-provider", "codex");
for (const name of ["--doc", "--origin-provider", "--origin-session", "--origin-turn", "--origin-after"]) {
  if (args.includes(name) && (!flag(name, null) || flag(name, "").startsWith("--"))) {
    console.error(`Missing value for ${name}`); process.exit(1);
  }
}
if (originAfter !== null && (originProvider !== "hermes" || args.includes("--origin-turn") || !/^(0|[1-9]\d{0,15})$/.test(originAfter) || !Number.isSafeInteger(Number(originAfter)))) {
  console.error("Use --origin-after with a nonnegative native Hermes message row, without --origin-turn."); process.exit(1);
}
if (!["codex", "claude-code", "hermes"].includes(originProvider) || (args.includes("--origin-provider") && !originSession)) {
  console.error("Use --origin-provider codex|claude-code|hermes with the exact origin session and delivery IDs."); process.exit(1);
}
if (Boolean(originSession) !== Boolean(originTurn) || ((originSession || originTurn) && !documentPath) ||
  [originSession, originTurn].some(id => id !== null && (typeof id !== "string" || !/^[\w-]{1,160}$/.test(id)))) {
  console.error("Provide --doc and both exact --origin-session and --origin-turn IDs."); process.exit(1);
}
const positional = args.filter((arg, index) => !arg.startsWith("-") && !valueFlags.has(args[index - 1]));
const demo = args.includes("--demo");
let demoRoot = null;
if (demo) {
  demoRoot = await mkdtemp(join(tmpdir(), "marginote-demo-"));
  await Promise.all([
    writeFile(join(demoRoot, "welcome.md"), `# Welcome to Marginote

This vault is disposable. Explore freely: it is removed when Marginote stops.

## Try the editor

Type beside a collaborator, select text to leave a comment, or switch on suggesting mode.

## Wake the margin agent

Open Settings to add your provider's API key and model. Select text and leave a comment
to hear back from the agent, or click Grill me for a draft review with recommended fixes.
`, "utf8"),
    writeFile(join(demoRoot, "project-plan.md"), `# Launch plan

- [x] Keep the source as plain Markdown
- [x] Make every collaborator visible
- [ ] Invite the first reviewers

## Principle

Agents should work beside people, not rewrite their files behind the scenes.
`, "utf8"),
    writeFile(join(demoRoot, "architecture.md"), `# Architecture

\`\`\`mermaid
flowchart LR
  Human --> CRDT
  Agent --> CRDT
  CRDT --> Markdown
\`\`\`

The filesystem remains the source of truth.
`, "utf8"),
  ]);
}
const root = demoRoot ?? (positional[0] ? resolve(positional[0]) : await defaultVault());
// The repository build comes first. Both layouts can exist at once -- `build:release`
// stages a copy beside the binary -- and in a clone the live build is the one that
// changes, so preferring the staged copy would serve a stale client after every release.
const webRoot = locate("../../web/dist", "../web");
const registryPath = locate("../../../registry/index.json", "../registry/index.json");

if (!webRoot) {
  console.error("Web client not found. From a clone, run: npm run build");
  process.exit(1);
}

const allowedHosts = args.reduce((acc, arg, i) => {
  if (arg === "--allow-host" && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);

let server;
try {
  server = await MarginoteServer.start({
    root,
    webRoot,
    port: Number(flag("--port", 4321)),
    host: flag("--host", "127.0.0.1"),
    allowedHosts,
    git: args.includes("--git") && !args.includes("--no-git") ? {} : false,
    // Discover is index-only: entries are fetched from their own repositories on request.
    ...(args.includes("--no-discover") || !registryPath ? {} : { registryPath }),
    githubSearch: !args.includes("--no-discover") && !args.includes("--no-search"),
    allowExec: args.includes("--allow-exec"),
    history: args.includes("--history"),
    persist: !args.includes("--no-persist"),
  });
} catch (error) {
  if (demoRoot) await rm(demoRoot, { recursive: true, force: true });
  throw error;
}

const count = server.vault.list().length;
if (documentPath && !server.vault.list().includes(documentPath)) {
  console.error(`Document not found in vault: ${documentPath}`); await server.close(); process.exit(1);
}
if (originSession && originTurn && !args.includes("--no-connect")) {
  const origin = { provider: originProvider, sessionId: originSession, turnId: originTurn };
  const existing = server.conversations.status(documentPath);
  if (existing && (existing.origin.provider !== originProvider || existing.origin.sessionId !== originSession || existing.origin.turnId !== originTurn)) {
    console.error("This document is already bound to a different delivery. Open its conversation details and disconnect explicitly before replacing it.");
    await server.close(); process.exit(1);
  }
  if (!existing) void server.conversations.bind(server.room(documentPath), origin, true).catch(error => {
    console.error(`Conversation connection failed: ${error.message}. See the review page to retry or disconnect.`);
  });
}
const reviewUrl = new URL(`http://127.0.0.1:${server.port}/`);
if (documentPath) reviewUrl.searchParams.set("doc", documentPath);
if (originSession && originTurn) { reviewUrl.searchParams.set("origin-session", originSession); reviewUrl.searchParams.set("origin-turn", originTurn); }
if (originSession && originProvider !== "codex") reviewUrl.searchParams.set("origin-provider", originProvider);
console.log(`\n  Marginote\n`);
console.log(`  vault   ${root}`);
console.log(`  docs    ${count} document${count === 1 ? "" : "s"}`);
console.log(`  local   ${reviewUrl}\n`);
if (args.includes("--open")) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const browser = spawn(command, [reviewUrl.toString()], { stdio: "ignore" });
  browser.on("error", () => console.error(`Open this link in your browser: ${reviewUrl}`));
  browser.unref();
}
if (demoRoot) console.log(`  demo    disposable -- removed when Marginote stops`);
const snapshots = server.git && (await server.git.isRepo());
console.log(`  git     ${snapshots ? "snapshots on (commits when idle)" : "not a repository -- snapshots off"}`);
if (args.includes("--history")) {
  console.log(`  history retained -- documents can be replayed, and state grows with edits`);
}
if (args.includes("--allow-exec")) {
  console.log(`  exec    ENABLED -- documents in this vault can run code as you`);
}
if (allowedHosts.length > 0) console.log(`  trusted ${allowedHosts.join(", ")}`);
console.log(`\n  Local-first. No account needed. Configured agents send context to your provider.`);
console.log(`  Ctrl+C to stop.\n`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server.close();
  } finally {
    if (demoRoot) await rm(demoRoot, { recursive: true, force: true });
  }
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.on("SIGTERM", shutdown);
