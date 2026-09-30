// Scripted scenarios: a live session whose capture hears nothing (E2E_LIVE=hold), and events injected on the engine's
// bus through the harness's control channel, for states a real session cannot reach on demand.
import type { Page } from "@playwright/test";
import { expect, open, test, type Harness } from "../fixtures.ts";

test.use({ harnessEnv: { E2E_CONTROL: "1", E2E_LIVE: "hold", E2E_LIVE_TEXT: "off" } });

async function goLive(page: Page) {
  await open(page);
  await page.locator("#start-live").click();
  await page.locator("#start-go").click();
  await expect(page.locator("#onair-label")).toHaveText("On air");
}

const emit = (h: Harness, type: string, data: Record<string, unknown>, transient = false) => h.control({ emit: type, data, transient });

test("an engine error shows in Insights → Log and in the Insights menu item", async ({ page, harness }) => {
  await goLive(page);
  await emit(harness, "error", { component: "jev", message: "Jev timed out after 5 s" });
  await expect(page.locator("#log-count")).toHaveText("1");
  await page.locator("#cog-btn").click();
  await expect(page.locator("#m-insights .error-text")).toHaveText("1 error");
  await page.locator('[data-open="dlg-insights"]').click();
  await page.locator("#dlg-insights").getByRole("tab", { name: /Log/ }).click();
  await expect(page.locator("#errors")).toContainText("Jev timed out after 5 s");
});

test("health meters show each stream's level and device, and turn red when a stream goes quiet", async ({ page, harness }) => {
  test.setTimeout(60_000);
  await goLive(page);
  const host = page.locator("#health .meter").nth(0);
  await expect(host.locator(".dev")).toHaveText("MacBook Pro Microphone");
  // speech-level audio (−20 dBFS) on the host stream shows in its meter (the streams are merged by time, so the
  // remote stream gets its silence too)
  await harness.control({ push: { stream: "remote", atMs: 0, ms: 3000, amp: 0 } });
  await harness.control({ push: { stream: "host", atMs: 0, ms: 3000, amp: 3277 } });
  await expect(host.locator(".meta")).toHaveText(/^−20 dBFS/);
  await expect(host).not.toHaveClass(/alert/);
  // then nothing: after 10 s of silence the meter turns red and says so
  await expect(host).toHaveClass(/alert/, { timeout: 20_000 });
});

test("speaker mode shows while the call plays through the speakers", async ({ page, harness }) => {
  await goLive(page);
  await expect(page.locator("#speaker-mode")).toBeHidden();
  await emit(harness, "echo.gate", { active: true, device: "MacBook Pro Speakers", atMs: 1000 });
  await expect(page.locator("#speaker-mode")).toBeVisible();
  await expect(page.locator("#speaker-mode-device")).toHaveText("MacBook Pro Speakers");
  await emit(harness, "echo.gate", { active: false, device: "AirPods Pro", atMs: 2000 });
  await expect(page.locator("#speaker-mode")).toBeHidden();
});

test("OpenRouter's refusal marks the spend", async ({ page, harness }) => {
  await goLive(page);
  await emit(harness, "budget.exhausted", { cap: "provider", message: "OpenRouter credits or key limit exhausted (402)" });
  await expect(page.locator("#cost")).toHaveClass(/exhausted/);
  await expect(page.locator("#cost .error-text")).toHaveText("OpenRouter stopped: OpenRouter credits or key limit exhausted (402)");
});

test("a System 1 rewrite promoted by the gate shows in Insights → Fact-checker", async ({ page, harness }) => {
  await goLive(page);
  await emit(harness, "s1.version", { active: "s1@2", candidate: "s1@2", outcome: "promoted", rationale: "Catches price claims", gate: { goodKept: 1, errorsFixed: 2 }, errors: null });
  await page.locator("#cog-btn").click();
  await page.locator('[data-open="dlg-insights"]').click();
  await page.locator("#dlg-insights").getByRole("tab", { name: /Fact-checker/ }).click();
  await expect(page.locator("#s1")).toContainText("s1@2");
  await expect(page.locator("#s1")).toContainText(/promoted/i);
});

test("the page shows a lost event stream, reconnects by itself, and keeps what it had", async ({ page, harness }) => {
  await goLive(page);
  await emit(harness, "echo.gate", { active: true, device: "MacBook Pro Speakers", atMs: 1000 });
  await expect(page.locator("#speaker-mode")).toBeVisible();
  const reconnected = page.waitForRequest((r) => r.url().endsWith("/api/events"));
  await harness.control({ dropEvents: true });
  await expect(page.locator("#conn")).toHaveClass(/down/);
  await reconnected; // EventSource retries by itself, after about 3 s
  await expect(page.locator("#conn")).not.toHaveClass(/down/, { timeout: 15_000 });
  await expect(page.locator("#onair-label")).toHaveText("On air");
  await expect(page.locator("#speaker-mode")).toBeVisible();
  // and events flow again
  await emit(harness, "echo.gate", { active: false, device: "AirPods Pro", atMs: 2000 });
  await expect(page.locator("#speaker-mode")).toBeHidden();
});

test("BUG S-state-1: the history replayed after a reconnect does not count an error twice", async ({ page, harness }) => {
  test.fail(); // `error` events have no id, and the reducer adds them again (web/src/state.ts)
  await goLive(page);
  await emit(harness, "error", { component: "jev", message: "one error" });
  await expect(page.locator("#log-count")).toHaveText("1");
  const reconnected = page.waitForRequest((r) => r.url().endsWith("/api/events"));
  await harness.control({ dropEvents: true });
  await reconnected;
  await page.waitForTimeout(1000); // the replayed history has arrived
  await expect(page.locator("#log-count")).toHaveText("1");
});

// Known bugs, recorded, not fixed (SPEC §4.0.4); `test.fail` passes while a bug is there and fails once it is fixed.
// E2E-L1 and W7-L2: the engine's `error` event shares its name with EventSource's own connection error
// (web/src/app.ts, connect()).
test("BUG E2E-L1: an engine error does not mark the event stream as lost", async ({ page, harness }) => {
  test.fail();
  await goLive(page);
  await emit(harness, "error", { component: "jev", message: "Jev timed out after 5 s" });
  await expect(page.locator("#log-count")).toHaveText("1");
  await expect(page.locator("#conn")).not.toHaveClass(/down/, { timeout: 2000 });
});

test("BUG W7-L2: a lost event stream raises no error in the page", async ({ page, harness }) => {
  test.fail();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await goLive(page);
  await harness.control({ dropEvents: true });
  await expect(page.locator("#conn")).toHaveClass(/down/);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});
