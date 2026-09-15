import { isAbsolute, posix, relative, resolve } from "node:path";

export interface TexLocation { file: string; line: number; page: number; x: number; y: number; width: number; height: number }

/** Bounded line-box index for Tectonic's SyncTeX v1 output; coordinates are PDF points.
 * Only source files from the actual compile snapshot can enter the index.
 * Unsupported versions/post-processing transforms disable navigation, not compilation.
 * Format reference: https://github.com/TeX-Live/texlive-source/tree/trunk/texk/web2c/synctexdir
 */
export function parseSyncTex(text: string, root: string, prefix: string, files: Set<string>): TexLocation[] {
  if (!text.startsWith("SyncTeX Version:1\n") || text.split("Post scriptum:")[1]?.trim()) return [];
  const header = (name: string, fallback: number) => Number(text.match(new RegExp(`^${name}:(-?[\\d.]+)$`, "m"))?.[1] ?? fallback);
  const unit = header("Unit", 1) / 65536 * 72 / 72.27;
  const scale = unit * header("Magnification", 1000) / 1000;
  if (!Number.isFinite(scale) || scale <= 0) return [];
  const ox = header("X Offset", 0) * unit;
  const oy = header("Y Offset", 0) * unit;
  const inputs = new Map<number, string>();
  for (const match of text.matchAll(/^Input:(\d+):(.+)$/gm)) {
    const path = relative(root, resolve(root, match[2]!)).replaceAll("\\", "/");
    if (isAbsolute(path) || path.startsWith("../") || !files.has(path) || !/\.tex$/i.test(path)) continue;
    inputs.set(Number(match[1]), posix.join(prefix, path));
  }
  const locations: TexLocation[] = [];
  let page = 0;
  for (const record of text.split("\n")) {
    if (record.startsWith("{")) { page = Number(record.slice(1)); continue; }
    const point = record.match(/^[xg$]\s*(\d+),(\d+)(?:,-?\d+)?:\s*(-?\d+),(-?\d+)/);
    if (point && Number.isSafeInteger(page) && page > 0 && page < 100_000) {
      const file = inputs.get(Number(point[1]));
      const line = Number(point[2]); const x = Number(point[3]) * scale + ox; const y = Number(point[4]) * scale + oy - 10;
      if (file && Number.isSafeInteger(line) && line > 0 && line < 1e7 && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e7 && Math.abs(y) < 1e7) locations.push({ file, line, page, x, y, width: 2, height: 12 });
      if (locations.length >= 50_000) break;
      continue;
    }
    // Horizontal line boxes and void horizontal boxes carry source lines and dimensions.
    const m = record.match(/^[\(h]\s*(\d+),(\d+)(?:,-?\d+)?:\s*(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)/);
    if (!m || !Number.isSafeInteger(page) || page < 1) continue;
    const file = inputs.get(Number(m[1]));
    if (!file) continue;
    const [, , line, h, v, w, height, depth] = m;
    const location = { file, line: Number(line), page, x: Number(h) * scale + ox, y: (Number(v) - Number(height)) * scale + oy, width: Math.abs(Number(w) * scale), height: Math.max(1, (Number(height) + Number(depth)) * scale) };
    if (location.line < 1 || Object.values(location).some(value => typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 1e7))) continue;
    locations.push(location);
    if (locations.length >= 50_000) break;
  }
  return locations;
}

export function texDiagnostics(log: string, entry: string, files: string[]) {
  const diagnostics: Array<{ file: string; line: number; message: string }> = [];
  for (const match of log.matchAll(/^(?:error:\s*)?(.+?\.tex):(\d+):\s*(.+)$/gm)) {
    const file = files.find(path => path === match[1] || path === posix.join(posix.dirname(entry), match[1]!) || match[1]!.endsWith(`/${path}`));
    if (file) diagnostics.push({ file, line: Number(match[2]), message: match[3]!.slice(0, 1000) });
    if (diagnostics.length >= 100) break;
  }
  return diagnostics;
}
