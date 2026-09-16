import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Options, SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeConversationProvider, type ClaudeSdk } from "../src/claude-conversation.js";

const parent = "00000000-0000-4000-8000-000000000001";
const child = "00000000-0000-4000-8000-000000000002";
const delivery = "00000000-0000-4000-8000-000000000003";
const origin = { provider: "claude-code" as const, sessionId: parent, turnId: delivery };
let root: string; let source: SessionMessage[]; let inherited: SessionMessage[];
let sdk: ClaudeSdk; let provider: ClaudeConversationProvider;
let output: (options: Options) => AsyncGenerator<SDKMessage>;
let closed = vi.fn(() => {});
const assistant = (uuid: string, text: string): SessionMessage => ({ type: "assistant", uuid, session_id: parent, message: { role: "assistant", model: "original-model", stop_reason: "end_turn", content: [{ type: "text", text }] }, parent_agent_id: null, parent_tool_use_id: null });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marginote-claude-"));
  source = [assistant(delivery, "Delivered report"), assistant("later", "Later discussion must not leak")];
  inherited = [{ ...source[0]!, uuid: "remapped", session_id: child }];
  closed = vi.fn(() => {});
  output = async function* (options) {
    yield { type: "system", subtype: "init", session_id: child, tools: [], mcp_servers: Object.keys(options.mcpServers ?? {}).map(name => ({ name, status: "connected" })) } as unknown as SDKMessage;
    yield { type: "result", subtype: "success", session_id: child, result: "Original context retained", is_error: false } as SDKMessage;
  };
  sdk = {
    getSessionInfo: vi.fn(async id => ({ sessionId: id, summary: "Fixture", cwd: root, lastModified: 1, fileSize: 100 })),
    getSessionMessages: vi.fn(async id => id === parent ? source : inherited),
    forkSession: vi.fn(async () => ({ sessionId: child })),
    query: vi.fn(({ options }) => ({ [Symbol.asyncIterator]: () => output(options), close: closed })),
  };
  provider = new ClaudeConversationProvider(async () => sdk, async () => "/native/claude");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("forks through an exact completed message using the official SDK and checks inherited content", async () => {
  expect(await provider.fork(origin, AbortSignal.timeout(5000))).toBe(child);
  expect(sdk.forkSession).toHaveBeenCalledWith(parent, { dir: await import("node:fs/promises").then(fs => fs.realpath(root)), upToMessageId: delivery, title: "Marginote artifact conversation" });
  expect(source).toHaveLength(2);
  expect(sdk.query).not.toHaveBeenCalled();
  inherited = [assistant("wrong", "Different history")];
  await expect(provider.fork(origin, AbortSignal.timeout(5000))).rejects.toThrow(/exact delivery history/);
});

it("refuses unfinished, missing and foreign delivery boundaries", async () => {
  (source[0]!.message as { stop_reason: string }).stop_reason = "tool_use";
  await expect(provider.fork(origin, AbortSignal.timeout(5000))).rejects.toThrow(/completed/);
  await expect(provider.fork({ ...origin, turnId: parent }, AbortSignal.timeout(5000))).rejects.toThrow(/completed/);
  await expect(provider.fork({ ...origin, provider: "codex" }, AbortSignal.timeout(5000))).rejects.toThrow(/Claude Code/);
  expect(sdk.forkSession).not.toHaveBeenCalled();
});

it("resumes only the child with its original model and native defaults and revokes MCP", async () => {
  const tools = { definitions: [], call: async () => ({ content: [] }), setModel: vi.fn(), close: vi.fn() };
  expect(await provider.prompt(child, "Continue", { signal: AbortSignal.timeout(5000), approve: async () => false, tools })).toBe("Original context retained");
  const options = vi.mocked(sdk.query).mock.calls[0]![0].options;
  expect(options).toMatchObject({ resume: child, model: "original-model", pathToClaudeCodeExecutable: "/native/claude" });
  for (const key of ["continue", "forkSession", "permissionMode", "allowDangerouslySkipPermissions", "env", "systemPrompt", "settingSources"]) expect(options).not.toHaveProperty(key);
  const mcp = Object.values(options.mcpServers!)[0] as { url: string; headers: Record<string, string> };
  await expect(fetch(mcp.url, { headers: mcp.headers })).rejects.toThrow();
  expect(tools.setModel).toHaveBeenCalledWith("original-model"); expect(tools.close).toHaveBeenCalled(); expect(closed).toHaveBeenCalled();
});

it("relays one-time native permissions without granting persistent rules", async () => {
  let decision: unknown;
  output = async function* (options) {
    decision = await options.canUseTool!("Edit", { file_path: "report.md", old_string: "old", new_string: "new" }, { signal: options.abortController!.signal, toolUseID: "edit", requestId: "request" });
    yield { type: "result", subtype: "success", session_id: child, result: "Done", is_error: false } as SDKMessage;
  };
  const approve = vi.fn(async () => true);
  await provider.prompt(child, "Revise", { signal: AbortSignal.timeout(5000), approve });
  expect(approve).toHaveBeenCalledWith(expect.objectContaining({ kind: "file", detail: expect.stringContaining('"old_string": "old"') }));
  expect(decision).toEqual({ behavior: "allow", updatedInput: { file_path: "report.md", old_string: "old", new_string: "new" } });
});

it("rejects a native initialization that cannot connect the artifact tools", async () => {
  output = async function* () { yield { type: "system", subtype: "init", session_id: child, tools: [], mcp_servers: [] } as unknown as SDKMessage; };
  const tools = { definitions: [], call: async () => ({ content: [] }), setModel: vi.fn(), close: vi.fn() };
  await expect(provider.prompt(child, "Revise", { signal: AbortSignal.timeout(5000), approve: async () => true, tools })).rejects.toThrow(/did not connect/);
  expect(tools.close).toHaveBeenCalled(); expect(closed).toHaveBeenCalled();
});

it("fails closed on a different resumed session and unsupported interactive questions", async () => {
  output = async function* () { yield { type: "system", subtype: "init", session_id: parent } as SDKMessage; };
  await expect(provider.prompt(child, "Continue", { signal: AbortSignal.timeout(5000), approve: async () => true })).rejects.toThrow(/different session/);
  const approve = vi.fn(async () => true);
  output = async function* (options) {
    const result = await options.canUseTool!("AskUserQuestion", {}, { signal: options.abortController!.signal, toolUseID: "question", requestId: "request" });
    expect(result?.behavior).toBe("deny");
    yield { type: "result", subtype: "success", session_id: child, result: "Stopped", is_error: false } as SDKMessage;
  };
  await expect(provider.prompt(child, "Continue", { signal: AbortSignal.timeout(5000), approve })).rejects.toThrow(/unsupported/);
  expect(approve).not.toHaveBeenCalled();
});
