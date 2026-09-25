// Boot: load GET /api/state, then follow GET /api/events. Rendering is batched per animation frame.
import { api } from "./api.js";
import { $ } from "./dom.js";
import {
  bindControls, bindSessionName, bindSplit, checkEngine, jumpToSegment, loadDevices, renderClaims, renderClock, renderCost, renderErrors, renderFilters, renderHealth, renderLabels,
  renderMenu, renderRecordings, renderS1, renderSession, renderSpeakers, renderStats, renderTranscript, segmentMatches,
} from "./panels.js";
import { bindTimeline, renderLegend, renderTimeline } from "./timeline.js";
import { renderThinking } from "./calls.js";
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
      if (isOpen("dlg-recordings")) void renderRecordings(st);
    }
    if (all || dirty.has("health")) { renderHealth(st); renderClock(nowMs()); }
    if (all || dirty.has("transcript") || dirty.has("speakers")) renderTranscript(st);
    if (all || dirty.has("timeline") || dirty.has("transcript")) drawTimeline();
    if (all || dirty.has("speakers") || dirty.has("stats")) { renderSpeakers(st); renderFilters(st, onFilter); }
    if (all || dirty.has("claims")) renderClaims(st);
    if (all || dirty.has("s1")) void renderS1(st);
    if (all || dirty.has("labels")) renderLabels(st);
    if (all || dirty.has("cost")) renderCost(st);
    if (all || dirty.has("stats")) renderStats(st);
    if (all || dirty.has("errors")) renderErrors(st);
    if (all || dirty.has("calls") || dirty.has("claims")) renderThinking(st);
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

/** Renders a settings dialog's content just before it opens. */
function onOpen(id: string) {
  if (id === "dlg-recordings") void renderRecordings(st);
  if (id === "dlg-labels") renderLabels(st);
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
    const [s1, s2] = await Promise.all([api.calls("s1", 1000), api.calls("s2", 200)]);
    if (target !== st) return; // a newer session took over meanwhile
    const rows = [...(s1.rows as CallRow[]), ...(s2.rows as CallRow[])].sort((a, b) => a.at.localeCompare(b.at));
    for (const r of rows) addCall(st, r);
    for (const list of [st.calls.s1, st.calls.s2]) list.sort((a, b) => a.at.localeCompare(b.at));
    st.calls.models = { s1: s1.models.s1, s2: s1.models.s2 };
    dirty.add("calls");
    schedule();
  } catch { /* an older server has no /api/calls */ }
}

/** Right column tabs: Fact-check, Fast · slow thinking, Jev log. */
function bindTabs() {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tabs .tab")];
  const show = (tab: HTMLButtonElement) => {
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
  try {
    const saved = tabs.find((t) => t.dataset.pane === localStorage.getItem("pa.rightTab"));
    if (saved) show(saved);
  } catch { /* storage may be unavailable */ }
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
bindTabs();
void checkEngine();
setInterval(() => void checkEngine(), 15_000);
bindTimeline(() => { dirty.add("timeline"); schedule(); });
renderLegend($("#legend"));
void loadDevices();
await reload();
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
