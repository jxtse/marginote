import type { ConversationOrigin, ConversationProvider, ConversationRun, ConversationSnapshot } from "./conversation-provider.js";
import { NativeRpc } from "./native-rpc.js";

/** Uses the installed native Hermes plugin; no cross-provider fallback. */
export class HermesConversationProvider implements ConversationProvider {
  constructor(private readonly cwd: string, private readonly executable = "hermes", private readonly args = ["marginote-bridge"]) {}

  private async open(signal: AbortSignal, capability: string): Promise<NativeRpc> {
    const rpc = new NativeRpc(this.executable, this.args, this.cwd, signal, "Hermes");
    try {
      const initialized = await rpc.request("initialize", {});
      if (initialized?.protocolVersion !== 1 || !initialized.capabilities?.includes(capability)) throw new Error(`The installed Marginote Hermes plugin does not support ${capability}`);
      return rpc;
    } catch (error) { await rpc.close(); throw error; }
  }

  async fork(origin: ConversationOrigin, signal: AbortSignal): Promise<ConversationSnapshot> {
    const pending = /^after-(0|[1-9]\d{0,15})$/.exec(origin.turnId);
    if (origin.provider !== "hermes" || (!pending && !/^[1-9]\d{0,15}$/.test(origin.turnId)) || !Number.isSafeInteger(Number(pending?.[1] ?? origin.turnId))) throw new Error("Hermes requires the exact positive native delivery message row ID or a current-session delivery marker");
    const rpc = await this.open(signal, pending ? "wait_delivery" : "fork_delivery");
    try {
      let delivery = Number(origin.turnId);
      if (pending) {
        const ready = await rpc.request("wait_delivery", { sessionId: origin.sessionId, afterMessageId: Number(pending[1]) }, 600_000);
        if (ready?.sessionId !== origin.sessionId || !Number.isSafeInteger(ready.messageId) || ready.messageId <= Number(pending[1])) throw new Error("Hermes returned an invalid completed delivery");
        delivery = ready.messageId;
      }
      const result = await rpc.request("fork_delivery", { sessionId: origin.sessionId, messageId: delivery });
      if (result?.originSessionId !== origin.sessionId || result.deliveryRowId !== delivery ||
        typeof result.sessionId !== "string" || result.sessionId === origin.sessionId || !/^[\w-]{1,160}$/.test(result.sessionId)) throw new Error("Hermes did not return the expected independent delivery snapshot");
      if (typeof result.model !== "string" || !result.model || typeof result.provider !== "string" || !result.provider ||
          !Number.isSafeInteger(result.activeMessages) || result.activeMessages < 1 || !Number.isSafeInteger(result.archivedMessages) || result.archivedMessages < 0) throw new Error("Update marginote-hermes: the installed plugin did not identify the inherited model and history");
      return { sessionId: result.sessionId, deliveryTurnId: String(delivery), model: result.model, provider: result.provider,
        reasoningEffort: typeof result.reasoningEffort === "string" ? result.reasoningEffort : null,
        activeMessages: result.activeMessages, archivedMessages: result.archivedMessages };
    } finally { await rpc.close(); }
  }

  async prompt(sessionId: string, text: string, run: ConversationRun): Promise<string> {
    if (run.origin?.provider !== "hermes" || sessionId === run.origin.sessionId || !run.tools) throw new Error("Hermes continuation requires its native child, origin and artifact tools");
    const rpc = await this.open(run.signal, "prompt");
    let modelReported = false;
    rpc.requestHandler = async message => {
      run.signal.throwIfAborted();
      const params = message.params ?? {};
      if (message.method === "marginote/tool") {
        if (!modelReported) throw new Error("Hermes must identify its model before editing");
        return run.tools!.call(params.name, params.arguments);
      }
      if (message.method === "marginote/model") {
        if (typeof params.model !== "string" || !params.model.trim()) throw new Error("Hermes did not report the native model");
        run.tools!.setModel(params.model); modelReported = true; return true;
      }
      if (message.method === "marginote/approve") {
        if (typeof params.id !== "string" || typeof params.detail !== "string") throw new Error("Invalid native Hermes approval");
        return run.approve({ id: params.id, kind: "tool", detail: params.detail });
      }
      throw new Error("Continue this unsupported request in the native Hermes client");
    };
    try {
      const result = await rpc.request("prompt", { sessionId, originSessionId: run.origin.sessionId, text, tools: run.tools.definitions }, 660_000);
      if (result?.sessionId !== sessionId || !modelReported || typeof result.text !== "string" || !result.text.trim()) throw new Error("Hermes did not complete the expected native child turn");
      return result.text;
    } finally { run.tools.close(); await rpc.close(); }
  }
}
