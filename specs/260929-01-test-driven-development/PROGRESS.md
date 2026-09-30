# PROGRESS — Test-driven development for Tattle

The running log for `SPEC.md`. Updated after every phase.

## Status

- [x] Phase 0 — Preconditions and PROGRESS.md (2026-09-30)
- [x] Phase 1 — Tooling, shared fakes, probes, baseline (2026-09-30)
- [x] Phase 2 — CLAUDE.md and docs/testing.md (2026-09-30)
- [x] Phase 3 — `src/audio`, `src/speakers`, `src/transcribe`, `src/pipeline`
- [x] Phase 4 — `src/jev`, `src/factcheck`, `src/chat`, budget, config, keys, paths, licenses, version (+ `src/labels`, `src/settings.ts`)
- [x] Phase 5 — `src/server`, `src/store`, `src/cli`
- [x] Phase 6 — `desktop/`
- [x] Phase 7 — `web/src` state, router, api, desktop, calls, transfer, keys, ui, chat, app, main
- [x] Phase 8 — `web/src` panels, timeline, player, markdown, licenses, dom (+ `labels.ts`, `icons.ts`)
- [x] Phase 9 — E2E web (Playwright + Chromium)
- [x] Phase 10 — E2E Electron
- [x] Phase 11 — Swift tests for the capture helper (2026-09-30, done while Phases 3–8 ran in parallel worktrees)
- [x] Phase 12 — The suite becomes Step 1 of every release
- [x] Phase 13 — Close out

## Coverage

Per phase: folder → lines / statements / functions / branches (`coverage/coverage-summary.json`, summed over each folder's files).

### Baseline (Phase 1, before any new test; 27 files, 271 tests)

| Folder | lines | statements | functions | branches |
|---|---|---|---|---|
| `src/**` | 86.92 | 83.20 | 83.80 | 72.67 |
| `web/src/**` | 1.01 | 0.99 | 0.57 | 1.85 |
| `desktop/**` | 0.00 | 0.00 | 0.00 | 0.00 |

Thresholds set to these, rounded down: src 86/83/83/72, web/src 1/0/0/1, desktop 0.

Per file (lines / statements / functions / branches), at baseline:

| File | L | S | F | B | File | L | S | F | B |
|---|---|---|---|---|---|---|---|---|---|
| `src/audio/echoGate.ts` | 100 | 100 | 100 | 100 | `src/pipeline/session.ts` | 88.8 | 86.5 | 84.2 | 77.0 |
| `src/audio/nativeSource.ts` | 89.9 | 83.2 | 64.3 | 75.8 | `src/pipeline/stats.ts` | 100 | 98.8 | 100 | 94.6 |
| `src/audio/source.ts` | 100 | 95.9 | 100 | 86.7 | `src/pipeline/timeline.ts` | 98.9 | 96.0 | 96.7 | 82.5 |
| `src/audio/tags.ts` | 100 | 92.9 | 100 | 85.0 | `src/server/audio.ts` | 96.0 | 91.2 | 100 | 80.0 |
| `src/audio/vad.ts` | 88.1 | 83.3 | 100 | 69.2 | `src/server/inProcess.ts` | 100 | 93.5 | 88.9 | 66.7 |
| `src/audio/wav.ts` | 94.9 | 93.2 | 87.5 | 80.0 | `src/server/main.ts` | 68.4 | 63.4 | 54.5 | 63.8 |
| `src/budget.ts` | 100 | 94.1 | 100 | 77.8 | `src/settings.ts` | 97.1 | 95.2 | 81.8 | 79.4 |
| `src/chat/chat.ts` | 82.0 | 78.5 | 88.2 | 64.0 | `src/speakers/registry.ts` | 99.0 | 95.4 | 92.3 | 69.9 |
| `src/cli/calibrateBoundary.ts` | 41.2 | 47.7 | 55.6 | 65.5 | `src/speakers/suggest.ts` | 61.8 | 62.8 | 73.1 | 59.8 |
| `src/cli/calibrateSpeakers.ts` | 0 | 0 | 0 | 0 | `src/store/events.ts` | 100 | 97.7 | 100 | 85.7 |
| `src/cli/replay.ts` | 0 | 0 | 0 | 0 | `src/store/library.ts` | 96.2 | 95.9 | 94.4 | 81.0 |
| `src/config.ts` | 100 | 94.4 | 100 | 77.8 | `src/store/sessionStore.ts` | 100 | 90.6 | 100 | 76.5 |
| `src/factcheck/gate.ts` | 90.9 | 91.7 | 100 | 100 | `src/store/transfer.ts` | 95.2 | 90.9 | 88.0 | 74.8 |
| `src/factcheck/queue.ts` | 89.1 | 87.0 | 73.3 | 92.6 | `src/store/zip.ts` | 99.3 | 92.4 | 100 | 72.0 |
| `src/factcheck/s1.ts` | 92.9 | 88.2 | 95.9 | 82.4 | `src/transcribe/apple.ts` | 83.9 | 79.7 | 78.8 | 61.5 |
| `src/factcheck/s2.ts` | 92.2 | 88.3 | 86.4 | 76.2 | `src/transcribe/live.ts` | 97.4 | 96.3 | 100 | 84.1 |
| `src/jev/client.ts` | 94.3 | 90.0 | 90.5 | 86.7 | `src/transcribe/openai.ts` | 98.6 | 95.1 | 92.3 | 88.2 |
| `src/jev/types.ts` | 94.7 | 85.7 | 100 | 75.0 | `src/version.ts` | 100 | 100 | 100 | 100 |
| `src/keys.ts` | 96.9 | 92.2 | 88.0 | 84.8 | `web/src/router.ts` | 83.3 | 75.9 | 54.5 | 80.8 |
| `src/labels/assist.ts` | 82.9 | 77.7 | 85.7 | 55.5 | `web/src/icons.ts` | 100 | 100 | 100 | 100 |
| `src/labels/interview.ts` | 100 | 100 | 100 | 90.0 | every other `web/src` file | 0 | 0 | 0 | 0 |
| `src/labels/legacy.ts` | 100 | 98.2 | 100 | 75.0 | `desktop/main.ts`, `desktop/preload.ts` | 0 | 0 | 0 | 0 |
| `src/labels/model.ts` | 98.7 | 99.0 | 100 | 93.2 | `src/licenses.ts` | 100 | 100 | 100 | 76.9 |
| `src/labels/store.ts` | 100 | 98.0 | 100 | 92.5 | `src/paths.ts` | 88.9 | 90.5 | 100 | 90.9 |
| `src/labels/try.ts` | 94.4 | 95.3 | 100 | 75.0 | `src/pipeline/segmenter.ts` | 97.9 | 95.8 | 92.6 | 91.3 |

### After Phase 1 (28 files, 277 tests)

| Folder | lines | statements | functions | branches |
|---|---|---|---|---|
| `src/**` | 86.88 | 83.12 | 83.52 | 72.57 |
| `web/src/**` | 1.01 | 0.99 | 0.57 | 1.85 |
| `desktop/**` | 0.00 | 0.00 | 0.00 | 0.00 |

The small drop in `src` is the echo-gate engine test no longer opening a real socket (below).

### After Phases 3, 4, 6, 7, 8 and 9 (65 files, 1,983 tests: 1,938 pass, 45 expected fails)

| Folder | lines | statements | functions | branches |
|---|---|---|---|---|
| `src/**` | 93.01 | 91.44 | 91.57 | 86.57 |
| `web/src/**` | 100.00 | 99.53 | 98.95 | 97.42 |
| `desktop/**` | 100.00 | 100.00 | 100.00 | 100.00 |

Thresholds raised to src 93/91/91/86, web/src 100/99/98/97, desktop 100/100/100/100. `src/**` still counts Phase 5's
files (`src/server`, `src/store`, `src/cli`) at their baseline. Per file, every file in Phases 3, 4, 6, 7 and 8 is at
100 % lines; the branch gaps below 100 % are defensive `??` fallbacks and guards no allowed seam can reach (listed per
phase under Deviations). The one file under a target: `src/speakers/registry.ts` branches 84.93 % (target 90): the
`?? 0` / `?? []` at :115, 149, 155, 165–166, 199–204 and the fallback at :123 are unreachable, because `create()`
always sets those maps and a stream with no centroid always has a placeholder.

### After Phases 5 and 10 (74 files, 2,212 tests: 2,157 pass, 55 expected fails)

| Folder | lines | statements | functions | branches |
|---|---|---|---|---|
| `src/**` | 99.45 | 99.22 | 99.18 | 97.31 |
| `web/src/**` | 100.00 | 99.53 | 98.95 | 97.42 |
| `desktop/**` | 100.00 | 100.00 | 100.00 | 100.00 |

Every folder is above its §3 target. Thresholds raised: src 99/99/99/97. Files under a per-file target (branches):
`src/speakers/registry.ts` 84.93 % (above) and `src/server/inProcess.ts` 86.66 % (`v !== undefined` and
`res.statusCode ?? 500` cannot take their other arm from Node's http). Also below 100 % but above target:
`src/cli/replay.ts` functions 91.7 % (the bus's `onInvalid` callback never fires, and the entry guard's true branch
runs only as a child process); `src/server/main.ts` ~96 % (`main()`, the `npm run serve` body, runs only as a child
process, and S2 does not cover it; the `BudgetExhaustedError` catches in `assist`/`tryOn` and some `??` fallbacks are
unreachable).

### Final (Phase 13, `npm run test:all` via `test-suite.sh`, exit 0 in 192 s)

| Layer | Result |
|---|---|
| Vitest | 74 files, 2,212 tests: 2,157 pass, 55 expected fails (`it.fails`, each a ledger row) |
| Swift | 25 tests in 5 suites; ClockLock.swift 98.8 % lines (gate 90 %) |
| Playwright, web | 23 scenarios (3 of them `test.fail` bugs); 69/69 over `--repeat-each=3` |
| Playwright, Mac app | 15 scenarios (1 `test.fail` bug); 45/45 over `--repeat-each=3`, beside the installed Tattle |

| Folder | lines | statements | functions | branches | §3 target |
|---|---|---|---|---|---|
| `src/**` | 99.45 | 99.22 | 99.18 | 97.31 | 95 / 95 / 95 / 90 |
| `web/src/**` | 100.00 | 99.53 | 98.95 | 97.42 | 90 / 90 / 90 / 85 |
| `desktop/**` | 100.00 | 100.00 | 100.00 | 100.00 | 90 / 90 / 90 / 85 |

Thresholds in `vitest.config.ts`: src 99/99/99/97, web/src 100/99/98/97, desktop 100/100/100/100.

**Exclusions:** none. `grep -rn "v8 ignore" src desktop web/src` finds nothing.

## Bug ledger

| Id | File:line | Impact | Status |
|---|---|---|---|
| B1 | `src/server/main.ts:506` (`Engine.start`) | A name over 120 characters answered 400 while the session kept running; a retry got 409 | Fixed, `6dc0522` |
| B3 | `src/server/main.ts:1129`, `src/cli/calibrateBoundary.ts:63`, `src/cli/calibrateSpeakers.ts:51` | The command-line tools silently did nothing from a path with a space | Fixed for spaces, `8c5313b`; for symlinked paths after the spec (`isMain` in `src/entry.ts` resolves the path first), 2026-09-30 |
| B3-L1 | the same guards | S3's guard threw `ERR_INVALID_ARG_TYPE` when `process.argv[1]` is undefined, as in the packaged Mac app started from Finder: `src/server/main.ts` is bundled into the app, so the app would not have started. Found in review before any release | Fixed, `8cb59f2` (test first) |
| B2 | `web/src/panels.ts:590` (`segmentMatches`) | A speaker filter plus a label filter emptied the transcript; a speaker filter alone dimmed every segment | Fixed, `1e64d51` |
| B4 | `web/src/licenses.ts:15` (`linkify`) | `<https://x>` linked to `https://x>`, breaking 7 real notices | Fixed, `6884e05` |
| B5 | `web/src/api.ts:19` | An error with an empty body gave an empty message: blank toasts | Fixed, `4a83370` |
| A2-L1 | `src/audio/nativeSource.ts:62` | A stale chunk moves the LiveStream clock backwards | `it.fails` |
| A2-L2 | `src/audio/nativeSource.ts:247` | A non-JSON line from `listDevices` throws inside the exit handler; the promise never settles | Not writable as `it.fails` (an uncaught throw from a child's event) |
| A2-L3 | `src/audio/nativeSource.ts:154` | No `'error'` listener on the spawned helper: a spawn error (EACCES) would crash the engine | `it.fails` |
| A2-L4 | `src/audio/nativeSource.ts:173,191` | A `started` line without a numeric `epochMs` holds frames forever | `it.fails` |
| A2-L5 | `src/audio/nativeSource.ts:167` | More output after a malformed frame gives duplicate errors and two SIGKILLs | `it.fails` |
| A2-L6 | `src/audio/nativeSource.ts:222` | After a signal kill, `stop()` waits for the restart delay | `it.fails` |
| T1-L1 | `src/transcribe/live.ts:183-190`, `:197` | Audio fed while the socket is closed is billed but never sent; no reconnect mid-utterance | `it.fails` (two tests) |
| T2-L1 | `src/transcribe/openai.ts:133-135` | An invalid fix regex logs a second, failed row after the paid one, and the transcript is thrown away | `it.fails` |
| AP-L1 | `src/transcribe/apple.ts:409-418` (with `start()` :278-283) | When the helper cannot start, `transcribe()` still queues the line, which never settles, even after `close()`: `Session.finish` would wait forever | `it.fails` |
| S2-L1 (speakers) | `src/speakers/suggest.ts:130` | By voice alone, a speaker too short for a voiceprint is never suggested (docs/speakers.md says: to the biggest talker) | `it.fails` |
| P1-L1 | `src/pipeline/segmenter.ts:209` | A System 1 question with id `boundary` replaces the locked boundary question (config only) | `it.fails` |
| P2-L1 | `src/pipeline/timeline.ts:169-172` (`track`) | A throw from `write`/`emit` in `label()` is an unhandled rejection, and `idle()` rejects | `it.fails` |
| P2-L2 | `src/pipeline/timeline.ts:32` (`mentionsOf`) | ASCII-only `\w` lookarounds: "Metaé" counts as a mention of Meta | `it.fails` |
| P4-L1 | `src/pipeline/session.ts:402-403` | A throw in a line's `.then` makes `run()` reject without `session.ended` | `it.fails` |
| P4-L2 | `src/pipeline/session.ts:378` | A synchronous throw from `transcribe` aborts the whole session | `it.fails` |
| P4-L3 | `src/pipeline/session.ts:176,188` | The constructor opens live text (sockets, or the Apple helper) before `run()` | `it.fails` |
| P4-L4 | `src/pipeline/session.ts:336` with `mergeSources` | `stop()` never returns while a source has not yielded its first frame | `it.fails` |
| FC-Q1 | `src/factcheck/queue.ts:103-104` (`arm`) | A pending stale timer stops a sooner wake for a freed hourly slot: research waits up to `staleAfterMs` | `it.fails` |
| S2-L1 (System 2) | `src/factcheck/s2.ts:162-163` (`stripCitations`) | A citation whose URL has parentheses leaves a stray `)` on the card | `it.fails` |
| CH-L1 | `src/chat/chat.ts:447` | A title that only got shorter by collapsing spaces still gets `…` (cosmetic) | `it.fails` |
| DM-L1 | `desktop/main.ts:310-319` (`offerRestart`) | A restart put off through Check for Updates… is offered again by the automatic offer that waited for the show to end | `it.fails` (a judgment call: low) |
| DM-L2 | `desktop/main.ts:244-259` (`before-quit`) | ⌘Q again while the on-air quit sheet is up stacks a second sheet | `it.fails` (low) |
| S-state-1 | `web/src/state.ts:373` | After an event-stream reconnect, every error is listed twice | Fixed after the spec, 2026-09-30 (an error seen before is not listed again) |
| W7-L1 | `web/src/chat.ts:297-310` | A reply stream that ends without `done` is never fetched again: the unsaved version stays on screen | `it.fails` |
| W7-L2 | `web/src/app.ts:230, 244-247` | The page listens for the engine's `error` events under the name EventSource uses for a dropped connection: every drop runs `JSON.parse(undefined)` and throws | Fixed after the spec, 2026-09-30 |
| E2E-L1 | `web/src/app.ts:248-250` (`es.onerror`) | Same cause: every engine `error` event (and each one replayed on reconnect) marks the event stream as lost (`#conn.down`) while it is connected | Fixed after the spec, 2026-09-30 |
| E2E-L5 | `src/audio/wav.ts:41` (`readWav16k`) | **Severe for the Mac app**: `sherpa.readWave(path)` without `false` throws "External buffers are not allowed" inside Electron, and `FileSource` reads every replayed WAV through it, so a replay in the Mac app (Recordings → Replay) fails as it opens the audio. The gotcha's fix covered `vad.front` and `extractor.compute`, not `readWave` | Fixed after the spec, `7e860f7` (2026-09-30): verified in the development app, where a replay went from ending with this error to running to its end |
| E2E-L4 | `web/src/main.ts:13` | The shell shows (`booting` removed) before `app.js` has bound its controls: a click in that gap does nothing (seen under load) | Not testable deterministically; the E2E `open()` waits for the first render |
| §14.3 | `web/src/api.ts:153` → `transfer.ts:165` | An import answered with a 2xx that isn't JSON leaves the window on "Importing…" | Not writable as `it.fails` (unhandled rejection) |
| §14.4 | `web/src/keys.ts:20-49, 115` | The guide links are shared nodes: a second card showing at once takes them | `it.fails` |
| §14.5 | `web/src/keys.ts:245` | `showSetup` throws when unconfigured with no key missing | `it.fails` |
| §14.6 | `web/src/chat.ts:208-209` | Another session's chat list stays in the sidebar | `it.fails` |
| §14.7 | `web/src/chat.ts:180` | Switching recordings opens the new one's chat with the old one's id | `it.fails` |
| §14.8 | `web/src/chat.ts:215, 503` | The reply being written shows in another chat | `it.fails` |
| §14.9 | `web/src/chat.ts:267, 494` | Clicking a starter question wipes the typed draft | `it.fails` |
| §14.10 | `web/src/chat.ts:58, 62` | `tokens(999_600)` reads "1000k"; a tiny price reads "$0" | `it.fails` (two tests) |
| §14.12 | `web/src/ui.ts:31` | A select's accessible name includes every option when its label wraps it | `it.fails` |
| §14.13 | `web/src/calls.ts:292` | When Jev cost nothing: "10,000,000× cheaper" | `it.fails` |
| §14.20 | `web/src/transfer.ts:190` | Already in the library without a copy token shows the just-imported layout | `it.fails` |
| LIC-L1 | `web/src/licenses.ts:15` | A URL inside inline code is linkified: shows as `[url](url)` | `it.fails` |
| LIC-L2 | `web/src/licenses.ts:15` | `[https://x](https://x)` comes out garbled | `it.fails` |
| LIC-L3 | `web/src/licenses.ts:38` | A file listed with no text throws: that component cannot be opened | `it.fails` |
| PLY-L1 | `web/src/player.ts:144` | A late `pause` from the previous recording's audio reports 0 for the new one (can clear `?t=`) | `it.fails` |
| PAN-L1 | `web/src/panels.ts:755` | The first line by a speaker the page does not know yet has no name tag | `it.fails` |
| P6-L2 | `web/src/panels.ts:1206` | The recordings search keeps the first render's state: wrong Viewing/Current rows, delete-while-viewing from old data | `it.fails` |
| LBW-L1 | `web/src/labels.ts:24` (`toId`) | Accented names split: "Résumé" becomes `re_sume` (cosmetic) | `it.fails` |
| LBW-L2 | `web/src/labels.ts:492` | A save failing with a plain Error shows "TypeError: …" instead of its message | `it.fails` |
| LBW-L3 | `web/src/labels.ts` (`openEditor`, ~:479) | Save can be pressed before the first check answers (docs: Save waits until there are no errors) | `it.fails` |
| LBW-L4 | `web/src/labels.ts:562` (`tryIt`) | After a needsKey refusal with `GET /api/setup` failing, Try retries in a loop | `it.fails` |
| §11.2 | `src/server/main.ts:533` | A live capture keeps running when its Session cannot be built | `it.fails` |
| §11.4 | `src/server/audio.ts:85-91` | An error after the headers are sent (an unreadable WAV) is an unhandled rejection that ends the process | Not writable even as `it.fails` (it would crash the worker) |
| §11.5 | `src/store/transfer.ts:246-251` | **Privacy:** a `.tattle` export carries the exporter's home path in events.jsonl (confirmed in a Mac app recording: two occurrences) | Fixed after the spec, 2026-09-30: the export leaves out each event's `dir` |
| §11.6 | `src/store/transfer.ts:127` | Exporting a listed recording without events.jsonl fails with a raw ENOENT | `it.fails` (two tests) |
| §11.7 | `src/store/transfer.ts:226` | Two recordings with the same id and no start time count as the same (409) | `it.fails` |
| §11.8 | `src/store/transfer.ts:171` | An original WAV whose header was never finalised imports cut to 1 s | `it.fails` |
| §11.9 | `src/store/library.ts:202` | Recordings without a start time sort before every dated one | `it.fails` |
| §11.18 | `src/store/transfer.ts:276` | A manifest without `recording` gives a raw TypeError instead of a 400 | `it.fails` |
| §11.19 | `src/cli/replay.ts:105` | Replay exits 0 even after the credit ran out (402) | `it.fails` |
| §11.20 | `src/cli/calibrateSpeakers.ts:44` | `--voices abc` runs with a NaN limit | `it.fails` |

## Deviations and decisions

User decisions taken on 2026-09-30, before Phase 0:

- **The spec predates 34 commits** (0.9.0 Apple Speech, 1.0.0 label sets, 1.0.1): 45 files, +4,588/−678 lines in `src`, `web/src`, `desktop`, `native`. The user chose to proceed: the inventories are used for code that did not change; new and heavily changed modules (`src/labels/**`, `src/settings.ts`, `src/transcribe/apple.ts`, `web/src/labels.ts`, and the changed parts of `server/main.ts`, `panels.ts`, `timeline.ts`, `session.ts`, `web/src/keys.ts`) get tests written from the code and docs under the same rules (§4.0).
- **Obsolete items** are replaced by what the code does now: the $3 dev cap (`sumDevSpend`, FS7, `E2E_OVER_CAP`) was removed on 2026-09-29; `Budget` now refuses only after OpenRouter's non-transient 402. FS7 becomes "OpenRouter 402 → budget exhausted". The first-run screen appears only when the OpenAI engine is in use (FS1 and the Electron setup scenario force that engine).
- **`native/transcribe` (the Apple Speech Swift helper) is out of scope** for Swift tests: follow-up. Its TypeScript side (`src/transcribe/apple.ts`) is unit-tested.
- **Baseline at start:** 27 files, 271 tests, all green (the spec said 23 / 191). "Must stay at 191" reads as "must stay at 271".
- The staged move of `specs/260929-01-right-column-tabs` to `-DONE` was committed first (`fa50f3c`) so the tree was clean.
- The user asked to run through to Phase 13, stopping only at the spec's stop-and-ask points.

Phase 1:

- **An existing test opened a real WebSocket to OpenAI.** `tests/echoGate.test.ts` › "echo gate through the engine" starts a live session through `Engine` without a `liveConnect`, so the Session constructor's live text (P4-L3) opened `wss://api.openai.com/v1/realtime` with `process.env.OPENAI_API_KEY ?? ""` on every run (refused: no key is set here, so nothing was spent, but it broke the no-network rule). `tests/setup.ts` now makes the global `WebSocket` throw, like `fetch`, and that test passes a `FakeSocket` factory; its assertions are unchanged.
- **Fakes moved to `tests/fakes/`** with their behaviour unchanged, renamed on export where names clashed: `fakeServicesFetch` (session.test's `fakeFetch`) with `TEST_OPENROUTER_KEY`/`TEST_OPENAI_KEY`, `fakeKeyCheckFetch` (keys.test's `fakeFetch`), `transcribeOnlyServices` (echoGate's `services`), `toneWav` (transfer's `tone`). Also moved: `ramp`, `take`, `all` with `FakeHelper`, and library.test's `ev`/`seq` with `makeSession` (the counter stays shared). New builders: `responses.ts` (`json`, `text`, `sse`, `sseData`, `timeoutError`, `networkError`, `brokenBody`), `async.ts` (`deferred`, `flushMicrotasks`), `env.ts` (`tmpDir`, `cleanTmpDirs`, `withEnv`, `snapshotKeyEnv`, `withAppPaths`), `bus.ts` (`strictBus`, collecting rather than throwing), `pcm.ts` (`sine`, `silence`, `constant`, `wavFile`, `fixtureSlice`), `embedder.ts` (`FakeEmbedder`, `vec`), `jev.ts` (`FakeJev`, `jevOk`, `jevErr`, `noulA`/`choiceA`/`scoreA`), `openrouter.ts` (`FakeOpenRouter`, `completion`, `replyChunks`).
- **U1 (happy-dom 20.14.5), probed:** it has dialogs (`showModal`, `close(rv)`, `returnValue`, `<form method="dialog">`), history, `select.labels` and the select accessors, `PointerEvent`, `setPointerCapture`, `scrollIntoView`, `requestAnimationFrame`, clipboard, `ResizeObserver`, `MutationObserver`, `XMLHttpRequest`, `Audio`. It lacks the Popover API (`showPopover`/`hidePopover`/`togglePopover`; `:popover-open` parses but is never true), `EventSource` and `AudioContext`. A dialog's `close` event fires **synchronously** in happy-dom (a browser fires it in a later task). `:focus-visible` parses; the body counts as focused. Shims in `installBrowserStubs()`: the Popover API with `:popover-open`, `FakeEventSource`, `FakeAudio`, `FakeAudioContext`, `window.open` and `scrollIntoView` spies. `tests/web/probe.test.ts` pins both happy-dom's behaviour and the shims.
- **U2, probed:** both `/* v8 ignore next */` and `/* v8 ignore next -- @preserve */` drop the line from the report under vitest 5.0.1. The project uses the `-- @preserve` form (the one the Vitest docs recommend).
- **Playwright:** `npx playwright test --list` exits 1 while there are no tests ("No tests found"); `--pass-with-no-tests` makes it 0. The config loads.
- `npm i` warned that the install scripts of electron-winstaller, esbuild and fsevents were not run (npm's install-script approval); esbuild still works (`0.28.2`), and they are existing dependencies.

Phase 2:

- `docs/testing.md` covers what exists now (loop, layers, commands, offline rules, fakes, DOM tests, coverage policy, rules). Its E2E web, E2E Electron, Swift and release-gate sections are written in Phases 9–12, as the spec says. `CLAUDE.md` names `npm run test:swift`, which Phase 11 adds.
- The doc manifest was regenerated with `build-doc-manifest.py`; `--affects tests/foo.test.ts` names `docs/testing.md`.

Phase 11:

- 25 Swift tests in 5 suites (`ClockLockTests`, `LevelsTests`, `ConverterTests`, `DevicesTests`, `CaptureErrorTests`). Line coverage: ClockLock.swift 98.8 % (169/171), Devices.swift 17.9 %, Mic.swift 4.4 %, SystemTap.swift 0 %, main.swift 0 % (the last three are hardware- and permission-only, not gated). Proved to bite: raising the late-stream tolerance a hundredfold failed `padsALateStreamWithSilence` and `trimsAStreamThatRunsAhead`. The gate fails (exit 1) when set above the measured value.
- Seam S6 only: `Devices.fourCC` is `static` (internal) instead of `private static`.
- **Deviation:** `test:swift` is `node scripts/swift-coverage.mjs` alone rather than `swift test … && node scripts/swift-coverage.mjs`, because the script runs `swift test --enable-code-coverage` itself; the spec's form would run the tests twice.
- Not testable without a zero-rate `AVAudioFormat` (which cannot be made): `AdaptiveConverter`'s `r <= 0` guard.
- `npm run build:capture` (release) still builds; it does not build the test target.
- Order: Phase 11 was done before Phases 3–8 landed (they ran as parallel agents in separate worktrees, and Phase 11 touches only `native/capture`, `scripts/` and `package.json`).

Phases 3–8 (2026-09-30): run as six parallel agents, each in its own git worktree, merged by cherry-picking onto
master after review (base, diff, no `.only`/`.skip`, no loosened assertion, production diff limited to B1–B5 and the
allowed seams). Every new test file was proved to bite (a line sabotaged, red, reverted), and every `it.fails` was
run once as a plain `it` to confirm it fails for its stated reason.

- **The worktrees were created at `0db0b31`** (v1.0.1), not at master; each agent fast-forwarded its branch to
  `e2c5e89` before starting.
- **`tests/fixtures/` is not in git**: the `.gitignore` rule `fixtures/` (meant for the recorded fixture audio) also
  matches `tests/fixtures/`, so `labels.default.legacy.json` and `legacy-session.json` exist only in this checkout.
  A fresh clone fails `tests/labels.test.ts`, `tests/library.test.ts` and `tests/stats.test.ts`. Not changed here
  (outside this spec): a follow-up for the user (`!tests/fixtures/` in `.gitignore`, after checking the two files hold
  nothing private).
- **Phase 3** (+349 tests; `0917486…81290e1` → `d368014…2abb983`): no production change. The 10 s real-time pacing
  test runs on fake timers with the same assertion. Five `appleSpeechStatus` tests that spawn a tmp script run only
  on macOS 26+ (`describe.runIf(macosSupportsAppleSpeech())`): on older macOS the code spawns nothing. Obsolete
  inventory cases dropped (dev cap, `replaceLabels`, `LabelConflictError`, fixed marker thresholds); five inventory
  expectations were wrong and follow the code (e.g. `vad.flush` without native flush feeds 33 windows, not 32).
- **Phase 4** (+306 tests; → `fa9c37c…e78afb3`): no production change. Pinned as current behaviour, for the user to
  decide: the gate's `floor(0.9×G)` lets a candidate lose its only good flag when G = 1 (the formula the docs state,
  though they also say "keep at least 90 %"); a refused System 2 call writes no `s2_calls` row while Jev logs one;
  deleting a chat mid-reply saves the reply and then errors "unknown chat"; Create with AI's 402 does not mark the
  budget exhausted (its budget covers one request); `retry-after: -5` gives no wait.
- **Phase 6** (+153 tests; → `9f329e8`): no production change; `desktop/**` 100 % on every measure. The inventory's
  "Transcription window" in the menu does not exist in `desktop/main.ts`; U3/U4 are left to Phase 10.
- **Phase 7** (+431 tests; → `4a83370…1d4f178`): B5 fixed. U10 works (`vi.mock` of `api.ts` with `makeFakeApi`
  replaces the page modules' `./api.js`). `tests/web/helpers-core.ts` removes the listeners and observers earlier
  tests' module instances left. Pinned: §14.19 (a dropped trailing SSE block) and §14.21 (lenient `parseTime`).
- **Phase 8** (+467 tests; → `1e64d51…d730424`): B2 fixed in full (nothing in the docs or tests says the dimming is
  deliberate; `docs/architecture.md` says only label filters dim) and B4 fixed. panels tests are split into
  `panels.test.ts`, `panels-header.test.ts`, `panels-windows.test.ts` (§4.0.2 names one file per module).
  happy-dom limits met: a select's value ignores `selected`, `WheelEvent` lacks `ctrlKey`/`clientX`, no `Option`
  constructor, one `scrollIntoView` spy on the prototype.
- **Flakes under load:** with six agents running, one full run failed `nativeSource.test.ts` once and one run of
  `speakers.test.ts` took 126 s (timeout 120 s); both passed on their own and in every later full run.

Phase 9 (2026-09-30):

- **One harness, not two:** `e2e/harness/server.ts` runs the real engine with fake services. The scripted scenarios
  use the same harness with `E2E_CONTROL=1` (commands on stdin: emit an event on the engine's bus, drop the event
  streams, push audio) and `E2E_LIVE=hold` (a live session whose capture hears nothing), rather than
  `createApiServer(FakeEngine)`: the page needs a real `/api/state` snapshot of a running session, which the
  `FakeEngine` does not produce. There is no `e2e/harness/scripted.ts`.
- 23 scenarios (spec: ≥ 12): FS1 first run (the OpenAI key only: Apple Speech is reported unavailable), FS2 replay
  (counts derived from the script: 3 flagged claims, 1 repeat badge, 3 speakers; compared with the library's summary),
  FS3 chat, FS4 recordings, FS5 playback and `?t=`, FS6 export then import as a copy, FS7 replaced by OpenRouter's
  402, FS8 Start live with pause, resume and stop; scripted: an engine error in Insights, health meters, speaker mode,
  OpenRouter's refusal, a promoted System 1 rewrite, a lost event stream; navigation: the API keys window, a
  recording's URL with `?t=`, `?tab=` and `?panel=…&section=`, home while a recording is open, Back, an unknown
  recording, the Licenses page; three `test.fail` bugs (E2E-L1, W7-L2, S-state-1).
- `npx playwright test --project=web --repeat-each=3`: 69/69 passed (4.7 min). An earlier 3× run failed once in FS2
  at a UI step (the replay popover was not open): E2E-L4, fixed in the fixture's `open()`, not with a retry. FS2's
  results never varied.
- `fakeServicesFetch` gained an option, `echoKeyOnce` (default true: the session test's behaviour is unchanged), so
  the harness can drop the one echoed-key Jev error. The seeded recordings get real WAVs (makeSession's are bare
  bytes, which import cannot decode).

Phase 5 (2026-09-30; +225 tests; → `8c5313b…df9a052`): B1 and B3 fixed test-first, S2 (`run(argv, deps)` in replay
and both calibration tools; replay had no entry guard at all, so it got one in the S3 form) and S3. §4.0.6 in
`tests/server.test.ts`: `secret.txt` in a mkdtemp folder, and the FakeEngine reset before each test. Not written: the
`serve --replay … prints 'replaying …'` case (it needs a preload with a fake fetch in a child process, which §4.0.2
does not list).

- **Review finding, fixed:** the S3 guard as the spec gives it (`import.meta.url === pathToFileURL(process.argv[1]).href`)
  throws when `process.argv[1]` is undefined. `src/server/main.ts` is bundled into the Mac app's main process, and a
  packaged app started from Finder has no `argv[1]`: the app would not have started. A test loading the four modules
  with no `argv[1]` failed (`ERR_INVALID_ARG_TYPE`) and passes with `process.argv[1] && …` (`8cb59f2`, B3-L1). The
  development app and every test pass the path, which is why nothing else caught it.

Phase 10 (2026-09-30):

- 15 scenarios (spec: ≥ 8), `--repeat-each=3`: 45/45 passed in 59 s with the installed `/Applications/Tattle.app`
  running throughout (it was already open, and was left running). Everything the dev app keeps is inside the test's
  HOME (`userData` asserted), so isolation holds.
- U3 resolved: Electron's module properties are writable; `dialog.showMessageBox`, `shell.openExternal` and
  `shell.openPath` are replaced in the main process right after launch. U4: with an isolated HOME the lock is the
  test's own, and a second launch with the same HOME exits 0 and fires `second-instance` in the first. U5: the
  symlinked working folder works (no seam S5). U11: Playwright 1.63 launches Electron 44.4.5.
- `TATTLE_FORCE_NO_APPLE_SPEECH=1` keeps the on-device helper from starting (and its model from being installed).
- sherpa-onnx inside Electron: the VAD and the embedder work with the `false` copies. `readWave(path)` does not:
  E2E-L5 (see the ledger), the most serious finding of this work, since it breaks replays in the Mac app.

Phase 12 (2026-09-30):

- `.agents/skills/release-tattle/scripts/test-suite.sh` checks the models and fixture, Playwright's Chromium and
  `swift` (each with its fix command), then runs `npm run test:all`. It exited 0 in 192 s on this Mac.
- `SKILL.md`: a new **Step 1 — Test suite**; Steps 1–11 renumbered 2–12 with every cross-reference; the Gates row and
  the "never run the app" constraint reworded as the spec gives. **Deviation:** the spec's "run Step 2 first → run
  Steps 1 and 2 first" would, after renumbering, name the mode step instead of the docs step (now Step 3); the
  constraint says "Step 1 (the test suite) and Step 3 (update-doc, then git-commit …)". `skill.json` 0.6.0, its
  description and the `gh` dependency's step numbers (10, 12). README § Releasing (a new item 1, renumbered, and
  `test-suite.sh` first in "Without Claude Code"), `docs/website.md` (Step 12), `docs/testing.md` § Release gate.
  `checks.sh` is unchanged. The release itself was not run.

Phase 13 (2026-09-30):

- Every §3 box is checked: `npm run test:all` exits 0; the per-folder coverage is above target and enforced; no
  exclusion; `swift test` passes with ClockLock at 98.8 %; 23 web and 15 Mac app scenarios; `CLAUDE.md`,
  `docs/testing.md` (frontmatter, README index, manifest); release Step 1, `skill.json` 0.6.0, README; the notices
  check passes; conventional commits, nothing pushed.
- Docs were brought up to date by hand rather than through the `/update-doc` skill, with the items the spec lists:
  `docs/testing.md` (final), `docs/gotchas.md` § Testing (the six traps the spec names, plus the network-through-a-
  global, the Electron-only `readWave`, `pathToFileURL(undefined)` and the untracked `tests/fixtures/`), its
  description and tags, `docs/architecture.md` § Tests, the README doc index and scripts, and `doc-manifest.json`
  regenerated with `build-doc-manifest.py`.

## Suggested follow-ups (for the user to decide)

By severity:

1. **E2E-L5, the Mac app cannot replay a recording** (`src/audio/wav.ts:41`: `sherpa.readWave(path)` → `readWave(path, false)`).
   Every replay in the Mac app (Recordings → Replay) fails as it opens the audio. The fix is one argument, and the
   `test.fail` in `e2e/electron/app.spec.ts` turns red when it lands. A candidate for the next patch release.
2. **§11.5, privacy:** a `.tattle` export carries the exporter's home path in `events.jsonl`.
3. **`tests/fixtures/` is not in git** (the `.gitignore` rule `fixtures/` matches it): a fresh clone fails three test
   files. Add `!tests/fixtures/` after checking the two JSON files hold nothing private.
4. **The web page's event stream** (`web/src/app.ts`): the engine's `error` event collides with EventSource's own
   (W7-L2: a throw on every dropped connection; E2E-L1: every engine error marks the stream lost), and a reconnect
   lists every error twice (S-state-1).
5. **Engine robustness** (session, capture, transcription): P4-L1…L4, A2-L2…L6, AP-L1 (a line queued while the Apple
   helper cannot start never settles, so `Session.finish` would wait forever), P2-L1, §11.2, §11.4.
6. **B3 with a symlinked path:** S3's `pathToFileURL` guard still does nothing when the tool is started through a
   symlink (Node resolves the module's symlinks but not `argv[1]`). A `realpathSync` in the guard would fix it; S3 did
   not allow it.
7. **Chat and label-set window bugs** (§14.4–§14.20, W7-L1, LBW-L1…L4, P6-L2, PLY-L1, PAN-L1, LIC-L1…L3), and the
   behaviours pinned in Phase 4 for a decision (the gate's rounding at G = 1, the missing `s2_calls` row on a budget
   refusal, deleting a chat mid-reply, Create with AI's 402, a negative `retry-after`).
8. **Tests still out of scope:** the website (`website/`), the release scripts, `scripts/**`, and the Apple Speech
   Swift helper (`native/transcribe`).

## After the spec (2026-09-30, `/go-with-recommendations`)

The recommendations above were carried out, test-first, each verified: `tests/fixtures/` tracked (`!tests/fixtures/`;
a fresh clone passes the three files); E2E-L5 fixed (the `readWave` contract test red first, then a replay in the
development app checked before and after the fix); W7-L2, E2E-L1 and S-state-1 fixed (their tests made plain, red,
then green); §11.5 fixed; B3 extended to symlinked paths with `isMain`; the leftover worktrees removed. Follow-ups 1–4
and 6 above are done; 5, 7 and 8 remain, and pushing and releasing wait for the user.

## Resume notes

The spec is complete. Nothing is pushed: every commit is local on `master`.
