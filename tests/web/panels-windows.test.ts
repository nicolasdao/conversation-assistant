// @vitest-environment happy-dom
// The settings windows in web/src/panels.ts: Speakers (rename, merge, duplicate suggestions), Insights (Overview stats,
// Fact-checker, Log), and the Recordings library. docs/architecture.md § Web front end, docs/recordings.md.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { feed, flush, installBrowserStubs, loadIndexHtml, makeFakeApi } from "./helpers.ts";
import { recording, snapshot, trackDocumentListeners } from "./helpers-panels.ts";

const fake = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<object>()), api: fake }));
vi.mock("../../web/src/transfer.ts", () => ({ openExport: vi.fn(), openImport: vi.fn() }));

let P: typeof import("../../web/src/panels.ts");
let S: typeof import("../../web/src/state.ts");
let transfer: { openExport: ReturnType<typeof vi.fn>; openImport: ReturnType<typeof vi.fn> };
let untrack: () => void;

beforeEach(async () => {
  vi.resetModules();
  loadIndexHtml();
  installBrowserStubs();
  localStorage.clear();
  Object.assign(fake, makeFakeApi((await vi.importActual<typeof import("../../web/src/api.ts")>("../../web/src/api.ts")).api));
  untrack = trackDocumentListeners();
  P = await import("../../web/src/panels.ts");
  S = await import("../../web/src/state.ts");
  transfer = (await import("../../web/src/transfer.ts")) as never;
});

afterEach(() => {
  untrack();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const el = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const all = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const toasts = () => all("#toasts .toast").map((t) => `${t.className}|${t.textContent}`);
const ask = () => el<HTMLDialogElement>("#dlg-ask");
const answer = async (ok: boolean) => { ask().close(ok ? "ok" : "cancel"); await flush(); };

function speakers(n = 2, session: Record<string, unknown> = {}) {
  const names = ["Ann", "Bob", "Cat"];
  return feed(S, names.slice(0, n).map((name, i) => ["speaker.created", { id: name[0], displayName: name }] as [string, any]), snapshot(session));
}

// ---------- Speakers ----------

describe("renderSpeakers", () => {
  const rowOf = (id: string) => all(".sp-row").find((r) => r.querySelector(".id")!.textContent === id)!;
  const btn = (row: HTMLElement, label: string) => [...row.querySelectorAll("button")].find((b) => b.textContent === label)!;

  test("no speaker yet: says they appear as they talk, without suggestions", () => {
    P.renderSpeakers(speakers(0));
    expect([el("#speakers .empty").textContent, document.querySelector("#speakers .suggest")]).toEqual(["Speakers appear as they talk.", null]);
  });

  test("one speaker: no duplicate suggestions; two: the suggestions first", () => {
    P.renderSpeakers(speakers(1));
    expect(document.querySelector("#speakers .suggest")).toBeNull();
    P.renderSpeakers(speakers(2));
    expect(el("#speakers").firstElementChild!.className).toBe("suggest");
  });

  test("a row per unmerged speaker: id, name field, Rename, 'Merge into…' the others, Merge, and talk time from the stats", () => {
    const st = speakers(3);
    st.speakers.get("C")!.mergedInto = "A";
    st.stats = { speakers: [{ speakerId: "A", talkMs: 65_000 }] } as never;
    P.renderSpeakers(st);
    expect(all(".sp-row .id").map((x) => [x.textContent, x.title])).toEqual([["A", "A"], ["B", "B"]]);
    const a = rowOf("A");
    const input = a.querySelector("input")!;
    expect([input.value, input.getAttribute("aria-label")]).toEqual(["Ann", "Rename A"]);
    expect([...a.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Merge into…", "Bob"]);
    expect([a.querySelector(".talk")!.textContent, rowOf("B").querySelector(".talk")!.textContent]).toEqual(["1:05 talk", ""]);
  });

  test("while a field in the window is being typed in, nothing re-renders", () => {
    const st = speakers(2);
    P.renderSpeakers(st);
    const input = rowOf("A").querySelector("input")!;
    input.focus();
    st.speakers.get("A")!.displayName = "Changed";
    P.renderSpeakers(st);
    expect(rowOf("A").querySelector("input")).toBe(input);
    input.blur();
    P.renderSpeakers(st);
    expect(rowOf("A").querySelector("input")!.value).toBe("Changed");
  });

  test("Rename: empty asks for a name, the same name says so, a new one renames (Enter too)", async () => {
    P.renderSpeakers(speakers(2));
    const a = rowOf("A");
    const input = a.querySelector("input")!;
    input.value = " ";
    btn(a, "Rename").click();
    input.value = "Ann";
    btn(a, "Rename").click();
    input.value = "Anna";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(fake.rename!.mock.calls).toEqual([["A", "Anna"]]);
    expect(toasts()).toEqual(["toast error|Type a name first.", "toast error|Ann already has that name.", "toast ok|Renamed Ann to Anna"]);
  });

  test("Merge: nothing chosen says so; otherwise it asks, and merges only when confirmed", async () => {
    P.renderSpeakers(speakers(2));
    const a = rowOf("A");
    btn(a, "Merge").click();
    await flush();
    expect(toasts()).toEqual(["toast error|Choose who to merge Ann into first."]);
    a.querySelector("select")!.value = "B";
    btn(a, "Merge").click();
    await flush();
    expect([el("#h-ask").textContent, el("#ask-message").textContent, el("#ask-ok").textContent]).toEqual(["Merge Ann into Bob?", "Their utterances will be relabelled as Bob.", "Merge"]);
    await answer(false);
    expect(fake.merge).not.toHaveBeenCalled();
    btn(a, "Merge").click();
    await flush();
    await answer(true);
    expect(fake.merge).toHaveBeenCalledWith("A", "B");
    expect(toasts()[1]).toBe("toast ok|Merged Ann into Bob");
  });

  test("a merge target the list no longer has is named by its id", async () => {
    const st = speakers(2);
    P.renderSpeakers(st);
    st.speakers.delete("B");
    rowOf("A").querySelector("select")!.value = "B";
    btn(rowOf("A"), "Merge").click();
    await flush();
    expect(el("#h-ask").textContent).toBe("Merge Ann into B?");
    await answer(false);
  });
});

describe("duplicate speaker suggestions", () => {
  const sugg = (fromId: string, intoId: string, confidence: "high" | "medium" | "low", o: Record<string, unknown> = {}) => ({
    fromId, fromName: `${fromId}-name`, fromTalkMs: 1000, intoId, intoName: `${intoId}-name`, intoTalkMs: 2000, stream: "remote", similarity: 0.87, confidence, reason: "same voice", ...o,
  });
  const result = (list: unknown[], remote = 3) => ({ suggestions: list, voices: { host: 1, remote } });
  const find = () => el<HTMLButtonElement>(".suggest-head .btn.primary");
  const voices = () => el<HTMLSelectElement>("#suggest-voices");
  const selectedVoices = () => [...voices().options].filter((o) => o.hasAttribute("selected")).map((o) => o.value);

  test("before any analysis: 2 on the call by default, options 1–4 and any, and Find duplicates", () => {
    P.renderSpeakers(speakers(2));
    expect([...voices().options].map((o) => `${o.value}:${o.textContent}`)).toEqual(["1:1 on the call", "2:2 on the call", "3:3 on the call", "4:4 on the call", "0:Any number on the call"]);
    expect(selectedVoices()).toEqual(["2"]);
    expect([find().textContent, find().disabled]).toEqual(["Find duplicates", false]);
  });

  test("while analysing: the button waits and a note says how long; then the result, and 'Analyse again'", async () => {
    let resolve!: (v: unknown) => void;
    fake.suggestMerges!.mockReturnValue(new Promise((r) => { resolve = r; }));
    P.renderSpeakers(speakers(2));
    find().click();
    expect([find().textContent, find().disabled, voices().disabled]).toEqual(["Analysing voices…", true, true]);
    expect(el(".suggest > p.note").textContent).toMatch(/^Listening to each speaker's lines/);
    expect(fake.suggestMerges).toHaveBeenCalledWith(undefined);
    resolve(result([]));
    await flush();
    expect([find().textContent, el(".suggest-none").textContent]).toEqual(["Analyse again", "No duplicates: every speaker sounds distinct, and each stream has no more voices than expected."]);
    expect(selectedVoices()).toEqual(["3"]);
  });

  test("changing the number on the call analyses again with it", async () => {
    fake.suggestMerges!.mockResolvedValue(result([], 0));
    P.renderSpeakers(speakers(2));
    voices().value = "0";
    voices().dispatchEvent(new Event("change"));
    await flush();
    expect(fake.suggestMerges).toHaveBeenCalledWith(0);
    expect(selectedVoices()).toEqual(["0"]);
  });

  test("an analysis that fails shows why", async () => {
    fake.suggestMerges!.mockRejectedValue(new Error("no voiceprints"));
    P.renderSpeakers(speakers(2));
    find().click();
    await flush();
    expect([el(".suggest .error-text").textContent, find().disabled]).toEqual(["no voiceprints", false]);
    fake.suggestMerges!.mockRejectedValue("plain");
    find().click();
    await flush();
    expect(el(".suggest .error-text").textContent).toBe("plain");
  });

  test("a suggestion: who into whom, its confidence, the voice match, and why", async () => {
    fake.suggestMerges!.mockResolvedValue(result([sugg("B", "A", "high", { stream: "host" }), sugg("C", "A", "low", { similarity: null, reason: "too short" })]));
    P.renderSpeakers(speakers(2));
    find().click();
    await flush();
    expect(all(".sugg").map((s) => [s.className, s.querySelector(".sugg-names")!.textContent, s.querySelector(".sugg-conf")!.textContent, s.querySelector(".sugg-score")!.textContent, s.querySelector(".sugg-why")!.textContent]))
      .toEqual([
        ["sugg c-high", "B-name→A-name", "High confidence", "voice match 87%", "Your mic: same voice."],
        ["sugg c-low", "C-name→A-name", "Low confidence", "no voiceprint", "The call: too short."],
      ]);
  });

  test("a suggestion's Merge merges it, drops it from the list, and says so", async () => {
    fake.suggestMerges!.mockResolvedValue(result([sugg("B", "A", "medium"), sugg("C", "A", "high")]));
    const st = speakers(2);
    P.renderSpeakers(st);
    find().click();
    await flush();
    all<HTMLButtonElement>(".sugg button")[0]!.click();
    await flush();
    expect(fake.merge).toHaveBeenCalledWith("B", "A");
    expect(all(".sugg .sugg-names").map((n) => n.textContent)).toEqual(["C-name→A-name"]);
    expect(toasts()).toEqual(["toast ok|Merged B-name into A-name"]);
  });

  test("a merge that fails says so and stays listed, with no success toast", async () => {
    fake.suggestMerges!.mockResolvedValue(result([sugg("B", "A", "high")]));
    fake.merge!.mockRejectedValueOnce(new Error("gone")).mockRejectedValueOnce("plain");
    P.renderSpeakers(speakers(2));
    find().click();
    await flush();
    all<HTMLButtonElement>(".sugg button")[0]!.click();
    await flush();
    all<HTMLButtonElement>(".sugg button")[0]!.click();
    await flush();
    expect(toasts()).toEqual(["toast error|Could not merge B-name into A-name: gone", "toast error|Could not merge B-name into A-name: plain"]);
    expect(all(".sugg").length).toBe(1);
  });

  test("'Merge N high & medium' shows only when some but not all are sure, asks, and merges only those", async () => {
    fake.suggestMerges!.mockResolvedValue(result([sugg("B", "A", "high"), sugg("C", "A", "low")]));
    P.renderSpeakers(speakers(2));
    find().click();
    await flush();
    const sure = all<HTMLButtonElement>(".suggest .row.end button");
    expect(sure.map((b) => b.textContent)).toEqual(["Merge 1 high & medium", "Merge all 2"]);
    sure[0]!.click();
    await flush();
    expect(el("#h-ask").textContent).toBe("Merge 1 high and medium confidence suggestion?");
    await answer(false);
    expect(fake.merge).not.toHaveBeenCalled();
    all<HTMLButtonElement>(".suggest .row.end button")[0]!.click();
    await flush();
    await answer(true);
    expect(fake.merge!.mock.calls).toEqual([["B", "A"]]);
  });

  test("'Merge all N' warns about low-confidence ones, then merges every one ('Merged 2 speakers')", async () => {
    fake.suggestMerges!.mockResolvedValue(result([sugg("B", "A", "low"), sugg("C", "A", "low"), sugg("D", "A", "high")]));
    P.renderSpeakers(speakers(2));
    find().click();
    await flush();
    const mergeAll = () => all<HTMLButtonElement>(".suggest .row.end button").at(-1)!;
    expect(all(".suggest .row.end button").map((b) => b.textContent)).toEqual(["Merge 1 high & medium", "Merge all 3"]);
    mergeAll().click();
    await flush();
    expect([el("#h-ask").textContent, el("#ask-message").textContent]).toEqual(["Merge all 3 suggestions?", "2 of them are low confidence: check the transcript afterwards."]);
    await answer(false);
    expect(fake.merge).not.toHaveBeenCalled();
    fake.merge!.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(undefined);
    mergeAll().click();
    await flush();
    await answer(true);
    expect(fake.merge).toHaveBeenCalledTimes(3);
    expect(toasts().at(-1)).toBe("toast ok|Merged 2 speakers");
  });

  test("the warning in the singular, or none when all are sure; no 'high & medium' button then", async () => {
    fake.suggestMerges!.mockResolvedValue(result([sugg("B", "A", "low")]));
    P.renderSpeakers(speakers(2));
    find().click();
    await flush();
    expect(all(".suggest .row.end button").map((b) => b.textContent)).toEqual(["Merge all 1"]);
    all<HTMLButtonElement>(".suggest .row.end button")[0]!.click();
    await flush();
    expect([el("#h-ask").textContent, el("#ask-message").textContent]).toEqual(["Merge all 1 suggestion?", "1 of them is low confidence: check the transcript afterwards."]);
    await answer(false);
    fake.suggestMerges!.mockResolvedValue(result([sugg("B", "A", "high")]));
    find().click();
    await flush();
    all<HTMLButtonElement>(".suggest .row.end button")[0]!.click();
    await flush();
    expect(el("#ask-message").textContent).toBe("Every one is high or medium confidence.");
    await answer(false);
  });

  test("the result stays while the window re-renders, even down to one speaker, and is forgotten for another session", async () => {
    fake.suggestMerges!.mockResolvedValue(result([sugg("B", "A", "high")]));
    P.renderSpeakers(speakers(2));
    find().click();
    await flush();
    P.renderSpeakers(speakers(1));
    expect(all(".sugg").length).toBe(1);
    P.renderSpeakers(speakers(2, { id: "s2" }));
    expect([document.querySelector(".sugg"), find().textContent]).toEqual([null, "Find duplicates"]);
  });
});

// ---------- Insights: Fact-checker ----------

describe("renderS1", () => {
  const fcOff = () => feed(S, [], snapshot({ features: { factcheck: false, labels: true } }));

  test("fact-checking off: System 1 does not run", async () => {
    await P.renderS1(fcOff());
    expect(el("#s1 .empty").textContent).toBe("Fact-checking is off for this session, so System 1 does not run.");
  });

  test("while its select is in use, nothing re-renders", async () => {
    const st = feed(S, [], snapshot());
    await P.renderS1(st);
    const sel = el<HTMLSelectElement>("#rollback");
    sel.focus();
    await P.renderS1(fcOff());
    expect(el("#rollback")).toBe(sel);
  });

  test("the active version, memory questions, and five counters", async () => {
    const st = feed(S, [
      ["claim.flagged", { claimId: "c_1", utteranceId: "u", speakerId: "A", text: "x", priority: 1, s1Version: "s1@1" }],
      ["claim.flagged", { claimId: "c_2", utteranceId: "u", speakerId: "A", text: "y", priority: 1, s1Version: "s1@1" }],
      ["claim.flagged", { claimId: "c_3", utteranceId: "u", speakerId: "A", text: "z", priority: 1, s1Version: "s1@1" }],
      ["claim.verdict", { claimId: "c_1", verdict: {}, grade: "good_flag" }],
      ["claim.verdict", { claimId: "c_2", verdict: {}, grade: "false_alarm" }],
      ["claim.verdict", { claimId: "c_3", verdict: {}, grade: "false_alarm" }],
      ["claim.disputed", { claimId: "c_3" }],
      ["claim.repeat", { claimId: "c_1", utteranceId: "u9" }],
      ["audit", { misses: [{}, {}] }],
      ["s1.memory", { size: 2 }],
    ], snapshot());
    st.s1.active = "s1@3";
    await P.renderS1(st);
    expect(el("#s1 .kv").textContent).toBe("System 1 s1@3 · 2 memory questions");
    expect(el("#s1 .kv strong").textContent).toBe("s1@3");
    expect(all("#s1 .counter").map((c) => `${c.className}|${c.querySelector(".n")!.textContent}|${c.querySelector(".k")!.textContent}`)).toEqual([
      "counter |3|Flags", "counter good|1|Good flags", "counter bad|1|False alarms", "counter bad|2|Misses", "counter |1|Repeats",
    ]);
    st.s1.memorySize = 1;
    await P.renderS1(st);
    expect(el("#s1 .kv").textContent).toBe("System 1 s1@3 · 1 memory question");
  });

  test("the totals from the stats: verdicts without zeros (unknown ones raw), System 2's research, rewrites", async () => {
    const st = feed(S, [], snapshot());
    st.stats = { factcheck: { verdicts: { contradicted: 2, supported: 1, misleading: 0, odd: 1 }, researched: 3, duplicates: 1, promoted: 1 } } as never;
    await P.renderS1(st);
    expect(all("#s1 .fc-totals dd").map((d) => d.textContent)).toEqual(["False 2 · Supported 1 · odd 1", "3 researched · 1 duplicates · 0 dropped", "1 promoted · 0 rejected"]);
    st.stats = { factcheck: {} } as never;
    await P.renderS1(st);
    expect(all("#s1 .fc-totals dd").map((d) => d.textContent)).toEqual(["None yet", "0 researched · 0 duplicates · 0 dropped", "0 promoted · 0 rejected"]);
    st.stats = null;
    await P.renderS1(st);
    expect(document.querySelector("#s1 .fc-totals")).toBeNull();
  });

  test("the last rewrite: its outcome, versions, gate, rationale, and errors; none yet says so", async () => {
    const st = feed(S, [], snapshot());
    await P.renderS1(st);
    expect(el("#s1 p.note").textContent).toBe("No rewrite yet: System 2 rewrites System 1 after enough false alarms or misses.");
    S.applyEvent(st, "s1.version", { active: "s1@2", candidate: "s1@3", outcome: "gate_failed", rationale: "Too many misses", gate: { G: 10, G2: 8, F: 4, F2: 1, M: 3, M2: 2 }, errors: ["a", "b"] }, "2026-09-30T10:00:00.000Z", new Set());
    await P.renderS1(st);
    const o = el("#s1 .outcome");
    expect(o.className).toBe("outcome gate_failed");
    expect([o.querySelector(".stamp")!.firstChild!.textContent, o.querySelector(".stamp small")!.textContent]).toEqual(["gate failed", "s1@3 → active s1@2"]);
    expect([...o.querySelectorAll(".gate span")].map((s) => s.textContent)).toEqual(["Good kept 8/10", "False alarms left 1/4", "Misses caught 2/3"]);
    expect([o.querySelector(".txt > span")!.textContent, o.querySelector(".error-text")!.textContent]).toEqual(["Too many misses", "a; b"]);
    S.applyEvent(st, "s1.version", { active: "s1@2", candidate: null, outcome: "promoted", rationale: "", gate: null, errors: null }, "2026-09-30T10:01:00.000Z", new Set());
    await P.renderS1(st);
    expect([el("#s1 .stamp small").textContent, document.querySelector("#s1 .gate"), document.querySelector("#s1 .outcome .error-text"), el("#s1 .txt").children.length]).toEqual(["active s1@2", null, null, 0]);
  });

  test("Roll back offers the first version and every promoted one (else just the active one), and rolls back", async () => {
    const st = feed(S, [], snapshot());
    await P.renderS1(st);
    expect([...el<HTMLSelectElement>("#rollback").options].map((o) => o.value)).toEqual(["s1@1"]);
    st.s1.versions = [
      { id: "s1@1", parent: null, status: "active", kind: "", rationale: "", gate: null, errors: null },
      { id: "s1@2", parent: "s1@1", status: "rejected", kind: "", rationale: "", gate: null, errors: null },
      { id: "s1@3", parent: "s1@1", status: "promoted", kind: "", rationale: "", gate: null, errors: null },
    ];
    st.s1.active = "s1@3";
    await P.renderS1(st);
    const sel = el<HTMLSelectElement>("#rollback");
    expect([...sel.options].map((o) => `${o.value}${o.hasAttribute("selected") ? "*" : ""}`)).toEqual(["s1@1", "s1@3*"]);
    sel.value = "s1@1";
    [...document.querySelectorAll<HTMLButtonElement>("#s1 button")].find((b) => b.textContent === "Roll back")!.click();
    await flush();
    expect(fake.rollback).toHaveBeenCalledWith("s1@1");
    expect(toasts()).toEqual(["toast ok|Rolled back to s1@1"]);
  });
});

// ---------- Insights: Overview ----------

describe("renderStats", () => {
  function withStats(over: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
    const st = feed(S, [["speaker.created", { id: "A", displayName: "Ann" }]], snapshot(session));
    st.stats = {
      version: 2, index: { name: "Off-topic", description: "time spent on personal life and other topics", share: 0.42 }, roganIndex: 0.42, labelledMs: 60_000,
      categories: [
        { id: "subject", name: "Subject", split: [{ option: "tech", ms: 20_000, share: 0.25 }, { option: "ai_models", ms: 60_000, share: 0.75 }] },
        { id: "mode", name: "Mode", split: [] },
        { id: "gone", name: "Gone", split: [{ option: "x", ms: 1, share: 1 }] },
      ],
      speakers: [
        { speakerId: "A", displayName: "Ann", talkMs: 65_000, markers: { disagreement: 2, unknown: 1 }, scores: { heat: 1.84, hype: null, other: 2 } },
        { speakerId: "Z", displayName: "Zed", talkMs: 1_000, markers: {}, scores: {} },
      ],
      lists: [
        { markerId: "prediction", items: [{ segmentId: "g1", text: "AGI by 2030" }, { segmentId: "g2", text: "" }] },
        { markerId: "clip_worthy", items: [] },
        { markerId: "unknown", items: [{ segmentId: "g3", text: "x" }] },
      ],
      ...over,
    } as never;
    return st;
  }

  test("no stats yet: they arrive every minute", () => {
    P.renderStats(feed(S, [], snapshot()));
    expect(el("#stats .empty").textContent).toBe("Stats arrive every minute and at the end of the show.");
  });

  test("the set's index is the big number", () => {
    P.renderStats(withStats());
    expect([el("#stats .big .n").textContent, el("#stats .big .k").textContent]).toEqual(["42%", "Off-topic index: time spent on personal life and other topics"]);
    P.renderStats(withStats({ index: null }));
    expect(document.querySelector("#stats .big")).toBeNull();
  });

  test("each category the set knows with a split: a bar, largest first, in its options' colours, and keys", () => {
    P.renderStats(withStats());
    expect(all("#stats .split-stat h3").map((x) => x.textContent)).toEqual(["Subject"]);
    const bar = el("#stats .split-bar");
    expect(bar.getAttribute("aria-label")).toBe("AI models 75%, Tech 25%");
    expect([...bar.children].map((s) => [s.getAttribute("style"), s.getAttribute("title")])).toEqual([
      ["width:75.00%;background:#3f7df0", "AI models: 75% · 1:00"],
      ["width:25.00%;background:#1fa89a", "Tech: 25% · 0:20"],
    ]);
    expect(all("#stats .split-keys span").map((s) => s.textContent)).toEqual(["AI models 75%", "Tech 25%"]);
  });

  test("the table: each speaker's talk time, each per-speaker marker the set has, and each score's average", () => {
    P.renderStats(withStats());
    expect(all("#stats table th").map((x) => x.textContent)).toEqual(["Speaker", "Talk", "Disagreements", "Heat", "Hype"]);
    expect(all("#stats tbody tr").map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ["Ann", "1:05", "2", "1.8 / 4", "–"],
      ["Z", "0:01", "0", "–", "–"],
    ]);
  });

  test("one list per listed marker the set has: each entry jumps to its segment; an empty one says none yet", () => {
    P.renderStats(withStats());
    expect(all("#stats .lists h3").map((x) => x.textContent)).toEqual(["Prediction", "Clip-worthy"]);
    const links = all<HTMLAnchorElement>("#stats .lists a");
    expect(links.map((a) => a.textContent)).toEqual(["AGI by 2030", "g2"]);
    expect(el("#stats .lists p.note").textContent).toBe("None yet");
    const click = new MouseEvent("click", { cancelable: true });
    links[0]!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(toasts()).toEqual(["toast error|That segment is hidden by the current filters"]);
    P.renderStats(withStats({ lists: [] }));
    expect(document.querySelector("#stats .lists")).toBeNull();
  });

  test("labels off: no splits, and only talk time", () => {
    P.renderStats(withStats({ speakers: [] }, { features: { factcheck: true, labels: false } }));
    expect([document.querySelector("#stats .split-stat"), all("#stats table th").map((x) => x.textContent)]).toEqual([null, ["Speaker", "Talk"]]);
    expect(document.querySelector("#stats .lists h3")).toBeNull();
  });
});

describe("renderErrors", () => {
  test("none: 'No errors.' and no count", () => {
    el("#log-count").classList.add("bad");
    P.renderErrors(S.emptyState());
    expect([el("#errors .empty").textContent, el("#log-count").textContent, el("#log-count").classList.contains("bad")]).toEqual(["No errors.", "", false]);
  });

  test("errors: the count in red, and one row each with its component, local time, and message", () => {
    const st = S.emptyState();
    const at = "2026-09-30T10:11:12.000Z";
    st.errors = [{ component: "jev", message: "timeout", at }, { component: "s2", message: "402", at }];
    P.renderErrors(st);
    expect([el("#log-count").textContent, el("#log-count").classList.contains("bad")]).toEqual(["2", true]);
    const time = new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    expect(all("#errors .err").map((e) => [...e.children].map((c) => c.textContent))).toEqual([["jev", time, "timeout"], ["s2", time, "402"]]);
  });
});

// ---------- Recordings ----------

describe("renderRecordings", () => {
  const rows = () => all("#recordings .rec");
  const row = (i = 0) => rows()[i]!;
  const button = (r: HTMLElement, cls: string) => r.querySelector<HTMLButtonElement>(`.${cls}`)!;
  const badges = (r: HTMLElement) => [...r.querySelectorAll(".badge")].map((b) => b.textContent);
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const recDialog = () => el<HTMLDialogElement>("#dlg-recordings");

  async function library(list: ReturnType<typeof recording>[], st = S.emptyState()) {
    fake.sessions!.mockResolvedValue(list);
    await P.renderRecordings(st);
    return st;
  }

  test("without #recordings it does nothing", async () => {
    el("#recordings").remove();
    await P.renderRecordings(S.emptyState());
    expect(fake.sessions).not.toHaveBeenCalled();
  });

  test("the first render builds the search, Import, the list and a note; later renders keep the same search field", async () => {
    await library([]);
    const search = el<HTMLInputElement>("#recordings input.rec-search");
    expect([search.type, search.placeholder, search.getAttribute("aria-label")]).toEqual(["search", "Search names and transcripts…", "Search names and transcripts"]);
    expect(el("#recordings > p.note").textContent).toMatch(/^Click a recording to open it/);
    el<HTMLButtonElement>("#recordings .rec-tools .btn").click();
    expect(transfer.openImport).toHaveBeenCalledWith();
    await P.renderRecordings(S.emptyState());
    expect(el("#recordings input.rec-search")).toBe(search);
    expect(fake.sessions!.mock.calls).toEqual([[""], [""]]);
  });

  test("no recordings, none matching, or the library failing each say so", async () => {
    await library([]);
    expect(el("#recordings .rec-list .empty").textContent).toBe("No recordings yet.");
    fake.sessions!.mockRejectedValue(new Error("disk gone"));
    await P.renderRecordings(S.emptyState());
    expect(el("#recordings .rec-list .error-text").textContent).toBe("disk gone");
    fake.sessions!.mockRejectedValue("plain");
    await P.renderRecordings(S.emptyState());
    expect(el("#recordings .rec-list .error-text").textContent).toBe("plain");
  });

  test("typing searches after 250 ms of quiet, once, with the trimmed text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await library([]);
    const search = el<HTMLInputElement>("#recordings input.rec-search");
    search.value = "gpt";
    search.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(100);
    search.value = " gpt-6 ";
    search.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(249);
    expect(fake.sessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sessions!.mock.calls).toEqual([[""], ["gpt-6"]]);
    expect(el("#recordings .rec-list .empty").textContent).toBe("No recording matches.");
  });

  test("a row: a button with its name (or when it started, or its id), badges, and the facts about it", async () => {
    const started = "2026-09-28T19:30:00.000Z";
    await library([
      recording("r1", { name: "Episode 12", startedAt: started, claims: 3, appVersion: "1.0.0", matches: [{ utteranceId: "u1", startMs: 65_000, speaker: "Ann", snippet: "GPT-6 is out" }] }),
      recording("r2", { startedAt: started, ended: false, imported: { at: "", exportedWith: "0.7.0", fileName: "f.tattle" }, hasAudio: false, speakers: [] }),
      recording("r3", { imported: { at: "", exportedWith: null, fileName: null } }),
    ]);
    const [r1, r2, r3] = rows();
    expect([r1!.getAttribute("role"), r1!.getAttribute("tabindex"), r1!.className, r1!.title]).toEqual(["button", "0", "rec", "Open this recording: nothing is re-processed or spent"]);
    expect(button(r1!, "rec-title").textContent).toBe("Episode 12");
    expect(r1!.querySelector(".meta")!.textContent).toBe(`${when(started)} · 1:05 · live · 12 lines · Ann, Bob · 3 claims · $0.50 · v1.0.0`);
    expect([r1!.querySelector(".match .t")!.textContent, r1!.querySelector(".match")!.textContent]).toEqual(["1:05", "1:05Ann: GPT-6 is out"]);
    expect(button(r2!, "rec-title").textContent).toBe(when(started));
    expect(r2!.querySelector(".meta")!.textContent).toBe("1:05 · live · 12 lines · $0.50");
    expect(badges(r2!)).toEqual(["Incomplete", "Imported", "No audio"]);
    expect(r2!.querySelector(".badge.imp")!.getAttribute("title")).toBe("Imported from f.tattle, exported with v0.7.0");
    expect([button(r3!, "rec-title").textContent, r3!.querySelector(".badge.imp")!.getAttribute("title")]).toEqual(["r3", "Imported"]);
    expect(button(r1!, "rec-delete").getAttribute("aria-label")).toBe("Delete Episode 12");
  });

  test("the recording on screen reads Viewing; the session on air reads Current and locks the others", async () => {
    await library([recording("s1"), recording("r2")], feed(S, [], snapshot({ status: "archived" })));
    expect([row(0).className, badges(row(0)), row(0).title]).toEqual(["rec current", ["Viewing"], "You are viewing this recording"]);
    await library([recording("s1", { ended: false }), recording("r2")], feed(S, [], snapshot()));
    expect([row(0).className, badges(row(0)), row(1).className, row(1).title]).toEqual(["rec current", ["Current"], "rec locked", "Stop the current session first"]);
    expect([button(row(0), "rec-export").disabled, button(row(0), "rec-delete").disabled, button(row(1), "rec-export").disabled]).toEqual([true, true, false]);
    expect(button(row(0), "rec-export").title).toBe("Stop the session before exporting it");
    expect(button(row(0), "rec-delete").title).toBe("Stop the session before deleting it");
    expect([button(row(1), "rec-replay").disabled, button(row(1), "rec-replay").title]).toEqual([true, "Stop the current session first"]);
  });

  test("a click opens a recording and closes the window; the one on screen just closes; while on air it says to stop first", async () => {
    recDialog().showModal();
    await library([recording("r1")]);
    row().click();
    await flush();
    expect([fake.openSession!.mock.calls, recDialog().open]).toEqual([[["r1"]], false]);
    recDialog().showModal();
    await library([recording("s1")], feed(S, [], snapshot({ status: "archived" })));
    row().click();
    expect([fake.openSession!.mock.calls.length, recDialog().open]).toEqual([1, false]);
    await library([recording("r1")], feed(S, [], snapshot()));
    row().click();
    expect(toasts()).toEqual(["toast error|Stop the current session before opening a recording."]);
  });

  test("Enter or Space on the row opens it; on a button inside it does not; other keys do nothing", async () => {
    await library([recording("r1")]);
    const key = (target: HTMLElement, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    key(row(), "Enter");
    key(row(), " ");
    key(row(), "a");
    key(button(row(), "rec-export"), "Enter");
    await flush();
    expect(fake.openSession).toHaveBeenCalledTimes(2);
  });

  test("clicking the name edits it in place, without opening the row; Enter renames and refreshes", async () => {
    const started = "2026-09-28T19:30:00.000Z";
    await library([recording("r1", { startedAt: started })]);
    button(row(), "rec-title").click();
    const input = el<HTMLInputElement>("#recordings input.rec-title-input");
    expect([input.className, input.value, input.placeholder]).toEqual(["input rec-title-input", "", when(started)]);
    expect(fake.openSession).not.toHaveBeenCalled();
    input.value = "Pilot";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(fake.renameSession).toHaveBeenCalledWith("r1", "Pilot");
    expect(fake.sessions).toHaveBeenCalledTimes(2);
    expect(toasts()).toEqual(["toast ok|Renamed to Pilot"]);
  });

  test("clearing a name says so", async () => {
    await library([recording("r1", { name: "Old" })]);
    button(row(), "rec-title").click();
    const input = el<HTMLInputElement>("#recordings input.rec-title-input");
    input.value = "";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect([fake.renameSession!.mock.calls, toasts()]).toEqual([[["r1", ""]], ["toast ok|Name cleared"]]);
  });

  test("Export opens the export window for that recording, without opening the row", async () => {
    await library([recording("r1")]);
    button(row(), "rec-export").click();
    expect(transfer.openExport).toHaveBeenCalledWith("r1");
    expect(fake.openSession).not.toHaveBeenCalled();
    expect(button(row(), "rec-export").title).toBe("Save it as one file to share (WhatsApp, email)");
  });

  test("Replay is off without audio; otherwise it asks, with the cost, and replays transcript-only without the key", async () => {
    recDialog().showModal();
    await library([recording("r1", { name: "Pilot", costUsd: 0 }), recording("r2", { hasAudio: false })]);
    expect([button(row(1), "rec-replay").disabled, button(row(1), "rec-replay").title]).toEqual([true, "No audio to replay"]);
    expect(button(row(0), "rec-replay").title).toMatch(/^Run the audio through the pipeline again/);
    $voices("2");
    button(row(0), "rec-replay").click();
    await flush();
    expect([el("#h-ask").textContent, el("#ask-ok").textContent]).toEqual(["Replay “Pilot”?", "Replay"]);
    expect(el("#ask-message").textContent).toContain("(about $0.02)");
    await answer(false);
    expect(fake.replaySession).not.toHaveBeenCalled();
    button(row(0), "rec-replay").click();
    await flush();
    await answer(true);
    await flush();
    expect(fake.replaySession).toHaveBeenCalledWith("r1", 1, 2, { factcheck: false, labels: false }, { labelSet: null });
    expect(recDialog().open).toBe(false);
    expect(fake.openSession).not.toHaveBeenCalled();
  });
  function $voices(v: string) { el<HTMLSelectElement>("#voices").value = v; }

  test("Delete asks with a danger button; cancelled, nothing happens; confirmed, it deletes, refreshes, and says so", async () => {
    await library([recording("r1", { name: "Pilot" })]);
    button(row(), "rec-delete").click();
    await flush();
    expect([el("#h-ask").textContent, el("#ask-ok").className, el("#ask-ok").textContent]).toEqual(["Delete “Pilot”?", "btn danger", "Delete"]);
    await answer(false);
    expect(fake.deleteSession).not.toHaveBeenCalled();
    button(row(), "rec-delete").click();
    await flush();
    await answer(true);
    await flush();
    expect(fake.deleteSession).toHaveBeenCalledWith("r1");
    expect(fake.sessions).toHaveBeenCalledTimes(2);
    expect(fake.openSession).not.toHaveBeenCalled();
    expect(toasts()).toEqual(["toast ok|Deleted Pilot"]);
  });

  test("deleting the recording on screen opens the one below it, else the one above, else leaves the view", async () => {
    const viewGone = vi.fn();
    P.bindControls(vi.fn(), viewGone);
    const del = async (i: number) => {
      button(row(i), "rec-delete").click();
      await flush();
      await answer(true);
      await flush();
    };
    await library([recording("s1"), recording("r2")], feed(S, [], snapshot({ status: "archived" })));
    await del(0);
    expect(fake.openSession).toHaveBeenLastCalledWith("r2");
    await library([recording("r0"), recording("s1")], feed(S, [], snapshot({ status: "archived" })));
    await del(1);
    expect(fake.openSession).toHaveBeenLastCalledWith("r0");
    await library([recording("s1")], feed(S, [], snapshot({ status: "archived" })));
    await del(0);
    expect(viewGone).toHaveBeenCalledOnce();
  });

  // The search field's listener is bound once, with the state of the first render; the page replaces its state object
  // on every reload, so a later search draws rows for a state that is gone (inventory 5 §6 smell 2).
  test.fails("BUG P6-L2: a search after the state changed draws the rows for the current state (the session now on air is locked out)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await library([recording("r1"), recording("s1")]);
    const onAir = feed(S, [], snapshot());
    await P.renderRecordings(onAir);
    expect(row(0).className).toBe("rec locked");
    const search = el<HTMLInputElement>("#recordings input.rec-search");
    search.value = "r";
    search.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(250);
    expect(row(0).className).toBe("rec locked");
  });
});
