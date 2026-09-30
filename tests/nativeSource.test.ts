import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
  FrameParser, listDevices, LiveStream, MalformedFrameError, startNativeCapture, type NativeCaptureOptions,
} from "../src/audio/nativeSource.ts";
import { setAppPaths } from "../src/paths.ts";
import { all, cleanTmpDirs, FakeHelper, frameBytes, ramp, take, tmpDir, withEnv } from "./fakes/index.ts";
import { shellBin } from "./fakes/audio.ts";

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
      // the restart comes after a 5 ms timer: wait for it, not for a fixed time (a busy machine takes longer)
      await vi.waitFor(() => expect(helpers.length).toBe(i + 2));
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
    await vi.waitFor(() => expect(helpers.length).toBe(2));
    expect(helpers[0].killed).toEqual(["SIGKILL"]);
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
    await vi.waitFor(() => expect(events).toContainEqual({ type: "error", component: "capture", message: "device switched", level: "warning" }));
    await cap.stop();
    expect(helpers[0].stdin.writableEnded).toBe(true);
    expect(helpers[0].killed).toEqual([]);
    expect(helpers.length).toBe(1);
    expect(await all(cap.sources[0])).toEqual([]);
  });
});

// ---------- more of the parser, the live stream, and the adapter ----------

const tick = () => new Promise<void>((r) => setImmediate(r));
/** Resolves with "timeout" if `p` has not settled within `ms` of real time. */
const within = <T>(p: Promise<T>, ms = 30) => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

describe("helper frame parser, edge cases", () => {
  const withHeader = (edit: (b: Buffer) => void) => { const b = frameBytes(0, 0, [1, 2]); edit(b); return b; };

  test("rejects n === 0", () => {
    expect(() => new FrameParser().push(withHeader((b) => b.writeUInt32LE(0, 16)))).toThrow(/impossible/);
  });

  test("rejects a negative sessionMs", () => {
    expect(() => new FrameParser().push(frameBytes(1, -1, [1]))).toThrow(/impossible/);
  });

  test("rejects NaN and Infinity sessionMs", () => {
    expect(() => new FrameParser().push(frameBytes(0, NaN, [1]))).toThrow(/impossible/);
    expect(() => new FrameParser().push(frameBytes(0, Infinity, [1]))).toThrow(/impossible/);
  });

  test("accepts n === 160000 (10 s) and rejects 160001", () => {
    const [f] = new FrameParser().push(frameBytes(1, 5, new Array(160_000).fill(3)));
    expect(f.samples.length).toBe(160_000);
    expect(() => new FrameParser().push(withHeader((b) => b.writeUInt32LE(160_001, 16)))).toThrow(/impossible/);
  });

  test("returns [] for a partial header and completes on the next push", () => {
    const p = new FrameParser();
    const b = frameBytes(0, 7, [5, 6, 7]);
    expect(p.push(b.subarray(0, 10))).toEqual([]);
    const [f] = p.push(b.subarray(10));
    expect([f.stream, f.sessionMs, [...f.samples]]).toEqual(["host", 7, [5, 6, 7]]);
  });

  test("keeps state across pushes after a full frame followed by 3 bytes of the next", () => {
    const p = new FrameParser();
    const a = frameBytes(0, 1, [1]);
    const b = frameBytes(1, 2, [2, 2]);
    expect(p.push(Buffer.concat([a, b.subarray(0, 3)])).map((f) => f.sessionMs)).toEqual([1]);
    expect(p.push(b.subarray(3)).map((f) => [f.stream, f.sessionMs])).toEqual([["remote", 2]]);
    expect(p.push(Buffer.alloc(0))).toEqual([]);
  });

  test("ignores the reserved bytes 5..7", () => {
    const b = frameBytes(1, 3, [9]);
    b[5] = 0xff; b[6] = 0x12; b[7] = 0x7f;
    expect(new FrameParser().push(b).map((f) => [f.stream, f.sessionMs, f.samples[0]])).toEqual([["remote", 3, 9]]);
  });
});

describe("live stream, edge cases", () => {
  test("a push after end() is ignored", async () => {
    const s = new LiveStream("host");
    s.push(Int16Array.from(ramp(512)), 0);
    s.end();
    s.push(Int16Array.from(ramp(512)), 32);
    expect((await all(s)).map((f) => f.sessionMs)).toEqual([0]);
  });

  test("frames() ends at once when end() is called with nothing queued", async () => {
    const s = new LiveStream("remote");
    s.end();
    expect(await all(s)).toEqual([]);
  });

  test("a consumer waiting in frames() wakes on the next push, and on end()", async () => {
    const s = new LiveStream("host");
    const one = take(s, 1);
    expect(await within(one)).toBe("timeout");
    s.push(Int16Array.from(ramp(512)), 100);
    expect((await one)[0].sessionMs).toBe(100);
    const rest = all(s);
    expect(await within(rest)).toBe("timeout");
    s.end();
    expect(await rest).toEqual([]);
  });

  test("scales -32768 to -1 and 32767 to 1 exactly", async () => {
    const s = new LiveStream("host");
    const x = new Int16Array(512);
    x[0] = -32768; x[1] = 32767; x[2] = -16384;
    s.push(x, 0);
    s.end();
    const [f] = await all(s);
    expect([f.samples[0], f.samples[1], f.samples[2]]).toEqual([-1, 1, -0.5]);
  });

  test("a push shorter than 512 samples yields no frame until enough accumulate", async () => {
    const s = new LiveStream("host");
    s.push(Int16Array.from(ramp(300)), 0);
    const first = take(s, 1);
    expect(await within(first)).toBe("timeout");
    s.push(Int16Array.from(ramp(300, 300)), 18.75); // contiguous: 300 samples is 18.75 ms
    const [f] = await first;
    expect(f.sessionMs).toBe(0);
    expect(f.samples[300]).toBe(Math.fround(ramp(1, 300)[0] / 32768)); // −700: negatives scale by 32768
  });

  test("an overlap larger than the push drops the whole push", async () => {
    const s = new LiveStream("host");
    s.push(Int16Array.from(new Array(1024).fill(1)), 0);
    s.push(Int16Array.from(new Array(160).fill(2)), 10); // 10–20 ms: all of it already on the clock
    s.end();
    const frames = await all(s);
    expect(frames.map((f) => f.sessionMs)).toEqual([0, 32]);
    expect(frames.every((f) => f.samples.every((v) => v === Math.fround(1 / 32767)))).toBe(true);
  });

  it.fails("BUG A2-L1: a stale chunk entirely before the clock does not move the clock backwards", async () => {
    const s = new LiveStream("host");
    s.push(Int16Array.from(new Array(1024).fill(1)), 0);
    s.push(Int16Array.from(new Array(160).fill(2)), 10); // stale: before the clock (64 ms)
    s.push(Int16Array.from(new Array(512).fill(3)), 64); // the next chunk, right on the clock
    s.end();
    // today: [0, 32, 20, 52] — the stale chunk set the clock to 20 ms, so 44 ms of silence was inserted, stamped in the past
    expect((await all(s)).map((f) => f.sessionMs)).toEqual([0, 32, 64]);
  });

  test("fractional sessionMs gaps round to whole samples", async () => {
    const s = new LiveStream("host");
    s.push(Int16Array.from(new Array(512).fill(100)), 0);
    s.push(Int16Array.from(new Array(511).fill(100)), 32.03); // 0.48 samples late: no gap
    // the clock is now 32.03 + 511/16 = 63.9675 ms; this chunk is 0.04 ms (0.64 samples) late: one silent sample
    s.push(Int16Array.from(new Array(512).fill(100)), 63.9675 + 0.04);
    s.end();
    const frames = await all(s);
    expect(frames).toHaveLength(3); // 512 + 511 + 1 + 512 samples
    const v = Math.fround(100 / 32767);
    expect(frames[1].samples.subarray(0, 511).every((x) => x === v)).toBe(true); // 0.48 samples rounded to no gap
    expect(frames[1].samples[511]).toBe(0); // 0.64 samples rounded to one
    expect(frames[2].samples.every((x) => x === v)).toBe(true);
  });
});

describe("native capture adapter, more (fake helper)", () => {
  afterEach(() => { vi.useRealTimers(); setAppPaths(); cleanTmpDirs(); });

  async function capture(opts: NativeCaptureOptions = {}, make: () => FakeHelper = () => new FakeHelper()) {
    const helpers: FakeHelper[] = [];
    const events: Record<string, unknown>[] = [];
    const spawned: string[][] = [];
    const cap = await startNativeCapture({
      spawn: (_bin, args) => { spawned.push(args); const h = make(); helpers.push(h); return h; },
      sessionStartEpochMs: 0, restartDelayMs: 5, onStatus: (type, data) => events.push({ type, ...data }), ...opts,
    });
    const errors = () => events.filter((e) => e.type === "error");
    return { cap, helpers, events, spawned, errors };
  }

  test("rejects when the bin is missing and no spawn is injected", async () => {
    await expect(startNativeCapture({ bin: "/nonexistent/tattle-capture" })).rejects.toThrow(/not built/);
  });

  test("the default bin is appPaths().helper", async () => {
    setAppPaths({ helper: "/nonexistent/default-helper" });
    await expect(startNativeCapture()).rejects.toThrow(/default-helper/);
  });

  test("passes --mic, --no-mic, --no-system per options", async () => {
    for (const [opts, args] of [
      [{}, []], [{ mic: "USB Mic" }, ["--mic", "USB Mic"]], [{ host: false }, ["--no-mic"]], [{ remote: false }, ["--no-system"]],
      [{ mic: "X", remote: false }, ["--mic", "X", "--no-system"]],
    ] as [NativeCaptureOptions, string[]][]) {
      const { cap, spawned } = await capture(opts);
      expect(spawned).toEqual([args]);
      await cap.stop();
    }
  });

  test("host:false exposes only the remote source and drops host frames", async () => {
    const { cap, helpers } = await capture({ host: false });
    expect(cap.sources.map((s) => s.stream)).toEqual(["remote"]);
    helpers[0].started(0);
    helpers[0].stdout.write(frameBytes(0, 0, ramp(512)));
    helpers[0].stdout.write(frameBytes(1, 0, ramp(512)));
    const [f] = await take(cap.sources[0], 1);
    expect(f.sessionMs).toBe(0);
    await cap.stop();
    expect(await all(cap.sources[0])).toEqual([]);
  });

  test("remote:false exposes only the host source", async () => {
    const { cap } = await capture({ remote: false });
    expect(cap.sources.map((s) => s.stream)).toEqual(["host"]);
    await cap.stop();
  });

  test("a non-JSON stderr line becomes a warning with the raw text", async () => {
    const { cap, helpers, errors } = await capture();
    helpers[0].stderr.write("  dyld: something odd  \n");
    await tick();
    expect(errors()).toEqual([{ type: "error", component: "capture", message: "dyld: something odd", level: "warning" }]);
    expect(cap.status()).toEqual({ type: "warning", message: "dyld: something odd" });
    await cap.stop();
  });

  test("stderr lines split across chunks are joined; blank lines are skipped", async () => {
    const { cap, helpers, events } = await capture();
    helpers[0].stderr.write('{"type":"dev');
    await tick();
    expect(events).toEqual([]);
    helpers[0].stderr.write('ice_changed","x":1}\n\n   \n{"type":"lev');
    await tick();
    helpers[0].stderr.write('els"}\n');
    await tick();
    expect(events).toEqual([
      { type: "health", capture: { type: "device_changed", x: 1 } },
      { type: "health", capture: { type: "levels" } },
    ]);
    await cap.stop();
  });

  test("an {type:'error'} line emits level 'error'; one without a message uses the raw line", async () => {
    const { cap, helpers, errors } = await capture();
    helpers[0].stderr.write('{"type":"error","message":"mic denied"}\n{"type":"warning"}\n');
    await tick();
    expect(errors()).toEqual([
      { type: "error", component: "capture", message: "mic denied", level: "error" },
      { type: "error", component: "capture", message: '{"type":"warning"}', level: "warning" },
    ]);
    await cap.stop();
  });

  test("device_changed and other status types become health events {capture: st}", async () => {
    const { cap, helpers, events } = await capture();
    const st = { type: "device_changed", remote: { outputDevice: "AirPods", outputKind: "headphones" } };
    helpers[0].stderr.write(JSON.stringify(st) + "\n");
    await tick();
    expect(events).toEqual([{ type: "health", capture: st }]);
    expect(cap.status()).toEqual(st);
    await cap.stop();
  });

  test("started emits health with the status, and status() returns the latest line", async () => {
    const { cap, helpers, events } = await capture();
    expect(cap.status()).toBeNull();
    helpers[0].started(0);
    await tick();
    expect(events).toEqual([{ type: "health", capture: { type: "started", epochMs: 0, host: { device: "MacBook Air Microphone" }, remote: { outputDevice: "AirPods" } } }]);
    expect(cap.status()?.type).toBe("started");
    helpers[0].stderr.write('{"type":"levels","host":-30}\n');
    await tick();
    expect(cap.status()).toEqual({ type: "levels", host: -30 });
    await cap.stop();
  });

  test("a started line without a numeric epochMs is reported as health", async () => {
    const { cap, helpers, events } = await capture();
    helpers[0].stderr.write('{"type":"started","epochMs":"soon"}\n');
    await tick();
    expect(events).toEqual([{ type: "health", capture: { type: "started", epochMs: "soon" } }]);
    await cap.stop();
  });

  it.fails("BUG A2-L4: frames are not held forever when the started line has no numeric epochMs", async () => {
    const { cap, helpers } = await capture();
    helpers[0].stderr.write('{"type":"started"}\n');
    helpers[0].stdout.write(frameBytes(0, 0, ramp(512)));
    const got = await within(take(cap.sources[0], 1), 50);
    await cap.stop();
    expect(got).not.toBe("timeout"); // today the frame waits in `held` with no clock offset, and more pile up behind it
  });

  test("frames and exits from a stale (replaced) process are ignored", async () => {
    const { cap, helpers } = await capture({ sessionStartEpochMs: 1000 });
    helpers[0].started(1000);
    helpers[0].exit(1);
    await vi.waitFor(() => expect(helpers).toHaveLength(2));
    helpers[0].stdout.write(frameBytes(0, 0, ramp(512))); // the old helper's pipe still delivers
    helpers[1].started(1500);
    helpers[1].stdout.write(frameBytes(0, 0, ramp(512)));
    const [f] = await take(cap.sources[0], 1);
    expect(f.sessionMs).toBe(500); // the new helper's frame, not the stale one at 0
    helpers[0].emit("exit", 1, null); // a late exit from the old one changes nothing
    await tick();
    expect(helpers).toHaveLength(2);
    await cap.stop();
  });

  test("maxRestarts: 0 ends capture on the first exit with 'after 0 restarts'", async () => {
    const { cap, helpers, errors } = await capture({ maxRestarts: 0 });
    helpers[0].exit(2, null);
    await cap.done;
    expect(helpers).toHaveLength(1);
    expect(errors().map((e) => e.message)).toEqual(["the capture helper exited (code 2, signal null) after 0 restarts; ending live capture"]);
    expect(await all(cap.sources[0])).toEqual([]);
  });

  test("stop() during the restart delay ends the streams and never relaunches", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { cap, helpers, errors } = await capture({ restartDelayMs: 1000 });
    helpers[0].exit(1);
    await tick();
    expect(errors().map((e) => e.message)).toEqual(["the capture helper exited (code 1, signal null); restart 1 of 3 in 1000 ms"]);
    await cap.stop(); // the helper has exited: nothing to wait for
    expect(await all(cap.sources[0])).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(helpers).toHaveLength(1);
  });

  test("stop() sends SIGTERM after 2 s and SIGKILL after 5 s when the helper ignores stdin", async () => {
    class StubbornHelper extends FakeHelper {
      private allow = false;
      override kill(signal: NodeJS.Signals = "SIGTERM") {
        this.killed.push(signal);
        if (signal === "SIGKILL") { this.allow = true; this.exit(null, signal); }
        return true;
      }
      override exit(code: number | null, signal: NodeJS.Signals | null = null) { if (this.allow) super.exit(code, signal); }
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { cap, helpers } = await capture({}, () => new StubbornHelper());
    let stopped = false;
    const p = cap.stop().then(() => { stopped = true; });
    expect(helpers[0].stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(helpers[0].killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers[0].killed).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(helpers[0].killed).toEqual(["SIGTERM"]);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(helpers[0].killed).toEqual(["SIGTERM", "SIGKILL"]);
    await tick();
    await p;
    expect(stopped).toBe(true);
  });

  test("stop() twice resolves both and closes stdin once", async () => {
    const { cap, helpers } = await capture();
    const end = vi.spyOn(helpers[0].stdin, "end");
    await Promise.all([cap.stop(), cap.stop()]);
    expect(end).toHaveBeenCalledTimes(1);
    await cap.stop();
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("stop() after the helper already exited for good resolves at once", async () => {
    const { cap, helpers } = await capture({ maxRestarts: 0 });
    helpers[0].exit(0);
    await cap.done;
    const end = vi.spyOn(helpers[0].stdin, "end");
    await cap.stop();
    expect(end).not.toHaveBeenCalled();
  });

  it.fails("BUG A2-L6: stop() after a helper killed by a signal does not wait for the restart delay", async () => {
    // a real ChildProcess killed by a signal keeps exitCode null (it sets signalCode), and it exits only once
    class SignalledHelper extends FakeHelper {
      private gone = false;
      override exit(code: number | null, signal: NodeJS.Signals | null = null) {
        if (this.gone) return;
        this.gone = true;
        setImmediate(() => this.emit("exit", code, signal));
      }
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { cap, helpers } = await capture({ restartDelayMs: 1000 }, () => new SignalledHelper());
    helpers[0].exit(null, "SIGSEGV");
    await tick();
    expect(helpers[0].exitCode).toBeNull();
    let stopped = false;
    const p = cap.stop().then(() => { stopped = true; });
    for (let i = 0; i < 5; i++) await tick();
    const early = stopped;
    await vi.advanceTimersByTimeAsync(1000); // today only the restart timer ends it
    await p;
    expect(early).toBe(true);
  });

  it.fails("BUG A2-L5: a malformed frame is reported once, even when more output arrives before the helper exits", async () => {
    const { cap, helpers, errors } = await capture();
    helpers[0].started(0);
    helpers[0].stdout.write(Buffer.from("garbage-garbage-garbage"));
    helpers[0].stdout.write(Buffer.from("more output before the exit"));
    await new Promise((r) => setTimeout(r, 30));
    await cap.stop();
    expect(errors().filter((e) => /malformed/.test(String(e.message)))).toHaveLength(1); // today 2, with two SIGKILLs
  });

  it.fails("BUG A2-L3: a spawn error ('error' event on the child) is reported, not thrown", async () => {
    const { cap, helpers, errors } = await capture();
    // a real ChildProcess emits 'error' for EACCES, or a binary deleted after the existsSync check; with no listener,
    // EventEmitter throws it, which crashes the engine
    expect(() => helpers[0].emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }))).not.toThrow();
    await cap.stop();
    expect(errors().length).toBeGreaterThan(0);
  });

  test("sessionStartEpochMs defaults to Date.now()", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { cap, helpers } = await capture({ sessionStartEpochMs: undefined });
    vi.useRealTimers();
    helpers[0].started(1_000_300);
    helpers[0].stdout.write(frameBytes(0, 0, ramp(512)));
    const [f] = await take(cap.sources[0], 1);
    expect(f.sessionMs).toBe(300);
    await cap.stop();
  });

  test("the default spawn runs a real executable, with the API keys stripped from its environment", async () => {
    const bin = shellBin(tmpDir("capture-"), [
      `echo '{"type":"started","epochMs":0}' >&2`,
      `echo "{\\"type\\":\\"warning\\",\\"message\\":\\"key=$OPENAI_API_KEY$OPENROUTER_API_KEY\\"}" >&2`,
      "cat > /dev/null", // runs until stdin closes, like the helper
    ].join("\n"));
    setAppPaths({ helper: bin });
    await withEnv({ OPENAI_API_KEY: "sk-test-should-not-leak", OPENROUTER_API_KEY: "sk-or-should-not-leak" }, async () => {
      const events: Record<string, unknown>[] = [];
      const cap = await startNativeCapture({ onStatus: (type, data) => events.push({ type, ...data }) });
      for (let i = 0; i < 200 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      expect(events).toEqual([
        { type: "health", capture: { type: "started", epochMs: 0 } },
        { type: "error", component: "capture", message: "key=", level: "warning" },
      ]);
      await cap.stop(); // closing stdin ends `cat`, so the script exits
      await cap.done;
    });
  });
});

describe("listDevices", () => {
  afterEach(() => { setAppPaths(); cleanTmpDirs(); });

  test("rejects when the bin is missing", async () => {
    await expect(listDevices("/nonexistent/tattle-capture")).rejects.toThrow(/not built/);
    setAppPaths({ helper: "/nonexistent/default" });
    await expect(listDevices()).rejects.toThrow(/not built/);
  });

  test("resolves the JSON lines a fake helper prints", async () => {
    const bin = shellBin(tmpDir("devices-"), [
      `[ "$1" = "--list-devices" ] || exit 9`,
      `echo '{"id":"a","name":"MacBook Air Microphone"}'`,
      "echo",
      `echo '{"id":"b","name":"USB Mic"}'`,
    ].join("\n"));
    expect(await listDevices(bin)).toEqual([{ id: "a", name: "MacBook Air Microphone" }, { id: "b", name: "USB Mic" }]);
  });

  test("rejects with the exit code on a non-zero exit", async () => {
    await expect(listDevices(shellBin(tmpDir("devices-"), "exit 3"))).rejects.toThrow(/exited with 3/);
  });
});
