import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { run } from "../src/cli/replay.ts";
import { setAppPaths } from "../src/paths.ts";
import { appleSpeechStatus, macosSupportsAppleSpeech } from "../src/transcribe/apple.ts";
import { FIXTURE_DIR, loadScript, requireAssets } from "./helpers.ts";
import { cleanTmpDirs, fakeServicesFetch, fixtureSlice, silence, snapshotKeyEnv, tmpDir, wavFile, withEnv } from "./fakes/index.ts";

// `npm run replay` (src/cli/replay.ts), run in process through its run(argv, deps): a fake fetch for every service,
// a temporary recordings folder, keys and settings in a temporary home, and the output and exit captured.

const restoreKeys = snapshotKeyEnv();
let home = "";
let sigint: Function[] = [];
beforeEach(() => {
  home = tmpDir("home-");
  sigint = process.listeners("SIGINT");
});
afterEach(() => {
  restoreKeys();
  setAppPaths();
  // each run listens for Ctrl-C to stop its session; drop what the test added
  for (const l of process.listeners("SIGINT")) if (!sigint.includes(l)) process.removeListener("SIGINT", l as never);
});
afterAll(() => cleanTmpDirs());

/** Runs the command; returns what it printed, the exit codes it asked for, and its stderr. */
async function replay(argv: string[], env: Record<string, string | undefined> = {}, fetchFn?: typeof fetch) {
  const out: string[] = [];
  const codes: number[] = [];
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const sessionsDir = tmpDir("sessions-");
  try {
    await withEnv({
      TATTLE_CREDENTIALS: join(home, "credentials.json"), TATTLE_SETTINGS: join(home, "settings.json"), HOME: home,
      TATTLE_FORCE_NO_APPLE_SPEECH: "1", OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, ...env,
    }, () => run(argv, { fetch: fetchFn, sessionsDir, stdout: (t) => out.push(t), exit: (c) => codes.push(c) }));
    return { text: out.join(""), codes, errors: err.mock.calls.map((c) => String(c[0])), sessionsDir };
  } finally {
    err.mockRestore();
  }
}

describe("npm run replay", () => {
  test("no WAV given: the usage, exit 1, before any key is read", async () => {
    const r = await replay([]);
    expect(r.codes).toEqual([1]);
    expect(r.errors[0]).toMatch(/^usage: npm run replay -- --host <host.wav>/);
    expect(r.text).toBe("");
  });

  test("an unknown engine: exit 1", async () => {
    const r = await replay(["--host", "x.wav", "--engine", "whisper"]);
    expect([r.codes, r.errors]).toEqual([[1], ["--engine must be apple or openai"]]);
  });

  test("Apple Speech where it cannot run: exit 1 with the reason", async () => {
    const r = await replay(["--host", "x.wav", "--engine", "apple"]);
    expect(r.codes).toEqual([1]);
    expect(r.errors).toEqual(["on-device transcription is not available: Needs macOS 26 or later"]);
  });

  describe.skipIf(!macosSupportsAppleSpeech())("with a stand-in for the tattle-transcribe helper", () => {
    /** A helper script: `status` answers --status, `install` runs for --install; anything else reads its input until it closes. */
    async function helper(status: string, install = "exit 0") {
      const bin = join(tmpDir("bin-"), "tattle-transcribe");
      writeFileSync(bin, ["#!/bin/sh", 'case "$1" in', `  --status) echo '${status}' ;;`, `  --install) ${install} ;;`, "  *) cat >/dev/null ;;", "esac"].join("\n") + "\n");
      chmodSync(bin, 0o755);
      setAppPaths({ transcriber: bin });
      // the status is kept for the process: ask this helper afresh
      await withEnv({ TATTLE_FORCE_NO_APPLE_SPEECH: undefined }, () => appleSpeechStatus({ refresh: true }));
    }
    const apple = { TATTLE_FORCE_NO_APPLE_SPEECH: undefined };

    test("a status check that fails, or says no without a reason: exit 1 with what it said", async () => {
      await helper("not json");
      const r = await replay(["--host", "x.wav", "--engine", "apple"], apple);
      expect(r.codes).toEqual([1]);
      expect(r.errors[0]).toMatch(/^on-device transcription is not available: no answer from tattle-transcribe --status/);
      await helper('{"available":false}');
      expect((await replay(["--host", "x.wav", "--engine", "apple"], apple)).errors).toEqual(["on-device transcription is not available: unknown reason"]);
    });

    test("without its model, a failed install stops the replay", async () => {
      await helper('{"available":true,"installed":false,"locale":"en-US"}', `echo '{"type":"progress","fraction":0.5}'; echo '{"type":"error","message":"the model could not download"}'; exit 1`);
      await expect(replay(["--host", "x.wav", "--engine", "apple"], apple)).rejects.toThrow("the model could not download");
    });

    test("without its model, the replay installs it first, showing progress, then transcribes on this Mac", async () => {
      requireAssets();
      await helper('{"available":true,"installed":false,"locale":"en-US"}', `echo '{"type":"progress","fraction":0.25}'; echo '{"type":"progress","fraction":1}'; exit 0`);
      const dir = tmpDir("wav-");
      wavFile(dir, silence(16_000), "host.wav");
      const r = await replay(["--host", join(dir, "host.wav"), "--engine", "apple", "--no-factcheck", "--no-labels", "--quiet"], apple);
      expect(r.text.startsWith("installing the on-device speech model...\n\r  25 %\r  100 %\n")).toBe(true);
      expect(r.text).toContain("transcription: on this Mac (Apple Speech); fact-checking off, labels off");
      expect(r.codes).toEqual([0]);
    });
  });

  test("Ctrl-C stops the session, which still ends with its summary", async () => {
    requireAssets();
    const dir = tmpDir("wav-");
    wavFile(dir, silence(16_000 * 30), "host.wav"); // 30 s at real time: stopped long before
    const before = process.listeners("SIGINT");
    const running = replay(["--host", join(dir, "host.wav"), "--speed", "1", "--engine", "openai", "--quiet", "--no-factcheck", "--no-labels"]);
    let stop: Function | undefined;
    for (let i = 0; i < 500 && !stop; i++) {
      stop = process.listeners("SIGINT").find((l) => !before.includes(l));
      if (!stop) await new Promise((r) => setTimeout(r, 10));
    }
    expect(stop).toBeDefined();
    const t0 = Date.now();
    stop!();
    const r = await running;
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.codes).toEqual([0]);
    expect(r.text).toContain("── summary ──");
  });

  test("the defaults: the real output and exit", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run([]);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
    requireAssets();
    const dir = tmpDir("wav-");
    wavFile(dir, silence(8_000), "host.wav");
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation(((t: string) => { written.push(String(t)); return true; }) as never);
    const codes: number[] = [];
    try {
      await withEnv({ TATTLE_CREDENTIALS: join(home, "credentials.json"), TATTLE_SETTINGS: join(home, "settings.json"), TATTLE_FORCE_NO_APPLE_SPEECH: "1" }, () =>
        run(["--host", join(dir, "host.wav"), "--engine", "openai", "--quiet", "--no-factcheck", "--no-labels"], { sessionsDir: tmpDir("sessions-"), exit: (c) => codes.push(c) }));
    } finally {
      out.mockRestore();
    }
    expect(codes).toEqual([0]);
    expect(written.join("")).toContain("── summary ──");
  });

  test("quiet, transcript only, from the saved engine: only the summary", async () => {
    requireAssets();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ transcriptionEngine: "openai" }));
    const dir = tmpDir("wav-");
    wavFile(dir, silence(16_000), "host.wav");
    const r = await replay(["--host", join(dir, "host.wav"), "--quiet", "--no-factcheck", "--no-labels", "--speed", "1"], {}, (async () => { throw new Error("nothing is called"); }) as unknown as typeof fetch);
    expect(r.codes).toEqual([0]);
    expect(r.text.split("\n")[0]).toBe("transcription: OpenAI; fact-checking off, labels off");
    expect(r.text).toContain("\n── summary ──\n");
    expect(r.text).toMatch(/utterances {2}0\n/);
    expect(r.text).toMatch(/verdicts {4}none\n/);
    expect(r.text).not.toContain("export ");
    expect(readdirSync(r.sessionsDir).length).toBe(1); // the recording went to the folder given
  });

  test("the fixture at full speed, with every feature: each event printed, then the summary and the export", async () => {
    const script = loadScript();
    const services = fakeServicesFetch(script).f;
    // System 2's first research fails (the claim is dropped); its second verdict carries a correction
    let verdicts = 0;
    const f = (async (url: string, init: RequestInit) => {
      if (url.includes("chat/completions") && JSON.parse(String(init.body)).response_format?.json_schema?.name === "verdict") {
        verdicts++;
        if (verdicts === 1) return new Response(JSON.stringify({ error: { code: 400, message: "bad request" } }), { status: 400 });
        if (verdicts === 2) {
          const content = { restated_claim: "A claim.", verdict: "contradicted", correction: "It is cheaper.", confidence: "high", false_alarm_reason: "none", sources: [{ url: "https://example.com/b", title: "B" }] };
          return new Response(JSON.stringify({ id: "gen-2", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ message: { content: JSON.stringify(content), annotations: [] } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0003 } }));
        }
      }
      return services(url, init);
    }) as unknown as typeof fetch;
    const out = join(tmpDir("export-"), "boundary.jsonl");
    const r = await replay(["--host", `${FIXTURE_DIR}/host.wav`, "--remote", `${FIXTURE_DIR}/remote.wav`, "--engine", "openai", "--export", out], {}, f);
    expect(r.text).toMatch(/ {2}✗ c_\d+ dropped: research_failed/);
    expect(r.text).toMatch(/ {2}✓ c_\d+ contradicted: A claim\. — It is cheaper\. \(1 sources, \d+ ms\)/);
    expect(r.codes).toEqual([0]);
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("transcription: OpenAI; fact-checking on, labels on");
    expect(lines.filter((l) => /^\[\d+\.\ds\] .+: .+/.test(l)).length).toBeGreaterThanOrEqual(8); // utterances
    expect(r.text).toMatch(/ {2}── seg_\d+ closed \(\d+\.\d s(, forced)?\)/);
    expect(r.text).toMatch(/ {2}── seg_\d+ labels: \w+=\S+ .*markers=\[/);
    expect(r.text).toMatch(/ {2}⚑ c_\d+ flagged \(priority \d\.\d\d\): /);
    expect(r.text).toMatch(/ {2}✓ c_\d+ supported: A claim\. {2}\(1 sources, \d+ ms\)/);
    expect(r.text).toMatch(/ {2}↺ claim\.(repeat|duplicate) of c_\d+ by u_\d+/);
    expect(r.text).toMatch(/ {2}! \S+: /); // the fake's one refused Jev call
    expect(r.text).toMatch(/export {6}.*boundary\.jsonl\n$/);
    expect(r.text).toMatch(/cost {8}\$\d+\.\d{4} \(transcription \$/);
    const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ utterance_id: expect.any(String), boundary_p: expect.any(Number), human_boundary: null });
  });

  test.fails("BUG §11.19: a replay whose credit ran out exits non-zero, so a script can tell", async () => {
    requireAssets();
    const dir = tmpDir("wav-");
    wavFile(dir, fixtureSlice("host", 0, 15_000), "host.wav");
    // transcription answers; OpenRouter says the credit is gone (402, not retried)
    const f = (async (url: string) => {
      if (url.includes("audio/transcriptions")) return new Response(JSON.stringify({ text: "Jev is four hundred times cheaper." }));
      return new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { status: 402 });
    }) as unknown as typeof fetch;
    const r = await replay(["--host", join(dir, "host.wav"), "--engine", "openai"], {}, f);
    expect(r.text).toContain("  $ budget exhausted: ");
    expect(r.codes).toEqual([1]); // today: 0
  });
});
