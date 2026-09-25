import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ChoiceQuestion, JevQuestion, NoulQuestion, QuestionId, ScoreQuestion } from "./jev/types.ts";

const positive = z.number().positive();
const nonNegative = z.number().min(0);
const probability = z.number().min(0).max(1);
const int = z.number().int().positive();

export const AppConfigSchema = z.object({
  server: z.object({ port: z.number().int().min(1).max(65535) }).strict(),
  budget: z.object({ sessionCapUsd: positive, devCapUsd: positive }).strict(),
  vad: z.object({
    threshold: probability, minSpeechDuration: positive, minSilenceDuration: positive, maxSpeechDuration: positive,
  }).strict(),
  speakers: z.object({ threshold: probability, minEmbedSeconds: positive, maxEmbeddingsPerSpeaker: int }).strict(),
  transcription: z.object({
    model: z.string().min(1),
    languages: z.array(z.string().min(1)),
    concurrency: int,
    timeoutMs: int,
    prompt: z.string(),
    keywords: z.array(z.string().min(1)),
    fixes: z.array(z.object({ pattern: z.string().min(1), replace: z.string() }).strict()),
    /** Streaming text for the display only (OpenAI realtime transcription); final text still comes from `model`. */
    live: z.object({
      enabled: z.boolean(),
      model: z.string().min(1),
      delay: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
      prerollMs: nonNegative,
      hangoverMs: nonNegative,
      usdPerMinute: nonNegative,
    }).strict().optional(),
  }).strict(),
  jev: z.object({
    model: z.string().min(1), utteranceTimeoutMs: int, segmentTimeoutMs: int, maxAttempts: int,
    backgroundTimeoutMs: int, backgroundMaxAttempts: int, concurrency: int, segmentConcurrency: int,
    /** OpenRouter provider routing, such as { data_collection: "deny" }; omitted from the request when absent. */
    provider: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  segmentation: z.object({
    boundaryThreshold: probability, speakerChangeGapMs: nonNegative, speakerChangeBonus: probability,
    minSegmentMs: nonNegative, maxSegmentMs: positive, reorderTimeoutMs: int,
  }).strict().refine((s) => s.minSegmentMs <= s.maxSegmentMs, {
    message: "segmentation.minSegmentMs must not exceed segmentation.maxSegmentMs",
  }),
  timeline: z.object({
    noulMarkerThreshold: probability, clipWorthyMin: nonNegative, fadedBelowConfidence: probability,
    companies: z.array(z.string().min(1)), stories: z.array(z.string().min(1)),
  }).strict(),
  s2: z.object({
    model: z.string().min(1),
    provider: z.object({
      order: z.array(z.string()), allow_fallbacks: z.boolean(), require_parameters: z.boolean(),
    }).passthrough(),
    web: z.object({ engine: z.enum(["exa", "native"]), max_results: int }).strict(),
    effort: z.object({
      research: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
      audit: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
      rewrite: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
    }).strict(),
    timeoutMs: int, maxAttempts: int, researchConcurrency: int, maxResearchPerHour: int, maxResearchPerSession: int,
    staleAfterMs: int,
  }).strict(),
  factcheck: z.object({
    hedgedThreshold: probability, knownMatchThreshold: probability, maxKnownQuestions: int,
    auditIntervalMs: int, auditMinUtterances: int, auditSample: int,
    rewriteOnFalseAlarms: int, rewriteOnMisses: int, rewriteCooldownMs: nonNegative, replayMaxItems: int,
  }).strict(),
}).strict();
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** The timeline label set (§4.9). `boundary` is asked per utterance; `questions` per closed segment. */
export const LabelSetSchema = z.object({
  prefix: z.string(),
  boundary: NoulQuestion,
  questions: z.record(QuestionId, JevQuestion).refine((q) => Object.keys(q).length > 0, "at least one question")
    .refine((q) => !("story" in q), "`story` is generated from timeline.stories; do not define it"),
  story: z.object({ instructions: z.string().min(1), none: z.string().min(1) }).strict(),
}).strict();
export type LabelSet = z.infer<typeof LabelSetSchema>;

export const CLAIM_TYPE_KEYS = [
  "number_or_price", "date_or_release", "quote_or_attribution", "capability_or_benchmark", "event", "prediction", "none",
] as const;

export const S1ThresholdsSchema = z.object({
  claimThreshold: z.number().min(0.5).max(0.9),
  worthMin: z.number().min(1).max(3),
  attentionThreshold: z.number().min(0.5).max(0.9),
}).strict();
export type S1Thresholds = z.infer<typeof S1ThresholdsSchema>;

/** A fact-check System 1 question set (§4.8a). Attention questions are optional nouls named attention_<n>. */
export const S1QuestionsSchema = z.object({
  claim: NoulQuestion,
  claim_type: ChoiceQuestion.refine(
    (q) => {
      const keys = Object.keys(q.criteria).sort();
      return keys.length === CLAIM_TYPE_KEYS.length && [...CLAIM_TYPE_KEYS].sort().every((k, i) => keys[i] === k);
    },
    { message: `claim_type must have exactly the keys ${CLAIM_TYPE_KEYS.join(", ")}` },
  ),
  hedged: NoulQuestion,
  worth: ScoreQuestion.refine((q) => q.criteria.length === 5, "worth must have exactly 5 levels"),
}).catchall(NoulQuestion).superRefine((q, ctx) => {
  const extra = Object.keys(q).filter((k) => !["claim", "claim_type", "hedged", "worth"].includes(k));
  for (const k of extra) {
    if (!/^attention_\d+$/.test(k)) ctx.addIssue({ code: "custom", message: `unexpected System 1 question ${k}` });
  }
  if (extra.length > 3) ctx.addIssue({ code: "custom", message: "at most 3 attention questions" });
});
export type S1Questions = z.infer<typeof S1QuestionsSchema>;

export const S1SetSchema = z.object({
  id: z.string().regex(/^s1@\d+$/),
  questions: S1QuestionsSchema,
  thresholds: S1ThresholdsSchema,
}).strict();
export type S1Set = z.infer<typeof S1SetSchema>;

export interface Config { app: AppConfig; labels: LabelSet; s1: S1Set }

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parse<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${file}: ${z.prettifyError(r.error)}`);
  return r.data;
}

export function loadConfig(dir = "config"): Config {
  const f = (name: string) => join(dir, name);
  return {
    app: parse(AppConfigSchema, readJson(f("app.json")), f("app.json")),
    labels: parse(LabelSetSchema, readJson(f("labels.default.json")), f("labels.default.json")),
    s1: parse(S1SetSchema, readJson(f("factcheck.s1.default.json")), f("factcheck.s1.default.json")),
  };
}

export const parseAppConfig = (v: unknown) => parse(AppConfigSchema, v, "app config");
export const parseLabelSet = (v: unknown) => parse(LabelSetSchema, v, "label set");
export const parseS1Set = (v: unknown) => parse(S1SetSchema, v, "System 1 set");
