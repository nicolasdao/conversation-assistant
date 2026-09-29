import { describe, expect, test } from "vitest";
import { Budget } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { LiveTranscriber, REALTIME_URL, type LivePartial, type LiveTranscriptionRow, type SocketLike } from "../src/transcribe/live.ts";
import { EventBus } from "../src/store/events.ts";

const cfg = loadConfig().app;
const live = cfg.transcription.live!;

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: any[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.onclose?.({ code: 1000 }); }
  server(e: unknown) { this.onmessage?.({ data: JSON.stringify(e) }); }
  get appends() { return this.sent.filter((m) => m.type === "input_audio_buffer.append"); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const partials: LivePartial[] = [];
  const rows: LiveTranscriptionRow[] = [];
  const errors: string[] = [];
  const budget = new Budget();
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
