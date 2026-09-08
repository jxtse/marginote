import { expect, test } from "@playwright/test";
import type { EditorView } from "@codemirror/view";

declare global {
  interface Window { __marginoteView?: EditorView }
}

test("source and preview navigate in both directions without stealing scroll", async ({ page, browserName }) => {
  const paths = { chromium: "welcome.md", firefox: "project-plan.md", webkit: "architecture.md" };
  await page.goto(`/?doc=${paths[browserName]}`);
  await expect(page.getByText("live", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#preview h1")).toBeVisible();
  const source = Array.from({ length: 60 }, (_, index) => `Paragraph ${index}: a navigation target.`).join("\n\n");
  await page.evaluate((content) => {
    const view = window.__marginoteView!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: 0 } });
  }, source);
  const first = page.locator('#preview > [data-src-start="0"]');
  await expect(first).toContainText("Paragraph 0:");
  const proposed = "Pending proposal.\n\n";
  await page.locator("#suggest-btn").click();
  await page.evaluate((insert) => window.__marginoteView!.dispatch({ changes: { from: 0, insert } }), proposed);
  await expect(page.getByRole("textbox")).toContainText("Pending proposal.");
  await expect(page.locator("#preview")).not.toContainText("Pending proposal.");
  await page.locator("#suggest-btn").click();
  const paragraph = page.locator("#preview > p").filter({ hasText: "Paragraph 3:" });
  await paragraph.dblclick();
  const offset = source.indexOf("Paragraph 3:");
  await expect.poll(() => page.evaluate(() => window.__marginoteView!.state.selection.main.head)).toBe(offset + proposed.length);
  expect(await page.evaluate(() => window.__marginoteView!.state.selection.main.empty)).toBe(true);
  await expect(page.locator(".cm-line.sync-nav-flash")).toContainText("Paragraph 3:");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");

  await page.waitForTimeout(1100);
  const lastOffset = source.indexOf("Paragraph 59:");
  await page.evaluate((anchor) => window.__marginoteView!.dispatch({ selection: { anchor } }), lastOffset + proposed.length);
  const last = page.locator(`#preview > [data-src-start="${lastOffset}"]`);
  await expect(last).toHaveClass(/sync-nav-flash/);
  await expect(last).toBeInViewport();
  const scroll = await page.locator("#preview").evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await page.evaluate(() => {
    const view = window.__marginoteView!;
    const anchor = view.state.selection.main.head;
    view.dispatch({ changes: { from: anchor, insert: "Typed " }, selection: { anchor: anchor + 6 } });
  });
  await page.waitForTimeout(250);
  expect(await page.locator("#preview").evaluate((element) => element.scrollTop)).toBe(scroll);

  await page.locator("#preview").hover();
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__marginoteView!.dispatch({ selection: { anchor: 0 } }));
  await page.waitForTimeout(250);
  await expect(first).not.toHaveClass(/sync-nav-flash/);
  await expect(first).not.toBeInViewport();
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__marginoteView!.dispatch({ selection: { anchor: 1 } }));
  await expect(first).toHaveClass(/sync-nav-flash/);
  await expect(first).toBeInViewport();
  await expect(first).not.toHaveClass(/sync-nav-flash/, { timeout: 2500 });
});
