import { describe, expect, test } from "vitest";
import { loadConfig, parseAppConfig, parseLabelSet, parseS1Set } from "../src/config.ts";

const clone = <T>(v: T): T => structuredClone(v);

describe("config", () => {
  const cfg = loadConfig();

  test("loads all three files", () => {
    expect(cfg.app.server.port).toBe(4317);
    expect(Object.keys(cfg.labels.questions)).toContain("subject");
    expect(cfg.s1.id).toBe("s1@1");
    expect(cfg.s1.thresholds.worthMin).toBe(1.5);
  });

  test("rejects minSegmentMs > maxSegmentMs", () => {
    const app = clone(cfg.app);
    app.segmentation.minSegmentMs = 80_000;
    expect(() => parseAppConfig(app)).toThrow(/minSegmentMs/);
  });

  test("rejects a choice without criteria", () => {
    const labels = clone(cfg.labels) as any;
    delete labels.questions.subject.criteria;
    expect(() => parseLabelSet(labels)).toThrow();
  });

  test("rejects a choice without a fallback option", () => {
    const labels = clone(cfg.labels) as any;
    delete labels.questions.subject.criteria.other_topics;
    expect(() => parseLabelSet(labels)).toThrow(/fallback/);
  });

  test("accepts `none` and `other*` as fallback keys", () => {
    const labels = clone(cfg.labels) as any;
    labels.questions.x = { type: "choice", instructions: "x", criteria: { a: "a", none: "n" } };
    labels.questions.y = { type: "choice", instructions: "y", criteria: { a: "a", other: "o" } };
    expect(() => parseLabelSet(labels)).not.toThrow();
  });

  test("rejects a score with fewer than 2 levels", () => {
    const labels = clone(cfg.labels) as any;
    labels.questions.heat.criteria = ["Calm"];
    expect(() => parseLabelSet(labels)).toThrow(/2 levels/);
  });

  test("rejects non-snake_case ids", () => {
    const labels = clone(cfg.labels) as any;
    labels.questions.HotTake = labels.questions.hot_take;
    expect(() => parseLabelSet(labels)).toThrow(/HotTake/);
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
