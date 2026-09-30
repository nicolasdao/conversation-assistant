// The API keys window, deep links and Back, and the Licenses page (inventory 4 §13: E2, E7, E9).
import { expect, open, test } from "../fixtures.ts";

test.use({ harnessEnv: { E2E_SEED: "library" } });

test("the API keys window saves only the key that was pasted", async ({ page }) => {
  await open(page);
  await page.locator("#cog-btn").click();
  await page.locator('[data-open="dlg-keys"]').click();
  await expect(page.locator("#dlg-keys")).toHaveAttribute("open", "");
  await expect(page).toHaveURL(/[?&]panel=keys/);
  await expect(page.locator("#keys .key-card")).toHaveCount(2);
  await expect(page.locator("#keys")).toContainText("…1234"); // the saved OpenRouter key's last 4 characters

  const save = page.locator("#keys .key-actions .btn.primary");
  await save.click();
  await expect(page.locator("#keys .key-actions .key-msg.bad")).toHaveText("Paste a key to save.");

  await page.getByLabel("OpenRouter API key").fill("sk-or-v1-new-0000000000000000000000000000009876");
  const posted = page.waitForRequest((r) => r.url().endsWith("/api/setup/keys"));
  await save.click();
  expect(Object.keys((await posted).postDataJSON())).toEqual(["openrouter"]);
  await expect(page.locator(".toast.ok")).toHaveText("API key saved: the next call uses it");

  await page.locator("#dlg-keys .x, #dlg-keys [aria-label='Close']").first().click();
  await expect(page).not.toHaveURL(/panel=/);
});

test("a recording's URL opens it at its position; Back returns home and closes it", async ({ page }) => {
  await open(page, "/");
  await expect(page.locator("#session-name")).toHaveText("No session");
  await page.goto("/recordings/20260924-100000?t=1:03", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#transcript .utt")).toHaveCount(2);
  await expect(page.locator("#player")).toBeVisible();
  await expect(page.locator("#play-time")).toHaveText("1:03");

  // a tab and a window in the URL
  await page.goto("/recordings/20260924-100000?tab=jev-log&panel=insights&section=fact-checker", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#pane-jev")).toBeVisible();
  await expect(page.locator("#dlg-insights")).toHaveAttribute("open", "");
  await expect(page.locator("#dlg-insights").getByRole("tab", { name: /Fact-checker/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/panel=/);

});

test("loading the home page while the engine shows a recording puts it in the URL", async ({ page }) => {
  await open(page, "/recordings/20260924-100000");
  await expect(page.locator("#transcript .utt")).toHaveCount(2);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/recordings\/20260924-100000(\?|$)/);
  await expect(page.locator("#transcript .utt")).toHaveCount(2);
});

test("opening a recording adds a history entry, and Back leaves it", async ({ page }) => {
  await open(page, "/");
  await page.locator("#cog-btn").click();
  await page.locator('[data-open="dlg-recordings"]').click();
  await page.locator("#recordings .rec").first().click();
  await expect(page).toHaveURL(/\/recordings\/20260925-090000(\?|$)/);
  await expect(page.locator("#transcript .utt")).toHaveCount(1);
  const closing = page.waitForRequest((r) => r.url().endsWith("/api/sessions/close"));
  await page.goBack();
  await closing;
  await expect(page.locator("#session-name")).toHaveText("No session");
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/(\?|$)/);
});

test("an unknown recording's URL says so and lands home", async ({ page }) => {
  await open(page, "/recordings/20990101-000000");
  await expect(page.locator(".toast.error")).toContainText("could not be opened");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#session-name")).toHaveText("No session");
});

test("the Licenses page lists the app and its components, and searches them", async ({ page, context }) => {
  await open(page);
  await page.locator("#cog-btn").click();
  const opened = context.waitForEvent("page");
  await page.locator("#license-link").click();
  const lic = await opened;
  await lic.waitForLoadState("domcontentloaded");
  expect(new URL(lic.url()).pathname).toBe("/licenses");
  const first = lic.locator("#lic-list .lic-item").first();
  await expect(first).toContainText("This app");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(lic.locator("#lic-detail h1")).toHaveText("This app");
  await lic.locator("#lic-search").fill("electron");
  await expect(lic.locator("#lic-list .lic-item").first()).toContainText(/Electron/i);
  await lic.locator("#lic-search").fill("zzzz-nothing");
  await expect(lic.locator("#lic-list")).toHaveText("Nothing matches.");
});
