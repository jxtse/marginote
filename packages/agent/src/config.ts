import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface AgentConfig {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  agentName: string;
  webSearch: { provider: "auto" | "ddg" | "tavily" | "exa"; apiKey: string | null };
}

export const defaultConfig = (): AgentConfig => ({
  provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "",
  model: "", agentName: "Margin", webSearch: { provider: "auto", apiKey: null },
});

export const maskKey = (key: string | null): string | null => key ? `••••…${key.length > 8 ? key.slice(-3) : ""}` : key;

export function maskedConfig(config: AgentConfig): AgentConfig {
  return { ...config, apiKey: maskKey(config.apiKey) ?? "", webSearch: { ...config.webSearch, apiKey: maskKey(config.webSearch.apiKey) } };
}

export function mergeConfig(current: AgentConfig, input: unknown): AgentConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a config object");
  const patch = input as Record<string, unknown>;
  const next = { ...current, webSearch: { ...current.webSearch } };
  for (const field of ["baseUrl", "apiKey", "model", "agentName"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 4096) throw new Error(`Invalid ${field}`);
    if (field === "apiKey" && value === maskKey(current.apiKey)) continue;
    next[field] = field === "apiKey" ? value : value.trim();
  }
  if (patch.provider !== undefined && patch.provider !== "openai-compatible") throw new Error("Unsupported provider");
  const url = new URL(next.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Base URL");
  if (!next.agentName || next.agentName.length > 80) throw new Error("Agent name must be 1–80 characters");
  if (patch.webSearch !== undefined) {
    if (!patch.webSearch || typeof patch.webSearch !== "object" || Array.isArray(patch.webSearch)) throw new Error("Invalid webSearch");
    const search = patch.webSearch as Record<string, unknown>;
    if (search.provider !== undefined) {
      if (!["auto", "ddg", "tavily", "exa"].includes(String(search.provider))) throw new Error("Invalid search provider");
      next.webSearch.provider = search.provider as AgentConfig["webSearch"]["provider"];
    }
    if (search.apiKey !== undefined && search.apiKey !== maskKey(current.webSearch.apiKey)) {
      if (search.apiKey !== null && (typeof search.apiKey !== "string" || search.apiKey.length > 4096)) throw new Error("Invalid search key");
      next.webSearch.apiKey = search.apiKey as string | null;
    }
  }
  return next;
}

export class ConfigStore {
  private value = defaultConfig();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}
  get current(): AgentConfig { return structuredClone(this.value); }
  private async directory(): Promise<string> {
    const root = await realpath(this.root);
    const directory = join(root, ".marginote");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new Error("Agent config directory must not be a symlink");
    return directory;
  }
  async load(): Promise<void> {
    try {
      const file = await open(join(await this.directory(), "agent.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await file.stat()).size > 32_768) throw new Error("Agent config too large");
        this.value = mergeConfig(defaultConfig(), JSON.parse(await file.readFile("utf8")));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  save(input: unknown): Promise<AgentConfig> {
    const operation = this.writes.then(async () => {
      const next = mergeConfig(this.value, input);
      const directory = await this.directory();
      const temporary = join(directory, `agent-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(`${JSON.stringify(next, null, 2)}\n`); } finally { await file.close(); }
        await rename(temporary, join(directory, "agent.json"));
        this.value = next;
        return maskedConfig(next);
      } finally { await rm(temporary, { force: true }); }
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}

export async function testConnection(config: AgentConfig): Promise<void> {
  if (!config.apiKey || !config.model) throw new Error("Set an API key and model first");
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1, stream: false }),
    signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  if (!response.ok) throw new Error(await response.text() || `Provider returned ${response.status}`);
  const result = await response.json() as { choices?: unknown[]; error?: unknown };
  if (result.error || !result.choices?.length) throw new Error(JSON.stringify(result.error ?? result));
}
