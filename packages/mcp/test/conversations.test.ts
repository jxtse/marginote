import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CommentStore } from "@marginote/bridge";
import { MarginoteServer } from "@marginote/server";
import { createQuireMcpServer } from "../src/server.js";

it("offers exact delivery links and exposes actionable threads and replies through MCP", async () => {
  const root = await mkdtemp(join(tmpdir(), "marginote-mcp-conversation-"));
  await writeFile(join(root, "report.md"), "Discuss this report.\n");
  const server = await MarginoteServer.start({ root, port: 0, git: false });
  const url = `http://127.0.0.1:${server.port}`;
  const mcp = await createQuireMcpServer({ serverUrl: url, agentName: "Codex", agentColor: "green" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(a); await client.connect(b);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const text = (result: Awaited<ReturnType<typeof call>>) => (result.content as Array<{ type: string; text: string }>).find(c => c.type === "text")!.text;
    const result = await call("review_document", { path: "report.md", origin_session: "parent", origin_turn: "delivery" });
    const link = new URL(JSON.parse(text(result)).url);
    expect(link.searchParams.get("doc")).toBe("report.md"); expect(link.searchParams.get("origin-turn")).toBe("delivery");
    expect(server.conversations.owns("report.md")).toBe(false);
    expect((await call("review_document", { path: "report.md", origin_session: "parent" })).isError).toBe(true);
    const claudeLink = new URL(JSON.parse(text(await call("review_document", { path: "report.md", origin_provider: "claude-code", origin_session: "parent", origin_turn: "delivery" }))).url);
    expect(claudeLink.searchParams.get("origin-provider")).toBe("claude-code");
    expect((await call("review_document", { path: "report.md", origin_provider: "claude-code" })).isError).toBe(true);
    const hermesLink = new URL(JSON.parse(text(await call("review_document", { path: "report.md", origin_provider: "hermes", origin_session: "parent", origin_turn: "42" }))).url);
    expect(hermesLink.searchParams.get("origin-provider")).toBe("hermes");
    expect(hermesLink.searchParams.get("origin-turn")).toBe("42");
    const handle = server.vault.getDoc("report.md"); const comments = new CommentStore(handle.doc);
    const id = comments.add({ text: handle.text, from: 0, to: 7, body: "Explain", authorId: "human", authorName: "Human" });
    const listed = JSON.parse(text(await call("list_comments", { path: "report.md" })));
    expect(listed[0]).toMatchObject({ id, body: "Explain", replies: [] });
    expect((await call("reply_comment", { path: "report.md", thread_id: "missing", body: "Answer" })).isError).toBe(true);
    expect((await call("reply_comment", { path: "report.md", thread_id: id, body: "Answer" })).isError).not.toBe(true);
    expect(comments.list()[0]!.replies.at(-1)!.body).toBe("Answer");
    expect((await call("create_document", { path: "paper.tex" })).isError).not.toBe(true);
    expect(server.vault.getDoc("paper.tex").getContent()).toContain("\\documentclass{article}");
    expect((await call("create_document", { path: "report.html" })).isError).not.toBe(true);
    expect(server.vault.getDoc("report.html").getContent()).toContain("<!doctype html>");
    expect(JSON.parse(text(await call("review_document", { path: "report.html" }))).url).toContain("doc=report.html");
  } finally { await client.close(); await mcp.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
