import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import sherpa from "sherpa-onnx-node";
import { loadConfig } from "../src/config.ts";
import { EchoGate } from "../src/audio/echoGate.ts";
import { FileSource } from "../src/audio/source.ts";
import { encodeWav, readWav16k } from "../src/audio/wav.ts";
import { Session } from "../src/pipeline/session.ts";
import { EventBus } from "../src/store/events.ts";
import { FIXTURE_DIR, loadScript, requireAssets } from "./helpers.ts";
import { FakeSocket, transcribeOnlyServices as services } from "./fakes/index.ts";

const CFG = { mode: "auto" as const, thresholdDbfs: -45, holdMs: 250 };
const tone = (amp: number) => Float32Array.from({ length: 512 }, (_, i) => amp * Math.sin(i / 3));
const FRAME_MS = 32;

describe("echo gate", () => {
  test("inactive, it returns every host frame unchanged", () => {
    const g = new EchoGate(CFG);
    g.remote(tone(0.5), 0);
    const f = tone(0.3);
    expect(g.host(f, 0)).toBe(f);
    expect(g.takeMutedMs()).toBe(0);
  });

  test("follows the output device in auto mode: speakers on, headphones and unknown off", () => {
    const g = new EchoGate(CFG);
    expect(g.setOutput("speakers")).toBe(true);
    expect(g.active).toBe(true);
    expect(g.setOutput("speakers")).toBe(false);
    expect(g.setOutput("headphones")).toBe(true);
    expect(g.active).toBe(false);
    g.setOutput("speakers");
    expect(g.setOutput(null)).toBe(true);
    expect(g.active).toBe(false);
  });

  test("always and never ignore the output device", () => {
    const always = new EchoGate({ ...CFG, mode: "always" });
    expect(always.active).toBe(true);
    expect(always.setOutput("headphones")).toBe(false);
    expect(always.active).toBe(true);
    const never = new EchoGate({ ...CFG, mode: "never" });
    expect(never.setOutput("speakers")).toBe(false);
    expect(never.active).toBe(false);
  });

  test("mutes the microphone while the call plays and for holdMs after, then lets it through", () => {
    const g = new EchoGate({ ...CFG, mode: "always" });
    g.remote(tone(0.5), 1000); // the call plays 1000–1032 ms
    const f = tone(0.3);
    expect(g.host(f, 1000).every((v) => v === 0)).toBe(true);
    expect(g.host(f, 1032 + 200).every((v) => v === 0)).toBe(true); // inside the hold
    expect(g.host(f, 1032 + 250)).toBe(f); // hold over
    expect(g.takeMutedMs()).toBe(2 * FRAME_MS);
    expect(g.takeMutedMs()).toBe(0);
  });

  test("the microphone always comes back: after the call goes quiet, on a bad timestamp, and when earbuds connect", () => {
    const g = new EchoGate(CFG);
    g.setOutput("speakers");
    const f = tone(0.3);
    g.remote(tone(0.5), 0);
    expect(g.host(f, 100)).not.toBe(f); // muted while the call plays
    for (let t = 1000; t < 60_000; t += FRAME_MS) expect(g.host(f, t)).toBe(f); // call silent: open for good
    g.remote(tone(0.5), 500_000); // a call frame stamped far in the future
    expect(g.host(f, 60_000)).toBe(f);
    g.remote(tone(0.5), 60_000);
    expect(g.host(f, 60_010)).not.toBe(f);
    g.setOutput("headphones"); // earbuds in, even mid-call
    expect(g.host(f, 60_020)).toBe(f);
    expect(g.takeMutedMs()).toBe(0);
  });

  test("a call quieter than the threshold (line noise) does not mute", () => {
    const g = new EchoGate({ ...CFG, mode: "always" });
    g.remote(tone(0.002), 0); // about −57 dBFS
    const f = tone(0.3);
    expect(g.host(f, 0)).toBe(f);
  });

  test("a virtual output (a recorder, a loopback device) keeps the gate off", () => {
    const g = new EchoGate(CFG);
    expect(g.setOutput("virtual")).toBe(false);
    expect(g.active).toBe(false);
    g.setOutput("speakers");
    expect(g.setOutput("virtual")).toBe(true);
    expect(g.active).toBe(false);
  });

  test("always mode ignores a null output; never mode ignores speakers", () => {
    const always = new EchoGate({ ...CFG, mode: "always" });
    expect(always.setOutput(null)).toBe(false);
    expect(always.active).toBe(true);
    const never = new EchoGate({ ...CFG, mode: "never" });
    expect(never.setOutput("speakers")).toBe(false);
    expect(never.setOutput(null)).toBe(false);
  });

  test("going inactive resets the muted counter", () => {
    const g = new EchoGate(CFG);
    g.setOutput("speakers");
    g.remote(tone(0.5), 0);
    expect(g.host(tone(0.3), 0).every((v) => v === 0)).toBe(true);
    g.setOutput("headphones");
    expect(g.takeMutedMs()).toBe(0);
  });

  test("a host frame at exactly playingUntil + holdMs passes through (>=), one ms before is muted", () => {
    const g = new EchoGate({ ...CFG, mode: "always" });
    g.remote(tone(0.5), 1000); // playing until 1032
    const f = tone(0.3);
    expect(g.host(f, 1032 + 250 - 1)).not.toBe(f);
    expect(g.host(f, 1032 + 250)).toBe(f);
  });

  test("a lead of exactly 1000 ms still mutes; 1000.5 ms does not", () => {
    const f = tone(0.3);
    const g = new EchoGate({ ...CFG, mode: "always" });
    g.remote(tone(0.5), 2000); // playing until 2032
    expect(g.host(f, 1032)).not.toBe(f); // 1000 ms ahead
    const h = new EchoGate({ ...CFG, mode: "always" });
    h.remote(tone(0.5), 2000);
    expect(h.host(f, 1031.5)).toBe(f); // 1000.5 ms ahead: a bad timestamp, never muted
  });

  test("a call frame exactly at thresholdDbfs counts as playing", () => {
    const amp = 10 ** (-20 / 20); // a constant of 0.1 is −20 dBFS
    const at = Float32Array.from({ length: 512 }, () => amp);
    const db = 20 * Math.log10(Math.sqrt(at.reduce((a, x) => a + x * x, 0) / at.length));
    const g = new EchoGate({ ...CFG, mode: "always", thresholdDbfs: db });
    g.remote(at, 0);
    expect(g.host(tone(0.3), 0).every((v) => v === 0)).toBe(true);
    const h = new EchoGate({ ...CFG, mode: "always", thresholdDbfs: db + 1e-9 });
    h.remote(at, 0);
    const f = tone(0.3);
    expect(h.host(f, 0)).toBe(f);
  });

  test("an empty call frame is ignored", () => {
    const g = new EchoGate({ ...CFG, mode: "always" });
    g.remote(new Float32Array(0), 0);
    const f = tone(0.3);
    expect(g.host(f, 0)).toBe(f);
  });

  test("takeMutedMs rounds fractional ms: a 100-sample host frame is 6.25 ms → 6", () => {
    const g = new EchoGate({ ...CFG, mode: "always" });
    g.remote(tone(0.5), 0);
    const out = g.host(new Float32Array(100).fill(0.3), 0);
    expect(out.length).toBe(100);
    expect(g.takeMutedMs()).toBe(6);
  });

  test("a later quiet call frame does not shorten playingUntil", () => {
    const g = new EchoGate({ ...CFG, mode: "always" });
    g.remote(tone(0.5), 1000); // until 1032
    g.remote(tone(0.001), 1032); // quiet: ignored
    const f = tone(0.3);
    expect(g.host(f, 1032 + 249)).not.toBe(f);
  });

  test("an earlier loud call frame after a later one moves playingUntil back (it assigns, it does not take the max)", () => {
    const g = new EchoGate({ ...CFG, mode: "always" });
    g.remote(tone(0.5), 2000); // until 2032
    g.remote(tone(0.5), 1000); // until 1032: frames arrive in time order, so this does not happen in a session
    const f = tone(0.3);
    expect(g.host(f, 1032 + 250)).toBe(f);
  });
});

/** The fixture's host track with the call leaking in: the remote track, 40 ms late, at a third of its level. */
function echoedHost(dir: string): string {
  const host = readWav16k(`${FIXTURE_DIR}/host.wav`);
  const remote = readWav16k(`${FIXTURE_DIR}/remote.wav`);
  const delay = 16 * 40;
  const out = Float32Array.from(host);
  for (let i = delay; i < out.length && i - delay < remote.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] + remote[i - delay] / 3));
  const path = join(dir, "host-echo.wav");
  writeFileSync(path, encodeWav(out));
  return path;
}

async function run(hostPath: string, mode: "auto" | "always" | "never", output?: "speakers") {
  const config = loadConfig();
  config.app.echoGate.mode = mode;
  const bus = new EventBus();
  const s = new Session({
    mode: "replay", config, bus, sessionsDir: mkdtempSync(join(tmpdir(), "sessions-")), services,
    features: { factcheck: false, labels: false },
    sources: [new FileSource(hostPath, "host", "max"), new FileSource(`${FIXTURE_DIR}/remote.wav`, "remote", "max")],
  });
  const done = s.run();
  if (output) s.setOutput(output, "MacBook Air Speakers");
  await done;
  const host = bus.history().filter((e) => e.type === "utterance" && e.data.stream === "host").map((e) => e.data as { startMs: number; endMs: number });
  return { s, bus, host };
}

describe("echo gate in a session", () => {
  test("with the call leaking into the microphone, speaker mode keeps the host's lines and drops the echoed ones", async () => {
    requireAssets();
    const script = loadScript();
    const remoteLines = script.lines.filter((l) => l.stream === "remote");
    const hostLines = script.lines.filter((l) => l.stream === "host");
    const path = echoedHost(mkdtempSync(join(tmpdir(), "echo-")));
    const overlapsRemote = (u: { startMs: number; endMs: number }) => remoteLines.some((l) => u.startMs < l.endMs && u.endMs > l.startMs);

    const before = await run(path, "never");
    // the bug: the call is heard twice (back-to-back echoed lines can merge into one utterance)
    expect(before.host.filter(overlapsRemote).length).toBeGreaterThanOrEqual(3);

    const after = await run(path, "auto", "speakers");
    expect(after.host.filter(overlapsRemote)).toEqual([]);
    for (const l of hostLines) expect(after.host.some((u) => u.startMs < l.endMs && u.endMs > l.startMs), l.text).toBe(true);
    const gate = after.bus.history().filter((e) => e.type === "echo.gate");
    expect(gate.map((e) => e.data)).toEqual([{ active: true, device: "MacBook Air Speakers", atMs: expect.any(Number) }]);
    expect((after.s.state() as any).session.echoGate).toEqual({ active: true, device: "MacBook Air Speakers" });
    // what is stored is what the pipeline heard: the muted stretches are silence in host.wav
    const rec = sherpa.readWave(join(after.s.store.dir, "host.wav")).samples;
    const l = remoteLines[0];
    expect(rec.subarray(l.startMs * 16 + 1600, l.endMs * 16).every((v: number) => v === 0)).toBe(true);
  }, 300_000); // two full sessions: slow on a loaded machine

  test("with headphones (auto mode, no speakers), the recorded host audio is exactly the input", async () => {
    requireAssets();
    const { s, bus } = await run(`${FIXTURE_DIR}/host.wav`, "auto");
    expect(bus.history().some((e) => e.type === "echo.gate")).toBe(false);
    const input = readWav16k(`${FIXTURE_DIR}/host.wav`);
    const rec = readWav16k(join(s.store.dir, "host.wav"));
    expect(rec.length).toBeGreaterThanOrEqual(input.length);
    let diff = 0;
    for (let i = 0; i < input.length; i++) diff = Math.max(diff, Math.abs(rec[i] - input[i]));
    expect(diff).toBeLessThan(1e-4); // PCM16 rounding only
  });
});

describe("echo gate through the engine", () => {
  test("a live session follows the helper's output device: speakers turn speaker mode on, headphones turn it off", async () => {
    requireAssets();
    const { Engine } = await import("../src/server/main.ts");
    let status!: (type: "error" | "health", data: Record<string, unknown>) => void;
    const engine = new Engine({
      sessionsDir: mkdtempSync(join(tmpdir(), "sessions-")),
      // live text gets a fake socket: without one it opened a real one to OpenAI's realtime endpoint (docs/testing.md)
      session: { services, liveConnect: (url, headers) => new FakeSocket(url, headers) },
      live: async (_mic, onStatus) => {
        status = onStatus;
        // the helper says where the call plays before the session exists
        onStatus("health", { capture: { type: "started", epochMs: 0, remote: { outputDevice: "MacBook Air Speakers", outputKind: "speakers" } } });
        return { sources: [new FileSource(`${FIXTURE_DIR}/host.wav`, "host", "max"), new FileSource(`${FIXTURE_DIR}/remote.wav`, "remote", "max")], stop: async () => {} };
      },
    });
    await engine.start({ mode: "live", features: { factcheck: false, labels: false } });
    const s = engine.current!;
    expect(s.echoGate.active).toBe(true);
    status("health", { capture: { type: "device_changed", remote: { outputDevice: "AirPods Pro", outputKind: "headphones" } } });
    expect(s.echoGate.active).toBe(false);
    await s.run();
    const gate = engine.bus.history().filter((e) => e.type === "echo.gate").map((e) => ({ active: e.data.active, device: e.data.device }));
    expect(gate).toEqual([{ active: true, device: "MacBook Air Speakers" }, { active: false, device: "AirPods Pro" }]);
  });
});
