import { DECISIONS_URL } from "../../src/jev/client.ts";
import { json, timeoutError } from "./responses.ts";

export type Responder = (req: { body: any; init: RequestInit }) => Response | Promise<Response>;

/** Answer builders for Jev's question types. */
export const noulA = (noul: number) => ({ type: "noul", noul });
export const choiceA = (choice: string, confidence = 0.9) => ({ type: "choice", choice, confidence, probabilities: {} });
export const scoreA = (score: number, confidence = 0.9) => ({ type: "score", score, confidence, probabilities: {} });

/** A successful decisions response. */
export const jevOk = (answers: Record<string, unknown>, o: { cost?: number; id?: string; model?: string; provider?: string } = {}): Response =>
  json({ answers, id: o.id ?? "gen-dec-1", model: o.model ?? "typesafe/jev-1.13-20260917", provider: o.provider ?? "TypeSafe", usage: { cost: o.cost ?? 0.00002, input_tokens: 400, output_tokens: 10 } });

export const jevErr = (status: number, error: { code?: number; message?: string; [k: string]: unknown } = {}, headers: Record<string, string> = {}): Response =>
  json({ error: { code: status, message: "error", ...error } }, status, headers);

/**
 * A fake of Jev's decisions endpoint: a queue of responders (or one default), recording every request with its
 * parsed body. Throws on any other URL, and when the queue runs dry without a default.
 */
export class FakeJev {
  readonly requests: { url: string; body: any; init: RequestInit }[] = [];
  private readonly queue: Responder[];
  constructor(queue: Responder[] = [], private readonly fallback?: Responder) { this.queue = [...queue]; }
  push(...r: Responder[]): this { this.queue.push(...r); return this; }
  readonly fetch = (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url) !== DECISIONS_URL) throw new Error(`FakeJev: unexpected URL ${url}`);
    const body = JSON.parse(String(init.body));
    this.requests.push({ url: String(url), body, init });
    const r = this.queue.shift() ?? this.fallback;
    if (!r) throw new Error("FakeJev: no more responses");
    return r({ body, init });
  }) as typeof fetch;
  static timeout: Responder = () => { throw timeoutError(); };
}
