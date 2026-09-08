import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore, defaultConfig, maskedConfig, mergeConfig, testConnection } from "../src/config.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "marginote-agent-config-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("agent config", () => {
  it("roundtrips, masks both keys and preserves omitted or masked keys", async () => {
    const store = new ConfigStore(root); await store.load();
    const masked = await store.save({ apiKey: "sk-private-abcdef", model: "test", webSearch: { apiKey: "search-private-key" } });
    expect(JSON.stringify(masked)).not.toContain("private");
    await store.save(masked);
    await store.save({ agentName: "Ada" });
    const loaded = new ConfigStore(root); await loaded.load();
    expect(loaded.current.apiKey).toBe("sk-private-abcdef");
    expect(loaded.current.agentName).toBe("Ada");
    expect(loaded.current.webSearch.apiKey).toBe("search-private-key");
    expect((await stat(join(root, ".marginote/agent.json"))).mode & 0o777).toBe(0o600);
    expect(maskedConfig({ ...defaultConfig(), apiKey: "short" }).apiKey).not.toContain("short");
    await loaded.save({ apiKey: "", webSearch: { apiKey: null } });
    expect(loaded.current.apiKey).toBe("");
  });
  it("serializes concurrent updates without losing fields", async () => {
    const store = new ConfigStore(root);
    await Promise.all([store.save({ model: "one" }), store.save({ agentName: "Two" })]);
    expect(store.current).toMatchObject({ model: "one", agentName: "Two" });
  });
  it("refuses invalid config and symlink config directories", async () => {
    expect(() => mergeConfig(defaultConfig(), { baseUrl: "file:///etc" })).toThrow();
    expect(() => mergeConfig(defaultConfig(), { apiKey: 123 })).toThrow();
    expect(() => mergeConfig(defaultConfig(), { webSearch: { provider: "other" } })).toThrow();
    const outside = await mkdtemp(join(tmpdir(), "marginote-outside-"));
    try {
      await symlink(outside, join(root, ".marginote"));
      await expect(new ConfigStore(root).save({ model: "x" })).rejects.toThrow(/symlink/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it("does not follow an agent.json symlink on read or write", async () => {
    const store = new ConfigStore(root); await store.load();
    const target = join(root, "secret"); await writeFile(target, "untouched");
    await symlink(target, join(root, ".marginote/agent.json"));
    await expect(store.load()).rejects.toThrow();
    await store.save({ model: "x" });
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
  it("makes a one-token completion and surfaces provider error verbatim", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(testConnection({ ...defaultConfig(), apiKey: "key", model: "model" })).rejects.toThrow('{"error":{"message":"bad key"}}');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ max_tokens: 1, model: "model", stream: false });
    fetchMock.mockResolvedValue(new Response('{"choices":[{"message":{"content":"Hi"}}]}'));
    await expect(testConnection({ ...defaultConfig(), apiKey: "key", model: "model" })).resolves.toBeUndefined();
  });
});
