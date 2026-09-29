// A label set: the timeline's labels as data — up to 2 categories (Jev choices), 2 scores (5 levels), and 8 markers
// (yes/no, shown as an icon) — plus how to ask and show them. See docs/jev.md § The timeline questions.
import { createHash } from "node:crypto";
import { z } from "zod";
import { ICONS } from "../../web/src/icons.ts";
import { isFallbackOption, QuestionId, type QuestionSet } from "../jev/types.ts";

export const LABEL_FORMAT = "tattle-labels";
export const LIMITS = { categories: 2, scores: 2, markers: 8, options: 255, levels: 5 } as const;
/** Question ids the app asks itself: `story` is generated from tonight's stories, `boundary` is per utterance. */
export const RESERVED_IDS = ["story", "boundary"];

const nonBlank = z.string().refine((s) => s.trim().length > 0, "must not be empty");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colours are #rrggbb");

const OptionSchema = z.object({
  id: QuestionId,
  name: nonBlank.pipe(z.string().max(60)),
  /** What Jev reads for this option: the choice question's criteria. */
  description: nonBlank,
  color,
  /** Options sharing a group are offered together in the category's filter (the built-in set's "AI"). */
  group: nonBlank.pipe(z.string().max(40)).optional(),
}).strict();

const IndexSchema = z.object({
  name: nonBlank.pipe(z.string().max(40)),
  description: nonBlank.pipe(z.string().max(200)),
  options: z.array(z.string()).min(1),
}).strict();

const CategorySchema = z.object({
  id: QuestionId,
  name: nonBlank.pipe(z.string().max(40)),
  instructions: nonBlank,
  options: z.array(OptionSchema).min(2, "a category needs at least 2 options").max(LIMITS.options, `a category has at most ${LIMITS.options} options`),
  /** A share of time shown as one big number in Insights (the built-in set's Off-topic index). */
  index: IndexSchema.optional(),
}).strict();

const ScoreSchema = z.object({
  id: QuestionId,
  name: nonBlank.pipe(z.string().max(40)),
  instructions: nonBlank,
  /** Always 5, lowest first, so every score shares the chart's 0–4 axis. */
  levels: z.array(nonBlank).length(LIMITS.levels, `a score has exactly ${LIMITS.levels} levels`),
}).strict();

const MarkerSchema = z.object({
  id: QuestionId,
  name: nonBlank.pipe(z.string().max(40)),
  short: nonBlank.pipe(z.string().max(20)),
  icon: z.enum(ICONS),
  instructions: nonBlank,
  /** Concrete true/false wording; optional, as for any Jev yes/no question, but it sharpens fuzzy cases. */
  criteria: z.object({ true: nonBlank, false: nonBlank }).strict().optional(),
  /** The marker shows when Jev's yes probability reaches this. */
  threshold: z.number().min(0).max(1),
  /** Counted per speaker in Insights. */
  perSpeaker: z.boolean(),
  /** Listed in Insights, each entry jumping to its segment. */
  list: z.boolean(),
}).strict();

export const LabelSetSchema = z.object({
  format: z.literal(LABEL_FORMAT),
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "set ids are lowercase letters, digits, and dashes").max(64),
  name: nonBlank.pipe(z.string().max(80)),
  description: z.string().max(500),
  /** Only the sets shipped in config/labels/; stripped on import and clone. */
  builtIn: z.boolean().optional(),
  /** Prepended to every question's instructions. */
  prefix: z.string().max(500),
  /** Choices less sure than this are drawn faded and left out of sections. */
  fadedBelowConfidence: z.number().min(0).max(1),
  /** Company names spotted in each segment by code (whole words, any case). */
  companies: z.array(nonBlank.pipe(z.string().max(60))).max(200),
  /** The first category draws the section brackets. */
  categories: z.array(CategorySchema).max(LIMITS.categories, `at most ${LIMITS.categories} categories`),
  scores: z.array(ScoreSchema).max(LIMITS.scores, `at most ${LIMITS.scores} scores`),
  markers: z.array(MarkerSchema).max(LIMITS.markers, `at most ${LIMITS.markers} markers`),
}).strict().superRefine((set, ctx) => {
  const labels = [...set.categories, ...set.scores, ...set.markers];
  if (labels.length === 0) ctx.addIssue({ code: "custom", message: "a label set needs at least one label" });
  const seen = new Set<string>();
  for (const l of labels) {
    if (RESERVED_IDS.includes(l.id)) ctx.addIssue({ code: "custom", message: `${l.id} is reserved: use another id` });
    if (seen.has(l.id)) ctx.addIssue({ code: "custom", message: `the id ${l.id} is used twice` });
    seen.add(l.id);
  }
  let indexes = 0;
  for (const c of set.categories) {
    const ids = new Set<string>();
    for (const o of c.options) {
      if (ids.has(o.id)) ctx.addIssue({ code: "custom", message: `${c.name}: the option id ${o.id} is used twice` });
      ids.add(o.id);
    }
    // Jev's choices always pick an option, so each needs one that fits anything else
    if (![...ids].some(isFallbackOption)) {
      ctx.addIssue({ code: "custom", message: `${c.name} needs a fallback option: an option id of none, or starting with other` });
    }
    if (c.index) {
      indexes++;
      for (const o of c.index.options) if (!ids.has(o)) ctx.addIssue({ code: "custom", message: `${c.name}'s index names ${o}, which is not one of its options` });
    }
  }
  if (indexes > 1) ctx.addIssue({ code: "custom", message: "at most one category has an index" });
});

export type LabelSet = z.infer<typeof LabelSetSchema>;
export type Category = LabelSet["categories"][number];
export type Score = LabelSet["scores"][number];
export type Marker = LabelSet["markers"][number];

/** The story question's wording, which lives in config/timeline.json and is the same for every set. */
export interface StoryWording { instructions: string; none: string }

/** Validates a set; throws with every problem, one per line. */
export function parseLabelSet(v: unknown): LabelSet {
  const r = LabelSetSchema.safeParse(v);
  if (!r.success) throw new Error(z.prettifyError(r.error));
  return r.data;
}

/** Validates a set without throwing: the problems as short sentences, each naming where it is. */
export function checkLabelSet(v: unknown): { ok: true; set: LabelSet; errors: [] } | { ok: false; set: null; errors: string[] } {
  const r = LabelSetSchema.safeParse(v);
  if (r.success) return { ok: true, set: r.data, errors: [] };
  return {
    ok: false, set: null,
    errors: r.error.issues.map((i) => (i.path.length ? `${where(v, i.path)}: ${i.message}` : i.message)),
  };
}

/** "Markers › Hot take › threshold" rather than markers.2.threshold. */
function where(root: unknown, path: PropertyKey[]): string {
  const parts: string[] = [];
  let node: any = root;
  for (const p of path) {
    node = node?.[p as any];
    if (typeof p === "number") parts.push(typeof node?.name === "string" && node.name.trim() ? node.name : `#${p + 1}`);
    else parts.push(String(p));
  }
  return parts.join(" › ");
}

/** The per-segment Jev questions: every instruction gets the prefix; `story` is generated from tonight's headlines. */
export function setQuestions(set: LabelSet, stories: string[], story: StoryWording): QuestionSet {
  const pre = set.prefix ? `${set.prefix} ` : "";
  const out: QuestionSet = {};
  for (const c of set.categories) {
    out[c.id] = { type: "choice", instructions: pre + c.instructions, criteria: Object.fromEntries(c.options.map((o) => [o.id, o.description])) };
  }
  for (const s of set.scores) out[s.id] = { type: "score", instructions: pre + s.instructions, criteria: [...s.levels] };
  for (const m of set.markers) {
    out[m.id] = m.criteria
      ? { type: "noul", instructions: pre + m.instructions, criteria: { ...m.criteria } }
      : { type: "noul", instructions: pre + m.instructions };
  }
  if (stories.length > 0) {
    const criteria: Record<string, string> = {};
    stories.forEach((h, i) => { criteria[`s${i + 1}`] = h; });
    criteria.none = story.none;
    out.story = { type: "choice", instructions: pre + story.instructions, criteria };
  }
  return out;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** First 12 hex characters of SHA-256 over the canonical JSON of the questions Jev is asked (stories included). */
export function labelSetVersion(set: LabelSet, stories: string[], story: StoryWording): string {
  const json = JSON.stringify(canonical(setQuestions(set, stories, story)));
  return createHash("sha256").update(json).digest("hex").slice(0, 12);
}

/** Segments in an hour of show (about one every 30 s), for the cost estimate. */
const SEGMENTS_PER_HOUR = 120;
/** Jev's price per input token (docs/jev.md § Limits and price); output is free. */
const USD_PER_TOKEN = 0.042 / 1_000_000;
/** The segment and the one before it, as Jev reads them. */
const STATE_TOKENS = 1_500;
/** Jev's limit is 32,000 tokens for the state plus the questions; the estimate is rough, so it warns early. */
export const TOKEN_LIMIT = 32_000;
const WARN_TOKENS = 30_000;

/**
 * A rough cost of asking a set: characters of every instruction and criterion / 4, plus the segment text, per call;
 * 120 calls an hour. Stories add a little more.
 */
export function estimate(set: LabelSet): { tokens: number; perHourUsd: number; overLimit: boolean } {
  const q = setQuestions(set, [], { instructions: "", none: "" });
  const chars = JSON.stringify(q).length;
  const tokens = Math.ceil(chars / 4) + STATE_TOKENS;
  return { tokens, perHourUsd: SEGMENTS_PER_HOUR * tokens * USD_PER_TOKEN, overLimit: tokens > WARN_TOKENS };
}

/**
 * The editor's live check of a draft: the problems, and the estimate. A draft that does not validate yet is estimated
 * from its text, so the footer keeps moving while the host types.
 */
export function checkDraft(draft: unknown): { ok: boolean; errors: string[]; tokens: number; perHourUsd: number; overLimit: boolean } {
  const r = checkLabelSet(draft);
  if (r.ok) return { ok: true, errors: [], ...estimate(r.set) };
  const d = (draft ?? {}) as Record<string, unknown>;
  const chars = JSON.stringify([d.prefix, d.categories, d.scores, d.markers]).length;
  const tokens = Math.ceil(chars / 4) + STATE_TOKENS;
  return { ok: false, errors: r.errors, tokens, perHourUsd: SEGMENTS_PER_HOUR * tokens * USD_PER_TOKEN, overLimit: tokens > WARN_TOKENS };
}

/** What the library lists for a set. */
export function countsOf(set: LabelSet) {
  return { categories: set.categories.length, scores: set.scores.length, markers: set.markers.length };
}
