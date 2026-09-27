import { writeFileSync } from "node:fs";
import type { Config } from "../config.ts";
import { Budget, sumDevSpend } from "../budget.ts";
import { mergeSources, type AudioSource, type StreamName } from "../audio/source.ts";
import { EchoGate, type OutputKind } from "../audio/echoGate.ts";
import { LoudTagger, rmsDbfs, type Tag } from "../audio/tags.ts";
import { StreamVad, UtteranceIds, type Utterance } from "../audio/vad.ts";
import { SAMPLE_RATE } from "../audio/wav.ts";
import { Embedder, SpeakerRegistry, type VoiceLimits } from "../speakers/registry.ts";
import { Transcriber, type TranscriptionContext, type TranscriptionResult } from "../transcribe/openai.ts";
import { LiveTranscriber, type LiveDeps } from "../transcribe/live.ts";
import { JevClient, type JevCallMeta, type JevCallRow } from "../jev/client.ts";
import type { JevResponse, QuestionSet } from "../jev/types.ts";
import { S2Client } from "../factcheck/s2.ts";
import { FactChecker, type S2Api } from "../factcheck/s1.ts";
import { Segmenter, type PipelineUtterance, type Segment } from "./segmenter.ts";
import { Timeline } from "./timeline.ts";
import { computeStats, type SessionStats } from "./stats.ts";
import { EventBus, processSecrets, type EventType } from "../store/events.ts";
import { SessionStore, type JsonlFile } from "../store/sessionStore.ts";
import { appInfo } from "../version.ts";

export type SessionMode = "replay" | "live";

/**
 * What a session runs beyond the transcript, chosen when it starts and fixed for its whole run (an off feature cannot
 * be turned back on). With both off, Jev is never asked: the session is a plain recording with a transcript.
 */
export interface Features {
  /** System 1 (Jev flags claims on every line) and System 2 (research, audits, rewrites). */
  factcheck: boolean;
  /** Jev labels each closed segment of the timeline. */
  labels: boolean;
}

/** System 1's questions and answers, when fact-checking is off: none. */
const NO_FACTCHECK = { questions: () => ({ questions: {}, version: "off" }), onAnswers: () => {} };

/** The external services, injectable so tests never touch the network. */
/** Streamed to the page but never stored in the replayable history or events.jsonl. */
const TRANSIENT = new Set<EventType>(["utterance.partial", "call.started", "call"]);

export interface Services {
  transcribe(utteranceId: string, samples: Float32Array, context?: TranscriptionContext): Promise<TranscriptionResult>;
  ask(state: unknown, questions: QuestionSet, meta: JevCallMeta): Promise<JevResponse>;
  s2: S2Api;
}

export interface SessionOptions {
  mode: SessionMode;
  sources: AudioSource[];
  config: Config;
  bus: EventBus;
  sessionsDir?: string;
  sessionPrefix?: string;
  allowOverDevCap?: boolean;
  /** Real services are built from fetch and the keys unless given. */
  services?: (ctx: { budget: Budget; log: (file: JsonlFile, row: unknown, live?: Record<string, unknown>) => void }) => Services;
  fetch?: typeof fetch;
  keys?: { openrouter?: string; openai?: string };
  embedder?: Embedder;
  exportBoundary?: string;
  statsIntervalMs?: number;
  /** Extra detail for health events, such as the capture helper's device names. */
  healthDetail?: () => Record<string, unknown> | null;
  /** Streaming display text (live sessions and speed-1 replays); needs transcription.live.enabled. */
  liveText?: boolean;
  /** Test seam for the realtime WebSocket. */
  liveConnect?: LiveDeps["connect"];
  /** Overrides `speakers.voicesPerStream`, e.g. how many people are on the call tonight. */
  voices?: VoiceLimits;
  /** Both on unless set to false. */
  features?: Partial<Features>;
  /** How often failed lines are retried while the session runs (tests set it). */
  retryEveryMs?: number;
}

interface StreamHealth { lastFrameAt: number; recent: Float32Array[]; utteranceTimes: number[] }

/** A line whose final transcript failed on a transient error (a network drop): its audio is kept and retried. */
interface PendingTranscript {
  u: Utterance; speakerId: string; inferred: boolean; tags: Tag[]; context: TranscriptionContext;
}

/** How often failed lines are retried while the session runs. */
const RETRY_EVERY_MS = 15_000;
/** The most failed lines kept for a retry (about 20 minutes of speech); older ones are given up. */
const MAX_PENDING = 200;

/** Wires sources → VAD → tags → speakers → transcription → segmenter → timeline and fact-checker → store and events (§4.10). */
export class Session {
  readonly store: SessionStore;
  readonly budget: Budget;
  readonly speakers: SpeakerRegistry;
  readonly segmenter: Segmenter;
  readonly timeline: Timeline;
  readonly factcheck: FactChecker;
  readonly startedAt = new Date();
  status: "running" | "ending" | "ended" = "running";
  /** While paused, incoming audio is replaced by silence: nothing is heard, transcribed, or spent, and times stay aligned. */
  paused = false;
  /** Speaker mode: the microphone is muted while the call plays through the speakers. */
  readonly echoGate: EchoGate;
  private outputDevice: string | null = null;
  private lastMs = 0;
  private readonly bus: EventBus;
  private readonly services: Services;
  private readonly vads = new Map<StreamName, StreamVad>();
  private readonly ids = new UtteranceIds();
  private readonly loud = new LoudTagger();
  private readonly states = new Map<string, unknown>();
  private readonly transcriptions = new Set<Promise<void>>();
  /** Failed lines waiting for a retry, oldest first. */
  private readonly pending = new Map<string, PendingTranscript>();
  private retrying: Promise<void> | null = null;
  private readonly utterances: PipelineUtterance[] = [];
  private readonly processed = new Map<string, PipelineUtterance>();
  private readonly health = new Map<StreamName, StreamHealth>();
  private readonly timers: NodeJS.Timeout[] = [];
  private stopRequested = false;
  private exportRows: unknown[] = [];
  private live: LiveTranscriber | null = null;
  private done: Promise<void> | null = null;

  constructor(private readonly opts: SessionOptions) {
    const cfg = opts.config;
    this.bus = opts.bus;
    const streams = opts.sources.map((s) => s.stream);
    if (streams.length === 0) throw new Error("at least one audio source is required");
    this.store = new SessionStore({ root: opts.sessionsDir, prefix: opts.sessionPrefix, streams, redact: processSecrets() });

    this.budget = new Budget({
      sessionCapUsd: cfg.app.budget.sessionCapUsd,
      devCapUsd: cfg.app.budget.devCapUsd,
      enforceDevCap: opts.mode !== "live" && !opts.allowOverDevCap,
      devSpentUsd: sumDevSpend(opts.sessionsDir ?? "sessions"),
      onExhausted: (e) => this.emit("budget.exhausted", { cap: e.cap, purpose: e.purpose, message: e.message, totals: e.totals }),
      onCost: (t) => this.emit("cost", { ...t, sessionCapUsd: cfg.app.budget.sessionCapUsd }),
    });

    const log = (file: JsonlFile, row: unknown, live?: Record<string, unknown>) => {
      this.store.append(file, row);
      const r = row as JevCallRow;
      if (file === "jev_calls" && r.purpose === "utterance" && r.ok && r.utterance_id) this.states.set(r.utterance_id, r.state);
      // every Jev and System 2 call also streams to the page, as it completes
      if (file === "jev_calls" || file === "s2_calls") this.emit("call", { ...(row as Record<string, unknown>), ...(live ?? {}) });
    };
    this.services = opts.services ? opts.services({ budget: this.budget, log }) : this.realServices(log);
    const liveCfg = opts.config.app.transcription.live;
    if (opts.liveText && liveCfg?.enabled) {
      this.live = new LiveTranscriber(opts.config.app.transcription, liveCfg, {
        apiKey: opts.keys?.openai ?? process.env.OPENAI_API_KEY ?? "",
        budget: this.budget,
        log: (r) => this.store.append("transcriptions", r),
        onPartial: (p) => this.emit("utterance.partial", { ...p }),
        onError: (m) => this.emit("error", { component: "live-transcription", message: m }),
        connect: opts.liveConnect,
      });
      for (const s of streams) this.live.warm(s);
    }

    this.echoGate = new EchoGate(cfg.app.echoGate);
    this.speakers = new SpeakerRegistry(cfg.app.speakers, opts.embedder ?? new Embedder(), this.voices);
    for (const s of streams) {
      this.vads.set(s, new StreamVad(s, cfg.app.vad, this.ids));
      this.health.set(s, { lastFrameAt: 0, recent: [], utteranceTimes: [] });
    }

    const onError = (component: string, message: string, detail?: Record<string, unknown>) =>
      this.emit("error", { component, message, ...(detail ?? {}) });
    const speakerName = (id: string) => this.speakers.displayName(id);

    const features = this.features;
    this.timeline = new Timeline(cfg.app, cfg.labels, {
      labels: features.labels,
      ask: (s, q, m) => this.services.ask(s, q, m),
      speakerName,
      emit: (t, d) => this.emit(t as EventType, d),
      write: (row) => this.store.append("labels", row),
      onError,
    });

    this.factcheck = new FactChecker({
      app: cfg.app, s1Default: cfg.s1, s2: this.services.s2,
      ask: (s, q, m) => this.services.ask(s, q, m),
      emit: (t, d) => this.emit(t as EventType, d),
      write: (file, row) => this.store.append(file, row),
      speakerName,
      stateOf: (id) => this.states.get(id),
      onError,
    });

    this.segmenter = new Segmenter(cfg.app.segmentation, {
      ask: (s, q, m) => this.services.ask(s, q, m),
      boundary: () => this.timeline.labelSetActive.boundary,
      factcheck: features.factcheck ? this.factcheck : NO_FACTCHECK,
      jev: features.factcheck || features.labels,
      speakerName,
      resolveSpeaker: (id) => this.speakers.resolve(id),
      streams: () => [...this.vads.values()].map((v) => ({ stream: v.stream, watermark: v.watermark, midSpeech: v.isDetected() })),
      onSegmentClosed: (seg) => this.onSegmentClosed(seg),
      onProcessed: (u) => {
        this.processed.set(u.id, u);
        if (opts.exportBoundary && typeof u.boundary === "number") {
          this.exportRows.push({ utterance_id: u.id, speaker: speakerName(u.speakerId), text: u.text, boundary_p: u.boundary, human_boundary: null });
        }
      },
      onError,
    });
  }

  get id(): string {
    return this.store.id;
  }

  /** How many voices each stream carries in this session. */
  get voices(): VoiceLimits {
    return { ...this.opts.config.app.speakers.voicesPerStream, ...(this.opts.voices ?? {}) };
  }

  get mode(): SessionMode {
    return this.opts.mode;
  }

  get features(): Features {
    return { factcheck: this.opts.features?.factcheck !== false, labels: this.opts.features?.labels !== false };
  }

  private realServices(log: (file: JsonlFile, row: unknown, live?: Record<string, unknown>) => void): Services {
    const f = this.opts.fetch ?? fetch;
    const cfg = this.opts.config.app;
    const openrouter = this.opts.keys?.openrouter ?? process.env.OPENROUTER_API_KEY ?? "";
    const openai = this.opts.keys?.openai ?? process.env.OPENAI_API_KEY ?? "";
    const transcriber = new Transcriber(cfg.transcription, { fetch: f, apiKey: openai, budget: this.budget, log: (r) => log("transcriptions", r) });
    const jev = new JevClient(cfg.jev, {
      fetch: f, apiKey: openrouter, budget: this.budget,
      log: (r, questions) => log("jev_calls", r, questions ? { questions } : undefined),
      onStart: (purpose) => this.emit("call.started", { system: "s1", purpose }),
    });
    const s2 = new S2Client(cfg.s2, {
      fetch: f, apiKey: openrouter, budget: this.budget, log: (r) => log("s2_calls", r),
      onStart: (purpose) => this.emit("call.started", { system: "s2", purpose }),
    });
    return {
      transcribe: (id, samples, context) => transcriber.transcribe(id, samples, context),
      ask: (s, q, m) => jev.ask(s, q, m),
      s2,
    };
  }

  emit(type: EventType, data: Record<string, unknown>): void {
    const transient = TRANSIENT.has(type);
    const e = this.bus.emit(type, data, { transient });
    // Commands after the end (a speaker rename or merge) are still recorded, so a reopened recording shows them.
    if (!transient) this.store.append("events", e, { afterClose: this.status === "ended" });
  }

  /** Runs the whole session; resolves at session.ended. */
  run(): Promise<void> {
    this.done ??= this.runInner();
    return this.done;
  }

  private async runInner(): Promise<void> {
    const cfg = this.opts.config;
    this.store.writeJson("session.json", {
      // the version that made the recording, which an export carries along
      id: this.id, app: appInfo(), mode: this.opts.mode, startedAt: this.startedAt.toISOString(),
      streams: this.opts.sources.map((s) => s.stream),
      config: cfg.app, voices: this.voices, features: this.features, labelSet: cfg.labels, labelSetVersion: this.timeline.version,
      s1Version: this.factcheck.active.id, s1: cfg.s1,
    });
    this.emit("session.started", {
      sessionId: this.id, mode: this.opts.mode, dir: this.store.dir, s1Version: this.factcheck.active.id,
      labelSetVersion: this.timeline.version, streams: this.opts.sources.map((s) => s.stream), startedAt: this.startedAt.toISOString(),
      features: this.features,
    });
    if (this.echoGate.active) this.emitEchoGate();
    this.timers.push(setInterval(() => this.emitHealth(), 1000));
    this.timers.push(setInterval(() => this.emitStats(), this.opts.statsIntervalMs ?? 60_000));
    this.timers.push(setInterval(() => void this.retryPending(), this.opts.retryEveryMs ?? RETRY_EVERY_MS));
    for (const t of this.timers) t.unref?.();

    let reason = "end_of_input";
    try {
      let n = 0;
      for await (let f of mergeSources(this.opts.sources, (s) => this.endStream(s))) {
        if (this.stopRequested) { reason = "stopped"; break; }
        this.lastMs = Math.max(this.lastMs, f.sessionMs);
        if (this.paused) f = { ...f, samples: new Float32Array(f.samples.length) };
        // speaker mode: the stored host audio is what the pipeline heard, silence included
        if (f.stream === "remote") this.echoGate.remote(f.samples, f.sessionMs);
        else if (this.echoGate.active) f = { ...f, samples: this.echoGate.host(f.samples, f.sessionMs) };
        this.store.writeAudio(f.stream, f.samples);
        const h = this.health.get(f.stream)!;
        h.lastFrameAt = Date.now();
        h.recent.push(f.samples);
        if (h.recent.length > 32) h.recent.shift();
        const vad = this.vads.get(f.stream)!;
        const utts = vad.accept(f.samples, f.sessionMs);
        this.live?.feed(f.stream, f.samples, vad.isDetected());
        for (const u of utts) this.onUtterance(u);
        this.segmenter.poll();
        if (++n % 64 === 0) await new Promise<void>((r) => setImmediate(r)); // let network I/O progress at speed max
      }
    } catch (e) {
      reason = "error";
      this.emit("error", { component: "session", message: e instanceof Error ? e.message : String(e) });
    }
    await this.finish(reason);
  }

  private endStream(s: StreamName) {
    for (const u of this.vads.get(s)!.flush()) this.onUtterance(u);
    this.segmenter.poll();
  }

  private onUtterance(u: Utterance) {
    const tags = this.loud.tag(u.stream, u.samples) ? (["loud"] as const) : [];
    const a = this.speakers.assign(u.stream, u.samples);
    if (a.created) this.emit("speaker.created", { id: a.created.id, displayName: a.created.displayName, stream: u.stream });
    this.health.get(u.stream)!.utteranceTimes.push(Date.now());
    this.store.append("utterances", {
      id: u.id, stream: u.stream, start_ms: Math.round(u.startMs), end_ms: Math.round(u.endMs), speaker_id: a.speakerId,
      speaker_inferred: a.inferred, tags,
    });
    this.segmenter.emitted(u);
    this.live?.commit(u.stream, u.id);
    const context = this.transcriptionContext();
    const p = this.services.transcribe(u.id, u.samples, context)
      .catch((e): TranscriptionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        if (!r.ok) {
          this.emit("error", { component: "transcription", message: r.error, utterance_id: u.id });
          // the line keeps its place in the transcript; a transient failure is retried with the same audio and context
          if (r.retryable) this.keepForRetry({ u, speakerId: a.speakerId, inferred: a.inferred, tags: [...tags], context });
          this.emitFailed(u, a.speakerId, r.retryable ? "retrying" : "failed");
        }
        const text = r.ok ? r.text : "";
        const pu: PipelineUtterance = {
          id: u.id, stream: u.stream, startMs: u.startMs, endMs: u.endMs, speakerId: a.speakerId, speakerInferred: a.inferred,
          text, filler: r.ok ? r.filler : false, failed: !r.ok, tags: [...tags],
        };
        const dropped = r.ok && text === "";
        if (r.ok && !dropped) {
          this.utterances.push(pu);
          this.emit("utterance", {
            id: u.id, stream: u.stream, startMs: u.startMs, endMs: u.endMs, speakerId: this.speakers.resolve(a.speakerId),
            speakerName: this.speakers.displayName(a.speakerId), speakerInferred: a.inferred, text, filler: pu.filler, tags: pu.tags,
          });
        }
        this.segmenter.transcribed(u.id, { ...pu, dropped });
      });
    this.transcriptions.add(p);
    p.finally(() => this.transcriptions.delete(p));
  }

  private emitFailed(u: { id: string; stream: StreamName; startMs: number; endMs: number }, speakerId: string, status: "retrying" | "failed" | "empty") {
    this.emit("utterance.failed", { id: u.id, stream: u.stream, startMs: u.startMs, endMs: u.endMs, speakerId: this.speakers.resolve(speakerId), status });
  }

  private keepForRetry(t: PendingTranscript) {
    this.pending.set(t.u.id, t);
    if (this.pending.size <= MAX_PENDING) return;
    const [oldest] = this.pending.values();
    this.pending.delete(oldest.u.id);
    this.emitFailed(oldest.u, oldest.speakerId, "failed");
  }

  /**
   * Retries failed lines, oldest first, and stops at the first failure: the connection is probably still down, and
   * one attempt per pass does not pile requests onto it. A recovered line joins the transcript (and the chat) in its
   * place; it does not go back through Jev, segments, or fact-checking, which have moved on. One pass at a time.
   */
  private retryPending(): Promise<void> {
    if (this.retrying || this.pending.size === 0) return this.retrying ?? Promise.resolve();
    const run = async () => {
      for (const t of [...this.pending.values()]) {
        const r = await this.services.transcribe(t.u.id, t.u.samples, t.context)
          .catch((e): TranscriptionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        if (!r.ok) {
          if (r.retryable) return; // still down: try again on the next pass
          this.pending.delete(t.u.id);
          this.emitFailed(t.u, t.speakerId, "failed");
          continue;
        }
        this.pending.delete(t.u.id);
        if (!r.text) {
          this.emitFailed(t.u, t.speakerId, "empty");
          continue;
        }
        const pu: PipelineUtterance = {
          id: t.u.id, stream: t.u.stream, startMs: t.u.startMs, endMs: t.u.endMs, speakerId: t.speakerId, speakerInferred: t.inferred,
          text: r.text, filler: r.filler, failed: false, tags: t.tags,
        };
        // in time order, so the chat and the transcription context read the conversation as it happened
        const at = this.utterances.findIndex((x) => x.startMs > pu.startMs);
        if (at < 0) this.utterances.push(pu);
        else this.utterances.splice(at, 0, pu);
        this.emit("utterance", {
          id: pu.id, stream: pu.stream, startMs: pu.startMs, endMs: pu.endMs, speakerId: this.speakers.resolve(pu.speakerId),
          speakerName: this.speakers.displayName(pu.speakerId), speakerInferred: pu.speakerInferred, text: pu.text, filler: pu.filler,
          tags: pu.tags, recovered: true,
        });
      }
    };
    this.retrying = run()
      .catch((e) => this.emit("error", { component: "transcription", message: `retrying failed lines: ${e instanceof Error ? e.message : String(e)}` }))
      .finally(() => { this.retrying = null; });
    return this.retrying;
  }

  /**
   * Guidance for one clip's final transcript: the base prompt, the names the host gave the speakers, tonight's stories,
   * and the last few lines said, so a 2-second clip is heard in context ("to pee", not "2P").
   */
  private transcriptionContext(): TranscriptionContext {
    const cfg = this.opts.config.app.transcription;
    const names = this.speakers.active().map((s) => s.displayName).filter((n) => !/^Speaker \d+$/.test(n));
    const stories = this.timeline.storiesActive;
    let recent = "";
    for (const u of this.utterances.slice(-6).reverse()) {
      if (!u.text) continue;
      const line = `${this.speakers.displayName(u.speakerId)}: ${u.text}`;
      if (recent.length + line.length > 600) break;
      recent = recent ? `${line}\n${recent}` : line;
    }
    const prompt = [
      cfg.prompt,
      names.length ? `The speakers are ${names.join(", ")}.` : "",
      stories.length ? `Topics tonight: ${stories.join("; ")}.` : "",
      recent ? `The conversation so far:\n${recent}` : "",
    ].filter(Boolean).join("\n");
    return { prompt, keywords: names };
  }

  private onSegmentClosed(seg: Segment) {
    this.store.append("segments", {
      id: seg.id, start_ms: Math.round(seg.startMs), end_ms: Math.round(seg.endMs), forced: seg.forced, final: seg.final,
      utterance_ids: seg.utterances.map((u) => u.id),
    });
    this.emit("segment.closed", {
      id: seg.id, startMs: seg.startMs, endMs: seg.endMs, forced: seg.forced, final: seg.final,
      utteranceIds: seg.utterances.map((u) => u.id),
    });
    this.timeline.onSegmentClosed(seg);
  }

  private emitHealth() {
    const now = Date.now();
    for (const [stream, h] of this.health) {
      const n = h.recent.reduce((a, b) => a + b.length, 0);
      const all = new Float32Array(n);
      let off = 0;
      for (const r of h.recent) { all.set(r, off); off += r.length; }
      h.recent = [];
      h.utteranceTimes = h.utteranceTimes.filter((t) => now - t < 60_000);
      const db = rmsDbfs(all);
      const muted = stream === "host" && this.echoGate.active ? { echoMutedMs: this.echoGate.takeMutedMs() } : {};
      this.emit("health", {
        stream, rmsDbfs: Number.isFinite(db) ? Math.round(db * 10) / 10 : -120,
        msSinceLastFrame: h.lastFrameAt ? now - h.lastFrameAt : -1, utterancesLastMinute: h.utteranceTimes.length, ...muted,
        ...(this.opts.healthDetail?.() ? { detail: this.opts.healthDetail() } : {}),
      });
    }
  }

  stats(): SessionStats {
    return computeStats({
      segments: this.timeline.segments, labels: this.timeline.labels,
      resolveSpeaker: (id) => this.speakers.resolve(id), speakerName: (id) => this.speakers.displayName(id),
      factcheck: this.factcheck.stats(), cost: this.budget.totals(), timeline: this.opts.config.app.timeline,
    });
  }

  private emitStats() {
    this.emit("stats", { ...this.stats() });
  }

  /** End of input, in order (§4.10). */
  private async finish(reason: string) {
    this.status = "ending";
    for (const s of this.vads.keys()) if (!this.vads.get(s)!.ended) this.endStream(s); // 1. flush every VAD
    while (this.transcriptions.size > 0) await Promise.all([...this.transcriptions]); // 2. transcription and segmenter
    // a last try for lines lost to a network drop; whatever still fails is given up
    await this.retrying;
    await this.retryPending();
    for (const t of this.pending.values()) this.emitFailed(t.u, t.speakerId, "failed");
    this.pending.clear();
    this.segmenter.poll();
    await this.segmenter.idle();
    this.segmenter.closeFinal(); // 3. close and label the open segment
    await this.timeline.idle();
    const drained = await this.factcheck.drain(180_000); // 4. research, audits, rewrites
    if (!drained) this.emit("error", { component: "factcheck", message: "fact-check work still running after 180 s; ending anyway" });
    this.factcheck.stop();
    for (const t of this.timers) clearInterval(t);
    this.live?.close();
    this.emitStats(); // 5.
    this.store.writeJson("speakers.json", this.speakers.list());
    if (this.opts.exportBoundary) {
      writeFileSync(this.opts.exportBoundary, this.exportRows.map((r) => JSON.stringify(r)).join("\n") + (this.exportRows.length ? "\n" : ""));
    }
    this.status = "ended";
    this.emit("session.ended", { sessionId: this.id, reason, dir: this.store.dir });
    this.store.close();
  }

  /**
   * Where the Mac plays the call, from the capture helper (live sessions): speakers turn the echo gate on, headphones or
   * earbuds turn it off. Emits `echo.gate` when that changes, and when the device changes while the gate is on.
   */
  setOutput(kind: OutputKind | null, device: string | null): void {
    const changed = this.echoGate.setOutput(kind);
    const renamed = this.echoGate.active && device !== this.outputDevice;
    this.outputDevice = device;
    if ((changed || renamed) && this.status === "running") this.emitEchoGate();
  }

  private emitEchoGate() {
    this.emit("echo.gate", { active: this.echoGate.active, device: this.outputDevice, atMs: this.lastMs });
  }

  /** Pauses a running session: audio becomes silence until resume(). */
  pause(): boolean {
    if (this.status !== "running" || this.paused) return false;
    this.paused = true;
    this.emit("session.paused", { sessionId: this.id, atMs: this.lastMs });
    return true;
  }

  resume(): boolean {
    if (this.status !== "running" || !this.paused) return false;
    this.paused = false;
    this.emit("session.resumed", { sessionId: this.id, atMs: this.lastMs });
    return true;
  }

  /** Stops reading input; everything in flight still completes. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.run();
  }

  // ----- host commands -----

  renameSpeaker(id: string, displayName: string) {
    const s = this.speakers.rename(id, displayName);
    this.emit("speaker.updated", { id: s.id, displayName: s.displayName });
    this.saveSpeakersAfterEnd();
    return s;
  }

  mergeSpeakers(fromId: string, intoId: string) {
    const from = this.speakers.resolve(fromId);
    const s = this.speakers.merge(fromId, intoId);
    this.emit("speaker.merged", { fromId: from, intoId: s.id, displayName: s.displayName });
    this.saveSpeakersAfterEnd();
    return s;
  }

  /** speakers.json is written at the end; an edit made after that rewrites it. */
  private saveSpeakersAfterEnd() {
    if (this.status === "ended") this.store.writeJson("speakers.json", this.speakers.list());
  }

  /** The final transcript for the chat window, in arrival order, with current speaker names; fillers left out. */
  transcriptLines(): { id: string; startMs: number; speakerId: string; speaker: string; text: string }[] {
    return this.utterances
      .filter((u) => !u.filler && u.text.trim())
      .map((u) => ({ id: u.id, startMs: u.startMs, speakerId: u.speakerId, speaker: this.speakers.displayName(u.speakerId), text: u.text }));
  }

  state() {
    return {
      session: {
        id: this.id, mode: this.opts.mode, status: this.status, paused: this.paused, dir: this.store.dir, startedAt: this.startedAt.toISOString(),
        streams: this.opts.sources.map((s) => s.stream), features: this.features,
        echoGate: { active: this.echoGate.active, device: this.outputDevice },
      },
      speakers: this.speakers.list(),
      utterances: this.utterances.map((u) => ({
        ...u, speakerId: this.speakers.resolve(u.speakerId), speakerName: this.speakers.displayName(u.speakerId),
        boundary: this.processed.get(u.id)?.boundary ?? null,
      })),
      segments: this.timeline.segments.map((s) => ({
        id: s.id, startMs: s.startMs, endMs: s.endMs, forced: s.forced, final: s.final, utteranceIds: s.utterances.map((u) => u.id),
        labels: this.timeline.labels.get(s.id) ?? null,
      })),
      openSegment: this.segmenter.openSegment ? { id: this.segmenter.openSegment.id, utteranceIds: this.segmenter.openSegment.utterances.map((u) => u.id) } : null,
      sections: this.timeline.sections(),
      labels: { set: this.timeline.labelSetActive, stories: this.timeline.storiesActive, version: this.timeline.version },
      claims: [...this.factcheck.claims.values()],
      s1: {
        active: this.factcheck.active.id,
        versions: this.factcheck.versions.map((v) => ({ id: v.id, parent: v.parent, status: v.status, kind: v.kind, rationale: v.rationale, gate: v.gate, createdAt: v.createdAt, errors: v.errors ?? null })),
        activeSet: { questions: this.factcheck.active.questions, thresholds: this.factcheck.active.thresholds },
        memory: this.factcheck.memoryQuestions,
      },
      cost: { ...this.budget.totals(), sessionCapUsd: this.opts.config.app.budget.sessionCapUsd },
      stats: this.stats(),
    };
  }
}
