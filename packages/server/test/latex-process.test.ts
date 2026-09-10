import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runBounded, processTreeRss } from "../src/latex.js";

const base = { timeoutMs: 10_000, maxOutputBytes: 1024 };

it("captures direct argv output without a shell", async () => {
  expect(await runBounded(process.execPath, ["-e", "console.log(process.argv[1])", "$(echo unsafe)"], { cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 1024 })).toContain("$(echo unsafe)");
});
it("bounds compiler time and output and reports absence", async () => {
  await expect(runBounded(process.execPath, ["-e", "setInterval(()=>{},100)"], { cwd: process.cwd(), timeoutMs: 50, maxOutputBytes: 1024 })).rejects.toThrow(/timed out/);
  await expect(runBounded(process.execPath, ["-e", "console.log('a'.repeat(4096))"], { cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 100 })).rejects.toThrow(/output limit/);
  await expect(runBounded("/missing/tectonic", [], { cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 1024 })).rejects.toThrow(/not found/);
});

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "marginote-bound-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

it("kills a compiler that fills the output directory beyond the byte budget", () => withDir(async (dir) => {
  const script = `const fs=require("fs");let i=0;setInterval(()=>fs.writeFileSync(process.argv[1]+"/aux"+(i++), Buffer.alloc(1<<20)),5)`;
  await expect(runBounded(process.execPath, ["-e", script, dir], { ...base, cwd: dir, budget: { directory: dir, maxDirectoryBytes: 4 << 20, maxRssBytes: 1 << 30, intervalMs: 20 } })).rejects.toThrow(/generated more than/);
}));

it("kills a compiler process tree whose resident memory exceeds the budget, including grandchildren", () => withDir(async (dir) => {
  // Parent stays tiny; a detached grandchild in a new session does the allocating, so
  // only a ppid-walk (not pgid/sid selection) can attribute the memory to this job.
  const grandchild = `const a=[];setInterval(()=>{a.push(Buffer.alloc(32<<20,1))},5)`;
  const parent = `const {spawn}=require("child_process");spawn(process.execPath,["-e",process.argv[1]],{detached:true,stdio:"ignore"});setInterval(()=>{},1000)`;
  await expect(runBounded(process.execPath, ["-e", parent, grandchild], { ...base, cwd: dir, budget: { directory: dir, maxDirectoryBytes: Number.MAX_SAFE_INTEGER, maxRssBytes: 128 << 20, intervalMs: 20 } })).rejects.toThrow(/memory/);
  // The grandchild must be dead too, not orphaned in its own session.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { execFileSync } = await import("node:child_process");
  const survivors = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes("Buffer.alloc(32<<20,1)"));
  expect(survivors).toEqual([]);
}));

it("fails closed when process accounting is unavailable while the compiler is alive", () => withDir(async (dir) => {
  await expect(runBounded(process.execPath, ["-e", "setInterval(()=>{},100)"], { ...base, cwd: dir, budget: { directory: dir, maxDirectoryBytes: 1 << 30, maxRssBytes: 1 << 30, intervalMs: 20, psCommand: "/nonexistent/ps" } })).rejects.toThrow(/accounting/);
}));

it("rejects a compiler that exceeded the output budget before the first sample could observe it", () => withDir(async (dir) => {
  // Burst: write 6 MiB and exit immediately, faster than any sampling interval.
  const script = `require("fs").writeFileSync(process.argv[1]+"/burst", Buffer.alloc(6<<20))`;
  await expect(runBounded(process.execPath, ["-e", script, dir], { ...base, cwd: dir, budget: { directory: dir, maxDirectoryBytes: 4 << 20, maxRssBytes: 1 << 30, intervalMs: 60_000 } })).rejects.toThrow(/generated more than/);
}));

it("enforces a per-file size hard limit through the OS before the compiler starts", () => withDir(async (dir) => {
  const script = `require("fs").writeFileSync(process.argv[1]+"/big", Buffer.alloc(5<<20)); console.log("wrote")`;
  await expect(runBounded(process.execPath, ["-e", script, dir], { ...base, cwd: dir, hardLimits: { maxFileBytes: 1 << 20 } })).rejects.toThrow();
  const { stat } = await import("node:fs/promises");
  const size = await stat(join(dir, "big")).then((info) => info.size).catch(() => 0);
  expect(size).toBeLessThanOrEqual(2 << 20);
}));

it("processTreeRss sums descendants found through the ppid chain", async () => {
  const rss = await processTreeRss(process.pid, "ps");
  expect(rss).toBeGreaterThan(1 << 20);
  await expect(processTreeRss(process.pid, "/nonexistent/ps")).rejects.toThrow();
});
