import { agentRequest } from "./agent-settings.js";
const providerName = (provider: string) => provider === "hermes" ? "Hermes" : provider === "claude-code" ? "Claude Code" : "Codex";

export interface ConversationStatus {
  sessionId: string | null;
  origin: { provider: string; sessionId: string; turnId: string };
  state: "connecting" | "idle" | "working" | "approval" | "error";
  error: string | null;
  approval: { id: string; kind: string; detail: string } | null;
  snapshot?: { model: string; provider: string; reasoningEffort: string | null; activeMessages: number; archivedMessages: number } | null;
  currentModel?: string | null;
}

/** A persistent, visible route to the delivery conversation and its pending decisions. */
export class ConversationPanel {
  private readonly element = document.createElement("section");
  private signature = "";
  constructor(parent: HTMLElement, private readonly refresh: () => void) {
    this.element.className = "artifact-conversation";
    this.element.setAttribute("aria-label", "Artifact conversation");
    this.element.hidden = true; parent.prepend(this.element);
  }
  render(doc: string | null, status: ConversationStatus | null): void {
    const signature = JSON.stringify([doc, status]);
    if (signature === this.signature) return;
    this.signature = signature; this.element.replaceChildren();
    this.element.hidden = !doc || !status;
    if (!doc) return;
    if (!status) {
      const query = new URLSearchParams(location.search);
      const sessionId = query.get("origin-session"); const turnId = query.get("origin-turn");
      const provider = query.get("origin-provider") ?? "codex";
      if (!["codex", "claude-code", "hermes"].includes(provider)) return;
      if (query.get("doc") !== doc || !sessionId || !turnId || !/^[\w-]{1,160}$/.test(sessionId) || !/^[\w-]{1,160}$/.test(turnId)) return;
      this.element.hidden = false;
      const title = document.createElement("strong"); title.textContent = `Continue this document with ${providerName(provider)}`;
      const note = document.createElement("p"); note.textContent = "Connect after the delivery turn finishes. Your comments will continue a copy of that conversation.";
      const connect = document.createElement("button"); connect.textContent = "Connect conversation"; connect.type = "button";
      const error = document.createElement("p"); error.setAttribute("role", "status");
      connect.onclick = async () => {
        connect.disabled = true; error.textContent = "Connecting…";
        try { await agentRequest("conversation", { doc, origin: { provider, sessionId, turnId } }); this.refresh(); }
        catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); connect.disabled = false; }
      };
      this.element.append(title, note, connect, error);
      return;
    }
    const title = document.createElement("strong");
    title.textContent = `${providerName(status.origin.provider)} conversation · ${{ connecting: "Connecting…", idle: "Ready", working: "Working…", approval: "Your approval needed", error: "Needs attention" }[status.state]}`;
    title.setAttribute("role", "status");
    const note = document.createElement("p");
    note.textContent = status.state === "connecting"
      ? "Waiting for the originating delivery to finish. Comments posted here will be handled after connection."
      : "Comments continue a separate copy of the originating conversation. The original chat is unchanged.";
    const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Conversation details";
    const reference = document.createElement("p"); reference.textContent = `Original: ${status.origin.sessionId}\nDelivery turn: ${status.origin.turnId.startsWith("after-") ? "Waiting for completion" : status.origin.turnId}\nDocument session: ${status.sessionId ?? "Not connected yet"}`;
    details.append(summary, reference);
    this.element.append(title, note, details);
    if (status.snapshot || status.currentModel) {
      const model = document.createElement("p"); model.className = "conversation-model";
      model.textContent = status.snapshot
        ? `Inherited model: ${status.snapshot.model} · ${status.snapshot.provider}${status.snapshot.reasoningEffort ? ` · reasoning ${status.snapshot.reasoningEffort}` : ""}`
        : `Reported model: ${status.currentModel}`;
      this.element.insertBefore(model, details);
      if (status.snapshot && status.currentModel) {
        const live = document.createElement("p"); live.textContent = `Latest reported model: ${status.currentModel}`; this.element.insertBefore(live, details);
      }
    }
    if (status.snapshot) {
      const history = document.createElement("p");
      history.textContent = `Inherited history: ${status.snapshot.activeMessages} active messages, ${status.snapshot.archivedMessages} archived. Later parent messages are not included.`;
      details.append(history);
      if (status.currentModel && status.currentModel !== status.snapshot.model) {
        const original = document.createElement("p"); original.textContent = `Delivery model: ${status.snapshot.model}. Hermes reported the current model above.`; details.append(original);
      }
    }
    const action = (label: string, path: string, body: Record<string, unknown>) => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.onclick = async () => {
        const buttons = [...this.element.querySelectorAll("button")]; buttons.forEach(b => b.disabled = true);
        try { await agentRequest(`conversation/${path}`, { doc, ...body }); this.refresh(); }
        catch (error) { const failure = document.createElement("p"); failure.textContent = error instanceof Error ? error.message : String(error); failure.setAttribute("role", "alert"); this.element.append(failure); buttons.forEach(b => b.disabled = false); }
      };
      this.element.append(button);
    };
    if (status.approval) {
      const pre = document.createElement("pre"); pre.textContent = status.approval.detail; this.element.append(pre);
      action("Approve once", "decision", { id: status.approval.id, accepted: true });
      action("Decline", "decision", { id: status.approval.id, accepted: false });
    }
    if (status.error) {
      const error = document.createElement("p"); error.textContent = status.error; error.setAttribute("role", "alert"); this.element.append(error);
      action("Retry after checking session", "retry", {});
    }
    if (["connecting", "idle", "error"].includes(status.state)) action("Disconnect conversation", "disconnect", {});
  }
}
