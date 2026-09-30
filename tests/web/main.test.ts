// @vitest-environment happy-dom
// The page's boot (web/src/main.ts) and the Mac app's bridge (web/src/desktop.ts): the setup screen or the app, never
// both; the Mac app's own marks. The app itself (app.ts) is replaced by a stub that records it was loaded.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SetupStatus } from "../../web/src/api.ts";
import { freshPage, resetApi, type FakeApi } from "./helpers-core.ts";

const fake = vi.hoisted(() => ({}) as FakeApi);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<typeof import("../../web/src/api.ts")>()), api: fake }));

const bridge = { onCommand: vi.fn(), run: vi.fn() };
const unconfigured: SetupStatus = {
  configured: false, required: ["openai"], path: "~/x",
  keys: [{ name: "openai", env: "OPENAI_API_KEY", set: false, source: null, hint: null }, { name: "openrouter", env: "OPENROUTER_API_KEY", set: false, source: null, hint: null }],
};

/** Boots the page as the browser would load /dist/main.js, with app.ts stubbed; returns whether the app loaded. */
async function boot(opts: { desktop?: unknown } = {}): Promise<{ appLoaded: boolean }> {
  freshPage(opts);
  document.body.classList.add("booting");
  let appLoaded = false;
  vi.doMock("../../web/src/app.ts", () => { appLoaded = true; return {}; });
  await import("../../web/src/main.ts");
  return { appLoaded };
}

beforeEach(async () => { await resetApi(fake); });

describe("desktop.ts", () => {
  test("in a browser there is no bridge", async () => {
    freshPage();
    expect((await import("../../web/src/desktop.ts")).desktop).toBeUndefined();
  });

  test("in the Mac app it is the preload's bridge, read when the module loads", async () => {
    freshPage({ desktop: bridge });
    const { desktop } = await import("../../web/src/desktop.ts");
    expect(desktop).toBe(bridge);
    delete (globalThis as { desktop?: unknown }).desktop;
    expect((await import("../../web/src/desktop.ts")).desktop).toBe(bridge);
  });
});

describe("main.ts", () => {
  test("in the Mac app the body gets in-app, so the browser-only items leave the page", async () => {
    fake.setup!.mockResolvedValue({ ...unconfigured, configured: true });
    await boot({ desktop: bridge });
    expect(document.body.classList.contains("in-app")).toBe(true);
  });

  test("in a browser it does not", async () => {
    fake.setup!.mockResolvedValue({ ...unconfigured, configured: true });
    await boot();
    expect(document.body.classList.contains("in-app")).toBe(false);
  });

  test("not configured: the setup screen shows with what the engine says, the page shows, and the app never loads", async () => {
    fake.setup!.mockResolvedValue(unconfigured);
    fake.transcription!.mockResolvedValue({ engine: "openai", saved: null, openai: { keySet: false }, apple: { available: false, reason: "old Mac", model: "missing", fraction: null, error: null } });
    const { appLoaded } = await boot();
    expect(appLoaded).toBe(false);
    expect(document.body.classList.contains("booting")).toBe(false);
    expect(document.body.classList.contains("setup-mode")).toBe(true);
    expect(document.querySelector("#setup h1")?.textContent).toBe("Add your OpenAI API key to start");
    expect(document.querySelector("#setup .setup-lede")?.textContent).toMatch(/^On-device transcription needs macOS 26/);
    expect(fake.transcription).toHaveBeenCalledTimes(1);
  });

  test("configured: the page shows and the app loads, without asking about transcription", async () => {
    fake.setup!.mockResolvedValue({ ...unconfigured, configured: true });
    const { appLoaded } = await boot();
    expect([appLoaded, document.body.classList.contains("booting"), document.querySelector("#setup")]).toEqual([true, false, null]);
    expect(fake.transcription).not.toHaveBeenCalled();
  });

  test("a server without the setup route (null): the app loads anyway", async () => {
    fake.setup!.mockRejectedValue(new Error("404"));
    const { appLoaded } = await boot();
    expect([appLoaded, document.body.classList.contains("booting")]).toEqual([true, false]);
  });
});
