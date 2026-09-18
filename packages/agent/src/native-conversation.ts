import { CodexConversationProvider } from "./codex-conversation.js";
import { ClaudeConversationProvider } from "./claude-conversation.js";
import { HermesConversationProvider } from "./hermes-conversation.js";
import type { ConversationOrigin, ConversationProvider, ConversationRun, ConversationSnapshot } from "./conversation-provider.js";

/** Routing is persisted with the artifact; no cross-provider fallback. */
export class NativeConversationProvider implements ConversationProvider {
  private readonly providers: Record<ConversationOrigin["provider"], ConversationProvider>;
  constructor(cwd: string) { this.providers = { codex: new CodexConversationProvider(cwd), "claude-code": new ClaudeConversationProvider(), hermes: new HermesConversationProvider(cwd) }; }
  fork(origin: ConversationOrigin, signal: AbortSignal): Promise<string | ConversationSnapshot> { return this.providers[origin.provider].fork(origin, signal); }
  prompt(session: string, text: string, run: ConversationRun): Promise<string> {
    if (!run.origin) throw new Error("The originating provider is required to resume this conversation");
    return this.providers[run.origin.provider].prompt(session, text, run);
  }
}
