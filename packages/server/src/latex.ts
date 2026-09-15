import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { access, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants, type Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, posix } from "node:path";
import type { Vault } from "@marginote/bridge";
import { MediaError, readBoundedFile, readVaultFile, vaultFile } from "./assets.js";
import { resolveTexEntry, texSymbols } from "./latex-project.js";
import { parseSyncTex, type TexLocation } from "./latex-synctex.js";

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

async function snapshotLatexProject(liveRoot: string, snapshotRoot: string | null, entryName: string, signal?: AbortSignal) {
  let files = 0;
  let bytes = 0;
  let visited = 0;
  let entryHash = "";
  const projectHash = createHash("sha256");
  const sources: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  let sourceBytes = 0;
  const copyDirectory = async (relativeDir: string): Promise<void> => {
    if (signal?.aborted) throw new MediaError("Compilation cancelled", 422, "compile_failed");
    const sourceDir = relativeDir ? join(liveRoot, relativeDir) : liveRoot;
    const targetDir = snapshotRoot && (relativeDir ? join(snapshotRoot, relativeDir) : snapshotRoot);
    // Node's readdir reads a directory in one call; bounding here is what keeps a single
    // enormous directory from consuming the whole entry budget before any check runs.
    const entries = (await readdir(sourceDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    // Reserve this directory's entries up front so a deep subtree cannot spend the
    // budget that the remaining entries of its parent still need.
    visited += entries.length;
    if (visited > SNAPSHOT_MAX_ENTRIES) throw new MediaError("LaTeX project directory has too many entries to snapshot", 413, "project_limit");
    if (targetDir) await mkdir(targetDir, { recursive: true });
    for (const entry of entries) {
      if (signal?.aborted) throw new MediaError("Compilation cancelled", 422, "compile_failed");
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
      if (snapshotRoot) await writeFile(join(snapshotRoot, relativePath), data, { flag: "wx" });
      const hash = createHash("sha256").update(data).digest("hex");
      hashes[relativePath] = hash;
      projectHash.update(JSON.stringify([relativePath, hash]));
      if ([".tex", ".bib"].includes(extension)) {
        sourceBytes += data.length;
        if (sourceBytes > 32 * 1024 * 1024) throw new MediaError("TeX sources exceed 32 MiB", 413, "project_limit");
        sources[relativePath] = data.toString("utf8");
      }
      if (relativePath === entryName) entryHash = hash;
    }
  };
  await copyDirectory("");
  if (!entryHash) throw new MediaError("TeX entry disappeared before compilation", 409, "source_changed");
  return { entryPath: join(snapshotRoot ?? liveRoot, entryName), entryHash, projectHash: projectHash.digest("hex"), sources, hashes };
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
  /** Test hook: where the ulimit unit probe writes its 1 KiB file (default os.tmpdir()). */
  probeDirectory?: string;
}

const SCAN_MAX_ENTRIES = 20_000;

/**
 * Total size of regular files under `root`. Stops early once `limit` is exceeded, once
 * the scan itself passes SCAN_MAX_ENTRIES (reported as infinite), or when `stop()` says
 * the caller no longer needs the answer, so a scan can never outlive the job by much.
 */
async function directoryBytes(root: string, limit: number, stop: () => boolean = () => false): Promise<number> {
  let total = 0;
  let visited = 0;
  const pending = [root];
  while (pending.length) {
    if (stop()) return total;
    const directory = pending.pop()!;
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    visited += entries.length;
    if (visited > SCAN_MAX_ENTRIES) return Number.POSITIVE_INFINITY;
    for (const entry of entries) {
      if (stop()) return total;
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
 *
 * `ulimit -f` units differ between shells (512-byte blocks on BSD sh/bash, 1 KiB on
 * some others). The unit is probed once per process (`detectUlimitUnit`) and passed as
 * `$3`; the prologue converts the KiB request accordingly, sets the limit, reads it back
 * and refuses to continue (exit 97) if the kernel did not accept exactly that value.
 */
const RLIMIT_PROLOGUE = [
  'if [ "$3" = "blocks" ]; then want="$(( $1 * 2 ))"; else want="$1"; fi',
  'ulimit -f "$want" || exit 97',
  'got="$(ulimit -f)"; [ "$got" = "$want" ] || exit 97',
  'if [ "$2" != "-" ]; then ulimit -v "$2" || exit 97; fi',
  'shift 3; exec "$@"',
].join("; ");

/**
 * Cached result of detecting whether /bin/sh's `ulimit -f` counts 512-byte blocks.
 * The verdict comes from the kernel, not from a file size: under `ulimit -f 1` a fresh
 * O_EXCL file is written with a single 1024-byte write(2); the kernel returns the number
 * of bytes it allowed (a short write at exactly the limit), and the very next 1-byte
 * write must fail with errno EFBIG. Only the pair (short count, EFBIG) identifies
 * RLIMIT_FSIZE: 1024 -> KiB, 512 -> blocks. Any other count, any other errno
 * (ENOSPC/EIO/EACCES/EEXIST...), or a missing EFBIG on the follow-up write is
 * "unknown", is NOT cached, and callers refuse to start the compiler.
 */
let ulimitUnitProbe: Promise<"blocks" | "kib" | "unknown"> | undefined;
export const ULIMIT_PROBE_NODE = [
  'const fs = require("node:fs");',
  'const path = process.argv[1] + "/marginote-ulimit-probe." + process.pid + "." + Math.random().toString(36).slice(2);',
  "let fd; let written = -1; let verdict = \"unknown\";",
  "try {",
  '  fd = fs.openSync(path, "wx", 0o600);',
  "  try { written = fs.writeSync(fd, Buffer.alloc(1024, 1)); } catch (e) { if (e && e.code === \"EFBIG\") written = 0; else throw e; }",
  "  let second = null; try { fs.writeSync(fd, Buffer.alloc(1)); } catch (e) { second = e && e.code; }",
  '  if (second === "EFBIG" && fs.fstatSync(fd).size === written) verdict = written === 1024 ? "kib" : written === 512 ? "blocks" : "unknown";',
  "} catch {} finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} try { fs.unlinkSync(path); } catch {} }",
  "process.stdout.write(verdict);",
].join("\n");
export const ULIMIT_PROBE = 'ulimit -f 1 || { echo unknown; exit 0; }; exec "$1" -e "$2" "$3"';
function detectUlimitUnit(probeDirectory: string): Promise<"blocks" | "kib" | "unknown"> {
  if (ulimitUnitProbe) return ulimitUnitProbe;
  const attempt = new Promise<"blocks" | "kib" | "unknown">((resolve) => {
    execFile("/bin/sh", ["-c", ULIMIT_PROBE, "probe", process.execPath, ULIMIT_PROBE_NODE, probeDirectory], { timeout: 10_000 }, (error, stdout) => {
      const answer = error ? "unknown" : stdout.trim();
      resolve(answer === "kib" || answer === "blocks" ? answer : "unknown");
    });
  });
  ulimitUnitProbe = attempt.then((unit) => { if (unit === "unknown") ulimitUnitProbe = undefined; return unit; });
  return ulimitUnitProbe;
}
/** Test hook: forget the cached ulimit unit so the next call re-probes. */
export function resetUlimitUnitProbe(): void { ulimitUnitProbe = undefined; }

export function runBounded(command: string, args: string[], options: {
  cwd: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; budget?: ResourceBudget; hardLimits?: HardLimits;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    void (async () => {
    let executable = command;
    let argv = args;
    if (options.hardLimits && process.platform !== "win32") {
      const fileKib = Math.max(1, Math.ceil(options.hardLimits.maxFileBytes / 1024));
      const addressKib = options.hardLimits.maxAddressSpaceBytes && process.platform === "linux" ? String(Math.ceil(options.hardLimits.maxAddressSpaceBytes / 1024)) : "-";
      const unit = await detectUlimitUnit(options.hardLimits.probeDirectory ?? tmpdir());
      if (unit === "unknown") throw new MediaError("Could not determine how to apply OS resource limits; refusing to start the compiler unbounded", 503, "sandbox_unavailable");
      executable = "/bin/sh";
      argv = ["-c", RLIMIT_PROLOGUE, "marginote-rlimit", String(fileKib), addressKib, unit, command, ...args];
    }
    const child = spawn(executable, argv, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure = "";
    let closed = false;
    let terminating = false;
    let reaping: Promise<void> = Promise.resolve();
    // Idempotent: the first caller records the reason and starts exactly one
    // enumerate-then-kill pass; later callers (e.g. every further log chunk after the
    // output cap) only ever observe the flag.
    const kill = (reason: string): void => {
      if (terminating) return;
      terminating = true;
      failure ||= reason;
      const pid = child.pid;
      if (pid && process.platform !== "win32") {
        // Enumerate descendants BEFORE signalling anything: once the parent dies they are
        // reparented to init and the ppid walk can no longer find them. They may also
        // have left our process group or session (bwrap --new-session), so the group
        // kill alone is not enough.
        reaping = descendantPids(pid, options.budget?.psCommand).catch(() => []).then((pids) => {
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
    const budget = options.budget;
    const diskMessage = budget ? `Compiler generated more than ${Math.round(budget.maxDirectoryBytes / 1048576)} MiB of output` : "";
    const memoryMessage = budget ? `Compiler exceeded the ${Math.round(budget.maxRssBytes / 1048576)} MiB memory budget` : "";
    // Two independent sampling loops so a slow directory scan never delays a memory
    // verdict. Each loop reschedules only itself; both stop once the child has closed.
    let memoryTimer: ReturnType<typeof setTimeout> | undefined;
    let diskTimer: ReturnType<typeof setTimeout> | undefined;
    let memoryLoop: Promise<void> = Promise.resolve();
    let diskLoop: Promise<void> = Promise.resolve();
    // A sample that observed an over-budget RSS while the child was alive is a verdict
    // even if the answer arrives after the child exited; it must not be dropped.
    let memoryVerdict = "";
    if (budget && child.pid && process.platform !== "win32") {
      const pid = child.pid;
      const interval = budget.intervalMs ?? 250;
      const memoryTick = async (): Promise<void> => {
        if (closed || terminating) return;
        try {
          const rss = await processTreeRss(pid, budget.psCommand);
          if (rss > budget.maxRssBytes) { memoryVerdict ||= memoryMessage; kill(memoryMessage); return; }
        } catch (error) {
          if (!closed) { const message = `Compiler memory accounting failed (${error instanceof Error ? error.message : String(error)}); refusing to run unbounded`; memoryVerdict ||= message; kill(message); }
          return;
        }
        if (!closed && !terminating) memoryTimer = setTimeout(() => { memoryLoop = memoryTick(); }, interval);
      };
      const diskTick = async (): Promise<void> => {
        if (closed || terminating) return;
        const disk = await directoryBytes(budget.directory, budget.maxDirectoryBytes, () => closed || terminating);
        if (!closed && disk > budget.maxDirectoryBytes) { kill(diskMessage); return; }
        if (!closed && !terminating) diskTimer = setTimeout(() => { diskLoop = diskTick(); }, interval);
      };
      memoryTimer = setTimeout(() => { memoryLoop = memoryTick(); }, interval);
      diskTimer = setTimeout(() => { diskLoop = diskTick(); }, interval);
    }
    const receive = (chunk: Buffer): void => {
      if (terminating) return;
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
      clearTimeout(memoryTimer);
      clearTimeout(diskTimer);
      options.signal?.removeEventListener("abort", abort);
      const finish = async (): Promise<void> => {
        // Wait for in-flight samples first: a late verdict may call kill() and replace
        // `reaping`, so the reaping promise must be read only after both loops settled.
        await Promise.allSettled([memoryLoop, diskLoop]);
        await Promise.allSettled([reaping]);
        const log = Buffer.concat(chunks).toString("utf8");
        if (!failure && memoryVerdict) failure = memoryVerdict;
        if (!failure && code === 97) failure = "Could not apply OS resource limits to the compiler";
        // SIGXFSZ is the kernel enforcing RLIMIT_FSIZE from the prologue: the compiler tried
        // to write a single file past the per-file ceiling. Runtimes that ignore SIGXFSZ
        // (Node does) fail with EFBIG instead. Match only error-line shapes emitted by
        // runtimes/libc ("Error: EFBIG: ...", "code: 'EFBIG'", "errno ... EFBIG",
        // "<path>: File too large"), never a bare word in prose, and keep the exit code
        // so the attribution is visibly a probable cause.
        const perFile = `${Math.round((options.hardLimits?.maxFileBytes ?? 0) / 1048576)} MiB per-file limit`;
        if (!failure && signal === "SIGXFSZ") failure = `Compiler tried to write a file larger than the ${perFile}`;
        const efbigLine = /^(?:\s*(?:\w*Error|error|errno):?\s*EFBIG\b.*|\s*code:\s*['"]EFBIG['"].*|.*\S: File too large\s*)$/m;
        if (!failure && options.hardLimits && code !== 0 && efbigLine.test(log)) failure = `Tectonic failed (exit ${code}); the log reports EFBIG, most likely the ${perFile}`;
        if (!failure && signal) failure = `Compiler terminated by ${signal}`;
        // A burst that finished between samples must still be rejected.
        if (!failure && code === 0 && budget && (await directoryBytes(budget.directory, budget.maxDirectoryBytes)) > budget.maxDirectoryBytes) failure = diskMessage;
        if (failure || code !== 0) reject(new MediaError(failure || `Tectonic failed (exit ${code}); check compiler log`, 422, "compile_failed", log));
        else resolve(log);
      };
      void finish();
    });
    })().catch((error) => reject(error instanceof MediaError ? error : new MediaError(error instanceof Error ? error.message : String(error), 422, "compile_failed")));
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
  try { await processTreeRss(process.pid); }
  catch { throw new MediaError("Process accounting is unavailable; refusing to start a compiler that cannot be monitored", 503, "sandbox_unavailable"); }
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

interface RenderedLatex { pdf: Buffer; hash: string; projectHash: string; id: string }
export class LatexRenderer {
  private readonly active = new Map<string, { task: Promise<RenderedLatex>; waiters: number; controller: AbortController }>();
  private readonly maps = new Map<string, { entry: string; projectHash: string; hashes: Record<string, string>; locations: TexLocation[]; created: number }>();
  private readonly abort = new AbortController();
  private inspection: { key: string; task: ReturnType<LatexRenderer["inspectProject"]> } | undefined;
  constructor(private readonly vault: Vault, private readonly compiler: LatexCompiler = tectonicCompiler) {}

  project(doc: string, preferred?: string) {
    const key = JSON.stringify([doc, preferred]);
    if (this.inspection) {
      if (this.inspection.key === key) return this.inspection.task;
      return Promise.reject(new MediaError("Another project is being inspected; retry shortly", 429, "project_busy"));
    }
    const task = this.inspectProject(doc, preferred).finally(() => { if (this.inspection?.task === task) this.inspection = undefined; });
    this.inspection = { key, task };
    return task;
  }

  private async inspectProject(doc: string, preferred?: string) {
    await vaultFile(this.vault.root, doc, [".tex"]);
    await this.vault.flush();
    const resolved = await resolveTexEntry(this.vault, doc, preferred);
    if (!resolved.entry) return { doc, entry: null, candidates: resolved.candidates, source: "", revision: "", docHash: createHash("sha256").update(resolved.sources.get(doc)!).digest("hex"), hashes: {}, labels: [], citations: [] };
    const entryPath = await vaultFile(this.vault.root, resolved.entry, [".tex"]);
    const snapshot = await snapshotLatexProject(dirname(entryPath), null, basename(entryPath));
    return {
      doc, entry: resolved.entry, candidates: [...new Set([...resolved.candidates, resolved.entry])],
      source: snapshot.sources[basename(entryPath)], revision: snapshot.projectHash,
      docHash: createHash("sha256").update(resolved.sources.get(doc)!).digest("hex"),
      hashes: Object.fromEntries(Object.entries(snapshot.hashes).filter(([file]) => /\.tex$/i.test(file)).map(([file, hash]) => [posix.join(posix.dirname(resolved.entry!), file), hash])),
      ...texSymbols(snapshot.sources),
    };
  }

  mapping(id: string) {
    const map = this.maps.get(id);
    if (!map || Date.now() - map.created > 30 * 60_000) {
      this.maps.delete(id);
      throw new MediaError("PDF navigation expired; recompile the document", 404, "preview_expired");
    }
    return map;
  }

  /** Real offline probe, sharing the compile slot and shutdown/cancellation lifecycle. */
  async check(signal?: AbortSignal): Promise<{ ok: true }> {
    await this.execute("__runtime_check__", async (signal) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "marginote-tex-check-")));
      try {
        const outputDir = join(root, "output");
        await mkdir(outputDir);
        const entryPath = join(root, "check.tex");
        await writeFile(entryPath, "\\documentclass{article}\n\\begin{document}\n\\section{Environment check}\nText, \\textbf{bold}, \\textit{italic}, and $E=mc^2$.\n\\end{document}\n");
        await this.compiler({ root, entryPath, outputDir, signal });
        const pdf = await readBoundedFile(join(outputDir, "check.pdf"));
        if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new MediaError("The environment check did not produce a PDF", 422, "compile_failed");
        return { pdf, hash: "", projectHash: "", id: "" };
      } finally { await rm(root, { recursive: true, force: true }); }
    }, signal);
    return { ok: true };
  }

  /**
   * Compile `path`. Concurrent requests for the same entry share one compilation; when
   * every requester's `signal` aborts (browser navigated away, socket closed) the
   * compiler is killed so an orphaned 120 s job cannot hold the single slot hostage.
   */
  async render(path: string, signal?: AbortSignal): Promise<RenderedLatex> {
    const entryPath = await vaultFile(this.vault.root, path, [".tex"]);
    return this.execute(path, (signal) => this.compile(path, entryPath, signal), signal);
  }

  private async execute(path: string, compile: (signal: AbortSignal) => Promise<RenderedLatex>, signal?: AbortSignal): Promise<RenderedLatex> {
    if (this.abort.signal.aborted) throw new MediaError("Server is closing", 503, "closing");
    if (signal?.aborted) throw new MediaError("Client disconnected", 499, "client_closed");
    let entry = this.active.get(path);
    if (!entry) {
      if (this.active.size >= 1) throw new MediaError("Another document is compiling; retry shortly", 429, "compile_busy");
      const controller = new AbortController();
      const forward = (): void => controller.abort();
      this.abort.signal.addEventListener("abort", forward, { once: true });
      const task = compile(controller.signal).finally(() => {
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

  private async compile(path: string, entryPath: string, signal: AbortSignal): Promise<RenderedLatex> {
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
      let locations: TexLocation[] = [];
      try {
        const compressed = await readBoundedFile(join(outputDir, `${basename(path).replace(/\.tex$/i, "")}.synctex.gz`), 8 * 1024 * 1024);
        const decoded = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }).toString("utf8");
        locations = parseSyncTex(decoded, snapshotRoot, posix.dirname(path), new Set(Object.keys(snapshot.hashes)));
      } catch { /* Navigation is optional; invalid or oversized maps never invalidate a PDF. */ }
      const id = randomUUID();
      const hashes = Object.fromEntries(Object.entries(snapshot.hashes).filter(([file]) => /\.tex$/i.test(file)).map(([file, hash]) => [posix.join(posix.dirname(path), file), hash]));
      this.maps.set(id, { entry: path, projectHash: snapshot.projectHash, hashes, locations, created: Date.now() });
      while (this.maps.size > 4) this.maps.delete(this.maps.keys().next().value!);
      return { pdf, hash: snapshot.entryHash, projectHash: snapshot.projectHash, id };
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
    await this.inspection?.task.catch(() => {});
    this.maps.clear();
  }
}
