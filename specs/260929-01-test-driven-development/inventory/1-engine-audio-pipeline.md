> **Inventory for [SPEC.md](../SPEC.md) — Area 1: engine audio, speakers, transcription, pipeline (src/audio, src/speakers, src/transcribe, src/pipeline).** Written 2026-09-29 by a read-only scan of commit `74b42a6`. Line numbers were right at that commit; **symbol names win when lines drift** (grep them). "Spike" and "scratchpad" mentions refer to throwaway experiments run outside the repo during the scan; they are not available to you, but every recipe they validated is written out below. Items marked *unverified*/*UNSURE*/*hedged* are exactly that — verify before relying on them. SPEC.md overrides this file wherever they disagree (scope, thresholds, bug policy, file layout).


# Scan: engine audio / speakers / transcribe / pipeline

Scope: `src/audio/**` (6 files), `src/speakers/**` (2), `src/transcribe/**` (2), `src/pipeline/{session,segmenter,timeline,stats}.ts` (4). Tests read: `tests/{audio,echoGate,nativeSource,speakers,suggest,transcribe,live,segmenter,timeline,stats,session,retry}.test.ts`, `tests/helpers.ts`, `tests/setup.ts`. Docs read: architecture.md (Capture, Session pipeline, Features, Echo gate, Budgets, Tests), speakers.md, transcription.md, gotchas.md (Capture, sherpa-onnx, OpenAI, Test fixture).

All existing tests in the area pass (verified 2026-09-29: 9 fast files, 63 tests, 12 s; session/echoGate/retry, 18 tests, 28 s wall on 3 workers).

Two latent bugs were **confirmed by a scratchpad probe** (no project files touched): LiveStream clock going backwards (A2-L1) and live transcription billing unsent audio (T1-L1).

Conventions below: `path:line`. "Fake" = test double, no model/network. Items under "NOT covered" are `it("...")` one-liners: input/state → expected outcome.

---

## A1. `src/audio/source.ts` (65 lines)

**Purpose.** The `AudioSource` contract (16 kHz mono, 512-sample frames with `sessionMs`), `FileSource` (plays a WAV), and `mergeSources` (merges sources in `sessionMs` order).

**Exports.**
- `type StreamName = "host" | "remote"` :3; `FRAME_SAMPLES = 512` :4; `interface AudioFrame` :6; `interface AudioSource` :8; `type Speed = 1 | "max"` :13.
- `class FileSource` :18, with ctor `(path, stream, speed, now = () => performance.now())` :19 and `frames()` :21. It pads the last frame with zeros :31-35. At speed 1 it sleeps until `t0 + sessionMs` and skips waits of 1 ms or less :26-29. `sessionMs = off*1000/16000` :25.
- `interface TaggedFrame` :41.
- `async function* mergeSources(sources, onEnd?)` :47.
  - An empty array throws :48. Because this is an async generator, the error surfaces at the first `next()`, not at the call.
  - Primes every head in parallel :50, then calls `onEnd` for sources that were empty from the start :52.
  - Picks the strictly smallest `sessionMs` :56. On a tie the earlier source in the array wins.
  - Calls `onEnd` when a source ends :60-62.

**Side effects / deps.**
- `readWav16k` (sherpa-onnx native `readWave`, plus `LinearResampler` for other sample rates).
- The real `setTimeout` via `sleep` :15.
- `performance.now` by default.

**Seams.**
- The `now` ctor param :19.
- `sleep` uses the global `setTimeout`, so vitest fake timers can drive it.
- `mergeSources` takes any `AudioSource`, so inline fakes work. `nativeSource.test.ts` uses `LiveStream`. No shared ArraySource helper exists.

**Covered.**
- audio.test.ts "a single stream is enough"
- "boundaries within ±400 ms…", which merges the two fixture streams
- "speed 1 pacing within 5% of wall-clock over 10 s", which takes **10 s real time**

**NOT covered.**
- `it("FileSource yields ceil(n/512) frames with sessionMs = i*32 for a synthetic 1000-sample WAV")`: write via `encodeWav` to tmpdir; expect 2 frames at 0 and 32.
- `it("FileSource zero-pads the final frame to 512 samples")`: 600 samples; frame[1].samples.length is 512 and samples[88..] are 0.
- `it("FileSource on an empty WAV yields no frames")`: header only (encodeWav(new Float32Array(0))). Unverified: sherpa may reject 0-length data.
- `it("FileSource resamples a 48 kHz / 8 kHz WAV to 16 kHz")`: encodeWav(samples, 48000); frame count is about n/3/512.
- `it("FileSource speed 1 does not yield frame k before k*32 ms (fake timers + injected now)")`: replaces the 10 s real-time test. Use `vi.useFakeTimers({toFake:["setTimeout","Date"]})`, `now: () => Date.now()`, and `advanceTimersByTimeAsync`.
- `it("FileSource speed 1 skips waits of ≤1 ms")`: a now() that is already late gives no setTimeout call.
- `it("FileSource speed max never sleeps")`: spy on setTimeout; 0 calls.
- `it("mergeSources rejects on first next() when given []")`: `await expect(it.next()).rejects.toThrow("at least one audio source")`.
- `it("mergeSources interleaves two sources in sessionMs order")`: A at 0,64 and B at 32,96 give A,B,A,B with `stream` tags.
- `it("mergeSources breaks ties by array order")`: both at 0; the first source comes first.
- `it("mergeSources calls onEnd immediately for a source that yields nothing")`: onEnd(remote) before the first yield.
- `it("mergeSources calls onEnd once per source, in the order they end")`.
- `it("mergeSources propagates a source's thrown error")`: the consumer's for-await rejects.
- `it("mergeSources with a stalled source waits (does not emit the other source's frames past the stall)")`: a documented ordering property; LiveStream with no push, so a timeout race resolves nothing.

**Hard to test.** Real-time pacing: use fake timers as above. Nothing else is hard.

**Smells.**
- `mergeSources` never calls `return()` on the other iterators when the consumer breaks (Session.stop at session.ts:288 breaks). The suspended FileSource/LiveStream generators are left dangling. This is harmless for files. Unverified whether it leaks a LiveStream waiter.
- A source that never yields its first frame blocks everything at :50. That includes `Session.stop`, which only checks `stopRequested` per frame (session.ts:288).

## A2. `src/audio/nativeSource.ts` (250 lines)

**Purpose.** Node adapter for the Swift `tattle-capture` helper:
- the binary frame parser;
- the push-fed `LiveStream` (re-chunks to 512 samples, fills gaps with silence);
- `startNativeCapture`: spawn, status lines, clock offset, restarts, stop;
- `listDevices`.

**Exports.**
- `HEADER=20` :8 and `MAX_SAMPLES=160000` :9 (private consts).
- `interface HelperFrame` :11; `class MalformedFrameError` :13.
- `class FrameParser` :16, `push(chunk)` :19:
  - Buffers partial reads :20 and :29.
  - Checks, in order: magic `PCAP` :23; stream byte 0/1 :25; `n===0 || n>MAX || !finite(sessionMs) || sessionMs<0` :28.
  - Bytes 5-7 are reserved and never checked.
- `class LiveStream` :40:
  - `push(samples, sessionMs)` :51:
    - Ignored after `end` :52.
    - The first push sets the clock :54.
    - A positive gap is filled with zeros :56-57.
    - A negative gap drops the overlap :58-59.
    - Scaling is /32768 for negatives and /32767 for positives :61.
    - `nextMs = sessionMs + len/16` :62.
    - Emits 512-sample frames with `frameMs` :63-67.
  - `end()` :71; `frames()` async generator with a single waiter :82-88.
- `interface HelperProcess` :91; `type CaptureStatus` :100; `interface NativeCaptureOptions` :102; `interface NativeCapture` :116.
- `startNativeCapture(opts)` :126:
  - Default bin `appPaths().helper` :127.
  - The default spawn is real `child_process.spawn` with `env: childEnv()` :128, which strips the API key env vars.
  - Rejects if the bin is missing and no spawn was injected :129.
  - Args :138: `--mic X`, `--no-mic`, `--no-system`.
  - `launch()` :153:
    - The stdout handler ignores stale procs :163.
    - A parse error emits an error and SIGKILLs :167-171.
    - Frames are held until `started` :173.
  - stderr line handling :177-202:
    - JSON lines are parsed; a non-JSON line becomes `{type:"warning"}` :188.
    - `started` with a numeric `epochMs` sets `offsetMs = epochMs - sessionStart`, flushes held frames and emits health :191-195.
    - `error`/`warning` becomes `onStatus("error", {component:"capture", message, level})` :196-197.
    - Anything else becomes health :199.
  - exit handler :203-213:
    - Ignores a stale proc.
    - If stopping, ends all streams.
    - If `restarts >= maxRestarts`, emits an error and ends all streams.
    - Otherwise `restarts++`, emits an error, and relaunches after `restartDelayMs` (the timer callback ends all streams if stopping by then).
  - `stop()` :218:
    - Idempotent: returns `done`.
    - If there is no child or it already exited, ends all streams.
    - Otherwise `stdin.end()`, then SIGTERM at 2 s and SIGKILL at 5 s; awaits `done` and clears the timers.
  - Defaults: `maxRestarts` 3 :133, `restartDelayMs` 1000 :134, `sessionStart = Date.now()` :132.
- `listDevices(bin = appPaths().helper)` :238:
  - Rejects if the bin is missing.
  - Spawns `--list-devices` and rejects on a non-zero exit.
  - Otherwise parses stdout as JSON lines.

**Side effects.**
- `child_process.spawn`, `fs.existsSync`, `setTimeout` (restart and stop timers), `Date.now`, `appPaths()` global.
- `childEnv()` from `src/keys.ts`, which deletes the key env vars.

**Seams.**
- `opts.spawn`, `opts.bin`, `sessionStartEpochMs`, `restartDelayMs`, `maxRestarts`, `onStatus`.
- `listDevices` takes `bin`.
- `setAppPaths({helper})` in `src/paths.ts:52` can redirect the default bin.
- Existing fake: `class FakeHelper` in tests/nativeSource.test.ts:35-58. It is an EventEmitter with PassThrough stdio. stdin finish triggers `exit(0)`. `kill()` records the signal and exits. `started(epochMs)` writes a started line. `exit()` emits on setImmediate.
- Helpers in that file: `frameBytes()` :7, `ramp()` :17, `take()`/`all()` :19-33. All of them should be moved to a shared helper.

**Covered.** nativeSource.test.ts:
- "parses frames split at awkward boundaries"
- "rejects bad magic and impossible counts" (magic, n too big, bad stream)
- "512-sample Float32 frames; … gaps become silence"
- "overlapping samples are dropped"
- "maps helper time onto the session clock and restarts up to 3 times, then ends cleanly"
- "a malformed frame kills the helper and is handled as a crash"
- "stop closes stdin; warnings become capture errors"
- echoGate.test.ts drives the Engine with a fake `live` factory, not this module.

**NOT covered.**
- FrameParser:
  - `it("rejects n === 0")` → `/impossible/`
  - `it("rejects negative sessionMs")`
  - `it("rejects NaN / Infinity sessionMs")`
  - `it("accepts n === MAX_SAMPLES (160000) and rejects 160001")`
  - `it("returns [] for a partial header and completes on the next push")`
  - `it("keeps state across pushes after a full frame followed by 3 bytes of the next")`
  - `it("ignores reserved bytes 5..7")`: non-zero reserved bytes still parse.
- LiveStream:
  - `it("push after end() is ignored")`
  - `it("frames() ends immediately when end() is called with nothing queued")`
  - `it("a consumer waiting in frames() wakes on the next push")`: start `take(s,1)`, then push; it resolves.
  - `it("scales -32768 to -1 and 32767 to 1 exactly")`
  - `it("a push shorter than 512 samples yields no frame until enough accumulate")`
  - `it("an overlap larger than the push drops the whole push")`: push 1024@0, then 160@10. No new samples.
  - `it("a stale chunk entirely before the clock does not move the clock backwards")` (**currently fails**, see A2-L1). After push 1024@0, 160@10, 512@64, expect frame ms [0,32,64]. Today it yields [0,32,20,52].
  - `it("fractional sessionMs gaps round to whole samples")`
- startNativeCapture:
  - `it("rejects when the bin is missing and no spawn is injected")`: `bin: "/nonexistent"` → rejects `/not built/`.
  - `it("passes --mic, --no-mic, --no-system per options")`: capture spawn args for {mic:"X"}, {host:false}, {remote:false}.
  - `it("host:false exposes only the remote source and drops host frames")`
  - `it("remote:false exposes only the host source")`
  - `it("a non-JSON stderr line becomes a warning error event with the raw text")`
  - `it("stderr lines split across chunks are joined; blank lines skipped")`
  - `it("an {type:'error'} line emits level 'error'")`
  - `it("device_changed and other status types become health events {capture: st}")`
  - `it("started emits health with the status and status() returns the latest line")`
  - `it("started without numeric epochMs keeps frames held (no delivery)")`: documents the current behaviour. Frames are held forever, see A2-L4.
  - `it("frames from a stale (replaced) process are ignored")`
  - `it("maxRestarts: 0 ends capture on the first exit with 'after 0 restarts'")`
  - `it("stop() during the restart delay ends the streams and never relaunches")`: fake timers.
  - `it("stop() sends SIGTERM after 2 s and SIGKILL after 5 s when the helper ignores stdin")`: a FakeHelper variant with no exit-on-finish, plus fake timers.
  - `it("stop() twice returns the same done promise and closes stdin once")`
  - `it("stop() after the helper already exited resolves immediately")`
  - `it("sessionStartEpochMs defaults to Date.now()")`: fake Date.
  - `it("default spawn runs a real executable with API keys stripped from env")`: tmp shell script bin that prints `{"type":"started","epochMs":0}` and `{"type":"warning","message":"$OPENAI_API_KEY"}` to stderr and `cat`s stdin. Set `process.env.OPENAI_API_KEY`; expect the warning message to be "". No hardware.
- listDevices:
  - `it("rejects when the bin is missing")`
  - `it("resolves parsed JSON lines from a fake bin")`: tmp script echoing two JSON lines and exiting 0.
  - `it("rejects with the exit code on non-zero exit")`: script `exit 3` → `/exited with 3/`.
  - `it("rejects (does not crash) when a line is not JSON")` (**currently throws uncaught**, see A2-L2).

**Hard to test.**
- Real mic, system tap, and permissions: hardware only (`npm run capture:test`, preflight).
- Everything else works with FakeHelper and tmp shell scripts.
- Prefer `vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]})` over the current 30 ms real sleeps (nativeSource.test.ts:140,152,169), which are flaky under load. Keep `setImmediate` real, because FakeHelper.exit uses it.

**Smells / latent bugs.**
- **A2-L1 (confirmed):** `nativeSource.ts:62` sets `this.nextMs = sessionMs + samples.length/16` unconditionally. A chunk that lies entirely before the clock (possible after a helper restart whose `epochMs` offset lands slightly earlier) moves the clock back. The next push then inserts silence and emits non-monotonic `sessionMs`. Probe output: `[0, 32, 20, 52]`. A likely fix is `Math.max`.
- **A2-L2:** `listDevices` :247 calls `JSON.parse` inside the `exit` handler. A non-JSON line throws an uncaught exception and the promise never settles.
- **A2-L3:** `launch` :154 attaches no `'error'` listener to the spawned ChildProcess. A spawn failure other than a missing file (EACCES, or the binary deleted between check and spawn) emits an unhandled `'error'` event, which crashes the process. `HelperProcess` has no `error` event.
- **A2-L4:** a `started` line without a numeric `epochMs` goes to health (:199). Frames then accumulate in `held` without bound (:173).
- **A2-L5:** after a parse error, later chunks on the same (still-alive) proc call `parser.push` again on the still-bad buffer. Each call emits another error and another SIGKILL (:167-170) until the exit arrives. The result is duplicate error events.
- **A2-L6:** `stop()` :222 checks `proc.exitCode !== null`. A real ChildProcess killed by a signal has `exitCode === null` (it sets `signalCode`). Stopping during a restart delay after a signal crash therefore calls `stdin.end()` on a dead process and waits for the restart timer. It resolves only after `restartDelayMs`. Unverified whether `stdin.end()` on a dead pipe emits EPIPE unhandled.
- `restarts` never resets after a healthy run. This matches the docs ("up to 3 times per session"), so it is intended.

## A3. `src/audio/vad.ts` (99 lines)

**Purpose.** The `Utterance` type, the session-wide `UtteranceIds`, and `StreamVad`: one sherpa Silero VAD per stream that emits utterances with session-clock times.

**Exports.**
- `interface Utterance` :7.
- `class UtteranceIds` :16, `next()` → `u_1, u_2, …` :18.
- `class StreamVad` :24:
  - ctor `(stream, cfg: AppConfig["vad"], ids, modelPath = vadModelPath())` :32 builds `new sherpa.Vad({...windowSize:512}, 60)` :38.
  - `accept(samples, sessionMs)` :48:
    - The first frame sets `streamStartMs` :49; `watermark = sessionMs` :50.
    - Carries a remainder that is not a multiple of 512 :52-60.
    - Returns `drain()`.
  - `isDetected()` :64 is false once ended.
  - `flush()` :69:
    - Idempotent: returns [] if ended.
    - Uses `vad.flush()`, or falls back to about 1 s of silence frames when `flush` is missing :71-76.
    - Sets `ended=true` and `watermark=Infinity`.
  - private `drain()` :83:
    - Pops segments.
    - `startMs = streamStartMs + seg.start/16`.
    - Splits every `maxSpeechDuration*16000` samples :91-95. This is a code-side guard in case the native max is ignored.

**Side effects / deps.**
- sherpa-onnx native `Vad`.
- `models/silero_vad.onnx` via `vadModelPath()` (`appPaths().models`, overridable with `setAppPaths`).

**Seams.**
- `modelPath` param.
- No seam for the `Vad` instance. Options:
  - (a) `vi.mock("sherpa-onnx-node", …)` in a dedicated test file, supplying a `FakeVad` with a scripted `isEmpty/front/pop/acceptWaveform/isDetected/flush`;
  - (b) construct with the real model, then overwrite the private field: `(v as any).vad = fake`.
  - (b) needs no refactor but needs the model file (640 KB; construction is cheap).

**Covered.** audio.test.ts:
- "boundaries within ±400 ms for ≥ 90% of lines, none longer than 20 s": the fixture plus unique session-wide ids.
- "a single stream is enough"
- Indirectly: speakers.test, session tests.

**NOT covered (use FakeVad).**
- `it("accept feeds exact 512-sample windows and carries the remainder")`: frames of 300, 300, 500 → acceptWaveform calls with 512 samples each, 2 calls total, remainder 76.
- `it("accept records watermark = last frame sessionMs")`
- `it("utterance startMs = first frame's sessionMs + seg.start/16")`: first frame at 1000 ms, seg.start=1600 → startMs 1100.
- `it("drain splits a segment longer than maxSpeechDuration into consecutive utterances with consecutive ids")`: cfg max=1 s, seg 2.5 s → 3 utterances of 1 s, 1 s, 0.5 s with startMs +0/+1000/+2000.
- `it("ids are shared across StreamVads using one UtteranceIds")`
- `it("flush returns pending segments, sets ended, watermark Infinity, isDetected false")`
- `it("flush twice returns [] the second time and does not call vad.flush again")`
- `it("flush without vad.flush feeds 32 silence windows")`: fake without `flush`; expect acceptWaveform called 32 times (16000/512+1 = 32.25, so the loop runs 32 times).
- `it("isDetected delegates to vad.isDetected while not ended")`
- `it("real Silero: pure digital silence yields no utterances")`: uses the model; cheap.
- `it("real Silero: a 3 s slice of fixture host speech yields 1 utterance within ±400 ms")`: model plus fixture; faster than the full fixture.

**Hard to test.** Silero behaviour on synthetic tones is unverified (likely not speech). Use fixture slices for real-model assertions.

**Smells.**
- `watermark` is the *start* of the last frame, not its end. That is fine for the segmenter's `>=` comparison, just noted.
- `streamStartMs` assumes contiguous frames. LiveStream guarantees this; FileSource too.

## A4. `src/audio/wav.ts` (73 lines)

**Purpose.** WAV header, PCM16 conversion, in-memory encode, `readWav16k` via sherpa, and a streaming `WavWriter`.

**Exports.**
- `SAMPLE_RATE=16000` :4.
- `wavHeader(dataBytes, sampleRate)` :6: 44 bytes, PCM mono 16-bit.
- `toPcm16(samples)` :24: clamps to [-1,1]; negatives ×0x8000, positives ×0x7fff, rounded.
- `encodeWav(samples, sampleRate=16000)` :34.
- `readWav16k(path)` :40: `sherpa.readWave`, then `LinearResampler(...).flush(samples)` if the rate differs.
- `class WavWriter` :47:
  - The ctor opens the file and writes a 0-length header :52-53.
  - `write` is a no-op after close :56.
  - `samplesWritten` getter :63.
  - `close()` patches the header at offset 0 and is idempotent :67-72.

**Side effects.** Sync fs (`openSync/writeSync/closeSync`); sherpa native (`readWave`, `LinearResampler`; no model needed).

**Seams.** Pure functions; tmpdir paths.

**Covered.** audio.test.ts "encodeWav round-trips through sherpa.readWave", which covers WavWriter chunked writes equalling encodeWav plus a sherpa read back.

**NOT covered.**
- `it("wavHeader writes RIFF size 36+data, fmt 16, PCM 1, mono, rate, byteRate 2*rate, align 2, 16 bits, data size")`: 22050 Hz, 1000 bytes.
- `it("toPcm16 clamps 1.5→32767, -1.5→-32768, 1→32767, -1→-32768, 0→0")`
- `it("toPcm16 rounds 0.5/32767 correctly")`
- `it("encodeWav(samples, 8000) writes rate 8000 in the header")`
- `it("WavWriter.samplesWritten counts samples across writes")`
- `it("WavWriter.write after close is a no-op and close is idempotent")`: file size unchanged.
- `it("WavWriter header reads 0 data bytes before close (sizes unset while recording)")`: read bytes 40-43 before close.
- `it("readWav16k returns 16 kHz samples unchanged")`
- `it("readWav16k resamples 48 kHz to ≈ n/3 samples")`

**Smells.** None.

## A5. `src/audio/tags.ts` (45 lines)

**Purpose.** `rmsDbfs`, the per-stream `loud` tagger, and the cross-stream `overlap` predicate.

**Exports.**
- `type Tag` :3.
- `rmsDbfs(samples)` :5: -Infinity for empty or all zeros.
- private `median` :13.
- `class LoudTagger` :20, `tag(stream, samples)` :23:
  - Loud if the history is non-empty and db ≥ median + 6.
  - Only finite db values enter the history.
  - The history is capped at 50 (shift).
- `interface TimeRange` :36.
- `overlaps(u, others, minMs=1000)` :39: skips same-stream ranges; true if the intersection is ≥ minMs.

**Seams.** Pure.

**Covered.** audio.test.ts "loud is 6 dB above the stream's median" and "overlap needs ≥ 1000 ms on the other stream".

**NOT covered.**
- `it("rmsDbfs([]) and rmsDbfs(zeros) are -Infinity")`
- `it("rmsDbfs of a 0.5 constant ≈ -6.02")`
- `it("LoudTagger: the first utterance on a stream is never loud")`
- `it("LoudTagger: exactly +6 dB over the median is loud (>=)")`: 0.1 vs 0.1995 (6.0 dB).
- `it("LoudTagger: a silent utterance is never loud and is not added to history")`: after silence, a moderate level is still compared against the previous median.
- `it("LoudTagger: median over an even count averages the middle two")`
- `it("LoudTagger: history keeps only the last 50")`: 50 loud (0.5) then 1 quiet; the quiet one is not loud. With 50 quiet then 51 more quiet, the median is still quiet.
- `it("overlaps honours a custom minMs and is inclusive at exactly minMs")`
- `it("overlaps with no others is false")`

## A6. `src/audio/echoGate.ts` (74 lines)

**Purpose.** Speaker-mode mic gate: while active, host frames become silence while the call plays and for `holdMs` after.

**Exports.**
- `type OutputKind` :5; `interface EchoGateConfig` :7; `MAX_LEAD_MS=1000` :21 (private).
- `class EchoGate` :34:
  - `active = mode === "always"` :42.
  - `setOutput(kind)` :46: auto mode only. Active iff `kind === "speakers"`. Returns true on change. Going inactive resets `mutedMs`.
  - `remote(samples, sessionMs)` :56: if rms ≥ threshold, `playingUntilMs = sessionMs + len/16`. This is an assignment, not a max.
  - `host(samples, sessionMs)` :61:
    - Passes the frame through if inactive or `sessionMs >= playingUntil + holdMs`.
    - Passes it through if `playingUntil - sessionMs > 1000`.
    - Otherwise adds to `mutedMs` and returns a new zero array.
  - `takeMutedMs()` :69: returns the rounded value and resets it.

**Seams.** Pure; the config object.

**Covered.** echoGate.test.ts:
- "inactive, it returns every host frame unchanged"
- "follows the output device in auto mode…"
- "always and never ignore the output device"
- "mutes … for holdMs after"
- "the microphone always comes back…"
- "a call quieter than the threshold…"
- Session-level: "with the call leaking…" (12.6 s) and "with headphones… exactly the input". Engine-level: "a live session follows the helper's output device…".

**NOT covered.**
- `it("setOutput('virtual') is inactive")`
- `it("setOutput returns false in never mode even for speakers")`: already covered. Also cover `always` + null.
- `it("going inactive resets the muted counter")`: mute some frames, `setOutput("headphones")` → `takeMutedMs() === 0`. Partly covered.
- `it("host at exactly playingUntil+holdMs passes through (>=)")`
- `it("a lead of exactly 1000 ms still mutes; 1000.1 ms does not")`
- `it("a remote frame exactly at thresholdDbfs counts as playing")`
- `it("an empty remote frame is ignored")`
- `it("takeMutedMs rounds fractional ms")`: a 100-sample host frame is 6.25 ms → 6.
- `it("a later quiet remote frame does not shorten playingUntil")`
- `it("an earlier loud remote frame after a later one moves playingUntil back")`: documents the current assignment semantics at :57. Hedged: merge order makes this unlikely.

---

## S1. `src/speakers/registry.ts` (220 lines)

**Purpose.** WeSpeaker `Embedder`, and `SpeakerRegistry`, which assigns utterances to speakers per stream with a threshold, a placeholder rule, per-stream voice limits, rename, and merge.

**Exports.**
- `interface Speaker` :8; `interface Assignment` :15.
- `class Embedder` :23: ctor `(modelPath = speakerModelPath())` :26 builds `sherpa.SpeakerEmbeddingExtractor`; `dim` :30; `embed(samples)` :34.
- `type VoiceLimits` :43. Private `unit` :45 (zero vector → zeros, via `|| 1`) and `cosine` :52 (dot product).
- `class SpeakerRegistry` :65, ctor `(cfg, embedder, limits = cfg.voicesPerStream ?? {})` :75:
  - `assign(stream, samples)` :78: embeds only if `seconds >= minEmbedSeconds`, else passes null.
  - `assignEmbedding(stream, v|null, threshold=cfg.threshold)` :85:
    - null: the stream's last speaker (resolved, `utterances++`, inferred), or else create a placeholder (inferred, `created`) :86-95.
    - best match among `onStream(stream)` centroids ≥ threshold: add the embedding, `++`, set last :105-110.
    - Else placeholder adoption: the last speaker (resolved) has 0 embeddings, so it adopts `v` :113-119.
    - Else if `limit > 0 && onStream.length >= limit`: the closest speaker (or `resolve(last ?? onStream[0])` if there is no best) without adding the embedding :121-127.
    - Else create a new speaker with `v` :128.
  - private `onStream` :133 (active speakers whose stream set includes the stream); `create` :137; `addEmbedding` :148 (keeps the last `maxEmbeddingsPerSpeaker`); `recompute` :154 (centroid = unit(sum)).
  - `voiceprints()` :163 (talkMs always 0).
  - `resolve(id)` :171 (follows `mergedInto` chains).
  - `get` :177; `displayName` :181 (falls back to the id).
  - `rename(id, name)` :185: throws "unknown speaker <id>" or "displayName must not be empty"; trims.
  - `merge(from, into)` :194: resolves both; throws "unknown speaker" or "cannot merge a speaker into itself"; moves embeddings (capped), joins streams, sums utterances, sets `mergedInto`.
  - `list()` :213 (copies); `active()` :217.

**Side effects.** `Embedder` loads the 26 MB WeSpeaker model (`models/wespeaker_en_voxceleb_resnet34_LM.onnx`). The registry itself is pure.

**Seams.**
- `embedder` ctor param (structural). A fake `{ embed: vi.fn(() => vec), dim: 8 } as unknown as Embedder` needs no model.
- `limits` param.
- The existing speakers.test.ts constructs a **real Embedder** at describe level (:21), even for the pure `assignEmbedding` tests, where it only needs `embedder.dim`.

**Covered.** speakers.test.ts:
- "the fixture yields exactly 3 speakers…" (4.8 s; model plus fixture)
- "short utterances take the stream's last speaker, marked inferred"
- "a placeholder speaker … adopts the first voiceprint"
- "rename and merge"
- "a voice belongs to its stream, and a stream with all its voices reuses the closest one"

**NOT covered (fake embedder, no model).**
- `it("assign does not call embed below minEmbedSeconds and returns inferred")`: 1.49 s of samples → embed not called.
- `it("assign calls embed at exactly minEmbedSeconds")`: 24000 samples.
- `it("a match at exactly threshold is a match (>=)")`
- `it("assignEmbedding respects a custom threshold argument")`
- `it("keeps at most maxEmbeddingsPerSpeaker embeddings")`: 25 matches → `voiceprints()[0].sampled === 20`.
- `it("the centroid is the unit mean of kept embeddings")`: check via `voiceprints()`.
- `it("a zero-vector embedding does not match anyone and creates a speaker")`
- `it("voiceprints(): placeholder has centroid null, sampled 0; lines = utterances; talkMs 0; streams listed")`
- `it("voiceprints() excludes merged speakers")`
- `it("rename unknown id throws 'unknown speaker'")`
- `it("rename trims whitespace")`
- `it("rename of a merged id renames the survivor")`
- `it("merge unknown from/into throws 'unknown speaker'")`
- `it("merge an already-merged id into its survivor throws 'cannot merge … itself'")`
- `it("merge chains resolve transitively (a→b, b→c ⇒ resolve(a)=c)")`
- `it("merge sums utterances and joins streams: host lines can then match the merged remote speaker")`
- `it("merge caps the combined embeddings at maxEmbeddingsPerSpeaker")`
- `it("displayName/get of an unknown id returns the id / undefined")`
- `it("list() returns copies (mutating does not affect the registry)")`
- `it("a limit of 0 means unlimited")`
- `it("limit branch does not add the embedding to the chosen speaker")`: `sampled` unchanged.
- `it("limit branch sets lastOnStream so a later short line is inferred to that speaker")`
- `it("ctor default limits come from cfg.voicesPerStream")`
- Real model:
  - `it("Embedder.embed returns a Float32Array of length dim")`
  - `it("Embedder.embed is deterministic for the same clip")`

**Smells.**
- Registry.ts:123's fallback `this.resolve(last ?? onStream[0]!)` looks unreachable (unverified). If any on-stream speaker has a centroid, `best` is set. If none does, the last speaker is a placeholder and is adopted at :115. Flag for coverage: it may need a `/* c8 ignore */` or removal.
- `unit` and `cosine` are duplicated in suggest.ts:42-53.

## S2. `src/speakers/suggest.ts` (211 lines)

**Purpose.**
- `suggestMerges`: proposes merges per stream from voiceprints, using talk time, rename status, and voice limits.
- `recordedVoiceprints`: recomputes voiceprints from a recording folder's WAVs.

**Exports.**
- `interface Voiceprint` :11; `type Confidence` :24; `interface MergeSuggestion` :26.
- `BANDS = {high:.85, medium:.75, low:.65}` :40.
- `unit` :42; `cosine` :49; `centroidOf(vs)` :55 (null when empty).
- `SMALL_SHARE = 0.05` :65. Private `isDefaultName` :62 (`/^Speaker \d+$/`), `band` :67, `raise` :68, `mmss` :69.
- `suggestMerges(prints, limits={})` :83, for each stream in [host, remote]:
  - Groups whose `streams` include the stream; skips if fewer than 2 :90.
  - `total = sum talkMs || 1`.
  - `rank` :94: renamed first, then by talkMs desc, then by lines desc.
  - **Limit branch** (`limit>0 && groups>limit`) :100:
    - `kept` = the top `limit` by rank.
    - Others go in ascending talkMs order. Each goes to the best kept speaker by cosine. If there is no best (no centroid on either side), it goes to `kept[0]` with sim null and confidence medium if small, else low.
    - Otherwise the confidence is `band(sim)`, raised one level if small.
    - The reason names the similarity, talk, and "set for N voice(s)".
  - **Voice-only branch** :124:
    - Greedy most-similar pair while sim ≥ 0.65, over groups with centroids only.
    - `into` = rank winner.
    - Weighted re-centroid (weights `max(1, sampled)`) :139-142.
    - Chains resolved with `finalOf` (a 50-hop cap) :146. The reason adds ", via X".
  - The output is sorted by confidence, then by similarity desc (null counts as 0) :152-153.
- Private `readClip(fd, startMs, endMs)` :157: reads PCM16 at byte `44 + from*2`, /32768.
- `recordedVoiceprints(dir, embedder, resolve, names, perSpeaker=30)` :172:
  - Reads `utterances.jsonl`.
  - Groups by resolved speaker (lines, talkMs, per-stream counts). Clips must be not inferred and ≥ 2000 ms.
  - Opens `host.wav`/`remote.wav` if they exist.
  - Picks evenly spread clips, skips clips under 1 s after reading, embeds with `unit`, and yields `setImmediate` between embeddings.
  - `home` stream = majority.
  - `name = names.get(id) ?? id`.
  - Closes the fds in `finally`.

**Side effects.** `recordedVoiceprints` uses sync fs (read, open, readSync, close), `setImmediate`, and the embedder (model, unless faked).

**Seams.** `suggestMerges` is pure. `recordedVoiceprints` takes `embedder`, `resolve` and `names`; a fake embedder can return e.g. `[mean(clip), 1-mean]`. Test helpers `voice()` and `vp()` are in suggest.test.ts:6-8.

**Covered.** suggest.test.ts (5 tests):
- codec split → the named speaker, high, streams never mix
- different people untouched unless over the limit (low, "set for 1 voice")
- short-lines speaker → main voice (medium when small); chains
- biggest talkers kept, small duplicates raised
- a renamed speaker is preferred as the destination
- server.test.ts only fakes `speakerSuggestions`.
- **`recordedVoiceprints` is untested.**

**NOT covered.**
- `it("unit of a zero vector is zeros; centroidOf([]) is null; centroidOf averages then normalises")`
- `it("fewer than 2 speakers on a stream yields no suggestion for it")`
- `it("a print listed on both streams is considered in each")`
- `it("limit branch: groups ≤ limit falls through to voice-only merging")`: 2 remote speakers at 0.9 with limit 2 → 1 suggestion by voice.
- `it("limit branch: kept speakers have no centroids → sim null, goes to kept[0]")`
- `it("limit branch: a non-small speaker with no voiceprint is 'low'")`
- `it("limit branch: others are processed in ascending talkMs order")`: check the output order before sorting via equal-confidence ties.
- `it("limit branch: plural 'voices' for limit 2")`
- `it("voice-only: a pair below 0.65 is not suggested; exactly 0.65 is")`
- `it("voice-only: speakers without a centroid are never suggested")`: documents the current behaviour. **The docs and the comment at :81 say they go to the biggest talker**; see S2-L1.
- `it("voice-only: the survivor is the renamed one even if it talked less")`
- `it("voice-only: equal rank ties keep the earlier group as into")` (`rank<=0`)
- `it("voice-only: a 3-link chain points every suggestion at the final survivor with 'via'")`
- `it("voice-only: re-centroid weights by sampled")`: a 3-group case where weighting changes the second pick.
- `it("zero total talk: shares are 0 % and every duplicate counts as small (raised)")`
- `it("reason formats talk time as m:ss (61 s → 1:01; 65 min → 65:00)")`
- `it("output sorts high<medium<low then by similarity desc, null last")`
- `recordedVoiceprints` (tmpdir; WAVs via `encodeWav`; fake embedder; no model):
  - `it("builds one voiceprint per resolved speaker with lines, talkMs, sampled")`
  - `it("excludes inferred lines and lines under 2 s from sampling but counts them in lines/talkMs")`
  - `it("follows resolve() so merged speakers pool their clips")`
  - `it("caps at perSpeaker clips, evenly spread")`: 10 clips, perSpeaker 3 → indices 0, 3, 6 (step 3.33 → floor). Assert via the embed call order.
  - `it("skips clips whose stream WAV is missing")` → centroid null, sampled 0.
  - `it("skips clips truncated to < 1 s by the end of the WAV")`
  - `it("home stream is the majority stream")`
  - `it("name falls back to the id when names lacks it")`
  - `it("negative durations count 0 talkMs")`
  - `it("rejects when utterances.jsonl is missing")` (ENOENT)
  - `it("rejects on a corrupt JSONL line")` (SyntaxError, no try)
  - `it("closes the WAV fds even when the embedder throws")`: embedder throws on the first call; the promise rejects. Check the fds are closed via `vi.mock("node:fs")` spy on `closeSync`, or by counting `/dev/fd` entries before and after. Unverified which is simpler.
- One real-model integration: `it("recordedVoiceprints on a session produced from the fixture gives 3 centroids whose cross-similarity < 0.65")`. Optional and slow (about 5 s).

**Smells.**
- **S2-L1:** docs/speakers.md and the JSDoc at :81 say "A speaker too short for a voiceprint goes to the stream's biggest talker". The voice-only branch (no limit, or groups ≤ limit) skips centroid-less speakers (:130), so they get no suggestion at all. That rule is only implemented in the limit branch (:110-114). A TDD test written from the docs would fail.
- `rows` with a missing `stream` produce `streams: [undefined]` (:204). The row shape is not validated.
- `readClip` assumes a 44-byte header. That is consistent with `WavWriter`, but an imported WAV with extra chunks would misalign. Hedged: recordings are always written by WavWriter.

---

## T1. `src/transcribe/live.ts` (255 lines)

**Purpose.** Streaming display text over the OpenAI realtime WebSocket, one connection per stream. It sends VAD-gated audio with pre-roll and hangover, commits per utterance, and bills per minute sent.

**Exports.**
- `REALTIME_URL` :7; `RATE=24000` :8 (private).
- `interface SocketLike` :11; `LivePartial` :21; `LiveTranscriptionRow` :30; `LiveDeps` :39 (`connect?` seam :45).
- Private `class StreamLink` :50 constructs a **real `sherpa.LinearResampler(16000, 24000)`** (native, no model).
- `class LiveTranscriber` :72:
  - The default `connect` uses the global `WebSocket` with `{headers}` :78.
  - `warm(stream)` :91.
  - Private `ensure` :95:
    - If disabled or a ws exists, returns.
    - If `budget.assertCanSpend` throws, sets `disabled` silently.
    - Otherwise connects with a Bearer header.
    - `onopen` sends `session.update` (the exact shape is asserted in the tests).
    - `onclose` (current ws only): bills, clears ws, ready, pending and awaitingCommit, and reports an error if the code is not in {1000, 1005, falsy}.
  - Private `onMessage` :137:
    - Invalid JSON is ignored.
    - `session.updated`: ready, flushes pending.
    - `…delta`: accumulates and emits a non-final partial (trimmed).
    - `input_audio_buffer.committed`: shifts awaitingCommit and maps it if there is an `item_id`.
    - `…completed`: emits a final partial and deletes the text.
    - `error`: ignores `input_audio_buffer_commit_empty`; otherwise calls `onError`.
  - Private `send` :177 queues until ready.
  - Private `sendAudio` :183: resamples, encodes PCM16 and base64, and appends. It counts `sentSinceCommit` and `unbilledSamples`, **even when `send` dropped the message because ws is null** (T1-L1).
  - `feed(stream, samples, speaking)` :193:
    - Speaking: on the first speaking frame, ensures the connection and flushes the pre-roll; resets silence; sends.
    - Active but silent: sends, counts silence, deactivates after `hangoverMs`.
    - Otherwise: adds to the pre-roll, trimmed to `prerollMs` while keeping at least 1 chunk.
  - `commit(stream, uttId)` :219:
    - Needs `ws` and `sentSinceCommit > 0`.
    - Sends commit, pushes awaitingCommit, resets, and bills.
    - Then checks the budget. On failure: `disabled = true` and `close()`.
  - Private `bill` :235: `cost = s/60 × usdPerMinute`, `budget.record("transcription")`, logs a row.
  - `close()` :247: bills and closes every link; nulls ws first, so `onclose` is ignored.

**Side effects.** WebSocket (network) by default, sherpa native resampler, `Date` for row `at`.

**Seams.**
- `deps.connect` (the fake `FakeSocket` in tests/live.test.ts:10-22, with `server(e)`, `appends`, and a `close()` that fires `onclose({code:1000})`).
- `deps.budget` (a real `Budget`), `deps.log`, `onPartial`, `onError`.
- `vi.stubGlobal("WebSocket", Fake)` can cover the default connect at :78.

**Covered.** live.test.ts:
- "configures a transcription session, and queues audio until session.updated"
- "sends audio only while speaking, with pre-roll and hangover"
- "deltas accumulate; a commit maps…; completed is final"
- "bills sent audio … on commit and close; an empty turn is not committed"
- "stops streaming once the session budget is exhausted"
- "reconnects on the next speech after the server closes; errors surface"
- plus an EventBus transient check

**NOT covered.**
- `it("warm with an exhausted budget opens no socket and disables live text")`: then `feed(…, true)` → 0 sockets.
- `it("default connect constructs global WebSocket(url, {headers})")`: `vi.stubGlobal("WebSocket", class { constructor(u, o) { captured = [u, o]; } … })`.
- `it("onclose with code 1000, 1005, or no code reports no error")`
- `it("onclose without reason formats 'live transcription closed (1011)'")`
- `it("onclose bills unbilled audio and clears pending and awaitingCommit")`: a commit sent before close is not mapped after reconnect.
- `it("a stale socket's onclose after close() is ignored")`: no second bill row.
- `it("invalid JSON and unknown message types are ignored")`
- `it("error without code or message → 'live transcription: '")`: documents that `?? "error"` is unreachable, since code defaults to "".
- `it("error with message only surfaces the message")`
- `it("committed with no awaiting utterance maps nothing; later partials have utteranceId null")`
- `it("committed without item_id consumes the awaiting utterance without mapping")`
- `it("completed without transcript emits final text ''")`
- `it("delta without delta field keeps the text")`
- `it("pre-roll keeps at most prerollMs but always ≥1 chunk")`: 20 silent frames, then speech → exactly ceil(600/32) = 19 pre-roll appends (existing test only bounds this).
- `it("speech during hangover resets the silence counter")`
- `it("commit on a stream never fed is a no-op")`
- `it("commit with the socket closed is a no-op")`
- `it("two streams use two independent sockets and bill separately")`
- `it("feed after close() while still active does not reconnect until hangover ends")`: documents the behaviour.
- `it("audio fed while the socket is closed mid-utterance is not billed")` (**currently fails**, T1-L1).
- `it("a server close mid-utterance reconnects on continued speech")` (**currently fails**: no reconnect while `active` stays true; hedged as intended or not).
- `it("budget exhaustion at commit bills, closes every socket, and ignores later feeds")`
- `it("rows carry ISO at and audio_seconds rounded to ms")`

**Hard to test.** The real OpenAI realtime API is network plus money, so it is out of scope (smoke only). Everything else works with FakeSocket. The resampler is real but fast.

**Smells / latent bugs.**
- **T1-L1 (confirmed by probe):**
  - `sendAudio` :183-190 increments `sentSinceCommit` and `unbilledSamples` after `send()` returns early because `l.ws` is null (a socket closed mid-speech). Audio never sent is billed at the next bill/close. The probe billed 3.2 s that were never sent.
  - Also, while `l.active` stays true, `ensure()` is never called (:197), so live text stays dead until `hangoverMs` of silence.
- `LiveTranscriber` is built and `warm()`ed in the Session **constructor** (session.ts:150-160), so sockets open even if `run()` is never called.
- A budget failure in `ensure` is silent: no `onError`.

## T2. `src/transcribe/openai.ts` (171 lines)

**Purpose.** Final per-utterance transcription via multipart upload. It covers concurrency limiting, one retry on transient errors, a bracket-field fallback, cost and log rows, the filler test, and regex fixes.

**Exports.**
- `TRANSCRIBE_URL` :5; `USD_PER_AUDIO_MINUTE=0.0045` :6; `FILLER` regex :7 (private).
- `TranscriptionRow` :9; `TranscriptionResult` :22; `TranscriberDeps` :27.
- Private `class HttpFailure` :34: message is `HTTP <status>: <body[:300]>`, or the body alone when the status is null.
- `applyFixes(text, fixes)` :40: `new RegExp("\\b(?:p)\\b", "g")`; **it can throw on an invalid pattern**.
- `MIN_AUDIO_SECONDS=0.25` :45; `TranscriptionContext` :48.
- `isFiller(t)` :50: trimmed length under 4, or matches FILLER.
- `class Transcriber` :56:
  - Private semaphore `acquire/release` :64-73, with `cfg.concurrency`.
  - `fieldStyle` instance state, `brackets`, then `plain` :60.
  - `buildForm(wav, style, context)` :75: file, model, `prompt = context.prompt ?? cfg.prompt`, deduped keywords (config and context), languages.
  - Private `send` :87:
    - `fetch` with an Authorization header and `signal: AbortSignal.timeout(cfg.timeoutMs)`.
    - A fetch throw becomes `HttpFailure(null, "Name: msg")`.
    - A non-OK response becomes `HttpFailure(status, body)`.
    - `JSON.parse` of the body can throw a SyntaxError that is not an HttpFailure.
    - A missing `text` becomes `HttpFailure(status, "response without text")`.
  - Private `rejectsBrackets` :106: 400, style brackets, and a body matching `/keywords|languages/i`.
  - `transcribe(id, samples, context?)` :114:
    - Under MIN, returns `{ok:true, text:"", filler:false}` with no request.
    - `budget.assertCanSpend("transcription")` **throws outside the try**, so the call rejects.
    - acquire, then loop `while (attempts<2 || (styleRetried && attempts<3))`.
      - On success: record cost, log ok, apply fixes, trim, filler.
      - On a brackets rejection: switch to plain once and continue.
      - `noCredits` = 429 and the body matches `/insufficient_quota|credit_balance_exhausted/`.
      - retryable = HttpFailure and not noCredits and (status null, 429, or ≥ 500).
      - A non-retryable failure breaks the loop.
    - Failure log row with `cost 0`; returns `{ok:false, error, retryable}`.
    - `finally` releases.
  - Private `log` :157.

**Side effects.** `fetch` (injected), `Date.now`, `Budget`.

**Seams.** `deps.fetch`, `deps.budget`, `deps.log`, and `cfg` (e.g. `concurrency: 1`). The existing fake, `fakeFetch(responses)` in tests/transcribe.test.ts:12-21, is a queue of Response factories that records calls. `json(status, body)` is at :23.

**Covered.** transcribe.test.ts:
- "a clip carries the conversation so far and the speakers' names; a sliver is never sent"
- "sends the multipart fields and records estimated cost"
- "retries once on 429, then fails without a second retry" (500/503)
- "does not retry a 429 for exhausted credits"
- "does not retry a 400"
- "falls back to unbracketed field names…"
- "says whether a failure is worth retrying later…"
- "retries a timeout"
- "fillers and fixes"
- "refuses when the budget is exhausted"

**NOT covered.**
- `it("concurrency 1: a second call waits until the first completes")`: deferred fetch; fetch call count is 1 until the first resolves.
- `it("release hands the slot to a waiter (active never exceeds concurrency)")`: concurrency 2, 5 calls, track max in-flight.
- `it("the slot is released on failure")`: a failed call, then the next call proceeds.
- `it("MIN_AUDIO_SECONDS boundary: 4000 samples are sent, 3999 are not")`
- `it("a budget failure does not consume a slot or log a row")`
- `it("200 without text → ok:false 'HTTP 200: response without text', not retryable, 1 attempt")`
- `it("200 with invalid JSON → ok:false with a SyntaxError message, not retried")`
- `it("brackets rejected then 500, 500 → 3 attempts, retryable true, logged attempts 3")`
- `it("brackets rejected then 400 mentioning keywords again → 2 attempts, not retryable")`: plain style is not re-triggered.
- `it("a 400 mentioning 'languages' also triggers the plain fallback")`
- `it("a 429 without quota text twice → retryable:true after 2 attempts")`
- `it("5xx then success → one budget record, log attempts 2")`
- `it("a non-Error thrown by fetch is stringified")`
- `it("HttpFailure message truncates the body to 300 chars")`
- `it("sends signal: an AbortSignal")`: assert `init.signal instanceof AbortSignal`.
- `it("context.prompt '' is sent as '' (not the config prompt)")`: documents the `??` semantics.
- `it("fixes apply before the filler check")`: a fix mapping "yep" to "yeah" gives filler true.
- `it("applyFixes applies several fixes in order and respects word boundaries")`
- `it("isFiller: '' true, 'hey' true (<4), 'yes.' true, 'mm-hmm,' true, 'Right on' false, 'okay then' false")`
- `it("log row has kind, utterance_id, latency_ms ≥0, audio_seconds rounded to ms, estimated, ISO at, error only on failure")`
- `it("an invalid fix regex returns ok:false and logs exactly one row")` (**currently logs two rows and records cost**, see T2-L1).

**Hard to test.** Nothing. Timeouts are exercised by throwing a `TimeoutError` DOMException from the fake, as already done.

**Smells.**
- **T2-L1:** `applyFixes` runs inside the try after `budget.record` and the ok `log` (:131-133). An invalid `fixes[].pattern` (config.ts:36 only checks `min(1)`, not regex validity) throws. That is caught as a non-retryable error, so a second ok:false row is logged for the same utterance and the paid transcript is discarded.
- There is no backoff between retries (:126-147). The retry is immediate.
- `fieldStyle` is shared per instance. After one bracket rejection, every later call uses plain style (intended, per the docs).

---

## P1. `src/pipeline/segmenter.ts` (249 lines)

**Purpose.** A reorder buffer that releases transcribed utterances in `startMs` order across streams. Each non-filler, non-failed utterance gets one Jev call (boundary plus System 1 questions). Code rules close segments; a no-Jev mode uses pauses instead.

**Exports.**
- `PipelineUtterance` :8; `Segment` :23; `StreamStatus` :32; `Transcribed` :34; `FactcheckHook` :46; `SegmenterDeps` :51 (`jev?`, `now?`, `setTimer?`, `resolveSpeaker?`, `onProcessed?`).
- `stateUtterance(u, name)` :80.
- `class Segmenter` :85:
  - ctor defaults: `now=Date.now`; `setTimer = setTimeout(...).unref()` :96.
  - `emitted(u)` :100: pushes to pending, sorts by startMs, and adds to `recent`. `recent` is pruned when an entry's `endMs` falls before `startMs - 120000`.
  - `transcribed(id, result)` :108: unknown id is a no-op. Stamps `transcribedAt`, arms a timer for `reorderTimeoutMs+1`, then polls.
  - `poll()` :118: releases an item when (all earlier items settled AND every other stream has `watermark ≥ startMs && !midSpeech`) OR it timed out.
  - Private `release` :135:
    - `dropped` returns without processing.
    - Adds `overlap` via `overlaps(p, recent)` unless it is already present.
    - Chains `process` and `.catch` into `onError("segmenter", msg, {utterance_id})`.
  - `idle()` :150 loops until the chain is stable. `pendingCount` :158; `openSegment` :162.
  - Private `span` :166; private `close(forced, final)` :172; private `add` :182 creates `seg_<n>`.
  - Private `process(u)` :191:
    - A failed utterance only triggers `onProcessed`.
    - A filler forces a close if the span would exceed max, then is added (no Jev).
    - Otherwise, when Jev is on: builds `{boundary, ...fc.questions}` and the state (the open segment's non-failed utterances plus the new one), then asks. A failure calls `onError("jev", …)`.
    - `boundary = noul(answers,"boundary") ?? 0`; `u.boundary` is set only when Jev is on.
    - Close rules, for an open segment:
      - Forced if the span would exceed `maxSegmentMs`.
      - Without Jev: close if the gap to the previous utterance is ≥ `pauseBoundaryMs` and the span is ≥ `minSegmentMs`.
      - With Jev: close if boundary ≥ `boundaryThreshold − (speakerChange ? bonus : 0)` and the span is ≥ min. `speakerChange` means the resolved speaker differs and the gap is ≥ `speakerChangeGapMs`.
    - Then add. `onAnswers(u, answers, {segment})` runs only if answers exist. Then `onProcessed`.
  - `closeFinal()` :246.

**Side effects.** Only the timers (default `setTimeout().unref()`) and `Date.now`.

**Seams.** Everything is injected. The existing `harness(boundaries, {streams, jev})` in tests/segmenter.test.ts:20-57 provides a fake ask with scripted boundaries or "fail", a fixed clock `{t}`, a no-op `setTimer`, and an `add()` helper.

**Covered.** segmenter.test.ts:
- no-Jev pause rule and forced close
- boundary close plus state shape
- holds open when shorter than the minimum
- forces a close when adding would exceed the maximum
- speaker-change threshold with a gap
- filler and failed utterances
- empty (dropped) utterance
- Jev failure → boundary 0 and fact-check skipped
- cross-stream watermark ordering
- reorder timeout plus overlap tag at release

**NOT covered.**
- `it("transcribed(unknown id) is a no-op")`
- `it("transcribed arms setTimer with reorderTimeoutMs+1 whose callback releases on timeout")`: capture the timer fn, advance the clock, call it.
- `it("default setTimer uses an unref'd setTimeout")`: `vi.useFakeTimers()`, no `setTimer` dep, advance 8001 ms → released.
- `it("default now is Date.now")`
- `it("emitted out of order is sorted by startMs")`
- `it("poll releases several ready items in one pass")`
- `it("a stream at the watermark but midSpeech holds release")`
- `it("recent drops ranges ending >120 s before a new utterance, so no overlap tag")`
- `it("an existing 'overlap' tag is not duplicated")`
- `it("dropped results are never processed nor onProcessed")`
- `it("a filler as the first utterance opens a segment")`
- `it("a filler that would exceed maxSegmentMs forces a close before it")`
- `it("a failed utterance never joins the open segment and is excluded from later Jev state")`: a failed utterance in the open segment is filtered at :211. That needs a failed utterance already in the segment, which `process` never adds, so the filter at :211 is defensive. Unverified reachability.
- `it("answers without a 'boundary' key → boundary 0, still calls onAnswers")`
- `it("jev:false leaves u.boundary undefined and never calls factcheck.onAnswers")`
- `it("boundary exactly at threshold closes (>=)")`
- `it("span exactly minSegmentMs closes")`
- `it("span exactly maxSegmentMs is not forced (> only)")`
- `it("speaker change at exactly speakerChangeGapMs gets the bonus")`
- `it("merged speakers (resolveSpeaker) are not a speaker change")`
- `it("resolveSpeaker defaults to identity")`
- `it("no-Jev: a gap of exactly pauseBoundaryMs closes; a pause before minSegmentMs does not")`
- `it("an error thrown by onSegmentClosed / onAnswers / onProcessed is reported as segmenter error and the chain continues")`
- `it("a non-Error rejection from ask is stringified in onError")`
- `it("the ask meta carries purpose, utterance_id, question_set_version")`: partly covered.
- `it("fc.questions containing 'boundary' overrides the boundary question")`: documents the spread order at :209. Hedged smell.
- `it("closeFinal with no open segment returns null; twice returns null")`
- `it("idle waits for work released while awaiting")`
- `it("pendingCount reflects unreleased items")`
- `it("stateUtterance copies tags (mutation-safe)")`

**Smells.**
- One timer per transcription is never cleared (:113). This is harmless with unref.
- `{ boundary, ...fc.questions }` :209 lets a System 1 question id `boundary` silently replace the calibrated boundary. The config validation of System 1 ids may prevent this (unverified).

## P2. `src/pipeline/timeline.ts` (236 lines)

**Purpose.** Labels each closed segment through Jev with the host-editable label set. It derives markers, faded choices, mentions, lane and story, and computes sections. It also handles label-set replacement and versioning, stories, and relabel.

**Exports.**
- Private `canonical` :8 (sorted keys, recursive).
- `labelSetVersion(labels, stories)` :17: sha256(canonical {prefix, questions, story, stories})[:12].
- `timelineQuestions(labels, stories)` :23: prefix plus space on every instruction; a `story` choice with s1..sN plus `none` only when there are stories.
- `segmentState(prev, seg, name)` :36: excludes failed utterances.
- `AI_SUBJECTS` :41; `ChoiceLabel` :43; `SegmentLabels` :45.
- `mentionsOf(text, companies)` :60: regex-escaped, case-insensitive, `(?<![\w])…(?![\w])`.
- `deriveLabels(seg, answers|null, cfg, version, stories)` :66:
  - null answers → `unlabeled: true`, with mentions still computed.
  - choice → `{choice, confidence, faded: conf < fadedBelowConfidence}`.
  - noul → `nouls`, plus a marker when ≥ `noulMarkerThreshold`.
  - score → `scores`.
  - `clip_worthy ≥ clipWorthyMin` adds a "clip_worthy" marker.
  - lane is "ai" for AI subjects, else the subject.
  - `story` comes from `"sN"`, else null.
- `Section` :90; `sectionsOf(segments, labels)` :93: skips missing, unlabeled, no-subject and faded segments; merges consecutive same-subject segments.
- `LabelConflictError` :110; `TimelineDeps` :112 (`labels?:false`).
- `class Timeline` :123:
  - `labelSetActive`, `storiesActive` (copy), `version`, `questions()`, `sections()`.
  - `replaceLabels(input)` :159: `parseLabelSet` (throws when invalid). A boundary change throws `LabelConflictError`. Returns the version.
  - `setStories(h)` :168: trims, filters empties, throws if more than 254, returns the version.
  - Semaphore with `cfg.jev.segmentConcurrency` :175-184.
  - `onSegmentClosed(seg)` :187: pushes the segment; labels it unless `labels === false`.
  - `relabel()` :193: labels every segment and **does not check `deps.labels`**. Returns the count.
  - Private `track` :198; `idle()` :203.
  - Private `label(seg, purpose)` :207:
    - Snapshots the questions, version and stories before acquiring.
    - Asks. On error, calls `onError("jev", …)`, and if this is a relabel of an already-labelled segment, keeps the old labels and returns.
    - Otherwise derives, sets, `write({kind:"labels", purpose, ...l})`, and emits `segment.labels`.
    - Emits `section.updated` only when the sections' JSON changed.

**Side effects.** `crypto` sha256; `parseLabelSet` from config.ts.

**Seams.** Deps are injected. The existing `timeline(answer)` factory is in tests/timeline.test.ts:100-116. `u()` and `seg()` builders are at :13-16; `labelsFor` at :19.

**Covered.** timeline.test.ts:
- prefix, boundary and story questions
- label-set version (12 hex, key-order independent, stories, boundary excluded)
- segmentState
- markers and faded rules
- mentions
- sections ignoring faded segments
- config replacement / conflict / invalid
- failed → unlabeled, then relabel

**NOT covered.**
- `it("timelineQuestions with an empty prefix adds no leading space")`
- `it("labelSetVersion depends on array order (arrays not sorted)")`
- `it("deriveLabels: story 's2' maps to stories[1]; 'none' → null; 's9' out of range → null")`
- `it("deriveLabels: a non-AI subject sets lane = subject; no subject → lane null")`
- `it("deriveLabels: confidence exactly fadedBelowConfidence is not faded")`
- `it("deriveLabels: noul exactly noulMarkerThreshold is a marker")`
- `it("deriveLabels: clip_worthy exactly clipWorthyMin adds the marker; missing clip_worthy adds none")`
- `it("deriveLabels: failed utterances are excluded from mention text")`
- `it("deriveLabels: unlabeled still computes mentions")`
- `it("mentionsOf escapes regex metacharacters in company names")`: e.g. "C++" or "A.I." in a custom list.
- `it("mentionsOf treats non-ASCII letters as boundaries")`: "OpenAIé" matches. This documents `\w` being ASCII; hedged smell.
- `it("sectionsOf skips segments with no labels, unlabeled, or no subject; endMs is the max")`
- `it("sectionsOf numbers sections sec_1..n")`
- `it("setStories trims and drops blanks; >254 throws; returns the new version")`
- `it("storiesActive returns a copy")`
- `it("labels:false keeps segments but never asks")`
- `it("relabel with labels:false still asks")`: documents that the Engine is what refuses (Engine 409). Hedged.
- `it("segmentConcurrency 1 serialises label requests")`: deferred ask.
- `it("a relabel failure keeps existing labels (no write, no emit)")`
- `it("a relabel failure on an unlabeled segment rewrites it unlabeled")`
- `it("section.updated is emitted only when sections change")`: two segments with the same sections produce one emit.
- `it("write row is {kind:'labels', purpose, ...labels}")`
- `it("label uses the version/stories snapshot taken before acquire")`: `replaceLabels` while a request waits; the waiting request keeps the old version.
- `it("previous_segment is the segment before this one in close order")`
- `it("a non-Error ask rejection is stringified")`
- `it("a throw from deps.write rejects label and is surfaced")` (**currently an unhandled rejection**, see P2-L1).

**Smells.**
- **P2-L1:** `track` :198-201 does `p.finally(...)` without handling a rejection. If `deps.write` or `deps.emit` throws inside `label`, the derived promise rejects unhandled, and `idle()` rejects too. Unverified in practice: `store.append` is sync fs.
- Relabel and segment labelling can race. The last one to finish wins (there is no sequence check).

## P3. `src/pipeline/stats.ts` (94 lines)

**Purpose.** Computes end-of-show and periodic stats from segments and labels:
- the Off-topic index (the field is still called `roganIndex`);
- labelled time;
- per-speaker talk time, disagreements and duration-weighted hype;
- predictions, recommendations, clips;
- pass-through fact-check and cost figures.

**Exports.**
- `SpeakerStat` :7; `SessionStats` :9; `StatsInput` :21.
- `OFF_TOPIC` :31; private `segmentText` :33.
- `computeStats(input)` :38:
  - Talk time counts every non-failed utterance, even in unlabelled segments.
  - Labelled time requires a subject.
  - Disagreement marker: +1 per speaker in the segment.
  - Hype is weighted by per-speaker ms.
  - Texts are sliced to 120.
  - clip_worthy ≥ `clipWorthyMin`.
  - Speakers sorted by talk desc; `hype` null when the weight is 0.
  - `roganIndex = off/labelled` or 0.

**Seams.** Pure.

**Covered.** stats.test.ts: Off-topic index; talk, disagreements and hype with a merge; predictions, recommendations, clips, factcheck/cost pass-through, 120-char slice. The boundary calibration tests in the same file belong to `src/cli`.

**NOT covered.**
- `it("no segments → roganIndex 0, labelledMs 0, speakers []")`
- `it("failed utterances count no talk and no text")`
- `it("a segment without labels still counts talk time")`
- `it("a labelled segment without a subject adds no labelledMs but still counts markers/hype")`
- `it("a speaker only in unhyped segments has hype null")`
- `it("clip_worthy exactly clipWorthyMin is a clip; below is not")`
- `it("a segment's text trims and joins non-failed utterances with a space")`
- `it("speakers sorted by talkMs desc; displayName from speakerName(resolved id)")`
- `it("disagreement counts once per segment per speaker, not per utterance")`

---

## P4. `src/pipeline/session.ts` (605 lines)

**Purpose.** The orchestrator. It runs sources → merge → pause/echo gate → WAV store → VAD → live text → tags/speakers → transcription (with the retry queue) → segmenter → timeline and fact-checker → events, store, health, stats → ordered shutdown. It also handles host commands (rename, merge, pause, resume, stop, setOutput) and `state()`.

**Exports.**
- `SessionMode` :23; `Features` :29; private `NO_FACTCHECK` :37; private `TRANSIENT` :41 (`utterance.partial`, `call.started`, `call`).
- `Services` :43; `SessionOptions` :49 (`services`, `fetch`, `keys`, `embedder`, `exportBoundary`, `statsIntervalMs`, `healthDetail`, `liveText`, `liveConnect`, `voices`, `features`, `retryEveryMs`).
- Private `PendingTranscript` :81; `RETRY_EVERY_MS=15000` :86; `MAX_PENDING=200` :88.
- `class Session` :91, ctor :125:
  - Empty sources throw :129.
  - `SessionStore` (fs dir under `sessionsDir`).
  - `Budget`: `enforceDevCap = mode !== "live" && !allowOverDevCap`; `devSpentUsd = sumDevSpend(sessionsDir)`; `onExhausted` → `budget.exhausted`; `onCost` → `cost`.
  - `log` :141 appends to the store; for an ok `jev_calls` row with purpose utterance it saves the state for the fact-checker; `jev_calls` and `s2_calls` rows also emit `call` (transient).
  - `services` come from `opts.services({budget, log})`, else `realServices` :229 (Transcriber, JevClient, S2Client with `opts.fetch ?? fetch` and keys from opts or env).
  - `LiveTranscriber` when `liveText && live.enabled`, **warmed in the ctor** :159.
  - `EchoGate`.
  - `SpeakerRegistry(cfg, opts.embedder ?? new Embedder(), this.voices)`.
  - **`new StreamVad(...)` per stream, with no seam** :165.
  - Timeline, FactChecker and Segmenter wiring :174-209 (`jev: factcheck || labels`; `NO_FACTCHECK` when fact-checking is off; `onProcessed` stores `processed` and export rows).
- Getters: `id`, `voices` (config merged with `opts.voices`) :217, `mode`, `features` :225 (default true unless false).
- `emit` :251: bus emit; non-transient events are appended to `events.jsonl` with `afterClose` once ended.
- `run()` :259 is idempotent (`this.done ??=`). Private `runInner` :264:
  - Writes `session.json`, emits `session.started`, and emits `echo.gate` if active.
  - Three unref'd intervals: health 1 s, stats `statsIntervalMs ?? 60000`, retry `retryEveryMs ?? 15000`.
  - The for-await merge loop :287:
    - Breaks with "stopped" when a stop is requested.
    - Tracks `lastMs`.
    - When paused, replaces frames with zeros.
    - Remote frames go to `echoGate.remote`; host frames go through `echoGate.host` when active.
    - `writeAudio`; health bookkeeping (32 recent frames).
    - `vad.accept`; `live.feed(isDetected)`; `onUtterance` for each result; `segmenter.poll`.
    - `setImmediate` every 64 frames.
  - The catch emits `error {component:"session"}` with reason "error". Then `finish(reason)`.
- Private `endStream(s)` :313: flushes the VAD, then `onUtterance` and poll.
- Private `onUtterance(u)` :318:
  - Loud tag; `speakers.assign` (plus `speaker.created`); health timestamp.
  - Appends to `utterances.jsonl` (rounded ms).
  - `segmenter.emitted`; `live.commit`; context.
  - `services.transcribe(...).catch(→ {ok:false, error})`, then:
    - Not ok: an `error` event (component "transcription"); `keepForRetry` if retryable; `utterance.failed` (`retrying` or `failed`).
    - ok with text: push to `utterances` and emit `utterance`.
    - `segmenter.transcribed({...pu, dropped: ok && text===""})`.
  - Tracks the promise in `transcriptions`.
- Private `emitFailed` :358; private `keepForRetry` :362 (evicts the oldest past 200 and marks it `failed`).
- Private `retryPending()` :375:
  - Single-flight.
  - Oldest first. Stops at the first retryable failure. A non-retryable failure is dropped and marked failed.
  - Empty text is marked `empty`.
  - Success is inserted in time order and emits `utterance {recovered:true}`. It does not go back to the segmenter.
  - A thrown error emits `error "retrying failed lines: …"`.
- Private `transcriptionContext()` :417: config prompt, renamed names, stories, and up to 6 recent lines within 600 chars; `keywords = names`.
- Private `onSegmentClosed` :437: `segments.jsonl`, the `segment.closed` event, then the timeline.
- Private `emitHealth` :449: rms of the recent frames (−120 when silent, 0.1 dB rounding), `msSinceLastFrame` (−1 if none), `utterancesLastMinute`, `echoMutedMs` for the host when the gate is active, `detail` from `healthDetail()` (called twice).
- `stats()` :468; private `emitStats` :476.
- Private `finish(reason)` :481, in order:
  1. `closeAudio`
  2. flush the VADs that have not ended
  3. await every transcription (loop)
  4. await the retrying pass, then one final `retryPending`
  5. give up whatever is still pending (`failed`)
  6. poll, then segmenter idle, then `closeFinal`, then timeline idle
  7. `factcheck.drain(180000)`: false emits an error, then `stop`
  8. clear the timers; `live.close`; `emitStats`
  9. `speakers.json`; the `exportBoundary` file; status "ended"; `session.ended {reason}`; `store.close`
- `setOutput(kind, device)` :514: emits `echo.gate` only while running, on a change or on a device rename while active.
- `pause()` :526 and `resume()` :533: return booleans; only while running; emit events with `atMs = lastMs`.
- `stop()` :541: sets the flag and awaits `run()`.
- `renameSpeaker` :548 and `mergeSpeakers` :555: emit `speaker.updated`/`speaker.merged` (the from id is resolved before the merge); `speakers.json` is rewritten if the session has ended.
- `transcriptLines()` :569: drops fillers and empty lines.
- `state()` :575.

**Side effects.**
- fs through `SessionStore` (a dir per session; WAVs; JSONL; JSON), `writeFileSync(exportBoundary)`, `sumDevSpend` (reads `sessionsDir`).
- Timers (setInterval ×3), `setImmediate`, `Date.now`, `process.env` (keys).
- Global `fetch` if neither services nor fetch is injected; `tests/setup.ts` makes it throw.
- The Silero model (always) and the WeSpeaker model (unless `embedder` is injected).
- WebSocket if `liveText`.

**Seams that exist.**
- `services` (the main one): `transcribe`, `ask`, `s2`.
- `fetch` + `keys`, for the real clients with a fake fetch: `fakeFetch(script)` in tests/session.test.ts:23-79 fakes the transcription, Jev (`alpha/decisions`) and OpenRouter chat endpoints; it matches transcription by clip duration and returns a key-echo error once.
- `embedder`, `liveConnect`, `retryEveryMs`, `statsIntervalMs`, `healthDetail`, `exportBoundary`, `sessionsDir` (tmpdir), `features`, `voices`, and `sources` (any `AudioSource`).
- EventBus `onInvalid` (events.ts:72): **tests should pass `onInvalid: (t, m) => { throw new Error(...) }` or collect**, to assert every emitted payload is schema-valid. No existing test does.
- Existing service fakes:
  - `services()` in echoGate.test.ts:85-89: transcribe always returns text; ask throws.
  - `flaky(downFor, failure, text)` in retry.test.ts:13-21.

**Covered.**
- session.test.ts:
  - "runs the fixture end to end; no event or session file contains either API key": files, events, speakers, segments ≤ 75 s, WAV equality, repeat link, rename and merge after the end, redaction, `state()`.
  - "transcript only…"
  - "fact-checking off, labels on…"
  - "a paused session hears silence…"
  - Engine tests for named sessions and deletion.
- retry.test.ts:
  - recovery in time order
  - given up at the end (one request per pass)
  - a non-transient failure is not retried
- echoGate.test.ts: session and engine echo gate.
- Each session test takes about 5 s, because it runs the full 78 s fixture through Silero and WeSpeaker.

**NOT covered.**
- Construction and config:
  - `it("throws 'at least one audio source is required' for sources: []")`
  - `it("features default to both on; false switches each off")`
  - `it("voices merges config voicesPerStream with opts.voices")`
  - `it("replay enforces the dev cap; live does not; allowOverDevCap lifts it")`: seed `sessionsDir` with a jsonl whose `cost_usd` is above `devCapUsd`. The replay's first transcribe rejects and the line is marked `failed`; a `budget.exhausted` event {cap:"dev"} is emitted.
  - `it("liveText with live.enabled warms one socket per stream at construction (liveConnect fake)")`
  - `it("liveText with live.enabled=false creates no LiveTranscriber")`
  - `it("live apiKey comes from keys.openai, else OPENAI_API_KEY")`
- run lifecycle:
  - `it("run() twice returns the same promise and runs once")`
  - `it("session.json has id, app, mode, startedAt, streams, config, voices, features, labelSet, labelSetVersion, s1Version, s1")`
  - `it("emits echo.gate at start when echoGate.mode is 'always'")`
  - `it("a source that throws ends the session with reason 'error' and an error event {component:'session'}")`: an ArraySource that throws after 3 frames. `session.ended.reason === "error"`.
  - `it("stop() mid-run ends with reason 'stopped' and in-flight transcriptions still complete")`: a controllable source (async queue), a deferred transcribe, then `stop()`. `session.ended` comes after the transcribe resolves.
  - `it("stop() before run() starts and immediately stops on the first frame")`
  - `it("finish flushes VADs that were not ended when stopped mid-speech")`
  - `it("session.ended is the last event and store is closed")`: `events.jsonl` has nothing after it except after-close commands.
  - `it("transient events (utterance.partial, call, call.started) never reach events.jsonl or history")`
- Frames:
  - `it("paused frames are written as silence and resume restores audio")`
  - `it("pause/resume return false when not running or already in that state; events carry atMs = lastMs")`
  - `it("remote frames feed the echo gate; host frames are muted only while active")`: partly covered.
- onUtterance (fixture slice, or private access `(s as any).onUtterance(u)` with a synthetic Utterance and a fake embedder):
  - `it("emits speaker.created for a new speaker with stream")`
  - `it("appends utterances.jsonl with rounded start/end and tags ['loud'] when loud")`
  - `it("dropped (ok, empty text) emits neither utterance nor utterance.failed")`
  - `it("filler text emits utterance with filler:true and is excluded from transcriptLines")`
  - `it("a rejected transcribe (e.g. budget) → error event + utterance.failed status 'failed', not kept for retry")`
  - `it("utterance event carries the resolved speakerId and current displayName")`
  - `it("commits live text for the utterance's stream")`: with a `liveConnect` fake.
- Transcription context: `it("context prompt = config prompt + renamed names + stories + ≤6 recent lines ≤600 chars; keywords = renamed names only")`. Capture the context in a fake `transcribe`; rename a speaker and set stories via `s.timeline.setStories` before later lines.
- Retry:
  - `it("keepForRetry evicts the oldest past 200 and marks it failed")`: private access, calling `(s as any).keepForRetry` 201 times.
  - `it("retryPending is single-flight: concurrent calls share one pass")`
  - `it("a retry returning empty text emits utterance.failed 'empty'")`
  - `it("a non-retryable retry failure marks that line failed and continues with the next")`
  - `it("a periodic retry pass runs every retryEveryMs")`: `retryEveryMs: 50` with a controllable source kept open.
  - `it("a synchronous throw from services.transcribe inside retry is reported as 'retrying failed lines: …'")`
- Health, stats, export:
  - `it("health: -120 dBFS for silence, msSinceLastFrame -1 before any frame, utterancesLastMinute windowed to 60 s")`: call `(s as any).emitHealth()` directly with `vi.setSystemTime`.
  - `it("health includes echoMutedMs only for host while the gate is active, and detail when healthDetail returns non-null")`
  - `it("stats are emitted every statsIntervalMs and once at the end")`
  - `it("exportBoundary writes one JSONL row per Jev-processed utterance, '' when none")`
  - `it("factcheck.drain returning false emits the 180 s error and the session still ends")`: stub `(s.factcheck as any).drain = async () => false` before `run`.
- Commands and state:
  - `it("setOutput emits echo.gate on change, on device rename while active, never after the session ended")`
  - `it("setOutput with an inactive gate and a new device emits nothing")`
  - `it("mergeSpeakers emits fromId resolved before merge")`
  - `it("rename/merge before the end do not write speakers.json; after the end they do")`
  - `it("state() reports boundary per utterance from processed, openSegment, sections, labels version, cost with sessionCapUsd")`
  - `it("log(): an ok utterance jev_calls row stores state for the fact-checker; call events are transient")`
- **Schema validity:** `it("every event emitted in a fixture run passes its zod schema")` (EventBus `onInvalid` collects to an array, which must stay empty).

**Hard to test / recommended approach.**
- **VAD is not injectable** (session.ts:165). Every run needs `models/silero_vad.onnx`, and utterances only appear for real speech. Options:
  - (1) No refactor: short **fixture slices** through a small `ArraySource` (e.g. host 0.5–8 s holds line 1 only; remote 8.5–15 s holds line 2), with a fake embedder. This takes well under a second per test. Silero on synthetic tones is unverified.
  - (2) Private access: `(s as any).onUtterance({id, stream, startMs, endMs, samples})` and `(s as any).finish("end_of_input")` to test branches without audio.
  - (3) Minimal refactor seam: add `vadFactory?: (stream, cfg, ids) => StreamVad`-like to `SessionOptions` next to `embedder` :61. That would allow a scripted FakeVad emitting utterances at chosen frames. Recommended only if (1) and (2) prove too brittle.
- **Timers:**
  - The intervals use the real `setInterval` (unref'd).
  - `vi.useFakeTimers({toFake:["setInterval","clearInterval","Date"]})` works, but **do not fake `setImmediate`**: runInner yields with it every 64 frames, and it would deadlock at speed max.
  - Alternatively call `emitHealth` / `emitStats` / `retryPending` privately.
- **Factcheck drain 180 s:** stub `drain`.
- **Real services** (OpenAI, OpenRouter): network plus money, so they are excluded. `realServices` is already exercised through a fake `fetch`.
- **Hardware:** live capture is only through `Engine` with a fake `live` factory (echoGate.test.ts:165).

**Smells / latent bugs.**
- **P4-L1:** `transcriptions.add(p); p.finally(...)` :354-355. `p` rejects only if the `.then` callback throws (e.g. `bus.emit` for an unknown type, or `store.append` failing on a full disk or removed dir). The derived `finally` promise is then an unhandled rejection, and `Promise.all` in `finish` :485 rejects, so `run()` rejects without `session.ended`. Hedged: this needs an I/O failure.
- **P4-L2:** a *synchronous* throw from `services.transcribe` (a non-async fake, or a future client) escapes `onUtterance`: `.catch` is attached to the returned promise only :330-331. It aborts the whole run loop with reason "error". The same at :379 inside the retry pass is caught by `run().catch`.
- **P4-L3:** `LiveTranscriber.warm` runs in the constructor :159, so a constructed but never-run Session opens sockets and holds a budget check.
- **P4-L4:** a Session whose source never yields cannot be stopped: `stopRequested` is only checked per frame :288, and `mergeSources` awaits all heads :50. For live capture, the Engine stops the capture first (unverified; outside this area).
- `healthDetail()` is called twice per health event :463.
- `finish` calls `endStream` only for VADs that have not ended. On a normal end, `mergeSources`' `onEnd` already flushed them. Fine.

---

## Area-wide notes

**Runtime costs (measured 2026-09-29, M-series Mac).**
- Pure / fake-only, milliseconds: suggest, transcribe, live, segmenter, timeline, stats (except the CLI subprocess test, about 200 ms), nativeSource (about 100 ms, of which 90 ms are real sleeps).
- `models/silero_vad.onnx` (640 KB): anything constructing `StreamVad` or `Session`. Construction is cheap; the full fixture VAD pass takes about 0.25–0.5 s.
- `models/wespeaker_en_voxceleb_resnet34_LM.onnx` (26 MB): `new Embedder()`, which the Session constructs by default. The fixture speaker test takes 4.8 s.
- Full fixture sessions take about 5 s each; echoGate "leaking" takes 12.6 s (two sessions). The session, retry and echoGate files together take 28 s on 3 workers.
- audio.test.ts "speed 1 pacing" takes **10 s of real time**; replace it with fake timers.
- `requireAssets()` (tests/helpers.ts:6) throws "run npm run models && npm run fixtures" if a model or fixture is missing. Both models and fixtures exist locally. Fixture: 77.754 s, 10 scripted lines (`fixtures/conversation/script.json`), voices Samantha (host), Daniel and Sandy (remote).
- `tests/setup.ts` replaces `globalThis.fetch` with a throwing function. `WebSocket` is **not** stubbed; consider `vi.stubGlobal("WebSocket", …)` in setup so that a missed `liveConnect` fails loudly.

**Shared helpers worth creating** (e.g. `tests/fakes/`):
- `ArraySource(stream, Float32Array, {startMs?, throwAfter?})`: an `AudioSource` yielding 512-sample frames, with an optional error.
- `ControlledSource`: pushable and endable, like `LiveStream` (which could itself be reused: `new LiveStream("host")` plus `push(Int16Array)` plus `end()`, since it already implements `AudioSource`).
- `fixtureSlice(stream, fromMs, toMs)`: `readWav16k(fixture).subarray(...)`, for fast real-VAD tests. Line timings are in the script.
- `pcm.ts`: `tone(amp, n)`, `silence(n)`, `constant(v, n)`, `wavFile(dir, samples, rate)` (via `encodeWav`).
- `FakeEmbedder(dim, map?)`: `embed` returns a preset unit vector per call or derives one from the clip's mean. A `vec(k, mix)` builder like suggest.test.ts:6.
- `FakeHelper`, `frameBytes`, `ramp`, `take`, `all`: moved from nativeSource.test.ts.
- `FakeSocket`: moved from live.test.ts.
- `fakeFetch` for transcription (a queue; transcribe.test.ts:12) and for full services (session.test.ts:23). Also `servicesFake({transcribe?, ask?})` merging echoGate.test.ts:85 and retry.test.ts:13.
- `deferred<T>()`: for concurrency, semaphore and stop-ordering tests.
- `tmpSessions()` = `mkdtempSync(join(tmpdir(), "sessions-"))`.
- `strictBus()` = `new EventBus({ onInvalid: (t, m) => { throw new Error(`${t}: ${m}`); } })`. Throwing inside emit would surface as P4-L1-style failures, so collecting into an array is safer.
- `shellBin(dir, script)`: writes an executable sh script, for `startNativeCapture`'s default spawn and for `listDevices`.
- A fake clock: the segmenter's `{t}` pattern, or `vi.useFakeTimers({toFake:[...]})` with an explicit list. **Never fake `setImmediate`** in session tests (session.ts:304) or `recordedVoiceprints` (suggest.ts:200). Also avoid it where FakeHelper exits (nativeSource.test.ts:56).

**Gotchas constraining tests in this area** (docs/gotchas.md):
- sherpa-onnx loads directly under vitest on this Mac. If it ever fails, `DYLD_LIBRARY_PATH` must be set in front of `node`, because macOS strips it through shebangs. The package ships no types (`src/types/sherpa-onnx-node.d.ts`). `Vad.flush()` exists in 1.13.8, so the silence fallback in vad.ts:73-76 is dead in production and needs a fake to cover.
- The fixture's voices: Samantha and Karen score 0.86 cosine, so the fixture uses Sandy. Silero misses Sandy's opening words. Keep synthetic fixture lines to one sentence, because a pause over 0.5 s splits a line.
- OpenAI: a 429 with `insufficient_quota` is non-transient (tested). Realtime needs `turn_detection: null` and 24 kHz (asserted in live.test).
- Capture: a denied permission yields −120 dBFS silence, not an error, so the adapter cannot detect it. The system tap takes about 0.9 s to start (ClockLock pads). Mic, tap and permission behaviour is **hardware-only**; the Node adapter is fully fakeable.
- Budget: replays enforce the dev cap from `sumDevSpend(sessionsDir)`. Always pass a fresh tmp `sessionsDir`, or tests would read the real `sessions/` spend and could be refused.

**Latent bug index** (tests written from spec or docs will expose these):
- A2-L1 (confirmed) LiveStream clock goes backwards: nativeSource.ts:62.
- A2-L2 listDevices non-JSON line gives an uncaught exception: nativeSource.ts:247.
- A2-L3 no `'error'` listener on the spawned helper: nativeSource.ts:154.
- A2-L4 `started` without epochMs holds frames forever: nativeSource.ts:173,191.
- A2-L5 repeated error/kill after a malformed frame: nativeSource.ts:167.
- A2-L6 `stop()` with a signal-killed proc waits for the restart timer: nativeSource.ts:222.
- T1-L1 (confirmed) live text bills unsent audio and does not reconnect mid-speech: live.ts:183-190, 197.
- T2-L1 an invalid fix regex double-logs and wastes a paid transcript: openai.ts:131-133 (config.ts:36 does not validate the regex).
- S2-L1 docs say centroid-less speakers go to the biggest talker; the voice-only branch never suggests them: suggest.ts:130 vs :81 and speakers.md.
- P2-L1 unhandled rejection in Timeline.track: timeline.ts:198.
- P4-L1 / P4-L2 unhandled or unguarded transcription promise paths: session.ts:330-355.
- P4-L3 live sockets opened in the Session constructor: session.ts:159.

**Proposed test case count:** about 255 `it(...)` lines above:
- source 13, nativeSource 36, vad 11, wav 9, tags 9, echoGate 10
- registry 25, suggest 30
- live 24, openai 21
- segmenter 28, timeline 26, stats 9, session 45
