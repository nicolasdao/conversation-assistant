import { createHash } from "node:crypto";
import type { AppConfig } from "../config.ts";
import type { Budget } from "../budget.ts";
import type { JevAnswer, JevResponse, JevUsage, QuestionSet } from "./types.ts";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export type JevPurpose = "utterance" | "segment" | "relabel" | "gate" | "preflight" | "smoke";
const LIVE: ReadonlySet<JevPurpose> = new Set(["utterance", "segment"]);

/** An HTTP failure carrying what retry classification needs; status null = no response (network error or timeout). */
export class HttpError extends Error {
  constructor(readonly status: number | null, readonly body: string, readonly retryAfterMs: number | null = null, message?: string) {
    super(message ?? (status === null ? body : `HTTP ${status}${body ? ` ${body.slice(0, 300)}` : ""}`));
  }
}

export type RetryClass = "retry" | "fail";

/** jev-xp's classifyError (§2.5), adapted to fetch. */
export function classifyError(e: unknown): RetryClass {
  if (!(e instanceof HttpError)) return "fail";
  const s = e.status;
  if (s === null) return "retry";
  if (s >= 200 && s < 300) {
    const code = embeddedErrorCode(e.body);
    if (code === null) return "retry";
    return classifyError(new HttpError(code, e.body, e.retryAfterMs));
  }
  if (s === 429 || s >= 500) return "retry";
  if (s === 402 && isTransient402(e.body)) return "retry";
  return "fail";
}

export function embeddedErrorCode(body: string): number | null {
  const start = body.indexOf("{");
  if (start < 0) return null;
  try {
    const code = JSON.parse(body.slice(start))?.error?.code;
    return typeof code === "number" && code >= 400 ? code : null;
  } catch {
    return null;
  }
}

function isTransient402(body: string): boolean {
  const start = body.indexOf("{");
  if (start < 0) return false;
  try {
    return JSON.parse(body.slice(start))?.error?.metadata?.limit_source === "openrouter_in_flight_budget";
  } catch {
    return false;
  }
}

/** The effective status: a 2xx error body is classified by its embedded code. */
export function effectiveStatus(e: HttpError): number | null {
  if (e.status !== null && e.status >= 200 && e.status < 300) return embeddedErrorCode(e.body);
  return e.status;
}

export function backoffMs(attempt: number, retryAfterMs: number | null, rand = Math.random): number {
  return (retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt)) + Math.floor(rand() * 500);
}

export function parseRetryAfter(ra: string | null, now = Date.now()): number | null {
  if (ra === null) return null;
  if (Number.isFinite(Number(ra))) return Number(ra) * 1000;
  return Math.max(0, Date.parse(ra) - now) || null;
}

export interface JevCallRow {
  kind: "jev_call";
  purpose: JevPurpose;
  utterance_id?: string;
  segment_id?: string;
  request_hash: string;
  state: unknown;
  question_ids: string[];
  question_set_version: string | null;
  ok: boolean;
  latency_ms: number;
  attempts: number;
  id: string | null;
  model_returned: string | null;
  provider_returned: string | null;
  answers: Record<string, JevAnswer> | null;
  usage: JevUsage | null;
  cost_usd: number;
  error?: string;
  at: string;
}

export interface JevCallMeta {
  purpose: JevPurpose;
  utterance_id?: string;
  segment_id?: string;
  question_set_version?: string;
  /** Overrides for smoke checks (§4.11). */
  timeoutMs?: number;
  maxAttempts?: number;
  live?: boolean;
}

export interface JevClientDeps {
  fetch: typeof fetch;
  apiKey: string;
  budget: Budget;
  log: (row: JevCallRow) => void;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

/** Raw-fetch Decisions client with a shared concurrency limit, shared pause, bounded retries, budget, and call log. */
export class JevClient {
  private active = 0;
  private readonly high: (() => void)[] = [];
  private readonly low: (() => void)[] = [];
  private pauseUntil = 0;

  constructor(private readonly cfg: AppConfig["jev"], private readonly deps: JevClientDeps) {}

  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  private async acquire(high: boolean) {
    if (this.active < this.cfg.concurrency) { this.active++; return; }
    await new Promise<void>((r) => (high ? this.high : this.low).push(r));
  }

  private release() {
    const next = this.high.shift() ?? this.low.shift();
    if (next) next();
    else this.active--;
  }

  /** When the shared pause ends (ms epoch); background calls wait it out, live calls never do. */
  get pausedUntil(): number {
    return this.pauseUntil;
  }

  async ask(state: unknown, questions: QuestionSet, meta: JevCallMeta): Promise<JevResponse> {
    const live = meta.live ?? LIVE.has(meta.purpose);
    await this.acquire(live);
    try {
      return await this.callWithRetry(state, questions, meta, live);
    } finally {
      this.release();
    }
  }

  private settings(meta: JevCallMeta, live: boolean) {
    const timeoutMs = meta.timeoutMs ?? (
      meta.purpose === "utterance" ? this.cfg.utteranceTimeoutMs
        : meta.purpose === "segment" ? this.cfg.segmentTimeoutMs
          : this.cfg.backgroundTimeoutMs);
    const maxAttempts = meta.maxAttempts ?? (live ? this.cfg.maxAttempts : this.cfg.backgroundMaxAttempts);
    return { timeoutMs, maxAttempts };
  }

  private async callWithRetry(state: unknown, questions: QuestionSet, meta: JevCallMeta, live: boolean): Promise<JevResponse> {
    const started = Date.now();
    const { timeoutMs, maxAttempts } = this.settings(meta, live);
    let attempt = 0;
    try {
      this.deps.budget.assertCanSpend(`jev:${meta.purpose}`);
    } catch (e) {
      this.log(state, questions, meta, { ok: false, attempts: 0, started, error: errorText(e) });
      throw e;
    }
    for (;;) {
      attempt++;
      if (!live) {
        const wait = this.pauseUntil - Date.now();
        if (wait > 0) await this.sleep(wait);
      }
      try {
        const res = await this.send(state, questions, timeoutMs);
        this.deps.budget.record("jev", res.usage.cost);
        this.log(state, questions, meta, { ok: true, res, attempts: attempt, started });
        return res;
      } catch (e) {
        const cls = classifyError(e);
        const status = e instanceof HttpError ? effectiveStatus(e) : null;
        const pauses = e instanceof HttpError && (status === 429 || status === 402);
        if (cls === "retry" && pauses) {
          // Shared pause for background callers; a live call goes straight to its fallback.
          const delay = backoffMs(attempt, (e as HttpError).retryAfterMs, this.deps.rand);
          this.pauseUntil = Math.max(this.pauseUntil, Date.now() + delay);
        }
        const liveRetryable = cls === "retry" && !pauses;
        if (cls === "fail" || attempt >= maxAttempts || (live && !liveRetryable)) {
          this.log(state, questions, meta, { ok: false, attempts: attempt, started, error: errorText(e) });
          if (e instanceof HttpError && status === 402 && cls === "fail") {
            this.deps.budget.exhaust("provider", `jev:${meta.purpose}`, "OpenRouter credits or key limit exhausted (402)");
          }
          if (e instanceof HttpError && status === 401) {
            throw new HttpError(401, e.body, null, "OpenRouter rejected the API key (401): check OPENROUTER_API_KEY");
          }
          throw e;
        }
        if (!live && !pauses) {
          const delay = backoffMs(attempt, e instanceof HttpError ? e.retryAfterMs : null, this.deps.rand);
          this.pauseUntil = Math.max(this.pauseUntil, Date.now() + delay);
        }
      }
    }
  }

  private async send(state: unknown, questions: QuestionSet, timeoutMs: number): Promise<JevResponse> {
    let res: Response;
    try {
      res = await this.deps.fetch(DECISIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.apiKey}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Podcast Assistant",
        },
        body: JSON.stringify({ model: this.cfg.model, state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new HttpError(null, errorText(e));
    }
    let text: string;
    try {
      text = await res.text(); // read once: error bodies are not always JSON
    } catch (e) {
      throw new HttpError(null, errorText(e)); // the timeout can fire while the body streams
    }
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if (!res.ok) throw new HttpError(res.status, text, retryAfterMs);
    const start = text.indexOf("{"); // the body may start with keep-alive whitespace
    if (start < 0) throw new HttpError(res.status, text, retryAfterMs);
    let body: any;
    try {
      body = JSON.parse(text.slice(start));
    } catch {
      throw new HttpError(res.status, text, retryAfterMs);
    }
    if (body.error) throw new HttpError(res.status, text, retryAfterMs); // an upstream error delivered with HTTP 200
    if (typeof body.usage?.cost !== "number") throw new HttpError(-1, text, null, "response without usage.cost rejected");
    return {
      answers: body.answers ?? {},
      id: body.id ?? null,
      model: body.model,
      provider: body.provider ?? null,
      usage: { input_tokens: body.usage.input_tokens ?? 0, output_tokens: body.usage.output_tokens ?? 0, cost: body.usage.cost },
    };
  }

  private log(
    state: unknown, questions: QuestionSet, meta: JevCallMeta,
    r: { ok: boolean; res?: JevResponse; attempts: number; started: number; error?: string },
  ) {
    this.deps.log({
      kind: "jev_call",
      purpose: meta.purpose,
      ...(meta.utterance_id ? { utterance_id: meta.utterance_id } : {}),
      ...(meta.segment_id ? { segment_id: meta.segment_id } : {}),
      request_hash: requestHash(this.cfg.model, state, questions),
      state,
      question_ids: Object.keys(questions),
      question_set_version: meta.question_set_version ?? null,
      ok: r.ok,
      latency_ms: Date.now() - r.started,
      attempts: r.attempts,
      id: r.res?.id ?? null,
      model_returned: r.res?.model ?? null,
      provider_returned: r.res?.provider ?? null,
      answers: r.res?.answers ?? null,
      usage: r.res?.usage ?? null,
      cost_usd: r.res?.usage.cost ?? 0,
      ...(r.error ? { error: r.error } : {}),
      at: new Date().toISOString(),
    });
  }
}

export function requestHash(model: string, state: unknown, questions: QuestionSet): string {
  return createHash("sha256").update(JSON.stringify({ model, state, questions })).digest("hex").slice(0, 16);
}

function errorText(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
