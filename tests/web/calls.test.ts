// @vitest-environment happy-dom
// The "Fast · slow thinking" and "Jev log" tabs (web/src/calls.ts), rendered from a state fed through the real reducer.
import { beforeEach, describe, expect, test } from "vitest";
import * as state from "../../web/src/state.ts";
import type { CallRow, State } from "../../web/src/state.ts";
import { feed, layout } from "./helpers.ts";
import { all, freshPage, text } from "./helpers-core.ts";

type Calls = typeof import("../../web/src/calls.ts");
let calls: Calls;

const START = "2026-09-30T10:00:00.000Z";
const at = (s: number) => new Date(Date.parse(START) + s * 1000).toISOString();
const jev = (o: Partial<CallRow> = {}): CallRow => ({
  kind: "jev_call", purpose: "utterance", ok: true, latency_ms: 850, attempts: 1, cost_usd: 0.000036, at: at(65), id: "g1", model_returned: "typesafe/jev-1.13",
  state: { new_utterance: { speaker: "Alice", text: "GPT-6 has ten trillion parameters." } }, utterance_id: "u1",
  answers: { claim: { type: "noul", noul: 0.62 }, public: { type: "noul", noul: 0.02 }, worth: { type: "score", score: 2, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 } }, boundary: { type: "noul", noul: 0.1 } },
  question_ids: ["claim", "public", "worth", "boundary"], ...o,
});
const s2 = (o: Partial<CallRow> = {}): CallRow => ({
  kind: "s2_call", purpose: "research", ok: true, latency_ms: 12_300, attempts: 1, cost_usd: 0.0077, at: at(70), id: "r1", model_returned: "openai/gpt-6-luna",
  claim_id: "c1", request: { system: "You are a fact-checker.", user: "Check: GPT-6 has ten trillion parameters." }, response: JSON.stringify({ verdict: "misleading" }),
  usage: { prompt_tokens: 1200, completion_tokens: 300, reasoning_tokens: 100 }, ...o,
});
const SET = {
  categories: [{ id: "subject", name: "Subject", options: [{ id: "ai", name: "AI" }] }],
  scores: [{ id: "heat", name: "Heat" }],
  markers: [{ id: "prediction", name: "Prediction" }],
} as unknown as NonNullable<State["labels"]["set"]>;

const session = (o: object = {}) => ({ session: { id: "S1", mode: "live", status: "running", startedAt: START, ...o } });
const build = (events: Parameters<typeof feed>[1], snap: object = session()) => feed(state, events, snap);
const show = (pane: "pane-jev" | "pane-think") => { for (const p of ["pane-fc", "pane-jev", "pane-think"]) document.getElementById(p)!.hidden = p !== pane; };

const reload = async () => {
  freshPage();
  calls = await import("../../web/src/calls.ts");
};
beforeEach(reload);

describe("money", () => {
  test("dollars at the precision one call needs", () => {
    expect([calls.money(0), calls.money(NaN), calls.money(0.000036), calls.money(0.0077), calls.money(1.239), calls.money(0.1)])
      .toEqual(["$0", "$0", "$0.000036", "$0.0077", "$1.24", "$0.10"]);
  });
});

describe("with Jev off", () => {
  test("a session with fact-checking and labels off says Jev is off in both tabs, and has no count", () => {
    const st = build([], session({ features: { factcheck: false, labels: false } }));
    st.calls.s1.push(jev());
    document.getElementById("jev-count")!.textContent = "9";
    calls.renderThinking(st);
    const off = "Jev is off for this session: fact-checking and labels were turned off when it started, so nothing is asked.";
    expect([text("#jev-log"), text("#think"), text("#jev-count")]).toEqual([off, off, ""]);
  });

  test("no session renders normally", () => {
    show("pane-jev");
    calls.renderThinking(state.emptyState());
    expect(text("#jev-log")).toBe("Every call to Jev appears here as it happens: what it was asked, what it answered, and what the app did next.");
  });

  test("fact-checking off but labels on: the thinking tab says fact-checking is off", () => {
    show("pane-think");
    calls.renderThinking(build([], session({ features: { factcheck: false, labels: true } })));
    expect(text("#think")).toMatch(/^Fact-checking is off for this session, so System 1 and System 2 do not run/);
  });
});

describe("the Jev log", () => {
  test("a hidden pane is not drawn; the count still shows", () => {
    const st = build([["call", jev()]]);
    calls.renderThinking(st);
    expect([all("#jev-log .call").length, text("#jev-count")]).toEqual([0, "1"]);
  });

  test("lists calls newest first, 200 at most", () => {
    show("pane-jev");
    const st = build([]);
    for (let i = 0; i < 205; i++) state.addCall(st, jev({ id: `g${i}`, at: at(i) }));
    calls.renderThinking(st);
    const rows = all("#jev-log .call");
    expect(rows).toHaveLength(200);
    expect(text(".t", rows[0])).toBe("3:24");
    expect(text("#jev-count")).toBe("205");
  });

  test("a line check: its session time, 'Line check', what Jev was shown, latency and cost", () => {
    show("pane-jev");
    calls.renderThinking(build([["call", jev()]]));
    const row = document.querySelector("#jev-log .call")!;
    expect(row.className).toBe("call s1");
    expect([text(".t", row), text(".purpose", row), text(".what", row), text(".lat", row), text(".cost", row)])
      .toEqual(["1:05", "Line check", "Alice: “GPT-6 has ten trillion parameters.”", "850 ms", "$0.000036"]);
    expect(row.querySelector(".call-head")!.getAttribute("title")).toMatch(/^Every line said is checked/);
  });

  test("a call from before the session started shows its wall-clock time", () => {
    show("pane-jev");
    const r = jev({ at: "2026-09-30T09:59:00.000Z", latency_ms: 1234 });
    calls.renderThinking(build([["call", r]]));
    const expected = new Date(Date.parse(r.at)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    expect([text("#jev-log .t"), text("#jev-log .lat")]).toEqual([expected, "1.2 s"]);
  });

  test("the key answers of a line check, in order claim, public, worth, boundary; a yes is marked", () => {
    show("pane-jev");
    calls.renderThinking(build([["call", jev()]]));
    const qa = all("#jev-log .qa-row .qa");
    expect(qa.map((q) => `${text(".qa-q", q)} ${text("b", q)}`)).toEqual(["Checkable claim? Yes (62%)", "About the public world? No (2% yes)", "Worth checking? 2.0 of 4", "New topic? No (10% yes)"]);
    expect(qa.map((q) => q.className)).toEqual(["qa yes key", "qa key", "qa key", "qa key"]);
  });

  test("answers as words: choices by the set's option name or their id, with a confidence; scores out of their legend", () => {
    show("pane-jev");
    const st = build([["call", jev({
      purpose: "segment", state: { segment: [{ speaker: "Bob", text: "So, AI." }, { speaker: "Alice", text: "Yes." }] },
      answers: {
        subject: { type: "choice", choice: "ai", confidence: 0.39 }, heat: { type: "score", score: 1.5, legend: { a: 1, b: 2, c: 3 } },
        mode: { type: "choice", choice: "deep_dive", probabilities: { deep_dive: 0.7 } }, prediction: { type: "noul", noul: 0.9 },
        other: { type: "noul", noul: 0.1 }, odd: { type: "choice", choice: "x" }, weird: { type: "text", value: 1 },
      },
    })]]);
    st.labels.set = SET;
    calls.renderThinking(st);
    expect(text("#jev-log .purpose")).toBe("Topic labels");
    expect(text("#jev-log .what")).toBe("2 lines of conversation, from Bob: “So, AI.”");
    expect(all("#jev-log .qa-row .qa").map((q) => `${text(".qa-q", q)} ${text("b", q)}`)).toEqual(["Subject AI (39% sure)", "Heat 1.5 of 2", "Prediction? Yes (90%)"]);
    // opened: every answer, including the ones not shown folded
    document.querySelector<HTMLButtonElement>("#jev-log .call-head")!.click();
    const every = all("#jev-log .qa-row.all .qa").map((q) => `${text(".qa-q", q)} ${text("b", q)}`);
    expect(every).toEqual(["Subject AI (39% sure)", "Heat 1.5 of 2", "mode? deep dive (70% sure)", "Prediction? Yes (90%)", "other? No (10% yes)", "odd? x (0% sure)", `weird? {"type":"text","value":1}`]);
  });

  test("what Jev was shown: one line of conversation, an empty segment, or nothing", () => {
    show("pane-jev");
    calls.renderThinking(build([
      ["call", jev({ id: "a", purpose: "segment", state: { segment: [{ speaker: "Bob", text: "Hi." }] }, answers: {} })],
      ["call", jev({ id: "b", purpose: "segment", state: { segment: [] }, answers: {} })],
      ["call", jev({ id: "c", purpose: "gate", state: {}, answers: null })],
      ["call", jev({ id: "d", purpose: "brand_new", state: undefined, answers: {} })],
    ]));
    expect(all("#jev-log .what").map((w) => w.textContent)).toEqual(["", "", "0 lines of conversation", "1 line of conversation, from Bob: “Hi.”"]);
    expect(all("#jev-log .purpose").map((w) => w.textContent)).toEqual(["brand new", "Rewrite test", "Topic labels", "Topic labels"]);
  });

  test("a failed call shows its error, or that it failed, and that the line is not fact-checked", () => {
    show("pane-jev");
    calls.renderThinking(build([["call", jev({ ok: false, error: "timeout after 3 s" })], ["call", jev({ id: "g2", ok: false })]]));
    const rows = all("#jev-log .call");
    expect(rows.map((r) => r.className)).toEqual(["call s1 failed", "call s1 failed"]);
    expect(rows.map((r) => text(".error-text", r))).toEqual(["The call failed.", "timeout after 3 s"]);
    expect(text(".next.bad", rows[0])).toBe("→ No answer in time: this line is not fact-checked");
    rows[1]!.querySelector<HTMLButtonElement>(".call-head")!.click();
    expect(all("#jev-log .http-line.resp")[0]!.textContent).toBe("Failed · timeout after 3 s");
    document.querySelectorAll<HTMLButtonElement>("#jev-log .call-head")[0]!.click();
    expect(all("#jev-log .http-line.resp").map((r) => r.textContent)).toContain("Failed · ");
  });

  test.each([
    [{}, "→ Flagged: sent to System 2 · researching"],
    [{ dropped: true }, "→ Flagged: sent to System 2 · dropped"],
    [{ verdict: "contradicted" }, "→ Flagged: sent to System 2 · verdict: False"],
    [{ verdict: "brand_new" }, "→ Flagged: sent to System 2 · verdict: brand_new"],
  ])("what the app did with a flagged line (%j)", (o: { dropped?: boolean; verdict?: string }, line) => {
    show("pane-jev");
    const events: Parameters<typeof feed>[1] = [["claim.flagged", { claimId: "c1", utteranceId: "u1", text: "x" }], ["call", jev()]];
    if (o.dropped) events.push(["claim.dropped", { claimId: "c1", reason: "r" }]);
    if (o.verdict) events.push(["claim.verdict", { claimId: "c1", verdict: { verdict: o.verdict }, grade: "good_flag" }]);
    calls.renderThinking(build(events));
    expect(text("#jev-log .next.go")).toBe(line);
  });

  test("a repeat of a claim already checked, and a line not flagged; other purposes say nothing", () => {
    show("pane-jev");
    calls.renderThinking(build([
      ["call", jev({ id: "a", utterance_id: "u5", answers: { known_c_7: { type: "noul", noul: 0.8 } } })],
      ["call", jev({ id: "b", utterance_id: "u6", answers: { known_c_7: { type: "noul", noul: 0.5 } } })],
      ["call", jev({ id: "c", utterance_id: undefined })],
      ["call", jev({ id: "d", purpose: "segment" })],
    ]));
    expect(all("#jev-log .next").map((n) => n.textContent)).toEqual([
      "→ Not flagged: nothing sent to System 2", "→ Not flagged: nothing sent to System 2", "→ Already checked: a repeat of claim c_7",
    ]);
  });

  test("a click opens a call: every answer, the memory line, and the exact request and response; it stays open on re-render", () => {
    show("pane-jev");
    const st = build([["call", jev({
      answers: { claim: { type: "noul", noul: 0.9 }, known_c_1: { type: "noul", noul: 0.7 }, known_c_2: { type: "noul", noul: 0.1 } },
      questions: { claim: { type: "noul", instructions: "Is it a claim?" } }, usage: { tokens: 10 },
    })]]);
    calls.renderThinking(st);
    const head = document.querySelector<HTMLButtonElement>("#jev-log .call-head")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    head.click();
    const row = document.querySelector("#jev-log .call")!;
    expect([row.className, row.querySelector(".call-head")!.getAttribute("aria-expanded")]).toEqual(["call s1 open", "true"]);
    expect(text(".call-detail h4", row)).toBe("Every answer · 3 questions asked at once");
    expect(all(".qa-row.all .qa", row)).toHaveLength(1); // memory questions folded into one line
    expect(text(".call-detail > p.note:nth-of-type(2)", row)).toBe(`Plus 2 memory questions, one per claim already flagged ("is this a repeat of it?"): a repeat of c_1`);
    expect(text(".http-line", row)).toBe("POST https://openrouter.ai/api/alpha/decisions");
    const [req, res] = all(".http pre", row).map((p) => JSON.parse(p.textContent!));
    expect(req).toEqual({ model: "typesafe/jev-1.13", state: jev().state, questions: { claim: { type: "noul", instructions: "Is it a claim?" } } });
    expect(res).toEqual({ answers: st.calls.s1[0]!.answers, usage: { tokens: 10 } });
    expect(all(".http .note", row)).toHaveLength(0);
    expect(text(".http-line.resp", row)).toBe("200 OK · 850 ms · $0.000036");
    state.addCall(st, jev({ id: "g9", at: at(80) }));
    calls.renderThinking(st);
    expect(all("#jev-log .call").map((r) => r.classList.contains("open"))).toEqual([false, true]);
    document.querySelectorAll<HTMLButtonElement>("#jev-log .call-head")[1]!.click();
    expect(all("#jev-log .call.open")).toHaveLength(0);
  });

  test("an opened call made before this page shows the wording seen on live calls, or says it was not recorded", () => {
    show("pane-jev");
    const st = build([["call", jev({ model_returned: null, answers: { known_c_1: { type: "noul", noul: 0.2 } } })]]);
    st.calls.questions = { claim: { type: "noul", instructions: "Is it a claim?" } };
    calls.renderThinking(st);
    document.querySelector<HTMLButtonElement>("#jev-log .call-head")!.click();
    const req = JSON.parse(all("#jev-log .http pre")[0]!.textContent!);
    expect(req.model).toBe("typesafe/jev-1.13");
    expect(req.questions).toEqual({ claim: { type: "noul", instructions: "Is it a claim?" }, public: "(wording not recorded for this call)", worth: "(wording not recorded for this call)", boundary: "(wording not recorded for this call)" });
    expect(text("#jev-log .http .note")).toBe("The question wording is shown in full only for calls made while this page was open.");
    expect(all("#jev-log .call-detail > p.note").map((p) => p.textContent)).toContain(`Plus 1 memory question, one per claim already flagged ("is this a repeat of it?"): no repeat found.`);
  });

  test("an opened call with no question ids and no answers", () => {
    show("pane-jev");
    calls.renderThinking(build([["call", jev({ question_ids: undefined, answers: undefined })]]));
    document.querySelector<HTMLButtonElement>("#jev-log .call-head")!.click();
    expect(text("#jev-log .call-detail h4")).toBe("Every answer · 0 questions asked at once");
    expect(JSON.parse(all("#jev-log .http pre")[0]!.textContent!).questions).toEqual({});
  });

  test("new calls arriving above keep the reader's place", () => {
    show("pane-jev");
    const box = document.getElementById("jev-log")!;
    let top = 0;
    Object.defineProperty(box, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = v; } });
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => box.children.length * 100 });
    const st = build([["call", jev({ id: "a", at: at(1) })], ["call", jev({ id: "b", at: at(2) })]]);
    calls.renderThinking(st);
    top = 50;
    state.addCall(st, jev({ id: "c", at: at(3) }));
    calls.renderThinking(st);
    expect(top).toBe(150);
    top = 0;
    state.addCall(st, jev({ id: "d", at: at(4) }));
    calls.renderThinking(st);
    expect(top).toBe(0); // at the top, it stays at the top, where new calls arrive
    box.classList.remove("scroll");
    top = 10;
    state.addCall(st, jev({ id: "e", at: at(5) }));
    calls.renderThinking(st);
    expect(top).toBe(10);
    layout(box, {});
  });

  test("without the log's box nothing is drawn", () => {
    show("pane-jev");
    document.getElementById("jev-log")!.remove();
    expect(() => calls.renderThinking(build([["call", jev()]]))).not.toThrow();
  });
});

describe("System 2 rows (inside the thinking tab's handoffs)", () => {
  const openHandoff = (st: State) => {
    show("pane-think");
    calls.renderThinking(st);
    document.querySelector<HTMLButtonElement>("#think .handoff-head")!.click();
  };
  const flagged = (...rows: CallRow[]) => build([["claim.flagged", { claimId: "c1", utteranceId: "u1", text: "GPT-6 has ten trillion parameters." }], ...rows.map((r) => ["call", r] as [string, CallRow])]);

  test("a research call: the claim, its verdict, and, opened, the tokens, the request with the system prompt folded, the reply", () => {
    openHandoff(flagged(jev(), s2({ web_engine: "exa" })));
    const row = document.querySelector("#think .call.s2")!;
    expect([text(".purpose", row), text(".what", row), text(".lat", row), text(".cost", row), text(".next.go", row)])
      .toEqual(["Research", "“GPT-6 has ten trillion parameters.”", "12.3 s", "$0.0077", "→ Verdict: Misleading"]);
    row.querySelector<HTMLButtonElement>(".call-head")!.click();
    const open = document.querySelector("#think .call.s2")!;
    expect(text(".call-detail > p.note", open)).toBe(
      `System 2 searches the web and writes a verdict with sources. It read ${(1200).toLocaleString()} tokens and wrote ${(300).toLocaleString()}, ${(100).toLocaleString()} of them reasoning.`);
    const req = JSON.parse(all(".http pre", open)[0]!.textContent!);
    expect(req).toEqual({
      model: "openai/gpt-6-luna",
      messages: [{ role: "system", content: `(${(23).toLocaleString()} characters, below)` }, { role: "user", content: "Check: GPT-6 has ten trillion parameters." }],
      plugins: [{ id: "web", engine: "exa" }],
    });
    expect(JSON.parse(all(".http pre", open)[1]!.textContent!)).toEqual({ verdict: "misleading" });
    expect(text("details pre", open)).toBe("You are a fact-checker.");
    expect(text(".http-line", open)).toBe("POST https://openrouter.ai/api/v1/chat/completions");
  });

  test("a reply that is not JSON shows as it is; a failed call shows its error; no usage adds nothing", () => {
    openHandoff(flagged(s2({ response: "not json", usage: undefined, model_returned: null, ok: false, error: "402" })));
    const row = document.querySelector("#think .call.s2")!;
    expect(all(".next", row)).toHaveLength(0);
    row.querySelector<HTMLButtonElement>(".call-head")!.click();
    const open = document.querySelector("#think .call.s2")!;
    expect(open.className).toBe("call s2 failed open");
    expect(text(".call-detail > p.note", open)).toBe("System 2 searches the web and writes a verdict with sources.");
    expect(all(".http pre", open)[1]!.textContent).toBe("not json");
    expect(text(".http-line.resp", open)).toBe("Failed · 402");
    expect(JSON.parse(all(".http pre", open)[0]!.textContent!).model).toBe("");
  });

  test("no response at all shows the error, or nothing; a verdict the page does not know is shown as it is", async () => {
    openHandoff(flagged(s2({ response: undefined, ok: false })));
    document.querySelector<HTMLButtonElement>("#think .call.s2 .call-head")!.click();
    expect(all("#think .call.s2 .http pre")[1]!.textContent).toBe("");
    await reload();
    openHandoff(flagged(s2({ response: JSON.stringify({ verdict: "brand_new" }) })));
    expect(text("#think .call.s2 .next.go")).toBe("→ Verdict: brand_new");
    await reload();
    openHandoff(flagged(s2({ response: JSON.stringify([1]) })));
    expect(all("#think .call.s2 .next")).toHaveLength(0);
  });

  test("a call recorded before prompts were saved says so", () => {
    openHandoff(flagged(s2({ request: undefined })));
    document.querySelector<HTMLButtonElement>("#think .call.s2 .call-head")!.click();
    expect(text("#think .call.s2 .call-detail > p.note:last-child")).toBe("This call was recorded before prompts were saved with each call.");
    expect(all("#think .call.s2 details")).toHaveLength(0);
  });
});

describe("the Fast · slow thinking tab", () => {
  test("both systems side by side: idle, their models, calls, averages and totals", () => {
    show("pane-think");
    const st = build([["call", jev()], ["call", jev({ id: "g2", latency_ms: 1150, cost_usd: 0.000064 })], ["call", s2()]]);
    st.calls.models = { s1: "typesafe/jev-1.13", s2: "openai/gpt-6-luna" };
    calls.renderThinking(st);
    const [a, b] = all("#think .sys");
    expect([a!.className, text(".sys-k", a), text(".sys-name", a), text(".sys-model", a), text(".sys-state", a)]).toEqual(["sys s1", "System 1 · fast", "Jev", "typesafe/jev-1.13", "Idle"]);
    expect(all(".sys-stats b", a).map((x) => x.textContent)).toEqual(["2", "1.0 s", "$0.000050", "$0.000100"]);
    expect([b!.className, text(".sys-name", b), text(".sys-role", b)]).toEqual(["sys s2", "GPT-6 Luna", "Researches only what System 1 flags"]);
  });

  test("a system with a call in flight glows and reads Thinking; the links flow while System 2 works", () => {
    show("pane-think");
    calls.renderThinking(build([["call.started", { system: "s1" }], ["call.started", { system: "s2" }]]));
    expect(all("#think .sys").map((x) => [x.className, text(".sys-state", x)])).toEqual([["sys s1 busy", "Thinking"], ["sys s2 busy", "Thinking"]]);
    expect(document.querySelector("#think .links")!.className).toBe("links flowing");
  });

  test("with no calls: dashes, System 2 unnamed, no value box, and the empty handoff text", () => {
    show("pane-think");
    calls.renderThinking(build([]));
    expect(all("#think .sys-stats b").map((x) => x.textContent)).toEqual(["0", "–", "–", "$0", "0", "–", "–", "$0"]);
    expect(text("#think .sys.s2 .sys-name")).toBe("System 2");
    expect(all("#think .value")).toHaveLength(0);
    expect(text("#think .handoffs + *, #think p.empty")).toBe("When Jev flags a public fact worth checking, it appears here with its trip to System 2 and back.");
    expect(all("#think .feed-h").map((f) => f.textContent)).toEqual(["From every line to a verdict", "Claims handed from System 1 to System 2"]);
  });

  test("the model falls back to the last call's, and a model name reads like a product", () => {
    show("pane-think");
    calls.renderThinking(build([["call", s2({ model_returned: "anthropic/claude-sonnet-5" })]]));
    expect([text("#think .sys.s2 .sys-name"), text("#think .sys.s2 .sys-model"), text("#think .sys.s1 .sys-model")]).toEqual(["Claude Sonnet 5", "anthropic/claude-sonnet-5", ""]);
  });

  test("the value box: how much cheaper System 1 was, and what System 2 would have cost", () => {
    show("pane-think");
    calls.renderThinking(build([["call", jev({ cost_usd: 0.0001 })], ["call", jev({ id: "g2", cost_usd: 0.0001 })], ["call", s2({ cost_usd: 0.01, latency_ms: 60_000 })]]));
    expect(text("#think .value-n")).toBe(`${(100).toLocaleString()}×cheaper with System 1`);
    expect(text("#think .value p")).toBe("Jev made 2 judgments for $0.000200. Asking System 2 for each would have cost about $0.0200 and taken 2:00 of model time.");
  });

  // calls.ts `Math.max(a.cost, 1e-9)`: when every Jev call cost nothing (a free model, or costs not reported), the
  // "× cheaper" figure is astronomically large instead of left out.
  test.fails("BUG §14.13: no value box claims billions of times cheaper when Jev cost nothing", () => {
    show("pane-think");
    calls.renderThinking(build([["call", jev({ cost_usd: 0 })], ["call", s2({ cost_usd: 0.01 })]]));
    expect(Number(text("#think .value-n b").replace(/\D/g, "") || 0)).toBeLessThan(1_000_000);
  });

  test("the funnel: lines, checked by Jev, flagged, researched, and verdicts by kind", () => {
    show("pane-think");
    const st = build([
      ["utterance", { id: "u1" }], ["utterance", { id: "u2" }], ["utterance", { id: "u3" }],
      ["call", jev({ id: "a", cost_usd: 0.001, latency_ms: 500 })], ["call", jev({ id: "b", cost_usd: 0.001, latency_ms: 1500 })], ["call", jev({ id: "c", purpose: "segment" })],
      ["claim.flagged", { claimId: "c1", utteranceId: "u1" }], ["claim.flagged", { claimId: "c2", utteranceId: "u2" }], ["claim.flagged", { claimId: "c3", utteranceId: "u3" }],
      ["claim.verdict", { claimId: "c1", verdict: { verdict: "contradicted" } }], ["claim.verdict", { claimId: "c2", verdict: { verdict: "supported" } }],
      ["claim.verdict", { claimId: "c3", verdict: { verdict: "unverifiable" } }],
      ["call", s2({ id: "r1", cost_usd: 0.01, latency_ms: 10_000 })], ["call", s2({ id: "r2", purpose: "audit" })],
    ]);
    calls.renderThinking(st);
    expect(all("#think .funnel .step").map((s) => `${text("b", s)}|${text(".label", s)}|${text(".sub", s)}`)).toEqual([
      "3|lines heard|transcribed", "2|checked by Jev|$0.0020 · 1.0 s each", "3|flagged|public facts worth checking",
      "1|researched|$0.0100 · 10.0 s each", "3|verdicts|1 false · 1 supported",
    ]);
  });

  test("the funnel with nothing yet names each system, and 'none yet'", () => {
    show("pane-think");
    calls.renderThinking(build([]));
    expect(all("#think .funnel .sub").map((s) => s.textContent)).toEqual(["transcribed", "System 1", "public facts worth checking", "System 2", "none yet"]);
  });

  test("handoffs: most recent activity first, 60 at most, each with its hops and verdict", () => {
    show("pane-think");
    const events: Parameters<typeof feed>[1] = [];
    for (let i = 0; i < 62; i++) events.push(["claim.flagged", { claimId: `c${i}`, utteranceId: `u${i}`, text: `claim ${i}` }, at(i)]);
    const st = build(events);
    calls.renderThinking(st);
    const rows = all("#think .handoff");
    expect(rows).toHaveLength(60);
    expect(text(".claim", rows[0])).toBe("“claim 61”");
    expect(all("#think .feed-h")[1]!.textContent).toBe("Claims handed from System 1 to System 2 · 62");
  });

  test.each([
    [["claim.verdict", { claimId: "c1", verdict: { verdict: "misleading" } }], "Misleading", "v-misleading"],
    [["claim.verdict", { claimId: "c1", verdict: { verdict: "new_kind" } }], "new_kind", "v-new_kind"],
    [["claim.dropped", { claimId: "c1", reason: "r" }], "Dropped", "v-dropped"],
    [["claim.researching", { claimId: "c1" }], "Researching…", "v-researching"],
    [null, "Queued", "v-queued"],
  ] as const)("a handoff's verdict hop after %j reads %s", (ev, word, cls) => {
    show("pane-think");
    const events: Parameters<typeof feed>[1] = [["claim.flagged", { claimId: "c1", utteranceId: "u1", text: "x" }]];
    if (ev) events.push(ev as [string, unknown] as [string, any]);
    calls.renderThinking(build(events));
    const v = document.querySelector("#think .hop.verdict")!;
    expect([v.textContent, v.classList.contains(cls)]).toEqual([word, true]);
  });

  test("a handoff's hops: Jev's time and cost, System 2's, or what is still to come", () => {
    show("pane-think");
    let st = build([["claim.flagged", { claimId: "c1", utteranceId: "u1", text: "x" }], ["call", jev()], ["call", s2()]]);
    st.calls.models.s2 = "openai/gpt-6-luna";
    calls.renderThinking(st);
    expect(all("#think .hop small").map((s) => s.textContent)).toEqual(["850 ms · $0.000036", "12.3 s · $0.0077"]);
    expect(text("#think .hop.s2")).toBe("GPT-6 Luna12.3 s · $0.0077");
    st = build([["claim.flagged", { claimId: "c1", utteranceId: "u1", text: "x" }]]);
    calls.renderThinking(st);
    expect(all("#think .hop small").map((s) => s.textContent)).toEqual(["flagged", "…"]);
    st = build([["claim.flagged", { claimId: "c1", utteranceId: "u1", text: "x" }], ["claim.dropped", { claimId: "c1" }]]);
    calls.renderThinking(st);
    expect(all("#think .hop small").map((s) => s.textContent)).toEqual(["flagged", "not researched"]);
  });

  test("a handoff opens to both calls, and closes again; with no calls it opens empty", () => {
    show("pane-think");
    const st = build([["claim.flagged", { claimId: "c1", utteranceId: "u1", text: "x" }], ["call", jev()], ["call", s2()]]);
    calls.renderThinking(st);
    document.querySelector<HTMLButtonElement>("#think .handoff-head")!.click();
    expect(all("#think .handoff.open .call-detail h4").map((h) => h.textContent)).toEqual(["System 1 · Jev flagged it", "System 2 · researched it"]);
    expect(all("#think .handoff .call")).toHaveLength(2);
    document.querySelector<HTMLButtonElement>("#think .handoff-head")!.click();
    expect(all("#think .handoff.open")).toHaveLength(0);
    calls.renderThinking(build([["claim.flagged", { claimId: "c9", utteranceId: "u9", text: "y" }]]));
    document.querySelector<HTMLButtonElement>("#think .handoff-head")!.click();
    expect(all("#think .handoff.open .call-detail > *")).toHaveLength(0);
  });
});
