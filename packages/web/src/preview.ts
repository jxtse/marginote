import { previewBlocks } from "./preview-blocks.js";
import type { Mermaid } from "mermaid";
import { imageAssetUrl, rewriteSrcset } from "./media.js";

/**
 * Mermaid is ~900 KB and most documents contain no diagrams, so it is loaded on first
 * use rather than shipped in the initial bundle.
 */
let mermaidModule: Promise<Mermaid> | null = null;
const loadMermaid = (): Promise<Mermaid> => {
  mermaidModule ??= import("mermaid").then((m) => m.default);
  return mermaidModule;
};

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let mermaidTheme: "dark" | "default" | null = null;
const renderVersions = new WeakMap<HTMLElement, number>();

/**
 * Mermaid bakes its palette in at initialize() time, so a diagram rendered before the
 * viewer switched to dark keeps dark-on-dark arrows. Re-initialise whenever the scheme
 * no longer matches what we last configured.
 */
async function initMermaid(): Promise<Mermaid> {
  const mermaid = await loadMermaid();
  const wanted = darkQuery.matches ? "dark" : "default";
  if (mermaidTheme !== wanted) {
    mermaid.initialize({ startOnLoad: false, theme: wanted, securityLevel: "strict" });
    mermaidTheme = wanted;
  }
  return mermaid;
}

/** Repaint diagrams when the viewer's colour scheme changes. */
export function onColorSchemeChange(repaint: () => void): void {
  darkQuery.addEventListener("change", () => {
    mermaidTheme = null;
    repaint();
  });
}

/** Rewrite [[wiki links]] into real anchors before Markdown parsing. */
function linkifyWikiLinks(source: string, exists: (target: string) => string | null): string {
  return source.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_all, target, _hash, label) => {
    const path = exists(String(target).trim());
    const text = String(label ?? target).trim();
    return path
      ? `<a class="wikilink" data-path="${escapeAttr(path)}" href="#">${escapeHtml(text)}</a>`
      : `<span class="wikilink missing" title="No document matches this link">${escapeHtml(text)}</span>`;
  });
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const escapeAttr = escapeHtml;

export async function renderPreview(
  target: HTMLElement,
  source: string,
  options: { resolveLink: (t: string) => string | null; onNavigate: (path: string) => void; documentPath?: string },
): Promise<void> {
  const version = (renderVersions.get(target) ?? 0) + 1;
  renderVersions.set(target, version);
  const fragment = document.createDocumentFragment();
  for (const block of previewBlocks(source, (raw) => linkifyWikiLinks(raw, options.resolveLink))) {
    const template = document.createElement("template");
    template.innerHTML = block.html;
    for (const node of [...template.content.childNodes]) {
      let element: Element;
      if (node instanceof Element) element = node;
      else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        element = document.createElement("span");
        element.append(node);
      } else {
        fragment.append(node);
        continue;
      }
      element.setAttribute("data-src-start", String(block.start));
      element.setAttribute("data-src-end", String(block.end));
      fragment.append(element);
    }
  }
  target.replaceChildren(fragment);

  if (options.documentPath) {
    for (const image of target.querySelectorAll<HTMLImageElement>("img")) {
      const reference = image.getAttribute("src") ?? "";
      const url = imageAssetUrl(reference, options.documentPath);
      const srcset = image.getAttribute("srcset");
      if (srcset !== null) {
        const rewritten = rewriteSrcset(srcset, options.documentPath);
        if (rewritten) image.setAttribute("srcset", rewritten); else image.removeAttribute("srcset");
      }
      if (!url) { image.removeAttribute("src"); image.alt ||= "Unsupported or unsafe image path"; continue; }
      if (/\.pdf(?:[?#]|$)/i.test(reference) && url.startsWith("/api/assets?")) {
        const object = document.createElement("object");
        object.className = "pdf-image";
        object.type = "application/pdf";
        object.data = url;
        object.setAttribute("aria-label", image.alt || "PDF figure");
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = image.alt || "Open PDF figure";
        object.append(link.cloneNode(true));
        const figure = document.createElement("span");
        figure.className = "pdf-figure";
        if (image.dataset.srcStart) figure.dataset.srcStart = image.dataset.srcStart;
        if (image.dataset.srcEnd) figure.dataset.srcEnd = image.dataset.srcEnd;
        figure.append(object, link);
        image.replaceWith(figure);
      } else { image.src = url; image.loading = "lazy"; }
    }
  }

  for (const anchor of target.querySelectorAll<HTMLAnchorElement>("a.wikilink")) {
    anchor.onclick = (event) => {
      event.preventDefault();
      const path = anchor.dataset.path;
      if (path) options.onNavigate(path);
    };
  }

  const blocks = [...target.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (blocks.length === 0) return;

  const mermaid = await initMermaid();
  if (renderVersions.get(target) !== version) return;
  await Promise.all(
    blocks.map(async (block, index) => {
      const container = block.parentElement;
      if (!container) return;
      try {
        const { svg } = await mermaid.render(`mmd-${Date.now()}-${version}-${index}`, block.textContent ?? "");
        if (renderVersions.get(target) !== version) return;
        const figure = document.createElement("figure");
        figure.className = "mermaid-figure";
        figure.dataset.srcStart = container.dataset.srcStart;
        figure.dataset.srcEnd = container.dataset.srcEnd;
        figure.innerHTML = svg;
        container.replaceWith(figure);
      } catch (error) {
        if (renderVersions.get(target) !== version) return;
        // A broken diagram should show its error, not blank the whole preview.
        const pre = document.createElement("pre");
        pre.className = "mermaid-error";
        pre.dataset.srcStart = container.dataset.srcStart;
        pre.dataset.srcEnd = container.dataset.srcEnd;
        pre.textContent = `Mermaid error: ${(error as Error).message}`;
        container.replaceWith(pre);
      }
    }),
  );
}
