import sherpa, { type LinearResampler } from "sherpa-onnx-node";
import type { AppConfig } from "../config.ts";
import type { Budget } from "../budget.ts";
import type { StreamName } from "../audio/source.ts";
import { SAMPLE_RATE, toPcm16 } from "../audio/wav.ts";

export const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const RATE = 24_000;

/** The subset of the WHATWG WebSocket this module uses, so tests can pass a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface LivePartial {
  stream: StreamName;
  itemId: string;
  text: string;
  /** The VAD utterance this text belongs to, once committed. */
  utteranceId: string | null;
  final: boolean;
}

export interface LiveTranscriptionRow {
  kind: "live_transcription";
  stream: StreamName;
  audio_seconds: number;
  cost_usd: number;
  estimated: true;
  at: string;
}

export interface LiveDeps {
  apiKey: string;
  budget: Budget;
  log(row: LiveTranscriptionRow): void;
  onPartial(p: LivePartial): void;
  onError(message: string): void;
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
}

type LiveConfig = NonNullable<AppConfig["transcription"]["live"]>;

class StreamLink {
  ws: SocketLike | null = null;
  ready = false;
  pending: string[] = [];
  preroll: Float32Array[] = [];
  prerollSamples = 0;
  active = false;
  silenceSamples = 0;
  sentSinceCommit = 0;
  unbilledSamples = 0;
  resampler: LinearResampler = new sherpa.LinearResampler(SAMPLE_RATE, RATE);
  texts = new Map<string, string>();
  itemToUtterance = new Map<string, string>();
  awaitingCommit: string[] = [];
  constructor(readonly stream: StreamName) {}
}

/**
 * Streaming transcript for the display (OpenAI realtime transcription). Audio is sent only while the VAD hears speech,
 * with a pre-roll so the first word is whole; each VAD utterance end commits the turn. The final text used by Jev and
 * the fact-checker still comes from the per-utterance file transcription.
 */
export class LiveTranscriber {
  private readonly links = new Map<StreamName, StreamLink>();
  private disabled = false;
  private readonly connect: (url: string, headers: Record<string, string>) => SocketLike;

  constructor(private readonly cfg: AppConfig["transcription"], private readonly live: LiveConfig, private readonly deps: LiveDeps) {
    this.connect = deps.connect ?? ((url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as SocketLike);
  }

  private link(stream: StreamName): StreamLink {
    let l = this.links.get(stream);
    if (!l) {
      l = new StreamLink(stream);
      this.links.set(stream, l);
    }
    return l;
  }

  /** Opens the connection ahead of speech: setup takes ~1.5 s, which would otherwise delay the first words. */
  warm(stream: StreamName): void {
    this.ensure(this.link(stream));
  }

  private ensure(l: StreamLink): void {
    if (this.disabled || l.ws) return;
    try {
      this.deps.budget.assertCanSpend("transcription:live");
    } catch {
      this.disabled = true;
      return;
    }
    const ws = this.connect(REALTIME_URL, { Authorization: `Bearer ${this.deps.apiKey}` });
    l.ws = ws;
    l.ready = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: RATE },
              transcription: {
                model: this.live.model, delay: this.live.delay, languages: this.cfg.languages,
                keywords: this.cfg.keywords, prompt: this.cfg.prompt,
              },
              turn_detection: null,
            },
          },
        },
      }));
    };
    ws.onmessage = (ev) => this.onMessage(l, ws, String(ev.data));
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
      if (l.ws !== ws) return;
      this.bill(l);
      l.ws = null;
      l.ready = false;
      l.pending = [];
      l.awaitingCommit = [];
      if (ev?.code && ev.code !== 1000 && ev.code !== 1005) this.deps.onError(`live transcription closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
    };
  }

  private onMessage(l: StreamLink, ws: SocketLike, raw: string) {
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    switch (e.type) {
      case "session.updated":
        l.ready = true;
        for (const m of l.pending.splice(0)) ws.send(m);
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const text = (l.texts.get(e.item_id) ?? "") + (e.delta ?? "");
        l.texts.set(e.item_id, text);
        this.deps.onPartial({ stream: l.stream, itemId: e.item_id, text: text.trim(), utteranceId: l.itemToUtterance.get(e.item_id) ?? null, final: false });
        break;
      }
      case "input_audio_buffer.committed": {
        const u = l.awaitingCommit.shift();
        if (u && e.item_id) l.itemToUtterance.set(e.item_id, u);
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        this.deps.onPartial({
          stream: l.stream, itemId: e.item_id, text: String(e.transcript ?? "").trim(),
          utteranceId: l.itemToUtterance.get(e.item_id) ?? null, final: true,
        });
        l.texts.delete(e.item_id);
        break;
      }
      case "error": {
        const code = e.error?.code ?? "";
        if (code === "input_audio_buffer_commit_empty") break;
        this.deps.onError(`live transcription: ${e.error?.message ?? code ?? "error"}`);
        break;
      }
    }
  }

  private send(l: StreamLink, msg: string) {
    if (!l.ws) return;
    if (l.ready) l.ws.send(msg);
    else l.pending.push(msg);
  }

  private sendAudio(l: StreamLink, samples: Float32Array) {
    const pcm = toPcm16(l.resampler.resample(samples));
    if (pcm.length === 0) return;
    this.send(l, JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
    l.sentSinceCommit += samples.length;
    l.unbilledSamples += samples.length;
  }

  /** Every 16 kHz frame of a stream, with whether the VAD currently hears speech. */
  feed(stream: StreamName, samples: Float32Array, speaking: boolean): void {
    if (this.disabled) return;
    const l = this.link(stream);
    if (speaking) {
      if (!l.active) {
        l.active = true;
        this.ensure(l);
        for (const c of l.preroll) this.sendAudio(l, c);
        l.preroll = [];
        l.prerollSamples = 0;
      }
      l.silenceSamples = 0;
      this.sendAudio(l, samples);
    } else if (l.active) {
      this.sendAudio(l, samples);
      l.silenceSamples += samples.length;
      if (l.silenceSamples >= (this.live.hangoverMs * SAMPLE_RATE) / 1000) l.active = false;
    } else {
      l.preroll.push(samples);
      l.prerollSamples += samples.length;
      const max = (this.live.prerollMs * SAMPLE_RATE) / 1000;
      while (l.preroll.length > 1 && l.prerollSamples - l.preroll[0].length >= max) l.prerollSamples -= l.preroll.shift()!.length;
    }
  }

  /** The VAD closed an utterance: commit the turn so its text finalises and maps to that utterance. */
  commit(stream: StreamName, utteranceId: string): void {
    const l = this.links.get(stream);
    if (!l?.ws || l.sentSinceCommit === 0) return;
    this.send(l, JSON.stringify({ type: "input_audio_buffer.commit" }));
    l.awaitingCommit.push(utteranceId);
    l.sentSinceCommit = 0;
    this.bill(l);
  }

  private bill(l: StreamLink) {
    if (l.unbilledSamples === 0) return;
    const seconds = l.unbilledSamples / SAMPLE_RATE;
    l.unbilledSamples = 0;
    const cost = (seconds / 60) * this.live.usdPerMinute;
    this.deps.budget.record("transcription", cost);
    this.deps.log({
      kind: "live_transcription", stream: l.stream, audio_seconds: Math.round(seconds * 1000) / 1000, cost_usd: cost, estimated: true,
      at: new Date().toISOString(),
    });
  }

  close(): void {
    for (const l of this.links.values()) {
      this.bill(l);
      const ws = l.ws;
      l.ws = null;
      ws?.close();
    }
  }
}
