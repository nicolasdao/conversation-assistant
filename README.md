# Podcast Assistant

A local app that listens to a remote podcast recording (the host's microphone plus the Mac's system audio), transcribes it live, labels the conversation on a timeline with Jev, and fact-checks claims with a System 1 / System 2 loop.

## Setup

Requires Node 24 and macOS on Apple Silicon.

```bash
npm install
cp .env.example .env && chmod 600 .env   # fill OPENROUTER_API_KEY and OPENAI_API_KEY; never commit it
npm run models                           # Silero VAD + WeSpeaker speaker-embedding models into models/
npm run fixtures                         # a scripted ~100 s test conversation into fixtures/conversation/
```

Use a dedicated OpenRouter key for this project with a credit limit (for example $10).

## Scripts

| Script | Does |
| --- | --- |
| `npm test` / `npm run typecheck` | Offline tests (no network) and type checks |
| `npm run models` | Downloads the local models |
| `npm run fixtures` | Builds `fixtures/conversation/{host,remote}.wav` and `script.json` with macOS `say` |
| `npm run smoke` | Live checks of every external service (about $0.30) |
| `npm run replay -- --host <wav> --remote <wav> --speed max\|1 [--export <file>]` | Runs WAV files through the pipeline into `sessions/<id>/` |
| `npm run serve [-- --replay <dir> --speed 1\|max]` | HTTP + SSE API on `127.0.0.1:4317` |
| `npm run preflight` | Pre-show checks |
| `npm run calibrate:boundary -- <labelled.jsonl>` | Precision / recall / F1 of the boundary threshold (offline) |
| `npm run calibrate:speakers -- --host <wav> --remote <wav>` | Speaker count per similarity threshold |

Development runs stop at a $3 total spend (summed from `sessions/**/*.jsonl`); `--allow-over-dev-cap` lifts that cap.

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
