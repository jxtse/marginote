import { expect, it } from "vitest";
import { applyHtmlEdits, htmlAssetPath, htmlSource } from "../src/html-source.js";

it("maps repeated prose, entities and Unicode by grammar positions without altering raw-text elements", () => {
  const source = '<!doctype html><title>Repeated</title><style>p{color:red}</style><p>重复 &amp; café☕</p><p>重复 &amp; café☕</p><script>"<p>fake</p>"</script><textarea>private text</textarea>';
  const mapping = htmlSource(source, "token");
  expect(mapping.texts.map(text => text.raw)).toEqual(["重复 &amp; café☕", "重复 &amp; café☕"]);
  expect(mapping.texts[1]!.start).toBe(source.lastIndexOf("重复"));
  const rendered = applyHtmlEdits(source, mapping.edits);
  expect(rendered).toContain('"<p>fake</p>"</script>');
  expect(rendered).toContain('>private text</textarea>');
  expect(rendered).toContain("<!--mn-token:1-->重复 &amp; café☕");
  expect(mapping.attributes).toHaveLength(0);
});
it("handles quoted > characters, void tags, fragments and pre's first newline", () => {
  const source = '<img src="a>b.png"/><pre>\r\nFirst &lt; line</pre><p class=test>Tail';
  const mapping = htmlSource(source, "token");
  expect(mapping.attributes[0]!.value).toBe("a>b.png");
  expect(mapping.texts.map(text => text.raw)).toEqual(["First &lt; line", "Tail"]);
  expect(applyHtmlEdits(source, mapping.edits)).toContain('src="a>b.png" data-mn-token="0"/>');
  expect(applyHtmlEdits(source, mapping.edits)).toContain('>\r\n<!--mn-token:0-->First');
});
it("refuses overlapping transformations and invalid marker names", () => {
  expect(() => htmlSource("hello", '" onclick="bad')).toThrow();
  expect(() => applyHtmlEdits("abcdef", [{ start: 1, end: 4, text: "x" }, { start: 3, end: 6, text: "y" }])).toThrow(/Overlapping/);
});
it("does not inject text markers into attribute entities, and retains semicolon-free text references", () => {
  const source = '<p title="a &amp; b" style="font-family:&quot;serif&quot;">&#x1f600; &copy foo</p>';
  const mapping = htmlSource(source, "token");
  expect(mapping.texts.map(text => text.raw)).toEqual(["&#x1f600; &copy foo"]);
  expect(applyHtmlEdits(source, mapping.edits)).toContain('title="a &amp; b" style="font-family:&quot;serif&quot;"');
});
it("resolves relative project assets, including CSS parent references, without escaping the vault", () => {
  expect(htmlAssetPath("../images/a%20b.svg?v=2", "paper/css/theme.css")).toBe("paper/images/a b.svg");
  expect(htmlAssetPath("./app.js", "paper/report.html")).toBe("paper/app.js");
  for (const path of ["../../../secret.js", "%252e%252e/secret.js", "/etc/secret.js", "https://bad.test/x.js", "javascript:alert(1)", "../.marginote/agent.json", "node_modules/x.js", "x\\y.js"]) expect(htmlAssetPath(path, "report.html")).toBeNull();
});
