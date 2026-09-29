// Pre-show checks (§4.16): models, capture helper and permissions, the transcription engine, keys, config, OpenRouter
// credit, one live call per service (about $0.02 with OpenAI and OpenRouter; nothing with Apple Speech and no OpenRouter
// key), and free disk. npm run preflight
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
import { resolveEngine, SettingsStore } from "../settings.ts";
import { AppleSpeech, appleSpeechStatus } from "../transcribe/apple.ts";
import type { TranscriptionEngine } from "../pipeline/session.ts";
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

const keys = new KeyStore().load();
const apple = await appleSpeechStatus();
// the engine the app would use: the one saved in Settings, resolved as a first run would
const engine: TranscriptionEngine = resolveEngine({
  saved: new SettingsStore().read().transcriptionEngine, openaiKeySet: !keys.missing().includes("openai"), apple,
}).engine;
const hasOpenRouter = !keys.missing().includes("openrouter");

await check("transcription engine", async () => {
  if (engine === "openai") return "OpenAI (Settings → Transcription)";
  if (!apple.available) throw new Error(`Apple Speech is not available: ${apple.reason ?? apple.error ?? "unknown reason"}`);
  if (!apple.installed) throw new Error("the on-device speech model is not installed: open the app, which installs it, or run npm run build:transcribe && native/transcribe/.build/release/tattle-transcribe --install");
  return `on this Mac (Apple Speech, ${apple.locale}), model installed`;
});

await check("keys are set", async () => {
  const where = (k: { env: string; source: string | null }) => `${k.env} (${k.source === "file" ? "saved from the page" : ".env or shell"})`;
  if (engine === "openai" && keys.missing().includes("openai")) {
    throw new Error("missing: OPENAI_API_KEY, which OpenAI transcription needs (run npm run serve and add it on the page, or set it in .env)");
  }
  const set = keys.status().filter((k) => k.set).map(where);
  const optional = hasOpenRouter ? "" : "; no OpenRouter key: fact-checking, labels, and Chat ask for it when turned on";
  return `${set.length ? set.join(", ") : "none needed"}${optional}`;
});

let cfg: Config | null = null;
await check("config is valid", async () => {
  cfg = loadConfig();
  return `app, labels, and ${cfg.s1.id}`;
});

if (hasOpenRouter) await check("OpenRouter key limit and remaining credit", async () => {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = (await res.json()).data ?? {};
  const remaining = d.limit_remaining;
  const detail = `limit ${d.limit === null ? "none" : `$${d.limit}`}, remaining ${remaining === null || remaining === undefined ? "n/a" : `$${Number(remaining).toFixed(2)}`}, used $${Number(d.usage ?? 0).toFixed(2)}`;
  if (typeof remaining === "number" && remaining <= 0) throw new Error(`${detail}: no credit left`);
  return detail;
});

if (cfg) {
  const c: Config = cfg;
  const store = new SessionStore({ prefix: "preflight-", redact: processSecrets() });
  const budget = new Budget();
  const openrouter = process.env.OPENROUTER_API_KEY ?? "";

  await check(engine === "apple" ? "transcription on this Mac" : "transcription call", async () => {
    const src = existsSync("fixtures/conversation/remote.wav") ? readWav16k("fixtures/conversation/remote.wav") : null;
    if (!src) throw new Error("fixtures missing: run npm run fixtures");
    const clip = src.slice(8 * SAMPLE_RATE, 15 * SAMPLE_RATE);
    const log = (r: unknown) => store.append("transcriptions", r);
    if (engine === "apple") {
      const a = new AppleSpeech(c.app.transcription, { emitPartials: false, log, onPartial: () => {}, onError: () => {} });
      const r = await a.transcribe("preflight", clip);
      await a.close();
      if (!r.ok) throw new Error(r.error);
      return `"${r.text}"`;
    }
    const t = new Transcriber(c.app.transcription, { fetch, apiKey: process.env.OPENAI_API_KEY ?? "", budget, log });
    const r = await t.transcribe("preflight", clip);
    if (!r.ok) throw new Error(r.error);
    return `"${r.text}"`;
  });

  if (hasOpenRouter) await check("Jev call", async () => {
    const jev = new JevClient(c.app.jev, { fetch, apiKey: openrouter, budget, log: (r) => store.append("jev_calls", r) });
    const res = await jev.ask(
      { current_segment: [], new_utterance: { speaker: "Nic", text: "OpenRouter listed Jev on September eighteenth.", tags: [] } },
      { boundary: c.timeline.boundary, ...c.s1.questions } as never, { purpose: "preflight" });
    if (!res.model.startsWith("typesafe/jev-1.13")) throw new Error(`unexpected model ${res.model}`);
    return `${res.model}, claim ${(res.answers.claim as { noul: number }).noul.toFixed(2)}`;
  });

  if (hasOpenRouter) await check("System 2 call (research with web search)", async () => {
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
