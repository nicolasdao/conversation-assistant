import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { FrameParser, LiveStream, MalformedFrameError, startNativeCapture, type HelperProcess } from "../src/audio/nativeSource.ts";
import type { AudioFrame } from "../src/audio/source.ts";

function frameBytes(stream: 0 | 1, sessionMs: number, samples: number[]): Buffer {
  const b = Buffer.alloc(20 + samples.length * 2);
  b.write("PCAP", 0, "ascii");
  b[4] = stream;
  b.writeDoubleLE(sessionMs, 8);
  b.writeUInt32LE(samples.length, 16);
  samples.forEach((s, i) => b.writeInt16LE(s, 20 + 2 * i));
  return b;
}

const ramp = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ((from + i) % 2000) - 1000);

async function take(src: { frames(): AsyncIterable<AudioFrame> }, n: number): Promise<AudioFrame[]> {
  const out: AudioFrame[] = [];
  if (n === 0) return out;
  for await (const f of src.frames()) {
    out.push(f);
    if (out.length >= n) break;
  }
  return out;
}

async function all(src: { frames(): AsyncIterable<AudioFrame> }): Promise<AudioFrame[]> {
  const out: AudioFrame[] = [];
  for await (const f of src.frames()) out.push(f);
  return out;
}

class FakeHelper extends EventEmitter implements HelperProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  killed: string[] = [];
  constructor() {
    super();
    this.stdin.on("finish", () => this.exit(0));
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed.push(signal);
    this.exit(null, signal);
    return true;
  }
  started(epochMs: number) {
    this.stderr.write(JSON.stringify({ type: "started", epochMs, host: { device: "MacBook Air Microphone" }, remote: { outputDevice: "AirPods" } }) + "\n");
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    setImmediate(() => this.emit("exit", code, signal));
  }
}

describe("helper frame parser", () => {
  test("parses frames split at awkward boundaries", () => {
    const bytes = Buffer.concat([frameBytes(0, 0, ramp(1600)), frameBytes(1, 0, ramp(1600, 7)), frameBytes(0, 100, ramp(1600, 1600))]);
    for (const step of [1, 7, 19, 20, 21, 333, bytes.length]) {
      const p = new FrameParser();
      const frames = [];
      for (let i = 0; i < bytes.length; i += step) frames.push(...p.push(bytes.subarray(i, i + step)));
      expect(frames.map((f) => [f.stream, f.sessionMs, f.samples.length])).toEqual([["host", 0, 1600], ["remote", 0, 1600], ["host", 100, 1600]]);
      expect(frames[1].samples[0]).toBe(-993);
      expect(frames[2].samples[5]).toBe(ramp(1600, 1600)[5]);
    }
  });

  test("rejects bad magic and impossible counts", () => {
    const bad = frameBytes(0, 0, [1, 2]);
    bad.write("XCAP", 0, "ascii");
    expect(() => new FrameParser().push(bad)).toThrow(MalformedFrameError);
    const huge = frameBytes(0, 0, [1]);
    huge.writeUInt32LE(10_000_000, 16);
    expect(() => new FrameParser().push(huge)).toThrow(/impossible/);
    const badStream = frameBytes(0, 0, [1]);
    badStream[4] = 7;
    expect(() => new FrameParser().push(badStream)).toThrow(/stream/);
  });
});

describe("live stream re-chunking", () => {
  test("512-sample Float32 frames; sessionMs = helper ms + offset / 16; gaps become silence", async () => {
    const s = new LiveStream("host");
    s.push(Int16Array.from(ramp(1600)), 250);
    s.push(Int16Array.from(ramp(1600, 1600)), 350);
    s.push(Int16Array.from(new Array(1600).fill(1000)), 1450); // a 1 s gap (restart)
    s.end();
    const frames = await all(s);
    expect(frames.every((f) => f.samples.length === 512)).toBe(true);
    frames.forEach((f, i) => expect(f.sessionMs).toBeCloseTo(250 + i * 32));
    expect(frames[0].samples[1]).toBeCloseTo(-999 / 32768);
    // samples from 550 ms to 1450 ms are silence
    const at = (ms: number) => {
      const idx = Math.round((ms - 250) * 16);
      return frames[Math.floor(idx / 512)].samples[idx % 512];
    };
    expect(at(800)).toBe(0);
    expect(at(1460)).toBeCloseTo(1000 / 32767);
  });

  test("overlapping samples are dropped", async () => {
    const s = new LiveStream("remote");
    s.push(Int16Array.from(new Array(1024).fill(1)), 0);
    s.push(Int16Array.from(new Array(1024).fill(2)), 32); // overlaps 32..64 ms
    s.end();
    const frames = await all(s);
    expect(frames.length).toBe(3); // 64 ms + 32 ms of new samples
    expect(frames[2].samples[0]).toBeCloseTo(2 / 32767);
  });
});

describe("native capture adapter (fake helper)", () => {
  test("maps helper time onto the session clock and restarts up to 3 times, then ends cleanly", async () => {
    const helpers: FakeHelper[] = [];
    const events: Record<string, unknown>[] = [];
    const cap = await startNativeCapture({
      spawn: () => { const h = new FakeHelper(); helpers.push(h); return h; },
      sessionStartEpochMs: 1_000_000, restartDelayMs: 5,
      onStatus: (type, data) => events.push({ type, ...data }),
    });
    const [host, remote] = cap.sources;
    expect(host.stream).toBe("host");
    // frames before the started line are held until the offset is known
    helpers[0].stdout.write(frameBytes(0, 0, ramp(512)));
    helpers[0].started(1_000_200);
    helpers[0].stdout.write(frameBytes(1, 0, ramp(512)));
    const [h0] = await take(host, 1);
    expect(h0.sessionMs).toBe(200);
    const [r0] = await take(remote, 1);
    expect(r0.sessionMs).toBe(200);
    expect(cap.status()?.type).toBe("started");

    for (let i = 0; i < 3; i++) {
      helpers[i].exit(1);
      await new Promise((r) => setTimeout(r, 30));
      expect(helpers.length).toBe(i + 2);
    }
    // after restart 1, the helper clock restarted: offset recomputed
    helpers[3].started(1_005_000);
    helpers[3].stdout.write(frameBytes(0, 0, ramp(512)));
    const next = await take(host, 1);
    // 232 ms of host audio was delivered before; the gap up to 5000 ms is silence, so frames stay continuous
    expect(next[0].sessionMs).toBeCloseTo(232);
    const errors = events.filter((e) => e.type === "error").map((e) => e.message as string);
    expect(errors.filter((m) => /restart \d of 3/.test(m)).length).toBe(3);
    helpers[3].exit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(helpers.length).toBe(4); // no fourth restart
    await cap.done;
    const rest = await all(host);
    expect(rest.at(-1)!.sessionMs).toBeCloseTo(5000, -2);
    expect(events.some((e) => /ending live capture/.test(String(e.message)))).toBe(true);
  });

  test("a malformed frame kills the helper and is handled as a crash", async () => {
    const helpers: FakeHelper[] = [];
    const events: Record<string, unknown>[] = [];
    const cap = await startNativeCapture({
      spawn: () => { const h = new FakeHelper(); helpers.push(h); return h; },
      restartDelayMs: 5, onStatus: (type, data) => events.push({ type, ...data }),
    });
    helpers[0].started(Date.now());
    helpers[0].stdout.write(Buffer.from("garbage-garbage-garbage"));
    await new Promise((r) => setTimeout(r, 30));
    expect(helpers[0].killed).toEqual(["SIGKILL"]);
    expect(helpers.length).toBe(2);
    expect(events.some((e) => /malformed/.test(String(e.message)))).toBe(true);
    await cap.stop();
  });

  test("stop closes stdin; warnings become capture errors", async () => {
    const helpers: FakeHelper[] = [];
    const events: Record<string, unknown>[] = [];
    const cap = await startNativeCapture({
      spawn: () => { const h = new FakeHelper(); helpers.push(h); return h; },
      onStatus: (type, data) => events.push({ type, ...data }),
    });
    helpers[0].stderr.write(JSON.stringify({ type: "warning", message: "device switched" }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toContainEqual({ type: "error", component: "capture", message: "device switched", level: "warning" });
    await cap.stop();
    expect(helpers[0].stdin.writableEnded).toBe(true);
    expect(helpers[0].killed).toEqual([]);
    expect(helpers.length).toBe(1);
    expect(await all(cap.sources[0])).toEqual([]);
  });
});
