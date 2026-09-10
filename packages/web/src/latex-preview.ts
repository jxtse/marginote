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

export type LatexState = { status: "waiting" | "compiling" } | { status: "ready"; url: string } | { status: "error"; error: string };

export class LatexPreview {
  /** 650 ms + 1.3 s + 2.6 s + 5 s × 27 ≈ 140 s, just past the server's 120 s compile timeout. */
  static readonly BUSY_RETRIES = 30;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  private url: string | undefined;
  private key: string | undefined;
  constructor(private readonly show: (state: LatexState) => void, private readonly fetcher: typeof fetch = fetch) {}

  reset(): void {
    this.version++;
    clearTimeout(this.timer);
    this.abort?.abort();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    this.key = undefined;
  }

  clear(): void {
    this.reset();
    this.show({ status: "waiting" });
  }

  schedule(path: string, source: string, retry = 0, delay = 650): void {
    const key = `${path}\0${source}`;
    if (this.key === key && retry === 0) return;
    this.reset();
    this.key = key;
    const version = this.version;
    this.show({ status: "waiting" });
    this.timer = setTimeout(() => { void this.compile(path, source, version, retry); }, delay);
  }

  private async compile(path: string, source: string, version: number, retry: number): Promise<void> {
    this.abort = new AbortController();
    this.show({ status: "compiling" });
    try {
      const response = await this.fetcher.call(globalThis, `/api/latex?doc=${encodeURIComponent(path)}`, { method: "POST", signal: this.abort.signal, cache: "no-store" });
      if (version !== this.version) return;
      if (response.status === 429) {
        // The server runs one compilation at a time and a real paper can take most of
        // its 120 s budget, so waiting for the slot is normal, not a failure. Back off
        // geometrically to 5 s and give up only once the server's own limit has passed.
        if (retry >= LatexPreview.BUSY_RETRIES) throw new Error("The compiler stayed busy for over two minutes. Retry when it is free.");
        this.schedule(path, source, retry + 1, Math.min(5_000, 650 * 2 ** Math.min(retry, 3)));
        return;
      }
      if (response.status === 409 || (response.ok && response.headers.get("x-source-hash") !== await sourceHash(source))) {
        if (version !== this.version) return;
        if (retry >= 8) throw new Error("Preview could not catch up. Wait for sync, then retry.");
        this.schedule(path, source, retry + 1);
        return;
      }
      if (!response.ok) {
        const result = await response.json() as { error?: string; log?: string };
        throw new Error([result.error ?? `Compilation failed (${response.status})`, result.log].filter(Boolean).join("\n"));
      }
      const blob = await response.blob();
      if (version !== this.version) return;
      this.url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      this.show({ status: "ready", url: this.url });
    } catch (error) {
      if (version !== this.version) return;
      this.key = undefined;
      this.show({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
}
