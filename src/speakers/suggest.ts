// Merge suggestions: which detected speakers are really the same person. Each speaker's voiceprint (the mean of their
// lines' embeddings) is compared with the others heard on the same stream; pairs that sound alike are proposed as
// merges, best first, with a voice-match score and a confidence the host can act on. Code decides; nothing is merged
// until the host clicks.
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { StreamName } from "../audio/source.ts";
import { SAMPLE_RATE } from "../audio/wav.ts";
import type { Embedder } from "./registry.ts";

export interface Voiceprint {
  id: string;
  name: string;
  streams: StreamName[];
  /** Unit-length mean of the speaker's line embeddings; null when no line was long enough to embed. */
  centroid: Float32Array | null;
  /** Lines the voiceprint was built from, and all the speaker's lines. */
  sampled: number;
  lines: number;
  /** How long the speaker talked: the real people talk the most, a voice's duplicates little. */
  talkMs: number;
}

export type Confidence = "high" | "medium" | "low";

export interface MergeSuggestion {
  fromId: string; fromName: string; fromTalkMs: number;
  intoId: string; intoName: string; intoTalkMs: number;
  stream: StreamName;
  /** Cosine similarity of the two voiceprints, 0–1; null when the smaller speaker has no voiceprint. */
  similarity: number | null;
  confidence: Confidence;
  reason: string;
}

/**
 * Similarity bands, from recordings where the truth is known: one voice split by a call codec scored 0.92
 * (a podcast recording: a named co-host vs "Speaker 3"); different people scored 0.55–0.61; one speaker's two halves 0.98–1.00.
 */
export const BANDS = { high: 0.85, medium: 0.75, low: 0.65 } as const;

export function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function centroidOf(vs: Float32Array[]): Float32Array | null {
  if (vs.length === 0) return null;
  const c = new Float32Array(vs[0]!.length);
  for (const v of vs) for (let i = 0; i < v.length; i++) c[i]! += v[i]!;
  return unit(c);
}

const isDefaultName = (n: string) => /^Speaker \d+$/.test(n);

/** A duplicate this small a share of its stream's talk time is almost never a real person. */
export const SMALL_SHARE = 0.05;

const band = (sim: number): Confidence => (sim >= BANDS.high ? "high" : sim >= BANDS.medium ? "medium" : "low");
const raise = (c: Confidence): Confidence => (c === "low" ? "medium" : "high");
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/**
 * Proposes merges within each stream. Two signals decide, besides the voices:
 *   - A name the host gave marks a speaker as acknowledged: it is always kept, and preferred as the destination.
 *   - Talk time: the real people are the ones who talk the most; duplicates made by a drifting voice talk little.
 *
 * When a stream has more speakers than its expected voices (`limits`: 1 on the host's mic, the people on the call),
 * the kept speakers are the renamed ones, then the biggest talkers, up to that number; every other speaker goes to the
 * kept speaker whose voice it matches best, never to another duplicate. Confidence comes from the voice match (bands
 * above), one level higher for a duplicate under 5 % of the stream's talk. Otherwise, pairs are merged by voice alone,
 * most similar first (re-merging voiceprints after each), while a pair reaches the low band; the survivor is the
 * renamed one, else the bigger talker. A speaker too short for a voiceprint goes to the stream's biggest talker.
 */
export function suggestMerges(prints: Voiceprint[], limits: Partial<Record<StreamName, number>> = {}): MergeSuggestion[] {
  const out: MergeSuggestion[] = [];
  for (const stream of ["host", "remote"] as StreamName[]) {
    type Group = { id: string; name: string; talkMs: number; lines: number; vectors: { c: Float32Array; w: number }[]; centroid: Float32Array | null };
    const groups: Group[] = prints.filter((p) => p.streams.includes(stream)).map((p) => ({
      id: p.id, name: p.name, talkMs: p.talkMs, lines: p.lines, vectors: p.centroid ? [{ c: p.centroid, w: Math.max(1, p.sampled) }] : [], centroid: p.centroid,
    }));
    if (groups.length < 2) continue;
    const total = groups.reduce((n, g) => n + g.talkMs, 0) || 1;
    const limit = limits[stream] ?? 0;
    // acknowledged (renamed) first, then by talk time, then by lines
    const rank = (a: Group, b: Group) =>
      Number(isDefaultName(a.name)) - Number(isDefaultName(b.name)) || b.talkMs - a.talkMs || b.lines - a.lines;
    const talkNote = (g: Group) => `${g.name} talked ${mmss(g.talkMs)}, ${Math.round((g.talkMs / total) * 100)} % of this stream`;
    const push = (from: Group, into: Group, sim: number | null, confidence: Confidence, reason: string) =>
      out.push({ fromId: from.id, fromName: from.name, fromTalkMs: from.talkMs, intoId: into.id, intoName: into.name, intoTalkMs: into.talkMs, stream, similarity: sim, confidence, reason });

    if (limit > 0 && groups.length > limit) {
      // the kept speakers: renamed ones, then the biggest talkers
      const kept = [...groups].sort(rank).slice(0, limit);
      for (const g of groups.filter((x) => !kept.includes(x)).sort((a, b) => a.talkMs - b.talkMs)) {
        let best: { k: Group; sim: number } | null = null;
        if (g.centroid) for (const k of kept) if (k.centroid) {
          const sim = cosine(g.centroid, k.centroid);
          if (!best || sim > best.sim) best = { k, sim };
        }
        const small = g.talkMs / total < SMALL_SHARE;
        if (!best) {
          const into = kept[0]!;
          push(g, into, null, small ? "medium" : "low",
            `${talkNote(g)}, in lines too short for a voiceprint; ${into.name} is the main voice here`);
          continue;
        }
        const conf = small ? raise(band(best.sim)) : band(best.sim);
        push(g, best.k, best.sim, conf,
          `voices match ${Math.round(best.sim * 100)} %; ${talkNote(g)}, and it was set for ${limit} voice${limit === 1 ? "" : "s"}`);
      }
      continue;
    }

    // no limit reached: merge by voice alone, most similar pair first
    const merged: { from: Group; into: Group; sim: number }[] = [];
    for (;;) {
      let best: { a: Group; b: Group; sim: number } | null = null;
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const a = groups[i]!, b = groups[j]!;
          if (!a.centroid || !b.centroid) continue;
          const sim = cosine(a.centroid, b.centroid);
          if (!best || sim > best.sim) best = { a, b, sim };
        }
      }
      if (!best || best.sim < BANDS.low) break;
      const into = rank(best.a, best.b) <= 0 ? best.a : best.b;
      const from = into === best.a ? best.b : best.a;
      merged.push({ from, into, sim: best.sim });
      into.vectors.push(...from.vectors);
      const c = new Float32Array(into.vectors[0]!.c.length);
      for (const { c: v, w } of into.vectors) for (let k = 0; k < v.length; k++) c[k]! += v[k]! * w;
      into.centroid = unit(c);
      groups.splice(groups.indexOf(from), 1);
    }
    // point chains at the final survivor ("8 → 9", "9 → 1" become "8 → 1", "9 → 1")
    const finalOf = (g: Group): Group => { let x = g; for (let n = 0; n < 50; n++) { const m = merged.find((y) => y.from === x); if (!m) break; x = m.into; } return x; };
    for (const m of merged) {
      const into = finalOf(m.into);
      push(m.from, into, m.sim, band(m.sim), `voices match ${Math.round(m.sim * 100)} %${into !== m.into ? `, via ${m.into.name}` : ""}; ${talkNote(m.from)}`);
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((x, y) => order[x.confidence] - order[y.confidence] || (y.similarity ?? 0) - (x.similarity ?? 0));
}

/** Reads one clip of a 16 kHz mono PCM16 WAV without loading the file (the header is 44 bytes; sizes may be unset while recording). */
function readClip(fd: number, startMs: number, endMs: number): Float32Array {
  const from = Math.max(0, Math.round(startMs * (SAMPLE_RATE / 1000)));
  const n = Math.max(0, Math.round(endMs * (SAMPLE_RATE / 1000)) - from);
  const buf = Buffer.alloc(n * 2);
  const read = readSync(fd, buf, 0, buf.length, 44 + from * 2);
  const out = new Float32Array(Math.floor(read / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/**
 * Voiceprints of a session folder's speakers, from its audio: up to `perSpeaker` of each speaker's longest-voiced lines
 * (at least 2 s, not inferred), spread over the session. `resolve` follows merges already made; `names` gives the
 * current names. Yields to the event loop between embeddings so the server stays responsive.
 */
export async function recordedVoiceprints(
  dir: string, embedder: Embedder, resolve: (id: string) => string, names: Map<string, string>, perSpeaker = 30,
): Promise<Voiceprint[]> {
  const rows = readFileSync(join(dir, "utterances.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const by = new Map<string, { perStream: Map<StreamName, number>; lines: number; talkMs: number; clips: any[] }>();
  for (const r of rows) {
    const id = resolve(r.speaker_id);
    const e = by.get(id) ?? by.set(id, { perStream: new Map(), lines: 0, talkMs: 0, clips: [] }).get(id)!;
    e.lines++;
    e.talkMs += Math.max(0, r.end_ms - r.start_ms);
    e.perStream.set(r.stream, (e.perStream.get(r.stream) ?? 0) + 1);
    if (!r.speaker_inferred && r.end_ms - r.start_ms >= 2000) e.clips.push(r);
  }
  const fds: Partial<Record<StreamName, number>> = {};
  for (const s of ["host", "remote"] as StreamName[]) if (existsSync(join(dir, `${s}.wav`))) fds[s] = openSync(join(dir, `${s}.wav`), "r");
  try {
    const out: Voiceprint[] = [];
    for (const [id, e] of by) {
      // evenly spread picks, so a voice that drifts over the session is represented from start to end
      const step = Math.max(1, e.clips.length / perSpeaker);
      const picks = Array.from({ length: Math.min(perSpeaker, e.clips.length) }, (_, i) => e.clips[Math.floor(i * step)]);
      const vs: Float32Array[] = [];
      for (const c of picks) {
        const fd = fds[c.stream as StreamName];
        if (fd === undefined) continue;
        const clip = readClip(fd, c.start_ms, c.end_ms);
        if (clip.length < SAMPLE_RATE) continue;
        vs.push(unit(embedder.embed(clip)));
        await new Promise((r) => setImmediate(r));
      }
      // A speaker belongs to the stream most of their lines are on: recordings from before voices were tied to a stream
      // can have a few lines matched across streams, and the host's mic never hears the call.
      const home = [...e.perStream].sort((a, b) => b[1] - a[1])[0]![0];
      out.push({ id, name: names.get(id) ?? id, streams: [home], centroid: centroidOf(vs), sampled: vs.length, lines: e.lines, talkMs: e.talkMs });
    }
    return out;
  } finally {
    for (const fd of Object.values(fds)) if (fd !== undefined) closeSync(fd);
  }
}
