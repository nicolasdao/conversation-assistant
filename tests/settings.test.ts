import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveEngine, SettingsStore, TranscriptionSettings } from "../src/settings.ts";
import type { AppleStatus } from "../src/transcribe/apple.ts";
import { createApiServer, Engine } from "../src/server/main.ts";

const AVAILABLE: AppleStatus = { available: true, reason: null, locale: "en_US", installed: true };
const OLD_MAC: AppleStatus = { available: false, reason: "Needs macOS 26 or later", locale: null, installed: false };
const CHECK_FAILED: AppleStatus = { available: false, reason: null, locale: null, installed: false, error: "timed out" };

const store = () => new SettingsStore(join(mkdtempSync(join(tmpdir(), "settings-")), "settings.json"));

describe("resolveEngine", () => {
  test("a fresh macOS 26 Mac transcribes on the Mac, and saves it", () => {
    expect(resolveEngine({ openaiKeySet: false, apple: AVAILABLE })).toEqual({ engine: "apple", persist: "apple" });
  });
  test("a fresh older Mac uses OpenAI", () => {
    expect(resolveEngine({ openaiKeySet: false, apple: OLD_MAC })).toEqual({ engine: "openai", persist: "openai" });
  });
  test("someone with an OpenAI key keeps OpenAI after the update", () => {
    expect(resolveEngine({ openaiKeySet: true, apple: AVAILABLE })).toEqual({ engine: "openai", persist: "openai" });
  });
  test("a saved choice wins, and is never overwritten", () => {
    expect(resolveEngine({ saved: "openai", openaiKeySet: false, apple: AVAILABLE })).toEqual({ engine: "openai", persist: null });
    expect(resolveEngine({ saved: "apple", openaiKeySet: true, apple: AVAILABLE })).toEqual({ engine: "apple", persist: null });
  });
  test("saved Apple on a Mac that cannot run it falls back to OpenAI, without changing what is saved", () => {
    expect(resolveEngine({ saved: "apple", openaiKeySet: false, apple: OLD_MAC })).toEqual({ engine: "openai", persist: null });
  });
  test("a failed check never sends a Mac to the OpenAI screen: Apple, not saved", () => {
    expect(resolveEngine({ openaiKeySet: false, apple: CHECK_FAILED })).toEqual({ engine: "apple", persist: null });
    expect(resolveEngine({ saved: "apple", openaiKeySet: false, apple: CHECK_FAILED })).toEqual({ engine: "apple", persist: null });
  });
});

describe("SettingsStore", () => {
  test("saves atomically, merges, and ignores a broken file", () => {
    const s = store();
    expect(s.read()).toEqual({});
    s.save({ transcriptionEngine: "apple" });
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual({ transcriptionEngine: "apple" });
    writeFileSync(s.path, "{not json");
    expect(s.read()).toEqual({});
    writeFileSync(s.path, JSON.stringify({ transcriptionEngine: "whisper" }));
    expect(s.read()).toEqual({});
  });
});

describe("TranscriptionSettings", () => {
  test("a fresh Mac resolves to Apple, saves it, and installs a missing model with progress", async () => {
    const s = store();
    const changes: unknown[] = [];
    let installed = false;
    const t = new TranscriptionSettings({
      store: s, openaiKeySet: () => false,
      status: async () => ({ ...AVAILABLE, installed }),
      install: async (p) => { p(0.5); installed = true; },
      onChange: (st) => changes.push(st),
    });
    await t.init();
    expect(s.read()).toEqual({ transcriptionEngine: "apple" });
    expect(t.engine).toBe("apple");
    await t.install(); // the one init started
    expect(t.status().apple).toMatchObject({ model: "installed", fraction: null, error: null });
    expect(t.ready).toBe(true);
    expect(changes).toContainEqual(expect.objectContaining({ apple: expect.objectContaining({ model: "installing", fraction: 0.5 }) }));
  });

  test("a failed install is an error, which a retry can clear", async () => {
    let fail = true;
    const t = new TranscriptionSettings({
      store: store(), openaiKeySet: () => false,
      status: async () => ({ ...AVAILABLE, installed: !fail }),
      install: async () => { if (fail) throw new Error("no network"); },
    });
    await t.init();
    await t.install();
    expect(t.status().apple).toMatchObject({ model: "error", error: "no network" });
    expect(t.ready).toBe(false);
    fail = false;
    await t.install();
    expect(t.status().apple.model).toBe("installed");
  });

  test("an OpenAI key saved before the update keeps OpenAI, with nothing to install", async () => {
    let installs = 0;
    const t = new TranscriptionSettings({
      store: store(), openaiKeySet: () => true, status: async () => ({ ...AVAILABLE, installed: false }),
      install: async () => { installs++; },
    });
    await t.init();
    expect(t.engine).toBe("openai");
    expect(t.ready).toBe(true);
    expect(installs).toBe(0);
  });
});

describe("the transcription routes, and what Start and Chat refuse", () => {
  const prev = { oa: process.env.OPENAI_API_KEY, or: process.env.OPENROUTER_API_KEY };
  let installed = false;
  const transcription = new TranscriptionSettings({
    store: store(), openaiKeySet: () => !!process.env.OPENAI_API_KEY,
    status: async () => ({ ...AVAILABLE, installed }),
    install: async () => { /* stays missing until the test says so */ },
  });
  const engine = new Engine({ sessionsDir: mkdtempSync(join(tmpdir(), "sessions-")), transcription });
  const server = createApiServer(engine, { webRoot: mkdtempSync(join(tmpdir(), "web-")), ready: transcription.init() });
  let port = 0;
  beforeAll(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    if (prev.oa !== undefined) process.env.OPENAI_API_KEY = prev.oa;
    if (prev.or !== undefined) process.env.OPENROUTER_API_KEY = prev.or;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  test("GET reports the engine, Apple's state, and the OpenAI key", async () => {
    const r = await call("GET", "/api/transcription");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ engine: "apple", saved: "apple", apple: { available: true }, openai: { keySet: false } });
  });

  test("Start refuses features without the OpenRouter key, and Apple before its model is ready", async () => {
    const fc = await call("POST", "/api/session/start", { mode: "replay", dir: "fixtures/conversation", features: { factcheck: true, labels: false } });
    expect(fc).toMatchObject({ status: 400, json: { needsKey: "openrouter" } });
    expect(fc.json.error).toMatch(/OpenRouter API key to configure fact-checking or labeling/);
    const prep = await call("POST", "/api/session/start", { mode: "replay", dir: "fixtures/conversation", features: { factcheck: false, labels: false } });
    expect(prep).toMatchObject({ status: 409, json: { preparing: true } });
  });

  test("choosing OpenAI needs its key; Start with OpenAI and no key names it", async () => {
    expect(await call("PUT", "/api/transcription", { engine: "whisper" })).toMatchObject({ status: 400 });
    expect(await call("PUT", "/api/transcription", { engine: "openai" })).toMatchObject({ status: 400, json: { needsKey: "openai" } });
    process.env.OPENAI_API_KEY = "sk-proj-test-0000000000000000000000";
    const r = await call("PUT", "/api/transcription", { engine: "openai" });
    expect(r).toMatchObject({ status: 200, json: { engine: "openai", saved: "openai" } });
    delete process.env.OPENAI_API_KEY;
    const s = await call("POST", "/api/session/start", { mode: "replay", dir: "fixtures/conversation", features: { factcheck: false, labels: false } });
    expect(s).toMatchObject({ status: 400, json: { needsKey: "openai" } });
    expect((await call("PUT", "/api/transcription", { engine: "apple" })).json).toMatchObject({ engine: "apple" });
  });

  test("Chat asks for the OpenRouter key before calling OpenRouter; reading past chats does not", async () => {
    const r = await call("POST", "/api/chats", { model: "openai/gpt-6-luna" });
    expect(r).toMatchObject({ status: 400, json: { needsKey: "openrouter" } });
    expect(r.json.error).toMatch(/to use Chat/);
    expect((await call("GET", "/api/chats")).status).not.toBe(400);
  });

  test("the engine cannot change while a session is on air", async () => {
    installed = true;
    await transcription.install();
    expect(transcription.ready).toBe(true);
    // a real session is not needed to prove the guard: a stub that looks on air
    (engine as unknown as { session: unknown }).session = { status: "running" };
    try {
      expect(await call("PUT", "/api/transcription", { engine: "apple" })).toMatchObject({ status: 409 });
    } finally {
      (engine as unknown as { session: unknown }).session = null;
    }
  });
});
