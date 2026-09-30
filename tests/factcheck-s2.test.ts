import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget, BudgetExhaustedError } from "../src/budget.ts";
import {
  AUDIT_JSON_SCHEMA, AuditSchema, CHAT_URL, citationsOf, ContentError, finalizeVerdict, gradeOf, parseContent, researchSystemPrompt,
  REWRITE_JSON_SCHEMA, S2Client, stripCitations, truncateWords, VERDICT_JSON_SCHEMA, VerdictSchema, type S2CallRow, type S2Purpose,
} from "../src/factcheck/s2.ts";
import { HttpError } from "../src/jev/client.ts";
import { fcConfig as cfg, VERDICT } from "./fakes/factcheck.ts";

const T0 = Date.parse("2026-09-30T10:00:00Z");

describe("System 2's verdict helpers", () => {
  it("citationsOf: non-array → []; skips non url_citation and a missing url; a non-string title → the url", () => {
    expect(citationsOf(undefined)).toEqual([]);
    expect(citationsOf({ type: "url_citation" })).toEqual([]);
    expect(citationsOf([
      null, { type: "file_citation", url_citation: { url: "https://x" } }, { type: "url_citation" }, { type: "url_citation", url_citation: { url: 5 } },
      { type: "url_citation", url_citation: { url: "https://a", title: 7 } }, { type: "url_citation", url_citation: { url: "https://b", title: "B" } },
    ])).toEqual([{ url: "https://a", title: "https://a" }, { url: "https://b", title: "B" }]);
  });

  it("truncateWords keeps the original spacing when within n words, and joins with single spaces when truncating", () => {
    expect(truncateWords("  a  b\tc  ", 3)).toBe("a  b\tc");
    expect(truncateWords("a  b\tc d", 3)).toBe("a b c");
    expect(truncateWords("", 3)).toBe("");
  });

  it("stripCitations: a parenthesised cite, a ';'-separated group, a bare [t](u), a space before punctuation, double spaces", () => {
    expect(stripCitations("Prices fell ([site](https://s.com/a)).")).toBe("Prices fell.");
    expect(stripCitations("Two ([a](https://a.com); [b](https://b.com)) sources.")).toBe("Two sources.");
    expect(stripCitations("See [the post](https://p.com/x) today")).toBe("See the post today");
    expect(stripCitations("Odd  spacing , here ; there : done .")).toBe("Odd spacing, here; there: done.");
    expect(stripCitations("  no citations  ")).toBe("no citations");
  });

  it.fails("BUG S2-L1: a citation whose URL contains parentheses leaves a stray ')'", () => {
    // Wikipedia-style URLs such as https://en.wikipedia.org/wiki/Her_(film) are common in the web plugin's citations.
    expect(stripCitations("It won an Oscar ([wiki](https://en.wikipedia.org/wiki/Her_(film))).")).toBe("It won an Oscar.");
  });

  it("finalizeVerdict: an empty title → the hostname without www; an unparsable https url keeps the url as title; HTTPS in capitals is kept; an empty url is skipped", () => {
    const v = finalizeVerdict({
      ...VERDICT(),
      sources: [
        { url: "https://www.example.com/a", title: "" }, { url: "https://", title: "https://" }, { url: "HTTPS://CAPS.example/x", title: "Caps" },
        { url: "", title: "nothing" },
      ],
    }, []);
    expect(v.sources).toEqual([{ url: "https://www.example.com/a", title: "example.com" }, { url: "https://", title: "https://" }, { url: "HTTPS://CAPS.example/x", title: "Caps" }]);
  });

  it("finalizeVerdict: unverifiable with no sources is not downgraded; citations are stripped before the 200-character cut", () => {
    expect(finalizeVerdict({ ...VERDICT({ verdict: "unverifiable" }), sources: [] }, null)).toMatchObject({ verdict: "unverifiable", downgraded: false });
    const cite = "([s](https://s.example/" + "p".repeat(300) + "))";
    const v = finalizeVerdict({ ...VERDICT(), restated_claim: `${"x".repeat(150)} ${cite}` }, []);
    expect(v.restated_claim).toBe("x".repeat(150));
  });

  it("gradeOf: a supported verdict with reason 'private' is a false alarm", () => {
    expect(gradeOf({ verdict: "supported", false_alarm_reason: "private" })).toBe("false_alarm");
    expect(gradeOf({ verdict: "misleading", false_alarm_reason: "none" })).toBe("good_flag");
    expect(gradeOf({ verdict: "unverifiable", false_alarm_reason: "none" })).toBe("good_flag");
  });

  it("parseContent: prose around the JSON parses; '{bad' → invalid JSON; no braces → no JSON object", () => {
    expect(parseContent('Here you go: {"items": []} hope that helps', AuditSchema)).toEqual({ items: [] });
    expect(() => parseContent("{bad}", AuditSchema)).toThrow(/^invalid JSON in the reply: /);
    expect(() => parseContent("no json here", AuditSchema)).toThrow("no JSON object in the reply: no json here");
    expect(() => parseContent("} backwards {", AuditSchema)).toThrow(ContentError);
    expect(() => parseContent("x".repeat(300), AuditSchema)).toThrow(`no JSON object in the reply: ${"x".repeat(200)}`);
  });

  it("the strict JSON schemas list every property as required and allow no others", () => {
    const check = (s: any) => {
      if (s?.type === "object" || (Array.isArray(s?.type) && s.type.includes("object"))) {
        expect(s.additionalProperties).toBe(false);
        expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
        for (const p of Object.values(s.properties)) check(p);
      }
      if (s?.items) check(s.items);
    };
    for (const s of [VERDICT_JSON_SCHEMA, AUDIT_JSON_SCHEMA, REWRITE_JSON_SCHEMA]) check(s);
    expect(VERDICT_JSON_SCHEMA.properties.false_alarm_reason.enum).toContain("private");
  });

  it("the research prompt carries the date and the private-lives rule", () => {
    const p = researchSystemPrompt("1 October 2026");
    expect(p).toContain("Today is 1 October 2026.");
    expect(p).toContain("false_alarm_reason private");
  });
});

// ---------- the client ----------

type Fake = () => Response | Promise<Response>;
const body = (content: unknown, o: { usage?: Record<string, unknown>; annotations?: unknown[]; message?: Record<string, unknown> } = {}) => JSON.stringify({
  id: "gen-1", model: "openai/gpt-6-luna-20260601", provider: "OpenAI",
  choices: [{ message: o.message ?? { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content), annotations: o.annotations ?? [] } }],
  usage: o.usage ?? { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 }, prompt_tokens_details: { cached_tokens: 10 }, cost: 0.001 },
});
const ok = (content: unknown, o: Parameters<typeof body>[1] = {}): Fake => () => new Response(body(content, o));
const err = (status: number, error: Record<string, unknown> = {}, headers: Record<string, string> = {}): Fake =>
  () => new Response(JSON.stringify({ error: { code: status, message: "e", ...error } }), { status, headers });

function client(responses: Fake[], o: { budget?: Budget; sleep?: boolean; today?: boolean } = {}) {
  const bodies: any[] = [];
  const inits: RequestInit[] = [];
  const rows: S2CallRow[] = [];
  const sleeps: number[] = [];
  const starts: S2Purpose[] = [];
  const budget = o.budget ?? new Budget();
  const f = (async (url: string, init: RequestInit) => {
    expect(url).toBe(CHAT_URL);
    inits.push(init);
    bodies.push(JSON.parse(init.body as string));
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return next();
  }) as unknown as typeof fetch;
  const c = new S2Client(cfg.app.s2, {
    fetch: f, apiKey: "sk-or-k", budget, log: (r) => rows.push(r), onStart: (p) => starts.push(p), rand: () => 0,
    ...(o.sleep === false ? {} : { sleep: async (ms: number) => { sleeps.push(ms); } }),
    ...(o.today === false ? {} : { today: () => "24 September 2026" }),
  });
  return { c, bodies, inits, rows, sleeps, starts, budget };
}
const input = { claim_id: "c_1", speaker: "Anna", utterance: "Jev is 445 times cheaper", segment: "Anna: Jev is 445 times cheaper" };
const badRequest = err(400, { message: "json_schema not supported with plugins" });

describe("S2Client: requests", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("the default today() formats the date en-GB as 'D Month YYYY'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { c, bodies } = client([ok(VERDICT())], { today: false });
    await c.research(input);
    const expected = new Date(T0).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    expect(expected).toMatch(/^30 September 2026$/);
    expect(bodies[0].messages[0].content).toContain(`Today is ${expected}.`);
  });

  it("research sends only the last 1500 characters of the segment, and the headers and timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { c, bodies, inits } = client([ok(VERDICT())]);
    await c.research({ ...input, segment: "a".repeat(500) + "b".repeat(1500) });
    expect(bodies[0].messages[1].content).toBe(`Speaker: Anna\nUtterance: Jev is 445 times cheaper\nCurrent segment (context only): ${"b".repeat(1500)}`);
    expect(inits[0].headers).toEqual({ Authorization: "Bearer sk-or-k", "Content-Type": "application/json", "X-OpenRouter-Title": "Tattle" });
    expect(inits[0].method).toBe("POST");
    expect(timeout.mock.calls.map((x) => x[0])).toEqual([90_000]);
  });

  it("research with another web engine sends that engine (smoke check 5's native run)", async () => {
    const { c, bodies, rows } = client([ok(VERDICT())]);
    await c.research(input, { engine: "native", max_results: 3 });
    expect(bodies[0].plugins).toEqual([{ id: "web", engine: "native", max_results: 3 }]);
    expect(rows[0]!.web_engine).toBe("native");
  });

  it("the fallback body: provider.require_parameters false, the schema suffix on the user message (not in the row), json_object", async () => {
    const { c, bodies, rows } = client([badRequest, ok(VERDICT())]);
    await c.research(input);
    const fb = bodies[1];
    expect(fb.provider).toEqual({ ...cfg.app.s2.provider, require_parameters: false });
    expect(fb.response_format).toEqual({ type: "json_object" });
    expect(fb.plugins).toEqual([{ id: "web", engine: "exa", max_results: 5 }]);
    expect(fb.messages[1].content).toBe(`${bodies[0].messages[1].content}\n\nReply with one JSON object only, matching this JSON schema:\n${JSON.stringify(VERDICT_JSON_SCHEMA)}`);
    expect(rows.map((r) => [r.ok, r.response_format])).toEqual([[false, "json_schema"], [true, "json_object"]]);
    expect(rows[1].request!.user).toBe(bodies[0].messages[1].content);
  });

  it("the fallback also triggers on a ContentError (a reply that does not match the schema) with web", async () => {
    const { c, bodies } = client([ok({ verdict: "maybe" }), ok(VERDICT())]);
    expect((await c.research(input)).verdict).toBe("supported");
    expect(bodies.map((b) => b.response_format.type)).toEqual(["json_schema", "json_object"]);
  });

  it("a failed fallback rethrows and does not set the sticky flag: the next research tries json_schema again", async () => {
    const { c, bodies } = client([badRequest, ok("not json"), ok(VERDICT())]);
    await expect(c.research(input)).rejects.toBeInstanceOf(ContentError);
    await c.research(input);
    expect(bodies.map((b) => b.response_format.type)).toEqual(["json_schema", "json_object", "json_schema"]);
  });

  it("a sticky json_object call that fails is not retried with another fallback", async () => {
    const { c, bodies } = client([badRequest, ok(VERDICT()), badRequest]);
    await c.research(input);
    await expect(c.research(input)).rejects.toThrow(/HTTP 400/);
    expect(bodies.map((b) => b.response_format.type)).toEqual(["json_schema", "json_object", "json_object"]);
  });

  it("non-400 errors (500 twice) with web do not fall back", async () => {
    const { c, bodies } = client([err(500), err(500), ok(VERDICT())]);
    await expect(c.research(input)).rejects.toThrow(/HTTP 500/);
    expect(bodies.map((b) => b.response_format.type)).toEqual(["json_schema", "json_schema"]);
  });

  it("an audit with a 400 throws without a fallback", async () => {
    const { c, bodies } = client([badRequest, ok({ items: [] })]);
    await expect(c.audit([])).rejects.toThrow(/HTTP 400/);
    expect(bodies).toHaveLength(1);
  });

  it("onStart is called once per chat() call: twice with a fallback", async () => {
    const { c, starts } = client([badRequest, ok(VERDICT()), ok({ items: [] }), ok({ changes: [], rationale: "r" })]);
    await c.research(input);
    await c.audit([]);
    await c.rewrite("u");
    expect(starts).toEqual(["research", "research", "audit", "rewrite"]);
  });
});

describe("S2Client: retries, errors, budget", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a 5xx then success → 2 fetches, one sleep of backoffMs(1) = 2000 with rand 0", async () => {
    const { c, bodies, sleeps, rows } = client([err(502), ok({ items: [] })]);
    await c.audit([]);
    expect(bodies).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  it("a 429 with retry-after 3 sleeps 3000, then succeeds", async () => {
    const { c, sleeps } = client([err(429, {}, { "retry-after": "3" }), ok({ items: [] })]);
    await c.audit([]);
    expect(sleeps).toEqual([3000]);
  });

  it("two failures use up maxAttempts=2: a row with ok:false, attempts:2 and the error", async () => {
    const { c, rows } = client([() => { throw new TypeError("fetch failed"); }, () => { throw new TypeError("fetch failed"); }]);
    await expect(c.rewrite("x")).rejects.toThrow("TypeError: fetch failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "s2_call", purpose: "rewrite", ok: false, attempts: 2, error: "TypeError: fetch failed", usage: null, cost_usd: 0, id: null });
    expect(rows[0]).not.toHaveProperty("response");
  });

  it("a fetch rejecting with a non-Error is a no-status failure", async () => {
    const { c, rows } = client([() => Promise.reject("reset"), () => Promise.reject("reset")]);
    await expect(c.audit([])).rejects.toThrow("reset");
    expect(rows[0]!.error).toBe("reset");
  });

  it("a non-transient 402 → BudgetExhaustedError('provider'); a 401 → the message is rewritten", async () => {
    const exhausted: string[] = [];
    const budget = new Budget({ onExhausted: (e) => exhausted.push(e.purpose) });
    const a = client([err(402, { message: "Insufficient credits" })], { budget });
    const e = await a.c.research(input).catch((x) => x);
    expect(e).toBeInstanceOf(BudgetExhaustedError);
    expect(e.cap).toBe("provider");
    expect(exhausted).toEqual(["s2:research"]);
    expect(a.bodies).toHaveLength(1); // a 402 is not a strict-output rejection: no fallback

    const b = client([err(401, { message: "No auth" })]);
    const e2 = await b.c.audit([]).catch((x) => x);
    expect(e2).toBeInstanceOf(HttpError);
    expect(e2).toMatchObject({ status: 401, message: "OpenRouter rejected the API key (401): check OPENROUTER_API_KEY" });
  });

  it("a transient 402 is retried", async () => {
    const { c, bodies, budget } = client([err(402, { metadata: { limit_source: "openrouter_in_flight_budget" } }), ok({ items: [] })]);
    await c.audit([]);
    expect(bodies).toHaveLength(2);
    expect(budget.isExhausted).toBe(false);
  });

  it("a refused budget throws before any fetch, with no log row and no onStart (unlike Jev's 0-attempt row)", async () => {
    const budget = new Budget();
    expect(() => budget.exhaust("provider", "jev:utterance", "used up")).toThrow();
    const { c, bodies, rows, starts } = client([ok({ items: [] })], { budget });
    await expect(c.audit([])).rejects.toThrow("used up");
    expect(bodies).toEqual([]);
    expect(rows).toEqual([]);
    expect(starts).toEqual([]);
  });

  it("a 200 with an error body is retried; a reply without usage.cost fails without a retry", async () => {
    const a = client([() => new Response(JSON.stringify({ error: { message: "upstream" } })), ok({ items: [] })]);
    await a.c.audit([]);
    expect(a.bodies).toHaveLength(2);
    const b = client([() => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1 } })), ok({ items: [] })]);
    await expect(b.c.audit([])).rejects.toThrow("response without usage.cost rejected");
    expect(b.bodies).toHaveLength(1);
  });

  it("a 200 that is not JSON, or truncated JSON, is retried", async () => {
    const { c, bodies } = client([() => new Response("<html>"), () => new Response('{"choices":'), ok({ items: [] })]);
    await expect(c.audit([])).rejects.toThrow(/HTTP 200/); // maxAttempts 2
    expect(bodies).toHaveLength(2);
  });

  it("content as an array of parts is joined; missing content → ContentError 'no JSON object'", async () => {
    const parts = { role: "assistant", content: [{ type: "text", text: '{"items":' }, { type: "text", text: "[]}" }, { type: "image" }] };
    const a = client([ok(null, { message: parts })]);
    expect(await a.c.audit([])).toEqual({ items: [] });
    expect(a.rows[0]!.response).toBe('{"items":[]}');
    const b = client([ok(null, { message: { role: "assistant" } })]);
    await expect(b.c.audit([])).rejects.toThrow("no JSON object in the reply: ");
    const d = client([() => new Response(JSON.stringify({ choices: [], usage: { cost: 0 } }))]);
    await expect(d.c.audit([])).rejects.toBeInstanceOf(ContentError);
  });

  it("usage without details logs reasoning_tokens 0 and cached_tokens 0", async () => {
    const { c, rows } = client([ok({ items: [] }, { usage: { cost: 0.0002 } })]);
    await c.audit([]);
    expect(rows[0]!.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cost: 0.0002 });
  });

  it("the row: web_engine null for an audit, claim_id omitted when absent, the raw reply as response, the request as sent", async () => {
    const { c, rows } = client([ok({ items: [] }), ok(VERDICT())]);
    await c.audit([{ utterance_id: "u_1", speaker: "A", text: "t" }]);
    await c.research(input);
    expect(rows[0]).toMatchObject({ purpose: "audit", web_engine: null, response_format: "json_schema", response: '{"items":[]}', id: "gen-1", model_returned: "openai/gpt-6-luna-20260601", provider_returned: "OpenAI" });
    expect(rows[0]).not.toHaveProperty("claim_id");
    expect(rows[0]!.request!.user).toBe(JSON.stringify([{ utterance_id: "u_1", speaker: "A", text: "t" }], null, 1));
    expect(rows[1]).toMatchObject({ purpose: "research", claim_id: "c_1", web_engine: "exa" });
    expect(Date.parse(rows[0]!.at)).not.toBeNaN();
  });

  it("without an injected sleep, a retry waits on a real timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { c, bodies } = client([err(503), ok({ items: [] })], { sleep: false });
    const p = c.audit([]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(bodies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(bodies).toHaveLength(2);
  });
});
