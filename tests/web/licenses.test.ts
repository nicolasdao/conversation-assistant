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
