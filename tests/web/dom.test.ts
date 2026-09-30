// @vitest-environment happy-dom
// The page's tiny DOM helpers (web/src/dom.ts): the element and SVG builders, glyphs and icons, and the formatters.
import { describe, expect, test, vi } from "vitest";
import { $, clock, glyph, h, icon, pluralOf, pretty, replace, s, usd } from "../../web/src/dom.ts";

describe("clock", () => {
  test.each([
    [0, "0:00"], [59_999, "0:59"], [247_000, "4:07"], [3_600_000, "1:00:00"], [3_723_000, "1:02:03"], [3_847_000, "1:04:07"], [-5000, "0:00"],
  ])("clock(%i) is %s", (ms, text) => expect(clock(ms)).toBe(text));
});

describe("usd", () => {
  test("four decimals under a cent, two from a cent", () => {
    expect([usd(0.005), usd(0), usd(0.0099), usd(0.01), usd(12.345), usd(3)]).toEqual(["$0.0050", "$0.0000", "$0.0099", "$0.01", "$12.35", "$3.00"]);
  });

  test("a negative amount takes the four-decimal branch (a quirk: '$-1.0000')", () => {
    expect(usd(-1)).toBe("$-1.0000");
  });
});

describe("pretty", () => {
  test("replaces every underscore with a space, and leaves ids without one alone", () => {
    expect([pretty("ai_models"), pretty("a_b_c"), pretty("tech")]).toEqual(["ai models", "a b c", "tech"]);
  });
});

describe("pluralOf", () => {
  test.each([
    ["Disagreement", "Disagreements"], ["Category", "Categories"], ["Day", "Days"], ["Box", "Boxes"], ["Match", "Matches"],
    ["Wish", "Wishes"], ["Bus", "Buses"], ["subject", "subjects"], ["STORY", "STORies"],
  ])("pluralOf(%s) is %s", (word, plural) => expect(pluralOf(word)).toBe(plural));
});

describe("h", () => {
  test("creates the tag with string attributes; skips null, undefined and false; true is an empty attribute; numbers are strings", () => {
    const el = h("button", { class: "btn", id: "x", title: null, "aria-label": undefined, hidden: false, disabled: true, tabindex: 0 });
    expect(el.tagName).toBe("BUTTON");
    expect(el.getAttribute("class")).toBe("btn");
    expect(el.id).toBe("x");
    expect(["title", "aria-label", "hidden"].map((a) => el.hasAttribute(a))).toEqual([false, false, false]);
    expect(el.getAttribute("disabled")).toBe("");
    expect(el.getAttribute("tabindex")).toBe("0");
  });

  test("an on* function becomes a listener, not an attribute", () => {
    const fn = vi.fn();
    const el = h("button", { onclick: fn });
    expect(el.hasAttribute("onclick")).toBe(false);
    el.click();
    expect(fn).toHaveBeenCalledOnce();
  });

  test("an on* key whose value is not a function is an attribute", () => {
    expect(h("div", { "one-way": "x", on: "y" }).getAttribute("on")).toBe("y");
  });

  test("value is set as a property on elements that have one, and as an attribute on others", () => {
    const input = h("input", { value: "abc" });
    expect(input.value).toBe("abc");
    expect(input.hasAttribute("value")).toBe(false);
    expect(h("textarea", { value: 3 }).value).toBe("3");
    expect(h("div", { value: "v" }).getAttribute("value")).toBe("v");
  });

  test("children: nested arrays flatten at any depth; null, undefined and false are skipped, but 0 renders as '0'", () => {
    const el = h("p", {}, "a", ["b", ["c", [null, "d"]]], undefined, false, 0, 7);
    expect(el.textContent).toBe("abcd07");
    expect(el.childNodes.length).toBe(6);
  });

  test("strings stay text, so markup is never parsed", () => {
    const el = h("div", {}, "<b>bold</b>");
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toBe("<b>bold</b>");
  });

  test("nodes are appended as they are", () => {
    const child = h("span", {}, "x");
    expect(h("div", {}, child).firstChild).toBe(child);
  });
});

describe("s, glyph, icon", () => {
  test("s creates an element in the SVG namespace with its attributes and children", () => {
    const el = s("svg", { viewBox: "0 0 10 10" }, s("line", { x1: 0 }));
    expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(el.getAttribute("viewBox")).toBe("0 0 10 10");
    expect(el.firstElementChild!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(el.firstElementChild!.getAttribute("x1")).toBe("0");
  });

  test("glyph('flag') is svg.g[aria-hidden] > use[href='#g-flag'], with an optional class", () => {
    const g = glyph("flag");
    expect([g.getAttribute("class"), g.getAttribute("aria-hidden"), g.querySelector("use")!.getAttribute("href")]).toEqual(["g", "true", "#g-flag"]);
    expect(glyph("play", "big").getAttribute("class")).toBe("big");
  });

  test("icon('bolt') uses the marker icon library, #i-bolt", () => {
    const i = icon("bolt");
    expect([i.getAttribute("class"), i.getAttribute("aria-hidden"), i.querySelector("use")!.getAttribute("href")]).toEqual(["g", "true", "#i-bolt"]);
    expect(icon("star", "mk").getAttribute("class")).toBe("mk");
  });
});

describe("replace and $", () => {
  test("replace(null, …) does nothing", () => {
    expect(() => replace(null, "x")).not.toThrow();
  });

  test("replace empties the element then appends the children", () => {
    const el = h("div", {}, h("span", {}, "old"), "text");
    replace(el, "new", [h("b", {}, "!")], null);
    expect(el.innerHTML).toBe("new<b>!</b>");
    replace(el);
    expect(el.childNodes.length).toBe(0);
  });

  test("$ returns the first match, or null", () => {
    document.body.innerHTML = `<p class="a" id="one"></p><p class="a" id="two"></p>`;
    expect($(".a")!.id).toBe("one");
    expect($(".missing")).toBeNull();
  });
});
