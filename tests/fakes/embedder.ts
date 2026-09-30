/** A unit vector mostly along axis `k`, with `mix` of axis `k2`: cosine(vec(k), vec(k, m)) ≈ 1/√(1+m²). */
export function vec(k: number, mix = 0, dim = 64, k2 = (k + 1) % dim): Float32Array {
  const v = new Float32Array(dim).map((_, i) => (i === k ? 1 : i === k2 ? mix : 0));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/**
 * Stands in for the WeSpeaker `Embedder`: returns queued vectors in order, or else derives an axis from the clip's
 * mean, so equal clips get equal voices. Records every clip it was given.
 */
export class FakeEmbedder {
  readonly clips: Float32Array[] = [];
  constructor(readonly dim = 64, private readonly queue: Float32Array[] = []) {}
  embed(samples: Float32Array): Float32Array {
    this.clips.push(samples);
    const next = this.queue.shift();
    if (next) return next;
    const mean = samples.reduce((a, x) => a + Math.abs(x), 0) / Math.max(1, samples.length);
    return vec(Math.floor(mean * 1000) % this.dim, 0, this.dim);
  }
}
