# PROGRESS — Test-driven development for Tattle

The running log for `SPEC.md`. Updated after every phase.

## Status

- [x] Phase 0 — Preconditions and PROGRESS.md (2026-09-30)
- [x] Phase 1 — Tooling, shared fakes, probes, baseline (2026-09-30)
- [x] Phase 2 — CLAUDE.md and docs/testing.md (2026-09-30)
- [ ] Phase 3 — `src/audio`, `src/speakers`, `src/transcribe`, `src/pipeline`
- [ ] Phase 4 — `src/jev`, `src/factcheck`, `src/chat`, budget, config, keys, paths, licenses, version (+ `src/labels`, `src/settings.ts`)
- [ ] Phase 5 — `src/server`, `src/store`, `src/cli`
- [ ] Phase 6 — `desktop/`
- [ ] Phase 7 — `web/src` state, router, api, desktop, calls, transfer, keys, ui, chat, app, main
- [ ] Phase 8 — `web/src` panels, timeline, player, markdown, licenses, dom (+ `labels.ts`, `icons.ts`)
- [ ] Phase 9 — E2E web (Playwright + Chromium)
- [ ] Phase 10 — E2E Electron
- [ ] Phase 11 — Swift tests for the capture helper
- [ ] Phase 12 — The suite becomes Step 1 of every release
- [ ] Phase 13 — Close out

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

## Bug ledger

| Id | File:line | Impact | Status |
|---|---|---|---|

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

## Resume notes

Next: Phase 3 (inventory 1: `src/audio`, `src/speakers`, `src/transcribe`, `src/pipeline`).
