import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** `chat` has its own cap per recording (chat.capUsd), so the session cap counts only the pipeline's buckets. */
export type Bucket = "transcription" | "jev" | "s2" | "chat";

/** Call rows whose cost_usd counts toward the dev total. Events and totals never do: they would count a cost twice. */
// deleted_session: the spend of a recording deleted from the library, kept so deleting cannot lower the development total
const CALL_KINDS = new Set(["jev_call", "s2_call", "transcription", "live_transcription", "chat_call", "deleted_session"]);

export class BudgetExhaustedError extends Error {
  constructor(readonly cap: "session" | "dev" | "provider", message: string) {
    super(message);
  }
}

export interface CostTotals { transcription: number; jev: number; s2: number; chat: number; session: number; dev: number }

export interface BudgetOptions {
  sessionCapUsd: number;
  devCapUsd: number;
  /** Development runs enforce the dev cap; live sessions enforce only the session cap. */
  enforceDevCap: boolean;
  /** Spend already logged by earlier runs (sumDevSpend). */
  devSpentUsd: number;
  onExhausted?: (e: { cap: "session" | "dev" | "provider"; purpose: string; totals: CostTotals; message: string }) => void;
  onCost?: (totals: CostTotals) => void;
}

/** The one spending ledger for the whole process (§4.6). Every external call: assertCanSpend before, record after. */
export class Budget {
  private readonly spent: Record<Bucket, number> = { transcription: 0, jev: 0, s2: 0, chat: 0 };
  private exhausted: BudgetExhaustedError | null = null;

  constructor(private readonly opts: BudgetOptions) {}

  totals(): CostTotals {
    const session = this.spent.transcription + this.spent.jev + this.spent.s2 + this.spent.chat;
    return { ...this.spent, session, dev: this.opts.devSpentUsd + session };
  }

  assertCanSpend(purpose: string): void {
    if (this.exhausted) throw this.exhausted;
    const t = this.totals();
    // chat spend shows in the session's total but never stops the pipeline: it has its own cap
    const pipeline = t.session - t.chat;
    if (pipeline >= this.opts.sessionCapUsd) {
      this.exhaust("session", purpose, `session spend $${pipeline.toFixed(4)} reached the cap of $${this.opts.sessionCapUsd}`);
    }
    if (this.opts.enforceDevCap && t.dev >= this.opts.devCapUsd) {
      this.exhaust("dev", purpose, `development spend $${t.dev.toFixed(4)} reached the cap of $${this.opts.devCapUsd}`);
    }
  }

  /** Marks the budget exhausted (also used for a non-transient 402 from OpenRouter) and throws. */
  exhaust(cap: "session" | "dev" | "provider", purpose: string, message: string): never {
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

/** Sums cost_usd over call rows in sessions/**\/*.jsonl. */
export function sumDevSpend(sessionsDir = "sessions"): number {
  if (!existsSync(sessionsDir)) return 0;
  let total = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            if (CALL_KINDS.has(row?.kind) && typeof row.cost_usd === "number") total += row.cost_usd;
          } catch { /* a torn last line after a crash */ }
        }
      }
    }
  };
  walk(sessionsDir);
  return total;
}
