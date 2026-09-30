import { describe, expect, it } from "vitest";
import { CLAIM_TYPE_KEYS, type AppConfig, type S1Set } from "../src/config.ts";
import { applyRewrite, FactChecker, flagDecision, KNOWN_CRITERIA, S1_BASE_IDS, versionQuestions, type S2Api } from "../src/factcheck/s1.ts";
import type { RewriteProposal } from "../src/factcheck/s2.ts";
import { deferred } from "./fakes/async.ts";
import {
  ans, change, checker, FALSE_ALARM, fakeS2, fcConfig as cfg, FLAG, jevRes, NOFLAG, proposal, settle, VERDICT,
} from "./fakes/factcheck.ts";

const app = (f: Partial<AppConfig["factcheck"]> = {}, s2: Partial<AppConfig["s2"]> = {}): AppConfig =>
  ({ ...cfg.app, factcheck: { ...cfg.app.factcheck, ...f }, s2: { ...cfg.app.s2, ...s2 } });
const withAttention = (n: number[]): S1Set => {
  const s = structuredClone(cfg.s1) as any;
  for (const i of n) s.questions[`attention_${i}`] = { type: "noul", instructions: `attend ${i}` };
  return s;
};

describe("flagDecision", () => {
  it("no answers → flag false, claimType null, priority 0", () => {
    expect(flagDecision({}, cfg.s1, 0.6)).toEqual({ flag: false, priority: 0, claim: 0, claimType: null, worth: 0, hedged: 0, public: 0, attention: false });
  });

  it("hedged exactly at hedgedThreshold adds 0.5; attention below attentionThreshold adds 0", () => {
    const v = withAttention([1]);
    expect(flagDecision(ans({ ...FLAG, hedged: 0.6 }), v, 0.6).priority).toBe(3.5);
    expect(flagDecision(ans({ ...FLAG, hedged: 0.59 }), v, 0.6).priority).toBe(3);
    expect(flagDecision(ans({ ...FLAG, attention_1: 0.69 }), v, 0.6)).toMatchObject({ priority: 3, attention: false });
    expect(flagDecision(ans({ ...FLAG, attention_1: 0.7 }), v, 0.6)).toMatchObject({ priority: 4, attention: true });
  });

  it("ignores attention_* answers for questions not in the version", () => {
    expect(flagDecision(ans({ ...FLAG, attention_2: 1 }), withAttention([1]), 0.6)).toMatchObject({ attention: false, priority: 3 });
  });

  it("a claim answered with the wrong type counts as 0", () => {
    const a = ans(FLAG);
    a.claim = { type: "choice", choice: "yes", confidence: 1, probabilities: {} };
    expect(flagDecision(a, cfg.s1, 0.6)).toMatchObject({ flag: false, claim: 0 });
  });

  it("uses 0.5 when thresholds.publicThreshold is undefined (sets from before the question)", () => {
    const v = structuredClone(cfg.s1) as any;
    delete v.thresholds.publicThreshold;
    expect(flagDecision(ans({ ...FLAG, public: 0.5 }), v, 0.6).flag).toBe(true);
    expect(flagDecision(ans({ ...FLAG, public: 0.49 }), v, 0.6).flag).toBe(false);
  });

  it("versionQuestions is a shallow copy of the version's questions", () => {
    const q = versionQuestions(cfg.s1);
    expect(q).toEqual(cfg.s1.questions);
    expect(q).not.toBe(cfg.s1.questions);
    expect(S1_BASE_IDS).toEqual(["claim", "claim_type", "public", "hedged", "worth"]);
  });
});

describe("applyRewrite", () => {
  const errs = (active: S1Set, p: RewriteProposal): string[] => {
    const r = applyRewrite(active, p);
    return r.ok ? [] : r.errors;
  };
  const set = (active: S1Set, p: RewriteProposal) => {
    const r = applyRewrite(active, p);
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.set;
  };
  const keys = [...CLAIM_TYPE_KEYS];

  it("no changes, or more than 3, reject the whole rewrite", () => {
    expect(errs(cfg.s1, proposal())).toEqual(["no changes proposed"]);
    const t = change({ op: "set_threshold", target: "worthMin", number: 2 });
    expect(errs(cfg.s1, proposal(t, t, t, t))).toEqual(["4 changes; at most 3 are allowed"]);
  });

  it("a blank set_instructions text → 'instructions must not be empty'", () => {
    expect(errs(cfg.s1, proposal(change({ op: "set_instructions", target: "claim", text: "   " })))).toEqual(["instructions must not be empty"]);
    expect(set(cfg.s1, proposal(change({ op: "set_instructions", target: "hedged", text: "x".repeat(400) }))).questions.hedged.instructions).toHaveLength(400);
  });

  it("set_instructions and set_criteria may target 'public'; set_threshold may target publicThreshold", () => {
    const s = set(cfg.s1, proposal(
      change({ op: "set_instructions", target: "public", text: "About the public world." }),
      change({ op: "set_criteria", target: "public", true_text: "public", false_text: "private" }),
      change({ op: "set_threshold", target: "publicThreshold", number: 0.8 }),
    ));
    expect(s.questions.public).toEqual({ type: "noul", instructions: "About the public world.", criteria: { true: "public", false: "private" } });
    expect(s.thresholds.publicThreshold).toBe(0.8);
  });

  it("blank criteria texts → 'criteria descriptions must not be empty'", () => {
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "claim", true_text: " ", false_text: "f" })))).toEqual(["criteria descriptions must not be empty"]);
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "hedged", true_text: "t", false_text: "" })))).toEqual(["criteria descriptions must not be empty"]);
  });

  it("claim_type: a duplicated key → 'exactly'; a blank description → 'descriptions must not be empty'; keys come out in CLAIM_TYPE_KEYS order", () => {
    const dup = [...keys.slice(0, 6), keys[0]!].map((key) => ({ key, description: "d" }));
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "claim_type", options: dup })))[0]).toMatch(/^claim_type options must list exactly /);
    const blank = keys.map((key) => ({ key, description: key === "event" ? "  " : "d" }));
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "claim_type", options: blank })))).toEqual(["claim_type descriptions must not be empty"]);
    const reversed = [...keys].reverse().map((key) => ({ key, description: `about ${key}` }));
    const s = set(cfg.s1, proposal(change({ op: "set_criteria", target: "claim_type", options: reversed })));
    expect(Object.keys(s.questions.claim_type.criteria)).toEqual(keys);
    expect(s.questions.claim_type.criteria.none).toBe("about none");
  });

  it("a blank worth level → 'worth levels must not be empty'; an extra field → 'must leave'", () => {
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "worth", levels: ["a", "b", "", "d", "e"] })))).toEqual(["worth levels must not be empty"]);
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "worth", levels: ["a", "b"] })))).toEqual(["worth needs exactly 5 levels, got 2"]);
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "worth", levels: ["a", "b", "c", "d", "e"], text: "x" })))).toEqual(["set_criteria on worth must leave text null"]);
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "claim_type", options: [], number: 1 })))).toEqual(["set_criteria on claim_type must leave number null"]);
    expect(errs(cfg.s1, proposal(change({ op: "set_criteria", target: "claim", true_text: "t", false_text: "f", levels: [] })))).toEqual(["set_criteria on claim must leave levels null"]);
  });

  it("add_attention: over 400 characters, a blank text; with both texts the criteria are set", () => {
    expect(errs(cfg.s1, proposal(change({ op: "add_attention", target: "new", text: "x".repeat(401) })))).toEqual(["attention instructions exceed 400 characters"]);
    expect(errs(cfg.s1, proposal(change({ op: "add_attention", target: "new", text: " " })))).toEqual(["instructions must not be empty"]);
    expect(errs(cfg.s1, proposal(change({ op: "add_attention", target: "new", text: "x", false_text: "f" })))).toEqual(["add_attention needs both true_text and false_text, or neither"]);
    expect(errs(cfg.s1, proposal(change({ op: "add_attention", target: "new", text: "x", number: 1 })))).toEqual(["add_attention on new must leave number null"]);
    const s = set(cfg.s1, proposal(change({ op: "add_attention", target: "new", text: "Mentions a price", true_text: "yes", false_text: "no" })));
    expect(s.questions.attention_1).toEqual({ type: "noul", instructions: "Mentions a price", criteria: { true: "yes", false: "no" } });
  });

  it("add_attention after a remove in the same proposal numbers max + 1 (attention_4 when 1 and 3 remain)", () => {
    const s = set(withAttention([1, 2, 3]), proposal(
      change({ op: "remove_attention", target: "attention_2" }),
      change({ op: "add_attention", target: "new", text: "new one" }),
    ));
    expect(Object.keys(s.questions).filter((k) => k.startsWith("attention_"))).toEqual(["attention_1", "attention_3", "attention_4"]);
  });

  it("remove_attention on 'claim' → no question; with a field set → must leave null", () => {
    expect(errs(cfg.s1, proposal(change({ op: "remove_attention", target: "claim" })))).toEqual(["remove_attention: no question claim"]);
    expect(errs(withAttention([1]), proposal(change({ op: "remove_attention", target: "attention_1", text: "x" })))).toEqual(["remove_attention on attention_1 must leave text null"]);
  });

  it("thresholds are inclusive at 0.5 and 0.9 (1 and 3 for worthMin); NaN is outside", () => {
    for (const [target, n] of [["claimThreshold", 0.5], ["claimThreshold", 0.9], ["attentionThreshold", 0.5], ["worthMin", 1], ["worthMin", 3]] as const) {
      expect(set(cfg.s1, proposal(change({ op: "set_threshold", target, number: n }))).thresholds[target]).toBe(n);
    }
    expect(errs(cfg.s1, proposal(change({ op: "set_threshold", target: "claimThreshold", number: Number.NaN })))).toEqual(["claimThreshold NaN is outside [0.5, 0.9]"]);
    expect(errs(cfg.s1, proposal(change({ op: "set_threshold", target: "worthMin", number: 0.99 })))).toEqual(["worthMin 0.99 is outside [1, 3]"]);
  });

  it("collects every error from several bad changes", () => {
    expect(errs(cfg.s1, proposal(
      change({ op: "set_instructions", target: "boundary", text: "x" }),
      change({ op: "set_threshold", target: "hedgedThreshold", number: 0.6 }),
      change({ op: "add_attention", target: "attention_9", text: "x" }),
    ))).toEqual(["set_instructions cannot target boundary", "set_threshold cannot target hedgedThreshold", 'add_attention must target "new"']);
  });

  it("add_attention with true_text '' and false_text '' fails the final schema parse", () => {
    const e = errs(cfg.s1, proposal(change({ op: "add_attention", target: "new", text: "x", true_text: "", false_text: "" })));
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/attention_1|too_small|>=1/);
  });

  it("does not mutate the active set", () => {
    const active = structuredClone(cfg.s1);
    const before = JSON.stringify(active);
    set(active, proposal(
      change({ op: "set_instructions", target: "claim", text: "changed" }),
      change({ op: "add_attention", target: "new", text: "x" }),
      change({ op: "set_threshold", target: "worthMin", number: 2 }),
    ));
    expect(JSON.stringify(active)).toBe(before);
  });
});

describe("FactChecker: System 1", () => {
  it("the constructor writes the default s1@1 row with createdAt = ISO(now())", () => {
    const h = checker({ now: () => Date.parse("2026-09-30T08:00:00Z") });
    expect(h.rows).toEqual([{ file: "s1_versions", row: { ...cfg.s1, parent: null, kind: "default", createdAt: "2026-09-30T08:00:00.000Z", rationale: "default", gate: null, status: "default" } }]);
    expect(h.fc.active.id).toBe("s1@1");
    expect(h.fc.versions).toHaveLength(1);
  });

  it("defaults to Date.now and Math.random without injected ones", () => {
    const rows: any[] = [];
    const before = Date.now();
    new FactChecker({
      app: cfg.app, s1Default: cfg.s1, s2: fakeS2().s2, ask: async () => jevRes({}), emit: () => {}, write: (_f, r) => rows.push(r),
      speakerName: (id) => id, stateOf: () => undefined, onError: () => {},
    });
    expect(Date.parse(rows[0].createdAt)).toBeGreaterThanOrEqual(before - 1);
  });

  it("claim.flagged carries every field; the claims row is queued; the segment text leaves out failed lines and uses display names", async () => {
    const { s2, calls } = fakeS2();
    const h = checker({ s2, now: () => Date.parse("2026-09-30T08:00:00Z"), speakerName: (id) => ({ spk_1: "Nic", spk_2: "Anna" })[id] ?? id });
    const a = h.utt("Earlier line", 2000, { speakerId: "spk_1" });
    const failed = h.utt("", 3000, { speakerId: "spk_1", failed: true });
    const u = h.utt("GPT-6 costs $3 per million tokens", 6000);
    h.say(u.text, ans({ ...FLAG, hedged: 0.7 }), u, [a, failed, u]);
    expect(h.of("claim.flagged")[0]!.data).toEqual({
      claimId: "c_1", utteranceId: u.id, speakerId: "spk_2", text: u.text, priority: 3.5, claimType: "number_or_price",
      worth: 3, hedged: 0.7, claim: 0.9, attention: false, s1Version: "s1@1",
    });
    expect(h.rows.find((r) => r.file === "claims")!.row).toEqual({
      kind: "claim", id: "c_1", utterance_id: u.id, speaker_id: "spk_2", text: u.text, s1_version: "s1@1", priority: 3.5,
      claim_type: "number_or_price", worth: 3, hedged: 0.7, status: "queued", grade: null, disputed: false, drop_reason: null,
      at: "2026-09-30T08:00:00.000Z",
    });
    await h.fc.drain();
    expect(calls.research[0]).toEqual({ claim_id: "c_1", speaker: "Anna", utterance: u.text, segment: `Nic: Earlier line\nAnna: ${u.text}` });
  });

  it("fillers are neither flagged into the pool nor audited; repeats and duplicates are not in the audit pool", async () => {
    const { s2, calls } = fakeS2({ verdict: () => new Promise(() => {}) }); // research never ends: c_1 stays pending
    const h = checker({ s2, app: app({ auditIntervalMs: 100_000, auditMinUtterances: 2, auditSample: 10 }) });
    h.say("claim", ans(FLAG), h.utt("claim", 10_000));
    h.say("yeah", ans(NOFLAG), h.utt("yeah", 20_000, { filler: true }));
    h.say("same claim", ans({ ...NOFLAG, known_c_1: 0.9 }), h.utt("same claim", 30_000));
    h.say("line a", ans(NOFLAG), h.utt("line a", 40_000));
    h.say("line b", ans(NOFLAG), h.utt("line b", 100_000));
    await settle();
    expect(calls.audit).toHaveLength(1);
    expect(calls.audit[0]!.map((i) => i.text)).toEqual(["line a", "line b"]);
  });

  it("a memory match picks the highest known_* above the threshold among several", () => {
    const { s2 } = fakeS2({ verdict: () => new Promise(() => {}) });
    const h = checker({ s2 });
    h.say("one", ans(FLAG));
    h.say("two", ans(FLAG));
    h.say("three", ans(FLAG));
    h.say("which?", ans({ ...FLAG, known_c_1: 0.7, known_c_2: 0.95, known_c_3: 0.5 }));
    expect(h.of("claim.duplicate").map((e) => e.data)).toEqual([
      { claimId: "c_2", utteranceId: "u_4", speakerId: "spk_2", text: "which?", match: 0.95, status: "researching" },
    ]);
    expect(h.fc.claims.get("c_2")!.duplicates).toEqual(["u_4"]);
    expect(h.fc.stats().duplicates).toBe(1);
  });

  it("questions() lists the version's questions then one memory question per claim", () => {
    const { s2 } = fakeS2({ verdict: () => new Promise(() => {}) });
    const h = checker({ s2 });
    h.say('He said "maybe"', ans(FLAG));
    const q = h.fc.questions();
    expect(q.version).toBe("s1@1");
    expect(q.questions.known_c_1).toEqual({ type: "noul", instructions: 'Judge only new_utterance. It restates or relies on this already-checked claim: "He said "maybe""', criteria: KNOWN_CRITERIA });
    expect(h.fc.memoryQuestions).toEqual([{ claimId: "c_1", text: 'He said "maybe"' }]);
  });

  it("clockMs never goes backwards with out-of-order endMs", async () => {
    const { s2, calls } = fakeS2({ verdict: () => FALSE_ALARM() });
    const h = checker({ s2, ask: async () => jevRes(ans(NOFLAG)), app: app({ rewriteOnFalseAlarms: 1, rewriteCooldownMs: 100_000, auditIntervalMs: 10_000_000 }) });
    h.say("opinion A", ans(FLAG), h.utt("opinion A", 150_000));
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(1);
    h.say("opinion B", ans(FLAG), h.utt("opinion B", 300_000));
    h.say("late line", ans(NOFLAG), h.utt("late line", 50_000)); // arrives late: the clock stays at 300 s
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(2);
  });
});

describe("FactChecker: research", () => {
  it("a research failure → onError('s2', …, { claim_id, purpose: 'research' }), claim.dropped research_failed, counted as dropped and researched", async () => {
    const { s2 } = fakeS2({ verdict: () => { throw new Error("OpenRouter 500"); } });
    const h = checker({ s2 });
    h.say("a claim", ans(FLAG));
    await h.fc.drain();
    expect(h.errors).toEqual([{ component: "s2", message: "OpenRouter 500", detail: { claim_id: "c_1", purpose: "research" } }]);
    expect(h.of("claim.dropped").map((e) => e.data)).toEqual([{ claimId: "c_1", reason: "research_failed" }]);
    expect(h.rows.filter((r) => r.file === "claims").map((r) => [r.row.status, r.row.drop_reason])).toEqual([["queued", null], ["researching", null], ["dropped", "research_failed"]]);
    expect(h.fc.stats()).toMatchObject({ flagged: 1, researched: 1, dropped: 1 });
  });

  it("a research failure that is not an Error is reported as its string", async () => {
    const s2: S2Api = { ...fakeS2().s2, research: () => Promise.reject("socket closed") };
    const h = checker({ s2 });
    h.say("a claim", ans(FLAG));
    await h.fc.drain();
    expect(h.errors[0]!.message).toBe("socket closed");
  });

  it("a verdict with a blank restated_claim leaves the memory text unchanged (no update event)", async () => {
    const { s2 } = fakeS2({ verdict: () => VERDICT({ restated_claim: "   " }) });
    const h = checker({ s2 });
    h.say("original words", ans(FLAG));
    await h.fc.drain();
    expect(h.of("s1.memory").map((e) => e.data.action)).toEqual(["add"]);
    expect(h.fc.memoryQuestions[0]!.text).toBe("original words");
  });

  it("a verdict for an evicted memory claim emits no update", async () => {
    const h = checker({ app: app({ maxKnownQuestions: 1 }) });
    h.say("first", ans(FLAG));
    h.say("second", ans(FLAG)); // evicts c_1 before its verdict arrives
    await h.fc.drain();
    const mem = h.of("s1.memory").map((e) => `${e.data.action}:${e.data.claimId}`);
    expect(mem).toEqual(["add:c_1", "add:c_2", "evict:c_1", "update:c_2"]);
  });

  it("the verdicts row has the grade and latency_ms = the now() delta", async () => {
    let t = 1_000;
    const gate = deferred();
    const { s2 } = fakeS2({ verdict: async () => { await gate.promise; return FALSE_ALARM(); } });
    const h = checker({ s2, now: () => t });
    h.say("a claim", ans(FLAG));
    t = 4_000;
    gate.resolve();
    await h.fc.drain();
    const row = h.rows.find((r) => r.file === "verdicts")!.row;
    expect(row).toMatchObject({ kind: "verdict", claim_id: "c_1", utterance_id: "u_1", verdict: "not_a_claim", grade: "false_alarm", latency_ms: 3000 });
    expect(h.of("claim.verdict")[0]!.data).toMatchObject({ claimId: "c_1", grade: "false_alarm", latencyMs: 3000 });
  });

  it("queue drops (session_cap, stale, stopped) mark the claim dropped with that reason and emit claim.dropped", async () => {
    // session cap: one research per session, one worker
    const h = checker({ app: app({}, { maxResearchPerSession: 1, researchConcurrency: 1 }) });
    h.say("first", ans(FLAG));
    h.say("second", ans(FLAG));
    await h.fc.drain();
    expect(h.of("claim.dropped").map((e) => e.data)).toEqual([{ claimId: "c_2", reason: "session_cap" }]);
    expect(h.fc.claims.get("c_2")).toMatchObject({ status: "dropped", dropReason: "session_cap" });

    // stale: the second claim waits past staleAfterMs while the first is researched
    let t = 0;
    const timers: (() => void)[] = [];
    const hold = deferred();
    const { s2 } = fakeS2({ verdict: async () => { await hold.promise; return VERDICT(); } });
    const s = checker({ s2, now: () => t, setTimer: (fn) => timers.push(fn), app: app({}, { researchConcurrency: 1 }) });
    s.say("busy", ans(FLAG));
    s.say("waiting", ans(FLAG));
    t = cfg.app.s2.staleAfterMs + 1;
    timers[0]!();
    expect(s.of("claim.dropped").map((e) => e.data)).toEqual([{ claimId: "c_2", reason: "stale" }]);

    // stopped: stop() drops what is queued, and every later flag
    s.fc.stop();
    s.say("after stop", ans(FLAG));
    expect(s.of("claim.dropped").map((e) => e.data.reason)).toEqual(["stale", "stopped"]);
    expect(s.fc.stats().dropped).toBe(2);
    hold.resolve();
    await s.fc.drain();
  });

  it("the queue ignores an item whose claim it does not know (research and drop)", async () => {
    const h = checker();
    h.fc.queue.enqueue({ claimId: "ghost", priority: 1, flaggedAt: Date.now() });
    await h.fc.drain();
    h.fc.stop();
    h.fc.queue.enqueue({ claimId: "ghost2", priority: 1, flaggedAt: Date.now() });
    expect(h.events).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("a duplicate of a dropped claim reports status 'dropped'", async () => {
    const { s2 } = fakeS2({ verdict: () => { throw new Error("down"); } });
    const h = checker({ s2 });
    h.say("claim", ans(FLAG));
    await h.fc.drain();
    h.say("claim again", ans({ ...NOFLAG, known_c_1: 0.8 }));
    expect(h.of("claim.duplicate")[0]!.data).toMatchObject({ claimId: "c_1", status: "dropped" });
  });

  it("override without a note emits note:null; before the verdict it throws 'has no verdict yet'", async () => {
    const gate = deferred();
    const { s2 } = fakeS2({ verdict: async () => { await gate.promise; return VERDICT(); } });
    const h = checker({ s2 });
    h.say("claim", ans(FLAG));
    expect(() => h.fc.override("c_1")).toThrow("claim c_1 has no verdict yet");
    expect(() => h.fc.override("c_9")).toThrow("unknown claim c_9");
    gate.resolve();
    await h.fc.drain();
    const c = h.fc.override("c_1");
    expect(c.disputed).toBe(true);
    expect(c.note).toBeUndefined();
    expect(h.of("claim.disputed")[0]!.data).toEqual({ claimId: "c_1", note: null });
    expect(h.rows.filter((r) => r.file === "claims").at(-1)!.row).toMatchObject({ disputed: true, grade: "good_flag", status: "verdict" });
    h.say("claim once more", ans({ ...NOFLAG, known_c_1: 0.9 }));
    expect(h.of("claim.repeat")[0]!.data).toMatchObject({ claimId: "c_1", disputed: true, verdict: { verdict: "supported" } });
  });

  it("stats counts verdicts by kind, and disputed claims", async () => {
    const kinds = { a: "supported", b: "contradicted", c: "misleading", d: "misleading", e: "not_a_claim" } as const;
    const { s2 } = fakeS2({ verdict: (t) => VERDICT({ verdict: kinds[t as keyof typeof kinds] }) });
    const h = checker({ s2 });
    for (const t of Object.keys(kinds)) h.say(t, ans(FLAG));
    await h.fc.drain();
    h.fc.override("c_2", "no");
    expect(h.fc.stats()).toEqual({
      flagged: 5, researched: 5, verdicts: { supported: 1, contradicted: 1, misleading: 2, unverifiable: 0, not_a_claim: 1 },
      repeats: 0, duplicates: 0, dropped: 0, goodFlags: 3, falseAlarms: 1, misses: 0, disputed: 1, promoted: 0, rejected: 0,
    });
  });

  it("drain(maxMs) returns false when research never resolves", async () => {
    const { s2 } = fakeS2({ verdict: () => new Promise(() => {}) });
    const h = checker({ s2 });
    h.say("claim", ans(FLAG));
    expect(await h.fc.drain(20)).toBe(false);
    expect(await checker().fc.drain(20)).toBe(true);
  });
});

describe("FactChecker: audits", () => {
  const auditApp = (f: Partial<AppConfig["factcheck"]> = {}) => app({ auditIntervalMs: 100_000, auditMinUtterances: 2, auditSample: 10, ...f });

  it("an audit failure → onError('s2', …, { purpose: 'audit' }) and no misses", async () => {
    const { s2 } = fakeS2({ audit: async () => { throw new Error("audit down"); } });
    const h = checker({ s2, app: auditApp() });
    h.say("a", ans(NOFLAG), h.utt("a", 50_000));
    h.say("b", ans(NOFLAG), h.utt("b", 100_000));
    await h.fc.drain();
    expect(h.errors).toEqual([{ component: "s2", message: "audit down", detail: { purpose: "audit" } }]);
    expect(h.fc.stats().misses).toBe(0);
    expect(h.of("audit")).toEqual([]);
  });

  it("an audit failure that is not an Error is reported as its string", async () => {
    const s2: S2Api = { ...fakeS2().s2, audit: () => Promise.reject("gone") };
    const h = checker({ s2, app: auditApp() });
    h.say("a", ans(NOFLAG), h.utt("a", 50_000));
    h.say("b", ans(NOFLAG), h.utt("b", 100_000));
    await h.fc.drain();
    expect(h.errors[0]!.message).toBe("gone");
  });

  it("an audit ignores returned items whose utterance_id was not sampled; its row and event list what came back", async () => {
    const { s2 } = fakeS2({
      audit: async (items) => ({ items: [...items.map((i) => ({ utterance_id: i.utterance_id, has_checkable_claim: true, worth: "high" as const })), { utterance_id: "u_99", has_checkable_claim: true, worth: "high" as const }] }),
    });
    const h = checker({ s2, app: auditApp(), now: () => Date.parse("2026-09-30T08:00:00Z") });
    h.say("a", ans(NOFLAG), h.utt("a", 50_000));
    h.say("b", ans(NOFLAG), h.utt("b", 100_000));
    await h.fc.drain();
    expect(h.of("audit")[0]!.data).toMatchObject({ sampled: 2, misses: ["u_1", "u_2"] });
    expect(h.of("audit")[0]!.data.items).toHaveLength(3);
    expect(h.rows.find((r) => r.file === "audits")!.row).toMatchObject({ kind: "audit", sampled: ["u_1", "u_2"], misses: ["u_1", "u_2"], at: "2026-09-30T08:00:00.000Z" });
    expect(h.fc.stats().misses).toBe(2);
  });

  it("the sample is drawn with rand (0 takes the pool in order; ~1 takes it from the end), capped at auditSample", async () => {
    for (const [rand, expected] of [[() => 0, ["l0", "l1", "l2"]], [() => 0.999, ["l4", "l3", "l2"]]] as const) {
      const { s2, calls } = fakeS2();
      const h = checker({ s2, rand, app: auditApp({ auditSample: 3 }) });
      for (let i = 0; i < 5; i++) h.say(`l${i}`, ans(NOFLAG), h.utt(`l${i}`, 20_000 * (i + 1)));
      await h.fc.drain();
      expect(calls.audit[0]!.map((x) => x.text)).toEqual(expected);
    }
  });

  it("a too-small pool is kept and audited at a later interval together with newer lines", async () => {
    const { s2, calls } = fakeS2();
    const h = checker({ s2, app: auditApp({ auditMinUtterances: 3 }) });
    h.say("a", ans(NOFLAG), h.utt("a", 60_000));
    h.say("b", ans(NOFLAG), h.utt("b", 100_000)); // interval reached with 2 < 3: kept
    h.say("c", ans(NOFLAG), h.utt("c", 150_000));
    await h.fc.drain();
    expect(calls.audit).toHaveLength(0);
    h.say("d", ans(NOFLAG), h.utt("d", 200_000));
    await h.fc.drain();
    expect(calls.audit.map((a) => a.map((x) => x.text))).toEqual([["a", "b", "c", "d"]]);
  });

  it("2 audit misses trigger a rewrite", async () => {
    const { s2, calls } = fakeS2({ audit: async (items) => ({ items: items.map((i) => ({ utterance_id: i.utterance_id, has_checkable_claim: true, worth: "medium" as const })) }) });
    const h = checker({ s2, app: auditApp() });
    h.say("a", ans(NOFLAG), h.utt("a", 50_000));
    h.say("b", ans(NOFLAG), h.utt("b", 100_000));
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(1);
    expect(JSON.parse(calls.rewrite[0]!).misses).toEqual(["a", "b"]);
  });
});

describe("FactChecker: rewrites and the gate", () => {
  const rwApp = (f: Partial<AppConfig["factcheck"]> = {}) => app({ auditIntervalMs: 10_000_000, rewriteCooldownMs: 0, ...f });
  const opinions = (h: ReturnType<typeof checker>, n: number, from = 1) => {
    for (let i = from; i < from + n; i++) h.say(`opinion ${i}`, ans(FLAG), h.utt(`opinion ${i}`, i * 1000));
  };
  const valid = async () => proposal(change({ op: "set_threshold", target: "claimThreshold", number: 0.9 }));

  it("a rewrite failure → onError('s2', …, { purpose: 'rewrite' }), no version recorded, and the cooldown still applies", async () => {
    const { s2, calls } = fakeS2({ verdict: FALSE_ALARM, rewrite: async () => { throw new Error("rewrite down"); } });
    const h = checker({ s2, app: rwApp({ rewriteCooldownMs: 180_000 }) });
    opinions(h, 3);
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(1);
    expect(h.errors).toEqual([{ component: "s2", message: "rewrite down", detail: { purpose: "rewrite" } }]);
    expect(h.fc.versions).toHaveLength(1);
    expect(h.of("s1.version")).toEqual([]);
    h.say("opinion 4", ans(FLAG), h.utt("opinion 4", 100_000));
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(1); // within the cooldown
    h.say("opinion 5", ans(FLAG), h.utt("opinion 5", 3000 + 180_000));
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(2);
  });

  it("gate_failed: stateOf throwing while the gate items are built → onError('gate', …), the candidate is rejected with its errors", async () => {
    const { s2 } = fakeS2({ verdict: FALSE_ALARM, rewrite: valid });
    const h = checker({ s2, app: rwApp(), stateOf: () => { throw new Error("jev_calls.jsonl unreadable"); } });
    opinions(h, 3);
    await h.fc.drain();
    expect(h.errors).toEqual([{ component: "gate", message: "jev_calls.jsonl unreadable", detail: { candidate: "s1@2" } }]);
    expect(h.of("s1.version")[0]!.data).toMatchObject({ outcome: "gate_failed", status: "rejected", active: "s1@1", candidate: "s1@2", errors: ["jev_calls.jsonl unreadable"], gate: null });
    expect(h.fc.stats().rejected).toBe(1);
    expect(h.rows.filter((r) => r.file === "s1_versions").at(-1)!.row).toMatchObject({ id: "s1@2", status: "rejected", errors: ["jev_calls.jsonl unreadable"] });
  });

  it("no second rewrite starts while one is running, even when more evidence arrives", async () => {
    const gate = deferred<RewriteProposal>();
    const { s2, calls } = fakeS2({ verdict: FALSE_ALARM, rewrite: () => gate.promise });
    const h = checker({ s2, app: rwApp() });
    opinions(h, 3);
    await settle(); await settle();
    expect(calls.rewrite).toHaveLength(1);
    opinions(h, 2, 4); // two more false alarms while the rewrite waits
    await settle(); await settle();
    expect(calls.rewrite).toHaveLength(1);
    gate.resolve(proposal());
    await h.fc.drain();
    expect(h.of("s1.version").map((e) => e.data.outcome)).toEqual(["invalid"]);
  });

  it("gate_failed reports a non-Error throw as its string", async () => {
    const { s2 } = fakeS2({ verdict: FALSE_ALARM, rewrite: valid });
    const h = checker({ s2, app: rwApp(), stateOf: () => { throw "no state"; } });
    opinions(h, 3);
    await h.fc.drain();
    expect(h.of("s1.version")[0]!.data).toMatchObject({ outcome: "gate_failed", errors: ["no state"] });
  });

  it("a rewrite failure that is not an Error is reported as its string", async () => {
    const { s2 } = fakeS2({ verdict: FALSE_ALARM, rewrite: () => Promise.reject("nope") });
    const h = checker({ s2, app: rwApp() });
    opinions(h, 3);
    await h.fc.drain();
    expect(h.errors[0]).toMatchObject({ component: "s2", message: "nope" });
  });

  it("evidence restarts after a promotion: false alarms from the old version no longer count", async () => {
    const { s2, calls } = fakeS2({ verdict: FALSE_ALARM, rewrite: valid });
    const h = checker({ s2, app: rwApp(), ask: async () => jevRes(ans(NOFLAG)) });
    opinions(h, 3);
    await h.fc.drain();
    expect(h.of("s1.version")[0]!.data).toMatchObject({ outcome: "promoted", active: "s1@2" });
    expect(calls.rewrite).toHaveLength(1);
    expect(JSON.parse(h.fc.rewriteInput()).false_alarms).toEqual([]);
    opinions(h, 2, 10); // flagged under s1@2 (claim 0.9 ≥ 0.9)
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(1); // 2 < 3, though 5 false alarms in all
    opinions(h, 1, 20);
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(2);
    expect(h.fc.stats().promoted).toBeGreaterThanOrEqual(1);
  });

  it("rollback restarts the evidence count", async () => {
    const { s2, calls } = fakeS2({ verdict: FALSE_ALARM });
    const h = checker({ s2, app: rwApp() });
    opinions(h, 2);
    await h.fc.drain();
    expect(JSON.parse(h.fc.rewriteInput()).false_alarms).toHaveLength(2);
    h.fc.rollback("s1@1");
    expect(JSON.parse(h.fc.rewriteInput()).false_alarms).toHaveLength(0);
    opinions(h, 1, 5);
    await h.fc.drain();
    expect(calls.rewrite).toHaveLength(0); // 1 since the rollback, not 3
    expect(h.of("s1.version").at(-1)!.data).toEqual({ active: "s1@1", candidate: null, outcome: "rollback", status: "default", parent: null, rationale: "default", gate: null, errors: null });
  });

  it("rewriteInput: falls back to all good flags and all misses when the active version has none; keeps the last 10", async () => {
    const { s2 } = fakeS2({ audit: async (items) => ({ items: items.map((i) => ({ utterance_id: i.utterance_id, has_checkable_claim: true, worth: "high" as const })) }) });
    const h = checker({ s2, app: app({ auditIntervalMs: 1_000_000, auditMinUtterances: 12, auditSample: 12, rewriteOnMisses: 100 }) });
    for (let i = 1; i <= 12; i++) h.say(`good ${i}`, ans(FLAG), h.utt(`good ${i}`, i * 1000));
    for (let i = 1; i <= 12; i++) h.say(`quiet ${i}`, ans(NOFLAG), h.utt(`quiet ${i}`, i === 12 ? 1_000_000 : 20_000 + i * 1000));
    await h.fc.drain();
    const own = JSON.parse(h.fc.rewriteInput());
    expect(own.good_flags).toEqual(Array.from({ length: 10 }, (_, i) => `good ${i + 3}`));
    expect(own.misses).toHaveLength(10);
    expect(own.active_questions).toEqual(cfg.s1.questions);
    expect(own.thresholds).toEqual(cfg.s1.thresholds);
    h.fc.rollback("s1@1"); // the evidence restarts: examples fall back to every good flag and miss
    const all = JSON.parse(h.fc.rewriteInput());
    expect(all.good_flags).toEqual(own.good_flags);
    expect(all.misses).toEqual(own.misses);
    expect(all.false_alarms).toEqual([]);
  });

  it("version ids count rejected versions: an invalid s1@2, then the candidate s1@3", async () => {
    const replies: RewriteProposal[] = [proposal(), proposal(change({ op: "set_threshold", target: "claimThreshold", number: 0.5 }))];
    const { s2 } = fakeS2({ verdict: FALSE_ALARM, rewrite: async () => replies.shift()! });
    const h = checker({ s2, app: rwApp(), ask: async () => jevRes(ans(FLAG)) });
    opinions(h, 3);
    await h.fc.drain();
    opinions(h, 1, 4);
    await h.fc.drain();
    expect(h.of("s1.version").map((e) => [e.data.candidate, e.data.outcome])).toEqual([["s1@2", "invalid"], ["s1@3", "rejected"]]);
    expect(h.of("s1.version")[0]!.data.errors).toEqual(["no changes proposed"]);
    expect(h.fc.versions.map((v) => v.id)).toEqual(["s1@1", "s1@2", "s1@3"]);
  });

  it("gateItems: drops items without a logged state, sorts newest first, caps at replayMaxItems, includes misses", async () => {
    const { s2 } = fakeS2({
      verdict: (t) => (t.startsWith("bad") ? FALSE_ALARM() : VERDICT()),
      audit: async (items) => ({ items: items.map((i) => ({ utterance_id: i.utterance_id, has_checkable_claim: true, worth: "high" as const })) }),
    });
    const h = checker({ s2, app: app({ auditIntervalMs: 100_000, auditMinUtterances: 1, rewriteOnMisses: 100, rewriteOnFalseAlarms: 100, replayMaxItems: 3 }) });
    h.say("good 1", ans(FLAG), h.utt("good 1", 1000));
    h.say("bad 1", ans(FLAG), h.utt("bad 1", 2000));
    h.say("good 2", ans(FLAG), h.utt("good 2", 3000));
    h.say("missed", ans(NOFLAG), h.utt("missed", 100_000));
    await h.fc.drain();
    expect(h.fc.gateItems().map((i) => [i.utteranceId, i.set])).toEqual([["u_4", "M"], ["u_3", "G"], ["u_2", "F"]]);
    h.states.delete("u_3");
    expect(h.fc.gateItems().map((i) => [i.utteranceId, i.set])).toEqual([["u_4", "M"], ["u_2", "F"], ["u_1", "G"]]);
  });

  it("a promoted rewrite's s1_versions row and s1.version event carry the gate metrics", async () => {
    const { s2 } = fakeS2({ verdict: FALSE_ALARM, rewrite: valid });
    const h = checker({ s2, app: rwApp(), ask: async () => jevRes(ans(NOFLAG)), now: () => Date.parse("2026-09-30T09:00:00Z") });
    opinions(h, 3);
    await h.fc.drain();
    const ev = h.of("s1.version")[0]!.data;
    expect(ev).toEqual({
      active: "s1@2", candidate: "s1@2", outcome: "promoted", status: "promoted", parent: "s1@1", rationale: "because",
      gate: { G: 0, F: 3, M: 0, G2: 0, F2: 0, M2: 0, asked: 3, failed: 0, promote: true }, errors: null,
    });
    expect(h.rows.filter((r) => r.file === "s1_versions").at(-1)!.row).toMatchObject({ id: "s1@2", kind: "criteria", createdAt: "2026-09-30T09:00:00.000Z", status: "promoted" });
    expect(h.fc.rollback("s1@2").id).toBe("s1@2");
  });
});
