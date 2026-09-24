import { z } from "zod";

/** Question shapes of the Decisions API (§2.2), with the authoring rules of §2.5 enforced. */
export const NoulQuestion = z.object({
  type: z.literal("noul"),
  instructions: z.string().min(1),
  criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }).strict().optional(),
}).strict();

export const ChoiceQuestion = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1),
  criteria: z.record(z.string(), z.string().min(1)),
}).strict().superRefine((q, ctx) => {
  const keys = Object.keys(q.criteria);
  if (keys.length < 2) ctx.addIssue({ code: "custom", message: "a choice needs at least 2 options" });
  if (keys.length > 255) ctx.addIssue({ code: "custom", message: "a choice has at most 255 options" });
  if (!keys.some(isFallbackOption)) {
    ctx.addIssue({ code: "custom", message: "a choice needs a fallback option: `none` or a key starting with `other`" });
  }
});

export const ScoreQuestion = z.object({
  type: z.literal("score"),
  instructions: z.string().min(1),
  criteria: z.array(z.string().min(1)).min(2, "a score needs at least 2 levels").max(10, "a score has at most 10 levels"),
}).strict();

export const JevQuestion = z.union([NoulQuestion, ChoiceQuestion, ScoreQuestion]);
export type JevQuestion = z.infer<typeof JevQuestion>;
export type NoulQuestion = z.infer<typeof NoulQuestion>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestion>;
export type ScoreQuestion = z.infer<typeof ScoreQuestion>;

export const QuestionId = z.string().regex(/^[a-z][a-z0-9_]*$/, "question ids are snake_case");
export const QuestionSet = z.record(QuestionId, JevQuestion);
export type QuestionSet = Record<string, JevQuestion>;

export function isFallbackOption(key: string): boolean {
  return key === "none" || key.startsWith("other");
}

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = {
  type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, string>;
};
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export const JevAnswerSchema = z.union([
  z.object({ type: z.literal("noul"), noul: z.number() }).passthrough(),
  z.object({
    type: z.literal("choice"), choice: z.string(), confidence: z.number(), probabilities: z.record(z.string(), z.number()),
  }).passthrough(),
  z.object({
    type: z.literal("score"), score: z.number(), confidence: z.number(), probabilities: z.record(z.string(), z.number()),
    legend: z.record(z.string(), z.string()).optional(),
  }).passthrough(),
]);

export interface JevUsage { input_tokens: number; output_tokens: number; cost: number }

export interface JevResponse {
  answers: Record<string, JevAnswer>;
  id: string | null;
  model: string;
  provider: string | null;
  usage: JevUsage;
}

/** The utterance shape inside every Jev state (§4.7): display names, text, and tags only. */
export interface StateUtterance { speaker: string; text: string; tags: string[] }

export function noul(answers: Record<string, JevAnswer> | undefined, id: string): number | null {
  const a = answers?.[id];
  return a && a.type === "noul" ? a.noul : null;
}

export function choice(answers: Record<string, JevAnswer> | undefined, id: string): ChoiceAnswer | null {
  const a = answers?.[id];
  return a && a.type === "choice" ? a : null;
}

export function score(answers: Record<string, JevAnswer> | undefined, id: string): number | null {
  const a = answers?.[id];
  return a && a.type === "score" ? a.score : null;
}
