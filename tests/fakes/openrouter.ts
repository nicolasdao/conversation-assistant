/** A fake OpenRouter: the model catalogue, and chat completions streamed as server-sent events. */
export function fakeOpenRouter(reply = "Alice said [0:10] hello.", usage = { prompt_tokens: 120, completion_tokens: 8, cost: 0.0012 }) {
  const bodies: any[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", context_length: 1_050_000, pricing: { prompt: "0.0000001", completion: "0.0000005" }, top_provider: { max_completion_tokens: 128000 } }] }));
    }
    bodies.push(JSON.parse(String(init!.body)));
    const chunks = [
      ": OPENROUTER PROCESSING\n\n",
      ...reply.split(" ").map((w, i) => `data: ${JSON.stringify({ id: "gen-1", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ delta: { content: (i ? " " : "") + w } }] })}\n\n`),
      `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta: {} , finish_reason: "stop" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, bodies };
}

export interface CatalogueModel { id: string; name?: string; context_length?: number; pricing?: { prompt: string; completion: string }; top_provider?: { max_completion_tokens?: number } }

/**
 * A fake of OpenRouter's chat side, routed by URL: `/models` (the catalogue), `/chat/completions` (a queue of
 * responders, streaming or not), and `/generation?id=` (a queue of responders for the cost lookup). Records the
 * parsed body of every completion request and every URL.
 */
export class FakeOpenRouter {
  readonly bodies: any[] = [];
  readonly urls: string[] = [];
  models: CatalogueModel[] = [{ id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", context_length: 1_050_000, pricing: { prompt: "0.0000001", completion: "0.0000005" }, top_provider: { max_completion_tokens: 128000 } }];
  completions: ((body: any, init: RequestInit) => Response | Promise<Response>)[] = [];
  generations: ((id: string) => Response | Promise<Response>)[] = [];
  readonly fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    this.urls.push(u);
    if (u.endsWith("/models")) return new Response(JSON.stringify({ data: this.models }));
    if (u.includes("/generation")) {
      const r = this.generations.shift();
      if (!r) throw new Error("FakeOpenRouter: no generation response");
      return r(new URL(u).searchParams.get("id") ?? "");
    }
    if (u.includes("/chat/completions")) {
      const body = JSON.parse(String(init.body));
      this.bodies.push(body);
      const r = this.completions.shift();
      if (!r) throw new Error("FakeOpenRouter: no completion response");
      return r(body, init);
    }
    throw new Error(`FakeOpenRouter: unexpected URL ${u}`);
  }) as typeof fetch;
}

/** A non-streaming chat completion, as System 2 receives it. */
export const completion = (content: unknown, o: { usage?: Record<string, number>; annotations?: unknown[]; id?: string; model?: string } = {}): Response =>
  new Response(JSON.stringify({
    id: o.id ?? "gen-1", model: o.model ?? "openai/gpt-6-luna", provider: "OpenAI",
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content), annotations: o.annotations ?? [] } }],
    usage: o.usage ?? { prompt_tokens: 10, completion_tokens: 10, cost: 0.0003 },
  }));

/** The chunks of a streamed chat reply, word by word, ending with usage and [DONE]. */
export function replyChunks(reply: string, usage: Record<string, number> | null = { prompt_tokens: 120, completion_tokens: 8, cost: 0.0012 }, id = "gen-1"): string[] {
  return [
    ": OPENROUTER PROCESSING\n\n",
    ...reply.split(" ").map((w, i) => `data: ${JSON.stringify({ id, model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ delta: { content: (i ? " " : "") + w } }] })}\n\n`),
    ...(usage ? [`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`] : []),
    "data: [DONE]\n\n",
  ];
}
