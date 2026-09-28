import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { about, ApiError, createApiServer, engineStale, type EngineApi, type StartRequest } from "../src/server/main.ts";
import { EventBus } from "../src/store/events.ts";
import { wavHeader } from "../src/audio/wav.ts";
import { limit, streamGain } from "../src/server/audio.ts";
import { parseNotices } from "../src/licenses.ts";

/** A fake pipeline: records every command and emits the events a real session would. */
class FakeEngine implements EngineApi {
  bus = new EventBus();
  calls: [string, ...unknown[]][] = [];
  names: Record<string, string> = { spk_1: "Speaker 1", spk_2: "Speaker 2" };
  state() { return { session: { id: "s1" }, speakers: this.names }; }
  async start(req: StartRequest) { this.calls.push(["start", req]); return { sessionId: "s1" }; }
  async stop() { this.calls.push(["stop"]); return { sessionId: "s1" }; }
  async devices() { return [{ uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", transport: "builtin", isDefault: true }]; }
  renameSpeaker(id: string, displayName: string) {
    if (!this.names[id]) throw new ApiError(404, "unknown speaker");
    this.names[id] = displayName;
    this.bus.emit("speaker.updated", { id, displayName });
    return { id, displayName };
  }
  mergeSpeakers(fromId: string, intoId: string) { this.calls.push(["merge", fromId, intoId]); return { id: intoId }; }
  putLabels(body: unknown) {
    if ((body as any).boundary === "changed") throw new ApiError(409, "boundary");
    this.calls.push(["labels", body]);
    return { version: "abc123def456" };
  }
  relabel() { this.calls.push(["relabel"]); return { segments: 2 }; }
  putStories(h: string[]) { this.calls.push(["stories", h]); return { version: "v2" }; }
  override(id: string, note?: string) { this.calls.push(["override", id, note]); return { id, disputed: true }; }
  rollback(version: string) { this.calls.push(["rollback", version]); return { active: version }; }
  stats() { return { roganIndex: 0.25 }; }
  listSessions(q?: string, all?: boolean) { this.calls.push(["list", q, all]); return [{ id: "20260925-120000", name: "Pilot" }]; }
  getSession(id: string) { if (id !== "20260925-120000") throw new ApiError(404, "unknown session"); return { id }; }
  updateSession(id: string, patch: unknown) { this.calls.push(["update", id, patch]); return { id, ...(patch as object) }; }
  openSession(id: string) { this.calls.push(["open", id]); return { sessionId: id, events: 12 }; }
  deleteSession(id: string) { this.calls.push(["delete", id]); return { deleted: id }; }
  closeView() { this.calls.push(["close"]); return { closed: "20260925-120000" }; }
  pause() { this.calls.push(["pause"]); return { paused: true }; }
  audioDir = "";
  sessionDir(id: string) { if (id !== "20260925-120000") throw new ApiError(404, "unknown session"); return this.audioDir; }
  async speakerSuggestions(v?: number) { this.calls.push(["suggest", v]); return { suggestions: [], voices: { host: 1, remote: v ?? 2 } }; }
  callLog(system: "s1" | "s2", limit?: number) { return { rows: [{ system, limit }], models: { s1: "typesafe/jev-1.13", s2: "openai/gpt-6-luna" } }; }
  resume() { this.calls.push(["resume"]); return { paused: false }; }
}

let base = "";
const engine = new FakeEngine();
const web = mkdtempSync(join(tmpdir(), "web-"));
const server = createApiServer(engine, { webRoot: web });

beforeAll(async () => {
  mkdirSync(join(web, "dist"), { recursive: true });
  mkdirSync(join(web, "fonts"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(web, "licenses.html"), "<!doctype html><title>l</title>");
  writeFileSync(join(web, "styles.css"), "body{}");
  writeFileSync(join(web, "dist", "app.js"), "export {}");
  writeFileSync(join(web, "fonts", "face.woff2"), "wOF2");
  writeFileSync(join(tmpdir(), "secret.txt"), "top secret");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

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
    expect((await call("PUT", "/api/labels", { prefix: "p" })).json).toEqual({ version: "abc123def456" });
    expect((await call("PUT", "/api/labels", { boundary: "changed" })).status).toBe(409);
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
    expect(engine.calls.map((c) => c[0])).toEqual(["start", "merge", "labels", "relabel", "stories", "override", "rollback", "stop", "list", "update", "open"]);
    expect(engine.calls[8]).toEqual(["list", "jev cheap", true]);
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
