import { describe, expect, test } from "vitest";
import { loadConfig, parseAppConfig, parseS1Set } from "../src/config.ts";

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
