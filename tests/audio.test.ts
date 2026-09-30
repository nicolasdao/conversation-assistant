import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import sherpa from "sherpa-onnx-node";
import { loadConfig } from "../src/config.ts";
import { LiveStream } from "../src/audio/nativeSource.ts";
import { FileSource, mergeSources, type AudioSource } from "../src/audio/source.ts";
import { LoudTagger, overlaps, rmsDbfs } from "../src/audio/tags.ts";
import { StreamVad, UtteranceIds, type Utterance } from "../src/audio/vad.ts";
import { encodeWav, readWav16k, toPcm16, wavHeader, WavWriter } from "../src/audio/wav.ts";
import { FIXTURE_DIR, loadScript, requireAssets } from "./helpers.ts";
import { cleanTmpDirs, constant, tmpDir, wavFile } from "./fakes/index.ts";
import { ArraySource, framesAt } from "./fakes/audio.ts";

const cfg = loadConfig();

async function runVad(sources: AudioSource[]): Promise<Utterance[]> {
  const ids = new UtteranceIds();
  const vads = { host: new StreamVad("host", cfg.app.vad, ids), remote: new StreamVad("remote", cfg.app.vad, ids) };
  const out: Utterance[] = [];
  for await (const f of mergeSources(sources, (s) => out.push(...vads[s].flush()))) out.push(...vads[f.stream].accept(f.samples, f.sessionMs));
  return out;
}

describe("wav", () => {
  test("encodeWav round-trips through sherpa.readWave", () => {
    const dir = mkdtempSync(join(tmpdir(), "wav-"));
    const samples = new Float32Array(1600).map((_, i) => Math.sin(i / 10) * 0.5);
    const path = join(dir, "a.wav");
    const w = new WavWriter(path);
    w.write(samples.subarray(0, 700));
    w.write(samples.subarray(700));
    w.close();
    const back = sherpa.readWave(path);
    expect(back.sampleRate).toBe(16000);
    expect(back.samples.length).toBe(1600);
    expect(Math.abs(back.samples[100] - samples[100])).toBeLessThan(1e-3);
    expect(readFileSync(path).equals(encodeWav(samples))).toBe(true);
  });
});

describe("tags", () => {
  test("loud is 6 dB above the stream's median", () => {
    const t = new LoudTagger();
    const quiet = new Float32Array(1000).fill(0.05);
    for (let i = 0; i < 5; i++) expect(t.tag("host", quiet)).toBe(false);
    expect(t.tag("host", new Float32Array(1000).fill(0.2))).toBe(true);
    expect(t.tag("remote", new Float32Array(1000).fill(0.2))).toBe(false);
    expect(rmsDbfs(new Float32Array(10).fill(1))).toBeCloseTo(0);
  });

  test("overlap needs ≥ 1000 ms on the other stream", () => {
    const u = { stream: "host" as const, startMs: 0, endMs: 3000 };
    expect(overlaps(u, [{ stream: "remote", startMs: 2000, endMs: 5000 }])).toBe(true);
    expect(overlaps(u, [{ stream: "remote", startMs: 2500, endMs: 5000 }])).toBe(false);
    expect(overlaps(u, [{ stream: "host", startMs: 0, endMs: 5000 }])).toBe(false);
  });
});

describe("VAD on the fixture", () => {
  test("boundaries within ±400 ms for ≥ 90% of lines, none longer than 20 s", async () => {
    requireAssets();
    const script = loadScript();
    const utts = await runVad([
      new FileSource(`${FIXTURE_DIR}/host.wav`, "host", "max"),
      new FileSource(`${FIXTURE_DIR}/remote.wav`, "remote", "max"),
    ]);
    const matched = script.lines.filter((l) =>
      utts.some((u) => u.stream === l.stream && Math.abs(u.startMs - l.startMs) <= 400 && Math.abs(u.endMs - l.endMs) <= 400));
    expect(matched.length / script.lines.length).toBeGreaterThanOrEqual(0.9);
    for (const u of utts) expect(u.endMs - u.startMs).toBeLessThanOrEqual(20_000);
    // one session-wide counter
    expect(new Set(utts.map((u) => u.id)).size).toBe(utts.length);
    expect(utts.map((u) => u.id).sort()).toEqual(utts.map((_, i) => `u_${i + 1}`).sort());
  });

  test("a single stream is enough", async () => {
    requireAssets();
    const utts = await runVad([new FileSource(`${FIXTURE_DIR}/host.wav`, "host", "max")]);
    expect(utts.every((u) => u.stream === "host")).toBe(true);
    expect(utts.length).toBeGreaterThan(0);
  });

  test("speed 1 pacing within 5% of wall-clock over 10 s", async () => {
    requireAssets();
    // on a fake clock (setTimeout and performance), so it takes milliseconds, not 10 s of real time
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const src = new FileSource(`${FIXTURE_DIR}/host.wav`, "host", 1);
      const t0 = performance.now();
      const done = (async () => { for await (const f of src.frames()) if (f.sessionMs >= 10_000) break; return performance.now(); })();
      await vi.advanceTimersByTimeAsync(11_000);
      const elapsed = (await done) - t0;
      expect(Math.abs(elapsed - 10_000) / 10_000).toBeLessThan(0.05);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- source.ts: FileSource and mergeSources ----------

describe("FileSource", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanTmpDirs(); });
  const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => ((i % 100) + 1) / 200);
  const collect = async (src: FileSource) => { const out = []; for await (const f of src.frames()) out.push(f); return out; };

  test("yields ceil(n/512) frames with sessionMs = i*32 for a synthetic 1000-sample WAV", async () => {
    const frames = await collect(new FileSource(wavFile(tmpDir("src-"), ramp(1000)), "host", "max"));
    expect(frames.map((f) => f.sessionMs)).toEqual([0, 32]);
    expect(frames[0].samples[5]).toBeCloseTo(6 / 200, 3);
  });

  test("zero-pads the final frame to 512 samples", async () => {
    const frames = await collect(new FileSource(wavFile(tmpDir("src-"), constant(0.5, 600)), "remote", "max"));
    expect(frames.length).toBe(2);
    expect(frames[1].samples.length).toBe(512);
    expect(frames[1].samples[87]).toBeCloseTo(0.5, 3);
    expect(frames[1].samples.subarray(88).every((v) => v === 0)).toBe(true);
  });

  test("on an empty WAV yields no frames", async () => {
    expect(await collect(new FileSource(wavFile(tmpDir("src-"), new Float32Array(0)), "host", "max"))).toEqual([]);
  });

  test("resamples a 48 kHz and an 8 kHz WAV to 16 kHz", async () => {
    const dir = tmpDir("src-");
    const at48 = await collect(new FileSource(wavFile(dir, constant(0.3, 48_000), "a48.wav", 48_000), "host", "max"));
    expect(at48.length).toBe(Math.ceil(16_000 / 512)); // one second either way
    const at8 = await collect(new FileSource(wavFile(dir, constant(0.3, 8_000), "a8.wav", 8_000), "host", "max"));
    expect(at8.length).toBe(Math.ceil(16_000 / 512));
  });

  test("speed 1 does not yield frame k before k*32 ms (fake timers, injected now)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const src = new FileSource(wavFile(tmpDir("src-"), constant(0.1, 16_000)), "host", 1, () => Date.now());
    const t0 = Date.now();
    const seen: [number, number][] = [];
    const done = (async () => { for await (const f of src.frames()) seen.push([f.sessionMs, Date.now() - t0]); })();
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(seen.length).toBe(32);
    for (const [ms, at] of seen) expect(at).toBeGreaterThanOrEqual(ms);
    expect(seen.at(-1)![1]).toBeLessThan(seen.at(-1)![0] + 32); // and not a frame late either
  });

  test("speed 1 skips waits of 1 ms or less, and sleeps for anything longer", async () => {
    const path = wavFile(tmpDir("src-"), constant(0.1, 2048)); // 4 frames, at 0, 32, 64 and 96 ms
    const spy = vi.spyOn(globalThis, "setTimeout");
    const sleeps = () => spy.mock.calls.filter((c) => typeof c[1] === "number" && c[1] > 0 && c[1] <= 2).length;
    // the first now() is t0; every frame's now() is `early` ms before its time
    const clock = (early: number) => { let calls = 0; return () => (calls++ === 0 ? 0 : 32 * (calls - 2) - early); };
    await collect(new FileSource(path, "host", 1, clock(1))); // exactly 1 ms early: never worth a sleep
    expect(sleeps()).toBe(0);
    let late = 0;
    await collect(new FileSource(path, "host", 1, () => (late += 1000))); // a clock already late never sleeps
    expect(sleeps()).toBe(0);
    await collect(new FileSource(path, "host", 1, clock(2))); // 2 ms early: every frame sleeps
    expect(sleeps()).toBe(4);
  });

  test("speed max never sleeps", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    await collect(new FileSource(wavFile(tmpDir("src-"), constant(0.1, 4096)), "host", "max"));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("mergeSources", () => {
  const drain = async (it: AsyncIterable<{ stream: string; sessionMs: number }>) => { const out: [string, number][] = []; for await (const f of it) out.push([f.stream, f.sessionMs]); return out; };

  test("rejects on the first next() when given no source", async () => {
    const it = mergeSources([])[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow("at least one audio source");
  });

  test("interleaves two sources in sessionMs order, tagging each frame with its stream", async () => {
    const out = await drain(mergeSources([new ArraySource("host", framesAt([0, 64])), new ArraySource("remote", framesAt([32, 96]))]));
    expect(out).toEqual([["host", 0], ["remote", 32], ["host", 64], ["remote", 96]]);
  });

  test("breaks ties by array order", async () => {
    expect(await drain(mergeSources([new ArraySource("remote", framesAt([0])), new ArraySource("host", framesAt([0]))])))
      .toEqual([["remote", 0], ["host", 0]]);
    expect(await drain(mergeSources([new ArraySource("host", framesAt([0])), new ArraySource("remote", framesAt([0]))])))
      .toEqual([["host", 0], ["remote", 0]]);
  });

  test("calls onEnd at once for a source that yields nothing, before the first frame", async () => {
    const log: string[] = [];
    for await (const f of mergeSources([new ArraySource("host", framesAt([0, 32])), new ArraySource("remote", [])], (s) => log.push(`end ${s}`))) {
      log.push(`${f.stream} ${f.sessionMs}`);
    }
    expect(log).toEqual(["end remote", "host 0", "host 32", "end host"]);
  });

  test("calls onEnd once per source, in the order they end", async () => {
    const ends: string[] = [];
    await drain(mergeSources([new ArraySource("host", framesAt([0, 32, 64, 96])), new ArraySource("remote", framesAt([0, 32]))], (s) => ends.push(s)));
    expect(ends).toEqual(["remote", "host"]);
  });

  test("propagates a source's thrown error to the consumer", async () => {
    await expect(drain(mergeSources([new ArraySource("host", framesAt([0, 32, 64]), 2), new ArraySource("remote", framesAt([0, 32, 64]))])))
      .rejects.toThrow("source host failed");
  });

  test("with a stalled source it waits: no frame of the other source is emitted past the stall", async () => {
    const stalled = new LiveStream("remote");
    const it = mergeSources([new ArraySource("host", framesAt([0, 32])), stalled])[Symbol.asyncIterator]();
    const first = it.next();
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), 30));
    expect(await Promise.race([first, timeout])).toBe("timeout");
    stalled.push(new Int16Array(512), 16);
    expect((await first).value).toMatchObject({ stream: "host", sessionMs: 0 });
    expect((await it.next()).value).toMatchObject({ stream: "remote", sessionMs: 16 });
    stalled.end();
    expect((await it.next()).value).toMatchObject({ stream: "host", sessionMs: 32 });
    expect((await it.next()).done).toBe(true);
  });
});

// ---------- wav.ts ----------

describe("wav details", () => {
  afterEach(() => cleanTmpDirs());

  test("wavHeader writes RIFF size 36+data, fmt 16, PCM 1, mono, rate, byteRate 2*rate, align 2, 16 bits, data size", () => {
    const h = wavHeader(1000, 22_050);
    expect(h.length).toBe(44);
    expect(h.toString("ascii", 0, 4)).toBe("RIFF");
    expect(h.readUInt32LE(4)).toBe(1036);
    expect(h.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect([h.readUInt32LE(16), h.readUInt16LE(20), h.readUInt16LE(22)]).toEqual([16, 1, 1]);
    expect([h.readUInt32LE(24), h.readUInt32LE(28), h.readUInt16LE(32), h.readUInt16LE(34)]).toEqual([22_050, 44_100, 2, 16]);
    expect(h.toString("ascii", 36, 40)).toBe("data");
    expect(h.readUInt32LE(40)).toBe(1000);
  });

  test("toPcm16 clamps 1.5→32767, -1.5→-32768, 1→32767, -1→-32768, 0→0", () => {
    const b = toPcm16(Float32Array.from([1.5, -1.5, 1, -1, 0]));
    expect([0, 1, 2, 3, 4].map((i) => b.readInt16LE(i * 2))).toEqual([32767, -32768, 32767, -32768, 0]);
  });

  test("toPcm16 rounds to the nearest step, with 32767 steps up and 32768 down", () => {
    const b = toPcm16(Float32Array.from([1.4 / 32767, 1.6 / 32767, -1.4 / 32768, -1.6 / 32768, 0.5]));
    expect([0, 1, 2, 3, 4].map((i) => b.readInt16LE(i * 2))).toEqual([1, 2, -1, -2, 16384]);
  });

  test("encodeWav(samples, 8000) writes rate 8000 in the header", () => {
    const w = encodeWav(new Float32Array(10), 8000);
    expect(w.readUInt32LE(24)).toBe(8000);
    expect(w.readUInt32LE(40)).toBe(20);
    expect(w.length).toBe(64);
  });

  test("WavWriter counts samples across writes, and reads 0 data bytes until close", () => {
    const path = join(tmpDir("wav-"), "w.wav");
    const w = new WavWriter(path);
    w.write(new Float32Array(100));
    w.write(new Float32Array(28));
    expect(w.samplesWritten).toBe(128);
    const before = readFileSync(path);
    expect(before.length).toBe(44 + 256);
    expect(before.readUInt32LE(40)).toBe(0); // sizes unset while recording
    expect(before.readUInt32LE(4)).toBe(36);
    w.close();
    expect(readFileSync(path).readUInt32LE(40)).toBe(256);
  });

  test("WavWriter.write after close is a no-op and close is idempotent", () => {
    const path = join(tmpDir("wav-"), "w.wav");
    const w = new WavWriter(path, 8000);
    w.write(new Float32Array(10).fill(0.5));
    w.close();
    const size = statSync(path).size;
    w.write(new Float32Array(1000));
    w.close();
    expect(statSync(path).size).toBe(size);
    expect(w.samplesWritten).toBe(10);
    expect(readFileSync(path).readUInt32LE(24)).toBe(8000);
  });

  test("readWav16k returns 16 kHz samples unchanged", () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.round(Math.sin(i / 7) * 16000) / 32767);
    const back = readWav16k(wavFile(tmpDir("wav-"), samples));
    expect(back.length).toBe(1000);
    for (let i = 0; i < 1000; i += 37) expect(back[i]).toBeCloseTo(samples[i], 4);
  });

  test("readWav16k resamples 48 kHz to about n/3 samples", () => {
    const back = readWav16k(wavFile(tmpDir("wav-"), constant(0.25, 48_000), "a.wav", 48_000));
    expect(Math.abs(back.length - 16_000)).toBeLessThanOrEqual(2);
    expect(back[8000]).toBeCloseTo(0.25, 2);
  });
});

// ---------- tags.ts ----------

describe("tags details", () => {
  test("rmsDbfs of [] and of zeros is -Infinity; of a 0.5 constant about -6.02", () => {
    expect(rmsDbfs(new Float32Array(0))).toBe(-Infinity);
    expect(rmsDbfs(new Float32Array(100))).toBe(-Infinity);
    expect(rmsDbfs(constant(0.5, 100))).toBeCloseTo(-6.0206, 3);
    expect(rmsDbfs(constant(-0.5, 100))).toBeCloseTo(-6.0206, 3);
  });

  test("the first utterance on a stream is never loud", () => {
    expect(new LoudTagger().tag("host", constant(1, 100))).toBe(false);
  });

  test("a hair over +6 dB above the median is loud, a hair under is not", () => {
    const over = new LoudTagger();
    over.tag("host", constant(0.1, 100));
    expect(over.tag("host", constant(0.1996, 100))).toBe(true); // +6.003 dB
    const under = new LoudTagger();
    under.tag("host", constant(0.1, 100));
    expect(under.tag("host", constant(0.1994, 100))).toBe(false); // +5.994 dB
  });

  test("a silent utterance is never loud and is not added to the history", () => {
    const t = new LoudTagger();
    expect(t.tag("host", new Float32Array(100))).toBe(false);
    // had silence (−Infinity) entered the history, this would be loud against its median
    expect(t.tag("host", constant(0.1, 100))).toBe(false);
    expect(t.tag("host", new Float32Array(100))).toBe(false);
    // the median is still 0.1's level: −20 dBFS
    expect(t.tag("host", constant(0.21, 100))).toBe(true);
  });

  test("the median over an even count averages the middle two", () => {
    // history [−20, −7.96]: the average is −13.98, so the bar is −7.98 dBFS
    const mk = () => { const t = new LoudTagger(); t.tag("host", constant(0.1, 100)); t.tag("host", constant(0.4, 100)); return t; };
    expect(mk().tag("host", constant(0.316, 100))).toBe(false); // −10 dBFS: loud only against the lower middle (−14)
    expect(mk().tag("host", constant(0.45, 100))).toBe(true); // −6.9 dBFS: not loud against the upper middle (−1.96)
  });

  test("the history keeps only the last 50 utterances", () => {
    const t = new LoudTagger();
    for (let i = 0; i < 50; i++) t.tag("host", constant(0.01, 100)); // −40 dBFS
    for (let i = 0; i < 50; i++) t.tag("host", constant(0.1, 100)); // −20 dBFS: the −40s are gone
    // against all 100, the median would be −30 and −16.5 dBFS loud; against the last 50 (−20) it is not
    expect(t.tag("host", constant(0.15, 100))).toBe(false);
    // and 50 loud ones then a quiet one: the quiet one is not loud
    const u = new LoudTagger();
    for (let i = 0; i < 50; i++) u.tag("remote", constant(0.5, 100));
    expect(u.tag("remote", constant(0.05, 100))).toBe(false);
  });

  test("overlaps honours a custom minMs and is inclusive at exactly minMs", () => {
    const u = { stream: "host" as const, startMs: 0, endMs: 3000 };
    const o = [{ stream: "remote" as const, startMs: 2500, endMs: 5000 }]; // 500 ms together
    expect(overlaps(u, o, 500)).toBe(true);
    expect(overlaps(u, o, 501)).toBe(false);
    expect(overlaps(u, [{ stream: "remote", startMs: 2000, endMs: 5000 }])).toBe(true); // exactly the default 1000
  });

  test("overlaps with no others is false", () => {
    expect(overlaps({ stream: "host", startMs: 0, endMs: 9000 }, [])).toBe(false);
  });
});
