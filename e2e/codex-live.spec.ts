import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexRpc } from "../packages/agent/src/codex-conversation.js";
import { MarginoteServer } from "../packages/server/src/server.js";
import { allRuns, CommentStore, pendingSuggestions } from "@marginote/bridge";

test("live Codex inherits delivery history, proposes an edit and continues after acceptance", async ({ page }) => {
  test.skip(process.env.MARGINOTE_LIVE_CODEX !== "1", "Opt in explicitly: uses the installed Codex identity and real model calls");
  test.setTimeout(360_000);
  const root = await mkdtemp(join(tmpdir(), "marginote-live-codex-"));
  const signal = AbortSignal.timeout(340_000);
  const rpc = new CodexRpc("codex", ["app-server", "--listen", "stdio://"], root, signal);
  let server: MarginoteServer | undefined; let originId: string | undefined; let childId: string | undefined;
  try {
    const initial = "# Delivery review\n\nDiscuss this report with its original conversation.\n";
    await writeFile(join(root, "report.md"), initial);
    await rpc.initialize();
    const started = await rpc.request("thread/start", { cwd: root, sandbox: "read-only", developerInstructions: "This is a synthetic artifact collaboration integration test. Answer the human's questions. If asked to revise the document, use only the supplied marginote_read_document and marginote_suggest_edit tools. Do not use shell, filesystem tools, other MCP connectors, or external services. Leave suggestions for human review." });
    originId = started.thread.id;
    const nonce = `delivery-${randomUUID()}`;
    let detach: (() => void) | undefined;
    const finished = new Promise<string>((resolve, reject) => {
      detach = rpc.subscribe(message => {
        if (message.method === "marginote/disconnected") reject(message.params.error);
        if (message.method === "turn/completed" && message.params.threadId === originId) {
          if (message.params.turn.status !== "completed") reject(new Error(message.params.turn.error?.message ?? "Fixture turn failed"));
          else resolve(message.params.turn.id);
        }
      });
    });
    const [, turnId] = await Promise.all([
      rpc.request("turn/start", { threadId: originId, input: [{ type: "text", text: `For this report, the delivery code is ${nonce}. Remember it for follow-up questions. Reply only 'Recorded'. Do not use tools.`, text_elements: [] }] }),
      finished,
    ]);
    detach?.();
    const before = await rpc.request("thread/read", { threadId: originId, includeTurns: true });
    server = await MarginoteServer.start({ root, port: 0, git: false, webRoot: resolve("packages/web/dist") });
    await page.goto(`http://127.0.0.1:${server.port}/?doc=report.md&origin-session=${originId}&origin-turn=${turnId}`);
    await page.getByRole("button", { name: "Connect conversation" }).click();
    const panel = page.getByRole("region", { name: "Artifact conversation" });
    await expect(panel).toContainText("Ready", { timeout: 30_000 });
    childId = server.conversations.status("report.md")!.sessionId;
    await page.evaluate(() => window.__marginoteView!.dispatch({ selection: { anchor: 19, head: 38 } }));
    await page.locator("#comment-btn").click();
    await page.getByPlaceholder("What needs saying?").fill("What is the delivery code from our earlier conversation? Reply with only that code. Do not use tools.");
    await page.locator(".composer").getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.locator("#comments .reply")).toContainText(nonce, { timeout: 90_000 });
    await expect(panel).toContainText("Ready");
    await page.locator("#comments").getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: "Reply to comment" }).fill("Repeat the code and add the word confirmed. Do not use tools.");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.locator("#comments .reply")).toHaveCount(3, { timeout: 90_000 });
    await expect(page.locator("#comments .reply").last()).toContainText("confirmed");
    await expect(page.locator("#comments .reply").last()).toContainText(nonce);
    await expect(panel).toContainText("Ready");
    expect(server.conversations.status("report.md")!.sessionId).toBe(childId);
    await page.locator("#comments").getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: "Reply to comment" }).fill("Use the Marginote tools to propose replacing the sentence beginning 'Discuss this report' with exactly 'Reviewed delivery code: CODE.' where CODE is the delivery code from our original conversation. Keep the heading. Do not change the file directly; leave one suggestion for me to accept.");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.locator("#suggestions .card")).toHaveCount(1, { timeout: 120_000 });
    await expect(page.locator("#comments .reply")).toHaveCount(5, { timeout: 90_000 });
    await expect(panel).toContainText("Ready");
    const handle = server.vault.getDoc("report.md");
    expect(pendingSuggestions(handle.text)).toHaveLength(1);
    expect(allRuns(handle.doc).some(run => run.tool === "suggest_edit" && run.model === started.model && run.authorId === "agent-marginote-codex")).toBe(true);
    await server.vault.flush(); expect(await readFile(join(root, "report.md"), "utf8")).toBe(initial);
    await expect(page.locator("#suggestions .card")).toContainText(nonce);
    await page.locator("#suggestions").getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(() => handle.getContent()).toBe(`# Delivery review\n\nReviewed delivery code: ${nonce}.\n`);
    await server.vault.flush(); expect(await readFile(join(root, "report.md"), "utf8")).toBe(handle.getContent());
    expect(new CommentStore(handle.doc).list()[0]!.orphaned).toBe(true);
    await page.locator("#comments").getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: "Reply to comment" }).fill("I accepted your change. Repeat the delivery code and say accepted. Do not use tools.");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.locator("#comments .reply")).toHaveCount(7, { timeout: 90_000 });
    await expect(page.locator("#comments .reply").last()).toContainText(nonce);
    await expect(page.locator("#comments .reply").last()).toContainText("accepted");
    await expect(panel).toContainText("Ready");
    expect(server.conversations.status("report.md")!.sessionId).toBe(childId);
    const after = await rpc.request("thread/read", { threadId: originId, includeTurns: true });
    expect(after.thread.turns.map((turn: any) => turn.items)).toEqual(before.thread.turns.map((turn: any) => turn.items));
    await page.screenshot({ path: test.info().outputPath("codex-live-conversation.png") });
  } finally {
    await server?.close();
    for (const id of [childId, originId]) if (id) await rpc.request("thread/archive", { threadId: id }).catch(() => {});
    rpc.close(); await rm(root, { recursive: true, force: true });
  }
});
