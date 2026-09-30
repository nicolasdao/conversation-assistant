import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wavHeader } from "../../src/audio/wav.ts";

export let seq = 0;
export const ev = (type: string, data: Record<string, unknown>) => JSON.stringify({ seq: ++seq, type, at: "2026-09-25T10:00:00.000Z", data });

export function makeSession(root: string, id: string, o: { mode?: string; startedAt: string; lines: [string, string][]; cost?: number; ended?: boolean }) {
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

/** 3 s of a tone at 16 kHz, as the app writes its WAVs. */
export function toneWav(seconds: number, hz: number): Buffer {
  const n = seconds * 16_000;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 16_000) * 8000), i * 2);
  return Buffer.concat([wavHeader(pcm.length, 16_000), pcm]);
}

export function recording(root: string, id = "20260925-120000") {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id, app: { name: "conversation-assistant", version: "0.2.0" }, mode: "live", startedAt: "2026-09-25T12:00:00Z", streams: ["host", "remote"] }));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ name: "Episode 12: a/b" }));
  writeFileSync(join(dir, "events.jsonl"), [
    { seq: 1, type: "session.started", at: "x", data: { sessionId: id, mode: "live", s1Version: "s1@1", labelSetVersion: "a" } },
    { seq: 2, type: "utterance", at: "x", data: { id: "u_1", stream: "host", startMs: 0, endMs: 2500, speakerId: "spk_1", speakerName: "Nic", text: "Hello", tags: [] } },
    { seq: 3, type: "session.ended", at: "x", data: { sessionId: id, reason: "stopped" } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "jev_calls.jsonl"), JSON.stringify({ kind: "jev_call", cost_usd: 0.25 }) + "\n");
  writeFileSync(join(dir, "chats.jsonl"), JSON.stringify({ kind: "chat", op: "create", chat_id: "chat_1", title: "Private", model: "m", at: "x" }) + "\n");
  writeFileSync(join(dir, "host.wav"), toneWav(3, 440));
  writeFileSync(join(dir, "remote.wav"), toneWav(3, 660));
  return dir;
}
