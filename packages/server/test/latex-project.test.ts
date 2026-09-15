import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Vault } from "@marginote/bridge";
import { LatexRenderer } from "../src/latex.js";
import { resolveTexEntry, texPath } from "../src/latex-project.js";
import { parseSyncTex, texDiagnostics } from "../src/latex-synctex.js";

let root: string;
let vault: Vault;
let renderer: LatexRenderer;
const main = "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "marginote-tex-project-")));
  await mkdir(join(root, "paper/sections"), { recursive: true });
  await writeFile(join(root, "paper/main.tex"), main);
  await writeFile(join(root, "paper/sections/intro.tex"), "Hello \\label{sec:intro}");
  await writeFile(join(root, "paper/refs.bib"), "@article{smith2020,title={Title}}\n@comment{ignored,title={No}}");
  vault = await Vault.open({ root, persist: false });
  renderer = new LatexRenderer(vault, async ({ root, entryPath, outputDir }) => {
    const name = entryPath.endsWith("check.tex") ? "check" : "main";
    await writeFile(join(outputDir, `${name}.pdf`), "%PDF-1.7 fixture");
    await writeFile(join(outputDir, `${name}.synctex.gz`), gzipSync(`SyncTeX Version:1\nInput:1:${root}/sections/intro.tex\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n(1,1:65536,131072:65536,65536,0\n)\n}1\nPostamble:\nPost scriptum:\n`));
    return "ok";
  });
});
afterEach(async () => { await renderer?.close(); await vault?.close(); await rm(root, { recursive: true, force: true }); });

it("resolves included chapters and indexes labels and bibliography keys", async () => {
  const project = await renderer.project("paper/sections/intro.tex");
  expect(project).toMatchObject({ entry: "paper/main.tex", labels: ["sec:intro"], citations: ["smith2020"] });
  const rendered = await renderer.render("paper/main.tex");
  expect(rendered.projectHash).toBe(project.revision);
  expect(renderer.mapping(rendered.id)).toMatchObject({ entry: "paper/main.tex", locations: [expect.objectContaining({ file: "paper/sections/intro.tex", line: 1, page: 1 })] });
});

it("does not guess when a chapter belongs to multiple main documents", async () => {
  vault.getDoc("paper/other.tex").text.insert(0, main);
  await vault.flush();
  expect(await resolveTexEntry(vault, "paper/sections/intro.tex")).toMatchObject({ entry: null, candidates: ["paper/main.tex", "paper/other.tex"] });
  expect(await renderer.project("paper/sections/intro.tex", "paper/other.tex")).toMatchObject({ entry: "paper/other.tex" });
});

it("honors root directives and rejects paths escaping the vault", async () => {
  vault.getDoc("paper/sections/intro.tex").applyFromDisk("% !TEX root = ../main.tex\nHello");
  await writeFile(join(root, "paper/sections/intro.tex"), "% !TEX root = ../main.tex\nHello");
  expect(await renderer.project("paper/sections/intro.tex")).toMatchObject({ entry: "paper/main.tex" });
  expect(() => texPath("main.tex", "../outside.tex")).toThrow(/leaves the vault/);
  await expect(renderer.project("../secret.tex")).rejects.toMatchObject({ status: 400 });
  vault.getDoc("paper/sections/intro.tex").applyFromDisk("% !TEX root = ../../../../outside.tex\nHello");
  await writeFile(join(root, "paper/sections/intro.tex"), "% !TEX root = ../../../../outside.tex\nHello");
  await expect(renderer.project("paper/sections/intro.tex")).rejects.toMatchObject({ status: 400 });
});

it("invalidates project hashes for live includes, bibliography and figures", async () => {
  const before = await renderer.project("paper/main.tex");
  vault.getDoc("paper/sections/intro.tex").text.insert(0, "Updated ");
  const edited = await renderer.project("paper/main.tex");
  expect(edited.revision).not.toBe(before.revision);
  await writeFile(join(root, "paper/refs.bib"), "@article{newkey,title={New}}");
  const bibliography = await renderer.project("paper/main.tex");
  expect(bibliography.revision).not.toBe(edited.revision);
  expect(bibliography.citations).toEqual(["newkey"]);
  await writeFile(join(root, "paper/figure.svg"), "<svg/>");
  expect((await renderer.project("paper/main.tex")).revision).not.toBe(bibliography.revision);
});

it("checks compilation and bounds retained navigation maps", async () => {
  expect(await renderer.check()).toEqual({ ok: true });
  const first = await renderer.render("paper/main.tex");
  for (let i = 0; i < 4; i++) await renderer.render("paper/main.tex");
  expect(() => renderer.mapping(first.id)).toThrow(/expired/);
});

it("converts real Tectonic coordinates and excludes non-project inputs", () => {
  const source = "SyncTeX Version:1\nInput:1:/snapshot/main.tex\nInput:2:/secret.tex\nUnit:1\nMagnification:1000\nX Offset:0\nY Offset:0\nContent:\n{2\n(1,3:65536,131072:65536,65536,0\ng1,4:65536,131072\n(2,1:0,0:1,1,1\nPostamble:\nPost scriptum:\n";
  const result = parseSyncTex(source, "/snapshot", "paper", new Set(["main.tex"]));
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ file: "paper/main.tex", line: 3, page: 2 });
  expect(result[0]!.x).toBeCloseTo(72 / 72.27);
  expect(parseSyncTex(source + "Magnification:2\n", "/snapshot", "paper", new Set(["main.tex"]))).toEqual([]);
  expect(texDiagnostics("error: main.tex:9: Undefined control sequence", "paper/main.tex", ["paper/main.tex"])).toEqual([{ file: "paper/main.tex", line: 9, message: "Undefined control sequence" }]);
});
