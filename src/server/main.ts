import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "../config.ts";
import { FileSource, type AudioSource, type Speed } from "../audio/source.ts";
import { Session, type Features, type SessionOptions } from "../pipeline/session.ts";
import { listDevices, startNativeCapture } from "../audio/nativeSource.ts";
import { LabelConflictError } from "../pipeline/timeline.ts";
import { EventBus, processSecrets, type AppEvent } from "../store/events.ts";
import { resolveRecorded, SessionLibrary } from "../store/library.ts";
import { Embedder } from "../speakers/registry.ts";
import { recordedVoiceprints, suggestMerges, type MergeSuggestion } from "../speakers/suggest.ts";
import { serveMixedAudio } from "./audio.ts";
import { ChatError, ChatService, type ChatEvent, type ChatSource } from "../chat/chat.ts";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  discard, exportEstimate, exportFileName, exportRecording, importRecording, MAX_UPLOAD_BYTES, saveUpload, TransferError, type AudioChoice,
} from "../store/transfer.ts";
import { appInfo } from "../version.ts";
import { KeyError, KeySetup, KeyStore } from "../keys.ts";
import { appPaths } from "../paths.ts";

/** Export and import of recordings as one `.conversation-recording` file (see docs/recordings.md § Export and import). */
export interface TransferApi {
  /** What an export would contain and weigh. */
  info(id: string): unknown;
  /** Writes the export file; the download follows with `file(token)`. */
  prepare(id: string, body: { audio?: unknown; chats?: unknown }): Promise<{ token: string; fileName: string; bytes: number }>;
  file(token: string): { path: string; fileName: string };
  importFile(body: AsyncIterable<Buffer>, fileName: string | null): Promise<unknown>;
  /** Imports a file the library already had, again, as a copy under `name` (the upload was kept by `importFile`). */
  importCopy(token: string, name: unknown): Promise<unknown>;
}

/** The chat window's commands, for the session on screen (see docs/chat.md). */
export interface ChatApi {
  models(): Promise<unknown>;
  list(): unknown;
  chat(id: string): Promise<unknown>;
  create(model?: string): Promise<unknown>;
  update(id: string, patch: { title?: unknown; model?: unknown }): Promise<unknown>;
  remove(id: string): unknown;
  stop(id: string): unknown;
  /** Validates, then returns the run that streams the reply. */
  prepare(id: string, body: { content?: unknown; mode?: unknown }): (sink: (e: ChatEvent) => void) => Promise<void>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** `features`: what runs beyond the transcript, fixed for the session; both on unless set to false. */
export type StartRequest =
  | { mode: "replay"; dir?: string; sessionId?: string; speed?: Speed | "1"; name?: string; voices?: number; features?: Partial<Features> }
  | { mode: "live"; mic?: string; name?: string; voices?: number; features?: Partial<Features> };

function parseFeatures(f: unknown): Partial<Features> {
  if (f === undefined || f === null) return {};
  if (typeof f !== "object") throw new ApiError(400, "features must be an object");
  const out: Partial<Features> = {};
  for (const k of ["factcheck", "labels"] as const) {
    const v = (f as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new ApiError(400, `features.${k} must be true or false`);
    out[k] = v;
  }
  return out;
}

/** What the HTTP layer needs from the engine. The front end is a thin client of exactly this. */
export interface EngineApi {
  bus: EventBus;
  state(): unknown;
  start(req: StartRequest): Promise<{ sessionId: string }>;
  stop(): Promise<{ sessionId: string }>;
  devices(): Promise<unknown[]>;
  renameSpeaker(id: string, displayName: string): unknown;
  mergeSpeakers(fromId: string, intoId: string): unknown;
  putLabels(body: unknown): { version: string };
  relabel(): { segments: number };
  putStories(headlines: string[]): { version: string };
  override(claimId: string, note?: string): unknown;
  rollback(version: string): unknown;
  stats(): unknown;
  listSessions(q?: string, includeTools?: boolean): unknown[];
  getSession(id: string): unknown;
  updateSession(id: string, patch: { name?: string; notes?: string }): unknown;
  openSession(id: string): { sessionId: string; events: number };
  deleteSession(id: string): { deleted: string };
  closeView(): { closed: string | null };
  callLog(system: "s1" | "s2", limit?: number): unknown;
  /** A recording's folder, for serving its audio (throws for an unknown id). */
  sessionDir(id: string): string;
  speakerSuggestions(remoteVoices?: number): Promise<unknown>;
  pause(): { paused: boolean };
  resume(): { paused: boolean };
  /** Absent: the chat routes answer 501. */
  chat?: ChatApi;
  /** Absent: the export and import routes answer 501. */
  transfer?: TransferApi;
}

/** Replay sources for a fixture or a session folder: host.wav and/or remote.wav. */
export function replaySources(dir: string, speed: Speed): AudioSource[] {
  const sources: AudioSource[] = [];
  for (const stream of ["host", "remote"] as const) {
    const p = join(dir, `${stream}.wav`);
    if (existsSync(p)) sources.push(new FileSource(p, stream, speed));
  }
  if (sources.length === 0) throw new ApiError(400, `no host.wav or remote.wav in ${dir}`);
  return sources;
}

export interface LiveCapture {
  sources: AudioSource[];
  stop(): Promise<void>;
}

export type CaptureStatusHandler = (type: "error" | "health", data: Record<string, unknown>) => void;

export interface EngineOptions {
  config?: Config;
  sessionsDir?: string;
  allowOverDevCap?: boolean;
  session?: Partial<SessionOptions>;
  /** Tier 2: starts the native capture helper. */
  live?: (mic: string | undefined, onStatus: CaptureStatusHandler) => Promise<LiveCapture>;
  devices?: () => Promise<unknown[]>;
  /** The chat window's network access (tests pass a fake). */
  fetch?: typeof fetch;
  openrouterKey?: string;
}

/** The engine: owns one session at a time, its event bus, and the host commands. */
export class Engine implements EngineApi {
  readonly bus = new EventBus({ redact: processSecrets(), onInvalid: (t, m) => console.error(`event ${t} failed validation: ${m}`) });
  private session: Session | null = null;
  private capture: LiveCapture | null = null;
  private captureDetail: Record<string, unknown> | null = null;
  /** A past session being viewed read-only, rebuilt from its events. */
  private archived: string | null = null;
  readonly library: SessionLibrary;
  readonly chat: ChatService;
  private readonly config: Config;

  constructor(private readonly opts: EngineOptions = {}) {
    this.config = opts.config ?? loadConfig();
    this.library = new SessionLibrary(opts.sessionsDir);
    this.chat = new ChatService(this.config.app.chat, {
      fetch: (...a) => (opts.fetch ?? fetch)(...a),
      // read on each call: a key saved from the setup page applies at once
      get apiKey() { return opts.openrouterKey ?? process.env.OPENROUTER_API_KEY ?? ""; },
      source: () => this.chatSource(),
      onSpend: (src) => this.chatSpent(src),
    });
  }

  private readonly exports = new Map<string, { path: string; fileName: string }>();
  /** Uploads of a recording the library already had, kept for a possible copy. */
  private readonly uploads = new Map<string, { path: string; fileName: string | null }>();

  readonly transfer: TransferApi = {
    info: (id) => {
      const dir = this.libraryCall(() => this.library.dirOf(id));
      const s = this.library.get(id);
      return { id, name: s.name, fileName: exportFileName(s.name, id), recordedWith: s.appVersion, app: appInfo(), ...exportEstimate(dir) };
    },
    prepare: async (id, body) => {
      const dir = this.libraryCall(() => this.library.dirOf(id));
      if (this.session && this.session.id === id && this.session.status !== "ended") throw new ApiError(409, "stop the session before exporting it");
      const audio = (body?.audio ?? "compressed") as AudioChoice;
      if (!["compressed", "original", "none"].includes(audio)) throw new ApiError(400, "audio must be compressed, original, or none");
      if (body?.chats !== undefined && typeof body.chats !== "boolean") throw new ApiError(400, "chats must be true or false");
      const r = await this.transferCall(() => exportRecording(dir, id, { audio, chats: body?.chats === true, app: appInfo() }));
      const token = randomUUID();
      this.exports.set(token, { path: r.path, fileName: r.fileName });
      // a download not collected within 15 minutes is deleted
      setTimeout(() => { if (this.exports.delete(token)) void rm(r.path, { force: true }); }, 15 * 60_000).unref();
      return { token, fileName: r.fileName, bytes: r.bytes };
    },
    file: (token) => {
      const f = this.exports.get(token);
      if (!f) throw new ApiError(404, "this export has expired: export again");
      return f;
    },
    importFile: async (body, fileName) => {
      const tmp = await this.transferCall(() => saveUpload(body, MAX_UPLOAD_BYTES));
      let keep = false;
      try {
        const { id, manifest } = await importRecording(tmp, this.library.root, fileName);
        return { summary: this.library.get(id), manifest, already: false };
      } catch (e) {
        // the same recording again: nothing is added, and the page offers the one already here — or a copy of it,
        // from this same upload, kept for 15 minutes so a long show is not sent twice
        if (e instanceof TransferError && e.status === 409 && (e as any).id) {
          keep = true;
          const copyToken = randomUUID();
          this.uploads.set(copyToken, { path: tmp, fileName });
          setTimeout(() => { if (this.uploads.delete(copyToken)) void discard(tmp); }, 15 * 60_000).unref();
          return { summary: this.library.get((e as any).id), already: true, copyToken };
        }
        throw e instanceof TransferError ? new ApiError(e.status, e.message) : e;
      } finally {
        if (!keep) await discard(tmp);
      }
    },
    importCopy: async (token, name) => {
      const up = this.uploads.get(token);
      if (!up) throw new ApiError(404, "the upload has expired: import the file again");
      if (typeof name !== "string" || !name.trim()) throw new ApiError(400, "a name is required for the copy");
      if (name.trim().length > 120) throw new ApiError(400, "name is too long");
      this.uploads.delete(token);
      try {
        const { id, manifest } = await this.transferCall(() => importRecording(up.path, this.library.root, up.fileName, { copy: true }));
        return { summary: this.library.update(id, { name: name.trim() }), manifest, already: false };
      } finally {
        await discard(up.path);
      }
    },
  };

  private async transferCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TransferError) throw new ApiError(e.status, e.message);
      throw e;
    }
  }

  /** A prepared export, once downloaded, is deleted. */
  exportSent(token: string) {
    const f = this.exports.get(token);
    if (!f) return;
    this.exports.delete(token);
    void rm(f.path, { force: true });
  }

  /** What the chat talks about: the session on air, or the recording on screen. */
  private chatSource(): ChatSource | null {
    const s = this.session;
    if (s && !this.archived) {
      return { sessionId: s.id, dir: s.store.dir, live: s.status === "running", lines: () => s.transcriptLines(), budget: s.budget };
    }
    const id = this.archived;
    if (!id) return null;
    const dir = this.libraryCall(() => this.library.dirOf(id));
    return { sessionId: id, dir, live: false, lines: () => this.library.transcript(id) };
  }

  /** A recording has no running ledger: its header cost is refreshed from its files (the session's own emits `cost`). */
  private chatSpent(src: ChatSource) {
    if (src.budget || this.archived !== src.sessionId) return;
    const s = this.library.get(src.sessionId);
    const cap = this.library.snapshot(src.sessionId).cost.sessionCapUsd;
    this.bus.emit("cost", { ...s.cost, session: s.costUsd, sessionCapUsd: cap }, { transient: true });
  }

  get current(): Session | null {
    return this.session;
  }

  private need(): Session {
    if (this.archived) throw new ApiError(409, "viewing a recorded session: start or replay one to use this command");
    if (!this.session) throw new ApiError(409, "no session");
    return this.session;
  }

  state() {
    if (this.archived) return this.library.snapshot(this.archived);
    if (!this.session) return { session: null };
    const st = this.session.state();
    let name: string | null = null;
    try { name = this.library.get(this.session.id).name; } catch { /* not listed yet */ }
    return { ...st, session: { ...st.session, name } };
  }

  private libraryCall<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new ApiError(/unknown session|invalid session/.test(m) ? 404 : 400, m);
    }
  }

  listSessions(q?: string, includeTools = false) {
    return this.library.list({ q, includeTools });
  }

  getSession(id: string) {
    return this.libraryCall(() => this.library.get(id));
  }

  updateSession(id: string, patch: { name?: string; notes?: string }) {
    return this.libraryCall(() => this.library.update(id, patch ?? {}));
  }

  /** Shows a recorded session exactly as it was, from its events: no audio is processed and nothing is spent. */
  openSession(id: string) {
    if (this.session && this.session.status !== "ended") throw new ApiError(409, "a session is running: stop it first");
    const events = this.libraryCall(() => this.library.events(id));
    this.session = null;
    this.archived = id;
    this.bus.load(events);
    return { sessionId: id, events: events.length };
  }

  /** Deletes a recording; the running session cannot be deleted. If it is the one on screen, the view is cleared. */
  deleteSession(id: string) {
    if (this.session && this.session.id === id) throw new ApiError(409, "stop the session before deleting it");
    this.libraryCall(() => this.library.remove(id));
    if (this.archived === id) {
      this.archived = null;
      this.bus.reset();
    }
    return { deleted: id };
  }

  private embedder: Embedder | null = null;

  /**
   * Which speakers of the session on screen are probably the same person: from the live voiceprints while a session
   * runs, or from a recording's audio (about 25 s for two hours). `remoteVoices` is how many people were on the call;
   * by default the number the session ran with.
   */
  async speakerSuggestions(remoteVoices?: number): Promise<{ suggestions: MergeSuggestion[]; voices: { host: number; remote: number } }> {
    const cfgVoices = this.config.app.speakers.voicesPerStream;
    if (this.session && !this.archived) {
      const run = this.session.voices;
      const voices = { host: run.host ?? cfgVoices.host, remote: remoteVoices ?? run.remote ?? cfgVoices.remote };
      // talk time per speaker, from the session's stats
      const talk = new Map(this.session.stats().speakers.map((s) => [s.speakerId, s.talkMs]));
      const prints = this.session.speakers.voiceprints().map((p) => ({ ...p, talkMs: talk.get(p.id) ?? 0 }));
      return { suggestions: suggestMerges(prints, voices), voices };
    }
    const id = this.archived;
    if (!id) throw new ApiError(409, "no session");
    const { dir, voices: ran } = this.libraryCall(() => this.library.voicesOf(id));
    const voices = { host: ran?.host ?? cfgVoices.host, remote: remoteVoices ?? ran?.remote ?? cfgVoices.remote };
    const sp = this.library.speakers(id);
    this.embedder ??= new Embedder();
    const prints = await recordedVoiceprints(dir, this.embedder, (x) => resolveRecorded(sp, x), sp.names);
    return { suggestions: suggestMerges(prints, voices), voices };
  }

  sessionDir(id: string): string {
    return this.libraryCall(() => this.library.dirOf(id));
  }

  /** The session on screen's recent Jev or System 2 calls (none without a session). */
  callLog(system: "s1" | "s2", limit?: number) {
    const id = this.archived ?? this.session?.id;
    if (!id) return { rows: [], models: { s1: this.config.app.jev.model, s2: this.config.app.s2.model } };
    return this.libraryCall(() => this.library.calls(id, system, limit));
  }

  /** Leaves an opened recording's view, back to no session (the page's "/"). A live or replay session is not affected. */
  closeView() {
    const id = this.archived;
    if (!id) return { closed: null };
    this.archived = null;
    this.bus.reset();
    return { closed: id };
  }

  pause() {
    const s = this.need();
    if (s.mode !== "live") throw new ApiError(409, "only a live session can be paused");
    if (s.status !== "running") throw new ApiError(409, "the session is ending");
    s.pause();
    return { paused: true };
  }

  resume() {
    const s = this.need();
    if (s.status !== "running") throw new ApiError(409, "the session is ending");
    s.resume();
    return { paused: false };
  }

  async start(req: StartRequest): Promise<{ sessionId: string }> {
    if (this.session && this.session.status !== "ended") throw new ApiError(409, "a session is already running");
    const features = parseFeatures(req?.features);
    let sources: AudioSource[];
    let mode: "replay" | "live";
    let liveText = false;
    if (req?.mode === "replay") {
      const dir = req.sessionId ? this.libraryCall(() => this.library.dirOf(req.sessionId!)) : req.dir;
      if (typeof dir !== "string" || !dir) throw new ApiError(400, "dir or sessionId is required");
      const speed: Speed = req.speed === "max" ? "max" : 1;
      sources = replaySources(dir, speed);
      mode = "replay";
      liveText = speed === 1; // streaming text only makes sense at real-time pace
    } else if (req?.mode === "live") {
      if (!this.opts.live) throw new ApiError(501, "live capture is not available");
      this.captureDetail = null;
      this.capture = await this.opts.live(req.mic, (type, data) => {
        if (type === "error") this.session?.emit("error", data);
        else {
          this.captureDetail = (data.capture as Record<string, unknown>) ?? data;
          this.followOutput();
        }
      });
      sources = this.capture.sources;
      mode = "live";
      liveText = true;
    } else {
      throw new ApiError(400, "mode must be replay or live");
    }
    this.archived = null;
    this.bus.reset();
    this.session = new Session({
      mode, sources, config: structuredClone(this.config), bus: this.bus, sessionsDir: this.opts.sessionsDir,
      allowOverDevCap: this.opts.allowOverDevCap, healthDetail: () => this.captureDetail, liveText, features,
      // how many people are on the call (the remote stream); 0 means no limit
      ...(Number.isInteger(req.voices) && req.voices! >= 0 ? { voices: { remote: req.voices } } : {}),
      ...this.opts.session,
    });
    const s = this.session;
    // When it ends, the session becomes a recording: the page shows it exactly as a reopened one.
    s.run()
      .then(() => { if (this.session === s) { this.session = null; this.archived = s.id; } })
      .catch((e) => console.error("session failed:", e));
    if (mode === "live") this.followOutput(); // after session.started: the helper may already have said where the call plays
    // after run() has written session.json, which makes the folder a recording the library can name
    if (typeof req.name === "string" && req.name.trim()) this.library.update(s.id, { name: req.name });
    return { sessionId: s.id };
  }

  /** Tells a live session where the call plays (the helper's `remote.outputKind`), which drives its echo gate. */
  private followOutput() {
    const remote = this.captureDetail?.remote as { outputKind?: unknown; outputDevice?: unknown } | undefined;
    if (!remote || this.session?.mode !== "live") return;
    const kind = remote.outputKind === "speakers" || remote.outputKind === "headphones" || remote.outputKind === "virtual" ? remote.outputKind : null;
    this.session.setOutput(kind, typeof remote.outputDevice === "string" ? remote.outputDevice : null);
  }

  async stop(): Promise<{ sessionId: string }> {
    const s = this.need();
    if (this.capture) {
      await this.capture.stop();
      this.capture = null;
    }
    await s.stop();
    return { sessionId: s.id };
  }

  async devices(): Promise<unknown[]> {
    if (!this.opts.devices) throw new ApiError(501, "device listing is not available");
    return this.opts.devices();
  }

  renameSpeaker(id: string, displayName: string) {
    if (this.archived) {
      const rec = this.archived;
      const sp = this.library.speakers(rec);
      const target = resolveRecorded(sp, id);
      if (!sp.names.has(target)) throw new ApiError(404, `unknown speaker ${id}`);
      if (typeof displayName !== "string" || !displayName.trim()) throw new ApiError(400, "displayName is required");
      const name = displayName.trim();
      this.library.recordSpeakerEdit(rec, this.bus.emit("speaker.updated", { id: target, displayName: name }));
      return { id: target, displayName: name };
    }
    const s = this.need();
    if (!s.speakers.get(id)) throw new ApiError(404, `unknown speaker ${id}`);
    if (typeof displayName !== "string" || !displayName.trim()) throw new ApiError(400, "displayName is required");
    return s.renameSpeaker(id, displayName);
  }

  mergeSpeakers(fromId: string, intoId: string) {
    if (this.archived) {
      const rec = this.archived;
      const sp = this.library.speakers(rec);
      const from = resolveRecorded(sp, fromId);
      const into = resolveRecorded(sp, intoId);
      if (!sp.names.has(from) || !sp.names.has(into)) throw new ApiError(404, "unknown speaker");
      if (from === into) throw new ApiError(400, "cannot merge a speaker into itself");
      const displayName = sp.names.get(into)!;
      // A recording keeps no voiceprints, so the merge relabels lines only.
      this.library.recordSpeakerEdit(rec, this.bus.emit("speaker.merged", { fromId: from, intoId: into, displayName }));
      return { id: into, displayName };
    }
    const s = this.need();
    if (!s.speakers.get(fromId) || !s.speakers.get(intoId)) throw new ApiError(404, "unknown speaker");
    return s.mergeSpeakers(fromId, intoId);
  }

  /** The running session, if it runs `feature`: a command for a feature that is off cannot turn it on. */
  private needFeature(feature: keyof Features): Session {
    const s = this.need();
    if (!s.features[feature]) {
      throw new ApiError(409, feature === "labels" ? "labels are off for this session" : "fact-checking is off for this session");
    }
    return s;
  }

  putLabels(body: unknown) {
    const s = this.needFeature("labels");
    try {
      return { version: s.timeline.replaceLabels(body) };
    } catch (e) {
      if (e instanceof LabelConflictError) throw new ApiError(409, e.message);
      throw new ApiError(400, e instanceof Error ? e.message : String(e));
    }
  }

  relabel() {
    return { segments: this.needFeature("labels").timeline.relabel() };
  }

  putStories(headlines: string[]) {
    if (!Array.isArray(headlines) || headlines.some((h) => typeof h !== "string")) throw new ApiError(400, "headlines must be an array of strings");
    return { version: this.needFeature("labels").timeline.setStories(headlines) };
  }

  override(claimId: string, note?: string) {
    const s = this.needFeature("factcheck");
    if (!s.factcheck.claims.has(claimId)) throw new ApiError(404, `unknown claim ${claimId}`);
    return s.factcheck.override(claimId, note);
  }

  rollback(version: string) {
    const s = this.needFeature("factcheck");
    if (!s.factcheck.versions.some((v) => v.id === version)) throw new ApiError(404, `unknown version ${version}`);
    return { active: s.factcheck.rollback(version).id };
  }

  stats() {
    return this.need().stats();
  }
}

// ---------- HTTP ----------

const BOOTED_AT = Date.now();

/**
 * The project's version and license, for the page's menu footer. The version lives only in the root package.json;
 * both files are read on each request, so a release shows without restarting.
 */
export function about(root = appPaths().root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const text = existsSync(join(root, "LICENSE")) ? readFileSync(join(root, "LICENSE"), "utf8") : "";
  return { name: pkg.name, version: pkg.version, license: { id: pkg.license ?? null, holder: pkg.author ?? null, text } };
}

/** True when engine code under src/ changed after this server started: the page asks for a restart. Never in the Mac app, which has no sources. */
export function engineStale(srcDir = appPaths().src, since = BOOTED_AT): boolean {
  if (!srcDir) return false;
  const walk = (dir: string): boolean => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() ? walk(p) : e.name.endsWith(".ts") && statSync(p).mtimeMs > since) return true;
    }
    return false;
  };
  try { return walk(srcDir); } catch { return false; }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".map": "application/json", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new ApiError(413, "body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
}

/** Streams a chat reply as server-sent events: start, thinking, delta…, then done (after error, if it failed). */
async function streamChat(res: ServerResponse, run: (sink: (e: ChatEvent) => void) => Promise<void>) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  // the page may leave mid-reply: the reply still completes and is saved, so a reload shows it
  const sink = (e: ChatEvent) => { if (!res.writableEnded && !res.destroyed) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); };
  try {
    await run(sink);
  } catch (e) {
    sink({ type: "error", message: e instanceof Error ? e.message : String(e), chat: null });
  }
  res.end();
}

function sse(res: ServerResponse, e: AppEvent) {
  res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

/** Serves web/index.html at /, and web/styles.css, web/dist/** and web/fonts/** as static files, confined to web/. */
function serveStatic(webRoot: string, path: string, res: ServerResponse): boolean {
  let rel: string;
  // the page's own URLs (see docs/architecture.md): home, and an opened recording
  if (path === "/" || path === "/index.html" || /^\/recordings\/[A-Za-z0-9][A-Za-z0-9_-]*\/?$/.test(path)) rel = "index.html";
  else if (path === "/styles.css") rel = "styles.css";
  else if (path.startsWith("/dist/") || path.startsWith("/fonts/")) rel = path.slice(1);
  else return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return false;
  }
  const root = resolve(webRoot);
  const file = resolve(root, decoded);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
  return true;
}

/** What the setup routes need (see docs/setup.md); `KeySetup` in src/keys.ts. */
export interface SetupApi {
  status(): { configured: boolean };
  save(body: unknown): Promise<unknown>;
}

/**
 * The setup routes accept only the page itself: the Host must be this machine (no DNS rebinding) and a browser's
 * Origin must match it, so another website open in the browser can neither read the hints nor replace the keys.
 */
function fromThisPage(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

/** Routes that work before the keys are set: the setup page's own, and the page's footer. */
const OPEN_ROUTES = new Set(["/api/setup", "/api/setup/keys", "/api/about", "/api/engine"]);

export function createApiServer(engine: EngineApi, opts: { webRoot?: string; setup?: SetupApi } = {}): Server {
  const webRoot = opts.webRoot ?? appPaths().web;
  const setup = opts.setup;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const m = req.method ?? "GET";
    try {
      if (setup && path.startsWith("/api/setup")) {
        if (!fromThisPage(req)) throw new ApiError(403, "the setup routes answer only the page at 127.0.0.1");
        if (m === "GET" && path === "/api/setup") return send(res, 200, setup.status());
        if (m === "POST" && path === "/api/setup/keys") {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new ApiError(415, "expected JSON");
          return send(res, 200, await setup.save(await readJson(req)));
        }
      }
      // until both keys are set, the engine's routes wait: the page shows only the setup screen
      if (setup && path.startsWith("/api/") && !OPEN_ROUTES.has(path) && !setup.status().configured) {
        return send(res, 503, { error: "API keys are missing: open the page to add them", setup: true });
      }
      if (m === "GET" && path === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n");
        for (const e of engine.bus.history()) sse(res, e);
        const unsub = engine.bus.subscribe((e) => sse(res, e));
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => { unsub(); clearInterval(ping); });
        return;
      }
      if (m === "GET" && path === "/api/state") return send(res, 200, engine.state());
      if (m === "GET" && path === "/api/calls") {
        const system = url.searchParams.get("system") === "s2" ? "s2" : "s1";
        const limit = Number(url.searchParams.get("limit")) || undefined;
        return send(res, 200, engine.callLog(system, limit));
      }
      if (m === "GET" && path === "/api/about") return send(res, 200, about());
      if (m === "GET" && path === "/api/engine") return send(res, 200, { startedAt: new Date(BOOTED_AT).toISOString(), stale: engineStale() });
      if (m === "GET" && path === "/api/stats") return send(res, 200, engine.stats());
      if (m === "GET" && path === "/api/devices") return send(res, 200, await engine.devices());
      if (m === "POST" && path === "/api/session/start") return send(res, 200, await engine.start(await readJson(req)));
      if (m === "POST" && path === "/api/session/stop") return send(res, 200, await engine.stop());
      if (m === "POST" && path === "/api/sessions/close") return send(res, 200, engine.closeView());
      if (m === "POST" && path === "/api/session/pause") return send(res, 200, engine.pause());
      if (m === "POST" && path === "/api/session/resume") return send(res, 200, engine.resume());
      if (m === "GET" && path === "/api/speakers/suggestions") {
        const v = url.searchParams.get("voices");
        return send(res, 200, await engine.speakerSuggestions(v === null || v === "" ? undefined : Math.max(0, Number(v) || 0)));
      }
      if (m === "POST" && path === "/api/speakers/merge") {
        const b = await readJson(req);
        return send(res, 200, engine.mergeSpeakers(b.fromId, b.intoId));
      }
      let mm = path.match(/^\/api\/speakers\/([^/]+)\/rename$/);
      if (m === "POST" && mm) return send(res, 200, engine.renameSpeaker(decodeURIComponent(mm[1]), (await readJson(req)).displayName));
      if (m === "PUT" && path === "/api/labels") return send(res, 200, engine.putLabels(await readJson(req)));
      if (m === "POST" && path === "/api/labels/relabel") return send(res, 202, engine.relabel());
      if (m === "PUT" && path === "/api/stories") return send(res, 200, engine.putStories((await readJson(req)).headlines));
      mm = path.match(/^\/api\/claims\/([^/]+)\/override$/);
      if (m === "POST" && mm) return send(res, 200, engine.override(decodeURIComponent(mm[1]), (await readJson(req)).note));
      if (m === "GET" && path === "/api/sessions") {
        return send(res, 200, engine.listSessions(url.searchParams.get("q") ?? undefined, url.searchParams.get("all") === "1"));
      }
      mm = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (m === "GET" && mm) return send(res, 200, engine.getSession(decodeURIComponent(mm[1])));
      if (m === "PATCH" && mm) return send(res, 200, engine.updateSession(decodeURIComponent(mm[1]), await readJson(req)));
      if (m === "DELETE" && mm) return send(res, 200, engine.deleteSession(decodeURIComponent(mm[1])));
      mm = path.match(/^\/api\/sessions\/([^/]+)\/audio$/);
      if ((m === "GET" || m === "HEAD") && mm) return serveMixedAudio(engine.sessionDir(decodeURIComponent(mm[1])), req, res);
      mm = path.match(/^\/api\/sessions\/([^/]+)\/open$/);
      if (m === "POST" && mm) return send(res, 200, engine.openSession(decodeURIComponent(mm[1])));
      if (path === "/api/chat/models" || path.startsWith("/api/chats")) {
        const chat = engine.chat;
        if (!chat) throw new ApiError(501, "chat is not available");
        if (m === "GET" && path === "/api/chat/models") return send(res, 200, await chat.models());
        if (m === "GET" && path === "/api/chats") return send(res, 200, chat.list());
        if (m === "POST" && path === "/api/chats") return send(res, 200, await chat.create((await readJson(req)).model));
        mm = path.match(/^\/api\/chats\/([^/]+)$/);
        if (m === "GET" && mm) return send(res, 200, await chat.chat(decodeURIComponent(mm[1])));
        if (m === "PATCH" && mm) return send(res, 200, await chat.update(decodeURIComponent(mm[1]), await readJson(req)));
        if (m === "DELETE" && mm) return send(res, 200, chat.remove(decodeURIComponent(mm[1])));
        mm = path.match(/^\/api\/chats\/([^/]+)\/stop$/);
        if (m === "POST" && mm) return send(res, 200, chat.stop(decodeURIComponent(mm[1])));
        mm = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
        if (m === "POST" && mm) return await streamChat(res, chat.prepare(decodeURIComponent(mm[1]), await readJson(req)));
      }
      if (path.startsWith("/api/sessions/import") || path.startsWith("/api/exports/") || /^\/api\/sessions\/[^/]+\/export$/.test(path)) {
        const t = engine.transfer;
        if (!t) throw new ApiError(501, "export and import are not available");
        if (m === "POST" && path === "/api/sessions/import") {
          let name: string | null = null;
          try { name = req.headers["x-file-name"] ? decodeURIComponent(String(req.headers["x-file-name"])) : null; } catch { /* keep null */ }
          return send(res, 200, await t.importFile(req as AsyncIterable<Buffer>, name));
        }
        mm = path.match(/^\/api\/sessions\/import\/([0-9a-f-]{36})$/);
        if (m === "POST" && mm) return send(res, 200, await t.importCopy(mm[1], (await readJson(req)).name));
        mm = path.match(/^\/api\/sessions\/([^/]+)\/export$/);
        if (m === "GET" && mm) return send(res, 200, t.info(decodeURIComponent(mm[1])));
        if (m === "POST" && mm) return send(res, 200, await t.prepare(decodeURIComponent(mm[1]), await readJson(req)));
        mm = path.match(/^\/api\/exports\/([0-9a-f-]{36})$/);
        if (m === "GET" && mm) {
          const token = mm[1];
          const f = t.file(token);
          const ascii = f.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
          res.writeHead(200, {
            "Content-Type": "application/octet-stream", "Content-Length": statSync(f.path).size, "Cache-Control": "no-store",
            "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
          });
          const stream = createReadStream(f.path);
          stream.pipe(res);
          res.on("finish", () => (engine as { exportSent?: (t: string) => void }).exportSent?.(token));
          return;
        }
      }
      if (m === "POST" && path === "/api/s1/rollback") return send(res, 200, engine.rollback((await readJson(req)).version));
      if (m === "GET" && serveStatic(webRoot, path, res)) return;
      return send(res, 404, { error: "not found" });
    } catch (e) {
      const status = e instanceof ApiError || e instanceof ChatError || e instanceof KeyError ? e.status : 400;
      return send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

// ---------- Start-up, shared by npm run serve and the Mac app ----------

/**
 * Loads the keys (the environment and .env first, then the keys saved from the setup page), the config, and an engine
 * with native capture, and returns the API server for them, not yet listening: `npm run serve` listens on a port, the
 * Mac app serves it in-process (src/server/inProcess.ts).
 */
export function bootEngine(opts: { allowOverDevCap?: boolean } = {}) {
  const keys = new KeyStore().load();
  const config = loadConfig();
  const setup = new KeySetup(keys, {
    fetch: (...a) => fetch(...a),
    models: [config.app.transcription.model, ...(config.app.transcription.live?.enabled ? [config.app.transcription.live.model] : [])],
  });
  const engine = new Engine({
    config, allowOverDevCap: opts.allowOverDevCap,
    live: (mic, onStatus) => startNativeCapture({ mic: mic === "builtin" ? undefined : mic, onStatus }),
    devices: () => listDevices(),
  });
  return { keys, config, engine, server: createApiServer(engine, { setup }) };
}

// ---------- CLI: npm run serve [-- --replay <dir> --speed 1|max] ----------

async function main() {
  const { values } = parseArgs({
    options: {
      replay: { type: "string" }, speed: { type: "string", default: "1" }, port: { type: "string" },
      "allow-over-dev-cap": { type: "boolean", default: false },
    },
  });
  const { keys, config, engine, server } = bootEngine({ allowOverDevCap: values["allow-over-dev-cap"] });
  const port = Number(values.port ?? config.app.server.port);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Conversation Assistant on http://127.0.0.1:${port}`);
    const missing = keys.missing();
    if (missing.length) console.log(`API keys missing (${missing.join(", ")}): open the page above to add them`);
  });
  if (values.replay && keys.missing().length) {
    console.error("--replay needs both API keys: open the page to add them, then start the replay from there");
  } else if (values.replay) {
    const { sessionId } = await engine.start({ mode: "replay", dir: values.replay, speed: values.speed === "max" ? "max" : 1 });
    console.log(`replaying ${values.replay} at speed ${values.speed} as session ${sessionId}`);
  }
  const shutdown = async () => {
    if (engine.current && engine.current.status === "running") await engine.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
