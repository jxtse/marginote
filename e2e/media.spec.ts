import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MarginoteServer } from "../packages/server/src/server.js";
import type { EditorView } from "@codemirror/view";

declare global {
  interface Window { __marginoteView?: EditorView }
}

function fixturePdf(): Buffer {
  const stream = "BT /F1 24 Tf 40 100 Td (Marginote PDF fixture) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
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
    await expect(page.locator("iframe.latex-pdf")).toHaveAttribute("src", /^blob:/);
    expect(await page.locator("iframe.latex-pdf").evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(200);
    await page.evaluate(() => window.__marginoteView!.dispatch({ changes: { from: 0, insert: "% edit\n" } }));
    await expect(page.locator(".latex-error")).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator(".latex-error img")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry compilation" }).click();
    await expect(page.locator(".latex-status")).toContainText("PDF compiled");
    await page.goto(`http://127.0.0.1:${server.port}/?doc=paper/note.md`);
    await expect(page.locator("#preview h1")).toHaveText("Figures");
    const image = page.locator("#preview img");
    await expect(image).toHaveAttribute("src", "/api/assets?path=paper%2Ffigure.svg");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(100);
    await expect(page.locator("#preview object")).toHaveAttribute("data", "/api/assets?path=paper%2Ffigure.pdf");
    await expect(page.locator("iframe.latex-pdf")).toHaveCount(0);
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
