/** Self-contained: serialized into an opaque-origin frame before the artifact scripts. */
export function htmlBridge(config: { token: string; texts: string[]; attribute: string }): void {
  const post = window.parent.postMessage.bind(window.parent);
  const send = (kind: string, data: object = {}) => post({ channel: config.token, kind, ...data }, "*");
  const nodes = new Map<Node, { id: number; text: string }>();
  const elements = new Map<number, Element>();
  let loaded = false;
  const endpoint = (node: Node, offset: number, end: boolean): { id: number; offset: number } | null => {
    if (node.nodeType !== Node.TEXT_NODE) {
      const child = node.childNodes[end ? offset - 1 : offset]; if (!child) return null;
      node = child;
      while (node.nodeType !== Node.TEXT_NODE) { const next = end ? node.lastChild : node.firstChild; if (!next) return null; node = next; }
      offset = end ? (node.textContent?.length ?? 0) : 0;
    }
    const entry = nodes.get(node);
    return entry && node.textContent === entry.text && offset >= 0 && offset <= entry.text.length ? { id: entry.id, offset } : null;
  };
  const selection = () => {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) { send("selection"); return; }
    const range = selected.getRangeAt(0);
    const start = endpoint(range.startContainer, range.startOffset, false); const end = endpoint(range.endContainer, range.endOffset, true);
    send("selection", start && end ? { start, end } : { unsupported: true });
  };
  document.addEventListener("DOMContentLoaded", () => {
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    for (let marker = walker.nextNode(); marker; marker = walker.nextNode()) {
      if (!marker.textContent?.startsWith(`mn-${config.token}:`)) continue;
      const id = Number(marker.textContent.slice(`mn-${config.token}:`.length)); const text = marker.nextSibling;
      if (text?.nodeType === Node.TEXT_NODE && text.textContent === config.texts[id]) nodes.set(text, { id, text: text.textContent! });
    }
    for (const element of document.querySelectorAll(`[${config.attribute}]`)) elements.set(Number(element.getAttribute(config.attribute)), element);
    loaded = true; send("ready");
  }, { once: true });
  document.addEventListener("pointerup", selection);
  document.addEventListener("keyup", selection);
  document.addEventListener("dblclick", event => {
    const element = event.target instanceof Element ? event.target.closest(`[${config.attribute}]`) : null;
    if (element && !element.closest("a, button, input, select, textarea")) send("navigate", { id: Number(element.getAttribute(config.attribute)) });
  });
  document.addEventListener("click", event => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    event.preventDefault(); send("link", { href });
  }, true);
  let flash: Element | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.channel !== config.token) return;
    if (event.data.kind === "ping" && loaded) send("ready");
    if (event.data.kind === "highlight") {
      const element = elements.get(event.data.id); if (!element?.isConnected) return;
      if (flash) flash.classList.remove(`mn-highlight-${config.token}`);
      clearTimeout(timer); flash = element; element.classList.add(`mn-highlight-${config.token}`);
      element.scrollIntoView({ block: "nearest", behavior: "smooth" });
      timer = setTimeout(() => element.classList.remove(`mn-highlight-${config.token}`), 1200);
    }
  });
}

/** Decode HTML character references and retain their source boundaries (UTF-16). */
export function htmlTextMap(raw: string): { text: string; starts: number[]; ends: number[] } {
  const decoder = document.createElement("textarea");
  let text = ""; const starts: number[] = []; const ends: number[] = [];
  for (let offset = 0; offset < raw.length;) {
    let consumed = 1; let value = raw[offset]!;
    if (value === "\r") { consumed = raw[offset + 1] === "\n" ? 2 : 1; value = "\n"; }
    else if (value === "\0") value = "\ufffd";
    else if (value === "&") {
      const candidate = /^&(?:#[xX][\da-fA-F]+;?|#\d+;?|[a-zA-Z][a-zA-Z0-9]*;?)/.exec(raw.slice(offset))?.[0];
      if (candidate) {
        decoder.innerHTML = candidate; const decoded = decoder.value;
        if (decoded !== candidate) {
          // A named reference without ';' can leave a literal suffix, e.g. &notit;.
          let suffix = 0;
          while (suffix < decoded.length && candidate[candidate.length - 1 - suffix] === decoded[decoded.length - 1 - suffix]) suffix++;
          consumed = candidate.length - suffix; value = decoded.slice(0, decoded.length - suffix);
        }
      }
    }
    text += value;
    for (let i = 0; i < value.length; i++) { starts.push(offset); ends.push(offset + consumed); }
    offset += consumed;
  }
  return { text, starts, ends };
}
