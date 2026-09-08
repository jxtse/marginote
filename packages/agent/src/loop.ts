import { AgentBudget, CommentStore, knownAuthors, readPolicy, registerAuthor, type CommentThread, type DocHandle, type Vault } from "@marginote/bridge";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { ConfigStore } from "./config.js";
import { grillPrompt, newSession, threadPrompt } from "./session.js";
import { createComment, createTools, summaryQuote, type ToolContext } from "./tools.js";

export const AGENT_ID = "agent-marginote-embedded";
const authorId = (name: string) => name === "Margin" ? AGENT_ID : `${AGENT_ID}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
const isEmbedded = (id: string) => id === AGENT_ID || id.startsWith(`${AGENT_ID}-`);

export function shouldTrigger(previous: CommentThread | undefined, thread: CommentThread, isAgent: (id: string) => boolean): boolean {
  if (thread.resolved || thread.orphaned) return false;
  if (!previous) return !isAgent(thread.authorId);
  const participated = isEmbedded(thread.authorId) || previous.replies.some(reply => isEmbedded(reply.authorId));
  return participated && thread.replies.slice(previous.replies.length).some(reply => !isAgent(reply.authorId));
}

export interface AgentRoom {
  handle: DocHandle;
  humanCursors(): Array<{ name: string; index: number }>;
  setAgentPresence(name: string | null): void;
}

export class EmbeddedAgent {
  readonly config: ConfigStore;
  lastError: string | null = null;
  private working = 0;
  private introduced = false;
  private readonly loops = new Map<AgentRoom, DocumentLoop>();
  constructor(readonly vault: Vault, readonly sessionFactory = newSession, readonly timeoutMs = 180000) { this.config = new ConfigStore(vault.root); }
  get status() { return { configured: Boolean(this.config.current.apiKey && this.config.current.model), state: this.working ? "working" : "idle", lastError: this.lastError }; }
  attach(room: AgentRoom): void { if (!this.loops.has(room)) this.loops.set(room, new DocumentLoop(this, room)); }
  detach(room: AgentRoom): void { this.loops.get(room)?.dispose(); this.loops.delete(room); }
  busy(room: AgentRoom): boolean { return this.loops.get(room)?.busy ?? false; }
  grill(room: AgentRoom): string {
    if (!this.status.configured) throw new Error("Configure an API key and model in Settings first");
    if (room.handle.deleted || !room.handle.getContent().trim()) throw new Error("Choose a nonempty document to grill");
    this.attach(room);
    return this.loops.get(room)!.grill();
  }
  close(): void { for (const loop of this.loops.values()) loop.dispose(); this.loops.clear(); }
  begin(): void { this.working++; this.lastError = null; }
  end(): void { this.working--; }
  introduce(store: CommentStore, thread: string): void {
    if (this.introduced) return;
    this.introduced = true;
    const name = this.config.current.agentName;
    store.reply(thread, `I'm ${name}, this workspace's agent — add an API key in Settings and I'll respond to comments like this one.`, authorId(name), name);
  }
}

class DocumentLoop {
  private readonly store: CommentStore;
  private previous = new Map<string, CommentThread>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queue: string[] = [];
  private readonly grills = new Set<string>();
  private readonly sessions = new Map<string, { session: AgentSession; context: ToolContext; config: string }>();
  private active: string | null = null;
  private controller: AbortController | null = null;
  private disposed = false;
  private readonly budget: AgentBudget;
  get busy(): boolean { return this.active !== null || this.queue.length > 0 || this.pending.size > 0; }
  grill(): string {
    if (this.grills.size) throw new Error("A grill is already queued or working for this document");
    const id = `grill-${randomUUID()}`;
    this.grills.add(id);
    this.queue.push(id);
    void this.drain();
    return id;
  }
  constructor(private readonly agent: EmbeddedAgent, private readonly room: AgentRoom) {
    this.store = new CommentStore(room.handle.doc);
    this.previous = new Map(this.store.list().map(thread => [thread.id, thread]));
    this.budget = new AgentBudget(readPolicy(room.handle.doc));
    this.store.yarray.observeDeep(this.observe);
  }
  private readonly observe = (): void => {
    if (this.disposed) return;
    const threads = this.store.list();
    const authors = knownAuthors(this.room.handle.doc);
    const isAgent = (id: string) => id === AGENT_ID || authors[id]?.kind === "agent";
    const previous = this.previous;
    this.previous = new Map(threads.map(thread => [thread.id, thread]));
    for (const thread of threads) {
      if (!shouldTrigger(previous.get(thread.id), thread, isAgent)) continue;
      if (this.queue.includes(thread.id)) continue;
      clearTimeout(this.pending.get(thread.id));
      this.pending.set(thread.id, setTimeout(() => {
        this.pending.delete(thread.id);
        if (this.disposed || this.queue.includes(thread.id)) return;
        this.queue.push(thread.id);
        void this.drain();
      }, 400));
    }
  };
  private async drain(): Promise<void> {
    if (this.active || this.disposed) return;
    const id = this.queue.shift();
    if (!id) return;
    this.active = id;
    try { await this.run(id); }
    catch (error) { console.error("[marginote agent] lifecycle failure", error); }
    finally { this.grills.delete(id); this.active = null; void this.drain(); }
  }
  private async run(id: string): Promise<void> {
    const thread = this.store.list().find(entry => entry.id === id);
    const grill = this.grills.has(id);
    if ((!grill && (!thread || thread.resolved || thread.orphaned)) || this.room.handle.deleted) return;
    const config = this.agent.config.current;
    const author = { id: authorId(config.agentName), name: config.agentName, color: "var(--agent)", kind: "agent" as const };
    registerAuthor(this.room.handle.doc, author);
    if (!config.apiKey || !config.model) { if (!grill) this.agent.introduce(this.store, id); return; }
    if (!grill) this.store.reply(id, "👀 reading…", author.id, author.name);
    this.room.setAgentPresence(author.name);
    this.agent.begin();
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error("Run timed out after 3 minutes")), this.agent.timeoutMs);
    let entry = this.sessions.get(id);
    const fingerprint = JSON.stringify([config, this.room.handle.path]);
    if (entry && entry.config !== fingerprint) { entry.session.dispose(); this.sessions.delete(id); entry = undefined; }
    const context: ToolContext = entry?.context ?? {
      vault: this.agent.vault, handle: this.room.handle, author, budget: this.budget, config, threadId: id,
      active: true, signal: controller.signal, snapshot: this.room.handle.getContent(), suggestions: [], replies: [], humanCursors: () => this.room.humanCursors(),
      ...(grill ? { grill: { findings: 0, summary: false } } : {}),
    };
    Object.assign(context, { active: true, signal: controller.signal, snapshot: this.room.handle.getContent(), suggestions: [], replies: [] });
    try {
      const work = async () => {
        if (!entry) {
          const session = await this.agent.sessionFactory(config, this.agent.vault.root, this.room.handle.path, createTools(context));
          if (controller.signal.aborted) { session.dispose(); controller.signal.throwIfAborted(); }
          entry = { session, context, config: fingerprint };
          this.sessions.set(id, entry);
          if (this.sessions.size > 32) {
            const oldest = this.sessions.keys().next().value!;
            if (oldest !== id) { this.sessions.get(oldest)?.session.dispose(); this.sessions.delete(oldest); }
          }
        }
        await entry.session.prompt(grill ? grillPrompt(context.snapshot) : threadPrompt(context.snapshot, thread!));
      };
      await Promise.race([work(), new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }))]);
      const last = entry?.session.messages.filter(message => message.role === "assistant").at(-1);
      if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) throw new Error(last.errorMessage ?? last.stopReason);
      const answer = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim() : "";
      if (grill) {
        if (!context.grill!.summary) createComment(context, summaryQuote(this.room.handle.getContent()), answer || "The review ended without a summary. Please try Grill me again.");
      } else if (context.suggestions.length) this.store.reply(id, `Suggested an edit: ${context.suggestions.join("; ")}${answer ? `\n\n${answer}` : ""}`.slice(0, 16000), author.id, author.name);
      else if (answer && !context.replies.includes(answer)) this.store.reply(id, answer.slice(0, 16000), author.id, author.name);
      else if (!context.replies.length) this.store.reply(id, "I couldn't produce an answer. Please try again.", author.id, author.name);
    } catch (error) {
      context.active = false;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[marginote agent] ${this.room.handle.path} ${id}`, error);
      const errorClass = controller.signal.aborted ? "timeout or cancellation" : /\b(401|403|429|5\d\d)\b/.exec(detail)?.[0] ? `${/\b(401|403|429|5\d\d)\b/.exec(detail)![0]} from provider` : "provider or agent error";
      this.agent.lastError = errorClass;
      if (!this.disposed && !grill) this.store.reply(id, `Sorry, I hit an error (${errorClass}). Check Settings → Agent.`, author.id, author.name);
      if (entry) { void entry.session.abort().catch(() => {}); entry.session.dispose(); this.sessions.delete(id); entry = undefined; }
    } finally {
      context.active = false;
      clearTimeout(timeout);
      if (grill && entry) { entry.session.dispose(); this.sessions.delete(id); }
      controller.abort();
      this.controller = null;
      if (!this.disposed) this.room.setAgentPresence(null);
      this.agent.end();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.store.yarray.unobserveDeep(this.observe);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear(); this.queue.length = 0;
    this.controller?.abort(new Error("Room closed"));
    for (const entry of this.sessions.values()) { entry.context.active = false; void entry.session.abort().catch(() => {}); entry.session.dispose(); }
    this.sessions.clear();
  }
}
