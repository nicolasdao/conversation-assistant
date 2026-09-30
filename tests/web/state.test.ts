// The page's state and its event reducer (web/src/state.ts): pure, so it runs in node. Every update is idempotent,
// because the engine replays a session's history on every (re)connect.
import { afterEach, describe, expect, test, vi } from "vitest";
import * as state from "../../web/src/state.ts";
import { addCall, applyEvent, emptyState, featuresOf, fromSnapshot, labelSetOf, resolveSpeaker, s1Counters, speakerName, type CallRow, type Dirty, type State } from "../../web/src/state.ts";
import { feed } from "./helpers.ts";

const AT = "2026-09-30T10:00:00.000Z";
const apply = (s: State, type: string, d: any, at = AT) => {
  const dirty: Dirty = new Set();
  const r = applyEvent(s, type, d, at, dirty);
  return { r, dirty: [...dirty].sort() };
};
const withSession = (extra: Partial<NonNullable<State["session"]>> = {}): State => {
  const s = emptyState();
  s.session = { id: "S1", mode: "live", status: "running", ...extra };
  return s;
};
const row = (o: Partial<CallRow> = {}): CallRow => ({
  kind: "jev_call", purpose: "utterance", ok: true, latency_ms: 800, attempts: 1, cost_usd: 0.0001, at: AT, id: "g1", model_returned: null, ...o,
});

afterEach(() => vi.useRealTimers());

describe("emptyState, featuresOf, labelSetOf", () => {
  test("emptyState has no session, s1@1, zero cost, and empty maps and calls", () => {
    const s = emptyState();
    expect(s.session).toBeNull();
    expect(s.s1).toMatchObject({ active: "s1@1", versions: [], memorySize: 0, last: null, misses: 0, audits: 0 });
    expect(s.cost).toEqual({ transcription: 0, jev: 0, s2: 0, session: 0 });
    for (const m of [s.speakers, s.utterances, s.missing, s.partials, s.segments, s.claims]) expect(m.size).toBe(0);
    expect(s.calls).toMatchObject({ s1: [], s2: [], active: { s1: 0, s2: 0 }, models: { s1: null, s2: null }, questions: {} });
    expect([s.stats, s.budgetExhausted, s.errors, s.labels]).toEqual([null, null, [], { set: null, stories: [], version: "" }]);
    expect(emptyState().calls.keys).not.toBe(s.calls.keys); // fresh each time
  });

  test("featuresOf defaults both on with no session, and with a session that has no features", () => {
    expect(featuresOf(emptyState())).toEqual({ factcheck: true, labels: true });
    expect(featuresOf(withSession())).toEqual({ factcheck: true, labels: true });
  });

  test("featuresOf reads factcheck:false and labels:false independently", () => {
    expect(featuresOf(withSession({ features: { factcheck: false, labels: true } }))).toEqual({ factcheck: false, labels: true });
    expect(featuresOf(withSession({ features: { factcheck: true, labels: false } }))).toEqual({ factcheck: true, labels: false });
  });

  test("labelSetOf is the session's set, or null with no session or labels off", () => {
    const set = { id: "builtin" } as any;
    const s = withSession();
    s.labels.set = set;
    expect(labelSetOf(s)).toBe(set);
    s.session!.features = { factcheck: true, labels: false };
    expect(labelSetOf(s)).toBeNull();
    const none = emptyState();
    none.labels.set = set;
    expect(labelSetOf(none)).toBeNull();
  });
});

describe("speakers", () => {
  test("resolveSpeaker follows a merge chain to the survivor", () => {
    const s = emptyState();
    s.speakers.set("a", { id: "a", displayName: "A", mergedInto: "b" });
    s.speakers.set("b", { id: "b", displayName: "B", mergedInto: "c" });
    s.speakers.set("c", { id: "c", displayName: "Carol" });
    expect(resolveSpeaker(s, "a")?.id).toBe("c");
    expect(speakerName(s, "a")).toBe("Carol");
  });

  test("resolveSpeaker stops after 50 hops on a merge cycle and returns a speaker", () => {
    const s = emptyState();
    s.speakers.set("a", { id: "a", displayName: "A", mergedInto: "b" });
    s.speakers.set("b", { id: "b", displayName: "B", mergedInto: "a" });
    expect(["a", "b"]).toContain(resolveSpeaker(s, "a")?.id);
  });

  test("an unknown id resolves to undefined, and its name is the id", () => {
    const s = emptyState();
    expect(resolveSpeaker(s, "x")).toBeUndefined();
    expect(speakerName(s, "x")).toBe("x");
    s.speakers.set("a", { id: "a", displayName: "A", mergedInto: "gone" });
    expect(speakerName(s, "a")).toBe("a"); // merged into a speaker the page never heard of
  });
});

describe("fromSnapshot", () => {
  test("no session gives an empty state", () => {
    for (const snap of [null, undefined, {}, { session: null, speakers: [{ id: "a", displayName: "A" }] }]) {
      expect(fromSnapshot(snap)).toEqual(emptyState());
    }
  });

  test("loads speakers, utterances, segments, sections and claims keyed by id", () => {
    const s = fromSnapshot({
      session: { id: "S1", mode: "replay", status: "running" },
      speakers: [{ id: "a", displayName: "A" }],
      utterances: [{ id: "u1", stream: "host", startMs: 0, endMs: 1, speakerId: "a", text: "hi", tags: [] }],
      segments: [{ id: "g1", startMs: 0, endMs: 1, forced: false, final: true, utteranceIds: ["u1"], labels: null }],
      sections: [{ id: "x1" }],
      claims: [{ id: "c1", text: "x", repeats: [], duplicates: [] }],
    });
    expect(s.session?.id).toBe("S1");
    expect([...s.speakers.keys(), ...s.utterances.keys(), ...s.segments.keys(), ...s.claims.keys()]).toEqual(["a", "u1", "g1", "c1"]);
    expect(s.sections).toEqual([{ id: "x1" }]);
  });

  test("takes s1's active version and versions, and the memory size from memory's length", () => {
    expect(fromSnapshot({ session: { id: "S" }, s1: { active: "s1@3", versions: [{ id: "s1@3" }], memory: [1, 2] } }).s1)
      .toMatchObject({ active: "s1@3", versions: [{ id: "s1@3" }], memorySize: 2 });
    expect(fromSnapshot({ session: { id: "S" }, s1: { active: "s1@2" } }).s1).toMatchObject({ active: "s1@2", versions: [], memorySize: 0 });
    expect(fromSnapshot({ session: { id: "S" } }).s1.active).toBe("s1@1");
  });

  test("copies labels, cost and stats (none gives null), and never seeds misses or errors", () => {
    const labels = { set: { id: "x" }, stories: ["a"], version: "v2" };
    const cost = { transcription: 1, jev: 2, s2: 3, session: 6 };
    const s = fromSnapshot({ session: { id: "S" }, labels, cost, stats: { version: 2 }, errors: [{ component: "x" }], s1: { active: "a", misses: 4 } });
    expect([s.labels, s.cost, s.stats]).toEqual([labels, cost, { version: 2 }]);
    expect([s.errors, s.s1.misses]).toEqual([[], 0]);
    expect(fromSnapshot({ session: { id: "S" } }).stats).toBeNull();
    expect(fromSnapshot({ session: { id: "S" } }).sections).toEqual([]);
  });
});

describe("applyEvent: session", () => {
  test("session.started with no session, or another session, asks for a reset and marks nothing", () => {
    expect(apply(emptyState(), "session.started", { sessionId: "S1" })).toEqual({ r: "reset", dirty: [] });
    expect(apply(withSession(), "session.started", { sessionId: "S2" })).toEqual({ r: "reset", dirty: [] });
  });

  test("session.started for the same id marks it running, keeps a recording archived, and copies features", () => {
    const s = withSession({ status: "ending" });
    expect(apply(s, "session.started", { sessionId: "S1", features: { factcheck: false, labels: true } })).toEqual({ r: undefined, dirty: ["session"] });
    expect(s.session).toMatchObject({ status: "running", features: { factcheck: false, labels: true } });
    const rec = withSession({ status: "archived", features: { factcheck: true, labels: true } });
    apply(rec, "session.started", { sessionId: "S1" });
    expect(rec.session).toMatchObject({ status: "archived", features: { factcheck: true, labels: true } });
  });

  test("session.ended archives and clears paused; it is safe with no session", () => {
    const s = withSession({ paused: true });
    expect(apply(s, "session.ended", {}).dirty).toEqual(["cost", "health", "session"]);
    expect(s.session).toMatchObject({ status: "archived", paused: false });
    const none = emptyState();
    expect(apply(none, "session.ended", {}).dirty).toEqual(["cost", "health", "session"]);
    expect(none.session).toBeNull();
  });

  test("session.paused adds one open pause, deduplicated by atMs on replay", () => {
    const s = withSession();
    expect(apply(s, "session.paused", { atMs: 5000 }).dirty).toEqual(["health", "session", "timeline"]);
    apply(s, "session.paused", { atMs: 5000 });
    expect(s.pauses).toEqual([{ startMs: 5000, endMs: null }]);
    expect(s.session!.paused).toBe(true);
    const none = emptyState();
    apply(none, "session.paused", { atMs: 1 });
    expect(none.pauses).toHaveLength(1);
  });

  test("session.resumed closes the open pause; a resume with nothing open is harmless", () => {
    const s = withSession();
    apply(s, "session.paused", { atMs: 5000 });
    expect(apply(s, "session.resumed", { atMs: 9000 }).dirty).toEqual(["health", "session", "timeline"]);
    expect(s.pauses).toEqual([{ startMs: 5000, endMs: 9000 }]);
    expect(s.session!.paused).toBe(false);
    apply(s, "session.resumed", { atMs: 12000 });
    expect(s.pauses).toEqual([{ startMs: 5000, endMs: 9000 }]);
    const none = emptyState();
    expect(apply(none, "session.resumed", { atMs: 1 }).dirty).toEqual(["health", "session", "timeline"]);
  });
});

describe("applyEvent: health and the echo gate", () => {
  const frame = (o: object) => ({ stream: "host", rmsDbfs: -20, msSinceLastFrame: 10, utterancesLastMinute: 3, ...o });

  test("a frame louder than -50 dBFS marks sound now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const s = withSession();
    expect(apply(s, "health", frame({ detail: { device: "Mic" } })).dirty).toEqual(["health"]);
    expect(s.health.host).toEqual({ rmsDbfs: -20, msSinceLastFrame: 10, utterancesLastMinute: 3, receivedAt: 1000, lastSoundAt: 1000, detail: { device: "Mic" }, echoMutedMs: undefined });
  });

  test("a quiet frame keeps the previous lastSoundAt, and the first quiet frame uses now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = withSession();
    vi.setSystemTime(1000);
    apply(s, "health", frame({ stream: "remote", rmsDbfs: -70 }));
    expect(s.health.remote!.lastSoundAt).toBe(1000);
    vi.setSystemTime(2000);
    apply(s, "health", frame({ stream: "remote", rmsDbfs: -30 }));
    vi.setSystemTime(5000);
    apply(s, "health", frame({ stream: "remote", rmsDbfs: -50 })); // -50 exactly is quiet
    expect(s.health.remote).toMatchObject({ receivedAt: 5000, lastSoundAt: 2000 });
  });

  test("a microphone muted by speaker mode counts as sound", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = withSession();
    vi.setSystemTime(1000);
    apply(s, "health", frame({ rmsDbfs: -90 }));
    vi.setSystemTime(3000);
    apply(s, "health", frame({ rmsDbfs: -90, echoMutedMs: 400 }));
    expect(s.health.host).toMatchObject({ lastSoundAt: 3000, echoMutedMs: 400 });
  });

  test("echo.gate sets active and device (none gives null); with no session it only marks health", () => {
    const s = withSession();
    expect(apply(s, "echo.gate", { active: 1, device: "MacBook speakers" }).dirty).toEqual(["health"]);
    expect(s.session!.echoGate).toEqual({ active: true, device: "MacBook speakers" });
    apply(s, "echo.gate", { active: false });
    expect(s.session!.echoGate).toEqual({ active: false, device: null });
    const none = emptyState();
    expect(apply(none, "echo.gate", { active: true }).dirty).toEqual(["health"]);
    expect(none.session).toBeNull();
  });
});

describe("applyEvent: transcript", () => {
  const utt = (id: string, o: object = {}) => ({ id, stream: "host", startMs: 0, endMs: 1000, speakerId: "a", text: "hi", tags: [], ...o });

  test("utterance.partial is stored by item id with the time it arrived", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(4242);
    const s = withSession();
    const p = { stream: "host", itemId: "i1", text: "hel", utteranceId: null, final: false };
    expect(apply(s, "utterance.partial", p).dirty).toEqual(["transcript"]);
    expect(s.partials.get("i1")).toEqual({ ...p, receivedAt: 4242 });
  });

  test("utterance.partial for a line already final is ignored and marks nothing", () => {
    const s = withSession();
    apply(s, "utterance", utt("u1"));
    expect(apply(s, "utterance.partial", { stream: "host", itemId: "i1", text: "late", utteranceId: "u1", final: true }).dirty).toEqual([]);
    expect(s.partials.size).toBe(0);
  });

  test("utterance.failed keeps a retrying or failed line; empty, or a line already transcribed, removes it", () => {
    const s = withSession();
    const failed = { id: "u1", stream: "host", startMs: 0, endMs: 1, speakerId: "a", status: "retrying" };
    expect(apply(s, "utterance.failed", failed).dirty).toEqual(["transcript"]);
    expect(s.missing.get("u1")).toEqual(failed);
    apply(s, "utterance.failed", { ...failed, status: "failed" });
    expect(s.missing.get("u1")?.status).toBe("failed");
    apply(s, "utterance.failed", { ...failed, status: "empty" });
    expect(s.missing.has("u1")).toBe(false);
    apply(s, "utterance", utt("u2"));
    apply(s, "utterance.failed", { ...failed, id: "u2", status: "failed" });
    expect(s.missing.has("u2")).toBe(false);
  });

  test("an utterance replaces its missing line and every partial that pointed to it", () => {
    const s = withSession();
    apply(s, "utterance.failed", { id: "u1", stream: "host", startMs: 0, endMs: 1, speakerId: "a", status: "retrying" });
    apply(s, "utterance.partial", { stream: "host", itemId: "i1", text: "a", utteranceId: "u1", final: false });
    apply(s, "utterance.partial", { stream: "host", itemId: "i2", text: "b", utteranceId: "u1", final: true });
    apply(s, "utterance.partial", { stream: "host", itemId: "i3", text: "c", utteranceId: null, final: false });
    expect(apply(s, "utterance", utt("u1")).dirty).toEqual(["transcript"]);
    expect([s.missing.size, [...s.partials.keys()], s.utterances.get("u1")?.text]).toEqual([0, ["i3"], "hi"]);
  });
});

describe("applyEvent: speakers, segments, sections", () => {
  test("speaker.created then speaker.updated renames without losing mergedInto", () => {
    const s = withSession();
    expect(apply(s, "speaker.created", { id: "a", displayName: "Speaker 1" }).dirty).toEqual(["claims", "speakers", "transcript"]);
    s.speakers.get("a")!.mergedInto = "b";
    apply(s, "speaker.updated", { id: "a", displayName: "Alice" });
    expect(s.speakers.get("a")).toEqual({ id: "a", displayName: "Alice", mergedInto: "b" });
  });

  test("speaker.merged sets mergedInto; an unknown speaker is a no-op but still marks dirty", () => {
    const s = withSession();
    apply(s, "speaker.created", { id: "a", displayName: "A" });
    apply(s, "speaker.merged", { fromId: "a", intoId: "b" });
    expect(s.speakers.get("a")!.mergedInto).toBe("b");
    expect(apply(s, "speaker.merged", { fromId: "zz", intoId: "b" }).dirty).toEqual(["claims", "speakers", "transcript"]);
    expect(s.speakers.has("zz")).toBe(false);
  });

  test("segment.closed keeps labels already attached when the segment closes again", () => {
    const s = withSession();
    const g = { id: "g1", startMs: 0, endMs: 10, forced: false, final: false, utteranceIds: ["u1"] };
    expect(apply(s, "segment.closed", g).dirty).toEqual(["timeline", "transcript"]);
    expect(s.segments.get("g1")!.labels).toBeNull();
    const labels = { segmentId: "g1", lane: "x" };
    expect(apply(s, "segment.labels", labels).dirty).toEqual(["timeline", "transcript"]);
    expect(s.segments.get("g1")!.labels).toBe(labels);
    apply(s, "segment.closed", { ...g, endMs: 20, final: true });
    expect(s.segments.get("g1")).toMatchObject({ endMs: 20, final: true, labels });
  });

  test("segment.labels for an unknown segment is a no-op", () => {
    const s = withSession();
    expect(apply(s, "segment.labels", { segmentId: "nope" }).dirty).toEqual(["timeline", "transcript"]);
    expect(s.segments.size).toBe(0);
  });

  test("section.updated replaces the sections", () => {
    const s = withSession();
    s.sections = [{ id: "old" } as any];
    const sections = [{ id: "x1" }, { id: "x2" }];
    expect(apply(s, "section.updated", { sections }).dirty).toEqual(["timeline"]);
    expect(s.sections).toBe(sections);
  });
});

describe("applyEvent: claims", () => {
  const flag = { claimId: "c1", utteranceId: "u1", speakerId: "a", text: "GPT-6 has 10T parameters", priority: 2, s1Version: "s1@1" };

  test("claim.flagged creates a queued claim once; a replay does not reset it", () => {
    const s = withSession();
    expect(apply(s, "claim.flagged", flag, "2026-09-30T10:00:01.000Z").dirty).toEqual(["claims", "s1"]);
    expect(s.claims.get("c1")).toEqual({
      id: "c1", utteranceId: "u1", speakerId: "a", text: flag.text, status: "queued", priority: 2, s1Version: "s1@1",
      repeats: [], duplicates: [], activity: "2026-09-30T10:00:01.000Z",
    });
    apply(s, "claim.researching", { claimId: "c1" });
    apply(s, "claim.flagged", { ...flag, text: "changed" }, "2026-09-30T11:00:00.000Z");
    expect(s.claims.get("c1")).toMatchObject({ status: "researching", text: flag.text, activity: "2026-09-30T10:00:01.000Z" });
  });

  test("claim.researching moves only queued claims", () => {
    const s = withSession();
    apply(s, "claim.flagged", flag);
    expect(apply(s, "claim.researching", { claimId: "c1" }).dirty).toEqual(["claims"]);
    expect(s.claims.get("c1")!.status).toBe("researching");
    apply(s, "claim.verdict", { claimId: "c1", verdict: { verdict: "supported" }, grade: "good_flag", latencyMs: 9000 });
    apply(s, "claim.researching", { claimId: "c1" });
    expect(s.claims.get("c1")!.status).toBe("verdict");
    expect(apply(s, "claim.researching", { claimId: "nope" }).dirty).toEqual(["claims"]);
  });

  test("claim.verdict sets the status, verdict, grade and latency; an unknown claim is a no-op", () => {
    const s = withSession();
    apply(s, "claim.flagged", flag);
    const verdict = { verdict: "contradicted", restated_claim: "x" };
    expect(apply(s, "claim.verdict", { claimId: "c1", verdict, grade: "good_flag", latencyMs: 9000 }).dirty).toEqual(["claims", "s1"]);
    expect(s.claims.get("c1")).toMatchObject({ status: "verdict", verdict, grade: "good_flag", latencyMs: 9000 });
    apply(s, "claim.verdict", { claimId: "nope", verdict });
    expect(s.claims.size).toBe(1);
  });

  test("claim.dropped sets the reason; claim.disputed marks it disputed", () => {
    const s = withSession();
    apply(s, "claim.flagged", flag);
    expect(apply(s, "claim.dropped", { claimId: "c1", reason: "not checkable" }).dirty).toEqual(["claims"]);
    expect(s.claims.get("c1")).toMatchObject({ status: "dropped", dropReason: "not checkable" });
    expect(apply(s, "claim.disputed", { claimId: "c1" }).dirty).toEqual(["claims", "s1"]);
    expect(s.claims.get("c1")!.disputed).toBe(true);
    apply(s, "claim.dropped", { claimId: "nope", reason: "x" });
    apply(s, "claim.disputed", { claimId: "nope" });
    expect(s.claims.size).toBe(1);
  });

  test("claim.repeat and claim.duplicate add the line once to the right list and bump activity", () => {
    const s = withSession();
    apply(s, "claim.flagged", flag, "2026-09-30T10:00:00.000Z");
    expect(apply(s, "claim.repeat", { claimId: "c1", utteranceId: "u7" }, "2026-09-30T10:05:00.000Z").dirty).toEqual(["claims", "s1"]);
    apply(s, "claim.repeat", { claimId: "c1", utteranceId: "u7" }, "2026-09-30T10:06:00.000Z");
    apply(s, "claim.duplicate", { claimId: "c1", utteranceId: "u8" }, "2026-09-30T10:07:00.000Z");
    expect(s.claims.get("c1")).toMatchObject({ repeats: ["u7"], duplicates: ["u8"], activity: "2026-09-30T10:07:00.000Z" });
    expect(apply(s, "claim.duplicate", { claimId: "nope", utteranceId: "u9" }).dirty).toEqual(["claims", "s1"]);
  });
});

describe("applyEvent: System 1, cost, stats, calls, errors", () => {
  test("an audit counts its misses once per timestamp, and counts audits", () => {
    const s = withSession();
    expect(apply(s, "audit", { misses: [{}, {}] }, "2026-09-30T10:00:00.000Z").dirty).toEqual(["s1"]);
    expect(apply(s, "audit", { misses: [{}, {}] }, "2026-09-30T10:00:00.000Z").dirty).toEqual([]);
    apply(s, "audit", { misses: [{}] }, "2026-09-30T10:01:00.000Z");
    expect([s.s1.misses, s.s1.audits]).toEqual([3, 2]);
  });

  test("an audit without misses adds none but counts the audit", () => {
    const s = withSession();
    apply(s, "audit", {}, "2026-09-30T10:00:00.000Z");
    expect([s.s1.misses, s.s1.audits]).toEqual([0, 1]);
  });

  test("s1.version sets the active version and the last outcome with its time; s1.memory sets the size", () => {
    const s = withSession();
    const d = { active: "s1@2", candidate: "s1@2", outcome: "promoted", rationale: "r", gate: null, errors: null };
    expect(apply(s, "s1.version", d, "2026-09-30T10:09:00.000Z").dirty).toEqual(["s1"]);
    expect(s.s1).toMatchObject({ active: "s1@2", last: { ...d, at: "2026-09-30T10:09:00.000Z" } });
    expect(apply(s, "s1.memory", { size: 7 }).dirty).toEqual(["s1"]);
    expect(s.s1.memorySize).toBe(7);
  });

  test("cost merges into the cost; budget.exhausted keeps the message", () => {
    const s = withSession();
    expect(apply(s, "cost", { jev: 0.5, session: 0.5 }).dirty).toEqual(["cost"]);
    apply(s, "cost", { chat: 0.1 });
    expect(s.cost).toEqual({ transcription: 0, jev: 0.5, s2: 0, session: 0.5, chat: 0.1 });
    expect(apply(s, "budget.exhausted", { message: "OpenRouter: out of credit" }).dirty).toEqual(["cost"]);
    expect(s.budgetExhausted).toBe("OpenRouter: out of credit");
  });

  test("stats replaces the stats", () => {
    const s = withSession();
    const st = { version: 2, roganIndex: 0.3 };
    expect(apply(s, "stats", st).dirty).toEqual(["stats"]);
    expect(s.stats).toBe(st);
  });

  test("call.started counts a call in flight and stamps it; call counts it down, not below 0, and adds the row", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(7000);
    const s = withSession();
    expect(apply(s, "call.started", { system: "s1" }).dirty).toEqual(["calls"]);
    apply(s, "call.started", { system: "s2" });
    expect([s.calls.active, s.calls.lastStart]).toEqual([{ s1: 1, s2: 1 }, { s1: 7000, s2: 7000 }]);
    expect(apply(s, "call", row()).dirty).toEqual(["calls"]);
    apply(s, "call", row({ kind: "s2_call", purpose: "research", id: "g2" }));
    apply(s, "call", row({ id: "g3" }));
    expect(s.calls.active).toEqual({ s1: 0, s2: 0 });
    expect([s.calls.s1.length, s.calls.s2.length]).toEqual([2, 1]);
  });

  test("error keeps the newest first, and 30 at most", () => {
    const s = withSession();
    expect(apply(s, "error", { component: "jev", message: "m0" }, "t0").dirty).toEqual(["errors"]);
    for (let i = 1; i < 35; i++) apply(s, "error", { component: "jev", message: `m${i}` }, `t${i}`);
    expect(s.errors).toHaveLength(30);
    expect(s.errors[0]).toEqual({ component: "jev", message: "m34", at: "t34" });
    expect(s.errors.at(-1)!.message).toBe("m5");
  });

  test("an unknown event type changes nothing and marks nothing", () => {
    const s = withSession();
    const before = structuredClone({ ...s, calls: { ...s.calls, keys: [] } });
    expect(apply(s, "transcription.status", { engine: "apple" })).toEqual({ r: undefined, dirty: [] });
    expect({ ...s, calls: { ...s.calls, keys: [] } }).toEqual(before);
  });

  // S-state-1: the engine replays a session's whole history on every EventSource (re)connect, and every other update
  // is idempotent; errors are not, so a reconnect lists every error twice in Insights → Log.
  test.fails("BUG S-state-1: a replayed error event is not added twice", () => {
    const s = withSession();
    apply(s, "error", { component: "jev", message: "timeout" }, "2026-09-30T10:00:00.000Z");
    apply(s, "error", { component: "jev", message: "timeout" }, "2026-09-30T10:00:00.000Z");
    expect(s.errors).toHaveLength(1);
  });
});

describe("addCall and s1Counters", () => {
  test("addCall deduplicates by kind, time, id and purpose (a null id counts as empty)", () => {
    const s = emptyState();
    addCall(s, row({ id: null }));
    addCall(s, row({ id: null }));
    addCall(s, row({ id: "" }));
    expect(s.calls.s1).toHaveLength(1);
    addCall(s, row({ id: null, purpose: "segment" }));
    addCall(s, row({ id: null, at: "2026-09-30T10:00:01.000Z" }));
    addCall(s, row({ id: null, kind: "s2_call" }));
    expect([s.calls.s1.length, s.calls.s2.length]).toEqual([3, 1]);
  });

  test("addCall keeps the question wording from live rows, by id", () => {
    const s = emptyState();
    addCall(s, row({ questions: { claim: { type: "noul", instructions: "Is it a claim?", criteria: { true: "y", false: "n" } } } }));
    addCall(s, row({ id: "g2", questions: { worth: { type: "score", instructions: "How worth it?" } } }));
    expect(s.calls.questions).toEqual({ claim: { type: "noul", instructions: "Is it a claim?" }, worth: { type: "score", instructions: "How worth it?" } });
  });

  test("addCall keeps the newest 3000 calls, for System 1 and for System 2", () => {
    const s = emptyState();
    for (let i = 0; i < 3002; i++) {
      addCall(s, row({ id: `a${i}` }));
      addCall(s, row({ id: `b${i}`, kind: "s2_call" }));
    }
    expect([s.calls.s1.length, s.calls.s2.length]).toEqual([3000, 3000]);
    expect([s.calls.s1[0]!.id, s.calls.s2[0]!.id, s.calls.s1.at(-1)!.id]).toEqual(["a2", "b2", "a3001"]);
  });

  test("s1Counters counts flags, good flags and false alarms (not disputed), misses, and repeats plus duplicates", () => {
    const s = feed(state, [
      ["claim.flagged", { claimId: "c1", utteranceId: "u1" }],
      ["claim.flagged", { claimId: "c2", utteranceId: "u2" }],
      ["claim.flagged", { claimId: "c3", utteranceId: "u3" }],
      ["claim.flagged", { claimId: "c4", utteranceId: "u4" }],
      ["claim.verdict", { claimId: "c1", verdict: {}, grade: "good_flag" }],
      ["claim.verdict", { claimId: "c2", verdict: {}, grade: "good_flag" }],
      ["claim.disputed", { claimId: "c2" }],
      ["claim.verdict", { claimId: "c3", verdict: {}, grade: "false_alarm" }],
      ["claim.verdict", { claimId: "c4", verdict: {}, grade: "false_alarm" }],
      ["claim.disputed", { claimId: "c4" }],
      ["claim.repeat", { claimId: "c1", utteranceId: "u9" }],
      ["claim.duplicate", { claimId: "c1", utteranceId: "u10" }],
      ["claim.repeat", { claimId: "c3", utteranceId: "u11" }],
      ["audit", { misses: [1, 2] }, "a1"],
    ]);
    expect(s1Counters(s)).toEqual({ flags: 4, goodFlags: 1, falseAlarms: 1, misses: 2, repeats: 3 });
    expect(s1Counters(emptyState())).toEqual({ flags: 0, goodFlags: 0, falseAlarms: 0, misses: 0, repeats: 0 });
  });
});
