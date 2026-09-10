import { expect, it } from "vitest";
import { imageAssetUrl, documentMode, rewriteSrcset } from "../src/media.js";
import { documentLanguage, stex } from "../src/document-language.js";
import { StringStream } from "@codemirror/language";

it("selects TeX and Markdown modes", () => {
  expect(documentMode("paper/main.tex")).toBe("stex");
  expect(documentMode("MAIN.TEX")).toBe("stex");
  expect(documentMode("note.md")).toBe("markdown");
  expect(documentMode("note.markdown")).toBe("markdown");
  expect(documentLanguage("main.tex")).toMatchObject({ name: "stex" });
  expect(documentLanguage("note.md")).toHaveProperty("language");
});
it("tokenizes TeX commands, comments and math without Markdown semantics", () => {
  const state = stex.startState!(2);
  expect(stex.token(new StringStream("\\section", 2, 2), state)).toBe("keyword");
  expect(stex.token(new StringStream("% comment", 2, 2), state)).toBe("comment");
  expect(stex.token(new StringStream("$", 2, 2), state)).toBe("keyword");
  expect(state.math).toBe(true);
});
it("resolves images against the document, preserving URL suffixes", () => {
  expect(imageAssetUrl("figures/a%20b.png", "paper/main.md")).toBe("/api/assets?path=paper%2Ffigures%2Fa%20b.png");
  expect(imageAssetUrl("./figure.pdf#page=2", "paper/main.md")).toBe("/api/assets?path=paper%2Ffigure.pdf#page=2");
});
it.each(["https://example.com/a.png", "http://example.com/a.png", "//example.com/a.png", "#figure", "data:image/png;base64,AAAA"])("preserves external or inline reference %s", (reference) => {
  expect(imageAssetUrl(reference, "paper/main.md")).toBe(reference);
});
it.each(["../a.png", "%2e%2e/a.png", "%252e%252e/a.png", "/a.png", "javascript:alert(1)", "figure.html", "a\\b.png"])("rejects unsafe reference %s", (reference) => {
  expect(imageAssetUrl(reference, "paper/main.md")).toBeNull();
});
it("rewrites responsive srcset candidates through the asset API and drops unsafe ones", () => {
  expect(rewriteSrcset("small.png 1x, big.png 2x", "paper/main.md")).toBe("/api/assets?path=paper%2Fsmall.png 1x, /api/assets?path=paper%2Fbig.png 2x");
  expect(rewriteSrcset("https://cdn.example/a.png 480w, ./b.webp 960w", "paper/main.md")).toBe("https://cdn.example/a.png 480w, /api/assets?path=paper%2Fb.webp 960w");
  expect(rewriteSrcset("../secret.png 1x, javascript:alert(1) 2x", "paper/main.md")).toBe("");
  expect(rewriteSrcset("../secret.png 1x, ok.png 2x", "paper/main.md")).toBe("/api/assets?path=paper%2Fok.png 2x");
  // HTML srcset grammar: a comma with no following whitespace is part of the URL, and
  // a data: URL may legitimately contain commas.
  expect(rewriteSrcset("a.png,b.png", "paper/main.md")).toBe("/api/assets?path=paper%2Fa.png%2Cb.png");
  expect(rewriteSrcset("data:image/png;base64,AAAA 1x, b.png 2x", "paper/main.md")).toBe("data:image/png;base64,AAAA 1x, /api/assets?path=paper%2Fb.png 2x");
  expect(rewriteSrcset("a.png 1x,b.png 2x", "paper/main.md")).toBe("/api/assets?path=paper%2Fa.png 1x, /api/assets?path=paper%2Fb.png 2x");
  // WHATWG descriptor grammar: density is any valid float, width a positive integer; a
  // candidate may not mix them or repeat; a stray parenthesis only swallows to ")".
  expect(rewriteSrcset("a.png .5x, b.png 1e2x", "paper/main.md")).toBe("/api/assets?path=paper%2Fa.png .5x, /api/assets?path=paper%2Fb.png 1e2x");
  expect(rewriteSrcset("a.png 1w 2x, b.png 2x", "paper/main.md")).toBe("/api/assets?path=paper%2Fb.png 2x");
  expect(rewriteSrcset("a.png 0w, b.png 2x", "paper/main.md")).toBe("/api/assets?path=paper%2Fb.png 2x");
  expect(rewriteSrcset("a.png ((x), b.png 2x", "paper/main.md")).toBe("/api/assets?path=paper%2Fb.png 2x");
});
