export function documentMode(path: string): "stex" | "markdown" {
  return /\.tex$/i.test(path) ? "stex" : "markdown";
}

export function imageAssetUrl(reference: string, documentPath: string): string | null {
  if (/^(https?:|data:|\/\/|#)/i.test(reference)) return reference;
  let decoded = reference;
  try {
    for (let depth = 0; depth < 8; depth++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch { return null; }
  if (/^[a-z][a-z\d+.-]*:|^\/|\\|[\u0000-\u001f\u007f]/i.test(decoded)) return null;
  const hashAt = reference.indexOf("#");
  const hash = hashAt < 0 ? "" : reference.slice(hashAt);
  const file = decoded.split(/[?#]/)[0]!.replace(/^(\.\/)+/, "");
  if (file.includes("%") || file.split("/").some((part) => ["..", ".", "", ".git", ".marginote", "node_modules"].includes(part))) return null;
  if (!/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(file)) return null;
  const directory = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/") + 1) : "";
  return `/api/assets?path=${encodeURIComponent(directory + file)}${hash}`;
}

/**
 * Rewrite each `srcset` candidate ("url [descriptor]") through the same resolver used
 * for `src`. Unsafe candidates are dropped rather than the whole attribute so
 * responsive raw-HTML images keep working. URLs cannot contain commas here unless
 * percent-encoded, so splitting on comma+whitespace follows the HTML srcset grammar.
 */
export function rewriteSrcset(srcset: string, documentPath: string): string {
  const candidates: string[] = [];
  for (const candidate of srcset.split(/,\s+|,(?=\S*\s)/)) {
    const [url, ...descriptor] = candidate.trim().split(/\s+/);
    if (!url) continue;
    const resolved = imageAssetUrl(url, documentPath);
    if (!resolved) continue;
    if (descriptor.length && !descriptor.every((part) => /^\d+(\.\d+)?[wx]$/.test(part))) continue;
    candidates.push([resolved, ...descriptor].join(" "));
  }
  return candidates.join(", ");
}
