import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: { code?: number; message: string } };
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Small stdio JSON-RPC client. No shell interpolation or global agent configuration. */
export class NativeRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(message: Message) => void>();
  private sequence = 0;
  private buffer = "";
  private ended: Error | null = null;
  requestHandler: (message: Message) => Promise<unknown> = async () => { throw new Error("Unsupported agent request"); };
  constructor(command: string, args: string[], cwd: string, private readonly signal: AbortSignal, private readonly label = "Codex") {
    signal.throwIfAborted();
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) return this.close(new Error(`${this.label} response exceeded 32 MiB`));
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.close(new Error(`Invalid JSON from ${this.label} native runtime`)); return; }
      }
    });
    // Drain stderr without leaking native session contents into HTTP errors.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.close(new Error(`${this.label} input closed`)));
    this.child.on("error", error => this.close(new Error(`Unable to start ${this.label}: ${error.message}`)));
    this.child.on("exit", code => this.close(new Error(`${this.label} native runtime exited (${code ?? "signal"})`)));
    signal.addEventListener("abort", this.abort, { once: true });
  }
  private readonly abort = (): void => this.close(new Error(`${this.label} conversation cancelled`));
  private send(message: Message): void {
    if (this.ended) throw this.ended;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private receive(message: Message): void {
    if (message.method && message.id !== undefined) {
      void this.requestHandler(message).then(
        result => { if (!this.ended) this.send({ id: message.id!, result }); },
        error => { if (!this.ended) this.send({ id: message.id!, error: { code: -32601, message: error instanceof Error ? error.message : "Unsupported request" } }); },
      );
    } else if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id)); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    } else for (const listener of this.listeners) listener(message);
  }
  request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.ended) return Promise.reject(this.ended);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.label} ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  subscribe(listener: (message: Message) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "marginote", version: "0.2.0" }, capabilities: null });
    this.send({ method: "initialized" });
  }
  close(error = new Error(`${this.label} connection closed`)): void {
    if (this.ended) return;
    this.ended = error;
    this.signal.removeEventListener("abort", this.abort);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "marginote/disconnected", params: { error } });
    this.listeners.clear();
    this.child.stdin.destroy();
    const pid = this.child.pid;
    if (pid) {
      try { if (process.platform === "win32") this.child.kill(); else process.kill(-pid, "SIGTERM"); } catch { /* already exited */ }
      const timer = setTimeout(() => {
        try { if (process.platform === "win32") this.child.kill("SIGKILL"); else process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
      }, 1500);
      timer.unref();
      this.child.once("close", () => clearTimeout(timer));
    }
  }
}
