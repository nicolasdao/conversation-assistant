import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppPaths } from "../src/paths.ts";
import { settingsPath, SettingsStore, TranscriptionSettings, type TranscriptionStatus } from "../src/settings.ts";
import type { AppleStatus } from "../src/transcribe/apple.ts";
import { deferred } from "./fakes/async.ts";
import { cleanTmpDirs, tmpDir, withEnv } from "./fakes/env.ts";

const AVAILABLE: AppleStatus = { available: true, reason: null, locale: "en_US", installed: true };
const MISSING: AppleStatus = { ...AVAILABLE, installed: false };
const CHECK_FAILED: AppleStatus = { available: false, reason: null, locale: null, installed: false, error: "timed out" };
const OLD_MAC: AppleStatus = { available: false, reason: "Needs macOS 26 or later", locale: null, installed: false };

/** A settings file in a folder that does not exist yet. Never the real one. */
const tmpStore = () => new SettingsStore(join(tmpDir("settings-"), "Tattle", "settings.json"));

afterEach(() => {
  setAppPaths();
  cleanTmpDirs();
  vi.restoreAllMocks();
});

describe("where the settings live", () => {
  it("settingsPath uses TATTLE_SETTINGS, else Application Support/Tattle/settings.json (a string only)", () => {
    expect(settingsPath({ TATTLE_SETTINGS: "/tmp/x/settings.json" })).toBe("/tmp/x/settings.json");
    expect(settingsPath({})).toBe(join(homedir(), "Library", "Application Support", "Tattle", "settings.json"));
  });

  it("the store's default path follows TATTLE_SETTINGS", async () => {
    const p = join(tmpDir("settings-"), "settings.json");
    await withEnv({ TATTLE_SETTINGS: p }, () => { expect(new SettingsStore().path).toBe(p); });
  });
});

describe("SettingsStore", () => {
  it("save creates a private folder and file (0700 / 0600), leaves no .tmp file, merges, and returns the whole settings", () => {
    const s = tmpStore();
    expect(s.save({})).toEqual({});
    expect(s.save({ transcriptionEngine: "openai" })).toEqual({ transcriptionEngine: "openai" });
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(s.path)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(s.path))).toEqual(["settings.json"]);
    expect(readFileSync(s.path, "utf8")).toBe('{\n  "transcriptionEngine": "openai"\n}\n');
    expect(s.save({ transcriptionEngine: "apple" })).toEqual({ transcriptionEngine: "apple" });
  });

  it("read reports a broken file with console.error; saving over it replaces it", () => {
    const s = tmpStore();
    mkdirSync(dirname(s.path), { recursive: true, mode: 0o700 });
    writeFileSync(s.path, "{ broken", { mode: 0o600 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(s.read()).toEqual({});
    expect(err).toHaveBeenCalledWith(`${s.path} is not valid JSON: ignored`);
    s.save({ transcriptionEngine: "apple" });
    expect(s.read()).toEqual({ transcriptionEngine: "apple" });
  });

  it("read keeps only a known engine and drops other keys", () => {
    const s = tmpStore();
    mkdirSync(dirname(s.path), { recursive: true, mode: 0o700 });
    writeFileSync(s.path, JSON.stringify({ transcriptionEngine: "openai", other: 1 }), { mode: 0o600 });
    expect(s.read()).toEqual({ transcriptionEngine: "openai" });
    writeFileSync(s.path, "null", { mode: 0o600 });
    expect(s.read()).toEqual({});
  });
});

/** TranscriptionSettings with every seam faked; `statuses` answers the Apple checks in turn (the last one repeats). */
function rig(o: { saved?: "apple" | "openai"; key?: boolean; statuses?: AppleStatus[]; install?: (p: (f: number) => void) => Promise<void> } = {}) {
  const store = tmpStore();
  if (o.saved) store.save({ transcriptionEngine: o.saved });
  const statuses = [...(o.statuses ?? [AVAILABLE])];
  const checks: boolean[] = [];
  const changes: TranscriptionStatus[] = [];
  let installs = 0;
  let key = o.key ?? false;
  const t = new TranscriptionSettings({
    store, openaiKeySet: () => key,
    status: async (refresh) => { checks.push(refresh); return statuses.length > 1 ? statuses.shift()! : statuses[0]!; },
    install: async (p) => { installs++; await (o.install ?? (async () => {}))(p); },
    onChange: (s) => changes.push(s),
  });
  return { t, store, checks, changes, installs: () => installs, setKey: (v: boolean) => { key = v; } };
}

describe("TranscriptionSettings", () => {
  it("a saved choice is read, used, and not written again", async () => {
    const r = rig({ saved: "openai", statuses: [AVAILABLE] });
    const before = readFileSync(r.store.path, "utf8");
    expect(await r.t.init()).toEqual({
      engine: "openai", saved: "openai",
      apple: { available: true, reason: null, model: "installed", fraction: null, error: null }, openai: { keySet: false },
    });
    expect(readFileSync(r.store.path, "utf8")).toBe(before);
    expect(r.checks).toEqual([false]); // the boot check may use the cached answer
    expect(r.installs()).toBe(0);
  });

  it("a failed Apple check: Apple, its model in error with the reason, nothing saved, nothing installed", async () => {
    const r = rig({ statuses: [CHECK_FAILED] });
    const s = await r.t.init();
    expect(s).toMatchObject({ engine: "apple", saved: null, apple: { model: "error", error: "Could not check on-device speech recognition: timed out" } });
    expect(existsSync(r.store.path)).toBe(false);
    expect(r.installs()).toBe(0);
    expect(r.t.ready).toBe(false);
    expect(r.t.appleAvailable).toBe(true); // a failed check still lets the host pick Apple
  });

  it("an older Mac: OpenAI, saved; Apple is not available, with its reason", async () => {
    const r = rig({ statuses: [OLD_MAC] });
    await r.t.init();
    expect(r.t.engine).toBe("openai");
    expect(r.store.read()).toEqual({ transcriptionEngine: "openai" });
    expect(r.t.appleAvailable).toBe(false);
    expect(r.t.appleReason).toBe("Needs macOS 26 or later");
    expect(r.t.ready).toBe(true);
  });

  it("set(apple) with the model missing saves, installs, and reports each change; set(openai) installs nothing", async () => {
    const r = rig({ key: true, statuses: [MISSING, AVAILABLE], install: async (p) => { p(0.25); p(1); } });
    await r.t.init();
    expect(r.t.engine).toBe("openai");
    expect(r.installs()).toBe(0);
    const s = await r.t.set("apple");
    expect(r.store.read()).toEqual({ transcriptionEngine: "apple" });
    expect(s.engine).toBe("apple");
    await r.t.install(); // joins the running install
    expect(r.installs()).toBe(1);
    expect(r.checks).toEqual([false, true]); // after installing, the check is refreshed
    expect(r.changes.map((c) => [c.apple.model, c.apple.fraction])).toEqual([["installing", 0], ["installing", 0.25], ["installing", 1], ["installing", 1], ["installed", null]]);
    await r.t.set("openai");
    expect(r.installs()).toBe(1);
    expect(r.t.status().openai.keySet).toBe(true);
    r.setKey(false);
    expect(r.t.status().openai.keySet).toBe(false);
  });

  it("set(apple) while the model installs, or once installed, starts no second install", async () => {
    const gate = deferred();
    const r = rig({ key: true, statuses: [MISSING, AVAILABLE], install: () => gate.promise });
    await r.t.init();
    await r.t.set("apple");
    await r.t.set("apple");
    expect(r.installs()).toBe(1);
    const p1 = r.t.install();
    expect(r.t.install()).toBe(p1);
    gate.resolve();
    await p1;
    await r.t.set("apple");
    expect(r.installs()).toBe(1);
  });

  it("an install that ends without the model installed is an error: Apple's own reason, else 'the model did not install'", async () => {
    const a = rig({ statuses: [MISSING, { ...MISSING, error: "helper crashed" }] });
    await a.t.init();
    await a.t.install();
    expect(a.t.status().apple).toMatchObject({ model: "error", error: "helper crashed" });
    const b = rig({ statuses: [MISSING] });
    await b.t.init();
    await b.t.install();
    expect(b.t.status().apple).toMatchObject({ model: "error", error: "the model did not install" });
  });

  it("an install rejecting with a non-Error reports it as a string", async () => {
    const r = rig({ statuses: [MISSING], install: () => Promise.reject("disk full") });
    await r.t.init();
    await r.t.install();
    expect(r.t.status().apple).toMatchObject({ model: "error", error: "disk full", fraction: null });
  });

  it("without injected seams it uses the store at TATTLE_SETTINGS, Apple's real check, and the real installer (here: none built)", async () => {
    const p = join(tmpDir("settings-"), "settings.json");
    setAppPaths({ transcriber: join(tmpDir("no-helper-"), "tattle-transcribe") });
    await withEnv({ TATTLE_SETTINGS: p, TATTLE_FORCE_NO_APPLE_SPEECH: "1" }, async () => {
      const t = new TranscriptionSettings({ openaiKeySet: () => false });
      const s = await t.init();
      expect(s).toMatchObject({ engine: "openai", saved: "openai", apple: { available: false, reason: "Needs macOS 26 or later" } });
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ transcriptionEngine: "openai" });
      await t.install(); // spawns a helper that does not exist: an error, never a download
      expect(t.status().apple.model).toBe("error");
      expect(t.status().apple.error).toMatch(/ENOENT/);
    });
  });
});
