import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyOpenedVaultFile } from "../src/assets.js";

it("rejects an opened handle when the checked vault path no longer names that inode", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "marginote-asset-race-root-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "marginote-asset-race-outside-")));
  const candidate = join(root, "figure.png");
  const external = join(outside, "figure.png");
  await writeFile(candidate, "inside");
  await writeFile(external, "outside");
  const handle = await open(external, "r");
  try {
    await expect(verifyOpenedVaultFile(handle, candidate, root)).rejects.toMatchObject({ code: "file_changed", status: 409 });
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
