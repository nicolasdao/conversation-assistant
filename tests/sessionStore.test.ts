import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { JSONL_FILES, SessionStore, timestampId } from "../src/store/sessionStore.ts";
import { redactor } from "../src/store/events.ts";
import { setAppPaths } from "../src/paths.ts";
import { cleanTmpDirs, tmpDir, withAppPaths } from "./fakes/index.ts";

// One folder per session (src/store/sessionStore.ts): WAVs, append-only JSONL files, and JSON documents, all redacted.

afterEach(() => { setAppPaths(); vi.useRealTimers(); });
afterAll(() => cleanTmpDirs());

describe("timestampId", () => {
  test("the local time as YYYYMMDD-HHMMSS, zero-padded", () => {
    expect(timestampId(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
    expect(timestampId(new Date(2026, 11, 31, 23, 59, 59))).toBe("20261231-235959");
    expect(timestampId()).toMatch(/^\d{8}-\d{6}$/);
  });
});

describe("SessionStore", () => {
  test("creates the folder, every JSONL file empty, and a WAV per stream", () => {
    const root = tmpDir("store-");
    const s = new SessionStore({ root, streams: ["host", "remote"] });
    expect(s.dir).toBe(join(root, s.id));
    expect(JSONL_FILES.length).toBe(11);
    for (const f of JSONL_FILES) expect(readFileSync(join(s.dir, `${f}.jsonl`), "utf8")).toBe("");
    expect(existsSync(join(s.dir, "host.wav"))).toBe(true);
    expect(existsSync(join(s.dir, "remote.wav"))).toBe(true);
    expect(existsSync(join(s.dir, "session.json"))).toBe(false); // the session writes it
    s.close();
  });

  test("two stores in the same second get <id> and <id>-2; a prefix goes first", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 30, 10, 0, 0));
    const root = tmpDir("store-");
    const a = new SessionStore({ root });
    const b = new SessionStore({ root });
    const c = new SessionStore({ root });
    const smoke = new SessionStore({ root, prefix: "smoke-" });
    expect([a.id, b.id, c.id, smoke.id]).toEqual(["20260930-100000", "20260930-100000-2", "20260930-100000-3", "smoke-20260930-100000"]);
    expect(readdirSync(root).sort()).toEqual(["20260930-100000", "20260930-100000-2", "20260930-100000-3", "smoke-20260930-100000"]);
  });

  test("without a root, the app's recordings folder", () => {
    const { sessions } = withAppPaths();
    const s = new SessionStore();
    expect(s.dir.startsWith(sessions)).toBe(true);
    expect(readdirSync(sessions)).toEqual([s.id]);
  });

  test("rows and documents are redacted; documents are pretty-printed with a trailing newline", () => {
    const s = new SessionStore({ root: tmpDir("store-"), redact: redactor(["sk-secret-12345678"]) });
    s.append("jev_calls", { key: "sk-secret-12345678", n: 1 });
    s.append("jev_calls", { n: 2 });
    expect(readFileSync(join(s.dir, "jev_calls.jsonl"), "utf8")).toBe('{"key":"[redacted]","n":1}\n{"n":2}\n');
    s.writeJson("session.json", { id: s.id, note: "sk-secret-12345678" });
    expect(readFileSync(join(s.dir, "session.json"), "utf8")).toBe(`{\n  "id": "${s.id}",\n  "note": "[redacted]"\n}\n`);
    s.writeJson("speakers.json", []);
    expect(readFileSync(join(s.dir, "speakers.json"), "utf8")).toBe("[]\n");
  });

  test("after close, rows are dropped unless written after the end on purpose; close twice is safe", () => {
    const s = new SessionStore({ root: tmpDir("store-"), streams: ["host"] });
    s.writeAudio("host", new Float32Array(160));
    s.writeAudio("remote", new Float32Array(160)); // no such stream: ignored
    expect(existsSync(join(s.dir, "remote.wav"))).toBe(false);
    s.close();
    s.close();
    s.append("events", { n: 1 });
    s.append("events", { n: 2 }, { afterClose: true });
    expect(readFileSync(join(s.dir, "events.jsonl"), "utf8")).toBe('{"n":2}\n');
    expect(readFileSync(join(s.dir, "host.wav")).length).toBe(44 + 320);
  });
});
