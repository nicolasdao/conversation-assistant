import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Budget, BudgetExhaustedError, sumDevSpend } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { backoffMs, classifyError, DECISIONS_URL, HttpError, JevClient, parseRetryAfter, type JevCallRow } from "../src/jev/client.ts";

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
  const budget = new Budget({
    sessionCapUsd: 5, devCapUsd: 3, enforceDevCap: true, devSpentUsd: 0, onExhausted: (e) => exhausted.push(e.cap), ...budgetOpts,
  });
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
    expect(headers["X-OpenRouter-Title"]).toBe("Podcast Assistant");
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

  test("a call refused by the budget never reaches the network", async () => {
    const { client, calls, exhausted } = setup([res(200, OK_BODY)], { devSpentUsd: 3.01 });
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(calls.length).toBe(0);
    expect(exhausted).toEqual(["dev"]);
  });

  test("live sessions ignore the dev cap", async () => {
    const { client } = setup([res(200, OK_BODY)], { devSpentUsd: 3.01, enforceDevCap: false });
    await expect(client.ask({}, QUESTIONS, { purpose: "utterance" })).resolves.toBeDefined();
  });

  test("the dev total is summed from existing session files, call rows only", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "smoke-20260924-100000"));
    writeFileSync(join(dir, "a", "jev_calls.jsonl"), [
      JSON.stringify({ kind: "jev_call", cost_usd: 0.25 }),
      JSON.stringify({ kind: "jev_call", cost_usd: 0.5 }),
      "",
    ].join("\n"));
    writeFileSync(join(dir, "a", "events.jsonl"), JSON.stringify({ kind: "cost", cost_usd: 99 }) + "\n");
    writeFileSync(join(dir, "smoke-20260924-100000", "s2_calls.jsonl"),
      JSON.stringify({ kind: "s2_call", cost_usd: 1 }) + "\n" + JSON.stringify({ kind: "transcription", cost_usd: 0.125 }) + "\n{torn");
    expect(sumDevSpend(dir)).toBeCloseTo(1.875);
    expect(sumDevSpend(join(dir, "missing"))).toBe(0);
  });
});
