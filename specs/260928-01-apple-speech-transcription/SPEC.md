# SPEC — On-device transcription with Apple Speech, as the default, and no required API keys

Created 28 September 2026. Status: Phase 0 done (29 September 2026); §4.1 onward in progress.

## §0 How to use this spec (read first)

**What this spec is.** The complete plan for adding a second transcription engine to Tattle — Apple's on-device `SpeechAnalyzer` / `SpeechTranscriber` (macOS 26+) — making it the default where the Mac supports it, and removing the first-run API-key screen for those Macs.

**Who you are.** A fresh session with no memory of the conversation that produced this spec. Everything that conversation established is here. Trust it; do not redo it.

**DO**
- Read this file end to end before touching anything.
- Run `/init-context on-device transcription with Apple Speech` first: it loads `docs/mission.md`, `docs/gotchas.md`, and the subsystem docs. Before your first edit to any file, run `python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects <path>` and read what it names.
- Do **§4.0 (Phase 0) first, and stop** after it: report its numbers to the user and wait for a go. Nothing in §4.1+ starts before that go.
- Treat every `file:line` as an anchor that may have drifted: grep the symbol named with it.
- Verify each task with its **Done when** before the next one.
- Work on a branch, `feat/local-transcription`. One task per commit, conventional commits (`feat(transcribe): …`, `fix(web): …`), each ending with the attribution line the session gives you.

**DO NOT**
- Re-research Apple's APIs or re-explore the codebase: §2, §6, and §10 carry what was found, with sources.
- Commit, push, open a PR, or release (`/release-tattle`) without the user's explicit go.
- Commit the working tree's pre-existing uncommitted changes (licenses work: `desktop/preload.ts`, `src/licenses.ts`, `web/licenses.html`, … as of 28 Sep 2026). Run `git status` first; if unrelated changes are present, **stop and ask** how the user wants them handled.
- Edit `docs/mission.md` without the user approving the exact wording (see §4.10).
- Edit this spec. If it is wrong or incomplete, stop and tell the user.

**Suggested first 30 minutes.** `/init-context` → read `docs/transcription.md` and `docs/setup.md` in full → read `Services` and `onUtterance` in `src/pipeline/session.ts` and `LiveTranscriber` in `src/transcribe/live.ts` → start §4.0.

## §1 Goal

1. **Two transcription engines**, chosen in Settings: **Apple Speech** (on this Mac, free, audio never leaves the Mac) and **OpenAI** (today's `gpt-transcribe` + `gpt-live-transcribe`). Apple Speech replaces both OpenAI layers: its volatile results drive the live text, its finalized results the per-utterance transcript.
2. **Apple Speech is the default** wherever it is available (macOS 26+, `SpeechTranscriber.isAvailable`, English supported) — except for an existing user who already has an OpenAI key saved, who keeps OpenAI until they change it.
3. **No key is asked at first launch on a Mac that runs Apple Speech.** The app opens straight into the app. The on-device model downloads in the background with no question.
4. **On macOS 14.2–25** (no Apple Speech), the first launch still requires a key — **only the OpenAI key**. OpenRouter is no longer on the first-run screen for anyone.
5. **The OpenRouter key becomes optional and is asked for only when it is needed**: when fact-checking or labels are switched on in the Start live window, or when Chat is opened. The prompt reads: *"Please provide your OpenRouter API key to configure fact-checking or labeling."* (Chat: *"…to use Chat."*). With no OpenRouter key, a transcript-only show works fully offline on macOS 26+.
6. The app's minimum stays **macOS 14.2, Apple Silicon** (`electron-builder.yml` `minimumSystemVersion`). Nothing is dropped.

## §2 Context

Transcription is the dominant running cost: about $1.23 of the ~$1.60 an hour of a show (`docs/transcription.md` § Cost: ~$1.00 live text + $0.23 final). With fact-checking and labels switched off at Start live (`docs/architecture.md` § Features: fixed for the whole session, chosen before it starts), Jev and GPT-6 Luna are never called, so with on-device transcription a show costs nothing and sends nothing off the Mac.

**Apple's options (researched 28 Sep 2026).** `SpeechAnalyzer` + `SpeechTranscriber` (WWDC 2025, macOS 26.0+): on-device, streaming, volatile (partial) and final results, per-run `audioTimeRange` timestamps, `finalize(through:)`. Models are downloaded through `AssetInventory` into shared system storage. On conversational English (Argmax, earnings22) its word error rate is 14.0 %, between whisper-base.en (15.2) and whisper-small.en (12.8); nobody has published a comparison with OpenAI's cloud models. It has no documented custom-vocabulary option (`contextualStrings` is documented for `DictationTranscriber` only). The legacy `SFSpeechRecognizer` is **not viable** (poor accuracy, a one-minute limit Apple still documents, reports of it never starting on macOS 26) — do not use it.

This Mac: macOS 26.2, Xcode SDK 26.5, Swift 6.3.3. The SDK's `Speech.swiftinterface` confirms `SpeechAnalyzer.finalize(through:)`, `finalizeAndFinishThroughEndOfInput()`, `AnalyzerInput(buffer:bufferStartTime:)`, `bestAvailableAudioFormat(compatibleWith:considering:)`, `SpeechTranscriber.isAvailable`, `.volatileResults`, `.fastResults`, `.audioTimeRange`, `AnalysisContext.contextualStrings`, and the `SFSpeechError.Code.insufficientResources` error. `ignoresResourceLimits` and `AnalyzerInputConverter` are **macOS 27 only** and must not be used (deployment target is 26).

**Decisions the user made (28 Sep 2026), do not revisit:**
- Keep macOS 14.2 support; older macOS uses OpenAI and gets a first-run screen with the OpenAI key only. macOS 26+ is asked nothing.
- Existing users with an OpenAI key keep OpenAI after the update.
- Test first (Phase 0), then build.
- Chat without an OpenRouter key shows the same key prompt.

## §3 Acceptance criteria

- [ ] Phase 0 report delivered to the user and a go received (§4.0).
- [ ] `npm run typecheck`, `npm test`, `npm run build:web`, `npm run build:desktop` pass. Tests stay offline and do not need macOS 26 (the helper is faked).
- [ ] `npm run build:transcribe` builds `native/transcribe/.build/release/tattle-transcribe`; `otool -l` on it shows `minos 26.0`.
- [ ] Fresh state on this Mac (no `credentials.json`, no `settings.json`, no `.env` keys): `npm run app` opens the app, not the setup screen; `GET /api/transcription` reports `engine: "apple"`; a live show with fact-check and labels off produces a transcript with live text; `transcriptions.jsonl` rows have `engine: "apple"` and `usd: 0`; no request goes to `api.openai.com` or `openrouter.ai` (check with `nettop -m route` or Little Snitch, or by running with Wi-Fi off after the model is installed).
- [ ] Same fresh state, Start live: the switches start **off**; switching one on shows the OpenRouter key prompt inside the Start dialog; "Not now" turns it back off; a valid key keeps it on and the show runs with fact-checking.
- [ ] `POST /api/session/start` with `features.factcheck: true` and no OpenRouter key → 400 with `needsKey: "openrouter"`. Chat routes with no key → 400 with `needsKey: "openrouter"`, and opening Chat shows the prompt.
- [ ] Simulated old macOS (`TATTLE_FORCE_NO_APPLE_SPEECH=1`, §4.3): fresh state shows the setup screen with **only** the OpenAI field; after saving it the app opens with `engine: "openai"`.
- [ ] Upgrade path: with an OpenAI key saved and no `settings.json`, first boot resolves and saves `engine: "openai"`.
- [ ] Settings → Transcription switches engines (refused with 409 while a session is on air); choosing OpenAI with no key shows the OpenAI key card first.
- [ ] `session.json` and `session.started` carry `transcription: { engine, … }`.
- [ ] The packaged app (`npm run dist:mac`) contains `Contents/Resources/bin/tattle-transcribe`, signed by the same team (`codesign -dv`), its `Info.plist` has `NSSpeechRecognitionUsageDescription`, `minimumSystemVersion` is still 14.2, and a Gatekeeper check passes (`spctl -a -vv`).
- [ ] Docs updated through `update-doc` (§4.10).

## §4 The work

### §4.0 Phase 0 — prove it on this Mac, then STOP

**Why.** Two facts decide whether this ships as designed and neither is documented: whether macOS 26 runs **two** `SpeechTranscriber` analyses at once, and how accurate it is on this show compared with OpenAI.

**Where.** A throwaway Swift package **outside the repository** (your session scratchpad). Nothing from Phase 0 is committed. It may later be copied into `native/transcribe/` (§4.1).

**Input.** A real recorded episode: `sessions/20260925-202620/` (≈1 h 57 min; `host.wav` and `remote.wav` are 16 kHz mono PCM16 with a 44-byte header; `events.jsonl` has 1,656 `utterance` events with OpenAI's `text`, `stream`, `startMs`, `endMs` — the reference). The same recording is in `~/Library/Application Support/Tattle/sessions/`.

**Build a CLI that:**
1. Installs the `en-US` model if needed (`AssetInventory.assetInstallationRequest(supporting:)` → `downloadAndInstall()`), printing progress, time, and whether macOS showed any prompt.
2. Starts **two** `SpeechAnalyzer`s, each with its own `SpeechTranscriber(locale:transcriptionOptions:[], reportingOptions:[.volatileResults], attributeOptions:[.audioTimeRange])` and its own `AsyncStream<AnalyzerInput>`. Get the locale from `SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US"))`.
3. Feeds `host.wav` and `remote.wav` **in real time** (100 ms buffers with `bufferStartTime`, converted with `AVAudioConverter` to `bestAvailableAudioFormat`) for at least 15 minutes, then the rest at max speed.
4. Calls `finalize(through:)` at the end time of every reference utterance on its stream (as the app will, §4.2) and measures the time until the final results for that range arrive.
5. Writes the final runs with their time ranges to JSON.

**Measure and report (one table):**
- Did both analyses run for the whole period with no `insufficientResources` or other error? Any stall?
- `finalize(through:)` → final-result latency: p50 / p95 / max. (Today's final layer: ~2.5 s after the speaker stops.)
- First volatile text after speech starts: p50. (Today's live layer: ~1.2 s.)
- Word error rate against OpenAI's text, per stream and overall, with words assigned to utterances by the midpoint rule of §4.2. Normalize case and punctuation before comparing. Include 20 sampled utterance pairs and every utterance where OpenAI's text contains "Jev" or a speaker name.
- Does the output have punctuation and capitalization?
- With `AnalysisContext` `contextualStrings[.general] = ["Jev", "TypeSafe", "Riverside", "GPT-6 Luna"]` set on the analyzer (`setContext`), does the "Jev" count change? (Undocumented for `SpeechTranscriber`; this answers it.)
- CPU % and memory of the process while both run in real time (`top -pid`).
- Did a **Speech Recognition** permission prompt appear when run from Terminal? Is there an entry under System Settings → Privacy & Security → Speech Recognition afterwards?
- Model download size and time.

**Done when:** the report is in the chat and the user has replied.

**Stop and ask (always — this phase ends with a stop).** Specifically flag:
- Two analyses cannot run at once on macOS 26 → the design needs a change. Offer: (a) Apple Speech only on macOS 27+ (with `ignoresResourceLimits`; recheck availability), (b) one analyzer fed the two streams interleaved per utterance (loses live text on one stream), (c) drop the feature.
- p95 finalize latency > 5 s, or overall word error rate more than 10 points worse than OpenAI → ask whether Apple Speech should still be the default.
- `contextualStrings` clearly helps → ask whether to feed it the speakers' names and `transcription.keywords` (small addition to §4.1/§4.2).

**Results (29 Sep 2026; the user chose clips for the final layer).** Measured on the reference episode, against OpenAI's text with fillers and number words normalized:
- Two analyses at once ran for the whole 1 h 57 min with no error; four at once (two streams plus two clips) also did.
- `finalize(through:)` at each utterance end **destroys words** whatever its timing (through end + 400 ms, or called 2 s late): 25 % disagreement, 17 % of words deleted, ~22 % of lines empty. It returns in 74 ms p50 / 179 ms p95.
- Unfinalized streaming finals disagree 9.6 %, but arrive 3.4 s p50 / 12.6 s p95 / 22.8 s max after the speaker stops.
- **One clip per utterance** (its own short-lived analyzer, ±300 ms of padding, two at once): 9.3 % disagreement, 8 of 1,581 lines empty, 0.3 s p50 / 0.9 s p95 per clip; "Jev" 23 times where OpenAI has 36 (others become "Jeff", "Jeb", "Javi"). The first analyzer and the first clip start cold: 0.35–7 s and 11 s.
- Runs are word-level and all carry `audioTimeRange`, but the first word after a pause has its start stretched back over the pause: word **end** times are reliable, starts and midpoints are not.
- First live (volatile) text: 2.0 s p50, 3.8 s p95 after speech starts (OpenAI's live layer: ~1.2 s).
- `contextualStrings`: no effect (16 "Jev" with and without). Punctuation and capitalization: yes.
- No Speech Recognition permission request (none in the `tccd` log). The en-US model (~155 MB) was already on this Mac; `--install` only allocated it (1.3 s), with no prompt. The download on a Mac without it is unmeasured.
- The model runs in Apple's `localspeechrecognition` XPC service: 4.5 % of one core p50 with two real-time streams, 135–209 MB.

So the final text comes from clips, and the stream analyzers only feed live text and are **never finalized** (§4.1, §4.2).

---

### §4.1 The `tattle-transcribe` Swift helper

**Where it lives (new).** `native/transcribe/Package.swift`, `native/transcribe/Info.plist`, `native/transcribe/Sources/tattle-transcribe/*.swift`. Mirror `native/capture/` exactly: swift-tools 6.0, Swift 5 language mode, `-sectcreate __TEXT __info_plist` linker flags (`native/capture/Package.swift:5-17`), frameworks `Speech`, `AVFoundation`, `CoreMedia`. Platform: `.macOS("26.0")`. `Info.plist`: bundle id `com.cloudlesslabs.tattle-transcribe`, plus `NSSpeechRecognitionUsageDescription` ("Tattle transcribes your conversations on this Mac. Audio never leaves it.").

**Commands.**
- `--status` → one JSON line: `{"available":bool,"reason":string|null,"locale":"en_US"|null,"installed":bool}`. `available` is `SpeechTranscriber.isAvailable` and a supported locale equivalent to `--locale` (default `en-US`).
- `--install` → JSON lines `{"type":"progress","fraction":0.42}` … then `{"type":"installed"}` or `{"type":"error","message":…}`; exit 0 / non-zero. Idempotent.
- Default (run) mode: reads binary frames from **stdin**, writes **JSON lines to stdout**, diagnostics as JSON lines to **stderr** (same convention as capture's stderr). Options: `--locale` (default `en-US`), `--live` (run the stream analyzers for live text), `--clip-concurrency` (2). Exits cleanly when stdin closes, after the queued clips finish and `finalizeAndFinishThroughEndOfInput()` on the stream analyzers.

**Stdin frames (little-endian).** Header: magic `PTRX` (4 bytes), `kind` u8, `stream` u8 (0 host, 1 remote), 2 reserved bytes. Then by kind:
- `0` audio (sent only with `--live`): `startMs` f64 (session time of the first sample), `count` u32, `count` × PCM16 at 16 kHz mono, fed to that stream's analyzer.
- `1` retired: a clip cut by the helper from streamed audio. Built first, it failed the §4.2 replay: at `--speed max` the engine streams audio faster than the helper reads it (about 30× real time per stream), so every clip waited behind it and timed out. The engine cuts clips itself (§4.2).
- `2` clip: `idLen` u32, UTF-8 utterance id, `count` u32, samples; `stream` is ignored. Kept for `scripts/transcribe-test.sh`.
- `3` clip in a file: `idLen` u32, id, `pathLen` u32, UTF-8 path of a file of PCM16 samples, which the helper reads and deletes. The engine uses this one: a clip (100–300 KB) is larger than a pipe holds, so on stdin a busy engine delivered it over several turns of its event loop (40 clips: 49 s with 50 ms turns, 139 s with 200 ms turns; 16 s either way through files, measured in §4.2). The engine writes each clip into its own `mkdtemp` folder (mode 0600), deletes any the helper did not, and removes the folder at `close`.

Every clip is transcribed by its own short-lived `SpeechAnalyzer` (`analyzeSequence`, then `finalizeAndFinishThroughEndOfInput`), at most `--clip-concurrency` at once, in arrival order. **Never call `finalize(through:)` on a stream analyzer**: Phase 0 showed it drops the words that follow (§4.0). Without `--live`, one analyzer is started and never fed, to keep the model loaded between clips (found in §4.2: without it a clip's p90 was 2.1 s and its max 3.4 s, against 0.7 s and 0.8 s). Do not use `SpeechAnalyzer.Options(modelRetention: .lingering | .processLifetime)` for this: with either, a later clip never answered.

**Stdout lines.**
- `{"type":"ready","locale":"en_US"}` once the stream analyzers (with `--live`) have started **and** one warm-up clip (1 s of silence) has finished: the first clip starts cold (11 s in Phase 0).
- `{"type":"volatile","stream":"host","runs":[{"text":…,"startMs":…,"endMs":…}]}` and `{"type":"final","stream":"host","runs":[…]}` from the stream analyzers (with `--live` only), for live text: one entry per attributed-string run that has an `audioTimeRange`, times in session ms (analyzer time + the `bufferStartTime` base).
- `{"type":"clip","id":…,"text":…}` or `{"type":"clip","id":…,"error":…}`
- `{"type":"error","message":…,"fatal":bool}`

**How.** With `--live`, one `SpeechAnalyzer` per stream, created lazily on that stream's first audio frame, each with its own `AsyncStream<AnalyzerInput>` continuation. `AnalyzerInput(buffer:bufferStartTime:)` with `CMTime(seconds: startMs/1000, preferredTimescale: 16000)`. Convert with one `AVAudioConverter` per stream to `bestAvailableAudioFormat(compatibleWith:considering:)` (16 kHz Int16 mono on macOS 26.2: no conversion needed). Before the run, if the model is not installed, write a fatal error (`"model not installed"`) and exit 3; the engine installs it first (§4.3). Use Phase 0's code for everything it proved.

**Done when:** `swift build -c release --package-path native/transcribe` succeeds; `--status` prints `installed: true` on this Mac; piping a 30 s excerpt of `host.wav` as audio frames with `--live`, plus one clip frame, prints volatile lines and then the clip line (write this as a small script under `scripts/`, see §4.9).

**Stop and ask if:** a result run carries no `audioTimeRange`, or run times do not line up with `bufferStartTime` (off by more than 100 ms from the audio).

### §4.2 The engine side: `AppleSpeech` in `src/transcribe/apple.ts` (new)

**Where it plugs in.**
- `Services.transcribe(utteranceId, samples, context?)` — `src/pipeline/session.ts:44`. The session already depends on this interface, not on the OpenAI class.
- `Session.realServices` — `session.ts:229` (builds `new Transcriber(...)` at :234, wires it at :245).
- `LiveTranscriber` — `src/transcribe/live.ts:72`: `warm(stream)` :91, `feed(stream, samples, speaking)` :193, `commit(stream, utteranceId)` :219, `close()` :247, and `onPartial` in `LiveDeps` (:43). The session constructs it at `session.ts:151` only when `opts.liveText && liveCfg.enabled`, emits `utterance.partial` at :155, and calls `warm` :159, `feed` :301, `commit` :328, `close` :499.
- `Session.onUtterance` — `session.ts:318`: `commit` then `services.transcribe(u.id, u.samples, context)` at :330. The retry pass calls `services.transcribe` again at ≈:379.
- The page's partial contract — `web/src/state.ts:212-227`: a partial is keyed by `itemId`, ignored if its `utteranceId` already landed, and removed when the `utterance` with that id arrives.

**How.**
1. `AppleSpeech` spawns the helper (`appPaths().transcriber`, §4.8) once per session, with the NativeSource pattern for restarts (`src/audio/nativeSource.ts`): an unexpected exit is restarted up to 3 times per session, 1 s apart, with an `error` event each time.
2. It implements **LiveTranscriber's public shape** (`warm`, `feed`, `commit`, `close`, `onPartial`), so the session holds it in `this.live`. When the engine is `apple`, the session constructs it **always** (clips are cut from the audio it is fed), passing `emitPartials: opts.liveText && liveCfg.enabled`, which starts the helper with `--live`.
3. `feed(stream, samples, _speaking)` keeps the last 60 s of **every** frame, silence included, and with live text also sends it as audio frames. `startMs` comes from a per-stream sample counter from session start. The session already feeds contiguous frames with gaps filled by silence, and after pause and speaker-mode muting, so what Apple hears is exactly what is stored in the WAVs. After a helper restart, send from the current counter.
4. **Final text.** Extend `Services.transcribe` with an optional 4th argument, `span?: { stream; startMs; endMs }`. `onUtterance` passes it; the retry pass does not. OpenAI ignores it.
   - With a `span`: cut `[startMs − clipPadMs, endMs + clipPadMs]` from that stream's last 60 s and send it as a clip (kind 3, a file). Without one (retries), or when that audio is no longer held: send `samples`. The engine sends at most `clipConcurrency` clips at a time and queues the rest, and a clip's timeout starts when it is sent, so a `--speed max` replay does not time out a backlog.
   - No `clip` answer within `apple.clipTimeoutMs`, a clip `error`, or the helper died → return `{ ok:false, error, retryable:true }`, so the existing retry machinery keeps the line (`docs/transcription.md` § "A failed line keeps its place").
   - Then apply the same post-processing the OpenAI path applies (`transcription.fixes`, the filler rule, empty → dropped). Reuse those functions; do not copy them.
5. **Live text.** From the stream's `volatile` and `final` lines, emit `utterance.partial` `{ stream, itemId: "apple-<stream>-<n>", text, utteranceId: null, final: false }`, built from the stream's final runs whose `endMs − 100` lies after its last committed `endMs + 150`, then its current volatile text, so text already handed to a finished line never reappears. Use end times, never starts or midpoints: the first word after a pause has its start stretched back over the pause (§4.0). A volatile result is **one run over its whole unsettled range, with no word times** (found in §4.1), and it lags the speech by a second or two, so a line's last words arrive after the VAD has closed it. So each closed line remembers how many words of the unsettled text (same range start) are its own: first as many as had arrived at the commit, then, once its clip is transcribed, as many as the clip has. Those words are stripped from later volatile text with that range start, and a partial that becomes empty is sent empty (the page hides it). Found in §4.2: without the clip's count, 9 of 12 live items on the fixture began with the previous line's tail; with it, the tail shows for about 0.3 s. On `commit(stream, id)`, re-emit the current partial with `utteranceId: id`, `final: true`, then increment `n`. The page then removes it when the final line lands — no page change needed.
6. **Cost and logging.** Nothing goes to the budget. Log a `transcriptions.jsonl` row per utterance, shaped like the OpenAI row (read what `src/transcribe/openai.ts:131` logs), with `engine: "apple"` and `usd: 0`. Add `engine: "openai"` to the OpenAI rows.
7. Config: add `transcription.apple: { locale: "en-US", clipPadMs: 300, clipConcurrency: 2, clipTimeoutMs: 20000 }` (the timeout is `clipTimeoutMs` plus twice the clip's length: it catches a stuck helper; the §4.2 replay on a loaded Mac took up to 5.4 s for a short clip, so 8 s failed lines that were only slow) to `config/app.json` and to the strict zod schema in `src/config.ts:29` (optional, with those defaults). The **engine choice is not in `config/app.json`** (it is a user setting, §4.3).

**Done when:** unit tests cover the frame encoder, the padded cut vs the samples (retries), clip timeout → `retryable`, helper death → `retryable`, and the live-text end-time filter — all with a fake child process. `npm run replay -- --host sessions/20260925-202620/host.wav --remote sessions/20260925-202620/remote.wav --speed max --engine apple` completes and writes a transcript.

**Stop and ask if:** the replay's transcript disagrees with the reference session's OpenAI text by more than 12 % (Phase 0: 9.3 %), more than 2 % of its lines come back empty, or the page shows duplicated live text that §4.2.5 does not remove.

### §4.3 The engine setting: resolution, storage, API

**New file `src/settings.ts`.** A `SettingsStore` for `appSupportDir()/settings.json` (`src/paths.ts`), written atomically like `KeyStore` in `src/keys.ts:42` (read that and copy its write pattern). Shape: `{ "transcriptionEngine": "apple" | "openai" }`. Shared by the Mac app and `npm run serve`, like `credentials.json`.

**Apple availability** (`src/transcribe/apple.ts`, exported `appleSpeechStatus()`):
- If `os.release()` major is below 25 (macOS < 26), or env `TATTLE_FORCE_NO_APPLE_SPEECH=1` → `{ available:false, reason:"Needs macOS 26 or later" }`, without spawning anything (the binary cannot load there).
- Otherwise run `--status` (5 s timeout) and cache the answer for the engine's lifetime.
- The model state is `missing | installing (fraction) | installed | error`.

**Resolution at boot** (a pure exported function `resolveEngine({ saved, openaiKeySet, apple })`, unit-tested):
- `saved` present → use it; but if `saved === "apple"` and Apple is definitively unavailable → effective `"openai"` (do not overwrite `saved`).
- No `saved`:
  - an OpenAI key is set (file or env) → `"openai"`, the upgrade path;
  - otherwise Apple available → `"apple"`;
  - otherwise → `"openai"`.
- **Persist** the resolved value, except when the `--status` check errored or timed out. Then the effective engine is `"apple"` with model state `error`: never send a macOS 26 user to the OpenAI screen because of a transient failure.

**Model preparation.** Whenever the effective engine is `apple` and the model is not installed, the engine runs `--install` in the background at boot, and again when the user switches to Apple. Progress goes out as a `transcription.status` event (transient, like `utterance.partial`: add it to `TRANSIENT` at `session.ts:41` or the bus equivalent) and in `GET /api/transcription`.

**Routes** (in `createApiServer`, `src/server/main.ts:675`; gated like the rest):
- `GET /api/transcription` → `{ engine, saved, apple: { available, reason, model, fraction }, openai: { keySet } }`.
- `PUT /api/transcription { engine }` → 409 while a session is on air; 400 `needsKey:"openai"` when choosing OpenAI with no key; 400 when choosing Apple while unavailable. Saves, starts the install if needed, returns the new status.
- `POST /api/transcription/install` → retries a failed install.

**Sessions.** `Engine.start` (`main.ts:394`) reads the effective engine at start. The session records `transcription: { engine, model | locale }` in `session.json` (`Session.runInner`, `session.ts:266-272`, next to `features` at :270) and in `session.started` (:273-277). Replays from the page use the current engine.

**Done when:** tests cover the `resolveEngine` matrix (fresh macOS 26 → apple; fresh old macOS → openai; OpenAI key saved → openai; saved apple on an unavailable Mac → openai, not persisted; status error → apple, not persisted) and the PUT 409 / 400 cases.

### §4.4 The setup gate: required keys follow the engine

**Where.**
- `KeySetup.status()` — `src/keys.ts:187` (today `configured: keys.every(set)`).
- The 503 gate — `src/server/main.ts:691-693`.
- `OPEN_ROUTES` — `main.ts:673`.
- `bootEngine` — `main.ts:806`: builds `KeySetup` at :809 with the models to check at :811; logs missing keys at :834; the `--replay` needs-both-keys check is at :837-838.
- `web/src/main.ts:9-13`: `setupStatus()` → `showSetup` or `import("./app.js")`.
- `showSetup` — `web/src/keys.ts:120`; `GUIDES` :20.

**How.**
- `status()` gains `required: KeyName[]`: `["openai"]` when the effective engine is `openai`, `[]` otherwise. `configured` = every required key is set. OpenRouter is never required.
- `showSetup` renders **only the required missing keys**, so the first-run screen is OpenAI-only. It gets a line explaining why: "On-device transcription needs macOS 26 or later. On this Mac, Tattle transcribes with OpenAI." Remove the OpenRouter guide from the first-run path, but keep `GUIDES.openrouter` for the prompts in §4.5–§4.7. Update the header comments that say "two keys" (`web/src/main.ts:1`, `src/keys.ts:1`, `web/src/keys.ts:117`, `:210`).
- `bootEngine`'s logs and the `--replay` check require only what the engine and the requested features need.
- `KeySetup.save` and `POST /api/setup/keys` are unchanged: they already take either key alone.

**Done when:** `tests/keys.test.ts` is updated. Its "only the setup routes answer until both keys are saved" test (:128) becomes: with engine `openai` and no OpenAI key → 503; with engine `apple` and no keys → 200. New cases cover `required`. The fresh-state and simulated-old-macOS criteria in §3 pass by hand.

### §4.5 Start live: ask for OpenRouter only when a switch needs it

**Where.**
- Markup: `#dlg-start` at `web/index.html:208`; switches `#feat-factcheck` :222 and `#feat-labels` :226; `#start-summary` :230.
- `web/src/panels.ts`: `PER_HOUR = {transcript:1.23, jev:0.04, factcheck:0.35}` :174, `renderStartSummary` :179, `openStartLive` :187, `bindStartLive` :199 (builds `features` at :207, posts at :211).
- `keyCard` — `web/src/keys.ts:223`: the reusable per-key form. Reuse it; do not build another.
- The server's `parseFeatures` (≈`main.ts:62`) and `Engine.start` (:394-396).

**How.**
- The page knows whether the OpenRouter key is set (from `GET /api/setup`) and the effective engine (from `GET /api/transcription`).
- `openStartLive`: the switches start **on** when the OpenRouter key is set, as today, and **off** when it is not.
- Switching one on with no key reveals an inline panel **inside `#dlg-start`**, never a popover outside it (gotcha: everything outside an open modal is inert). The panel has the heading *"Please provide your OpenRouter API key to configure fact-checking or labeling."*, a `keyCard('openrouter')` with its guide, **Save**, and **Not now**.
  - Save → `POST /api/setup/keys { openrouter }`. On success the panel closes and the switch stays on; on failure `keyCard` shows the reason.
  - Not now → every switch that needs the key goes back off.
  - Pressing Start with a switch on and no key opens the panel instead of starting.
- `renderStartSummary`: the transcript line depends on the engine. Apple: "Transcript: free, on this Mac". OpenAI: $1.23 an hour, as today.
- When the engine is Apple and the model is not `installed`: Start is disabled and the summary shows "Getting on-device speech recognition ready… 42 %". On `error` it shows the message, with **Try again** (`POST /api/transcription/install`) and a link to Settings → Transcription.
- Server (`Engine.start`, for both live and replay):
  - features needing OpenRouter and no key → 400 `{ error, needsKey:"openrouter" }`;
  - engine `openai` and no key → 400 `needsKey:"openai"`;
  - engine `apple` and the model not installed → 409 `{ error, preparing:true }`.

**Done when:** the Start-live criteria in §3 pass by hand in `npm run app`, and a server test covers the three refusals.

### §4.6 Chat: the same prompt

**Where.**
- `openChat` — `web/src/chat.ts:132`; `chatOpened` :167.
- Chat routes — `src/server/main.ts:746-760`; the key is read lazily at :157.
- `ChatService.stream` — `src/chat/chat.ts:555`, which today turns a 401 into "OpenRouter rejected the API key (401)…" at :633.

**How.**
- Chat routes answer 400 `{ error, needsKey:"openrouter" }` when no key is set, before calling OpenRouter.
- `openChat`, with no key, shows the same inline panel inside the chat dialog: *"Please provide your OpenRouter API key to use Chat."*, then `keyCard('openrouter')`, then Save. Saving continues into the chat.

**Done when:** a server test covers the 400, and opening Chat with no key shows the panel.

### §4.7 Settings: a Transcription panel; both keys optional

**Where.**
- Cog menu items — `web/index.html:80-86` (the API keys item is at :86, its dialog `#dlg-keys` at :197).
- `PANELS` — `web/src/router.ts:22`. `renderMenu` — `web/src/panels.ts:339` (one-line summaries). `bindControls` — `panels.ts:118`.
- Dialog rendering — `web/src/app.ts:78-79`; `openPanel` :212.
- `renderKeys` — `web/src/keys.ts:247`.

**How.**
- Add a cog item **Transcription**, with a `#dlg-transcription` dialog and a `transcription` entry in `PANELS`, so it gets a URL like the others. Its `renderMenu` summary is "On this Mac" or "OpenAI".
- The dialog has two radio choices:
  - **On this Mac (Apple Speech)** — "Free. Audio never leaves your Mac. Less accurate on names and jargon." Disabled with the reason when unavailable (e.g. "Needs macOS 26 or later"). Shows the model state and progress, with Try again on error.
  - **OpenAI** — "More accurate on names and jargon. About $1.23 an hour of show. Needs an OpenAI key." Choosing it without a key shows `keyCard('openai')` inline first, then saves the engine.
  - The whole dialog is read-only while a session is on air, with the reason.
- `renderKeys`: both keys are optional. OpenAI: "Needed only for OpenAI transcription." OpenRouter: "Needed for fact-checking, labels, and Chat." The Mac menu's **Settings…** keeps opening API keys.

**Done when:** switching engines in the dialog changes `GET /api/transcription` and the next session's `session.json`; the menu summary updates; the dialog is read-only on air.

### §4.8 The Mac app: ship the helper, prepare at first launch

**Where.**
- `AppPaths` and its defaults — `src/paths.ts:20-37`: add `transcriber`, default `native/transcribe/.build/release/tattle-transcribe`.
- `setAppPaths` in `desktop/main.ts:30-32`: add `resources/bin/tattle-transcribe`.
- `electron-builder.yml`: `extraResources` at :38-39 (add the second binary → `bin/tattle-transcribe`); `extendInfo` at :65-67 (add `NSSpeechRecognitionUsageDescription`, same text as §4.1). **Leave `minimumSystemVersion: "14.2"` (:60) alone.**
- `package.json`: add `build:transcribe` = `swift build -c release --package-path native/transcribe`, next to `build:capture` (:25).
- `scripts/build-mac.sh:14`: build it after `build:capture`. There is no copy or sign step to add: electron-builder copies and signs extraResources (`build-mac.sh:26-36`). Verify with `codesign -dv`.
- `askPermissions` — `desktop/main.ts:199-218`, the first-launch permissions sheet.

**How.**
- **If Phase 0 showed a Speech Recognition prompt:** the sheet also requests it up front when the engine is Apple, so it never interrupts a show. Add a `--request-permission` command to the helper (`SFSpeechRecognizer.requestAuthorization`, prints the status). Permissions are attributed to the app that launched the helper (gotchas § Capture), so the app's `Info.plist` must carry the usage string. **If no prompt appeared, add nothing here.**
- The model download needs no question: the engine starts it at boot (§4.3). The first launch must work while the download runs: everything but Start works, and Start shows progress (§4.5).
- Development: `README.md` § Develop gains `npm run build:transcribe`. `npm run app` and `serve` without the built helper → Apple is unavailable with reason "tattle-transcribe is not built (npm run build:transcribe)", not a crash.

**Done when:** the packaged-app criteria in §3 pass. A clean first launch of the packaged app on this Mac (no `settings.json`, no credentials) opens straight into the app and asks only for the macOS permissions.

**Stop and ask if:** notarization rejects the new binary, or the packaged helper fails to start (check its `codesign` entitlements against `tattle-capture`'s first).

### §4.9 Command-line tools

- `src/cli/replay.ts` and `npm run serve -- --replay`: use the saved engine; add `--engine apple|openai` to override.
- `src/cli/preflight.ts` (:84 builds the OpenAI `Transcriber`): check the effective engine. Apple → `--status` must report `installed: true`. OpenAI → today's check.
- `src/cli/smoke.ts` stays OpenAI-only: it is the paid live check of the OpenAI path.
- New `scripts/transcribe-test.sh` (the §4.1 excerpt test), and an `npm run transcribe:test` entry next to `capture:test`.

**Done when:** `npm run preflight` passes on this Mac with the engine on Apple and with no OpenRouter key, and the §4.2 replay command works.

### §4.10 Docs, through `update-doc`

Run `/update-doc` after the code. It must cover:
- `docs/transcription.md`: two engines; Apple's final layer (one clip per utterance) and live layer (stream analyzers, never finalized, and why: §4.0); the end-time filter for live text; config keys; cost $0.
- `docs/setup.md`: keys are optional; `required` follows the engine; the first-run screen is OpenAI-only on macOS < 26; the Start and Chat prompts; the new routes.
- `docs/architecture.md`: the helper, the Features section's cost line, `session.json`'s `transcription`.
- `docs/desktop.md`: the second binary, `NSSpeechRecognitionUsageDescription`, first launch.
- `docs/recordings.md`: the `transcription` field and the `engine` column in `transcriptions.jsonl`.
- `docs/gotchas.md`: every trap you hit.
- `README.md`:
  - Install: no API account needed on macOS 26+; on older macOS, an OpenAI account. OpenRouter optional, for fact-checking, labels, and Chat.
  - The privacy table (`README.md:39-48`): the audio row goes to OpenAI only with the OpenAI engine.
  - Costs (`:97`, `:99`), Develop, Scripts.
- `docs/rehearsal.md:35`: the cost.

`docs/mission.md` § Principles, "Plug and play for anyone", still says the first run asks for the two keys. **Propose** the new sentence to the user and edit only after they approve it. Suggested: "On macOS 26 or later a first run asks for nothing but the macOS permissions. Transcription runs on the Mac, and the OpenRouter key is asked for only when fact-checking, labels, or Chat need it. Older macOS asks for an OpenAI key."

**Done when:** `python3 .claude/skills/init-context/scripts/manifest-query.py --root . --index` lists the docs with updated descriptions, and grepping `two API keys|both keys` in `README.md docs/ web/src src desktop` finds only intended mentions.

## §5 Non-goals

- `SFSpeechRecognizer`, Whisper, WhisperKit, Parakeet, or any other local model. Apple `SpeechAnalyzer` only.
- `DictationTranscriber`: it uses Apple's older model. Revisit only if Phase 0 says so, with the user.
- Anything macOS 27 only (`ignoresResourceLimits`, `AnalyzerInputConverter`, `AssetInputSequenceProvider`), unless the user picks option (a) in §4.0.
- Raising `minimumSystemVersion` or dropping OpenAI.
- Languages other than English (mission non-goal), and a locale picker.
- Switching engines mid-session, or per show in the Start dialog. The choice lives in Settings only.
- Moving an existing user with an OpenAI key to Apple automatically.
- Changing the VAD, the speakers, the segmenter, Jev, the fact-checker, or how recordings are stored beyond the new fields.
- New npm dependencies. The helper uses Apple frameworks only.
- Changes to `npm run smoke`, the dev spend cap, or the release skill.
- Deleting a saved key (no UI for it exists today; do not add one).

## §6 Known uncertainties

Findings from the research, quoted where they were hedged:

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | Two analyses at once on macOS 26. | **Measured (§4.0):** two, and four, ran with no error. |
| 2 | Speech Recognition permission. | **Measured:** no request in the `tccd` log. Still ship `NSSpeechRecognitionUsageDescription` (app and helper); request nothing up front (§4.8). |
| 3 | Custom vocabulary with `contextualStrings`. | **Measured:** no effect. Do not wire it; `transcription.fixes` stays the tool. |
| 4 | Punctuation. | **Measured:** punctuation and capitalization are present. |
| 5 | Latency and effect of `finalize(through:)`. | **Measured:** fast (179 ms p95) but it destroys words. Not used: finals come from clips (§4.1). |
| 6 | Granularity of `audioTimeRange` runs. | **Measured:** word-level; starts are stretched over pauses, ends are reliable. Live text filters on end times (§4.2.5). |
| 7 | Whether the model download shows any prompt, and its size. | Allocating an already-downloaded model showed none. A Mac without the model is unmeasured: check it in §4.8 if one is available; if a prompt appears, stop and ask. |
| 8 | Accuracy against OpenAI on this show. | **Measured:** 9.3 % disagreement with clips. |
| 9 | Signing and notarizing a second helper binary: expected to work like the capture helper, but untested. | Verify with `codesign`, `spctl`, and a notarized `dist:mac` before calling §4.8 done. |

## §7 Guardrails

1. New files are limited to: `native/transcribe/**`, `src/transcribe/apple.ts`, `src/settings.ts`, `scripts/transcribe-test.sh`, and test files under `tests/`. Anything else, ask.
2. No npm dependency changes; the only `package.json` edits are the `build:transcribe` and `transcribe:test` scripts.
3. Reuse `keyCard`, `KeyStore`'s write pattern, the NativeSource restart pattern, and the OpenAI path's fixes and filler functions. Do not write parallel versions.
4. Every dialog UI goes **inside** its open `<dialog>` (gotcha: outside a modal is inert). Every Electron dialog goes through `ask()` in `desktop/main.ts` (gotcha: a parentless dialog freezes the engine).
5. Never log, store, or emit a key. The API returns only its last 4 characters, as today.
6. The helper must never be spawned on macOS < 26 (check `os.release()` first).
7. Tests stay offline and pass on any Mac: fake the helper through an injectable spawn, as the tests fake other services.
8. Do not change `minimumSystemVersion`, the dev spend cap, or `npm run smoke`.
9. Conventional commits, one task per commit, on `feat/local-transcription`. No push, no PR, no release without the user's go.
10. Do not edit `specs/`, including this file.

## §8 Verification

```bash
# gates
npm run typecheck && npm test && npm run build:web && npm run build:desktop
# helper
npm run build:transcribe && native/transcribe/.build/release/tattle-transcribe --status
otool -l native/transcribe/.build/release/tattle-transcribe | grep -A3 LC_BUILD_VERSION   # minos 26.0
npm run transcribe:test
# fresh first run (back up first, restore after)
D="$HOME/Library/Application Support/Tattle"
mv "$D/credentials.json" /tmp/ca-credentials.json.bak; mv "$D/settings.json" /tmp/ca-settings.json.bak 2>/dev/null
grep -n "OPENAI_API_KEY\|OPENROUTER_API_KEY" .env   # comment these out for the test, restore after
npm run app          # expect: straight into the app, no key screen
# simulated old macOS
TATTLE_FORCE_NO_APPLE_SPEECH=1 npm run serve   # http://127.0.0.1:4317 → OpenAI-only setup screen
# API checks (npm run serve)
curl -s http://127.0.0.1:4317/api/transcription | jq
curl -s -X POST http://127.0.0.1:4317/api/session/start -H 'content-type: application/json' \
  -d '{"mode":"live","features":{"factcheck":true,"labels":false}}' | jq   # 400 needsKey openrouter with no key
# replay with Apple against a real episode
npm run replay -- --host sessions/20260925-202620/host.wav --remote sessions/20260925-202620/remote.wav --speed max --engine apple
# packaged app
npm run dist:mac
codesign -dv "out/mac-arm64/Tattle.app/Contents/Resources/bin/tattle-transcribe"
spctl -a -vv "out/mac-arm64/Tattle.app"
# restore
mv /tmp/ca-credentials.json.bak "$D/credentials.json"; mv /tmp/ca-settings.json.bak "$D/settings.json" 2>/dev/null
```

The user's real keys live in `~/Library/Application Support/Tattle/credentials.json` and possibly `.env`. **Back them up before any fresh-state test, and restore them.** Never print them. The `out/` path is an assumption: check `electron-builder.yml`'s `directories.output`. A live show needs a real microphone and a call playing; for a hands-free check, use a speed-1 replay from the page.

## §9 Glossary

| Term | Meaning |
|---|---|
| Engine (transcription) | `apple` (on-device `SpeechAnalyzer`) or `openai` (`gpt-transcribe` + `gpt-live-transcribe`). |
| Final layer / live layer | The stored per-utterance transcript, which Jev reads / the streaming display text, which only the page reads (`docs/transcription.md`). |
| Utterance | One VAD-delimited piece of speech on one stream (`Utterance` in `src/audio/vad.ts:7`). |
| Stream | `host` (the Mac's microphone) or `remote` (the tap of everything the Mac plays, i.e. the call). |
| Volatile / final result | Apple's provisional text, which may still change, and its settled text. |
| Clip | One utterance's audio transcribed by its own short-lived analyzer: Apple's final layer. |
| Features | Fact-checking and labels, chosen per show in the Start live window, fixed for the session. |
| Helper | A native Swift command-line binary spawned by the engine: `tattle-capture` (exists), `tattle-transcribe` (new). |

## §10 References

- Docs: `docs/mission.md`, `docs/transcription.md`, `docs/setup.md`, `docs/architecture.md` (§ Capture, § Features), `docs/desktop.md`, `docs/gotchas.md` (§ Capture, § Web page, § Mac app), `docs/recordings.md`.
- Prior spec: `specs/-DONE/260924-01-live-conversation-assistant/`.
- Apple:
  - [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber)
  - [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer)
  - [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory)
  - [ReportingOption](https://developer.apple.com/documentation/speech/speechtranscriber/reportingoption)
  - [WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/)
  - [permission article](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition)
  - [contextualStrings](https://developer.apple.com/documentation/speech/analysiscontext/contextualstrings)
  - [locale matching (forums)](https://developer.apple.com/forums/thread/790108)
- Benchmarks:
  - [Argmax](https://www.argmaxinc.com/blog/apple-and-argmax)
  - [MacStories](https://www.macstories.net/stories/hands-on-how-apples-new-speech-apis-outpace-whisper-for-lightning-fast-transcription/)
- Prior art for a CLI helper:
  - [simonw/speech-analyzer-cli](https://github.com/simonw/speech-analyzer-cli)
  - [Electron + Swift helper, mic and system audio](https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant/pull/570)
- SDK interface, for exact signatures: `$(xcrun --sdk macosx --show-sdk-path)/System/Library/Frameworks/Speech.framework/Versions/A/Modules/Speech.swiftmodule/arm64e-apple-macos.swiftinterface`

### Code anchors

```
Services.transcribe          src/pipeline/session.ts:44
Session (live construct)     src/pipeline/session.ts:151-159
Session.realServices         src/pipeline/session.ts:229-245
Session.runInner (json)      src/pipeline/session.ts:266-277
Session.onUtterance          src/pipeline/session.ts:318-330
Transcriber / transcribe     src/transcribe/openai.ts:56 / :114
LiveTranscriber              src/transcribe/live.ts:72 (warm :91, feed :193, commit :219, close :247)
Utterance                    src/audio/vad.ts:7
transcription schema         src/config.ts:29
KeyStore / KeySetup.status   src/keys.ts:42 / :187
OPEN_ROUTES / gate           src/server/main.ts:673 / :691-693
Engine.start                 src/server/main.ts:394
bootEngine                   src/server/main.ts:806-838
chat routes                  src/server/main.ts:746-760
setup vs app                 web/src/main.ts:9-13
showSetup / keyCard / renderKeys   web/src/keys.ts:120 / :223 / :247
PER_HOUR / openStartLive / bindStartLive   web/src/panels.ts:174 / :187 / :199
renderMenu                   web/src/panels.ts:339
openChat                     web/src/chat.ts:132
partial handling             web/src/state.ts:212-227
PANELS                       web/src/router.ts:22
#dlg-start / cog items       web/index.html:208 / :80-86
AppPaths                     src/paths.ts:20-37
setAppPaths / askPermissions desktop/main.ts:30-32 / :199-218
extraResources / extendInfo  electron-builder.yml:38-39 / :65-67
```
