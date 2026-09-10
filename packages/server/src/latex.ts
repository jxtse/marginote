import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants, type Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";
import type { Vault } from "@marginote/bridge";
import { MediaError, readBoundedFile, readVaultFile, vaultFile } from "./assets.js";

export interface CompileInput {
  root: string;
  entryPath: string;
  outputDir: string;
  signal: AbortSignal;
}
export type LatexCompiler = (input: CompileInput) => Promise<string>;

const SNAPSHOT_EXTENSIONS = new Set([
  ".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx", ".lbx", ".cfg", ".def", ".clo", ".fd",
  ".tikz", ".pgf", ".csv", ".tsv", ".dat", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".eps",
]);
const SNAPSHOT_MAX_FILES = 5_000;
const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_MAX_ENTRIES = 50_000;

async function snapshotLatexProject(liveRoot: string, snapshotRoot: string, entryName: string, signal?: AbortSignal): Promise<{ entryPath: string; entryHash: string }> {
  let files = 0;
  let bytes = 0;
  let visited = 0;
  let entryHash = "";
  const copyDirectory = async (relativeDir: string): Promise<void> => {
    if (signal?.aborted) throw new MediaError("Compilation cancelled", 422, "compile_failed");
    const sourceDir = relativeDir ? join(liveRoot, relativeDir) : liveRoot;
    const targetDir = relativeDir ? join(snapshotRoot, relativeDir) : snapshotRoot;
    // Node's readdir reads a directory in one call; bounding here is what keeps a single
    // enormous directory from consuming the whole entry budget before any check runs.
    const entries = await readdir(sourceDir, { withFileTypes: true });
    if (visited + entries.length > SNAPSHOT_MAX_ENTRIES) throw new MediaError("LaTeX project directory has too many entries to snapshot", 413, "project_limit");
    await mkdir(targetDir, { recursive: true });
    for (const entry of entries) {
      if (signal?.aborted) throw new MediaError("Compilation cancelled", 422, "compile_failed");
      // Every directory entry counts, not only copied files, so a tree of unsupported or
      // empty directories cannot turn the snapshot walk into an unbounded scan.
      visited++;
      if ([".git", ".marginote", "node_modules"].includes(entry.name)) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new MediaError(`LaTeX snapshot does not follow symlink: ${relativePath}`, 400, "invalid_path");
      if (entry.isDirectory()) { await copyDirectory(relativePath); continue; }
      const extension = extname(entry.name).toLowerCase();
      if (!entry.isFile() || !SNAPSHOT_EXTENSIONS.has(extension)) continue;
      const data = await readVaultFile(liveRoot, relativePath, [extension]);
      files++;
      bytes += data.length;
      if (files > SNAPSHOT_MAX_FILES || bytes > SNAPSHOT_MAX_BYTES) {
        throw new MediaError("LaTeX project snapshot exceeds 5,000 files or 256 MiB", 413, "project_limit");
      }
      await writeFile(join(snapshotRoot, relativePath), data, { flag: "wx" });
      if (relativePath === entryName) entryHash = createHash("sha256").update(data).digest("hex");
    }
  };
  await copyDirectory("");
  if (!entryHash) throw new MediaError("TeX entry disappeared before compilation", 409, "source_changed");
  return { entryPath: join(snapshotRoot, entryName), entryHash };
}

/**
 * Per-compilation resource budget. Two layers:
 *
 * 1. `hardLimits` are applied by the OS before the compiler starts (RLIMIT_FSIZE, and
 *    RLIMIT_AS on Linux) through a constant `/bin/sh` prologue that receives every
 *    value positionally, so there is no string interpolation and no injection surface.
 *    macOS ignores RLIMIT_AS/RSS, which is why the poller below exists.
 * 2. A poller samples the output directory (bounded scan, early exit past the limit)
 *    and the resident memory of the whole descendant tree (ppid walk over `ps -eo`,
 *    independent of pgid/sid so `bwrap --new-session` children are still counted)
 *    every `intervalMs`. Either limit kills the process group. If accounting itself
 *    fails while the compiler is alive the job is killed rather than left unbounded.
 *    Disk is re-checked once after exit so a burst that finished between samples is
 *    still rejected.
 */
export interface ResourceBudget {
  directory: string;
  maxDirectoryBytes: number;
  maxRssBytes: number;
  intervalMs?: number;
  /** Test hook: alternative `ps` binary, e.g. a missing path to simulate accounting failure. */
  psCommand?: string;
}
export interface HardLimits {
  /** RLIMIT_FSIZE in bytes: any single file the compiler writes is truncated here. */
  maxFileBytes: number;
  /** RLIMIT_AS in bytes; enforced by the kernel on Linux only, ignored on macOS. */
  maxAddressSpaceBytes?: number;
}

const SCAN_MAX_ENTRIES = 20_000;

/** Total size of regular files under `root`, stopping early once `limit` is exceeded or the scan itself grows too large. */
async function directoryBytes(root: string, limit: number): Promise<number> {
  let total = 0;
  let visited = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > SCAN_MAX_ENTRIES) return Number.POSITIVE_INFINITY;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { total += (await lstat(path)).size; } catch {}
        if (total > limit) return total;
      }
    }
  }
  return total;
}

/**
 * Resident memory (bytes) of `rootPid` and every descendant reachable through ppid.
 * Rejects when `ps` cannot be run or returns nothing usable; callers must treat that
 * as a failure while the compiler is alive, never as "0 bytes".
 */
export function processTreeRss(rootPid: number, psCommand = "ps"): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(psCommand, ["-eo", "pid=,ppid=,rss="], { timeout: 2_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error(`process accounting unavailable: ${error.message}`)); return; }
      const children = new Map<number, number[]>();
      const rss = new Map<number, number>();
      for (const line of stdout.split("\n")) {
        const [pid, ppid, kib] = line.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
        if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(kib)) continue;
        rss.set(pid!, kib! * 1024);
        const siblings = children.get(ppid!) ?? [];
        siblings.push(pid!);
        children.set(ppid!, siblings);
      }
      if (rss.size === 0) { reject(new Error("process accounting returned no processes")); return; }
      let total = 0;
      const pending = [rootPid];
      const seen = new Set<number>();
      while (pending.length) {
        const pid = pending.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        total += rss.get(pid) ?? 0;
        for (const child of children.get(pid) ?? []) pending.push(child);
      }
      resolve(total);
    });
  });
}

/** All descendant pids of `rootPid` via the ppid chain; empty when accounting is unavailable. */
function descendantPids(rootPid: number, psCommand = "ps"): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(psCommand, ["-eo", "pid=,ppid="], { timeout: 2_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      const children = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
        const siblings = children.get(ppid!) ?? [];
        siblings.push(pid!);
        children.set(ppid!, siblings);
      }
      const found: number[] = [];
      const pending = [rootPid];
      const seen = new Set<number>([rootPid]);
      while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!seen.has(child)) { seen.add(child); found.push(child); pending.push(child); }
      resolve(found);
    });
  });
}

/**
 * Constant shell prologue that applies rlimits then execs the real command. The script
 * text never changes; limits and the command arrive as positional parameters, so this
 * is not a shell-injection surface. `ulimit -v` is a no-op on macOS but harmless.
 */
const RLIMIT_PROLOGUE = 'ulimit -f "$1" || exit 97; if [ "$2" != "-" ]; then ulimit -v "$2" || exit 97; fi; shift 2; exec "$@"';

export function runBounded(command: string, args: string[], options: {
  cwd: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; budget?: ResourceBudget; hardLimits?: HardLimits;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let executable = command;
    let argv = args;
    if (options.hardLimits && process.platform !== "win32") {
      // ulimit -f counts 512-byte blocks on BSD/macOS sh and KiB on some Linux shells;
      // KiB is the larger unit, so use it and accept a ≤2× slack on BSD rather than risk
      // a cap smaller than a legitimate PDF.
      const fileKib = Math.max(1, Math.ceil(options.hardLimits.maxFileBytes / 1024));
      const addressKib = options.hardLimits.maxAddressSpaceBytes && process.platform === "linux" ? String(Math.ceil(options.hardLimits.maxAddressSpaceBytes / 1024)) : "-";
      executable = "/bin/sh";
      argv = ["-c", RLIMIT_PROLOGUE, "marginote-rlimit", String(fileKib), addressKib, command, ...args];
    }
    const child = spawn(executable, argv, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure = "";
    let closed = false;
    let reaping: Promise<void> = Promise.resolve();
    const kill = (reason: string): void => {
      failure ||= reason;
      const pid = child.pid;
      if (pid && process.platform !== "win32") {
        // Enumerate descendants BEFORE signalling anything: once the parent dies they are
        // reparented to init and the ppid walk can no longer find them. They may also
        // have left our process group or session (bwrap --new-session), so the group
        // kill alone is not enough.
        reaping = descendantPids(pid, options.budget?.psCommand).then((pids) => {
          for (const descendant of pids) { try { process.kill(descendant, "SIGKILL"); } catch {} }
          try { process.kill(-pid, "SIGKILL"); } catch {}
          try { child.kill("SIGKILL"); } catch {}
        });
      } else { try { child.kill("SIGKILL"); } catch {} }
    };
    const timer = setTimeout(() => kill("Tectonic timed out"), options.timeoutMs);
    const abort = (): void => kill("Compilation cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let sampling: Promise<void> = Promise.resolve();
    const budget = options.budget;
    const diskMessage = budget ? `Compiler generated more than ${Math.round(budget.maxDirectoryBytes / 1048576)} MiB of output` : "";
    if (budget && child.pid && process.platform !== "win32") {
      const pid = child.pid;
      const interval = budget.intervalMs ?? 250;
      // Memory and disk are checked independently so a slow directory scan can never
      // delay killing a process that is already over its memory budget.
      const checkMemory = async (): Promise<void> => {
        let rss: number;
        try { rss = await processTreeRss(pid, budget.psCommand); }
        catch (error) { if (!closed) kill(`Compiler memory accounting failed (${error instanceof Error ? error.message : String(error)}); refusing to run unbounded`); return; }
        if (!closed && rss > budget.maxRssBytes) kill(`Compiler exceeded the ${Math.round(budget.maxRssBytes / 1048576)} MiB memory budget`);
      };
      const checkDisk = async (): Promise<void> => {
        const disk = await directoryBytes(budget.directory, budget.maxDirectoryBytes);
        if (!closed && disk > budget.maxDirectoryBytes) kill(diskMessage);
      };
      const sample = async (): Promise<void> => {
        if (closed || failure) return;
        sampling = Promise.allSettled([checkMemory(), checkDisk()]).then(() => {});
        await sampling;
        if (!closed && !failure) watchdog = setTimeout(() => { void sample(); }, interval);
      };
      watchdog = setTimeout(() => { void sample(); }, interval);
    }
    const receive = (chunk: Buffer): void => {
      const remaining = Math.max(0, options.maxOutputBytes - bytes);
      chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) kill("Compiler output limit exceeded");
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.on("error", (error: NodeJS.ErrnoException) => { failure = error.code === "ENOENT" ? "Tectonic or sandbox executable not found; install the required runtime" : error.message; });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      options.signal?.removeEventListener("abort", abort);
      const finish = async (): Promise<void> => {
        await Promise.allSettled([sampling, reaping]);
        const log = Buffer.concat(chunks).toString("utf8");
        if (!failure && code === 97) failure = "Could not apply OS resource limits to the compiler";
        // SIGXFSZ is the kernel enforcing RLIMIT_FSIZE from the prologue: the compiler tried
        // to write a single file past the per-file ceiling.
        if (!failure && signal === "SIGXFSZ") failure = `Compiler tried to write a file larger than the ${Math.round((options.hardLimits?.maxFileBytes ?? 0) / 1048576)} MiB per-file limit`;
        if (!failure && signal) failure = `Compiler terminated by ${signal}`;
        // A burst that finished between samples must still be rejected.
        if (!failure && code === 0 && budget && (await directoryBytes(budget.directory, budget.maxDirectoryBytes)) > budget.maxDirectoryBytes) failure = diskMessage;
        if (failure || code !== 0) reject(new MediaError(failure || `Tectonic failed (exit ${code}); check compiler log`, 422, "compile_failed", log));
        else resolve(log);
      };
      void finish();
    });
  });
}

async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new MediaError(`${name} not found on PATH; install it to enable secure LaTeX preview`, 503, "runtime_missing");
}

/** Fixed sandbox binary; overridable only by tests via `latexRuntimePaths` to simulate absence. */
export const latexRuntimePaths = { sandboxExec: "/usr/bin/sandbox-exec" };

export const tectonicCompiler: LatexCompiler = async ({ root, entryPath, outputDir, signal }) => {
  const tectonic = await executable("tectonic");
  const cache = process.platform === "darwin"
    ? join(homedir(), "Library/Caches/TectonicProject.Tectonic")
    : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "Tectonic");
  const args = ["--untrusted", "--only-cached", "--synctex", "--keep-logs", "--print", "--outdir", outputDir, entryPath];
  const env = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: outputDir, XDG_CACHE_HOME: dirname(cache) };
  let command: string;
  let sandboxArgs: string[];
  if (process.platform === "darwin") {
    command = latexRuntimePaths.sandboxExec;
    try { await access(command, constants.X_OK); }
    catch { throw new MediaError("macOS sandbox-exec is unavailable; secure LaTeX preview is disabled", 503, "sandbox_unavailable"); }
    const quote = (path: string): string => JSON.stringify(path);
    // Allow only the selected vault, compiler cache, output directory, and immutable
    // system/runtime trees. The literal root access is needed for Tectonic's startup
    // directory probe; it does not grant recursive access outside these subpaths.
    const subtreeCandidates = [
      root, outputDir, cache, "/System", "/usr/lib", "/usr/share", "/Library/Fonts", "/Library/Frameworks",
      join(homedir(), "Library/Fonts"), "/opt/homebrew/etc/fonts", "/opt/homebrew/share/fonts",
      "/opt/homebrew/var/cache/fontconfig", "/opt/homebrew/opt/icu4c@78/lib", "/opt/homebrew/opt/harfbuzz/lib",
      "/opt/homebrew/opt/freetype/lib", "/opt/homebrew/opt/graphite2/lib", "/opt/homebrew/opt/libpng/lib",
      "/opt/homebrew/opt/glib/lib", "/opt/homebrew/opt/gettext/lib", "/opt/homebrew/opt/pcre2/lib",
      "/private/etc/fonts", "/private/var/db/timezone", "/dev",
    ];
    const subtrees = await Promise.all(subtreeCandidates.map(async (path) => {
      try { return await realpath(path); } catch { return path; }
    }));
    const profile = [
      "(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)",
      "(allow mach-lookup)", "(allow file-read-metadata)",
      `(allow file-read* (literal "/") (literal ${quote(tectonic)}) ${subtrees.map((path) => `(subpath ${quote(path)})`).join(" ")})`,
      `(allow file-write* (subpath ${quote(outputDir)}))`,
      `(deny file-read* ${[".git", ".marginote", "node_modules"].map((name) => `(subpath ${quote(join(root, name))})`).join(" ")})`,
    ].join("");
    sandboxArgs = ["-p", profile, tectonic, ...args];
  } else if (process.platform === "linux") {
    command = await executable("bwrap");
    sandboxArgs = ["--die-with-parent", "--unshare-all", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
    for (const path of ["/usr/lib", "/usr/lib64", "/usr/share/fonts", "/lib", "/lib64", "/etc/fonts", "/etc/ld.so.cache", cache]) {
      try { await access(path); sandboxArgs.push("--ro-bind", path, path); } catch {}
    }
    sandboxArgs.push("--ro-bind", root, root, "--bind", outputDir, outputDir, "--ro-bind", tectonic, tectonic);
    for (const name of [".git", ".marginote", "node_modules"]) {
      try { await access(join(root, name)); sandboxArgs.push("--tmpfs", join(root, name)); } catch {}
    }
    sandboxArgs.push("--chdir", dirname(entryPath), "--", tectonic, ...args);
  } else throw new MediaError("Secure LaTeX preview requires macOS sandbox-exec or Linux bubblewrap", 503, "sandbox_unavailable");
  return runBounded(command, sandboxArgs, {
    cwd: dirname(entryPath), timeoutMs: 120_000, maxOutputBytes: 256 * 1024, signal, env,
    // TMPDIR is pointed at outputDir and the sandbox only permits writes there, so its
    // size is the compiler's total generated data. 2 GiB RSS is generous for XeTeX on a
    // real paper (tens of MiB) while still stopping a runaway allocation loop.
    budget: { directory: outputDir, maxDirectoryBytes: 512 * 1024 * 1024, maxRssBytes: 2 * 1024 * 1024 * 1024 },
    // Kernel-enforced ceilings that hold even between poller samples: no single file
    // beyond the 64 MiB PDF limit (with headroom), and on Linux a 4 GiB address space.
    hardLimits: { maxFileBytes: 128 * 1024 * 1024, maxAddressSpaceBytes: 4 * 1024 * 1024 * 1024 },
  });
};

export class LatexRenderer {
  private readonly active = new Map<string, { task: Promise<{ pdf: Buffer; hash: string }>; waiters: number; controller: AbortController }>();
  private readonly abort = new AbortController();
  constructor(private readonly vault: Vault, private readonly compiler: LatexCompiler = tectonicCompiler) {}

  /**
   * Compile `path`. Concurrent requests for the same entry share one compilation; when
   * every requester's `signal` aborts (browser navigated away, socket closed) the
   * compiler is killed so an orphaned 120 s job cannot hold the single slot hostage.
   */
  async render(path: string, signal?: AbortSignal): Promise<{ pdf: Buffer; hash: string }> {
    const entryPath = await vaultFile(this.vault.root, path, [".tex"]);
    if (this.abort.signal.aborted) throw new MediaError("Server is closing", 503, "closing");
    if (signal?.aborted) throw new MediaError("Client disconnected", 499, "client_closed");
    let entry = this.active.get(path);
    if (!entry) {
      if (this.active.size >= 1) throw new MediaError("Another document is compiling; retry shortly", 429, "compile_busy");
      const controller = new AbortController();
      const forward = (): void => controller.abort();
      this.abort.signal.addEventListener("abort", forward, { once: true });
      const task = this.compile(path, entryPath, controller.signal).finally(() => {
        this.abort.signal.removeEventListener("abort", forward);
        if (this.active.get(path) === entry) this.active.delete(path);
      });
      entry = { task, waiters: 0, controller };
      this.active.set(path, entry);
    }
    const current = entry;
    current.waiters++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (--current.waiters <= 0) current.controller.abort();
    };
    signal?.addEventListener("abort", release, { once: true });
    try { return await current.task; } finally {
      signal?.removeEventListener("abort", release);
      if (!released) { released = true; current.waiters--; }
    }
  }

  private async compile(path: string, entryPath: string, signal: AbortSignal): Promise<{ pdf: Buffer; hash: string }> {
    let temporaryRoot: string | undefined;
    try {
      await this.vault.flush();
      temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "marginote-latex-")));
      const snapshotRoot = join(temporaryRoot, "source");
      const outputDir = join(temporaryRoot, "output");
      await mkdir(outputDir);
      const liveProjectRoot = await realpath(dirname(entryPath));
      const snapshot = await snapshotLatexProject(liveProjectRoot, snapshotRoot, basename(entryPath), signal);
      if (signal.aborted) throw new MediaError("Compilation cancelled", 422, "compile_failed");
      const log = await this.compiler({ root: snapshotRoot, entryPath: snapshot.entryPath, outputDir, signal });
      let pdf: Buffer;
      try { pdf = await readBoundedFile(join(outputDir, `${basename(path).replace(/\.tex$/i, "")}.pdf`)); }
      catch { throw new MediaError("Tectonic did not produce a readable fresh PDF", 422, "compile_failed", log); }
      if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new MediaError("Compiler output is not a PDF", 422, "compile_failed", log);
      return { pdf, hash: snapshot.entryHash };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError(error instanceof Error ? error.message : "Compilation failed", 422, "compile_failed");
    } finally { if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }); }
  }

  async close(): Promise<void> {
    this.abort.abort();
    // Wait for the compile promises themselves, not the bookkeeping wrappers, so that
    // temporary snapshot/output directories are removed before the process exits.
    await Promise.allSettled([...this.active.values()].map((entry) => entry.task));
  }
}
