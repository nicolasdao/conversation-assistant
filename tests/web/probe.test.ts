// @vitest-environment happy-dom
// What the page code needs from the DOM, checked against happy-dom 20. The first block pins down happy-dom's own
// behaviour (so an upgrade that changes it is noticed); the second checks the shims in helpers.ts.
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAudio, FakeAudioContext, FakeEventSource, installBrowserStubs, layout, loadIndexHtml } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("happy-dom as it is", () => {
  test("dialogs: showModal, close with a return value, and a form with method=dialog", () => {
    document.body.innerHTML = `<dialog id="d"><form method="dialog"><button id="b" value="ok">ok</button></form></dialog>`;
    const d = document.getElementById("d") as HTMLDialogElement;
    const closes: string[] = [];
    d.addEventListener("close", () => closes.push(d.returnValue));
    d.showModal();
    expect(d.open).toBe(true);
    d.close("yes");
    // unlike a browser, which fires it in a later task, happy-dom fires close synchronously
    expect([d.open, d.returnValue, closes]).toEqual([false, "yes", ["yes"]]);
    d.showModal();
    (document.getElementById("b") as HTMLButtonElement).click();
    expect([d.open, d.returnValue]).toEqual([false, "ok"]);
  });

  test("has history, selects, pointer events, clipboard, and animation frames; lacks the Popover API, EventSource and AudioContext", () => {
    history.pushState(null, "", "/recordings/x?t=1");
    expect(location.pathname + location.search).toBe("/recordings/x?t=1");
    document.body.innerHTML = `<label for="s">L</label><select id="s"><option value="a">A</option><option value="b">B</option></select><div id="p" popover></div><button id="x">x</button>`;
    const s = document.getElementById("s") as HTMLSelectElement;
    expect(s.labels?.length).toBe(1);
    expect(typeof Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set).toBe("function");
    expect(typeof Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex")?.set).toBe("function");
    s.value = "b";
    expect(s.selectedIndex).toBe(1);
    expect(typeof PointerEvent).toBe("function");
    expect(typeof HTMLElement.prototype.setPointerCapture).toBe("function");
    expect(typeof HTMLElement.prototype.scrollIntoView).toBe("function");
    expect(typeof navigator.clipboard.writeText).toBe("function");
    expect(typeof requestAnimationFrame).toBe("function");
    expect(document.getElementById("x")!.matches(":focus-visible")).toBe(false); // parses; not focused
    const p = document.getElementById("p") as HTMLElement & { showPopover?: unknown };
    expect(p.showPopover).toBeUndefined();
    expect(p.matches(":popover-open")).toBe(false); // parses, but is never true
    expect((globalThis as { EventSource?: unknown }).EventSource).toBeUndefined();
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
  });

  test("the network stays off in DOM tests too", () => {
    expect(() => fetch("/api/state")).toThrow("network disabled in tests");
  });
});

describe("the shims (installBrowserStubs)", () => {
  test("popovers open and close, and :popover-open follows them", () => {
    installBrowserStubs();
    document.body.innerHTML = `<div id="p" popover="manual"></div>`;
    const p = document.getElementById("p") as HTMLElement & { showPopover(): void; hidePopover(): void; togglePopover(f?: boolean): boolean };
    p.showPopover();
    expect(p.matches(":popover-open")).toBe(true);
    p.hidePopover();
    expect(p.matches(":popover-open")).toBe(false);
    expect(p.togglePopover()).toBe(true);
    expect(p.matches(":popover-open")).toBe(true);
    expect(p.matches("div")).toBe(true); // other selectors still work
  });

  test("EventSource, Audio and AudioContext are fakes the test drives; window.open records", async () => {
    const { open } = installBrowserStubs();
    const es = new EventSource("/api/events") as unknown as FakeEventSource;
    const got: string[] = [];
    es.addEventListener("utterance", (e) => got.push((e as MessageEvent).data));
    es.open();
    es.emit("utterance", { id: "u_1" });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect([es.readyState, got]).toEqual([1, ['{"id":"u_1"}']]);
    const a = new Audio("/x.wav") as unknown as FakeAudio;
    await a.play();
    expect([a.paused, FakeAudio.instances.length]).toEqual([false, 1]);
    const ctx = new AudioContext() as unknown as FakeAudioContext;
    expect(ctx.createGain().gain.value).toBe(1);
    window.open("https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com");
  });

  test("layout sets the sizes happy-dom reports as 0, and the page's markup loads", () => {
    loadIndexHtml();
    const tl = document.getElementById("pane-fc")!;
    layout(tl, { clientWidth: 1000, rect: { left: 10, width: 1000 } });
    expect([tl.clientWidth, tl.getBoundingClientRect().right]).toEqual([1000, 1010]);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.getElementById("dlg-insights")).not.toBeNull();
  });
});
