import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AgentBudget, CommentStore, committedText, committedToFull, insertAttributed, isRangeLocked,
  proposeDelete, readPolicy, registerAuthor, registerRun, spans,
  type Author, type DocHandle, type Vault,
} from "@marginote/bridge";
import type { AgentConfig } from "./config.js";
import { documentPath, readImage } from "./sandbox.js";
import { fetchPage, webSearch } from "./search.js";

export interface ToolContext {
  vault: Vault;
  handle: DocHandle;
  author: Author;
  budget: AgentBudget;
  config: AgentConfig;
  threadId: string;
  active: boolean;
  signal: AbortSignal;
  snapshot: string;
  suggestions: string[];
  replies: string[];
  /** Native artifact discussions retain deleted quotes; edits use a fresh source revision. */
  allowOrphanedThread?: boolean;
  grill?: { findings: number; summary: boolean };
  humanCursors: () => Array<{ name: string; index: number }>;
}

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function ensureActive(context: ToolContext): void {
  context.signal.throwIfAborted();
  if (!context.active || context.handle.deleted) throw new Error("This agent run is no longer active");
  if (context.grill) return;
  const thread = new CommentStore(context.handle.doc).list().find(entry => entry.id === context.threadId);
  if (!thread || thread.resolved || (thread.orphaned && !context.allowOrphanedThread)) throw new Error("The comment is resolved, orphaned or gone");
}

export function summaryQuote(text: string): string {
  let quote = /^#{1,6}[\t ]+.+$/m.exec(text)?.[0] ?? text.split("\n").find(line => line.trim()) ?? "";
  if (!quote) return quote;
  const start = text.indexOf(quote);
  while (text.indexOf(quote, start + 1) >= 0) {
    const nextLine = text.indexOf("\n", start + quote.length + 1);
    quote = text.slice(start, nextLine < 0 ? text.length : nextLine);
  }
  return quote;
}

export function createComment(context: ToolContext, quote: string, body: string): string {
  ensureActive(context);
  if (!context.grill) throw new Error("Only grill runs may create comments");
  if (!quote || !body.trim()) throw new Error("Quote and body must not be empty");
  const text = committedText(context.handle.text);
  const from = text.indexOf(quote);
  if (from < 0) throw new Error("Quote not found in committed text; read again and adjust the quote");
  if (text.indexOf(quote, from + 1) >= 0) throw new Error("Ambiguous quote; include more surrounding text");
  const summary = quote === summaryQuote(text);
  if (summary ? context.grill.summary : context.grill.findings >= 8) throw new Error(summary ? "Only one summary comment is allowed" : "At most 8 findings are allowed");
  const id = new CommentStore(context.handle.doc).add({ text: context.handle.text,
    from: committedToFull(context.handle.text, from), to: committedToFull(context.handle.text, from + quote.length),
    body, authorId: context.author.id, authorName: context.author.name });
  if (summary) context.grill.summary = true;
  else context.grill.findings++;
  return id;
}

export function suggestEdit(context: ToolContext, from: number, to: number, replacement: string, note?: string): string {
  ensureActive(context);
  const { handle, author } = context;
  const committed = committedText(handle.text);
  if (![from, to].every(Number.isSafeInteger) || from < 0 || to < from || to > committed.length) throw new Error("Invalid committed-text range");
  if (committed !== context.snapshot) throw new Error("The document changed. Read it again before suggesting an edit.");
  const fullFrom = committedToFull(handle.text, from);
  const fullTo = committedToFull(handle.text, to);
  const policy = readPolicy(handle.doc);
  const locked = isRangeLocked(handle.text.toString(), policy.lockedSections, fullFrom, fullTo);
  if (locked) throw new Error(`"${locked.heading}" is locked against agent edits in this document.`);
  const existing = spans(handle.text);
  if (existing.some(span => span.suggestDelete && span.from < fullTo && span.to > fullFrom)) throw new Error("This range already has a pending deletion suggestion; wait for human review.");
  context.budget.update(policy);
  const verdict = context.budget.admit({ inserted: replacement.length, deleted: to - from });
  if (!verdict.allowed) throw new Error(verdict.reason);
  const suggestion = `s_${randomUUID()}`;
  const run = `r_${randomUUID()}`;
  registerAuthor(handle.doc, author);
  registerRun(handle.doc, { id: run, authorId: author.id, model: context.config.model, prompt: note ?? null, tool: "suggest_edit" });
  handle.doc.transact(() => {
    for (const span of existing) {
      if (span.suggestInsert) continue;
      const start = Math.max(span.from, fullFrom);
      const end = Math.min(span.to, fullTo);
      if (end > start) proposeDelete(handle.text, start, end, author, suggestion);
    }
    if (replacement) insertAttributed(handle.text, fullTo, replacement, author, { suggestion, run });
  }, `author:${author.id}`);
  context.suggestions.push(note?.slice(0, 200) || replacement.slice(0, 160) || "Remove the selected text");
  const human = context.humanCursors().find(cursor => cursor.index >= fullFrom - 120 && cursor.index <= fullTo + 120);
  return `Proposed ${suggestion}; awaiting human review. The file on disk is unchanged.${human ? ` ${human.name} is working nearby; no direct edits were made.` : ""}`;
}

export function createTools(context: ToolContext) {
  return [
    ...(context.grill ? [defineTool({
      name: "create_comment", label: "Create review comment", description: "Post an exact, uniquely anchored finding (maximum 8). Reserve the first heading/first nonempty line quote for one final summary comment.",
      parameters: Type.Object({ quote: Type.String({ minLength: 1 }), body: Type.String({ minLength: 1, maxLength: 12000 }) }),
      async execute(_id, args) { return textResult(createComment(context, args.quote, args.body)); },
    })] : []),
    defineTool({
      name: "read_document", label: "Read document", description: "Read committed Markdown. Offsets are characters in committed text, not pending suggestions.",
      parameters: Type.Object({ path: Type.Optional(Type.String()), offsetChars: Type.Optional(Type.Integer({ minimum: 0 })), limitChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 40000 })) }),
      async execute(_id, args) {
        ensureActive(context);
        const path = args.path ?? context.handle.path;
        await documentPath(context.vault.root, path);
        ensureActive(context);
        if (!context.vault.list().includes(path)) throw new Error("No document at this path");
        const text = context.vault.getDoc(path).getContent();
        if (path === context.handle.path) context.snapshot = text;
        const offset = args.offsetChars ?? 0;
        return textResult(JSON.stringify({ path, offsetChars: offset, totalChars: text.length, text: text.slice(offset, offset + (args.limitChars ?? 24000)) }));
      },
    }),
    defineTool({
      name: "list_documents", label: "List documents", description: "List documents in the vault.", parameters: Type.Object({}),
      async execute() { ensureActive(context); return textResult(JSON.stringify(context.vault.list())); },
    }),
    defineTool({
      name: "read_image", label: "Read image", description: "Read a vault image, or an outside image directly linked from vault Markdown. Relative paths use the current document directory.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, args) {
        ensureActive(context);
        const image = await readImage(context.vault, context.handle.path, args.path);
        ensureActive(context);
        return { content: [image], details: {} };
      },
    }),
    defineTool({
      name: "suggest_edit", label: "Suggest edit", description: "Propose a replacement in the current document at committed-text offsets. Never commits edits. Read again if the document changed.",
      parameters: Type.Object({ from: Type.Integer({ minimum: 0 }), to: Type.Integer({ minimum: 0 }), replacement: Type.String({ maxLength: 40000 }), note: Type.Optional(Type.String({ maxLength: 2000 })) }),
      async execute(_id, args) { return textResult(suggestEdit(context, args.from, args.to, args.replacement, args.note)); },
    }),
    defineTool({
      name: "reply_comment", label: "Reply to comment", description: "Reply to the active comment thread. Use this or a final answer, not both with the same text.",
      parameters: Type.Object({ threadId: Type.String(), body: Type.String({ minLength: 1, maxLength: 12000 }) }),
      async execute(_id, args) {
        ensureActive(context);
        if (context.grill) throw new Error("Grill runs have no active thread; use create_comment");
        if (args.threadId !== context.threadId) throw new Error("Only the active comment thread may be answered");
        new CommentStore(context.handle.doc).reply(args.threadId, args.body, context.author.id, context.author.name);
        context.replies.push(args.body);
        return textResult("Reply posted");
      },
    }),
    defineTool({
      name: "web_search", label: "Search the web", description: "Find public web sources. On failure report search unavailable; never fabricate sources.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 2000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }),
      async execute(_id, args) { ensureActive(context); return textResult(JSON.stringify(await webSearch(context.config.webSearch, args.query, args.limit, context.signal))); },
    }),
    defineTool({
      name: "fetch_page", label: "Read web page", description: "Read a public HTML page (up to 40,000 characters). Private network addresses are forbidden.",
      parameters: Type.Object({ url: Type.String({ maxLength: 4096 }) }),
      async execute(_id, args) { ensureActive(context); return textResult(await fetchPage(args.url, context.signal)); },
    }),
  ];
}
