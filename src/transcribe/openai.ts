import type { AppConfig } from "../config.ts";
import type { Budget } from "../budget.ts";
import { encodeWav, SAMPLE_RATE } from "../audio/wav.ts";

export const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
export const USD_PER_AUDIO_MINUTE = 0.0045;
const FILLER = /^(uh|um|mm|hmm|mm-hmm|yeah|yes|no|okay|ok|right|so)\W*$/i;

export interface TranscriptionRow {
  kind: "transcription";
  utterance_id: string;
  ok: boolean;
  latency_ms: number;
  attempts: number;
  audio_seconds: number;
  cost_usd: number;
  estimated: true;
  error?: string;
  at: string;
}

export type TranscriptionResult =
  | { ok: true; text: string; filler: boolean }
  /** `retryable`: the failure looked transient (network, timeout, 429 other than no credits, 5xx), so trying later may work. */
  | { ok: false; error: string; retryable?: boolean };

export interface TranscriberDeps {
  fetch: typeof fetch;
  apiKey: string;
  budget: Budget;
  log: (row: TranscriptionRow) => void;
}

class HttpFailure extends Error {
  constructor(readonly status: number | null, readonly body: string) {
    super(status === null ? body : `HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export function applyFixes(text: string, fixes: AppConfig["transcription"]["fixes"]): string {
  return fixes.reduce((t, f) => t.replace(new RegExp(`\\b(?:${f.pattern})\\b`, "g"), f.replace), text);
}

/** A VAD sliver this short (54 ms was seen) has no words, and the API answers 400 "Audio file might be corrupted". */
export const MIN_AUDIO_SECONDS = 0.25;

/** Per-clip guidance for the final transcript: a prompt (with the conversation so far) and extra keywords. */
export interface TranscriptionContext { prompt?: string; keywords?: string[] }

export function isFiller(text: string): boolean {
  const t = text.trim();
  return t.length < 4 || FILLER.test(t);
}

/** Per-utterance file transcription with OpenAI gpt-transcribe (§4.5). */
export class Transcriber {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** `brackets` sends keywords[] / languages[]; `plain` is the §4.5 fallback when the API rejects brackets. */
  private fieldStyle: "brackets" | "plain" = "brackets";

  constructor(private readonly cfg: AppConfig["transcription"], private readonly deps: TranscriberDeps) {}

  private async acquire() {
    if (this.active < this.cfg.concurrency) { this.active++; return; }
    await new Promise<void>((r) => this.waiting.push(r));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  buildForm(wav: Buffer, style = this.fieldStyle, context: TranscriptionContext = {}): FormData {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
    form.append("model", this.cfg.model);
    form.append("prompt", context.prompt ?? this.cfg.prompt);
    const k = style === "brackets" ? "keywords[]" : "keywords";
    const l = style === "brackets" ? "languages[]" : "languages";
    for (const kw of [...new Set([...this.cfg.keywords, ...(context.keywords ?? [])])]) form.append(k, kw);
    for (const lang of this.cfg.languages) form.append(l, lang);
    return form;
  }

  private async send(wav: Buffer, context?: TranscriptionContext): Promise<string> {
    let res: Response;
    try {
      res = await this.deps.fetch(TRANSCRIBE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.deps.apiKey}` }, // no Content-Type: fetch sets the multipart boundary
        body: this.buildForm(wav, this.fieldStyle, context),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw new HttpFailure(null, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    const body = await res.text();
    if (!res.ok) throw new HttpFailure(res.status, body);
    const json = JSON.parse(body);
    if (typeof json?.text !== "string") throw new HttpFailure(res.status, "response without text");
    return json.text;
  }

  private rejectsBrackets(e: unknown): boolean {
    return e instanceof HttpFailure && e.status === 400 && this.fieldStyle === "brackets" && /keywords|languages/i.test(e.body);
  }

  /**
   * `context` makes a short clip less ambiguous: the conversation so far and the names in it. Clips shorter than
   * MIN_AUDIO_SECONDS are not sent (the API rejects them as corrupted); they come back as empty text, which drops them.
   */
  async transcribe(utteranceId: string, samples: Float32Array, context?: TranscriptionContext): Promise<TranscriptionResult> {
    const audioSeconds = samples.length / SAMPLE_RATE;
    if (audioSeconds < MIN_AUDIO_SECONDS) return { ok: true, text: "", filler: false };
    this.deps.budget.assertCanSpend("transcription");
    await this.acquire();
    const started = Date.now();
    let attempts = 0;
    try {
      const wav = encodeWav(samples);
      let lastError: unknown;
      let lastRetryable = false;
      let styleRetried = false;
      while (attempts < 2 || (styleRetried && attempts < 3)) {
        attempts++;
        try {
          const raw = await this.send(wav, context);
          const cost = (audioSeconds / 60) * USD_PER_AUDIO_MINUTE;
          this.deps.budget.record("transcription", cost);
          this.log(utteranceId, { ok: true, attempts, started, audioSeconds, cost });
          const text = applyFixes(raw, this.cfg.fixes).trim();
          return { ok: true, text, filler: isFiller(text) };
        } catch (e) {
          lastError = e;
          if (this.rejectsBrackets(e) && !styleRetried) {
            this.fieldStyle = "plain";
            styleRetried = true;
            continue;
          }
          // A 429 for exhausted credits (insufficient_quota) is not transient.
          const noCredits = e instanceof HttpFailure && e.status === 429 && /insufficient_quota|credit_balance_exhausted/.test(e.body);
          const retryable = e instanceof HttpFailure && !noCredits && (e.status === null || e.status === 429 || e.status >= 500);
          lastRetryable = retryable;
          if (!retryable) break;
        }
      }
      const error = lastError instanceof Error ? lastError.message : String(lastError);
      this.log(utteranceId, { ok: false, attempts, started, audioSeconds, cost: 0, error });
      return { ok: false, error, retryable: lastRetryable };
    } finally {
      this.release();
    }
  }

  private log(utteranceId: string, r: { ok: boolean; attempts: number; started: number; audioSeconds: number; cost: number; error?: string }) {
    this.deps.log({
      kind: "transcription",
      utterance_id: utteranceId,
      ok: r.ok,
      latency_ms: Date.now() - r.started,
      attempts: r.attempts,
      audio_seconds: Math.round(r.audioSeconds * 1000) / 1000,
      cost_usd: r.cost,
      estimated: true,
      ...(r.error ? { error: r.error } : {}),
      at: new Date().toISOString(),
    });
  }
}
