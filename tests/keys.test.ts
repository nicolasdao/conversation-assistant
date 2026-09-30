import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkKey, keyFormatProblem, KeySetup, KeyStore } from "../src/keys.ts";
import { createApiServer, type EngineApi } from "../src/server/main.ts";
import { EventBus } from "../src/store/events.ts";
import { fakeKeyCheckFetch as fakeFetch } from "./fakes/index.ts";

const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
const OPENROUTER = "sk-or-v1-abcdefghijklmnopqrstuvwxyz9876";
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "keys-")), "Tattle", "credentials.json");

describe("KeyStore", () => {
  test("the environment wins; the file fills what it lacks", () => {
    const path = tmpFile();
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-from-env-0000000000000000" };
    new KeyStore({ path, env: {} }).save({ openai: OPENAI, openrouter: OPENROUTER });
    const store = new KeyStore({ path, env }).load();
    expect(env.OPENAI_API_KEY).toBe("sk-from-env-0000000000000000");
    expect(env.OPENROUTER_API_KEY).toBe(OPENROUTER);
    expect(store.status()).toEqual([
      { name: "openai", env: "OPENAI_API_KEY", set: true, source: "environment", hint: "0000" },
      { name: "openrouter", env: "OPENROUTER_API_KEY", set: true, source: "file", hint: "9876" },
    ]);
    expect(() => store.save({ openai: OPENAI })).toThrow(/set in .env or your shell/);
  });

  test("saves a file only this user can read, in a folder only this user can open", () => {
    const path = tmpFile();
    const env: NodeJS.ProcessEnv = {};
    const store = new KeyStore({ path, env }).load();
    expect(store.missing()).toEqual(["openai", "openrouter"]);
    store.save({ openai: OPENAI });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ OPENAI_API_KEY: OPENAI });
    expect(env.OPENAI_API_KEY).toBe(OPENAI); // used at once
    store.save({ openrouter: OPENROUTER });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ OPENAI_API_KEY: OPENAI, OPENROUTER_API_KEY: OPENROUTER });
    expect(store.missing()).toEqual([]);
  });

  test("tightens a readable file, and ignores a broken one", () => {
    const path = tmpFile();
    new KeyStore({ path, env: {} }).save({ openai: OPENAI });
    chmodSync(path, 0o644);
    new KeyStore({ path, env: {} }).load();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, "{ not json");
    const env: NodeJS.ProcessEnv = {};
    expect(new KeyStore({ path, env }).load().missing()).toEqual(["openai", "openrouter"]);
  });
});

describe("checking a key", () => {
  test("catches paste mistakes before any call", () => {
    expect(keyFormatProblem("openai", OPENROUTER)).toMatch(/OpenRouter key/);
    expect(keyFormatProblem("openrouter", OPENAI)).toMatch(/OpenAI key/);
    expect(keyFormatProblem("openai", "sk-abc def")).toMatch(/no spaces/);
    expect(keyFormatProblem("openai", "sk-short")).toMatch(/whole key/);
    expect(keyFormatProblem("openai", OPENAI)).toBeNull();
  });

  test("refuses a key the service rejects; warns on no limit, no credit, missing models, or offline", async () => {
    expect((await checkKey("openai", OPENAI, { fetch: fakeFetch({ openai: 401 }).f })).ok).toBe(false);
    expect((await checkKey("openrouter", OPENROUTER, { fetch: fakeFetch({ openrouter: 401 }).f })).ok).toBe(false);
    expect(await checkKey("openrouter", OPENROUTER, { fetch: fakeFetch().f })).toEqual({ ok: true, message: "Key works: limit $10, $9.50 left" });
    expect((await checkKey("openrouter", OPENROUTER, { fetch: fakeFetch({ limit: null }).f })).warning).toMatch(/no credit limit/);
    expect((await checkKey("openrouter", OPENROUTER, { fetch: fakeFetch({ freeTier: true }).f })).warning).toMatch(/no credit yet/);
    const lacking = await checkKey("openai", OPENAI, { fetch: fakeFetch({ models: ["gpt-transcribe"] }).f, models: ["gpt-transcribe", "gpt-live-transcribe"] });
    expect(lacking).toMatchObject({ ok: true, warning: expect.stringMatching(/gpt-live-transcribe/) });
    expect(await checkKey("openai", OPENAI, { fetch: fakeFetch({ offline: true }).f })).toMatchObject({ ok: true, warning: expect.stringMatching(/online/) });
  });

  test("saves nothing unless every key given is accepted", async () => {
    const path = tmpFile();
    const store = new KeyStore({ path, env: {} }).load();
    const bad = await new KeySetup(store, { fetch: fakeFetch({ openai: 401 }).f, models: [] }).save({ openai: OPENAI, openrouter: OPENROUTER });
    expect(bad).toMatchObject({ saved: false, configured: false });
    expect(existsSync(path)).toBe(false);
    const good = await new KeySetup(store, { fetch: fakeFetch().f, models: [] }).save({ openai: OPENAI, openrouter: OPENROUTER });
    expect(good).toMatchObject({ saved: true, configured: true });
    expect(JSON.stringify(good)).not.toContain(OPENAI.slice(0, -4)); // only hints come back
  });
});

describe("the server before the keys are set", () => {
  const env: NodeJS.ProcessEnv = {};
  const store = new KeyStore({ path: tmpFile(), env }).load();
  // the required keys follow the transcription engine: OpenAI's key for OpenAI, none for Apple Speech on this Mac
  let transcription: "openai" | "apple" = "openai";
  const setup = new KeySetup(store, { fetch: fakeFetch().f, models: [], required: () => (transcription === "openai" ? ["openai"] : []) });
  const engine = { bus: new EventBus(), state: () => ({ session: null }) } as unknown as EngineApi;
  const server = createApiServer(engine, { webRoot: mkdtempSync(join(tmpdir(), "web-")), setup });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  test("with Apple Speech no key is required: the app opens at once", async () => {
    transcription = "apple";
    const s = await call("GET", "/api/setup");
    expect(s.json).toMatchObject({ configured: true, required: [], keys: [{ name: "openai", set: false }, { name: "openrouter", set: false }] });
    expect((await call("GET", "/api/state")).status).toBe(200);
  });

  test("with OpenAI only the setup routes answer until the OpenAI key is saved; OpenRouter is never required", async () => {
    transcription = "openai";
    expect((await call("GET", "/api/state")).status).toBe(503);
    expect((await call("GET", "/api/licenses")).status).toBe(200); // Help → Licenses works on the setup screen too
    const s = await call("GET", "/api/setup");
    expect(s.json).toMatchObject({ configured: false, required: ["openai"], keys: [{ name: "openai", set: false }, { name: "openrouter", set: false }] });
    expect((await call("POST", "/api/setup/keys", { openrouter: OPENROUTER })).json).toMatchObject({ saved: true, configured: false });
    expect((await call("GET", "/api/state")).status).toBe(503);
    expect((await call("POST", "/api/setup/keys", { openai: OPENAI })).json).toMatchObject({ saved: true, configured: true });
    expect((await call("GET", "/api/state")).status).toBe(200);
  });

  test("refuses another website, and a form post", async () => {
    expect((await call("POST", "/api/setup/keys", { openai: OPENAI }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("GET", "/api/setup", undefined, { host: "evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/setup/keys", undefined, { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
  });
});
