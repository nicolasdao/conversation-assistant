import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { FileSource } from "../src/audio/source.ts";
import { Session, type Services } from "../src/pipeline/session.ts";
import type { TranscriptionResult } from "../src/transcribe/openai.ts";
import { EventBus } from "../src/store/events.ts";
import { FIXTURE_DIR, requireAssets } from "./helpers.ts";

/** Transcription that is down for the first `downFor` calls, then answers with `text`. */
function flaky(downFor: number, failure: TranscriptionResult = { ok: false, error: "TypeError: fetch failed", retryable: true }, text = "words said here") {
  let calls = 0;
  const services = (): Services => ({
    transcribe: async () => (++calls <= downFor ? failure : { ok: true, text, filler: false }),
    ask: async () => { throw new Error("Jev is not called with both features off"); },
    s2: {} as never,
  });
  return { services, calls: () => calls };
}

async function run(services: () => Services, retryEveryMs?: number) {
  const bus = new EventBus();
  const s = new Session({
    mode: "replay", config: loadConfig(), bus, sessionsDir: mkdtempSync(join(tmpdir(), "sessions-")), services,
    features: { factcheck: false, labels: false }, ...(retryEveryMs ? { retryEveryMs } : {}),
    sources: [new FileSource(`${FIXTURE_DIR}/host.wav`, "host", "max"), new FileSource(`${FIXTURE_DIR}/remote.wav`, "remote", "max")],
  });
  await s.run();
  const events = bus.history();
  const of = (type: string) => events.filter((e) => e.type === type).map((e) => e.data as any);
  return { s, events, of };
}

describe("lines whose transcription failed", () => {
  test("a network drop keeps the line in place and a retry recovers it, in time order, for the transcript and the chat", async () => {
    requireAssets();
    const { services } = flaky(4); // the first 4 lines fail (the connection is down), later calls work
    // no periodic pass mid-session, however slow the machine: it would take one of the 4 failures (only the final pass runs)
    const { s, of, events } = await run(services, 3_600_000);
    const failed = of("utterance.failed");
    expect(failed.filter((d) => d.status === "retrying")).toHaveLength(4);
    const recovered = of("utterance").filter((d) => d.recovered);
    expect(recovered.map((d) => d.id).sort()).toEqual(failed.map((d) => d.id).sort());
    // every recovered line comes after its placeholder, and no line ends up missing
    for (const d of recovered) {
      const placeholder = events.findIndex((e) => e.type === "utterance.failed" && (e.data as any).id === d.id);
      const line = events.findIndex((e) => e.type === "utterance" && (e.data as any).id === d.id);
      expect(line).toBeGreaterThan(placeholder);
    }
    expect(failed.some((d) => d.status === "failed")).toBe(false);
    const lines = s.transcriptLines();
    expect(lines.length).toBe(of("utterance").length);
    expect(lines.map((l) => l.startMs)).toEqual([...lines.map((l) => l.startMs)].sort((a, b) => a - b));
  });

  test("still down at the end: the lines are given up, marked failed, and the session still ends", async () => {
    requireAssets();
    const { services, calls } = flaky(Infinity);
    const { of } = await run(services, 3_600_000); // no periodic pass: only the final one, however slow the machine
    const failed = of("utterance.failed");
    const ids = new Set(failed.map((d) => d.id));
    for (const id of ids) expect(failed.filter((d) => d.id === id).map((d) => d.status)).toEqual(["retrying", "failed"]);
    expect(of("utterance")).toHaveLength(0);
    expect(of("session.ended")).toHaveLength(1);
    // the final pass stops at its first failure: one request, not one per line
    expect(calls()).toBe(ids.size + 1);
  });

  test("a failure that is not transient (no credits, a bad request) is not retried", async () => {
    requireAssets();
    const { services, calls } = flaky(Infinity, { ok: false, error: "429 insufficient_quota", retryable: false });
    const { of } = await run(services);
    const failed = of("utterance.failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((d) => d.status === "failed")).toBe(true);
    expect(calls()).toBe(failed.length);
  });
});
