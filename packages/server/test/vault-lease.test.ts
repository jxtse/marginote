import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VaultLease } from "../src/vault-lease.js";
import { MarginoteServer } from "../src/server.js";
import { CommentStore } from "@marginote/bridge";

let root: string;
const leases: VaultLease[] = [];
const servers: MarginoteServer[] = [];
let child: ChildProcess | undefined;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "marginote-lease-"))); });
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  child = undefined;
  for (const server of servers.splice(0)) await server.close();
  for (const lease of leases.splice(0)) await lease.release();
  await rm(root, { recursive: true, force: true });
});
const acquire = async (path = root) => { const lease = await VaultLease.acquire(path); leases.push(lease); return lease; };

it("excludes concurrent owners and aliases, and releases exactly once", async () => {
  const first = await acquire();
  const alias = join(root, "alias"); await symlink(root, alias);
  await expect(acquire(alias)).rejects.toThrow(/already owns/);
  await Promise.all([first.release(), first.release()]);
  const next = await acquire();
  expect(next.root).toBe(root);
  await first.release();
  await expect(acquire()).rejects.toThrow(/already owns/);
});

it("excludes another process and recovers an expired crash lease", async () => {
  const script = join(root, "holder.cjs");
  const lockPath = createRequire(import.meta.url).resolve("proper-lockfile");
  await mkdir(join(root, ".marginote"));
  await writeFile(script, `const { lock } = require(${JSON.stringify(lockPath)});
lock(process.argv[2], { lockfilePath: process.argv[2] + '/.marginote/runtime.lock', stale: 120000, update: 5000, retries: 0 })
.then(() => process.send('ready')).catch(error => { process.send(error.message); process.exit(1); });
setInterval(() => {}, 1000);`);
  child = fork(script, [root], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
  expect((await once(child, "message"))[0]).toBe("ready");
  await expect(acquire()).rejects.toThrow(/already owns/);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  await expect(acquire()).rejects.toThrow(/already owns/);
  const old = new Date(Date.now() - 130_000);
  await utimes(join(root, ".marginote/runtime.lock"), old, old);
  await acquire();
});

it("refuses symlinked runtime metadata", async () => {
  await mkdir(join(root, "other"));
  await symlink(join(root, "other"), join(root, ".marginote"));
  await expect(acquire()).rejects.toThrow(/symlink/);
});

it("fails a duplicate server before loading routing and permits restart after close", async () => {
  const server = await MarginoteServer.start({ root, port: 0, git: false }); servers.push(server);
  await writeFile(join(root, ".marginote/conversations.json"), "invalid");
  await expect(MarginoteServer.start({ root, port: 0, git: false })).rejects.toThrow(/already owns/);
  expect(await readFile(join(root, ".marginote/conversations.json"), "utf8")).toBe("invalid");
  await server.close();
  await expect(MarginoteServer.start({ root, port: 0, git: false })).rejects.toThrow();
  // A failed startup must release the lease too.
  await rm(join(root, ".marginote/conversations.json"));
  servers.push(await MarginoteServer.start({ root, port: 0, git: false }));
});

it("stops serving when its ownership is compromised", async () => {
  await writeFile(join(root, "report.md"), "A report");
  let activeSignal: AbortSignal | undefined;
  const server = await MarginoteServer.start({ root, port: 0, git: false, conversationProvider: {
    fork: async () => "child",
    prompt: async (_id, _text, { signal }) => new Promise((_resolve, reject) => {
      activeSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
    }),
  } }); servers.push(server);
  const url = `http://127.0.0.1:${server.port}/api/files`;
  expect((await fetch(url)).status).toBe(200);
  const bound = await fetch(`http://127.0.0.1:${server.port}/api/agent/conversation`, { method: "POST", body: JSON.stringify({ doc: "report.md", origin: { provider: "codex", sessionId: "parent", turnId: "delivery" } }) });
  expect(bound.status).toBe(201);
  const handle = server.vault.getDoc("report.md");
  new CommentStore(handle.doc).add({ text: handle.text, from: 0, to: 1, body: "Explain", authorId: "human", authorName: "Human" });
  await vi.waitFor(() => expect(activeSignal).toBeDefined());
  await rm(join(root, ".marginote/runtime.lock"), { recursive: true });
  await vi.waitFor(async () => { await expect(fetch(url)).rejects.toThrow(); }, { timeout: 8_000, interval: 100 });
  expect(activeSignal!.aborted).toBe(true);
  await server.close();
  expect(JSON.parse(await readFile(join(root, ".marginote/conversations.json"), "utf8")).bindings[0].error).toMatch(/stopped|timed out/i);
  await acquire();
});
