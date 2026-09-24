// npm run replay -- --host <wav> --remote <wav> --speed max|1 [--export <file>] [--allow-over-dev-cap]
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { FileSource, type AudioSource } from "../audio/source.ts";
import { Session } from "../pipeline/session.ts";
import { EventBus, processSecrets } from "../store/events.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string" }, remote: { type: "string" }, speed: { type: "string", default: "max" },
    export: { type: "string" }, "allow-over-dev-cap": { type: "boolean", default: false }, quiet: { type: "boolean", default: false },
  },
});
if (!values.host && !values.remote) {
  console.error("usage: npm run replay -- --host <host.wav> --remote <remote.wav> --speed max|1 [--export <file>]");
  process.exit(1);
}
const speed = values.speed === "1" ? 1 : "max";
const sources: AudioSource[] = [];
if (values.host) sources.push(new FileSource(values.host, "host", speed));
if (values.remote) sources.push(new FileSource(values.remote, "remote", speed));

const bus = new EventBus({ redact: processSecrets(), onInvalid: (t, m) => console.error(`event ${t} failed validation: ${m}`) });
if (!values.quiet) {
  bus.subscribe((e) => {
    const d = e.data as any;
    if (e.type === "utterance") console.log(`[${(d.startMs / 1000).toFixed(1)}s] ${d.speakerName}: ${d.text}`);
    else if (e.type === "segment.closed") console.log(`  ── ${d.id} closed (${((d.endMs - d.startMs) / 1000).toFixed(1)} s${d.forced ? ", forced" : ""})`);
    else if (e.type === "segment.labels") console.log(`  ── ${d.segmentId} labels: subject=${d.choices?.subject?.choice ?? "?"} mode=${d.choices?.mode?.choice ?? "?"} markers=[${d.markers.join(", ")}]`);
    else if (e.type === "claim.flagged") console.log(`  ⚑ ${d.claimId} flagged (priority ${d.priority.toFixed(2)}): ${d.text}`);
    else if (e.type === "claim.verdict") console.log(`  ✓ ${d.claimId} ${d.verdict.verdict}: ${d.verdict.restated_claim} ${d.verdict.correction ? `— ${d.verdict.correction}` : ""} (${d.verdict.sources.length} sources, ${d.latencyMs} ms)`);
    else if (e.type === "claim.repeat" || e.type === "claim.duplicate") console.log(`  ↺ ${e.type} of ${d.claimId} by ${d.utteranceId}`);
    else if (e.type === "claim.dropped") console.log(`  ✗ ${d.claimId} dropped: ${d.reason}`);
    else if (e.type === "s1.version") console.log(`  ⚙ s1.version ${d.outcome}: active ${d.active}`);
    else if (e.type === "error") console.log(`  ! ${d.component}: ${d.message}`);
    else if (e.type === "budget.exhausted") console.log(`  $ budget exhausted: ${d.message}`);
  });
}

const session = new Session({
  mode: "replay", sources, config: loadConfig(), bus, allowOverDevCap: values["allow-over-dev-cap"], exportBoundary: values.export,
});
process.on("SIGINT", () => { void session.stop(); });
await session.run();

const st = session.stats();
const fc = st.factcheck;
console.log("\n── summary ──");
console.log(`session     ${session.store.dir}`);
console.log(`utterances  ${session.state().utterances.length}`);
console.log(`speakers    ${session.speakers.active().map((s) => `${s.displayName} (${s.id})`).join(", ")}`);
console.log(`segments    ${session.timeline.segments.length}`);
console.log(`claims      ${fc.flagged} flagged, ${fc.repeats} repeats, ${fc.duplicates} duplicates, ${fc.dropped} dropped`);
console.log(`verdicts    ${Object.entries(fc.verdicts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
console.log(`cost        $${st.cost.session.toFixed(4)} (transcription $${st.cost.transcription.toFixed(4)}, Jev $${st.cost.jev.toFixed(4)}, System 2 $${st.cost.s2.toFixed(4)}); dev total $${st.cost.dev.toFixed(4)}`);
if (values.export) console.log(`export      ${values.export}`);
process.exit(0);
