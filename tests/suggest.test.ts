import { describe, expect, test } from "vitest";
import { suggestMerges, unit, type Voiceprint } from "../src/speakers/suggest.ts";

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
