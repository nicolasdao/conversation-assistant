// @vitest-environment happy-dom
// The bespoke controls (web/src/ui.ts): every <select> upgraded into a button and a listbox that follows the native
// select, styled tooltips from `title`, and no autofill. The layout sizes happy-dom reports as 0 are set by hand.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flush, layout } from "./helpers.ts";
import { all, freshPage, key } from "./helpers-core.ts";

type Ui = typeof import("../../web/src/ui.ts");
let ui: Ui;

const SELECT = `<label for="s">Microphone</label>
  <select id="s" class="mic" title="Pick one"><option value="a">Apple</option><option value="b" selected>Banana</option><option value="c" disabled>Cherry</option><option value="h" hidden>Hidden</option><option value="d">Blueberry</option></select>`;

/** A fresh page with this markup, upgraded. */
async function page(html = SELECT) {
  freshPage();
  document.body.innerHTML = html;
  ui = await import("../../web/src/ui.ts");
  ui.bindBespoke();
}
const option = (label: string, value: string) => Object.assign(document.createElement("option"), { textContent: label, value });
const sel = (id = "s") => document.getElementById(id) as HTMLSelectElement;
const btn = (id = "s") => sel(id).parentElement!.querySelector<HTMLButtonElement>(".sel-btn")!;
const list = () => document.querySelector<HTMLElement>(".sel-list");
const opts = () => all(".sel-list .sel-opt");
const activeIndex = () => opts().findIndex((o) => o.classList.contains("active"));

afterEach(() => vi.useRealTimers());

describe("place", () => {
  beforeEach(async () => {
    await page("<div id=a></div><div id=p></div>");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  });
  const pop = (scrollHeight: number, offsetWidth = 250) => {
    const p = document.getElementById("p")!;
    layout(p, { scrollHeight });
    Object.defineProperty(p, "offsetWidth", { configurable: true, value: offsetWidth });
    return p;
  };
  const anchor = (rect: Partial<DOMRect>) => { const a = document.getElementById("a")!; layout(a, { rect }); return a; };

  test("below the anchor, with the gap, at least as wide as it", () => {
    const p = pop(200);
    ui.place(p, anchor({ top: 100, left: 50, width: 200, height: 30 }));
    expect([p.style.minWidth, p.style.maxHeight, p.style.left, p.style.top]).toEqual(["200px", "320px", "50px", "134px"]);
    ui.place(p, anchor({ top: 100, left: 50, width: 200, height: 30 }), 10);
    expect(p.style.top).toBe("140px");
  });

  test("above the anchor when there is no room below and more above", () => {
    const p = pop(400);
    ui.place(p, anchor({ top: 700, left: 50, width: 200, height: 30 }));
    expect([p.style.maxHeight, p.style.top]).toEqual(["320px", "376px"]);
  });

  test("the height stays within 120 to 320 px, and the left edge within 8 px of the window", () => {
    const p = pop(200);
    ui.place(p, anchor({ top: 50, left: 1000, width: 20, height: 730 }));
    expect([p.style.maxHeight, p.style.top, p.style.left]).toEqual(["120px", "8px", "766px"]);
    ui.place(p, anchor({ top: 100, left: -20, width: 20, height: 20 }));
    expect(p.style.left).toBe("8px");
    const short = pop(50);
    ui.place(short, anchor({ top: 100, left: 0, width: 20, height: 600 }));
    expect([short.style.maxHeight, short.style.top]).toEqual(["120px", "704px"]); // room 88 < 120, but the list fits below
  });
});

describe("a select, upgraded", () => {
  beforeEach(() => page());

  test("is wrapped with a combobox button showing the selected option; the select stays, hidden, as the truth", () => {
    const wrap = sel().parentElement!;
    expect([wrap.tagName, wrap.className]).toEqual(["SPAN", "sel mic"]);
    expect([sel().hidden, sel().tabIndex, sel().dataset.bespoke]).toEqual([true, -1, "1"]);
    expect([btn().getAttribute("role"), btn().getAttribute("aria-haspopup"), btn().getAttribute("aria-expanded"), btn().textContent]).toEqual(["combobox", "listbox", "false", "Banana"]);
    expect(btn().getAttribute("aria-label")).toBe("Microphone: Banana");
  });

  test("its title moves to the wrapper", () => {
    expect([sel().parentElement!.getAttribute("title") ?? sel().parentElement!.getAttribute("data-tip"), sel().hasAttribute("title")]).toEqual(["Pick one", false]);
  });

  test("is upgraded once", () => {
    ui.bindBespoke();
    expect(all(".sel")).toHaveLength(1);
  });

  test("setting .value or .selectedIndex from code shows at once", () => {
    sel().value = "a";
    expect([btn().textContent, sel().value]).toEqual(["Apple", "a"]);
    sel().selectedIndex = 4;
    expect([btn().textContent, sel().selectedIndex]).toEqual(["Blueberry", 4]);
  });

  test("new options, or disabling it, show too", async () => {
    sel().replaceChildren(option("Kiwi", "k"));
    await flush();
    expect(btn().textContent).toBe("Kiwi");
    sel().disabled = true;
    await flush();
    expect(btn().disabled).toBe(true);
    btn().click();
    expect(list()).toBeNull();
    sel().replaceChildren();
    await flush();
    expect([btn().textContent, btn().getAttribute("aria-label")]).toEqual(["", "Microphone"]);
  });

  test("a click opens its list: every visible option, the selected one marked and highlighted, the disabled one marked", () => {
    btn().click();
    const l = list()!;
    expect([l.parentElement, l.getAttribute("role"), l.getAttribute("aria-label"), l.matches(":popover-open")]).toEqual([document.body, "listbox", "Microphone", true]);
    expect(opts().map((o) => o.textContent)).toEqual(["Apple", "Banana", "Cherry", "Blueberry"]);
    expect(opts().map((o) => o.className)).toEqual(["sel-opt", "sel-opt selected active", "sel-opt disabled", "sel-opt"]);
    expect(opts().map((o) => [o.getAttribute("aria-selected"), o.getAttribute("aria-disabled")])).toEqual([["false", null], ["true", null], ["false", "true"], ["false", null]]);
    expect([btn().getAttribute("aria-expanded"), btn().getAttribute("aria-controls"), btn().getAttribute("aria-activedescendant")]).toEqual(["true", l.id, `${l.id}-1`]);
    expect(sel().parentElement!.classList.contains("open")).toBe(true);
    btn().click();
    expect([list(), btn().getAttribute("aria-expanded"), btn().hasAttribute("aria-activedescendant")]).toEqual([null, "false", false]);
  });

  test("choosing an option sets the value, fires input and change once, closes, and focuses the button; the same value fires nothing", () => {
    const events: string[] = [];
    sel().addEventListener("input", () => events.push("input"));
    sel().addEventListener("change", () => events.push("change"));
    btn().click();
    const down = new Event("pointerdown", { cancelable: true });
    opts()[0]!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // focus stays on the button
    opts()[0]!.click();
    expect([sel().value, btn().textContent, events, list(), document.activeElement]).toEqual(["a", "Apple", ["input", "change"], null, btn()]);
    btn().click();
    opts()[0]!.click();
    expect(events).toEqual(["input", "change"]);
  });

  test("a disabled option cannot be chosen by click or Enter", () => {
    btn().click();
    opts()[2]!.click();
    expect(list()).not.toBeNull();
    opts()[2]!.dispatchEvent(new Event("pointermove"));
    expect(activeIndex()).toBe(2);
    key(btn(), "Enter");
    expect([sel().value, list() !== null]).toEqual(["b", true]);
  });

  test.each(["ArrowDown", "ArrowUp", "Enter", " "])("%j opens a closed list, and nothing else leaks", (k) => {
    const e = key(btn(), k);
    expect([list() !== null, e.defaultPrevented]).toEqual([true, true]);
  });

  test("other keys leave a closed list closed", () => {
    expect([key(btn(), "a").defaultPrevented, list()]).toEqual([false, null]);
  });

  test("in an open list the arrows, Home, End and the page keys move the highlight within bounds; keys stay in the list", () => {
    let leaked = 0;
    document.body.addEventListener("keydown", () => leaked++);
    btn().click();
    key(btn(), "ArrowDown");
    expect(activeIndex()).toBe(2);
    key(btn(), "ArrowDown");
    key(btn(), "ArrowDown");
    expect(activeIndex()).toBe(3);
    key(btn(), "Home");
    expect(activeIndex()).toBe(0);
    key(btn(), "ArrowUp");
    expect(activeIndex()).toBe(0);
    key(btn(), "End");
    expect(activeIndex()).toBe(3);
    key(btn(), "PageUp");
    expect(activeIndex()).toBe(0);
    key(btn(), "PageDown");
    expect(activeIndex()).toBe(3);
    expect(leaked).toBe(0);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  test("Enter and Space choose the highlighted option; Escape and Tab close", () => {
    btn().click();
    key(btn(), "Home");
    key(btn(), "Enter");
    expect([sel().value, list()]).toEqual(["a", null]);
    btn().click();
    key(btn(), "End");
    key(btn(), " ");
    expect(sel().value).toBe("d");
    btn().click();
    key(btn(), "Escape");
    expect(list()).toBeNull();
    btn().click();
    key(btn(), "Tab");
    expect(list()).toBeNull();
  });

  test("typing jumps to the option starting with what was typed; a pause of 700 ms starts over", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    btn().click();
    key(btn(), "b");
    expect(activeIndex()).toBe(1);
    key(btn(), "l");
    expect(activeIndex()).toBe(3);
    key(btn(), "z");
    expect(activeIndex()).toBe(3); // no match: stays
    vi.advanceTimersByTime(701);
    key(btn(), "a");
    expect(activeIndex()).toBe(0);
    key(btn(), "Shift");
    expect(activeIndex()).toBe(0);
  });

  test("opening another list closes the first", async () => {
    await page(`${SELECT}<select id="t"><option>One</option></select>`);
    btn().click();
    btn("t").click();
    expect([all(".sel-list").length, btn().getAttribute("aria-expanded"), btn("t").getAttribute("aria-expanded")]).toEqual([1, "false", "true"]);
  });

  test("losing focus closes the list, unless focus came back to the button", async () => {
    btn().click();
    btn().focus();
    btn().dispatchEvent(new Event("blur"));
    await flush();
    expect(list()).not.toBeNull();
    btn().blur();
    await flush();
    expect(list()).toBeNull();
  });

  test("a pointer down outside, a resize, or a scroll outside the list closes it; inside, it stays", () => {
    btn().click();
    list()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    btn().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    list()!.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(list()).not.toBeNull();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(list()).toBeNull();
    btn().click();
    window.dispatchEvent(new Event("resize"));
    expect(list()).toBeNull();
    btn().click();
    document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(list()).toBeNull();
    // with nothing open these do nothing
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    document.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  });

  test("a click on its label focuses the button instead of the hidden select", () => {
    const l = document.querySelector("label")!;
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    l.dispatchEvent(e);
    expect([e.defaultPrevented, document.activeElement]).toEqual([true, btn()]);
  });

  test("an aria-label names it; without a label or options it has an empty name", async () => {
    await page(`<select id="s" aria-label="Speed"><option>1×</option></select><select id="t"></select>`);
    expect(btn().getAttribute("aria-label")).toBe("Speed: 1×");
    expect([btn("t").getAttribute("aria-label"), btn("t").textContent]).toEqual(["", ""]);
    btn("t").click();
    expect(opts()).toHaveLength(0);
    key(btn("t"), "ArrowDown");
    key(btn("t"), "Enter");
    expect(list()).not.toBeNull();
  });

  // ui.ts: the name comes from the label's whole text; a label that wraps its select (index.html's Microphone and
  // People pickers) holds every option's text too, so a screen reader reads them all as the name (inventory 4 §14.12).
  test.fails("BUG §14.12: a label that wraps its select names the combobox with the label's own words only", async () => {
    await page(`<label>Microphone <select id="s"><option>Built-in</option><option>Rode</option></select></label>`);
    expect(btn().getAttribute("aria-label")).toBe("Microphone: Built-in");
  });
});

describe("lists inside a modal dialog", () => {
  test("open inside the dialog, where they can be clicked (a modal makes the rest of the page inert)", async () => {
    await page(`<dialog id="d">${SELECT}</dialog>`);
    const d = document.getElementById("d") as HTMLDialogElement;
    d.showModal();
    btn().click();
    expect(list()!.parentElement).toBe(d);
    opts()[0]!.click();
    expect(sel().value).toBe("a");
    d.close();
    btn().click();
    expect(list()!.parentElement).toBe(document.body);
  });
});

describe("the rest of the page", () => {
  test("text fields get autocomplete off unless they say otherwise; selects added later are upgraded", async () => {
    await page(`<input id="i"><input id="j" autocomplete="name"><textarea id="x"></textarea><div id="later"></div>`);
    expect(["i", "j", "x"].map((id) => document.getElementById(id)!.getAttribute("autocomplete"))).toEqual(["off", "name", "off"]);
    const s = document.createElement("select");
    s.id = "s2";
    s.append(option("Late", "l"));
    document.getElementById("later")!.append(s, document.createTextNode("text"));
    const box = document.createElement("div");
    box.innerHTML = `<select id="s3"><option>Inside</option></select><input id="k">`;
    document.body.append(box);
    await flush();
    expect([btn("s2").textContent, btn("s3").textContent, document.getElementById("k")!.getAttribute("autocomplete")]).toEqual(["Late", "Inside", "off"]);
  });
});

describe("tooltips", () => {
  const tip = () => document.querySelector<HTMLElement>(".tip")!;
  const over = (el: Element) => el.dispatchEvent(new Event("pointerover", { bubbles: true }));
  beforeEach(async () => {
    await page(`<button id="b" title="Save the recording"><span id="inner">Save</span></button><button id="e" title="">Empty</button><p id="plain">x</p><button id="c" title="Close">×</button>`);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    layout(tip(), { offsetHeight: 30 });
    Object.defineProperty(tip(), "offsetWidth", { configurable: true, value: 100 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  test("hovering an element with a title shows the tooltip after 450 ms, above it, and moves the title so the browser's never shows", () => {
    const b = document.getElementById("b")!;
    layout(b, { rect: { top: 100, left: 200, width: 60, height: 20 } });
    over(document.getElementById("inner")!);
    expect([b.hasAttribute("title"), b.getAttribute("data-tip"), b.getAttribute("aria-description")]).toEqual([false, "Save the recording", "Save the recording"]);
    vi.advanceTimersByTime(449);
    expect(tip().matches(":popover-open")).toBe(false);
    vi.advanceTimersByTime(1);
    expect([tip().matches(":popover-open"), tip().textContent, tip().style.left, tip().style.top, tip().classList.contains("below")]).toEqual([true, "Save the recording", "180px", "62px", false]);
    expect([tip().getAttribute("role"), tip().getAttribute("popover")]).toEqual(["tooltip", "manual"]);
  });

  test("near the top of the window it shows below; it stays within the window's sides", () => {
    const b = document.getElementById("b")!;
    layout(b, { rect: { top: 10, left: 1000, width: 60, height: 20 } });
    over(b);
    vi.advanceTimersByTime(450);
    expect([tip().style.top, tip().style.left, tip().classList.contains("below")]).toEqual(["38px", "918px", true]);
    layout(b, { rect: { top: 100, left: 0, width: 10, height: 20 } });
    over(document.getElementById("plain")!);
    over(b);
    vi.advanceTimersByTime(450);
    expect([tip().style.left, tip().classList.contains("below")]).toEqual(["6px", false]);
  });

  test("moving within the same element does not restart it; leaving it, or anything else, hides it", () => {
    const b = document.getElementById("b")!;
    over(b);
    vi.advanceTimersByTime(300);
    over(b);
    vi.advanceTimersByTime(150);
    expect(tip().matches(":popover-open")).toBe(true);
    const out = (related: Node | null) => { const e = new Event("pointerout", { bubbles: true }); Object.defineProperty(e, "relatedTarget", { value: related }); b.dispatchEvent(e); };
    out(document.getElementById("inner"));
    expect(tip().matches(":popover-open")).toBe(true);
    out(document.body);
    expect(tip().matches(":popover-open")).toBe(false);
    out(document.body); // nothing to hide
    for (const [type, target] of [["focusout", b], ["pointerdown", b], ["keydown", b], ["scroll", document.body]] as const) {
      over(document.getElementById("plain")!);
      over(b);
      vi.advanceTimersByTime(450);
      expect(tip().matches(":popover-open")).toBe(true);
      target.dispatchEvent(new Event(type, { bubbles: true }));
      expect(tip().matches(":popover-open")).toBe(false);
    }
  });

  test("an element without a title hides it; an empty title shows nothing", () => {
    over(document.getElementById("b")!);
    vi.advanceTimersByTime(450);
    over(document.getElementById("plain")!);
    expect(tip().matches(":popover-open")).toBe(false);
    const e = document.getElementById("e")!;
    e.setAttribute("data-tip", "old");
    over(e);
    vi.advanceTimersByTime(1000);
    expect([tip().matches(":popover-open"), e.hasAttribute("data-tip"), e.hasAttribute("title")]).toEqual([false, false, false]);
  });

  test("a title set again later is taken again", () => {
    const b = document.getElementById("b")!;
    over(b);
    over(document.getElementById("plain")!);
    b.setAttribute("title", "Saved");
    over(b);
    vi.advanceTimersByTime(450);
    expect(tip().textContent).toBe("Saved");
  });

  test("an element removed before the delay shows nothing", () => {
    const b = document.getElementById("b")!;
    over(b);
    b.remove();
    vi.advanceTimersByTime(450);
    expect(tip().matches(":popover-open")).toBe(false);
  });

  test("a second tooltip re-opens the popover, so it stacks above a dialog opened since", () => {
    over(document.getElementById("b")!);
    vi.advanceTimersByTime(450);
    const hide = vi.spyOn(tip(), "hidePopover");
    // a tooltip already showing when the next one's delay ends (hide() only runs through the listeners)
    over(document.getElementById("c")!);
    expect(hide).toHaveBeenCalledTimes(1);
    (tip() as HTMLElement & { showPopover(): void }).showPopover();
    vi.advanceTimersByTime(450);
    expect([hide.mock.calls.length, tip().textContent]).toEqual([2, "Close"]);
  });

  test("keyboard focus shows it after 250 ms, only when the focus is visible", () => {
    const c = document.getElementById("c")!;
    c.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(tip().matches(":popover-open")).toBe(false);
    const matches = c.matches.bind(c);
    c.matches = ((s: string) => s === ":focus-visible" || matches(s)) as typeof c.matches;
    c.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(249);
    expect(tip().matches(":popover-open")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(tip().textContent).toBe("Close");
    const p = document.getElementById("plain")!;
    p.matches = ((s: string) => s === ":focus-visible" || matches(s)) as typeof p.matches;
    p.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); // nothing to show
  });
});
