// Prints how many speakers each similarity threshold creates on the given WAVs (§4.4). Local only: no API calls.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.ts";
import { FileSource, mergeSources, type AudioSource } from "../audio/source.ts";
import { StreamVad, UtteranceIds, type Utterance } from "../audio/vad.ts";
import { SAMPLE_RATE } from "../audio/wav.ts";
import { Embedder, SpeakerRegistry, type VoiceLimits } from "../speakers/registry.ts";

/** `limits` caps the voices per stream (the default is no cap, so the count shows what the threshold alone does). */
export async function speakerCounts(host: string | undefined, remote: string | undefined, thresholds: number[], limits: VoiceLimits = {}) {
  const cfg = loadConfig();
  const ids = new UtteranceIds();
  const sources: AudioSource[] = [];
  if (host) sources.push(new FileSource(host, "host", "max"));
  if (remote) sources.push(new FileSource(remote, "remote", "max"));
  const vads = { host: new StreamVad("host", cfg.app.vad, ids), remote: new StreamVad("remote", cfg.app.vad, ids) };
  const utts: Utterance[] = [];
  for await (const f of mergeSources(sources, (s) => utts.push(...vads[s].flush()))) utts.push(...vads[f.stream].accept(f.samples, f.sessionMs));
  utts.sort((a, b) => a.startMs - b.startMs);
  const embedder = new Embedder();
  const vs = utts.map((u) => (u.samples.length / SAMPLE_RATE >= cfg.app.speakers.minEmbedSeconds ? embedder.embed(u.samples) : null));
  return {
    utterances: utts.length,
    rows: thresholds.map((threshold) => {
      const reg = new SpeakerRegistry(cfg.app.speakers, embedder, limits);
      utts.forEach((u, i) => reg.assignEmbedding(u.stream, vs[i], threshold));
      return { threshold, speakers: reg.active().length };
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { host: { type: "string" }, remote: { type: "string" }, voices: { type: "string" } } });
  if (!values.host && !values.remote) {
    console.error("usage: npm run calibrate:speakers -- --host <host.wav> --remote <remote.wav>");
    process.exit(1);
  }
  const thresholds = Array.from({ length: 9 }, (_, i) => Math.round((0.35 + i * 0.05) * 100) / 100);
  // --voices <n>: the people on the call (the host's mic always carries one), as the app uses them live
  const limits: VoiceLimits = values.voices !== undefined ? { host: 1, remote: Number(values.voices) } : {};
  const { utterances, rows } = await speakerCounts(values.host, values.remote, thresholds, limits);
  console.log(`${utterances} utterances${values.voices !== undefined ? `, at most 1 voice on the host mic and ${values.voices} on the call` : ", no limit on voices per stream"}`);
  console.log("threshold  speakers");
  for (const r of rows) console.log(`${r.threshold.toFixed(2).padStart(9)}  ${r.speakers}`);
}
