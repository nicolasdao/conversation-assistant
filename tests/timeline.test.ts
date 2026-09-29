import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { JevAnswer, QuestionSet } from "../src/jev/types.ts";
import type { JevCallMeta } from "../src/jev/client.ts";
import { labelSetVersion, setQuestions, type LabelSet } from "../src/labels/model.ts";
import type { PipelineUtterance, Segment } from "../src/pipeline/segmenter.ts";
import { deriveLabels, mentionsOf, sectionsOf, segmentState, Timeline, type SegmentLabels } from "../src/pipeline/timeline.ts";

const cfg = loadConfig();
const set = cfg.labels;
const clone = <T>(v: T): T => structuredClone(v);

const u = (id: string, speakerId: string, text: string, tags: string[] = []): PipelineUtterance => ({
  id, stream: "remote", startMs: 0, endMs: 1000, speakerId, speakerInferred: false, text, filler: false, failed: false, tags: tags as any,
});
const seg = (id: string, startMs: number, endMs: number, utts: PipelineUtterance[]): Segment => ({ id, startMs, endMs, utterances: utts, forced: false, final: false });

const choiceA = (c: string, confidence = 0.9): JevAnswer => ({ type: "choice", choice: c, confidence, probabilities: {} });
const labelsFor = (segmentId: string, subject: string, confidence = 0.9): SegmentLabels =>
  deriveLabels(seg(segmentId, 0, 1, []), { subject: choiceA(subject, confidence) }, set, "v", []);

describe("timeline", () => {
  test("questions get the prefix; boundary is not one of them; story is generated", () => {
    const q = setQuestions(set, [], cfg.timeline.story);
    expect(Object.keys(q)).toEqual(["subject", "mode", "heat", "hype", "disagreement", "hot_take", "prediction", "recommendation", "clip_worthy", "humour"]);
    expect(q.subject.instructions).toBe("Judge only segment; previous_segment is context only. What is the current segment mainly about?");
    expect("boundary" in q).toBe(false);
    const withStories = setQuestions(set, ["OpenAI ships GPT-6 Sol", "Nvidia earnings"], cfg.timeline.story);
    expect(withStories.story).toEqual({
      type: "choice",
      instructions: "Judge only segment; previous_segment is context only. Which of tonight's stories is the current segment about?",
      criteria: { s1: "OpenAI ships GPT-6 Sol", s2: "Nvidia earnings", none: "None of these stories." },
    });
    expect(cfg.timeline.boundary.instructions.startsWith("Judge only")).toBe(false);
  });

  test("label-set version: 12 hex, independent of display fields, changes with the questions and the stories", () => {
    const v = labelSetVersion(set, [], cfg.timeline.story);
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    const renamed = clone(set);
    renamed.name = "Renamed";
    renamed.categories[0].options[0].color = "#000000";
    expect(labelSetVersion(renamed, [], cfg.timeline.story)).toBe(v);
    expect(labelSetVersion(set, ["x"], cfg.timeline.story)).not.toBe(v);
    const reworded = clone(set);
    reworded.markers[0].instructions = "different";
    expect(labelSetVersion(reworded, [], cfg.timeline.story)).not.toBe(v);
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

  test("markers at each marker's own threshold, faded choices, and the lane from the option's group", () => {
    const s = seg("seg_1", 0, 20_000, [u("u_1", "spk_1", "OpenAI and nvidia, not openairline or Metadata")]);
    const own = clone(set);
    own.markers.find((m) => m.id === "humour")!.threshold = 0.6;
    const l = deriveLabels(s, {
      subject: choiceA("ai_models", 0.49),
      mode: choiceA("news", 0.5),
      disagreement: { type: "noul", noul: 0.7 },
      humour: { type: "noul", noul: 0.69 },
      clip_worthy: { type: "noul", noul: 0.71 },
      hot_take: { type: "noul", noul: 0.69 },
      heat: { type: "score", score: 4, confidence: 1, probabilities: {} },
      unknown_question: { type: "noul", noul: 1 },
    }, own, "v", []);
    expect(l.choices.subject).toEqual({ choice: "ai_models", confidence: 0.49, faded: true });
    expect(l.choices.mode.faded).toBe(false);
    expect(l.markers).toEqual(["disagreement", "clip_worthy", "humour"]); // the set's order; humour at its own 0.6
    expect(l.nouls.hot_take).toBe(0.69);
    expect("unknown_question" in l.nouls).toBe(false);
    expect(l.lane).toBe("AI");
    expect(l.scores.heat).toBe(4);
    expect(l.mentions).toEqual(["OpenAI", "Nvidia"]);
    expect(l.unlabeled).toBe(false);
    expect(deriveLabels(s, { subject: choiceA("tech") }, set, "v", []).lane).toBe("tech");
    expect(deriveLabels(s, null, set, "v", []).unlabeled).toBe(true);
  });

  test("mentions are case-insensitive whole words", () => {
    expect(mentionsOf("openai, NVIDIA and Hugging Face; not OpenAIs or Metaverse", set.companies)).toEqual(["OpenAI", "Nvidia", "Hugging Face"]);
    expect(mentionsOf("OpenAIs and Metaverse", set.companies)).toEqual([]);
    expect(mentionsOf("Meta. OpenAI!", set.companies)).toEqual(["OpenAI", "Meta"]);
  });

  test("sections merge consecutive same-option segments of the first category, ignoring faded ones", () => {
    const segs = ["seg_1", "seg_2", "seg_3", "seg_4", "seg_5"].map((id, i) => seg(id, i * 10, i * 10 + 10, []));
    const labels = new Map([
      ["seg_1", labelsFor("seg_1", "ai_models")],
      ["seg_2", labelsFor("seg_2", "ai_models")],
      ["seg_3", labelsFor("seg_3", "personal_life", 0.3)], // faded: ignored
      ["seg_4", labelsFor("seg_4", "ai_models")],
      ["seg_5", labelsFor("seg_5", "personal_life")],
    ]);
    const s = sectionsOf(segs, labels, set);
    expect(s.map((x) => [x.option, x.segmentIds])).toEqual([["ai_models", ["seg_1", "seg_2", "seg_4"]], ["personal_life", ["seg_5"]]]);
    expect(s[0]).toMatchObject({ category: "subject", lane: "AI", startMs: 0, endMs: 40 });
    expect(sectionsOf(segs, labels, null)).toEqual([]);
    const noCategory: LabelSet = { ...clone(set), categories: [] };
    expect(sectionsOf(segs, labels, noCategory)).toEqual([]);
  });

  function timeline(answer: (q: QuestionSet, m: JevCallMeta) => Record<string, JevAnswer> | "fail", labels: LabelSet | null = set, stories: string[] = []) {
    const events: { type: string; data: any }[] = [];
    const asked: { q: QuestionSet; m: JevCallMeta; state: any }[] = [];
    const t = new Timeline(cfg.app, cfg.timeline, labels, stories, {
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

  test("each closed segment is asked the session's set, with the previous segment as context", async () => {
    const { t, asked } = timeline(() => ({ subject: choiceA("tech") }), set, ["Surf report"]);
    t.onSegmentClosed(seg("seg_1", 0, 1, [u("u_1", "spk_1", "a")]));
    t.onSegmentClosed(seg("seg_2", 1, 2, [u("u_2", "spk_1", "b")]));
    await t.idle();
    expect(Object.keys(asked[0].q)).toContain("story");
    expect(asked[1].m).toMatchObject({ purpose: "segment", segment_id: "seg_2", question_set_version: t.version });
    expect(asked[1].state.previous_segment).toEqual([{ speaker: "spk_1", text: "a", tags: [] }]);
  });

  test("without a set, segments are kept but never labelled", async () => {
    const { t, asked } = timeline(() => ({}), null);
    t.onSegmentClosed(seg("seg_1", 0, 1, [u("u_1", "spk_1", "a")]));
    await t.idle();
    expect(t.segments.length).toBe(1);
    expect(asked.length).toBe(0);
    expect(t.version).toBe("");
    expect(t.relabel()).toBe(0);
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
