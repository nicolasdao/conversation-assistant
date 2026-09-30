import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { HelperProcess } from "../../src/audio/nativeSource.ts";
import type { AudioFrame } from "../../src/audio/source.ts";

export function frameBytes(stream: 0 | 1, sessionMs: number, samples: number[]): Buffer {
  const b = Buffer.alloc(20 + samples.length * 2);
  b.write("PCAP", 0, "ascii");
  b[4] = stream;
  b.writeDoubleLE(sessionMs, 8);
  b.writeUInt32LE(samples.length, 16);
  samples.forEach((s, i) => b.writeInt16LE(s, 20 + 2 * i));
  return b;
}

export const ramp = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ((from + i) % 2000) - 1000);

export async function take(src: { frames(): AsyncIterable<AudioFrame> }, n: number): Promise<AudioFrame[]> {
  const out: AudioFrame[] = [];
  if (n === 0) return out;
  for await (const f of src.frames()) {
    out.push(f);
    if (out.length >= n) break;
  }
  return out;
}

export async function all(src: { frames(): AsyncIterable<AudioFrame> }): Promise<AudioFrame[]> {
  const out: AudioFrame[] = [];
  for await (const f of src.frames()) out.push(f);
  return out;
}

export class FakeHelper extends EventEmitter implements HelperProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  killed: string[] = [];
  constructor() {
    super();
    this.stdin.on("finish", () => this.exit(0));
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed.push(signal);
    this.exit(null, signal);
    return true;
  }
  started(epochMs: number) {
    this.stderr.write(JSON.stringify({ type: "started", epochMs, host: { device: "MacBook Air Microphone" }, remote: { outputDevice: "AirPods" } }) + "\n");
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    setImmediate(() => this.emit("exit", code, signal));
  }
}
