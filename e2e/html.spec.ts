import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MarginoteServer } from "../packages/server/src/server.js";
import { CommentStore } from "@marginote/bridge";

test("HTML preserves styles and scripts, maps a rendered selection, and continues its artifact conversation", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "marginote-html-")); let server: MarginoteServer | undefined;
  const prompts: string[] = [];
  try {
    await mkdir(join(root, "paper/css"), { recursive: true }); await mkdir(join(root, "paper/images"));
    await writeFile(join(root, "paper/css/theme.css"), 'p{color:rgb(17,68,119)} .figure{width:80px;height:40px;background-image:url("../images/figure.svg")}');
    await writeFile(join(root, "paper/images/figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>');
    await writeFile(join(root, "paper/app.js"), 'document.getElementById("external-script").textContent="Local script loaded";');
    const source = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HTML report</title><link rel="stylesheet" href="css/theme.css"><style>body{font:18px Georgia;padding:24px}h1{font:28px system-ui}</style></head><body>
<h1>HTML report</h1><p id="first" title="one &amp; two">重复 &amp; café☕</p><p id="second">重复 &amp; café☕</p>
<div class="figure"></div><img id="figure" src="images/figure.svg"><p id="external-script"></p>
<button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button>
<p id="dynamic">Original dynamic text</p><button id="change" onclick="document.getElementById('dynamic').textContent='Generated text'">Change</button>
<button id="escape" onclick="location.href='https://blocked.invalid/capture?data=private'">Test navigation</button>
<script>window.parentBlocked=false;try{parent.document.body.dataset.escaped='yes'}catch{window.parentBlocked=true}fetch('/api/agent/config').then(()=>window.apiBlocked=false).catch(()=>window.apiBlocked=true);</script>
<script src="app.js"></script></body></html>`;
    await writeFile(join(root, "paper/report.html"), source);
    await writeFile(join(root, "note.md"), "# Markdown remains available\n");
    server = await MarginoteServer.start({ root, port: 0, git: false, webRoot: resolve("packages/web/dist"), conversationProvider: {
      fork: async () => "html-child", prompt: async (session, text) => { expect(session).toBe("html-child"); prompts.push(text); return prompts.length === 1 ? "HTML comment understood." : "HTML follow-up understood."; },
    } });
    let externalRequests = 0;
    await page.route("https://blocked.invalid/**", route => { externalRequests++; return route.abort(); });
    await page.goto(`http://127.0.0.1:${server.port}/?doc=paper/report.html&origin-session=parent&origin-turn=delivery`);
    await expect(page.getByText("live", { exact: true })).toBeVisible();
    const frame = page.frameLocator('iframe[title="HTML document preview"]');
    await expect(frame.locator("h1")).toHaveText("HTML report");
    await expect(frame.locator("#external-script")).toHaveText("Local script loaded");
    await expect(frame.locator("#second")).toHaveCSS("color", "rgb(17, 68, 119)");
    await expect(frame.locator(".figure")).toHaveCSS("background-image", /data:image\/svg/);
    await expect.poll(() => frame.locator("#figure").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(80);
    await frame.locator("#counter").click(); await expect(frame.locator("#counter")).toHaveText("1");
    expect(await frame.locator("body").evaluate(() => (window as any).parentBlocked)).toBe(true);
    await expect.poll(() => frame.locator("body").evaluate(() => (window as any).apiBlocked)).toBe(true);
    expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
    const blockedNavigation = page.evaluate(() => new Promise<void>(resolve => {
      const blocked = (event: SecurityPolicyViolationEvent) => {
        if (event.effectiveDirective !== "frame-src" || !event.blockedURI.startsWith("https://blocked.invalid")) return;
        document.removeEventListener("securitypolicyviolation", blocked); resolve();
      };
      document.addEventListener("securitypolicyviolation", blocked);
    }));
    await frame.locator("#escape").click();
    await blockedNavigation;
    // Engines may either retain srcdoc or replace it with a blocked frame.
    await expect.poll(async () =>
      (await page.locator(".html-status").textContent())?.includes("blocked navigation") || await frame.locator("h1").isVisible(),
    ).toBe(true);
    expect(externalRequests).toBe(0);
    await page.getByRole("button", { name: "Reload preview" }).click();
    await expect(frame.locator("h1")).toBeVisible();
    await writeFile(join(root, "paper/css/theme.css"), 'p{color:rgb(80,20,100)} .figure{width:80px;height:40px;background-image:url("../images/figure.svg")}');
    await expect(frame.locator("#second")).toHaveCSS("color", "rgb(80, 20, 100)");
    await page.getByRole("button", { name: "Connect conversation" }).click();
    await expect(page.getByRole("region", { name: "Artifact conversation" })).toContainText("Ready");
    await frame.locator("#second").evaluate(element => {
      const text = [...element.childNodes].find(n => n.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange(); range.setStart(text, 3); range.setEnd(text, 9);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    await expect(page.getByRole("button", { name: "Comment selected text" })).toBeEnabled();
    await page.getByRole("button", { name: "Comment selected text" }).click();
    await page.getByPlaceholder("What needs saying?").fill("Explain the selected HTML passage");
    await page.locator(".composer").getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.locator("#comments")).toContainText("HTML comment understood.");
    const thread = new CommentStore(server.vault.getDoc("paper/report.html").doc).list()[0]!;
    expect(thread.quote).toBe("&amp; café");
    expect(thread.range!.from).toBe(source.lastIndexOf("&amp;"));
    expect(prompts[0]).toContain("Explain the selected HTML passage");
    await page.locator("#comments").getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: "Reply to comment" }).fill("And the context?");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.locator("#comments")).toContainText("HTML follow-up understood.");
    await frame.locator("#change").click();
    await frame.locator("#dynamic").evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    await expect(page.getByRole("button", { name: "Comment selected text" })).toBeDisabled();
    await expect(page.locator(".html-status")).toContainText("changed dynamically");
    await page.evaluate(() => { const view = window.__marginoteView!; const start = view.state.doc.toString().indexOf("HTML report</h1>"); view.dispatch({ changes: { from: start, to: start + 11, insert: "Updated report" } }); });
    await expect(frame.locator("h1")).toHaveText("Updated report");
    await expect(page.getByRole("button", { name: "Comment selected text" })).toBeDisabled();
    await expect.poll(async () => (await readFile(join(root, "paper/report.html"), "utf8")).includes("Updated report</h1>")).toBe(true);
    const offset = await page.evaluate(() => { const view = window.__marginoteView!; const from = view.state.doc.toString().indexOf('<p id="second"'); view.dispatch({ selection: { anchor: from + 16 } }); return from; });
    await page.getByRole("button", { name: "Find in HTML" }).click();
    await expect(frame.locator("#second")).toHaveAttribute("class", /mn-highlight-/);
    await frame.locator("#second").dblclick();
    await expect.poll(() => page.evaluate(() => window.__marginoteView!.state.selection.main.head)).toBe(offset);
    await page.locator("#export-btn").click();
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "HTML source original format", exact: true }).click()]);
    expect(file.suggestedFilename()).toBe("report.html");
    expect(await readFile((await file.path())!, "utf8")).toBe(await readFile(join(root, "paper/report.html"), "utf8"));
    await page.screenshot({ path: test.info().outputPath("html-conversation.png") });
    await page.goto(`http://127.0.0.1:${server.port}/?doc=note.md`);
    await expect(page.locator("#preview h1")).toHaveText("Markdown remains available");
    await expect(page.locator('iframe[title="HTML document preview"]')).toHaveCount(0);
    expect(externalRequests).toBe(0);
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
