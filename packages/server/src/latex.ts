import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
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

async function snapshotLatexProject(liveRoot: string, snapshotRoot: string, entryName: string): Promise<{ entryPath: string; entryHash: string }> {
  let files = 0;
  let bytes = 0;
  let entryHash = "";
  const copyDirectory = async (relativeDir: string): Promise<void> => {
    const sourceDir = relativeDir ? join(liveRoot, relativeDir) : liveRoot;
    const targetDir = relativeDir ? join(snapshotRoot, relativeDir) : snapshotRoot;
    await mkdir(targetDir, { recursive: true });
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
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

export function runBounded(command: string, args: string[], options: {
  cwd: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure = "";
    const kill = (reason: string): void => {
      failure ||= reason;
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => kill("Tectonic timed out"), options.timeoutMs);
    const abort = (): void => kill("Compilation cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const receive = (chunk: Buffer): void => {
      const remaining = Math.max(0, options.maxOutputBytes - bytes);
      chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) kill("Compiler output limit exceeded");
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.on("error", (error: NodeJS.ErrnoException) => { failure = error.code === "ENOENT" ? "Tectonic or sandbox executable not found; install the required runtime" : error.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const log = Buffer.concat(chunks).toString("utf8");
      if (failure || code !== 0) reject(new MediaError(failure || `Tectonic failed (exit ${code}); check compiler log`, 422, "compile_failed", log));
      else resolve(log);
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
    command = "/usr/bin/sandbox-exec";
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
  return runBounded(command, sandboxArgs, { cwd: dirname(entryPath), timeoutMs: 120_000, maxOutputBytes: 256 * 1024, signal, env });
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
      const snapshot = await snapshotLatexProject(liveProjectRoot, snapshotRoot, basename(entryPath));
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
    await Promise.allSettled(this.active.values());
  }
}
