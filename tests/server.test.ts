import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiError, createApiServer, engineStale, type EngineApi, type StartRequest } from "../src/server/main.ts";
import { EventBus } from "../src/store/events.ts";

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
  pause() { this.calls.push(["pause"]); return { paused: true }; }
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

describe("HTTP API", () => {
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

  test("the page can tell when the engine code changed after the server started", async () => {
    expect((await call("GET", "/api/engine")).json).toMatchObject({ stale: false });
    const src = mkdtempSync(join(tmpdir(), "src-"));
    mkdirSync(join(src, "store"));
    writeFileSync(join(src, "store", "a.ts"), "export {}");
    expect(engineStale(src, Date.now() + 60_000)).toBe(false);
    expect(engineStale(src, Date.now() - 60_000)).toBe(true);
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
