import { ApiError, type EngineApi, type StartRequest } from "../../src/server/main.ts";
import { EventBus } from "../../src/store/events.ts";

/** A fake pipeline: records every command and emits the events a real session would. */
export class FakeEngine implements EngineApi {
  bus = new EventBus();
  calls: [string, ...unknown[]][] = [];
  names: Record<string, string> = { spk_1: "Speaker 1", spk_2: "Speaker 2" };
  state() { return { session: { id: "s1" }, speakers: this.names }; }
  async start(req: StartRequest) { this.calls.push(["start", req]); return { sessionId: "s1" }; }
  async stop() { this.calls.push(["stop"]); return { sessionId: "s1" }; }
  async devices() { return [{ uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", transport: "builtin", isDefault: true }]; }
  renameSpeaker(id: string, displayName: string) {
    if (!this.names[id]) throw new ApiError(404, "unknown speaker");
    this.names[id] = displayName;
    this.bus.emit("speaker.updated", { id, displayName });
    return { id, displayName };
  }
  mergeSpeakers(fromId: string, intoId: string) { this.calls.push(["merge", fromId, intoId]); return { id: intoId }; }
  relabel() { this.calls.push(["relabel"]); return { segments: 2 }; }
  putStories(h: string[]) { this.calls.push(["stories", h]); return { version: "v2" }; }
  override(id: string, note?: string) { this.calls.push(["override", id, note]); return { id, disputed: true }; }
  rollback(version: string) { this.calls.push(["rollback", version]); return { active: version }; }
  stats() { return { roganIndex: 0.25 }; }
  listSessions(q?: string, all?: boolean) { this.calls.push(["list", q, all]); return [{ id: "20260925-120000", name: "Pilot" }]; }
  getSession(id: string) { if (id !== "20260925-120000") throw new ApiError(404, "unknown session"); return { id }; }
  updateSession(id: string, patch: unknown) { this.calls.push(["update", id, patch]); return { id, ...(patch as object) }; }
  openSession(id: string) { this.calls.push(["open", id]); return { sessionId: id, events: 12 }; }
  deleteSession(id: string) { this.calls.push(["delete", id]); return { deleted: id }; }
  closeView() { this.calls.push(["close"]); return { closed: "20260925-120000" }; }
  pause() { this.calls.push(["pause"]); return { paused: true }; }
  audioDir = "";
  sessionDir(id: string) { if (id !== "20260925-120000") throw new ApiError(404, "unknown session"); return this.audioDir; }
  async speakerSuggestions(v?: number) { this.calls.push(["suggest", v]); return { suggestions: [], voices: { host: 1, remote: v ?? 2 } }; }
  callLog(system: "s1" | "s2", limit?: number) { return { rows: [{ system, limit }], models: { s1: "typesafe/jev-1.13", s2: "openai/gpt-6-luna" } }; }
  resume() { this.calls.push(["resume"]); return { paused: false }; }
}
