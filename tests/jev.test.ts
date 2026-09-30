import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import { Budget, BudgetExhaustedError } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import {
  backoffMs, classifyError, DECISIONS_URL, effectiveStatus, embeddedErrorCode, HttpError, JevClient, parseRetryAfter, requestHash,
  type JevCallRow, type JevPurpose,
} from "../src/jev/client.ts";
import type { QuestionSet } from "../src/jev/types.ts";
import { deferred, flushMicrotasks } from "./fakes/async.ts";
import { brokenBody, networkError } from "./fakes/responses.ts";

const cfg = loadConfig().app;
const QUESTIONS = { is_bug: { type: "noul" as const, instructions: "Is it a bug?" } };
const OK_BODY = {
  answers: { is_bug: { type: "noul", noul: 0.96 } },
  id: "gen-dec-1", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe",
  usage: { cost: 0.00002, input_tokens: 476, output_tokens: 70 },
};

type Fake = () => Response | Promise<Response>;
const res = (status: number, body: unknown, headers: Record<string, string> = {}): Fake =>
  () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const timeout: Fake = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };

function setup(responses: Fake[], budgetOpts: Partial<ConstructorParameters<typeof Budget>[0]> = {}) {
  const calls: RequestInit[] = [];
  const sleeps: number[] = [];
  const rows: JevCallRow[] = [];
  const exhausted: string[] = [];
  const budget = new Budget({ onExhausted: (e) => exhausted.push(e.cap), ...budgetOpts });
  const f = (async (url: string, init: RequestInit) => {
    expect(url).toBe(DECISIONS_URL);
    calls.push(init);
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return next();
  }) as unknown as typeof fetch;
  const client = new JevClient(cfg.jev, {
    fetch: f, apiKey: "sk-or-test", budget, log: (r) => rows.push(r),
    sleep: async (ms) => { sleeps.push(ms); }, rand: () => 0,
  });
  return { client, calls, sleeps, rows, budget, exhausted };
}

describe("Jev client", () => {
  test("success: request shape, answers, log row, budget", async () => {
    const { client, calls, rows, budget } = setup([res(200, "\n  " + JSON.stringify(OK_BODY))]);
    const r = await client.ask({ text: "hello" }, QUESTIONS, { purpose: "utterance", utterance_id: "u_1", question_set_version: "s1@1" });
    expect(r.answers.is_bug).toEqual({ type: "noul", noul: 0.96 });
    expect(r.model).toBe("typesafe/jev-1.13-20260917");
    const headers = calls[0].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    expect(headers["X-OpenRouter-Title"]).toBe("Tattle");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      model: "typesafe/jev-1.13", state: { text: "hello" }, questions: QUESTIONS, provider: { data_collection: "deny" },
    });
    expect(rows[0]).toMatchObject({
      kind: "jev_call", purpose: "utterance", utterance_id: "u_1", ok: true, attempts: 1, id: "gen-dec-1",
      model_returned: "typesafe/jev-1.13-20260917", provider_returned: "TypeSafe", cost_usd: 0.00002,
      question_ids: ["is_bug"], question_set_version: "s1@1", state: { text: "hello" },
    });
    expect(rows[0].request_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(budget.totals().jev).toBeCloseTo(0.00002);
  });

  test("a 429 then success on a background purpose waits out the backoff", async () => {
    const { client, calls, sleeps, rows } = setup([res(429, { error: { code: 429, message: "slow down" } }), res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "relabel" });
    expect(calls.length).toBe(2);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(1500);
    expect(rows[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  test("a 429 on a live purpose goes straight to the fallback and sets the shared pause", async () => {
    const { client, calls, sleeps, rows } = setup([res(429, { error: { code: 429 } }, { "retry-after": "7" })]);
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect(rows[0]).toMatchObject({ ok: false, attempts: 1 });
    expect(client.pausedUntil - Date.now()).toBeGreaterThan(6000);
  });

  test("a live 5xx is retried once, immediately", async () => {
    const { client, calls, sleeps } = setup([res(502, "bad gateway"), res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "segment" });
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([]);
  });

  test("a 400 fails immediately", async () => {
    const { client, calls } = setup([res(400, { error: { code: 400, message: "bad question" } })]);
    await expect(client.ask({}, QUESTIONS, { purpose: "relabel" })).rejects.toThrow(/400/);
    expect(calls.length).toBe(1);
  });

  test("a timeout is retried, then fails after maxAttempts on a live purpose", async () => {
    const { client, calls, rows } = setup([timeout, timeout, res(200, OK_BODY)]);
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toThrow(/timeout/i);
    expect(calls.length).toBe(2);
    expect(rows[0]).toMatchObject({ ok: false, attempts: 2 });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  test("a 2xx with an error body is retried", async () => {
    const { client, calls } = setup([res(200, "   " + JSON.stringify({ error: { message: "upstream died" } })), res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "gate" });
    expect(calls.length).toBe(2);
  });

  test("a response without usage.cost is rejected, not retried", async () => {
    const { client, calls } = setup([res(200, { ...OK_BODY, usage: { input_tokens: 1, output_tokens: 1 } }), res(200, OK_BODY)]);
    await expect(client.ask({}, QUESTIONS, { purpose: "relabel" })).rejects.toThrow(/usage.cost/);
    expect(calls.length).toBe(1);
  });

  test("retry-after in seconds and as an HTTP date", async () => {
    const now = Date.parse("2026-09-24T10:00:00Z");
    expect(parseRetryAfter("3", now)).toBe(3000);
    expect(parseRetryAfter("Thu, 24 Sep 2026 10:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(backoffMs(1, 3000, () => 0)).toBe(3000);
    expect(backoffMs(3, null, () => 0.999)).toBe(8000 + 499);
    expect(backoffMs(10, null, () => 0)).toBe(30_000);

    const date = new Date(Date.now() + 4000).toUTCString();
    const { client, sleeps } = setup([res(429, {}, { "retry-after": date }), res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "relabel" });
    expect(sleeps[0]).toBeGreaterThan(2000);
    expect(sleeps[0]).toBeLessThanOrEqual(4000);
  });

  test("error classification", () => {
    expect(classifyError(new HttpError(null, "net"))).toBe("retry");
    expect(classifyError(new HttpError(524, ""))).toBe("retry");
    expect(classifyError(new HttpError(402, JSON.stringify({ error: { metadata: { limit_source: "openrouter_in_flight_budget" } } })))).toBe("retry");
    expect(classifyError(new HttpError(402, JSON.stringify({ error: { message: "no credits" } })))).toBe("fail");
    expect(classifyError(new HttpError(200, JSON.stringify({ error: { code: 400 } })))).toBe("fail");
    for (const s of [401, 403, 404, 413, -1]) expect(classifyError(new HttpError(s, ""))).toBe("fail");
  });

  test("a non-transient 402 exhausts the budget", async () => {
    const { client, exhausted, budget } = setup([res(402, { error: { code: 402, message: "no credits" } })]);
    await expect(client.ask({}, QUESTIONS, { purpose: "relabel" })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(exhausted).toEqual(["provider"]);
    expect(budget.isExhausted).toBe(true);
  });

  test("once OpenRouter said the credit is used up, later calls never reach the network", async () => {
    const { client, calls, budget } = setup([res(402, { error: { code: 402, message: "no credits" } }), res(200, OK_BODY)]);
    await expect(client.ask({}, QUESTIONS, { purpose: "relabel" })).rejects.toBeInstanceOf(BudgetExhaustedError);
    const sent = calls.length;
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(calls.length).toBe(sent);
    expect(budget.isExhausted).toBe(true);
  });

  test("the app sets no dollar limit: a session that has spent a lot still calls Jev", async () => {
    const { client, budget } = setup([res(200, OK_BODY)]);
    budget.record("jev", 1_000);
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).resolves.toBeDefined();
  });
});

/** A client with every seam exposed: config overrides, onStart, the question set passed to log. */
function rig(responses: Fake[], o: { jev?: Partial<typeof cfg.jev>; sleep?: boolean; budget?: Budget } = {}) {
  const calls: RequestInit[] = [];
  const sleeps: number[] = [];
  const rows: JevCallRow[] = [];
  const logged: (QuestionSet | undefined)[] = [];
  const starts: JevPurpose[] = [];
  const budget = o.budget ?? new Budget();
  const f = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return next();
  }) as unknown as typeof fetch;
  const client = new JevClient({ ...cfg.jev, ...o.jev }, {
    fetch: f, apiKey: "sk-or-test", budget, log: (r, q) => { rows.push(r); logged.push(q); },
    onStart: (p) => starts.push(p),
    ...(o.sleep === false ? {} : { sleep: async (ms: number) => { sleeps.push(ms); } }),
    rand: () => 0,
  });
  return { client, calls, sleeps, rows, logged, starts, budget };
}

const T0 = Date.parse("2026-09-30T10:00:00Z");
const transient402 = res(402, { error: { code: 402, message: "busy", metadata: { limit_source: "openrouter_in_flight_budget" } } });

describe("Jev client: backoff and the shared pause", () => {
  afterEach(() => { vi.useRealTimers(); });
  const frozen = () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); };

  it("background 5xx x5 fails after backgroundMaxAttempts=5 with sleeps [2000, 4000, 8000, 16000] (rand 0, Date frozen)", async () => {
    frozen();
    const { client, calls, sleeps, rows } = rig([res(500, "a"), res(502, "b"), res(503, "c"), res(504, "d"), res(500, "e"), res(200, OK_BODY)]);
    await expect(client.ask({}, QUESTIONS, { purpose: "relabel" })).rejects.toThrow(/HTTP 500 e/);
    expect(calls.length).toBe(5);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, attempts: 5, error: "HTTP 500 e" });
    expect(client.pausedUntil).toBe(T0 + 16000); // the failed last attempt set no new pause
  });

  it("backoff is capped at 30000 ms for attempt >= 5, and adds up to 499 ms of jitter", () => {
    expect(backoffMs(4, null, () => 0)).toBe(16_000);
    expect(backoffMs(5, null, () => 0)).toBe(30_000);
    expect(backoffMs(12, null, () => 0.5)).toBe(30_250);
    expect(backoffMs(1, 0, () => 0)).toBe(0); // a retry-after of 0 waits nothing, not the default
    const d = backoffMs(1, null); // default rand: Math.random
    expect(d).toBeGreaterThanOrEqual(2000);
    expect(d).toBeLessThan(2500);
  });

  it("a live call made while paused does not wait; a background call made while paused sleeps the remaining pause first", async () => {
    frozen();
    const { client, sleeps, calls } = rig([res(429, { error: { code: 429 } }, { "retry-after": "7" }), res(200, OK_BODY), res(200, OK_BODY)]);
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toBeInstanceOf(HttpError);
    expect(client.pausedUntil).toBe(T0 + 7000);
    await client.ask({}, QUESTIONS, { purpose: "segment" }); // live: no wait
    expect(sleeps).toEqual([]);
    vi.setSystemTime(T0 + 2000);
    await client.ask({}, QUESTIONS, { purpose: "relabel" });
    expect(sleeps).toEqual([5000]);
    expect(calls.length).toBe(3);
  });

  it("a transient 402 on a live purpose fails at once without exhausting the budget, and sets the pause", async () => {
    frozen();
    const { client, calls, budget, rows } = rig([transient402, res(200, OK_BODY)]);
    const err = await client.ask({}, QUESTIONS, { purpose: "utterance" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(402);
    expect(calls.length).toBe(1);
    expect(budget.isExhausted).toBe(false);
    expect(client.pausedUntil).toBe(T0 + 2000);
    expect(rows[0]).toMatchObject({ ok: false, attempts: 1 });
  });

  it("a transient 402 on a background purpose is retried after the pause", async () => {
    frozen();
    const { client, calls, sleeps, budget, rows } = rig([transient402, res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "gate" });
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(budget.isExhausted).toBe(false);
    expect(rows[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  it("the pause only moves forward: a shorter backoff never shortens it", async () => {
    frozen();
    const { client, sleeps } = rig([res(429, {}, { "retry-after": "20" }), res(429, {}, { "retry-after": "1" }), res(200, OK_BODY)]);
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toBeInstanceOf(HttpError);
    await expect(client.ask({}, QUESTIONS, { purpose: "segment" })).rejects.toBeInstanceOf(HttpError);
    expect(client.pausedUntil).toBe(T0 + 20_000);
    await client.ask({}, QUESTIONS, { purpose: "relabel" });
    expect(sleeps).toEqual([20_000]);
  });

  it("without an injected sleep, a background retry waits on a real timer", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(T0);
    const { client, calls } = rig([res(503, "down"), res(200, OK_BODY)], { sleep: false });
    let done = false;
    const p = client.ask({}, QUESTIONS, { purpose: "relabel" }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls.length).toBe(1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(calls.length).toBe(2);
  });
});

describe("Jev client: error classes and responses", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("401 is rethrown as HttpError status 401 with a message naming OPENROUTER_API_KEY, never retried", async () => {
    const { client, calls, rows } = rig([res(401, { error: { code: 401, message: "No auth credentials found" } }), res(200, OK_BODY)]);
    const err = await client.ask({}, QUESTIONS, { purpose: "relabel" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("OpenRouter rejected the API key (401): check OPENROUTER_API_KEY");
    expect(err.body).toContain("No auth credentials found");
    expect(calls.length).toBe(1);
    expect(rows[0].error).toMatch(/^HTTP 401 /); // the row keeps the service's own words
  });

  it("403/404/413 fail on the first attempt and set no pause", async () => {
    for (const status of [403, 404, 413]) {
      const { client, calls, sleeps } = rig([res(status, { error: { code: status } }), res(200, OK_BODY)]);
      await expect(client.ask({}, QUESTIONS, { purpose: "relabel" })).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(calls.length).toBe(1);
      expect(sleeps).toEqual([]);
      expect(client.pausedUntil).toBe(0);
    }
  });

  it("a 2xx body with embedded code 429 pauses; embedded 400 fails; an embedded code as a string is retried", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const a = rig([res(200, { error: { code: 429, message: "slow" } }), res(200, OK_BODY)]);
    await a.client.ask({}, QUESTIONS, { purpose: "utterance" }).catch(() => undefined);
    expect(a.calls.length).toBe(1); // live: a pausing error goes to the fallback
    expect(a.client.pausedUntil).toBe(T0 + 2000);

    const b = rig([res(200, { error: { code: 400, message: "bad" } }), res(200, OK_BODY)]);
    await expect(b.client.ask({}, QUESTIONS, { purpose: "relabel" })).rejects.toThrow(/HTTP 200/);
    expect(b.calls.length).toBe(1);

    const c = rig([res(200, { error: { code: "429", message: "?" } }), res(200, OK_BODY)]);
    await c.client.ask({}, QUESTIONS, { purpose: "utterance" });
    expect(c.calls.length).toBe(2); // no usable code: retried like a no-status failure, immediately
    expect(c.client.pausedUntil).toBe(0);
  });

  it("a non-JSON 200 body ('<html>') and truncated JSON are retried as 2xx errors without a code", async () => {
    const { client, calls, rows } = rig([res(200, "<html>gateway</html>"), res(200, '{"answers":'), res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "relabel" });
    expect(calls.length).toBe(3);
    expect(rows[0]).toMatchObject({ ok: true, attempts: 3 });
  });

  it("a body stream that errors while reading is treated as no status, and retried", async () => {
    const { client, calls } = rig([() => brokenBody(), res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "utterance" });
    expect(calls.length).toBe(2);
  });

  it("a network TypeError ('fetch failed') becomes HttpError(null) and is retried; the row names it", async () => {
    const { client, calls, rows } = rig([() => { throw networkError(); }, () => { throw networkError(); }]);
    const err = await client.ask({}, QUESTIONS, { purpose: "segment" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBeNull();
    expect(err.message).toBe("TypeError: fetch failed");
    expect(calls.length).toBe(2);
    expect(rows[0]).toMatchObject({ ok: false, attempts: 2, error: "TypeError: fetch failed" });
  });

  it("a fetch that rejects with a non-Error value is still a no-status failure", async () => {
    const { client, rows } = rig([() => Promise.reject("socket hang up"), () => Promise.reject("socket hang up")]);
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toThrow("socket hang up");
    expect(rows[0].error).toBe("socket hang up");
  });

  it("missing answers/id/provider/input_tokens default to {}/null/null/0", async () => {
    const { client, rows } = rig([res(200, { model: "typesafe/jev-1.13-x", usage: { cost: 0.00001 } })]);
    const r = await client.ask({}, QUESTIONS, { purpose: "utterance" });
    expect(r).toEqual({ answers: {}, id: null, model: "typesafe/jev-1.13-x", provider: null, usage: { input_tokens: 0, output_tokens: 0, cost: 0.00001 } });
    expect(rows[0]).toMatchObject({ id: null, provider_returned: null, answers: {} });
  });

  it("the request omits provider when the config has none", async () => {
    const { client, calls } = rig([res(200, OK_BODY)], { jev: { provider: undefined } });
    await client.ask({ x: 1 }, QUESTIONS, { purpose: "utterance" });
    expect(JSON.parse(calls[0].body as string)).toEqual({ model: "typesafe/jev-1.13", state: { x: 1 }, questions: QUESTIONS });
    expect(calls[0].method).toBe("POST");
    expect((calls[0].headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("uses utteranceTimeoutMs/segmentTimeoutMs/backgroundTimeoutMs and the meta.timeoutMs override", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const { client } = rig([res(200, OK_BODY), res(200, OK_BODY), res(200, OK_BODY), res(200, OK_BODY), res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "utterance" });
    await client.ask({}, QUESTIONS, { purpose: "segment" });
    await client.ask({}, QUESTIONS, { purpose: "relabel" });
    await client.ask({}, QUESTIONS, { purpose: "try" });
    await client.ask({}, QUESTIONS, { purpose: "smoke", timeoutMs: 1234 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([3000, 5000, 30_000, 30_000, 1234]);
  });

  it("meta.maxAttempts and meta.live override the purpose defaults", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    // maxAttempts 1 on a background purpose: no retry at all
    const a = rig([res(500, "x"), res(200, OK_BODY)]);
    await expect(a.client.ask({}, QUESTIONS, { purpose: "relabel", maxAttempts: 1 })).rejects.toThrow(/500/);
    expect(a.calls.length).toBe(1);
    // live:true on smoke: does not wait out the pause and does not retry a 429
    const b = rig([res(429, {}, { "retry-after": "9" }), res(200, OK_BODY), res(429, {}), res(200, OK_BODY)]);
    await expect(b.client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toBeInstanceOf(HttpError);
    await b.client.ask({}, QUESTIONS, { purpose: "smoke", live: true });
    await expect(b.client.ask({}, QUESTIONS, { purpose: "smoke", live: true })).rejects.toBeInstanceOf(HttpError);
    expect(b.sleeps).toEqual([]);
    expect(b.calls.length).toBe(3);
    // live:false on utterance: waits out the pause and uses the background attempts
    const c = rig([res(500, "x"), res(500, "x"), res(500, "x"), res(200, OK_BODY)]);
    await c.client.ask({}, QUESTIONS, { purpose: "utterance", live: false });
    expect(c.calls.length).toBe(4);
    expect(c.sleeps).toEqual([2000, 4000, 8000]);
  });
});

describe("Jev client: budget, onStart and the call log", () => {
  it("a budget refusal logs a row with ok:false, attempts:0 and the error, never calls onStart or the network", async () => {
    const budget = new Budget();
    expect(() => budget.exhaust("provider", "jev:relabel", "OpenRouter credits or key limit exhausted (402)")).toThrow();
    const { client, calls, rows, starts } = rig([res(200, OK_BODY)], { budget });
    await expect(client.ask({ s: 1 }, QUESTIONS, { purpose: "segment", segment_id: "seg_3" })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toEqual([]);
    expect(starts).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "segment", segment_id: "seg_3", ok: false, attempts: 0, cost_usd: 0, answers: null, usage: null, id: null,
      error: "Error: OpenRouter credits or key limit exhausted (402)",
    });
  });

  it("onStart is called once per ask, with the purpose, after the budget check, even across retries", async () => {
    const { client, starts, calls } = rig([res(502, "x"), res(200, OK_BODY), res(200, OK_BODY)]);
    await client.ask({}, QUESTIONS, { purpose: "segment" });
    await client.ask({}, QUESTIONS, { purpose: "gate" });
    expect(calls.length).toBe(3);
    expect(starts).toEqual(["segment", "gate"]);
  });

  it("log receives the question set as its second argument; the row omits utterance_id/segment_id/error when absent", async () => {
    const { client, rows, logged } = rig([res(200, OK_BODY)]);
    await client.ask({ a: 1 }, QUESTIONS, { purpose: "relabel" });
    expect(logged[0]).toBe(QUESTIONS);
    expect(rows[0]).not.toHaveProperty("utterance_id");
    expect(rows[0]).not.toHaveProperty("segment_id");
    expect(rows[0]).not.toHaveProperty("error");
    expect(rows[0].question_set_version).toBeNull();
    expect(rows[0].request_hash).toBe(requestHash("typesafe/jev-1.13", { a: 1 }, QUESTIONS));
    expect(rows[0].usage).toEqual({ input_tokens: 476, output_tokens: 70, cost: 0.00002 });
    expect(Date.parse(rows[0].at)).not.toBeNaN();
    expect(rows[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("a cost of 0 is not recorded in the budget", async () => {
    const costs: number[] = [];
    const budget = new Budget({ onCost: (t) => costs.push(t.jev) });
    const { client } = rig([res(200, { ...OK_BODY, usage: { cost: 0 } })], { budget });
    await client.ask({}, QUESTIONS, { purpose: "utterance" });
    expect(budget.totals().jev).toBe(0);
    expect(costs).toEqual([]);
  });

  it("requestHash is stable for equal inputs and differs by model, state and questions", () => {
    const h = requestHash("m", { a: 1 }, QUESTIONS);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(requestHash("m", { a: 1 }, QUESTIONS)).toBe(h);
    expect(requestHash("m2", { a: 1 }, QUESTIONS)).not.toBe(h);
    expect(requestHash("m", { a: 2 }, QUESTIONS)).not.toBe(h);
    expect(requestHash("m", { a: 1 }, { other: QUESTIONS.is_bug })).not.toBe(h);
  });
});

describe("Jev client: shared concurrency", () => {
  it("with concurrency 1, a queued live call runs before an earlier-queued background call", async () => {
    const first = deferred<Response>();
    const order: string[] = [];
    const responses: Fake[] = [() => first.promise, res(200, OK_BODY), res(200, OK_BODY)];
    const { client, calls } = rig(responses, { jev: { concurrency: 1 } });
    const a = client.ask({ n: "first" }, QUESTIONS, { purpose: "relabel" }).then(() => order.push("first"));
    await flushMicrotasks();
    const bg = client.ask({ n: "background" }, QUESTIONS, { purpose: "relabel" }).then(() => order.push("background"));
    const live = client.ask({ n: "live" }, QUESTIONS, { purpose: "utterance" }).then(() => order.push("live"));
    await flushMicrotasks();
    expect(calls.length).toBe(1); // the others wait for the slot
    first.resolve(new Response(JSON.stringify(OK_BODY)));
    await Promise.all([a, bg, live]);
    expect(calls.map((c) => JSON.parse(c.body as string).state.n)).toEqual(["first", "live", "background"]);
    expect(order).toEqual(["first", "live", "background"]);
  });

  it("release frees the slot after a failure, so the next queued call proceeds", async () => {
    const first = deferred<Response>();
    const { client, calls } = rig([() => first.promise, res(200, OK_BODY), res(200, OK_BODY)], { jev: { concurrency: 1 } });
    const a = client.ask({}, QUESTIONS, { purpose: "relabel" });
    await flushMicrotasks();
    const b = client.ask({}, QUESTIONS, { purpose: "relabel" });
    first.resolve(new Response(JSON.stringify({ error: { code: 400 } }), { status: 400 }));
    await expect(a).rejects.toThrow(/400/);
    await expect(b).resolves.toBeDefined();
    await expect(client.ask({}, QUESTIONS, { purpose: "relabel" })).resolves.toBeDefined(); // the slot came back
    expect(calls.length).toBe(3);
  });
});

describe("Jev client: helpers", () => {
  it("embeddedErrorCode returns null for no '{', invalid JSON, a code < 400, a non-number code", () => {
    expect(embeddedErrorCode("upstream failed")).toBeNull();
    expect(embeddedErrorCode("{not json")).toBeNull();
    expect(embeddedErrorCode(JSON.stringify({ error: { code: 200 } }))).toBeNull();
    expect(embeddedErrorCode(JSON.stringify({ error: { code: "502" } }))).toBeNull();
    expect(embeddedErrorCode(JSON.stringify({ error: {} }))).toBeNull();
    expect(embeddedErrorCode("  \n" + JSON.stringify({ error: { code: 502 } }))).toBe(502);
  });

  it("effectiveStatus returns the embedded code for 2xx and the raw status otherwise", () => {
    expect(effectiveStatus(new HttpError(200, JSON.stringify({ error: { code: 429 } })))).toBe(429);
    expect(effectiveStatus(new HttpError(204, "no body"))).toBeNull();
    expect(effectiveStatus(new HttpError(500, JSON.stringify({ error: { code: 429 } })))).toBe(500);
    expect(effectiveStatus(new HttpError(null, "net"))).toBeNull();
  });

  it("classifyError: a non-HttpError fails; a 402 body that is not JSON fails", () => {
    expect(classifyError(new Error("boom"))).toBe("fail");
    expect(classifyError("boom")).toBe("fail");
    expect(classifyError(new HttpError(402, "no json here"))).toBe("fail");
    expect(classifyError(new HttpError(402, "{broken"))).toBe("fail");
    expect(classifyError(new HttpError(429, ""))).toBe("retry");
    expect(classifyError(new HttpError(200, JSON.stringify({ error: { code: 503 } })))).toBe("retry");
  });

  it("parseRetryAfter: '0' → 0, a past date → null, garbage → null; a negative number passes through", () => {
    const now = Date.parse("2026-09-24T10:00:00Z");
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("1.5", now)).toBe(1500);
    expect(parseRetryAfter("Thu, 24 Sep 2026 09:59:00 GMT", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBe(-5000); // documents: an invalid negative header gives a negative delay (no wait)
    expect(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000); // default now
  });

  it("HttpError's default message: a null status uses the body; else 'HTTP <s> <body[0:300]>'", () => {
    expect(new HttpError(null, "fetch failed").message).toBe("fetch failed");
    expect(new HttpError(500, "").message).toBe("HTTP 500");
    expect(new HttpError(502, "x".repeat(400)).message).toBe(`HTTP 502 ${"x".repeat(300)}`);
    expect(new HttpError(401, "b", null, "custom").message).toBe("custom");
    expect(new HttpError(429, "b", 7000).retryAfterMs).toBe(7000);
  });
});
