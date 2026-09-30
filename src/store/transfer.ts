import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { JSONL_FILES, timestampId } from "./sessionStore.ts";
import { extractStoredEntry, readZipEntries, readZipEntry, writeZip, ZipError, type ZipInput } from "./zip.ts";
import { wavHeader } from "../audio/wav.ts";
import { childEnv } from "../keys.ts";

// Recordings leave and arrive as one file: `<name>.tattle`, a ZIP (see docs/recordings.md § Export and
// import). A custom extension rather than .zip, so a browser never unzips it on download and a chat app sends it as a
// document. Inside: manifest.json, the session's data files, and its audio (compressed AAC, the original WAVs, or none).

export const EXTENSION = ".tattle";
// the server never checks the extension; the page also accepts the extensions from before the renames
export const FORMAT = "tattle-recording";
/** The ids exports carried under the app's earlier names, Podcast Assistant and Conversation Assistant: still imported. */
const LEGACY_FORMATS = new Set(["podcast-assistant-recording", "conversation-assistant-recording"]);
export const FORMAT_VERSION = 1;

export type AudioChoice = "compressed" | "original" | "none";
/** AAC bitrate per stream: speech at 16 kHz stays clear, and an hour of show is about 30 MB. */
export const AAC_BITRATE = 32_000;

const execFileP = promisify(execFile);
const run = (bin: string, args: string[]) => execFileP(bin, args, { env: childEnv() });

/** Everything a recording folder holds besides audio; chats only when asked for. */
const DATA_FILES = ["session.json", "meta.json", "speakers.json", ...JSONL_FILES.map((f) => `${f}.jsonl`)];
const STREAMS = ["host", "remote"] as const;
// Imports come from other people, so every size in them is a claim to check. A two-hour show's data files weigh about
// 3 MB in all; these limits leave ample room while stopping a small file from filling the disk.
const MAX_DATA_BYTES = 256 * 1024 * 1024; // any one data file
const MAX_DATA_TOTAL = 512 * 1024 * 1024; // all data files together
const MAX_PAD_BYTES = 32_000; // silence added when decoded audio comes out short: 1 s at most
const MAX_AUDIO_BYTES = 4 * 1024 * 1024 * 1024 - 1;

export interface Manifest {
  format: typeof FORMAT;
  formatVersion: number;
  /** The app that exported the file. */
  app: { name: string; version: string };
  exportedAt: string;
  recording: {
    id: string; name: string | null; startedAt: string | null; durationMs: number; mode: string;
    /** The app version that recorded it; null for recordings from before versions were recorded. */
    recordedWith: string | null;
  };
  audio: { choice: AudioChoice; format: "aac" | "wav" | null; bitrate: number | null; streams: { stream: string; samples: number }[] };
  chats: boolean;
  files: string[];
}

export class TransferError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
/** PCM samples in one of the app's own WAVs (a 44-byte header, 16-bit mono). */
const samplesOf = (wav: string) => Math.max(0, Math.floor((statSync(wav).size - 44) / 2));

/** A file name for the export: the recording's name (or id), safe on every system. */
export function exportFileName(name: string | null, id: string): string {
  const base = (name ?? "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || `Recording ${id}`;
  return `${base}${EXTENSION}`;
}

/** What each audio choice would weigh, for the export window. */
export function exportEstimate(dir: string): { bytes: Record<AudioChoice, number>; chats: number; hasAudio: boolean } {
  const wavs = STREAMS.map((s) => join(dir, `${s}.wav`)).filter((p) => existsSync(p));
  const data = DATA_FILES.reduce((t, f) => t + (existsSync(join(dir, f)) ? statSync(join(dir, f)).size : 0), 0);
  const seconds = wavs.reduce((t, p) => t + samplesOf(p) / 16_000, 0);
  // JSON lines deflate to about a fifth
  const packed = Math.round(data / 5) + 4096;
  const chatsPath = join(dir, "chats.jsonl");
  const chats = existsSync(chatsPath)
    ? new Set(readFileSync(chatsPath, "utf8").split("\n").filter(Boolean).map((l) => { try { const r = JSON.parse(l); return r.kind === "chat" && r.op === "create" ? r.chat_id : null; } catch { return null; } }).filter(Boolean)).size
    : 0;
  return {
    bytes: {
      compressed: packed + Math.round((seconds * AAC_BITRATE) / 8 * 1.02),
      original: packed + wavs.reduce((t, p) => t + statSync(p).size, 0),
      none: packed,
    },
    chats, hasAudio: wavs.length > 0,
  };
}

/** Writes a recording to one `.tattle` file in `outDir`; returns its path. */
export async function exportRecording(
  dir: string, id: string, opts: { audio: AudioChoice; chats: boolean; app: { name: string; version: string }; outDir?: string },
): Promise<{ path: string; fileName: string; bytes: number }> {
  const session = readJson(join(dir, "session.json"));
  if (!session) throw new TransferError(404, `unknown session ${id}`);
  const meta = readJson(join(dir, "meta.json")) ?? {};
  const work = await mkdtemp(join(opts.outDir ?? tmpdir(), "pa-export-"));
  try {
    const entries: ZipInput[] = [];
    const files: string[] = [];
    for (const f of [...DATA_FILES, ...(opts.chats ? ["chats.jsonl"] : [])]) {
      const p = join(dir, f);
      if (!existsSync(p)) continue;
      entries.push({ name: `data/${f}`, data: f === "events.jsonl" ? withoutFolder(await readFile(p, "utf8")) : await readFile(p) });
      files.push(`data/${f}`);
    }
    const streams: Manifest["audio"]["streams"] = [];
    const wavs = STREAMS.filter((s) => existsSync(join(dir, `${s}.wav`)));
    for (const s of opts.audio === "none" ? [] : wavs) {
      const wav = join(dir, `${s}.wav`);
      streams.push({ stream: s, samples: samplesOf(wav) });
      if (opts.audio === "original") {
        entries.push({ name: `audio/${s}.wav`, path: wav });
        files.push(`audio/${s}.wav`);
      } else {
        const m4a = join(work, `${s}.m4a`);
        await run("afconvert", ["-f", "m4af", "-d", "aac", "-b", String(AAC_BITRATE), "-c", "1", wav, m4a]).catch((e) => {
          throw new TransferError(500, `could not compress the audio (afconvert): ${e instanceof Error ? e.message : String(e)}`);
        });
        entries.push({ name: `audio/${s}.m4a`, path: m4a });
        files.push(`audio/${s}.m4a`);
      }
    }
    const last = [...readFileSync(join(dir, "events.jsonl"), "utf8").matchAll(/"endMs":(\d+(?:\.\d+)?)/g)].pop();
    const durationMs = wavs.length ? Math.max(...wavs.map((s) => samplesOf(join(dir, `${s}.wav`)))) / 16 : Number(last?.[1] ?? 0);
    const manifest: Manifest = {
      format: FORMAT, formatVersion: FORMAT_VERSION, app: opts.app, exportedAt: new Date().toISOString(),
      recording: {
        id, name: meta.name ?? null, startedAt: session.startedAt ?? null, durationMs: Math.round(durationMs), mode: session.mode ?? "unknown",
        recordedWith: session.app?.version ?? null,
      },
      audio: {
        choice: opts.audio, format: opts.audio === "none" || !streams.length ? null : opts.audio === "original" ? "wav" : "aac",
        bitrate: opts.audio === "compressed" ? AAC_BITRATE : null, streams,
      },
      chats: opts.chats, files,
    };
    // the manifest comes first, so a reader can tell what the file is from its start
    entries.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") });
    const fileName = exportFileName(meta.name ?? null, id);
    const out = join(opts.outDir ?? tmpdir(), `pa-${id}-${Date.now()}${EXTENSION}`);
    const bytes = await writeZip(out, entries);
    return { path: out, fileName, bytes };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The events without the folder the recording was made in: in the Mac app it is under the exporter's home folder,
 * which names them, and the importer's own folder is filled in when the recording is opened (SessionLibrary.events).
 */
function withoutFolder(events: string): Buffer {
  return Buffer.from(events.split("\n").map((line) => {
    if (!line.includes('"dir":')) return line;
    const e = JSON.parse(line);
    if (e?.data && typeof e.data === "object") delete e.data.dir;
    return JSON.stringify(e);
  }).join("\n"));
}

/** Rewrites a WAV (afconvert's has extra chunks) as the app's own: a 44-byte header, 16 kHz mono PCM16, `samples` long. */
async function canonicalWav(src: string, dest: string, samples: number | null) {
  const fh = await open(src, "r");
  try {
    const head = Buffer.alloc(Math.min(65536, (await fh.stat()).size));
    await fh.read(head, 0, head.length, 0);
    let p = 12, dataAt = -1, dataLen = 0;
    while (p + 8 <= head.length) {
      const id = head.toString("ascii", p, p + 4), n = head.readUInt32LE(p + 4);
      if (id === "fmt ") {
        const channels = head.readUInt16LE(p + 10), rate = head.readUInt32LE(p + 12), bits = head.readUInt16LE(p + 22);
        if (channels !== 1 || rate !== 16_000 || bits !== 16) throw new TransferError(400, "unexpected audio format after decoding");
      }
      if (id === "data") { dataAt = p + 8; dataLen = n; break; }
      p += 8 + n + (n & 1);
    }
    if (dataAt < 0) throw new TransferError(400, "no audio data after decoding");
    // the manifest's sample count trims or pads (decoding can be a few samples short), but never adds more than 1 s of
    // silence: a crafted manifest could otherwise ask for gigabytes of it
    const want = samples === null ? dataLen : Math.min(samples * 2, dataLen + MAX_PAD_BYTES);
    const out = await open(dest, "w");
    try {
      await out.write(wavHeader(want, 16_000));
      const buf = Buffer.alloc(1 << 20);
      let done = 0;
      while (done < want) {
        const n = Math.min(buf.length, want - done);
        const avail = Math.max(0, Math.min(n, dataLen - done));
        if (avail > 0) await fh.read(buf, 0, avail, dataAt + done);
        buf.fill(0, avail, n); // pad with silence if decoding came out short
        await out.write(buf.subarray(0, n));
        done += n;
      }
    } finally { await out.close(); }
  } finally {
    await fh.close();
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Adds a `.tattle` file to the library as a new recording folder. Only known files are written; anything
 * else in the archive is ignored. Returns the new id, or throws 409 with the existing id when the same recording (same
 * id and start time) is already in the library — unless `copy` is set, which imports it again under a new id.
 */
export async function importRecording(
  file: string, root: string, originalName: string | null, opts: { copy?: boolean } = {},
): Promise<{ id: string; manifest: Manifest }> {
  let entries;
  try {
    entries = await readZipEntries(file);
  } catch (e) {
    throw new TransferError(400, e instanceof ZipError ? `${e.message}. Is it a ${EXTENSION} file?` : String(e));
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const mEntry = byName.get("manifest.json");
  if (!mEntry) throw new TransferError(400, `not a Tattle recording (no manifest.json). Is it a ${EXTENSION} file?`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse((await readZipEntry(file, mEntry, 1 << 20)).toString("utf8"));
  } catch {
    throw new TransferError(400, "the recording's manifest is damaged");
  }
  if (manifest?.format !== FORMAT && !LEGACY_FORMATS.has(manifest?.format)) throw new TransferError(400, "not a Tattle recording");
  if (!(manifest.formatVersion >= 1) || manifest.formatVersion > FORMAT_VERSION) {
    throw new TransferError(400, `this recording was exported by a newer Tattle (v${manifest.app?.version ?? "?"}): update the app to import it`);
  }
  if (!byName.has("data/session.json") || !byName.has("data/events.jsonl")) throw new TransferError(400, "the recording is incomplete (no session.json or events.jsonl)");

  const session = JSON.parse((await readZipEntry(file, byName.get("data/session.json")!, 1 << 24)).toString("utf8"));
  const baseId = SAFE_ID.test(manifest.recording?.id ?? "") ? manifest.recording.id : timestampId();
  // the same recording imported twice: point at the one already here
  const existing = join(root, baseId);
  if (!opts.copy && existsSync(join(existing, "session.json")) && readJson(join(existing, "session.json"))?.startedAt === session.startedAt) {
    throw Object.assign(new TransferError(409, "this recording is already in your library"), { id: baseId });
  }
  let id = baseId;
  for (let n = 2; existsSync(join(root, id)); n++) id = `${baseId}-${n}`;

  await mkdir(root, { recursive: true });
  // written to a hidden folder first, which the library ignores, then moved into place in one step
  const work = await mkdtemp(join(root, ".import-"));
  try {
    let budget = MAX_DATA_TOTAL;
    for (const f of [...DATA_FILES, "chats.jsonl"]) {
      const e = byName.get(`data/${f}`);
      if (!e) continue;
      if (e.size > budget) throw new TransferError(400, "the recording's data is too large");
      const data = await readZipEntry(file, e, Math.min(MAX_DATA_BYTES, budget));
      budget -= data.length;
      await writeFile(join(work, f), data);
    }
    // under a new id (a copy, or another recording's id taken), the recording names itself by it
    const recordedId = typeof session.id === "string" ? session.id : manifest.recording.id;
    if (id !== recordedId) {
      await writeFile(join(work, "session.json"), JSON.stringify({ ...session, id }, null, 2) + "\n");
      const events = join(work, "events.jsonl");
      const text = (await readFile(events, "utf8")).split(`"sessionId":${JSON.stringify(recordedId)}`).join(`"sessionId":${JSON.stringify(id)}`);
      await writeFile(events, text);
    }
    for (const f of JSONL_FILES) if (!existsSync(join(work, `${f}.jsonl`))) await writeFile(join(work, `${f}.jsonl`), "");
    for (const s of STREAMS) {
      const declared = manifest.audio?.streams?.find((x) => x.stream === s)?.samples;
      const samples = Number.isSafeInteger(declared) && (declared as number) >= 0 ? (declared as number) : null;
      const wav = byName.get(`audio/${s}.wav`);
      const m4a = byName.get(`audio/${s}.m4a`);
      if (wav) {
        if (wav.size > MAX_AUDIO_BYTES) throw new TransferError(400, "the audio is too large");
        await extractStoredEntry(file, wav, join(work, `${s}.orig.wav`));
        await canonicalWav(join(work, `${s}.orig.wav`), join(work, `${s}.wav`), samples);
        await rm(join(work, `${s}.orig.wav`));
      } else if (m4a) {
        await extractStoredEntry(file, m4a, join(work, `${s}.m4a`));
        await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", join(work, `${s}.m4a`), join(work, `${s}.decoded.wav`)]).catch((e) => {
          throw new TransferError(500, `could not decode the audio (afconvert): ${e instanceof Error ? e.message : String(e)}`);
        });
        await canonicalWav(join(work, `${s}.decoded.wav`), join(work, `${s}.wav`), samples);
        await rm(join(work, `${s}.m4a`));
        await rm(join(work, `${s}.decoded.wav`));
      }
    }
    // where it came from; the development budget skips folders that have this file (their spend was someone else's)
    await writeFile(join(work, "imported.json"), JSON.stringify({
      importedAt: new Date().toISOString(), fileName: originalName, originalId: manifest.recording.id, manifest,
    }, null, 2) + "\n");
    await rename(work, join(root, id));
    return { id, manifest };
  } catch (e) {
    await rm(work, { recursive: true, force: true });
    throw e;
  }
}

/** Saves an upload to a temporary file, refusing more than `maxBytes`. */
export async function saveUpload(body: AsyncIterable<Buffer>, maxBytes: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pa-import-"));
  const path = join(dir, `upload${EXTENSION}`);
  const fh = await open(path, "w");
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > maxBytes) throw new TransferError(413, "the file is too large (4 GB at most)");
      await fh.write(chunk);
    }
  } catch (e) {
    await fh.close();
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  await fh.close();
  return path;
}

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

/** Deletes a temporary file and its folder. */
export async function discard(path: string) {
  await rm(join(path, ".."), { recursive: true, force: true }).catch(() => {});
}

