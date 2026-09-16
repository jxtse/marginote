import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import { MarginoteServer } from "../src/server.js";
import { CommentStore } from "@marginote/bridge";
import type { ConversationProvider } from "@marginote/agent";

let root: string;
let server: MarginoteServer;
let native: Mocked<ConversationProvider>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marginote-server-agent-"));
  await writeFile(join(root, "doc.md"), "Document");
  native = { fork: vi.fn<ConversationProvider["fork"]>(async () => "child"), prompt: vi.fn<ConversationProvider["prompt"]>(async () => "From the original conversation") };
  server = await MarginoteServer.start({ root, port: 0, git: false, conversationProvider: native });
});
afterEach(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });
const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}/api/agent/${path}`, init);

describe("agent routes", () => {
  it("binds an exact native origin, routes comments, and disconnects without touching the parent", async () => {
    const post = (path: string, body: unknown, headers = {}) => request(path, { method: "POST", body: JSON.stringify(body), headers });
    const origin = { provider: "codex", sessionId: "parent", turnId: "delivery" };
    expect(await (await request("conversation?doc=doc.md")).json()).toBe(null);
    expect((await post("conversation", { doc: "doc.md", origin }, { Origin: "https://untrusted.test" })).status).toBe(403);
    expect(native.fork).not.toHaveBeenCalled();
    expect((await post("conversation", { doc: "../escape.md", origin })).status).toBe(404);
    expect((await post("conversation", { doc: "doc.md", origin: { ...origin, provider: "unsupported-agent" } })).status).toBe(400);
    const result = await post("conversation", { doc: "doc.md", origin });
    expect(result.status).toBe(201); expect(await result.json()).toMatchObject({ sessionId: "child", origin });
    expect((await post("conversation", { doc: "doc.md", origin })).status).toBe(400);
    expect(native.fork).toHaveBeenCalledTimes(1);
    const handle = server.vault.getDoc("doc.md"); const comments = new CommentStore(handle.doc);
    comments.add({ text: handle.text, from: 0, to: 8, body: "Explain", authorId: "human", authorName: "Human" });
    await vi.waitFor(() => expect(comments.list()[0]!.replies.at(-1)?.body).toBe("From the original conversation"));
    expect(native.prompt.mock.calls[0]![0]).toBe("child");
    expect(await (await request("status?doc=doc.md")).json()).toMatchObject({ conversation: { state: "idle" } });
    expect((await post("conversation/decision", { doc: "doc.md", id: "expired", accepted: true })).status).toBe(400);
    expect((await post("conversation/disconnect", { doc: "doc.md" })).status).toBe(200);
    expect(await (await request("conversation?doc=doc.md")).json()).toBe(null);
  });
  it("validates grill requests and enqueues the current document", async () => {
    const post = (body: unknown) => request("grill", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ doc: "doc.md" })).status).toBe(409);
    for (const doc of ["missing.md", "../doc.md", null]) expect((await post({ doc })).status).toBe(404);
    await server.agent.config.save({ apiKey: "fake", model: "fake" });
    const grill = vi.spyOn(server.agent, "grill").mockReturnValue("grill-test");
    const response = await post({ doc: "doc.md" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ enqueued: true, runId: "grill-test" });
    expect(grill.mock.calls[0]![0].handle.path).toBe("doc.md");
    expect(await (await request("status?doc=doc.md")).json()).toMatchObject({ busy: false });
    grill.mockRestore();
  });
  it("roundtrips config, masks keys, reports status and excludes metadata from documents", async () => {
    const response = await request("config", { method: "POST", body: JSON.stringify({ apiKey: "sk-private-12345", model: "model", webSearch: { apiKey: "search-secret" } }) });
    expect(response.status).toBe(200);
    const saved = await response.json() as { apiKey: string };
    expect(saved.apiKey).not.toContain("private");
    const loaded = await request("config"); expect(loaded.headers.get("cache-control")).toBe("no-store");
    expect(await loaded.json()).toEqual(saved);
    expect(await (await request("status")).json()).toEqual({ configured: true, state: "idle", lastError: null });
    expect(server.vault.list()).toEqual(["doc.md"]);
  });
  it("rejects malformed updates, incorrect methods and hostile origins", async () => {
    expect((await request("config", { method: "POST", body: "{bad" })).status).toBe(400);
    expect((await request("config", { method: "DELETE" })).status).toBe(405);
    expect((await request("config", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await request("test", { method: "POST" })).status).toBe(502);
  });
});
