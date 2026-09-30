// The Mac app's main process (desktop/main.ts; docs/desktop.md), with `electron`, `electron-updater`, the engine, the
// in-process bridge and the Application Support folder mocked. The module acts at top level, so each test builds fresh
// fakes, resets the module registry, and imports it again (`boot()`). Nothing here opens a window, a dialog, the
// network, or the real ~/Library/Application Support/Tattle.
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushMicrotasks } from "./fakes/async.ts";
import { FakeWindow, fakeDesktopEngine, fakeElectron, type ElectronFake, type ElectronOptions } from "./fakes/electron.ts";
import { cleanTmpDirs, tmpDir } from "./fakes/env.ts";

const h = vi.hoisted(() => ({ s: {} as any }));

// The factories run once per file, not once per resetModules, so each export reads the current test's fake at each use.
vi.mock("electron", async () => (await import("./fakes/electron.ts")).electronModule(() => h.s.electron));
vi.mock("electron-updater", () => ({ default: { get autoUpdater() { return h.s.electron.autoUpdater; } } }));
vi.mock("../src/server/main.ts", () => ({ bootEngine: (...a: unknown[]) => h.s.bootEngine(...a) }));
vi.mock("../src/server/inProcess.ts", () => ({ inProcessHandler: (...a: unknown[]) => h.s.inProcessHandler(...a) }));
vi.mock("../src/paths.ts", async (orig) => {
  const real = await orig<typeof import("../src/paths.ts")>();
  // never the real Application Support: the folder is a tmp one, and the move from the old name is a spy (read at each
  // call: tests/fakes/env.ts imports this module before any test has set h.s)
  return {
    ...real,
    migrateAppSupportDir: (...a: unknown[]) => h.s.migrate(...a),
    appSupportDir: () => h.s.support,
    setAppPaths: (...a: Parameters<typeof real.setAppPaths>) => { h.s.setAppPaths?.(...a); return real.setAppPaths(...a); },
  };
});
vi.mock("node:child_process", async (orig) => ({ ...(await orig<object>()), execFile: (...a: unknown[]) => h.s.execFile(...a) }));

const ORIGIN = "app://conversation-assistant";
const flush = () => flushMicrotasks(60);

let e: ElectronFake;
let engine: ReturnType<typeof fakeDesktopEngine>;
let support: string;
let downloads: string;

/** Fresh fakes, then a fresh import of desktop/main.ts; `ready` resolves app.whenReady(). */
async function boot(o: ElectronOptions = {}, { ready = true, onAir = false } = {}) {
  support = tmpDir("support-");
  downloads = tmpDir("downloads-");
  e = fakeElectron({ downloads, ...o });
  engine = fakeDesktopEngine();
  engine.onAir(onAir);
  const handle = vi.fn(async (_req: Request) => new Response("page"));
  h.s = {
    electron: e, engine, support, handle,
    migrate: vi.fn(() => null),
    bootEngine: vi.fn(() => ({ engine, server: { name: "router" } })),
    inProcessHandler: vi.fn(() => handle),
    execFile: vi.fn(),
    setAppPaths: vi.fn(),
  };
  vi.resetModules();
  await import("../desktop/main.ts");
  if (ready) await whenReady();
  return e;
}

async function whenReady() {
  e.ready.resolve();
  await flush();
}

const paths = async () => import("../src/paths.ts");
const main = () => e.mainWindows()[e.mainWindows().length - 1]!;
const sheets = () => e.dialog.showMessageBox.mock.calls.map((c) => c[1]);
const lastSheet = () => sheets()[sheets().length - 1];
/** A sheet that stays up until the test answers it. */
function pendingSheet() {
  let answer!: (response: number) => void;
  e.answers.push(new Promise((r) => { answer = (response) => r({ response }); }));
  return (response: number) => answer(response);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
  vi.spyOn(process, "chdir").mockImplementation(() => {});
  Object.defineProperty(process, "resourcesPath", { value: "/App/Contents/Resources", configurable: true, writable: true });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (process as { resourcesPath?: string }).resourcesPath;
  (await paths()).setAppPaths();
  cleanTmpDirs();
});


// The gotcha this guards (docs/gotchas.md § Mac app): a dialog without a parent window runs macOS's modal loop, which
// stops this process, and with it the engine. Whatever a test did, every dialog must have been a sheet on a window.
afterEach(() => {
  for (const [parent] of e?.dialog.showMessageBox.mock.calls ?? []) expect(parent, "a dialog without a window").toBeInstanceOf(FakeWindow);
});

const REPO = "https://github.com/nicolasdao/tattle";
const RES = "/App/Contents/Resources";
const HOUR = 60 * 60 * 1000;
const updateItem = () => e.menu[0].submenu[1];
const found = (version = "1.1.0") => ({ isUpdateAvailable: true, updateInfo: { version } });
async function clickCheck() {
  updateItem().click();
  await flush();
}

describe("start-up", () => {
  it("a packaged app started with --remote-debugging-port exits with 1 before touching anything", async () => {
    await expect(boot({ isPackaged: true, switches: ["remote-debugging-port"] }, { ready: false })).rejects.toThrow("exit 1");
    expect(e.app.exit).toHaveBeenCalledWith(1);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(h.s.migrate).not.toHaveBeenCalled();
    expect(h.s.bootEngine).not.toHaveBeenCalled();
    expect(e.app.setPath).not.toHaveBeenCalled();
  });

  it("a packaged app started with --remote-debugging-pipe exits with 1 too", async () => {
    await expect(boot({ isPackaged: true, switches: ["remote-debugging-pipe"] }, { ready: false })).rejects.toThrow("exit 1");
    expect(e.app.exit).toHaveBeenCalledWith(1);
    expect(h.s.bootEngine).not.toHaveBeenCalled();
  });

  it("development accepts remote debugging (Playwright drives `npm run app` through it)", async () => {
    await boot({ switches: ["remote-debugging-port", "remote-debugging-pipe"] });
    expect(e.app.exit).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    expect(e.windows).toHaveLength(1);
  });

  it("a packaged app with other switches starts", async () => {
    await boot({ isPackaged: true, switches: ["enable-logging"] });
    expect(e.app.exit).not.toHaveBeenCalled();
    expect(e.windows).toHaveLength(1);
  });

  it("moves the folder from before the rename first: before the paths, the window's storage, and the engine", async () => {
    await boot({ isPackaged: true }, { ready: false });
    expect(h.s.migrate).toHaveBeenCalledTimes(1);
    expect(h.s.migrate).toHaveBeenCalledWith(); // the default base: the user's Application Support (mocked here)
    const first = h.s.migrate.mock.invocationCallOrder[0];
    expect(first).toBeLessThan(h.s.setAppPaths.mock.invocationCallOrder[0]);
    expect(first).toBeLessThan(e.app.setPath.mock.invocationCallOrder[0]!);
    expect(first).toBeLessThan(h.s.bootEngine.mock.invocationCallOrder[0]);
  });

  it("packaged: every path points into Resources and Application Support, sessions/ exists, and the cwd moves there", async () => {
    await boot({ isPackaged: true, appPath: "/App/Contents/Resources/app.asar" }, { ready: false });
    expect((await paths()).appPaths()).toMatchObject({
      root: "/App/Contents/Resources/app.asar",
      web: `${RES}/web`, config: `${RES}/config`, models: `${RES}/models`,
      helper: `${RES}/bin/tattle-capture`, transcriber: `${RES}/bin/tattle-transcribe`,
      sessions: join(support, "sessions"), src: null,
      notices: `${RES}/licenses/THIRD_PARTY_NOTICES.txt`, licenses: `${RES}/licenses`,
    });
    expect(existsSync(join(support, "sessions"))).toBe(true);
    expect(process.chdir).toHaveBeenCalledWith(support);
    // the paths are set before the engine boots, which reads them
    expect(h.s.setAppPaths.mock.invocationCallOrder[0]).toBeLessThan(h.s.bootEngine.mock.invocationCallOrder[0]);
  });

  it("development: the project folder's paths, with src/ watched, and the cwd left alone", async () => {
    await boot({ appPath: "/project" }, { ready: false });
    expect((await paths()).appPaths()).toMatchObject({
      root: "/project", src: "/project/src", notices: "/project/THIRD_PARTY_NOTICES.md", licenses: "/project/licenses",
      // cwd-relative, like `npm run serve`
      web: "web", config: "config", models: "models", sessions: "sessions",
    });
    expect(process.chdir).not.toHaveBeenCalled();
    expect(existsSync(join(support, "sessions"))).toBe(false);
  });

  it.each([true, false])("keeps the window's storage in <Application Support>/Tattle/Window (packaged: %s)", async (isPackaged) => {
    await boot({ isPackaged }, { ready: false });
    expect(e.app.setPath).toHaveBeenCalledWith("userData", join(support, "Window"));
  });

  it("a second instance quits and exits 0 before booting the engine", async () => {
    await expect(boot({ lock: false }, { ready: false })).rejects.toThrow("exit 0");
    expect(e.app.quit).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(h.s.bootEngine).not.toHaveBeenCalled();
    expect(e.protocol.registerSchemesAsPrivileged).not.toHaveBeenCalled();
  });

  it("registers app:// before the app is ready: standard, secure, fetch, streaming, no CORS", async () => {
    await boot({}, { ready: false });
    expect(e.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
    ]);
  });

  it("boots the engine once, in this process, and bridges the router in-process", async () => {
    await boot({}, { ready: false });
    expect(h.s.bootEngine).toHaveBeenCalledTimes(1);
    expect(h.s.bootEngine).toHaveBeenCalledWith();
    expect(h.s.inProcessHandler).toHaveBeenCalledWith({ name: "router" });
  });

  it("opens nothing until the app is ready", async () => {
    await boot({}, { ready: false });
    expect(e.windows).toHaveLength(0);
    expect(e.protocol.handle).not.toHaveBeenCalled();
    expect(e.Menu.setApplicationMenu).not.toHaveBeenCalled();
    await whenReady();
    expect(e.windows).toHaveLength(1);
    expect(e.protocol.handle).toHaveBeenCalledWith("app", expect.any(Function));
    expect(e.Menu.setApplicationMenu).toHaveBeenCalled();
  });

  it("sets the About panel: copyright and license, where the licenses are, and the repository", async () => {
    await boot();
    expect(e.app.setAboutPanelOptions).toHaveBeenCalledWith({
      copyright: expect.stringContaining("BSD 3-Clause"),
      credits: expect.stringContaining("Help → Licenses and Acknowledgements"),
      website: REPO,
    });
  });
});

describe("the window", () => {
  it("opens one 1440×900 window titled Tattle on app://conversation-assistant/, sandboxed, with the preload", async () => {
    await boot();
    expect(e.windows).toHaveLength(1);
    const w = e.windows[0]!;
    expect(w.opts).toMatchObject({ width: 1440, height: 900, minWidth: 1024, minHeight: 640, title: "Tattle", backgroundColor: "#0a1628", show: false });
    expect(w.opts.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false });
    expect(w.opts.webPreferences.preload).toMatch(/desktop[/\\]preload\.cjs$/);
    expect(w.loadURL).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("allows DevTools only in development", async () => {
    await boot();
    expect(e.windows[0]!.opts.webPreferences.devTools).toBe(true);
    await boot({ isPackaged: true });
    expect(e.windows[0]!.opts.webPreferences.devTools).toBe(false);
  });

  it("shows the window once it is ready to show", async () => {
    await boot();
    expect(main().show).not.toHaveBeenCalled();
    main().emit("ready-to-show");
    expect(main().show).toHaveBeenCalledTimes(1);
  });

  it.each(["https://platform.openai.com/api-keys", "http://example.com/a", "mailto:hello@example.com"])(
    "window.open(%s) opens in the default browser and never in the app", async (url) => {
      await boot();
      expect(main().webContents.openHandler!({ url })).toEqual({ action: "deny" });
      expect(e.shell.openExternal).toHaveBeenCalledWith(url);
    });

  it.each(["file:///etc/passwd", "javascript:alert(1)", `${ORIGIN}/licenses`, "x-apple.systempreferences:x", "ftp://example.com"])(
    "window.open(%s) is denied and opened nowhere", async (url) => {
      await boot();
      expect(main().webContents.openHandler!({ url })).toEqual({ action: "deny" });
      expect(e.shell.openExternal).not.toHaveBeenCalled();
    });

  it.each([`${ORIGIN}/`, `${ORIGIN}/recordings/20260930-120000?t=12`, `${ORIGIN}/licenses`])("navigating within the app (%s) is allowed", async (url) => {
    await boot();
    expect(main().webContents.navigate(url)).toBe(false);
    expect(e.shell.openExternal).not.toHaveBeenCalled();
  });

  it("navigating to another site is refused and the link opens in the browser", async () => {
    await boot();
    expect(main().webContents.navigate("https://example.com/")).toBe(true);
    expect(e.shell.openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it.each(["app://conversation-assistant.evil.example/", "app://elsewhere/", "file:///Users/me/secret.txt", "app://conversation-assistant"])(
    "navigating to %s is refused and opened nowhere", async (url) => {
      await boot();
      expect(main().webContents.navigate(url)).toBe(true);
      expect(e.shell.openExternal).not.toHaveBeenCalled();
    });

  it("closing the window keeps the app running, and the Dock icon (activate) reopens it", async () => {
    await boot();
    expect(e.app.listenerCount("window-all-closed")).toBe(1);
    main().close();
    e.app.emit("window-all-closed");
    expect(e.app.quit).not.toHaveBeenCalled();
    expect(e.app.exit).not.toHaveBeenCalled();
    e.app.emit("activate");
    expect(e.mainWindows()).toHaveLength(2);
    expect(main().loadURL).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("activate with the window open opens no other", async () => {
    await boot();
    e.app.emit("activate");
    expect(e.windows).toHaveLength(1);
  });

  it("opening the app again focuses the window, restoring it when minimised", async () => {
    await boot();
    e.app.emit("second-instance");
    expect(main().focus).toHaveBeenCalledTimes(1);
    expect(main().restore).not.toHaveBeenCalled();
    main().minimized = true;
    e.app.emit("second-instance");
    expect(main().restore).toHaveBeenCalledTimes(1);
    expect(main().focus).toHaveBeenCalledTimes(2);
    expect(e.windows).toHaveLength(1);
  });

  it("opening the app again with the window closed opens a new one", async () => {
    await boot();
    main().close();
    e.app.emit("second-instance");
    expect(e.mainWindows()).toHaveLength(2);
  });
});

describe("the app:// scheme and the page's permissions", () => {
  it("answers app://conversation-assistant requests with the in-process router", async () => {
    await boot();
    const req = new Request(`${ORIGIN}/api/state`);
    const res = await e.schemes.app!(req);
    expect(h.s.handle).toHaveBeenCalledWith(req);
    expect(await res.text()).toBe("page");
  });

  it.each(["app://elsewhere/api/state", "app://conversation-assistant.evil/api/state"])("answers 404 for another host: %s", async (url) => {
    await boot();
    const res = await e.schemes.app!(new Request(url));
    expect(res.status).toBe(404);
    expect(h.s.handle).not.toHaveBeenCalled();
  });

  const refused = ["media", "geolocation", "notifications", "midi", "midiSysex", "pointerLock", "fullscreen", "openExternal",
    "clipboard-read", "display-capture", "hid", "serial", "usb", "window-management", "idle-detection", "storage-access", "unknown"];

  it("refuses every permission a page asks for but clipboard-sanitized-write (the chat's Copy buttons)", async () => {
    await boot();
    const ask = (p: string) => { const done = vi.fn(); e.defaultSession.requestHandler!(null, p, done); return done.mock.calls[0]![0]; };
    for (const p of refused) expect(ask(p), p).toBe(false);
    expect(ask("clipboard-sanitized-write")).toBe(true);
  });

  it("answers permission checks the same way", async () => {
    await boot();
    for (const p of refused) expect(e.defaultSession.checkHandler!(null, p), p).toBe(false);
    expect(e.defaultSession.checkHandler!(null, "clipboard-sanitized-write")).toBe(true);
  });
});

describe("downloads (exports)", () => {
  function download(name: string) {
    const item = Object.assign(new EventEmitter(), { getFilename: () => name, setSavePath: vi.fn() });
    e.defaultSession.emit("will-download", {}, item);
    return item;
  }

  it("saves to Downloads as name.tattle, then name (2).tattle, name (3).tattle", async () => {
    await boot();
    expect(download("Show 12.tattle").setSavePath).toHaveBeenCalledWith(join(downloads, "Show 12.tattle"));
    writeFileSync(join(downloads, "Show 12.tattle"), "");
    expect(download("Show 12.tattle").setSavePath).toHaveBeenCalledWith(join(downloads, "Show 12 (2).tattle"));
    writeFileSync(join(downloads, "Show 12 (2).tattle"), "");
    expect(download("Show 12.tattle").setSavePath).toHaveBeenCalledWith(join(downloads, "Show 12 (3).tattle"));
  });

  it("numbers a name without an extension too", async () => {
    await boot();
    writeFileSync(join(downloads, "notes"), "");
    expect(download("notes").setSavePath).toHaveBeenCalledWith(join(downloads, "notes (2)"));
  });

  it("bounces the Dock's Downloads stack only when the download completed", async () => {
    await boot();
    download("a.tattle").emit("done", {}, "cancelled");
    download("c.tattle").emit("done", {}, "interrupted");
    expect(e.app.dock!.downloadFinished).not.toHaveBeenCalled();
    download("b.tattle").emit("done", {}, "completed");
    expect(e.app.dock!.downloadFinished).toHaveBeenCalledWith(join(downloads, "b.tattle"));
  });

  it("tolerates no Dock", async () => {
    await boot({ noDock: true });
    expect(() => download("a.tattle").emit("done", {}, "completed")).not.toThrow();
  });
});

describe("the menu bar", () => {
  it("has Tattle, File, Edit, View, Window and Help, in that order", async () => {
    await boot();
    expect(e.menu.map((m: any) => m.label ?? m.role)).toEqual(["Tattle", "File", "editMenu", "viewMenu", "windowMenu", "help"]);
    expect(e.menu[0].submenu.map((i: any) => i.label ?? i.role ?? i.type)).toEqual([
      "about", "Check for Updates…", "separator", "Settings…", "separator", "services", "separator", "hide", "hideOthers", "unhide", "separator", "quit",
    ]);
    expect(e.menu[1].submenu.map((i: any) => i.label ?? i.role ?? i.type)).toEqual(["Show Recordings in Finder", "separator", "close"]);
    expect(e.menu[5].submenu.map((i: any) => i.label ?? i.type)).toEqual(["Tattle on GitHub", "separator", "Licenses and Acknowledgements"]);
    expect(e.item("Tattle", "Settings…").accelerator).toBe("CommandOrControl+,");
  });

  it("puts an SF Symbol beside each item of the app's own, made once however often the menu is rebuilt", async () => {
    await boot({ isPackaged: true }); // the launch's update check rebuilds the menu twice
    expect(e.menus.length).toBeGreaterThanOrEqual(3);
    expect(e.item("Tattle", "Settings…").icon).toEqual({ symbol: "gearshape" });
    expect(e.item("Tattle", "Check for Updates…").icon).toEqual({ symbol: "arrow.triangle.2.circlepath" });
    expect(e.item("File", "Show Recordings in Finder").icon).toEqual({ symbol: "folder" });
    expect(e.item("help", "Tattle on GitHub").icon).toEqual({ symbol: "globe" });
    expect(e.item("help", "Licenses and Acknowledgements").icon).toEqual({ symbol: "doc.text" });
    const names = e.nativeImage.createMenuSymbol.mock.calls.map((c) => c[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(e.item("Tattle", "Settings…").icon).toBe(e.menus[0][0].submenu[3].icon); // the same image, not a new one
  });

  it("Settings… shows the window and sends the keys command to a loaded page", async () => {
    await boot();
    main().webContents.finishLoad();
    e.item("Tattle", "Settings…").click();
    expect(main().show).toHaveBeenCalled();
    expect(main().webContents.send).toHaveBeenCalledWith("desktop:command", "keys");
  });

  it("Settings… while the page loads sends once it has loaded", async () => {
    await boot();
    e.item("Tattle", "Settings…").click();
    expect(main().webContents.send).not.toHaveBeenCalled();
    main().webContents.finishLoad();
    expect(main().webContents.send).toHaveBeenCalledTimes(1);
    expect(main().webContents.send).toHaveBeenCalledWith("desktop:command", "keys");
  });

  it("Settings… with the window closed reopens it, then sends once the page has loaded", async () => {
    await boot();
    main().close();
    e.item("Tattle", "Settings…").click();
    expect(e.mainWindows()).toHaveLength(2);
    expect(main().show).toHaveBeenCalled();
    expect(main().webContents.send).not.toHaveBeenCalled();
    main().webContents.finishLoad();
    expect(main().webContents.send).toHaveBeenCalledWith("desktop:command", "keys");
  });

  it("Settings… reaches a page that starts listening only after the command arrived (the preload's queue)", async () => {
    await boot();
    main().close();
    await import("../desktop/preload.ts"); // the reopened window's preload
    e.item("Tattle", "Settings…").click();
    main().webContents.finishLoad(); // the command reaches the preload before the page's app.ts listens
    const received: string[] = [];
    e.exposed.desktop.onCommand((c: string) => received.push(c));
    expect(received).toEqual(["keys"]);
    e.item("Tattle", "Settings…").click();
    expect(received).toEqual(["keys", "keys"]);
  });

  it("Show Recordings in Finder opens the sessions folder: the project's in development", async () => {
    await boot();
    e.item("File", "Show Recordings in Finder").click();
    expect(e.shell.openPath).toHaveBeenCalledWith("sessions");
  });

  it("Show Recordings in Finder opens Application Support/Tattle/sessions in the app", async () => {
    await boot({ isPackaged: true });
    e.item("File", "Show Recordings in Finder").click();
    expect(e.shell.openPath).toHaveBeenCalledWith(join(support, "sessions"));
  });

  it("Help → Tattle on GitHub opens the repository", async () => {
    await boot();
    e.item("help", "Tattle on GitHub").click();
    expect(e.shell.openExternal).toHaveBeenCalledWith(REPO);
  });

  it("Help → Licenses and Acknowledgements opens one window at /licenses, and shows it again after that", async () => {
    await boot();
    e.item("help", "Licenses and Acknowledgements").click();
    const lic = e.windows.filter((w) => w.opts.title === "Licenses and Acknowledgements");
    expect(lic).toHaveLength(1);
    expect(lic[0]!.opts).toMatchObject({ width: 1040, height: 760, minWidth: 720, minHeight: 480 });
    expect(lic[0]!.opts.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(lic[0]!.loadURL).toHaveBeenCalledWith(`${ORIGIN}/licenses`);
    e.item("help", "Licenses and Acknowledgements").click();
    expect(e.windows).toHaveLength(2);
    expect(lic[0]!.show).toHaveBeenCalledTimes(1);
  });

  it("a closed Licenses window opens anew", async () => {
    await boot();
    e.item("help", "Licenses and Acknowledgements").click();
    e.windows[1]!.close();
    e.item("help", "Licenses and Acknowledgements").click();
    expect(e.windows.filter((w) => w.opts.title === "Licenses and Acknowledgements")).toHaveLength(2);
  });

  it("the Licenses window has the same guards as the main one", async () => {
    await boot();
    e.item("help", "Licenses and Acknowledgements").click();
    const w = e.windows[1]!;
    expect(w.webContents.openHandler!({ url: "https://www.apache.org/licenses/LICENSE-2.0" })).toEqual({ action: "deny" });
    expect(e.shell.openExternal).toHaveBeenCalledWith("https://www.apache.org/licenses/LICENSE-2.0");
    expect(w.webContents.navigate("https://example.com/")).toBe(true);
  });
});

describe("requests from the page (desktop:run)", () => {
  it("open-licenses from the app's page opens the Licenses window", async () => {
    await boot();
    e.run("open-licenses");
    expect(e.windows.map((w) => w.opts.title)).toEqual(["Tattle", "Licenses and Acknowledgements"]);
    e.run("open-licenses", `${ORIGIN}/licenses`);
    expect(e.windows).toHaveLength(2);
  });

  it.each(["https://evil.example/", "app://conversation-assistant.evil/", "file:///tmp/x.html", "app://elsewhere/", ""])(
    "is ignored from a frame at %j", async (url) => {
      await boot();
      e.run("open-licenses", url);
      e.run("show-license-files", url);
      e.run("open-chromium-licenses", url);
      expect(e.windows).toHaveLength(1);
      expect(e.shell.openPath).not.toHaveBeenCalled();
    });

  it("is ignored with no sender frame", async () => {
    await boot();
    e.run("open-licenses", null);
    expect(e.windows).toHaveLength(1);
  });

  it("open-chromium-licenses opens Electron's LICENSES.chromium.html: from node_modules in development", async () => {
    await boot({ appPath: "/project" });
    e.run("open-chromium-licenses");
    expect(e.shell.openPath).toHaveBeenCalledWith("/project/node_modules/electron/dist/LICENSES.chromium.html");
  });

  it("open-chromium-licenses opens Resources/licenses/LICENSES.chromium.html in the app", async () => {
    await boot({ isPackaged: true });
    e.run("open-chromium-licenses");
    expect(e.shell.openPath).toHaveBeenCalledWith(`${RES}/licenses/LICENSES.chromium.html`);
  });

  it("show-license-files opens the licenses folder: the project's, or the app's Resources/licenses", async () => {
    await boot({ appPath: "/project" });
    e.run("show-license-files");
    expect(e.shell.openPath).toHaveBeenCalledWith("/project/licenses");
    await boot({ isPackaged: true });
    e.run("show-license-files");
    expect(e.shell.openPath).toHaveBeenCalledWith(`${RES}/licenses`);
  });

  it.each(["open-anything", "rm -rf /", 42, null, { request: "open-licenses" }])("does nothing for any other request: %j", async (request) => {
    await boot();
    e.run(request);
    expect(e.windows).toHaveLength(1);
    expect(e.shell.openPath).not.toHaveBeenCalled();
    expect(e.shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("macOS permissions (the packaged app's first launch)", () => {
  it("not determined: once the window shows, a sheet on it explains, then the helper probes so macOS asks now", async () => {
    await boot({ isPackaged: true, mic: "not-determined" });
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
    const answer = pendingSheet();
    main().emit("ready-to-show");
    await flush();
    expect(e.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(e.dialog.showMessageBox.mock.calls[0]![0]).toBe(main());
    expect(lastSheet()).toMatchObject({ type: "info", buttons: ["Continue"], message: "Tattle needs two permissions" });
    expect(lastSheet().detail).toMatch(/Microphone.*System Audio Recording/);
    expect(h.s.execFile).not.toHaveBeenCalled(); // not before the host has read it
    answer(0);
    await flush();
    expect(h.s.execFile).toHaveBeenCalledWith(`${RES}/bin/tattle-capture`, ["--probe", "1"], { timeout: 120_000 }, expect.any(Function));
    expect(() => h.s.execFile.mock.calls[0][3](new Error("helper missing"))).not.toThrow(); // its errors are ignored
  });

  it("denied: offers System Settings, and Open System Settings opens Privacy → Microphone", async () => {
    await boot({ isPackaged: true, mic: "denied" });
    e.answers.push(0);
    main().emit("ready-to-show");
    await flush();
    expect(lastSheet()).toMatchObject({ type: "warning", buttons: ["Open System Settings", "Not now"], defaultId: 0, cancelId: 1, message: "The microphone is turned off for Tattle" });
    expect(e.shell.openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    expect(h.s.execFile).not.toHaveBeenCalled();
  });

  it("restricted, and Not now: opens nothing", async () => {
    await boot({ isPackaged: true, mic: "restricted" });
    e.answers.push(1);
    main().emit("ready-to-show");
    await flush();
    expect(lastSheet().message).toBe("The microphone is turned off for Tattle");
    expect(e.shell.openExternal).not.toHaveBeenCalled();
  });

  it("granted: no sheet", async () => {
    await boot({ isPackaged: true, mic: "granted" });
    main().emit("ready-to-show");
    await flush();
    expect(e.systemPreferences.getMediaAccessStatus).toHaveBeenCalledWith("microphone");
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(h.s.execFile).not.toHaveBeenCalled();
  });

  it("development never asks (macOS asks on behalf of the terminal)", async () => {
    await boot({ mic: "not-determined" });
    main().emit("ready-to-show");
    await flush();
    expect(e.systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe("a show on air", () => {
  it("keeps the Mac awake from session.started to session.ended, with one blocker", async () => {
    await boot({}, { ready: false });
    engine.emit("session.started");
    engine.emit("session.started");
    expect(e.powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(e.powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    engine.emit("session.ended");
    expect(e.powerSaveBlocker.stop).toHaveBeenCalledWith(1);
    engine.emit("session.ended");
    expect(e.powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    engine.emit("session.started");
    expect(e.powerSaveBlocker.start).toHaveBeenCalledTimes(2);
  });

  it("session.ended with no blocker, and other events, do nothing", async () => {
    await boot({}, { ready: false });
    engine.emit("session.ended");
    engine.emit("utterance");
    expect(e.powerSaveBlocker.stop).not.toHaveBeenCalled();
    expect(e.powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("quitting off air goes ahead with no sheet", async () => {
    await boot();
    expect(e.beforeQuit()).toBe(false);
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
    engine.current = { status: "ended" };
    expect(e.beforeQuit()).toBe(false);
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("quitting on air is held back and asks on a sheet; Cancel keeps the show running", async () => {
    await boot({}, { onAir: true });
    e.answers.push(1);
    expect(e.beforeQuit()).toBe(true);
    await flush();
    expect(e.dialog.showMessageBox.mock.calls[0]![0]).toBe(main());
    expect(lastSheet()).toMatchObject({ type: "warning", buttons: ["Stop and Quit", "Cancel"], defaultId: 1, cancelId: 1, message: "A session is on air" });
    expect(engine.stop).not.toHaveBeenCalled();
    expect(e.app.quit).not.toHaveBeenCalled();
  });

  it("Stop and Quit stops the session, then quits", async () => {
    await boot({}, { onAir: true });
    let stopped!: () => void;
    engine.stop.mockReturnValue(new Promise<void>((r) => { stopped = r; }));
    e.beforeQuit();
    await flush();
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(e.app.quit).not.toHaveBeenCalled();
    stopped();
    await flush();
    expect(e.app.quit).toHaveBeenCalledTimes(1);
  });

  it("Stop and Quit quits after 30 s even if the session never ends", async () => {
    await boot({}, { onAir: true });
    engine.stop.mockReturnValue(new Promise(() => {}));
    e.beforeQuit();
    await flush();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(e.app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(e.app.quit).toHaveBeenCalledTimes(1);
  });

  it("Stop and Quit quits even when stopping fails", async () => {
    await boot({}, { onAir: true });
    engine.stop.mockRejectedValue(new Error("stop failed"));
    e.beforeQuit();
    await flush();
    expect(e.app.quit).toHaveBeenCalledTimes(1);
  });

  it("after Stop and Quit, the quit it starts goes through without asking again", async () => {
    await boot({}, { onAir: true });
    e.beforeQuit();
    await flush();
    expect(e.app.quit).toHaveBeenCalledTimes(1);
    expect(e.beforeQuit()).toBe(false); // app.quit() fires before-quit again; the session may still be ending
    expect(e.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("with the window closed, the quit sheet reopens the window and attaches to it", async () => {
    await boot({}, { onAir: true });
    main().close();
    e.answers.push(1);
    e.beforeQuit();
    await flush();
    expect(e.mainWindows()).toHaveLength(2);
    expect(e.dialog.showMessageBox.mock.calls[0]![0]).toBe(main());
    expect(main().show).toHaveBeenCalled();
  });
});

describe("updates in development", () => {
  it("never checks, and Check for Updates… says only the installed app updates", async () => {
    await boot();
    expect(e.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(e.autoUpdater.autoDownload).toBe(true); // untouched
    expect(e.autoUpdater.listenerCount("update-downloaded")).toBe(0);
    await clickCheck();
    expect(lastSheet()).toMatchObject({ type: "info", buttons: ["OK"], message: "Updates come only to the installed app" });
    expect(lastSheet().detail).toContain("1.0.1");
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(e.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe("updates in the app", () => {
  it("downloads by itself only when asked to, and installs on quit", async () => {
    await boot({ isPackaged: true });
    expect(e.autoUpdater.autoDownload).toBe(false);
    expect(e.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("checks at launch and, when a version is found, downloads it quietly", async () => {
    await boot({ isPackaged: true }, { ready: false });
    e.autoUpdater.checkForUpdates.mockResolvedValue(found("1.1.0"));
    await whenReady();
    expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(e.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(updateItem()).toMatchObject({ label: "Downloading 1.1.0… 0%", enabled: false, icon: { symbol: "arrow.down.circle" } });
    expect(updateItem().click).toBeUndefined();
    expect(main().setProgressBar).toHaveBeenLastCalledWith(0);
  });

  it("finds nothing newer: back to Check for Updates…, no download", async () => {
    await boot({ isPackaged: true });
    expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(e.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(updateItem()).toMatchObject({ label: "Check for Updates…" });
    expect(main().setProgressBar).toHaveBeenLastCalledWith(-1);
  });

  it("an update that is not available is not downloaded", async () => {
    await boot({ isPackaged: true }, { ready: false });
    e.autoUpdater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: "1.0.1" } });
    await whenReady();
    expect(e.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("the menu reads Checking for Updates…, greyed, while a check runs", async () => {
    await boot({ isPackaged: true }, { ready: false });
    e.autoUpdater.checkForUpdates.mockReturnValue(new Promise(() => {}));
    await whenReady();
    expect(updateItem()).toMatchObject({ label: "Checking for Updates…", enabled: false, icon: { symbol: "arrow.triangle.2.circlepath" } });
    expect(updateItem().click).toBeUndefined();
  });

  it("never checks at launch while a session is on air, and checks at the next 4-hour tick once it is over", async () => {
    await boot({ isPackaged: true }, { onAir: true });
    expect(e.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(e.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    engine.onAir(false);
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("checks again every 4 hours", async () => {
    await boot({ isPackaged: true });
    await vi.advanceTimersByTimeAsync(4 * HOUR - 1);
    expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8 * HOUR);
    expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(4);
  });

  it("skips the 4-hour check while a download runs", async () => {
    await boot({ isPackaged: true }, { ready: false });
    e.autoUpdater.checkForUpdates.mockResolvedValue(found());
    e.autoUpdater.downloadUpdate.mockReturnValue(new Promise(() => {}));
    await whenReady();
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("does not download what it found if a session went on air meanwhile", async () => {
    await boot({ isPackaged: true }, { ready: false });
    e.autoUpdater.checkForUpdates.mockImplementation(async () => { engine.onAir(); return found(); });
    await whenReady();
    expect(e.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(updateItem().label).toBe("Check for Updates…");
  });

  it("an automatic check that fails says nothing and leaves the menu as it was", async () => {
    await boot({ isPackaged: true }, { ready: false });
    e.autoUpdater.checkForUpdates.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
    await whenReady();
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(updateItem().label).toBe("Check for Updates…");
  });

  it("an automatic download that fails returns to Check for Updates…, quietly", async () => {
    await boot({ isPackaged: true }, { ready: false });
    e.autoUpdater.checkForUpdates.mockResolvedValue(found());
    e.autoUpdater.downloadUpdate.mockRejectedValue(new Error("sha512 checksum mismatch"));
    await whenReady();
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(updateItem().label).toBe("Check for Updates…");
    expect(main().setProgressBar).toHaveBeenLastCalledWith(-1);
  });

  it("logs the updater's errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await boot({ isPackaged: true });
    e.autoUpdater.emit("error", new Error("boom"));
    e.autoUpdater.emit("error", "plain");
    expect(log).toHaveBeenCalledWith("update: boom");
    expect(log).toHaveBeenCalledWith("update: plain");
  });

  describe("a download's progress", () => {
    async function downloading() {
      await boot({ isPackaged: true }, { ready: false });
      e.autoUpdater.checkForUpdates.mockResolvedValue(found("1.1.0"));
      await whenReady();
    }

    it("shows in the menu and on the Dock icon, in steps of 5 %", async () => {
      await downloading();
      e.autoUpdater.emit("download-progress", { percent: 12.7 });
      expect(updateItem().label).toBe("Downloading 1.1.0… 10%");
      expect(main().setProgressBar).toHaveBeenLastCalledWith(0.1);
      const built = e.menus.length;
      e.autoUpdater.emit("download-progress", { percent: 14.9 });
      expect(e.menus.length).toBe(built); // the menu is rebuilt only every 5 %
      e.autoUpdater.emit("download-progress", { percent: 45 });
      expect(updateItem().label).toBe("Downloading 1.1.0… 45%");
      expect(main().setProgressBar).toHaveBeenLastCalledWith(0.45);
    });

    it("never goes backwards", async () => {
      await downloading();
      e.autoUpdater.emit("download-progress", { percent: 50 });
      const built = e.menus.length;
      e.autoUpdater.emit("download-progress", { percent: 20 });
      expect(e.menus.length).toBe(built);
      expect(updateItem().label).toBe("Downloading 1.1.0… 50%");
    });

    it("is ignored when nothing is downloading", async () => {
      await boot({ isPackaged: true });
      const built = e.menus.length;
      e.autoUpdater.emit("download-progress", { percent: 50 });
      expect(e.menus.length).toBe(built);
      expect(updateItem().label).toBe("Check for Updates…");
    });

    it("survives a closed window (no Dock progress to set)", async () => {
      await downloading();
      main().close();
      expect(() => e.autoUpdater.emit("download-progress", { percent: 30 })).not.toThrow();
      expect(updateItem().label).toBe("Downloading 1.1.0… 30%");
    });
  });

  describe("a downloaded version", () => {
    it("offers to restart, on a sheet; Restart Now installs", async () => {
      await boot({ isPackaged: true });
      e.answers.push(0);
      e.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
      await flush();
      expect(lastSheet()).toMatchObject({ type: "info", buttons: ["Restart Now", "Later"], defaultId: 0, cancelId: 1, message: "Tattle 1.1.0 is ready" });
      expect(e.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(updateItem().label).toBe("Check for Updates…");
      expect(main().setProgressBar).toHaveBeenLastCalledWith(-1);
    });

    it("Later installs nothing now, and the same version is not offered twice by itself", async () => {
      await boot({ isPackaged: true });
      e.answers.push(1);
      e.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
      await flush();
      expect(e.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
      e.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
      await flush();
      expect(e.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    });

    it("waits for the show to end before offering", async () => {
      await boot({ isPackaged: true }, { onAir: true });
      e.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
      await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
      engine.onAir(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(lastSheet().message).toBe("Tattle 1.1.0 is ready");
    });

    it("stops the 4-hourly checks until the app restarts", async () => {
      await boot({ isPackaged: true });
      e.answers.push(1);
      e.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
      await flush();
      await vi.advanceTimersByTimeAsync(4 * HOUR);
      expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("a download failing after the version became ready keeps it ready", async () => {
      await boot({ isPackaged: true }, { ready: false });
      let fail!: (err: Error) => void;
      e.autoUpdater.checkForUpdates.mockResolvedValue(found("1.1.0"));
      e.autoUpdater.downloadUpdate.mockReturnValue(new Promise((_r, rej) => { fail = rej; }));
      await whenReady();
      e.answers.push(1);
      e.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
      await flush();
      fail(new Error("late"));
      await flush();
      e.answers.push(0);
      await clickCheck();
      expect(lastSheet().message).toBe("Tattle 1.1.0 is ready");
      expect(e.autoUpdater.quitAndInstall).toHaveBeenCalled();
    });

    it("a check still running when a version became ready leaves it ready", async () => {
      await boot({ isPackaged: true }, { ready: false });
      let checked!: (v: null) => void;
      e.autoUpdater.checkForUpdates.mockReturnValue(new Promise((r) => { checked = r; }));
      await whenReady();
      e.answers.push(1);
      e.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
      await flush();
      checked(null);
      await flush();
      e.answers.push(1);
      await clickCheck();
      expect(lastSheet().message).toBe("Tattle 1.1.0 is ready");
    });
  });

  describe("Check for Updates…", () => {
    it("nothing newer: You're up to date, with the version", async () => {
      await boot({ isPackaged: true });
      await clickCheck();
      expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
      expect(lastSheet()).toMatchObject({ type: "info", buttons: ["OK"], message: "You're up to date", detail: "Tattle 1.0.1 is the newest version." });
    });

    it("on air: Updates wait until the show ends, and nothing is checked", async () => {
      await boot({ isPackaged: true });
      engine.onAir();
      await clickCheck();
      expect(lastSheet().message).toBe("Updates wait until the show ends");
      expect(lastSheet().detail).toContain("1.0.1");
      expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("an error: Can't check for updates right now, with its first line only", async () => {
      await boot({ isPackaged: true });
      e.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("net::ERR_INTERNET_DISCONNECTED\n    at stack"));
      await clickCheck();
      expect(lastSheet()).toMatchObject({ type: "warning", message: "Can't check for updates right now" });
      expect(lastSheet().detail).toBe("net::ERR_INTERNET_DISCONNECTED\n\nCheck the internet connection and try again. You have 1.0.1.");
      expect(updateItem().label).toBe("Check for Updates…");
    });

    it("an error's reason is cut at 200 characters, and a thrown non-Error is said as text", async () => {
      await boot({ isPackaged: true });
      e.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("x".repeat(500)));
      await clickCheck();
      expect(lastSheet().detail.split("\n\n")[0]).toBe("x".repeat(200));
      e.autoUpdater.checkForUpdates.mockRejectedValueOnce("GitHub said 503");
      await clickCheck();
      expect(lastSheet().detail.startsWith("GitHub said 503\n\n")).toBe(true);
    });

    it("a newer version: offers Download and Install, Later, or Release Notes; Later does nothing", async () => {
      await boot({ isPackaged: true });
      e.autoUpdater.checkForUpdates.mockResolvedValueOnce(found("1.2.0"));
      e.answers.push(1);
      await clickCheck();
      expect(lastSheet()).toMatchObject({
        type: "info", buttons: ["Download and Install", "Later", "Release Notes"], defaultId: 0, cancelId: 1,
        message: "A new version is available", detail: "Tattle 1.2.0 is out. You have 1.0.1.",
      });
      expect(e.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
      expect(e.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    });

    it("Release Notes opens the release's page and asks again", async () => {
      await boot({ isPackaged: true });
      e.autoUpdater.checkForUpdates.mockResolvedValueOnce(found("1.2.0"));
      e.answers.push(2, 2, 1);
      await clickCheck();
      expect(e.shell.openExternal).toHaveBeenCalledWith(`${REPO}/releases/tag/v1.2.0`);
      expect(e.shell.openExternal).toHaveBeenCalledTimes(2);
      expect(sheets().map((s) => s.message)).toEqual(Array(3).fill("A new version is available"));
      expect(e.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    it("Download and Install downloads, then offers the restart when done", async () => {
      await boot({ isPackaged: true });
      e.autoUpdater.checkForUpdates.mockResolvedValueOnce(found("1.2.0"));
      e.answers.push(0);
      await clickCheck();
      expect(e.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
      expect(updateItem().label).toBe("Downloading 1.2.0… 0%");
      expect(e.dialog.showMessageBox).toHaveBeenCalledTimes(1);
      e.answers.push(1);
      e.autoUpdater.emit("update-downloaded", { version: "1.2.0" });
      await flush();
      expect(lastSheet().message).toBe("Tattle 1.2.0 is ready");
    });

    it("a session started while the sheet was up: Updates wait until the show ends, no download", async () => {
      await boot({ isPackaged: true });
      e.autoUpdater.checkForUpdates.mockResolvedValueOnce(found("1.2.0"));
      const answer = pendingSheet();
      await clickCheck();
      engine.onAir();
      answer(0);
      await flush();
      expect(lastSheet().message).toBe("Updates wait until the show ends");
      expect(e.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    it("a failed download: The download failed, and back to Check for Updates…", async () => {
      await boot({ isPackaged: true });
      e.autoUpdater.checkForUpdates.mockResolvedValueOnce(found("1.2.0"));
      e.autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error("sha512 checksum mismatch\nmore"));
      e.answers.push(0);
      await clickCheck();
      expect(lastSheet()).toMatchObject({ type: "warning", message: "The download failed" });
      expect(lastSheet().detail).toBe("sha512 checksum mismatch\n\nTry Check for Updates… again later. You have 1.0.1.");
      expect(updateItem().label).toBe("Check for Updates…");
      expect(main().setProgressBar).toHaveBeenLastCalledWith(-1);
    });

    it("a version already downloaded is offered again, even after Later", async () => {
      await boot({ isPackaged: true });
      e.answers.push(1);
      e.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
      await flush();
      e.answers.push(0);
      await clickCheck();
      expect(sheets().map((s) => s.message)).toEqual(["Tattle 1.1.0 is ready", "Tattle 1.1.0 is ready"]);
      expect(e.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1); // nothing new is looked for
    });

    it("a click on a menu built before a check started does nothing while it runs", async () => {
      await boot({ isPackaged: true }, { ready: false });
      e.autoUpdater.checkForUpdates.mockReturnValue(new Promise(() => {}));
      await whenReady();
      const stale = e.menus[0][0].submenu[1]; // the menu from before the launch's check
      expect(stale.label).toBe("Check for Updates…");
      stale.click();
      await flush();
      expect(e.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it("with the window closed, its sheet reopens the window", async () => {
      await boot({ isPackaged: true });
      main().close();
      await clickCheck();
      expect(e.mainWindows()).toHaveLength(2);
      expect(e.dialog.showMessageBox.mock.calls[0]![0]).toBe(main());
    });
  });
});

// Known bugs, recorded, not fixed (SPEC §4.0.4): each `it.fails` states the intended behaviour and turns red when the
// bug is fixed, to be made a plain `it`.
describe("known bugs", () => {
  it.fails("BUG DM-L1: a restart put off through Check for Updates… is not offered again by the automatic offer that waited for the show to end", async () => {
    await boot({ isPackaged: true }, { onAir: true });
    e.autoUpdater.emit("update-downloaded", { version: "1.1.0" }); // offerRestart waits, sleeping 30 s at a time
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    engine.onAir(false); // the show ends mid-sleep
    e.answers.push(1);
    await clickCheck(); // the host asks, and answers Later
    expect(sheets().map((s) => s.message)).toEqual(["Tattle 1.1.0 is ready"]);
    e.answers.push(1);
    await vi.advanceTimersByTimeAsync(30_000); // the waiting offer wakes: the same sheet again, seconds after Later
    expect(sheets().map((s) => s.message)).toEqual(["Tattle 1.1.0 is ready"]);
  });

  it.fails("BUG DM-L2: ⌘Q pressed again while the on-air quit sheet is up does not stack a second sheet", async () => {
    await boot({}, { onAir: true });
    const first = pendingSheet();
    expect(e.beforeQuit()).toBe(true);
    await flush();
    const second = pendingSheet();
    expect(e.beforeQuit()).toBe(true); // the quit is still held back, as it should be
    await flush();
    first(1);
    second(1);
    await flush();
    expect(e.dialog.showMessageBox).toHaveBeenCalledTimes(1); // but a second "A session is on air" sheet was stacked
  });
});
