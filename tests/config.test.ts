import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, test } from "vitest";
import {
  CLAIM_TYPE_KEYS, DEFAULT_LABEL_SET, loadConfig, parseAppConfig, parseS1Set, TimelineConfigSchema,
} from "../src/config.ts";
import { setAppPaths } from "../src/paths.ts";
import { cleanTmpDirs, tmpDir } from "./fakes/env.ts";

const clone = <T>(v: T): T => structuredClone(v);

describe("config", () => {
  const cfg = loadConfig();

  test("loads app.json, timeline.json, the built-in label set, and System 1", () => {
    expect(cfg.app.server.port).toBe(4317);
    expect(cfg.timeline.boundary.type).toBe("noul");
    expect(cfg.timeline.story.none).toBe("None of these stories.");
    expect(cfg.labels.id).toBe("ai-podcast");
    expect(cfg.labels.builtIn).toBe(true);
    expect(cfg.labels.categories.map((c) => c.id)).toEqual(["subject", "mode"]);
    expect(cfg.s1.id).toBe("s1@1");
    expect(cfg.s1.thresholds.worthMin).toBe(1.5);
  });

  test("app.json has no timeline block any more: labels come from label sets", () => {
    expect("timeline" in cfg.app).toBe(false);
    expect(() => parseAppConfig({ ...clone(cfg.app), timeline: { stories: [] } })).toThrow();
  });

  test("rejects minSegmentMs > maxSegmentMs", () => {
    const app = clone(cfg.app);
    app.segmentation.minSegmentMs = 80_000;
    expect(() => parseAppConfig(app)).toThrow(/minSegmentMs/);
  });

  test("System 1 set rules", () => {
    const s1 = clone(cfg.s1) as any;
    s1.questions.attention_1 = { type: "noul", instructions: "x" };
    expect(() => parseS1Set(s1)).not.toThrow();
    s1.thresholds.claimThreshold = 0.95;
    expect(() => parseS1Set(s1)).toThrow();
    const s1b = clone(cfg.s1) as any;
    delete s1b.questions.claim_type.criteria.event;
    expect(() => parseS1Set(s1b)).toThrow(/claim_type/);
  });
});

describe("loadConfig from a folder", () => {
  afterEach(() => { setAppPaths(); cleanTmpDirs(); });

  /** A tmp copy of config/, with one file replaced. */
  const copy = (file?: string, content?: string) => {
    const d = tmpDir("config-");
    cpSync("config", d, { recursive: true });
    if (file) writeFileSync(join(d, file), content!);
    return d;
  };

  it("reads a custom folder, and appPaths().config by default", () => {
    const d = copy();
    const app = JSON.parse(readFileSync(join(d, "app.json"), "utf8"));
    app.server.port = 5000;
    writeFileSync(join(d, "app.json"), JSON.stringify(app));
    expect(loadConfig(d).app.server.port).toBe(5000);
    setAppPaths({ config: d });
    expect(loadConfig().app.server.port).toBe(5000);
  });

  it("prefixes a schema failure with the file's path", () => {
    const d = copy("app.json", JSON.stringify({ server: { port: 0 } }));
    expect(() => loadConfig(d)).toThrow(new RegExp(`^${join(d, "app.json")}: `));
    const t = copy("timeline.json", JSON.stringify({ boundary: { type: "noul", instructions: "x" }, story: { instructions: "x", none: "y", extra: 1 } }));
    expect(() => loadConfig(t)).toThrow(`${join(t, "timeline.json")}: `);
    const l = copy("labels/ai-podcast.json", JSON.stringify({ id: "ai-podcast" }));
    expect(() => loadConfig(l)).toThrow(`${join(l, "labels/ai-podcast.json")}: `);
    const s = copy("factcheck.s1.default.json", JSON.stringify({ id: "s1@x" }));
    expect(() => loadConfig(s)).toThrow(`${join(s, "factcheck.s1.default.json")}: `);
  });

  it("throws on a missing file (ENOENT) and on invalid JSON (SyntaxError)", () => {
    expect(() => loadConfig(tmpDir("config-"))).toThrow(/ENOENT/);
    expect(() => loadConfig(copy("app.json", "{ not json"))).toThrow(SyntaxError);
  });
});

describe("parseAppConfig", () => {
  const cfg = loadConfig();
  const app = () => structuredClone(cfg.app) as any;
  const rejects = (mutate: (a: any) => void, re?: RegExp) => {
    const a = app();
    mutate(a);
    expect(() => parseAppConfig(a)).toThrow(re ?? /^app config: /);
  };

  it("rejects unknown keys at the top level and inside jev (strict)", () => {
    rejects((a) => { a.extra = 1; });
    rejects((a) => { a.jev.extra = 1; });
    rejects((a) => { a.server.host = "0.0.0.0"; });
  });

  it("rejects chat.defaultModel not in chat.models, and empty chat.models", () => {
    rejects((a) => { a.chat.defaultModel = "someone/else"; }, /chat.defaultModel must be one of chat.models/);
    rejects((a) => { a.chat.models = []; a.chat.defaultModel = "x"; });
  });

  it("accepts transcription without live and jev without provider; fills Apple's defaults when absent", () => {
    const a = app();
    delete a.transcription.live;
    delete a.jev.provider;
    delete a.transcription.apple;
    const parsed = parseAppConfig(a);
    expect(parsed.transcription.live).toBeUndefined();
    expect(parsed.jev.provider).toBeUndefined();
    expect(parsed.transcription.apple).toEqual({ locale: "en-US", clipPadMs: 300, clipConcurrency: 2, clipTimeoutMs: 20000 });
    const b = app();
    b.transcription.apple = {};
    expect(parseAppConfig(b).transcription.apple).toEqual({ locale: "en-US", clipPadMs: 300, clipConcurrency: 2, clipTimeoutMs: 20000 });
  });

  it("rejects port 0/65536, echoGate.thresholdDbfs > 0, an unknown echoGate.mode, s2.web.engine 'bing', effort 'extreme'", () => {
    rejects((a) => { a.server.port = 0; });
    rejects((a) => { a.server.port = 65536; });
    rejects((a) => { a.server.port = 80.5; });
    rejects((a) => { a.echoGate.thresholdDbfs = 1; });
    rejects((a) => { a.echoGate.mode = "sometimes"; });
    rejects((a) => { a.s2.web.engine = "bing"; });
    rejects((a) => { a.s2.effort.research = "extreme"; });
    rejects((a) => { a.chat.effort = "extreme"; });
    rejects((a) => { a.labelsAssist.effort = "extreme"; });
    rejects((a) => { a.transcription.live.delay = "none"; });
    rejects((a) => { a.vad.threshold = 1.5; });
    rejects((a) => { a.speakers.voicesPerStream.remote = -1; });
    const ok = app();
    ok.server.port = 65535;
    ok.echoGate.thresholdDbfs = 0;
    ok.speakers.voicesPerStream = { host: 0, remote: 0 };
    expect(() => parseAppConfig(ok)).not.toThrow();
  });

  it("s2.provider passes extra keys through but requires order, allow_fallbacks and require_parameters", () => {
    const a = app();
    a.s2.provider.zdr = true;
    expect(parseAppConfig(a).s2.provider).toMatchObject({ zdr: true, data_collection: "deny" });
    for (const k of ["order", "allow_fallbacks", "require_parameters"]) rejects((x) => { delete x.s2.provider[k]; });
  });

  it("the defaults in config/app.json are the documented ones", () => {
    const a = cfg.app;
    expect(a.server.port).toBe(4317);
    expect(a.jev).toEqual({
      model: "typesafe/jev-1.13", utteranceTimeoutMs: 3000, segmentTimeoutMs: 5000, maxAttempts: 2, backgroundTimeoutMs: 30000,
      backgroundMaxAttempts: 5, concurrency: 8, segmentConcurrency: 4, provider: { data_collection: "deny" },
    });
    expect(a.s2).toMatchObject({
      model: "openai/gpt-6-luna",
      provider: { order: ["openai"], allow_fallbacks: false, require_parameters: true, data_collection: "deny" },
      web: { engine: "exa", max_results: 5 }, effort: { research: "medium", audit: "low", rewrite: "medium" },
      timeoutMs: 90000, maxAttempts: 2, researchConcurrency: 2, maxResearchPerHour: 30, maxResearchPerSession: 40, staleAfterMs: 600000,
    });
    expect(a.factcheck).toEqual({
      hedgedThreshold: 0.6, knownMatchThreshold: 0.6, maxKnownQuestions: 40, auditIntervalMs: 300000, auditMinUtterances: 10,
      auditSample: 10, rewriteOnFalseAlarms: 3, rewriteOnMisses: 2, rewriteCooldownMs: 180000, replayMaxItems: 300,
    });
    expect(a.chat).toMatchObject({ defaultModel: "openai/gpt-6-luna", effort: "low", timeoutMs: 120000, maxAttempts: 2, provider: { data_collection: "deny" } });
    expect(a.chat.models).toHaveLength(14);
    expect(a.labelsAssist).toMatchObject({ model: "openai/gpt-6-luna", effort: "high", timeoutMs: 90000, maxAttempts: 2 });
    expect(a.segmentation).toMatchObject({ boundaryThreshold: 0.6, minSegmentMs: 12000, maxSegmentMs: 75000, pauseBoundaryMs: 2000 });
    expect(cfg.s1.thresholds).toEqual({ claimThreshold: 0.7, publicThreshold: 0.6, worthMin: 1.5, attentionThreshold: 0.7 });
    expect(cfg.s1.questions.hedged.criteria).toBeUndefined();
    expect(DEFAULT_LABEL_SET).toBe("ai-podcast");
    expect(cfg.labels.id).toBe(DEFAULT_LABEL_SET);
  });
});

describe("TimelineConfigSchema", () => {
  it("needs a noul boundary and a strict story with instructions and none", () => {
    const t = structuredClone(loadConfig().timeline) as any;
    expect(TimelineConfigSchema.safeParse(t).success).toBe(true);
    expect(TimelineConfigSchema.safeParse({ ...t, story: { ...t.story, extra: "x" } }).success).toBe(false);
    expect(TimelineConfigSchema.safeParse({ ...t, story: { instructions: "x" } }).success).toBe(false);
    expect(TimelineConfigSchema.safeParse({ ...t, boundary: { type: "score", instructions: "x", criteria: ["a", "b"] } }).success).toBe(false);
    expect(TimelineConfigSchema.safeParse({ ...t, labels: {} }).success).toBe(false);
  });
});

describe("parseS1Set", () => {
  const base = () => structuredClone(loadConfig().s1) as any;
  const noulQ = { type: "noul", instructions: "Attend to this." };

  it("rejects an unexpected question 'foo', a 4th attention question, and a non-noul attention_1", () => {
    const a = base();
    a.questions.foo = noulQ;
    expect(() => parseS1Set(a)).toThrow(/unexpected System 1 question foo/);
    const b = base();
    for (const i of [1, 2, 3, 4]) b.questions[`attention_${i}`] = noulQ;
    expect(() => parseS1Set(b)).toThrow(/at most 3 attention questions/);
    const c = base();
    for (const i of [1, 2, 3]) c.questions[`attention_${i}`] = noulQ;
    expect(() => parseS1Set(c)).not.toThrow();
    const d = base();
    d.questions.attention_1 = { type: "score", instructions: "x", criteria: ["a", "b"] };
    expect(() => parseS1Set(d)).toThrow(/^System 1 set: /);
  });

  it("rejects worth with 4 levels, id 's1@x', a missing publicThreshold, worthMin 3.5, an extra threshold", () => {
    const a = base();
    a.questions.worth.criteria = a.questions.worth.criteria.slice(0, 4);
    expect(() => parseS1Set(a)).toThrow(/worth must have exactly 5 levels/);
    for (const mutate of [
      (s: any) => { s.id = "s1@x"; },
      (s: any) => { delete s.thresholds.publicThreshold; },
      (s: any) => { s.thresholds.worthMin = 3.5; },
      (s: any) => { s.thresholds.attentionThreshold = 0.4; },
      (s: any) => { s.thresholds.extra = 0.6; },
      (s: any) => { s.extra = true; },
      (s: any) => { s.questions.claim_type.criteria.bonus = "extra option"; },
    ]) {
      const s = base();
      mutate(s);
      expect(() => parseS1Set(s)).toThrow();
    }
    const ok = base();
    ok.id = "s1@12";
    ok.thresholds = { claimThreshold: 0.5, publicThreshold: 0.9, worthMin: 3, attentionThreshold: 0.9 };
    expect(parseS1Set(ok).id).toBe("s1@12");
  });

  it("CLAIM_TYPE_KEYS lists the 7 claim types, none last", () => {
    expect(CLAIM_TYPE_KEYS).toEqual([
      "number_or_price", "date_or_release", "quote_or_attribution", "capability_or_benchmark", "event", "prediction", "none",
    ]);
  });
});
