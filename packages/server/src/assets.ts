import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { isSafeDocPath } from "./security.js";

export class MediaError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_path", readonly log = "") {
    super(message);
  }
}

export const ASSET_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
};

export async function vaultFile(root: string, path: string, extensions: readonly string[]): Promise<string> {
  if (!isSafeDocPath(path) || path.includes("\\") || !extensions.includes(extname(path).toLowerCase())) {
    throw new MediaError("Expected a safe vault-relative path with a supported extension");
  }
  let current = await realpath(root);
  try {
    for (const segment of path.split("/")) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new MediaError("Symlink paths are not allowed");
    }
    if (!(await lstat(current)).isFile()) throw new MediaError("Expected a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MediaError("File not found", 404, "not_found");
    throw error;
  }
  return current;
}

const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

/**
 * Recheck a pathname after opening it. The inode comparison closes the gap between
 * component validation and open(2): if a parent directory was exchanged meanwhile,
 * either the resolved path leaves the vault or it no longer names the opened inode.
 */
export async function verifyOpenedVaultFile(file: FileHandle, candidate: string, canonicalRoot: string): Promise<Stats> {
  try {
    const [opened, resolved, named] = await Promise.all([file.stat(), realpath(candidate), lstat(candidate)]);
    if (!isInside(canonicalRoot, resolved) || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new MediaError("File changed during secure open; retry", 409, "file_changed");
    }
    return opened;
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError("File changed during secure open; retry", 409, "file_changed");
  }
}

async function readOpenFile(file: FileHandle, info: Stats, maxBytes: number): Promise<Buffer> {
    if (!info.isFile() || info.size > maxBytes) throw new MediaError("File exceeds the 64 MiB limit or is not regular", 413, "file_limit");
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new MediaError("File changed while being read; retry", 409, "file_changed");
    return buffer.subarray(0, length);
}

export async function readVaultFile(root: string, path: string, extensions: readonly string[], maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const canonicalRoot = await realpath(root);
  const candidate = await vaultFile(canonicalRoot, path, extensions);
  const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await readOpenFile(file, await verifyOpenedVaultFile(file, candidate, canonicalRoot), maxBytes);
  } finally { await file.close(); }
}

export async function readBoundedFile(path: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await readOpenFile(file, await file.stat(), maxBytes);
  } finally { await file.close(); }
}
