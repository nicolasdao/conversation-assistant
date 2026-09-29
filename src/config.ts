import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appPaths } from "./paths.ts";
import { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "./jev/types.ts";
import { LabelSetSchema, type LabelSet } from "./labels/model.ts";

export type { LabelSet };

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
  /** Speaker mode: mutes the microphone while the call plays through the Mac's speakers (see src/audio/echoGate.ts). */
  echoGate: z.object({
    mode: z.enum(["auto", "always", "never"]),
    thresholdDbfs: z.number().max(0),
    holdMs: nonNegative,
  }).strict(),
  speakers: z.object({
    threshold: probability, minEmbedSeconds: positive, maxEmbeddingsPerSpeaker: int,
    /** The most voices each stream carries (0 = no limit); a session can override the remote count. */
    voicesPerStream: z.object({ host: z.number().int().min(0), remote: z.number().int().min(0) }).strict(),
  }).strict(),
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
    /** On-device transcription with Apple Speech (macOS 26+): one clip per utterance, live text from stream analyzers. */
    apple: z.object({
      locale: z.string().min(1).default("en-US"),
      clipPadMs: nonNegative.default(300),
      clipConcurrency: int.default(2),
      /** Plus twice the clip's length: it only catches a stuck helper, and a busy Mac (or a --speed max replay) is slow. */
      clipTimeoutMs: int.default(20000),
    }).strict().default({ locale: "en-US", clipPadMs: 300, clipConcurrency: 2, clipTimeoutMs: 20000 }),
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
    // with fact-checking and labels both off, Jev is never asked: a pause this long ends a segment instead
    pauseBoundaryMs: positive,
  }).strict().refine((s) => s.minSegmentMs <= s.maxSegmentMs, {
    message: "segmentation.minSegmentMs must not exceed segmentation.maxSegmentMs",
  }),
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
  // Create with AI: an LLM drafts a label set for the host to review and save (src/labels/assist.ts). One fixed model, no picker.
  labelsAssist: z.object({
    model: z.string().min(1),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
    provider: z.object({}).passthrough(),
    timeoutMs: int, maxAttempts: int,
    /** The most one Create with AI conversation may spend. */
    capUsd: positive,
  }).strict(),
  // The chat window: questions about the transcript, to any of `models` through OpenRouter (see docs/chat.md)
  chat: z.object({
    defaultModel: z.string().min(1),
    models: z.array(z.string().min(1)).min(1),
    provider: z.object({}).passthrough(),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
    capUsd: positive, timeoutMs: int, maxAttempts: int,
  }).strict().refine((c) => c.models.includes(c.defaultModel), { message: "chat.defaultModel must be one of chat.models" }),
}).strict();
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * The timeline's locked questions, the same for every label set: `boundary`, asked per utterance, decides where segments
 * end and is calibrated (`npm run calibrate:boundary`); `story` is the wording of the question generated from tonight's
 * stories. The labels themselves are label sets (config/labels/, and the user's own; see src/labels/).
 */
export const TimelineConfigSchema = z.object({
  boundary: NoulQuestion,
  story: z.object({ instructions: z.string().min(1), none: z.string().min(1) }).strict(),
}).strict();
export type TimelineConfig = z.infer<typeof TimelineConfigSchema>;

/** The built-in set a session uses when none is named. */
export const DEFAULT_LABEL_SET = "ai-podcast";

export const CLAIM_TYPE_KEYS = [
  "number_or_price", "date_or_release", "quote_or_attribution", "capability_or_benchmark", "event", "prediction", "none",
] as const;

export const S1ThresholdsSchema = z.object({
  claimThreshold: z.number().min(0.5).max(0.9),
  /** The `public` answer a flag needs: the claim is about the public world, not the speakers' private lives. */
  publicThreshold: z.number().min(0.5).max(0.9),
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
  public: NoulQuestion,
  hedged: NoulQuestion,
  worth: ScoreQuestion.refine((q) => q.criteria.length === 5, "worth must have exactly 5 levels"),
}).catchall(NoulQuestion).superRefine((q, ctx) => {
  const extra = Object.keys(q).filter((k) => !["claim", "claim_type", "public", "hedged", "worth"].includes(k));
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

/** `labels`: the default built-in label set (config/labels/ai-podcast.json). */
export interface Config { app: AppConfig; timeline: TimelineConfig; labels: LabelSet; s1: S1Set }

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parse<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${file}: ${z.prettifyError(r.error)}`);
  return r.data;
}

export function loadConfig(dir = appPaths().config): Config {
  const f = (name: string) => join(dir, name);
  return {
    app: parse(AppConfigSchema, readJson(f("app.json")), f("app.json")),
    timeline: parse(TimelineConfigSchema, readJson(f("timeline.json")), f("timeline.json")),
    labels: parse(LabelSetSchema, readJson(f(`labels/${DEFAULT_LABEL_SET}.json`)), f(`labels/${DEFAULT_LABEL_SET}.json`)),
    s1: parse(S1SetSchema, readJson(f("factcheck.s1.default.json")), f("factcheck.s1.default.json")),
  };
}

export const parseAppConfig = (v: unknown) => parse(AppConfigSchema, v, "app config");
export const parseS1Set = (v: unknown) => parse(S1SetSchema, v, "System 1 set");
