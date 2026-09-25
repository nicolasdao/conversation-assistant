import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "../config.ts";
import { FileSource, type AudioSource, type Speed } from "../audio/source.ts";
import { Session, type SessionOptions } from "../pipeline/session.ts";
import { listDevices, startNativeCapture } from "../audio/nativeSource.ts";
import { LabelConflictError } from "../pipeline/timeline.ts";
import { EventBus, processSecrets, type AppEvent } from "../store/events.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type StartRequest =
  | { mode: "replay"; dir: string; speed?: Speed | "1" }
  | { mode: "live"; mic?: string };

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
}

/** The engine: owns one session at a time, its event bus, and the host commands. */
export class Engine implements EngineApi {
  readonly bus = new EventBus({ redact: processSecrets(), onInvalid: (t, m) => console.error(`event ${t} failed validation: ${m}`) });
  private session: Session | null = null;
  private capture: LiveCapture | null = null;
  private captureDetail: Record<string, unknown> | null = null;
  private readonly config: Config;

  constructor(private readonly opts: EngineOptions = {}) {
    this.config = opts.config ?? loadConfig();
  }

  get current(): Session | null {
    return this.session;
  }

  private need(): Session {
    if (!this.session) throw new ApiError(409, "no session");
    return this.session;
  }

  state() {
    return this.session ? this.session.state() : { session: null };
  }

  async start(req: StartRequest): Promise<{ sessionId: string }> {
    if (this.session && this.session.status !== "ended") throw new ApiError(409, "a session is already running");
    let sources: AudioSource[];
    let mode: "replay" | "live";
    let liveText = false;
    if (req?.mode === "replay") {
      if (typeof req.dir !== "string" || !req.dir) throw new ApiError(400, "dir is required");
      const speed: Speed = req.speed === "max" ? "max" : 1;
      sources = replaySources(req.dir, speed);
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
    this.bus.reset();
    this.session = new Session({
      mode, sources, config: structuredClone(this.config), bus: this.bus, sessionsDir: this.opts.sessionsDir,
      allowOverDevCap: this.opts.allowOverDevCap, healthDetail: () => this.captureDetail, liveText, ...this.opts.session,
    });
    const s = this.session;
    s.run().catch((e) => console.error("session failed:", e));
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
    const s = this.need();
    if (!s.speakers.get(id)) throw new ApiError(404, `unknown speaker ${id}`);
    if (typeof displayName !== "string" || !displayName.trim()) throw new ApiError(400, "displayName is required");
    return s.renameSpeaker(id, displayName);
  }

  mergeSpeakers(fromId: string, intoId: string) {
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

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".map": "application/json", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
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

function sse(res: ServerResponse, e: AppEvent) {
  res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

/** Serves web/index.html at /, and web/styles.css and web/dist/** as static files, confined to web/. */
function serveStatic(webRoot: string, path: string, res: ServerResponse): boolean {
  let rel: string;
  if (path === "/" || path === "/index.html") rel = "index.html";
  else if (path === "/styles.css") rel = "styles.css";
  else if (path.startsWith("/dist/")) rel = path.slice(1);
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
      if (m === "GET" && path === "/api/stats") return send(res, 200, engine.stats());
      if (m === "GET" && path === "/api/devices") return send(res, 200, await engine.devices());
      if (m === "POST" && path === "/api/session/start") return send(res, 200, await engine.start(await readJson(req)));
      if (m === "POST" && path === "/api/session/stop") return send(res, 200, await engine.stop());
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
      if (m === "POST" && path === "/api/s1/rollback") return send(res, 200, engine.rollback((await readJson(req)).version));
      if (m === "GET" && serveStatic(webRoot, path, res)) return;
      return send(res, 404, { error: "not found" });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 400;
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
