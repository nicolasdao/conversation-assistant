// FS3: the chat window about the recording on screen — ⌘K, a streamed answer, Stop, the model picker, and the cost.
import { expect, open, test } from "../fixtures.ts";

test.use({ harnessEnv: { E2E_SEED: "library" } });

test("asks about a recording, streams the answer, stops a second one, and switches model", async ({ page }) => {
  await open(page, "/recordings/20260924-100000");
  await expect(page.locator("#transcript .utt")).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#dlg-chat")).toHaveAttribute("open", "");
  await expect(page).toHaveURL(/[?&]panel=chat/);

  const input = page.locator("#chat-input");
  await input.fill("What did they say about Jev?");
  await input.press("Enter");
  await expect(page.locator("#chat-log .msg.user").first()).toContainText("What did they say about Jev?");
  await expect(page.locator("#chat-send")).toHaveText("Stop");
  await expect(page.locator("#chat-log .msg.assistant").first()).toContainText("that Jev is cheap, reply 1.", { timeout: 15_000 });
  await expect(page.locator("#chat-send")).toHaveText("Send");
  await expect(page).toHaveURL(/[?&]chat=chat_1/);
  await expect(page.locator("#chat-spend")).toContainText("$0.0012");

  // a second question, stopped while it streams
  await input.fill("And then?");
  await input.press("Enter");
  await expect(page.locator("#chat-send")).toHaveText("Stop");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-log .note", { hasText: "Stopped." })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#chat-send")).toHaveText("Send");

  // the model picker: search, pick, and the chat keeps the new model
  await page.locator("#model-btn").click();
  await expect(page.locator("#model-menu")).toBeVisible();
  await page.locator("#model-search").fill("claude");
  // the curated Claude models; those missing from OpenRouter's catalogue cannot be picked
  await expect(page.locator("#model-list .model-row:not([disabled])")).toHaveText([/Claude Sonnet 5/]);
  await expect(page.locator("#model-list .model-row[disabled]")).toHaveCount(2);
  await page.locator("#model-list .model-row:not([disabled])").click();
  await expect(page.locator("#model-btn")).toContainText("Claude Sonnet 5");
  await expect(page.locator("#model-menu")).toBeHidden();
});
