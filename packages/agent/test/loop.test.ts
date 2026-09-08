import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentStore, Vault, registerAuthor } from "@marginote/bridge";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AGENT_ID, EmbeddedAgent, shouldTrigger, type AgentRoom } from "../src/loop.js";

let root: string;
let vault: Vault;
let agent: EmbeddedAgent;
let room: AgentRoom;
let comments: CommentStore;
const fake = () => ({
  prompt: vi.fn(async (_text: string) => {}), abort: vi.fn(async () => {}), dispose: vi.fn(),
  messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Here is my answer." }] }],
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marginote-agent-loop-"));
  await writeFile(join(root, "doc.md"), "A paragraph to discuss.\n");
  await writeFile(join(root, "other.md"), "Another paragraph.\n");
  vault = await Vault.open({ root, persist: false });
  room = { handle: vault.getDoc("doc.md"), humanCursors: () => [], setAgentPresence: vi.fn() };
  comments = new CommentStore(room.handle.doc);
});
afterEach(async () => { agent?.close(); vi.useRealTimers(); vi.restoreAllMocks(); await vault?.close(); await rm(root, { recursive: true, force: true }); });
function add(body = "Question", authorId = "human"): string {
  return comments.add({ text: room.handle.text, from: 0, to: 10, body, authorId, authorName: authorId });
}
async function configure(factory: ConstructorParameters<typeof EmbeddedAgent>[1], timeoutMs = 180000) {
  agent = new EmbeddedAgent(vault, factory, timeoutMs);
  await agent.config.save({ apiKey: "test-key", model: "test-model" });
  agent.attach(room); vi.useFakeTimers();
}

describe("comment lifecycle", () => {
  it("triggers only eligible human comments and human replies to agent conversations", () => {
    const id = add(); const thread = comments.list()[0]!;
    const isAgent = (author: string) => author === AGENT_ID;
    expect(shouldTrigger(undefined, thread, isAgent)).toBe(true);
    expect(shouldTrigger(undefined, { ...thread, authorId: AGENT_ID }, isAgent)).toBe(false);
    expect(shouldTrigger(undefined, { ...thread, resolved: true }, isAgent)).toBe(false);
    expect(shouldTrigger(undefined, { ...thread, orphaned: true }, isAgent)).toBe(false);
    comments.reply(id, "another human", "human2", "Human");
    expect(shouldTrigger(thread, comments.list()[0]!, isAgent)).toBe(false);
    comments.reply(id, "answer", AGENT_ID, "Margin"); const participated = comments.list()[0]!;
    expect(shouldTrigger(thread, participated, isAgent)).toBe(false);
    comments.reply(id, "followup", "human", "Human");
    expect(shouldTrigger(participated, comments.list()[0]!, isAgent)).toBe(true);
    const external = { ...participated, replies: participated.replies.map(reply => ({ ...reply, authorId: "external-agent" })) };
    expect(shouldTrigger(external, { ...external, replies: [...external.replies, { authorId: "human", authorName: "Human", body: "Followup", at: 1 }] }, author => author === "external-agent")).toBe(false);
  });
  it("debounces, ignores agent self-events and reuses the thread session", async () => {
    const session = fake(); const factory = vi.fn(async () => session as unknown as AgentSession);
    await configure(factory);
    registerAuthor(room.handle.doc, { id: "other-agent", name: "Other", kind: "agent", color: "gold" });
    add("Ignore", "other-agent"); const id = add();
    await vi.advanceTimersByTimeAsync(399); expect(factory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(comments.list().find(thread => thread.id === id)!.replies.map(reply => reply.body)).toEqual(["👀 reading…", "Here is my answer."]);
    comments.reply(id, "Follow up", "human", "Human");
    comments.reply(id, "And this", "human", "Human");
    await vi.advanceTimersByTimeAsync(400);
    expect(factory).toHaveBeenCalledTimes(1); expect(session.prompt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(agent.status).toMatchObject({ configured: true, state: "idle", lastError: null });
  });
  it("runs FIFO, never concurrently within a document, and preserves a follow-up during work", async () => {
    const resolvers: Array<() => void> = [];
    const order: string[] = [];
    const factory = vi.fn(async () => {
      const session = fake();
      session.prompt.mockImplementation(text => { order.push(text); return new Promise<void>(resolve => resolvers.push(resolve)); });
      return session as unknown as AgentSession;
    });
    await configure(factory);
    const first = add("First"); add("Second");
    await vi.advanceTimersByTimeAsync(400);
    expect(factory).toHaveBeenCalledTimes(1); expect(agent.status.state).toBe("working");
    comments.reply(first, "Followup", "human", "Human"); comments.reply(first, "More", "human", "Human");
    await vi.advanceTimersByTimeAsync(400); expect(factory).toHaveBeenCalledTimes(1);
    resolvers.shift()!(); await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(2); expect(order[1]).toContain("Second");
    resolvers.shift()!(); await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(2); expect(order[2]).toContain("Followup");
    resolvers.shift()!(); await vi.advanceTimersByTimeAsync(0);
    expect(agent.status.state).toBe("idle");
  });
  it("posts one unconfigured introduction across all rooms", async () => {
    const factory = vi.fn(); agent = new EmbeddedAgent(vault, factory); agent.attach(room);
    const other = { ...room, handle: vault.getDoc("other.md") }; agent.attach(other);
    vi.useFakeTimers(); add(); add("Second");
    const otherComments = new CommentStore(other.handle.doc);
    otherComments.add({ text: other.handle.text, from: 0, to: 5, body: "Third", authorId: "human", authorName: "Human" });
    await vi.advanceTimersByTimeAsync(400);
    expect([...comments.list(), ...otherComments.list()].flatMap(thread => thread.replies)).toHaveLength(1);
    expect(factory).not.toHaveBeenCalled();
  });
  it("does not replay old comments or pick up resolved queued threads", async () => {
    add("Existing"); const factory = vi.fn(async () => fake() as unknown as AgentSession);
    await configure(factory);
    const id = add("Resolved before pickup"); comments.setResolved(id, true);
    await vi.advanceTimersByTimeAsync(1000); expect(factory).not.toHaveBeenCalled();
  });
  it("caps runs, aborts the session, disables late tools, and continues the queue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let tools: ToolDefinition[] = [];
    const session = fake(); session.prompt.mockImplementation(() => new Promise(() => {}));
    const factory = vi.fn(async (_config, _vault, _path, customTools: ToolDefinition[]) => { tools = customTools; return session as unknown as AgentSession; });
    await configure(factory, 1000);
    const id = add(); await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.abort).toHaveBeenCalled(); expect(agent.status.state).toBe("idle");
    expect(comments.list().find(thread => thread.id === id)!.replies.at(-1)!.body).toContain("timeout");
    const tool = tools.find(tool => tool.name === "suggest_edit")!;
    await expect(tool.execute("late", { from: 0, to: 1, replacement: "bad" }, undefined, undefined, {} as never)).rejects.toThrow();
    expect(room.handle.getContent()).toBe("A paragraph to discuss.\n");
  });
  it("surfaces provider errors without leaking details into comments", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const session = fake(); session.prompt.mockRejectedValue(new Error("401 secret-value"));
    await configure(async () => session as unknown as AgentSession);
    add(); await vi.advanceTimersByTimeAsync(400);
    const body = comments.list()[0]!.replies.at(-1)!.body;
    expect(body).toContain("401 from provider"); expect(body).not.toContain("secret-value");
  });
  it("detaches observers and cancels pending work on room disposal", async () => {
    const factory = vi.fn(async () => fake() as unknown as AgentSession);
    await configure(factory); add(); agent.detach(room);
    await vi.advanceTimersByTimeAsync(1000); add("After detach"); await vi.advanceTimersByTimeAsync(1000);
    expect(factory).not.toHaveBeenCalled();
  });
});
