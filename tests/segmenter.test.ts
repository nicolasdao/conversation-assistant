import { afterEach, describe, expect, it, test, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { JevCallMeta } from "../src/jev/client.ts";
import type { QuestionSet } from "../src/jev/types.ts";
import {
  Segmenter, stateUtterance, type PipelineUtterance, type Segment, type SegmenterDeps, type StreamStatus, type Transcribed,
} from "../src/pipeline/segmenter.ts";
import { deferred } from "./fakes/index.ts";

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

function harness(boundaries: Record<string, number | "fail">, opts: { streams?: StreamStatus[]; jev?: boolean; deps?: Partial<SegmenterDeps> } = {}): Harness {
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
    boundary: () => cfg.timeline.boundary,
    factcheck: { questions: () => ({ questions: cfg.s1.questions, version: "s1@1" }), onAnswers: (u) => factAnswers.push(u.id) },
    speakerName: (id) => ({ spk_1: "Nic", spk_2: "Speaker 2" } as Record<string, string>)[id] ?? id,
    streams: () => streams,
    onSegmentClosed: (s) => closed.push(s),
    onError: (c, m) => errors.push(`${c}: ${m}`),
    now: () => clock.t,
    setTimer: () => {},
    jev: opts.jev,
    ...opts.deps,
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
  test("without Jev (fact-checking and labels off): never asks, and a long enough segment ends at a 2 s pause", async () => {
    const h = harness({}, { jev: false });
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "remote", 7000, 11000);   // 1 s gap: continues
    h.add("u_3", "host", 14000, 20000);    // 3 s gap, but the segment is only 11 s long: continues
    h.add("u_4", "host", 20500, 26000);    // 0.5 s gap: continues
    h.add("u_5", "remote", 28500, 33000);  // 2.5 s gap and the segment is 26 s long: a new segment
    await h.seg.idle();
    expect(h.asked).toHaveLength(0);
    expect(h.factAnswers).toEqual([]);
    expect(h.closed.map(ids)).toEqual([["u_1", "u_2", "u_3", "u_4"]]);
    expect(h.closed[0].forced).toBe(false);
    h.add("u_6", "remote", 33100, 105000); // the segment would pass 75 s: forced, whatever the pause
    await h.seg.idle();
    expect(h.closed.map(ids)).toEqual([["u_1", "u_2", "u_3", "u_4"], ["u_5"]]);
    expect(h.closed[1].forced).toBe(true);
  });

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

const behind: () => StreamStatus[] = () => [
  { stream: "host", watermark: Infinity, midSpeech: false },
  { stream: "remote", watermark: 0, midSpeech: true },
];
const result = (t: Partial<Transcribed> = {}): Transcribed =>
  ({ speakerId: "spk_1", speakerInferred: false, text: "words", filler: false, failed: false, dropped: false, tags: [], ...t });
const asked = (h: Harness) => h.asked.map((a) => a.meta.utterance_id);

describe("segmenter: the reorder buffer", () => {
  afterEach(() => { vi.useRealTimers(); });

  test("a transcription for an unknown id is ignored", async () => {
    const timers: number[] = [];
    const h = harness({}, { deps: { setTimer: (_fn, ms) => { timers.push(ms); } } });
    h.seg.transcribed("u_9", result());
    await h.seg.idle();
    expect(timers).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.seg.pendingCount).toBe(0);
  });

  test("each transcription arms a timer of reorderTimeoutMs + 1 whose callback releases what has waited long enough", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const h = harness({}, { streams: behind(), deps: { setTimer: (fn, ms) => { timers.push({ fn, ms }); } } });
    h.add("u_1", "host", 1000, 3000);
    expect(timers.map((t) => t.ms)).toEqual([cfg.app.segmentation.reorderTimeoutMs + 1]);
    await h.seg.idle();
    expect(h.asked).toEqual([]);
    h.clock.t = cfg.app.segmentation.reorderTimeoutMs + 1;
    timers[0].fn();
    await h.seg.idle();
    expect(asked(h)).toEqual(["u_1"]);
  });

  test("by default the timer is a real (unref'd) setTimeout and the clock is Date.now", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const h = harness({}, { streams: behind(), deps: { now: undefined, setTimer: undefined } });
    h.add("u_1", "host", 1000, 3000);
    await h.seg.idle();
    expect(h.asked).toEqual([]);
    vi.advanceTimersByTime(cfg.app.segmentation.reorderTimeoutMs);
    await h.seg.idle();
    expect(h.asked).toEqual([]);
    vi.advanceTimersByTime(1);
    await h.seg.idle();
    expect(asked(h)).toEqual(["u_1"]);
  });

  test("utterances emitted out of order are released in start order", async () => {
    const h = harness({});
    h.seg.emitted({ id: "u_2", stream: "host", startMs: 5000, endMs: 6000 });
    h.seg.emitted({ id: "u_1", stream: "remote", startMs: 1000, endMs: 2000 });
    h.seg.transcribed("u_2", result());
    expect(h.seg.pendingCount).toBe(2); // u_1, earlier, is still transcribing
    h.seg.transcribed("u_1", result({ speakerId: "spk_2" }));
    await h.seg.idle();
    expect(asked(h)).toEqual(["u_1", "u_2"]);
    expect(h.seg.pendingCount).toBe(0);
  });

  test("one poll releases every item that became ready", async () => {
    const streams = behind();
    const h = harness({}, { streams });
    h.add("u_1", "host", 1000, 2000);
    h.add("u_2", "host", 3000, 4000);
    h.add("u_3", "host", 5000, 6000);
    await h.seg.idle();
    expect(h.seg.pendingCount).toBe(3);
    streams[1] = { stream: "remote", watermark: 10_000, midSpeech: false };
    h.seg.poll();
    await h.seg.idle();
    expect(asked(h)).toEqual(["u_1", "u_2", "u_3"]);
  });

  test("another stream at the watermark holds the release only while someone is speaking on it", async () => {
    const streams: StreamStatus[] = [{ stream: "host", watermark: Infinity, midSpeech: false }, { stream: "remote", watermark: 5000, midSpeech: true }];
    const h = harness({}, { streams });
    h.add("u_1", "host", 5000, 6000);
    await h.seg.idle();
    expect(h.asked).toEqual([]);
    streams[1].midSpeech = false; // the watermark is exactly the start: enough
    h.seg.poll();
    await h.seg.idle();
    expect(asked(h)).toEqual(["u_1"]);
  });

  test("ranges more than 120 s old are forgotten, so they no longer make an overlap", async () => {
    const run = async (late: boolean) => {
      const h = harness({});
      h.seg.emitted({ id: "u_1", stream: "remote", startMs: 0, endMs: 3000 });
      h.seg.emitted({ id: "u_2", stream: "host", startMs: 1000, endMs: 2500 });
      if (late) h.seg.emitted({ id: "u_3", stream: "host", startMs: 130_000, endMs: 131_000 });
      h.seg.transcribed("u_1", result({ dropped: true }));
      h.seg.transcribed("u_2", result());
      await h.seg.idle();
      return h.seg.openSegment!.utterances[0].tags;
    };
    expect(await run(false)).toEqual(["overlap"]);
    expect(await run(true)).toEqual([]);
  });

  test("an 'overlap' tag already there is not added twice", async () => {
    const h = harness({});
    h.seg.emitted({ id: "u_1", stream: "remote", startMs: 0, endMs: 3000 });
    h.add("u_2", "host", 1000, 2500, { tags: ["overlap"] });
    h.seg.transcribed("u_1", result({ dropped: true }));
    await h.seg.idle();
    expect(h.seg.openSegment!.utterances[0].tags).toEqual(["overlap"]);
  });

  test("a dropped (empty) line is never processed", async () => {
    const processed: string[] = [];
    const h = harness({}, { deps: { onProcessed: (u) => processed.push(u.id) } });
    h.add("u_1", "host", 0, 1000, { dropped: true, text: "" });
    h.add("u_2", "host", 2000, 3000);
    await h.seg.idle();
    expect(processed).toEqual(["u_2"]);
  });

  test("pendingCount counts what has not been released", async () => {
    const h = harness({}, { streams: behind() });
    h.seg.emitted({ id: "u_1", stream: "host", startMs: 0, endMs: 1000 });
    h.seg.emitted({ id: "u_2", stream: "host", startMs: 2000, endMs: 3000 });
    expect(h.seg.pendingCount).toBe(2);
    h.clock.t = 10_000;
    h.seg.transcribed("u_1", result()); // held: the remote stream is behind, and it has not waited yet
    expect(h.seg.pendingCount).toBe(2);
    h.clock.t = 10_000 + cfg.app.segmentation.reorderTimeoutMs;
    h.seg.poll();
    expect(h.seg.pendingCount).toBe(1);
  });

  test("idle() waits for work released while it was waiting", async () => {
    const gate = deferred<void>();
    const h = harness({}, {
      deps: {
        ask: async (state, questions, meta) => {
          if (meta.utterance_id === "u_1") await gate.promise;
          h.asked.push({ state, questions, meta });
          return { answers: {}, id: "x", model: "m", provider: "p", usage: { input_tokens: 1, output_tokens: 0, cost: 0 } };
        },
      },
    });
    h.add("u_1", "host", 0, 1000);
    const idle = h.seg.idle();
    h.add("u_2", "host", 2000, 3000);
    gate.resolve();
    await idle;
    expect(asked(h)).toEqual(["u_1", "u_2"]);
  });
});

describe("segmenter: closing rules at their edges", () => {
  test("a filler as the first line opens a segment", async () => {
    const h = harness({});
    h.add("u_1", "host", 0, 500, { text: "yeah", filler: true });
    await h.seg.idle();
    expect(h.asked).toEqual([]);
    expect(h.seg.openSegment).toMatchObject({ id: "seg_1", startMs: 0, endMs: 500 });
  });

  test("a filler that would make the segment longer than maxSegmentMs closes it first (forced)", async () => {
    const h = harness({});
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 80_000, 80_500, { text: "yeah", filler: true });
    await h.seg.idle();
    expect(h.closed.map(ids)).toEqual([["u_1"]]);
    expect(h.closed[0].forced).toBe(true);
    expect(ids(h.seg.openSegment!)).toEqual(["u_2"]);
  });

  test("a failed line never joins the segment, is never asked about, and still counts as processed", async () => {
    const processed: string[] = [];
    const h = harness({}, { deps: { onProcessed: (u) => processed.push(u.id) } });
    h.add("u_1", "host", 0, 1000, { failed: true, text: "" });
    h.add("u_2", "host", 2000, 3000);
    await h.seg.idle();
    expect(processed).toEqual(["u_1", "u_2"]);
    expect(asked(h)).toEqual(["u_2"]);
    expect(ids(h.seg.openSegment!)).toEqual(["u_2"]);
    expect(h.asked[0].state.current_segment).toEqual([]);
  });

  test("answers without a boundary count as 0, and still go to the fact-checker", async () => {
    const h = harness({}, {
      deps: {
        ask: async (state, questions, meta) => {
          h.asked.push({ state, questions, meta });
          return { answers: { claim: { type: "noul", noul: 0.9 } }, id: "x", model: "m", provider: "p", usage: { input_tokens: 1, output_tokens: 0, cost: 0 } };
        },
      },
    });
    h.add("u_1", "host", 0, 1000);
    await h.seg.idle();
    expect(h.seg.openSegment!.utterances[0].boundary).toBe(0);
    expect(h.factAnswers).toEqual(["u_1"]);
  });

  test("without Jev a line has no boundary and the fact-checker hears nothing", async () => {
    const h = harness({}, { jev: false });
    h.add("u_1", "host", 0, 1000);
    await h.seg.idle();
    expect(h.seg.openSegment!.utterances[0].boundary).toBeUndefined();
    expect(h.factAnswers).toEqual([]);
  });

  test("a boundary exactly at the threshold closes (>=)", async () => {
    const h = harness({ u_3: cfg.app.segmentation.boundaryThreshold });
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 6500, 13_000);
    h.add("u_3", "host", 13_500, 15_000);
    await h.seg.idle();
    expect(h.closed.map(ids)).toEqual([["u_1", "u_2"]]);
  });

  test("a segment of exactly minSegmentMs can close", async () => {
    const h = harness({ u_3: 0.9 });
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 6000, cfg.app.segmentation.minSegmentMs);
    h.add("u_3", "host", 12_500, 14_000);
    await h.seg.idle();
    expect(h.closed.map(ids)).toEqual([["u_1", "u_2"]]);
  });

  test("a segment of exactly maxSegmentMs is not forced (only longer is)", async () => {
    const h = harness({});
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 69_000, cfg.app.segmentation.maxSegmentMs);
    await h.seg.idle();
    expect(h.closed).toEqual([]);
    expect(ids(h.seg.openSegment!)).toEqual(["u_1", "u_2"]);
  });

  test("a speaker change after exactly speakerChangeGapMs gets the lower threshold", async () => {
    const h = harness({ u_3: 0.55 });
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 6500, 12_500);
    h.add("u_3", "remote", 12_500 + cfg.app.segmentation.speakerChangeGapMs, 16_000);
    await h.seg.idle();
    expect(h.closed.map(ids)).toEqual([["u_1", "u_2"]]);
  });

  test("merged speakers are not a speaker change", async () => {
    const h = harness({ u_3: 0.55 }, { deps: { resolveSpeaker: () => "spk_1" } });
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 6500, 12_500);
    h.add("u_3", "remote", 14_500, 18_000);
    await h.seg.idle();
    expect(h.closed).toEqual([]);
  });

  test("without Jev a pause of exactly pauseBoundaryMs closes a long enough segment", async () => {
    const h = harness({}, { jev: false });
    h.add("u_1", "host", 0, 12_000);
    h.add("u_2", "host", 12_000 + cfg.app.segmentation.pauseBoundaryMs, 16_000);
    await h.seg.idle();
    expect(h.closed.map(ids)).toEqual([["u_1"]]);
  });

  test("closeFinal with no open segment returns null, and so does a second call", async () => {
    const h = harness({});
    expect(h.seg.closeFinal()).toBeNull();
    h.add("u_1", "host", 0, 1000);
    await h.seg.idle();
    expect(h.seg.closeFinal()).toMatchObject({ id: "seg_1", final: true });
    expect(h.seg.closeFinal()).toBeNull();
  });
});

describe("segmenter: errors and the request", () => {
  test("a throw from onSegmentClosed, onAnswers or onProcessed is a segmenter error, and later lines still flow", async () => {
    const errors: { c: string; m: string; d?: Record<string, unknown> }[] = [];
    let n = 0;
    const h = harness({ u_3: 0.9 }, {
      deps: {
        onError: (c, m, d) => errors.push({ c, m, d }),
        onSegmentClosed: () => { throw new Error("closed failed"); },
        onProcessed: (u) => { if (u.id === "u_1") throw new Error("processed failed"); },
        factcheck: { questions: () => ({ questions: {}, version: "s1@1" }), onAnswers: () => { if (++n === 2) throw "answers failed"; } },
      },
    });
    h.add("u_1", "host", 0, 6000);
    h.add("u_2", "host", 6500, 13_000);
    h.add("u_3", "host", 13_500, 15_000);
    h.add("u_4", "host", 15_500, 17_000);
    await h.seg.idle();
    expect(errors).toEqual([
      { c: "segmenter", m: "processed failed", d: { utterance_id: "u_1" } },
      { c: "segmenter", m: "answers failed", d: { utterance_id: "u_2" } },
      { c: "segmenter", m: "closed failed", d: { utterance_id: "u_3" } },
    ]);
    expect(asked(h)).toEqual(["u_1", "u_2", "u_3", "u_4"]);
  });

  test("a rejection that is not an Error is reported as its string", async () => {
    const errors: string[] = [];
    const h = harness({}, { deps: { ask: async () => { throw "gateway said no"; }, onError: (c, m) => errors.push(`${c}: ${m}`) } });
    h.add("u_1", "host", 0, 1000);
    await h.seg.idle();
    expect(errors).toEqual(["jev: gateway said no"]);
  });

  test("the request carries the purpose, the line, and the fact-checker's question-set version", async () => {
    const h = harness({});
    h.add("u_1", "host", 0, 1000);
    await h.seg.idle();
    expect(h.asked[0].meta).toEqual({ purpose: "utterance", utterance_id: "u_1", question_set_version: "s1@1" });
    expect(h.asked[0].questions.boundary).toEqual(cfg.timeline.boundary);
  });

  it.fails("BUG P1-L1: a System 1 question with the id 'boundary' cannot replace the locked, calibrated boundary question", async () => {
    const own = { type: "noul" as const, instructions: "Is this a claim?" };
    const h = harness({}, { deps: { factcheck: { questions: () => ({ questions: { boundary: own }, version: "s1@9" }), onAnswers: () => {} } } });
    h.add("u_1", "host", 0, 1000);
    await h.seg.idle();
    expect(h.asked[0].questions.boundary).toEqual(cfg.timeline.boundary);
  });

  test("stateUtterance copies the tags, so a later change to the line does not reach the request", () => {
    const u: PipelineUtterance = { id: "u_1", stream: "host", startMs: 0, endMs: 1, speakerId: "spk_1", speakerInferred: false, text: "hi", filler: false, failed: false, tags: ["loud"] };
    const s = stateUtterance(u, () => "Nic");
    u.tags.push("overlap");
    expect(s).toEqual({ speaker: "Nic", text: "hi", tags: ["loud"] });
  });
});
