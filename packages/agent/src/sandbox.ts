import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Vault } from "@marginote/bridge";

export function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function documentPath(root: string, path: string): Promise<string> {
  if (!path || path.includes("\\") || /[\u0000-\u001f%]/.test(path) || isAbsolute(path) || path.split("/").some(part => ["", ".", "..", ".git", "node_modules", ".marginote"].includes(part))) throw new Error("Unsafe document path");
  const base = await realpath(root);
  const target = await realpath(resolve(base, path));
  if (!inside(base, target) || relative(base, target).split(sep).some(part => [".marginote", ".git", "node_modules"].includes(part))) throw new Error("Path escapes vault");
  return target;
}

async function noSymlinks(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Image symlinks are not allowed");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpath(path);
}

export function imageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("Only PNG, JPEG, WebP and GIF images are allowed");
}

export async function readImage(vault: Vault, currentPath: string, path: string): Promise<{ type: "image"; data: string; mimeType: string }> {
  if (!path || /[\u0000-\u001f]/.test(path)) throw new Error("Invalid image path");
  const root = await realpath(vault.root);
  const target = resolve(root, dirname(currentPath), path);
  const canonical = await realpath(target);
  if (inside(root, canonical)) {
    await documentPath(root, relative(root, target));
  } else {
    let referenced = false;
    for (const document of vault.list()) {
      await documentPath(root, document);
      for (const match of vault.getDoc(document).getContent().matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) {
        const link = match[1] ?? match[2]!;
        if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue;
        const linked = resolve(root, dirname(document), decodeURIComponent(link));
        if (linked === target && await noSymlinks(linked) === canonical) referenced = true;
      }
    }
    if (!referenced) throw new Error("Outside image is not directly referenced by a vault document");
  }
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error("Image exceeds 5 MB or is not a file");
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 5 * 1024 * 1024) throw new Error("Image exceeds 5 MB");
    const data = bytes.subarray(0, length);
    return { type: "image", data: data.toString("base64"), mimeType: imageMime(data) };
  } finally { await file.close(); }
}
