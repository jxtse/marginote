import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { documentMode } from "./media.js";

interface TexState { math: boolean; verbatim: boolean }
export const stex: StreamParser<TexState> = {
  name: "stex",
  startState: () => ({ math: false, verbatim: false }),
  token(stream, state) {
    if (state.verbatim) {
      if (stream.match(/\\end\{(?:verbatim\*?|lstlisting|minted)\}/)) { state.verbatim = false; return "keyword"; }
      stream.next();
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/%.*/)) return "comment";
    if (stream.match(/\\begin\{(?:verbatim\*?|lstlisting|minted)\}/)) { state.verbatim = true; return "keyword"; }
    if (stream.match(/\\verb\*?/)) {
      const delimiter = stream.next();
      if (delimiter) { while (!stream.eol() && stream.next() !== delimiter) {} }
      return "string";
    }
    if (stream.match(/\\[\[(]/)) { state.math = true; return "keyword"; }
    if (stream.match(/\\[\])]/)) { state.math = false; return "keyword"; }
    if (stream.match(/\\[a-zA-Z@]+\*?|\\./)) return "keyword";
    if (stream.match(/\$\$?/)) { state.math = !state.math; return "keyword"; }
    if (stream.match(/[{}\[\]]/)) return "bracket";
    if (stream.match(/#[1-9]/)) return "variableName";
    if (stream.match(/[&_^]/)) return "operator";
    if (state.math && stream.match(/\d+(?:\.\d+)?/)) return "number";
    stream.next();
    return state.math ? "string" : null;
  },
  languageData: { commentTokens: { line: "%" }, closeBrackets: { brackets: ["(", "[", "{"] } },
};
const latexLanguage = StreamLanguage.define(stex);
export function documentLanguage(path: string) {
  return documentMode(path) === "stex" ? latexLanguage : documentMode(path) === "html" ? html() : markdown();
}
