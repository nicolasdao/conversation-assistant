import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { JevCallMeta } from "../src/jev/client.ts";
import type { QuestionSet } from "../src/jev/types.ts";
import { Segmenter, type PipelineUtterance, type Segment, type StreamStatus, type Transcribed } from "../src/pipeline/segmenter.ts";

const cfg = loadConfig();

interface Harness {
  seg: Segmenter;
  closed: Segment[];
  asked: { state: any; questions: QuestionSet; meta: JevCallMeta }[];
  errors: string[];
  factAnswers: string[];
  streams: StreamStatus[];
  clock: { t: number };
  add(id: string, stream: "host" | "remote", startMs: number, endMs: number, t?: Partial<Transcribed>): void;
}

function harness(boundaries: Record<string, number | "fail">, opts: { streams?: StreamStatus[] } = {}): Harness {
  const closed: Segment[] = [];
  const asked: Harness["asked"] = [];
  const errors: string[] = [];
  const factAnswers: string[] = [];
  const clock = { t: 0 };
  const streams = opts.streams ?? [
    { stream: "host", watermark: Infinity, midSpeech: false },
    { stream: "remote", watermark: Infinity, midSpeech: false },
  ];
  const seg = new Segmenter(cfg.app.segmentation, {
    async ask(state, questions, meta) {
      asked.push({ state, questions, meta });
      const b = boundaries[meta.utterance_id!];
      if (b === "fail") throw new Error("timeout");
      return { answers: { boundary: { type: "noul", noul: b ?? 0 }, claim: { type: "noul", noul: 0.1 } }, id: "x", model: "m", provider: "p", usage: { input_tokens: 1, output_tokens: 0, cost: 0 } };
    },
    boundary: () => cfg.labels.boundary,
    factcheck: { questions: () => ({ questions: cfg.s1.questions, version: "s1@1" }), onAnswers: (u) => factAnswers.push(u.id) },
    speakerName: (id) => ({ spk_1: "Nic", spk_2: "Speaker 2" } as Record<string, string>)[id] ?? id,
    streams: () => streams,
    onSegmentClosed: (s) => closed.push(s),
    onError: (c, m) => errors.push(`${c}: ${m}`),
    now: () => clock.t,
    setTimer: () => {},
  });
  return {
    seg, closed, asked, errors, factAnswers, streams, clock,
    add(id, stream, startMs, endMs, t = {}) {
      seg.emitted({ id, stream, startMs, endMs });
      seg.transcribed(id, {
        speakerId: stream === "host" ? "spk_1" : "spk_2", speakerInferred: false, text: `line ${id.slice(2)}`, filler: false,
        failed: false, dropped: false, tags: [], ...t,
      });
    },
  };
}

const ids = (s: Segment) => s.utterances.map((u) => u.id);

describe("segmenter", () => {
  test("closes on a boundary once the segment is long enough; state carries names, text, and tags only", async () => {
    const h = harness({ u_1: 0, u_2: 0.1, u_3: 0.9 });
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 6500, 13000);
    h.add("u_3", "host", 13500, 18000);
    await h.seg.idle();
    expect(h.closed.map(ids)).toEqual([["u_1", "u_2"]]);
    expect(h.closed[0]).toMatchObject({ forced: false, final: false, id: "seg_1" });
    const st = h.asked[2].state;
    expect(st).toEqual({
      current_segment: [{ speaker: "Nic", text: "line 1", tags: [] }, { speaker: "Nic", text: "line 2", tags: [] }],
      new_utterance: { speaker: "Nic", text: "line 3", tags: [] },
    });
    expect(JSON.stringify(st)).not.toMatch(/u_\d|spk_|\d{4}/);
    expect(Object.keys(h.asked[0].questions)).toEqual(["boundary", "claim", "claim_type", "public", "hedged", "worth"]);
    expect(h.asked[0].meta).toMatchObject({ purpose: "utterance", utterance_id: "u_1", question_set_version: "s1@1" });
    expect(h.factAnswers).toEqual(["u_1", "u_2", "u_3"]);
    expect(h.seg.closeFinal()).toMatchObject({ final: true, forced: false });
  });

  test("holds a segment open when it is shorter than the minimum", async () => {
    const h = harness({ u_2: 0.95 });
    h.add("u_1", "host", 0, 5000);
    h.add("u_2", "host", 5500, 9000);
    await h.seg.idle();
    expect(h.closed).toEqual([]);
    expect(ids(h.seg.openSegment!)).toEqual(["u_1", "u_2"]);
  });

  test("forces a close when adding would exceed maxSegmentMs", async () => {
    const h = harness({});
    for (let i = 0; i < 5; i++) h.add(`u_${i + 1}`, "host", i * 18_000, i * 18_000 + 17_000);
    await h.seg.idle();
    expect(h.closed.length).toBe(1);
    expect(h.closed[0]).toMatchObject({ forced: true });
    expect(ids(h.closed[0])).toEqual(["u_1", "u_2", "u_3", "u_4"]);
    expect(h.closed[0].endMs - h.closed[0].startMs).toBeLessThanOrEqual(75_000);
  });

  test("a speaker change after a long enough gap lowers the threshold", async () => {
    // 0.55 is below 0.6 but at or above 0.6 - 0.1
    const same = harness({ u_3: 0.55 });
    same.add("u_1", "host", 0, 6000);
    same.add("u_2", "host", 6500, 12500);
    same.add("u_3", "host", 14500, 18000);
    await same.seg.idle();
    expect(same.closed).toEqual([]);

    const changed = harness({ u_3: 0.55 });
    changed.add("u_1", "host", 0, 6000);
    changed.add("u_2", "host", 6500, 12500);
    changed.add("u_3", "remote", 14500, 18000);
    await changed.seg.idle();
    expect(changed.closed.map(ids)).toEqual([["u_1", "u_2"]]);

    const shortGap = harness({ u_3: 0.55 });
    shortGap.add("u_1", "host", 0, 6000);
    shortGap.add("u_2", "host", 6500, 12500);
    shortGap.add("u_3", "remote", 13000, 18000);
    await shortGap.seg.idle();
    expect(shortGap.closed).toEqual([]);
  });

  test("a filler skips Jev and joins the open segment; a failed transcription adds no text", async () => {
    const h = harness({});
    h.add("u_1", "host", 0, 3000);
    h.add("u_2", "remote", 3500, 4000, { text: "yeah", filler: true });
    h.add("u_3", "remote", 4500, 5000, { text: "", failed: true });
    await h.seg.idle();
    expect(h.asked.map((a) => a.meta.utterance_id)).toEqual(["u_1"]);
    expect(ids(h.seg.openSegment!)).toEqual(["u_1", "u_2"]);
  });

  test("an empty transcript is dropped", async () => {
    const h = harness({});
    h.add("u_1", "host", 0, 3000, { text: "", dropped: true });
    await h.seg.idle();
    expect(h.seg.openSegment).toBeNull();
    expect(h.asked).toEqual([]);
  });

  test("a Jev failure treats the boundary as 0 and skips fact-checking", async () => {
    const h = harness({ u_3: "fail" });
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 6500, 13000);
    h.add("u_3", "host", 13500, 18000);
    await h.seg.idle();
    expect(h.closed).toEqual([]);
    expect(h.errors).toEqual(["jev: timeout"]);
    expect(h.factAnswers).toEqual(["u_1", "u_2"]);
    expect(h.seg.openSegment!.utterances[2].boundary).toBe(0);
  });

  test("orders utterances across the two streams, waiting for the other stream's watermark and speech", async () => {
    const streams: StreamStatus[] = [
      { stream: "host", watermark: 10_000, midSpeech: false },
      { stream: "remote", watermark: 3000, midSpeech: true },
    ];
    const h = harness({}, { streams });
    // host u_2 (5 s) finishes transcription before remote u_1 (2 s) is even emitted
    h.add("u_2", "host", 5000, 8000);
    await h.seg.idle();
    expect(h.asked).toEqual([]); // remote is behind and mid-speech
    streams[1].watermark = 9000;
    streams[1].midSpeech = false;
    h.seg.emitted({ id: "u_1", stream: "remote", startMs: 2000, endMs: 4500 });
    h.seg.poll();
    await h.seg.idle();
    expect(h.asked).toEqual([]); // an earlier utterance is still transcribing
    h.seg.transcribed("u_1", { speakerId: "spk_2", speakerInferred: false, text: "early", filler: false, failed: false, dropped: false, tags: [] });
    await h.seg.idle();
    expect(h.asked.map((a) => a.meta.utterance_id)).toEqual(["u_1", "u_2"]);
  });

  test("releases on the reorder timeout, and a late utterance joins in arrival order", async () => {
    const streams: StreamStatus[] = [
      { stream: "host", watermark: Infinity, midSpeech: false },
      { stream: "remote", watermark: 1000, midSpeech: true },
    ];
    const h = harness({}, { streams });
    h.seg.emitted({ id: "u_1", stream: "remote", startMs: 1000, endMs: 3000 });
    h.add("u_2", "host", 2000, 6000);
    h.clock.t = 7999;
    h.seg.poll();
    await h.seg.idle();
    expect(h.asked).toEqual([]);
    h.clock.t = 8000;
    h.seg.poll();
    await h.seg.idle();
    expect(h.asked.map((a) => a.meta.utterance_id)).toEqual(["u_2"]);
    streams[1] = { stream: "remote", watermark: Infinity, midSpeech: false };
    h.seg.transcribed("u_1", { speakerId: "spk_2", speakerInferred: false, text: "late", filler: false, failed: false, dropped: false, tags: [] });
    await h.seg.idle();
    expect(ids(h.seg.openSegment!)).toEqual(["u_2", "u_1"]);
    // overlap is computed at release: u_1 and u_2 overlap by 1000 ms
    expect(h.seg.openSegment!.utterances[1].tags).toContain("overlap");
  });
});
