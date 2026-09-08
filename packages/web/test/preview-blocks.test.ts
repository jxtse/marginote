import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { blockAt, previewBlocks } from "../src/preview-blocks.js";

describe("preview source blocks", () => {
  it("measures original blocks before wikilink rewriting", () => {
    const chunks = ["# Heading\n\n", "A [[long target|label]] paragraph.\n\n", "```js\nconsole.log(1)\n```\n\n", "- one\n- two\n\n", "> quote\n\n", "```mermaid\ngraph TD; A-->B\n```\n\n", "| A | B |\n| - | - |\n| 1 | 2 |\n"];
    const source = chunks.join("");
    const blocks = previewBlocks(source, (raw) => raw.replace("[[long target|label]]", '<a href="#">label</a>'));
    expect(blocks).toHaveLength(chunks.length);
    let start = 0;
    for (const [index, chunk] of chunks.entries()) {
      expect(blocks[index]!.start).toBe(start);
      expect(source.slice(blocks[index]!.start, blocks[index]!.end).trim()).toBe(chunk.trim());
      start += chunk.length;
    }
    expect(blocks.map((block) => block.html.match(/^<\w+/)?.[0])).toEqual(["<h1", "<p", "<pre", "<ul", "<blockquote", "<pre", "<table"]);
    expect(blocks[1]!.html).toContain('<a href="#">label</a>');
  });

  it("preserves reference definitions and CRLF source coordinates", () => {
    const source = '[ref]: /target "Title"\r\n\r\n# Heading\r\n\r\nA [reference][ref].\r\n\r\n[other]: /other\r\n\r\nLast 😀 paragraph.\r\n';
    const blocks = previewBlocks(source, (raw) => raw);
    expect(blocks.map((block) => block.start)).toEqual([source.indexOf("# Heading"), source.indexOf("A [reference]"), source.indexOf("Last")]);
    expect(blocks[1]!.html).toContain('href="/target" title="Title"');
    expect(blocks.at(-1)!.end).toBe(source.length);
  });

  it("handles repeated blocks, leading whitespace, empty docs and cursor boundaries", () => {
    const source = "\n\nSame\n\nSame\n\n";
    const blocks = previewBlocks(source, (raw) => raw);
    expect(blocks.map((block) => block.start)).toEqual([2, 8]);
    expect(blockAt(blocks, 0)).toBe(blocks[0]);
    expect(blockAt(blocks, 7)).toBe(blocks[0]);
    expect(blockAt(blocks, 8)).toBe(blocks[1]);
    expect(blockAt(blocks, source.length)).toBe(blocks[1]);
    expect(blockAt([], 0)).toBeUndefined();
    expect(previewBlocks("\n\n", (raw) => raw)).toEqual([]);
  });

  it.each([
    "same\n    continuation\n---\n",
    "- first\n\n  continued\n\n- second\n\nAfter\n",
    "<div>First</div>\n<div>Second</div>\n\nAfter\n",
    '[ref]: /target\n  "Title"\n\n[ref]\n\n[ref]\n',
  ])("preserves full-document Markdown rendering: %s", (source) => {
    const html = previewBlocks(source, (raw) => raw).map((block) => block.html).join("");
    expect(html).toBe(marked.parse(source));
  });

  it("does not count synthetic lexer newlines as source characters", () => {
    const source = "same\n    continuation\n---\n";
    const blocks = previewBlocks(source, (raw) => raw);
    expect(blocks[0]!.end).toBe(source.indexOf("---"));
    expect(blocks[1]!.start).toBe(source.indexOf("---"));
    expect(blocks[1]!.end).toBe(source.length);
  });
});
