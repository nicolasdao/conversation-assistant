import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "../config.ts";
import { FileSource, type AudioSource, type Speed } from "../audio/source.ts";
import { Session, type SessionOptions } from "../pipeline/session.ts";
import { listDevices, startNativeCapture } from "../audio/nativeSource.ts";
import { LabelConflictError } from "../pipeline/timeline.ts";
import { EventBus, processSecrets, type AppEvent } from "../store/events.ts";
import { resolveRecorded, SessionLibrary } from "../store/library.ts";
import { Embedder } from "../speakers/registry.ts";
import { recordedVoiceprints, suggestMerges, type MergeSuggestion } from "../speakers/suggest.ts";
import { serveMixedAudio } from "./audio.ts";
import { ChatError, ChatService, type ChatEvent, type ChatSource } from "../chat/chat.ts";

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

export type StartRequest =
  | { mode: "replay"; dir?: string; sessionId?: string; speed?: Speed | "1"; name?: string; voices?: number }
  | { mode: "live"; mic?: string; name?: string; voices?: number };

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
    this.library = new SessionLibrary(opts.sessionsDir ?? "sessions");
    this.chat = new ChatService(this.config.app.chat, {
      fetch: (...a) => (opts.fetch ?? fetch)(...a),
      apiKey: opts.openrouterKey ?? process.env.OPENROUTER_API_KEY ?? "",
      source: () => this.chatSource(),
      onSpend: (src) => this.chatSpent(src),
    });
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
        else this.captureDetail = (data.capture as Record<string, unknown>) ?? data;
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
      allowOverDevCap: this.opts.allowOverDevCap, healthDetail: () => this.captureDetail, liveText,
      // how many people are on the call (the remote stream); 0 means no limit
      ...(Number.isInteger(req.voices) && req.voices! >= 0 ? { voices: { remote: req.voices } } : {}),
      ...this.opts.session,
    });
    const s = this.session;
    if (typeof req.name === "string" && req.name.trim()) this.library.update(s.id, { name: req.name });
    // When it ends, the session becomes a recording: the page shows it exactly as a reopened one.
    s.run()
      .then(() => { if (this.session === s) { this.session = null; this.archived = s.id; } })
      .catch((e) => console.error("session failed:", e));
    return { sessionId: s.id };
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

  putLabels(body: unknown) {
    const s = this.need();
    try {
      return { version: s.timeline.replaceLabels(body) };
    } catch (e) {
      if (e instanceof LabelConflictError) throw new ApiError(409, e.message);
      throw new ApiError(400, e instanceof Error ? e.message : String(e));
    }
  }

  relabel() {
    return { segments: this.need().timeline.relabel() };
  }

  putStories(headlines: string[]) {
    if (!Array.isArray(headlines) || headlines.some((h) => typeof h !== "string")) throw new ApiError(400, "headlines must be an array of strings");
    return { version: this.need().timeline.setStories(headlines) };
  }

  override(claimId: string, note?: string) {
    const s = this.need();
    if (!s.factcheck.claims.has(claimId)) throw new ApiError(404, `unknown claim ${claimId}`);
    return s.factcheck.override(claimId, note);
  }

  rollback(version: string) {
    const s = this.need();
    if (!s.factcheck.versions.some((v) => v.id === version)) throw new ApiError(404, `unknown version ${version}`);
    return { active: s.factcheck.rollback(version).id };
  }

  stats() {
    return this.need().stats();
  }
}

// ---------- HTTP ----------

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOTED_AT = Date.now();

/**
 * The project's version and license, for the page's menu footer. The version lives only in the root package.json;
 * both files are read on each request, so a release shows without restarting.
 */
export function about(root = resolve(SRC_DIR, "..")) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const text = existsSync(join(root, "LICENSE")) ? readFileSync(join(root, "LICENSE"), "utf8") : "";
  return { name: pkg.name, version: pkg.version, license: { id: pkg.license ?? null, holder: pkg.author ?? null, text } };
}

/** True when engine code under src/ changed after this server started: the page asks for a restart. */
export function engineStale(srcDir = SRC_DIR, since = BOOTED_AT): boolean {
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

export function createApiServer(engine: EngineApi, opts: { webRoot?: string } = {}): Server {
  const webRoot = opts.webRoot ?? "web";
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const m = req.method ?? "GET";
    try {
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
      if (m === "POST" && path === "/api/s1/rollback") return send(res, 200, engine.rollback((await readJson(req)).version));
      if (m === "GET" && serveStatic(webRoot, path, res)) return;
      return send(res, 404, { error: "not found" });
    } catch (e) {
      const status = e instanceof ApiError || e instanceof ChatError ? e.status : 400;
      return send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

// ---------- CLI: npm run serve [-- --replay <dir> --speed 1|max] ----------

async function main() {
  const { values } = parseArgs({
    options: {
      replay: { type: "string" }, speed: { type: "string", default: "1" }, port: { type: "string" },
      "allow-over-dev-cap": { type: "boolean", default: false },
    },
  });
  const config = loadConfig();
  const engine = new Engine({
    config, allowOverDevCap: values["allow-over-dev-cap"],
    live: (mic, onStatus) => startNativeCapture({ mic: mic === "builtin" ? undefined : mic, onStatus }),
    devices: () => listDevices(),
  });
  const port = Number(values.port ?? config.app.server.port);
  const server = createApiServer(engine);
  server.listen(port, "127.0.0.1", () => console.log(`Podcast Assistant on http://127.0.0.1:${port}`));
  if (values.replay) {
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
