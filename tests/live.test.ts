import { afterEach, describe, expect, test, vi } from "vitest";
import { Budget } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { LiveTranscriber, REALTIME_URL, type LivePartial, type LiveTranscriptionRow } from "../src/transcribe/live.ts";
import { EventBus } from "../src/store/events.ts";
import { FakeSocket } from "./fakes/index.ts";

const cfg = loadConfig().app;
const live = cfg.transcription.live!;

function setup(budget = new Budget()) {
  const sockets: FakeSocket[] = [];
  const partials: LivePartial[] = [];
  const rows: LiveTranscriptionRow[] = [];
  const errors: string[] = [];
  const lt = new LiveTranscriber(cfg.transcription, live, {
    apiKey: "sk-test", budget, log: (r) => rows.push(r), onPartial: (p) => partials.push(p), onError: (m) => errors.push(m),
    connect: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); return s; },
  });
  return { lt, sockets, partials, rows, errors, budget };
}

const frame = (v = 0.1) => new Float32Array(512).fill(v); // 32 ms at 16 kHz

describe("live transcription", () => {
  test("configures a transcription session, and queues audio until session.updated", () => {
    const { lt, sockets } = setup();
    lt.warm("host");
    const ws = sockets[0];
    expect(ws.url).toBe(REALTIME_URL);
    expect(ws.headers.Authorization).toBe("Bearer sk-test");
    ws.onopen?.({});
    expect(ws.sent[0]).toEqual({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-live-transcribe", delay: "low", languages: ["en"], keywords: cfg.transcription.keywords, prompt: cfg.transcription.prompt },
            turn_detection: null,
          },
        },
      },
    });
    lt.feed("host", frame(), true);
    expect(ws.appends.length).toBe(0); // not ready yet
    ws.server({ type: "session.updated" });
    expect(ws.appends.length).toBe(1);
    // 512 samples at 16 kHz → ~768 at 24 kHz → ~1,536 bytes of PCM16
    expect(Buffer.from(ws.appends[0].audio, "base64").length).toBeGreaterThan(1000);
  });

  test("sends audio only while speaking, with pre-roll and hangover", () => {
    const { lt, sockets } = setup();
    lt.warm("remote");
    const ws = sockets[0];
    ws.onopen?.({});
    ws.server({ type: "session.updated" });
    for (let i = 0; i < 40; i++) lt.feed("remote", frame(0), false); // 1.3 s of silence
    expect(ws.appends.length).toBe(0);
    lt.feed("remote", frame(), true);
    const prerollFrames = Math.ceil((live.prerollMs * 16) / 512);
    expect(ws.appends.length).toBeGreaterThanOrEqual(prerollFrames);
    expect(ws.appends.length).toBeLessThanOrEqual(prerollFrames + 2);
    const afterSpeechStart = ws.appends.length;
    const hangFrames = Math.ceil((live.hangoverMs * 16) / 512);
    for (let i = 0; i < hangFrames + 20; i++) lt.feed("remote", frame(0), false);
    expect(ws.appends.length - afterSpeechStart).toBe(hangFrames); // then it stops sending silence
  });

  test("deltas accumulate; a commit maps the item to the VAD utterance; completed is final", () => {
    const { lt, sockets, partials } = setup();
    lt.warm("host");
    const ws = sockets[0];
    ws.onopen?.({});
    ws.server({ type: "session.updated" });
    lt.feed("host", frame(), true);
    ws.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_1", delta: " Honestly" });
    ws.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_1", delta: ", Jev" });
    expect(partials.at(-1)).toEqual({ stream: "host", itemId: "item_1", text: "Honestly, Jev", utteranceId: null, final: false });
    lt.commit("host", "u_7");
    expect(ws.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    ws.server({ type: "input_audio_buffer.committed", item_id: "item_1" });
    ws.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_1", delta: " is cheap" });
    expect(partials.at(-1)).toMatchObject({ text: "Honestly, Jev is cheap", utteranceId: "u_7" });
    ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "Honestly, Jev is cheap." });
    expect(partials.at(-1)).toEqual({ stream: "host", itemId: "item_1", text: "Honestly, Jev is cheap.", utteranceId: "u_7", final: true });
  });

  test("bills sent audio at usdPerMinute on commit and close; an empty turn is not committed", () => {
    const { lt, sockets, rows, budget } = setup();
    lt.warm("host");
    const ws = sockets[0];
    ws.onopen?.({});
    ws.server({ type: "session.updated" });
    lt.commit("host", "u_1");
    expect(ws.sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(false);
    for (let i = 0; i < 125; i++) lt.feed("host", frame(), true); // 4 s
    lt.commit("host", "u_2");
    expect(rows[0]).toMatchObject({ kind: "live_transcription", stream: "host", audio_seconds: 4, estimated: true });
    expect(rows[0].cost_usd).toBeCloseTo((4 / 60) * 0.017);
    expect(budget.totals().transcription).toBeCloseTo((4 / 60) * 0.017);
    lt.feed("host", frame(), true);
    lt.close();
    expect(rows.length).toBe(2);
  });

  test("stops streaming once OpenRouter or OpenAI refused for good (the budget is exhausted)", () => {
    const { lt, sockets, budget } = setup();
    lt.warm("host");
    const ws = sockets[0];
    ws.onopen?.({});
    ws.server({ type: "session.updated" });
    lt.feed("host", frame(), true);
    try { budget.exhaust("provider", "jev", "credits used up"); } catch { /* another component hit a 402 */ }
    lt.commit("host", "u_1");
    const sent = ws.appends.length;
    for (let i = 0; i < 20; i++) lt.feed("host", frame(), true);
    expect(ws.appends.length).toBe(sent);
    expect(sockets.length).toBe(1); // and it does not reconnect
  });

  test("reconnects on the next speech after the server closes; errors surface", () => {
    const { lt, sockets, errors } = setup();
    lt.warm("host");
    sockets[0].onclose?.({ code: 1011, reason: "server error" });
    expect(errors[0]).toMatch(/1011/);
    lt.feed("host", frame(), true);
    expect(sockets.length).toBe(2);
    sockets[1].server({ type: "error", error: { code: "input_audio_buffer_commit_empty", message: "empty" } });
    expect(errors.length).toBe(1);
  });

  test("partial events stream to subscribers but stay out of the replay history", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    bus.emit("utterance.partial", { stream: "host", itemId: "i", text: "hi", utteranceId: null, final: false }, { transient: true });
    expect(seen).toEqual(["utterance.partial"]);
    expect(bus.history()).toEqual([]);
  });
});

const exhausted = () => {
  const b = new Budget();
  try { b.exhaust("provider", "jev", "credits used up"); } catch { /* the 402 that exhausts it */ }
  return b;
};

/** A link whose socket is open and configured, so audio goes straight out. */
function ready(t: ReturnType<typeof setup>, stream: "host" | "remote" = "host", i = t.sockets.length) {
  t.lt.warm(stream);
  const ws = t.sockets[i];
  ws.onopen?.({});
  ws.server({ type: "session.updated" });
  return ws;
}

const silentFrames = (n: number) => Array.from({ length: n }, () => frame(0));
const hangFrames = Math.ceil((live.hangoverMs * 16) / 512);

describe("live transcription: connection and budget", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test("warm with an exhausted budget opens no socket, and live text stays off", () => {
    const t = setup(exhausted());
    t.lt.warm("host");
    t.lt.feed("host", frame(), true);
    t.lt.commit("host", "u_1");
    expect(t.sockets).toHaveLength(0);
    expect(t.rows).toHaveLength(0);
    expect(t.errors).toEqual([]); // silent: the budget refusal is reported where it happened
  });

  test("a budget exhausted before the first speech disables live text at that speech, and nothing is sent or billed", () => {
    const b = new Budget();
    const t = setup(b);
    for (const f of silentFrames(5)) t.lt.feed("host", f, false); // pre-roll waiting
    try { b.exhaust("provider", "jev", "gone"); } catch { /* exhausted */ }
    t.lt.feed("host", frame(), true);
    t.lt.close();
    expect(t.sockets).toHaveLength(0);
    expect(t.rows).toHaveLength(0);
  });

  test("the default connect opens the global WebSocket with the Authorization header", () => {
    const made: [string, unknown][] = [];
    vi.stubGlobal("WebSocket", class {
      readyState = 0;
      constructor(url: string, opts: unknown) { made.push([url, opts]); }
      send() {}
      close() {}
    });
    const lt = new LiveTranscriber(cfg.transcription, live, { apiKey: "sk-x", budget: new Budget(), log: () => {}, onPartial: () => {}, onError: () => {} });
    lt.warm("remote");
    expect(made).toEqual([[REALTIME_URL, { headers: { Authorization: "Bearer sk-x" } }]]);
  });

  test("a close with code 1000, 1005, or no code reports no error", () => {
    for (const ev of [{ code: 1000 }, { code: 1005 }, {}, undefined]) {
      const t = setup();
      t.lt.warm("host");
      t.sockets[0].onclose?.(ev as never);
      expect(t.errors).toEqual([]);
    }
  });

  test("a close without a reason reads 'live transcription closed (1011)'; with one, it adds it", () => {
    const t = setup();
    t.lt.warm("host");
    t.sockets[0].onclose?.({ code: 1011 });
    expect(t.errors).toEqual(["live transcription closed (1011)"]);
    t.lt.warm("host");
    t.sockets[1].onclose?.({ code: 4000, reason: "bye" });
    expect(t.errors.at(-1)).toBe("live transcription closed (4000: bye)");
  });

  test("a server close bills the unbilled audio and forgets queued audio and commits waiting for their item", () => {
    const t = setup();
    t.lt.warm("host");
    const ws = t.sockets[0];
    ws.onopen?.({});
    t.lt.feed("host", frame(), true); // queued: not ready yet
    t.lt.commit("host", "u_1"); // commit queued too, and billed
    expect(t.rows).toHaveLength(1);
    t.lt.feed("host", frame(), true);
    ws.onclose?.({ code: 1006 });
    expect(t.rows).toHaveLength(2); // the second frame, billed at close
    expect(t.rows[1].audio_seconds).toBe(0.032);
    // the next speech (after the hangover) reconnects; nothing queued on the old socket is sent on the new one
    for (const f of silentFrames(hangFrames)) t.lt.feed("host", f, false);
    t.lt.feed("host", frame(), true);
    const ws2 = t.sockets[1];
    ws2.onopen?.({});
    ws2.server({ type: "session.updated" });
    expect(ws2.sent.filter((m) => m.type === "input_audio_buffer.commit")).toHaveLength(0);
    // u_1's commit was forgotten: the new socket's first committed item maps to nothing
    ws2.server({ type: "input_audio_buffer.committed", item_id: "item_9" });
    ws2.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_9", delta: "hi" });
    expect(t.partials.at(-1)).toMatchObject({ itemId: "item_9", utteranceId: null });
  });

  test("a stale socket's close after close() is ignored: no second bill, no error", () => {
    const t = setup();
    const ws = ready(t);
    t.lt.feed("host", frame(), true);
    t.lt.close();
    expect(t.rows).toHaveLength(1);
    ws.onclose?.({ code: 1011 });
    expect(t.rows).toHaveLength(1);
    expect(t.errors).toEqual([]);
  });

  test("two streams use two sockets and are billed separately", () => {
    const t = setup();
    const host = ready(t, "host");
    const remote = ready(t, "remote");
    for (let i = 0; i < 10; i++) t.lt.feed("host", frame(), true);
    for (let i = 0; i < 20; i++) t.lt.feed("remote", frame(), true);
    t.lt.commit("host", "u_1");
    t.lt.commit("remote", "u_2");
    expect(host.appends).toHaveLength(10);
    expect(remote.appends).toHaveLength(20);
    expect(t.rows.map((r) => [r.stream, r.audio_seconds])).toEqual([["host", 0.32], ["remote", 0.64]]);
  });

  test("budget exhaustion at a commit bills, closes every socket, and ignores later feeds", () => {
    const b = new Budget();
    const t = setup(b);
    const host = ready(t, "host");
    const remote = ready(t, "remote");
    t.lt.feed("host", frame(), true);
    t.lt.feed("remote", frame(), true);
    try { b.exhaust("provider", "jev", "gone"); } catch { /* exhausted */ }
    let closes = 0;
    for (const ws of [host, remote]) { const c = ws.close.bind(ws); ws.close = () => { closes++; c(); }; }
    t.lt.commit("host", "u_1");
    expect(closes).toBe(2);
    expect(t.rows.map((r) => r.stream)).toEqual(["host", "remote"]); // the commit's bill, then close's for remote
    for (let i = 0; i < 5; i++) { t.lt.feed("host", frame(), true); t.lt.feed("remote", frame(), true); }
    t.lt.commit("remote", "u_2");
    expect(host.appends).toHaveLength(1);
    expect(remote.appends).toHaveLength(1);
    expect(t.sockets).toHaveLength(2);
  });

  test("rows carry an ISO time and audio_seconds rounded to the millisecond", () => {
    const t = setup();
    ready(t);
    t.lt.feed("host", new Float32Array(100).fill(0.1), true); // 6.25 ms
    t.lt.close();
    expect(t.rows[0].audio_seconds).toBe(0.006);
    expect(t.rows[0].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(t.rows[0].cost_usd).toBeCloseTo((100 / 16000 / 60) * live.usdPerMinute, 12);
  });
});

describe("live transcription: server messages", () => {
  test("invalid JSON, unknown message types, and a socket error event (its close follows) are ignored", () => {
    const t = setup();
    const ws = ready(t);
    ws.onerror?.({ type: "error" });
    ws.onmessage?.({ data: "not json {" });
    ws.server({ type: "conversation.item.created", item: {} });
    expect(t.partials).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  test("an error without code or message reads 'live transcription: '", () => {
    const t = setup();
    const ws = ready(t);
    ws.server({ type: "error" });
    ws.server({ type: "error", error: { message: "rate limited" } });
    ws.server({ type: "error", error: { code: "bad_thing" } });
    expect(t.errors).toEqual(["live transcription: ", "live transcription: rate limited", "live transcription: bad_thing"]);
  });

  test("a committed with no utterance waiting maps nothing; later partials carry utteranceId null", () => {
    const t = setup();
    const ws = ready(t);
    ws.server({ type: "input_audio_buffer.committed", item_id: "item_1" });
    ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "Hi." });
    expect(t.partials).toEqual([{ stream: "host", itemId: "item_1", text: "Hi.", utteranceId: null, final: true }]);
  });

  test("a committed without item_id uses up the waiting utterance without mapping it", () => {
    const t = setup();
    const ws = ready(t);
    t.lt.feed("host", frame(), true);
    t.lt.commit("host", "u_1");
    ws.server({ type: "input_audio_buffer.committed" });
    ws.server({ type: "input_audio_buffer.committed", item_id: "item_2" });
    ws.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_2", delta: "x" });
    expect(t.partials.at(-1)?.utteranceId).toBeNull();
  });

  test("a completed without transcript is final with empty text; a delta without delta keeps the text", () => {
    const t = setup();
    const ws = ready(t);
    ws.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "Hello " });
    ws.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "a" });
    expect(t.partials.at(-1)).toMatchObject({ itemId: "a", text: "Hello", final: false });
    ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "a" });
    expect(t.partials.at(-1)).toMatchObject({ itemId: "a", text: "", final: true });
    // the item's text was forgotten: a new delta starts over
    ws.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "again" });
    expect(t.partials.at(-1)?.text).toBe("again");
  });
});

describe("live transcription: sending audio", () => {
  test("the pre-roll keeps at most prerollMs, in whole frames", () => {
    const t = setup();
    const ws = ready(t);
    for (const f of silentFrames(20)) t.lt.feed("host", f, false);
    t.lt.feed("host", frame(), true);
    // 600 ms is 9600 samples: 19 frames of 512 are kept (dropping one more would leave < 600 ms)
    expect(ws.appends).toHaveLength(19 + 1);
  });

  test("the pre-roll always keeps at least one chunk, even one longer than prerollMs", () => {
    const t = setup();
    const ws = ready(t);
    t.lt.feed("host", new Float32Array(16_000), false); // 1 s in one chunk
    t.lt.feed("host", frame(), true);
    expect(ws.appends).toHaveLength(2);
    // with no pre-roll configured, the last chunk heard is still sent
    const sockets: FakeSocket[] = [];
    const lt = new LiveTranscriber(cfg.transcription, { ...live, prerollMs: 0 }, {
      apiKey: "k", budget: new Budget(), log: () => {}, onPartial: () => {}, onError: () => {},
      connect: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); return s; },
    });
    for (const f of silentFrames(3)) lt.feed("host", f, false);
    lt.feed("host", frame(), true);
    sockets[0].onopen?.({});
    sockets[0].server({ type: "session.updated" });
    expect(sockets[0].appends).toHaveLength(2);
  });

  test("speech during the hangover resets the silence count", () => {
    const t = setup();
    const ws = ready(t);
    t.lt.feed("host", frame(), true);
    for (const f of silentFrames(hangFrames - 1)) t.lt.feed("host", f, false);
    t.lt.feed("host", frame(), true); // still active: silence starts over
    for (const f of silentFrames(hangFrames - 1)) t.lt.feed("host", f, false);
    expect(ws.appends).toHaveLength(1 + (hangFrames - 1) + 1 + (hangFrames - 1));
    t.lt.feed("host", frame(0), false); // the hangover ends here
    t.lt.feed("host", frame(0), false); // pre-roll: not sent
    expect(ws.appends).toHaveLength(2 * hangFrames + 1);
  });

  test("an empty frame sends nothing", () => {
    const t = setup();
    const ws = ready(t);
    t.lt.feed("host", new Float32Array(0), true);
    expect(ws.appends).toHaveLength(0);
  });

  test("a commit on a stream never fed, or with its socket closed, is a no-op", () => {
    const t = setup();
    t.lt.commit("remote", "u_1");
    const ws = ready(t);
    t.lt.feed("host", frame(), true);
    ws.onclose?.({ code: 1000 });
    const rows = t.rows.length;
    t.lt.commit("host", "u_2");
    expect(ws.sent.filter((m) => m.type === "input_audio_buffer.commit")).toHaveLength(0);
    expect(t.rows).toHaveLength(rows);
  });

  test("after close(), speech still under way does not reconnect until the hangover has ended", () => {
    const t = setup();
    ready(t);
    t.lt.feed("host", frame(), true);
    t.lt.close();
    t.lt.feed("host", frame(), true);
    expect(t.sockets).toHaveLength(1);
    for (const f of silentFrames(hangFrames)) t.lt.feed("host", f, false);
    t.lt.feed("host", frame(), true);
    expect(t.sockets).toHaveLength(2);
  });

  test.fails("BUG T1-L1: audio fed while the socket is closed mid-utterance is not billed", () => {
    const t = setup();
    const ws = ready(t);
    t.lt.feed("host", frame(), true);
    ws.onclose?.({ code: 1006 }); // bills the one frame sent
    const billed = t.rows.reduce((a, r) => a + r.audio_seconds, 0);
    for (let i = 0; i < 100; i++) t.lt.feed("host", frame(), true); // 3.2 s never sent: there is no socket
    t.lt.close();
    expect(t.rows.reduce((a, r) => a + r.audio_seconds, 0)).toBeCloseTo(billed);
  });

  test.fails("BUG T1-L1: a server close mid-utterance reconnects on continued speech", () => {
    const t = setup();
    const ws = ready(t);
    t.lt.feed("host", frame(), true);
    ws.onclose?.({ code: 1006 });
    for (let i = 0; i < 10; i++) t.lt.feed("host", frame(), true);
    expect(t.sockets).toHaveLength(2);
  });
});
