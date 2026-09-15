import { expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { texCompletions } from "../src/latex-editor.js";

function complete(source: string) {
  return texCompletions(new CompletionContext(EditorState.create({ doc: source }), source.length, true), { labels: ["sec:intro"], citations: ["smith2020", "jones2021"] });
}
it("completes citation lists, local labels, environments and commands", () => {
  const citation = complete("\\cite{smith2020, jon")!;
  expect(citation.from).toBe("\\cite{smith2020, ".length);
  expect(citation.options).toContainEqual({ label: "jones2021", type: "variable" });
  expect(complete("\\label{new}\n\\ref{")!.options).toContainEqual({ label: "new", type: "variable" });
  expect(complete("\\begin{eq")!.options).toContainEqual({ label: "equation", type: "variable" });
  expect(complete("\\sec")!.options).toContainEqual({ label: "section", type: "keyword" });
  expect(complete("% \\sec")).toBeNull();
  expect(complete("ordinary prose")).toBeNull();
});
