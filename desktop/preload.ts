// The bridge between the Mac app and the page in its windows (see docs/desktop.md). It runs sandboxed, before the page,
// and gives it `window.desktop` (typed in web/src/desktop.ts): commands from the menu bar in, a fixed set of requests
// out, which desktop/main.ts checks again. Bundled on its own to dist/desktop/preload.cjs: a sandboxed preload is CommonJS.
import { contextBridge, ipcRenderer } from "electron";

// a command can arrive before the page listens (Settings… with the window closed): it waits for the listener
let listener: ((command: string) => void) | null = null;
const pending: string[] = [];
ipcRenderer.on("desktop:command", (_e, command: unknown) => {
  if (typeof command !== "string") return;
  if (listener) listener(command);
  else pending.push(command);
});

contextBridge.exposeInMainWorld("desktop", {
  onCommand(cb: (command: string) => void) {
    listener = cb;
    for (const c of pending.splice(0)) cb(c);
  },
  run(request: string) {
    ipcRenderer.send("desktop:run", String(request));
  },
});
