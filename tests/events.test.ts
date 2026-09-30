import { afterEach, describe, expect, test } from "vitest";
import { EVENT_SCHEMAS, EVENT_TYPES, EventBus, processSecrets, redactor, type AppEvent, type EventType } from "../src/store/events.ts";
import { snapshotKeyEnv } from "./fakes/index.ts";

// The event bus (src/store/events.ts): typed, validated payloads, a replayable history, subscribers, and keys
// redacted from everything it carries.

const restoreKeys = snapshotKeyEnv();
afterEach(() => restoreKeys());

describe("EventBus", () => {
  test("an unknown type is refused outright", () => {
    const bus = new EventBus();
    expect(() => bus.emit("nope" as EventType, {})).toThrow("unknown event type nope");
    expect(bus.history()).toEqual([]);
  });

  test("an invalid payload is reported and still emitted", () => {
    const invalid: [string, string][] = [];
    const bus = new EventBus({ onInvalid: (t, m) => invalid.push([t, m]) });
    const e = bus.emit("speaker.updated", { id: 1 });
    expect(invalid.length).toBe(1);
    expect(invalid[0][0]).toBe("speaker.updated");
    expect(invalid[0][1]).toMatch(/id/);
    expect(bus.history()).toEqual([e]);
    expect(() => new EventBus().emit("speaker.updated", { id: 1 })).not.toThrow(); // no reporter: silent
  });

  test("seq and at; transient events reach subscribers but never the history", () => {
    const bus = new EventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const a = bus.emit("speaker.updated", { id: "spk_1", displayName: "Nic" });
    const b = bus.emit("cost", { transcription: 0, jev: 0, s2: 0, session: 0 }, { transient: true });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(new Date(a.at).toISOString()).toBe(a.at);
    expect(seen).toEqual([a, b]);
    expect(bus.history()).toEqual([a]);
    bus.history().pop();
    expect(bus.history()).toEqual([a]); // a copy
  });

  test("a subscriber that throws does not stop the others; unsubscribing stops delivery", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe(() => { throw new Error("broken page"); });
    const off = bus.subscribe((e) => seen.push(e.seq));
    bus.emit("speaker.updated", { id: "spk_1", displayName: "A" });
    off();
    bus.emit("speaker.updated", { id: "spk_1", displayName: "B" });
    expect(seen).toEqual([1]);
  });

  test("reset clears the history only: subscribers stay, and seq keeps counting", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.seq));
    bus.emit("speaker.updated", { id: "spk_1", displayName: "A" });
    bus.reset();
    expect(bus.history()).toEqual([]);
    expect(bus.emit("speaker.updated", { id: "spk_1", displayName: "B" }).seq).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  test("load replaces the history, tells subscribers in order, and continues from the highest seq", () => {
    const bus = new EventBus();
    bus.emit("speaker.updated", { id: "spk_1", displayName: "A" });
    const seen: number[] = [];
    bus.subscribe(() => { throw new Error("ignored"); });
    bus.subscribe((e) => seen.push(e.seq));
    const stored = [
      { seq: 7, type: "speaker.created", at: "x", data: { id: "spk_1", displayName: "S1", stream: "host" } },
      { seq: 3, type: "speaker.updated", at: "x", data: { id: "spk_1", displayName: "N" } },
      { type: "speaker.updated", at: "x", data: { id: "spk_1", displayName: "no seq" } },
    ] as AppEvent[];
    bus.load(stored);
    expect(seen).toEqual([7, 3, undefined]);
    expect(bus.history()).toEqual(stored);
    expect(bus.emit("speaker.updated", { id: "spk_1", displayName: "B" }).seq).toBe(8);
    bus.load([]);
    expect(bus.emit("speaker.updated", { id: "spk_1", displayName: "C" }).seq).toBe(1);
  });

  test("redaction: every occurrence, nested; undefined fields are dropped", () => {
    const bus = new EventBus({ redact: redactor(["sk-secret-12345678"]) });
    const e = bus.emit("error", { component: "jev", message: "key sk-secret-12345678 refused", detail: { again: ["sk-secret-12345678", "x"] }, gone: undefined });
    expect(e.data).toEqual({ component: "jev", message: "key [redacted] refused", detail: { again: ["[redacted]", "x"] } });
  });
});

describe("redaction", () => {
  test("secrets shorter than 8 characters, and anything not a string, are not redacted", () => {
    const r = redactor(["short", undefined, 12345678 as never, "long-enough-key"]);
    expect(r("short long-enough-key 12345678")).toBe("short [redacted] 12345678");
    expect(redactor([])("anything")).toBe("anything");
  });

  test("processSecrets reads the keys at each call: one saved later is redacted too", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const r = processSecrets();
    expect(r("sk-proj-later-000000000")).toBe("sk-proj-later-000000000");
    process.env.OPENAI_API_KEY = "sk-proj-later-000000000";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-later-00000000";
    expect(r("a sk-proj-later-000000000 b sk-or-v1-later-00000000")).toBe("a [redacted] b [redacted]");
  });
});

describe("the schemas", () => {
  /** The least each type needs. */
  const minimal: Record<EventType, Record<string, unknown>> = {
    "session.started": { sessionId: "s", mode: "live", s1Version: "s1@1", labelSetVersion: "v" },
    "session.ended": { sessionId: "s", reason: "stopped" },
    "session.paused": { sessionId: "s", atMs: 1 },
    "session.resumed": { sessionId: "s", atMs: 1 },
    "echo.gate": { active: true, device: null, atMs: 0 },
    health: { stream: "host", rmsDbfs: -30, msSinceLastFrame: 10, utterancesLastMinute: 2 },
    "transcription.status": { engine: "apple" },
    "utterance.partial": { stream: "remote", itemId: "i", text: "t", utteranceId: null, final: false },
    "utterance.failed": { id: "u", stream: "host", startMs: 0, endMs: 1, speakerId: "spk_1", status: "retrying" },
    utterance: { id: "u", stream: "host", startMs: 0, endMs: 1, speakerId: "spk_1", speakerName: "N", text: "t", tags: [] },
    "speaker.created": { id: "spk_1", displayName: "S", stream: "host" },
    "speaker.updated": { id: "spk_1", displayName: "S" },
    "speaker.merged": { fromId: "spk_2", intoId: "spk_1", displayName: "S" },
    "segment.closed": { id: "seg_1", startMs: 0, endMs: 1, forced: false, final: true, utteranceIds: [] },
    "segment.labels": { segmentId: "seg_1", labelSetVersion: "v", unlabeled: false, markers: [] },
    "section.updated": { sections: [{ id: "sec_1", category: "c", option: "o", segmentIds: [] }] },
    "claim.flagged": { claimId: "c", utteranceId: "u", text: "t", priority: 1, s1Version: "s1@1" },
    "claim.duplicate": { claimId: "c", utteranceId: "u" },
    "claim.repeat": { claimId: "c", utteranceId: "u", verdict: { verdict: "supported" } },
    "claim.researching": { claimId: "c" },
    "claim.verdict": { claimId: "c", verdict: { verdict: "supported", restated_claim: "r", sources: [{ url: "https://x" }] }, grade: "a" },
    "claim.dropped": { claimId: "c", reason: "r" },
    "claim.disputed": { claimId: "c" },
    audit: { sampled: 3, misses: [] },
    "s1.version": { active: "s1@1", outcome: "rollback" },
    "s1.memory": { action: "add", claimId: "c", size: 1 },
    cost: { transcription: 0, jev: 0, s2: 0, session: 0 },
    "budget.exhausted": { cap: "provider", message: "m" },
    stats: { roganIndex: 0.1 },
    error: { component: "c", message: "m" },
    "call.started": { system: "s1", purpose: "utterance" },
    call: { kind: "jev_call", purpose: "utterance", ok: true },
  };

  test("the list of types is the schemas' keys", () => {
    expect(EVENT_TYPES).toEqual(Object.keys(EVENT_SCHEMAS));
    expect(Object.keys(minimal).sort()).toEqual([...EVENT_TYPES].sort());
  });

  test.each(EVENT_TYPES)("%s accepts its minimal payload, extra fields included, and refuses an empty one", (type) => {
    expect(EVENT_SCHEMAS[type].safeParse({ ...minimal[type], extra: 1 }).success).toBe(true);
    expect(EVENT_SCHEMAS[type].safeParse({}).success).toBe(false);
  });
});
