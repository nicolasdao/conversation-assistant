import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { JevAnswer } from "../src/jev/types.ts";
import type { PipelineUtterance, Segment } from "../src/pipeline/segmenter.ts";
import { computeStats } from "../src/pipeline/stats.ts";
import { fromLegacy, fromLegacyStats } from "../src/labels/legacy.ts";
import type { LabelSet } from "../src/labels/model.ts";
import { deriveLabels, type SegmentLabels } from "../src/pipeline/timeline.ts";
import { best, scoreThresholds } from "../src/cli/calibrateBoundary.ts";

const set = loadConfig().labels;
const u = (id: string, speakerId: string, startMs: number, endMs: number, text = "some words"): PipelineUtterance => ({
  id, stream: "remote", startMs, endMs, speakerId, speakerInferred: false, text, filler: false, failed: false, tags: [],
});
const choiceA = (c: string): JevAnswer => ({ type: "choice", choice: c, confidence: 0.9, probabilities: {} });
const noulA = (p: number): JevAnswer => ({ type: "noul", noul: p });
const scoreA = (s: number): JevAnswer => ({ type: "score", score: s, confidence: 0.9, probabilities: {} });
const fc = { flagged: 3, researched: 2, verdicts: { supported: 1, contradicted: 0, misleading: 1, unverifiable: 0, not_a_claim: 0 }, repeats: 1, duplicates: 0, dropped: 1, goodFlags: 2, falseAlarms: 0, misses: 0, disputed: 0, promoted: 0, rejected: 0 };
const cost = { transcription: 0.01, jev: 0.02, s2: 0.03, chat: 0, session: 0.06, dev: 0.5 };

describe("stats on a synthetic session, with the built-in set", () => {
  const segs: Segment[] = [
    { id: "seg_1", startMs: 0, endMs: 30_000, forced: false, final: false, utterances: [u("u_1", "spk_1", 0, 20_000, "I predict agents will write most code next year."), u("u_2", "spk_2", 20_000, 30_000)] },
    { id: "seg_2", startMs: 30_000, endMs: 40_000, forced: false, final: false, utterances: [u("u_3", "spk_2", 30_000, 40_000, "Try the new coding assistant.")] },
    { id: "seg_3", startMs: 40_000, endMs: 50_000, forced: false, final: true, utterances: [u("u_4", "spk_3", 40_000, 45_000), u("u_5", "spk_1", 45_000, 50_000)] },
    { id: "seg_4", startMs: 50_000, endMs: 60_000, forced: false, final: true, utterances: [u("u_6", "spk_1", 50_000, 60_000)] },
  ];
  const labels = new Map<string, SegmentLabels>([
    ["seg_1", deriveLabels(segs[0], { subject: choiceA("ai_tools"), mode: choiceA("news"), disagreement: noulA(0.9), prediction: noulA(0.8), hype: scoreA(4), heat: scoreA(1), clip_worthy: noulA(0.9) }, set, "v", [])],
    ["seg_2", deriveLabels(segs[1], { subject: choiceA("personal_life"), mode: choiceA("banter"), recommendation: noulA(0.75), hype: scoreA(2), clip_worthy: noulA(0.1) }, set, "v", [])],
    ["seg_3", deriveLabels(segs[2], { subject: choiceA("other_topics"), disagreement: noulA(0.7), hype: scoreA(0) }, set, "v", [])],
    ["seg_4", deriveLabels(segs[3], null, set, "v", [])], // unlabeled: no labelled time
  ]);
  const names: Record<string, string> = { spk_1: "Nic", spk_2: "Ana", spk_3: "Sam" };
  const st = computeStats({
    segments: segs, labels, set, resolveSpeaker: (id) => (id === "spk_3" ? "spk_2" : id), speakerName: (id) => names[id], factcheck: fc, cost,
  });

  test("the set's index (Off-topic) is its options' share of the category's labelled time", () => {
    expect(st.version).toBe(2);
    expect(st.labelledMs).toBe(50_000);
    expect(st.index).toEqual({ name: "Off-topic", description: "time spent on personal life and other topics", share: 20_000 / 50_000 });
    expect(st.roganIndex).toBeCloseTo(20_000 / 50_000);
  });

  test("each category's split, in the set's option order", () => {
    expect(st.categories.map((c) => c.id)).toEqual(["subject", "mode"]);
    expect(st.categories[0].split).toEqual([
      { option: "ai_tools", ms: 30_000, share: 0.6 }, { option: "personal_life", ms: 10_000, share: 0.2 }, { option: "other_topics", ms: 10_000, share: 0.2 },
    ]);
    expect(st.categories[1].split.map((x) => [x.option, x.share])).toEqual([["news", 0.75], ["banter", 0.25]]);
  });

  test("talk time, per-speaker markers, and duration-weighted scores per (merged) speaker", () => {
    const nic = st.speakers.find((s) => s.speakerId === "spk_1")!;
    const ana = st.speakers.find((s) => s.speakerId === "spk_2")!;
    expect(st.speakers.length).toBe(2); // spk_3 merged into spk_2
    expect(nic.talkMs).toBe(35_000);
    expect(ana.talkMs).toBe(25_000);
    expect(nic.markers).toEqual({ disagreement: 2 }); // only the markers with perSpeaker
    expect(ana.markers).toEqual({ disagreement: 2 });
    expect(nic.scores.hype).toBeCloseTo((4 * 20_000 + 0 * 5_000) / 25_000);
    expect(ana.scores.hype).toBeCloseTo((4 * 10_000 + 2 * 10_000 + 0 * 5_000) / 25_000);
    expect(nic.scores.heat).toBeCloseTo(1);
    expect(nic.displayName).toBe("Nic");
  });

  test("one list per marker with list: true, then fact-check and cost totals", () => {
    expect(st.lists.map((l) => l.markerId)).toEqual(["prediction", "recommendation", "clip_worthy"]);
    expect(st.lists[0].items).toEqual([{ segmentId: "seg_1", text: "I predict agents will write most code next year. some words" }]);
    expect(st.lists[1].items.map((r) => r.segmentId)).toEqual(["seg_2"]);
    expect(st.lists[2].items.map((c) => c.segmentId)).toEqual(["seg_1"]);
    expect(st.factcheck).toBe(fc);
    expect(st.cost).toBe(cost);
    const long = computeStats({
      segments: [{ ...segs[0], utterances: [u("u_1", "spk_1", 0, 1000, "x".repeat(300))] }], labels, set, resolveSpeaker: (id) => id,
      speakerName: (id) => id, factcheck: fc, cost,
    });
    expect(long.lists[0].items[0].text.length).toBe(120);
  });

  test("labels off: talk time only", () => {
    const off = computeStats({ segments: segs, labels: new Map(), set: null, resolveSpeaker: (id) => id, speakerName: (id) => id, factcheck: fc, cost });
    expect(off).toMatchObject({ index: null, roganIndex: 0, labelledMs: 0, categories: [], lists: [] });
    expect(off.speakers.find((s) => s.speakerId === "spk_1")).toMatchObject({ talkMs: 35_000, markers: {}, scores: {} });
  });
});

describe("stats with another set: a sales call, one category, no scores, three markers", () => {
  const sales: LabelSet = {
    format: "tattle-labels", version: 1, id: "sales-call", name: "Sales call", description: "", prefix: "", fadedBelowConfidence: 0.5, companies: [],
    categories: [{
      id: "stage", name: "Stage", instructions: "Which stage of the call is this?",
      options: [
        { id: "discovery", name: "Discovery", description: "Learning the customer's needs", color: "#3f7df0" },
        { id: "pricing", name: "Pricing", description: "Talking about price", color: "#d0892a" },
        { id: "other", name: "Other", description: "Anything else", color: "#6f7a8c" },
      ],
      index: { name: "Pricing talk", description: "time spent on price", options: ["pricing"] },
    }],
    scores: [],
    markers: [
      { id: "objection", name: "Objection", short: "Objection", icon: "warning", instructions: "The customer raises an objection.", threshold: 0.6, perSpeaker: true, list: true },
      { id: "next_step", name: "Next step", short: "Next", icon: "calendar", instructions: "A next step is agreed.", threshold: 0.7, perSpeaker: false, list: true },
      { id: "competitor", name: "Competitor", short: "Rival", icon: "target", instructions: "A competitor is named.", threshold: 0.8, perSpeaker: false, list: false },
    ],
  };
  const segs: Segment[] = [
    { id: "seg_1", startMs: 0, endMs: 20_000, forced: false, final: false, utterances: [u("u_1", "spk_1", 0, 20_000, "What do you need?")] },
    { id: "seg_2", startMs: 20_000, endMs: 30_000, forced: false, final: false, utterances: [u("u_2", "spk_2", 20_000, 30_000, "That is too expensive.")] },
  ];
  const labels = new Map<string, SegmentLabels>([
    ["seg_1", deriveLabels(segs[0], { stage: choiceA("discovery"), competitor: noulA(0.9) }, sales, "v", [])],
    ["seg_2", deriveLabels(segs[1], { stage: choiceA("pricing"), objection: noulA(0.65), next_step: noulA(0.69) }, sales, "v", [])],
  ]);
  const st = computeStats({ segments: segs, labels, set: sales, resolveSpeaker: (id) => id, speakerName: (id) => id, factcheck: fc, cost });

  test("its own index, split, per-speaker counts, and lists", () => {
    expect(st.index).toEqual({ name: "Pricing talk", description: "time spent on price", share: 10_000 / 30_000 });
    expect(st.categories).toEqual([{ id: "stage", name: "Stage", split: [
      { option: "discovery", ms: 20_000, share: 20_000 / 30_000 }, { option: "pricing", ms: 10_000, share: 10_000 / 30_000 },
    ] }]);
    expect(st.speakers.find((s) => s.speakerId === "spk_2")).toMatchObject({ markers: { objection: 1 }, scores: {} });
    expect(st.speakers.find((s) => s.speakerId === "spk_1")).toMatchObject({ markers: { objection: 0 } });
    expect(st.lists).toEqual([
      { markerId: "objection", items: [{ segmentId: "seg_2", text: "That is too expensive." }] },
      { markerId: "next_step", items: [] }, // 0.69 is under its 0.7
    ]);
  });
});

describe("stats stored by a recording made before label sets", () => {
  test("convert to version 2 in the converted set's shape", () => {
    const legacy = JSON.parse(readFileSync("tests/fixtures/legacy-session.json", "utf8"));
    const converted = fromLegacy(legacy.labelSet, legacy.config.timeline);
    const old = {
      roganIndex: 0.12, labelledMs: 1000,
      speakers: [{ speakerId: "spk_1", displayName: "Nic", talkMs: 500, disagreements: 26, hype: 1.8 }],
      predictions: [{ segmentId: "seg_1", text: "p" }], recommendations: [], clips: [{ segmentId: "seg_2", clipWorthy: 3.2, text: "c" }],
      factcheck: fc, cost,
    };
    expect(fromLegacyStats(old, converted)).toEqual({
      version: 2, index: { name: "Off-topic", description: "time spent on personal life and other topics", share: 0.12 }, roganIndex: 0.12,
      labelledMs: 1000, categories: [],
      speakers: [{ speakerId: "spk_1", displayName: "Nic", talkMs: 500, markers: { disagreement: 26 }, scores: { hype: 1.8 } }],
      lists: [
        { markerId: "prediction", items: [{ segmentId: "seg_1", text: "p" }] },
        { markerId: "recommendation", items: [] },
        { markerId: "clip_worthy", items: [{ segmentId: "seg_2", text: "c" }] },
      ],
      factcheck: fc, cost,
    });
    const v2 = fromLegacyStats(old, converted);
    expect(fromLegacyStats(v2, converted)).toBe(v2); // already converted: unchanged
  });
});

describe("boundary calibration", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    utterance_id: `u_${i + 1}`, speaker: "A", text: `line ${i}`, boundary_p: i / 20, human_boundary: i >= 13 ? true : i === 5,
  }));

  test("precision, recall, and F1 per threshold", () => {
    const s = scoreThresholds(rows);
    expect(s.map((x) => x.threshold)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    const at07 = s.find((x) => x.threshold === 0.7)!;
    // p ≥ 0.7 ⇔ i ≥ 14: 6 predicted, all true; 8 true boundaries (13–19 and 5)
    expect(at07).toMatchObject({ tp: 6, fp: 0, fn: 2 });
    expect(at07.precision).toBe(1);
    expect(at07.recall).toBeCloseTo(0.75);
    expect(s.find((x) => x.threshold === 0.6)!.f1).toBeCloseTo(0.875);
    expect(best(s).threshold).toBe(0.6);
  });

  test("the CLI runs on a labelled sample of 20 rows", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cal-")), "labelled.jsonl");
    writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli/calibrateBoundary.ts", f], { encoding: "utf8" });
    expect(out).toContain("20 labelled rows");
    expect(out).toContain("best threshold: 0.6");
    expect(out.split("\n").filter((l) => /^\s+0\.\d\s/.test(l)).length).toBe(7);
  });
});
