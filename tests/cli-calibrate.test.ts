import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { best, parseRows, run as boundary, scoreThresholds, type BoundaryRow } from "../src/cli/calibrateBoundary.ts";
import { run as speakers, speakerCounts } from "../src/cli/calibrateSpeakers.ts";
import { requireAssets } from "./helpers.ts";
import { cleanTmpDirs, fixtureSlice, tmpDir, wavFile } from "./fakes/index.ts";

// The two offline calibration tools (src/cli/calibrateBoundary.ts, calibrateSpeakers.ts), run in process through
// run(argv, deps) with their output and exit captured. Neither calls a service.

afterAll(() => cleanTmpDirs());

async function capture(cmd: (argv: string[], deps: { stdout: (t: string) => void; exit: (c: number) => void }) => Promise<void>, argv: string[]) {
  const out: string[] = [];
  const codes: number[] = [];
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await cmd(argv, { stdout: (t) => out.push(t), exit: (c) => codes.push(c) });
    return { text: out.join(""), codes, errors: err.mock.calls.map((c) => String(c[0])) };
  } finally {
    err.mockRestore();
  }
}

const row = (p: number, human: boolean | null, i = 0): BoundaryRow => ({ utterance_id: `u_${i}`, speaker: "Nic", text: "t", boundary_p: p, human_boundary: human });

describe("calibrate:boundary", () => {
  test("parseRows skips blank lines and names the first bad row", () => {
    expect(parseRows(`${JSON.stringify(row(0.5, true))}\n\n  \n${JSON.stringify(row(0.2, false))}\n`).length).toBe(2);
    expect(() => parseRows(`${JSON.stringify(row(0.5, true))}\n${JSON.stringify({ ...row(0.5, true), boundary_p: "0.5" })}`)).toThrow("row 2: boundary_p must be a number");
  });

  test("scores: only labelled rows count; no positives score 0; custom thresholds", () => {
    const none = scoreThresholds([row(0.9, false), row(0.1, false), row(0.95, null)], [0.5]);
    expect(none).toEqual([{ threshold: 0.5, tp: 0, fp: 1, fn: 0, precision: 0, recall: 0, f1: 0 }]);
    const s = scoreThresholds([row(0.9, true), row(0.6, false), row(0.3, true)], [0.25, 0.7]);
    expect(s.map((x) => [x.threshold, x.tp, x.fp, x.fn])).toEqual([[0.25, 2, 1, 0], [0.7, 1, 0, 1]]);
    expect(scoreThresholds([]).length).toBe(7);
  });

  test("best: the highest F1, the first of equals; nothing to choose from throws", () => {
    const a = { threshold: 0.3, tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 0.8 };
    expect(best([a, { ...a, threshold: 0.4 }, { ...a, threshold: 0.5, f1: 0.7 }]).threshold).toBe(0.3);
    expect(best([a, { ...a, threshold: 0.6, f1: 0.9 }]).threshold).toBe(0.6);
    expect(() => best([])).toThrow(TypeError);
  });

  test("the command: usage without a file; nothing labelled; a table and the best threshold", async () => {
    expect(await capture(boundary, [])).toMatchObject({ codes: [1], errors: ["usage: npm run calibrate:boundary -- <labelled.jsonl>"], text: "" });
    const dir = tmpDir("calib-");
    writeFileSync(join(dir, "none.jsonl"), [row(0.5, null), row(0.7, null)].map((r) => JSON.stringify(r)).join("\n"));
    expect(await capture(boundary, [join(dir, "none.jsonl")])).toMatchObject({ codes: [1], errors: ["no row has human_boundary set to true or false"] });
    writeFileSync(join(dir, "rows.jsonl"), [row(0.9, true, 1), row(0.55, false, 2), row(0.35, true, 3), row(0.2, false, 4), row(0.5, null, 5)].map((r) => JSON.stringify(r)).join("\n"));
    const r = await capture(boundary, [join(dir, "rows.jsonl")]);
    expect(r.codes).toEqual([]);
    const lines = r.text.trimEnd().split("\n");
    expect(lines[0]).toBe("4 labelled rows (1 unlabelled skipped)");
    expect(lines[1]).toBe("threshold  precision  recall   F1");
    expect(lines.slice(2, 9).map((l) => l.trim().split(/\s+/)[0])).toEqual(["0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9"]);
    expect(lines[2]).toBe("      0.3      0.667   1.000  0.800");
    expect(lines[9]).toBe("best threshold: 0.3 (F1 0.800); set segmentation.boundaryThreshold in config/app.json");
    writeFileSync(join(dir, "bad.jsonl"), `${JSON.stringify(row(0.5, true))}\nnot json`);
    await expect(capture(boundary, [join(dir, "bad.jsonl")])).rejects.toThrow(SyntaxError);
  });
});

describe("calibrate:speakers", () => {
  /** 20 s of each fixture stream, as WAV files. */
  function slices() {
    const dir = tmpDir("calib-");
    return { host: wavFile(dir, fixtureSlice("host", 0, 20_000), "host.wav"), remote: wavFile(dir, fixtureSlice("remote", 0, 20_000), "remote.wav") };
  }

  test("the command without a WAV prints its usage and exits 1", async () => {
    expect(await capture(speakers, [])).toMatchObject({ codes: [1], errors: ["usage: npm run calibrate:speakers -- --host <host.wav> --remote <remote.wav>"] });
    expect(await capture(speakers, ["--voices", "2"])).toMatchObject({ codes: [1] });
  });

  test("speakerCounts: a row per threshold; limits cap the voices; one stream alone works", async () => {
    requireAssets();
    const { host, remote } = slices();
    const thresholds = [0.35, 0.55, 0.75];
    const all = await speakerCounts(host, remote, thresholds);
    expect(all.utterances).toBeGreaterThan(0);
    expect(all.rows.map((r) => r.threshold)).toEqual(thresholds);
    expect(all.rows.every((r) => r.speakers >= 1)).toBe(true);
    const capped = await speakerCounts(host, remote, thresholds, { host: 1, remote: 1 });
    expect(capped.rows.every((r) => r.speakers <= 2)).toBe(true);
    const hostOnly = await speakerCounts(host, undefined, [0.5]);
    expect(hostOnly.rows).toEqual([{ threshold: 0.5, speakers: expect.any(Number) }]);
    expect((await speakerCounts(undefined, remote, [0.5])).utterances).toBeGreaterThan(0);
  });

  test("the command: nine thresholds, with or without a voice limit", async () => {
    requireAssets();
    const { host, remote } = slices();
    const r = await capture(speakers, ["--host", host, "--remote", remote, "--voices", "2"]);
    const lines = r.text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\d+ utterances, at most 1 voice on the host mic and 2 on the call$/);
    expect(lines[1]).toBe("threshold  speakers");
    expect(lines.slice(2).map((l) => l.trim().split(/\s+/)[0])).toEqual(["0.35", "0.40", "0.45", "0.50", "0.55", "0.60", "0.65", "0.70", "0.75"]);
    const free = await capture(speakers, ["--host", host]);
    expect(free.text.split("\n")[0]).toMatch(/^\d+ utterances, no limit on voices per stream$/);
    expect(free.codes).toEqual([]);
  });

  test.fails("BUG §11.20: a --voices that is not a number is refused", async () => {
    requireAssets();
    const { host } = slices();
    const r = await capture(speakers, ["--host", host, "--voices", "abc"]);
    expect(r.codes).toEqual([1]); // today it runs with a NaN limit and prints "abc on the call"
  });
});

describe("the calibration tools' defaults: the real output and exit", () => {
  test("usage exits the process; results go to stdout", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation(((t: string) => { written.push(String(t)); return true; }) as never);
    try {
      await boundary([]);
      await speakers([]);
      expect(exit.mock.calls).toEqual([[1], [1]]);
      const dir = tmpDir("calib-");
      writeFileSync(join(dir, "rows.jsonl"), [row(0.9, true), row(0.1, false)].map((r) => JSON.stringify(r)).join("\n"));
      await boundary([join(dir, "rows.jsonl")]);
      requireAssets();
      await speakers(["--host", wavFile(dir, fixtureSlice("host", 0, 8_000), "host.wav")]);
    } finally {
      exit.mockRestore();
      err.mockRestore();
      out.mockRestore();
    }
    expect(written.join("")).toContain("best threshold: ");
    expect(written.join("")).toContain("threshold  speakers");
  });
});
