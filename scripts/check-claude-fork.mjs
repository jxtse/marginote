// Official SDK file operations against synthetic native transcripts. No model requests.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ClaudeConversationProvider } from "../packages/agent/dist/src/claude-conversation.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "marginote-claude-fork-")));
// This script runs in its own process; real Claude config and sessions are never opened.
process.env.CLAUDE_CONFIG_DIR = join(root, "fixture-config");
try {
  const sdkPath = createRequire(new URL("../packages/agent/package.json", import.meta.url)).resolve("@anthropic-ai/claude-agent-sdk");
  const sdk = await import(pathToFileURL(sdkPath).href);
  const sessionId = randomUUID(); const ids = Array.from({ length: 4 }, () => randomUUID());
  const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project, { recursive: true });
  const sourcePath = join(project, `${sessionId}.jsonl`);
  const entries = ["Remember the synthetic code ABC.", "Delivered report: ABC.", "Later request that must not leak.", "Later answer."].map((text, index) => ({
    type: index % 2 ? "assistant" : "user", uuid: ids[index], parentUuid: ids[index - 1] ?? null,
    sessionId, cwd: root, timestamp: new Date().toISOString(), isSidechain: false, version: "2.1.243",
    message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text }],
      ...(index % 2 ? { id: `msg_${index}`, model: "synthetic-model", stop_reason: "end_turn", type: "message" } : {}) },
  }));
  const source = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(sourcePath, source);
  const provider = new ClaudeConversationProvider();
  const child = await provider.fork({ provider: "claude-code", sessionId, turnId: ids[1] }, AbortSignal.timeout(20_000));
  const messages = await sdk.getSessionMessages(child, { dir: root, includeSystemMessages: true });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].message.content[0].text, entries[1].message.content[0].text);
  assert(messages.every(message => !ids.includes(message.uuid)));
  assert.equal(await readFile(sourcePath, "utf8"), source);
  console.log("PASS: official Claude SDK fork retained the exact delivery prefix, remapped message UUIDs and left the source transcript byte-for-byte unchanged. No model was called.");
  if (process.env.MARGINOTE_CLAUDE_RELEASE === "1") {
    await writeFile(join(root, "report.md"), "Synthetic release validation.\n");
    const processHandle = spawn(process.execPath, [fileURLToPath(new URL("../packages/cli/dist/marginote.js", import.meta.url)), root, "--port", "0", "--no-discover", "--no-git"], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => processHandle.once("exit", resolve));
    try {
      const url = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Release CLI startup timed out")), 20_000);
        processHandle.once("error", error => { clearTimeout(timer); reject(error); });
        processHandle.once("exit", () => { clearTimeout(timer); reject(new Error(`Release CLI exited before startup: ${output.slice(-1000)}`)); });
        for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on("data", chunk => {
          output += chunk.toString();
          const found = output.match(/local\s+(http:\/\/127\.0\.0\.1:\d+)/);
          if (found) { clearTimeout(timer); resolve(found[1]); }
        });
      });
      const response = await fetch(`${url}/api/agent/conversation`, { method: "POST", headers: { "content-type": "application/json", Origin: url }, body: JSON.stringify({ doc: "report.md", origin: { provider: "claude-code", sessionId, turnId: ids[1] } }), signal: AbortSignal.timeout(20_000) });
      const state = await response.json();
      assert.equal(response.status, 201, JSON.stringify(state));
      assert.equal(state.origin.provider, "claude-code");
      assert.equal(typeof state.sessionId, "string");
      assert.notEqual(state.sessionId, sessionId);
      const saved = await sdk.getSessionMessages(state.sessionId, { dir: root, includeSystemMessages: true });
      assert.equal(saved.length, 2);
      assert.equal(await readFile(sourcePath, "utf8"), source);
      console.log("PASS: the bundled release CLI forked and bound the exact Claude delivery through its real HTTP endpoint. No comments or model requests were submitted.");
    } finally {
      processHandle.kill("SIGTERM");
      const timer = setTimeout(() => processHandle.kill("SIGKILL"), 5000);
      await exited; clearTimeout(timer);
    }
  }
  if (process.env.MARGINOTE_CLAUDE_PROTOCOL === "1") {
    const executable = execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    let warm;
    try {
      warm = await sdk.startup({ options: { resume: child, cwd: root, model: "synthetic-model", pathToClaudeCodeExecutable: executable, abortController: controller }, initializeTimeoutMs: 20_000 });
      console.log("PASS: the installed Claude CLI completed the SDK initialization handshake. No prompt was submitted and no model turn was started.");
    } finally { clearTimeout(timer); warm?.close(); controller.abort(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
