// The Mac app (see docs/desktop.md). The engine runs in this process, the one `npm run serve` starts, and the window
// loads the same web page from the private app:// scheme, answered in-process: no server, no port.
import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, protocol, session, shell, systemPreferences } from "electron";
import electronUpdater, { type UpdateInfo } from "electron-updater";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { appPaths, appSupportDir, setAppPaths } from "../src/paths.ts";
import { bootEngine } from "../src/server/main.ts";
import { inProcessHandler } from "../src/server/inProcess.ts";

const ORIGIN = "app://conversation-assistant";
const REPO = "https://github.com/nicolasdao/conversation-assistant";
/** How long quitting waits for a session on air to end; its audio is complete within seconds (src/pipeline/session.ts). */
const QUIT_WAIT_MS = 30_000;
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;

// A packaged app refuses Chromium's remote debugging: it would let any program on this Mac drive the window, and through
// it the engine, with the app's Microphone and System Audio Recording grants. The fuses in electron-builder.yml close
// the other ways in (running the app as plain Node, NODE_OPTIONS, --inspect).
if (app.isPackaged && ["remote-debugging-port", "remote-debugging-pipe"].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
  process.exit(1);
}

// ---------- where things are: the bundle's Resources, and Application Support ----------

if (app.isPackaged) {
  const res = process.resourcesPath;
  setAppPaths({
    root: app.getAppPath(), web: join(res, "web"), config: join(res, "config"), models: join(res, "models"),
    helper: join(res, "bin", "conversation-capture"), sessions: join(appSupportDir(), "sessions"), src: null,
    notices: join(res, "licenses", "THIRD_PARTY_NOTICES.txt"), licenses: join(res, "licenses"),
  });
  mkdirSync(appPaths().sessions, { recursive: true });
  process.chdir(appSupportDir()); // anything still relative lands here, never in "/"
} else {
  // `npm run app`: the project folder, like `npm run serve`; the engine is bundled, so src/ edits need a restart
  const dir = app.getAppPath();
  setAppPaths({ root: dir, src: join(dir, "src"), notices: join(dir, "THIRD_PARTY_NOTICES.md"), licenses: join(dir, "licenses") });
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
let licensesWin: BrowserWindow | null = null;

// ---------- the windows ----------

function openOutside(url: string) {
  if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
}

/** A window on a page of the app: sandboxed, with the preload's bridge (desktop/preload.ts), and nowhere else to go. */
function appWindow(opts: Electron.BrowserWindowConstructorOptions, path: string): BrowserWindow {
  const w = new BrowserWindow({
    ...opts, backgroundColor: "#0a1628", show: false,
    // no DevTools in the packaged app: pasted into its console, code could use the app's microphone grant
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged,
      preload: join(import.meta.dirname, "preload.cjs"),
    },
  });
  w.once("ready-to-show", () => w.show());
  // links to other sites (key setup steps, fact-check sources, license pages) open in the default browser, never in the app
  w.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    e.preventDefault();
    openOutside(url);
  });
  void w.loadURL(`${ORIGIN}${path}`);
  return w;
}

function createWindow() {
  win = appWindow({ width: 1440, height: 900, minWidth: 1024, minHeight: 640, title: "Conversation Assistant" }, "/");
  win.on("closed", () => { win = null; });
}

/** Licenses and Acknowledgements (web/licenses.html): its own window, which stays open beside the app's. */
function openLicenses() {
  if (licensesWin) return licensesWin.show();
  licensesWin = appWindow({ width: 1040, height: 760, minWidth: 720, minHeight: 480, title: "Licenses and Acknowledgements" }, "/licenses");
  licensesWin.on("closed", () => { licensesWin = null; });
}

/** A command from the menu bar to the page (web/src/desktop.ts): opens the window first, if it was closed. */
function sendCommand(command: string) {
  if (!win) createWindow();
  win!.show();
  const w = win!.webContents;
  if (w.isLoading()) w.once("did-finish-load", () => w.send("desktop:command", command));
  else w.send("desktop:command", command);
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

/** The license files: the app's Resources/licenses when packaged, the project's licenses/ in development. */
const licensesDir = () => (app.isPackaged ? join(process.resourcesPath, "licenses") : join(app.getAppPath(), "licenses"));
/** Chromium's, Node.js's, FFmpeg's, and the rest of Electron's: a 20 MB page, which opens in the browser. */
const chromiumLicenses = () => (app.isPackaged
  ? join(licensesDir(), "LICENSES.chromium.html") : join(app.getAppPath(), "node_modules/electron/dist/LICENSES.chromium.html"));

/** What a page may ask the app for (web/src/desktop.ts), from the app's own pages only. */
ipcMain.on("desktop:run", (e, request: unknown) => {
  if (!e.senderFrame?.url.startsWith(`${ORIGIN}/`)) return;
  if (request === "open-licenses") openLicenses();
  else if (request === "open-chromium-licenses") void shell.openPath(chromiumLicenses());
  else if (request === "show-license-files") void shell.openPath(licensesDir());
});

function updateItem(): Electron.MenuItemConstructorOptions {
  if (update.kind === "checking") return { label: "Checking for Updates…", enabled: false };
  if (update.kind === "downloading") return { label: `Downloading ${update.version}… ${update.percent}%`, enabled: false };
  return { label: "Check for Updates…", click: () => void checkForUpdatesNow() };
}

/** The menu bar; rebuilt when the update item changes. */
function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        updateItem(),
        { type: "separator" },
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => sendCommand("keys") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
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
    {
      role: "help",
      submenu: [
        { label: "Conversation Assistant on GitHub", click: () => void shell.openExternal(REPO) },
        { type: "separator" },
        { label: "Licenses and Acknowledgements", click: () => openLicenses() },
      ],
    },
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
 * the host chooses to restart. An automatic check downloads a new version quietly, then offers to restart; Check for
 * Updates… says what it found and downloads only when asked.
 */
type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string };

let update: UpdateState = { kind: "idle" };
/** The version whose restart was offered: "update-downloaded" offers each version once; Check for Updates… offers it again. */
let offered: string | null = null;
const { autoUpdater } = electronUpdater;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** An updater error, short enough for a sheet: its first line. */
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n", 1)[0]!.slice(0, 200);

/** Shows the state in the menu, and a download's progress on the Dock icon. */
function setUpdate(next: UpdateState) {
  update = next;
  win?.setProgressBar(next.kind === "downloading" ? next.percent / 100 : -1);
  menu();
}

/** Asks GitHub for a newer version: its info, or null when this is the newest. */
async function lookForUpdate(): Promise<UpdateInfo | null> {
  setUpdate({ kind: "checking" });
  try {
    const r = await autoUpdater.checkForUpdates();
    return r?.isUpdateAvailable ? r.updateInfo : null;
  } finally {
    if (update.kind === "checking") setUpdate({ kind: "idle" });
  }
}

/** Downloads a found version; "update-downloaded" then makes it ready. */
async function download(version: string) {
  setUpdate({ kind: "downloading", version, percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    if (update.kind === "downloading") setUpdate({ kind: "idle" });
    throw e;
  }
}

async function offerRestart(version: string) {
  offered = version;
  while (onAir()) await sleep(30_000);
  const { response } = await ask({
    type: "info", buttons: ["Restart Now", "Later"], defaultId: 0, cancelId: 1,
    message: `Conversation Assistant ${version} is ready`,
    detail: "Restart to use it now, or it installs the next time you quit.",
  });
  if (response === 0) autoUpdater.quitAndInstall();
}

/** Check for Updates…: every outcome is said, on a sheet (see ask()). */
async function checkForUpdatesNow() {
  const current = app.getVersion();
  const info = (message: string, detail: string, type: "info" | "warning" = "info") =>
    ask({ type, buttons: ["OK"], message, detail });
  const onAirSheet = () => info("Updates wait until the show ends",
    `You have ${current}. Nothing is checked for or downloaded while a session is on air.`);
  if (!app.isPackaged) {
    return void info("Updates come only to the installed app",
      `This copy runs from the project folder (${current}). Install a signed build to check for updates.`);
  }
  if (onAir()) return void onAirSheet();
  if (update.kind === "ready") return offerRestart(update.version);
  if (update.kind !== "idle") return;
  let found: UpdateInfo | null;
  try {
    found = await lookForUpdate();
  } catch (e) {
    return void info("Can't check for updates right now", `${reason(e)}\n\nCheck the internet connection and try again. You have ${current}.`, "warning");
  }
  if (!found) return void info("You're up to date", `Conversation Assistant ${current} is the newest version.`);
  for (;;) {
    const { response } = await ask({
      type: "info", buttons: ["Download and Install", "Later", "Release Notes"], defaultId: 0, cancelId: 1,
      message: "A new version is available",
      detail: `Conversation Assistant ${found.version} is out. You have ${current}.`,
    });
    if (response === 2) { void shell.openExternal(`${REPO}/releases/tag/v${found.version}`); continue; }
    if (response !== 0) return;
    break;
  }
  if (onAir()) return void onAirSheet(); // a session started while the sheet was up
  // when it is done, "update-downloaded" offers the restart: this version was never offered, or it would be ready
  try {
    await download(found.version);
  } catch (e) {
    return void info("The download failed", `${reason(e)}\n\nTry Check for Updates… again later. You have ${current}.`, "warning");
  }
}

function updates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false; // started here: at once after an automatic check, on request after Check for Updates…
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (e) => console.error(`update: ${e instanceof Error ? e.message : String(e)}`));
  autoUpdater.on("download-progress", (p) => {
    const percent = Math.floor(p.percent / 5) * 5; // the menu is rebuilt only every 5 %
    if (update.kind === "downloading" && percent > update.percent) setUpdate({ ...update, percent });
  });
  autoUpdater.on("update-downloaded", (i) => {
    setUpdate({ kind: "ready", version: i.version });
    if (offered !== i.version) void offerRestart(i.version);
  });
  const check = async () => {
    if (onAir() || update.kind !== "idle") return;
    try {
      const found = await lookForUpdate();
      if (found && !onAir()) await download(found.version);
    } catch { /* logged by the "error" handler; the next check tries again */ }
  };
  void check();
  setInterval(() => void check(), UPDATE_EVERY_MS).unref();
}

// ---------- start ----------

/** The only browser permission the page needs: the chat's Copy buttons. Capture goes through the helper, never the page. */
const PAGE_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

app.whenReady().then(() => {
  // Electron grants a page every permission it asks for unless told otherwise
  session.defaultSession.setPermissionRequestHandler((_w, permission, done) => done(PAGE_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_w, permission) => PAGE_PERMISSIONS.has(permission));
  protocol.handle("app", async (req) => {
    if (new URL(req.url).host !== "conversation-assistant") return new Response("not found", { status: 404 });
    return handle(req); // the page's Content-Security-Policy comes with it (PAGE_CSP in src/server/main.ts)
  });
  session.defaultSession.on("will-download", (_e, item) => {
    const target = downloadPath(item.getFilename());
    item.setSavePath(target);
    item.once("done", (_d, state) => { if (state === "completed") app.dock?.downloadFinished(target); });
  });
  app.setAboutPanelOptions({
    copyright: "© 2026 Cloudless Consulting Pty Ltd · BSD 3-Clause",
    credits: "Includes third-party software under their own licenses: Help → Licenses and Acknowledgements.",
    website: REPO,
  });
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
