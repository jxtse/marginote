import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { AgentBudget, CommentStore, pendingSuggestions, readPolicy, spans, type Author, type Vault } from "@marginote/bridge";
import { defaultConfig } from "./config.js";
import { suggestEdit, type ToolContext } from "./tools.js";
import type { AgentRoom } from "./loop.js";
import type { ConversationTools } from "./conversation-provider.js";

const readSchema = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40000 })),
}, { additionalProperties: false });
const editSchema = Type.Object({
  revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  old_text: Type.String({ minLength: 1, maxLength: 40000 }),
  new_text: Type.String({ maxLength: 40000 }),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });
const revision = (source: string) => createHash("sha256").update(source).digest("hex");

/** Per-turn access to the active artifact. Native shell/model permissions are separate. */
export function artifactTools(vault: Vault, room: AgentRoom, threadId: string, author: Author, budget: AgentBudget, signal: AbortSignal): ConversationTools {
  const context: ToolContext = { vault, handle: room.handle, threadId, author, budget, signal,
    config: defaultConfig(), active: true, snapshot: "", suggestions: [], replies: [], allowOrphanedThread: true, humanCursors: () => room.humanCursors() };
  let readRevision: string | null = null;
  const ensureActive = () => {
    signal.throwIfAborted();
    if (!context.active || room.handle.deleted) throw new Error("This artifact tool session has ended");
    const thread = new CommentStore(room.handle.doc).list().find(item => item.id === threadId);
    if (!thread || thread.resolved) throw new Error("The comment is resolved or gone");
  };
  return {
    definitions: [
      { name: "marginote_read_document", description: "Read the live committed artifact source, revision, policy and pending changes. Use this before proposing an edit; disk contents may omit unaccepted suggestions.", inputSchema: { ...readSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      { name: "marginote_suggest_edit", description: "Propose replacing one unique exact passage in the active artifact. Requires the revision returned by marginote_read_document. The change appears live for human acceptance/rejection; does not write the file. Respects document locks and edit budgets. Use this for document changes instead of filesystem tools.", inputSchema: { ...editSchema },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    ],
    async call(name, args) {
      try {
        ensureActive();
        const source = room.handle.getContent();
        if (name === "marginote_read_document") {
          if (!Check(readSchema, args)) throw new Error("Invalid read parameters");
          context.snapshot = source; readRevision = revision(source);
          const offset = args.offset ?? 0;
          const allSpans = spans(room.handle.text);
          const fullSource = room.handle.text.toString();
          const pending = pendingSuggestions(room.handle.text).slice(0, 64).map(id => ({ id,
            inserted: allSpans.filter(span => span.suggestInsert === id).map(span => fullSource.slice(span.from, span.to)).join("").slice(0, 2000),
            deleted: allSpans.filter(span => span.suggestDelete === id).map(span => fullSource.slice(span.from, span.to)).join("").slice(0, 2000),
          }));
          return { content: [{ type: "text", text: JSON.stringify({ path: room.handle.path, revision: readRevision, offset, totalChars: source.length, text: source.slice(offset, offset + (args.limit ?? 24000)), policy: readPolicy(room.handle.doc), pending }) }] };
        }
        if (name !== "marginote_suggest_edit") throw new Error("Unknown artifact tool");
        if (!Check(editSchema, args)) throw new Error("Invalid edit parameters");
        if (!readRevision || args.revision !== readRevision || args.revision !== revision(source)) throw new Error("The document changed or was not read. Read it again before proposing a change.");
        const from = source.indexOf(args.old_text);
        if (from < 0) throw new Error("Passage not found; read the document again");
        if (source.indexOf(args.old_text, from + 1) >= 0) throw new Error("Ambiguous passage; include more surrounding text");
        if (args.old_text === args.new_text) throw new Error("The proposed passage is unchanged");
        return { content: [{ type: "text", text: suggestEdit(context, from, from + args.old_text.length, args.new_text, args.reason) }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : "Artifact tool failed" }], isError: true }; }
    },
    setModel(model) { context.config.model = model; },
    close() { context.active = false; },
  };
}
