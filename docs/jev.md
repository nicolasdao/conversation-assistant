---
description: What Jev is, how its Decisions API works (question types, answers, confidence, limits, price), and every place this project asks it a question — per utterance, per segment, in the replay gate — with the client's retry and budget rules.
tags: [jev, typesafe, openrouter, decisions-api, system-1, llm]
source:
  - src/jev/client.ts
  - src/jev/types.ts
  - src/pipeline/segmenter.ts
  - src/pipeline/timeline.ts
  - src/factcheck/gate.ts
  - config/timeline.json
  - config/labels/**
  - src/labels/model.ts
  - src/labels/legacy.ts
  - src/labels/try.ts
  - src/labels/assist.ts
  - config/factcheck.s1.default.json
---

# Jev

Jev is TypeSafe AI's decision model, which TypeSafe calls a "System One" model. It does not write text. You give it a **state** (any JSON: a string, an object, or an array) and a set of **typed questions** about that state; it returns one typed answer per question, each with probabilities. This project uses Jev as its fast, cheap, always-on judgment layer: roughly two thousand typed judgments an hour of show, for cents.

The idea the project demonstrates: ordinary software should call a model for **bounded judgments** — "is this a checkable claim?", "is this a new topic?" — instead of asking a chat LLM to behave like a program. Jev is a developer primitive: its value reaches people when software composes its answers, as this app does.

## The API

This project calls Jev through OpenRouter's Decisions API (alpha), pinned to `typesafe/jev-1.13`:

```http
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
X-OpenRouter-Title: Tattle

{ "model": "typesafe/jev-1.13",
  "state": { ... },
  "questions": { "<snake_case_id>": { "type": "noul" | "choice" | "score", "instructions": "...", "criteria": ... } },
  "provider": { "data_collection": "deny" } }
```

The response carries `answers` (one per question id), `id`, `model` (the resolved snapshot — currently `typesafe/jev-1.13-20260917`), `provider` (`TypeSafe`), and `usage: { input_tokens, output_tokens, cost }`. The raw HTTP API uses snake_case.

### Question types

| Type | Question shape | Answer shape | Used for |
| --- | --- | --- | --- |
| `noul` | `{ type, instructions, criteria?: { true, false } }` | `{ type: "noul", noul: p }` — `p` is the probability of yes | Yes/no judgments: `boundary`, `claim`, `hedged`, memory questions, and a label set's markers (`disagreement`, `clip_worthy`…) |
| `choice` | `{ type, instructions, criteria: { label: description } }` | `{ choice, confidence, probabilities }` | Picking one of your labels: `claim_type`, a label set's categories (`subject`, `mode`), `story` |
| `score` | `{ type, instructions, criteria: [levels, lowest first] }` | `{ score, confidence, probabilities, legend }` — `score` is the probability-weighted level index, 0 to n − 1 | Graded judgments: `worth`, and a label set's scores (`heat`, `hype`) |

### A real exchange from this project

The repeated fixture line "Jev is 445 times cheaper than GPT." (a planted test statement for the fact-checker, not a claim of this project) as the per-utterance request sent it (session `20260925-133413`, abridged to the fields shown):

```json
"state": {
  "current_segment": [ { "speaker": "Speaker 1", "text": "According to the launch post, Jev can never hallucinate.", "tags": [] } ],
  "new_utterance":   { "speaker": "Speaker 2", "text": "Jev is 445 times cheaper than GPT.", "tags": [] }
},
"question_ids": ["boundary", "claim", "claim_type", "hedged", "worth", "known_c_1", "known_c_2"]
```

Answers:

```json
"boundary":   { "type": "noul", "noul": 0.79 },
"claim":      { "type": "noul", "noul": 0.9 },
"claim_type": { "type": "choice", "choice": "number_or_price", "confidence": 1,
                "probabilities": { "number_or_price": 1, "date_or_release": 0, "none": 0, "...": 0 } },
"hedged":     { "type": "noul", "noul": 0.02 },
"worth":      { "type": "score", "score": 2.26, "confidence": 0.67,
                "probabilities": { "0": 0, "1": 0.06, "2": 0.67, "3": 0.21, "4": 0.06 },
                "legend": { "0": "No factual claim, or trivial", "2": "Relevant to the discussion", "...": "..." } },
"known_c_1":  { "type": "noul", "noul": 0.77 },
"known_c_2":  { "type": "noul", "noul": 0.02 }
```

`usage`: 1,045 input tokens, 184 output tokens, $0.0000439; 778 ms, one attempt. What code did with it: `known_c_1` ≥ 0.6 linked the line to claim `c_1` as a **repeat** instead of flagging it again; `boundary` 0.79 did **not** close the segment, because the open segment was 3.5 s long and a segment must reach 12 s first. `worth` 2.26 is the probability-weighted level index (0.06×1 + 0.67×2 + 0.21×3 + 0.06×4 ≈ 2.27 from the rounded probabilities shown).

### How to read the answers

- **Every question is answered independently and in parallel**, against the same state. One question cannot see another's answer, so each question must stand on its own ("Judge only new_utterance." opens every System 1 question for that reason).
- **A `choice` always picks one of your options.** Every choice here has a fallback option (`none`, or a key starting with `other`); config validation rejects a choice without one.
- **`confidence` measures ambiguity among your options**, not "none of these fit". A 0.99 `subject` means the probabilities are concentrated, not that the segment is certainly about AI models.
- **Answers are not bit-reproducible**, and there is no temperature or seed. The same request can return 0.76 one run and 0.86 the next; thresholds need margin (see [Gotchas](gotchas.md)).
- **Jev is weak at numbers, counting, and dates**, and most accurate in English. This project never asks it to count, do arithmetic, compare timestamps, or name speakers: code does all of that.
- **Write one narrow judgment per question**, with snake_case ids and concrete `criteria.true` / `criteria.false` when the boundary is fuzzy. A memory question without criteria scored a verbatim repeat 0.55; with criteria, ~0.86.

### Limits and price

| Item | Value |
| --- | --- |
| Tokens per request | At most 32,000 for state plus all questions |
| Options per `choice` | Up to 255 |
| Levels per `score` | 2–10 accepted (2–6 recommended); this project uses 5 |
| States per request | One — there is no endpoint that takes several states |
| Price | $0.042 per million input tokens; output is free |

Calibration reported by OpenRouter (Banking77): 96.3% accuracy on the 58% of inputs where confidence ≥ 0.99, and 85% of errors had confidence below 0.90.

## Where this project asks Jev

| Purpose | When | State | Questions | Settings |
| --- | --- | --- | --- | --- |
| `utterance` | Every non-filler utterance, in time order (`src/pipeline/segmenter.ts`); with fact-checking off, `boundary` only; with fact-checking and labels both off, never | `{ current_segment, new_utterance }` | `boundary` + the active System 1 set (`claim`, `claim_type`, `public`, `hedged`, `worth`, 0–3 `attention_*`) + memory questions (0–40 `known_*`) → 6 to 49 questions | Live: 3 s timeout, 2 attempts |
| `segment` | Each closed segment (`src/pipeline/timeline.ts`); never when labels are off | `{ previous_segment, segment }` | The session's label set: one question per label (10 in the built-in set), plus `story` when stories are set | Live: 5 s timeout, 2 attempts; up to 4 in parallel |
| `relabel` | `POST /api/labels/relabel` | Same as `segment` | The session's label set | Background: 30 s timeout, 5 attempts |
| `try` | **Try on a recording** (`src/labels/try.ts`): a draft label set, on the segments that start in a recording's first 10 minutes (40 at most) | Same as `segment` (speakers by their current names) | The draft's questions | Background: 30 s timeout, 5 attempts; 4 in parallel |
| `gate` | Replay gate for a System 1 rewrite (`src/factcheck/gate.ts`) | The logged `utterance` states of graded flags and audit misses (up to 300) | The candidate System 1 set only (no `boundary`, no memory) | Background |
| `preflight`, `smoke` | Pre-show and development checks | Fixture text | `boundary` + `s1@1`; the built-in label set; a 48-question worst case | Background, or as each check states |

The **state never contains timestamps, ids, costs, or scores** — only display names, text, and tags (`loud`, `overlap`). Each utterance in a state has the shape `{ speaker, text, tags }`; failed transcriptions are left out, fillers are kept. Because display names are resolved when each request is built, renaming a speaker changes what Jev sees from the next request on.

### The boundary question (per utterance)

```text
boundary (noul): The new_utterance moves on to a different point or subject than current_segment,
  rather than continuing, elaborating, answering, or reacting to it.
  true:  It starts a new topic, a new story, or a clearly different point.
  false: It continues, adds detail to, answers, jokes about, or reacts to the preceding discussion.
```

It is a **comparison**, not "is this a complete idea?", because Jev reads questions literally. Code turns it into segments (`src/pipeline/segmenter.ts`):

1. A filler skips Jev and joins the open segment. A failed transcription skips Jev and adds no text; if a later retry recovers it, the text reaches the transcript and the chat only, never Jev (see [Transcription](transcription.md#final-layer--srctranscribeopenaits)).
2. If adding the utterance would make the segment longer than `maxSegmentMs` (75 s), the segment closes first, marked `forced`.
3. Otherwise the segment closes before the utterance when `boundary ≥ boundaryThreshold` (0.6) **and** the segment is already at least `minSegmentMs` (12 s) long. The threshold drops by `speakerChangeBonus` (0.1) when the speaker changes after a gap of at least `speakerChangeGapMs` (1.5 s).
4. If the Jev call fails, `boundary` counts as 0 (the segment stays open) and fact-checking is skipped for that utterance.

A session started with fact-checking and labels both off never asks Jev (see [Architecture](architecture.md#features-transcript-only-sessions)). Its segments close by code alone: at a pause of at least `pauseBoundaryMs` (2 s) once the segment is 12 s long, or forced before 75 s.

The boundary question lives in `config/timeline.json`, with the wording of the `story` question, and is the same for every label set. It is **locked**: its threshold is calibrated (`npm run calibrate:boundary`), so no set and no command changes it.

### The timeline questions (per segment): label sets

Since 29 September 2026 the timeline's labels come from a **label set** (`src/labels/model.ts`), chosen when a session starts and fixed for its run. A set is data, validated by one zod schema:

| Part | Limit | Asked as | Shown as |
| --- | --- | --- | --- |
| **Categories** | 0–2 | `choice`: each option's `description` is its criterion; 2–255 options, one of them a fallback (`none` or `other…`) | One lane each (options in their `color`); the first also draws the section brackets. `group` puts options together in the filter (the built-in "AI"); an optional `index` turns some options' share of time into Insights' big number |
| **Scores** | 0–2 | `score` with exactly 5 `levels`, so every score shares the chart's 0–4 axis | One chart line each, coloured by slot (first `--heat`, second `--hype`) |
| **Markers** | 0–8 | `noul`, with optional `criteria.true` / `false` | A pin with the marker's `icon` (one of the 30 in `web/src/icons.ts`) when Jev's answer reaches its own `threshold`; `perSpeaker` counts it per speaker in Insights, `list` lists it there |

A set also holds `name`, `description`, the `prefix` put before every instruction ("Judge only segment; previous_segment is context only." in the built-in set), `fadedBelowConfidence`, and the `companies` spotted by code. Ids are snake_case and unique across the set; `story` and `boundary` are reserved. At least one label is required.

The built-in set, `config/labels/ai-podcast.json` (read-only, id `ai-podcast`):

| Id | Kind | Asks |
| --- | --- | --- |
| `subject` | category | What the segment is mainly about: `ai_models`, `ai_tools`, `ai_industry` (group AI), `tech`, `marketing`, `personal_life`, `other_topics`, `the_show`. Its index, **Off-topic**, is `personal_life` + `other_topics` |
| `mode` | category | What the speakers are doing: `news`, `analysis`, `personal_story`, `explainer`, `banter`, `transition`, `other` |
| `heat`, `hype` | score | Calm → Very heated; Very skeptical → Very enthusiastic |
| `disagreement` (per speaker), `hot_take`, `prediction` (listed), `recommendation` (listed), `clip_worthy` (listed), `humour` | marker, at 0.7 | Whether each happens in the segment |
| `story` | choice | Generated only when tonight's stories are set: `s1`…`sN` for the headlines, plus `none` |

Its wording is byte for byte the old single set's (`tests/labels.test.ts` checks it against a copy), except `clip_worthy`: it was a score (a marker at 3 or more) and is now a yes/no marker with concrete true/false criteria.

Computed in code, not by Jev: a **marker** when its answer reaches the marker's `threshold`; `faded` for any choice with confidence below `fadedBelowConfidence`; **sections** (consecutive segments with the same non-faded option of the first category); company **mentions** (case-insensitive whole-word matches of the set's `companies`); the display `lane` (the first category's option, or its `group`). A failed segment request marks the segment `unlabeled`, and relabel can fill it later. The label set's version is the first 12 hex characters of a SHA-256 over the canonical JSON of the questions it asks (stories included). Recordings made before label sets keep their old set in `session.json`; `src/labels/legacy.ts` converts it for display (see [Recordings](recordings.md#session-folders)).

No LLM changes these labels or a set on its own: the host is System 2 for the timeline, because the timeline has no outcome signal to learn from (unlike fact-checks, whose verdicts grade the flags — see [System 1 and System 2](system1-system2.md)).

**Try on a recording** (`POST /api/label-sets/try`) shows what a draft would draw before a show: it rebuilds the recording's segments from its events, asks Jev the draft's questions about those that start in the first 10 minutes, and returns the draft's labels next to the recording's own. It works on transcript-only recordings too, whose segments were closed at pauses rather than by the boundary question. Nothing is written into the recording's folder; the calls are logged to `label-tries.jsonl` beside the recordings, so the development total counts them. It needs the OpenRouter key and is refused on air (409).

**Create with AI** (`POST /api/label-sets/assist`, `src/labels/assist.ts`) lets an LLM **draft** a set, as the mission allows: the host describes the show, `labelsAssist.model` (GPT-6 Luna, fixed in `config/app.json`, no picker) answers in strict JSON `{ reply, set }`, and the set must pass the same validation as a hand-made one (an invalid set is sent back once with its errors, then dropped with the reply kept). The system prompt carries the three kinds and their limits, the 30 icons, the wording rules above, and the built-in set as an example. Each message also carries the draft on screen, so the host's own edits win. The host reviews, edits, and saves; nothing is saved by the model. A conversation spends at most `labelsAssist.capUsd` ($1); its calls are logged to `label-assist.jsonl` beside the recordings. It needs the OpenRouter key.

## The client — `src/jev/client.ts`

`JevClient.ask(state, questions, meta)` is the only path to Jev. It makes raw `fetch` calls (no SDK) and implements the retry rules ported from jev-xp:

| Outcome | Classified as |
| --- | --- |
| No HTTP status (network error, timeout), 429, any 5xx | Retry |
| 402 whose `error.metadata.limit_source` is `openrouter_in_flight_budget` | Retry |
| HTTP 2xx whose body is an error object | Classified by the embedded `error.code`; retried when there is no code |
| 400, 401 (bad key), 403, 404, 413 | Fail |
| A response without `usage.cost` | Fail (rejected, not retried) |
| Any other 402 (credits or key limit exhausted) | Fail, and the budget is marked exhausted (`budget.exhausted` event) |

- **Live purposes** (`utterance`, `segment`) make at most 2 attempts, and the second only immediately after a no-status failure, a 5xx, or a retryable 2xx error body. A 429 or the transient 402 goes straight to the caller's fallback — a live call never waits out a backoff.
- **Background purposes** (`relabel`, `try`, `gate`, `preflight`) make up to 5 attempts with a 30 s timeout, waiting `retry-after` (seconds or an HTTP date) or `min(30 s, 1 s × 2^attempt)`, plus 0–500 ms of jitter.
- **The pause is shared.** A 429 or transient 402 on any call — live included — sets a pause, and so does every retryable failure of a background call. Every background attempt waits until that pause ends; live calls ignore it.
- **Concurrency** is shared (`jev.concurrency`, 8); live calls queue ahead of background calls.
- **Budget:** `assertCanSpend` before every call (a refused call is logged with 0 attempts and never reaches the network) and `record("jev", usage.cost)` after.

Every call writes one row to `jev_calls.jsonl`: `purpose`, `utterance_id` / `segment_id`, a 16-hex `request_hash`, the full `state` and `question_ids`, `question_set_version` (the System 1 version or label-set version), `ok`, `latency_ms`, `attempts`, the returned `id`, `model_returned`, `provider_returned`, `answers`, `usage`, `cost_usd`, and `error`. The logged states are what the replay gate re-asks. The same rows stream to the page as they complete (with the question definitions added, for display only) and fill its **Jev log** tab; `onStart` marks each call as it is sent, so the page can show System 1 thinking. Separately, `replay --export` writes each utterance's boundary probability for `calibrate:boundary`.

## Measured performance and cost

| Measurement | Value |
| --- | --- |
| 10,120 calls from this Mac (jev-xp, small requests) | 0 failures, 1 retry; p50 415 ms, p95 838 ms, p99 2.1 s |
| Smoke check 4: 50 sequential worst-case per-utterance requests (48 questions), 3 s live timeout, one attempt each | p50 349–367 ms, p95 479–518 ms, 0 timeouts |
| The 78 s fixture at speed 1 | 13 calls, all first-attempt; p50 699 ms, max 944 ms; $0.0006 total |
| One per-utterance request with 5 questions (smoke check 2) | $0.000036 |
| One segment request with 11 questions (smoke check 3) | $0.00006 |

Design estimate for a one-hour show: about 900 per-utterance and 80 per-segment requests. At the fixture's measured rate that is about $0.04 of Jev; the original design estimate, which assumed larger requests, was $0.15. Each memory question adds input tokens to every later per-utterance request, so a claim-heavy show costs more.

Related: [System 1 and System 2](system1-system2.md), [Architecture](architecture.md), [Gotchas](gotchas.md).
