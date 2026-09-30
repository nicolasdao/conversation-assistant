// The page's HTTP client (web/src/api.ts), in node with a recording fake fetch and a fake XMLHttpRequest.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, ApiError, type ChatStreamEvent } from "../../web/src/api.ts";
import { json, sse, sseData, text } from "../fakes/index.ts";

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

describe("every command's method, path and body", () => {
  const cases: [string, () => Promise<unknown>, string, string, unknown][] = [
    ["setup", () => api.setup(), "GET", "/api/setup", undefined],
    ["saveKeys", () => api.saveKeys({ openrouter: "sk-or-x" }), "POST", "/api/setup/keys", { openrouter: "sk-or-x" }],
    ["transcription", () => api.transcription(), "GET", "/api/transcription", undefined],
    ["setTranscription", () => api.setTranscription("apple"), "PUT", "/api/transcription", { engine: "apple" }],
    ["installModel", () => api.installModel(), "POST", "/api/transcription/install", undefined],
    ["about", () => api.about(), "GET", "/api/about", undefined],
    ["licenses", () => api.licenses(), "GET", "/api/licenses", undefined],
    ["closeView", () => api.closeView(), "POST", "/api/sessions/close", undefined],
    ["calls default", () => api.calls("s1"), "GET", "/api/calls?system=s1&limit=300", undefined],
    ["calls limit", () => api.calls("s2", 200), "GET", "/api/calls?system=s2&limit=200", undefined],
    ["engine", () => api.engine(), "GET", "/api/engine", undefined],
    ["stats", () => api.stats(), "GET", "/api/stats", undefined],
    ["devices", () => api.devices(), "GET", "/api/devices", undefined],
    ["startReplay", () => api.startReplay("fixtures/conversation", "max", 2, { factcheck: true, labels: false }, { labelSet: null, stories: ["a"] }),
      "POST", "/api/session/start", { mode: "replay", dir: "fixtures/conversation", speed: "max", voices: 2, features: { factcheck: true, labels: false }, labelSet: null, stories: ["a"] }],
    ["startReplay bare", () => api.startReplay("d", 1), "POST", "/api/session/start", { mode: "replay", dir: "d", speed: 1 }],
    ["startLive without a mic", () => api.startLive(), "POST", "/api/session/start", { mode: "live" }],
    ["startLive with a mic", () => api.startLive("usb1", 2, { factcheck: true, labels: true }, { labelSet: "builtin" }),
      "POST", "/api/session/start", { mode: "live", mic: "usb1", voices: 2, features: { factcheck: true, labels: true }, labelSet: "builtin" }],
    ["stop", () => api.stop(), "POST", "/api/session/stop", undefined],
    ["pause", () => api.pause(), "POST", "/api/session/pause", undefined],
    ["resume", () => api.resume(), "POST", "/api/session/resume", undefined],
    ["rename encodes the id", () => api.rename("a/b", "Alice"), "POST", "/api/speakers/a%2Fb/rename", { displayName: "Alice" }],
    ["suggestMerges", () => api.suggestMerges(), "GET", "/api/speakers/suggestions", undefined],
    ["suggestMerges with voices", () => api.suggestMerges(2), "GET", "/api/speakers/suggestions?voices=2", undefined],
    ["suggestMerges with 0 voices", () => api.suggestMerges(0), "GET", "/api/speakers/suggestions?voices=0", undefined],
    ["relabel", () => api.relabel(), "POST", "/api/labels/relabel", undefined],
    ["putStories", () => api.putStories(["x"]), "PUT", "/api/stories", { headlines: ["x"] }],
    ["override", () => api.override("c 1"), "POST", "/api/claims/c%201/override", {}],
    ["override with a note", () => api.override("c1", "host says so"), "POST", "/api/claims/c1/override", { note: "host says so" }],
    ["sessions", () => api.sessions(), "GET", "/api/sessions", undefined],
    ["sessions search", () => api.sessions("x y"), "GET", "/api/sessions?q=x%20y", undefined],
    ["renameSession", () => api.renameSession("s/1", "Pilot"), "PATCH", "/api/sessions/s%2F1", { name: "Pilot" }],
    ["openSession", () => api.openSession("s1"), "POST", "/api/sessions/s1/open", undefined],
    ["replaySession", () => api.replaySession("s1", 1, 3, { factcheck: false, labels: false }),
      "POST", "/api/session/start", { mode: "replay", sessionId: "s1", speed: 1, voices: 3, features: { factcheck: false, labels: false } }],
    ["deleteSession", () => api.deleteSession("s1"), "DELETE", "/api/sessions/s1", undefined],
    ["chatModels", () => api.chatModels(), "GET", "/api/chat/models", undefined],
    ["chats", () => api.chats(), "GET", "/api/chats", undefined],
    ["chat", () => api.chat("chat_1"), "GET", "/api/chats/chat_1", undefined],
    ["createChat", () => api.createChat("openai/gpt-6-luna"), "POST", "/api/chats", { model: "openai/gpt-6-luna" }],
    ["updateChat", () => api.updateChat("chat_1", { title: "T" }), "PATCH", "/api/chats/chat_1", { title: "T" }],
    ["deleteChat", () => api.deleteChat("chat_1"), "DELETE", "/api/chats/chat_1", undefined],
    ["stopChat", () => api.stopChat("chat_1"), "POST", "/api/chats/chat_1/stop", undefined],
    ["exportInfo", () => api.exportInfo("s1"), "GET", "/api/sessions/s1/export", undefined],
    ["exportPrepare", () => api.exportPrepare("s1", "none", true), "POST", "/api/sessions/s1/export", { audio: "none", chats: true }],
    ["importCopy", () => api.importCopy("t/1", "Pilot (copy)"), "POST", "/api/sessions/import/t%2F1", { name: "Pilot (copy)" }],
    ["rollback", () => api.rollback("s1@1"), "POST", "/api/s1/rollback", { version: "s1@1" }],
    ["labelSets", () => api.labelSets(), "GET", "/api/label-sets", undefined],
    ["labelSet", () => api.labelSet("my set"), "GET", "/api/label-sets/my%20set", undefined],
    ["createLabelSet", () => api.createLabelSet({ name: "x" }), "POST", "/api/label-sets", { name: "x" }],
    ["updateLabelSet", () => api.updateLabelSet("a", { name: "y" }), "PUT", "/api/label-sets/a", { name: "y" }],
    ["deleteLabelSet", () => api.deleteLabelSet("a"), "DELETE", "/api/label-sets/a", undefined],
    ["cloneLabelSet", () => api.cloneLabelSet("builtin"), "POST", "/api/label-sets/builtin/clone", undefined],
    ["importLabelSet", () => api.importLabelSet({ format: "tattle-labels" }), "POST", "/api/label-sets/import", { format: "tattle-labels" }],
    ["checkLabelSet", () => api.checkLabelSet({ name: "d" }), "POST", "/api/label-sets/estimate", { name: "d" }],
    ["tryLabelSet", () => api.tryLabelSet({ name: "d" }, "s1"), "POST", "/api/label-sets/try", { set: { name: "d" }, sessionId: "s1", minutes: 10 }],
    ["tryLabelSet minutes", () => api.tryLabelSet(null, "s1", 3), "POST", "/api/label-sets/try", { set: null, sessionId: "s1", minutes: 3 }],
    ["assistLabels", () => api.assistLabels("conv1", [{ role: "user", content: "hi" }], null, ["x"]),
      "POST", "/api/label-sets/assist", { conversationId: "conv1", messages: [{ role: "user", content: "hi" }], draft: null, skipped: ["x"] }],
  ];
  test.each(cases)("%s", async (_name, run, method, url, body) => {
    const reqs = fakeFetch();
    await run();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ method, url });
    expect(reqs[0]!.body).toEqual(body);
  });

  test("labelSetExportUrl is a plain encoded URL, with no request", () => {
    const reqs = fakeFetch();
    expect(api.labelSetExportUrl("a b")).toBe("/api/label-sets/a%20b/export");
    expect(reqs).toEqual([]);
  });
});

describe("sendChat: the streamed reply", () => {
  const collect = async (res: Response, body: { content?: string; mode?: string } = { content: "q", mode: "send" }) => {
    const reqs = fakeFetch(() => res);
    const got: ChatStreamEvent[] = [];
    await api.sendChat("chat_1", body, (e) => got.push(e));
    return { got, reqs };
  };

  test("posts the question and streams start, thinking, delta and done, across arbitrary chunk boundaries", async () => {
    const all = [
      sseData({ type: "start", user: null, assistantId: "m_2", model: "m" }), sseData({ type: "thinking" }),
      sseData({ type: "delta", text: "Hel" }), sseData({ type: "delta", text: "lo" }), sseData({ type: "done", message: { id: "m_2" }, chat: { id: "chat_1" } }),
    ].join("");
    // split mid-line and mid-separator
    const chunks = [all.slice(0, 7), all.slice(7, 60), all.slice(60, all.indexOf("\n\n", 100) + 1), all.slice(all.indexOf("\n\n", 100) + 1)];
    const { got, reqs } = await collect(sse(chunks));
    expect(got.map((e) => e.type)).toEqual(["start", "thinking", "delta", "delta", "done"]);
    expect(got.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("Hello");
    expect(reqs[0]).toEqual({ url: "/api/chats/chat_1/messages", method: "POST", headers: { "Content-Type": "application/json" }, body: { content: "q", mode: "send" } });
  });

  test("joins multi-line data fields and ignores event, id and comment lines", async () => {
    const { got } = await collect(sse([': ping\n\n', 'event: x\nid: 3\ndata: {"type":\ndata: "delta","text":"a"}\n\n']));
    expect(got).toEqual([{ type: "delta", text: "a" }]);
  });

  test("ignores blocks without data", async () => {
    const { got } = await collect(sse(["event: nothing\n\n", "\n\n", sseData({ type: "thinking" })]));
    expect(got).toEqual([{ type: "thinking" }]);
  });

  test("a trailing block without its blank line is dropped (documents behaviour)", async () => {
    const { got } = await collect(sse([sseData({ type: "thinking" }), 'data: {"type":"delta","text":"x"}\n']));
    expect(got).toEqual([{ type: "thinking" }]);
  });

  test("a malformed data line rejects with the parse error", async () => {
    fakeFetch(() => sse(["data: {nope\n\n"]));
    await expect(api.sendChat("chat_1", { mode: "regenerate" }, () => {})).rejects.toThrow(SyntaxError);
  });

  test("an error response throws ApiError with the JSON error, else the text, else the status text", async () => {
    fakeFetch(() => json({ error: "a reply is already being written" }, 409));
    const a = await api.sendChat("c", {}, () => {}).catch((x) => x);
    expect([a instanceof ApiError, a.status, a.message]).toEqual([true, 409, "a reply is already being written"]);
    fakeFetch(() => text("plain failure", 500));
    expect((await api.sendChat("c", {}, () => {}).catch((x) => x)).message).toBe("plain failure");
    fakeFetch(() => new Response("", { status: 502, statusText: "Bad Gateway" }));
    expect((await api.sendChat("c", {}, () => {}).catch((x) => x)).message).toBe("Bad Gateway");
    fakeFetch(() => text("{}", 400));
    expect((await api.sendChat("c", {}, () => {}).catch((x) => x)).message).toBe("{}");
  });

  test("an OK response without a body throws an ApiError too", async () => {
    fakeFetch(() => new Response(null, { status: 200, statusText: "OK" }));
    const e = await api.sendChat("c", {}, () => {}).catch((x) => x);
    expect([e instanceof ApiError, e.status, e.message]).toEqual([true, 200, "OK"]);
  });
});

describe("importRecording: the upload with progress", () => {
  class FakeXhr {
    static last: FakeXhr;
    method = ""; url = ""; headers: Record<string, string> = {}; sent: unknown = null;
    status = 0; statusText = ""; responseText = "";
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeXhr.last = this; }
    open(m: string, u: string) { this.method = m; this.url = u; }
    setRequestHeader(k: string, v: string) { this.headers[k] = v; }
    send(body: unknown) { this.sent = body; }
    answer(status: number, body: string, statusText = "") { Object.assign(this, { status, responseText: body, statusText }); this.onload!(); }
  }
  const file = { name: "Pilot épisode.tattle" } as File;

  test("posts the file as octet-stream with its encoded name", () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    void api.importRecording(file, () => {});
    const x = FakeXhr.last;
    expect([x.method, x.url, x.sent]).toEqual(["POST", "/api/sessions/import", file]);
    expect(x.headers).toEqual({ "Content-Type": "application/octet-stream", "X-File-Name": "Pilot%20%C3%A9pisode.tattle" });
  });

  test("reports progress only when the length is known, and resolves the JSON on 2xx", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    const p = api.importRecording(file, (d) => progress.push(d));
    const x = FakeXhr.last;
    x.upload.onprogress!({ lengthComputable: false, loaded: 5, total: 0 });
    x.upload.onprogress!({ lengthComputable: true, loaded: 25, total: 100 });
    x.upload.onprogress!({ lengthComputable: true, loaded: 100, total: 100 });
    x.answer(201, JSON.stringify({ summary: { id: "s1" }, already: false }));
    expect(await p).toEqual({ summary: { id: "s1" }, already: false });
    expect(progress).toEqual([0.25, 1]);
  });

  test("rejects an ApiError with the JSON error, or the status text when the body is not JSON", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const a = api.importRecording(file, () => {});
    FakeXhr.last.answer(409, JSON.stringify({ error: "a session is on air" }), "Conflict");
    const e = await a.catch((x) => x);
    expect([e instanceof ApiError, e.status, e.message]).toEqual([true, 409, "a session is on air"]);
    const b = api.importRecording(file, () => {});
    FakeXhr.last.answer(500, "<html>", "Internal Server Error");
    expect((await b.catch((x) => x)).message).toBe("Internal Server Error");
    const c = api.importRecording(file, () => {});
    FakeXhr.last.answer(199, "{}", "odd");
    expect((await c.catch((x) => x)).status).toBe(199);
  });

  test("a network failure rejects ApiError(0) asking whether the server is running", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const p = api.importRecording(file, () => {});
    FakeXhr.last.onerror!();
    const e = await p.catch((x) => x);
    expect([e instanceof ApiError, e.status, e.message]).toEqual([true, 0, "the upload failed: is the server running?"]);
  });
});
