import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultVault } from "../bin/default-vault.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "marginote-default-vault-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("default vault", () => {
  it("creates the default directory and welcome exactly once", async () => {
    const root = await defaultVault(home);
    expect(root).toBe(join(home, "Documents", "Marginote"));
    const welcome = join(root, "welcome.md");
    expect(await readFile(welcome, "utf8")).toContain("Grill me");
    await writeFile(welcome, "My writing");
    await defaultVault(home);
    expect(await readFile(welcome, "utf8")).toBe("My writing");
    await rm(welcome);
    await defaultVault(home);
    expect(await readdir(root)).toEqual([]);
  });
  it("does not seed an existing empty folder", async () => {
    const root = join(home, "Documents", "Marginote");
    await mkdir(root, { recursive: true });
    await defaultVault(home);
    expect(await readdir(root)).toEqual([]);
  });
  it("concurrent first launches do not overwrite or duplicate the welcome", async () => {
    const roots = await Promise.all([defaultVault(home), defaultVault(home)]);
    expect(roots[0]).toBe(roots[1]);
    expect(await readdir(roots[0]!)).toEqual(["welcome.md"]);
  });
});
