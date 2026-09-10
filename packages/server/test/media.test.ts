import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarginoteServer } from "../src/server.js";
import type { LatexCompiler } from "../src/latex.js";

let root: string;
let outside: string;
let server: MarginoteServer;
const pdf = Buffer.from("%PDF-1.7\nfixture\n%%EOF");
const compiler = vi.fn<LatexCompiler>();
async function dispatch(url: string, method = "GET", headers = {}, req?: EventEmitter): Promise<Response> {
  let status = 200;
  const responseHeaders = new Headers();
  let body: string | Buffer = "";
  const response = {
    setHeader: (key: string, value: string) => responseHeaders.set(key, value),
    writeHead: (code: number, values: Record<string, string>) => { status = code; for (const [key, value] of Object.entries(values ?? {})) responseHeaders.set(key, value); },
    end: (value: string | Buffer) => { body = value; },
  };
  const request = Object.assign(req ?? new EventEmitter(), { url, method, headers: { host: "127.0.0.1", ...headers } });
  await (server as unknown as { onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> }).onRequest(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  return new Response(body, { status, headers: responseHeaders });
}
const request = (path: string, route = "assets") => dispatch(`/api/${route}?${route === "assets" ? "path" : "doc"}=${encodeURIComponent(path)}`, route === "latex" ? "POST" : "GET");

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "marginote-media-")));
  outside = await mkdtemp(join(tmpdir(), "marginote-secret-"));
  await mkdir(join(root, "paper"));
  await writeFile(join(root, "paper/main.tex"), "\\input{section}");
  await writeFile(join(root, "paper/section.tex"), "original");
  await writeFile(join(root, "note.markdown"), "# Markdown");
  await writeFile(join(outside, "secret.png"), "secret");
  await symlink(outside, join(root, "escape"));
  compiler.mockReset();
  compiler.mockImplementation(async ({ outputDir }) => { await writeFile(join(outputDir, "main.pdf"), pdf); return "compiled"; });
  const listen = vi.spyOn(MarginoteServer.prototype as unknown as { listen(): Promise<void> }, "listen").mockResolvedValue();
  server = await MarginoteServer.start({ root, port: 0, persist: false, git: false, latexCompiler: compiler });
  listen.mockRestore();
});
afterEach(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

it("discovers TeX and Markdown and flushes included live documents before fresh compilation", async () => {
  expect(server.vault.list()).toEqual(["note.markdown", "paper/main.tex", "paper/section.tex"]);
  const handle = server.vault.getDoc("paper/section.tex");
  handle.text.insert(0, "live ");
  compiler.mockImplementation(async ({ outputDir, entryPath }) => {
    expect(entryPath).not.toBe(join(root, "paper/main.tex"));
    expect(await readFile(join(root, "paper/section.tex"), "utf8")).toBe("live original");
    expect(await readFile(join(entryPath, "../section.tex"), "utf8")).toBe("live original");
    await writeFile(join(outputDir, "main.pdf"), pdf);
    return "compiled";
  });
  const response = await request("paper/main.tex", "latex");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf);
  const output = compiler.mock.calls[0]![0].outputDir;
  await expect(readFile(join(output, "main.pdf"))).rejects.toThrow();
});

it.each(["../secret.tex", "%2e%2e/secret.tex", "/main.tex", "paper\\main.tex", "note.markdown", "escape/secret.tex"])("rejects unsafe or non-TeX entry %s", async (path) => {
  expect((await request(path, "latex")).status).toBe(400);
  expect(compiler).not.toHaveBeenCalled();
});
it("returns missing and method errors", async () => {
  expect((await request("missing.tex", "latex")).status).toBe(404);
  expect((await dispatch("/api/latex?doc=paper/main.tex")).status).toBe(405);
});
it("deduplicates concurrent compiles and limits process fanout", async () => {
  let release!: () => void;
  compiler.mockImplementation(async ({ outputDir }) => { await new Promise<void>((resolve) => { release = resolve; }); await writeFile(join(outputDir, "main.pdf"), pdf); return "ok"; });
  const first = request("paper/main.tex", "latex");
  await vi.waitFor(() => expect(compiler).toHaveBeenCalledTimes(1));
  const duplicate = request("paper/main.tex", "latex");
  expect((await request("paper/section.tex", "latex")).status).toBe(429);
  release();
  expect((await first).status).toBe(200);
  expect((await duplicate).status).toBe(200);
  expect(compiler).toHaveBeenCalledTimes(1);
});
it("cancels a compilation whose client disconnected and frees the slot for the next request", async () => {
  let sawAbort = false;
  compiler.mockImplementation(({ signal }) => new Promise((_, reject) => {
    if (signal.aborted) { sawAbort = true; reject(new Error("Compilation cancelled")); return; }
    signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("Compilation cancelled")); }, { once: true });
  }));
  const socket = new EventEmitter();
  const orphan = dispatch("/api/latex?doc=paper%2Fmain.tex", "POST", {}, socket);
  await vi.waitFor(() => expect(compiler).toHaveBeenCalledTimes(1));
  socket.emit("close");
  expect((await orphan).status).toBe(422);
  expect(sawAbort).toBe(true);
  compiler.mockImplementation(async ({ outputDir }) => { await writeFile(join(outputDir, "section.pdf"), pdf); return "ok"; });
  expect((await request("paper/section.tex", "latex")).status).toBe(200);
});

it("close() waits for the running compilation to finish its cleanup before resolving", async () => {
  let finishCleanup!: () => void;
  const cleanedUp = new Promise<void>((resolve) => { finishCleanup = resolve; });
  let compilerAborted = false;
  compiler.mockImplementation(({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { compilerAborted = true; void cleanedUp.then(() => reject(new Error("Compilation cancelled"))); }, { once: true });
  }));
  const inflight = request("paper/main.tex", "latex");
  await vi.waitFor(() => expect(compiler).toHaveBeenCalledTimes(1));
  let closed = false;
  const closing = server.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(compilerAborted).toBe(true);
  expect(closed).toBe(false);
  finishCleanup();
  await closing;
  expect(closed).toBe(true);
  expect((await inflight).status).toBe(422);
});

it("keeps included TeX sources immutable while the live project changes", async () => {
  compiler.mockImplementation(async ({ outputDir, entryPath }) => {
    await writeFile(join(root, "paper/section.tex"), "changed during compile");
    expect(await readFile(join(entryPath, "../section.tex"), "utf8")).toBe("original");
    await writeFile(join(outputDir, "main.pdf"), pdf);
    return "compiled";
  });
  const response = await request("paper/main.tex", "latex");
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf);
});

it("compiles an immutable snapshot when a live entry changes A to B to A", async () => {
  const original = "\\documentclass{article}\\begin{document}A\\end{document}";
  await writeFile(join(root, "paper/main.tex"), original);
  compiler.mockImplementation(async ({ outputDir, entryPath }) => {
    await writeFile(join(root, "paper/main.tex"), original.replace("A", "B"));
    const compiled = await readFile(entryPath, "utf8");
    await writeFile(join(root, "paper/main.tex"), original);
    await writeFile(join(outputDir, "main.pdf"), Buffer.from(`%PDF-${compiled.includes("B") ? "B" : "A"}`));
    return "compiled";
  });
  const response = await request("paper/main.tex", "latex");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("%PDF-A");
  expect(response.headers.get("x-source-hash")).toBe(createHash("sha256").update(original).digest("hex"));
});

it("reports failures without serving a stale PDF", async () => {
  await writeFile(join(root, "paper/main.pdf"), pdf);
  compiler.mockRejectedValue(new Error("Tectonic not found or failed: <unsafe>"));
  const response = await request("paper/main.tex", "latex");
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "compile_failed", error: expect.stringContaining("Tectonic") });
  compiler.mockResolvedValue("no PDF produced");
  expect((await request("paper/main.tex", "latex")).status).toBe(422);
});
it.each([["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"], ["svg", "image/svg+xml"], ["pdf", "application/pdf"]])("serves %s with correct MIME and sandbox headers", async (extension, mime) => {
  await writeFile(join(root, `paper/image.${extension}`), "fixture");
  const response = await request(`paper/image.${extension}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(mime);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(await response.text()).toBe("fixture");
});
it.each(["../secret.png", "%2e%2e/secret.png", "%252e%252e/secret.png", "escape/secret.png", "paper/main.tex", "/secret.png", "paper\\image.png"])("rejects unsafe asset %s", async (path) => {
  expect((await request(path)).status).toBe(400);
});
it("returns 404 for missing assets and preserves origin guard", async () => {
  expect((await request("missing.png")).status).toBe(404);
  expect((await dispatch("/api/assets?path=missing.png", "GET", { origin: "https://evil.example" })).status).toBe(403);
});
