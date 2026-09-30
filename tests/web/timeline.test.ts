// @vitest-environment happy-dom
// The timeline strip (web/src/timeline.ts; docs/architecture.md § Web front end, Timeline): lanes drawn from the session's
// label set, the chart, pins, the open segment, pauses, the axis and now line; zoom, hover, click-to-seek, the playhead,
// the resize grip; and the still preview used by Try on a recording.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { feed, installBrowserStubs, layout, loadIndexHtml } from "./helpers.ts";
import { aiSet, labels, seg, snapshot, tinySet, trackDocumentListeners, utt } from "./helpers-panels.ts";

type TL = typeof import("../../web/src/timeline.ts");
type StateMod = typeof import("../../web/src/state.ts");
type State = import("../../web/src/state.ts").State;
let T: TL;
let S: StateMod;
let untrack: () => void;

beforeEach(async () => {
  vi.resetModules();
  loadIndexHtml();
  installBrowserStubs();
  localStorage.clear();
  untrack = trackDocumentListeners();
  T = await import("../../web/src/timeline.ts");
  S = await import("../../web/src/state.ts");
});

afterEach(() => {
  untrack();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const box = () => document.getElementById("timeline")!;
const sc = () => document.getElementById("tl-scroll")!;
const q = (sel: string) => [...box().querySelectorAll<HTMLElement>(sel)];
const draw = (st: State, o: { matches?: (g: import("../../web/src/state.ts").Segment) => boolean; onJump?: (id: string) => void; nowMs?: number } = {}) =>
  T.renderTimeline(box(), st, { matches: o.matches ?? (() => true), onJump: o.onJump ?? (() => {}), nowMs: o.nowMs ?? 0 });
const pct = (n: number) => `${Math.max(0, Math.min(100, n)).toFixed(4)}%`;
/** happy-dom's WheelEvent has no ctrlKey, metaKey or clientX (it is not a MouseEvent there), so they are set by hand. */
function wheel(o: { deltaY?: number; deltaX?: number; ctrlKey?: boolean; metaKey?: boolean; clientX?: number }): WheelEvent {
  const e = new WheelEvent("wheel", { deltaY: o.deltaY ?? 0, deltaX: o.deltaX ?? 0, cancelable: true });
  for (const k of ["ctrlKey", "metaKey", "clientX"] as const) Object.defineProperty(e, k, { value: o[k] ?? (k === "clientX" ? 0 : false) });
  return e;
}

/** A running live session with the built-in set: g1 0–30 s (ai_models 80 %, news, heat 2, hype 3, hot take), g2 30–60 s unlabelled. */
function show(session: Record<string, unknown> = {}, set = aiSet()) {
  return feed(S, [
    ["speaker.created", { id: "A", displayName: "Ann" }],
    ["utterance", utt("u1", 0, 30_000, "A")],
    ["utterance", utt("u2", 30_000, 60_000, "A")],
    ["segment.closed", seg("g1", 0, 30_000, ["u1"])],
    ["segment.labels", labels("g1", { choices: { subject: ["ai_models", 0.8], mode: ["news", 0.9] }, scores: { heat: 2, hype: 3 }, markers: ["hot_take"], mentions: ["OpenAI", "Nvidia"], story: "s1" })],
    ["segment.closed", seg("g2", 30_000, 60_000, ["u2"])],
  ], snapshot(session, set));
}

describe("option helpers", () => {
  test("optionOf finds an option of a category, or undefined without a category or an id", () => {
    const cat = aiSet().categories[0]!;
    expect(T.optionOf(cat, "tech")).toBe(cat.options.find((o) => o.id === "tech"));
    expect(T.optionOf(cat, "tech")!.id).toBe("tech");
    expect([T.optionOf(undefined, "tech"), T.optionOf(cat, undefined), T.optionOf(cat, "nope")]).toEqual([undefined, undefined, undefined]);
  });

  test("optionName is the option's name, or the id made readable", () => {
    const cat = tinySet().categories[0]!;
    expect([T.optionName(cat, "a"), T.optionName(cat, "some_thing"), T.optionName(undefined, "x_y")]).toEqual(["Alpha", "some thing", "x y"]);
  });

  test("optionColor is the option's colour, else the lane's fallback (the first lane's for any lane past the second)", () => {
    const cat = tinySet().categories[0]!;
    expect([T.optionColor(cat, "a"), T.optionColor(cat, "zz"), T.optionColor(cat, "zz", 1), T.optionColor(undefined, "zz", 5)]).toEqual(["#111111", "#6a7d98", "#4e5b6c", "#6a7d98"]);
  });
});

describe("renderLegend", () => {
  test("each score's line in its slot, then each marker's icon and short name", () => {
    const el = document.createElement("div");
    T.renderLegend(el, aiSet());
    expect([...el.children].map((c) => c.textContent)).toEqual(["Heat", "Hype", "Disagree", "Hot take", "Prediction", "Recommend", "Clip", "Humour"]);
    expect([...el.querySelectorAll(".ln")].map((l) => l.className)).toEqual(["ln score-1", "ln score-2"]);
    const mk = el.querySelector<HTMLElement>(".mk")!;
    expect([mk.title, mk.querySelector("use")!.getAttribute("href")]).toEqual(["Disagreement", "#i-bolt"]);
  });

  test("no set empties it", () => {
    const el = document.createElement("div");
    el.textContent = "old";
    T.renderLegend(el, null);
    expect(el.childNodes.length).toBe(0);
  });
});

describe("renderTimeline: lanes", () => {
  test("the built-in set: sections, two category lanes, the chart, markers, the axis; the label column matches", () => {
    draw(show());
    expect([...box().children].map((c) => c.className)).toEqual(["lane sections", "lane cat cat-1", "lane cat cat-2", "lane chart", "lane markers", "lane axis"]);
    expect(box().style.gridTemplateRows).toBe("4px 34px 22px var(--tl-chart) 28px 18px");
    const labelCol = document.getElementById("tl-labels")!;
    expect(labelCol.style.gridTemplateRows).toBe("4px 34px 22px var(--tl-chart) 28px 18px");
    expect([...labelCol.children].map((c) => c.textContent)).toEqual(["", "Subject", "Mode", "Heat · Hype40", "Markers", ""]);
    expect(labelCol.querySelector(".tl-lbl-chart .scale.top")!.textContent).toBe("4");
  });

  test("the label column is redrawn only when the rows or the set change", () => {
    const st = show();
    draw(st);
    const first = document.querySelector("#tl-labels .tl-lbl")!;
    draw(st);
    expect(document.querySelector("#tl-labels .tl-lbl")).toBe(first);
    st.labels.set = tinySet();
    draw(st);
    expect([...document.getElementById("tl-labels")!.children].map((c) => c.textContent)).toEqual(["", "Topic", "Energy40", "Markers", ""]);
  });

  test("labels off: one lane of plain segments, no chart or markers", () => {
    draw(show({ features: { factcheck: true, labels: false } }));
    expect([...box().children].map((c) => c.className)).toEqual(["lane sections", "lane cat cat-1", "lane axis"]);
    expect([...document.getElementById("tl-labels")!.children].map((c) => c.textContent)).toEqual(["", "Segments", ""]);
    const blk = q(".cat-1 .blk")[0]!;
    expect([blk.title, blk.style.background, blk.textContent]).toEqual(["0:00–0:30 · click to jump", "", ""]);
  });

  test("a set with no categories still draws one lane of segments, with 'unlabeled' in the tip of an unlabelled one", () => {
    const st = show({}, tinySet({ categories: [] }));
    S.applyEvent(st, "segment.labels", labels("g2", { unlabeled: true }), "2026-09-30T10:00:00.000Z", new Set());
    draw(st);
    expect(q(".cat-1 .blk").map((b) => [b.className, b.title])).toEqual([
      ["blk", "0:00–0:30 · click to jump"], ["blk unlabeled", "0:30–1:00 · unlabeled · click to jump"],
    ]);
  });

  test("the chart has gridlines at 25, 50 and 75 %", () => {
    draw(show());
    expect(q(".chart .gridline").map((g) => g.style.top)).toEqual(["25%", "50%", "75%"]);
  });

  test("no timeline label column in the page: nothing breaks", () => {
    document.getElementById("tl-labels")!.remove();
    expect(() => draw(show())).not.toThrow();
  });
});

describe("renderTimeline: segments", () => {
  test("positions are percentages of at least 60 s, and the track is zoom × 100 % wide", () => {
    layout(sc(), { clientWidth: 1000 });
    draw(show());
    expect(box().style.width).toBe("100%");
    const [g1] = q(".cat-1 .blk");
    expect(g1!.getAttribute("style")).toContain(`left:${pct(0)};width:${pct(50 - (2 / 1000) * 100)}`);
  });

  test("the length is the longest of 60 s, now, the last line and the last segment", () => {
    const st = show();
    draw(st, { nowMs: 120_000 });
    expect(q(".cat-1 .blk")[1]!.getAttribute("style")).toContain(`left:${pct(25)}`);
    S.applyEvent(st, "utterance", utt("u9", 60_000, 240_000, "A"), "2026-09-30T10:00:00.000Z", new Set());
    draw(st);
    expect(q(".cat-1 .blk")[1]!.getAttribute("style")).toContain(`left:${pct(12.5)}`);
  });

  test("a labelled segment: the option's colour and name, and a tip with the choice, the other category, the story and the mentions", () => {
    draw(show());
    const [subj] = q(".cat-1 .blk");
    const [mode] = q(".cat-2 .blk");
    expect(subj!.style.background).toBe(aiSet().categories[0]!.options[0]!.color);
    expect(subj!.textContent).toBe(aiSet().categories[0]!.options[0]!.name);
    expect(subj!.title).toBe(`0:00–0:30 · ${T.optionName(aiSet().categories[0], "ai_models")} (80%) · ${T.optionName(aiSet().categories[1], "news")} · story: s1 · mentions: OpenAI, Nvidia · click to jump`);
    expect([mode!.getAttribute("tabindex"), mode!.title, mode!.textContent]).toEqual(["-1", `0:00–0:30 · ${T.optionName(aiSet().categories[1], "news")}`, T.optionName(aiSet().categories[1], "news")]);
  });

  test("a segment being labelled reads 'labelling…'; its second lane says there is no answer yet", () => {
    draw(show());
    const [, subj] = q(".cat-1 .blk");
    const [, mode] = q(".cat-2 .blk");
    expect([subj!.title, subj!.textContent, subj!.style.background]).toEqual(["0:30–1:00 · labelling… · click to jump", "", ""]);
    expect(mode!.title).toBe("0:30–1:00 · no mode yet");
  });

  test("an unlabelled segment (Jev failed) is marked and reads 'unlabeled'", () => {
    const st = show();
    S.applyEvent(st, "segment.labels", labels("g2", { unlabeled: true }), "2026-09-30T10:00:00.000Z", new Set());
    draw(st);
    const [, subj] = q(".cat-1 .blk");
    expect([subj!.className, subj!.title, subj!.textContent]).toEqual(["blk unlabeled", "0:30–1:00 · unlabeled · click to jump", "unlabeled"]);
  });

  test("a labelled segment without the first category's answer shows '?', and a choice unknown to the set its readable id", () => {
    const st = show();
    S.applyEvent(st, "segment.labels", labels("g2", { choices: { mode: ["new_mode", 0.9] } }), "2026-09-30T10:00:00.000Z", new Set());
    draw(st);
    const [, subj] = q(".cat-1 .blk");
    const [, mode] = q(".cat-2 .blk");
    expect(subj!.title).toBe("0:30–1:00 · ? · new mode · click to jump");
    expect([mode!.textContent, mode!.style.background]).toEqual(["new mode", "#4e5b6c"]);
  });

  test("low-confidence choices are faded, and the second lane's tip says so", () => {
    const st = show();
    S.applyEvent(st, "segment.labels", labels("g2", { choices: { subject: ["tech", 0.3, true], mode: ["banter", 0.2, true] } }), "2026-09-30T10:00:00.000Z", new Set());
    draw(st);
    expect(q(".cat-1 .blk")[1]!.className).toBe("blk faded");
    expect(q(".cat-2 .blk")[1]!.className).toBe("blk faded");
    expect(q(".cat-2 .blk")[1]!.title).toBe(`0:30–1:00 · ${T.optionName(aiSet().categories[1], "banter")} (low confidence)`);
  });

  test("a segment that does not match the filters is dimmed, with its pins", () => {
    draw(show(), { matches: (g) => g.id !== "g1" });
    expect(q(".cat-1 .blk").map((b) => b.classList.contains("dim"))).toEqual([true, false]);
    expect(q(".cat-2 .blk")[0]!.classList.contains("dim")).toBe(true);
    expect(q(".pin")[0]!.classList.contains("dim")).toBe(true);
  });

  test("a click on a segment jumps to it; with a seek handler (a recording) playback moves to its start too", () => {
    const onJump = vi.fn();
    const seek = vi.fn();
    const st = show();
    draw(st, { onJump });
    q(".cat-2 .blk")[1]!.click();
    expect([onJump.mock.calls, seek.mock.calls]).toEqual([[["g2"]], []]);
    T.setSeekHandler(seek);
    draw(st, { onJump });
    q(".cat-1 .blk")[1]!.click();
    expect(seek.mock.calls).toEqual([[30_000]]);
  });

  test("a very short segment keeps a minimum width", () => {
    const st = show();
    S.applyEvent(st, "segment.closed", seg("g3", 60_000, 60_001, []), "2026-09-30T10:00:00.000Z", new Set());
    draw(st);
    expect(q(".cat-1 .blk")[2]!.getAttribute("style")).toContain(`width:${pct(0.3)}`);
  });

  test("sections: a bracket per section of the first category, coloured, with its option and span; others are skipped", () => {
    const st = show();
    S.applyEvent(st, "section.updated", { sections: [
      { id: "x1", category: "subject", option: "ai_models", lane: "AI", segmentIds: ["g1"], startMs: 0, endMs: 30_000 },
      { id: "x2", category: "subject", option: "zz", lane: "zz", segmentIds: ["g2"], startMs: 30_000, endMs: 60_000 },
      { id: "x3", category: "gone", option: "a", lane: "a", segmentIds: [], startMs: 0, endMs: 1 },
    ] }, "2026-09-30T10:00:00.000Z", new Set());
    draw(st);
    const sects = q(".sections .sect");
    expect(sects.map((x) => [x.style.background, x.title])).toEqual([
      [aiSet().categories[0]!.options[0]!.color, `Section: ${T.optionName(aiSet().categories[0], "ai_models")}, 0:00–0:30`],
      ["#6a7d98", "Section: zz, 0:30–1:00"],
    ]);
    expect(sects[1]!.getAttribute("style")).toContain(`left:${pct(50)};width:${pct(50)}`);
  });
});

describe("renderTimeline: chart and markers", () => {
  test("each score is a polyline in its slot at y = (1 − v/4) × 100, with a dot per point", () => {
    const st = show();
    S.applyEvent(st, "segment.labels", labels("g2", { choices: { subject: ["tech", 0.9] }, scores: { heat: 4 } }), "2026-09-30T10:00:00.000Z", new Set());
    draw(st);
    const svg = box().querySelector(".chart svg")!;
    expect([svg.getAttribute("viewBox"), svg.getAttribute("preserveAspectRatio")]).toEqual(["0 0 100 100", "none"]);
    expect([...svg.querySelectorAll("polyline")].map((p) => [p.getAttribute("class"), p.getAttribute("points")])).toEqual([
      ["score-1", "25,50 75,0"], ["score-2", "25,25"],
    ]);
    expect(q(".chart .dot").map((d) => [d.className, d.title, d.getAttribute("style")])).toEqual([
      ["dot score-1", "Heat 2.0", `left:${pct(25)};top:${pct(50)}`],
      ["dot score-1", "Heat 4.0", `left:${pct(75)};top:${pct(0)}`],
      ["dot score-2", "Hype 3.0", `left:${pct(25)};top:${pct(25)}`],
    ]);
  });

  test("a score with no values draws no line", () => {
    const st = show();
    st.segments.get("g1")!.labels!.scores = {};
    draw(st);
    expect(box().querySelectorAll(".chart polyline").length).toBe(0);
  });

  test("a pin per marker of the set at the segment's middle, with its icon, name and time; unknown markers are skipped", () => {
    const onJump = vi.fn();
    const st = show();
    st.segments.get("g1")!.labels!.markers = ["hot_take", "not_in_set"];
    draw(st, { onJump });
    const pins = q(".markers .pin");
    expect(pins.map((p) => [p.getAttribute("style"), p.title, p.getAttribute("aria-label"), p.querySelector("use")!.getAttribute("href")])).toEqual([
      [`left:calc(${pct(25)} + 0px)`, "Hot take · 0:00: click to jump", "Hot take at 0:00", "#i-flame"],
    ]);
    pins[0]!.click();
    expect(onJump).toHaveBeenCalledWith("g1");
  });

  test("two markers sit 28 px apart around the middle, three at −28, 0 and +28", () => {
    const st = show();
    st.segments.get("g1")!.labels!.markers = ["hot_take", "prediction"];
    st.segments.get("g2")!.labels = labels("g2", { markers: ["humour", "clip_worthy", "disagreement"] });
    draw(st);
    expect(q(".markers .pin").map((p) => p.getAttribute("style")!.replace(/^.* \+ /, ""))).toEqual(["-14px)", "14px)", "-28px)", "0px)", "28px)"]);
  });
});

describe("renderTimeline: in progress, pauses, axis, now", () => {
  function live() {
    const st = show();
    S.applyEvent(st, "utterance", utt("u3", 60_000, 70_000, "A"), "2026-09-30T10:00:00.000Z", new Set());
    return st;
  }

  test("lines in no closed segment give an 'in progress' block in each lane, reaching now while running", () => {
    layout(sc(), { clientWidth: 1000 });
    draw(live(), { nowMs: 100_000 });
    const [open1] = q(".cat-1 .blk.open");
    const [open2] = q(".cat-2 .blk.open");
    expect([open1!.tagName, open1!.title, open1!.textContent]).toEqual(["SPAN", "Segment in progress: labelled when it closes", "In progress"]);
    expect(open1!.getAttribute("style")).toBe(`left:${pct(60)};width:${pct(40)}`);
    expect([open2!.title, open2!.textContent]).toEqual(["", ""]);
  });

  test("the text shows only when the block is wider than 90 px; a stopped session's block ends at its last line", () => {
    layout(sc(), { clientWidth: 1000 });
    const st = live();
    st.session!.status = "archived";
    draw(st, { nowMs: 1_000_000 });
    const [open] = q(".cat-1 .blk.open");
    expect(open!.getAttribute("style")).toBe(`left:${pct(6)};width:${pct(1)}`);
    expect(open!.textContent).toBe("");
  });

  test("with labels off the block only says the segment is in progress", () => {
    const st = live();
    st.session!.features = { factcheck: true, labels: false };
    draw(st, { nowMs: 100_000 });
    expect(q(".blk.open")[0]!.title).toBe("Segment in progress");
  });

  test("a pause is a hatched band across the category lanes and the chart; an ongoing one runs to now", () => {
    const st = show();
    S.applyEvent(st, "session.paused", { atMs: 10_000 }, "2026-09-30T10:00:00.000Z", new Set());
    S.applyEvent(st, "session.resumed", { atMs: 20_000 }, "2026-09-30T10:00:00.000Z", new Set());
    S.applyEvent(st, "session.paused", { atMs: 40_000 }, "2026-09-30T10:00:00.000Z", new Set());
    draw(st, { nowMs: 50_000 });
    const bands = q(".pause-band");
    expect(bands.length).toBe(6);
    expect(bands.map((b) => b.parentElement!.className)).toEqual(["lane cat cat-1", "lane cat cat-1", "lane cat cat-2", "lane cat cat-2", "lane chart", "lane chart"]);
    expect(bands[0]!.title).toBe("Paused 0:10–0:20: nothing was heard or transcribed");
    expect(bands[1]!.title).toBe("Paused 0:40–now: nothing was heard or transcribed");
    expect(bands[1]!.getAttribute("style")).toBe(`left:${pct((40 / 60) * 100)};width:${pct((10 / 60) * 100)}`);
  });

  test("axis at 1000 px for 60 s: 5 s ticks from 0:00, leaving room for the now tag at the end", () => {
    layout(sc(), { clientWidth: 1000 });
    draw(show());
    const ticks = q(".axis .tick");
    expect(ticks.map((t) => t.textContent)).toEqual(["0:00", "0:05", "0:10", "0:15", "0:20", "0:25", "0:30", "0:35", "0:40", "0:45", "0:50", "0:55"]);
    expect(ticks[0]!.className).toBe("tick first");
    expect(ticks[1]!.className).toBe("tick");
  });

  test("a longer show takes a coarser step (an hour at 1000 px: 5 min), and past every step one tick an hour", () => {
    layout(sc(), { clientWidth: 1000 });
    draw(show(), { nowMs: 3_600_000 });
    expect(q(".axis .tick").slice(0, 3).map((t) => t.textContent)).toEqual(["0:00", "5:00", "10:00"]);
    draw(show(), { nowMs: 100 * 3_600_000 });
    expect(q(".axis .tick").slice(0, 2).map((t) => t.textContent)).toEqual(["0:00", "1:00:00"]);
  });

  test("the now line in every lane and the tag: 'Now' while running, 'End' otherwise; none at 0", () => {
    const st = show();
    draw(st, { nowMs: 60_000 });
    expect(q(".nowline").map((n) => n.parentElement!.className)).toEqual(["lane cat cat-1", "lane cat cat-2", "lane chart", "lane markers"]);
    expect(q(".nowtag").map((n) => [n.textContent, n.getAttribute("style")])).toEqual([["Now 1:00", `left:calc(${pct(100)} + 1px)`]]);
    st.session!.status = "archived";
    draw(st, { nowMs: 60_000 });
    expect(q(".nowtag")[0]!.textContent).toBe("End 1:00");
    draw(st, { nowMs: 0 });
    expect(q(".nowline, .nowtag").length).toBe(0);
  });

  test("without the scroller, the track is taken as 1000 px", () => {
    sc().replaceWith(box());
    draw(show());
    expect(q(".axis .tick").length).toBe(12);
  });
});

describe("zoom", () => {
  function bound(clientWidth = 1000) {
    layout(sc(), { clientWidth });
    const redraw = vi.fn();
    T.bindTimeline(redraw);
    return redraw;
  }
  const level = () => document.getElementById("zoom-level")!.textContent;
  const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;

  test("at first: the whole show, zoom-out off", () => {
    bound();
    expect([level(), btn("zoom-out").disabled]).toEqual(["Whole show", true]);
  });

  test("+ doubles up to about 30 s across (2 min: 1:00 view, then 0:30 view and + off); − halves; Fit returns to 1; each redraws", () => {
    const redraw = bound();
    draw(show(), { nowMs: 120_000 });
    btn("zoom-in").click();
    expect([level(), box().style.width, btn("zoom-out").disabled, btn("zoom-in").disabled]).toEqual(["1:00 view", "200%", false, false]);
    btn("zoom-in").click();
    expect([level(), box().style.width, btn("zoom-in").disabled]).toEqual(["0:30 view", "400%", true]);
    btn("zoom-out").click();
    expect(level()).toBe("1:00 view");
    btn("zoom-fit").click();
    expect([level(), box().style.width]).toEqual(["Whole show", "100%"]);
    expect(redraw).toHaveBeenCalledTimes(4);
  });

  test("the strip is at least 60 s long, so even an empty one zooms in once, to 0:30", () => {
    bound();
    T.renderTimeline(box(), S.emptyState(), { matches: () => true, onJump: () => {}, nowMs: 0 });
    expect(btn("zoom-in").disabled).toBe(false);
    btn("zoom-in").click();
    expect([level(), btn("zoom-in").disabled]).toEqual(["0:30 view", true]);
  });

  test("zooming keeps the time under the anchor in place", () => {
    bound();
    draw(show(), { nowMs: 120_000 });
    btn("zoom-in").click(); // anchored at the centre: 60 s is at 500 px of a 2000 px track, so it scrolls to 500
    expect(sc().scrollLeft).toBe(500);
  });

  test("a recording opened after a longer one clamps the zoom", () => {
    bound();
    draw(show(), { nowMs: 240_000 });
    btn("zoom-in").click();
    btn("zoom-in").click();
    btn("zoom-in").click();
    expect(box().style.width).toBe("800%");
    draw(show(), { nowMs: 60_000 });
    expect([box().style.width, level()]).toEqual(["200%", "0:30 view"]);
  });

  test("while scrolled to the newest moment, a redraw stays at the end as the session grows", () => {
    bound();
    draw(show(), { nowMs: 120_000 });
    btn("zoom-in").click();
    layout(sc(), { clientWidth: 1000, scrollWidth: 2000 });
    sc().scrollLeft = 1000;
    draw(show(), { nowMs: 130_000 });
    expect(sc().scrollLeft).toBe(2000);
  });

  test("⌘/Ctrl + wheel zooms by exp(−deltaY × 0.01) around the pointer", () => {
    const redraw = bound();
    layout(sc(), { clientWidth: 1000, rect: { left: 100, width: 1000 } });
    draw(show(), { nowMs: 120_000 });
    const e = wheel({ deltaY: -Math.log(2) * 100, ctrlKey: true, clientX: 100 });
    sc().dispatchEvent(e);
    expect([e.defaultPrevented, box().style.width, sc().scrollLeft]).toEqual([true, "200%", 0]);
    const m = wheel({ deltaY: Math.log(2) * 100, metaKey: true, clientX: 600 });
    sc().dispatchEvent(m);
    expect([m.defaultPrevented, box().style.width]).toEqual([true, "100%"]);
    expect(redraw).toHaveBeenCalledTimes(2);
  });

  test("a plain wheel scrolls through time only while zoomed, and only when it is mostly vertical", () => {
    bound();
    draw(show(), { nowMs: 120_000 });
    const flat = wheel({ deltaY: 50 });
    sc().dispatchEvent(flat);
    expect(flat.defaultPrevented).toBe(false);
    btn("zoom-in").click();
    sc().scrollLeft = 0;
    const v = wheel({ deltaY: 50, deltaX: 10 });
    sc().dispatchEvent(v);
    expect([v.defaultPrevented, sc().scrollLeft]).toEqual([true, 50]);
    const hz = wheel({ deltaY: 10, deltaX: 50 });
    sc().dispatchEvent(hz);
    expect(hz.defaultPrevented).toBe(false);
  });

  test("zoom without the strip in the page does nothing", () => {
    T.bindTimeline(() => {});
    sc().remove();
    expect(() => btn("zoom-in").click()).not.toThrow();
  });
});

describe("hover and click-to-seek", () => {
  function bound() {
    layout(sc(), { clientWidth: 1000, rect: { left: 100, width: 1000 } });
    T.bindTimeline(() => {});
    draw(show(), { nowMs: 100_000 });
  }
  const hover = () => document.getElementById("tl-hover")!;

  test("the pointer shows a line at its x with the exact time, marked near either edge; leaving hides it", () => {
    bound();
    sc().dispatchEvent(new PointerEvent("pointermove", { clientX: 600 }));
    expect([hover().hidden, hover().style.left, hover().querySelector("span")!.textContent]).toEqual([false, "500px", "0:50"]);
    expect([hover().classList.contains("edge-left"), hover().classList.contains("edge-right")]).toEqual([false, false]);
    sc().dispatchEvent(new PointerEvent("pointermove", { clientX: 110 }));
    expect(hover().classList.contains("edge-left")).toBe(true);
    sc().dispatchEvent(new PointerEvent("pointermove", { clientX: 1090 }));
    expect(hover().classList.contains("edge-right")).toBe(true);
    sc().dispatchEvent(new PointerEvent("pointerleave"));
    expect(hover().hidden).toBe(true);
  });

  test("scrolling moves the line with the strip", () => {
    bound();
    sc().dispatchEvent(new PointerEvent("pointermove", { clientX: 600 }));
    sc().scrollLeft = 200;
    sc().dispatchEvent(new Event("scroll"));
    expect(hover().style.left).toBe("700px");
  });

  test("a click on the empty track seeks there; on a segment or a pin it does not; without a handler nothing happens", () => {
    bound();
    const seek = vi.fn();
    sc().dispatchEvent(new MouseEvent("click", { clientX: 600, bubbles: true }));
    T.setSeekHandler(seek);
    expect(sc().classList.contains("seekable")).toBe(true);
    sc().dispatchEvent(new MouseEvent("click", { clientX: 600, bubbles: true }));
    sc().dispatchEvent(new MouseEvent("click", { clientX: 50, bubbles: true }));
    expect(seek.mock.calls).toEqual([[50_000], [0]]);
    seek.mockClear();
    // a click inside a pin or a segment seeks only through its own jump (to the segment's start), never to the x
    q(".pin")[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { clientX: 600, bubbles: true }));
    q(".cat-1 .blk")[1]!.querySelector("span")!.dispatchEvent(new MouseEvent("click", { clientX: 600, bubbles: true }));
    expect(seek.mock.calls).toEqual([[0], [30_000]]);
    T.setSeekHandler(null);
    expect(sc().classList.contains("seekable")).toBe(false);
  });
});

describe("the playhead", () => {
  test("setPlayhead(ms) draws div#playhead at ms / length, with the time, marked near the end; null removes it", () => {
    draw(show());
    T.setPlayhead(15_000);
    const ph = document.getElementById("playhead")!;
    expect([ph.className, ph.style.left, ph.querySelector("span")!.textContent]).toEqual(["playhead", "25%", "0:15"]);
    T.setPlayhead(58_000);
    expect(ph.classList.contains("edge")).toBe(true);
    T.setPlayhead(600_000);
    expect(ph.style.left).toBe("100%");
    T.setPlayhead(null);
    expect(document.getElementById("playhead")).toBeNull();
  });

  test("a redraw keeps the playhead", () => {
    const st = show();
    draw(st);
    T.setPlayhead(30_000);
    draw(st);
    expect(document.getElementById("playhead")!.style.left).toBe("50%");
  });

  test("set before the strip exists, it appears with the next draw", () => {
    const tl = box();
    tl.remove();
    T.setPlayhead(30_000);
    expect(document.getElementById("playhead")).toBeNull();
    document.getElementById("tl-scroll")!.append(tl);
    draw(show());
    expect(document.getElementById("playhead")!.style.left).toBe("50%");
  });

  test("following while zoomed: out of view it scrolls to put the playhead 30 % in; in view, or at zoom 1, it does not", () => {
    layout(sc(), { clientWidth: 1000 });
    T.bindTimeline(() => {});
    draw(show(), { nowMs: 120_000 });
    T.setPlayhead(100_000, true);
    expect(sc().scrollLeft).toBe(0);
    document.getElementById("zoom-in")!.click();
    sc().scrollLeft = 0;
    T.setPlayhead(100_000, true); // at 1666.7 px of 2000
    expect(sc().scrollLeft).toBeCloseTo(1666.67 - 300, 1);
    const at = sc().scrollLeft;
    T.setPlayhead(110_000, true);
    expect(sc().scrollLeft).toBe(at);
    T.setPlayhead(10_000, false);
    expect(sc().scrollLeft).toBe(at);
  });
});

describe("the chart's height", () => {
  const tl = () => document.getElementById("tl")!;
  const grip = () => document.getElementById("tl-grip")!;

  test("a saved height is restored (at least 60 px); a missing or unreadable one is ignored", () => {
    localStorage.setItem("pa.timelineChartPx", "150");
    T.bindTimeline(() => {});
    expect([tl().style.getPropertyValue("--tl-chart"), grip().getAttribute("aria-valuenow"), grip().getAttribute("aria-valuemin")]).toEqual(["150px", "150", "60"]);
    loadIndexHtml();
    localStorage.setItem("pa.timelineChartPx", "20");
    T.bindTimeline(() => {});
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("60px");
    loadIndexHtml();
    localStorage.setItem("pa.timelineChartPx", "abc");
    T.bindTimeline(() => {});
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("");
  });

  test("storage that throws is tolerated", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => T.bindTimeline(() => {})).not.toThrow();
    grip().dispatchEvent(new MouseEvent("dblclick"));
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("100px");
  });

  test("double-click resets to 100 px and saves it", () => {
    T.bindTimeline(() => {});
    tl().style.setProperty("--tl-chart", "200px");
    grip().dispatchEvent(new MouseEvent("dblclick"));
    expect([tl().style.getPropertyValue("--tl-chart"), localStorage.getItem("pa.timelineChartPx")]).toEqual(["100px", "100"]);
  });

  test("↑ and ↓ change it by 20 px; other keys do nothing", () => {
    T.bindTimeline(() => {});
    const key = (k: string) => { const e = new KeyboardEvent("keydown", { key: k, cancelable: true }); grip().dispatchEvent(e); return e; };
    expect(key("ArrowUp").defaultPrevented).toBe(true);
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("120px");
    key("ArrowDown");
    key("ArrowDown");
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("80px");
    expect(key("Enter").defaultPrevented).toBe(false);
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("80px");
  });

  test("it never grows past the window's height less room for the transcript", () => {
    vi.stubGlobal("innerHeight", 500);
    T.bindTimeline(() => {});
    // the strip is 150 px of lanes plus the chart: 500 - 60 - 160 - 150 leaves 130 px for the chart
    Object.defineProperty(tl(), "offsetHeight", { configurable: true, get: () => 150 + (parseFloat(tl().style.getPropertyValue("--tl-chart")) || 100) });
    for (let i = 0; i < 20; i++) grip().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("130px");
  });

  test("dragging the grip up makes it taller; the drag state is shown until the pointer is released or cancelled", () => {
    T.bindTimeline(() => {});
    grip().setPointerCapture = vi.fn();
    const down = new PointerEvent("pointerdown", { clientY: 500, pointerId: 3, cancelable: true });
    grip().dispatchEvent(down);
    expect([down.defaultPrevented, grip().classList.contains("dragging"), document.body.classList.contains("resizing")]).toEqual([true, true, true]);
    expect(grip().setPointerCapture).toHaveBeenCalledWith(3);
    grip().dispatchEvent(new PointerEvent("pointermove", { clientY: 450 }));
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("150px");
    grip().dispatchEvent(new PointerEvent("pointerup"));
    expect([grip().classList.contains("dragging"), document.body.classList.contains("resizing")]).toEqual([false, false]);
    grip().dispatchEvent(new PointerEvent("pointermove", { clientY: 300 }));
    expect(tl().style.getPropertyValue("--tl-chart")).toBe("150px");
    grip().dispatchEvent(new PointerEvent("pointerdown", { clientY: 500 }));
    grip().dispatchEvent(new PointerEvent("pointercancel"));
    expect(grip().classList.contains("dragging")).toBe(false);
  });

  test("without the grip, or without #tl, the rest still binds", () => {
    grip().remove();
    expect(() => T.bindTimeline(() => {})).not.toThrow();
    loadIndexHtml();
    tl().removeAttribute("id");
    localStorage.setItem("pa.timelineChartPx", "150");
    expect(() => T.bindTimeline(() => {})).not.toThrow();
  });
});

describe("renderPreview (Try on a recording)", () => {
  const win = { startMs: 0, endMs: 60_000 };
  const segs = [{ id: "g1", startMs: 0, endMs: 30_000 }, { id: "g2", startMs: 30_000, endMs: 60_000 }, { id: "g3", startMs: 60_000, endMs: 60_010 }];

  test("the same lanes as the strip, without clicks: blocks with colours, names and tips, the chart, pins, and four ticks", () => {
    const l = new Map([
      ["g1", labels("g1", { choices: { subject: ["ai_models", 0.8], mode: ["news", 0.4, true] }, scores: { heat: 1 }, markers: ["hot_take", "prediction", "nope"] })],
      ["g2", labels("g2", { unlabeled: true })],
    ]);
    const el = T.renderPreview(aiSet(), segs, l, win);
    expect(el.className).toBe("tl-body preview");
    expect(el.querySelector<HTMLElement>(".tl-labels")!.getAttribute("style")).toBe("grid-template-rows:4px 34px 22px var(--tl-chart) 28px 18px");
    const track = el.querySelector(".tl-track")!;
    expect([...track.children].map((c) => c.className)).toEqual(["lane sections", "lane cat cat-1", "lane cat cat-2", "lane chart", "lane markers", "lane axis"]);
    const b = [...track.querySelectorAll<HTMLElement>(".cat-1 .blk")];
    expect(b.map((x) => [x.tagName, x.className, x.title, x.textContent])).toEqual([
      ["SPAN", "blk", `0:00–0:30 · ${T.optionName(aiSet().categories[0], "ai_models")} (80%)`, T.optionName(aiSet().categories[0], "ai_models")],
      ["SPAN", "blk unlabeled", "0:30–1:00 · no answer", ""],
      ["SPAN", "blk", "1:00–1:00", ""],
    ]);
    expect(b[0]!.getAttribute("style")).toBe(`left:${pct(0)};width:${pct(50 - 0.25)};background:${aiSet().categories[0]!.options[0]!.color}`);
    expect(b[2]!.getAttribute("style")).toContain(`width:${pct(0.3)}`);
    expect(track.querySelector(".cat-2 .blk")!.className).toBe("blk faded");
    expect(track.querySelector(".chart polyline")!.getAttribute("points")).toBe("25,75");
    expect(track.querySelector<HTMLElement>(".chart .dot")!.title).toBe("Heat 1.0");
    expect([...track.querySelectorAll<HTMLElement>(".markers .pin")].map((p) => [p.tagName, p.title, p.getAttribute("style")])).toEqual([
      ["SPAN", "Hot take · 0:00–0:30", `left:calc(${pct(25)} + -14px)`], ["SPAN", "Prediction · 0:00–0:30", `left:calc(${pct(25)} + 14px)`],
    ]);
    expect([...track.querySelectorAll(".axis .tick")].map((t) => [t.className, t.textContent])).toEqual([["tick first", "0:00"], ["tick", "0:15"], ["tick", "0:30"], ["tick", "0:45"]]);
  });

  test("a window that does not start at 0 is measured from its start; an empty window counts as 1 ms", () => {
    const el = T.renderPreview(aiSet(), [{ id: "g", startMs: 600_000, endMs: 630_000 }], new Map(), { startMs: 600_000, endMs: 660_000 });
    expect(el.querySelector(".cat-1 .blk")!.getAttribute("style")).toBe(`left:${pct(0)};width:${pct(50 - 0.25)}`);
    expect(el.querySelector(".axis .tick")!.textContent).toBe("10:00");
    expect(() => T.renderPreview(aiSet(), [], new Map(), { startMs: 5, endMs: 5 })).not.toThrow();
  });

  test("without a set (labels off), one lane of plain segments", () => {
    const el = T.renderPreview(null, segs.slice(0, 2), new Map([["g2", labels("g2", { unlabeled: true })]]), win);
    expect([...el.querySelector(".tl-track")!.children].map((c) => c.className)).toEqual(["lane sections", "lane cat cat-1", "lane axis"]);
    expect([...el.querySelectorAll<HTMLElement>(".cat-1 .blk")].map((x) => [x.className, x.title])).toEqual([["blk", "0:00–0:30"], ["blk unlabeled", "0:30–1:00"]]);
    expect(el.querySelector(".tl-labels")!.textContent).toBe("Segments");
  });

  test("a score with no values draws no line", () => {
    const el = T.renderPreview(tinySet(), segs, new Map(), win);
    expect(el.querySelector(".chart svg")!.children.length).toBe(0);
  });
});
