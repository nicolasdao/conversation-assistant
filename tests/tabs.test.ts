import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TABS } from "../web/src/router.ts";

const html = readFileSync("web/index.html", "utf8");
const app = readFileSync("web/src/app.ts", "utf8");

// every <button> whose class includes "tab" and that names a pane
const paneTabs = [...html.matchAll(/<button\b[^>]*>/g)]
  .map((m) => m[0])
  .filter((b) => /\bclass="[^"]*\btab\b[^"]*"/.test(b))
  .map((b) => /\bdata-pane="([^"]+)"/.exec(b)?.[1])
  .filter((p): p is string => !!p);

describe("the right column's tabs", () => {
  test("every tab that names a pane has that pane in the page", () => {
    expect(paneTabs.length).toBeGreaterThanOrEqual(3);
    for (const p of paneTabs) expect(html, `pane #${p}`).toContain(`id="${p}"`);
  });

  test("every tab the URL can name has a tab and a pane", () => {
    for (const p of Object.values(TABS)) {
      expect(paneTabs, `tab for ${p}`).toContain(p);
      expect(html, `pane #${p}`).toContain(`id="${p}"`);
    }
  });

  // The Insights dialog's tab bar is `dlg-tabs tabs` too, and its tabs have no pane.
  // In 0.8.0 bindTabs matched them, so every tab switch threw before redrawing.
  test("bindTabs looks up only tabs that have a pane", () => {
    const body = /function bindTabs\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
    const sel = /querySelectorAll<HTMLButtonElement>\("([^"]+)"\)/.exec(body)?.[1];
    expect(sel).toMatch(/\[data-pane\]$/);
  });
});
