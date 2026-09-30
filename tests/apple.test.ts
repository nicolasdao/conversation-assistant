import { EventEmitter } from "node:events";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { setAppPaths } from "../src/paths.ts";
import {
  AppleSpeech, AudioRing, LiveText, appleSpeechStatus, audioFrame, clipFileFrame, clipFrame, installAppleModel, macosSupportsAppleSpeech,
  type AppleSpeechDeps, type HelperProcess,
} from "../src/transcribe/apple.ts";
import type { LivePartial } from "../src/transcribe/live.ts";
import type { TranscriptionRow } from "../src/transcribe/openai.ts";
import { cleanTmpDirs, tmpDir, withEnv } from "./fakes/index.ts";

const cfg = loadConfig().app;
const second = () => new Float32Array(16_000).fill(0.1);

type Parsed =
  | { kind: 0; stream: number; startMs: number; count: number }
  | { kind: 2; id: string; count: number; first: number }
  | { kind: 3; id: string; count: number; first: number; path: string };

/** Parses the engine's frames, as the helper does. */
function parseFrames(buf: Buffer): Parsed[] {
  const out: Parsed[] = [];
  let p = 0;
  while (p < buf.length) {
    expect(buf.toString("ascii", p, p + 4)).toBe("PTRX");
    const kind = buf[p + 4];
    const stream = buf[p + 5];
    p += 8;
    if (kind === 0) {
      const startMs = buf.readDoubleLE(p);
      const count = buf.readUInt32LE(p + 8);
      p += 12 + count * 2;
      out.push({ kind, stream, startMs, count });
    } else if (kind === 2) {
      const n = buf.readUInt32LE(p);
      const id = buf.toString("utf8", p + 4, p + 4 + n);
      const count = buf.readUInt32LE(p + 4 + n);
      const first = count ? buf.readInt16LE(p + 8 + n) : 0;
      p += 8 + n + count * 2;
      out.push({ kind: 2, id, count, first });
    } else {
      // a clip in a file: read it as the helper would (it is deleted once the clip is answered)
      expect(kind).toBe(3);
      const n = buf.readUInt32LE(p);
      const id = buf.toString("utf8", p + 4, p + 4 + n);
      const m = buf.readUInt32LE(p + 4 + n);
      const path = buf.toString("utf8", p + 8 + n, p + 8 + n + m);
      p += 8 + n + m;
      const pcm = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
      out.push({ kind: 3, id, count: pcm.length / 2, first: pcm.length ? pcm.readInt16LE(0) : 0, path });
    }
  }
  return out;
}

class FakeHelper extends EventEmitter implements HelperProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  received = Buffer.alloc(0);
  constructor(readonly args: string[]) {
    super();
    this.stdin.on("data", (d: Buffer) => { this.received = Buffer.concat([this.received, d]); });
    this.stdin.on("finish", () => this.exit(0));
  }
  frames() { return parseFrames(this.received); }
  line(obj: unknown) { this.stdout.write(JSON.stringify(obj) + "\n"); }
  kill() { this.exit(null, "SIGTERM"); return true; }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    setImmediate(() => this.emit("exit", code, signal));
  }
}

const tick = () => new Promise((r) => setImmediate(r));

// every engine made here is closed, which removes its folder of clip files
const made: AppleSpeech[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((a) => a.close())); });

function setup(opts: { emitPartials?: boolean; clipTimeoutMs?: number; maxRestarts?: number } = {}) {
  const helpers: FakeHelper[] = [];
  const rows: TranscriptionRow[] = [];
  const partials: LivePartial[] = [];
  const errors: string[] = [];
  const apple = new AppleSpeech({ ...cfg.transcription, apple: { ...cfg.transcription.apple, clipTimeoutMs: opts.clipTimeoutMs ?? 8000 } }, {
    emitPartials: opts.emitPartials ?? false,
    log: (r) => rows.push(r),
    onPartial: (p) => partials.push(p),
    onError: (m) => errors.push(m),
    spawn: (_bin, args) => { const h = new FakeHelper(args); helpers.push(h); return h; },
    restartDelayMs: 1,
    maxRestarts: opts.maxRestarts,
  });
  made.push(apple);
  return { apple, helpers, rows, partials, errors };
}

describe("frames", () => {
  test("encode audio and clips", () => {
    const frames = parseFrames(Buffer.concat([
      audioFrame("remote", 1234.5, new Float32Array([0, 0.5, -1])),
      clipFrame("u_8", new Float32Array(10)),
    ]));
    expect(frames).toEqual([
      { kind: 0, stream: 1, startMs: 1234.5, count: 3 },
      { kind: 2, id: "u_8", count: 10, first: 0 },
    ]);
    const pcm = audioFrame("host", 0, new Float32Array([0.5, -1, 2]));
    expect([pcm.readInt16LE(20), pcm.readInt16LE(22), pcm.readInt16LE(24)]).toEqual([16384, -32768, 32767]);
  });
});

describe("AppleSpeech final text", () => {
  test("a line's clip is cut from its stream with 300 ms either side; its answer is fixed, trimmed, and logged at no cost", async () => {
    const { apple, helpers, rows } = setup();
    // 3 s of host audio whose samples count up, so the clip's first sample tells where it was cut
    for (let at = 0; at < 48_000; at += 512) apple.feed("host", Float32Array.from({ length: 512 }, (_, i) => (at + i) / 65_536), false, at / 16);
    expect(helpers).toHaveLength(1);
    expect(helpers[0].args).toEqual(["--locale", "en-US", "--clip-concurrency", "2"]);
    const r = apple.transcribe("u_1", second(), { stream: "host", startMs: 1000, endMs: 2000 });
    await tick();
    expect(helpers[0].frames()).toEqual([]); // without live text no audio is sent, and nothing before the helper is ready
    helpers[0].line({ type: "ready", locale: "en_US" });
    await tick();
    // 700 ms → 2300 ms: 1.6 s, starting at sample 11 200, in a file only this user can read
    const [f] = helpers[0].frames() as { kind: 3; path: string }[];
    expect(f).toMatchObject({ kind: 3, id: "u_1", count: 25_600, first: Math.round((11_200 / 65_536) * 0x7fff) });
    helpers[0].line({ type: "clip", id: "u_1", text: "  Hello there. " });
    expect(await r).toEqual({ ok: true, text: "Hello there.", filler: false });
    expect(existsSync(f.path)).toBe(false); // deleted once answered
    expect(rows).toMatchObject([{ kind: "transcription", engine: "apple", utterance_id: "u_1", ok: true, cost_usd: 0, audio_seconds: 1 }]);
  });

  test("a retry (no span) sends the samples; slivers are never sent", async () => {
    const { apple, helpers } = setup();
    expect(await apple.transcribe("u_0", new Float32Array(100))).toEqual({ ok: true, text: "", filler: false });
    const r = apple.transcribe("u_2", second());
    helpers[0].line({ type: "ready" });
    await tick();
    expect(helpers[0].frames()).toMatchObject([{ kind: 3, id: "u_2", count: 16_000, first: Math.round(0.1 * 0x7fff) }]);
    helpers[0].line({ type: "clip", id: "u_2", text: "Okay" });
    expect(await r).toMatchObject({ ok: true, text: "Okay", filler: true });
  });

  test("at most clipConcurrency clips are in the helper; the rest wait their turn", async () => {
    const { apple, helpers } = setup();
    const rs = ["u_1", "u_2", "u_3"].map((id) => apple.transcribe(id, second()));
    helpers[0].line({ type: "ready" });
    await tick();
    expect(helpers[0].frames().map((f) => (f as { id: string }).id)).toEqual(["u_1", "u_2"]);
    helpers[0].line({ type: "clip", id: "u_2", text: "Line two." });
    await tick();
    expect(helpers[0].frames().map((f) => (f as { id: string }).id)).toEqual(["u_1", "u_2", "u_3"]);
    helpers[0].line({ type: "clip", id: "u_1", text: "Line one." });
    helpers[0].line({ type: "clip", id: "u_3", error: "boom" });
    expect(await Promise.all(rs)).toEqual([
      { ok: true, text: "Line one.", filler: false }, { ok: true, text: "Line two.", filler: false }, { ok: false, error: "boom", retryable: true },
    ]);
  });

  test("no answer within clipTimeoutMs plus twice the clip's length is a retryable failure", async () => {
    const { apple, helpers, rows } = setup({ clipTimeoutMs: 20 });
    const started = Date.now();
    const r = apple.transcribe("u_1", new Float32Array(8000)); // 0.5 s: 20 + 1000 ms
    helpers[0].line({ type: "ready" });
    const res = await r;
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(res).toMatchObject({ ok: false, retryable: true });
    expect((res as { error: string }).error).toMatch(/within 1 s/);
    expect(rows[0]).toMatchObject({ engine: "apple", ok: false });
  });

  test("helper death fails its clips as retryable and restarts it, up to maxRestarts", async () => {
    const { apple, helpers, errors } = setup({ maxRestarts: 1 });
    const r = apple.transcribe("u_1", second(), { stream: "host", startMs: 0, endMs: 1000 });
    helpers[0].line({ type: "ready" });
    await tick();
    helpers[0].exit(1);
    expect(await r).toMatchObject({ ok: false, retryable: true });
    await new Promise((res) => setTimeout(res, 20));
    expect(helpers).toHaveLength(2);
    expect(errors[0]).toMatch(/restart 1 of 1/);
    helpers[1].line({ type: "ready" });
    const r2 = apple.transcribe("u_2", second());
    await tick();
    helpers[1].line({ type: "clip", id: "u_2", text: "back" });
    expect(await r2).toMatchObject({ ok: true, text: "back" });
    helpers[1].exit(1);
    await new Promise((res) => setTimeout(res, 20));
    expect(helpers).toHaveLength(2);
    expect(errors.at(-1)).toMatch(/after 1 restarts/);
    expect(await apple.transcribe("u_3", second())).toMatchObject({ ok: false, retryable: true });
  });
});

describe("AppleSpeech audio and live text", () => {
  test("with live text every frame is sent, stamped from a per-stream sample counter", async () => {
    const { apple, helpers } = setup({ emitPartials: true });
    apple.feed("host", new Float32Array(512), false, 5000);
    apple.feed("host", new Float32Array(512), true, 5032);
    apple.feed("remote", new Float32Array(512), false, 5000);
    await tick();
    expect(helpers[0].args).toContain("--live");
    expect(helpers[0].frames()).toEqual([
      { kind: 0, stream: 0, startMs: 5000, count: 512 },
      { kind: 0, stream: 0, startMs: 5032, count: 512 },
      { kind: 0, stream: 1, startMs: 5000, count: 512 },
    ]);
  });

  test("close() ends stdin so the helper can finish", async () => {
    const { apple, helpers } = setup();
    apple.warm("host");
    await apple.close();
    expect(helpers[0].exitCode).toBe(0);
  });

  test("helper lines become partials; a commit hands them to the line and they never show again", async () => {
    const { apple, helpers, partials } = setup({ emitPartials: true });
    apple.warm("host");
    const h = helpers[0];
    h.line({ type: "volatile", stream: "host", runs: [{ text: "Hello there", startMs: 0, endMs: 3000 }] });
    await tick();
    expect(partials.at(-1)).toEqual({ stream: "host", itemId: "apple-host-0", text: "Hello there", utteranceId: null, final: false });
    apple.commit("host", "u_1", 2000);
    expect(partials.at(-1)).toEqual({ stream: "host", itemId: "apple-host-0", text: "Hello there", utteranceId: "u_1", final: true });
    // the same unsettled range grows with the next line: its first two words belong to u_1
    h.line({ type: "volatile", stream: "host", runs: [{ text: "Hello there how are you", startMs: 0, endMs: 5000 }] });
    await tick();
    expect(partials.at(-1)).toMatchObject({ itemId: "apple-host-1", text: "how are you" });
  });
});

describe("AudioRing", () => {
  test("cuts across chunks, clamps to what it holds, and keeps at least a minute", () => {
    const ring = new AudioRing();
    for (let at = 0; at < 16_000 * 70; at += 1600) ring.append(at, new Float32Array(1600).fill(at / 16_000 / 100));
    expect(ring.cut(0, 100)).toBeNull(); // older than a minute (and a chunk) is gone
    const c = ring.cut(16_000 * 65 - 800, 16_000 * 65 + 800)!;
    expect(c.length).toBe(1600);
    expect([c[0], c[1599]]).toEqual([Math.fround(64.9 / 100), Math.fround(65 / 100)]);
    expect(ring.cut(16_000 * 69, 16_000 * 80)!.length).toBe(16_000); // clamped at the end
  });
});

describe("LiveText", () => {
  test("a closed line's late words are its own, not the next line's: its clip says how many", () => {
    const out: LivePartial[] = [];
    const lt = new LiveText("remote", (p) => out.push(p));
    lt.volatileText([{ text: "Honestly, Jev is 4", startMs: 9000, endMs: 14000 }]);
    lt.commit("u_2", 14000); // the VAD closed the line before its last words arrived
    lt.volatileText([{ text: "Honestly, Jev is 445 times cheaper", startMs: 9000, endMs: 15000 }]);
    expect(out.at(-1)).toMatchObject({ itemId: "apple-remote-1", text: "times cheaper" });
    lt.clipText("u_2", "Honestly, Jev is 445 times cheaper than GPT.");
    expect(out.at(-1)).toMatchObject({ itemId: "apple-remote-1", text: "" }); // the page hides it
    lt.volatileText([{ text: "Honestly, Jev is 445 times cheaper than GPT. I don't buy", startMs: 9000, endMs: 17000 }]);
    expect(out.at(-1)).toMatchObject({ itemId: "apple-remote-1", text: "I don't buy" });
    // once Apple settles the range, a new range starts and nothing is stripped from it
    lt.final([{ text: "Honestly,", startMs: 9000, endMs: 9500 }, { text: " cheaper than GPT.", startMs: 12000, endMs: 13900 }]);
    lt.volatileText([{ text: "I don't buy that", startMs: 15400, endMs: 18000 }]);
    expect(out.at(-1)).toMatchObject({ itemId: "apple-remote-1", text: "I don't buy that" });
  });

  test("settled words are kept by their end time: a first word stretched over the pause still belongs to its line", () => {
    const out: LivePartial[] = [];
    const lt = new LiveText("remote", (p) => out.push(p));
    lt.final([{ text: "Back", startMs: 1000, endMs: 1500 }, { text: " home.", startMs: 1500, endMs: 1900 }]);
    lt.commit("u_1", 1900);
    // "Tell" starts at 2000 but was said at ~3000 (its start covers the pause); it is the next line's
    lt.final([{ text: " Tell", startMs: 2000, endMs: 3120 }, { text: " me.", startMs: 3120, endMs: 3300 }]);
    expect(lt.text()).toBe("Tell me.");
    // a word ending within the slack of the committed end is the committed line's
    lt.final([{ text: " late", startMs: 1900, endMs: 2100 }]);
    expect(lt.text()).toBe("Tell me.");
  });

  test("a volatile result replaced by settled runs is not shown twice", () => {
    const out: LivePartial[] = [];
    const lt = new LiveText("host", (p) => out.push(p));
    lt.volatileText([{ text: "Welcome back", startMs: 0, endMs: 30000 }]);
    lt.final([{ text: "Welcome", startMs: 0, endMs: 1500 }, { text: " back.", startMs: 1500, endMs: 1800 }]);
    expect(lt.text()).toBe("Welcome back.");
    lt.volatileText([{ text: " Tonight", startMs: 1800, endMs: 30000 }]);
    expect(out.at(-1)?.text).toBe("Welcome back. Tonight");
  });

  test("an unchanged text is not emitted again", () => {
    const out: LivePartial[] = [];
    const lt = new LiveText("host", (p) => out.push(p));
    lt.volatileText([{ text: "Hi", startMs: 0, endMs: 100 }]);
    lt.volatileText([{ text: "Hi", startMs: 0, endMs: 200 }]);
    expect(out).toHaveLength(1);
  });
});

test("Apple Speech needs macOS 26 (Darwin 25)", () => {
  expect(macosSupportsAppleSpeech("25.2.0")).toBe(true);
  expect(macosSupportsAppleSpeech("24.6.0")).toBe(false);
  expect(macosSupportsAppleSpeech("23.1.0")).toBe(false);
});

// ---------- more cases: every branch of the engine side ----------

afterEach(() => { setAppPaths(); cleanTmpDirs(); });

/** Like setup(), with any dependency overridden (spawn, bin, restarts). */
function engine(over: Partial<AppleSpeechDeps> = {}, apple: Partial<typeof cfg.transcription.apple> = {}, fixes: typeof cfg.transcription.fixes = []) {
  const helpers: FakeHelper[] = [];
  const bins: string[] = [];
  const rows: TranscriptionRow[] = [];
  const partials: LivePartial[] = [];
  const errors: string[] = [];
  const a = new AppleSpeech({ ...cfg.transcription, fixes, apple: { ...cfg.transcription.apple, ...apple } }, {
    emitPartials: false,
    log: (r) => rows.push(r),
    onPartial: (p) => partials.push(p),
    onError: (m) => errors.push(m),
    spawn: (bin, args) => { bins.push(bin); const h = new FakeHelper(args); helpers.push(h); return h; },
    restartDelayMs: 1,
    ...over,
  });
  made.push(a);
  return { a, helpers, bins, rows, partials, errors };
}

const ms = (n: number) => new Promise((r) => setTimeout(r, n));
/** Resolves to "pending" if `p` has not settled within `n` ms. */
const within = <T>(p: Promise<T>, n = 50) => Promise.race([p, ms(n).then(() => "pending" as const)]);

/** A helper that ignores stdin closing and a SIGTERM; only SIGKILL stops it. */
class StubbornHelper extends FakeHelper {
  signals: string[] = [];
  constructor(args: string[]) {
    super(args);
    this.stdin.removeAllListeners("finish");
  }
  override kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.exit(null, signal);
    return true;
  }
}

/** An executable shell script in a tmp folder. */
function script(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("frames: clip in a file", () => {
  test("kind 3 carries the id and the path, with stream 0", () => {
    const b = clipFileFrame("u_12", "/tmp/x/1.pcm");
    expect(b.toString("ascii", 0, 4)).toBe("PTRX");
    expect([b[4], b[5], b[6], b[7]]).toEqual([3, 0, 0, 0]);
    expect(b.readUInt32LE(8)).toBe(4);
    expect(b.toString("utf8", 12, 16)).toBe("u_12");
    expect(b.readUInt32LE(16)).toBe("/tmp/x/1.pcm".length);
    expect(b.toString("utf8", 20)).toBe("/tmp/x/1.pcm");
  });

  test("a clip on stdin (kind 2) carries its samples as PCM16", () => {
    const b = clipFrame("é", new Float32Array([1, -0.5]));
    expect(b[4]).toBe(2);
    expect(b.readUInt32LE(8)).toBe(2); // "é" is 2 bytes in UTF-8
    expect(b.readUInt32LE(14)).toBe(2);
    expect([b.readInt16LE(18), b.readInt16LE(20)]).toEqual([32767, -16384]);
  });
});

describe("AudioRing: edges", () => {
  test("an empty ring holds nothing", () => {
    expect(new AudioRing().cut(0, 100)).toBeNull();
  });

  test("a range wholly before or after what is held is null; a gap between chunks stays silent", () => {
    const ring = new AudioRing();
    ring.append(100, new Float32Array(100).fill(1));
    ring.append(300, new Float32Array(100).fill(2));
    expect(ring.cut(0, 100)).toBeNull();
    expect(ring.cut(400, 500)).toBeNull();
    const c = ring.cut(150, 350)!;
    expect(c.length).toBe(200);
    expect([c[0], c[49], c[50], c[149], c[150], c[199]]).toEqual([1, 1, 0, 0, 2, 2]);
  });

  test("one chunk longer than a minute is kept whole", () => {
    const ring = new AudioRing();
    ring.append(0, new Float32Array(16_000 * 61).fill(0.5));
    expect(ring.cut(0, 10)!.length).toBe(10);
  });
});

describe("LiveText: edges", () => {
  test("an empty volatile result changes nothing; a clip for an unknown line is ignored", () => {
    const out: LivePartial[] = [];
    const lt = new LiveText("host", (p) => out.push(p));
    lt.volatileText([]);
    lt.clipText("u_9", "whatever words");
    expect(out).toEqual([]);
    expect(lt.text()).toBe("");
  });

  test("a commit with nothing on screen sends no final text but still starts a new item", () => {
    const out: LivePartial[] = [];
    const lt = new LiveText("host", (p) => out.push(p));
    lt.commit("u_1", 1000);
    expect(out).toEqual([]);
    lt.volatileText([{ text: "Next", startMs: 1500, endMs: 2000 }]);
    expect(out).toEqual([{ stream: "host", itemId: "apple-host-1", text: "Next", utteranceId: null, final: false }]);
  });

  test("the committed end never moves back", () => {
    const lt = new LiveText("host", () => {});
    lt.commit("u_1", 5000);
    lt.commit("u_2", 3000); // an older line closing late
    lt.final([{ text: "old", startMs: 4000, endMs: 5100 }, { text: " new", startMs: 5200, endMs: 6000 }]);
    expect(lt.text()).toBe("new");
  });
});

describe("AppleSpeech: starting the helper", () => {
  test("the helper is the app's tattle-transcribe unless a bin is given", async () => {
    setAppPaths({ transcriber: "/opt/tattle/tattle-transcribe" });
    const t = engine();
    t.a.warm("host");
    t.a.warm("remote"); // one helper for both streams
    const u = engine({ bin: "/elsewhere/tt" });
    u.a.warm("host");
    expect(t.bins).toEqual(["/opt/tattle/tattle-transcribe"]);
    expect(u.bins).toEqual(["/elsewhere/tt"]);
    expect(t.helpers[0].args).toEqual(["--locale", "en-US", "--clip-concurrency", "2"]);
  });

  test("a spawn that throws is reported, and lines already waiting fail as retryable", async () => {
    let fail = false;
    const t = engine({ spawn: (_b, args) => { if (fail) throw new Error("EACCES"); const h = new FakeHelper(args); t.helpers.push(h); return h; } });
    const r = t.a.transcribe("u_1", second()); // queued: the helper is not ready
    t.helpers[0].exit(1);
    fail = true;
    expect(await r).toMatchObject({ ok: false, retryable: true }); // the helper stopped
    await ms(20); // the restart throws
    expect(t.errors.at(-1)).toBe("could not start tattle-transcribe: EACCES");
  });

  test("a non-Error thrown by spawn is reported as text", () => {
    const t = engine({ spawn: () => { throw "no such file"; } });
    t.a.warm("host");
    expect(t.errors).toEqual(["could not start tattle-transcribe: no such file"]);
  });

  test.fails("BUG AP-L1: a line transcribed while the helper cannot start is answered (it hangs, even after close)", async () => {
    const t = engine({ spawn: () => { throw new Error("EACCES"); } });
    const r = t.a.transcribe("u_1", second());
    await t.a.close();
    expect(await within(r)).toMatchObject({ ok: false, retryable: true });
  });

  test("with the default spawn, a real executable runs with the API keys left out of its environment", async () => {
    const dir = tmpDir("tattle-apple-");
    const bin = script(dir, "tt", `echo "$OPENAI_API_KEY|$OPENROUTER_API_KEY" > "${dir}/env.txt"\necho "$@" > "${dir}/args.txt"\necho '{"type":"ready"}'\ncat > /dev/null`);
    await withEnv({ OPENAI_API_KEY: "sk-secret-openai", OPENROUTER_API_KEY: "sk-or-secret" }, async () => {
      const a = new AppleSpeech(cfg.transcription, { emitPartials: true, log: () => {}, onPartial: () => {}, onError: () => {}, bin });
      made.push(a);
      const r = a.transcribe("u_1", second());
      for (let i = 0; i < 200 && !existsSync(join(dir, "args.txt")); i++) await ms(10);
      await a.close(); // stdin closes, cat ends, the script exits: the clip was never answered
      expect(await r).toMatchObject({ ok: false, error: "the transcription helper stopped", retryable: true });
    });
    expect(readFileSync(join(dir, "env.txt"), "utf8")).toBe("|\n");
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toBe("--locale en-US --clip-concurrency 2 --live\n");
  });
});

describe("AppleSpeech: the helper's lines", () => {
  test("lines split across chunks are joined; blank lines, non-JSON and unknown types are ignored", async () => {
    const t = engine();
    const r = t.a.transcribe("u_1", second());
    const h = t.helpers[0];
    h.stdout.write('{"type":"rea');
    h.stdout.write('dy"}\n\n   \nnot json\n{"type":"mystery"}\n');
    await tick();
    expect(h.frames()).toMatchObject([{ kind: 3, id: "u_1" }]);
    h.stdout.write(Buffer.from('{"type":"clip","id":"u_1","text":"One. "}\n'));
    expect(await r).toEqual({ ok: true, text: "One.", filler: false });
  });

  test("an error line is reported with its message", async () => {
    const t = engine();
    t.a.warm("host");
    t.helpers[0].line({ type: "error", message: "model not installed", fatal: true });
    await tick();
    expect(t.errors).toEqual(["tattle-transcribe: model not installed"]);
  });

  test("without live text, volatile and final lines make no partial", async () => {
    const t = engine();
    t.a.warm("host");
    t.helpers[0].line({ type: "volatile", stream: "host", runs: [{ text: "Hi", startMs: 0, endMs: 100 }] });
    t.helpers[0].line({ type: "final", stream: "host", runs: [{ text: "Hi", startMs: 0, endMs: 100 }] });
    await tick();
    expect(t.partials).toEqual([]);
  });

  test("with live text, a line for an unknown stream or without runs is ignored; final runs show", async () => {
    const t = engine({ emitPartials: true });
    t.a.warm("host");
    const h = t.helpers[0];
    h.line({ type: "volatile", stream: "tape", runs: [{ text: "x", startMs: 0, endMs: 1 }] });
    h.line({ type: "final", stream: "remote", runs: "nope" });
    h.line({ type: "final", stream: "remote", runs: [{ text: "Settled.", startMs: 0, endMs: 900 }] });
    await tick();
    expect(t.partials).toEqual([{ stream: "remote", itemId: "apple-remote-0", text: "Settled.", utteranceId: null, final: false }]);
  });

  test("a clip answered with neither text nor error, or with an error, fails as retryable; an unknown id is ignored", async () => {
    const t = engine();
    const r1 = t.a.transcribe("u_1", second());
    const r2 = t.a.transcribe("u_2", second());
    const h = t.helpers[0];
    h.line({ type: "ready" });
    await tick();
    h.line({ type: "clip", id: "u_404", text: "stray" });
    h.line({ type: "clip", id: "u_1" });
    h.line({ type: "clip", id: "u_2", text: "ignored", error: "analyzer failed" });
    expect(await r1).toEqual({ ok: false, error: "no text", retryable: true });
    expect(await r2).toEqual({ ok: false, error: "analyzer failed", retryable: true });
    expect(t.rows.map((r) => [r.utterance_id, r.ok, r.error])).toEqual([["u_1", false, "no text"], ["u_2", false, "analyzer failed"]]);
  });

  test("the helper's diagnostics on stderr and a stdin error are harmless", async () => {
    const t = engine();
    t.a.warm("host");
    t.helpers[0].stderr.write("debug: warming up\n");
    t.helpers[0].stdin.emit("error", new Error("EPIPE"));
    await tick();
    expect(t.errors).toEqual([]);
  });
});

describe("AppleSpeech: clips", () => {
  test("a second request for a line already in the helper fails at once", async () => {
    const t = engine();
    const r1 = t.a.transcribe("u_1", second());
    t.helpers[0].line({ type: "ready" });
    await tick();
    const r2 = t.a.transcribe("u_1", second());
    expect(await r2).toEqual({ ok: false, error: "the same line is already being transcribed", retryable: true });
    t.helpers[0].line({ type: "clip", id: "u_1", text: "First." });
    expect(await r1).toMatchObject({ ok: true, text: "First." });
  });

  test("a clip that cannot be written fails as retryable, and the next one is still sent", async () => {
    const t = engine();
    (t.a as unknown as { clipDir: string }).clipDir = join(tmpDir("tattle-apple-"), "gone"); // no such folder
    const r = t.a.transcribe("u_1", second());
    t.helpers[0].line({ type: "ready" });
    const res = await r;
    expect(res).toMatchObject({ ok: false, retryable: true });
    expect((res as { error: string }).error).toMatch(/^could not write the clip: .*ENOENT/);
    expect(t.helpers[0].frames()).toEqual([]);
  });

  test("a span whose stream was never fed, or whose audio is gone, sends the line's own samples", async () => {
    const t = engine();
    t.a.feed("host", new Float32Array(512).fill(0.9), false, 0);
    const r1 = t.a.transcribe("u_1", second(), { stream: "remote", startMs: 0, endMs: 1000 });
    const r2 = t.a.transcribe("u_2", second(), { stream: "host", startMs: 90_000, endMs: 91_000 });
    t.helpers[0].line({ type: "ready" });
    await tick();
    expect(t.helpers[0].frames()).toMatchObject([
      { kind: 3, id: "u_1", count: 16_000, first: Math.round(0.1 * 0x7fff) },
      { kind: 3, id: "u_2", count: 16_000, first: Math.round(0.1 * 0x7fff) },
    ]);
    t.helpers[0].line({ type: "clip", id: "u_1", text: "a b c d" });
    t.helpers[0].line({ type: "clip", id: "u_2", text: "e f g h" });
    await Promise.all([r1, r2]);
  });

  test("a stream fed without session times starts at 0", async () => {
    const t = engine();
    t.a.feed("host", Float32Array.from({ length: 16_000 }, (_, i) => i / 32_768), false);
    const r = t.a.transcribe("u_1", second(), { stream: "host", startMs: 500, endMs: 600 });
    t.helpers[0].line({ type: "ready" });
    await tick();
    // 200 → 900 ms: samples 3200 to 14 400
    expect(t.helpers[0].frames()).toMatchObject([{ kind: 3, id: "u_1", count: 11_200, first: Math.round((3200 / 32_768) * 0x7fff) }]);
    t.helpers[0].line({ type: "clip", id: "u_1", text: "ok" });
    await r;
  });

  test("the answer goes through the configured fixes and the filler rule", async () => {
    const t = engine({}, {}, [{ pattern: "Jeff", replace: "Jev" }]);
    const r = t.a.transcribe("u_1", second());
    t.helpers[0].line({ type: "ready" });
    await tick();
    t.helpers[0].line({ type: "clip", id: "u_1", text: "Ask Jeff about it" });
    expect(await r).toEqual({ ok: true, text: "Ask Jev about it", filler: false });
  });

  test("a line's clip tells the live text how many of the late words are its own", async () => {
    const t = engine({ emitPartials: true });
    t.a.feed("remote", new Float32Array(16_000 * 3).fill(0.1), true, 0);
    const h = t.helpers[0];
    h.line({ type: "ready" });
    h.line({ type: "volatile", stream: "remote", runs: [{ text: "Jev is 4", startMs: 0, endMs: 2000 }] });
    await tick();
    t.a.commit("remote", "u_1", 2000);
    t.a.commit("remote", "u_x"); // no end: ignored
    t.a.commit("host", "u_y", 100); // no live text on the host yet: ignored
    const r = t.a.transcribe("u_1", second(), { stream: "remote", startMs: 1000, endMs: 2000 });
    h.line({ type: "volatile", stream: "remote", runs: [{ text: "Jev is 445 times cheaper", startMs: 0, endMs: 3000 }] });
    await tick();
    expect(t.partials.at(-1)).toMatchObject({ itemId: "apple-remote-1", text: "times cheaper" }); // "4" was u_1's (now "445")
    h.line({ type: "clip", id: "u_1", text: "Jev is 445 times cheaper." });
    await r;
    expect(t.partials.at(-1)).toMatchObject({ itemId: "apple-remote-1", text: "" });
  });

  test("a frame is not written to a helper that has already exited, and a failing write is swallowed", async () => {
    const t = engine({ emitPartials: true });
    t.a.feed("host", new Float32Array(512), false, 0);
    await tick();
    const h = t.helpers[0];
    expect(h.frames()).toHaveLength(1);
    const write = h.stdin.write;
    h.stdin.write = () => { throw new Error("EPIPE"); };
    expect(() => t.a.feed("host", new Float32Array(512), false)).not.toThrow();
    h.exitCode = 1; // exited, its exit event not delivered yet
    const spy = vi.fn();
    h.stdin.write = spy as never;
    t.a.feed("host", new Float32Array(512), false);
    expect(spy).not.toHaveBeenCalled();
    // back to a running helper, so close() can end it
    h.exitCode = null;
    h.stdin.write = write;
  });
});

describe("AppleSpeech: restarts and closing", () => {
  test("by default the helper is restarted 3 times, then transcription stops", async () => {
    const t = engine({ maxRestarts: undefined });
    t.a.warm("host");
    for (let i = 0; i < 4; i++) {
      t.helpers[i].exit(1, null);
      await ms(20);
    }
    expect(t.helpers).toHaveLength(4);
    expect(t.errors).toEqual([
      "tattle-transcribe exited (code 1, signal null); restart 1 of 3",
      "tattle-transcribe exited (code 1, signal null); restart 2 of 3",
      "tattle-transcribe exited (code 1, signal null); restart 3 of 3",
      "tattle-transcribe exited (code 1, signal null) after 3 restarts; transcription stops",
    ]);
    expect(await t.a.transcribe("u_1", second())).toEqual({ ok: false, error: "the transcription helper stopped", retryable: true });
    expect(t.rows.at(-1)).toMatchObject({ utterance_id: "u_1", ok: false, error: "the transcription helper stopped" });
  });

  test("a second exit event from a replaced helper is ignored", async () => {
    const t = engine();
    t.a.warm("host");
    t.helpers[0].emit("exit", 1, null);
    await ms(20);
    t.helpers[0].emit("exit", 1, null);
    await ms(20);
    expect(t.helpers).toHaveLength(2);
    expect(t.errors).toHaveLength(1);
  });

  test("close() during the restart delay never starts another helper", async () => {
    const t = engine({ restartDelayMs: 10 });
    t.a.warm("host");
    t.helpers[0].exit(1);
    await tick();
    await t.a.close();
    await ms(30);
    expect(t.helpers).toHaveLength(1);
  });

  test("close() before any helper started resolves at once; close() after the helper exited removes the clip folder", async () => {
    const t = engine();
    await t.a.close();
    expect(t.helpers).toHaveLength(0);
    const u = engine();
    const r = u.a.transcribe("u_1", second());
    u.helpers[0].line({ type: "ready" });
    await tick();
    const [f] = u.helpers[0].frames() as { path: string }[];
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    expect(existsSync(dir)).toBe(true);
    u.helpers[0].exit(0);
    await r;
    await u.a.close();
    expect(existsSync(dir)).toBe(false);
  });

  test("a helper that ignores stdin closing gets SIGTERM after 2 s, then SIGKILL after 5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stubborn: StubbornHelper[] = [];
      const t = engine({ spawn: (_b, args) => { const h = new StubbornHelper(args); stubborn.push(h); return h; } });
      t.a.warm("host");
      let done = false;
      const closing = t.a.close().then(() => { done = true; });
      vi.advanceTimersByTime(1999);
      expect(stubborn[0].signals).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(stubborn[0].signals).toEqual(["SIGTERM"]);
      await tick();
      expect(done).toBe(false);
      vi.advanceTimersByTime(3000);
      expect(stubborn[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
      await closing;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a helper that exits when stdin closes is never signalled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = engine();
      t.a.warm("host");
      const kill = vi.spyOn(t.helpers[0], "kill");
      await t.a.close();
      vi.advanceTimersByTime(10_000);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("availability and the model", () => {
  const supported = macosSupportsAppleSpeech();

  test("macosSupportsAppleSpeech defaults to this Mac's Darwin release", () => {
    expect(supported).toBe(Number(release().split(".")[0]) >= 25);
  });

  test("TATTLE_FORCE_NO_APPLE_SPEECH=1 says it needs macOS 26, without spawning anything", async () => {
    const dir = tmpDir("tattle-apple-");
    const bin = script(dir, "tt", `touch "${dir}/ran"`);
    const s = await withEnv({ TATTLE_FORCE_NO_APPLE_SPEECH: "1" }, () => appleSpeechStatus({ bin, refresh: true }));
    expect(s).toEqual({ available: false, reason: "Needs macOS 26 or later", locale: null, installed: false });
    expect(existsSync(join(dir, "ran"))).toBe(false);
  });

  test("a missing helper is unavailable, and says how to build it", async () => {
    setAppPaths({ transcriber: join(tmpDir("tattle-apple-"), "missing") });
    const s = await withEnv({ TATTLE_FORCE_NO_APPLE_SPEECH: undefined }, () => appleSpeechStatus({ refresh: true }));
    expect(s).toEqual(supported
      ? { available: false, reason: "tattle-transcribe is not built (npm run build:transcribe)", locale: null, installed: false }
      : { available: false, reason: "Needs macOS 26 or later", locale: null, installed: false });
  });

  describe.runIf(supported)("on macOS 26 or later", () => {
    const status = (bin: string, o: { refresh?: boolean; locale?: string } = {}) =>
      withEnv({ TATTLE_FORCE_NO_APPLE_SPEECH: undefined }, () => appleSpeechStatus({ bin, ...o }));

    test("--status answers from the helper's last line, with the locale, and without the API keys", async () => {
      const dir = tmpDir("tattle-apple-");
      const bin = script(dir, "tt", `echo "starting"\necho "{\\"available\\":true,\\"reason\\":\\"$*|$OPENAI_API_KEY\\",\\"locale\\":\\"fr-FR\\",\\"installed\\":true}"`);
      const s = await withEnv({ OPENAI_API_KEY: "sk-secret" }, () => status(bin, { refresh: true, locale: "fr-FR" }));
      expect(s).toEqual({ available: true, reason: "--status --locale fr-FR|", locale: "fr-FR", installed: true });
    });

    test("missing fields read as unavailable, not installed, with no reason or locale", async () => {
      const bin = script(tmpDir("tattle-apple-"), "tt", "echo '{}'");
      expect(await status(bin, { refresh: true })).toEqual({ available: false, reason: null, locale: null, installed: false });
    });

    test("an answer is cached until refresh; installing the model clears it", async () => {
      const dir = tmpDir("tattle-apple-");
      const bin = script(dir, "tt", `echo run >> "${dir}/runs"\necho '{"available":true,"locale":"en-US","installed":false}'`);
      await status(bin, { refresh: true });
      await status(bin);
      expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\n");
      await status(bin, { refresh: true });
      expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\nrun\n");
      await installAppleModel(() => {}, { bin: script(dir, "install", "exit 0") });
      await status(bin);
      expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\nrun\nrun\n");
    });

    test("a failed check (no JSON, a crash) is an error and is not cached", async () => {
      const dir = tmpDir("tattle-apple-");
      const crash = script(dir, "crash", `echo run >> "${dir}/runs"\necho oops\nexit 3`);
      const s = await status(crash, { refresh: true });
      expect(s).toMatchObject({ available: false, reason: null, locale: null, installed: false });
      expect(s.error).toMatch(/Command failed/);
      await status(crash);
      expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\nrun\n");
      const silent = script(dir, "silent", "exit 0");
      expect((await status(silent, { refresh: true })).error).toBe("no answer from tattle-transcribe --status");
    });

    test("the app's helper is asked when no bin is given", async () => {
      const dir = tmpDir("tattle-apple-");
      setAppPaths({ transcriber: script(dir, "tt", `echo '{"available":true,"reason":null,"locale":"en-US","installed":true}'`) });
      const s = await withEnv({ TATTLE_FORCE_NO_APPLE_SPEECH: undefined }, () => appleSpeechStatus({ refresh: true }));
      expect(s).toEqual({ available: true, reason: null, locale: "en-US", installed: true });
    });
  });

  test("installing reports progress and resolves when the helper exits 0", async () => {
    const dir = tmpDir("tattle-apple-");
    const bin = script(dir, "install", [
      `echo "$*" > "${dir}/args"`,
      `printf '{"type":"progress","fraction":0.25}\\n{"type":"progress","fraction":"half"}\\nnot json\\n{"type":"progress","fraction":1}\\n'`,
      `echo '{"type":"installed"}'`,
    ].join("\n"));
    const seen: number[] = [];
    await installAppleModel((f) => seen.push(f), { bin, locale: "en-GB" });
    expect(seen).toEqual([0.25, 1]);
    expect(readFileSync(join(dir, "args"), "utf8")).toBe("--install --locale en-GB\n");
  });

  test("installing rejects with the helper's error message, or with its exit code", async () => {
    const dir = tmpDir("tattle-apple-");
    await expect(installAppleModel(() => {}, { bin: script(dir, "a", `echo '{"type":"error","message":"no network"}'\nexit 1`) })).rejects.toThrow("no network");
    await expect(installAppleModel(() => {}, { bin: script(dir, "b", "exit 2") })).rejects.toThrow("tattle-transcribe --install exited with 2");
  });

  test("installing rejects when the helper cannot be run; with no bin it runs the app's helper", async () => {
    const dir = tmpDir("tattle-apple-");
    const notExec = join(dir, "plain");
    writeFileSync(notExec, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await expect(installAppleModel(() => {}, { bin: notExec })).rejects.toThrow(/EACCES/);
    setAppPaths({ transcriber: script(dir, "tt", `echo "$*" > "${dir}/args"`) });
    await installAppleModel(() => {});
    expect(readFileSync(join(dir, "args"), "utf8")).toBe("--install --locale en-US\n");
  });
});
