import { describe, expect, test } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.ts";
import type { JevAnswer, JevResponse, QuestionSet } from "../src/jev/types.ts";
import type { JevCallMeta } from "../src/jev/client.ts";
import type { PipelineUtterance } from "../src/pipeline/segmenter.ts";
import { applyRewrite, FactChecker, flagDecision, type S2Api } from "../src/factcheck/s1.ts";
import { ResearchQueue, type QueueItem } from "../src/factcheck/queue.ts";
import { finalizeVerdict, gradeOf, parseContent, VerdictSchema, type RewriteChange, type RewriteProposal, type Verdict } from "../src/factcheck/s2.ts";
import { gateDecision, runGate, type GateItem } from "../src/factcheck/gate.ts";

const cfg = loadConfig();
const clone = <T>(v: T): T => structuredClone(v);

// ---------- helpers ----------

function ans(o: { claim?: number; type?: string; worth?: number; hedged?: number; public?: number; [k: string]: number | string | undefined }): Record<string, JevAnswer> {
  const a: Record<string, JevAnswer> = {
    claim: { type: "noul", noul: o.claim ?? 0 },
    claim_type: { type: "choice", choice: o.type ?? "none", confidence: 1, probabilities: {} },
    public: { type: "noul", noul: o.public ?? 0.9 },
    worth: { type: "score", score: o.worth ?? 0, confidence: 1, probabilities: {} },
    hedged: { type: "noul", noul: o.hedged ?? 0 },
  };
  for (const [k, v] of Object.entries(o)) if (typeof v === "number" && (k.startsWith("known_") || k.startsWith("attention_"))) a[k] = { type: "noul", noul: v };
  return a;
}
const FLAG = { claim: 0.9, type: "number_or_price", worth: 3 };
const NOFLAG = { claim: 0.1 };

let uN = 0;
function utt(text: string, endMs = (uN + 1) * 5000, filler = false): PipelineUtterance {
  uN++;
  return { id: `u_${uN}`, stream: "remote", startMs: endMs - 3000, endMs, speakerId: "spk_2", speakerInferred: false, text, filler, failed: false, tags: [] };
}

const VERDICT = (o: Partial<Verdict> = {}): Verdict => ({
  restated_claim: "Jev costs 1/445 of GPT.", verdict: "supported", correction: "", confidence: "high", false_alarm_reason: "none",
  sources: [{ url: "https://a.example", title: "A" }], downgraded: false, ...o,
});

function fakeS2(opts: { verdict?: (c: string) => Verdict; audit?: S2Api["audit"]; rewrite?: S2Api["rewrite"] } = {}) {
  const calls = { research: [] as string[], audit: 0, rewrite: 0 };
  const s2: S2Api = {
    async research(i) { calls.research.push(i.utterance); return (opts.verdict ?? (() => VERDICT()))(i.utterance); },
    async audit(items) { calls.audit++; return opts.audit ? opts.audit(items) : { items: [] }; },
    async rewrite(u) { calls.rewrite++; return opts.rewrite ? opts.rewrite(u) : { changes: [], rationale: "none" }; },
  };
  return { s2, calls };
}

function checker(opts: {
  app?: AppConfig; s2?: S2Api;
  ask?: (state: unknown, q: QuestionSet, m: JevCallMeta) => Promise<JevResponse>;
  now?: () => number;
} = {}) {
  const events: { type: string; data: any }[] = [];
  const rows: { file: string; row: any }[] = [];
  const states = new Map<string, unknown>();
  const fc = new FactChecker({
    app: opts.app ?? cfg.app, s1Default: cfg.s1, s2: opts.s2 ?? fakeS2().s2,
    ask: opts.ask ?? (async () => { throw new Error("no ask"); }),
    emit: (type, data) => events.push({ type, data }),
    write: (file, row) => rows.push({ file, row }),
    speakerName: (id) => id,
    stateOf: (id) => states.get(id),
    onError: (c, m) => events.push({ type: "error", data: { c, m } }),
    now: opts.now, rand: () => 0,
  });
  const say = (text: string, a: Record<string, JevAnswer>, u = utt(text)) => {
    states.set(u.id, { current_segment: [], new_utterance: { speaker: u.speakerId, text: u.text, tags: [] } });
    fc.onAnswers(u, a, { segment: [u] });
    return u;
  };
  return { fc, events, rows, say, of: (t: string) => events.filter((e) => e.type === t) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------- §4.8a ----------

describe("System 1: flag rule, priority, memory", () => {
  test("flag rule needs claim, a claim type, and worth", () => {
    const v = cfg.s1;
    expect(flagDecision(ans(FLAG), v, 0.6).flag).toBe(true);
    expect(flagDecision(ans({ ...FLAG, claim: 0.69 }), v, 0.6).flag).toBe(false);
    expect(flagDecision(ans({ ...FLAG, type: "none" }), v, 0.6).flag).toBe(false);
    expect(flagDecision(ans({ ...FLAG, worth: 1.49 }), v, 0.6).flag).toBe(false);
    expect(flagDecision(ans({ ...FLAG, worth: 1.5 }), v, 0.6).flag).toBe(true);
  });

  test("a concrete claim about the speakers' private lives is not flagged", () => {
    const v = cfg.s1;
    expect(flagDecision(ans({ ...FLAG, type: "event", public: 0.1 }), v, 0.6).flag).toBe(false);
    expect(flagDecision(ans({ ...FLAG, public: 0.59 }), v, 0.6).flag).toBe(false);
    expect(flagDecision(ans({ ...FLAG, public: 0.6 }), v, 0.6)).toMatchObject({ flag: true, public: 0.6 });
    // a set from before the question existed does not gate on it
    const old = clone(cfg.s1) as any;
    delete old.questions.public;
    expect(flagDecision(ans({ ...FLAG, public: 0 }), old, 0.6).flag).toBe(true);
  });

  test("priority adds hedging and attention", () => {
    const v = clone(cfg.s1) as any;
    v.questions.attention_1 = { type: "noul", instructions: "about AI pricing" };
    expect(flagDecision(ans(FLAG), v, 0.6).priority).toBe(3);
    expect(flagDecision(ans({ ...FLAG, hedged: 0.7 }), v, 0.6).priority).toBe(3.5);
    expect(flagDecision(ans({ ...FLAG, hedged: 0.7, attention_1: 0.8 }), v, 0.6).priority).toBe(4.5);
  });

  test("the queue serves the highest priority first", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q = new ResearchQueue({ ...cfg.app.s2, researchConcurrency: 1 }, {
      research: async (it) => { order.push(it.claimId); await gate; }, onDropped: () => {}, setTimer: () => {},
    });
    q.enqueue({ claimId: "first", priority: 1, flaggedAt: Date.now() });
    q.enqueue({ claimId: "low", priority: 2, flaggedAt: Date.now() });
    q.enqueue({ claimId: "high", priority: 4.5, flaggedAt: Date.now() });
    q.enqueue({ claimId: "mid", priority: 3, flaggedAt: Date.now() });
    release();
    await settle(); await settle(); await q.drain();
    expect(order).toEqual(["first", "high", "mid", "low"]);
  });

  test("a flag adds a memory question; memory evicts the oldest", () => {
    const app = clone(cfg.app);
    app.factcheck.maxKnownQuestions = 2;
    const h = checker({ app });
    h.say("claim one", ans(FLAG));
    h.say("claim two", ans(FLAG));
    h.say("claim three", ans(FLAG));
    const q = h.fc.questions();
    expect(Object.keys(q.questions)).toEqual(["claim", "claim_type", "public", "hedged", "worth", "known_c_2", "known_c_3"]);
    expect(q.questions.known_c_3).toEqual({
      type: "noul",
      instructions: 'Judge only new_utterance. It restates or relies on this already-checked claim: "claim three"',
      criteria: {
        true: "new_utterance states the same factual claim again, in the same or different words.",
        false: "new_utterance makes a different claim, or only reacts to, questions, or disputes the claim.",
      },
    });
    expect(h.of("s1.memory").map((e) => e.data.action)).toEqual(["add", "add", "add", "evict"]);
    expect(q.version).toBe("s1@1");
  });

  test("duplicate while pending, repeat with the verdict once verified; no second research", async () => {
    const { s2, calls } = fakeS2();
    const h = checker({ s2 });
    h.say("Jev is 445 times cheaper than GPT", ans(FLAG));
    // same tick: the claim is still queued/researching
    h.say("as I said, 445 times cheaper", ans({ ...FLAG, known_c_1: 0.9 }));
    expect(h.of("claim.duplicate")[0].data).toMatchObject({ claimId: "c_1" });
    await h.fc.drain();
    h.say("Jev is 445 times cheaper than GPT", ans({ ...FLAG, known_c_1: 0.6 }));
    const rep = h.of("claim.repeat")[0].data;
    expect(rep.claimId).toBe("c_1");
    expect(rep.verdict.verdict).toBe("supported");
    expect(calls.research.length).toBe(1);
    expect(h.of("claim.flagged").length).toBe(1);
    // the verdict's restated claim replaces the quoted text
    expect((h.fc.questions().questions.known_c_1 as any).instructions).toContain("Jev costs 1/445 of GPT.");
    // a match below knownMatchThreshold flags normally
    h.say("another claim", ans({ ...FLAG, known_c_1: 0.59 }));
    expect(h.of("claim.flagged").length).toBe(2);
  });
});

// ---------- §4.8b ----------

describe("System 2: queue, research, grading", () => {
  test("per-session and per-hour caps", async () => {
    const researched: string[] = [];
    const dropped: [string, string][] = [];
    const timers: number[] = [];
    const q = new ResearchQueue({ ...cfg.app.s2, maxResearchPerSession: 3, maxResearchPerHour: 2, researchConcurrency: 1 }, {
      research: async (it) => { researched.push(it.claimId); }, onDropped: (it, r) => dropped.push([it.claimId, r]),
      setTimer: (_fn, ms) => timers.push(ms),
    });
    const now = Date.now();
    for (const id of ["a", "b", "c", "d"]) q.enqueue({ claimId: id, priority: 1, flaggedAt: now });
    await settle(); await q.drain(); await settle();
    expect(researched).toEqual(["a", "b"]); // the hour window is full
    expect(timers.length).toBeGreaterThan(0);

    const q2 = new ResearchQueue({ ...cfg.app.s2, maxResearchPerSession: 2, researchConcurrency: 1 }, {
      research: async (it) => { researched.push(it.claimId); }, onDropped: (it, r) => dropped.push([it.claimId, r]), setTimer: () => {},
    });
    for (const id of ["e", "f", "g"]) q2.enqueue({ claimId: id, priority: 1, flaggedAt: now });
    await settle(); await q2.drain(); await settle(); await q2.drain();
    expect(researched.slice(2)).toEqual(["e", "f"]);
    expect(dropped).toEqual([["g", "session_cap"]]);
  });

  test("stale items are dropped", async () => {
    let t = 1_000_000;
    const dropped: string[] = [];
    const researched: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const q = new ResearchQueue({ ...cfg.app.s2, researchConcurrency: 1 }, {
      research: async (it: QueueItem) => { researched.push(it.claimId); await hold; },
      onDropped: (it, r) => dropped.push(`${it.claimId}:${r}`), now: () => t, setTimer: () => {},
    });
    q.enqueue({ claimId: "busy", priority: 5, flaggedAt: t });
    q.enqueue({ claimId: "old", priority: 1, flaggedAt: t });
    t += cfg.app.s2.staleAfterMs + 1;
    release();
    await settle(); await q.drain(); await settle();
    expect(researched).toEqual(["busy"]);
    expect(dropped).toEqual(["old:stale"]);
  });

  test("sources merge annotations, deduplicated by URL, before the 3-source limit; limits enforced", () => {
    const raw = {
      restated_claim: "x".repeat(250), verdict: "contradicted" as const, correction: Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "),
      confidence: "medium" as const, false_alarm_reason: "none" as const,
      sources: [{ url: "https://a", title: "A" }, { url: "https://b", title: "B" }],
    };
    const ann = [
      { type: "url_citation", url_citation: { url: "https://b", title: "B again", content: "", start_index: 0, end_index: 1 } },
      { type: "url_citation", url_citation: { url: "https://c", title: "C" } },
      { type: "url_citation", url_citation: { url: "https://d", title: "D" } },
    ];
    const v = finalizeVerdict(raw, ann);
    expect(v.sources.map((s) => s.url)).toEqual(["https://a", "https://b", "https://c"]);
    expect(v.restated_claim.length).toBe(200);
    expect(v.correction.split(" ").length).toBe(25);
    expect(v.verdict).toBe("contradicted");
    expect(v.downgraded).toBe(false);
  });

  test("sources are web pages only: javascript:, data: and file: links from the model are dropped", () => {
    const v = finalizeVerdict({
      ...VERDICT(),
      sources: [{ url: "javascript:alert(1)", title: "x" }, { url: "file:///etc/passwd", title: "y" }, { url: "data:text/html,hi", title: "z" }, { url: "https://ok.example/a", title: "OK" }],
    }, [{ type: "url_citation", url_citation: { url: "JavaScript:void(0)", title: "w" } }]);
    expect(v.sources.map((s) => s.url)).toEqual(["https://ok.example/a"]);
  });

  test("inline markdown citations are stripped from text and titles", () => {
    const v = finalizeVerdict({
      ...VERDICT(),
      correction: "445x is a vendor figure ([tomshardware.com](https://t.com/a)); tests found 40–49x ([a.com](https://a.com), [b.com](https://b.com)).",
      restated_claim: "Jev is [445 times](https://x.com) cheaper.",
      sources: [{ url: "https://www.ayautomate.com/blog", title: "[ayautomate.com](https://www.ayautomate.com/blog)" }, { url: "https://dev.to/x", title: "https://dev.to/x" }],
    }, []);
    expect(v.correction).toBe("445x is a vendor figure; tests found 40–49x.");
    expect(v.restated_claim).toBe("Jev is 445 times cheaper.");
    expect(v.sources.map((s) => s.title)).toEqual(["ayautomate.com", "dev.to"]);
  });

  test("a sourced verdict without sources is downgraded to unverifiable", () => {
    for (const verdict of ["supported", "contradicted", "misleading"] as const) {
      const v = finalizeVerdict({ ...VERDICT({ verdict }), sources: [] }, []);
      expect(v).toMatchObject({ verdict: "unverifiable", downgraded: true });
    }
    expect(finalizeVerdict({ ...VERDICT({ verdict: "not_a_claim" }), sources: [] }, undefined)).toMatchObject({ verdict: "not_a_claim", downgraded: false });
    // annotations alone are enough
    expect(finalizeVerdict({ ...VERDICT(), sources: [] }, [{ type: "url_citation", url_citation: { url: "https://z", title: "Z" } }]).verdict).toBe("supported");
  });

  test("grading", () => {
    expect(gradeOf({ verdict: "supported", false_alarm_reason: "none" })).toBe("good_flag");
    expect(gradeOf({ verdict: "contradicted", false_alarm_reason: "none" })).toBe("good_flag");
    expect(gradeOf({ verdict: "not_a_claim", false_alarm_reason: "none" })).toBe("false_alarm");
    expect(gradeOf({ verdict: "unverifiable", false_alarm_reason: "hyperbole" })).toBe("false_alarm");
  });

  test("a host override disputes the verdict and removes its grade from the evidence", async () => {
    const { s2 } = fakeS2({ verdict: () => VERDICT({ verdict: "not_a_claim", false_alarm_reason: "hyperbole" }) });
    const h = checker({ s2 });
    h.say("a million times better", ans(FLAG));
    await h.fc.drain();
    expect(h.fc.stats().falseAlarms).toBe(1);
    expect(h.fc.gateItems().map((i) => i.set)).toEqual(["F"]);
    h.fc.override("c_1", "it was a joke, fine");
    expect(h.of("claim.disputed")[0].data).toEqual({ claimId: "c_1", note: "it was a joke, fine" });
    expect(h.fc.stats()).toMatchObject({ falseAlarms: 0, disputed: 1 });
    expect(h.fc.gateItems()).toEqual([]);
    expect(() => h.fc.override("c_9")).toThrow();
  });

  test("verdict parsing validates against the schema", () => {
    expect(() => parseContent('{"verdict":"maybe"}', VerdictSchema)).toThrow(/schema/);
    expect(parseContent("```json\n" + JSON.stringify(VERDICT()) + "\n```", VerdictSchema).verdict).toBe("supported");
  });
});

// ---------- §4.8c ----------

const change = (o: Partial<RewriteChange> & Pick<RewriteChange, "op" | "target">): RewriteChange => ({
  text: null, true_text: null, false_text: null, options: null, levels: null, number: null, ...o,
});
const proposal = (...changes: RewriteChange[]): RewriteProposal => ({ changes, rationale: "because" });

describe("feedback loop: audits, rewrites, gate", () => {
  test("audit trigger: interval on the session clock, minimum pool, and the miss rule", async () => {
    const { s2, calls } = fakeS2({
      audit: async (items) => ({
        items: items.map((it, i) => ({ utterance_id: it.utterance_id, has_checkable_claim: i < 3, worth: (["high", "low", "medium"] as const)[i % 3] })),
      }),
    });
    const h = checker({ s2 });
    uN = 0;
    for (let i = 0; i < 9; i++) h.say(`chat ${i}`, ans(NOFLAG), utt(`chat ${i}`, 30_000 * (i + 1)));
    h.say("filler", ans(NOFLAG), utt("yeah", 290_000, true));
    h.say("chat 9", ans(NOFLAG), utt("chat 9", 299_000));
    expect(calls.audit).toBe(0); // interval not reached
    h.say("chat 10", ans(NOFLAG), utt("chat 10", 300_000));
    await h.fc.drain();
    expect(calls.audit).toBe(1);
    const a = h.of("audit")[0].data;
    expect(a.sampled).toBe(10);
    // items 0 (high) and 2 (medium) are misses; item 1 is checkable but low worth
    expect(a.misses.length).toBe(2);
    expect(h.fc.stats().misses).toBe(2);
    // not enough new utterances at the next interval: no audit
    h.say("chat 11", ans(NOFLAG), utt("chat 11", 600_000));
    await h.fc.drain();
    expect(calls.audit).toBe(1);
  });

  test("rewrite trigger, cooldown, and memory changes not resetting the count", async () => {
    const { s2, calls } = fakeS2({ verdict: () => VERDICT({ verdict: "not_a_claim", false_alarm_reason: "opinion" }) });
    const h = checker({ s2, ask: async () => ({ answers: ans(NOFLAG), id: "g", model: "m", provider: "p", usage: { input_tokens: 0, output_tokens: 0, cost: 0 } }) });
    uN = 0;
    h.say("opinion 1", ans(FLAG), utt("opinion 1", 10_000));
    h.say("opinion 2", ans(FLAG), utt("opinion 2", 20_000)); // two memory adds happen in between: they do not reset the count
    await h.fc.drain();
    expect(calls.rewrite).toBe(0);
    h.say("opinion 3", ans(FLAG), utt("opinion 3", 30_000));
    await h.fc.drain();
    expect(calls.rewrite).toBe(1); // 3 false alarms
    expect(h.of("s1.version")[0].data).toMatchObject({ outcome: "invalid", active: "s1@1" }); // the fake proposes no changes
    h.say("opinion 4", ans(FLAG), utt("opinion 4", 40_000));
    await h.fc.drain();
    expect(calls.rewrite).toBe(1); // cooldown
    h.say("opinion 5", ans(FLAG), utt("opinion 5", 30_000 + 180_000));
    await h.fc.drain();
    expect(calls.rewrite).toBe(2);
    expect(h.fc.stats().rejected).toBe(2);
  });

  test("per-op field rules and every rejected change", () => {
    const a = cfg.s1;
    const ok = (p: RewriteProposal) => expect(applyRewrite(a, p).ok).toBe(true);
    const bad = (p: RewriteProposal, re: RegExp) => {
      const r = applyRewrite(a, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("; ")).toMatch(re);
    };
    const keys = ["number_or_price", "date_or_release", "quote_or_attribution", "capability_or_benchmark", "event", "prediction", "none"];
    ok(proposal(change({ op: "set_instructions", target: "claim", text: "Judge only new_utterance. A checkable fact." })));
    ok(proposal(change({ op: "set_criteria", target: "hedged", true_text: "t", false_text: "f" })));
    ok(proposal(change({ op: "set_criteria", target: "claim_type", options: keys.map((key) => ({ key, description: `d ${key}` })) })));
    ok(proposal(change({ op: "set_criteria", target: "worth", levels: ["a", "b", "c", "d", "e"] })));
    ok(proposal(change({ op: "add_attention", target: "new", text: "Mentions a price" }), change({ op: "add_attention", target: "new", text: "x", true_text: "t", false_text: "f" })));
    ok(proposal(change({ op: "set_threshold", target: "worthMin", number: 1 }), change({ op: "set_threshold", target: "claimThreshold", number: 0.9 })));

    // wrong fields
    bad(proposal(change({ op: "set_instructions", target: "claim" })), /needs text/);
    bad(proposal(change({ op: "set_instructions", target: "claim", text: "x", number: 1 })), /must leave number null/);
    bad(proposal(change({ op: "set_criteria", target: "claim", true_text: "t" })), /needs false_text/);
    bad(proposal(change({ op: "add_attention", target: "new", text: "x", true_text: "t" })), /both/);
    bad(proposal(change({ op: "remove_attention", target: "attention_1" })), /no question/);
    bad(proposal(change({ op: "set_threshold", target: "worthMin" })), /needs number/);
    // wrong targets
    bad(proposal(change({ op: "set_instructions", target: "boundary", text: "x" })), /cannot target boundary/);
    bad(proposal(change({ op: "set_criteria", target: "subject", true_text: "t", false_text: "f" })), /cannot target/);
    bad(proposal(change({ op: "add_attention", target: "attention_1", text: "x" })), /"new"/);
    bad(proposal(change({ op: "set_threshold", target: "sessionCapUsd", number: 1 })), /cannot target/);
    // keys
    bad(proposal(change({ op: "set_criteria", target: "claim_type", options: keys.slice(0, 6).map((key) => ({ key, description: "d" })) })), /exactly/);
    bad(proposal(change({ op: "set_criteria", target: "claim_type", options: [...keys.slice(0, 6), "other"].map((key) => ({ key, description: "d" })) })), /exactly/);
    // level count
    bad(proposal(change({ op: "set_criteria", target: "worth", levels: ["a", "b", "c", "d"] })), /exactly 5/);
    // range
    bad(proposal(change({ op: "set_threshold", target: "claimThreshold", number: 0.95 })), /outside/);
    bad(proposal(change({ op: "set_threshold", target: "attentionThreshold", number: 0.4 })), /outside/);
    bad(proposal(change({ op: "set_threshold", target: "worthMin", number: 3.5 })), /outside/);
    // length
    bad(proposal(change({ op: "set_instructions", target: "worth", text: "x".repeat(401) })), /400/);
    // more than 3 changes, and more than 3 attention questions
    const add = change({ op: "add_attention", target: "new", text: "x" });
    bad(proposal(add, add, add, add), /at most 3/);
    const three = applyRewrite(a, proposal(add, add, add));
    expect(three.ok).toBe(true);
    if (three.ok) {
      const withThree = { id: "s1@2", ...three.set };
      expect(Object.keys(withThree.questions)).toContain("attention_3");
      const r = applyRewrite(withThree, proposal(add));
      expect(r.ok).toBe(false);
      expect(applyRewrite(withThree, proposal(change({ op: "remove_attention", target: "attention_2" }))).ok).toBe(true);
    }
    // one bad change rejects the whole rewrite
    bad(proposal(change({ op: "set_threshold", target: "worthMin", number: 1 }), change({ op: "set_threshold", target: "worthMin", number: 9 })), /outside/);
  });

  test("gate arithmetic", () => {
    expect(gateDecision({ G: 10, F: 3, M: 0, G2: 9, F2: 2, M2: 0 })).toBe(true);
    expect(gateDecision({ G: 10, F: 3, M: 0, G2: 8, F2: 0, M2: 0 })).toBe(false); // lost good flags
    expect(gateDecision({ G: 10, F: 3, M: 0, G2: 10, F2: 3, M2: 0 })).toBe(false); // fixed nothing
    expect(gateDecision({ G: 5, F: 0, M: 2, G2: 5, F2: 0, M2: 1 })).toBe(true); // caught a miss
    expect(gateDecision({ G: 3, F: 1, M: 0, G2: 2, F2: 0, M2: 0 })).toBe(true); // floor(2.7) = 2
  });

  test("runGate re-asks the candidate questions (no memory) on stored states", async () => {
    const seen: QuestionSet[] = [];
    const items: GateItem[] = [
      { utteranceId: "g1", set: "G", state: { s: "g1" }, order: 3 },
      { utteranceId: "g2", set: "G", state: { s: "g2" }, order: 2 },
      { utteranceId: "f1", set: "F", state: { s: "f1" }, order: 1 },
    ];
    const ask = async (state: any, q: QuestionSet, m: JevCallMeta) => {
      seen.push(q);
      expect(m.purpose).toBe("gate");
      return { answers: ans(state.s.startsWith("g") ? FLAG : NOFLAG), id: "", model: "", provider: "", usage: { input_tokens: 0, output_tokens: 0, cost: 0 } };
    };
    const promote = await runGate(cfg.s1, items, { ask, hedgedThreshold: 0.6 });
    expect(promote).toMatchObject({ G: 2, F: 1, M: 0, G2: 2, F2: 0, promote: true });
    expect(Object.keys(seen[0])).toEqual(["claim", "claim_type", "public", "hedged", "worth"]);
    const reject = await runGate(cfg.s1, items, { ask: async (s, q, m) => ({ ...(await ask(s, q, m)), answers: ans(FLAG) }), hedgedThreshold: 0.6 });
    expect(reject).toMatchObject({ G2: 2, F2: 1, promote: false });
  });

  test("a promoted version applies from the next utterance; rollback keeps the memory set", async () => {
    const rewrite: S2Api["rewrite"] = async () => proposal(change({ op: "set_threshold", target: "claimThreshold", number: 0.9 }));
    const { s2 } = fakeS2({ verdict: (t) => (t.startsWith("opinion") ? VERDICT({ verdict: "not_a_claim", false_alarm_reason: "opinion" }) : VERDICT()), rewrite });
    // The gate: candidate (claimThreshold 0.9) stops flagging opinions (asked at 0.8) but keeps the real claim (0.95).
    const ask = async (state: any) => ({
      answers: ans({ ...FLAG, claim: String(state.new_utterance.text).startsWith("opinion") ? 0.8 : 0.95 }),
      id: "", model: "", provider: "", usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
    });
    const h = checker({ s2, ask });
    uN = 0;
    h.say("real claim", ans({ ...FLAG, claim: 0.95 }), utt("real claim", 5_000));
    for (let i = 1; i <= 3; i++) h.say(`opinion ${i}`, ans({ ...FLAG, claim: 0.8 }), utt(`opinion ${i}`, 5_000 + i * 5_000));
    expect(h.fc.questions().version).toBe("s1@1");
    await h.fc.drain();
    const ev = h.of("s1.version")[0].data;
    expect(ev).toMatchObject({ outcome: "promoted", active: "s1@2", parent: "s1@1", rationale: "because" });
    expect(ev.gate).toMatchObject({ G: 1, F: 3, G2: 1, F2: 0, promote: true });
    expect(h.fc.active.thresholds.claimThreshold).toBe(0.9);
    // the next utterance is asked and judged with s1@2
    expect(h.fc.questions().version).toBe("s1@2");
    h.say("opinion 4", ans({ ...FLAG, claim: 0.8 }), utt("opinion 4", 30_000));
    expect(h.of("claim.flagged").length).toBe(4);
    expect(h.rows.filter((r) => r.file === "s1_versions").map((r) => r.row.id)).toEqual(["s1@1", "s1@2"]);

    const memBefore = h.fc.memoryQuestions;
    expect(memBefore.length).toBe(4);
    h.fc.rollback("s1@1");
    expect(h.fc.questions().version).toBe("s1@1");
    expect(h.fc.memoryQuestions).toEqual(memBefore);
    expect(h.of("s1.version").at(-1)!.data).toMatchObject({ outcome: "rollback", active: "s1@1" });
    h.fc.rollback("s1@2");
    expect(h.fc.active.id).toBe("s1@2");
    expect(() => h.fc.rollback("s1@9")).toThrow();
  });

  test("a rejected candidate cannot be restored", async () => {
    const rewrite: S2Api["rewrite"] = async () => proposal(change({ op: "set_threshold", target: "claimThreshold", number: 0.5 }));
    const { s2 } = fakeS2({ verdict: () => VERDICT({ verdict: "not_a_claim", false_alarm_reason: "opinion" }), rewrite });
    const ask = async () => ({ answers: ans(FLAG), id: "", model: "", provider: "", usage: { input_tokens: 0, output_tokens: 0, cost: 0 } });
    const h = checker({ s2, ask });
    for (let i = 0; i < 3; i++) h.say(`opinion ${i}`, ans(FLAG));
    await h.fc.drain();
    expect(h.of("s1.version")[0].data).toMatchObject({ outcome: "rejected", active: "s1@1", candidate: "s1@2" });
    expect(() => h.fc.rollback("s1@2")).toThrow(/rejected/);
  });
});

// ---------- the S2 client ----------

import { Budget } from "../src/budget.ts";
import { CHAT_URL, S2Client, type S2CallRow } from "../src/factcheck/s2.ts";

describe("S2 client", () => {
  const completion = (content: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
    id: "gen-1", model: "openai/gpt-6-luna-20260601", provider: "OpenAI",
    choices: [{ message: { role: "assistant", content: JSON.stringify(content), annotations: [{ type: "url_citation", url_citation: { url: "https://src", title: "Src" } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 }, prompt_tokens_details: { cached_tokens: 10 }, cost: 0.001 },
    ...extra,
  }), { status: 200 });

  function client(responses: (() => Response)[]) {
    const bodies: any[] = [];
    const rows: S2CallRow[] = [];
    const f = (async (url: string, init: RequestInit) => {
      expect(url).toBe(CHAT_URL);
      bodies.push(JSON.parse(init.body as string));
      return responses.shift()!();
    }) as unknown as typeof fetch;
    const budget = new Budget({ sessionCapUsd: 5, devCapUsd: 3, enforceDevCap: true, devSpentUsd: 0 });
    const c = new S2Client(cfg.app.s2, { fetch: f, apiKey: "k", budget, log: (r) => rows.push(r), sleep: async () => {}, today: () => "24 September 2026" });
    return { c, bodies, rows, budget };
  }

  test("research request shape, citation merge, and call row", async () => {
    const { c, bodies, rows, budget } = client([() => completion({ ...VERDICT(), sources: [] })]);
    const v = await c.research({ claim_id: "c_1", speaker: "Daniel", utterance: "Jev is 445 times cheaper", segment: "x".repeat(3000) });
    expect(v.sources).toEqual([{ url: "https://src", title: "Src" }]);
    const b = bodies[0];
    expect(b.model).toBe("openai/gpt-6-luna");
    expect(b.reasoning).toEqual({ effort: "medium" });
    expect(b.provider).toEqual({ order: ["openai"], allow_fallbacks: false, require_parameters: true, data_collection: "deny" });
    expect(b.plugins).toEqual([{ id: "web", engine: "exa", max_results: 5 }]);
    expect(b.response_format.type).toBe("json_schema");
    expect(b.response_format.json_schema).toMatchObject({ name: "verdict", strict: true });
    expect(b.temperature).toBeUndefined();
    expect(b.messages[0].content).toContain("Today is 24 September 2026.");
    expect(b.messages[1].content.length).toBeLessThan(1600);
    expect(rows[0]).toMatchObject({ kind: "s2_call", purpose: "research", claim_id: "c_1", ok: true, cost_usd: 0.001, provider_returned: "OpenAI",
      usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 20, cached_tokens: 10, cost: 0.001 } });
    expect(budget.totals().s2).toBeCloseTo(0.001);
  });

  test("audit and rewrite omit the web plugin", async () => {
    const { c, bodies } = client([() => completion({ items: [] }), () => completion({ changes: [], rationale: "r" })]);
    await c.audit([{ utterance_id: "u_1", speaker: "A", text: "t" }]);
    await c.rewrite("input");
    expect(bodies[0].plugins).toBeUndefined();
    expect(bodies[0].reasoning).toEqual({ effort: "low" });
    expect(bodies[1].plugins).toBeUndefined();
  });

  test("falls back to json_object when strict output is rejected with the web plugin", async () => {
    const { c, bodies } = client([
      () => new Response(JSON.stringify({ error: { code: 400, message: "json_schema not supported with plugins" } }), { status: 400 }),
      () => completion(VERDICT()),
      () => completion(VERDICT()),
    ]);
    expect((await c.research({ speaker: "A", utterance: "u", segment: "" })).verdict).toBe("supported");
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].messages[0].content).toBe(bodies[0].messages[0].content); // system prompt byte-identical
    await c.research({ speaker: "A", utterance: "u", segment: "" });
    expect(bodies[2].response_format).toEqual({ type: "json_object" }); // sticky
  });
});
