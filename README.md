# Podcast Assistant

## Table of Contents

<!-- BEGIN toc -->
- [Setup](#setup)
- [Scripts](#scripts)
- [Using it](#using-it)
- [Documentation](#documentation)
- [Design decisions](#design-decisions)
- [License](#license)
<!-- END toc -->


A local app that listens to a remote podcast recording (the host's microphone plus the Mac's system audio), transcribes it live, labels the conversation on a timeline with Jev, and fact-checks claims with a System 1 / System 2 loop.

It exists to demonstrate, live on air, that software should call a decision model like Jev for bounded judgments, with a slower LLM as System 2 that improves it. Start with the [Mission](docs/mission.md), then [Architecture](docs/architecture.md), [Jev](docs/jev.md), and [System 1 and System 2](docs/system1-system2.md).

## Setup

Requires Node 24 and macOS on Apple Silicon.

```bash
npm install
cp .env.example .env && chmod 600 .env   # fill OPENROUTER_API_KEY and OPENAI_API_KEY; never commit it
npm run models                           # Silero VAD + WeSpeaker speaker-embedding models into models/
npm run fixtures                         # a scripted ~78 s test conversation into fixtures/conversation/
```

Use a dedicated OpenRouter key for this project with a credit limit (for example $10).

## Scripts

| Script | Does |
| --- | --- |
| `npm test` / `npm run typecheck` | Offline tests (no network) and type checks |
| `npm run models` | Downloads the local models |
| `npm run fixtures` | Builds `fixtures/conversation/{host,remote}.wav` and `script.json` with macOS `say` |
| `npm run smoke` | Live checks of transcription, Jev, and System 2 (measured at about $0.05); streaming text is not checked |
| `npm run replay -- --host <wav> --remote <wav> --speed max\|1 [--export <file>]` | Runs WAV files through the pipeline into `sessions/<id>/` |
| `npm run serve [-- --replay <dir> --speed 1\|max]` | The web page and HTTP + SSE API on http://127.0.0.1:4317 |
| `npm run build:capture` | Builds the `podcast-capture` Swift helper (microphone + system audio) |
| `npm run capture:test` | Checks the helper and the macOS permissions on this Mac (interactive) |
| `npm run build:web` | Compiles the web page (`npm run serve` does it first) |
| `npm run preflight` | Pre-show checks (see `docs/rehearsal.md`) |
| `npm run calibrate:boundary -- <labelled.jsonl>` | Precision / recall / F1 of the boundary threshold (offline) |
| `npm run calibrate:speakers -- --host <wav> --remote <wav>` | Speaker count per similarity threshold |

Development runs stop at a $3 total spend (summed from `sessions/**/*.jsonl`); `--allow-over-dev-cap` lifts that cap.

macOS asks once for **Microphone** and once for **System Audio Recording**; both are granted to the terminal app that starts the server (System Settings → Privacy & Security). A denied permission delivers silence, which `capture:test` and `preflight` detect.

## Using it

`npm run serve`, then open http://127.0.0.1:4317 and press **Start live** (earbuds in). The page shows both stream meters, a transcript that streams as people speak, the timeline, fact-check cards, and the System 1 panel. Every session is saved under `sessions/`; the **Recordings** tab lists, names, searches, reopens, and replays them.

Expect about $1.60 per hour of show: roughly $1.00 streaming text, $0.23 final transcripts, $0.04 Jev, and up to $0.35 fact-checking. The per-session cap is `budget.sessionCapUsd` ($5) in `config/app.json`. OpenRouter calls send `provider: { data_collection: "deny" }`.

## Documentation

<!-- BEGIN doc-index -->
- [Architecture](docs/architecture.md) — The end-to-end architecture — native capture, the Node engine's pipeline from audio to utterances, transcripts, segments, labels, and fact-checks, the event bus and HTTP/SSE API, the web front end, storage, and budgets.
- [Gotchas](docs/gotchas.md) — Verified traps in this project — macOS capture permissions, sherpa-onnx, OpenAI and OpenRouter behaviour, Jev question wording, and test-fixture voices — each with its fix.
- [Jev](docs/jev.md) — What Jev is, how its Decisions API works (question types, answers, confidence, limits, price), and every place this project asks it a question — per utterance, per segment, in the replay gate — with the client's retry and budget rules.
- [Mission](docs/mission.md) — Why Podcast Assistant exists — a live, on-air demonstration that software should call a decision model like Jev for bounded judgments, with a slower LLM as System 2 — and the principles and non-goals that follow from it.
- [Recordings](docs/recordings.md) — Where every session is stored, what each file holds, and how the recordings library lists, names, searches, reopens, and replays past sessions.
- [Rehearsal kit](docs/rehearsal.md) — The pre-show checklist, the planted lines to say on air, how to keep a fallback recording, and how to calibrate thresholds on an old episode.
- [Speakers](docs/speakers.md) — How each utterance gets a speaker from local voice embeddings, why the threshold is 0.65, how short utterances are handled, and how to rename, merge, and calibrate.
- [System 1 and System 2](docs/system1-system2.md) — The fact-checker's System 1 / System 2 architecture — Jev flags claims on every utterance, GPT-6 Luna researches them and audits for misses, and verdicts drive memory questions and gated rewrites that improve System 1 — with every rule, threshold, prompt, and schema.
- [Transcription](docs/transcription.md) — How speech becomes text, in two layers — final per-utterance transcripts from gpt-transcribe, and streaming display text from gpt-live-transcribe — with their triggers, costs, and configuration.
<!-- END doc-index -->

## Design decisions

**Tier 2 capture and front end — decided 24 September 2026.**

**Architecture.** The engine owns everything smart: capture, VAD, speakers, transcription, System 1 and System 2, storage, and the HTTP and SSE API. It is the Node server plus a native capture helper that the server starts as a child process. The front end is a thin client: it only reads `GET /api/state` and `GET /api/events` and posts commands. It could be replaced later, for example by a SwiftUI app, without touching the engine.

**Capture: a native Swift helper, `podcast-capture`.**
- `host`: the MacBook's built-in microphone, chosen explicitly whatever the system default input is.
- `remote`: a global Core Audio tap (macOS 14.2+) of everything the Mac plays, on any output device (speakers, wired earbuds, AirPods), including a device switch mid-session.
- It works whether Riverside runs in Chrome or as the Mac app.

**Front end: a local web page served by the engine**, in plain TypeScript compiled with `tsc` to browser ES modules. No bundler, no UI framework, no new dependencies.

**Show setup assumption.** The host wears earbuds, so the microphone never hears the call. Echo cancellation is out of scope. Riverside's own microphone is also set to the MacBook's built-in mic.

**Why:**
- Browser capture tied the engine to a Chrome tab that had to be re-picked every session and could be closed or throttled.
- AudioTee captures system audio only, not the microphone. One helper that captures both streams gives them a single clock.
- A global tap, rather than one app's output, is independent of the output device and of which Riverside client is used. Notification sounds are handled by the show checklist (Focus mode).
- Chrome's system audio and BlackHole had other risks (see the spec's background notes).
- A local web page needs nothing installed, runs in any browser, and can be shared as a window in Riverside.

## License

MIT
