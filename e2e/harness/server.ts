// The end-to-end harness (docs/testing.md § E2E web): the real engine, router, page, key setup and session pipeline,
// with every external service faked, on 127.0.0.1. Run from the project root:
//   node --import tsx e2e/harness/server.ts
// It prints `E2E_READY <url>` once it listens. The Playwright fixture (e2e/fixtures.ts) starts it with an isolated
// HOME and tmp paths for everything, and these switches:
//   E2E_PORT=0            the port (0 picks a free one)
//   E2E_TMP=<dir>         where sessions, keys, settings and label sets live (required)
//   E2E_KEYS=missing      start with no keys (the first-run screen)
//   E2E_REFUSE_KEYS=<s>   key checks refuse keys containing <s>
//   E2E_402=1             OpenRouter answers every Jev call with a non-transient 402 (credit used up)
//   E2E_SEED=library      two recordings in the library before the page loads
//   E2E_LIVE=hold         Start live captures silence until stopped (scripted scenarios); otherwise the fixture at 1×
//   E2E_LIVE_TEXT=off     no live text
//   E2E_CONTROL=1         read commands from stdin, one JSON per line (scripted scenarios):
//                         {"emit": type, "data": {...}, "transient"?: true}  an event on the engine's bus
//                         {"dropEvents": true}                              closes every open /api/events stream
//                         {"push": {stream, atMs, ms, amp}}                 audio on a held stream (E2E_LIVE=hold)
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { ServerResponse } from "node:http";

// The network is off before anything else loads: every service call goes through the fakes.
globalThis.fetch = (() => { throw new Error("network disabled in E2E"); }) as typeof fetch;
globalThis.WebSocket = class { constructor() { throw new Error("network disabled in E2E"); } } as unknown as typeof WebSocket;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const tmp = process.env.E2E_TMP;
if (!tmp || !process.env.HOME?.startsWith(tmp) || !process.env.TATTLE_CREDENTIALS?.startsWith(tmp) || !process.env.TATTLE_SETTINGS?.startsWith(tmp)) {
  // never run against the real Application Support folder (real keys and recordings)
  console.error("E2E harness: set E2E_TMP, and HOME, TATTLE_CREDENTIALS and TATTLE_SETTINGS inside it (e2e/fixtures.ts does)");
  process.exit(2);
}

const { setAppPaths } = await import("../../src/paths.ts");
const { loadConfig } = await import("../../src/config.ts");
const { Engine, createApiServer } = await import("../../src/server/main.ts");
const { KeySetup, KeyStore } = await import("../../src/keys.ts");
const { SettingsStore, TranscriptionSettings } = await import("../../src/settings.ts");
const { LabelSetStore } = await import("../../src/labels/store.ts");
const { FileSource } = await import("../../src/audio/source.ts");
const { LiveStream } = await import("../../src/audio/nativeSource.ts");
const { loadScript } = await import("../../tests/helpers.ts");
const { makeSession, toneWav } = await import("../../tests/fakes/index.ts");
const { e2eFetch, FakeRealtimeSocket } = await import("./fakes.ts");

const sessions = join(tmp, "sessions");
mkdirSync(sessions, { recursive: true });
setAppPaths({ sessions, src: null, helper: join(tmp, "no-helper") });

if (process.env.E2E_SEED === "library") {
  const seeded = [
    makeSession(sessions, "20260924-100000", { startedAt: "2026-09-24T10:00:00Z", lines: [["u_1", "Jev is four hundred times cheaper than GPT."], ["u_2", "Surfing in Sydney was great."]] }),
    makeSession(sessions, "20260925-090000", { startedAt: "2026-09-25T09:00:00Z", lines: [["u_1", "Welcome to the show about agents."]] }),
  ];
  // real WAVs (makeSession's are bare bytes), so playback, export and import decode them
  for (const dir of seeded) {
    writeFileSync(join(dir, "host.wav"), toneWav(90, 440));
    writeFileSync(join(dir, "remote.wav"), toneWav(90, 660));
  }
}

const keys = new KeyStore({ path: process.env.TATTLE_CREDENTIALS }).load();
if (process.env.E2E_KEYS !== "missing" && keys.missing().length) {
  keys.save({ openai: "sk-proj-e2e-000000000000000000000000abcd", openrouter: "sk-or-v1-e2e-00000000000000000000000000001234" });
}
const config = loadConfig();
if (process.env.E2E_LIVE_TEXT === "off" && config.app.transcription.live) config.app.transcription.live.enabled = false;
const fx = e2eFetch(loadScript(), { openrouter402: process.env.E2E_402 === "1", refuseKeysWith: process.env.E2E_REFUSE_KEYS });

const keySet = (name: "openai" | "openrouter") => keys.status().some((k) => k.name === name && k.set);
let engine: InstanceType<typeof Engine> | null = null;
// Apple Speech is never available here: it would start the real on-device helper. Sessions transcribe with the fake OpenAI.
const transcription = new TranscriptionSettings({
  store: new SettingsStore(process.env.TATTLE_SETTINGS),
  openaiKeySet: () => keySet("openai"),
  status: async () => ({ available: false, reason: "not in end-to-end tests", locale: null, installed: false }),
  install: async () => {},
  onChange: (s) => engine?.bus.emit("transcription.status", { ...s }, { transient: true }),
});
const ready = transcription.init();
const setup = new KeySetup(keys, {
  fetch: fx,
  models: [config.app.transcription.model, ...(config.app.transcription.live?.enabled ? [config.app.transcription.live.model] : [])],
  required: () => (transcription.engine === "openai" ? ["openai"] : []),
});

const FIX = resolve("fixtures/conversation");
let held: InstanceType<typeof LiveStream>[] = [];
engine = new Engine({
  config, sessionsDir: sessions, transcription, fetch: fx,
  labelSets: new LabelSetStore({ userDir: join(tmp, "labels") }),
  session: { fetch: fx, liveConnect: (url, headers) => new FakeRealtimeSocket(url, headers), statsIntervalMs: 2000 },
  live: async (_mic, onStatus) => {
    onStatus("health", { capture: { type: "started", epochMs: Date.now(), host: { device: "MacBook Pro Microphone" }, remote: { outputKind: "headphones", outputDevice: "AirPods Pro" } } });
    if (process.env.E2E_LIVE === "hold") {
      // silence until stopped: the scenario drives what the page sees through the control channel
      held = [new LiveStream("host"), new LiveStream("remote")];
      return { sources: held, stop: async () => { for (const s of held) s.end(); } };
    }
    return { sources: [new FileSource(`${FIX}/host.wav`, "host", 1), new FileSource(`${FIX}/remote.wav`, "remote", 1)], stop: async () => {} };
  },
  devices: async () => [
    { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", transport: "builtin", isDefault: true },
    { uid: "usb-rode", name: "Rode NT-USB", transport: "usb", isDefault: false },
  ],
});

const server = createApiServer(engine, { webRoot: resolve("web"), setup, ready });
const eventStreams = new Set<ServerResponse>();
server.on("request", (req, res) => {
  if (req.url?.startsWith("/api/events")) { eventStreams.add(res); res.on("close", () => eventStreams.delete(res)); }
});

if (process.env.E2E_CONTROL === "1") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      const c = JSON.parse(line);
      if (c.emit) engine!.bus.emit(c.emit, c.data ?? {}, { transient: !!c.transient });
      if (c.dropEvents) for (const r of eventStreams) r.destroy();
      // audio on the held streams: {"push": {"stream": "host", "atMs": 0, "ms": 1000, "amp": 3277}} (3277 ≈ −20 dBFS)
      if (c.push) {
        const s = held.find((x) => x.stream === (c.push.stream ?? "host"));
        s?.push(new Int16Array(Math.round((c.push.ms ?? 1000) * 16)).fill(c.push.amp ?? 0), c.push.atMs ?? 0);
      }
      console.log(`E2E_DONE ${c.id ?? ""}`);
    } catch (e) {
      console.log(`E2E_FAILED ${(e as Error).message}`);
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  await ready;
  server.listen(Number(process.env.E2E_PORT ?? 0), "127.0.0.1", () => {
    console.log(`E2E_READY http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
  const shutdown = async () => {
    if (engine!.current && engine!.current.status === "running") await engine!.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
