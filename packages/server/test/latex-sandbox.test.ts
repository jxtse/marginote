import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { latexRuntimePaths, tectonicCompiler } from "../src/latex.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => { vi.unstubAllEnvs(); spawn.mockReset(); });

it("fails closed when Tectonic is absent", async () => {
  vi.stubEnv("PATH", "");
  await expect(tectonicCompiler({ root: "/vault", entryPath: "/vault/main.tex", outputDir: "/tmp/out", signal: new AbortController().signal })).rejects.toMatchObject({ status: 503, code: "runtime_missing" });
  expect(spawn).not.toHaveBeenCalled();
});

it("invokes an OS sandbox with offline untrusted argv and a bounded runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marginote-fake-compiler-"));
  try {
    await writeFile(join(directory, "tectonic"), "fake", { mode: 0o700 });
    await writeFile(join(directory, "bwrap"), "fake", { mode: 0o700 });
    const tectonicPath = await realpath(join(directory, "tectonic"));
    vi.stubEnv("PATH", directory);
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => { child.stdout.end("ok"); child.emit("close", 0); });
      return child;
    });
    const input = { root: "/vault", entryPath: "/vault/paper/main.tex", outputDir: "/tmp/out", signal: new AbortController().signal };
    if (!["darwin", "linux"].includes(process.platform)) {
      await expect(tectonicCompiler(input)).rejects.toMatchObject({ code: "sandbox_unavailable" });
      return;
    }
    expect(await tectonicCompiler(input)).toBe("ok");
    const [shell, spawned, options] = spawn.mock.calls[0]!;
    // rlimit prologue: constant script text, then positional limits, then the real argv.
    expect(shell).toBe("/bin/sh");
    expect(spawned[0]).toBe("-c");
    expect(spawned[1]).toMatch(/^ulimit -f "\$1"/);
    expect(spawned[1]).not.toContain("/vault");
    expect(spawned[2]).toBe("marginote-rlimit");
    expect(spawned[3]).toBe(String(128 * 1024));
    expect(spawned[4]).toBe(process.platform === "linux" ? String(4 * 1024 * 1024) : "-");
    const [command, ...args] = spawned.slice(5) as string[];
    expect(args).toEqual(expect.arrayContaining(["--untrusted", "--only-cached", "--synctex", "--keep-logs", "--outdir", "/tmp/out", "/vault/paper/main.tex"]));
    expect(options).toMatchObject({ shell: false, cwd: "/vault/paper", stdio: ["ignore", "pipe", "pipe"] });
    expect(options.env).not.toHaveProperty("TECTONIC_UNTRUSTED_MODE");
    if (process.platform === "darwin") {
      expect(command).toBe("/usr/bin/sandbox-exec");
      expect(args[1]).toContain("(deny default)");
      expect(args[1]).not.toContain("(allow network");
      expect(args[1]).not.toContain("(allow file-read*)");
      expect(args[1]).toContain('(literal "/")');
      expect(args[1]).toContain('(subpath "/vault")');
      expect(args[1]).not.toContain('(subpath "/opt")');
      expect(args[1]).not.toContain('(subpath "/usr")');
      expect(args[1]).not.toContain('(subpath "/Library")');
      expect(args[1]).not.toContain('(subpath "/Applications")');
      expect(args[1]).toContain(`(literal "${tectonicPath}")`);
      expect(args[1]).toContain('(allow file-write* (subpath "/tmp/out"))');
    } else {
      expect(command).toMatch(/bwrap$/);
      expect(args).toContain("--unshare-all");
      expect(args).toContain("--ro-bind");
      const binds = args.filter((_: string, index: number) => args[index - 1] === "--ro-bind");
      expect(binds).not.toContain("/usr");
      expect(binds).not.toContain("/opt");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("reports a missing sandbox-exec as an unavailable runtime, not a compile failure", async () => {
  if (process.platform !== "darwin") return;
  const directory = await mkdtemp(join(tmpdir(), "marginote-fake-compiler-"));
  try {
    await writeFile(join(directory, "tectonic"), "fake", { mode: 0o700 });
    vi.stubEnv("PATH", directory);
    const original = latexRuntimePaths.sandboxExec;
    latexRuntimePaths.sandboxExec = join(directory, "missing-sandbox-exec");
    try {
      await expect(tectonicCompiler({ root: "/vault", entryPath: "/vault/main.tex", outputDir: "/tmp/out", signal: new AbortController().signal })).rejects.toMatchObject({ status: 503, code: "sandbox_unavailable" });
      expect(spawn).not.toHaveBeenCalled();
    } finally { latexRuntimePaths.sandboxExec = original; }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
