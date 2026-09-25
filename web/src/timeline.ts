// The timeline as a results strip: section brackets, a subject lane (AI subjects as shades of one colour), a mode lane,
// heat and hype lines (inline SVG), and marker pins. Low-confidence labels are faded. Clicking a segment or marker
// jumps to the transcript. Positions are percentages of the session length inside a track that is `zoom` times the
// visible width, so zooming only widens the track and the strip scrolls sideways. The strip can be made taller by
// dragging its top edge, and a dotted line follows the pointer with the exact time.
import { clock, glyph, h, pretty, replace, s } from "./dom.js";
import type { Segment, State } from "./state.js";

export const SUBJECT_COLORS: Record<string, string> = {
  ai_models: "#3f7df0", ai_tools: "#6fa0ff", ai_industry: "#2a58c9",
  tech: "#1fa89a", marketing: "#d0892a", personal_life: "#d9588a", other_topics: "#8b6fd6", the_show: "#6f7a8c",
};
export const MODE_COLORS: Record<string, string> = {
  news: "#3e8ee0", analysis: "#9a7fe0", personal_story: "#d9679a", explainer: "#2fb39c", banter: "#d99a2b", transition: "#6a7d98", other: "#4e5b6c",
};
/** Marker ids map to drawn glyphs (`#g-<id>` in index.html). */
export const MARKERS: Record<string, { label: string; short: string }> = {
  disagreement: { label: "Disagreement", short: "Disagree" },
  hot_take: { label: "Hot take", short: "Hot take" },
  prediction: { label: "Prediction", short: "Prediction" },
  recommendation: { label: "Recommendation", short: "Recommend" },
  clip_worthy: { label: "Clip-worthy", short: "Clip" },
  humour: { label: "Humour", short: "Humour" },
};

export function renderLegend(el: HTMLElement | null) {
  replace(el,
    h("span", {}, h("span", { class: "ln heat" }), "Heat"),
    h("span", {}, h("span", { class: "ln hype" }), "Hype"),
    Object.entries(MARKERS).map(([k, m]) => h("span", { class: "mk" }, glyph(k), m.short)));
}

const pct = (n: number) => `${Math.max(0, Math.min(100, n)).toFixed(4)}%`;

// ---------- zoom, scroll, hover, resize ----------

/** How many times the visible width the track is: 1 shows the whole session. */
let zoom = 1;
/** The session length the track was last drawn for. */
let spanMs = 60_000;
/** The closest zoom shows about 30 s across the strip. */
const MIN_VISIBLE_MS = 30_000;
const maxZoom = () => Math.max(1, spanMs / MIN_VISIBLE_MS);

const scroller = () => document.getElementById("tl-scroll") as HTMLElement | null;
const track = () => document.getElementById("timeline") as HTMLElement | null;

/** Zooms to `z`, keeping the time under `anchorX` (px from the strip's left edge; default its centre) in place. */
function setZoom(z: number, anchorX?: number) {
  const sc = scroller();
  const tr = track();
  if (!sc || !tr) return;
  const next = Math.min(maxZoom(), Math.max(1, z));
  const ax = anchorX ?? sc.clientWidth / 2;
  const at = (sc.scrollLeft + ax) / (sc.clientWidth * zoom);
  zoom = next;
  tr.style.width = `${zoom * 100}%`;
  sc.scrollLeft = at * sc.clientWidth * zoom - ax;
  showZoom();
  redraw();
}

function showZoom() {
  const label = document.getElementById("zoom-level");
  if (label) label.textContent = zoom <= 1.001 ? "Whole show" : `${clock(spanMs / zoom)} view`;
  const out = document.getElementById("zoom-out") as HTMLButtonElement | null;
  const inn = document.getElementById("zoom-in") as HTMLButtonElement | null;
  if (out) out.disabled = zoom <= 1.001;
  if (inn) inn.disabled = zoom >= maxZoom() - 0.001;
}

let hoverX: number | null = null; // px from the strip's left edge while the pointer is over it

function showHover() {
  const sc = scroller();
  const line = document.getElementById("tl-hover");
  if (!sc || !line) return;
  if (hoverX === null) { line.hidden = true; return; }
  const x = sc.scrollLeft + hoverX;
  const width = sc.clientWidth * zoom;
  line.hidden = false;
  line.style.left = `${x}px`;
  line.classList.toggle("edge-left", hoverX < 30);
  line.classList.toggle("edge-right", sc.clientWidth - hoverX < 30);
  line.querySelector("span")!.textContent = clock((x / width) * spanMs);
}

const CHART_DEFAULT = 100;
const CHART_MIN = 60;
const STORE_KEY = "pa.timelineChartPx";

function setChartHeight(px: number) {
  const tl = document.getElementById("tl");
  if (!tl) return;
  const current = parseFloat(getComputedStyle(tl).getPropertyValue("--tl-chart")) || CHART_DEFAULT;
  // keep at least ~160 px for the transcript and fact-checks
  const max = Math.max(CHART_MIN, window.innerHeight - 60 - 160 - (tl.offsetHeight - current));
  const next = Math.round(Math.min(max, Math.max(CHART_MIN, px)));
  tl.style.setProperty("--tl-chart", `${next}px`);
  document.getElementById("tl-grip")?.setAttribute("aria-valuenow", String(next));
  try { localStorage.setItem(STORE_KEY, String(next)); } catch { /* storage may be unavailable */ }
}

let redraw: () => void = () => {};

/** Wires the zoom buttons, ⌘/Ctrl + scroll zoom, sideways scrolling, the hover line, and the resize grip. */
export function bindTimeline(onRedraw: () => void) {
  redraw = onRedraw;
  const sc = scroller();
  const grip = document.getElementById("tl-grip");
  document.getElementById("zoom-in")?.addEventListener("click", () => setZoom(zoom * 2));
  document.getElementById("zoom-out")?.addEventListener("click", () => setZoom(zoom / 2));
  document.getElementById("zoom-fit")?.addEventListener("click", () => setZoom(1));
  showZoom();

  sc?.addEventListener("wheel", (e) => {
    const rect = sc.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { // ⌘/Ctrl + scroll, or a trackpad pinch
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left);
    } else if (zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { // a plain wheel scrolls through time
      e.preventDefault();
      sc.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  sc?.addEventListener("pointermove", (e) => { hoverX = e.clientX - sc.getBoundingClientRect().left; showHover(); });
  sc?.addEventListener("pointerleave", () => { hoverX = null; showHover(); });
  sc?.addEventListener("scroll", showHover);

  try {
    const saved = Number(localStorage.getItem(STORE_KEY));
    if (saved) setChartHeight(saved);
  } catch { /* storage may be unavailable */ }
  if (!grip) return;
  grip.setAttribute("aria-valuemin", String(CHART_MIN));
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const tl = document.getElementById("tl")!;
    const startY = e.clientY;
    const start = parseFloat(getComputedStyle(tl).getPropertyValue("--tl-chart")) || CHART_DEFAULT;
    grip.classList.add("dragging");
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => setChartHeight(start + (startY - ev.clientY));
    const up = () => {
      grip.classList.remove("dragging");
      document.body.classList.remove("resizing");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => setChartHeight(CHART_DEFAULT));
  grip.addEventListener("keydown", (e) => {
    const tl = document.getElementById("tl")!;
    const cur = parseFloat(getComputedStyle(tl).getPropertyValue("--tl-chart")) || CHART_DEFAULT;
    if (e.key === "ArrowUp") { e.preventDefault(); setChartHeight(cur + 20); }
    if (e.key === "ArrowDown") { e.preventDefault(); setChartHeight(cur - 20); }
  });
}

// ---------- drawing ----------

const TICK_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

export function renderTimeline(
  box: HTMLElement, st: State, opts: { matches: (seg: Segment) => boolean; onJump: (segmentId: string) => void; nowMs: number },
) {
  const segs = [...st.segments.values()].sort((a, b) => a.startMs - b.startMs);
  const lastUtt = Math.max(0, ...[...st.utterances.values()].map((u) => u.endMs));
  const endMs = Math.max(60_000, opts.nowMs, lastUtt, ...segs.map((g) => g.endMs));
  const x = (ms: number) => (ms / endMs) * 100;
  const sc = scroller();
  // while live and scrolled to the newest moment, stay there as the session grows
  const following = !!sc && zoom > 1 && sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 4;
  spanMs = endMs;
  if (zoom > maxZoom()) zoom = maxZoom();
  box.style.width = `${zoom * 100}%`;
  const trackPx = (sc?.clientWidth ?? 1000) * zoom;

  const sections = h("div", { class: "lane sections" });
  const subject = h("div", { class: "lane subject" });
  const mode = h("div", { class: "lane mode" });
  const chart = h("div", { class: "lane chart" }, [25, 50, 75].map((t) => h("span", { class: "gridline", style: `top:${t}%` })));
  const markers = h("div", { class: "lane markers" });
  const axis = h("div", { class: "lane axis" });

  for (const sec of st.sections) {
    sections.append(h("span", {
      class: "sect", style: `left:${pct(x(sec.startMs))};width:${pct(x(sec.endMs) - x(sec.startMs))};background:${SUBJECT_COLORS[sec.subject] ?? "#6a7d98"}`,
      title: `Section: ${pretty(sec.subject)}, ${clock(sec.startMs)}–${clock(sec.endMs)}`,
    }));
  }

  // a 2 px gap between neighbouring segments, as in a results strip
  const gap = (2 / trackPx) * 100;
  const heat: [number, number][] = [];
  const hype: [number, number][] = [];
  for (const g of segs) {
    const left = x(g.startMs);
    const width = Math.max(0.3 / zoom, x(g.endMs) - left - gap);
    const geo = `left:${pct(left)};width:${pct(width)}`;
    const dim = !opts.matches(g);
    const l = g.labels;
    const subj = l?.choices.subject;
    const md = l?.choices.mode;
    const jump = () => opts.onJump(g.id);
    const span = `${clock(g.startMs)}–${clock(g.endMs)}`;
    const tip = l && !l.unlabeled
      ? `${span} · ${pretty(subj?.choice ?? "?")} (${Math.round((subj?.confidence ?? 0) * 100)}%) · ${pretty(md?.choice ?? "?")}${l.story ? ` · story: ${l.story}` : ""}${l.mentions.length ? ` · mentions: ${l.mentions.join(", ")}` : ""}`
      : `${span} · ${l?.unlabeled ? "unlabeled" : "labelling…"}`;
    const state = `${dim ? " dim" : ""}${l?.unlabeled ? " unlabeled" : ""}`;
    subject.append(h("button", {
      class: `blk${subj?.faded ? " faded" : ""}${state}`, style: `${geo}${subj ? `;background:${SUBJECT_COLORS[subj.choice] ?? "#6a7d98"}` : ""}`,
      title: `${tip} · click to jump`, onclick: jump,
    }, h("span", { class: "blk-t" }, subj ? pretty(subj.choice) : l?.unlabeled ? "unlabeled" : "")));
    mode.append(h("button", {
      class: `blk${md?.faded ? " faded" : ""}${state}`, style: `${geo}${md ? `;background:${MODE_COLORS[md.choice] ?? "#4e5b6c"}` : ""}`,
      title: `${span} · ${md ? `${pretty(md.choice)}${md.faded ? " (low confidence)" : ""}` : "no mode yet"}`, onclick: jump, tabindex: -1,
    }, h("span", { class: "blk-t" }, md ? pretty(md.choice) : "")));

    const mid = x((g.startMs + g.endMs) / 2);
    if (typeof l?.scores.heat === "number") heat.push([mid, l.scores.heat]);
    if (typeof l?.scores.hype === "number") hype.push([mid, l.scores.hype]);

    const marks = (l?.markers ?? []).filter((m) => MARKERS[m]);
    marks.forEach((m, i) => {
      const offset = (i - (marks.length - 1) / 2) * 28;
      markers.append(h("button", {
        class: `pin${dim ? " dim" : ""}`, style: `left:calc(${pct(mid)} + ${offset}px)`,
        title: `${MARKERS[m].label} · ${clock(g.startMs)}: click to jump`, "aria-label": `${MARKERS[m].label} at ${clock(g.startMs)}`, onclick: jump,
      }, glyph(m)));
    });
  }

  // the open segment: utterances not yet in a closed segment, shown as in progress
  const closed = new Set(segs.flatMap((g) => g.utteranceIds));
  const open = [...st.utterances.values()].filter((u) => !closed.has(u.id));
  if (open.length > 0) {
    const start = Math.min(...open.map((u) => u.startMs));
    const end = Math.max(...open.map((u) => u.endMs), st.session?.status === "running" ? opts.nowMs : 0);
    const geo = `left:${pct(x(start))};width:${pct(Math.max(0.4 / zoom, x(end) - x(start)))}`;
    const wide = ((end - start) / endMs) * trackPx > 90;
    subject.append(h("span", { class: "blk open", style: geo, title: "Segment in progress: labelled when it closes" }, wide ? "In progress" : ""));
    mode.append(h("span", { class: "blk open", style: geo }));
  }

  // paused stretches, hatched across the lanes
  for (const p of st.pauses) {
    const end = p.endMs ?? opts.nowMs;
    const geo = `left:${pct(x(p.startMs))};width:${pct(Math.max(0.2 / zoom, x(end) - x(p.startMs)))}`;
    const tip = `Paused ${clock(p.startMs)}–${p.endMs === null ? "now" : clock(end)}: nothing was heard or transcribed`;
    for (const lane of [subject, mode, chart]) lane.append(h("span", { class: "pause-band", style: geo, title: tip }));
  }

  // heat and hype on a 0–4 scale
  const yOf = (v: number) => (1 - v / 4) * 100;
  const line = (pts: [number, number][], cls: string) =>
    pts.length ? s("polyline", { class: cls, points: pts.map(([px, v]) => `${px},${yOf(v)}`).join(" ") }) : null;
  chart.append(s("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" }, line(heat, "heat"), line(hype, "hype")));
  for (const [cls, pts] of [["heat", heat], ["hype", hype]] as const) {
    for (const [px, v] of pts) chart.append(h("span", { class: `dot ${cls}`, style: `left:${pct(px)};top:${pct(yOf(v))}`, title: `${cls === "heat" ? "Heat" : "Hype"} ${v.toFixed(1)}` }));
  }

  // axis: ticks at least ~80 px apart at the current zoom, and the now line
  const pxPerMs = trackPx / endMs;
  const step = TICK_STEPS.find((t) => t * pxPerMs >= 80) ?? TICK_STEPS.at(-1)!;
  for (let t = 0; t <= endMs; t += step) {
    if (t > 0 && (endMs - t) * pxPerMs < 60) break; // leave room for the now tag
    axis.append(h("span", { class: `tick${t === 0 ? " first" : ""}`, style: `left:${pct(x(t))}` }, clock(t)));
  }
  if (opts.nowMs > 0) {
    const nx = pct(x(opts.nowMs));
    for (const lane of [subject, mode, chart, markers]) lane.append(h("span", { class: "nowline", style: `left:${nx}` }));
    axis.append(h("span", { class: "nowtag", style: `left:calc(${nx} + 1px)` }, `${st.session?.status === "running" ? "Now" : "End"} ${clock(opts.nowMs)}`));
  }

  replace(box, sections, subject, mode, chart, markers, axis);
  if (following && sc) sc.scrollLeft = sc.scrollWidth;
  showZoom();
  showHover();
}
