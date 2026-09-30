// FS1: the first run on a Mac that transcribes with OpenAI asks for the OpenAI key, checks it, and opens the app.
import { expect, open, test } from "../fixtures.ts";

test.use({ harnessEnv: { E2E_KEYS: "missing", E2E_REFUSE_KEYS: "refused" } });

test("the setup screen refuses a bad key, saves a good one, and opens the app", async ({ page }) => {
  await open(page);
  await expect(page.locator("main#setup")).toBeVisible();
  await expect(page.locator("#top")).toBeHidden();
  await expect(page.locator("main#setup h1")).toHaveText("Add your OpenAI API key to start");
  const input = page.getByLabel("OpenAI API key");
  const go = page.locator(".setup-go");
  await expect(go).toHaveText("Save key and start");

  // nothing typed: nothing is sent
  await go.click();
  await expect(page.locator(".setup-field .key-msg.bad")).toBeVisible();

  // a key in the wrong field is caught before any check
  await input.fill("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123");
  await expect(page.locator(".setup-field .key-msg")).toContainText("OpenRouter");

  // a well-formed key that OpenAI refuses
  await input.fill("sk-proj-refused-abcdefghijklmnopqrstuvwxyz");
  await expect(page.locator(".setup-field")).toContainText("Looks right");
  await go.click();
  await expect(page.locator(".setup-field .key-msg.bad")).toContainText("OpenAI does not accept this key");
  await expect(go).toBeEnabled();

  // a good key: saved, and the page reloads into the app by itself
  await input.fill("sk-proj-good-abcdefghijklmnopqrstuvwxyz0123");
  await go.click();
  await expect(page.locator(".setup-progress.done")).toHaveText("All set. Opening Tattle…");
  await expect(page.locator("#session-name")).toHaveText("No session", { timeout: 15_000 });
  await expect(page.locator("main#setup")).toHaveCount(0);
  await expect(page.locator("#top")).toBeVisible();
});
