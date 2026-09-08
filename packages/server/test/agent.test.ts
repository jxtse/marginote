import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarginoteServer } from "../src/server.js";

let root: string;
let server: MarginoteServer;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marginote-server-agent-"));
  await writeFile(join(root, "doc.md"), "Document");
  server = await MarginoteServer.start({ root, port: 0, git: false });
});
afterEach(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });
const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}/api/agent/${path}`, init);

describe("agent routes", () => {
  it("roundtrips config, masks keys, reports status and excludes metadata from documents", async () => {
    const response = await request("config", { method: "POST", body: JSON.stringify({ apiKey: "sk-private-12345", model: "model", webSearch: { apiKey: "search-secret" } }) });
    expect(response.status).toBe(200);
    const saved = await response.json() as { apiKey: string };
    expect(saved.apiKey).not.toContain("private");
    const loaded = await request("config"); expect(loaded.headers.get("cache-control")).toBe("no-store");
    expect(await loaded.json()).toEqual(saved);
    expect(await (await request("status")).json()).toEqual({ configured: true, state: "idle", lastError: null });
    expect(server.vault.list()).toEqual(["doc.md"]);
  });
  it("rejects malformed updates, incorrect methods and hostile origins", async () => {
    expect((await request("config", { method: "POST", body: "{bad" })).status).toBe(400);
    expect((await request("config", { method: "DELETE" })).status).toBe(405);
    expect((await request("config", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await request("test", { method: "POST" })).status).toBe(502);
  });
});
