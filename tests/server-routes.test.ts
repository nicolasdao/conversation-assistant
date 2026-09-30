import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { connect } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, createApiServer, Engine, type ChatApi, type EngineApi, type LabelSetApi, type TranscriptionApi, type TransferApi } from "../src/server/main.ts";
import { ChatError, type ChatEvent } from "../src/chat/chat.ts";
import { KeyError, KeySetup, KeyStore } from "../src/keys.ts";
import { LabelSetError } from "../src/labels/store.ts";
import { setAppPaths } from "../src/paths.ts";
import { wavHeader } from "../src/audio/wav.ts";
import { cleanTmpDirs, deferred, FakeEngine, fakeKeyCheckFetch, tmpDir, transcribeOnlyServices } from "./fakes/index.ts";
import { http, listen, openStream } from "./fakes/http.ts";

// The HTTP router (createApiServer in src/server/main.ts) over a real socket, with engines that script each answer.
// The real engine's own behaviour is in tests/engine.test.ts.

/** A static web root with every kind of file the page serves. */
function webRoot(): string {
  const web = tmpDir("web-");
  for (const d of ["dist", "fonts", "dist/sub"]) mkdirSync(join(web, d), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(web, "licenses.html"), "<!doctype html><title>l</title>");
  writeFileSync(join(web, "styles.css"), "body{}");
  for (const f of ["app.js", "app.js.map", "data.json", "icon.svg", "logo.png", "favicon.ico", "notes.txt"]) writeFileSync(join(web, "dist", f), "x");
  writeFileSync(join(web, "fonts", "face.woff2"), "wOF2");
  return web;
}

afterAll(() => cleanTmpDirs());

/** FakeEngine, plus a switch that makes /api/stats throw what a test chooses. */
class ScriptedEngine extends FakeEngine {
  failWith: unknown = null;
  override stats() {
    if (this.failWith) throw this.failWith;
    return super.stats();
  }
}

describe("an engine without the optional parts", () => {
  const engine = new ScriptedEngine();
  const server = createApiServer(engine, { webRoot: webRoot() });
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => ({ base, close } = await listen(server)));
  afterAll(() => close());

  test("every chat route answers 501 when the engine has no chat", async () => {
    for (const [m, p] of [["GET", "/api/chat/models"], ["GET", "/api/chats"], ["POST", "/api/chats"], ["GET", "/api/chats/x"], ["PATCH", "/api/chats/x"],
      ["DELETE", "/api/chats/x"], ["POST", "/api/chats/x/stop"], ["POST", "/api/chats/x/messages"]]) {
      const r = await http(base, m, p, m === "GET" || m === "DELETE" ? {} : { body: {} });
      expect([m, p, r.status, r.json]).toEqual([m, p, 501, { error: "chat is not available" }]);
    }
  });

  test("every export and import route answers 501 when the engine has no transfer", async () => {
    const token = "0123abcd-0123-4567-89ab-0123456789ab";
    for (const [m, p] of [["POST", "/api/sessions/import"], ["POST", `/api/sessions/import/${token}`], ["GET", "/api/sessions/x/export"],
      ["POST", "/api/sessions/x/export"], ["GET", `/api/exports/${token}`]]) {
      const r = await http(base, m, p, m === "GET" ? {} : { body: {} });
      expect([m, p, r.status, r.json]).toEqual([m, p, 501, { error: "export and import are not available" }]);
    }
  });

  test("the transcription and label-set routes answer 501 without their parts", async () => {
    expect((await http(base, "GET", "/api/transcription")).status).toBe(501);
    expect((await http(base, "POST", "/api/transcription/install")).json).toEqual({ error: "the transcription setting is not available" });
    expect((await http(base, "GET", "/api/label-sets")).json).toEqual({ error: "label sets are not available" });
    expect((await http(base, "GET", "/api/label-sets/x/export")).status).toBe(501);
  });

  test("an error keeps its status when it carries one; anything else is a 400", async () => {
    const cases: [unknown, number, Record<string, unknown>][] = [
      [new ApiError(402, "out of credit", { needsKey: "openrouter" }), 402, { error: "out of credit", needsKey: "openrouter" }],
      [new ChatError(418, "teapot"), 418, { error: "teapot" }],
      [new KeyError(409, "set in .env"), 409, { error: "set in .env" }],
      [new LabelSetError(404, "no such set"), 404, { error: "no such set" }],
      [Object.assign(new Error("ENOENT: no such file"), { status: 500 }), 400, { error: "ENOENT: no such file" }],
      ["a thrown string", 400, { error: "a thrown string" }],
    ];
    for (const [e, status, body] of cases) {
      engine.failWith = e;
      const r = await http(base, "GET", "/api/stats");
      expect([r.status, r.json]).toEqual([status, body]);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    engine.failWith = null;
  });

  test("request bodies: empty is {}, 'null' reaches the handler as null, malformed is a 400, over 1 MB a 413", async () => {
    await http(base, "POST", "/api/session/start", { body: "", headers: { "content-type": "application/json" } });
    expect(engine.calls.at(-1)).toEqual(["start", {}]);
    await http(base, "POST", "/api/session/start", { body: "  \n ", headers: { "content-type": "application/json" } });
    expect(engine.calls.at(-1)).toEqual(["start", {}]);
    // `null` parses; reading a field of it is a TypeError, answered 400
    const nul = await http(base, "POST", "/api/speakers/spk_1/rename", { body: "null" });
    expect(nul.status).toBe(400);
    expect(nul.json.error).toMatch(/null/);
    expect((await http(base, "POST", "/api/session/start", { body: "{bad" })).json).toEqual({ error: "invalid JSON body" });
    const big = await http(base, "POST", "/api/session/start", { body: Buffer.alloc(1_000_001, 0x20) }).catch((e: NodeJS.ErrnoException) => ({ status: e.code, json: null }));
    // the router answers before reading the rest: the client sees the 413, or the connection reset under it
    expect([413, "ECONNRESET", "EPIPE"]).toContain(big.status);
    if (big.status === 413) expect(big.json).toEqual({ error: "body too large" });
  });

  test("ids in the path are URI-decoded; a malformed escape is a 400", async () => {
    expect((await http(base, "GET", "/api/sessions/20260925%2D120000")).json).toEqual({ id: "20260925-120000" });
    const bad = await http(base, "GET", "/api/sessions/%E0%A4%A");
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/URI/);
    expect((await http(base, "POST", "/api/speakers/%E0%A4%A/rename", { body: { displayName: "x" } })).status).toBe(400);
  });

  test("query parameters: the call log's system and limit, and the suggestions' voice count", async () => {
    expect((await http(base, "GET", "/api/calls?system=anything&limit=0")).json.rows).toEqual([{ system: "s1" }]); // limit 0 → default
    expect((await http(base, "GET", "/api/calls?limit=abc")).json.rows).toEqual([{ system: "s1" }]);
    const voices = async (q: string) => { await http(base, "GET", `/api/speakers/suggestions${q}`); return engine.calls.at(-1); };
    expect(await voices("?voices=abc")).toEqual(["suggest", 0]);
    expect(await voices("?voices=-3")).toEqual(["suggest", 0]);
    expect(await voices("?voices=2.5")).toEqual(["suggest", 2.5]);
    expect(await voices("?voices=")).toEqual(["suggest", undefined]);
  });

  test("the page's engine info: no restart banner where there are no sources", async () => {
    setAppPaths({ src: null });
    try {
      const r = await http(base, "GET", "/api/engine");
      expect(r.json.stale).toBe(false);
      expect(new Date(r.json.startedAt).toISOString()).toBe(r.json.startedAt);
    } finally {
      setAppPaths();
    }
  });

  test("static files: the page's URLs, content types, and nothing else", async () => {
    const type = async (p: string) => { const r = await http(base, "GET", p); return [r.status, r.headers["content-type"]]; };
    expect(await type("/index.html")).toEqual([200, "text/html; charset=utf-8"]);
    expect(await type("/recordings/20260925-120000/")).toEqual([200, "text/html; charset=utf-8"]);
    expect(await type("/dist/app.js.map")).toEqual([200, "application/json"]);
    expect(await type("/dist/data.json")).toEqual([200, "application/json"]);
    expect(await type("/dist/icon.svg")).toEqual([200, "image/svg+xml"]);
    expect(await type("/dist/logo.png")).toEqual([200, "image/png"]);
    expect(await type("/dist/favicon.ico")).toEqual([200, "image/x-icon"]);
    expect(await type("/dist/notes.txt")).toEqual([200, "application/octet-stream"]);
    expect((await http(base, "GET", "/dist/app.js")).headers["cache-control"]).toBe("no-cache");
    expect((await http(base, "GET", "/dist/app.js")).headers["content-security-policy"]).toBeUndefined(); // only pages carry it
    expect((await http(base, "GET", "/licenses")).headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect((await http(base, "GET", "/dist/sub")).status).toBe(404); // a folder
    expect((await http(base, "GET", "/dist/missing.js")).status).toBe(404);
    expect((await http(base, "GET", "/dist/%E0%A4%A")).status).toBe(404); // cannot be decoded
    expect((await http(base, "GET", "/recordings/.hidden")).status).toBe(404);
    expect((await http(base, "GET", "/other.html")).json).toEqual({ error: "not found" });
    expect((await http(base, "POST", "/")).status).toBe(404);
    expect((await http(base, "HEAD", "/api/nope")).status).toBe(404);
  });

  test("the audio route answers HEAD with the headers only", async () => {
    const dir = tmpDir("audio-");
    const pcm = Buffer.alloc(8);
    writeFileSync(join(dir, "host.wav"), Buffer.concat([wavHeader(pcm.length, 16000), pcm]));
    engine.audioDir = dir;
    const r = await http(base, "HEAD", "/api/sessions/20260925-120000/audio");
    expect(r.status).toBe(200);
    expect(r.headers["content-length"]).toBe("52");
    expect(r.body.length).toBe(0);
    expect((await http(base, "PUT", "/api/sessions/20260925-120000/audio")).status).toBe(404);
  });

  test("only the page itself: an opaque or other origin, IPv6, and a mismatched name are refused", async () => {
    const { port } = new URL(base);
    const status = async (headers: Record<string, string>) => (await http(base, "GET", "/api/state", { headers })).status;
    expect(await status({ origin: "null" })).toBe(403);
    expect(await status({ host: `[::1]:${port}` })).toBe(403);
    expect(await status({ origin: `http://localhost:${port}` })).toBe(403); // Host 127.0.0.1, Origin localhost
    expect(await status({ origin: `https://127.0.0.1:${port}` })).toBe(403);
    expect(await status({ host: "localhost" })).toBe(200);
    expect((await http(base, "GET", "/api/state", { headers: { origin: "null" } })).json).toEqual({ error: "this server answers only its own page at 127.0.0.1" });
    // HTTP/1.0 without any Host header
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(Number(port), "127.0.0.1", () => sock.end("GET /api/state HTTP/1.0\r\n\r\n"));
      let text = "";
      sock.on("data", (c) => (text += c));
      sock.on("end", () => resolve(text));
      sock.on("error", reject);
    });
    expect(raw.split("\r\n")[0]).toMatch(/^HTTP\/1\.[01] 403/);
  });

  test("the recordings list without a query asks for everything, tools hidden", async () => {
    await http(base, "GET", "/api/sessions");
    expect(engine.calls.at(-1)).toEqual(["list", undefined, false]);
  });
});

describe("server-sent events", () => {
  const engine = new FakeEngine();
  const server = createApiServer(engine, { webRoot: webRoot() });
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => ({ base, close } = await listen(server)));
  afterAll(() => close());
  afterEach(() => vi.useRealTimers());
  const subscribers = () => (engine.bus as unknown as { subs: Set<unknown> }).subs.size;
  const settle = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); };

  test("': connected' first, then each event with its id, type, and JSON", async () => {
    engine.bus.reset();
    const e = engine.bus.emit("speaker.updated", { id: "spk_1", displayName: "Nic" });
    const s = await openStream(base, "/api/events");
    expect(s.headers["content-type"]).toBe("text/event-stream");
    expect(s.headers["cache-control"]).toBe("no-cache");
    await s.until(`"displayName":"Nic"`);
    expect(s.text().startsWith(": connected\n\n")).toBe(true);
    expect(s.text()).toContain(`id: ${e.seq}\nevent: speaker.updated\ndata: ${JSON.stringify(e)}\n\n`);
    // transient events stream too, though they never enter the history
    const t = engine.bus.emit("cost", { transcription: 0, jev: 0, s2: 0, session: 0 }, { transient: true });
    await s.until(`id: ${t.seq}\nevent: cost`);
    s.close();
    await settle(() => subscribers() === 0);
  });

  test("a client that hangs up is unsubscribed from the bus", async () => {
    const before = subscribers();
    const s = await openStream(base, "/api/events");
    await s.until(": connected");
    expect(subscribers()).toBe(before + 1);
    s.close();
    await settle(() => subscribers() === before);
    expect(subscribers()).toBe(before);
  });

  test("a ': ping' comment every 15 s keeps the stream open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = await openStream(base, "/api/events");
    await s.until(": connected");
    expect(s.text()).not.toContain(": ping");
    vi.advanceTimersByTime(15_000);
    await s.until(": ping\n\n");
    vi.advanceTimersByTime(15_000);
    await s.until(": ping\n\n: ping\n\n");
    s.close();
    await settle(() => subscribers() === 0);
  });
});

describe("chat routes", () => {
  const seen: unknown[][] = [];
  let keySet = true;
  const chat: ChatApi = {
    models: async () => ({ default: "openai/gpt-6-luna", models: [] }),
    list: () => ({ chats: [] }),
    chat: async (id) => { if (id !== "c1") throw new ChatError(404, "unknown chat"); return { id }; },
    create: async (model) => { seen.push(["create", model]); return { id: "c1", model }; },
    update: async (id, patch) => ({ id, ...patch }),
    remove: (id) => ({ deleted: id }),
    stop: (id) => ({ stopped: id }),
    prepare: (id, body) => {
      if (body.content === "busy") throw new ChatError(409, "a reply is already being written");
      seen.push(["prepare", id, body]);
      return async (sink) => {
        sink({ type: "start", user: null, assistantId: "m_2", model: "openai/gpt-6-luna" });
        sink({ type: "thinking" });
        sink({ type: "delta", text: "Hello" });
        if (body.content === "boom") throw new Error("the stream broke");
        if (body.content === "string") throw "a thrown string";
        sink({ type: "done", chat: { id } } as ChatEvent);
      };
    },
  };
  const engine = Object.assign(new FakeEngine(), { chat, openrouterKeySet: () => keySet });
  const server = createApiServer(engine as EngineApi, { webRoot: webRoot() });
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => ({ base, close } = await listen(server)));
  afterAll(() => close());
  beforeEach(() => { keySet = true; });

  /** The event types and data of an SSE body. */
  const events = (text: string) => [...text.matchAll(/event: (\S+)\ndata: (.*)\n\n/g)].map((m) => [m[1], JSON.parse(m[2])]);

  test("a reply streams as start, thinking, delta, done", async () => {
    const r = await http(base, "POST", "/api/chats/c1/messages", { body: { content: "hi" } });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/event-stream");
    expect(events(r.text).map((e) => e[0])).toEqual(["start", "thinking", "delta", "done"]);
    expect(events(r.text)[2][1]).toEqual({ type: "delta", text: "Hello" });
    expect(seen.at(-1)).toEqual(["prepare", "c1", { content: "hi" }]);
  });

  test("a run that fails after the headers ends with an error event (chat: null)", async () => {
    const r = await http(base, "POST", "/api/chats/c1/messages", { body: { content: "boom" } });
    expect(r.status).toBe(200);
    expect(events(r.text).at(-1)).toEqual(["error", { type: "error", message: "the stream broke", chat: null }]);
    const s = await http(base, "POST", "/api/chats/c1/messages", { body: { content: "string" } });
    expect(events(s.text).at(-1)).toEqual(["error", { type: "error", message: "a thrown string", chat: null }]);
  });

  test("a reply keeps being written after the page leaves; nothing more is sent to it", async () => {
    const release = deferred();
    const finished = deferred();
    const leaving: ChatApi = { ...chat, prepare: () => async (sink) => {
      sink({ type: "start", user: null, assistantId: "m_3", model: "m" });
      await release.promise;
      sink({ type: "delta", text: "after the page left" });
      sink({ type: "done", chat: null } as ChatEvent);
      finished.resolve();
    } };
    const e2 = Object.assign(new FakeEngine(), { chat: leaving, openrouterKeySet: () => true });
    const { base: b2, close: c2 } = await listen(createApiServer(e2 as EngineApi, { webRoot: webRoot() }));
    try {
      const s = await new Promise<{ destroy: () => void }>((resolve, reject) => {
        const req = request(`${b2}/api/chats/c1/messages`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
          res.once("data", () => resolve({ destroy: () => req.destroy() }));
        });
        req.on("error", (err) => { if (!req.destroyed) reject(err); });
        req.end(JSON.stringify({ content: "hi" }));
      });
      s.destroy();
      await new Promise((r) => setTimeout(r, 50));
      release.resolve();
      await finished.promise; // the run completed without writing to the closed response
    } finally {
      await c2();
    }
  });

  test("a refusal before the stream starts is plain JSON", async () => {
    const r = await http(base, "POST", "/api/chats/c1/messages", { body: { content: "busy" } });
    expect([r.status, r.json]).toEqual([409, { error: "a reply is already being written" }]);
  });

  test("every other chat route, and the missing key refused on POST only", async () => {
    expect((await http(base, "GET", "/api/chat/models")).json).toMatchObject({ default: "openai/gpt-6-luna" });
    expect((await http(base, "GET", "/api/chats")).json).toEqual({ chats: [] });
    expect((await http(base, "POST", "/api/chats", { body: { model: "m" } })).json).toEqual({ id: "c1", model: "m" });
    expect((await http(base, "GET", "/api/chats/c1")).json).toEqual({ id: "c1" });
    expect((await http(base, "GET", "/api/chats/nope")).status).toBe(404);
    expect((await http(base, "PATCH", "/api/chats/c%31", { body: { title: "T" } })).json).toEqual({ id: "c1", title: "T" });
    expect((await http(base, "DELETE", "/api/chats/c1")).json).toEqual({ deleted: "c1" });
    expect((await http(base, "POST", "/api/chats/c1/stop")).json).toEqual({ stopped: "c1" });
    expect((await http(base, "PUT", "/api/chats/c1/stop")).status).toBe(404);
    keySet = false;
    const refused = await http(base, "POST", "/api/chats", { body: {} });
    expect([refused.status, refused.json]).toEqual([400, { error: "Please provide your OpenRouter API key to use Chat.", needsKey: "openrouter" }]);
    expect((await http(base, "POST", "/api/chats/c1/messages", { body: { content: "hi" } })).status).toBe(400);
    expect((await http(base, "GET", "/api/chats")).status).toBe(200); // reading past chats needs no key
  });
});

describe("export and import routes", () => {
  const exported = tmpDir("exported-");
  const files = new Map<string, { path: string; fileName: string }>();
  const sent: string[] = [];
  const imports: { bytes: number; fileName: string | null }[] = [];
  const transfer: TransferApi = {
    info: (id) => ({ id, bytes: { none: 1 } }),
    prepare: async (id, body) => ({ token: "tok", fileName: `${id}.tattle`, bytes: 1, body } as never),
    file: (token) => { const f = files.get(token); if (!f) throw new ApiError(404, "this export has expired: export again"); return f; },
    importFile: async (body, fileName) => {
      let bytes = 0;
      for await (const c of body) bytes += c.length;
      imports.push({ bytes, fileName });
      return { already: false };
    },
    importCopy: async (token, name) => ({ token, name }),
  };
  const engine = Object.assign(new FakeEngine(), { transfer, exportSent: (t: string) => sent.push(t) });
  const server = createApiServer(engine as EngineApi, { webRoot: webRoot() });
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => ({ base, close } = await listen(server)));
  afterAll(() => close());
  const T1 = "aaaabbbb-2222-4333-8444-cccccccccccc";

  test("an upload is streamed to the engine, with its URI-encoded name; a malformed name is null", async () => {
    const body = Buffer.alloc(200_000, 7);
    expect((await http(base, "POST", "/api/sessions/import", { body, headers: { "x-file-name": encodeURIComponent("Épisode 12.tattle") } })).json).toEqual({ already: false });
    expect(imports.at(-1)).toEqual({ bytes: 200_000, fileName: "Épisode 12.tattle" });
    await http(base, "POST", "/api/sessions/import", { body: Buffer.from("x"), headers: { "x-file-name": "%E0%A4%A" } });
    expect(imports.at(-1)).toEqual({ bytes: 1, fileName: null });
    await http(base, "POST", "/api/sessions/import", { body: Buffer.from("xy") });
    expect(imports.at(-1)).toEqual({ bytes: 2, fileName: null });
  });

  test("a copy takes a lowercase uuid token; anything else is not a route", async () => {
    expect((await http(base, "POST", `/api/sessions/import/${T1}`, { body: { name: "Copy" } })).json).toEqual({ token: T1, name: "Copy" });
    expect((await http(base, "POST", "/api/sessions/import/NOT-A-UUID", { body: {} })).json).toEqual({ error: "not found" });
    expect((await http(base, "POST", `/api/sessions/import/${T1.toUpperCase()}`, { body: {} })).status).toBe(404);
    expect((await http(base, "GET", `/api/exports/short`)).status).toBe(404);
  });

  test("an export's info and preparation", async () => {
    expect((await http(base, "GET", "/api/sessions/20260925-120000/export")).json).toEqual({ id: "20260925-120000", bytes: { none: 1 } });
    expect((await http(base, "POST", "/api/sessions/20260925-120000/export", { body: { audio: "none" } })).json)
      .toEqual({ token: "tok", fileName: "20260925-120000.tattle", bytes: 1, body: { audio: "none" } });
    expect((await http(base, "DELETE", "/api/sessions/x/export")).status).toBe(404);
  });

  test("the download: an attachment named safely for every browser, then the engine is told it was sent", async () => {
    const path = join(exported, "pa-x.tattle");
    writeFileSync(path, "ZIPDATA");
    files.set(T1, { path, fileName: 'Épisode "12": ✓.tattle' });
    const r = await http(base, "GET", `/api/exports/${T1}`);
    expect(r.status).toBe(200);
    expect(r.text).toBe("ZIPDATA");
    expect(r.headers["content-type"]).toBe("application/octet-stream");
    expect(r.headers["content-length"]).toBe("7");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["content-disposition"]).toBe(`attachment; filename="_pisode '12': _.tattle"; filename*=UTF-8''${encodeURIComponent('Épisode "12": ✓.tattle')}`);
    for (let i = 0; i < 50 && !sent.includes(T1); i++) await new Promise((res) => setTimeout(res, 10));
    expect(sent).toEqual([T1]);
    expect((await http(base, "GET", "/api/exports/22222222-2222-4333-8444-555555555555")).json).toEqual({ error: "this export has expired: export again" });
    // the file went away between the token and the read: a plain 400, nothing sent
    files.set("33333333-2222-4333-8444-555555555555", { path: join(exported, "gone.tattle"), fileName: "gone.tattle" });
    expect((await http(base, "GET", "/api/exports/33333333-2222-4333-8444-555555555555")).status).toBe(400);
  });
});

describe("the transcription and label-set routes, through fakes", () => {
  const calls: unknown[][] = [];
  const status = { engine: "openai" } as never;
  const transcription: TranscriptionApi = {
    status: () => status,
    set: async (e) => { calls.push(["set", e]); return status; },
    install: () => { calls.push(["install"]); return status; },
  };
  const labelSetApi = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => { calls.push([name, ...args]); if (name === "exportFile") return { fileName: "Ventes « été ».tattle-labels", body: "{}\n" }; return { called: name }; },
  }) as LabelSetApi;
  const engine = Object.assign(new FakeEngine(), { transcription, labelSetApi });
  let ready!: () => void;
  const server = createApiServer(engine as EngineApi, { webRoot: webRoot(), ready: new Promise<void>((r) => (ready = r)) });
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => ({ base, close } = await listen(server)));
  afterAll(() => close());

  test("every route waits until the engine setting has resolved", async () => {
    let answered = false;
    const pending = http(base, "GET", "/api/state").then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);
    ready();
    expect((await pending).status).toBe(200);
  });

  test("transcription: read, change, install (202); other methods are not routes", async () => {
    expect((await http(base, "GET", "/api/transcription")).json).toEqual({ engine: "openai" });
    expect((await http(base, "PUT", "/api/transcription", { body: { engine: "apple" } })).status).toBe(200);
    expect((await http(base, "POST", "/api/transcription/install")).status).toBe(202);
    expect(calls.slice(-2)).toEqual([["set", "apple"], ["install"]]);
    expect((await http(base, "DELETE", "/api/transcription")).status).toBe(404);
    expect((await http(base, "GET", "/api/transcription/install")).status).toBe(404);
  });

  test("label sets: each route calls its method with the decoded id and the body", async () => {
    calls.length = 0;
    const expectCall = async (m: string, p: string, status: number, call: unknown[], body?: unknown) => {
      const r = await http(base, m, p, body === undefined ? {} : { body });
      expect([m, p, r.status]).toEqual([m, p, status]);
      expect(calls.at(-1)).toEqual(call);
    };
    await expectCall("GET", "/api/label-sets", 200, ["list"]);
    await expectCall("POST", "/api/label-sets", 201, ["create", { name: "A" }], { name: "A" });
    await expectCall("POST", "/api/label-sets/import", 201, ["importFile", { x: 1 }], { x: 1 });
    await expectCall("POST", "/api/label-sets/estimate", 200, ["estimate", { y: 1 }], { y: 1 });
    await expectCall("POST", "/api/label-sets/try", 200, ["tryOn", { sessionId: "s" }], { sessionId: "s" });
    await expectCall("POST", "/api/label-sets/assist", 200, ["assist", { conversationId: "c" }], { conversationId: "c" });
    await expectCall("GET", "/api/label-sets/my%20set", 200, ["get", "my set"]);
    await expectCall("PUT", "/api/label-sets/a", 200, ["update", "a", { name: "B" }], { name: "B" });
    await expectCall("DELETE", "/api/label-sets/a", 200, ["remove", "a"]);
    await expectCall("POST", "/api/label-sets/a/clone", 201, ["clone", "a"]);
    const n = calls.length;
    expect((await http(base, "PATCH", "/api/label-sets/a")).status).toBe(404);
    expect((await http(base, "GET", "/api/label-sets/a/clone")).status).toBe(404);
    expect((await http(base, "POST", "/api/label-sets/a/export")).status).toBe(404);
    expect(calls.length).toBe(n);
    const ex = await http(base, "GET", "/api/label-sets/a/export");
    expect(ex.text).toBe("{}\n");
    expect(ex.headers["content-length"]).toBe("3");
    expect(ex.headers["content-disposition"]).toBe(`attachment; filename="Ventes _ _t_ _.tattle-labels"; filename*=UTF-8''${encodeURIComponent("Ventes « été ».tattle-labels")}`);
  });
});

describe("the setup routes and the gate", () => {
  const env: NodeJS.ProcessEnv = {};
  const credentials = join(tmpDir("keys-"), "credentials.json");
  const setup = new KeySetup(new KeyStore({ path: credentials, env }).load(), { fetch: fakeKeyCheckFetch().f, models: [], required: () => ["openai"] });
  const engine = new FakeEngine();
  const server = createApiServer(engine, { webRoot: webRoot(), setup });
  const noSetup = createApiServer(new FakeEngine(), { webRoot: webRoot() });
  let base = "";
  let bare = "";
  const closers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    const a = await listen(server);
    const b = await listen(noSetup);
    base = a.base;
    bare = b.base;
    closers.push(a.close, b.close);
  });
  afterAll(async () => { for (const c of closers) await c(); });

  test("unconfigured: the open routes and the page answer; every other API route is 503 with setup: true", async () => {
    for (const p of ["/api/about", "/api/engine", "/api/licenses", "/api/setup"]) expect([p, (await http(base, "GET", p)).status]).toEqual([p, 200]);
    for (const [m, p] of [["GET", "/api/events"], ["GET", "/api/sessions"], ["POST", "/api/session/start"], ["GET", "/api/setup/foo"], ["GET", "/api/nope"]]) {
      const r = await http(base, m, p, m === "GET" ? {} : { body: {} });
      expect([m, p, r.status, r.json]).toEqual([m, p, 503, { error: "API keys are missing: open the page to add them", setup: true }]);
    }
    expect((await http(base, "GET", "/api/transcription")).status).toBe(501); // open, and this engine has none
    expect((await http(base, "GET", "/")).status).toBe(200);
    expect(engine.calls).toEqual([]);
  });

  test("saving keys: JSON only, and the store's refusals keep their status", async () => {
    expect((await http(base, "POST", "/api/setup/keys", { body: "openai=x", headers: { "content-type": "text/plain" } })).json).toEqual({ error: "expected JSON" });
    expect((await http(base, "POST", "/api/setup/keys", { body: Buffer.from("{}") })).status).toBe(415); // no content type at all
    expect((await http(base, "POST", "/api/setup/keys", { body: {} })).json).toEqual({ error: "no key given" });
    expect((await http(base, "POST", "/api/setup/keys", { body: { openai: 42 } })).status).toBe(400);
    expect((await http(base, "POST", "/api/setup/keys", { body: "null", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await http(base, "PUT", "/api/setup/keys", { body: {} })).status).toBe(404); // an open path, but no such route
    // a key from the shell cannot be replaced from the page
    const shell = new KeySetup(new KeyStore({ path: join(tmpDir("keys-"), "credentials.json"), env: { OPENAI_API_KEY: "sk-proj-from-the-shell-000000000000" } }).load(),
      { fetch: fakeKeyCheckFetch().f, models: [], required: () => ["openai"] });
    const { base: withShellKey, close } = await listen(createApiServer(new FakeEngine(), { webRoot: webRoot(), setup: shell }));
    try {
      const r = await http(withShellKey, "POST", "/api/setup/keys", { body: { openai: "sk-proj-another-key-0000000000000" } });
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/OPENAI_API_KEY is set in .env or your shell/);
      expect((await http(withShellKey, "GET", "/api/setup/foo")).json).toEqual({ error: "not found" }); // configured: no longer gated
    } finally {
      await close();
    }
    expect(env).toEqual({}); // this server's own store saved nothing
  });

  test("without a setup option the setup routes do not exist", async () => {
    expect((await http(bare, "GET", "/api/setup")).status).toBe(404);
    expect((await http(bare, "POST", "/api/setup/keys", { body: {} })).status).toBe(404);
    expect((await http(bare, "GET", "/api/state")).status).toBe(200);
  });
});

describe("the router over a real engine, with no session", () => {
  const engine = new Engine({ sessionsDir: tmpDir("sessions-"), session: { services: transcribeOnlyServices } });
  const server = createApiServer(engine, { webRoot: webRoot() });
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => ({ base, close } = await listen(server)));
  afterAll(() => close());

  test("what a real engine answers before anything runs", async () => {
    const answer = async (m: string, p: string, body?: unknown) => { const r = await http(base, m, p, body === undefined ? {} : { body }); return [r.status, r.json]; };
    expect(await answer("GET", "/api/state")).toEqual([200, { session: null }]);
    expect(await answer("GET", "/api/devices")).toEqual([501, { error: "device listing is not available" }]);
    expect(await answer("POST", "/api/session/start", {})).toEqual([400, { error: "mode must be replay or live" }]);
    expect(await answer("POST", "/api/session/stop")).toEqual([409, { error: "no session" }]);
    expect(await answer("GET", "/api/stats")).toEqual([409, { error: "no session" }]);
    expect(await answer("PUT", "/api/stories", { headlines: "A" })).toEqual([400, { error: "headlines must be an array of strings" }]);
    expect(await answer("PUT", "/api/stories", { headlines: ["A"] })).toEqual([409, { error: "no session" }]);
    expect(await answer("GET", "/api/sessions/..%2Fetc")).toEqual([404, { error: "invalid session id ../etc" }]);
    // the import route shadows no recording: a GET of it is an unknown recording named "import"
    expect(await answer("GET", "/api/sessions/import")).toEqual([404, { error: "unknown session import" }]);
    expect(await answer("GET", "/api/sessions")).toEqual([200, []]);
    expect(await answer("GET", "/api/calls")).toMatchObject([200, { rows: [] }]);
    expect(await answer("POST", "/api/sessions/close")).toEqual([200, { closed: null }]);
    expect(await answer("GET", "/api/speakers/suggestions")).toEqual([409, { error: "no session" }]);
    expect(await answer("GET", "/api/exports/aaaabbbb-2222-4333-8444-cccccccccccc")).toEqual([404, { error: "this export has expired: export again" }]);
    expect(await answer("POST", "/api/sessions/import/aaaabbbb-2222-4333-8444-cccccccccccc", { name: "x" })).toEqual([404, { error: "the upload has expired: import the file again" }]);
    expect(await answer("GET", "/api/sessions/nope/audio")).toEqual([404, { error: "unknown session nope" }]);
  });
});
