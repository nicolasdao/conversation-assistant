// The Mac app (see docs/desktop.md). The engine runs in this process, the one `npm run serve` starts, and the window
// loads the same web page from the private app:// scheme, answered in-process: no server, no port.
import { app, BrowserWindow, dialog, Menu, powerSaveBlocker, protocol, session, shell, systemPreferences } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { appPaths, appSupportDir, setAppPaths } from "../src/paths.ts";
import { bootEngine } from "../src/server/main.ts";
import { inProcessHandler } from "../src/server/inProcess.ts";

const ORIGIN = "app://conversation-assistant";
const REPO = "https://github.com/nicolasdao/podcast-ai-assistant";
/** How long quitting waits for a session on air to end; its audio is complete within seconds (src/pipeline/session.ts). */
const QUIT_WAIT_MS = 30_000;
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;
// The page may load only from the app itself; styles stay inline-able because the page sets them from code.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
  + "media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// ---------- where things are: the bundle's Resources, and Application Support ----------

if (app.isPackaged) {
  const res = process.resourcesPath;
  setAppPaths({
    root: app.getAppPath(), web: join(res, "web"), config: join(res, "config"), models: join(res, "models"),
    helper: join(res, "bin", "conversation-capture"), sessions: join(appSupportDir(), "sessions"), src: null,
  });
  mkdirSync(appPaths().sessions, { recursive: true });
  process.chdir(appSupportDir()); // anything still relative lands here, never in "/"
} else {
  // `npm run app`: the project folder, like `npm run serve`; the engine is bundled, so src/ edits need a restart
  setAppPaths({ root: app.getAppPath(), src: join(app.getAppPath(), "src") });
}
// the window's own storage (preferences the page remembers) goes in a subfolder, next to the keys and recordings
app.setPath("userData", join(appSupportDir(), "Window"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
]);

// The dev spend cap guards the developer's own replays; the app's users have only the per-session cap.
const { engine, server } = bootEngine({ allowOverDevCap: app.isPackaged });
const handle = inProcessHandler(server);
const onAir = () => engine.current?.status === "running";
let win: BrowserWindow | null = null;

// ---------- the window ----------

function openOutside(url: string) {
  if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, title: "Conversation Assistant", backgroundColor: "#0a1628", show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once("ready-to-show", () => win?.show());
  // links to other sites (key setup steps, fact-check sources) open in the default browser, never in the app
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    e.preventDefault();
    openOutside(url);
  });
  win.on("closed", () => { win = null; });
  void win.loadURL(`${ORIGIN}/`);
}

/**
 * Every dialog is a sheet on the window. A dialog without one runs macOS's modal loop (NSAlert runModal), which stops
 * this process's event loop until it is answered, and with it the engine: a show on air would stop being captured.
 */
function ask(opts: Electron.MessageBoxOptions) {
  if (!win) createWindow();
  win!.show();
  return dialog.showMessageBox(win!, opts);
}

/** Exports go to Downloads, like a browser: "name.conversation-recording", then "name (2)…" if taken. */
function downloadPath(fileName: string): string {
  const dir = app.getPath("downloads");
  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let p = join(dir, fileName);
  for (let n = 2; existsSync(p); n++) p = join(dir, `${stem} (${n})${ext}`);
  return p;
}

function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "Show Recordings in Finder", click: () => void shell.openPath(appPaths().sessions) },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Conversation Assistant on GitHub", click: () => void shell.openExternal(REPO) }] },
  ]));
}

// ---------- macOS permissions: asked once, before the first show ----------

/**
 * macOS asks for the Microphone and System Audio Recording the first time the capture helper starts, and gives both to
 * this app. On a first launch the app starts the helper for a moment, so the questions come now rather than at the
 * start of a show. A refused microphone is offered a way back through System Settings.
 */
async function askPermissions() {
  const mic = systemPreferences.getMediaAccessStatus("microphone");
  if (mic === "not-determined") {
    await ask({
      type: "info", buttons: ["Continue"],
      message: "Conversation Assistant needs two permissions",
      detail: "It listens to your microphone and to the call your Mac plays, then transcribes both. macOS will now ask for "
        + "Microphone and for System Audio Recording: click Allow on both.",
    });
    execFile(appPaths().helper, ["--probe", "1"], { timeout: 120_000 }, () => {});
  } else if (mic === "denied" || mic === "restricted") {
    const { response } = await ask({
      type: "warning", buttons: ["Open System Settings", "Not now"], defaultId: 0, cancelId: 1,
      message: "The microphone is turned off for Conversation Assistant",
      detail: "Live shows record silence without it. In System Settings → Privacy & Security → Microphone, turn on "
        + "Conversation Assistant, then quit and reopen it.",
    });
    if (response === 0) void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  }
}

// ---------- a show in progress: keep the Mac awake, and never quit or update in the middle of it ----------

let blocker: number | null = null;
engine.bus.subscribe((e) => {
  if (e.type === "session.started" && blocker === null) blocker = powerSaveBlocker.start("prevent-app-suspension");
  if (e.type === "session.ended" && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !onAir()) return;
  e.preventDefault();
  void (async () => {
    const { response } = await ask({
      type: "warning", buttons: ["Stop and Quit", "Cancel"], defaultId: 1, cancelId: 1,
      message: "A session is on air",
      detail: "Quitting stops it and keeps the recording. Lines still being transcribed or fact-checked may be lost: "
        + "to keep them, press Stop and wait for the session to end first.",
    });
    if (response !== 0) return;
    quitting = true;
    await Promise.race([engine.stop().catch(() => {}), new Promise((r) => setTimeout(r, QUIT_WAIT_MS))]);
    app.quit();
  })();
});

/**
 * Updates come from the project's GitHub Releases (see docs/desktop.md). They are looked for and downloaded only while
 * nothing is on air, so a download never competes with a live call, and installed when the app quits, or at once if
 * the host chooses to restart.
 */
function updates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (e) => console.error(`update: ${e instanceof Error ? e.message : String(e)}`));
  let offered = false;
  autoUpdater.on("update-downloaded", async (info) => {
    if (offered) return;
    offered = true;
    while (onAir()) await new Promise((r) => setTimeout(r, 30_000));
    const { response } = await ask({
      type: "info", buttons: ["Restart Now", "Later"], defaultId: 0, cancelId: 1,
      message: `Conversation Assistant ${info.version} is ready`,
      detail: "Restart to use it now, or it installs the next time you quit.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => { if (!onAir()) void autoUpdater.checkForUpdates().catch(() => {}); };
  check();
  setInterval(check, UPDATE_EVERY_MS).unref();
}

// ---------- start ----------

app.whenReady().then(() => {
  protocol.handle("app", async (req) => {
    if (new URL(req.url).host !== "conversation-assistant") return new Response("not found", { status: 404 });
    const res = await handle(req);
    if (res.headers.get("content-type")?.startsWith("text/html")) res.headers.set("Content-Security-Policy", CSP);
    return res;
  });
  session.defaultSession.on("will-download", (_e, item) => {
    const target = downloadPath(item.getFilename());
    item.setSavePath(target);
    item.once("done", (_d, state) => { if (state === "completed") app.dock?.downloadFinished(target); });
  });
  app.setAboutPanelOptions({ copyright: "© 2026 Cloudless Consulting Pty Ltd · BSD 3-Clause", website: REPO });
  menu();
  createWindow();
  // in development, macOS asks on behalf of the terminal that started the app, which already has both permissions
  if (app.isPackaged) win!.once("ready-to-show", () => void askPermissions());
  updates();
});

// closing the window keeps the app (and any show on air) running, as Mac apps do; the Dock icon reopens it
app.on("window-all-closed", () => {});
app.on("activate", () => { if (!win) createWindow(); });
app.on("second-instance", () => {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});
