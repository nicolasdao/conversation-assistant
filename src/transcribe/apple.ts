import { spawn as nodeSpawn, execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AppConfig } from "../config.ts";
import type { StreamName } from "../audio/source.ts";
import { SAMPLE_RATE } from "../audio/wav.ts";
import { childEnv } from "../keys.ts";
import { appPaths } from "../paths.ts";
import type { LivePartial } from "./live.ts";
import { applyFixes, isFiller, MIN_AUDIO_SECONDS, type TranscriptionResult, type TranscriptionRow } from "./openai.ts";

/**
 * On-device transcription with Apple Speech (macOS 26+), through the tattle-transcribe helper (see docs/transcription.md).
 * Final text comes from one clip per utterance, cut here with some audio either side of the VAD's edges and transcribed
 * by its own short-lived analyzer in the helper. Live text comes from one analyzer per stream that hears every frame
 * and is never finalized mid-stream: Phase 0 showed that finalize(through:) drops the words that follow it. Audio goes
 * to the helper only for live text: at --speed max it arrives faster than the helper reads it, and a clip queued behind
 * it would wait. Nothing is sent off the Mac and nothing is spent.
 */

const STREAM_INDEX: Record<StreamName, number> = { host: 0, remote: 1 };
const MAGIC = Buffer.from("PTRX");

export type AppleConfig = AppConfig["transcription"]["apple"];

/** A line's place in its stream, so its clip can be cut with padding around the VAD's edges. */
export interface Span { stream: StreamName; startMs: number; endMs: number }

// ---------- frames (engine → helper), little-endian ----------

function header(kind: number, stream: number): Buffer {
  const b = Buffer.alloc(8);
  MAGIC.copy(b, 0);
  b[4] = kind;
  b[5] = stream;
  return b;
}

function pcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return out;
}

/** Kind 0: audio. `startMs` is the session time of the first sample. */
export function audioFrame(stream: StreamName, startMs: number, samples: Float32Array): Buffer {
  const h = Buffer.alloc(12);
  h.writeDoubleLE(startMs, 0);
  h.writeUInt32LE(samples.length, 8);
  return Buffer.concat([header(0, STREAM_INDEX[stream]), h, pcm16(samples)]);
}

/**
 * Kind 3: one line's clip, in a file the helper reads and deletes. A clip is larger than a pipe holds, so on stdin a
 * busy engine (a --speed max replay) delivered it over several turns of its event loop: 40 clips took 49 s with 50 ms
 * turns, 139 s with 200 ms turns, 21 s with 5 ms turns (measured). A file is written at once.
 */
export function clipFileFrame(id: string, path: string): Buffer {
  const idb = Buffer.from(id, "utf8");
  const pb = Buffer.from(path, "utf8");
  const a = Buffer.alloc(4);
  a.writeUInt32LE(idb.length, 0);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(pb.length, 0);
  return Buffer.concat([header(3, 0), a, idb, n, pb]);
}

/** Kind 2: one line's clip on stdin (the helper's test script uses it; kind 1 is retired). */
export function clipFrame(id: string, samples: Float32Array): Buffer {
  const idb = Buffer.from(id, "utf8");
  const a = Buffer.alloc(4);
  a.writeUInt32LE(idb.length, 0);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(samples.length, 0);
  return Buffer.concat([header(2, 0), a, idb, n, pcm16(samples)]);
}

// ---------- the last minute of each stream, to cut clips from ----------

/** A line is at most 30 s (vad.maxSpeechDuration), and is transcribed about 0.5 s after it ends: a minute is plenty. */
const KEEP_SAMPLES = 60 * SAMPLE_RATE;

export class AudioRing {
  private chunks: { start: number; data: Float32Array }[] = [];
  private end = 0;

  /** `start`: the session sample index of the first sample. */
  append(start: number, data: Float32Array) {
    this.chunks.push({ start, data });
    this.end = start + data.length;
    while (this.chunks.length > 1 && this.end - (this.chunks[1].start) >= KEEP_SAMPLES) this.chunks.shift();
  }

  /** Samples [from, to), clamped to what is held; null when none of it is. Gaps (none in practice) stay silent. */
  cut(from: number, to: number): Float32Array | null {
    const first = this.chunks[0]?.start ?? Infinity;
    const a = Math.max(from, first);
    const b = Math.min(to, this.end);
    if (b <= a) return null;
    const out = new Float32Array(b - a);
    for (const c of this.chunks) {
      const s = Math.max(a, c.start);
      const e = Math.min(b, c.start + c.data.length);
      if (e > s) out.set(c.data.subarray(s - c.start, e - c.start), s - a);
    }
    return out;
  }
}

// ---------- live text ----------

export interface Run { text: string; startMs: number; endMs: number }

/** Word ends are reliable; a word's start is stretched back over the pause before it, so only ends are compared. */
const END_MARGIN_MS = 100;
const COMMIT_SLACK_MS = 150;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * One stream's live text: its settled (final) runs not yet handed to a finished line, then its unsettled (volatile)
 * text. A volatile result is one run over its whole unsettled range, with no word times, and it lags the speech by a
 * second or two: when the VAD closes a line, its last words are not in it yet, and they arrive with the next line's.
 * So each closed line remembers how many words of the unsettled text are its own, first as many as had arrived when it
 * closed, then, once its clip is transcribed, as many as the clip has; those words are stripped from later volatile
 * text with the same range start. Apple settles a line about 3.4 s after it ends; the range then moves on.
 */
export class LiveText {
  private finals: Run[] = [];
  private volatile: { text: string; startMs: number } | null = null;
  private committedEndMs = -Infinity;
  /** Closed lines whose words may still be in the unsettled text, oldest first. */
  private lines: { id: string; startMs: number; words: number; clipWords: number | null }[] = [];
  private n = 0;
  private shown = "";

  constructor(readonly stream: StreamName, private readonly onPartial: (p: LivePartial) => void) {}

  private get itemId() {
    return `apple-${this.stream}-${this.n}`;
  }

  final(runs: Run[]): void {
    this.finals.push(...runs);
    this.volatile = null; // the settled runs replace the unsettled text they covered
    this.render();
  }

  volatileText(runs: Run[]): void {
    if (runs.length === 0) return;
    this.volatile = { text: runs.map((r) => r.text).join(""), startMs: runs[0].startMs };
    // lines from an older range were settled with it: the settled runs' times place their words now
    this.lines = this.lines.filter((l) => l.startMs === this.volatile!.startMs);
    this.render();
  }

  /** A closed line's final text: how many words of the unsettled text are really its own. */
  clipText(utteranceId: string, text: string): void {
    const line = this.lines.find((l) => l.id === utteranceId);
    if (!line) return;
    line.clipWords = words(text).length;
    this.render();
  }

  /** Words at the start of the unsettled text that belong to closed lines. */
  private owned(): number {
    if (!this.volatile) return 0;
    return this.lines.filter((l) => l.startMs === this.volatile!.startMs).reduce((n, l) => n + (l.clipWords ?? l.words), 0);
  }

  /** The text on screen now. */
  text(): string {
    const settled = this.finals
      .filter((r) => r.endMs - END_MARGIN_MS > this.committedEndMs + COMMIT_SLACK_MS)
      .map((r) => r.text)
      .join("");
    const unsettled = this.volatile ? words(this.volatile.text).slice(this.owned()).join(" ") : "";
    return `${settled} ${unsettled}`.replace(/\s+/g, " ").trim();
  }

  private render() {
    const text = this.text();
    if (text === this.shown) return;
    this.shown = text;
    // an empty text too: the page hides it (a tail that turned out to be the last line's)
    this.onPartial({ stream: this.stream, itemId: this.itemId, text, utteranceId: null, final: false });
  }

  /** The VAD closed a line ending at `endMs`: what is on screen belongs to it, and never shows again. */
  commit(utteranceId: string, endMs: number): void {
    if (this.shown) this.onPartial({ stream: this.stream, itemId: this.itemId, text: this.shown, utteranceId, final: true });
    this.committedEndMs = Math.max(this.committedEndMs, endMs);
    this.finals = this.finals.filter((r) => r.endMs - END_MARGIN_MS > this.committedEndMs + COMMIT_SLACK_MS);
    if (this.volatile) {
      const mine = Math.max(0, words(this.volatile.text).length - this.owned());
      this.lines.push({ id: utteranceId, startMs: this.volatile.startMs, words: mine, clipWords: null });
    }
    this.n++;
    this.shown = "";
  }
}

// ---------- the helper process ----------

/** The subset of a child process this module uses, so tests can pass a fake. */
export interface HelperProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  exitCode: number | null;
}

export type SpawnHelper = (bin: string, args: string[]) => HelperProcess;

export interface AppleSpeechDeps {
  /** Show live text: live sessions and speed-1 replays. Without it the helper runs no stream analyzers. */
  emitPartials: boolean;
  log(row: TranscriptionRow): void;
  onPartial(p: LivePartial): void;
  onError(message: string): void;
  spawn?: SpawnHelper;
  bin?: string;
  restartDelayMs?: number;
  maxRestarts?: number;
}

interface Waiting {
  id: string;
  stream: StreamName | null;
  samples: Float32Array;
  file?: string;
  audioSeconds: number;
  started: number;
  resolve(r: TranscriptionResult): void;
  timer?: NodeJS.Timeout;
}

/**
 * The engine side of Apple Speech: implements LiveTranscriber's shape (warm, feed, commit, close) for live text, and
 * `transcribe` for each line's final text. One helper per session, restarted up to 3 times, 1 s apart, like capture.
 */
export class AppleSpeech {
  private proc: HelperProcess | null = null;
  private ready = false;
  private closing = false;
  private restarts = 0;
  private readonly counters = new Map<StreamName, number>(); // session sample index of the next frame, per stream
  private readonly rings = new Map<StreamName, AudioRing>();
  private readonly live = new Map<StreamName, LiveText>();
  private readonly queue: Waiting[] = [];
  private readonly inFlight = new Map<string, Waiting>();
  private exited: Promise<void> = Promise.resolve();
  private clipDir: string | null = null;
  private clipSeq = 0;

  constructor(private readonly cfg: AppConfig["transcription"], private readonly deps: AppleSpeechDeps) {}

  private get apple(): AppleConfig {
    return this.cfg.apple;
  }

  private start(): void {
    if (this.proc || this.closing) return;
    const bin = this.deps.bin ?? appPaths().transcriber;
    const spawn = this.deps.spawn ?? ((b: string, a: string[]) => nodeSpawn(b, a, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() }) as unknown as HelperProcess);
    const args = ["--locale", this.apple.locale, "--clip-concurrency", String(this.apple.clipConcurrency)];
    if (this.deps.emitPartials) args.push("--live");
    let proc: HelperProcess;
    try {
      proc = spawn(bin, args);
    } catch (e) {
      this.deps.onError(`could not start tattle-transcribe: ${e instanceof Error ? e.message : String(e)}`);
      this.failAll("the transcription helper did not start");
      return;
    }
    this.proc = proc;
    this.ready = false;
    let buf = "";
    proc.stdout.setEncoding?.("utf8");
    proc.stdout.on("data", (chunk: string | Buffer) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    proc.stderr.on("data", () => { /* diagnostics only */ });
    proc.stdin.on("error", () => { /* the exit handler reports it */ });
    this.exited = new Promise((resolve) => {
      proc.on("exit", (code, signal) => {
        resolve();
        if (this.proc !== proc) return;
        this.proc = null;
        this.ready = false;
        this.failAll("the transcription helper stopped");
        if (this.closing) return;
        const max = this.deps.maxRestarts ?? 3;
        if (this.restarts >= max) {
          this.deps.onError(`tattle-transcribe exited (code ${code}, signal ${signal}) after ${max} restarts; transcription stops`);
          this.closing = true;
          return;
        }
        this.restarts++;
        this.deps.onError(`tattle-transcribe exited (code ${code}, signal ${signal}); restart ${this.restarts} of ${max}`);
        setTimeout(() => this.start(), this.deps.restartDelayMs ?? 1000).unref?.();
      });
    });
  }

  private onLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    switch (m.type) {
      case "ready":
        this.ready = true;
        this.pump();
        break;
      case "volatile":
      case "final": {
        const lt = this.liveText(m.stream);
        if (!lt || !Array.isArray(m.runs)) break;
        if (m.type === "final") lt.final(m.runs);
        else lt.volatileText(m.runs);
        break;
      }
      case "clip":
        this.onClip(String(m.id), typeof m.text === "string" ? m.text : null, m.error ? String(m.error) : null);
        break;
      case "error":
        this.deps.onError(`tattle-transcribe: ${m.message}`);
        break;
    }
  }

  private liveText(stream: StreamName): LiveText | null {
    if (!this.deps.emitPartials || (stream !== "host" && stream !== "remote")) return null;
    let lt = this.live.get(stream);
    if (!lt) {
      lt = new LiveText(stream, this.deps.onPartial);
      this.live.set(stream, lt);
    }
    return lt;
  }

  private write(frame: Buffer) {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    try {
      p.stdin.write(frame);
    } catch { /* the exit handler reports it */ }
  }

  // ----- LiveTranscriber's shape -----

  /** Starts the helper ahead of speech: its first clip starts cold (11 s measured), so it warms up before it is ready. */
  warm(_stream: StreamName): void {
    this.start();
  }

  /** Every 16 kHz frame of a stream, silence included: clips are cut from it, and live text hears it all. */
  feed(stream: StreamName, samples: Float32Array, _speaking: boolean, sessionMs?: number): void {
    this.start();
    let at = this.counters.get(stream);
    if (at === undefined) at = Math.round((sessionMs ?? 0) * (SAMPLE_RATE / 1000));
    let ring = this.rings.get(stream);
    if (!ring) this.rings.set(stream, (ring = new AudioRing()));
    ring.append(at, samples);
    if (this.deps.emitPartials) this.write(audioFrame(stream, (at * 1000) / SAMPLE_RATE, samples));
    this.counters.set(stream, at + samples.length);
  }

  commit(stream: StreamName, utteranceId: string, endMs?: number): void {
    const lt = this.live.get(stream);
    if (lt && endMs !== undefined) lt.commit(utteranceId, endMs);
  }

  close(): Promise<void> {
    this.closing = true;
    const p = this.proc;
    const clean = () => { if (this.clipDir) rmSync(this.clipDir, { recursive: true, force: true }); };
    if (!p || p.exitCode !== null) return this.exited.finally(clean);
    p.stdin.end(); // the helper finishes its clips and stops when stdin closes
    const term = setTimeout(() => p.kill("SIGTERM"), 2000);
    const kill = setTimeout(() => p.kill("SIGKILL"), 5000);
    return this.exited.finally(() => { clearTimeout(term); clearTimeout(kill); clean(); });
  }

  // ----- final text -----

  /**
   * One line's final text. With a span, the clip is cut from the stream with `clipPadMs` either side (Phase 0: the
   * VAD's edges clip words otherwise); retries, and lines whose audio is no longer held, send the line's own samples.
   */
  transcribe(utteranceId: string, samples: Float32Array, span?: Span): Promise<TranscriptionResult> {
    const audioSeconds = samples.length / SAMPLE_RATE;
    if (audioSeconds < MIN_AUDIO_SECONDS) return Promise.resolve({ ok: true, text: "", filler: false });
    if (this.closing && !this.proc) return Promise.resolve(this.failure(utteranceId, Date.now(), audioSeconds, "the transcription helper stopped"));
    this.start();
    const clip = (span && this.padded(span)) || samples;
    return new Promise((resolve) => {
      this.queue.push({ id: utteranceId, stream: span?.stream ?? null, samples: clip, audioSeconds, started: Date.now(), resolve });
      this.pump();
    });
  }

  private padded(span: Span): Float32Array | null {
    const pad = (this.apple.clipPadMs * SAMPLE_RATE) / 1000;
    const perMs = SAMPLE_RATE / 1000;
    return this.rings.get(span.stream)?.cut(Math.round(span.startMs * perMs - pad), Math.round(span.endMs * perMs + pad)) ?? null;
  }

  /** Sends queued clips while fewer than clipConcurrency are in the helper; each one's timeout starts when it is sent. */
  private pump() {
    while (this.ready && this.proc && this.queue.length > 0 && this.inFlight.size < this.apple.clipConcurrency) {
      const w = this.queue.shift()!;
      if (this.inFlight.has(w.id)) {
        w.resolve(this.failure(w.id, w.started, w.audioSeconds, "the same line is already being transcribed"));
        continue;
      }
      this.inFlight.set(w.id, w);
      // it only catches a stuck helper: a busy Mac, or a --speed max replay competing for it, makes clips slow, not stuck
      const ms = this.apple.clipTimeoutMs + 2 * w.audioSeconds * 1000;
      w.timer = setTimeout(() => this.settle(w.id, null, `no answer from on-device transcription within ${Math.round(ms / 1000)} s`), ms);
      w.timer.unref?.();
      try {
        // readable by this user only; the helper deletes it once read, and settle() if it never was
        this.clipDir ??= mkdtempSync(join(tmpdir(), "tattle-clips-"));
        w.file = join(this.clipDir, `${++this.clipSeq}.pcm`);
        writeFileSync(w.file, pcm16(w.samples), { mode: 0o600 });
      } catch (e) {
        this.settle(w.id, null, `could not write the clip: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      this.write(clipFileFrame(w.id, w.file));
    }
  }

  private onClip(id: string, text: string | null, error: string | null) {
    this.settle(id, text, error ?? (text === null ? "no text" : null));
  }

  private settle(id: string, text: string | null, error: string | null) {
    const w = this.inFlight.get(id);
    if (!w) return;
    this.inFlight.delete(id);
    clearTimeout(w.timer);
    if (w.file) rmSync(w.file, { force: true });
    if (error !== null || text === null) w.resolve(this.failure(id, w.started, w.audioSeconds, error ?? "no text"));
    else {
      this.log(id, { ok: true, started: w.started, audioSeconds: w.audioSeconds });
      const t = applyFixes(text, this.cfg.fixes).trim();
      if (w.stream) this.live.get(w.stream)?.clipText(id, text);
      w.resolve({ ok: true, text: t, filler: isFiller(t) });
    }
    this.pump();
  }

  /** Every Apple failure is worth a retry: the helper restarts, and a retry sends the samples themselves. */
  private failure(id: string, started: number, audioSeconds: number, error: string): TranscriptionResult {
    this.log(id, { ok: false, started, audioSeconds, error });
    return { ok: false, error, retryable: true };
  }

  private failAll(error: string) {
    for (const w of [...this.inFlight.values()]) this.settle(w.id, null, error);
    for (const w of this.queue.splice(0)) w.resolve(this.failure(w.id, w.started, w.audioSeconds, error));
  }

  private log(id: string, r: { ok: boolean; started: number; audioSeconds: number; error?: string }) {
    this.deps.log({
      kind: "transcription", engine: "apple", utterance_id: id, ok: r.ok, latency_ms: Date.now() - r.started, attempts: 1,
      audio_seconds: Math.round(r.audioSeconds * 1000) / 1000, cost_usd: 0, estimated: true,
      ...(r.error ? { error: r.error } : {}), at: new Date().toISOString(),
    });
  }
}

// ---------- availability ----------

export interface AppleStatus {
  available: boolean;
  reason: string | null;
  locale: string | null;
  installed: boolean;
  /** The --status check itself failed (timeout, crash): not a verdict on this Mac. */
  error?: string;
}

/** macOS 26 is Darwin 25. The helper cannot even load on older macOS, so it is never spawned there. */
export function macosSupportsAppleSpeech(darwinRelease = release()): boolean {
  return Number(darwinRelease.split(".")[0]) >= 25;
}

let cached: Promise<AppleStatus> | null = null;

/** Whether Apple Speech can run here, from `tattle-transcribe --status`; cached for the engine's lifetime once it answers. */
export function appleSpeechStatus(opts: { refresh?: boolean; bin?: string; locale?: string } = {}): Promise<AppleStatus> {
  if (process.env.TATTLE_FORCE_NO_APPLE_SPEECH === "1" || !macosSupportsAppleSpeech()) {
    return Promise.resolve({ available: false, reason: "Needs macOS 26 or later", locale: null, installed: false });
  }
  const bin = opts.bin ?? appPaths().transcriber;
  if (!existsSync(bin)) {
    return Promise.resolve({ available: false, reason: "tattle-transcribe is not built (npm run build:transcribe)", locale: null, installed: false });
  }
  if (cached && !opts.refresh) return cached;
  const p = new Promise<AppleStatus>((resolve) => {
    execFile(bin, ["--status", "--locale", opts.locale ?? "en-US"], { timeout: 5000, env: childEnv() }, (err, stdout) => {
      try {
        const s = JSON.parse(String(stdout).trim().split("\n").pop() ?? "");
        resolve({ available: !!s.available, reason: s.reason ?? null, locale: s.locale ?? null, installed: !!s.installed });
      } catch {
        resolve({ available: false, reason: null, locale: null, installed: false, error: err ? err.message : "no answer from tattle-transcribe --status" });
      }
    });
  });
  // a failed check is not remembered: the next call asks again
  cached = p.then((s) => { if (s.error) cached = null; return s; });
  return cached;
}

/** Runs `tattle-transcribe --install`, reporting progress (0–1); resolves when the model is installed, rejects on failure. */
export function installAppleModel(onProgress: (fraction: number) => void, opts: { bin?: string; locale?: string } = {}): Promise<void> {
  const bin = opts.bin ?? appPaths().transcriber;
  return new Promise((resolve, reject) => {
    const p = nodeSpawn(bin, ["--install", "--locale", opts.locale ?? "en-US"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    let buf = "";
    let error: string | null = null;
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === "progress" && typeof m.fraction === "number") onProgress(m.fraction);
          if (m.type === "error") error = String(m.message);
        } catch { /* not JSON */ }
      }
    });
    p.on("error", (e) => reject(e));
    p.on("exit", (code) => {
      if (code === 0) { cached = null; resolve(); } else reject(new Error(error ?? `tattle-transcribe --install exited with ${code}`));
    });
  });
}
