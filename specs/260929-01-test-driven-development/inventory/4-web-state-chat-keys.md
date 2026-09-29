> **Inventory for [SPEC.md](../SPEC.md) — Area 4: web front end part B (state, api, router, chat, calls, app, keys, transfer, ui, desktop, main) and the page↔engine contract.** Written 2026-09-29 by a read-only scan of commit `74b42a6`. Line numbers were right at that commit; **symbol names win when lines drift** (grep them). "Spike" and "scratchpad" mentions refer to throwaway experiments run outside the repo during the scan; they are not available to you, but every recipe they validated is written out below. Items marked *unverified*/*UNSURE*/*hedged* are exactly that — verify before relying on them. SPEC.md overrides this file wherever they disagree (scope, thresholds, bug policy, file layout).


# Scan: web front end, part B (chat, state, calls, app, keys, transfer, ui, api, router, desktop, main, HTML)

Scope: `web/src/{chat,state,calls,app,keys,transfer,ui,api,router,desktop,main}.ts`, `web/index.html`, `web/licenses.html` (+ `web/src/licenses.ts`, 96 lines, which `licenses.html` loads). Read in full. Transitive modules I touched only for side effects and contracts: `dom.ts`, `panels.ts` (toast/ask/bindControls/Start live/menu/about/checkEngine), `desktop/preload.ts`, `src/server/main.ts` (routes, SSE writer), `src/store/events.ts` (event schemas).

Verified by running (read-only):
- `npx vitest run tests/router.test.ts`: passes, 4 tests.
- Plain Node import probe (`node --import tsx -e "import('./web/src/X.ts')"`). These modules import fine with no DOM: `state`, `calls`, `transfer`, `api`, `router`, `desktop`, `panels`. These fail: **`keys`** (`document is not defined`), **`chat`** and **`ui`** (`HTMLSelectElement is not defined`).
- `package.json` has no happy-dom, jsdom or Playwright. `vitest.config.ts` has only `include: tests/**/*.test.ts`, `setupFiles: tests/setup.ts`, and 120 s timeouts.
- **`tests/setup.ts` replaces `globalThis.fetch` with a function that throws, for every test.** So every web test must `vi.stubGlobal("fetch", fake)`, including tests that run in a DOM environment.

Naming correction: the preload bridge is **`window.desktop`**, not `window.tattle` (`desktop/preload.ts` `contextBridge.exposeInMainWorld("desktop", …)`; `web/src/desktop.ts:15`).

---

## Area-wide notes

### A. Harness recommendation (the best seam found)
- `createApiServer(engine: EngineApi, { webRoot, setup })` (`src/server/main.ts:675`) takes an **engine interface** (`EngineApi`, `src/server/main.ts:76-109`), with optional `chat?: ChatApi` (`:39`) and `transfer?: TransferApi` (`:27`), plus a `SetupApi` (`:654`, `status()` and `save(body)`).
- `tests/server.test.ts:13-51` already has a `FakeEngine` with `bus = new EventBus()`.
- **E2E recommendation:** a Node script that starts `createApiServer(fakeEngine, { webRoot: "<repo>/web", setup: fakeSetup })` on `127.0.0.1:<port>`, after `npm run build:web`, which is needed because `web/dist` is served.
  - The test drives events with `fakeEngine.bus.emit(type, data)`. The bus keeps history and replays it to every new SSE connection (`src/server/main.ts:695-702`).
  - `{ transient: true }` mirrors the real engine for `utterance.partial`, `call.started` and `call`.
  - This gives the real router, the real SSE framing, the Host/Origin guard, the CSP and static serving, with a scriptable engine.
- Playwright `page.route` alone is poor for `/api/events`: a fulfilled SSE body ends, then EventSource auto-reconnects about 3 s later and the history is replayed (see smell S-state-1).
- The `baseURL` must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. `fromThisPage` (`src/server/main.ts:662-668`) returns 403 for any other Host, or for an Origin that does not match.
- The page CSP is `script-src 'self'` (`PAGE_CSP` `:554`). If `page.addInitScript` stubs misbehave, use the context option `bypassCSP: true`.
- Never wait for `networkidle`: `/api/events` stays open (gotcha "Headless Chrome never finishes loading", `docs/gotchas.md:61`). Use `waitUntil: "domcontentloaded"` or `"load"`, then wait on selectors.
- `/api/*` returns 503 `{error, setup:true}` until `setup.status().configured`, except `OPEN_ROUTES` = `/api/setup`, `/api/setup/keys`, `/api/about`, `/api/licenses`, `/api/engine` (`:673`, `:692`).

### B. Unit environment
- Use `// @vitest-environment happy-dom` per file (or `environmentMatchGlobs`) for `web/src` DOM tests. jsdom lacks `HTMLDialogElement.showModal`, **to my knowledge (uncertain)**.
- **Write a probe test first**, because the following are uncertain in happy-dom:
  - (a) `dialog.showModal()` / `.close(rv)` / `open` / a `close` event. Is the event sync or async? Browsers queue it as a task.
  - (b) `showPopover` / `hidePopover`.
  - (c) **`el.matches(":popover-open")`**. This may throw a SyntaxError for an unknown pseudo-class. It is used in `panels.toast` (panels.ts:18,22), `chat.ts:111,337,343,352` and `ui.ts:166,176`.
  - (d) `el.matches(":focus-visible")` (`ui.ts:197`).
  - (e) `EventSource`: probably absent, so stub it.
  - (f) `navigator.clipboard.writeText`.
  - (g) `requestAnimationFrame`.
  - (h) `history.pushState` / `replaceState` updating `location.pathname` / `search`.
  - (i) `<form method="dialog">` setting `returnValue`.
  - (j) `select.labels`.
  - (k) `HTMLSelectElement.prototype` having an accessor `value` and `selectedIndex`, which `ui.ts:12-13` needs.
  - If (b)/(c) are missing, add a shim in a web setup file: patch `HTMLElement.prototype.showPopover` / `hidePopover` to toggle a flag, and wrap `Element.prototype.matches` to answer `:popover-open` from that flag.
- Reset module state per test: `vi.resetModules()` plus `await import(...)`. `chat.ts`, `calls.ts`, `ui.ts`, `app.ts`, `transfer.ts` and `panels.ts` hold module-level `let`s.
- DOM fixture: parse `web/index.html` and set `document.body.innerHTML` to the `<body>` content without the `<script>`. That gives every id the code expects (`#dlg-chat`, `#chat`, `#chat-sub`, `#chat-btn .dot`, `#toasts`, `#dlg-ask`, `#export-btn`, `#import-btn`, `#drop`, `#dlg-export`, `#export-body`, `#export-sub`, `#dlg-import`, `#import-body`, `#keys`, `#pane-*`, `#jev-log`, `#think`, `#jev-count`, …).
- Imports: the source uses `./x.js` specifiers for `.ts` files. Vite/Vitest resolves that, as the existing src tests show. Import `../web/src/x.ts` from tests, as `tests/router.test.ts` does.

### C. Page ↔ engine contract, as seen from the client

**Boot order** (`main.ts`, then `app.ts:251-283`):
1. `GET /api/setup`.
2. Stop if not configured. Otherwise import `app.ts`, which calls `GET /api/about` (bindAbout), `GET /api/chat/models` (bindChat), `GET /api/engine` (checkEngine, then every 15 s) and `GET /api/devices` (loadDevices).
3. `GET /api/state`. If `session` is present: `GET /api/calls?system=s1&limit=3000` and `GET /api/calls?system=s2&limit=200`.
4. applyRoute: maybe `POST /api/sessions/:id/open`, then `GET /api/state` again, or `POST /api/sessions/close`.
5. `new EventSource("/api/events")`.
6. When `session` is present, renderChat also triggers `GET /api/chats`.

**`GET /api/state`** (consumer: `state.ts:146 fromSnapshot`). Missing or null `session` gives an empty state. Fields read:
- `session`: `{id, mode, status: "running"|"ending"|"archived"|…, paused?, dir?, startedAt?, streams?, name?, features?:{factcheck,labels}, echoGate?:{active,device}, hasAudio?, appVersion?, imported?}`
- `speakers: [{id, displayName, mergedInto?}]`
- `utterances: [{id, stream, startMs, endMs, speakerId, text, tags[], filler?, speakerInferred?}]`
- `segments: [{id, startMs, endMs, forced, final, utteranceIds[], labels|null}]`
- `sections: [{id, subject, lane, segmentIds, startMs, endMs}]`
- `claims: [Claim]` (`state.ts:24-30`)
- `s1: {active, versions[], memory[]}`, where only `memory.length` is used
- `labels: {set, stories, version}`
- `cost: {transcription, jev, s2, chat?, session, sessionCapUsd}`
- `stats` (any; panels reads `roganIndex`)
- The snapshot's pauses, errors, health, missing lines and partials are **not** read. They come only from replayed events.

**`GET /api/events` (SSE)**:
- The server writes `id: <seq>\nevent: <type>\ndata: <JSON of {seq,type,at,data}>\n\n` (`src/server/main.ts:622-624`), plus `: connected` / `: ping` comments.
- The client registers `addEventListener` for exactly 31 names (`app.ts:238-240`) and parses `ev.data` as `{type, data, at}` (`app.ts:226-228`). `es.onmessage` is a no-op, so unnamed messages are ignored.
- The names: `session.started, session.ended, session.paused, session.resumed, echo.gate, call.started, call, health, utterance, utterance.failed, utterance.partial, speaker.created, speaker.updated, speaker.merged, segment.closed, segment.labels, section.updated, claim.flagged, claim.duplicate, claim.repeat, claim.researching, claim.verdict, claim.dropped, claim.disputed, audit, s1.version, s1.memory, cost, budget.exhausted, stats, error`.
- This matches `EVENT_TYPES` in `src/store/events.ts:8-46` one for one (checked by hand). Candidate contract test: export the list from app.ts (seam) and assert equality with `EVENT_TYPES`.
- Payload fields the reducer reads:
  - `session.started{sessionId, features?, startedAt?}`
  - `session.paused/resumed{atMs}`
  - `health{stream, rmsDbfs, msSinceLastFrame, utterancesLastMinute, detail?, echoMutedMs?}`
  - `echo.gate{active, device}`
  - `utterance.partial{stream, itemId, text, utteranceId|null, final}`
  - `utterance.failed{id, stream, startMs, endMs, speakerId, status}`
  - `utterance{…Utterance}`
  - `speaker.created/updated{id, displayName}`
  - `speaker.merged{fromId, intoId}`
  - `segment.closed{id, startMs, endMs, forced, final, utteranceIds}`
  - `segment.labels{segmentId, …Labels}`
  - `section.updated{sections}`
  - `claim.flagged{claimId, utteranceId, speakerId, text, priority, s1Version}`. `speakerId` is **not** in the zod schema but is emitted (`src/factcheck/s1.ts:353`).
  - `claim.researching/disputed{claimId}`
  - `claim.verdict{claimId, verdict, grade, latencyMs}`
  - `claim.dropped{claimId, reason}`
  - `claim.repeat/duplicate{claimId, utteranceId}`
  - `audit{misses[]}`, deduped by the envelope's `at`
  - `s1.version{active, …}`, which also triggers an extra `GET /api/state` (`app.ts:235`)
  - `s1.memory{size}`
  - `cost{…}` (merged)
  - `budget.exhausted{message}`
  - `stats{…}`
  - `call.started{system}`
  - `call{kind, purpose, ok, latency_ms, attempts, cost_usd, at, id, model_returned, …}`
  - `error{component, message}`
- **`session.started` with a `sessionId` different from the one on screen (or with no session) returns "reset"**, and the page re-fetches `/api/state` (`app.ts:228-233`). This is how the page switches sessions after start, open and import-open. **A fake engine must emit it on start and open.**

**Commands (`api.ts:125-170`)**. Method, path and body; response type in brackets.

| client fn | request | response used |
|---|---|---|
| state | GET /api/state | snapshot |
| setup | GET /api/setup | `{configured, keys:[{name:"openai"\|"openrouter", env, set, source:"environment"\|"file"\|null, hint}], path}` |
| saveKeys | POST /api/setup/keys `{openai?, openrouter?}` | `{saved, checks:{openai?:{ok,message,warning?}, openrouter?:…}, configured, keys, path}` |
| about | GET /api/about | `{name, version, license}` → `#app-version` "v<version>" |
| licenses | GET /api/licenses | `{app:{name,version,license,holder,text}, groups:[{title, components:[{title,license,body,files[]}]}], texts:{[file]:string}}` |
| closeView | POST /api/sessions/close | `{closed}` |
| calls | GET /api/calls?system=s1\|s2&limit=N | `{rows: CallRow[], models:{s1,s2}}` |
| engine | GET /api/engine | `{startedAt, stale}`; 404 → stale banner shown |
| stats | GET /api/stats | |
| devices | GET /api/devices | `[{uid,name,transport,isDefault}]` (transport "builtin" filtered out; a fixed "builtin" option is prepended) |
| startReplay | POST /api/session/start `{mode:"replay", dir, speed:1\|"max", voices}` | `{sessionId}` |
| startLive | POST /api/session/start `{mode:"live", mic?, voices, features:{factcheck,labels}}` | `{sessionId}` |
| stop / pause / resume | POST /api/session/stop \| pause \| resume | |
| rename | POST /api/speakers/:id/rename `{displayName}` | |
| suggestMerges | GET /api/speakers/suggestions[?voices=N] | |
| merge | POST /api/speakers/merge `{fromId,intoId}` | |
| putLabels / relabel / putStories | PUT /api/labels, POST /api/labels/relabel, PUT /api/stories `{headlines}` | |
| override | POST /api/claims/:id/override `{note?}` | |
| sessions | GET /api/sessions[?q=] | SessionSummary[] |
| renameSession | PATCH /api/sessions/:id `{name}` | SessionSummary |
| openSession | POST /api/sessions/:id/open | `{sessionId, events}` |
| replaySession | POST /api/session/start `{mode:"replay", sessionId, speed, voices}` | |
| deleteSession | DELETE /api/sessions/:id | |
| chatModels | GET /api/chat/models | `{default, capUsd, models:[ChatModel]}` |
| chats | GET /api/chats | `{sessionId, spentUsd, capUsd, chats:[{id,title,model,updatedAt,busy,messages,costUsd}]}`. **`sessionId` must equal the session on screen, or the list is ignored** (`chat.ts:177`) |
| chat | GET /api/chats/:id | `Chat{id,title,model,createdAt,updatedAt,busy,messages[],meter}` |
| createChat | POST /api/chats `{model}` | Chat |
| updateChat | PATCH /api/chats/:id `{title?,model?}` | Chat |
| deleteChat | DELETE /api/chats/:id | |
| stopChat | POST /api/chats/:id/stop | |
| sendChat | POST /api/chats/:id/messages `{content, mode:"send"\|"edit"}` or `{mode:"regenerate"}` | SSE body of `data: {"type":"start"\|"thinking"\|"delta"\|"done"\|"error", …}` blocks separated by `\n\n` |
| exportInfo | GET /api/sessions/:id/export | `{id,name,fileName,recordedWith,app:{name,version},bytes:{compressed,original,none},chats,hasAudio}` |
| exportPrepare | POST /api/sessions/:id/export `{audio, chats}` | `{token, fileName, bytes}`, then the page navigates an `<a download>` to GET /api/exports/:token |
| importRecording | XHR POST /api/sessions/import, octet-stream body, header `X-File-Name: encodeURIComponent(name)` | `{summary: SessionSummary, already, copyToken?}` |
| importCopy | POST /api/sessions/import/:token `{name}` | ImportResult |
| rollback | POST /api/s1/rollback `{version}` | |

Also fetched outside api.ts: `GET /api/sessions/:id/audio` (player.ts, when a recording is archived with `hasAudio !== false`); `GET /licenses` (licenses.html); `/dist/*.js`, `/styles.css`, `/fonts/*`.

---

## 1. `web/src/state.ts` (360 lines): client state and event reducer. Pure, DOM-free. Highest value per test.

**Exports:** types `Stream, Speaker, Utterance, MissingLine, ChoiceLabel, Labels, Segment, Section, Verdict, Claim, Health, S1Version, S1Outcome, Cost, LabelQuestion, LabelSet, LivePartial, ErrorItem, CallRow, SystemId, Calls, Features, State, Dirty`. Functions:

| symbol | line | notes |
|---|---|---|
| `addCall(s,row)` | 109 | key `${kind}\|${at}\|${id??""}\|${purpose}`; dedupe; merges `row.questions` into `s.calls.questions` as `{type,instructions}`; jev_call goes to `s1`, else `s2`; caps at 3000 (`MAX_S1_CALLS`, applied to both lists) by dropping the oldest |
| `emptyState()` | 119 | defaults: `s1.active "s1@1"`, `cost.sessionCapUsd 10` |
| `featuresOf(s)` | 130 | `!== false` for each, so no session gives both true |
| `resolveSpeaker(s,id)` | 135 | follows `mergedInto` at most 50 hops (guards cycles) |
| `speakerName(s,id)` | 141 | falls back to the id |
| `fromSnapshot(snap)` | 146 | see contract C |
| `applyEvent(s,type,d,at,dirty)` | 171 | returns `"reset"` or void; see below |
| `s1Counters(s)` | 351 | `{flags, goodFlags (grade good_flag && !disputed), falseAlarms, misses, repeats (Σ repeats+duplicates)}` |

**applyEvent branches** (every handled type, with the dirty set it adds):
- `session.started` (173): no session, or a different id, returns `"reset"` without touching dirty. Same id: status becomes `running` unless `archived`; `features` copied if given. dirty session.
- `session.ended` (179): status `archived`, `paused=false` (only if a session exists). dirty session, health, cost.
- `session.paused` (184): `paused=true` if session; adds `{startMs:atMs, endMs:null}` unless a pause with that startMs exists. dirty session, health, timeline.
- `session.resumed` (189): `paused=false`; closes the first open pause with `endMs=atMs`. Same dirty.
- `health` (196): stores it with `receivedAt=Date.now()`. `lastSoundAt = now` if `rmsDbfs > -50` or `echoMutedMs > 0`, else the previous `lastSoundAt`, else `now`. dirty health.
- `echo.gate` (208): `session.echoGate = {active: !!d.active, device: d.device ?? null}` if a session exists. dirty health (even with no session).
- `utterance.partial` (212): if `utteranceId` is already final, **break without dirty**; else `partials.set(itemId, {...d, receivedAt})`. dirty transcript.
- `utterance.failed` (217): `status==="empty"` or the utterance already exists → delete from `missing`; else set. dirty transcript.
- `utterance` (222): set; delete from `missing`; delete every partial whose `utteranceId` matches. dirty transcript.
- `speaker.created` / `speaker.updated` (228): upsert, keeping the existing object (keeps `mergedInto`). dirty speakers, transcript, claims.
- `speaker.merged` (236): `from.mergedInto = intoId` if `from` is known. Same dirty.
- `segment.closed` (242): set, keeping the previous `labels`, else null. dirty timeline, transcript.
- `segment.labels` (248): attach to an existing segment (unknown: no-op). Same dirty.
- `section.updated` (254): replace `sections`. dirty timeline.
- `claim.flagged` (258): create if new, `status:"queued"`, `activity=at`, empty repeats and duplicates; an existing claim is not overwritten. dirty claims, s1.
- `claim.researching` (267): only `queued` becomes `researching`. dirty claims.
- `claim.verdict` (273): `status "verdict"`, verdict, grade, latencyMs. dirty claims, s1.
- `claim.dropped` (279): `status "dropped"`, `dropReason`. dirty claims.
- `claim.disputed` (285): `disputed=true`. dirty claims, s1.
- `claim.repeat` / `claim.duplicate` (291): push `utteranceId` once into repeats or duplicates; `activity=at` (even if already present). dirty claims, s1.
- `audit` (300): dedupe by `at`; `misses += d.misses.length` (?? []); `audits++`. dirty s1.
- `s1.version` (307): `active`; `last = {...d, at}`. dirty s1.
- `s1.memory` (312): `memorySize = d.size`. dirty s1.
- `cost` (316): shallow merge. dirty cost.
- `budget.exhausted` (320): `budgetExhausted = message`. dirty cost.
- `stats` (324): replace. dirty stats.
- `call.started` (328): `active[system]++`, `lastStart = Date.now()`. dirty calls.
- `call` (335): `active` decremented, not below 0; `addCall`. dirty calls.
- `error` (342): unshift `{component, message, at}`; keep 30. dirty errors.
- unknown type: no-op, no dirty.

**Browser deps:** none, apart from `Date.now` (use `vi.useFakeTimers` / `vi.setSystemTime`). **Side effects on import:** none. Runs in the node environment.

**Unit tests** (`tests/web/state.test.ts`, node environment):
- it("emptyState has no session, cap 10, s1@1, empty maps and calls")
- it("featuresOf defaults both on with no session, and with session.features undefined")
- it("featuresOf reads factcheck:false and labels:false independently")
- it("resolveSpeaker follows a merge chain to the survivor")
- it("resolveSpeaker stops after 50 hops on a merge cycle and returns a speaker, not hanging")
- it("resolveSpeaker returns undefined for an unknown id; speakerName falls back to the id")
- it("fromSnapshot(null|{}|{session:null}) returns an empty state")
- it("fromSnapshot loads speakers, utterances, segments, sections, claims keyed by id")
- it("fromSnapshot takes s1.active and versions and memorySize from memory.length; missing memory gives 0")
- it("fromSnapshot copies labels, cost, stats (stats missing gives null) and never seeds misses or errors")
- it("session.started with no session returns reset and adds nothing to dirty")
- it("session.started with another sessionId returns reset")
- it("session.started for the same id sets running, keeps archived, copies features")
- it("session.ended archives and clears paused; is safe with no session")
- it("session.paused adds one open pause, deduped by atMs on replay")
- it("session.resumed closes the open pause; a resume with no open pause is harmless")
- it("health marks lastSoundAt now when louder than -50 dBFS")
- it("health keeps the previous lastSoundAt when quiet, and uses now for the first quiet frame")
- it("health treats echoMutedMs>0 as sound")
- it("echo.gate sets active and device (undefined device gives null); no-op without a session but marks health")
- it("utterance.partial is stored by itemId with receivedAt")
- it("utterance.partial for an utterance already final is ignored and not dirty")
- it("utterance.failed retrying/failed is stored; empty removes; a known utterance removes")
- it("utterance replaces its missing line and every partial pointing to it")
- it("speaker.created then speaker.updated renames without losing mergedInto")
- it("speaker.merged sets mergedInto; unknown fromId is a no-op but still dirty")
- it("segment.closed keeps labels already attached when re-closed")
- it("segment.labels for an unknown segment is a no-op")
- it("section.updated replaces the sections array")
- it("claim.flagged creates a queued claim once; a replay does not reset its status")
- it("claim.researching only moves queued claims")
- it("claim.verdict sets status, verdict, grade, latencyMs; unknown claim no-op")
- it("claim.dropped sets dropReason; claim.disputed sets disputed")
- it("claim.repeat and claim.duplicate add the utterance once to the right list and bump activity")
- it("audit counts misses once per `at`, and counts audits")
- it("audit without misses adds 0 misses but counts the audit")
- it("s1.version sets active and last with at; s1.memory sets memorySize")
- it("cost merges into the existing cost; budget.exhausted stores the message")
- it("stats replaces stats")
- it("call.started increments active and stamps lastStart; call decrements, not below 0, and adds the row")
- it("error keeps the newest first and caps at 30")
- it("an unknown event type changes nothing and adds no dirty flags")
- it("addCall dedupes by kind|at|id|purpose (null id)")
- it("addCall keeps question wording from live rows by id")
- it("addCall trims the oldest beyond 3000, for s1 and for s2")
- it("s1Counters counts flags, good flags and false alarms excluding disputed, misses, and repeats plus duplicates")

**Smells:**
- S-state-1 (`state.ts:342-345`): `error` events are not deduplicated. The server replays the full history on every SSE (re)connect (`src/server/main.ts:698`), and `EventSource` auto-reconnects after a drop without a page reload. After a reconnect, every stored error is added again. Likewise `claim.repeat` updates `activity` again, which is harmless.
- `state.ts:106`: `MAX_S1_CALLS` also caps `s2`, and `calls.keys` is never pruned, so memory grows without bound on long shows. Minor.
- `state.ts:301`: audits deduped by millisecond timestamp; two audits in the same ms would count once. Hedged, unlikely.
- `state.ts:230`: `speaker.created` for a merged speaker keeps `mergedInto`, which is probably intended.

---

## 2. `web/src/router.ts` (85 lines): the page's URLs

**Exports:**
- `Route` (17)
- `TABS` (21): `{"fact-check":"pane-fc", thinking:"pane-think", "jev-log":"pane-jev"}`
- `PANELS` (22): recordings, insights, speakers, labels, chat, keys → dlg-*
- `SECTIONS` (26)
- `tabName(paneId)` (30), `panelName(dialogId)` (31)
- `parseTime` (34), `formatTime` (41): pure
- `readRoute(loc=location)` (47): pure when given `loc`
- `buildUrl(r)` (65): pure
- `setRoute(patch, push=false)` (78): uses `location`, `history`

Private: `FORMER` (28), which maps `stats`→overview, `system-1`→fact-checker, `log`→log.

**Browser deps:** `location` (default parameter, evaluated per call, so importing is safe), `history.pushState/replaceState`. Everything but setRoute runs in node; setRoute needs a DOM environment, or `vi.stubGlobal("location", …)` plus `vi.stubGlobal("history", {pushState: vi.fn(), replaceState: vi.fn()})` with a stub that updates location. **Side effects:** none.

**Existing coverage** (`tests/router.test.ts`): readRoute basics, FORMER, chat and section gating, buildUrl round trips, parseTime three cases.

**Missing tests:**
- it("parseTime(null|'') is null; negative parts null; '1.5' gives 1500; '1::2' gives 3602000 (empty part is 0)"). This documents current leniency.
- it("formatTime clamps negatives to 0:00, floors ms, uses h:mm:ss past an hour")
- it("tabName/panelName map ids back to names and return null for unknown")
- it("readRoute accepts a trailing slash on /recordings/<id>/")
- it("readRoute rejects ids starting with - or _ and ids with dots or %")
- it("readRoute ignores t on /")
- it("readRoute chat only matches ^chat_\\d+$")
- it("buildUrl omits t when t<=0 or null, omits tab fact-check, omits section overview, keeps colons in t")
- it("buildUrl encodes the recording id")
- it("setRoute replaces by default and pushes when push=true")
- it("setRoute is a no-op when the URL would not change (no history call)")
- it("setRoute changing recording resets t to patch.t ?? null")
- it("setRoute merging a patch keeps the other params")

**Smells:**
- `router.ts:36`: parseTime accepts fractions, exponents ("1e3") and empty parts. Harmless, lenient.
- `formatTime` (41) duplicates `dom.clock` (`dom.ts:51`) exactly.

---

## 3. `web/src/api.ts` (170 lines): HTTP client

**Exports:**
- `ApiError(status, message)` (3)
- types: SessionSummary, MergeSuggestion, ChatModel, ChatMessage, ChatMeter, Chat, ChatList, ChatStreamEvent, KeyName, KeyStatus, SetupStatus, KeyCheck, SaveKeysResult, ExportInfo, LicenseComponent, Licenses, ImportResult
- `api` (125): the table in C

Private: `call` (9), `streamChat` (60), `importRecording` (107).

**Pure parts:** none are exported. `streamChat`'s SSE block parser (73-84) is the most interesting logic; it can be tested through `api.sendChat` with a fake fetch returning `new Response(ReadableStream)`.

**Browser deps:**
- `fetch`: node has it, but tests/setup.ts replaces it, so use `vi.stubGlobal`.
- `Response.body.getReader` and `TextDecoder`: Node 24 has both.
- `XMLHttpRequest`: not in node. happy-dom has one that does real I/O, so stub a class with `open`, `setRequestHeader`, `upload.onprogress`, `onload`, `onerror`, `send`, `status`, `statusText`, `responseText`.
- All of api.ts **runs in node** with stubs. **Side effects:** none.

**Unit tests** (node environment, fake fetch capturing `(url, init)`):
- it("call GETs with no body and no content-type")
- it("call POSTs JSON with Content-Type application/json")
- it("call returns parsed JSON; empty 2xx body gives null")
- it("call throws ApiError with status and json.error on non-2xx")
- it("call throws ApiError with raw text when the error body is not JSON")
- it("call with empty error body gives an ApiError message of '' (documents the bug, see smell)")
- one it per api method asserting method, path, URL-encoding of ids (e.g. `rename("a/b")` → `/api/speakers/a%2Fb/rename`), query strings (`sessions("x y")` → `?q=x%20y`; `sessions()` → no query; `suggestMerges()` vs `suggestMerges(2)`; `calls("s1")` default limit 300), and body shape:
  - `startLive()` without mic omits `mic`
  - `startLive("m",2,{…})` includes mic, voices and features
  - `override(id)` sends `{}`; with a note sends `{note}`
- it("sendChat streams start/thinking/delta/done events split across arbitrary chunk boundaries")
- it("sendChat joins multi-line data: fields and ignores event:/id:/comment lines")
- it("sendChat ignores blocks without data")
- it("sendChat throws ApiError with json.error on 409, and falls back to text then statusText")
- it("sendChat drops a trailing block not terminated by a blank line (documents behaviour)")
- it("sendChat propagates a JSON parse error from a malformed data line")
- it("importRecording posts octet-stream with an encoded X-File-Name and sends the File")
- it("importRecording reports loaded/total only when lengthComputable")
- it("importRecording resolves the parsed JSON on 2xx")
- it("importRecording rejects ApiError(json.error) on 4xx, statusText when not JSON")
- it("importRecording onerror rejects ApiError(0, 'the upload failed: is the server running?')")

**Smells:**
- `api.ts:18`: `json?.error ?? text ?? res.statusText`. `text` is `""` for an empty body, which is not nullish, so the ApiError message is empty and toasts are blank. `streamChat:68` uses `||` correctly.
- `api.ts:64`: an OK response with a null body throws `ApiError(200, …)`. Odd, unlikely.
- `api.ts:78`: splits only on `\n\n`, so CRLF-framed SSE would never parse. The server uses `\n`. The remainder at stream end is dropped, and the reader is never `cancel()`ed on a thrown handler.
- `api.ts:117`: a 2xx with a non-JSON body resolves `null`, and `transfer.showResult(null)` then crashes with a TypeError.
- No `onabort` / `ontimeout` handlers on the XHR.

---

## 4. `web/src/chat.ts` (571 lines): the chat window

**Exports:**
- `tokens(n)` (55): pure
- `bindChat({onTime})` (74)
- `openChat()` (132)
- `renderChat(st)` (143)
- `chatOpened()` (167)

**Module state** (20-42): `models, defaultModel="openai/gpt-6-luna", list, current, draftModel, sessionId, hasSession, streaming, editing, onTime, lastMeterRefresh, busyPoll, sessionLabel, modelSort (from localStorage "pa.modelSort"), modelQuery, modelActive`.

**Private pure helpers** (can't be tested without export; candidates for a seam, e.g. `chatFormat.ts`, or test them through the DOM):
- `price` (61): null → "?"; <0.1 → 3 decimals with trailing zeros stripped; else 2 decimals
- `shortName` (64), `vendor` (65), `facts` (66): these depend on the module `models`
- `shownModels` (356): filter, then sort by suggested / cheapest / priciest / context, with null handling
- `attachment(m)` (479): chip text, DOM

**Private DOM functions:** `autosize` 125, `loadList` 174, `select` 183, `newChat` 198, `pollWhileBusy` 206, `lastUser` 219, `submit(text, mode)` 221, `stop` 282, `startEdit` 287, `drawSide` 297, `rename` 315, `remove` 325, `closeModels` 335, `toggleModels` 341, `drawModelMenu` 366, `drawModelList` 397, `pickModel` 417, `draw` 430, `drawModelButton` 450, `drawLog` 455, `userBubble` 488, `assistantBubble` 510, `copyButton` 522, `drawStreaming` 533, `drawMeter` 541, `scrollToEnd` 567.

**Browser deps:**
- `<dialog>` `#dlg-chat` `showModal`/`close`/`open`, plus the `close` event (113). happy-dom support is probable; verify.
- Popover API `showPopover`/`hidePopover`/`:popover-open` for `#model-menu` (97, 111, 337, 343, 346, 352). This **may need a shim**.
- `requestAnimationFrame`/`cancelAnimationFrame` (171, 263, 274): happy-dom has them, or use fake timers.
- `navigator.clipboard.writeText` (527): stub it.
- `localStorage` (40, 384).
- `scrollIntoView` (414): happy-dom may lack it, so stub `Element.prototype.scrollIntoView`.
- `getBoundingClientRect` and `window.innerHeight` (349).
- Keyboard: document-level **⌘K / Ctrl+K** (115-120: meta or ctrl + "k", case-insensitive, not with alt/shift). Composer: Enter sends (not with shift, not while `isComposing`), Esc stops while streaming, ArrowUp in an empty box edits the last question. Model search: ArrowDown/ArrowUp/Enter/Escape (Escape does stopPropagation so the dialog stays open). Edit box: Enter / Escape.
- Document `pointerdown` closes the model menu when the target is outside it (108).
- Streaming uses `api.sendChat`'s fetch stream, which is fake-able in happy-dom via `new Response(ReadableStream)`.

**Module-level side effects:**
- `chat.ts:40` reads `localStorage` inside try/catch, so it is safe.
- Import chain: `chat → ui.ts:12` reads `HTMLSelectElement.prototype` at import, so **importing needs a DOM environment**. `chat → panels → transfer/timeline/state/dom/router/api/desktop` is fine.
- Minimal seam for node-only coverage of `tokens` and `price`: move formatters to a DOM-free module. Otherwise just run chat tests under happy-dom.

**Unit tests** (happy-dom; `document.body.innerHTML` = index.html body; `vi.stubGlobal("fetch", router)`; fresh module per test):

`tokens`:
- it("tokens: 0→'0', 950→'950', 999.4→'999'")
- it("tokens: 1000→'1k', 1250→'1.3k', 9_950→'9.9k' or '10k' (round-half), 12_400→'12k', 999_499→'999k'")
- it("tokens: 1_000_000→'1M', 1_050_000→'1.05M', 2_000_000→'2M', 10_000_000→'10M'")
- it("tokens edge: 999_600 renders '1000k' (documents the bug)")

bindChat, open, render:
- it("bindChat builds sidebar, model button, log, meter, composer and fetches /api/chat/models")
- it("with no session: log says 'Start a session or open a recording…', input and send disabled, model button disabled, #chat-sub 'Ask about the transcript'")
- it("renderChat with a running session sets #chat-sub 'About <name> · on air'")
- it("renderChat with an archived session sets '· recording'; name falls back to id")
- it("renderChat on a new session id resets current, loads GET /api/chats and selects the URL's ?chat= when listed")
- it("loadList ignores a list whose sessionId differs from the session on screen")
- it("loadList failure sets list null and still draws")
- it("empty chat shows 4 starters; clicking one submits it")
- it("starters are disabled when the cap is reached")
- it("openChat closes other open dialogs, showModal()s #dlg-chat, sets ?panel=chat (and chat=<id> when current)")
- it("⌘K and Ctrl+K open the chat; Alt/Shift variants do not")
- it("closing the dialog closes the model menu and removes ?chat= from the URL")

Sending:
- it("submit on a new chat POSTs /api/chats with the active model, then streams to /api/chats/:id/messages {content, mode:'send'}")
- it("submit ignores empty or whitespace text in send mode")
- it("submit ignores a second submit while streaming")
- it("submit without a session toasts 'Start a session or open a recording to chat about it.'")
- it("submit with the cap reached toasts '…reached its cap of $2.00.'")
- it("createChat failure toasts the error and does not stream")
- it("Enter sends, Shift+Enter does not, isComposing does not")
- it("streaming: 'start' pushes the user message, 'thinking' shows ' Thinking…', deltas render markdown in #chat-streaming, 'done' replaces current")
- it("Send button reads Stop with class stop while streaming; #chat-btn .dot visible while streaming")
- it("an 'error' stream event toasts its message; the reply shows .msg.assistant.failed with Retry")
- it("a thrown sendChat toasts and refetches GET /api/chats/:id")
- it("Esc while streaming, or clicking Stop, POSTs /api/chats/:id/stop; stop failure toasts")
- it("after the stream: streaming cleared, list reloaded (GET /api/chats), redraw")
- it("events for a chat no longer on screen are ignored")

Editing and regenerating:
- it("ArrowUp in an empty box opens #chat-edit with the last question; Escape cancels; Enter sends mode:'edit' and truncates before the last user message")
- it("Edit button appears only on the last user message and not while streaming")
- it("Regenerate on the last assistant message sends {mode:'regenerate'} and keeps messages up to and including the last user message")

Sidebar actions:
- it("Copy writes to the clipboard, shows 'Copied' then 'Copy' after 1.5s; a rejected clipboard toasts 'Copying is not allowed here'")
- it("sidebar lists chats with model short name, cost, 'writing…' when busy; the current chat has aria-current")
- it("+ New chat while streaming toasts 'Wait for the reply…'; otherwise clears current, keeps the model as draft, removes ?chat=")
- it("select(id) GETs the chat, sets ?chat=, polls every 2s while busy until not busy")
- it("select failure toasts and clears current")
- it("Rename uses #dlg-ask (input) → PATCH {title}; cancel or empty does nothing; failure toasts")
- it("Delete confirms via #dlg-ask (danger) → DELETE; deleting the current chat selects none")
- it("chat spend shows '$x of $y', the bar class warn above 80%, error-text at the cap")

Model picker:
- it("model button shows shortName ('GPT-6 Luna' from 'OpenAI: GPT-6 Luna') and facts '1.05M context · $1.25 in / $10.00 out per M tokens'")
- it("model button shows 'context ?' when contextLength is null")
- it("unknown model id shows the raw id; vendor falls back to the id prefix")
- it("toggleModels opens the popover, focuses #model-search, re-fetches models; a second click closes")
- it("search filters by name or id (case-insensitive); no match shows 'No model matches \"q\".'")
- it("ArrowDown/Up move .active within bounds; Enter picks; Escape closes and refocuses #model-btn")
- it("sort Cheapest orders by input then output with null last")
- it("sort Priciest orders the reverse with null last")
- it("sort Largest context orders by context desc with null last")
- it("the sort is saved to localStorage pa.modelSort and restored on the next module load; an invalid saved value is ignored")
- it("unavailable model rows are disabled and titled 'OpenRouter no longer lists this model'; Enter does not pick them")
- it("pickModel with no current sets the draft model (no request)")
- it("pickModel on the same model is a no-op")
- it("pickModel on another model PATCHes {model}; failure toasts")
- it("pointerdown outside the menu and button closes it")

Meter:
- it("meter without a current chat: 'Nothing sent yet…' and window from the model's contextLength")
- it("meter with a meter: 'In 12k (3k cached)', 'Out 900 (200 thinking)', 'This chat $0.0123*' when estimated")
- it("meter shows 'Your next question brings 1 new line (about 40 tokens).' and pluralizes")
- it("meter bar gets warn above 80%, plus the 'close to the model's limit' note")
- it("renderChat refreshes the meter via GET /api/chats/:id at most every 4s while open, not while streaming")

Rendering details:
- it("attachment chip: from 0 → 'Transcript · 120 lines · up to 10:12'; later → '+44 new lines'; zero → 'no new lines'; title live vs ended")
- it("assistant message shows 'Stopped.' when stopped, the error text when error, the model short name")
- it("scrollToEnd keeps the empty state at top; sticks to the bottom when within 120px or forced")

**Smells:**
- `chat.ts:57`: `tokens(999_500..999_999)` gives "1000k", and `tokens(999.5..999.99)` gives "1000".
- `chat.ts:61`: `price(0.0004)` gives "$0". A tiny positive price reads as free.
- `chat.ts:176-177`: `list` is assigned before the session check. A list for another session stays in `list`, and `capReached()` and drawSide use it, after the early `return` (which also skips `draw()`).
- `chat.ts:154`: on a session change, the URL's `?chat=` from the previous recording is reused. Chat ids restart per recording (`chat_1`…), so a different recording's `chat_2` could open. Hedged: likely intended only for page load.
- `chat.ts:474` with `select` at 183: selecting another chat in the sidebar mid-stream is not blocked (only New chat is, 199). `drawLog` shows the `#chat-streaming` "writing" bubble whenever `streaming` is set, so it appears in the wrong chat.
- `chat.ts:236`: a starter click (`submit(q)`) clears whatever the user had typed in the composer.
- `chat.ts:251-268`: if the stream ends without `done` (and without an exception), `current` keeps the optimistic messages. finally does not refetch the chat.
- `chat.ts:311`: `capUsd` 0 gives division by zero, so the style width is NaN or Infinity.
- `chat.ts:546`: a local `const window` shadows the global. It works, but is fragile.
- `chat.ts:108,115`: document listeners are added on each `bindChat` call; there is no teardown. This matters for tests that call it repeatedly without resetModules and a new document.

---

## 5. `web/src/calls.ts` (325 lines): the "Fast · slow thinking" and "Jev log" tabs

**Exports:** `money(n)` (13, pure), `renderThinking(st)` (306).

**Private pure helpers:**
- `seconds` 20: <1000 → "N ms", else "N.N s"
- `pct` 21
- `when` 24: session clock if `at >= startedAt`, else locale time
- `purposeOf` 49
- `questionName` 58: QUESTION map; `known_<id>` → "Repeat of claim <id>?"; else pretty + "?"
- `answerText` 61: noul Yes/No with %; choice with `confidence ?? probabilities[choice] ?? 0`; score "x.x of max", where max comes from probabilities/legend keys − 1, min 1; else JSON
- `claimFor` 78
- `memory` 89
- `outcome` 98: only purpose `utterance`. Branches: failed → "No answer in time"; claim → "Flagged: sent to System 2 · verdict X | · dropped | · researching"; `known_*` ≥ 0.6 → "Already checked: a repeat of claim N"; else "Not flagged"
- `shown` 112: `new_utterance` or `segment[]`
- `keyAnswers` 123: utterance/gate → claim, public, worth, boundary; else subject/mode/heat/hype plus any noul ≥ 0.5
- `http` 134, `jevRow` 143, `s2Row` 171
- `feed` 200: last 200 rows, newest first, keeps the scroll position
- `totals` 211
- `modelName` 217: "openai/gpt-6-luna" → "GPT-6 Luna"
- `node` 219, `funnel` 237, `handoff` 258, `thinking` 278

Module state: `expanded` Set (31), `rerender` (33).

**renderThinking(st)** (306):
- If a session exists with both features off: writes the "Jev is off…" text to `#jev-log` and `#think`, clears `#jev-count`, and returns.
- If `#pane-jev` is visible: feed of s1 rows. If `#pane-think` is visible: the diagram, or "Fact-checking is off…" when factcheck is off.
- `#jev-count` is set to the s1 count, or "".

**Browser deps:** DOM only (h/replace, scrollHeight/scrollTop). No APIs. **Side effects:** none; imports in node (verified). `money` is testable in node.

**Unit tests:**
- node: it("money: 0 and NaN → '$0'; 0.000036 → '$0.000036'; 0.0077 → '$0.0077'; 1.239 → '$1.24'; 0.1 → '$0.10'")
- happy-dom, with `#pane-jev`, `#jev-log`, `#pane-think`, `#think`, `#jev-count`:
  - it("both features off: both panes say 'Jev is off for this session…' and the count is empty")
  - it("no session: renders normally (featuresOf defaults on)")
  - it("Jev log hidden pane is not rendered; visible pane lists newest first, max 200")
  - it("Jev log shows the 'Every call to Jev appears here…' empty state")
  - it("jev row: purpose label (Line check), subject from state.new_utterance, latency '850 ms' / '1.2 s', money")
  - it("key answers for an utterance call in order claim, public, worth, boundary; noul yes gets the class 'yes'")
  - it("answerText renders noul Yes (62%) / No (2% yes), choice '<pretty> (39% sure)', score '2.0 of 4'")
  - it("failed jev row shows the error or 'The call failed.' and outcome 'No answer in time…'")
  - it("outcome flagged with verdict 'contradicted' reads '→ Flagged: sent to System 2 · verdict: False'")
  - it("outcome for a dropped claim reads '· dropped'; for a pending claim reads '· researching'")
  - it("outcome for a known_* answer ≥0.6 reads 'Already checked: a repeat of claim c_7'")
  - it("click toggles expansion (aria-expanded, detail with HTTP request/response) and it survives re-render")
  - it("expanded jev row without live questions uses st.calls.questions wording, or '(wording not recorded…)', plus the note")
  - it("memory line lists repeats ≥0.6 or 'no repeat found.'")
  - it("s2 row: parses JSON response verdict → '→ Verdict: Misleading'; a non-JSON response is shown raw")
  - it("s2 row: request missing gives 'recorded before prompts were saved'; web_engine adds plugins")
  - it("thinking diagram: node busy when active>0 ('Thinking' vs 'Idle'); model name from models or the last row")
  - it("value box only when both systems have calls and s2 avgCost>0; shows '<N>× cheaper'")
  - it("funnel counts lines, judged, flagged, researched, verdicts with the False/Misleading/Supported breakdown or 'none yet'")
  - it("handoffs sorted by activity desc, max 60; verdict word or Dropped/Researching…/Queued")
  - it("fact-check off but labels on: the think pane shows the 'Fact-checking is off…' message")
  - it("jev-count shows the s1 row count")
  - it("feed preserves the reader's scroll offset when new rows arrive above (box.scroll with scrollTop>0)"). happy-dom layout is zero; stub scrollHeight.

**Smells:**
- `calls.ts:281`: `Math.max(a.cost, 1e-9)`. If every Jev row has cost 0, the "×cheaper" figure is astronomically large.
- `calls.ts:307`: `rerender` closes over the last `st`. After a reload replaces `st`, a click re-renders stale state until the next render. Minor.
- `calls.ts:149`: the fallback value is a string where an object is expected. Display only.

---

## 6. `web/src/app.ts` (283 lines): app boot, render scheduler, URL sync, SSE

**Exports:** none. Everything is module-private and **the whole module is a top-level program**.

Private functions:
- `nowMs` 24: running uses the wall clock since `sessionStartWall`, else the max utterance `endMs`
- `schedule` 31: batching through rAF
- `markAll` 60, `drawTimeline` 65, `isOpen` 70
- `onOpen(id)` 73: setRoute panel; per-dialog render (recordings, labels, insights section, chat, keys)
- `onFilter` 82
- `reload` 87: `GET /api/state`, falling back to emptyState on error; markAll; loadCalls
- `loadCalls` 99: aborts if a newer st took over; sorts by `at`; sets `models = {s1: s1.models.s1, s2: s1.models.s2}`
- `jumpToTime(ms)` 119: archived → seek; else close the chat, scroll to the last `.utt[data-start] <= ms+999`, and flash it
- `bindTabs` 132: URL `tab` wins over localStorage `pa.rightTab`; show() hides panes, toggles `#tally`, stores
- `followState` 160: pushes /recordings/<id> when archived, or "/"
- `applyRoute(r, why)` 167
- `openPanel(name)` 212: for the desktop menu
- `connect` 221

**Module-level side effects** (`app.ts:251-283`), all run on import:
- bindControls, bindSessionName, bindSplit, bindPlayer, setTimeClick, setPositionListener
- dialog close listeners (258)
- popstate (259)
- bindBespoke (260): installs a MutationObserver on body
- bindTransfer, bindChat (fetches models), bindInsights
- `desktop?.onCommand(openPanel)` (264)
- `#chat-btn` click (265)
- bindTabs
- `checkEngine()` and **`setInterval(checkEngine, 15_000)`** (268)
- bindTimeline, renderLegend, loadDevices (fetch)
- **top-level `await reload()`** (272) and **`await applyRoute(readRoute(),"load")`** (273)
- **`connect()`, which creates `new EventSource("/api/events")`** (274)
- resize listener
- **`setInterval(…, 1000)`** (276): marks health and timeline; resets stale in-flight calls after 30 s (s1) or 120 s (s2)

Importing in a unit test needs all of the following. Otherwise, cover app.ts only by E2E:
- a full index.html body
- a fetch stub for every boot route
- a fake `EventSource` class exposing `addEventListener`, `onerror`, `onopen`, `dispatch(type, data)`
- `vi.useFakeTimers()`, so the intervals don't leak
- `vi.resetModules()`

Minimal seams, if unit coverage is wanted:
- (1) export `EVENT_NAMES` (238-240) and assert it equals `EVENT_TYPES`
- (2) extract `applyRoute`, `followState`, `jumpToTime`, `nowMs` into a module taking dependencies
- (3) wrap the boot (251-283) in an exported `boot()` that returns a teardown

Without seams, a DOM integration test can import it once per test with stubs.

**Browser deps:**
- EventSource (stub in unit; real in E2E)
- rAF
- history/popstate
- `dialog.showModal`/`close`
- localStorage
- `scrollIntoView`
- setInterval
- `window.desktop`

**Integration-style unit tests** (happy-dom, full body, fake fetch, fake EventSource, fake timers; `await import("../web/src/app.ts")` per test after `vi.resetModules()`):
- it("boot GETs /api/state; with a session also GETs /api/calls s1 limit 3000 and s2 limit 200 and fills calls sorted by at")
- it("GET /api/state failure renders the empty state (No session)")
- it("/api/calls failure is swallowed")
- it("an SSE event is applied and rendered in the next animation frame (e.g. utterance appears in #transcript)")
- it("session.started with a new sessionId triggers a second GET /api/state; events arriving meanwhile wait for it")
- it("session.started sets sessionStartWall from data.startedAt, so the clock ticks from it")
- it("s1.version triggers GET /api/state and copies s1.versions")
- it("EventSource onerror adds .down to #conn; onopen removes it")
- it("the 1s interval zeroes calls.active[s1] 30s after the last call.started, s2 after 120s")
- it("checkEngine runs at boot and every 15s")
- it("tabs: clicking 'Jev log' shows #pane-jev, hides #tally, sets ?tab=jev-log, stores pa.rightTab=pane-jev")
- it("tabs: ?tab=thinking wins over the stored tab")
- it("load /recordings/<id> with nothing on air: POST /api/sessions/<id>/open then GET /api/state")
- it("load /recordings/<id> with a failing open: toast 'Recording <id> could not be opened: …', URL '/'")
- it("load /recordings/<id> while running: toast 'A session is on air…', URL '/'")
- it("load / while the engine shows an archived recording: URL replaced with /recordings/<id> (no close call)")
- it("popstate to / while archived: POST /api/sessions/close then reload")
- it("?panel=speakers with no session opens nothing and removes panel")
- it("?panel=recordings opens #dlg-recordings via onOpen (GET /api/sessions)")
- it("?panel=insights&section=log shows the Log tab")
- it("?t=1:23 on an archived recording seeks to 83000 (player)")
- it("session.ended while live pushes /recordings/<id> (history.pushState)")
- it("closing a dialog removes ?panel= when it names that dialog")
- it("desktop.onCommand('keys') closes other dialogs, runs onOpen(dlg-keys) and showModal; an unknown name or an open dialog is ignored")
- it("#chat-btn click opens the chat")
- it("jumpToTime on air closes the chat and flashes the last line starting at or before ms+999; archived seeks instead")
- it("nowMs when not running is the max utterance endMs")

**Smells:**
- `app.ts:35-36`: `const all = dirty.has("session"); if (all || dirty.has("session"))`. Any session change re-renders every panel. The name suggests intent, but the expression is redundant.
- `app.ts:107`: the s2 model is taken from the **s1** response (`s1.models.s2`). The same config is served, so this works by coincidence.
- `app.ts:235`: every `s1.version` refetches the entire `/api/state` (whole transcript) just for `versions`. Costly on long shows.
- `app.ts:226`: `JSON.parse` failure gives an unhandled rejection. No try/catch in `handle`.
- `app.ts:221-249`: on EventSource auto-reconnect the history is replayed into the same `st` (see S-state-1: duplicated errors). If the engine restarted with no session, stale state stays on screen, since no reset is triggered.
- `app.ts:268,276`: intervals are never cleared, which matters only for tests.

---

## 7. `web/src/keys.ts` (279 lines): first-run setup screen and API keys window

**Exports:** `setupStatus()` (50: `api.setup()`, null on any error), `showSetup(status)` (120), `renderKeys(onSaved)` (247).

**Private:**
- `GUIDES` (20)
- `formatProblem(name,key)` (57), **pure**. Branches, in order:
  1. whitespace → "A key has no spaces or line breaks: copy it again."
  2. openai + `sk-or-` → "This is an OpenRouter key: paste it in the OpenRouter field."
  3. openrouter + `sk-` but not `sk-or-` → "This looks like an OpenAI key: OpenRouter keys start with sk-or-."
  4. length < 20 → "This looks too short to be a whole key."
  5. else null
- `keyInput` (66): password field; Show/Hide toggles type, text and aria-pressed; Enter submits
- `steps` (82)
- `saveFields(fields)` (85): "Checking with X…", then per check: class `bad` / `warn` / `good`. Text: "✓ msg" if saved; "msg, not saved until the other key works" if ok but not saved; the failure message; plus the warning span. If saved: clears the input, sets the chip to "Saved · …hint" and the placeholder.
- `padlock`, `trust`, `keyCard` (223)

**Module-level side effects:**
- **`keys.ts:18,20-47`: `GUIDES` calls `link()` → `h("a")` → `document.createElement` at import.** Verified: import fails in node with "document is not defined". It needs a DOM environment.
- Seam: make GUIDES lazy (a function), or export `formatProblem` from a DOM-free module.

**Browser deps:** DOM, focus, `location.reload()` (201, 198: stub it in unit tests with `vi.spyOn(location,'reload')`; happy-dom's may be non-configurable, uncertain), setTimeout 1200 ms, `window.desktop` for the footer text.

**Unit tests** (happy-dom):
- it("formatProblem covers whitespace, OpenRouter key in the OpenAI field, OpenAI key in the OpenRouter field, too short, and valid (sk-… 20+ chars; sk-or-… 20+ chars)")
- it("setupStatus returns the status, or null when fetch rejects or returns 503")

showSetup:
- it("showSetup with both keys missing: body.setup-mode, h1 'Add your two API keys to start', two .setup-field with step numbers 1 and 2, button 'Save keys and start', progress '0 of 2 keys added', first input focused")
- it("showSetup with one key missing: h1 'Add your OpenAI API key to start', button 'Save key and start', '0 of 1 key added', no .key-step")
- it("typing a valid key marks .setup-field.ok, chip '✓ Looks right', progress '1 of 2 keys added'")
- it("typing a valid key into both fields gives 'Both keys added: press Save keys and start', progress.done, button.armed")
- it("typing a bad key marks .bad, chip 'Check this key', .key-msg.bad with the reason")
- it("clearing a field returns the chip to 'Required' with no message")
- it("Save with an empty field marks it 'Paste this key to continue.' and focuses it; no request is made")
- it("Show toggles the input type password↔text, the label Show↔Hide, and aria-pressed")
- it("Enter in a field submits")
- it("Save POSTs /api/setup/keys {openai, openrouter} trimmed; the button is disabled with 'Checking your keys…' meanwhile; double submit is ignored")
- it("a refused key: .key-msg.bad with the server message; the other shows '…, not saved until the other key works'; the button is restored")
- it("saved with no warnings: messages '✓ …', chip 'Saved · …abcd', then 'Open Tattle' + 'All set. Opening Tattle…' and location.reload after 1200ms")
- it("saved with a warning: .key-msg.warn plus the warning span; 'Saved. Read the note above, then open the app.'; no auto reload; clicking Open Tattle reloads")
- it("a network or 500 error shows the general .key-msg.bad with the error message")
- it("the footer names status.path and 'cog menu → API keys' in a browser, 'Tattle → Settings… (⌘,)' with window.desktop set before import")

renderKeys:
- it("renderKeys without #keys is a no-op")
- it("renderKeys: setupStatus null shows 'This server cannot manage keys: restart it with npm run serve.'")
- it("renderKeys shows OpenAI and OpenRouter cards with chips 'Saved · …1234'; an unset key shows the placeholder")
- it("renderKeys with source environment: chip '.env · …1234', note 'Set by OPENAI_API_KEY in .env…', no input")
- it("renderKeys with both keys from the environment hides .key-actions")
- it("renderKeys Save with no input shows 'Paste a key to save.'")
- it("renderKeys Save sends only the filled keys; on saved calls onSaved('API key saved: the next call uses it')")
- it("renderKeys Save failure shows the error; the button is re-enabled")
- it("rendering steps twice moves the shared <a> nodes out of the first render (documents the bug below)")

**Smells:**
- **`keys.ts:18,27-29,40-42` with `82`: the guide links are single DOM nodes created once at import.** `steps(name)` appends the same `<a>` elements every time, and a node can have only one parent. Each render (the keys window re-renders on every open, `app.ts:79`) steals the links from the previous render. Harmless today, because the old render is replaced, but any second simultaneous render loses its links.
- `keys.ts:210`: `GUIDES[names[0]].title` crashes if `configured` is false while no key is missing. The server's logic should prevent this.
- `keys.ts:150`: after `done()` replaces the actions, `finally` re-enables and relabels the detached save button. Harmless.
- `keys.ts:57-62`: there is no OpenAI prefix check (any 20+ chars pass). The server also checks length ≤ 400.

---

## 8. `web/src/transfer.ts` (268 lines): export and import of `.tattle` files

**Exports:**
- `size(bytes)` (17), pure: <1e6 → "N KB" (min 1); <1e7 → "N.N MB"; <1e9 → "N MB"; else "N.N GB"
- `openExport(id)` (34)
- `openImport(file?)` (107)
- `bindTransfer(state)` (242)
- `renderTransferButtons(st)` (263): `#export-btn` hidden unless archived; `#import-btn` hidden while running or ending

**Private:**
- `fits` (24), pure: ≤24e6 "fits email and WhatsApp"; ≤2e9 "fits WhatsApp (2 GB); too big for most email"; else "too big for WhatsApp; share it through a cloud drive"
- `onAir` (30), `upload` (133), `showResult` (165)
- `IMPORTABLE` = `.tattle`, `.conversation-recording`, `.podcast-recording` (11), matched case-insensitively (136)

**Module state:** `getState` throws "bindTransfer first" until bound (14).

**Browser deps:**
- `<dialog>` (#dlg-export, #dlg-import)
- `<input type=file>` `.click()` (116)
- drag and drop with `DataTransfer.types` / `files` (248-259, 119-127): happy-dom's DragEvent/DataTransfer support is uncertain. Dispatch `new Event("drop")` with a defined `dataTransfer` property.
- `<a download>` click (84-87): E2E only for a real download
- XHR via api.importRecording: stub `api.importRecording` by stubbing XMLHttpRequest
- `toLocaleString` (182)

**Side effects:** none. It imports in node (verified), but every function needs the DOM.

**Unit tests:**
- node: it("size: 0 → '1 KB', 950_000 → '950 KB', 1_000_000 → '1.0 MB', 31_000_000 → '31 MB', 1.2e9 → '1.2 GB'; 999_999 → '1000 KB' (edge)")
- happy-dom:
  - it("renderTransferButtons: archived shows Export; running/ending hides Import; none shows Import only")
  - it("bindTransfer: #export-btn opens export for the session on screen; with no session nothing happens")
  - it("#import-btn opens the import dialog")
  - it("openExport shows 'Reading the recording…', closes other dialogs, GETs export info; failure shows .error-text")
  - it("openExport with audio: compressed is checked by default with '≈ 57 MB'; clicking Original re-renders the choice and the foot size")
  - it("openExport without audio: compressed and original are disabled with 'This recording has no audio.'; none is selected")
  - it("the chats switch is disabled when chats=0 ('No chats about this recording.'); otherwise it toggles aria-checked")
  - it("the foot shows fileName, the size and fits text, 'Recorded with v0.7.0 · exported with v0.8.0' or 'Recorded before the app noted its version'")
  - it("Export POSTs {audio, chats}, shows 'Preparing…' plus the compressing note, clicks an <a download=fileName href=/api/exports/<token>>, closes, toasts 'Exported … check your Downloads folder…'")
  - it("Export failure shows the error in status and re-enables 'Export'")
  - it("openImport renders the drop zone and a hidden picker accepting .tattle,.conversation-recording,.podcast-recording")
  - it("Enter or Space on the zone clicks the picker")
  - it("the zone dragover adds .over; dragleave removes it")
  - it("a drop on the zone uploads the first file and stops propagation (the document handler doesn't also fire)")
  - it("upload rejects a wrong extension: toast 'That is not a recording file: it should end in .tattle.' and re-renders the zone")
  - it("upload accepts .TATTLE (case-insensitive) and legacy extensions")
  - it("upload shows 'Importing <name>…' with .bar.waiting; progress removes waiting and sets the width; done>=1 shows 'Unpacking the recording…'")
  - it("upload failure shows the error with 'Try another file' and 'Close'")
  - it("result imported: 'Imported', name, the meta line (date · clock · N lines · speakers), version line, 'no audio: no playback or replay' when hasAudio false")
  - it("result imported: Rename is disabled until the name changes; Rename or Enter PATCHes /api/sessions/:id {name}, re-renders, toasts 'Renamed to X'; failure shows the note")
  - it("result 'Open it' POSTs /api/sessions/:id/open and closes; disabled with its title while on air; failure toasts")
  - it("result already+copyToken: 'You already have this recording', name prefilled '<name> (copy)' selected, 'Open the one I have', 'Import as a copy'")
  - it("import as a copy with an empty name shows 'Give the copy a name.'")
  - it("import as a copy POSTs /api/sessions/import/<token> {name} and shows the new result; failure restores the button")
  - it("result already without copyToken falls through to the imported layout (documents behaviour)")
  - it("a document drag with Files shows #drop; leave hides it at depth 0; drop hides it and opens import with the file; non-file drags are ignored")

**Smells:**
- `transfer.ts:190`: `already && !copyToken` renders the "Imported" layout, which is misleading. Hedged: the server always sends a token.
- `transfer.ts:176`: `disabled: onAir()` is evaluated at render time only.
- `transfer.ts:84`: the token is not URL-encoded (server-generated, so fine).
- `transfer.ts:249`: the `#drop` overlay can show while a modal dialog is open. It is outside the dialog, so it is inert and under the top layer. Hedged cosmetic.
- `transfer.ts:17`: `size(999_999)` gives "1000 KB"; `size(9.96e6)` gives "10.0 MB" but `1e7` gives "10 MB". Cosmetic.

---

## 9. `web/src/ui.ts` (229 lines): bespoke selects, tooltips, autofill off

**Exports:** `place(pop, anchor, gap=4)` (136), `bindBespoke()` (218).

**Private:** `upgradeSelect` (19), `bindTooltips` (148), `upgradeTree` (208).

**Module-level side effects:**
- **`ui.ts:12-13` read `Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value"/"selectedIndex")!`.** This throws in node (verified). In happy-dom, verify both are prototype accessors; if the descriptor is undefined, `valueProp.get!` crashes later.
- `listSeq`, `openList` module state.

**Browser deps:**
- MutationObserver (happy-dom has it)
- popover API and `:popover-open` (probe)
- `:focus-visible` in `matches` (probe)
- `getBoundingClientRect`, `offsetWidth`, `scrollHeight`, `innerWidth`/`innerHeight`: happy-dom returns 0, so stub them
- `scrollIntoView` (probably missing, so stub it)
- `select.labels`
- `closest("dialog[open]")`

**`place` is a quasi-pure geometry function** (DOM reads only):
- `minWidth` = anchor width
- `room = innerHeight - r.bottom - 12`; `ph = min(scrollHeight, 320)`
- above if `room < ph && r.top > room`
- `maxHeight = clamp(120..320, above ? r.top-12 : room)`
- `left = max(8, min(r.left, innerWidth - w - 8))`
- `top`: above → `max(8, r.top - gap - min(ph, r.top-12))`; else `r.bottom + gap`

**Unit tests** (happy-dom; stub `getBoundingClientRect`, `Object.defineProperty(pop, "scrollHeight"/"offsetWidth")`, `window.innerHeight`):

place:
- it("place puts the popover below the anchor with the gap when there is room")
- it("place flips above when there is not enough room below and more above")
- it("place clamps maxHeight to 120..320 and left within 8px of the window edges")

upgradeSelect:
- it("upgradeSelect wraps a select in span.sel with a combobox button showing the selected option; the select is hidden with tabIndex -1")
- it("a title moves from the select to the wrapper")
- it("upgradeSelect is idempotent (data-bespoke)")
- it("setting sel.value or sel.selectedIndex from code updates the label immediately")
- it("replacing options (MutationObserver) or toggling disabled updates the label and the disabled state")
- it("click opens a listbox popover with options, marking selected and disabled; aria-expanded true; aria-controls set")
- it("the list opens inside the nearest open dialog, else in body (regression for the modal inert bug)")
- it("choosing an option sets the value, dispatches input and change once (not when unchanged), closes, refocuses the button")
- it("disabled options can't be chosen by click or Enter")
- it("keyboard closed: ArrowDown/ArrowUp/Enter/Space open")
- it("keyboard open: Arrow, Home/PageUp, End/PageDown move the highlight; Enter/Space choose; Escape closes; Tab closes; keydown does not propagate")
- it("type-ahead jumps to an option starting with the typed prefix; the prefix resets after 700ms")
- it("opening a second select closes the first (single openList)")
- it("blur closes the list unless focus is back on the button")
- it("pointerdown outside .sel and .sel-list closes; window resize closes; scroll outside the list closes")
- it("the label click focuses the bespoke button instead of the hidden select")

upgradeTree and tooltips:
- it("upgradeTree sets autocomplete=off on inputs and textareas without it, and upgrades selects added later (MutationObserver on body)")
- it("tooltips: pointerover a [title] element moves title to data-tip and aria-description, shows .tip after 450ms positioned above, or below (class below) near the top")
- it("tooltips: focusin with :focus-visible shows after 250ms; pointerout, focusout, pointerdown, keydown and scroll hide it")
- it("tooltips: an empty title removes data-tip and shows nothing")
- it("tooltips: the target removed before the delay shows nothing")

**Smells:**
- **`ui.ts:31`**: when a select has no aria-label, its accessible name comes from `sel.labels[0].textContent`. For `<label>Microphone<select>…options…</select></label>` (index.html:212-216) that text includes **every option's text**. So the combobox's aria-label reads, for example, "Microphone Built-in microphone: Built-in microphone", and "People on the call Any number1 on the call…". This is an accessibility bug, and it affects Playwright `getByRole("combobox", {name})` selectors. Use `.sel-btn` inside a scoped container instead.
- `ui.ts:43`: the per-select MutationObserver is never disconnected.
- `ui.ts:12`: the non-null assertions on the descriptors are env-fragile.

---

## 10. `web/src/desktop.ts` (15 lines): Mac-app bridge types

**Exports:** `DesktopCommand`, `DesktopRequest` ("open-licenses" | "open-chromium-licenses" | "show-license-files"), `DesktopBridge {onCommand(cb), run(req)}`, and `desktop` (15) = `globalThis.desktop`, **read once at import**.

**Tests:**
- it("desktop is undefined in a browser")
- it("desktop is the bridge when globalThis.desktop is set before import"). Use `vi.resetModules()` plus `vi.stubGlobal("desktop", {...})`.
- In E2E, `page.addInitScript(() => { window.desktop = { onCommand(cb){ window.__cmd = cb }, run(r){ (window.__runs ||= []).push(r) } } })` emulates the Mac app in a browser.

---

## 11. `web/src/main.ts` (13 lines): boot entry (top-level await)

Side effects on import:
- line 7: adds `body.in-app` if desktop
- line 9: `await setupStatus()`
- line 10: `showSetup` if not configured
- line 12: removes `body.booting`
- line 13: `await import("./app.js")` if status is null or configured

**Unit tests** (happy-dom, reset modules; spy the app import with `vi.doMock("../web/src/app.ts", () => ({}))`):
- it("with window.desktop, body gets in-app")
- it("unconfigured: shows the setup screen, removes booting, never imports app")
- it("configured: removes booting and imports app")
- it("setup route failing (null): imports app anyway")

**Smell:** `main.ts:9`: no timeout. If `/api/setup` hangs, the page stays invisible (`body.booting > * {visibility:hidden}`, styles.css:996).

---

## 12. `web/index.html` (269 lines) and `web/licenses.html` (25 lines) + `web/src/licenses.ts` (96 lines)

index.html provides every id used above, plus:
- the header: `#top`, `#onair`/`#onair-label`, `#conn`, `#features-chip`, `#session-name`, `#clock`, `#speaker-mode`, `#health`, `#cost`, `#export-btn`, `#import-btn`, `#start-live`, `#pause`, `#stop`, `#chat-btn` (`.dot`), `#replay-btn.browser-only`, `#cog-btn`, `#replay-pop`, `#cog-menu`
- cog menu items `[data-open=dlg-recordings|dlg-insights|dlg-speakers|dlg-labels|dlg-keys]`; `dlg-keys` is `.browser-only`
- `#app-version`, `#license-link` (`.menu-foot.browser-only`)
- `#stale`
- `#transcript`, `#filters`, the tabs `.tabs .tab[data-pane]`, `#tally`, `#claims`, `#think`, `#jev-log`, `#jev-count`, `#claims-count`
- the timeline: `#tl`, `#player`, `#play`, `#play-speed`, `#play-boost`, `#legend`, `#zoom-*`, `#timeline`
- dialogs: `#dlg-recordings`, `#dlg-speakers`, `#dlg-labels`, `#dlg-insights` (tabs `[data-section]`), `#dlg-keys` (`#keys`), `#dlg-chat` (`#chat`, `#chat-sub`), `#dlg-start` (`#mic`, `#voices`, `#feat-factcheck`, `#feat-labels`, `#start-summary`, `[data-cancel]`, `#start-go`), `#dlg-export`, `#dlg-import`, `#drop`, `#dlg-speaker`, `#dlg-ask` (`form[method=dialog]`, `#ask-input`, `#ask-ok[value=ok]`)
- `#toasts[popover]`
- `<script type=module src=/dist/main.js>`
- `body.booting` initially

CSS hooks: `body.booting > *` hidden (styles.css:996); `body.setup-mode` shows only `#setup` and `#toasts` (997); `body.in-app .browser-only {display:none}` (1098).

licenses.html: `#lic-search`, `#lic-list[role=listbox]`, `#lic-desktop[hidden]` (`#lic-chromium`, `#lic-finder`), `#lic-detail`; script `/dist/licenses.js`.

licenses.ts side effects on import:
- document keydown ArrowUp/Down (76)
- `$("#lic-search")!` listener (84): **throws if the markup is missing**
- desktop buttons (85-89)
- **top-level `await api.licenses()`** (91)

Pure helpers inside: `linkify` (14, bare URL → `[u](u)`, skips code fences and trailing punctuation) and `items` (27, group renames).

Unit-test it with the licenses.html body plus a fetch stub:
- it("lists 'This app' first and selects it")
- it("group titles are renamed")
- it("search filters, or shows 'Nothing matches.'")
- it("ArrowDown/Up select and focus the next item")
- it("full texts over 60000 chars start folded")
- it("the holder email is stripped")
- it("a fetch failure shows 'The licenses could not be loaded: …'")
- it("with desktop, the #lic-desktop buttons call run('open-chromium-licenses'/'show-license-files')")

---

## 13. E2E scenarios (Playwright, against `createApiServer(fakeEngine, {webRoot:"web", setup})`)

Common setup:
- Chromium, `baseURL http://127.0.0.1:<port>`, `waitUntil: "domcontentloaded"`, then `await expect(page.locator("body")).not.toHaveClass(/booting/)`.
- The fake engine records calls (like `tests/server.test.ts` FakeEngine) and emits via `bus.emit`.
- For in-app variants, use the `addInitScript` window.desktop stub (§10).

**E1. First run, both keys missing**
- Routes: GET /api/setup → `{configured:false, keys:[{name:"openai",env:"OPENAI_API_KEY",set:false,source:null,hint:null},{name:"openrouter",…}], path:"~/Library/Application Support/Tattle/credentials.json"}`; POST /api/setup/keys.
- Steps and expectations:
  - `main#setup` is visible and `#top` is hidden (setup-mode). `h1` reads "Add your two API keys to start". `.setup-progress` reads "0 of 2 keys added". `.setup-go` reads "Save keys and start".
  - Click Save while empty: both `.setup-field.bad`, `.setup-badge` "Check this key", `.key-msg` "Paste this key to continue.". **No POST.**
  - Fill `input[aria-label="OpenAI API key"]` with "sk-or-…" (≥20 chars): `.key-msg` "This is an OpenRouter key: paste it in the OpenRouter field.".
  - Fill a valid `sk-proj-XXXXXXXXXXXXXXXXXXXX`: the badge reads "✓ Looks right" and the progress "1 of 2 keys added".
  - Fill OpenRouter with `sk-or-v1-XXXXXXXXXXXXXXXX`: "Both keys added: press Save keys and start", `.setup-go.armed`.
  - Show button toggles the input type to text and the label to "Hide".
  - **Invalid key:** the fake setup.save returns `{saved:false, checks:{openai:{ok:false,message:"OpenAI refused this key (401)"}, openrouter:{ok:true,message:"Key works"}}, …}`. Expect the OpenAI `.key-msg.bad` with that message, the OpenRouter `.key-msg.good` "Key works, not saved until the other key works", and the button re-enabled with "Save keys and start".
  - **Both valid:** save returns `saved:true` with hints, and afterwards status reports `configured:true`. Expect "✓ Key works" and the badge "Saved · …abcd". Then "Open Tattle" plus "All set. Opening Tattle…", and **the page reloads by itself after ~1.2 s**. After the reload the app shell shows (`#top` visible, `#session-name` "No session"). The requests after the reload include GET /api/state and /api/events.
  - **Warning variant:** `checks.openrouter = {ok:true, message:"Key works", warning:"No credit limit on this key."}`. Expect `.key-msg.warn`, "Saved. Read the note above, then open the app.", **no** auto reload; click "Open Tattle" to reload.
  - **Server error:** POST returns 500 `{error:"boom"}`. Expect the general `.setup-actions .key-msg.bad` "boom".
- Variant, one key missing: h1 "Add your OpenAI API key to start", "Save key and start", "0 of 1 key added".
- In-app variant: the footer contains "Tattle → Settings… (⌘,)".

**E2. API keys window** (configured)
- Routes: GET /api/setup, POST /api/setup/keys.
- Steps:
  - Click `#cog-btn`, then `[data-open="dlg-keys"]`: `#dlg-keys[open]`, URL `?panel=keys`. `.key-card h2` "OpenAI"/"OpenRouter", `.key-chip` "Saved · …1234".
  - Save with nothing typed: "Paste a key to save.".
  - Paste an OpenRouter key and Save: the POST body has **only** `openrouter`; a toast `.toast.ok` "API key saved: the next call uses it".
  - An environment-sourced key shows "Set by OPENAI_API_KEY in .env…" with no input.
  - Close ×: the URL loses `panel`.
- In-app: the cog item is hidden (`.browser-only`). Instead, `window.__cmd("keys")` (the desktop onCommand) opens `#dlg-keys`.

**E3. Start live**
- Routes: GET /api/devices → `[{uid:"usb1",name:"Rode",transport:"usb",isDefault:false},{uid:"b",name:"MacBook",transport:"builtin",…}]`; POST /api/session/start. Then the fake emits `session.started{sessionId:"20260929-120000", mode:"live", s1Version:"s1@1", labelSetVersion:"v", startedAt, features}` and GET /api/state returns a running snapshot.
- Steps:
  - Click `#start-live`: `#dlg-start[open]`. `#feat-factcheck` and `#feat-labels` have `aria-checked="true"`. `#start-summary` reads "Everything on" + "About $1.62 an hour at most.". The microphone list shows "Built-in microphone" and "Rode (usb)" (the builtin device is filtered out).
  - Toggle `#feat-factcheck`: "No fact-checking" / "About $1.27 an hour.".
  - Toggle `#feat-labels` too: "Transcript only: Jev and System 2 are not called" / "About $1.23 an hour.".
  - Toggle fact-check back on: "No labels" / "About $1.62 an hour at most.".
  - People: open the bespoke select inside the dialog (`#dlg-start .sel.voices .sel-btn`; don't rely on the combobox name, see the ui.ts:31 smell). Choose "2 on the call". Microphone: choose "Rode (usb)". **This is the regression for the list-inside-a-modal gotcha:** a mouse click must work.
  - `#start-go`: the dialog closes. The POST body is `{mode:"live", mic:"usb1", voices:2, features:{factcheck:true, labels:false}}`. localStorage has `pa.mic="usb1"`.
  - After `session.started`: `#onair` is visible with "On air", `#stop` visible and enabled, `#pause` visible, `#start-live` disabled, `#features-chip` "No labels", `#import-btn` hidden, `#export-btn` hidden, `#tl.labels-off`.
  - Reopening Start live resets people to "Any number" and both switches to on, and preselects the last microphone.
- Variants:
  - Cancel `[data-cancel]` sends no POST.
  - /api/devices 500: `#mic` shows "Capture helper unavailable".
  - POST 409 `{error:"a session is already running"}`: an error toast.
- Pause/Stop: `#pause` POSTs /api/session/pause, toast "Paused: nothing is heard…". After `session.paused{atMs}` the button reads "Resume". `#stop` POSTs /api/session/stop, toast "Stopping: in-flight work will finish". After `session.ended`: the URL is pushed to `/recordings/<id>`, `#export-btn` shows, `#import-btn` shows.

**E4. Chat** (a session on screen; the fake ChatApi implemented in the harness)
- Routes: GET /api/chat/models `{default:"openai/gpt-6-luna", capUsd:2, models:[{id:"openai/gpt-6-luna", name:"OpenAI: GPT-6 Luna", contextLength:1050000, inputUsdPerM:1.25, outputUsdPerM:10, …, available:true}, {…"anthropic/claude-sonnet-5"…}, {…, available:false}]}`; GET /api/chats `{sessionId:<on screen>, spentUsd:0, capUsd:2, chats:[]}`; POST /api/chats; POST /api/chats/:id/messages (SSE); POST /api/chats/:id/stop; GET/PATCH/DELETE /api/chats/:id.

Steps:
- **Open:** press `Meta+K` (or `Control+K`) → `#dlg-chat[open]`, URL `?panel=chat`, `#chat-sub` "About <name> · on air", `#chat-log .starters .starter` ×4, `#chat-list .note` "No chats yet. Your first question starts one.", `#chat-meter` "Nothing sent yet: a new chat costs nothing until you ask.", `#chat-spend` "$0.0000 of $2.00". Clicking `#chat-btn` also opens it.
- **Send and stream:**
  - Type into `#chat-input`, press Enter. POST /api/chats `{model:"openai/gpt-6-luna"}` → `chat_1`, URL `&chat=chat_1`, then POST messages `{content, mode:"send"}`.
  - The fake stream emits `start{user, assistantId}`, `thinking`, several `delta` with ~100 ms gaps, then `done{message, chat}`.
  - Expect `.msg.user .bubble` with the text, `#chat-streaming .typing` with " Thinking…", then streamed markdown, `#chat-send` "Stop" with class `stop`, and `#chat-btn .dot` visible.
  - After `done`: `.msg.assistant` with rendered markdown, `#chat-send` "Send", the dot hidden, the sidebar row "chat_1 title · GPT-6 Luna · $0.0012", and `.chip-attach` "Transcript · 12 lines · up to 1:02".
  - Shift+Enter inserts a newline without sending.
- **Stop:** during deltas, press Escape in the input (or click Stop). POST /api/chats/chat_1/stop. The fake finishes with `done{message:{stopped:true}}`: "Stopped." note, and the meter's "This chat $x*" when estimated.
- **Error:** the stream sends `error{message:"No provider…"}` then `done`: a toast with the message, `.msg.assistant.failed` with a "Retry" button. Retry POSTs `{mode:"regenerate"}`.
- **Edit:** press ArrowUp in the empty input: `#chat-edit` textarea with the last question. Change it, press Enter: POST `{content, mode:"edit"}`.
- **Cited time:** the reply content "At [1:02] …" renders a time button (markdown.ts). Clicking it on air closes the chat and flashes `#transcript .utt` (class `flash`). On an archived recording it seeks the player, and the chat stays open.
- **Model picker:**
  - Click `#model-btn`: `#model-menu` popover open, `#model-search` focused.
  - Type "claude": only matching `.model-row`.
  - ArrowDown, Enter picks. With no chat yet, no request (the draft model). With a chat: PATCH `{model}`.
  - The unavailable row is `disabled`. Sort buttons `[aria-pressed]`: Cheapest reorders; reload the page, reopen, and Cheapest is still pressed (localStorage `pa.modelSort`).
  - Escape closes the menu but not the dialog.
- **Sidebar:** Rename (✎, aria-label "Rename <title>") → `#dlg-ask` with `#ask-input`, OK → PATCH `{title}`. Delete (aria-label "Delete <title>") → confirm → DELETE; the current chat is cleared.
- **+ New chat** clears the log to the starters and removes `chat=` from the URL.
- **Cost cap:** GET /api/chats returns `{spentUsd:2, capUsd:2}`. Then `#chat-input` is disabled with placeholder "Chat spend reached its $2.00 cap for this recording", `#chat-send` disabled, starters disabled, `#chat-spend .error-text`.
- **No session:** open with state `{session:null}`: "Start a session or open a recording to chat about its transcript." and the composer disabled.
- **Deep link:** load `/recordings/<id>?panel=chat&chat=chat_2` (the recording has chat_2). The chat dialog opens with chat_2 loaded (GET /api/chats/chat_2) and `aria-current` on its row.
- **Busy chat:** GET /api/chats/chat_2 returns `busy:true`, then after 2 s `busy:false` with a reply. The reply appears without user action; the row shows "writing…" meanwhile.
- **Meter refresh:** on air, with the chat open and new `utterance` events, GET /api/chats/:id at most every 4 s. The `.pending` row reads "Your next question brings N new lines (about T tokens).".

**E5. Export `.tattle`** (an archived recording on screen)
- Routes: GET /api/sessions/:id/export → ExportInfo; POST /api/sessions/:id/export → `{token:"t1", fileName:"Pilot.tattle", bytes:56700000}`; GET /api/exports/t1 → attachment bytes (the fake `transfer.file(token)` returns a temp file).
- Steps:
  - `#export-btn` is visible only when archived. Click it: `#dlg-export[open]`, `#export-sub` shows the name, "Compressed audio" `aria-checked=true` with "≈ 57 MB", and the foot "About 57 MB: fits WhatsApp (2 GB); too big for most email." with the versions line.
  - Choose "No audio" (≈ 3 MB): "fits email and WhatsApp".
  - Toggle "Include my chats" (disabled when chats=0).
  - `page.waitForEvent("download")` + click Export. The download's suggestedFilename is "Pilot.tattle". The POST body is `{audio:"none", chats:true}`. The dialog closes, toast "Exported Pilot.tattle (3.0 MB): check your Downloads folder…".
- Error: POST 409 → `.error-text` in the status, button back to "Export".
- Also from the Recordings window's row (panels.ts, other scanner).

**E6. Import via file chooser and drag-drop**
- Routes: POST /api/sessions/import (header X-File-Name), POST /api/sessions/import/:token, PATCH /api/sessions/:id, POST /api/sessions/:id/open, then the fake emits `session.started` with the imported id.
- File chooser:
  - Click `#import-btn`: `#dlg-import[open]`, `.drop-zone`.
  - `page.waitForEvent("filechooser")` + click `.drop-zone`, then `setFiles({name:"Pilot.tattle", mimeType:"application/octet-stream", buffer})`.
  - Expect `.import-progress` ("Importing Pilot.tattle…", then possibly "Unpacking the recording…"). In Chromium over HTTP, upload progress fires; on app:// it never fires (gotcha), so the bar stays `.bar.waiting`. Assert the final state only.
  - Then `.import-done` "Imported", a name input with the name, Rename disabled. Edit the name and press Enter: PATCH `{name}`, toast "Renamed to …".
  - "Open it": POST /api/sessions/:id/open; the dialog closes. After `session.started` the page shows the recording: URL `/recordings/<id>`, `#export-btn` visible.
- Wrong extension: `notes.txt` → toast "That is not a recording file: it should end in .tattle.", and the zone is shown again. No POST.
- Legacy extension: `x.podcast-recording` is accepted.
- **Drag-drop on the page:** dispatch `dragenter` / `dragover` / `drop` on `document`, with a `DataTransfer` built in `page.evaluateHandle` (`new DataTransfer(); dt.items.add(new File([...], "Pilot.tattle"))`). `#drop` overlay becomes visible on dragenter and hidden on drop; the import dialog opens and the upload starts.
- Drop on `.drop-zone` inside the open dialog: `.over` class during dragover, the upload starts, and the document handler does not also fire (one POST).
- **Duplicate → copy:** import returns `{already:true, copyToken:"c1", summary:{id:"x", name:"Pilot", …}}`.
  - Expect "You already have this recording", the input value "Pilot (copy)" selected, buttons "Import another", "Open the one I have", "Import as a copy".
  - Clear the name and click Import as a copy: "Give the copy a name.".
  - With a name: POST /api/sessions/import/c1 `{name:"Pilot (copy)"}` → "Imported" with the new id `x-2`.
- On air: the Import button is hidden; within the result, the open buttons are disabled with the title "Stop the current session to open it".
- Upload error: 409 `{error:"a session is on air"}` shows `.error-text` plus "Try another file" / "Close".

**E7. Deep links and history**
- Routes: GET /api/state, POST /api/sessions/:id/open, POST /api/sessions/close, GET /api/sessions/:id/audio (with Range).
- Cases:
  - Load `/recordings/20260925-120000?t=1:23` with no session: POST open, the state becomes archived (the fake `state()` switches to the archived snapshot), the player `#player` is visible, and the audio `currentTime` is ≈83 s (`page.evaluate` on the `<audio>`, or `#play-time`).
  - Playing then pausing updates `?t=` (player).
  - Load with an unknown id (the fake openSession throws `ApiError(404,"unknown session")`): toast "Recording nope could not be opened: unknown session", URL `/`.
  - Load `/recordings/x` while the state is running: toast "A session is on air, so it is shown instead of the recording.", URL `/`.
  - Load `/` while the engine serves an archived recording: the URL becomes `/recordings/<id>` (replace, not push).
  - From a recording, `page.goBack()` to `/`: POST /api/sessions/close, then "No session".
  - `?tab=jev-log`: the Jev log pane is shown.
  - `?panel=insights&section=fact-checker`: the Insights Fact-checker tab. `?panel=system-1` (legacy) opens the same, and the URL is rewritten.
  - `?panel=speakers` with no session: no dialog, and `panel` is removed from the URL.
  - `?panel=recordings`: the Recordings dialog opens (GET /api/sessions).
  - Invalid `?panel=nope`: ignored.

**E8. Settings / cog menu**
- Routes: GET /api/about → `{name:"Tattle", version:"0.8.0", …}`, GET /api/sessions, GET /api/speakers/suggestions.
- Steps:
  - `#cog-btn`: `#cog-menu` visible, `aria-expanded=true`. The footer `#app-version` reads "v0.8.0" with title "Tattle 0.8.0".
  - Escape or an outside click closes it.
  - With no session: `[data-open=dlg-speakers]` and `[data-open=dlg-labels]` are disabled, `#m-speakers` reads "Start or open a recording".
  - With a session and `stats{roganIndex:0.25}` plus an `error` event: `#m-insights` contains "Off-topic 25%", "N flags" and `em.error-text` "1 error".
  - Each item opens its dialog and sets `?panel=`.
  - `#replay-btn` (browser-only) popover; `#start-replay` POSTs `{mode:"replay", dir:"fixtures/conversation", speed:1|"max", voices}`.
- In-app (the desktop stub): `body.in-app`; the API keys item, the footer and `#replay-btn` are hidden. `window.__cmd("recordings")` opens `#dlg-recordings` and closes others.
- Stale engine: GET /api/engine `{stale:true}` shows `#stale`; a 404 also shows it.

**E9. About / Licenses page**
- Browser: `#cog-btn`, then `#license-link`. `context.waitForEvent("page")` (window.open with `noopener`, so use the context's page event rather than `popup`, to be safe). The new page is `/licenses`, which GETs /api/licenses.
- Expect `.lic-item` first "This app" with `aria-selected=true`, `#lic-detail h1` "This app", `.lic-meta` "Tattle 0.8.0 · Cloudless Consulting Pty Ltd" (email stripped).
- Type in `#lic-search` to filter. Nonsense shows "Nothing matches.".
- ArrowDown moves the selection.
- Group headings "Built into the app" / "npm packages".
- A >60 kB text has `details.lic-file` not open.
- /api/licenses 500: "The licenses could not be loaded: …".
- In-app: `#license-link` is hidden. On the `/licenses` page with the desktop stub, `#lic-desktop` is visible and its buttons push "open-chromium-licenses" / "show-license-files" into `window.__runs`. The in-app `#license-link` path calls `desktop.run("open-licenses")`, but it is hidden by CSS, so test it via `page.evaluate(() => document.querySelector('#license-link').click())`.
- Note: `/api/licenses` is in OPEN_ROUTES, so it works before the keys are set.

**E10. Live transcript and SSE plumbing** (overlaps other scanners; listed for the fake-engine contract)
- Emit `speaker.created`, `utterance.partial` (transient), then `utterance`: the partial line is replaced by the final one.
- `health` every second: `#health` meters.
- `claim.flagged`, `claim.researching`, `claim.verdict`: cards in `#claims`, and the Fast · slow tab funnel.
- `call.started{system:"s1"}` (transient): the node shows "Thinking"; `call{kind:"jev_call", …}` returns it to "Idle", with the row in `#jev-log` and `#jev-count` "1".
- Kill and restart the SSE response: `#conn.down`, then reconnect and replay (S-state-1: error duplicates in Insights → Log).

**Electron (optional, slow).**
- Playwright `_electron.launch({ args: ["."] })` after `npm run build:web && npm run build:desktop`. The page is `app://conversation-assistant/`, the engine is real and in-process, and it needs keys: point `TATTLE_CREDENTIALS` at a temp file, or run the first-run flow against real checks (network).
- Assert: `body.in-app`, the menu command via the app menu, and import progress staying `.waiting` (the gotcha).
- A packaged build cannot be driven (`--remote-debugging-port` exits).

---

## 14. Consolidated latent bugs and smells (hedged)

1. `state.ts:342` + `app.ts:221`: error events are duplicated after an EventSource auto-reconnect (history replay). *Likely.*
2. `api.ts:18`: an empty error body gives an empty ApiError message, so toasts are blank. *Likely.*
3. `api.ts:117` → `transfer.ts:168`: a 2xx non-JSON import response crashes `showResult(null)`. *Edge.*
4. `keys.ts:18-47,82`: shared `<a>` nodes are moved between renders of the guide steps. *Certain mechanism, currently invisible.*
5. `keys.ts:210`: crash if unconfigured with no missing key. *Edge.*
6. `chat.ts:176-177`: a stale other-session list is kept in `list` (affects capReached). *Race edge.*
7. `chat.ts:154`: the URL chat id is reused across a recording switch. *Possible wrong chat.*
8. `chat.ts:474` / `183`: the "writing" bubble shows in another chat when switching mid-stream. *Likely UI glitch.*
9. `chat.ts:236`: a starter click wipes the typed draft. *Minor.*
10. `chat.ts:57`: `tokens` rounds up to "1000k" / "1000". `chat.ts:61`: `price` of a tiny value gives "$0". *Cosmetic.*
11. `chat.ts:311`: `capUsd` 0 gives NaN/Infinity width. *Edge.*
12. `ui.ts:31`: the combobox accessible name includes all option texts, because the label wraps the select. *Likely a11y bug; affects selectors.*
13. `calls.ts:281`: a huge "×cheaper" figure when Jev cost is 0. *Edge.*
14. `app.ts:107`: the s2 model is read from the s1 response. *Harmless.*
15. `app.ts:235`: a full `/api/state` refetch per `s1.version`. *Perf.*
16. `app.ts:35-36`: the redundant `all` flag, so a session change re-renders everything. *Smell.*
17. `app.ts:226`: an unguarded `JSON.parse` in the SSE handler. *Edge.*
18. `main.ts:9`: no timeout on the setup check, so the page could stay invisible. *Edge.*
19. `api.ts:78`: the SSE parser drops the final unterminated block and assumes `\n\n` framing. *Robustness.*
20. `transfer.ts:190`: `already` without `copyToken` shows "Imported". *Edge.*
21. `router.ts:36`: parseTime is lenient (fractions, exponents, empty parts). `router.formatTime` duplicates `dom.clock`. *Smell.*

## 15. Coverage plan summary (cheapest first)
1. Node environment, no stubs: `state.ts` (all), `router.ts` pure functions, `calls.money`, `transfer.size`.
2. Node environment + fetch/XHR stubs: `api.ts` (all), `router.setRoute` (stub location/history), `desktop.ts`.
3. happy-dom + shims (popover, :popover-open, scrollIntoView, clipboard, EventSource): `keys.ts`, `transfer.ts`, `calls.renderThinking`, `ui.ts`, `chat.ts`, `licenses.ts`, `main.ts`, and `app.ts` as an integration import with fake timers.
4. Playwright against `createApiServer(fakeEngine)`: E1–E10. This is the only realistic coverage for real dialog/popover top-layer behaviour, downloads, file choosers, drag-drop, history, and SSE reconnects.
