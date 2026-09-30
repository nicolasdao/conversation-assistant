/** Response builders for fake `fetch` functions. */

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const text = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

/** What `AbortSignal.timeout` makes fetch throw. */
export const timeoutError = (): DOMException => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** What fetch throws when the network is down. */
export const networkError = (): TypeError => new TypeError("fetch failed");

/** A 200 whose body errors while being read. */
export const brokenBody = (status = 200): Response =>
  new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } }), { status });

/**
 * A server-sent event stream: each chunk is written as it is (use `sseData` for `data:` lines). `holdOpen` never closes
 * the stream (until the request's signal aborts it); `errorAfter` fails the stream after that many chunks.
 */
export function sse(chunks: string[], opts: { holdOpen?: boolean; errorAfter?: number; signal?: AbortSignal | null } = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x, i) => {
        if (opts.errorAfter !== undefined && i >= opts.errorAfter) return;
        c.enqueue(enc.encode(x));
      });
      if (opts.errorAfter !== undefined && opts.errorAfter < chunks.length) { c.error(new TypeError("terminated")); return; }
      if (!opts.holdOpen) { c.close(); return; }
      opts.signal?.addEventListener("abort", () => { try { c.error(opts.signal!.reason ?? new DOMException("aborted", "AbortError")); } catch { /* closed */ } });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export const sseData = (payload: unknown): string => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
