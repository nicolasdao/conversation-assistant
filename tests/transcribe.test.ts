import { describe, expect, test } from "vitest";
import { Budget } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { applyFixes, isFiller, MIN_AUDIO_SECONDS, Transcriber, TRANSCRIBE_URL, type TranscriptionRow } from "../src/transcribe/openai.ts";
import { deferred, flushMicrotasks } from "./fakes/index.ts";

const cfg = loadConfig().app;

function budget() {
  return new Budget();
}

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const oneSecond = new Float32Array(16000).fill(0.1);

describe("transcription", () => {
  test("a clip carries the conversation so far and the speakers' names; a sliver is never sent", async () => {
    const { f, calls } = fakeFetch([json(200, { text: "to pee" })]);
    const rows: TranscriptionRow[] = [];
    const t = new Transcriber(cfg.transcription, { fetch: f, apiKey: "k", budget: budget(), log: (r) => rows.push(r) });
    const prompt = `${cfg.transcription.prompt}\nThe speakers are Nic, Sam.\nThe conversation so far:\nNic: let's go back to the cinema`;
    await t.transcribe("u_2", oneSecond, { prompt, keywords: ["Nic", "Sam", "Jev"] });
    const form = calls[0].init.body as FormData;
    expect(form.get("prompt")).toBe(prompt);
    expect(form.getAll("keywords[]")).toEqual([...cfg.transcription.keywords, "Nic", "Sam"]); // no duplicate "Jev"
    // 54 ms of audio: dropped as empty text, with no request, no cost, and no failure
    expect(await t.transcribe("u_3", new Float32Array(864))).toEqual({ ok: true, text: "", filler: false });
    expect(calls.length).toBe(1);
    expect(rows.length).toBe(1);
  });


  test("sends the multipart fields and records estimated cost", async () => {
    const { f, calls } = fakeFetch([json(200, { text: "Jev is cheap.", languages: ["en"] })]);
    const rows: TranscriptionRow[] = [];
    const b = budget();
    const t = new Transcriber(cfg.transcription, { fetch: f, apiKey: "sk-test", budget: b, log: (r) => rows.push(r) });
    const r = await t.transcribe("u_1", oneSecond);
    expect(r).toEqual({ ok: true, text: "Jev is cheap.", filler: false });
    expect(calls[0].url).toBe(TRANSCRIBE_URL);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const form = calls[0].init.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("utterance.wav");
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(44 + 32000);
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("prompt")).toBe(cfg.transcription.prompt);
    expect(form.getAll("keywords[]")).toEqual(cfg.transcription.keywords);
    expect(form.getAll("languages[]")).toEqual(["en"]);
    expect(rows[0]).toMatchObject({ kind: "transcription", utterance_id: "u_1", ok: true, attempts: 1, audio_seconds: 1, estimated: true });
    expect(rows[0].cost_usd).toBeCloseTo(0.0045 / 60);
    expect(b.totals().transcription).toBeCloseTo(0.0045 / 60);
  });

  test("retries once on 429, then fails without a second retry", async () => {
    const { f, calls } = fakeFetch([json(429, { error: {} }), json(200, { text: "ok then" })]);
    const t = new Transcriber(cfg.transcription, { fetch: f, apiKey: "k", budget: budget(), log: () => {} });
    expect(await t.transcribe("u_1", oneSecond)).toMatchObject({ ok: true, text: "ok then" });
    expect(calls.length).toBe(2);

    const { f: f2, calls: c2 } = fakeFetch([json(500, {}), json(503, {}), json(200, { text: "never" })]);
    const rows: TranscriptionRow[] = [];
    const t2 = new Transcriber(cfg.transcription, { fetch: f2, apiKey: "k", budget: budget(), log: (r) => rows.push(r) });
    const r = await t2.transcribe("u_2", oneSecond);
    expect(r.ok).toBe(false);
    expect(c2.length).toBe(2);
    expect(rows[0]).toMatchObject({ ok: false, attempts: 2, cost_usd: 0 });
  });

  test("does not retry a 429 for exhausted credits", async () => {
    const { f, calls } = fakeFetch([json(429, { error: { type: "insufficient_quota", code: "credit_balance_exhausted" } }), json(200, { text: "x" })]);
    const t = new Transcriber(cfg.transcription, { fetch: f, apiKey: "k", budget: budget(), log: () => {} });
    expect((await t.transcribe("u_1", oneSecond)).ok).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("does not retry a 400", async () => {
    const { f, calls } = fakeFetch([json(400, { error: { message: "bad file" } })]);
    const t = new Transcriber(cfg.transcription, { fetch: f, apiKey: "k", budget: budget(), log: () => {} });
    expect((await t.transcribe("u_1", oneSecond)).ok).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("falls back to unbracketed field names when the API rejects brackets", async () => {
    const { f, calls } = fakeFetch([
      json(400, { error: { message: "Unknown parameter: 'keywords[]'.", param: "keywords[]" } }),
      json(200, { text: "fine" }),
      json(200, { text: "again" }),
    ]);
    const t = new Transcriber(cfg.transcription, { fetch: f, apiKey: "k", budget: budget(), log: () => {} });
    expect(await t.transcribe("u_1", oneSecond)).toMatchObject({ ok: true, text: "fine" });
    expect((calls[1].init.body as FormData).getAll("keywords")).toEqual(cfg.transcription.keywords);
    await t.transcribe("u_2", oneSecond);
    expect((calls[2].init.body as FormData).getAll("keywords[]")).toEqual([]);
  });

  test("says whether a failure is worth retrying later: a network drop or 5xx is, a 400 or no credits is not", async () => {
    const fail = async (reply: Parameters<typeof fakeFetch>[0][number]) => {
      const { f } = fakeFetch([reply, reply]);
      return new Transcriber(cfg.transcription, { fetch: f, apiKey: "k", budget: budget(), log: () => {} }).transcribe("u_1", oneSecond);
    };
    expect(await fail(() => { throw new TypeError("fetch failed"); })).toMatchObject({ ok: false, retryable: true });
    expect(await fail(json(503, {}))).toMatchObject({ ok: false, retryable: true });
    expect(await fail(json(400, { error: { message: "bad file" } }))).toMatchObject({ ok: false, retryable: false });
    expect(await fail(json(429, { error: { code: "insufficient_quota" } }))).toMatchObject({ ok: false, retryable: false });
  });

  test("retries a timeout", async () => {
    const { f, calls } = fakeFetch([
      () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
      json(200, { text: "late but here" }),
    ]);
    const t = new Transcriber(cfg.transcription, { fetch: f, apiKey: "k", budget: budget(), log: () => {} });
    expect(await t.transcribe("u_1", oneSecond)).toMatchObject({ ok: true });
    expect(calls.length).toBe(2);
  });

  test("fillers and fixes", () => {
    for (const t of ["uh", "Yeah.", "mm-hmm", "OK!", "so", "hi"]) expect(isFiller(t)).toBe(true);
    expect(isFiller("Jev is cheap")).toBe(false);
    expect(applyFixes("jeff and Jeffrey", [{ pattern: "jeff", replace: "Jev" }])).toBe("Jev and Jeffrey");
  });

  test("refuses once OpenRouter said the credit is used up", async () => {
    const b = new Budget();
    try { b.exhaust("provider", "jev", "OpenRouter credits or key limit exhausted (402)"); } catch { /* expected */ }
    const t = new Transcriber(cfg.transcription, { fetch: fakeFetch([]).f, apiKey: "k", budget: b, log: () => {} });
    await expect(t.transcribe("u_1", oneSecond)).rejects.toThrow(/credits or key limit exhausted/);
  });
});

function transcriber(responses: Parameters<typeof fakeFetch>[0], over: Partial<typeof cfg.transcription> = {}, b = budget()) {
  const { f, calls } = fakeFetch(responses);
  const rows: TranscriptionRow[] = [];
  const t = new Transcriber({ ...cfg.transcription, ...over }, { fetch: f, apiKey: "k", budget: b, log: (r) => rows.push(r) });
  return { t, calls, rows, b };
}

describe("transcription: concurrency", () => {
  test("concurrency 1: a second call waits until the first completes", async () => {
    const first = deferred<Response>();
    const { t, calls } = transcriber([() => first.promise, json(200, { text: "two" })], { concurrency: 1 });
    const a = t.transcribe("u_1", oneSecond);
    const b = t.transcribe("u_2", oneSecond);
    await flushMicrotasks(20);
    expect(calls).toHaveLength(1);
    first.resolve(new Response(JSON.stringify({ text: "one" })));
    expect(await a).toMatchObject({ text: "one" });
    expect(await b).toMatchObject({ text: "two" });
    expect(calls).toHaveLength(2);
  });

  test("never more requests in flight than concurrency; each release hands the slot on", async () => {
    let inFlight = 0;
    let max = 0;
    const slow = () => async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ text: "said" }));
    };
    const { t, calls } = transcriber(Array.from({ length: 5 }, slow), { concurrency: 2 });
    const rs = await Promise.all(["a", "b", "c", "d", "e"].map((id) => t.transcribe(id, oneSecond)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(calls).toHaveLength(5);
    expect(max).toBe(2);
  });

  test("the slot is released on failure", async () => {
    const { t } = transcriber([json(400, { error: "bad" }), json(200, { text: "next one" })], { concurrency: 1 });
    expect((await t.transcribe("u_1", oneSecond)).ok).toBe(false);
    expect(await t.transcribe("u_2", oneSecond)).toMatchObject({ ok: true, text: "next one" });
  });

  test("a budget refusal takes no slot and logs no row", async () => {
    const b = new Budget();
    try { b.exhaust("provider", "jev", "gone"); } catch { /* exhausted */ }
    const { t, rows } = transcriber([], { concurrency: 1 }, b);
    await expect(t.transcribe("u_1", oneSecond)).rejects.toThrow(/gone/);
    await expect(t.transcribe("u_2", oneSecond)).rejects.toThrow(/gone/); // not stuck waiting for a slot
    expect(rows).toEqual([]);
  });
});

describe("transcription: requests and failures", () => {
  test("MIN_AUDIO_SECONDS: 4000 samples (0.25 s) are sent, 3999 are not", async () => {
    const { t, calls } = transcriber([json(200, { text: "short one" })]);
    await t.transcribe("u_1", new Float32Array(3999));
    expect(calls).toHaveLength(0);
    await t.transcribe("u_2", new Float32Array(4000));
    expect(calls).toHaveLength(1);
    expect(MIN_AUDIO_SECONDS).toBe(0.25);
  });

  test("a 200 without text fails, is not retried, and says so", async () => {
    const { t, calls, rows } = transcriber([json(200, { words: [] }), json(200, { text: "x" })]);
    expect(await t.transcribe("u_1", oneSecond)).toEqual({ ok: false, error: "HTTP 200: response without text", retryable: false });
    expect(calls).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, attempts: 1, error: "HTTP 200: response without text" });
  });

  test("a 200 with invalid JSON fails with the parser's message and is not retried", async () => {
    const { t, calls } = transcriber([() => new Response("<html>oops"), json(200, { text: "x" })]);
    const r = await t.transcribe("u_1", oneSecond);
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect((r as { error: string }).error).toMatch(/JSON/);
    expect(calls).toHaveLength(1);
  });

  test("brackets rejected, then 500 twice: 3 attempts, retryable", async () => {
    const { t, calls, rows } = transcriber([json(400, { error: { message: "bad keywords[]" } }), json(500, {}), json(500, {})]);
    expect(await t.transcribe("u_1", oneSecond)).toMatchObject({ ok: false, retryable: true });
    expect(calls).toHaveLength(3);
    expect(rows[0]).toMatchObject({ attempts: 3 });
  });

  test("brackets rejected, then a 400 naming keywords again: the plain style is not re-triggered (2 attempts, not retryable)", async () => {
    const { t, calls } = transcriber([json(400, { error: { message: "bad keywords[]" } }), json(400, { error: { message: "bad keywords" } }), json(200, { text: "x" })]);
    expect(await t.transcribe("u_1", oneSecond)).toMatchObject({ ok: false, retryable: false });
    expect(calls).toHaveLength(2);
  });

  test("a 400 naming 'languages' also switches to the plain fields", async () => {
    const { t, calls } = transcriber([json(400, { error: { message: "Unknown parameter languages[]" } }), json(200, { text: "fine" })]);
    expect(await t.transcribe("u_1", oneSecond)).toMatchObject({ ok: true });
    expect((calls[1].init.body as FormData).getAll("languages")).toEqual(["en"]);
  });

  test("a 429 without quota text twice is retryable after 2 attempts", async () => {
    const { t, calls } = transcriber([json(429, { error: "slow down" }), json(429, { error: "slow down" })]);
    expect(await t.transcribe("u_1", oneSecond)).toMatchObject({ ok: false, retryable: true });
    expect(calls).toHaveLength(2);
  });

  test("a 5xx then success records one cost and logs 2 attempts", async () => {
    const { t, rows, b } = transcriber([json(502, {}), json(200, { text: "made it" })]);
    expect(await t.transcribe("u_1", oneSecond)).toMatchObject({ ok: true, text: "made it" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, attempts: 2 });
    expect(b.totals().transcription).toBeCloseTo(0.0045 / 60);
  });

  test("a non-Error thrown by fetch is stringified", async () => {
    const { t } = transcriber([() => { throw "socket hang up"; }, () => { throw "socket hang up"; }]);
    expect(await t.transcribe("u_1", oneSecond)).toEqual({ ok: false, error: "socket hang up", retryable: true });
  });

  test("an HTTP failure's message keeps only the first 300 characters of the body", async () => {
    const { t } = transcriber([() => new Response("x".repeat(1000), { status: 400 })]);
    const r = await t.transcribe("u_1", oneSecond);
    expect((r as { error: string }).error).toBe(`HTTP 400: ${"x".repeat(300)}`);
  });

  test("each request carries a timeout signal", async () => {
    const { t, calls } = transcriber([json(200, { text: "hello there" })]);
    await t.transcribe("u_1", oneSecond);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].init.method).toBe("POST");
  });

  test("a context prompt of '' is sent as '' (not the configured prompt)", async () => {
    const { t, calls } = transcriber([json(200, { text: "hello there" })]);
    await t.transcribe("u_1", oneSecond, { prompt: "" });
    expect((calls[0].init.body as FormData).get("prompt")).toBe("");
  });

  test("fixes apply before the filler check", async () => {
    const { t } = transcriber([json(200, { text: " yep " })], { fixes: [{ pattern: "yep", replace: "yeah" }] });
    expect(await t.transcribe("u_1", oneSecond)).toEqual({ ok: true, text: "yeah", filler: true });
  });

  test("the log row: kind, engine, utterance id, latency, rounded seconds, estimated, ISO time; error only on failure", async () => {
    const { t, rows } = transcriber([json(200, { text: "hello there" }), json(400, { error: "no" })]);
    await t.transcribe("u_1", new Float32Array(12_345));
    await t.transcribe("u_2", oneSecond);
    expect(rows[0]).toEqual({
      kind: "transcription", engine: "openai", utterance_id: "u_1", ok: true, latency_ms: expect.any(Number), attempts: 1,
      audio_seconds: 0.772, cost_usd: expect.any(Number), estimated: true, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
    });
    expect(rows[0].latency_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0]).not.toHaveProperty("error");
    expect(rows[1]).toMatchObject({ ok: false, cost_usd: 0, error: expect.stringMatching(/^HTTP 400/) });
  });

  test("buildForm with the plain style uses unbracketed names", () => {
    const t = new Transcriber(cfg.transcription, { fetch: fakeFetch([]).f, apiKey: "k", budget: budget(), log: () => {} });
    const form = t.buildForm(Buffer.alloc(44), "plain", { keywords: ["Nic"] });
    expect(form.getAll("keywords")).toEqual([...cfg.transcription.keywords, "Nic"]);
    expect(form.getAll("keywords[]")).toEqual([]);
    expect(form.getAll("languages")).toEqual(["en"]);
  });

  test.fails("BUG T2-L1: an invalid fix pattern fails the line once, without logging a second row for it", async () => {
    const { t, rows } = transcriber([json(200, { text: "hello there" })], { fixes: [{ pattern: "(unclosed", replace: "x" }] });
    const r = await t.transcribe("u_1", oneSecond);
    expect(r.ok).toBe(false);
    expect(rows).toHaveLength(1);
  });
});

describe("fillers and fixes", () => {
  test("isFiller: short text or a lone filler word, with trailing punctuation", () => {
    for (const t of ["", "hey", "yes.", "mm-hmm,", "  Okay!  ", "Right"]) expect(isFiller(t), t).toBe(true);
    for (const t of ["Right on", "okay then", "yes we can"]) expect(isFiller(t), t).toBe(false);
  });

  test("applyFixes applies each fix in order, on whole words only", () => {
    const fixes = [{ pattern: "jeff", replace: "Jev" }, { pattern: "Jev(?:s)?", replace: "JEV" }, { pattern: "gpt", replace: "GPT" }];
    expect(applyFixes("jeff, jeffs and gpts gpt", fixes)).toBe("JEV, jeffs and gpts GPT");
    expect(applyFixes("unchanged", [])).toBe("unchanged");
  });
});
