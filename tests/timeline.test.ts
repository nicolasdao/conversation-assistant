import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { JevAnswer, QuestionSet } from "../src/jev/types.ts";
import type { JevCallMeta } from "../src/jev/client.ts";
import type { PipelineUtterance, Segment } from "../src/pipeline/segmenter.ts";
import {
  deriveLabels, LabelConflictError, labelSetVersion, mentionsOf, sectionsOf, segmentState, Timeline, timelineQuestions, type SegmentLabels,
} from "../src/pipeline/timeline.ts";

const cfg = loadConfig();
const clone = <T>(v: T): T => structuredClone(v);

const u = (id: string, speakerId: string, text: string, tags: string[] = []): PipelineUtterance => ({
  id, stream: "remote", startMs: 0, endMs: 1000, speakerId, speakerInferred: false, text, filler: false, failed: false, tags: tags as any,
});
const seg = (id: string, startMs: number, endMs: number, utts: PipelineUtterance[]): Segment => ({ id, startMs, endMs, utterances: utts, forced: false, final: false });

const choiceA = (c: string, confidence = 0.9): JevAnswer => ({ type: "choice", choice: c, confidence, probabilities: {} });
const labelsFor = (segmentId: string, subject: string, confidence = 0.9): SegmentLabels =>
  deriveLabels(seg(segmentId, 0, 1, []), { subject: choiceA(subject, confidence) }, cfg.app.timeline, "v", []);

describe("timeline", () => {
  test("questions get the prefix; boundary never does; story is generated", () => {
    const q = timelineQuestions(cfg.labels, []);
    expect(Object.keys(q)).toEqual(Object.keys(cfg.labels.questions));
    expect(q.subject.instructions).toBe("Judge only segment; previous_segment is context only. What is the current segment mainly about?");
    expect("boundary" in q).toBe(false);
    const withStories = timelineQuestions(cfg.labels, ["OpenAI ships GPT-6 Sol", "Nvidia earnings"]);
    expect(withStories.story).toEqual({
      type: "choice",
      instructions: "Judge only segment; previous_segment is context only. Which of tonight's stories is the current segment about?",
      criteria: { s1: "OpenAI ships GPT-6 Sol", s2: "Nvidia earnings", none: "None of these stories." },
    });
    expect(cfg.labels.boundary.instructions.startsWith("Judge only")).toBe(false);
  });

  test("label-set version: 12 hex, key-order independent, changes with stories", () => {
    const v = labelSetVersion(cfg.labels, []);
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    const reordered = { ...cfg.labels, questions: Object.fromEntries(Object.entries(cfg.labels.questions).reverse()) };
    expect(labelSetVersion(reordered, [])).toBe(v);
    expect(labelSetVersion(cfg.labels, ["x"])).not.toBe(v);
    const changedBoundary = clone(cfg.labels);
    changedBoundary.boundary.instructions = "different";
    expect(labelSetVersion(changedBoundary, [])).toBe(v); // boundary is not part of the label-set version
  });

  test("state building: previous_segment and segment with names, text, tags only", () => {
    const a = seg("seg_1", 0, 5000, [u("u_1", "spk_1", "hello", ["loud"])]);
    const b = seg("seg_2", 5000, 9000, [u("u_2", "spk_2", "hi"), { ...u("u_3", "spk_2", ""), failed: true }]);
    const names: Record<string, string> = { spk_1: "Nic", spk_2: "Speaker 2" };
    expect(segmentState(a, b, (id) => names[id])).toEqual({
      previous_segment: [{ speaker: "Nic", text: "hello", tags: ["loud"] }],
      segment: [{ speaker: "Speaker 2", text: "hi", tags: [] }],
    });
    expect(segmentState(null, a, (id) => names[id]).previous_segment).toEqual([]);
  });

  test("markers and faded rules", () => {
    const s = seg("seg_1", 0, 20_000, [u("u_1", "spk_1", "OpenAI and nvidia, not openairline or Metadata")]);
    const l = deriveLabels(s, {
      subject: choiceA("ai_models", 0.49),
      mode: choiceA("news", 0.5),
      disagreement: { type: "noul", noul: 0.7 },
      humour: { type: "noul", noul: 0.69 },
      clip_worthy: { type: "score", score: 3, confidence: 1, probabilities: {} },
      heat: { type: "score", score: 4, confidence: 1, probabilities: {} },
    }, cfg.app.timeline, "v", []);
    expect(l.choices.subject).toEqual({ choice: "ai_models", confidence: 0.49, faded: true });
    expect(l.choices.mode.faded).toBe(false);
    expect(l.markers).toEqual(["disagreement", "clip_worthy"]);
    expect(l.lane).toBe("ai");
    expect(l.scores.heat).toBe(4);
    expect(l.unlabeled).toBe(false);
    const low = deriveLabels(s, { clip_worthy: { type: "score", score: 2.99, confidence: 1, probabilities: {} } }, cfg.app.timeline, "v", []);
    expect(low.markers).toEqual([]);
    expect(deriveLabels(s, null, cfg.app.timeline, "v", []).unlabeled).toBe(true);
  });

  test("mentions are case-insensitive whole words", () => {
    expect(mentionsOf("openai, NVIDIA and Hugging Face; not OpenAIs or Metaverse", cfg.app.timeline.companies)).toEqual(["OpenAI", "Nvidia", "Hugging Face"]);
    expect(mentionsOf("OpenAIs and Metaverse", cfg.app.timeline.companies)).toEqual([]);
    expect(mentionsOf("Meta. OpenAI!", cfg.app.timeline.companies)).toEqual(["OpenAI", "Meta"]);
  });

  test("sections merge consecutive same-subject segments, ignoring faded ones", () => {
    const segs = ["seg_1", "seg_2", "seg_3", "seg_4", "seg_5"].map((id, i) => seg(id, i * 10, i * 10 + 10, []));
    const labels = new Map([
      ["seg_1", labelsFor("seg_1", "ai_models")],
      ["seg_2", labelsFor("seg_2", "ai_models")],
      ["seg_3", labelsFor("seg_3", "personal_life", 0.3)], // faded: ignored
      ["seg_4", labelsFor("seg_4", "ai_models")],
      ["seg_5", labelsFor("seg_5", "personal_life")],
    ]);
    const s = sectionsOf(segs, labels);
    expect(s.map((x) => [x.subject, x.segmentIds])).toEqual([["ai_models", ["seg_1", "seg_2", "seg_4"]], ["personal_life", ["seg_5"]]]);
    expect(s[0]).toMatchObject({ lane: "ai", startMs: 0, endMs: 40 });
  });

  function timeline(answer: (q: QuestionSet, m: JevCallMeta) => Record<string, JevAnswer> | "fail") {
    const events: { type: string; data: any }[] = [];
    const asked: { q: QuestionSet; m: JevCallMeta; state: any }[] = [];
    const t = new Timeline(cfg.app, cfg.labels, {
      async ask(state, q, m) {
        asked.push({ q, m, state });
        const a = answer(q, m);
        if (a === "fail") throw new Error("timeout");
        return { answers: a, id: "", model: "", provider: "", usage: { input_tokens: 0, output_tokens: 0, cost: 0 } };
      },
      speakerName: (id) => id,
      emit: (type, data) => events.push({ type, data }),
      write: () => {},
      onError: () => {},
    });
    return { t, events, asked };
  }

  test("config replacement: validated, active from the next segment; a boundary change is a conflict", async () => {
    const { t, asked } = timeline(() => ({ subject: choiceA("tech") }));
    t.onSegmentClosed(seg("seg_1", 0, 1, [u("u_1", "spk_1", "a")]));
    await t.idle();
    const next = clone(cfg.labels) as any;
    delete next.questions.heat;
    next.questions.jargon = { type: "noul", instructions: "Uses jargon." };
    const v = t.replaceLabels(next);
    expect(v).not.toBe(labelSetVersion(cfg.labels, []));
    t.onSegmentClosed(seg("seg_2", 1, 2, [u("u_2", "spk_1", "b")]));
    await t.idle();
    expect(Object.keys(asked[0].q)).toContain("heat");
    expect(Object.keys(asked[1].q)).toContain("jargon");
    expect(Object.keys(asked[1].q)).not.toContain("heat");
    expect(asked[1].m).toMatchObject({ purpose: "segment", segment_id: "seg_2", question_set_version: v });
    expect(asked[1].state.previous_segment).toEqual([{ speaker: "spk_1", text: "a", tags: [] }]);

    const badBoundary = clone(next);
    badBoundary.boundary.instructions = "something else";
    expect(() => t.replaceLabels(badBoundary)).toThrow(LabelConflictError);
    const invalid = clone(next);
    invalid.questions.subject.criteria = { a: "only one" };
    expect(() => t.replaceLabels(invalid)).toThrow();
  });

  test("a failed request marks the segment unlabeled; relabel asks again in the background", async () => {
    let fail = true;
    const { t, events, asked } = timeline(() => (fail ? "fail" : { subject: choiceA("personal_life") }));
    t.onSegmentClosed(seg("seg_1", 0, 1, [u("u_1", "spk_1", "surfing")]));
    await t.idle();
    expect(t.labels.get("seg_1")!.unlabeled).toBe(true);
    fail = false;
    t.setStories(["Surf report"]);
    expect(t.relabel()).toBe(1);
    await t.idle();
    expect(asked[1].m.purpose).toBe("relabel");
    expect(Object.keys(asked[1].q)).toContain("story");
    expect(t.labels.get("seg_1")).toMatchObject({ unlabeled: false, lane: "personal_life" });
    expect(events.filter((e) => e.type === "segment.labels").length).toBe(2);
    expect(events.some((e) => e.type === "section.updated")).toBe(true);
  });
});
