import { SAMPLE_RATE, readWav16k } from "./wav.ts";

export type StreamName = "host" | "remote";
export const FRAME_SAMPLES = 512;

export interface AudioFrame { samples: Float32Array; sessionMs: number }

export interface AudioSource {
  stream: StreamName;
  frames(): AsyncIterable<AudioFrame>; // 16 kHz mono, 512-sample frames
}

export type Speed = 1 | "max";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Plays a WAV file as 512-sample frames. A frame's sessionMs is its sample offset, so every file shares clock zero. */
export class FileSource implements AudioSource {
  constructor(readonly path: string, readonly stream: StreamName, readonly speed: Speed, private readonly now = () => performance.now()) {}

  async *frames(): AsyncIterable<AudioFrame> {
    const samples = readWav16k(this.path);
    const t0 = this.now();
    for (let off = 0; off < samples.length; off += FRAME_SAMPLES) {
      const sessionMs = (off * 1000) / SAMPLE_RATE;
      if (this.speed === 1) {
        const wait = t0 + sessionMs - this.now();
        if (wait > 1) await sleep(wait);
      }
      let frame = samples.subarray(off, off + FRAME_SAMPLES);
      if (frame.length < FRAME_SAMPLES) {
        const padded = new Float32Array(FRAME_SAMPLES);
        padded.set(frame);
        frame = padded;
      }
      yield { samples: frame, sessionMs };
    }
  }
}

export interface TaggedFrame extends AudioFrame { stream: StreamName }

/**
 * Merges sources frame by frame in sessionMs order, so files at speed "max" stay aligned across streams.
 * Calls onEnd(stream) when a source ends.
 */
export async function* mergeSources(sources: AudioSource[], onEnd?: (s: StreamName) => void): AsyncIterable<TaggedFrame> {
  if (sources.length === 0) throw new Error("at least one audio source is required");
  const its = sources.map((s) => ({ stream: s.stream, it: s.frames()[Symbol.asyncIterator]() }));
  const heads = await Promise.all(its.map((x) => x.it.next()));
  const live = its.map((x, i) => ({ ...x, head: heads[i] }));
  for (const x of live) if (x.head.done) onEnd?.(x.stream);
  let active = live.filter((x) => !x.head.done);
  while (active.length > 0) {
    let min = active[0];
    for (const x of active) if ((x.head.value as AudioFrame).sessionMs < (min.head.value as AudioFrame).sessionMs) min = x;
    const frame = min.head.value as AudioFrame;
    yield { ...frame, stream: min.stream };
    min.head = await min.it.next();
    if (min.head.done) {
      onEnd?.(min.stream);
      active = active.filter((x) => x !== min);
    }
  }
}
