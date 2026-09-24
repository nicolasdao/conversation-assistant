import type { AppConfig, S1Set } from "../config.ts";
import { CLAIM_TYPE_KEYS, S1SetSchema } from "../config.ts";
import { choice, noul, score, type JevAnswer, type NoulQuestion, type QuestionSet } from "../jev/types.ts";
import type { FactcheckHook, PipelineUtterance } from "../pipeline/segmenter.ts";
import type { AuditResult, RewriteChange, RewriteProposal, Verdict, VerdictKind } from "./s2.ts";
import { gradeOf } from "./s2.ts";
import { ResearchQueue, type DropReason, type QueueItem } from "./queue.ts";
import { runGate, type GateItem, type GateMetrics } from "./gate.ts";
import type { JevCallMeta } from "../jev/client.ts";
import type { JevResponse } from "../jev/types.ts";

// ---------- versions ----------

export type VersionStatus = "default" | "promoted" | "rejected";

export interface S1Version extends S1Set {
  parent: string | null;
  kind: "default" | "criteria";
  createdAt: string;
  rationale: string;
  gate: GateMetrics | null;
  status: VersionStatus;
  errors?: string[];
}

export const S1_BASE_IDS = ["claim", "claim_type", "hedged", "worth"] as const;

/** The questions a System 1 version asks (memory questions excluded). */
export function versionQuestions(v: S1Set): QuestionSet {
  return { ...v.questions } as QuestionSet;
}

// ---------- flag rule ----------

export interface FlagDecision {
  flag: boolean;
  priority: number;
  claim: number;
  claimType: string | null;
  worth: number;
  hedged: number;
  attention: boolean;
}

export function flagDecision(answers: Record<string, JevAnswer>, v: Pick<S1Set, "thresholds" | "questions">, hedgedThreshold: number): FlagDecision {
  const t = v.thresholds;
  const claim = noul(answers, "claim") ?? 0;
  const claimType = choice(answers, "claim_type")?.choice ?? null;
  const worth = score(answers, "worth") ?? 0;
  const hedged = noul(answers, "hedged") ?? 0;
  const attention = Object.keys(v.questions).filter((k) => k.startsWith("attention_"))
    .some((k) => (noul(answers, k) ?? 0) >= t.attentionThreshold);
  const flag = claim >= t.claimThreshold && claimType !== null && claimType !== "none" && worth >= t.worthMin;
  const priority = worth + (hedged >= hedgedThreshold ? 0.5 : 0) + (attention ? 1 : 0);
  return { flag, priority, claim, claimType, worth, hedged, attention };
}

// ---------- rewrite validation (§4.8c) ----------

const INSTRUCTIONS_MAX = 400;
const THRESHOLD_RANGES: Record<string, [number, number]> = {
  claimThreshold: [0.5, 0.9], attentionThreshold: [0.5, 0.9], worthMin: [1, 3],
};

type FieldName = "text" | "true_text" | "false_text" | "options" | "levels" | "number";
const FIELDS: FieldName[] = ["text", "true_text", "false_text", "options", "levels", "number"];

function onlyFields(c: RewriteChange, required: FieldName[], optional: FieldName[] = []): string | null {
  for (const f of required) if (c[f] === null) return `${c.op} on ${c.target} needs ${f}`;
  for (const f of FIELDS) {
    if (!required.includes(f) && !optional.includes(f) && c[f] !== null) return `${c.op} on ${c.target} must leave ${f} null`;
  }
  return null;
}

/**
 * Applies a proposal to the active set, or rejects the whole rewrite if it has more than 3 changes or any change breaks
 * the per-op rules. Returns the candidate questions and thresholds.
 */
export function applyRewrite(active: S1Set, proposal: RewriteProposal): { ok: true; set: Omit<S1Set, "id"> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (proposal.changes.length > 3) return { ok: false, errors: [`${proposal.changes.length} changes; at most 3 are allowed`] };
  if (proposal.changes.length === 0) return { ok: false, errors: ["no changes proposed"] };
  const questions = structuredClone(active.questions) as Record<string, any>;
  const thresholds = { ...active.thresholds };
  const nextAttention = () => {
    const used = Object.keys(questions).filter((k) => k.startsWith("attention_")).map((k) => Number(k.slice(10)));
    return `attention_${Math.max(0, ...used) + 1}`;
  };

  for (const c of proposal.changes) {
    const fail = (m: string) => errors.push(m);
    switch (c.op) {
      case "set_instructions": {
        if (!(S1_BASE_IDS as readonly string[]).includes(c.target)) { fail(`set_instructions cannot target ${c.target}`); break; }
        const e = onlyFields(c, ["text"]);
        if (e) { fail(e); break; }
        if (!c.text!.trim()) { fail("instructions must not be empty"); break; }
        if (c.text!.length > INSTRUCTIONS_MAX) { fail(`instructions for ${c.target} exceed ${INSTRUCTIONS_MAX} characters`); break; }
        questions[c.target].instructions = c.text;
        break;
      }
      case "set_criteria": {
        if (c.target === "claim" || c.target === "hedged") {
          const e = onlyFields(c, ["true_text", "false_text"]);
          if (e) { fail(e); break; }
          if (!c.true_text!.trim() || !c.false_text!.trim()) { fail("criteria descriptions must not be empty"); break; }
          questions[c.target].criteria = { true: c.true_text, false: c.false_text };
        } else if (c.target === "claim_type") {
          const e = onlyFields(c, ["options"]);
          if (e) { fail(e); break; }
          const keys = c.options!.map((o) => o.key);
          const expected = [...CLAIM_TYPE_KEYS];
          if (keys.length !== expected.length || new Set(keys).size !== keys.length || !expected.every((k) => keys.includes(k))) {
            fail(`claim_type options must list exactly ${expected.join(", ")}`);
            break;
          }
          if (c.options!.some((o) => !o.description.trim())) { fail("claim_type descriptions must not be empty"); break; }
          questions.claim_type.criteria = Object.fromEntries(expected.map((k) => [k, c.options!.find((o) => o.key === k)!.description]));
        } else if (c.target === "worth") {
          const e = onlyFields(c, ["levels"]);
          if (e) { fail(e); break; }
          if (c.levels!.length !== 5) { fail(`worth needs exactly 5 levels, got ${c.levels!.length}`); break; }
          if (c.levels!.some((l) => !l.trim())) { fail("worth levels must not be empty"); break; }
          questions.worth.criteria = [...c.levels!];
        } else {
          fail(`set_criteria cannot target ${c.target}`);
        }
        break;
      }
      case "add_attention": {
        if (c.target !== "new") { fail("add_attention must target \"new\""); break; }
        const e = onlyFields(c, ["text"], ["true_text", "false_text"]);
        if (e) { fail(e); break; }
        if ((c.true_text === null) !== (c.false_text === null)) { fail("add_attention needs both true_text and false_text, or neither"); break; }
        if (!c.text!.trim()) { fail("instructions must not be empty"); break; }
        if (c.text!.length > INSTRUCTIONS_MAX) { fail(`attention instructions exceed ${INSTRUCTIONS_MAX} characters`); break; }
        const q: NoulQuestion = { type: "noul", instructions: c.text! };
        if (c.true_text !== null) q.criteria = { true: c.true_text, false: c.false_text! };
        questions[nextAttention()] = q;
        if (Object.keys(questions).filter((k) => k.startsWith("attention_")).length > 3) fail("at most 3 attention questions");
        break;
      }
      case "remove_attention": {
        if (!/^attention_\d+$/.test(c.target) || !(c.target in questions)) { fail(`remove_attention: no question ${c.target}`); break; }
        const e = onlyFields(c, []);
        if (e) { fail(e); break; }
        delete questions[c.target];
        break;
      }
      case "set_threshold": {
        const range = THRESHOLD_RANGES[c.target];
        if (!range) { fail(`set_threshold cannot target ${c.target}`); break; }
        const e = onlyFields(c, ["number"]);
        if (e) { fail(e); break; }
        if (!(c.number! >= range[0] && c.number! <= range[1])) { fail(`${c.target} ${c.number} is outside [${range[0]}, ${range[1]}]`); break; }
        (thresholds as Record<string, number>)[c.target] = c.number!;
        break;
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const parsed = S1SetSchema.safeParse({ id: "s1@0", questions, thresholds });
  if (!parsed.success) return { ok: false, errors: [parsed.error.message] };
  return { ok: true, set: { questions: parsed.data.questions, thresholds: parsed.data.thresholds } };
}

// ---------- claims ----------

export type ClaimStatus = "queued" | "researching" | "verdict" | "dropped";

export interface Claim {
  id: string;
  utteranceId: string;
  speakerId: string;
  text: string;
  segmentText: string;
  s1Version: string;
  priority: number;
  claimType: string | null;
  worth: number;
  hedged: number;
  status: ClaimStatus;
  flaggedAt: number;
  verdict?: Verdict;
  latencyMs?: number;
  grade?: "good_flag" | "false_alarm";
  gradeSeq?: number;
  disputed?: boolean;
  note?: string;
  dropReason?: DropReason | "research_failed";
  repeats: string[];
  duplicates: string[];
}

export interface FactcheckStats {
  flagged: number;
  researched: number;
  verdicts: Record<VerdictKind, number>;
  repeats: number;
  duplicates: number;
  dropped: number;
  goodFlags: number;
  falseAlarms: number;
  misses: number;
  disputed: number;
  promoted: number;
  rejected: number;
}

export interface S2Api {
  research(input: { claim_id?: string; speaker: string; utterance: string; segment: string }): Promise<Verdict>;
  audit(items: { utterance_id: string; speaker: string; text: string }[]): Promise<AuditResult>;
  rewrite(user: string): Promise<RewriteProposal>;
}

export type FactcheckFile = "claims" | "verdicts" | "s1_versions" | "audits";

export interface FactcheckDeps {
  app: AppConfig;
  s1Default: S1Set;
  s2: S2Api;
  ask(state: unknown, questions: QuestionSet, meta: JevCallMeta): Promise<JevResponse>;
  emit(type: string, data: Record<string, unknown>): void;
  write(file: FactcheckFile, row: Record<string, unknown>): void;
  speakerName(id: string): string;
  /** The logged per-utterance Jev state, joined by utterance_id. */
  stateOf(utteranceId: string): unknown | undefined;
  onError(component: string, message: string, detail?: Record<string, unknown>): void;
  now?: () => number;
  rand?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

interface Evaluation { utteranceId: string; version: string; flagged: boolean; text: string; speakerId: string; order: number }
interface Miss { utteranceId: string; version: string; seq: number }

/** Fact-check System 1 (per-utterance flags and memory) and its System 2 loop (research, grades, audits, rewrites). */
export class FactChecker implements FactcheckHook {
  readonly versions: S1Version[] = [];
  private activeVersion: S1Version;
  private activationSeq = 0;
  private seq = 0;
  private readonly memory: { claimId: string; text: string }[] = [];
  readonly claims = new Map<string, Claim>();
  private claimN = 0;
  private readonly evaluations = new Map<string, Evaluation>();
  private auditPool: string[] = [];
  private readonly misses = new Map<string, Miss>();
  private clockMs = 0;
  private lastAuditMs = 0;
  private lastRewriteMs = -Infinity;
  private rewriteRunning = false;
  private readonly background = new Set<Promise<void>>();
  private counters = { repeats: 0, duplicates: 0, dropped: 0, promoted: 0, rejected: 0 };
  readonly queue: ResearchQueue;
  private readonly now: () => number;
  private readonly rand: () => number;

  constructor(private readonly deps: FactcheckDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.rand = deps.rand ?? Math.random;
    const v: S1Version = {
      ...structuredClone(deps.s1Default), parent: null, kind: "default", createdAt: new Date(this.now()).toISOString(),
      rationale: "default", gate: null, status: "default",
    };
    this.versions.push(v);
    this.activeVersion = v;
    deps.write("s1_versions", { ...v });
    this.queue = new ResearchQueue(deps.app.s2, {
      research: (item) => this.research(item),
      onDropped: (item, reason) => this.dropped(item, reason),
      now: this.now,
      setTimer: deps.setTimer,
    });
  }

  get active(): S1Version {
    return this.activeVersion;
  }

  get memoryQuestions(): { claimId: string; text: string }[] {
    return this.memory.map((m) => ({ ...m }));
  }

  private get cfg() {
    return this.deps.app.factcheck;
  }

  // ----- System 1 -----

  questions(): { questions: QuestionSet; version: string } {
    const questions: QuestionSet = versionQuestions(this.activeVersion);
    for (const m of this.memory) {
      questions[`known_${m.claimId}`] = {
        type: "noul",
        instructions: `new_utterance restates or relies on this already-checked claim: "${m.text}"`,
      };
    }
    return { questions, version: this.activeVersion.id };
  }

  onAnswers(u: PipelineUtterance, answers: Record<string, JevAnswer>, context: { segment: PipelineUtterance[] }): void {
    this.clockMs = Math.max(this.clockMs, u.endMs);
    const version = this.activeVersion;

    // Memory first: a restatement links to the earlier claim instead of flagging.
    let best: { claimId: string; p: number } | null = null;
    for (const m of this.memory) {
      const p = noul(answers, `known_${m.claimId}`) ?? 0;
      if (p >= this.cfg.knownMatchThreshold && (!best || p > best.p)) best = { claimId: m.claimId, p };
    }
    if (best) {
      const target = this.claims.get(best.claimId)!;
      const base = { claimId: target.id, utteranceId: u.id, speakerId: u.speakerId, text: u.text, match: best.p };
      if (target.verdict) {
        target.repeats.push(u.id);
        this.counters.repeats++;
        this.deps.emit("claim.repeat", { ...base, verdict: target.verdict, disputed: target.disputed ?? false });
      } else {
        target.duplicates.push(u.id);
        this.counters.duplicates++;
        this.deps.emit("claim.duplicate", { ...base, status: target.status });
      }
      this.evaluations.set(u.id, { utteranceId: u.id, version: version.id, flagged: false, text: u.text, speakerId: u.speakerId, order: ++this.seq });
      this.maybeAudit();
      return;
    }

    const d = flagDecision(answers, version, this.cfg.hedgedThreshold);
    this.evaluations.set(u.id, { utteranceId: u.id, version: version.id, flagged: d.flag, text: u.text, speakerId: u.speakerId, order: ++this.seq });
    if (d.flag) {
      const claim: Claim = {
        id: `c_${++this.claimN}`, utteranceId: u.id, speakerId: u.speakerId, text: u.text,
        segmentText: context.segment.filter((x) => !x.failed).map((x) => `${this.deps.speakerName(x.speakerId)}: ${x.text}`).join("\n"),
        s1Version: version.id, priority: d.priority, claimType: d.claimType, worth: d.worth, hedged: d.hedged,
        status: "queued", flaggedAt: this.now(), repeats: [], duplicates: [],
      };
      this.claims.set(claim.id, claim);
      this.deps.emit("claim.flagged", {
        claimId: claim.id, utteranceId: u.id, speakerId: u.speakerId, text: u.text, priority: d.priority, claimType: d.claimType,
        worth: d.worth, hedged: d.hedged, claim: d.claim, attention: d.attention, s1Version: version.id,
      });
      this.writeClaim(claim);
      this.addMemory(claim.id, u.text);
      this.queue.enqueue({ claimId: claim.id, priority: d.priority, flaggedAt: claim.flaggedAt });
    } else if (!u.filler) {
      this.auditPool.push(u.id);
    }
    this.maybeAudit();
  }

  private addMemory(claimId: string, text: string) {
    this.memory.push({ claimId, text });
    this.deps.emit("s1.memory", { action: "add", claimId, text, size: this.memory.length });
    while (this.memory.length > this.cfg.maxKnownQuestions) {
      const gone = this.memory.shift()!;
      this.deps.emit("s1.memory", { action: "evict", claimId: gone.claimId, text: gone.text, size: this.memory.length });
    }
  }

  private writeClaim(c: Claim) {
    this.deps.write("claims", {
      kind: "claim", id: c.id, utterance_id: c.utteranceId, speaker_id: c.speakerId, text: c.text, s1_version: c.s1Version,
      priority: c.priority, claim_type: c.claimType, worth: c.worth, hedged: c.hedged, status: c.status,
      grade: c.grade ?? null, disputed: c.disputed ?? false, drop_reason: c.dropReason ?? null, at: new Date(this.now()).toISOString(),
    });
  }

  // ----- System 2: research and grading -----

  private async research(item: QueueItem): Promise<void> {
    const c = this.claims.get(item.claimId);
    if (!c) return;
    c.status = "researching";
    this.deps.emit("claim.researching", { claimId: c.id });
    this.writeClaim(c);
    const started = this.now();
    try {
      const v = await this.deps.s2.research({
        claim_id: c.id, speaker: this.deps.speakerName(c.speakerId), utterance: c.text, segment: c.segmentText,
      });
      c.verdict = v;
      c.latencyMs = this.now() - started;
      c.status = "verdict";
      c.grade = gradeOf(v);
      c.gradeSeq = ++this.seq;
      this.deps.write("verdicts", { kind: "verdict", claim_id: c.id, utterance_id: c.utteranceId, ...v, grade: c.grade, latency_ms: c.latencyMs });
      this.writeClaim(c);
      this.deps.emit("claim.verdict", { claimId: c.id, verdict: v, grade: c.grade, latencyMs: c.latencyMs });
      const m = this.memory.find((x) => x.claimId === c.id);
      if (m && v.restated_claim.trim()) {
        m.text = v.restated_claim.trim();
        this.deps.emit("s1.memory", { action: "update", claimId: c.id, text: m.text, size: this.memory.length });
      }
      this.maybeRewrite();
    } catch (e) {
      this.deps.onError("s2", e instanceof Error ? e.message : String(e), { claim_id: c.id, purpose: "research" });
      c.status = "dropped";
      c.dropReason = "research_failed";
      this.counters.dropped++;
      this.writeClaim(c);
      this.deps.emit("claim.dropped", { claimId: c.id, reason: "research_failed" });
    }
  }

  private dropped(item: QueueItem, reason: DropReason) {
    const c = this.claims.get(item.claimId);
    if (!c) return;
    c.status = "dropped";
    c.dropReason = reason;
    this.counters.dropped++;
    this.writeClaim(c);
    this.deps.emit("claim.dropped", { claimId: c.id, reason });
  }

  /** The host disputes a verdict: its grade leaves the evidence. */
  override(claimId: string, note?: string): Claim {
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`unknown claim ${claimId}`);
    if (!c.verdict) throw new Error(`claim ${claimId} has no verdict yet`);
    c.disputed = true;
    if (note) c.note = note;
    this.writeClaim(c);
    this.deps.emit("claim.disputed", { claimId, note: note ?? null });
    return c;
  }

  // ----- audits -----

  private track(p: Promise<void>) {
    this.background.add(p);
    p.finally(() => this.background.delete(p));
  }

  private maybeAudit() {
    if (this.clockMs - this.lastAuditMs < this.cfg.auditIntervalMs) return;
    this.lastAuditMs = this.clockMs;
    if (this.auditPool.length < this.cfg.auditMinUtterances) return;
    const pool = this.auditPool;
    this.auditPool = [];
    const sample: string[] = [];
    const copy = [...pool];
    while (sample.length < this.cfg.auditSample && copy.length > 0) sample.push(copy.splice(Math.floor(this.rand() * copy.length), 1)[0]);
    this.track(this.audit(sample));
  }

  private async audit(ids: string[]): Promise<void> {
    const items = ids.map((id) => {
      const e = this.evaluations.get(id)!;
      return { utterance_id: id, speaker: this.deps.speakerName(e.speakerId), text: e.text };
    });
    try {
      const r = await this.deps.s2.audit(items);
      const missed = r.items
        .filter((it) => it.has_checkable_claim && it.worth !== "low" && ids.includes(it.utterance_id))
        .map((it) => it.utterance_id);
      for (const id of missed) {
        const e = this.evaluations.get(id)!;
        this.misses.set(id, { utteranceId: id, version: e.version, seq: ++this.seq });
      }
      this.deps.write("audits", { kind: "audit", sampled: ids, items: r.items, misses: missed, at: new Date(this.now()).toISOString() });
      this.deps.emit("audit", { sampled: ids.length, misses: missed, items: r.items });
      this.maybeRewrite();
    } catch (e) {
      this.deps.onError("s2", e instanceof Error ? e.message : String(e), { purpose: "audit" });
    }
  }

  // ----- rewrites and the replay gate -----

  /** Evidence counted toward the active version since it became active. */
  private evidence() {
    const v = this.activeVersion.id;
    const graded = [...this.claims.values()].filter((c) => c.grade && !c.disputed && c.s1Version === v && (c.gradeSeq ?? 0) > this.activationSeq);
    const falseAlarms = graded.filter((c) => c.grade === "false_alarm");
    const goodFlags = graded.filter((c) => c.grade === "good_flag");
    const misses = [...this.misses.values()].filter((m) => m.version === v && m.seq > this.activationSeq);
    return { falseAlarms, goodFlags, misses };
  }

  private maybeRewrite() {
    if (this.rewriteRunning) return;
    const { falseAlarms, misses } = this.evidence();
    const due = falseAlarms.length >= this.cfg.rewriteOnFalseAlarms || misses.length >= this.cfg.rewriteOnMisses;
    if (!due || this.clockMs - this.lastRewriteMs < this.cfg.rewriteCooldownMs) return;
    this.rewriteRunning = true;
    this.lastRewriteMs = this.clockMs;
    this.track(this.rewrite().finally(() => { this.rewriteRunning = false; }));
  }

  rewriteInput(): string {
    const { falseAlarms, goodFlags, misses } = this.evidence();
    // Good flags and misses come from any version: they are examples, not counts.
    const allGood = [...this.claims.values()].filter((c) => c.grade === "good_flag" && !c.disputed);
    const allMisses = [...this.misses.values()];
    return JSON.stringify({
      active_questions: this.activeVersion.questions,
      thresholds: this.activeVersion.thresholds,
      false_alarms: falseAlarms.map((c) => ({ utterance: c.text, reason: c.verdict?.false_alarm_reason, verdict: c.verdict?.verdict })),
      good_flags: (goodFlags.length ? goodFlags : allGood).slice(-10).map((c) => c.text),
      misses: (misses.length ? misses : allMisses).slice(-10).map((m) => this.evaluations.get(m.utteranceId)?.text ?? ""),
    }, null, 1);
  }

  private nextVersionId() {
    return `s1@${this.versions.length + 1}`;
  }

  private async rewrite(): Promise<void> {
    const parent = this.activeVersion;
    let proposal: RewriteProposal;
    try {
      proposal = await this.deps.s2.rewrite(this.rewriteInput());
    } catch (e) {
      this.deps.onError("s2", e instanceof Error ? e.message : String(e), { purpose: "rewrite" });
      return;
    }
    const applied = applyRewrite(parent, proposal);
    const base = { id: this.nextVersionId(), parent: parent.id, kind: "criteria" as const, createdAt: new Date(this.now()).toISOString(), rationale: proposal.rationale };
    if (!applied.ok) {
      const v: S1Version = { ...base, questions: parent.questions, thresholds: parent.thresholds, gate: null, status: "rejected", errors: applied.errors };
      this.record(v, "invalid");
      return;
    }
    const candidate: S1Version = { ...base, ...applied.set, gate: null, status: "rejected" } as S1Version;
    let metrics: GateMetrics;
    try {
      metrics = await runGate(candidate, this.gateItems(), {
        ask: this.deps.ask, hedgedThreshold: this.cfg.hedgedThreshold,
      });
    } catch (e) {
      this.deps.onError("gate", e instanceof Error ? e.message : String(e), { candidate: candidate.id });
      candidate.errors = [e instanceof Error ? e.message : String(e)];
      this.record(candidate, "gate_failed");
      return;
    }
    candidate.gate = metrics;
    candidate.status = metrics.promote ? "promoted" : "rejected";
    this.record(candidate, metrics.promote ? "promoted" : "rejected");
    if (metrics.promote) {
      this.activeVersion = candidate;
      this.activationSeq = ++this.seq;
    }
  }

  private record(v: S1Version, outcome: string) {
    this.versions.push(v);
    if (v.status === "promoted") this.counters.promoted++;
    else this.counters.rejected++;
    this.deps.write("s1_versions", { ...v });
    const active = v.status === "promoted" ? v.id : this.activeVersion.id;
    this.deps.emit("s1.version", {
      active, candidate: v.id, outcome, status: v.status, parent: v.parent, rationale: v.rationale, gate: v.gate, errors: v.errors ?? null,
    });
  }

  /** G (good flags), F (false alarms), M (misses) with their logged states, newest first, up to replayMaxItems. */
  gateItems(): GateItem[] {
    const items: GateItem[] = [];
    for (const c of this.claims.values()) {
      if (!c.grade || c.disputed) continue;
      items.push({ utteranceId: c.utteranceId, set: c.grade === "good_flag" ? "G" : "F", state: this.deps.stateOf(c.utteranceId), order: this.evaluations.get(c.utteranceId)?.order ?? 0 });
    }
    for (const m of this.misses.values()) {
      items.push({ utteranceId: m.utteranceId, set: "M", state: this.deps.stateOf(m.utteranceId), order: this.evaluations.get(m.utteranceId)?.order ?? 0 });
    }
    return items.filter((i) => i.state !== undefined).sort((a, b) => b.order - a.order).slice(0, this.cfg.replayMaxItems);
  }

  rollback(versionId: string): S1Version {
    const v = this.versions.find((x) => x.id === versionId);
    if (!v) throw new Error(`unknown System 1 version ${versionId}`);
    if (v.status === "rejected") throw new Error(`${versionId} was rejected by the gate and cannot be restored`);
    this.activeVersion = v;
    this.activationSeq = ++this.seq;
    this.deps.emit("s1.version", {
      active: v.id, candidate: null, outcome: "rollback", status: v.status, parent: v.parent, rationale: v.rationale, gate: v.gate, errors: null,
    });
    return v;
  }

  // ----- lifecycle and stats -----

  /** Waits for research, audits, and rewrites, for at most maxMs. */
  async drain(maxMs = 180_000): Promise<boolean> {
    const all = async () => {
      for (;;) {
        await this.queue.drain();
        if (this.background.size === 0 && this.queue.researching === 0) return;
        await Promise.all([...this.background]);
      }
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => { timer = setTimeout(() => r(false), maxMs); timer.unref?.(); });
    const done = await Promise.race([all().then(() => true), timeout]);
    clearTimeout(timer);
    return done;
  }

  stop(): void {
    this.queue.stop();
  }

  stats(): FactcheckStats {
    const claims = [...this.claims.values()];
    const verdicts = { supported: 0, contradicted: 0, misleading: 0, unverifiable: 0, not_a_claim: 0 } as Record<VerdictKind, number>;
    for (const c of claims) if (c.verdict) verdicts[c.verdict.verdict]++;
    return {
      flagged: claims.length,
      researched: claims.filter((c) => c.verdict || c.dropReason === "research_failed").length,
      verdicts,
      repeats: this.counters.repeats,
      duplicates: this.counters.duplicates,
      dropped: this.counters.dropped,
      goodFlags: claims.filter((c) => c.grade === "good_flag" && !c.disputed).length,
      falseAlarms: claims.filter((c) => c.grade === "false_alarm" && !c.disputed).length,
      misses: this.misses.size,
      disputed: claims.filter((c) => c.disputed).length,
      promoted: this.counters.promoted,
      rejected: this.counters.rejected,
    };
  }
}
