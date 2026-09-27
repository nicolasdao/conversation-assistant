// The app, once the API keys are set (main.ts): load GET /api/state, then follow GET /api/events. Rendering is batched per animation frame.
import { api } from "./api.js";
import { $ } from "./dom.js";
import {
  bindControls, bindSessionName, bindSplit, checkEngine, jumpToSegment, setTimeClick, toast, loadDevices, renderClaims, renderClock, renderCost, renderErrors, renderFilters, renderHealth, renderLabels,
  renderMenu, renderRecordings, renderS1, renderSession, renderSpeakers, renderStats, renderTranscript, segmentMatches,
} from "./panels.js";
import { bindTimeline, renderLegend, renderTimeline } from "./timeline.js";
import { renderThinking } from "./calls.js";
import { bindChat, chatOpened, openChat, renderChat } from "./chat.js";
import { bindBespoke } from "./ui.js";
import { bindTransfer, renderTransferButtons } from "./transfer.js";
import { renderKeys } from "./keys.js";
import { bindPlayer, refreshFollow, seek, setPositionListener, syncPlayer } from "./player.js";
import { panelName, PANELS, readRoute, setRoute, tabName, TABS, type Route } from "./router.js";
import { addCall, applyEvent, emptyState, fromSnapshot, type CallRow, type Dirty, type State } from "./state.js";

let st: State = emptyState();
const dirty: Dirty = new Set();
let frame = 0;
let sessionStartWall = 0;

function nowMs(): number {
  if (!st.session || st.session.status !== "running" || !sessionStartWall) {
    return Math.max(0, ...[...st.utterances.values()].map((u) => u.endMs));
  }
  return Date.now() - sessionStartWall;
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const all = dirty.has("session");
    if (all || dirty.has("session")) {
      renderSession(st);
      renderTransferButtons(st);
      syncPlayer(st);
      followState();
      if (isOpen("dlg-recordings")) void renderRecordings(st);
    }
    if (all || dirty.has("health")) { renderHealth(st); renderClock(nowMs()); }
    if (all || dirty.has("transcript") || dirty.has("speakers")) { renderTranscript(st); refreshFollow(); }
    if (all || dirty.has("timeline") || dirty.has("transcript")) drawTimeline();
    if (all || dirty.has("speakers") || dirty.has("stats")) { renderSpeakers(st); renderFilters(st, onFilter); }
    if (all || dirty.has("claims")) renderClaims(st);
    if (all || dirty.has("s1")) void renderS1(st);
    if (all || dirty.has("labels")) renderLabels(st);
    if (all || dirty.has("cost")) renderCost(st);
    if (all || dirty.has("stats")) renderStats(st);
    if (all || dirty.has("errors")) renderErrors(st);
    if (all || dirty.has("calls") || dirty.has("claims")) renderThinking(st);
    if (all || dirty.has("session") || dirty.has("transcript")) renderChat(st);
    renderMenu(st);
    dirty.clear();
  });
}

function markAll() {
  for (const k of ["session", "health", "transcript", "timeline", "claims", "speakers", "s1", "labels", "cost", "stats", "errors", "calls"] as const) dirty.add(k);
  schedule();
}

function drawTimeline() {
  const box = $("#timeline");
  if (box) renderTimeline(box, st, { matches: segmentMatches, onJump: jumpToSegment, nowMs: nowMs() });
}

const isOpen = (id: string) => !!$<HTMLDialogElement>(`#${id}`)?.open;

/** Renders a settings dialog's content just before it opens, and puts it in the URL. */
function onOpen(id: string) {
  setRoute({ panel: panelName(id) });
  if (id === "dlg-recordings") void renderRecordings(st);
  if (id === "dlg-labels") renderLabels(st);
  if (id === "dlg-chat") chatOpened();
  if (id === "dlg-keys") void renderKeys((m) => toast(m, "ok"));
}

function onFilter() {
  dirty.add("transcript").add("timeline").add("speakers");
  schedule();
}

async function reload() {
  try {
    st = fromSnapshot(await api.state());
    sessionStartWall = st.session?.startedAt ? Date.parse(st.session.startedAt) : 0;
  } catch {
    st = emptyState();
  }
  markAll();
  void loadCalls(st);
}

/** The calls made before this page connected (or all of an opened recording's); later ones arrive live. */
async function loadCalls(target: State) {
  if (!target.session) return;
  try {
    const [s1, s2] = await Promise.all([api.calls("s1", 3000), api.calls("s2", 200)]);
    if (target !== st) return; // a newer session took over meanwhile
    const rows = [...(s1.rows as CallRow[]), ...(s2.rows as CallRow[])].sort((a, b) => a.at.localeCompare(b.at));
    for (const r of rows) addCall(st, r);
    for (const list of [st.calls.s1, st.calls.s2]) list.sort((a, b) => a.at.localeCompare(b.at));
    st.calls.models = { s1: s1.models.s1, s2: s1.models.s2 };
    dirty.add("calls");
    schedule();
  } catch { /* an older server has no /api/calls */ }
}

let showPane: (paneId: string) => void = () => {};

/**
 * A time cited in a chat reply: a recording plays from there (the chat stays open, to read on while listening);
 * on air, the chat closes and the transcript scrolls to that line.
 */
function jumpToTime(ms: number) {
  if (st.session?.status === "archived") return seek(ms);
  $<HTMLDialogElement>("#dlg-chat")?.close();
  const lines = [...document.querySelectorAll<HTMLElement>("#transcript .utt[data-start]")];
  const line = lines.filter((u) => Number(u.dataset.start) <= ms + 999).at(-1) ?? lines[0];
  if (!line) return;
  line.scrollIntoView({ behavior: "smooth", block: "center" });
  line.classList.remove("flash");
  void line.offsetWidth;
  line.classList.add("flash");
}

/** Right column tabs: Fact-check, Fast · slow thinking, Jev log. */
function bindTabs() {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tabs .tab")];
  showPane = (paneId) => { const t = tabs.find((x) => x.dataset.pane === paneId); if (t) show(t); };
  const show = (tab: HTMLButtonElement) => {
    setRoute({ tab: tabName(tab.dataset.pane!) });
    for (const t of tabs) {
      t.setAttribute("aria-selected", String(t === tab));
      $(`#${t.dataset.pane}`)!.hidden = t !== tab;
    }
    $("#tally")!.hidden = tab.dataset.pane !== "pane-fc";
    try { localStorage.setItem("pa.rightTab", tab.dataset.pane!); } catch { /* storage may be unavailable */ }
    dirty.add("calls");
    schedule();
  };
  for (const t of tabs) t.addEventListener("click", () => show(t));
  // the URL's tab wins over the one remembered in the browser
  const fromUrl = readRoute().tab;
  let saved: HTMLButtonElement | undefined;
  try { saved = tabs.find((t) => t.dataset.pane === (fromUrl ? TABS[fromUrl] : localStorage.getItem("pa.rightTab"))); } catch { /* storage may be unavailable */ }
  if (saved) show(saved);
}

// ---------- the URL (see router.ts) ----------

/** False until the URL opened the page has been applied, and while Back or Forward is being applied. */
let routeReady = false;

/** The URL follows what is on screen: a recording opened or left (history entries), or a session ending as one. */
function followState() {
  if (!routeReady) return;
  const recording = st.session?.status === "archived" ? st.session.id : null;
  if (readRoute().recording !== recording) setRoute({ recording }, true);
}

/** Makes the screen match a URL: on load, or after Back and Forward. */
async function applyRoute(r: Route, why: "load" | "history") {
  routeReady = false;
  try {
    const cur = st.session;
    const onAir = !!cur && (cur.status === "running" || cur.status === "ending");
    if (r.recording && cur?.id !== r.recording) {
      if (onAir) {
        toast("A session is on air, so it is shown instead of the recording.");
        setRoute({ recording: null });
      } else {
        try {
          await api.openSession(r.recording);
          await reload();
        } catch (e) {
          toast(`Recording ${r.recording} could not be opened: ${e instanceof Error ? e.message : String(e)}`);
          setRoute({ recording: null });
        }
      }
    } else if (!r.recording && cur?.status === "archived") {
      // Back to "/" leaves the recording; loading "/" while one is shown makes the URL say so instead
      if (why === "history") { await api.closeView(); await reload(); }
      else setRoute({ recording: cur.id });
    }
    if (r.tab) showPane(TABS[r.tab]!);
    else if (why === "history") showPane("pane-fc");
    for (const [name, id] of Object.entries(PANELS)) {
      const d = $<HTMLDialogElement>(`#${id}`);
      if (!d) continue;
      if (name === r.panel && !d.open) { onOpen(id); d.showModal(); }
      else if (name !== r.panel && d.open) d.close();
    }
    if (r.recording && r.t !== null && st.session?.status === "archived") {
      syncPlayer(st); // make sure the audio exists before seeking
      seek(r.t);
    }
  } finally {
    routeReady = true;
    followState();
  }
}

function connect() {
  const es = new EventSource("/api/events");
  let reloading: Promise<void> | null = null;
  es.onmessage = () => {};
  const handle = async (ev: MessageEvent) => {
    const e = JSON.parse(ev.data);
    if (reloading) await reloading;
    if (applyEvent(st, e.type, e.data, e.at, dirty) === "reset") {
      reloading = reload();
      await reloading;
      reloading = null;
      return;
    }
    if (e.type === "session.started" && e.data.startedAt) sessionStartWall = Date.parse(e.data.startedAt);
    if (e.type === "s1.version") void api.state().then((snap) => { st.s1.versions = snap?.s1?.versions ?? st.s1.versions; dirty.add("s1"); schedule(); });
    schedule();
  };
  for (const t of ["session.started", "session.ended", "session.paused", "session.resumed", "call.started", "call", "health", "utterance", "utterance.partial", "speaker.created", "speaker.updated", "speaker.merged",
    "segment.closed", "segment.labels", "section.updated", "claim.flagged", "claim.duplicate", "claim.repeat", "claim.researching",
    "claim.verdict", "claim.dropped", "claim.disputed", "audit", "s1.version", "s1.memory", "cost", "budget.exhausted", "stats", "error"]) {
    es.addEventListener(t, (ev) => void handle(ev as MessageEvent));
  }
  es.onerror = () => {
    $("#conn")?.classList.add("down");
  };
  es.onopen = () => {
    $("#conn")?.classList.remove("down");
  };
}

bindControls(onOpen, () => void reload());
bindSessionName(() => st, () => { dirty.add("session"); schedule(); });
bindSplit();
bindPlayer();
setTimeClick(seek);
setPositionListener((ms) => { if (st.session?.status === "archived") setRoute({ t: ms }); });
// a settings window closing takes `?panel=` out of the URL
for (const id of Object.values(PANELS)) $<HTMLDialogElement>(`#${id}`)?.addEventListener("close", () => { if (readRoute().panel === panelName(id)) setRoute({ panel: null }); });
window.addEventListener("popstate", () => void applyRoute(readRoute(), "history"));
bindBespoke();
bindTransfer(() => st);
bindChat({ onTime: jumpToTime });
$("#chat-btn")?.addEventListener("click", () => openChat());
bindTabs();
void checkEngine();
setInterval(() => void checkEngine(), 15_000);
bindTimeline(() => { dirty.add("timeline"); schedule(); });
renderLegend($("#legend"));
void loadDevices();
await reload();
await applyRoute(readRoute(), "load");
connect();
window.addEventListener("resize", () => { dirty.add("timeline"); schedule(); });
setInterval(() => {
  dirty.add("health").add("timeline");
  // a start whose finished call never arrived (a dropped connection) must not leave a system "thinking" forever
  for (const [sys, limit] of [["s1", 30_000], ["s2", 120_000]] as const) {
    if (st.calls.active[sys] > 0 && Date.now() - st.calls.lastStart[sys] > limit) { st.calls.active[sys] = 0; dirty.add("calls"); }
  }
  schedule();
}, 1000);
