// Client state, built from GET /api/state plus the SSE event stream. Every update is idempotent by id,
// because the event stream replays the session's history on connect.

export type Stream = "host" | "remote";

export interface Speaker { id: string; displayName: string; mergedInto?: string }
export interface Utterance {
  id: string; stream: Stream; startMs: number; endMs: number; speakerId: string; text: string; tags: string[];
  filler?: boolean; speakerInferred?: boolean;
}
/** A line whose final transcript failed: retried while the session runs, else given up (see `utterance.failed`). */
export interface MissingLine { id: string; stream: Stream; startMs: number; endMs: number; speakerId: string; status: "retrying" | "failed" }
export interface ChoiceLabel { choice: string; confidence: number; faded: boolean }
export interface Labels {
  segmentId: string; labelSetVersion: string; unlabeled: boolean; choices: Record<string, ChoiceLabel>;
  nouls: Record<string, number>; scores: Record<string, number>; markers: string[]; mentions: string[]; lane: string | null; story: string | null;
}
export interface Segment { id: string; startMs: number; endMs: number; forced: boolean; final: boolean; utteranceIds: string[]; labels: Labels | null }
/** A run of consecutive segments with the same option of the set's first category (the section brackets). */
export interface Section { id: string; category: string; option: string; lane: string; segmentIds: string[]; startMs: number; endMs: number }
export interface Verdict {
  restated_claim: string; verdict: string; correction: string; confidence: string; false_alarm_reason: string;
  sources: { url: string; title: string }[]; downgraded: boolean;
}
export interface Claim {
  id: string; utteranceId: string; speakerId: string; text: string; status: string; priority: number; s1Version: string;
  verdict?: Verdict; grade?: string; latencyMs?: number; disputed?: boolean; dropReason?: string;
  repeats: string[]; duplicates: string[];
  /** When the claim was last flagged or said again: cards sort by it, so a repeat surfaces instantly. */
  activity?: string;
}
export interface Health {
  rmsDbfs: number; msSinceLastFrame: number; utterancesLastMinute: number; receivedAt: number; lastSoundAt: number; detail?: any;
  /** Host only, in speaker mode: how much of the last second the microphone was muted because the call was playing. */
  echoMutedMs?: number;
}
export interface S1Version { id: string; parent: string | null; status: string; kind: string; rationale: string; gate: any; errors: string[] | null }
export interface S1Outcome { active: string; candidate: string | null; outcome: string; rationale: string; gate: any; errors: string[] | null; at: string }
export interface Cost { transcription: number; jev: number; s2: number; chat?: number; session: number }
/** A label set, as the engine defines it (src/labels/model.ts): up to 2 categories, 2 scores, 8 markers. */
export interface LabelOption { id: string; name: string; description: string; color: string; group?: string }
export interface LabelCategory {
  id: string; name: string; instructions: string; options: LabelOption[];
  index?: { name: string; description: string; options: string[] };
}
export interface LabelScore { id: string; name: string; instructions: string; levels: string[] }
export interface LabelMarker {
  id: string; name: string; short: string; icon: string; instructions: string; criteria?: { true: string; false: string };
  threshold: number; perSpeaker: boolean; list: boolean;
}
export interface LabelSet {
  format: "tattle-labels"; version: 1; id: string; name: string; description: string; builtIn?: boolean;
  prefix: string; fadedBelowConfidence: number; companies: string[];
  categories: LabelCategory[]; scores: LabelScore[]; markers: LabelMarker[];
}
/** Stats in the shape of the session's set (src/pipeline/stats.ts); older recordings arrive converted. */
export interface Stats {
  version: 2;
  index: { name: string; description: string; share: number } | null;
  roganIndex: number;
  labelledMs: number;
  categories: { id: string; name: string; split: { option: string; ms: number; share: number }[] }[];
  speakers: { speakerId: string; displayName: string; talkMs: number; markers: Record<string, number>; scores: Record<string, number | null> }[];
  lists: { markerId: string; items: { segmentId: string; text: string }[] }[];
  factcheck?: any; cost?: any;
}
export interface LivePartial { stream: Stream; itemId: string; text: string; utteranceId: string | null; final: boolean; receivedAt: number }
export interface ErrorItem { component: string; message: string; at: string }

/** One Jev (System 1) or System 2 call, as logged in jev_calls.jsonl / s2_calls.jsonl and streamed live. */
export interface CallRow {
  kind: "jev_call" | "s2_call"; purpose: string; ok: boolean; latency_ms: number; attempts: number; cost_usd: number; at: string;
  id: string | null; model_returned: string | null; error?: string;
  // Jev
  state?: any; question_ids?: string[]; answers?: Record<string, any> | null; question_set_version?: string | null;
  usage?: any; utterance_id?: string; segment_id?: string; request_hash?: string;
  /** Question definitions: only on calls streamed live. */
  questions?: Record<string, { type: string; instructions: string; criteria?: unknown }>;
  // System 2
  claim_id?: string; web_engine?: string | null; request?: { system: string; user: string }; response?: string;
}
export type SystemId = "s1" | "s2";
export interface Calls {
  s1: CallRow[]; s2: CallRow[];
  /** Calls in flight, from call.started to its logged row. */
  active: Record<SystemId, number>;
  lastStart: Record<SystemId, number>;
  models: Record<SystemId, string | null>;
  /** Question definitions seen on live calls, by id, so older calls can show their wording too. */
  questions: Record<string, { type: string; instructions: string }>;
  keys: Set<string>;
}

/** What a session runs beyond the transcript, chosen at its start (see the engine's Features). */
export interface Features { factcheck: boolean; labels: boolean }

export interface State {
  session: {
    id: string; mode: string; status: string; paused?: boolean; dir?: string; startedAt?: string; streams?: Stream[]; name?: string | null;
    features?: Features;
    /** Speaker mode: the call plays through the Mac's speakers, so the microphone is muted while it plays. */
    echoGate?: { active: boolean; device: string | null };
    /** Recordings only: false when imported without audio; the version that recorded it; where it was imported from. */
    hasAudio?: boolean; appVersion?: string | null; imported?: { at: string; exportedWith: string | null; fileName: string | null } | null;
  } | null;
  /** Paused stretches of session time; `endMs` is null while still paused. */
  pauses: { startMs: number; endMs: number | null }[];
  speakers: Map<string, Speaker>;
  utterances: Map<string, Utterance>;
  /** Lines not transcribed (yet): shown in their place until a retry brings their text. */
  missing: Map<string, MissingLine>;
  /** Streaming text not yet replaced by its final utterance, by realtime item id. */
  partials: Map<string, LivePartial>;
  segments: Map<string, Segment>;
  sections: Section[];
  claims: Map<string, Claim>;
  health: Partial<Record<Stream, Health>>;
  s1: { active: string; versions: S1Version[]; memorySize: number; last: S1Outcome | null; misses: number; audits: number; auditsSeen: Set<string> };
  labels: { set: LabelSet | null; stories: string[]; version: string };
  cost: Cost;
  stats: Stats | null;
  errors: ErrorItem[];
  budgetExhausted: string | null;
  calls: Calls;
}

const emptyCalls = (): Calls => ({
  s1: [], s2: [], active: { s1: 0, s2: 0 }, lastStart: { s1: 0, s2: 0 }, models: { s1: null, s2: null }, questions: {}, keys: new Set(),
});

/** Keeps at most this many System 1 calls in the page: about an hour and a half of a show. */
const MAX_S1_CALLS = 3000;

/** Adds a call once (history and the live stream can overlap), newest last. */
export function addCall(s: State, row: CallRow) {
  const key = `${row.kind}|${row.at}|${row.id ?? ""}|${row.purpose}`;
  if (s.calls.keys.has(key)) return;
  s.calls.keys.add(key);
  for (const [id, q] of Object.entries(row.questions ?? {})) s.calls.questions[id] = { type: q.type, instructions: q.instructions };
  const list = row.kind === "jev_call" ? s.calls.s1 : s.calls.s2;
  list.push(row);
  if (list.length > MAX_S1_CALLS) list.splice(0, list.length - MAX_S1_CALLS);
}

export function emptyState(): State {
  return {
    session: null, pauses: [], speakers: new Map(), utterances: new Map(), missing: new Map(), partials: new Map(), segments: new Map(), sections: [], claims: new Map(), health: {},
    s1: { active: "s1@1", versions: [], memorySize: 0, last: null, misses: 0, audits: 0, auditsSeen: new Set() },
    labels: { set: null, stories: [], version: "" },
    cost: { transcription: 0, jev: 0, s2: 0, session: 0 },
    stats: null, errors: [], budgetExhausted: null, calls: emptyCalls(),
  };
}

/** The session on screen's features; sessions and recordings from before features existed ran with both on. */
export function featuresOf(s: State): Features {
  return { factcheck: s.session?.features?.factcheck !== false, labels: s.session?.features?.labels !== false };
}

/** The label set the screen shows: the session's, or null when it runs (or ran) with labels off, or there is none. */
export function labelSetOf(s: State): LabelSet | null {
  return s.session && featuresOf(s).labels ? s.labels.set : null;
}

/** Follows merges to the surviving speaker. */
export function resolveSpeaker(s: State, id: string): Speaker | undefined {
  let sp = s.speakers.get(id);
  for (let i = 0; sp?.mergedInto && i < 50; i++) sp = s.speakers.get(sp.mergedInto);
  return sp;
}

export function speakerName(s: State, id: string): string {
  return resolveSpeaker(s, id)?.displayName ?? id;
}

/** Loads GET /api/state into a fresh state. */
export function fromSnapshot(snap: any): State {
  const s = emptyState();
  if (!snap?.session) return s;
  s.session = snap.session;
  for (const sp of snap.speakers ?? []) s.speakers.set(sp.id, sp);
  for (const u of snap.utterances ?? []) s.utterances.set(u.id, u);
  for (const g of snap.segments ?? []) s.segments.set(g.id, g);
  s.sections = snap.sections ?? [];
  for (const c of snap.claims ?? []) s.claims.set(c.id, c);
  if (snap.s1) {
    s.s1.active = snap.s1.active;
    s.s1.versions = snap.s1.versions ?? [];
    s.s1.memorySize = (snap.s1.memory ?? []).length;
  }
  if (snap.labels) s.labels = snap.labels;
  if (snap.cost) s.cost = snap.cost;
  s.stats = snap.stats ?? null;
  // Misses are counted from `audit` events, which the event stream replays on connect; seeding them from the
  // snapshot as well would count every audit twice.
  return s;
}

export type Dirty = Set<"session" | "health" | "transcript" | "timeline" | "claims" | "speakers" | "s1" | "labels" | "cost" | "stats" | "errors" | "calls">;

/** Applies one SSE event. Returns what needs re-rendering, or "reset" when a new session started. */
export function applyEvent(s: State, type: string, d: any, at: string, dirty: Dirty): "reset" | void {
  switch (type) {
    case "session.started":
      if (!s.session || s.session.id !== d.sessionId) return "reset";
      if (s.session.status !== "archived") s.session.status = "running";
      if (d.features) s.session.features = d.features;
      dirty.add("session");
      break;
    case "session.ended":
      // an ended session is a recording: the engine now serves it as one, and the page shows it the same way
      if (s.session) { s.session.status = "archived"; s.session.paused = false; }
      dirty.add("session").add("health").add("cost");
      break;
    case "session.paused":
      if (s.session) s.session.paused = true;
      if (!s.pauses.some((p) => p.startMs === d.atMs)) s.pauses.push({ startMs: d.atMs, endMs: null });
      dirty.add("session").add("health").add("timeline");
      break;
    case "session.resumed": {
      if (s.session) s.session.paused = false;
      const open = s.pauses.find((p) => p.endMs === null);
      if (open) open.endMs = d.atMs;
      dirty.add("session").add("health").add("timeline");
      break;
    }
    case "health": {
      const prev = s.health[d.stream as Stream];
      const now = Date.now();
      // a microphone muted by speaker mode is silent on purpose, not failing
      const loud = d.rmsDbfs > -50 || (d.echoMutedMs ?? 0) > 0;
      s.health[d.stream as Stream] = {
        rmsDbfs: d.rmsDbfs, msSinceLastFrame: d.msSinceLastFrame, utterancesLastMinute: d.utterancesLastMinute, receivedAt: now,
        lastSoundAt: loud ? now : prev?.lastSoundAt ?? now, detail: d.detail, echoMutedMs: d.echoMutedMs,
      };
      dirty.add("health");
      break;
    }
    case "echo.gate":
      if (s.session) s.session.echoGate = { active: !!d.active, device: d.device ?? null };
      dirty.add("health");
      break;
    case "utterance.partial":
      if (d.utteranceId && s.utterances.has(d.utteranceId)) break; // the final line already landed
      s.partials.set(d.itemId, { ...d, receivedAt: Date.now() });
      dirty.add("transcript");
      break;
    case "utterance.failed":
      if (d.status === "empty" || s.utterances.has(d.id)) s.missing.delete(d.id);
      else s.missing.set(d.id, d);
      dirty.add("transcript");
      break;
    case "utterance":
      s.utterances.set(d.id, d);
      s.missing.delete(d.id); // a retry recovered it
      for (const [k, p] of s.partials) if (p.utteranceId === d.id) s.partials.delete(k);
      dirty.add("transcript");
      break;
    case "speaker.created":
    case "speaker.updated": {
      const sp = s.speakers.get(d.id) ?? { id: d.id, displayName: d.displayName };
      sp.displayName = d.displayName;
      s.speakers.set(d.id, sp);
      dirty.add("speakers").add("transcript").add("claims");
      break;
    }
    case "speaker.merged": {
      const from = s.speakers.get(d.fromId);
      if (from) from.mergedInto = d.intoId;
      dirty.add("speakers").add("transcript").add("claims");
      break;
    }
    case "segment.closed": {
      const prev = s.segments.get(d.id);
      s.segments.set(d.id, { ...d, labels: prev?.labels ?? null });
      dirty.add("timeline").add("transcript");
      break;
    }
    case "segment.labels": {
      const seg = s.segments.get(d.segmentId);
      if (seg) seg.labels = d;
      dirty.add("timeline").add("transcript");
      break;
    }
    case "section.updated":
      s.sections = d.sections;
      dirty.add("timeline");
      break;
    case "claim.flagged":
      if (!s.claims.has(d.claimId)) {
        s.claims.set(d.claimId, {
          id: d.claimId, utteranceId: d.utteranceId, speakerId: d.speakerId, text: d.text, status: "queued", priority: d.priority,
          s1Version: d.s1Version, repeats: [], duplicates: [], activity: at,
        });
      }
      dirty.add("claims").add("s1");
      break;
    case "claim.researching": {
      const c = s.claims.get(d.claimId);
      if (c && c.status === "queued") c.status = "researching";
      dirty.add("claims");
      break;
    }
    case "claim.verdict": {
      const c = s.claims.get(d.claimId);
      if (c) Object.assign(c, { status: "verdict", verdict: d.verdict, grade: d.grade, latencyMs: d.latencyMs });
      dirty.add("claims").add("s1");
      break;
    }
    case "claim.dropped": {
      const c = s.claims.get(d.claimId);
      if (c) Object.assign(c, { status: "dropped", dropReason: d.reason });
      dirty.add("claims");
      break;
    }
    case "claim.disputed": {
      const c = s.claims.get(d.claimId);
      if (c) c.disputed = true;
      dirty.add("claims").add("s1");
      break;
    }
    case "claim.repeat":
    case "claim.duplicate": {
      const c = s.claims.get(d.claimId);
      const list = c ? (type === "claim.repeat" ? c.repeats : c.duplicates) : null;
      if (list && !list.includes(d.utteranceId)) list.push(d.utteranceId);
      if (c) c.activity = at;
      dirty.add("claims").add("s1");
      break;
    }
    case "audit":
      if (s.s1.auditsSeen.has(at)) break; // the same audit, replayed
      s.s1.auditsSeen.add(at);
      s.s1.misses += (d.misses ?? []).length;
      s.s1.audits++;
      dirty.add("s1");
      break;
    case "s1.version":
      s.s1.active = d.active;
      s.s1.last = { ...d, at };
      dirty.add("s1");
      break;
    case "s1.memory":
      s.s1.memorySize = d.size;
      dirty.add("s1");
      break;
    case "cost":
      s.cost = { ...s.cost, ...d };
      dirty.add("cost");
      break;
    case "budget.exhausted":
      s.budgetExhausted = d.message;
      dirty.add("cost");
      break;
    case "stats":
      s.stats = d;
      dirty.add("stats");
      break;
    case "call.started": {
      const sys = d.system as SystemId;
      s.calls.active[sys]++;
      s.calls.lastStart[sys] = Date.now();
      dirty.add("calls");
      break;
    }
    case "call": {
      const sys: SystemId = d.kind === "jev_call" ? "s1" : "s2";
      s.calls.active[sys] = Math.max(0, s.calls.active[sys] - 1);
      addCall(s, d as CallRow);
      dirty.add("calls");
      break;
    }
    case "error":
      s.errors.unshift({ component: d.component, message: d.message, at });
      s.errors.length = Math.min(s.errors.length, 30);
      dirty.add("errors");
      break;
  }
}

/** Fact-check counters for the System 1 panel, computed from claims. */
export function s1Counters(s: State) {
  const claims = [...s.claims.values()];
  return {
    flags: claims.length,
    goodFlags: claims.filter((c) => c.grade === "good_flag" && !c.disputed).length,
    falseAlarms: claims.filter((c) => c.grade === "false_alarm" && !c.disputed).length,
    misses: s.s1.misses,
    repeats: claims.reduce((n, c) => n + c.repeats.length + c.duplicates.length, 0),
  };
}
