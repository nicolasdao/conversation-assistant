import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { FileSource, mergeSources } from "../src/audio/source.ts";
import { StreamVad, UtteranceIds, type Utterance } from "../src/audio/vad.ts";
import { Embedder, SpeakerRegistry } from "../src/speakers/registry.ts";
import { FIXTURE_DIR, loadScript, requireAssets } from "./helpers.ts";

const cfg = loadConfig();

async function fixtureUtterances(): Promise<Utterance[]> {
  const ids = new UtteranceIds();
  const vads = { host: new StreamVad("host", cfg.app.vad, ids), remote: new StreamVad("remote", cfg.app.vad, ids) };
  const out: Utterance[] = [];
  const sources = [new FileSource(`${FIXTURE_DIR}/host.wav`, "host", "max"), new FileSource(`${FIXTURE_DIR}/remote.wav`, "remote", "max")];
  for await (const f of mergeSources(sources, (s) => out.push(...vads[s].flush()))) out.push(...vads[f.stream].accept(f.samples, f.sessionMs));
  return out.sort((a, b) => a.startMs - b.startMs);
}

describe("speaker registry", () => {
  requireAssets();
  const embedder = new Embedder();

  test("the fixture yields exactly 3 speakers, consistent with the script", async () => {
    const script = loadScript();
    const utts = await fixtureUtterances();
    const reg = new SpeakerRegistry(cfg.app.speakers, embedder);
    const pairs: { voice: string; speaker: string }[] = [];
    for (const u of utts) {
      const a = reg.assign(u.stream, u.samples);
      const line = script.lines.find((l) => l.stream === u.stream && Math.min(l.endMs, u.endMs) - Math.max(l.startMs, u.startMs) > 0);
      if (line && (u.endMs - u.startMs) / 1000 >= 1.5) pairs.push({ voice: line.voice, speaker: a.speakerId });
    }
    expect(reg.active().length).toBe(3);
    // Map each voice to its majority speaker; ≥ 95% must agree, and the mapping is one-to-one.
    const byVoice = new Map<string, Map<string, number>>();
    for (const p of pairs) {
      const m = byVoice.get(p.voice) ?? new Map();
      m.set(p.speaker, (m.get(p.speaker) ?? 0) + 1);
      byVoice.set(p.voice, m);
    }
    const majority = new Map([...byVoice].map(([v, m]) => [v, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
    expect(new Set(majority.values()).size).toBe(3);
    const consistent = pairs.filter((p) => majority.get(p.voice) === p.speaker).length;
    expect(consistent / pairs.length).toBeGreaterThanOrEqual(0.95);
  });

  test("short utterances take the stream's last speaker, marked inferred", () => {
    const reg = new SpeakerRegistry(cfg.app.speakers, embedder);
    const first = reg.assignEmbedding("remote", null);
    expect(first.created?.displayName).toBe("Speaker 1");
    expect(first.inferred).toBe(true);
    const second = reg.assignEmbedding("remote", null);
    expect(second.speakerId).toBe(first.speakerId);
    expect(second.created).toBeUndefined();
  });

  test("a placeholder speaker from short utterances adopts the first voiceprint on its stream", () => {
    const reg = new SpeakerRegistry(cfg.app.speakers, embedder);
    const dim = embedder.dim;
    const host = new Float32Array(dim).map((_, i) => (i % 2 ? 1 : 0));
    const ai = new Float32Array(dim).map((_, i) => (i % 2 ? 0 : 1));
    expect(reg.assignEmbedding("host", host).speakerId).toBe("spk_1");
    const short = reg.assignEmbedding("remote", null); // "Loud and clear." — too short to embed
    expect(short.created?.id).toBe("spk_2");
    const long = reg.assignEmbedding("remote", ai); // the same voice, now long enough
    expect(long).toEqual({ speakerId: "spk_2", inferred: false });
    expect(reg.assignEmbedding("remote", ai).speakerId).toBe("spk_2");
    expect(reg.active().map((s) => s.id)).toEqual(["spk_1", "spk_2"]);
    // a speaker that already has a voiceprint is never overwritten: a new voice still creates a new speaker
    const other = new Float32Array(dim).map((_, i) => (i % 4 < 2 ? 1 : -1));
    expect(reg.assignEmbedding("remote", other).created?.id).toBe("spk_3");
  });

  test("rename and merge", () => {
    const reg = new SpeakerRegistry(cfg.app.speakers, embedder);
    const dim = embedder.dim;
    const a = new Float32Array(dim).map((_, i) => (i % 2 ? 1 : 0));
    const b = new Float32Array(dim).map((_, i) => (i % 2 ? 0 : 1));
    const s1 = reg.assignEmbedding("host", a);
    const s2 = reg.assignEmbedding("remote", b);
    expect(s1.speakerId).toBe("spk_1");
    expect(s2.speakerId).toBe("spk_2");
    expect(reg.assignEmbedding("remote", b).speakerId).toBe("spk_2");

    reg.rename("spk_1", "Nic");
    expect(reg.displayName("spk_1")).toBe("Nic");
    expect(() => reg.rename("spk_1", "  ")).toThrow();

    reg.merge("spk_2", "spk_1");
    expect(reg.resolve("spk_2")).toBe("spk_1");
    expect(reg.displayName("spk_2")).toBe("Nic");
    expect(reg.active().map((s) => s.id)).toEqual(["spk_1"]);
    expect(reg.list().find((s) => s.id === "spk_2")?.mergedInto).toBe("spk_1");
    // the moved embeddings now match the surviving speaker
    expect(reg.assignEmbedding("remote", b).speakerId).toBe("spk_1");
    // a short utterance on the stream whose last speaker was merged resolves too
    expect(reg.assignEmbedding("remote", null).speakerId).toBe("spk_1");
    expect(() => reg.merge("spk_1", "spk_1")).toThrow();
  });

  test("a voice belongs to its stream, and a stream with all its voices reuses the closest one", () => {
    const dim = embedder.dim;
    const a = new Float32Array(dim).map((_, i) => (i % 2 ? 1 : 0));
    const b = new Float32Array(dim).map((_, i) => (i % 2 ? 0 : 1));
    const c = new Float32Array(dim).map((_, i) => (i % 4 < 2 ? 1 : -1));
    const bish = b.map((x, i) => (i % 3 === 0 ? x * 0.3 + 0.2 : x)); // the same voice, drifted by a codec
    const reg = new SpeakerRegistry(cfg.app.speakers, embedder, { host: 1, remote: 1 });
    expect(reg.assignEmbedding("host", a).speakerId).toBe("spk_1");
    // the same voiceprint on the other stream is a different person: the host's mic never hears the call
    expect(reg.assignEmbedding("remote", a).created?.id).toBe("spk_2");
    // the call carries one voice: an unfamiliar line goes to it rather than becoming Speaker 3
    expect(reg.assignEmbedding("remote", c)).toEqual({ speakerId: "spk_2", inferred: false });
    expect(reg.assignEmbedding("remote", bish).speakerId).toBe("spk_2");
    // and so does the host's mic, with its one voice
    expect(reg.assignEmbedding("host", c).speakerId).toBe("spk_1");
    expect(reg.active().length).toBe(2);
    // without a limit, the same unfamiliar voice would have been a new speaker
    const open = new SpeakerRegistry(cfg.app.speakers, embedder, {});
    open.assignEmbedding("remote", a);
    expect(open.assignEmbedding("remote", c).created?.id).toBe("spk_2");
  });
});
