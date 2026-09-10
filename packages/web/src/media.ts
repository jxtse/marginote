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
 * Rewrite each `srcset` candidate through the same resolver used for `src`, following
 * the HTML srcset tokenizer: a URL runs to the next whitespace, a trailing comma on the
 * URL ends the candidate without descriptors, otherwise descriptors run to the next
 * comma. This keeps commas inside `data:` URLs and bare `a.png,b.png` intact. Unsafe
 * candidates are dropped individually so responsive raw-HTML images keep working.
 */
export function rewriteSrcset(srcset: string, documentPath: string): string {
  const candidates: string[] = [];
  let position = 0;
  while (position < srcset.length) {
    while (position < srcset.length && /[\s,]/.test(srcset[position]!)) position++;
    if (position >= srcset.length) break;
    const urlStart = position;
    while (position < srcset.length && !/\s/.test(srcset[position]!)) position++;
    let url = srcset.slice(urlStart, position);
    let descriptors: string[] = [];
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      const descriptorStart = position;
      let depth = 0;
      while (position < srcset.length) {
        const character = srcset[position]!;
        if (character === "(") depth++;
        else if (character === ")") depth = Math.max(0, depth - 1);
        else if (character === "," && depth === 0) break;
        position++;
      }
      descriptors = srcset.slice(descriptorStart, position).trim().split(/\s+/).filter(Boolean);
    }
    if (!url) continue;
    const resolved = imageAssetUrl(url, documentPath);
    if (!resolved) continue;
    if (!descriptors.every((part) => /^\d+(\.\d+)?[wx]$/.test(part))) continue;
    candidates.push([resolved, ...descriptors].join(" "));
  }
  return candidates.join(", ");
}
