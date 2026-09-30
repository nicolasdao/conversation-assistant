// The external services the end-to-end harness answers in place of the network (docs/testing.md § E2E web).
import { fakeServicesFetch, replyChunks, type CatalogueModel } from "../../tests/fakes/index.ts";
import type { loadScript } from "../../tests/helpers.ts";
import type { SocketLike } from "../../src/transcribe/live.ts";

export const CHAT_MODELS: CatalogueModel[] = [
  { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", context_length: 1_050_000, pricing: { prompt: "0.00000125", completion: "0.00001" }, top_provider: { max_completion_tokens: 128000 } },
  { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", context_length: 1_000_000, pricing: { prompt: "0.000003", completion: "0.000015" }, top_provider: { max_completion_tokens: 64000 } },
];

export interface ServiceSwitches {
  /** Every Jev call answers a non-transient 402: OpenRouter's credit is used up. */
  openrouter402?: boolean;
  /** Key checks answer 401 for keys containing this text. */
  refuseKeysWith?: string;
}

/**
 * One fetch for everything the engine calls: transcription, Jev and System 2 (the session tests' fake, without its
 * one echoed-key error), the chat's catalogue and streamed replies, and the key checks of the setup screen.
 */
export function e2eFetch(script: ReturnType<typeof loadScript>, sw: ServiceSwitches = {}): typeof fetch {
  const services = fakeServicesFetch(script, { echoKeyOnce: false }).f;
  let chatN = 0;
  return (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? "");
    if (u.startsWith("https://api.openai.com/v1/models")) {
      if (sw.refuseKeysWith && auth.includes(sw.refuseKeysWith)) return new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 });
      return new Response(JSON.stringify({ data: [{ id: "gpt-transcribe" }, { id: "gpt-live-transcribe" }] }));
    }
    if (u.startsWith("https://openrouter.ai/api/v1/key")) {
      if (sw.refuseKeysWith && auth.includes(sw.refuseKeysWith)) return new Response(JSON.stringify({ error: { message: "No auth credentials found" } }), { status: 401 });
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 9.5, is_free_tier: false } }));
    }
    if (u.endsWith("/models")) return new Response(JSON.stringify({ data: CHAT_MODELS }));
    if (u.includes("/generation")) return new Response(JSON.stringify({ data: { total_cost: 0.0012 } }));
    if (u.includes("alpha/decisions") && sw.openrouter402) {
      return new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { status: 402 });
    }
    if (u.includes("chat/completions") && JSON.parse(String(init.body)).stream) {
      chatN++;
      const enc = new TextEncoder();
      const chunks = replyChunks(`Daniel said [0:05] that Jev is cheap, reply ${chatN}.`, { prompt_tokens: 120, completion_tokens: 8, cost: 0.0012 }, `gen-chat-${chatN}`);
      const signal = init.signal;
      // streamed a word every 150 ms, so a test can stop it midway
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          for (const x of chunks) {
            if (signal?.aborted) { c.error(signal.reason); return; }
            c.enqueue(enc.encode(x));
            await new Promise((r) => setTimeout(r, 150));
          }
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return services(u, init);
  }) as typeof fetch;
}

/** OpenAI's realtime socket for live text: it accepts the session and the audio, and sends no text. */
export class FakeRealtimeSocket implements SocketLike {
  readyState = 1;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {
    setTimeout(() => this.onopen?.({} as never), 0);
  }
  send(d: string) {
    const m = JSON.parse(d);
    if (m.type === "session.update") setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "session.updated", session: m.session }) }), 0);
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
