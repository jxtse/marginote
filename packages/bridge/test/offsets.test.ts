import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ATTR_SUGGEST_DELETE, ATTR_SUGGEST_INSERT, committedToFull, fullToCommitted } from "../src/attribution.js";

describe("committed/full navigation offsets", () => {
  it("skips leading, middle and trailing insertions but keeps suggested deletions", () => {
    const text = new Y.Doc().getText("content");
    text.insert(0, "XX", { [ATTR_SUGGEST_INSERT]: "leading" });
    text.insert(2, "ab", {});
    text.insert(4, "YYY", { [ATTR_SUGGEST_INSERT]: "middle" });
    text.insert(7, "cd", { [ATTR_SUGGEST_DELETE]: "deletion" });
    text.insert(9, "ZZ", { [ATTR_SUGGEST_INSERT]: "trailing" });
    expect([0, 1, 2, 3, 4].map((offset) => committedToFull(text, offset))).toEqual([2, 3, 7, 8, 9]);
    expect(Array.from({ length: 12 }, (_, offset) => fullToCommitted(text, offset))).toEqual([0, 0, 0, 1, 2, 2, 2, 2, 3, 4, 4, 4]);
    for (let offset = 0; offset <= 4; offset++) expect(fullToCommitted(text, committedToFull(text, offset))).toBe(offset);
    expect(committedToFull(text, -1)).toBe(2);
    expect(committedToFull(text, 100)).toBe(9);
    expect(fullToCommitted(text, -1)).toBe(0);
  });

  it("handles empty and entirely proposed documents and UTF-16 positions", () => {
    const text = new Y.Doc().getText("content");
    expect(committedToFull(text, 10)).toBe(0);
    expect(fullToCommitted(text, 10)).toBe(0);
    text.insert(0, "proposed", { [ATTR_SUGGEST_INSERT]: "only" });
    expect(committedToFull(text, 0)).toBe(0);
    expect(fullToCommitted(text, 4)).toBe(0);
    text.insert(text.length, "😀text", {});
    expect(committedToFull(text, 2)).toBe(10);
    expect(fullToCommitted(text, 10)).toBe(2);
  });
});
