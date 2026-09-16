import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(store.list()[0]!.replies).toHaveLength(1);
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
    expect(store.list()[0]!.replies.map(r => r.body)).toEqual(["Another detail", "First answer", "Follow-up answer"]);
  });
  it("holds native approval until an explicit matching decision and rejects stale decisions", async () => {
    vi.mocked(provider.prompt).mockImplementation(async (_session, _text, run) => {
      const accepted = await run.approve({ id: "approval-1", kind: "command", detail: "git diff" });
      return accepted ? "Approved" : "Declined";
    });
    await manager.bind(room, origin); add();
    await vi.waitFor(() => expect(manager.status("report.md")?.state).toBe("approval"));
    expect(store.list()[0]!.replies).toHaveLength(0);
    expect(() => manager.decide("report.md", "wrong", true)).toThrow(/expired/);
    manager.decide("report.md", "approval-1", false); await idle();
    expect(store.list()[0]!.replies[0]!.body).toBe("Declined");
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
    add(); await vi.waitFor(() => expect(store.list()[0]!.replies).toHaveLength(1));
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
});
