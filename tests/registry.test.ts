// The speaker registry's rules with a fake embedder: no model, milliseconds (docs/speakers.md). The fixture test with the
// real WeSpeaker model is in tests/speakers.test.ts.
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { SpeakerRegistry, type Embedder } from "../src/speakers/registry.ts";
import { cosine, unit } from "../src/speakers/suggest.ts";
import { FakeEmbedder, vec } from "./fakes/index.ts";

const cfg = loadConfig().app.speakers;
const DIM = 64;
const reg = (limits: Parameters<typeof make>[0] = {}, embedder = new FakeEmbedder(DIM)) => make(limits, embedder);
function make(limits: Partial<Record<"host" | "remote", number>>, embedder: FakeEmbedder) {
  return new SpeakerRegistry(cfg, embedder as unknown as Embedder, limits);
}
const axis = (k: number) => vec(k, 0, DIM);

describe("speaker registry: assign", () => {
  test("a line shorter than minEmbedSeconds is never embedded and takes the stream's speaker, inferred", () => {
    const e = new FakeEmbedder(DIM);
    const r = reg({}, e);
    const a = r.assign("host", new Float32Array(Math.round(cfg.minEmbedSeconds * 16_000) - 160)); // 1.49 s
    expect(e.clips).toHaveLength(0);
    expect(a).toMatchObject({ speakerId: "spk_1", inferred: true });
    expect(a.created?.displayName).toBe("Speaker 1");
  });

  test("a line of exactly minEmbedSeconds is embedded", () => {
    const e = new FakeEmbedder(DIM, [axis(3)]);
    const r = reg({}, e);
    const a = r.assign("host", new Float32Array(cfg.minEmbedSeconds * 16_000));
    expect(e.clips).toHaveLength(1);
    expect(a).toMatchObject({ speakerId: "spk_1", inferred: false });
    expect(r.voiceprints()[0].sampled).toBe(1);
  });

  test("a match at exactly the threshold is a match (>=); a hair above it is not", () => {
    const b = new Float32Array(DIM);
    b[0] = 0.6; b[1] = 0.8;
    const sim = cosine(unit(b), axis(0)); // what the registry computes: the centroid of one axis vector is itself
    const at = reg();
    at.assignEmbedding("host", axis(0));
    expect(at.assignEmbedding("host", b, sim)).toEqual({ speakerId: "spk_1", inferred: false });
    const above = reg();
    above.assignEmbedding("host", axis(0));
    expect(above.assignEmbedding("host", b, sim + 1e-6).created?.id).toBe("spk_2");
  });

  test("assignEmbedding takes a custom threshold instead of the configured one", () => {
    const b = new Float32Array(DIM);
    b[0] = 0.6; b[1] = 0.8; // cosine 0.6 with axis 0: under the configured 0.65
    const strict = reg();
    strict.assignEmbedding("host", axis(0));
    expect(strict.assignEmbedding("host", b).created?.id).toBe("spk_2");
    const loose = reg();
    loose.assignEmbedding("host", axis(0));
    expect(loose.assignEmbedding("host", b, 0.5).speakerId).toBe("spk_1");
  });

  test("a voiceprint keeps at most maxEmbeddingsPerSpeaker embeddings", () => {
    const r = reg();
    for (let i = 0; i < 25; i++) r.assignEmbedding("host", axis(0));
    expect(r.voiceprints()[0]).toMatchObject({ sampled: cfg.maxEmbeddingsPerSpeaker, lines: 25 });
  });

  test("the centroid is the unit mean of the kept embeddings", () => {
    const r = reg();
    const a = axis(0);
    const b = vec(0, 0.5, DIM); // cosine ≈ 0.89: the same voice
    r.assignEmbedding("host", a);
    expect(r.assignEmbedding("host", b).speakerId).toBe("spk_1");
    const expected = unit(a.map((x, i) => x + b[i]));
    const c = r.voiceprints()[0].centroid!;
    expect(Math.hypot(...c)).toBeCloseTo(1, 5);
    for (let i = 0; i < DIM; i++) expect(c[i]).toBeCloseTo(expected[i], 6);
  });

  test("a zero-vector embedding matches nobody and becomes a speaker of its own", () => {
    const r = reg();
    r.assignEmbedding("host", axis(0));
    const z = r.assignEmbedding("host", new Float32Array(DIM));
    expect(z.created?.id).toBe("spk_2");
    expect(r.voiceprints()[1].centroid!.every((x) => x === 0)).toBe(true);
  });

  test("a placeholder from short lines adopts the stream's first voiceprint; a voiced speaker never does", () => {
    const r = reg({ remote: 0 });
    expect(r.assignEmbedding("remote", null).created?.id).toBe("spk_1");
    expect(r.assignEmbedding("remote", axis(5))).toEqual({ speakerId: "spk_1", inferred: false });
    expect(r.voiceprints()[0]).toMatchObject({ sampled: 1, lines: 2 });
    expect(r.assignEmbedding("remote", axis(30)).created?.id).toBe("spk_2");
  });

  test("a limit of 0 means no limit", () => {
    const r = reg({ host: 0 });
    for (let k = 0; k < 4; k++) r.assignEmbedding("host", axis(k * 5));
    expect(r.active()).toHaveLength(4);
  });

  test("a stream at its limit sends an unmatched line to the closest voice without adding to its voiceprint", () => {
    const r = reg({ remote: 2 });
    r.assignEmbedding("remote", axis(0));
    r.assignEmbedding("remote", axis(10));
    const near10 = vec(10, 1.2, DIM); // cosine ≈ 0.64 with axis 10: under the threshold, but the closest
    expect(r.assignEmbedding("remote", near10)).toEqual({ speakerId: "spk_2", inferred: false });
    expect(r.voiceprints().map((v) => v.sampled)).toEqual([1, 1]);
    expect(r.get("spk_2")!.utterances).toBe(2);
    // the chosen voice is now the stream's current speaker: a short line after it is theirs
    expect(r.assignEmbedding("remote", null)).toEqual({ speakerId: "spk_2", inferred: true });
  });

  test("the default limits are the config's voicesPerStream (none when the config has none)", () => {
    const e = new FakeEmbedder(DIM);
    const one = new SpeakerRegistry({ ...cfg, voicesPerStream: { host: 1, remote: 1 } }, e as unknown as Embedder);
    one.assignEmbedding("remote", axis(0));
    expect(one.assignEmbedding("remote", axis(20)).speakerId).toBe("spk_1");
    const none = new SpeakerRegistry({ ...cfg, voicesPerStream: undefined } as never, e as unknown as Embedder);
    none.assignEmbedding("remote", axis(0));
    expect(none.assignEmbedding("remote", axis(20)).created?.id).toBe("spk_2");
  });
});

describe("speaker registry: voiceprints, rename, merge", () => {
  test("voiceprints: a placeholder has no centroid; lines count every utterance; talk time is 0; streams listed", () => {
    const r = reg();
    r.assignEmbedding("remote", null);
    r.assignEmbedding("remote", null);
    r.assignEmbedding("host", axis(1));
    expect(r.voiceprints()).toEqual([
      { id: "spk_1", name: "Speaker 1", streams: ["remote"], centroid: null, sampled: 0, lines: 2, talkMs: 0 },
      { id: "spk_2", name: "Speaker 2", streams: ["host"], centroid: axis(1), sampled: 1, lines: 1, talkMs: 0 },
    ]);
  });

  test("voiceprints leave merged speakers out", () => {
    const r = reg();
    r.assignEmbedding("host", axis(0));
    r.assignEmbedding("remote", axis(9));
    r.merge("spk_2", "spk_1");
    expect(r.voiceprints().map((v) => v.id)).toEqual(["spk_1"]);
    expect(r.voiceprints()[0].streams.sort()).toEqual(["host", "remote"]);
  });

  test("rename: an unknown id throws, the name is trimmed, and a merged id renames the survivor", () => {
    const r = reg();
    r.assignEmbedding("host", axis(0));
    r.assignEmbedding("remote", axis(9));
    expect(() => r.rename("spk_9", "Nic")).toThrow("unknown speaker spk_9");
    expect(() => r.rename("spk_1", " \t ")).toThrow("displayName must not be empty");
    expect(r.rename("spk_1", "  Nic  ").displayName).toBe("Nic");
    r.merge("spk_2", "spk_1");
    expect(r.rename("spk_2", "Nicolas").id).toBe("spk_1");
    expect(r.displayName("spk_1")).toBe("Nicolas");
  });

  test("merge: unknown ids throw; merging a merged speaker into its survivor is merging it into itself", () => {
    const r = reg();
    r.assignEmbedding("host", axis(0));
    r.assignEmbedding("remote", axis(9));
    expect(() => r.merge("spk_9", "spk_1")).toThrow("unknown speaker");
    expect(() => r.merge("spk_1", "spk_9")).toThrow("unknown speaker");
    r.merge("spk_2", "spk_1");
    expect(() => r.merge("spk_2", "spk_1")).toThrow("cannot merge a speaker into itself");
  });

  test("merge chains resolve transitively", () => {
    const r = reg();
    r.assignEmbedding("host", axis(0));
    r.assignEmbedding("host", axis(10));
    r.assignEmbedding("host", axis(20));
    r.merge("spk_1", "spk_2");
    r.merge("spk_2", "spk_3");
    expect(r.resolve("spk_1")).toBe("spk_3");
    expect(r.get("spk_1")!.id).toBe("spk_3");
  });

  test("merge sums the lines and joins the streams: the host's mic can then match the merged call voice", () => {
    const r = reg({ host: 0, remote: 0 });
    r.assignEmbedding("host", axis(0));
    r.assignEmbedding("remote", axis(9));
    r.assignEmbedding("remote", axis(9));
    const into = r.merge("spk_1", "spk_2");
    expect(into.utterances).toBe(3);
    expect(r.assignEmbedding("host", axis(9)).speakerId).toBe("spk_2");
  });

  test("two placeholders merged stay without a voiceprint, and the survivor then adopts one", () => {
    const r = reg();
    r.assignEmbedding("host", null);
    r.assignEmbedding("remote", null);
    r.merge("spk_1", "spk_2");
    expect(r.voiceprints()).toEqual([{ id: "spk_2", name: "Speaker 2", streams: ["remote", "host"], centroid: null, sampled: 0, lines: 2, talkMs: 0 }]);
    expect(r.assignEmbedding("host", axis(3))).toEqual({ speakerId: "spk_2", inferred: false });
  });

  test("merge caps the combined embeddings at maxEmbeddingsPerSpeaker", () => {
    const r = reg();
    for (let i = 0; i < 15; i++) r.assignEmbedding("host", axis(0));
    for (let i = 0; i < 15; i++) r.assignEmbedding("remote", axis(9));
    r.merge("spk_1", "spk_2");
    expect(r.voiceprints()).toHaveLength(1);
    expect(r.voiceprints()[0].sampled).toBe(cfg.maxEmbeddingsPerSpeaker);
  });

  test("an unknown id: displayName is the id, get is undefined", () => {
    const r = reg();
    expect(r.displayName("spk_42")).toBe("spk_42");
    expect(r.get("spk_42")).toBeUndefined();
  });

  test("list() returns copies", () => {
    const r = reg();
    r.assignEmbedding("host", axis(0));
    r.list()[0].displayName = "Changed";
    r.active()[0].utterances = 99;
    expect(r.get("spk_1")).toMatchObject({ displayName: "Speaker 1", utterances: 1 });
  });
});
