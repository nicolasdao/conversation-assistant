import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { StreamVad, UtteranceIds, type Utterance } from "../src/audio/vad.ts";
import { loadScript, requireAssets } from "./helpers.ts";
import { fixtureSlice } from "./fakes/index.ts";
import { FakeVad } from "./fakes/audio.ts";

const cfg = loadConfig().app.vad;

/** A StreamVad on the real model (construction is cheap), with its sherpa Vad swapped for a scripted fake. */
function fakeVad(opts: { maxSpeechDuration?: number; withFlush?: boolean; ids?: UtteranceIds; stream?: "host" | "remote" } = {}) {
  requireAssets();
  const v = new StreamVad(opts.stream ?? "host", { ...cfg, maxSpeechDuration: opts.maxSpeechDuration ?? cfg.maxSpeechDuration }, opts.ids ?? new UtteranceIds());
  const fake = new FakeVad(opts.withFlush ?? true);
  (v as unknown as { vad: FakeVad }).vad = fake;
  return { v, fake };
}

const seq = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => (from + i) / 10_000);

describe("StreamVad (scripted VAD)", () => {
  test("accept feeds exact 512-sample windows and carries the remainder", () => {
    const { v, fake } = fakeVad();
    v.accept(seq(300), 0);
    expect(fake.fed).toHaveLength(0);
    v.accept(seq(300, 300), 32);
    v.accept(seq(500, 600), 64);
    expect(fake.fed.map((w) => w.length)).toEqual([512, 512]);
    // the windows are the samples in order, across frame boundaries
    expect(fake.fed[0][299]).toBeCloseTo(299 / 10_000);
    expect(fake.fed[0][300]).toBeCloseTo(300 / 10_000);
    expect(fake.fed[1][0]).toBeCloseTo(512 / 10_000);
    expect((v as unknown as { pending: Float32Array }).pending.length).toBe(76);
    // the next frame completes the carried 76 samples first
    v.accept(seq(436, 1100), 96);
    expect(fake.fed).toHaveLength(3);
    expect(fake.fed[2][0]).toBeCloseTo(1024 / 10_000);
    expect(fake.fed[2][76]).toBeCloseTo(1100 / 10_000);
  });

  test("accept records watermark = the last frame's sessionMs", () => {
    const { v } = fakeVad();
    expect(v.watermark).toBe(-Infinity);
    v.accept(seq(512), 1000);
    v.accept(seq(512), 1032);
    expect(v.watermark).toBe(1032);
  });

  test("an utterance starts at the first frame's sessionMs + seg.start/16 and ends after its samples", () => {
    const { v, fake } = fakeVad();
    expect(v.accept(seq(512), 1000)).toEqual([]);
    fake.segment(1600, 8000);
    const [u] = v.accept(seq(512), 1032);
    expect(u).toMatchObject({ id: "u_1", stream: "host", startMs: 1100, endMs: 1600 });
    expect(u.samples.length).toBe(8000);
  });

  test("drain splits a segment longer than maxSpeechDuration into consecutive utterances with consecutive ids", () => {
    const { v, fake } = fakeVad({ maxSpeechDuration: 1 });
    v.accept(seq(512), 0);
    fake.segment(0, 40_000); // 2.5 s
    const out = v.accept(seq(512), 32);
    expect(out.map((u) => [u.id, u.startMs, u.endMs, u.samples.length])).toEqual([
      ["u_1", 0, 1000, 16_000], ["u_2", 1000, 2000, 16_000], ["u_3", 2000, 2500, 8000],
    ]);
  });

  test("ids are shared across StreamVads using one UtteranceIds", () => {
    const ids = new UtteranceIds();
    const a = fakeVad({ ids, stream: "host" });
    const b = fakeVad({ ids, stream: "remote" });
    a.v.accept(seq(512), 0);
    b.v.accept(seq(512), 0);
    a.fake.segment(0, 1000);
    b.fake.segment(0, 1000);
    a.fake.segment(2000, 1000);
    const out: Utterance[] = [...b.v.accept(seq(512), 32), ...a.v.accept(seq(512), 32)];
    expect(out.map((u) => `${u.stream} ${u.id}`)).toEqual(["remote u_1", "host u_2", "host u_3"]);
  });

  test("flush returns pending segments, sets ended, watermark Infinity, and isDetected false", () => {
    const { v, fake } = fakeVad();
    v.accept(seq(512), 500);
    fake.detected = true;
    expect(v.isDetected()).toBe(true);
    fake.segment(160, 3200);
    const out = v.flush();
    expect(fake.flushes).toBe(1);
    expect(out.map((u) => [u.startMs, u.endMs])).toEqual([[510, 710]]);
    expect(v.ended).toBe(true);
    expect(v.watermark).toBe(Infinity);
    expect(v.isDetected()).toBe(false); // even while the VAD itself still says speech
  });

  test("flush twice returns [] the second time and does not flush the VAD again", () => {
    const { v, fake } = fakeVad();
    v.flush();
    fake.segment(0, 1000);
    expect(v.flush()).toEqual([]);
    expect(fake.flushes).toBe(1);
  });

  test("flush without vad.flush feeds 1 s of silence windows (33 of them) instead", () => {
    const { v, fake } = fakeVad({ withFlush: false });
    v.accept(seq(512), 0);
    fake.fed = [];
    v.flush();
    // the loop runs while i < 16000/512 + 1 = 32.25: 33 windows of 512 zeros
    expect(fake.fed).toHaveLength(33);
    expect(fake.fed.every((w) => w.length === 512 && w.every((x) => x === 0))).toBe(true);
  });

  test("isDetected delegates to the VAD while not ended", () => {
    const { v, fake } = fakeVad();
    expect(v.isDetected()).toBe(false);
    fake.detected = true;
    expect(v.isDetected()).toBe(true);
  });

  test("an utterance before any frame starts from session time 0", () => {
    const { v, fake } = fakeVad();
    fake.segment(1600, 1600);
    const [u] = v.flush();
    expect(u.startMs).toBe(100);
  });
});

describe("StreamVad (real Silero)", () => {
  const feed = (v: StreamVad, samples: Float32Array, fromMs: number) => {
    const out: Utterance[] = [];
    for (let off = 0; off < samples.length; off += 512) out.push(...v.accept(samples.subarray(off, off + 512), fromMs + off / 16));
    return [...out, ...v.flush()];
  };

  test("pure digital silence yields no utterances", () => {
    requireAssets();
    const v = new StreamVad("host", cfg, new UtteranceIds());
    expect(feed(v, new Float32Array(16_000 * 3), 0)).toEqual([]);
  });

  test("a slice of the fixture's first host line yields 1 utterance within ±400 ms of the script", () => {
    const line = loadScript().lines[0];
    const from = line.startMs - 800;
    const v = new StreamVad("host", cfg, new UtteranceIds());
    const utts = feed(v, fixtureSlice("host", from, line.endMs + 1200), from);
    expect(utts).toHaveLength(1);
    expect(Math.abs(utts[0].startMs - line.startMs)).toBeLessThanOrEqual(400);
    expect(Math.abs(utts[0].endMs - line.endMs)).toBeLessThanOrEqual(400);
  });
});
