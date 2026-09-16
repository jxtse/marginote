// Called only by check-hermes-runtime.py against an isolated synthetic profile.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentBudget, CommentStore, Vault, acceptSuggestion, pendingSuggestions, readPolicy } from "../packages/bridge/dist/src/index.js";
import { artifactTools } from "../packages/agent/dist/src/artifact-tools.js";
import { HermesConversationProvider } from "../packages/agent/dist/src/hermes-conversation.js";

const [root, parent, delivery] = process.argv.slice(2);
assert(root && parent && delivery);
assert.equal(await readFile(join(root, "synthetic-check-marker"), "utf8"), "marginote-local-hermes-test");
const provider = new HermesConversationProvider(root);
const origin = { provider: "hermes", sessionId: parent, turnId: delivery };
const signal = AbortSignal.timeout(150_000);
let vault;
try {
  const child = await provider.fork(origin, signal);
  vault = await Vault.open({ root });
  const handle = vault.getDoc("report.md");
  const comments = new CommentStore(handle.doc);
  const thread = comments.add({ text: handle.text, from: 0, to: 27, body: "Revise using our original discussion", authorId: "human", authorName: "Human" });
  const room = { handle, humanCursors: () => [], setAgentPresence() {} };
  const author = { id: "agent-hermes-test", kind: "agent", name: "Hermes", color: "purple" };
  const budget = new AgentBudget(readPolicy(handle.doc));
  const before = await readFile(join(root, "report.md"), "utf8");
  const answer = await provider.prompt(child, "Read the artifact, then propose revising its claim with the secret code from our original conversation. Use the Marginote tools.", {
    signal, origin, approve: async () => false, tools: artifactTools(vault, room, thread, author, budget, signal),
  });
  assert(answer.includes("Proposed"));
  await vault.flush(); assert.equal(await readFile(join(root, "report.md"), "utf8"), before);
  const suggestions = pendingSuggestions(handle.text); assert.equal(suggestions.length, 1);
  acceptSuggestion(handle.text, suggestions[0]); await vault.flush();
  const revised = await readFile(join(root, "report.md"), "utf8");
  assert(revised.startsWith("This claim remembers "));
  assert(comments.list()[0].orphaned);
  const followup = await provider.prompt(child, "Follow-up: remember the code from our original conversation and confirm the revision.", {
    signal, origin, approve: async () => false, tools: artifactTools(vault, room, thread, author, budget, signal),
  });
  const nonce = revised.match(/remembers ([A-Z0-9-]+)\./)[1];
  assert(followup.includes(nonce));
  let approvals = 0;
  const denied = await provider.prompt(child, "Approval-check: request deletion of the disposable approval-fixture directory, respecting the human decision.", {
    signal, origin, approve: async request => { assert(request.detail.includes("approval-fixture")); approvals++; return false; },
    tools: artifactTools(vault, room, thread, author, budget, signal),
  });
  assert(approvals > 0); assert(denied.includes("declined"));
  assert.equal(await readFile(join(root, "approval-fixture", "retained.txt"), "utf8"), "Human declined deletion");
  await writeFile(join(root, "checked-child.json"), JSON.stringify({ child, nonce }));
  console.log("PASS: native Hermes continued its child, called real Marginote edit tools, preserved disk until acceptance, resumed for a follow-up and respected a denied native permission. Model responses came only from the local test server.");
} finally { await vault?.close(); }
