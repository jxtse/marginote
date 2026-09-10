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
