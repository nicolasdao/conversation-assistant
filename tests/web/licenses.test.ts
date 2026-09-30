// @vitest-environment happy-dom
// The Licenses and Acknowledgements page (web/src/licenses.ts, web/licenses.html; docs/desktop.md). The module runs at
// import: it reads GET /api/licenses (a fake here) and renders the list, so each test imports it fresh.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Licenses } from "../../web/src/api.ts";
import { installBrowserStubs, loadLicensesHtml, makeFakeApi } from "./helpers.ts";

const fake = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<object>()), api: fake }));

let listeners: [string, EventListenerOrEventListenerObject][] = [];

beforeEach(async () => {
  vi.resetModules();
  loadLicensesHtml();
  installBrowserStubs();
  Object.assign(fake, makeFakeApi((await vi.importActual<typeof import("../../web/src/api.ts")>("../../web/src/api.ts")).api));
  // the page adds a keydown listener to the document at import: remove it after each test, so old copies stay quiet
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
    listeners.push([type, fn]);
    add(type, fn, o);
  });
});

afterEach(() => {
  for (const [type, fn] of listeners) document.removeEventListener(type, fn);
  listeners = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { desktop?: unknown }).desktop;
});

function licenses(over: Partial<Licenses> = {}): Licenses {
  return {
    app: { name: "Tattle", version: "1.0.1", license: "MIT", holder: "Cloudless Consulting Pty Ltd <hello@example.com>", text: "MIT License text" },
    groups: [
      { title: "Components built into the app", components: [
        { title: "`sherpa-onnx`", license: "Apache-2.0", body: "Speech tools. See https://github.com/k2-fsa/sherpa-onnx.", files: ["licenses/sherpa/LICENSE"] },
      ] },
      { title: "npm packages in the app", components: [
        { title: "jquery", license: "MIT", body: "Copyright jQuery Foundation and other contributors <https://jquery.org/>", files: [] },
      ] },
    ],
    texts: { "licenses/sherpa/LICENSE": "Apache License 2.0" },
    ...over,
  };
}

async function open(l: Licenses | Error = licenses()) {
  if (l instanceof Error) fake.licenses!.mockRejectedValue(l);
  else fake.licenses!.mockResolvedValue(l);
  await import("../../web/src/licenses.ts");
}

const pick = (title: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("#lic-list .lic-item")].find((b) => b.querySelector(".lic-title")!.textContent === title)!;

describe("linkify (through a component's notice)", () => {
  // B4: `<https://x>` put the closing > inside the link, so 7 real notices (jQuery, bsdiff…) linked to "https://…>"
  test("<https://x> links to https://x, with the angle brackets as text", async () => {
    await open();
    pick("jquery").click();
    const a = document.querySelector<HTMLAnchorElement>("#lic-detail .md a")!;
    expect(a.getAttribute("href")).toBe("https://jquery.org/");
    expect(a.textContent).toBe("https://jquery.org/");
    expect(document.querySelector("#lic-detail .md p")!.textContent).toBe("Copyright jQuery Foundation and other contributors <https://jquery.org/>");
    expect(document.querySelector('#lic-detail a[href$=">"]')).toBeNull();
  });
});

describe("linkify, the rest", () => {
  const notice = async (body: string) => {
    await open(licenses({ groups: [{ title: "Other", components: [{ title: "c", license: "MIT", body, files: [] }] }] }));
    pick("c").click();
    return document.querySelector<HTMLElement>("#lic-detail .md")!;
  };

  test("a bare URL becomes a link; trailing . , ; : stay outside it", async () => {
    const md = await notice("see https://a.b/c. and http://x.y/z;, too");
    expect([...md.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://a.b/c", "http://x.y/z"]);
    expect(md.textContent).toBe("see https://a.b/c. and http://x.y/z;, too");
  });

  test("a URL in parentheses links without the closing paren", async () => {
    const md = await notice("(https://a.b)");
    expect(md.querySelector("a")!.getAttribute("href")).toBe("https://a.b");
    expect(md.textContent).toBe("(https://a.b)");
  });

  test("a URL that is already a markdown link's target is left alone", async () => {
    const md = await notice("[the site](https://a.b)");
    expect([...md.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["the site", "https://a.b"]]);
  });

  test("fenced code blocks are not linkified", async () => {
    const md = await notice("```\ncurl https://a.b\n```\nthen https://c.d");
    expect(md.querySelector("code")!.textContent).toBe("curl https://a.b");
    expect([...md.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://c.d"]);
  });

  test.fails("BUG LIC-L1: a URL inside inline code is not linkified (it shows as literal [url](url) text)", async () => {
    const md = await notice("run `https://a.b` now");
    expect(md.querySelector("code")!.textContent).toBe("https://a.b");
  });

  test.fails("BUG LIC-L2: a markdown link whose text is the URL itself is left alone, not garbled", async () => {
    const md = await notice("[https://a.b](https://a.b)");
    expect([...md.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["https://a.b", "https://a.b"]]);
  });
});

describe("the list", () => {
  test("the app's own license first, in group Tattle; then each group's components under a header, with renamed group titles", async () => {
    await open();
    expect([...document.querySelectorAll("#lic-list > *")].map((e) => `${e.className}:${e.textContent}`)).toEqual([
      "lic-group:Tattle", "lic-item:This appMIT",
      "lic-group:Built into the app", "lic-item:sherpa-onnxApache-2.0",
      "lic-group:npm packages", "lic-item:jqueryMIT",
    ]);
    const b = document.querySelector<HTMLButtonElement>("#lic-list .lic-item")!;
    expect([b.getAttribute("role"), b.dataset.index, b.querySelector(".lic-title")!.textContent, b.querySelector(".lic-lic")!.textContent]).toEqual(["option", "0", "This app", "MIT"]);
  });

  test("other group titles are kept as they are", async () => {
    await open(licenses({ groups: [{ title: "Fonts", components: [{ title: "Barlow", license: "OFL-1.1", body: "", files: [] }] }] }));
    expect([...document.querySelectorAll("#lic-list .lic-group")].map((g) => g.textContent)).toEqual(["Tattle", "Fonts"]);
  });

  test("the first item is selected: a title, the license chip, the holder without its email, and the license text", async () => {
    await open();
    const d = document.getElementById("lic-detail")!;
    expect(d.querySelector("header.lic-head > h1")!.textContent).toBe("This app");
    expect(d.querySelector("header.lic-head > span.lic-chip")!.textContent).toBe("MIT");
    expect(d.querySelector("p.lic-meta")!.textContent).toBe("Tattle 1.0.1 · Cloudless Consulting Pty Ltd");
    expect(d.querySelector("pre.license-text")!.textContent).toBe("MIT License text");
    expect([...document.querySelectorAll("#lic-list .lic-item")].map((b) => b.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  });

  test("the app with no license, no holder and no text: no chip, just name and version, and 'No LICENSE file.'", async () => {
    await open(licenses({ app: { name: "Tattle", version: "1.0.1", license: null, holder: null, text: "" } }));
    const d = document.getElementById("lic-detail")!;
    expect(d.querySelector(".lic-chip")).toBeNull();
    expect(d.querySelector("p.lic-meta")!.textContent).toBe("Tattle 1.0.1");
    expect(d.querySelector("pre.license-text")!.textContent).toBe("No LICENSE file.");
  });

  test("a component: its notice as Markdown, then one open details per file with 'Full text · <basename>'", async () => {
    await open();
    const d = document.getElementById("lic-detail")!;
    d.scrollTop = 50;
    pick("sherpa-onnx").click();
    expect(d.scrollTop).toBe(0);
    expect(d.querySelector("h1")!.textContent).toBe("sherpa-onnx");
    expect(d.querySelector(".md p")!.textContent).toBe("Speech tools. See https://github.com/k2-fsa/sherpa-onnx.");
    const file = d.querySelector<HTMLDetailsElement>("details.lic-file")!;
    expect([file.open, file.querySelector("summary")!.textContent, file.querySelector("pre.license-text")!.textContent]).toEqual([true, "Full text · LICENSE", "Apache License 2.0"]);
    expect([...document.querySelectorAll("#lic-list .lic-item")].map((b) => b.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  });

  test("a full text over 60 000 characters starts folded; at 60 000 it is open", async () => {
    const big = licenses();
    big.groups[0]!.components[0]!.files = ["a/LICENSE", "b/NOTICE"];
    big.texts = { "a/LICENSE": "x".repeat(60_000), "b/NOTICE": "y".repeat(60_001) };
    await open(big);
    pick("sherpa-onnx").click();
    expect([...document.querySelectorAll<HTMLDetailsElement>("#lic-detail details")].map((d) => d.open)).toEqual([true, false]);
  });

  test.fails("BUG LIC-L3: a file the server lists without its text still shows the component (fullText reads text.length of undefined)", async () => {
    const l = licenses();
    l.texts = {};
    await open(l);
    pick("sherpa-onnx").click();
    expect(document.querySelector("#lic-detail h1")!.textContent).toBe("sherpa-onnx");
  });
});

describe("search", () => {
  const search = (q: string) => {
    const input = document.querySelector<HTMLInputElement>("#lic-search")!;
    input.value = q;
    input.dispatchEvent(new Event("input"));
  };

  test("filters on title, license and text, ignoring case; the groups follow; the first match is selected when the current one is gone", async () => {
    await open();
    search("  APACHE ");
    expect([...document.querySelectorAll("#lic-list > *")].map((e) => e.textContent)).toEqual(["Built into the app", "sherpa-onnxApache-2.0"]);
    expect(document.querySelector("#lic-detail h1")!.textContent).toBe("sherpa-onnx");
    search("jquery foundation");
    expect(document.querySelector("#lic-detail h1")!.textContent).toBe("jquery");
  });

  test("no match: 'Nothing matches.' and the detail keeps the previous item; clearing shows everything and keeps the selection", async () => {
    await open();
    pick("jquery").click();
    search("zzz");
    expect(document.querySelector("#lic-list p.empty")!.textContent).toBe("Nothing matches.");
    expect(document.querySelector("#lic-detail h1")!.textContent).toBe("jquery");
    search("");
    expect(document.querySelectorAll("#lic-list .lic-item").length).toBe(3);
    expect(document.querySelector("#lic-detail h1")!.textContent).toBe("jquery");
    expect(pick("jquery").getAttribute("aria-selected")).toBe("true");
  });

  test("the arrows do nothing while the search matches nothing", async () => {
    await open();
    search("zzz");
    const e = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true, bubbles: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("the keyboard", () => {
  const key = (k: string) => {
    const e = new KeyboardEvent("keydown", { key: k, cancelable: true, bubbles: true });
    document.dispatchEvent(e);
    return e;
  };
  const title = () => document.querySelector("#lic-detail h1")!.textContent;

  test("↓ and ↑ move through the shown items, clamped at both ends, focusing the item and scrolling it into view", async () => {
    await open();
    const e = key("ArrowDown");
    expect([e.defaultPrevented, title()]).toEqual([true, "sherpa-onnx"]);
    expect(document.activeElement).toBe(pick("sherpa-onnx"));
    const spy = vi.mocked(Element.prototype.scrollIntoView);
    expect(spy.mock.contexts).toEqual([pick("sherpa-onnx")]);
    expect(spy).toHaveBeenCalledWith({ block: "nearest" });
    key("ArrowDown");
    key("ArrowDown");
    expect(title()).toBe("jquery");
    key("ArrowUp");
    key("ArrowUp");
    const top = key("ArrowUp");
    expect([top.defaultPrevented, title()]).toEqual([true, "This app"]);
  });

  test("other keys are ignored", async () => {
    await open();
    expect(key("Enter").defaultPrevented).toBe(false);
    expect(title()).toBe("This app");
  });

  test("the arrows do nothing when nothing could be loaded", async () => {
    await open(new Error("offline"));
    expect(key("ArrowDown").defaultPrevented).toBe(false);
  });
});

describe("the Mac app and errors", () => {
  test("in the Mac app, two more buttons ask the app for Chromium's licenses and the license files", async () => {
    const run = vi.fn();
    (globalThis as { desktop?: unknown }).desktop = { run, onCommand: vi.fn() };
    await open();
    expect(document.getElementById("lic-desktop")!.hidden).toBe(false);
    document.getElementById("lic-chromium")!.click();
    document.getElementById("lic-finder")!.click();
    expect(run.mock.calls).toEqual([["open-chromium-licenses"], ["show-license-files"]]);
  });

  test("in a browser they stay hidden", async () => {
    await open();
    expect(document.getElementById("lic-desktop")!.hidden).toBe(true);
  });

  test("a failed request says so in the detail pane", async () => {
    await open(new Error("offline"));
    expect(document.querySelector("#lic-detail p.error-text")!.textContent).toBe("The licenses could not be loaded: offline");
  });

  test("a rejection that is not an Error is shown as text", async () => {
    fake.licenses!.mockRejectedValue("nope");
    await import("../../web/src/licenses.ts");
    expect(document.querySelector("#lic-detail p.error-text")!.textContent).toBe("The licenses could not be loaded: nope");
  });
});
