// @vitest-environment happy-dom
// The transcript filters (web/src/panels.ts): segmentOf, segmentMatches, renderFilters, and how renderTranscript and the
// timeline use them. docs/architecture.md § Web front end: "A speaker filter shows only that speaker's lines; a marker or
// category filter shows the matching segments' lines and dims the rest of the timeline".
import { beforeEach, describe, expect, test, vi } from "vitest";
import { feed, installBrowserStubs, loadIndexHtml, makeFakeApi } from "./helpers.ts";
import { aiSet, labels, seg, snapshot, utt } from "./helpers-panels.ts";

const fake = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<object>()), api: fake }));
vi.mock("../../web/src/transfer.ts", () => ({ openExport: vi.fn(), openImport: vi.fn() }));

type Panels = typeof import("../../web/src/panels.ts");
type StateMod = typeof import("../../web/src/state.ts");
let P: Panels;
let S: StateMod;

beforeEach(async () => {
  vi.resetModules();
  loadIndexHtml();
  installBrowserStubs();
  Object.assign(fake, makeFakeApi((await vi.importActual<typeof import("../../web/src/api.ts")>("../../web/src/api.ts")).api));
  P = await import("../../web/src/panels.ts");
  S = await import("../../web/src/state.ts");
});

/** Two speakers, three segments: g1 (hot take, ai_models) with u1 by A and u2 by B; g2 (no markers, tech) with u3 by A; g3 unlabelled with u4 by B. */
function show() {
  return feed(S, [
    ["speaker.created", { id: "A", displayName: "Ann" }],
    ["speaker.created", { id: "B", displayName: "Bob" }],
    ["utterance", utt("u1", 0, 5_000, "A")],
    ["utterance", utt("u2", 5_000, 10_000, "B", { stream: "remote" })],
    ["utterance", utt("u3", 12_000, 20_000, "A")],
    ["utterance", utt("u4", 22_000, 30_000, "B", { stream: "remote" })],
    ["segment.closed", seg("g1", 0, 10_000, ["u1", "u2"])],
    ["segment.labels", labels("g1", { choices: { subject: ["ai_models", 0.9], mode: ["news", 0.8] }, markers: ["hot_take"] })],
    ["segment.closed", seg("g2", 12_000, 20_000, ["u3"])],
    ["segment.labels", labels("g2", { choices: { subject: ["tech", 0.9] } })],
    ["segment.closed", seg("g3", 22_000, 30_000, ["u4"])],
  ], snapshot());
}

const lines = () => [...document.querySelectorAll("#transcript .utt")].map((r) => r.id);

describe("segmentOf", () => {
  test("maps every utterance id to its segment; an empty state gives an empty map", () => {
    const st = show();
    const m = P.segmentOf(st);
    expect([...m].map(([u, g]) => `${u}:${g.id}`)).toEqual(["u1:g1", "u2:g1", "u3:g2", "u4:g3"]);
    expect(P.segmentOf(S.emptyState()).size).toBe(0);
  });
});

describe("segmentMatches", () => {
  test("no filter matches every segment", () => {
    const st = show();
    P.renderFilters(st, () => {});
    expect([...st.segments.values()].map(P.segmentMatches)).toEqual([true, true, true]);
  });

  test("a marker filter matches the segments that have one of the chosen markers; a segment without labels never matches", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.markers.add("hot_take");
    expect([...st.segments.values()].map(P.segmentMatches)).toEqual([true, false, false]);
    P.filters.markers.add("prediction");
    expect(P.segmentMatches(st.segments.get("g1")!)).toBe(true);
  });

  test("a category filter matches its option, or every option of a group; a filter on a category the set lacks is ignored", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.categories.subject = "tech";
    expect([...st.segments.values()].map(P.segmentMatches)).toEqual([false, true, false]);
    P.filters.categories.subject = "group:AI";
    expect([...st.segments.values()].map(P.segmentMatches)).toEqual([true, false, false]);
    P.filters.categories = { nothing: "x" };
    expect([...st.segments.values()].map(P.segmentMatches)).toEqual([false, false, false]);
    P.filters.categories = { subject: "" };
    expect([...st.segments.values()].map(P.segmentMatches)).toEqual([true, true, true]);
  });

  // B2: speaker filtering is per utterance; segments dim only on label filters
  test("a speaker filter alone dims no segment", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.speaker = "A";
    expect([...st.segments.values()].map(P.segmentMatches)).toEqual([true, true, true]);
  });

  test("on the timeline, a speaker filter alone dims no segment; a marker filter dims the others", async () => {
    const T = await import("../../web/src/timeline.ts");
    const st = show();
    P.renderFilters(st, () => {});
    const draw = () => T.renderTimeline(document.getElementById("timeline")!, st, { matches: P.segmentMatches, onJump: () => {}, nowMs: 0 });
    P.filters.speaker = "A";
    draw();
    expect(document.querySelectorAll("#timeline .blk.dim").length).toBe(0);
    P.filters.markers.add("hot_take");
    draw();
    expect(document.querySelectorAll("#timeline .lane.cat-1 .blk.dim").length).toBe(2);
  });
});

describe("renderTranscript with filters", () => {
  test("a speaker filter shows only that speaker's lines (a merged speaker counts as the survivor)", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.speaker = "A";
    P.renderTranscript(st);
    expect(lines()).toEqual(["utt-u1", "utt-u3"]);
    S.applyEvent(st, "speaker.merged", { fromId: "B", intoId: "A" }, "2026-09-30T10:00:00.000Z", new Set());
    P.renderTranscript(st);
    expect(lines()).toEqual(["utt-u1", "utt-u2", "utt-u3", "utt-u4"]);
  });

  test("a marker filter shows the matching segments' lines only", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.markers.add("hot_take");
    P.renderTranscript(st);
    expect(lines()).toEqual(["utt-u1", "utt-u2"]);
  });

  // B2: with a speaker filter and a label filter together the transcript was empty ("Waiting for speech…")
  test("a speaker filter plus a marker filter shows that speaker's lines in the matching segments", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.markers.add("hot_take");
    P.filters.speaker = "B";
    P.renderTranscript(st);
    expect(lines()).toEqual(["utt-u2"]);
  });

  test("a speaker filter plus a category filter shows that speaker's lines in the matching segments", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.categories.subject = "group:AI";
    P.filters.speaker = "A";
    P.renderTranscript(st);
    expect(lines()).toEqual(["utt-u1"]);
  });
});

describe("renderFilters", () => {
  test("a chip per marker of the set, pressed when filtered; a click toggles the filter and calls onChange", () => {
    const st = show();
    const onChange = vi.fn();
    P.renderFilters(st, onChange);
    const chips = [...document.querySelectorAll<HTMLButtonElement>("#filters .chip")];
    expect(chips.map((c) => c.textContent)).toEqual(aiSet().markers.map((m) => m.name));
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(Array(6).fill("false"));
    expect(chips[1]!.querySelector("use")!.getAttribute("href")).toBe("#i-flame");
    chips[1]!.click();
    expect([...P.filters.markers]).toEqual(["hot_take"]);
    chips[1]!.click();
    expect(P.filters.markers.size).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("the speaker select lists 'All speakers' and every unmerged speaker, and a change sets the filter", () => {
    const st = show();
    S.applyEvent(st, "speaker.created", { id: "C", displayName: "Cat" }, "2026-09-30T10:00:00.000Z", new Set());
    S.applyEvent(st, "speaker.merged", { fromId: "C", intoId: "A" }, "2026-09-30T10:00:00.000Z", new Set());
    P.filters.speaker = "B";
    const onChange = vi.fn();
    P.renderFilters(st, onChange);
    const sel = document.querySelector<HTMLSelectElement>('#filters select[aria-label="Speaker filter"]')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["All speakers", "Ann", "Bob"]);
    // happy-dom ignores an option's selected attribute when choosing a select's value, so read the attribute
    expect([...sel.options].filter((o) => o.hasAttribute("selected")).map((o) => o.value)).toEqual(["B"]);
    sel.value = "A";
    sel.dispatchEvent(new Event("change"));
    expect([P.filters.speaker, onChange.mock.calls.length]).toEqual(["A", 1]);
  });

  test("one select per category: 'All <plural>', each group '(all)', then its options; a change sets the filter", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.categories.subject = "group:AI";
    const onChange = vi.fn();
    P.renderFilters(st, onChange);
    const subject = document.querySelector<HTMLSelectElement>('#filters select[aria-label="Subject filter"]')!;
    const mode = document.querySelector<HTMLSelectElement>('#filters select[aria-label="Mode filter"]')!;
    expect([...subject.options].map((o) => o.textContent)).toEqual(["All subjects", "AI (all)", ...aiSet().categories[0]!.options.map((o) => o.name)]);
    expect([...subject.options].filter((o) => o.hasAttribute("selected")).map((o) => o.value)).toEqual(["group:AI"]);
    expect(mode.options[0]!.textContent).toBe("All modes");
    mode.value = "news";
    mode.dispatchEvent(new Event("change"));
    expect([P.filters.categories.mode, onChange.mock.calls.length]).toEqual(["news", 1]);
  });

  test("Clear shows only while a filter is set, and resets all of them", () => {
    const st = show();
    P.renderFilters(st, () => {});
    expect(document.querySelector("#filters .linkbtn")).toBeNull();
    P.filters.markers.add("hot_take");
    P.filters.speaker = "A";
    P.filters.categories.subject = "tech";
    const onChange = vi.fn();
    P.renderFilters(st, onChange);
    document.querySelector<HTMLButtonElement>("#filters .linkbtn")!.click();
    expect([P.filters.markers.size, P.filters.speaker, P.filters.categories]).toEqual([0, "", {}]);
    expect(onChange).toHaveBeenCalledOnce();
  });

  test("labels off: no chips and no category selects, and the label filters are cleared (the speaker filter is kept)", () => {
    const st = feed(S, [["speaker.created", { id: "A", displayName: "Ann" }]], snapshot({ features: { factcheck: true, labels: false } }));
    P.filters.markers.add("hot_take");
    P.filters.categories.subject = "tech";
    P.filters.speaker = "A";
    P.renderFilters(st, () => {});
    expect(document.querySelectorAll("#filters .chip").length).toBe(0);
    expect(document.querySelectorAll("#filters select").length).toBe(1);
    expect([P.filters.markers.size, P.filters.categories, P.filters.speaker]).toEqual([0, {}, "A"]);
  });

  test("another label set clears the label filters", () => {
    const st = show();
    P.renderFilters(st, () => {});
    P.filters.markers.add("hot_take");
    st.labels.set = { ...aiSet(), id: "other" };
    P.renderFilters(st, () => {});
    expect(P.filters.markers.size).toBe(0);
  });

  test("the chip row keeps its scroll position, scrolls sideways with the wheel, and says when it overflows", () => {
    const st = show();
    P.renderFilters(st, () => {});
    const row = () => document.querySelector<HTMLElement>("#filters .chip-row")!;
    row().scrollLeft = 40;
    P.renderFilters(st, () => {});
    expect(row().scrollLeft).toBe(40);
    Object.defineProperty(row(), "scrollWidth", { value: 500, configurable: true });
    Object.defineProperty(row(), "clientWidth", { value: 200, configurable: true });
    const wheel = new WheelEvent("wheel", { deltaY: 30, deltaX: 0, cancelable: true });
    row().dispatchEvent(wheel);
    expect([wheel.defaultPrevented, row().scrollLeft]).toEqual([true, 70]);
    const sideways = new WheelEvent("wheel", { deltaY: 0, deltaX: 30, cancelable: true });
    row().dispatchEvent(sideways);
    expect(sideways.defaultPrevented).toBe(false);
  });
});
