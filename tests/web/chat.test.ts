// @vitest-environment happy-dom
// The chat window (web/src/chat.ts): questions about the transcript of the session on screen. The engine is the fake
// api; a reply's stream is driven by the test. See docs/chat.md § The page.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Chat, ChatList, ChatMessage, ChatMeter, ChatModel, ChatStreamEvent, SetupStatus } from "../../web/src/api.ts";
import { emptyState, type State } from "../../web/src/state.ts";
import { flush } from "./helpers.ts";
import { all, button, freshPage, key, later, resetApi, text, toasts, type, type FakeApi } from "./helpers-core.ts";

const fake = vi.hoisted(() => ({}) as FakeApi);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<typeof import("../../web/src/api.ts")>()), api: fake }));

type ChatMod = typeof import("../../web/src/chat.ts");
let chat: ChatMod;
let keys: typeof import("../../web/src/keys.ts");
let onTime: ReturnType<typeof vi.fn<(ms: number) => void>>;

const LUNA = "openai/gpt-6-luna", SONNET = "anthropic/claude-sonnet-5";
const model = (id: string, name: string, o: Partial<ChatModel> = {}): ChatModel =>
  ({ id, name, contextLength: 200_000, maxOutput: 8000, inputUsdPerM: 3, outputUsdPerM: 15, cacheReadUsdPerM: 0.3, available: true, ...o });
const MODELS: ChatModel[] = [
  model(LUNA, "OpenAI: GPT-6 Luna", { contextLength: 1_050_000, inputUsdPerM: 1.25, outputUsdPerM: 10 }),
  model(SONNET, "Anthropic: Claude Sonnet 5"),
  model("x/mystery", "Mystery", { contextLength: null, inputUsdPerM: null, outputUsdPerM: null }),
  model("old/gone", "Old: Gone", { contextLength: 8000, inputUsdPerM: 0.05, outputUsdPerM: 0.1, available: false }),
];
const meter = (o: Partial<ChatMeter> = {}): ChatMeter => ({
  model: LUNA, contextLength: 1_050_000, contextTokens: 31_000, leftTokens: 1_019_000, inputTokens: 12_000, cachedTokens: 3000, outputTokens: 900,
  reasoningTokens: 200, costUsd: 0.0123, estimated: false, pendingLines: 0, pendingTokens: 0, ...o,
});
const msg = (role: "user" | "assistant", content: string, o: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m_${Math.random()}`, role, content, at: "2026-09-30T10:00:00.000Z", ...(role === "assistant" ? { model: LUNA } : {}), ...o });
const aChat = (o: Partial<Chat> = {}): Chat => ({
  id: "chat_1", title: "New chat", model: LUNA, createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z", busy: false, messages: [], meter: meter(), ...o,
});
const listOf = (chats: Partial<ChatList["chats"][number]>[] = [], o: Partial<ChatList> = {}): ChatList => ({
  sessionId: "S1", spentUsd: 0.5,
  chats: chats.map((c, i) => ({ id: `chat_${i + 1}`, title: `Chat ${i + 1}`, model: LUNA, updatedAt: "", busy: false, messages: 2, costUsd: 0.0012, ...c })),
  ...o,
});
const setup = (openrouter: boolean): SetupStatus => ({
  configured: true, required: [], path: "~/x",
  keys: [{ name: "openai", env: "OPENAI_API_KEY", set: false, source: null, hint: null }, { name: "openrouter", env: "OPENROUTER_API_KEY", set: openrouter, source: openrouter ? "file" : null, hint: openrouter ? "abcd" : null }],
});
const session = (o: Partial<NonNullable<State["session"]>> = {}): State => {
  const s = emptyState();
  s.session = { id: "S1", mode: "live", status: "running", name: "Episode 12", ...o };
  return s;
};

/** A reply's stream, driven by the test: `emit` sends an event, `end` finishes the POST, `fail` rejects it. */
function streams() {
  const calls: { id: string; body: unknown; emit: (e: ChatStreamEvent) => void; end: () => void; fail: (e: unknown) => void }[] = [];
  fake.sendChat!.mockImplementation((id: string, body: unknown, on: (e: ChatStreamEvent) => void) => {
    const d = later<void>();
    calls.push({ id, body, emit: on, end: () => d.resolve(), fail: (e) => d.reject(e) });
    return d.promise;
  });
  return calls;
}

/** A fresh page with chat bound; `st` rendered unless null; `key` whether OpenRouter's key is set. */
async function boot(o: { st?: State | null; key?: boolean; list?: ChatList; url?: string } = {}) {
  await resetApi(fake, {
    setup: async () => setup(o.key ?? true),
    chatModels: async () => ({ default: LUNA, models: MODELS }),
    chats: async () => o.list ?? listOf(),
    chat: async (id: string) => aChat({ id }),
    createChat: async (m: string) => aChat({ model: m }),
  });
  freshPage({ url: o.url });
  chat = await import("../../web/src/chat.ts");
  keys = await import("../../web/src/keys.ts");
  await keys.setupStatus();
  onTime = vi.fn<(ms: number) => void>();
  chat.bindChat({ onTime });
  if (o.st !== null) chat.renderChat(o.st ?? session());
  await flush();
}
const dlg = () => document.getElementById("dlg-chat") as HTMLDialogElement;
const input = () => document.getElementById("chat-input") as HTMLTextAreaElement;
const send = () => document.getElementById("chat-send") as HTMLButtonElement;
const url = () => `${location.pathname}${location.search}`;
const frame = () => new Promise((r) => requestAnimationFrame(r));
/** Opens the chat and waits for its first frame. */
const open = async () => { chat.openChat(); await flush(); await frame(); };
/** Selects a chat from the sidebar. */
const pick = async (i = 0) => { all("#chat-list .chat-open")[i]!.click(); await flush(); };

afterEach(() => vi.useRealTimers());

describe("tokens", () => {
  test("below a thousand as is; then k with one decimal below 10k; then M with up to two decimals", async () => {
    await boot({ st: null });
    expect([0, 950, 999.4, 1000, 1250, 9_940, 12_400, 999_499].map(chat.tokens)).toEqual(["0", "950", "999", "1k", "1.3k", "9.9k", "12k", "999k"]);
    expect([1_000_000, 1_050_000, 2_000_000, 10_000_000, 1_234_567].map(chat.tokens)).toEqual(["1M", "1.05M", "2M", "10M", "1.23M"]);
  });

  test.fails("BUG §14.10: a count just under a million reads 1M, not 1000k", async () => {
    await boot({ st: null });
    expect(chat.tokens(999_600)).toBe("1M");
  });
});

describe("the window, with and without a session", () => {
  test("bindChat builds the sidebar, the model picker, the log, the meter and the composer, and asks nothing yet", async () => {
    await boot({ st: null });
    for (const id of ["chat-list", "chat-spend", "model-btn", "model-menu", "chat-about", "chat-log", "chat-meter", "chat-input", "chat-send"]) expect(document.getElementById(id), id).not.toBeNull();
    expect(button("+ New chat")).toBeDefined();
    expect(fake.chatModels).not.toHaveBeenCalled(); // asked only when the chat opens (docs/chat.md, 1.0.1)
    expect(fake.chats).not.toHaveBeenCalled();
  });

  test("with no session: the log says to start one, and everything is disabled", async () => {
    await boot({ st: null });
    chat.renderChat(emptyState());
    expect(text("#chat-log")).toBe("Start a session or open a recording to chat about its transcript.");
    expect([input().disabled, send().disabled, document.getElementById("model-btn")!.hasAttribute("disabled")]).toEqual([true, true, true]);
    expect(input().placeholder).toBe("Start a session or open a recording to chat about it");
    expect([text("#chat-sub"), text("#chat-about"), text("#chat-meter"), text("#chat-list")]).toEqual(["Ask about the transcript", "", "", ""]);
  });

  test.each([
    [{ status: "running" }, "About Episode 12 · on air"],
    [{ status: "archived" }, "About Episode 12 · recording"],
    [{ status: "archived", name: null }, "About S1 · recording"],
    [{ status: "ending", name: "" }, "About S1"],
  ])("a session %j is named in the header: %s", async (o, label) => {
    await boot({ st: session(o) });
    expect(text("#chat-sub")).toBe(label);
    expect([input().disabled, input().placeholder, text("#chat-about")]).toEqual([false, "Ask about the transcript…", "New chat"]);
  });

  test("the header goes back to its default when the session leaves", async () => {
    await boot();
    chat.renderChat(emptyState());
    expect(text("#chat-sub")).toBe("Ask about the transcript");
  });

  test("a new session on screen loads its chats and opens the URL's chat when it is one of them", async () => {
    await boot({ url: "/?panel=chat&chat=chat_2", list: listOf([{}, { title: "Second" }]) });
    expect(fake.chats).toHaveBeenCalledTimes(1);
    expect(fake.chat).toHaveBeenCalledWith("chat_2");
    expect(all("#chat-list .chat-open").map((b) => b.getAttribute("aria-current"))).toEqual([null, "true"]);
    expect(url()).toBe("/?panel=chat&chat=chat_2");
  });

  test("a URL chat that is not in the list is not opened", async () => {
    await boot({ url: "/?panel=chat&chat=chat_9", list: listOf([{}]) });
    expect(fake.chat).not.toHaveBeenCalled();
  });

  test("a list for another session is ignored; a list that fails leaves the sidebar empty", async () => {
    await boot({ list: listOf([{}], { sessionId: "OTHER" }), url: "/?panel=chat&chat=chat_1" });
    expect(fake.chat).not.toHaveBeenCalled();
    fake.chats!.mockRejectedValue(new Error("409"));
    chat.renderChat(session({ id: "S2" }));
    await flush();
    expect([text("#chat-list"), text("#chat-spend")]).toEqual(["No chats yet. Your first question starts one.", ""]);
  });

  // chat.ts assigns the list before checking its session, then returns without drawing: the other recording's chats
  // stay in `list` and show at the next draw (inventory 4 §14.6).
  test.fails("BUG §14.6: another session's list never shows in the sidebar", async () => {
    await boot({ list: listOf([{ title: "Not mine" }], { sessionId: "OTHER" }) });
    chat.renderChat(session()); // any redraw
    button("+ New chat")!.click();
    await flush();
    expect(text("#chat-list")).not.toContain("Not mine");
  });

  test("an empty chat shows four starters; one sends its question", async () => {
    await boot();
    const calls = streams();
    const starters = all("#chat-log .starters .starter");
    expect(starters.map((s) => s.textContent)).toEqual([
      "Summarise the conversation so far.", "What were the main disagreements, and who took which side?",
      "List every claim about AI companies or models, with its time.", "What happened in the last five minutes?",
    ]);
    starters[0]!.click();
    await flush();
    expect(calls[0]!.body).toEqual({ content: "Summarise the conversation so far.", mode: "send" });
  });
});

describe("opening", () => {
  test("openChat closes other windows, opens the chat, puts it in the URL, asks for the models, and focuses the box", async () => {
    await boot();
    const other = document.getElementById("dlg-recordings") as HTMLDialogElement;
    other.showModal();
    await open();
    expect([other.open, dlg().open, url(), document.activeElement]).toEqual([false, true, "/?panel=chat", input()]);
    expect(fake.chatModels).toHaveBeenCalledTimes(1);
    expect(text("#model-btn b")).toBe("GPT-6 Luna");
    await open(); // already open: the models are not asked again
    expect(fake.chatModels).toHaveBeenCalledTimes(1);
  });

  test("the models are asked again next time if they failed", async () => {
    await boot();
    fake.chatModels!.mockRejectedValueOnce(new Error("offline"));
    await open();
    chat.chatOpened();
    await flush();
    expect(fake.chatModels).toHaveBeenCalledTimes(2);
  });

  test("with a chat on screen the URL names it", async () => {
    await boot({ list: listOf([{}]) });
    await pick();
    history.replaceState(null, "", "/");
    await open();
    expect(url()).toBe("/?panel=chat&chat=chat_1");
  });

  test("⌘K and Ctrl+K open it from anywhere; with Alt or Shift they do not", async () => {
    await boot();
    for (const init of [{ metaKey: true, altKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: false }]) {
      key(document.body, "k", init);
      expect(dlg().open).toBe(false);
    }
    const e = key(document.body, "K", { metaKey: true });
    expect([dlg().open, e.defaultPrevented]).toEqual([true, true]);
    dlg().close();
    key(document.body, "k", { ctrlKey: true });
    expect(dlg().open).toBe(true);
  });

  test("closing the window closes the model menu and takes the chat out of the URL", async () => {
    await boot({ list: listOf([{}]) });
    await open();
    await pick();
    document.getElementById("model-btn")!.click();
    expect(document.getElementById("model-menu")!.matches(":popover-open")).toBe(true);
    dlg().close();
    expect([document.getElementById("model-menu")!.matches(":popover-open"), url()]).toEqual([false, "/?panel=chat"]);
    dlg().showModal();
    dlg().close(); // no chat in the URL: nothing to take out
  });

  test("openChat without the window does nothing", async () => {
    await boot();
    dlg().remove();
    expect(() => chat.openChat()).not.toThrow();
  });

  test("without the OpenRouter key it shows the key's card instead; saving the key opens the chat", async () => {
    await boot({ key: false });
    await open();
    const box = document.getElementById("chat-key")!;
    expect([box.hidden, document.getElementById("chat")!.hidden]).toEqual([false, true]);
    expect(text("#chat-key .key-prompt-h")).toBe("Please provide your OpenRouter API key to use Chat.");
    expect(fake.chatModels).not.toHaveBeenCalled();
    chat.chatOpened(); // asked again: the card is not drawn twice
    await flush();
    expect(all("#chat-key .key-prompt")).toHaveLength(1);
    fake.saveKeys!.mockResolvedValue({ ...setup(true), saved: true, checks: { openrouter: { ok: true, message: "Key works" } } });
    type(document.querySelector<HTMLInputElement>("#chat-key input")!, "sk-or-v1-abcdefghijklmnopqrstuvwx");
    button("Save", box)!.click();
    await flush();
    expect([box.hidden, box.childElementCount, document.getElementById("chat")!.hidden]).toEqual([true, 0, false]);
    expect(fake.chatModels).toHaveBeenCalledTimes(1);
  });

  test("without the key, a key set meanwhile (the API keys window, or .env) opens the chat", async () => {
    await boot({ key: false });
    fake.setup!.mockResolvedValue(setup(true));
    await open();
    await flush();
    expect([document.getElementById("chat-key")!.hidden, fake.chatModels.mock.calls.length]).toEqual([true, 1]);
  });

  test("a page without the key's box skips the check", async () => {
    await boot({ key: false });
    document.getElementById("chat-key")!.remove();
    await open();
    expect(fake.chatModels).toHaveBeenCalledTimes(1);
  });
});

describe("asking", () => {
  test("the first question creates the chat with the model shown, then streams the reply to it", async () => {
    await boot();
    await open();
    const calls = streams();
    type(input(), "  What did Alice claim?  ");
    key(input(), "Enter");
    await flush();
    expect(fake.createChat).toHaveBeenCalledWith(LUNA);
    expect(calls.map((c) => [c.id, c.body])).toEqual([["chat_1", { content: "What did Alice claim?", mode: "send" }]]);
    expect([url(), input().value]).toEqual(["/?panel=chat&chat=chat_1", ""]);
  });

  test("empty text, a second question while one streams, and no session send nothing", async () => {
    await boot();
    const calls = streams();
    type(input(), "   ");
    key(input(), "Enter");
    await flush();
    expect(fake.createChat).not.toHaveBeenCalled();
    type(input(), "one");
    key(input(), "Enter");
    await flush();
    type(input(), "two");
    key(input(), "Enter");
    await flush();
    expect(calls).toHaveLength(1);
    calls[0]!.end();
    await flush();
    chat.renderChat(emptyState());
    type(input(), "three");
    key(input(), "Enter"); // the box and Send are disabled then, so only a key could reach it
    await flush();
    expect(toasts()).toEqual(["Start a session or open a recording to chat about it."]);
  });

  test("Enter sends; Shift+Enter and Enter while composing do not", async () => {
    await boot();
    streams();
    type(input(), "q");
    expect(key(input(), "Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(key(input(), "Enter", { isComposing: true } as KeyboardEventInit).defaultPrevented).toBe(false);
    key(input(), "x");
    await flush();
    expect(fake.createChat).not.toHaveBeenCalled();
  });

  test("a chat that cannot be created is a toast, and nothing streams", async () => {
    await boot();
    fake.createChat!.mockRejectedValue(new Error("OpenRouter key missing"));
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    fake.createChat!.mockRejectedValue("odd");
    key(input(), "Enter");
    await flush();
    expect([toasts(), fake.sendChat.mock.calls.length]).toEqual([["OpenRouter key missing", "odd"], 0]);
  });

  test("the reply streams: the question, typing dots, Thinking…, the words as Markdown, then the saved reply", async () => {
    await boot();
    await open();
    const calls = streams();
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    expect([send().textContent, send().className, send().title]).toEqual(["Stop", "btn sm stop", "Stop the reply (Esc)"]);
    expect(document.querySelector<HTMLElement>("#chat-btn .dot")!.hidden).toBe(false);
    expect(all("#chat-streaming .typing i")).toHaveLength(3);
    const c = calls[0]!;
    c.emit({ type: "start", user: msg("user", "q"), assistantId: "m_2", model: LUNA });
    expect(text("#chat-log .msg.user .bubble")).toBe("q");
    c.emit({ type: "thinking" });
    expect(text("#chat-streaming .typing")).toBe(" Thinking…");
    c.emit({ type: "delta", text: "Hello **wor" });
    c.emit({ type: "delta", text: "ld**" });
    await frame();
    expect([text("#chat-streaming strong"), text("#chat-streaming .who")]).toEqual(["world", "GPT-6 Luna · writing"]);
    const done = aChat({ title: "q", messages: [msg("user", "q"), msg("assistant", "Hello **world**")] });
    c.emit({ type: "done", message: done.messages[1]!, chat: done });
    c.end();
    await flush();
    expect([all("#chat-streaming").length, text("#chat-log .msg.assistant strong"), send().textContent, send().className]).toEqual([0, "world", "Send", "btn sm primary"]);
    expect(document.querySelector<HTMLElement>("#chat-btn .dot")!.hidden).toBe(true);
    expect(fake.chats).toHaveBeenCalledTimes(2); // the list reloaded after the reply
    expect(text("#chat-about")).toBe("q");
  });

  test("a start without a question keeps what is shown; an error event is a toast and the failed reply offers Retry", async () => {
    await boot();
    const calls = streams();
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    calls[0]!.emit({ type: "start", user: null, assistantId: "m_2", model: LUNA });
    calls[0]!.emit({ type: "error", message: "No provider of GPT-6 Luna accepts this project's privacy setting", chat: null });
    const failed = aChat({ messages: [msg("user", "q"), msg("assistant", "", { error: "No provider…" })] });
    calls[0]!.emit({ type: "done", message: failed.messages[1]!, chat: failed });
    calls[0]!.end();
    await flush();
    expect(toasts()).toEqual(["No provider of GPT-6 Luna accepts this project's privacy setting"]);
    expect([document.querySelector("#chat-log .msg.assistant")!.className, text("#chat-log .msg.assistant .error-text")]).toEqual(["msg assistant failed", "No provider…"]);
    button("Retry")!.click();
    await flush();
    expect(calls[1]!.body).toEqual({ mode: "regenerate" });
  });

  test("a stream that throws is a toast, and the chat is fetched again (or kept as shown if that fails too)", async () => {
    await boot();
    const calls = streams();
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    fake.chat!.mockResolvedValue(aChat({ title: "From the server" }));
    calls[0]!.fail(new Error("a reply is already being written"));
    await flush();
    expect([toasts(), text("#chat-about")]).toEqual([["a reply is already being written"], "From the server"]);
    type(input(), "again");
    key(input(), "Enter");
    await flush();
    fake.chat!.mockRejectedValue(new Error("gone"));
    calls[1]!.fail("odd");
    await flush();
    expect(toasts()).toEqual(["a reply is already being written", "odd"]);
    expect(text("#chat-about")).toBe("From the server");
  });

  test("Esc in the box, or Stop, stops the reply; a stop that fails is a toast; Esc with nothing streaming does nothing", async () => {
    await boot();
    const calls = streams();
    expect(key(input(), "Escape").defaultPrevented).toBe(false);
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    expect(key(input(), "Escape").defaultPrevented).toBe(true);
    send().click();
    await flush();
    expect(fake.stopChat.mock.calls).toEqual([["chat_1"], ["chat_1"]]);
    fake.stopChat!.mockRejectedValue(new Error("nothing to stop"));
    send().click();
    await flush();
    fake.stopChat!.mockRejectedValue("odd");
    send().click();
    await flush();
    expect(toasts()).toEqual(["nothing to stop", "odd"]);
    calls[0]!.end();
    await flush();
  });

  test("events for a chat no longer on screen are ignored", async () => {
    await boot({ list: listOf([{}, {}]) });
    const calls = streams();
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    fake.chat!.mockResolvedValue(aChat({ id: "chat_2", title: "Other" }));
    await pick(1);
    calls[0]!.emit({ type: "start", user: msg("user", "q"), assistantId: "m", model: LUNA });
    calls[0]!.emit({ type: "delta", text: "zzz" });
    await frame();
    expect(text("#chat-log")).not.toContain("q");
  });

  // Switching chats mid-reply is not blocked (only New chat is), and the "writing" bubble shows whenever a reply
  // streams, so it appears in the other chat (inventory 4 §14.8).
  test.fails("BUG §14.8: the reply being written does not show in another chat", async () => {
    await boot({ list: listOf([{}, {}]) });
    streams();
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    fake.chat!.mockResolvedValue(aChat({ id: "chat_2", title: "Other" }));
    await pick(1);
    expect(all("#chat-streaming")).toHaveLength(0);
  });

  // A reply stream that ends without its "done" event (and without an error) leaves the optimistic messages on screen:
  // the finally block never asks the engine for the chat as saved (inventory 4 §4, chat.ts smell; W7-L1).
  test.fails("BUG W7-L1: a reply stream that ends without 'done' fetches the chat as saved", async () => {
    await boot({ list: listOf([{}]) });
    await pick();
    const before = fake.chat!.mock.calls.length;
    const calls = streams();
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    calls[0]!.end();
    await flush();
    expect(fake.chat!.mock.calls.length).toBe(before + 1);
  });

  // On a change of session, the chat named in the URL (from the recording before) is opened in the new one: chat ids
  // restart per recording, so another recording's chat_2 opens (inventory 4 §14.7).
  test.fails("BUG §14.7: switching recordings does not open the new one's chat with the old one's id", async () => {
    await boot({ list: listOf([{}, {}]), url: "/recordings/S1?panel=chat&chat=chat_2" });
    fake.chat!.mockClear();
    fake.chats!.mockResolvedValue(listOf([{}, {}], { sessionId: "S2" }));
    chat.renderChat(session({ id: "S2", status: "archived" }));
    await flush();
    expect(fake.chat).not.toHaveBeenCalled();
  });

  // A starter click sends its question and clears whatever the user had typed in the box (inventory 4 §14.9).
  test.fails("BUG §14.9: a starter keeps the draft the user typed", async () => {
    await boot();
    streams();
    type(input(), "my own question, half written");
    all("#chat-log .starter")[0]!.click();
    await flush();
    expect(input().value).toBe("my own question, half written");
  });
});

describe("editing and regenerating", () => {
  const withMessages = async () => {
    await boot({ list: listOf([{}]) });
    fake.chat!.mockResolvedValue(aChat({ messages: [msg("user", "first"), msg("assistant", "one"), msg("user", "second"), msg("assistant", "two")] }));
    await pick();
  };

  test("↑ in an empty box edits the last question in place; Escape and Cancel give it up", async () => {
    await withMessages();
    expect(key(input(), "ArrowUp").defaultPrevented).toBe(true);
    const box = document.getElementById("chat-edit") as HTMLTextAreaElement;
    expect([box.value, document.activeElement]).toEqual(["second", box]);
    expect(text("#chat-log .msg.user.editing .note")).toMatch(/^Replaces this question and its answer/);
    key(box, "Escape");
    expect([document.getElementById("chat-edit"), document.activeElement]).toEqual([null, input()]);
    key(input(), "ArrowUp");
    button("Cancel", document.getElementById("chat-log")!)!.click();
    expect(document.getElementById("chat-edit")).toBeNull();
  });

  test("↑ with text in the box, or with no question yet, does nothing", async () => {
    await withMessages();
    type(input(), "draft");
    expect(key(input(), "ArrowUp").defaultPrevented).toBe(false);
    await boot();
    expect(key(input(), "ArrowUp").defaultPrevented).toBe(false);
  });

  test("Enter or Save & send in the edit box asks again in edit mode, dropping the old question and its reply", async () => {
    await withMessages();
    const calls = streams();
    key(input(), "ArrowUp");
    const box = document.getElementById("chat-edit") as HTMLTextAreaElement;
    box.value = "second, better";
    key(box, "Enter", { shiftKey: true });
    key(box, "a");
    key(box, "Enter");
    await flush();
    expect(calls[0]!.body).toEqual({ content: "second, better", mode: "edit" });
    expect(all("#chat-log .msg").map((m) => m.className)).toEqual(["msg user", "msg assistant", "msg assistant streaming"]);
    calls[0]!.end();
    await flush();
    key(input(), "ArrowUp"); // the stream ended without "done": the chat shown is the optimistic one, ending at "first"
    button("Save & send")!.click();
    await flush();
    expect(calls[1]!.body).toEqual({ content: "first", mode: "edit" });
  });

  test("Edit shows only on the last question, and not while a reply streams; Regenerate keeps up to the last question", async () => {
    await withMessages();
    expect(all("#chat-log .msg.user").map((m) => !!button("Edit", m))).toEqual([false, true]);
    expect(all("#chat-log .msg.assistant").map((m) => !!button("Regenerate", m))).toEqual([false, true]);
    const calls = streams();
    button("Regenerate")!.click();
    await flush();
    expect(calls[0]!.body).toEqual({ mode: "regenerate" });
    expect(all("#chat-log .msg").map((m) => m.className)).toEqual(["msg user", "msg assistant", "msg user", "msg assistant streaming"]);
    expect([button("Edit"), button("Regenerate")]).toEqual([undefined, undefined]);
    button("Copy")!.click(); // Copy still works meanwhile
  });

  test("Edit on the last question opens the edit box", async () => {
    await withMessages();
    button("Edit")!.click();
    expect((document.getElementById("chat-edit") as HTMLTextAreaElement).value).toBe("second");
  });
});

describe("messages", () => {
  const show = async (messages: ChatMessage[]) => {
    await boot({ list: listOf([{}]) });
    await open();
    fake.chat!.mockResolvedValue(aChat({ messages }));
    await pick();
  };

  test.each([
    [{ from: 0, to: 120, upToMs: 612_000, live: true }, "Transcript · 120 lines · up to 10:12", "Sent while the recording was live"],
    [{ from: 0, to: 1, upToMs: null, live: false }, "Transcript · 1 line", "Sent after the recording ended"],
    [{ from: 120, to: 164, upToMs: 1_360_000, live: true }, "Transcript · +44 new lines · up to 22:40", "Sent while the recording was live"],
    [{ from: 120, to: 121, upToMs: null, live: true }, "Transcript · +1 new line", "Sent while the recording was live"],
    [{ from: 164, to: 164, upToMs: 1_400_000, live: true }, "Transcript · no new lines · up to 23:20", "Sent while the recording was live"],
  ])("a question's chip says what it carried (%j)", async (lines, chip, title) => {
    await show([msg("user", "q", { lines })]);
    const c = document.querySelector("#chat-log .chip-attach")!;
    expect([c.textContent, c.getAttribute("title")]).toEqual([chip, title]);
  });

  test("a question without lines has no chip; a reply shows Stopped., its error, and its model's short name", async () => {
    await show([msg("user", "q"), msg("assistant", "Part", { stopped: true, model: SONNET }), msg("user", "q2"), msg("assistant", "", { error: "timeout", model: undefined })]);
    expect(all("#chat-log .chip-attach")).toHaveLength(0);
    const [a, b] = all("#chat-log .msg.assistant");
    expect([text(".note", a), text(".who", a)]).toEqual(["Stopped.", "Claude Sonnet 5"]);
    expect([text(".error-text", b), text(".who", b), button("Copy", b!), text(".md", b)]).toEqual(["timeout", "", undefined, ""]);
  });

  test("a cited time in a reply calls back with its moment", async () => {
    await show([msg("user", "q"), msg("assistant", "At [1:02] Alice said so.")]);
    document.querySelector<HTMLButtonElement>("#chat-log .md-time")!.click();
    expect(onTime).toHaveBeenCalledWith(62_000);
  });

  test("Copy puts the text on the clipboard and says Copied for 1.5 s; a refused clipboard is a toast", async () => {
    await show([msg("user", "the question")]);
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const copy = button("Copy")!;
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect([write.mock.calls[0], copy.textContent]).toEqual([["the question"], "Copied"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(copy.textContent).toBe("Copy");
    write.mockRejectedValue(new Error("denied"));
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts()).toEqual(["Copying is not allowed here"]);
  });

  test("the log sticks to the bottom when the reader is near it, keeps the empty state at the top", async () => {
    await boot({ list: listOf([{}]) });
    const log = document.getElementById("chat-log")!;
    let top = 500;
    Object.defineProperty(log, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = v; } });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    await open();
    expect(top).toBe(0); // the empty state reads from the top
    fake.chat!.mockResolvedValue(aChat({ messages: [msg("user", "q")] }));
    await pick();
    expect(top).toBe(2000); // forced to the end on opening a chat
    const calls = streams();
    top = 100; // the reader scrolled up
    type(input(), "q2");
    key(input(), "Enter");
    await flush();
    top = 100;
    calls[0]!.emit({ type: "delta", text: "x" });
    await frame();
    expect(top).toBe(100); // far from the end: left where it is
    top = 1500;
    calls[0]!.emit({ type: "delta", text: "y" });
    await frame();
    expect(top).toBe(2000);
    calls[0]!.end();
    await flush();
  });
});

describe("the sidebar", () => {
  test("lists the chats with their model, cost, and 'writing…' when busy; the chat on screen is current; the spend below", async () => {
    await boot({ list: listOf([{ title: "Claims", model: SONNET, costUsd: 0.0012 }, { title: "Summary", busy: true, costUsd: 0.25 }]) });
    await open();
    await flush();
    expect(all("#chat-list .chat-open").map((b) => `${text("b", b)}|${text("span", b)}`)).toEqual(["Claims|Claude Sonnet 5 · $0.0012", "Summary|GPT-6 Luna · $0.25 · writing…"]);
    expect(text("#chat-spend")).toBe("Chat spend$0.50");
    await pick(1);
    expect(all("#chat-list .chat-row").map((r) => r.className)).toEqual(["chat-row", "chat-row current"]);
    expect(all("#chat-list [aria-label]").map((b) => b.getAttribute("aria-label"))).toEqual(["Rename Claims", "Delete Claims", "Rename Summary", "Delete Summary"]);
  });

  test("+ New chat while a reply streams waits; otherwise it clears the chat, keeps its model for the next, and leaves the URL", async () => {
    await boot({ list: listOf([{}]) });
    await open();
    fake.chat!.mockResolvedValue(aChat({ model: SONNET, messages: [msg("user", "q")] }));
    await pick();
    const calls = streams();
    type(input(), "q2");
    key(input(), "Enter");
    await flush();
    button("+ New chat")!.click();
    expect(toasts()).toEqual(["Wait for the reply, or stop it, before starting a new chat."]);
    calls[0]!.end();
    await flush();
    button("+ New chat")!.click();
    await flush();
    expect([text("#chat-about"), text("#model-btn b"), url(), document.activeElement]).toEqual(["New chat", "Claude Sonnet 5", "/?panel=chat", input()]);
    expect(all("#chat-log .starter")).toHaveLength(4);
    type(input(), "q3");
    key(input(), "Enter");
    await flush();
    expect(fake.createChat).toHaveBeenLastCalledWith(SONNET);
  });

  test("opening a chat still being written checks back every 2 s until it is done", async () => {
    await boot({ list: listOf([{ busy: true }]) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fake.chat!.mockResolvedValueOnce(aChat({ busy: true }));
    all("#chat-list .chat-open")[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    fake.chat!.mockRejectedValueOnce(new Error("blip"));
    await vi.advanceTimersByTimeAsync(2000);
    fake.chat!.mockResolvedValueOnce(aChat({ busy: false, messages: [msg("user", "q"), msg("assistant", "done now")] }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(text("#chat-log .msg.assistant .md")).toBe("done now");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.chat).toHaveBeenCalledTimes(3);
  });

  test("the check stops when another chat is opened", async () => {
    await boot({ list: listOf([{ busy: true }]) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fake.chat!.mockResolvedValueOnce(aChat({ busy: true }));
    all("#chat-list .chat-open")[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    button("+ New chat")!.click();
    await vi.advanceTimersByTimeAsync(4000);
    expect(fake.chat).toHaveBeenCalledTimes(1);
  });

  test("a chat that cannot be opened is a toast, and none is shown", async () => {
    await boot({ list: listOf([{}]) });
    fake.chat!.mockRejectedValue(new Error("unknown chat"));
    await pick();
    fake.chat!.mockRejectedValue("odd");
    await pick();
    expect([toasts(), text("#chat-about")]).toEqual([["unknown chat", "odd"], "New chat"]);
  });

  const answerAsk = (value: string | null) => {
    const d = document.getElementById("dlg-ask") as HTMLDialogElement;
    if (value !== null) (document.getElementById("ask-input") as HTMLInputElement).value = value;
    d.close(value === null ? "" : "ok");
  };

  test("Rename asks in the page, saves the new title, and reloads the list; cancelled or empty does nothing", async () => {
    await boot({ list: listOf([{ title: "Old" }]) });
    await pick();
    fake.updateChat!.mockResolvedValue(aChat({ title: "New title" }));
    all("#chat-list [aria-label^=Rename]")[0]!.click();
    expect([text("#h-ask"), (document.getElementById("ask-input") as HTMLInputElement).value]).toEqual(["Rename chat", "Old"]);
    answerAsk(null);
    await flush();
    all("#chat-list [aria-label^=Rename]")[0]!.click();
    answerAsk("   ");
    await flush();
    expect(fake.updateChat).not.toHaveBeenCalled();
    all("#chat-list [aria-label^=Rename]")[0]!.click();
    answerAsk(" New title ");
    await flush();
    expect(fake.updateChat).toHaveBeenCalledWith("chat_1", { title: "New title" });
    expect([text("#chat-about"), fake.chats.mock.calls.length]).toEqual(["New title", 2]);
  });

  test("renaming a chat not on screen keeps the one shown; a failure is a toast", async () => {
    await boot({ list: listOf([{}, {}]) });
    fake.updateChat!.mockResolvedValue(aChat({ id: "chat_2", title: "Two" }));
    all("#chat-list [aria-label^=Rename]")[1]!.click();
    answerAsk("Two");
    await flush();
    expect(text("#chat-about")).toBe("New chat");
    fake.updateChat!.mockRejectedValue(new Error("too long"));
    all("#chat-list [aria-label^=Rename]")[1]!.click();
    answerAsk("x");
    await flush();
    fake.updateChat!.mockRejectedValue("odd");
    all("#chat-list [aria-label^=Rename]")[1]!.click();
    answerAsk("x");
    await flush();
    expect(toasts()).toEqual(["too long", "odd"]);
  });

  test("Delete confirms in the page; deleting the chat on screen shows none; a failure is a toast", async () => {
    await boot({ list: listOf([{ title: "Gone soon" }, {}]) });
    await pick();
    all("#chat-list [aria-label^=Delete]")[0]!.click();
    expect([text("#h-ask"), text("#ask-message"), document.getElementById("ask-ok")!.className]).toEqual(
      ["Delete this chat?", `"Gone soon" disappears from the list. What it cost stays in the recording's total.`, "btn danger"]);
    answerAsk(null);
    await flush();
    expect(fake.deleteChat).not.toHaveBeenCalled();
    all("#chat-list [aria-label^=Delete]")[1]!.click();
    answerAsk("");
    await flush();
    expect([fake.deleteChat.mock.calls[0], all("#chat-list .chat-row.current").length]).toEqual([["chat_2"], 1]);
    all("#chat-list [aria-label^=Delete]")[0]!.click();
    answerAsk("");
    await flush();
    expect([fake.deleteChat.mock.calls[1], all("#chat-list .chat-row.current").length, url()]).toEqual([["chat_1"], 0, "/"]);
    fake.deleteChat!.mockRejectedValue(new Error("busy"));
    all("#chat-list [aria-label^=Delete]")[0]!.click();
    answerAsk("");
    await flush();
    fake.deleteChat!.mockRejectedValue("odd");
    all("#chat-list [aria-label^=Delete]")[0]!.click();
    answerAsk("");
    await flush();
    expect(toasts()).toEqual(["busy", "odd"]);
  });
});

describe("the model picker", () => {
  const menu = () => document.getElementById("model-menu")!;
  const rows = () => all("#model-list .model-row") as HTMLButtonElement[];
  const search = () => document.getElementById("model-search") as HTMLInputElement;
  const openMenu = async () => { document.getElementById("model-btn")!.click(); await flush(); };

  test("the button shows the model's short name and its facts", async () => {
    await boot();
    await open();
    expect([text("#model-btn b"), text("#model-btn span")]).toEqual(["GPT-6 Luna", "1.05M context · $1.25 in / $10.00 out per M tokens"]);
  });

  test("an unknown context reads 'context ?'; an unknown model shows its id, and no facts", async () => {
    await boot({ list: listOf([{ model: "x/mystery" }, { model: "nobody/knows" }]) });
    await open();
    fake.chat!.mockResolvedValueOnce(aChat({ model: "x/mystery" }));
    await pick(0);
    expect(text("#model-btn span")).toBe("context ? · ? in / ? out per M tokens");
    fake.chat!.mockResolvedValueOnce(aChat({ model: "nobody/knows" }));
    await pick(1);
    expect([text("#model-btn b"), text("#model-btn span")]).toEqual(["nobody/knows", ""]);
  });

  test("opens as a popover with the search focused and the models asked again; a second click closes it", async () => {
    await boot();
    await open();
    await openMenu();
    expect([menu().matches(":popover-open"), document.getElementById("model-btn")!.getAttribute("aria-expanded"), document.activeElement]).toEqual([true, "true", search()]);
    expect(fake.chatModels).toHaveBeenCalledTimes(2);
    expect(rows().map((r) => `${text("b", r)}|${text("small", r)}|${all(".num", r).map((n) => n.textContent).join(" ")}`)).toEqual([
      "GPT-6 Luna|OpenAI|1.05M $1.25 $10.00", "Claude Sonnet 5|Anthropic|200k $3.00 $15.00", "Mystery|x|? ? ?", "Gone|Old|8k $0.05 $0.10",
    ]);
    expect(rows().map((r) => r.className)).toEqual(["model-row current active", "model-row", "model-row", "model-row"]);
    await openMenu();
    expect([menu().matches(":popover-open"), document.getElementById("model-btn")!.getAttribute("aria-expanded")]).toEqual([false, "false"]);
  });

  test("the models asked when it opens redraw only the button once it is closed; a failure changes nothing", async () => {
    await boot();
    await open();
    const answer = later<{ default: string; models: ChatModel[] }>();
    fake.chatModels!.mockReturnValueOnce(answer.promise);
    await openMenu();
    await openMenu();
    answer.resolve({ default: LUNA, models: [MODELS[0]!] });
    await flush();
    expect(all("#model-list .model-row")).toHaveLength(4); // not redrawn while closed
    fake.chatModels!.mockRejectedValueOnce(new Error("offline"));
    await openMenu();
    expect(rows()).toHaveLength(1);
  });

  test("a model no longer listed is disabled and says so", async () => {
    await boot();
    await open();
    await openMenu();
    expect([rows()[3]!.disabled, rows()[3]!.getAttribute("title"), rows()[0]!.getAttribute("title")]).toEqual([true, "OpenRouter no longer lists this model", LUNA]);
  });

  test("search filters by name or id, any case; nothing found says so", async () => {
    await boot();
    await open();
    await openMenu();
    type(search(), "CLAUDE");
    expect(rows().map((r) => text("b", r))).toEqual(["Claude Sonnet 5"]);
    type(search(), "x/myst");
    expect(rows().map((r) => text("b", r))).toEqual(["Mystery"]);
    type(search(), "nope");
    expect([rows().length, text("#model-list .note")]).toEqual([0, `No model matches "nope".`]);
    key(search(), "Enter");
    expect(fake.updateChat).not.toHaveBeenCalled();
  });

  test("↓ and ↑ move within the list; Enter picks; a disabled model is not picked; Escape closes the menu but not the window", async () => {
    await boot();
    await open();
    await openMenu();
    const active = () => rows().findIndex((r) => r.classList.contains("active"));
    key(search(), "ArrowUp");
    expect(active()).toBe(0);
    for (let i = 0; i < 5; i++) key(search(), "ArrowDown");
    expect(active()).toBe(3);
    key(search(), "Enter");
    expect(menu().matches(":popover-open")).toBe(true);
    key(search(), "ArrowUp");
    key(search(), "ArrowUp");
    key(search(), "Enter");
    expect([menu().matches(":popover-open"), text("#model-btn b")]).toEqual([false, "Claude Sonnet 5"]); // no chat yet: the draft's model
    expect(fake.updateChat).not.toHaveBeenCalled();
    await openMenu();
    let bubbled = 0;
    document.body.addEventListener("keydown", () => bubbled++);
    key(search(), "Escape");
    expect([menu().matches(":popover-open"), dlg().open, document.activeElement, bubbled]).toEqual([false, true, document.getElementById("model-btn"), 0]);
    await openMenu();
    key(search(), "a");
    expect(menu().matches(":popover-open")).toBe(true);
  });

  test("the pointer highlights a row; a click picks it", async () => {
    await boot();
    await open();
    await openMenu();
    rows()[2]!.dispatchEvent(new Event("pointermove"));
    rows()[2]!.dispatchEvent(new Event("pointermove"));
    expect(rows().map((r) => r.classList.contains("active"))).toEqual([false, false, true, false]);
    rows()[2]!.click();
    expect(text("#model-btn b")).toBe("Mystery");
  });

  test("the sorts: cheapest by input then output, priciest the reverse, largest context; unknown prices and sizes last", async () => {
    await boot();
    await open();
    const models = [
      model("a/one", "A: One", { inputUsdPerM: 1, outputUsdPerM: 5, contextLength: 100 }),
      model("a/two", "A: Two", { inputUsdPerM: 1, outputUsdPerM: 2, contextLength: 100 }),
      model("a/none", "A: None", { inputUsdPerM: null, outputUsdPerM: null, contextLength: null }),
      model("a/big", "A: Big", { inputUsdPerM: 9, outputUsdPerM: 9, contextLength: 1000 }),
    ];
    fake.chatModels!.mockResolvedValue({ default: LUNA, models });
    await openMenu();
    const names = () => rows().map((r) => text("b", r));
    const sort = (label: string) => button(label, menu())!.click();
    expect(names()).toEqual(["One", "Two", "None", "Big"]);
    sort("Cheapest");
    expect(names()).toEqual(["Two", "One", "Big", "None"]);
    expect(all("#model-menu .seg-ctl button").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false"]);
    expect(document.activeElement).toBe(search());
    sort("Priciest");
    expect(names()).toEqual(["Big", "One", "Two", "None"]);
    sort("Largest context");
    expect(names()).toEqual(["Big", "One", "Two", "None"]);
    sort("Suggested");
    expect(names()).toEqual(["One", "Two", "None", "Big"]);
  });

  test("the sort is remembered in the browser; a stored value that is not a sort is ignored", async () => {
    await boot();
    await open();
    await openMenu();
    button("Priciest", menu())!.click();
    expect(localStorage.getItem("pa.modelSort")).toBe("priciest");
    vi.resetModules();
    const again = await import("../../web/src/chat.ts");
    expect(again).not.toBe(chat);
    await boot(); // a fresh page clears storage: set it before the module loads
    localStorage.setItem("pa.modelSort", "cheapest");
    vi.resetModules();
    chat = await import("../../web/src/chat.ts");
    (await import("../../web/src/keys.ts")).setupStatus();
    document.getElementById("chat")!.replaceChildren();
    chat.bindChat({ onTime });
    chat.renderChat(session());
    await flush();
    await open();
    await openMenu();
    expect(all("#model-menu .seg-ctl button[aria-pressed=true]").map((b) => b.textContent)).toEqual(["Cheapest"]);
    localStorage.setItem("pa.modelSort", "bogus");
    vi.resetModules();
    chat = await import("../../web/src/chat.ts");
    document.getElementById("chat")!.replaceChildren();
    chat.bindChat({ onTime });
    chat.renderChat(session());
    await flush();
    await open();
    await openMenu();
    expect(all("#model-menu .seg-ctl button[aria-pressed=true]").map((b) => b.textContent)).toEqual(["Suggested"]);
  });

  test("picking a model for a chat saves it; the same model does nothing; a failure is a toast", async () => {
    await boot({ list: listOf([{}]) });
    await open();
    await pick();
    await openMenu();
    rows()[0]!.click();
    await flush();
    expect(fake.updateChat).not.toHaveBeenCalled();
    fake.updateChat!.mockResolvedValue(aChat({ model: SONNET }));
    await openMenu();
    rows()[1]!.click();
    await flush();
    expect([fake.updateChat.mock.calls[0], text("#model-btn b")]).toEqual([["chat_1", { model: SONNET }], "Claude Sonnet 5"]);
    fake.updateChat!.mockRejectedValue(new Error("busy"));
    await openMenu();
    rows()[0]!.click();
    await flush();
    fake.updateChat!.mockRejectedValue("odd");
    await openMenu();
    rows()[0]!.click();
    await flush();
    expect(toasts()).toEqual(["busy", "odd"]);
  });

  test("a pointer down outside the menu and its button closes it; inside, it stays", async () => {
    await boot();
    await open();
    await openMenu();
    search().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    document.getElementById("model-btn")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu().matches(":popover-open")).toBe(true);
    document.getElementById("chat-log")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu().matches(":popover-open")).toBe(false);
    document.getElementById("chat-log")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });

  // price(): a price under $0.0005 per million tokens rounds to "$0", so a tiny price reads as free (inventory 4 §14.10).
  test.fails("BUG §14.10: a tiny price does not read as free", async () => {
    await boot();
    await open();
    fake.chatModels!.mockResolvedValue({ default: LUNA, models: [model("a/tiny", "A: Tiny", { inputUsdPerM: 0.0004 })] });
    await openMenu();
    expect(all("#model-list .num")[1]!.textContent).not.toBe("$0");
  });
});

describe("the meter", () => {
  test("before the first question: nothing sent yet, and the window from the model's context", async () => {
    await boot();
    await open();
    expect(all("#chat-meter .meter-row").map((r) => r.textContent)).toEqual(["Context0 of 1.05M · 1.05M left", "Nothing sent yet: a new chat costs nothing until you ask.Recording $0.50"]);
    expect(document.querySelector<HTMLElement>("#chat-meter .bar b")!.getAttribute("style")).toBe("width:0%");
  });

  test("with an unknown window: only what is used; with no list: no recording spend", async () => {
    await boot({ st: null });
    chat.renderChat(session());
    fake.chats!.mockRejectedValue(new Error("x"));
    chat.renderChat(session({ id: "S2" }));
    await flush();
    await open();
    fake.chat!.mockResolvedValue(aChat({ model: "x/mystery", meter: meter({ contextLength: null, contextTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimated: false }) }));
    fake.chats!.mockResolvedValue(listOf([{}], { sessionId: "S2" }));
    chat.renderChat(session({ id: "S3" }));
    chat.renderChat(session({ id: "S2" }));
    await flush();
    await pick();
    expect(all("#chat-meter .meter-row").map((r) => r.textContent)).toEqual(["Context0 used", "In 12kOut 900This chat $0.01Recording $0.50"]);
  });

  test("a chat's meter: context, input (cached), output (thinking), its cost (estimated*), and the lines the next question brings", async () => {
    await boot({ list: listOf([{}]) });
    fake.chat!.mockResolvedValue(aChat({ meter: meter({ estimated: true, pendingLines: 1, pendingTokens: 40 }) }));
    await pick();
    expect(all("#chat-meter .meter-row").map((r) => r.textContent)).toEqual([
      "Context31k of 1.05M · 1.02M left", "In 12k (3k cached)Out 900 (200 thinking)This chat $0.01*Recording $0.50",
      "Your next question brings 1 new line (about 40 tokens).",
    ]);
    expect(document.querySelector("#chat-meter [title]")!.getAttribute("title")).toBe("Includes an estimate for a stopped reply");
    fake.chat!.mockResolvedValue(aChat({ meter: meter({ pendingLines: 44, pendingTokens: 1800 }) }));
    await pick();
    expect(text("#chat-meter .pending")).toBe("Your next question brings 44 new lines (about 1.8k tokens).");
  });

  test("past 80% of the window the bar warns and suggests a new chat", async () => {
    await boot({ list: listOf([{}]) });
    fake.chat!.mockResolvedValue(aChat({ meter: meter({ contextLength: 100_000, contextTokens: 90_000 }) }));
    await pick();
    expect(document.querySelector("#chat-meter .bar b")!.className).toBe("warn");
    expect(text("#chat-meter .error-text")).toBe("This chat is close to the model's limit: start a new chat, or pick a model with a larger context.");
    fake.chat!.mockResolvedValue(aChat({ meter: meter({ contextLength: 100_000, contextTokens: 250_000 }) }));
    await pick();
    expect(document.querySelector<HTMLElement>("#chat-meter .bar b")!.getAttribute("style")).toBe("width:100%");
  });

  test("on air, new lines refresh the meter at most every 4 s while the window is open and no reply streams", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(100_000);
    await boot({ list: listOf([{}]) });
    await pick();
    const calls = fake.chat!.mock.calls.length;
    chat.renderChat(session()); // closed: nothing
    await open();
    fake.chat!.mockResolvedValue(aChat({ meter: meter({ pendingLines: 3, pendingTokens: 90 }) }));
    chat.renderChat(session());
    await flush();
    expect(text("#chat-meter .pending")).toBe("Your next question brings 3 new lines (about 90 tokens).");
    vi.setSystemTime(103_000);
    chat.renderChat(session());
    expect(fake.chat!.mock.calls.length).toBe(calls + 1);
    vi.setSystemTime(105_000);
    fake.chat!.mockRejectedValueOnce(new Error("offline"));
    chat.renderChat(session());
    await flush();
    expect(fake.chat!.mock.calls.length).toBe(calls + 2);
    const s = streams();
    type(input(), "q");
    key(input(), "Enter");
    await flush();
    vi.setSystemTime(200_000);
    chat.renderChat(session());
    expect(fake.chat!.mock.calls.length).toBe(calls + 2);
    s[0]!.end();
    await flush();
  });

  test("a meter answer for a chat no longer on screen is dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(100_000);
    await boot({ list: listOf([{}, {}]) });
    await pick(0);
    await open();
    const answer = later<Chat>();
    fake.chat!.mockReturnValueOnce(answer.promise);
    chat.renderChat(session());
    fake.chat!.mockResolvedValueOnce(aChat({ id: "chat_2", meter: meter({ inputTokens: 5 }) }));
    await pick(1);
    answer.resolve(aChat({ meter: meter({ inputTokens: 999_000 }) }));
    await flush();
    expect(text("#chat-meter")).toContain("In 5");
  });
});
