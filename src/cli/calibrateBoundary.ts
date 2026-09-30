// Offline: precision, recall, and F1 of the boundary threshold on host-labelled rows (§4.12). No API calls.
// Input: JSONL rows { utterance_id, speaker, text, boundary_p, human_boundary } from `replay --export`, with human_boundary filled in.
import { readFileSync } from "node:fs";
import { isMain } from "../entry.ts";

export interface BoundaryRow { utterance_id: string; speaker: string; text: string; boundary_p: number; human_boundary: boolean | null }
export interface ThresholdScore { threshold: number; tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }

export function parseRows(text: string): BoundaryRow[] {
  return text.split("\n").filter((l) => l.trim()).map((l, i) => {
    const r = JSON.parse(l);
    if (typeof r.boundary_p !== "number") throw new Error(`row ${i + 1}: boundary_p must be a number`);
    return r;
  });
}

export function scoreThresholds(rows: BoundaryRow[], thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]): ThresholdScore[] {
  const labelled = rows.filter((r) => typeof r.human_boundary === "boolean");
  return thresholds.map((threshold) => {
    let tp = 0, fp = 0, fn = 0;
    for (const r of labelled) {
      const predicted = r.boundary_p >= threshold;
      if (predicted && r.human_boundary) tp++;
      else if (predicted && !r.human_boundary) fp++;
      else if (!predicted && r.human_boundary) fn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { threshold, tp, fp, fn, precision, recall, f1 };
  });
}

export function best(scores: ThresholdScore[]): ThresholdScore {
  return scores.reduce((a, b) => (b.f1 > a.f1 ? b : a));
}

/** The command: `argv` is what follows the script's path; `deps` lets tests capture the output and the exit. */
export async function run(argv = process.argv.slice(2), deps: { stdout?: (text: string) => void; exit?: (code: number) => void } = {}) {
  const log = (line: string) => (deps.stdout ?? ((t: string) => { process.stdout.write(t); }))(`${line}\n`);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const file = argv[0];
  if (!file) {
    console.error("usage: npm run calibrate:boundary -- <labelled.jsonl>");
    return exit(1);
  }
  const rows = parseRows(readFileSync(file, "utf8"));
  const labelled = rows.filter((r) => typeof r.human_boundary === "boolean").length;
  if (labelled === 0) {
    console.error("no row has human_boundary set to true or false");
    return exit(1);
  }
  const scores = scoreThresholds(rows);
  log(`${labelled} labelled rows (${rows.length - labelled} unlabelled skipped)`);
  log("threshold  precision  recall   F1");
  for (const s of scores) {
    log(`${s.threshold.toFixed(1).padStart(9)}  ${s.precision.toFixed(3).padStart(9)}  ${s.recall.toFixed(3).padStart(6)}  ${s.f1.toFixed(3)}`);
  }
  const b = best(scores);
  log(`best threshold: ${b.threshold.toFixed(1)} (F1 ${b.f1.toFixed(3)}); set segmentation.boundaryThreshold in config/app.json`);
}

if (isMain(import.meta.url)) await run();
