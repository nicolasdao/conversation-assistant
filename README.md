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

## License

MIT
