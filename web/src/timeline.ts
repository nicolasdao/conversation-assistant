// The timeline as a results strip, drawn from the session's label set: section brackets from its first category, one
// lane per category (options in their colours), one chart line per score (0–4), and marker pins with each marker's
// icon. Without a set (labels off), one lane of plain segments. Low-confidence labels are faded. Clicking a segment or
// marker jumps to the transcript. Positions are percentages of the session length inside a track that is `zoom` times
// the visible width, so zooming only widens the track and the strip scrolls sideways. The strip can be made taller by
// dragging its top edge, and a dotted line follows the pointer with the exact time.
import { clock, h, icon, replace, s } from "./dom.js";
import { labelSetOf, type LabelCategory, type LabelOption, type LabelSet, type Labels, type Segment, type State } from "./state.js";

/** Scores take their colour from their slot (CSS classes): the first is drawn in --heat, the second in --hype. */
export const SCORE_SLOTS = ["score-1", "score-2"] as const;
const LANE_FALLBACK = ["#6a7d98", "#4e5b6c"];

export function optionOf(cat: LabelCategory | undefined, id: string | undefined): LabelOption | undefined {
  return cat && id ? cat.options.find((o) => o.id === id) : undefined;
}

/** An option's name, or its id made readable when the set does not know it. */
export const optionName = (cat: LabelCategory | undefined, id: string) => optionOf(cat, id)?.name ?? id.replace(/_/g, " ");

export function optionColor(cat: LabelCategory | undefined, id: string, lane = 0): string {
  return optionOf(cat, id)?.color ?? LANE_FALLBACK[lane] ?? LANE_FALLBACK[0];
}

/** The legend above the strip: each score's line, then each marker's icon. It scrolls sideways when it does not fit. */
export function renderLegend(el: HTMLElement | null, set: LabelSet | null) {
  if (!set) return replace(el);
  replace(el,
    set.scores.map((sc, i) => h("span", {}, h("span", { class: `ln ${SCORE_SLOTS[i]}` }), sc.name)),
    set.markers.map((m) => h("span", { class: "mk", title: m.name }, icon(m.icon), m.short)));
}

/** The lanes' row heights, shared by the label column and the track, and their labels. */
function lanes(set: LabelSet | null): { rows: string[]; labels: HTMLElement[] } {
  const rows: string[] = ["4px"];
  const labels: HTMLElement[] = [h("span", {})];
  const cats = set?.categories ?? [];
  if (cats.length === 0) {
    rows.push("34px");
    labels.push(h("span", { class: "tl-lbl" }, "Segments"));
  }
  cats.forEach((c, i) => {
    rows.push(i === 0 ? "34px" : "22px");
    labels.push(h("span", { class: "tl-lbl" }, c.name));
  });
  if (set?.scores.length) {
    rows.push("var(--tl-chart)");
    labels.push(h("span", { class: "tl-lbl tl-lbl-chart" }, set.scores.map((x) => x.name).join(" · "), h("i", { class: "scale top" }, "4"), h("i", { class: "scale bottom" }, "0")));
  }
  if (set?.markers.length) {
    rows.push("28px");
    labels.push(h("span", { class: "tl-lbl" }, "Markers"));
  }
  rows.push("18px");
  labels.push(h("span", {}));
  return { rows, labels };
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

// ---------- playback: the playhead and click-to-seek (recordings only) ----------

let playhead: number | null = null;
let onSeek: ((ms: number) => void) | null = null;

/** Where playback is, in session ms (null hides the playhead). While playing, keeps the playhead in view when zoomed. */
export function setPlayhead(ms: number | null, follow = false) {
  playhead = ms;
  const tr = track();
  if (!tr) return;
  let line = document.getElementById("playhead");
  if (ms === null) { line?.remove(); return; }
  if (!line) {
    line = h("div", { id: "playhead", class: "playhead" }, h("span", {}));
    tr.append(line);
  }
  const x = Math.max(0, Math.min(100, (ms / spanMs) * 100));
  line.style.left = `${x}%`;
  line.querySelector("span")!.textContent = clock(ms);
  line.classList.toggle("edge", x > 92);
  const sc = scroller();
  if (follow && sc && zoom > 1) {
    const px = (x / 100) * sc.clientWidth * zoom;
    if (px < sc.scrollLeft || px > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = px - sc.clientWidth * 0.3;
  }
}

/** Lets a click on the timeline (outside segments and markers) move playback there. */
export function setSeekHandler(fn: ((ms: number) => void) | null) {
  onSeek = fn;
  scroller()?.classList.toggle("seekable", !!fn);
}

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
  sc?.addEventListener("click", (e) => {
    if (!onSeek || (e.target as Element).closest(".blk, .pin")) return;
    const x = sc.scrollLeft + e.clientX - sc.getBoundingClientRect().left;
    onSeek(Math.max(0, (x / (sc.clientWidth * zoom)) * spanMs));
  });
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
  const set = labelSetOf(st);
  const labelsOn = !!set;
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

  // the rows follow the set: its categories, a chart if it has scores, pins if it has markers
  const layout = lanes(set);
  const rows = layout.rows.join(" ");
  box.style.gridTemplateRows = rows;
  const labelCol = document.getElementById("tl-labels");
  if (labelCol && labelCol.dataset.rows !== `${rows}|${set?.id ?? ""}|${labelsOn}`) {
    labelCol.dataset.rows = `${rows}|${set?.id ?? ""}|${labelsOn}`;
    labelCol.style.gridTemplateRows = rows;
    replace(labelCol, layout.labels);
  }

  const cats = set?.categories ?? [];
  const scores = set?.scores ?? [];
  const markerDefs = new Map((set?.markers ?? []).map((m) => [m.id, m]));
  const sections = h("div", { class: "lane sections" });
  // without categories, one lane of plain segments to find your way around
  const catLanes = (cats.length ? cats : [null]).map((_, i) => h("div", { class: `lane cat cat-${i + 1}` }));
  const chart = scores.length ? h("div", { class: "lane chart" }, [25, 50, 75].map((t) => h("span", { class: "gridline", style: `top:${t}%` }))) : null;
  const markers = markerDefs.size ? h("div", { class: "lane markers" }) : null;
  const axis = h("div", { class: "lane axis" });

  for (const sec of st.sections) {
    const cat = cats.find((c) => c.id === sec.category);
    if (!cat) continue;
    sections.append(h("span", {
      class: "sect", style: `left:${pct(x(sec.startMs))};width:${pct(x(sec.endMs) - x(sec.startMs))};background:${optionColor(cat, sec.option)}`,
      title: `Section: ${optionName(cat, sec.option)}, ${clock(sec.startMs)}–${clock(sec.endMs)}`,
    }));
  }

  // a 2 px gap between neighbouring segments, as in a results strip
  const gap = (2 / trackPx) * 100;
  const points: [number, number][][] = scores.map(() => []);
  for (const g of segs) {
    const left = x(g.startMs);
    const width = Math.max(0.3 / zoom, x(g.endMs) - left - gap);
    const geo = `left:${pct(left)};width:${pct(width)}`;
    const dim = !opts.matches(g);
    const l = g.labels;
    // jump the transcript there; in a recording, playback moves there too
    const jump = () => { opts.onJump(g.id); onSeek?.(g.startMs); };
    const span = `${clock(g.startMs)}–${clock(g.endMs)}`;
    const plain = !labelsOn; // labels off: a segment is only a stretch of time to jump to
    const labelled = !!l && !l.unlabeled;
    const state = `${dim ? " dim" : ""}${l?.unlabeled ? " unlabeled" : ""}`;
    if (!cats.length) {
      catLanes[0].append(h("button", { class: `blk${state}`, style: geo, title: `${span}${plain ? "" : l?.unlabeled ? " · unlabeled" : ""} · click to jump`, onclick: jump }));
    }
    cats.forEach((cat, i) => {
      const c = l?.choices[cat.id];
      let tip: string;
      if (i === 0) {
        const rest = cats.slice(1).map((o) => (l?.choices[o.id] ? ` · ${optionName(o, l.choices[o.id].choice)}` : "")).join("");
        tip = labelled
          ? `${span} · ${c ? `${optionName(cat, c.choice)} (${Math.round(c.confidence * 100)}%)` : "?"}${rest}${l!.story ? ` · story: ${l!.story}` : ""}${l!.mentions.length ? ` · mentions: ${l!.mentions.join(", ")}` : ""}`
          : `${span} · ${l?.unlabeled ? "unlabeled" : "labelling…"}`;
      } else {
        tip = `${span} · ${c ? `${optionName(cat, c.choice)}${c.faded ? " (low confidence)" : ""}` : `no ${cat.name.toLowerCase()} yet`}`;
      }
      catLanes[i].append(h("button", {
        class: `blk${c?.faded ? " faded" : ""}${state}`, style: `${geo}${c ? `;background:${optionColor(cat, c.choice, i)}` : ""}`,
        title: i === 0 ? `${tip} · click to jump` : tip, onclick: jump, ...(i > 0 ? { tabindex: -1 } : {}),
      }, h("span", { class: "blk-t" }, c ? optionName(cat, c.choice) : i === 0 && l?.unlabeled ? "unlabeled" : "")));
    });

    const mid = x((g.startMs + g.endMs) / 2);
    scores.forEach((sc2, i) => {
      const v = l?.scores[sc2.id];
      if (typeof v === "number") points[i].push([mid, v]);
    });

    const marks = (l?.markers ?? []).filter((m) => markerDefs.has(m));
    marks.forEach((m, i) => {
      const def = markerDefs.get(m)!;
      const offset = (i - (marks.length - 1) / 2) * 28;
      markers?.append(h("button", {
        class: `pin${dim ? " dim" : ""}`, style: `left:calc(${pct(mid)} + ${offset}px)`,
        title: `${def.name} · ${clock(g.startMs)}: click to jump`, "aria-label": `${def.name} at ${clock(g.startMs)}`, onclick: jump,
      }, icon(def.icon)));
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
    catLanes.forEach((lane, i) => lane.append(i === 0
      ? h("span", { class: "blk open", style: geo, title: labelsOn ? "Segment in progress: labelled when it closes" : "Segment in progress" }, wide ? "In progress" : "")
      : h("span", { class: "blk open", style: geo })));
  }

  // paused stretches, hatched across the lanes
  for (const p of st.pauses) {
    const end = p.endMs ?? opts.nowMs;
    const geo = `left:${pct(x(p.startMs))};width:${pct(Math.max(0.2 / zoom, x(end) - x(p.startMs)))}`;
    const tip = `Paused ${clock(p.startMs)}–${p.endMs === null ? "now" : clock(end)}: nothing was heard or transcribed`;
    for (const lane of [...catLanes, chart]) lane?.append(h("span", { class: "pause-band", style: geo, title: tip }));
  }

  // each score on the shared 0–4 scale, coloured by its slot
  const yOf = (v: number) => (1 - v / 4) * 100;
  const line = (pts: [number, number][], cls: string) =>
    pts.length ? s("polyline", { class: cls, points: pts.map(([px, v]) => `${px},${yOf(v)}`).join(" ") }) : null;
  if (chart) {
    chart.append(s("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" }, scores.map((_, i) => line(points[i], SCORE_SLOTS[i]))));
    scores.forEach((sc2, i) => {
      for (const [px, v] of points[i]) chart.append(h("span", { class: `dot ${SCORE_SLOTS[i]}`, style: `left:${pct(px)};top:${pct(yOf(v))}`, title: `${sc2.name} ${v.toFixed(1)}` }));
    });
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
    for (const lane of [...catLanes, chart, markers]) lane?.append(h("span", { class: "nowline", style: `left:${nx}` }));
    axis.append(h("span", { class: "nowtag", style: `left:calc(${nx} + 1px)` }, `${st.session?.status === "running" ? "Now" : "End"} ${clock(opts.nowMs)}`));
  }

  replace(box, sections, catLanes, chart, markers, axis);
  if (playhead !== null) setPlayhead(playhead);
  if (following && sc) sc.scrollLeft = sc.scrollWidth;
  showZoom();
  showHover();
}

// ---------- a still preview of a stretch (Try on a recording) ----------

/**
 * A timeline for a stretch of a recording, drawn with a given set, without zoom, playhead, or clicks: the same lanes,
 * colours, chart, and pins as the strip below the transcript. Used to compare a draft set with a recording's own labels.
 */
export function renderPreview(
  set: LabelSet | null, segments: { id: string; startMs: number; endMs: number }[], labels: Map<string, Labels>, window: { startMs: number; endMs: number },
): HTMLElement {
  const span = Math.max(1, window.endMs - window.startMs);
  const x = (ms: number) => ((ms - window.startMs) / span) * 100;
  const layout = lanes(set);
  const rows = layout.rows.join(" ");
  const cats = set?.categories ?? [];
  const scores = set?.scores ?? [];
  const markerDefs = new Map((set?.markers ?? []).map((m) => [m.id, m]));
  const catLanes = (cats.length ? cats : [null]).map((_, i) => h("div", { class: `lane cat cat-${i + 1}` }));
  const chart = scores.length ? h("div", { class: "lane chart" }, [25, 50, 75].map((t) => h("span", { class: "gridline", style: `top:${t}%` }))) : null;
  const markers = markerDefs.size ? h("div", { class: "lane markers" }) : null;
  const points: [number, number][][] = scores.map(() => []);
  for (const g of segments) {
    const l = labels.get(g.id);
    const geo = `left:${pct(x(g.startMs))};width:${pct(Math.max(0.3, x(g.endMs) - x(g.startMs) - 0.25))}`;
    const tip = `${clock(g.startMs)}–${clock(g.endMs)}`;
    if (!cats.length) catLanes[0].append(h("span", { class: `blk${l?.unlabeled ? " unlabeled" : ""}`, style: geo, title: tip }));
    cats.forEach((cat, i) => {
      const c = l?.choices[cat.id];
      catLanes[i].append(h("span", {
        class: `blk${c?.faded ? " faded" : ""}${l?.unlabeled ? " unlabeled" : ""}`, style: `${geo}${c ? `;background:${optionColor(cat, c.choice, i)}` : ""}`,
        title: `${tip}${c ? ` · ${optionName(cat, c.choice)} (${Math.round(c.confidence * 100)}%)` : l?.unlabeled ? " · no answer" : ""}`,
      }, h("span", { class: "blk-t" }, c ? optionName(cat, c.choice) : "")));
    });
    const mid = x((g.startMs + g.endMs) / 2);
    scores.forEach((sc, i) => { const v = l?.scores[sc.id]; if (typeof v === "number") points[i].push([mid, v]); });
    const marks = (l?.markers ?? []).filter((m) => markerDefs.has(m));
    marks.forEach((m, i) => {
      const def = markerDefs.get(m)!;
      markers?.append(h("span", { class: "pin", style: `left:calc(${pct(mid)} + ${(i - (marks.length - 1) / 2) * 28}px)`, title: `${def.name} · ${tip}` }, icon(def.icon)));
    });
  }
  const yOf = (v: number) => (1 - v / 4) * 100;
  if (chart) {
    chart.append(s("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" },
      points.map((pts, i) => (pts.length ? s("polyline", { class: SCORE_SLOTS[i], points: pts.map(([px, v]) => `${px},${yOf(v)}`).join(" ") }) : null))));
    scores.forEach((sc, i) => { for (const [px, v] of points[i]) chart.append(h("span", { class: `dot ${SCORE_SLOTS[i]}`, style: `left:${pct(px)};top:${pct(yOf(v))}`, title: `${sc.name} ${v.toFixed(1)}` })); });
  }
  const axis = h("div", { class: "lane axis" }, [0, 0.25, 0.5, 0.75].map((f) => h("span", { class: `tick${f === 0 ? " first" : ""}`, style: `left:${pct(f * 100)}` }, clock(window.startMs + f * span))));
  return h("div", { class: "tl-body preview" },
    h("div", { class: "tl-labels", style: `grid-template-rows:${rows}` }, layout.labels),
    h("div", { class: "tl-track", style: `grid-template-rows:${rows}` }, h("div", { class: "lane sections" }), catLanes, chart, markers, axis));
}
