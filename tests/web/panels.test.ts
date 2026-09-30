// @vitest-environment happy-dom
// The transcript filters (web/src/panels.ts): segmentOf, segmentMatches, renderFilters, and how renderTranscript and the
// timeline use them. docs/architecture.md § Web front end: "A speaker filter shows only that speaker's lines; a marker or
// category filter shows the matching segments' lines and dims the rest of the timeline". Then the rest of the transcript
// (dividers, name tags, missing lines, live text), the speaker window, jumping to a segment, and the fact-check cards.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { feed, flush, installBrowserStubs, layout, loadIndexHtml, makeFakeApi } from "./helpers.ts";
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

// ---------- the rest of the transcript ----------

const T0 = "2026-09-30T10:00:00.000Z";
const rows = () => [...document.querySelectorAll<HTMLElement>("#transcript > div")];
const toastTexts = () => [...document.querySelectorAll("#toasts .toast")].map((t) => `${t.className}|${t.textContent}`);
const el = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

describe("renderTranscript", () => {
  afterEach(() => vi.useRealTimers());

  test("with no session and no lines it invites to start; with a session it waits for speech", () => {
    P.renderTranscript(S.emptyState());
    expect(el("#transcript .empty").textContent).toBe("Start a live session or a replay.");
    P.renderTranscript(feed(S, [], snapshot()));
    expect(el("#transcript .empty").textContent).toBe("Waiting for speech…");
  });

  test("lines are in time order, whatever order they arrived in", () => {
    const st = feed(S, [
      ["speaker.created", { id: "A", displayName: "Ann" }],
      ["utterance", utt("u2", 5_000, 6_000, "A")],
      ["utterance", utt("u1", 1_000, 2_000, "A")],
    ], snapshot());
    P.renderTranscript(st);
    expect(lines()).toEqual(["utt-u1", "utt-u2"]);
  });

  test("a segment's divider comes before its first line: time, the first category in its colour, the second, known markers, mentions", () => {
    const st = show();
    st.segments.get("g1")!.labels = labels("g1", {
      choices: { subject: ["ai_models", 0.9], mode: ["news", 0.3, true] }, markers: ["hot_take", "unknown", "prediction"], mentions: ["OpenAI", "Anthropic"],
    });
    P.renderTranscript(st);
    const div = rows()[0]!;
    expect([div.className, div.id]).toEqual(["segdiv", "seg-g1"]);
    expect(div.querySelector(".t")!.textContent).toBe("0:00");
    const subj = div.querySelector<HTMLElement>(".subj")!;
    expect([subj.textContent, subj.className, subj.getAttribute("style")]).toEqual(["AI models", "subj", "background:#3f7df0"]);
    expect([div.querySelector(".mode")!.textContent, div.querySelector(".mode")!.className]).toEqual(["News", "mode faded"]);
    expect([...div.querySelectorAll(".mk")].map((m) => m.getAttribute("title"))).toEqual(["Hot take", "Prediction"]);
    expect(div.querySelector(".ment")!.textContent).toBe("OpenAI, Anthropic");
    expect(rows()[1]!.id).toBe("utt-u1");
  });

  test("a faded first category is marked; an option the set does not know keeps its id and a fallback colour", () => {
    const st = show();
    st.segments.get("g1")!.labels = labels("g1", { choices: { subject: ["weird_one", 0.2, true] } });
    P.renderTranscript(st);
    const subj = el("#seg-g1 .subj");
    expect([subj.textContent, subj.className, subj.getAttribute("style")]).toEqual(["weird one", "subj faded", "background:#6a7d98"]);
  });

  test("a segment without labels gets a divider with only its time", () => {
    P.renderTranscript(show());
    expect([...el("#seg-g3").children].map((c) => c.className)).toEqual(["t"]);
  });

  test("labels off: dividers carry no category tags", () => {
    const st = show();
    st.session!.features = { factcheck: true, labels: false };
    P.renderTranscript(st);
    expect(document.querySelectorAll("#transcript .subj, #transcript .mode").length).toBe(0);
  });

  test("a speaker's name shows once per run of lines, and again in a new segment", () => {
    const st = feed(S, [
      ["speaker.created", { id: "A", displayName: "Ann" }],
      ["speaker.created", { id: "A2", displayName: "Ann again" }],
      ["speaker.merged", { fromId: "A2", intoId: "A" }],
      ["utterance", utt("u1", 0, 1_000, "A")],
      ["utterance", utt("u2", 1_000, 2_000, "A2")],
      ["utterance", utt("u3", 3_000, 4_000, "A")],
      ["segment.closed", seg("g1", 0, 2_000, ["u1", "u2"])],
      ["segment.closed", seg("g2", 3_000, 4_000, ["u3"])],
    ], snapshot());
    P.renderTranscript(st);
    const who = (id: string) => el(`#utt-${id}`).children[1] as HTMLElement;
    expect([who("u1").tagName, who("u1").className, who("u1").textContent]).toEqual(["BUTTON", "who-tab host", "Ann"]);
    expect([who("u2").tagName, who("u2").textContent]).toEqual(["SPAN", ""]); // a merged speaker is the same run
    expect([who("u3").className, who("u3").textContent]).toEqual(["who-tab host", "Ann"]);
  });

  test("an inferred speaker shows as a muted 'name *', and the next line names its speaker again", () => {
    const st = feed(S, [
      ["speaker.created", { id: "B", displayName: "Bob" }],
      ["utterance", utt("u1", 0, 1_000, "B", { stream: "remote" })],
      ["utterance", utt("u2", 1_000, 2_000, "B", { stream: "remote", speakerInferred: true })],
      ["utterance", utt("u3", 2_000, 3_000, "B", { stream: "remote" })],
    ], snapshot());
    P.renderTranscript(st);
    const who = (id: string) => el(`#utt-${id}`).children[1] as HTMLElement;
    expect([who("u2").className, who("u2").textContent]).toEqual(["who-cont", "Bob *"]);
    expect([who("u3").className, who("u3").textContent]).toEqual(["who-tab remote", "Bob"]);
  });

  test("a row: its id, segment, rounded start, and classes for filler and flagged lines; tags and the flag", () => {
    const st = feed(S, [
      ["speaker.created", { id: "A", displayName: "Ann" }],
      ["utterance", utt("u1", 1234.6, 2_000, "A", { filler: true, tags: ["LOUD"] })],
      ["utterance", utt("u2", 3_000, 4_000, "A", { text: "GPT-6 has 10 trillion parameters" })],
      ["segment.closed", seg("g1", 0, 2_000, ["u1"])],
      ["claim.flagged", { claimId: "c_1", utteranceId: "u2", speakerId: "A", text: "x", priority: 1, s1Version: "s1@1" }],
    ], snapshot());
    P.renderTranscript(st);
    const u1 = el("#utt-u1");
    expect([u1.className, u1.dataset.seg, u1.dataset.start]).toEqual(["utt filler", "g1", "1235"]);
    expect(u1.querySelector(".tag-loud")!.textContent).toBe("LOUD");
    const u2 = el("#utt-u2");
    expect([u2.className, u2.dataset.seg]).toEqual(["utt flagged", ""]);
    expect(u2.querySelector(".flag use")!.getAttribute("href")).toBe("#g-flag");
    expect(u2.querySelector("span.time")!.textContent).toBe("0:03");
  });

  test("in a recording a line's time is a button that plays from there; on air it is plain text", () => {
    const st = show();
    st.session!.status = "archived";
    const onTime = vi.fn();
    P.setTimeClick(onTime);
    P.renderTranscript(st);
    const t = el<HTMLButtonElement>("#utt-u3 button.time.seek");
    expect(t.textContent).toBe("0:12");
    t.click();
    expect(onTime).toHaveBeenCalledWith(12_000);
  });

  test("lines not transcribed keep their place: retrying, or given up (with play from here in a recording)", () => {
    const missing = (status: string) => ({ id: "m1", stream: "host", startMs: 500, endMs: 900, speakerId: "A", status });
    const st = feed(S, [["speaker.created", { id: "A", displayName: "Ann" }], ["utterance", utt("u1", 1_000, 2_000, "A")], ["utterance.failed", missing("retrying")]], snapshot());
    P.renderTranscript(st);
    expect(lines()).toEqual(["utt-m1", "utt-u1"]);
    expect([el("#utt-m1").className, el("#utt-m1 .text").textContent]).toEqual(["utt missing", "Not transcribed yet: the connection dropped. Retrying…"]);
    S.applyEvent(st, "utterance.failed", missing("failed"), T0, new Set());
    P.renderTranscript(st);
    expect(el("#utt-m1 .text").textContent).toBe("Not transcribed.");
    st.session!.status = "archived";
    P.renderTranscript(st);
    expect(el("#utt-m1 .text").textContent).toBe("Not transcribed. Play from here to hear it.");
  });

  test("a missing line that has its text now shows once, as a line", () => {
    const st = feed(S, [["speaker.created", { id: "A", displayName: "Ann" }], ["utterance", utt("u1", 1_000, 2_000, "A")]], snapshot());
    st.missing.set("u1", { id: "u1", stream: "host", startMs: 1_000, endMs: 2_000, speakerId: "A", status: "retrying" });
    P.renderTranscript(st);
    expect(lines()).toEqual(["utt-u1"]);
    expect(el("#utt-u1").className).toBe("utt");
  });

  describe("live text", () => {
    const partial = (itemId: string, stream: "host" | "remote", text: string, o: { final?: boolean } = {}) => ({ itemId, stream, text, utteranceId: null, final: !!o.final });

    test("after the final lines, by arrival; empty ones skipped; named after the stream's only speaker, else Host or Call", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const st = feed(S, [
        ["speaker.created", { id: "A", displayName: "Ann" }],
        ["speaker.created", { id: "B", displayName: "Bob" }],
        ["speaker.created", { id: "C", displayName: "Cat" }],
        ["utterance", utt("u1", 0, 1_000, "A")],
        ["utterance", utt("u2", 1_000, 2_000, "B", { stream: "remote" })],
        ["utterance", utt("u3", 2_000, 3_000, "C", { stream: "remote" })],
      ], snapshot());
      vi.setSystemTime(1000);
      S.applyEvent(st, "utterance.partial", partial("i2", "remote", "and then"), T0, new Set());
      vi.setSystemTime(500);
      S.applyEvent(st, "utterance.partial", partial("i1", "host", "so I"), T0, new Set());
      S.applyEvent(st, "utterance.partial", partial("i3", "host", ""), T0, new Set());
      vi.setSystemTime(1500);
      P.renderTranscript(st);
      const live = [...document.querySelectorAll("#transcript .utt.live")];
      expect(live.map((r) => `${r.querySelector(".who-tab")!.className}|${r.querySelector(".who-tab")!.textContent}|${r.querySelector(".text")!.textContent}`))
        .toEqual(["who-tab host|Ann|so I", "who-tab remote|Call|and then"]);
      expect(live[0]!.querySelector(".livedot")).not.toBeNull();
      expect(rows().at(-1)).toBe(live[1]);
    });

    test("a stream with no line yet is named Host", () => {
      const st = feed(S, [["utterance.partial", partial("i1", "host", "hello")]], snapshot());
      P.renderTranscript(st);
      expect(el("#transcript .utt.live .who-tab").textContent).toBe("Host");
    });

    test("hidden under a label filter; under a speaker filter only a stream whose only speaker matches", () => {
      const st = show();
      S.applyEvent(st, "utterance.partial", partial("i1", "host", "mine"), T0, new Set());
      P.renderFilters(st, () => {});
      P.filters.speaker = "A";
      P.renderTranscript(st);
      expect(document.querySelectorAll("#transcript .utt.live").length).toBe(1);
      P.filters.speaker = "B";
      P.renderTranscript(st);
      expect(document.querySelectorAll("#transcript .utt.live").length).toBe(0);
      P.filters.speaker = "";
      P.filters.markers.add("hot_take");
      P.renderTranscript(st);
      expect(document.querySelectorAll("#transcript .utt.live").length).toBe(0);
    });

    test("a finished partial whose line never came goes after 8 s; an unfinished one stays", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(10_000);
      const st = feed(S, [
        ["utterance.partial", partial("done", "host", "old", { final: true })],
        ["utterance.partial", partial("going", "remote", "still")],
      ], snapshot());
      vi.setSystemTime(18_001);
      P.renderTranscript(st);
      expect([...st.partials.keys()]).toEqual(["going"]);
      expect(document.querySelectorAll("#transcript .utt.live").length).toBe(1);
    });
  });

  test("it follows the newest line when the reader was at the bottom, and leaves them where they are otherwise", () => {
    const st = show();
    const box = el("#transcript");
    layout(box, { scrollHeight: 1000, clientHeight: 500 });
    box.scrollTop = 450;
    P.renderTranscript(st);
    expect(box.scrollTop).toBe(1000);
    box.scrollTop = 0;
    P.renderTranscript(st);
    expect(box.scrollTop).toBe(0);
  });
});

describe("the speaker window (a click on a name)", () => {
  function opened(clicked = "u1") {
    const st = feed(S, [
      ["speaker.created", { id: "A", displayName: "Ann" }],
      ["speaker.created", { id: "B", displayName: "Bob" }],
      ["utterance", utt("u1", 0, 2_000, "A")],
      ["utterance", utt("u2", 2_000, 4_000, "B", { stream: "remote" })],
      ["utterance", utt("u3", 4_000, 7_000, "A", { stream: "remote" })],
    ], snapshot());
    P.renderTranscript(st);
    el<HTMLButtonElement>(`#utt-${clicked} .who-tab`).click();
    return st;
  }
  const dlg = () => el<HTMLDialogElement>("#dlg-speaker");
  const input = () => el<HTMLInputElement>("#speaker-body input");
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("#speaker-body button")];
  const selects = () => [...document.querySelectorAll<HTMLSelectElement>("#speaker-body select")];

  test("says who, how many lines, how long they talked, and on which streams", () => {
    opened();
    expect([dlg().open, el("#h-speaker").textContent, el("#speaker-sub").textContent]).toEqual([true, "Ann", "2 lines · 0:05 talking · on your mic and the call"]);
    expect(input().value).toBe("Ann");
    expect(selects().map((s) => [...s.options].map((o) => o.textContent))).toEqual([["Choose a speaker…", "Bob"], ["Choose a speaker…", "Bob"]]);
  });

  test("a speaker with one line says so; alone, there is no one to merge with", () => {
    const st = feed(S, [["speaker.created", { id: "A", displayName: "Ann" }], ["utterance", utt("u1", 0, 2_000, "A")]], snapshot());
    P.renderTranscript(st);
    el<HTMLButtonElement>("#utt-u1 .who-tab").click();
    expect(el("#speaker-sub").textContent).toBe("1 line · 0:02 talking · on your mic");
    expect(el("#speaker-body p.note").textContent).toBe("No other speaker to merge with.");
  });

  test("a speaker id the state does not know opens nothing", () => {
    const st = feed(S, [["speaker.created", { id: "A", displayName: "Ann" }], ["utterance", utt("u0", 0, 1_000, "A")], ["utterance", utt("u1", 1_000, 2_000, "Z")]], snapshot());
    P.renderTranscript(st);
    expect(el("#utt-u1 .who-tab").textContent).toBe("Z");
    el<HTMLButtonElement>("#utt-u1 .who-tab").click();
    expect(dlg().open).toBe(false);
  });

  // The first line's speaker id is not (yet) in the speaker list: `sp?.id === lastSpeaker` is undefined === undefined
  test.fails("BUG PAN-L1: the first line by a speaker the page does not know yet still shows a name tag (its id)", () => {
    const st = feed(S, [["utterance", utt("u1", 0, 2_000, "Z")]], snapshot());
    P.renderTranscript(st);
    expect(el("#utt-u1 .who-tab").textContent).toBe("Z");
  });

  test("Rename: an empty name asks for one; the same name just closes; a new one renames and says so; Enter does it too", async () => {
    opened();
    input().value = "  ";
    buttons().find((b) => b.textContent === "Rename")!.click();
    expect(toastTexts()).toEqual(["toast error|Type a name first."]);
    input().value = "Ann";
    buttons().find((b) => b.textContent === "Rename")!.click();
    expect([dlg().open, fake.rename!.mock.calls.length]).toEqual([false, 0]);
    opened();
    input().value = "Anna";
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    input().dispatchEvent(enter);
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(fake.rename).toHaveBeenCalledWith("A", "Anna");
    expect(dlg().open).toBe(false);
    expect(toastTexts()[1]).toBe("toast ok|Renamed Ann to Anna");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(fake.rename).toHaveBeenCalledOnce();
  });

  test("'Ann is really…': choosing someone enables the button and says what happens; merging closes the window", async () => {
    opened();
    const [into] = selects();
    const btn = buttons().filter((b) => b.textContent === "Merge")[0]!;
    expect(btn.disabled).toBe(true);
    into!.value = "B";
    into!.dispatchEvent(new Event("change"));
    expect([btn.disabled, btn.textContent]).toEqual([false, "Merge Ann into Bob"]);
    into!.value = "";
    into!.dispatchEvent(new Event("change"));
    expect([btn.disabled, btn.textContent]).toEqual([true, "Merge"]);
    btn.disabled = false; // even if clicked with nothing chosen, nothing merges
    btn.click();
    expect(fake.merge).not.toHaveBeenCalled();
    into!.value = "B";
    into!.dispatchEvent(new Event("change"));
    btn.click();
    await flush();
    expect(fake.merge).toHaveBeenCalledWith("A", "B");
    expect(dlg().open).toBe(false);
    expect(toastTexts()).toEqual(["toast ok|Merged Ann into Bob"]);
  });

  test("'…is really Ann' merges the other way", async () => {
    opened();
    const from = selects()[1]!;
    const btn = buttons().filter((b) => b.textContent === "Merge")[1]!;
    from.value = "B";
    from.dispatchEvent(new Event("change"));
    expect(btn.textContent).toBe("Merge Bob into Ann");
    btn.click();
    await flush();
    expect(fake.merge).toHaveBeenCalledWith("B", "A");
    from.value = "";
    from.dispatchEvent(new Event("change"));
    expect([btn.disabled, btn.textContent]).toEqual([true, "Merge"]);
    btn.disabled = false;
    btn.click();
    expect(fake.merge).toHaveBeenCalledOnce();
  });

  test("an id the speaker list does not have reads as the id in the merge button", () => {
    const st = opened();
    const into = selects()[0]!;
    const ghost = document.createElement("option");
    ghost.value = "G";
    ghost.textContent = "Ghost";
    into.append(ghost);
    into.value = "G";
    into.dispatchEvent(new Event("change"));
    expect(buttons().filter((b) => b.textContent!.startsWith("Merge"))[0]!.textContent).toBe("Merge Ann into G");
    expect(st.speakers.has("G")).toBe(false);
  });

  test("an inferred speaker's 'name *' opens the window too", () => {
    const st = feed(S, [["speaker.created", { id: "A", displayName: "Ann" }], ["utterance", utt("u1", 0, 2_000, "A", { speakerInferred: true })]], snapshot());
    P.renderTranscript(st);
    el<HTMLButtonElement>("#utt-u1 .who-cont").click();
    expect(dlg().open).toBe(true);
  });
});

describe("jumpToSegment", () => {
  test("a segment hidden by the filters says so", () => {
    P.renderTranscript(show());
    P.jumpToSegment("nope");
    expect(toastTexts()).toEqual(["toast error|That segment is hidden by the current filters"]);
  });

  test("closes open windows, scrolls the divider into view, and flashes the segment's lines", () => {
    P.renderTranscript(show());
    el<HTMLDialogElement>("#dlg-insights").showModal();
    el("#utt-u1").classList.add("flash");
    P.jumpToSegment("g1");
    expect(el<HTMLDialogElement>("#dlg-insights").open).toBe(false);
    expect(el("#seg-g1").scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect([...document.querySelectorAll(".flash")].map((e) => e.id)).toEqual(["utt-u1", "utt-u2"]);
  });
});

// ---------- fact-check cards ----------

describe("renderClaims", () => {
  const verdict = (v: string, o: Record<string, unknown> = {}) => ({
    restated_claim: "Restated", verdict: v, correction: "", confidence: "high", false_alarm_reason: "", sources: [], downgraded: false, ...o,
  });
  function claims(extra: ([string, any] | [string, any, string])[] = []) {
    return feed(S, [
      ["speaker.created", { id: "A", displayName: "Ann" }],
      ["utterance", utt("u1", 0, 1_000, "A")],
      ["claim.flagged", { claimId: "c_1", utteranceId: "u1", speakerId: "A", text: "GPT-6 is out", priority: 1, s1Version: "s1@1" }, "2026-09-30T10:00:01.000Z"],
      ...extra,
    ], snapshot());
  }
  const cards = () => [...document.querySelectorAll<HTMLElement>("#claims article.fc")];
  const vw = (i = 0) => cards()[i]!.querySelector(".vw")!.textContent;
  const vms = (i = 0) => [...cards()[i]!.querySelectorAll(".vm")].map((x) => x.textContent);

  test("none yet: why it is empty (fact-checking on or off), no count, no tally", () => {
    P.renderClaims(feed(S, [], snapshot()));
    expect([el("#claims .empty").textContent, el("#claims-count").textContent, el("#tally").children.length]).toEqual(["Checkable claims appear here as they are said.", "", 0]);
    P.renderClaims(feed(S, [], snapshot({ features: { factcheck: false, labels: true } })));
    expect(el("#claims .empty").textContent).toBe("Fact-checking is off for this session: it was turned off when the session started.");
  });

  test("the most recently active first, then the higher id (c_10 before c_9); the count", () => {
    const st = claims();
    const base = st.claims.get("c_1")!;
    st.claims.set("c_9", { ...base, id: "c_9", text: "nine", activity: "2026-09-30T09:00:00.000Z" });
    st.claims.set("c_10", { ...base, id: "c_10", text: "ten", activity: "2026-09-30T09:00:00.000Z" });
    st.claims.set("c_0", { ...base, id: "c_0", text: "none", activity: undefined });
    st.claims.set("c_2", { ...base, id: "c_2", text: "latest", activity: "2026-09-30T11:00:00.000Z" });
    P.renderClaims(st);
    expect(cards().map((c) => c.querySelector("blockquote")!.textContent)).toEqual(["“latest”", "“GPT-6 is out”", "“ten”", "“nine”", "“none”"]);
    expect(el("#claims-count").textContent).toBe("5");
  });

  test("queued: 'Queued', waiting; the first step is current; no dispute yet", () => {
    P.renderClaims(claims());
    expect([cards()[0]!.className, vw(), vms()]).toEqual(["fc v-queued", "Queued", ["Waiting for research"]]);
    const steps = [...cards()[0]!.querySelectorAll("ol.steps li")];
    expect(steps.map((s) => s.className)).toEqual(["done cur", "", ""]);
    expect(steps.map((s) => s.textContent)).toEqual(["queued", "researching", "verdict"]);
    expect(cards()[0]!.querySelector("ol.steps")!.getAttribute("aria-label")).toBe("Status: queued");
    expect(cards()[0]!.querySelector(".fc-foot")).toBeNull();
  });

  test("researching: 'Checking'; the second step is current", () => {
    P.renderClaims(claims([["claim.researching", { claimId: "c_1" }]]));
    expect([cards()[0]!.className, vw(), vms()]).toEqual(["fc v-researching", "Checking", ["Researching"]]);
    expect([...cards()[0]!.querySelectorAll("ol.steps li")].map((s) => s.className)).toEqual(["done", "done cur", ""]);
  });

  test("a verdict: its word, the confidence capitalised, no source found, the research time; every step done", () => {
    P.renderClaims(claims([["claim.verdict", { claimId: "c_1", verdict: verdict("contradicted", { downgraded: true }), grade: "good_flag", latencyMs: 2300 }]]));
    expect([cards()[0]!.className, vw(), vms()]).toEqual(["fc v-contradicted", "False", ["High confidence", "No source found", "2.3 s"]]);
    expect([...cards()[0]!.querySelectorAll("ol.steps li")].map((s) => s.className)).toEqual(["done", "done", "done cur"]);
    expect(cards()[0]!.querySelector("p.restated")!.textContent).toBe("Restated");
    expect(cards()[0]!.querySelector("p.correction")).toBeNull();
    expect(cards()[0]!.querySelector(".sources")).toBeNull();
  });

  test("each verdict's word; an unknown one made readable; no latency and an empty confidence show nothing extra", () => {
    const words: string[] = [];
    for (const v of ["supported", "misleading", "unverifiable", "not_a_claim", "weird_one"]) {
      P.renderClaims(claims([["claim.verdict", { claimId: "c_1", verdict: verdict(v, { confidence: "" }), latencyMs: 0 }]]));
      words.push(vw());
      expect(vms()).toEqual([" confidence"]);
    }
    expect(words).toEqual(["Supported", "Misleading", "Unverifiable", "Not a claim", "weird one"]);
  });

  test("dropped: 'Dropped' with the reason made readable (or nothing), and no steps", () => {
    P.renderClaims(claims([["claim.dropped", { claimId: "c_1", reason: "not_checkable" }]]));
    expect([vw(), vms(), cards()[0]!.querySelector("ol.steps")]).toEqual(["Dropped", ["not checkable"], null]);
    P.renderClaims(claims([["claim.dropped", { claimId: "c_1" }]]));
    expect(vms()).toEqual([""]);
  });

  test("the card: the speaker in their stream's colour, the quote, the correction, repeats, and only web sources", () => {
    const st = claims([
      ["claim.verdict", { claimId: "c_1", verdict: verdict("misleading", { correction: "It is not out", sources: [
        { url: "https://a.example/x", title: "A" }, { url: "http://b.example", title: "" }, { url: "javascript:alert(1)", title: "bad" }, { url: "file:///etc/passwd", title: "f" },
      ] }) }],
      ["claim.repeat", { claimId: "c_1", utteranceId: "u5" }],
      ["claim.duplicate", { claimId: "c_1", utteranceId: "u6" }],
      ["claim.duplicate", { claimId: "c_1", utteranceId: "u7" }],
    ]);
    P.renderClaims(st);
    const c = cards()[0]!;
    expect([c.querySelector(".who-tab")!.className, c.querySelector(".who-tab")!.textContent]).toEqual(["who-tab host", "Ann"]);
    expect(c.querySelector("blockquote")!.textContent).toBe("“GPT-6 is out”");
    expect(c.querySelector("p.correction")!.textContent).toBe("It is not out");
    expect(c.querySelector(".badge.repeat")!.textContent).toBe("Repeat ×3");
    expect([...c.querySelectorAll(".sources a")].map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]))
      .toEqual([["A", "https://a.example/x", "_blank", "noopener noreferrer"], ["http://b.example", "http://b.example", "_blank", "noopener noreferrer"]]);
    st.claims.get("c_1")!.verdict!.sources = [{ url: "javascript:x", title: "x" }];
    P.renderClaims(st);
    expect([cards()[0]!.querySelector(".sources .lbl")!.textContent, cards()[0]!.querySelectorAll(".sources a").length]).toEqual(["Sources", 0]);
  });

  test("a claim on a line the page does not have is on the call; an unknown speaker shows their id", () => {
    const st = claims();
    st.claims.get("c_1")!.utteranceId = "gone";
    st.claims.get("c_1")!.speakerId = "Z";
    P.renderClaims(st);
    expect([cards()[0]!.querySelector(".who-tab")!.className, cards()[0]!.querySelector(".who-tab")!.textContent]).toEqual(["who-tab remote", "Z"]);
  });

  test("a disputed verdict is marked, with a badge and no dispute button", () => {
    P.renderClaims(claims([["claim.verdict", { claimId: "c_1", verdict: verdict("supported") }], ["claim.disputed", { claimId: "c_1" }]]));
    expect([cards()[0]!.className, cards()[0]!.querySelector(".badge.dispute")!.textContent, cards()[0]!.querySelector(".fc-foot")]).toEqual(["fc v-supported disputed", "Host disputes", null]);
  });

  test("Host disputes asks why in the page's dialog, and sends the trimmed note, none, or nothing when cancelled", async () => {
    P.renderClaims(claims([["claim.verdict", { claimId: "c_1", verdict: verdict("contradicted") }]]));
    const dlg = el<HTMLDialogElement>("#dlg-ask");
    const dispute = async (answer: string | null) => {
      el<HTMLButtonElement>("#claims .fc-foot .linkbtn").click();
      expect([el("#h-ask").textContent, el("#ask-ok").textContent, el<HTMLInputElement>("#ask-input").hidden]).toEqual(["Host disputes this verdict", "Dispute", false]);
      if (answer === null) dlg.close("cancel");
      else { el<HTMLInputElement>("#ask-input").value = answer; dlg.close("ok"); }
      await flush();
    };
    await dispute("  why not ");
    await dispute("   ");
    await dispute(null);
    expect(fake.override!.mock.calls).toEqual([["c_1", "why not"], ["c_1", undefined]]);
  });

  test("the tally counts false, misleading, supported, and checking (queued or researching), leaving out zeros", () => {
    const st = claims();
    const add = (id: string, o: Record<string, unknown>) => st.claims.set(id, { ...st.claims.get("c_1")!, id, ...o });
    add("c_2", { status: "verdict", verdict: verdict("contradicted") });
    add("c_3", { status: "verdict", verdict: verdict("contradicted") });
    add("c_4", { status: "verdict", verdict: verdict("supported") });
    add("c_5", { status: "researching" });
    add("c_6", { status: "dropped" });
    P.renderClaims(st);
    const spans = [...document.querySelectorAll("#tally > span")];
    expect(spans.map((s) => s.textContent)).toEqual(["2 false", "1 supported", "2 checking"]);
    expect(spans.map((s) => s.querySelector("i")!.getAttribute("style"))).toEqual(["background:var(--bad)", "background:var(--good)", "background:var(--accent)"]);
    add("c_7", { status: "verdict", verdict: verdict("misleading") });
    P.renderClaims(st);
    expect([...document.querySelectorAll("#tally > span")].map((s) => s.textContent)).toEqual(["2 false", "1 misleading", "1 supported", "2 checking"]);
    expect(document.querySelectorAll("#tally i")[1]!.getAttribute("style")).toBe("background:var(--warn)");
  });
});
