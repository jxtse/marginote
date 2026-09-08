import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function boot(home: string, children: ChildProcess[]): Promise<string> {
  const child = spawn(process.execPath, ["packages/cli/bin/marginote.js", "--port", "0", "--no-discover", "--no-persist"], {
    env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`CLI boot timed out: ${output}`)), 20000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`CLI exited ${code}: ${output}`)); });
    child.stderr!.on("data", data => { output += data; });
    child.stdout!.on("data", data => {
      output += data;
      const url = /local\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (url) { clearTimeout(timeout); resolve(url); }
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

test("CLI default vault seeds once and never reseeds an existing folder", async ({ request }) => {
  test.skip(process.platform === "win32", "This isolated-home harness uses POSIX HOME");
  const home = await mkdtemp(join(tmpdir(), "marginote-first-run-"));
  const children: ChildProcess[] = [];
  const vault = join(home, "Documents", "Marginote");
  try {
    const url = await boot(home, children);
    const response = await request.get(`${url}/api/files`);
    expect((await response.json()).files).toEqual(["welcome.md"]);
    const welcome = join(vault, "welcome.md");
    expect(await readFile(welcome, "utf8")).toContain("Grill me");
    await stop(children[0]!);
    await writeFile(welcome, "# My own welcome\n");
    await boot(home, children);
    expect(await readFile(welcome, "utf8")).toBe("# My own welcome\n");
    await stop(children[1]!);
    await rm(vault, { recursive: true });
    await mkdir(vault);
    await boot(home, children);
    expect((await readdir(vault)).filter(name => name.endsWith(".md"))).toEqual([]);
  } finally {
    await Promise.all(children.map(stop));
    await rm(home, { recursive: true, force: true });
  }
});
