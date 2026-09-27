import sherpa, { type SpeakerEmbeddingExtractor } from "sherpa-onnx-node";
import type { AppConfig } from "../config.ts";
import type { StreamName } from "../audio/source.ts";
import { SAMPLE_RATE } from "../audio/wav.ts";
import type { Voiceprint } from "./suggest.ts";
import { speakerModelPath } from "../paths.ts";

export interface Speaker {
  id: string;
  displayName: string;
  mergedInto?: string;
  utterances: number;
}

export interface Assignment {
  speakerId: string;
  inferred: boolean;
  /** Set when this assignment created a new speaker. */
  created?: Speaker;
}

/** Wraps the WeSpeaker extractor so the registry and calibration share it. */
export class Embedder {
  private readonly extractor: SpeakerEmbeddingExtractor;

  constructor(modelPath = speakerModelPath()) {
    this.extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false });
  }

  get dim(): number {
    return this.extractor.dim;
  }

  embed(samples: Float32Array): Float32Array {
    const stream = this.extractor.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    stream.inputFinished();
    return this.extractor.compute(stream, false);
  }
}

/** How many different voices each stream carries at most; 0 or absent means no limit. */
export type VoiceLimits = Partial<Record<StreamName, number>>;

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * One speaker registry for both streams (§4.4). A voice belongs to the stream it was heard on: the host's microphone
 * never hears the call (the host wears earbuds), so a line is only compared with voices from its own stream. Each
 * stream also has a limit on how many voices it carries; once a stream has that many, a line that matches no one
 * closely goes to the closest voice instead of creating a new speaker. Codecs like WhatsApp's make one voice drift
 * too far for any threshold to hold it together (see docs/speakers.md).
 */
export class SpeakerRegistry {
  private readonly speakers = new Map<string, Speaker>();
  private readonly embeddings = new Map<string, Float32Array[]>();
  /** The mean of each speaker's unit embeddings (unit length), used for matching. */
  private readonly centroids = new Map<string, Float32Array>();
  /** The streams each speaker was heard on; a merge joins them. */
  private readonly streams = new Map<string, Set<StreamName>>();
  private readonly lastOnStream = new Map<StreamName, string>();
  private n = 0;

  constructor(private readonly cfg: AppConfig["speakers"], private readonly embedder: Embedder, private readonly limits: VoiceLimits = cfg.voicesPerStream ?? {}) {}

  /** Embeds (when long enough) and assigns a speaker to an utterance. */
  assign(stream: StreamName, samples: Float32Array): Assignment {
    const seconds = samples.length / SAMPLE_RATE;
    const v = seconds >= this.cfg.minEmbedSeconds ? this.embedder.embed(samples) : null;
    return this.assignEmbedding(stream, v);
  }

  /** Assigns with a precomputed embedding, or null for an utterance too short to embed. */
  assignEmbedding(stream: StreamName, v: Float32Array | null, threshold = this.cfg.threshold): Assignment {
    if (v === null) {
      const last = this.lastOnStream.get(stream);
      if (last) {
        const id = this.resolve(last);
        this.speakers.get(id)!.utterances++;
        return { speakerId: id, inferred: true };
      }
      const created = this.create(stream, []);
      return { speakerId: created.id, inferred: true, created };
    }
    const u = unit(v);
    const onStream = this.onStream(stream);
    let best: { id: string; sim: number } | null = null;
    for (const id of onStream) {
      const c = this.centroids.get(id);
      if (!c) continue;
      const sim = cosine(u, c);
      if (!best || sim > best.sim) best = { id, sim };
    }
    if (best && best.sim >= threshold) {
      this.addEmbedding(best.id, u);
      this.speakers.get(best.id)!.utterances++;
      this.lastOnStream.set(stream, best.id);
      return { speakerId: best.id, inferred: false };
    }
    // The stream's current speaker may be a placeholder made from utterances too short to embed ("Loud and clear."):
    // it adopts this first voiceprint instead of the same voice becoming a second speaker.
    const last = this.lastOnStream.get(stream);
    const placeholder = last ? this.resolve(last) : undefined;
    if (placeholder && (this.embeddings.get(placeholder)?.length ?? 0) === 0) {
      this.addEmbedding(placeholder, u);
      this.speakers.get(placeholder)!.utterances++;
      return { speakerId: placeholder, inferred: false };
    }
    // The stream already has all the voices it can carry: the closest one, without adding this line to its voiceprint.
    const limit = this.limits[stream] ?? 0;
    if (limit > 0 && onStream.length >= limit) {
      const id = best?.id ?? this.resolve(last ?? onStream[0]!);
      this.speakers.get(id)!.utterances++;
      this.lastOnStream.set(stream, id);
      return { speakerId: id, inferred: false };
    }
    const created = this.create(stream, [u]);
    return { speakerId: created.id, inferred: false, created };
  }

  /** Active speakers heard on a stream. */
  private onStream(stream: StreamName): string[] {
    return [...this.speakers.values()].filter((s) => !s.mergedInto && this.streams.get(s.id)?.has(stream)).map((s) => s.id);
  }

  private create(stream: StreamName, vs: Float32Array[]): Speaker {
    const n = ++this.n;
    const s: Speaker = { id: `spk_${n}`, displayName: `Speaker ${n}`, utterances: 1 };
    this.speakers.set(s.id, s);
    this.embeddings.set(s.id, []);
    this.streams.set(s.id, new Set([stream]));
    for (const v of vs) this.addEmbedding(s.id, v);
    this.lastOnStream.set(stream, s.id);
    return s;
  }

  private addEmbedding(id: string, v: Float32Array): void {
    const list = [...(this.embeddings.get(id) ?? []), v].slice(-this.cfg.maxEmbeddingsPerSpeaker);
    this.embeddings.set(id, list);
    this.recompute(id);
  }

  private recompute(id: string): void {
    const list = this.embeddings.get(id) ?? [];
    if (list.length === 0) { this.centroids.delete(id); return; }
    const sum = new Float32Array(list[0]!.length);
    for (const v of list) for (let i = 0; i < v.length; i++) sum[i]! += v[i]!;
    this.centroids.set(id, unit(sum));
  }

  /** Each active speaker's current voiceprint, for merge suggestions. */
  voiceprints(): Voiceprint[] {
    return this.active().map((s) => ({
      id: s.id, name: s.displayName, streams: [...(this.streams.get(s.id) ?? [])],
      centroid: this.centroids.get(s.id) ?? null, sampled: this.embeddings.get(s.id)?.length ?? 0, lines: s.utterances, talkMs: 0,
    }));
  }

  /** Follows merges to the surviving speaker id. */
  resolve(id: string): string {
    let cur = id;
    for (let s = this.speakers.get(cur); s?.mergedInto; s = this.speakers.get(cur)) cur = s.mergedInto;
    return cur;
  }

  get(id: string): Speaker | undefined {
    return this.speakers.get(this.resolve(id));
  }

  displayName(id: string): string {
    return this.get(id)?.displayName ?? id;
  }

  rename(id: string, displayName: string): Speaker {
    const s = this.get(id);
    if (!s) throw new Error(`unknown speaker ${id}`);
    const name = displayName.trim();
    if (!name) throw new Error("displayName must not be empty");
    s.displayName = name;
    return s;
  }

  merge(fromId: string, intoId: string): Speaker {
    const from = this.resolve(fromId);
    const into = this.resolve(intoId);
    if (!this.speakers.has(from) || !this.speakers.has(into)) throw new Error("unknown speaker");
    if (from === into) throw new Error("cannot merge a speaker into itself");
    const moved = this.embeddings.get(from) ?? [];
    this.embeddings.set(into, [...(this.embeddings.get(into) ?? []), ...moved].slice(-this.cfg.maxEmbeddingsPerSpeaker));
    this.embeddings.set(from, []);
    this.centroids.delete(from);
    this.recompute(into);
    for (const st of this.streams.get(from) ?? []) this.streams.get(into)?.add(st);
    const target = this.speakers.get(into)!;
    const source = this.speakers.get(from)!;
    target.utterances += source.utterances;
    source.mergedInto = into;
    return target;
  }

  /** Every speaker ever created, merged ones included (they carry mergedInto). */
  list(): Speaker[] {
    return [...this.speakers.values()].map((s) => ({ ...s }));
  }

  active(): Speaker[] {
    return this.list().filter((s) => !s.mergedInto);
  }
}
