// FS2: a replay of the fixture conversation at max speed, through the real pipeline with fake services. What the
// page shows must match what the engine produced, and what the fixture's script says Jev flags.
import { loadScript } from "../../tests/helpers.ts";
import { expect, open, test } from "../fixtures.ts";

test("the replayed fixture shows its transcript, speakers, segments, fact-checks and tally", async ({ page }) => {
  test.setTimeout(180_000);
  const script = loadScript();
  const claims = script.lines.filter((l) => l.expected.claim && !l.expected.repeatOf).length; // the repeat links to its first claim
  const voices = new Set(script.lines.map((l) => l.voice)).size;

  await open(page);
  await page.locator("#replay-btn").click();
  await page.locator("#replay-dir").fill("fixtures/conversation");
  await page.getByRole("button", { name: "Max" }).click();
  await page.locator("#start-replay").click();
  await expect(page.locator("#onair")).toBeVisible();

  // the session ends by itself: the page then shows it as a recording, at its own URL
  await expect(page).toHaveURL(/\/recordings\/\d{8}-\d{6}$/, { timeout: 150_000 });
  const id = page.url().split("/").pop()!;
  // what the engine recorded, from the library's summary of the recording
  const rec = await page.evaluate((i) => fetch(`/api/sessions/${i}`).then((r) => r.json()), id);

  const lines = page.locator("#transcript .utt:not(.live)");
  await expect(lines).toHaveCount(rec.utterances);
  expect(rec.utterances).toBeGreaterThanOrEqual(script.lines.length - 1); // Silero may merge or miss one short line
  const speakers = new Set(await page.locator("#transcript .utt .who-tab").allTextContents());
  expect(speakers.size).toBe(voices);
  expect(rec.speakers).toHaveLength(voices);

  await expect(page.locator("#claims article.fc")).toHaveCount(claims);
  expect(rec.claims).toBe(claims);
  await expect(page.locator("#claims article.fc.v-supported")).toHaveCount(claims);
  await expect(page.locator("#tally")).toHaveText(`${claims} supported`);
  await expect(page.locator("#transcript .utt.flagged")).toHaveCount(claims);
  // the repeated line is not researched again: its first claim carries a badge
  const repeats = script.lines.filter((l) => l.expected.repeatOf).length;
  await expect(page.locator("#claims .badge.repeat")).toHaveText([`Repeat ×${repeats}`]);

  const segments = rec.segments;
  expect(segments).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#timeline .lane.cat-1 .blk:not(.open)")).toHaveCount(segments);
  await expect(page.locator("#onair")).toBeHidden();
  await expect(page.locator("#export-btn")).toBeVisible();
});
