import { z } from "zod";

const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const str = z.string();
const num = z.number();

/** Payload schemas: the fields every front end may rely on. Extra fields pass through. */
export const EVENT_SCHEMAS = {
  "session.started": obj({ sessionId: str, mode: z.enum(["replay", "live"]), s1Version: str, labelSetVersion: str }),
  "session.ended": obj({ sessionId: str, reason: str }),
  "session.paused": obj({ sessionId: str, atMs: num }),
  "session.resumed": obj({ sessionId: str, atMs: num }),
  // speaker mode switched on or off: the microphone is muted while the call plays through the speakers
  "echo.gate": obj({ active: z.boolean(), device: str.nullable(), atMs: num }),
  health: obj({ stream: z.enum(["host", "remote"]), rmsDbfs: num, msSinceLastFrame: num, utterancesLastMinute: num }),
  // the transcription engine and Apple's model: which engine, and install progress (transient, like partials)
  "transcription.status": obj({ engine: z.enum(["apple", "openai"]) }),
  "utterance.partial": obj({ stream: z.enum(["host", "remote"]), itemId: str, text: str, utteranceId: str.nullable(), final: z.boolean() }),
  // a line whose final transcript failed: "retrying" (its audio is kept and retried), "failed" (given up), "empty" (the retry heard nothing)
  "utterance.failed": obj({ id: str, stream: str, startMs: num, endMs: num, speakerId: str, status: z.enum(["retrying", "failed", "empty"]) }),
  utterance: obj({ id: str, stream: str, startMs: num, endMs: num, speakerId: str, speakerName: str, text: str, tags: z.array(str) }),
  "speaker.created": obj({ id: str, displayName: str, stream: str }),
  "speaker.updated": obj({ id: str, displayName: str }),
  "speaker.merged": obj({ fromId: str, intoId: str, displayName: str }),
  "segment.closed": obj({ id: str, startMs: num, endMs: num, forced: z.boolean(), final: z.boolean(), utteranceIds: z.array(str) }),
  "segment.labels": obj({ segmentId: str, labelSetVersion: str, unlabeled: z.boolean(), markers: z.array(str) }),
  "section.updated": obj({ sections: z.array(obj({ id: str, category: str, option: str, segmentIds: z.array(str) })) }),
  "claim.flagged": obj({ claimId: str, utteranceId: str, text: str, priority: num, s1Version: str }),
  "claim.duplicate": obj({ claimId: str, utteranceId: str }),
  "claim.repeat": obj({ claimId: str, utteranceId: str, verdict: obj({ verdict: str }) }),
  "claim.researching": obj({ claimId: str }),
  "claim.verdict": obj({ claimId: str, verdict: obj({ verdict: str, restated_claim: str, sources: z.array(obj({ url: str })) }), grade: str }),
  "claim.dropped": obj({ claimId: str, reason: str }),
  "claim.disputed": obj({ claimId: str }),
  audit: obj({ sampled: num, misses: z.array(str) }),
  "s1.version": obj({ active: str, outcome: str }),
  "s1.memory": obj({ action: z.enum(["add", "evict", "update"]), claimId: str, size: num }),
  cost: obj({ transcription: num, jev: num, s2: num, session: num }),
  "budget.exhausted": obj({ cap: str, message: str }),
  stats: obj({ roganIndex: num }),
  error: obj({ component: str, message: str }),
  // transient: live view of every Jev (System 1) and System 2 call; the call logs on disk are the record
  "call.started": obj({ system: z.enum(["s1", "s2"]), purpose: str }),
  call: obj({ kind: z.enum(["jev_call", "s2_call"]), purpose: str, ok: z.boolean() }),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];

export interface AppEvent {
  seq: number;
  type: EventType;
  at: string;
  data: Record<string, unknown>;
}

/** Replaces any secret value with "[redacted]". Keys never appear in logs, session files, or events. */
export function redactor(secrets: (string | undefined)[]): (s: string) => string {
  const list = secrets.filter((s): s is string => typeof s === "string" && s.length >= 8);
  return (s) => list.reduce((acc, k) => acc.split(k).join("[redacted]"), s);
}

/** Redacts the keys current when each string is written: keys saved from the setup page apply without a restart. */
export function processSecrets(): (s: string) => string {
  return (s) => redactor([process.env.OPENROUTER_API_KEY, process.env.OPENAI_API_KEY])(s);
}

/** A typed event bus with zod-validated payloads, a replayable history, and subscribers. */
export class EventBus {
  private events: AppEvent[] = [];
  private seq = 0;
  private readonly subs = new Set<(e: AppEvent) => void>();

  constructor(private readonly opts: { redact?: (s: string) => string; onInvalid?: (type: string, message: string) => void } = {}) {}

  /** A transient event (live partial text) reaches subscribers but is never kept in the replayable history. */
  emit(type: EventType, data: Record<string, unknown>, opts: { transient?: boolean } = {}): AppEvent {
    const schema = EVENT_SCHEMAS[type];
    if (!schema) throw new Error(`unknown event type ${type}`);
    const r = schema.safeParse(data);
    if (!r.success) this.opts.onInvalid?.(type, z.prettifyError(r.error));
    const clean = this.opts.redact ? JSON.parse(this.opts.redact(JSON.stringify(data))) : data;
    const e: AppEvent = { seq: ++this.seq, type, at: new Date().toISOString(), data: clean };
    if (!opts.transient) this.events.push(e);
    for (const s of this.subs) {
      try { s(e); } catch { /* a broken subscriber must not break the pipeline */ }
    }
    return e;
  }

  history(): AppEvent[] {
    return [...this.events];
  }

  subscribe(fn: (e: AppEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** A new session: history starts over; subscribers stay connected. */
  reset(): void {
    this.events = [];
  }

  /** Reopening a recorded session: its stored events become the history, and connected clients receive them. */
  load(events: AppEvent[]): void {
    this.events = [...events];
    this.seq = events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    for (const e of events) {
      for (const s of this.subs) {
        try { s(e); } catch { /* ignore */ }
      }
    }
  }
}
