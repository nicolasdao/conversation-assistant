# SPEC — Test-driven development for Tattle

## §0 How to use this spec (read first)

**What this is:** the complete plan to make Tattle a test-driven project. It covers four things:
- tooling;
- about 900 new unit, DOM, end-to-end and Swift tests, toward about 95 % coverage;
- TDD written down as the project's rule in `CLAUDE.md` and `docs/testing.md`;
- the full test suite as **Step 1** of `/release-tattle`.

**Who you are:** a fresh session with no memory of the conversation that produced this. The whole codebase was scanned for you. Every decision is here, and every module's test inventory is in `inventory/`. Where something was not decided, §6 says what to do.

**How the folder is organised**

| File | What | When to read it |
|---|---|---|
| `SPEC.md` (this) | Decisions, phases, rules, acceptance criteria | Now, end to end |
| `inventory/1-engine-audio-pipeline.md` | `src/audio`, `src/speakers`, `src/transcribe`, `src/pipeline`: per-file symbols, seams, existing coverage, about 255 `it(...)` cases, latent bugs | Phase 3 |
| `inventory/2-intelligence-config.md` | `src/jev`, `src/factcheck`, `src/chat`, budget, config, keys, paths, licenses, version: about 245 cases, fake request/response shapes | Phase 4 |
| `inventory/3-server-store-cli-harness.md` | `src/server`, `src/store`, `src/cli`: route table, 100+ cases. **§10 is the E2E harness design** | Phases 5 and 9 |
| `inventory/4-web-state-chat-keys.md` | `web/src` state, api, router, chat, calls, app, keys, transfer, ui, desktop, main; the page↔engine contract; E2E scenarios E1–E10 | Phases 7 and 9 |
| `inventory/5-web-panels-timeline-player.md` | `web/src` panels, timeline, player, markdown, licenses, dom; happy-dom helpers; 23 E2E scenarios | Phases 7 and 9 |
| `inventory/6-desktop-native-release-tooling.md` | Electron main and preload (§A), Swift helper (§B), release skill (§E), tooling and versions (§F). §C/§D are out of scope | Phases 1, 6, 10, 11, 12 |
| `PROGRESS.md` (you create it) | Your running log: phase status, coverage numbers, bugs found, deviations | Update after every phase |

Read only the inventory for the phase you are in; together they are about 6,000 lines. The inventories are a catalogue, not a script. Their `it("…")` lines are the minimum to write. Their "Suggested seams" and "fix" hints are **overridden by this spec's §4.0 rules** (allowed seams and bug policy).

**DO**
- Read this file end to end before editing anything.
- Run `/init-context test-driven development` first. It loads `docs/mission.md`, `docs/gotchas.md` and the relevant docs.
- Before your **first edit to any file**, run `python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects <path>` and read the docs it names.
- Treat `file:line` as anchors, not gospel. The symbol name wins: grep it.
- Work in phase order (§4). Phase 1 and Phase 2 come before any bulk test writing.
- Run `npm run typecheck && npm test` after every task, and the phase's Done-when checks before each phase commit.
- Keep `PROGRESS.md` current, so a later session can resume if your context runs out.

**DO NOT**
- Do not re-scan or re-audit the codebase to rebuild what the inventories already say. Open a source file only when writing its tests.
- Do not make any real network call to OpenAI, OpenRouter/Jev or GitHub from any test, harness or script. Do not run `npm run smoke`, `npm run preflight`, `npm run replay`, or a live/replay session in `npm run serve`/`npm run app`: they use real keys and spend money. The Phase 9 harness's replays use fakes and are fine.
- Do not change production behaviour except through the allowed seams in §4.0.3 and the listed bug fixes in §4.0.4.
- Do not weaken, delete or skip an existing test to get a green run. A red test is information.
- Do not push, release, tag, or run `/release-tattle` or `npm run dist:mac`. You commit locally only (§4.0.5).
- Do not edit anything under `specs/` except `specs/260929-01-test-driven-development/PROGRESS.md`, which you own.

**Suggested first 30 minutes**
1. Run `git status`: it must be clean, and HEAD must be at or after `74b42a6`. If there is uncommitted work, stop and ask.
2. Run `npm test`. The baseline is **23 files, 191 tests, all pass, about 24 s**. If anything fails, stop and ask.
3. Check the assets: `ls models/silero_vad.onnx models/wespeaker_en_voxceleb_resnet34_LM.onnx fixtures/conversation/{host.wav,remote.wav,script.json}`. If any is missing, run `npm run models && npm run fixtures`. That downloads the models and uses macOS `say`; it is free.
4. Read §4.0 (the rules that apply to every phase), then do Phase 0.

## §1 Goal

1. **Tooling.** Add Vitest coverage (v8) with enforced thresholds, happy-dom for web unit tests, Playwright for end-to-end tests (web page and Electron app), and a Swift Testing target for the capture helper. All of it runs offline and spends nothing.
2. **Tests.** Write unit tests for every TypeScript module in `src/`, `desktop/` and `web/src/`. Write end-to-end tests of the web page against the real engine with fake external services, and of the Electron development app. Write Swift tests for the helper's pure logic.
   - Target: **src ≥ 95 % lines, statements and functions and ≥ 90 % branches; web/src and desktop ≥ 90 % / 85 %.**
   - Anything excluded is hardware- or OS-only and carries a written reason.
3. **TDD as the rule.** Create `CLAUDE.md` (the project has none) and `docs/testing.md`. They must state that every fix, feature or change is test-first, using the layers, fakes and harnesses built here.
4. **Release gate.** The whole suite (`npm run test:all`) becomes **Step 1** of the `release-tattle` skill, and the README's Releasing section says so.

## §2 Context (brief)

- **Starting point.** Tattle already has a disciplined offline suite:
  - Vitest 5.0.1, 23 files, 191 tests.
  - `tests/setup.ts` makes `fetch` throw, and every client takes `fetch` or a WebSocket factory through its constructor.
  - Of 36 feature and fix commits that changed code, 33 changed tests in the same commit.
- **What's missing:**
  - No written TDD rule and no `CLAUDE.md`.
  - No coverage tool. An attempt to measure with raw `NODE_V8_COVERAGE` and c8 reported 0 %, which is unusable, so Phase 1 measures the real baseline.
  - Almost no tests for the web front end: about 4,300 lines, with only `router.ts` tested.
  - No tests for `desktop/main.ts` or the CLIs, no UI end-to-end tests, and no Swift tests.
  - No CI. The release skill is the only gate, and its `checks.sh` already runs `npm test`.
- **Why it matters.** The mission (`docs/mission.md`): "Reliability matters as much as features on air." The tests exist to protect a live show, so tests that bite matter more than a coverage number.
- **Bugs already found.** The scan found about 40 latent bugs; several were confirmed with probes. §4.0.4 says which to fix now and which to record.

User decisions (do not revisit):

| Question | Decision |
|---|---|
| Coverage bar | About 95 %, per-folder thresholds, justified exclusions; thresholds only ratchet up |
| Refactoring for testability | Minimal seams only, listed in §4.0.3; anything larger: stop and ask |
| Scope beyond the TypeScript engine and web page | Electron E2E and the Swift helper are **in**; website tests and release-script tests are **out** |
| Commits | Conventional commits on `master`, one or more per phase, suite green at every commit, never pushed |

## §3 Acceptance criteria

All of these can be checked from the project root:

- [ ] `npm run test:all` exits 0. It runs typecheck, then Vitest with coverage thresholds, then `swift test`, then Playwright (web and Electron). It must work with no network apart from the one-time Playwright browser install.
- [ ] `npx vitest run --coverage` prints per-folder coverage at or above these values (enforced by `coverage.thresholds` in `vitest.config.ts`):

  | Folder | lines | statements | functions | branches |
  |---|---|---|---|---|
  | `src/**` | ≥ 95 | ≥ 95 | ≥ 95 | ≥ 90 |
  | `web/src/**` | ≥ 90 | ≥ 90 | ≥ 90 | ≥ 85 |
  | `desktop/**` | ≥ 90 | ≥ 90 | ≥ 90 | ≥ 85 |

  If a target is truly unreachable within the allowed seams, the thresholds equal the achieved floor, and `PROGRESS.md` lists every file under target with its uncovered lines and why. §4 Phase 13 says when to stop and ask.
- [ ] Every coverage exclusion comment has a reason on the same or the previous line. Check with `grep -rn "v8 ignore" src desktop web/src`: every hit shows a reason.
- [ ] `swift test --package-path native/capture` passes, and `ClockLock.swift` line coverage is ≥ 90 %, checked by the script from §4 Phase 11.
- [ ] `npx playwright test` passes, with ≥ 12 web scenarios (full-stack and scripted) and ≥ 8 Electron scenarios (§4 Phases 9 and 10).
- [ ] `CLAUDE.md` exists at the root and contains the TDD rule (§4 Phase 2 gives the text). `docs/testing.md` exists with frontmatter and is listed in the README doc index and in `doc-manifest.json`.
- [ ] `.agents/skills/release-tattle/SKILL.md` has a new **Step 1 — Test suite** that runs `scripts/test-suite.sh`. Every old step is renumbered and every cross-reference fixed. `skill.json` is version `0.6.0`. The README "Releasing" list and "Without Claude Code" block show the new first step.
- [ ] `node scripts/third-party-notices.mjs --check` still exits 0: dev dependencies never ship.
- [ ] `git log` shows conventional commits for each phase. The working tree is clean, and nothing was pushed.
- [ ] `PROGRESS.md` has final coverage numbers, the bug ledger (fixed vs `it.fails`), and every deviation from this spec.

## §4 The work

### §4.0 Rules for every phase

#### §4.0.1 The TDD loop you follow (and later write into CLAUDE.md)

- **Characterisation tests for existing code** (most of this spec):
  1. Write the test from the *intended* behaviour: the inventory, the docs, the code's comments.
  2. Run it. If it passes, prove it bites **once per new test file**: break the line under test (invert a condition, change a constant), watch at least one test go red, then revert the sabotage. **Never commit a sabotage.**
- **When a characterisation test fails,** you found a discrepancy. Follow §4.0.4.
- **For fixes and new code** (the bug fixes here, and every future change): red first, then the minimum code to go green, then refactor with the suite green.

#### §4.0.2 Where tests go

Only these new locations may be created:

| Layer | Location | Runner | Environment |
|---|---|---|---|
| Node unit and integration (engine, desktop main with a mocked `electron`) | `tests/<area>.test.ts`: extend the existing file for the same module, or create a new one (e.g. `tests/desktop-main.test.ts`, `tests/preload.test.ts`, `tests/cli-replay.test.ts`) | `vitest` | node |
| Shared fakes and builders | `tests/fakes/*.ts` (plus `tests/fakes/index.ts`) | — | — |
| Web DOM unit | `tests/web/<module>.test.ts`, first line `// @vitest-environment happy-dom` | `vitest` | happy-dom |
| Web test helpers | `tests/web/helpers.ts` | — | — |
| E2E web | `e2e/web/*.spec.ts`; harness `e2e/harness/server.ts` plus `e2e/harness/*.ts` | Playwright (Chromium) | real browser |
| E2E Electron | `e2e/electron/*.spec.ts`; fixture `e2e/electron/fixture.ts` | Playwright `_electron` | dev app |
| Swift | `native/capture/Tests/tattle-capture-tests/*.swift` | `swift test` | — |
| Swift coverage gate | `scripts/swift-coverage.mjs` | node | — |
| Release gate | `.agents/skills/release-tattle/scripts/test-suite.sh` | sh | — |

- **Pure web modules** (e.g. `web/src/state.ts`) may be tested in node without the docblock, as `tests/router.test.ts` already does.
- **Playwright files** use the `.spec.ts` suffix under `e2e/`. Vitest's include (`tests/**/*.test.ts`) never picks them up.

#### §4.0.3 Allowed production seams (the whole whitelist)

Each seam must be behaviour-identical. Use a `refactor(scope):` commit when it is standalone, or include it in the phase commit with a mention. Anything not on this list: **stop and ask**.

| # | Seam | Where | Why |
|---|---|---|---|
| S1 | Export a module-private function or constant so it can be tested directly, with no other change | any `src/`, `desktop/`, `web/src/` file | Cheapest coverage for pure logic (inventory 5 §0 "Suggested seams" lists candidates) |
| S2 | Wrap a CLI's top-level code in `export async function run(argv, deps?)` (deps: `fetch`, `sessionsDir`, `stdout`, `exit`), called by the existing entry guard | `src/cli/replay.ts`, `src/cli/calibrateBoundary.ts`, `src/cli/calibrateSpeakers.ts` | Child-process runs do not count in v8 coverage (inventory 3 §9, §10.4) |
| S3 | Make the CLI entry guard robust: `import.meta.url === pathToFileURL(process.argv[1]).href` | `` import.meta.url === `file://${process.argv[1]}` `` in `src/server/main.ts:852`, `src/cli/calibrateBoundary.ts:37`, `src/cli/calibrateSpeakers.ts:32` | Bug B3: paths with spaces or symlinks silently do nothing. Write a failing test first |
| S4 | Optional `vad?: () => StreamVad` factory in `SessionOptions`, defaulting to today's construction | `Session` constructor, `src/pipeline/session.ts` (built at about :165) | **Only if** fixture-slice tests prove too brittle (inventory 1 §P4) |
| S5 | Env override `TATTLE_SESSIONS_DIR` for the development branch of `desktop/main.ts` (the `else` branch after `if (app.isPackaged)`) | `desktop/main.ts` | **Only if** the symlinked-cwd approach of Phase 10 fails |
| S6 | Change `private static func fourCC` to `static func` (internal) | `native/capture/Sources/tattle-capture/Devices.swift` | Swift unit test |

**Forbidden, even when an inventory suggests it:**
- Splitting the Swift package into a library.
- Extracting `Options.parse`, `StdoutSink.encode` or `RestartPolicy` in Swift. The helper is the live capture path and cannot be retested without hardware.
- Rewriting `desktop/main.ts`, or changing `bootEngine`'s signature.
- Refactoring the web modules' structure.

#### §4.0.4 Bug policy (the scan found about 40)

When a test exposes behaviour that contradicts the docs or intent:

1. **Fix now**, only for the bugs in this table. Write the failing test, make the minimal fix, and commit it alone as `fix(scope): …`.

   | Id | Bug | Anchor | Expected behaviour |
   |---|---|---|---|
   | B1 | `Engine.start` answers 400 for a name over 120 chars **after** the session already started; a retry then gets 409 | `Engine.start` in `src/server/main.ts` (about :394; the name is saved by `this.library.update(s.id, { name })` at about :439, after `s.run()`); `library.update` in `src/store/library.ts` (about :218) | Validate the name before the Session is built: 400 and no session started |
   | B2 | A speaker filter makes `segmentMatches` false, so with a marker or subject filter the transcript is empty, and alone it dims every timeline segment | `segmentMatches` in `web/src/panels.ts` (about :432); inventory 5 §6 | What the code's own comment says (`// speaker filtering is per utterance; segments dim only on label filters`): `segmentMatches` ignores `filters.speaker`, so a speaker filter plus a label filter shows that speaker's lines in matching segments, and a speaker filter alone dims no segment. The line has been there since the first web commit (`9011f98`), so if anything in the docs or tests says the dimming is deliberate, fix only the empty-transcript case and ask |
   | B3 | The CLI entry guard fails for paths with spaces or symlinks | seam S3 | The guard uses `pathToFileURL` |
   | B4 | `linkify` puts the closing `>` inside the link for `<https://…>`, which breaks 7 real notices | `linkify` in `web/src/licenses.ts` (about :15); inventory 5 §5 | `<https://x>` gives a link to `https://x`, with the brackets as text |
   | B5 | An error response with an empty body gives an empty `ApiError` message, so toasts are blank | `web/src/api.ts` (about :18); inventory 4 §3 | Falls back to `` `${status} ${statusText}` `` |

2. **Everything else: record, don't fix.**
   - Write the test for the intended behaviour as `it.fails("BUG <id>: <what>", …)`. It stays green, and flips red when someone fixes the bug, prompting them to change it to `it`.
   - Add a row to the bug ledger in `PROGRESS.md`: id from the inventory (e.g. A2-L1, T1-L1, P2-L1, §11.5), file:line, one line of impact.
   - This applies especially to the capture path (`src/audio/nativeSource.ts`, `src/transcribe/live.ts`, `Session` in `src/pipeline/session.ts`, anything Swift) and to privacy. **The `.tattle` export carries the exporter's home path**: inventory 3 §11.5. It is a candidate for a follow-up the user decides.
3. If a recorded bug makes a test impossible to write even as `it.fails` (e.g. an unhandled rejection that crashes the worker), note it in the ledger, cover the rest, and move on.

#### §4.0.5 Commits

- Use the conventional format with the project's scopes (see `git log`), one or more commits per phase, with the full `npm run typecheck && npm test` green at each commit. Examples:
  - `build(test): add coverage, happy-dom, and Playwright`
  - `test(pipeline): cover segmenter boundaries and timeline concurrency`
  - `fix(server): refuse a too-long session name before starting the session`
  - `docs: make test-driven development the project rule in CLAUDE.md and docs/testing.md`
  - `feat(release): run the whole test suite as step 1 of a release`
- Use the `/git-commit` skill or follow its conventions, including the attribution line the session's system prompt gives. Commit on `master`. **Never push.**
- Do not edit `CHANGELOG.md`. The release skill writes it from these commits.

#### §4.0.6 Test hygiene rules (for every new or touched test)

- **Never touch real user data.**
  - Always pass explicit tmp paths to `KeyStore`, `loadKeys`, `credentialsPath`, `migrateAppSupportDir`/`appSupportDir` (`base`) and `sumDevSpend`.
  - Call `setAppPaths({ sessions: tmp })` with `afterEach(() => setAppPaths())`.
  - With no path, these read or rename `~/Library/Application Support/Tattle` (real keys and recordings) or the repo's `sessions/` (inventory 2, "Global test environment facts").
- **Environment variables.** Restore `process.env.OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `TATTLE_CREDENTIALS` after any test that sets them.
- **Fake timers.**
  - **Never fake `setImmediate`** in Session and `recordedVoiceprints` tests: they deadlock (inventory 1, Area-wide notes).
  - Prefer `vi.useFakeTimers({ toFake: [...] })` with an explicit list.
  - For Jev pauses and the chat catalogue TTL, fake only `Date`.
- **Assets.** Tests that need `models/` or fixtures call `requireAssets()` from `tests/helpers.ts`.
- **Tmp dirs.** Use `mkdtemp` and remove them in `afterEach`/`afterAll`. Never write straight into `os.tmpdir()` (fix `tests/server.test.ts` about :66 while you are there).
- **Isolation.** Tests must not depend on order. `tests/server.test.ts` asserts on a shared `FakeEngine`'s cumulative calls: make each test use a fresh engine or reset it.
- **Speed.** Replace the 10 s real-time "speed 1 pacing" test in `tests/audio.test.ts` with fake timers, with the same assertion.
- **Locale.** Assert locale- or TZ-dependent strings with a regex, or compute the expected value with the same `toLocale*` call.

### Phase 0 — Preconditions and PROGRESS.md

1. Complete the §0 first-30-minutes checks.
2. Create `specs/260929-01-test-driven-development/PROGRESS.md` with these sections:
   - `Status` (a phase checklist mirroring §4)
   - `Coverage` (a table per phase: folder → lines/branches/functions/statements)
   - `Bug ledger`
   - `Deviations and decisions`
   - `Resume notes` (what to do next if the session ends)

**Done when:** the file exists and `npm test` is green. Commit it at the end of Phase 1 together with the tooling; there is no separate commit.

### Phase 1 — Tooling, shared fakes, probes, baseline

1. **Dependencies.** Read inventory 6 §F first.
   - Install: `npm i -D --save-exact @vitest/coverage-v8@5.0.1` (its peer is exactly the installed vitest; confirm with `npm ls vitest`). Then `npm i -D happy-dom@^20.14.5 @playwright/test@^1.63.0`.
   - **Not jsdom:** 30.x needs Node ≥ 24.15, and this Mac runs 24.0.1.
   - Then `npx playwright install chromium`, a one-time download outside `node_modules`.
   - If npm reports ERESOLVE or a peer conflict: stop and ask. Never use `--force` or `--legacy-peer-deps`.
2. **`vitest.config.ts`.** Keep the existing keys (include, timeouts, `setupFiles`) and add `coverage`:
   ```ts
   coverage: {
     provider: "v8",
     include: ["src/**/*.ts", "desktop/**/*.ts", "web/src/**/*.ts"],
     exclude: ["src/types/**", "src/cli/smoke.ts", "src/cli/preflight.ts"], // live-only CLIs: they exist to call real services
     reporter: ["text", "html", "json-summary"],
     thresholds: { /* per-folder globs, §3 table; start at the measured baseline floor, ratchet up each phase */ },
   },
   ```
   Pick the DOM environment per file with the `// @vitest-environment happy-dom` docblock. Vitest 5 supports it; `environmentMatchGlobs` is gone. Do not use `projects` unless the docblock proves insufficient.
3. **`package.json` scripts.** Keep `test` as it is and add:
   - `"test:coverage": "vitest run --coverage"`
   - `"test:swift": "swift test --package-path native/capture && node scripts/swift-coverage.mjs"`. Add the Swift part in Phase 11; until then `test:swift` can be absent.
   - `"test:e2e": "npm run build:web && npm run build:desktop && playwright test"`
   - `"test:all": "npm run typecheck && npm run test:coverage && npm run test:swift && npm run test:e2e"`
4. **Other config.**
   - `tsconfig.json` `include`: add `"e2e"` and `"playwright.config.ts"`.
   - `.gitignore`: add `test-results/`, `playwright-report/`, `blob-report/`, `playwright/.cache/` (`coverage/` is already there).
   - Create a `playwright.config.ts` skeleton: `testDir: "e2e"`, `workers: 1`, `fullyParallel: false`, projects `web` (Chromium) and `electron`, and `use: { trace: "retain-on-failure" }`.
5. **Shared fakes.**
   - Move the existing fakes into `tests/fakes/` **without changing behaviour**, and make the old tests import them:
     - `fakeFetch` (`tests/session.test.ts` about :23)
     - `fakeOpenRouter` (`tests/chat.test.ts` about :46)
     - keys `fakeFetch` (`tests/keys.test.ts` about :16)
     - `FakeSocket` (`tests/live.test.ts` about :10)
     - `FakeEngine` (`tests/server.test.ts` about :14)
     - `frameBytes`/`FakeHelper` (`tests/nativeSource.test.ts`)
     - `services`/`flaky` (`tests/echoGate.test.ts`, `tests/retry.test.ts`)
     - `makeSession` (`tests/library.test.ts` about :11)
     - `recording`/`tone` (`tests/transfer.test.ts`)
   - Then add the new builders from inventory 1 (Area-wide notes), inventory 2 (Reusable fakes) and inventory 5 §0 (Shared test helpers): `json`/`sse` response helpers, `FakeJev`, `FakeOpenRouter` (streaming, `/models`, `/generation`), `pcm` generators, `FakeEmbedder`, `deferred`, `tmpDir`, `withEnv`, `withAppPaths`, `strictBus`.
   - The suite must stay at 191 passing after the move.
6. **Probe tests.** Resolve §6 uncertainties U1 and U2 before writing tests that depend on them. Create `tests/web/probe.test.ts` (happy-dom) asserting each capability the web code needs:
   - `dialog.showModal`/`close(rv)`/`returnValue`/`close` event timing
   - `showPopover`/`hidePopover`
   - `el.matches(":popover-open")`
   - `el.matches(":focus-visible")`
   - `EventSource`, `navigator.clipboard.writeText`, `requestAnimationFrame`, `history.pushState` → `location`
   - `<form method="dialog">`, `select.labels`, the `HTMLSelectElement.prototype` `value`/`selectedIndex` accessors
   - `PointerEvent`, `setPointerCapture`, `scrollIntoView`

   For each missing capability, add a shim to `installBrowserStubs()` in `tests/web/helpers.ts`, then turn the probe into a regression test of the helpers. Also probe the coverage-ignore syntax (U2): add a temporary `/* v8 ignore next -- @preserve */` to a scratch test-only module, confirm the line leaves the report, and delete the scratch module.
7. **Baseline.** Run `npx vitest run --coverage` and write the per-folder and per-file numbers into `PROGRESS.md`. Set `thresholds` to those numbers rounded **down** to the integer, so the gate is live from day one.

**Done when:**
- `npm run test:coverage` passes with thresholds at the baseline.
- `npx playwright test --list` runs (0 tests is fine).
- The probe test is green.
- The suite has ≥ 191 tests, all green.
- The commit is `build(test): …`.

### Phase 2 — Write the rule down first

TDD applies to the rest of this work, so the rules land before the bulk of the tests.

1. **Create `CLAUDE.md`** at the root. The content is below; adjust the wording only.
   ```markdown
   # Tattle — rules for working on this project

   Start with `/init-context <task>`. Before editing a file, run
   `python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects <path>` and read what it names.

   ## Test-driven development (mandatory for every change)
   Every fix, feature, refactor, or config change is test-first:
   1. **Red**: write or extend the test that states the behaviour — for a bug, a test that reproduces it — and run it: it must fail, for the reason you expect.
   2. **Green**: make the smallest change that passes it.
   3. **Refactor** with the suite green.
   4. Before committing: `npm run typecheck && npm run test:coverage`; if you touched the web page, the Mac app, or the capture helper, also `npm run test:e2e` / `npm run test:swift`. `npm run test:all` runs everything (and is step 1 of every release).

   Rules:
   - Put each test in its layer (unit, DOM, end-to-end web, end-to-end Mac app, Swift) as described in docs/testing.md; reuse the fakes in `tests/fakes/`.
   - Tests never touch the network or real services, and never read or write the real `~/Library/Application Support/Tattle` or `sessions/`: pass tmp paths.
   - Never delete, skip, or loosen a test to get green. A known bug not fixed yet is an `it.fails("BUG …")`, not a deleted test.
   - Coverage thresholds in `vitest.config.ts` only go up. An exclusion (`/* v8 ignore … -- @preserve */`) needs a written reason and is only for code that needs real hardware, macOS permissions, or a signed build.
   - Never run `npm run smoke`, `preflight`, or a real session as a test: they spend money.

   ## Also
   - Conventional commits (`/git-commit`); after a feature or fix, `/update-doc`.
   - Releases only through `/release-tattle`.
   ```
2. **Create `docs/testing.md`.** Give it frontmatter in the style of the other docs:
   - `description`: one sentence.
   - `tags`: `[testing, tdd, vitest, coverage, playwright, e2e, swift]`.
   - `source`: `tests/**`, `e2e/**`, `vitest.config.ts`, `playwright.config.ts`, `native/capture/Tests/**`, `scripts/swift-coverage.mjs`, `.agents/skills/release-tattle/scripts/test-suite.sh`.

   Sections:
   - The TDD loop.
   - Layers: the §4.0.2 table.
   - Commands.
   - Fakes catalogue: what each fake in `tests/fakes` imitates.
   - Web DOM tests: happy-dom, stubs, `loadIndexHtml`.
   - E2E web harness (how it starts, and why `127.0.0.1` and never `networkidle`).
   - E2E Electron (isolated HOME, symlinked cwd, dialog stubs).
   - Swift tests.
   - Coverage policy (thresholds, ratchet, exclusions).
   - Rules for new tests (§4.0.6).
3. **Other docs.**
   - Replace the body of `docs/architecture.md` § Tests with a two-line summary linking `docs/testing.md`.
   - Add `docs/testing.md` to the README doc index (between the `<!-- BEGIN doc-index -->` markers, alphabetical).
   - Add the new npm scripts to the README `## Scripts` table.
   - Regenerate `doc-manifest.json` by running `/update-doc`, or its manifest generator: `python3 .claude/skills/init-doc/scripts/build-doc-manifest.py --root .`. Never hand-edit the manifest.

   `docs/testing.md` will grow as later phases land. Update it in the phase that adds each harness.

**Done when:**
- `CLAUDE.md` and `docs/testing.md` exist.
- `python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects tests/foo.test.ts` names `docs/testing.md`.
- The commit is `docs: …`.

### Phases 3–8 — Unit tests by area

For each phase:
- Open the named inventory and write every `it(...)` it lists for the files in scope, in its order (cheapest and pure first).
- Add cases for anything the inventory missed that coverage reveals.
- Apply §4.0.4 to every discrepancy.
- At the end, run coverage, write the numbers into `PROGRESS.md`, and ratchet `thresholds` up to the new floor.

| Phase | Scope | Inventory | Notes |
|---|---|---|---|
| **3** | `src/audio/**`, `src/speakers/**`, `src/transcribe/**`, `src/pipeline/**` | 1 | Use `LiveStream` as a controllable source and `fixtureSlice` for fast real-VAD tests. For `startNativeCapture`'s real-spawn paths, use small `#!/bin/sh` helper scripts in a tmp dir. The latent bugs A2-L1…L6, T1-L1, T2-L1, S2-L1, P2-L1 and P4-L1…L3 → `it.fails` + ledger |
| **4** | `src/jev/**`, `src/factcheck/**`, `src/chat/**`, `src/budget.ts`, `src/config.ts`, `src/keys.ts`, `src/paths.ts`, `src/licenses.ts`, `src/version.ts` | 2 | Priority gaps: chat stream failure, stop and cost; S2 retries, 401/402 and budget refusal; FactChecker error paths and `gate_failed`; Jev backoff and priority. Assert timeouts by spying on `AbortSignal.timeout`. File-mode tests: set modes explicitly (0600/0700) |
| **5** | `src/server/**`, `src/store/**`, `src/cli/{replay,calibrateBoundary,calibrateSpeakers}.ts` | 3 | Cover every route in the §1.3 route table (status codes and error branches) and every §1.7 case. Seams S2 and S3 for the CLIs; B1 and B3 here. `inProcess.ts` branches: inventory 6 §A.4 |
| **6** | `desktop/main.ts`, `desktop/preload.ts`, static contract tests for `electron-builder.yml` and `desktop/*.plist` | 6 §A.1–A.5 | The harness recipe in §A.5 was validated against the real file: mocks for `electron`, `electron-updater`, `src/server/main.ts`, `src/server/inProcess.ts`, `src/paths.ts`; then `vi.resetModules()` and a fresh `import()` per test; fake timers for 30 s, 4 h and `QUIT_WAIT_MS`. Parse YAML and plist with regexes; **no new YAML dependency** |
| **7** | `web/src/{state,router,api,desktop,calls,transfer,keys,ui,chat,app,main}.ts` | 4 | Order: `state.ts` reducer (node, all 31 event branches), then `api.ts` with fetch/XHR stubs, then the DOM modules. Mock `../web/src/api.ts` with `vi.mock(path, async (orig) => ({ ...(await orig()), api: fakeApi }))`. Set `globalThis.desktop` before importing `desktop.ts`. B5 here |
| **8** | `web/src/{panels,timeline,player,markdown,licenses,dom}.ts` | 5 | Use `loadIndexHtml()`, `installBrowserStubs()`, the `makeState()` builder, `FakeAudio`/`FakeAudioContext` and layout stubs (`clientWidth` etc. are 0 in happy-dom). Mock `../web/src/transfer.ts` for the recordings rows (circular import). B2 and B4 here |

**Done when (each phase):**
- Every inventory case for the phase exists, or `PROGRESS.md` says why not.
- The phase's folders are at the §3 targets, or `PROGRESS.md` lists the gap per file.
- Thresholds are ratcheted.
- The suite is green.
- There is one `test(scope): …` commit, and one `fix(scope): …` commit per fixed bug.

**Stop and ask if:**
- a module can only be covered by a seam not in §4.0.3;
- a test needs real hardware, a network call, or a signed build that the inventory did not flag;
- happy-dom cannot host a module even with shims (report which API).

### Phase 9 — End-to-end tests of the web page (Playwright + Chromium)

**Two harnesses. Both are test-only code in `e2e/harness/`, and neither needs a production change.**

1. **Full stack** (`e2e/harness/server.ts`). This is the real `Engine`, router, page, `KeySetup` and session pipeline, with only the external services faked. Follow inventory 3 §10.2 (Option A):
   - Build the engine from `new Engine({ config, sessionsDir: tmp, session: { fetch: servicesFetch, liveConnect: FakeRealtimeSocket, statsIntervalMs }, fetch: chatFetch, live: fileSourceCapture, devices })`.
   - Serve it with `createApiServer(engine, { webRoot: resolve("web"), setup: new KeySetup(new KeyStore({ path: tmpCreds }).load(), { fetch: keyCheckFetch, models }) })`.
   - Call `setAppPaths({ sessions: tmp, src: null, helper: tmp/no-helper })`.
   - Stub `globalThis.fetch` and `WebSocket` to throw, and delete the real key variables from `process.env`.
   - Listen on `127.0.0.1` and print `E2E_READY <url>`.
   - Env switches: `E2E_KEYS=missing`, `E2E_REPLAY=<dir>`, `E2E_SPEED=max|1`, `E2E_OVER_CAP=1`, `E2E_LIVE_TEXT=off`.
   - Reuse `tests/fakes`, and drop `fakeFetch`'s "echo the key once" 400 branch in the E2E variant.
2. **Scripted** (`e2e/harness/scripted.ts`). This is `createApiServer(FakeEngine, …)` whose bus the spec drives: `bus.emit(type, data, { transient })`, reached through a small test-only control route or IPC on the harness process (inventory 4 §A). Use it for states a real session cannot reach on demand:
   - error toasts
   - budget exhausted
   - the echo gate
   - health meters
   - a System 1 rewrite
   - an SSE reconnect
3. **Playwright fixtures.** Use one worker-scoped fixture per harness that spawns `node --import tsx e2e/harness/<x>.ts` with `E2E_PORT=0` and parses `E2E_READY`, and a fresh harness per spec file, because engine state is global.
   - `baseURL` is `http://127.0.0.1:<port>`. Anything else gets 403 from the Host/Origin guard.
   - Navigate with `waitUntil: "domcontentloaded"` and web-first assertions. **Never use `networkidle`**, because `/api/events` stays open (gotcha).
   - Guard the page with `page.route("**/*", r => r.request().url().startsWith(baseURL) ? r.continue() : r.abort())`.
   - Bespoke selects are comboboxes: use `getByRole("combobox", { name: /^Playback speed/ })`, then `getByRole("option", …)` (inventory 5 §0).
4. **Scenarios.**

   Full stack, at minimum:

   | # | Scenario | Assert |
   |---|---|---|
   | FS1 | First run | With `E2E_KEYS=missing`, the setup screen shows; invalid keys → the messages from inventory 4 E1; valid keys → the page reloads into the app |
   | FS2 | Replay of `fixtures/conversation` at max speed | Transcript lines, speakers, timeline segments, fact-check cards and verdict tally match what the pipeline produced with the same fakes. Derive expected counts from `loadScript()` and the fake's scripted verdicts; do not hard-code the inventory's hedged "3 flagged, 1 repeat" |
   | FS3 | Chat window | ⌘K opens it; ask; the answer streams; Stop; model picker; cost shown |
   | FS4 | Recordings | List, rename, search, open, delete |
   | FS5 | Playback | Open a recording, play at 4×, the `?t=` deep link survives a reload |
   | FS6 | Export, then import | Export `.tattle` with `audio: "original"` (a download event), then import it through the file chooser: "already in library" → import as copy, and the copy opens with its own id (the gotcha about the session id rewrite) |
   | FS7 | Dev cap | A seeded `jev_calls.jsonl` with cost 3.5 makes the replay show budget exhausted; `E2E_OVER_CAP=1` does not |
   | FS8 | Start live | Through the fake `live` capture at speed 1: Pause, Resume, Stop within 15 s |

   Scripted: at least E2, E4, E5, E7 and E9 from inventory 4 §13, plus the error toast and SSE-reconnect scenarios. Take the others from inventory 5 §8 as time allows.

**Done when:**
- `npx playwright test --project=web` passes 3 times in a row (no flakes).
- There are ≥ 12 scenarios.
- No request leaves `127.0.0.1`: the route guard fails the test otherwise.
- `docs/testing.md` § E2E web is written.
- The commit is `test(e2e): …`.

**Stop and ask if:**
- a scenario cannot be reached with either harness without a production change;
- FS2's results are not deterministic across 3 runs (report the variance, and do not add retries to hide it).

### Phase 10 — End-to-end tests of the Mac app (Playwright `_electron`, development build)

Read inventory 6 §A.6 and §A.8. Playwright 1.63 was verified to launch Electron 44.4.5 in development. The remote-debugging refusal applies only when `app.isPackaged`.

1. **Fixture** (`e2e/electron/fixture.ts`).
   - Build first: `npm run build:web && npm run build:desktop`. `test:e2e` already does it.
   - Make a tmp HOME and a tmp cwd. In the cwd, create symlinks `web`, `config`, `models` → the project's folders, and an empty `sessions/`. In development these four paths are cwd-relative, so the app never sees the real `sessions/`.
   - Launch with `_electron.launch({ args: [ROOT], cwd: tmpCwd, env: { ...env without OPENAI_API_KEY/OPENROUTER_API_KEY, HOME: tmpHome, TATTLE_CREDENTIALS: tmpHome + "/credentials.json" } })`.
   - Right after launch, in the main process, run `app.evaluate(() => { globalThis.fetch = () => { throw new Error("network disabled in E2E") } })`. Also stub `dialog.showMessageBox` (record the options and answer `{ response: 0 }` or a scripted value), `shell.openExternal` and `shell.openPath` (record the calls). `main.ts` reads them at call time.
   - If the symlinked cwd does not work, use seam S5 and record it in `PROGRESS.md`.
2. **Scenarios** (≥ 8, from inventory 6 §A.6):
   - One window, titled Tattle, at `app://conversation-assistant/`.
   - The setup screen with no keys.
   - `window.desktop` exposes `onCommand` and `run`, and there is no `require`/`process`.
   - `/api/state` works over `app://`.
   - The CSP header is present.
   - The menu bar reads Tattle/File/Edit/View/Window/Help.
   - Settings… opens the keys panel, including after the window was closed (the preload's `pending` queue).
   - Licenses opens once and is reused.
   - Check for Updates in development shows "Updates come only to the installed app".
   - `window.open` of https is denied and opened externally.
   - Navigation away is refused.
   - `getUserMedia` is refused while clipboard write works.
   - Closing the window keeps the app alive; `activate` reopens it.
   - A second launch with the same HOME focuses the first.
   - Also check that sherpa-onnx works inside Electron (the "External buffers" gotcha): the existing `tests/desktop.test.ts` only proves Node. Add a scenario that runs one VAD and embedding call in the main process through `app.evaluate` on a short fixture slice, if the bundle exposes a way. If it doesn't, record it in `PROGRESS.md` and do not add a production hook.
3. Never start a session, send a chat message, or save keys in the Electron E2E tests. With fetch stubbed they would fail anyway, and they exist in the web E2E tests.

**Done when:**
- `npx playwright test --project=electron` passes 3 times in a row with an installed `/Applications/Tattle.app` **running at the same time** (proving isolation), with ≥ 8 scenarios.
- `docs/testing.md` § E2E Electron is written.
- The commit is `test(desktop): …`.

**Stop and ask if:**
- Electron will not launch under Playwright;
- isolation from the installed app cannot be proven.

### Phase 11 — Swift tests for the capture helper

Read inventory 6 §B. It was validated that no library split is needed.

1. In `native/capture/Package.swift`, add `.testTarget(name: "tattle-capture-tests", dependencies: ["tattle-capture"], path: "Tests/tattle-capture-tests", swiftSettings: [.swiftLanguageMode(.v5)])`.
2. Tests use `import Testing` and `@testable import tattle_capture` (an underscore in the module name). Cover:
   - `ClockLock`: pad, trim, clamp, framing, continuous `sessionMs`, two independent streams, `flush`, the watchdog (allow timing slack).
   - `Levels`.
   - `MonoConverter`/`AdaptiveConverter`. **The first 48 kHz convert returns about 1360 samples, not 1600**, because AVAudioConverter has about 240 samples of latency. Assert cumulative totals with a tolerance of ≥ 300.
   - `transportName` (every case), `address`, `fourCC` (seam S6), `CaptureError.description`.
3. `scripts/swift-coverage.mjs`:
   - Run `swift test --package-path native/capture --enable-code-coverage`.
   - Read the JSON from `swift test --package-path native/capture --show-codecov-path`.
   - Fail (exit 1) if `ClockLock.swift` line coverage is < 90 %.
   - Print the per-file table.
   - `SystemTap.swift`, `Mic.swift` and `main.swift` are hardware-only and not gated.
4. Confirm that `npm run build:capture` (release build) is unchanged: test targets are not built by `swift build -c release`.

**Done when:**
- `npm run test:swift` passes.
- ClockLock ≥ 90 %.
- `npm run build:capture` succeeds.
- The commit is `test(capture): …`.

### Phase 12 — The suite becomes Step 1 of every release

Read inventory 6 §E.1–E.2. The skill is local to this project (not in `skills-lock.json`). `.claude/skills/release-tattle` is a symlink to `.agents/skills/release-tattle`; edit the `.agents/` path.

1. **New script `.agents/skills/release-tattle/scripts/test-suite.sh`**, `set -e`, run from the project root. It checks, in order, and each check fails with its fix command:
   1. Models and fixtures exist; otherwise print `npm run models && npm run fixtures` and exit 1.
   2. Playwright's Chromium is installed; otherwise print `npx playwright install chromium` and exit 1.
   3. `swift` is available.

   Then it runs `npm run test:all`, and finally prints `ok: test suite passed (unit + coverage, Swift, end-to-end)`.
2. **`SKILL.md`.**
   - Insert **Step 1 — Test suite (Modes A and B; hard gate; no API spend)**:
     - A `unreleased` action skips to Mode C, which never runs it.
     - Otherwise run `sh "${CLAUDE_SKILL_DIR}/scripts/test-suite.sh"`.
     - On failure, show the failing tests or the coverage table and **stop before any doc update or commit**.
   - Renumber Steps 1–11 to 2–12, and fix every cross-reference listed in inventory 6 §E.2 item 1: "(Step 4)", "Steps 4–7", "Steps 8–10", "until Step 9", "(Step 11)" ×3, "Step 9's confirmation", "If Step 10 failed", "from Step 3", "run Step 2 first" → "run Steps 1 and 2 first", "(Step 6)… (Step 9)". "Starts again from Step 1" stays.
   - Update the Project facts "Gates" row to include the full suite in Step 1.
   - **Reword the constraint** "Never run the app, `npm run smoke`, `preflight`, or anything that calls paid APIs as a release gate" to: "Never run the app against real services (`npm run smoke`, `preflight`, a real session) or anything that calls paid APIs as a release gate; the Step 1 suite runs the development app offline, with no keys and an isolated HOME."
   - Keep `checks.sh` as is. Its `npm test` stays as a cheap re-check for the manual path.
3. **`skill.json`:** `"version": "0.6.0"`, and mention the test suite in `description`.
4. **README `## Releasing`.**
   - Insert item 1, "Runs the whole test suite: unit tests with coverage thresholds, the capture helper's Swift tests, and the end-to-end tests of the web page and the Mac app (development build, offline); stops if any fails.", and renumber the rest.
   - In "Without Claude Code", add `sh $S/test-suite.sh   # unit + coverage, Swift, end-to-end` as the first command.
5. **Other references.**
   - In `docs/website.md`, change "(`release-tattle`, Step 11)" to Step 12. Grep the repo for other `Step 11`/`Step 9` references to this skill: `grep -rn "Step 1[01]\|Step [0-9]" README.md docs .agents/skills/release-tattle`.
   - `docs/testing.md` gets § Release gate.

**Done when:**
- `sh .agents/skills/release-tattle/scripts/test-suite.sh` exits 0.
- `grep -n "^### Step\|^## Step" .agents/skills/release-tattle/SKILL.md` shows Steps 1–12 in order.
- `skill.json` is 0.6.0.
- The README shows the new first step.
- The commit is `feat(release): run the whole test suite as step 1 of a release`.
- **Do not run the release itself.**

### Phase 13 — Close out

1. Run `npm run test:all`. Record the final coverage table in `PROGRESS.md`.
2. **If a §3 target is unmet:** in `PROGRESS.md`, list each file below target with its uncovered lines and the reason (hardware-only, seam not allowed, `it.fails` bug). **Stop and ask the user** whether to accept the floor. Do not lower the targets yourself.
3. Run `/update-doc`:
   - `docs/testing.md` final.
   - Add a `## Testing` section to `docs/gotchas.md` with the traps confirmed during the work. At least:
     - never fake `setImmediate` in session tests;
     - key and path functions touch real user data without explicit paths;
     - happy-dom shims that were needed;
     - the AVAudioConverter latency;
     - Electron E2E needs an isolated HOME;
     - `networkidle` never fires.
   - Update `docs/architecture.md` § Tests and the README doc index/scripts. Regenerate `doc-manifest.json`.
4. The final `PROGRESS.md` has:
   - the bug ledger, as a table: id, file:line, impact, fixed (commit) or `it.fails`;
   - the list of every exclusion;
   - the deviations;
   - a short "suggested follow-ups" list: unfixed bugs by severity, website tests, release-script tests.
5. Commit with `docs: …` (and `chore(test): …` if thresholds changed). `git status` must be clean.

**Done when:** every §3 box is checked, or a user decision about an unmet target is recorded in `PROGRESS.md`.

## §5 Non-goals

- **No website tests.** Nothing for `website/`: download.js, nav.js, sections.js, main.js, the CSP hash check, or Playwright on hey-tattle.com. They are out of scope by the user's choice. Inventory 6 §D keeps the plan for later.
- **No release-script tests**: `update-website.sh`, `preflight.sh`, `apply-release.sh` (inventory 6 §E.3). The only release-skill work is Phase 12.
- **No tests of `scripts/**`**: third-party-notices, make-fixtures, build-mac, make-icon.
- **No CI.** Do not add GitHub Actions or any `.github/` folder. The repository deliberately has no Actions or secrets.
- **No automated tests of the packaged, signed app:** auto-update, TCC prompts, fuses. They are covered by the release's `build-app.sh`/`verify-release.sh`. Do not add post-build assertions to `build-app.sh` in this spec.
- **No live tests.** Do not make `npm run smoke`, `npm run preflight` or `capture:test` part of any suite.
- **Only the listed bug fixes.** Fix only B1–B5. Everything else goes to the ledger, including bugs that look easy.
- **No new dependencies beyond these:** `@vitest/coverage-v8`, `happy-dom`, `@playwright/test`. No jsdom, no `@vitest/browser`, no `wrangler`, no `three`, no YAML or plist parser, no mocking library (Vitest has `vi`).
- **No upgrades** of vitest, Electron, TypeScript, or any other existing dependency. The coverage package matches the installed vitest instead.
- **No changes to the app's behaviour, UI, copy, config defaults, or `config/*.json`**, except B1–B5.
- **No Swift production changes** except S6. No changes to `electron-builder.yml`, entitlements, or signing.
- **No changes to `docs/mission.md`**, and no specs other than `PROGRESS.md`.

## §6 Known uncertainties

| # | Uncertainty (from the scan) | Safe behaviour |
|---|---|---|
| U1 | happy-dom support is unverified for `:popover-open` (it "may throw a SyntaxError"), `showPopover`, the timing of the `dialog` `close` event, `:focus-visible`, `setPointerCapture`, `scrollIntoView`, and `EventSource` ("probably absent") | Phase 1 probe test first; shim what is missing in `installBrowserStubs()` |
| U2 | Whether `/* v8 ignore next */` survives Vite's esbuild transform of TypeScript. The Vitest docs recommend `/* v8 ignore next -- @preserve */` | Phase 1 probe. Use whichever form the probe proves works, and document it in `docs/testing.md` |
| U3 | "unverified that Electron's module properties are writable (likely)", for stubbing `dialog.showMessageBox` through `app.evaluate` | Try it in Phase 10. If they are not writable, assert on window state instead of sheets and record it |
| U4 | "I believe Electron keys `requestSingleInstanceLock` on the userData dir (unverified)" | An isolated HOME moves userData anyway. Prove it in Phase 10 by running with the installed app open |
| U5 | The symlinked-cwd isolation of `sessions/` for Electron E2E is untested | If it fails, use seam S5 |
| U6 | The FakeRealtimeSocket event names: "UNSURE of the exact event names: read `src/transcribe/live.ts` and `tests/live.test.ts`" | Read those two files; copy the existing `FakeSocket` |
| U7 | The fixture outcome under the E2E fakes ("3 flagged claims, 1 repeat, ≥2 segments and 3 speakers") is hedged | Compute expectations from `loadScript()` and the fake's script; if runs differ, stop (Phase 9) |
| U8 | Whether `src/**` branches can reach 90 % without more seams | Ratchet per phase; Phase 13 stop-and-ask if not |
| U9 | Child-process runs do not count toward v8 coverage ("UNSURE how vitest v5 coverage merges child processes") | Seam S2 for CLIs; do not rely on child-process coverage |
| U10 | Whether `vi.mock` with `importOriginal` works for `web/src/api.ts` imported as `./api.js` ("very likely … not verified") | First web DOM test proves it; if not, mock the `fetch` layer instead |
| U11 | A Playwright/Electron 44 pairing is not officially listed (it worked in the scan's spike) | If launch fails, check the Playwright and Electron versions, and stop and ask before changing either |
| U12 | The ICU date strings ("Sept" for en-GB) depend on Node's ICU build | Compute expected strings with the same `toLocale*` call |

If you discover a new uncertainty, record it in `PROGRESS.md` and take the safest path that keeps production behaviour unchanged. If no safe path exists, stop and ask.

## §7 Anti-hallucination guardrails

1. **Files:** create only the paths in §4.0.2, `CLAUDE.md`, `docs/testing.md`, `playwright.config.ts`, `PROGRESS.md` and `test-suite.sh`. Edit production files only for seams S1–S6 and bugs B1–B5.
2. **`package.json`:** add only the three devDependencies and the four scripts (§4 Phase 1).
3. **Network and money:** no request to `api.openai.com`, `openrouter.ai`, `api.github.com` or `wss://api.openai.com` from any test or harness. `tests/setup.ts`, the harness stubs and the Playwright route guard enforce it; never remove them. Never run `npm run smoke`, `preflight`, `replay`, `serve` with `.env`, or the app with real keys.
4. **Real data:** no test reads or writes the real `~/Library/Application Support/Tattle`, the repo's `sessions/`, `~/Downloads`, or `.env`.
5. **No weakening:** never delete, `.skip`, `.only` or loosen an existing assertion. `.only` must never be committed.
6. **Existing fakes:** move them; don't rewrite what they return. The existing 191 tests must still pass unchanged after the Phase 1 move.
7. **Anchors:** confirm every inventory anchor by grepping the symbol before relying on its line number.
8. **Inventory hints:** a "fix", "refactor" or "suggested seam" hint in an inventory is not permission. §4.0.3 and §4.0.4 are the only permissions.
9. **Protected identifiers:** never change `app://conversation-assistant`, the bundle id `com.cloudlesslabs.conversation-assistant`, the notary profile name, or paths under Application Support. Updates and permissions depend on them (gotchas: renaming).
10. **Git:** commit locally with conventional messages. No push, no tag, no release, no `npm version`, no `dist:mac`.
11. **Thresholds** only move up. Never lower one to make a run pass; stop and ask instead (Phase 13).
12. **This spec** is read-only for you. Record gaps and deviations in `PROGRESS.md` and tell the user.

## §8 Verification commands

```bash
# baseline / any time
git status --short                              # clean before starting and after each commit
npm run typecheck && npm test                   # 191+ tests, offline
npx vitest run tests/<file>.test.ts             # one file
npx vitest run --coverage                       # unit + coverage table; html in coverage/index.html
npx vitest run --coverage --coverage.include='src/pipeline/**'   # one folder while working

# e2e
npx playwright install chromium                 # once per Mac
npm run build:web && npm run build:desktop      # the page and the Mac app bundle (test:e2e does this)
npx playwright test --project=web
npx playwright test --project=electron
npx playwright test --repeat-each=3             # flake check before each e2e commit
npx playwright show-report                      # after a failure (trace on failure)

# swift
swift test --package-path native/capture
npm run test:swift                              # + ClockLock coverage gate
npm run build:capture                           # release build unchanged

# everything, and the release gate
npm run test:all
sh .agents/skills/release-tattle/scripts/test-suite.sh
node scripts/third-party-notices.mjs --check    # dev deps never ship

# docs
python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects <path>
python3 .claude/skills/init-doc/scripts/build-doc-manifest.py --root .
```

- **Running the app by hand** (only to look, never to test with real services): `npm run app`. It shares `~/Library/Application Support/Tattle` with the installed app, and a real session calls paid APIs, so do not start one.
- **Credentials:** none are needed for anything in this spec. If a step seems to need a real key, you are off-spec: stop.

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Engine | The Node process that owns capture, the pipeline and the HTTP/SSE API (`Engine` in `src/server/main.ts`); in the Mac app it runs in Electron's main process |
| Session | One recording run (`Session` in `src/pipeline/session.ts`), in live or replay mode; stored as a folder under `sessions/` |
| Utterance | A VAD-delimited stretch of speech with a speaker and a transcript |
| Segment | A stretch of utterances on the timeline, with labels from Jev |
| Jev | TypeSafe AI's decision model on OpenRouter (`/api/alpha/decisions`), asked typed questions (`src/jev/client.ts`) |
| System 1 / S1 | Jev plus its questions, flagging checkable claims on every utterance (`src/factcheck/s1.ts`) |
| System 2 / S2 | GPT-6 Luna on OpenRouter: researches flagged claims, audits for misses, proposes System 1 rewrites (`src/factcheck/s2.ts`) |
| Replay gate | The check that a System 1 rewrite keeps at least 90 % of good flags before it is promoted (`src/factcheck/gate.ts`) |
| Live text | Streaming display text over the OpenAI realtime WebSocket (`src/transcribe/live.ts`) |
| Echo gate / speaker mode | Mutes the mic while the call plays through speakers (`src/audio/echoGate.ts`) |
| Dev cap | The $3 total spend limit for development runs, summed from `sessions/**/*.jsonl` (`sumDevSpend` in `src/budget.ts`) |
| Capture helper | `tattle-capture`, the Swift binary for the mic and system audio; frames on stdout (`PCAP` magic), status on stderr |
| Fixture | `fixtures/conversation/{host,remote}.wav` + `script.json`: a scripted 78 s, 10-line conversation made with macOS `say` |
| `.tattle` | The export format: a zip with its own extension (Safari would unzip a `.zip`) |
| `app://conversation-assistant` | The Mac app's page origin, served in-process (`inProcessHandler`); never renamed |
| FakeEngine | The test double implementing `EngineApi` (`tests/server.test.ts`, moving to `tests/fakes/`) |
| Full-stack / scripted harness | The E2E servers of Phase 9: real engine with fake services, and a fake engine whose events the test drives |

## §10 References

- The inventories, one per area: `specs/260929-01-test-driven-development/inventory/1…6-*.md`.
- Project docs: `docs/mission.md`; `docs/gotchas.md` (Mac app, Web page, Chat, Test fixture, sherpa-onnx); `docs/architecture.md` § Tests; `docs/desktop.md`; `docs/recordings.md`; `docs/setup.md`; `docs/chat.md`; `docs/system1-system2.md`; README § Releasing and § Scripts.
- The release skill: `.agents/skills/release-tattle/SKILL.md`, `scripts/checks.sh`, `skill.json`.
- Earlier specs, for the house style: `specs/260928-02-custom-label-sets/SPEC.md`, `specs/260928-01-apple-speech-transcription/SPEC.md`. `specs/260928-01` (Apple speech) and `specs/260928-02` (label sets) are **not implemented yet**. If either lands while you work, its new code needs tests under the same rules. Record it in `PROGRESS.md`; do not implement those specs.
- Versions (checked 2026-09-29):

  | Package | Version | Note |
  |---|---|---|
  | vitest | 5.0.1 installed | |
  | @vitest/coverage-v8 | 5.0.1 | peer: exactly the installed vitest |
  | happy-dom | 20.14.5 | |
  | @playwright/test | 1.63.0 | |
  | electron | 44.4.5 | |
  | Node | 24.0.1 | |
  | Swift | 6.3.3 | Swift Testing available |

### Code anchors (most used)

| Anchor | Where |
|---|---|
| `tests/setup.ts` | makes `fetch` throw in every test |
| `requireAssets`, `loadScript`, `FIXTURE_DIR` | `tests/helpers.ts` |
| `Engine`, `EngineApi`, `createApiServer`, `bootEngine`, `main` | `src/server/main.ts` (Engine about :126–544, router about :675–797, `bootEngine` about :806) |
| `inProcessHandler` | `src/server/inProcess.ts:8` |
| `Session`, `SessionOptions` | `src/pipeline/session.ts` (options about :49–76) |
| `KeyStore`, `KeySetup`, `credentialsPath` | `src/keys.ts` (`credentialsPath` about :21) |
| `appPaths`, `setAppPaths`, `appSupportDir`, `migrateAppSupportDir` | `src/paths.ts` |
| `sumDevSpend`, `Budget` | `src/budget.ts` |
| `processSecrets`, `redactor`, `EventBus` | `src/store/events.ts` (about :57–62) |
| `applyEvent`, `emptyState` | `web/src/state.ts` |
| `api`, `ApiError` | `web/src/api.ts` (about :18, :125–170) |
| `toast`, `run`, `segmentMatches` | `web/src/panels.ts` (about :18–31, :432) |
| `linkify` | `web/src/licenses.ts:15` |
| remote-debugging gate, dev/packaged paths, `ask()` | `desktop/main.ts` (:22, :30–46, :117) |
| `ClockLock`, `Levels`, `MonoConverter` | `native/capture/Sources/tattle-capture/ClockLock.swift` |
| Step list, the Gates row, the constraints | `.agents/skills/release-tattle/SKILL.md` (Gates row :20, steps :33–115, constraints :128–141) |
