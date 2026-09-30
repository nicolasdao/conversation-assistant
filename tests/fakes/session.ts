// Builders for Session tests (tests/sessionUnit.test.ts): audio sources a test controls, scripted services, and a
// small session factory with fakes everywhere (no model but Silero, no network, a tmp sessions folder).
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { FRAME_SAMPLES, type AudioFrame, type AudioSource, type StreamName } from "../../src/audio/source.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import { Session, type Services, type SessionOptions } from "../../src/pipeline/session.ts";
import type { Embedder } from "../../src/speakers/registry.ts";
import type { HelperProcess } from "../../src/transcribe/apple.ts";
import type { TranscriptionResult } from "../../src/transcribe/openai.ts";
import { strictBus } from "./bus.ts";
import { FakeEmbedder } from "./embedder.ts";
import { tmpDir } from "./env.ts";

/** Plays `samples` as 512-sample frames from `startMs`; with `throwAfter`, throws instead of yielding that frame. */
export class SamplesSource implements AudioSource {
  constructor(readonly stream: StreamName, private readonly samples: Float32Array, private readonly opts: { startMs?: number; throwAfter?: number } = {}) {}
  async *frames(): AsyncGenerator<AudioFrame> {
    for (let off = 0, i = 0; off < this.samples.length; off += FRAME_SAMPLES, i++) {
      if (this.opts.throwAfter !== undefined && i >= this.opts.throwAfter) throw new Error("the source broke");
      const s = new Float32Array(FRAME_SAMPLES);
      s.set(this.samples.subarray(off, off + FRAME_SAMPLES));
      yield { samples: s, sessionMs: (this.opts.startMs ?? 0) + (i * FRAME_SAMPLES * 1000) / 16_000 };
    }
  }
}

/** A source the test feeds frame by frame (`push`), then ends; its clock advances 32 ms per frame. */
export class PushSource implements AudioSource {
  private readonly queue: (AudioFrame | null)[] = [];
  private wake: (() => void) | null = null;
  private ms = 0;
  /** Frames the session has taken so far. */
  taken = 0;
  constructor(readonly stream: StreamName) {}
  /** Queues `samples` as whole 512-sample frames (the last one zero-padded). */
  push(samples: Float32Array = new Float32Array(FRAME_SAMPLES)): void {
    for (let off = 0; off < samples.length; off += FRAME_SAMPLES) {
      const s = new Float32Array(FRAME_SAMPLES);
      s.set(samples.subarray(off, off + FRAME_SAMPLES));
      this.queue.push({ samples: s, sessionMs: this.ms });
      this.ms += 32;
    }
    this.wake?.();
  }
  end(): void {
    this.queue.push(null);
    this.wake?.();
  }
  async *frames(): AsyncGenerator<AudioFrame> {
    for (;;) {
      while (this.queue.length === 0) await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
      const f = this.queue.shift()!;
      if (f === null) return;
      this.taken++;
      yield f;
    }
  }
}

/** Services with a scripted transcription (default: every line says "words said here") and a Jev that is never asked. */
export function scriptedServices(transcribe?: Services["transcribe"], ask?: Services["ask"]): () => Services {
  return () => ({
    transcribe: transcribe ?? (async () => ({ ok: true, text: "words said here", filler: false }) as TranscriptionResult),
    ask: ask ?? (async () => { throw new Error("Jev is not asked in this test"); }),
    s2: {} as never,
  });
}

/**
 * A Session on fakes: a tmp sessions folder, a strict bus (every schema failure is collected in `invalid`), a fake
 * embedder, scripted services, and both features off unless `opts` says otherwise.
 */
export function makeSession(opts: Partial<SessionOptions> = {}, config: Config = loadConfig()) {
  const { bus, invalid } = strictBus();
  const s = new Session({
    mode: "replay", config, bus, sessionsDir: tmpDir("sessions-"), embedder: new FakeEmbedder() as unknown as Embedder,
    services: scriptedServices(), features: { factcheck: false, labels: false },
    sources: [new SamplesSource("host", new Float32Array(0))],
    ...opts,
  });
  const events = () => bus.history();
  const of = (type: string) => bus.history().filter((e) => e.type === type).map((e) => e.data as any);
  return { s, bus, invalid, events, of };
}

/** The tattle-transcribe helper as a child process: records its args and what it was sent; `line()` answers. */
export class FakeAppleHelper extends EventEmitter implements HelperProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  received = Buffer.alloc(0);
  constructor(readonly args: string[]) {
    super();
    this.stdin.on("data", (d: Buffer) => { this.received = Buffer.concat([this.received, d]); });
    this.stdin.on("finish", () => this.exit(0));
  }
  line(obj: unknown) { this.stdout.write(JSON.stringify(obj) + "\n"); }
  kill() { this.exit(null, "SIGTERM"); return true; }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    setImmediate(() => this.emit("exit", code, signal));
  }
}
