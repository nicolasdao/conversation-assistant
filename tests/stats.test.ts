import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { JevAnswer } from "../src/jev/types.ts";
import type { PipelineUtterance, Segment } from "../src/pipeline/segmenter.ts";
import { computeStats } from "../src/pipeline/stats.ts";
import { deriveLabels, type SegmentLabels } from "../src/pipeline/timeline.ts";
import { best, scoreThresholds } from "../src/cli/calibrateBoundary.ts";

const cfg = loadConfig().app;
const u = (id: string, speakerId: string, startMs: number, endMs: number, text = "some words"): PipelineUtterance => ({
  id, stream: "remote", startMs, endMs, speakerId, speakerInferred: false, text, filler: false, failed: false, tags: [],
});
const choiceA = (c: string): JevAnswer => ({ type: "choice", choice: c, confidence: 0.9, probabilities: {} });
const noulA = (p: number): JevAnswer => ({ type: "noul", noul: p });
const scoreA = (s: number): JevAnswer => ({ type: "score", score: s, confidence: 0.9, probabilities: {} });

describe("stats on a synthetic session", () => {
  const segs: Segment[] = [
    { id: "seg_1", startMs: 0, endMs: 30_000, forced: false, final: false, utterances: [u("u_1", "spk_1", 0, 20_000, "I predict agents will write most code next year."), u("u_2", "spk_2", 20_000, 30_000)] },
    { id: "seg_2", startMs: 30_000, endMs: 40_000, forced: false, final: false, utterances: [u("u_3", "spk_2", 30_000, 40_000, "Try the new coding assistant.")] },
    { id: "seg_3", startMs: 40_000, endMs: 50_000, forced: false, final: true, utterances: [u("u_4", "spk_3", 40_000, 45_000), u("u_5", "spk_1", 45_000, 50_000)] },
    { id: "seg_4", startMs: 50_000, endMs: 60_000, forced: false, final: true, utterances: [u("u_6", "spk_1", 50_000, 60_000)] },
  ];
  const labels = new Map<string, SegmentLabels>([
    ["seg_1", deriveLabels(segs[0], { subject: choiceA("ai_tools"), disagreement: noulA(0.9), prediction: noulA(0.8), hype: scoreA(4), clip_worthy: scoreA(3.5) }, cfg.timeline, "v", [])],
    ["seg_2", deriveLabels(segs[1], { subject: choiceA("personal_life"), recommendation: noulA(0.75), hype: scoreA(2), clip_worthy: scoreA(1) }, cfg.timeline, "v", [])],
    ["seg_3", deriveLabels(segs[2], { subject: choiceA("other_topics"), disagreement: noulA(0.7), hype: scoreA(0) }, cfg.timeline, "v", [])],
    ["seg_4", deriveLabels(segs[3], null, cfg.timeline, "v", [])], // unlabeled: no labelled time
  ]);
  const names: Record<string, string> = { spk_1: "Nic", spk_2: "Ana", spk_3: "Sam" };
  const fc = { flagged: 3, researched: 2, verdicts: { supported: 1, contradicted: 0, misleading: 1, unverifiable: 0, not_a_claim: 0 }, repeats: 1, duplicates: 0, dropped: 1, goodFlags: 2, falseAlarms: 0, misses: 0, disputed: 0, promoted: 0, rejected: 0 };
  const cost = { transcription: 0.01, jev: 0.02, s2: 0.03, chat: 0, session: 0.06, dev: 0.5 };
  const st = computeStats({
    segments: segs, labels, resolveSpeaker: (id) => (id === "spk_3" ? "spk_2" : id), speakerName: (id) => names[id],
    factcheck: fc, cost, timeline: cfg.timeline,
  });

  test("Rogan index is the personal_life + other_topics share of labelled time", () => {
    expect(st.labelledMs).toBe(50_000);
    expect(st.roganIndex).toBeCloseTo(20_000 / 50_000);
  });

  test("talk time, disagreements, and duration-weighted hype per (merged) speaker", () => {
    const nic = st.speakers.find((s) => s.speakerId === "spk_1")!;
    const ana = st.speakers.find((s) => s.speakerId === "spk_2")!;
    expect(st.speakers.length).toBe(2); // spk_3 merged into spk_2
    expect(nic.talkMs).toBe(35_000);
    expect(ana.talkMs).toBe(25_000);
    expect(nic.disagreements).toBe(2);
    expect(ana.disagreements).toBe(2);
    expect(nic.hype).toBeCloseTo((4 * 20_000 + 0 * 5_000) / 25_000);
    expect(ana.hype).toBeCloseTo((4 * 10_000 + 2 * 10_000 + 0 * 5_000) / 25_000);
    expect(nic.displayName).toBe("Nic");
  });

  test("predictions, recommendations, clips, fact-check and cost totals", () => {
    expect(st.predictions).toEqual([{ segmentId: "seg_1", text: "I predict agents will write most code next year. some words" }]);
    expect(st.recommendations.map((r) => r.segmentId)).toEqual(["seg_2"]);
    expect(st.clips.map((c) => c.segmentId)).toEqual(["seg_1"]);
    expect(st.factcheck).toBe(fc);
    expect(st.cost).toBe(cost);
    const long = computeStats({
      segments: [{ ...segs[0], utterances: [u("u_1", "spk_1", 0, 1000, "x".repeat(300))] }], labels, resolveSpeaker: (id) => id,
      speakerName: (id) => id, factcheck: fc, cost, timeline: cfg.timeline,
    });
    expect(long.predictions[0].text.length).toBe(120);
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
