---
description: How speech becomes text, with two engines — Apple Speech on this Mac (the default on macOS 26+, free, nothing leaves the Mac), with one clip per utterance and live text from stream analyzers, or OpenAI's gpt-transcribe and gpt-live-transcribe — how the engine is chosen and saved, the tattle-transcribe helper, costs, and configuration.
tags: [transcription, apple-speech, speechanalyzer, openai, realtime, engine, settings, latency, cost]
source:
  - src/transcribe/apple.ts
  - src/transcribe/openai.ts
  - src/transcribe/live.ts
  - src/settings.ts
  - src/audio/vad.ts
  - native/transcribe/**
  - scripts/transcribe-test.sh
  - config/app.json
---

# Transcription

Speech is transcribed twice, for two different readers:

| Layer | Produces | Read by |
| --- | --- | --- |
| Final | One transcript per VAD utterance | Jev (segmenter, fact-checker), timeline, chat, session files |
| Live | Text that streams while someone speaks | The web page only |

The live layer never feeds any judgment. Two **engines** can produce both layers:

| Engine | Final layer | Live layer | Cost | Leaves the Mac |
| --- | --- | --- | --- | --- |
| **Apple Speech** (`apple`), macOS 26+ | One clip per utterance, each through its own short-lived `SpeechAnalyzer` | One `SpeechAnalyzer` per stream, never finalized | Free | Nothing |
| **OpenAI** (`openai`) | `gpt-transcribe`, one upload per utterance, ~2.5 s after the speaker stops | `gpt-live-transcribe` over a realtime WebSocket, ~1.2 s after speech starts | ~$1.23 an hour | The audio, to OpenAI |

Measured on a 1 h 57 min episode against OpenAI's text (fillers and number words normalized, 29 September 2026): Apple's clips disagree with OpenAI on **9.3 %** of words, take 0.3 s p50 / 0.9 s p95 each, and hear "Jev" 23 times where OpenAI does 36 times (the others become "Jeff", "Jeb", "Javi"). Apple's live text shows 2.0 s p50 after speech starts. Where they disagree, OpenAI is not always right ("dispatch it" against OpenAI's "Patch it").

## Choosing the engine — `src/settings.ts`

The engine is a user setting, not config: `~/Library/Application Support/Tattle/settings.json` holds `{ "transcriptionEngine": "apple" | "openai" }`, written atomically like `credentials.json` and shared by the Mac app and `npm run serve` (`TATTLE_SETTINGS` overrides the path; tests use it). It changes in **Settings → Transcription** (cog menu), never mid-session: `PUT /api/transcription` answers 409 while a session is on air, and a session records the engine it ran with in `session.json` and `session.started` (`transcription: { engine, locale }` or `{ engine, model }`).

At boot, `resolveEngine` (pure, unit-tested) decides:

| Situation | Engine | Saved |
| --- | --- | --- |
| A choice is saved | That one; but saved `apple` on a Mac that cannot run it runs `openai` | Unchanged |
| Nothing saved, an OpenAI key is set (someone updating from a version before engines) | `openai` | Yes |
| Nothing saved, Apple Speech available | `apple` | Yes |
| Nothing saved, Apple Speech unavailable (macOS < 26) | `openai` | Yes |
| The availability check itself failed or timed out | `apple`, with its model in `error` | No: a transient failure never sends a macOS 26 user to the OpenAI key screen |

**Availability** (`appleSpeechStatus` in `src/transcribe/apple.ts`): on Darwin < 25 (macOS < 26), or with `TATTLE_FORCE_NO_APPLE_SPEECH=1`, it is unavailable ("Needs macOS 26 or later") without spawning anything: the helper cannot load there. Without the built helper it is unavailable too ("tattle-transcribe is not built (npm run build:transcribe)"). Otherwise it runs `tattle-transcribe --status` (5 s timeout) and caches the answer.

**The model.** When the engine is `apple` and the model is not installed, the engine runs `tattle-transcribe --install` in the background at boot, and again when the user switches to Apple. Its state is `missing | installing (fraction) | installed | error`, sent to the page as the transient event `transcription.status` and returned by `GET /api/transcription`. Start live waits for it ("Getting on-device speech recognition ready… 42 %"; `POST /api/session/start` answers 409 `{ preparing: true }` meanwhile); on `error` the page offers **Try again** (`POST /api/transcription/install`).

| Method | Route | Does |
| --- | --- | --- |
| GET | `/api/transcription` | `{ engine, saved, apple: { available, reason, model, fraction, error }, openai: { keySet } }`. Open before any key is set: the setup screen says why it asks for one |
| PUT | `/api/transcription` | `{ engine }`. 409 on air; 400 `needsKey: "openai"` when choosing OpenAI without its key; 400 when choosing Apple where it is unavailable. Saves, and starts the install if needed |
| POST | `/api/transcription/install` | Retries a failed install (202) |

## Apple Speech — `native/transcribe/`, `src/transcribe/apple.ts`

`tattle-transcribe` is a Swift command-line helper, built like `tattle-capture` (swift-tools 6.0, Swift 5 mode, `Info.plist` embedded with `-sectcreate`, frameworks Speech, AVFoundation, CoreMedia), for macOS 26.0 (`otool -l` shows `minos 26.0`). It uses Apple's `SpeechAnalyzer` + `SpeechTranscriber` (`en_US`, `.volatileResults`, `.audioTimeRange`). The engine spawns one per session, restarted up to 3 times, 1 s apart, like capture.

| Command | Does |
| --- | --- |
| `--status [--locale en-US]` | One JSON line: `{ available, reason, locale, installed }` |
| `--install` | Downloads and installs the model (`AssetInventory`), with `{"type":"progress","fraction":…}` lines, then `{"type":"installed"}` or an error |
| (run) `[--live] [--clip-concurrency 2]` | Reads frames on stdin, writes JSON lines on stdout; with `--live` it runs one analyzer per stream for live text |

**Frames on stdin** (little-endian; header `PTRX`, kind u8, stream u8 (0 host, 1 remote), 2 reserved bytes):

| Kind | Body | Used for |
| --- | --- | --- |
| 0 audio | `startMs` f64, `count` u32, PCM16 16 kHz mono | Live text only: every frame, silence included, stamped from a per-stream sample counter |
| 2 clip | `idLen` u32, id, `count` u32, samples | `scripts/transcribe-test.sh` |
| 3 clip in a file | `idLen` u32, id, `pathLen` u32, path | Every line's final text. The file holds PCM16 samples; the helper reads and deletes it |

Kind 1 (a clip cut by the helper from streamed audio) is retired: see [Gotchas](gotchas.md#apple-speech).

**Lines on stdout:** `ready` (once the analyzers have started and a warm-up clip has run; the first clip starts cold, 11 s measured), `volatile` / `final` `{ stream, runs: [{ text, startMs, endMs }] }` (with `--live`), `clip { id, text }` or `clip { id, error }`, and `error { message, fatal }`. Without the model it exits 3 with "model not installed".

**Final text: one clip per utterance.** `AppleSpeech` keeps the last 60 s of each stream (`AudioRing`). When the VAD closes a line, `Services.transcribe` gets its span; the engine cuts `[start − clipPadMs, end + clipPadMs]` (300 ms either side, because the VAD's edges clip words), writes it to a file in its own `mkdtemp` folder (mode 0600), and sends kind 3. Retries (no span), and a line whose audio is no longer held, send the line's own samples. At most `clipConcurrency` (2) clips are in the helper at once, the rest wait in the engine, and a clip's timeout, `clipTimeoutMs` (20 s) plus twice its length, starts when it is sent: it catches a stuck helper, not a slow one. A failure or a timeout is `retryable`, so the line keeps its place and is retried (below). The text then goes through the same `transcription.fixes`, filler rule, and empty-drop as OpenAI's. Each helper clip runs in its own analyzer at `.userInitiated` priority; without `--live`, one analyzer is started and never fed, which keeps the model loaded between clips.

**Live text: stream analyzers, never finalized.** With live text on (live sessions, speed-1 replays), every frame goes to the helper, and each stream's analyzer reports volatile results (one run over the whole unsettled range, with no word times) and final ones (one run per word). `LiveText` turns them into `utterance.partial` events `{ stream, itemId: "apple-<stream>-<n>", text, utteranceId, final }`:

- the text is the stream's settled words not yet handed to a line, then its unsettled text. Settled words are compared by their **end** time (− 100 ms) with the last closed line's end (+ 150 ms): the first word after a pause has its start stretched back over the pause;
- on `commit` (the VAD closed a line), the text on screen is re-sent with that line's id and `final: true`, and the next item starts. The page removes it when the final line lands;
- the unsettled text lags speech by a second or two, so a closed line's last words arrive afterwards. Each closed line remembers how many words of the unsettled text are its own: as many as had arrived when it closed, then, once its clip is transcribed, as many as the clip has. Those words are stripped from the next item; an item left empty is sent empty, which the page hides.

`finalize(through:)` is never called on a stream analyzer: it drops the words that follow it.

**No permission.** SpeechAnalyzer asked for no Speech Recognition permission in testing; the helper and the Mac app still declare `NSSpeechRecognitionUsageDescription`.

**Logging.** Nothing goes to the budget. Each line logs a `transcriptions.jsonl` row like OpenAI's, with `engine: "apple"` and `cost_usd: 0`.

`npm run transcribe:test` checks the helper on this Mac: availability, then 30 s of the fixture's host stream with live text and a clip of its first line, and that word times line up with the audio.

## OpenAI — `src/transcribe/openai.ts`, `src/transcribe/live.ts`

### Final layer

`Transcriber.transcribe(utteranceId, samples)` uploads the utterance as a 16 kHz PCM16 WAV to `POST https://api.openai.com/v1/audio/transcriptions` with `model`, `prompt`, `keywords[]`, and `languages[]` from `config/app.json` → `transcription`.

- **Context per clip.** The `prompt` sent with each clip is built by the session: the configured prompt, the names the host gave the speakers ("The speakers are Nic, Sam."), tonight's stories, and up to 600 characters of the last lines said ("The conversation so far: …"). The speakers' names are also added to `keywords`. Clips are short (2–3 s on average for a remote guest), so without the conversation around them words are misheard: "let's go back to the cinema 2P" for "to pee". (Apple Speech takes no context: its documented vocabulary hint, `contextualStrings`, changed nothing in testing.)
- **Slivers are not sent.** A clip shorter than 0.25 s (`MIN_AUDIO_SECONDS`; the VAD emitted 54 ms ones) comes back as empty text, which drops it, with no request and no cost: the API rejected every such clip with 400 "Audio file might be corrupted or unsupported". Apple skips them the same way.
- One retry on a network error, timeout, 429, or 5xx — except a 429 whose body says `insufficient_quota` / `credit_balance_exhausted`, which is not transient and fails at once.
- If the API rejects the bracketed field names, it retries once with `keywords` / `languages` and keeps that style.
- Cost is estimated as `audio_seconds / 60 × $0.0045` and logged to `transcriptions.jsonl` as `kind: "transcription"`, `engine: "openai"`.

### Live layer

`LiveTranscriber` keeps one realtime connection per stream to `wss://api.openai.com/v1/realtime?intent=transcription`, authenticated with an `Authorization` header (Node 24's built-in `WebSocket` accepts `headers`; no dependency). The session is configured with `session.update`: `type: "transcription"`, 24 kHz PCM, `model: "gpt-live-transcribe"`, the same keywords, languages, and prompt as the final layer, and `turn_detection: null`.

1. **Gated by the VAD.** Nothing is sent while a stream is silent. When the VAD starts hearing speech, the last `live.prerollMs` (600 ms) of audio is sent first, so the first word is whole, and sending continues until `live.hangoverMs` (700 ms) of silence.
2. **Resampled** from 16 kHz to 24 kHz with sherpa-onnx's `LinearResampler`.
3. **Committed per utterance.** When the VAD closes an utterance, `commit(stream, utteranceId)` sends `input_audio_buffer.commit`; the server's `input_audio_buffer.committed` maps its `item_id` to that utterance id.

The connection is opened when the session starts (`warm`), because setup takes about 1.5 s; after a server close it reopens on the next speech. Live text is billed per audio minute sent, at `live.usdPerMinute` ($0.017), logged as `kind: "live_transcription"` at each commit, when a connection closes, and at session end, and counted in the budget's `transcription` bucket; once a cap is reached, live text stops. Measured on the 78 s fixture at speed 1: $0.022 live against $0.0047 final. For a one-hour show with about 50 minutes of speech, expect roughly $1.00 live plus $0.23 final. Crosstalk costs double, because both streams send. See [Recordings](recordings.md) for how replays re-spend.

## Both engines

**Utterances: what triggers a transcript.** `src/audio/vad.ts` runs one Silero VAD per stream (`host`, `remote`). An utterance closes after `vad.minSilenceDuration` (0.5 s) of silence, or at `vad.maxSpeechDuration` (30 s) of continuous speech. It was 20 s until a one-hour call showed long turns cut mid-sentence at exactly 20.0 s. `vad.minSpeechDuration` is 0.25 s: at 0.4 s, a short first word followed by a micro-pause ("I", "Jev") was dropped.

**Partials are transient**: they go to SSE subscribers but are never stored in `events.jsonl` or the replay history, because one per word would bloat both. The page shows a partial as an italic line with a red dot and removes it when the final `utterance` with the same id arrives. While a line is still live the page names the speaker only if that stream has had a single speaker so far; otherwise "Host" or "Call". Live text runs in live sessions and speed-1 replays (`Engine.start` sets `liveText`); `--speed max` replays and the `replay` CLI never stream.

- A trimmed text shorter than 4 characters, or matching `uh|um|mm|hmm|mm-hmm|yeah|yes|no|okay|ok|right|so`, is a **filler**: it joins the segment but skips Jev.
- Empty text is dropped.
- **A failed line keeps its place and is retried.** A failure is `retryable` when it may pass: for OpenAI, no HTTP status (a network drop or timeout), a 429 other than no credits, or a 5xx; for Apple, every failure (a timeout, the helper stopping). The session keeps that line's audio and context and emits `utterance.failed` with `status: "retrying"`, and the page shows "Not transcribed yet… Retrying…" in the line's place. Every 15 s the session retries the kept lines oldest first, stopping at the first failure. A recovered line is emitted as `utterance` with `recovered: true` and joins the transcript and the chat in time order; it does not go back through Jev, segments, or fact-checking. At the end of the session there is one last pass; whatever still fails is marked `status: "failed"`. A failure that is not transient is marked `failed` at once. At most 200 lines are kept. Added 27 September 2026, after a one-minute network drop in a live test lost 8 lines silently.

## Configuration (`config/app.json` → `transcription`)

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `gpt-transcribe` | OpenAI's final-layer model |
| `languages`, `keywords`, `prompt` | English, the show's jargon | Sent to OpenAI's two layers |
| `concurrency`, `timeoutMs` | 4, 20000 | OpenAI upload limits |
| `fixes` | `[]` | Whole-word regex replacements applied to final text, either engine. Do not add "Jeff" → "Jev": real people are called Jeff. |
| `live.enabled` | `true` | `false` turns live text off everywhere, either engine |
| `live.model`, `live.delay` | `gpt-live-transcribe`, `low` | OpenAI's streaming model and its latency (`minimal` · `low` · `medium` · `high` · `xhigh`) |
| `live.prerollMs`, `live.hangoverMs` | 600, 700 | OpenAI's audio sent before and after VAD speech |
| `live.usdPerMinute` | 0.017 | Cost estimates only |
| `apple.locale` | `en-US` | Apple's locale (the helper's `--locale`) |
| `apple.clipPadMs` | 300 | Audio added either side of a line's clip |
| `apple.clipConcurrency` | 2 | Clips in the helper at once |
| `apple.clipTimeoutMs` | 20000 | Plus twice the clip's length: no answer by then fails the line (retryable) |

The engine choice is not config: it is `settings.json` (above).

Related: [Setup and API keys](setup.md), [Speakers](speakers.md) for how final utterances get a speaker, [Architecture](architecture.md), [Gotchas](gotchas.md#apple-speech).
