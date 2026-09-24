// Boot: load GET /api/state, then follow GET /api/events. Rendering is batched per animation frame.
import { api } from "./api.js";
import { $ } from "./dom.js";
import {
  bindControls, jumpToSegment, loadDevices, renderClaims, renderCost, renderErrors, renderFilters, renderHealth, renderLabels,
  renderS1, renderSession, renderSpeakers, renderStats, renderTranscript, segmentMatches,
} from "./panels.js";
import { renderTimeline } from "./timeline.js";
import { applyEvent, emptyState, fromSnapshot, type Dirty, type State } from "./state.js";

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
    if (all || dirty.has("session")) renderSession(st);
    if (all || dirty.has("health")) renderHealth(st);
    if (all || dirty.has("transcript") || dirty.has("speakers")) renderTranscript(st);
    if (all || dirty.has("timeline") || dirty.has("transcript")) drawTimeline();
    if (all || dirty.has("speakers") || dirty.has("stats")) { renderSpeakers(st); renderFilters(st, onFilter); }
    if (all || dirty.has("claims")) renderClaims(st);
    if (all || dirty.has("s1")) void renderS1(st);
    if (all || dirty.has("labels")) renderLabels(st);
    if (all || dirty.has("cost")) renderCost(st);
    if (all || dirty.has("stats")) renderStats(st);
    if (all || dirty.has("errors")) renderErrors(st);
    dirty.clear();
  });
}

function markAll() {
  for (const k of ["session", "health", "transcript", "timeline", "claims", "speakers", "s1", "labels", "cost", "stats", "errors"] as const) dirty.add(k);
  schedule();
}

function drawTimeline() {
  const svg = $<SVGSVGElement>("#timeline");
  if (svg) renderTimeline(svg, st, { matches: segmentMatches, onJump: jumpToSegment, nowMs: nowMs() });
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
  for (const t of ["session.started", "session.ended", "health", "utterance", "speaker.created", "speaker.updated", "speaker.merged",
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

function tabs() {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
      document.querySelectorAll<HTMLElement>(".tab").forEach((t) => { t.hidden = t.id !== b.dataset.tab; });
      if (b.dataset.tab === "tab-labels") renderLabels(st);
    });
  });
}

bindControls();
tabs();
void loadDevices();
await reload();
connect();
window.addEventListener("resize", () => { dirty.add("timeline"); schedule(); });
setInterval(() => { dirty.add("health").add("timeline"); schedule(); }, 1000);
