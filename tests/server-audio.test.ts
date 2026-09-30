import { utimesSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { limit, serveMixedAudio, streamGain } from "../src/server/audio.ts";
import { wavHeader } from "../src/audio/wav.ts";
import { cleanTmpDirs, tmpDir } from "./fakes/index.ts";
import { http, listen } from "./fakes/http.ts";

// Playback of a recording (src/server/audio.ts): the two streams mixed into one seekable WAV, each raised to a common
// speech level and summed under a soft limiter.

/** A WAV of these 16-bit samples, as the app writes them. */
function wav(samples: ArrayLike<number>): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i], i * 2);
  return Buffer.concat([wavHeader(pcm.length, 16000), pcm]);
}

let dir = "";
let base = "";
let close: () => Promise<void>;
beforeAll(async () => {
  const server = createServer((req, res) => serveMixedAudio(join(dir, req.url!.slice(1)), req, res));
  ({ base, close } = await listen(server));
});
afterAll(async () => { await close(); cleanTmpDirs(); });

/** A recording folder with the given WAVs; returns the URL path that serves it. */
function folder(files: Record<string, Buffer>): string {
  dir = tmpDir("audio-");
  for (const [f, b] of Object.entries(files)) writeFileSync(join(dir, f), b);
  return "/";
}

const get = (range?: string, method = "GET") => http(base, method, "/", { headers: range ? { range } : {} });

describe("serveMixedAudio", () => {
  test("no WAV at all is a 404 with a JSON reason", async () => {
    folder({});
    const r = await get();
    expect([r.status, r.json]).toEqual([404, { error: "this recording has no audio" }]);
  });

  test("a recording with only the call's stream plays that stream", async () => {
    folder({ "remote.wav": wav([100, -200, 300]) });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(44 + 6);
    expect([0, 1, 2].map((i) => r.body.readInt16LE(44 + i * 2))).toEqual([100, -200, 300]);
  });

  test("HEAD answers the headers only, with the full length", async () => {
    folder({ "host.wav": wav([1, 2, 3, 4]) });
    const r = await get(undefined, "HEAD");
    expect(r.status).toBe(200);
    expect(r.headers["content-length"]).toBe("52");
    expect(r.headers["accept-ranges"]).toBe("bytes");
    expect(r.body.length).toBe(0);
  });

  test("ranges: a suffix, an open end, an end past the file, and the ones that cannot be served", async () => {
    folder({ "host.wav": wav([1, 2, 3, 4]) }); // 52 bytes
    const all = (await get()).body;
    const suffix = await get("bytes=-4");
    expect([suffix.status, suffix.headers["content-range"]]).toEqual([206, "bytes 48-51/52"]);
    expect(suffix.body).toEqual(all.subarray(48));
    const open = await get("bytes=50-");
    expect([open.headers["content-range"], open.body]).toEqual(["bytes 50-51/52", all.subarray(50)]);
    const clamped = await get("bytes=40-999");
    expect([clamped.status, clamped.headers["content-range"], clamped.body]).toEqual([206, "bytes 40-51/52", all.subarray(40)]);
    const header = await get("bytes=0-9");
    expect(header.body).toEqual(all.subarray(0, 10));
    const across = await get("bytes=40-45"); // the header's end and the first sample
    expect(across.body).toEqual(all.subarray(40, 46));
    for (const r of ["bytes=10-5", "bytes=-0", "bytes=52-"]) {
      const bad = await get(r);
      expect([r, bad.status, bad.headers["content-range"]]).toEqual([r, 416, "bytes */52"]);
    }
    const empty = await get("bytes=-"); // neither end: the whole file, as a range
    expect([empty.status, empty.headers["content-range"], empty.body.length]).toEqual([206, "bytes 0-51/52", 52]);
    // several ranges, or a malformed one, are ignored: the whole file
    for (const r of ["bytes=0-1,4-5", "items=0-3", "bytes=a-b"]) {
      const full = await get(r);
      expect([r, full.status, full.body.length]).toEqual([r, 200, 52]);
    }
  });

  test("a WAV shorter than its header gives a header-only file", async () => {
    folder({ "host.wav": Buffer.from("RIFF") });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(44);
    expect(r.body.readUInt32LE(40)).toBe(0);
  });

  test("a long recording streams in chunks, with backpressure, and equals the mix computed in memory", async () => {
    const n = 16000 * 30; // 30 s: 960 KB per stream, many 64 KiB chunks
    const host = Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 7) * 3000));
    const remote = Int16Array.from({ length: n - 1000 }, (_, i) => Math.round(Math.sin(i / 11) * 2000));
    folder({ "host.wav": wav(host), "remote.wav": wav(remote) });
    const gh = streamGain(join(dir, "host.wav"));
    const gr = streamGain(join(dir, "remote.wav"));
    const expected = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      // summed in 32-bit floats, stream by stream, as the server does
      let v = Math.fround((host[i] / 32768) * gh);
      if (i < remote.length) v = Math.fround(v + (remote[i] / 32768) * gr);
      expected.writeInt16LE(Math.round(limit(v) * 32767), i * 2);
    }
    // a slow reader: the server's writes fill the socket and wait for it to drain
    const body = await new Promise<Buffer>((resolve, reject) => {
      const req = request(base + "/", (res) => {
        const chunks: Buffer[] = [];
        res.pause();
        setTimeout(() => { res.on("data", (c) => chunks.push(c)); res.resume(); }, 100);
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", reject);
      req.end();
    });
    expect(body.length).toBe(44 + n * 2);
    expect(body.subarray(44).equals(expected)).toBe(true);
    const mid = await get(`bytes=${44 + 200_001}-${44 + 400_000}`); // odd start, across chunks
    expect(mid.body.equals(expected.subarray(200_001, 400_001))).toBe(true);
  });

  test("a client that hangs up mid-stream does not break the server", async () => {
    folder({ "host.wav": wav(new Int16Array(16000 * 60)) });
    await new Promise<void>((resolve) => {
      const req = request(base + "/", (res) => { res.once("data", () => { req.destroy(); resolve(); }); });
      req.on("error", () => {});
      req.end();
    });
    expect((await get("bytes=0-3")).status).toBe(206); // still serving
  });
});

describe("loudness", () => {
  const sine = (dbfs: number, seconds = 6) =>
    Array.from({ length: 16000 * seconds }, (_, i) => Math.round(Math.sin(i / 8) * 32768 * 10 ** (dbfs / 20) * Math.SQRT2));

  test("a very quiet stream is raised by at most +20 dB; a silent or tiny one is left alone", () => {
    const d = tmpDir("gain-");
    writeFileSync(join(d, "whisper.wav"), wav(sine(-60)));
    expect(streamGain(join(d, "whisper.wav"))).toBe(10);
    writeFileSync(join(d, "silent.wav"), wav(new Array(16000 * 4).fill(0)));
    expect(streamGain(join(d, "silent.wav"))).toBe(1);
    writeFileSync(join(d, "tiny.wav"), wav([1000, 2000]));
    expect(streamGain(join(d, "tiny.wav"))).toBe(1);
    writeFileSync(join(d, "loud.wav"), wav(sine(-6)));
    expect(streamGain(join(d, "loud.wav"))).toBe(1); // never turned down
  });

  test("the gain is cached per file state: a rewritten file is measured again", () => {
    const d = tmpDir("gain-");
    const p = join(d, "s.wav");
    writeFileSync(p, wav(sine(-30)));
    const quiet = streamGain(p);
    expect(20 * Math.log10(quiet)).toBeCloseTo(18, 0);
    expect(streamGain(p)).toBe(quiet);
    writeFileSync(p, wav(sine(-20)));
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    expect(20 * Math.log10(streamGain(p))).toBeCloseTo(8, 0);
  });

  test("the limiter is odd-symmetric, continuous at its knee, and stays under full scale", () => {
    for (const x of [0, 0.3, 0.85, 0.86, 1, 1.5, 3, 100]) expect(limit(-x)).toBeCloseTo(-limit(x), 12);
    expect(limit(0.85)).toBe(0.85);
    expect(limit(0.850001)).toBeCloseTo(0.850001, 5);
    expect(limit(100)).toBeLessThanOrEqual(1);
    expect(limit(1.2)).toBeGreaterThan(limit(1.1));
  });
});
