import { expect, test } from "@playwright/test";

test("unconfigured grill and dismissible onboarding survive reload", async ({ page, request }) => {
  await request.post("/api/agent/config", { data: { apiKey: "", model: "" } });
  await page.goto("/?doc=welcome.md");
  await expect(page.locator("#grill-btn")).toBeVisible();
  await expect(page.locator("#grill-btn")).toBeDisabled();
  await expect(page.locator("#grill-btn")).toHaveAttribute("title", /API key/);
  await expect(page.locator("#agent-onboarding")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss agent introduction" }).click();
  await page.reload();
  await expect(page.locator("#agent-onboarding")).toBeHidden();
});

test("settings opens, saves and masks credentials; Grill posts the selected doc", async ({ page, request }) => {
  await request.post("/api/agent/config", { data: { apiKey: "", model: "" } });
  await page.goto("/?doc=welcome.md");
  await page.getByRole("button", { name: "Add an API key to wake the margin agent" }).click();
  const panel = page.locator(".agent-settings");
  const key = panel.locator('input[name="apiKey"]');
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("fake-test-secret-12345");
  await panel.getByLabel("Model id", { exact: true }).fill("fake-model");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved.");
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("placeholder", /Saved/);
  const config = await (await request.get("/api/agent/config")).json();
  expect(config.apiKey).not.toContain("fake-test-secret");
  await expect(page.locator("#agent-onboarding")).toBeHidden();
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  let busy = false;
  await page.route("**/api/agent/status**", route => route.fulfill({ json: { configured: true, state: busy ? "working" : "idle", busy, lastError: null } }));
  await page.route("**/api/agent/grill", async route => {
    expect(route.request().postDataJSON()).toEqual({ doc: "welcome.md" });
    busy = true;
    await route.fulfill({ status: 202, json: { enqueued: true, runId: "fake-run" } });
  });
  await expect(page.locator("#grill-btn")).toBeEnabled();
  const posted = page.waitForRequest("**/api/agent/grill");
  await page.locator("#grill-btn").click();
  await posted;
  await expect(page.locator("#grill-btn")).toHaveText("Working…");
  await expect(page.locator("#grill-btn")).toBeDisabled();
  await expect(page.locator("#grill-btn")).toHaveAttribute("aria-busy", "true");
  busy = false;
  await expect(page.locator("#grill-btn")).toHaveText("Grill me");
  await expect(page.locator("#grill-btn")).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("placeholder", /Saved/);
  await request.post("/api/agent/config", { data: { apiKey: "", model: "" } });
});
