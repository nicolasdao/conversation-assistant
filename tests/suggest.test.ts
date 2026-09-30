import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, test } from "vitest";
import type { Embedder } from "../src/speakers/registry.ts";
import { centroidOf, cosine, recordedVoiceprints, suggestMerges, unit, type Voiceprint } from "../src/speakers/suggest.ts";
import { cleanTmpDirs, FakeEmbedder, tmpDir, wavFile } from "./fakes/index.ts";

const DIM = 64;
/** A unit vector pointing mostly along axis `k`, with `mix` of axis `k2`: cosine(voice(k,0), voice(k,m)) ≈ 1/√(1+m²). */
const voice = (k: number, mix = 0, k2 = (k + 1) % DIM) => unit(new Float32Array(DIM).map((_, i) => (i === k ? 1 : i === k2 ? mix : 0)));
const vp = (id: string, name: string, stream: "host" | "remote", centroid: Float32Array | null, lines = 100, talkMs = lines * 2000): Voiceprint =>
  ({ id, name, streams: [stream], centroid, sampled: centroid ? 20 : 0, lines, talkMs });

describe("merge suggestions", () => {
  test("one voice split by a codec merges into the named speaker, at high confidence; streams never mix", () => {
    const s = suggestMerges([
      vp("spk_1", "Nic", "host", voice(0)),
      vp("spk_2", "Alex", "remote", voice(5), 198),
      vp("spk_3", "Speaker 3", "remote", voice(5, 0.45), 613), // cosine ≈ 0.91, like the real recording's 0.90–0.92
    ], { host: 1, remote: 2 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ fromId: "spk_3", intoId: "spk_2", intoName: "Alex", stream: "remote", confidence: "high" });
    expect(s[0]!.similarity!).toBeGreaterThan(0.85);
  });

  test("different people are left alone, unless the stream has more voices than it should", () => {
    const people = [vp("spk_1", "Nic", "host", voice(0)), vp("spk_2", "Ana", "remote", voice(5)), vp("spk_3", "Tom", "remote", voice(9))];
    expect(suggestMerges(people, { host: 1, remote: 2 })).toEqual([]);
    const one = suggestMerges(people, { host: 1, remote: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ stream: "remote", confidence: "low" });
    expect(one[0]!.reason).toMatch(/set for 1 voice/);
  });

  test("a speaker with only short lines goes to the stream's main voice; chains point at the final speaker", () => {
    const s = suggestMerges([
      vp("spk_1", "Speaker 1", "host", voice(0), 300),
      vp("spk_5", "Speaker 5", "host", voice(0, 0.5), 10), // ≈ 0.89 to Speaker 1
      vp("spk_8", "Speaker 8", "host", voice(0, 0.5, 3), 2), // closest to Speaker 5 first
      vp("spk_6", "Speaker 6", "host", null, 1),
    ], { host: 1 });
    expect(s.map((m) => `${m.fromId}>${m.intoId}`).sort()).toEqual(["spk_5>spk_1", "spk_6>spk_1", "spk_8>spk_1"]);
    // no voiceprint, but 1 line out of 313 is a tiny share of the talk: medium rather than low
    expect(s.find((m) => m.fromId === "spk_6")).toMatchObject({ similarity: null, confidence: "medium" });
  });

  test("the real people are the renamed speakers and the biggest talkers; small duplicates go to the one they sound like", () => {
    const s = suggestMerges([
      vp("spk_1", "Speaker 1", "remote", voice(5), 300, 1_800_000), // 30 min
      vp("spk_2", "Speaker 2", "remote", voice(9), 250, 1_500_000), // 25 min
      vp("spk_3", "Speaker 3", "remote", voice(9, 0.8), 20, 40_000), // 40 s, closer to Speaker 2 (≈ 0.78)
      vp("spk_4", "Speaker 4", "remote", voice(5, 1.1), 3, 6_000), // 6 s, like Speaker 1 but weakly (≈ 0.67)
    ], { remote: 2 });
    // the two big talkers are kept and never merged with each other; each duplicate goes to its closest kept voice
    expect(s.map((m) => `${m.fromId}>${m.intoId}`).sort()).toEqual(["spk_3>spk_2", "spk_4>spk_1"]);
    // under 5 % of the talk raises confidence one level: 0.78 is medium → high, 0.67 is low → medium
    expect(s.find((m) => m.fromId === "spk_3")).toMatchObject({ confidence: "high", fromTalkMs: 40_000 });
    expect(s.find((m) => m.fromId === "spk_4")).toMatchObject({ confidence: "medium" });
    expect(s.find((m) => m.fromId === "spk_3")!.reason).toMatch(/talked 0:40, 1 % of this stream/);
  });

  test("a renamed speaker is kept and preferred as the destination, even when another talked more", () => {
    const s = suggestMerges([
      vp("spk_2", "Sam", "remote", voice(5), 50, 300_000), // renamed: acknowledged by the host
      vp("spk_4", "Speaker 4", "remote", voice(5, 0.4), 400, 2_400_000), // talked more, same voice
    ], { remote: 1 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ fromId: "spk_4", intoId: "spk_2", intoName: "Sam" });
  });
});

// ---------- every branch of suggestMerges, and recordedVoiceprints ----------

describe("voiceprint helpers", () => {
  test("unit of a zero vector is zeros; centroidOf([]) is null; centroidOf averages then normalises", () => {
    expect([...unit(new Float32Array(3))]).toEqual([0, 0, 0]);
    expect(centroidOf([])).toBeNull();
    const c = centroidOf([Float32Array.from([1, 0]), Float32Array.from([0, 1])])!;
    expect(c[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(cosine(Float32Array.from([1, 2]), Float32Array.from([3, 4]))).toBe(11);
  });
});

/** A voiceprint with exact (float64) components, for tests on the similarity bands' edges. */
const exact = (xs: number[]) => Float64Array.from([...xs, ...new Array(DIM - xs.length).fill(0)]) as unknown as Float32Array;

describe("merge suggestions: every rule", () => {
  test("a stream with fewer than 2 speakers gets no suggestion, even for identical voices on the other stream", () => {
    expect(suggestMerges([vp("spk_1", "Speaker 1", "host", voice(0)), vp("spk_2", "Speaker 2", "remote", voice(0))])).toEqual([]);
  });

  test("a speaker listed on both streams is considered on each", () => {
    const both: Voiceprint = { ...vp("spk_1", "Speaker 1", "host", voice(0), 300), streams: ["host", "remote"] };
    const s = suggestMerges([both, vp("spk_2", "Speaker 2", "host", voice(0, 0.3), 10), vp("spk_3", "Speaker 3", "remote", voice(0, 0.3), 10)]);
    expect(s.map((m) => `${m.stream}:${m.fromId}>${m.intoId}`).sort()).toEqual(["host:spk_2>spk_1", "remote:spk_3>spk_1"]);
  });

  test("a stream at or under its limit is merged by voice alone", () => {
    const s = suggestMerges([vp("spk_1", "Speaker 1", "remote", voice(5), 200), vp("spk_2", "Speaker 2", "remote", voice(5, 0.45), 100)], { remote: 2 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ fromId: "spk_2", intoId: "spk_1", confidence: "high" });
    expect(s[0].reason).not.toMatch(/set for/);
  });

  test("over the limit, with no voiceprint on the kept side: no similarity, the first kept speaker", () => {
    const s = suggestMerges([vp("spk_1", "Speaker 1", "remote", null, 300), vp("spk_2", "Speaker 2", "remote", voice(5), 3)], { remote: 1 });
    expect(s).toEqual([expect.objectContaining({ fromId: "spk_2", intoId: "spk_1", similarity: null, confidence: "medium" })]);
    expect(s[0].reason).toMatch(/in lines too short for a voiceprint; Speaker 1 is the main voice here/);
  });

  test("over the limit, a speaker with no voiceprint and a real share of the talk is 'low'", () => {
    const s = suggestMerges([vp("spk_1", "Speaker 1", "remote", voice(5), 60), vp("spk_2", "Speaker 2", "remote", null, 40)], { remote: 1 });
    expect(s[0]).toMatchObject({ fromId: "spk_2", similarity: null, confidence: "low" });
  });

  test("over the limit, the other speakers are taken smallest talker first", () => {
    const s = suggestMerges([
      vp("spk_1", "Speaker 1", "remote", null, 50), vp("spk_2", "Speaker 2", "remote", null, 30), vp("spk_3", "Speaker 3", "remote", null, 20),
    ], { remote: 1 });
    // same confidence and no similarity: the sort keeps the order they were made in
    expect(s.map((m) => m.fromId)).toEqual(["spk_3", "spk_2"]);
  });

  test("the reason says 'voices' for a limit above 1", () => {
    const s = suggestMerges([vp("a", "Speaker 1", "remote", voice(1), 300), vp("b", "Speaker 2", "remote", voice(20), 200), vp("c", "Speaker 3", "remote", voice(40), 100)], { remote: 2 });
    expect(s).toHaveLength(1);
    expect(s[0].reason).toMatch(/set for 2 voices$/);
  });

  test("by voice alone: a pair under 0.65 is not suggested; exactly 0.65 is", () => {
    const a = exact([1]);
    const at = exact([0.65, Math.sqrt(1 - 0.65 ** 2)]);
    const under = exact([0.6499, Math.sqrt(1 - 0.6499 ** 2)]);
    expect(suggestMerges([vp("a", "Speaker 1", "host", a, 20), vp("b", "Speaker 2", "host", under, 10)])).toEqual([]);
    const s = suggestMerges([vp("a", "Speaker 1", "host", a, 20), vp("b", "Speaker 2", "host", at, 10)]);
    expect(s).toEqual([expect.objectContaining({ fromId: "b", intoId: "a", similarity: 0.65, confidence: "low" })]);
  });

  test("by voice alone, the survivor is the renamed speaker even if they talked less", () => {
    const s = suggestMerges([vp("spk_4", "Speaker 4", "remote", voice(5, 0.4), 400), vp("spk_2", "Sam", "remote", voice(5), 50)]);
    expect(s[0]).toMatchObject({ fromId: "spk_4", intoId: "spk_2" });
  });

  test("by voice alone, equal rank keeps the earlier speaker as the destination", () => {
    const s = suggestMerges([vp("spk_1", "Speaker 1", "host", voice(5, 0.3), 10), vp("spk_2", "Speaker 2", "host", voice(5), 10)]);
    expect(s[0]).toMatchObject({ fromId: "spk_2", intoId: "spk_1" });
  });

  test("by voice alone, a chain points every suggestion at the final survivor, naming the link", () => {
    const c = unit(new Float32Array(DIM).map((_, i) => (i === 0 ? 1 : i === 1 ? 0.5 : i === 2 ? 0.2 : 0)));
    const s = suggestMerges([
      vp("A", "Speaker 1", "host", voice(0), 300), vp("B", "Speaker 2", "host", voice(0, 0.5), 20), vp("C", "Speaker 3", "host", c, 5),
    ]);
    expect(s.map((m) => `${m.fromId}>${m.intoId}`).sort()).toEqual(["B>A", "C>A"]);
    expect(s.find((m) => m.fromId === "C")!.reason).toMatch(/, via Speaker 2;/);
    expect(s.find((m) => m.fromId === "B")!.reason).not.toMatch(/via/);
  });

  test("by voice alone, a merged voiceprint weighs each side by how many lines built it", () => {
    const A = exact([1]);
    const B = exact([0.9, Math.sqrt(1 - 0.81)]);
    const C = exact([0.4, (0.75 - 0.36) / Math.sqrt(0.19), 0.2]);
    const run = (sa: number, sb: number) => suggestMerges([
      { ...vp("A", "Speaker 1", "host", A, 300), sampled: sa }, { ...vp("B", "Speaker 2", "host", B, 20), sampled: sb }, { ...vp("C", "Speaker 3", "host", C, 5), sampled: 1 },
    ]).map((m) => m.fromId).sort();
    expect(run(20, 1)).toEqual(["B"]); // the merged voice is mostly A's, far from C
    expect(run(1, 20)).toEqual(["B", "C"]); // mostly B's, which C is close to
  });

  test("zero talk on a stream: every share is 0 % and every duplicate counts as small", () => {
    const s = suggestMerges([vp("a", "Speaker 1", "remote", voice(1), 3, 0), vp("b", "Speaker 2", "remote", voice(30), 1, 0)], { remote: 1 });
    expect(s[0]).toMatchObject({ confidence: "medium" }); // low, raised
    expect(s[0].reason).toMatch(/talked 0:00, 0 % of this stream/);
  });

  test("talk time reads m:ss: 61 s is 1:01 and 65 min is 65:00", () => {
    const at = (ms: number) => suggestMerges([vp("a", "Speaker 1", "remote", voice(1), 1, 10 * 3_600_000), vp("b", "Speaker 2", "remote", voice(30), 1, ms)], { remote: 1 })[0].reason;
    expect(at(61_000)).toMatch(/talked 1:01,/);
    expect(at(65 * 60_000)).toMatch(/talked 65:00,/);
  });

  test("suggestions are sorted high, medium, low, then by similarity, highest first, none last", () => {
    const s = suggestMerges([
      vp("k", "Speaker 1", "remote", exact([1]), 1000, 1_000_000),
      vp("lowNull", "Speaker 2", "remote", null, 1, 500_000),
      vp("low70", "Speaker 3", "remote", exact([0.7, Math.sqrt(0.51)]), 1, 500_000),
      vp("med80", "Speaker 4", "remote", exact([0.8, 0.6]), 1, 500_000),
      vp("high90", "Speaker 5", "remote", exact([0.9, Math.sqrt(0.19)]), 1, 500_000),
      vp("high95", "Speaker 6", "remote", exact([0.95, Math.sqrt(1 - 0.9025)]), 1, 500_000),
    ], { remote: 1 });
    expect(s.map((m) => m.fromId)).toEqual(["high95", "high90", "med80", "low70", "lowNull"]);
  });

  it.fails("BUG S2-L1: by voice alone, a speaker too short for a voiceprint goes to the stream's biggest talker (docs/speakers.md)", () => {
    const s = suggestMerges([vp("spk_1", "Speaker 1", "remote", voice(5), 300), vp("spk_2", "Speaker 2", "remote", voice(30), 100), vp("spk_3", "Speaker 3", "remote", null, 2)]);
    expect(s).toEqual([expect.objectContaining({ fromId: "spk_3", intoId: "spk_1", similarity: null })]);
  });
});

describe("voiceprints recomputed from a recording", () => {
  afterEach(() => cleanTmpDirs());
  // second i of each track holds the constant (i + 1) / 100, so a clip's first sample says where it was cut
  const track = (seconds: number) => Float32Array.from({ length: Math.round(seconds * 16_000) }, (_, n) => (Math.floor(n / 16_000) + 1) / 100);
  const second = (clip: Float32Array) => Math.round(clip[0] * 100) - 1;
  const row = (id: string, speaker_id: string, stream: "host" | "remote", start_ms: number, end_ms: number, speaker_inferred = false) =>
    ({ id, speaker_id, stream, start_ms, end_ms, speaker_inferred });
  function recording(rows: unknown[], tracks: { host?: number; remote?: number } = { host: 40, remote: 40 }): string {
    const dir = tmpDir("rec-");
    writeFileSync(join(dir, "utterances.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (tracks.host) wavFile(dir, track(tracks.host), "host.wav");
    if (tracks.remote) wavFile(dir, track(tracks.remote), "remote.wav");
    return dir;
  }
  const same = (id: string) => id;
  const E = () => new FakeEmbedder(DIM);
  const asEmbedder = (e: FakeEmbedder) => e as unknown as Embedder;

  test("one voiceprint per speaker, with lines, talk time, and the clips it sampled", async () => {
    const e = E();
    const dir = recording([row("u_1", "spk_1", "host", 0, 3000), row("u_2", "spk_1", "host", 4000, 6500), row("u_3", "spk_2", "remote", 10_000, 12_500)]);
    const v = await recordedVoiceprints(dir, asEmbedder(e), same, new Map([["spk_1", "Nic"]]));
    expect(v.map(({ centroid: _c, ...x }) => x)).toEqual([
      { id: "spk_1", name: "Nic", streams: ["host"], sampled: 2, lines: 2, talkMs: 5500 },
      { id: "spk_2", name: "spk_2", streams: ["remote"], sampled: 1, lines: 1, talkMs: 2500 },
    ]);
    expect(v[0].centroid!.length).toBe(DIM);
    expect(e.clips.map(second)).toEqual([0, 4, 10]);
    expect(e.clips[0].length).toBe(3 * 16_000);
  });

  test("inferred lines and lines under 2 s are not sampled but still count", async () => {
    const e = E();
    const dir = recording([row("u_1", "spk_1", "host", 0, 1999), row("u_2", "spk_1", "host", 3000, 6000, true), row("u_3", "spk_1", "host", 8000, 10_000)]);
    const [v] = await recordedVoiceprints(dir, asEmbedder(e), same, new Map());
    expect(v).toMatchObject({ lines: 3, talkMs: 1999 + 3000 + 2000, sampled: 1 });
    expect(e.clips.map(second)).toEqual([8]);
  });

  test("merged speakers pool their lines under the survivor", async () => {
    const dir = recording([row("u_1", "spk_1", "host", 0, 3000), row("u_2", "spk_3", "host", 5000, 8000)]);
    const v = await recordedVoiceprints(dir, asEmbedder(E()), (id) => (id === "spk_3" ? "spk_1" : id), new Map());
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ id: "spk_1", lines: 2, sampled: 2 });
  });

  test("at most perSpeaker clips, spread evenly over the session", async () => {
    const e = E();
    const dir = recording(Array.from({ length: 10 }, (_, i) => row(`u_${i}`, "spk_1", "host", i * 3000, i * 3000 + 2000)));
    const [v] = await recordedVoiceprints(dir, asEmbedder(e), same, new Map(), 3);
    expect(v.sampled).toBe(3);
    expect(e.clips.map(second)).toEqual([0, 9, 18]); // lines 0, 3, 6 (a step of 3.33)
  });

  test("a line on a stream with no WAV is skipped: no voiceprint", async () => {
    const dir = recording([row("u_1", "spk_1", "remote", 0, 3000)], { host: 5 });
    const [v] = await recordedVoiceprints(dir, asEmbedder(E()), same, new Map());
    expect(v).toMatchObject({ centroid: null, sampled: 0, lines: 1 });
  });

  test("a clip cut to under 1 s by the end of the WAV is skipped", async () => {
    const e = E();
    const dir = recording([row("u_1", "spk_1", "host", 2000, 4500), row("u_2", "spk_1", "host", 0, 2000)], { host: 2.5 });
    const [v] = await recordedVoiceprints(dir, asEmbedder(e), same, new Map());
    expect(v.sampled).toBe(1);
    expect(e.clips.map(second)).toEqual([0]);
  });

  test("a speaker belongs to the stream most of their lines are on", async () => {
    const dir = recording([row("u_1", "spk_1", "host", 0, 3000), row("u_2", "spk_1", "remote", 0, 3000), row("u_3", "spk_1", "remote", 5000, 8000)]);
    const [v] = await recordedVoiceprints(dir, asEmbedder(E()), same, new Map());
    expect(v.streams).toEqual(["remote"]);
  });

  test("a line ending before it starts counts no talk time", async () => {
    const dir = recording([row("u_1", "spk_1", "host", 5000, 4000), row("u_2", "spk_1", "host", 6000, 7000)]);
    const [v] = await recordedVoiceprints(dir, asEmbedder(E()), same, new Map());
    expect(v.talkMs).toBe(1000);
  });

  test("a recording without utterances.jsonl, or with a corrupt line, rejects", async () => {
    const empty = tmpDir("rec-");
    await expect(recordedVoiceprints(empty, asEmbedder(E()), same, new Map())).rejects.toThrow(/ENOENT/);
    const dir = recording([]);
    writeFileSync(join(dir, "utterances.jsonl"), '{"id":"u_1"\n');
    await expect(recordedVoiceprints(dir, asEmbedder(E()), same, new Map())).rejects.toThrow(SyntaxError);
  });

  test("the WAV files are closed even when the embedder throws", async () => {
    const dir = recording([row("u_1", "spk_1", "host", 0, 3000)]);
    const broken = { embed: () => { throw new Error("model failed"); } } as unknown as Embedder;
    const open = () => readdirSync("/dev/fd").length;
    const before = open();
    await expect(recordedVoiceprints(dir, broken, same, new Map())).rejects.toThrow("model failed");
    expect(open()).toBe(before);
  });
});
