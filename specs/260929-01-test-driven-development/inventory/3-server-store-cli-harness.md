> **Inventory for [SPEC.md](../SPEC.md) — Area 3: HTTP/SSE server and Engine, session store and library, export/import, CLIs, and the web E2E harness design (§10).** Written 2026-09-29 by a read-only scan of commit `74b42a6`. Line numbers were right at that commit; **symbol names win when lines drift** (grep them). "Spike" and "scratchpad" mentions refer to throwaway experiments run outside the repo during the scan; they are not available to you, but every recipe they validated is written out below. Items marked *unverified*/*UNSURE*/*hedged* are exactly that — verify before relying on them. SPEC.md overrides this file wherever they disagree (scope, thresholds, bug policy, file layout).


# Scan: src/server/**, src/store/**, src/cli/** (+ their tests)

Project root: the repository root (cwd for everything below; many paths are cwd-relative).
Scanner: read-only. All 7 related test files were run: `npx vitest run tests/server.test.ts tests/library.test.ts tests/transfer.test.ts tests/inProcess.test.ts tests/keys.test.ts tests/session.test.ts tests/desktop.test.ts`. Result: 56 passed, about 27 s.
Tooling state: **no `@vitest/coverage-v8` and no Playwright in node_modules**, so both must be added as devDependencies before coverage or E2E work. `tests/setup.ts` replaces `globalThis.fetch` with a function that throws "network disabled in tests". Vitest config (`vitest.config.ts`): `include: tests/**/*.test.ts`, `testTimeout`/`hookTimeout` 120 s, `setupFiles: tests/setup.ts`.

Legend: `sym file:line`. "UNSURE" marks anything I did not verify by running it.

---

## 0. Cross-cutting facts a test writer needs

- **Paths** (`src/paths.ts`): `appPaths()` defaults are *relative*: `web: "web"`, `config: "config"`, `models: "models"`, `sessions: "sessions"`, `helper: "native/capture/.build/release/tattle-capture"`. `root`, `notices`, `licenses` and `src` are absolute. `setAppPaths(partial)` merges into the current paths. `setAppPaths()` with no argument resets them. Every consumer reads the paths at each use, so tests must run from the project root or call `setAppPaths`. `tests/desktop.test.ts` resets in `afterEach(() => setAppPaths())`.
- **Keys** (`src/keys.ts`): `credentialsPath(env)` is `env.TATTLE_CREDENTIALS || ~/Library/Application Support/Tattle/credentials.json` (keys.ts:21). `appSupportDir()` uses `os.homedir()`, which follows `$HOME`. `KeyStore({path, env})` has `load()`, which copies file keys into `env` (default `process.env`). The environment wins over the file. `KeySetup(store, {fetch, models})` has `status()` returning `{configured, keys, path}` and `save(body)`.
- **Key redaction**: `processSecrets()` (events.ts:62) reads `process.env.OPENROUTER_API_KEY` and `OPENAI_API_KEY` on each call. `redactor()` ignores secrets shorter than 8 characters.
- **Budget** (`src/budget.ts`): `Session` builds `Budget({sessionCapUsd, devCapUsd, enforceDevCap: mode !== "live" && !allowOverDevCap, devSpentUsd: sumDevSpend(sessionsDir)})` (session.ts:131-139).
  - `sumDevSpend(root)` walks every `*.jsonl` under root, skips folders that contain `imported.json`, and sums `cost_usd` of rows whose `kind` is in {jev_call, s2_call, transcription, live_transcription, chat_call, deleted_session}.
  - Config defaults: `sessionCapUsd` 10, `devCapUsd` 3 (config/app.json).
- **Session seams** (`SessionOptions`, session.ts:49-76): `services`, `fetch`, `keys {openrouter, openai}`, `embedder`, `liveConnect` (fake realtime WebSocket), `statsIntervalMs`, `retryEveryMs`, `sessionsDir`, `sessionPrefix`, `exportBoundary`, `voices`, `features`, `healthDetail`, `liveText`.
  - `Session.runInner` writes `session.json` synchronously before its first await (session.ts:266).
  - It then emits `session.started` with `dir: store.dir` (session.ts:272).
- **External URLs**, all of which a fake fetch must route:
  - `https://api.openai.com/v1/audio/transcriptions` (transcribe/openai.ts:5)
  - `https://openrouter.ai/api/alpha/decisions` (Jev, jev/client.ts:6)
  - `https://openrouter.ai/api/v1/chat/completions` (S2 non-streaming with `response_format.json_schema.name` ∈ verdict|audit|rewrite, s2.ts:6). The chat window uses the same URL with `stream: true`.
  - `https://openrouter.ai/api/v1/models` and `https://openrouter.ai/api/v1/generation` (chat.ts:9-10)
  - `https://api.openai.com/v1/models` and `https://openrouter.ai/api/v1/key` (key checks and preflight)
  - `wss://api.openai.com/v1/realtime?intent=transcription` (live.ts:7). Its default connect is `new WebSocket(url, {headers})`, resolved from the global at call time (live.ts:78).
- **Reusable fakes already in tests**:
  - `fakeFetch(script)` in `tests/session.test.ts:23-79` handles transcription by clip duration, Jev by script line, and S2. It also echoes the key in one Jev error to prove redaction.
  - `fakeOpenRouter()` in `tests/chat.test.ts:46-62` returns the models catalogue and a streamed SSE chat.
  - `fakeFetch()` in `tests/keys.test.ts:16-27` covers the key checks.
  - `FakeSocket` in `tests/live.test.ts:10-22` implements `SocketLike`.
  - `services()` in `tests/echoGate.test.ts:85-89` and `flaky()` in `tests/retry.test.ts:13-21` are Services fakes: transcribe only, and Jev throws.
  - `frameBytes()` in `tests/nativeSource.test.ts:7` builds helper frames.
  - `FakeEngine` in `tests/server.test.ts:14-51` implements `EngineApi`.
  - **Recommendation:** move these into `tests/fakes/*.ts` for reuse by the unit and E2E suites.
- **Fixture**: `fixtures/conversation/{host.wav,remote.wav,script.json}`, 77.754 s, 10 scripted lines. `tests/helpers.ts`: `FIXTURE_DIR = "fixtures/conversation"`; `requireAssets()` throws "run npm run models && npm run fixtures" when models or fixtures are missing; `loadScript()`. Both models are present locally.
- **`os.tmpdir()`** is where exports (`pa-<id>-<ts>.tattle`), export work dirs (`pa-export-*`) and uploads (`pa-import-*`) go. Set `TMPDIR` to isolate them.

---

## 1. `src/server/main.ts` (857 lines): Engine, HTTP/SSE router, boot, `npm run serve` CLI

### 1.1 Exports

| Symbol | Line | Notes |
|---|---|---|
| `interface TransferApi` | 27 | info, prepare, file, importFile, importCopy |
| `interface ChatApi` | 39 | models, list, chat, create, update, remove, stop, prepare |
| `class ApiError(status, message)` | 51 | |
| `type StartRequest` | 58 | replay: `{mode, dir?, sessionId?, speed?, name?, voices?, features?}`; live: `{mode, mic?, name?, voices?, features?}` |
| `parseFeatures` (not exported) | 62 | null/undefined → `{}`; non-object → 400 "features must be an object"; non-boolean factcheck/labels → 400 "features.<k> must be true or false"; other keys ignored |
| `interface EngineApi` | 76 | What the router needs. `chat?` and `transfer?` are optional (routes answer 501 when absent) |
| `replaySources(dir, speed)` | 109 | FileSource per existing host.wav/remote.wav; none → `ApiError(400, "no host.wav or remote.wav in <dir>")` |
| `interface LiveCapture {sources, stop()}` | 119 | |
| `type CaptureStatusHandler` | 124 | |
| `interface EngineOptions` | 126 | config, sessionsDir, allowOverDevCap, session (Partial<SessionOptions>), live, devices, fetch (chat), openrouterKey |
| `class Engine` | 140 | see 1.2 |
| `PAGE_CSP` | 554 | |
| `about(root = appPaths().root)` | 561 | `{name, version, license: {id, holder, text}}`; LICENSE missing → text "" |
| `engineStale(srcDir = appPaths().src, since = BOOTED_AT)` | 568 | null srcDir → false; any `.ts` mtime > since → true; a walk error → false |
| `interface SetupApi` | 654 | |
| `createApiServer(engine, {webRoot?, setup?})` | 675 | returns a `node:http` Server that is not yet listening |
| `bootEngine({allowOverDevCap?})` | 806 | see 1.5 |
| `main()` (not exported) | 824 | guarded at 852 by `import.meta.url === \`file://${process.argv[1]}\`` |

Module state: `BOOTED_AT = Date.now()` (548) is captured at import. `CONTENT_TYPES` (580) covers `.html .css .js .map .json .svg .png .ico .woff2`; anything else gets `application/octet-stream`.

### 1.2 Engine (140-544): members, behaviour, error statuses

Fields:
- `bus = new EventBus({redact: processSecrets(), onInvalid: console.error})` (141)
- `session`, `capture`, `captureDetail`, `archived` (the id of the recording on screen)
- `library = new SessionLibrary(opts.sessionsDir)` (153)
- `chat = new ChatService(config.app.chat, {fetch: opts.fetch ?? global fetch (resolved per call), get apiKey() { opts.openrouterKey ?? env.OPENROUTER_API_KEY ?? "" }, source, onSpend})` (154-160)
- `exports: Map<token, {path, fileName}>` (163) and `uploads: Map<copyToken, {path, fileName}>` (165)
- `embedder` (332), created lazily

Methods:

| Method | Line | Behaviour / errors |
|---|---|---|
| `transfer.info(id)` | 168 | `libraryCall(dirOf)`: 404 unknown/invalid id. Returns `{id, name, fileName: exportFileName(name,id), recordedWith: appVersion, app: appInfo(), bytes:{compressed,original,none}, chats, hasAudio}` |
| `transfer.prepare(id, body)` | 173 | 404 bad id; 409 "stop the session before exporting it" when `session.id===id && status!=="ended"`; audio default "compressed", else 400 "audio must be compressed, original, or none"; `chats` present and non-boolean → 400; `exportRecording` into `os.tmpdir()`; TransferError → ApiError via `transferCall` (229); `token = randomUUID()`; stored in `exports`; `setTimeout(15 min).unref()` deletes the entry and `rm(path)` (183) → `{token, fileName, bytes}` |
| `transfer.file(token)` | 186 | unknown → 404 "this export has expired: export again" |
| `transfer.importFile(body, fileName)` | 191 | `notOnAir()`: 409 while `session.status==="running"`. `saveUpload(body, MAX_UPLOAD_BYTES)`: 413 over 4 GB. `importRecording(tmp, library.root, fileName)` → `{summary, manifest, already:false}`. On `TransferError` 409 with `.id`: keep the upload, `copyToken = randomUUID()`, `uploads.set`, 15-minute unref'd timer discards it → `{summary: library.get(existingId), already:true, copyToken}`. Other TransferError → `ApiError(status)`. Anything else is rethrown raw (the router answers 400). `finally`: discard tmp unless kept |
| `transfer.importCopy(token, name)` | 213 | `notOnAir()` 409; unknown token → 404 "the upload has expired: import the file again"; name not a string or blank → 400 "a name is required for the copy"; trimmed length > 120 → 400 "name is too long". Deletes the token (one use) → `importRecording(..., {copy:true})` → `library.update(id,{name})` → `{summary, manifest, already:false}`. `finally` discards the upload |
| `exportSent(token)` | 239 | Not in EngineApi; the router calls it by duck typing. Deletes the entry and `rm`s the file; unknown token → no-op |
| `chatSource()` (private) | 247 | Session present and not archived → `{sessionId, dir, live: status==="running", lines: s.transcriptLines(), budget}`; archived → `{…, live:false, lines: library.transcript(id)}` with no budget; neither → null |
| `chatSpent(src)` (private) | 259 | Only for an archived recording without a budget: emits a transient `cost` `{...s.cost, session: costUsd, sessionCapUsd}` |
| `current` getter | 266 | the Session or null |
| `notOnAir()` | 271 | 409 "a session is on air: import the recording after it ends" |
| `need()` | 275 | archived → 409 "viewing a recorded session: start or replay one to use this command"; no session → 409 "no session" |
| `state()` | 281 | archived → `library.snapshot(id)`; none → `{session:null}`; else `session.state()` plus `session.name` from the library (errors swallowed) |
| `libraryCall(fn)` | 290 | Error message matching /unknown session\|invalid session/ → 404, otherwise 400 |
| `listSessions(q, includeTools=false)` | 299 | `library.list({q, includeTools})` |
| `getSession(id)` / `updateSession(id, patch)` | 303/307 | via `libraryCall`: 404/400. `patch ?? {}` |
| `openSession(id)` | 312 | 409 "a session is running: stop it first" if the session is not ended; `library.events(id)` (404 bad id); sets `session=null`, `archived=id`; `bus.load(events)` → `{sessionId, events: count}` |
| `deleteSession(id)` | 322 | 409 "stop the session before deleting it" if `session.id===id`; `library.remove` (404 invalid/unknown); clears `archived` and `bus.reset()` if it was on screen → `{deleted:id}` |
| `speakerSuggestions(remoteVoices?)` | 339 | Running session: voices from `session.voices`/config and talk time from `session.stats()` → `suggestMerges`. Archived: `library.voicesOf` + `library.speakers` + lazy `Embedder` + `recordedVoiceprints(dir, ...)`, which reads the WAVs. Neither → 409 "no session" |
| `sessionDir(id)` | 359 | `libraryCall(dirOf)` |
| `callLog(system, limit?)` | 364 | No archived or current session → `{rows:[], models:{s1: cfg.jev.model, s2: cfg.s2.model}}`; else `library.calls(id, system, limit)` |
| `closeView()` | 371 | Not archived → `{closed:null}`; else clears `archived`, `bus.reset()` → `{closed:id}` |
| `pause()` | 379 | `need()`; mode not live → 409 "only a live session can be paused"; status not running → 409 "the session is ending"; `s.pause()` → `{paused:true}` |
| `resume()` | 387 | `need()`; not running → 409; `s.resume()` → `{paused:false}` (works for replay too) |
| `start(req)` | 394 | See the flow below |
| `followOutput()` (private) | 444 | Uses `captureDetail.remote.outputKind` ∈ speakers/headphones/virtual (else null) and `outputDevice` string → `session.setOutput(kind, device)`; only in live mode |
| `stop()` | 451 | `need()` (409); awaits `capture.stop()` if set, then `session.stop()` → `{sessionId}` |
| `devices()` | 461 | No `opts.devices` → 501 "device listing is not available" |
| `renameSpeaker(id, name)` | 466 | Archived: resolves merges; unknown → 404 "unknown speaker <id>"; blank name → 400 "displayName is required"; trims; emits `speaker.updated` and `library.recordSpeakerEdit` → `{id: target, displayName}`. Live: `need()`, 404, 400, `s.renameSpeaker` |
| `mergeSpeakers(from, into)` | 483 | Archived: either unknown → 404 "unknown speaker"; same after resolving → 400 "cannot merge a speaker into itself"; emits `speaker.merged` with into's displayName and records it → `{id: into, displayName}`. Live: 404 checks, then `s.mergeSpeakers` (no "itself" check at engine level; UNSURE whether Session checks it) |
| `needFeature(f)` | 502 | `need()`, then 409 "labels are off for this session" / "fact-checking is off for this session" |
| `putLabels(body)` | 510 | `LabelConflictError` → 409; any other throw → 400 with its message |
| `relabel()` | 520 | → `{segments: n}` (the router answers 202) |
| `putStories(h)` | 524 | Validation first: not an array of strings → 400 "headlines must be an array of strings"; then `needFeature("labels")` |
| `override(claimId, note)` | 529 | `needFeature("factcheck")`; unknown claim → 404 "unknown claim <id>" |
| `rollback(version)` | 535 | `needFeature("factcheck")`; unknown → 404 "unknown version <v>" → `{active}` |
| `stats()` | 541 | `need().stats()` |

`start(req)` flow (394-441):
1. A session that is not ended → 409 "a session is already running".
2. `parseFeatures(req?.features)`.
3. Replay:
   - The dir comes from `req.sessionId` (`libraryCall(dirOf)`, 404/400) or `req.dir`; missing → 400 "dir or sessionId is required".
   - `speed = req.speed === "max" ? "max" : 1`, so any other value means real time.
   - `replaySources` (400 if no WAV).
   - `liveText = speed === 1`.
4. Live:
   - No `opts.live` → 501 "live capture is not available".
   - `captureDetail = null`; `capture = await opts.live(req.mic, onStatus)`, where `onStatus("error", d)` becomes `session.emit("error", d)` and `onStatus("health", d)` sets `captureDetail = d.capture ?? d` and calls `followOutput()`.
   - `liveText = true`.
5. Any other mode → 400 "mode must be replay or live".
6. `archived = null`; `bus.reset()`.
7. `new Session({mode, sources, config: structuredClone(config), bus, sessionsDir, allowOverDevCap, healthDetail, liveText, features, voices: {remote: req.voices} if a non-negative integer, ...opts.session})`. **`opts.session` is spread last and can override anything**, including `sources` and `bus`.
8. `s.run().then(() => { if session===s: session=null; archived=s.id })`. A rejected run is only logged.
9. Live mode calls `followOutput()` again.
10. If `req.name` is a non-blank string, `library.update(s.id, {name})`.
11. Returns `{sessionId}`.

### 1.3 HTTP router: `createApiServer` (675-797)

Pre-checks, in order:
1. `fromThisPage(req)` (665) checks two things:
   - Host must match `^(127\.0\.0\.1|localhost)(:\d+)?$`.
   - Origin must be absent or equal to `http://${host}`.
   Failure → **403** "this server answers only its own page at 127.0.0.1". This applies to **every** path, static files included.
2. When `setup` is given and the path starts with `/api/setup`:
   - `GET /api/setup` → 200 `setup.status()`.
   - `POST /api/setup/keys`: content-type must start with `application/json`, else **415** "expected JSON"; then `readJson` → `setup.save(body)` → 200.
   - Anything else under `/api/setup*` falls through.
3. Gate (692): `setup` given, the path starts with `/api/`, it is not in `OPEN_ROUTES` {/api/setup, /api/setup/keys, /api/about, /api/licenses, /api/engine}, and `!setup.status().configured` → **503** `{error: "API keys are missing: open the page to add them", setup: true}`. Static page routes are not gated.

`readJson(req)` (592):
- More than 1,000,000 bytes → 413 "body too large".
- An empty or whitespace body → `{}`.
- Unparsable → 400 "invalid JSON body".
- The literal `null` → `null`, so a later `.field` access throws a TypeError, which the router answers with 400.

Catch-all (792-795): `ApiError`, `ChatError` and `KeyError` keep their `.status`. **Every other error is answered with 400**, including internal errors such as ENOENT and `TransferError` thrown by a non-Engine `EngineApi`. The body is `{error: message}`, sent as `application/json; charset=utf-8` with `Cache-Control: no-store`.

| # | Method | Path (regex) | Line | Handler | Request | Success | Error branches |
|---|---|---|---|---|---|---|---|
| 1 | GET | /api/setup | 685 | `setup.status()` | – | 200 `{configured, keys[{name,env,set,source,hint}], path}` | no `setup` → 404 |
| 2 | POST | /api/setup/keys | 686 | `setup.save` | JSON `{openai?, openrouter?}`; content-type json | 200 `{saved, checks, configured, keys, path}` | 415 not json; 413; 400 invalid JSON; KeyError 400 (not an object / "no key given" / non-string); 409 for a key set in the environment |
| 3 | GET | /api/events | 695 | SSE | – | 200 `text/event-stream`; first `: connected\n\n`, then the whole `bus.history()`, then live; `: ping\n\n` every 15 s; unsubscribes and clears the ping on `req` close | 503 gate |
| 4 | GET | /api/state | 704 | `engine.state()` | – | 200 | Engine errors |
| 5 | GET | /api/calls | 705 | `engine.callLog(system, limit)` | `?system=s2` (anything else → s1) `&limit=` (`Number(x)` or undefined, so 0/NaN → undefined) | 200 `{rows, models}` | 404 unknown session id (from the library) |
| 6 | GET | /api/about | 710 | `about()` | – | 200 | package.json missing → 400 |
| 7 | GET | /api/licenses | 711 | `licenses()` (src/licenses.ts) | – | 200 `{app, groups, texts}` | |
| 8 | GET | /api/engine | 712 | – | – | 200 `{startedAt: ISO(BOOTED_AT), stale: engineStale()}` | |
| 9 | GET | /api/stats | 713 | `engine.stats()` | – | 200 | 409 no session / archived |
| 10 | GET | /api/devices | 714 | `engine.devices()` | – | 200 array | 501 no devices option; helper errors → 400 |
| 11 | POST | /api/session/start | 715 | `engine.start(body)` | StartRequest | 200 `{sessionId}` | 409 running; 400 mode, dir, features or no WAV; 404 unknown sessionId; 501 live unavailable; live() rejection → 400 |
| 12 | POST | /api/session/stop | 716 | `engine.stop()` | – | 200 `{sessionId}` | 409 |
| 13 | POST | /api/sessions/close | 717 | `engine.closeView()` | – | 200 `{closed}` | |
| 14 | POST | /api/session/pause | 718 | `engine.pause()` | – | 200 `{paused:true}` | 409 ×4 |
| 15 | POST | /api/session/resume | 719 | `engine.resume()` | – | 200 `{paused:false}` | 409 |
| 16 | GET | /api/speakers/suggestions | 720 | `engine.speakerSuggestions(v)` | `?voices=`: absent or "" → undefined, else `Math.max(0, Number(v)\|\|0)` | 200 `{suggestions, voices}` | 409 |
| 17 | POST | /api/speakers/merge | 724 | `engine.mergeSpeakers(b.fromId, b.intoId)` | `{fromId, intoId}` | 200 | 404, 400, 409 |
| 18 | POST | `^/api/speakers/([^/]+)/rename$` | 728 | `engine.renameSpeaker(decodeURIComponent(id), body.displayName)` | `{displayName}` | 200 `{id, displayName}` | 404, 400, 409; a bad %-escape (URIError) → 400 |
| 19 | PUT | /api/labels | 730 | `engine.putLabels(body)` | label set | 200 `{version}` | 409 conflict or feature off; 400 |
| 20 | POST | /api/labels/relabel | 731 | `engine.relabel()` | – | **202** `{segments}` | 409 |
| 21 | PUT | /api/stories | 732 | `engine.putStories(body.headlines)` | `{headlines: string[]}` | 200 `{version}` | 400, 409 |
| 22 | POST | `^/api/claims/([^/]+)/override$` | 733 | `engine.override(id, body.note)` | `{note?}` | 200 | 404, 409 |
| 23 | GET | /api/sessions | 735 | `engine.listSessions(q, all==="1")` | `?q=&all=1` | 200 `SessionSummary[]` (with `matches` when q is set) | |
| 24 | GET | `^/api/sessions/([^/]+)$` | 739 | `engine.getSession` | – | 200 | 404 (note: `GET /api/sessions/import` → 404 "unknown session import") |
| 25 | PATCH | same | 740 | `engine.updateSession(id, body)` | `{name?, notes?}` | 200 summary | 400 too long / not a string; 404 |
| 26 | DELETE | same | 741 | `engine.deleteSession` | – | 200 `{deleted}` | 409 current; 404 |
| 27 | GET/HEAD | `^/api/sessions/([^/]+)/audio$` | 743 | `serveMixedAudio(engine.sessionDir(id), req, res)` | `Range: bytes=a-b` | 200/206 `audio/wav` | 404 unknown id; 404 JSON "this recording has no audio"; 416 |
| 28 | POST | `^/api/sessions/([^/]+)/open$` | 745 | `engine.openSession` | – | 200 `{sessionId, events}` | 409, 404 |
| 29 | GET | /api/chat/models | 749 | `chat.models()` | – | 200 `{default, capUsd, models[]}` | no chat → 501 "chat is not available" |
| 30 | GET | /api/chats | 750 | `chat.list()` | – | 200 `{spentUsd, capUsd, chats}` | 501; ChatError 409 "no session on screen…" (UNSURE whether list() throws) |
| 31 | POST | /api/chats | 751 | `chat.create(body.model)` | `{model?}` | 200 chat | ChatError 400 unknown model; 409 no source |
| 32 | GET | `^/api/chats/([^/]+)$` | 753 | `chat.chat(id)` | – | 200 | ChatError 404 "unknown chat" |
| 33 | PATCH | same | 754 | `chat.update(id, body)` | `{title?, model?}` | 200 | 400 blank or long title, unknown model; 404 |
| 34 | DELETE | same | 755 | `chat.remove(id)` | – | 200 | 404 |
| 35 | POST | `^/api/chats/([^/]+)/stop$` | 757 | `chat.stop(id)` | – | 200 | |
| 36 | POST | `^/api/chats/([^/]+)/messages$` | 759 | `streamChat(res, chat.prepare(id, body))` | `{content?, mode?: "edit"\|"regenerate"}` | 200 SSE: `event: start\|thinking\|delta\|done\|error` with `data: JSON(ChatEvent)`; a run that throws after the headers → `event: error` (`chat: null`), then end | Errors raised by `prepare()` *before* the headers are normal JSON: 409 busy or capped; 400 content required / too long (>20,000) / nothing to regenerate or edit; 404 |
| 37 | POST | /api/sessions/import | 764 | `t.importFile(req, name)` | raw bytes; `X-File-Name` URI-encoded (a malformed escape gives null) | 200 `{summary, manifest, already:false}` or `{summary, already:true, copyToken}` | no transfer → 501; 409 on air; 413; 400 not a zip / no manifest / damaged / wrong format / newer formatVersion / incomplete / too large / bad audio; 500 afconvert |
| 38 | POST | `^/api/sessions/import/([0-9a-f-]{36})$` | 770 | `t.importCopy(token, body.name)` | `{name}` | 200 | 404 expired; 400; 409 on air. A non-matching (uppercase/short) token → falls through to 404 "not found" |
| 39 | GET | `^/api/sessions/([^/]+)/export$` | 772 | `t.info(id)` | – | 200 | 404; 501 |
| 40 | POST | same | 773 | `t.prepare(id, body)` | `{audio?, chats?}` | 200 `{token, fileName, bytes}` | 409 on air; 400; 404; 500 afconvert |
| 41 | GET | `^/api/exports/([0-9a-f-]{36})$` | 775 | `t.file(token)`, then streams the file | – | 200 `application/octet-stream`, `Content-Length`, `Cache-Control: no-store`, `Content-Disposition: attachment; filename="<ascii with non-printables → _ and " → '>"; filename*=UTF-8''<encoded>`; `exportSent(token)` on `res` "finish" | 404 expired; a file deleted after `file()` → `statSync` throws → 400 |
| 42 | POST | /api/s1/rollback | 789 | `engine.rollback(body.version)` | `{version}` | 200 `{active}` | 404, 409 |
| 43 | GET | static | 790, `serveStatic` 627 | `/`, `/index.html`, `^/recordings/[A-Za-z0-9][A-Za-z0-9_-]*/?$` → index.html; `/licenses` → licenses.html; `/styles.css`; `/dist/**`; `/fonts/**` | – | 200 with content type; `.html` also gets the `Content-Security-Policy: PAGE_CSP` header; `Cache-Control: no-cache` | Decode error, outside webRoot, missing or a directory → false → 404 |
| 44 | * | anything else | 791 | – | – | 404 `{error:"not found"}` | |

**SSE event types on `/api/events`**: every key of `EVENT_SCHEMAS` (events.ts:8-43):
- Session: `session.started`, `session.ended`, `session.paused`, `session.resumed`
- Audio and transcript: `echo.gate`, `health`, `utterance.partial`\*, `utterance.failed`, `utterance`
- Speakers: `speaker.created`, `speaker.updated`, `speaker.merged`
- Timeline: `segment.closed`, `segment.labels`, `section.updated`
- Claims: `claim.flagged`, `claim.duplicate`, `claim.repeat`, `claim.researching`, `claim.verdict`, `claim.dropped`, `claim.disputed`
- System 1: `audit`, `s1.version`, `s1.memory`
- Spend and misc: `cost`, `budget.exhausted`, `stats`, `error`, `call.started`\*, `call`\*

\* marks types that are transient in Session (session.ts:40): they are never in the history and never in events.jsonl. The Engine's transient `cost` for chats is also transient.

Wire format: `id: <seq>\nevent: <type>\ndata: <JSON AppEvent {seq,type,at,data}>\n\n` (622). `Last-Event-ID` is ignored; every connection gets the full history.

### 1.4 Side effects

- **fs**: `about()` reads `package.json` and `LICENSE` on every request. `engineStale` walks `src/`. `serveStatic` reads under webRoot. Export files go to `os.tmpdir()`. Imports write to `<sessions>/.import-*` and rename into place. `library.update` writes `meta.json`. `recordSpeakerEdit` appends to `events.jsonl` and rewrites `speakers.json`. `library.remove` does `rm -rf <sessions>/<id>` and appends `<sessions>/deleted-spend.jsonl`.
- **Timers**:
  - 15-minute `unref()` timers per export (183) and per kept upload (205).
  - A 15 s SSE ping per connection (700).
  - Session timers: health 1 s, stats 60 s (`statsIntervalMs`), retry 15 s (`retryEveryMs`).
- **Child processes**: `afconvert` (via transfer.ts); `listDevices` and `startNativeCapture` spawn the helper (only through `bootEngine`'s `live` and `devices` options).
- **Network**: the chat's OpenRouter calls via `opts.fetch ?? fetch`; the Session's real services; `bootEngine`'s `KeySetup` uses the global `fetch`.
- **Env vars**: `OPENAI_API_KEY`, `OPENROUTER_API_KEY` (read live), `TATTLE_CREDENTIALS`, `HOME` (through homedir), `TMPDIR`.

### 1.5 `bootEngine` (806-820) and `main` (824-850)

`bootEngine` runs these steps, in order:
1. `migrateAppSupportDir()`. **This touches the real `~/Library/Application Support`** by renaming "Conversation Assistant" to "Tattle" when only the old folder exists.
2. `new KeyStore().load()`, using `TATTLE_CREDENTIALS` or `$HOME/...`.
3. `loadConfig()`.
4. `new KeySetup(keys, {fetch: (...a) => fetch(...a), models: [transcription.model, live.model if enabled]})`.
5. `new Engine({config, allowOverDevCap, live: startNativeCapture({mic: mic==="builtin" ? undefined : mic, onStatus}), devices: listDevices})`.
6. Returns `{keys, config, engine, server: createApiServer(engine, {setup})}`.

It has **no parameters for fetch, sessionsDir, keys path, session services, live or devices**. It is used by `desktop/main.ts:58` with `bootEngine({allowOverDevCap: app.isPackaged})`.

`main()`:
- Arguments (`parseArgs`): `--replay <dir>`, `--speed` (default "1"), `--port` (default `config.app.server.port` 4317), `--allow-over-dev-cap` (boolean). Unknown flags throw from `parseArgs` → caught at 853 → prints the message and exits 1.
- Listens on `127.0.0.1`. Logs `Tattle on http://127.0.0.1:<port>`; this is the requested port, so `--port 0` logs `:0`. When keys are missing it also logs `API keys missing (openai, openrouter): open the page above to add them`.
- `--replay` with keys missing → stderr "--replay needs both API keys…", but the server keeps running (exit code stays 0).
- Otherwise `engine.start({mode:"replay", dir, speed: "max" if --speed max else 1})` → logs "replaying <dir> at speed <s> as session <id>". A start failure (for example a bad dir) rejects `main` → exit 1.
- SIGINT/SIGTERM → stop a running session (errors ignored) → `process.exit(0)`.

### 1.6 Existing tests touching main.ts

- `tests/server.test.ts` builds a `FakeEngine` (14-51) as `createApiServer(engine, {webRoot: mkdtemp web})`. It uses `listen(0, "127.0.0.1")` and a raw `http.request` helper `call()`, because fetch is disabled, plus `bytes()` for Range.
  - "a recording's audio: both streams mixed into one seekable WAV": 200/206/416/404 (unknown id), mid-sample ranges.
  - "quiet speech is boosted to a common level, within a limit": `streamGain` ≈ +18 dB; `limit()`.
  - "every route": state, start, devices, rename 200/404, merge, labels 200/409, relabel 202, stories, override, rollback, stats, stop, sessions list/get/404/patch/open, a bad JSON body → 400, `/api/nope` → 404, call order.
  - "pause, resume, and delete a recording".
  - "merge suggestions for the session on screen" (voices=1 and absent).
  - "the call log of System 1 or System 2".
  - "the version comes from the root package.json, with the license".
  - "the licenses: …" and "the notices split into groups…" (`parseNotices`).
  - "the page can tell when the engine code changed…" (`engineStale` true/false).
  - "every route answers only its own page…": cross-origin POST → 403, rebound Host → 403 for the API and static, allowed hosts.
  - "the page is served with its Content-Security-Policy".
  - "static files are served from web/ only": types, traversal 404s including encoded ones, `/recordings/:id`, `/licenses`, `POST /api/sessions/close`.
  - "SSE replays the session's events so far on connect, then streams".
- `tests/keys.test.ts` "the server before the keys are set" builds `createApiServer({bus, state} as EngineApi, {webRoot, setup: new KeySetup(new KeyStore({path: tmp, env: {}}).load(), {fetch: fakeFetch().f, models: []})})`. It tests the 503 gate, `/api/licenses` open, setup status, the partial and full save, and 403 for an evil Origin or Host plus 415 for a form post.
- `tests/session.test.ts` uses the real Engine as `new Engine({sessionsDir: mkdtemp, session: {fetch: fakeFetch(script).f, keys: {openrouter, openai}}})`.
  - "the engine starts a named, transcript-only session; commands for its off features are refused": invalid features → throw; name applied; relabel, stories and rollback refused.
  - "an ended session becomes a recording, which can be deleted without lowering the development spend": pause refused in replay and when archived; state archived; delete; `sumDevSpend` unchanged; unknown/invalid id errors.
- `tests/library.test.ts` uses `new Engine({sessionsDir})`:
  - "the engine reopens a recording read-only from its events"
  - "speakers can be renamed and merged on a reopened recording…"
- `tests/transfer.test.ts` "the same recording again can be imported as a named copy, from the same upload" covers `importFile` → already+copyToken, a blank name → throw, copy, the token used once, id rewrite.
- `tests/echoGate.test.ts:158-181` covers live mode through the Engine with the `live` fake and `followOutput` (speakers → headphones).
- `tests/desktop.test.ts` checks that `about()` throws for a missing root and `engineStale()` is false with `src: null`.

### 1.7 NOT covered (main.ts): tests to write

Router (FakeEngine or real Engine; raw http):
- `it("answers 501 for every chat route when engine.chat is absent")`: GET /api/chat/models, GET/POST /api/chats, GET/PATCH/DELETE /api/chats/x, POST /api/chats/x/stop and POST /api/chats/x/messages → 501 "chat is not available".
- `it("answers 501 for import/export routes when engine.transfer is absent")`: POST /api/sessions/import, POST /api/sessions/import/<uuid>, GET/POST /api/sessions/x/export, GET /api/exports/<uuid> → 501.
- `it("GET /api/devices → 501 when the Engine has no devices option")` (real Engine without `devices`).
- `it("a body over 1,000,000 bytes → 413 body too large")` (POST /api/session/start). UNSURE whether the client sees the 413 or ECONNRESET, because the server answers before draining.
- `it("body 'null' on POST /api/speakers/x/rename → 400")` (TypeError message).
- `it("empty body on POST /api/session/start → 400 mode must be replay or live")`.
- `it("a malformed percent-escape in an id → 400")`: GET /api/sessions/%E0%A4%A.
- `it("GET /api/sessions/..%2Fetc → 404 invalid session id")` (real Engine: invalid ids map to 404, not 400).
- `it("GET /api/sessions/import → 404 unknown session import")`, a route-shadowing documentation test.
- `it("POST /api/sessions/import/NOT-A-UUID → 404 not found")`.
- `it("GET /api/exports/<unknown uuid> → 404 this export has expired")`.
- `it("GET /api/exports/:token streams the file with Content-Disposition (ascii fallback plus UTF-8 filename*), then a second GET → 404")`. The file has been deleted after 'finish' (await one tick).
- `it("a file name with é and quotes: filename=\"_\" and ' substitution; filename* percent-encoded")`.
- `it("POST /api/chats/:id/messages streams start/delta/done SSE events")` (real Engine plus fake chat fetch, or a FakeEngine chat whose `prepare` returns a runner).
- `it("a runner that throws after the headers yields event: error with chat:null, then ends")`.
- `it("prepare() throwing ChatError 409 answers JSON 409, not SSE")`.
- `it("unknown ChatError/KeyError statuses propagate; a generic Error → 400")`.
- `it("SSE sends ': connected' first and ': ping' every 15 s")` (vi.useFakeTimers is hard with a real socket; alternative: advance a mocked setInterval, or wait. UNSURE).
- `it("SSE: a client disconnect unsubscribes from the bus")` (this is tested for inProcess; add one over TCP).
- `it("SSE carries id: <seq> lines")`.
- `it("the setup gate: with configured=false, /api/about, /api/engine and /api/licenses answer 200 and /api/events, /api/sessions and /api/session/start answer 503 {setup:true}; static / still 200")`.
- `it("unknown /api/setup/foo → 503 when unconfigured, 404 when configured")`.
- `it("GET /api/setup without a setup option → 404")`.
- `it("POST /api/setup/keys: KeyError 409 for an env key, 400 for {}, 400 for a non-string key")`.
- `it("Origin 'null' and IPv6 Host [::1] are refused (403)")`.
- `it("Origin http://localhost:P with Host 127.0.0.1:P → 403")` (they mismatch).
- `it("HEAD /api/sessions/:id/audio → headers only, Content-Length = total")`.
- `it("static: /index.html, /recordings/x/ (trailing slash), .map/.json/.svg/.png/.ico types, an unknown extension → application/octet-stream, /dist/ (a directory) → 404, POST / → 404")`.
- `it("GET /api/calls?limit=0 → limit undefined (default 300); ?system=anything → s1")`.
- `it("GET /api/speakers/suggestions?voices=abc → 0; ?voices=-3 → 0; ?voices= → undefined")`.
- `it("POST /api/labels/relabel answers 202")` (done). `it("PUT /api/stories with headlines not an array → 400")` via the real Engine.
- `it("GET /api/engine returns startedAt ISO and stale:false when appPaths().src is null")`.

Engine (real, `sessionsDir` = mkdtemp, `session: {fetch or services}`):
- `start`:
  - `it("rejects a second start while running → 409 a session is already running")`
  - `it("replay without dir or sessionId → 400")`
  - `it("replay of a dir without WAVs → 400 no host.wav or remote.wav")`
  - `it("replay by sessionId uses library.dirOf; an unknown id → 404")`
  - `it("speed other than 'max' means real-time and liveText=true")` (spy with `session: {liveConnect}` and `config.transcription.live.enabled`)
  - `it("mode 'x' → 400")`
  - `it("live without opts.live → 501")`
  - `it("voices: 2 → session.voices.remote === 2; voices: -1 or '2' ignored")`
  - `it("features {factcheck:1} → 400")`
  - `it("the name is trimmed into meta.json")`
  - `it("a name over 120 chars: start rejects with 400 but the session is already running")` (documents bug §11.1)
  - `it("a live onStatus('error') becomes an error event")`
  - `it("health without .capture is kept as captureDetail itself")`
  - `it("outputKind 'virtual' → setOutput('virtual'), 'bogus' → null")`
- `stop`:
  - `it("stops the live capture before the session and clears it")` (fake `live` with a spied `stop()`)
  - `it("stop with no session → 409 no session; when archived → 409 viewing a recorded session")`
- `pause`/`resume`:
  - `it("live pause/resume → {paused:true}/{paused:false}")`
  - `it("resume on an ending session → 409 the session is ending")`
- `openSession`:
  - `it("openSession while a session runs → 409")`
  - `it("openSession of an ended-but-still-current session clears it and archives the opened one")`
- `deleteSession`:
  - `it("deleteSession of the current running session id → 409")`
  - `it("deleting a recording that is not on screen leaves the archived view and history")`
- `it("closeView without an archived recording → {closed:null}; with one → {closed:id} and an empty history")`.
- `callLog`:
  - `it("callLog with no session → empty rows and the config models")`
  - `it("callLog of an archived recording → the last N rows, models from session.json")`
- `it("devices() delegates to opts.devices")`.
- `putLabels`:
  - `it("putLabels: LabelConflictError → 409, invalid → 400, ok → {version}")` (a running replay with labels on; UNSURE about the exact label-body shape: see timeline.ts `replaceLabels`)
  - `it("putLabels when labels are off → 409 labels are off")`
- `it("override unknown claim → 404; override with factcheck off → 409")`.
- `it("rollback unknown version → 404; a known version → {active}")`.
- `it("stats() when archived → 409; while running → stats object")`.
- `speakerSuggestions`:
  - `it("speakerSuggestions with no session → 409")`
  - `it("speakerSuggestions for a running session uses voices and talk time")` (UNSURE whether voiceprints exist fast enough)
  - `it("speakerSuggestions for an archived recording reads audio via recordedVoiceprints")` (needs models; heavy)
- `renameSpeaker`/`mergeSpeakers`:
  - `it("renameSpeaker live: an unknown id → 404 before blank-name validation")`
  - `it("mergeSpeakers live: unknown → 404")`
- `it("state() while running includes session.name from meta.json; null before it is named")`.
- `it("state() while archived returns library.snapshot")` (done); `it("state() after the archived folder was deleted externally → throws (router 400)")`.
- `it("chatSource: running → live:true with budget; archived → lines from library.transcript; none → ChatError 409 via chat.create")`.
- `it("chatSpent: after a chat reply on an archived recording, a transient cost event with sessionCapUsd is emitted")`.
- `transfer`:
  - `it("transfer.info → {fileName, recordedWith, app, bytes, chats, hasAudio}")`
  - `it("transfer.prepare: 409 while the same session is running; 400 audio:'mp3'; 400 chats:'yes'; ok with audio:'none' → token uuid, file exists in tmpdir")`
  - `it("an export token expires after 15 minutes and the file is removed")` (`vi.useFakeTimers()` then `vi.advanceTimersByTime(15*60_000)`, then await `rm`)
  - `it("exportSent deletes the file and the token; exportSent of an unknown token is a no-op")`
  - `it("importFile while running → 409 before reading the body")`
  - `it("importFile of a non-zip → ApiError 400 'not a recording file…'; the temp upload is discarded")`
  - `it("a kept upload is discarded after 15 minutes; importCopy then → 404")` (fake timers)
  - `it("importCopy: unknown token → 404; name 121 chars → 400; while running → 409")`
- `it("replaySources returns only the existing streams")` (a dir with only remote.wav → 1 source).
- `about`/`engineStale`:
  - `it("about(root) with no LICENSE → license.text ''")`
  - `it("engineStale ignores non-.ts files and returns false on an unreadable dir")`

`bootEngine`/`main` (child process; see §9 for the preload seam):
- `it("serve with HOME=tmp and no keys prints the 'API keys missing' line and listens on --port")`.
- `it("serve --replay with keys missing prints the refusal and stays up")`.
- `it("serve --replay fixtures/conversation --speed max with seeded keys and fake fetch prints 'replaying … as session <id>'")`.
- `it("serve --bogus exits 1")` (parseArgs strict).
- `it("SIGTERM exits 0")`.

---

## 2. `src/server/audio.ts` (123 lines)

- **Exports:**
  - `streamGain(path)` (26): cached per `path|size|mtimeMs` in a module-level `gains` Map that is never evicted.
  - `limit(x)` (53): identity when |x| ≤ 0.85, else a tanh knee below 1.
  - `serveMixedAudio(dir, req, res)` (61).
- **Constants:** `TARGET_DBFS` −12, `MAX_GAIN` 10, `LIMIT_START` 0.85, `HEADER` 44, `CHUNK` 64 KiB.
- **`streamGain`:** takes the RMS of 100 ms blocks every 2 s, uses the 95th percentile, and computes `gain = min(10, max(1, 10^(−12/20)/p95))`. Silent input, or a file under 1600 samples, gives 1.
- **`serveMixedAudio`:**
  - Mixes the host and remote WAVs that exist. None → 404 JSON "this recording has no audio".
  - `dataBytes = max(size−44) & ~1` over the files, so the longer stream sets the length and the shorter one is zero-padded. A new 44-byte header is built.
  - Range regex `^bytes=(\d*)-(\d*)$`:
    - suffix `-N` → the last N bytes
    - `a-` → a to the end
    - `a-b` → b clamped to the total
    - `start>end` or `start>=total` → 416 with `Content-Range: bytes */total`
    - Multi-range or malformed → ignored, 200 full.
  - HEAD → headers only. Backpressure via `res.once("drain", pump)`. fds are closed on `res` "close".
- **Side effects:** sync fs reads, open fds per request.
- **Covered:** mix, padding, limiter, 206 mid-sample, 416 "bytes=99-", gain +18 dB (server.test.ts:104-148); inProcess Range (inProcess.test.ts:70).
- **Not covered:**
  - `it("only remote.wav present → mixes that stream alone")`
  - `it("HEAD → 200 and Content-Length without a body")`
  - `it("suffix range bytes=-4 → the last 4 bytes, 206")`
  - `it("bytes=10-5 → 416")`
  - `it("bytes=-0 → 416")` (start = total)
  - `it("multi-range 'bytes=0-1,4-5' → 200 full")`
  - `it("end beyond total is clamped")`
  - `it("a very quiet stream is capped at MAX_GAIN 10 (+20 dB)")`
  - `it("a silent stream → gain 1")`
  - `it("the gain cache is recomputed when the file's size or mtime changes")`
  - `it("limit is odd-symmetric and continuous at 0.85")`
  - `it("a large file (>64 KiB) streams in chunks; the result equals the in-memory mix")` (drain path)
  - `it("a WAV shorter than 44 bytes → a 44-byte header-only response")`

---

## 3. `src/server/inProcess.ts` (38 lines)

- **Export:** `inProcessHandler(server)` (8) returns `(req: Request) => Promise<Response>`.
- **How it works:**
  - A `duplexPair()` per request, with close propagated both ways (14-15).
  - `server.emit("connection", side)`.
  - The headers are copied, then forced to `host: 127.0.0.1` and `connection: close`, and **any `origin` is deleted**.
  - The request is sent with `http.request({createConnection: () => client})`.
  - The response headers are joined with ", ". Status 204/304 or a HEAD request → a `null` body (the stream is resumed); otherwise `Readable.toWeb(res)`.
  - A request body is piped from `Readable.fromWeb`. A request error → reject.
- **Covered** (`tests/inProcess.test.ts`, which uses a partial engine cast to `EngineApi` and `setup: {status: configured true, save}`):
  - "serves the page and JSON routes"
  - "passes request bodies, and the app's own page may use the setup routes"
  - "streams server-sent events as they happen, and stops listening when the page closes the stream" (checks `bus.subs.size`)
  - "answers Range requests for playback"
  - "each request's stream pair closes when its response ends"
- **Not covered:**
  - `it("HEAD returns a null body with the headers")`
  - `it("a 204 response returns a null body")` (plain createServer)
  - `it("multi-value response headers are joined with ', '")`
  - `it("an Origin from any scheme is stripped, so the router never answers 403 in-process")`
  - `it("a body stream error destroys the outgoing request (rejects)")`
  - `it("an upload (POST /api/sessions/import) passes a binary body intact")` (end-to-end with a real Engine and an exported `.tattle`)

---

## 4. `src/store/sessionStore.ts` (63 lines)

- **Exports:**
  - `JSONL_FILES` (7): utterances, transcriptions, jev_calls, s2_calls, segments, labels, claims, verdicts, s1_versions, audits, events.
  - `type JsonlFile`
  - `timestampId(d = new Date())` (12): local time `YYYYMMDD-HHMMSS`.
  - `class SessionStore` (18).
- **Constructor** `{root?, prefix?, streams?, redact?}`:
  - `root` defaults to `appPaths().sessions`. Collision → `-2`, `-3`, …
  - mkdir -p; creates every `<f>.jsonl` empty; one `WavWriter` per stream (`<s>.wav`).
- **`append(file, row, {afterClose})`**: ignored after `close()` unless `afterClose`; writes `redact(JSON.stringify(row)) + "\n"` synchronously.
- **`writeAudio`**: an unknown stream is a no-op.
- **`writeJson("session.json"|"speakers.json", v)`**: pretty-printed, redacted.
- **`closeAudio()`**: finalises the WAV headers.
- **`close()`**: idempotent.
- **Does not write session.json itself.** Session does. So `smoke-`/`preflight-` folders never become library entries.
- **Covered:** desktop.test "a recording's audio is complete as soon as its input ends…" (closeAudio header size, append after closeAudio). Indirectly by session.test (all JSONL files exist).
- **Not covered:**
  - `it("timestampId formats a fixed local Date")`
  - `it("two stores in the same second get <id> and <id>-2")`
  - `it("prefix is prepended: smoke-<ts>")`
  - `it("append redacts secrets")` (`redact: redactor(["sk-secret-12345678"])`)
  - `it("writeJson redacts and pretty-prints with a trailing newline")`
  - `it("append after close() is dropped; with {afterClose:true} it is written")`
  - `it("close() twice is safe")`
  - `it("writeAudio to a stream not given is ignored")`
  - `it("creates all 11 JSONL files empty")`

---

## 5. `src/store/events.ts` (113 lines)

- **Exports:**
  - `EVENT_SCHEMAS` (8), `EventType`, `EVENT_TYPES` (46), `AppEvent {seq, type, at, data}`
  - `redactor(secrets)` (56): drops secrets shorter than 8 characters or not strings; `split/join` replace with "[redacted]".
  - `processSecrets()` (62)
  - `class EventBus` (67)
- **`emit(type, data, {transient})`**:
  - Unknown type → throws `Error("unknown event type X")`.
  - Schema failure → `onInvalid(type, prettified)`, but it **still emits**.
  - Redact via a JSON round trip, so `undefined` fields are dropped.
  - `seq` is incremented.
  - Kept in history unless transient.
  - Subscribers are called in try/catch.
- **`history()`**: a copy. **`subscribe`** returns an unsubscribe function.
- **`reset()`**: clears the history but **not `seq`**; subscribers stay.
- **`load(events)`**: replaces the history, sets `seq = max(e.seq ?? 0)`, and notifies subscribers of each event.
- **Covered:** indirectly (server SSE, library reopen, session redaction).
- **Not covered:**
  - `it("emit of an unknown type throws")`
  - `it("an invalid payload calls onInvalid and still emits")`
  - `it("transient events reach subscribers but not history")`
  - `it("a throwing subscriber does not stop others")`
  - `it("unsubscribe stops delivery")`
  - `it("reset keeps subscribers and seq continues increasing")`
  - `it("load sets seq to the max loaded seq; the next emit is max+1")`
  - `it("load notifies subscribers in order")`
  - `it("redactor ignores secrets shorter than 8 chars and non-strings")`
  - `it("processSecrets picks up an env key changed after creation")`
  - `it("redact replaces every occurrence, including inside nested data")`
  - `it("every EVENT_TYPES entry accepts a minimal valid payload")` (table-driven)

---

## 6. `src/store/library.ts` (332 lines)

- **Constants:**
  - `TOOL_PREFIXES` smoke-/preflight-/dev- (7)
  - `COST_KINDS` (8)
  - `COST_FILES` (10): transcription → transcriptions.jsonl, jev → jev_calls, s2 → s2_calls, chat → chats
  - `SAFE_ID` `^[A-Za-z0-9][A-Za-z0-9_-]*$` (82)
  - `SESSION_EVENTS` (84)
- **Exports:**
  - `CostBreakdown`, `SessionMeta`, `SessionSummary` (15-39), `SearchMatch`, `RecordedSpeakers`
  - `resolveRecorded(sp, id)` (68): follows merges, at most 50 hops (cycle guard)
  - `class SessionLibrary(root = appPaths().sessions)` (87)
- **Methods:**
  - `dirOf(id)` (92): unsafe → Error "invalid session id X"; no session.json → "unknown session X".
  - `load(id)` (private, 99): the cache key is the max mtime of events.jsonl, meta.json, speakers.json and chats.jsonl.
    - `ended` means a `session.ended` event exists.
    - `speakers` come from speakers.json (non-merged displayNames), else from speaker events.
    - `durationMs` is the max over WAVs of `(size−44)/32000*1000`. Without audio it is the imported manifest's `durationMs`, else the max utterance `endMs`.
    - `cost` sums the buckets over COST_KINDS rows.
    - `tool` comes from the prefix.
    - `appVersion` is `session.app.version ?? imported.manifest.recording.recordedWith`.
    - `imported` is `{at, exportedWith, fileName}`.
  - `ids()` (158): folders with a safe name and session.json, so `.import-*` is ignored.
  - `list({q, includeTools, limit})` (164):
    - An unreadable folder is logged and skipped.
    - Tools are hidden.
    - `q`: lowercase words. It is a match if **all** words are in name+notes+id+speakers, or all words are in **one** utterance.
    - Up to 5 matches `{utteranceId, startMs, speaker (current name), snippet}`, where the snippet is 50 characters before the first word through i+90, with ellipses.
    - Sorted by `(startedAt ?? id)` descending; `limit` slices.
  - `get(id)` (204)
  - `update(id, patch)` (210): only name and notes. Not a string → Error "<k> must be a string". Trimmed name > 120 or notes > 4000 → "<k> is too long". Empty → delete. Writes meta.json and drops the cache.
  - `events(id)` (228): rewrites `sessionId` (and `dir` if present) of session.* events whose sessionId ≠ id.
  - `speakers(id)` (239)
  - `recordSpeakerEdit(id, e)` (248): appends the event to events.jsonl. If speakers.json is an array it applies the rename, or the merge (`mergedInto`, and adds utterance counts).
  - `transcript(id)` (272): skips fillers and blank lines; current names.
  - `voicesOf(id)` (285)
  - `calls(id, system, limit=300)` (294): `rows.slice(-max(1,limit))`; models from session.json config (null if absent).
  - `remove(id)` (305): if `costUsd>0 && !imported`, appends `{kind:"deleted_session", session_id, deleted_at, cost_usd}` to `<root>/deleted-spend.jsonl`, then `rm -rf`.
  - `snapshot(id)` (317):
    - `session`: `{id, mode, status:"archived", dir, startedAt, streams, name, hasAudio, appVersion, imported, features: {factcheck: !==false, labels: !==false}}`
    - `labels` only if `session.labelSet`
    - `s1: {active: s1Version ?? "s1@1", versions: [], memory: []}`
    - `cost: {...cost, session: costUsd, sessionCapUsd: config.budget.sessionCapUsd ?? 5}`
    - `archived: true`
- **Side effects:** reads everything synchronously on each call; writes meta.json, events.jsonl, speakers.json and deleted-spend.jsonl; rm -rf.
- **Covered** (`tests/library.test.ts`, builder `makeSession(root, id, {mode, startedAt, lines, cost, ended})` at 11-28 and `fixture()` at 30-36):
  - "lists recordings newest first, hiding tool runs, with summaries"
  - "chats count in a recording's cost, by bucket…"
  - "names and notes go to meta.json; empty clears"
  - "search matches names and transcript text…"
  - "the engine reopens a recording read-only…"
  - "speakers can be renamed and merged on a reopened recording…"
  - "a recording that cannot be read is skipped…"
  - Also covered: transfer.test "a copy imported before its ids were rewritten still opens as itself" (`events()` rewrite); session.test (remove plus deleted-spend via `sumDevSpend`).
- **Not covered:**
  - `it("search: words split across name and a transcript line do NOT match")`
  - `it("search: max 5 matches per recording")`
  - `it("snippet: leading … when the match is beyond 50 chars, trailing … when text continues past i+90")`
  - `it("search is case-insensitive, and a meta-only match returns matches: []")`
  - `it("list({limit:1}) returns one")`
  - `it("list skips folders without session.json, names starting with '.', and unsafe names")`
  - `it("list sorts a recording without startedAt by id")` (see smell §11.9)
  - `it("summary: speakers from speakers.json exclude mergedInto entries")`
  - `it("summary: hasAudio false → durationMs from imported manifest; else last utterance endMs")`
  - `it("summary: durationMs is the max of host/remote WAV sizes")`
  - `it("summary: cost ignores rows whose kind is not in COST_KINDS or with a non-number cost_usd")`
  - `it("summary: transcription and s2 buckets are summed from their files")`
  - `it("summary: mode other than live/replay → 'unknown'")`
  - `it("summary: appVersion from session.app.version, else imported.manifest.recording.recordedWith")`
  - `it("cache: a rewrite of meta.json with a new mtime refreshes the summary")`
  - `it("readJsonl tolerates a torn last line")`
  - `it("update: non-string name → error 'name must be a string'; notes 4001 chars → too long; whitespace-only name clears")`
  - `it("events(): session.* events with another sessionId get this id and this dir; other events untouched")`
  - `it("recordSpeakerEdit without speakers.json only appends the event")`
  - `it("recordSpeakerEdit merge sums utterances")` (partly covered)
  - `it("transcript skips filler and blank-text utterances and applies current names")`
  - `it("voicesOf returns null voices for old recordings")`
  - `it("calls: limit trims to the last N rows; limit 0 → 1 row; models null without config")`
  - `it("remove: a zero-cost recording appends nothing; an imported recording appends nothing")`
  - `it("snapshot: features default true; features.factcheck:false preserved; labels undefined without labelSet; sessionCapUsd default 5; s1.active default s1@1")`
  - `it("resolveRecorded stops on a merge cycle")` (a→b, b→a)

---

## 7. `src/store/transfer.ts` (313 lines)

- **Constants:**
  - `EXTENSION ".tattle"`, `FORMAT "tattle-recording"`, `LEGACY_FORMATS` (podcast-assistant-recording, conversation-assistant-recording), `FORMAT_VERSION 1`
  - `AAC_BITRATE 32000`
  - `DATA_FILES` = session.json, meta.json, speakers.json and the 11 JSONL files
  - `MAX_DATA_BYTES` 256 MiB, `MAX_DATA_TOTAL` 512 MiB, `MAX_PAD_BYTES` 32,000, `MAX_AUDIO_BYTES` 4 GiB−1, `MAX_UPLOAD_BYTES` 4 GiB (307)
- **Exports:** `Manifest` (40), `TransferError(status, msg)` (56), `exportFileName` (67), `exportEstimate` (73), `exportRecording` (94), `importRecording` (198), `saveUpload` (287), `MAX_UPLOAD_BYTES`, `discard` (310). Private: `canonicalWav` (153).
- **`exportFileName(name, id)`**: replaces `[\\/:*?"<>|\x00-\x1f]+` with a space, collapses whitespace, trims, keeps 80 characters; empty → `Recording <id>` + ".tattle".
- **`exportEstimate(dir)`**:
  - `packed = round(dataBytes/5)+4096`
  - `compressed = packed + round(seconds*32000/8*1.02)`
  - `original = packed + wav sizes`
  - `none = packed`
  - `chats` = distinct `chat_id` of `{kind:"chat", op:"create"}` rows
  - `hasAudio`
- **`exportRecording(dir, id, {audio, chats, app, outDir?})`**:
  - No session.json → TransferError 404.
  - `mkdtemp(outDir ?? tmpdir, "pa-export-")`.
  - Data entries `data/<f>` (deflated); chats.jsonl only if `chats`.
  - Audio "original" → stored `audio/<s>.wav`. "compressed" → `afconvert -f m4af -d aac -b 32000 -c 1` (env without keys) → stored `audio/<s>.m4a`; failure → TransferError 500. "none" → no streams.
  - `durationMs` = max samples/16, or with no WAVs the last `"endMs":N` in events.jsonl (a regex). **Throws ENOENT if events.jsonl is missing.**
  - The manifest comes first. The output is `(outDir ?? tmpdir)/pa-<id>-<Date.now()>.tattle` → `{path, fileName, bytes}`. The work dir is always removed.
- **`canonicalWav(src, dest, samples)`**:
  - Scans the RIFF chunks within the first 64 KiB.
  - `fmt` must be 1 channel, 16 kHz, 16-bit, else 400 "unexpected audio format after decoding".
  - No `data` chunk → 400 "no audio data after decoding".
  - `want = samples===null ? dataLen : min(samples*2, dataLen+32000)`.
  - Writes a 44-byte header plus data, zero-padded.
- **`importRecording(file, root, originalName, {copy})`** checks and errors, in order:
  1. `readZipEntries` fails → 400 (`"<ZipError msg>. Is it a .tattle file?"` or `String(e)`).
  2. No manifest.json → 400 "not a Tattle recording (no manifest.json)…".
  3. Unparsable manifest (read limit 1 MiB) → 400 "the recording's manifest is damaged".
  4. `format` not tattle/legacy → 400 "not a Tattle recording".
  5. `formatVersion` not ≥1 or >1 → 400 "…exported by a newer Tattle (v<app.version ?? ?>)…".
  6. No data/session.json or data/events.jsonl → 400 "the recording is incomplete…".
  7. session.json is parsed (limit 16 MiB; **a JSON error is not wrapped**).

  Then the import itself:
  - `baseId` = manifest.recording.id if safe, else `timestampId()`.
  - Unless `copy`: an existing `<root>/<baseId>/session.json` with the same `startedAt` → throw `TransferError 409 "this recording is already in your library"` with `.id = baseId`.
  - `id` = baseId, else `-2`, `-3`, … (checks folder existence).
  - `mkdir root`; `mkdtemp(root/.import-)`.
  - Data files: `e.size > remaining budget` → 400 "the recording's data is too large"; read with limit `min(256 MiB, budget)`.
  - If `id !== recordedId` (session.id ?? manifest.recording.id): rewrite session.json `id`, and in events.jsonl textually replace `"sessionId":"<old>"` with `"sessionId":"<new>"`.
  - Create any missing JSONL files empty.
  - Audio per stream:
    - `declared` samples come from manifest.audio.streams (a safe integer ≥0, else null).
    - A wav entry larger than 4 GiB−1 → 400 "the audio is too large". Otherwise `extractStoredEntry` → canonicalWav → rm the orig.
    - An m4a entry → extract → `afconvert -f WAVE -d LEI16@16000 -c 1` (500 on failure) → canonicalWav → rm the temporaries.
  - Write imported.json `{importedAt, fileName, originalId, manifest}`.
  - `rename(work, root/id)`. Any error → rm the work dir and rethrow.
- **`saveUpload(body, max)`**: `mkdtemp(tmpdir, "pa-import-")/upload.tattle`; more than max → 413 "the file is too large (4 GB at most)", and the dir is removed.
- **`discard(path)`**: `rm -rf dirname(path)`, errors swallowed.
- **Side effects:** tmpdir files; `afconvert` child processes (macOS only, env without API keys); writes under root.
- **Covered** (`tests/transfer.test.ts`, builders `tone(seconds, hz)` 17-22 and `recording(root, id)` 24-39; `hasAfconvert` gates the compressed test):
  - "a file name that is safe everywhere"
  - "compressed audio: exports small, imports with the same length, and carries the versions"
  - "original audio is byte-exact; no audio still imports, without playback; chats come only when included": also covers a different recording with the same id → `-2`
  - "the same recording again can be imported as a named copy, from the same upload" (Engine)
  - "a copy imported before its ids were rewritten still opens as itself"
  - "imports a recording exported under an earlier name (%s)" ×2
  - "refuses what is not a recording, or is from a newer format; ignores unknown entries" (path traversal entries ignored)
  - "a crafted manifest cannot make an import write gigabytes of silence"
- **Not covered:**
  - `it("exportFileName: control chars and long names → 80 chars max; whitespace-only name → Recording <id>")`
  - `it("exportEstimate: no WAVs → hasAudio false, compressed === none; chats counts distinct creates, ignoring torn lines")`
  - `it("exportRecording: no session.json → TransferError 404")`
  - `it("exportRecording: audio 'none' → manifest.audio {format:null, bitrate:null, streams:[]}")`
  - `it("exportRecording: no WAVs → durationMs from the last endMs in events.jsonl")`
  - `it("exportRecording: missing events.jsonl → throws ENOENT")` (documents smell §11.6)
  - `it("exportRecording: outDir is honoured and the work dir is removed")`
  - `it("exportRecording: afconvert failure → TransferError 500")` (point PATH at a failing `afconvert` stub via `process.env.PATH`; `childEnv` copies `process.env`)
  - `it("exportRecording compressed: manifest.audio {format:'aac', bitrate:32000}, per-stream samples")`
  - `it("importRecording: no manifest.json → 400")`
  - `it("importRecording: manifest not JSON → 400 damaged")`
  - `it("importRecording: format 'other' → 400 not a Tattle recording")`
  - `it("importRecording: formatVersion 0 / missing → 400 newer message with v?")`
  - `it("importRecording: no data/events.jsonl → 400 incomplete")`
  - `it("importRecording: manifest.recording.id unsafe ('../x') → id from timestampId()")`
  - `it("importRecording: third import of distinct recordings with the same id → -3")`
  - `it("importRecording: copy:true with the same startedAt → -2 and session.json.id + events sessionId rewritten")` (partly via Engine)
  - `it("importRecording: missing JSONL files are created empty")`
  - `it("importRecording: imported.json holds {importedAt, fileName, originalId, manifest}")`
  - `it("importRecording: data entries larger than MAX_DATA_TOTAL → 400 data too large")` (craft a ZIP whose central directory *claims* a large size; use a custom writer)
  - `it("importRecording: a failure mid-way removes the .import-* folder")`
  - `it("importRecording: wav with 8 kHz fmt → 400 unexpected audio format")`
  - `it("importRecording: wav without a data chunk → 400 no audio data")`
  - `it("importRecording: declared samples shorter than the data → trimmed; declared samples null → dataLen kept")`
  - `it("importRecording: session.json in the zip not JSON → rejects")` (raw SyntaxError; router 400)
  - `it("saveUpload over maxBytes → 413 and the temp dir removed")`
  - `it("discard removes the file's parent folder and never throws")`
  - `it("two recordings both without startedAt and the same id are treated as the same → 409")` (smell §11.7)

---

## 8. `src/store/zip.ts` (204 lines)

- **Exports:**
  - `ZipInput {name, path?|data?}`, `ZipEntry`
  - `writeZip(out, entries, now = new Date())` (29): `data` entries are deflated (method 8, level 6); `path` entries are stored (method 0) with a CRC pre-pass; UTF-8 flag 0x0800; DOS time with the year clamped to 1980 or later; throws if a size or offset is over 0xffffffff or there are more than 0xffff entries.
  - `ZipError` (119)
  - `readZipEntries(path)` (122): EOCD search in the last 22+65535 bytes. Errors: "not a recording file (no ZIP directory)"; `cdOffset+cdSize > size` → "the file is truncated"; bad central signature → "the ZIP directory is damaged".
  - `readZipEntry(path, e, maxBytes)` (162): `e.size > max` → "<name> is larger than expected"; bad local signature → "damaged entry"; `compressedSize > max` or it extends past the end of the file → "damaged entry"; methods 0/8 only, else "unsupported compression"; length/CRC mismatch → "is damaged (checksum)". Inflate is async with `maxOutputLength`.
  - `extractStoredEntry(path, e, dest)` (184): method ≠ 0 → error; a short read → "is truncated"; CRC mismatch → "damaged (checksum)".
- **Covered:** transfer.test "round trip: deflated data and stored files, with UTF-8 names and checksums" (plus the system `unzip -l`); the no-ZIP-directory case via "refuses what is not a recording".
- **Not covered:**
  - `it("dosTime clamps years before 1980")` (`writeZip(out, [..], new Date("1970-01-01"))`, then read the central date bits)
  - `it("readZipEntries: truncated file (cdOffset beyond EOF) → 'the file is truncated'")`
  - `it("readZipEntries: a corrupted central signature → 'the ZIP directory is damaged'")`
  - `it("readZipEntry: a corrupted local header → 'damaged entry'")`
  - `it("readZipEntry: compressedSize bigger than maxBytes → damaged entry")`
  - `it("readZipEntry: method 12 → unsupported compression")` (patch the bytes of a written zip)
  - `it("readZipEntry: flipped data byte → checksum error")`
  - `it("readZipEntry: a stored entry read via readZipEntry works (method 0)")`
  - `it("extractStoredEntry: a deflated entry → 'expected an uncompressed entry'")`
  - `it("extractStoredEntry: CRC mismatch → damaged")`
  - `it("extractStoredEntry: truncated → is truncated")`
  - `it("writeZip returns the file size in bytes")`
  - `it("writeZip with 65536 entries throws 'the export is too large'")` (maybe slow; UNSURE of runtime)
  - `it("an entry with a comment/extra field in the central directory is parsed")` (craft by hand)

---

## 9. CLIs (`src/cli/**`) and `npm run serve`

General rules:
- No CLI exposes `main(argv, deps)`.
- `calibrateBoundary.ts` and `calibrateSpeakers.ts` export pure functions and guard their `main` with `import.meta.url === \`file://${process.argv[1]}\``.
- `replay.ts`, `smoke.ts` and `preflight.ts` are **top-level scripts**: importing them runs them.

**A seam with no production change, for child-process CLI tests:**

`node --import tsx --import ./tests/cli/preload.ts src/cli/<x>.ts …`

The preload (same module instances, since the ESM cache is keyed by URL) does four things:
- `globalThis.fetch = fakeFetch` (from session.test's fakeFetch, plus key/models routes)
- `globalThis.WebSocket = FakeRealtimeSocket` (or a throwing class)
- `setAppPaths({sessions: process.env.E2E_SESSIONS, helper: <fake or nonexistent>, src: null})`
- optionally `process.on("exit")` bookkeeping

The child environment is also locked down:
- `HOME=<tmp>` isolates `migrateAppSupportDir` and the default credentials path.
- `TATTLE_CREDENTIALS=<tmp>/credentials.json`.
- **Fake `OPENAI_API_KEY`/`OPENROUTER_API_KEY` strings, or none.**
- **Never go through `npm run …`**, because it loads `.env` with the real keys. With no real key reachable, a failed preload cannot spend money: a real call would get a 401.

This works because the Session's `realServices` takes `this.opts.fetch ?? fetch` at construction (session.ts:241), after the preload ran, and `live.ts:78` resolves `WebSocket` at call time. The CLIs read fixtures cwd-relative, so run them from the project root.

### 9.1 `calibrateBoundary.ts` (57 lines)

- **Exports:** `BoundaryRow`, `ThresholdScore`, `parseRows(text)` (8; throws "row N: boundary_p must be a number"), `scoreThresholds(rows, thresholds=[0.3…0.9])` (16; only boolean `human_boundary` rows count), `best(scores)` (33; highest F1, the first wins ties; **throws a TypeError on an empty array**).
- **Main** (37-57):
  - No argument → usage on stderr, exit 1.
  - No labelled rows → "no row has human_boundary set…", exit 1.
  - Otherwise prints a table and "best threshold: X (F1 Y)…", exit 0 implicitly.
  - A parse error → an uncaught throw → exit 1 with a stack.
- **Side effects:** reads the file. Offline and free.
- **Covered** (`tests/stats.test.ts`): "precision, recall, and F1 per threshold"; "the CLI runs on a labelled sample of 20 rows" (`execFileSync(process.execPath, ["--import","tsx","src/cli/calibrateBoundary.ts", f])`).
- **Not covered:**
  - `it("parseRows throws 'row 2: boundary_p must be a number'")`
  - `it("parseRows skips blank lines")`
  - `it("scoreThresholds: no positives → precision/recall/f1 0")`
  - `it("scoreThresholds with custom thresholds")`
  - `it("best of equal F1s keeps the first")`
  - `it("best([]) throws")`
  - `it("CLI with no argument exits 1 with usage")`
  - `it("CLI with only unlabelled rows exits 1")`
  - `it("CLI with a malformed row exits non-zero")`

### 9.2 `calibrateSpeakers.ts` (45 lines)

- **Export:** `speakerCounts(host?, remote?, thresholds, limits={})` (10). It loads the config, runs `FileSource` at max speed through `StreamVad` (Silero), then `Embedder` (WeSpeaker), then a `SpeakerRegistry` per threshold → `{utterances, rows:[{threshold, speakers}]}`.
- **Main** (32-45):
  - Arguments `--host`, `--remote`, `--voices`. Neither host nor remote → usage, exit 1.
  - Thresholds 0.35…0.75 step 0.05 (9 values).
  - `--voices n` → limits `{host:1, remote:Number(n)}`. NaN is not validated.
- **Side effects:** local models only, no network, free, but CPU-heavy (seconds).
- **Covered:** none.
- **Not covered:**
  - `it("speakerCounts on the fixture returns 9 rows with non-increasing speaker counts as the threshold falls")` (UNSURE about monotonicity; assert `rows.length === 9` and `utterances > 0`; `requireAssets()`)
  - `it("speakerCounts with limits {host:1, remote:2} caps active speakers at 3")`
  - `it("host only works (remote undefined)")`
  - `it("CLI with no --host/--remote exits 1")`
  - `it("CLI --voices abc prints 'NaN on the call'")` (documents missing validation)

### 9.3 `preflight.ts` (116 lines): LIVE, never run for real in tests

Everything is top-level with top-level await. Module state: `failures` (18), `report` (19), `check` (23).

| Check | Line | What it does |
|---|---|---|
| models present | 31 | `vadModelPath`/`speakerModelPath` exist |
| capture helper built and has both permissions | 37 | `existsSync(appPaths().helper)`, else FAIL before spawning. **Spawns `sh -c "sleep 0.8; afplay Ping.aiff ×2"`** and `execFile(helper, ["--probe","3"], {timeout: 40s})`. Needs a remote peak above −40 dBFS and a host peak above −100 |
| keys are set | 50 | `new KeyStore().load()` |
| config is valid | 58 | `loadConfig()` sets the module-level `cfg` |
| OpenRouter key limit and remaining credit | 63 | **global fetch** `https://openrouter.ai/api/v1/key`; FAIL if `limit_remaining < sessionCapUsd` |
| transcription call | 81 | only if `cfg` is set: creates `SessionStore({prefix: "preflight-"})` in `appPaths().sessions` and a `Budget` without the dev cap; reads `fixtures/conversation/remote.wav` (cwd-relative), samples 8–15 s |
| Jev call | 90 | the model must start with "typesafe/jev-1.13" |
| System 2 research | 99 | |
| free disk | 108 | `statfsSync(".")` at least 2 GB |

It ends with "PREFLIGHT PASS", exit 0, or "PREFLIGHT FAIL (n)", exit 1. It costs about $0.01–0.02 (header says ~$0.02).

**Testability:**
- Without refactoring: a child process with the preload (fake fetch), `setAppPaths({helper: "/nonexistent", sessions: tmp})` and `TATTLE_CREDENTIALS` seeded. Expect "FAIL  capture helper…", "PASS  keys are set", "PASS  transcription call", exit 1.
- The disk check reads the real disk.
- **Needed refactor** (optional): wrap lines 31-116 in `export async function preflight(deps: {fetch, keys, helperProbe, statfs, fixturePath, sessionsRoot, log})` and move the module-level `failures`/`cfg` inside. The exact lines are 18-29 (state and helpers) and 31-116 (checks).

### 9.4 `replay.ts` (59 lines): spends money for real, fake-able

Top-level:
- `parseArgs` at 9-14: `--host`, `--remote`, `--speed` (default "max"; only "1" means real time), `--export <file>`, `--allow-over-dev-cap`, `--quiet`.
- Neither host nor remote → usage, exit 1 (15-18). This happens **before `loadKeys()`**, so it is safe to test for real.
- `loadKeys()` (19).
- A bus subscriber pretty-prints events unless `--quiet` (26-40).
- `new Session({mode:"replay", sources, config: loadConfig(), bus, allowOverDevCap, exportBoundary})` (42). **There is no fetch, services or sessionsDir injection**, so it uses `appPaths().sessions`, i.e. the project's `sessions/`.
- SIGINT → `session.stop()`; `await session.run()`; prints a summary; **always `process.exit(0)`** (59), even if the budget was exhausted.
- The dev cap is enforced unless `--allow-over-dev-cap`, because `enforceDevCap = mode !== "live" && !allow`.

Test plan:
- `it("exits 1 with usage when neither --host nor --remote")` (safe).
- Other cases need the preload with a fake fetch and sessions redirected:
  - `it("--speed max --export out.jsonl writes boundary rows {utterance_id, speaker, text, boundary_p, human_boundary:null}")`
  - `it("--quiet prints only the summary")`
  - `it("with ≥$3 already in sessions/*.jsonl, a replay emits budget.exhausted cap dev and still exits 0")`
  - `it("--allow-over-dev-cap lifts it")`
- **Seam for in-process tests:** extract lines 9-59 into `export async function runReplay(argv, deps: {fetch?, sessionsDir?, log?})` and guard it with import.meta.

### 9.5 `smoke.ts` (174 lines): LIVE, about $0.05–0.30. Must never run against real services in tests.

Top-level:
- `parseArgs` `--checks 1,2,4`, `--allow-over-dev-cap`.
- `loadKeys()`.
- `SessionStore({prefix:"smoke-"})` in `appPaths().sessions`.
- `Budget({enforceDevCap: !allow, devSpentUsd: sumDevSpend()})`.
- Clients use the **global fetch**.
- Reads `fixtures/conversation/script.json` and `remote.wav` (cwd-relative).

| Check | What it does |
|---|---|
| 1 | transcribe the first Daniel line; the text must contain "Jev" |
| 2 | the Jev per-utterance answers are typed; the model starts with typesafe/jev-1.13 |
| 3 | segment labels (`timelineQuestions`) |
| 4 | 50 latency calls; FAIL if more than 2 timeouts or p95 > 1500 ms; on failure, reruns with 20 known questions |
| 5 | S2 research with exa, plus the native engine |
| 6 | audit and rewrite |

Exit 0 iff every check passed and the session total is ≤ $0.50; otherwise exit 1.

Testability: only with the preload fake fetch and fake keys. The dev cap would otherwise use the real `sessions/` spend, so also redirect sessions. Even then, check 4 does 50 calls: fast with a fake. Recommendation: at most one test, `it("smoke with a fake fetch passes checks 1,2,3,5,6 and exits 0")`, marked in the spec as optional. **Guard:** the test must assert that `OPENAI_API_KEY`/`OPENROUTER_API_KEY` in the child env are fake and that `HOME`/`TATTLE_CREDENTIALS` point to tmp before spawning. Seam to refactor: lines 17-174 → `export async function smoke(argv, deps)`.

### 9.6 `npm run serve` = `src/server/main.ts` `main()`

See §1.5. The child-process tests in §1.7 use the same preload plus `HOME=tmp`. Keep `--port` fixed, because the log prints the requested port.

---

## 10. END-TO-END HARNESS DESIGN (Playwright against the real engine and page, no network, no Swift helper)

### 10.1 What exists today (no production change needed)

1. **`Engine` constructor options** (main.ts:126):
   - `config` (e.g. to set `transcription.live.enabled=false` or smaller caps)
   - `sessionsDir` (library root, Session store root and `sumDevSpend` root)
   - `allowOverDevCap`
   - `session: Partial<SessionOptions>` (spread last into every Session): `{fetch, keys, services, liveConnect, statsIntervalMs, retryEveryMs, embedder}`
   - `live(mic, onStatus)` (a fake capture)
   - `devices()`
   - `fetch` (chat, OpenRouter)
   - `openrouterKey`
2. **`createApiServer(engine, {webRoot, setup})`** (675) serves the real page (`web/index.html`, `web/dist/*.js` compiled by `npm run build:web`, `web/fonts`, `web/styles.css`).
3. **`KeyStore({path, env})` and `KeySetup(store, {fetch, models})`** drive the setup screen.
4. **`setAppPaths()`** for `sessions`, `helper`, `src: null` (no restart banner), `web`, `config`, `models`.
5. **`TATTLE_CREDENTIALS`** and **`HOME`** isolate the credentials and `migrateAppSupportDir`.
6. **Global `fetch`/`WebSocket` are resolved late**, so a preload can replace them even for `bootEngine`.

### 10.2 Option A (recommended primary): `tests/e2e/harness-server.ts`, composed in process

Run with `node --import tsx tests/e2e/harness-server.ts` from the **project root** (config, models and fixtures are cwd-relative).

```ts
// shape only
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { dirname, join, resolve } from "node:path";
import { setAppPaths } from "../../src/paths.ts";
import { loadConfig } from "../../src/config.ts";
import { Engine, createApiServer } from "../../src/server/main.ts";
import { KeySetup, KeyStore } from "../../src/keys.ts";
import { FileSource } from "../../src/audio/source.ts";
import { servicesFetch, chatFetch, keyCheckFetch, FakeRealtimeSocket } from "../fakes/index.ts"; // moved from session/chat/keys/live tests

globalThis.fetch = (() => { throw new Error("network disabled in E2E"); }) as typeof fetch;             // belt and braces
(globalThis as any).WebSocket = class { constructor() { throw new Error("network disabled in E2E"); } };
delete process.env.OPENAI_API_KEY; delete process.env.OPENROUTER_API_KEY;                               // never inherit real keys

const tmp = process.env.E2E_TMP ?? mkdtempSync(join(tmpdir(), "tattle-e2e-"));
const sessions = join(tmp, "sessions"); mkdirSync(sessions, { recursive: true });
setAppPaths({ sessions, src: null, helper: join(tmp, "no-helper") });   // src:null → /api/engine stale:false
const credPath = join(tmp, "Tattle", "credentials.json");
if (process.env.E2E_KEYS !== "missing") {                               // pre-seed → page skips the setup screen
  mkdirSync(dirname(credPath), { recursive: true, mode: 0o700 });
  writeFileSync(credPath, JSON.stringify({ OPENAI_API_KEY: "sk-proj-e2e-000000000000000000", OPENROUTER_API_KEY: "sk-or-v1-e2e-0000000000000000" }), { mode: 0o600 });
}
const keys = new KeyStore({ path: credPath }).load();                   // env = process.env, so Session/chat/redaction see the fake keys
const config = loadConfig();
if (process.env.E2E_LIVE_TEXT === "off") config.app.transcription.live!.enabled = false;
const setup = new KeySetup(keys, { fetch: keyCheckFetch, models: [config.app.transcription.model, config.app.transcription.live!.model] });
const FIX = resolve("fixtures/conversation");
const engine = new Engine({
  config, sessionsDir: sessions, allowOverDevCap: process.env.E2E_OVER_CAP === "1",
  session: { fetch: servicesFetch(), liveConnect: (url, h) => new FakeRealtimeSocket(url, h), statsIntervalMs: 2000 },
  fetch: chatFetch(), openrouterKey: undefined,                          // falls back to env (fake)
  live: async (_mic, onStatus) => {
    onStatus("health", { capture: { type: "started", epochMs: Date.now(), host: { device: "MacBook Pro Microphone" }, remote: { outputKind: "headphones", outputDevice: "AirPods Pro" } } });
    return { sources: [new FileSource(`${FIX}/host.wav`, "host", 1), new FileSource(`${FIX}/remote.wav`, "remote", 1)], stop: async () => {} };
  },
  devices: async () => [{ uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", transport: "builtin", isDefault: true }],
});
const server = createApiServer(engine, { webRoot: resolve("web"), setup });
const port = Number(process.env.E2E_PORT ?? 0);
server.listen(port, "127.0.0.1", async () => {
  const bound = (server.address() as import("node:net").AddressInfo).port;
  if (process.env.E2E_REPLAY) await engine.start({ mode: "replay", dir: process.env.E2E_REPLAY, speed: (process.env.E2E_SPEED as "max") ?? "max" });
  console.log(`E2E_READY http://127.0.0.1:${bound}`);                   // Playwright fixture parses this
});
process.on("SIGTERM", async () => { if (engine.current?.status === "running") await engine.stop().catch(() => {}); process.exit(0); });
```

Notes and constraints:
- **Bind and URL.** The server must listen on `127.0.0.1`. Playwright's `baseURL` must be `http://127.0.0.1:<port>`; do not use `localhost` unless every request uses it. The router enforces Host ∈ {127.0.0.1, localhost}[:port] and **Origin === `http://<Host>`**, and a mismatch is a 403 even for the page.
- **Port.** Either a fixed `E2E_PORT` (Playwright `webServer: {command, url: "http://127.0.0.1:4399/api/about"}`), or `0` with a worker-scoped fixture that spawns the harness and parses `E2E_READY`. `/api/about` is a good readiness URL: it is open even before keys are set.
- **Engine state is global.** There is one session at a time, and the SSE history resets per session. Use Playwright `workers: 1` with a fresh harness per test file, or a harness per worker on port 0. There is **no production reset route**. Resetting means restarting the process, or calling `POST /api/sessions/close` and deleting recordings through the API.
- **Build the page first.** Run `npm run build:web` (`tsc -p web/tsconfig.json`) as the webServer command prefix or in `globalSetup`. `web/dist/` exists today but may be stale.
- **Keys and the setup screen.**
  - `E2E_KEYS=missing` gives `setup.status().configured === false`. The page shows the setup screen, and every other `/api/*` answers 503.
  - With `keyCheckFetch` (tests/keys.test.ts:16 style) answering 200 for `api.openai.com/v1/models` (with `gpt-transcribe` and `gpt-live-transcribe` in `data`) and `{data:{limit:10, limit_remaining:9.5}}` for `openrouter.ai/api/v1/key`, typing two well-formed keys (OpenAI `sk-proj-…` ≥20 chars, OpenRouter `sk-or-v1-…`) saves them to `credPath` and `process.env` and the page loads the app.
  - Fake 401 answers give the "refused" state.
  - Keys need no restart: the Session reads `process.env` at construction and the chat reads it per call.
- **Replayed fixture conversation.**
  - `E2E_REPLAY=fixtures/conversation E2E_SPEED=max` starts a replay at boot. The UI replay popover can also post `{mode:"replay", dir:"fixtures/conversation", speed:"max"}`.
  - `servicesFetch` should be `fakeFetch(loadScript())` from tests/session.test.ts:23. **Drop its "echo key once" 400 branch**, or E2E will show one Jev error.
  - At `speed: "max"` the whole 77.8 s fixture runs in a few seconds (session.test runs take about 3–6 s each). It yields 3 flagged claims, 1 repeat, ≥2 segments and 3 speakers. After `session.ended` the engine archives it (`state().session.status === "archived"`).
  - `speed: 1` (real time, 78 s) also enables live text over the fake realtime socket. It needs a `FakeRealtimeSocket` that answers `session.update` with `session.updated` and emits `conversation.item.input_audio_transcription.delta/completed` (UNSURE of the exact event names: read `src/transcribe/live.ts` and `tests/live.test.ts`). The alternative is `E2E_LIVE_TEXT=off`.
- **"Start live" without the Swift helper.** The `live` option above gives two FileSources at speed 1. The page's Start live button works, and Pause, Resume and Stop go through `Engine.pause/resume/stop`. The echo gate follows `onStatus` health (`outputKind`).
- **Chat.** `chatFetch` = `fakeOpenRouter()` from tests/chat.test.ts:46. It must answer `MODELS_URL` with a catalogue containing `openai/gpt-6-luna` (config's `defaultModel`) and chat/completions with a streamed SSE body including final `usage.cost`. That avoids the `GENERATION_URL` fallback; otherwise also answer `/api/v1/generation`.
- **Export and import.** `audio:"compressed"` needs macOS `afconvert`. E2E on Linux CI should use `"original"`/`"none"`. Downloads go to `os.tmpdir()`, so set `TMPDIR` for isolation. Upload through Playwright `setInputFiles` on the import input or a drop.
- **Seeding the library** (the Recordings window, search, rename, delete, open, playback): either run one max-speed replay at boot (real pipeline and fakes, about 5 s), or write folders directly using the `makeSession` builder from tests/library.test.ts:11 (session.json, events.jsonl, jev_calls.jsonl, host.wav) into `sessions`.
- **Budget scenarios.**
  - Seed `sessions/x/jev_calls.jsonl` with `{"kind":"jev_call","cost_usd":3.5}` (no session.json, so it is invisible in the library), then replay → `budget.exhausted {cap:"dev"}` is visible in the UI. `E2E_OVER_CAP=1` → no exhaustion.
  - A lower `config.app.budget.sessionCapUsd` (e.g. 0.00001) triggers the session cap.
- **SSE and Playwright.** Headless Chrome never reaches "networkidle" because `/api/events` stays open (docs/gotchas.md: "Headless Chrome never finishes loading the page"). Use `waitUntil: "domcontentloaded"` and web-first assertions, never `networkidle`.
- **Network proof.** Stubbing `globalThis.fetch`/`WebSocket` in the harness guarantees no service call from the engine. In Playwright, `page.route("**/*", r => r.request().url().startsWith(baseURL) ? r.continue() : r.abort())` guards the page. The page CSP is already `'self'`-only.

### 10.3 Option B (boot fidelity): the real `main()` plus a preload plus a fake helper binary

Command:

```
HOME=$TMP TATTLE_CREDENTIALS=$TMP/credentials.json E2E_SESSIONS=$TMP/sessions node --import tsx --import ./tests/e2e/preload.ts src/server/main.ts --port 4399 --replay fixtures/conversation --speed max
```

- **Do not use `npm run serve`**: it loads `.env` (real keys) and rebuilds the web page.
- `preload.ts` does two things:
  - `setAppPaths({sessions: process.env.E2E_SESSIONS, helper: resolve("tests/e2e/fake-capture.mjs"), src: null})`
  - Replaces `globalThis.fetch` with the combined fake (services, chat, key checks) and `globalThis.WebSocket` with `FakeRealtimeSocket`.
- `fake-capture.mjs` must start with `#!/usr/bin/env node`, be `chmod +x`, and implement the helper protocol (nativeSource.ts:8-33, 126-249):
  - `--list-devices`: print JSON lines `{"uid":…,"name":…,"transport":"builtin","isDefault":true}` and exit 0.
  - Otherwise:
    - On **stderr**, one line `{"type":"started","epochMs":<Date.now()>,"remote":{"outputKind":"headphones","outputDevice":"AirPods"}}`.
    - On **stdout**, frames: `"PCAP"` + stream byte (0 host, 1 remote) + 3 zero bytes + float64LE sessionMs + uint32LE n + n×int16LE, i.e. 1600 samples every 100 ms, read from the fixture WAVs.
    - Exit when stdin closes.
    - `frameBytes()` in tests/nativeSource.test.ts:7 is the reference encoder.
- **Covers:** `migrateAppSupportDir` (with `HOME=tmp`), `KeyStore` default path resolution, `bootEngine` wiring, `startNativeCapture` spawn/parse/stop, `listDevices`, the `--replay` flow and the SIGTERM shutdown.
- **Caveat:** `main()` logs the *requested* port, so use a fixed one.
- **Caveat:** the `import.meta.url === file://argv[1]` guard fails for a path containing spaces or percent-encodable characters (UNSURE; see §11.10). The project path has none.

### 10.4 Is a production change unavoidable?

**No.** Option A needs only existing seams, and Option B only preloads and env vars.

Optional niceties (not required):
- **`bootEngine`** (main.ts:806) could accept `{fetch?, sessionsDir?, session?, live?, devices?, keysPath?, migrate?: boolean}`. That would let Option A reuse the exact boot.
- **`main()`** (main.ts:833) could log the bound port (`server.address().port`) so `--port 0` works.
- **`replay.ts`/`smoke.ts`/`preflight.ts`** could be wrapped as exported functions (lines above) for in-process unit tests with coverage. Child-process runs do not show up in V8 coverage unless `NODE_V8_COVERAGE` is wired; UNSURE how vitest v5 coverage merges child processes. **So to reach about 100 % line coverage on the CLIs, the refactor into exported functions is effectively required.**

---

## 11. Code smells and latent bugs (hedged)

1. **`Engine.start` can fail after the session has started** (main.ts:439). `library.update(s.id, {name})` throws "name is too long" (library.ts:218) for a name over 120 characters, or "must be a string" (unreachable because of the typeof guard). By then `s.run()` is running, so the HTTP answer is 400 while a session runs. A retry then gets 409 "already running". **Confident.** Fix: validate the name before building the Session.
2. **A live capture can leak** (main.ts:408-431). If `opts.live()` resolved but `new Session(...)` throws (e.g. zero sources, or a sherpa model missing), `this.capture` stays set and the helper keeps running. A failure in `live()` itself is answered with 400 rather than 5xx.
3. **The router maps every non-API error to 400** (main.ts:793), including server faults (ENOENT, EACCES, sherpa errors, a raw SyntaxError from transfer.ts:222). Clients cannot tell "your fault" from "our fault".
4. **Errors after the headers are sent can crash the process** (hedged).
   - In `serveMixedAudio` (audio.ts:85-91) the headers go out before `openSync`. If a WAV vanishes in between (a delete during playback), the throw reaches the router's catch, whose `send()` throws `ERR_HTTP_HEADERS_SENT` inside the async request handler: an unhandled rejection, which in Node 24 terminates the process.
   - Likewise, `createReadStream(...).pipe(res)` in `serveStatic` (main.ts:649) and the export download (783) has no `'error'` listener, so a read error would be an uncaught `'error'` event.
5. **`importRecording` leaves the exporter's `dir` in place** (transfer.ts:246-251 and library.ts:233). The import rewrites only `"sessionId"`. `session.started.data.dir` (session.ts:272) keeps the exporter's absolute path, which includes their macOS username. `SessionLibrary.events` fixes `dir` only when `sessionId` mismatches, and after the rewrite it never does. The page does not read `dir` (grep of web/src), so this is harmless in the UI but **leaks the exporter's home path inside every `.tattle`** (events.jsonl). A privacy smell.
6. **`exportRecording` does not handle a missing events.jsonl** (transfer.ts:127). `readFileSync(events.jsonl)` is unguarded, so a recording folder without events.jsonl (the library only requires session.json) fails export with a raw ENOENT → 400.
7. **The duplicate check treats undefined start times as equal** (transfer.ts:226). `startedAt === session.startedAt` holds when both are `undefined`. Two different recordings with the same id and no `startedAt` are treated as the same → 409.
8. **`canonicalWav` trusts the declared data length** (transfer.ts:171, used for `audio/*.wav` entries). For an "original" export of a WAV whose header was never finalised (data length 0 after a crash, since `WavWriter` writes the final size only on close), `want = min(samples*2, 0+32000)` truncates the import to at most 1 s of audio. `dataLen` also ignores the file's real size. Conversely, `samples === null` with an oversized declared `dataLen` reads past EOF: `fh.read` returns fewer bytes but `avail` assumes a full read, so stale buffer bytes may be written (UNSURE).
9. **`SessionLibrary.list` sorts mixed keys** (library.ts:200). It compares `startedAt` (ISO `2026-09-24T…`) with ids (`20260924-…`); `'0' > '-'` puts id-keyed rows before all ISO ones. This is rare, since every Session writes `startedAt`.
10. **The CLI guard breaks for some paths** (main.ts:852, calibrateBoundary.ts:37, calibrateSpeakers.ts:32). `import.meta.url === \`file://${process.argv[1]}\`` fails when the path contains spaces or characters that need percent-encoding, or is reached through a symlink: `main()` silently does nothing. `pathToFileURL(process.argv[1]).href` would be robust.
11. **`snapshot` has a stale cap default** (library.ts:328). `sessionCapUsd ?? 5` is a fallback inconsistent with the config default of 10.
12. **The library cache can serve stale data** (library.ts:103-110). Its key is the max mtime of four files; it ignores session.json and the WAV sizes, and writes within the same mtime granularity can serve a stale summary. The durations of a running session update only when events.jsonl changes (which is frequent).
13. **`discard` is dangerous if reused** (transfer.ts:310). `rm -rf dirname(path)` is correct only because every caller passes `<mkdtemp>/upload.tattle`. Passing any other path would delete its parent folder, e.g. the sessions root.
14. **`bootEngine` touches the real home** (main.ts:807). `migrateAppSupportDir()` renames folders under the real `~/Library/Application Support` whenever the engine boots, including from any test that calls `bootEngine`/`main` without `HOME` isolation.
15. **The SSE ping has no guard** (main.ts:700). It writes `": ping"` without checking `res.writableEnded`. It is harmless because the interval is cleared on `req` close, but it would write to a closed response if 'close' were missed.
16. **Duck-typed export cleanup** (main.ts:785). `exportSent` fires on `res` "finish", so an aborted download keeps the file until the 15-minute timer. That is by design, but the Mac app's in-process download relies on "finish" happening. It is also outside `EngineApi`.
17. **`/api/sessions/import` is shadowed for GET/DELETE** by the `/api/sessions/:id` route (738-741): GET gives 404 "unknown session import". A recording can never be named `import`, `close` or `export`, but ids are timestamps, so this is cosmetic.
18. **`importFile` does not wrap every error** (main.ts:196-208). A non-TransferError (ZipError from `readZipEntry` at transfer.ts:241, a RangeError from zlib's `maxOutputLength`, a SyntaxError) is rethrown raw → 400 with a technical message. Only `readZipEntries` is wrapped into a friendly 400.
19. **Replay CLI exit codes and spend** (replay.ts:59, smoke.ts:25, preflight.ts:77). `replay.ts` always exits 0, even on `budget.exhausted` or with every call failing, so scripts cannot detect a failed replay. `replay.ts`/`smoke.ts`/`preflight.ts` write into the project's `sessions/` (no flag to redirect). `smoke-`/`preflight-` folders still count toward `sumDevSpend` (intended).
20. **`calibrateSpeakers --voices`** is not validated (calibrateSpeakers.ts:40), so `Number("abc")` gives a NaN limit.
21. **Test hygiene**:
    - tests/server.test.ts:66 writes `secret.txt` directly into `os.tmpdir()`, not a mkdtemp.
    - Many tests never remove their mkdtemp folders.
    - server.test.ts shares one FakeEngine across tests and asserts on the cumulative `engine.calls` order, so tests are order-dependent ("every route" asserts the exact list, and "pause, resume…" uses `slice(-3)`).
22. **`streamGain` cache grows forever** (audio.ts:23). The `gains` Map is never evicted. Each re-recorded or modified file adds a key. Negligible.

---

## 12. Quick index of the existing test harness shapes (to copy)

- **Router with a fake engine:** `const server = createApiServer(new FakeEngine(), { webRoot: tmpWeb }); await new Promise(r => server.listen(0, "127.0.0.1", r)); base = \`http://127.0.0.1:${port}\``. Requests go through raw `http.request` (fetch is disabled by tests/setup.ts). The web root is seeded with index.html, licenses.html, styles.css, dist/app.js and fonts/face.woff2.
- **Router with the setup gate:** `createApiServer({ bus: new EventBus(), state: () => ({session:null}) } as unknown as EngineApi, { webRoot, setup: new KeySetup(new KeyStore({ path: tmp, env: {} }).load(), { fetch: fakeFetch().f, models: [] }) })`.
- **In-process:** `inProcessHandler(createApiServer(partialEngine, { webRoot, setup: { status: () => ({configured:true}), save } }))`, called as `handle(new Request("app://conversation-assistant/api/state"))`.
- **Real Engine, offline:**
  - `new Engine({ sessionsDir: mkdtemp, session: { fetch: fakeFetch(loadScript()).f, keys: { openrouter, openai } } })` (session.test.ts:243)
  - `new Engine({ sessionsDir, session: { services } , live: async (mic, onStatus) => ({ sources, stop }) })` (echoGate.test.ts:162)
  - `new Engine({ sessionsDir: root })` for library-only work (library.test.ts:91)
  - After `engine.start`, `await engine.current!.run()` then `await new Promise(r => setImmediate(r))` to let the `.then` archive it (session.test.ts:262-264).
- **Library fixtures:** `makeSession(root, id, {startedAt, lines, cost, ended, mode})` (library.test.ts:11). **Transfer fixtures:** `recording(root, id)` plus `tone(s, hz)` (transfer.test.ts:17-39).
- **CLI via a child process:** `execFileSync(process.execPath, ["--import", "tsx", "src/cli/calibrateBoundary.ts", file], { encoding: "utf8" })` (stats.test.ts:94).
