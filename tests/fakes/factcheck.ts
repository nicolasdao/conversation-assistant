// Builders for the fact-checker's tests (System 1 answers, a fake System 2, and a FactChecker harness). Imported
// directly, not through index.ts.
import { loadConfig, type AppConfig, type S1Set } from "../../src/config.ts";
import type { JevCallMeta } from "../../src/jev/client.ts";
import type { JevAnswer, JevResponse, QuestionSet } from "../../src/jev/types.ts";
import type { PipelineUtterance } from "../../src/pipeline/segmenter.ts";
import { FactChecker, type S2Api } from "../../src/factcheck/s1.ts";
import type { RewriteChange, RewriteProposal, Verdict } from "../../src/factcheck/s2.ts";

export const fcConfig = loadConfig();

/** System 1 answers; defaults: public 0.9, claim_type "none", everything else 0. `known_*` and `attention_*` add nouls. */
export function ans(o: { claim?: number; type?: string; worth?: number; hedged?: number; public?: number; [k: string]: number | string | undefined }): Record<string, JevAnswer> {
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
export const FLAG = { claim: 0.9, type: "number_or_price", worth: 3 };
export const NOFLAG = { claim: 0.1 };

export const jevRes = (answers: Record<string, JevAnswer>): JevResponse => ({ answers, id: "g", model: "m", provider: "p", usage: { input_tokens: 0, output_tokens: 0, cost: 0 } });

export const VERDICT = (o: Partial<Verdict> = {}): Verdict => ({
  restated_claim: "Jev costs 1/445 of GPT.", verdict: "supported", correction: "", confidence: "high", false_alarm_reason: "none",
  sources: [{ url: "https://a.example", title: "A" }], downgraded: false, ...o,
});
export const FALSE_ALARM = () => VERDICT({ verdict: "not_a_claim", false_alarm_reason: "opinion" });

export const change = (o: Partial<RewriteChange> & Pick<RewriteChange, "op" | "target">): RewriteChange => ({
  text: null, true_text: null, false_text: null, options: null, levels: null, number: null, ...o,
});
export const proposal = (...changes: RewriteChange[]): RewriteProposal => ({ changes, rationale: "because" });

export function fakeS2(opts: { verdict?: (text: string) => Verdict | Promise<Verdict>; audit?: S2Api["audit"]; rewrite?: S2Api["rewrite"] } = {}) {
  const calls = { research: [] as Parameters<S2Api["research"]>[0][], audit: [] as Parameters<S2Api["audit"]>[0][], rewrite: [] as string[] };
  const s2: S2Api = {
    async research(i) { calls.research.push(i); return (opts.verdict ?? (() => VERDICT()))(i.utterance); },
    async audit(items) { calls.audit.push(items); return opts.audit ? opts.audit(items) : { items: [] }; },
    async rewrite(u) { calls.rewrite.push(u); return opts.rewrite ? opts.rewrite(u) : { changes: [], rationale: "none" }; },
  };
  return { s2, calls };
}

/** A FactChecker with recorded events, rows and errors; `utt` numbers utterances per harness (u_1, u_2…). */
export function checker(opts: {
  app?: AppConfig; s1?: S1Set; s2?: S2Api;
  ask?: (state: unknown, q: QuestionSet, m: JevCallMeta) => Promise<JevResponse>;
  now?: () => number; rand?: () => number; setTimer?: (fn: () => void, ms: number) => void;
  stateOf?: (id: string) => unknown;
  speakerName?: (id: string) => string;
} = {}) {
  const events: { type: string; data: any }[] = [];
  const rows: { file: string; row: any }[] = [];
  const errors: { component: string; message: string; detail?: Record<string, unknown> }[] = [];
  const states = new Map<string, unknown>();
  let n = 0;
  const fc = new FactChecker({
    app: opts.app ?? fcConfig.app, s1Default: opts.s1 ?? fcConfig.s1, s2: opts.s2 ?? fakeS2().s2,
    ask: opts.ask ?? (async () => { throw new Error("no ask"); }),
    emit: (type, data) => events.push({ type, data }),
    write: (file, row) => rows.push({ file, row }),
    speakerName: opts.speakerName ?? ((id) => id),
    stateOf: opts.stateOf ?? ((id) => states.get(id)),
    onError: (component, message, detail) => errors.push({ component, message, detail }),
    now: opts.now, rand: opts.rand ?? (() => 0), setTimer: opts.setTimer,
  });
  const utt = (text: string, endMs = (n + 1) * 5000, o: Partial<PipelineUtterance> = {}): PipelineUtterance => {
    n++;
    return { id: `u_${n}`, stream: "remote", startMs: endMs - 3000, endMs, speakerId: "spk_2", speakerInferred: false, text, filler: false, failed: false, tags: [], ...o };
  };
  const say = (text: string, a: Record<string, JevAnswer>, u = utt(text), segment?: PipelineUtterance[]) => {
    states.set(u.id, { current_segment: [], new_utterance: { speaker: u.speakerId, text: u.text, tags: [] } });
    fc.onAnswers(u, a, { segment: segment ?? [u] });
    return u;
  };
  return { fc, events, rows, errors, states, say, utt, of: (t: string) => events.filter((e) => e.type === t) };
}

/** Lets queued research and background audits/rewrites run. */
export const settle = () => new Promise((r) => setTimeout(r, 0));
