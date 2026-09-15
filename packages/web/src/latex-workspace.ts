import { LatexPreview, sourceHash, type LatexState, type TexDiagnostic, type TexMapping } from "./latex-preview.js";
import { LatexPdf } from "./latex-pdf.js";
import type { TexSymbols } from "./latex-editor.js";

interface Project extends TexSymbols { doc: string; entry: string | null; candidates: string[]; source?: string; revision?: string; docHash?: string; hashes?: Record<string, string> }
interface Context { doc: string; source: string; line: number }
interface Actions {
  current: () => Context | null;
  navigate: (file: string, line: number, hash?: string) => Promise<void>;
  diagnostics: (diagnostics: TexDiagnostic[], hashes: Record<string, string>) => void;
}

export function environmentAdvice(message: string): string {
  if (/not found on PATH|runtime_missing/i.test(message)) return "Install Tectonic on the server and restart Marginote with it on PATH. Preview uses only cached TeX resources.";
  if (/sandbox|Operation not permitted|process accounting/i.test(message)) return "The server needs macOS sandbox-exec or Linux bubblewrap with permitted namespaces and process accounting. Run the check in the same environment as the server. Isolation stays enabled.";
  if (/font|cached|not found|\.sty/i.test(message)) return "A required font or TeX package is unavailable. On the server, compile a trusted copy of this project with Tectonic outside Marginote to populate its cache, then retry. That preparation may download resources. Preview itself stays offline.";
  return "Read the compiler log below. Fix the reported source or runtime problem, then retry. An environment check covers basic text, headings and math; individual projects can need more packages.";
}

export class LatexWorkspace {
  symbols: TexSymbols = { labels: [], citations: [] };
  private readonly toolbar = document.createElement("div");
  private readonly select = document.createElement("select");
  private readonly status = document.createElement("div");
  private readonly errors = document.createElement("div");
  private readonly link = document.createElement("a");
  private readonly forward = document.createElement("button");
  private readonly viewer: LatexPdf;
  private readonly compiler: LatexPreview;
  private project: Project | undefined;
  private mapping: TexMapping | undefined;
  private ready = false;
  private input: { doc: string; source: string } | undefined;
  private version = 0;
  private request: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private recovery = 0;
  private checkRequest: AbortController | undefined;
  private checkButton: HTMLButtonElement;
  private checkResult = document.createElement("div");

  constructor(private readonly host: HTMLElement, private readonly actions: Actions) {
    this.toolbar.className = "latex-toolbar";
    this.select.setAttribute("aria-label", "LaTeX main document");
    this.select.onchange = () => {
      if (!this.input) return;
      try { localStorage.setItem(`marginote:tex-root:${this.input.doc}`, this.select.value); } catch {}
      this.compiler.reset(); this.viewer.reset(); this.mapping = undefined;
      this.refresh();
    };
    this.status.className = "latex-status"; this.status.setAttribute("role", "status");
    this.errors.className = "latex-errors";
    this.link.textContent = "Open PDF"; this.link.target = "_blank"; this.link.rel = "noopener"; this.link.hidden = true;
    this.forward.textContent = "Find in PDF"; this.forward.disabled = true;
    this.forward.onclick = () => void this.findSource();
    const retry = document.createElement("button"); retry.textContent = "Recompile";
    retry.onclick = () => { this.compiler.invalidate(); this.refresh(); };
    this.checkButton = document.createElement("button"); this.checkButton.textContent = "Check LaTeX setup";
    this.checkButton.onclick = () => void this.check();
    this.checkResult.className = "latex-check-result";
    this.toolbar.append(this.select, retry, this.forward, this.link, this.checkButton);
    this.viewer = new LatexPdf((page, x, y) => void this.findPdf(page, x, y), message => { this.errors.textContent = message; });
    this.compiler = new LatexPreview(state => this.show(state));
    // Reconnects and missed file events get a bounded, infrequent fallback refresh.
    setInterval(() => { if (this.input && !document.hidden && !this.request) this.refresh(); }, 15_000);
  }

  reset(): void {
    this.version++; clearTimeout(this.timer); this.request?.abort(); this.request = undefined;
    this.checkRequest?.abort(); this.checkRequest = undefined;
    this.compiler.reset(); this.viewer.reset(); this.project = undefined; this.mapping = undefined;
    this.ready = false; this.input = undefined; this.symbols = { labels: [], citations: [] };
    this.link.hidden = true; this.forward.disabled = true; this.errors.replaceChildren();
    this.checkButton.disabled = false; this.checkResult.replaceChildren();
  }

  clear(): void { this.reset(); this.mount(); this.status.textContent = "The TeX source is empty."; }

  schedule(doc: string, source: string): void {
    const changed = doc !== this.input?.doc || source !== this.input?.source;
    this.input = { doc, source };
    this.mount();
    if (!changed) return;
    this.recovery = 0;
    this.compiler.invalidate(); this.ready = false; this.forward.disabled = true;
    this.actions.diagnostics([], {});
    this.refresh();
  }

  changed(path?: string): void {
    if (!this.input) return;
    const entry = this.project?.entry;
    const directory = entry?.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
    if (!path || !entry || path.startsWith(directory)) this.refresh();
  }

  private mount(): void {
    this.host.classList.add("latex-preview");
    if (!this.host.contains(this.toolbar)) this.host.replaceChildren(this.toolbar, this.status, this.checkResult, this.errors, this.viewer.element);
  }

  private refresh(): void {
    const input = this.input;
    if (!input) return;
    const version = ++this.version;
    clearTimeout(this.timer); this.request?.abort(); this.request = undefined;
    this.timer = setTimeout(() => void this.resolve(input, version), 200);
  }

  private async resolve(input: { doc: string; source: string }, version: number): Promise<void> {
    const abort = new AbortController(); this.request = abort;
    try {
      let preferred: string | null = null;
      try { preferred = localStorage.getItem(`marginote:tex-root:${input.doc}`); } catch {}
      const query = new URLSearchParams({ doc: input.doc });
      if (preferred) query.set("entry", preferred);
      const response = await fetch(`/api/latex/project?${query}`, { signal: abort.signal });
      const result = await response.json();
      if (version !== this.version) return;
      if (!response.ok) {
        // A removed/renamed saved root must not trap the document behind stale preferences.
        if (preferred && result.code === "invalid_entry") {
          try { localStorage.removeItem(`marginote:tex-root:${input.doc}`); } catch {}
          this.refresh(); return;
        }
        throw new Error(result.error ?? "Could not resolve the main document");
      }
      const project = result as Project;
      if (project.docHash && project.docHash !== await sourceHash(input.source)) {
        if (version !== this.version) return;
        if (++this.recovery > 8) throw new Error("Waiting for source sync. Reconnect, then recompile.");
        this.refresh(); return;
      }
      if (version !== this.version) return;
      const old = this.project;
      this.project = project;
      this.symbols = { labels: project.labels ?? [], citations: project.citations ?? [] };
      this.select.replaceChildren();
      if (!project.entry) {
        const option = document.createElement("option"); option.value = ""; option.textContent = "Choose main document…"; this.select.append(option);
      }
      for (const path of project.candidates) {
        const option = document.createElement("option"); option.value = path; option.textContent = path; this.select.append(option);
      }
      this.select.value = project.entry ?? "";
      if (!project.entry || !project.source || !project.revision) {
        this.compiler.reset(); this.viewer.reset(); this.ready = false; this.link.hidden = true;
        this.status.textContent = project.candidates.length ? "Choose which main document to compile." : "No main document found. Add a document class or a % !TEX root = main.tex directive.";
        return;
      }
      if (old?.entry && old.entry !== project.entry) {
        this.compiler.reset(); this.viewer.reset(); this.link.hidden = true;
      }
      if (old?.revision !== project.revision) { this.ready = false; this.forward.disabled = true; }
      this.compiler.schedule(project.entry, project.source, 0, 650, project.revision);
    } catch (error) {
      if (version === this.version) { this.ready = false; this.forward.disabled = true; this.status.textContent = error instanceof Error ? error.message : String(error); }
    } finally { if (this.request === abort) this.request = undefined; }
  }

  private show(state: LatexState): void {
    this.mount(); this.errors.replaceChildren();
    this.ready = state.status === "ready";
    this.forward.disabled = true;
    if (state.status === "ready") {
      this.status.textContent = "PDF compiled";
      this.mapping = state.mapping;
      this.forward.disabled = !state.mapping?.locations.length;
      if (!state.mapping?.locations.length) this.status.textContent += " · source navigation unavailable for this output";
      this.link.href = state.url; this.link.hidden = false;
      this.actions.diagnostics([], {});
      void this.viewer.load(state.url);
    } else if (state.status === "error") {
      this.status.textContent = state.url ? "Compilation failed · showing last successful PDF" : "LaTeX compilation failed";
      const advice = document.createElement("p"); advice.textContent = environmentAdvice(state.error);
      const log = document.createElement("pre"); log.className = "latex-error"; log.textContent = state.error;
      const retry = document.createElement("button"); retry.textContent = "Retry compilation";
      retry.onclick = () => { this.compiler.invalidate(); this.refresh(); };
      this.errors.append(advice);
      for (const diagnostic of state.diagnostics ?? []) {
        const go = document.createElement("button"); go.textContent = `${diagnostic.file}:${diagnostic.line} — ${diagnostic.message}`;
        go.onclick = () => void this.actions.navigate(diagnostic.file, diagnostic.line, this.project?.hashes?.[diagnostic.file]);
        this.errors.append(go);
      }
      this.errors.append(log, retry);
      this.actions.diagnostics(state.diagnostics ?? [], this.project?.hashes ?? {});
    } else {
      this.status.textContent = (state.status === "waiting" ? "Waiting to compile…" : "Compiling LaTeX…") + (state.url ? " · showing previous PDF" : "");
    }
  }

  private async findSource(): Promise<void> {
    const context = this.actions.current(); const mapping = this.mapping;
    if (!this.ready || !context || !mapping) return;
    if (mapping.hashes[context.doc] !== await sourceHash(context.source)) { this.status.textContent = "Source changed; wait for a fresh PDF before navigating."; return; }
    const match = mapping.locations.filter(location => location.file === context.doc).sort((a, b) => Math.abs(a.line - context.line) - Math.abs(b.line - context.line) || a.width * a.height - b.width * b.height)[0];
    if (match) await this.viewer.highlight(match);
    else this.status.textContent = "This source has no typeset position in the current PDF.";
  }

  private async findPdf(page: number, x: number, y: number): Promise<void> {
    if (!this.ready || !this.mapping) return;
    const distance = (point: TexMapping["locations"][number]) => Math.hypot(Math.max(point.x - x, 0, x - point.x - point.width), Math.max(point.y - y, 0, y - point.y - point.height));
    const match = this.mapping.locations.filter(location => location.page === page).sort((a, b) => distance(a) - distance(b) || a.width * a.height - b.width * b.height)[0];
    if (match) await this.actions.navigate(match.file, match.line, this.mapping.hashes[match.file]);
  }

  private async check(): Promise<void> {
    this.checkRequest?.abort(); const abort = new AbortController(); this.checkRequest = abort;
    this.checkButton.disabled = true; this.checkResult.textContent = "Checking basic text, headings and math offline…";
    try {
      const response = await fetch("/api/latex/check", { method: "POST", signal: abort.signal });
      const result = await response.json();
      if (abort.signal.aborted) return;
      if (response.ok) this.checkResult.textContent = "Basic LaTeX check passed. This project may require additional packages.";
      else {
        const message = [result.error, result.log].filter(Boolean).join("\n");
        const advice = document.createElement("p"); advice.textContent = environmentAdvice(message);
        const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Setup check log";
        const log = document.createElement("pre"); log.textContent = message; details.append(summary, log);
        this.checkResult.replaceChildren(advice, details);
      }
    } catch (error) { if (!abort.signal.aborted) this.checkResult.textContent = error instanceof Error ? error.message : String(error); }
    finally { if (this.checkRequest === abort) { this.checkButton.disabled = false; this.checkRequest = undefined; } }
  }
}
