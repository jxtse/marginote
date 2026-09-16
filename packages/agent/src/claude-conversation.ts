import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Options, SDKMessage, SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationOrigin, ConversationProvider, ConversationRun } from "./conversation-provider.js";
import { ConversationMcp } from "./conversation-mcp.js";

export interface ClaudeSdk {
  getSessionInfo(id: string): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(id: string, options: { dir: string; includeSystemMessages: true }): Promise<SessionMessage[]>;
  forkSession(id: string, options: { dir: string; upToMessageId: string; title: string }): Promise<{ sessionId: string }>;
  query(input: { prompt: string; options: Options }): AsyncIterable<SDKMessage> & { close(): void };
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const contentHash = (messages: SessionMessage[]) => createHash("sha256").update(JSON.stringify(messages.map(message => ({ type: message.type, message: message.message, parentTool: message.parent_tool_use_id, parentAgent: message.parent_agent_id })))).digest("hex");

async function installedClaude(): Promise<string> {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const path = join(directory, `claude${suffix}`);
      try { await access(path, constants.X_OK); return await realpath(path); } catch { /* next PATH candidate */ }
    }
  }
  throw new Error("Claude Code is not installed on PATH. Install/sign in through your usual Claude Code client first.");
}

/** Official native transcript fork + the user's installed Claude Code executable. */
export class ClaudeConversationProvider implements ConversationProvider {
  constructor(private readonly load: () => Promise<ClaudeSdk> = () => import("@anthropic-ai/claude-agent-sdk"), private readonly executable: () => Promise<string> = installedClaude) {}

  private async session(sdk: ClaudeSdk, id: string): Promise<{ info: SDKSessionInfo; cwd: string; messages: SessionMessage[] }> {
    if (!uuid.test(id)) throw new Error("Claude Code requires an exact session UUID");
    const info = await sdk.getSessionInfo(id);
    if (!info?.cwd) throw new Error("Claude Code session or its original working directory was not found");
    if ((info.fileSize ?? 0) > 64 * 1024 * 1024) throw new Error("Claude Code session exceeds the 64 MiB handoff limit");
    const cwd = await realpath(info.cwd);
    const messages = await sdk.getSessionMessages(id, { dir: cwd, includeSystemMessages: true });
    if (!messages.length || messages.length > 50_000) throw new Error("Claude Code history is missing or too large");
    return { info, cwd, messages };
  }

  async fork(origin: ConversationOrigin, signal: AbortSignal): Promise<string> {
    if (origin.provider !== "claude-code" || !uuid.test(origin.turnId)) throw new Error("Expected a Claude Code session and delivery message UUID");
    signal.throwIfAborted();
    await this.executable();
    const sdk = await this.load();
    const original = await this.session(sdk, origin.sessionId);
    const boundary = original.messages.findIndex(message => message.uuid === origin.turnId);
    const delivery = original.messages[boundary];
    const payload = delivery?.message as { stop_reason?: string; content?: Array<{ type?: string }> } | undefined;
    if (boundary < 0 || delivery?.type !== "assistant" || !["end_turn", "stop_sequence"].includes(payload?.stop_reason ?? "") || !payload?.content?.some(block => block.type === "text")) throw new Error("The delivery boundary must be a completed Claude assistant message");
    signal.throwIfAborted();
    const child = await sdk.forkSession(origin.sessionId, { dir: original.cwd, upToMessageId: origin.turnId, title: "Marginote artifact conversation" });
    if (!uuid.test(child.sessionId) || child.sessionId === origin.sessionId) throw new Error("Claude Code did not create a distinct child session");
    const inherited = await this.session(sdk, child.sessionId);
    const expected = original.messages.slice(0, boundary + 1);
    if (contentHash(inherited.messages) !== contentHash(expected)) throw new Error(`Claude fork ${child.sessionId} did not preserve the exact delivery history`);
    const after = await this.session(sdk, origin.sessionId);
    if (contentHash(after.messages.slice(0, boundary + 1)) !== contentHash(expected)) throw new Error("Original Claude conversation changed during the handoff");
    signal.throwIfAborted();
    return child.sessionId;
  }

  async prompt(sessionId: string, text: string, run: ConversationRun): Promise<string> {
    run.signal.throwIfAborted();
    const sdk = await this.load();
    const session = await this.session(sdk, sessionId);
    const lastAssistant = [...session.messages].reverse().find(message => message.type === "assistant");
    const model = (lastAssistant?.message as { model?: string } | undefined)?.model;
    if (!model || model.startsWith("<")) throw new Error("Cannot determine the original Claude model; resume in the native client first");
    const executable = await this.executable();
    const controller = new AbortController();
    const abort = () => controller.abort();
    run.signal.addEventListener("abort", abort, { once: true });
    let mcp: ConversationMcp | undefined; let stream: ReturnType<ClaudeSdk["query"]> | undefined;
    let unsupported: string | null = null;
    try {
      run.signal.throwIfAborted();
      if (run.tools) mcp = await ConversationMcp.start(run.tools, controller.signal);
      run.tools?.setModel(model);
      const config = mcp?.config;
      const serverName = `marginote_artifact_${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
      stream = sdk.query({ prompt: text, options: {
        resume: sessionId, cwd: session.cwd, model, pathToClaudeCodeExecutable: executable,
        abortController: controller,
        ...(config ? { mcpServers: { [serverName]: { type: "http" as const, url: config.url, headers: config.http_headers } } } : {}),
        canUseTool: async (name, input, request) => {
          if (["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"].includes(name)) {
            unsupported = name; return { behavior: "deny", message: "Continue this request in the native Claude Code client", interrupt: true };
          }
          if (request.signal.aborted || controller.signal.aborted) return { behavior: "deny", message: "Conversation cancelled", interrupt: true };
          const accepted = await run.approve({ id: randomUUID(), kind: name === "Bash" ? "command" : ["Edit", "Write", "NotebookEdit"].includes(name) ? "file" : "tool",
            detail: [request.title ?? name, request.description, request.decisionReason, JSON.stringify(input, null, 2)].filter(Boolean).join("\n") });
          if (request.signal.aborted || controller.signal.aborted) return { behavior: "deny", message: "Conversation cancelled", interrupt: true };
          return accepted ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The human declined this operation" };
        },
      } });
      let answer: string | undefined;
      for await (const message of stream) {
        run.signal.throwIfAborted();
        if (message.type === "system" && message.subtype === "init") {
          if (message.session_id !== sessionId) throw new Error("Claude Code resumed a different session");
          if (mcp && (message.mcp_servers?.find(server => server.name === serverName)?.status !== "connected" ||
            run.tools?.definitions.some(tool => !message.tools?.includes(`mcp__${serverName}__${tool.name}`)))) {
            throw new Error("Claude Code did not connect the artifact edit tools; continue in the native client");
          }
        }
        if (message.type === "result") {
          if (message.session_id !== sessionId) throw new Error("Claude Code returned a different session");
          if (unsupported) throw new Error(`Continue in Claude Code: unsupported request ${unsupported}`);
          if (message.subtype !== "success" || message.is_error) throw new Error("Claude Code did not complete the turn successfully");
          answer = message.result;
        }
      }
      if (unsupported) throw new Error(`Continue in Claude Code: unsupported request ${unsupported}`);
      if (!answer?.trim()) throw new Error("Claude Code completed without an answer");
      return answer;
    } finally { run.signal.removeEventListener("abort", abort); controller.abort(); stream?.close(); await mcp?.close(); }
  }
}
