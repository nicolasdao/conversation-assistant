// Session (src/pipeline/session.ts), branch by branch, on fakes: scripted services, a fake embedder, short synthetic or
// fixture-slice sources, and a strict bus. The whole-fixture runs stay in session.test.ts, retry.test.ts, echoGate.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { readWav16k } from "../src/audio/wav.ts";
import type { Utterance } from "../src/audio/vad.ts";
import type { TranscriptionContext, TranscriptionResult } from "../src/transcribe/openai.ts";
import type { JevResponse } from "../src/jev/types.ts";
import { requireAssets } from "./helpers.ts";
import {
  cleanTmpDirs, constant, deferred, fixtureSlice, FakeSocket, silence, snapshotKeyEnv, tmpDir,
} from "./fakes/index.ts";
import { SamplesSource, FakeAppleHelper, makeSession, PushSource, scriptedServices } from "./fakes/session.ts";

beforeAll(() => requireAssets());
afterEach(() => {
  vi.useRealTimers();
  cleanTmpDirs();
});

const utt = (id: string, stream: "host" | "remote", startMs: number, seconds = 2, amp = 0.1): Utterance =>
  ({ id, stream, startMs, endMs: startMs + seconds * 1000, samples: constant(amp, Math.round(seconds * 16_000)) });

/** Waits until every transcription started so far has settled. */
async function settled(s: object) {
  const set = (s as any).transcriptions as Set<Promise<void>>;
  while (set.size > 0) await Promise.all([...set]);
}

/** Lets the session take what was pushed (a few event-loop turns). */
async function until(cond: () => boolean, turns = 2000) {
  for (let i = 0; i < turns && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}

const jevAnswer = (answers: JevResponse["answers"]): JevResponse => ({ answers, id: null, model: "jev", provider: null, usage: { input_tokens: 0, output_tokens: 0, cost: 0 } });

function withEchoMode(mode: "auto" | "always" | "never"): Config {
  const c = loadConfig();
  c.app.echoGate = { ...c.app.echoGate, mode };
  return c;
}

describe("Session construction", () => {
  it("throws 'at least one audio source is required' for sources: []", () => {
    expect(() => makeSession({ sources: [] })).toThrow("at least one audio source is required");
  });

  it("features: both on unless set to false; labels are off without a label set", () => {
    expect(makeSession({ features: undefined }).s.features).toEqual({ factcheck: true, labels: true });
    expect(makeSession({ features: { factcheck: false } }).s.features).toEqual({ factcheck: false, labels: true });
    expect(makeSession({ features: { labels: false } }).s.features).toEqual({ factcheck: true, labels: false });
    expect(makeSession({ features: {}, labelSet: null }).s.features).toEqual({ factcheck: true, labels: false });
  });

  it("the label set is the config's default when absent, and the given one otherwise", () => {
    const config = loadConfig();
    const a = makeSession({ features: {} }, config).s;
    expect(a.timeline.set?.id).toBe(config.labels.id);
    const b = makeSession({ features: {}, labelSet: { ...structuredClone(config.labels), id: "mine", name: "Mine", builtIn: false } }, config).s;
    expect(b.timeline.set?.id).toBe("mine");
  });

  it("voices merge speakers.voicesPerStream with the session's own", () => {
    expect(makeSession().s.voices).toEqual({ host: 1, remote: 2 });
    expect(makeSession({ voices: { remote: 4 } }).s.voices).toEqual({ host: 1, remote: 4 });
  });

  it("the engine is OpenAI unless given; transcription names its model or its locale", async () => {
    const { s } = makeSession();
    expect(s.mode).toBe("replay");
    expect(makeSession({ mode: "live" }).s.mode).toBe("live");
    expect(s.engine).toBe("openai");
    expect(s.transcription).toEqual({ engine: "openai", model: "gpt-transcribe" });
    const helpers: FakeAppleHelper[] = [];
    const apple = makeSession({ engine: "apple", appleSpawn: (_b, a) => { const h = new FakeAppleHelper(a); helpers.push(h); return h; } }).s;
    expect(apple.transcription).toEqual({ engine: "apple", locale: "en-US" });
    // Apple needs every frame even without live text, so its helper starts with the session, without --live
    expect(helpers).toHaveLength(1);
    expect(helpers[0].args).not.toContain("--live");
    await (apple as any).live.close();
  });

  it("live text on OpenAI warms one socket per stream, with keys.openai, else OPENAI_API_KEY", async () => {
    const restore = snapshotKeyEnv();
    try {
      const sockets: FakeSocket[] = [];
      const liveConnect = (u: string, h: Record<string, string>) => { const w = new FakeSocket(u, h); sockets.push(w); return w; };
      const both = [new SamplesSource("host", silence(0)), new SamplesSource("remote", silence(0))];
      makeSession({ liveText: true, liveConnect, keys: { openai: "sk-from-keys" }, sources: both });
      expect(sockets).toHaveLength(2);
      expect(sockets[0].headers.Authorization).toBe("Bearer sk-from-keys");
      process.env.OPENAI_API_KEY = "sk-from-env";
      makeSession({ liveText: true, liveConnect });
      expect(sockets[2].headers.Authorization).toBe("Bearer sk-from-env");
      delete process.env.OPENAI_API_KEY;
      makeSession({ liveText: true, liveConnect });
      expect(sockets[3].headers.Authorization).toBe("Bearer ");
    } finally {
      restore();
    }
  });

  it("OpenAI live text reaches the page as transient partials; its errors and its bill reach the session", async () => {
    const sockets: FakeSocket[] = [];
    const { s, bus, of } = makeSession({ liveText: true, liveConnect: (u, h) => { const w = new FakeSocket(u, h); sockets.push(w); return w; } });
    const partials: any[] = [];
    bus.subscribe((e) => { if (e.type === "utterance.partial") partials.push(e.data); });
    sockets[0].server({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_1", delta: "Hello" });
    expect(partials).toEqual([{ stream: "host", itemId: "item_1", text: "Hello", utteranceId: null, final: false }]);
    expect(bus.history().some((e) => e.type === "utterance.partial")).toBe(false);
    sockets[0].server({ type: "error", error: { code: "server_error", message: "overloaded" } });
    expect(of("error")).toEqual([{ component: "live-transcription", message: "live transcription: overloaded" }]);
    sockets[0].server({ type: "session.updated" });
    (s as any).live.feed("host", constant(0.3, 16_000), true);
    await (s as any).live.close(); // bills what was sent
    const rows = readFileSync(join(s.store.dir, "transcriptions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ kind: "live_transcription", audio_seconds: expect.any(Number) });
  });

  it("Apple live text reaches the page as transient partials, and the helper's errors as transcription errors", async () => {
    const helpers: FakeAppleHelper[] = [];
    const { s, bus, of } = makeSession({ engine: "apple", liveText: true, appleSpawn: (_b, a) => { const h = new FakeAppleHelper(a); helpers.push(h); return h; } });
    expect(helpers[0].args).toContain("--live");
    const partials: any[] = [];
    bus.subscribe((e) => { if (e.type === "utterance.partial") partials.push(e.data); });
    helpers[0].line({ type: "volatile", stream: "host", runs: [{ text: "Hello there", startMs: 0, endMs: 900 }] });
    helpers[0].line({ type: "error", message: "the analyzer stopped", fatal: false });
    await until(() => of("error").length === 1);
    expect(partials).toEqual([{ stream: "host", itemId: "apple-host-0", text: "Hello there", utteranceId: null, final: false }]);
    expect(of("error")).toEqual([{ component: "transcription", message: "tattle-transcribe: the analyzer stopped" }]);
    await (s as any).live.close();
  });

  it("no live text without liveText, or with transcription.live.enabled false", () => {
    const sockets: FakeSocket[] = [];
    const liveConnect = (u: string, h: Record<string, string>) => { const w = new FakeSocket(u, h); sockets.push(w); return w; };
    makeSession({ liveConnect });
    const config = loadConfig();
    config.app.transcription.live = { ...config.app.transcription.live!, enabled: false };
    makeSession({ liveText: true, liveConnect }, config);
    expect(sockets).toHaveLength(0);
  });

  it.fails("BUG P4-L3: a session that is constructed but never run opens no live-text socket", () => {
    const sockets: FakeSocket[] = [];
    makeSession({ liveText: true, liveConnect: (u, h) => { const w = new FakeSocket(u, h); sockets.push(w); return w; } });
    expect(sockets).toHaveLength(0); // warm() runs in the constructor today
  });

  it("real services: OpenAI transcription through the given fetch, with keys.openai or else OPENAI_API_KEY", async () => {
    const restore = snapshotKeyEnv();
    try {
      const auth: string[] = [];
      const fetch = (async (_u: string, init: RequestInit) => {
        auth.push((init.headers as Record<string, string>).Authorization);
        return new Response(JSON.stringify({ text: "hello there friend" }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const a = makeSession({ services: undefined, fetch, keys: { openai: "sk-a" } }).s;
      expect(await (a as any).services.transcribe("u_1", constant(0.1, 16_000))).toMatchObject({ ok: true, text: "hello there friend" });
      process.env.OPENAI_API_KEY = "sk-env";
      process.env.OPENROUTER_API_KEY = "sk-or-env";
      const b = makeSession({ services: undefined, fetch }).s;
      await (b as any).services.transcribe("u_1", constant(0.1, 16_000));
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      const c = makeSession({ services: undefined, fetch }).s;
      await (c as any).services.transcribe("u_1", constant(0.1, 16_000));
      expect(auth).toEqual(["Bearer sk-a", "Bearer sk-env", "Bearer "]);
    } finally {
      restore();
    }
  });

  it("real services: Jev and System 2 go through the given fetch with the OpenRouter key, and stream as calls", async () => {
    const urls: string[] = [];
    const fetch = (async (u: string, init: RequestInit) => {
      urls.push(`${u} ${(init.headers as Record<string, string>).Authorization}`);
      return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.5 } }, id: "g", model: "jev", provider: "x", usage: { cost: 0, input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { s, bus } = makeSession({ services: undefined, fetch, keys: { openrouter: "sk-or" } });
    const live: string[] = [];
    bus.subscribe((e) => live.push(e.type));
    const r = await (s as any).services.ask({ a: 1 }, { q: { type: "noul", instruction: "Is it?", criteria: { true: "yes", false: "no" } } }, { purpose: "utterance", utterance_id: "u_1" });
    expect(r.answers.q).toMatchObject({ noul: 0.5 });
    expect(urls[0]).toMatch(/alpha\/decisions Bearer sk-or$/);
    expect(live).toContain("call.started");
    expect(live).toContain("call");
    expect(bus.history().some((e) => e.type === "call" || e.type === "call.started")).toBe(false);
    expect((s as any).services.s2).toBeDefined();
  });

  it("real services on Apple: a line's clip goes to the helper, cut from the stream around its span", async () => {
    const helpers: FakeAppleHelper[] = [];
    const { s } = makeSession({
      services: undefined, engine: "apple", appleSpawn: (_b, a) => { const h = new FakeAppleHelper(a); helpers.push(h); return h; },
    });
    const live = (s as any).live;
    live.feed("host", constant(0.2, 32_000), true, 0);
    const p = (s as any).services.transcribe("u_1", constant(0.2, 16_000), { prompt: "ignored" }, { stream: "host", startMs: 500, endMs: 1500 });
    helpers[0].line({ type: "ready" });
    await until(() => helpers[0].received.length > 0);
    helpers[0].line({ type: "clip", id: "u_1", text: "from the Mac" });
    expect(await p).toEqual({ ok: true, text: "from the Mac", filler: false });
    await live.close();
  });
});

describe("Session run lifecycle", () => {
  it("run() twice returns the same promise and runs once", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(2048))] });
    const a = s.run();
    expect(s.run()).toBe(a);
    await a;
    expect(of("session.started")).toHaveLength(1);
    expect(of("session.ended")).toHaveLength(1);
  });

  it("session.json records the session, its config, voices, features, engine, label set and System 1", async () => {
    const config = loadConfig();
    const { s, invalid } = makeSession({ sources: [new SamplesSource("host", silence(512))], features: { factcheck: false }, stories: ["A story", "  "] }, config);
    await s.run();
    const j = JSON.parse(readFileSync(join(s.store.dir, "session.json"), "utf8"));
    expect(j).toMatchObject({
      id: s.id, mode: "replay", streams: ["host"], voices: { host: 1, remote: 2 }, features: { factcheck: false, labels: true },
      transcription: { engine: "openai", model: "gpt-transcribe" }, stories: ["A story"], s1Version: expect.any(String),
    });
    expect(j.app.name).toBeTruthy();
    expect(j.config.vad).toEqual(config.app.vad);
    expect(j.labelSet.id).toBe(config.labels.id);
    expect(j.labelSetVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(j.s1).toEqual(JSON.parse(JSON.stringify(config.s1)));
    expect(new Date(j.startedAt).toISOString()).toBe(j.startedAt);
    expect(invalid).toEqual([]);
  });

  it("emits echo.gate at the start when the gate is always on", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(512))] }, withEchoMode("always"));
    await s.run();
    expect(of("echo.gate")).toEqual([{ active: true, device: null, atMs: 0 }]);
    const off = makeSession({ sources: [new SamplesSource("host", silence(512))] });
    await off.s.run();
    expect(off.of("echo.gate")).toEqual([]);
  });

  it("a source that throws ends the session with reason 'error' and an error event from the session", async () => {
    const { s, of, invalid } = makeSession({ sources: [new SamplesSource("host", silence(512 * 10), { throwAfter: 3 })] });
    await s.run();
    expect(of("error")).toEqual([{ component: "session", message: "the source broke" }]);
    expect(of("session.ended")[0].reason).toBe("error");
    expect(invalid).toEqual([]);
  });

  it("a non-Error thrown by a source is reported as its string", async () => {
    const src = { stream: "host" as const, async *frames() { yield { samples: silence(), sessionMs: 0 }; throw "plain failure"; } };
    const { s, of } = makeSession({ sources: [src] });
    await s.run();
    expect(of("error")).toEqual([{ component: "session", message: "plain failure" }]);
  });

  it("stop() mid-run ends with reason 'stopped', and a transcription in flight still completes first", async () => {
    const src = new PushSource("host");
    const d = deferred<TranscriptionResult>();
    const { s, events } = makeSession({ sources: [src], services: scriptedServices(() => d.promise) });
    const done = s.run();
    src.push(silence(512 * 3));
    await until(() => src.taken === 3);
    (s as any).onUtterance(utt("u_1", "host", 0));
    const stopped = s.stop();
    src.push(); // the loop only sees the stop on its next frame
    await until(() => s.status === "ending");
    expect(s.status).toBe("ending");
    d.resolve({ ok: true, text: "the last words", filler: false });
    await stopped;
    await done;
    const types = events().map((e) => e.type);
    expect(types.indexOf("utterance")).toBeLessThan(types.indexOf("session.ended"));
    expect(events().at(-1)).toMatchObject({ type: "session.ended", data: { reason: "stopped" } });
    expect(src.taken).toBe(4);
  });

  it("stop() before any frame stops on the first frame, which is never recorded", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", constant(0.3, 512 * 4))] });
    await s.stop();
    expect(of("session.ended")[0].reason).toBe("stopped");
    expect(readWav16k(join(s.store.dir, "host.wav"))).toHaveLength(0);
  });

  it.fails("BUG P4-L4: stop() ends a session whose source never yields a frame", async () => {
    const src = new PushSource("host");
    const { s } = makeSession({ sources: [src] });
    void s.run();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("stop() still waiting after 300 ms")), 300));
    try {
      await Promise.race([s.stop(), timeout]);
    } finally {
      src.end(); // lets the session end, so nothing is left running
      await s.run();
    }
  });

  it("stopped mid-speech, the VAD is flushed and the line being said is still transcribed", async () => {
    const src = new PushSource("host");
    const { s, of } = makeSession({ sources: [src] });
    const done = s.run();
    const speech = fixtureSlice("host", 0, 4000); // line 1 runs 1.0–7.65 s: cut mid-sentence
    src.push(speech);
    const frames = Math.ceil(speech.length / 512);
    await until(() => src.taken === frames);
    expect((s as any).vads.get("host").isDetected()).toBe(true);
    const stopped = s.stop();
    src.push();
    await stopped;
    await done;
    const [u] = of("utterance");
    expect(u).toMatchObject({ stream: "host", text: "words said here" });
    expect(u.endMs).toBeLessThanOrEqual(4100);
    expect(of("session.ended")[0].reason).toBe("stopped");
  });

  it("session.ended is the last event, the store is closed, and transient events never reach the files", async () => {
    const { s, events } = makeSession({ sources: [new SamplesSource("host", silence(512))] });
    await s.run();
    s.emit("utterance.partial", { stream: "host", itemId: "i", text: "hi", utteranceId: null, final: false });
    s.emit("call.started", { system: "s1", purpose: "utterance" });
    const rows = readFileSync(join(s.store.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.at(-1).type).toBe("session.ended");
    expect(events().at(-1)?.type).toBe("session.ended");
    expect(rows.some((r) => r.type === "utterance.partial" || r.type === "call.started")).toBe(false);
    // closed: a plain append is dropped, a command after the end is still recorded
    s.store.append("utterances", { late: true });
    expect(readFileSync(join(s.store.dir, "utterances.jsonl"), "utf8")).toBe("");
    s.emit("speaker.updated", { id: "spk_1", displayName: "Nic" });
    expect(readFileSync(join(s.store.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).type).at(-1)).toBe("speaker.updated");
  });
});

describe("Session frames", () => {
  it("paused frames are recorded as silence and resume brings the audio back; pause and resume only while running", async () => {
    const src = new PushSource("host");
    const { s, of } = makeSession({ sources: [src] });
    const done = s.run();
    src.push(constant(0.5, 512 * 5));
    await until(() => src.taken === 5);
    expect(s.resume()).toBe(false); // not paused
    expect(s.pause()).toBe(true);
    expect(s.pause()).toBe(false);
    src.push(constant(0.5, 512 * 5));
    await until(() => src.taken === 10);
    expect(s.resume()).toBe(true);
    src.push(constant(0.5, 512 * 5));
    src.end();
    await done;
    expect(of("session.paused")).toEqual([{ sessionId: s.id, atMs: 128 }]);
    expect(of("session.resumed")).toEqual([{ sessionId: s.id, atMs: 288 }]);
    const rec = readWav16k(join(s.store.dir, "host.wav"));
    expect(rec).toHaveLength(512 * 15);
    expect(rec.subarray(0, 2560).every((v) => v > 0.4)).toBe(true);
    expect(rec.subarray(2560, 5120).every((v) => v === 0)).toBe(true);
    expect(rec.subarray(5120).every((v) => v > 0.4)).toBe(true);
    expect(s.pause()).toBe(false); // ended
    expect(s.resume()).toBe(false);
  });

  it("with the gate on, host frames are muted while the call plays; remote frames are recorded as they are", async () => {
    const host = new PushSource("host");
    const remote = new PushSource("remote");
    // remote first: at equal times the merge takes the sources in order, so the gate hears the call before the mic
    const { s } = makeSession({ sources: [remote, host] }, withEchoMode("always"));
    const done = s.run();
    for (let i = 0; i < 5; i++) { remote.push(constant(0.5)); host.push(constant(0.3)); }
    host.end();
    remote.end();
    await done;
    expect(readWav16k(join(s.store.dir, "remote.wav")).every((v) => v > 0.4)).toBe(true);
    expect(readWav16k(join(s.store.dir, "host.wav")).every((v) => v === 0)).toBe(true);
  });

  it("with the gate off (auto, no output reported), host frames are recorded as they are", async () => {
    const host = new PushSource("host");
    const remote = new PushSource("remote");
    const { s } = makeSession({ sources: [host, remote] });
    const done = s.run();
    for (let i = 0; i < 5; i++) { remote.push(constant(0.5)); host.push(constant(0.3)); }
    host.end();
    remote.end();
    await done;
    expect(readWav16k(join(s.store.dir, "host.wav")).every((v) => v > 0.25)).toBe(true);
  });

  it("every frame goes to live text with the VAD's speech flag and its time", async () => {
    const src = new SamplesSource("host", silence(512 * 3), { startMs: 1000 });
    const { s } = makeSession({ sources: [src], liveText: true, liveConnect: (u, h) => new FakeSocket(u, h) });
    const feed = vi.spyOn((s as any).live, "feed");
    await s.run();
    expect(feed.mock.calls.map((c) => [c[0], c[2], c[3]])).toEqual([["host", false, 1000], ["host", false, 1032], ["host", false, 1064]]);
  });

  it("yields to the event loop every 64 frames", async () => {
    const { s } = makeSession({ sources: [new SamplesSource("host", silence(512 * 130))] });
    const spy = vi.spyOn(globalThis, "setImmediate");
    try {
      await s.run();
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Session lines (onUtterance)", () => {
  const both = () => [new SamplesSource("host", silence(0)), new SamplesSource("remote", silence(0))];

  it("a new voice emits speaker.created with its stream; utterances.jsonl rounds times and tags a loud line", async () => {
    const { s, of, invalid } = makeSession({ sources: both() });
    (s as any).onUtterance({ ...utt("u_1", "remote", 1000.4, 2, 0.05), endMs: 3000.6 });
    (s as any).onUtterance(utt("u_2", "remote", 4000, 2, 0.5)); // 20 dB over the stream's median
    await settled(s);
    expect(of("speaker.created")[0]).toMatchObject({ id: expect.stringMatching(/^spk_/), displayName: expect.stringMatching(/^Speaker /), stream: "remote" });
    const rows = readFileSync(join(s.store.dir, "utterances.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ id: "u_1", stream: "remote", start_ms: 1000, end_ms: 3001, speaker_inferred: false, tags: [] });
    expect(rows[1]).toMatchObject({ id: "u_2", tags: ["loud"] });
    expect(of("utterance")[1].tags).toEqual(["loud"]);
    expect(invalid).toEqual([]);
  });

  it("a line transcribed to nothing (ok, empty) emits neither an utterance nor a failure", async () => {
    const { s, of } = makeSession({ sources: both(), services: scriptedServices(async () => ({ ok: true, text: "", filler: false })) });
    (s as any).onUtterance(utt("u_1", "host", 0));
    await settled(s);
    expect(of("utterance")).toEqual([]);
    expect(of("utterance.failed")).toEqual([]);
    expect(s.transcriptLines()).toEqual([]);
  });

  it("a filler is an utterance marked filler, left out of the chat's transcript", async () => {
    const texts = ["yeah", "a real sentence here"];
    const { s, of } = makeSession({ sources: both(), services: scriptedServices(async () => { const t = texts.shift()!; return { ok: true, text: t, filler: t === "yeah" }; }) });
    (s as any).onUtterance(utt("u_1", "host", 0));
    (s as any).onUtterance(utt("u_2", "host", 3000));
    await settled(s);
    expect(of("utterance").map((u) => [u.text, u.filler])).toEqual([["yeah", true], ["a real sentence here", false]]);
    expect(s.transcriptLines().map((l) => l.text)).toEqual(["a real sentence here"]);
  });

  it("a rejected transcription (a budget refusal) is an error and a failed line, not kept for a retry", async () => {
    const { s, of } = makeSession({ sources: both(), services: scriptedServices(async () => { throw new Error("budget exhausted"); }) });
    (s as any).onUtterance(utt("u_1", "host", 0));
    await settled(s);
    expect(of("error")).toEqual([{ component: "transcription", message: "budget exhausted", utterance_id: "u_1" }]);
    expect(of("utterance.failed")).toEqual([{ id: "u_1", stream: "host", startMs: 0, endMs: 2000, speakerId: expect.any(String), status: "failed" }]);
    expect((s as any).pending.size).toBe(0);
  });

  it("a non-Error rejection is reported as its string", async () => {
    const { s, of } = makeSession({ sources: both(), services: scriptedServices(() => Promise.reject("offline")) });
    (s as any).onUtterance(utt("u_1", "host", 0));
    await settled(s);
    expect(of("error")[0].message).toBe("offline");
  });

  it("the utterance carries the resolved speaker and their current name", async () => {
    const d = deferred<TranscriptionResult>();
    const calls: string[] = [];
    const { s, of } = makeSession({ sources: both(), services: scriptedServices(async (id) => { calls.push(id); return id === "u_2" ? d.promise : { ok: true, text: "first line said", filler: false }; }) });
    (s as any).onUtterance(utt("u_1", "host", 0, 2, 0.1));
    await settled(s);
    (s as any).onUtterance(utt("u_2", "remote", 3000, 2, 0.3));
    const [host, remote] = of("speaker.created").map((x) => x.id);
    s.mergeSpeakers(remote, host);
    s.renameSpeaker(host, "Nic");
    d.resolve({ ok: true, text: "second line said", filler: false });
    await settled(s);
    expect(of("utterance")[1]).toMatchObject({ id: "u_2", speakerId: host, speakerName: "Nic" });
  });

  it("each line commits live text for its stream, with its end", async () => {
    const { s } = makeSession({ sources: both(), liveText: true, liveConnect: (u, h) => new FakeSocket(u, h) });
    const commit = vi.spyOn((s as any).live, "commit");
    (s as any).onUtterance(utt("u_1", "remote", 1000));
    await settled(s);
    expect(commit).toHaveBeenCalledWith("remote", "u_1", 3000);
  });

  it.fails("BUG P4-L2: a transcriber that throws synchronously fails its line; the session carries on", async () => {
    const services = scriptedServices(() => { throw new Error("not async"); });
    const { s, of } = makeSession({ sources: [new SamplesSource("host", fixtureSlice("host", 0, 9000))], services });
    await s.run();
    expect(of("session.ended")[0].reason).toBe("end_of_input"); // today: "error", the whole session stops
    expect(of("utterance.failed")).toHaveLength(1);
  });

  it.fails("BUG P4-L1: a line whose handling throws after its transcript still lets the session end cleanly", async () => {
    // The throw makes the promise the session tracks reject; the `finally` it chains is then an unhandled rejection
    // (which would fail the whole run), so this test marks those as handled while it runs.
    const original = Promise.prototype.finally;
    Promise.prototype.finally = function (this: Promise<unknown>, f?: (() => void) | null) {
      const r = original.call(this, f);
      r.catch(() => {});
      return r;
    } as typeof original;
    try {
      const d = deferred<TranscriptionResult>();
      const src = new PushSource("host");
      const { s, of } = makeSession({ sources: [src], services: scriptedServices(() => d.promise) });
      vi.spyOn(s.segmenter, "transcribed").mockImplementation(() => { throw new Error("disk full"); });
      const done = s.run();
      (s as any).onUtterance(utt("u_1", "host", 0));
      src.end();
      await until(() => s.status === "ending");
      d.resolve({ ok: true, text: "words", filler: false });
      try {
        await done; // today: rejects with "disk full", and session.ended is never emitted
      } finally {
        for (const t of (s as any).timers) clearInterval(t); // the session never finished: stop its timers
      }
      expect(of("session.ended")).toHaveLength(1);
    } finally {
      Promise.prototype.finally = original;
    }
  });
});

describe("Session transcription context", () => {
  it("prompt = config prompt + renamed names + stories + the last lines said; keywords = renamed names only", async () => {
    const config = loadConfig();
    const contexts: TranscriptionContext[] = [];
    const texts = ["line one", "line two", "", "line four", "line five", "line six", "line seven", "line eight"];
    let i = 0;
    const { s, of } = makeSession({
      sources: [new SamplesSource("host", silence(0)), new SamplesSource("remote", silence(0))], stories: ["Jev's launch", "Bondi"],
      features: { factcheck: false },
      services: scriptedServices(async (_id, _s, ctx) => { contexts.push(ctx!); return { ok: true, text: texts[i++] ?? "more", filler: false }; }),
    }, config);
    (s as any).onUtterance(utt("u_1", "host", 0, 2, 0.1));
    await settled(s);
    expect(contexts[0]).toEqual({ prompt: `${config.app.transcription.prompt}\nTopics tonight: Jev's launch; Bondi.`, keywords: [] });
    const host = of("speaker.created")[0].id;
    s.renameSpeaker(host, "Nic");
    (s as any).onUtterance(utt("u_2", "remote", 3000, 2, 0.3)); // a second, unnamed voice: not a keyword
    await settled(s);
    for (let k = 3; k <= 9; k++) {
      (s as any).onUtterance(utt(`u_${k}`, "host", k * 3000, 2, 0.1));
      await settled(s);
    }
    const last = contexts.at(-1)!;
    expect(last.keywords).toEqual(["Nic"]);
    expect(last.prompt).toContain("The speakers are Nic.");
    // the empty third line was dropped; of the 7 others said before this one, the last 6, oldest first
    expect(last.prompt!.split("The conversation so far:\n")[1].split("\n")).toEqual([
      "Speaker 2: line two", "Nic: line four", "Nic: line five", "Nic: line six", "Nic: line seven", "Nic: line eight",
    ]);
  });

  it("the recent lines stop before 600 characters, keeping the newest", async () => {
    const texts = ["a".repeat(290), "b".repeat(290), "c".repeat(290), "d"];
    const contexts: TranscriptionContext[] = [];
    const { s } = makeSession({
      sources: [new SamplesSource("host", silence(0))],
      services: scriptedServices(async (_id, _s, ctx) => { contexts.push(ctx!); return { ok: true, text: texts.shift() ?? "e", filler: false }; }),
    });
    for (let k = 1; k <= 4; k++) {
      (s as any).onUtterance(utt(`u_${k}`, "host", k * 3000));
      await settled(s);
    }
    // "Speaker 1: ccc…" (301) and "Speaker 1: bbb…" (301) would be 603 with the newline: only the newest fits
    expect(contexts[3].prompt!.split("The conversation so far:\n")[1]).toBe(`Speaker 1: ${"c".repeat(290)}`);
  });

  it("without a config prompt, names, stories or lines, the prompt is empty", async () => {
    const config = loadConfig();
    config.app.transcription.prompt = "";
    const contexts: TranscriptionContext[] = [];
    const { s } = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(async (_i, _s, c) => { contexts.push(c!); return { ok: true, text: "", filler: false }; }) }, config);
    (s as any).onUtterance(utt("u_1", "host", 0));
    await settled(s);
    expect(contexts[0]).toEqual({ prompt: "", keywords: [] });
  });
});

describe("Session retries", () => {
  const down = { ok: false as const, error: "fetch failed", retryable: true };

  it("keeps at most 200 lines for a retry: the oldest is given up and marked failed", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(0))] });
    for (let k = 1; k <= 201; k++) (s as any).keepForRetry({ u: utt(`u_${k}`, "host", k * 10, 0.5), speakerId: "spk_1", inferred: false, tags: [], context: { prompt: "" } });
    expect((s as any).pending.size).toBe(200);
    expect(of("utterance.failed")).toEqual([{ id: "u_1", stream: "host", startMs: 10, endMs: 510, speakerId: "spk_1", status: "failed" }]);
  });

  it("one retry pass at a time: a second call shares the pass in progress", async () => {
    const d = deferred<TranscriptionResult>();
    let calls = 0;
    const { s } = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(() => { calls++; return d.promise; }) });
    (s as any).keepForRetry({ u: utt("u_1", "host", 0), speakerId: "spk_1", inferred: false, tags: [], context: { prompt: "" } });
    const a = (s as any).retryPending();
    const b = (s as any).retryPending();
    expect(b).toBe(a);
    d.resolve({ ok: true, text: "back again", filler: false });
    await a;
    expect(calls).toBe(1);
    expect(await (s as any).retryPending()).toBeUndefined(); // nothing pending: resolves at once
  });

  it("a retry that comes back empty is marked 'empty'; a non-transient failure is given up and the pass goes on", async () => {
    const answers: TranscriptionResult[] = [{ ok: true, text: "", filler: false }, { ok: false, error: "bad request", retryable: false }, { ok: true, text: "recovered line", filler: false }];
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(async () => answers.shift()!) });
    for (const k of [1, 2, 3]) (s as any).keepForRetry({ u: utt(`u_${k}`, "host", k * 3000), speakerId: "spk_1", inferred: false, tags: ["loud"], context: { prompt: "" } });
    await (s as any).retryPending();
    expect(of("utterance.failed").map((f) => [f.id, f.status])).toEqual([["u_1", "empty"], ["u_2", "failed"]]);
    expect(of("utterance")).toEqual([expect.objectContaining({ id: "u_3", text: "recovered line", recovered: true, tags: ["loud"] })]);
    expect((s as any).pending.size).toBe(0);
  });

  it("a recovered line takes its place in time order among the lines already said", async () => {
    const answers: TranscriptionResult[] = [{ ok: true, text: "first said", filler: false }, { ok: true, text: "said later", filler: false }, { ok: true, text: "said between", filler: false }];
    const { s } = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(async () => answers.shift()!) });
    (s as any).onUtterance(utt("u_1", "host", 0));
    (s as any).onUtterance(utt("u_3", "host", 9000));
    await settled(s);
    (s as any).keepForRetry({ u: utt("u_2", "host", 4000), speakerId: "spk_1", inferred: false, tags: [], context: { prompt: "" } });
    await (s as any).retryPending();
    expect(s.transcriptLines().map((l) => l.text)).toEqual(["first said", "said between", "said later"]);
  });

  it("a transient failure during a retry pass stops the pass and keeps the rest", async () => {
    let calls = 0;
    const { s } = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(async () => { calls++; return down; }) });
    for (const k of [1, 2]) (s as any).keepForRetry({ u: utt(`u_${k}`, "host", k * 3000), speakerId: "spk_1", inferred: false, tags: [], context: { prompt: "" } });
    await (s as any).retryPending();
    expect(calls).toBe(1);
    expect((s as any).pending.size).toBe(2);
  });

  it("a rejected retry (a budget refusal) is not transient: the line is given up and the pass goes on", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(() => Promise.reject(new Error("budget exhausted"))) });
    for (const k of [1, 2]) (s as any).keepForRetry({ u: utt(`u_${k}`, "host", k * 3000), speakerId: "spk_1", inferred: false, tags: [], context: { prompt: "" } });
    await (s as any).retryPending();
    expect((s as any).pending.size).toBe(0);
    expect(of("utterance.failed").map((f) => [f.id, f.status])).toEqual([["u_1", "failed"], ["u_2", "failed"]]);
    const s2 = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(() => Promise.reject("offline")) });
    (s2.s as any).keepForRetry({ u: utt("u_1", "host", 0), speakerId: "spk_1", inferred: false, tags: [], context: { prompt: "" } });
    await (s2.s as any).retryPending();
    expect(s2.of("utterance.failed")[0].status).toBe("failed");
  });

  it("a transcriber that throws synchronously during a retry is reported as 'retrying failed lines: …'", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(() => { throw new Error("not async"); }) });
    (s as any).keepForRetry({ u: utt("u_1", "host", 0), speakerId: "spk_1", inferred: false, tags: [], context: { prompt: "" } });
    await (s as any).retryPending();
    expect(of("error")).toEqual([{ component: "transcription", message: "retrying failed lines: not async" }]);
    expect((s as any).retrying).toBeNull();
    const s2 = makeSession({ sources: [new SamplesSource("host", silence(0))], services: scriptedServices(() => { throw "plain"; }) });
    (s2.s as any).keepForRetry({ u: utt("u_1", "host", 0), speakerId: "spk_1", inferred: false, tags: [], context: { prompt: "" } });
    await (s2.s as any).retryPending();
    expect(s2.of("error")[0].message).toBe("retrying failed lines: plain");
  });

  it("while the session runs, failed lines are retried every retryEveryMs", async () => {
    let calls = 0;
    const src = new PushSource("host");
    const { s, of } = makeSession({
      sources: [src], retryEveryMs: 20,
      services: scriptedServices(async () => (++calls === 1 ? down : { ok: true, text: "recovered by the timer", filler: false })),
    });
    const done = s.run();
    (s as any).onUtterance(utt("u_1", "host", 0));
    await until(() => of("utterance").length === 1, 100_000);
    src.end();
    await done;
    expect(of("utterance")[0]).toMatchObject({ id: "u_1", recovered: true });
    expect(of("utterance.failed").map((f) => f.status)).toEqual(["retrying"]);
  });
});

describe("Session health, stats and export", () => {
  it("health: −120 dBFS for silence, −1 ms before any frame, and lines counted over the last minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    const { s, of, invalid } = makeSession({ sources: [new SamplesSource("host", silence(0)), new SamplesSource("remote", silence(0))] });
    (s as any).emitHealth();
    expect(of("health")).toEqual([
      { stream: "host", rmsDbfs: -120, msSinceLastFrame: -1, utterancesLastMinute: 0 },
      { stream: "remote", rmsDbfs: -120, msSinceLastFrame: -1, utterancesLastMinute: 0 },
    ]);
    (s as any).onUtterance(utt("u_1", "host", 0));
    vi.setSystemTime(new Date("2026-09-30T10:00:30Z"));
    (s as any).onUtterance(utt("u_2", "host", 3000));
    const h = (s as any).health.get("host");
    h.lastFrameAt = Date.now() - 250;
    h.recent.push(constant(0.5));
    vi.setSystemTime(new Date("2026-09-30T10:01:10Z"));
    (s as any).emitHealth();
    expect(of("health")[2]).toEqual({ stream: "host", rmsDbfs: -6, msSinceLastFrame: 40_250, utterancesLastMinute: 1 });
    await settled(s);
    expect(invalid).toEqual([]);
  });

  it("health carries the gate's muted time for the host only while the gate is on, and the capture detail when there is one", async () => {
    let detail: Record<string, unknown> | null = { device: "MacBook Air Microphone" };
    const { s, of, invalid } = makeSession({ sources: [new SamplesSource("host", silence(0)), new SamplesSource("remote", silence(0))], healthDetail: () => detail }, withEchoMode("always"));
    s.echoGate.remote(constant(0.5, 16_000), 0);
    s.echoGate.host(constant(0.3, 1600), 100); // 100 ms muted
    (s as any).emitHealth();
    expect(of("health")[0]).toMatchObject({ stream: "host", echoMutedMs: 100, detail: { device: "MacBook Air Microphone" } });
    expect(of("health")[1]).not.toHaveProperty("echoMutedMs");
    detail = null;
    (s as any).emitHealth();
    expect(of("health")[2]).not.toHaveProperty("detail");
    expect(of("health")[2].echoMutedMs).toBe(0);
    expect(invalid).toEqual([]);
  });

  it("stats are emitted every statsIntervalMs while running, and once more at the end", async () => {
    const src = new PushSource("host");
    const { s, events } = makeSession({ sources: [src], statsIntervalMs: 10 });
    const done = s.run();
    await until(() => events().filter((e) => e.type === "stats").length >= 2, 100_000);
    src.end();
    await done;
    const types = events().map((e) => e.type);
    expect(types.at(-2)).toBe("stats");
    expect(types.filter((t) => t === "stats").length).toBeGreaterThanOrEqual(3);
  });

  it("the boundary export has one row per line Jev processed, and state() reports each line's boundary", async () => {
    const out = join(tmpDir(), "boundary.jsonl");
    const ask = vi.fn(async () => jevAnswer({ boundary: { type: "noul", noul: 0.25 } }));
    const { s, invalid } = makeSession({
      sources: [new SamplesSource("host", fixtureSlice("host", 0, 9000))], exportBoundary: out, features: { factcheck: false, labels: true },
      services: scriptedServices(undefined, ask),
    });
    await s.run();
    const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toEqual([{ utterance_id: "u_1", speaker: "Speaker 1", text: "words said here", boundary_p: 0.25, human_boundary: null }]);
    const st = s.state() as any;
    expect(st.utterances[0]).toMatchObject({ id: "u_1", boundary: 0.25, speakerName: "Speaker 1" });
    expect(st.openSegment).toBeNull();
    expect(st.segments).toHaveLength(1);
    expect(st.labels.version).toBe(s.timeline.version);
    expect(st.cost).toEqual(s.budget.totals());
    expect(st.session).toMatchObject({ status: "ended", paused: false, streams: ["host"], echoGate: { active: false, device: null } });
    expect(invalid).toEqual([]);
  });

  it("the boundary export is empty when Jev processed nothing", async () => {
    const out = join(tmpDir(), "boundary.jsonl");
    const { s } = makeSession({ sources: [new SamplesSource("host", fixtureSlice("host", 0, 9000))], exportBoundary: out });
    await s.run();
    expect(readFileSync(out, "utf8")).toBe("");
    expect((s.state() as any).utterances[0].boundary).toBeNull();
  });

  it("state() shows the open segment while it is open", async () => {
    const { s } = makeSession({ sources: [new SamplesSource("host", silence(0))] });
    (s as any).onUtterance(utt("u_1", "host", 0));
    await settled(s);
    await s.segmenter.idle();
    expect((s.state() as any).openSegment).toEqual({ id: expect.stringMatching(/^seg_/), utteranceIds: ["u_1"] });
  });

  it("when fact-checking does not drain within 180 s, an error says so and the session still ends", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(512))], features: {} });
    vi.spyOn(s.factcheck, "drain").mockResolvedValue(false);
    await s.run();
    expect(of("error")).toContainEqual({ component: "factcheck", message: "fact-check work still running after 180 s; ending anyway" });
    expect(of("session.ended")).toHaveLength(1);
  });

  it("a Jev or System 2 row is logged and streamed as a transient call; an ok utterance row keeps its state for System 1", async () => {
    let log!: (file: any, row: unknown, live?: Record<string, unknown>) => void;
    const { s, bus } = makeSession({ sources: [new SamplesSource("host", silence(0))], services: (ctx) => { log = ctx.log; return scriptedServices()(); } });
    const live: any[] = [];
    bus.subscribe((e) => live.push(e));
    log("jev_calls", { kind: "jev_call", purpose: "utterance", ok: true, utterance_id: "u_1", state: { said: 1 } }, { questions: { q: 1 } });
    log("jev_calls", { kind: "jev_call", purpose: "utterance", ok: false, utterance_id: "u_2", state: { said: 2 } });
    log("jev_calls", { kind: "jev_call", purpose: "segment", ok: true, utterance_id: "u_3", state: { said: 3 } });
    log("s2_calls", { kind: "s2_call", purpose: "research", ok: true });
    log("transcriptions", { kind: "transcription", ok: true });
    expect([...(s as any).states.entries()]).toEqual([["u_1", { said: 1 }]]);
    expect(live.map((e) => e.type)).toEqual(["call", "call", "call", "call"]);
    expect(live[0].data.questions).toEqual({ q: 1 });
    expect(bus.history()).toEqual([]);
    expect(readFileSync(join(s.store.dir, "jev_calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
    expect(readFileSync(join(s.store.dir, "transcriptions.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("the fact-checker's replay gate asks Jev through the session's services and reads the state kept for each line", async () => {
    let log!: (file: any, row: unknown) => void;
    const ask = vi.fn(async () => jevAnswer({}));
    const { s } = makeSession({ sources: [new SamplesSource("host", silence(0))], features: {}, services: (ctx) => { log = ctx.log; return scriptedServices(undefined, ask)(); } });
    log("jev_calls", { kind: "jev_call", purpose: "utterance", ok: true, utterance_id: "u_7", state: { said: 7 } });
    const deps = (s.factcheck as any).deps;
    expect(deps.stateOf("u_7")).toEqual({ said: 7 });
    expect(deps.stateOf("u_8")).toBeUndefined();
    await deps.ask({ said: 7 }, {}, { purpose: "gate", utterance_id: "u_7" });
    expect(ask).toHaveBeenCalledWith({ said: 7 }, {}, { purpose: "gate", utterance_id: "u_7" });
  });

  it("the budget's cost and exhaustion reach the bus", () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(0))] });
    s.budget.record("jev", 0.01);
    expect(of("cost").length).toBeGreaterThan(0);
    (s.budget as any).opts.onExhausted({ cap: "openrouter", purpose: "jev", message: "no credits", totals: s.budget.totals() });
    expect(of("budget.exhausted")[0]).toMatchObject({ cap: "openrouter", purpose: "jev", message: "no credits" });
  });
});

describe("Session commands", () => {
  it("setOutput emits echo.gate on a change and on a device rename while on; nothing while off or after the end", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(0))] });
    s.setOutput("speakers", "MacBook Air Speakers");
    s.setOutput("speakers", "MacBook Air Speakers"); // no change
    s.setOutput("speakers", "Studio Display Speakers"); // renamed while on
    s.setOutput("headphones", "AirPods"); // off
    s.setOutput("headphones", "Other Headphones"); // renamed while off: nothing
    s.setOutput(null, null);
    expect(of("echo.gate").map((e) => [e.active, e.device])).toEqual([
      [true, "MacBook Air Speakers"], [true, "Studio Display Speakers"], [false, "AirPods"],
    ]);
    await s.run();
    s.setOutput("speakers", "MacBook Air Speakers");
    expect(of("echo.gate")).toHaveLength(3);
    expect((s.state() as any).session.echoGate).toEqual({ active: true, device: "MacBook Air Speakers" });
  });

  it("mergeSpeakers names the speaker as resolved before the merge; rename and merge write speakers.json only after the end", async () => {
    const { s, of } = makeSession({ sources: [new SamplesSource("host", silence(0)), new SamplesSource("remote", silence(0))] });
    (s as any).onUtterance(utt("u_1", "host", 0, 2, 0.1));
    (s as any).onUtterance(utt("u_2", "remote", 0, 2, 0.3));
    (s as any).onUtterance(utt("u_3", "remote", 3000, 2, 0.6));
    await settled(s);
    const [a, b, c] = of("speaker.created").map((x) => x.id);
    s.mergeSpeakers(c, b);
    s.mergeSpeakers(c, a); // c now resolves to b: the event names b
    expect(of("speaker.merged").map((e) => e.fromId)).toEqual([c, b]);
    s.renameSpeaker(a, "Nic");
    expect(existsSync(join(s.store.dir, "speakers.json"))).toBe(false);
    await s.run();
    s.renameSpeaker(a, "Nicolas");
    const saved = JSON.parse(readFileSync(join(s.store.dir, "speakers.json"), "utf8"));
    expect(saved.find((x: any) => x.id === a).displayName).toBe("Nicolas");
  });

  it("every event of a short session with real services on fakes passes its schema", async () => {
    // fixture slices with both features on: transcription, Jev (boundary, System 1, labels) and System 2 on one fake fetch
    const { fakeServicesFetch, TEST_OPENROUTER_KEY, TEST_OPENAI_KEY } = await import("./fakes/index.ts");
    const { loadScript } = await import("./helpers.ts");
    const { f } = fakeServicesFetch(loadScript());
    const { s, invalid, events } = makeSession({
      services: undefined, fetch: f, keys: { openrouter: TEST_OPENROUTER_KEY, openai: TEST_OPENAI_KEY }, features: {},
      sources: [new SamplesSource("host", fixtureSlice("host", 0, 16_000)), new SamplesSource("remote", fixtureSlice("remote", 0, 16_000))],
    });
    await s.run();
    expect(events().map((e) => e.type)).toEqual(expect.arrayContaining(["utterance", "speaker.created", "segment.closed", "session.ended"]));
    expect(invalid).toEqual([]);
  });
});
