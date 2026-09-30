import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appInfo } from "../src/version.ts";
import {
  appPaths, appSupportDir, migrateAppSupportDir, setAppPaths, speakerModelPath, vadModelPath,
} from "../src/paths.ts";
import { cleanTmpDirs, tmpDir } from "./fakes/env.ts";

afterEach(() => {
  setAppPaths();
  cleanTmpDirs();
  vi.restoreAllMocks();
});

describe("app paths (src/paths.ts)", () => {
  it("setAppPaths merges successive partial calls", () => {
    setAppPaths({ sessions: "/tmp/x-sessions" });
    setAppPaths({ models: "/tmp/x-models" });
    expect(appPaths()).toMatchObject({ sessions: "/tmp/x-sessions", models: "/tmp/x-models", config: "config" });
  });

  it("setAppPaths({}) resets to the defaults, the same as no argument", () => {
    const defaults = { ...appPaths() };
    setAppPaths({ sessions: "/tmp/x", web: "/tmp/w" });
    expect(setAppPaths({})).toEqual(defaults);
    setAppPaths({ sessions: "/tmp/x" });
    expect(setAppPaths()).toEqual(defaults);
  });

  it("defaults: root is the project root; notices, licenses and src are absolute under it; the helpers are relative", () => {
    const p = appPaths();
    expect(JSON.parse(readFileSync(join(p.root, "package.json"), "utf8")).name).toBe("tattle");
    expect(p.notices).toBe(join(p.root, "THIRD_PARTY_NOTICES.md"));
    expect(p.licenses).toBe(join(p.root, "licenses"));
    expect(p.src).toBe(join(p.root, "src"));
    for (const k of ["notices", "licenses", "src"] as const) expect(isAbsolute(p[k]!)).toBe(true);
    expect(p).toMatchObject({
      web: "web", config: "config", models: "models", sessions: "sessions",
      helper: "native/capture/.build/release/tattle-capture", transcriber: "native/transcribe/.build/release/tattle-transcribe",
    });
    expect(p.labelSets).toBe(process.env.TATTLE_LABEL_SETS); // tests/setup.ts points it at a tmp folder
  });

  it("the label sets default to Application Support/Tattle/labels when TATTLE_LABEL_SETS is not set (read at load)", async () => {
    const saved = process.env.TATTLE_LABEL_SETS;
    delete process.env.TATTLE_LABEL_SETS;
    try {
      vi.resetModules();
      const fresh = await import("../src/paths.ts"); // computes a string only: nothing on disk is touched
      expect(fresh.appPaths().labelSets).toBe(join(homedir(), "Library", "Application Support", "Tattle", "labels"));
    } finally {
      process.env.TATTLE_LABEL_SETS = saved;
      vi.resetModules();
    }
  });

  it("appSupportDir() without a base ends with Library/Application Support/Tattle (a string only)", () => {
    expect(appSupportDir()).toBe(join(homedir(), "Library", "Application Support", "Tattle"));
    expect(appSupportDir("/x")).toBe("/x/Tattle");
  });

  it("the model paths follow appPaths().models at each call", () => {
    expect(vadModelPath()).toBe(join("models", "silero_vad.onnx"));
    setAppPaths({ models: "/tmp/m" });
    expect(vadModelPath()).toBe("/tmp/m/silero_vad.onnx");
    expect(speakerModelPath()).toBe("/tmp/m/wespeaker_en_voxceleb_resnet34_LM.onnx");
  });

  it("migrateAppSupportDir returns null and warns when the rename fails", () => {
    const base = tmpDir("appsupport-");
    mkdirSync(join(base, "Conversation Assistant"));
    writeFileSync(join(base, "Conversation Assistant", "credentials.json"), "{}", { mode: 0o600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    chmodSync(base, 0o500); // no write: the rename cannot happen
    try {
      expect(migrateAppSupportDir(base)).toBeNull();
    } finally {
      chmodSync(base, 0o700);
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(/^Could not move .*Conversation Assistant to .*Tattle: /);
    expect(existsSync(join(base, "Conversation Assistant", "credentials.json"))).toBe(true);
    expect(existsSync(join(base, "Tattle"))).toBe(false);
  });
});

describe("appInfo (src/version.ts)", () => {
  it("appInfo() returns the root package.json's name 'tattle' and its version", () => {
    const pkg = JSON.parse(readFileSync(join(appPaths().root, "package.json"), "utf8"));
    expect(appInfo()).toEqual({ name: "tattle", version: pkg.version });
  });

  it("appInfo(dir) re-reads on each call, so a release shows without a restart", () => {
    const d = tmpDir("version-");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    expect(appInfo(d)).toEqual({ name: "x", version: "1.0.0" });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", version: "1.0.1" }));
    expect(appInfo(d)).toEqual({ name: "x", version: "1.0.1" });
  });

  it("appInfo follows setAppPaths({ root })", () => {
    const d = tmpDir("version-");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "packaged", version: "9.9.9" }));
    setAppPaths({ root: d });
    expect(appInfo()).toEqual({ name: "packaged", version: "9.9.9" });
  });

  it("appInfo stringifies missing fields as 'undefined' (documents behaviour)", () => {
    const d = tmpDir("version-");
    writeFileSync(join(d, "package.json"), "{}");
    expect(appInfo(d)).toEqual({ name: "undefined", version: "undefined" });
  });

  it("appInfo throws when package.json is missing", () => {
    expect(() => appInfo(tmpDir("version-"))).toThrow(/ENOENT/);
  });
});
