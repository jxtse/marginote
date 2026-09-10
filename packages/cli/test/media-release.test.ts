import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("packages LaTeX runtime setup instructions with the release", () => {
  const packageInfo = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(packageInfo.files).toContain("docs/");
  const build = readFileSync(new URL("../../../scripts/build-release.mjs", import.meta.url), "utf8");
  expect(build).toContain('"docs/latex-and-images.md"');
});
