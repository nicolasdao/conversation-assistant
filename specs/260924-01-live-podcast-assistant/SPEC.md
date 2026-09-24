# SPEC — Podcast Assistant v1: live transcript, Jev timeline, and fact-checker

Created 24 September 2026 from a design session held in the private jev-xp research repository. Stack: TypeScript on Node 24, macOS 26.2 on Apple Silicon. Status: Tier 1 is ready to implement. Tier 2 opens with a decision the user has deliberately left open (§4.13).

## §0 How to use this spec (read first)

**What this is.** Everything needed to build Podcast Assistant v1 in this repository. It is a local app that listens to a remote podcast recording (the host's microphone plus the Riverside call audio) and transcribes it live. It labels the conversation on a timeline with Jev and fact-checks claims with a System 1 / System 2 loop. The host will demonstrate it live, on air, during the hosts' AI podcast.

**Who you are.** A fresh session with no memory of the design discussion. Every decision is recorded here. `BACKGROUND.md` explains why; you do not need it to build.

**DO**
- Read this file end to end before writing code.
- Implement Tier 1 (§4.1–§4.12) in order, and verify each task's **Done when** before starting the next.
- In your first 30 minutes, ask the user once whether you may make one local conventional commit per task (`feat(audio): …`, `test(factcheck): …`) on branch `main`. Without that yes, do not commit.
- Stop at §4.13 and hold the decision conversation with the user before writing any capture or UI code.
- Ask the user for `OPENROUTER_API_KEY` and `OPENAI_API_KEY` when `.env` lacks them.
- Keep development spend under **$3**, the sum of logged `cost_usd`. Stop and report when you reach it.

**DO NOT**
- Re-research APIs, models, prices, or libraries, or re-explore the jev-xp repository. Everything was verified on 24 September 2026 and is recorded here.
- Let an LLM write, choose, or change the timeline labels. They are a predefined, host-editable config.
- Cut audio at fixed intervals.
- Call Jev through chat completions.
- Send timestamps or raw numbers to Jev when code can compute them.
- Add dependencies beyond §7.
- Invent a key, or copy one from another repository.
- Edit anything under `specs/`, or anywhere in the private jev-xp research repository (read-only reference).
- Push, deploy, or open a pull request.

**First 30 minutes.**
1. Read §1–§3.
2. Run the §8 environment check.
3. Run `git status`. The folder may not be a git repository yet; if so, ask the user before running `git init -b main`, and ask about commits at the same time.
4. Start §4.1.

No project spec-rules file is configured. Terms are defined in §9.

## §1 Goal

Build a local pipeline and API that works with any capture method. For a live or replayed podcast session, it:
1. Takes two audio streams:
   - `host`: the host's microphone.
   - `remote`: the Riverside call, meaning co-hosts and guests.

   It cuts each stream into utterances with local voice activity detection (VAD). It labels each utterance's speaker with local voice embeddings: an unrecognised voice becomes "Speaker N", which the host can rename or merge live.
2. Transcribes each utterance with OpenAI `gpt-transcribe`.
3. Groups utterances into segments using a Jev boundary question plus code rules.
4. Labels each closed segment with a predefined, host-editable set of Jev questions (the timeline).
5. Fact-checks claims:
   - Jev flags checkable claims on every utterance (System 1).
   - GPT-6 Luna with web search researches the flagged claims (System 2).
   - Each verdict grades the flag that triggered it, and audits find misses.
   - System 2 reprograms System 1 through memory questions and criteria rewrites. A rewrite takes effect only after it passes a replay gate.
6. Records every session so it can be replayed through the same pipeline for tests, calibration, and an on-air fallback. It streams all results to any front end over HTTP and Server-Sent Events (SSE).

Tier 1 delivers items 1–6 headless, driven by WAV files. Tier 2 adds live capture and the front end once the user chooses them. Tier 3 prepares the live show.

## §2 Context

The demo's point is that ordinary software should call a model for bounded judgments, instead of an LLM behaving like a program:
- Jev makes about two thousand typed judgments an hour for cents.
- A slower LLM (System 2) is called only when System 1 finds something worth checking, and it improves System 1 by rewriting its questions.

The demo runs live, so reliability, latency, and a recorded fallback matter as much as features. All speech is English.

### §2.1 Decisions already made (do not reopen)

| Topic | Decision | Reason, in short |
| --- | --- | --- |
| Product scope | Live labelling and fact-checking, not after-the-fact questions over the transcript | An LLM already does after-the-fact questions well; Jev's advantage is judging every utterance live |
| Utterances | Local VAD cuts at pauses (Silero through `sherpa-onnx-node`), never at fixed intervals | Deterministic and free, never cuts mid-word, gives timestamps |
| Segments | A Jev boundary question per utterance plus code rules (minimum 12 s, maximum 75 s, speaker-change bonus) | A concrete comparison, not "is this a complete idea?" |
| Sections | Code merges consecutive segments that share the same `subject` label | Topic-level grouping at no extra cost |
| Timeline labels | A predefined, host-editable config (§4.9); no LLM writes them; the host acts as System 2 for the timeline | User decision |
| Fact-check System 1 | Its questions travel in the same per-utterance Jev request as the boundary question | No extra requests, and cards arrive without waiting for a segment to close |
| Fact-check System 2 | GPT-6 Luna through OpenRouter chat completions with the web plugin, on the standard endpoint (not flex) | jev-xp's conventions; the flex endpoint queued for minutes |
| Feedback loop | Verdicts grade flags; audits find misses; System 2 adds memory questions and rewrites criteria; rewrites need to pass the replay gate | The outcome signal that makes this improvement |
| Speakers | Local embeddings (`sherpa-onnx-node`, WeSpeaker ResNet34-LM). An unknown voice becomes "Speaker N". Rename and merge live. No pre-registration. | User decision |
| Transcription | Per-utterance file transcription with OpenAI `gpt-transcribe`, English, keyword hints | Works with any capture method, testable with files |
| Jev access | OpenRouter Decisions API over raw HTTP, pinned to `typesafe/jev-1.13` | 0 failures in 10,120 calls from this Mac |
| Capture method and front end | **Open.** Decided with the user at §4.13 | User decision |
| Repository | This repository, separate from jev-xp: TypeScript on Node 24, vitest, zod, `tsx --env-file` | User decision |

### §2.2 Jev essentials you must respect

**Request.** `POST https://openrouter.ai/api/alpha/decisions` with header `Authorization: Bearer $OPENROUTER_API_KEY` and body:

```json
{ "model": "typesafe/jev-1.13", "state": "<string, object, or array>", "questions": { "<id>": "<question>" } }
```

**Question types and their answers.**

| Type | Question shape | Answer shape |
| --- | --- | --- |
| `noul` | `{ type, instructions, criteria?: { true, false } }` | `{ type: "noul", noul: p }`, where `p` is the probability of yes |
| `choice` | `{ type, instructions, criteria: { label: description } }` | `{ choice, confidence, probabilities }` |
| `score` | `{ type, instructions, criteria: [levels, lowest first] }` | `{ score, confidence, probabilities, legend }`, where `score` is the probability-weighted level index, 0 to n−1 |

**Response.** `{ answers, id, model, provider, usage: { input_tokens, output_tokens, cost } }`. Reject any response without `usage.cost`. Log `model`, which is the resolved snapshot, for example `typesafe/jev-1.13-20260917`.

**Errors.** The body is `{ error: { code, message, metadata } }`.
- Retry on 429, any 5xx, a 402 whose `metadata.limit_source` is `openrouter_in_flight_budget`, and timeouts.
- Fail immediately on 400 and on any other 402.

**Limits and price.**
- A request can hold at most 32,000 tokens of state plus all questions.
- A `choice` can have up to 255 options.
- One request can carry many questions about one state. There is no endpoint that takes several states.
- $0.042 per million input tokens; output is free.

**Behaviour to design around.**
- Every question is answered independently and in parallel, against the same state.
- A `choice` always picks one of your options, so always include a `none` or `other` option.
- Confidence measures ambiguity among your options, not "none of these".
- Answers are not bit-reproducible, and there is no temperature or seed.
- Jev is weak at numbers, counting, and dates, and most accurate in English.
- Write one narrow judgment per question, with snake_case ids.

**Measured latency from this Mac** (10,120 calls): p50 415 ms, p95 838 ms, p99 2.1 s.

### §2.3 Other services (verified 24 September 2026)

**GPT-6 Luna through OpenRouter.**
- `POST https://openrouter.ai/api/v1/chat/completions` with `model: "openai/gpt-6-luna"`, costing $0.10 / $0.50 per million input / output tokens on the standard endpoint.
- `reasoning: { effort }`, from `none` to `max`.
- `response_format` with a strict json_schema; pair it with `provider.require_parameters: true`.
- Every response includes `usage.cost`.
- Web search: `plugins: [{ id: "web", engine: "native" | "exa", max_results }]`. Citations arrive in `choices[0].message.annotations[]` as `url_citation` entries.

**OpenAI `gpt-transcribe`.**
- `POST https://api.openai.com/v1/audio/transcriptions`, multipart, with parameters `prompt`, `keywords`, and `languages`.
- The response is `{ text, languages }`, with no usage field.
- $0.0045 per audio minute.

**sherpa-onnx-node 1.13.8** has a darwin-arm64 build. Its README asks for `DYLD_LIBRARY_PATH=node_modules/sherpa-onnx-darwin-arm64` on macOS.

### §2.4 Secrets

- `OPENROUTER_API_KEY` (Jev and GPT-6 Luna) and `OPENAI_API_KEY` (transcription) live in `.env` at the repository root, mode 600, gitignored.
- `.env.example` lists both names with empty values.
- Load them with Node's `--env-file=.env` in npm scripts. No dotenv.
- Suggest to the user a dedicated OpenRouter key for this project with a $10 credit limit.
- Keys never appear in logs, session files, or events.

## §3 Acceptance criteria

**Tier 1 (headless):**
- `npm run typecheck` and `npm test` pass, and the tests make no network calls.
- `npm run fixtures` creates `fixtures/conversation/host.wav`, `remote.wav` (16 kHz mono PCM16), and `script.json`.
- `npm run smoke` passes every check in §4.11. It prints per-utterance Jev latency p50 and p95 over 50 calls with at most 2 timeouts, and total spend is ≤ $0.50.
- `npm run replay -- --host fixtures/conversation/host.wav --remote fixtures/conversation/remote.wav --speed max` creates `sessions/<id>/` with every file listed in §4.10, and:
  - `speakers.json` holds exactly 3 speakers, one per fixture voice.
  - `segments.jsonl` holds ≥ 2 closed segments, none longer than `maxSegmentMs`.
  - `claims.jsonl` flags the "445 times cheaper" utterance and the "never hallucinate" utterance.
  - Each researched claim has a schema-valid verdict with ≥ 1 source, or the verdict `unverifiable`.
  - The repeated "445 times cheaper" line produces a `claim.repeat` or `claim.duplicate` event linked to the first claim, with no second research call.
- With `npm run serve -- --replay fixtures/conversation --speed 1` running, `curl -N localhost:4317/api/events` shows `utterance`, `segment.closed`, `segment.labels`, `claim.flagged`, and `claim.verdict` events.
- A rename request (§8) emits `speaker.updated`, and later events use the new name.
- `npm run calibrate:boundary -- <labelled.jsonl>` prints precision, recall, and F1 for thresholds 0.3–0.9.

**Tier 2** (details decided at §4.13). A live session on the user's real setup must show, at minimum:
- level meters for both streams;
- transcripts within 3 s (p90) of each utterance ending;
- every UI element in §4.15.

**Tier 3.** `npm run preflight` passes, and a rehearsal session with the planted claims (§4.16) is recorded and replays.

## §4 The work

The order is fixed, and Tier 1 tasks each end with tests. The files named in §4 and in §A are the only files you may create in Tier 1; ask before adding others.

### Tier 1: headless core, driven by files

#### §4.1 Scaffold

**Files:**
- `package.json`: `"type": "module"`, `engines.node >= 24`.
- `tsconfig.json`: copy the compiler options of the jev-xp repository's `tsconfig.json`, and include `src`, `tests`, and `scripts`.
- `vitest.config.ts`: tests in `tests/**/*.test.ts`, 120 s timeout.
- `.gitignore` already exists (added 24 September 2026). Do not recreate or trim it. It ignores secrets, `node_modules/`, build output, `models/`, `fixtures/`, `sessions/`, `data/`, every audio, video, and `*.jsonl` file anywhere, and macOS and editor clutter. To commit a deliberate test asset, add a `!path` exception and tell the user.
- `.env.example`, a short `README.md` (setup and scripts), and `config/app.json` (§4.2).

**npm scripts:** `test`, `typecheck`, `models` (`sh scripts/download-models.sh`), `fixtures`, `smoke`, `replay`, `serve`, `preflight`, `calibrate:boundary`, `calibrate:speakers`. Every script that loads `sherpa-onnx-node`, including `test`, is prefixed with `DYLD_LIBRARY_PATH=node_modules/sherpa-onnx-darwin-arm64`.

**`scripts/download-models.sh`** downloads into `models/`, skipping files that already exist:
- `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`
- `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx` (about 26.5 MB; the tag's misspelling is real)

Tests that need `models/` or `fixtures/` fail with the message "run npm run models && npm run fixtures". Import the addon from ESM as `import sherpa from "sherpa-onnx-node"`. If its typings are missing, add a minimal `src/types/sherpa-onnx-node.d.ts`.

**Done when:** `npm install && npm run models && npm run typecheck && npm test` succeeds with one placeholder test, and a script importing `sherpa-onnx-node` runs.

**Stop and ask if:** `sherpa-onnx-node` fails to load even with `DYLD_LIBRARY_PATH` set.

#### §4.2 Config

`src/config.ts` loads and validates, with zod, `config/app.json`, `config/labels.default.json` (§4.9), and `config/factcheck.s1.default.json` (§4.8). Defaults for `config/app.json`:

```json
{
  "server": { "port": 4317 },
  "budget": { "sessionCapUsd": 5, "devCapUsd": 3 },
  "vad": { "threshold": 0.5, "minSpeechDuration": 0.4, "minSilenceDuration": 0.5, "maxSpeechDuration": 20 },
  "speakers": { "threshold": 0.55, "minEmbedSeconds": 1.5, "maxEmbeddingsPerSpeaker": 20 },
  "transcription": {
    "model": "gpt-transcribe", "languages": ["en"], "concurrency": 4, "timeoutMs": 20000,
    "prompt": "Three friends co-host an English-language podcast about AI news, tech and marketing.",
    "keywords": ["Jev", "TypeSafe", "OpenRouter", "Riverside", "GPT-6 Luna", "GPT-6 Sol", "OpenAI", "Anthropic",
                 "Claude", "DeepSeek", "Gemini", "Hugging Face", "Nvidia", "System 1", "System 2", "Kahneman"],
    "fixes": []
  },
  "jev": { "model": "typesafe/jev-1.13", "utteranceTimeoutMs": 3000, "segmentTimeoutMs": 5000, "maxAttempts": 2, "concurrency": 8 },
  "segmentation": { "boundaryThreshold": 0.6, "speakerChangeGapMs": 1500, "speakerChangeBonus": 0.1,
                    "minSegmentMs": 12000, "maxSegmentMs": 75000, "reorderTimeoutMs": 8000 },
  "timeline": { "noulMarkerThreshold": 0.7, "clipWorthyMin": 3, "fadedBelowConfidence": 0.5,
                "companies": ["OpenAI", "Anthropic", "Google", "Meta", "Nvidia", "TypeSafe", "OpenRouter", "DeepSeek", "Hugging Face"],
                "stories": [] },
  "s2": { "model": "openai/gpt-6-luna",
          "provider": { "order": ["openai"], "allow_fallbacks": false, "require_parameters": true },
          "web": { "engine": "exa", "max_results": 5 },
          "effort": { "research": "medium", "audit": "low", "rewrite": "medium" },
          "timeoutMs": 90000, "researchConcurrency": 2, "maxResearchPerHour": 30, "maxResearchPerSession": 40,
          "staleAfterMs": 600000 },
  "factcheck": { "claimThreshold": 0.7, "worthMin": 2, "hedgedThreshold": 0.6, "attentionThreshold": 0.7,
                 "knownMatchThreshold": 0.8, "maxKnownQuestions": 40, "auditIntervalMs": 300000, "auditSample": 10,
                 "rewriteOnFalseAlarms": 3, "rewriteOnMisses": 2, "rewriteCooldownMs": 180000, "replayMaxItems": 300 }
}
```

`transcription.fixes` is a list of `{ "pattern": "<whole-word regex>", "replace": "…" }` entries applied to transcripts. It ships empty. Do not add "Jeff" → "Jev": real people are called Jeff.

**Done when:** a test loads all three files, and rejects both a config where `segmentation.minSegmentMs > maxSegmentMs` and a label set with a `choice` that has no criteria.

#### §4.3 Audio source, WAV codec, VAD, fixtures

**`src/audio/wav.ts`** reads and writes PCM16 mono WAV, and converts to and from Float32 in [−1, 1].

**`src/audio/source.ts`** defines:

```ts
interface AudioSource {
  stream: "host" | "remote";
  frames(): AsyncIterable<{ samples: Float32Array; sessionMs: number }>; // 16 kHz mono, 512-sample frames
}
```

- `FileSource(path, stream, speed)`: `speed` is `1` (real-time pacing, for demos and the fallback run) or `"max"` (no pacing).
- A file frame's `sessionMs` is its sample offset. Both streams of a session share clock zero.
- Either stream may be absent, but at least one must be present.
- Live adapters (Tier 2) implement the same interface. Nothing downstream may know which source it is reading.

**`src/audio/vad.ts`** creates one `sherpa.Vad` per stream:
- Config: `{ sileroVad: { model: "models/silero_vad.onnx", threshold, minSpeechDuration, minSilenceDuration, maxSpeechDuration, windowSize: 512 }, sampleRate: 16000, numThreads: 1, debug: false }`, with a 60 s buffer.
- Feed it 512-sample windows through `acceptWaveform(samples)`, and drain it with `while (!vad.isEmpty()) { const seg = vad.front(); vad.pop(); … }`.
- Emit `Utterance { id: "u_<n>", stream, startMs, endMs, samples }`, where `startMs = streamStartMs + seg.start / 16` and `endMs = startMs + seg.samples.length / 16`.
- At end of stream, call `vad.flush()` if it exists; otherwise feed 1 s of silence.

**`src/audio/tags.ts`** adds two tags:
- `loud`: the utterance's RMS in dBFS is at least 6 dB above the median of that stream's last 50 utterances.
- `overlap`: its time range overlaps an utterance on the other stream by ≥ 1,000 ms.

**`scripts/make-fixtures.ts`** builds a scripted conversation of about 100 s:
- Voices: macOS `say` with Samantha on `host`, and Daniel and Karen on `remote`.
- Convert each line with `afconvert -f WAVE -d LEI16@16000 -c 1`.
- Place each line on its stream at a scripted offset, with gaps of at least 1.2 s and silence everywhere else.
- Write `host.wav`, `remote.wav`, and `script.json` (line, voice, stream, startMs, endMs, expected flags).

The lines, in this order:
1. Samantha: a welcome line.
2. Daniel: "Honestly, Jev is four hundred and forty-five times cheaper than GPT."
3. Karen: disagrees with Daniel.
4. Samantha: "OpenRouter listed Jev on September eighteenth."
5. Daniel: "Jev is a million times better at this than any chatbot."
6. Samantha: changes the topic to surfing in Sydney.
7. Karen: talks about surfing for at least 15 s, across two lines.
8. Samantha: "According to the launch post, Jev can never hallucinate."
9. Daniel: repeats "Jev is four hundred and forty-five times cheaper than GPT."

**Done when:** tests on the fixture show:
- utterance boundaries within ±400 ms of `script.json` for ≥ 90% of lines;
- no utterance longer than 20 s;
- `speed: 1` pacing within 5% of wall-clock time over a 10 s slice.

#### §4.4 Speaker registry

`src/speakers/registry.ts` holds one registry shared by both streams.

**Embedding and search:**
- Extractor: `new sherpa.SpeakerEmbeddingExtractor({ model: "models/wespeaker_en_voxceleb_resnet34_LM.onnx", numThreads: 1, debug: false })`.
- To embed an utterance: `createStream()`, then `stream.acceptWaveform({ sampleRate: 16000, samples })`, then `extractor.compute(stream)`.
- Manager: `new sherpa.SpeakerEmbeddingManager(extractor.dim)`, with `addMulti({ name, v })`, `search({ v, threshold })` (returns `""` when the voice is unknown), and `remove(name)`.

**Assignment:**
- Utterances of at least `minEmbedSeconds` are embedded and searched.
- A match assigns that speaker and appends the embedding. Keep the last `maxEmbeddingsPerSpeaker` embeddings, re-registering with `remove` followed by `addMulti`.
- No match creates `spk_<n>` with display name `Speaker <n>`.
- Shorter utterances take the last speaker on the same stream and are marked `speakerInferred: true`. If the stream has no speaker yet, they create a new one.

**Editing:**
- `rename(id, displayName)`.
- `merge(fromId, intoId)` moves the embeddings, records `mergedInto`, and resolves every later lookup of `fromId` to `intoId`.

**`src/cli/calibrateSpeakers.ts`** prints, for thresholds 0.35–0.75 in steps of 0.05, how many speakers each threshold creates on the given WAVs.

**Done when:**
- On the fixture, the default threshold (or the calibrated one written to `config/app.json`) yields exactly 3 speakers.
- ≥ 95% of utterances of at least 1.5 s are assigned consistently with `script.json`.
- The rename and merge tests pass.

**Stop and ask if:** no threshold between 0.35 and 0.75 yields 3 speakers on the fixture.

#### §4.5 Transcription

`src/transcribe/openai.ts` sends each utterance to OpenAI.

**Request.** `POST https://api.openai.com/v1/audio/transcriptions` as a multipart form with:
- `file`: the utterance as a WAV named `utterance.wav`;
- `model` and `prompt`;
- `keywords[]` and `languages[]`, each repeated once per value.

**Response.** `{ text }`.

**Handling:**
- Concurrency and timeout come from config, with one retry on 429, 5xx, or timeout.
- Cost is `durationSeconds / 60 × 0.0045`, logged with `estimated: true`.
- Apply `fixes` to the text.
- Mark the utterance `filler: true` when the trimmed text matches `/^(uh|um|mm|hmm|mm-hmm|yeah|yes|no|okay|ok|right|so)\W*$/i` or is shorter than 4 characters.
- Drop utterances with empty text.

**Done when:**
- A unit test with a fake `fetch` checks the multipart fields.
- Smoke check 1 (§4.11) transcribes the first Daniel line, and the text contains "Jev".

**Stop and ask if:** the API rejects `keywords[]` and also rejects one retry that sends `keywords` repeated without brackets.

#### §4.6 Jev client

`src/jev/client.ts` makes raw `fetch` calls to the Decisions endpoint with:
- `AbortSignal.timeout` and a bounded number of attempts, from config;
- the retry classification from §2.2;
- a shared concurrency limit;
- a budget guard that refuses calls once the session cap is reached and emits `budget.exhausted`.

It writes one log row per call:

```
{ kind: "jev_call", purpose, request_hash, state, question_set_version, ok, latency_ms, attempts, model_returned, usage, cost_usd, error? }
```

`state` is stored so the replay gate can ask again. `src/jev/types.ts` holds the question and answer types from §2.2.

Reference for the retry logic only (do not copy): `classifyError` at jev-xp's `src/policy/jevClient.ts:77`, and `backoffMs` at line 107.

**Done when:** tests with a fake `fetch` cover success, a 429 followed by success, a 400 that fails immediately, a timeout, a response without `usage.cost` being rejected, and a call refused by the budget guard.

#### §4.7 Segmenter

`src/pipeline/segmenter.ts` consumes transcribed utterances in `startMs` order across both streams, through a reorder buffer. An utterance is released once every utterance that started earlier has been transcribed, or once `reorderTimeoutMs` has passed.

It processes one utterance at a time:
1. A filler skips Jev and joins the open segment.
2. Any other utterance gets one Jev request (`purpose: "utterance"`, timeout `utteranceTimeoutMs`). The request carries the state below plus these questions: `boundary` (§4.9), the active fact-check System 1 set (§4.8), and its memory questions.
3. Close the open segment before this utterance when either:
   - `boundary ≥ boundaryThreshold` and the segment is at least `minSegmentMs` long. The threshold drops by `speakerChangeBonus` when the speaker changes after a gap of at least `speakerChangeGapMs`.
   - Adding the utterance would exceed `maxSegmentMs`. Mark this close `forced: true`.

   The first utterance opens the first segment.
4. If the Jev request fails, treat the boundary as 0, skip fact-checking for this utterance, and log `jev_timeout`.
5. Pass the fact-check answers to §4.8.

The state holds display names, text, and tags only, never timestamps or ids:

```json
{ "current_segment": [ { "speaker": "Nic", "text": "…", "tags": [] } ],
  "new_utterance": { "speaker": "Speaker 2", "text": "…", "tags": ["loud"] } }
```

**Done when:** tests with fake Jev answers cover:
- a boundary close;
- a segment held open because it is shorter than the minimum;
- a forced close;
- the speaker-change bonus;
- a filler skipping Jev;
- the timeout fallback;
- ordering across the two streams.

#### §4.8 Fact-checker (System 1 and System 2)

**Files:** `src/factcheck/s1.ts` (question sets, versions, flag rule), `src/factcheck/queue.ts`, `src/factcheck/s2.ts` (OpenRouter chat calls and prompts), `src/factcheck/gate.ts`, and `config/factcheck.s1.default.json`. The work comes in three parts, each with its own finish line.

##### §4.8a System 1: questions, flags, memory

`config/factcheck.s1.default.json` (version `s1@1`) holds these questions:

```yaml
claim:      noul  "Judge only new_utterance. It states a specific factual claim that could be checked against public sources, such as a number, price, date, ranking, quote, attribution, release, or product capability."
            criteria: { true: "At least one concrete, checkable statement of fact.",
                        false: "An opinion, joke, question, feeling, exaggeration, vague statement, or no factual content." }
claim_type: choice "Judge only new_utterance. What kind of factual claim does it make?"
            criteria: { number_or_price: "A figure, price, multiple, or percentage.",
                        date_or_release: "When something happened or was released.",
                        quote_or_attribution: "Who said, did, or owns something.",
                        capability_or_benchmark: "What a product or model can do, or how it scored.",
                        event: "Something that happened.", prediction: "What will happen in the future.",
                        none: "No checkable factual claim." }
hedged:     noul  "Judge only new_utterance. The speaker signals uncertainty about a fact, such as 'I think', 'if I remember correctly', 'something like', or 'don't quote me'."
worth:      score "Judge only new_utterance. How much would listeners care whether its factual claim is accurate?"
            criteria: ["No factual claim, or trivial", "A minor detail", "Relevant to the discussion",
                       "Central to the speaker's argument", "Surprising or high-stakes if wrong"]
```

**Flag rule.** Flag the utterance when all three hold: `claim ≥ claimThreshold`, `claim_type ≠ none`, and `worth ≥ worthMin`. Its priority is:

```
priority = worth
         + 0.5 if hedged ≥ hedgedThreshold
         + 1   if any attention_* ≥ attentionThreshold
```

**Memory questions.**
- When a claim is queued, add a `known_<claimId>` noul: "new_utterance restates or relies on this already-checked claim: \"<claim>\"".
- The quoted text is the utterance until the verdict's `restated_claim` replaces it.
- Keep at most `maxKnownQuestions`, evicting the oldest.
- A match at or above `knownMatchThreshold` links the utterance to that claim instead of flagging it:
  - if the claim is verified, emit `claim.repeat` with its verdict (an instant card);
  - if it is still pending, emit `claim.duplicate`.
- Adding or evicting a memory question bumps the System 1 version with kind `memory`. It does not go through the gate.

**Done when:** unit tests with fake Jev answers cover the flag rule, priority order, memory-question eviction, and both the repeat and duplicate paths.

##### §4.8b System 2: queue, research, grading

**Queue.**
- Highest priority first, served by `researchConcurrency` workers.
- Enforce the per-hour and per-session caps.
- Drop items older than `staleAfterMs` with `claim.dropped`.

**Research call.** `POST https://openrouter.ai/api/v1/chat/completions` with:
- `model`, `provider`, and `plugins: [{ id: "web", engine, max_results }]` from config;
- `reasoning: { effort: effort.research }`;
- `response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true, schema } }`.

The system message:

> You fact-check one spoken claim from a live English-language AI podcast. Today is <date>. Use the web results and judge the claim as a listener would understand it. Verdicts:
> - supported: accurate.
> - contradicted: false.
> - misleading: technically true but missing context that changes its meaning, or a vendor's own claim presented as fact.
> - unverifiable: no reliable source found.
> - not_a_claim: an opinion, joke, exaggeration, or too vague to check.
>
> restated_claim is one precise sentence. correction is at most 25 words saying what is true. Cite only sources you used.

The user message holds only the speaker, the utterance, and up to 1,500 characters of the current segment.

The schema has every field required and no extra properties:

| Field | Type |
| --- | --- |
| `restated_claim` | string, ≤ 200 characters |
| `verdict` | `supported`, `contradicted`, `misleading`, `unverifiable`, or `not_a_claim` |
| `correction` | string, empty when supported |
| `confidence` | `low`, `medium`, or `high` |
| `false_alarm_reason` | `none`, `hyperbole`, `joke`, `opinion`, `too_vague`, `trivial`, or `not_factual` |
| `sources` | up to 3 of `{ url, title }` |

After the call:
- Merge `message.annotations[].url_citation` into `sources`, deduplicated by URL.
- A `supported`, `contradicted`, or `misleading` verdict with no source at all becomes `unverifiable`, marked `downgraded: true`.
- Log `usage.cost`.

**Grade.**
- `false_alarm` when the verdict is `not_a_claim` or `false_alarm_reason ≠ none`; otherwise `good_flag`.
- A host override through `POST /api/claims/:id/override` marks the verdict `disputed` (`claim.disputed`) and removes its grade from the evidence.

**Done when:**
- Unit tests with a fake System 2 cover the caps, staleness, source merging, the downgrade, grading, and override exclusion.
- The fixture replay meets the fact-check criteria in §3.

**Stop and ask if:** the verdict call fails both with strict `json_schema` and with the fallback in §6 row 5.

##### §4.8c Feedback loop: audit, rewrite, replay gate

**Audit.**
- Every `auditIntervalMs`, if at least 10 unflagged, non-filler utterances have accumulated, send up to `auditSample` of them to GPT-6 Luna.
- No web search, effort `effort.audit`.
- Schema: `{ items: [{ utterance_id, has_checkable_claim, worth: "low" | "medium" | "high" }] }`.
- An item with `has_checkable_claim` true and `worth ≠ low` is a **miss**.

**Criteria rewrite.**

*Trigger.* All of:
- false alarms since the active version reach `rewriteOnFalseAlarms`, or misses reach `rewriteOnMisses`;
- no rewrite ran within the last `rewriteCooldownMs`.

*Call.* Ask GPT-6 Luna (no web search, effort `effort.rewrite`) for `{ changes: [{ op, target, value }], rationale }`. Give it:
- the active question set and thresholds;
- the false alarms with their reasons;
- up to 10 good flags and up to 10 misses.

*Allowed ops.* Code rejects anything else:

| Op | May target | Limits |
| --- | --- | --- |
| `set_instructions`, `set_criteria` | `claim`, `claim_type`, `hedged`, `worth` | For `claim_type`, descriptions only: keys stay fixed and `none` stays. Instructions ≤ 400 characters. |
| `add_attention`, `remove_attention` | noul questions named `attention_<n>` | At most 3 |
| `set_threshold` | `claimThreshold`, `attentionThreshold` | Within [0.5, 0.9] |
| `set_threshold` | `worthMin` | Within [1, 3] |

**Replay gate** (`gate.ts`).

*Evaluation items.* Logged utterance states, newest first, up to `replayMaxItems`, falling into three sets:
- `G`: flagged utterances graded good flags;
- `F`: flagged utterances graded false alarms;
- `M`: utterances an audit found missed.

*Steps.*
1. Ask the candidate's `claim`, `claim_type`, `hedged`, `worth`, and `attention_*` questions again on each stored state. Memory questions are excluded.
2. Apply the candidate flag rule.
3. Count how many items in each set it flags: `G'`, `F'`, `M'`.

*Decision.*
- Promote when `G' ≥ floor(0.9 × |G|)`, `F' ≤ |F|`, and either `F' < |F|` or `M' > 0`. Otherwise reject.
- Record both outcomes in `s1_versions.jsonl` with their metrics and rationale.
- A promoted version applies from the next utterance.
- `POST /api/s1/rollback` restores any earlier version.

**Done when:** unit tests with fake Jev and fake System 2 cover the audit trigger and miss rule, the rewrite trigger and cooldown, rejection of every disallowed op, and the gate arithmetic (one promote case and one reject case), with the promoted version applied from the next utterance.

#### §4.9 Timeline labels

`config/labels.default.json` holds the label set; its version is a hash of its content. The state is `{ "previous_segment": [...], "segment": [...] }`, using the utterance shape from §4.7.

Each closed segment gets one Jev request (`purpose: "segment"`, concurrency 4, timeout `segmentTimeoutMs`). If it fails, the segment is marked `unlabeled` and can be relabelled later.

Every timeline instruction below is prefixed with "Judge only segment; previous_segment is context only." The `boundary` question is also defined in this file, but it is asked per utterance (§4.7).

```yaml
boundary: noul "The new_utterance moves on to a different point or subject than current_segment, rather than continuing, elaborating, answering, or reacting to it."
subject: choice "What is the current segment mainly about?"
  ai_models: New AI models, labs, benchmarks, research papers or capabilities
  ai_tools: AI apps, agents, coding assistants or developer tools, and how people build with or use them
  ai_industry: AI companies, funding, jobs, regulation, safety, ethics or AI's impact on society
  tech: Technology not centred on AI, such as hardware, platforms, crypto, gadgets or startups
  marketing: Marketing, audiences, content, social media, brands, sales or growth
  personal_life: The hosts' own lives, such as travel, family, health, food, sport or where they live
  other_topics: Anything else, such as culture, science, politics, philosophy or random tangents
  the_show: The podcast itself, such as intros, outros, sponsors, listener comments or housekeeping
mode: choice "What are the speakers mainly doing in the current segment?"
  news: Reporting what happened, such as an announcement, release or event
  analysis: Interpreting, giving opinions, or discussing what something means or why it matters
  personal_story: Recounting their own experience, project or anecdote
  explainer: Explaining how something works or defining a concept
  banter: Joking, teasing or casual chat with little information
  transition: Introducing, wrapping up or moving between topics
disagreement: noul "In the current segment, a speaker disputes or pushes back on another speaker's view."
heat: score "How heated is the exchange in the current segment?" [Calm, Lively, Animated, Heated, Very heated]
hype: score "How do the speakers in the current segment feel about the subject they are discussing?" [Very skeptical, Skeptical, Neutral or mixed, Positive, Very enthusiastic]
humour: noul "The current segment contains jokes, teasing or laughter."
hot_take: noul "A speaker in the current segment states a bold, surprising or contrarian opinion."
prediction: noul "A speaker in the current segment predicts what will happen in the future."
recommendation: noul "A speaker in the current segment recommends a specific tool, product, resource or practice."
clip_worthy: score "How well would the current segment work as a standalone short clip for social media?" [Unusable, Weak, Decent, Strong, Must clip]
story: choice, only when timeline.stories is non-empty: "Which of tonight's stories is the current segment about?"
  s1…sN: the typed headlines; none: "None of these stories."
```

**Computed in code, not by Jev:**
- `mentions`: case-insensitive whole-word matches of `timeline.companies` in the segment text.
- Markers: a noul answer ≥ `noulMarkerThreshold`, or `clip_worthy ≥ clipWorthyMin`.
- `faded: true` on any `choice` whose confidence is below `fadedBelowConfidence`.
- Sections: consecutive segments with the same `subject`, ignoring faded ones.
- The display lane `ai` for the three `ai_*` subjects.

**Editing:**
- `PUT /api/labels` validates a new label set and activates it from the next segment.
- `POST /api/labels/relabel` asks the active set again on closed segments, in the background.

**Done when:**
- Tests cover state building, the marker and faded rules, sections, mentions, config replacement, and relabelling.
- In the fixture replay, the surfing lines are labelled `subject: personal_life` or `other_topics`.

#### §4.10 Session orchestration, store, events, API, replay

**`src/pipeline/session.ts`** wires the pipeline together: sources → VAD → tags → speakers → transcription → segmenter → timeline and fact-checker → store and events. At end of input it drains every queue for at most 180 s, then emits `session.ended`.

**`src/store/sessionStore.ts`** writes to `sessions/<YYYYMMDD-HHMMSS>/`:
- `host.wav` and `remote.wav`: the full streams as received, for exact replay.
- `session.json`: the config snapshot, label set, System 1 version, and start time.
- JSONL files: `utterances`, `transcriptions`, `jev_calls`, `s2_calls`, `segments`, `labels`, `claims`, `verdicts`, `s1_versions`, `audits`, `events`.
- `speakers.json`, written at the end.

Files are append-only and flushed on every write.

**`src/store/events.ts`** is a typed event bus with zod schemas. Events:

| Group | Events |
| --- | --- |
| Session | `session.started`, `session.ended`, `health` (per stream, every second: RMS dBFS, ms since last frame, utterances in the last minute) |
| Speech | `utterance`, `speaker.created`, `speaker.updated`, `speaker.merged` |
| Timeline | `segment.closed`, `segment.labels`, `section.updated` |
| Fact-check | `claim.flagged`, `claim.duplicate`, `claim.repeat`, `claim.researching`, `claim.verdict`, `claim.dropped`, `claim.disputed`, `audit`, `s1.version` |
| Accounting | `cost` (running totals for transcription, Jev, and System 2), `budget.exhausted`, `stats` (§4.12), `error` |

**`src/server/main.ts`** uses Node's `http` module, no framework, and binds to 127.0.0.1 only:

| Method | Route | Body / purpose |
| --- | --- | --- |
| GET | `/api/events` | SSE; replays the session's events so far on connect |
| GET | `/api/state` | Full current state |
| POST | `/api/session/start` | `{ mode: "replay", dir, speed }`; Tier 2 adds live modes |
| POST | `/api/session/stop` | |
| POST | `/api/speakers/:id/rename` | `{ displayName }` |
| POST | `/api/speakers/merge` | `{ fromId, intoId }` |
| PUT | `/api/labels` | A new label set |
| POST | `/api/labels/relabel` | |
| PUT | `/api/stories` | `{ headlines }` |
| POST | `/api/claims/:id/override` | `{ note? }` |
| POST | `/api/s1/rollback` | `{ version }` |
| GET | `/api/stats` | |

**Replay.**
- `src/cli/replay.ts` (`--host`, `--remote`, `--speed`, optional `--export <file>` for §4.12) feeds WAV files through `FileSource`. It prints a summary: utterances, speakers, segments, claims, verdicts, and cost.
- `npm run serve -- --replay <dir> --speed <1|max>` does the same for a fixture or a session folder, behind the API.

**Done when:**
- An in-process server test drives a fake pipeline and checks every route and the SSE replay on connect.
- A test confirms that no event or session file contains either API key.

#### §4.11 Smoke checks (live, about $0.30)

`src/cli/smoke.ts` prints PASS or FAIL with latency and cost for each check:
1. Transcribe the fixture's first Daniel line. The text contains "Jev".
2. Send one per-utterance Jev request (boundary plus `s1@1`) on a fixture state. Every answer is typed, `usage.cost` is present, and the returned model starts with `typesafe/jev-1.13`.
3. Send one segment request with the full label set. Every answer is present.
4. Send 50 sequential per-utterance requests and report p50 and p95. FAIL if more than 2 time out at `utteranceTimeoutMs`.
5. Research "Jev is 445 times cheaper than GPT" with the configured web engine. The verdict is schema-valid with ≥ 1 source; report latency and cost. Then try `engine: "native"` once and print whether it works, without changing config.
6. Send one audit call and one rewrite call with canned inputs. Both are schema-valid.

**Done when:** all checks pass and total cost is ≤ $0.50.

**Stop and ask if:**
- Check 4 fails. The alpha endpoint would be too slow for live use, and TypeSafe's direct API needs a key the user does not have yet.
- Check 5 fails with both engines.

#### §4.12 Stats and calibration

**`src/pipeline/stats.ts`** emits `stats` every 60 s and at session end:
- Rogan index: the share of labelled segment time whose subject is `personal_life` or `other_topics`.
- Talk time per speaker.
- Disagreements per speaker: segments with a `disagreement` marker in which the speaker talked.
- Duration-weighted mean `hype` per speaker.
- Predictions and recommendations: segment id plus the first 120 characters.
- Clips: segments with `clip_worthy ≥ clipWorthyMin`.
- Fact-check totals: flagged, researched, verdicts by type, repeats, duplicates, dropped, false alarms, misses, and System 1 versions promoted and rejected.
- Cost totals.

**`src/cli/calibrateBoundary.ts`** runs offline, with no API calls:
- Input: JSONL rows `{ utterance_id, speaker, text, boundary_p, human_boundary }`.
- Produce the rows with `replay --export <file>`; the host fills in `human_boundary` (true or false).
- It prints precision, recall, and F1 for thresholds 0.3–0.9 in steps of 0.1, and the best threshold.

**Done when:** the stats tests pass on a synthetic session, and the calibrate CLI runs on a labelled sample of 20 rows.

### Tier 2: live capture and front end (starts with a decision)

#### §4.13 Decision gate: stop and decide with the user

Before writing any capture or UI code, present this summary and ask the user to choose.

Known facts about this Mac:
- macOS 26.2, with Chrome 153 and Edge installed.
- No Riverside Mac app is installed.
- Xcode and Swift 6.3 are installed.
- No virtual audio drivers are installed.

Riverside officially supports Chrome and Edge, and it also offers a Mac app.

| Capture option | Host mic | Remote (Riverside) | Needs | Main risk |
| --- | --- | --- | --- | --- |
| A. Local web page in Chrome, with Riverside in a Chrome tab | `getUserMedia` | `getDisplayMedia` → pick the Riverside tab → "Also share tab audio" | Nothing to install | The tab must be re-picked each session. Unverified: whether the tab's audio excludes the host's own voice. |
| B. Riverside Mac app | Browser `getUserMedia` or a Node mic module | AudioTee (Core Audio process tap, macOS 14.2+) filtered to Riverside's process, PCM on stdout | Build AudioTee with Xcode; grant the "System Audio Recording" permission | An extra native tool |
| C. Chrome system audio (Chrome 141+, sharing a window or screen) | `getUserMedia` | All system audio | Nothing | Notification sounds and other apps leak in |
| D. BlackHole virtual device | Any | A routed output device | Driver install and a multi-output device | Fiddly routing, and normal volume control is lost |

Front-end options:
- A local web page served by this server, in vanilla TypeScript bundled with esbuild or Vite.
- A native SwiftUI app.
- Electron.

The design session recommended A with a local web page, B as the fallback, and a native app only if Riverside must run as the Mac app. The user explicitly left the choice open.

Record the decision (date, choice, reason) in `README.md`, then proceed.

**Done when:** the user has chosen a capture method and a front end, and the choice is recorded.

#### §4.14 Live capture adapter (per the decision)

- Implement the chosen adapter behind `AudioSource` (§4.3). It delivers 16 kHz mono Float32 frames, with `sessionMs` taken from a single session clock.
- Browser capture sends PCM16 chunks of about 250 ms to `POST /api/audio/:stream`, with `x-seq` and `x-session-ms` headers. Use a WebSocket instead only if the user approves adding `ws`.
- A native tool pipes PCM into the server instead.
- The server records the raw streams to `host.wav` and `remote.wav` as received.
- Add `{ mode: "live" }` to `POST /api/session/start`.

**Done when:** a 2-minute live test with a co-host on Riverside:
- produces utterances on both streams;
- shows transcripts within 3 s (p90) of each utterance ending;
- leaves a session folder that replays.

**Stop and ask if:** the remote stream contains the host's own voice.

#### §4.15 Front end (per the decision)

These requirements hold whatever the technology. Everything comes from `GET /api/state` plus `GET /api/events`.

- **Stream health:** a level meter and "last frame" age for `host` and `remote`. Show red when a stream is silent for more than 10 s during a session.
- **Live transcript:** speaker display names, and click a name to rename it. A speaker panel renames and merges speakers; a merge asks for confirmation.
- **Timeline:**
  - a `subject` lane, with the AI subjects rolled up into shades of one lane;
  - a `mode` lane;
  - `heat` and `hype` lines;
  - markers for disagreement, humour, hot take, prediction, recommendation, and clip-worthy moments.

  Low-confidence labels are faded. Clicking a marker jumps to the transcript.
- **Filters:** disagreements, hot takes, predictions, recommendations, clips, by speaker, and by subject.
- **Fact-check cards:**
  - status: queued → researching → verdict;
  - the restated claim and the correction;
  - sources as links, and latency;
  - a "repeat" badge and a "host disputes" button.
- **System 1 panel:**
  - the active version;
  - counters for flags, good flags, false alarms, misses, and repeats;
  - the last promotion or rejection with its rationale;
  - a rollback control.
- **Label editor:** edit, add, and remove questions, apply them, and relabel. A stories box for tonight's headlines.
- **Accounting:** a cost meter against the session cap, and the end-of-show stats (§4.12).
- **Legibility:** readable when shared as a window in Riverside at 1280 × 720.

**Done when:** every item above is visible in a replay at `--speed 1`, and you have shown the user a screenshot of each.

### Tier 3: the live show

#### §4.16 Preflight and rehearsal kit

**`npm run preflight`** checks, printing PASS or FAIL for each:
- the models are present;
- the keys are set;
- the config is valid;
- the OpenRouter key's limit and remaining credit (`GET https://openrouter.ai/api/v1/key`);
- one call each to transcription, Jev, and System 2 (about $0.02);
- at least 2 GB of free disk.

**`docs/rehearsal.md`** contains:
- The pre-show checklist:
  - everyone wears headphones;
  - the spend cap is set;
  - tonight's stories are typed in;
  - speakers are renamed as they first speak;
  - the app window is shared in Riverside;
  - a fallback session was recorded the day before and replays at `--speed 1`.
- The planted lines to say on air: the four fixture claims (445×, "never hallucinate", "listed on September eighteenth", "a million times better") plus one about GPT-6 Luna's price.

**Calibration on an old episode.**
1. Convert it with `afconvert -f WAVE -d LEI16@16000 -c 1 <in> <out>.wav`. Riverside exports one track per participant, so pass the host's track as `--host` and a co-host's track or a mix as `--remote`.
2. Calibrate the boundary threshold and the speaker threshold.
3. Write the chosen values to `config/app.json`.

**Done when:** preflight passes, and a rehearsal session is recorded and replays with every feature.

#### §4.17 Optional, only if the user asks

- Persistent speaker profiles across sessions: an opt-in `data/speakers.json` of embeddings.
- A `[laughter]` tag from sherpa-onnx audio tagging.
- An LLM second opinion on low-confidence timeline labels.

## §5 Non-goals

- No after-the-fact LLM questions over the transcript. "When did we…?" is a filter over existing labels.
- No LLM that writes or changes timeline labels, and no live System 2 on the timeline.
- No fixed-interval chunking.
- No Jev for anything code does exactly: company mentions, counting, time, speaker identity.
- No OpenAI diarization model. No OpenAI realtime transcription in v1; reconsider realtime only if the user wants live word-by-word text.
- No multi-language support, video, clip export, social posting, cloud deployment, or authentication (the server binds to 127.0.0.1).
- No integration with Riverside beyond reading exported tracks for calibration.
- No fine-tuning or model training beyond speaker enrolment.
- No changes to the private jev-xp research repository.

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
| --- | --- | --- |
| 1 | Capture method and front end are undecided. | Hold the §4.13 gate; never choose for the user. |
| 2 | Unknown whether Riverside's tab audio contains only the remote participants. | Test in §4.14 before relying on it; stop if the host's voice is in it. |
| 3 | Per-utterance Jev latency with 5–48 questions is unmeasured. Small requests measured p95 838 ms. | Smoke check 4. If p95 exceeds 1.5 s, lower `maxKnownQuestions` and measure again before asking. |
| 4 | OpenRouter's Decisions endpoint is alpha. A third party reported about 15% of calls hanging; this Mac saw 0 failures in 10,120 calls. | Short timeouts, one retry, the boundary fallback. Stop per §4.11 if timeouts exceed the limit. |
| 5 | Unconfirmed whether the web plugin works together with strict `json_schema` and reasoning on GPT-6 Luna, and which engine is better. | Smoke check 5. If strict output fails with the plugin, retry with `response_format: { type: "json_object" }` and a zod parse. If that also fails, stop and ask. |
| 6 | The exact multipart encoding of `keywords` and `languages` for `gpt-transcribe`. | The §4.5 fallback, then stop. |
| 7 | `sherpa-onnx-node`'s README says macOS needs `DYLD_LIBRARY_PATH`. Neither `Vad.flush()` nor the `maxSpeechDuration` key is confirmed in the Node typings; the C++ default for maximum speech duration is 20 s. | Keep the prefix. Feature-detect `flush`. If `maxSpeechDuration` is ignored, split long utterances in code at 20 s. |
| 8 | Speaker-ID accuracy on short utterances and through Riverside's audio codec. | Calibrate (§4.12, §4.16). Inferred speakers are marked, and rename and merge exist. |
| 9 | Jev's accuracy on casual, sarcastic speech for `disagreement`, `hype`, and `heat` is unmeasured. | Thresholds live in config, low-confidence labels are faded, and you calibrate on an old episode. |
| 10 | System 2 verdicts can be wrong on air. Jev answers are not bit-reproducible, so the gate compares a re-asked candidate with the incumbent's recorded outcomes. | Show sources; provide the host dispute button and rollback. |
| 11 | Native web search price through OpenRouter is passed through and not listed. | Log `usage.cost`; cap research by count. |
| 12 | Unknown whether `gpt-transcribe` returns usage. | Estimate cost from audio seconds and mark it `estimated`. |

## §7 Anti-hallucination guardrails

1. **Dependencies.** Runtime: `sherpa-onnx-node` (^1.13.8) and `zod` (^4). Dev: `typescript`, `tsx`, `vitest`, `@types/node`. Anything else, such as `ws`, a bundler, or UI libraries, needs the user's approval at §4.13. No OpenAI or OpenRouter SDKs; use `fetch`.
2. **Files.** Only the files named in §4 and §A, plus tests under `tests/`. Tier 2 files follow the §4.13 decision.
3. **Call paths.** Jev only through `src/jev/client.ts`, never through chat completions. System 2 only through `src/factcheck/s2.ts`.
4. **Jev state.** Speaker display names, text, and tags only. No timestamps, ids, costs, or scores.
5. **System 2's reach.** It may change only the fact-check System 1 set, only through the §4.8 ops. Never `boundary`, never timeline labels, never thresholds outside their ranges, never budgets.
6. **Logging.** Every external call is logged with purpose, latency, attempts, and cost. Keys never appear in any log, event, or file.
7. **Budgets.** Enforce caps in code before each call, not after.
8. **Network.** Tests never call the network. Live calls happen only in `smoke`, `replay`, `serve`, `preflight`, and the calibration CLIs.
9. **Commits.** Commit only with the user's §0 yes, one conventional commit per §4 task. Never commit `models/`, `fixtures/`, `sessions/`, or `.env`.
10. **Scope.** Do not push, deploy, or open pull requests, and do not edit `specs/`. If this spec has a gap, stop and tell the user instead of patching it.

## §8 Verification commands

```bash
# Environment
node --version            # v24.x
sw_vers -productVersion   # 26.x
say -v '?' | grep -E '^(Samantha|Daniel|Karen) '
git status                # "not a git repository": ask the user, then `git init -b main`

# Setup (the user fills OPENROUTER_API_KEY and OPENAI_API_KEY in .env; never print .env)
cp .env.example .env && chmod 600 .env
npm install && npm run models && npm run fixtures

# Offline
npm run typecheck && npm test

# Live checks (~$0.30)
npm run smoke

# Headless replay of the fixture
npm run replay -- --host fixtures/conversation/host.wav --remote fixtures/conversation/remote.wav --speed max
ls "sessions/$(ls -t sessions | head -1)"

# Server and events
npm run serve -- --replay fixtures/conversation --speed 1 &
curl -N localhost:4317/api/events
curl -X POST localhost:4317/api/speakers/spk_1/rename -H 'content-type: application/json' -d '{"displayName":"Nic"}'
curl -X POST localhost:4317/api/speakers/merge -H 'content-type: application/json' -d '{"fromId":"spk_3","intoId":"spk_2"}'
curl localhost:4317/api/stats

# Calibration
npm run calibrate:speakers -- --host <host.wav> --remote <remote.wav>
npm run replay -- --host <host.wav> --remote <remote.wav> --speed max --export boundary.jsonl
npm run calibrate:boundary -- boundary.jsonl
```

## §9 Glossary

| Term | Meaning |
| --- | --- |
| Jev | TypeSafe AI's decision model. It answers typed questions (`noul`, `choice`, `score`) about a state, with probabilities. It cannot generate text or invent options. |
| System 1 / System 2 | Fast, cheap, always-on judgment (Jev plus its question set and thresholds) / slow, deliberate research and rewriting (GPT-6 Luna). |
| `host` / `remote` stream | The host's microphone / the Riverside call audio (co-hosts and guests). |
| Utterance | A stretch of speech between pauses, cut by VAD, with one speaker and one transcript. |
| Filler | A short utterance such as "yeah" that skips the per-utterance Jev request. |
| Segment | Consecutive utterances making one point, closed by the boundary rule. The unit the timeline labels. |
| Section | Consecutive segments with the same subject. |
| System 1 version | An immutable fact-check question set plus thresholds (`s1@N`), of kind `default`, `memory`, or `criteria`. |
| Flag / good flag / false alarm / miss | System 1 marks a claim / System 2 confirms it was worth checking / System 2 finds it was not a checkable claim / an audit finds an unflagged claim. |
| Memory question | `known_<claimId>`: recognises a repeat of a claim already queued or checked. |
| Attention question | `attention_<n>`: a noul question that System 2 adds to prioritise a kind of claim. |
| Replay gate | Asking a candidate System 1 set again on logged states, and promoting it only if it fixes errors without losing good flags. |
| Rogan index | The share of the show spent on `personal_life` and `other_topics`. |
| Speed `max` / `1` | Replay as fast as possible / at real-time pace. |

## §10 References

**In this folder:** `BACKGROUND.md` covers why each decision was made, the rejected alternatives, the measured numbers, and the capture research. It is optional.

**Design background** (read-only, optional), in the private jev-xp research repository:
- `specs/260922-01-xp/jev-as-primitive.md`: Jev's value proposition (§1), evidence, the hallucination claim, confidence, and calibration (§2).
- `specs/260922-01-xp/openrouter-integration.md`: the Decisions API (§4.1–4.6), authoring rules (§4.8), GPT-6 Luna facts (§5.0), request fields (§5.3), and errors and key limits (§5.6).
- `specs/260922-01-xp/models-research.md`: Jev operational facts (rate limits, latency, consistency).
- `src/policy/jevClient.ts`: a working Decisions client built on the OpenRouter SDK. See `sdkTransport` (line 47), `classifyError` (line 77), `backoffMs` (line 107), and `JevClient` (line 142).
- `src/s2/researcher.ts`: `sdkS2Transport` (line 52), GPT-6 Luna calls with provider pinning.

**External**, verified 24 September 2026:
- Jev: [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request), [TypeSafe primitives](https://docs.typesafe.ai/primitives), [TypeSafe models and limits](https://docs.typesafe.ai/models), [TypeSafe confidence](https://docs.typesafe.ai/confidence).
- OpenRouter: [web search](https://openrouter.ai/docs/guides/features/plugins/web-search), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
- OpenAI: [speech to text](https://developers.openai.com/api/docs/guides/speech-to-text), [gpt-transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe), [realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) (a non-goal).
- sherpa-onnx: [Node examples](https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples) (`test_speaker_identification.js`, `test_vad_microphone.js`); npm `sherpa-onnx-node` 1.13.8, with a darwin-arm64 build.
- Capture options for §4.13: [AudioTee](https://github.com/makeusabrew/audiotee), [AudioCap (Core Audio taps)](https://github.com/insidegui/AudioCap), [Chrome system audio on macOS](https://blog.addpipe.com/getdisplaymedia-allows-capturing-the-screen-with-system-sounds-on-chrome-on-macos/), [Riverside supported browsers](https://support.riverside.com/hc/en-us/articles/5252134218013-System-requirements-and-supported-browsers), [browser VAD alternative](https://docs.vad.ricky0123.com/user-guide/browser/).

### §A Anchors (the Tier 1 file set)

```
config/app.json                                  thresholds, caps, models (§4.2)
config/labels.default.json                       boundary + timeline questions (§4.9)
config/factcheck.s1.default.json                 s1@1 question set (§4.8)
src/config.ts                                    config loading (§4.2)
src/audio/{wav,source,vad,tags}.ts               audio in (§4.3)
src/speakers/registry.ts                         speakers (§4.4)
src/transcribe/openai.ts                         transcription (§4.5)
src/jev/{client,types}.ts                        Jev (§4.6)
src/pipeline/{segmenter,timeline,stats,session}.ts
src/factcheck/{s1,queue,s2,gate}.ts              fact-checker (§4.8)
src/store/{sessionStore,events}.ts               store and events (§4.10)
src/server/main.ts                               HTTP + SSE (§4.10)
src/cli/{replay,smoke,preflight,calibrateBoundary,calibrateSpeakers}.ts
src/types/sherpa-onnx-node.d.ts                  only if typings are missing (§4.1)
scripts/{download-models.sh,make-fixtures.ts}
docs/rehearsal.md                                Tier 3 (§4.16)
```
