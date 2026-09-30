// FS7 (since 29 September 2026 the app sets no dollar cap of its own): when OpenRouter refuses for good (a
// non-transient 402: credit used up), later calls are not sent and the header's spend says why. The transcript goes on.
import { expect, open, test } from "../fixtures.ts";

test.use({ harnessEnv: { E2E_402: "1" } });

test("OpenRouter's 402 stops Jev and System 2, says so in the spend, and the transcript goes on", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  await page.locator("#replay-btn").click();
  await page.getByRole("button", { name: "Max" }).click();
  await page.locator("#start-replay").click();
  await expect(page.locator("#cost")).toHaveClass(/exhausted/, { timeout: 60_000 });
  await expect(page.locator("#cost .error-text")).toHaveText("OpenRouter stopped: OpenRouter credits or key limit exhausted (402)");
  await expect(page).toHaveURL(/\/recordings\/\d{8}-\d{6}$/, { timeout: 150_000 });
  await expect(page.locator("#transcript .utt").first()).toBeVisible();
  await expect(page.locator("#claims article.fc")).toHaveCount(0);
});
