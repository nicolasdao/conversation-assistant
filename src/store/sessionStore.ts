import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamName } from "../audio/source.ts";
import { WavWriter } from "../audio/wav.ts";
import { appPaths } from "../paths.ts";

export const JSONL_FILES = [
  "utterances", "transcriptions", "jev_calls", "s2_calls", "segments", "labels", "claims", "verdicts", "s1_versions", "audits", "events",
] as const;
export type JsonlFile = (typeof JSONL_FILES)[number];

export function timestampId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** One folder per session: WAVs as received, session.json, append-only JSONL flushed on every write, speakers.json at the end. */
export class SessionStore {
  readonly id: string;
  readonly dir: string;
  private readonly wavs = new Map<StreamName, WavWriter>();
  private closed = false;

  constructor(opts: { root?: string; prefix?: string; streams?: StreamName[]; redact?: (s: string) => string } = {}) {
    const root = opts.root ?? appPaths().sessions;
    const base = `${opts.prefix ?? ""}${timestampId()}`;
    let id = base;
    for (let n = 2; existsSync(join(root, id)); n++) id = `${base}-${n}`;
    this.id = id;
    this.dir = join(root, id);
    mkdirSync(this.dir, { recursive: true });
    this.redact = opts.redact ?? ((s) => s);
    for (const f of JSONL_FILES) writeFileSync(join(this.dir, `${f}.jsonl`), "");
    for (const s of opts.streams ?? []) this.wavs.set(s, new WavWriter(join(this.dir, `${s}.wav`)));
  }

  private readonly redact: (s: string) => string;

  /** `afterClose` lets a host command made after the session ended (a speaker rename or merge) still reach the files. */
  append(file: JsonlFile, row: unknown, opts: { afterClose?: boolean } = {}): void {
    if (this.closed && !opts.afterClose) return;
    appendFileSync(join(this.dir, `${file}.jsonl`), this.redact(JSON.stringify(row)) + "\n");
  }

  writeAudio(stream: StreamName, samples: Float32Array): void {
    this.wavs.get(stream)?.write(samples);
  }

  writeJson(name: "session.json" | "speakers.json", value: unknown): void {
    writeFileSync(join(this.dir, name), this.redact(JSON.stringify(value, null, 2)) + "\n");
  }

  /** Writes the WAVs' final headers once input has ended, so they are complete however long the rest of the ending takes (or if the app quits during it). */
  closeAudio(): void {
    for (const w of this.wavs.values()) w.close();
  }

  close(): void {
    if (this.closed) return;
    this.closeAudio();
    this.closed = true;
  }
}
