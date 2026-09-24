// The timeline as inline SVG: a subject lane (AI subjects as shades of one lane), a mode lane, heat and hype lines,
// and markers. Low-confidence labels are faded. Clicking a segment or marker jumps to the transcript.
import { clock, pretty, s } from "./dom.js";
import type { Segment, State } from "./state.js";

export const SUBJECT_COLORS: Record<string, string> = {
  ai_models: "#4f86f7", ai_tools: "#82aefc", ai_industry: "#2d5fd0",
  tech: "#2bb3a3", marketing: "#e0a33a", personal_life: "#d8638b", other_topics: "#9a7fd1", the_show: "#8a8f98",
};
export const MODE_COLORS: Record<string, string> = {
  news: "#4c9be8", analysis: "#a58be0", personal_story: "#e67aa0", explainer: "#48c1a8", banter: "#f0b14a", transition: "#7f8792", other: "#5d636b",
};
export const MARKERS: Record<string, { icon: string; label: string }> = {
  disagreement: { icon: "⚡", label: "Disagreement" },
  humour: { icon: "😄", label: "Humour" },
  hot_take: { icon: "🔥", label: "Hot take" },
  prediction: { icon: "🔮", label: "Prediction" },
  recommendation: { icon: "👍", label: "Recommendation" },
  clip_worthy: { icon: "✂️", label: "Clip-worthy" },
};

const GUTTER = 84;
const ROWS = { subject: [14, 30], mode: [50, 20], chart: [78, 64], markers: [150, 26], axis: 190 } as const;

export function renderTimeline(
  svg: SVGSVGElement, st: State, opts: { matches: (seg: Segment) => boolean; onJump: (segmentId: string) => void; nowMs: number },
) {
  const width = Math.max(600, svg.clientWidth || svg.parentElement?.clientWidth || 900);
  const height = ROWS.axis + 18;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", String(height));
  const segs = [...st.segments.values()].sort((a, b) => a.startMs - b.startMs);
  const lastUtt = Math.max(0, ...[...st.utterances.values()].map((u) => u.endMs));
  const endMs = Math.max(60_000, opts.nowMs, lastUtt, ...segs.map((g) => g.endMs));
  const plotW = width - GUTTER - 12;
  const x = (ms: number) => GUTTER + (ms / endMs) * plotW;
  const nodes: SVGElement[] = [];

  // row labels
  const rowLabel = (text: string, y: number) => s("text", { x: 8, y, class: "tl-rowlabel" }, text);
  nodes.push(rowLabel("subject", ROWS.subject[0] + 20), rowLabel("mode", ROWS.mode[0] + 14), rowLabel("heat · hype", ROWS.chart[0] + 36), rowLabel("markers", ROWS.markers[0] + 18));

  // chart frame
  const [cy, ch] = ROWS.chart;
  nodes.push(s("rect", { x: GUTTER, y: cy, width: plotW, height: ch, class: "tl-chartbg" }));
  for (let lvl = 1; lvl < 4; lvl++) nodes.push(s("line", { x1: GUTTER, x2: GUTTER + plotW, y1: cy + ch - (lvl / 4) * ch, y2: cy + ch - (lvl / 4) * ch, class: "tl-grid" }));

  const heat: string[] = [];
  const hype: string[] = [];
  for (const g of segs) {
    const x0 = x(g.startMs);
    const w = Math.max(2, x(g.endMs) - x0 - 1);
    const dim = !opts.matches(g);
    const l = g.labels;
    const jump = () => opts.onJump(g.id);
    const group = s("g", { class: `tl-seg${dim ? " dim" : ""}`, onclick: jump });
    const subj = l?.choices.subject;
    const mode = l?.choices.mode;
    const tip = l && !l.unlabeled
      ? `${clock(g.startMs)}–${clock(g.endMs)} · ${pretty(subj?.choice ?? "?")} (${Math.round((subj?.confidence ?? 0) * 100)}%) · ${pretty(mode?.choice ?? "?")}${l.story ? ` · story: ${l.story}` : ""}${l.mentions.length ? ` · mentions: ${l.mentions.join(", ")}` : ""}`
      : `${clock(g.startMs)}–${clock(g.endMs)} · ${l?.unlabeled ? "unlabeled" : "labelling…"}`;
    group.append(s("title", {}, tip));
    group.append(s("rect", {
      x: x0, y: ROWS.subject[0], width: w, height: ROWS.subject[1], rx: 3,
      fill: subj ? SUBJECT_COLORS[subj.choice] ?? "#666" : "#2a2f37", "fill-opacity": subj?.faded ? 0.3 : 1,
      class: l?.unlabeled ? "tl-unlabeled" : "",
    }));
    if (subj && w > 46) {
      group.append(s("text", { x: x0 + 5, y: ROWS.subject[0] + 20, class: "tl-inlabel", "fill-opacity": subj.faded ? 0.5 : 1 }, pretty(subj.choice).slice(0, Math.floor(w / 7))));
    }
    group.append(s("rect", {
      x: x0, y: ROWS.mode[0], width: w, height: ROWS.mode[1], rx: 3,
      fill: mode ? MODE_COLORS[mode.choice] ?? "#666" : "#2a2f37", "fill-opacity": mode?.faded ? 0.3 : 0.9,
    }));
    if (mode && w > 46) group.append(s("text", { x: x0 + 5, y: ROWS.mode[0] + 14, class: "tl-inlabel small", "fill-opacity": mode.faded ? 0.5 : 1 }, pretty(mode.choice).slice(0, Math.floor(w / 6))));
    nodes.push(group);

    const mid = (x(g.startMs) + x(g.endMs)) / 2;
    const yOf = (v: number) => cy + ch - (v / 4) * ch;
    if (typeof l?.scores.heat === "number") heat.push(`${mid},${yOf(l.scores.heat)}`);
    if (typeof l?.scores.hype === "number") hype.push(`${mid},${yOf(l.scores.hype)}`);

    const marks = (l?.markers ?? []).filter((m) => MARKERS[m]);
    marks.forEach((m, i) => {
      const mx = mid + (i - (marks.length - 1) / 2) * 20;
      nodes.push(s("text", {
        x: mx, y: ROWS.markers[0] + 19, class: `tl-marker${dim ? " dim" : ""}`, "text-anchor": "middle",
        onclick: jump,
      }, s("title", {}, `${MARKERS[m].label} · ${clock(g.startMs)} — click to jump`), MARKERS[m].icon));
    });
  }
  // the open segment: utterances not yet in a closed segment, shown as in progress
  const closed = new Set(segs.flatMap((g) => g.utteranceIds));
  const open = [...st.utterances.values()].filter((u) => !closed.has(u.id));
  if (open.length > 0) {
    const x0 = x(Math.min(...open.map((u) => u.startMs)));
    const end = Math.max(...open.map((u) => u.endMs), st.session?.status === "running" ? opts.nowMs : 0);
    const w = Math.max(2, x(end) - x0);
    nodes.push(s("rect", { x: x0, y: ROWS.subject[0], width: w, height: ROWS.subject[1], rx: 3, class: "tl-open" }, s("title", {}, "Segment in progress: labelled when it closes")));
    nodes.push(s("rect", { x: x0, y: ROWS.mode[0], width: w, height: ROWS.mode[1], rx: 3, class: "tl-open" }));
    if (w > 70) nodes.push(s("text", { x: x0 + 5, y: ROWS.subject[0] + 20, class: "tl-inlabel muted" }, "in progress…"));
  }
  if (heat.length) nodes.push(s("polyline", { points: heat.join(" "), class: "tl-heat" }));
  if (hype.length) nodes.push(s("polyline", { points: hype.join(" "), class: "tl-hype" }));
  for (const p of heat) { const [px, py] = p.split(","); nodes.push(s("circle", { cx: px, cy: py, r: 3, class: "tl-heat-dot" })); }
  for (const p of hype) { const [px, py] = p.split(","); nodes.push(s("circle", { cx: px, cy: py, r: 3, class: "tl-hype-dot" })); }
  nodes.push(s("text", { x: GUTTER + plotW - 4, y: cy + 12, class: "tl-legend", "text-anchor": "end" }, s("tspan", { class: "heat" }, "— heat "), s("tspan", { class: "hype" }, " — hype")));

  // section brackets above the subject lane
  for (const sec of st.sections) {
    nodes.push(s("line", { x1: x(sec.startMs) + 1, x2: x(sec.endMs) - 1, y1: 8, y2: 8, class: "tl-section", stroke: SUBJECT_COLORS[sec.subject] ?? "#888" }));
  }

  // axis
  const step = endMs > 40 * 60_000 ? 10 * 60_000 : endMs > 10 * 60_000 ? 5 * 60_000 : endMs > 3 * 60_000 ? 60_000 : 15_000;
  for (let t = 0; t <= endMs; t += step) {
    nodes.push(s("line", { x1: x(t), x2: x(t), y1: ROWS.axis - 6, y2: ROWS.axis, class: "tl-tick" }));
    nodes.push(s("text", { x: x(t), y: ROWS.axis + 13, class: "tl-axis", "text-anchor": "middle" }, clock(t)));
  }
  if (opts.nowMs > 0) nodes.push(s("line", { x1: x(opts.nowMs), x2: x(opts.nowMs), y1: 4, y2: ROWS.axis, class: "tl-now" }));
  svg.replaceChildren(...nodes);
}
