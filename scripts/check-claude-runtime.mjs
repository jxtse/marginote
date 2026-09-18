// Installed Claude Code + official SDK + real Marginote tools, with a loopback model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentBudget, CommentStore, Vault, acceptSuggestion, pendingSuggestions, readPolicy } from "../packages/bridge/dist/src/index.js";
import { artifactTools } from "../packages/agent/dist/src/artifact-tools.js";
import { ClaudeConversationProvider } from "../packages/agent/dist/src/claude-conversation.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "marginote-claude-runtime-")));
const nonce = `CODE-${randomUUID()}`;
const future = `FUTURE-${randomUUID()}`;
const model = "claude-sonnet-4-5-20250929";
const requests = []; const errors = [];
let vault; let succeeded = false;
function documentResult(value) {
  if (value && typeof value === "object") {
    if (typeof value.revision === "string" && typeof value.text === "string") return value;
    for (const item of Object.values(value)) { const found = documentResult(item); if (found) return found; }
  } else if (typeof value === "string") {
    try { return documentResult(JSON.parse(value)); } catch { /* not JSON */ }
  }
}
const server = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (req.url?.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":100}'); return; }
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(raw);
    const messages = body.messages;
    const relevant = messages.some(m => JSON.stringify(m.content).includes("TEST_"));
    let block;
    if (!relevant) block = { type: "text", text: "Synthetic auxiliary response." };
    else {
      requests.push(body);
      assert.equal(body.model, model, "The inherited model must survive resume");
      assert(JSON.stringify(messages).includes(nonce), "Inherited source history is absent");
      assert(!JSON.stringify(messages).includes(future), "Messages after the delivery leaked into the child");
      const instruction = [...messages].reverse().find(m => m.role === "user" && JSON.stringify(m.content).includes("TEST_"));
      const text = JSON.stringify(instruction.content);
      const lastCall = [...messages].reverse().flatMap(m => m.role === "assistant" && Array.isArray(m.content) ? m.content.filter(b => b.type === "tool_use") : [])[0];
      const names = (body.tools ?? []).map(t => t.name);
      const tool = suffix => { const name = names.find(n => n.endsWith(suffix)); assert(name, `Native tool absent: ${suffix}; available=${names.join(",")}`); return name; };
      const call = (name, input) => ({ type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "")}`, name, input });
      if (text.includes("TEST_FOLLOWUP")) block = { type: "text", text: `The accepted revision retains ${nonce}.` };
      else if (text.includes("TEST_DENY")) {
        block = lastCall?.name === "Bash" ? { type: "text", text: "The human declined deletion." }
          : call(tool("Bash"), { command: "rm -rf ./approval-fixture", description: "Delete the disposable approval fixture" });
      } else if (lastCall?.name.endsWith("marginote_suggest_edit")) block = { type: "text", text: `Proposed revision using ${nonce}.` };
      else if (lastCall?.name.endsWith("marginote_read_document")) {
        const doc = documentResult(messages.at(-1)); assert(doc, "Native read result missing");
        block = call(tool("marginote_suggest_edit"), { revision: doc.revision, old_text: "Original sentence.", new_text: `Reviewed with ${nonce}.`, reason: "Use the inherited discussion" });
      } else block = call(tool("marginote_read_document"), {});
    }
    const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    event("content_block_delta", { index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
    event("message_stop", {}); res.end();
  } catch (error) { errors.push(error); console.error(String(error)); res.writeHead(400); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
// This dedicated test process and its children use only synthetic credentials/config.
for (const key of Object.keys(process.env)) if (/ANTHROPIC|CLAUDE|OPENAI|CODEX|PROXY/i.test(key)) delete process.env[key];
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, "config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_API_KEY: "synthetic-local-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false",
});
try {
  const sessionId = randomUUID(); const ids = Array.from({ length: 4 }, () => randomUUID());
  const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project, { recursive: true });
  const parent = join(project, `${sessionId}.jsonl`);
  const source = [nonce, "Delivered report.md", future, "Later answer"].map((text, index) => JSON.stringify({
    type: index % 2 ? "assistant" : "user", uuid: ids[index], parentUuid: ids[index - 1] ?? null,
    sessionId, cwd: root, timestamp: new Date().toISOString(), isSidechain: false, version: "2.1.243",
    message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text }],
      ...(index % 2 ? { id: `msg_${index}`, model, stop_reason: "end_turn", type: "message" } : {}) },
  })).join("\n") + "\n";
  await writeFile(parent, source);
  await writeFile(join(root, "report.md"), "Original sentence.\n");
  await mkdir(join(root, "approval-fixture"));
  await writeFile(join(root, "approval-fixture/retained.txt"), "Keep me");
  const signal = AbortSignal.timeout(100_000);
  const provider = new ClaudeConversationProvider();
  const origin = { provider: "claude-code", sessionId, turnId: ids[1] };
  const child = await provider.fork(origin, signal);
  vault = await Vault.open({ root });
  const handle = vault.getDoc("report.md"); const comments = new CommentStore(handle.doc);
  const thread = comments.add({ text: handle.text, from: 0, to: 18, body: "Revise this sentence", authorId: "human", authorName: "Human" });
  const room = { handle, humanCursors: () => [], setAgentPresence() {} };
  const author = { id: "agent-claude-check", kind: "agent", name: "Claude", color: "blue" };
  const tools = () => artifactTools(vault, room, thread, author, new AgentBudget(readPolicy(handle.doc)), signal);
  const answer = await provider.prompt(child, "TEST_EDIT: read the artifact and propose a revision using the inherited code.", { origin, signal, tools: tools(), approve: async request => request.detail.includes("marginote_") });
  assert(answer.includes(nonce));
  await vault.flush(); assert.equal(await readFile(join(root, "report.md"), "utf8"), "Original sentence.\n");
  const proposals = pendingSuggestions(handle.text); assert.equal(proposals.length, 1);
  acceptSuggestion(handle.text, proposals[0]); await vault.flush();
  assert.equal(await readFile(join(root, "report.md"), "utf8"), `Reviewed with ${nonce}.\n`);
  console.log("PASS: installed Claude CLI inherited the exact history/model and called native Marginote read/propose tools; disk changed only after acceptance.");
  const followup = await provider.prompt(child, "TEST_FOLLOWUP: confirm the code from the inherited conversation.", { origin, signal, tools: tools(), approve: async () => false });
  assert(followup.includes(nonce));
  let approvals = 0;
  const denied = await provider.prompt(child, "TEST_DENY: request deletion of the approval-fixture directory and respect the human decision.", { origin, signal, tools: tools(), approve: async request => { assert(request.detail.includes("approval-fixture")); approvals++; return false; } });
  assert(approvals > 0); assert(denied.includes("declined"));
  assert.equal(await readFile(join(root, "approval-fixture/retained.txt"), "utf8"), "Keep me");
  assert.equal(await readFile(parent, "utf8"), source);
  assert(requests.length >= 6); assert.deepEqual(errors, []);
  console.log("PASS: a new Claude process resumed the child, preserved history, and respected denied tool approval; source unchanged. All model requests used the local fixture.");
  succeeded = true;
} finally {
  await vault?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (succeeded) await rm(root, { recursive: true, force: true });
  else { await writeFile(join(root, "fixture-errors.json"), JSON.stringify(errors.map(String))); console.error(`FAIL: synthetic Claude fixture retained at ${root}; ${requests.length} model requests`); }
}
