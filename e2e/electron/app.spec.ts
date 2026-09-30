// The Mac app in development (docs/desktop.md): its window, its bridge to the page, the menu bar, the guards on the
// window, and the single-instance lock. It never starts a session, sends a chat message or saves keys: those are in
// the web end-to-end tests, and here the main process has no network.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, isolatedFolders, macApp, ROOT, test } from "./fixture.ts";

test("opens one window titled Tattle at app://conversation-assistant/, with the development paths", async ({ mac }) => {
  expect(mac.app.windows()).toHaveLength(1);
  expect(mac.window.url()).toBe("app://conversation-assistant/");
  await expect(mac.window).toHaveTitle("Tattle");
  expect(await mac.app.evaluate(({ app }) => app.isPackaged)).toBe(false);
  // everything the app keeps is in the isolated HOME: nothing is shared with an installed Tattle
  expect(await mac.app.evaluate(({ app }) => app.getPath("userData"))).toBe(join(mac.home, "Library", "Application Support", "Tattle", "Window"));
  await expect(mac.window.locator("#session-name")).toHaveText("No session");
});

test.describe("with no keys", () => {
  test.use({ keys: false });
  test("shows the setup screen, which asks for the OpenAI key", async ({ mac }) => {
    await expect(mac.window.locator("main#setup")).toBeVisible();
    await expect(mac.window.locator("main#setup h1")).toHaveText("Add your OpenAI API key to start");
    await expect(mac.window.locator("body")).toHaveClass(/in-app/);
    await expect(mac.window.locator("main#setup")).toContainText("Settings…"); // the in-app hint to the menu bar
  });
});

test("the page gets window.desktop and nothing of Node", async ({ mac }) => {
  const got = await mac.window.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    return [typeof w.desktop?.onCommand, typeof w.desktop?.run, typeof w.require, typeof w.process];
  });
  expect(got).toEqual(["function", "function", "undefined", "undefined"]);
});

test("the API answers over app://, with the page's Content Security Policy", async ({ mac }) => {
  const state = await mac.window.evaluate(() => fetch("/api/state").then((r) => r.json()));
  expect(state).toEqual({ session: null });
  const csp = await mac.window.evaluate(() => fetch("/").then((r) => r.headers.get("content-security-policy")));
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("default-src 'self'");
});

test("the menu bar reads Tattle, File, Edit, View, Window, Help", async ({ mac }) => {
  expect(await mac.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((i) => i.label))).toEqual(["Tattle", "File", "Edit", "View", "Window", "Help"]);
});

test("Settings… opens the API keys window, and still does after the window was closed", async ({ mac }) => {
  await mac.menu(["Tattle", "Settings…"]);
  await expect(mac.window.locator("#dlg-keys")).toHaveAttribute("open", "");
  // closing the window keeps the app running; Settings… reopens it and the command waits for the page
  await mac.window.close();
  expect(await mac.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  const reopened = mac.app.waitForEvent("window");
  await mac.menu(["Tattle", "Settings…"]);
  const w = await reopened;
  await expect(w.locator("#dlg-keys")).toHaveAttribute("open", "", { timeout: 15_000 });
});

test("closing the window keeps the app alive, and activating it reopens the window", async ({ mac }) => {
  await mac.window.close();
  expect(await mac.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  const reopened = mac.app.waitForEvent("window");
  await mac.app.evaluate(({ app }) => { app.emit("activate"); });
  const w = await reopened;
  await expect(w).toHaveTitle("Tattle");
});

test("Licenses and Acknowledgements opens one window at /licenses, and opening it again reuses it", async ({ mac }) => {
  const opened = mac.app.waitForEvent("window");
  await mac.menu(["Help", "Licenses and Acknowledgements"]);
  const lic = await opened;
  expect(lic.url()).toBe("app://conversation-assistant/licenses");
  await expect(lic.locator("#lic-list .lic-item").first()).toContainText("This app");
  await mac.menu(["Help", "Licenses and Acknowledgements"]);
  // the page's own button goes through the bridge to the same window
  await mac.window.evaluate(() => (window as unknown as { desktop: { run(c: string): void } }).desktop.run("open-licenses"));
  await expect.poll(() => mac.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
});

test("Check for Updates… in development says updates come only to the installed app, on a sheet", async ({ mac }) => {
  await mac.menu(["Tattle", "Check for Updates…"]);
  await expect.poll(async () => (await mac.recorded()).sheets.map((s) => s.message)).toEqual(["Updates come only to the installed app"]);
});

test("links to other sites open in the browser, never in the app", async ({ mac }) => {
  const opened = await mac.window.evaluate(() => window.open("https://example.com/a") === null);
  expect(opened).toBe(true);
  await expect.poll(async () => (await mac.recorded()).external).toEqual(["https://example.com/a"]);
  expect(mac.app.windows()).toHaveLength(1);
  // navigating the window away is refused too
  await mac.window.evaluate(() => { location.href = "https://example.com/b"; });
  await expect.poll(async () => (await mac.recorded()).external).toEqual(["https://example.com/a", "https://example.com/b"]);
  expect(mac.window.url()).toBe("app://conversation-assistant/");
});

test("the page may write to the clipboard, and gets no microphone", async ({ mac }) => {
  const mic = await mac.window.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted", (e) => String(e.name)));
  expect(mic).toBe("NotAllowedError");
  const copied = await mac.window.evaluate(() => navigator.clipboard.writeText("Tattle").then(() => "ok", (e) => String(e)));
  expect(copied).toBe("ok");
});

test("File → Show Recordings in Finder opens the recordings folder", async ({ mac }) => {
  await mac.menu(["File", "Show Recordings in Finder"]);
  await expect.poll(async () => (await mac.recorded()).paths).toEqual(["sessions"]);
});

test("a second launch with the same HOME quits at once and brings the first window forward", async () => {
  const f = isolatedFolders({ keys: true });
  const first = await macApp(f);
  try {
    await first.app.evaluate(({ app }) => {
      const g = globalThis as Record<string, unknown>;
      g.__second = 0;
      app.on("second-instance", () => { g.__second = (g.__second as number) + 1; });
    });
    const electron = createRequire(join(ROOT, "package.json"))("electron") as unknown as string;
    const second = spawn(electron, [ROOT], { cwd: f.cwd, env: f.env, stdio: "ignore" });
    const code = await new Promise<number | null>((r) => second.once("exit", r));
    expect(code).toBe(0);
    await expect.poll(() => first.app.evaluate(() => (globalThis as Record<string, unknown>).__second)).toBe(1);
    expect(first.app.windows()).toHaveLength(1);
  } finally {
    await first.close();
  }
});

// sherpa-onnx inside Electron (docs/gotchas.md § Mac app: "External buffers are not allowed"): Electron's memory cage
// refuses buffers the addon makes over native memory, so every call that returns audio must ask for a copy (`false`).
// The Node tests cannot see this; these run in the app's main process.
const sherpaIn = (mac: { app: import("@playwright/test").ElectronApplication }, fn: (sherpa: any, root: string) => unknown) =>
  mac.app.evaluate((_e, a) => {
    const { createRequire: cr } = process.getBuiltinModule("node:module") as typeof import("node:module");
    const sherpa = cr(`${a.root}/package.json`)("sherpa-onnx-node");
    return new Function("sherpa", "root", `return (${a.fn})(sherpa, root)`)(sherpa, a.root);
  }, { root: ROOT, fn: fn.toString() });

test("sherpa-onnx runs inside Electron with copies: the VAD finds speech and the embedder gives a voiceprint", async ({ mac }) => {
  const got = await sherpaIn(mac, (sherpa, root) => {
    const samples: Float32Array = sherpa.readWave(`${root}/fixtures/conversation/host.wav`, false).samples.subarray(0, 16000 * 12);
    const vad = new sherpa.Vad({ sileroVad: { model: `${root}/models/silero_vad.onnx`, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512 }, sampleRate: 16000, debug: false, numThreads: 1 }, 60);
    let speech: Float32Array | null = null;
    for (let i = 0; i + 512 <= samples.length; i += 512) {
      vad.acceptWaveform(samples.subarray(i, i + 512));
      while (!vad.isEmpty()) { const seg = vad.front(false); speech ??= seg.samples; vad.pop(); }
    }
    const ex = new sherpa.SpeakerEmbeddingExtractor({ model: `${root}/models/wespeaker_en_voxceleb_resnet34_LM.onnx`, numThreads: 1, debug: false });
    const stream = ex.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: speech! });
    stream.inputFinished();
    return { speech: speech?.length ?? 0, dim: ex.compute(stream, false).length };
  }) as { speech: number; dim: number };
  expect(got.speech).toBeGreaterThan(16000); // more than a second of speech
  expect(got.dim).toBe(256);
});

// Why src/audio/wav.ts reads WAVs with `sherpa.readWave(path, false)`: without the copy, Electron refuses the buffer,
// and every replay in the Mac app failed as it opened the audio (E2E-L5, fixed on 30 September 2026). The contract
// test in tests/desktop.test.ts keeps the `false` in place.
test("sherpa's readWave without a copy is refused inside Electron", async ({ mac }) => {
  await expect(sherpaIn(mac, (sherpa, root) => sherpa.readWave(`${root}/fixtures/conversation/host.wav`).samples.length)).rejects.toThrow("External buffers are not allowed");
});
