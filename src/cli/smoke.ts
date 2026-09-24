// Live checks of every external service (§4.11, about $0.30). npm run smoke [-- --checks 1,2,4] [--allow-over-dev-cap]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { Budget, sumDevSpend } from "../budget.ts";
import { readWav16k, SAMPLE_RATE } from "../audio/wav.ts";
import { Transcriber } from "../transcribe/openai.ts";
import { JevClient } from "../jev/client.ts";
import type { JevAnswer, QuestionSet } from "../jev/types.ts";
import { S2Client } from "../factcheck/s2.ts";
import { timelineQuestions } from "../pipeline/timeline.ts";
import { processSecrets } from "../store/events.ts";
import { SessionStore } from "../store/sessionStore.ts";

const { values } = parseArgs({ options: { checks: { type: "string" }, "allow-over-dev-cap": { type: "boolean", default: false } } });
const only = values.checks ? new Set(values.checks.split(",").map((s) => Number(s.trim()))) : null;
const run = (n: number) => !only || only.has(n);

const cfg = loadConfig();
const openrouter = process.env.OPENROUTER_API_KEY ?? "";
const openai = process.env.OPENAI_API_KEY ?? "";
const store = new SessionStore({ prefix: "smoke-", redact: processSecrets() });
const budget = new Budget({
  sessionCapUsd: cfg.app.budget.sessionCapUsd, devCapUsd: cfg.app.budget.devCapUsd,
  enforceDevCap: !values["allow-over-dev-cap"], devSpentUsd: sumDevSpend(),
});
const jev = new JevClient(cfg.app.jev, { fetch, apiKey: openrouter, budget, log: (r) => store.append("jev_calls", r) });
const s2 = new S2Client(cfg.app.s2, { fetch, apiKey: openrouter, budget, log: (r) => store.append("s2_calls", r) });
const transcriber = new Transcriber(cfg.app.transcription, { fetch, apiKey: openai, budget, log: (r) => store.append("transcriptions", r) });

const script = JSON.parse(readFileSync("fixtures/conversation/script.json", "utf8")) as {
  lines: { line: number; voice: string; stream: "host" | "remote"; text: string; startMs: number; endMs: number }[];
};
const state = (i: number) => ({
  current_segment: script.lines.slice(Math.max(0, i - 3), i).map((l) => ({ speaker: l.voice.split(" ")[0], text: l.text, tags: [] })),
  new_utterance: { speaker: script.lines[i].voice.split(" ")[0], text: script.lines[i].text, tags: [] },
});
const s1Questions = (): QuestionSet => ({ boundary: cfg.labels.boundary, ...cfg.s1.questions } as QuestionSet);

const results: { n: number; name: string; pass: boolean; detail: string }[] = [];
async function check(n: number, name: string, fn: () => Promise<string>) {
  if (!run(n)) return;
  const before = budget.totals().session;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ n, name, pass: true, detail });
  } catch (e) {
    results.push({ n, name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
  const r = results[results.length - 1];
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${n}. ${name} — ${r.detail} [${Date.now() - t0} ms, $${(budget.totals().session - before).toFixed(5)}]`);
}

function typedLike(q: QuestionSet[string], a: JevAnswer | undefined): boolean {
  if (!a || a.type !== q.type) return false;
  if (a.type === "noul") return typeof a.noul === "number";
  if (a.type === "choice") return q.type === "choice" && a.choice in q.criteria;
  return typeof a.score === "number";
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

await check(1, "transcribe the first Daniel line", async () => {
  const line = script.lines.find((l) => l.voice === "Daniel")!;
  const samples = readWav16k("fixtures/conversation/remote.wav");
  const a = Math.max(0, Math.round(((line.startMs - 200) * SAMPLE_RATE) / 1000));
  const b = Math.round(((line.endMs + 200) * SAMPLE_RATE) / 1000);
  const r = await transcriber.transcribe("smoke_1", samples.slice(a, b));
  if (!r.ok) throw new Error(r.error);
  if (!/\bJev\b/i.test(r.text)) throw new Error(`text lacks "Jev": ${r.text}`);
  return `"${r.text}"`;
});

await check(2, "per-utterance Jev request (boundary + s1@1)", async () => {
  const q = s1Questions();
  const res = await jev.ask(state(1), q, { purpose: "smoke", question_set_version: "s1@1", live: false });
  const bad = Object.entries(q).filter(([id, qq]) => !typedLike(qq, res.answers[id])).map(([id]) => id);
  if (bad.length) throw new Error(`untyped or missing answers: ${bad.join(", ")}`);
  if (!res.model.startsWith("typesafe/jev-1.13")) throw new Error(`model ${res.model}`);
  return `model ${res.model}, claim=${(res.answers.claim as any).noul.toFixed(2)}, cost $${res.usage.cost}`;
});

await check(3, "segment request with the full label set", async () => {
  const q = timelineQuestions(cfg.labels, ["OpenRouter lists Jev", "Surfing in Sydney"]);
  const seg = script.lines.slice(0, 5).map((l) => ({ speaker: l.voice.split(" ")[0], text: l.text, tags: [] }));
  const res = await jev.ask({ previous_segment: [], segment: seg }, q, { purpose: "smoke", live: false });
  const missing = Object.keys(q).filter((id) => !typedLike(q[id], res.answers[id]));
  if (missing.length) throw new Error(`missing answers: ${missing.join(", ")}`);
  return `${Object.keys(q).length} answers, subject=${(res.answers.subject as any).choice}, story=${(res.answers.story as any).choice}`;
});

async function latencyRun(known: number) {
  const q: QuestionSet = s1Questions();
  for (let i = 1; i <= 3; i++) q[`attention_${i}`] = { type: "noul", instructions: `Judge only new_utterance. Synthetic attention question ${i}: it mentions a price, a date, or a model name.` };
  for (let i = 1; i <= known; i++) q[`known_c_${i}`] = { type: "noul", instructions: `new_utterance restates or relies on this already-checked claim: "Synthetic claim number ${i} about an AI model's price or release."` };
  const lat: number[] = [];
  let timeouts = 0;
  for (let i = 0; i < 50; i++) {
    const t0 = Date.now();
    try {
      await jev.ask(state(1 + (i % (script.lines.length - 1))), q, {
        purpose: "smoke", live: true, maxAttempts: 1, timeoutMs: cfg.app.jev.utteranceTimeoutMs,
      });
      lat.push(Date.now() - t0);
    } catch (e) {
      lat.push(Date.now() - t0);
      timeouts++;
      if (!/timeout|abort/i.test(String(e))) console.log(`      call ${i + 1} failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
    }
  }
  const p50 = pct(lat, 50);
  const p95 = pct(lat, 95);
  const detail = `${Object.keys(q).length} questions: p50 ${p50} ms, p95 ${p95} ms, ${timeouts}/50 failed or timed out`;
  if (timeouts > 2 || p95 > 1500) throw new Error(detail);
  return detail;
}

if (run(4)) {
  await check(4, `50 worst-case per-utterance requests (maxKnownQuestions ${cfg.app.factcheck.maxKnownQuestions})`, () => latencyRun(cfg.app.factcheck.maxKnownQuestions));
  if (!results.at(-1)!.pass) {
    await check(4, "rerun with maxKnownQuestions 20", () => latencyRun(20));
    if (results.at(-1)!.pass) console.log("      → set factcheck.maxKnownQuestions to 20 in config/app.json");
    else console.log("      → STOP: the alpha endpoint is too slow for live use; the fallback (TypeSafe's direct API) needs a TypeSafe key and the user's approval.");
  }
}

await check(5, `research "Jev is 445 times cheaper than GPT" (engine ${cfg.app.s2.web.engine})`, async () => {
  const input = { speaker: "Daniel", utterance: "Honestly, Jev is four hundred and forty-five times cheaper than GPT.", segment: script.lines.slice(0, 2).map((l) => l.text).join(" ") };
  const t0 = Date.now();
  const v = await s2.research(input);
  if (v.sources.length < 1 && v.verdict !== "unverifiable" && v.verdict !== "not_a_claim") throw new Error("no sources");
  if (v.sources.length < 1) throw new Error(`verdict ${v.verdict} with no source`);
  const main = `${v.verdict} (${v.confidence}): ${v.restated_claim} ${v.correction ? `— ${v.correction}` : ""} [${v.sources.length} sources, ${Date.now() - t0} ms]`;
  let native: string;
  try {
    const n = await s2.research(input, { engine: "native", max_results: cfg.app.s2.web.max_results });
    native = `native engine works: ${n.verdict}, ${n.sources.length} sources`;
  } catch (e) {
    native = `native engine failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`;
  }
  return `${main}; ${native}`;
});

await check(6, "audit and rewrite calls with canned inputs", async () => {
  const a = await s2.audit([
    { utterance_id: "u_1", speaker: "Daniel", text: "Nvidia's market cap passed five trillion dollars this summer." },
    { utterance_id: "u_2", speaker: "Karen", text: "I just think the vibes are off with these agent demos." },
  ]);
  const input = JSON.stringify({
    active_questions: cfg.s1.questions, thresholds: cfg.s1.thresholds,
    false_alarms: [
      { utterance: "Jev is a million times better at this than any chatbot.", reason: "hyperbole" },
      { utterance: "Claude is basically magic at coding now.", reason: "opinion" },
      { utterance: "Everyone at the conference was talking about agents.", reason: "too_vague" },
    ],
    good_flags: ["OpenRouter listed Jev on September eighteenth.", "Jev is four hundred and forty-five times cheaper than GPT."],
    misses: [],
  }, null, 1);
  const r = await s2.rewrite(input);
  return `audit ${a.items.length} items (${a.items.filter((i) => i.has_checkable_claim).length} checkable); rewrite ${r.changes.length} changes (${r.changes.map((c) => `${c.op}:${c.target}`).join(", ")})`;
});

store.close();
const total = budget.totals().session;
const pass = results.every((r) => r.pass) && total <= 0.5;
console.log(`\n${pass ? "ALL PASS" : "SOME CHECKS FAILED"} — total cost $${total.toFixed(4)} (limit $0.50); dev total $${budget.totals().dev.toFixed(4)}; rows in ${store.dir}`);
process.exit(pass ? 0 : 1);
