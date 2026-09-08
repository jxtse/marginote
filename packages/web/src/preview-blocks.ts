import { Lexer, marked, Tokenizer } from "marked";

export interface SourceBlock {
  start: number;
  end: number;
  html: string;
}

export function previewBlocks(source: string, rewrite: (raw: string) => string): SourceBlock[] {
  const offsets = [0];
  const normalized = source.replace(/\r\n|\r|[^\r]/g, (chunk, index: number) => {
    offsets.push(index + chunk.length);
    return chunk.startsWith("\r") ? "\n" : chunk;
  });
  const tokenizer = new Tokenizer();
  const tokens = marked.lexer(normalized, { ...marked.defaults, tokenizer });
  let cursor = 0;
  const blocks: SourceBlock[] = [];
  for (const token of tokens) {
    // Marked omits reference definitions; consume those gaps before summing raw lengths.
    // CRLF is normalized by marked, so offsets map back to the original UTF-16 source.
    while (cursor < normalized.length) {
      const definition = tokenizer.def(normalized.slice(cursor));
      if (definition) cursor += definition.raw.length;
      else if (normalized[cursor] === token.raw[0]) break;
      else if (/\s/.test(normalized[cursor]!)) cursor++;
      else throw new Error("Cannot map Markdown block to source");
    }
    const start = cursor;
    // Marked can synthesize a newline when folding indented code into a paragraph.
    // Count only raw characters actually present in the source in that edge case.
    if (normalized.startsWith(token.raw, cursor)) cursor += token.raw.length;
    else {
      for (const character of token.raw.split("")) {
        if (normalized[cursor] === character) cursor++;
        else if (character !== "\n") throw new Error("Cannot map Markdown token to source");
      }
    }
    if (token.type === "space") continue;
    // Rewrite only after measuring the original block. Share definitions so references
    // still resolve across blocks, and leave each list intact as a single token.
    const raw = normalized.slice(start, cursor);
    const rewritten = rewrite(raw);
    const lexer = new Lexer({ ...marked.defaults, tokenizer: new Tokenizer() });
    lexer.tokens.links = tokens.links;
    const html = marked.parser(rewritten === raw ? [token] : lexer.lex(rewritten), { async: false });
    if (html.trim()) blocks.push({ start: offsets[start]!, end: offsets[cursor]!, html });
  }
  return blocks;
}

export function blockAt<T extends { start: number; end: number }>(blocks: readonly T[], offset: number): T | undefined {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (blocks[middle]!.start <= offset) low = middle + 1;
    else high = middle;
  }
  // Blank lines and EOF belong to the preceding rendered block.
  return blocks[Math.max(0, low - 1)];
}
