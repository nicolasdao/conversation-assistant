import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import sherpa from "sherpa-onnx-node";
import { loadConfig } from "../src/config.ts";
import { FileSource, mergeSources, type AudioSource } from "../src/audio/source.ts";
import { LoudTagger, overlaps, rmsDbfs } from "../src/audio/tags.ts";
import { StreamVad, UtteranceIds, type Utterance } from "../src/audio/vad.ts";
import { encodeWav, WavWriter } from "../src/audio/wav.ts";
import { FIXTURE_DIR, loadScript, requireAssets } from "./helpers.ts";

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
    const src = new FileSource(`${FIXTURE_DIR}/host.wav`, "host", 1);
    const t0 = performance.now();
    for await (const f of src.frames()) if (f.sessionMs >= 10_000) break;
    const elapsed = performance.now() - t0;
    expect(Math.abs(elapsed - 10_000) / 10_000).toBeLessThan(0.05);
  });
});
