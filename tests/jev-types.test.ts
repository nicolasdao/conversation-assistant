import { describe, expect, it } from "vitest";
import {
  choice, ChoiceQuestion, isFallbackOption, JevAnswerSchema, noul, NoulQuestion, QuestionId, QuestionSet, score, ScoreQuestion,
  type JevAnswer,
} from "../src/jev/types.ts";

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues.map((i) => i.message) ?? [];
const options = (n: number, fallback = "none") =>
  Object.fromEntries([...Array.from({ length: n - 1 }, (_, i) => [`o${i}`, `option ${i}`]), [fallback, "fallback"]]);

describe("Jev question shapes (src/jev/types.ts)", () => {
  it("isFallbackOption accepts none, other, other_x, otherwise; rejects None, x_other", () => {
    for (const k of ["none", "other", "other_x", "otherwise"]) expect(isFallbackOption(k)).toBe(true);
    for (const k of ["None", "x_other", "nothing", ""]) expect(isFallbackOption(k)).toBe(false);
  });

  it("ChoiceQuestion rejects 1 option, accepts 2 with a fallback, accepts 255 and rejects 256 options", () => {
    const q = (criteria: Record<string, string>) => ChoiceQuestion.safeParse({ type: "choice", instructions: "Pick", criteria });
    expect(messages(q({ none: "no" }))).toContain("a choice needs at least 2 options");
    expect(q({ a: "A", none: "no" }).success).toBe(true);
    expect(q(options(255)).success).toBe(true);
    expect(messages(q(options(256)))).toContain("a choice has at most 255 options");
    expect(messages(q({ a: "A", b: "B" }))).toContain("a choice needs a fallback option: `none` or a key starting with `other`");
    expect(q({ a: "A", none: "" }).success).toBe(false); // every option needs a description
  });

  it("ScoreQuestion rejects 1 and 11 levels and accepts 2 and 10", () => {
    const q = (n: number) => ScoreQuestion.safeParse({ type: "score", instructions: "How much", criteria: Array.from({ length: n }, (_, i) => `level ${i}`) });
    expect(messages(q(1))).toContain("a score needs at least 2 levels");
    expect(q(2).success).toBe(true);
    expect(q(10).success).toBe(true);
    expect(messages(q(11))).toContain("a score has at most 10 levels");
  });

  it("NoulQuestion rejects extra keys, criteria with extra keys (strict), and empty instructions", () => {
    expect(NoulQuestion.safeParse({ type: "noul", instructions: "Is it?" }).success).toBe(true);
    expect(NoulQuestion.safeParse({ type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } }).success).toBe(true);
    expect(NoulQuestion.safeParse({ type: "noul", instructions: "Is it?", extra: 1 }).success).toBe(false);
    expect(NoulQuestion.safeParse({ type: "noul", instructions: "Is it?", criteria: { true: "y", false: "n", maybe: "m" } }).success).toBe(false);
    expect(NoulQuestion.safeParse({ type: "noul", instructions: "Is it?", criteria: { true: "y" } }).success).toBe(false);
    expect(NoulQuestion.safeParse({ type: "noul", instructions: "" }).success).toBe(false);
  });

  it("QuestionId rejects '1abc', 'Abc', 'a-b', ''; accepts 'a', 'a_1'", () => {
    for (const id of ["1abc", "Abc", "a-b", "", "_a"]) expect(messages(QuestionId.safeParse(id))).toEqual(["question ids are snake_case"]);
    for (const id of ["a", "a_1", "claim_type"]) expect(QuestionId.safeParse(id).success).toBe(true);
    expect(QuestionSet.safeParse({ Bad: { type: "noul", instructions: "x" } }).success).toBe(false);
    expect(QuestionSet.safeParse({ good: { type: "noul", instructions: "x" } }).success).toBe(true);
  });

  it("noul/choice/score return null for undefined answers, a missing id, and a wrong answer type", () => {
    const answers: Record<string, JevAnswer> = {
      n: { type: "noul", noul: 0.4 },
      c: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, none: 0.2 } },
      s: { type: "score", score: 2.5, confidence: 0.6, probabilities: {} },
    };
    expect(noul(answers, "n")).toBe(0.4);
    expect(choice(answers, "c")?.choice).toBe("a");
    expect(score(answers, "s")).toBe(2.5);
    for (const f of [noul, choice, score]) {
      expect(f(undefined, "n")).toBeNull();
      expect(f(answers, "missing")).toBeNull();
    }
    expect(noul(answers, "c")).toBeNull();
    expect(choice(answers, "s")).toBeNull();
    expect(score(answers, "n")).toBeNull();
    expect(noul({ z: { type: "noul", noul: 0 } }, "z")).toBe(0); // a zero answer is an answer
  });

  it("JevAnswerSchema accepts each answer type with extra fields and rejects a noul without a number", () => {
    expect(JevAnswerSchema.safeParse({ type: "noul", noul: 0.9, extra: true }).success).toBe(true);
    expect(JevAnswerSchema.safeParse({ type: "choice", choice: "a", confidence: 1, probabilities: { a: 1 }, extra: 1 }).success).toBe(true);
    expect(JevAnswerSchema.safeParse({ type: "score", score: 1, confidence: 1, probabilities: { 0: 0 }, legend: { 0: "low" }, x: 1 }).success).toBe(true);
    expect(JevAnswerSchema.safeParse({ type: "noul" }).success).toBe(false);
    expect(JevAnswerSchema.safeParse({ type: "noul", noul: "0.9" }).success).toBe(false);
    expect(JevAnswerSchema.safeParse({ type: "choice", choice: "a" }).success).toBe(false);
  });
});
