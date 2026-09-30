import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { about, bootEngine, Engine, engineStale, labelSetFileName, replaySources, type LiveCapture } from "../src/server/main.ts";
import type { AudioFrame, AudioSource, StreamName } from "../src/audio/source.ts";
import { LabelSetError, type LabelSetStore } from "../src/labels/store.ts";
import type { TranscriptionSettings } from "../src/settings.ts";
import { setAppPaths } from "../src/paths.ts";
import { writeZip } from "../src/store/zip.ts";
import { requireAssets } from "./helpers.ts";
import {
  cleanTmpDirs, ev, FakeEmbedder, fakeOpenRouter, FakeSocket, fixtureSlice, makeSession, recording, silence, snapshotKeyEnv, tmpDir, transcribeOnlyServices, wavFile, withEnv,
} from "./fakes/index.ts";
import { http, listen } from "./fakes/http.ts";

// The engine itself (src/server/main.ts), offline: fake services, a temporary recordings folder, short WAVs, and a
// fake live capture whose audio lasts until it is stopped. The router over it is in tests/server-routes.test.ts.

const restoreKeys = snapshotKeyEnv();
afterEach(() => { restoreKeys(); setAppPaths(); vi.useRealTimers(); });
afterAll(() => cleanTmpDirs());

/** A folder to replay: one second of silence on the host stream. */
function replayDir(): string {
  const dir = tmpDir("replay-");
  wavFile(dir, silence(16_000), "host.wav");
  return dir;
}

/** Silence until stopped, 512 samples at a time: a live stream that lasts as long as a test needs. */
class Endless implements AudioSource {
  stopped = false;
  /** `lead`: samples played first (speech, say), then silence. */
  constructor(readonly stream: StreamName, private readonly lead: Float32Array<ArrayBufferLike> = new Float32Array(0)) {}
  async *frames(): AsyncIterable<AudioFrame> {
    for (let off = 0, ms = 0; !this.stopped; off += 512, ms += 32) {
      const samples = new Float32Array(512);
      if (off < this.lead.length) samples.set(this.lead.subarray(off, off + 512));
      yield { samples, sessionMs: ms };
      if (off >= this.lead.length) await new Promise((r) => setTimeout(r, 2));
    }
  }
}

/** A fake live capture: records the mic asked for, the status handler, and when it was stopped. */
function fakeLive(log: string[] = [], lead?: Float32Array<ArrayBufferLike>) {
  const src = new Endless("host", lead);
  const live = {
    log, src, mic: undefined as string | undefined, status: null as null | ((type: "error" | "health", data: Record<string, unknown>) => void),
    capture: async (mic: string | undefined, onStatus: (type: "error" | "health", data: Record<string, unknown>) => void): Promise<LiveCapture> => {
      live.mic = mic;
      live.status = onStatus;
      return { sources: [src], stop: async () => { log.push("capture stopped"); src.stopped = true; } };
    },
  };
  return live;
}

/** An engine whose sessions call no service (transcription answers, nothing else is asked), and live text a fake socket. */
function offlineEngine(extra: ConstructorParameters<typeof Engine>[0] = {}) {
  const sessionsDir = extra.sessionsDir ?? tmpDir("sessions-");
  const engine = new Engine({
    ...extra, sessionsDir,
    session: { services: transcribeOnlyServices, embedder: new FakeEmbedder() as never, liveConnect: (u, h) => new FakeSocket(u, h), ...extra.session },
  });
  return { engine, sessionsDir };
}

const OFF = { factcheck: false, labels: false };

/** Ends a live session a test left running. */
async function end(engine: Engine, live?: ReturnType<typeof fakeLive>) {
  if (live) live.src.stopped = true;
  if (engine.current && engine.current.status !== "ended") await engine.current.stop();
}

describe("Engine.start", () => {
  test("a name over 120 characters is refused before the session starts (B1)", async () => {
    requireAssets();
    const { engine, sessionsDir } = offlineEngine();
    const start = engine.start({ mode: "replay", dir: replayDir(), speed: "max", name: "x".repeat(121), features: OFF });
    await expect(start).rejects.toMatchObject({ status: 400, message: "name is too long" });
    expect(engine.current).toBeNull();
    expect(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []).toEqual([]);
    // and the next start is not refused as "already running"
    const ok = await engine.start({ mode: "replay", dir: replayDir(), speed: "max", name: "  Pilot  ", features: OFF });
    expect(engine.library.get(ok.sessionId).name).toBe("Pilot");
    expect(JSON.parse(readFileSync(join(sessionsDir, ok.sessionId, "meta.json"), "utf8"))).toEqual({ name: "Pilot" });
    await engine.current!.run();
  });

  test("a blank name is ignored: no meta.json", async () => {
    requireAssets();
    const { engine, sessionsDir } = offlineEngine();
    const { sessionId } = await engine.start({ mode: "replay", dir: replayDir(), speed: "max", name: "   ", features: OFF });
    await engine.current!.run();
    expect(existsSync(join(sessionsDir, sessionId, "meta.json"))).toBe(false);
  });

  test("request checks, before anything starts: mode, dir, WAVs, features, stories, label set", async () => {
    const { engine } = offlineEngine();
    const refused = async (req: unknown, status: number, message: string | RegExp) => {
      const p = engine.start(req as never);
      await expect(p).rejects.toMatchObject({ status });
      await expect(p).rejects.toThrow(message);
    };
    await refused({ mode: "x" }, 400, "mode must be replay or live");
    await refused(undefined, 400, "mode must be replay or live");
    await refused({ mode: "replay" }, 400, "dir or sessionId is required");
    await refused({ mode: "replay", dir: "" }, 400, "dir or sessionId is required");
    await refused({ mode: "replay", dir: tmpDir("empty-") }, 400, /^no host.wav or remote.wav in /);
    await refused({ mode: "replay", sessionId: "20990101-000000" }, 404, "unknown session 20990101-000000");
    await refused({ mode: "replay", sessionId: "../etc" }, 404, "invalid session id ../etc");
    await refused({ mode: "live" }, 501, "live capture is not available");
    await refused({ mode: "replay", features: "all" }, 400, "features must be an object");
    await refused({ mode: "replay", features: { factcheck: 1 } }, 400, "features.factcheck must be true or false");
    await refused({ mode: "replay", stories: "one" }, 400, "stories must be an array of strings");
    await refused({ mode: "replay", stories: ["a", 2] }, 400, "stories must be an array of strings");
    await refused({ mode: "replay", stories: Array.from({ length: 255 }, (_, i) => `s${i}`) }, 400, "at most 254 stories");
    await refused({ mode: "replay", stories: ["x".repeat(301)] }, 400, "a story is at most 300 characters");
    await refused({ mode: "replay", labelSet: 42 }, 400, "labelSet must be a label set id, or null for labels off");
    await refused({ mode: "replay", labelSet: "nope" }, 400, "There is no label set nope: pick another in Start live.");
    expect(engine.current).toBeNull();
  });

  test("tonight's stories are trimmed, and blank ones dropped", async () => {
    requireAssets();
    const { engine } = offlineEngine();
    await engine.start({ mode: "replay", dir: replayDir(), speed: "max", features: { factcheck: false }, stories: ["  Jev launch ", "", "   ", "GPT-6"] });
    expect(engine.current!.timeline.storiesActive).toEqual(["Jev launch", "GPT-6"]);
    await engine.current!.run();
  });

  test("an event that fails its schema is reported on the console, and still sent", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { engine } = offlineEngine();
    engine.bus.emit("speaker.updated", { id: 7 });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^event speaker.updated failed validation: /));
    expect(engine.bus.history().length).toBe(1);
    err.mockRestore();
  });

  test("a label-set store that fails otherwise: its own message, or the error as it is", async () => {
    const store = (e: Error) => ({ get: () => { throw e; } }) as unknown as LabelSetStore;
    const a = offlineEngine({ labelSets: store(new LabelSetError(400, "the set file is damaged")) }).engine;
    await expect(a.start({ mode: "replay", labelSet: "mine" })).rejects.toMatchObject({ status: 400, message: "the set file is damaged" });
    const b = offlineEngine({ labelSets: store(new TypeError("boom")) }).engine;
    await expect(b.start({ mode: "replay" })).rejects.toThrow(TypeError);
  });

  test("the keys a session needs, when it calls the real services", async () => {
    const engine = new Engine({ sessionsDir: tmpDir("sessions-") });
    await withEnv({ OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, async () => {
      await expect(engine.start({ mode: "replay" })).rejects.toMatchObject({ status: 400, extra: { needsKey: "openrouter" } });
      await expect(engine.start({ mode: "replay", features: { factcheck: false }, labelSet: "ai-podcast" })).rejects.toMatchObject({ extra: { needsKey: "openrouter" } });
      const noOpenai = engine.start({ mode: "replay", features: OFF });
      await expect(noOpenai).rejects.toMatchObject({ status: 400, message: "Transcribing with OpenAI needs an OpenAI API key.", extra: { needsKey: "openai" } });
      // labels off by a null set count as off too
      await expect(engine.start({ mode: "replay", features: { factcheck: false }, labelSet: null })).rejects.toMatchObject({ extra: { needsKey: "openai" } });
    });
    // with both keys (from the environment, or given to the sessions) the checks pass and the request's own errors show
    await withEnv({ OPENAI_API_KEY: "sk-proj-env-000000000000000000", OPENROUTER_API_KEY: "sk-or-v1-env-0000000000000000" }, async () => {
      await expect(engine.start({ mode: "nope" } as never)).rejects.toThrow("mode must be replay or live");
    });
    await withEnv({ OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, async () => {
      const keyed = new Engine({ sessionsDir: tmpDir("sessions-"), session: { keys: { openai: "sk-proj-k-000000000000000", openrouter: "sk-or-v1-k-00000000000000" } } });
      expect(keyed.openrouterKeySet()).toBe(true);
      await expect(keyed.start({ mode: "nope" } as never)).rejects.toThrow("mode must be replay or live");
      const blank = new Engine({ sessionsDir: tmpDir("sessions-"), openrouterKey: "  " });
      expect(blank.openrouterKeySet()).toBe(false);
    });
  });

  test("with Apple Speech, a session waits for its model: 409 preparing", async () => {
    const transcription = { engine: "apple", ready: false } as unknown as TranscriptionSettings;
    const { engine } = offlineEngine({ transcription });
    await expect(engine.start({ mode: "replay", features: OFF })).rejects.toMatchObject({ status: 409, extra: { preparing: true } });
  });

  test("replay by recording id, the speed, and the voices on the call", async () => {
    requireAssets();
    const { engine, sessionsDir } = offlineEngine();
    const rec = join(sessionsDir, "20260925-120000");
    mkdirSync(rec);
    writeFileSync(join(rec, "session.json"), JSON.stringify({ id: "20260925-120000", mode: "live", startedAt: "2026-09-25T12:00:00Z" }));
    wavFile(rec, silence(8000), "remote.wav");
    const sockets: FakeSocket[] = [];
    const slow = offlineEngine({ sessionsDir, session: { liveConnect: (u, h) => { const s = new FakeSocket(u, h); sockets.push(s); return s; } } }).engine;
    // speed "max" skips live text; any other speed is real time, with live text
    await engine.start({ mode: "replay", sessionId: "20260925-120000", speed: "max", features: OFF, voices: 2 });
    expect(engine.current!.voices.remote).toBe(2);
    expect(engine.current!.state().session.streams).toEqual(["remote"]);
    await engine.current!.run();
    await slow.start({ mode: "replay", sessionId: "20260925-120000", speed: "1", features: OFF, voices: -1 } as never);
    expect(sockets.length).toBeGreaterThan(0);
    const cfgRemote = (await import("../src/config.ts")).loadConfig().app.speakers.voicesPerStream.remote;
    expect(slow.current!.voices.remote).toBe(cfgRemote); // -1 is ignored: the config's value
    await slow.stop();
    await engine.start({ mode: "replay", dir: replayDir(), speed: "max", features: OFF, voices: "2" as never });
    expect(engine.current!.voices.remote).toBe(cfgRemote);
    await engine.current!.run();
  });

  test("a second start while a session runs is refused", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    await engine.start({ mode: "live", mic: "BuiltInMicrophoneDevice", features: OFF });
    expect(live.mic).toBe("BuiltInMicrophoneDevice");
    await expect(engine.start({ mode: "replay", dir: replayDir() })).rejects.toMatchObject({ status: 409, message: "a session is already running" });
    await end(engine, live);
  });

  test("live capture status: errors become error events, health says where the call plays", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    await engine.start({ mode: "live", features: OFF });
    const s = engine.current!;
    const setOutput = vi.spyOn(s, "setOutput");
    live.status!("error", { component: "capture", message: "the mic stopped" });
    expect(engine.bus.history().filter((e) => e.type === "error").map((e) => e.data.message)).toEqual(["the mic stopped"]);
    // health without a `capture` wrapper is the detail itself
    live.status!("health", { remote: { outputKind: "virtual", outputDevice: "BlackHole 2ch" } });
    expect(setOutput).toHaveBeenLastCalledWith("virtual", "BlackHole 2ch");
    expect((engine as unknown as { captureDetail: unknown }).captureDetail).toEqual({ remote: { outputKind: "virtual", outputDevice: "BlackHole 2ch" } });
    live.status!("health", { capture: { remote: { outputKind: "bogus", outputDevice: 7 } } });
    expect(setOutput).toHaveBeenLastCalledWith(null, null);
    live.status!("health", { capture: { remote: { outputKind: "speakers", outputDevice: "MacBook Speakers" } } });
    expect(setOutput).toHaveBeenLastCalledWith("speakers", "MacBook Speakers");
    const calls = setOutput.mock.calls.length;
    live.status!("health", { capture: { type: "started" } }); // no remote: nothing to follow
    expect(setOutput.mock.calls.length).toBe(calls);
    await end(engine, live);
  });

  test.fails("BUG §11.2: a capture whose session cannot be built is stopped, not left running", async () => {
    let stopped = false;
    const { engine } = offlineEngine({ live: async () => ({ sources: [], stop: async () => { stopped = true; } }) });
    await expect(engine.start({ mode: "live", features: OFF })).rejects.toThrow("at least one audio source is required");
    expect(stopped).toBe(true);
  });

  test("a capture that fails to start fails the start", async () => {
    const { engine } = offlineEngine({ live: async () => { throw new Error("the capture helper is not built"); } });
    await expect(engine.start({ mode: "live", features: OFF })).rejects.toThrow("the capture helper is not built");
    expect(engine.current).toBeNull();
  });

  test("a session whose run fails is logged, not thrown", async () => {
    requireAssets();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { engine } = offlineEngine();
    await engine.start({ mode: "replay", dir: replayDir(), speed: "max", features: OFF });
    const s = engine.current!;
    const finish = vi.spyOn(s as unknown as { finish: (reason: string) => Promise<void> }, "finish").mockRejectedValue(new Error("disk full"));
    await expect(s.run()).rejects.toThrow("disk full");
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalledWith("session failed:", expect.objectContaining({ message: "disk full" }));
    expect(engine.current).toBe(s); // not archived
    finish.mockRestore();
    await (s as unknown as { finish: (reason: string) => Promise<void> }).finish("error"); // stops the session's timers
    err.mockRestore();
  });
});

describe("the running session's commands", () => {
  test("stop ends the live capture first, then the session; nothing to stop is a 409", async () => {
    requireAssets();
    const log: string[] = [];
    const live = fakeLive(log);
    const { engine } = offlineEngine({ live: live.capture });
    await expect(engine.stop()).rejects.toMatchObject({ status: 409, message: "no session" });
    const { sessionId } = await engine.start({ mode: "live", features: OFF });
    const s = engine.current!;
    const stop = s.stop.bind(s);
    vi.spyOn(s, "stop").mockImplementation(async () => { log.push("session stopped"); await stop(); });
    expect(await engine.stop()).toEqual({ sessionId });
    expect(log).toEqual(["capture stopped", "session stopped"]);
    expect((engine as unknown as { capture: unknown }).capture).toBeNull();
    await new Promise((r) => setImmediate(r));
    await expect(engine.stop()).rejects.toMatchObject({ status: 409, message: "viewing a recorded session: start or replay one to use this command" });
  });

  test("pause and resume a live session; a replay cannot pause; an ending session refuses both", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    await engine.start({ mode: "live", features: OFF });
    expect(engine.pause()).toEqual({ paused: true });
    expect(engine.current!.paused).toBe(true);
    expect(engine.resume()).toEqual({ paused: false });
    engine.current!.status = "ending";
    expect(() => engine.pause()).toThrow("the session is ending");
    expect(() => engine.resume()).toThrow("the session is ending");
    engine.current!.status = "running";
    await end(engine, live);
    const r = offlineEngine().engine;
    await r.start({ mode: "replay", dir: replayDir(), speed: "max", features: OFF });
    expect(() => r.pause()).toThrow("only a live session can be paused");
    expect(r.resume()).toEqual({ paused: false }); // a replay resumes (a no-op)
    await r.current!.run();
  });

  test("speakers on air: rename and merge, unknown ids first, then the name", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    await engine.start({ mode: "live", features: OFF });
    const s = engine.current!;
    const a = s.speakers.assign("host", new Float32Array(32_000).fill(0.001)).speakerId;
    const b = s.speakers.assign("remote", new Float32Array(32_000).fill(0.02)).speakerId; // the host's mic carries one voice
    expect(a).not.toBe(b);
    expect(() => engine.renameSpeaker("spk_99", "")).toThrow("unknown speaker spk_99"); // 404 before the name is checked
    expect(() => engine.renameSpeaker(a, "  ")).toThrow("displayName is required");
    expect(() => engine.renameSpeaker(a, 5 as never)).toThrow("displayName is required");
    expect(engine.renameSpeaker(a, "Nic")).toMatchObject({ id: a, displayName: "Nic" });
    expect(() => engine.mergeSpeakers("spk_99", a)).toThrow("unknown speaker");
    expect(() => engine.mergeSpeakers(a, "spk_99")).toThrow("unknown speaker");
    expect(engine.mergeSpeakers(b, a)).toMatchObject({ id: a });
    await end(engine, live);
  });

  test("labels on, fact-checking off: relabel and stories run; overrides and rollbacks are refused", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    await engine.start({ mode: "live", features: { factcheck: false } });
    expect(engine.relabel()).toEqual({ segments: 0 });
    expect(engine.putStories(["Jev launch"])).toEqual({ version: expect.any(String) });
    expect(() => engine.putStories("A" as never)).toThrow("headlines must be an array of strings");
    expect(() => engine.putStories([1] as never)).toThrow("headlines must be an array of strings");
    expect(() => engine.override("c_1")).toThrow("fact-checking is off for this session");
    expect(() => engine.rollback("s1@1")).toThrow("fact-checking is off for this session");
    expect(engine.stats()).toMatchObject({ roganIndex: expect.any(Number) });
    await end(engine, live);
  });

  test("fact-checking on: an unknown claim or version is a 404; a known version is restored", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    await engine.start({ mode: "live", features: { labels: false } });
    expect(() => engine.override("c_9", "no")).toThrow("unknown claim c_9");
    expect(() => engine.rollback("s1@9")).toThrow("unknown version s1@9");
    const active = engine.current!.factcheck.active.id;
    expect(engine.rollback(active)).toEqual({ active });
    // a claim with a verdict can be disputed
    const fc = engine.current!.factcheck as unknown as { claims: Map<string, unknown> };
    fc.claims.set("c_1", { id: "c_1", verdict: { verdict: "supported" }, utteranceId: "u_1", text: "x" });
    expect(engine.override("c_1", "the host disagrees")).toMatchObject({ disputed: true, note: "the host disagrees" });
    expect(() => engine.relabel()).toThrow("labels are off for this session");
    await end(engine, live);
  });

  test("state while on air carries the recording's name; a session outside the library has none", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    await engine.start({ mode: "live", features: OFF, name: "Episode 12" });
    expect((engine.state() as any).session).toMatchObject({ status: "running", name: "Episode 12" });
    await end(engine, live);
    // the session writes elsewhere than the library reads: not listed, so no name
    const other = fakeLive();
    const apart = offlineEngine({ live: other.capture, session: { sessionsDir: tmpDir("elsewhere-") } }).engine;
    await apart.start({ mode: "live", features: OFF });
    expect((apart.state() as any).session.name).toBeNull();
    await end(apart, other);
  });

  test("merge suggestions on air use the session's voices and talk time", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    await expect(engine.speakerSuggestions()).rejects.toMatchObject({ status: 409, message: "no session" });
    await engine.start({ mode: "live", features: OFF, voices: 1 });
    const s = engine.current!;
    s.speakers.assign("host", new Float32Array(32_000).fill(0.001));
    const r = await engine.speakerSuggestions();
    expect(r.voices).toEqual({ host: s.voices.host, remote: 1 });
    expect(r.suggestions).toEqual([]);
    expect((await engine.speakerSuggestions(3)).voices.remote).toBe(3);
    await end(engine, live);
  });

  test("merge suggestions on air count each speaker's talk time, from the session's stats", async () => {
    requireAssets();
    const live = fakeLive([], fixtureSlice("host", 0, 12_000));
    const { engine } = offlineEngine({ live: live.capture });
    await engine.start({ mode: "live", features: OFF });
    for (let i = 0; i < 500 && !engine.bus.history().some((e) => e.type === "utterance"); i++) await new Promise((r) => setTimeout(r, 20));
    const s = engine.current!;
    const [print] = s.speakers.voiceprints();
    expect(print).toBeDefined();
    const stats = vi.spyOn(s, "stats").mockReturnValue({ ...s.stats(), speakers: [{ speakerId: print.id, talkMs: 4200 }] } as never);
    const r = await engine.speakerSuggestions();
    expect(stats).toHaveBeenCalled();
    expect(r.suggestions).toEqual([]); // one voice: nothing to merge
    await end(engine, live);
  });

  test("devices come from the capture helper, when there is one", async () => {
    await expect(offlineEngine().engine.devices()).rejects.toMatchObject({ status: 501, message: "device listing is not available" });
    const devices = [{ uid: "mic", name: "Mic", transport: "usb", isDefault: false }];
    expect(await offlineEngine({ devices: async () => devices }).engine.devices()).toBe(devices);
  });
});

describe("recordings through the engine", () => {
  /** A library with two recordings, and an engine over it. */
  function library() {
    const root = tmpDir("library-");
    makeSession(root, "20260924-100000", { startedAt: "2026-09-24T10:00:00Z", lines: [["u_1", "Hello there."], ["u_2", "Surfing in Sydney."]] });
    makeSession(root, "20260925-090000", { startedAt: "2026-09-25T09:00:00Z", lines: [["u_1", "Welcome."]] });
    return { root, ...offlineEngine({ sessionsDir: root }) };
  }

  test("closing the view: nothing open, or the open recording and its history", () => {
    const { engine } = library();
    expect(engine.closeView()).toEqual({ closed: null });
    engine.openSession("20260924-100000");
    expect(engine.bus.history().length).toBeGreaterThan(0);
    expect(engine.closeView()).toEqual({ closed: "20260924-100000" });
    expect(engine.bus.history()).toEqual([]);
    expect(engine.state()).toEqual({ session: null });
  });

  test("deleting a recording not on screen keeps the one on screen", () => {
    const { engine, root } = library();
    engine.openSession("20260924-100000");
    const before = engine.bus.history().length;
    expect(engine.deleteSession("20260925-090000")).toEqual({ deleted: "20260925-090000" });
    expect(existsSync(join(root, "20260925-090000"))).toBe(false);
    expect(engine.bus.history().length).toBe(before);
    expect((engine.state() as any).session.id).toBe("20260924-100000");
  });

  test("on air: the running session cannot be deleted, and no recording can be opened", async () => {
    requireAssets();
    const live = fakeLive();
    const { root } = library();
    const { engine } = offlineEngine({ sessionsDir: root, live: live.capture });
    const { sessionId } = await engine.start({ mode: "live", features: OFF });
    expect(() => engine.deleteSession(sessionId)).toThrow("stop the session before deleting it");
    expect(() => engine.openSession("20260924-100000")).toThrow("a session is running: stop it first");
    // once the session has ended (before it is archived), a recording opens in its place
    engine.current!.status = "ended";
    expect(engine.openSession("20260924-100000")).toMatchObject({ sessionId: "20260924-100000" });
    expect(engine.current).toBeNull();
    live.src.stopped = true;
  });

  test("the call log: none without a session; the recording's last rows and its models", () => {
    const { engine, root } = library();
    const cfg = (engine as unknown as { config: { app: { jev: { model: string }; s2: { model: string } } } }).config.app;
    expect(engine.callLog("s1")).toEqual({ rows: [], models: { s1: cfg.jev.model, s2: cfg.s2.model } });
    writeFileSync(join(root, "20260924-100000", "jev_calls.jsonl"), [1, 2, 3].map((n) => JSON.stringify({ kind: "jev_call", n })).join("\n") + "\n");
    engine.openSession("20260924-100000");
    expect(engine.callLog("s1", 2)).toEqual({ rows: [{ kind: "jev_call", n: 2 }, { kind: "jev_call", n: 3 }], models: { s1: null, s2: null } });
    expect(engine.callLog("s2").rows).toEqual([]);
  });

  test("stats and commands are refused on a recording; its state is its snapshot, until its folder goes", () => {
    const { engine, root } = library();
    engine.openSession("20260924-100000");
    expect(() => engine.stats()).toThrow("viewing a recorded session");
    expect(() => engine.relabel()).toThrow("viewing a recorded session");
    expect((engine.state() as any).session.status).toBe("archived");
    rmSync(join(root, "20260924-100000"), { recursive: true });
    expect(() => engine.state()).toThrow(/unknown session/);
  });

  test("renaming and merging on a recording: unknown speakers, blank names, and a merge into itself", () => {
    const { engine } = library();
    engine.openSession("20260924-100000");
    expect(() => engine.renameSpeaker("spk_9", "X")).toThrow("unknown speaker spk_9");
    expect(() => engine.renameSpeaker("spk_1", " ")).toThrow("displayName is required");
    expect(engine.renameSpeaker("spk_1", " Nicolas ")).toEqual({ id: "spk_1", displayName: "Nicolas" });
    expect(() => engine.mergeSpeakers("spk_1", "spk_9")).toThrow("unknown speaker");
    expect(() => engine.mergeSpeakers("spk_1", "spk_1")).toThrow("cannot merge a speaker into itself");
  });

  test("merge suggestions for a recording read its audio, with the voices it ran with", async () => {
    requireAssets();
    const { engine, root } = library();
    const dir = join(root, "20260924-100000");
    writeFileSync(join(dir, "utterances.jsonl"), [
      { id: "u_1", stream: "host", start_ms: 0, end_ms: 4000, speaker_id: "spk_1", speaker_inferred: false, tags: [] },
      { id: "u_2", stream: "host", start_ms: 5000, end_ms: 9000, speaker_id: "spk_1", speaker_inferred: false, tags: [] },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    writeFileSync(join(dir, "session.json"), JSON.stringify({ ...session, voices: { host: 1, remote: 4 } }));
    engine.openSession("20260924-100000");
    const r = await engine.speakerSuggestions();
    expect(r.voices).toEqual({ host: 1, remote: 4 });
    expect(Array.isArray(r.suggestions)).toBe(true);
    expect((await engine.speakerSuggestions(2)).voices).toEqual({ host: 1, remote: 2 });
    // a recording from before voices were recorded falls back to the config
    engine.openSession("20260925-090000");
    writeFileSync(join(root, "20260925-090000", "utterances.jsonl"), "");
    expect((await engine.speakerSuggestions()).suggestions).toEqual([]);
  });

  test("a recording's folder for playback", () => {
    const { engine, root } = library();
    expect(engine.sessionDir("20260924-100000")).toBe(join(root, "20260924-100000"));
    expect(() => engine.sessionDir("nope")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => engine.getSession("nope")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => engine.updateSession("20260924-100000", { name: 5 as never })).toThrow(expect.objectContaining({ status: 400, message: "name must be a string" }));
    expect(engine.updateSession("20260924-100000", null as never)).toMatchObject({ id: "20260924-100000" });
    expect(engine.listSessions("sydney").map((s: any) => s.id)).toEqual(["20260924-100000"]);
  });
});

describe("the chat's session", () => {
  const KEY = "sk-or-v1-chat-test-0000000000000";

  test("no session on screen: nothing to list, and a new chat is refused", async () => {
    const { engine } = offlineEngine({ openrouterKey: KEY, fetch: fakeOpenRouter().fetchFn });
    expect(engine.chat.list()).toMatchObject({ sessionId: null, chats: [] });
    await expect(engine.chat.create()).rejects.toMatchObject({ status: 409 });
  });

  test("a recording on screen: its transcript, and each reply's cost refreshes its header", async () => {
    const root = tmpDir("library-");
    makeSession(root, "20260924-100000", { startedAt: "2026-09-24T10:00:00Z", lines: [["u_1", "Jev is cheaper."]] });
    const { fetchFn, bodies } = fakeOpenRouter();
    const { engine } = offlineEngine({ sessionsDir: root, openrouterKey: KEY, fetch: fetchFn });
    engine.openSession("20260924-100000");
    const chat: any = await engine.chat.create();
    const sink: string[] = [];
    await engine.chat.prepare(chat.id, { content: "What was said?" })((e) => sink.push(e.type));
    expect(sink.at(-1)).toBe("done");
    expect(JSON.stringify(bodies[0])).toContain("Jev is cheaper.");
    const costs: any[] = [];
    engine.bus.subscribe((e) => { if (e.type === "cost") costs.push(e.data); });
    await engine.chat.prepare(chat.id, { content: "And then?" })(() => {});
    expect(costs.length).toBe(1);
    expect(costs[0].chat).toBeCloseTo(0.0024);
    expect(costs[0].session).toBeCloseTo(0.01 + 0.0024);
    expect(engine.bus.history().some((e) => e.type === "cost")).toBe(false); // transient
  });

  test("a session on air: a live source with its budget, whose own events carry the cost", async () => {
    requireAssets();
    const live = fakeLive();
    const { fetchFn } = fakeOpenRouter();
    const { engine } = offlineEngine({ live: live.capture, openrouterKey: KEY, fetch: fetchFn });
    await engine.start({ mode: "live", features: OFF });
    const chat: any = await engine.chat.create();
    const types: string[] = [];
    engine.bus.subscribe((e) => types.push(e.type));
    await engine.chat.prepare(chat.id, { content: "Anything yet?" })(() => {});
    expect(engine.chat.list()).toMatchObject({ sessionId: engine.current!.id });
    expect(types.filter((t) => t === "cost").length).toBe(1); // the session's budget, not the recording's refresh
    await end(engine, live);
  });

  test("without a fetch of its own, the chat uses the global one (refused offline): no catalogue", async () => {
    const { engine } = offlineEngine({ openrouterKey: KEY });
    expect((await engine.chat.models()).models.every((m) => m.available === null)).toBe(true);
  });

  test("the chat reads the key on each call, from the environment when none is given", async () => {
    await withEnv({ OPENROUTER_API_KEY: "sk-or-v1-from-env-000000000000" }, () => {
      const { engine } = offlineEngine();
      expect(engine.openrouterKeySet()).toBe(true);
      expect((engine.chat as unknown as { deps: { apiKey: string } }).deps.apiKey).toBe("sk-or-v1-from-env-000000000000");
    });
    await withEnv({ OPENROUTER_API_KEY: undefined }, () => {
      const { engine } = offlineEngine();
      expect((engine.chat as unknown as { deps: { apiKey: string } }).deps.apiKey).toBe("");
    });
  });
});

describe("export and import through the engine", () => {
  /** Runs `fn` with the system's temporary folder pointed at a fresh one, where exports and uploads go. */
  async function inTmp<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
    const tmp = tmpDir("os-tmp-");
    return withEnv({ TMPDIR: tmp }, () => fn(tmp));
  }
  async function* bytes(b: Buffer) { yield b; }

  test("info: the file name, the versions, and each audio choice's size", () => {
    const root = tmpDir("library-");
    recording(root);
    const { engine } = offlineEngine({ sessionsDir: root });
    expect(engine.transfer.info("20260925-120000")).toMatchObject({
      id: "20260925-120000", name: "Episode 12: a/b", fileName: "Episode 12 a b.tattle", recordedWith: "0.2.0",
      app: { name: expect.any(String), version: expect.any(String) }, chats: 1, hasAudio: true,
      bytes: { compressed: expect.any(Number), original: expect.any(Number), none: expect.any(Number) },
    });
    expect(() => engine.transfer.info("nope")).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("prepare: the choices are checked; the file waits for its download, then is deleted", async () => {
    const root = tmpDir("library-");
    recording(root);
    const { engine } = offlineEngine({ sessionsDir: root });
    await inTmp(async (tmp) => {
      await expect(engine.transfer.prepare("20260925-120000", { audio: "mp3" })).rejects.toMatchObject({ status: 400, message: "audio must be compressed, original, or none" });
      await expect(engine.transfer.prepare("20260925-120000", { audio: "none", chats: "yes" })).rejects.toMatchObject({ status: 400, message: "chats must be true or false" });
      await expect(engine.transfer.prepare("nope", {})).rejects.toMatchObject({ status: 404 });
      const r = await engine.transfer.prepare("20260925-120000", { audio: "none", chats: true });
      expect(r.token).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.fileName).toBe("Episode 12 a b.tattle");
      const f = engine.transfer.file(r.token);
      expect(f.path.startsWith(tmp)).toBe(true);
      expect(existsSync(f.path)).toBe(true);
      engine.exportSent("not-a-token"); // nothing to do
      engine.exportSent(r.token);
      expect(() => engine.transfer.file(r.token)).toThrow("this export has expired: export again");
      for (let i = 0; i < 50 && existsSync(f.path); i++) await new Promise((res) => setTimeout(res, 10));
      expect(existsSync(f.path)).toBe(false);
    });
  });

  test("an export's refusal from the format keeps its status; the export's own timer does nothing once it was sent", async () => {
    const root = tmpDir("library-");
    recording(root);
    const { engine } = offlineEngine({ sessionsDir: root });
    const bin = tmpDir("bin-");
    writeFileSync(join(bin, "afconvert"), "#!/bin/sh\nexit 3\n");
    chmodSync(join(bin, "afconvert"), 0o755);
    await inTmp(async () => {
      await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }, async () => {
        // compressed is the default choice
        await expect(engine.transfer.prepare("20260925-120000", {})).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/afconvert/) });
      });
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const r = await engine.transfer.prepare("20260925-120000", { audio: "none" });
      engine.exportSent(r.token);
      vi.advanceTimersByTime(15 * 60_000); // the entry is gone: nothing more to do
      vi.useRealTimers();
      expect(() => engine.transfer.file(r.token)).toThrow(expect.objectContaining({ status: 404 }));
    });
  });

  test.fails("BUG §11.6: a recording without events.jsonl, listed by the library, exports", async () => {
    const root = tmpDir("library-");
    const dir = recording(root);
    rmSync(join(dir, "events.jsonl"));
    const { engine } = offlineEngine({ sessionsDir: root });
    await inTmp(async () => {
      expect(engine.listSessions().map((s: any) => s.id)).toEqual(["20260925-120000"]);
      await expect(engine.transfer.prepare("20260925-120000", { audio: "none" })).resolves.toMatchObject({ fileName: "Episode 12 a b.tattle" });
    });
  });

  test("an export nobody downloads is deleted after 15 minutes", async () => {
    const root = tmpDir("library-");
    recording(root);
    const { engine } = offlineEngine({ sessionsDir: root });
    await inTmp(async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const r = await engine.transfer.prepare("20260925-120000", { audio: "none" });
      const { path } = engine.transfer.file(r.token);
      vi.advanceTimersByTime(15 * 60_000 - 1);
      expect(engine.transfer.file(r.token).path).toBe(path);
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
      expect(() => engine.transfer.file(r.token)).toThrow(expect.objectContaining({ status: 404 }));
      for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((res) => setTimeout(res, 10));
      expect(existsSync(path)).toBe(false);
    });
  });

  test("a session on air cannot be exported, and nothing can be imported", async () => {
    requireAssets();
    const live = fakeLive();
    const { engine } = offlineEngine({ live: live.capture });
    const { sessionId } = await engine.start({ mode: "live", features: OFF });
    await expect(engine.transfer.prepare(sessionId, {})).rejects.toMatchObject({ status: 409, message: "stop the session before exporting it" });
    let read = false;
    const body = (async function* () { read = true; yield Buffer.from("x"); })();
    await expect(engine.transfer.importFile(body, "a.tattle")).rejects.toMatchObject({ status: 409, message: "a session is on air: import the recording after it ends" });
    expect(read).toBe(false); // refused before reading the upload
    await expect(engine.transfer.importCopy("t", "x")).rejects.toMatchObject({ status: 409 });
    await end(engine, live);
  });

  test("an upload that is not a recording is refused, and its temporary file removed", async () => {
    const { engine } = offlineEngine();
    await inTmp(async (tmp) => {
      await expect(engine.transfer.importFile(bytes(Buffer.from("hello, not a zip")), "x.tattle")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^not a recording file/) });
      expect(readdirSync(tmp)).toEqual([]);
    });
  });

  test("an import error that is not the format's own passes through as it is (§11.18)", async () => {
    const { engine } = offlineEngine();
    const file = join(tmpDir("zip-"), "broken.tattle");
    await inTmp(async (tmp) => {
      const manifest = { format: "tattle-recording", formatVersion: 1, app: { name: "tattle", version: "1.0.1" }, recording: { id: "20260925-120000" }, audio: { streams: [] } };
      await writeZip(file, [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }, { name: "data/session.json", data: Buffer.from("{not json") }, { name: "data/events.jsonl", data: Buffer.from("") }]);
      const p = engine.transfer.importFile(bytes(readFileSync(file)), "broken.tattle");
      await expect(p).rejects.toThrow(SyntaxError);
      await expect(p).rejects.not.toHaveProperty("status");
      expect(readdirSync(tmp)).toEqual([]);
    });
  });

  test("the same recording again: kept for a copy, which takes a name, once; unused, it goes after 15 minutes", async () => {
    const src = tmpDir("library-");
    recording(src);
    const { engine: exporter } = offlineEngine({ sessionsDir: src });
    const dest = tmpDir("library-");
    const { engine } = offlineEngine({ sessionsDir: dest });
    await inTmp(async (tmp) => {
      const r = await exporter.transfer.prepare("20260925-120000", { audio: "none" });
      const file = readFileSync(exporter.transfer.file(r.token).path);
      exporter.exportSent(r.token);
      expect(await engine.transfer.importFile(bytes(file), "Episode.tattle")).toMatchObject({ already: false });
      vi.useFakeTimers({ toFake: ["setTimeout"] }); // the kept uploads' 15 minutes, until the end of the test
      const again: any = await engine.transfer.importFile(bytes(file), "Episode.tattle");
      expect(again).toMatchObject({ already: true, summary: { id: "20260925-120000" }, copyToken: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      await expect(engine.transfer.importCopy("nope", "Copy")).rejects.toMatchObject({ status: 404, message: "the upload has expired: import the file again" });
      await expect(engine.transfer.importCopy(again.copyToken, "  ")).rejects.toMatchObject({ status: 400, message: "a name is required for the copy" });
      await expect(engine.transfer.importCopy(again.copyToken, 7)).rejects.toMatchObject({ status: 400 });
      await expect(engine.transfer.importCopy(again.copyToken, "x".repeat(121))).rejects.toMatchObject({ status: 400, message: "name is too long" });
      const copy: any = await engine.transfer.importCopy(again.copyToken, " Episode (copy) ");
      vi.advanceTimersByTime(15 * 60_000); // the kept upload's timer finds it used: nothing to discard
      expect(copy).toMatchObject({ already: false, summary: { id: "20260925-120000-2", name: "Episode (copy)" } });
      await expect(engine.transfer.importCopy(again.copyToken, "Again")).rejects.toMatchObject({ status: 404 }); // one use
      // a kept upload that is never used is discarded after 15 minutes
      const third: any = await engine.transfer.importFile(bytes(file), "Episode.tattle");
      vi.advanceTimersByTime(15 * 60_000);
      vi.useRealTimers();
      await expect(engine.transfer.importCopy(third.copyToken, "Late")).rejects.toMatchObject({ status: 404 });
      for (let i = 0; i < 50 && readdirSync(tmp).length; i++) await new Promise((res) => setTimeout(res, 10));
      expect(readdirSync(tmp)).toEqual([]);
    });
  });
});

describe("the transcription setting through the engine", () => {
  /** A stand-in for TranscriptionSettings that records what the engine asks of it. */
  function settings(o: { appleAvailable?: boolean; appleReason?: string | null } = {}) {
    const calls: string[] = [];
    const t = {
      engine: "openai", ready: true, appleAvailable: o.appleAvailable ?? true, appleReason: o.appleReason ?? null,
      status: () => ({ engine: t.engine }),
      set: async (e: string) => { calls.push(`set ${e}`); t.engine = e; return t.status(); },
      install: async () => { calls.push("install"); },
    };
    return { t: t as unknown as TranscriptionSettings, calls };
  }

  test("absent without the setting", () => {
    expect(offlineEngine().engine.transcription).toBeUndefined();
  });

  test("changing the engine: its name, not on air, OpenAI's key, and Apple's availability", async () => {
    const { t, calls } = settings({ appleAvailable: false, appleReason: "Needs macOS 26 or later" });
    const { engine } = offlineEngine({ transcription: t });
    const api = engine.transcription!;
    expect(api.status()).toEqual({ engine: "openai" });
    await expect(api.set("whisper")).rejects.toMatchObject({ status: 400, message: "engine must be apple or openai" });
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      await expect(api.set("openai")).rejects.toMatchObject({ status: 400, extra: { needsKey: "openai" } });
    });
    await expect(api.set("apple")).rejects.toMatchObject({ status: 400, message: "On-device transcription is not available: Needs macOS 26 or later" });
    expect(() => api.install()).toThrow("On-device transcription is not available: Needs macOS 26 or later");
    await withEnv({ OPENAI_API_KEY: "sk-proj-env-000000000000000000" }, async () => {
      expect(await api.set("openai")).toEqual({ engine: "openai" });
    });
    expect(calls).toEqual(["set openai"]);
    const unknown = settings({ appleAvailable: false }).t;
    await expect(offlineEngine({ transcription: unknown }).engine.transcription!.set("apple")).rejects.toThrow("not available: unknown reason");
    expect(() => offlineEngine({ transcription: unknown }).engine.transcription!.install()).toThrow("not available: unknown reason");
  });

  test("Apple: chosen and installed when available; refused on air", async () => {
    requireAssets();
    const { t, calls } = settings();
    const live = fakeLive();
    const { engine } = offlineEngine({ transcription: t, live: live.capture });
    expect(await engine.transcription!.set("apple")).toEqual({ engine: "apple" });
    expect(engine.transcription!.install()).toEqual({ engine: "apple" });
    expect(calls).toEqual(["set apple", "install"]);
    (t as unknown as { engine: string }).engine = "openai";
    await engine.start({ mode: "live", features: OFF });
    await expect(engine.transcription!.set("openai")).rejects.toMatchObject({ status: 409 });
    await end(engine, live);
  });
});

describe("label sets through the engine", () => {
  test("a set's export file name is safe on every file system", () => {
    expect(labelSetFileName('Sales: "calls" / Q4\u0001', "sales")).toBe("Sales calls Q4.tattle-labels");
    expect(labelSetFileName("  :/:  ", "sales")).toBe("sales.tattle-labels");
    expect(labelSetFileName("x".repeat(100), "id")).toBe(`${"x".repeat(80)}.tattle-labels`);
  });

  test("estimate takes any draft: not an object, an array, or no id", () => {
    const { engine } = offlineEngine();
    for (const body of [null, "x", [1, 2], { id: 5 }]) expect(engine.labelSetApi.estimate(body)).toMatchObject({ ok: false });
  });

  test("Create with AI: OpenRouter's refusals keep their status; other failures are a 400; the draft and skips pass through", async () => {
    const root = tmpDir("assist-");
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const body = { conversationId: "c1", messages: [{ role: "user", content: "A cooking show." }] };
    const withFetch = (f: typeof fetch) => new Engine({ sessionsDir: root, openrouterKey: "sk-or-v1-test-key-000000000000", fetch: f });
    await expect(withFetch(answer(401, { error: { message: "bad key" } })).labelSetApi.assist(body)).rejects.toMatchObject({ status: 401 });
    await expect(withFetch(answer(402, { error: { message: "no credit" } })).labelSetApi.assist(body)).rejects.toMatchObject({ status: 402 });
    const ok = withFetch((async () => new Response(JSON.stringify({ id: "g", choices: [{ message: { content: "{}" } }], usage: { cost: 0.1 } }))) as unknown as typeof fetch);
    // the host's draft (never built-in) and what they skipped reach the assistant
    expect(await ok.labelSetApi.assist({ ...body, draft: { name: "Cooking", builtIn: true }, skipped: ["markers", 3] })).toMatchObject({ skipped: ["markers"], spentUsd: 0.1 });
    // any other failure is a 400 with its message
    await expect(ok.labelSetApi.assist({ conversationId: "c1", messages: [{ role: "assistant", content: "Hi" }] })).rejects.toMatchObject({ status: 400, message: "the last message must be the host's" });
    // the session's fetch and keys serve too
    const seen: string[] = [];
    const viaSession = new Engine({
      sessionsDir: root,
      session: { keys: { openrouter: "sk-or-v1-session-key-00000000000" }, fetch: (async (_u: string, init: RequestInit) => { seen.push(String((init.headers as Record<string, string>).Authorization)); return new Response("{}", { status: 401 }); }) as unknown as typeof fetch },
    });
    await withEnv({ OPENROUTER_API_KEY: undefined }, async () => {
      await expect(viaSession.labelSetApi.assist(body)).rejects.toMatchObject({ status: 401 });
    });
    expect(seen[0]).toBe("Bearer sk-or-v1-session-key-00000000000");
    expect(readFileSync(join(root, "label-assist.jsonl"), "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(4);
    await expect(withFetch(answer(200, {})).labelSetApi.assist({ conversationId: "c1", messages: "hi" })).rejects.toMatchObject({ status: 400 });
    await expect(withFetch(answer(200, {})).labelSetApi.assist(undefined)).rejects.toMatchObject({ status: 400, message: "conversationId is required" });
    await expect(withFetch(answer(200, {})).labelSetApi.assist({ conversationId: "c1", messages: [{ role: "system", content: "x" }] })).rejects.toMatchObject({ status: 400 });
  });

  test("Create with AI and Try, with the key from the environment and the global fetch (refused offline)", async () => {
    const root = tmpDir("env-");
    const dir = makeSession(root, "20260924-100000", { startedAt: "2026-09-24T10:00:00Z", lines: [] });
    // a segment with a blank line, which the transcript leaves out: its speaker is shown by id
    writeFileSync(join(dir, "events.jsonl"), [
      ev("session.started", { sessionId: "20260924-100000", mode: "live", s1Version: "s1@1", labelSetVersion: "a" }),
      ev("speaker.created", { id: "spk_1", displayName: "Nic", stream: "host" }),
      ev("utterance", { id: "u_1", stream: "host", startMs: 0, endMs: 2000, speakerId: "spk_1", speakerName: "Nic", text: "Hello.", tags: [] }),
      ev("utterance", { id: "u_2", stream: "host", startMs: 2500, endMs: 3000, speakerId: "spk_1", speakerName: "Nic", text: "  ", tags: [] }),
      ev("segment.closed", { id: "seg_1", startMs: 0, endMs: 3000, forced: false, final: true, utteranceIds: ["u_1", "u_2"] }),
    ].join("\n") + "\n");
    const set = JSON.parse(readFileSync("config/labels/ai-podcast.json", "utf8"));
    // the global fetch, for this test only: OpenRouter refuses the key (not retried), and records which key was sent
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => { sent.push(String((init.headers as Record<string, string>).Authorization)); return new Response("{}", { status: 401 }); });
    try {
      await withEnv({ OPENROUTER_API_KEY: "sk-or-v1-from-env-000000000000" }, async () => {
        const engine = new Engine({ sessionsDir: root });
        await expect(engine.labelSetApi.assist({ conversationId: "c1", messages: [{ role: "user", content: "A show." }] })).rejects.toMatchObject({ status: 401 });
        expect(await engine.labelSetApi.tryOn({ set, sessionId: "20260924-100000" })).toMatchObject({ failed: 1 });
      });
      await withEnv({ OPENROUTER_API_KEY: undefined }, async () => {
        const keyed = new Engine({ sessionsDir: root, session: { keys: { openrouter: "sk-or-v1-session-000000000000" } } });
        expect(await keyed.labelSetApi.tryOn({ set, sessionId: "20260924-100000" })).toMatchObject({ failed: 1 });
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual(["Bearer sk-or-v1-from-env-000000000000", "Bearer sk-or-v1-from-env-000000000000", "Bearer sk-or-v1-session-000000000000"]);
  });

  test("Try on a recording: the default and capped minutes, and a missing session id", async () => {
    const root = tmpDir("try-");
    let asked = 0;
    const jev = (async (_u: string, init: RequestInit) => {
      asked++;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(JSON.parse(String(init.body)).questions)) {
        answers[id] = q.type === "noul" ? { type: "noul", noul: 0.9 } : q.type === "score" ? { type: "score", score: 2, confidence: 0.9, probabilities: {} }
          : { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.9, probabilities: {} };
      }
      return new Response(JSON.stringify({ answers, id: "gen-x", model: "typesafe/jev-1.13", provider: "TypeSafe", usage: { cost: 0.0001 } }));
    }) as unknown as typeof fetch;
    const { engine } = offlineEngine({ sessionsDir: root, openrouterKey: "sk-or-v1-test-key-000000000000", fetch: jev });
    const set = JSON.parse(readFileSync("config/labels/ai-podcast.json", "utf8"));
    await expect(engine.labelSetApi.tryOn({ set })).rejects.toMatchObject({ status: 400, message: "sessionId is required" });
    await expect(engine.labelSetApi.tryOn(undefined)).rejects.toMatchObject({ status: 400 });
    makeSession(root, "20260924-100000", { startedAt: "2026-09-24T10:00:00Z", lines: [["u_1", "Hello."]] });
    // one segment, starting at 0: in the window whatever the minutes (the default 10, or at most 30)
    for (const minutes of [undefined, -1, 90]) {
      expect(await engine.labelSetApi.tryOn({ set, sessionId: "20260924-100000", minutes })).toMatchObject({ segments: [{ id: "seg_1" }], failed: 0, window: { startMs: 0 } });
    }
    expect(asked).toBe(3);
  });
});

describe("module helpers", () => {
  test("replay sources: only the streams whose WAV exists", () => {
    const dir = tmpDir("replay-");
    wavFile(dir, silence(512), "remote.wav");
    expect(replaySources(dir, "max").map((s) => s.stream)).toEqual(["remote"]);
    wavFile(dir, silence(512), "host.wav");
    expect(replaySources(dir, 1).map((s) => s.stream)).toEqual(["host", "remote"]);
  });

  test("about: no LICENSE file gives an empty text; no license field gives null", () => {
    const root = tmpDir("root-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "9.9.9" }));
    expect(about(root)).toEqual({ name: "x", version: "9.9.9", license: { id: null, holder: null, text: "" } });
  });

  test("engine staleness: only .ts files count, and an unreadable folder is not stale", () => {
    const src = tmpDir("src-");
    writeFileSync(join(src, "notes.md"), "x");
    expect(engineStale(src, Date.now() - 60_000)).toBe(false);
    expect(engineStale(join(src, "missing"), 0)).toBe(false);
    expect(engineStale(null, 0)).toBe(false);
  });
});

describe("bootEngine, in an isolated home", () => {
  test("keys, config, the engine setting, and the server, with native capture that is not built here", async () => {
    const home = tmpDir("home-");
    setAppPaths({ sessions: join(home, "sessions"), helper: join(home, "no-helper"), transcriber: join(home, "no-transcriber"), src: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await withEnv({
      HOME: home, TATTLE_CREDENTIALS: join(home, "credentials.json"), TATTLE_SETTINGS: join(home, "settings.json"),
      TATTLE_FORCE_NO_APPLE_SPEECH: "1", OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
    }, async () => {
      const { engine, keys, transcription, ready, server } = bootEngine();
      await ready;
      expect(transcription.engine).toBe("openai");
      expect(keys.missing()).toEqual(["openai", "openrouter"]);
      expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ transcriptionEngine: "openai" });
      const { base, close } = await listen(server);
      try {
        expect((await http(base, "GET", "/api/setup")).json).toMatchObject({ configured: false, required: ["openai"] });
        expect((await http(base, "GET", "/api/state")).status).toBe(503);
      } finally {
        await close();
      }
      await expect(engine.devices()).rejects.toThrow(/capture helper is not built/);
      // the engine setting's changes reach the page as transient events
      const seen: string[] = [];
      engine.bus.subscribe((e) => seen.push(e.type));
      process.env.OPENAI_API_KEY = "sk-proj-boot-test-000000000000";
      await engine.transcription!.set("openai");
      expect(seen).toContain("transcription.status");
      expect(engine.bus.history().some((e) => e.type === "transcription.status")).toBe(false);
      // live capture goes through the helper, which is not built: the start fails, whichever mic
      await expect(engine.start({ mode: "live", mic: "builtin", features: OFF, labelSet: null })).rejects.toThrow(/capture helper is not built/);
      await expect(engine.start({ mode: "live", mic: "usb-mic", features: OFF, labelSet: null })).rejects.toThrow(/capture helper is not built/);
      expect(existsSync(join(home, "Library"))).toBe(false); // nothing to migrate, nothing created
    });
    log.mockRestore();
  });

  test("a key saved from the setup page is checked with the global fetch (offline here: saved, with a warning)", async () => {
    const home = tmpDir("home-");
    setAppPaths({ sessions: join(home, "sessions"), helper: join(home, "no-helper"), transcriber: join(home, "no-transcriber"), src: null });
    await withEnv({
      HOME: home, TATTLE_CREDENTIALS: join(home, "credentials.json"), TATTLE_SETTINGS: join(home, "settings.json"),
      TATTLE_FORCE_NO_APPLE_SPEECH: "1", OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
    }, async () => {
      const { server, ready } = bootEngine();
      await ready;
      const { base, close } = await listen(server);
      try {
        const r = await http(base, "POST", "/api/setup/keys", { body: { openai: "sk-proj-offline-check-000000000000" } });
        expect(r.json).toMatchObject({ saved: true, configured: true, checks: { openai: { ok: true, warning: expect.any(String) } } });
        expect(JSON.parse(readFileSync(join(home, "credentials.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "sk-proj-offline-check-000000000000" });
      } finally {
        await close();
      }
    });
  });

  test("an engine setting that cannot be saved is reported, and the engine still boots", async () => {
    const home = tmpDir("home-");
    writeFileSync(join(home, "a-file"), "");
    setAppPaths({ sessions: join(home, "sessions"), helper: join(home, "no-helper"), transcriber: join(home, "no-transcriber"), src: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await withEnv({
      HOME: home, TATTLE_CREDENTIALS: join(home, "credentials.json"), TATTLE_SETTINGS: join(home, "a-file", "settings.json"),
      TATTLE_FORCE_NO_APPLE_SPEECH: "1", OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
    }, async () => {
      const { ready, transcription } = bootEngine();
      await ready;
      expect(log).toHaveBeenCalledWith("transcription setting:", expect.anything());
      expect(transcription.engine).toBe("openai");
    });
    log.mockRestore();
  });
});
