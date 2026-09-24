import { describe, expect, test } from "vitest";
import { Budget } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { applyFixes, isFiller, Transcriber, TRANSCRIBE_URL, type TranscriptionRow } from "../src/transcribe/openai.ts";

const cfg = loadConfig().app;

function budget() {
  return new Budget({ sessionCapUsd: 5, devCapUsd: 3, enforceDevCap: true, devSpentUsd: 0 });
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

  test("refuses when the budget is exhausted", async () => {
    const b = new Budget({ sessionCapUsd: 0.000001, devCapUsd: 3, enforceDevCap: true, devSpentUsd: 0 });
    b.record("jev", 0.01);
    const t = new Transcriber(cfg.transcription, { fetch: fakeFetch([]).f, apiKey: "k", budget: b, log: () => {} });
    await expect(t.transcribe("u_1", oneSecond)).rejects.toThrow(/cap/);
  });
});
