import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ULIMIT_PROBE_NODE, runBounded, processTreeRss, resetUlimitUnitProbe } from "../src/latex.js";

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

it("refuses to start the compiler when the ulimit unit cannot be determined, and recovers once it can", () => withDir(async (dir) => {
  // Probe with an unwritable directory: no positive identification -> fail closed, and
  // the failure must not be cached.
  const { mkdir, chmod } = await import("node:fs/promises");
  const locked = join(dir, "locked");
  await mkdir(locked);
  await chmod(locked, 0o500);
  resetUlimitUnitProbe();
  try {
    await expect(runBounded(process.execPath, ["-e", "console.log('ran')"], { ...base, cwd: dir, hardLimits: { maxFileBytes: 1 << 20, probeDirectory: locked } })).rejects.toThrow(/resource limits/);
    expect(await runBounded(process.execPath, ["-e", "console.log('ran')"], { ...base, cwd: dir, hardLimits: { maxFileBytes: 1 << 20, probeDirectory: dir } })).toContain("ran");
  } finally { await chmod(locked, 0o700); resetUlimitUnitProbe(); }
}));

it("waits for a late memory verdict's termination work before settling", () => withDir(async (dir) => {
  const { writeFile, chmod } = await import("node:fs/promises");
  const pidFile = join(dir, "child.pid");
  const marker = join(dir, "ps-done");
  const slowPs = join(dir, "ps");
  // First call (RSS sample) is slow and over budget; second call (descendant enumeration
  // for the kill) records a marker so the test can assert it finished before settlement.
  await writeFile(slowPs, `#!/bin/sh\nif [ "$1" = "-eo" ] && [ "$2" = "pid=,ppid=,rss=" ]; then sleep 0.3; p="$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo 1)"; echo "$p 1 999999999"; else sleep 0.2; touch ${JSON.stringify(marker)}; fi\n`);
  await chmod(slowPs, 0o755);
  const script = `require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(()=>{},150)`;
  await expect(runBounded(process.execPath, ["-e", script, pidFile], { ...base, cwd: dir, budget: { directory: dir, maxDirectoryBytes: 1 << 30, maxRssBytes: 64 << 20, intervalMs: 10, psCommand: slowPs } })).rejects.toThrow(/memory/);
  const { access } = await import("node:fs/promises");
  await expect(access(marker)).resolves.toBeUndefined();
}));

it("processTreeRss sums descendants found through the ppid chain", async () => {
  const rss = await processTreeRss(process.pid, "ps");
  expect(rss).toBeGreaterThan(1 << 20);
  await expect(processTreeRss(process.pid, "/nonexistent/ps")).rejects.toThrow();
});

it("does not attribute an unrelated failure to the per-file limit because prose mentions EFBIG", () => withDir(async (dir) => {
  const script = `console.log("This paragraph discusses EFBIG behavior and says File too large in passing"); process.exit(3)`;
  await expect(runBounded(process.execPath, ["-e", script], { ...base, cwd: dir, hardLimits: { maxFileBytes: 1 << 20 } })).rejects.toThrow(/exit 3\); check compiler log$/);
  const real = `console.error("Error: EFBIG: file too large, write"); process.exit(1)`;
  await expect(runBounded(process.execPath, ["-e", real], { ...base, cwd: dir, hardLimits: { maxFileBytes: 1 << 20 } })).rejects.toThrow(/most likely the 1 MiB per-file limit/);
}));

it("ulimit unit probe reports unknown unless the kernel itself signals RLIMIT_FSIZE", () => withDir(async (dir) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFile, chmod, readdir } = await import("node:fs/promises");
  const run = promisify(execFile);
  const probe = (limit: string, directory: string) => run("/bin/sh", ["-c", `ulimit -f ${limit} || { echo unknown; exit 0; }; exec "$1" -e "$2" "$3"`, "probe", process.execPath, ULIMIT_PROBE_NODE, directory]).then((r) => r.stdout.trim());
  // Kernel fingerprint present: definite answer, and the probe file is removed.
  expect(["kib", "blocks"]).toContain(await probe("1", dir));
  // Limit large enough on EITHER unit (3 KiB or 3 blocks = 1536 B) that the follow-up write
  // does not hit EFBIG: no fingerprint -> unknown, even though 1024 bytes were written.
  expect(await probe("3", dir)).toBe("unknown");
  // Unlimited: same.
  expect(await probe("unlimited", dir)).toBe("unknown");
  // Reviewer counterexample: a pre-existing read-only 512-byte file at every plausible
  // name cannot be arranged (the name is randomised), but O_EXCL means any pre-existing
  // file is EEXIST -> unknown rather than a size read from stale content. Simulate the
  // class by making the directory unwritable: open fails -> unknown.
  const locked = join(dir, "locked");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(locked);
  await writeFile(join(locked, "decoy"), Buffer.alloc(512));
  await chmod(locked, 0o500);
  try { expect(await probe("1", locked)).toBe("unknown"); } finally { await chmod(locked, 0o700); }
  expect((await readdir(dir)).filter((name) => name.startsWith("marginote-ulimit-probe."))).toEqual([]);
}));

it("terminates idempotently: a flood of over-limit log chunks spawns at most one ps enumeration", () => withDir(async (dir) => {
  // Emit many small chunks well past the log cap, each of which used to call kill() and
  // therefore start another `ps`. Count ps invocations through a counting wrapper.
  const { writeFile, chmod } = await import("node:fs/promises");
  const counter = join(dir, "ps-count");
  const wrapper = join(dir, "ps");
  await writeFile(wrapper, `#!/bin/sh\necho x >> ${JSON.stringify(counter)}\nexec /bin/ps "$@"\n`);
  await chmod(wrapper, 0o755);
  const script = `let i=0;const t=setInterval(()=>{process.stdout.write("y".repeat(200)+"\\n");if(++i>400)clearInterval(t)},1)`;
  await expect(runBounded(process.execPath, ["-e", script], { ...base, cwd: dir, maxOutputBytes: 512, budget: { directory: dir, maxDirectoryBytes: 1 << 30, maxRssBytes: 1 << 30, intervalMs: 60_000, psCommand: wrapper } })).rejects.toThrow(/output limit/);
  const { readFile } = await import("node:fs/promises");
  const invocations = (await readFile(counter, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  expect(invocations).toBeLessThanOrEqual(1);
}));

it("rejects a compiler whose memory sample came back over budget only after it exited", () => withDir(async (dir) => {
  // ps is delayed so its over-limit answer lands after the child has already closed. The
  // fake ps reports a huge RSS for the pid recorded by the child itself.
  const { writeFile, chmod } = await import("node:fs/promises");
  const pidFile = join(dir, "child.pid");
  const slowPs = join(dir, "ps");
  await writeFile(slowPs, `#!/bin/sh\nsleep 0.3\np="$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo 1)"\necho "$p 1 999999999"\n`);
  await chmod(slowPs, 0o755);
  const script = `require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(()=>{},150)`;
  await expect(runBounded(process.execPath, ["-e", script, pidFile], { ...base, cwd: dir, budget: { directory: dir, maxDirectoryBytes: 1 << 30, maxRssBytes: 64 << 20, intervalMs: 10, psCommand: slowPs } })).rejects.toThrow(/memory/);
}));

it("keeps sampling memory on schedule while a directory scan is slow", () => withDir(async (dir) => {
  // 12,000 empty files make each scan take noticeably longer than the 10 ms interval;
  // the allocator must still be killed by the memory check within a few intervals.
  const { writeFile } = await import("node:fs/promises");
  await Promise.all(Array.from({ length: 12_000 }, (_, i) => writeFile(join(dir, `f${i}`), "")));
  const script = `const a=[];setInterval(()=>{a.push(Buffer.alloc(32<<20,1))},5)`;
  const started = Date.now();
  await expect(runBounded(process.execPath, ["-e", script], { ...base, cwd: dir, budget: { directory: dir, maxDirectoryBytes: 1 << 30, maxRssBytes: 128 << 20, intervalMs: 10 } })).rejects.toThrow(/memory/);
  expect(Date.now() - started).toBeLessThan(3_000);
}));

it("applies the exact per-file limit regardless of the shell's ulimit unit", () => withDir(async (dir) => {
  // Write a file just under the limit (must succeed) and one just over (must be cut).
  const under = `require("fs").writeFileSync(process.argv[1]+"/under", Buffer.alloc((1<<20)-4096)); console.log("ok")`;
  expect(await runBounded(process.execPath, ["-e", under, dir], { ...base, cwd: dir, hardLimits: { maxFileBytes: 1 << 20 } })).toContain("ok");
  const over = `require("fs").writeFileSync(process.argv[1]+"/over", Buffer.alloc((1<<20)+4096))`;
  await expect(runBounded(process.execPath, ["-e", over, dir], { ...base, cwd: dir, hardLimits: { maxFileBytes: 1 << 20 } })).rejects.toThrow(/per-file limit/);
  const { stat } = await import("node:fs/promises");
  // The kernel stops the write exactly at RLIMIT_FSIZE.
  expect((await stat(join(dir, "over"))).size).toBe(1 << 20);
}));
