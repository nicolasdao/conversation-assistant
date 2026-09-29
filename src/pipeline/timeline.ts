import type { AppConfig, TimelineConfig } from "../config.ts";
import type { JevCallMeta } from "../jev/client.ts";
import type { JevAnswer, JevResponse, QuestionSet } from "../jev/types.ts";
import { labelSetVersion, setQuestions, type LabelSet } from "../labels/model.ts";
import { stateUtterance, type Segment } from "./segmenter.ts";

export function segmentState(previous: Segment | null, seg: Segment, name: (id: string) => string) {
  const utts = (s: Segment | null) => (s?.utterances ?? []).filter((u) => !u.failed).map((u) => stateUtterance(u, name));
  return { previous_segment: utts(previous), segment: utts(seg) };
}

export interface ChoiceLabel { choice: string; confidence: number; faded: boolean }

/** One segment's labels, keyed by the set's question ids; the shape of labels.jsonl rows and `segment.labels`. */
export interface SegmentLabels {
  segmentId: string;
  labelSetVersion: string;
  unlabeled: boolean;
  choices: Record<string, ChoiceLabel>;
  nouls: Record<string, number>;
  scores: Record<string, number>;
  markers: string[];
  mentions: string[];
  /** The first category's option, or its group when it has one (the built-in set's "AI"). */
  lane: string | null;
  /** The story headline, when a story (not `none`) was chosen. */
  story: string | null;
}

export function mentionsOf(text: string, companies: string[]): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return companies.filter((c) => new RegExp(`(?<![\\w])${esc(c)}(?![\\w])`, "i").test(text));
}

/** Code-computed labels: markers at each marker's own threshold, faded choices, mentions, lane. */
export function deriveLabels(
  seg: Segment, answers: Record<string, JevAnswer> | null, set: LabelSet, version: string, stories: string[],
): SegmentLabels {
  const text = seg.utterances.filter((u) => !u.failed).map((u) => u.text).join(" ");
  const out: SegmentLabels = {
    segmentId: seg.id, labelSetVersion: version, unlabeled: answers === null, choices: {}, nouls: {}, scores: {}, markers: [],
    mentions: mentionsOf(text, set.companies), lane: null, story: null,
  };
  if (!answers) return out;
  const choice = (id: string) => {
    const a = answers[id];
    if (a?.type === "choice") out.choices[id] = { choice: a.choice, confidence: a.confidence, faded: a.confidence < set.fadedBelowConfidence };
  };
  for (const c of set.categories) choice(c.id);
  choice("story");
  for (const s of set.scores) {
    const a = answers[s.id];
    if (a?.type === "score") out.scores[s.id] = a.score;
  }
  for (const m of set.markers) {
    const a = answers[m.id];
    if (a?.type !== "noul") continue;
    out.nouls[m.id] = a.noul;
    if (a.noul >= m.threshold) out.markers.push(m.id);
  }
  const first = set.categories[0];
  const picked = first && out.choices[first.id]?.choice;
  if (picked) out.lane = first.options.find((o) => o.id === picked)?.group ?? picked;
  const story = out.choices.story?.choice;
  if (story && story !== "none") out.story = stories[Number(story.slice(1)) - 1] ?? null;
  return out;
}

/** A run of consecutive segments with the same option of the set's first category. */
export interface Section { id: string; category: string; option: string; lane: string; segmentIds: string[]; startMs: number; endMs: number }

/** Consecutive segments with the same first-category option, ignoring faded (and unlabeled) ones. */
export function sectionsOf(segments: Segment[], labels: Map<string, SegmentLabels>, set: LabelSet | null): Section[] {
  const out: Section[] = [];
  const cat = set?.categories[0]?.id;
  if (!cat) return out;
  for (const seg of segments) {
    const l = labels.get(seg.id);
    const c = l?.choices[cat];
    if (!l || l.unlabeled || !c || c.faded) continue;
    const last = out[out.length - 1];
    if (last && last.option === c.choice) {
      last.segmentIds.push(seg.id);
      last.endMs = Math.max(last.endMs, seg.endMs);
    } else {
      out.push({ id: `sec_${out.length + 1}`, category: cat, option: c.choice, lane: l.lane ?? c.choice, segmentIds: [seg.id], startMs: seg.startMs, endMs: seg.endMs });
    }
  }
  return out;
}

export interface TimelineDeps {
  ask(state: unknown, questions: QuestionSet, meta: JevCallMeta): Promise<JevResponse>;
  speakerName(id: string): string;
  emit(type: string, data: Record<string, unknown>): void;
  write(row: Record<string, unknown>): void;
  onError(component: string, message: string, detail?: Record<string, unknown>): void;
}

/**
 * Labels each closed segment with the session's label set, fixed when it started (no LLM writes or changes these
 * labels). Without a set, labels are off: segments are kept, for navigation, but never labelled.
 */
export class Timeline {
  private stories: string[];
  readonly segments: Segment[] = [];
  readonly labels = new Map<string, SegmentLabels>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private lastSections = "";

  constructor(
    private readonly cfg: AppConfig, private readonly locked: TimelineConfig, readonly set: LabelSet | null, stories: string[],
    private readonly deps: TimelineDeps,
  ) {
    this.stories = clean(stories);
  }

  get storiesActive(): string[] {
    return [...this.stories];
  }

  get version(): string {
    return this.set ? labelSetVersion(this.set, this.stories, this.locked.story) : "";
  }

  questions(): QuestionSet {
    return this.set ? setQuestions(this.set, this.stories, this.locked.story) : {};
  }

  sections(): Section[] {
    return sectionsOf(this.segments, this.labels, this.set);
  }

  /** PUT /api/stories: tonight's headlines, from the next segment. */
  setStories(headlines: string[]): string {
    const next = clean(headlines);
    if (next.length > 254) throw new Error("at most 254 stories");
    this.stories = next;
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
    if (this.set) this.track(this.label(this.set, seg, "segment"));
  }

  /** POST /api/labels/relabel: asks the set again on every closed segment, in the background. */
  relabel(): number {
    const set = this.set;
    if (!set) return 0;
    for (const seg of this.segments) this.track(this.label(set, seg, "relabel"));
    return this.segments.length;
  }

  private track(p: Promise<void>) {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private async label(set: LabelSet, seg: Segment, purpose: "segment" | "relabel"): Promise<void> {
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
    const l = deriveLabels(seg, answers, set, version, stories);
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

function clean(headlines: string[]): string[] {
  return headlines.map((h) => h.trim()).filter(Boolean);
}
