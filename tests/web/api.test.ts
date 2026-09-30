// The page's HTTP client (web/src/api.ts), in node with a recording fake fetch and a fake XMLHttpRequest.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, ApiError } from "../../web/src/api.ts";
import { json, text } from "../fakes/index.ts";

type Req = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Stubs fetch: every request is recorded, and answered by `answer` (default: 200 `{}`). */
function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response> = () => json({})) {
  const reqs: Req[] = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    reqs.push({
      url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return answer(url, init);
  });
  vi.stubGlobal("fetch", f);
  return reqs;
}

afterEach(() => vi.unstubAllGlobals());

describe("call: requests and answers", () => {
  test("a GET sends no body and no Content-Type", async () => {
    const reqs = fakeFetch(() => json({ session: null }));
    expect(await api.state()).toEqual({ session: null });
    expect(reqs).toEqual([{ url: "/api/state", method: "GET", headers: {}, body: undefined }]);
  });

  test("a POST sends JSON with Content-Type application/json", async () => {
    const reqs = fakeFetch();
    await api.merge("a", "b");
    expect(reqs[0]).toEqual({ url: "/api/speakers/merge", method: "POST", headers: { "Content-Type": "application/json" }, body: { fromId: "a", intoId: "b" } });
  });

  test("an empty 2xx body gives null", async () => {
    fakeFetch(() => text("", 200));
    expect(await api.stop()).toBeNull();
  });

  test("a non-JSON 2xx body gives null", async () => {
    fakeFetch(() => text("<html>", 200));
    expect(await api.stats()).toBeNull();
  });

  test("an error response throws ApiError with its status, its JSON error, and its JSON body", async () => {
    fakeFetch(() => json({ error: "OpenRouter key missing", needsKey: "openrouter" }, 400));
    const e = await api.startLive().catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.message, e.body]).toEqual([400, "OpenRouter key missing", { error: "OpenRouter key missing", needsKey: "openrouter" }]);
  });

  test("an error body that is not JSON is the message itself, with no body", async () => {
    fakeFetch(() => text("Bad Gateway from proxy", 502));
    const e = await api.state().catch((x) => x);
    expect([e.status, e.message, e.body]).toEqual([502, "Bad Gateway from proxy", null]);
  });

  test("an error JSON that is not an object keeps the text as the message", async () => {
    fakeFetch(() => text("42", 500));
    const e = await api.state().catch((x) => x);
    expect([e.message, e.body]).toEqual(["42", null]);
  });

  // B5: the message fell back to the empty text, so the toast showing it was blank.
  test("an error with an empty body says its status and status text", async () => {
    fakeFetch(() => new Response("", { status: 503, statusText: "Service Unavailable" }));
    const e = await api.state().catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.message]).toEqual([503, "503 Service Unavailable"]);
  });

  test("an error with an empty body and no status text still says its status", async () => {
    fakeFetch(() => new Response("", { status: 500 }));
    expect((await api.state().catch((x) => x)).message).toMatch(/^500\b/);
  });
});
