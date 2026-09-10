import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runBounded } from "../src/latex.js";

it("captures direct argv output without a shell", async () => {
  expect(await runBounded(process.execPath, ["-e", "console.log(process.argv[1])", "$(echo unsafe)"], { cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 1024 })).toContain("$(echo unsafe)");
});
it("bounds compiler time and output and reports absence", async () => {
  await expect(runBounded(process.execPath, ["-e", "setInterval(()=>{},100)"], { cwd: process.cwd(), timeoutMs: 50, maxOutputBytes: 1024 })).rejects.toThrow(/timed out/);
  await expect(runBounded(process.execPath, ["-e", "console.log('a'.repeat(4096))"], { cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 100 })).rejects.toThrow(/output limit/);
  await expect(runBounded("/missing/tectonic", [], { cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 1024 })).rejects.toThrow(/not found/);
});
it("kills a compiler that fills the output directory beyond the byte budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marginote-bound-"));
  try {
    const script = `const fs=require("fs");let i=0;setInterval(()=>fs.writeFileSync(process.argv[1]+"/aux"+(i++), Buffer.alloc(1<<20)),5)`;
    await expect(runBounded(process.execPath, ["-e", script, dir], { cwd: dir, timeoutMs: 10_000, maxOutputBytes: 1024, budget: { directory: dir, maxDirectoryBytes: 4 << 20, maxRssBytes: 1 << 30, intervalMs: 20 } })).rejects.toThrow(/generated more than/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("kills a compiler process tree whose resident memory exceeds the budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marginote-bound-"));
  try {
    const script = `const a=[];setInterval(()=>{a.push(Buffer.alloc(32<<20,1))},5)`;
    await expect(runBounded(process.execPath, ["-e", script], { cwd: dir, timeoutMs: 10_000, maxOutputBytes: 1024, budget: { directory: dir, maxDirectoryBytes: Number.MAX_SAFE_INTEGER, maxRssBytes: 128 << 20, intervalMs: 20 } })).rejects.toThrow(/memory/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
