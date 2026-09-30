import { existsSync, readdirSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { Engine } from "../src/server/main.ts";
import { requireAssets } from "./helpers.ts";
import { cleanTmpDirs, FakeEmbedder, silence, tmpDir, transcribeOnlyServices, wavFile } from "./fakes/index.ts";

// The engine itself (src/server/main.ts), offline: fake services, a temporary recordings folder, short WAVs.

afterAll(() => cleanTmpDirs());

/** A folder to replay: one second of silence on the host stream. */
function replayDir(): string {
  const dir = tmpDir("replay-");
  wavFile(dir, silence(16_000), "host.wav");
  return dir;
}

/** An engine whose sessions call no service (transcription answers, nothing else is asked). */
function offlineEngine(extra: ConstructorParameters<typeof Engine>[0] = {}) {
  const sessionsDir = tmpDir("sessions-");
  const engine = new Engine({ sessionsDir, ...extra, session: { services: transcribeOnlyServices, embedder: new FakeEmbedder() as never, ...extra.session } });
  return { engine, sessionsDir };
}

describe("Engine.start", () => {
  test("a name over 120 characters is refused before the session starts (B1)", async () => {
    requireAssets();
    const { engine, sessionsDir } = offlineEngine();
    const start = engine.start({ mode: "replay", dir: replayDir(), speed: "max", name: "x".repeat(121), features: { factcheck: false, labels: false } });
    await expect(start).rejects.toMatchObject({ status: 400, message: "name is too long" });
    expect(engine.current).toBeNull();
    expect(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []).toEqual([]);
    // and the next start is not refused as "already running"
    const ok = await engine.start({ mode: "replay", dir: replayDir(), speed: "max", name: "  Pilot  ", features: { factcheck: false, labels: false } });
    expect(engine.library.get(ok.sessionId).name).toBe("Pilot");
    await engine.current!.run();
  });
});
