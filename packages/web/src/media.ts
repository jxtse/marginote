export function documentMode(path: string): "stex" | "markdown" | "html" {
  return /\.tex$/i.test(path) ? "stex" : /\.html?$/i.test(path) ? "html" : "markdown";
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
 * the WHATWG srcset parsing algorithm: a URL runs to the next ASCII whitespace, a
 * trailing comma on the URL ends the candidate without descriptors, otherwise
 * descriptors run to the next comma (an open parenthesis swallows through the next ")"
 * only, no nesting). Descriptors must be exactly one valid width ("<positive int>w")
 * or density ("<float>x"); mixed, repeated, or malformed descriptors drop that
 * candidate. This keeps commas inside `data:` URLs and bare `a.png,b.png` intact.
 * Unsafe candidates are dropped individually so responsive raw-HTML images keep working.
 */
const ASCII_WHITESPACE = /[\t\n\f\r ]/;
const ASCII_WHITESPACE_RUN = /[\t\n\f\r ]+/;
const ASCII_TRIM = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;
// Width: valid non-negative integer > 0 (leading zeros allowed by the integer grammar).
const WIDTH_DESCRIPTOR = /^\d+w$/;
// Density: valid floating-point number (optional "-", digits with optional fraction or
// ".digits", optional exponent with "e" or "E") followed by lowercase "x"; "1." has no
// fraction digits so it is invalid, and the "x" suffix is case-sensitive. A negative
// value is rejected afterwards (spec: density < 0 is an error), so "-0x" parses and
// passes while "-1x" is dropped.
const DENSITY_DESCRIPTOR = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?x$/;
// Future-compat height descriptor: only meaningful next to a width descriptor.
const HEIGHT_DESCRIPTOR = /^\d+h$/;

/** WHATWG "parse a srcset attribute" descriptor validation for one candidate. */
function validDescriptors(descriptors: string[]): boolean {
  let width = false;
  let density = false;
  let height = false;
  for (const descriptor of descriptors) {
    if (WIDTH_DESCRIPTOR.test(descriptor) && !width && !density && Number.parseInt(descriptor, 10) > 0) width = true;
    else if (DENSITY_DESCRIPTOR.test(descriptor) && !density && !width && !height && Number.parseFloat(descriptor) >= 0) density = true;
    else if (HEIGHT_DESCRIPTOR.test(descriptor) && !height && !density && Number.parseInt(descriptor, 10) > 0) height = true;
    else return false;
  }
  return !(height && !width);
}

export function rewriteSrcset(srcset: string, documentPath: string, resolve = imageAssetUrl): string {
  const candidates: string[] = [];
  let position = 0;
  while (position < srcset.length) {
    while (position < srcset.length && (ASCII_WHITESPACE.test(srcset[position]!) || srcset[position] === ",")) position++;
    if (position >= srcset.length) break;
    const urlStart = position;
    while (position < srcset.length && !ASCII_WHITESPACE.test(srcset[position]!)) position++;
    let url = srcset.slice(urlStart, position);
    let descriptors: string[] = [];
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      const descriptorStart = position;
      let inParens = false;
      while (position < srcset.length) {
        const character = srcset[position]!;
        if (inParens) { if (character === ")") inParens = false; }
        else if (character === "(") inParens = true;
        else if (character === ",") break;
        position++;
      }
      descriptors = srcset.slice(descriptorStart, position).replace(ASCII_TRIM, "").split(ASCII_WHITESPACE_RUN).filter(Boolean);
    }
    if (!url) continue;
    const resolved = resolve(url, documentPath);
    if (!resolved) continue;
    if (!validDescriptors(descriptors)) continue;
    candidates.push([resolved, ...descriptors].join(" "));
  }
  return candidates.join(", ");
}
