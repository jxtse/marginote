import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { TexLocation } from "./latex-preview.js";

/** A paged viewer with explicit, persistent page/zoom state and bounded canvas memory. */
export class LatexPdf {
  readonly element = document.createElement("div");
  private readonly controls = document.createElement("div");
  private readonly viewport = document.createElement("div");
  private readonly pageInput = document.createElement("input");
  private readonly count = document.createElement("span");
  private readonly zoomInput = document.createElement("select");
  private document: PDFDocumentProxy | undefined;
  private loading: PDFDocumentLoadingTask | undefined;
  private readonly tasks = new Set<PDFDocumentLoadingTask>();
  private renderTask: RenderTask | undefined;
  private version = 0;
  private drawing = 0;
  private scale = 1;
  private page = 1;
  private zoom = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onPosition: (page: number, x: number, y: number) => void, private readonly onError: (message: string) => void) {
    this.element.className = "latex-pdf";
    this.controls.className = "latex-pdf-controls";
    this.viewport.className = "latex-pdf-viewport";
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute("aria-label", "PDF page; double-click text to find its source");
    this.pageInput.type = "number";
    this.pageInput.min = "1";
    this.pageInput.value = "1";
    this.pageInput.setAttribute("aria-label", "PDF page");
    const button = (label: string, action: () => void) => {
      const node = document.createElement("button"); node.textContent = label; node.onclick = action; return node;
    };
    this.controls.append(button("Previous", () => void this.go(this.page - 1)), this.pageInput, this.count, button("Next", () => void this.go(this.page + 1)));
    this.pageInput.onchange = () => void this.go(Number(this.pageInput.value));
    for (const [value, label] of [[0, "Fit width"], [0.75, "75%"], [1, "100%"], [1.25, "125%"], [1.5, "150%"], [2, "200%"]] as const) {
      const option = document.createElement("option"); option.value = String(value); option.textContent = label; this.zoomInput.append(option);
    }
    this.zoomInput.setAttribute("aria-label", "PDF zoom");
    this.zoomInput.onchange = () => { this.zoom = Number(this.zoomInput.value); void this.draw(); };
    this.controls.append(this.zoomInput);
    this.element.append(this.controls, this.viewport);
    new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => { if (this.document && !this.zoom && this.element.isConnected) void this.draw(); }, 150);
    }).observe(this.viewport);
    this.viewport.ondblclick = (event) => {
      const paper = this.viewport.querySelector<HTMLElement>(".latex-paper");
      if (!paper || !(event.target instanceof Node) || !paper.contains(event.target)) return;
      const bounds = paper.getBoundingClientRect();
      onPosition(this.page, (event.clientX - bounds.left) / this.scale, (event.clientY - bounds.top) / this.scale);
    };
  }

  reset() {
    this.version++; this.drawing++;
    clearTimeout(this.resizeTimer);
    this.renderTask?.cancel();
    for (const task of this.tasks) void task.destroy().catch(() => {});
    this.tasks.clear();
    this.loading = undefined;
    this.document = undefined;
    this.page = 1; this.zoom = 0;
    this.zoomInput.value = "0";
    this.viewport.replaceChildren();
  }

  async load(url: string): Promise<void> {
    const version = ++this.version;
    try {
      const pdfjs = await import("pdfjs-dist");
      if (version !== this.version) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const task = pdfjs.getDocument({ url, enableXfa: false, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/" });
      this.tasks.add(task);
      this.loading = task;
      const document = await task.promise;
      if (version !== this.version) { await task.destroy(); return; }
      this.document = document;
      this.page = Math.min(this.page, document.numPages);
      await this.draw();
      for (const previous of this.tasks) if (previous !== task) { void previous.destroy().catch(() => {}); this.tasks.delete(previous); }
    } catch (error) { if (version === this.version) this.onError(`PDF viewer: ${error instanceof Error ? error.message : error}. Use Open PDF to view the file.`); }
  }

  private async go(page: number) {
    if (!this.document || !Number.isFinite(page)) return;
    this.page = Math.max(1, Math.min(this.document.numPages, Math.floor(page)));
    this.viewport.scrollTop = 0;
    await this.draw();
  }

  private async draw() {
    const document = this.document;
    if (!document) return;
    const drawing = ++this.drawing;
    this.renderTask?.cancel();
    try {
      const page = await document.getPage(this.page);
      if (drawing !== this.drawing) return;
      const base = page.getViewport({ scale: 1 });
      const scale = this.zoom || Math.max(0.25, (this.viewport.clientWidth - 32) / base.width);
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)));
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      const paper = window.document.createElement("div");
      paper.className = "latex-paper";
      paper.style.width = `${viewport.width}px`; paper.style.height = `${viewport.height}px`;
      paper.style.setProperty("--scale-factor", String(scale));
      paper.style.setProperty("--total-scale-factor", String(scale));
      paper.append(canvas);
      const task = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      this.renderTask = task;
      await task.promise;
      if (drawing !== this.drawing) return;
      // Commit the replacement only after it renders; keep the old page visible while working.
      const top = this.viewport.scrollTop; const left = this.viewport.scrollLeft;
      this.viewport.replaceChildren(paper);
      this.viewport.scrollTop = top; this.viewport.scrollLeft = left;
      this.scale = scale;
      this.pageInput.value = String(this.page); this.pageInput.max = String(document.numPages);
      this.count.textContent = `/ ${document.numPages}`;
      const pdfjs = await import("pdfjs-dist");
      const layer = window.document.createElement("div"); layer.className = "textLayer";
      paper.append(layer);
      const text = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport });
      if (drawing !== this.drawing) return;
      await text.render();
    } catch (error) {
      if (drawing === this.drawing && !(error instanceof Error && error.name === "RenderingCancelledException")) this.onError(`PDF rendering failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async highlight(location: TexLocation) {
    await this.go(location.page);
    const paper = this.viewport.querySelector<HTMLElement>(".latex-paper");
    if (!paper) return;
    paper.querySelector(".latex-target")?.remove();
    const target = document.createElement("div"); target.className = "latex-target";
    Object.assign(target.style, { left: `${location.x * this.scale}px`, top: `${location.y * this.scale}px`, width: `${Math.max(location.width, 8) * this.scale}px`, height: `${Math.max(location.height, 8) * this.scale}px` });
    paper.append(target);
    this.viewport.scrollTop = Math.max(0, location.y * this.scale - this.viewport.clientHeight / 3);
  }
}
