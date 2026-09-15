import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { MarginoteServer } from "../packages/server/src/server.js";
import type { EditorView } from "@codemirror/view";

declare global {
  interface Window { __marginoteView?: EditorView }
}

function fixturePdf(pages = 1): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({length: pages}, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let page = 0; page < pages; page++) {
    const stream = `BT /F1 18 Tf 20 100 Td (Marginote PDF page ${page + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + page * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

test("TeX PDF lifecycle and relative Markdown figures", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "marginote-media-e2e-"));
  let server: MarginoteServer | undefined;
  let compiles = 0;
  try {
    await mkdir(join(root, "paper"));
    await writeFile(join(root, "paper/main.tex"), "\\documentclass{article}\n\\begin{document}Hello\\end{document}");
    await writeFile(join(root, "paper/note.md"), "# Figures\n\n![Diagram](figure.svg)\n\n![PDF](figure.pdf)");
    await writeFile(join(root, "paper/figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="green"/></svg>');
    await writeFile(join(root, "paper/figure.pdf"), fixturePdf());
    server = await MarginoteServer.start({ root, port: 0, persist: false, git: false, webRoot: resolve("packages/web/dist"), latexCompiler: async ({ outputDir }) => {
      compiles++;
      if (compiles === 2) throw new Error("<img src=x onerror=alert(1)> compile failure");
      await writeFile(join(outputDir, "main.pdf"), fixturePdf());
      return "ok";
    } });
    await page.goto(`http://127.0.0.1:${server.port}/?doc=paper/main.tex`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("live", { exact: true })).toBeVisible();
    await expect(page.locator(".latex-status")).toContainText("PDF compiled", { timeout: 15000 });
    await expect(page.locator(".latex-pdf canvas")).toBeVisible();
    expect(await page.locator(".latex-pdf").evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(200);
    await page.getByLabel("PDF zoom").selectOption("1.5");
    await page.evaluate(() => window.__marginoteView!.dispatch({ changes: { from: 0, insert: "% edit\n" } }));
    await expect(page.locator(".latex-error")).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator(".latex-error img")).toHaveCount(0);
    await expect(page.locator(".latex-pdf canvas")).toBeVisible();
    await expect(page.getByLabel("PDF zoom")).toHaveValue("1.5");
    await page.getByRole("button", { name: "Retry compilation" }).click();
    await expect(page.locator(".latex-status")).toContainText("PDF compiled");
    await page.goto(`http://127.0.0.1:${server.port}/?doc=paper/note.md`);
    await expect(page.locator("#preview h1")).toHaveText("Figures");
    const image = page.locator("#preview img");
    await expect(image).toHaveAttribute("src", "/api/assets?path=paper%2Ffigure.svg");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(100);
    await expect(page.locator("#preview object")).toHaveAttribute("data", "/api/assets?path=paper%2Ffigure.pdf");
    await expect(page.locator(".latex-pdf")).toHaveCount(0);
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("multi-file preview refresh, page retention, navigation and environment check", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "marginote-tex-workflow-"));
  let server: MarginoteServer | undefined;
  let compiles = 0;
  try {
    await mkdir(join(root, "paper/sections"), { recursive: true });
    await writeFile(join(root, "paper/main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/body}\n\\end{document}");
    await writeFile(join(root, "paper/sections/body.tex"), "First line\nSecond line\nThird line");
    await writeFile(join(root, "paper/refs.bib"), "@article{oldkey,title={Title}}");
    server = await MarginoteServer.start({ root, port: 0, persist: false, git: false, webRoot: resolve("packages/web/dist"), latexCompiler: async ({ root: snapshot, entryPath, outputDir }) => {
      const name = entryPath.endsWith("check.tex") ? "check" : "main";
      if (name === "main") compiles++;
      await writeFile(join(outputDir, `${name}.pdf`), fixturePdf(2));
      await writeFile(join(outputDir, `${name}.synctex.gz`), gzipSync(`SyncTeX Version:1\nInput:1:${snapshot}/main.tex\nInput:2:${snapshot}/sections/body.tex\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n(1,2:1315635,6578176:6578176,657818,0\n)\n}1\n{2\n(2,2:1315635,6578176:6578176,657818,0\n)\n}2\nPostamble:\nPost scriptum:\n`));
      return "ok";
    } });
    const url = `http://127.0.0.1:${server.port}`;
    await page.goto(`${url}/?doc=paper/sections/body.tex`);
    await expect(page.locator(".latex-status")).toContainText("PDF compiled");
    await expect(page.getByLabel("LaTeX main document")).toHaveValue("paper/main.tex");
    await expect(page.locator(".latex-pdf canvas")).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByLabel("PDF zoom").selectOption("1.5");
    await expect(page.getByLabel("PDF page", { exact: true })).toHaveValue("2");
    const previous = compiles;
    await writeFile(join(root, "paper/refs.bib"), "@article{newkey,title={Changed}}");
    await expect.poll(() => compiles).toBeGreaterThan(previous);
    await expect(page.locator(".latex-status")).toContainText("PDF compiled");
    await expect(page.getByLabel("PDF page", { exact: true })).toHaveValue("2");
    await expect(page.getByLabel("PDF zoom")).toHaveValue("1.5");
    const figureBefore = compiles;
    await writeFile(join(root, "paper/figure.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await expect.poll(() => compiles).toBeGreaterThan(figureBefore);
    await expect(page.locator(".latex-status")).toContainText("PDF compiled");
    await page.getByRole("button", { name: "Find in PDF" }).click();
    await expect(page.locator(".latex-target")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("latex-preview.png") });
    await page.locator(".latex-paper").dblclick({ position: { x: 50, y: 140 } });
    await expect.poll(() => page.evaluate(() => window.__marginoteView!.state.doc.lineAt(window.__marginoteView!.state.selection.main.head).number)).toBe(2);
    // Cross-file navigation must preserve the selected main document and source hash checks.
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await page.locator(".latex-paper").dblclick({ position: { x: 50, y: 140 } });
    await expect(page.locator("#docpath")).toHaveText("paper/main.tex");
    await page.getByRole("button", { name: "Check LaTeX setup" }).click();
    await expect(page.locator(".latex-check-result")).toContainText("Basic LaTeX check passed");
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("real offline LaTeX renders references and navigates compiler errors", async ({ page }) => {
  test.skip(process.env.MARGINOTE_REAL_LATEX !== "1", "Requires Tectonic and a prepared offline resource cache");
  const root = await mkdtemp(join(tmpdir(), "marginote-real-latex-e2e-"));
  let server: MarginoteServer | undefined;
  try {
    await mkdir(join(root, "paper"));
    await writeFile(join(root, "paper/main.tex"), "\\documentclass{article}\n\\begin{document}\n\\section{Preview verification}\nText, \\textbf{bold}, \\textit{italic}, and $E=mc^2$.\n\\input{section}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}");
    await writeFile(join(root, "paper/section.tex"), "Included source with citation \\cite{sample}.\n");
    await writeFile(join(root, "paper/references.bib"), "@article{sample,author={Example, Alice},title={Synthetic fixture},journal={Fixture},year={2020}}");
    server = await MarginoteServer.start({ root, port: 0, persist: false, git: false, webRoot: resolve("packages/web/dist") });
    await page.goto(`http://127.0.0.1:${server.port}/?doc=paper/main.tex`);
    await expect(page.locator(".latex-status")).toContainText("PDF compiled", { timeout: 30_000 });
    await expect(page.locator(".textLayer")).toContainText("Synthetic fixture");
    await page.getByRole("button", { name: "Check LaTeX setup" }).click();
    await expect(page.locator(".latex-check-result")).toContainText("Basic LaTeX check passed");
    await page.screenshot({ path: test.info().outputPath("real-latex.png") });
    await page.evaluate(() => {
      const view = window.__marginoteView!;
      view.dispatch({ changes: { from: view.state.doc.line(4).from, insert: "\\notARealCommand " } });
    });
    await expect(page.locator(".latex-error")).toContainText("Undefined control sequence");
    await expect(page.locator(".latex-pdf canvas")).toBeVisible();
    await page.getByRole("button", { name: /paper\/main.tex:4/ }).click();
    await expect.poll(() => page.evaluate(() => window.__marginoteView!.state.doc.lineAt(window.__marginoteView!.state.selection.main.head).number)).toBe(4);
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
