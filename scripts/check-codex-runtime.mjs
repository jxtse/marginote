// Installed Codex app-server + real Marginote tools, with an isolated loopback model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentBudget, CommentStore, Vault, acceptSuggestion, pendingSuggestions, readPolicy } from "../packages/bridge/dist/src/index.js";
import { artifactTools } from "../packages/agent/dist/src/artifact-tools.js";
import { CodexConversationProvider, CodexRpc } from "../packages/agent/dist/src/codex-conversation.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "marginote-codex-runtime-")));
const nonce = `CODE-${randomUUID()}`; const future = `FUTURE-${randomUUID()}`;
const model = "gpt-5.1-codex";
const requests = []; const errors = [];
let vault; let rpc; let succeeded = false;
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
    if (!req.url?.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(raw); requests.push(body);
    const input = body.input;
    const user = [...input].reverse().find(item => item.role === "user");
    const text = JSON.stringify(user?.content);
    const lastCall = [...input].reverse().find(item => item.type === "function_call");
    const tools = (body.tools ?? []).flatMap(t => t.type === "namespace" ? t.tools.map(x => ({ name: x.name, namespace: t.name })) : [{ name: t.name }]);
    let item;
    const message = text => ({ id: `msg_${randomUUID()}`, type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
    const call = (suffix, args) => {
      const tool = tools.find(t => t.name?.endsWith(suffix)); assert(tool, `Native tool absent: ${suffix}`);
      return { id: `fc_${randomUUID()}`, type: "function_call", call_id: `call_${randomUUID()}`, ...tool, arguments: JSON.stringify(args), status: "completed" };
    };
    if (text.includes("TEST_SEED")) item = message("Delivered report.md");
    else if (text.includes("TEST_LATER")) item = message("Later parent answer");
    else {
      assert.equal(body.model, model, "The inherited model must survive resume");
      assert.equal(body.reasoning?.effort, "low", "The recorded reasoning effort must survive resume");
      assert(JSON.stringify(input).includes(nonce), "Inherited history missing");
      assert(!JSON.stringify(input).includes(future), "Later parent history leaked into the child");
      if (text.includes("TEST_FOLLOWUP")) item = message(`The accepted revision retains ${nonce}.`);
      else if (lastCall?.name.endsWith("marginote_suggest_edit")) item = message(`Proposed revision using ${nonce}.`);
      else if (lastCall?.name.endsWith("marginote_read_document")) {
        const doc = documentResult([...input].reverse().find(i => i.type === "function_call_output")); assert(doc, "Native read result missing");
        item = call("marginote_suggest_edit", { revision: doc.revision, old_text: "Original sentence.", new_text: `Reviewed with ${nonce}.`, reason: "Use the inherited discussion" });
      } else item = call("marginote_read_document", {});
    }
    const response = { id: `resp_${randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model, output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    let sequence = 0;
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    event("response.created", { response: { ...response, status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : { ...item, arguments: "", status: "in_progress" } });
    if (item.type === "message") {
      event("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      event("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text });
      event("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text: item.content[0].text });
      event("response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
    } else {
      event("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments });
      event("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments });
    }
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response }); res.end();
  } catch (error) { errors.push(error); console.error(String(error)); res.writeHead(400); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
// Native subprocesses inherit a dedicated test home, not the user's auth/config.
for (const key of Object.keys(process.env)) if (/OPENAI|CODEX|ANTHROPIC|PROXY/i.test(key)) delete process.env[key];
process.env.CODEX_HOME = join(root, "config");
await mkdir(process.env.CODEX_HOME);
const configPath = join(process.env.CODEX_HOME, "config.toml");
const config = `model = "${model}"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "low"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[features]\nenable_request_compression = false\nshell_snapshot = false\n[model_providers.fixture]\nname = "Local test model"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`;
await writeFile(configPath, config);
try {
  const signal = AbortSignal.timeout(120_000);
  rpc = new CodexRpc("codex", ["app-server", "--listen", "stdio://"], root, signal);
  await rpc.initialize();
  const parent = await rpc.request("thread/start", { cwd: root, model, modelProvider: "fixture", sandbox: "read-only", approvalPolicy: "on-request" });
  const parentId = parent.thread.id;
  async function turn(text) {
    let dispose;
    const done = new Promise((resolve, reject) => {
      dispose = rpc.subscribe(m => {
        if (m.method === "marginote/disconnected") reject(m.params.error);
        if (m.method === "turn/completed" && m.params.threadId === parentId) {
          if (m.params.turn.status !== "completed") reject(new Error(JSON.stringify(m.params.turn)));
          else resolve(m.params.turn.id);
        }
      });
    });
    try { const [, id] = await Promise.all([rpc.request("turn/start", { threadId: parentId, input: [{ type: "text", text, text_elements: [] }] }), done]); return id; }
    finally { dispose(); }
  }
  const delivery = await turn(`TEST_SEED: remember ${nonce} and deliver report.md.`);
  await turn(`TEST_LATER: remember ${future}.`);
  const original = await rpc.request("thread/read", { threadId: parentId, includeTurns: true });
  const sourcePath = original.thread.path; assert(sourcePath, "Native rollout was not persisted");
  const source = await readFile(sourcePath, "utf8");
  await rpc.close(); rpc = undefined;
  await writeFile(configPath, config.replace(`model = "${model}"`, 'model = "different-profile-default"').replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "high"'));
  await writeFile(join(root, "report.md"), "Original sentence.\n");
  const provider = new CodexConversationProvider(root);
  const origin = { provider: "codex", sessionId: parentId, turnId: delivery };
  const child = await provider.fork(origin, signal);
  vault = await Vault.open({ root }); const handle = vault.getDoc("report.md");
  const thread = new CommentStore(handle.doc).add({ text: handle.text, from: 0, to: 18, body: "Revise this sentence", authorId: "human", authorName: "Human" });
  const room = { handle, humanCursors: () => [], setAgentPresence() {} };
  const author = { id: "agent-codex-check", kind: "agent", name: "Codex", color: "blue" };
  const tools = () => artifactTools(vault, room, thread, author, new AgentBudget(readPolicy(handle.doc)), signal);
  const answer = await provider.prompt(child, "TEST_EDIT: read the artifact and propose a revision using the inherited code.", { origin, signal, tools: tools(), approve: async () => false });
  assert(answer.includes(nonce)); await vault.flush();
  assert.equal(await readFile(join(root, "report.md"), "utf8"), "Original sentence.\n");
  const proposals = pendingSuggestions(handle.text); assert.equal(proposals.length, 1);
  acceptSuggestion(handle.text, proposals[0]); await vault.flush();
  assert.equal(await readFile(join(root, "report.md"), "utf8"), `Reviewed with ${nonce}.\n`);
  console.log("PASS: installed Codex forked the exact delivery, inherited history/model and called native read/propose tools; disk changed only after acceptance.");
  const followup = await provider.prompt(child, "TEST_FOLLOWUP: confirm the inherited code.", { origin, signal, tools: tools(), approve: async () => false });
  assert(followup.includes(nonce)); assert.equal(await readFile(sourcePath, "utf8"), source);
  assert(requests.length >= 6); assert.deepEqual(errors, []);
  console.log("PASS: another Codex app-server resumed the child with inherited history and model despite a different profile default; source unchanged. Model requests stayed on the local fixture.");
  succeeded = true;
} finally {
  await rpc?.close(); await vault?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (succeeded) await rm(root, { recursive: true, force: true });
  else { await writeFile(join(root, "fixture-errors.json"), JSON.stringify(errors.map(String))); await writeFile(join(root, "fixture-requests.json"), JSON.stringify(requests)); console.error(`FAIL: synthetic Codex fixture retained at ${root}; ${requests.length} model requests`); }
}
