import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { lintGutter } from "@codemirror/lint";

export interface TexSymbols { labels: string[]; citations: string[] }
const commands = ["begin", "end", "section", "subsection", "subsubsection", "paragraph", "textbf", "textit", "emph", "label", "ref", "eqref", "cite", "citep", "citet", "input", "include", "includegraphics", "caption", "footnote", "item", "frac", "sqrt", "sum", "alpha", "beta", "gamma", "delta", "theta", "lambda", "mu", "sigma", "omega"];
const environments = ["document", "equation", "align", "gather", "figure", "table", "tabular", "itemize", "enumerate", "abstract", "proof", "theorem", "verbatim"];

export function texCompletions(context: CompletionContext, symbols: TexSymbols) {
  const before = context.state.doc.sliceString(context.state.doc.lineAt(context.pos).from, context.pos);
  if (/(?<!\\)%/.test(before)) return null;
  const argument = before.match(/\\(cite\w*|(?:eq|auto|page|c|C)?ref|label|begin|end)(?:\[[^\]]*\])*\{([^{}]*)$/);
  if (argument) {
    const command = argument[1]!;
    const values = command.startsWith("cite") ? symbols.citations : ["begin", "end"].includes(command) ? environments : [...new Set([...symbols.labels, ...[...context.state.doc.toString().matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1]!)])];
    const word = argument[2]!.split(",").pop()!.trimStart();
    return { from: context.pos - word.length, options: values.map(label => ({ label, type: "variable" })), validFor: /^[\w:./-]*$/ };
  }
  const word = context.matchBefore(/\\[a-zA-Z]*/);
  return word ? { from: word.from + 1, options: commands.map(label => ({ label, type: "keyword" })), validFor: /^[a-zA-Z]*$/ } : null;
}

export function latexExtensions(symbols: () => TexSymbols) {
  return [autocompletion({ override: [context => texCompletions(context, symbols())] }), lintGutter()];
}
