import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkKey, childEnv, credentialsPath, KEY_ENV, KEY_NAMES, KeyError, keyFormatProblem, KeySetup, KeyStore, loadKeys,
} from "../src/keys.ts";
import { cleanTmpDirs, tmpDir, withEnv } from "./fakes/env.ts";
import { fakeKeyCheckFetch } from "./fakes/keyCheck.ts";

const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
const OPENROUTER = "sk-or-v1-abcdefghijklmnopqrstuvwxyz9876";
/** A credentials path whose folder does not exist yet, as on a fresh Mac. Never the real one. */
const tmpCreds = () => join(tmpDir("keys-"), "Tattle", "credentials.json");

afterEach(() => {
  cleanTmpDirs();
  vi.restoreAllMocks();
});

describe("where the keys live", () => {
  it("credentialsPath uses TATTLE_CREDENTIALS, else Library/Application Support/Tattle/credentials.json (a string only)", () => {
    expect(credentialsPath({ TATTLE_CREDENTIALS: "/tmp/x/creds.json" })).toBe("/tmp/x/creds.json");
    expect(credentialsPath({ TATTLE_CREDENTIALS: "" })).toBe(join(homedir(), "Library", "Application Support", "Tattle", "credentials.json"));
    expect(credentialsPath({})).toMatch(/Library\/Application Support\/Tattle\/credentials\.json$/);
  });

  it("the KeyStore's default path comes from the given env's TATTLE_CREDENTIALS", () => {
    const p = tmpCreds();
    expect(new KeyStore({ env: { TATTLE_CREDENTIALS: p } }).path).toBe(p);
  });

  it("KEY_ENV and KEY_NAMES name both keys; childEnv drops them and keeps the rest", () => {
    expect(KEY_NAMES).toEqual(["openai", "openrouter"]);
    expect(KEY_ENV).toEqual({ openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" });
    const env = { OPENAI_API_KEY: "a", OPENROUTER_API_KEY: "b", PATH: "/bin" };
    expect(childEnv(env)).toEqual({ PATH: "/bin" });
    expect(env.OPENAI_API_KEY).toBe("a"); // a copy
  });
});

describe("KeyStore", () => {
  it("load treats a whitespace-only env var as unset and fills it from the file", () => {
    const path = tmpCreds();
    new KeyStore({ path, env: {} }).save({ openai: OPENAI });
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "   " };
    const store = new KeyStore({ path, env }).load();
    expect(env.OPENAI_API_KEY).toBe(OPENAI);
    expect(store.status()[0]).toMatchObject({ set: true, source: "file" });
  });

  it("status: the hint is the last 4 characters of the trimmed key; an unset key is set:false, source:null, hint:null", () => {
    const store = new KeyStore({ path: tmpCreds(), env: { OPENAI_API_KEY: `  ${OPENAI}\n` } }).load();
    expect(store.status()).toEqual([
      { name: "openai", env: "OPENAI_API_KEY", set: true, source: "environment", hint: "0123" },
      { name: "openrouter", env: "OPENROUTER_API_KEY", set: false, source: null, hint: null },
    ]);
    expect(store.missing()).toEqual(["openrouter"]);
  });

  it("save tightens an existing 0755 folder to 0700", () => {
    const path = tmpCreds();
    mkdirSync(dirname(path), { mode: 0o755 });
    chmodSync(dirname(path), 0o755);
    new KeyStore({ path, env: {} }).save({ openrouter: OPENROUTER });
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("save leaves no .tmp file behind, and writes 2-space JSON ending with a newline", () => {
    const path = tmpCreds();
    new KeyStore({ path, env: {} }).save({ openai: OPENAI, openrouter: OPENROUTER });
    expect(readdirSync(dirname(path))).toEqual(["credentials.json"]);
    expect(readFileSync(path, "utf8")).toBe(`{\n  "OPENAI_API_KEY": "${OPENAI}",\n  "OPENROUTER_API_KEY": "${OPENROUTER}"\n}\n`);
  });

  it("save refuses a key the environment sets (409), before writing anything", () => {
    const path = tmpCreds();
    const store = new KeyStore({ path, env: { OPENROUTER_API_KEY: OPENROUTER } }).load();
    let err: unknown;
    try { store.save({ openai: OPENAI, openrouter: OPENROUTER }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(KeyError);
    expect(err).toMatchObject({ status: 409, message: "OPENROUTER_API_KEY is set in .env or your shell, which wins over the page: change it there" });
    expect(existsSync(path)).toBe(false);
  });

  it("save of an empty key sets it empty in the environment and leaves it out of the file (documents behaviour)", () => {
    const path = tmpCreds();
    const env: NodeJS.ProcessEnv = {};
    new KeyStore({ path, env }).save({ openai: "" });
    expect(env.OPENAI_API_KEY).toBe("");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("read ignores non-string and blank values and trims the others", () => {
    const path = tmpCreds();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: 12345, OPENROUTER_API_KEY: `  ${OPENROUTER}  `, OTHER: "x" }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    new KeyStore({ path, env }).load();
    expect(env).toEqual({ OPENROUTER_API_KEY: OPENROUTER });
    writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: "   " }), { mode: 0o600 });
    const env2: NodeJS.ProcessEnv = {};
    expect(new KeyStore({ path, env: env2 }).load().missing()).toEqual(["openai", "openrouter"]);
    writeFileSync(path, "null", { mode: 0o600 });
    expect(new KeyStore({ path, env: {} }).load().missing()).toEqual(["openai", "openrouter"]);
  });

  it("read reports a broken file with console.error, and the page asks for the keys again", () => {
    const path = tmpCreds();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "{ broken", { mode: 0o600 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(new KeyStore({ path, env: {} }).load().missing()).toEqual(["openai", "openrouter"]);
    expect(err).toHaveBeenCalledWith(`${path} is not valid JSON: ignored, so the page asks for the keys again`);
  });

  it("loadKeys fills process.env from the TATTLE_CREDENTIALS file", async () => {
    const path = tmpCreds();
    new KeyStore({ path, env: {} }).save({ openai: OPENAI, openrouter: OPENROUTER });
    await withEnv({ TATTLE_CREDENTIALS: path, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, () => {
      const store = loadKeys();
      expect(store.path).toBe(path);
      expect(process.env.OPENAI_API_KEY).toBe(OPENAI);
      expect(process.env.OPENROUTER_API_KEY).toBe(OPENROUTER);
    });
  });
});

describe("keyFormatProblem", () => {
  it("'' → Paste the key.; a tab or newline → no spaces; 19 and 401 chars → whole key; 20 and 400 pass", () => {
    expect(keyFormatProblem("openai", "")).toBe("Paste the key.");
    expect(keyFormatProblem("openai", "sk-abc\tdefghijklmnopqrstu")).toBe("A key has no spaces or line breaks: copy it again.");
    expect(keyFormatProblem("openrouter", `${OPENROUTER}\n`)).toBe("A key has no spaces or line breaks: copy it again.");
    expect(keyFormatProblem("openai", "k".repeat(19))).toBe("This does not look like a whole key: copy it again.");
    expect(keyFormatProblem("openai", "k".repeat(401))).toBe("This does not look like a whole key: copy it again.");
    expect(keyFormatProblem("openai", "k".repeat(20))).toBeNull();
    expect(keyFormatProblem("openai", "k".repeat(400))).toBeNull();
  });

  it("an OpenRouter key passes for OpenRouter; a key without sk- passes for OpenAI; the wrong service's key is named", () => {
    expect(keyFormatProblem("openrouter", OPENROUTER)).toBeNull();
    expect(keyFormatProblem("openai", "proj-abcdefghijklmnopqrstuvwxyz")).toBeNull();
    expect(keyFormatProblem("openrouter", "or-abcdefghijklmnopqrstuvwxyz")).toBeNull();
    expect(keyFormatProblem("openai", OPENROUTER)).toBe("This is an OpenRouter key: paste it in the OpenRouter field.");
    expect(keyFormatProblem("openrouter", OPENAI)).toBe("This looks like an OpenAI key: OpenRouter keys start with sk-or-.");
  });
});

describe("checkKey", () => {
  const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("makes no fetch call when the format is wrong", async () => {
    const f = vi.fn();
    expect(await checkKey("openai", "short", { fetch: f as unknown as typeof fetch })).toEqual({ ok: false, message: "This does not look like a whole key: copy it again." });
    expect(f).not.toHaveBeenCalled();
  });

  it("asks the right URL with a Bearer header and a 10 s timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    await checkKey("openai", OPENAI, { fetch: f });
    await checkKey("openrouter", OPENROUTER, { fetch: f });
    expect(seen.map((s) => s.url)).toEqual(["https://api.openai.com/v1/models", "https://openrouter.ai/api/v1/key"]);
    expect(seen.map((s) => (s.init.headers as Record<string, string>).Authorization)).toEqual([`Bearer ${OPENAI}`, `Bearer ${OPENROUTER}`]);
    expect(seen.every((s) => s.init.signal instanceof AbortSignal)).toBe(true);
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([10_000, 10_000]);
  });

  it("401 refuses with a message for each service", async () => {
    expect(await checkKey("openai", OPENAI, { fetch: respond(401, "") })).toEqual({ ok: false, message: "OpenAI does not accept this key. Check it was copied whole, and not revoked." });
    expect(await checkKey("openrouter", OPENROUTER, { fetch: respond(401, "") })).toEqual({ ok: false, message: "OpenRouter does not accept this key. Check it was copied whole, and not deleted or disabled." });
  });

  it("403 and 500 are saved with an 'HTTP <s>' warning", async () => {
    for (const s of [403, 500]) {
      expect(await checkKey("openai", OPENAI, { fetch: respond(s, "nope") })).toEqual({
        ok: true, message: "Saved", warning: `The service answered HTTP ${s} when checking it. It was saved anyway.`,
      });
    }
  });

  it("a 200 with a non-JSON body: OpenRouter warns of no credit limit; OpenAI says the key works", async () => {
    expect((await checkKey("openrouter", OPENROUTER, { fetch: respond(200, "<html>") })).warning).toMatch(/no credit limit/);
    expect(await checkKey("openai", OPENAI, { fetch: respond(200, "<html>"), models: ["gpt-transcribe"] })).toEqual({ ok: true, message: "Key works" });
  });

  it("OpenRouter: a limit without limit_remaining → 'Key works: limit $10'; the free tier wins over a limit", async () => {
    expect(await checkKey("openrouter", OPENROUTER, { fetch: respond(200, JSON.stringify({ data: { limit: 10 } })) })).toEqual({ ok: true, message: "Key works: limit $10" });
    const free = await checkKey("openrouter", OPENROUTER, { fetch: fakeKeyCheckFetch({ freeTier: true, limit: 10 }).f });
    expect(free).toEqual({ ok: true, message: "Key works", warning: expect.stringMatching(/^This account has no credit yet/) });
  });

  it("OpenAI: two lacking models are joined with ' and '; all present or an empty model list → no warning", async () => {
    const two = await checkKey("openai", OPENAI, { fetch: fakeKeyCheckFetch({ models: ["whisper"] }).f, models: ["gpt-transcribe", "gpt-live-transcribe"] });
    expect(two.warning).toBe("This key cannot use gpt-transcribe and gpt-live-transcribe, which transcription needs. Check the project's model permissions at platform.openai.com.");
    expect(await checkKey("openai", OPENAI, { fetch: fakeKeyCheckFetch().f, models: ["gpt-transcribe"] })).toEqual({ ok: true, message: "Key works" });
    expect(await checkKey("openai", OPENAI, { fetch: fakeKeyCheckFetch({ models: [] }).f, models: ["gpt-transcribe"] })).toEqual({ ok: true, message: "Key works" });
    expect(await checkKey("openai", OPENAI, { fetch: fakeKeyCheckFetch({ models: ["x"] }).f })).toEqual({ ok: true, message: "Key works" }); // no models asked for
  });
});

describe("KeySetup", () => {
  const setup = (env: NodeJS.ProcessEnv = {}, fetchFn = fakeKeyCheckFetch().f, extra: { required?: () => ("openai" | "openrouter")[] } = {}) => {
    const store = new KeyStore({ path: tmpCreds(), env }).load();
    return { store, env, setup: new KeySetup(store, { fetch: fetchFn, models: ["gpt-transcribe"], ...extra }) };
  };

  it("save: a null or string body → 400; a number value → 400 'openai must be a string'; nothing given → 400 'no key given'", async () => {
    const { setup: s } = setup();
    for (const body of [null, "str", 5]) await expect(s.save(body)).rejects.toMatchObject({ status: 400, message: "expected { openai?, openrouter? }" });
    await expect(s.save({ openai: 12 })).rejects.toMatchObject({ status: 400, message: "openai must be a string" });
    await expect(s.save({ openrouter: true })).rejects.toMatchObject({ status: 400, message: "openrouter must be a string" });
    for (const body of [{}, { openai: "" }, { openai: null, openrouter: undefined }]) {
      await expect(s.save(body)).rejects.toMatchObject({ status: 400, message: "no key given" });
    }
  });

  it("save: a key the environment sets → 409, and nothing is checked", async () => {
    const f = vi.fn();
    const { setup: s } = setup({ OPENAI_API_KEY: OPENAI }, f as unknown as typeof fetch);
    await expect(s.save({ openai: OPENAI })).rejects.toMatchObject({ status: 409, message: "OPENAI_API_KEY is set in .env or your shell, which wins over the page: change it there" });
    expect(f).not.toHaveBeenCalled();
  });

  it("save trims keys before checking and saving, and passes the transcription models only for OpenAI", async () => {
    const seen: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return String(url).includes("openai") ? new Response(JSON.stringify({ data: [{ id: "whisper" }] })) : new Response(JSON.stringify({ data: { limit: 5 } }));
    }) as unknown as typeof fetch;
    const { setup: s, store, env } = setup({}, f);
    const r = await s.save({ openai: `  ${OPENAI}\n`, openrouter: ` ${OPENROUTER} ` });
    expect(seen.sort()).toEqual([`https://api.openai.com/v1/models Bearer ${OPENAI}`, `https://openrouter.ai/api/v1/key Bearer ${OPENROUTER}`]);
    expect(r.checks.openai!.warning).toMatch(/cannot use gpt-transcribe/); // the models were passed for OpenAI
    expect(r.checks.openrouter).toEqual({ ok: true, message: "Key works: limit $5" });
    expect(r.saved).toBe(true);
    expect(env).toMatchObject({ OPENAI_API_KEY: OPENAI, OPENROUTER_API_KEY: OPENROUTER });
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({ OPENAI_API_KEY: OPENAI, OPENROUTER_API_KEY: OPENROUTER });
  });

  it("status: the path shows the home folder as ~; configured follows the required keys (OpenAI by default)", () => {
    const store = new KeyStore({ path: join(homedir(), "never-created-tattle-test", "credentials.json"), env: {} });
    expect(new KeySetup(store, { fetch: fakeKeyCheckFetch().f, models: [] }).status()).toMatchObject({
      configured: false, required: ["openai"], path: "~/never-created-tattle-test/credentials.json",
    });
    expect(new KeySetup(store, { fetch: fakeKeyCheckFetch().f, models: [], required: () => [] }).status()).toMatchObject({ configured: true, required: [] });
    const withOr = new KeyStore({ path: tmpCreds(), env: { OPENROUTER_API_KEY: OPENROUTER } }).load();
    expect(new KeySetup(withOr, { fetch: fakeKeyCheckFetch().f, models: [], required: () => ["openrouter"] }).status().configured).toBe(true);
    expect(existsSync(join(homedir(), "never-created-tattle-test"))).toBe(false);
  });
});
