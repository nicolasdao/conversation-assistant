// FS8: Start live through the harness's capture (the fixture at 1×): the window's choices, then Pause, Resume and Stop.
import { expect, open, test } from "../fixtures.ts";

test("starts live with the chosen microphone and features, pauses, resumes, and stops into a recording", async ({ page }) => {
  await open(page);
  await page.locator("#start-live").click();
  await expect(page.locator("#dlg-start")).toHaveAttribute("open", "");
  await expect(page.locator("#feat-factcheck")).toHaveAttribute("aria-checked", "true");
  // a mouse click on a list inside the modal works (docs/gotchas.md § Web page)
  await page.locator("#dlg-start").getByRole("combobox", { name: /^Microphone/ }).click();
  await page.getByRole("option", { name: /Rode NT-USB/ }).click();
  await page.locator("#feat-factcheck").click();
  await expect(page.locator("#feat-factcheck")).toHaveAttribute("aria-checked", "false");
  const started = page.waitForRequest((r) => r.url().endsWith("/api/session/start"));
  await page.locator("#start-go").click();
  const body = (await started).postDataJSON();
  expect(body).toMatchObject({ mode: "live", mic: "usb-rode", features: { factcheck: false } });

  await expect(page.locator("#onair")).toBeVisible();
  await expect(page.locator("#onair-label")).toHaveText("On air");
  await expect(page.locator("#features-chip")).toHaveText("No fact-check");
  await expect(page.locator("#transcript .utt").first()).toBeVisible({ timeout: 20_000 });

  await page.locator("#pause").click();
  await expect(page.locator("#onair-label")).toHaveText("Paused");
  await expect(page.locator("#pause")).toContainText("Resume");
  await page.locator("#pause").click();
  await expect(page.locator("#onair-label")).toHaveText("On air");

  await page.locator("#stop").click();
  await expect(page).toHaveURL(/\/recordings\/\d{8}-\d{6}$/, { timeout: 15_000 });
  await expect(page.locator("#onair")).toBeHidden();
  await expect(page.locator("#export-btn")).toBeVisible();
});
