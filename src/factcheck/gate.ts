import type { S1Set } from "../config.ts";
import type { JevCallMeta } from "../jev/client.ts";
import type { JevResponse, QuestionSet } from "../jev/types.ts";
import { flagDecision, versionQuestions } from "./s1.ts";

export interface GateItem {
  utteranceId: string;
  set: "G" | "F" | "M";
  state: unknown;
  order: number;
}

export interface GateMetrics {
  G: number; F: number; M: number;
  G2: number; F2: number; M2: number;
  asked: number;
  failed: number;
  promote: boolean;
}

/** Promote when G' ≥ floor(0.9 × |G|) and either F' < |F| or M' > 0. */
export function gateDecision(m: Omit<GateMetrics, "promote" | "asked" | "failed">): boolean {
  return m.G2 >= Math.floor(0.9 * m.G) && (m.F2 < m.F || m.M2 > 0);
}

export interface GateDeps {
  ask(state: unknown, questions: QuestionSet, meta: JevCallMeta): Promise<JevResponse>;
  hedgedThreshold: number;
}

/**
 * The replay gate (§4.8c): asks the candidate's questions (memory questions excluded) again on each logged state,
 * applies the candidate flag rule, and counts G', F', M'. Re-asked calls use background settings and the budget.
 * An item whose call fails counts as not flagged.
 */
export async function runGate(candidate: S1Set, items: GateItem[], deps: GateDeps): Promise<GateMetrics> {
  const questions = versionQuestions(candidate);
  const count = { G: 0, F: 0, M: 0, G2: 0, F2: 0, M2: 0, asked: 0, failed: 0 };
  await Promise.all(items.map(async (it) => {
    count[it.set]++;
    try {
      const res = await deps.ask(it.state, questions, { purpose: "gate", utterance_id: it.utteranceId, question_set_version: candidate.id });
      count.asked++;
      if (flagDecision(res.answers, candidate, deps.hedgedThreshold).flag) count[`${it.set}2` as "G2" | "F2" | "M2"]++;
    } catch {
      count.failed++;
    }
  }));
  return { ...count, promote: gateDecision(count) };
}
