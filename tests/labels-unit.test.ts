import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget, BudgetExhaustedError } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { AssistError, LabelsAssistant, normalizeDraft, type AssistMessage } from "../src/labels/assist.ts";
import { checklistText, interviewChecklist } from "../src/labels/interview.ts";
import { fromLegacy, fromLegacyEvent, fromLegacyStats, isLegacySet } from "../src/labels/legacy.ts";
import { checkDraft, checkLabelSet, countsOf, labelSetVersion, parseLabelSet, setQuestions, type LabelSet } from "../src/labels/model.ts";
import { LabelSetError, LabelSetStore } from "../src/labels/store.ts";
import { recordedSegments, TRY_MAX_SEGMENTS, tryLabelSet } from "../src/labels/try.ts";
import type { JevCallMeta } from "../src/jev/client.ts";
import type { AppEvent } from "../src/store/events.ts";
import { cleanTmpDirs, tmpDir } from "./fakes/env.ts";

const cfg = loadConfig();
const builtIn = (): LabelSet => structuredClone(cfg.labels);
const story = cfg.timeline.story;

afterEach(() => {
  cleanTmpDirs();
  vi.useRealTimers();
});

describe("label-set model", () => {
  it("parseLabelSet returns a valid set; countsOf counts its labels", () => {
    expect(parseLabelSet(builtIn()).id).toBe("ai-podcast");
    expect(countsOf(builtIn())).toEqual({ categories: 2, scores: 2, markers: 6 });
  });

  it("an empty prefix is not prepended; a marker without criteria asks a bare yes/no", () => {
    const set = { ...builtIn(), prefix: "", markers: [{ ...builtIn().markers[0]!, criteria: undefined }] };
    const q = setQuestions(set, [], story);
    expect(q.subject!.instructions).toBe(set.categories[0]!.instructions);
    expect(q[set.markers[0]!.id]).toEqual({ type: "noul", instructions: set.markers[0]!.instructions });
  });

  it("the version changes with the stories and the wording, and not with key order", () => {
    const v = labelSetVersion(builtIn(), [], story);
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(labelSetVersion(builtIn(), ["A story"], story)).not.toBe(v);
    const flipped = builtIn();
    const m = flipped.markers.find((x) => x.criteria)!;
    m.criteria = { false: m.criteria!.false, true: m.criteria!.true }; // the same wording, keys in another order
    expect(labelSetVersion(flipped, [], story)).toBe(v);
    const reworded = builtIn();
    reworded.markers[0]!.instructions += " Really.";
    expect(labelSetVersion(reworded, [], story)).not.toBe(v);
  });

  it("checkDraft estimates a draft that does not validate from its text, even null", () => {
    expect(checkDraft(null)).toMatchObject({ ok: false, errors: expect.any(Array), tokens: expect.any(Number), overLimit: false });
    const huge = { ...builtIn(), markers: [], scores: [], prefix: "x".repeat(200_000) };
    expect(checkDraft(huge)).toMatchObject({ ok: false, overLimit: true });
    expect(checkDraft(builtIn())).toMatchObject({ ok: true, errors: [] });
  });

  it("errors name where they are: an unnamed item by its number", () => {
    const set = builtIn() as any;
    set.markers[1] = { ...set.markers[1], name: " ", threshold: 2 };
    const r = checkLabelSet(set);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith("markers › #2 › threshold"))).toBe(true);
  });
});

describe("the label-set store: edges", () => {
  it("a user folder that does not exist yet lists only the built-in sets", () => {
    const s = new LabelSetStore({ builtInDir: "config/labels", userDir: join(tmpDir("labels-"), "missing") });
    expect(s.list().map((x) => x.id)).toEqual(["ai-podcast"]);
  });

  it("a broken built-in set is left out of the list and refused by get (400)", () => {
    const dir = tmpDir("builtin-");
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ format: "tattle-labels", version: 1, id: "broken" }));
    const s = new LabelSetStore({ builtInDir: dir, userDir: tmpDir("labels-") });
    expect(s.list()).toEqual([]);
    let e: unknown;
    try { s.get("broken"); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(LabelSetError);
    expect(e).toMatchObject({ status: 400, message: expect.stringMatching(/^the built-in label set broken is broken: /) });
  });

  it("import refuses a file without a usable name, and anything that is not a Tattle label set", () => {
    const s = new LabelSetStore({ builtInDir: "config/labels", userDir: tmpDir("labels-") });
    for (const body of [null, "x", { format: "other" }]) expect(() => s.import(body)).toThrow("this is not a Tattle label set file");
    expect(() => s.import({ ...builtIn(), name: 5 })).toThrow(LabelSetError);
    expect(() => s.import({ ...builtIn(), name: "   " })).toThrow(/must not be empty/);
    expect(() => s.create([])).toThrow("a label set is a JSON object");
  });

  it("the default folders are appPaths' config/labels and labelSets", () => {
    const s = new LabelSetStore();
    expect(s.builtInDir).toBe(join("config", "labels"));
    expect(s.userDir).toBe(process.env.TATTLE_LABEL_SETS);
  });
});

describe("the interview checklist: edges", () => {
  // the built-in set with yes and no wording on every marker: nothing left, not even a recommendation
  const set = { ...builtIn(), markers: builtIn().markers.map((m) => ({ ...m, criteria: m.criteria ?? { true: "yes", false: "no" } })) };

  it("items are named after their label; unnamed ones by number; blank questions are to do", () => {
    const c = interviewChecklist({
      description: "d", name: "n",
      categories: [{ name: "", instructions: "", options: [{ id: "a", name: "A", description: "x" }, { id: "none", name: "None", description: "y" }], index: { name: "i" } }],
      scores: [{ name: "Energy", instructions: "", levels: ["a", "b", "c", "d", "e"] }],
      markers: [{ name: "Win", instructions: "", criteria: { true: "t", false: "f" } }],
    });
    const status = Object.fromEntries(c.items.map((x) => [x.id, [x.label, x.status]]));
    expect(status["cat0.question"]).toEqual(["Category 1: its question", "todo"]);
    expect(status["cat0.options"]).toEqual(["Category 1: its options", "done"]);
    expect(status["cat0.fallback"]).toEqual(["Category 1: an Other or None option", "done"]);
    expect(status.index).toEqual(["An index in Insights (optional)", "done"]);
    expect(status["score0.question"]).toEqual(["Energy: its question", "todo"]);
    expect(status["score0.levels"]).toEqual(["Energy: 5 levels", "done"]);
    expect(status["marker0.question"]).toEqual(["Win: its question", "todo"]);
    expect(status["marker0.wording"]).toEqual(["Win: yes and no wording", "done"]);
    expect(c.items.find((x) => x.id === "cat0.options")!.detail).toBeUndefined();
  });

  it("one usable option is 'option', not 'options'; a skipped index is skipped", () => {
    const c = interviewChecklist({ categories: [{ name: "Stage", instructions: "q", options: [{ id: "a", name: "A", description: "x" }] }] }, ["index"]);
    expect(c.items.find((x) => x.id === "cat0.options")!.detail).toMatch(/^It has 1 usable option: /);
    expect(c.items.find((x) => x.id === "index")!.status).toBe("skipped");
  });

  it("with everything settled but the draft invalid: not complete, nothing next, and the text says so", () => {
    const bad = { ...set, markers: set.markers.map((m, i) => (i === 0 ? { ...m, threshold: 5 } : m)) };
    const c = interviewChecklist(bad);
    expect(c.next).toBeNull();
    expect(c.complete).toBe(false);
    const text = checklistText(c);
    expect(text).toContain("The draft does not validate yet: ");
    expect(text).not.toContain("Next to settle");
    expect(text).not.toContain("Everything is settled");
  });

  it("a complete set: nothing next, and the text says everything is settled", () => {
    const c = interviewChecklist(set);
    expect(c.next).toBeNull();
    expect(c.complete).toBe(true);
    expect(checklistText(c)).toMatch(/The draft validates\.\nEverything is settled: summarise the set/);
  });

  it("a recommended item comes next once nothing is required", () => {
    const c = interviewChecklist({ ...set, markers: set.markers.map((m) => ({ ...m, criteria: undefined })) }, ["index"]);
    expect(c.next!.status).toBe("recommended");
    expect(c.next!.id).toBe("marker0.wording");
  });
});

describe("recordings made before label sets: edges", () => {
  it("isLegacySet needs an object without format and with a questions object", () => {
    expect(isLegacySet(null)).toBe(false);
    expect(isLegacySet({ questions: null })).toBe(false);
    expect(isLegacySet({ questions: {} })).toBe(true);
    expect(isLegacySet({ format: "x", questions: {} })).toBe(false);
  });

  it("converts unknown options with spare colours, a score without levels, a marker without criteria, no prefix, no questions", () => {
    expect(fromLegacy({} as any)).toMatchObject({ prefix: "", categories: [], scores: [], markers: [], fadedBelowConfidence: 0.5, companies: [] });
    const set = fromLegacy({
      questions: {
        subject: { type: "choice", instructions: "About?", criteria: { tech: "Tech", widgets: "Widgets", other: "Else" } },
        mood: { type: "choice", instructions: "Mood?" },
        energy: { type: "score", instructions: "Energy?", criteria: "not a list" },
        vague: { type: "noul", instructions: "Vague?" },
        clip_worthy: { type: "score", instructions: "Clip?", criteria: ["a", "b"] },
      },
    }, { noulMarkerThreshold: 0.8, fadedBelowConfidence: 0.4, companies: ["Acme"] });
    const subject = set.categories[0]!;
    expect(subject.options.map((o) => [o.id, o.name, o.color])).toEqual([["tech", "Tech", "#1fa89a"], ["widgets", "Widgets", "#3f7df0"], ["other", "Other", "#4e5b6c"]]);
    expect(subject.index).toBeUndefined(); // its options are not all there
    expect(set.categories[1]).toMatchObject({ id: "mood", name: "Mood", options: [] });
    expect(set.scores).toEqual([{ id: "energy", name: "Energy", instructions: "Energy?", levels: [] }]);
    expect(set.markers.map((m) => [m.id, m.threshold, m.list, "criteria" in m])).toEqual([["clip_worthy", 0.8, true, false], ["vague", 0.8, false, false]]);
    expect(set).toMatchObject({ fadedBelowConfidence: 0.4, companies: ["Acme"] });
  });

  it("fromLegacyStats passes version 2 through, and fills what an old event lacks", () => {
    const set = fromLegacy({ questions: { hype: { type: "score", instructions: "h", criteria: ["a", "b", "c", "d", "e"] }, disagreement: { type: "noul", instructions: "d" }, prediction: { type: "noul", instructions: "p" } } });
    const v2 = { version: 2, anything: true };
    expect(fromLegacyStats(v2, set)).toBe(v2);
    expect(fromLegacyStats(undefined, set)).toEqual({
      version: 2, index: null, roganIndex: 0, labelledMs: 0, categories: [], speakers: [],
      lists: [{ markerId: "prediction", items: [] }], factcheck: undefined, cost: undefined,
    });
    const s = fromLegacyStats({ speakers: [{ speakerId: "spk_1", displayName: "Nic" }], predictions: [{ segmentId: "seg_1" }] }, set);
    expect(s.speakers).toEqual([{ speakerId: "spk_1", displayName: "Nic", talkMs: 0, markers: { disagreement: 0 }, scores: { hype: null } }]);
    expect(s.lists).toEqual([{ markerId: "prediction", items: [{ segmentId: "seg_1", text: "" }] }]);
    const bare = fromLegacyStats({ speakers: [{ speakerId: "spk_1", displayName: "Nic", talkMs: 5 }] }, fromLegacy({ questions: {} }));
    expect(bare.speakers[0]).toEqual({ speakerId: "spk_1", displayName: "Nic", talkMs: 5, markers: {}, scores: {} });
  });

  it("a yes/no question's criteria are kept; an old stats event without the index share gets 0", () => {
    const set = fromLegacy({
      questions: {
        subject: { type: "choice", instructions: "About?", criteria: { personal_life: "Life", other_topics: "Else" } },
        humour: { type: "noul", instructions: "Funny?", criteria: { true: "a joke", false: "no joke" } },
      },
    });
    expect(set.markers[0]).toMatchObject({ id: "humour", criteria: { true: "a joke", false: "no joke" } });
    expect(set.categories[0]!.index).toMatchObject({ name: "Off-topic" });
    expect(fromLegacyStats({}, set).index).toEqual({ name: "Off-topic", description: "time spent on personal life and other topics", share: 0 });
  });

  it("fromLegacyEvent converts stats; sections already naming their option, or none, are kept", () => {
    const set = fromLegacy({ questions: {} });
    const stats = fromLegacyEvent({ seq: 1, type: "stats", at: "", data: { roganIndex: 0.2 } }, set);
    expect(stats.data).toMatchObject({ version: 2, roganIndex: 0.2 });
    const s = { id: "sec_1", category: "mode", option: "news", segmentIds: [] };
    expect((fromLegacyEvent({ seq: 2, type: "section.updated", at: "", data: { sections: [s] } }, set).data as any).sections).toEqual([s]);
    expect((fromLegacyEvent({ seq: 3, type: "section.updated", at: "", data: {} }, set).data as any).sections).toEqual([]);
  });
});

describe("Try on a recording", () => {
  const ev = (seq: number, type: string, data: Record<string, unknown>): AppEvent => ({ seq, type, at: "", data } as AppEvent);

  it("rebuilds the first minutes' closed segments with current names; lines without text are failed; own labels are kept", () => {
    const events = [
      ev(1, "utterance", { id: "u_1", stream: "mic", startMs: 0, endMs: 1000, speakerId: "spk_1", text: "hello", tags: ["loud"] }),
      ev(2, "utterance", { id: "u_2", stream: "remote", startMs: 1000, endMs: 2000, speakerId: "spk_2" }),
      ev(3, "segment.closed", { id: "seg_2", startMs: 20_000, endMs: 30_000 }),
      ev(4, "segment.closed", { id: "seg_1", startMs: 0, endMs: 20_000, utteranceIds: ["u_1", "u_2", "u_missing"], forced: true }),
      ev(5, "segment.closed", { id: "seg_late", startMs: 11 * 60_000, endMs: 12 * 60_000, utteranceIds: [] }),
      ev(6, "segment.labels", { segmentId: "seg_1", unlabeled: false }),
      ev(7, "segment.labels", { segmentId: "seg_late", unlabeled: false }),
    ];
    const r = recordedSegments(events, (_u, id) => ({ spk_1: "Nic" })[id] ?? id, 10);
    expect(r.segments.map((s) => s.id)).toEqual(["seg_1", "seg_2"]);
    expect(r.segments[0]).toMatchObject({ forced: true, final: false });
    expect(r.segments[0]!.utterances.map((u) => [u.speakerId, u.text, u.failed, u.tags])).toEqual([["Nic", "hello", false, ["loud"]], ["spk_2", "", true, []]]);
    expect(r.segments[1]!.utterances).toEqual([]);
    expect([...r.own.keys()]).toEqual(["seg_1"]);
  });

  it(`keeps at most ${TRY_MAX_SEGMENTS} segments`, () => {
    const events = Array.from({ length: 50 }, (_, i) => ev(i, "segment.closed", { id: `seg_${i}`, startMs: i * 1000, endMs: i * 1000 + 900 }));
    expect(recordedSegments(events, (_u, id) => id, 10).segments).toHaveLength(TRY_MAX_SEGMENTS);
  });

  it("asks each segment with the draft's questions, a few at a time; a failed call leaves its segment unlabeled", async () => {
    const set = builtIn();
    const segments = recordedSegments([
      ev(1, "utterance", { id: "u_1", startMs: 0, endMs: 1000, speakerId: "spk_1", text: "one" }),
      ...[1, 2, 3].map((i) => ev(1 + i, "segment.closed", { id: `seg_${i}`, startMs: i * 1000, endMs: i * 1000 + 900, utteranceIds: ["u_1"] })),
    ], (_u, id) => id, 10).segments;
    const metas: JevCallMeta[] = [];
    let active = 0, peak = 0;
    const r = await tryLabelSet(set, segments, {
      concurrency: 2, story,
      ask: async (_state, q, meta) => {
        metas.push(meta);
        active++; peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 5));
        active--;
        expect(Object.keys(q)).toEqual(Object.keys(setQuestions(set, [], story)));
        if (meta.segment_id === "seg_2") throw new Error("jev down");
        return { answers: {}, id: null, model: "m", provider: null, usage: meta.segment_id === "seg_3" ? (undefined as any) : { input_tokens: 0, output_tokens: 0, cost: 0.001 } };
      },
    });
    expect(peak).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.costUsd).toBe(0.001);
    expect(r.labels.map((l) => [l.segmentId, l.unlabeled])).toEqual([["seg_1", false], ["seg_2", true], ["seg_3", false]]);
    expect(metas.every((m) => m.purpose === "try" && m.question_set_version === labelSetVersion(set, [], story))).toBe(true);
    expect(await tryLabelSet(set, [], { concurrency: 4, story, ask: async () => { throw new Error("never"); } })).toEqual({ labels: [], costUsd: 0, failed: 0 });
  });
});

describe("Create with AI: errors, retries and odd replies", () => {
  const acfg = cfg.app.labelsAssist;
  const ask: AssistMessage[] = [{ role: "assistant", content: "What kind of conversation?" }, { role: "user", content: "Sales calls." }];
  const body = (content: unknown, usage: Record<string, unknown> = { cost: 0.01, prompt_tokens: 50, completion_tokens: 9 }, message?: unknown) =>
    JSON.stringify({ id: "gen-a", model: "openai/gpt-6-luna", choices: [{ message: message ?? { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage });
  type Fake = () => Response | Promise<Response>;
  const ok = (content: unknown, usage?: Record<string, unknown>, message?: unknown): Fake => () => new Response(body(content, usage, message));
  const turnOf = (o: Record<string, unknown> = {}) => ({ reply: "Noted.", question: "Next?", choices: [], skip: [], set: null, ...o });
  function rig(responses: Fake[], o: { budget?: Budget; sleep?: boolean } = {}) {
    const rows: any[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const f = (async () => { calls++; const r = responses.shift(); if (!r) throw new Error("no more"); return r(); }) as unknown as typeof fetch;
    const a = new LabelsAssistant(acfg, {
      fetch: f, apiKey: "k", budget: o.budget ?? new Budget(), log: (r) => rows.push(r),
      ...(o.sleep === false ? {} : { sleep: async (ms: number) => { sleeps.push(ms); } }),
    });
    return { a, rows, sleeps, calls: () => calls };
  }

  it("the last message must be the host's, and not blank", async () => {
    const { a, calls } = rig([]);
    for (const m of [[], [{ role: "assistant" as const, content: "hi" }], [{ role: "user" as const, content: "  " }]]) {
      await expect(a.turn("sys", m, null)).rejects.toThrow("the last message must be the host's");
    }
    expect(calls()).toBe(0);
  });

  it("401 → AssistError 401; 402 → 402; any other failure after the retries → 502 'GPT-6 Luna did not answer'", async () => {
    const e401 = await rig([() => new Response('{"error":{"code":401}}', { status: 401 })]).a.turn("s", ask, null).catch((e) => e);
    expect(e401).toBeInstanceOf(AssistError);
    expect(e401).toMatchObject({ status: 401, message: "OpenRouter rejected the API key (401): replace it in API keys." });
    const e402 = await rig([() => new Response('{"error":{"code":402}}', { status: 402 })]).a.turn("s", ask, null).catch((e) => e);
    expect(e402).toMatchObject({ status: 402, message: "OpenRouter says the credit or the key's limit is used up (402): add credit at openrouter.ai." });
    const r = rig([() => new Response("bad gateway", { status: 502 }), () => new Response("bad gateway", { status: 502 })]);
    const e502 = await r.a.turn("s", ask, null).catch((e) => e);
    expect(e502).toMatchObject({ status: 502, message: "GPT-6 Luna did not answer: HTTP 502 bad gateway" });
    expect(r.calls()).toBe(2);
    expect(r.sleeps).toHaveLength(1);
    expect(r.sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(r.sleeps[0]).toBeLessThan(2500);
    expect(r.rows).toEqual([expect.objectContaining({ kind: "s2_call", purpose: "labels_assist", ok: false, attempts: 2, error: "HTTP 502 bad gateway", usage: null, cost_usd: 0, id: null })]);
  });

  it("a network failure, a body that is not JSON, a 200 error body, and a reply without cost", async () => {
    const net = rig([() => Promise.reject("reset"), () => { throw new TypeError("fetch failed"); }]);
    await expect(net.a.turn("s", ask, null)).rejects.toThrow("GPT-6 Luna did not answer: TypeError: fetch failed");
    const garbage = rig([() => new Response("<html>"), ok(turnOf())]);
    expect((await garbage.a.turn("s", ask, null)).reply).toBe("Noted.");
    expect(garbage.calls()).toBe(2);
    const errBody = rig([() => new Response('{"error":{"message":"upstream"}}'), ok(turnOf())]);
    await errBody.a.turn("s", ask, null);
    expect(errBody.calls()).toBe(2);
    const noCost = rig([() => new Response(JSON.stringify({ choices: [] }))]);
    await expect(noCost.a.turn("s", ask, null)).rejects.toThrow("GPT-6 Luna did not answer: response without usage.cost rejected");
    expect(noCost.calls()).toBe(1);
  });

  it("a retry-after header sets the wait, and without an injected sleep a real timer waits", async () => {
    const r = rig([() => new Response("", { status: 429, headers: { "retry-after": "3" } }), ok(turnOf())]);
    await r.a.turn("s", ask, null);
    expect(r.sleeps[0]).toBeGreaterThanOrEqual(3000);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const t = rig([() => new Response("", { status: 503 }), ok(turnOf())], { sleep: false });
    const p = t.a.turn("s", ask, null);
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(501);
    await p;
    expect(t.calls()).toBe(2);
  });

  it("a refused budget throws before any call", async () => {
    const budget = new Budget();
    expect(() => budget.exhaust("provider", "jev:try", "used up")).toThrow();
    const r = rig([ok(turnOf())], { budget });
    await expect(r.a.turn("s", ask, null)).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(r.calls()).toBe(0);
  });

  it("the cost is recorded in the request's budget, and the row's usage defaults missing token counts to 0", async () => {
    const budget = new Budget();
    const r = rig([ok(turnOf(), { cost: 0.02 })], { budget });
    const out = await r.a.turn("s", ask, null);
    expect(out.costUsd).toBe(0.02);
    expect(budget.totals().s2).toBe(0.02);
    expect(r.rows[0]).toMatchObject({ ok: true, attempts: 1, id: "gen-a", model_returned: "openai/gpt-6-luna", usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0.02 } });
  });

  it("a reply that is not JSON becomes the reply text; an empty one says it could not be read; content parts are joined", async () => {
    const prose = await rig([ok("  Just some words.  ")]).a.turn("s", ask, null);
    expect(prose).toMatchObject({ reply: "Just some words.", choices: [], set: null, skipped: [] });
    expect(prose.question).toBe(""); // no question could be read
    const empty = await rig([ok("", undefined, { content: null })]).a.turn("s", ask, null);
    expect(empty.reply).toBe("The reply could not be read.");
    const parts = await rig([ok(null, undefined, { content: [{ type: "text", text: '{"reply":"Hi",' }, { type: "text", text: '"question":"Q?"}' }, {}] })]).a.turn("s", ask, null);
    expect(parts).toMatchObject({ reply: "Hi", question: "Q?" });
  });

  it("odd fields: non-string reply and question are empty; blank and non-string choices and unknown skips are dropped; at most 4 choices", async () => {
    const r = await rig([ok({ reply: 5, question: null, choices: ["a", " ", 7, "b", "c", "d", "e"], skip: ["scores", "bogus", 3], set: null })]).a.turn("s", ask, null, ["markers", "also-bogus"]);
    expect(r.reply).toBe("");
    expect(r.question).toBe("");
    expect(r.choices).toEqual(["a", "b", "c", "d"]);
    expect(r.skipped.sort()).toEqual(["markers", "scores"]);
  });

  it("a rule-breaking draft corrected to null on the retry leaves no draft and no error", async () => {
    const bad = { name: "x", description: "d", prefix: "", fadedBelowConfidence: 0.5, companies: [], categories: [], scores: [], markers: [{ id: "story", name: "S", short: "S", icon: "pin", instructions: "q", criteria: null, threshold: 0.7, perSpeaker: false, list: false }] };
    const r = rig([ok(turnOf({ set: bad })), ok(turnOf({ set: null }))]);
    const out = await r.a.turn("s", ask, null);
    expect(r.calls()).toBe(2);
    expect(out.set).toBeNull();
    expect(out.error).toBeUndefined();
  });

  it("normalizeDraft passes non-objects through, fills missing lists, and keeps a real index, group and criteria", () => {
    expect(normalizeDraft(null)).toBeNull();
    expect(normalizeDraft("x")).toBe("x");
    expect(normalizeDraft({ name: "n" })).toEqual({ format: "tattle-labels", version: 1, id: "draft", name: "n", categories: [], markers: [] });
    const n = normalizeDraft({ categories: [null, { id: "c", index: { name: "i" }, options: [null, { id: "o", group: "G" }] }], markers: [null, { id: "m", criteria: { true: "t", false: "f" } }] }) as any;
    expect(n.categories).toEqual([{ options: [] }, { id: "c", index: { name: "i" }, options: [{}, { id: "o", group: "G" }] }]);
    expect(n.markers).toEqual([{}, { id: "m", criteria: { true: "t", false: "f" } }]);
  });
});

describe("the label-set store writes", () => {
  it("a user file shadowed by a built-in id is not listed twice", () => {
    const userDir = tmpDir("labels-");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "ai-podcast.json"), JSON.stringify({ ...builtIn(), name: "Shadow" }));
    const s = new LabelSetStore({ builtInDir: "config/labels", userDir });
    expect(s.list().map((x) => x.name)).toEqual(["AI podcast"]);
  });
});
