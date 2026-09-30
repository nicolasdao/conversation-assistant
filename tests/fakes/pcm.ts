import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav, readWav16k } from "../../src/audio/wav.ts";
import { FIXTURE_DIR } from "../helpers.ts";

/** A sine at `amp`, `n` samples (16 kHz, about 2.5 kHz at the default period). */
export const sine = (amp: number, n = 512, period = 6): Float32Array => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * i) / period));
export const silence = (n = 512): Float32Array => new Float32Array(n);
export const constant = (v: number, n = 512): Float32Array => new Float32Array(n).fill(v);

/** Writes samples as a 16-bit WAV in `dir` and returns its path. */
export function wavFile(dir: string, samples: Float32Array, name = "a.wav", rate = 16_000): string {
  const p = join(dir, name);
  writeFileSync(p, encodeWav(samples, rate));
  return p;
}

/** A slice of a fixture track (16 kHz), for fast tests with the real VAD. */
export function fixtureSlice(stream: "host" | "remote", fromMs: number, toMs: number): Float32Array {
  return readWav16k(`${FIXTURE_DIR}/${stream}.wav`).subarray(Math.round(fromMs * 16), Math.round(toMs * 16));
}
