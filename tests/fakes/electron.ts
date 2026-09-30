// A fake of the `electron` module (and `electron-updater`'s autoUpdater) for unit tests of the Mac app's main process
// and preload (desktop/main.ts, desktop/preload.ts), which import it at load and act at top level. A test builds one
// with `fakeElectron({...})` and mocks the module with `electronModule(() => currentFake)` (a mock factory runs once
// per file, so the module reads the current fake at each use), then imports the code fresh (`vi.resetModules()`
// first). Everything is recorded; nothing touches a real window, dialog, or the network.
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { deferred } from "./async.ts";

type Answer = { response: number };

export class FakeWebContents extends EventEmitter {
  loading = false;
  openHandler: ((d: { url: string }) => { action: string }) | null = null;
  readonly setWindowOpenHandler = vi.fn((h: (d: { url: string }) => { action: string }) => { this.openHandler = h; });
  readonly send = vi.fn((channel: string, ...args: unknown[]) => { this.onSend?.(channel, ...args); });
  onSend: ((channel: string, ...args: unknown[]) => void) | null = null;
  isLoading = () => this.loading;
  /** Fires will-navigate as Chromium would; true when the navigation was refused. */
  navigate(url: string): boolean {
    let prevented = false;
    this.emit("will-navigate", { preventDefault: () => { prevented = true; } }, url);
    return prevented;
  }
  /** The page finishes loading. */
  finishLoad() { this.loading = false; this.emit("did-finish-load"); }
}

export class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  minimized = false;
  readonly show = vi.fn();
  /** Loading starts here and lasts until the test calls `webContents.finishLoad()`, as a real page's load does. */
  readonly loadURL = vi.fn(async (_url: string) => { this.webContents.loading = true; });
  readonly setProgressBar = vi.fn();
  readonly restore = vi.fn(() => { this.minimized = false; });
  readonly focus = vi.fn();
  isMinimized = () => this.minimized;
  constructor(readonly opts: Record<string, any>) { super(); }
  /** The user closes the window. */
  close() { this.emit("closed"); }
}

export interface ElectronOptions {
  isPackaged?: boolean;
  /** Command-line switches the app was started with (`remote-debugging-port`…). */
  switches?: string[];
  /** Whether this instance gets the single-instance lock. */
  lock?: boolean;
  appPath?: string;
  downloads?: string;
  version?: string;
  /** `systemPreferences.getMediaAccessStatus("microphone")`. */
  mic?: string;
  /** Leave out `app.dock` (it is undefined off macOS). */
  noDock?: boolean;
}

export function fakeElectron(o: ElectronOptions = {}) {
  const windows: FakeWindow[] = [];
  const ready = deferred<void>();
  /** Scripted answers for dialog.showMessageBox, in order; when empty, a sheet answers 0. */
  const answers: Array<number | Promise<Answer>> = [];

  const app = Object.assign(new EventEmitter(), {
    isPackaged: o.isPackaged ?? false,
    name: "Tattle",
    commandLine: { hasSwitch: vi.fn((s: string) => (o.switches ?? []).includes(s)) },
    exit: vi.fn(),
    quit: vi.fn(),
    getAppPath: vi.fn(() => o.appPath ?? "/project"),
    setPath: vi.fn(),
    getPath: vi.fn((name: string) => (name === "downloads" ? o.downloads ?? "/downloads" : `/${name}`)),
    requestSingleInstanceLock: vi.fn(() => o.lock ?? true),
    whenReady: vi.fn(() => ready.promise),
    getVersion: vi.fn(() => o.version ?? "1.0.1"),
    setAboutPanelOptions: vi.fn(),
    dock: o.noDock ? undefined : { downloadFinished: vi.fn() },
  });

  const BrowserWindow = vi.fn(function (this: unknown, opts: Record<string, any>) {
    const w = new FakeWindow(opts);
    // what main sends to a window reaches the preload's ipcRenderer, as Electron's IPC would
    w.webContents.onSend = (channel, ...args) => ipcRenderer.emit(channel, {}, ...args);
    windows.push(w);
    return w;
  });

  const dialog = {
    showMessageBox: vi.fn(async (_win: unknown, _opts: Record<string, any>): Promise<Answer> => {
      const next = answers.shift();
      return next === undefined ? { response: 0 } : typeof next === "number" ? { response: next } : next;
    }),
  };

  const ipcMain = new EventEmitter();
  const menus: any[] = [];
  const Menu = {
    buildFromTemplate: vi.fn((template: any[]) => template),
    setApplicationMenu: vi.fn((m: any) => { menus.push(m); }),
  };
  const nativeImage = { createMenuSymbol: vi.fn((name: string) => ({ symbol: name })) };
  let blockerId = 0;
  const powerSaveBlocker = { start: vi.fn((_type: string) => ++blockerId), stop: vi.fn((_id: number) => {}) };
  const schemes: Record<string, (req: Request) => Promise<Response>> = {};
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn((scheme: string, fn: (req: Request) => Promise<Response>) => { schemes[scheme] = fn; }),
  };
  const defaultSession = Object.assign(new EventEmitter(), {
    requestHandler: null as null | ((w: unknown, p: string, done: (ok: boolean) => void) => void),
    checkHandler: null as null | ((w: unknown, p: string) => boolean),
    setPermissionRequestHandler: vi.fn((h: any) => { defaultSession.requestHandler = h; }),
    setPermissionCheckHandler: vi.fn((h: any) => { defaultSession.checkHandler = h; }),
  });
  const session = { defaultSession };
  const shell = { openExternal: vi.fn(async (_url: string) => {}), openPath: vi.fn(async (_path: string) => "") };
  const systemPreferences = { getMediaAccessStatus: vi.fn((_media: string) => o.mic ?? "granted") };

  // the preload's side of the bridge; main's webContents.send reaches it when a test wires them (connectPreload)
  const ipcRenderer = Object.assign(new EventEmitter(), { send: vi.fn() });
  const exposed: Record<string, any> = {};
  const contextBridge = { exposeInMainWorld: vi.fn((key: string, api: unknown) => { exposed[key] = api; }) };

  const autoUpdater = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async (): Promise<any> => null),
    downloadUpdate: vi.fn(async (): Promise<any> => []),
    quitAndInstall: vi.fn(),
  });

  const module = { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, protocol, session, shell, systemPreferences, ipcRenderer, contextBridge };

  return {
    module, autoUpdater, windows, ready, answers, menus, schemes, exposed,
    app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, protocol, defaultSession, shell, systemPreferences, ipcRenderer, contextBridge,
    /** The menu bar last set. */
    get menu(): any[] { return menus[menus.length - 1]; },
    /** A menu item by its top menu's label (or role) and its own label (or role). */
    item(top: string, label: string): any {
      const m = this.menu.find((t: any) => t.label === top || t.role === top);
      return m?.submenu?.find((i: any) => i.label === label || i.role === label);
    },
    /** Every main window opened (title Tattle), oldest first. */
    mainWindows(): FakeWindow[] { return windows.filter((w) => w.opts.title === "Tattle"); },
    /** Sends `desktop:run` as a page at `url` would. */
    run(request: unknown, url: string | null = "app://conversation-assistant/") {
      ipcMain.emit("desktop:run", { senderFrame: url === null ? null : { url } }, request);
    },
    /** Asks the app to quit, as ⌘Q does; true when the quit was held back. */
    beforeQuit(): boolean {
      let prevented = false;
      app.emit("before-quit", { preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
}

export type ElectronFake = ReturnType<typeof fakeElectron>;

/** The engine as desktop/main.ts sees it: a bus to subscribe to, the current session, and stop(). */
export function fakeDesktopEngine() {
  const listeners: Array<(e: { type: string; data?: unknown }) => void> = [];
  const engine = {
    current: null as null | { status: string },
    stop: vi.fn(async () => {}),
    bus: { subscribe: vi.fn((fn: (e: { type: string }) => void) => { listeners.push(fn); return () => {}; }) },
    /** Puts a session on air (or takes it off). */
    onAir(on = true) { engine.current = on ? { status: "running" } : null; },
    emit(type: string) { for (const l of listeners) l({ type }); },
  };
  return engine;
}

/**
 * The `electron` module for `vi.mock("electron", …)`, reading the current fake at each use: a mock factory runs once
 * per test file, while each test makes a fresh fake and a fresh import (`vi.resetModules()`).
 */
export function electronModule(current: () => ElectronFake): Record<string, unknown> {
  const keys = ["app", "BrowserWindow", "dialog", "ipcMain", "Menu", "nativeImage", "powerSaveBlocker", "protocol", "session", "shell", "systemPreferences", "ipcRenderer", "contextBridge"] as const;
  const m: Record<string, unknown> = {};
  for (const k of keys) Object.defineProperty(m, k, { enumerable: true, get: () => current().module[k] });
  return m;
}
