// npm run replay -- --host <wav> --remote <wav> --speed max|1 [--engine apple|openai] [--no-factcheck] [--no-labels]
//                    [--export <file>]
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { FileSource, type AudioSource } from "../audio/source.ts";
import { Session } from "../pipeline/session.ts";
import { EventBus, processSecrets } from "../store/events.ts";
import { loadKeys } from "../keys.ts";
import { resolveEngine, SettingsStore } from "../settings.ts";
import { appleSpeechStatus, installAppleModel } from "../transcribe/apple.ts";
import type { TranscriptionEngine } from "../pipeline/session.ts";

/**
 * The command: `argv` is what follows the script's path. `deps` lets tests replay offline: the services' fetch, the
 * recordings folder, the output, and the exit (each defaults to the real one).
 */
export async function run(
  argv = process.argv.slice(2),
  deps: { fetch?: typeof fetch; sessionsDir?: string; stdout?: (text: string) => void; exit?: (code: number) => void } = {},
) {
  const stdout = deps.stdout ?? ((t: string) => { process.stdout.write(t); });
  const log = (line = "") => stdout(`${line}\n`);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      host: { type: "string" }, remote: { type: "string" }, speed: { type: "string", default: "max" },
      export: { type: "string" }, quiet: { type: "boolean", default: false },
      engine: { type: "string" }, factcheck: { type: "boolean", default: true }, labels: { type: "boolean", default: true },
    },
  });
  if (!values.host && !values.remote) {
    console.error("usage: npm run replay -- --host <host.wav> --remote <remote.wav> --speed max|1 [--engine apple|openai] [--no-factcheck] [--no-labels] [--export <file>]");
    return exit(1);
  }
  if (values.engine !== undefined && values.engine !== "apple" && values.engine !== "openai") {
    console.error("--engine must be apple or openai");
    return exit(1);
  }
  const keys = loadKeys();
  // the engine: --engine, else the one saved from the app's Settings (resolved as the app does on a first run)
  const apple = await appleSpeechStatus();
  const engine: TranscriptionEngine = (values.engine as TranscriptionEngine | undefined) ?? resolveEngine({
    saved: new SettingsStore().read().transcriptionEngine, openaiKeySet: !keys.missing().includes("openai"), apple,
  }).engine;
  if (engine === "apple") {
    if (!apple.available) {
      console.error(`on-device transcription is not available: ${apple.reason ?? apple.error ?? "unknown reason"}`);
      return exit(1);
    }
    if (!apple.installed) {
      log("installing the on-device speech model...");
      await installAppleModel((f) => stdout(`\r  ${Math.round(f * 100)} %`), { locale: loadConfig().app.transcription.apple.locale });
      log("");
    }
  }
  const cfg = loadConfig();
  const speed = values.speed === "1" ? 1 : "max";
  const sources: AudioSource[] = [];
  if (values.host) sources.push(new FileSource(values.host, "host", speed));
  if (values.remote) sources.push(new FileSource(values.remote, "remote", speed));

  const bus = new EventBus({ redact: processSecrets(), onInvalid: (t, m) => console.error(`event ${t} failed validation: ${m}`) });
  if (!values.quiet) {
    bus.subscribe((e) => {
      const d = e.data as any;
      if (e.type === "utterance") log(`[${(d.startMs / 1000).toFixed(1)}s] ${d.speakerName}: ${d.text}`);
      else if (e.type === "segment.closed") log(`  ── ${d.id} closed (${((d.endMs - d.startMs) / 1000).toFixed(1)} s${d.forced ? ", forced" : ""})`);
      else if (e.type === "segment.labels") {
        // the built-in set's categories, then its markers
        const cats = cfg.labels.categories.map((c) => `${c.id}=${d.choices?.[c.id]?.choice ?? "?"}`).join(" ");
        log(`  ── ${d.segmentId} labels: ${cats} markers=[${d.markers.join(", ")}]`);
      }
      else if (e.type === "claim.flagged") log(`  ⚑ ${d.claimId} flagged (priority ${d.priority.toFixed(2)}): ${d.text}`);
      else if (e.type === "claim.verdict") log(`  ✓ ${d.claimId} ${d.verdict.verdict}: ${d.verdict.restated_claim} ${d.verdict.correction ? `— ${d.verdict.correction}` : ""} (${d.verdict.sources.length} sources, ${d.latencyMs} ms)`);
      else if (e.type === "claim.repeat" || e.type === "claim.duplicate") log(`  ↺ ${e.type} of ${d.claimId} by ${d.utteranceId}`);
      else if (e.type === "claim.dropped") log(`  ✗ ${d.claimId} dropped: ${d.reason}`);
      else if (e.type === "s1.version") log(`  ⚙ s1.version ${d.outcome}: active ${d.active}`);
      else if (e.type === "error") log(`  ! ${d.component}: ${d.message}`);
      else if (e.type === "budget.exhausted") log(`  $ budget exhausted: ${d.message}`);
    });
  }

  const session = new Session({
    mode: "replay", sources, config: cfg, bus, exportBoundary: values.export, fetch: deps.fetch, sessionsDir: deps.sessionsDir,
    engine, features: { factcheck: values.factcheck, labels: values.labels },
  });
  log(`transcription: ${engine === "apple" ? "on this Mac (Apple Speech)" : "OpenAI"}; fact-checking ${values.factcheck ? "on" : "off"}, labels ${values.labels ? "on" : "off"}`);
  process.on("SIGINT", () => { void session.stop(); });
  await session.run();

  const st = session.stats();
  const fc = st.factcheck;
  log("\n── summary ──");
  log(`session     ${session.store.dir}`);
  log(`utterances  ${session.state().utterances.length}`);
  log(`speakers    ${session.speakers.active().map((s) => `${s.displayName} (${s.id})`).join(", ")}`);
  log(`segments    ${session.timeline.segments.length}`);
  log(`claims      ${fc.flagged} flagged, ${fc.repeats} repeats, ${fc.duplicates} duplicates, ${fc.dropped} dropped`);
  log(`verdicts    ${Object.entries(fc.verdicts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  log(`cost        $${st.cost.session.toFixed(4)} (transcription $${st.cost.transcription.toFixed(4)}, Jev $${st.cost.jev.toFixed(4)}, System 2 $${st.cost.s2.toFixed(4)})`);
  if (values.export) log(`export      ${values.export}`);
  exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
