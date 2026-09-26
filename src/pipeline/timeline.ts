import { createHash } from "node:crypto";
import type { AppConfig, LabelSet } from "../config.ts";
import { parseLabelSet } from "../config.ts";
import type { JevCallMeta } from "../jev/client.ts";
import type { JevAnswer, JevResponse, QuestionSet } from "../jev/types.ts";
import { stateUtterance, type Segment } from "./segmenter.ts";

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** First 12 hex characters of SHA-256 over the canonical JSON of { prefix, questions, story, stories }. */
export function labelSetVersion(labels: LabelSet, stories: string[]): string {
  const json = JSON.stringify(canonical({ prefix: labels.prefix, questions: labels.questions, story: labels.story, stories }));
  return createHash("sha256").update(json).digest("hex").slice(0, 12);
}

/** The per-segment questions: every timeline instruction gets the prefix; `story` is generated from tonight's headlines. */
export function timelineQuestions(labels: LabelSet, stories: string[]): QuestionSet {
  const pre = labels.prefix ? `${labels.prefix} ` : "";
  const out: QuestionSet = {};
  for (const [id, q] of Object.entries(labels.questions)) out[id] = { ...q, instructions: pre + q.instructions } as QuestionSet[string];
  if (stories.length > 0) {
    const criteria: Record<string, string> = {};
    stories.forEach((h, i) => { criteria[`s${i + 1}`] = h; });
    criteria.none = labels.story.none;
    out.story = { type: "choice", instructions: pre + labels.story.instructions, criteria };
  }
  return out;
}

export function segmentState(previous: Segment | null, seg: Segment, name: (id: string) => string) {
  const utts = (s: Segment | null) => (s?.utterances ?? []).filter((u) => !u.failed).map((u) => stateUtterance(u, name));
  return { previous_segment: utts(previous), segment: utts(seg) };
}

export const AI_SUBJECTS = new Set(["ai_models", "ai_tools", "ai_industry"]);

export interface ChoiceLabel { choice: string; confidence: number; faded: boolean }

export interface SegmentLabels {
  segmentId: string;
  labelSetVersion: string;
  unlabeled: boolean;
  choices: Record<string, ChoiceLabel>;
  nouls: Record<string, number>;
  scores: Record<string, number>;
  markers: string[];
  mentions: string[];
  /** Display lane for `subject`: "ai" for the three ai_* subjects. */
  lane: string | null;
  /** The story headline, when a story (not `none`) was chosen. */
  story: string | null;
}

export function mentionsOf(text: string, companies: string[]): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return companies.filter((c) => new RegExp(`(?<![\\w])${esc(c)}(?![\\w])`, "i").test(text));
}

/** Code-computed labels: markers, faded choices, mentions, lane (§4.9). */
export function deriveLabels(
  seg: Segment, answers: Record<string, JevAnswer> | null, cfg: AppConfig["timeline"], version: string, stories: string[],
): SegmentLabels {
  const text = seg.utterances.filter((u) => !u.failed).map((u) => u.text).join(" ");
  const out: SegmentLabels = {
    segmentId: seg.id, labelSetVersion: version, unlabeled: answers === null, choices: {}, nouls: {}, scores: {}, markers: [],
    mentions: mentionsOf(text, cfg.companies), lane: null, story: null,
  };
  if (!answers) return out;
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === "choice") out.choices[id] = { choice: a.choice, confidence: a.confidence, faded: a.confidence < cfg.fadedBelowConfidence };
    else if (a.type === "noul") {
      out.nouls[id] = a.noul;
      if (a.noul >= cfg.noulMarkerThreshold) out.markers.push(id);
    } else if (a.type === "score") out.scores[id] = a.score;
  }
  if ((out.scores.clip_worthy ?? -1) >= cfg.clipWorthyMin) out.markers.push("clip_worthy");
  const subject = out.choices.subject?.choice;
  if (subject) out.lane = AI_SUBJECTS.has(subject) ? "ai" : subject;
  const story = out.choices.story?.choice;
  if (story && story !== "none") out.story = stories[Number(story.slice(1)) - 1] ?? null;
  return out;
}

export interface Section { id: string; subject: string; lane: string; segmentIds: string[]; startMs: number; endMs: number }

/** Consecutive segments with the same subject, ignoring faded (and unlabeled) ones. */
export function sectionsOf(segments: Segment[], labels: Map<string, SegmentLabels>): Section[] {
  const out: Section[] = [];
  for (const seg of segments) {
    const l = labels.get(seg.id);
    const subj = l?.choices.subject;
    if (!l || l.unlabeled || !subj || subj.faded) continue;
    const last = out[out.length - 1];
    if (last && last.subject === subj.choice) {
      last.segmentIds.push(seg.id);
      last.endMs = Math.max(last.endMs, seg.endMs);
    } else {
      out.push({ id: `sec_${out.length + 1}`, subject: subj.choice, lane: l.lane ?? subj.choice, segmentIds: [seg.id], startMs: seg.startMs, endMs: seg.endMs });
    }
  }
  return out;
}

export class LabelConflictError extends Error {}

export interface TimelineDeps {
  ask(state: unknown, questions: QuestionSet, meta: JevCallMeta): Promise<JevResponse>;
  speakerName(id: string): string;
  emit(type: string, data: Record<string, unknown>): void;
  write(row: Record<string, unknown>): void;
  onError(component: string, message: string, detail?: Record<string, unknown>): void;
  /** False when the session runs with labels off: segments are kept, for navigation, but never labelled. */
  labels?: boolean;
}

/** Labels each closed segment with the host-editable label set (§4.9). No LLM writes or changes these labels. */
export class Timeline {
  private labelSet: LabelSet;
  private stories: string[];
  readonly segments: Segment[] = [];
  readonly labels = new Map<string, SegmentLabels>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private lastSections = "";

  constructor(private readonly cfg: AppConfig, labels: LabelSet, private readonly deps: TimelineDeps) {
    this.labelSet = labels;
    this.stories = [...cfg.timeline.stories];
  }

  get labelSetActive(): LabelSet {
    return this.labelSet;
  }

  get storiesActive(): string[] {
    return [...this.stories];
  }

  get version(): string {
    return labelSetVersion(this.labelSet, this.stories);
  }

  questions(): QuestionSet {
    return timelineQuestions(this.labelSet, this.stories);
  }

  sections(): Section[] {
    return sectionsOf(this.segments, this.labels);
  }

  /** PUT /api/labels: validates, and activates from the next segment. The boundary question cannot change live. */
  replaceLabels(input: unknown): string {
    const next = parseLabelSet(input);
    if (JSON.stringify(canonical(next.boundary)) !== JSON.stringify(canonical(this.labelSet.boundary))) {
      throw new LabelConflictError("the boundary question is calibrated; change it in config and restart");
    }
    this.labelSet = next;
    return this.version;
  }

  setStories(headlines: string[]): string {
    const clean = headlines.map((h) => h.trim()).filter(Boolean);
    if (clean.length > 254) throw new Error("at most 254 stories");
    this.stories = clean;
    return this.version;
  }

  private async acquire() {
    if (this.active < this.cfg.jev.segmentConcurrency) { this.active++; return; }
    await new Promise<void>((r) => this.waiting.push(r));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /** A segment closed: label it in the background. */
  onSegmentClosed(seg: Segment): void {
    this.segments.push(seg);
    if (this.deps.labels !== false) this.track(this.label(seg, "segment"));
  }

  /** POST /api/labels/relabel: asks the active set again on every closed segment, in the background. */
  relabel(): number {
    for (const seg of this.segments) this.track(this.label(seg, "relabel"));
    return this.segments.length;
  }

  private track(p: Promise<void>) {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private async label(seg: Segment, purpose: "segment" | "relabel"): Promise<void> {
    const idx = this.segments.indexOf(seg);
    const previous = idx > 0 ? this.segments[idx - 1] : null;
    const questions = this.questions();
    const version = this.version;
    const stories = [...this.stories];
    const state = segmentState(previous, seg, this.deps.speakerName);
    await this.acquire();
    let answers: Record<string, JevAnswer> | null = null;
    try {
      const res = await this.deps.ask(state, questions, { purpose, segment_id: seg.id, question_set_version: version });
      answers = res.answers;
    } catch (e) {
      this.deps.onError("jev", e instanceof Error ? e.message : String(e), { segment_id: seg.id, purpose });
      if (purpose === "relabel" && this.labels.get(seg.id) && !this.labels.get(seg.id)!.unlabeled) return; // keep the old labels
    } finally {
      this.release();
    }
    const l = deriveLabels(seg, answers, this.cfg.timeline, version, stories);
    this.labels.set(seg.id, l);
    this.deps.write({ kind: "labels", purpose, ...l });
    this.deps.emit("segment.labels", { ...l, purpose });
    const sections = this.sections();
    const key = JSON.stringify(sections);
    if (key !== this.lastSections) {
      this.lastSections = key;
      this.deps.emit("section.updated", { sections });
    }
  }
}
