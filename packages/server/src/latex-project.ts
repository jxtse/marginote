import { posix } from "node:path";
import type { Vault } from "@marginote/bridge";
import { MediaError, readVaultFile } from "./assets.js";

export function texWithoutComments(text: string): string {
  return text.replace(/(?<!\\)%[^\n]*/g, "");
}

/** Resolve literal include paths, never expanding TeX commands or leaving the vault. */
export function texPath(from: string, target: string, extension = ".tex"): string {
  if (!target || /[\\\0{}]/.test(target) || posix.isAbsolute(target)) throw new MediaError("Invalid TeX project path");
  const path = posix.normalize(posix.join(posix.dirname(from), target));
  if (path === ".." || path.startsWith("../")) throw new MediaError("TeX project path leaves the vault");
  return posix.extname(path) ? path : `${path}${extension}`;
}

export async function resolveTexEntry(vault: Vault, doc: string, preferred?: string) {
  const paths = vault.list().filter(path => /\.tex$/i.test(path));
  if (paths.length > 1000) throw new MediaError("Too many TeX documents to resolve a main file", 413, "project_limit");
  const sources = new Map<string, string>();
  let bytes = 0;
  for (const path of paths) {
    const source = await readVaultFile(vault.root, path, [".tex"], 8 * 1024 * 1024);
    bytes += source.length;
    if (bytes > 32 * 1024 * 1024) throw new MediaError("TeX sources exceed the project discovery limit", 413, "project_limit");
    sources.set(path, source.toString("utf8"));
  }
  if (!sources.has(doc)) throw new MediaError("TeX document not found", 404, "not_found");
  const entries = paths.filter(path => /\\documentclass\b/.test(texWithoutComments(sources.get(path)!)));
  // TeX resolves ordinary input paths from the compilation directory, including nested inputs.
  const includes = (entry: string, file: string, seen = new Set<string>()): boolean => {
    if (file === doc) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    const text = texWithoutComments(sources.get(file) ?? "");
    for (const match of text.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
      try { if (includes(entry, texPath(entry, match[1]!), seen)) return true; } catch { /* computed paths need an explicit main file */ }
    }
    return false;
  };
  const declared = sources.get(doc)!.match(/^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im)?.[1];
  let entry: string | null = null;
  const linked = entries.filter(path => includes(path, path));
  const candidates = linked.length ? linked : entries.filter(path => doc.startsWith(posix.dirname(path) === "." ? "" : `${posix.dirname(path)}/`));
  if (preferred) {
    if (!entries.includes(preferred) || !(doc.startsWith(posix.dirname(preferred) === "." ? "" : `${posix.dirname(preferred)}/`))) {
      throw new MediaError("Selected main file does not contain this document's directory", 400, "invalid_entry");
    }
    entry = preferred;
  } else if (declared) {
    entry = texPath(doc, declared.trim());
    if (!entries.includes(entry)) throw new MediaError(`The declared main file ${entry} is missing or has no document class`, 422, "invalid_entry");
  } else if (entries.includes(doc)) entry = doc;
  else if (candidates.length === 1) entry = candidates[0]!;
  return { entry, candidates, sources };
}

export function texSymbols(sources: Record<string, string>) {
  const labels = new Set<string>();
  const citations = new Set<string>();
  for (const [path, source] of Object.entries(sources)) {
    if (/\.tex$/i.test(path)) for (const match of texWithoutComments(source).matchAll(/\\label\s*\{([^}]+)\}/g)) labels.add(match[1]!);
    if (/\.bib$/i.test(path)) for (const match of source.matchAll(/@(?!comment\b|string\b|preamble\b)[\w-]+\s*\{\s*([^,\s]+)\s*,/gi)) citations.add(match[1]!);
  }
  return { labels: [...labels].sort(), citations: [...citations].sort() };
}
