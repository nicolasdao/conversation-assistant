import { closeSync, openSync, writeSync } from "node:fs";
import sherpa from "sherpa-onnx-node";

export const SAMPLE_RATE = 16_000;

export function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);          // fmt chunk size
  h.writeUInt16LE(1, 20);           // PCM
  h.writeUInt16LE(1, 22);           // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);           // block align
  h.writeUInt16LE(16, 34);          // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function toPcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return out;
}

/** An in-memory PCM16 mono WAV, for uploads. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const pcm = toPcm16(samples);
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}

/** Reads any WAV sherpa can read, resampled to 16 kHz mono Float32. */
export function readWav16k(path: string): Float32Array {
  const wave = sherpa.readWave(path);
  if (wave.sampleRate === SAMPLE_RATE) return wave.samples;
  return new sherpa.LinearResampler(wave.sampleRate, SAMPLE_RATE).flush(wave.samples);
}

/** A streaming PCM16 mono WAV writer for session recordings. Every write is flushed; close() patches the header. */
export class WavWriter {
  private fd: number | null;
  private dataBytes = 0;

  constructor(readonly path: string, private readonly sampleRate = SAMPLE_RATE) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, wavHeader(0, sampleRate));
  }

  write(samples: Float32Array): void {
    if (this.fd === null) return;
    const pcm = toPcm16(samples);
    writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  get samplesWritten(): number {
    return this.dataBytes / 2;
  }

  close(): void {
    if (this.fd === null) return;
    writeSync(this.fd, wavHeader(this.dataBytes, this.sampleRate), 0, 44, 0);
    closeSync(this.fd);
    this.fd = null;
  }
}
