// Playback of a recording: host.wav and remote.wav mixed on the fly into one 16 kHz mono WAV, served with HTTP Range
// support so the page's <audio> element can seek. Both files share the session clock (sample index ÷ 16 = session
// ms), so byte offsets in the mix map straight onto the timeline.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { SAMPLE_RATE, wavHeader } from "../audio/wav.ts";

const HEADER = 44;
const CHUNK = 64 * 1024; // bytes of PCM per read, per stream

/**
 * Loudness. Recorded speech sits around −24 to −28 dBFS (the loud 5 % of 100 ms blocks), well under a typical
 * podcast, so playback boosts each stream to a common speech level: louder, and the host's mic balanced against the
 * call. Heard on laptop speakers: −14 dBFS was slightly too quiet and −10 sounded saturated (its speech peaks reached
 * the limiter, which then started at 0.6 and reshaped ordinary peaks), hence −12. Only the loudest peaks, above
 * LIMIT_START, are bent smoothly under full scale instead of clipping.
 */
const TARGET_DBFS = -12;
const MAX_GAIN = 10; // +20 dB: enough for a quiet mic, without turning noise into a roar
const LIMIT_START = 0.85;

const gains = new Map<string, number>();

/** The playback gain for one stream: from the level of its loud speech, sampled every 2 s; cached per file state. */
export function streamGain(path: string): number {
  const st = statSync(path);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  const hit = gains.get(key);
  if (hit !== undefined) return hit;
  const fd = openSync(path, "r");
  const rms: number[] = [];
  try {
    const samples = Math.floor((st.size - HEADER) / 2);
    const block = Buffer.alloc(1600 * 2); // 100 ms
    for (let at = 0; at + 1600 <= samples; at += SAMPLE_RATE * 2) {
      const n = readSync(fd, block, 0, block.length, HEADER + at * 2);
      let sum = 0;
      for (let i = 0; i + 1 < n; i += 2) { const v = block.readInt16LE(i) / 32768; sum += v * v; }
      rms.push(Math.sqrt(sum / Math.max(1, n / 2)));
    }
  } finally {
    closeSync(fd);
  }
  rms.sort((a, b) => a - b);
  const speech = rms[Math.floor(rms.length * 0.95)] ?? 0;
  const gain = speech > 0 ? Math.min(MAX_GAIN, Math.max(1, 10 ** (TARGET_DBFS / 20) / speech)) : 1;
  gains.set(key, gain);
  return gain;
}

/** Leaves the signal alone up to LIMIT_START, then bends it smoothly towards full scale: no hard clipping. */
export function limit(x: number): number {
  const a = Math.abs(x);
  if (a <= LIMIT_START) return x;
  const room = 1 - LIMIT_START;
  return Math.sign(x) * (LIMIT_START + room * Math.tanh((a - LIMIT_START) / room));
}

/** Serves the mixed, loudness-matched audio of a session folder; 404 when it has no audio. */
export function serveMixedAudio(dir: string, req: IncomingMessage, res: ServerResponse): void {
  const files = ["host.wav", "remote.wav"].map((f) => join(dir, f)).filter((p) => existsSync(p));
  if (files.length === 0) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "this recording has no audio" }));
    return;
  }
  // a file still being written may have an unpatched header, so sizes come from the files themselves
  const dataBytes = Math.max(...files.map((p) => Math.max(0, statSync(p).size - HEADER))) & ~1;
  const header = wavHeader(dataBytes, SAMPLE_RATE);
  const total = HEADER + dataBytes;

  let start = 0;
  let end = total - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range) {
    if (range[1] === "" && range[2] !== "") { start = Math.max(0, total - Number(range[2])); }
    else { start = Number(range[1] || 0); if (range[2] !== "") end = Math.min(total - 1, Number(range[2])); }
    if (start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
  }
  res.writeHead(range ? 206 : 200, {
    "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Cache-Control": "no-cache",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
  });
  if (req.method === "HEAD") { res.end(); return; }

  const fds = files.map((p) => openSync(p, "r"));
  const gain = files.map((p) => streamGain(p));
  let pos = start;
  const close = () => { for (const fd of fds) try { closeSync(fd); } catch { /* already closed */ } };
  res.on("close", close);
  const pump = () => {
    while (pos <= end) {
      let out: Buffer;
      if (pos < HEADER) {
        out = header.subarray(pos, Math.min(HEADER, end + 1));
      } else {
        // mix whole samples: read from an even data offset, then trim to the requested bytes
        const dataPos = (pos - HEADER) & ~1;
        const want = Math.min(CHUNK, end + 1 - HEADER - dataPos + 1) & ~1 || 2;
        const sum = new Float32Array(want / 2);
        const buf = Buffer.alloc(want);
        fds.forEach((fd, f) => {
          const n = readSync(fd, buf, 0, want, HEADER + dataPos);
          for (let i = 0; i + 1 < n; i += 2) sum[i / 2]! += (buf.readInt16LE(i) / 32768) * gain[f]!;
        });
        const mix = Buffer.alloc(want);
        for (let k = 0; k < sum.length; k++) mix.writeInt16LE(Math.round(limit(sum[k]!) * 32767), k * 2);
        const skip = pos - HEADER - dataPos;
        out = mix.subarray(skip, Math.min(want, end + 1 - HEADER - dataPos));
      }
      if (out.length === 0) break;
      pos += out.length;
      if (!res.write(out)) { res.once("drain", pump); return; }
    }
    res.end();
  };
  pump();
}
