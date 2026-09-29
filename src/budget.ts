/** What a session spends on, shown in its cost breakdown. */
export type Bucket = "transcription" | "jev" | "s2" | "chat";

/** OpenRouter refused for good (credits or the key's own limit used up, a non-transient 402): later calls are not sent. */
export class BudgetExhaustedError extends Error {
  constructor(readonly cap: "provider", message: string) {
    super(message);
  }
}

export interface CostTotals { transcription: number; jev: number; s2: number; chat: number; session: number }

export interface BudgetOptions {
  onExhausted?: (e: { cap: "provider"; purpose: string; totals: CostTotals; message: string }) => void;
  onCost?: (totals: CostTotals) => void;
}

/**
 * The spending ledger of a session (or of one Try or Create with AI request). It sets no dollar limit of its own
 * (removed on 29 September 2026): the OpenRouter key's own credit limit is the only one. Every external call runs
 * `assertCanSpend` before, which refuses only after OpenRouter has said the credit is used up, and `record` after.
 */
export class Budget {
  private readonly spent: Record<Bucket, number> = { transcription: 0, jev: 0, s2: 0, chat: 0 };
  private exhausted: BudgetExhaustedError | null = null;

  constructor(private readonly opts: BudgetOptions = {}) {}

  totals(): CostTotals {
    return { ...this.spent, session: this.spent.transcription + this.spent.jev + this.spent.s2 + this.spent.chat };
  }

  assertCanSpend(_purpose: string): void {
    if (this.exhausted) throw this.exhausted;
  }

  /** Marks the budget exhausted after a non-transient 402 from OpenRouter, and throws. */
  exhaust(cap: "provider", purpose: string, message: string): never {
    if (!this.exhausted) {
      this.exhausted = new BudgetExhaustedError(cap, message);
      this.opts.onExhausted?.({ cap, purpose, totals: this.totals(), message });
    }
    throw this.exhausted;
  }

  get isExhausted(): boolean {
    return this.exhausted !== null;
  }

  record(bucket: Bucket, costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    this.spent[bucket] += costUsd;
    this.opts.onCost?.(this.totals());
  }
}
