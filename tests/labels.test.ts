import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { checkLabelSet, estimate, parseLabelSet, setQuestions, type LabelSet } from "../src/labels/model.ts";
import { fromLegacy, fromLegacyEvent, isLegacySet } from "../src/labels/legacy.ts";
import { LabelSetError, LabelSetStore, slug } from "../src/labels/store.ts";
import { ASSIST_JSON_SCHEMA, assistSystemPrompt, LabelsAssistant, normalizeDraft } from "../src/labels/assist.ts";
import { Budget } from "../src/budget.ts";
import { ICONS } from "../web/src/icons.ts";

const cfg = loadConfig();
const clone = <T>(v: T): T => structuredClone(v);
const builtIn = (): LabelSet => clone(cfg.labels);
/** The single label set the app shipped before label sets (config/labels.default.json), kept as test data. */
const legacyFile = JSON.parse(readFileSync("tests/fixtures/labels.default.legacy.json", "utf8"));

describe("the built-in set", () => {
  test("asks Jev exactly what the old label set asked, for every question but the new clip_worthy", () => {
    const now = setQuestions(builtIn(), ["A story"], cfg.timeline.story);
    // the old questions, as timelineQuestions built them: the prefix on every instruction, story generated
    const pre = `${legacyFile.prefix} `;
    const before: Record<string, any> = {};
    for (const [id, q] of Object.entries<any>(legacyFile.questions)) before[id] = { ...q, instructions: pre + q.instructions };
    before.story = { type: "choice", instructions: pre + legacyFile.story.instructions, criteria: { s1: "A story", none: legacyFile.story.none } };
    const { clip_worthy: newClip, ...rest } = now;
    const { clip_worthy: oldClip, ...oldRest } = before;
    expect(rest).toEqual(oldRest);
    expect(Object.keys(rest).length).toBe(10); // nine labels and the story
    expect(oldClip.type).toBe("score");
    expect(newClip).toMatchObject({ type: "noul", criteria: { true: expect.any(String), false: expect.any(String) } });
  });

  test("the boundary and story wording moved to config/timeline.json unchanged", () => {
    expect(cfg.timeline.boundary).toEqual(legacyFile.boundary);
    expect(cfg.timeline.story).toEqual(legacyFile.story);
  });

  test("keeps the old display: colours, the AI group, the Off-topic index, markers and their icons", () => {
    const s = builtIn();
    const subject = s.categories[0];
    expect(subject.options.filter((o) => o.group === "AI").map((o) => o.id)).toEqual(["ai_models", "ai_tools", "ai_industry"]);
    expect(subject.options.find((o) => o.id === "personal_life")!.color).toBe("#d9588a");
    expect(subject.index).toEqual({ name: "Off-topic", description: "time spent on personal life and other topics", options: ["personal_life", "other_topics"] });
    expect(s.markers.map((m) => [m.id, m.icon, m.threshold])).toEqual([
      ["disagreement", "bolt", 0.7], ["hot_take", "flame", 0.7], ["prediction", "trend", 0.7], ["recommendation", "star", 0.7],
      ["clip_worthy", "scissors", 0.7], ["humour", "smile", 0.7],
    ]);
    expect(s.markers.filter((m) => m.perSpeaker).map((m) => m.id)).toEqual(["disagreement"]);
    expect(s.markers.filter((m) => m.list).map((m) => m.id)).toEqual(["prediction", "recommendation", "clip_worthy"]);
  });

  test("costs about a cent an hour to ask, far under Jev's token limit", () => {
    const e = estimate(builtIn());
    expect(e.tokens).toBeGreaterThan(1_500);
    expect(e.tokens).toBeLessThan(4_000);
    expect(e.overLimit).toBe(false);
    expect(e.perHourUsd).toBeCloseTo(120 * e.tokens * 0.042e-6);
  });
});

describe("label-set rules", () => {
  const errors = (mutate: (s: any) => void) => {
    const s: any = builtIn();
    mutate(s);
    const r = checkLabelSet(s);
    return r.ok ? [] : r.errors;
  };

  test("the built-in set passes; parseLabelSet throws with the reason", () => {
    expect(checkLabelSet(builtIn()).ok).toBe(true);
    expect(() => parseLabelSet({ ...builtIn(), markers: "x" })).toThrow(/markers/);
  });

  test("limits: 2 categories, 2 scores, 8 markers, 5 levels, 2–255 options, at least one label", () => {
    expect(errors((s) => s.categories.push({ ...s.categories[1], id: "third" })).join()).toMatch(/at most 2 categories/);
    expect(errors((s) => s.scores.push({ ...s.scores[0], id: "third" })).join()).toMatch(/at most 2 scores/);
    expect(errors((s) => { for (let i = 0; i < 3; i++) s.markers.push({ ...s.markers[0], id: `m_${i}` }); }).join()).toMatch(/at most 8 markers/);
    expect(errors((s) => s.scores[0].levels.pop()).join()).toMatch(/exactly 5 levels/);
    expect(errors((s) => { s.categories[1].options = s.categories[1].options.slice(-1); }).join()).toMatch(/at least 2 options/);
    expect(errors((s) => { s.categories = []; s.scores = []; s.markers = []; }).join()).toMatch(/at least one label/);
  });

  test("ids: snake_case, unique across the set, never story or boundary", () => {
    expect(errors((s) => { s.markers[0].id = "HotTake"; }).join()).toMatch(/snake_case/);
    expect(errors((s) => { s.markers[0].id = "heat"; }).join()).toMatch(/heat is used twice/);
    expect(errors((s) => { s.markers[0].id = "story"; }).join()).toMatch(/story is reserved/);
    expect(errors((s) => { s.markers[0].id = "boundary"; }).join()).toMatch(/boundary is reserved/);
    expect(errors((s) => { s.categories[0].options[1].id = "ai_models"; }).join()).toMatch(/option id ai_models is used twice/);
  });

  test("a category needs a fallback option, as Jev's choices do", () => {
    expect(errors((s) => { s.categories[1].options = s.categories[1].options.filter((o: any) => o.id !== "other"); }).join()).toMatch(/fallback/);
  });

  test("colours, icons, thresholds, and the index are checked", () => {
    expect(errors((s) => { s.categories[0].options[0].color = "blue"; }).join()).toMatch(/#rrggbb/);
    expect(errors((s) => { s.markers[0].icon = "emoji"; }).length).toBeGreaterThan(0);
    expect(errors((s) => { s.markers[0].threshold = 1.2; }).length).toBeGreaterThan(0);
    expect(errors((s) => { s.categories[0].index.options = ["nope"]; }).join()).toMatch(/index names nope/);
    expect(errors((s) => { s.categories[1].index = { name: "x", description: "y", options: ["news"] }; }).join()).toMatch(/at most one category has an index/);
  });

  test("errors name where they are", () => {
    const e = errors((s) => { s.markers[1].threshold = 2; });
    expect(e[0]).toMatch(/^markers › Hot take › threshold:/);
  });
});

describe("the icon library", () => {
  const html = readFileSync("web/index.html", "utf8");

  test("30 icons, each drawn as a symbol in index.html", () => {
    expect(ICONS.length).toBe(30);
    expect(new Set(ICONS).size).toBe(30);
    for (const id of ICONS) expect(html, id).toContain(`<symbol id="i-${id}" viewBox="0 0 16 16">`);
  });

  test("the built-in set's icons are in the library", () => {
    for (const m of builtIn().markers) expect(ICONS).toContain(m.icon);
  });
});

describe("recordings made before label sets", () => {
  const session = JSON.parse(readFileSync("tests/fixtures/legacy-session.json", "utf8"));

  test("their old set converts to the new format, with the Jev wording they were recorded with", () => {
    expect(isLegacySet(session.labelSet)).toBe(true);
    expect(isLegacySet(builtIn())).toBe(false);
    const set = fromLegacy(session.labelSet, session.config.timeline);
    expect(checkLabelSet(set).ok).toBe(true);
    expect({
      categories: set.categories.map((c) => [c.id, c.name, c.options.map((o) => `${o.id}:${o.color}${o.group ? `:${o.group}` : ""}`), c.index?.name ?? null]),
      scores: set.scores.map((s) => [s.id, s.levels]),
      markers: set.markers.map((m) => [m.id, m.short, m.icon, m.threshold, m.perSpeaker, m.list]),
      prefix: set.prefix, faded: set.fadedBelowConfidence, companies: set.companies.length,
    }).toMatchInlineSnapshot(`
      {
        "categories": [
          [
            "subject",
            "Subject",
            [
              "ai_models:#3f7df0:AI",
              "ai_tools:#6fa0ff:AI",
              "ai_industry:#2a58c9:AI",
              "tech:#1fa89a",
              "marketing:#d0892a",
              "personal_life:#d9588a",
              "other_topics:#8b6fd6",
              "the_show:#6f7a8c",
            ],
            "Off-topic",
          ],
          [
            "mode",
            "Mode",
            [
              "news:#3e8ee0",
              "analysis:#9a7fe0",
              "personal_story:#d9679a",
              "explainer:#2fb39c",
              "banter:#d99a2b",
              "transition:#6a7d98",
              "other:#4e5b6c",
            ],
            null,
          ],
        ],
        "companies": 9,
        "faded": 0.5,
        "markers": [
          [
            "disagreement",
            "Disagree",
            "bolt",
            0.7,
            true,
            false,
          ],
          [
            "hot_take",
            "Hot take",
            "flame",
            0.7,
            false,
            false,
          ],
          [
            "prediction",
            "Prediction",
            "trend",
            0.7,
            false,
            true,
          ],
          [
            "recommendation",
            "Recommend",
            "star",
            0.7,
            false,
            true,
          ],
          [
            "clip_worthy",
            "Clip",
            "scissors",
            0.7,
            false,
            true,
          ],
          [
            "humour",
            "Humour",
            "smile",
            0.7,
            false,
            false,
          ],
        ],
        "prefix": "Judge only segment; previous_segment is context only.",
        "scores": [
          [
            "heat",
            [
              "Calm",
              "Lively",
              "Animated",
              "Heated",
              "Very heated",
            ],
          ],
          [
            "hype",
            [
              "Very skeptical",
              "Skeptical",
              "Neutral or mixed",
              "Positive",
              "Very enthusiastic",
            ],
          ],
        ],
      }
    `);
    expect(set.categories[0].instructions).toBe(session.labelSet.questions.subject.instructions);
  });

  test("a host-edited old set converts too, within the limits", () => {
    const edited = clone(session.labelSet);
    edited.questions.jargon = { type: "noul", instructions: "Uses jargon." };
    edited.questions.format = { type: "choice", instructions: "Format?", criteria: { a: "A", other: "O" } };
    const set = fromLegacy(edited);
    expect(set.categories.length).toBe(2); // the third choice does not fit
    expect(set.markers.find((m) => m.id === "jargon")).toMatchObject({ name: "Jargon", icon: "pin", threshold: 0.7 });
  });

  test("their section events name the option", () => {
    const set = fromLegacy(session.labelSet, session.config.timeline);
    const e = fromLegacyEvent({ seq: 1, type: "section.updated", at: "", data: { sections: [{ id: "sec_1", subject: "tech", lane: "tech", segmentIds: ["seg_1"], startMs: 0, endMs: 5 }] } }, set);
    expect((e.data as any).sections).toEqual([{ id: "sec_1", category: "subject", option: "tech", lane: "tech", segmentIds: ["seg_1"], startMs: 0, endMs: 5 }]);
    const other = { seq: 2, type: "utterance" as const, at: "", data: { id: "u_1" } };
    expect(fromLegacyEvent(other, set)).toBe(other);
  });
});

describe("the label-set store", () => {
  const store = () => {
    const userDir = mkdtempSync(join(tmpdir(), "labels-user-"));
    return { s: new LabelSetStore({ builtInDir: "config/labels", userDir }), userDir };
  };
  const status = (fn: () => unknown) => {
    try { fn(); } catch (e) { return e instanceof LabelSetError ? e.status : "other"; }
    return "ok";
  };

  test("lists the built-in set first; its id is fixed and it is read-only", () => {
    const { s } = store();
    expect(s.list()).toEqual([{ id: "ai-podcast", name: "AI podcast", description: expect.any(String), builtIn: true, counts: { categories: 2, scores: 2, markers: 6 }, perHourUsd: expect.any(Number) }]);
    expect(s.get("ai-podcast").builtIn).toBe(true);
    expect(status(() => s.update("ai-podcast", builtIn()))).toBe(409);
    expect(status(() => s.remove("ai-podcast"))).toBe(409);
    expect(status(() => s.get("nope"))).toBe(404);
    expect(status(() => s.get("../etc"))).toBe(404);
  });

  test("create, get, update, remove: one JSON file each, written whole", () => {
    const { s, userDir } = store();
    const made = s.create({ ...builtIn(), name: "Sales calls", id: "ignored", builtIn: true });
    expect(made).toMatchObject({ id: "sales-calls", name: "Sales calls", builtIn: false });
    const onDisk = JSON.parse(readFileSync(join(userDir, "sales-calls.json"), "utf8"));
    expect(onDisk.builtIn).toBeUndefined();
    expect(onDisk.format).toBe("tattle-labels");
    expect(s.create({ ...builtIn(), name: "Sales calls" }).id).toBe("sales-calls-2");
    const changed = s.update("sales-calls", { ...made, description: "Changed" });
    expect(s.get("sales-calls").description).toBe("Changed");
    expect(changed.id).toBe("sales-calls");
    expect(readdirSync(userDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(s.remove("sales-calls")).toEqual({ deleted: "sales-calls" });
    expect(existsSync(join(userDir, "sales-calls.json"))).toBe(false);
    expect(status(() => s.remove("sales-calls"))).toBe(404);
    expect(status(() => s.update("sales-calls", made))).toBe(404);
  });

  test("an invalid set is refused with the reason", () => {
    const { s } = store();
    const bad = { ...builtIn(), name: "Bad", markers: [...builtIn().markers, ...builtIn().markers.map((m) => ({ ...m, id: `${m.id}_2` }))] };
    expect(() => s.create(bad)).toThrow(/at most 8 markers/);
    expect(status(() => s.create(bad))).toBe(400);
    expect(status(() => s.create("text"))).toBe(400);
  });

  test("clone copies any set as the user's own, named “<name> copy”", () => {
    const { s } = store();
    const c = s.clone("ai-podcast");
    expect(c).toMatchObject({ id: "ai-podcast-copy", name: "AI podcast copy", builtIn: false });
    expect(s.clone("ai-podcast").name).toBe("AI podcast copy (2)");
    const { id: _a, name: _b, builtIn: _c, ...content } = c;
    const { id: _d, name: _e, builtIn: _f, ...original } = builtIn();
    expect(content).toEqual(original);
  });

  test("import: a shared file becomes a new set with a new id, renamed if its name is taken", () => {
    const { s } = store();
    const file = { ...builtIn(), id: "whatever", builtIn: true };
    const a = s.import(file);
    expect(a).toMatchObject({ name: "AI podcast (2)", id: "ai-podcast-2", builtIn: false });
    expect(status(() => s.import({ name: "x" }))).toBe(400);
    expect(status(() => s.import({ ...file, markers: "x" }))).toBe(400);
  });

  test("a broken file is listed as broken, never crashes the list, and cannot be used", () => {
    const { s, userDir } = store();
    writeFileSync(join(userDir, "broken.json"), "{ not json");
    writeFileSync(join(userDir, "invalid.json"), JSON.stringify({ ...builtIn(), id: "invalid", name: "Half made", markers: "x" }));
    writeFileSync(join(userDir, "Not An Id.json"), "{}"); // not a set's file name: ignored
    const list = s.list();
    expect(list.map((x) => x.id)).toEqual(["ai-podcast", "broken", "invalid"]);
    expect(list[1].broken).toMatch(/not readable JSON/);
    expect(list[2]).toMatchObject({ name: "Half made", broken: expect.stringMatching(/markers/) });
    expect(status(() => s.get("broken"))).toBe(400);
  });

  test("ids come from names", () => {
    expect(slug("Sales calls — Q3!")).toBe("sales-calls-q3");
    expect(slug("Café")).toBe("cafe");
    expect(slug("!!!")).toBe("labels");
  });
});

describe("Create with AI, with a fake OpenRouter", () => {
  const set = builtIn();
  // the model's shape: optional fields as null, no format, version, or id
  const asModel = (s: LabelSet) => ({
    name: "Sales calls", description: "d", prefix: s.prefix, fadedBelowConfidence: 0.5, companies: [],
    categories: s.categories.map((c) => ({ ...c, index: c.index ?? null, options: c.options.map((o) => ({ ...o, group: o.group ?? null })) })),
    scores: s.scores, markers: s.markers.map((m) => ({ ...m, criteria: m.criteria ?? null })),
  });
  const reply = (content: unknown, cost = 0.01) => new Response(JSON.stringify({
    id: "gen-1", model: "openai/gpt-6-luna", choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost, prompt_tokens: 5000, completion_tokens: 900 },
  }), { status: 200 });
  const run = (answers: unknown[], cap = 1) => {
    const bodies: any[] = [];
    const rows: any[] = [];
    let i = 0;
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return reply(answers[Math.min(i++, answers.length - 1)]); }) as unknown as typeof fetch;
    const cfg = { ...loadConfig().app.labelsAssist };
    const budget = new Budget({ sessionCapUsd: cap, devCapUsd: 100, enforceDevCap: false, devSpentUsd: 0 });
    const a = new LabelsAssistant(cfg, { fetch: f, apiKey: "sk-or-test", budget, log: (r) => rows.push(r), sleep: async () => {} });
    return { a, bodies, rows };
  };
  const system = assistSystemPrompt(set);
  const ask = [{ role: "user" as const, content: "A set for sales calls." }];

  test("a valid draft comes back as a set that passes the same validation; the model is the configured one, with a strict schema", async () => {
    const { a, bodies, rows } = run([{ reply: "Here is a draft.", set: asModel(set) }]);
    const r = await a.turn(system, ask, null);
    expect(r.reply).toBe("Here is a draft.");
    expect(checkLabelSet(r.set).ok).toBe(true);
    expect(r.set!.categories[0].options.find((o) => o.id === "tech")!.group).toBeUndefined(); // nulls dropped
    expect(r.costUsd).toBeCloseTo(0.01);
    expect(bodies[0].model).toBe("openai/gpt-6-luna");
    expect(bodies[0].response_format).toMatchObject({ type: "json_schema", json_schema: { name: "label_set_draft", strict: true } });
    expect(bodies[0].messages[0].content).toContain("thumbs-up"); // the icon list
    expect(bodies[0].messages[1].content).toContain("There is no draft yet.");
    expect(rows[0]).toMatchObject({ kind: "s2_call", purpose: "labels_assist", ok: true, cost_usd: 0.01 });
  });

  test("the draft on screen goes with the message, the host's edits included", async () => {
    const { a, bodies } = run([{ reply: "Noted.", set: null }]);
    const r = await a.turn(system, [...ask, { role: "assistant", content: "Here is a draft." }, { role: "user", content: "Add a marker for objections." }], { ...set, name: "Edited by hand" });
    expect(r.set).toBeNull();
    expect(bodies[0].messages.length).toBe(4);
    expect(bodies[0].messages[3].content).toMatch(/^Add a marker for objections\.\n\nCurrent draft \(the host may have edited it\):\n\{.*"Edited by hand"/s);
  });

  test("an invalid set is sent back once with its errors; still invalid, the reply is kept and the set dropped", async () => {
    const bad = { ...asModel(set), scores: [...set.scores, { ...set.scores[0], id: "third" }] };
    const fixed = await run([{ reply: "Draft.", set: bad }, { reply: "Fixed.", set: asModel(set) }]);
    const r1 = await fixed.a.turn(system, ask, null);
    expect(r1).toMatchObject({ reply: "Fixed.", costUsd: 0.02 });
    expect(r1.set).not.toBeNull();
    expect(fixed.bodies[1].messages.at(-1).content).toMatch(/at most 2 scores/);
    const stuck = run([{ reply: "Draft.", set: bad }]);
    const r2 = await stuck.a.turn(system, ask, null);
    expect(r2.set).toBeNull();
    expect(r2.reply).toBe("Draft.");
    expect(r2.error).toMatch(/did not pass validation: .*at most 2 scores/);
    expect(stuck.bodies.length).toBe(2);
  });

  test("the conversation's cap stops the next call", async () => {
    const { a, bodies } = run([{ reply: "x", set: null }], 0.015);
    await a.turn(system, ask, null);
    await a.turn(system, ask, null);
    await expect(a.turn(system, ask, null)).rejects.toThrow(/cap/);
    expect(bodies.length).toBe(2);
  });

  test("the reply schema's icons are the library's, and the model's nulls normalise away", () => {
    expect((ASSIST_JSON_SCHEMA.properties.set as any).anyOf[1].properties.markers.items.properties.icon.enum).toEqual([...ICONS]);
    const n = normalizeDraft({ name: "x", categories: [{ id: "a", index: null, options: [{ id: "o", group: null }] }], markers: [{ id: "m", criteria: null }] }) as any;
    expect(n).toMatchObject({ format: "tattle-labels", version: 1, id: "draft" });
    expect("index" in n.categories[0] || "group" in n.categories[0].options[0] || "criteria" in n.markers[0]).toBe(false);
  });
});
