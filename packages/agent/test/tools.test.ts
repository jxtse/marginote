import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBudget, CommentStore, Vault, committedText, insertAttributed, pendingSuggestions, readPolicy, registerAuthor, spans, writePolicy } from "@marginote/bridge";
import { defaultConfig } from "../src/config.js";
import { documentPath, readImage } from "../src/sandbox.js";
import { createComment, createTools, suggestEdit, summaryQuote, type ToolContext } from "../src/tools.js";
import { newSession } from "../src/session.js";

let root: string;
let outside: string;
let vault: Vault;
let context: ToolContext;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "marginote-agent-tools-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "marginote-agent-outside-")));
  await writeFile(join(root, "doc.md"), "# Title\nabcdef\n");
  vault = await Vault.open({ root, persist: false });
  const handle = vault.getDoc("doc.md");
  const author = { id: "agent-test", name: "Test", kind: "agent" as const, color: "gold" }; registerAuthor(handle.doc, author);
  const threadId = new CommentStore(handle.doc).add({ text: handle.text, from: 8, to: 14, body: "Revise", authorId: "human", authorName: "Human" });
  context = { vault, handle, author, threadId, config: defaultConfig(), budget: new AgentBudget(readPolicy(handle.doc)), active: true, signal: new AbortController().signal, snapshot: handle.getContent(), suggestions: [], replies: [], humanCursors: () => [] };
});
afterEach(async () => { vi.unstubAllGlobals(); await vault?.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

describe("sandbox tools", () => {
  it("anchors grill findings in committed text despite pending insertions", () => {
    context.grill = { findings: 0, summary: false };
    insertAttributed(context.handle.text, 8, "PENDING", context.author, { suggestion: "pending" });
    const id = createComment(context, "bcd", "Define this term.");
    const thread = new CommentStore(context.handle.doc).list().find(entry => entry.id === id)!;
    expect(thread.quote).toBe("bcd");
    expect(thread.authorId).toBe(context.author.id);
    expect(context.grill.findings).toBe(1);
    expect(() => createComment(context, "PENDING", "No")).toThrow(/not found/);
  });
  it("rejects absent, empty and ambiguous quotes without consuming the cap", () => {
    context.grill = { findings: 0, summary: false };
    context.handle.text.insert(context.handle.text.length, "abc abc");
    expect(() => createComment(context, "absent", "Fix")).toThrow(/not found/);
    expect(() => createComment(context, "", "Fix")).toThrow(/empty/);
    expect(() => createComment(context, "abc", "Fix")).toThrow(/Ambiguous/);
    expect(context.grill.findings).toBe(0);
    createComment(context, "abcdef", "Fix");
  });
  it("caps findings at eight plus one summary and rejects late calls", () => {
    context.grill = { findings: 0, summary: false };
    for (let index = 0; index < 8; index++) createComment(context, "abcdef", `Fix ${index}`);
    expect(() => createComment(context, "abcdef", "Ninth")).toThrow(/8 findings/);
    createComment(context, "# Title", "Weakness; strength; 1. First 2. Second 3. Third");
    expect(() => createComment(context, "# Title", "Again")).toThrow(/one summary/);
    expect(createTools(context).map(tool => tool.name)).toContain("create_comment");
    context.active = false;
    expect(() => createComment(context, "abcdef", "Late")).toThrow(/no longer active/);
  });
  it("disambiguates a repeated heading for the summary and handles headingless drafts", () => {
    const text = "# Title\nFirst\n# Title\nSecond\n";
    expect(summaryQuote(text)).toBe("# Title\nFirst");
    expect(summaryQuote("\nPlain draft\nMore text")).toBe("Plain draft");
    expect(summaryQuote("\n")).toBe("");
    context.handle.text.delete(0, context.handle.text.length);
    context.handle.text.insert(0, text);
    context.grill = { findings: 0, summary: false };
    createComment(context, summaryQuote(text), "Summary");
    expect(context.grill).toEqual({ findings: 0, summary: true });
  });
  it("rejects traversal, metadata, absolute and symlink escapes", async () => {
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(join(outside, "secret.md"), join(root, "escape.md"));
    for (const path of ["../secret.md", "%2e%2e/secret.md", ".marginote/agent.json", "/etc/passwd", "escape.md", "a\\b.md"]) await expect(documentPath(root, path)).rejects.toThrow();
    expect(await documentPath(root, "doc.md")).toBe(join(root, "doc.md"));
  });
  it("reads images by magic bytes, requiring explicit outside references and rejecting symlinks", async () => {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    await writeFile(join(root, "image.bin"), image);
    expect(await readImage(vault, "doc.md", "image.bin")).toMatchObject({ type: "image", mimeType: "image/png" });
    const external = join(outside, "image.png"); await writeFile(external, image);
    await expect(readImage(vault, "doc.md", external)).rejects.toThrow(/not directly/);
    context.handle.applyFromDisk(`# Title\n![outside](${external})\n`);
    expect(await readImage(vault, "doc.md", external)).toMatchObject({ type: "image" });
    const linked = join(root, "alias.png"); await symlink(external, linked);
    context.handle.applyFromDisk("![alias](alias.png)\n");
    await expect(readImage(vault, "doc.md", "alias.png")).rejects.toThrow(/symlink/);
    await writeFile(join(root, "fake.png"), "not an image");
    await expect(readImage(vault, "doc.md", "fake.png")).rejects.toThrow(/Only PNG/);
    await writeFile(join(root, "large.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(readImage(vault, "doc.md", "large.png")).rejects.toThrow(/5 MB/);
  });
  it("maps committed offsets without deleting another pending insertion", () => {
    insertAttributed(context.handle.text, 10, "PENDING", context.author, { suggestion: "existing" });
    expect(suggestEdit(context, 9, 12, "BCD")).toContain("awaiting human review");
    expect(committedText(context.handle.text)).toBe("# Title\nabcdef\n");
    const pending = spans(context.handle.text).find(span => span.suggestInsert === "existing")!;
    expect(pending.suggestDelete).toBeNull();
    expect(pendingSuggestions(context.handle.text)).toHaveLength(2);
    expect(context.budget.spent).toEqual({ inserted: 3, deleted: 3 });
  });
  it("enforces locks, read-only, budgets, cancellation and stale reads", () => {
    writePolicy(context.handle.doc, { lockedSections: ["Title"] });
    expect(() => suggestEdit(context, 8, 9, "x")).toThrow(/locked/);
    writePolicy(context.handle.doc, { lockedSections: [], mode: "read-only" });
    expect(() => suggestEdit(context, 8, 9, "x")).toThrow(/read-only/);
    writePolicy(context.handle.doc, { mode: "propose", maxInserts: 1, maxDeletes: 1 });
    expect(() => suggestEdit(context, 8, 10, "xx")).toThrow(/budget/);
    context.handle.text.insert(0, "new");
    expect(() => suggestEdit(context, 8, 9, "x")).toThrow(/changed/);
    context.active = false;
    expect(() => suggestEdit(context, 8, 9, "x")).toThrow(/no longer active/);
  });
  it("enables exactly custom tools in a real SDK session, without loading vault extensions", async () => {
    await mkdir(join(root, ".pi/extensions"), { recursive: true });
    await writeFile(join(root, ".pi/extensions/unsafe.ts"), 'throw new Error("MUST NOT LOAD")');
    const tools = createTools(context);
    const session = await newSession({ ...defaultConfig(), model: "test", apiKey: "!must-be-literal-not-a-command" }, root, "doc.md", tools);
    try {
      expect(session.getActiveToolNames().sort()).toEqual(["fetch_page", "list_documents", "read_document", "read_image", "reply_comment", "suggest_edit", "web_search"]);
      expect(session.getActiveToolNames()).not.toContain("bash");
    } finally { session.dispose(); }
  });
  it("executes an SDK streaming tool roundtrip with literal credentials and a final answer", async () => {
    const stream = (delta: unknown, reason: string) => new Response([
      `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream({ role: "assistant", tool_calls: [{ index: 0, id: "tool-call", type: "function", function: { name: "suggest_edit", arguments: JSON.stringify({ from: 8, to: 9, replacement: "A", note: "Capitalize" }) } }] }, "tool_calls"))
      .mockResolvedValueOnce(stream({ role: "assistant", content: "Suggested capitalization." }, "stop"));
    vi.stubGlobal("fetch", fetchMock);
    const session = await newSession({ ...defaultConfig(), baseUrl: "https://provider.example/v1", model: "test", apiKey: "!literal-secret" }, root, "doc.md", createTools(context));
    try {
      await session.prompt("Capitalize the first letter of the paragraph using suggest_edit.");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url, options] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("https://provider.example/v1/chat/completions");
      expect(new Headers(options.headers).get("authorization")).toBe("Bearer !literal-secret");
      expect(context.suggestions).toEqual(["Capitalize"]);
      expect(context.handle.getContent()).toBe("# Title\nabcdef\n");
      expect(JSON.stringify(session.messages.at(-1))).toContain("Suggested capitalization.");
    } finally { session.dispose(); }
  });
  it("reads committed text and lists documents, and confines replies to the active thread", async () => {
    const tools = createTools(context);
    const execute = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute("test", args, undefined, undefined, {} as never);
    expect((await execute("list_documents", {})).content).toEqual([{ type: "text", text: '["doc.md"]' }]);
    insertAttributed(context.handle.text, 8, "PENDING", context.author, { suggestion: "pending" });
    const result = (await execute("read_document", { offsetChars: 8, limitChars: 3 })).content[0]!;
    expect(result.type).toBe("text");
    if (result.type === "text") expect(JSON.parse(result.text)).toMatchObject({ text: "abc", totalChars: 15 });
    await expect(execute("read_document", { path: "../escape.md" })).rejects.toThrow();
    await expect(execute("reply_comment", { threadId: "different", body: "No" })).rejects.toThrow(/active/);
    await execute("reply_comment", { threadId: context.threadId, body: "Answer" });
    expect(new CommentStore(context.handle.doc).list()[0]!.replies[0]!.body).toBe("Answer");
  });
});
