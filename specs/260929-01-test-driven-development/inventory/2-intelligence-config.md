> **Inventory for [SPEC.md](../SPEC.md) — Area 2: Jev client, fact-checker (System 1/2), chat, budget, config, keys, paths, licenses, version.** Written 2026-09-29 by a read-only scan of commit `74b42a6`. Line numbers were right at that commit; **symbol names win when lines drift** (grep them). "Spike" and "scratchpad" mentions refer to throwaway experiments run outside the repo during the scan; they are not available to you, but every recipe they validated is written out below. Items marked *unverified*/*UNSURE*/*hedged* are exactly that — verify before relying on them. SPEC.md overrides this file wherever they disagree (scope, thresholds, bug policy, file layout).


# Scan: intelligence + config area (jev, factcheck, chat, budget, config, keys, paths, licenses, version)

Scanner scope: `src/jev/{client,types}.ts`, `src/factcheck/{s1,s2,queue,gate}.ts`, `src/chat/chat.ts`, `src/budget.ts`, `src/config.ts`, `src/keys.ts`, `src/paths.ts`, `src/licenses.ts`, `src/version.ts`, `config/*.json`; tests `tests/{jev,factcheck,chat,config,keys,desktop}.test.ts` (+ excerpts of `server/session/transfer.test.ts`), `tests/helpers.ts`, `tests/setup.ts`.

Baseline run (2026-09-29): `npx vitest run tests/jev.test.ts tests/factcheck.test.ts tests/chat.test.ts tests/config.test.ts tests/keys.test.ts tests/desktop.test.ts` → 6 files, 70 tests, all pass, 464 ms.
No coverage provider installed (`node_modules/@vitest/` has only `mocker`, `spy`): measuring ~100% needs `@vitest/coverage-v8` added as a devDependency (spec decision, not done here).

Note: `tests/retry.test.ts` is NOT about the Jev client's retries — it tests `Session` transcription retry (`src/pipeline/session.ts`) with a `flaky()` fake `Services`; out of this area.

---

## Global test environment facts (read first)

- `tests/setup.ts:2` replaces `globalThis.fetch` with a function that throws `"network disabled in tests"`. Every client in this area takes `fetch` via constructor/opts, so fakes are mandatory; any code path that falls back to global fetch fails loudly.
- `vitest.config.ts`: `include: ["tests/**/*.test.ts"]`, `testTimeout/hookTimeout: 120_000`, `setupFiles: ["tests/setup.ts"]`. Tests run from project root; `loadConfig()` defaults to relative `"config"` (cwd-relative).
- `tests/helpers.ts`: `FIXTURE_DIR` (`fixtures/conversation`), `requireAssets()` (throws "run npm run models && npm run fixtures" if models/fixtures missing), `ScriptLine`, `loadScript()`. None needed for this area's unit tests.
- DANGER: `new KeyStore()` with no `path`/`env`, `loadKeys()`, `credentialsPath()` with real env, `migrateAppSupportDir()` / `appSupportDir()` with no `base` touch the real `~/Library/Application Support/Tattle` (the user's real keys). Tests must always pass `path`+`env`, a `base`, or set `process.env.TATTLE_CREDENTIALS` to a tmp file (and restore).
- DANGER: `sumDevSpend()` with no arg reads `appPaths().sessions` = relative `"sessions"` = the repo's real recordings. Always pass a tmp dir or `setAppPaths({ sessions: tmp })` + `afterEach(() => setAppPaths())`.
- `processSecrets()` (`src/store/events.ts:62`) reads `process.env.OPENROUTER_API_KEY` / `OPENAI_API_KEY` on every chat row write; `redactor` ignores secrets shorter than 8 chars (`events.ts:57`). Tests that set these env vars must restore them.

---

## 1. `src/jev/types.ts` (87 lines)

Purpose: zod schemas for Jev Decisions API question shapes (authoring rules enforced) + answer types and accessor helpers.

Exports:
- `NoulQuestion` :4 — `{type:"noul", instructions:min1, criteria?:{true:min1,false:min1}.strict()}.strict()`
- `ChoiceQuestion` :10 — `criteria: record<string,min1 string>`; superRefine :14: <2 keys → "a choice needs at least 2 options"; >255 → "a choice has at most 255 options"; no fallback key → "a choice needs a fallback option: `none` or a key starting with `other`".
- `ScoreQuestion` :23 — criteria array min 2 ("a score needs at least 2 levels"), max 10 ("a score has at most 10 levels").
- `JevQuestion` :29 (union), types :30-33.
- `QuestionId` :35 regex `^[a-z][a-z0-9_]*$` msg "question ids are snake_case"; `QuestionSet` :36-37.
- `isFallbackOption(key)` :39 — `key === "none" || key.startsWith("other")` (so `"otherwise"` counts).
- Answer types :43-48; `JevAnswerSchema` :50 (passthrough union; NOT used by the client — unverified whether used elsewhere).
- `JevUsage` :61, `JevResponse` :63, `StateUtterance` :72.
- `noul(answers, id)` :74, `choice()` :79, `score()` :84 — return null when missing or wrong `type`.

Side effects: none. Seams: pure.

Covered: indirectly via config.test (fallback, <2 levels, snake_case) and factcheck.test (accessors via flagDecision).

NOT covered — tests to write:
- `it("isFallbackOption accepts none, other, other_x, otherwise; rejects None, x_other")`
- `it("ChoiceQuestion rejects 1 option, accepts 2 with fallback, rejects 256 options")`
- `it("ScoreQuestion rejects 11 levels and accepts 10")`
- `it("NoulQuestion rejects extra keys and criteria with extra keys (strict), and empty instructions")`
- `it("QuestionId rejects '1abc', 'Abc', 'a-b'; accepts 'a', 'a_1'")`
- `it("noul/choice/score return null for undefined answers, missing id, and wrong answer type")`
- `it("JevAnswerSchema accepts each answer type with extra fields and rejects a noul without a number")`

---

## 2. `src/jev/client.ts` (291 lines)

Purpose: raw-fetch client for OpenRouter's Decisions API (Jev) with shared concurrency limit (live-first), shared pause, bounded retries, budget checks, and one log row per call.

Exports:
- `DECISIONS_URL` :6 = `https://openrouter.ai/api/alpha/decisions`
- `JevPurpose` :8 = utterance|segment|relabel|gate|preflight|smoke; private `LIVE` :9 = {utterance, segment}.
- `class HttpError` :12 — `(status: number|null, body, retryAfterMs=null, message?)`; default message: status null → body; else `HTTP ${status} ${body.slice(0,300)}`.
- `RetryClass` :18; `classifyError(e)` :21 — non-HttpError→fail; null→retry; 2xx→ embedded code (null→retry, else recurse); 429 or ≥500→retry; 402 + transient→retry; else fail.
- `embeddedErrorCode(body)` :35 — parses from first `{`; `error.code` number ≥400 else null.
- private `isTransient402` :46 — `error.metadata.limit_source === "openrouter_in_flight_budget"`.
- `effectiveStatus(e)` :57 — 2xx → embedded code (may be null), else status.
- `backoffMs(attempt, retryAfterMs, rand=Math.random)` :62 — `(retryAfterMs ?? min(30000, 1000*2^attempt)) + floor(rand()*500)`.
- `parseRetryAfter(ra, now=Date.now())` :66 — null→null; numeric string → seconds*1000; else `max(0, Date.parse(ra)-now) || null`.
- `JevCallRow` :72, `JevCallMeta` :94 (`timeoutMs`, `maxAttempts`, `live` overrides), `JevClientDeps` :105 (`fetch, apiKey, budget, log(row, questions?), onStart?, sleep?, rand?`).
- `class JevClient` :118 — `constructor(cfg: AppConfig["jev"], deps)` :124; `get pausedUntil` :142; `ask(state, questions, meta)` :146.
  - private `acquire(high)` :130 / `release()` :135 — concurrency `cfg.concurrency`; waiters in `high` (live) then `low` queues; release hands the slot directly to next waiter (active not decremented).
  - private `settings()` :156 — timeout: meta.timeoutMs ?? (utterance→utteranceTimeoutMs 3000, segment→segmentTimeoutMs 5000, else backgroundTimeoutMs 30000); maxAttempts: meta ?? (live ? maxAttempts 2 : backgroundMaxAttempts 5).
  - private `callWithRetry` :165 — budget `assertCanSpend("jev:<purpose>")` first; on throw logs row `{ok:false, attempts:0}` and rethrows (:169-174). Then `onStart(purpose)` once (:175). Loop: background waits `pauseUntil - Date.now()` via `sleep` before each attempt (:178-181); success → `budget.record("jev", cost)`, log ok row. On error: `pauses` = status 429 or 402 (effective); if retry && pauses → `pauseUntil = max(pauseUntil, now + backoff(attempt, retryAfterMs))` (live included). Stop when `fail` || attempt ≥ max || (live && !liveRetryable) — live never retries a 429/transient-402. On stop: log fail row; if effective 402 && fail → `budget.exhaust("provider", "jev:<purpose>", "OpenRouter credits or key limit exhausted (402)")` (throws BudgetExhaustedError); if 401 → throw new `HttpError(401, body, null, "OpenRouter rejected the API key (401): check OPENROUTER_API_KEY")`; else rethrow. Background non-pause retryable errors ALSO set the shared pause (:207-210).
  - private `send` :215 — POST with headers `Authorization: Bearer <key>`, `Content-Type: application/json`, `X-OpenRouter-Title: Tattle`; body `{model, state, questions, provider?}` (provider only if `cfg.provider`); `signal: AbortSignal.timeout(timeoutMs)`. fetch reject → `HttpError(null, errorText)`; `res.text()` reject → `HttpError(null)`; `!res.ok` → `HttpError(status, text, retryAfter)`; no `{` or bad JSON → `HttpError(status...)`; `body.error` → `HttpError(status...)` (2xx error); `usage.cost` not number → `HttpError(-1, text, null, "response without usage.cost rejected")` (fail, not retried). Returns `{answers: body.answers ?? {}, id ?? null, model, provider ?? null, usage:{input_tokens??0, output_tokens??0, cost}}`.
  - private `log` :256 — row fields; `utterance_id`/`segment_id` only if set; `question_set_version ?? null`; `error` only if set; `request_hash` = `requestHash(cfg.model, state, questions)`; passes `questions` as 2nd arg.
- `requestHash(model, state, questions)` :284 — sha256 of JSON `{model,state,questions}`, first 16 hex.
- private `errorText(e)` :288 — HttpError → message; Error → `${name}: ${message}` (BudgetExhaustedError's name is `"Error"` since it does not set `name`).

Side effects: network via injected fetch; `Date.now()`; `setTimeout` via default sleep; `AbortSignal.timeout`. No fs, no env.

Seams: `deps.fetch`, `deps.sleep`, `deps.rand`, `deps.log`, `deps.onStart`, `deps.budget`; `meta.timeoutMs/maxAttempts/live`.

Fake used today (`tests/jev.test.ts:17-42`): `res(status, body, headers)` builds a `Response`; `timeout` throws `DOMException("...", "TimeoutError")`; `setup(responses, budgetOpts)` returns `{client, calls(RequestInit[]), sleeps, rows, budget, exhausted}`, `sleep` records ms and resolves immediately, `rand: () => 0`, config from `loadConfig().app.jev`.

Decisions API shape a fake must return (200):
```json
{ "answers": { "<qid>": {"type":"noul","noul":0.96} | {"type":"choice","choice":"k","confidence":1,"probabilities":{"k":1}} | {"type":"score","score":2.26,"confidence":0.67,"probabilities":{"0":0,...},"legend":{...}} },
  "id": "gen-dec-1", "model": "typesafe/jev-1.13-20260917", "provider": "TypeSafe",
  "usage": { "cost": 0.00002, "input_tokens": 476, "output_tokens": 70 } }
```
Body may be prefixed with whitespace (keep-alives). Errors: `{error:{code, message, metadata?:{limit_source}}}` with any status (incl. 200). Header `retry-after` (seconds or HTTP date).

Covered (`tests/jev.test.ts`, "Jev client"): success shape/headers/body/log/budget; background 429→sleep→success; live 429 → no retry + pause set from retry-after 7; live 502 retried immediately; 400 fails; timeout retried then fails at 2 attempts on live; 2xx error body retried (gate); missing usage.cost rejected not retried; parseRetryAfter secs/date/null + backoffMs; classifyError table; non-transient 402 → BudgetExhaustedError + exhausted ["provider"]; budget refusal never hits network; enforceDevCap false ignores dev cap; sumDevSpend basics.

NOT covered:
- `it("background 5xx x5 fails after backgroundMaxAttempts=5 with sleeps ≈ [2000,4000,8000,16000] (rand 0, Date frozen)")` — use `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime` so waits are exact.
- `it("backoff is capped at 30000 ms for attempt ≥ 5")`
- `it("a live call made while paused does not wait; a background call made while paused sleeps the remaining pause first")` (live 429 retry-after 7 then relabel → first sleep ≈7000).
- `it("transient 402 on a live purpose fails at once without exhausting the budget and sets the pause")`
- `it("transient 402 on a background purpose is retried after the pause")`
- `it("401 is rethrown as HttpError status 401 with message 'OpenRouter rejected the API key (401): check OPENROUTER_API_KEY'")`
- `it("403/404/413 fail on first attempt, no pause set")`
- `it("2xx body with embedded code 429 pauses; embedded 400 fails; embedded code as string is retried")`
- `it("non-JSON 200 body ('<html>') and truncated JSON are retried as 2xx-no-code")`
- `it("a body stream that errors while reading is treated as no-status and retried")` — fake `new Response(new ReadableStream({ start(c){ c.error(new Error('boom')) } }))`.
- `it("network TypeError ('fetch failed') → HttpError(null) → retried")`
- `it("missing answers/id/provider/input_tokens default to {}/null/null/0")`
- `it("request omits provider when cfg.provider is undefined")`
- `it("uses utteranceTimeoutMs/segmentTimeoutMs/backgroundTimeoutMs and meta.timeoutMs override")` — `vi.spyOn(AbortSignal, "timeout")` and assert args 3000/5000/30000/override.
- `it("meta.maxAttempts and meta.live override the purpose defaults")` (e.g. purpose smoke with live:true does not wait out pause).
- `it("budget refusal logs a row with ok:false, attempts:0, error 'Error: development spend ...', and onStart is not called")`
- `it("onStart is called once per ask, with the purpose, after the budget check")`
- `it("log receives the question set as its second argument; row omits utterance_id/segment_id/error when absent and question_set_version is null")`
- `it("cost 0 is not recorded in the budget")`
- `it("requestHash is stable for equal inputs and differs by model/state/questions")`
- `it("concurrency: with concurrency 1, a queued live call runs before an earlier-queued background call")` — fake fetch returning deferred promises; assert call order.
- `it("release frees the slot after a failure (next queued call proceeds)")`
- `it("embeddedErrorCode returns null for no '{', invalid JSON, code < 400, non-number code")`
- `it("effectiveStatus returns embedded code for 2xx and raw status otherwise")`
- `it("parseRetryAfter: '0' → 0, past date → null, garbage → null")`
- `it("HttpError default message: null status uses body; else 'HTTP <s> <body[0:300]>'")`

Hard to test: pause arithmetic uses real `Date.now()` — freeze with `vi.useFakeTimers({ toFake: ["Date"] })` (AbortSignal.timeout still uses real timers, fine). Concurrency ordering: deferred-response fake. No refactor needed.

Smells:
- `parseRetryAfter` :68 — negative numeric (`"-5"`) yields -5000 → negative backoff/pause; `""` → 0. Low impact.
- `errorText` for `BudgetExhaustedError` gives `"Error: ..."` because the class never sets `name` (`budget.ts:12`). Cosmetic.

---

## 3. `src/budget.ts` (98 lines)

Purpose: single spend ledger per process (4 buckets) with session/dev caps and provider exhaustion; `sumDevSpend` totals call-row spend across session folders.

Exports:
- `Bucket` :6; private `CALL_KINDS` :10 = jev_call, s2_call, transcription, live_transcription, chat_call, deleted_session.
- `class BudgetExhaustedError` :12 (`cap: session|dev|provider`).
- `CostTotals` :18, `BudgetOptions` :20 (`sessionCapUsd, devCapUsd, enforceDevCap, devSpentUsd, onExhausted?, onCost?`).
- `class Budget` :32: `totals()` :38 (session = all 4 buckets incl chat; dev = devSpentUsd + session); `assertCanSpend(purpose)` :43 — throws stored error if exhausted; pipeline = session − chat ≥ sessionCapUsd → exhaust("session", msg `session spend $X.XXXX reached the cap of $N`); `enforceDevCap && dev ≥ devCapUsd` → exhaust("dev"); `exhaust(cap, purpose, message)` :57 — first call stores error + `onExhausted({cap,purpose,totals,message})`, always throws the FIRST error; `isExhausted` :65; `record(bucket, cost)` :69 — ignores non-finite or ≤0; calls `onCost(totals)`.
- `sumDevSpend(sessionsDir = appPaths().sessions)` :77 — missing dir → 0; recursive walk; skips any directory containing `imported.json`; sums `cost_usd` (number) of CALL_KINDS rows in `*.jsonl`; skips blank/torn lines.

Side effects: fs reads (sumDevSpend). Seams: constructor options; `sessionsDir` arg.

Covered: jev.test (dev cap refusal, provider exhaust, enforceDevCap false, sumDevSpend basics + torn line + non-call kinds); transfer.test:90 (imported recording → 0); session.test:268 (deleted_session keeps total); chat.test (chat bucket record).

NOT covered:
- `it("session cap: pipeline spend exactly equal to cap exhausts ('session'), message contains $X.XXXX")`
- `it("chat spend never trips the session cap but is included in totals().session")`
- `it("chat spend counts toward the dev total and can trip the dev cap when enforceDevCap")` (documents current behaviour, see smell)
- `it("exhaust twice: onExhausted called once; second throws the first error even with a different cap")`
- `it("after exhaustion assertCanSpend throws the stored error without re-evaluating")`
- `it("record ignores 0, negative, NaN, Infinity and does not call onCost")`
- `it("record calls onCost with updated totals")`
- `it("sumDevSpend counts chat_call, live_transcription, deleted_session; ignores cost_usd strings; ignores non-.jsonl files; recurses nested dirs")`
- `it("sumDevSpend skips a folder with imported.json including its subfolders")`
- `it("sumDevSpend() default reads appPaths().sessions")` (with setAppPaths to tmp; restore).

Smell: dev total includes chat (:40), so chat spend can trip the dev cap for pipeline calls in enforceDevCap runs; docs/chat.md says "the development cap is not enforced on chat" (true only in the sense that chat never calls assertCanSpend). Hedged: probably intended.

---

## 4. `src/config.ts` (170 lines) + `config/*.json`

Purpose: zod schemas and loader for `config/app.json`, `labels.default.json`, `factcheck.s1.default.json`.

Exports:
- `AppConfigSchema` :12 (strict at every level): server.port int 1..65535; budget caps positive; vad; echoGate mode enum auto|always|never, thresholdDbfs ≤0, holdMs ≥0; speakers (voicesPerStream host/remote int ≥0); transcription (live optional, delay enum); jev (provider optional record); segmentation `.refine(min ≤ max)` msg "segmentation.minSegmentMs must not exceed segmentation.maxSegmentMs" :58; timeline; s2 (provider `.passthrough()` requiring order/allow_fallbacks/require_parameters; web.engine exa|native; effort enums); factcheck; chat `.refine(models.includes(defaultModel))` msg "chat.defaultModel must be one of chat.models" :91, models min 1, provider passthrough.
- `AppConfig` :93; `LabelSetSchema` :96 — boundary NoulQuestion; questions record non-empty ("at least one question") and no `story` key ("`story` is generated from timeline.stories; do not define it"); story strict `{instructions, none}`.
- `CLAIM_TYPE_KEYS` :105 (7 keys incl none).
- `S1ThresholdsSchema` :109 — claimThreshold/publicThreshold/attentionThreshold in [0.5,0.9], worthMin [1,3], strict, all required.
- `S1QuestionsSchema` :119 — claim, claim_type (exact keys, msg "claim_type must have exactly the keys ..."), public, hedged (Noul), worth (exactly 5 levels "worth must have exactly 5 levels"); catchall Noul; superRefine: extra key not `attention_\d+` → "unexpected System 1 question <k>"; >3 extras → "at most 3 attention questions".
- `S1SetSchema` :140 — id `^s1@\d+$`.
- `Config` :147; private `readJson` :149, `parse` :153 (throws `Error("<file>: " + z.prettifyError)`).
- `loadConfig(dir = appPaths().config)` :159; `parseAppConfig` :168 ("app config"), `parseLabelSet` :169 ("label set"), `parseS1Set` :170 ("System 1 set").

Default values worth pinning (config/app.json): port 4317; budget session 10 / dev 3; jev model `typesafe/jev-1.13`, utterance 3000, segment 5000, maxAttempts 2, background 30000/5, concurrency 8, segmentConcurrency 4, provider `{data_collection:"deny"}`; s2 model `openai/gpt-6-luna`, provider `{order:["openai"],allow_fallbacks:false,require_parameters:true,data_collection:"deny"}`, web exa/5, effort research medium/audit low/rewrite medium, timeout 90000, maxAttempts 2, researchConcurrency 2, perHour 30, perSession 40, staleAfterMs 600000; factcheck hedged 0.6, knownMatch 0.6, maxKnown 40, auditInterval 300000, auditMin 10, auditSample 10, rewriteOnFalseAlarms 3, rewriteOnMisses 2, cooldown 180000, replayMaxItems 300; chat default `openai/gpt-6-luna`, 14 models, effort low, capUsd 2, timeout 120000, maxAttempts 2. s1@1 thresholds claim 0.7 / public 0.6 / worthMin 1.5 / attention 0.7; `hedged` has no criteria. labels: 10 questions (subject, mode choices; disagreement, humour, hot_take, prediction, recommendation nouls; heat, hype, clip_worthy scores).

Side effects: fs reads. Seams: `dir` argument; `parse*` helpers take plain objects.

Covered (`tests/config.test.ts`): loads all three; min>max segment; choice without criteria; choice without fallback; none/other fallback accepted; score <2; non-snake id; S1 attention_1 ok, claimThreshold 0.95 rejected, claim_type missing key.

NOT covered:
- `it("loadConfig(dir) reads a custom folder (tmp copy of config/)")`
- `it("loadConfig throws '<path>/app.json: ...' prefixed error on schema failure")`
- `it("loadConfig throws on a missing file (ENOENT) and on invalid JSON (SyntaxError)")`
- `it("parseAppConfig rejects unknown keys at top level and inside jev (strict)")`
- `it("parseAppConfig rejects chat.defaultModel not in chat.models and empty chat.models")`
- `it("parseAppConfig accepts transcription without live and jev without provider")`
- `it("parseAppConfig rejects port 0/65536, echoGate.thresholdDbfs > 0, unknown echoGate.mode, s2.web.engine 'bing', effort 'extreme'")`
- `it("s2.provider passes through extra keys (data_collection) but requires order/allow_fallbacks/require_parameters")`
- `it("parseLabelSet rejects empty questions, a 'story' question, a choice boundary, story with extra key")`
- `it("parseS1Set rejects unexpected question 'foo', a 4th attention question, a non-noul attention_1, worth with 4 levels, id 's1@x', missing publicThreshold, worthMin 3.5")`
- `it("default config snapshot: key values equal the documented defaults")` (pins the numbers above).

Smell: `S1ThresholdsSchema` requires `publicThreshold` while `flagDecision` keeps a `?? 0.5` fallback (`s1.ts:62`) for old versions — dead unless versions bypass the schema.

---

## 5. `src/keys.ts` (216 lines)

Purpose: API key storage (env first, then 0600 credentials file), format + live check, and setup-route logic.

Exports:
- `KEY_ENV` :9 `{openai:"OPENAI_API_KEY", openrouter:"OPENROUTER_API_KEY"}`; `KeyName` :10; `KEY_NAMES` :11.
- `childEnv(env=process.env)` :14 — shallow copy without both key vars.
- `credentialsPath(env=process.env)` :21 — `env.TATTLE_CREDENTIALS || appSupportDir()/credentials.json`.
- `KeyStatus` :25; `class KeyError(status, message)` :35.
- `class KeyStore` :42 — ctor `{path?, env?}` :47 (default env `process.env`, path `credentialsPath(env)`); `load()` :53 — env value trimmed non-empty → fromEnv; else file value copied into env; `status()` :63 — `{name, env, set, source: environment|file|null, hint: last 4 of trimmed}`; `missing()` :74; `save(keys)` :79 — any key in fromEnv → `KeyError(409, "<VAR> is set in .env or your shell, which wins over the page: change it there")`; merges with file; `mkdirSync(dir,{recursive,mode:0o700})` + `chmodSync(dir,0o700)`; writes `${path}.${pid}.tmp` (mode 0600 + chmod 0600) then rename; body only non-empty keys as `{OPENAI_API_KEY, OPENROUTER_API_KEY}` pretty-printed 2 spaces + "\n"; sets env for given keys. private `read()` :97 — missing → {}; if `mode & 0o077` → chmod 0600 (errors swallowed); invalid JSON → `console.error("<path> is not valid JSON: ignored, ...")` + {}; picks string, trimmed, non-empty values.
- `loadKeys()` :120 — `new KeyStore().load()` (real process.env + default path).
- `KeyCheck` :126; `keyFormatProblem(name, key)` :135 — "" → "Paste the key."; whitespace → "A key has no spaces or line breaks: copy it again."; len <20 or >400 → "This does not look like a whole key: copy it again."; openai + `sk-or-` → "This is an OpenRouter key: paste it in the OpenRouter field."; openrouter + `sk-` not `sk-or-` → "This looks like an OpenAI key: OpenRouter keys start with sk-or-."; else null.
- `checkKey(name, key, {fetch, models?})` :149 — format problem → `{ok:false, message}` with no fetch; GET `https://api.openai.com/v1/models` or `https://openrouter.ai/api/v1/key` with `Authorization: Bearer`, `AbortSignal.timeout(10_000)`; fetch throws → ok true, "Saved", warning "Could not reach the service ... (are you online?) ..."; 401 → ok false with service-specific message; other non-ok → ok true, warning "The service answered HTTP <s> when checking it. It was saved anyway."; json failure → body null. OpenRouter: `data.is_free_tier === true` → warning "no credit yet"; `limit` null/undefined → warning "no credit limit"; else message `Key works: limit $<limit>[, $<remaining.toFixed(2)> left]`. OpenAI: ids from `data[].id`; lacking = models not in ids (only if ids non-empty) → warning "This key cannot use a and b, which transcription needs..."; else "Key works".
- `class KeySetup(store, {fetch, models})` :184 — `status()` :187 `{configured, keys, path (homedir → "~")}`; `save(body)` :193 — non-object → `KeyError(400,"expected { openai?, openrouter? }")`; value undefined/null/"" skipped; non-string → 400 `"<name> must be a string"`; none → 400 "no key given"; env-sourced → 409; checks in parallel (openai gets `opts.models`, openrouter `[]`); saves only if all ok; returns `{saved, checks, ...status()}`.

Side effects: fs (mkdir/chmod/write/rename/stat/read), `process.env` mutation, `process.pid`, `homedir()`, `console.error`, network via injected fetch.

Seams: `KeyStore({path, env})`; `checkKey(..., {fetch})`; `KeySetup(store, {fetch, models})`; `TATTLE_CREDENTIALS` env.

Fake used today (`tests/keys.test.ts:16-27`): `fakeFetch({openai?, openrouter?, limit?, freeTier?, models?, offline?})` → `{f, seen}`; OpenAI returns `{data:[{id}]}`; OpenRouter returns `{data:{limit, limit_remaining: 9.5, is_free_tier}}`; `tmpFile()` = `<mkdtemp>/Tattle/credentials.json` (parent does not exist yet).

Covered: env wins/file fills/status/409 on env key; file 0600 + dir 0700 + JSON content + env updated + merge; tighten 0644→0600; broken JSON ignored; format problems (4 cases); checkKey 401 both, limit message, no-limit, free tier, lacking models, offline; KeySetup all-or-nothing + hints only; server gate routes (keys.test "the server before the keys are set"); desktop.test childEnv.

NOT covered:
- `it("credentialsPath uses TATTLE_CREDENTIALS, else ends with Library/Application Support/Tattle/credentials.json")` (pass env object; no fs touched).
- `it("KeyStore default path comes from the given env's TATTLE_CREDENTIALS")`
- `it("load treats a whitespace-only env var as unset and fills it from the file")`
- `it("status hint is the last 4 chars of the trimmed key; unset → set:false, source:null, hint:null")`
- `it("save tightens an existing 0755 folder to 0700")`
- `it("save leaves no .tmp file behind and the file ends with a newline, 2-space JSON")`
- `it("read ignores non-string and blank values and trims values")`
- `it("read logs 'is not valid JSON' via console.error")` (vi.spyOn(console, "error")).
- `it("loadKeys fills process.env from TATTLE_CREDENTIALS file")` (set/restore process.env TATTLE_CREDENTIALS, OPENAI_API_KEY, OPENROUTER_API_KEY).
- `it("keyFormatProblem: '' → Paste the key.; tab/newline → no spaces; 19 and 401 chars → whole key; openrouter sk-or- key → null; openai non-sk key → null")`
- `it("checkKey makes no fetch call when the format is wrong")`
- `it("checkKey hits the right URL with Bearer header and a signal")`
- `it("checkKey: 403/500 → ok:true with 'HTTP <s>' warning")`
- `it("checkKey: 200 with non-JSON body → openrouter 'no credit limit' warning; openai 'Key works'")`
- `it("checkKey openrouter: limit without limit_remaining → 'Key works: limit $10' (no 'left'); free tier wins over limit")`
- `it("checkKey openai: two lacking models joined with ' and '; all present → no warning; empty data list → no warning")`
- `it("KeySetup.save: null/'str' body → 400; number value → 400 'openai must be a string'; {openai:''} → 400 'no key given'; env-sourced → 409")`
- `it("KeySetup.save trims keys before checking and saving; passes models only for openai")`
- `it("KeySetup.status path replaces the home directory with ~")` (path under homedir() in a tmp subdir is risky — use a path string starting with homedir() but never saved; status() does not touch fs beyond store.status()).

Hard to test: chmod failure branch :101 (file owned by another user) — needs `vi.mock("node:fs")` partial; recommend skipping or a partial mock of `chmodSync` throwing. No refactor.

Smells:
- `checkKey` :164 saves a key on 403/429/5xx with only a warning (403 may mean an unusable key). Intentional per docs ("any other HTTP error" → saved).
- `KeyStore.save({openai: ""})` :94 sets env to "" and omits from file (KeySetup filters "", so only reachable directly).
- tmp name `${path}.${pid}.tmp` :90 — two concurrent saves in one process would share it (low risk).

---

## 6. `src/paths.ts` (82 lines)

Purpose: mutable engine file locations (project defaults; Mac app overrides) and Application Support folder + rename migration.

Exports: `AppPaths` :11; private `ROOT` :30 (project root from import.meta.url), `DEFAULTS` :32 (root, web "web", config "config", models "models", sessions "sessions", helper "native/capture/.build/release/tattle-capture", notices ROOT/THIRD_PARTY_NOTICES.md, licenses ROOT/licenses, src ROOT/src); `appPaths()` :46; `setAppPaths(p={})` :51 — non-empty → merge into current; EMPTY object (or no arg) → reset to defaults; `appSupportDir(base=~/Library/Application Support)` :57 → `<base>/Tattle`; private `LEGACY_APP_SUPPORT` :62 "Conversation Assistant"; `migrateAppSupportDir(base)` :68 — null if new exists or old missing; rename; on error `console.warn("Could not move ...")` and null; `vadModelPath` :81, `speakerModelPath` :82 (read `current.models` at call time).

Side effects: module-global `current`; fs exists/rename; homedir.

Covered (`tests/desktop.test.ts`): migration once + never overwrites + empty base → null; defaults; setAppPaths moves models/sessions/root and reset.

NOT covered:
- `it("setAppPaths merges successive partial calls")`
- `it("setAppPaths({}) resets to defaults (same as no arg)")`
- `it("defaults: root is the project root (contains package.json), notices/licenses/src absolute under root, helper path")`
- `it("appSupportDir() without base ends with Library/Application Support/Tattle")` (string only).
- `it("migrateAppSupportDir returns null and warns when rename fails")` — make `base` read-only (`chmodSync(base, 0o500)`) after creating the legacy folder; restore mode in finally. (Works as non-root on macOS; unverified on CI.)

Smell: `setAppPaths({})` resetting everything is surprising (:52) — a caller passing a computed empty partial resets the Mac app's paths.

---

## 7. `src/licenses.ts` (86 lines)

Purpose: builds Licenses window content from package.json, LICENSE, THIRD_PARTY_NOTICES.md and license texts.

Exports: `LicenseComponent` :7, `LicenseGroup` :18, `Licenses` :20; private `FILE_REF` :27 (backticked `licenses/<name>.txt` or `web/fonts/OFL.txt`); private `component(title, lines)` :29 — license = first line before " · " with `**` removed; files deduped; `parseNotices(md)` :38 — CRLF normalized; `## ` opens group, `### ` opens component; lines inside ``` fences are text; components before any group are dropped (close() only pushes when groups exist); empty groups filtered; private `resolveRef(ref)` :61 — `licenses/` → `appPaths().licenses/<name>`, else `appPaths().web/fonts/OFL.txt`; `licenses()` :67 — reads `<root>/package.json` (throws if missing), notices/LICENSE/texts read as "" when missing; texts only kept if non-empty; component.files filtered to loaded texts; app `{name: productName ?? name, version, license ?? null, holder: author ?? null, text}`.

Side effects: fs reads via appPaths. Seams: `setAppPaths({root, notices, licenses, web})` to a tmp tree.

Covered: server.test "the licenses: ..." (real repo files via /api/licenses) and "the notices split into groups and components, not at headings inside code blocks" (parseNotices).

NOT covered:
- `it("parseNotices drops components before the first ## group and groups with no components")`
- `it("parseNotices handles CRLF, '#### ' is body text, deduplicates repeated file refs, ignores non-backticked refs")`
- `it("parseNotices: an unterminated fence swallows later headings")` (documents behaviour)
- `it("licenses() with tmp paths: missing THIRD_PARTY_NOTICES → groups []; missing LICENSE → text ''; missing referenced text file → removed from files and texts")`
- `it("licenses() uses productName over name; license/author null when absent")`
- `it("licenses() resolves web/fonts/OFL.txt under appPaths().web")`
- `it("licenses() throws when package.json is missing")`

---

## 8. `src/version.ts` (9 lines)

Purpose: `appInfo(root = appPaths().root)` :6 → `{name: String(pkg.name), version: String(pkg.version)}` read on each call.

Covered indirectly (server.test `/api/about`, session.json writes). NOT covered:
- `it("appInfo() returns the root package.json name 'tattle' and version")`
- `it("appInfo(tmp) re-reads on each call (write, read, rewrite, read)")`
- `it("appInfo stringifies missing fields as 'undefined'")` (documents behaviour)
- `it("appInfo throws when package.json is missing")`

---

## 9. `src/factcheck/gate.ts` (50 lines)

Purpose: replay gate — re-ask a candidate System 1 set on logged states, count G′/F′/M′, decide promotion.

Exports: `GateItem` :6 (`utteranceId, set: G|F|M, state, order`); `GateMetrics` :13; `gateDecision(m)` :22 — `G2 >= floor(0.9*G) && (F2 < F || M2 > 0)`; `GateDeps` :26 (`ask`, `hedgedThreshold`); `runGate(candidate, items, deps)` :36 — questions = `versionQuestions(candidate)`; all items in parallel (`Promise.all`); meta `{purpose:"gate", utterance_id, question_set_version: candidate.id}`; success → `asked++`, flag via `flagDecision` → `<set>2++`; ask throws → `failed++` (counted as not flagged).

Covered: "gate arithmetic" (5 cases), "runGate re-asks the candidate questions (no memory) on stored states" (promote + reject; purpose gate; question keys).

NOT covered:
- `it("runGate counts failures in 'failed', not in G2/F2/M2, and still returns a decision")`
- `it("runGate passes utterance_id and question_set_version = candidate.id")`
- `it("runGate with no items → all zeros, promote false")`
- `it("runGate counts M items and M2 > 0 promotes even with F2 == F")`
- `it("gateDecision: G=20 needs G2 ≥ 18; G=0 always passes the keep rule; F=0,M2=0 never promotes")`
- `it("gateDecision: G=1, G2=0, F=1, F2=0 promotes (floor(0.9)=0)")` — documents the smell below.

Smell: `floor(0.9 × G)` (:23) lets a candidate lose one good flag whenever G < 10 and ALL good flags when G = 1; docs say "keep at least 90%". Hedged: may be accepted as noise tolerance, but G=1 losing 100% contradicts the doc's wording.

---

## 10. `src/factcheck/queue.ts` (122 lines)

Purpose: research priority queue with worker concurrency, per-hour sliding window, per-session cap, staleness, stop.

Exports: `QueueItem` :3, `DropReason` :10 (stale|session_cap|stopped), `QueueDeps` :12 (`research, onDropped, now?, setTimer?`); `class ResearchQueue` :22 — ctor :33 (default now `Date.now`, default setTimer `setTimeout(...).unref?.()`); `enqueue` :38 (stopped → onDropped "stopped"); getters `size` :47, `researching` :51, `researchedCount` :55; private `next()` :59 (highest priority, tie → earliest flaggedAt); `pump()` :71 — drop stale (`now - flaggedAt > staleAfterMs`, strict), purge starts ≥ 1 h old, while workers free: session cap reached → drop ALL queued "session_cap" and return; hour window full → `arm(min(HOUR - (now - starts[0]), staleAfterMs))` and return; start research (errors swallowed; finally → active--, pump()); after loop, items left → `arm(staleAfterMs)`; private `arm(ms)` :103 — single armed timer; `Math.max(1, ms)`; `drain()` :113 — loops until no in-flight; `stop()` :118 — stopped=true; queued → "stopped".

Seams: `now`, `setTimer` (tests capture `fn` and `ms`), `research` promise control.

Covered: priority order; per-session + per-hour caps (timer armed); stale drop.

NOT covered:
- `it("ties are served by earliest flaggedAt")`
- `it("enqueue after stop drops immediately with 'stopped'; stop drops queued items with 'stopped' but lets in-flight finish")`
- `it("size/researching/researchedCount reflect queue state")`
- `it("a rejected research promise is swallowed and the next item starts")`
- `it("hour window: arm(ms) = HOUR - elapsed (capped by staleAfterMs); firing the captured timer after advancing now by 1 h resumes research")`
- `it("arm is idempotent while a timer is pending (setTimer called once)")`
- `it("remaining items arm a stale timer; firing it after staleAfterMs+1 drops them as stale")`
- `it("an item exactly staleAfterMs old is not stale")`
- `it("session cap reached with concurrency 2: the third item is dropped only when a worker frees")`
- `it("drain resolves immediately with nothing in flight and waits for research started from finally")`
- `it("default setTimer uses setTimeout and does not keep the process alive")` (vi.useFakeTimers + advanceTimersByTime).

Smell (hedged): once a long stale timer is armed, a later shorter hour-window wake cannot be armed (:104), so a freed hour slot may wait until the stale timer fires or another research completes. Low impact.

---

## 11. `src/factcheck/s1.ts` (636 lines)

Purpose: System 1 flag rule, rewrite validation, and `FactChecker` (memory questions, claims, research via queue, audits, rewrites + replay gate, versions, rollback, stats).

Exports:
- `VersionStatus` :14, `S1Version` :16, `S1_BASE_IDS` :26 (claim, claim_type, public, hedged, worth), `KNOWN_CRITERIA` :28.
- `versionQuestions(v)` :34 — shallow copy of `v.questions`.
- `FlagDecision` :40; `flagDecision(answers, v, hedgedThreshold)` :51 — missing answers → 0 / null; `public` gated only if `"public" in v.questions` else 1; attention = any `attention_*` key IN THE VERSION with answer ≥ attentionThreshold; flag = claim ≥ claimThreshold && claimType not null/"none" && worth ≥ worthMin && pub ≥ (publicThreshold ?? 0.5); priority = worth + 0.5 (hedged ≥ hedgedThreshold) + 1 (attention).
- private `INSTRUCTIONS_MAX` :69 = 400; `THRESHOLD_RANGES` :70 (claim/public/attention [0.5,0.9], worthMin [1,3]); `onlyFields` :77 (messages "`<op> on <target> needs <f>`", "`... must leave <f> null`").
- `applyRewrite(active, proposal)` :89 — >3 changes → `["<n> changes; at most 3 are allowed"]`; 0 → `["no changes proposed"]`; per op (collects ALL errors):
  - set_instructions :103: target in S1_BASE_IDS (incl `public`) else "set_instructions cannot target X"; only `text`; blank → "instructions must not be empty"; >400 → "instructions for X exceed 400 characters".
  - set_criteria :112: claim/public/hedged → true_text+false_text, blank → "criteria descriptions must not be empty"; claim_type → options exactly the 7 keys, unique ("claim_type options must list exactly ..."), blank description → "claim_type descriptions must not be empty", rebuilt in CLAIM_TYPE_KEYS order; worth → levels length 5 ("worth needs exactly 5 levels, got N"), blank → "worth levels must not be empty"; other → "set_criteria cannot target X".
  - add_attention :140: target "new" else `add_attention must target "new"`; text required, true/false optional but both-or-neither ("add_attention needs both true_text and false_text, or neither"); blank; >400 → "attention instructions exceed 400 characters"; id = `attention_<max(existing)+1>`; >3 → "at most 3 attention questions".
  - remove_attention :153: must match `attention_\d+` and exist ("remove_attention: no question X"); no fields.
  - set_threshold :160: key in THRESHOLD_RANGES else "set_threshold cannot target X"; only number; out of inclusive range (NaN too) → "X N is outside [a, b]".
  - Final `S1SetSchema.safeParse` :172 → `[error.message]` (reachable e.g. add_attention with `true_text:""`, `false_text:""`). Active set is not mutated (structuredClone).
- `ClaimStatus` :179, `Claim` :181, `FactcheckStats` :205, `S2Api` :220 (`research, audit, rewrite`), `FactcheckFile` :226 (claims|verdicts|s1_versions|audits), `FactcheckDeps` :228 (`app, s1Default, s2, ask, emit, write, speakerName, stateOf, onError, now?, rand?, setTimer?`).
- `class FactChecker` :248:
  - ctor :269 — version s1@1 `{kind:"default", status:"default", parent:null, rationale:"default", gate:null, createdAt: ISO(now())}`; `write("s1_versions", v)`; builds `ResearchQueue(app.s2, {research, onDropped, now, setTimer})`.
  - `active` :287, `memoryQuestions` :291 (copies).
  - `questions()` :301 — active version questions + `known_<claimId>` nouls (instructions `Judge only new_utterance. It restates or relies on this already-checked claim: "<text>"`, criteria KNOWN_CRITERIA); returns `{questions, version}`.
  - `onAnswers(u, answers, {segment})` :315 — clockMs = max(clockMs, u.endMs). Memory first: best `known_*` ≥ knownMatchThreshold (highest p) → target has verdict → `repeats.push`, emit `claim.repeat {claimId, utteranceId, speakerId, text, match, verdict, disputed}`; else `duplicates.push`, emit `claim.duplicate {..., status}`; evaluation stored (flagged false); NOT added to audit pool; maybeAudit; return. Else flagDecision; flagged → claim `c_<n>` (segmentText = non-failed segment lines as `speakerName(id): text` joined "\n"), emit `claim.flagged {claimId, utteranceId, speakerId, text, priority, claimType, worth, hedged, claim, attention, s1Version}`, write claims row, addMemory, enqueue. Not flagged & not filler → audit pool. maybeAudit.
  - private `addMemory` :365 — emit `s1.memory {action:"add", claimId, text, size}`; evict oldest beyond maxKnownQuestions with `action:"evict"`.
  - private `writeClaim` :374 — row `{kind:"claim", id, utterance_id, speaker_id, text, s1_version, priority, claim_type, worth, hedged, status, grade|null, disputed, drop_reason|null, at}`.
  - private `research(item)` :384 — status researching + event `claim.researching` + row; `s2.research({claim_id, speaker: speakerName, utterance, segment})`; success → verdict, latencyMs = now() − started, grade = gradeOf, gradeSeq; write `verdicts` row `{kind:"verdict", claim_id, utterance_id, ...v, grade, latency_ms}`; claims row; `claim.verdict {claimId, verdict, grade, latencyMs}`; memory text ← trimmed restated_claim if non-empty (emit `s1.memory action:"update"`); maybeRewrite. Failure → `onError("s2", msg, {claim_id, purpose:"research"})`, status dropped, dropReason "research_failed", counters.dropped++, row, `claim.dropped {claimId, reason:"research_failed"}`.
  - private `dropped` :419 — queue drop → status dropped, reason, row, `claim.dropped`.
  - `override(claimId, note?)` :430 — unknown → "unknown claim X"; no verdict → "claim X has no verdict yet"; disputed, note; row; `claim.disputed {claimId, note: note ?? null}`.
  - private `track` :443; `maybeAudit` :448 — if clockMs − lastAuditMs < auditIntervalMs return; lastAuditMs = clockMs (EVEN when pool too small); pool < auditMinUtterances → return (pool kept); sample up to auditSample by `rand()`; `audit` :460 — `s2.audit(items)`; misses = items with has_checkable_claim && worth ≠ "low" && id in sample; misses map (version = evaluation version, seq); write `audits` row `{kind:"audit", sampled, items, misses, at}`; emit `audit {sampled: n, misses, items}`; maybeRewrite. Failure → `onError("s2", msg, {purpose:"audit"})`.
  - private `evidence()` :485 — graded non-disputed claims of the active version graded after activationSeq; misses of the active version after activationSeq.
  - private `maybeRewrite` :494 — not running; falseAlarms ≥ rewriteOnFalseAlarms OR misses ≥ rewriteOnMisses; clockMs − lastRewriteMs ≥ cooldown; sets running + lastRewriteMs.
  - `rewriteInput()` :504 — JSON (indent 1) `{active_questions, thresholds, false_alarms:[{utterance, reason, verdict}], good_flags: last 10 texts (active-version ones, else all non-disputed good), misses: last 10 texts (active ones else all)}`.
  - private `nextVersionId` :518 = `s1@<versions.length+1>`.
  - private `rewrite()` :522 — s2.rewrite throws → `onError("s2", msg, {purpose:"rewrite"})`, return (nothing recorded). applyRewrite invalid → recorded as rejected with `errors`, outcome "invalid". Else runGate(candidate, this.gateItems(), ...) inside try: throw → `onError("gate", msg, {candidate})`, errors, outcome "gate_failed". Else gate metrics, status promoted/rejected; promoted → active + activationSeq.
  - private `record(v, outcome)` :559 — push, counters, write `s1_versions`, emit `s1.version {active, candidate, outcome, status, parent, rationale, gate, errors|null}`.
  - `gateItems()` :571 — G/F from graded non-disputed claims, M from misses; drop items whose `stateOf` is undefined; sort by order desc; slice replayMaxItems.
  - `rollback(versionId)` :583 — unknown → "unknown System 1 version X"; rejected → "X was rejected by the gate and cannot be restored"; sets active, activationSeq; emit `s1.version {outcome:"rollback", candidate:null, errors:null}`.
  - `drain(maxMs=180_000)` :598 — waits queue + background until empty; returns false on timeout (real `setTimeout`, unref'd).
  - `stop()` :613 → queue.stop(); `stats()` :617.

Side effects: none direct (all via deps); `Date`/`setTimeout` in drain; `new Date(now())` ISO strings.

Seams: all deps; `now`, `rand`, `setTimer`; fake S2Api.

Fakes used today (`tests/factcheck.test.ts`): `ans({claim,type,worth,hedged,public,known_*,attention_*})` :16 builds answers (defaults: public 0.9, claim_type "none"); `FLAG`/`NOFLAG` :27-28; `utt(text, endMs, filler)` :31 (global counter `uN`, reset manually in some tests); `VERDICT(o)` :36; `fakeS2({verdict, audit, rewrite})` :41 → `{s2, calls}`; `checker({app, s2, ask, now})` :51 → `{fc, events, rows, say(text, answers, u?), of(type)}` (stateOf backed by a Map set in `say`, `rand: () => 0`); `settle()` :77; `change()`/`proposal()` :292-295.

Covered: flag rule thresholds; public gating + old set; priority hedged/attention; memory add/evict + known question text; duplicate vs repeat + restated memory update + below-threshold flags; override → evidence removal + unknown claim throws; audit interval/min pool/miss rule; rewrite trigger/cooldown/invalid outcome/rejected count; applyRewrite per-op rules (broad); promoted version + rollback + memory kept; rejected cannot be restored.

NOT covered:
- `it("flagDecision: no answers → flag false, claimType null, priority 0")`
- `it("flagDecision: hedged exactly at hedgedThreshold adds 0.5; attention below attentionThreshold adds 0")`
- `it("flagDecision ignores attention_* answers for questions not in the version")`
- `it("flagDecision: a claim answered with the wrong type counts as 0")`
- `it("flagDecision uses 0.5 when thresholds.publicThreshold is undefined")`
- `it("applyRewrite: blank set_instructions text → 'instructions must not be empty'")`
- `it("applyRewrite: set_instructions and set_criteria may target 'public'; set_threshold may target publicThreshold")` (doc drift: docs omit these)
- `it("applyRewrite: blank criteria texts → 'criteria descriptions must not be empty'")`
- `it("applyRewrite: claim_type with a duplicated key (7 entries) → 'exactly'; blank description → 'descriptions must not be empty'; result keys in CLAIM_TYPE_KEYS order")`
- `it("applyRewrite: blank worth level → 'worth levels must not be empty'; extra field → 'must leave'")`
- `it("applyRewrite: add_attention >400 chars, blank text; with both texts → criteria set")`
- `it("applyRewrite: add_attention after remove in same proposal numbers max+1 (attention_4 when 1,3 remain)")`
- `it("applyRewrite: remove_attention on 'claim' → no question; with a field set → must leave null")`
- `it("applyRewrite: thresholds inclusive at 0.5 and 0.9; NaN → outside")`
- `it("applyRewrite collects every error from several bad changes")`
- `it("applyRewrite: add_attention with true_text '' and false_text '' fails the final schema parse")`
- `it("applyRewrite does not mutate the active set")`
- `it("constructor writes the default s1@1 row with createdAt = ISO(now())")`
- `it("claim.flagged payload has every field; claims row status queued; segmentText excludes failed lines and uses speakerName")`
- `it("fillers are neither flagged into the pool nor audited; repeats/duplicates are not in the audit pool")`
- `it("memory match picks the highest known_* above threshold among several")`
- `it("research failure → onError('s2', msg, {claim_id, purpose:'research'}), claim.dropped research_failed, stats.dropped and researched count it")`
- `it("a verdict with blank restated_claim leaves the memory text unchanged (no update event)")`
- `it("a verdict for an evicted memory claim emits no update")`
- `it("verdicts row has grade and latency_ms = now() delta")` (inject `now`).
- `it("queue drops (stale/session_cap/stopped) mark the claim dropped with that reason and emit claim.dropped")`
- `it("after stop(), a new flag is dropped with 'stopped'")`
- `it("a duplicate of a dropped claim reports status 'dropped'")`
- `it("override without a note emits note:null; override before the verdict throws 'has no verdict yet'")`
- `it("audit failure → onError('s2', msg, {purpose:'audit'}) and no misses")`
- `it("audit ignores returned items whose utterance_id was not sampled")`
- `it("audit sample is chosen with rand (rand=0 takes the pool in order) and capped at auditSample")`
- `it("a too-small pool is kept and audited at a later interval together with newer lines")`
- `it("2 audit misses trigger a rewrite")`
- `it("rewrite failure → onError('s2', msg, {purpose:'rewrite'}), no version recorded, cooldown still applies")`
- `it("gate_failed: stateOf throwing during gateItems → onError('gate', ...), version rejected with errors, outcome 'gate_failed'")`
- `it("evidence restarts after a promotion: old-version false alarms no longer count")`
- `it("rewriteInput: falls back to all good flags / all misses when the active version has none; keeps the last 10")`
- `it("version ids count rejected versions: invalid s1@2 then candidate s1@3")`
- `it("gateItems: drops items without a logged state, sorts newest first, caps at replayMaxItems, includes M items")`
- `it("rollback restarts the evidence count")`
- `it("drain(maxMs) returns false when research never resolves")` (research promise that never settles; maxMs 20).
- `it("stats counts verdicts by kind and disputed claims")`
- `it("clockMs never goes backwards with out-of-order endMs")` (audit timing).

Hard to test: `gate_failed` is only reachable if `gateItems()`/`stateOf` throws (runGate catches per-item errors) — use a `stateOf` that throws after flagging. Timing via session clock (`u.endMs`), so no fake timers needed. `drain` uses real `setTimeout` — pass small `maxMs`.

Smells:
- `rewrite()` :534 invalid version reuses `parent.questions`/`thresholds` by reference (not cloned). Harmless unless mutated.
- `gate_failed` branch :544 effectively unreachable in normal operation.
- Docs drift (docs/system1-system2.md rewrite table and gate steps omit `public`/`publicThreshold`, which code allows and re-asks).

---

## 12. `src/factcheck/s2.ts` (447 lines)

Purpose: System 2 (GPT-6 Luna via OpenRouter chat completions): prompts, strict JSON schemas + zod, verdict post-processing, and `S2Client` with retries, budget, json_object fallback, call logging.

Exports:
- `CHAT_URL` :6 `https://openrouter.ai/api/v1/chat/completions`; `S2Purpose` :7.
- `researchSystemPrompt(today)` :11; `AUDIT_SYSTEM` :26; `REWRITE_SYSTEM` :29.
- `VERDICTS` :34, `FALSE_ALARM_REASONS` :35 (incl `private`), `VerdictKind` :36, `VERDICT_JSON_SCHEMA` :39, `VerdictSchema` :56, `RawVerdict` :64, `Verdict` :66 (`downgraded`), `AUDIT_JSON_SCHEMA` :70, `AuditSchema` :87, `AuditResult` :90, `REWRITE_OPS` :92, `REWRITE_JSON_SCHEMA` :95, `RewriteChangeSchema` :125, `RewriteSchema` :135, `RewriteProposal`/`RewriteChange` :136-137.
- `Citation` :141; `citationsOf(annotations)` :143 — non-array → []; only `type === "url_citation"` with string `url_citation.url`; title fallback url.
- `truncateWords(s, n)` :154 — ≤n words → `s.trim()` (whitespace preserved inside); else first n joined by single spaces.
- `stripCitations(s)` :160 — removes ` ([a](u))` and `([a](u), [b](u))` / `;` groups; `[t](u)` → `t`; collapse 2+ spaces; remove space before `.,;:`; trim.
- private `cleanTitle(title, url)` :169 — stripped title if non-empty and not URL-like; else hostname sans `www.`; invalid URL → url.
- `finalizeVerdict(raw, annotations)` :180 — merge raw.sources + citations; keep only `^https?://` (case-insensitive), non-empty, dedupe by URL; titles cleaned; restated_claim stripped then `.slice(0,200)`; correction stripped then 25 words; first 3 sources; supported/contradicted/misleading with 0 sources → unverifiable, downgraded true.
- `gradeOf(v)` :203.
- `S2CallRow` :209, `S2Deps` :232 (`fetch, apiKey, budget, log, onStart?, sleep?, rand?, today?`).
- `class S2Client` :258 — private `jsonObjectWithWeb` :260 (sticky); `today()` :268 default `new Date().toLocaleDateString("en-GB", {day:"numeric", month:"long", year:"numeric"})`; `research(input, web = cfg.web)` :272 — user = `Speaker: X\nUtterance: Y\nCurrent segment (context only): <segment.slice(-1500)>`; effort research; schema "verdict"; `finalizeVerdict`. `audit(items)` :286 — user `JSON.stringify(items, null, 1)`, web null. `rewrite(user)` :294 — web null.
  - private `structured` :302 — first call json_object only if web && sticky; on error: strictRejected = HttpError with effective status 400 OR ContentError; if web null, already json_object, or not strictRejected → rethrow; else second `chat(req, "json_object")`, parse, THEN set sticky.
  - private `body` :318 — json_object: user + `"\n\nReply with one JSON object only, matching this JSON schema:\n" + JSON.stringify(schema)`; provider = cfg.provider (json_schema) or `{...provider, require_parameters:false}` (json_object); `plugins:[{id:"web", engine, max_results}]` when web; response_format json_schema `{name, strict:true, schema}` or `{type:"json_object"}`; `reasoning:{effort}`; no temperature.
  - private `chat` :334 — `budget.assertCanSpend("s2:<purpose>")` (throws BEFORE any log row); `onStart(purpose)`; loop: success → `budget.record("s2", usage.cost)`, content = string, or array parts `.text` joined, else ""; log ok row; return `{content, annotations: message.annotations}`. Error: fail or attempt ≥ cfg.maxAttempts → log fail row; effective 402 + fail → `budget.exhaust("provider", ...)`; 401 → rewritten HttpError; else rethrow. Otherwise `sleep(backoffMs(attempt, retryAfterMs, rand))` (no shared pause; 429 just sleeps).
  - private `send` :368 — same HttpError mapping as Jev's `send` (fetch/text errors → status null; !ok; no `{`; bad JSON; `json.error`; missing `usage.cost` → -1).
  - private `log` :399 — row: usage `{prompt_tokens??0, completion_tokens??0, reasoning_tokens: completion_tokens_details.reasoning_tokens??0, cached_tokens: prompt_tokens_details.cached_tokens??0, cost}` or null; cost_usd; response_format; web_engine; request `{system, user}` (user WITHOUT the json_object suffix); `response` only when content given; `error`; claim_id only if set.
- `class ContentError` :432; `parseContent(content, schema)` :434 — slice first `{` to last `}`; "no JSON object in the reply: <200 chars>"; "invalid JSON in the reply: ..."; "reply does not match the schema: ...".

Side effects: network via fetch; Date; default sleep setTimeout. Seams: all deps incl. `today`.

OpenRouter chat-completions (non-streaming) response a fake must return:
```json
{ "id":"gen-1", "model":"openai/gpt-6-luna-20260601", "provider":"OpenAI",
  "choices":[{"message":{"role":"assistant","content":"<JSON string>" | [{"type":"text","text":"..."}],
     "annotations":[{"type":"url_citation","url_citation":{"url":"https://src","title":"Src","content":"","start_index":0,"end_index":1}}]}}],
  "usage":{"prompt_tokens":100,"completion_tokens":50,"completion_tokens_details":{"reasoning_tokens":20},"prompt_tokens_details":{"cached_tokens":10},"cost":0.001} }
```
Errors: `{error:{code, message}}` with status 400/401/402/429/5xx or 200.

Fake used today (`tests/factcheck.test.ts:480-498`): `completion(content, extra)` → `Response`; `client(responses)` → `{c, bodies (parsed), rows, budget}`, `sleep: async () => {}`, `today: () => "24 September 2026"`.

Covered: research request shape (model, reasoning, provider, plugins, json_schema strict, no temperature, today in prompt, user < 1600 chars), call row usage/cost, budget s2; audit/rewrite omit plugins + audit effort low; json_object fallback on 400 with web + byte-identical system prompt + sticky; finalizeVerdict merge/limits/http-only/strip/downgrade; gradeOf; parseContent schema error + fenced JSON.

NOT covered:
- `it("citationsOf: non-array → []; skips non url_citation and missing url; non-string title → url")`
- `it("truncateWords keeps original spacing when ≤ n words and collapses when truncating")`
- `it("stripCitations: single parenthesised cite, ';'-separated group, bare [t](u), space before punctuation, double spaces")`
- `it("stripCitations leaves a trailing ')' for URLs containing parentheses")` (documents the smell)
- `it("finalizeVerdict: title empty → hostname without www; invalid 'https://' url keeps url as title; HTTPS uppercase kept; empty url skipped")`
- `it("finalizeVerdict: unverifiable with no sources is not downgraded; strip happens before the 200-char slice")`
- `it("gradeOf: supported with reason 'private' → false_alarm")`
- `it("default today() formats en-GB 'D Month YYYY'")` (vi.setSystemTime).
- `it("research sends only the last 1500 chars of the segment")`
- `it("research with web=null sends no plugins and does not fall back on 400")`
- `it("fallback body: provider.require_parameters false, user has the schema suffix, row request.user has no suffix, response_format json_object")`
- `it("fallback also triggers on ContentError (reply not matching schema) with web")`
- `it("fallback failure rethrows and does not set the sticky flag (next research tries json_schema again)")`
- `it("non-400 errors (e.g. 500 x2) with web do not fall back")`
- `it("audit with 400 throws without fallback")`
- `it("5xx then success → 2 fetches, sleep(backoffMs(1, null, rand)) = 2000 with rand 0")`
- `it("429 with retry-after 3 sleeps 3000 then succeeds")`
- `it("2 failures exhaust maxAttempts=2: row ok:false attempts:2 error set")`
- `it("non-transient 402 → BudgetExhaustedError('provider'); 401 → message rewritten")`
- `it("budget refused → throws before fetch, no log row, onStart not called")` (contrast with Jev)
- `it("onStart called once per chat() (twice on fallback)")`
- `it("200 with error body is retried; missing usage.cost fails without retry")`
- `it("content as array of parts is joined; missing content → ContentError 'no JSON object'")`
- `it("usage without details logs reasoning_tokens 0 and cached_tokens 0")`
- `it("row: web_engine null for audit, claim_id omitted when absent, response contains the raw content")`
- `it("parseContent: prose around JSON parses; '{bad' → 'invalid JSON'; no braces → 'no JSON object'")`
- `it("VERDICT/AUDIT/REWRITE JSON schemas list every property as required")` (schema snapshot).

Smells:
- Budget refusal in `chat` :335 throws before logging — no `s2_call` row, unlike Jev (which logs a 0-attempt row). Inconsistent audit trail.
- One malformed reply (ContentError) on a web call flips the client to json_object for the rest of the session (:309, :313). Hedged: intended "sticky" per §6 but broader trigger than "strict rejected".
- `stripCitations` :162-163 regexes `[^)]*` break on URLs containing `)` (e.g. Wikipedia `_(film)`), leaving a stray `)`.

---

## 13. `src/chat/chat.ts` (642 lines)

Purpose: host chat about the on-screen session's transcript via OpenRouter streaming chat completions; append-only `chats.jsonl`; model catalogue; cost incl. stopped replies; own per-recording cap.

Exports:
- `MODELS_URL` :9 `https://openrouter.ai/api/v1/models`; `GENERATION_URL` :10 `https://openrouter.ai/api/v1/generation`; `CHAT_SYSTEM` :20.
- `TranscriptLine` :29, `ChatSource` :32 (`sessionId, dir, live, lines(), budget?`), `ModelInfo` :43, `SentLines` :50, `ChatMessage` :60, `ChatCallRow` :69; private `Row` :81, `ChatRecord` :90; `ChatMeter` :95; `ChatEvent` :108 (start|thinking|delta|done|error); `class ChatError(status, message)` :115; `ChatDeps` :121 (`fetch, apiKey, source(), onSpend?, sleep?, rand?`).
- `clock(ms)` :132 — floor secs, negative → 0; `m:ss` or `h:mm:ss`.
- `formatLine(l)` :138 → `[clock] Speaker: text`; private `approxTokens` :141 = ceil(len/4).
- `composeQuestion(prev, lines, live, question)` :147 — from = min(prev.to ?? 0, lines.length); renames announced only for ids present in current lines whose name changed; names updated with added lines; upToMs = max(prev.upToMs, added startMs) or null; first: `<transcript status="live, still being recorded"|"finished" lines="N" up_to="m:ss">\n...\n</transcript>` or `<transcript status="...">No one has spoken yet.</transcript>`; later: `<speaker_names>...; ....</speaker_names>`, `<recording_status>The recording has ended.</recording_status>` when prev.live && !live, `<transcript_update lines="a–b" up_to="...">` (en dash) or `<transcript_update>No new lines since the previous question.</transcript_update>`; then `<question>\n...\n</question>`; parts joined by blank line.
- private `readRows(path)` :181 — missing → []; torn lines skipped.
- `foldChats(rows)` :192 — create; ignore rows for unknown chats; rename/model/rewind(slice keep)/delete; updatedAt from chat rows and messages (NOT calls); message rows increment messageRows (never decremented by rewind → ids stay unique); calls appended.
- `chatSpend(rows)` :220 — sum of numeric cost_usd over chat_call rows (deleted chats included).
- `class ChatService` :222:
  - `models()` :236 — cached 1 h when ok, 60 s when failed; fetch `MODELS_URL` with `AbortSignal.timeout(10000)`; non-ok → failure; failure keeps previous `byId`; per configured model: name (fallback id), contextLength (`context_length` ?? `top_provider.context_length` ?? null), maxOutput (`top_provider.max_completion_tokens`), prices per M = round(n×1e6, 4 dp) or null if missing/non-finite/negative (strings parsed), available: listed → true; not listed & catalogue non-empty → false; empty catalogue → null. Returns `{default, capUsd, models}`.
  - private `need()` :271 — no source → `ChatError(409, "no session on screen: ...")`; `path` :277 `<dir>/chats.jsonl`; `append` :281 — `appendFileSync(path, processSecrets()(JSON.stringify(row)) + "\n")` (keys redacted); `get` :289 → `ChatError(404, "unknown chat X")` if missing/deleted; `busy` :295 by `<sessionId>/<chatId>`.
  - private `meter` :299 — contextTokens = prompt+completion of latest call with usage whose message is still kept; leftTokens = max(0, contextLength − contextTokens) or null; totals over ALL calls with usage; costUsd over all calls; estimated if any; pendingLines = lines after the last message's `lines.to`; pendingTokens = Σ(approxTokens(formatLine)+1).
  - private `view` :317 — messages without `sent`, meter.
  - `list()` :326 — no source → `{sessionId:null, chats:[], spentUsd:0, capUsd}`; non-deleted, sorted by updatedAt desc (string compare), with message count and cost.
  - `chat(id)` :339; `create(model?)` :345 — unknown model → 400 `unknown model X`; id `chat_<count of create rows + 1>`; title "New chat".
  - `update(id, {title?, model?})` :356 — title non-string/blank → 400 "title must be a non-empty string"; >120 trimmed → 400 "title is too long"; model not in list → 400; same model → no row.
  - `remove(id)` :373 — aborts in-flight; appends delete; `{deleted}`.
  - `stop(id)` :382 — `{stopped: !!ctl}`.
  - `prepare(id, {content?, mode?})` :397 — sync validation: need/get; mode edit|regenerate else send; busy → 409 "this chat is already writing a reply"; chatSpend ≥ capUsd → 409 "chat spend on this recording ($X.XXXX) reached its cap of $N (chat.capUsd in config/app.json)"; regenerate without user → 400 "nothing to regenerate", keep = lastUser+1; send/edit: empty content → 400 "content is required"; >20000 → 400 "the question is too long"; edit without user → 400 "nothing to edit", keep = lastUser. Registers AbortController in `inflight` NOW; returns `run(sink)` that removes it in finally.
  - private `run` :432 — rewind row if keep < messages.length; new user message (not regenerate): `m_<++rows>`, `sent` = composeQuestion using the last message with `lines`; append; auto-rename on first question when title "New chat": `content.replace(/\s+/g," ").slice(0,60) + (content.length > 60 ? "…" : "")`, row `auto:true`. `sink(start {user (no sent) | null, assistantId, model})`. `info = model(c.model)` (may fetch catalogue). body `{model, messages: history(c), stream:true, usage:{include:true}, provider: cfg.provider, reasoning:{effort}}`. Loop: stream; on error: `ctl.signal.aborted` → stopped (no retry); else retry only if no content yet, class retry, attempt < maxAttempts (sleep backoff); else `error = describe(e, model)` and 402-fail → `s.budget?.exhaust("provider","chat",...)` (thrown error swallowed). Cost: `out.usage.cost` if number; else if genId → `generation(genId)`; else if still null and genId → estimate `(approxTokens(bodyText)×inputUsdPerM + approxTokens(content)×outputUsdPerM)/1e6`, estimated true. Call row `{kind:"chat_call", chat_id, message_id: assistantId, model, ok: !error, latency_ms, attempts, id: genId, model_returned, provider_returned, usage{prompt, completion, reasoning, cached}|null, cost_usd: cost ?? 0, estimated?, stopped?, error?, at}`. Appends assistant message (content, stopped?, error?) then call row. cost > 0 → `s.budget?.record("chat", cost)` + `onSpend(s)`. `view`; emits `error` (if any) then `done {message, call, chat}`.
  - private `history(c)` :539 — system + users (`sent ?? content`) + assistants with non-empty content; `anthropic/*` → last message content becomes `[{type:"text", text, cache_control:{type:"ephemeral"}}]`.
  - private `stream` :555 — POST CHAT_URL, headers as Jev, `signal: AbortSignal.any([stop, AbortSignal.timeout(cfg.timeoutMs)])`; fetch throw → HttpError(null); `!ok || !body` → HttpError(status, text, retryAfter); SSE parse: split on "\n", trim, skip lines not starting `data:`, skip empty/`[DONE]`, skip bad JSON; `j.error` → `HttpError(code number ?? 200, data)`; `genId ??= j.id`; model/provider/usage captured when present; `choices[0].delta.content` non-empty → delta event; else first `delta.reasoning` or non-empty `reasoning_details` → one `thinking` event. Reader errors → HttpError(null).
  - private `generation(id)` :609 — up to 3 tries, `sleep(1000×(i+1))` BEFORE each; GET `${GENERATION_URL}?id=<enc>` with Bearer, timeout 5000; non-ok → next; `data.total_cost` number → `{cost, prompt: native_tokens_prompt ?? tokens_prompt ?? 0, completion: native_tokens_completion ?? tokens_completion ?? 0}`; else null.
- private `describe(e, model)` :628 — 401 → "OpenRouter rejected the API key (401): check OPENROUTER_API_KEY."; 402 → "OpenRouter credits or the key's limit are exhausted (402)."; 404 + /data policy|endpoints/i in error.message → "No provider of <model> accepts this project's privacy setting (data_collection: deny). Pick another model."; 429 → "<model> is rate-limited right now (429). Try again in a moment, or pick another model."; JSON message → "<model>: <msg>"; else `e.message.slice(0,300)`; non-HttpError → message.

Side effects: fs append/read in `<source.dir>/chats.jsonl`; network (catalogue, streaming completions, generation lookup); `Date.now`; `process.env` via processSecrets; AbortController; timers via default sleep.

Seams: `deps.fetch` (routes by URL), `deps.sleep`, `deps.rand`, `deps.source` (tmp dir + in-memory lines + optional Budget), `deps.onSpend`, `apiKey` (server uses a getter).

Streaming SSE a fake must produce (`text/event-stream` body as a `ReadableStream<Uint8Array>`):
```
: OPENROUTER PROCESSING\n\n
data: {"id":"gen-1","model":"openai/gpt-6-luna","provider":"OpenAI","choices":[{"delta":{"content":"Alice"}}]}\n\n
data: {"id":"gen-1","choices":[{"delta":{"reasoning":"..."}}]}\n\n            (optional → one "thinking")
data: {"id":"gen-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":8,"cost":0.0012,"completion_tokens_details":{"reasoning_tokens":3},"prompt_tokens_details":{"cached_tokens":100}}}\n\n
data: [DONE]\n\n
```
Mid-stream error chunk: `data: {"error":{"code":502,"message":"upstream"}}`. Catalogue: `{data:[{id, name, context_length, pricing:{prompt:"0.0000001", completion:"0.0000005", input_cache_read:"..."}, top_provider:{context_length, max_completion_tokens}}]}`. Generation: `{data:{total_cost, native_tokens_prompt, native_tokens_completion}}`.
For STOP tests the fake must honour `init.signal`: `init.signal.addEventListener("abort", () => controller.error(init.signal.reason))` and keep the stream open (don't `close()`), so `reader.read()` rejects when `svc.stop(id)` is called.

Fake used today (`tests/chat.test.ts:46-76`): `fakeOpenRouter(reply, usage)` → `{fetchFn, bodies}` (URL ending `/models` → catalogue with only gpt-6-luna; else SSE split by words); `setup(lines, {budget, live})` → `{dir (mkdtemp), svc, or, ask(id, body) → events[], spends()}`; `line(n, speakerId, speaker)`.

Covered: composeQuestion first/update/no-new/renames/ended/empty; models() catalogue mapping + unavailable; create spends nothing + list; stream → events order, done payload, auto-title, meter, budget chat bucket, onSpend, request shape, second question byte-identical prefix + update only; edit/regenerate; cap refusal; rename/model/delete + unknown model + unknown chat.

NOT covered:
- `it("clock: 0 → '0:00', 59_999 → '0:59', 3_725_000 → '1:02:05', negative → '0:00'")`
- `it("composeQuestion clamps from when lines shrink; upToMs null with no lines ever; no rename note for a speaker absent from current lines; finished→finished has no ended note")`
- `it("foldChats ignores rows for unknown chats; rewind keeps messageRows so new ids stay unique; calls do not change updatedAt")`
- `it("chatSpend includes deleted chats and ignores non-number cost_usd")`
- `it("readRows skips a torn last line in chats.jsonl")`
- `it("models() caches for an hour: second call makes no fetch; after 1h+1ms refetches")` (vi.setSystemTime)
- `it("models() failure (HTTP 500 or throw): available null with empty catalogue, retried after 60 s; keeps the previous catalogue on failure")`
- `it("models() price parsing: missing/negative/'abc' → null; context_length falls back to top_provider.context_length; name falls back to id; cacheReadUsdPerM")`
- `it("no source: chat/create/update/remove/stop/prepare throw ChatError 409; list returns sessionId null")`
- `it("create with an explicit allowed model; unknown → 400; ids count deleted chats (chat_2 after deleting chat_1)")`
- `it("update: title '' / 123 → 400; 121 chars → 'too long'; trimmed title saved; same model appends no row")`
- `it("prepare validation: busy → 409; empty content → 400; 20001 chars → 400; regenerate/edit with no question → 400; unknown mode → send")`
- `it("auto-title only from the first question; >60 chars gets '…'; a renamed chat is not auto-titled")`
- `it("start event user has no 'sent'; regenerate start has user null")`
- `it("thinking is emitted once before the first delta for reasoning / reasoning_details deltas")`
- `it("SSE split mid-line across reads, CRLF lines, comment lines, bad JSON lines, [DONE] are handled")`
- `it("HTTP 429 before the stream → retried after backoff sleep, then succeeds; attempts 2")`
- `it("network error twice → error event 'TypeError: ...' then done with ok:false, attempts 2")`
- `it("mid-stream error chunk before content is retried; after content it is not retried and the partial reply is kept with error")`
- `it("401 → error 'OpenRouter rejected the API key (401)...', no retry")`
- `it("402 non-transient → source budget exhausted ('provider') and error message '(402)'; no throw out of run")`
- `it("404 with 'No endpoints found matching your data policy' → privacy message")`
- `it("other HttpError with JSON message → '<model>: <msg>'; non-JSON body → 'HTTP <s> ...'")`
- `it("ok response with null body → treated as 2xx no-code error and retried")`
- `it("stop mid-stream: stop() → {stopped:true}; reply keeps partial content, stopped:true on message and call; not retried")`
- `it("stopped reply cost from generation lookup: sleeps [1000], uses total_cost and native tokens")`
- `it("generation lookup failing 3 times → sleeps [1000,2000,3000], estimated cost from price list, call.estimated true, meter.estimated true")`
- `it("stopped before any chunk (no gen id) → cost 0, usage null, no generation lookup, no budget record/onSpend")`
- `it("stop() with nothing in flight → {stopped:false}")`
- `it("remove() aborts an in-flight reply")`
- `it("history: failed replies with empty content are left out; anthropic model marks the last message with cache_control ephemeral")`
- `it("request timeout (cfg.timeoutMs tiny) is an error, not a stop")` — or assert `AbortSignal.any` composition via spy.
- `it("meter after an edit uses the latest kept call; leftTokens null without contextLength; pendingTokens formula")`
- `it("list sorts by updatedAt desc and reports busy while a reply streams")`
- `it("chat rows never contain the API key: process.env.OPENROUTER_API_KEY value in a question is written as [redacted]")` (set/restore env; secret ≥ 8 chars).
- `it("model change mid-chat sends the whole history to the new model")`

Hard to test: stop/abort (needs signal-aware stream fake, above); cache timing (`vi.setSystemTime` or `vi.useFakeTimers({toFake:["Date"]})`); generation sleeps (inject `sleep` recorder). No refactor needed.

Smells:
- `prepare` :422 registers `inflight` before the returned runner is invoked; if the caller never calls it (e.g. server's `streamChat` throws before running), the chat stays `busy` (409) until restart. Hedged: `server/main.ts:759` passes it straight to `streamChat`; unverified whether `streamChat` can fail before calling it.
- Auto-title ellipsis uses `req.content.length` (pre-whitespace-collapse) :451 — a 61-char string with collapsible spaces may get "…" without truncation. Cosmetic.
- `describe` :632 uses `e.body.slice(e.body.indexOf("{"))` — with no `{` slices the last char (caught by try). Harmless.
- A partially-streamed reply that errored keeps its content and is re-sent in history (:543). Probably intended.
- Redacting rows on write (:282) means the re-read `sent` may differ from what was actually sent (only when a key appears in text) — cache prefix break; negligible.

---

## Area-wide notes

### Reusable fakes worth extracting into `tests/fakes/`
1. `fakes/responses.ts` — `json(status, body, headers?)`, `text(status, s)`, `timeoutError()` (`DOMException("...","TimeoutError")`), `networkError()` (`TypeError("fetch failed")`), `brokenBody()` (ReadableStream that errors), `deferred()` helper.
2. `fakes/jev.ts` — `FakeJev`: queue of responders, `ok(answers, {cost, id, model, provider})`, `err(status, {code, message, limit_source}, headers)`, `embeddedError(body)`; records `{url, headers, body(parsed), signal}`; `setupJevClient(responses, budgetOpts)` (from jev.test:22); answer builders `noulA(p)`, `choiceA(k)`, `scoreA(s)` and the factcheck `ans()`.
3. `fakes/openrouterChat.ts` — `FakeOpenRouter` routing by URL: `/chat/completions` non-stream (`completion(content, {annotations, usage, contentParts})`) for S2; streaming SSE builder `sse(chunks, {splitAt?, holdOpen?, errorAfter?})` that honours `init.signal`; `/models` catalogue builder; `/generation?id=` responder with scripted statuses; records bodies.
4. `fakes/openai.ts` — `/v1/models` (`{data:[{id}]}`) and OpenRouter `/api/v1/key` (`{data:{limit, limit_remaining, is_free_tier}}`) from keys.test `fakeFetch`; offline mode. (Transcription/realtime fakes belong to the transcribe scanner.)
5. `fakes/s2.ts` — `fakeS2()` + `VERDICT()` + `change()`/`proposal()` + `checker()` harness from factcheck.test (make `uN` counter local to the harness to avoid cross-test coupling: tests currently reset global `uN = 0` manually).
6. `fakes/budget.ts` — `makeBudget(overrides)` recording `exhausted`/`costs`.
7. `fakes/env.ts` — `withEnv({...}, fn)` / `snapshotEnv()` restoring `process.env` keys (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `TATTLE_CREDENTIALS`); `tmpDir(prefix)`; `withAppPaths(partial)` with `afterEach(() => setAppPaths())`.
8. A `ChatSource` factory: `{sessionId, dir: mkdtemp, live, lines: () => arr, budget?}`.

### Gotchas constraining tests here
- Never construct `KeyStore`/call `loadKeys`/`migrateAppSupportDir()`/`sumDevSpend()` without explicit tmp paths (real user data).
- `paths.ts` is module-global state: always `afterEach(() => setAppPaths())`; `setAppPaths({})` resets.
- `processSecrets` redacts only secrets ≥ 8 chars currently in `process.env`.
- Jev pause and chat catalogue TTL read `Date.now()` directly: freeze with `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime`, not full fake timers (full fake timers would stall `AbortSignal.timeout`/stream reads only if code awaited them; the injected `sleep` avoids that anyway).
- `FactChecker.drain` and `ResearchQueue` default timers use real `setTimeout(...).unref()`; pass `setTimer` capture or small `maxMs`.
- Timeouts are not observable on a fake fetch except via `init.signal`; spy `AbortSignal.timeout` to assert configured values.
- File permission assertions (0600/0700) rely on process umask not widening; `writeFileSync(..., {mode})` + explicit chmod makes them deterministic. Root would bypass the read-only-dir trick for the migrate-failure test.
- e2e with these modules (session/server) already exist in other test files and need `requireAssets()`; unit tests here need no assets.

### Proposed test count
≈ 245 `it(...)` cases listed above (types 7, jev client 27, budget 10, config 11, keys 19, paths 5, licenses 7, version 4, gate 6, queue 11, s1 ≈ 52, s2 ≈ 27, chat ≈ 36 + fixture/snapshot extras).

### Biggest gaps (priority)
1. Chat streaming failure/stop/cost paths (stop mid-stream, generation lookup, estimate, retries, describe messages, SSE edge cases, catalogue cache) — none tested.
2. S2 client retries/402/401/budget-refusal/fallback edge cases and verdict helpers edge cases.
3. FactChecker error paths (research/audit/rewrite failures, gate_failed, queue drops → claim state, evidence reset, rewriteInput).
4. Jev client background backoff sequence, concurrency priority, timeout selection, 401 rewrite, transient-402 live.
5. licenses()/appInfo with tmp trees; keys edge cases (whitespace env, format boundaries, HTTP warnings, KeySetup 400s).
6. Coverage tooling absent (`@vitest/coverage-v8`).
