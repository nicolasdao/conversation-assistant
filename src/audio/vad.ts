import sherpa, { type Vad } from "sherpa-onnx-node";
import type { AppConfig } from "../config.ts";
import { FRAME_SAMPLES, type StreamName } from "./source.ts";
import { SAMPLE_RATE } from "./wav.ts";

export interface Utterance {
  id: string;
  stream: StreamName;
  startMs: number;
  endMs: number;
  samples: Float32Array;
}

/** One session-wide utterance counter, shared by every stream. */
export class UtteranceIds {
  private n = 0;
  next(): string {
    return `u_${++this.n}`;
  }
}

/** One Silero VAD per stream (§4.3). */
export class StreamVad {
  private readonly vad: Vad;
  private streamStartMs: number | null = null;
  private pending = new Float32Array(0);
  /** sessionMs of the last frame given to the VAD. */
  watermark = -Infinity;
  ended = false;

  constructor(
    readonly stream: StreamName,
    private readonly cfg: AppConfig["vad"],
    private readonly ids: UtteranceIds,
    modelPath = "models/silero_vad.onnx",
  ) {
    this.vad = new sherpa.Vad({
      sileroVad: {
        model: modelPath, threshold: cfg.threshold, minSpeechDuration: cfg.minSpeechDuration,
        minSilenceDuration: cfg.minSilenceDuration, maxSpeechDuration: cfg.maxSpeechDuration, windowSize: FRAME_SAMPLES,
      },
      sampleRate: SAMPLE_RATE, numThreads: 1, debug: false,
    }, 60);
  }

  /** Feeds one frame; returns the utterances it completed. */
  accept(samples: Float32Array, sessionMs: number): Utterance[] {
    if (this.streamStartMs === null) this.streamStartMs = sessionMs;
    this.watermark = sessionMs;
    // Feed exact 512-sample windows, carrying any remainder to the next frame.
    let buf = samples;
    if (this.pending.length > 0) {
      buf = new Float32Array(this.pending.length + samples.length);
      buf.set(this.pending);
      buf.set(samples, this.pending.length);
    }
    let off = 0;
    for (; off + FRAME_SAMPLES <= buf.length; off += FRAME_SAMPLES) this.vad.acceptWaveform(buf.slice(off, off + FRAME_SAMPLES));
    this.pending = buf.slice(off);
    return this.drain();
  }

  isDetected(): boolean {
    return !this.ended && this.vad.isDetected();
  }

  /** End of stream: flush the VAD (or feed 1 s of silence when flush is missing). */
  flush(): Utterance[] {
    if (this.ended) return [];
    if (typeof this.vad.flush === "function") {
      this.vad.flush();
    } else {
      const silence = new Float32Array(FRAME_SAMPLES);
      for (let i = 0; i < SAMPLE_RATE / FRAME_SAMPLES + 1; i++) this.vad.acceptWaveform(silence);
    }
    const out = this.drain();
    this.ended = true;
    this.watermark = Infinity;
    return out;
  }

  private drain(): Utterance[] {
    const out: Utterance[] = [];
    const maxSamples = this.cfg.maxSpeechDuration * SAMPLE_RATE;
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false);
      this.vad.pop();
      const base = (this.streamStartMs ?? 0) + (seg.start * 1000) / SAMPLE_RATE;
      // Split in code if the native maxSpeechDuration is ever ignored (§6 row 7).
      for (let off = 0; off < seg.samples.length; off += maxSamples) {
        const samples = seg.samples.slice(off, off + maxSamples);
        const startMs = base + (off * 1000) / SAMPLE_RATE;
        out.push({ id: this.ids.next(), stream: this.stream, startMs, endMs: startMs + (samples.length * 1000) / SAMPLE_RATE, samples });
      }
    }
    return out;
  }
}
