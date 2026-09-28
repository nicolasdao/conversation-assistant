import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SessionLibrary } from "../src/store/library.ts";
import { Engine } from "../src/server/main.ts";

let seq = 0;
const ev = (type: string, data: Record<string, unknown>) => JSON.stringify({ seq: ++seq, type, at: "2026-09-25T10:00:00.000Z", data });

function makeSession(root: string, id: string, o: { mode?: string; startedAt: string; lines: [string, string][]; cost?: number; ended?: boolean }) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id, mode: o.mode ?? "live", startedAt: o.startedAt, streams: ["host", "remote"], labelSetVersion: "abc", s1Version: "s1@1" }));
  const events = [
    ev("session.started", { sessionId: id, mode: o.mode ?? "live", s1Version: "s1@1", labelSetVersion: "abc" }),
    ev("speaker.created", { id: "spk_1", displayName: "Speaker 1", stream: "host" }),
    ev("speaker.updated", { id: "spk_1", displayName: "Nic" }),
    ...o.lines.map(([id2, text], i) => ev("utterance", { id: id2, stream: "host", startMs: i * 5000, endMs: i * 5000 + 4000, speakerId: "spk_1", speakerName: "Nic", text, tags: [] })),
    ev("segment.closed", { id: "seg_1", startMs: 0, endMs: 9000, forced: false, final: true, utteranceIds: [] }),
    ev("claim.flagged", { claimId: "c_1", utteranceId: "u_1", text: "x", priority: 3, s1Version: "s1@1" }),
    ...(o.ended === false ? [] : [ev("session.ended", { sessionId: id, reason: "end_of_input" })]),
  ];
  writeFileSync(join(dir, "events.jsonl"), events.join("\n") + "\n");
  writeFileSync(join(dir, "jev_calls.jsonl"), JSON.stringify({ kind: "jev_call", cost_usd: o.cost ?? 0.01 }) + "\n");
  writeFileSync(join(dir, "host.wav"), Buffer.alloc(44 + 32_000 * 90)); // 90 s
  return dir;
}

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
