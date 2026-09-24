import sherpa, { type SpeakerEmbeddingExtractor, type SpeakerEmbeddingManager } from "sherpa-onnx-node";
import type { AppConfig } from "../config.ts";
import type { StreamName } from "../audio/source.ts";
import { SAMPLE_RATE } from "../audio/wav.ts";

export const SPEAKER_MODEL = "models/wespeaker_en_voxceleb_resnet34_LM.onnx";

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

  constructor(modelPath = SPEAKER_MODEL) {
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

/** One speaker registry shared by both streams (§4.4). */
export class SpeakerRegistry {
  private readonly manager: SpeakerEmbeddingManager;
  private readonly speakers = new Map<string, Speaker>();
  private readonly embeddings = new Map<string, Float32Array[]>();
  private readonly lastOnStream = new Map<StreamName, string>();
  private n = 0;

  constructor(private readonly cfg: AppConfig["speakers"], private readonly embedder: Embedder) {
    this.manager = new sherpa.SpeakerEmbeddingManager(embedder.dim);
  }

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
    const found = this.manager.search({ v, threshold });
    if (found) {
      const id = this.resolve(found);
      this.addEmbedding(id, v);
      this.speakers.get(id)!.utterances++;
      this.lastOnStream.set(stream, id);
      return { speakerId: id, inferred: false };
    }
    const created = this.create(stream, [v]);
    return { speakerId: created.id, inferred: false, created };
  }

  private create(stream: StreamName, vs: Float32Array[]): Speaker {
    const n = ++this.n;
    const s: Speaker = { id: `spk_${n}`, displayName: `Speaker ${n}`, utterances: 1 };
    this.speakers.set(s.id, s);
    this.embeddings.set(s.id, []);
    for (const v of vs) this.addEmbedding(s.id, v);
    this.lastOnStream.set(stream, s.id);
    return s;
  }

  private addEmbedding(id: string, v: Float32Array): void {
    const list = [...(this.embeddings.get(id) ?? []), v].slice(-this.cfg.maxEmbeddingsPerSpeaker);
    this.embeddings.set(id, list);
    this.register(id);
  }

  private register(id: string): void {
    if (this.manager.contains(id)) this.manager.remove(id);
    const list = this.embeddings.get(id) ?? [];
    if (list.length > 0) this.manager.addMulti({ name: id, v: list });
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
    if (this.manager.contains(from)) this.manager.remove(from);
    this.register(into);
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
