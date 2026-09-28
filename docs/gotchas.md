---
description: Verified traps in this project — macOS capture permissions, sherpa-onnx, OpenAI and OpenRouter behaviour, the Electron Mac app, Jev question wording, and test-fixture voices — each with its fix.
tags: [gotchas, macos, openai, openrouter, jev, sherpa-onnx, electron]
source:
  - native/capture/**
  - src/audio/nativeSource.ts
  - src/transcribe/**
  - src/factcheck/s1.ts
  - src/factcheck/s2.ts
  - scripts/make-fixtures.ts
  - src/store/transfer.ts
  - desktop/**
  - src/server/inProcess.ts
---

# Gotchas

## Capture (macOS)

- **Permissions go to the app that launched the helper, not to Node or the helper.** For `npm run serve` that is the terminal app: in cmux grant cmux, in Terminal grant Terminal, then quit and reopen it. For the Mac app it is **Conversation Assistant** itself (verified in the `tccd` log: `responsible=com.cloudlesslabs.conversation-assistant` for the helper's requests), so a Mac with both has two separate sets of grants. A denied System Audio Recording permission delivers pure silence (−120 dBFS), not an error. `npm run preflight` detects silence by level.
- **The system tap takes about 0.9 s to start**, so a 3 s `--probe` returns about 2.1 s of audio. The first probe right after granting the permission came back silent once; later runs were reliable. ClockLock pads the start gap with silence, so the session clock stays aligned.
- **A call app changes the audio setup under you.** Starting a WhatsApp (or any VoIP) call on a Bluetooth headset switches it to its call profile: the output drops from 48 kHz to 16 or 24 kHz, and macOS stops other apps' `AVAudioEngine`s. Before 25 September 2026 the helper read the tap's rate once and never restarted the mic, so during a call the mic went silent (0 samples) and the system audio came out sped up, which the VAD no longer recognised as speech — the page showed "Waiting for speech". The helper now converts at each buffer's own rate, re-reads the rate whenever the output device's rate changes, and restarts the mic after `AVAudioEngineConfigurationChange` (at most 5 times a minute, since a restart can itself post the notification). A `warning` status line reports each switch. **It can also leave the engine "running" with no buffers:** on 27 September 2026 a WhatsApp call on Bluetooth earbuds silenced the built-in mic for the rest of the session (ClockLock padded exact digital silence, −120 dBFS), with no warning, because the restart only ran when `isRunning` was false, and it stayed true. Reproduced by changing the mic's sample rate mid-capture: 0 buffers a second, `isRunning` true. The helper now restarts the mic when no buffer has arrived for 1.5 s, whatever `isRunning` says; in the same reproduction the mic came back within 1.5 s. A voice-processing call on the same mic (VPIO) also turns our input down about 15 dB while it runs, but it keeps flowing.
- **A USB wireless mic can deliver exact digital silence** (−120 dBFS with frames arriving) when its transmitter is off, muted, or out of range; the built-in mic working in the same probe rules out permissions.
- **A global system-audio tap makes other apps hang when they start a microphone.** With the helper's old global tap (`CATapDescription(monoGlobalTapButExcludeProcesses: [])`) running, another app starting a microphone (ffmpeg in the tests; in real use, recorders reporting the microphone as taken) hung in `AudioDeviceStart` → `HALB_IOThread::StartAndWaitForState`, waiting on coreaudiod, and could ignore SIGTERM. It hung in 28 of 32 attempts on macOS 26.2, on the built-in mic and a USB wireless mic alike. With the helper capturing only the mic it hung in 0 of 3 attempts, so the cause is the tap, not the mic. Aggregate variants did not help: no sub-device, the IO proc on the realtime thread, no drift compensation, a public tap. A tap that lists processes hung in 0 of 20 attempts, so the helper's tap now follows the apps playing sound (see [Architecture](architecture.md#capture--nativecapture-and-srcaudionativesourcets)). Test: `native/capture/.build/release/conversation-capture --no-mic` with stdin kept open, then `ffmpeg -f avfoundation -i ":MacBook Air Microphone" -t 2 -f null -` under `timeout -s KILL 8`.
- **Speaker mode treats every Bluetooth output as headphones.** Core Audio does not say whether a Bluetooth device is earbuds or a Bluetooth speaker, so a Bluetooth speaker leaves the microphone open, and the call is transcribed twice again. With a Bluetooth speaker, set `echoGate.mode` to `always` in `config/app.json`. Every non-Bluetooth output that is not the headphone jack counts as speakers, so a USB headset mutes the mic while the call plays, which is harmless.
- **A mic start can block on a permission prompt** instead of failing. The helper warns after 5 s and exits with code 5 after 30 s rather than hanging.

## sherpa-onnx

- **`DYLD_LIBRARY_PATH` is not needed on this Mac**: the darwin-arm64 addon loads directly, including under vitest. If it ever fails, set the variable directly in front of `node`, because macOS strips `DYLD_*` through `/usr/bin/env` shebangs (`tsx`, `vitest`).
- **The npm package says Apache-2.0, but its prebuilt library contains GPL-3.0 code.** `sherpa-onnx-darwin-arm64`'s `libsherpa-onnx-c-api.dylib` compiles in eSpeak NG (GPL-3.0-or-later) for text-to-speech, which the package metadata never mentions (`nm -gU` lists `_espeak_ng_*`). Shipping it obliges the app to carry the GPL text and offer the exact source, which `THIRD_PARTY_NOTICES.md` and every release do (see [The Mac app](desktop.md#licenses)). Leaving text-to-speech out means rebuilding both native files, because `sherpa-onnx.node` references the text-to-speech functions. Check a new sherpa-onnx version for this before upgrading.
- **The package ships no TypeScript types**; `src/types/sherpa-onnx-node.d.ts` declares the subset used. `Vad.flush()` exists in 1.13.8.

## OpenAI

- **An out-of-credit account returns 429 `insufficient_quota`**, which looks like a rate limit. Retrying it wastes time, so the transcriber fails at once on that code. Add credits at platform.openai.com → Billing.
- **The realtime transcription docs omit the WebSocket URL**: it is `wss://api.openai.com/v1/realtime?intent=transcription`, with an `Authorization: Bearer` header, which Node 24's `WebSocket` accepts as `{ headers }`. `gpt-live-transcribe` needs `turn_detection: null` and 24 kHz PCM.

## OpenRouter and GPT-6 Luna

- **Verdicts embed inline markdown citations** (`([site](url))`) in `correction` and in source titles, because of the web plugin. They clutter the cards and count as one "word", which defeats the 25-word correction limit. `stripCitations` in `src/factcheck/s2.ts` removes them.
- **Strict `json_schema` works together with the web plugin** on GPT-6 Luna (both the exa and native engines), so the `json_object` fallback has not been needed; it stays in place in case that changes.
- **`provider: { data_collection: "deny" }` is sent on Jev and GPT-6 Luna calls** (`config/app.json`), and both still route. Adding `zdr: true` was not tested and may break Jev, whose endpoint is not confirmed on the zero-retention list.

## Web page

- **A list outside an open modal dialog cannot be clicked.** `showModal()` makes everything outside the dialog inert, and a top-layer popover appended to `<body>` still shows above the dialog but is inert: `elementFromPoint` sees through it and clicks land on the dialog. The bespoke select's list therefore goes inside the open dialog (`web/src/ui.ts`). Keyboard selection worked all along, which hid the bug.

## Export and import

- **Safari unzips a downloaded `.zip` into a folder** ("Open safe files after downloading"), which would break import. That is why exports use their own extension, `.conversation-recording`, and are served as `application/octet-stream`.
- **`afconvert`'s WAV output has extra chunks**: decoding AAC to WAVE puts the audio at byte 4088, not 44. The app assumes a 44-byte header everywhere (durations from file size, the playback mixer), so import rewrites the header (`canonicalWav` in `src/store/transfer.ts`). The AAC round trip itself is exact: the same sample count and no time shift, measured on a two-minute stream.

- **A recording's session events must carry its own folder id.** The page switches to a newly opened recording only when the `session.started` it receives names a different session from the one on screen. A copy imported as `<id>-2` whose events still said `<id>` opened in the engine, but the page kept showing the original. Import now rewrites the ids, and `SessionLibrary.events` corrects mismatches on open (see [Recordings](recordings.md#export-and-import)).

## Chat

- **A stopped stream never reaches its `usage` chunk**, so a stopped reply's cost is unknown from the stream. OpenRouter's `GET /api/v1/generation?id=<gen id>` has it a second or two later: the chat asks up to 3 times before falling back to a price-list estimate (marked `estimated`). The id is the chunks' `id`.
- **Headless Chrome never finishes loading the page** (`--virtual-time-budget` hangs), because `/api/events` keeps a server-sent event stream open. For a screenshot use `--timeout=6000` instead.

## Mac app (Electron)

- **sherpa-onnx throws "External buffers are not allowed" inside Electron** unless each call that returns audio asks for a copy. Electron's V8 memory cage refuses the ArrayBuffers the addon makes over native memory, which Node accepts, so the tests (which run in Node) cannot see it. Pass `false`: `vad.front(false)`, `extractor.compute(stream, false)`. `tests/desktop.test.ts` fails on a call without it. `LinearResampler.resample` returns a copy and is safe.
- **A dialog without a parent window freezes the whole app, engine included.** `dialog.showMessageBox(opts)` with no window runs `NSAlert runModal`, a nested modal loop that stops Electron's main loop until it is answered: measured, a timer in the main process stopped ticking, and even the dialog's own abort signal never fired. The engine runs in that process, so a show on air would stop being captured. Every dialog goes through `ask()` in `desktop/main.ts`, which attaches it to the window as a sheet (the timer kept ticking).
- **An in-memory stream pair does not pass a close across.** With `stream.duplexPair()`, a page closing its `/api/events` stream destroyed only its side: the router's side stayed open, subscribed to the event bus, and written to for good, once per reload. `src/server/inProcess.ts` destroys each side when the other closes (tested).
- **An ad-hoc build with the hardened runtime does not launch** ("Library not loaded: … Electron Framework … different Team IDs"): library validation needs the same Team ID across the app and its frameworks, and an ad-hoc signature has none. Ad-hoc test builds add `com.apple.security.cs.disable-library-validation` (`desktop/entitlements.adhoc.plist`); a Developer ID build signs everything with one team and does not need it.
- **XHR upload progress never fires on a custom protocol.** On `app://`, `xhr.upload.onprogress` is never called, even for 30 MB (which uploads in about 90 ms). The import bar moves back and forth until progress arrives, instead of waiting at 0 %.
- **Electron grants a page every permission it asks for** (microphone, camera, geolocation, notifications) unless a handler says otherwise. The window's page never needs one (capture goes through the helper), so `desktop/main.ts` refuses all of them except `clipboard-sanitized-write`, which the chat's Copy buttons use.
- **`security` cannot see a notarytool keychain profile.** `xcrun notarytool store-credentials conversation-assistant` saves the notary key where `security find-generic-password` finds nothing, so a script cannot test for it that way. `scripts/build-mac.sh` and `publish-app.sh` ask `xcrun notarytool history --keychain-profile conversation-assistant` instead: it succeeds only when the profile exists and Apple accepts it (about a second, free).
- **A packaged build cannot be driven through DevTools.** It exits when started with `--remote-debugging-port` (on purpose, see [The Mac app](desktop.md#hardening)), and the `EnableNodeCliInspectArguments` fuse is off. Drive the page with `npm run app`; test a packaged build by opening it, and check its window from outside (the window list via `CGWindowListCopyWindowInfo` needs no permission).
- **A packaged app with a sheet open ignores AppleScript's `quit`.** On a first launch the permissions sheet is up, and `tell application "Conversation Assistant" to quit` does nothing. Quit it with `pkill -x "Conversation Assistant"` (`-x`, the exact name: `pkill -f` with the app's path also matches the shell running the command).
- **In development the permission status is the terminal's.** `systemPreferences.getMediaAccessStatus("microphone")` reports Electron's own status, while macOS asks on behalf of the terminal that started `npm run app`, so the first-launch sheet would show on every launch. It runs only in the packaged app.

## Jev questions

- **A memory question needs concrete criteria or it cannot recognise a repeat.** Worded only as "new_utterance restates or relies on this already-checked claim", a verbatim repeat scored 0.55 and a mere reaction to the claim 0.50. With the "Judge only new_utterance." opener and true/false criteria, repeats score 0.73–0.87 and non-repeats ≤ 0.06, hence `factcheck.knownMatchThreshold` 0.6.
- **Jev's `worth` score can sit on the threshold**: "Jev can never hallucinate" scored 1.94–2.01 across runs, so `s1@1` uses `worthMin` 1.5 rather than 2, or the claim is flagged only some of the time.

## Test fixture

- **macOS `say` voices Samantha and Karen are nearly the same voiceprint** (0.86 cosine), so no usable threshold separates them. The fixture uses Sandy (UK) for the third voice; the lines still call her "Karen".
- **Silero misses Sandy's opening "Oh it was beautiful,"**, so that line reads "It was absolutely beautiful". Keep fixture lines to one sentence each: a sentence pause can exceed the VAD's 0.5 s silence and split a line in two.
