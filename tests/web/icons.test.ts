// The marker icons (web/src/icons.ts): "one `<symbol id="i-<name>">` each in index.html … so an icon exists everywhere
// or nowhere". A pure module, tested in node.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ICONS } from "../../web/src/icons.ts";

const html = readFileSync("web/index.html", "utf8");
const symbols = [...html.matchAll(/<symbol\b[^>]*\bid="i-([^"]+)"/g)].map((m) => m[1]);

describe("ICONS", () => {
  test("30 distinct names", () => {
    expect(ICONS.length).toBe(30);
    expect(new Set(ICONS).size).toBe(30);
  });

  test("every icon has its symbol in index.html, and every i- symbol is in the list", () => {
    expect([...symbols].sort()).toEqual([...ICONS].sort());
  });

  test("the built-in set's markers use icons from the list", () => {
    const set = JSON.parse(readFileSync("config/labels/ai-podcast.json", "utf8")) as { markers: { icon: string }[] };
    for (const m of set.markers) expect(ICONS).toContain(m.icon);
  });
});
