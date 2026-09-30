import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { resolveRecorded, SessionLibrary } from "../src/store/library.ts";
import { Engine } from "../src/server/main.ts";
import { setAppPaths } from "../src/paths.ts";
import { cleanTmpDirs, ev, makeSession, tmpDir, withAppPaths } from "./fakes/index.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "library-"));
  makeSession(root, "20260924-100000", { startedAt: "2026-09-24T10:00:00Z", lines: [["u_1", "Jev is four hundred times cheaper than GPT."], ["u_2", "Surfing in Sydney was great."]] });
  makeSession(root, "20260925-090000", { startedAt: "2026-09-25T09:00:00Z", lines: [["u_1", "Welcome to the show about agents."]], ended: false });
  makeSession(root, "smoke-20260925-080000", { mode: "replay", startedAt: "2026-09-25T08:00:00Z", lines: [] });
  return root;
}

describe("session library", () => {
  test("lists recordings newest first, hiding tool runs, with summaries", () => {
    const lib = new SessionLibrary(fixture());
    const list = lib.list();
    expect(list.map((s) => s.id)).toEqual(["20260925-090000", "20260924-100000"]);
    expect(list[1]).toMatchObject({
      mode: "live", durationMs: 90_000, utterances: 2, speakers: ["Nic"], segments: 1, claims: 1, ended: true, name: null, tool: false,
    });
    expect(list[1].costUsd).toBeCloseTo(0.01);
    expect(list[0].ended).toBe(false);
    expect(lib.list({ includeTools: true }).length).toBe(3);
  });

  test("chats count in a recording's cost, by bucket, and its transcript is there for the Chat tab", () => {
    const root = fixture();
    const lib = new SessionLibrary(root);
    expect(lib.get("20260924-100000").cost).toEqual({ transcription: 0, jev: 0.01, s2: 0, chat: 0 });
    writeFileSync(join(root, "20260924-100000", "chats.jsonl"),
      JSON.stringify({ kind: "chat_call", chat_id: "chat_1", message_id: "m_2", cost_usd: 0.004 }) + "\n");
    const s = lib.get("20260924-100000");
    expect(s.cost.chat).toBeCloseTo(0.004);
    expect(s.costUsd).toBeCloseTo(0.014);
    expect(lib.snapshot("20260924-100000").cost).toMatchObject({ chat: 0.004, jev: 0.01 });
    expect(lib.transcript("20260924-100000")).toEqual([
      { id: "u_1", startMs: 0, speakerId: "spk_1", speaker: "Nic", text: "Jev is four hundred times cheaper than GPT." },
      { id: "u_2", startMs: 5000, speakerId: "spk_1", speaker: "Nic", text: "Surfing in Sydney was great." },
    ]);
  });

  test("names and notes go to meta.json; empty clears", () => {
    const root = fixture();
    const lib = new SessionLibrary(root);
    expect(lib.update("20260924-100000", { name: "  Episode 12 ", notes: "planted claims" })).toMatchObject({ name: "Episode 12", notes: "planted claims" });
    expect(JSON.parse(readFileSync(join(root, "20260924-100000", "meta.json"), "utf8"))).toEqual({ name: "Episode 12", notes: "planted claims" });
    expect(lib.update("20260924-100000", { notes: "" }).notes).toBeNull();
    expect(() => lib.update("20260924-100000", { name: "x".repeat(121) })).toThrow(/too long/);
    expect(() => lib.update("../etc", { name: "x" })).toThrow(/invalid/);
    expect(() => lib.update("20990101-000000", { name: "x" })).toThrow(/unknown/);
  });

  test("search matches names and transcript text, every word, with snippets", () => {
    const lib = new SessionLibrary(fixture());
    lib.update("20260925-090000", { name: "Agents special" });
    const byText = lib.list({ q: "cheaper GPT" });
    expect(byText.map((s) => s.id)).toEqual(["20260924-100000"]);
    expect(byText[0].matches).toEqual([{ utteranceId: "u_1", startMs: 0, speaker: "Nic", snippet: "Jev is four hundred times cheaper than GPT." }]);
    expect(lib.list({ q: "agents" }).map((s) => s.id)).toEqual(["20260925-090000"]);
    expect(lib.list({ q: "nic" }).length).toBe(2);
    expect(lib.list({ q: "nothing here" })).toEqual([]);
  });

  test("the engine reopens a recording read-only from its events", () => {
    const root = fixture();
    const engine = new Engine({ sessionsDir: root });
    const seen: string[] = [];
    engine.bus.subscribe((e) => seen.push(e.type));
    expect(engine.openSession("20260924-100000")).toEqual({ sessionId: "20260924-100000", events: 8 });
    expect(seen[0]).toBe("session.started");
    expect(engine.bus.history().length).toBe(8);
    expect(engine.state()).toMatchObject({ session: { id: "20260924-100000", status: "archived" }, archived: true });
    expect(() => engine.override("c_1")).toThrow(/recorded session/);
    expect(() => engine.openSession("nope")).toThrow(/unknown|invalid/);
  });

  test("speakers can be renamed and merged on a reopened recording, and the edit is saved with it", () => {
    const root = fixture();
    const id = "20260924-100000";
    const dir = join(root, id);
    const events = readFileSync(join(dir, "events.jsonl"), "utf8");
    writeFileSync(join(dir, "events.jsonl"), events + ev("speaker.created", { id: "spk_2", displayName: "Speaker 2", stream: "remote" }) + "\n");
    writeFileSync(join(dir, "speakers.json"), JSON.stringify([
      { id: "spk_1", displayName: "Nic", utterances: 2 }, { id: "spk_2", displayName: "Speaker 2", utterances: 1 },
    ]));
    const engine = new Engine({ sessionsDir: root });
    const seen: string[] = [];
    engine.openSession(id);
    engine.bus.subscribe((e) => seen.push(e.type));

    expect(engine.renameSpeaker("spk_1", "  Nicolas ")).toEqual({ id: "spk_1", displayName: "Nicolas" });
    expect(engine.mergeSpeakers("spk_2", "spk_1")).toEqual({ id: "spk_1", displayName: "Nicolas" });
    expect(seen).toEqual(["speaker.updated", "speaker.merged"]); // open pages update at once
    // a merged speaker resolves to its target
    expect(engine.renameSpeaker("spk_2", "Nico")).toEqual({ id: "spk_1", displayName: "Nico" });
    expect(() => engine.mergeSpeakers("spk_2", "spk_1")).toThrow(/itself/);
    expect(() => engine.renameSpeaker("spk_9", "X")).toThrow(/unknown speaker/);
    expect(() => engine.renameSpeaker("spk_1", " ")).toThrow(/displayName/);

    // saved: the events are appended, speakers.json and the library reflect them, and reopening replays them
    expect(JSON.parse(readFileSync(join(dir, "speakers.json"), "utf8"))).toEqual([
      { id: "spk_1", displayName: "Nico", utterances: 3 }, { id: "spk_2", displayName: "Speaker 2", utterances: 1, mergedInto: "spk_1" },
    ]);
    const lib = new SessionLibrary(root);
    expect(lib.get(id).speakers).toEqual(["Nico"]);
    expect(lib.list({ q: "surfing" })[0].matches?.[0].speaker).toBe("Nico");
    const again = new Engine({ sessionsDir: root });
    again.openSession(id);
    const replayed = again.bus.history().filter((e) => e.type.startsWith("speaker."));
    expect(replayed.map((e) => e.type)).toEqual(["speaker.created", "speaker.updated", "speaker.created", "speaker.updated", "speaker.merged", "speaker.updated"]);
    expect(replayed.map((e) => e.seq)).toEqual([...replayed.map((e) => e.seq)].sort((x, y) => x - y));
  });
});

test("a recording that cannot be read is skipped, and the rest are still listed", () => {
  const root = mkdtempSync(join(tmpdir(), "lib-broken-"));
  makeSession(root, "20260924-100000", { startedAt: "2026-09-24T10:00:00Z", lines: [["u_1", "Hello there."]] });
  mkdirSync(join(root, "20260924-110000", "events.jsonl"), { recursive: true }); // a directory where a file should be
  writeFileSync(join(root, "20260924-110000", "session.json"), JSON.stringify({ id: "20260924-110000", mode: "live", startedAt: "2026-09-24T11:00:00Z" }));
  expect(new SessionLibrary(root).list().map((s) => s.id)).toEqual(["20260924-100000"]);
});

describe("recordings made before label sets", () => {
  test("open with their set, stats, and sections in the new format; new recordings are passed through", () => {
    const root = mkdtempSync(join(tmpdir(), "library-"));
    const legacy = JSON.parse(readFileSync("tests/fixtures/legacy-session.json", "utf8"));
    const dir = makeSession(root, "20260925-202620", { startedAt: legacy.startedAt, lines: [["u_1", "Hello."]] });
    writeFileSync(join(dir, "session.json"), JSON.stringify(legacy));
    const old = [
      ev("section.updated", { sections: [{ id: "sec_1", subject: "tech", lane: "tech", segmentIds: ["seg_1"], startMs: 0, endMs: 9000 }] }),
      ev("stats", { roganIndex: 0.12, labelledMs: 9000, speakers: [{ speakerId: "spk_1", displayName: "Nic", talkMs: 4000, disagreements: 3, hype: 2 }], predictions: [], recommendations: [], clips: [] }),
    ];
    writeFileSync(join(dir, "events.jsonl"), readFileSync(join(dir, "events.jsonl"), "utf8") + old.join("\n") + "\n");
    const lib = new SessionLibrary(root);

    const snap = lib.snapshot("20260925-202620");
    expect(snap.labels).toMatchObject({ set: { format: "tattle-labels", categories: [{ id: "subject" }, { id: "mode" }] }, stories: [], version: legacy.labelSetVersion });
    const events = lib.events("20260925-202620");
    expect(events.find((e) => e.type === "section.updated")!.data).toEqual({ sections: [{ id: "sec_1", category: "subject", option: "tech", lane: "tech", segmentIds: ["seg_1"], startMs: 0, endMs: 9000 }] });
    expect(events.find((e) => e.type === "stats")!.data).toMatchObject({ version: 2, index: { name: "Off-topic", share: 0.12 }, speakers: [{ markers: { disagreement: 3 }, scores: { hype: 2 } }] });

    // a recording made with labels off since label sets: null, and its events untouched
    const off = makeSession(root, "20260929-100000", { startedAt: "2026-09-29T10:00:00Z", lines: [["u_1", "Hi."]] });
    writeFileSync(join(off, "session.json"), JSON.stringify({ id: "20260929-100000", mode: "live", startedAt: "2026-09-29T10:00:00Z", streams: ["host"], features: { factcheck: false, labels: false }, labelSet: null, stories: [], labelSetVersion: "" }));
    expect(lib.snapshot("20260929-100000").labels).toEqual({ set: null, stories: [], version: "" });
    expect(lib.snapshot("20260929-100000").session.features).toEqual({ factcheck: false, labels: false });
  });
});

describe("the library, case by case", () => {
  afterEach(() => setAppPaths());
  afterAll(() => cleanTmpDirs());
  const E = (seq: number, type: string, data: Record<string, unknown>) => JSON.stringify({ seq, type, at: "2026-09-25T10:00:00.000Z", data });
  /** A bare recording folder: session.json, and events as given. */
  function bare(root: string, id: string, session: unknown, events: string[] = []) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), typeof session === "string" ? session : JSON.stringify(session));
    if (events.length) writeFileSync(join(dir, "events.jsonl"), events.join("\n") + "\n");
    return dir;
  }

  test("no recordings folder yet: an empty list; by default, the app's folder", () => {
    expect(new SessionLibrary(join(tmpDir("lib-"), "missing")).list()).toEqual([]);
    const { sessions } = withAppPaths();
    expect(new SessionLibrary().root).toBe(sessions);
  });

  test("only safe names with a session.json are recordings", () => {
    const root = tmpDir("lib-");
    bare(root, "20260925-120000", { startedAt: "2026-09-25T12:00:00Z" });
    bare(root, ".import-abc", { startedAt: "x" });
    bare(root, "_hidden", { startedAt: "x" });
    mkdirSync(join(root, "20260925-130000")); // no session.json
    writeFileSync(join(root, "deleted-spend.jsonl"), "");
    expect(new SessionLibrary(root).list().map((s) => s.id)).toEqual(["20260925-120000"]);
  });

  test("a summary from damaged or older files: unknown mode, no start, no streams, no events", () => {
    const root = tmpDir("lib-");
    bare(root, "20260925-120000", "{ not json");
    bare(root, "20260925-130000", { mode: "rehearsal" });
    const lib = new SessionLibrary(root);
    expect(lib.get("20260925-120000")).toMatchObject({ mode: "unknown", startedAt: null, streams: [], ended: false, utterances: 0, durationMs: 0, speakers: [], appVersion: null, imported: null, hasAudio: false });
    expect(lib.get("20260925-130000").mode).toBe("unknown");
    // without a start time, sorted by id, newest first
    expect(lib.list().map((s) => s.id)).toEqual(["20260925-130000", "20260925-120000"]);
    expect(lib.list({ limit: 1 }).map((s) => s.id)).toEqual(["20260925-130000"]);
    expect(lib.snapshot("20260925-120000")).toMatchObject({ session: { features: { factcheck: true, labels: true } }, labels: undefined, s1: { active: "s1@1", versions: [], memory: [] } });
  });

  test.fails("BUG §11.9: a recording without a start time is sorted by its id among dated ones, newest first", () => {
    // the sort compares an ISO start ("2026-09-25T14…") with an id ("20260925-13…"): "0" > "-", so every undated
    // recording comes before every dated one, whatever its date
    const root = tmpDir("lib-");
    bare(root, "20260925-130000", { mode: "live" });
    bare(root, "20260925-140000", { startedAt: "2026-09-25T14:00:00Z" });
    expect(new SessionLibrary(root).list().map((s) => s.id)).toEqual(["20260925-140000", "20260925-130000"]);
  });

  test("durations: the longer WAV; without audio, the export's duration, else the last line's end", () => {
    const root = tmpDir("lib-");
    const a = bare(root, "20260925-120000", { startedAt: "x" }, [E(1, "utterance", { id: "u_1", endMs: 4200, text: "a" }), E(2, "utterance", { id: "u_2", text: "b" })]);
    writeFileSync(join(a, "host.wav"), Buffer.alloc(44 + 32_000));
    writeFileSync(join(a, "remote.wav"), Buffer.alloc(44 + 64_000));
    const b = bare(root, "20260925-130000", { startedAt: "x" }, [E(1, "utterance", { id: "u_1", endMs: 4200, text: "a" })]);
    writeFileSync(join(b, "imported.json"), JSON.stringify({ importedAt: "t", manifest: { recording: { durationMs: 99_000, recordedWith: "0.9.0" } } }));
    bare(root, "20260925-140000", { startedAt: "x" }, [E(1, "utterance", { id: "u_1", endMs: 4200, text: "a" })]);
    const lib = new SessionLibrary(root);
    expect(lib.get("20260925-120000")).toMatchObject({ durationMs: 2000, hasAudio: true });
    expect(lib.get("20260925-130000")).toMatchObject({ durationMs: 99_000, hasAudio: false, appVersion: "0.9.0", imported: { at: "t", exportedWith: null, fileName: null } });
    expect(lib.get("20260925-140000").durationMs).toBe(4200);
  });

  test("cost: only call rows with a number count, by bucket", () => {
    const root = tmpDir("lib-");
    const dir = bare(root, "20260925-120000", { startedAt: "x" });
    const rows = (r: unknown[]) => r.map((x) => JSON.stringify(x)).join("\n") + "\n";
    writeFileSync(join(dir, "transcriptions.jsonl"), rows([{ kind: "transcription", cost_usd: 0.1 }, { kind: "live_transcription", cost_usd: 0.05 }, { kind: "transcription", cost_usd: "1" }]));
    writeFileSync(join(dir, "s2_calls.jsonl"), rows([{ kind: "s2_call", cost_usd: 0.2 }, { kind: "other", cost_usd: 5 }]) + "{ torn");
    writeFileSync(join(dir, "jev_calls.jsonl"), rows([{ kind: "jev_call", cost_usd: 0.01 }]));
    const s = new SessionLibrary(root).get("20260925-120000");
    expect(s.cost.transcription).toBeCloseTo(0.15);
    expect(s.cost.s2).toBeCloseTo(0.2);
    expect(s.cost.jev).toBeCloseTo(0.01);
    expect(s.costUsd).toBeCloseTo(0.36);
  });

  test("the summary is cached until one of its files changes", () => {
    const root = tmpDir("lib-");
    const dir = bare(root, "20260925-120000", { startedAt: "x" }, [E(1, "utterance", { id: "u_1", text: "a" })]);
    const lib = new SessionLibrary(root);
    const first = lib.get("20260925-120000");
    expect(lib.get("20260925-120000")).toBe(first);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ name: "Renamed elsewhere" }));
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(dir, "meta.json"), later, later); // a new mtime, as another process's write gives it
    expect(lib.get("20260925-120000").name).toBe("Renamed elsewhere");
  });

  test("speakers: from speakers.json without merged ones, else from the events", () => {
    const root = tmpDir("lib-");
    const dir = bare(root, "20260925-120000", { startedAt: "x" }, [
      E(1, "speaker.created", { id: "spk_1", displayName: "Speaker 1", stream: "host" }),
      E(2, "speaker.created", { id: "spk_2", displayName: "Speaker 2", stream: "remote" }),
      E(3, "speaker.merged", { fromId: "spk_2", intoId: "spk_1", displayName: "Speaker 1" }),
    ]);
    const lib = new SessionLibrary(root);
    expect(lib.get("20260925-120000").speakers).toEqual(["Speaker 1"]);
    writeFileSync(join(dir, "speakers.json"), JSON.stringify([{ id: "spk_1", displayName: "Nic" }, { id: "spk_2", displayName: 7, mergedInto: "spk_1" }, { id: "spk_3", displayName: 3 }]));
    expect(new SessionLibrary(root).get("20260925-120000").speakers).toEqual(["Nic", "3"]);
  });

  test("search: all words in one line, or all in the metadata; never split across the two", () => {
    const root = tmpDir("lib-");
    const long = `${"x".repeat(60)} the needle is here ${"y".repeat(120)}`;
    bare(root, "20260925-120000", { startedAt: "2026-09-25T12:00:00Z" }, [
      E(1, "speaker.created", { id: "spk_1", displayName: "Speaker 1", stream: "host" }),
      ...Array.from({ length: 7 }, (_, i) => E(i + 2, "utterance", { id: `u_${i}`, startMs: i, speakerId: "spk_1", speakerName: "Speaker 1", text: `Surfing at Bondi, take ${i}` })),
      E(20, "utterance", { id: "u_long", startMs: 99, speakerId: "spk_1", speakerName: "Speaker 1", text: long }),
      E(21, "utterance", { id: "u_ghost", startMs: 100, speakerId: "spk_9", speakerName: "Old name", text: "a ghost line" }),
      E(22, "utterance", { id: "u_empty", startMs: 101, speakerId: "spk_1" }),
    ]);
    writeFileSync(join(root, "20260925-120000", "meta.json"), JSON.stringify({ name: "Beach episode", notes: "  " }));
    const lib = new SessionLibrary(root);
    const r = lib.list({ q: "SURFING bondi" });
    expect(r[0].matches!.length).toBe(5); // at most 5 lines per recording
    expect(lib.list({ q: "beach surfing" })).toEqual([]); // one word in the name, one in a line
    const meta = lib.list({ q: "beach" });
    expect(meta[0].matches).toEqual([]); // a match on the name only
    expect(meta[0].notes).toBeNull();
    const snip = lib.list({ q: "needle" })[0].matches![0].snippet;
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip).toContain("the needle is here");
    expect(lib.list({ q: "ghost" })[0].matches![0].speaker).toBe("Old name"); // a speaker never named in the events
    expect(lib.transcript("20260925-120000").find((l) => l.id === "u_ghost")!.speaker).toBe("Old name");
  });

  test("events: a session event naming another id is corrected, with its folder when it had one", () => {
    const root = tmpDir("lib-");
    const dir = bare(root, "20260925-120000-2", { startedAt: "x" }, [
      E(1, "session.started", { sessionId: "20260925-120000", mode: "live", s1Version: "s1@1", labelSetVersion: "v", dir: "/Users/someone/sessions/20260925-120000" }),
      E(2, "utterance", { id: "u_1", sessionId: "20260925-120000", text: "untouched" }),
      E(3, "session.ended", { sessionId: "20260925-120000", reason: "stopped" }),
      E(4, "session.paused", { sessionId: "20260925-120000-2", atMs: 1 }),
    ]);
    const ev2 = new SessionLibrary(root).events("20260925-120000-2");
    expect(ev2[0].data).toMatchObject({ sessionId: "20260925-120000-2", dir });
    expect(ev2[1].data.sessionId).toBe("20260925-120000");
    expect(ev2[2].data).toEqual({ sessionId: "20260925-120000-2", reason: "stopped" });
    expect(ev2[3].data).toEqual({ sessionId: "20260925-120000-2", atMs: 1 });
  });

  test("events of a recording whose session.json is damaged pass through as they are", () => {
    const root = tmpDir("lib-");
    bare(root, "20260925-120000", "{ damaged", [E(1, "speaker.created", { id: "spk_1", displayName: "A", stream: "host" })]);
    expect(new SessionLibrary(root).events("20260925-120000").map((e) => e.type)).toEqual(["speaker.created"]);
  });

  test("labels: stories from the old config, and a missing version", () => {
    const root = tmpDir("lib-");
    bare(root, "20260925-120000", { startedAt: "x", labelSet: null, config: { timeline: { stories: ["Old story"] } } });
    bare(root, "20260925-130000", { startedAt: "x", labelSet: null });
    const lib = new SessionLibrary(root);
    expect(lib.snapshot("20260925-120000").labels).toEqual({ set: null, stories: ["Old story"], version: "" });
    expect(lib.snapshot("20260925-130000").labels).toEqual({ set: null, stories: [], version: "" });
  });

  test("speaker edits: a merge adds up the lines, counting missing ones as 0; without speakers.json only the event is kept", () => {
    const root = tmpDir("lib-");
    const dir = bare(root, "20260925-120000", { startedAt: "x" }, [E(1, "speaker.created", { id: "spk_1", displayName: "A", stream: "host" })]);
    const lib = new SessionLibrary(root);
    lib.recordSpeakerEdit("20260925-120000", { seq: 2, type: "speaker.updated", at: "x", data: { id: "spk_1", displayName: "B" } });
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").length).toBe(2);
    writeFileSync(join(dir, "speakers.json"), JSON.stringify([{ id: "spk_1", displayName: "B" }, { id: "spk_2", displayName: "C" }]));
    lib.recordSpeakerEdit("20260925-120000", { seq: 3, type: "speaker.merged", at: "x", data: { fromId: "spk_2", intoId: "spk_1", displayName: "B" } });
    lib.recordSpeakerEdit("20260925-120000", { seq: 4, type: "speaker.updated", at: "x", data: { id: "spk_9", displayName: "nobody" } });
    lib.recordSpeakerEdit("20260925-120000", { seq: 5, type: "speaker.merged", at: "x", data: { fromId: "spk_9", intoId: "spk_1", displayName: "B" } });
    expect(JSON.parse(readFileSync(join(dir, "speakers.json"), "utf8"))).toEqual([
      { id: "spk_1", displayName: "B", utterances: 0 }, { id: "spk_2", displayName: "C", mergedInto: "spk_1" },
    ]);
  });

  test("merges are followed to the survivor, and a cycle stops", () => {
    const sp = { names: new Map([["a", "A"], ["b", "B"]]), mergedInto: new Map([["a", "b"], ["b", "a"]]) };
    expect(["a", "b"]).toContain(resolveRecorded(sp, "a"));
    expect(resolveRecorded({ names: new Map(), mergedInto: new Map([["x", "y"], ["y", "z"]]) }, "x")).toBe("z");
  });

  test("the call log: the last rows, at least one; no config, no models", () => {
    const root = tmpDir("lib-");
    const dir = bare(root, "20260925-120000", { startedAt: "x" });
    writeFileSync(join(dir, "s2_calls.jsonl"), [1, 2, 3].map((n) => JSON.stringify({ n })).join("\n") + "\n");
    const lib = new SessionLibrary(root);
    expect(lib.calls("20260925-120000", "s2", 0).rows).toEqual([{ n: 3 }]);
    expect(lib.calls("20260925-120000", "s2")).toEqual({ rows: [{ n: 1 }, { n: 2 }, { n: 3 }], models: { s1: null, s2: null } });
    expect(lib.calls("20260925-120000", "s1").rows).toEqual([]);
  });

  test("voices: what the recording ran with, or null before voices were recorded", () => {
    const root = tmpDir("lib-");
    bare(root, "20260925-120000", { startedAt: "x", voices: { host: 1, remote: 2 } });
    bare(root, "20260925-130000", { startedAt: "x" });
    const lib = new SessionLibrary(root);
    expect(lib.voicesOf("20260925-120000").voices).toEqual({ host: 1, remote: 2 });
    expect(lib.voicesOf("20260925-130000")).toEqual({ dir: join(root, "20260925-130000"), voices: null });
  });

  test("names and notes: only strings, notes up to 4,000 characters, a blank name clears it", () => {
    const root = tmpDir("lib-");
    bare(root, "20260925-120000", { startedAt: "x" });
    const lib = new SessionLibrary(root);
    expect(() => lib.update("20260925-120000", { notes: 5 as never })).toThrow("notes must be a string");
    expect(() => lib.update("20260925-120000", { notes: "n".repeat(4001) })).toThrow("notes is too long");
    expect(lib.update("20260925-120000", { name: "A", notes: "n".repeat(4000) }).name).toBe("A");
    expect(lib.update("20260925-120000", { name: "   " }).name).toBeNull();
  });

  test("remove deletes the folder for good", () => {
    const root = tmpDir("lib-");
    bare(root, "20260925-120000", { startedAt: "x" });
    const lib = new SessionLibrary(root);
    lib.remove("20260925-120000");
    expect(lib.list()).toEqual([]);
    expect(() => lib.get("20260925-120000")).toThrow("unknown session 20260925-120000");
  });
});
