import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
