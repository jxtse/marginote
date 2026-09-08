import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, RequestOptions } from "node:http";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

import { fetchPage, publicRequest, webSearch } from "../src/search.js";

const responses: Array<{ status: number; headers: Record<string, string>; body: string }> = [];
const calls: Array<{ url: URL; options: RequestOptions; body?: string }> = [];
beforeEach(() => {
  responses.length = 0; calls.length = 0;
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  vi.mocked(request).mockImplementation(((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const outgoing = new EventEmitter();
    Object.assign(outgoing, { end(body?: string) {
      calls.push({ url, options, ...(body !== undefined ? { body } : {}) });
      queueMicrotask(() => {
        const entry = responses.shift()!;
        const incoming = new PassThrough();
        Object.assign(incoming, { statusCode: entry.status, headers: entry.headers });
        callback(incoming as unknown as IncomingMessage);
        incoming.end(entry.body);
      });
    } });
    return outgoing;
  }) as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe("bounded web requests", () => {
  it("pins DNS lookup to the checked address and keeps the original hostname", async () => {
    responses.push({ status: 200, headers: { "content-type": "text/html" }, body: "<p>Hello</p>" });
    expect(await fetchPage("https://example.com/page")).toBe("Hello");
    expect(calls[0]!.url.hostname).toBe("example.com");
    const callback = vi.fn();
    calls[0]!.options.lookup!("example.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("validates redirects before connecting and refuses private destinations", async () => {
    responses.push({ status: 302, headers: { location: "http://127.0.0.1:4321/api/agent/config" }, body: "" });
    await expect(fetchPage("https://example.com/redirect")).rejects.toThrow(/blocked/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("caps bytes, requires HTML, strips scripts and limits readable output", async () => {
    responses.push({ status: 200, headers: { "content-type": "text/html" }, body: "x".repeat(2 * 1024 * 1024 + 1) });
    await expect(fetchPage("https://example.com/large")).rejects.toThrow(/2 MB/);
    responses.push({ status: 200, headers: { "content-type": "application/json" }, body: "{}" });
    await expect(fetchPage("https://example.com/json")).rejects.toThrow(/text\/html/);
    responses.push({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: `<script>secret</script><p>${"x".repeat(50000)}</p>` });
    expect(await fetchPage("https://example.com/text")).toHaveLength(40000);
  });
  it("reports HTTP blocks and honors caller cancellation", async () => {
    responses.push({ status: 403, headers: {}, body: "blocked" });
    await expect(publicRequest("https://example.com")).rejects.toThrow(/unavailable.*403/);
    const controller = new AbortController(); controller.abort(new Error("Canceled"));
    await expect(publicRequest("https://example.com", { signal: controller.signal })).rejects.toThrow("Canceled");
  });
  it("uses the configured key provider, caps results and never forwards credentials on redirects", async () => {
    const body = JSON.stringify({ results: [{ title: "Result", url: "https://example.com", content: "Summary", text: "Exa text" }] });
    responses.push({ status: 200, headers: {}, body });
    expect(await webSearch({ provider: "auto", apiKey: "tavily-key" }, "query", 99)).toEqual([{ title: "Result", url: "https://example.com", snippet: "Summary" }]);
    expect(calls[0]!.url.href).toBe("https://api.tavily.com/search");
    expect(calls[0]!.options.headers).toMatchObject({ authorization: "Bearer tavily-key" });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ max_results: 8 });
    responses.push({ status: 200, headers: {}, body });
    await webSearch({ provider: "exa", apiKey: "exa-key" }, "query", 2);
    expect(calls[1]!.options.headers).toMatchObject({ "x-api-key": "exa-key" });
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ numResults: 2, contents: { text: { maxCharacters: 1500 } } });
    responses.push({ status: 302, headers: { location: "https://evil.example" }, body: "" });
    await expect(webSearch({ provider: "tavily", apiKey: "key" }, "query")).rejects.toThrow(/redirect refused/);
    expect(calls).toHaveLength(3);
    await expect(webSearch({ provider: "exa", apiKey: null }, "query")).rejects.toThrow(/requires an API key/);
  });
});
