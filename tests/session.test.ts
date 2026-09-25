import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import sherpa from "sherpa-onnx-node";
import { loadConfig } from "../src/config.ts";
import { FileSource } from "../src/audio/source.ts";
import { Session } from "../src/pipeline/session.ts";
import { EventBus, redactor } from "../src/store/events.ts";
import { JSONL_FILES } from "../src/store/sessionStore.ts";
import { Engine } from "../src/server/main.ts";
import { sumDevSpend } from "../src/budget.ts";
import { FIXTURE_DIR, loadScript, requireAssets } from "./helpers.ts";

const OPENROUTER = "sk-or-v1-test-openrouter-key-0123456789";
const OPENAI = "sk-proj-test-openai-key-9876543210";

/**
 * A fake of all three services behind fetch. Transcription returns the scripted line by time; Jev flags lines whose
 * script says `claim`, recognises the repeated line, and marks the topic change as a boundary; one Jev call echoes
 * the key in an error body to prove redaction.
 */
function fakeFetch(script: ReturnType<typeof loadScript>) {
  let transcribeCalls = 0;
  let echoed = false;
  const texts = new Map<string, number>(); // text → line
  for (const l of script.lines) texts.set(l.text, l.line);
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes("audio/transcriptions")) {
      transcribeCalls++;
      const form = init.body as FormData;
      const file = form.get("file") as File;
      const seconds = (file.size - 44) / 32000;
      // match by duration: the closest scripted line
      const line = [...script.lines].sort((a, b) =>
        Math.abs((a.endMs - a.startMs) / 1000 - seconds) - Math.abs((b.endMs - b.startMs) / 1000 - seconds))[0];
      return json({ text: line.text });
    }
    if (url.includes("alpha/decisions")) {
      const body = JSON.parse(init.body as string);
      if (!echoed) {
        echoed = true;
        return json({ error: { code: 401, message: `invalid key ${OPENROUTER}` } }, 400);
      }
      const answers: Record<string, unknown> = {};
      const st = body.state;
      const text: string = st.new_utterance?.text ?? "";
      const line = script.lines.find((l) => l.text === text);
      for (const [id, q] of Object.entries<any>(body.questions)) {
        if (id === "boundary") answers[id] = { type: "noul", noul: line?.expected.topicChange ? 0.9 : 0.1 };
        else if (id === "claim") answers[id] = { type: "noul", noul: line?.expected.claim ? 0.95 : 0.05 };
        else if (id === "claim_type") answers[id] = { type: "choice", choice: line?.expected.claim ? "number_or_price" : "none", confidence: 0.9, probabilities: {} };
        else if (id === "worth") answers[id] = { type: "score", score: line?.expected.claim ? 3.2 : 0.2, confidence: 0.9, probabilities: {} };
        else if (id.startsWith("known_")) answers[id] = { type: "noul", noul: line?.expected.repeatOf && id === "known_c_1" ? 0.95 : 0.02 };
        else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.2 };
        else if (q.type === "score") answers[id] = { type: "score", score: 1, confidence: 0.9, probabilities: {} };
        else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const segText = JSON.stringify(st.segment ?? "");
          const pick = id === "subject" ? (segText.includes("surf") || segText.includes("Bondi") ? "personal_life" : "ai_models") : keys[0];
          answers[id] = { type: "choice", choice: pick, confidence: 0.8, probabilities: {} };
        }
      }
      return json({ answers, id: "gen-dec-x", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", usage: { cost: 0.00002, input_tokens: 400, output_tokens: 10 } });
    }
    if (url.includes("chat/completions")) {
      const body = JSON.parse(init.body as string);
      const schema = body.response_format.json_schema?.name;
      const content = schema === "verdict"
        ? { restated_claim: "A claim.", verdict: "supported", correction: "", confidence: "high", false_alarm_reason: "none", sources: [{ url: "https://example.com/a", title: "A" }] }
        : schema === "audit" ? { items: [] } : { changes: [], rationale: "none" };
      return json({ id: "gen-1", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ message: { content: JSON.stringify(content), annotations: [] } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0003 } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { f: f as unknown as typeof fetch, stats: () => ({ transcribeCalls }) };
}

describe("session (offline, fake services)", () => {
  test("runs the fixture end to end; no event or session file contains either API key", async () => {
    requireAssets();
    const script = loadScript();
    const root = mkdtempSync(join(tmpdir(), "sessions-"));
    const prev = { or: process.env.OPENROUTER_API_KEY, oa: process.env.OPENAI_API_KEY };
    process.env.OPENROUTER_API_KEY = OPENROUTER;
    process.env.OPENAI_API_KEY = OPENAI;
    try {
      const bus = new EventBus({ redact: redactor([OPENROUTER, OPENAI]) });
      const { f } = fakeFetch(script);
      const s = new Session({
        mode: "replay", config: loadConfig(), bus, sessionsDir: root, fetch: f, keys: { openrouter: OPENROUTER, openai: OPENAI },
        sources: [new FileSource(`${FIXTURE_DIR}/host.wav`, "host", "max"), new FileSource(`${FIXTURE_DIR}/remote.wav`, "remote", "max")],
      });
      const live: any[] = [];
      bus.subscribe((e) => { if (e.type === "call" || e.type === "call.started") live.push(e); });
      await s.run();

      const dir = s.store.dir;
      // every Jev and System 2 call streams to the page as it happens, but stays out of the stored history
      const jevRows = readFileSync(join(dir, "jev_calls.jsonl"), "utf8").trim().split("\n").length;
      expect(live.filter((e) => e.type === "call" && e.data.kind === "jev_call").length).toBe(jevRows);
      expect(live.filter((e) => e.type === "call.started" && e.data.system === "s1").length).toBeGreaterThan(0);
      expect(live.find((e) => e.type === "call" && e.data.kind === "jev_call" && e.data.ok)?.data.questions).toBeTruthy();
      expect(live.some((e) => e.type === "call.started" && e.data.system === "s2")).toBe(true);
      expect(bus.history().some((e) => e.type === "call" || e.type === "call.started")).toBe(false);
      const s2rows = readFileSync(join(dir, "s2_calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const researched = s2rows.find((r) => r.purpose === "research" && r.ok);
      expect(researched.request.user.length).toBeGreaterThan(0);
      expect(JSON.parse(researched.response).verdict).toBe("supported");
      for (const f of ["host.wav", "remote.wav", "session.json", "speakers.json", ...JSONL_FILES.map((x) => `${x}.jsonl`)]) {
        expect(existsSync(join(dir, f)), f).toBe(true);
      }
      const speakers = JSON.parse(readFileSync(join(dir, "speakers.json"), "utf8"));
      expect(speakers.filter((x: any) => !x.mergedInto).length).toBe(3);
      const types = bus.history().map((e) => e.type);
      for (const t of ["session.started", "utterance", "speaker.created", "segment.closed", "segment.labels", "claim.flagged", "claim.verdict", "cost", "stats", "session.ended"]) {
        expect(types, t).toContain(t);
      }
      expect(types.at(-1)).toBe("session.ended");
      const seg = readFileSync(join(dir, "segments.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(seg.length).toBeGreaterThanOrEqual(2);
      for (const x of seg) expect(x.end_ms - x.start_ms).toBeLessThanOrEqual(75_000);
      // the recorded WAVs hold the streams as received (the last frame is zero-padded to 512 samples)
      const rec = sherpa.readWave(join(dir, "remote.wav")).samples;
      const orig = sherpa.readWave(`${FIXTURE_DIR}/remote.wav`).samples;
      expect(rec.length - orig.length).toBeGreaterThanOrEqual(0);
      expect(rec.length - orig.length).toBeLessThan(512);
      let maxDiff = 0;
      for (let i = 0; i < orig.length; i += 97) maxDiff = Math.max(maxDiff, Math.abs(rec[i] - orig[i]));
      expect(maxDiff).toBeLessThan(1e-3);

      // the repeated line links to the first claim, with no second research call
      const linked = bus.history().filter((e) => e.type === "claim.repeat" || e.type === "claim.duplicate");
      expect(linked.length).toBe(1);
      expect(linked[0].data.claimId).toBe("c_1");
      const flagged = bus.history().filter((e) => e.type === "claim.flagged").length;
      const research = readFileSync(join(dir, "s2_calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.purpose === "research");
      expect(research.length).toBe(flagged);
      expect(flagged).toBe(3);

      // a rename and a merge after the end are still saved, so reopening the recording shows them
      const [a, b] = speakers.filter((x: any) => !x.mergedInto).map((x: any) => x.id);
      s.renameSpeaker(a, "Nic");
      s.mergeSpeakers(b, a);
      const tail = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").slice(-2).map((l) => JSON.parse(l));
      expect(tail.map((e) => e.type)).toEqual(["speaker.updated", "speaker.merged"]);
      const after = JSON.parse(readFileSync(join(dir, "speakers.json"), "utf8"));
      expect(after.find((x: any) => x.id === a).displayName).toBe("Nic");
      expect(after.find((x: any) => x.id === b).mergedInto).toBe(a);

      // the echoed key was redacted
      expect(bus.history().some((e) => JSON.stringify(e).includes("[redacted]"))).toBe(true);
      for (const file of readdirSync(dir)) {
        const text = readFileSync(join(dir, file)).toString("latin1");
        expect(text.includes(OPENROUTER), file).toBe(false);
        expect(text.includes(OPENAI), file).toBe(false);
      }
      for (const e of bus.history()) {
        const t = JSON.stringify(e);
        expect(t.includes(OPENROUTER) || t.includes(OPENAI)).toBe(false);
      }
      const state = s.state() as any;
      expect(state.segments.length).toBe(seg.length);
    } finally {
      process.env.OPENROUTER_API_KEY = prev.or;
      process.env.OPENAI_API_KEY = prev.oa;
    }
  });

  test("a paused session hears silence: nothing is transcribed and the recorded audio is silent", async () => {
    requireAssets();
    const root = mkdtempSync(join(tmpdir(), "sessions-"));
    const { f, stats } = fakeFetch(loadScript());
    const bus = new EventBus();
    const s = new Session({
      mode: "replay", config: loadConfig(), bus, sessionsDir: root, fetch: f, keys: { openrouter: OPENROUTER, openai: OPENAI },
      sources: [new FileSource(`${FIXTURE_DIR}/host.wav`, "host", "max"), new FileSource(`${FIXTURE_DIR}/remote.wav`, "remote", "max")],
    });
    expect(s.pause()).toBe(true);
    expect(s.pause()).toBe(false); // already paused
    await s.run();
    const types = bus.history().map((e) => e.type);
    expect(types).toContain("session.paused");
    expect(types).not.toContain("utterance");
    expect(stats().transcribeCalls).toBe(0);
    const rec = sherpa.readWave(join(s.store.dir, "host.wav")).samples;
    expect(rec.length).toBeGreaterThan(16_000 * 60); // the file keeps its length, so times stay aligned
    expect(rec.every((v: number) => v === 0)).toBe(true);
    expect(s.resume()).toBe(false); // ended
  });

  test("an ended session becomes a recording, which can be deleted without lowering the development spend", async () => {
    requireAssets();
    const root = mkdtempSync(join(tmpdir(), "sessions-"));
    const { f } = fakeFetch(loadScript());
    const engine = new Engine({ sessionsDir: root, session: { fetch: f, keys: { openrouter: OPENROUTER, openai: OPENAI } } });
    const { sessionId } = await engine.start({ mode: "replay", dir: FIXTURE_DIR, speed: "max" });
    expect(() => engine.pause()).toThrow(/only a live session/);
    await engine.current!.run();
    await new Promise((r) => setImmediate(r));
    expect(engine.current).toBeNull();
    expect((engine.state() as any).session).toMatchObject({ id: sessionId, status: "archived" });
    expect(() => engine.pause()).toThrow(/recorded session/);

    const spent = sumDevSpend(root);
    expect(spent).toBeGreaterThan(0);
    expect(engine.deleteSession(sessionId)).toEqual({ deleted: sessionId });
    expect(existsSync(join(root, sessionId))).toBe(false);
    expect(sumDevSpend(root)).toBeCloseTo(spent, 6);
    expect(engine.state()).toEqual({ session: null });
    expect(engine.bus.history()).toEqual([]);
    expect(() => engine.deleteSession(sessionId)).toThrow(/unknown session/);
    expect(() => engine.deleteSession("../etc")).toThrow(/invalid/);
  });
});
