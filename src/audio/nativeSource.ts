import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { FRAME_SAMPLES, type AudioFrame, type AudioSource, type StreamName } from "./source.ts";
import { appPaths } from "../paths.ts";
import { childEnv } from "../keys.ts";

const HEADER = 20;
const MAX_SAMPLES = 16_000 * 10; // a frame longer than 10 s is impossible: the helper sends 1,600

export interface HelperFrame { stream: StreamName; sessionMs: number; samples: Int16Array }

export class MalformedFrameError extends Error {}

/** Parses the helper's stdout protocol, buffering partial reads (§4.14a). */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): HelperFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: HelperFrame[] = [];
    while (this.buf.length >= HEADER) {
      if (this.buf.toString("ascii", 0, 4) !== "PCAP") throw new MalformedFrameError("bad magic");
      const s = this.buf[4];
      if (s !== 0 && s !== 1) throw new MalformedFrameError(`bad stream ${s}`);
      const sessionMs = this.buf.readDoubleLE(8);
      const n = this.buf.readUInt32LE(16);
      if (n === 0 || n > MAX_SAMPLES || !Number.isFinite(sessionMs) || sessionMs < 0) throw new MalformedFrameError(`impossible frame (n ${n}, sessionMs ${sessionMs})`);
      if (this.buf.length < HEADER + 2 * n) break;
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = this.buf.readInt16LE(HEADER + 2 * i);
      out.push({ stream: s === 0 ? "host" : "remote", sessionMs, samples });
      this.buf = this.buf.subarray(HEADER + 2 * n);
    }
    return out;
  }
}

/** An AudioSource fed by pushes: re-chunks into 512-sample Float32 frames on a continuous clock, filling gaps with silence. */
export class LiveStream implements AudioSource {
  private queue: AudioFrame[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private pending: number[] = [];
  /** sessionMs of the next sample to emit. */
  private nextMs: number | null = null;

  constructor(readonly stream: StreamName) {}

  /** Samples whose first sample sits at sessionMs (already on the session clock). */
  push(samples: Int16Array, sessionMs: number): void {
    if (this.ended) return;
    let start = 0;
    if (this.nextMs === null) this.nextMs = sessionMs;
    const gapSamples = Math.round((sessionMs - this.nextMs) * 16);
    if (gapSamples > 0) {
      for (let i = 0; i < gapSamples; i++) this.pending.push(0); // a gap (helper restart) stays as silence
    } else if (gapSamples < 0) {
      start = Math.min(samples.length, -gapSamples); // overlap: drop what is already on the clock
    }
    for (let i = start; i < samples.length; i++) this.pending.push(samples[i] / (samples[i] < 0 ? 32768 : 32767));
    this.nextMs = sessionMs + samples.length / 16;
    while (this.pending.length >= FRAME_SAMPLES) {
      const chunk = this.pending.splice(0, FRAME_SAMPLES);
      const frameMs = this.nextMs - (this.pending.length + FRAME_SAMPLES) / 16;
      this.queue.push({ samples: Float32Array.from(chunk), sessionMs: frameMs });
    }
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *frames(): AsyncIterable<AudioFrame> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => { this.waiter = r; });
    }
  }
}

export interface HelperProcess {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  exitCode: number | null;
}

export type CaptureStatus = { type: string; [k: string]: unknown };

export interface NativeCaptureOptions {
  mic?: string;
  host?: boolean;
  remote?: boolean;
  bin?: string;
  spawn?: (bin: string, args: string[]) => HelperProcess;
  /** Session clock zero (epoch ms); defaults to now. */
  sessionStartEpochMs?: number;
  /** Status lines, restarts, and failures; `error` and `warning` become `error` events with component "capture". */
  onStatus?: (type: "error" | "health", data: Record<string, unknown>) => void;
  restartDelayMs?: number;
  maxRestarts?: number;
}

export interface NativeCapture {
  sources: AudioSource[];
  /** The latest status line (device names), for health details. */
  status(): CaptureStatus | null;
  stop(): Promise<void>;
  /** Resolves when the helper has exited for good. */
  done: Promise<void>;
}

/** Spawns conversation-capture and exposes its two streams as AudioSources (§4.14b). */
export function startNativeCapture(opts: NativeCaptureOptions = {}): Promise<NativeCapture> {
  const bin = opts.bin ?? appPaths().helper;
  const spawn = opts.spawn ?? ((b: string, a: string[]) => nodeSpawn(b, a, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() }) as unknown as HelperProcess);
  if (!opts.spawn && !existsSync(bin)) return Promise.reject(new Error(`the capture helper is not built: run npm run build:capture (${bin})`));
  const useHost = opts.host ?? true;
  const useRemote = opts.remote ?? true;
  const sessionStart = opts.sessionStartEpochMs ?? Date.now();
  const maxRestarts = opts.maxRestarts ?? 3;
  const restartDelayMs = opts.restartDelayMs ?? 1000;
  const streams = new Map<StreamName, LiveStream>();
  if (useHost) streams.set("host", new LiveStream("host"));
  if (useRemote) streams.set("remote", new LiveStream("remote"));
  const args = [...(opts.mic ? ["--mic", opts.mic] : []), ...(useHost ? [] : ["--no-mic"]), ...(useRemote ? [] : ["--no-system"])];

  let child: HelperProcess | null = null;
  let stopping = false;
  let restarts = 0;
  let lastStatus: CaptureStatus | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const emitError = (message: string, extra: Record<string, unknown> = {}) => opts.onStatus?.("error", { component: "capture", message, ...extra });

  const endAll = () => {
    for (const s of streams.values()) s.end();
    resolveDone();
  };

  const launch = () => {
    const proc = spawn(bin, args);
    child = proc;
    const parser = new FrameParser();
    let offsetMs: number | null = null;
    let held: HelperFrame[] = [];
    let errBuf = "";
    const deliver = (f: HelperFrame) => streams.get(f.stream)?.push(f.samples, f.sessionMs + offsetMs!);

    proc.stdout.on("data", (chunk: Buffer) => {
      if (proc !== child) return;
      let frames: HelperFrame[];
      try {
        frames = parser.push(chunk);
      } catch (e) {
        emitError(`malformed frame from the capture helper: ${(e as Error).message}`);
        proc.kill("SIGKILL"); // handled as a crash
        return;
      }
      for (const f of frames) {
        if (offsetMs === null) held.push(f);
        else deliver(f);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      errBuf += chunk.toString("utf8");
      let i: number;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (!line) continue;
        let st: CaptureStatus;
        try {
          st = JSON.parse(line);
        } catch {
          st = { type: "warning", message: line };
        }
        lastStatus = st;
        if (st.type === "started" && typeof st.epochMs === "number") {
          offsetMs = st.epochMs - sessionStart; // helper time → session clock, recomputed after each restart
          for (const f of held) deliver(f);
          held = [];
          opts.onStatus?.("health", { capture: st });
        } else if (st.type === "error" || st.type === "warning") {
          emitError(String(st.message ?? line), { level: st.type });
        } else {
          opts.onStatus?.("health", { capture: st });
        }
      }
    });
    proc.on("exit", (code, signal) => {
      if (proc !== child) return;
      if (stopping) return endAll();
      if (restarts >= maxRestarts) {
        emitError(`the capture helper exited (code ${code}, signal ${signal}) after ${maxRestarts} restarts; ending live capture`);
        return endAll();
      }
      restarts++;
      emitError(`the capture helper exited (code ${code}, signal ${signal}); restart ${restarts} of ${maxRestarts} in ${restartDelayMs} ms`);
      setTimeout(() => { if (!stopping) launch(); else endAll(); }, restartDelayMs);
    });
  };

  launch();

  const stop = async () => {
    if (stopping) return done;
    stopping = true;
    const proc = child;
    if (!proc || proc.exitCode !== null) {
      endAll();
      return done;
    }
    proc.stdin.end(); // the helper stops when stdin closes
    const term = setTimeout(() => proc.kill("SIGTERM"), 2000);
    const kill = setTimeout(() => proc.kill("SIGKILL"), 5000);
    await done;
    clearTimeout(term);
    clearTimeout(kill);
  };

  return Promise.resolve({ sources: [...streams.values()], status: () => lastStatus, stop, done });
}

/** GET /api/devices: the helper's --list-devices output. */
export function listDevices(bin = appPaths().helper): Promise<unknown[]> {
  if (!existsSync(bin)) return Promise.reject(new Error("the capture helper is not built: run npm run build:capture"));
  return new Promise((resolve, reject) => {
    const p: ChildProcess = nodeSpawn(bin, ["--list-devices"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    let out = "";
    p.stdout!.on("data", (c) => (out += c));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`conversation-capture --list-devices exited with ${code}`));
      resolve(out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
    });
  });
}
