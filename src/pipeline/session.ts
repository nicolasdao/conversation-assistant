import { writeFileSync } from "node:fs";
import type { Config } from "../config.ts";
import { Budget, sumDevSpend } from "../budget.ts";
import { mergeSources, type AudioSource, type StreamName } from "../audio/source.ts";
import { LoudTagger, rmsDbfs } from "../audio/tags.ts";
import { StreamVad, UtteranceIds, type Utterance } from "../audio/vad.ts";
import { SAMPLE_RATE } from "../audio/wav.ts";
import { Embedder, SpeakerRegistry } from "../speakers/registry.ts";
import { Transcriber, type TranscriptionResult } from "../transcribe/openai.ts";
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

export type SessionMode = "replay" | "live";

/** The external services, injectable so tests never touch the network. */
/** Streamed to the page but never stored in the replayable history or events.jsonl. */
const TRANSIENT = new Set<EventType>(["utterance.partial", "call.started", "call"]);

export interface Services {
  transcribe(utteranceId: string, samples: Float32Array): Promise<TranscriptionResult>;
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
}

interface StreamHealth { lastFrameAt: number; recent: Float32Array[]; utteranceTimes: number[] }

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
  private lastMs = 0;
  private readonly bus: EventBus;
  private readonly services: Services;
  private readonly vads = new Map<StreamName, StreamVad>();
  private readonly ids = new UtteranceIds();
  private readonly loud = new LoudTagger();
  private readonly states = new Map<string, unknown>();
  private readonly transcriptions = new Set<Promise<void>>();
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

    this.speakers = new SpeakerRegistry(cfg.app.speakers, opts.embedder ?? new Embedder());
    for (const s of streams) {
      this.vads.set(s, new StreamVad(s, cfg.app.vad, this.ids));
      this.health.set(s, { lastFrameAt: 0, recent: [], utteranceTimes: [] });
    }

    const onError = (component: string, message: string, detail?: Record<string, unknown>) =>
      this.emit("error", { component, message, ...(detail ?? {}) });
    const speakerName = (id: string) => this.speakers.displayName(id);

    this.timeline = new Timeline(cfg.app, cfg.labels, {
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
      factcheck: this.factcheck,
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

  get mode(): SessionMode {
    return this.opts.mode;
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
      transcribe: (id, samples) => transcriber.transcribe(id, samples),
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
      id: this.id, mode: this.opts.mode, startedAt: this.startedAt.toISOString(),
      streams: this.opts.sources.map((s) => s.stream),
      config: cfg.app, labelSet: cfg.labels, labelSetVersion: this.timeline.version,
      s1Version: this.factcheck.active.id, s1: cfg.s1,
    });
    this.emit("session.started", {
      sessionId: this.id, mode: this.opts.mode, dir: this.store.dir, s1Version: this.factcheck.active.id,
      labelSetVersion: this.timeline.version, streams: this.opts.sources.map((s) => s.stream), startedAt: this.startedAt.toISOString(),
    });
    this.timers.push(setInterval(() => this.emitHealth(), 1000));
    this.timers.push(setInterval(() => this.emitStats(), this.opts.statsIntervalMs ?? 60_000));
    for (const t of this.timers) t.unref?.();

    let reason = "end_of_input";
    try {
      let n = 0;
      for await (let f of mergeSources(this.opts.sources, (s) => this.endStream(s))) {
        if (this.stopRequested) { reason = "stopped"; break; }
        this.lastMs = Math.max(this.lastMs, f.sessionMs);
        if (this.paused) f = { ...f, samples: new Float32Array(f.samples.length) };
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
    const p = this.services.transcribe(u.id, u.samples)
      .catch((e): TranscriptionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        if (!r.ok) this.emit("error", { component: "transcription", message: r.error, utterance_id: u.id });
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
      this.emit("health", {
        stream, rmsDbfs: Number.isFinite(db) ? Math.round(db * 10) / 10 : -120,
        msSinceLastFrame: h.lastFrameAt ? now - h.lastFrameAt : -1, utterancesLastMinute: h.utteranceTimes.length,
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

  state() {
    return {
      session: {
        id: this.id, mode: this.opts.mode, status: this.status, paused: this.paused, dir: this.store.dir, startedAt: this.startedAt.toISOString(),
        streams: this.opts.sources.map((s) => s.stream),
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
