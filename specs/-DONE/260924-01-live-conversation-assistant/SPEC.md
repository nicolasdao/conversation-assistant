# SPEC — Conversation Assistant v1: live transcript, Jev timeline, and fact-checker

Created 24 September 2026 from a design session held in the private jev-xp research repository. Stack: TypeScript on Node 24, macOS 26.2 on Apple Silicon. Status: Tier 1 is ready to implement. The Tier 2 capture and front-end decision was made with the user on 24 September 2026 (§4.13).

## §0 How to use this spec (read first)

**What this is.** Everything needed to build Conversation Assistant v1 in this repository. It is a local app that listens to a remote podcast recording (the host's microphone plus the Mac's system audio, which carries the Riverside call) and transcribes it live. It labels the conversation on a timeline with Jev and fact-checks claims with a System 1 / System 2 loop. The host will demonstrate it live, on air, during the hosts' AI podcast.

**Who you are.** A fresh session with no memory of the design discussion. Every decision is recorded here. `BACKGROUND.md` explains why; you do not need it to build.

**DO**
- Read this file end to end before writing code.
- Implement Tier 1 (§4.1–§4.12) in order, and verify each task's **Done when** before starting the next.
- In your first 30 minutes, ask the user once whether you may make one local conventional commit per task (`feat(audio): …`, `test(factcheck): …`) on branch `master`. Without that yes, do not commit. When committing, stage only the paths the task touched (`git add <paths>`), never `git add -A`.
- At §4.13, read the recorded decision and follow it. Do not reopen it.
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
3. Run `git status`. The repository already exists on `master`, with remote `origin` (`github.com/nicolasdao/podcast-ai-assistant`), and `.gitignore` is committed. Leave any uncommitted edits under `specs/` alone: they are the user's. Ask about commits (see DO).
4. Start §4.1.

No project spec-rules file is configured. Terms are defined in §9.

## §1 Goal

Build a local pipeline and API that works with any capture method. For a live or replayed podcast session, it:
1. Takes two audio streams:
   - `host`: the host's microphone.
   - `remote`: the Mac's system audio, meaning everything the Mac plays, whatever the output device. During the show that is the Riverside call: co-hosts and guests.

   It cuts each stream into utterances with local voice activity detection (VAD). It labels each utterance's speaker with local voice embeddings: an unrecognised voice becomes "Speaker N", which the host can rename or merge live.
   The host wears earbuds during the show, so the microphone never picks up the call audio (§2.1, §5).
2. Transcribes each utterance with OpenAI `gpt-transcribe`.
3. Groups utterances into segments using a Jev boundary question plus code rules.
4. Labels each closed segment with a predefined, host-editable set of Jev questions (the timeline).
5. Fact-checks claims:
   - Jev flags checkable claims on every utterance (System 1).
   - GPT-6 Luna with web search researches the flagged claims (System 2).
   - Each verdict grades the flag that triggered it, and audits find misses.
   - System 2 reprograms System 1 through memory questions and criteria rewrites. A rewrite takes effect only after it passes a replay gate.
6. Records every session so it can be replayed through the same pipeline for tests, calibration, and an on-air fallback. It streams all results to any front end over HTTP and Server-Sent Events (SSE).

Tier 1 delivers items 1–6 headless, driven by WAV files. Tier 2 adds live capture (a native Swift helper) and a local web front end. Tier 3 prepares the live show.

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
| Architecture | A headless engine (the Node server plus a native capture helper) owns all capture and intelligence. The front end is a thin client of the HTTP and SSE API. | User decision: capture must not depend on a browser tab |
| Capture method | A native Swift command-line helper captures both streams: the built-in microphone (`host`) and a global Core Audio tap of all system output (`remote`). It pipes framed PCM to the Node server over stdout (§4.14). | User decision, 24 September 2026 |
| System audio scope | Everything the Mac plays, on any output device (speakers, wired earbuds, AirPods), not one app's output | User decision |
| Echo | The host wears earbuds, so the mic never hears the call. No echo cancellation (§5). | User decision: a demo, not a production system |
| Front end | A local web page served by the engine, in plain TypeScript compiled with `tsc` to browser ES modules. No bundler, no UI framework. | User decision; no new dependencies |
| Storage | Plain files: one folder per session with WAVs, `session.json`, and append-only JSONL (§4.10). Live state in memory. No database. | Crash-safe, readable, dependency-free, and replay is built on it |
| License | MIT; the project will be open-sourced as a demo | User decision |
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
- The documented response is `{ text, languages }`. No usage field is documented (§6 row 12).
- $0.0045 per audio minute.

**sherpa-onnx-node 1.13.8** has a darwin-arm64 build. Its README asks for `DYLD_LIBRARY_PATH=node_modules/sherpa-onnx-darwin-arm64` on macOS.

### §2.4 Secrets

- `OPENROUTER_API_KEY` (Jev and GPT-6 Luna) and `OPENAI_API_KEY` (transcription) live in `.env` at the repository root, mode 600, gitignored.
- `.env.example` lists both names with empty values.
- Load them with Node's `--env-file=.env` in npm scripts. No dotenv.
- Suggest to the user a dedicated OpenRouter key for this project with a $10 credit limit.
- Keys never appear in logs, session files, or events.

### §2.5 How to call each service (use these recipes; do not reinvent them)

**OpenRouter in brief.** OpenRouter is an API gateway.
- One key (`OPENROUTER_API_KEY`, created by the user at openrouter.ai with a credit limit on the key) reaches many models through an OpenAI-compatible chat endpoint (`https://openrouter.ai/api/v1/chat/completions`). Jev has its own alpha endpoint beside it (`https://openrouter.ai/api/alpha/decisions`).
- Authenticate with `Authorization: Bearer <key>`. The optional header `X-OpenRouter-Title: Conversation Assistant` labels calls in the OpenRouter dashboard.
- Every response reports its price in USD in `usage.cost`.
- `GET https://openrouter.ai/api/v1/key` returns the key's `limit`, `limit_remaining`, and usage.
- Per-model rate limits exist but are unpublished. From this Mac, 10,120 Jev calls at concurrency 8 needed one retry and none failed.

**Jev call** (Node 24 `fetch`):

```ts
const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json",
             "X-OpenRouter-Title": "Conversation Assistant" },
  body: JSON.stringify({ model: "typesafe/jev-1.13", state, questions }),
  signal: AbortSignal.timeout(timeoutMs),
});
const text = await res.text();                 // read once: error bodies are not always JSON
const ra = res.headers.get("retry-after");     // seconds, or an HTTP date
const retryAfterMs = ra === null ? null
  : Number.isFinite(Number(ra)) ? Number(ra) * 1000
  : Math.max(0, Date.parse(ra) - Date.now()) || null;
if (!res.ok) throw new HttpError(res.status, text, retryAfterMs);
const start = text.indexOf("{");               // the body may start with keep-alive whitespace
if (start < 0) throw new HttpError(res.status, text, retryAfterMs);  // a 2xx without JSON: treated as an error body without a code
const body = JSON.parse(text.slice(start));
if (body.error) throw new HttpError(res.status, text, retryAfterMs);  // an upstream error delivered with HTTP 200
if (typeof body.usage?.cost !== "number") throw new HttpError(-1, text, null);  // rejected, not retried
```

A real response, with the legend text abridged. Raw HTTP uses snake_case; OpenRouter's SDK would convert it to camelCase.

```json
{ "answers": {
    "is_bug":  { "type": "noul", "noul": 0.96 },
    "team":    { "type": "choice", "choice": "payments", "confidence": 0.75,
                 "probabilities": { "account": 0, "frontend": 0.16, "payments": 0.84 } },
    "urgency": { "type": "score", "score": 1.99, "confidence": 0.99,
                 "legend": { "0": "Can wait", "1": "This week", "2": "Blocking revenue" },
                 "probabilities": { "0": 0, "1": 0.01, "2": 0.99 } } },
  "id": "gen-dec-1789738314-X5e5eKGQdvR9rblyX250", "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe", "usage": { "cost": 0.000019992, "input_tokens": 476, "output_tokens": 70 } }
```

**Retry and backoff for every OpenRouter call.** This is jev-xp's proven logic (`classifyError`, `embeddedErrorCode`, `backoffMs`).
- **Retry:**
  - no HTTP status (a network error or timeout);
  - 429;
  - any 5xx, including 524 (edge timeout) and 529 (provider overloaded);
  - a 402 whose `error.metadata.limit_source` is `openrouter_in_flight_budget`;
  - an HTTP 2xx whose body is an error object. Classify it by the `error.code` inside the body with these same rules, and retry when the body has no code.
- **Fail without retrying:**
  - 400;
  - 401, a bad key: stop and tell the user;
  - 403 and 404;
  - 413, payload too large: too many questions;
  - status −1, a response without `usage.cost`;
  - any other 402, meaning credits or the key limit are exhausted: emit `budget.exhausted`.
- **Wait** `retryAfterMs ?? min(30_000, 1_000 × 2^attempt)` plus 0–500 ms of jitter. The pause is shared across concurrent callers.
- **Live purposes** (`utterance`, `segment`) make at most `jev.maxAttempts` (2) attempts with their short timeouts. The second attempt happens only after a no-status failure, a 5xx, or a 2xx error body that the rules above would retry, and only immediately; a live call never waits out a backoff. A 429 or the transient 402 goes straight to the caller's fallback, and it sets the shared pause that background calls respect.
- **Background purposes** (`relabel`, `gate`, `preflight`) use `jev.backgroundMaxAttempts` and `jev.backgroundTimeoutMs`, with the backoff above.
- **Smoke checks** use the settings each check states in §4.11.

**Question authoring rules** (the rulebook from TypeSafe and OpenRouter):
- Use the fewest questions that capture every judgment, with one narrow judgment per question.
- `choice`: a description for every option, plus a `none` or `other` option.
- `noul`: concrete `criteria.true` and `criteria.false` descriptions when the boundary is fuzzy.
- `score`: 2–6 concrete levels recommended, lowest first. TypeSafe accepts 2–10 and rejects fewer than two.
- snake_case ids.
- Never ask for free text, counting, or arithmetic.

System 2's rewrites must pass the same checks (§4.8c).

**GPT-6 Luna call:**

```json
POST https://openrouter.ai/api/v1/chat/completions
{ "model": "openai/gpt-6-luna",
  "messages": [ { "role": "system", "content": "…" }, { "role": "user", "content": "…" } ],
  "reasoning": { "effort": "medium" },
  "provider": { "order": ["openai"], "allow_fallbacks": false, "require_parameters": true },
  "plugins": [ { "id": "web", "engine": "exa", "max_results": 5 } ],
  "response_format": { "type": "json_schema", "json_schema": { "name": "verdict", "strict": true, "schema": { } } } }
```

Read from the response:
- `choices[0].message.content`: a JSON string. Parse it, then validate it with zod.
- `choices[0].message.annotations[]`: entries `{ type: "url_citation", url_citation: { url, title, content, start_index, end_index } }`.
- Top-level `model` and `provider`.
- `usage`: `prompt_tokens`, `completion_tokens`, `completion_tokens_details.reasoning_tokens`, `prompt_tokens_details.cached_tokens`, and `cost`.

Rules for GPT-6 Luna calls:
- Omit `plugins` in audit and rewrite calls.
- Send no `temperature` or `top_p`; they are unsupported.
- Use no function calling. These models accept tools only with reasoning `none`.
- The knowledge cutoff is 18 May 2026, so anything later must come from web results.
- Keep each system prompt byte-identical across calls, so cached input is billed at $0.01 instead of $0.10 per million tokens.
- `usage.cost` is always present. The old `usage: { include: true }` flag is deprecated.
- Error bodies add `error.metadata.error_type`: `rate_limit_exceeded`, `provider_overloaded`, `provider_unavailable`, `context_length_exceeded`, `timeout`, or `payment_required`. Classify errors with the retry rules above.
- Every System 2 call (research, audit, rewrite) uses `s2.timeoutMs` and at most `s2.maxAttempts` (2) attempts, with the backoff above.

**OpenAI transcription call:**

```ts
const form = new FormData();
form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "utterance.wav");
form.append("model", "gpt-transcribe");
form.append("prompt", cfg.transcription.prompt);
for (const k of cfg.transcription.keywords) form.append("keywords[]", k);
for (const l of cfg.transcription.languages) form.append("languages[]", l);
const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, // no Content-Type: fetch sets the multipart boundary
  body: form,
  signal: AbortSignal.timeout(cfg.transcription.timeoutMs),
});
// 200 → { text, languages }; error → { error: { message, type, param, code } }
```

- Files may be up to 25 MB, in mp3, mp4, mpeg, mpga, m4a, wav, or webm.
- The default Tier 1 limit for `gpt-transcribe` is 500 requests per minute; the pipeline sends about 15.
- The OpenAI account needs billing enabled.

**sherpa-onnx helpers to reuse** (from the official examples):
- `sherpa.readWave(path)` returns `{ samples: Float32Array, sampleRate }`.
- `sherpa.writeWave(path, { samples, sampleRate })`.
- `new sherpa.LinearResampler(fromRate, toRate).resample(samples)`, for WAV files that are not 16 kHz. Live capture arrives already at 16 kHz from the Swift helper (§4.14a).
- `new sherpa.CircularBuffer(capacity)`, with `push`, `get(start, n)`, `pop(n)`, `size()`, and `head()`, to feed VAD windows.

**Fallback, only with the user's approval: TypeSafe's direct API.**
- `POST https://api.typesafe.ai/v1/systemone` with a TypeSafe key, the same `{ state, questions }` body, and `model: "jev-1.13.0"`.
- 64,000 tokens per request, of which state plus the longest question may use 32,000. 1,200 requests per minute per model.
- Responses lack OpenRouter's `id`, `provider`, and `usage.cost`, so estimate cost from tokens at $0.042 per million.
- The documented client is TypeSafe's JS SDK (`@typesafe-ai/sdk`, `TypeSafeClient`).

**Privacy.** Podcast audio goes to OpenAI, and transcripts go to OpenRouter, TypeSafe, and OpenAI (through GPT-6 Luna).
- OpenRouter stores prompts only if the account has opted into logging.
- Per request, `provider: { data_collection: "deny" }` restricts routing to providers that do not collect data.
- `provider: { zdr: true }` restricts routing to zero-data-retention endpoints. It is not confirmed that Jev's TypeSafe endpoint is on that list.
- The user has not chosen a setting (§6).

**Long-form references, if anything above is unclear.** These are read-only, in the private jev-xp research repository.
- `specs/260922-01-xp/openrouter-integration.md`:

  | Section | Topic |
  | --- | --- |
  | §1 | Two endpoints, one key |
  | §3 | Authentication and headers |
  | §4.1–§4.2 | Decisions request and response |
  | §4.3–§4.4 | SDK alternatives |
  | §4.5 | Model pinning |
  | §4.6 | Errors, retries, and concurrency |
  | §4.7 | Packing several records into one request (not used here) |
  | §4.8 | Authoring rules |
  | §5.0 | GPT-6 Luna facts |
  | §5.3 | Request fields |
  | §5.6 | Errors, limits, and credits |
  | §6 | Ledger fields |
  | §7 | Data policy |

- `specs/260922-01-xp/models-research.md`, sections "Jev: availability, economics, and correct use" and "23 September operational recheck": rate limits, context, state format, batching, billing overhead, latency, endpoints, and SDK retry defaults.
- `specs/260922-01-xp/jev-as-primitive.md`: §2 (the hallucination claim, confidence, calibration), §5 (request shape for loops and streams), §8 (run-to-run stability).
- Working code:
  - `src/policy/jevClient.ts`: a complete Jev client on the OpenRouter SDK.
  - `src/s2/researcher.ts`: `sdkS2Transport` (line 52) makes GPT-6 Luna calls with provider pinning. It reads `provider` from the raw body because the SDK drops that field.

## §3 Acceptance criteria

**Tier 1 (headless):**
- `npm run typecheck` and `npm test` pass, and the tests make no network calls.
- `npm run fixtures` creates `fixtures/conversation/host.wav`, `remote.wav` (16 kHz mono PCM16), and `script.json`.
- `npm run smoke` passes every check in §4.11. It prints per-utterance Jev latency p50 and p95 over 50 calls with at most 2 timeouts, and total spend is ≤ $0.50.
- `npm run replay -- --host fixtures/conversation/host.wav --remote fixtures/conversation/remote.wav --speed max` creates `sessions/<id>/` with every file listed in §4.10, and:
  - `speakers.json` holds exactly 3 speakers, one per fixture voice.
  - `segments.jsonl` holds ≥ 2 closed segments, none longer than `maxSegmentMs`.
  - `claims.jsonl` flags the "445 times cheaper" utterance and the "never hallucinate" utterance.
  - Each researched claim has a schema-valid verdict with ≥ 1 source, or the verdict `unverifiable` or `not_a_claim`.
  - The repeated "445 times cheaper" line produces a `claim.repeat` or `claim.duplicate` event linked to the first claim, with no second research call.
- With `npm run serve -- --replay fixtures/conversation --speed 1` running, `curl -N localhost:4317/api/events` shows `utterance`, `segment.closed`, `segment.labels`, `claim.flagged`, and `claim.verdict` events.
- A rename request (§8) emits `speaker.updated`, and later events use the new name.
- `npm run calibrate:boundary -- <labelled.jsonl>` prints precision, recall, and F1 for thresholds 0.3–0.9.

**Tier 2** (decided at §4.13):
- `npm run build:capture` builds the Swift helper, and `npm run capture:test` passes (§4.14a).
- A live session on the user's real setup (earbuds, Riverside in Chrome) shows, at minimum:
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
- `vitest.config.ts`: tests in `tests/**/*.test.ts`, 120 s timeout, `setupFiles: ["tests/setup.ts"]`.
- `tests/setup.ts`: replaces `globalThis.fetch` with a function that throws "network disabled in tests". Tests pass fakes to the clients through their constructors. This is how "tests never call the network" (§7) is enforced.
- `.gitignore` already exists (added 24 September 2026). Do not recreate or trim it. It ignores secrets, `node_modules/`, build output, `models/`, `fixtures/`, `sessions/`, `data/`, every audio, video, and `*.jsonl` file anywhere, and macOS and editor clutter. To commit a deliberate test asset, add a `!path` exception and tell the user.
- `.env.example`, a short `README.md` (setup and scripts), `LICENSE` (MIT, "Copyright (c) 2026 Nicolas Dao"), and `config/app.json` (§4.2).

**npm scripts:** `test`, `typecheck`, `models` (`sh scripts/download-models.sh`), `fixtures`, `smoke`, `replay`, `serve`, `preflight`, `calibrate:boundary`, `calibrate:speakers`. Tier 2 adds `build:capture`, `capture:test`, and `build:web` (§4.14, §4.15).

Scripts that load `sherpa-onnx-node` (including `test`) need its native library to load:
1. After `npm install`, run `node -e "require('sherpa-onnx-node')"`. If it loads, no special environment is needed. Run TypeScript scripts as `node --env-file=.env --import tsx <file>`, and tests as `vitest run`.
2. If it fails, set `DYLD_LIBRARY_PATH=node_modules/sherpa-onnx-darwin-arm64`, and put it directly in front of `node`. For example:
   - `DYLD_LIBRARY_PATH=node_modules/sherpa-onnx-darwin-arm64 node --env-file=.env --import tsx src/cli/replay.ts`
   - `DYLD_LIBRARY_PATH=node_modules/sherpa-onnx-darwin-arm64 node node_modules/vitest/vitest.mjs run`

   macOS strips `DYLD_*` variables when a program starts through a `/usr/bin/env` shebang, which is how the `tsx` and `vitest` commands start. Setting the variable in front of `tsx` or `vitest` therefore does not reach the addon.

**`scripts/download-models.sh`** downloads into `models/`, skipping files that already exist:
- `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`
- `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx` (about 26.5 MB; the tag's misspelling is real)

Tests that need `models/` or `fixtures/` fail with the message "run npm run models && npm run fixtures". Import the addon from ESM as `import sherpa from "sherpa-onnx-node"`. If its typings are missing, add a minimal `src/types/sherpa-onnx-node.d.ts`.

**Done when:** `npm install && npm run models && npm run typecheck && npm test` succeeds with one placeholder test, and a script importing `sherpa-onnx-node` runs.

**Stop and ask if:** `sherpa-onnx-node` still fails to load with `DYLD_LIBRARY_PATH` set directly in front of `node`.

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
  "jev": { "model": "typesafe/jev-1.13", "utteranceTimeoutMs": 3000, "segmentTimeoutMs": 5000, "maxAttempts": 2,
           "backgroundTimeoutMs": 30000, "backgroundMaxAttempts": 5, "concurrency": 8, "segmentConcurrency": 4 },
  "segmentation": { "boundaryThreshold": 0.6, "speakerChangeGapMs": 1500, "speakerChangeBonus": 0.1,
                    "minSegmentMs": 12000, "maxSegmentMs": 75000, "reorderTimeoutMs": 8000 },
  "timeline": { "noulMarkerThreshold": 0.7, "clipWorthyMin": 3, "fadedBelowConfidence": 0.5,
                "companies": ["OpenAI", "Anthropic", "Google", "Meta", "Nvidia", "TypeSafe", "OpenRouter", "DeepSeek", "Hugging Face"],
                "stories": [] },
  "s2": { "model": "openai/gpt-6-luna",
          "provider": { "order": ["openai"], "allow_fallbacks": false, "require_parameters": true },
          "web": { "engine": "exa", "max_results": 5 },
          "effort": { "research": "medium", "audit": "low", "rewrite": "medium" },
          "timeoutMs": 90000, "maxAttempts": 2, "researchConcurrency": 2, "maxResearchPerHour": 30, "maxResearchPerSession": 40,
          "staleAfterMs": 600000 },
  "factcheck": { "hedgedThreshold": 0.6, "knownMatchThreshold": 0.8, "maxKnownQuestions": 40,
                 "auditIntervalMs": 300000, "auditMinUtterances": 10, "auditSample": 10,
                 "rewriteOnFalseAlarms": 3, "rewriteOnMisses": 2, "rewriteCooldownMs": 180000, "replayMaxItems": 300 }
}
```

The three thresholds that System 2 may change (`claimThreshold`, `worthMin`, `attentionThreshold`) do not live here. They belong to each System 1 version, so they sit in `config/factcheck.s1.default.json` (§4.8a). Code never writes to `config/app.json` at runtime.

`transcription.fixes` is a list of `{ "pattern": "<whole-word regex>", "replace": "…" }` entries applied to transcripts. It ships empty. Do not add "Jeff" → "Jev": real people are called Jeff.

**Done when:** a test loads all three files against zod schemas for the shapes in §4.2, §4.8a, and §4.9. It rejects:
- a config where `segmentation.minSegmentMs > maxSegmentMs`;
- a label set with a `choice` that has no criteria, or no fallback option (a key equal to `none`, or starting with `other`, such as `other_topics`);
- a `score` with fewer than 2 levels.

#### §4.3 Audio source, WAV codec, VAD, fixtures

**`src/audio/wav.ts`** encodes a Float32 utterance as an in-memory PCM16 mono WAV for uploads. It also provides a streaming WAV writer for session recordings, which patches the header on close. Read WAV files with `sherpa.readWave`, and resample anything that is not 16 kHz with `sherpa.LinearResampler` (§2.5).

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
- Emit `Utterance { id: "u_<n>", stream, startMs, endMs, samples }`.
  - `<n>` comes from one session-wide counter, not a counter per stream.
  - `seg.start` is a sample index counted from the first sample given to that VAD. `streamStartMs` is the `sessionMs` of that first frame.
  - So `startMs = streamStartMs + seg.start / 16` and `endMs = startMs + seg.samples.length / 16`.
- The session feeds all sources to their VADs in `sessionMs` order, merging the streams frame by frame. Files at `speed: "max"` therefore stay aligned across streams; live sources arrive in real time. Each stream's **watermark** is the `sessionMs` of the last frame given to its VAD.
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

**Scope notes:**
- Because the host wears earbuds, the `host` stream is expected to hold only the host's voice. The registry is still shared by both streams and makes no such assumption; the real work is telling co-hosts and guests apart on `remote`.
- OpenAI's speaker labels are not used (§5). They are scoped to one request, and this pipeline sends one request per utterance, so they could not track a voice across the session.

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
- Cost is `durationSeconds / 60 × 0.0045`, recorded in the budget (§4.6). Log one row per call: `{ kind: "transcription", utterance_id, ok, latency_ms, attempts, audio_seconds, cost_usd, estimated: true, error? }`.
- Apply `fixes` to the text.
- Mark the utterance `filler: true` when the trimmed text matches `/^(uh|um|mm|hmm|mm-hmm|yeah|yes|no|okay|ok|right|so)\W*$/i` or is shorter than 4 characters.
- Drop utterances with empty text.

**Done when:**
- A unit test with a fake `fetch` checks the multipart fields.
- Smoke check 1 (§4.11) transcribes the first Daniel line, and the text contains "Jev".

**Stop and ask if:** the API rejects the bracketed fields (`keywords[]`, `languages[]`), and also rejects one retry that sends `keywords` and `languages` repeated without brackets.

#### §4.6 Jev client

`src/jev/client.ts` makes raw `fetch` calls to the Decisions endpoint (recipe in §2.5) with:
- `AbortSignal.timeout` and a bounded number of attempts, from config, using live or background settings by purpose;
- the retry and backoff rules from §2.5;
- a shared concurrency limit;
- a check against the shared budget (`src/budget.ts`, below) before every call.

It writes one log row per call:

```
{ kind: "jev_call", purpose, utterance_id?, segment_id?, request_hash, state, question_ids, question_set_version,
  ok, latency_ms, attempts, id, model_returned, provider_returned, answers, usage, cost_usd, error? }
```

`state` and `answers` are stored so the replay gate can ask again and compare. The fields `id`, `model_returned`, `provider_returned`, and `usage` are the audit fields listed in `openrouter-integration.md` §6.

**`src/budget.ts`** is the one spending ledger for the whole process. Every external caller (transcription, Jev, System 2) uses it:
- **Before each call:** `assertCanSpend(purpose)`. It throws and emits `budget.exhausted` once either cap is reached:
  - the session total reaches `budget.sessionCapUsd`;
  - the dev total reaches `budget.devCapUsd`.
- **After each call:** `record(bucket, cost_usd)`, with bucket `transcription`, `jev`, or `s2`. This drives the `cost` event.
- **Dev total.** At process start, it sums `cost_usd` over the rows in `sessions/**/*.jsonl` whose `kind` is `jev_call`, `s2_call`, or `transcription`. Only call rows count, never events or totals, which would count a cost twice.
- **Where the dev cap applies.** Development runs (`smoke`, `replay`, `serve --replay`, and the calibration CLIs) enforce it. Live sessions (Tier 2 onward) enforce only `sessionCapUsd`. A CLI flag `--allow-over-dev-cap` lifts only the dev cap, and you use it only with the user's approval.
- **Where rows go.** Every CLI that spends money writes its rows into a session folder; smoke uses `sessions/smoke-<YYYYMMDD-HHMMSS>/`. `src/jev/types.ts` holds the question and answer types from §2.2.

Port, don't reinvent: the §2.5 rules are the logic of `classifyError` (jev-xp's `src/policy/jevClient.ts:77`) and `backoffMs` (line 107), and of the shared pause and priority queue in `JevClient` (line 142), adapted from the SDK to `fetch`.

**Done when:** tests with a fake `fetch` cover:
- success;
- a 429 followed by success (background purpose);
- a 429 on a live purpose going straight to the fallback;
- a 400 that fails immediately;
- a timeout;
- a 2xx with an error body, retried;
- a response without `usage.cost` being rejected;
- `retry-after` in seconds and as an HTTP date;
- a call refused by the budget;
- the dev total being summed from existing session files.

#### §4.7 Segmenter

`src/pipeline/segmenter.ts` consumes transcribed utterances in `startMs` order across both streams, through a reorder buffer. Utterance u is released when either:
- **Everything earlier is settled.** Every already-emitted utterance with a smaller `startMs` has finished transcription (successfully or not), and every other stream has a watermark ≥ `u.startMs` and is not mid-speech (`vad.isDetected()` false).
- **Timeout.** `reorderTimeoutMs` has passed since u's transcription finished.

A stream that is absent, or whose source has ended and whose VAD has been flushed, counts as watermark +∞ and never mid-speech.

An utterance that arrives after a later one has been processed joins the open segment in arrival order; closed segments are never reopened. The `overlap` tag (§4.3) is computed at release time. An utterance whose transcription fails after its retry is released as `failed`: it is logged, skips Jev like a filler, and adds no text.

It processes one utterance at a time:
1. A filler skips Jev and joins the open segment. If adding it would exceed `maxSegmentMs`, close the segment first (`forced: true`), as for any utterance.
2. Any other utterance gets one Jev request (`purpose: "utterance"`, timeout `utteranceTimeoutMs`). The request carries the state below plus these questions: `boundary` (§4.9), the active fact-check System 1 set (§4.8), and its memory questions.
3. Close the open segment before this utterance when either:
   - `boundary ≥ boundaryThreshold` and the segment is at least `minSegmentMs` long. The threshold drops by `speakerChangeBonus` when the speaker changes after a gap of at least `speakerChangeGapMs`.
   - Adding the utterance would exceed `maxSegmentMs`. Mark this close `forced: true`.

   The first utterance opens the first segment.
4. If the Jev request fails, treat the boundary as 0 and skip fact-checking for this utterance. The failed `jev_call` row records the error, and an `error` event with `component: "jev"` is emitted.
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

`config/factcheck.s1.default.json` has this JSON shape. Question objects are exactly the Decisions API shapes from §2.2.

```json
{ "id": "s1@1",
  "questions": { "claim": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } },
                 "claim_type": { "type": "choice", "instructions": "…", "criteria": { "number_or_price": "…" } },
                 "hedged": { "type": "noul", "instructions": "…" },
                 "worth": { "type": "score", "instructions": "…", "criteria": ["…", "…", "…", "…", "…"] } },
  "thresholds": { "claimThreshold": 0.7, "worthMin": 2, "attentionThreshold": 0.7 } }
```

A **System 1 version** is this object plus `parent`, `kind` (`default` or `criteria`), `createdAt`, `rationale`, and `gate` (metrics, or null). Versions are immutable, and `s1_versions.jsonl` holds every one. The question text for `s1@1`:

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

**Flag rule.** Using the active version's thresholds, flag the utterance when all three hold: `claim ≥ claimThreshold`, `claim_type ≠ none`, and `worth ≥ worthMin`. Its priority is:

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
- Memory questions are not part of any System 1 version. Adding or evicting one emits `s1.memory` and never goes through the gate. Promotions and rollbacks keep the current memory set.

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

> You fact-check one spoken claim from a live English-language AI podcast. Today is <date>. Your own knowledge ends in May 2026, so rely on the web results for anything after that, and never call something false only because you have not heard of it. Judge the claim as a listener would understand it. Verdicts:
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

Keep length and count limits out of the strict schema: OpenAI's strict mode has historically rejected `maxLength` and `maxItems`. Declare plain strings and arrays. Nullable fields are not needed here.

After the call:
- Parse the content and validate it with zod.
- Enforce the limits in code:
  - truncate `restated_claim` to 200 characters;
  - truncate `correction` to 25 words;
  - keep the first 3 sources, counted after the merge below.
- Merge `message.annotations[].url_citation` into `sources`, deduplicated by URL, before the 3-source limit is applied.
- A `supported`, `contradicted`, or `misleading` verdict with no source at all becomes `unverifiable`, marked `downgraded: true`.
- Record `usage.cost` in the budget, and log one row per System 2 call (research, audit, and rewrite alike): `{ kind: "s2_call", purpose, claim_id?, ok, latency_ms, attempts, id, model_returned, provider_returned, usage, cost_usd, error? }`.

**Grade.**
- `false_alarm` when the verdict is `not_a_claim` or `false_alarm_reason ≠ none`; otherwise `good_flag`.
- A host override through `POST /api/claims/:id/override` marks the verdict `disputed` (`claim.disputed`) and removes its grade from the evidence.

**Done when:**
- Unit tests with a fake System 2 cover the caps, staleness, source merging, the downgrade, grading, and override exclusion.
- The fixture replay meets the fact-check criteria in §3.

**Stop and ask if:** the verdict call fails both with strict `json_schema` and with the fallback in §6 row 5.

##### §4.8c Feedback loop: audit, rewrite, replay gate

**Audit.**
- Every `auditIntervalMs`, if at least `auditMinUtterances` unflagged, non-filler utterances have accumulated, send a random sample of up to `auditSample` of them to GPT-6 Luna.
- No web search, effort `effort.audit`.
- System message:

  > You audit a live AI podcast's fact-checker. For each utterance, say whether it contains a specific factual claim that could be checked against public sources, and how much listeners would care whether it is accurate. Opinions, jokes, exaggerations, and vague statements are not checkable claims.

- The user message lists `{ utterance_id, speaker, text }` for each utterance.
- Strict schema: `{ items: [{ utterance_id: string, has_checkable_claim: boolean, worth: "low" | "medium" | "high" }] }`.
- An item with `has_checkable_claim` true and `worth ≠ low` is a **miss**.

**Criteria rewrite.**

*Trigger.* All of:
- counting from the moment the active version became active, false alarms reach `rewriteOnFalseAlarms` or misses reach `rewriteOnMisses` (memory changes do not reset the count);
- no rewrite ran within the last `rewriteCooldownMs`.

*Call.* Ask GPT-6 Luna (no web search, effort `effort.rewrite`) for a rewrite. System message:

> You improve the questions a fast classifier uses to flag checkable factual claims in a live AI podcast. You get the active questions and thresholds, false alarms (flagged but not checkable) with reasons, correctly flagged examples, and missed claims. Propose at most 3 changes that remove false alarms or catch misses without losing correct flags. Follow these question rules: one narrow judgment per question, concrete true and false descriptions for yes/no questions, never ask for counting or arithmetic.

The user message holds:
- the active question set and thresholds;
- the false alarms with their reasons;
- up to 10 good flags and up to 10 misses, as utterance texts.

The strict schema has every field required and no extra properties. Fields shown with `| null` are declared as `type: ["…", "null"]`.

```json
{ "changes": [ { "op": "set_instructions | set_criteria | add_attention | remove_attention | set_threshold",
                 "target": "string",
                 "text": "string | null",
                 "true_text": "string | null", "false_text": "string | null",
                 "options": [ { "key": "string", "description": "string" } ] | null,
                 "levels": [ "string" ] | null,
                 "number": "number | null" } ],
  "rationale": "string" }
```

Which fields each op must fill (all others null). Code rejects the whole rewrite if it has more than 3 changes or if any change breaks these rules:
- `set_instructions`: `text`.
- `set_criteria` on `claim` or `hedged`: `true_text` and `false_text`.
- `set_criteria` on `claim_type`: `options`, listing exactly its 7 existing keys.
- `set_criteria` on `worth`: `levels`, exactly 5, lowest first.
- `add_attention`: `target` is `"new"`, plus `text` and optionally `true_text` and `false_text`. Code assigns the id `attention_<n>`.
- `remove_attention`: `target` is an existing `attention_<n>`.
- `set_threshold`: `number`.

*Allowed ops and limits:*

| Op | May target | Limits |
| --- | --- | --- |
| `set_instructions`, `set_criteria` | `claim`, `claim_type`, `hedged`, `worth` | For `claim_type`, descriptions only: keys stay fixed and `none` stays. Instructions ≤ 400 characters. |
| `add_attention`, `remove_attention` | noul questions named `attention_<n>` | At most 3 |
| `set_threshold` | `claimThreshold`, `attentionThreshold` | Within [0.5, 0.9] |
| `set_threshold` | `worthMin` | Within [1, 3] |

**Replay gate** (`gate.ts`).

*Evaluation items.* Logged utterance states (`jev_call` rows with `purpose: "utterance"`, joined by `utterance_id`), newest first, up to `replayMaxItems`, falling into three sets:
- `G`: flagged utterances graded good flags;
- `F`: flagged utterances graded false alarms;
- `M`: utterances an audit found missed.

*Steps.*
1. Ask the candidate's `claim`, `claim_type`, `hedged`, `worth`, and `attention_*` questions again on each stored state. Memory questions are excluded.
2. Apply the candidate flag rule.
3. Count how many items in each set it flags: `G'`, `F'`, `M'`.

*Decision.*
- Promote when `G' ≥ floor(0.9 × |G|)` and either `F' < |F|` or `M' > 0`. Otherwise reject.
- Re-asked calls use the background settings and count against the budget.
- Record both outcomes in `s1_versions.jsonl` with their metrics and rationale.
- A promoted version applies from the next utterance.
- `POST /api/s1/rollback` may restore `s1@1` or any promoted version, never a rejected candidate.
- The active version id is recorded in `session.json` at start and in every `s1.version` event, including rollbacks.
- Every session starts from `s1@1` in the file; in v1, versions do not carry over between sessions.
- A grade counts toward the version that was active when its claim was flagged.

**Done when:** unit tests with fake Jev and fake System 2 cover:
- the audit trigger and the miss rule;
- the rewrite trigger and cooldown, including that memory changes do not reset the count;
- the per-op field rules and every rejected change (wrong fields, keys, level count, range, length, more than 3 changes);
- the gate arithmetic, with one promote case and one reject case;
- the promoted version applying from the next utterance;
- rollback keeping the memory set.

#### §4.9 Timeline labels

`config/labels.default.json` has this JSON shape. Question objects are exactly the Decisions API shapes from §2.2.

```json
{ "prefix": "Judge only segment; previous_segment is context only.",
  "boundary": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } },
  "questions": { "subject": { "type": "choice", "instructions": "…", "criteria": { "ai_models": "…" } } },
  "story": { "instructions": "Which of tonight's stories is the current segment about?", "none": "None of these stories." } }
```

Code rules for this file:
- **Prefix.** At request time, `prefix` plus a space is prepended to the instructions of every timeline question, meaning every `questions.*` entry and the generated `story` question. It is never prepended to `boundary`, which is asked per utterance (§4.7) against `{ current_segment, new_utterance }`.
- **Story question.** When `timeline.stories` is non-empty, code adds a `story` choice. Its criteria are `s1`…`sN`, mapped to the typed headlines, plus `none` mapped to `story.none`.
- **Version.** The label-set version is the first 12 hex characters of SHA-256 over the canonical JSON (sorted keys) of `{ prefix, questions, story, stories }`.

**Requests.** The code lives in `src/pipeline/timeline.ts`. The state is `{ "previous_segment": [...], "segment": [...] }`, using the utterance shape from §4.7. Each closed segment gets one Jev request (`purpose: "segment"`, up to `jev.segmentConcurrency` in parallel, timeout `segmentTimeoutMs`). If it fails, the segment is marked `unlabeled` and can be relabelled later.

The default content, with every timeline instruction getting the prefix:

```yaml
boundary: noul "The new_utterance moves on to a different point or subject than current_segment, rather than continuing, elaborating, answering, or reacting to it."
  criteria: { true: "It starts a new topic, a new story, or a clearly different point.",
              false: "It continues, adds detail to, answers, jokes about, or reacts to the preceding discussion." }
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
  other: None of the above
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
- `PUT /api/labels` takes the same JSON shape, validates it (§4.2 rules), and activates it from the next segment. It returns 409 if `boundary` differs from the active one: the boundary question is calibrated (§4.12), so changing it needs a config edit and a restart.
- `POST /api/labels/relabel` asks the active set again on closed segments, in the background.

**Done when:**
- Tests cover state building, the marker and faded rules, sections, mentions, config replacement, and relabelling.
- In the fixture replay, the surfing lines are labelled `subject: personal_life` or `other_topics`.

#### §4.10 Session orchestration, store, events, API, replay

**`src/pipeline/session.ts`** wires the pipeline together: sources → VAD → tags → speakers → transcription → segmenter → timeline and fact-checker → store and events. At end of input, in order:
1. Flush every VAD (§4.3).
2. Wait for transcription and the segmenter to drain.
3. Close the open segment (`forced: false`, `final: true`) and label it.
4. Drain research, audits, and rewrites for at most 180 s.
5. Emit `stats` and `session.ended`.

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
| Fact-check | `claim.flagged`, `claim.duplicate`, `claim.repeat`, `claim.researching`, `claim.verdict`, `claim.dropped`, `claim.disputed`, `audit`, `s1.version`, `s1.memory` |
| Accounting | `cost` (running totals for transcription, Jev, and System 2), `budget.exhausted`, `stats` (§4.12), `error` |

**`src/server/main.ts`** uses Node's `http` module, no framework, and binds to 127.0.0.1 only:

| Method | Route | Body / purpose |
| --- | --- | --- |
| GET | `/api/events` | SSE; replays the session's events so far on connect |
| GET | `/api/state` | Full current state |
| POST | `/api/session/start` | `{ mode: "replay", dir, speed }`; Tier 2 adds `{ mode: "live", mic? }` (§4.14b) |
| GET | `/api/devices` | Tier 2: input devices from the capture helper (§4.14b) |
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
4. Send 50 sequential worst-case per-utterance requests: boundary plus `s1@1` plus 3 synthetic `attention_` questions plus `maxKnownQuestions` synthetic `known_` questions (48 questions at the default of 40). Use the live timeout (`utteranceTimeoutMs`) and a single attempt with no retry. Report p50 and p95. FAIL if more than 2 of the 50 exceed `utteranceTimeoutMs`, or if p95 is above 1,500 ms. On the first FAIL, set `maxKnownQuestions` to 20 and rerun this check once.

Checks 2, 3, 5, and 6 use the background settings (§2.5).
5. Research "Jev is 445 times cheaper than GPT" with the configured web engine. The verdict is schema-valid with ≥ 1 source; report latency and cost. Then try `engine: "native"` once and print whether it works, without changing config.
6. Send one audit call and one rewrite call with canned inputs. Both are schema-valid.

**Done when:** all checks pass and total cost is ≤ $0.50.

**Stop and ask if:**
- Check 4 fails again after the rerun with `maxKnownQuestions` at 20. The alpha endpoint would be too slow for live use. The fallback, TypeSafe's direct API (§2.5), needs a TypeSafe key and the user's approval.
- Check 5 fails with both engines.

#### §4.12 Stats and calibration

**`src/pipeline/stats.ts`** emits `stats` every 60 s and at session end:
- Off-topic index (renamed from an earlier working name): the share of labelled segment time whose subject is `personal_life` or `other_topics`.
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

### Tier 2: live capture and front end

#### §4.13 Decision record (decided 24 September 2026; do not reopen)

The user and a design session chose the following. Copy this record (date, choice, reasons) into `README.md` under "Design decisions", then proceed.

**Architecture.** The engine owns everything smart: capture, VAD, speakers, transcription, System 1 and System 2, storage, and the HTTP and SSE API. It is the Node server from Tier 1 plus a native capture helper that the server starts as a child process. The front end is a thin client: it only reads `GET /api/state` and `GET /api/events` and posts the commands in §4.10. It could be replaced later, for example by a SwiftUI app, without touching the engine.

**Capture: a native Swift helper, `conversation-capture` (§4.14).**
- `host`: the MacBook's built-in microphone, chosen explicitly whatever the system default input is.
- `remote`: a global Core Audio tap (macOS 14.2+) of everything the Mac plays, on any output device (speakers, wired earbuds, AirPods), including a device switch mid-session.
- It works whether Riverside runs in Chrome or as the Mac app.

**Front end: a local web page served by the engine (§4.15)**, in plain TypeScript compiled with `tsc` to browser ES modules. No bundler, no UI framework, no new dependencies.

**Show setup assumption.** The host wears earbuds, so the microphone never hears the call. Echo cancellation is out of scope (§5). Riverside's own microphone is also set to the MacBook's built-in mic (§4.16).

**Why:**
- Browser capture (the former option A) tied the engine to a Chrome tab that had to be re-picked every session and could be closed or throttled.
- AudioTee (the former option B) captures system audio only, not the microphone. One helper that captures both streams gives them a single clock.
- A global tap, rather than one app's output, is independent of the output device and of which Riverside client is used. Notification sounds are handled by the show checklist (Focus mode).
- Chrome's system audio (option C) and BlackHole (option D) had the risks listed in `BACKGROUND.md`.
- A local web page needs nothing installed, runs in any browser, and can be shared as a window in Riverside.

**Done when:** the record is in `README.md`.

#### §4.14 Live capture: the Swift helper and its Node adapter

##### §4.14a `native/capture/`: the `conversation-capture` helper

**Package.** A Swift package (Swift 6, `platforms: [.macOS(.v14)]`) with one executable target, `conversation-capture`. It uses Apple frameworks only (CoreAudio, AudioToolbox, AVFoundation) and no package dependencies. Files:
- `native/capture/Package.swift`
- `native/capture/Info.plist`: `CFBundleIdentifier` `com.cloudlesslabs.conversation-capture`, `NSMicrophoneUsageDescription`, and `NSAudioCaptureUsageDescription`. Embed it in the binary with `linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Info.plist"])]`, as AudioTee does. Without it, macOS refuses the capture permissions.
- `native/capture/Sources/conversation-capture/`: `main.swift` (arguments, stdout writer, stderr status), `Mic.swift`, `SystemTap.swift`, `Devices.swift`, and `ClockLock.swift`.

`npm run build:capture` runs `swift build -c release --package-path native/capture`. The binary is `native/capture/.build/release/conversation-capture`.

**Command line.**

| Invocation | Does |
| --- | --- |
| `conversation-capture --list-devices` | Prints input devices as JSON lines `{ uid, name, transport, isDefault }` and exits. |
| `conversation-capture [--mic builtin\|<uid>] [--no-mic] [--no-system]` | Captures until stdin closes or SIGTERM. Default `--mic builtin`. |
| `conversation-capture --probe <seconds>` | Captures without writing frames, then prints one JSON line `{ host: { peakDbfs, rmsDbfs }, remote: { peakDbfs, rmsDbfs } }` and exits. Used by `capture:test` and preflight. |

**Microphone (`Mic.swift`).**
- Resolve the device: `builtin` is the input device whose `kAudioDevicePropertyTransportType` is `kAudioDeviceTransportTypeBuiltIn`; otherwise match by UID. If it is missing, exit with code 2 and a status line.
- Capture with `AVAudioEngine`: set the device on `inputNode.audioUnit` through `kAudioOutputUnitProperty_CurrentDevice` before starting, and install a tap on the input node.
- Voice processing stays off: no echo cancellation, AGC, or ducking.
- Downmix to mono (channel 0 if the device is multichannel).

**System audio (`SystemTap.swift`).**
- `CATapDescription(monoGlobalTapButExcludeProcesses: [])`, with `isPrivate = true` and `muteBehavior = .unmuted`. Create it with `AudioHardwareCreateProcessTap`.
- Wrap it in a private aggregate device (`AudioHardwareCreateAggregateDevice`) whose tap list holds the tap and whose main sub-device is the current default output device. This follows Apple's "Capturing system audio with Core Audio taps" sample and AudioCap. Read buffers with an IOProc.
- Listen for `kAudioHardwarePropertyDefaultOutputDevice` changes, for example when AirPods connect. On a change, destroy and rebuild the aggregate device and emit a status line; ClockLock fills the gap.
- On exit (normal, SIGTERM, or SIGINT), destroy the aggregate device and the tap.

**Conversion.** Convert each stream with `AVAudioConverter` to 16 kHz mono, then to PCM16 little-endian.

**ClockLock (`ClockLock.swift`).**
- The session clock starts at zero when capture starts, measured with `mach_absolute_time`.
- Each buffer's first sample is timestamped from its `AudioTimeStamp.mHostTime`, converted to session milliseconds.
- For each stream, keep the number of samples emitted within 20 ms of elapsed host-clock time: insert silence when the stream falls behind (dropped buffers, a device rebuild) and drop samples when it runs ahead.
- As a result, sample index / 16 = session milliseconds on both streams. This is what §4.3's `startMs = streamStartMs + seg.start / 16` relies on, and it keeps both streams aligned over an hour despite separate hardware clocks.

**Stdout protocol.** Binary frames only, little-endian, no text:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic `PCAP` (ASCII) |
| 4 | 1 | stream: `0` = host, `1` = remote |
| 5 | 3 | reserved, zero |
| 8 | 8 | `sessionMs` of the first sample (float64) |
| 16 | 4 | sample count `n` (uint32) |
| 20 | 2n | PCM16 mono samples at 16 kHz |

Emit a frame about every 100 ms per stream (1,600 samples).

**Stderr protocol.** One JSON object per line: `{ "type": "started", "epochMs", "host": { device }, "remote": { outputDevice } }`, `{ "type": "device_changed", ... }`, `{ "type": "warning" | "error", "message" }`. `epochMs` is the wall-clock time of session clock zero.

**Permissions.** macOS asks once for Microphone and once for System Audio Recording. When the helper is started from a terminal (directly or through Node), the permission is attributed to that terminal app. A denied permission delivers silence rather than an error, so `capture:test` and preflight detect it by level (below).

**`npm run capture:test`** (`scripts/capture-test.sh`) checks the helper on this Mac, printing PASS or FAIL for each:
1. `--list-devices` lists a built-in input device.
2. System audio: run `--probe 3` while `afplay /System/Library/Sounds/Ping.aiff` plays twice. `remote.peakDbfs > -40`. A FAIL says: "grant System Audio Recording to your terminal in System Settings → Privacy & Security".
3. Microphone: `--probe 3` while the host says a sentence. `host.peakDbfs > -40`. On FAIL, the Microphone permission hint.
4. Isolation, with earbuds in: `--probe 5` while a video plays and the host stays silent. `host.rmsDbfs < -55`. This confirms that the mic does not hear the system audio.

**Done when:** `npm run build:capture && npm run capture:test` passes on the user's Mac.

**Stop and ask if:** the tap delivers silence after the permission is granted, or the helper cannot select the built-in mic.

##### §4.14b `src/audio/nativeSource.ts`: the Node adapter

- `startNativeCapture({ mic, host, remote })` spawns the helper with `child_process.spawn`, parses stdout frames (buffering partial reads), and returns two `AudioSource`s (§4.3) that re-chunk into 512-sample Float32 frames. Each frame's `sessionMs` is the helper's `sessionMs` plus the sample offset / 16, plus `offsetMs`.
- `offsetMs` is `started.epochMs − session start epochMs`, so helper time maps onto the session clock. It is recomputed after a restart.
- A malformed frame (bad magic, impossible count) kills the helper and is handled as a crash.
- Stderr status lines become `health` details and, for `warning` and `error`, `error` events with `component: "capture"`.
- If the helper exits unexpectedly, restart it up to 3 times per session, 1 s apart, and emit an `error` event each time. The gap stays in the recording as silence. After the third failure, end the live source cleanly: flush the VADs as at end of stream, and keep the session running for what is already in flight.
- On session stop, close the helper's stdin, send SIGTERM after 2 s, and SIGKILL after 5 s.
- The session store records each stream to `host.wav` and `remote.wav` as received (§4.10), so a live session replays exactly.
- `POST /api/session/start` gains `{ mode: "live", mic?: "builtin" | "<uid>" }`, and `GET /api/devices` returns the helper's `--list-devices` output. There is no browser audio upload route.

**Done when:**
- A unit test feeds recorded stdout bytes (split at awkward boundaries) through the parser and checks the frames, `sessionMs`, and malformed-frame handling. A fake child process covers the restart rule. No test spawns the real helper.
- A 2-minute live test with a co-host on Riverside:
  - produces utterances on both streams;
  - shows transcripts within 3 s (p90) of each utterance ending;
  - leaves a session folder that replays.

**Stop and ask if:** the remote stream contains the host's own voice (Riverside playing it back, §6 row 2).

#### §4.15 Front end: a local web page

**Build and serving.**
- Files: `web/index.html`, `web/styles.css`, `web/tsconfig.json`, and `web/src/*.ts`.
- `web/tsconfig.json`: `target` and `module` `ES2022`, `lib` `["ES2022", "DOM"]`, `outDir` `web/dist`. Imports use relative `.js` specifiers so browsers load the output as-is.
- `npm run build:web` runs `tsc -p web/tsconfig.json`. `npm run serve` builds first.
- `src/server/main.ts` serves `web/index.html` at `/` and `web/styles.css` and `web/dist/**` as static files, with correct content types, confined to `web/` (no path traversal).
- No bundler, no framework, and no chart library: the timeline is inline SVG.
- Session controls: start live (with a mic picker from `GET /api/devices`), start replay, and stop.

**Requirements.** Everything comes from `GET /api/state` plus `GET /api/events`.

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
- the capture helper is built, and `conversation-capture --probe 3` during an `afplay` ping shows system audio and a non-silent mic (the permissions are granted);
- the keys are set;
- the config is valid;
- the OpenRouter key's limit and remaining credit (`GET https://openrouter.ai/api/v1/key`);
- one call each to transcription, Jev, and System 2 (about $0.02);
- at least 2 GB of free disk.

**`docs/rehearsal.md`** contains:
- The pre-show checklist:
  - everyone wears headphones, and the host wears earbuds (the spec assumes it: no echo handling);
  - Riverside's microphone is set to the MacBook's built-in mic, like the helper's. If any app opens the AirPods mic, macOS switches the AirPods to the low-quality call profile;
  - a Focus mode is on and other apps are quiet, because the tap captures every sound the Mac plays;
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
- No OpenAI diarization model: its speaker labels hold only within one request, and the pipeline sends one request per utterance. No OpenAI realtime transcription in v1; reconsider realtime only if the user wants live word-by-word text.
- No multi-language support, video, clip export, social posting, cloud deployment, or authentication (the server binds to 127.0.0.1).
- No integration with Riverside beyond reading exported tracks for calibration.
- No echo cancellation or speaker-output setup. The host wears earbuds (§2.1). With speakers, the mic would also pick up the call and duplicate it on the `host` stream.
- No browser-based capture, and no per-app audio filtering: the tap captures all system output.
- No database. Storage is session folders of plain files (§4.10).
- No fine-tuning or model training beyond speaker enrolment.
- No changes to the private jev-xp research repository.

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
| --- | --- | --- |
| 1 | Resolved on 24 September 2026: the Swift capture helper and a local web page (§4.13). | Follow the record; do not reopen it. |
| 2 | Unknown whether Riverside plays the host's own voice back, which would put it in the system audio. | Check in the §4.14 live test; stop if the host's voice is in `remote`. |
| 3 | Per-utterance Jev latency with 5–48 questions is unmeasured. Small requests measured p95 838 ms. | Follow smoke check 4 and its stop rule (§4.11). |
| 4 | OpenRouter's Decisions endpoint is alpha. A third party reported about 15% of calls hanging; this Mac saw 0 failures in 10,120 calls. | Short timeouts, one retry, the boundary fallback. Stop per §4.11 if timeouts exceed the limit. |
| 5 | Unconfirmed whether the web plugin works together with strict `json_schema` and reasoning on GPT-6 Luna, and which engine is better. | Smoke check 5. If strict output fails with the plugin, retry with `response_format: { type: "json_object" }` and a zod parse. If that also fails, stop and ask. |
| 6 | The exact multipart encoding of `keywords` and `languages` for `gpt-transcribe`. | The §4.5 fallback, then stop. |
| 7 | `sherpa-onnx-node`'s README says macOS needs `DYLD_LIBRARY_PATH`. macOS strips `DYLD_*` variables when a program starts through a `/usr/bin/env` shebang, which is how `tsx` and `vitest` start. Neither `Vad.flush()` nor the `maxSpeechDuration` key is confirmed in the Node typings; the C++ default for maximum speech duration is 20 s. | Follow the §4.1 loading test. Feature-detect `flush`. If `maxSpeechDuration` is ignored, split long utterances in code at 20 s. |
| 8 | Speaker-ID accuracy on short utterances and through Riverside's audio codec. | Calibrate (§4.12, §4.16). Inferred speakers are marked, and rename and merge exist. |
| 9 | Jev's accuracy on casual, sarcastic speech for `disagreement`, `hype`, and `heat` is unmeasured. | Thresholds live in config, low-confidence labels are faded, and you calibrate on an old episode. |
| 10 | System 2 verdicts can be wrong on air. Jev answers are not bit-reproducible, so the gate compares a re-asked candidate with the incumbent's recorded outcomes. | Show sources; provide the host dispute button and rollback. |
| 11 | Native web search price through OpenRouter is passed through and not listed. | Log `usage.cost`; cap research by count. |
| 12 | Unknown whether `gpt-transcribe` returns usage. | Estimate cost from audio seconds and mark it `estimated`. |
| 13 | The user has not chosen a privacy setting for podcast content sent to OpenRouter, TypeSafe, and OpenAI (§2.5). | Use account defaults for development with fixtures. Ask the user before the first session with real voices whether to add `provider: { data_collection: "deny" }` to OpenRouter calls. |
| 14 | Core Audio tap details on macOS 26: the aggregate-device rebuild when the output device changes, and whether a denied permission always yields silence. | Follow Apple's tap sample and AudioCap; `capture:test` and preflight check by level. Stop per §4.14a. |
| 15 | Whether a command-line helper with an embedded Info.plist gets the System Audio Recording prompt when started through Node from a terminal. AudioTee reports that it does. | `capture:test` step 2; stop and ask if no prompt appears and the tap stays silent. |

## §7 Anti-hallucination guardrails

1. **Dependencies.** Runtime: `sherpa-onnx-node` (^1.13.8) and `zod` (^4). Dev: `typescript`, `tsx`, `vitest`, `@types/node`. Anything else, such as `ws`, a bundler, or UI libraries, needs the user's approval; §4.13 approved none. No OpenAI or OpenRouter SDKs; use `fetch`. The Swift helper uses Apple frameworks only, with no Swift package dependencies. The front end is compiled by the `typescript` dev dependency.
2. **Files.** Only the files named in §4 and §A, plus tests under `tests/`.
3. **Call paths.** Jev only through `src/jev/client.ts`, never through chat completions. System 2 only through `src/factcheck/s2.ts`.
4. **Jev state.** Speaker display names, text, and tags only. No timestamps, ids, costs, or scores.
5. **System 2's reach.** It may change only the fact-check System 1 set, only through the §4.8 ops. Never `boundary`, never timeline labels, never thresholds outside their ranges, never budgets.
6. **Logging.** Every external call is logged with purpose, latency, attempts, and cost. Keys never appear in any log, event, or file.
7. **Budgets.** Every external call goes through `src/budget.ts`: `assertCanSpend` before the call, `record` after. Never bypass it, and never raise a cap without the user.
8. **Network.** Tests never call the network. Live calls happen only in `smoke`, `replay`, `serve`, `preflight`, and the calibration CLIs.
9. **Commits.** Commit only with the user's §0 yes, one conventional commit per §4 task. Never commit `models/`, `fixtures/`, `sessions/`, or `.env`.
10. **Scope.** Do not push, deploy, or open pull requests, and do not edit `specs/`. If this spec has a gap, stop and tell the user instead of patching it.

## §8 Verification commands

```bash
# Environment
node --version            # v24.x
sw_vers -productVersion   # 26.x
say -v '?' | grep -E '^(Samantha|Daniel|Karen) '
git status                # on master, remote origin; do not touch uncommitted edits under specs/

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

# Live capture (Tier 2; earbuds in)
npm run build:capture && npm run capture:test
native/capture/.build/release/conversation-capture --list-devices
npm run serve   # then open http://127.0.0.1:4317 and start a live session

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
| `host` / `remote` stream | The host's microphone (the MacBook's built-in mic) / the Mac's system audio, all output on any device, which carries the Riverside call (co-hosts and guests). |
| Capture helper | `conversation-capture`, the native Swift tool that captures both streams and pipes framed PCM to the engine (§4.14a). |
| Core Audio tap | A macOS 14.2+ API that captures audio that processes play, before it reaches an output device, without a driver. |
| ClockLock | The helper's rule that keeps each stream's sample count aligned with the host clock (§4.14a). |
| Engine | The Node server plus the capture helper: everything except the front end. |
| Utterance | A stretch of speech between pauses, cut by VAD, with one speaker and one transcript. |
| Filler | A short utterance such as "yeah" that skips the per-utterance Jev request. |
| Segment | Consecutive utterances making one point, closed by the boundary rule. The unit the timeline labels. |
| Section | Consecutive segments with the same subject. |
| System 1 version | An immutable fact-check question set plus its three thresholds (`s1@N`), of kind `default` or `criteria`. Memory questions sit outside versions. |
| Flag / good flag / false alarm / miss | System 1 marks a claim / System 2 confirms it was worth checking / System 2 finds it was not a checkable claim / an audit finds an unflagged claim. |
| Memory question | `known_<claimId>`: recognises a repeat of a claim already queued or checked. |
| Attention question | `attention_<n>`: a noul question that System 2 adds to prioritise a kind of claim. |
| Replay gate | Asking a candidate System 1 set again on logged states, and promoting it only if it fixes errors without losing good flags. |
| Off-topic index | The share of the show spent on `personal_life` and `other_topics`. |
| Speed `max` / `1` | Replay as fast as possible / at real-time pace. |

## §10 References

**In this folder:** `BACKGROUND.md` covers why each decision was made, the rejected alternatives, the measured numbers, and the capture research. It is optional.

**Design background and integration references** (read-only), in the private jev-xp research repository. The section-by-section map is at the end of §2.5.
- `specs/260922-01-xp/openrouter-integration.md`: the authoritative OpenRouter, Jev, and GPT-6 Luna integration reference.
- `specs/260922-01-xp/models-research.md`: Jev's operational facts.
- `specs/260922-01-xp/jev-as-primitive.md`: Jev's value proposition, the hallucination claim, confidence, and calibration.
- `src/policy/jevClient.ts`: a working Decisions client built on the OpenRouter SDK. See `sdkTransport` (line 47), `classifyError` (line 77), `backoffMs` (line 107), and `JevClient` (line 142).
- `src/s2/researcher.ts`: `sdkS2Transport` (line 52), GPT-6 Luna calls with provider pinning.

**External**, verified 24 September 2026:
- Jev: [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request), [TypeSafe primitives](https://docs.typesafe.ai/primitives), [TypeSafe models and limits](https://docs.typesafe.ai/models), [TypeSafe confidence](https://docs.typesafe.ai/confidence).
- OpenRouter: [web search](https://openrouter.ai/docs/guides/features/plugins/web-search), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
- OpenAI: [speech to text](https://developers.openai.com/api/docs/guides/speech-to-text), [gpt-transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe), [realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) (a non-goal).
- sherpa-onnx: [Node examples](https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples) (`test_speaker_identification.js`, `test_vad_microphone.js`); npm `sherpa-onnx-node` 1.13.8, with a darwin-arm64 build.
- Core Audio taps: [Apple, Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps), [`CATapDescription`](https://developer.apple.com/documentation/coreaudio/catapdescription).
- Capture options considered for §4.13: [AudioTee](https://github.com/makeusabrew/audiotee), [AudioCap (Core Audio taps)](https://github.com/insidegui/AudioCap), [Chrome system audio on macOS](https://blog.addpipe.com/getdisplaymedia-allows-capturing-the-screen-with-system-sounds-on-chrome-on-macos/), [Riverside supported browsers](https://support.riverside.com/hc/en-us/articles/5252134218013-System-requirements-and-supported-browsers), [browser VAD alternative](https://docs.vad.ricky0123.com/user-guide/browser/).

### §A Anchors (the Tier 1 file set)

```
package.json, tsconfig.json, vitest.config.ts, .env.example, README.md   scaffold (§4.1)
config/app.json                                  thresholds, caps, models (§4.2)
config/labels.default.json                       boundary + timeline questions (§4.9)
config/factcheck.s1.default.json                 s1@1 question set (§4.8)
src/config.ts                                    config loading (§4.2)
src/budget.ts                                    shared spending ledger and caps (§4.6)
tests/setup.ts                                   disables the network in tests (§4.1)
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
LICENSE                                          MIT (§4.1)
```

Tier 2 adds:

```
native/capture/Package.swift, Info.plist         capture helper (§4.14a)
native/capture/Sources/conversation-capture/{main,Mic,SystemTap,Devices,ClockLock}.swift
scripts/capture-test.sh                          capture checks (§4.14a)
src/audio/nativeSource.ts                        helper adapter (§4.14b)
web/{index.html,styles.css,tsconfig.json}, web/src/*.ts   front end (§4.15)
```

Tier 3 adds:

```
docs/rehearsal.md                                (§4.16)
```
