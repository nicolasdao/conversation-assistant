import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appPaths, setAppPaths, speakerModelPath, vadModelPath } from "../src/paths.ts";
import { SessionLibrary } from "../src/store/library.ts";
import { about, engineStale } from "../src/server/main.ts";
import { SessionStore } from "../src/store/sessionStore.ts";

// What the Mac app relies on in the engine (see docs/desktop.md). The app itself runs in Electron, which these
// tests do not start.

afterEach(() => setAppPaths());

describe("paths", () => {
  test("default to the project folder, as npm run serve and the CLI tools expect", () => {
    expect(appPaths()).toMatchObject({ web: "web", config: "config", models: "models", sessions: "sessions" });
    expect(vadModelPath()).toBe(join("models", "silero_vad.onnx"));
    expect(appPaths().src).toMatch(/src$/);
  });

  test("the Mac app moves them all, read at each use", () => {
    setAppPaths({ models: "/app/Resources/models", sessions: "/support/sessions", root: "/app/asar", src: null });
    expect(speakerModelPath()).toBe("/app/Resources/models/wespeaker_en_voxceleb_resnet34_LM.onnx");
    expect(new SessionLibrary().root).toBe("/support/sessions");
    expect(engineStale()).toBe(false); // no sources to watch
    expect(() => about()).toThrow(/\/app\/asar\/package\.json/);
    setAppPaths();
    expect(appPaths().sessions).toBe("sessions");
  });
});

test("sherpa-onnx calls that return audio copy it, because Electron refuses external buffers", () => {
  // "External buffers are not allowed": Electron's V8 memory cage rejects the ArrayBuffers sherpa-onnx makes over
  // native memory, which Node accepts, so only this check catches a call that forgets the `false`.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk("src");
  const calls = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\b(?:vad|extractor)\.(front|compute|get)\(([^)]*)\)/g)].map((m) => `${f}: ${m[0]}`));
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const c of calls) expect(c).toMatch(/,?\s*false\)$/);
});

test("a recording's audio is complete as soon as its input ends, before the rest of the ending", () => {
  // quitting the Mac app during a show waits only for this, not for fact-checks to drain (up to 180 s)
  const store = new SessionStore({ root: mkdtempSync(join(tmpdir(), "sessions-")), streams: ["host"] });
  store.writeAudio("host", new Float32Array(1600).fill(0.25));
  const dataSize = () => readFileSync(join(store.dir, "host.wav")).readUInt32LE(40);
  expect(dataSize()).toBe(0); // the header is written with the final size, once
  store.closeAudio();
  expect(dataSize()).toBe(3200);
  store.append("events", { type: "session.ended" }); // the ending still writes its events
  expect(readFileSync(join(store.dir, "events.jsonl"), "utf8")).toContain("session.ended");
  store.close();
  expect(dataSize()).toBe(3200);
});
