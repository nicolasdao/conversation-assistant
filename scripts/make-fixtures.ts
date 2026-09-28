// Builds fixtures/conversation/{host,remote}.wav (16 kHz mono PCM16) and script.json from macOS `say` voices (§4.3).
// The conversation is fictional. Its factual-sounding lines are test statements, planted so the fact-checker has
// something to catch: some are deliberately false, exaggerated, or unverified, and none is a claim of this project.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sherpa from "sherpa-onnx-node";
import { SAMPLE_RATE } from "../src/audio/wav.ts";

type Voice = "Samantha" | "Daniel" | "Sandy (English (UK))";
interface Line {
  voice: Voice;
  text: string;
  /** What the pipeline should do with it. */
  expected: { claim: boolean; repeatOf?: number; hyperbole?: boolean; topicChange?: boolean };
}

const STREAM: Record<Voice, "host" | "remote"> = { Samantha: "host", Daniel: "remote", "Sandy (English (UK))": "remote" };

// Sandy replaces the spec's Karen: WeSpeaker scored Karen 0.86 similar to Samantha, so no threshold in 0.35–0.75 told
// them apart (user decision, 24 September 2026). Lines still address the speaker as "Karen".
// One sentence per line, so each line is one utterance (a sentence pause can exceed the VAD's 0.5 s silence).
const LINES: Line[] = [
  { voice: "Samantha", text: "Welcome back to the show everyone, tonight we are talking about Jev, the new decision model from TypeSafe.", expected: { claim: false } },
  { voice: "Daniel", text: "Honestly, Jev is four hundred and forty-five times cheaper than GPT.", expected: { claim: true } },
  { voice: "Sandy (English (UK))", text: "I don't buy that at all Daniel, cheap is not the same as good, and I think you are cherry picking the numbers.", expected: { claim: false } },
  { voice: "Samantha", text: "OpenRouter listed Jev on September eighteenth.", expected: { claim: true } },
  { voice: "Daniel", text: "Jev is a million times better at this than any chatbot.", expected: { claim: false, hyperbole: true } },
  { voice: "Samantha", text: "Okay, enough about models, let's talk about something completely different, how was surfing in Sydney this weekend Karen?", expected: { claim: false, topicChange: true } },
  { voice: "Sandy (English (UK))", text: "It was absolutely beautiful, I paddled out at Bondi right at sunrise and the water was so clear that you could see the ripples in the sand under my board the whole way out.", expected: { claim: false } },
  { voice: "Sandy (English (UK))", text: "Then later we drove up the coast to Manly for lunch, and the waves were small but really clean, so I stayed out for hours and completely forgot to put on any sunscreen.", expected: { claim: false } },
  { voice: "Samantha", text: "According to the launch post, Jev can never hallucinate.", expected: { claim: true } },
  { voice: "Daniel", text: "Jev is four hundred and forty-five times cheaper than GPT.", expected: { claim: true, repeatOf: 2 } },
];

const LEAD_MS = 1000;
const GAP_MS = 1300; // ≥ 1.2 s between lines
const TAIL_MS = 1500;
const RATE_WPM = 150; // a little slower than the default, closer to a relaxed podcast pace

/** Trims leading and trailing near-silence so script.json holds the speech extent. */
function trim(samples: Float32Array): Float32Array {
  const thr = 0.003;
  let a = 0;
  let b = samples.length;
  while (a < b && Math.abs(samples[a]) < thr) a++;
  while (b > a && Math.abs(samples[b - 1]) < thr) b--;
  return samples.slice(a, b);
}

const outDir = "fixtures/conversation";
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "podcast-fixtures-"));
try {
  const clips = LINES.map((line, i) => {
    const aiff = join(tmp, `${i}.aiff`);
    const wav = join(tmp, `${i}.wav`);
    execFileSync("say", ["-v", line.voice, "-r", String(RATE_WPM), "-o", aiff, line.text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", aiff, wav]);
    const w = sherpa.readWave(wav);
    if (w.sampleRate !== SAMPLE_RATE) throw new Error(`unexpected rate ${w.sampleRate}`);
    return trim(w.samples);
  });

  let cursor = (LEAD_MS * SAMPLE_RATE) / 1000;
  const placed = clips.map((c) => {
    const start = cursor;
    cursor += c.length + (GAP_MS * SAMPLE_RATE) / 1000;
    return start;
  });
  const total = Math.round(cursor - (GAP_MS * SAMPLE_RATE) / 1000 + (TAIL_MS * SAMPLE_RATE) / 1000);
  const host = new Float32Array(total);
  const remote = new Float32Array(total);
  const script = LINES.map((line, i) => {
    const target = STREAM[line.voice] === "host" ? host : remote;
    target.set(clips[i], placed[i]);
    return {
      line: i + 1,
      voice: line.voice,
      stream: STREAM[line.voice],
      text: line.text,
      startMs: Math.round((placed[i] * 1000) / SAMPLE_RATE),
      endMs: Math.round(((placed[i] + clips[i].length) * 1000) / SAMPLE_RATE),
      expected: line.expected,
    };
  });

  sherpa.writeWave(join(outDir, "host.wav"), { samples: host, sampleRate: SAMPLE_RATE });
  sherpa.writeWave(join(outDir, "remote.wav"), { samples: remote, sampleRate: SAMPLE_RATE });
  writeFileSync(join(outDir, "script.json"), JSON.stringify({ durationMs: Math.round((total * 1000) / SAMPLE_RATE), lines: script }, null, 2) + "\n");
  console.log(`wrote ${outDir}/host.wav, remote.wav, script.json (${(total / SAMPLE_RATE).toFixed(1)} s, ${script.length} lines)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
