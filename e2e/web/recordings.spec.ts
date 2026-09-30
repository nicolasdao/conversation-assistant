// FS4 and FS5: the Recordings window (list, search, rename, open, delete) and playback of a recording, whose position
// survives a reload through the URL.
import { expect, open, test } from "../fixtures.ts";

test.use({ harnessEnv: { E2E_SEED: "library" } });

test("lists, searches, renames, opens and deletes recordings", async ({ page }) => {
  await open(page);
  await page.locator("#cog-btn").click();
  await page.locator('[data-open="dlg-recordings"]').click();
  await expect(page.locator("#dlg-recordings")).toHaveAttribute("open", "");
  await expect(page).toHaveURL(/[?&]panel=recordings/);
  const rows = page.locator("#recordings .rec");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("1 lines"); // newest first

  // search the transcripts
  await page.getByLabel("Search names and transcripts").fill("surfing");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".match")).toContainText("Surfing in Sydney");
  await page.getByLabel("Search names and transcripts").fill("");
  await expect(rows).toHaveCount(2);

  // rename in place
  await rows.nth(1).locator(".rec-title").click();
  const name = page.locator(".rec-title-input");
  await name.fill("Pilot episode");
  await name.press("Enter");
  await expect(page.locator(".toast.ok")).toHaveText("Renamed to Pilot episode");
  await expect(page.locator("#recordings .rec-title", { hasText: "Pilot episode" })).toBeVisible();

  // open it: nothing is re-processed
  await page.locator("#recordings .rec", { hasText: "Pilot episode" }).click();
  await expect(page.locator("#dlg-recordings")).not.toHaveAttribute("open", "");
  await expect(page).toHaveURL(/\/recordings\/20260924-100000/);
  await expect(page.locator("#session-name")).toHaveText("Pilot episode");
  await expect(page.locator("#transcript .utt")).toHaveCount(2);

  // delete the other one, after confirming
  await page.locator("#cog-btn").click();
  await page.locator('[data-open="dlg-recordings"]').click();
  await page.locator("#recordings .rec", { hasNotText: "Pilot episode" }).locator(".rec-delete").click();
  await expect(page.locator("#dlg-ask")).toHaveAttribute("open", "");
  await page.locator("#ask-ok").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Pilot episode");
});

test("plays a recording at 4×, and the position in the URL survives a reload", async ({ page }) => {
  await open(page, "/recordings/20260924-100000");
  await expect(page.locator("#player")).toBeVisible();
  await page.getByRole("combobox", { name: /^Playback speed/ }).click();
  await page.getByRole("option", { name: "4×" }).click();
  await expect(page.getByRole("combobox", { name: /^Playback speed/ })).toHaveAccessibleName(/4×/);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause");
  // at 4×, 12 s of the recording pass in about 3 s
  await expect(page.locator("#play-time")).toHaveText(/^0:(1[2-9]|[2-5]\d)$/, { timeout: 15_000 });
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");
  await expect(page).toHaveURL(/[?&]t=0:\d\d/);
  const t = new URL(page.url()).searchParams.get("t")!;

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#play-time")).toHaveText(t);
  await expect(page).toHaveURL(new RegExp(`[?&]t=${t}`));
});
