import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, test } from "vitest";
import { createApiServer, type EngineApi } from "../src/server/main.ts";
import { inProcessHandler } from "../src/server/inProcess.ts";
import { EventBus } from "../src/store/events.ts";
import { wavHeader } from "../src/audio/wav.ts";

// The Mac app's window reaches the engine through inProcessHandler: the same router as `npm run serve`, with no port.

const bus = new EventBus();
const renamed: [string, string][] = [];
const audioDir = mkdtempSync(join(tmpdir(), "audio-"));
const engine = {
  bus,
  state: () => ({ session: { id: "s1" } }),
  renameSpeaker: (id: string, displayName: string) => { renamed.push([id, displayName]); return { id, displayName }; },
  sessionDir: () => audioDir,
} as unknown as EngineApi;
const web = mkdtempSync(join(tmpdir(), "web-"));
mkdirSync(join(web, "dist"));
writeFileSync(join(web, "index.html"), "<!doctype html><title>t</title>");
const setupSeen: unknown[] = [];
const setup = { status: () => ({ configured: true }), save: async (b: unknown) => { setupSeen.push(b); return { saved: true }; } };
const handle = inProcessHandler(createApiServer(engine, { webRoot: web, setup }));
const at = (path: string, init?: RequestInit) => handle(new Request(`app://conversation-assistant${path}`, init));
const subscribers = () => (bus as unknown as { subs: Set<unknown> }).subs.size;

describe("the in-process connection", () => {
  test("serves the page and JSON routes", async () => {
    const page = await at("/recordings/20260925-120000");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("<title>t</title>");
    const state = await at("/api/state");
    expect(await state.json()).toEqual({ session: { id: "s1" } });
    expect((await at("/api/nope")).status).toBe(404);
  });

  test("passes request bodies, and the app's own page may use the setup routes", async () => {
    const r = await at("/api/speakers/spk_1/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Nic" }) });
    expect(await r.json()).toEqual({ id: "spk_1", displayName: "Nic" });
    expect(renamed).toEqual([["spk_1", "Nic"]]);
    // the window's Origin is app://conversation-assistant, which the router would refuse from a browser
    const keys = await at("/api/setup/keys", {
      method: "POST", headers: { "content-type": "application/json", origin: "app://conversation-assistant" }, body: JSON.stringify({ openai: "k" }),
    });
    expect(keys.status).toBe(200);
    expect(setupSeen).toEqual([{ openai: "k" }]);
  });

  test("streams server-sent events as they happen, and stops listening when the page closes the stream", async () => {
    bus.emit("cost", { total: 1 } as never);
    const r = await at("/api/events");
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const until = async (needle: string) => { while (!text.includes(needle)) text += dec.decode((await reader.read()).value, { stream: true }); };
    await until('"total":1'); // history on connect
    expect(subscribers()).toBe(1);
    bus.emit("cost", { total: 2 } as never);
    await until('"total":2'); // then live
    await reader.cancel();
    for (let i = 0; i < 50 && subscribers() > 0; i++) await new Promise((res) => setTimeout(res, 10));
    expect(subscribers()).toBe(0);
  });

  test("answers Range requests for playback", async () => {
    const pcm = Buffer.alloc(8);
    writeFileSync(join(audioDir, "host.wav"), Buffer.concat([wavHeader(pcm.length, 16000), pcm]));
    writeFileSync(join(audioDir, "remote.wav"), Buffer.concat([wavHeader(pcm.length, 16000), pcm]));
    const r = await at("/api/sessions/20260925-120000/audio", { headers: { range: "bytes=46-49" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 46-49/52");
    expect((await r.arrayBuffer()).byteLength).toBe(4);
  });
});

test("each request's stream pair closes when its response ends", async () => {
  const { createServer } = await import("node:http");
  let open = 0;
  const server = createServer((_req, res) => res.end("ok"));
  server.on("connection", (s) => { open++; s.once("close", () => open--); });
  const h = inProcessHandler(server);
  for (let i = 0; i < 5; i++) expect(await (await h(new Request("app://x/"))).text()).toBe("ok");
  for (let i = 0; i < 50 && open > 0; i++) await new Promise((res) => setTimeout(res, 10));
  expect(open).toBe(0);
});

describe("the in-process connection, edge by edge", () => {
  /** A handler over a plain server that answers with `respond`, recording each request it saw. */
  function over(respond: (req: IncomingMessage, res: ServerResponse) => void) {
    const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); respond(req, res); });
    });
    return { h: inProcessHandler(server), seen };
  }

  test("HEAD, 204, and 304 answers have no body; the headers still come through", async () => {
    const { h } = over((req, res) => {
      if (req.url === "/204") { res.writeHead(204, { "x-kind": "none" }); res.end(); return; }
      if (req.url === "/304") { res.writeHead(304); res.end(); return; }
      res.writeHead(200, { "content-type": "text/plain", "content-length": "5" });
      res.end(req.method === "HEAD" ? undefined : "hello");
    });
    const head = await h(new Request("app://x/", { method: "HEAD" }));
    expect([head.status, head.body, head.headers.get("content-length")]).toEqual([200, null, "5"]);
    const none = await h(new Request("app://x/204"));
    expect([none.status, none.body, none.headers.get("x-kind")]).toEqual([204, null, "none"]);
    expect((await h(new Request("app://x/304"))).body).toBeNull();
    expect(await (await h(new Request("app://x/"))).text()).toBe("hello");
  });

  test("a header with several values arrives joined with a comma", async () => {
    // node joins most repeated headers itself; set-cookie arrives as a list, which the handler joins
    const { h } = over((_req, res) => { res.setHeader("x-many", ["1", "2"]); res.setHeader("set-cookie", ["a=1", "b=2"]); res.end(); });
    const r = await h(new Request("app://x/"));
    expect(r.headers.get("x-many")).toBe("1, 2");
    expect(r.headers.get("set-cookie")).toBe("a=1, b=2");
  });

  test("the request reaches the router as the page itself: Host 127.0.0.1, no Origin, the query kept, one connection each", async () => {
    const { h, seen } = over((_req, res) => res.end());
    await h(new Request("app://conversation-assistant/api/calls?system=s2&limit=5", { headers: { origin: "https://evil.example", "x-file-name": "a%20b" } }));
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/calls?system=s2&limit=5", headers: { host: "127.0.0.1", connection: "close", "x-file-name": "a%20b" } });
    expect(seen[0].headers.origin).toBeUndefined();
  });

  test("an upload's bytes arrive intact", async () => {
    const { h, seen } = over((_req, res) => res.end("ok"));
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 128));
    const r = await h(new Request("app://x/api/sessions/import", { method: "POST", body: bytes }));
    expect(await r.text()).toBe("ok");
    expect(Buffer.from(seen[0].body, "latin1").length).toBe(300_000);
    expect(seen[0].body).toBe(bytes.toString());
  });

  test("a request body that fails, or a router that hangs up, rejects", async () => {
    const { h } = over((_req, res) => res.end("never"));
    const failing = new ReadableStream({ start(c) { c.error(new Error("the page's stream broke")); } });
    await expect(h(new Request("app://x/", { method: "POST", body: failing, duplex: "half" } as RequestInit))).rejects.toThrow();
    const hangUp = inProcessHandler(createServer((req) => req.socket.destroy()));
    await expect(hangUp(new Request("app://x/"))).rejects.toThrow();
  });
});
