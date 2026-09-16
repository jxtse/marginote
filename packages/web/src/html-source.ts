import { parser } from "@lezer/html";
import type { SyntaxNode } from "@lezer/common";

export interface HtmlText { start: number; end: number; raw: string }
export interface HtmlElement { start: number; end: number }
export interface HtmlAttribute { start: number; end: number; tag: string; name: string; value: string }
export interface HtmlSource {
  texts: HtmlText[];
  elements: HtmlElement[];
  attributes: HtmlAttribute[];
  styles: Array<{ start: number; end: number }>;
  edits: Array<{ start: number; end: number; text: string }>;
}
const rawText = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript", "template"]);
const tagName = (node: SyntaxNode, source: string): string => {
  const name = node.getChild("TagName"); return name ? source.slice(name.from, name.to).toLowerCase() : "";
};

/** Source locations come from the HTML grammar, never from searching repeated prose. */
export function htmlSource(source: string, token: string): HtmlSource {
  if (!/^[a-z0-9]+$/.test(token)) throw new Error("Invalid HTML preview token");
  const result: HtmlSource = { texts: [], elements: [], attributes: [], styles: [], edits: [] };
  const tree = parser.parse(source);
  tree.iterate({ enter(cursor) {
    const node = cursor.node;
    if (node.name === "OpenTag" || node.name === "SelfClosingTag") {
      const name = tagName(node, source); const endTag = node.getChild("EndTag");
      if (endTag && name) {
        const id = result.elements.length;
        result.elements.push({ start: node.from, end: node.parent?.to ?? node.to });
        result.edits.push({ start: endTag.from, end: endTag.from, text: ` data-mn-${token}="${id}"` });
      }
      for (const attr of node.getChildren("Attribute")) {
        const key = attr.getChild("AttributeName"); const value = attr.getChild("AttributeValue");
        if (!key || !value) continue;
        const raw = source.slice(value.from, value.to);
        result.attributes.push({ start: value.from, end: value.to, tag: name, name: source.slice(key.from, key.to).toLowerCase(), value: /^["']/.test(raw) ? raw.slice(1, raw.endsWith(raw[0]!) ? -1 : undefined) : raw });
      }
    }
    if (node.name === "StyleText") result.styles.push({ start: node.from, end: node.to });
    if (!["Text", "EntityReference", "CharacterReference", "InvalidEntity"].includes(node.name)) return;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (["Attribute", "AttributeValue", "OpenTag", "SelfClosingTag", "CloseTag"].includes(ancestor.name)) return;
      const open = ancestor.getChild("OpenTag");
      if (open && rawText.has(tagName(open, source))) return;
    }
    const previous = result.texts.at(-1);
    if (previous && previous.end === node.from) { previous.end = node.to; previous.raw = source.slice(previous.start, node.to); return; }
    let start = node.from;
    const parentTag = node.parent?.getChild("OpenTag");
    if (parentTag && tagName(parentTag, source) === "pre" && parentTag.to === start) {
      // A marker before <pre>'s first newline would change HTML's newline stripping.
      if (source.slice(start, start + 2) === "\r\n") start += 2;
      else if (/\r|\n/.test(source[start] ?? "")) start++;
    }
    if (start === node.to) return;
    result.texts.push({ start, end: node.to, raw: source.slice(start, node.to) });
  } });
  result.texts.forEach((text, id) => result.edits.push({ start: text.start, end: text.start, text: `<!--mn-${token}:${id}-->` }));
  return result;
}

export function applyHtmlEdits(source: string, edits: HtmlSource["edits"]): string {
  let end = source.length; const pieces: string[] = [];
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.start < 0 || edit.end > end || edit.end < edit.start) throw new Error("Overlapping HTML transformations");
    pieces.push(source.slice(edit.end, end), edit.text); end = edit.start;
  }
  pieces.push(source.slice(0, end)); return pieces.reverse().join("");
}

/** Resolve ordinary relative web assets while keeping every request inside the vault. */
export function htmlAssetPath(reference: string, documentPath: string): string | null {
  let decoded = reference.trim();
  try { for (let i = 0; i < 8; i++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } } catch { return null; }
  if (/^[a-z][a-z\d+.-]*:|^[/#]|\\|[%\u0000-\u001f\u007f]/i.test(decoded)) return null;
  const parts = documentPath.split("/").slice(0, -1);
  for (const part of decoded.split(/[?#]/)[0]!.split("/")) {
    if (part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else { if (!part || [".git", ".marginote", "node_modules"].includes(part)) return null; parts.push(part); }
  }
  const path = parts.join("/");
  return /\.(css|m?js|png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i.test(path) ? path : null;
}
