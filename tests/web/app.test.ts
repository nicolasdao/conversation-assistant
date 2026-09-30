// @vitest-environment happy-dom
// The app (web/src/app.ts), a top-level program: loaded fresh per test into the page's markup, with a fake api, a fake
// EventSource the test drives, fake intervals, and a real location and history. What each panel draws is Phase 8's
// (panels.ts, timeline.ts…); these tests check the boot, the render scheduling, the URL, and the event stream.
import { afterEach, describe, expect, test, vi } from "vitest";
import { EVENT_TYPES } from "../../src/store/events.ts";
import { FakeAudio, FakeEventSource, flush } from "./helpers.ts";
import { all, button, freshPage, key, later, resetApi, text, toasts, type, type FakeApi } from "./helpers-core.ts";

const fake = vi.hoisted(() => ({}) as FakeApi);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<typeof import("../../web/src/api.ts")>()), api: fake }));

const T0 = "2026-09-30T10:00:00.000Z";
const utt = (id: string, startMs: number, endMs: number, text = `line ${id}`) => ({ id, stream: "host", startMs, endMs, speakerId: "a", text, tags: [] });
const snap = (session: object | null, o: object = {}) => ({
  session: session && { id: "S1", mode: "live", status: "running", startedAt: T0, name: "Episode 12", ...session },
  speakers: [{ id: "a", displayName: "Alice" }], utterances: [], segments: [], sections: [], claims: [], ...o,
});
const running = snap({});
const archived = snap({ status: "archived", mode: "replay" }, { utterances: [utt("u1", 0, 4000), utt("u2", 5000, 61_000)] });
const row = (kind: "jev_call" | "s2_call", at: string, o: object = {}) =>
  ({ kind, purpose: kind === "jev_call" ? "utterance" : "research", ok: true, latency_ms: 800, attempts: 1, cost_usd: 0.0001, at, id: at, model_returned: null, ...o });

let es: FakeEventSource;
let seq = 0;

/** Loads the app as main.ts would, with `state` answering GET /api/state (a function: each call). */
async function boot(o: { url?: string; state?: object | (() => unknown); api?: Record<string, (...a: any[]) => unknown>; desktop?: unknown; before?: () => void; now?: number } = {}) {
  const state = o.state ?? snap(null);
  await resetApi(fake, {
    state: async () => (typeof state === "function" ? (state as () => unknown)() : structuredClone(state)),
    calls: async () => ({ rows: [], models: { s1: null, s2: null } }),
    engine: async () => ({ startedAt: T0, stale: false }),
    devices: async () => [],
    about: async () => ({ name: "Tattle", version: "1.0.1", license: { id: null, holder: null, text: "" } }),
    labelSets: async () => ({ sets: [] }),
    setup: async () => ({ configured: true, required: [], path: "~/x", keys: [{ name: "openrouter", env: "OPENROUTER_API_KEY", set: true, source: "file", hint: "abcd" }] }),
    transcription: async () => ({ engine: "apple", saved: null, openai: { keySet: false }, apple: { available: true, reason: null, model: "installed", fraction: null, error: null } }),
    sessions: async () => [],
    chats: async () => ({ sessionId: "S1", spentUsd: 0, chats: [] }),
    chatModels: async () => ({ default: "openai/gpt-6-luna", models: [] }),
    closeView: async () => ({ closed: "S1" }),
    openSession: async () => ({ sessionId: "S1", events: 0 }),
    ...o.api,
  });
  freshPage({ url: o.url, desktop: o.desktop });
  // the app's intervals are fake (they would outlive the test); so is the clock when the test sets it
  vi.useFakeTimers({ toFake: o.now === undefined ? ["setInterval", "clearInterval"] : ["setInterval", "clearInterval", "Date"] });
  if (o.now !== undefined) vi.setSystemTime(o.now);
  o.before?.();
  seq = 0;
  await import("../../web/src/app.ts");
  es = FakeEventSource.instances.at(-1)!;
  await settle();
}
const frame = () => new Promise((r) => requestAnimationFrame(r));
/** Lets pending requests finish and the next frame render. */
async function settle() { await flush(); await frame(); await flush(); await frame(); }
/** The engine sends an event, as the SSE writer frames it. */
async function send(type: string, data: object, at = T0) {
  es.emit(type, { seq: ++seq, type, at, data });
  await settle();
}
const url = () => `${location.pathname}${location.search}`;
const dialog = (id: string) => document.getElementById(id) as HTMLDialogElement;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("boot", () => {
  test("with nothing on screen: GET /api/state, no calls, 'No session', and the event stream opened", async () => {
    await boot();
    expect(fake.state).toHaveBeenCalledTimes(1);
    expect(fake.calls).not.toHaveBeenCalled();
    expect(text("#session-name")).toBe("No session");
    expect([FakeEventSource.instances.length, es.url]).toEqual([1, "/api/events"]);
    expect(fake.engine).toHaveBeenCalledTimes(1);
    expect(fake.devices).toHaveBeenCalledTimes(1);
  });

  test("with a session: its calls, sorted by time, and the models from the System 1 answer", async () => {
    await boot({
      state: running,
      api: {
        calls: async (system: string) => system === "s1"
          ? { rows: [row("jev_call", "2026-09-30T10:00:02.000Z"), row("jev_call", "2026-09-30T10:00:01.000Z")], models: { s1: "typesafe/jev-1.13", s2: "openai/gpt-6-luna" } }
          : { rows: [row("s2_call", "2026-09-30T10:00:03.000Z")], models: { s1: "x", s2: "y" } },
      },
      url: "/?tab=jev-log",
    });
    expect(fake.calls.mock.calls).toEqual([["s1", 3000], ["s2", 200]]);
    expect(text("#jev-count")).toBe("2");
    expect(all("#jev-log .call .t").map((t) => t.textContent)).toEqual(["0:02", "0:01"]);
    document.querySelector<HTMLButtonElement>('.tabs .tab[data-pane="pane-think"]')!.click();
    await settle();
    expect(all("#think .sys-model").map((m) => m.textContent)).toEqual(["typesafe/jev-1.13", "openai/gpt-6-luna"]);
  });

  test("a failed GET /api/state shows no session; failed calls are ignored", async () => {
    await boot({ state: () => { throw new Error("503"); } });
    expect(text("#session-name")).toBe("No session");
    await boot({ state: running, api: { calls: async () => { throw new Error("404"); } } });
    expect([text("#session-name"), text("#jev-count")]).toEqual(["Episode 12", ""]);
  });

  test("the engine's staleness is checked at boot and every 15 s", async () => {
    await boot();
    expect(fake.engine).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);
    expect(fake.engine).toHaveBeenCalledTimes(3);
  });

  test("the event names it listens to are the engine's, one for one", async () => {
    const names: string[] = [];
    const add = EventTarget.prototype.addEventListener;
    await boot({
      before: () => {
        vi.spyOn(FakeEventSource.prototype, "addEventListener").mockImplementation(function (this: EventTarget, t: string, ...r: any[]) { names.push(t); return add.call(this, t, ...(r as [any])); });
      },
    });
    expect([...names].sort()).toEqual([...EVENT_TYPES].sort());
  });
});

describe("the event stream", () => {
  test("an event is applied and drawn in the next frame", async () => {
    await boot({ state: running });
    await send("utterance", utt("u9", 1000, 2000, "Hello there"));
    expect(text("#transcript")).toContain("Hello there");
  });

  test("a new session's start reloads the state; events arriving meanwhile wait for it", async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await boot({
      state: async () => {
        n++;
        if (n === 2) await gate;
        return n === 1 ? snap(null) : snap({ id: "S2", name: "New show" });
      },
    });
    es.emit("session.started", { seq: 1, type: "session.started", at: T0, data: { sessionId: "S2", startedAt: T0 } });
    es.emit("utterance", { seq: 2, type: "utterance", at: T0, data: utt("u1", 0, 1000, "After the reset") });
    await settle();
    expect(fake.state).toHaveBeenCalledTimes(2);
    expect(text("#transcript")).not.toContain("After the reset");
    release();
    await settle();
    expect([text("#session-name"), text("#transcript")]).toEqual(["New show", expect.stringContaining("After the reset")]);
  });

  test("a session's start sets the clock's origin, so the clock runs from it", async () => {
    await boot({ state: snap({ startedAt: undefined }), now: Date.parse(T0) + 65_000 });
    await send("session.started", { sessionId: "S1", startedAt: T0 });
    await send("health", { stream: "host", rmsDbfs: -20, msSinceLastFrame: 10, utterancesLastMinute: 1 });
    expect(text("#clock")).toBe("01:05");
    vi.setSystemTime(Date.parse(T0) + 3_724_000);
    vi.advanceTimersByTime(1000); // the 1 s tick redraws health and the clock
    await settle();
    expect(text("#clock")).toBe("1:02:05");
  });

  test("a recording's clock is its last line's end", async () => {
    await boot({ state: archived });
    expect(text("#clock")).toBe("01:01");
  });

  test("a new System 1 version fetches the versions again", async () => {
    await boot({ state: running });
    fake.state!.mockResolvedValue({ ...running, s1: { active: "s1@2", versions: [{ id: "s1@1" }, { id: "s1@2" }] } });
    await send("s1.version", { active: "s1@2", outcome: "promoted" });
    expect(fake.state).toHaveBeenCalledTimes(2);
    fake.state!.mockResolvedValue(null);
    await send("s1.version", { active: "s1@3", outcome: "promoted" });
    expect(fake.state).toHaveBeenCalledTimes(3);
  });

  test("the engine setting's changes reach the settings menu", async () => {
    await boot();
    await send("transcription.status", { engine: "openai", saved: "openai", openai: { keySet: true }, apple: { available: true, model: "installed" } });
    expect(text("#m-transcription")).toBe("OpenAI");
  });

  test("a dropped connection marks #conn down, and reconnecting clears it", async () => {
    await boot();
    // es.fail() would also dispatch the "error" Event to the listener for the engine's `error` events: W7-L2 below
    es.onerror!(new Event("error"));
    expect(document.getElementById("conn")!.classList.contains("down")).toBe(true);
    es.open();
    expect(document.getElementById("conn")!.classList.contains("down")).toBe(false);
    es.emit("message", "{}"); // unnamed messages are ignored
  });

  test("a call in flight with no answer stops showing as thinking after 30 s (System 1) or 120 s (System 2)", async () => {
    await boot({ state: running, url: "/?tab=thinking", now: Date.parse(T0) });
    await send("call.started", { system: "s1" });
    await send("call.started", { system: "s2" });
    const busy = () => all("#think .sys").map((s) => s.classList.contains("busy"));
    expect(busy()).toEqual([true, true]);
    vi.setSystemTime(Date.parse(T0) + 29_001);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(busy()).toEqual([false, true]);
    vi.setSystemTime(Date.parse(T0) + 119_001);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(busy()).toEqual([false, false]);
  });

  test("a window resize redraws the timeline", async () => {
    await boot({ state: running });
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(document.getElementById("timeline")).not.toBeNull();
  });

  // app.ts: `JSON.parse(ev.data)` has no guard, so a malformed event is an unhandled rejection in the page (inventory
  // 4 §14.17); it cannot be written as it.fails, since the rejection fails the test run.

  // The engine's `error` events share their name with the EventSource's own error for a dropped connection (W7-L2,
  // E2E-L1): a dropped connection is not an engine error, and an engine error is not a dropped connection.
  test("a dropped connection is not read as an engine error", async () => {
    await boot();
    es.dispatchEvent(new Event("error")); // what the browser dispatches when the connection drops
    es.onerror!(new Event("error"));
    await settle();
    expect(document.getElementById("conn")!.classList.contains("down")).toBe(true);
    expect(document.getElementById("log-count")!.textContent).toBe("");
  });

  test("an engine error is not read as a dropped connection", async () => {
    await boot();
    const ev = new MessageEvent("error", { data: JSON.stringify({ type: "error", at: T0, data: { component: "jev", message: "timeout" } }) });
    es.dispatchEvent(ev);
    es.onerror!(ev); // a browser runs the onerror handler for every event named "error"
    await settle();
    expect(document.getElementById("conn")!.classList.contains("down")).toBe(false);
    expect(document.getElementById("log-count")!.textContent).toBe("1");
  });
});

describe("the right column's tabs", () => {
  test("a click shows its pane, hides the tally off Fact-check, puts it in the URL, and remembers it", async () => {
    await boot();
    document.querySelector<HTMLButtonElement>('.tabs .tab[data-pane="pane-jev"]')!.click();
    await settle();
    expect(["pane-fc", "pane-think", "pane-jev"].map((id) => document.getElementById(id)!.hidden)).toEqual([true, true, false]);
    expect([document.getElementById("tally")!.hidden, url(), localStorage.getItem("pa.rightTab")]).toEqual([true, "/?tab=jev-log", "pane-jev"]);
    expect(all(".tabs .tab[data-pane]").map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    document.querySelector<HTMLButtonElement>('.tabs .tab[data-pane="pane-fc"]')!.click();
    expect([document.getElementById("tally")!.hidden, url()]).toEqual([false, "/"]);
  });

  test("the URL's tab wins over the remembered one; without one, the remembered one shows", async () => {
    await boot({ url: "/?tab=thinking", before: () => localStorage.setItem("pa.rightTab", "pane-jev") });
    expect(document.getElementById("pane-think")!.hidden).toBe(false);
    await boot({ before: () => localStorage.setItem("pa.rightTab", "pane-jev") });
    expect([document.getElementById("pane-jev")!.hidden, url()]).toEqual([false, "/?tab=jev-log"]);
  });

  test("storage that throws is survived", async () => {
    await boot({
      before: () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
      },
    });
    document.querySelector<HTMLButtonElement>('.tabs .tab[data-pane="pane-jev"]')!.click();
    expect(document.getElementById("pane-jev")!.hidden).toBe(false);
  });
});

describe("the URL", () => {
  test("/recordings/<id> with nothing on air opens the recording, then loads it", async () => {
    let opened = false;
    await boot({ url: "/recordings/S1", state: () => (opened ? structuredClone(archived) : snap(null)), api: { openSession: async () => { opened = true; return {}; } } });
    expect(fake.openSession).toHaveBeenCalledWith("S1");
    expect([fake.state.mock.calls.length, text("#session-name"), url()]).toEqual([2, "Episode 12", "/recordings/S1"]);
    expect(document.getElementById("player")!.hidden).toBe(false);
  });

  test("a recording that cannot be opened is a toast, and the URL goes back to /", async () => {
    await boot({ url: "/recordings/nope?t=1:00", api: { openSession: async () => { throw new Error("unknown session"); } } });
    expect([toasts(), url()]).toEqual([["Recording nope could not be opened: unknown session"], "/"]);
    await boot({ url: "/recordings/nope", api: { openSession: async () => { throw "odd"; } } });
    expect(toasts()).toEqual(["Recording nope could not be opened: odd"]);
  });

  test("a recording's URL while a session is on air shows the session instead, and says so", async () => {
    await boot({ url: "/recordings/OLD", state: running });
    expect(fake.openSession).not.toHaveBeenCalled();
    expect([toasts(), url()]).toEqual([["A session is on air, so it is shown instead of the recording."], "/"]);
  });

  test("/ while the engine shows a recording puts the recording in the URL, replacing the entry", async () => {
    const push = vi.spyOn(history, "pushState");
    await boot({ state: archived });
    expect([url(), fake.closeView.mock.calls.length, push.mock.calls.length]).toEqual(["/recordings/S1", 0, 0]);
  });

  test("the recording already on screen is not opened again", async () => {
    await boot({ url: "/recordings/S1", state: archived });
    expect(fake.openSession).not.toHaveBeenCalled();
  });

  test("Back to / from a recording closes it; Back with no tab shows Fact-check", async () => {
    await boot({ url: "/recordings/S1?tab=jev-log", state: archived });
    fake.state!.mockResolvedValue(snap(null));
    history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();
    expect([fake.closeView.mock.calls.length, text("#session-name"), document.getElementById("pane-fc")!.hidden]).toEqual([1, "No session", false]);
  });

  test("Back and Forward with a tab show it", async () => {
    await boot();
    history.pushState(null, "", "/?tab=thinking");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();
    expect(document.getElementById("pane-think")!.hidden).toBe(false);
  });

  test("Speakers named with nothing on screen opens nothing and leaves the URL", async () => {
    await boot({ url: "/?panel=speakers" });
    expect([dialog("dlg-speakers").open, url()]).toEqual([false, "/"]);
  });

  test("a window named in the URL opens, rendered first; another one open is closed", async () => {
    await boot({ url: "/?panel=recordings" });
    expect(dialog("dlg-recordings").open).toBe(true);
    expect(fake.sessions).toHaveBeenCalled();
    history.pushState(null, "", "/?panel=keys");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();
    expect([dialog("dlg-recordings").open, dialog("dlg-keys").open, fake.setup.mock.calls.length >= 2]).toEqual([false, true, true]);
  });

  test.each([
    ["labels", "dlg-labels"], ["transcription", "dlg-transcription"], ["chat", "dlg-chat"],
  ])("?panel=%s opens its window", async (name, id) => {
    await boot({ url: `/?panel=${name}` });
    expect(dialog(id).open).toBe(true);
  });

  test("Insights opens on the tab the URL names, and Back and Forward move between its tabs", async () => {
    await boot({ url: "/?panel=insights&section=log" });
    const selected = () => all("#dlg-insights .tab").find((t) => t.getAttribute("aria-selected") === "true")?.dataset.section;
    expect([dialog("dlg-insights").open, selected()]).toEqual([true, "log"]);
    history.pushState(null, "", "/?panel=insights");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();
    expect(selected()).toBe("overview");
  });

  test("?t= on a recording seeks the player there", async () => {
    await boot({ url: "/recordings/S1?t=1:23", state: archived });
    const audio = FakeAudio.instances.at(-1)!;
    expect(audio.src).toBe("/api/sessions/S1/audio");
    audio.loadMetadata(120);
    expect(audio.currentTime).toBe(83);
  });

  test("a live session ending becomes a recording in the URL (a history entry)", async () => {
    await boot({ state: running });
    const push = vi.spyOn(history, "pushState");
    await send("session.ended", { sessionId: "S1", reason: "stopped" });
    expect([url(), push.mock.calls.length]).toEqual(["/recordings/S1", 1]);
  });

  test("closing a window takes it out of the URL; closing another leaves the URL", async () => {
    await boot({ url: "/?panel=recordings" });
    dialog("dlg-keys").showModal();
    dialog("dlg-keys").close();
    expect(url()).toBe("/?panel=recordings");
    dialog("dlg-recordings").close();
    expect(url()).toBe("/");
  });

  test("playing a recording keeps its position in the URL; on air it does not", async () => {
    await boot({ url: "/recordings/S1", state: archived });
    const audio = FakeAudio.instances.at(-1)!;
    audio.loadMetadata(120);
    audio.currentTime = 42;
    audio.pause();
    await settle();
    expect(url()).toBe("/recordings/S1?t=0:42");
  });
});

describe("windows opened from outside the page", () => {
  const bridge = () => { let cb: ((c: string) => void) | null = null; return { onCommand: (f: (c: string) => void) => { cb = f; }, run: vi.fn(), send: (c: string) => cb!(c) }; };

  test("the Mac app's menu opens a window by name, closing the others; an unknown name, or a window already open, does nothing", async () => {
    const b = bridge();
    await boot({ desktop: b });
    dialog("dlg-recordings").showModal();
    b.send("keys");
    await settle();
    expect([dialog("dlg-keys").open, dialog("dlg-recordings").open, url()]).toEqual([true, false, "/?panel=keys"]);
    const calls = fake.setup.mock.calls.length;
    b.send("keys");
    b.send("nope");
    await settle();
    expect(fake.setup.mock.calls.length).toBe(calls);
  });

  test("the header's Chat button opens the chat", async () => {
    await boot({ state: running });
    document.getElementById("chat-btn")!.click();
    await settle();
    expect([dialog("dlg-chat").open, url()]).toEqual([true, "/?panel=chat"]);
  });
});

describe("a time cited in a chat reply", () => {
  const withReply = async (state: object) => {
    await boot({
      url: `${(state as typeof archived).session!.status === "archived" ? "/recordings/S1" : "/"}?panel=chat&chat=chat_1`,
      state,
      api: {
        chats: async () => ({ sessionId: "S1", spentUsd: 0, chats: [{ id: "chat_1", title: "t", model: "m", updatedAt: "", busy: false, messages: 2, costUsd: 0 }] }),
        chat: async () => ({ id: "chat_1", title: "t", model: "m", createdAt: "", updatedAt: "", busy: false, meter: null,
          messages: [{ id: "m1", role: "user", content: "when?", at: "" }, { id: "m2", role: "assistant", content: "At [0:05] and [9:00].", at: "" }] }),
      },
    });
  };

  test("on air it closes the chat and flashes the last line starting at or before that moment", async () => {
    await withReply(snap({}, { utterances: [utt("u1", 0, 3000), utt("u2", 4500, 7000), utt("u3", 7000, 9000)] }));
    expect(dialog("dlg-chat").open).toBe(true);
    all("#chat-log .md-time")[0]!.click();
    expect(dialog("dlg-chat").open).toBe(false);
    expect(document.getElementById("utt-u2")!.classList.contains("flash")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  test("before the first line it flashes the first; with no lines it does nothing", async () => {
    await withReply(snap({}, { utterances: [utt("u1", 600_000, 601_000)] }));
    all("#chat-log .md-time")[0]!.click();
    expect(document.getElementById("utt-u1")!.classList.contains("flash")).toBe(true);
    await withReply(snap({}));
    all("#chat-log .md-time")[0]!.click();
    expect(dialog("dlg-chat").open).toBe(false);
  });

  test("on a recording it plays from there, with the chat left open", async () => {
    await withReply(archived);
    const audio = FakeAudio.instances.at(-1)!;
    audio.loadMetadata(600);
    all("#chat-log .md-time")[1]!.click();
    expect([audio.currentTime, dialog("dlg-chat").open]).toEqual([540, true]);
  });
});

describe("what the app hands the panels", () => {
  test("the API keys window says a saved key is used by the next call", async () => {
    await boot({ url: "/?panel=keys", api: { saveKeys: async () => ({ saved: true, checks: { openrouter: { ok: true, message: "Key works" } }, keys: [], configured: true, required: [], path: "" }) } });
    type(document.querySelector<HTMLInputElement>("#keys input")!, "sk-or-v1-abcdefghijklmnopqrstuvwx");
    button("Save", document.getElementById("keys")!)!.click();
    await settle();
    expect(toasts()).toEqual(["API key saved: the next call uses it"]);
  });

  test("the Transcription window says which engine was chosen", async () => {
    await boot({
      url: "/?panel=transcription",
      api: {
        transcription: async () => ({ engine: "openai", saved: "openai", openai: { keySet: true }, apple: { available: true, reason: null, model: "installed", fraction: null, error: null } }),
        setTranscription: async () => ({ engine: "apple", saved: "apple", openai: { keySet: true }, apple: { available: true, reason: null, model: "installed", fraction: null, error: null } }),
      },
    });
    all("#transcription .engine-choice")[0]!.click();
    await settle();
    expect(toasts()).toEqual(["Transcription: on this Mac"]);
  });

  test("Start live's link to Settings → Transcription opens that window", async () => {
    await boot({
      api: { transcription: async () => ({ engine: "apple", saved: "apple", openai: { keySet: false }, apple: { available: true, reason: null, model: "error", fraction: null, error: "no space" } }) },
    });
    document.getElementById("start-live")!.click();
    await settle();
    button("Settings → Transcription")!.click();
    await settle();
    expect([dialog("dlg-start").open, dialog("dlg-transcription").open, url()]).toEqual([false, true, "/?panel=transcription"]);
  });

  test("a transcript filter redraws the transcript", async () => {
    await boot({ state: snap({}, { speakers: [{ id: "a", displayName: "Alice" }, { id: "b", displayName: "Bob" }], utterances: [utt("u1", 0, 1000, "from Alice"), { ...utt("u2", 2000, 3000, "from Bob"), speakerId: "b" }] }) });
    const sel = document.querySelector<HTMLSelectElement>('#filters select[aria-label="Speaker filter"]')!;
    sel.value = "b";
    sel.dispatchEvent(new Event("change"));
    await settle();
    expect([text("#transcript").includes("from Bob"), text("#transcript").includes("from Alice")]).toEqual([true, false]);
    sel.value = "";
    sel.dispatchEvent(new Event("change"));
    await settle();
  });

  test("renaming the session in the header redraws it", async () => {
    await boot({ state: running, api: { renameSession: async () => ({ name: "Episode 13" }) } });
    document.getElementById("session-name")!.click();
    const input = document.querySelector<HTMLInputElement>(".name-input")!;
    input.value = "Episode 13";
    key(input, "Enter");
    await settle();
    expect([text("#session-name"), toasts()]).toEqual(["Episode 13", ["Session renamed to Episode 13"]]);
  });

  test("deleting the recording on screen, with none below it, loads the empty state", async () => {
    await boot({
      url: "/recordings/S1?panel=recordings", state: archived,
      api: { sessions: async () => [{ id: "S1", name: "Episode 12", notes: null, mode: "replay", startedAt: T0, durationMs: 61_000, ended: true, utterances: 2, speakers: ["Alice"], segments: 0, claims: 0, costUsd: 0 }], deleteSession: async () => ({ deleted: "S1" }) },
    });
    fake.state!.mockResolvedValue(snap(null));
    document.querySelector<HTMLButtonElement>("#dlg-recordings .rec-delete")!.click();
    (document.getElementById("dlg-ask") as HTMLDialogElement).close("ok");
    await settle();
    expect([fake.deleteSession.mock.calls[0], text("#session-name")]).toEqual([["S1"], "No session"]);
  });

  test("Export in the header exports the recording on screen; a dropped label set goes to the label library", async () => {
    await boot({ state: archived, api: { exportInfo: async () => { throw new Error("x"); }, importLabelSet: async () => ({ name: "Mine" }) } });
    document.getElementById("export-btn")!.click();
    await settle();
    expect(fake.exportInfo).toHaveBeenCalledWith("S1");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new File(['{"format":"tattle-labels"}'], "Mine.tattle-labels")] } });
    document.dispatchEvent(drop);
    await settle();
    expect(fake.importLabelSet).toHaveBeenCalledWith({ format: "tattle-labels" });
  });

  test("zooming the timeline redraws it", async () => {
    await boot({ state: archived });
    document.getElementById("zoom-in")!.click();
    await settle();
    expect(document.getElementById("timeline")).not.toBeNull();
  });

  test("Insights opened from the Mac app's menu shows Overview", async () => {
    let cb!: (c: string) => void;
    await boot({ desktop: { onCommand: (f: (c: string) => void) => { cb = f; }, run: vi.fn() } });
    cb("insights");
    expect([dialog("dlg-insights").open, all("#dlg-insights .tab[aria-selected=true]").map((t) => t.dataset.section)]).toEqual([true, ["overview"]]);
  });
});

describe("edges", () => {
  test("calls answered after another session took over are dropped", async () => {
    const slow = later<{ rows: unknown[]; models: object }>();
    let n = 0;
    await boot({
      state: () => (++n === 1 ? structuredClone(running) : snap({ id: "S2" })),
      api: { calls: () => (n === 1 ? slow.promise : Promise.resolve({ rows: [], models: { s1: null, s2: null } })) },
      url: "/?tab=jev-log",
    });
    await send("session.started", { sessionId: "S2" });
    slow.resolve({ rows: [row("jev_call", T0)], models: { s1: "x", s2: "y" } });
    await settle();
    expect(text("#jev-count")).toBe("");
  });

  test("a frame drawn while the URL is still being applied leaves the URL alone", async () => {
    const opening = later<object>();
    let opened = false;
    const done = boot({ url: "/recordings/S1", state: () => (opened ? structuredClone(archived) : snap(null)), api: { openSession: () => opening.promise.then(() => { opened = true; }) } });
    await new Promise((r) => setTimeout(r, 50));
    expect(url()).toBe("/recordings/S1");
    opening.resolve({});
    await done;
    expect(url()).toBe("/recordings/S1");
  });

  test("a page without the timeline, a tab's pane, or a window still works", async () => {
    await boot({
      url: "/?tab=jev-log&panel=labels",
      before: () => {
        document.getElementById("timeline")!.remove();
        document.getElementById("pane-think")!.remove();
        document.getElementById("dlg-labels")!.remove();
        document.querySelector('.tabs .tab[data-pane="pane-jev"]')!.remove();
      },
    });
    document.querySelector<HTMLButtonElement>('.tabs .tab[data-pane="pane-think"]')!.click();
    await settle();
    expect(url()).toBe("/?tab=thinking&panel=labels"); // a window missing from the page is skipped, not closed
  });
});
