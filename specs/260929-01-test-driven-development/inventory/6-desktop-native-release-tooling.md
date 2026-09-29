> **Inventory for [SPEC.md](../SPEC.md) — Area 6: Electron main/preload, Swift capture helper, scripts, website, release skill, tooling.** Written 2026-09-29 by a read-only scan of commit `74b42a6`. Line numbers were right at that commit; **symbol names win when lines drift** (grep them). "Spike" and "scratchpad" mentions refer to throwaway experiments run outside the repo during the scan; they are not available to you, but every recipe they validated is written out below. Items marked *unverified*/*UNSURE*/*hedged* are exactly that — verify before relying on them. SPEC.md overrides this file wherever they disagree (scope, thresholds, bug policy, file layout).

> **Scope override:** the user put **§C scripts/**, **§D website/** and **§E.3 release-script tests** OUT of scope for this spec (SPEC.md §5). They are kept here only as reference for a later spec. §A (desktop), §B (Swift), §E.1–E.2 (release skill integration) and §F (tooling) are in scope.

# Scan: desktop, native capture, scripts, website, release skill, tooling

Project root: the repository root (all paths below are relative to it).
Scanned 2026-09-29, read-only. Baseline: `npx vitest run tests/desktop.test.ts tests/inProcess.test.ts` passes (2 files, 11 tests, 0.4 s).
Node active in the shell is **v24.0.1** (nvm), which matters for dependency choice (see F).

Evidence gathered outside the project (in the scratchpad only; no project file changed):
- **Spike 1:** `@playwright/test`'s engine (`playwright-core@1.63.0`) `_electron.launch` drove the project's Electron **44.4.5** binary with an ESM main, a sandboxed window, and a custom `app://` scheme. Both the default launch (`-r loader.js`) and `executablePath` worked, and `firstWindow().title()`, `textContent`, and `app.evaluate` behaved.
- **Spike 2:** the Swift package was copied to the scratchpad, a `.testTarget` depending on the **executable** target was added, and `swift test` ran 10 Swift Testing tests (`@testable import tattle_capture`), with coverage via `--enable-code-coverage` and `llvm-cov`. No library split is needed.
- **Spike 3:** a vitest 5.0.1 test (run with the project's vitest binary, root in the scratchpad) imported the real `desktop/main.ts` with `vi.mock("electron")`, `vi.mock("electron-updater")`, and mocks of `src/server/main.ts`, `src/server/inProcess.ts`, and `src/paths.ts`. It exercised the window, the protocol handler, the permission handlers, and the menu, and it passed. `import.meta.dirname` works under vitest.
- **Spike 4:** the `sha384` pins in `website/index.html` equal the SHA-384 of the files in the npm tarball `three@0.170.0`. The import-map SHA-256 recomputed now equals the one in `website/_headers` (`sha256-mya8lPJXErB8mSeQkeworyK5W4Syd+9fFdtxxcasD4o=`).

---

## A. Desktop (Electron main, preload, packaging) and the in-process bridge

### A.1 `desktop/main.ts` (410 lines): symbols, line numbers, Electron APIs

Imports (line 3): `app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, protocol, session, shell, systemPreferences` from `electron`. The default import `electronUpdater` comes from `electron-updater` (line 4). It also imports `execFile` from `node:child_process`, `existsSync, mkdirSync`, `extname, join`, `appPaths, appSupportDir, migrateAppSupportDir, setAppPaths` (`src/paths.ts`), `bootEngine` (`src/server/main.ts`), and `inProcessHandler` (`src/server/inProcess.ts`).

Nothing is exported. The whole module is top-level side effects, so every unit test must `vi.resetModules()` and then `await import("../desktop/main.ts")` after setting up mocks.

| Symbol / block | Line | What | Electron APIs |
|---|---|---|---|
| `ORIGIN` = `"app://conversation-assistant"` | 13 | Page origin (must never change) | - |
| `REPO` | 14 | `https://github.com/nicolasdao/tattle` | - |
| `QUIT_WAIT_MS` = 30 000 | 16 | Max wait for `engine.stop()` on quit | - |
| `UPDATE_EVERY_MS` = 4 h | 17 | Periodic update check | - |
| remote-debugging refusal | 22-25 | `if (app.isPackaged && hasSwitch("remote-debugging-port"\|"remote-debugging-pipe")) { app.exit(1); process.exit(1) }`. **Gated on `app.isPackaged` only**, so dev `electron .` accepts Playwright's `--remote-debugging-port=0` and `--inspect=0` | `app.isPackaged`, `app.commandLine.hasSwitch`, `app.exit` |
| `migrateAppSupportDir()` | 30 | Runs at import (touches the real `~/Library/Application Support` unless `HOME` is overridden or the module is mocked) | - |
| packaged paths | 31-39 | `setAppPaths({root: app.getAppPath(), web/config/models under process.resourcesPath, helper: Resources/bin/tattle-capture, sessions: appSupportDir()/sessions, src:null, notices, licenses})`, `mkdirSync(sessions)`, `process.chdir(appSupportDir())` | `app.getAppPath`, `process.resourcesPath` |
| dev paths | 40-44 | `setAppPaths({root: dir, src: dir/src, notices: dir/THIRD_PARTY_NOTICES.md, licenses: dir/licenses})`. `web`, `config`, `models`, and `sessions` stay **cwd-relative** defaults | - |
| userData | 46 | `app.setPath("userData", join(appSupportDir(), "Window"))` | `app.setPath` |
| single instance | 48-51 | `if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }` | `requestSingleInstanceLock` |
| scheme | 53-55 | `protocol.registerSchemesAsPrivileged([{scheme:"app", privileges:{standard, secure, supportFetchAPI, stream, corsEnabled:false}}])` | `protocol` |
| engine | 58-60 | `bootEngine({allowOverDevCap: app.isPackaged})`, `handle = inProcessHandler(server)`, `onAir = () => engine.current?.status === "running"` | - |
| `openOutside(url)` | 66-68 | `shell.openExternal` only for `https?:` or `mailto:` | `shell.openExternal` |
| `appWindow(opts, path)` | 71-90 | `BrowserWindow` with `backgroundColor #0a1628`, `show:false`, webPreferences `{contextIsolation, sandbox, nodeIntegration:false, spellcheck:false, devTools: !app.isPackaged, preload: join(import.meta.dirname,"preload.cjs")}`. It shows on `ready-to-show`; `setWindowOpenHandler` calls `openOutside` and returns `{action:"deny"}`; `will-navigate` allows only the `${ORIGIN}/` prefix and otherwise calls `preventDefault` and `openOutside`. `loadURL(ORIGIN+path)` | `BrowserWindow`, `webContents.setWindowOpenHandler`, `webContents.on("will-navigate")` |
| `createWindow()` | 92-95 | 1440×900 (min 1024×640), title "Tattle", path "/"; `closed` sets `win = null` | - |
| `openLicenses()` | 98-102 | Reuses an open window (`.show()`); otherwise 1040×760 `/licenses`; `closed` sets it to null | - |
| `sendCommand(command)` | 105-111 | Creates the window if needed, shows it, then sends `"desktop:command"` now, or on `did-finish-load` while `isLoading()` | `webContents.send`, `isLoading` |
| `ask(opts)` | 117-121 | Always `dialog.showMessageBox(win!, opts)`, a sheet on the window; creates the window if it is missing | `dialog.showMessageBox` |
| `downloadPath(fileName)` | 124-131 | `app.getPath("downloads")`, then `name.ext`, `name (2).ext`, and so on while `existsSync` | `app.getPath` |
| `licensesDir()` | 134 | Packaged: `resourcesPath/licenses`; dev: `getAppPath()/licenses` | - |
| `chromiumLicenses()` | 136-137 | Packaged: `licenses/LICENSES.chromium.html`; dev: `node_modules/electron/dist/LICENSES.chromium.html` | - |
| `ipcMain.on("desktop:run")` | 140-145 | Ignores the request unless `e.senderFrame?.url` starts with `${ORIGIN}/`. Handles `"open-licenses"` (window), `"open-chromium-licenses"` (`shell.openPath`), and `"show-license-files"` (`shell.openPath`); anything else is ignored | `ipcMain`, `shell.openPath` |
| `updateItem()` | 147-151 | `checking` gives "Checking for Updates…" (disabled); `downloading` gives "Downloading X… N%" (disabled); anything else gives "Check for Updates…" with a click that calls `checkForUpdatesNow` | - |
| `menu()` | 154-193 | App menu `[about, updateItem, sep, Settings… (Cmd+,) → sendCommand("keys"), sep, services, sep, hide, hideOthers, unhide, sep, quit]`; File `[Show Recordings in Finder → shell.openPath(appPaths().sessions), sep, close]`; editMenu; viewMenu; windowMenu; help `[Tattle on GitHub → openExternal(REPO), sep, Licenses and Acknowledgements → openLicenses]` | `Menu.buildFromTemplate`, `Menu.setApplicationMenu` |
| `askPermissions()` | 202-221 | `systemPreferences.getMediaAccessStatus("microphone")`. `not-determined`: info sheet, then `execFile(helper, ["--probe","1"], {timeout:120000})`. `denied`/`restricted`: a warning sheet; response 0 opens `x-apple.systempreferences:…Privacy_Microphone`. `granted`: nothing | `systemPreferences` |
| power-save blocker | 225-229 | `engine.bus.subscribe`: `session.started` with no blocker starts `prevent-app-suspension`; `session.ended` with a blocker stops it and clears it | `powerSaveBlocker` |
| `before-quit` | 231-247 | If `quitting` or not on air, the quit proceeds. Otherwise it `preventDefault`s and asks "Stop and Quit"/"Cancel" (default and cancel = 1). On 0 it sets `quitting = true`, races `engine.stop().catch()` against `QUIT_WAIT_MS`, then `app.quit()` | `app.on` |
| `UpdateState` type | 255-259 | `idle \| checking \| downloading{version,percent} \| ready{version}` | - |
| `update`, `offered` | 261, 263 | Module state | - |
| `reason(e)` | 267 | First line of the message, at most 200 chars; also handles non-Error values | - |
| `setUpdate(next)` | 270-274 | `win?.setProgressBar(downloading ? percent/100 : -1)`, then `menu()` | `setProgressBar` |
| `lookForUpdate()` | 277-285 | Sets checking, then `autoUpdater.checkForUpdates()` and returns `isUpdateAvailable ? updateInfo : null`; the `finally` resets to idle if still checking | - |
| `download(version)` | 288-296 | Sets downloading 0%, then `autoUpdater.downloadUpdate()`; on error it resets to idle if still downloading and rethrows | - |
| `offerRestart(version)` | 298-307 | Sets `offered = version`, then `while(onAir()) await sleep(30000)`, then a sheet "Tattle X is ready" (Restart Now/Later); 0 calls `autoUpdater.quitAndInstall()` | - |
| `checkForUpdatesNow()` | 310-347 | See the outcome table below | - |
| `updates()` | 349-371 | Returns early unless packaged. Sets `autoDownload=false`, `autoInstallOnAppQuit=true`, and handlers for `error` (console.error), `download-progress` (floored to steps of 5 and applied only if higher), and `update-downloaded` (ready, and `offerRestart` unless already offered). `check()` skips when on air or not idle, otherwise looks, and downloads if found and not on air; its catch is silent. Runs `void check()` now and `setInterval(check, 4h).unref()` | `autoUpdater` |
| `PAGE_PERMISSIONS` | 376 | `Set(["clipboard-sanitized-write"])` | - |
| `app.whenReady()` | 378-401 | Permission request and check handlers; `protocol.handle("app")` (host ≠ `conversation-assistant` gives 404, otherwise `handle(req)`); `will-download` saves to `downloadPath`, and `done`/`completed` calls `app.dock?.downloadFinished`; `setAboutPanelOptions`; `menu()`; `createWindow()`; packaged only: `win.once("ready-to-show", askPermissions)`; `updates()` | `session.defaultSession.*`, `protocol.handle`, `app.setAboutPanelOptions`, `app.dock` |
| `window-all-closed` | 404 | No-op, so the app keeps running | - |
| `activate` | 405 | `if (!win) createWindow()` | - |
| `second-instance` | 406-410 | No window: create one. Otherwise restore if minimised, then focus | - |

`checkForUpdatesNow()` outcomes (310-347). Each is a sheet via `ask()`:
1. Not packaged: "Updates come only to the installed app" (316-318).
2. On air: "Updates wait until the show ends" (320).
3. `update.kind === "ready"`: `offerRestart(version)` again (321).
4. `checking` or `downloading`: return silently (322).
5. `lookForUpdate` throws: "Can't check for updates right now" (warning) with `reason(e)` (324-328).
6. Nothing found: "You're up to date" (329).
7. Found: a loop over "Download and Install"/"Later"/"Release Notes". Response 2 opens `${REPO}/releases/tag/v${version}` and re-asks, 1 returns, 0 breaks (330-339).
8. A session started during the sheet: the on-air sheet (340).
9. `download()` throws: "The download failed" (warning) (342-346).

### A.2 `desktop/preload.ts` (23 lines)
- `ipcRenderer.on("desktop:command")` (9-13) drops non-string commands. With a listener it calls the listener; otherwise it pushes to `pending`.
- `contextBridge.exposeInMainWorld("desktop", { onCommand(cb) (16-19): sets the listener and flushes pending in order; run(request) (20-22): ipcRenderer.send("desktop:run", String(request)) })`.
- It is fully unit-testable with `vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { on: vi.fn(), send: vi.fn() } }))`.

### A.3 `desktop/*.plist`, `electron-builder.yml`
- `desktop/entitlements.mac.plist`: `cs.allow-jit`, `cs.allow-unsigned-executable-memory`, `device.audio-input`.
- `desktop/entitlements.adhoc.plist`: the same plus `cs.disable-library-validation`. A release must never use it.
- `electron-builder.yml`:
  - `appId com.cloudlesslabs.conversation-assistant` (must never change) (3).
  - `files` = `dist/desktop/**`, `package.json`, `LICENSE`, `!**/*.map` (10-14). Dev-only test dependencies never ship. `third-party-notices` uses `npm ls --omit=dev`, so adding devDependencies does not change `THIRD_PARTY_NOTICES.md`.
  - `electronFuses` (18-24): runAsNode false, NodeOptions false, NodeCliInspect false, asar integrity true, onlyLoadAppFromAsar true, grantFileProtocolExtraPrivileges false.
  - `extraResources` (30-51); `mac` (52-68, arm64 dmg+zip, `minimumSystemVersion 14.2`, `hardenedRuntime`, `notarize: true`, usage strings); `publish` github `nicolasdao/tattle` (72-76).
- Static contract tests are possible (parse YAML/plist as text; there is no YAML parser dependency, so use regexes or add `yaml` as a devDependency):
  - `it("keeps the bundle id com.cloudlesslabs.conversation-assistant")`
  - `it("sets every hardening fuse (runAsNode, NodeOptions, NodeCliInspect off; asar integrity and onlyLoadAppFromAsar on)")`
  - `it("ships only dist/desktop, package.json and LICENSE as app code, never source maps")`
  - `it("publishes to github nicolasdao/tattle, matching REPO in desktop/main.ts")` (cross-file consistency)
  - `it("uses entitlements.mac.plist (not adhoc) for mac.entitlements and entitlementsInherit")`
  - `it("entitlements.mac.plist has exactly allow-jit, allow-unsigned-executable-memory, audio-input")`
  - `it("adhoc plist equals mac plist plus disable-library-validation")`
  - `it("mac.extendInfo usage strings equal native/capture/Info.plist's")`
- The packaged fuses are verifiable after a build: `node_modules/.bin/electron-fuses read --app out/mac-arm64/Tattle.app`. Run now, it printed RunAsNode, NodeOptions, and NodeCliInspect Disabled; AsarIntegrity and OnlyLoadAppFromAsar Enabled; GrantFileProtocolExtraPrivileges Disabled; plus one line `undefined is Enabled`. The installed `@electron/fuses` does not know one of Electron 44's newer fuses; that is harmless, but a parser must tolerate it.

### A.4 `src/server/inProcess.ts` (38 lines): `inProcessHandler(server)` (line 8)
- `duplexPair()` (11). Closes are linked across the pair (14-15). `server.emit("connection", side)` (16). Headers are copied, `host` forced to `127.0.0.1`, `origin` deleted, `connection: close` (17-23). `httpRequest({createConnection})` (25). Response headers are joined with `", "` for arrays (27). `status ?? 500` (28). The body is empty for 204, 304, or HEAD, via `res.resume()` (29-31). `out.on("error", reject)` (33). A request body is piped from `Readable.fromWeb`; a body error calls `out.destroy(e)` (34); otherwise `out.end()` (35).
- Existing tests (`tests/inProcess.test.ts`) cover the page, JSON, 404, POST body, setup routes, SSE plus unsubscribe, a Range 206, and pair closure.
- **Untested branches**, as proposed tests:
  - `it("returns a null body for HEAD and drains the response")`: server `res.end("x")`, `method: "HEAD"`; expect `r.body === null`, status 200.
  - `it("returns a null body for 204 and 304")`.
  - `it("joins array-valued response headers with a comma")`: server `res.setHeader("x-a", ["1","2"])`; expect `"1, 2"`.
  - `it("rejects when the router destroys the socket before responding")`: server `req.socket.destroy()`; expect the promise to reject.
  - `it("rejects when the request body stream errors")`: `new Request(url, { method: "POST", body: new ReadableStream({ start(c){ c.error(new Error("boom")) } }), duplex: "half" })`; expect a rejection.
  - `it("overrides Host to 127.0.0.1 and strips Origin")`: an echo server returns `req.headers`.
  - `it("passes the query string through")`: `/x?a=1`.
  - `it("falls back to 500 when statusCode is missing")`. Hard to trigger: `statusCode` is always set by `http`. Mark it `/* v8 ignore next */` or accept it as a branch gap. unverified whether v8 counts `??` as a branch here. It does count `??` as a branch in v8 coverage generally.

### A.5 Unit-testing `desktop/main.ts` by mocking `electron` (vitest, node env): **validated by Spike 3**

Harness recipe, which worked in the spike:
```ts
// tests/desktop-main.test.ts
import { vi, test, expect, beforeEach } from "vitest";
const h = vi.hoisted(() => ({ s: {} as any }));
vi.mock("electron", async () => { const { EventEmitter } = await import("node:events"); /* build fakes into h.s */ return { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, protocol, session, shell, systemPreferences }; });
vi.mock("electron-updater", async () => { const { EventEmitter } = await import("node:events"); const autoUpdater = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() }); h.s.updater = autoUpdater; return { default: { autoUpdater } }; });
vi.mock("../src/server/main.ts", () => ({ bootEngine: vi.fn(() => ({ engine: h.s.engine, server: {} })) }));
vi.mock("../src/server/inProcess.ts", () => ({ inProcessHandler: () => async () => new Response("page") }));
vi.mock("../src/paths.ts", async (orig) => ({ ...(await orig()), migrateAppSupportDir: vi.fn(), appSupportDir: () => h.s.tmp }));
beforeEach(() => { vi.resetModules(); /* reset h.s, set h.s.app.isPackaged etc. */ });
const boot = async () => { await import("../desktop/main.ts"); h.s.resolveReady(); await flush(); };
```

Harness requirements:
- **Fake `app`:** `isPackaged`, `commandLine.hasSwitch`, `exit`, `quit`, `getAppPath`, `setPath`, `getPath("downloads")` pointing at a tmp dir, `requestSingleInstanceLock`, `whenReady()` returning a controllable promise, `on(event, cb)` storing handlers, `name`, `getVersion`, `setAboutPanelOptions`, and `dock.downloadFinished`.
- **Fake `BrowserWindow` class:** records instances, with `opts`, `once`, `on`, `show`, `loadURL`, `setProgressBar`, `isMinimized`, `restore`, and `focus`. Its `webContents` has `setWindowOpenHandler`, `on`, `once`, `send`, and `isLoading`.
- **Fake engine:** `{ bus: { subscribe: fn => store }, current: null | { status: "running" }, stop: vi.fn() }`.
- **Process spies:** `process.exit` via `vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit") }) as never)`, and `process.chdir` via a mock implementation. For packaged runs, set `process.resourcesPath`, e.g. `Object.defineProperty(process, "resourcesPath", { value: "/R", configurable: true })`.
- **Timers:** use `vi.useFakeTimers()` for `offerRestart`'s 30 s sleep, the `QUIT_WAIT_MS` race, and the 4 h `setInterval`.
- **Paths:** reset with `setAppPaths()` in `afterEach`.

Concrete cases (`it` one-liners):

Boot, both modes:
- `it("exits with 1 when packaged and started with --remote-debugging-port")` / `it("… with --remote-debugging-pipe")`: `app.exit(1)` and `process.exit(1)` are called.
- `it("does not refuse remote debugging in development")` (the Playwright prerequisite).
- `it("migrates the old Application Support folder before anything else")`.
- `it("packaged: points every path into Resources and Application Support, creates sessions/, and chdirs there")`.
- `it("dev: keeps project paths with src watched and root = getAppPath()")`.
- `it("stores window storage in <appSupport>/Window")`.
- `it("quits and exits 0 when another instance holds the lock")`.
- `it("registers app:// as standard, secure, fetch, stream, no CORS")`.
- `it("boots the engine with allowOverDevCap = isPackaged")`.

Window:
- `it("opens one 1440x900 window on app://conversation-assistant/ with sandbox, contextIsolation, no nodeIntegration, and the preload")`.
- `it("enables DevTools only in development")`.
- `it("shows the window on ready-to-show")`.
- `it("window.open of https/mailto opens in the browser and is denied")`.
- `it("window.open of file:/javascript: is denied and not opened")`.
- `it("will-navigate within app://conversation-assistant/ is allowed")`.
- `it("will-navigate elsewhere is prevented and opened outside")`.

Protocol and permissions:
- `it("app:// requests for another host get 404")`.
- `it("app://conversation-assistant requests go to the in-process handler")`.
- `it("grants only clipboard-sanitized-write, both request and check handlers")`.

Downloads:
- `it("names downloads name.ext, then name (2).ext, name (3).ext")` (create files in the tmp downloads dir).
- `it("bounces the Dock downloads stack only on completed")`.
- `it("tolerates a missing app.dock")`.

Menu and bridge:
- `it("builds Tattle/File/Edit/View/Window/Help menus in order")`.
- `it("Settings… sends desktop:command keys, now when loaded")`.
- `it("Settings… with the window closed recreates it and sends after did-finish-load")`.
- `it("Show Recordings in Finder opens appPaths().sessions")`.
- `it("Help → Tattle on GitHub opens REPO")`.
- `it("Licenses opens one window at /licenses and reuses it")`.
- `it("closing the licenses window lets the next click create a new one")`.
- `it("desktop:run from a foreign frame is ignored")`.
- `it("desktop:run with a null senderFrame is ignored")`.
- `it("desktop:run open-chromium-licenses opens node_modules/electron/dist/LICENSES.chromium.html in dev and Resources/licenses/LICENSES.chromium.html packaged")`.
- `it("desktop:run show-license-files opens the licenses dir")`.
- `it("desktop:run unknown request does nothing")`.

Permissions (packaged):
- `it("packaged + not-determined: shows the two-permissions sheet on the window, then probes the helper with --probe 1")` (mock `node:child_process` `execFile`).
- `it("packaged + denied: Open System Settings opens the privacy URL")`.
- `it("packaged + restricted + Not now: opens nothing")`.
- `it("packaged + granted: no sheet")`.
- `it("dev: never asks permissions")`.

On air and quitting:
- `it("starts one prevent-app-suspension blocker on session.started and stops it on session.ended")`.
- `it("a second session.started does not start a second blocker")`.
- `it("session.ended without a blocker does nothing")`.
- `it("quitting off air proceeds without a sheet")`.
- `it("quitting on air prevents quit and asks; Cancel keeps running")`.
- `it("Stop and Quit stops the engine then quits")`.
- `it("Stop and Quit quits after 30 s even if engine.stop never resolves")` (fake timers).
- `it("Stop and Quit quits even if engine.stop rejects")`.
- `it("a second before-quit after Stop and Quit proceeds (quitting flag)")`.

Updates (packaged):
- `it("dev: updates() does nothing and Check for Updates says only the installed app updates")`.
- `it("packaged: autoDownload off, autoInstallOnAppQuit on")`.
- `it("automatic check downloads a found version quietly")`.
- `it("automatic check skips while on air")`.
- `it("automatic check skips when not idle")`.
- `it("automatic check swallows errors")`.
- `it("re-checks every 4 hours")` (advance timers).
- `it("download-progress updates the menu label in 5% steps and the Dock progress bar")`.
- `it("download-progress lower than current is ignored")`.
- `it("download-progress while not downloading is ignored")`.
- `it("update-downloaded marks ready and offers Restart once per version")`.
- `it("Restart Now calls quitAndInstall; Later does not")`.
- `it("offerRestart waits while on air, then asks")` (advance 30 s steps).
- `it("Check for Updates on air shows the wait sheet")`.
- `it("Check for Updates when ready offers restart again even after Later")`.
- `it("Check for Updates while checking/downloading does nothing")`.
- `it("Check for Updates: up to date sheet")`.
- `it("Check for Updates: error sheet shows the first line only, max 200 chars")`.
- `it("Check for Updates: non-Error rejection is stringified")`.
- `it("Check for Updates: Release Notes opens the tag page and re-asks")`.
- `it("Check for Updates: Later does nothing")`.
- `it("Check for Updates: Download and Install downloads")`.
- `it("Check for Updates: session started during the sheet shows the wait sheet, no download")`.
- `it("Check for Updates: download failure shows The download failed and returns to idle")`.
- `it("menu shows Checking for Updates… disabled while checking")`.
- `it("lookForUpdate leaves idle state after a check even when it throws")`.
- `it("the error event logs update: <message>")`.

Lifecycle:
- `it("window-all-closed keeps the app running")`.
- `it("activate recreates a closed window")`.
- `it("second-instance recreates a closed window, restores a minimised one, and focuses")`.
- `it("sets About panel options with copyright, credits and REPO")`.

Caveats:
- `vi.mock("electron")` must resolve to the same id as main.ts's import. Inside the project it does. It failed only in the spike when the test file sat outside the project, until `node_modules/electron` was resolvable.
- Module state (`update`, `offered`, `win`, `blocker`, `quitting`) persists per module instance, so there must be one `resetModules` and import per test.

### A.6 Needs Playwright `_electron` against `electron .` (dev), **validated to launch Electron 44.4.5**
- **Launch:** `npm run build:web && npm run build:desktop` first; the app's `main` is `dist/desktop/main.mjs`. Then:
  ```ts
  const app = await _electron.launch({ args: ["."], cwd: ROOT, env: { ...process.env, HOME: tmpHome, TATTLE_CREDENTIALS: join(tmpHome, "credentials.json"), OPENAI_API_KEY: "", OPENROUTER_API_KEY: "" } })
  ```
  Here `ROOT` is the project root, and the key variables are emptied (or the env is built without them).
- **Why `HOME` must be isolated (important):**
  1. `appSupportDir()` (`src/paths.ts:57`) uses `homedir()`, and Node's `homedir()` honours `$HOME`.
  2. Without isolation, dev `npm run app` and the installed Tattle share `~/Library/Application Support/Tattle/Window` (userData, localStorage), `credentials.json`, and the single-instance lock. I believe Electron keys `requestSingleInstanceLock` on the userData dir (unverified), so with the installed app running, a dev launch would `process.exit(0)` silently (main.ts:48-51).
- **cwd must be the project root:** in dev, `web`, `config`, `models`, and `sessions` are cwd-relative (`src/paths.ts:32-42`). So e2e **sees the developer's real `sessions/` recordings**, which are private and gitignored. There is no env override for sessions today. Suggested minimal hook for the spec: an env such as `TATTLE_SESSIONS_DIR` read in the dev branch at main.ts:40-44, or in `DEFAULTS`. Otherwise tests must not assert on the recordings list.
- **Downloads:** redirect them with `app.evaluate(({ app }, d) => app.setPath("downloads", d), tmp)` before an export test (`downloadPath` reads `getPath` at call time).
- **Native dialogs are invisible to Playwright.** Stub them in the main process: `app.evaluate(({ dialog }) => { dialog.showMessageBox = async (w, o) => { (globalThis as any).__sheets = [...((globalThis as any).__sheets ?? []), o]; return { response: 0 }; }; })`. main.ts reads `dialog.showMessageBox` at call time from the external `electron` module object, so the patch applies. It is unverified that Electron's module properties are writable (likely). Do the same for `shell.openExternal` and `shell.openPath`.
- **Menu items:** get them via `app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map(i => i.label))`; click with `.submenu.items.find(i => i.label === "Settings…").click()`.

Scenarios:
- `it("opens one window titled Tattle at app://conversation-assistant/")`.
- `it("shows the setup (API keys) screen when no keys are configured")`.
- `it("exposes window.desktop with onCommand and run, and no require/process")` (`page.evaluate(() => [typeof (window as any).desktop?.onCommand, typeof (window as any).require])`).
- `it("GET /api/state over app:// returns JSON")` (`page.evaluate(() => fetch("/api/state").then(r => r.json()))`).
- `it("the page has the router's CSP header")` (`page.evaluate` fetch of `/` and read the header, or check that an inline script is blocked).
- `it("menu bar has Tattle, File, Edit, View, Window, Help")`.
- `it("Settings… opens the keys panel")`.
- `it("Settings… after closing the window reopens it and delivers keys once loaded")` (tests the preload's `pending` queue in reality).
- `it("Help → Licenses and Acknowledgements opens a second window at /licenses, and a second click does not open a third")`.
- `it("desktop.run('open-licenses') from the page opens the licenses window")`.
- `it("Check for Updates… in development shows 'Updates come only to the installed app'")` (with the dialog stub).
- `it("window.open('https://example.com') opens no window and calls shell.openExternal")`.
- `it("location.href = 'https://example.com' is refused; URL stays app://")`.
- `it("getUserMedia is refused; clipboard.writeText works")` (permission handler in reality).
- `it("closing the window keeps the process alive; activate reopens it")` (`app.evaluate(({ app }) => app.emit("activate"))`).
- `it("a second launch with the same HOME exits and focuses the first window")`.
- `it("an export lands in Downloads as name.tattle, then name (2).tattle")` (needs a recording in `sessions/`; conflicts with the cwd issue above, so gate it on the sessions hook).

Not e2e-able offline: quit while on air. A live or replay session needs API keys and paid calls; the release constraint says never. Keep that in the unit harness.

### A.7 Only in a packaged, signed build (not automatable in `npm test`; possibly a post-build smoke test in `build-app.sh`)
- **Auto-update end to end:** needs a signed build plus a newer published release.
- **macOS permission prompts and the TCC attribution**, and the "two permissions" first-launch sheet (packaged-only by design, main.ts:399).
- **Fuses:** check with `electron-fuses read --app out/mac-arm64/Tattle.app`. Feasible as a post-build assertion.
- **`--remote-debugging-port` refusal:** `spawn(out/mac-arm64/Tattle.app/Contents/MacOS/Tattle, ["--remote-debugging-port=9222"])` should exit with code 1 before touching user data. main.ts:22 runs before `migrateAppSupportDir` (30), so this is safe and automatable post-build.
- **asar integrity, Gatekeeper, notarization, stapling:** already in `build-app.sh` and `verify-release.sh`.
- Playwright cannot drive the packaged app: `--inspect` is fused off and `--remote-debugging-port` exits. This is documented in `docs/gotchas.md:72`.

### A.8 Playwright and Electron 44 compatibility
- `npm view @playwright/test version` gives **1.63.0** (engines node >= 20).
- Playwright launches Electron with `["--inspect=0", "--remote-debugging-port=0", ...args]`, plus `-r <playwright-core>/lib/server/electron/loader.js` unless `executablePath` is given. It deletes `env.NODE_OPTIONS` (`playwright-core/lib/coreBundle.js` ~44247-44285) and waits for the `Debugger listening on ws://` and `DevTools listening on ws://` lines.
- **Verified in Spike 1** against Electron 44.4.5 with an ESM `"type":"module"` main, a privileged `app://` scheme, and a sandboxed window: both modes worked, and `app.evaluate(({app}) => app.isPackaged)` returned false.
- Requirement met: the dev app does not exit on `--remote-debugging-port` (the gate is `app.isPackaged`, main.ts:22).
- Playwright's docs list only a minimum Electron version (v12.2.0+); Electron 44 is not officially listed (unverified beyond the spike).

### A.9 Code smells in A (hedged)
- main.ts:46-51: dev and the installed app share userData, credentials, and (likely) the single-instance lock. `npm run app` while Tattle.app runs probably exits silently.
- main.ts:40-44: dev sessions, web, config, and models are cwd-relative; launching from another cwd breaks the page and uses a different `sessions/`.
- main.ts:363: `check()` skips when `update.kind === "ready"`. After a downloaded-but-not-installed update, 4-hourly checks stop finding newer versions until relaunch. Arguably intended.
- main.ts:298-307: `offerRestart` can be pending (waiting on air) while `update-downloaded` for a newer version calls it again, giving two waiting loops and possibly two sheets. Unlikely in practice.
- main.ts:211: the helper probe's errors are ignored (for example, a helper missing from a bad build); nothing surfaces.
- preload.ts:8: `pending` is unbounded (negligible).
- inProcess.ts:27: joining array headers with `", "` would corrupt `set-cookie`. None is used today.

---

## B. Native capture helper (`native/capture/**`)

### B.1 Package layout
- `native/capture/Package.swift` (24 lines): `swift-tools-version:6.0`; `platforms: [.macOS(.v14)]`; one `.executableTarget("tattle-capture", path: "Sources/tattle-capture", swiftSettings: [.swiftLanguageMode(.v5)], linkerSettings: [unsafeFlags -sectcreate __TEXT __info_plist <Info.plist>, CoreAudio, AudioToolbox, AVFoundation])`.
- Toolchain: `swift --version` is **Apple Swift 6.3.3** (swiftlang-6.3.3.1.3), target `arm64-apple-macosx26.0`. Full Xcode is at `/Applications/Xcode.app` (`xcode-select -p`). **Swift Testing (`import Testing`) and XCTest both work** (Spike 2: "Testing Library Version: 1902").

### B.2 Minimal restructure: validated (Spike 2); **no library split needed**
Add to `targets:` in `native/capture/Package.swift`:
```swift
.testTarget(
    name: "tattle-capture-tests",
    dependencies: ["tattle-capture"],
    path: "Tests/tattle-capture-tests",
    swiftSettings: [.swiftLanguageMode(.v5)]
),
```
- Create `native/capture/Tests/tattle-capture-tests/*.swift` with `import Testing` and `@testable import tattle_capture` (module name uses an underscore).
- SwiftPM compiles the executable for testing with its entry point renamed, so `main.swift`'s top-level code (argument parsing, `dispatchMain()`) never runs in tests, while the types declared in any file (including `StdoutSink` and `NullSink` in main.swift) are visible.
- `npm run build:capture` (`swift build -c release`) does not build test targets, so the release artefact is unchanged.
- Run with `swift test --package-path native/capture`. Coverage: `swift test --package-path native/capture --enable-code-coverage`, then:
  ```
  xcrun llvm-cov report native/capture/.build/debug/tattle-capturePackageTests.xctest/Contents/MacOS/tattle-capturePackageTests -instr-profile native/capture/.build/debug/codecov/default.profdata native/capture/Sources/
  ```
  JSON is at `swift test --show-codecov-path` (`.build/debug/codecov/tattle-capture.json`). The profdata is written only when all tests pass.
- Measured coverage from the 10 spike tests: ClockLock.swift 80.7% lines, Devices.swift 13%, Mic.swift 4%, main.swift 0.5%, SystemTap.swift 0%.

### B.3 Pure or unit-testable logic (with test cases)

**`ClockLock.swift`**
- `protocol FrameSink` (6-8): inject a collecting sink.
- `MonoConverter.init?(sourceRate:)` (16-21), `convert(_:)` (24-48): takes channel 0 (the stride handles interleaved), resamples to 16 kHz. Returns `[]` for 0 frames.
- `AdaptiveConverter.convert` (57-65): rebuilds on a rate change; `r <= 0` gives `[]`.
- `Levels.add` (74-81) and `.json` (83-86): dBFS rounded to 0.1; silence gives -120.
- `ClockLock` (92-195):
  - Constants: `samplesPerMs` 16, `toleranceSamples` 320, `frameSamples` 1600.
  - `ms(hostTime:)` (121-124); `push` (129-131) is async on `queue`; `place` (133-146) pads, trims, and clamps; `append` (148-162) emits 1600-sample frames with `sessionMs`; `startWatchdog` (166-182) pads after 300 ms of lag up to now-100 ms; `flush` (185-194) is sync on the queue, emits the remainder, and cancels the timer.
  - Host-time helper for tests: `c.startHost &+ UInt64(ms * 1e6 * Double(tb.denom) / Double(tb.numer))`.

Tests validated in the spike (all passed):
- `@Test func levelsJsonSilence()`: `peakDbfs == -120`, `samples == 0`.
- `@Test func levelsJsonFullScale()`: `add([1,-1])` gives peak 0, rms 0.
- `@Test func clockLockFlushEmitsPending()`: 100 samples at t=0 give one frame of 100 at sessionMs 0.
- `@Test func padsLateStreamWithSilence()`: a buffer at 500 ms gives 8000 zeros then the samples, frames at `[0,100,200,300,400,500]`.
- `@Test func withinToleranceNoPadding()`: 19 ms late, 10 samples in, 10 out.
- `@Test func clampsAndScales()`: `[2,-2,1,-1]` gives `[32767,-32768,32767,-32768]`.
- `@Test func unknownStreamIgnored()`.
- `@Test func converterResamples48kTo16k()`: **the first call returns 1360, not 1600**. AVAudioConverter holds about 240 samples (about 15 ms) of latency, and 10 buffers of 4800 at 48 kHz give 15 738, not 16 000. Assert a cumulative tolerance of 300 or more, not per call.

Tests to add:
- `@Test func trimsStreamThatRunsAhead()`: push 1600 at 500 ms (padded), then 1600 at 0 ms; the second is dropped (`diff < -320`).
- `@Test func dropsAllWhenAheadExceedsBuffer()`: `min(-diff, count)`.
- `@Test func framesCarryContinuousSessionMs()`: 3200 + 800 samples give frames at 0 and 100, plus the flush remainder at 200.
- `@Test func twoStreamsAreIndependent()`.
- `@Test func watchdogPadsStalledStream()`: `startWatchdog()`, sleep about 450 ms, then `flush()`; there is silence up to about now-100 ms. Timing-based; allow slack.
- `@Test func flushTwiceEmitsNothingNew()`.
- `@Test func msOfStartHostIsZero()`.
- `@Test func adaptiveConverterRebuildsOnRateChange()`: 48k then 24k buffers; outputs are about proportional.
- `@Test func adaptiveConverterZeroRateReturnsEmpty()`.
- `@Test func monoConverterTakesChannelZeroOfInterleaved()`: an interleaved stereo buffer with ch0=0.5 and ch1=-0.5 gives a positive output.
- `@Test func emptyBufferReturnsEmpty()`.

**`Devices.swift`**
- `transportName(_:)` (65-78) is **pure**: test every case (`kAudioDeviceTransportTypeBuiltIn` gives "builtin", USB "usb", Bluetooth and BluetoothLE "bluetooth", Virtual, Aggregate, AirPlay, HDMI and DisplayPort "display", Thunderbolt, both ContinuityCapture "continuity", `0` "unknown").
- `address(_:_:)` (14-16) is pure.
- `fourCC` (89) is `private`, so it cannot be tested without changing it to `internal` (then `fourCC("hdpn") == 0x6864706e`).
- `outputKind` (94-108) mixes pure branching with Core Audio reads. It is testable only by extracting `static func kind(transport: UInt32, dataSource: UInt32?, name: String) -> String`.
  - Suggested refactor tests: `it("Bluetooth is headphones")`, `it("virtual is virtual")`, `it("built-in hdpn is headphones, ispk is speakers")`, `it("built-in named 'External Headphones' without data source is headphones")`, `it("USB/HDMI/unknown is speakers")`.
- `resolveMic` (126-130): logic over `inputs()`. Extracting `static func resolve(_ spec: String, in: [Input]) -> Input?` makes "builtin picks first builtin" and "uid matches exactly; unknown gives nil" pure.
- `allDevices`, `systemDevice`, `string`, `uid`, `name`, `nominalRate`, `transportType`, `outputDataSource`, `hasInput`, and `inputs` call Core Audio. They are callable in tests on a real Mac (they read the actual devices; nondeterministic), so use smoke assertions only, such as `inputs()` not crashing and every uid being non-empty.

**`main.swift`** (190 lines)
- The argument loop (32-52) and validation (64-65) are top-level code and **not testable in-process**. To unit-test them, extract:
  - `struct Options { listDevices, micSpec, useMic, useSystem, probeSeconds, tapMode }`
  - `static func parse(_ args: [String], env: [String:String]) -> Result<Options, (String, Int32)>`
  
  Test cases then: `it("defaults: builtin mic, both streams, tap apps")`, `it("--mic needs a value → 64")`, `it("--probe 0 / abc → 64")`, `it("--tap x → 64")`, `it("--no-mic --no-system → 64")`, `it("CONVERSATION_CAPTURE_TAP=global sets tap global; --tap overrides env")`, `it("unknown argument → 64")`.
  
  **Alternatively, black-box test the built binary from vitest** (no refactor): `execFileSync("native/capture/.build/release/tattle-capture", ["--bogus"])` exits 64 with stderr JSON `{"message":"unknown argument --bogus","type":"error"}`. `--mic`, `--tap foo`, `--probe 0`, and `--no-mic --no-system` all exit 64. `-h` exits 0 with usage on stdout. `--list-devices` exits 0 with JSON lines on stdout. These never start capture (all exit before line 105), so they need **no permissions**. `--list-devices` only reads Core Audio.
- `StdoutSink.frame` (71-96) writes straight to fd 1 via `Darwin.write`. To unit-test the framing, extract `static func encode(stream:sessionMs:samples:) -> Data` and test:
  - `"PCAP"` magic, stream byte, 3 zero bytes, float64 LE sessionMs, uint32 LE n, int16 LE samples; total length `20 + 2n`.
  - The TS side has a decoder in `src/audio/nativeSource.ts`, so a cross-language golden test (Swift writes a fixture and TS decodes it) is possible.
- `status(_:)` (12-15): sorted-keys JSON to stderr; black-box only.
- `NullSink` is trivially covered.

**`Mic.swift`**
- `restartIfStalled` (64-85) rate-limit logic (at most 5 per 60 s, then every 10 s, `gaveUpAt` reset) is **pure-ish but entangled** with `configure()` and `mach_absolute_time`.
- Testable only after extracting a `RestartPolicy` struct with `mutating func decide(now: Date, secondsSinceLast: Double, after: Double) -> Action (.none/.restart/.restartAndReportGaveUp/.wait)`. Test cases:
  - `it("no restart while buffers flow")`
  - `it("restarts after 1.5 s stall")`
  - `it("6th restart within 60 s reports once and waits 10 s")`
  - `it("flowing buffers reset gaveUpAt only on the watchdog (after >= 1.5)")`
- `CaptureError.description` (121-128) is pure (covered in the spike).
- Everything else (`AVAudioEngine`, device selection) is hardware-only.

**`SystemTap.swift`** (311 lines) is **hardware and permission only**: Core Audio process taps, aggregate devices, IO procs, and property listeners.
- The one pure-ish piece is `updateTapProcesses`' "set unchanged means skip" comparison (136-137).
- The rest is exercised by `scripts/capture-test.sh` (interactive, needs System Audio Recording permission) and by `npm run preflight`.
- Coverage target 0%; exclude it from Swift coverage gates.

### B.4 Recommendation for gates
- Swift coverage gate per file: ClockLock.swift at 95% or more is achievable; the watchdog is timing-based.
- Exclude SystemTap.swift, Mic.swift, and main.swift (unless refactored) from any threshold. Swift has no built-in threshold; enforce with a small script parsing `llvm-cov export -summary-only` JSON.
- Keep `swift test` in the full-suite step. It takes about 9 s for a cold debug build of this package in the scratchpad, and about 1 s warm.

### B.5 Smells (hedged)
- `main.swift:1-2` comment says "a global Core Audio tap of all system output", but the default tap is now `apps` (line 31). The comment is stale.
- `main.swift:152-153`: `_ = secs` is a no-op.
- `main.swift:147`: on a second shutdown, `Thread.sleep(10)` then exit (intended, to let the first finish).
- `ClockLock.place` (133-146): the converter's about 15 ms of latency makes samples land about 15 ms late relative to their host time, under the 20 ms tolerance, so it is invisible. Note it only if the tolerance is ever tightened.

---

## C. `scripts/**`

| Script | Lines | Testable? | How |
|---|---|---|---|
| `scripts/third-party-notices.mjs` | 126 | **Yes (integration)**. `--check` (116-122) compares the generated doc with `THIRD_PARTY_NOTICES.md` and exits 1 if they differ. Currently up to date (ran `--check`: exit 0, 0.6 s) | `it("THIRD_PARTY_NOTICES.md is up to date", () => execFileSync(process.execPath, ["scripts/third-party-notices.mjs","--check"]))`. It is already a release gate in `checks.sh` and `build-app.sh`. A duplicate in vitest is optional (it shells `npm ls`, about 0.6 s). For unit coverage of its branches (MIT with no license file gives the MIT fallback, 37-39; Apache fallback, 40; unknown license throws, 41; author string vs object, 38; homepage vs repository string vs object vs npmjs fallback, 34), **refactor into exported pure functions** (`npmEntry(e)`, `render(other, npmEntries)`), with the CLI wrapper in the same file guarded by `import.meta.main`. Otherwise exclude it from coverage. Side effect: lines 18-20 may run `node_modules/electron/install.js` (network) if `LICENSES.chromium.html` is missing |
| `scripts/build-mac.sh` | 38 | No (signing, notarization, electron-builder, about 3.5 min) | Covered by the release's `build-app.sh`. Shell has no coverage tooling |
| `scripts/make-icon.mjs` | 29 | No (needs an Electron offscreen window, `sips`, `iconutil`; writes `desktop/icon.icns`) | Exclude from coverage |
| `scripts/download-models.sh` | 15 | Only with network; the skip-if-present branch is testable with a tmp `models/` | Low value. A test could run it in a tmp cwd with both files present and expect "already present" and no curl |
| `scripts/make-fixtures.ts` | 95 | No (macOS `say` voices, `afconvert`, sherpa; writes the gitignored `fixtures/`). `trim()` (43-50) is pure but not exported; placement math (66-87) is inline | Exclude from coverage, or export `trim` and `place(clips)` to unit-test: leading and trailing near-silence under 0.003 is trimmed, and each line starts 1.3 s after the previous clip ends |
| `scripts/capture-test.sh` | 39 | No (interactive `read`, needs a mic and earbuds) | Manual. The non-interactive part (steps 1-2) needs permissions |

Notes:
- `tsconfig.json` includes `scripts`, so `make-fixtures.ts` is typechecked.
- The `.mjs` files are not typechecked.
- The vitest `coverage.include` should list only files the spec intends to gate. I suggest `src/**`, `desktop/**`, `website/assets/{download,nav,sections,main}.js`, and optionally `scripts/third-party-notices.mjs` after the refactor.

---

## D. Website (`website/`)

### D.1 Files
- **`website/index.html`** (375 lines):
  - JSON-LD `<script type="application/ld+json">` (20-36): `softwareVersion "0.8.0"`, `downloadUrl …/v0.8.0/Tattle-0.8.0-arm64.dmg`.
  - `<script type="importmap">` (37-46): three@0.170.0 from jsDelivr plus `integrity` sha384 for 3 URLs.
  - Scripts: `download.js` defer (47), `main.js` module (48), `sections.js` defer (49), `nav.js` defer (50).
  - Ids: `bar`, `onair`, `onair-label`, `clock`, `tabs` (tabs link to `#rundown #jev #systems #preshow #credits`, 67-71), `bar-track`, `bar-fill`, `top` (`header.hero`), `stage`, `gl`, `csskey`, `ck-floor`, `caps`, `rec`, `hint`, `hint-main`, `lower`, `cue`, `cue-a`, `cue-b`, `rundown`, `jev`, `jevcall`, `jc-n`, `jc-ms`, `jc-next`, `jc-json`, `jc-rows`, `jc-out`, `systems`, `flow`, `flow-feed`, `flow-checks`, `ft-lines`, `ft-flags`, `ft-s1`, `ft-s2`, `preshow`, `credits`, `signoff-title`, `fine-title`.
  - `[data-download]` links at 73 (bar, `data-when="mac"`, `tabindex=-1`), 100 (hero), and 335 (sign-off). `data-version`: `<span>` at 104 and `<b>` at 356. `data-size` at 104. `<time data-released datetime="2026-09-28">28 Sept 2026</time>` at 356. `data-notes` at 356. `data-release` `p.fine-rel` at 356. `data-copy-link` buttons at 110 and 345.
- **`website/_headers`** (11 lines): CSP (5) with `script-src 'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com 'sha256-mya8lPJXErB8mSeQkeworyK5W4Syd+9fFdtxxcasD4o='`, `connect-src 'self' https://api.github.com https://cloudflareinsights.com`, and so on. Also HSTS, nosniff, `X-Frame-Options DENY`, Referrer-Policy, Permissions-Policy, COOP.
- **`website/wrangler.jsonc`**: worker `tattle-website`, assets dir `.`, `auto-trailing-slash`, custom domain `hey-tattle.com`, `workers_dev false`, `preview_urls false`.
- **`website/.assetsignore`**: `wrangler.jsonc`, `.assetsignore`, `experiments/`, `*.md`, `.DS_Store`, `.wrangler/`.
- Deployed by Cloudflare Workers Builds on push to `master` touching `website/*` (`docs/website.md:59-72`). There is no repo CI.

### D.2 `website/assets/download.js` (82 lines): an IIFE, no exports, sets `window.CA`
- Top: `repo` (18), `releasesUrl` (19), and `isMac = /Macintosh/.test(ua) && !(navigator.maxTouchPoints > 1)` (22). `reducedMotion` via `matchMedia` (23). `document.documentElement.dataset.platform = "mac"|"other"` (24).
- `CA = { repo, releasesUrl, isMac, reducedMotion, release: null, ready(cb) }` (27-31). `ready` calls `cb` immediately if `release` is set; otherwise it queues.
- `apply(release)` (33-40):
  - `A[data-download].href = url` (A tags only).
  - `[data-version]` and `[data-size]` get their textContent.
  - `[data-released]` gets `released || ""`, plus `datetime` if `date`.
  - `[data-notes].href` if `notes`.
  - `[data-release]` gets `hidden = false`.
- `onReady()` (42-57):
  - Fills an empty `href` on `A[data-download]` with `releasesUrl`.
  - A delegated click handler: a click inside `[data-download]` dispatches `ca:download` `{url: a.href || releasesUrl, el}`. A click inside `[data-copy-link]` calls `navigator.clipboard.writeText(location.href)`: success sets "Copied" and restores the label after 1800 ms; failure sets textContent to `location.href`.
  - Then calls `load()`.
- `load()` (59-78):
  - Reads the sessionStorage `"ca.release.v2"`, wrapped in try.
  - Otherwise fetches `https://api.github.com/repos/nicolasdao/tattle/releases/latest` with `Accept: application/vnd.github+json`. `!res.ok` returns. It finds an asset matching `/-arm64\.dmg$/`; none returns.
  - `date = published_at.slice(0,10)`; `released = toLocaleDateString("en-GB", {day:"numeric", month:"short", year:"numeric", timeZone:"UTC"})`.
  - `release = {version: tag_name, url: browser_download_url, size: round(size/1e6)+" MB", date, released, notes: html_url}`.
  - Caches in sessionStorage (try); any throw returns.
  - Then `CA.release = release`, `apply`, and flushes the `waiting` callbacks.
- Readiness (80-81): `readyState === "loading"` waits for `DOMContentLoaded`; otherwise `onReady()` runs now.

Unit tests (happy-dom, file header `// @vitest-environment happy-dom`):
- **Load the script** with `vi.resetModules(); await import("../../website/assets/download.js")`. The IIFE runs on import. Strict mode as a module is fine: there is no sloppy-only code. Importing (not `eval`) lets v8 coverage attribute lines.
- **Set up before import:**
  - `document.body.innerHTML` = a fixture: either the real `index.html` body via `readFileSync` and a regex on `<body>…</body>`, or minimal markup.
  - `window.happyDOM.settings.navigator.userAgent = "…Macintosh…"`. happy-dom's default UA is `Mozilla/5.0 (X11; Darwin arm64) … HappyDOM/x`, which is *not* a Mac, and the default `maxTouchPoints` is 0 (`happy-dom/lib/browser/DefaultBrowserSettings.js`).
  - Override `globalThis.fetch = vi.fn(...)`. `tests/setup.ts` replaces fetch with a thrower, so each test must set its own.
  - `sessionStorage.clear()`.
- **happy-dom 20.14.5 facts** (from the package): `IntersectionObserver` and `ResizeObserver` exist but are **no-op** (callbacks never fire), so tests must `vi.stubGlobal` them to capture callbacks. `HTMLCanvasElement.getContext` returns `null` without a canvas adapter, and `window.WebGLRenderingContext` is undefined. `navigator.clipboard` exists. `matchMedia` exists (for reduced motion, `vi.stubGlobal("matchMedia", q => ({ matches: true, … }))`).

Cases:
- `it("marks the page as mac on a Macintosh user agent")`
- `it("treats an iPad (Macintosh + maxTouchPoints 5) as other")`
- `it("treats Windows/iPhone as other")`
- `it("fills an empty data-download href with the releases page, keeps a set one")`
- `it("exposes window.CA with repo nicolasdao/tattle and releasesUrl")`
- `it("fetches the latest release with the GitHub Accept header")`
- `it("points every A[data-download] at the arm64 DMG, not the zip")`: assets `[{name:"Tattle-0.9.0-arm64-mac.zip"}, {name:"Tattle-0.9.0-arm64.dmg", browser_download_url, size: 153_400_000}]`
- `it("formats size as rounded MB: 153400000 → '153 MB'")`
- `it("formats released as en-GB short date in UTC: 2026-09-28T23:30:00Z → '28 Sept 2026'")`. ICU-dependent: Node 24's full ICU gives "Sept" for en-GB, matching index.html:356. unverified on other ICU builds.
- `it("sets datetime on data-released only when published_at exists")`
- `it("leaves data-released empty when published_at is missing")`
- `it("sets data-notes href to html_url; leaves it when missing")`
- `it("unhides [data-release]")`
- `it("does not touch non-A elements with data-download")`
- `it("caches the release in sessionStorage ca.release.v2 and does not fetch on the next load")`
- `it("fetches when sessionStorage holds corrupt JSON")`
- `it("still works when sessionStorage throws")` (stub `getItem`/`setItem` to throw)
- `it("keeps the HTML's links when the API returns 403")`
- `it("keeps the HTML's links when there is no -arm64.dmg asset")`
- `it("keeps the HTML's links when fetch rejects (offline)")`
- `it("keeps the HTML's links when res.json() throws")`
- `it("CA.ready before load queues and fires once with the release")`
- `it("CA.ready after load fires immediately")`
- `it("CA.ready never fires when the release is unknown")`
- `it("a click inside a download link dispatches ca:download with its href and element")` (click a child `<span>`)
- `it("ca:download falls back to releasesUrl when href is empty")`. Hard: `onReady` fills empty hrefs first, so this is only reachable if an href is removed after load.
- `it("Copy link writes location.href, shows Copied, restores after 1.8 s")` (fake timers)
- `it("Copy link failure shows the URL in the button")`
- `it("runs at once when the document is already loaded, or on DOMContentLoaded when loading")`. Loading: `Object.defineProperty(document, "readyState", { value: "loading", configurable: true })`, then import, then `document.dispatchEvent(new Event("DOMContentLoaded"))`.

### D.3 `website/assets/nav.js` (79 lines): an IIFE
- Returns early if `#bar` or `#tabs` is missing (8).
- `setCurrent(i)` (14-26): sets `aria-current="location"` on tab i and removes it on the others. If `tabs.scrollWidth > clientWidth`, it calls `tabs.scrollTo`.
- `pick()` (28-34): the last section whose `getBoundingClientRect().top <= innerHeight/3`, or null.
- `placeTicks()` (37-49): clears the `<b>` ticks; returns if `max <= 0`; otherwise one `<b>` per section at `left` %.
- `progress()` (50-53): `fill.style.transform = scaleX(min(1, scrollY/max))`, or 0.
- `onScroll()` (56-60): rAF-throttled; toggles `bar.scrolled` when `scrollY > 8`.
- Listeners: scroll, resize, load; a `ResizeObserver` on body (65).
- Bar download (70-78): an IntersectionObserver on `.hero .dl`; `show-dl` when not intersecting and `top < 0`; `.bar-dl` `tabIndex` becomes 0 or -1.

Unit cases (happy-dom; stub `getBoundingClientRect` per section; `vi.stubGlobal("IntersectionObserver", class { constructor(cb){ io = cb } observe(){} })`; `vi.stubGlobal("requestAnimationFrame", cb => cb(0))`; set `scrollY` via `Object.defineProperty(window, "scrollY", {value, configurable:true})`):
- `it("does nothing without #bar or #tabs")`
- `it("lights the tab of the last section above a third of the viewport")`
- `it("lights no tab above the first section")`
- `it("keeps the last tab lit past the end")`
- `it("scrolls the tab strip to centre the active tab only when it overflows")`
- `it("does not re-apply when the section is unchanged")`
- `it("places one tick per section, clamped 0–100%")`
- `it("places no ticks when the page does not scroll")`
- `it("fills the playhead proportionally and clamps at 1")`
- `it("toggles .scrolled after 8 px")`
- `it("shows the bar Download and makes it focusable once the hero Download scrolls above the top")`
- `it("hides it again when the hero Download is back in view")`
- `it("does not show it when the hero Download is below the viewport")`
- `it("throttles scroll handling to one rAF")`

### D.4 `website/assets/sections.js` (163 lines): an IIFE
- `esc` (6) escapes `& < > "`.
- `whileVisible(el, ms, step)` (9-18): an IntersectionObserver with threshold 0.2 plus `visibilitychange`; `setInterval` only while on screen and the document is visible; returns `{restart}`.
- `Q` (21-29) and `LINES` (32-48): 5 examples.
- Jev call block (50-104), if `#jevcall` exists:
  - `answerHtml` (55-61): "noul" gives a bar and `toFixed(2)`; "choice" gives a label and a probability; "score" gives 5 pips with `on` when `v >= n+0.5`, and `toFixed(1)/4`.
  - `show(n)` (63-99): renders JSON and rows (`.mem` for `known_*`). With reduced motion it lands now; otherwise an rAF ticker until `L.ms`, then `land()`: `.landed`, `msEl` "0.41 s", `out.className "jc-out flag"`.
  - `show(0)`; auto every 7 s; `#jc-next` click calls `show(i+1)` and `restart`.
- Systems flow (107-162), if `#flow` exists:
  - `STREAM` (12 lines; verdicts at indices 1, 4, 8, 10); `S1_COST` 0.00004; `S2_COST` 0.008.
  - `step(instant)` prepends a feed item (cap 5) and, for a flagged line, a check card (cap 3) resolving now or after 5200 ms. `tally()`.
  - Five instant steps at start. Auto every 1700 ms unless reduced motion.

Unit cases:
- `it("renders the first Jev call with 6 questions (no known_c_1) and lands instantly under reduced motion")`: `#jc-n` "6", `#jc-out` has class `flag` and text "Flagged".
- `it("Next shows line 2 with 7 questions including a .mem known_c_1 row")`
- `it("wraps from line 5 back to line 1")`
- `it("escapes HTML in lines")`. Indirect: all LINES are static and contain no `<`, so this is covered only by `esc` being called. Consider exporting `esc`, or accept it.
- `it("answerHtml score 2.6 lights 3 pips")` (from row HTML: `.pips b.on` count 3)
- `it("ticks the timer with rAF then lands at L.ms without reduced motion")` (stub rAF and `performance.now`)
- `it("starts the flow with 5 lines, 2 flags, $0.0002 System 1 and $0.016 System 2")`
- `it("caps the feed at 5 and the checks at 3")`
- `it("a flagged line shows Checking, then its verdict after 5.2 s")` (fake timers)
- `it("auto-advances only while on screen and the tab is visible")` (captured IO callback plus `document.hidden`)
- `it("does nothing when #jevcall and #flow are absent")`

### D.5 `website/assets/main.js` (281 lines): an ES module with top-level side effects
- `params` (5), `reduced` (6-7) adds `html.reduced`.
- `SCRIPT` (13-22): 8 lines.
- `hasWebGL()` (29-33): `?nogl` gives false.
- `cssKey()` (35-73): the fallback API `down/release/tap/setLive/speaker/keyRect/emitPoint/wake`.
- `initKey()` (75-86): dynamic `import("./scene.js")` if WebGL; the catch falls back to `cssKey`; `placeHit()`; `?live` auto-starts after 500 ms.
- `setOnAir` (96-106), `toggle()` (108-130), `tickClock` (132-135) `mm:ss`, `speak` (138-147), `caption` (149-180), `third` (183-204), `showThird` (206-210), `dismissThird` (212-217), `factCheck` (219-228).
- Pointer, click, and Space handlers (231-266); `ca:download` goes on air (269); rundown IO (272-276); `CA.ready` unhides `.ver` (279).

In happy-dom WebGL is absent, so the CSS key path runs.

Cases (load the real `index.html` body; `vi.stubGlobal` ResizeObserver and IntersectionObserver):
- `it("uses the CSS key when WebGL is missing, showing #csskey and html.nogl")`
- `it("clicking the key goes on air: aria-pressed true, html.is-live, On air, 'You're on air.', clock 00:00")`
- `it("clicking again goes off air: 'That's a wrap.', Press to record again")`
- `it("the clock shows 01:05 after 65 s")` (fake timers plus `Date.now`)
- `it("speaks a caption after 450 ms, labelled Host · mic, then Guest · call")`
- `it("keeps at most 6 captions")`
- `it("a claim shows Checking at 700 ms then its verdict at 1900 ms in the lower third")`
- `it("going off air dismisses the lower third after 420 ms")`
- `it("Space toggles when the stage is on screen, not when typing in a button/input")`
- `it("Space with a modifier or repeat is ignored")`
- `it("Space when the stage is off screen is ignored")`
- `it("ca:download goes on air when off air, not when already live")`
- `it("?live starts on air after 500 ms")`
- `it("?nogl forces the CSS key")`
- `it("reduced motion: captions are replaced not stacked, speak every 3.8 s")`
- `it("pointerleave after pointerdown releases the key")`
- `it("unhides .ver when CA.ready fires")`
- `it("falls back to the CSS key when scene.js import throws")` (stub `WebGLRenderingContext` and `canvas.getContext` truthy, and `vi.mock("../../website/assets/scene.js", () => { throw … })`; unverified that vitest's mock intercepts a relative dynamic import from a non-TS file; likely yes)

`website/assets/scene.js` (439 lines; Three.js from the CDN via the import map; `createScene` at line 37) is **not unit-testable** in happy-dom (no WebGL, and bare `three` imports resolved only by the browser's import map). Exclude it from unit coverage and cover it in Playwright.

### D.6 Static contract tests (node env; no DOM)
- `it("the import map's SHA-256 is allowed by script-src in website/_headers")`:
  ```ts
  const html = readFileSync("website/index.html","utf8");
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)!;
  const h = "sha256-" + createHash("sha256").update(m[1]).digest("base64");
  expect(readFileSync("website/_headers","utf8")).toContain(`'${h}'`);
  ```
  Recomputed now: `sha256-mya8lPJXErB8mSeQkeworyK5W4Syd+9fFdtxxcasD4o=`, which matches.
- `it("every inline <script> is either the import map or JSON-LD")`: otherwise the CSP blocks it. Parse `<script(?![^>]*\bsrc=)[^>]*>` and check `type`.
- `it("the import map is valid JSON and every three URL it maps has an integrity entry")`: parse the JSON; the `imports.three` URL must be in `integrity`. For each `import … from "three/addons/…"` in `scene.js` (lines 7-8), resolve against `imports["three/addons/"]` and expect an integrity key.
- `it("integrity pins match three@0.170.0's files")`: add a devDependency on `three@0.170.0` (exact). Then `"sha384-" + createHash("sha384").update(readFileSync("node_modules/three/build/three.module.js")).digest("base64")` equals the map's value, and likewise for `examples/jsm/environments/RoomEnvironment.js` and `examples/jsm/utils/BufferGeometryUtils.js`.
  - **Verified:** the npm tarball bytes produce exactly the three pinned hashes.
  - three.module.js 0.170.0 has no further imports; `three.core.js` appears only from r171. Assert the version in the URLs equals `node_modules/three/package.json` version.
- `it("CSP allows api.github.com and cloudflareinsights for connect-src, jsdelivr and static.cloudflareinsights for script-src")`
- `it("headers include HSTS, nosniff, DENY framing, COOP")`
- `it("the page names one release consistently")`:
  - JSON-LD `softwareVersion` = X.
  - `downloadUrl` = `…/download/vX/Tattle-X-arm64.dmg`.
  - All 3 `data-download` hrefs equal `downloadUrl`.
  - `<span data-version>` and `<b data-version>` equal `vX`.
  - `data-notes` href ends with `/tag/vX`.
  - Do **not** assert X == `package.json` version. The site names the latest *published* release and is updated only in the release's last step. Assert `semver(X) <= package.json` instead.
- `it("update-website.sh's patterns each match exactly the expected count in index.html")`: the counts are 3, 1, 1, 1, 1, 1, 1, 1, 1, 1. This catches page edits that would break the release's Step 11 before release time.
- `it(".assetsignore keeps experiments/, wrangler.jsonc, *.md and .wrangler/ off the site")`
- `it("wrangler.jsonc serves ., with workers_dev and preview_urls off")` (strip `//` comments, then `JSON.parse`)
- `it("every element id main.js/nav.js/sections.js look up exists in index.html")`: grep `$("…")`, `getElementById("…")`, and `querySelector("#…")` in the assets.

### D.7 `update-website.sh`: worth testing (black-box, with a fake `gh`)
File: `.agents/skills/release-tattle/scripts/update-website.sh`. `.claude/skills/release-tattle` is a **symlink** to `../../.agents/skills/release-tattle` (a git mode 120000 entry), so edit the `.agents` path.
- Logic (15-45): 10 regex edits with required match counts (26-37). On a count mismatch it prints `…expected N match(es)…the page changed, update this script` and exits 1. `dmg.url` comes from `gh release view --json assets` (the browser download URL). Date formatting is identical to download.js.
- Harness:
  - Tmp dir with `website/index.html` copied from the real page.
  - A fake `gh` in `tmp/bin/gh`: `#!/bin/sh` then `[ "$FAKE_GH_FAIL" = 1 ] && exit 1; printf '%s' "$FAKE_GH_JSON"`, `chmod +x`.
  - `execFileSync("sh", [abs(update-website.sh), "0.9.0"], { cwd: tmp, env: { ...process.env, PATH: `${tmp}/bin:${process.env.PATH}`, FAKE_GH_JSON: JSON.stringify({ tagName:"v0.9.0", publishedAt:"2026-10-02T08:00:00Z", url:"https://github.com/nicolasdao/tattle/releases/tag/v0.9.0", assets:[{ name:"Tattle-0.9.0-arm64.dmg", url:"https://github.com/…/Tattle-0.9.0-arm64.dmg", size:154_000_000 }] }) } })`.
- Cases:
  - `it("rewrites 3 download links, both version labels, size, date, notes, and JSON-LD")`
  - `it("unhides span.ver and p.fine-rel when hidden")`
  - `it("is idempotent: a second run leaves the file byte-identical")`
  - `it("refuses an unpublished version (gh fails) with exit 1 and 'is not published'")`
  - `it("refuses a release without Tattle-<v>-arm64.dmg")`
  - `it("refuses when the page lost a data-download link (count 2 ≠ 3) and leaves the file unchanged")`
  - `it("fails without a version argument (usage)")`
  - `it("fails when run outside the project root (no website/index.html)")`
- The result must satisfy the D.6 consistency test, so it can be chained.

### D.8 Playwright scenarios for the page
- **Serve:** `npx wrangler dev` (in `website/`) applies `_headers`, but it needs `wrangler` (4.143.0, a large devDependency; peer `@cloudflare/workers-types`) and is slower. **Recommended instead:** a tiny Node static server in `e2e/website/server.ts` that serves `website/` and applies the `/*` block of `_headers` to every response. That enforces the real CSP in Chromium offline. Use Playwright `webServer: { command: "node --import tsx e2e/website/server.ts", port: 8788 }`. (`python3 -m http.server` does not apply headers; `docs/website.md:85`.)
- **Network isolation:**
  - `page.route("https://api.github.com/**", …)` returns a fixture or a 403.
  - `page.route("https://cdn.jsdelivr.net/npm/three@0.170.0/**", r => r.fulfill({ path: "node_modules/three/" + suffix, contentType: "text/javascript" }))` serves the exact npm bytes, so integrity passes offline.
  - `page.route("https://static.cloudflareinsights.com/**", r => r.abort())` (the beacon is injected only by Cloudflare anyway).
  - `page.route("https://github.com/**", r => r.fulfill({ status: 204 }))` stops downloads.
- **CSP watch:** collect `page.on("console")` messages matching `/Content Security Policy|Refused to/`, and `page.evaluate` a `securitypolicyviolation` listener installed by `addInitScript`. Expect none.

Scenarios:
- `it("Mac visitor sees Download for Mac pointing at the DMG named by the mocked API")`: `userAgent` Mac; route the API with `tag_name v9.9.9`, then expect all `[data-download]` hrefs to be the mocked URL and the text `v9.9.9` and `154 MB`.
- `it("keeps the HTML's release when the API answers 403")`
- `it("reads the release once per tab (sessionStorage)")`: count route hits across a reload, which is 1.
- `it("Windows visitor sees It's a Mac app and Copy link; Copy link says Copied")` (`context.grantPermissions(["clipboard-read","clipboard-write"])`)
- `it("iPad (Macintosh UA + touch) is not treated as a Mac")`. Set `hasTouch: true`; unverified that Chromium then reports `maxTouchPoints > 1`, else use `addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 }))`.
- `it("the 3D key loads with the pinned three.js and no CSP violation")`: `#gl` canvas has non-zero size; `html` lacks `.nogl`. Needs WebGL: Playwright's Chromium falls back to SwiftShader headless (unverified on this Mac; likely fine).
- `it("a tampered three.module.js is refused and the page falls back to the CSS key")`: fulfil modified bytes; expect `#csskey` visible, `html.nogl`, and a console warning "WebGL key unavailable".
- `it("?nogl shows the CSS key")`
- `it("pressing the key goes on air and back")`: click `#rec`; `aria-pressed` true; `#onair-label` "On air"; a caption appears within 1 s; click again gives "Off air".
- `it("Space toggles the key while the stage is on screen")`
- `it("clicking Download goes on air (ca:download)")`
- `it("scrolling to Jev lights the 02 Jev tab and shows the bar's Download")`
- `it("Next shows the next Jev call")`
- `it("reduced motion adds html.reduced and lands Jev answers at once")` (`page.emulateMedia({ reducedMotion: "reduce" })`)
- `it("no horizontal scroll at 375 px wide")`: `document.documentElement.scrollWidth <= innerWidth`.
- `it("response headers include the CSP and security headers")`: only meaningful with the header-applying server.

### D.9 Smells in D (hedged)
- `update-website.sh:27` requires the literal adjacency `data-download href="`, but download.js does not care about attribute order. A reformat such as `href` before `data-download` fails the release at Step 11. The count check does catch it, and the D.6 test would catch it earlier.
- `docs/website.md:135` says the scripts are in `.agents/skills/release-tattle/scripts/`, while the README and SKILL use `.claude/skills/...`. Both are correct because of the symlink; noting it for the spec's paths.
- `main.js:279` unhides `.ver`, which is not hidden in the current HTML (it is harmless and supports older states).
- download.js's `ca.release.v2` sessionStorage cache could show a stale release to a visitor who keeps a tab open across a release (by design).

---

## E. Release skill (`.claude/skills/release-tattle` → `.agents/skills/release-tattle`)

### E.1 Exact current step list (`SKILL.md`, 141 lines)
| Step | Lines | Content | Gates and scripts |
|---|---|---|---|
| Project facts table | 13-24 | The Gates row (20): "`npm run typecheck`, `npm test`, `npm run build:web`, `npm run build:desktop`, and the third-party notices check (`checks.sh`) — no API spend; offline…" | - |
| Step 1 — Mode | 33-37 | `unreleased` means Mode C; session work means Mode A; otherwise Mode B | - |
| Step 2 — Docs, then commit everything (A/B) | 39-47 | `update-doc`, then `git-commit` (everything) | - |
| Step 3 — Pre-flight (hard gate) | 49-53 | 3.1 `preflight.sh release`; **3.2 `checks.sh`** (the only place tests run today); 3.3 `credentials.sh` (on failure, ask Stop or "Release without deploying (Steps 4–7 only … deploying later needs Steps 8–10)") | `scripts/preflight.sh`, `scripts/checks.sh`, `scripts/credentials.sh` |
| Step 4 — What ships | 55-70 | `release-info.sh`; sources; Mode B question | `release-info.sh` |
| Step 5 — Classify and choose bump | 72-78 | | |
| Step 6 — Confirm the release | 80-82 | "nothing is pushed or published until Step 9 asks" | |
| Step 7 — Write, commit, tag (local) | 84-87 | stamp CHANGELOG; `apply-release.sh <v> "<attribution>"` | `apply-release.sh` |
| Step 8 — Build and verify the app (local) | 89-93 | `build-app.sh <v>` (npm ci, audit signatures, audit high, notices `--check`, `dist:mac`, codesign, stapler, spctl, GPL sources, SBOM, SHA256SUMS, `.built-v<v>`). On failure: `undo-local-release.sh`; "starts again from Step 1" | `build-app.sh`, `undo-local-release.sh` |
| Step 9 — Deploy (confirmation) | 95-100 | `deploy.sh <v> <notes>` | `deploy.sh` |
| Step 10 — Verify production | 102-104 | `verify-release.sh <v>` | `verify-release.sh` |
| Step 11 — Point the website | 106-115 | "Step 9's confirmation", "If Step 10 failed"; `update-website.sh`, `deploy-website.sh`; the finish text mentions "any credentials warning from Step 3" | `update-website.sh`, `deploy-website.sh` |
| Mode C | 117-126 | numbered 1-6 internally | `preflight.sh ledger`, `record-unreleased.sh` |
| Constraints | 128-141 | Line 130: "**Always** run Step 2 first in Modes A and B". 132: "(Step 11)". 134: "(Step 11)". 135: "(Step 6)… (Step 9)". **Line 140: "Never run the app, `npm run smoke`, `preflight`, or anything that calls paid APIs as a release gate."** | |

`checks.sh` (10 lines), `set -e`, in order: `npm run typecheck`, `npm test`, `npm run build:web`, `npm run build:desktop`, `node scripts/third-party-notices.mjs --check`.

### E.2 Inserting "run the whole test suite (unit + coverage thresholds + e2e) as step 1"

**Proposed new Step 1 — Test suite (Modes A and B; a hard gate, no API spend):**
- If `$action` is `unreleased`, skip to Mode C. The ledger never runs the suite.
- Otherwise run `sh "${CLAUDE_SKILL_DIR}/scripts/test-suite.sh"`, a new script in the skill. Alternatively `npm run test:all`, defined in `package.json`, so the README can point at the same entry point.
- The script builds what e2e needs, then runs:
  1. `npm run build:web && npm run build:desktop`
  2. `npx vitest run --coverage` (unit, with thresholds; fails under threshold)
  3. `swift test --package-path native/capture` (plus the llvm-cov threshold script, if adopted)
  4. `npx playwright test` (Electron dev app, and the website with the mocked GitHub API)
- If it fails, show the failing tests or coverage table and **stop** before any docs or commits happen.
- Rationale for putting it first: it is the most likely failure and costs nothing to undo. Step 2 (update-doc plus git-commit) does not change code, so its result stays valid.
- Caveat: the tests run on the uncommitted working tree, which is exactly what Step 2 then commits.

**What else must change:**
1. **Renumber** Steps 1–11 to 2–12 and fix every cross-reference in `SKILL.md`:
   - line 37 "(Step 4)" becomes Step 5
   - line 53 "Steps 4–7" becomes 5–8, and "Steps 8–10" becomes 9–11
   - line 82 "until Step 9" becomes Step 10
   - line 93 "starts again from Step 1": keep Step 1, since it now re-runs the tests (desired)
   - line 17 Project facts "(Step 11)" becomes Step 12
   - line 108 "Step 9's confirmation" and "If Step 10 failed" become 10 and 11
   - line 115 "from Step 3" becomes Step 4
   - line 130 "run Step 2 first" becomes "run Steps 1 and 2 first"
   - lines 132 and 134 "(Step 11)" become (Step 12)
   - line 135 "(Step 6)… (Step 9)" becomes (Step 7)… (Step 10)
   - The Mode C section is unchanged.
2. **Project facts, Gates row (line 20):** add the full suite (unit plus coverage, Swift, e2e), in Step 1, and say it never calls paid APIs.
3. **Constraint at line 140 conflicts:** "Never run the app … as a release gate". The Electron e2e *runs the app* (dev build, isolated `HOME`, no keys, network routed or blocked). Reword it, for example: "Never run the live app against real services (`npm run smoke`, `preflight`, a real session) or anything that calls paid APIs; the e2e suite runs the development app offline, with no keys and an isolated HOME."
4. **`checks.sh` (Step 3.2, renumbered 4.2):** it runs `npm test` again, which is redundant after Step 1. Options:
   - (a) Keep it as a cheap re-check (`npm test` without coverage takes seconds).
   - (b) Drop `npm test` from `checks.sh` and state that Step 1 ran it.
   - Recommend (a) for the manual path, since the README's "Without Claude Code" list uses `checks.sh`, and so the gates still hold if someone skips Step 1.
   - Also update the `checks.sh` header and its final "ok:" line if it changes.
5. **`build-app.sh`** optionally gains packaged smoke assertions after line 30:
   - `node_modules/.bin/electron-fuses read --app "$app"` with a grep for the six expected states
   - `"$app/Contents/MacOS/Tattle" --remote-debugging-port=9222; [ $? -eq 1 ]`, with a timeout via `perl -e 'alarm 20; exec @ARGV'` since macOS lacks `timeout`

   Note: `build-app.sh:17` runs `npm ci`, which **installs devDependencies too** (no `--omit=dev`), so Playwright and coverage tools will be present. Playwright's browser binaries (`npx playwright install chromium`) live outside `node_modules` (`~/Library/Caches/ms-playwright`), so Step 1 on a fresh Mac needs a one-time install. The test script should detect this and say so.
6. **`skill.json`:** bump `"version": "0.5.0"` to `0.6.0`, and mention tests in `description`.
7. **README `## Releasing` (README.md:182-225)** mirrors the skill:
   - The numbered summary (196-206) currently has 9 items. Insert a new 1. "Runs the whole test suite: unit tests with coverage thresholds, the capture helper's Swift tests, and the end-to-end tests of the Mac app (development build, offline) and the website; stops if any fails." Renumber 1–9 to 2–10.
   - Item 2 (line 199) still lists `npm test` among the gates.
   - "Without Claude Code" block (210-223): add a first line `npm run test:all  # unit + coverage, Swift, end-to-end` (or `sh $S/test-suite.sh`) before `preflight.sh`.
   - README `## Scripts` table (line 80) should gain rows for the new npm scripts (`test:coverage`, `test:e2e`, `test:swift`, `test:all`).
   - `docs/architecture.md:225` describes `npm test`; it should mention coverage and e2e.
   - `docs/website.md:130` says "(`release-tattle`, Step 11)", which becomes Step 12.
   - `docs/desktop.md:230-236` "Publishing" list (1–5) does not cite skill step numbers, but could add the test step.
8. There is no CI. Tests run only locally, in the release and in development.

### E.3 Other scripts: testable logic (optional shell contract tests, black-box via tmp git repos; shell has no coverage)
- `preflight.sh`:
  - `it("release mode fails on any dirty file and prints the list")`
  - `it("ledger mode fails only on unstaged CHANGELOG.md edits")`
- `apply-release.sh`:
  - `it("bumps via npm version, commits only package.json/lock/CHANGELOG with the attribution, tags v<v>")`
  - `it("refuses an existing tag")`
  - `it("skips npm version when unchanged")`

  Run it in a tmp repo with a minimal `package.json`; `npm version --no-git-tag-version` is offline.
- `undo-local-release.sh`: `it("refuses when HEAD is not the release commit")`; `it("removes tag and commit when origin lacks the tag")`. Use a local bare repo as `origin`.
- `release-info.sh`: `it("prints unreleased bullets from CHANGELOG")`.
- `deploy-website.sh`: guards only (lines 10-13: not master, other dirty files, page not linking the version). The push and curl loop are not testable.
- `deploy.sh`, `build-app.sh`, `credentials.sh`, `verify-release.sh`: guards only; the rest needs keychain, Apple, GitHub.
- Value is moderate. `update-website.sh` (D.7) is the one with real logic.

---

## F. Tooling feasibility

### F.1 Registry (`npm view`, 2026-09-29)
| Package | Latest | Peer / engines | Recommendation |
|---|---|---|---|
| `vitest` | 5.0.2 (installed 5.0.1, `^5.0.1` in package.json) | engines node `^22.12 \|\| ^24 \|\| >=26`; peers optional: `@vitest/coverage-v8: 5.0.2`, `happy-dom *`, `jsdom *`, `vite ^6.4\|^7\|^8` (installed vite 8.3.1) | Keep; bump with coverage in lockstep |
| `@vitest/coverage-v8` | 5.0.2; 5.0.1 exists | **peer `vitest` is exact**: 5.0.1 requires 5.0.1, 5.0.2 requires 5.0.2 | Install `@vitest/coverage-v8@5.0.1` (matches the installed vitest), or bump both to 5.0.2 together. Pin both exactly, or keep both `^5.0.x` but update them in lockstep, or npm may warn or ERESOLVE |
| `@vitest/coverage-istanbul` | 5.0.2 | peer vitest exact | Not needed |
| `happy-dom` | **20.14.5** | engines node >= 20 | **Recommended** DOM env (fast; has no-op IO/RO, clipboard, matchMedia, sessionStorage; canvas `getContext` returns null) |
| `jsdom` | 30.1.1 | **engines node `^22.22.2 \|\| ^24.15.0 \|\| >=26`**; the local node is **v24.0.1**, so npm warns (EBADENGINE) and it may fail | Avoid 30.x on this machine; 29.1.1 (node `>=24.0.0`) would work if jsdom is ever preferred |
| `@playwright/test` | **1.63.0** | node >= 20 | Recommended; `_electron` verified on Electron 44.4.5 (Spike 1). Browsers: `npx playwright install chromium` |
| `@vitest/browser`, `@vitest/browser-playwright` | 5.0.2 | peer vitest exact | Not needed (happy-dom plus Playwright e2e suffices) |
| `wrangler` | 4.143.0 | node >= 22 | Optional; prefer the tiny header-applying static server |
| `three` | 0.170.0 exists | - | Add as an **exact** devDependency for the offline integrity test and to serve CDN routes in e2e |

Also relevant: `electron` 44.4.5 is installed (dist present, `node_modules/electron/dist/version`). `tests/node_modules/.vite/vitest` is a vitest cache dir, covered by `node_modules/` in `.gitignore`.

### F.2 Vitest 5 config API (verified in `node_modules/vitest/dist/chunks/plugin.d.CN87HSxv.d.ts`)
- `test.environment?: VitestEnvironment` (line ~3585): `'node' | 'jsdom' | 'happy-dom' | 'edge-runtime'`.
- A per-file docblock `// @vitest-environment happy-dom` is supported (`dist/chunks/index.DzobfTyw.js:6033` regex `/@(?:vitest|jest)-environment\s+([\w-]+)\b/`).
- `environmentMatchGlobs` is gone (not in the types).
- `test.projects?: TestProjectConfiguration[]` (line ~3642). Inline projects accept `extends?: string | boolean` (line ~4499, default true: inherit root options). "Inline configurations cannot declare `projects`."
- `coverage.provider?: "v8" | "istanbul" | "custom"` (default v8); `include?: string[]` (by default only files touched by tests, so **set `include` to count untested files**); `exclude`, `reportsDirectory` (default `./coverage`), `reporter` (default `['text','html','clover','json']`), `skipFull`.
- `coverage.thresholds?: Thresholds | ({ [glob]: Pick<Thresholds, 100 | statements | functions | branches | lines | perFile> } & Thresholds)`, where `Thresholds = { 100?: boolean; perFile?: boolean | Pick<…>; autoUpdate?: boolean | fn; statements?; functions?; branches?; lines? }` (lines ~1853-2000). Negative numbers mean "max uncovered".
- Coverage options belong at the root, not per project.

Recommended `vitest.config.ts` (a sketch; the current one is 10 lines with include `tests/**/*.test.ts`, timeouts 120 s, and `setupFiles: ["tests/setup.ts"]`):
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 120_000, hookTimeout: 120_000,
    setupFiles: ["tests/setup.ts"],
    projects: [
      { extends: true, test: { name: "node", include: ["tests/**/*.test.ts"], exclude: ["tests/dom/**"], environment: "node" } },
      { extends: true, test: { name: "dom", include: ["tests/dom/**/*.test.ts"], environment: "happy-dom" } },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "desktop/**/*.ts", "website/assets/{download,nav,sections,main}.js" /*, "web/src/**/*.ts" per other scanners */],
      exclude: ["src/types/**", "website/assets/scene.js", "scripts/**" /* unless refactored */],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100, perFile: true /* or per-glob overrides */ },
    },
  },
});
```
The per-file docblock alternative (no projects) is simpler: put `// @vitest-environment happy-dom` atop each DOM test.

Keep Playwright specs out of vitest's include with a different folder and suffix (`e2e/**/*.spec.ts`), plus a `playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  projects: [
    { name: "electron", testMatch: /desktop\/.*\.spec\.ts/ },
    { name: "website", testMatch: /website\/.*\.spec\.ts/, use: { baseURL: "http://127.0.0.1:8788" } },
  ],
  webServer: { command: "node --import tsx e2e/website/server.ts", url: "http://127.0.0.1:8788", reuseExistingServer: true },
  workers: 1, // one Electron app at a time (single-instance lock)
});
```
`tsconfig.json` `include` should add `e2e` (currently `src, desktop, tests, scripts, vitest.config.ts`) and `playwright.config.ts`.

Suggested npm scripts:
- `"test": "vitest run"` (unchanged)
- `"test:coverage": "vitest run --coverage"`
- `"test:swift": "swift test --package-path native/capture"`
- `"test:e2e": "npm run build:web && npm run build:desktop && playwright test"`
- `"test:all": "npm run test:coverage && npm run test:swift && npm run test:e2e"`

### F.3 `.gitignore`
- It has `coverage/` (line ~61), `.build/`, `.swiftpm/`, `out/`, `dist/`, `.wrangler/`, and `node_modules/`.
- **Missing:** `test-results/`, `playwright-report/`, `blob-report/`, and `playwright/.cache/`. Add them.
- Also note that `*.webm` is already ignored (Playwright videos), and so are `*.log` and `tmp/`.

### F.4 CI
- **Confirmed: no CI.** There is no `.github/` directory, and no workflow files anywhere outside `node_modules`.
- `docs/website.md:110` states "the repository has no GitHub Actions and holds no deploy secret". The only automation is Cloudflare Workers Builds for `website/`. All test gating must live in the local release (`checks.sh` today, plus the proposed Step 1).

### F.5 Environment gotchas for the implementer
- `tests/setup.ts` replaces `globalThis.fetch` with a thrower for all tests. DOM tests must stub fetch per test. Playwright tests are unaffected (a separate runner).
- Node v24.0.1 locally. `duplexPair` (used by `inProcess.ts`) needs Node 22.6 or later: fine.
- Swift: full Xcode 26-era toolchain, Swift 6.3.3; `swift test` works (Spike 2).
- Playwright Electron tests must run serially (`workers: 1`) and with an isolated `HOME`, or they collide with each other and with an installed Tattle through userData, the single-instance lock, and `credentials.json`.
- `desktop.test.ts:62` walks `src` relative to cwd, so vitest must run from the project root (it does).
