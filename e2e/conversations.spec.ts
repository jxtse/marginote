import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MarginoteServer } from "../packages/server/src/server.js";
import { CommentStore } from "@marginote/bridge";

for (const provider of ["codex", "claude-code", "hermes"] as const) {
test(`${provider}: connects a delivery, discusses, proposes edits and continues after acceptance`, async ({ page }) => {
  // A typical desktop side panel is narrower than the old 1180px rail cutoff.
  if (provider === "codex") await page.setViewportSize({ width: 1100, height: 800 });
  const root = await mkdtemp(join(tmpdir(), "marginote-conversation-e2e-"));
  let server: MarginoteServer | undefined; const sessions: string[] = []; let forks = 0;
  try {
    await writeFile(join(root, "report.md"), "# A delivered report\n\nThis claim needs discussion.\n");
    await writeFile(join(root, "standalone.md"), "# Standalone editor\n");
    server = await MarginoteServer.start({ root, port: 0, git: false, webRoot: resolve("packages/web/dist"), conversationProvider: {
      fork: async origin => {
        expect(origin).toEqual({ provider, sessionId: "parent", turnId: "delivery" }); forks++;
        return provider === "hermes" ? { sessionId: "child", deliveryTurnId: "42", model: "inherited-model", provider: "native-route", reasoningEffort: "high", activeMessages: 9, archivedMessages: 3 } : "child";
      },
      prompt: async (session, text, run) => {
        sessions.push(session);
        if (sessions.length === 1) {
          expect(text).toContain("Explain the claim");
          const decision = await run.approve({ id: "approval-1", kind: "command", detail: "git diff -- report.md" });
          return decision ? "The claim follows our earlier discussion." : "The requested operation was declined.";
        }
        if (sessions.length === 2) {
          expect(text).toContain("What about uncertainty?");
          return "The uncertainty remains part of our discussion.";
        }
        if (sessions.length === 3) {
          expect(text).toContain("Propose a clearer sentence");
          const source = JSON.parse((await run.tools!.call("marginote_read_document", {})).content[0]!.text);
          const result = await run.tools!.call("marginote_suggest_edit", { revision: source.revision, old_text: "This claim needs discussion.", new_text: "This claim retains uncertainty.", reason: "Explain the uncertainty we discussed" });
          expect(result.isError).not.toBe(true);
          return "I proposed a clearer sentence for your review.";
        }
        expect(text).toContain('"orphaned":true');
        expect(text).toContain("This claim retains uncertainty.");
        return "The accepted revision retains our discussion history.";
      },
    } });
    const url = `http://127.0.0.1:${server.port}`;
    if (provider === "hermes") await server.conversations.bind(server.room("report.md"), { provider, sessionId: "parent", turnId: "delivery" }, true);
    await page.goto(`${url}/?doc=report.md&origin-session=parent&origin-turn=delivery&origin-provider=${provider}`);
    await expect(page.getByText("live", { exact: true })).toBeVisible();
    if (provider !== "hermes") await page.getByRole("button", { name: "Connect conversation" }).click();
    else await expect(page.getByRole("button", { name: "Connect conversation", exact: true })).toHaveCount(0);
    const panel = page.getByRole("region", { name: "Artifact conversation" });
    await expect(panel).toContainText("Ready");
    await expect(panel).toContainText(provider === "hermes" ? "Hermes" : provider === "codex" ? "Codex" : "Claude Code");
    if (provider === "hermes") {
      await expect(panel).toContainText("Inherited model: inherited-model · native-route · reasoning high");
      await panel.getByText("Conversation details", { exact: true }).click();
      await expect(panel).toContainText("9 active messages, 3 archived");
      await page.getByRole("button", { name: "Agent settings", exact: true }).click();
      await expect(page.locator(".agent-settings")).toContainText("Settings → Hermes");
      await expect(page.locator(".agent-settings")).toContainText("Model: inherited-model");
      await expect(page.locator(".agent-settings input[name=model]")).toHaveCount(0);
      await page.getByRole("button", { name: "Agent settings", exact: true }).click();
    }
    await expect(page.locator("#grill-btn")).toBeHidden();
    await expect(page.locator("#agent-onboarding")).toBeHidden();
    await page.evaluate(() => { window.__marginoteView!.dispatch({ selection: { anchor: 23, head: 33 } }); });
    await page.locator("#comment-btn").click();
    await page.getByPlaceholder("What needs saying?").fill("Explain the claim");
    await page.locator(".composer").getByRole("button", { name: "Comment", exact: true }).click();
    await expect(panel).toContainText("Your approval needed");
    await expect(panel).toContainText("git diff -- report.md");
    await expect(page.locator("#comments .reply")).toHaveCount(1);
    await expect(page.locator("#comments")).toContainText("👀 received · reading…");
    await expect(page.locator("#comments").getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("conversation-approval.png") });
    await page.getByRole("button", { name: "Approve once" }).click();
    await expect(page.locator("#comments")).toContainText("The claim follows our earlier discussion.");
    await page.locator("#comments").getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: "Reply to comment" }).fill("What about uncertainty?");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.locator("#comments")).toContainText("The uncertainty remains part of our discussion.");
    expect(forks).toBe(1); expect(sessions).toEqual(["child", "child"]);
    await page.reload();
    await expect(panel).toContainText("Ready");
    await expect(page.locator("#comments")).toContainText("The uncertainty remains part of our discussion.");
    expect(sessions).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath("conversation-replies.png") });
    await page.locator("#comments").getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: "Reply to comment" }).fill("Propose a clearer sentence");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.locator("#suggestions .card")).toHaveCount(1);
    await expect(page.locator("#comments .reply")).toHaveCount(8);
    await server.vault.flush();
    expect(await readFile(join(root, "report.md"), "utf8")).toContain("This claim needs discussion.");
    await page.screenshot({ path: test.info().outputPath("conversation-edit-proposal.png") });
    await page.locator("#suggestions").getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.locator("#preview")).toContainText("This claim retains uncertainty.");
    await server.vault.flush();
    expect(await readFile(join(root, "report.md"), "utf8")).toContain("This claim retains uncertainty.");
    expect(new CommentStore(server.vault.getDoc("report.md").doc).list()[0]!.orphaned).toBe(true);
    await page.locator("#comments").getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: "Reply to comment" }).fill("Continue after acceptance");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.locator("#comments .reply")).toHaveCount(11);
    await expect(page.locator("#comments .reply").last()).toContainText("accepted revision");
    expect(forks).toBe(1); expect(sessions).toEqual(["child", "child", "child", "child"]);
    await page.locator("#comments").getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(page.locator("#comments .card")).toHaveClass(/resolved/);
    await page.locator("#comments").getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(page.locator("#comments .card")).not.toHaveClass(/resolved/);
    await page.goto(`${url}/?doc=standalone.md`);
    await expect(panel).toBeHidden();
    await expect(page.locator("#agent-onboarding")).toBeVisible();
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
}
