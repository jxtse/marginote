import { createHash, randomUUID } from "node:crypto";
import type { ConversationOrigin, ConversationProvider, ConversationRun } from "./conversation-provider.js";
import { ConversationMcp } from "./conversation-mcp.js";
import { setTimeout as delay } from "node:timers/promises";

import { NativeRpc as CodexRpc } from "./native-rpc.js";
export { NativeRpc as CodexRpc } from "./native-rpc.js";

/** Uses the installed, authenticated Codex. Native model and permission settings are inherited. */
export class CodexConversationProvider implements ConversationProvider {
  constructor(private readonly cwd: string, private readonly executable = "codex", private readonly args = ["app-server", "--listen", "stdio://"]) {}
  async fork(origin: ConversationOrigin, signal: AbortSignal): Promise<string> {
    if (origin.provider !== "codex") throw new Error("Expected a Codex conversation origin");
    const rpc = new CodexRpc(this.executable, this.args, this.cwd, signal);
    try {
      await rpc.initialize();
      const original = await rpc.request("thread/read", { threadId: origin.sessionId, includeTurns: true });
      const turn = original?.thread?.turns?.find((item: any) => item.id === origin.turnId);
      if (turn?.status !== "completed") throw new Error("The delivery turn must exist and be completed before handing off");
      const result = await rpc.request("thread/fork", { threadId: origin.sessionId, lastTurnId: origin.turnId });
      const child = result?.thread;
      if (typeof child?.id !== "string" || child.id === origin.sessionId || child.forkedFromId !== origin.sessionId) throw new Error("Codex did not confirm a distinct fork of the original session");
      return child.id;
    } finally { rpc.close(); }
  }
  async prompt(sessionId: string, text: string, run: ConversationRun): Promise<string> {
    const rpc = new CodexRpc(this.executable, this.args, this.cwd, run.signal);
    let dispose: (() => void) | undefined;
    let mcp: ConversationMcp | undefined;
    try {
      if (run.tools) mcp = await ConversationMcp.start(run.tools, run.signal);
      await rpc.initialize();
      const toolServer = `marginote_artifact_${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
      const resumed = await rpc.request("thread/resume", { threadId: sessionId,
        ...(mcp ? { config: { [`mcp_servers.${toolServer}`]: mcp.config } } : {}) });
      if (resumed?.thread?.id !== sessionId) throw new Error("Codex resumed a different session");
      if (typeof resumed.model === "string") run.tools?.setModel(resumed.model);
      if (resumed.thread.turns?.some((turn: any) => turn.status === "inProgress")) throw new Error("This artifact session is already running in another client");
      if (mcp && run.tools) {
        const deadline = Date.now() + 30_000;
        while (true) {
          const inventory = await rpc.request("mcpServerStatus/list", { threadId: sessionId, limit: 100, detail: "full" });
          const target = inventory.data?.find((item: any) => item.name === toolServer);
          if (target?.runtimeStatus === "connected" && run.tools.definitions.every(tool => target.tools?.[tool.name])) break;
          if (Date.now() >= deadline || ["failed", "authenticationRequired", "disabled", "cancelled"].includes(target?.runtimeStatus)) throw new Error("Codex could not connect the artifact editing tools; no model turn was started");
          await delay(500, undefined, { signal: run.signal });
        }
      }
      const changes = new Map<string, string>();
      let unsupported: string | null = null;
      rpc.requestHandler = async message => {
        if (message.params?.threadId !== sessionId) throw new Error("Request belongs to a different session");
        const kind = message.method === "item/commandExecution/requestApproval" ? "command" : message.method === "item/fileChange/requestApproval" ? "file" : null;
        if (!kind) { unsupported = message.method ?? "unknown"; throw new Error("This request requires the native Codex client"); }
        const detail = kind === "command"
          ? [message.params.command, message.params.cwd, message.params.reason].filter(Boolean).join("\n")
          : [changes.get(message.params.itemId), message.params.reason].filter(Boolean).join("\n");
        // Never approve a file request without its actual diff to review.
        if (!detail || (kind === "file" && !changes.has(message.params.itemId))) { unsupported = "file approval without a diff"; return { decision: "decline" }; }
        const accepted = await run.approve({ id: randomUUID(), kind, detail });
        return { decision: accepted ? "accept" : "decline" };
      };
      const final = new Map<string, string>();
      const done = new Promise<string>((resolve, reject) => {
        dispose = rpc.subscribe(message => {
          if (message.method === "marginote/disconnected") { reject(message.params.error); return; }
          const p = message.params;
          if (p?.threadId !== sessionId) return;
          if (message.method === "item/started" && p.item?.type === "fileChange") {
            changes.set(p.item.id, (p.item.changes ?? []).map((c: any) => `${c.path}\n${c.diff ?? ""}`).join("\n\n"));
          }
          if (message.method === "item/completed" && p.item?.type === "agentMessage" && (!p.item.phase || p.item.phase === "final_answer")) final.set(p.item.id, p.item.text ?? "");
          if (message.method === "turn/completed") {
            if (unsupported) reject(new Error(`Continue in Codex: unsupported request ${unsupported}`));
            else if (p.turn?.status !== "completed") reject(new Error(p.turn?.error?.message ?? `Codex turn ${p.turn?.status ?? "failed"}`));
            else resolve([...final.values()].join("\n\n").trim());
          }
        });
      });
      // Observe before starting: very short turns can finish before the RPC response.
      const started = rpc.request("turn/start", { threadId: sessionId, clientUserMessageId: randomUUID(), input: [{ type: "text", text, text_elements: [] }] });
      const [, answer] = await Promise.all([started, done]);
      if (!answer) throw new Error("Codex completed without an answer");
      return answer;
    } finally { dispose?.(); rpc.close(); await mcp?.close(); }
  }
}
