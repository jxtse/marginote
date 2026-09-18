import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HermesConversationProvider } from "../src/hermes-conversation.js";

let root: string; let script: string;
const origin = { provider: "hermes" as const, sessionId: "original", turnId: "42" };
const fixture = String.raw`
import { createInterface } from "node:readline";
const mode = process.argv[2];
const pending = new Map();
let sequence = 0;
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const ask = (method, params) => new Promise(resolve => {
  const id = "native-" + ++sequence; pending.set(id, resolve); send({ id, method, params });
});
createInterface({ input: process.stdin }).on("line", async line => {
  const request = JSON.parse(line);
  if (!request.method) { pending.get(request.id)?.(request); pending.delete(request.id); return; }
  let result;
  if (request.method === "initialize") result = { protocolVersion: 1, capabilities: mode === "old" ? ["fork_delivery"] : ["fork_delivery", "wait_delivery", "prompt"] };
  if (request.method === "wait_delivery") result = { sessionId: request.params.sessionId, messageId: mode === "stale" ? request.params.afterMessageId : 43 };
  if (request.method === "fork_delivery") result = { sessionId: mode === "parent" ? "original" : "child", originSessionId: request.params.sessionId, deliveryRowId: request.params.messageId, model: "native-model", provider: "native-provider", reasoningEffort: "high", activeMessages: 6, archivedMessages: 2 };
  if (request.method === "prompt") {
    if (mode === "hang") return;
    if (mode !== "missing-model") await ask("marginote/model", { model: "native-model" });
    const read = await ask("marginote/tool", { name: "marginote_read_document", arguments: {} });
    if (read.error) { send({ id: request.id, error: { message: read.error.message } }); return; }
    const answer = await ask("marginote/approve", { id: "request-1", detail: "Native reviewable operation" });
    result = { sessionId: mode === "wrong" ? "different-child" : request.params.sessionId, text: answer.result ? "Approved once" : "Declined" };
  }
  send({ id: request.id, result });
});
`;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "marginote-hermes-rpc-")); script = join(root, "native.mjs"); await writeFile(script, fixture); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const provider = (mode = "normal") => new HermesConversationProvider(root, process.execPath, [script, mode]);
const tools = () => ({ definitions: [], call: vi.fn(async () => ({ content: [{ type: "text" as const, text: "Native source" }] })), setModel: vi.fn(), close: vi.fn() });

it("forks the exact numeric delivery and refuses a parent masquerading as a child", async () => {
  expect(await provider().fork(origin, AbortSignal.timeout(5000))).toMatchObject({ sessionId: "child", deliveryTurnId: "42", model: "native-model", provider: "native-provider", activeMessages: 6 });
  await expect(provider("parent").fork(origin, AbortSignal.timeout(5000))).rejects.toThrow(/independent/);
  await expect(provider().fork({ ...origin, turnId: "latest" }, AbortSignal.timeout(5000))).rejects.toThrow(/row ID/);
});

it("waits for the calling turn's delivery and rejects a stale boundary", async () => {
  const pending = { ...origin, turnId: "after-42" };
  expect(await provider().fork(pending, AbortSignal.timeout(5000))).toMatchObject({ sessionId: "child", deliveryTurnId: "43" });
  await expect(provider("stale").fork(pending, AbortSignal.timeout(5000))).rejects.toThrow(/invalid completed delivery/);
  await expect(provider("old").fork(pending, AbortSignal.timeout(5000))).rejects.toThrow(/does not support wait_delivery/);
});

it("bridges scoped artifact tools, native model identity and one-time human decisions", async () => {
  const toolset = tools(); const approve = vi.fn(async () => true);
  expect(await provider().prompt("child", "Explain", { origin, signal: AbortSignal.timeout(5000), tools: toolset, approve })).toBe("Approved once");
  expect(toolset.setModel).toHaveBeenCalledWith("native-model");
  expect(toolset.call).toHaveBeenCalledWith("marginote_read_document", {});
  expect(approve).toHaveBeenCalledWith({ id: "request-1", kind: "tool", detail: "Native reviewable operation" });
  expect(toolset.close).toHaveBeenCalled();
});

it("keeps a rejected approval rejected and refuses unsupported installed plugins", async () => {
  expect(await provider().prompt("child", "Explain", { origin, signal: AbortSignal.timeout(5000), tools: tools(), approve: async () => false })).toBe("Declined");
  await expect(provider("old").prompt("child", "Explain", { origin, signal: AbortSignal.timeout(5000), tools: tools(), approve: async () => true })).rejects.toThrow(/does not support prompt/);
});

it("fails closed on model/child identity violations and cannot prompt the original", async () => {
  for (const mode of ["wrong", "missing-model"]) {
    const toolset = tools();
    await expect(provider(mode).prompt("child", "Explain", { origin, signal: AbortSignal.timeout(5000), tools: toolset, approve: async () => true })).rejects.toThrow();
    expect(toolset.close).toHaveBeenCalled();
  }
  await expect(provider().prompt("original", "Explain", { origin, signal: AbortSignal.timeout(5000), tools: tools(), approve: async () => true })).rejects.toThrow(/native child/);
});

it("cancels a live native turn and revokes its artifact capability", async () => {
  const toolset = tools(); const controller = new AbortController();
  const work = provider("hang").prompt("child", "Explain", { origin, signal: controller.signal, tools: toolset, approve: async () => false });
  const checked = expect(work).rejects.toThrow(/cancelled/);
  setTimeout(() => controller.abort(), 200);
  await checked;
  expect(toolset.close).toHaveBeenCalled();
});
