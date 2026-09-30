import { describe, expect, it, test } from "vitest";
import { deferred, flushMicrotasks } from "./fakes/index.ts";
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

const noulA = (p: number): JevAnswer => ({ type: "noul", noul: p });
const scoreA = (s: number): JevAnswer => ({ type: "score", score: s, confidence: 1, probabilities: {} });
const response = (answers: Record<string, JevAnswer>) => ({ answers, id: "", model: "", provider: "", usage: { input_tokens: 0, output_tokens: 0, cost: 0 } });

describe("deriveLabels at its edges", () => {
  const s = seg("seg_1", 0, 10_000, [u("u_1", "spk_1", "OpenAI said so")]);

  test("the story: 's2' is tonight's second headline; 'none' and an unknown number are no story", () => {
    const stories = ["Surf report", "Nvidia earnings"];
    expect(deriveLabels(s, { story: choiceA("s2") }, set, "v", stories).story).toBe("Nvidia earnings");
    expect(deriveLabels(s, { story: choiceA("none") }, set, "v", stories).story).toBeNull();
    expect(deriveLabels(s, { story: choiceA("s9") }, set, "v", stories).story).toBeNull();
    expect(deriveLabels(s, { story: choiceA("s1") }, set, "v", stories).choices.story).toEqual({ choice: "s1", confidence: 0.9, faded: false });
  });

  test("the lane: the option's group, else the option, else none; an option the set lacks is its own lane", () => {
    expect(deriveLabels(s, { subject: choiceA("ai_tools") }, set, "v", []).lane).toBe("AI");
    expect(deriveLabels(s, { subject: choiceA("marketing") }, set, "v", []).lane).toBe("marketing");
    expect(deriveLabels(s, { mode: choiceA("news") }, set, "v", []).lane).toBeNull();
    expect(deriveLabels(s, { subject: choiceA("unheard_of") }, set, "v", []).lane).toBe("unheard_of");
    const markersOnly: LabelSet = { ...clone(set), categories: [] };
    expect(deriveLabels(s, { subject: choiceA("ai_tools") }, markersOnly, "v", []).lane).toBeNull();
  });

  test("a confidence exactly at fadedBelowConfidence is not faded", () => {
    expect(deriveLabels(s, { subject: choiceA("tech", set.fadedBelowConfidence) }, set, "v", []).choices.subject.faded).toBe(false);
  });

  test("a marker exactly at its threshold is set", () => {
    const m = set.markers[0];
    expect(deriveLabels(s, { [m.id]: noulA(m.threshold) }, set, "v", []).markers).toEqual([m.id]);
    expect(deriveLabels(s, { [m.id]: noulA(m.threshold - 0.001) }, set, "v", []).markers).toEqual([]);
  });

  test("an answer of the wrong type for its question is ignored", () => {
    const l = deriveLabels(s, { subject: noulA(1), heat: choiceA("hot"), disagreement: scoreA(4), hype: scoreA(3) }, set, "v", []);
    expect(l.choices).toEqual({});
    expect(l.scores).toEqual({ hype: 3 });
    expect(l.nouls).toEqual({});
    expect(l.markers).toEqual([]);
  });

  test("failed lines are not part of the mention text; an unlabeled segment still has its mentions", () => {
    const withFailed = seg("seg_1", 0, 1, [u("u_1", "spk_1", "Nvidia"), { ...u("u_2", "spk_1", "OpenAI"), failed: true }]);
    expect(deriveLabels(withFailed, null, set, "v", [])).toMatchObject({ unlabeled: true, mentions: ["Nvidia"], lane: null, story: null });
  });
});

describe("mentions", () => {
  test("regex characters in a company's name are matched literally", () => {
    expect(mentionsOf("we use C++ and A.I. tools", ["C++", "A.I."])).toEqual(["C++", "A.I."]);
    expect(mentionsOf("AxIx and C", ["A.I.", "C++"])).toEqual([]);
  });

  it.fails("BUG P2-L2: a company name followed by a non-ASCII letter is part of a longer word, not a mention", () => {
    expect(mentionsOf("Metaé and OpenAIñ", ["Meta", "OpenAI"])).toEqual([]);
  });
});

describe("sections at their edges", () => {
  test("segments with no labels, unlabeled ones, and ones without the first category are skipped; ids count up; the end is the latest", () => {
    const segs = [seg("seg_1", 0, 10, []), seg("seg_2", 10, 20, []), seg("seg_3", 20, 30, []), seg("seg_4", 30, 50, []), seg("seg_5", 40, 45, []), seg("seg_6", 50, 60, [])];
    const labels = new Map<string, SegmentLabels>([
      ["seg_2", deriveLabels(segs[1], null, set, "v", [])], // unlabeled
      ["seg_3", deriveLabels(segs[2], { mode: choiceA("news") }, set, "v", [])], // no subject
      ["seg_4", labelsFor("seg_4", "tech")],
      ["seg_5", labelsFor("seg_5", "tech")], // ends before seg_4 does
      ["seg_6", labelsFor("seg_6", "marketing")],
    ]);
    expect(sectionsOf(segs, labels, set)).toEqual([
      { id: "sec_1", category: "subject", option: "tech", lane: "tech", segmentIds: ["seg_4", "seg_5"], startMs: 30, endMs: 50 },
      { id: "sec_2", category: "subject", option: "marketing", lane: "marketing", segmentIds: ["seg_6"], startMs: 50, endMs: 60 },
    ]);
  });

  test("labels without a lane fall back to the option", () => {
    const l = { ...labelsFor("seg_1", "tech"), lane: null };
    expect(sectionsOf([seg("seg_1", 0, 1, [])], new Map([["seg_1", l]]), set)[0].lane).toBe("tech");
  });
});

describe("the timeline's labelling", () => {
  function make(answer: (m: JevCallMeta) => Promise<Record<string, JevAnswer>>, opts: { concurrency?: number; stories?: string[]; write?: (r: Record<string, unknown>) => void } = {}) {
    const events: { type: string; data: any }[] = [];
    const rows: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const asked: JevCallMeta[] = [];
    const app = opts.concurrency ? { ...cfg.app, jev: { ...cfg.app.jev, segmentConcurrency: opts.concurrency } } : cfg.app;
    const t = new Timeline(app, cfg.timeline, set, opts.stories ?? [], {
      async ask(_state, _q, m) { asked.push(m); return response(await answer(m)); },
      speakerName: (id) => id,
      emit: (type, data) => events.push({ type, data }),
      write: opts.write ?? ((r) => rows.push(r)),
      onError: (c, m) => errors.push(`${c}: ${m}`),
    });
    return { t, events, rows, errors, asked };
  }
  const one = (id: string, start = 0) => seg(id, start, start + 1000, [u(`u_${id}`, "spk_1", "words")]);

  test("setStories trims, drops blanks, refuses more than 254, and returns the new version", () => {
    const { t } = make(async () => ({}));
    const v0 = t.version;
    const v1 = t.setStories(["  Surf report ", "", "   "]);
    expect(t.storiesActive).toEqual(["Surf report"]);
    expect(v1).toBe(t.version);
    expect(v1).not.toBe(v0);
    expect(() => t.setStories(Array.from({ length: 255 }, (_, i) => `story ${i}`))).toThrow("at most 254 stories");
    expect(t.storiesActive).toEqual(["Surf report"]);
    expect(t.setStories(Array.from({ length: 254 }, (_, i) => `story ${i}`))).toMatch(/^[0-9a-f]{12}$/);
  });

  test("storiesActive is a copy", () => {
    const { t } = make(async () => ({}), { stories: ["A"] });
    t.storiesActive.push("B");
    expect(t.storiesActive).toEqual(["A"]);
  });

  test("the questions are the set's, and none without a set", () => {
    const { t } = make(async () => ({}));
    expect(Object.keys(t.questions())).toContain("subject");
    const off = new Timeline(cfg.app, cfg.timeline, null, [], { ask: async () => response({}), speakerName: (id) => id, emit: () => {}, write: () => {}, onError: () => {} });
    expect(off.questions()).toEqual({});
    expect(off.sections()).toEqual([]);
  });

  test("with segmentConcurrency 1, one segment is asked at a time", async () => {
    const gates = [deferred<Record<string, JevAnswer>>(), deferred<Record<string, JevAnswer>>()];
    const { t, asked } = make((m) => gates[Number(m.segment_id!.slice(4)) - 1].promise, { concurrency: 1 });
    t.onSegmentClosed(one("seg_1"));
    t.onSegmentClosed(one("seg_2", 1000));
    await flushMicrotasks();
    expect(asked.map((m) => m.segment_id)).toEqual(["seg_1"]);
    gates[0].resolve({ subject: choiceA("tech") });
    await flushMicrotasks(10);
    expect(asked.map((m) => m.segment_id)).toEqual(["seg_1", "seg_2"]);
    gates[1].resolve({ subject: choiceA("tech") });
    await t.idle();
    expect(t.labels.size).toBe(2);
  });

  test("a segment waiting its turn keeps the version and stories it was closed with", async () => {
    const gate = deferred<Record<string, JevAnswer>>();
    const { t, asked, rows } = make((m) => (m.segment_id === "seg_1" ? gate.promise : Promise.resolve({ story: choiceA("s1") })), { concurrency: 1, stories: ["Old story"] });
    const before = t.version;
    t.onSegmentClosed(one("seg_1"));
    t.onSegmentClosed(one("seg_2", 1000));
    t.setStories(["New story"]);
    gate.resolve({});
    await t.idle();
    expect(asked[1]).toMatchObject({ segment_id: "seg_2", question_set_version: before });
    expect(rows[1]).toMatchObject({ segmentId: "seg_2", labelSetVersion: before, story: "Old story" });
  });

  test("each labelling writes {kind: 'labels', purpose, ...labels} and emits segment.labels", async () => {
    const { t, rows, events } = make(async () => ({ subject: choiceA("tech") }));
    t.onSegmentClosed(one("seg_1"));
    await t.idle();
    const l = t.labels.get("seg_1")!;
    expect(rows).toEqual([{ kind: "labels", purpose: "segment", ...l }]);
    expect(events.find((e) => e.type === "segment.labels")!.data).toEqual({ ...l, purpose: "segment" });
  });

  test("section.updated is emitted only when the sections change", async () => {
    const { t, events } = make(async () => ({ subject: choiceA("tech") }));
    t.onSegmentClosed(one("seg_1"));
    await t.idle();
    t.relabel(); // the same answer: the same sections
    await t.idle();
    expect(events.filter((e) => e.type === "segment.labels")).toHaveLength(2);
    expect(events.filter((e) => e.type === "section.updated")).toHaveLength(1);
  });

  test("a failed relabel keeps a segment's labels: nothing written, nothing emitted", async () => {
    let fail = false;
    const { t, rows, events, errors } = make(async () => { if (fail) throw new Error("timeout"); return { subject: choiceA("tech") }; });
    t.onSegmentClosed(one("seg_1"));
    await t.idle();
    const kept = t.labels.get("seg_1");
    fail = true;
    t.relabel();
    await t.idle();
    expect(t.labels.get("seg_1")).toBe(kept);
    expect(rows).toHaveLength(1);
    expect(events.filter((e) => e.type === "segment.labels")).toHaveLength(1);
    expect(errors).toEqual(["jev: timeout"]);
  });

  test("a failed relabel of an unlabeled segment writes it unlabeled again", async () => {
    const { t, rows } = make(async () => { throw new Error("down"); });
    t.onSegmentClosed(one("seg_1"));
    await t.idle();
    t.relabel();
    await t.idle();
    expect(rows.map((r) => [r.purpose, r.unlabeled])).toEqual([["segment", true], ["relabel", true]]);
  });

  test("a rejection that is not an Error is reported as its string", async () => {
    const { t, errors } = make(async () => { throw "gateway said no"; });
    t.onSegmentClosed(one("seg_1"));
    await t.idle();
    expect(errors).toEqual(["jev: gateway said no"]);
  });

  it.fails("BUG P2-L1: a throw from write is reported, and idle() still resolves", async () => {
    // Today the throw rejects label(); the promise track() derives with finally() has no handler, so it is an unhandled
    // rejection. Capture it here instead of letting it fail the run, then put Vitest's listeners back.
    const listeners = process.listeners("unhandledRejection");
    const unhandled: unknown[] = [];
    const capture = (e: unknown) => { unhandled.push(e); };
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", capture);
    try {
      const { t, errors } = make(async () => ({ subject: choiceA("tech") }), { write: () => { throw new Error("disk full"); } });
      t.onSegmentClosed(one("seg_1"));
      const idled = await t.idle().then(() => true, () => false);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
      expect(idled).toBe(true);
      expect(errors.some((e) => e.includes("disk full"))).toBe(true);
    } finally {
      await new Promise((r) => setImmediate(r));
      process.off("unhandledRejection", capture);
      for (const l of listeners) process.on("unhandledRejection", l);
    }
  });
});
