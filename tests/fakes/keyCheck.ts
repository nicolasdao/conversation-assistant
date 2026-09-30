/** A fake of both services: `status` per host, and OpenRouter's key info. */
export function fakeKeyCheckFetch(opts: { openai?: number; openrouter?: number; limit?: number | null; freeTier?: boolean; models?: string[]; offline?: boolean } = {}) {
  const seen: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>)?.Authorization));
    if (opts.offline) throw new TypeError("fetch failed");
    if (String(url).includes("openai.com")) {
      return new Response(JSON.stringify({ data: (opts.models ?? ["gpt-transcribe", "gpt-live-transcribe"]).map((id) => ({ id })) }), { status: opts.openai ?? 200 });
    }
    return new Response(JSON.stringify({ data: { limit: opts.limit === undefined ? 10 : opts.limit, limit_remaining: 9.5, is_free_tier: opts.freeTier ?? false } }), { status: opts.openrouter ?? 200 });
  }) as typeof fetch;
  return { f, seen };
}
