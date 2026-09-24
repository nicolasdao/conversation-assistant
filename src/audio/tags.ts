import type { StreamName } from "./source.ts";

export type Tag = "loud" | "overlap";

export function rmsDbfs(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** `loud`: the utterance's RMS is at least 6 dB above the median of that stream's last 50 utterances. */
export class LoudTagger {
  private history = new Map<StreamName, number[]>();

  tag(stream: StreamName, samples: Float32Array): boolean {
    const db = rmsDbfs(samples);
    const h = this.history.get(stream) ?? [];
    const loud = h.length > 0 && Number.isFinite(db) && db >= median(h) + 6;
    if (Number.isFinite(db)) {
      h.push(db);
      if (h.length > 50) h.shift();
    }
    this.history.set(stream, h);
    return loud;
  }
}

export interface TimeRange { stream: StreamName; startMs: number; endMs: number }

/** `overlap`: the range overlaps an utterance on the other stream by at least minMs. */
export function overlaps(u: TimeRange, others: Iterable<TimeRange>, minMs = 1000): boolean {
  for (const o of others) {
    if (o.stream === u.stream) continue;
    if (Math.min(u.endMs, o.endMs) - Math.max(u.startMs, o.startMs) >= minMs) return true;
  }
  return false;
}
