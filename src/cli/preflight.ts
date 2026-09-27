// Pre-show checks (§4.16): models, capture helper and permissions, keys, config, OpenRouter credit,
// one live call per service (about $0.02), and free disk. npm run preflight
import { execFile, spawn } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { promisify } from "node:util";
import { loadConfig, type Config } from "../config.ts";
import { Budget } from "../budget.ts";
import { readWav16k, SAMPLE_RATE } from "../audio/wav.ts";
import { Transcriber } from "../transcribe/openai.ts";
import { JevClient } from "../jev/client.ts";
import { S2Client } from "../factcheck/s2.ts";
import { appPaths, speakerModelPath, vadModelPath } from "../paths.ts";
import { processSecrets } from "../store/events.ts";
import { KeyStore } from "../keys.ts";
import { SessionStore } from "../store/sessionStore.ts";

const run = promisify(execFile);
let failures = 0;
function report(pass: boolean, name: string, detail: string) {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
async function check(name: string, fn: () => Promise<string>) {
  try {
    report(true, name, await fn());
  } catch (e) {
    report(false, name, e instanceof Error ? e.message : String(e));
  }
}

await check("models are present", async () => {
  const missing = [vadModelPath(), speakerModelPath()].filter((p) => !existsSync(p));
  if (missing.length) throw new Error(`missing ${missing.join(", ")}: run npm run models`);
  return "Silero VAD and WeSpeaker";
});

await check("capture helper is built and has both permissions", async () => {
  if (!existsSync(appPaths().helper)) throw new Error("not built: run npm run build:capture");
  const ping = spawn("sh", ["-c", "sleep 0.8; afplay /System/Library/Sounds/Ping.aiff; afplay /System/Library/Sounds/Ping.aiff"], { stdio: "ignore" });
  const { stdout } = await run(appPaths().helper, ["--probe", "3"], { timeout: 40_000 });
  ping.kill();
  const lv = JSON.parse(stdout.trim().split("\n").pop()!);
  const problems: string[] = [];
  if (!(lv.remote?.peakDbfs > -40)) problems.push(`system audio peak ${lv.remote?.peakDbfs} dBFS (grant System Audio Recording to your terminal)`);
  if (!(lv.host?.peakDbfs > -100)) problems.push(`microphone is digital silence (grant Microphone to your terminal)`);
  if (problems.length) throw new Error(problems.join("; "));
  return `system audio peak ${lv.remote.peakDbfs} dBFS, microphone peak ${lv.host.peakDbfs} dBFS`;
});

await check("keys are set", async () => {
  const keys = new KeyStore().load();
  const missing = keys.status().filter((k) => !k.set).map((k) => k.env);
  if (missing.length) throw new Error(`missing: ${missing.join(", ")} (run npm run serve and add them on the page, or set them in .env)`);
  return keys.status().map((k) => `${k.env} (${k.source === "file" ? "saved from the page" : ".env or shell"})`).join(", ");
});

let cfg: Config | null = null;
await check("config is valid", async () => {
  cfg = loadConfig();
  return `app, labels, and ${cfg.s1.id}`;
});

await check("OpenRouter key limit and remaining credit", async () => {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = (await res.json()).data ?? {};
  const remaining = d.limit_remaining;
  const detail = `limit ${d.limit === null ? "none" : `$${d.limit}`}, remaining ${remaining === null || remaining === undefined ? "n/a" : `$${Number(remaining).toFixed(2)}`}, used $${Number(d.usage ?? 0).toFixed(2)}`;
  if (typeof remaining === "number" && cfg && remaining < cfg.app.budget.sessionCapUsd) throw new Error(`${detail}: less than the session cap`);
  return detail;
});

if (cfg) {
  const c: Config = cfg;
  const store = new SessionStore({ prefix: "preflight-", redact: processSecrets() });
  const budget = new Budget({ sessionCapUsd: c.app.budget.sessionCapUsd, devCapUsd: c.app.budget.devCapUsd, enforceDevCap: false, devSpentUsd: 0 });
  const openrouter = process.env.OPENROUTER_API_KEY ?? "";

  await check("transcription call", async () => {
    const src = existsSync("fixtures/conversation/remote.wav") ? readWav16k("fixtures/conversation/remote.wav") : null;
    if (!src) throw new Error("fixtures missing: run npm run fixtures");
    const t = new Transcriber(c.app.transcription, { fetch, apiKey: process.env.OPENAI_API_KEY ?? "", budget, log: (r) => store.append("transcriptions", r) });
    const r = await t.transcribe("preflight", src.slice(8 * SAMPLE_RATE, 15 * SAMPLE_RATE));
    if (!r.ok) throw new Error(r.error);
    return `"${r.text}"`;
  });

  await check("Jev call", async () => {
    const jev = new JevClient(c.app.jev, { fetch, apiKey: openrouter, budget, log: (r) => store.append("jev_calls", r) });
    const res = await jev.ask(
      { current_segment: [], new_utterance: { speaker: "Nic", text: "OpenRouter listed Jev on September eighteenth.", tags: [] } },
      { boundary: c.labels.boundary, ...c.s1.questions } as never, { purpose: "preflight" });
    if (!res.model.startsWith("typesafe/jev-1.13")) throw new Error(`unexpected model ${res.model}`);
    return `${res.model}, claim ${(res.answers.claim as { noul: number }).noul.toFixed(2)}`;
  });

  await check("System 2 call (research with web search)", async () => {
    const s2 = new S2Client(c.app.s2, { fetch, apiKey: openrouter, budget, log: (r) => store.append("s2_calls", r) });
    const v = await s2.research({ speaker: "Nic", utterance: "OpenRouter listed Jev on September eighteenth.", segment: "" });
    return `${v.verdict}, ${v.sources.length} sources`;
  });
  store.close();
  console.log(`      spend $${budget.totals().session.toFixed(4)}; rows in ${store.dir}`);
}

await check("at least 2 GB of free disk", async () => {
  const s = statfsSync(".");
  const gb = (s.bavail * s.bsize) / 1e9;
  if (gb < 2) throw new Error(`${gb.toFixed(1)} GB free`);
  return `${gb.toFixed(0)} GB free`;
});

console.log(failures === 0 ? "\nPREFLIGHT PASS" : `\nPREFLIGHT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
