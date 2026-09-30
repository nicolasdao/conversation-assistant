import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { about, createApiServer, Engine, engineStale } from "../src/server/main.ts";
import { LabelSetStore } from "../src/labels/store.ts";
import { wavHeader } from "../src/audio/wav.ts";
import { limit, streamGain } from "../src/server/audio.ts";
import { parseNotices } from "../src/licenses.ts";
import { FakeEngine } from "./fakes/index.ts";

let base = "";
const engine = new FakeEngine();
// the web root sits in its own temporary folder, beside a file it must never serve
const outside = mkdtempSync(join(tmpdir(), "server-"));
const web = join(outside, "web");
mkdirSync(web);
const server = createApiServer(engine, { webRoot: web });

beforeAll(async () => {
  mkdirSync(join(web, "dist"), { recursive: true });
  mkdirSync(join(web, "fonts"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(web, "licenses.html"), "<!doctype html><title>l</title>");
  writeFileSync(join(web, "styles.css"), "body{}");
  writeFileSync(join(web, "dist", "app.js"), "export {}");
  writeFileSync(join(web, "fonts", "face.woff2"), "wOF2");
  writeFileSync(join(outside, "secret.txt"), "top secret");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(outside, { recursive: true, force: true });
});
// each test starts from the same engine state: no test depends on another's calls, renames, or events
const NAMES = { ...engine.names };
beforeEach(() => {
  engine.calls.length = 0;
  engine.names = { ...NAMES };
  engine.bus.reset();
});

/** Raw http (the test setup disables fetch). */
function call(method: string, path: string, body?: unknown): Promise<{ status: number; type: string; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), json, text });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/** Raw bytes of a GET, with an optional Range header. */
function bytes(path: string, range?: string): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method: "GET", headers: range ? { range } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP API", () => {
  test("a recording's audio: both streams mixed into one seekable WAV", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audio-"));
    const wav = (samples: number[]) => {
      const pcm = Buffer.alloc(samples.length * 2);
      samples.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
      return Buffer.concat([wavHeader(pcm.length, 16000), pcm]);
    };
    writeFileSync(join(dir, "host.wav"), wav([1000, -2000, 30000]));
    writeFileSync(join(dir, "remote.wav"), wav([500, 500, 10000, 7])); // one sample longer
    engine.audioDir = dir;
    const all = await bytes("/api/sessions/20260925-120000/audio");
    expect(all.status).toBe(200);
    expect(all.headers["content-type"]).toBe("audio/wav");
    expect(all.headers["accept-ranges"]).toBe("bytes");
    expect(all.body.length).toBe(44 + 8);
    expect(all.body.subarray(0, 4).toString()).toBe("RIFF");
    expect(all.body.readUInt32LE(40)).toBe(8);
    const samples = [0, 1, 2, 3].map((i) => all.body.readInt16LE(44 + i * 2));
    // summed, the longer stream padded; too short to measure a level, so no gain; the loud sum bent under full scale
    expect([samples[0], samples[1], samples[3]]).toEqual([1500, -1500, 7]);
    expect(samples[2]).toBeGreaterThan(30000);
    expect(samples[2]).toBeLessThan(32767);
    // seeking: a range, including one that starts and ends mid-sample
    const part = await bytes("/api/sessions/20260925-120000/audio", "bytes=46-49");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 46-49/52");
    expect([part.body.readInt16LE(0), part.body.readInt16LE(2)]).toEqual([samples[1], samples[2]]);
    const odd = await bytes("/api/sessions/20260925-120000/audio", "bytes=45-46");
    expect(odd.body).toEqual(all.body.subarray(45, 47));
    expect((await bytes("/api/sessions/20260925-120000/audio", "bytes=99-")).status).toBe(416);
    expect((await bytes("/api/sessions/nope/audio")).status).toBe(404);
  });

  test("quiet speech is boosted to a common level, within a limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "gain-"));
    // 6 s of "speech" at −30 dBFS (a sine), like a quiet recording
    const quiet = Array.from({ length: 16000 * 6 }, (_, i) => Math.round(Math.sin(i / 8) * 32768 * 10 ** (-30 / 20) * Math.SQRT2));
    const pcm = Buffer.alloc(quiet.length * 2);
    quiet.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
    writeFileSync(join(dir, "q.wav"), Buffer.concat([wavHeader(pcm.length, 16000), pcm]));
    expect(20 * Math.log10(streamGain(join(dir, "q.wav")))).toBeCloseTo(18, 0); // −30 → −12 dBFS
    expect(limit(0.8)).toBe(0.8); // ordinary speech passes untouched
    expect(limit(2)).toBeLessThan(1);
    expect(limit(-2)).toBeGreaterThan(-1);
  });

  test("every route", async () => {
    expect((await call("GET", "/api/state")).json).toMatchObject({ session: { id: "s1" } });
    expect((await call("POST", "/api/session/start", { mode: "replay", dir: "fixtures/conversation", speed: 1 })).json).toEqual({ sessionId: "s1" });
    expect((await call("GET", "/api/devices")).json[0]).toMatchObject({ uid: "BuiltInMicrophoneDevice", isDefault: true });
    expect((await call("POST", "/api/speakers/spk_1/rename", { displayName: "Nic" })).json).toEqual({ id: "spk_1", displayName: "Nic" });
    expect((await call("POST", "/api/speakers/spk_9/rename", { displayName: "X" })).status).toBe(404);
    expect((await call("POST", "/api/speakers/merge", { fromId: "spk_2", intoId: "spk_1" })).status).toBe(200);
    expect((await call("PUT", "/api/labels", { prefix: "p" })).status).toBe(404); // no live label editing: a session's set is fixed
    expect((await call("POST", "/api/labels/relabel")).status).toBe(202);
    expect((await call("PUT", "/api/stories", { headlines: ["A", "B"] })).json).toEqual({ version: "v2" });
    expect((await call("POST", "/api/claims/c_1/override", { note: "no" })).json).toEqual({ id: "c_1", disputed: true });
    expect((await call("POST", "/api/s1/rollback", { version: "s1@1" })).json).toEqual({ active: "s1@1" });
    expect((await call("GET", "/api/stats")).json).toEqual({ roganIndex: 0.25 });
    expect((await call("POST", "/api/session/stop")).json).toEqual({ sessionId: "s1" });
    expect((await call("GET", "/api/sessions?q=jev%20cheap&all=1")).json).toEqual([{ id: "20260925-120000", name: "Pilot" }]);
    expect((await call("GET", "/api/sessions/20260925-120000")).json).toEqual({ id: "20260925-120000" });
    expect((await call("GET", "/api/sessions/nope")).status).toBe(404);
    expect((await call("PATCH", "/api/sessions/20260925-120000", { name: "Episode 12" })).json).toEqual({ id: "20260925-120000", name: "Episode 12" });
    expect((await call("POST", "/api/sessions/20260925-120000/open")).json).toEqual({ sessionId: "20260925-120000", events: 12 });
    expect((await call("POST", "/api/session/start", "{bad json")).status).toBe(400);
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect(engine.calls.map((c) => c[0])).toEqual(["start", "merge", "relabel", "stories", "override", "rollback", "stop", "list", "update", "open"]);
    expect(engine.calls[7]).toEqual(["list", "jev cheap", true]);
    expect(engine.calls[0][1]).toEqual({ mode: "replay", dir: "fixtures/conversation", speed: 1 });
  });

  test("pause, resume, and delete a recording", async () => {
    expect((await call("POST", "/api/session/pause")).json).toEqual({ paused: true });
    expect((await call("POST", "/api/session/resume")).json).toEqual({ paused: false });
    expect((await call("DELETE", "/api/sessions/20260925-120000")).json).toEqual({ deleted: "20260925-120000" });
    expect(engine.calls.slice(-3)).toEqual([["pause"], ["resume"], ["delete", "20260925-120000"]]);
  });

  test("merge suggestions for the session on screen", async () => {
    expect((await call("GET", "/api/speakers/suggestions?voices=1")).json).toEqual({ suggestions: [], voices: { host: 1, remote: 1 } });
    expect(engine.calls.at(-1)).toEqual(["suggest", 1]);
    await call("GET", "/api/speakers/suggestions");
    expect(engine.calls.at(-1)).toEqual(["suggest", undefined]);
  });

  test("the call log of System 1 or System 2", async () => {
    expect((await call("GET", "/api/calls?system=s2&limit=50")).json.rows).toEqual([{ system: "s2", limit: 50 }]);
    expect((await call("GET", "/api/calls")).json).toMatchObject({ rows: [{ system: "s1" }], models: { s1: "typesafe/jev-1.13" } });
  });

  test("the version comes from the root package.json, with the license", async () => {
    const a = (await call("GET", "/api/about")).json;
    expect(a.version).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
    expect(a.license.id).toBe("BSD-3-Clause");
    expect(a.license.text).toMatch(/Cloudless Consulting Pty Ltd/);
    expect(about().version).toBe(a.version);
  });

  test("the licenses: the app's own, then every third-party component with the full texts it names", async () => {
    const l = (await call("GET", "/api/licenses")).json;
    expect(l.app).toMatchObject({ name: "Tattle", license: "BSD-3-Clause", text: expect.stringMatching(/Cloudless Consulting Pty Ltd/) });
    expect(l.groups.map((g: any) => g.title)).toEqual(["Components built into the app", "npm packages in the app"]);
    const all = l.groups.flatMap((g: any) => g.components);
    const find = (prefix: string) => all.find((c: any) => c.title.startsWith(prefix));
    expect(find("Electron")).toMatchObject({ license: "MIT" });
    expect(find("eSpeak NG")).toMatchObject({ license: "GPL-3.0-or-later", files: ["licenses/GPL-3.0.txt"] });
    expect(find("Barlow")).toMatchObject({ files: ["web/fonts/OFL.txt"] });
    expect(find("sax").body).toMatch(/# Blue Oak Model License/); // a heading inside a code block stays in its component
    for (const c of all) for (const f of c.files) expect(l.texts[f]).toBeTruthy();
    expect(l.texts["licenses/GPL-3.0.txt"]).toMatch(/GNU GENERAL PUBLIC LICENSE/);
  });

  test("the notices split into groups and components, not at headings inside code blocks", () => {
    const md = "# Third-party notices\n\nIntro.\n\n## Built in\n\n### A 1.0\n\n**GPL-3.0** · https://a. Full text: `licenses/GPL-3.0.txt`.\n\n"
      + "## Packages\n\n### B 2.0\n\nMIT · https://b\n\n```text\n## Purpose\n### Not a component\n```\n";
    expect(parseNotices(md)).toEqual([
      { title: "Built in", components: [{ title: "A 1.0", license: "GPL-3.0", body: "**GPL-3.0** · https://a. Full text: `licenses/GPL-3.0.txt`.", files: ["licenses/GPL-3.0.txt"] }] },
      { title: "Packages", components: [{ title: "B 2.0", license: "MIT", body: "MIT · https://b\n\n```text\n## Purpose\n### Not a component\n```", files: [] }] },
    ]);
  });

  test("the page can tell when the engine code changed after the server started", async () => {
    expect((await call("GET", "/api/engine")).json).toMatchObject({ stale: false });
    const src = mkdtempSync(join(tmpdir(), "src-"));
    mkdirSync(join(src, "store"));
    writeFileSync(join(src, "store", "a.ts"), "export {}");
    expect(engineStale(src, Date.now() + 60_000)).toBe(false);
    expect(engineStale(src, Date.now() - 60_000)).toBe(true);
  });

  test("every route answers only its own page: another website or a rebound host is refused", async () => {
    const raw = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<number>((resolve, reject) => {
      const req = request(base + path, { method, headers }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.end(body);
    });
    const before = engine.calls.length;
    // a "simple" cross-site POST (text/plain, no preflight) that would start a recording
    expect(await raw("POST", "/api/session/start", { origin: "https://evil.example", "content-type": "text/plain" }, '{"mode":"live"}')).toBe(403);
    // DNS rebinding: evil.example resolves to 127.0.0.1, so the browser sends its own Host
    expect(await raw("GET", "/api/state", { host: "evil.example:4317" })).toBe(403);
    expect(await raw("GET", "/", { host: "evil.example:4317" })).toBe(403);
    expect(engine.calls.length).toBe(before); // nothing reached the engine
    // the page itself, by either name, and tools without an Origin
    const port = new URL(base).port;
    expect(await raw("GET", "/api/state", { origin: `http://127.0.0.1:${port}` })).toBe(200);
    expect(await raw("GET", "/api/state", { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200);
    expect(await raw("GET", "/api/state", {})).toBe(200);
  });

  test("the page is served with its Content-Security-Policy", async () => {
    const page = await bytes("/");
    expect(String(page.headers["content-security-policy"])).toMatch(/default-src 'self'; script-src 'self'/);
    expect(page.headers["content-security-policy"]).toBe((await import("../src/server/main.ts")).PAGE_CSP);
  });

  test("static files are served from web/ only", async () => {
    const index = await call("GET", "/");
    expect(index.status).toBe(200);
    expect(index.type).toContain("text/html");
    expect((await call("GET", "/styles.css")).type).toContain("text/css");
    expect((await call("GET", "/dist/app.js")).type).toContain("text/javascript");
    expect((await call("GET", "/fonts/face.woff2")).type).toBe("font/woff2");
    expect((await call("GET", "/fonts/../../secret.txt")).status).toBe(404);
    expect((await call("GET", "/dist/../../secret.txt")).status).toBe(404);
    // the page's own URLs serve the page; anything else is not found
    expect((await call("GET", "/recordings/20260925-202620")).type).toContain("text/html");
    expect((await call("GET", "/recordings/../secret.txt")).status).toBe(404);
    expect((await call("GET", "/licenses")).type).toContain("text/html");
    expect((await call("POST", "/api/sessions/close")).json).toEqual({ closed: "20260925-120000" });
    expect((await call("GET", "/dist/%2e%2e/%2e%2e/secret.txt")).status).toBe(404);
    expect((await call("GET", "/dist/..%2F..%2Fsecret.txt")).status).toBe(404);
  });

  test("SSE replays the session's events so far on connect, then streams", async () => {
    engine.bus.reset();
    engine.bus.emit("session.started", { sessionId: "s1", mode: "replay", s1Version: "s1@1", labelSetVersion: "v" });
    engine.bus.emit("utterance", { id: "u_1", stream: "host", startMs: 0, endMs: 1, speakerId: "spk_1", speakerName: "Nic", text: "hi", tags: [] });
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = request(`${base}/api/events`, (res) => {
        expect(res.headers["content-type"]).toBe("text/event-stream");
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          for (const m of buf.matchAll(/event: (\S+)\n/g)) if (!received.includes(m[1])) received.push(m[1]);
          if (received.length === 2 && !received.includes("speaker.updated")) {
            void call("POST", "/api/speakers/spk_1/rename", { displayName: "Nicolas" });
          }
          if (received.includes("speaker.updated")) {
            expect(buf).toContain('"displayName":"Nicolas"');
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e) => (received.includes("speaker.updated") ? resolve() : reject(e)));
      req.end();
    });
    expect(received).toEqual(["session.started", "utterance", "speaker.updated"]);
  });
});

describe("the label-set routes, on a real library in a temporary folder", () => {
  const userDir = mkdtempSync(join(tmpdir(), "label-sets-"));
  const labelSets = new LabelSetStore({ builtInDir: "config/labels", userDir });
  const engine = new Engine({ sessionsDir: mkdtempSync(join(tmpdir(), "sessions-")), labelSets });
  const server = createApiServer(engine, { webRoot: mkdtempSync(join(tmpdir(), "web-")) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: any = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* a download */ }
          resolve({ status: res.statusCode!, json, headers: res.headers, text });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  const builtIn = () => JSON.parse(readFileSync("config/labels/ai-podcast.json", "utf8"));

  test("list and get: the built-in set, read-only", async () => {
    const list = await call("GET", "/api/label-sets");
    expect(list.status).toBe(200);
    expect(list.json.sets).toEqual([{ id: "ai-podcast", name: "AI podcast", description: expect.any(String), builtIn: true, counts: { categories: 2, scores: 2, markers: 6 }, perHourUsd: expect.any(Number) }]);
    expect(list.json.boundary.type).toBe("noul");
    const got = await call("GET", "/api/label-sets/ai-podcast");
    expect(got.json).toMatchObject({ id: "ai-podcast", builtIn: true, format: "tattle-labels" });
    expect((await call("GET", "/api/label-sets/nope")).status).toBe(404);
    expect((await call("PUT", "/api/label-sets/ai-podcast", builtIn())).status).toBe(409);
    expect((await call("DELETE", "/api/label-sets/ai-podcast")).status).toBe(409);
  });

  test("create, update, clone, delete; an invalid set is refused with the reason", async () => {
    const made = await call("POST", "/api/label-sets", { ...builtIn(), name: "Sales calls", builtIn: true });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ id: "sales-calls", name: "Sales calls", builtIn: false });
    const bad = await call("POST", "/api/label-sets", { ...builtIn(), name: "Too many", scores: [...builtIn().scores, { ...builtIn().scores[0], id: "third" }] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/at most 2 scores/);
    const up = await call("PUT", "/api/label-sets/sales-calls", { ...made.json, description: "Changed" });
    expect(up).toMatchObject({ status: 200, json: { id: "sales-calls", description: "Changed" } });
    expect((await call("PUT", "/api/label-sets/sales-calls", { ...made.json, markers: "x" })).status).toBe(400);
    const cl = await call("POST", "/api/label-sets/ai-podcast/clone");
    expect(cl).toMatchObject({ status: 201, json: { name: "AI podcast copy", builtIn: false } });
    expect((await call("DELETE", `/api/label-sets/${cl.json.id}`)).json).toEqual({ deleted: cl.json.id });
    expect((await call("DELETE", `/api/label-sets/${cl.json.id}`)).status).toBe(404);
    expect((await call("GET", "/api/label-sets")).json.sets.map((s: any) => s.id)).toEqual(["ai-podcast", "sales-calls"]);
  });

  test("export downloads <name>.tattle-labels, and import brings it back as an identical set under a new id", async () => {
    const ex = await call("GET", "/api/label-sets/sales-calls/export");
    expect(ex.status).toBe(200);
    expect(ex.headers["content-type"]).toBe("application/octet-stream");
    expect(ex.headers["content-disposition"]).toContain('filename="Sales calls.tattle-labels"');
    const file = JSON.parse(ex.text);
    expect(file.builtIn).toBeUndefined();
    const im = await call("POST", "/api/label-sets/import", file);
    expect(im.status).toBe(201);
    expect(im.json).toMatchObject({ name: "Sales calls (2)", builtIn: false });
    expect(im.json.id).not.toBe("sales-calls");
    const { id: _a, name: _b, ...imported } = im.json;
    const { id: _c, name: _d, ...original } = (await call("GET", "/api/label-sets/sales-calls")).json;
    expect(imported).toEqual(original);
    expect((await call("POST", "/api/label-sets/import", { hello: "world" })).status).toBe(400);
    const builtInExport = await call("GET", "/api/label-sets/ai-podcast/export");
    expect(builtInExport.headers["content-disposition"]).toContain("AI podcast.tattle-labels");
  });

  test("estimate: validation and the cost of a draft, valid or not", async () => {
    const good = await call("POST", "/api/label-sets/estimate", builtIn());
    expect(good.json).toMatchObject({ ok: true, errors: [], overLimit: false });
    expect(good.json.tokens).toBeGreaterThan(1500);
    expect(good.json.perHourUsd).toBeLessThan(0.05); // about a cent an hour
    const { id: _i, format: _f, version: _v, ...draft } = builtIn();
    expect((await call("POST", "/api/label-sets/estimate", draft)).json.ok).toBe(true); // no id or format yet: still a draft
    const bad = await call("POST", "/api/label-sets/estimate", { ...draft, markers: [{ ...draft.markers[0], threshold: 3 }] });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.errors.join()).toMatch(/threshold/);
    expect(bad.json.tokens).toBeGreaterThan(1500);
    const huge = { ...draft, categories: [{ ...draft.categories[0], instructions: "x".repeat(130_000) }] };
    expect((await call("POST", "/api/label-sets/estimate", huge)).json.overLimit).toBe(true);
  });

  test("none of the routes needs an API key", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(engine.openrouterKeySet()).toBe(false);
      expect((await call("GET", "/api/label-sets")).status).toBe(200);
      expect((await call("POST", "/api/label-sets/ai-podcast/clone")).status).toBe(201);
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });
});

describe("Try on a recording (POST /api/label-sets/try), with a fake Jev", () => {
  const root = mkdtempSync(join(tmpdir(), "try-sessions-"));
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>) => JSON.stringify({ seq: ++seq, type, at: "2026-09-29T10:00:00.000Z", data });
  /** A recording of `n` 30 s segments, labelled or transcript-only. */
  const recording = (id: string, n: number, labelled: boolean) => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify({
      id, mode: "live", startedAt: "2026-09-29T10:00:00Z", streams: ["host"], features: { factcheck: false, labels: labelled },
      labelSet: labelled ? JSON.parse(readFileSync("config/labels/ai-podcast.json", "utf8")) : null, stories: [], labelSetVersion: "v",
    }));
    const lines = [ev("session.started", { sessionId: id, mode: "live", s1Version: "s1@1", labelSetVersion: "v" }), ev("speaker.created", { id: "spk_1", displayName: "Speaker 1", stream: "host" }), ev("speaker.updated", { id: "spk_1", displayName: "Nic" })];
    for (let i = 0; i < n; i++) {
      lines.push(ev("utterance", { id: `u_${i + 1}`, stream: "host", startMs: i * 30_000, endMs: i * 30_000 + 20_000, speakerId: "spk_1", speakerName: "Speaker 1", text: `Line ${i + 1}`, tags: [] }));
      lines.push(ev("segment.closed", { id: `seg_${i + 1}`, startMs: i * 30_000, endMs: i * 30_000 + 25_000, forced: false, final: false, utteranceIds: [`u_${i + 1}`] }));
      if (labelled) lines.push(ev("segment.labels", { segmentId: `seg_${i + 1}`, labelSetVersion: "v", unlabeled: false, choices: { subject: { choice: "tech", confidence: 0.9, faded: false } }, nouls: {}, scores: {}, markers: [], mentions: [], lane: "tech", story: null }));
    }
    lines.push(ev("session.ended", { sessionId: id, reason: "stop" }));
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
    return dir;
  };
  const labelledDir = recording("20260929-100000", 30, true); // 15 minutes: 20 segments start in the first 10
  recording("20260929-110000", 4, false);
  recording("20260929-120000", 0, false);
  const asked: { questions: string[]; state: any; purpose?: string }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    asked.push({ questions: Object.keys(body.questions), state: body.state });
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions)) {
      if (q.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
      else if (q.type === "score") answers[id] = { type: "score", score: 2, confidence: 0.9, probabilities: {} };
      else answers[id] = { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.9, probabilities: {} };
    }
    return new Response(JSON.stringify({ answers, id: "gen-x", model: "typesafe/jev-1.13", provider: "TypeSafe", usage: { input_tokens: 2000, output_tokens: 0, cost: 0.0001 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const withKey = new Engine({ sessionsDir: root, fetch: fakeFetch, openrouterKey: "sk-or-v1-test-key-000000000000", labelSets: new LabelSetStore({ builtInDir: "config/labels", userDir: mkdtempSync(join(tmpdir(), "ls-")) }) });
  const draft = () => {
    const s = JSON.parse(readFileSync("config/labels/ai-podcast.json", "utf8"));
    return { ...s, id: "", builtIn: undefined, name: "Draft", categories: [s.categories[1]], scores: [], markers: [s.markers[0], s.markers[1]] };
  };
  const snapshotOf = (dir: string) => readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8"), statSync(join(dir, f)).mtimeMs]);

  test("asks the draft's questions about the first 10 minutes, and writes nothing into the recording", async () => {
    const before = snapshotOf(labelledDir);
    const r: any = await withKey.labelSetApi.tryOn({ set: draft(), sessionId: "20260929-100000", minutes: 10 });
    expect(r.segments.length).toBe(20);
    expect(r.labels.length).toBe(20);
    expect(r.labels[0]).toMatchObject({ segmentId: "seg_1", choices: { mode: { choice: "news" } }, markers: ["disagreement", "hot_take"] });
    expect(asked.length).toBe(20);
    expect(asked[0].questions).toEqual(["mode", "disagreement", "hot_take"]);
    expect(asked[1].state).toEqual({ previous_segment: [{ speaker: "Nic", text: "Line 1", tags: [] }], segment: [{ speaker: "Nic", text: "Line 2", tags: [] }] });
    expect(r.costUsd).toBeCloseTo(0.002);
    expect(r.recording).toMatchObject({ features: { labels: true }, set: { id: "ai-podcast" } });
    expect(r.recording.labels.length).toBe(20);
    expect(snapshotOf(labelledDir)).toEqual(before);
    const log = readFileSync(join(root, "label-tries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.length).toBe(20);
    expect(log[0]).toMatchObject({ kind: "jev_call", purpose: "try", session_id: "20260929-100000", cost_usd: 0.0001 });
  });

  test("a transcript-only recording is tried too: its segments, and no labels of its own", async () => {
    asked.length = 0;
    const r: any = await withKey.labelSetApi.tryOn({ set: draft(), sessionId: "20260929-110000" });
    expect(r.segments.length).toBe(4);
    expect(r.recording).toEqual({ features: { factcheck: false, labels: false }, set: null, labels: [] });
    expect(asked.length).toBe(4);
  });

  test("a recording with no segments asks nothing", async () => {
    asked.length = 0;
    const r: any = await withKey.labelSetApi.tryOn({ set: draft(), sessionId: "20260929-120000" });
    expect(r).toMatchObject({ segments: [], labels: [], costUsd: 0 });
    expect(asked.length).toBe(0);
  });

  test("refused: an invalid draft, an unknown recording, while on air, and without the OpenRouter key", async () => {
    await expect(withKey.labelSetApi.tryOn({ set: { ...draft(), markers: "x" }, sessionId: "20260929-100000" })).rejects.toMatchObject({ status: 400 });
    await expect(withKey.labelSetApi.tryOn({ set: draft(), sessionId: "nope" })).rejects.toMatchObject({ status: 404 });
    (withKey as unknown as { session: unknown }).session = { status: "running" };
    try {
      await expect(withKey.labelSetApi.tryOn({ set: draft(), sessionId: "20260929-100000" })).rejects.toMatchObject({ status: 409 });
    } finally {
      (withKey as unknown as { session: unknown }).session = null;
    }
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const noKey = new Engine({ sessionsDir: root, fetch: fakeFetch });
      await expect(noKey.labelSetApi.tryOn({ set: draft(), sessionId: "20260929-100000" })).rejects.toMatchObject({ status: 400, extra: { needsKey: "openrouter" } });
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });
});

describe("Create with AI (POST /api/label-sets/assist)", () => {
  const root = mkdtempSync(join(tmpdir(), "assist-"));
  const answer = { reply: "Here you go.", question: "What is it about?", choices: [], skip: [], set: null };
  const f = (async () => new Response(JSON.stringify({ id: "g", model: "openai/gpt-6-luna", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { cost: 0.6 } }), { status: 200 })) as unknown as typeof fetch;
  const engine = new Engine({ sessionsDir: root, fetch: f, openrouterKey: "sk-or-v1-test-key-000000000000" });
  const body = (id = "c1") => ({ conversationId: id, messages: [{ role: "user", content: "A set for a cooking show." }], draft: null });

  test("answers with the reply, what the conversation spent, and its cap; logs the call beside the recordings", async () => {
    const r: any = await engine.labelSetApi.assist(body());
    expect(r).toMatchObject({ reply: "Here you go.", set: null, costUsd: 0.6, spentUsd: 0.6 });
    expect("capUsd" in r).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "label-assist.jsonl"), "utf8").trim())).toMatchObject({ kind: "s2_call", purpose: "labels_assist", cost_usd: 0.6 });
  });

  test("no spending cap: a conversation keeps going past $1, and each keeps its own total", async () => {
    await engine.labelSetApi.assist(body()); // 1.20 spent
    expect(((await engine.labelSetApi.assist(body())) as any).spentUsd).toBeCloseTo(1.8);
    await expect(engine.labelSetApi.assist(body("c2"))).resolves.toMatchObject({ spentUsd: 0.6 });
  });

  test("refused without the OpenRouter key, and for a malformed conversation", async () => {
    await expect(engine.labelSetApi.assist({ ...body(), messages: [] })).rejects.toMatchObject({ status: 400 });
    await expect(engine.labelSetApi.assist({ ...body(), conversationId: "../x" })).rejects.toMatchObject({ status: 400 });
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(new Engine({ sessionsDir: root, fetch: f }).labelSetApi.assist(body())).rejects.toMatchObject({ status: 400, extra: { needsKey: "openrouter" } });
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });
});
