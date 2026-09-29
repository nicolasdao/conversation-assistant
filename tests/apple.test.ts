import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  AppleSpeech, AudioRing, LiveText, audioFrame, clipFrame, macosSupportsAppleSpeech, type HelperProcess,
} from "../src/transcribe/apple.ts";
import type { LivePartial } from "../src/transcribe/live.ts";
import type { TranscriptionRow } from "../src/transcribe/openai.ts";

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
