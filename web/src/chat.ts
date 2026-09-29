// Chat: a large window, opened from the header, to ask any model in chat.models about the transcript of the
// session on screen, live or recorded.
// The engine owns the conversation (see docs/chat.md); this module only shows it and posts questions. Nothing is
// created, sent, or spent until the first question of a new chat.
import { api, type Chat, type ChatList, type ChatMessage, type ChatModel } from "./api.js";
import { $, clock, glyph, h, replace, usd } from "./dom.js";
import { keyPrompt, keySet, setupStatus } from "./keys.js";
import { renderMarkdown } from "./markdown.js";
import { ask, toast } from "./panels.js";
import { readRoute, setRoute } from "./router.js";
import { place } from "./ui.js";
import type { State } from "./state.js";

const STARTERS = [
  "Summarise the conversation so far.",
  "What were the main disagreements, and who took which side?",
  "List every claim about AI companies or models, with its time.",
  "What happened in the last five minutes?",
];

let models: ChatModel[] = [];
let defaultModel = "openai/gpt-6-luna";
let list: ChatList | null = null;
/** The chat on screen; null is a new chat that does not exist yet. */
let current: Chat | null = null;
/** The model a new chat will use. */
let draftModel: string | null = null;
let sessionId: string | null = null;
let hasSession = false;
let streaming: { chatId: string; assistantId: string; text: string; thinking: boolean; model: string } | null = null;
/** The question being edited in place (the last one), if any. */
let editing = false;
let onTime: (ms: number) => void = () => {};
let lastMeterRefresh = 0;
let busyPoll = 0;
let sessionLabel = "";

type ModelSort = "suggested" | "cheapest" | "priciest" | "context";
const SORTS: [ModelSort, string][] = [["suggested", "Suggested"], ["cheapest", "Cheapest"], ["priciest", "Priciest"], ["context", "Largest context"]];
let modelSort: ModelSort = "suggested";
try { const saved = localStorage.getItem("pa.modelSort"); if (SORTS.some(([k]) => k === saved)) modelSort = saved as ModelSort; } catch { /* storage may be unavailable */ }
let modelQuery = "";
let modelActive = 0;

const isOpen = () => !!$<HTMLDialogElement>("#dlg-chat")?.open;

const el = {
  root: () => $("#chat")!,
  log: () => $("#chat-log")!,
  input: () => $<HTMLTextAreaElement>("#chat-input")!,
};

// ---------- formatting ----------

/** 950, 12.4k, 1.05M */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
}

const price = (n: number | null) => (n === null ? "?" : n < 0.1 ? `$${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}` : `$${n.toFixed(2)}`);
const modelOf = (id: string) => models.find((m) => m.id === id);
/** "GPT-6 Luna" from "OpenAI: GPT-6 Luna". */
const shortName = (id: string) => (modelOf(id)?.name ?? id).replace(/^[^:]+:\s*/, "");
const vendor = (id: string) => (modelOf(id)?.name.match(/^([^:]+):/)?.[1] ?? id.split("/")[0]!);
const facts = (m: ChatModel | undefined) =>
  m ? `${m.contextLength ? `${tokens(m.contextLength)} context` : "context ?"} · ${price(m.inputUsdPerM)} in / ${price(m.outputUsdPerM)} out per M tokens` : "";

const activeModel = () => current?.model ?? draftModel ?? defaultModel;

// ---------- boot ----------

export function bindChat(opts: { onTime: (ms: number) => void }) {
  onTime = opts.onTime;
  const input = h("textarea", {
    id: "chat-input", class: "chat-input", rows: 1, placeholder: "Ask about the transcript…", "aria-label": "Your question",
  });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
    else if (e.key === "Escape" && streaming) { e.preventDefault(); void stop(); }
    else if (e.key === "ArrowUp" && !input.value && !streaming) {
      const last = lastUser();
      if (last) { e.preventDefault(); startEdit(); }
    }
  });
  replace(el.root(),
    h("aside", { class: "chat-side", "aria-label": "Chats" },
      h("button", { class: "btn new-chat", onclick: () => newChat() }, "+ New chat"),
      h("div", { id: "chat-list", class: "chat-list scroll" }),
      h("div", { id: "chat-spend", class: "chat-spend" })),
    h("section", { class: "chat-main" },
      h("div", { class: "chat-top" },
        h("div", { class: "model-pick" },
          h("button", { id: "model-btn", class: "model-btn", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Change the model", onclick: toggleModels }),
          h("div", { id: "model-menu", class: "model-menu", popover: "manual", role: "dialog", "aria-label": "Choose a model" })),
        h("span", { id: "chat-about", class: "chat-about" })),
      h("div", { id: "chat-log", class: "scroll chat-log", "aria-live": "polite" }),
      h("div", { class: "chat-foot" },
        h("div", { id: "chat-meter", class: "chat-meter" }),
        h("div", { class: "composer" },
          input,
          h("div", { class: "composer-row" },
            h("span", { class: "attach", title: "The transcript is attached to every chat: each question brings the lines said since the last one" }, "Transcript attached"),
            h("span", { class: "keys" }, "Enter to send · Shift+Enter for a new line"),
            h("button", { id: "chat-send", class: "btn primary sm", onclick: () => void (streaming ? stop() : submit()) }, "Send"))))));
  document.addEventListener("pointerdown", (e) => {
    const m = $("#model-menu");
    const t = e.target as Node;
    if (m?.matches(":popover-open") && !m.contains(t) && !$("#model-btn")!.contains(t)) closeModels();
  });
  $<HTMLDialogElement>("#dlg-chat")?.addEventListener("close", () => { closeModels(); if (readRoute().chat) setRoute({ chat: null }); });
  // ⌘K / Ctrl+K opens the chat from anywhere
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      openChat();
    }
  });
  void api.chatModels().then((r) => { models = r.models; defaultModel = r.default; draw(); }).catch(() => {});
  draw();
}

function autosize() {
  const t = el.input();
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
}

/** Opens the chat window (the header's Chat button and ⌘K); without an OpenRouter key it asks for one first. */
export function openChat() {
  const d = $<HTMLDialogElement>("#dlg-chat");
  if (!d) return;
  if (!d.open) {
    document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((x) => x.close());
    d.showModal();
  }
  chatOpened();
}

/** Chat asks OpenRouter's models: without its key, the window shows the key's card instead, and saving opens the chat. */
function needKey(): boolean {
  const box = $("#chat-key"), chat = $("#chat");
  if (!box || !chat) return false;
  const missing = !keySet("openrouter");
  box.hidden = !missing;
  chat.hidden = missing;
  if (missing && !box.childElementCount) {
    replace(box, keyPrompt("openrouter", "Please provide your OpenRouter API key to use Chat.", {
      onSaved: () => { replace(box); needKey(); chatOpened(); },
    }));
  }
  return missing;
}

/** Called on every render of the page: follows the session on screen, and keeps the meter's pending lines current. */
export function renderChat(st: State) {
  const id = st.session?.id ?? null;
  hasSession = !!st.session;
  const label = st.session ? `About ${st.session.name || st.session.id}${st.session.status === "running" ? " · on air" : st.session.status === "archived" ? " · recording" : ""}` : "";
  if (label !== sessionLabel) { sessionLabel = label; replace($("#chat-sub"), label || "Ask about the transcript"); }
  if (id !== sessionId) {
    sessionId = id;
    current = null;
    streaming = null;
    editing = false;
    list = null;
    if (id) void loadList(readRoute().chat ?? null);
    draw();
    return;
  }
  // new transcript lines change what the next question brings along
  if (isOpen() && current && !streaming && Date.now() - lastMeterRefresh > 4000) {
    lastMeterRefresh = Date.now();
    const cid = current.id;
    void api.chat(cid).then((c) => { if (current?.id === cid && !streaming) { current = { ...current, meter: c.meter }; drawMeter(); } }).catch(() => {});
  }
}

/** The window opened: put its chat in the URL (the URL's own chat, if not loaded yet, stays). */
export function chatOpened() {
  setRoute({ panel: "chat" });
  if (needKey()) {
    // what the server says now: a key saved in the API keys window, or in .env and a restart
    void setupStatus().then(() => { if (!needKey()) chatOpened(); });
    return;
  }
  // before the chat the URL names has loaded, keep it there
  if (current) setRoute({ chat: current.id });
  requestAnimationFrame(() => { scrollToEnd(true); if (!editing) el.input().focus(); });
}

async function loadList(open: string | null = null) {
  try {
    list = await api.chats();
    if (list.sessionId !== sessionId) return;
    if (open && list.chats.some((c) => c.id === open)) await select(open);
  } catch { list = null; }
  draw();
}

async function select(id: string | null) {
  editing = false;
  if (!id) { current = null; setRoute({ chat: null }); draw(); return; }
  try {
    current = await api.chat(id);
    setRoute({ chat: id });
    pollWhileBusy();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
    current = null;
  }
  draw();
  scrollToEnd(true);
}

function newChat() {
  if (streaming) return toast("Wait for the reply, or stop it, before starting a new chat.");
  draftModel = current?.model ?? draftModel;
  void select(null);
  el.input().focus();
}

/** A reply still being written after a reload (or in another window): check back until it is saved. */
function pollWhileBusy() {
  clearTimeout(busyPoll);
  if (!current?.busy || streaming) return;
  const id = current.id;
  busyPoll = window.setTimeout(async () => {
    if (current?.id !== id) return;
    try { current = await api.chat(id); draw(); scrollToEnd(); } catch { /* try again */ }
    pollWhileBusy();
  }, 2000);
}

// ---------- asking ----------

const lastUser = () => current ? [...current.messages].reverse().find((m) => m.role === "user") : undefined;

async function submit(text = el.input().value, mode: "send" | "edit" | "regenerate" = "send") {
  const content = text.trim();
  if (streaming || (mode !== "regenerate" && !content)) return;
  if (!hasSession) return toast("Start a session or open a recording to chat about it.");
  try {
    if (!current) {
      current = await api.createChat(activeModel());
      draftModel = null;
      setRoute({ chat: current.id });
    }
  } catch (e) {
    return toast(e instanceof Error ? e.message : String(e));
  }
  const chat = current;
  if (mode === "send") { el.input().value = ""; autosize(); }
  editing = false;
  streaming = { chatId: chat.id, assistantId: "", text: "", thinking: false, model: chat.model };
  // what is on screen until the engine confirms: the question, and a reply being written
  if (mode === "edit") {
    const i = chat.messages.map((m) => m.role).lastIndexOf("user");
    chat.messages = chat.messages.slice(0, i);
  } else if (mode === "regenerate") {
    const i = chat.messages.map((m) => m.role).lastIndexOf("user");
    chat.messages = chat.messages.slice(0, i + 1);
  }
  draw();
  scrollToEnd(true);
  let frame = 0;
  try {
    await api.sendChat(chat.id, mode === "regenerate" ? { mode } : { content, mode }, (e) => {
      if (!streaming || current?.id !== chat.id) return;
      if (e.type === "start") {
        streaming.assistantId = e.assistantId;
        if (e.user) chat.messages.push(e.user);
        draw();
        scrollToEnd(true);
      } else if (e.type === "thinking") {
        streaming.thinking = true;
        drawStreaming();
      } else if (e.type === "delta") {
        streaming.text += e.text;
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawStreaming(); scrollToEnd(); });
      } else if (e.type === "error") {
        toast(e.message);
      } else if (e.type === "done") {
        current = e.chat;
      }
    });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
    try { current = await api.chat(chat.id); } catch { /* keep what is shown */ }
  } finally {
    cancelAnimationFrame(frame);
    streaming = null;
    void loadList();
    draw();
    scrollToEnd();
  }
}

async function stop() {
  if (!streaming) return;
  try { await api.stopChat(streaming.chatId); } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
}

function startEdit() {
  editing = true;
  drawLog();
  const box = $<HTMLTextAreaElement>("#chat-edit");
  box?.focus();
  box?.setSelectionRange(box.value.length, box.value.length);
}

// ---------- menus ----------

function drawSide() {
  const chats = list?.chats ?? [];
  replace($("#chat-list"),
    chats.length === 0
      ? h("p", { class: "note" }, hasSession ? "No chats yet. Your first question starts one." : "")
      : chats.map((c) => h("div", { class: `chat-row${c.id === current?.id ? " current" : ""}` },
        h("button", { class: "chat-open", "aria-current": c.id === current?.id ? "true" : null, onclick: () => void select(c.id) },
          h("b", {}, c.title),
          h("span", {}, [shortName(c.model), usd(c.costUsd), c.busy ? "writing…" : null].filter(Boolean).join(" · "))),
        h("span", { class: "row-acts" },
          h("button", { class: "btn icon sm", title: "Rename", "aria-label": `Rename ${c.title}`, onclick: () => void rename(c.id, c.title) }, "✎"),
          h("button", { class: "btn icon sm", title: "Delete", "aria-label": `Delete ${c.title}`, onclick: () => void remove(c.id, c.title) }, glyph("trash"))))));
  replace($("#chat-spend"), list
    ? [h("span", { class: "k" }, "Chat spend"), h("span", {}, usd(list.spentUsd))]
    : null);
}

async function rename(id: string, title: string) {
  const next = await ask("Rename chat", { input: true, value: title, ok: "Rename" });
  if (next === null || !next.trim()) return;
  try {
    const c = await api.updateChat(id, { title: next.trim() });
    if (current?.id === id) current = { ...current, title: c.title };
    await loadList();
  } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
}

async function remove(id: string, title: string) {
  const ok = await ask("Delete this chat?", { message: `"${title}" disappears from the list. What it cost stays in the recording's total.`, ok: "Delete", danger: true });
  if (ok === null) return;
  try {
    await api.deleteChat(id);
    if (current?.id === id) await select(null);
    await loadList();
  } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
}

function closeModels() {
  const m = $("#model-menu");
  if (m?.matches(":popover-open")) m.hidePopover();
  $("#model-btn")?.setAttribute("aria-expanded", "false");
}

function toggleModels() {
  const m = $("#model-menu")!;
  if (m.matches(":popover-open")) return closeModels();
  modelQuery = "";
  drawModelMenu();
  m.showPopover();
  place(m, $("#model-btn")!, 6);
  // the list gets the room down to the window's edge, not a dropdown's 320 px
  m.style.maxHeight = `${Math.max(260, Math.min(640, window.innerHeight - $("#model-btn")!.getBoundingClientRect().bottom - 20))}px`;
  $("#model-btn")!.setAttribute("aria-expanded", "true");
  $<HTMLInputElement>("#model-search")?.focus();
  void api.chatModels().then((r) => { models = r.models; if (m.matches(":popover-open")) drawModelList(); drawModelButton(); }).catch(() => {});
}

/** The models matching the search, in the chosen order. A transcript chat is mostly input, so price sorts by input first. */
function shownModels(): ChatModel[] {
  const q = modelQuery.trim().toLowerCase();
  const found = models.filter((m) => !q || `${m.name} ${m.id}`.toLowerCase().includes(q));
  const num = (v: number | null, missing: number) => (v === null ? missing : v);
  if (modelSort === "cheapest") found.sort((a, b) => num(a.inputUsdPerM, Infinity) - num(b.inputUsdPerM, Infinity) || num(a.outputUsdPerM, Infinity) - num(b.outputUsdPerM, Infinity));
  else if (modelSort === "priciest") found.sort((a, b) => num(b.inputUsdPerM, -1) - num(a.inputUsdPerM, -1) || num(b.outputUsdPerM, -1) - num(a.outputUsdPerM, -1));
  else if (modelSort === "context") found.sort((a, b) => num(b.contextLength, -1) - num(a.contextLength, -1) || num(a.inputUsdPerM, Infinity) - num(b.inputUsdPerM, Infinity));
  return found;
}

function drawModelMenu() {
  const search = h("input", { id: "model-search", class: "input", placeholder: "Search models", "aria-label": "Search models", value: modelQuery });
  search.addEventListener("input", () => { modelQuery = search.value; modelActive = 0; drawModelList(); });
  search.addEventListener("keydown", (e) => {
    const shown = shownModels();
    if (e.key === "ArrowDown") { e.preventDefault(); modelActive = Math.min(shown.length - 1, modelActive + 1); drawModelList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); modelActive = Math.max(0, modelActive - 1); drawModelList(); }
    else if (e.key === "Enter") { e.preventDefault(); const m = shown[modelActive]; if (m && m.available !== false) void pickModel(m.id); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModels(); $("#model-btn")?.focus(); }
  });
  replace($("#model-menu"),
    h("div", { class: "model-tools" },
      search,
      h("div", { class: "seg-ctl", role: "group", "aria-label": "Sort models" },
        SORTS.map(([k, label]) => h("button", {
          "aria-pressed": String(modelSort === k),
          onclick: () => {
            modelSort = k;
            try { localStorage.setItem("pa.modelSort", k); } catch { /* storage may be unavailable */ }
            document.querySelectorAll("#model-menu .seg-ctl button").forEach((b, i) => b.setAttribute("aria-pressed", String(SORTS[i]![0] === k)));
            drawModelList();
            search.focus();
          },
        }, label)))),
    h("div", { class: "model-head", "aria-hidden": "true" }, h("span", {}, "Model"), h("span", {}, "Context"), h("span", {}, "Input"), h("span", {}, "Output")),
    h("div", { id: "model-list", class: "model-list", role: "listbox", "aria-label": "Models" }),
    h("p", { class: "note" }, "Prices per million tokens. A transcript chat is mostly input: each question re-sends the conversation, so Cheapest sorts by input price. Switching mid-chat sends the whole conversation to the new model with the next question."));
  modelActive = Math.max(0, shownModels().findIndex((m) => m.id === activeModel()));
  drawModelList();
}

function drawModelList() {
  const active = activeModel();
  const shown = shownModels();
  modelActive = Math.min(modelActive, Math.max(0, shown.length - 1));
  replace($("#model-list"),
    shown.length === 0 ? h("p", { class: "note" }, `No model matches "${modelQuery}".`) : null,
    shown.map((m, i) => h("button", {
      class: `model-row${m.id === active ? " current" : ""}${i === modelActive ? " active" : ""}`, role: "option",
      disabled: m.available === false, "aria-selected": String(m.id === active),
      title: m.available === false ? "OpenRouter no longer lists this model" : m.id,
      onclick: () => void pickModel(m.id),
      onpointermove: () => { if (modelActive !== i) { modelActive = i; document.querySelectorAll("#model-list .model-row").forEach((r, k) => r.classList.toggle("active", k === i)); } },
    },
      h("span", { class: "model-name" }, h("b", {}, shortName(m.id)), h("small", {}, vendor(m.id))),
      h("span", { class: "num" }, m.contextLength ? tokens(m.contextLength) : "?"),
      h("span", { class: "num" }, price(m.inputUsdPerM)),
      h("span", { class: "num" }, price(m.outputUsdPerM)))));
  $("#model-list .model-row.active")?.scrollIntoView({ block: "nearest" });
}

async function pickModel(id: string) {
  closeModels();
  if (!current) { draftModel = id; draw(); return; }
  if (id === current.model) return;
  try {
    current = await api.updateChat(current.id, { model: id });
    void loadList();
  } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  draw();
}

// ---------- drawing ----------

function draw() {
  if (!$("#chat")) return;
  const dot = $("#chat-btn .dot");
  if (dot) dot.hidden = !streaming;
  drawSide();
  drawModelButton();
  replace($("#chat-about"), current?.title ?? (hasSession ? "New chat" : ""));
  drawLog();
  drawMeter();
  $("#model-btn")!.toggleAttribute("disabled", !hasSession);
  const send = $<HTMLButtonElement>("#chat-send")!;
  replace(send, streaming ? "Stop" : "Send");
  send.className = `btn sm ${streaming ? "stop" : "primary"}`;
  send.title = streaming ? "Stop the reply (Esc)" : "Send (Enter; Shift+Enter for a new line)";
  send.disabled = !hasSession;
  el.input().disabled = !hasSession;
  el.input().placeholder = !hasSession ? "Start a session or open a recording to chat about it" : "Ask about the transcript…";
}

function drawModelButton() {
  const id = activeModel();
  replace($("#model-btn"), h("b", {}, shortName(id)), h("span", {}, facts(modelOf(id))), h("i", { class: "caret" }, "▾"));
}

function drawLog() {
  const log = el.log();
  if (!hasSession) {
    return replace(log, h("div", { class: "chat-empty" }, h("p", {}, "Start a session or open a recording to chat about its transcript.")));
  }
  const msgs = current?.messages ?? [];
  if (msgs.length === 0 && !streaming) {
    return replace(log, h("div", { class: "chat-empty" },
      h("h3", {}, "Ask about the transcript"),
      h("p", {}, "The transcript is attached. On air, each question also brings every line said since your last one, so answers cover the show up to the moment you ask."),
      h("div", { class: "starters" }, STARTERS.map((q) => h("button", { class: "starter", onclick: () => void submit(q) }, q)))));
  }
  const lastU = msgs.map((m) => m.role).lastIndexOf("user");
  const lastA = msgs.map((m) => m.role).lastIndexOf("assistant");
  const rows: HTMLElement[] = [];
  msgs.forEach((m, i) => {
    if (m.role === "user") rows.push(userBubble(m, i === lastU && !streaming));
    else rows.push(assistantBubble(m, i === lastA && i > lastU && !streaming));
  });
  if (streaming) rows.push(h("div", { id: "chat-streaming", class: "msg assistant streaming" }));
  replace(log, rows);
  if (streaming) drawStreaming();
}

function attachment(m: ChatMessage) {
  const l = m.lines;
  if (!l) return null;
  const n = l.to - l.from;
  const upTo = l.upToMs === null ? "" : ` · up to ${clock(l.upToMs)}`;
  const text = l.from === 0 ? `Transcript · ${n} line${n === 1 ? "" : "s"}${upTo}` : n ? `Transcript · +${n} new line${n === 1 ? "" : "s"}${upTo}` : `Transcript · no new lines${upTo}`;
  return h("span", { class: "chip-attach", title: l.live ? "Sent while the recording was live" : "Sent after the recording ended" }, text);
}

function userBubble(m: ChatMessage, last: boolean) {
  if (last && editing) {
    const box = h("textarea", { id: "chat-edit", class: "chat-input edit", rows: 3, value: m.content });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(box.value, "edit"); }
      else if (e.key === "Escape") { editing = false; drawLog(); el.input().focus(); }
    });
    return h("div", { class: "msg user editing" }, box,
      h("div", { class: "row end" },
        h("button", { class: "btn sm", onclick: () => { editing = false; drawLog(); } }, "Cancel"),
        h("button", { class: "btn primary sm", onclick: () => void submit(box.value, "edit") }, "Save & send")),
      h("p", { class: "note" }, "Replaces this question and its answer. The new question brings every line said since the one before it."));
  }
  return h("div", { class: "msg user" },
    h("div", { class: "bubble" }, m.content),
    h("div", { class: "msg-meta" },
      attachment(m),
      h("span", { class: "acts" },
        copyButton(m.content),
        last ? h("button", { class: "act", title: "Edit this question (↑ in an empty box)", onclick: startEdit }, "Edit") : null)));
}

function assistantBubble(m: ChatMessage, last: boolean) {
  return h("div", { class: `msg assistant${m.error ? " failed" : ""}` },
    m.content ? renderMarkdown(m.content, { onTime }) : null,
    m.stopped ? h("p", { class: "note" }, "Stopped.") : null,
    m.error ? h("p", { class: "error-text" }, m.error) : null,
    h("div", { class: "msg-meta" },
      h("span", { class: "who" }, shortName(m.model ?? "")),
      h("span", { class: "acts" },
        m.content ? copyButton(m.content) : null,
        last ? h("button", { class: "act", title: "Ask the same question again", onclick: () => void submit("", "regenerate") }, m.error ? "Retry" : "Regenerate") : null)));
}

function copyButton(text: string) {
  return h("button", {
    class: "act", title: "Copy",
    onclick: (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement;
      void navigator.clipboard.writeText(text).then(() => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); },
        () => toast("Copying is not allowed here"));
    },
  }, "Copy");
}

function drawStreaming() {
  const box = $("#chat-streaming");
  if (!box || !streaming) return;
  replace(box,
    streaming.text ? renderMarkdown(streaming.text, { onTime }) : h("p", { class: "typing" }, h("i", {}), h("i", {}), h("i", {}), streaming.thinking ? " Thinking…" : ""),
    h("div", { class: "msg-meta" }, h("span", { class: "who" }, `${shortName(streaming.model)} · writing`)));
}

function drawMeter() {
  const box = $("#chat-meter")!;
  if (!hasSession) return replace(box);
  const mt = current?.meter;
  const info = modelOf(activeModel());
  const window = mt?.contextLength ?? info?.contextLength ?? null;
  const used = mt?.contextTokens ?? 0;
  const pct = window ? Math.min(100, (used / window) * 100) : 0;
  const pending = mt ? mt.pendingLines : null;
  replace(box,
    h("div", { class: "meter-row" },
      h("span", { class: "k" }, "Context"),
      h("span", { class: "bar" }, h("b", { class: pct > 80 ? "warn" : "", style: `width:${pct}%` })),
      h("span", { class: "v" }, window ? `${tokens(used)} of ${tokens(window)} · ${tokens(Math.max(0, window - used))} left` : `${tokens(used)} used`)),
    h("div", { class: "meter-row small" },
      mt ? [
        h("span", {}, `In ${tokens(mt.inputTokens)}${mt.cachedTokens ? ` (${tokens(mt.cachedTokens)} cached)` : ""}`),
        h("span", {}, `Out ${tokens(mt.outputTokens)}${mt.reasoningTokens ? ` (${tokens(mt.reasoningTokens)} thinking)` : ""}`),
        h("span", { title: mt.estimated ? "Includes an estimate for a stopped reply" : "" }, `This chat ${usd(mt.costUsd)}${mt.estimated ? "*" : ""}`),
      ] : h("span", {}, "Nothing sent yet: a new chat costs nothing until you ask."),
      list ? h("span", {}, `Recording ${usd(list.spentUsd)}`) : null),
    pending ? h("div", { class: "meter-row small pending" },
      `Your next question brings ${pending} new line${pending === 1 ? "" : "s"} (about ${tokens(mt!.pendingTokens)} tokens).`) : null,
    window && used / window > 0.8 ? h("div", { class: "meter-row small error-text" }, "This chat is close to the model's limit: start a new chat, or pick a model with a larger context.") : null);
}

function scrollToEnd(force = false) {
  const log = el.log();
  if (!current?.messages.length && !streaming) { log.scrollTop = 0; return; } // the empty state reads from the top
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
}
