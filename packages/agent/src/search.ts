import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { AgentConfig } from "./config.js";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16]] as const) blocked.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return /^[23][\da-f]{3}:/i.test(address) && !blocked.check(address, "ipv6");
  return false;
}

export async function publicTarget(raw: string, resolver = lookup): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only public HTTP/HTTPS URLs are allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) throw new Error("Private, loopback and link-local destinations are blocked");
  return { url, ...records[0]! };
}

export async function publicRequest(raw: string, options: { signal?: AbortSignal | undefined; body?: string; headers?: Record<string, string> } = {}): Promise<{ text: string; contentType: string }> {
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
  let next = raw;
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    const target = await Promise.race([
      publicTarget(next),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ]);
    signal.throwIfAborted();
    const result = await new Promise<{ text: string; contentType: string; location?: string }>((resolve, reject) => {
      const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(target.url, {
        method: options.body === undefined ? "GET" : "POST", signal,
        headers: { "user-agent": "Marginote/1.0", "accept-encoding": "identity", ...options.headers },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      }, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (options.body !== undefined) return reject(new Error("Search provider redirect refused"));
          resolve({ text: "", contentType: "", location: response.headers.location });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { response.destroy(new Error("Response exceeds 2 MB")); return; }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (status < 200 || status >= 300) { reject(new Error(`Search unavailable (HTTP ${status})`)); return; }
          resolve({ text: Buffer.concat(chunks).toString("utf8"), contentType: response.headers["content-type"] ?? "" });
        });
      });
      request.on("error", reject);
      request.end(options.body);
    });
    if (!result.location) return result;
    next = new URL(result.location, target.url).href;
  }
  throw new Error("Too many redirects");
}

export function readableText(html: string): string {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
      const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
      const code = entity[2]?.toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }).replace(/\s+/g, " ").trim();
}

export interface SearchResult { title: string; url: string; snippet: string }
export function parseDdg(html: string, limit = 8): SearchResult[] {
  if (/anomaly\.js|challenge-form|bots use DuckDuckGo|captcha/i.test(html)) throw new Error("Search unavailable: DuckDuckGo blocked the request");
  const results: SearchResult[] = [];
  const anchors = [...html.matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index]!;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(anchor[1]!)?.[1];
    if (!href) continue;
    try {
      let url = new URL(readableText(href), "https://duckduckgo.com");
      if (url.searchParams.has("uddg")) url = new URL(url.searchParams.get("uddg")!);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      const following = html.slice(anchor.index! + anchor[0].length, anchors[index + 1]?.index ?? html.length);
      const snippet = /<(?:a|div|span)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(following)?.[1] ?? "";
      results.push({ title: readableText(anchor[2]!), url: url.href, snippet: readableText(snippet) });
    } catch { continue; }
    if (results.length >= Math.max(1, Math.min(8, limit))) break;
  }
  if (!results.length && !/No results found|result--no-result/i.test(html)) throw new Error("Search unavailable: unrecognised DuckDuckGo response");
  return results;
}

export async function webSearch(config: AgentConfig["webSearch"], query: string, limit = 5, signal?: AbortSignal): Promise<SearchResult[]> {
  const count = Math.max(1, Math.min(8, limit));
  const provider = config.provider === "auto" ? (config.apiKey ? "tavily" : "ddg") : config.provider;
  if (provider === "ddg") return parseDdg((await publicRequest(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal })).text, count);
  if (!config.apiKey) throw new Error(`Search unavailable: ${provider} requires an API key`);
  const tavily = provider === "tavily";
  const response = await publicRequest(tavily ? "https://api.tavily.com/search" : "https://api.exa.ai/search", {
    signal, headers: { "content-type": "application/json", ...(tavily ? { authorization: `Bearer ${config.apiKey}` } : { "x-api-key": config.apiKey }) },
    body: JSON.stringify(tavily ? { query, max_results: count } : { query, numResults: count, contents: { text: { maxCharacters: 1500 } } }),
  });
  const data = JSON.parse(response.text) as { results?: Array<{ title?: string; url?: string; content?: string; text?: string }> };
  if (!Array.isArray(data.results)) throw new Error("Search unavailable: invalid provider response");
  return data.results.slice(0, count).map(result => ({ title: result.title ?? "", url: result.url ?? "", snippet: (result.content ?? result.text ?? "").slice(0, 1500) }));
}

export async function fetchPage(url: string, signal?: AbortSignal): Promise<string> {
  const response = await publicRequest(url, { signal });
  if (!/^text\/html\b/i.test(response.contentType)) throw new Error("Only text/html pages are allowed");
  return readableText(response.text).slice(0, 40_000);
}
