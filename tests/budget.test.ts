import { describe, expect, it } from "vitest";
import { Budget, BudgetExhaustedError, type CostTotals } from "../src/budget.ts";

// The ledger sets no dollar cap since 29 September 2026: it refuses only after OpenRouter's non-transient 402 (`exhaust`).
describe("Budget", () => {
  it("totals(): every bucket, and the session total over all four (chat included)", () => {
    const b = new Budget();
    expect(b.totals()).toEqual({ transcription: 0, jev: 0, s2: 0, chat: 0, session: 0 });
    b.record("transcription", 0.25);
    b.record("jev", 0.5);
    b.record("s2", 1);
    b.record("chat", 2);
    b.record("jev", 0.5);
    expect(b.totals()).toEqual({ transcription: 0.25, jev: 1, s2: 1, chat: 2, session: 4.25 });
  });

  it("spending any amount never refuses: there is no cap", () => {
    const b = new Budget();
    b.record("s2", 1_000_000);
    expect(() => b.assertCanSpend("s2:research")).not.toThrow();
    expect(b.isExhausted).toBe(false);
  });

  it("record calls onCost with the updated totals", () => {
    const seen: CostTotals[] = [];
    const b = new Budget({ onCost: (t) => seen.push(t) });
    b.record("chat", 0.1);
    b.record("jev", 0.2);
    expect(seen).toEqual([
      { transcription: 0, jev: 0, s2: 0, chat: 0.1, session: 0.1 },
      { transcription: 0, jev: 0.2, s2: 0, chat: 0.1, session: expect.closeTo(0.3, 10) },
    ]);
  });

  it("record ignores 0, negative, NaN and Infinity, and does not call onCost", () => {
    const seen: CostTotals[] = [];
    const b = new Budget({ onCost: (t) => seen.push(t) });
    for (const c of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) b.record("jev", c);
    expect(b.totals().session).toBe(0);
    expect(seen).toEqual([]);
  });

  it("exhaust stores the error, tells onExhausted once with the totals, and throws", () => {
    const events: unknown[] = [];
    const b = new Budget({ onExhausted: (e) => events.push(e) });
    b.record("jev", 0.5);
    let first: unknown;
    try { b.exhaust("provider", "jev:utterance", "OpenRouter credits or key limit exhausted (402)"); } catch (e) { first = e; }
    expect(first).toBeInstanceOf(BudgetExhaustedError);
    expect(first).toBeInstanceOf(Error);
    expect((first as BudgetExhaustedError).cap).toBe("provider");
    expect((first as BudgetExhaustedError).message).toBe("OpenRouter credits or key limit exhausted (402)");
    expect(events).toEqual([{
      cap: "provider", purpose: "jev:utterance", message: "OpenRouter credits or key limit exhausted (402)",
      totals: { transcription: 0, jev: 0.5, s2: 0, chat: 0, session: 0.5 },
    }]);
    expect(b.isExhausted).toBe(true);
  });

  it("exhausting twice: onExhausted is called once, and the second throws the first error", () => {
    let calls = 0;
    const b = new Budget({ onExhausted: () => { calls++; } });
    const first = (() => { try { b.exhaust("provider", "s2:research", "first"); } catch (e) { return e; } })();
    const second = (() => { try { b.exhaust("provider", "chat", "second"); } catch (e) { return e; } })();
    expect(second).toBe(first);
    expect((second as Error).message).toBe("first");
    expect(calls).toBe(1);
  });

  it("after exhaustion assertCanSpend throws the stored error for every purpose", () => {
    const b = new Budget(); // no callbacks at all
    expect(() => b.exhaust("provider", "chat", "used up")).toThrow("used up");
    let err: unknown;
    try { b.assertCanSpend("jev:segment"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect(() => b.assertCanSpend("anything")).toThrow("used up");
    b.record("chat", 1); // a call already in flight still counts
    expect(b.totals().chat).toBe(1);
  });
});
