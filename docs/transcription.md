---
description: How speech becomes text, in two layers — final per-utterance transcripts from gpt-transcribe, and streaming display text from gpt-live-transcribe — with their triggers, costs, and configuration.
tags: [transcription, openai, realtime, latency, cost]
source:
  - src/transcribe/openai.ts
  - src/transcribe/live.ts
  - src/audio/vad.ts
  - config/app.json
---

# Transcription

Speech is transcribed twice, for two different readers:

| Layer | Model | Produces | Read by | When it arrives |
| --- | --- | --- | --- | --- |
| Final | `gpt-transcribe` (file upload) | One transcript per VAD utterance | Jev (segmenter, fact-checker), timeline, session files | ~2.5 s after the speaker stops |
| Live | `gpt-live-transcribe` (realtime WebSocket) | Word-by-word display text | The web page only | ~1.2 s after the speaker starts |

The live layer never feeds any judgment: Jev, the fact-checker, and the stored transcript use only the final layer. Turning the live layer off changes what the page shows while someone is still speaking, and removes its cost — which otherwise counts toward the same session cap as every other call.

## Utterances: what triggers a transcript

`src/audio/vad.ts` runs one Silero VAD per stream (`host`, `remote`). An utterance closes after `vad.minSilenceDuration` (0.5 s) of silence, or at `vad.maxSpeechDuration` (30 s) of continuous speech. It was 20 s until a one-hour call showed long turns cut mid-sentence at exactly 20.0 s, the next piece starting mid-thought ("To another pond."). `vad.minSpeechDuration` is 0.25 s: at the spec's original 0.4 s, a short first word followed by a micro-pause ("I", "Jev") was dropped from the utterance.

## Final layer — `src/transcribe/openai.ts`

`Transcriber.transcribe(utteranceId, samples)` uploads the utterance as a 16 kHz PCM16 WAV to `POST https://api.openai.com/v1/audio/transcriptions` with `model`, `prompt`, `keywords[]`, and `languages[]` from `config/app.json` → `transcription`.

- **Context per clip.** The `prompt` sent with each clip is built by the session: the configured prompt, the names the host gave the speakers ("The speakers are Nic, Sam."), tonight's stories, and up to 600 characters of the last lines said ("The conversation so far: …"). The speakers' names are also added to `keywords`. Clips are short (2–3 s on average for a remote guest), so without the conversation around them words are misheard: "let's go back to the cinema 2P" for "to pee".
- **Slivers are not sent.** A clip shorter than 0.25 s (`MIN_AUDIO_SECONDS`; the VAD emitted 54 ms ones) comes back as empty text, which drops it, with no request and no cost: the API rejected every such clip with 400 "Audio file might be corrupted or unsupported".
- One retry on a network error, timeout, 429, or 5xx — except a 429 whose body says `insufficient_quota` / `credit_balance_exhausted`, which is not transient and fails at once.
- If the API rejects the bracketed field names, it retries once with `keywords` / `languages` and keeps that style.
- A trimmed text shorter than 4 characters, or matching `uh|um|mm|hmm|mm-hmm|yeah|yes|no|okay|ok|right|so`, is a **filler**: it joins the segment but skips Jev.
- Empty text is dropped.
- **A failed line keeps its place and is retried.** The transcriber marks a failure `retryable` when the last error was transient: no HTTP status (a network drop or timeout), a 429 other than no credits, or a 5xx. The session then keeps that line's audio and context and emits `utterance.failed` with `status: "retrying"`, and the page shows "Not transcribed yet: the connection dropped. Retrying…" in the line's place. Every 15 s the session retries the kept lines oldest first, stopping at the first failure, so a dead connection gets one request per pass, not one per line. A recovered line is emitted as `utterance` with `recovered: true` and joins the transcript and the chat in time order. It does not go back through Jev, segments, or fact-checking, which have moved on. At the end of the session there is one last pass; whatever still fails is marked `status: "failed"` ("Not transcribed", which in a recording plays from that line). A failure that is not transient, such as no credits or a 400, is marked `failed` at once. At most 200 lines are kept, and older ones are given up. Added 27 September 2026, after a one-minute network drop in a live test lost 8 lines silently, which looked like a dead microphone.
- Cost is estimated as `audio_seconds / 60 × $0.0045` and logged to `transcriptions.jsonl` as `kind: "transcription"`.

## Live layer — `src/transcribe/live.ts`

`LiveTranscriber` keeps one realtime connection per stream to `wss://api.openai.com/v1/realtime?intent=transcription`, authenticated with an `Authorization` header (Node 24's built-in `WebSocket` accepts `headers`; no dependency). The session is configured with `session.update`: `type: "transcription"`, 24 kHz PCM, `model: "gpt-live-transcribe"`, the same keywords, languages, and prompt as the final layer, and `turn_detection: null`.

How audio is sent:

1. **Gated by the VAD.** Nothing is sent while a stream is silent. When the VAD starts hearing speech, the last `live.prerollMs` (600 ms) of audio is sent first, so the first word is whole, and sending continues until `live.hangoverMs` (700 ms) of silence.
2. **Resampled** from 16 kHz to 24 kHz with sherpa-onnx's `LinearResampler`.
3. **Committed per utterance.** When the VAD closes an utterance, `commit(stream, utteranceId)` sends `input_audio_buffer.commit`; the server's `input_audio_buffer.committed` maps its `item_id` to that utterance id.

The connection is opened when the session starts (`warm`), because setup takes about 1.5 s; after a server close it reopens on the next speech.

Each delta becomes an **`utterance.partial`** event `{ stream, itemId, text, utteranceId, final }`. These events are **transient**: they go to SSE subscribers but are never stored in `events.jsonl` or the replay history (`EventBus.emit(type, data, { transient: true })`), because one per word would bloat both. The page shows a partial as an italic line with a red dot and removes it when the final `utterance` with the same id arrives. While a line is still live the page names the speaker only if that stream has had a single speaker so far; otherwise it shows "Host" or "Call", because speaker identity is known only from the final layer.

When it runs: live sessions and speed-1 replays (`Engine.start` sets `liveText`). `--speed max` replays and the `replay` CLI never stream.

## Cost

Live text is billed per audio minute actually sent, at `live.usdPerMinute` ($0.017, from OpenAI's `gpt-live-transcribe` model page, checked 25 September 2026), logged to `transcriptions.jsonl` as `kind: "live_transcription"` at each commit, when a connection closes, and at session end, and counted in the budget's `transcription` bucket. The budget is checked when a connection opens and at every commit; once a cap is reached, live text stops and its connections close.

Measured on the 78 s fixture at speed 1: 63 s of speech sent as 78 s of audio (pre-roll and hangover), costing $0.022 live against $0.0047 final. For a one-hour show with about 50 minutes of speech, expect roughly $1.00 live plus $0.23 final. Crosstalk costs double, because both streams send. See [Recordings](recordings.md) for how replays re-spend.

## Configuration (`config/app.json` → `transcription`)

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `gpt-transcribe` | Final-layer model |
| `languages`, `keywords`, `prompt` | English, the show's jargon | Sent to both layers |
| `concurrency`, `timeoutMs` | 4, 20000 | Final-layer upload limits |
| `fixes` | `[]` | Whole-word regex replacements applied to final text. Do not add "Jeff" → "Jev": real people are called Jeff. |
| `live.enabled` | `true` | `false` turns the live layer off everywhere |
| `live.model` | `gpt-live-transcribe` | Streaming model |
| `live.delay` | `low` | `minimal` · `low` · `medium` · `high` · `xhigh`: lower is faster, higher is more accurate |
| `live.prerollMs`, `live.hangoverMs` | 600, 700 | Audio sent before and after VAD speech |
| `live.usdPerMinute` | 0.017 | Used for cost estimates only |

Related: [Speakers](speakers.md) for how final utterances get a speaker, [Gotchas](gotchas.md).
