import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEvent } from "./events.ts";

/** Folders written by tools, not recordings: hidden from the library unless asked for. */
const TOOL_PREFIXES = ["smoke-", "preflight-", "dev-"];
const COST_KINDS = new Set(["jev_call", "s2_call", "transcription", "live_transcription"]);

export interface SessionMeta { name?: string; notes?: string }

export interface SessionSummary {
  id: string;
  dir: string;
  name: string | null;
  notes: string | null;
  mode: "live" | "replay" | "unknown";
  startedAt: string | null;
  durationMs: number;
  streams: string[];
  ended: boolean;
  utterances: number;
  speakers: string[];
  segments: number;
  claims: number;
  costUsd: number;
  tool: boolean;
}

export interface SearchMatch { utteranceId: string; startMs: number; speaker: string; snippet: string }

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  const out: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line after a crash */ }
  }
  return out;
}

/** A recording's speakers from its events: current names, and merges (from → into). */
export interface RecordedSpeakers { names: Map<string, string>; mergedInto: Map<string, string> }

function foldSpeakers(events: AppEvent[]): RecordedSpeakers {
  const names = new Map<string, string>();
  const mergedInto = new Map<string, string>();
  for (const e of events) {
    const d = e.data as any;
    if (e.type === "speaker.created" || e.type === "speaker.updated") names.set(d.id, d.displayName);
    else if (e.type === "speaker.merged") mergedInto.set(d.fromId, d.intoId);
  }
  return { names, mergedInto };
}

/** Follows merges to the surviving speaker. */
export function resolveRecorded(sp: RecordedSpeakers, id: string): string {
  let cur = id;
  for (let i = 0; sp.mergedInto.has(cur) && i < 50; i++) cur = sp.mergedInto.get(cur)!;
  return cur;
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The recordings library: every session folder, with names, search, and read-only reopening (no API calls). */
export class SessionLibrary {
  private readonly cache = new Map<string, { mtimeMs: number; summary: SessionSummary; utterances: AppEvent[]; recorded: RecordedSpeakers }>();

  constructor(readonly root = "sessions") {}

  dirOf(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`invalid session id ${id}`);
    const dir = join(this.root, id);
    if (!existsSync(join(dir, "session.json"))) throw new Error(`unknown session ${id}`);
    return dir;
  }

  private load(id: string) {
    const dir = join(this.root, id);
    const eventsPath = join(dir, "events.jsonl");
    const metaPath = join(dir, "meta.json");
    const mtimeMs = Math.max(
      existsSync(eventsPath) ? statSync(eventsPath).mtimeMs : 0,
      existsSync(metaPath) ? statSync(metaPath).mtimeMs : 0,
      existsSync(join(dir, "speakers.json")) ? statSync(join(dir, "speakers.json")).mtimeMs : 0,
    );
    const hit = this.cache.get(id);
    if (hit && hit.mtimeMs === mtimeMs) return hit;

    const session = readJson(join(dir, "session.json")) ?? {};
    const meta: SessionMeta = readJson(metaPath) ?? {};
    const events = readJsonl(eventsPath) as AppEvent[];
    const recorded = foldSpeakers(events);
    let segments = 0;
    let claims = 0;
    let ended = false;
    const utterances: AppEvent[] = [];
    for (const e of events) {
      const d = e.data as any;
      if (e.type === "utterance") utterances.push(e);
      else if (e.type === "segment.closed") segments++;
      else if (e.type === "claim.flagged") claims++;
      else if (e.type === "session.ended") ended = true;
    }
    const speakersFile = readJson(join(dir, "speakers.json"));
    const speakers = Array.isArray(speakersFile)
      ? speakersFile.filter((s: any) => !s.mergedInto).map((s: any) => String(s.displayName))
      : [...recorded.names].filter(([id]) => !recorded.mergedInto.has(id)).map(([, n]) => n);
    let durationMs = 0;
    for (const s of ["host", "remote"]) {
      const p = join(dir, `${s}.wav`);
      if (existsSync(p)) durationMs = Math.max(durationMs, ((statSync(p).size - 44) / 32_000) * 1000);
    }
    let costUsd = 0;
    for (const f of ["jev_calls", "s2_calls", "transcriptions"]) {
      for (const r of readJsonl(join(dir, `${f}.jsonl`))) if (COST_KINDS.has(r.kind) && typeof r.cost_usd === "number") costUsd += r.cost_usd;
    }
    const summary: SessionSummary = {
      id, dir, name: meta.name?.trim() || null, notes: meta.notes?.trim() || null,
      mode: session.mode === "live" || session.mode === "replay" ? session.mode : "unknown",
      startedAt: session.startedAt ?? null, durationMs: Math.round(durationMs), streams: session.streams ?? [],
      ended, utterances: utterances.length, speakers, segments, claims, costUsd, tool: TOOL_PREFIXES.some((p) => id.startsWith(p)),
    };
    const entry = { mtimeMs, summary, utterances, recorded };
    this.cache.set(id, entry);
    return entry;
  }

  private ids(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((n) => SAFE_ID.test(n) && existsSync(join(this.root, n, "session.json")));
  }

  /** Newest first. `q` matches name, notes, id, speakers, and transcript text (case-insensitive, every word). */
  list(opts: { q?: string; includeTools?: boolean; limit?: number } = {}): (SessionSummary & { matches?: SearchMatch[] })[] {
    const words = (opts.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const out: (SessionSummary & { matches?: SearchMatch[] })[] = [];
    for (const id of this.ids()) {
      const { summary, utterances, recorded } = this.load(id);
      if (summary.tool && !opts.includeTools) continue;
      if (words.length === 0) {
        out.push(summary);
        continue;
      }
      const hay = [summary.name, summary.notes, summary.id, ...summary.speakers].filter(Boolean).join(" ").toLowerCase();
      const matches: SearchMatch[] = [];
      for (const e of utterances) {
        const d = e.data as any;
        const text = String(d.text ?? "");
        if (words.every((w) => text.toLowerCase().includes(w))) {
          const i = text.toLowerCase().indexOf(words[0]);
          const from = Math.max(0, i - 50);
          matches.push({
            // the speaker's current name: renames and merges made after the line was said apply
            utteranceId: d.id, startMs: d.startMs, speaker: recorded.names.get(resolveRecorded(recorded, d.speakerId)) ?? d.speakerName,
            snippet: `${from > 0 ? "…" : ""}${text.slice(from, i + 90)}${i + 90 < text.length ? "…" : ""}`,
          });
        }
      }
      const inMeta = words.every((w) => hay.includes(w));
      if (inMeta || matches.length > 0) out.push({ ...summary, matches: matches.slice(0, 5) });
    }
    out.sort((a, b) => (b.startedAt ?? b.id).localeCompare(a.startedAt ?? a.id));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  get(id: string): SessionSummary {
    this.dirOf(id);
    return this.load(id).summary;
  }

  /** Names and notes live in meta.json, beside the append-only session files, which are never edited. */
  update(id: string, patch: SessionMeta): SessionSummary {
    const dir = this.dirOf(id);
    const metaPath = join(dir, "meta.json");
    const meta: SessionMeta = readJson(metaPath) ?? {};
    for (const k of ["name", "notes"] as const) {
      if (patch[k] === undefined) continue;
      if (typeof patch[k] !== "string") throw new Error(`${k} must be a string`);
      const v = patch[k]!.trim();
      if (v.length > (k === "name" ? 120 : 4000)) throw new Error(`${k} is too long`);
      if (v) meta[k] = v;
      else delete meta[k];
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    this.cache.delete(id);
    return this.get(id);
  }

  /** The recorded event stream, for reopening a session exactly as it was, without calling any service. */
  events(id: string): AppEvent[] {
    return readJsonl(join(this.dirOf(id), "events.jsonl")) as AppEvent[];
  }

  /** The recording's speakers as they stand now, including renames and merges made after it was recorded. */
  speakers(id: string): RecordedSpeakers {
    this.dirOf(id);
    return this.load(id).recorded;
  }

  /**
   * Records a speaker rename or merge made on a reopened recording: the event is appended to events.jsonl (so reopening
   * shows it) and applied to speakers.json (so the library lists the new names).
   */
  recordSpeakerEdit(id: string, e: AppEvent): void {
    const dir = this.dirOf(id);
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(e) + "\n");
    const path = join(dir, "speakers.json");
    const list = readJson(path);
    if (Array.isArray(list)) {
      const d = e.data as any;
      const byId = new Map(list.map((s: any) => [s.id, s]));
      if (e.type === "speaker.updated" && byId.has(d.id)) byId.get(d.id).displayName = d.displayName;
      if (e.type === "speaker.merged" && byId.has(d.fromId) && byId.has(d.intoId)) {
        const from = byId.get(d.fromId);
        const into = byId.get(d.intoId);
        from.mergedInto = d.intoId;
        into.utterances = (into.utterances ?? 0) + (from.utterances ?? 0);
      }
      writeFileSync(path, JSON.stringify(list, null, 2) + "\n");
    }
    this.cache.delete(id);
  }

  /**
   * Deletes a recording's folder for good. Its spend is first appended to deleted-spend.jsonl beside the folders, so the
   * development budget (sumDevSpend) still counts it.
   */
  remove(id: string): void {
    const dir = this.dirOf(id);
    const summary = this.load(id).summary;
    if (summary.costUsd > 0) {
      appendFileSync(join(this.root, "deleted-spend.jsonl"),
        JSON.stringify({ kind: "deleted_session", session_id: id, deleted_at: new Date().toISOString(), cost_usd: summary.costUsd }) + "\n");
    }
    rmSync(dir, { recursive: true, force: true });
    this.cache.delete(id);
  }

  snapshot(id: string) {
    const dir = this.dirOf(id);
    const session = readJson(join(dir, "session.json")) ?? {};
    const s = this.get(id);
    return {
      session: { id, mode: s.mode, status: "archived", dir, startedAt: s.startedAt, streams: s.streams, name: s.name },
      labels: session.labelSet ? { set: session.labelSet, stories: session.config?.timeline?.stories ?? [], version: session.labelSetVersion ?? "" } : undefined,
      s1: { active: session.s1Version ?? "s1@1", versions: [], memory: [] },
      cost: { transcription: 0, jev: 0, s2: 0, session: s.costUsd, sessionCapUsd: session.config?.budget?.sessionCapUsd ?? 5 },
      archived: true,
    };
  }
}
