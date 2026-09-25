---
description: Verified traps in this project — macOS capture permissions, sherpa-onnx, OpenAI and OpenRouter behaviour, Jev question wording, and test-fixture voices — each with its fix.
tags: [gotchas, macos, openai, openrouter, jev, sherpa-onnx]
source:
  - native/capture/**
  - src/audio/nativeSource.ts
  - src/transcribe/**
  - src/factcheck/s1.ts
  - src/factcheck/s2.ts
  - scripts/make-fixtures.ts
---

# Gotchas

## Capture (macOS)

- **Permissions go to the app that launched the terminal, not to Node or the helper.** A denied System Audio Recording permission delivers pure silence (−120 dBFS), not an error. If this project runs inside cmux, grant cmux; in Terminal, grant Terminal. Then quit and reopen that app. `npm run preflight` detects silence by level.
- **The system tap takes about 0.9 s to start**, so a 3 s `--probe` returns about 2.1 s of audio. The first probe right after granting the permission came back silent once; later runs were reliable. ClockLock pads the start gap with silence, so the session clock stays aligned.
- **A mic start can block on a permission prompt** instead of failing. The helper warns after 5 s and exits with code 5 after 30 s rather than hanging.

## sherpa-onnx

- **`DYLD_LIBRARY_PATH` is not needed on this Mac**: the darwin-arm64 addon loads directly, including under vitest. If it ever fails, set the variable directly in front of `node`, because macOS strips `DYLD_*` through `/usr/bin/env` shebangs (`tsx`, `vitest`).
- **The package ships no TypeScript types**; `src/types/sherpa-onnx-node.d.ts` declares the subset used. `Vad.flush()` exists in 1.13.8.

## OpenAI

- **An out-of-credit account returns 429 `insufficient_quota`**, which looks like a rate limit. Retrying it wastes time, so the transcriber fails at once on that code. Add credits at platform.openai.com → Billing.
- **The realtime transcription docs omit the WebSocket URL**: it is `wss://api.openai.com/v1/realtime?intent=transcription`, with an `Authorization: Bearer` header, which Node 24's `WebSocket` accepts as `{ headers }`. `gpt-live-transcribe` needs `turn_detection: null` and 24 kHz PCM.

## OpenRouter and GPT-6 Luna

- **Verdicts embed inline markdown citations** (`([site](url))`) in `correction` and in source titles, because of the web plugin. They clutter the cards and count as one "word", which defeats the 25-word correction limit. `stripCitations` in `src/factcheck/s2.ts` removes them.
- **Strict `json_schema` works together with the web plugin** on GPT-6 Luna (both the exa and native engines), so the `json_object` fallback has not been needed; it stays in place in case that changes.
- **`provider: { data_collection: "deny" }` is sent on Jev and GPT-6 Luna calls** (`config/app.json`), and both still route. Adding `zdr: true` was not tested and may break Jev, whose endpoint is not confirmed on the zero-retention list.

## Jev questions

- **A memory question needs concrete criteria or it cannot recognise a repeat.** Worded only as "new_utterance restates or relies on this already-checked claim", a verbatim repeat scored 0.55 and a mere reaction to the claim 0.50. With the "Judge only new_utterance." opener and true/false criteria, repeats score 0.73–0.87 and non-repeats ≤ 0.06, hence `factcheck.knownMatchThreshold` 0.6.
- **Jev's `worth` score can sit on the threshold**: "Jev can never hallucinate" scored 1.94–2.01 across runs, so `s1@1` uses `worthMin` 1.5 rather than 2, or the claim is flagged only some of the time.

## Test fixture

- **macOS `say` voices Samantha and Karen are nearly the same voiceprint** (0.86 cosine), so no usable threshold separates them. The fixture uses Sandy (UK) for the third voice; the lines still call her "Karen".
- **Silero misses Sandy's opening "Oh it was beautiful,"**, so that line reads "It was absolutely beautiful". Keep fixture lines to one sentence each: a sentence pause can exceed the VAD's 0.5 s silence and split a line in two.
