import { digest as sha256 } from "lib0/hash/sha256";

/**
 * SHA-256 of the editor text, matched against the server's `x-source-hash`.
 * `crypto.subtle` only exists in secure contexts; with `--host 0.0.0.0` over plain HTTP
 * it is undefined, so fall back to lib0's pure-JS implementation (already a dependency).
 */
export async function sourceHash(source: string): Promise<string> {
  const encoded = new TextEncoder().encode(source);
  const bytes = globalThis.crypto?.subtle ? new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)) : sha256(encoded);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export interface TexLocation { file: string; line: number; page: number; x: number; y: number; width: number; height: number }
export interface TexDiagnostic { file: string; line: number; message: string }
export interface TexMapping { entry: string; projectHash: string; hashes: Record<string, string>; locations: TexLocation[] }
export type LatexState = { status: "waiting" | "compiling"; url?: string } | { status: "ready"; url: string; mapping?: TexMapping } | { status: "error"; error: string; url?: string; diagnostics?: TexDiagnostic[] };

export class LatexPreview {
  /** 650 ms + 1.3 s + 2.6 s + 5 s × 27 ≈ 140 s, just past the server's 120 s compile timeout. */
  static readonly BUSY_RETRIES = 30;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  private url: string | undefined;
  private key: string | undefined;
  private path: string | undefined;
  private revision: string | undefined;
  constructor(private readonly show: (state: LatexState) => void, private readonly fetcher: typeof fetch = fetch) {}

  reset(): void {
    this.version++;
    clearTimeout(this.timer);
    this.abort?.abort();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    this.key = undefined;
    this.path = undefined;
  }

  clear(): void {
    this.reset();
    this.show({ status: "waiting" });
  }

  invalidate(): void {
    this.version++; clearTimeout(this.timer); this.abort?.abort(); this.key = undefined;
    this.show({ status: "waiting", ...(this.url ? { url: this.url } : {}) });
  }

  schedule(path: string, source: string, retry = 0, delay = 650, revision?: string): void {
    const key = `${path}\0${source}\0${revision ?? ""}`;
    if (this.key === key && retry === 0) return;
    if (this.path !== path) this.reset();
    else { this.version++; clearTimeout(this.timer); this.abort?.abort(); }
    this.path = path;
    this.revision = revision;
    this.key = key;
    const version = this.version;
    this.show({ status: "waiting", ...(this.url ? { url: this.url } : {}) });
    this.timer = setTimeout(() => { void this.compile(path, source, version, retry); }, delay);
  }

  private async compile(path: string, source: string, version: number, retry: number): Promise<void> {
    this.abort = new AbortController();
    this.show({ status: "compiling", ...(this.url ? { url: this.url } : {}) });
    try {
      const response = await this.fetcher.call(globalThis, `/api/latex?doc=${encodeURIComponent(path)}`, { method: "POST", signal: this.abort.signal, cache: "no-store" });
      if (version !== this.version) return;
      if (response.status === 429) {
        // The server runs one compilation at a time and a real paper can take most of
        // its 120 s budget, so waiting for the slot is normal, not a failure. Back off
        // geometrically to 5 s and give up only once the server's own limit has passed.
        if (retry >= LatexPreview.BUSY_RETRIES) throw new Error("The compiler stayed busy for over two minutes. Retry when it is free.");
        this.schedule(path, source, retry + 1, Math.min(5_000, 650 * 2 ** Math.min(retry, 3)), this.revision);
        return;
      }
      if (response.status === 409 || (response.ok && (response.headers.get("x-source-hash") !== await sourceHash(source) || (this.revision && response.headers.get("x-project-hash") !== this.revision)))) {
        if (version !== this.version) return;
        if (retry >= 8) throw new Error("Preview could not catch up. Wait for sync, then retry.");
        this.schedule(path, source, retry + 1, 650, this.revision);
        return;
      }
      if (!response.ok) {
        const result = await response.json() as { error?: string; log?: string; diagnostics?: TexDiagnostic[] };
        if (version !== this.version) return;
        this.key = undefined;
        this.show({ status: "error", error: [result.error ?? `Compilation failed (${response.status})`, result.log].filter(Boolean).join("\n"), ...(this.url ? { url: this.url } : {}), ...(result.diagnostics?.length ? { diagnostics: result.diagnostics } : {}) });
        return;
      }
      const blob = await response.blob();
      let mapping: TexMapping | undefined;
      const id = response.headers.get("x-compile-id");
      if (id) {
        try {
          const result = await this.fetcher.call(globalThis, `/api/latex/mapping?id=${encodeURIComponent(id)}`, { signal: this.abort.signal });
          if (result.ok) mapping = await result.json();
        } catch { /* The PDF remains usable if navigation metadata expired. */ }
      }
      if (version !== this.version) return;
      const old = this.url;
      this.url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      this.show({ status: "ready", url: this.url, ...(mapping ? { mapping } : {}) });
      if (old) URL.revokeObjectURL(old);
    } catch (error) {
      if (version !== this.version) return;
      this.key = undefined;
      this.show({ status: "error", error: error instanceof Error ? error.message : String(error), ...(this.url ? { url: this.url } : {}) });
    }
  }
}
