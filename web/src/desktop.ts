// The Mac app's bridge (desktop/preload.ts), present only in its windows: the menu bar sends the page commands, and the
// page asks the app for what only it can do. In a browser (`npm run serve`) it is undefined and the page works alone.

/** What the menu bar sends: the name of a window to open (router.ts's PANELS). */
export type DesktopCommand = string;

/** What the page may ask the app for; the app refuses anything else. */
export type DesktopRequest = "open-licenses" | "open-chromium-licenses" | "show-license-files";

export interface DesktopBridge {
  onCommand(cb: (command: DesktopCommand) => void): void;
  run(request: DesktopRequest): void;
}

export const desktop = (globalThis as { desktop?: DesktopBridge }).desktop;
