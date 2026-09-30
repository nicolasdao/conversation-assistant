// The preload (desktop/preload.ts; docs/desktop.md § The bridge to the page): `window.desktop` for the page, with
// commands from the menu bar in (queued until the page listens) and a fixed set of requests out. `electron` is the
// fake in tests/fakes/electron.ts; each test imports the preload fresh.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { electronModule, fakeElectron, type ElectronFake } from "./fakes/electron.ts";

const h = vi.hoisted(() => ({ e: null as unknown }));
vi.mock("electron", async () => (await import("./fakes/electron.ts")).electronModule(() => h.e as ElectronFake));

let e: ElectronFake;
type Desktop = { onCommand(cb: (c: string) => void): void; run(request: unknown): void };
let desktop: Desktop;

/** Main sends a command to the window, as `webContents.send("desktop:command", …)` does. */
const command = (c: unknown) => e.ipcRenderer.emit("desktop:command", {}, c);

beforeEach(async () => {
  e = fakeElectron();
  h.e = e;
  vi.resetModules();
  await import("../desktop/preload.ts");
  desktop = e.exposed.desktop;
});

describe("window.desktop", () => {
  it("is exposed to the page under `desktop`, with onCommand and run and nothing else", () => {
    expect(e.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(e.contextBridge.exposeInMainWorld.mock.calls[0]![0]).toBe("desktop");
    expect(Object.keys(desktop).sort()).toEqual(["onCommand", "run"]);
    expect(e.ipcRenderer.eventNames()).toEqual(["desktop:command"]);
  });

  it("delivers a command straight to a page that listens", () => {
    const cb = vi.fn();
    desktop.onCommand(cb);
    command("keys");
    command("recordings");
    expect(cb.mock.calls).toEqual([["keys"], ["recordings"]]);
  });

  it("keeps commands that arrive before the page listens, and delivers them in order when it does", () => {
    command("keys");
    command("labels");
    const cb = vi.fn();
    desktop.onCommand(cb);
    expect(cb.mock.calls).toEqual([["keys"], ["labels"]]);
    command("speakers");
    expect(cb.mock.calls).toEqual([["keys"], ["labels"], ["speakers"]]);
  });

  it("delivers a queued command once: a new listener does not get it again", () => {
    command("keys");
    const first = vi.fn();
    desktop.onCommand(first);
    const second = vi.fn();
    desktop.onCommand(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    command("insights");
    expect(second).toHaveBeenCalledWith("insights");
    expect(first).toHaveBeenCalledTimes(1); // the latest listener replaces the one before
  });

  it.each([42, null, undefined, { command: "keys" }, ["keys"]])("drops a command that is not a string: %j", (bad) => {
    command(bad);
    const cb = vi.fn();
    desktop.onCommand(cb);
    expect(cb).not.toHaveBeenCalled();
    command(bad);
    expect(cb).not.toHaveBeenCalled();
  });

  it("run sends the request to the app as a string on desktop:run", () => {
    desktop.run("open-licenses");
    expect(e.ipcRenderer.send).toHaveBeenCalledWith("desktop:run", "open-licenses");
    desktop.run(7);
    desktop.run({ toString: () => "show-license-files" });
    expect(e.ipcRenderer.send.mock.calls.slice(1)).toEqual([["desktop:run", "7"], ["desktop:run", "show-license-files"]]);
  });
});

// electronModule is also what vi.mock uses above; this keeps its getters honest
it("the fake module reads the current fake at each use", () => {
  const a = fakeElectron();
  let current = a;
  const m = electronModule(() => current);
  expect(m.app).toBe(a.app);
  current = fakeElectron();
  expect(m.app).toBe(current.app);
});
