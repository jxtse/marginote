import { htmlBridge, htmlTextMap } from "./html-bridge.js";
import { applyHtmlEdits, htmlAssetPath, htmlSource, type HtmlSource } from "./html-source.js";
import { rewriteSrcset } from "./media.js";

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const dataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read HTML asset")); reader.readAsDataURL(blob);
});

interface HtmlContext {
  current(): { doc: string; source: string; offset: number } | null;
  select(from: number, to: number): void;
  comment(from: number, to: number): void;
  openLink(href: string): void;
}

export class HtmlPreview {
  private frame: HTMLIFrameElement | null = null;
  private token = "";
  private snapshot = "";
  private path = "";
  private mapping: HtmlSource | null = null;
  private texts: ReturnType<typeof htmlTextMap>[] = [];
  private selection: { from: number; to: number } | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private ready = false;
  private assets = new Set<string>();
  private status: HTMLElement | null = null;
  private commentButton: HTMLButtonElement | null = null;
  private linkButton: HTMLButtonElement | null = null;
  constructor(private readonly target: HTMLElement, private readonly context: HtmlContext) { window.addEventListener("message", this.message); }
  reset(): void {
    clearTimeout(this.timer); this.controller?.abort(); this.controller = null; this.version++;
    this.frame?.remove(); this.frame = null; this.mapping = null; this.selection = null; this.ready = false;
    this.snapshot = ""; this.path = ""; this.target.classList.remove("html-preview");
    this.assets.clear();
  }
  changed(path?: string): void {
    if (!path || !this.assets.has(path)) return;
    const current = this.context.current();
    if (current && current.doc === this.path) { this.snapshot = ""; this.schedule(current.doc, current.source); }
  }
  schedule(path: string, source: string): void {
    if (this.path === path && this.snapshot === source && this.frame) return;
    this.selection = null; if (this.commentButton) this.commentButton.disabled = true;
    clearTimeout(this.timer); this.controller?.abort();
    const version = ++this.version;
    this.timer = setTimeout(() => void this.render(path, source, version), 250);
  }
  private valid(): boolean {
    const current = this.context.current();
    return Boolean(current && current.doc === this.path && current.source === this.snapshot && this.frame?.isConnected && this.ready);
  }
  private readonly message = (event: MessageEvent): void => {
    if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== "null" || event.data?.channel !== this.token) return;
    const data = event.data;
    if (data.kind === "ready") { this.ready = true; return; }
    if (!this.valid() || !this.mapping) return;
    if (data.kind === "selection") {
      this.selection = null;
      const start = data.start; const end = data.end;
      const first = Number.isInteger(start?.id) ? this.texts[start.id] : null;
      const last = Number.isInteger(end?.id) ? this.texts[end.id] : null;
      if (first && last && Number.isInteger(start.offset) && Number.isInteger(end.offset) && start.offset >= 0 && start.offset < first.starts.length && end.offset > 0 && end.offset <= last.ends.length) {
        const from = this.mapping.texts[start.id]!.start + first.starts[start.offset]!;
        const to = this.mapping.texts[end.id]!.start + last.ends[end.offset - 1]!;
        if (from < to && to <= this.snapshot.length) this.selection = { from, to };
      }
      if (this.commentButton) this.commentButton.disabled = !this.selection;
      if (data.unsupported && this.status) this.status.textContent = "This text changed dynamically; select its source to comment.";
    } else if (data.kind === "navigate" && Number.isInteger(data.id)) {
      const element = this.mapping.elements[data.id]; if (element) this.context.select(element.start, element.start);
    } else if (data.kind === "link" && typeof data.href === "string" && this.linkButton) {
      const href = data.href.slice(0, 4096);
      this.linkButton.hidden = false; this.linkButton.title = href;
      this.linkButton.onclick = () => this.context.openLink(href);
    }
  };
  private async render(path: string, source: string, version: number): Promise<void> {
    const controller = new AbortController(); this.controller = controller;
    try {
      if (source.length > 2 * 1024 * 1024) throw new Error("HTML preview is limited to 2 MiB of source");
      const token = crypto.randomUUID().replace(/-/g, "");
      const mapping = htmlSource(source, token); if (mapping.elements.length + mapping.texts.length > 20000) throw new Error("HTML preview has too many nodes");
      const decoder = document.createElement("textarea");
      const decode = (value: string) => { decoder.innerHTML = value; return decoder.value; };
      let bytes = 0; let omitted = 0; let count = 0;
      const cache = new Map<string, Promise<string | null>>();
      const asset = async (reference: string, base: string, chain: string[] = []): Promise<string | null> => {
        if (/^data:(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|font\/[^;,]+|text\/css|(?:text|application)\/(?:javascript|ecmascript))[;,]/i.test(reference)) return reference;
        const file = htmlAssetPath(reference, base);
        if (!file || chain.includes(file) || chain.length > 4) { omitted++; return null; }
        if (cache.has(file)) return cache.get(file)!;
        if (++count > 64 || bytes >= 16 * 1024 * 1024) { omitted++; return null; }
        const result = (async () => {
          try {
            const response = await fetch(`/api/assets?path=${encodeURIComponent(file)}`, { signal: controller.signal });
            if (!response.ok) throw new Error("HTML asset unavailable");
            if (!response.body) throw new Error("HTML asset unavailable");
            const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = [];
            try {
              while (true) {
                const chunk = await reader.read(); if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("HTML assets exceed 16 MiB"); }
                chunks.push(new Uint8Array(chunk.value));
              }
            } finally { reader.releaseLock(); }
            const blob = new Blob(chunks, { type: response.headers.get("content-type") ?? "application/octet-stream" });
            if (/\.css$/i.test(file)) return dataUrl(new Blob([await css(await blob.text(), file, [...chain, file])], { type: "text/css" }));
            return dataUrl(blob);
          } catch (error) { if (controller.signal.aborted) throw error; omitted++; return null; }
        })();
        cache.set(file, result); return result;
      };
      const css = async (value: string, base: string, chain: string[] = []): Promise<string> => {
        // Unrecognized CSS URL syntax remains blocked by the frame's data-only CSP.
        const matches = [...value.matchAll(/url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)'";]+))\s*\)|@import\s+(?:"([^"\n]*)"|'([^'\n]*)')/gi)];
        for (const match of matches.reverse()) {
          const reference = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
          if (reference.startsWith("#")) continue;
          const resolved = await asset(reference, base, chain);
          const replacement = match[0].startsWith("@") ? `@import url("${resolved ?? "data:text/css,"}")` : `url("${resolved ?? "data:,"}")`;
          value = value.slice(0, match.index) + replacement + value.slice(match.index! + match[0].length);
        }
        return value;
      };
      for (const attr of mapping.attributes) {
        let value: string | null = null; const decoded = decode(attr.value);
        if (attr.name === "style") value = await css(decoded, path);
        else if (["src", "poster", "background"].includes(attr.name) || (attr.tag === "link" && attr.name === "href")) value = await asset(decoded, path) ?? "data:,";
        else if (attr.name === "srcset") {
          const urls = new Map<string, string | null>();
          rewriteSrcset(decoded, path, ref => { urls.set(ref, null); return ref; });
          for (const ref of urls.keys()) urls.set(ref, await asset(ref, path));
          value = rewriteSrcset(decoded, path, ref => urls.get(ref) ?? null);
        }
        if (value !== null) mapping.edits.push({ start: attr.start, end: attr.end, text: `"${escapeAttribute(value)}"` });
      }
      for (const style of mapping.styles) mapping.edits.push({ ...style, text: await css(source.slice(style.start, style.end), path) });
      if (version !== this.version || controller.signal.aborted) return;
      const texts = mapping.texts.map(text => htmlTextMap(text.raw));
      const config = JSON.stringify({ token, attribute: `data-mn-${token}`, texts: texts.map(text => text.text) }).replace(/</g, "\\u003c");
      const policy = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
      const frame = document.createElement("iframe"); frame.title = "HTML document preview"; frame.sandbox.add("allow-scripts"); frame.referrerPolicy = "no-referrer";
      frame.onload = () => {
        if (this.frame !== frame) return;
        this.ready = false; this.selection = null;
        if (this.commentButton) this.commentButton.disabled = true;
        frame.contentWindow?.postMessage({ channel: token, kind: "ping" }, "*");
        setTimeout(() => {
          if (this.frame === frame && !this.ready && this.status) this.status.textContent = "The preview is no longer available, possibly after blocked navigation. Reload preview to return to the report.";
        }, 750);
      };
      frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>(${htmlBridge.toString()})(${config})</script><style>.mn-highlight-${token}{outline:2px solid #907aa9!important;outline-offset:3px!important}</style>${applyHtmlEdits(source, mapping.edits)}`;
      const toolbar = document.createElement("div"); toolbar.className = "html-toolbar";
      const comment = document.createElement("button"); comment.textContent = "Comment selected text"; comment.disabled = true;
      comment.onclick = () => { if (this.valid() && this.selection) this.context.comment(this.selection.from, this.selection.to); };
      const find = document.createElement("button"); find.textContent = "Find in HTML";
      find.onclick = () => {
        if (!this.valid()) return;
        const offset = this.context.current()!.offset;
        const candidates = mapping.elements.map((entry, id) => ({ ...entry, id })).filter(entry => entry.start <= offset && offset <= entry.end).sort((a, b) => (a.end - a.start) - (b.end - b.start));
        if (candidates[0]) frame.contentWindow?.postMessage({ channel: token, kind: "highlight", id: candidates[0].id }, "*");
      };
      const link = document.createElement("button"); link.textContent = "Open selected link"; link.hidden = true;
      const reload = document.createElement("button"); reload.textContent = "Reload preview";
      reload.onclick = () => { const current = this.context.current(); if (current) { this.snapshot = ""; this.schedule(current.doc, current.source); } };
      const status = document.createElement("span"); status.className = "html-status"; status.setAttribute("role", "status");
      status.textContent = omitted ? `HTML preview · ${omitted} unavailable or external assets omitted` : "HTML preview · select text to discuss";
      toolbar.append(comment, find, reload, link, status);
      this.token = token; this.snapshot = source; this.path = path; this.mapping = mapping; this.texts = texts; this.frame = frame; this.ready = false; this.selection = null;
      this.status = status; this.commentButton = comment; this.linkButton = link;
      this.assets = new Set(cache.keys());
      this.target.classList.add("html-preview"); this.target.replaceChildren(toolbar, frame);
    } catch (error) {
      if (version !== this.version || controller.signal.aborted) return;
      const status = document.createElement("p"); status.className = "html-status"; status.setAttribute("role", "alert"); status.textContent = error instanceof Error ? error.message : "HTML preview failed";
      this.frame?.remove(); this.frame = null; this.target.replaceChildren(status);
    }
  }
}
