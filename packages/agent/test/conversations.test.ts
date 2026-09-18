import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentStore, Vault, registerAuthor } from "@marginote/bridge";
import { ArtifactConversations } from "../src/conversations.js";
import { EmbeddedAgent, type AgentRoom } from "../src/loop.js";
import type { ConversationProvider } from "../src/conversation-provider.js";

let root: string; let vault: Vault; let manager: ArtifactConversations; let room: AgentRoom; let store: CommentStore;
let provider: ConversationProvider; let embedded: EmbeddedAgent | undefined;
const origin = { provider: "codex", sessionId: "original", turnId: "delivery" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marginote-conversation-"));
  await writeFile(join(root, "report.md"), "The original report.\n");
  vault = await Vault.open({ root });
  room = { handle: vault.getDoc("report.md"), humanCursors: () => [], setAgentPresence: vi.fn() };
  store = new CommentStore(room.handle.doc);
  provider = { fork: vi.fn(async () => "native-child"), prompt: vi.fn(async () => "Native answer") };
  manager = new ArtifactConversations(vault, provider);
});
afterEach(async () => { embedded?.close(); embedded = undefined; await manager.close(); await vault.close(); await rm(root, { recursive: true, force: true }); });
const add = (body = "Explain this") => store.add({ text: room.handle.text, from: 0, to: 12, body, authorId: "human", authorName: "Human" });
const idle = () => vi.waitFor(() => expect(manager.busy("report.md")).toBe(false));

describe("artifact conversations", () => {
  it("answers comments and follow-ups submitted during the fork without replaying old comments", async () => {
    const old = add("Leave this existing comment alone");
    const followed = add("An existing thread with a new follow-up");
    let complete!: (session: string) => void;
    vi.mocked(provider.fork).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const connecting = manager.bind(room, origin);
    const added = add("Posted while connecting");
    store.reply(followed, "Follow-up while connecting", "human", "Human");
    complete("native-child"); await connecting; await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    expect(store.list().find(thread => thread.id === old)!.replies).toHaveLength(0);
    for (const id of [followed, added]) expect(store.list().find(thread => thread.id === id)!.replies.at(-1)!.body).toBe("Native answer");
  });
  it("refuses a fork whose document was renamed and keeps ownership until the fork settles", async () => {
    let complete!: (session: string) => void;
    let signal!: AbortSignal;
    vi.mocked(provider.fork).mockImplementation((_origin, input) => { signal = input; return new Promise(resolve => { complete = resolve; }); });
    const connecting = manager.bind(room, origin);
    const checked = expect(connecting).rejects.toThrow(/renamed|identity/);
    await rename(join(root, "report.md"), join(root, "renamed.md"));
    await vi.waitFor(() => expect(room.handle.path).toBe("renamed.md"));
    expect(signal.aborted).toBe(true);
    expect(manager.owns("renamed.md")).toBe(true);
    expect(manager.busy("renamed.md")).toBe(true);
    complete("native-child"); await checked;
    expect(manager.paths()).toEqual([]);
    expect(manager.owns("report.md")).toBe(false); expect(manager.owns("renamed.md")).toBe(false);
    await expect(readFile(join(root, ".marginote/conversations.json"))).rejects.toThrow(/ENOENT/);
    vi.mocked(provider.fork).mockResolvedValue("replacement-child");
    await manager.bind(room, origin);
    expect(manager.status("renamed.md")?.sessionId).toBe("replacement-child");
    const saved = JSON.parse(await readFile(join(root, ".marginote/conversations.json"), "utf8"));
    expect(saved.bindings.map((binding: { doc: string }) => binding.doc)).toEqual(["renamed.md"]);
  });
  it("refuses a fork whose document was deleted", async () => {
    let complete!: (session: string) => void;
    vi.mocked(provider.fork).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const connecting = manager.bind(room, origin);
    const checked = expect(connecting).rejects.toThrow(/deleted|identity/);
    await rm(join(root, "report.md"));
    await vi.waitFor(() => expect(room.handle.deleted).toBe(true), { timeout: 3000 });
    complete("native-child"); await checked;
    expect(manager.paths()).toEqual([]);
  });
  it("waits for an in-flight fork to stop before closing", async () => {
    let complete!: (session: string) => void;
    let signal!: AbortSignal;
    vi.mocked(provider.fork).mockImplementation((_origin, input) => { signal = input; return new Promise(resolve => { complete = resolve; }); });
    const connecting = manager.bind(room, origin);
    const checked = expect(connecting).rejects.toThrow();
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(closed).toBe(false);
    complete("native-child"); await checked; await closing;
    expect(manager.paths()).toEqual([]);
  });
  it("forks at an explicit delivery point and reuses the child across comments and restart", async () => {
    const old = add("Existing comment");
    await manager.bind(room, origin);
    expect(provider.fork).toHaveBeenCalledWith(origin, expect.any(AbortSignal));
    expect(provider.prompt).not.toHaveBeenCalled();
    const first = add(); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.prompt).mock.calls[0]![0]).toBe("native-child");
    expect(vi.mocked(provider.prompt).mock.calls[0]![1]).toContain("The original report");
    expect(store.list().find(t => t.id === old)!.replies).toHaveLength(0);
    expect(store.list().find(t => t.id === first)!.replies.at(-1)!.body).toBe("Native answer");
    store.reply(first, "And what follows?", "human", "Human"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    await manager.close(); await vault.close();
    vault = await Vault.open({ root });
    room = { ...room, handle: vault.getDoc("report.md") }; store = new CommentStore(room.handle.doc);
    manager = new ArtifactConversations(vault, provider); await manager.load(); manager.attach(room); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    add("A new topic"); await idle();
    expect(provider.fork).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.prompt).mock.calls.map(call => call[0])).toEqual(["native-child", "native-child", "native-child"]);
  });
  it("routes externally owned documents away from pi and ignores agent self-events", async () => {
    embedded = new EmbeddedAgent(vault, undefined, undefined, doc => manager.owns(doc)); embedded.attach(room);
    await manager.bind(room, origin);
    const id = add(); await idle();
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(store.list()[0]!.replies.map(r => r.body)).toEqual(["👀 received · reading…", "Native answer"]);
    registerAuthor(room.handle.doc, { id: "another-agent", name: "Other", kind: "agent", color: "blue" });
    store.reply(id, "External observation", "another-agent", "Other"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(() => embedded!.grill(room)).toThrow(/original agent/);
  });
  it("continues human discussion after its quoted passage was deleted", async () => {
    await manager.bind(room, origin);
    const id = add(); await idle();
    room.handle.text.delete(0, room.handle.text.length);
    room.handle.text.insert(0, "The revised report.\n");
    expect(store.list()[0]!.orphaned).toBe(true);
    store.reply(id, "Explain the revision", "human", "Human"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    const call = vi.mocked(provider.prompt).mock.calls[1]!;
    expect(call[0]).toBe("native-child");
    expect(call[1]).toContain("The revised report");
    expect(call[1]).toContain('"orphaned":true');
    expect(store.list()[0]!.quote).toBe("The original");
    expect(store.list()[0]!.replies.at(-1)!.body).toBe("Native answer");
  });
  it("serializes human follow-ups arriving during an active turn", async () => {
    const resolvers: Array<(value: string) => void> = [];
    vi.mocked(provider.prompt).mockImplementation(async () => new Promise(resolve => resolvers.push(resolve)));
    await manager.bind(room, origin);
    const id = add(); await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    store.reply(id, "Another detail", "human", "Human");
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    resolvers.shift()!("First answer"); await vi.waitFor(() => expect(provider.prompt).toHaveBeenCalledTimes(2));
    expect(vi.mocked(provider.prompt).mock.calls[1]![1]).toContain("Another detail");
    resolvers.shift()!("Follow-up answer"); await idle();
    expect(store.list()[0]!.replies.map(r => r.body)).toEqual(["👀 received · reading…", "Another detail", "First answer", "👀 received · reading…", "Follow-up answer"]);
  });
  it("holds native approval until an explicit matching decision and rejects stale decisions", async () => {
    vi.mocked(provider.prompt).mockImplementation(async (_session, _text, run) => {
      const accepted = await run.approve({ id: "approval-1", kind: "command", detail: "git diff" });
      return accepted ? "Approved" : "Declined";
    });
    await manager.bind(room, origin); add();
    await vi.waitFor(() => expect(manager.status("report.md")?.state).toBe("approval"));
    expect(store.list()[0]!.replies.map(r => r.body)).toEqual(["👀 received · reading…"]);
    expect(() => manager.decide("report.md", "wrong", true)).toThrow(/expired/);
    manager.decide("report.md", "approval-1", false); await idle();
    expect(store.list()[0]!.replies.at(-1)!.body).toBe("Declined");
    expect(() => manager.decide("report.md", "approval-1", true)).toThrow(/expired/);
  });
  it("does not auto-retry uncertain native failures or an interrupted persisted turn", async () => {
    vi.mocked(provider.prompt).mockRejectedValueOnce(new Error("Native connection lost"));
    await manager.bind(room, origin); add(); await idle();
    expect(manager.status("report.md")?.error).toContain("connection lost");
    add("Queued while offline"); await idle(); expect(provider.prompt).toHaveBeenCalledTimes(1);
    await manager.retry("report.md"); await idle(); expect(provider.prompt).toHaveBeenCalledTimes(3);
    await manager.close();
    const path = join(root, ".marginote/conversations.json"); const state = JSON.parse(await readFile(path, "utf8"));
    state.bindings[0].active = "interrupted"; await writeFile(path, JSON.stringify(state));
    manager = new ArtifactConversations(vault, provider); await manager.load(); manager.attach(room);
    expect(manager.status("report.md")?.error).toContain("actions may already have run");
    expect(provider.prompt).toHaveBeenCalledTimes(3);
  });
  it("restores a persisted answer without rerunning the provider", async () => {
    await manager.bind(room, origin); const id = add(); await idle();
    await manager.close();
    const entry = [...store.yarray].find(t => t.get("id") === id)!; entry.set("replies", []);
    manager = new ArtifactConversations(vault, provider); await manager.load(); manager.attach(room); await idle();
    expect(store.list()[0]!.replies[0]!.body).toBe("Native answer");
    expect(provider.prompt).toHaveBeenCalledTimes(1);
  });
  it("follows a document rename and pauses on deletion", async () => {
    await manager.bind(room, origin);
    room.handle.path = "renamed.md";
    vault.emit("doc:rename", { from: "report.md", to: "renamed.md" });
    expect(manager.owns("report.md")).toBe(false); expect(manager.owns("renamed.md")).toBe(true);
    add(); await vi.waitFor(() => expect(store.list()[0]!.replies.at(-1)?.body).toBe("Native answer"));
    expect(vi.mocked(provider.prompt).mock.calls[0]![1]).toContain("renamed.md");
    vault.emit("doc:delete", { path: "renamed.md" });
    expect(manager.status("renamed.md")?.error).toContain("deleted");
    add("Replacement"); expect(provider.prompt).toHaveBeenCalledTimes(1);
  });
  it("rejects unknown providers, rebinding, parent-session reuse and corrupt saved routes", async () => {
    await expect(manager.bind(room, { ...origin, provider: "unknown" })).rejects.toThrow(/Unsupported native session provider/);
    vi.mocked(provider.fork).mockResolvedValueOnce("original");
    await expect(manager.bind(room, origin)).rejects.toThrow(/did not fork/);
    expect(manager.owns("report.md")).toBe(false);
    await manager.bind(room, origin);
    await expect(manager.bind(room, origin)).rejects.toThrow(/already/);
    await manager.close(); await writeFile(join(root, ".marginote/conversations.json"), "{}");
    manager = new ArtifactConversations(vault, provider);
    await expect(manager.load()).rejects.toThrow(/Invalid/);
  });

  it("shows pending handoff, preserves inherited metadata and reports the actual model", async () => {
    let deliver!: (value: Awaited<ReturnType<ConversationProvider["fork"]>>) => void;
    vi.mocked(provider.fork).mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const source = { provider: "hermes", sessionId: "current-session", turnId: "after-40" };
    const connecting = manager.bind(room, source, true);
    expect(manager.status("report.md")).toMatchObject({ state: "connecting", sessionId: null });
    expect(manager.owns("report.md")).toBe(true);
    add("While the delivery is finishing");
    vi.mocked(provider.prompt).mockImplementation(async (_session, prompt, run) => {
      expect(prompt).toContain("no separate MCP setup is required");
      expect(prompt).not.toContain("attached Marginote MCP server");
      run.tools!.setModel("runtime-model");
      return "Answered";
    });
    deliver({ sessionId: "native-child", deliveryTurnId: "44", model: "delivery-model", provider: "native-route", reasoningEffort: "high", activeMessages: 12, archivedMessages: 4 });
    await connecting; await idle();
    expect(manager.status("report.md")).toMatchObject({ origin: { ...source, turnId: "44" },
      snapshot: { model: "delivery-model", activeMessages: 12 }, currentModel: "runtime-model" });
    await manager.close();
    manager = new ArtifactConversations(vault, provider); await manager.load();
    expect(manager.status("report.md")?.snapshot?.activeMessages).toBe(12);
  });

  it("retains automatic connection failures without silently using the embedded agent", async () => {
    vi.mocked(provider.fork).mockRejectedValueOnce(new Error("Delivery still active"));
    await expect(manager.bind(room, origin, true)).rejects.toThrow("Delivery still active");
    expect(manager.status("report.md")).toMatchObject({ state: "error", error: "Delivery still active" });
    expect(manager.owns("report.md")).toBe(true); expect(manager.busy("report.md")).toBe(false);
    expect(manager.connecting("report.md")).toBe(true);
    add("Queued after connection failed");
    await manager.retry("report.md"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(store.list()[0]!.replies.at(-1)!.body).toBe("Native answer");
  });

  it("disconnects a pending handoff only after its native wait stops", async () => {
    let stop!: () => void;
    vi.mocked(provider.fork).mockImplementation((_origin, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { stop = () => reject(new Error("Cancelled waiting for delivery")); });
    }));
    const connecting = manager.bind(room, { provider: "hermes", sessionId: "parent", turnId: "after-3" }, true);
    const checked = expect(connecting).rejects.toThrow("Cancelled waiting for delivery");
    let stopped = false;
    const disconnecting = manager.unbind("report.md").then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false); expect(manager.owns("report.md")).toBe(true);
    stop(); await checked; await disconnecting;
    expect(manager.status("report.md")).toBeNull(); expect(manager.owns("report.md")).toBe(false);
    expect(provider.prompt).not.toHaveBeenCalled();
  });
});
