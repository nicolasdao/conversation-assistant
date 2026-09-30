import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AudioFrame, AudioSource, StreamName } from "../../src/audio/source.ts";

/**
 * An AudioSource that yields preset frames (each `[sessionMs, samples]`), then ends; with `throwAfter`, it throws
 * after that many frames instead of ending.
 */
export class ArraySource implements AudioSource {
  constructor(readonly stream: StreamName, private readonly items: [number, Float32Array][], private readonly throwAfter?: number) {}

  async *frames(): AsyncIterable<AudioFrame> {
    let n = 0;
    for (const [sessionMs, samples] of this.items) {
      if (this.throwAfter !== undefined && n >= this.throwAfter) throw new Error(`source ${this.stream} failed`);
      yield { sessionMs, samples };
      n++;
    }
    if (this.throwAfter !== undefined && n >= this.throwAfter) throw new Error(`source ${this.stream} failed`);
  }
}

/** Frames of 512 samples at the given session times (each filled with `fill`). */
export const framesAt = (times: number[], fill = 0.1): [number, Float32Array][] => times.map((t) => [t, new Float32Array(512).fill(fill)]);

/** Writes an executable `#!/bin/sh` script in `dir` (a tmp folder) and returns its path: a stand-in for a helper binary. */
export function shellBin(dir: string, body: string, name = "helper"): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * A scripted stand-in for sherpa's Vad: records every window it is fed; `segments` are popped in order by `front`/`pop`
 * once `release()` (or the constructor's `ready`) makes them available. `flush` is optional, as in the typings.
 */
export class FakeVad {
  fed: Float32Array[] = [];
  detected = false;
  flushes = 0;
  private queue: { start: number; samples: Float32Array }[] = [];
  flush?: () => void;

  constructor(withFlush = true) {
    if (withFlush) this.flush = () => { this.flushes++; };
  }

  acceptWaveform(samples: Float32Array) { this.fed.push(samples); }
  isDetected() { return this.detected; }
  isEmpty() { return this.queue.length === 0; }
  front() { return this.queue[0]; }
  pop() { this.queue.shift(); }
  /** Makes a segment starting at sample `start` (relative to the stream's first frame) with `n` samples ready. */
  segment(start: number, n: number, fill = 0.2) { this.queue.push({ start, samples: new Float32Array(n).fill(fill) }); }
}
