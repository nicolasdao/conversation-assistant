---
description: How Tattle is tested, test-first — the TDD loop, the test layers and where each test goes, the commands, the shared fakes, DOM tests under happy-dom, the coverage thresholds and their exclusions, and the rules every test follows (offline, no real user data, no spend).
tags: [testing, tdd, vitest, coverage, playwright, e2e, swift]
source:
  - tests/**
  - e2e/**
  - vitest.config.ts
  - playwright.config.ts
  - native/capture/Tests/**
  - scripts/swift-coverage.mjs
  - .agents/skills/release-tattle/scripts/test-suite.sh
---

# Testing

Every change to Tattle is test-first (the rule is in [CLAUDE.md](../CLAUDE.md)). The tests exist to protect a live show: "Reliability matters as much as features on air" ([Mission](mission.md)). A test that bites matters more than a coverage number.

## The TDD loop

- **New code and fixes:** red, green, refactor. Write the test that states the behaviour (for a bug, one that reproduces it), run it and watch it fail for the reason you expect, make the smallest change that passes it, then clean up with the suite green.
- **Tests for code that already exists** (characterisation tests): write the test from the *intended* behaviour (the docs, the code's comments), not from what the code happens to do. If it passes, prove it bites once per new test file: break the line under test (invert a condition, change a constant), watch a test go red, and put the line back. Never commit the sabotage.
- **When such a test fails**, the code and its intent disagree. Either fix the bug test-first, or, when the fix is not in scope, keep the test as `it.fails("BUG <id>: <what>", …)`: it stays green while the bug is there and turns red when someone fixes it, telling them to make it a plain `it`.

## Layers

| Layer | Where | Runner | Environment |
|---|---|---|---|
| Unit and integration (engine; the Mac app's main process with a mocked `electron`) | `tests/<area>.test.ts`: extend the file for the same module, or add one | Vitest | node |
| Shared fakes and builders | `tests/fakes/*.ts`, imported from `tests/fakes/index.ts` | — | — |
| Web page, DOM | `tests/web/<module>.test.ts`, first line `// @vitest-environment happy-dom` | Vitest | happy-dom |
| Web test helpers | `tests/web/helpers.ts` | — | — |
| End-to-end, web page | `e2e/web/*.spec.ts` (harness in `e2e/harness/`) | Playwright (Chromium) | real browser |
| End-to-end, Mac app | `e2e/electron/*.spec.ts` | Playwright `_electron` | development app |
| Capture helper (Swift) | `native/capture/Tests/tattle-capture-tests/*.swift` | `swift test` | — |

- Pure web modules (`web/src/router.ts`, `web/src/state.ts`) can be tested in node without the docblock.
- Playwright files end in `.spec.ts` and live under `e2e/`, so Vitest (which runs `tests/**/*.test.ts`) never picks them up.

## Commands

| Command | Runs |
|---|---|
| `npm test` | Every Vitest test, offline, in about 30 s |
| `npx vitest run tests/<file>.test.ts` | One file |
| `npm run test:coverage` | Every Vitest test with coverage; fails under the thresholds. The report is in `coverage/index.html` |
| `npx vitest run --coverage --coverage.include='src/pipeline/**'` | Coverage of one folder while working on it |
| `npm run test:e2e` | Builds the page and the Mac app's bundle, then runs Playwright |
| `npm run test:swift` | The capture helper's Swift tests with coverage, and the ClockLock gate (`scripts/swift-coverage.mjs`) |
| `npm run test:all` | Type checks, then coverage, then the Swift tests, then the end-to-end tests |
| `npm run typecheck` | Type checks the engine, the tests, and the page |

`npx playwright install chromium` downloads Playwright's browser once per Mac (outside `node_modules`). With no end-to-end test yet, `npx playwright test --list` needs `--pass-with-no-tests` to exit 0.

## Offline, free, and away from real data

- **No network.** `tests/setup.ts` replaces the global `fetch` and `WebSocket` with functions that throw "network disabled in tests". Every client takes its `fetch` or its socket factory through its constructor or options, so a test passes a fake. A code path that falls back to the global one fails loudly: that is how a test was found opening a real socket to OpenAI's realtime endpoint (a live session through `Engine` with no `liveConnect`; it now gets a `FakeSocket`).
- **No real data.** Several functions read the user's real files when given no path: `new KeyStore()` without `path` and `env`, `loadKeys()`, `credentialsPath()`, `appSupportDir()` and `migrateAppSupportDir()` without `base` touch `~/Library/Application Support/Tattle` (real keys and recordings), and `appPaths().sessions` defaults to the repository's `sessions/`. Always pass tmp paths; for the app's folders call `withAppPaths()` (or `setAppPaths({ sessions: tmp })`) with `afterEach(() => setAppPaths())`. Label sets are already redirected: `tests/setup.ts` points `TATTLE_LABEL_SETS` at a tmp folder.
- **Environment variables.** A test that sets `OPENAI_API_KEY`, `OPENROUTER_API_KEY` or `TATTLE_CREDENTIALS` restores them: use `withEnv({...}, fn)` or `snapshotKeyEnv()`.
- **No spend.** `npm run smoke`, `npm run preflight`, `npm run replay` and a real session in `npm run serve` or `npm run app` call paid services. They are never part of a test or a suite.

## Fakes (`tests/fakes/`)

| Fake | Imitates |
|---|---|
| `fakeServicesFetch(script)`, `TEST_OPENROUTER_KEY`, `TEST_OPENAI_KEY` | OpenAI transcription, Jev and System 2 behind one `fetch`, answering from the fixture's script (the first Jev call echoes the key in an error, to prove redaction) |
| `FakeJev`, `jevOk`, `jevErr`, `noulA`, `choiceA`, `scoreA` | Jev's decisions endpoint: a queue of responders, recording every parsed request |
| `FakeOpenRouter`, `completion`, `replyChunks`, `fakeOpenRouter` | OpenRouter's chat side: `/models`, `/chat/completions` (streamed or not) and `/generation?id=`; `fakeOpenRouter` is the chat tests' simpler one |
| `fakeKeyCheckFetch` | The key checks: OpenAI's `/v1/models` and OpenRouter's `/api/v1/key`, or offline |
| `FakeSocket` | The realtime WebSocket that live text uses |
| `FakeHelper`, `frameBytes`, `ramp`, `take`, `all` | The Swift capture helper as a child process, and its binary frames |
| `FakeEngine` | The engine behind the HTTP API (`EngineApi`), recording every command |
| `transcribeOnlyServices`, `flaky` | A session's services with transcription only (always up, or down for the first N calls) |
| `makeSession`, `ev`, `recording`, `toneWav` | Recording folders on disk, as the library and export expect them |
| `FakeEmbedder`, `vec` | The speaker embedder, and unit vectors with a chosen similarity |
| `json`, `text`, `sse`, `sseData`, `timeoutError`, `networkError`, `brokenBody` | Responses and the errors `fetch` throws |
| `deferred`, `flushMicrotasks` | Promise control for ordering and concurrency |
| `tmpDir`, `cleanTmpDirs`, `withEnv`, `snapshotKeyEnv`, `withAppPaths` | Tmp folders, environment variables, the app's folders |
| `strictBus` | An `EventBus` that collects every event failing its schema |
| `sine`, `silence`, `constant`, `wavFile`, `fixtureSlice` | Audio samples and WAV files; a slice of the fixture for fast tests with the real VAD |

Tests that need the models or the fixture call `requireAssets()` from `tests/helpers.ts` (`npm run models && npm run fixtures` makes them; both are free).

## Web DOM tests (happy-dom)

A page module is tested in happy-dom with the page's real markup:

- `loadIndexHtml()` puts `web/index.html`'s body (without its scripts) into the document, so every id the code queries exists; `loadLicensesHtml()` does the same for the Licenses page.
- `installBrowserStubs()` adds what happy-dom 20 lacks, as `tests/web/probe.test.ts` checks: the Popover API (`showPopover`, `hidePopover`, `togglePopover`, and `:popover-open` in `matches`), `EventSource` (`FakeEventSource`, which the test drives with `open()`, `emit(type, data)` and `fail()`), `AudioContext` (`FakeAudioContext`), `Audio` (`FakeAudio`, with `loadMetadata()` and `end()`), and spies for `window.open` and `scrollIntoView`. Call it before importing a page module.
- `layout(el, {...})` sets `clientWidth`, `scrollWidth` and the other sizes that are always 0 in happy-dom, and `getBoundingClientRect`.
- `flush()` lets pending promises and zero-delay timers run.
- In happy-dom a dialog's `close` event fires synchronously; in a browser it fires in a later task.

## End-to-end tests of the web page

`npm run test:e2e` builds the page and runs Playwright (Chromium) against the real engine: its router, the page, the key setup and the whole session pipeline, with only the external services faked. `npx playwright test --project=web` runs these alone.

- **The harness** (`e2e/harness/server.ts`) composes the engine the way `bootEngine` does, in its own process: the network is off (`fetch` and `WebSocket` throw, the key variables are deleted), and one fake answers everything the engine calls (`e2e/harness/fakes.ts`: transcription, Jev and System 2 from the fixture's script, the chat's catalogue and streamed replies, the key checks). Apple Speech is reported unavailable, so sessions transcribe with the fake OpenAI and never start the on-device helper. It listens on `127.0.0.1` and prints `E2E_READY <url>`.
- **Isolation:** the fixture (`e2e/fixtures.ts`) starts a fresh harness for every test, in its own tmp folder: `HOME`, `TMPDIR`, `TATTLE_CREDENTIALS`, `TATTLE_SETTINGS` and `TATTLE_LABEL_SETS` all point inside it, and the harness refuses to start otherwise. Nothing touches the real Application Support folder or `sessions/`.
- **Switches** (`test.use({ harnessEnv: {...} })`): `E2E_KEYS=missing` (the first-run screen), `E2E_REFUSE_KEYS=<text>` (key checks refuse keys containing it), `E2E_402=1` (OpenRouter's credit is used up), `E2E_SEED=library` (two recordings with real audio), `E2E_LIVE=hold` (Start live captures nothing until stopped), `E2E_LIVE_TEXT=off`, `E2E_CONTROL=1` (commands on the harness's stdin: `harness.control({ emit, data })` puts an event on the engine's bus, `{ dropEvents: true }` closes every open event stream, `{ push: {...} }` feeds audio to a held capture). The scripted scenarios use the real engine with a held live session and injected events, for states a real session cannot reach on demand (health, speaker mode, OpenRouter's refusal, a System 1 rewrite, errors, a lost event stream).
- **The page:** always `http://127.0.0.1:<port>` (anything else gets 403 from the Host/Origin guard); navigate with `waitUntil: "domcontentloaded"` and wait with web-first assertions, **never `networkidle`** (`/api/events` stays open). `open(page, path)` also waits for the app's first render, because the page's shell shows before its controls are bound. Every request that would leave `127.0.0.1` is aborted and fails the test.
- **Bespoke selects** are comboboxes: `getByRole("combobox", { name: /^Playback speed/ })`, then `getByRole("option", { name: "4×" })`.
- **Known bugs** are `test.fail()` tests named `BUG <id>: …`, like `it.fails` in Vitest.
- **Flakes:** before committing a change to these tests, run them three times: `npx playwright test --project=web --repeat-each=3`. A failure is investigated, never retried away.

## End-to-end tests of the Mac app

`npx playwright test --project=electron` drives the Mac app in development (Playwright's `_electron`, against `dist/desktop/main.mjs`: `npm run test:e2e` builds it first). A packaged build cannot be driven (it refuses remote debugging), so what only a signed build has is checked by the release instead.

- **Isolation** (`e2e/electron/fixture.ts`): each test launches the app with its own `HOME` (so Application Support, the window's storage and the single-instance lock are its own, and an installed Tattle can run at the same time), `TATTLE_CREDENTIALS`, `TATTLE_SETTINGS` and `TATTLE_LABEL_SETS` inside it, and `TATTLE_FORCE_NO_APPLE_SPEECH=1` (the on-device helper never starts, and its model is never installed). It runs from a tmp working folder: in development `web`, `config`, `models` and `sessions` are relative to it, so symlinks give the app the project's page, config and models, and an empty `sessions/` instead of the real recordings.
- **The main process** gets a `fetch` that throws, and `dialog.showMessageBox`, `shell.openExternal` and `shell.openPath` replaced by recorders (Electron's module properties are writable, and `desktop/main.ts` reads them at call time): `mac.recorded()` returns the sheets and the links. `mac.menu(["Tattle", "Settings…"])` clicks a menu item.
- **Never** start a session, send a chat message or save keys here: the web end-to-end tests do, against fakes.
- **sherpa-onnx inside Electron:** one test runs the VAD and the embedder in the main process (with the `false` copies the gotcha requires), which the Node tests cannot check.

## Swift tests (the capture helper)

`native/capture/Package.swift` has a test target, `tattle-capture-tests` (`native/capture/Tests/tattle-capture-tests/`), written with Swift Testing (`import Testing`) against `@testable import tattle_capture` (the module name has an underscore). SwiftPM builds the executable for tests with its entry point renamed, so `main.swift`'s top-level code never runs, and no library split is needed; `swift build -c release` (`npm run build:capture`) does not build the tests.

- **What is tested:** the pure logic. `ClockLock` places each buffer on session time (padding a late stream with silence, trimming one that runs ahead, clamping and scaling to 16-bit, framing 100 ms frames with continuous `sessionMs`, flushing, and the watchdog that pads a stalled stream), `Levels`, the converters (`MonoConverter`, `AdaptiveConverter`), `Devices.transportName`, `Devices.address`, `Devices.fourCC`, and `CaptureError`. Frames go to a collecting `FrameSink`; host times are computed from `ClockLock.startHost`.
- **The converter's latency:** `AVAudioConverter` holds about 240 samples (15 ms), so the first 4,800-sample buffer at 48 kHz converts to about 1,360 samples, not 1,600. Assert cumulative totals with a tolerance of 300 or more, never per call.
- **Not tested:** `SystemTap.swift`, `Mic.swift` and `main.swift` need the real devices and the macOS permissions (`npm run capture:test` checks them by hand).
- **The gate:** `npm run test:swift` runs `scripts/swift-coverage.mjs`, which runs `swift test --enable-code-coverage`, prints line coverage per source file, and fails when `ClockLock.swift` is below 90 %.
- The first build of the test target takes a minute or two; later runs take seconds.

## Coverage policy

- `vitest.config.ts` measures `src/**`, `desktop/**` and `web/src/**` (with v8), excluding `src/types/**` and the two live-only command-line tools, `src/cli/smoke.ts` and `src/cli/preflight.ts`, which exist to call real services.
- **Thresholds are per folder and only go up.** After a round of tests, raise them to the new floor (the measured value rounded down). Never lower one to get a green run.
- **Exclusions** are for code that needs real hardware, macOS permissions, or a signed build, and each carries its reason: `/* v8 ignore next -- @preserve */ // <why>` (the `-- @preserve` form is the one the Vitest docs recommend; under Vitest 5 the plain form works too). `grep -rn "v8 ignore" src desktop web/src` must show a reason on every hit.

## Rules for new tests

- Tmp folders come from `mkdtemp` (or `tmpDir()`), removed afterwards; never write straight into `os.tmpdir()`.
- Tests do not depend on order. A shared fake (such as `FakeEngine`) is fresh per test, or reset.
- **Fake timers:** list what to fake, `vi.useFakeTimers({ toFake: [...] })`. Never fake `setImmediate` around a Session or `recordedVoiceprints`: they wait on it and deadlock. For Jev's pauses and the chat catalogue's cache, fake only `Date`.
- **Locale and time zone:** assert dates and times with a regex, or compute the expected string with the same `toLocale*` call.
- A test that needs the models or fixture calls `requireAssets()`.

Related: [Architecture](architecture.md), [Gotchas](gotchas.md), [Mission](mission.md).
