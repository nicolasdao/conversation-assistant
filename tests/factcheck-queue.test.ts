import { afterEach, describe, expect, it, vi } from "vitest";
import { gateDecision, runGate, type GateItem } from "../src/factcheck/gate.ts";
import { ResearchQueue, type QueueItem } from "../src/factcheck/queue.ts";
import type { JevCallMeta } from "../src/jev/client.ts";
import { deferred } from "./fakes/async.ts";
import { ans, fcConfig as cfg, FLAG, jevRes, NOFLAG, settle } from "./fakes/factcheck.ts";

const HOUR = 3_600_000;

describe("the replay gate (src/factcheck/gate.ts)", () => {
  const items = (spec: string): GateItem[] => spec.split("").map((set, i) => ({ utteranceId: `u_${i}`, set: set as "G" | "F" | "M", state: { i }, order: i }));

  it("runGate counts failures in 'failed', not in G2/F2/M2, and still returns a decision", async () => {
    const r = await runGate(cfg.s1, items("GGF"), {
      hedgedThreshold: 0.6,
      ask: async (state: any) => { if (state.i === 1) throw new Error("jev down"); return jevRes(ans(state.i === 2 ? NOFLAG : FLAG)); },
    });
    expect(r).toEqual({ G: 2, F: 1, M: 0, G2: 1, F2: 0, M2: 0, asked: 2, failed: 1, promote: true }); // floor(1.8) = 1 kept
  });

  it("runGate passes purpose gate, utterance_id and question_set_version = candidate.id, and the candidate's questions", async () => {
    const metas: JevCallMeta[] = [];
    const candidate = { ...structuredClone(cfg.s1), id: "s1@7" };
    await runGate(candidate, items("GM"), { hedgedThreshold: 0.6, ask: async (_s, q, m) => { metas.push(m); expect(Object.keys(q)).toEqual(Object.keys(candidate.questions)); return jevRes(ans(FLAG)); } });
    expect(metas).toEqual([
      { purpose: "gate", utterance_id: "u_0", question_set_version: "s1@7" },
      { purpose: "gate", utterance_id: "u_1", question_set_version: "s1@7" },
    ]);
  });

  it("runGate with no items → all zeros, promote false", async () => {
    const ask = vi.fn();
    expect(await runGate(cfg.s1, [], { ask, hedgedThreshold: 0.6 })).toEqual({ G: 0, F: 0, M: 0, G2: 0, F2: 0, M2: 0, asked: 0, failed: 0, promote: false });
    expect(ask).not.toHaveBeenCalled();
  });

  it("runGate counts M items, and M2 > 0 promotes even with F2 == F", async () => {
    const r = await runGate(cfg.s1, items("GFM"), { hedgedThreshold: 0.6, ask: async () => jevRes(ans(FLAG)) });
    expect(r).toMatchObject({ G: 1, F: 1, M: 1, G2: 1, F2: 1, M2: 1, promote: true });
  });

  it("gateDecision: G=20 needs G2 >= 18; G=0 always passes the keep rule; F=0 and M2=0 never promotes", () => {
    expect(gateDecision({ G: 20, F: 2, M: 0, G2: 18, F2: 1, M2: 0 })).toBe(true);
    expect(gateDecision({ G: 20, F: 2, M: 0, G2: 17, F2: 1, M2: 0 })).toBe(false);
    expect(gateDecision({ G: 0, F: 1, M: 0, G2: 0, F2: 0, M2: 0 })).toBe(true);
    expect(gateDecision({ G: 5, F: 0, M: 0, G2: 5, F2: 0, M2: 0 })).toBe(false);
    expect(gateDecision({ G: 5, F: 0, M: 3, G2: 5, F2: 0, M2: 0 })).toBe(false);
  });

  it("gateDecision: G=1, G2=0, F=1, F2=0 promotes, as the documented formula floor(0.9 × G) says", () => {
    // docs/system1-system2.md: promote ⇔ G′ ≥ floor(0.9 × |G|) AND (F′ < |F| OR M′ > 0). Below 10 good flags the floor
    // lets a candidate lose one good flag (with G = 1, its only one): the formula is the documented rule.
    expect(gateDecision({ G: 1, F: 1, M: 0, G2: 0, F2: 0, M2: 0 })).toBe(true);
    expect(gateDecision({ G: 9, F: 1, M: 0, G2: 8, F2: 0, M2: 0 })).toBe(true);
  });
});

/** A queue on a controllable clock and timer. */
function rig(over: Partial<typeof cfg.app.s2> = {}, research?: (it: QueueItem) => Promise<void>) {
  let t = 1_000_000;
  const researched: string[] = [];
  const dropped: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const q = new ResearchQueue({ ...cfg.app.s2, ...over }, {
    research: research ?? (async (it) => { researched.push(it.claimId); }),
    onDropped: (it, r) => dropped.push(`${it.claimId}:${r}`),
    now: () => t, setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { q, researched, dropped, timers, now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("the research queue (src/factcheck/queue.ts)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("ties are served by the earliest flaggedAt", async () => {
    const hold = deferred();
    const order: string[] = [];
    const { q, now } = rig({ researchConcurrency: 1 }, async (it) => { order.push(it.claimId); if (it.claimId === "first") await hold.promise; });
    q.enqueue({ claimId: "first", priority: 9, flaggedAt: now() });
    q.enqueue({ claimId: "late", priority: 2, flaggedAt: now() - 10 });
    q.enqueue({ claimId: "early", priority: 2, flaggedAt: now() - 20 });
    q.enqueue({ claimId: "mid", priority: 2, flaggedAt: now() - 15 });
    hold.resolve();
    await settle(); await q.drain(); await settle(); await q.drain();
    expect(order).toEqual(["first", "early", "mid", "late"]);
  });

  it("enqueue after stop drops at once with 'stopped'; stop drops queued items but lets in-flight research finish", async () => {
    const hold = deferred();
    let finished = false;
    const { q, dropped, now } = rig({ researchConcurrency: 1 }, async () => { await hold.promise; finished = true; });
    q.enqueue({ claimId: "busy", priority: 1, flaggedAt: now() });
    q.enqueue({ claimId: "waiting", priority: 1, flaggedAt: now() });
    q.stop();
    expect(dropped).toEqual(["waiting:stopped"]);
    q.enqueue({ claimId: "late", priority: 5, flaggedAt: now() });
    expect(dropped).toEqual(["waiting:stopped", "late:stopped"]);
    expect(q.researching).toBe(1);
    hold.resolve();
    await q.drain();
    expect(finished).toBe(true);
    expect(q.researching).toBe(0);
  });

  it("size, researching and researchedCount reflect the queue's state", async () => {
    const hold = deferred();
    const { q, now } = rig({ researchConcurrency: 2 }, () => hold.promise);
    expect([q.size, q.researching, q.researchedCount]).toEqual([0, 0, 0]);
    for (const id of ["a", "b", "c"]) q.enqueue({ claimId: id, priority: 1, flaggedAt: now() });
    expect([q.size, q.researching, q.researchedCount]).toEqual([1, 2, 2]);
    hold.resolve();
    await settle(); await q.drain();
    expect([q.size, q.researching, q.researchedCount]).toEqual([0, 0, 3]);
  });

  it("a rejected research promise is swallowed and the next item starts", async () => {
    const order: string[] = [];
    const { q, now } = rig({ researchConcurrency: 1 }, async (it) => { order.push(it.claimId); if (it.claimId === "bad") throw new Error("boom"); });
    q.enqueue({ claimId: "bad", priority: 2, flaggedAt: now() });
    q.enqueue({ claimId: "good", priority: 1, flaggedAt: now() });
    await settle(); await q.drain(); await settle(); await q.drain();
    expect(order).toEqual(["bad", "good"]);
  });

  it("hour window: arms HOUR − elapsed (capped by staleAfterMs); the captured timer after an hour resumes research", async () => {
    const { q, researched, timers, now, advance } = rig({ researchConcurrency: 1, maxResearchPerHour: 1, staleAfterMs: 2 * HOUR });
    q.enqueue({ claimId: "a", priority: 1, flaggedAt: now() });
    await settle(); await q.drain();
    advance(10 * 60_000);
    q.enqueue({ claimId: "b", priority: 1, flaggedAt: now() });
    expect(researched).toEqual(["a"]);
    expect(timers.map((t) => t.ms)).toEqual([HOUR - 10 * 60_000]);
    advance(HOUR - 10 * 60_000);
    timers[0]!.fn();
    await settle(); await q.drain();
    expect(researched).toEqual(["a", "b"]);
  });

  it("the hour window's wait is capped by staleAfterMs", async () => {
    const { q, timers, now } = rig({ researchConcurrency: 1, maxResearchPerHour: 1, staleAfterMs: 60_000 });
    q.enqueue({ claimId: "a", priority: 1, flaggedAt: now() });
    await settle(); await q.drain();
    q.enqueue({ claimId: "b", priority: 1, flaggedAt: now() });
    expect(timers.map((t) => t.ms)).toEqual([60_000]);
  });

  it("arm is idempotent while a timer is pending (setTimer called once), and at least 1 ms", async () => {
    const hold = deferred();
    const { q, timers, now } = rig({ researchConcurrency: 1, staleAfterMs: 0.2 }, () => hold.promise);
    q.enqueue({ claimId: "a", priority: 1, flaggedAt: now() });
    q.enqueue({ claimId: "b", priority: 1, flaggedAt: now() });
    q.enqueue({ claimId: "c", priority: 1, flaggedAt: now() });
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(1);
    hold.resolve();
  });

  it("remaining items arm a stale timer; firing it after staleAfterMs + 1 drops them as stale", async () => {
    const hold = deferred();
    const { q, dropped, timers, now, advance } = rig({ researchConcurrency: 1 }, () => hold.promise);
    q.enqueue({ claimId: "busy", priority: 2, flaggedAt: now() });
    q.enqueue({ claimId: "waiting", priority: 1, flaggedAt: now() });
    expect(timers.map((t) => t.ms)).toEqual([cfg.app.s2.staleAfterMs]);
    advance(cfg.app.s2.staleAfterMs + 1);
    timers[0]!.fn();
    expect(dropped).toEqual(["waiting:stale"]);
    expect(q.size).toBe(0);
    hold.resolve();
  });

  it("an item exactly staleAfterMs old is not stale", async () => {
    const hold = deferred();
    const { q, dropped, timers, advance, now } = rig({ researchConcurrency: 1 }, () => hold.promise);
    q.enqueue({ claimId: "busy", priority: 2, flaggedAt: now() });
    q.enqueue({ claimId: "edge", priority: 1, flaggedAt: now() });
    advance(cfg.app.s2.staleAfterMs);
    timers[0]!.fn();
    expect(dropped).toEqual([]);
    expect(q.size).toBe(1);
    hold.resolve();
  });

  it("session cap reached with concurrency 2: the third item is dropped only when a worker frees", async () => {
    const a = deferred();
    const b = deferred();
    const { q, dropped, now } = rig({ researchConcurrency: 2, maxResearchPerSession: 2 }, (it) => (it.claimId === "a" ? a.promise : b.promise));
    for (const id of ["a", "b", "c"]) q.enqueue({ claimId: id, priority: 1, flaggedAt: now() });
    expect(dropped).toEqual([]);
    expect(q.size).toBe(1);
    a.resolve();
    await settle();
    expect(dropped).toEqual(["c:session_cap"]);
    b.resolve();
    await q.drain();
  });

  it("drain resolves at once with nothing in flight, and waits for research started from finally", async () => {
    const { q, researched, now } = rig({ researchConcurrency: 1 }, async (it) => { await settle(); researched.push(it.claimId); });
    await q.drain();
    q.enqueue({ claimId: "a", priority: 2, flaggedAt: now() });
    q.enqueue({ claimId: "b", priority: 1, flaggedAt: now() });
    await q.drain();
    expect(researched).toEqual(["a", "b"]);
  });

  it.fails("BUG FC-Q1: a pending stale timer stops a sooner hour-window wake from being armed, so research waits longer", async () => {
    // concurrency 1, 2 per hour: a ran at t=0; b starts at 57 min while c waits (all workers busy → a 10 min stale
    // timer). When b ends at 57.5 min the hour is full until 60 min, so c should wake in 2.5 min, not at 67 min.
    const hold = deferred();
    const { q, researched, timers, now, advance } = rig({ researchConcurrency: 1, maxResearchPerHour: 2 }, async (it) => { researched.push(it.claimId); if (it.claimId === "b") await hold.promise; });
    q.enqueue({ claimId: "a", priority: 1, flaggedAt: now() });
    await settle(); await q.drain();
    advance(57 * 60_000);
    q.enqueue({ claimId: "b", priority: 1, flaggedAt: now() });
    q.enqueue({ claimId: "c", priority: 1, flaggedAt: now() });
    advance(30_000);
    hold.resolve();
    await settle(); await q.drain();
    expect(researched).toEqual(["a", "b"]);
    expect(timers.map((t) => t.ms)).toContain(150_000);
  });

  it("the default setTimer uses setTimeout, unref'd, and the default clock is Date.now", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(5_000_000);
    const hold = deferred();
    const dropped: string[] = [];
    const q = new ResearchQueue({ ...cfg.app.s2, researchConcurrency: 1, staleAfterMs: 1000 }, {
      research: () => hold.promise, onDropped: (it, r) => dropped.push(`${it.claimId}:${r}`),
    });
    q.enqueue({ claimId: "busy", priority: 2, flaggedAt: Date.now() });
    q.enqueue({ claimId: "waiting", priority: 1, flaggedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(dropped).toEqual([]); // exactly staleAfterMs: not stale yet; the timer re-arms
    await vi.advanceTimersByTimeAsync(1001);
    expect(dropped).toEqual(["waiting:stale"]);
    hold.resolve();
  });
});
