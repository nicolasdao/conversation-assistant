> **Inventory for [SPEC.md](../SPEC.md) — Area 5: web front end part A (panels, timeline, player, markdown, licenses, dom) and happy-dom helpers.** Written 2026-09-29 by a read-only scan of commit `74b42a6`. Line numbers were right at that commit; **symbol names win when lines drift** (grep them). "Spike" and "scratchpad" mentions refer to throwaway experiments run outside the repo during the scan; they are not available to you, but every recipe they validated is written out below. Items marked *unverified*/*UNSURE*/*hedged* are exactly that — verify before relying on them. SPEC.md overrides this file wherever they disagree (scope, thresholds, bug policy, file layout).


# Scan: web front end, part A (panels, timeline, player, markdown, licenses, dom)

Scanner: read-only. Every file in scope was read in full: web/src/panels.ts, timeline.ts, player.ts, markdown.ts, licenses.ts, dom.ts, web/index.html, web/licenses.html. I grepped web/styles.css for the classes the code toggles. I also read the dependencies these files import (state.ts, api.ts, router.ts, desktop.ts, the head of transfer.ts, and app.ts for how things are wired) and tests/router.test.ts.

**Checks I ran**, from a throwaway Vitest config in the scratchpad. No project file was touched.
- panels.ts, timeline.ts, player.ts, markdown.ts and dom.ts all import cleanly under Vitest's **node** environment, with no DOM present. The `./x.js` specifiers resolve to `./x.ts` automatically.
- `dom.clock(3723000) === "1:02:03"` and `dom.usd(0.005) === "$0.0050"`.
- `segmentMatches` returns false for every segment while a speaker filter is set (see latent bugs).
- I ran markdown edge cases through a fake `document` and ran `linkify` edge cases in plain Node. The results are quoted below.

**Installed test tooling:** no DOM library and no Playwright. happy-dom, jsdom and @playwright/test are all absent from node_modules and must be added as devDependencies. The package.json devDeps are: vitest ^5.0.1, typescript ^7, tsx, esbuild, electron.

---

## 0. Area-wide notes (read first)

### DOM environment: use happy-dom
Reasons specific to this code:
- **`<dialog>`.** The code relies on `HTMLDialogElement.showModal()`, `.close(returnValue)`, `.returnValue`, `.open` and the `close` event. Callers include `ask` panels.ts:47-63, bindControls panels.ts:158-168, openStartLive panels.ts:194-195, openSpeaker panels.ts:527 and jumpToSegment panels.ts:616.
  - happy-dom implements all of these.
  - jsdom still does not implement `showModal()`/`close()`, as far as I know. This is the deciding factor. There are about 10 call sites, and stubbing them all in jsdom is noisy.
- **PointerEvent and setPointerCapture.** bindSplit panels.ts:1138-1157 and bindTimeline timeline.ts:159-193 use them.
  - happy-dom has `PointerEvent`.
  - I am unsure whether happy-dom has `setPointerCapture`, so stub it: `HTMLElement.prototype.setPointerCapture ??= () => {}`.
- **requestAnimationFrame.** player.ts:63 uses it. happy-dom provides it. jsdom only provides it with `pretendToBeVisual`.
- **CSS custom properties.** panels.ts:1160 and timeline.ts:95,179,197 call `getComputedStyle(el).getPropertyValue("--split" | "--tl-chart")`.
  - happy-dom resolves inline `style.setProperty("--x")`. I have not verified this, so treat it as uncertain.
  - The code falls back to its defaults (56.5 and 100) when the value is "", so tests work either way. Assert through `style.getPropertyValue` on the element itself rather than through the computed style.
- **Stubs needed in either environment:**
  - **Popover API.** toast panels.ts:18-22 calls `box.matches(":popover-open")`, `showPopover()` and `hidePopover()`.
    - I am uncertain whether happy-dom supports `:popover-open`. The selector parser may **throw a SyntaxError** on it, and jsdom's nwsapi certainly throws.
    - This matters because `toast` runs in every `run()` error path. If it throws inside `run`'s catch (panels.ts:31), the promise rejects unhandled.
    - Stub: `HTMLElement.prototype.showPopover = function(){this.dataset.popOpen="1"}` and `hidePopover = function(){delete this.dataset.popOpen}`. Also wrap `Element.prototype.matches` so it maps `":popover-open"` to `this.dataset.popOpen === "1"`.
    - Better seam: a tiny `isPopoverOpen(el)` helper in panels.ts, wrapped in try/catch.
  - **`scrollIntoView`.** Used at panels.ts:617, player.ts:51 and licenses.ts:55. Stub it as a no-op `vi.fn()`. jsdom lacks it; I am not sure about happy-dom.
  - **Audio.** `Audio`/`HTMLAudioElement` media behaviour (player.ts:140-145) needs a `FakeAudio`. See the helpers below.
  - **`AudioContext`** (player.ts:104). Neither environment has it, so stub it.
  - **`window.open`** (panels.ts:105). Stub it: happy-dom may try to open a real frame.
  - **Layout.** `clientWidth`, `scrollWidth`, `scrollHeight`, `offsetHeight` and `getBoundingClientRect` are all 0 in a DOM environment. Set them with `Object.defineProperty(el, "clientWidth", { value: 1000, configurable: true })` wherever timeline zoom, seek or hover math is asserted (timeline.ts:49-86,160-164,207-221).
- **Locale and timezone.** `when()` panels.ts:1005-1008 and `renderErrors` panels.ts:996 use `toLocaleString`/`toLocaleTimeString(undefined, …)`, so their output depends on the Node ICU locale and `TZ`. Set `process.env.TZ = "UTC"` in setup, and assert with regexes (e.g. `/\d{2}:\d{2}:\d{2}/`) or compute the expected value with the same call.
- **Choosing the environment per file.** Put `// @vitest-environment happy-dom` at the top of each web DOM test file. The current vitest.config.ts has no `environment`, so everything else stays in node. router.test.ts already works in node because `readRoute` takes the location as a parameter.
- **fetch.** `tests/setup.ts` sets `globalThis.fetch` to a function that throws. In happy-dom `window === globalThis`, so any `api.*` call you did not mock rejects with "network disabled in tests". That surfaces as an error toast through `run()`. It is a good default.
  - To control the API, use `vi.mock("../web/src/api.ts", …)`. panels imports it as `"./api.js"`, and Vite resolves that to the same file id.
  - This is very likely to work but I did not verify it with a mock. Keep `ApiError` real: `vi.mock(path, async (orig) => ({ ...(await orig()), api: fakeApi }))`.
- **Module-level state.** Tests need isolation from it, so use `vi.resetModules()` plus `await import(...)` per test, or at least per describe block.
  - panels.ts state: `filters` :10 (exported, so it can also be reset by hand), `replaySpeed` :90, `onViewGone` :92, `shownBlock`/`entering` :275-276, `onTimeClick` :531, `suggest` :690, `editorVersion`/`editorTouched` :848-849, `libraryQuery`/`libraryTimer` :1002-1003.
  - timeline.ts state: `zoom`, `spanMs`, `hoverX`, `redraw`, `playhead`, `onSeek` (:38-109).
  - player.ts state: `audio`, `sessionId`, `frame`, `current`, `userScrolledAt`, `jumped`, `boost`, `onPosition`, `reportedAt` (:9-67).
  - licenses.ts state: `all`, `shown`, `current`, plus the top-level code.
  - desktop.ts:15 reads `globalThis.desktop` once, **at import time**. To test the desktop branch, set `globalThis.desktop = { run: vi.fn(), onCommand: vi.fn() }` *before* the dynamic import, after `vi.resetModules()`.
- **Circular import.** transfer.ts imports `toast` from panels.ts, and panels.ts imports `openExport`/`openImport` from transfer.ts. This is harmless because neither module uses the other at top level. When testing recordings rows, mock `../web/src/transfer.ts` (`openExport: vi.fn(), openImport: vi.fn()`).
- **Bespoke selects.** ui.ts's `bindBespoke` is NOT called by panels, timeline or player. In unit tests every `<select>` stays native, so set `.value` and dispatch `change`.
  - In the real page (E2E) every `<select>` is **hidden** and replaced by `span.sel > button.sel-btn[role=combobox]` plus a popover `div.sel-list[role=listbox] > .sel-opt[role=option]`.
  - The combobox's aria-label is `"<aria-label or <label> text>: <current option text>"`, e.g. "Playback speed: 1×".
  - In Playwright, use `getByRole('combobox', { name: /^Playback speed/ })` then `getByRole('option', { name: '4×' })`. Alternatively use `locator('#play-speed').selectOption('4', { force: true })`, which is less realistic.
  - ui.ts also moves `title` into `data-tip`/`aria-description` on first hover or focus, so E2E must not assert `title` after hovering.

### Shared test helpers (recommend creating `tests/web/helpers.ts`)
1. **`loadIndexHtml()`.** Read web/index.html, take the `<body>` innerHTML without the `<script>` tag, and set `document.body.innerHTML` and `document.body.className = ""`. Then every id the code queries exists, exactly as in production.
   - Add `loadLicensesHtml()` for licenses.html.
   - The SVG `<symbol id="g-*">` defs come along for free.
2. **`installBrowserStubs()`.** Installs: popover (see above), `scrollIntoView`, `setPointerCapture`/`releasePointerCapture`, `window.open = vi.fn()`, `AudioContext` (FakeAudioContext), `Audio` (FakeAudio), and a `layout(el, { clientWidth, scrollWidth, scrollHeight, clientHeight, rect })` helper.
3. **`FakeAudio extends EventTarget`**:
   - fields: `src`, `preload`, `preservesPitch`, `playbackRate`, `currentTime`, `paused = true`, `readyState = 0`;
   - `play()`: `paused = false`, dispatch `play`, resolve (or reject when `failPlay` is set);
   - `pause()`: `paused = true`, dispatch `pause`;
   - `loadMetadata()`: `readyState = 1`, dispatch `loadedmetadata`;
   - `end()`: dispatch `ended`.
   - Record instances in `FakeAudio.instances`.
4. **`FakeAudioContext`**: `createGain() → { gain: { value: 1 }, connect(n) { return n }, context: this }`, `createMediaElementSource(a) → { connect(n) { return n } }`, `destination: {}`, `resume = vi.fn()`, `close = vi.fn()`. Set `FakeAudioContext.throwOnNew` to cover the catch at player.ts:107.
5. **`makeState()` builder** on top of `emptyState()` from web/src/state.ts, with chainable pieces:
   - `session({ id = "s1", mode = "live", status = "running", paused, features, streams, echoGate, hasAudio, name })`;
   - `speaker(id, name, mergedInto?)`;
   - `utt(id, { stream = "host", startMs, endMs, speakerId, text = "t", tags = [], filler, speakerInferred })`;
   - `missing(id, status)`;
   - `partial(itemId, { stream, text, final, receivedAt, utteranceId })`;
   - `seg(id, startMs, endMs, uttIds, labels?)`;
   - `labels({ subject: [choice, conf, faded], mode: [...], markers, mentions, heat, hype, unlabeled, story })`, which builds the `Labels` object (`choices.subject`, `choices.mode`, `scores.heat/hype`);
   - `claim(id, { utteranceId, speakerId, text, status, verdict, repeats, duplicates, disputed, dropReason, latencyMs, activity, grade })`;
   - `health(stream, { rmsDbfs, msSinceLastFrame, receivedAt, lastSoundAt, echoMutedMs, detail })`;
   - `stats({ roganIndex, speakers, predictions, recommendations, clips, factcheck })`, `cost({...})`, `errors([...])`, `s1({ active, versions, memorySize, last, misses })`, `labelSet({ prefix, questions })`.
   - Optional: `feed(st, events)` that runs `applyEvent` from state.ts over an event list, so fixtures look like the real SSE stream. This is also what the E2E fake engine would emit.
6. **`fakeApi()`**: an object with a `vi.fn()` for every `api` member in api.ts:125-170 (sessions, openSession, renameSession, deleteSession, replaySession, rename, merge, suggestMerges, putLabels, putStories, relabel, override, rollback, pause, resume, stop, startLive, startReplay, devices, about, engine, licenses), all resolving by default.
7. **`flush()`**: `await new Promise(r => setTimeout(r, 0))`, repeated twice. `run()` chains `await fn()` and then `toast`. Or use `vi.waitFor`.
8. **Fake timers**: `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"] })`. These cover toast removal after 6 s, the 250 ms recordings search debounce, player reporting every 5 s, partial expiry after 8 s, and the health ages from `Date.now()`.

### Suggested seams (to reach ~100% cheaply)
These are optional small refactors. None is needed for DOM tests, but each turns branchy code into pure functions.
- **panels.ts.**
  - Export `plural` :330, `minus` :376, `criteriaText` :851, `parseCriteria` :857 and `when` :1005 (with an injectable locale).
  - Extract `startSummary(fc, lb) → { what, perHour, atMost }` from :179-184.
  - Extract `onairBlock(session) → "live" | "paused" | "replay" | null` from :280-281.
  - Extract `featuresOffLabel(st)` from :314.
  - Extract `meterModel(stream, hl, now, { running, present, paused })` from :401-413.
  - Extract `claimOrder(a, b)` from :670-671 and `tally(claims)` from :677-683.
  - Extract `recordingMeta(r)` from :1082-1083.
- **timeline.ts.** Export `pct` :33 and extract `tickStep(trackPx, endMs)` from :310-311 and `yOf` from :301.
- **licenses.ts.**
  - Move `linkify` :14, `items` :27 and `FOLD_OVER` into an importable module such as `licensesModel.ts`.
  - Wrap the top-level code (:76-96) in `export async function boot()`, called from the bottom of the file. The module would then import without side effects.

---

## 1. web/src/dom.ts: 63 lines

**Purpose.** Tiny DOM helpers with no framework: an element builder, an SVG builder, glyph `<use>`, replace-children, `$`, plus time, money and id formatting.

**Exports.**
- `h` :6
- `s` :14
- `glyph` :22
- `replace` :42
- `$` :48
- `clock` :51
- `usd` :59
- `pretty` :63

Private: `setAttrs` :26, `append` :35, `SVG_NS` :13.

**Pure (no DOM): `clock` :51, `usd` :59, `pretty` :63.** These are verified to run under node.

**DOM dependencies.** `document.createElement` and `createElementNS`, `addEventListener`, `replaceChildren`, `querySelector`. All of these are fine in happy-dom.

**Side effects on import:** none.

**Unit tests.**

`clock`, `usd` and `pretty` can run in node:
- `it("clock(0) is 0:00")`
- `it("clock(59_999) is 0:59")`: the value floors.
- `it("clock(247_000) is 4:07")`
- `it("clock(3_600_000) is 1:00:00")`
- `it("clock(3_723_000) is 1:02:03")`
- `it("clock(-5000) clamps to 0:00")`
- `it("usd(0.005) is $0.0050 (4 decimals under a cent)")`
- `it("usd(0.01) is $0.01")`
- `it("usd(12.345) is $12.35")`: verified in Node.
- `it("usd(0) is $0.0000")`
- `it("usd(-1) is $-1.0000")`: a quirk. Negatives take the 4-decimal branch.
- `it("pretty('ai_models') is 'ai models'")`
- `it("pretty replaces every underscore")`
- `it("pretty leaves ids without underscores alone")`

`h` needs happy-dom:
- `it("h creates the tag with string attributes")`
- `it("h skips null, undefined and false attributes")`
- `it("h sets true as an empty attribute (disabled='')")`
- `it("h stringifies numbers (tabindex=0 → '0')")`
- `it("h binds on* functions as listeners (onclick → click event) and does not set an attribute")`
- `it("h sets value as a property on input/option/select/textarea, not as an attribute")`
- `it("h flattens nested child arrays at any depth")`
- `it("h skips null, undefined and false children but renders 0 as '0'")`: the `0` pitfall.
- `it("h turns strings and numbers into text nodes, so '<b>' stays text")`

`s`, `glyph`, `replace` and `$`:
- `it("s creates an element in the SVG namespace")`
- `it("glyph('flag') is svg.g[aria-hidden=true] > use[href='#g-flag']")`
- `it("glyph with a custom class")`
- `it("replace(null, …) is a no-op")`
- `it("replace empties then appends")`
- `it("$ returns the first match or null")`

**Smells.**
- dom.ts:29: `k.slice(2)` only works for lower-case `on*` keys. `onClick` would listen for "Click", which never fires. No caller does this today.
- dom.ts:30: `"value" in el` is also true for `<li>`, `<button>`, `<progress>` and `<meter>`. For a `<select>`, setting value before its options are appended does nothing. Nobody passes `value` to a select (panels uses `selected` on options), but it is a trap.
- dom.ts:38: a numeric `0` child renders "0". Callers use ternaries, and I found no `n && h()` leaks, but new code could hit it.
- dom.ts:59: `usd` of a negative number gives `$-1.0000`.

---

## 2. web/src/markdown.ts: 124 lines

**Purpose.** A small, injection-safe Markdown to DOM renderer for chat replies and license notices. `[m:ss]` or `[h:mm:ss]` times become `button.md-time` elements that call `onTime(ms)`.

**Exports.**
- `MdOptions` :6
- `renderMarkdown(src, o = {}) → HTMLDivElement.md` :38

Private: `timeMs` :8, `inline` :13, `isTableRow` :35, `cells` :36, `list` :94.

**Pure:** `timeMs` :8, `isTableRow` :35 and `cells` :36 are private, so they need exporting to test directly; otherwise cover them through `renderMarkdown`. `inline` builds DOM.

**DOM dependencies.** Only `h` (createElement, append). The output never uses innerHTML. It runs fine in happy-dom, and I also ran it against a minimal fake `document`.

**Side effects on import:** none.

**Probe results** (actual output, serialized):

| Input | Output |
| --- | --- |
| `"2*3*4 and a * b * c"` | `<p>2<em>3</em>4 and a * b * c</p>` (quirk) |
| `"# "` | `<h3></h3>` |
| `"#######"` | `<p>#######</p>` |
| `"- a\n\n- b\n  - c\n  cont"` | `<ul><li>a</li><li>b<ul><li>c</li></ul> cont</li></ul>` |
| `"1. a\n- b"` | `<ol><li>a</li><li>b</li></ol>` (mixed markers join the first list) |
| a table | `div.md-table > table > thead > tr > th*` and `tbody > tr > td*` |
| `` "```js\nx\n" `` (unclosed) | `<pre><code data-lang="js">x\n</code></pre>`, with a trailing "\n" from the empty last line |
| `"> q\n> **b** [1:02] [10:00:00]"` | `blockquote > div.md > p` containing `q<br>` `<strong>b</strong>` and two `button.md-time` |
| `"[y](javascript:alert(1))"` | stays literal text; only http(s) URLs become links |
| `"---"`, `"* * *"` | `<hr>` |
| `` "__u__ `c` *i*" `` | `<strong>u</strong> <code>c</code> <em>i</em>` |
| `"para\nline2\n# h"` | `<p>para<br>line2</p><h3>h</h3>` |

**Unit tests** (happy-dom, pure input to DOM).

Paragraphs and headings:
- `it("returns div.md; blank lines only → empty div")`
- `it("normalizes \\r\\n")`
- `it("joins consecutive lines of a paragraph with <br>")`
- `it("a blank line splits paragraphs")`
- `it("# → h3, ## → h4, ### → h5, #### → h6, ##### → h6, ###### → h6")`
- `it("'# ' gives an empty h3; '#######' is a paragraph")`
- `it("a heading line ends a paragraph")`: the paragraph loop stops at `#{1,6}\s`.

Rules and fences:
- `it("---, ***, ___ and '- - -' give <hr>")`
- `` it("```lang fence → pre>code[data-lang=lang] with its body verbatim, not inline-parsed")``
- `it("a fence without a lang has no data-lang attribute")`
- `it("an unclosed fence runs to the end")`: the body includes the trailing empty line, giving "x\n".

Quotes and tables:
- `it("> lines → blockquote containing a nested div.md; consecutive > lines join")`
- `it("inline formatting inside a blockquote")`
- `it("a table needs a header row plus a separator (|---| or ---|, :-- allowed); rows continue while lines are |…|")`
- `it("inline formatting inside th and td")`
- `it("a |row| without a separator is a paragraph")`

Lists:
- `it("- / * / + items → ul")`
- `it("1. and 1) → ol")`
- `it("a deeper-indented item nests a list inside the previous li")`
- `it("a deeper-indented non-item line continues the li with a leading space")`
- `it("a blank line then a same-list item continues the list; a blank line then a paragraph ends it")`
- `it("a shallower item ends the nested list")`
- `it("'1. a\\n- b' gives a single ol")`: documents current behaviour.

Inline spans:
- `` it("`code` → <code>, with no parsing inside")``
- `it("**x** and __x__ → strong, recursively parsed (**a *b*** )")`
- `it("*x* → em; '* x *' (space after the star) is not em")`
- `it("[t](https://u) → a[href][target=_blank][rel='noopener noreferrer']")`
- `it("[t](http://u) is linked")`
- `it("[t](javascript:…) and [t](/rel) stay literal text")`
- `it("[1:02] with onTime → button.md-time; click calls onTime(62_000)")`
- `it("[10:00:00] → 36_000_000")`
- `it("[1:2] and [123:45] are not times")`
- `it("without onTime a time stays the literal text '[1:02]'")`
- `it("text around spans is kept in order")`
- `it("'<script>' renders as text, with no element created")`
- `it("'2*3*4' produces em('3')")`: documents the quirk.

**Smells.**
- markdown.ts:15: in the `\*([^*\s][^*]*)\*` alternative, arithmetic like `2*3*4` is italicised.
- markdown.ts:77-80 and :97: a list's ordered/unordered kind is fixed by its first item, so mixed markers merge into one list.
- markdown.ts:49-50: an unclosed fence includes the trailing empty line, and `i++` steps past the end. That is harmless.
- markdown.ts:85: the `if (!para.length)` fallback looks unreachable, since every line not caught as a block before it matches the paragraph loop. I could not construct an input that reaches it, so I am not certain. Mark it `/* c8 ignore */` or delete it.
- markdown.ts:22: the link URL character class `[^\s)]+` stops at the first `)`, so Wikipedia-style URLs with parentheses are cut short.

---

## 3. web/src/timeline.ts: 327 lines

**Purpose.** The bottom timeline strip. It draws section brackets, subject and mode lanes, a heat/hype SVG chart, marker pins, the open segment, pause bands, an axis and a now line.
- Zoom and scroll: − / + / Fit buttons, ⌘/Ctrl-wheel, and a plain wheel scrolls through time while zoomed.
- A hover time line follows the pointer.
- A resize grip changes the chart height, which is remembered in `localStorage` under `pa.timelineChartPx`.
- The playhead, and click-to-seek for recordings.

**Exports.**
- `SUBJECT_COLORS` :9 (8 keys)
- `MODE_COLORS` :13 (7 keys)
- `MARKERS` :17 (6 keys: disagreement, hot_take, prediction, recommendation, clip_worthy, humour)
- `renderLegend(el)` :26
- `setPlayhead(ms, follow = false)` :112
- `setSeekHandler(fn)` :134
- `bindTimeline(onRedraw)` :140
- `renderTimeline(box, st, { matches, onJump, nowMs })` :207

Private:
- `pct` :33
- `zoom` :38, `spanMs` :40, `MIN_VISIBLE_MS` :42, `maxZoom` :43
- `scroller` :45 (#tl-scroll), `track` :46 (#timeline)
- `setZoom` :49, `showZoom` :63
- `hoverX` :72, `showHover` :74
- `CHART_DEFAULT` 100, `CHART_MIN` 60, `STORE_KEY` :88-90
- `setChartHeight` :92, `redraw` :104
- `playhead` :108, `onSeek` :109
- `TICK_STEPS` :205

**Pure.**
- `pct(n)` :33: clamps to 0-100 and returns 4 decimals plus "%".
- `maxZoom()` :43: depends on module `spanMs`.
- The tick-step selection at :310-311 and `yOf` :301 are inline; extract them to test.
- `SUBJECT_COLORS`, `MODE_COLORS` and `MARKERS` are data. Useful as oracles.

**DOM ids it queries.**
- `#tl-scroll`, `#timeline`, `#zoom-level`, `#zoom-out`, `#zoom-in`, `#zoom-fit`
- `#tl-hover` (and its `span`), `#tl`, `#tl-grip`
- `#playhead`, which it creates

**Browser APIs.**
- `localStorage`: fine.
- `getComputedStyle(...).getPropertyValue("--tl-chart")`: falls back to 100.
- `window.innerHeight`: happy-dom default is 768, I believe; set it explicitly.
- `offsetHeight`, `clientWidth`, `scrollLeft`, `scrollWidth`, `getBoundingClientRect`: 0 in happy-dom, so stub them.
- `PointerEvent`, `setPointerCapture`: stub the capture.
- `WheelEvent` with `ctrlKey`/`metaKey`/`deltaX`/`deltaY`: happy-dom has WheelEvent.
- SVG `polyline`: created via `s()`.

**Side effects on import:** none (verified).

**Layout gotcha for tests.**
- In happy-dom `#tl-scroll.clientWidth` is 0. That makes `trackPx = 0` (:221) and the gap `2/0*100 = Infinity` (:238), so the block width falls back to `0.3/zoom` %, and `pxPerMs = 0`, so the tick step falls back to 3600 s and only the "0:00" tick shows.
- With `#tl-scroll` absent, `trackPx = 1000`.
- For realistic assertions, set `clientWidth = 1000` on `#tl-scroll`.

**Unit tests.**

`renderLegend` and `renderTimeline` basics:
- `it("renderLegend: .ln.heat 'Heat', .ln.hype 'Hype', then 6 span.mk each with glyph + short label (Disagree, Hot take, Prediction, Recommend, Clip, Humour)")`
- `it("renderTimeline: 6 lanes in order .sections .subject .mode .chart .markers .axis")`
- `it("chart lane has 3 gridlines at 25/50/75%")`
- `it("endMs is at least 60 s: an empty state puts a 30 s segment at width≈50%")`
- `it("endMs = max(60000, nowMs, last utterance end, last segment end)")`: check a segment's left % after the 60 s floor is exceeded.
- `it("box.style.width is zoom*100% (100% at zoom 1)")`

Sections and segment blocks:
- `it("a section gives span.sect with left/width %, background SUBJECT_COLORS[subject], title 'Section: ai models, 0:00–1:00'")`
- `it("an unknown section subject uses #6a7d98")`
- `it("a labelled segment gives button.blk in the subject lane with the background colour, text pretty(choice), title '0:00–0:30 · ai models (80%) · news · story: S · mentions: a, b · click to jump'")`
- `it("a faded subject gets .faded; a faded mode gets .faded")`
- `it("matches(g) false gives .dim on both blocks and on pins")`
- `it("labels.unlabeled gives .unlabeled, text 'unlabeled', title '… · unlabeled · click to jump'")`
- `it("labels null (labels on) gives title '… · labelling… · click to jump' and empty text")`
- `it("labels off (session.features.labels=false) gives the plain title '0:00–0:30 · click to jump', no background, empty text")`

Mode blocks and jumping:
- `it("mode block: button[tabindex=-1], background MODE_COLORS[choice] (fallback #4e5b6c), title '… · news (low confidence)' when faded, '… · no mode yet' without a mode, just the span when labels are off")`
- `it("clicking a subject or mode block calls onJump(seg.id) and, when a seek handler is set, onSeek(seg.startMs)")`
- `it("without a seek handler, clicking a block only calls onJump")`

Heat, hype and markers:
- `it("heat/hype scores give svg[viewBox='0 0 100 100'] > polyline.heat with points 'x,y' where y=(1-v/4)*100")`
- `it("no heat scores means no polyline.heat")`
- `it("every heat/hype point also gets span.dot.heat with left/top % and title 'Heat 2.0'")`
- `it("markers: unknown ids are filtered; one marker sits at left:calc(mid% + 0px)")`
- `it("two markers get offsets -14px and +14px; three get -28, 0, +28")`
- `it("pin aria-label 'Hot take at 0:10' and title 'Hot take · 0:10: click to jump'")`

Open segment and pauses:
- `it("utterances in no closed segment give span.blk.open in the subject and mode lanes")`
- `it("the open block's text is 'In progress' only when wider than 90px (set clientWidth)")`
- `it("the open block's title is 'Segment in progress: labelled when it closes' with labels on, 'Segment in progress' with labels off")`
- `it("the open segment extends to nowMs while status is running, and ends at its last utterance otherwise")`
- `it("a pause {startMs:10000,endMs:20000} gives span.pause-band in subject, mode and chart (3 in all), title 'Paused 0:10–0:20: nothing was heard or transcribed'")`
- `it("an ongoing pause (endMs null) runs to nowMs, and its title ends '–now: …'")`

Axis and now line:
- `it("axis with trackPx 1000 and endMs 60000: 5 s ticks from 0:00 to 0:55, and the one at 60 s is skipped to leave room for the now tag")`
- `it("the first tick has class 'tick first'")`
- `it("a longer show picks a coarser step (e.g. endMs 3_600_000 at 1000px → 300 s)")`: verify the 80px rule, `TICK_STEPS.find(t => t*pxPerMs >= 80)`.
- `it("with no step reaching 80px it falls back to 3600 s")`
- `it("nowMs > 0 gives span.nowline in the subject, mode, chart and markers lanes and span.nowtag 'Now 1:00' while running, 'End 1:00' otherwise")`
- `it("nowMs = 0 gives no nowline")`

Playhead:
- `it("keeps the playhead across a re-render when setPlayhead was called before")`
- `it("setPlayhead(null) removes #playhead")`
- `it("setPlayhead(ms) creates div#playhead.playhead > span with clock(ms), left = ms/spanMs %, clamped to 0-100")`
- `it("setPlayhead adds .edge when x > 92%")`
- `it("setPlayhead without #timeline does nothing to the DOM, but a later renderTimeline shows the stored playhead")`
- `it("setPlayhead(ms, true) with zoom>1 scrolls #tl-scroll so the playhead is in view (scrollLeft = px - 0.3*clientWidth) when it was out of view; no scroll when it is in view or zoom is 1")`

Seek handler and zoom:
- `it("setSeekHandler(fn) adds .seekable to #tl-scroll; null removes it")`
- `it("bindTimeline: #zoom-out is disabled at zoom 1; #zoom-level reads 'Whole show'")`
- `it("zoom-in doubles the zoom up to maxZoom = spanMs/30000; with spanMs 120000 the first click shows a '1:00 view' and #timeline width 200%, the second click reaches 4 and disables zoom-in")`
- `it("zoom-out halves; zoom-fit returns to 1")`
- `it("each zoom calls onRedraw")`
- `it("with spanMs ≤ 30 s maxZoom is 1, so zoom-in is disabled")`
- `it("setZoom keeps the time under the anchor fixed (check scrollLeft math with clientWidth 1000)")`
- `it("renderTimeline clamps zoom down when the session got shorter than the current zoom allows")`: in practice spanMs only grows, but for a newly opened recording it can shrink.

Wheel, click and hover:
- `it("wheel + ctrlKey or metaKey: preventDefault and zoom by exp(-deltaY*0.01) anchored at clientX - rect.left")`
- `it("plain vertical wheel while zoomed: preventDefault and scrollLeft += deltaY")`
- `it("plain wheel at zoom 1, or a horizontal-dominant wheel, is not prevented")`
- `it("click on #tl-scroll with a seek handler: onSeek(max(0, (scrollLeft + clientX - rect.left)/(clientWidth*zoom)*spanMs))")`
- `it("a click on .blk or .pin (or inside one) does not seek")`
- `it("a click with no seek handler does nothing")`
- `it("pointermove shows #tl-hover at left = scrollLeft+x px with the time text; .edge-left when x<30, .edge-right when clientWidth-x<30")`
- `it("pointerleave hides #tl-hover")`
- `it("scroll re-positions the hover line")`

Chart height grip:
- `it("a saved localStorage pa.timelineChartPx='150' sets #tl --tl-chart:150px and #tl-grip aria-valuenow=150; '20' is clamped to 60; a non-number is ignored")`
- `it("localStorage.getItem throwing does not break bindTimeline")`
- `it("grip: aria-valuemin=60")`
- `it("grip dblclick sets 100px")`
- `it("ArrowUp +20 and ArrowDown -20 with preventDefault; other keys are ignored")`
- `it("max height = max(60, innerHeight - 220 - (tl.offsetHeight - current)): innerHeight 500 caps at 280")`
- `it("grip pointerdown/move/up: height = start + (startY - clientY); adds and removes .dragging on the grip and .resizing on the body; listeners are removed after up or cancel")`
- `it("without #tl-grip, bindTimeline returns after the scroll wiring (no throw)")`
- `it("setChartHeight writes localStorage and survives setItem throwing")`

**Smells.**
- timeline.ts:212 and :213: `Math.max(0, ...[...utterances].map(...))` and `Math.max(... segs.map(...))`, and likewise :284-285 for the open segment, spread arrays into arguments. Very large arrays (over roughly 100k items) would throw a RangeError. A 2-hour show has a few thousand lines, so the risk is low.
- timeline.ts:238: `gap = 2/trackPx*100` is Infinity when `#tl-scroll` exists with `clientWidth` 0, for example while the strip is hidden or `display:none`. The width then falls back to its floor, so it is harmless.
- timeline.ts:55: `setZoom` divides by `sc.clientWidth * zoom`, giving NaN when clientWidth is 0, and then `sc.scrollLeft = NaN`. Probably harmless.
- timeline.ts:219: zoom is clamped inside a render function, a hidden side effect. The `#zoom-level` text is refreshed by the `showZoom()` at :325, so it stays consistent.
- timeline.ts:323: `setPlayhead(playhead)` is re-added inside `track()`, not inside `box`. If `renderTimeline` were called with some other box, the playhead would land in `#timeline`. Only app.ts calls it, with `#timeline`.
- timeline.ts:161: `.closest(".blk, .pin")` also matches `.blk.open` (a span), so clicking the in-progress block does not seek. Probably intended.

---

## 4. web/src/player.ts: 180 lines

**Purpose.** Recording playback.
- One `<audio>` element per opened recording, loaded from `/api/sessions/:id/audio`, with `preservesPitch`.
- Speed comes from `#play-speed` (1 to 4) and is remembered as `pa.playSpeed`.
- A volume boost through a Web Audio GainNode, set from `#play-boost` and remembered as `pa.playBoost`.
- It drives the timeline playhead and the seek handler.
- The transcript follows: `.utt.playing` plus `scrollIntoView`, paused for 4 s after the user scrolls.
- Space toggles play/pause.
- Every seek, every pause/end, and every 5 s while playing, it reports the position to the listener, which keeps `?t=` in the URL.

**Exports.**
- `setPositionListener(fn)` :69
- `seek(ms)` :77
- `toggle()` :115
- `syncPlayer(st)` :123
- `bindPlayer()` :151
- `refreshFollow()` :177

Private: `isRecording` :20, `positionMs` :23, `showButton` :25, `follow(ms, scroll, force)` :38, `tick` :54, `report(ms, always)` :70, `applyBoost` :99, `SPEED_KEY` :17, plus the state at :9-16 and :66-67.

**Pure:** `isRecording(st)` :20, which is `status === "archived" && hasAudio !== false`. It is private; export it or cover it through `syncPlayer`. Everything else touches the DOM or audio.

**DOM ids.** `#player`, `#play`, `#play-time`, `#play-speed`, `#play-boost`, `#transcript` (and `.utt[data-start]` rows), `dialog[open]`, `body.playback`. It also uses `#timeline`/`#tl-scroll` through `setPlayhead` and `setSeekHandler`.

**Browser APIs.**

| API | Where | happy-dom | Plan |
| --- | --- | --- | --- |
| `new Audio(url)` | :140 | an element exists, but no media pipeline | Stub `globalThis.Audio = FakeAudio`. Tests need `readyState`, `paused`, `currentTime` and events under control. |
| `HTMLMediaElement.play()` returns a promise, `pause()` | :118-119 | | FakeAudio |
| `preservesPitch`, `playbackRate`, `preload` | :141-143 | | plain properties on FakeAudio |
| `AudioContext`, `createGain`, `createMediaElementSource`, `.resume()`, `.close()` | :104-111, :132 | absent | FakeAudioContext. Real audio behaviour is E2E-only; in Chromium, assert only that no error occurs and that the boost select persists. |
| `requestAnimationFrame` | :63 | present | Fake timers with `requestAnimationFrame` faked, then `vi.advanceTimersToNextFrame()` (Vitest ≥3), or `vi.advanceTimersByTime(16)`. |
| `scrollIntoView` | :51 | | stub |
| `localStorage` | :154, :156, :159, :163 | fine | |
| `KeyboardEvent` on document | :166 | fine | |

**Side effects on import:** none (verified).

**Unit tests** (happy-dom plus `loadIndexHtml` and FakeAudio).

`syncPlayer`:
- `it("with no session: #player hidden, no Audio created, body has no .playback, setPlayhead(null) and setSeekHandler(null) run")`
- `it("live or running session: #player hidden")`
- `it("archived with hasAudio false: #player hidden, no Audio")`
- `it("archived with hasAudio true or undefined: #player shown, body.playback, Audio src '/api/sessions/<encodeURIComponent(id)>/audio' (an id with a space is encoded), preload 'metadata', preservesPitch true, playbackRate = Number(#play-speed.value)")`
- `it("then #play-time is '0:00', #play shows the play glyph (use[href='#g-play']) with aria-label 'Play' and title 'Play the recording (space)', and #tl-scroll is .seekable")`
- `it("called again with the same recording: no new Audio")`: `FakeAudio.instances.length` stays 1.
- `it("another recording: the old audio is paused, a new one is created, the boost context is closed and forgotten, the old .playing highlight is removed, #playhead is removed")`
- `it("going from a recording back to on air: audio null, player hidden, body.playback removed, seek handler cleared")`

`toggle`:
- `it("does nothing without audio")`
- `it("paused → play(); playing → pause()")`
- `it("a play() rejection is swallowed")`: no unhandled rejection.

Volume boost (`applyBoost`, reached through `toggle`):
- `it("at #play-boost=1 no AudioContext is created")`
- `it("at 2 it creates the AudioContext once; source.connect(gain).connect(destination); gain.value = 2; resume() is called")`
- `it("on a second toggle it reuses the same gain and updates its value")`
- `it("AudioContext throwing: no boost, and toggle still plays")`

`seek`:
- `it("does nothing without audio")`
- `it("readyState ≥ 1: sets currentTime = ms/1000 (negative → 0), runs a tick at once (#play-time shows clock(ms), #playhead at ms) and calls the position listener with ms")`
- `it("readyState 0: setPlayhead(ms) at once; on loadedmetadata currentTime is set and the listener called")`
- `it("two seeks before metadata apply in order, so the last one wins")`: documents the stacking listeners.

The tick loop:
- `it("the tick after a seek force-follows: scrollIntoView({block:'center', behavior:'auto'}) on the line, even when it is already current")`
- `it("while playing, tick re-schedules with rAF; it stops when paused")`
- `it("while playing, the listener is called at most every 5 s (fake Date)")`
- `it("on pause and ended events, the listener is called at once with the position; on play it is not")`
- `it("play, pause and ended events refresh the button: pause glyph, aria-label 'Pause', title 'Pause (space)' while playing")`
- `it("seeked triggers a tick when none is scheduled")`

`follow` (through `tick` and `refreshFollow`):
- `it("rows with data-start 0, 5000, 10000 at 7000 ms: the second row gets .playing, and others lose it")`
- `it("before the first row starts: no row is highlighted")`
- `it("after the last row starts: the last row is highlighted")`
- `it("while playing, it scrolls the line into view smoothly unless the user scrolled #transcript (wheel or touchmove) in the last 4 s")`
- `it("partial (live) rows without data-start are ignored")`

`refreshFollow`:
- `it("without audio it is a no-op")`
- `it("with audio it re-highlights after the transcript is re-rendered")`: replace `#transcript` children, then call it.

`bindPlayer`:
- `it("a saved pa.playSpeed='2' restores #play-speed; a saved pa.playBoost='1.5' restores #play-boost; a throwing localStorage is tolerated")`
- `it("changing speed sets audio.playbackRate and saves pa.playSpeed; changing it with no audio only saves")`
- `it("changing the boost applies it and saves pa.playBoost")`
- `it("#play click toggles")`

The space key:
- `it("space on body toggles and preventDefaults")`
- `it("space is ignored with no audio, with any dialog[open], or when the target is inside input, textarea, select, button or [contenteditable]")`
- `it("other keys are ignored")`

**Smells.**
- **Stale listener on the old element.** player.ts:130-131 plus :144: after `audio?.pause()` the old element's "pause" event fires. Real media events are asynchronous, so it can arrive after `audio` already points to the *new* element. The handler then runs `report(positionMs(), true)` with the new audio's position, 0. app.ts:256 turns that into `setRoute({ t: 0 })`, which drops `?t=`.
  - On a deep link to a second recording, this can momentarily clear `?t=` until loadedmetadata restores it.
  - It only happens when the previous recording was playing. Hedged: this is a race and I did not reproduce it.
  - Fix: remove the listeners, or check `ev.target === audio`.
- player.ts:91: each seek before metadata adds another `loadedmetadata` listener, and each one reports its own ms. The final state is correct, but the listener sees intermediate positions.
- player.ts:102: `boost` is created only when `level !== 1`. `createMediaElementSource` can be called only once per element, and a new element gets a new context (:132), so this is correct. But the boost is re-applied only on toggle or change, so a boost chosen *before* the first play in a new recording (restored from localStorage) only takes effect at the first `toggle()`. That is fine.
- player.ts:111: `.resume?.()` returns a promise that is never caught. A rejection would be unhandled; it is unlikely.
- player.ts:167: `(e.target as Element).closest(...)` assumes the target is an Element. With the target on `document`, for example after some programmatic dispatches, `closest` is undefined and this would throw. Browsers send key events to `body` or the active element, so it is fine in practice.

---

## 5. web/src/licenses.ts: 96 lines

**Purpose.** The page script for web/licenses.html, the Licenses and Acknowledgements window.
- Its left list comes from `GET /api/licenses`: the app's own license, then every component grouped. A search field filters it, and ↑/↓ move through it.
- The right pane is the detail: title, license chip, the notice rendered as Markdown (bare URLs linkified), and foldable full texts (`details` open when 60 000 characters or fewer).
- In the Mac app two extra buttons call the desktop bridge.

**Exports:** none.

**Private.**
- `Item` :8, `FOLD_OVER = 60_000` :11
- `linkify` :14, `fullText` :21, `items(l)` :27
- `all`, `shown`, `current` :42-44
- `select(item, focus)` :46, `renderList()` :59

**Pure (private):** `linkify(md)` :14 is pure string to string. `items(l)` is pure except for its lazy `render` closures. Recommend exporting both from a side-effect-free module.

**DOM ids.** `#lic-search`, `#lic-list` (`.lic-item[data-index]`, `.lic-group`), `#lic-detail`, `#lic-desktop`, `#lic-chromium`, `#lic-finder`.

**APIs.** fetch via `api.licenses()`, `scrollIntoView` (stub it), `focus`, and the `keydown` listener on `document`.

**Side effects on import: heavy, at lines 76-96.** They cannot be avoided without a seam.
- :76 adds a `document` `keydown` listener.
- :84 uses `$("#lic-search")!`. It throws a TypeError if the DOM is not loaded.
- :85-89 are the desktop branch, with `!` on three ids.
- :91-96 hold a **top-level `await api.licenses()`**.

Test recipe:
1. `vi.resetModules()`.
2. `loadLicensesHtml()`.
3. Mock `../web/src/api.ts` with `licenses: vi.fn().mockResolvedValue(fixture)`, or `mockRejectedValue`.
4. Optionally set `globalThis.desktop`.
5. `await import("../web/src/licenses.ts")`. The top-level await resolves before the import promise does, so the list is rendered once it returns.

The `document` keydown listener accumulates across re-imports. Use a fresh environment per test, or accept the extra listeners; the old ones reference stale module state and exit early only if `current` is null. Alternatively, apply the `boot()` seam.

**Linkify probe (actual):**

| Input | Output |
| --- | --- |
| `"see https://a.b/c."` | `"see [https://a.b/c](https://a.b/c)."`, trailing punctuation kept outside |
| `"[x](https://a.b)"` | unchanged |
| a fenced block | unchanged |
| `"(https://a.b)"` | `"([https://a.b](https://a.b))"`: OK |
| `"<https://a.b>"` | `"<[https://a.b>](https://a.b>)"` **BUG**: the `>` is inside the link |
| `` "`https://a.b`" `` | `` "`[https://a.b](https://a.b)`" `` **BUG**: the link lands inside inline code and renders as literal text |
| `"[https://a.b](https://a.b)"` | `"[[https://a.b](https://a.b](https://a.b](https://a.b))"` **BUG**: garbled |
| `"https://a.b/x_(y)"` | `"[https://a.b/x_(y](https://a.b/x_(y))"`: the paren is cut |

THIRD_PARTY_NOTICES.md contains **7** `<http…>` URLs, e.g. line 745 `Copyright jQuery Foundation … <https://jquery.org/>` and line 98 bsdiff. They render today as links whose href ends in `>`. This is a real, visible bug in the Licenses window.

**Unit tests** (after the seam, or through the import recipe).

`linkify`:
- `it("wraps bare http(s) URLs as [url](url)")`
- `it("keeps trailing . , ; : outside the link")`
- `it("does not touch URLs already inside a markdown link's (…)")`
- `it("skips fenced code blocks")`
- `it("<https://x> links without the > (currently fails)")`: pin the bug as `it.fails` or fix it.
- `it("does not linkify inside inline code (currently fails)")`
- `it("[https://x](https://x) is left alone (currently fails)")`

`items`:
- `it("the first item is 'This app' in group 'Tattle' with the app license; its render shows p.lic-meta 'Tattle 0.8.0 · Cloudless Consulting Pty Ltd' (the <email> is stripped) and pre.license-text with the text, or 'No LICENSE file.' when it is empty")`
- `it("group titles 'Components built into the app' → 'Built into the app' and 'npm packages in the app' → 'npm packages'; other titles unchanged")`
- `it("backticks are stripped from component titles")`
- `it("a component's render is renderMarkdown(linkify(body)) followed by one details.lic-file per file, with summary 'Full text · <basename>' and pre.license-text")`
- `it("details is open when text.length ≤ 60000 and closed above that")`

Boot and list:
- `it("boot: renders a .lic-group header whenever the group changes, and button.lic-item[role=option][data-index] with .lic-title and .lic-lic")`
- `it("boot selects the first item: #lic-detail has header.lic-head > h1 title plus span.lic-chip license (no chip when the license is empty); aria-selected=true on that button only")`
- `it("clicking an item selects it; #lic-detail scrollTop resets to 0")`

Search:
- `it("search filters case-insensitively on title, license and text; groups re-render; when the current item is filtered out the first match is selected")`
- `it("no matches: p.empty 'Nothing matches.' and the detail keeps the previous item")`
- `it("clearing the search shows everything, and the selection is kept")`

Keyboard:
- `it("ArrowDown/ArrowUp move within shown items, clamped at both ends, focus the button, call scrollIntoView({block:'nearest'}) and preventDefault")`
- `it("arrows are ignored with no current item or an empty list")`
- `it("other keys are ignored")`

Desktop and errors:
- `it("desktop present: #lic-desktop shown; #lic-chromium click → desktop.run('open-chromium-licenses'); #lic-finder → desktop.run('show-license-files')")`
- `it("desktop absent: #lic-desktop stays hidden")`
- `it("api failure: #lic-detail shows p.error-text 'The licenses could not be loaded: <message>'")`

**Smells.**
- licenses.ts:15: the three linkify bugs above. The `<url>` case affects real content.
- licenses.ts:38: `l.texts[f]!`. When the server lists a file with no text, `fullText` gets `undefined`, and `text.length` at :22 throws inside `render()`, which is inside `select()`. That breaks the list click, or the initial render if it is the first item. The server probably always includes them; guard with `?? ""`.
- licenses.ts:71-72: with no matches the detail still shows the previous item while the list says "Nothing matches.". Minor UX.
- licenses.ts:76: a global keydown listener that is never removed, which is fine for a page script.

---

## 6. web/src/panels.ts: 1176 lines

**Purpose.** Everything in the page's shell except the timeline, chat, calls and transfer.
- Toasts and the in-page ask/confirm dialog.
- The header: the session name edited in place, the ON AIR block, controls, pops, the Start live dialog, the replay popover, the cog menu with its summaries, and the About footer.
- The stream meters and the speaker-mode chip, plus the clock.
- The transcript: filters, segment dividers, caption rows, missing lines, live partials, and the per-speaker dialog.
- Fact-check cards and the verdict tally.
- Speakers: rename, merge, and the duplicate-speaker suggestions.
- Insights: tabs, Overview stats, the System 1 panel with rollback, and the error log.
- The Labels editor, the cost chip, the Recordings library, the split divider, and the stale-engine banner.

**Exports.**
- `Filters` :9, `filters` :10
- `toast(message, kind="error")` :12
- `ask(title, opts)` :47
- `loadDevices()` :73
- `bindControls(onOpen, viewGone)` :118
- `bindSessionName(getState, onRenamed)` :253
- `renderSession(st)` :278
- `renderClock(ms)` :322
- `SESSION_WINDOWS` :333 (dlg-speakers, dlg-labels)
- `renderMenu(st)` :339
- `showInsights(section)` :357
- `bindInsights()` :368
- `renderHealth(st)` :392
- `segmentOf(st)` :426
- `segmentMatches(g)` :432
- `renderFilters(st, onChange)` :443
- `setTimeClick(fn)` :533
- `renderTranscript(st)` :535
- `jumpToSegment(id)` :613
- `renderClaims(st)` :669
- `renderSpeakers(st)` :771
- `renderS1(st)` :809 (async, but never awaits)
- `renderLabels(st, force=false)` :903
- `renderCost(st)` :947
- `renderStats(st)` :972
- `renderErrors(st)` :990
- `renderRecordings(st)` :1087 (async)
- `bindSplit()` :1128
- `checkEngine()` :1169 (async)

Private.
- Helpers and constants:
  - `run(fn, ok?)` :26, `editing(box)` :36, `MIC_KEY='pa.mic'` :67
  - `replaySpeed` :90, `onViewGone` :92, `voicesOnCall` :95, `bindAbout` :101
  - `PER_HOUR` :174, `feature` :176, `isOn` :177
  - `plural` :330, `minus` :376
- Header and Start live:
  - `renderStartSummary` :179, `openStartLive` :187, `bindStartLive` :199
  - `closePops(only?)` :215, `editInPlace(target, opts)` :227
  - `ONAIR` :271, `shownBlock` :275, `entering` :276
- Health: `renderSpeakerMode` :382.
- Transcript: `openSpeaker(st, id)` :473, `onTimeClick` :531.
- Fact-check cards: `VERDICT_LABEL` :627, `card(st, c)` :631.
- Speakers and suggestions: `suggest` :690, `findDuplicates` :695, `applyMerges` :709, `CONFIDENCE_WORD` :724, `suggestionsPanel` :727.
- Labels editor: `editorVersion` and `editorTouched` :848-849, `criteriaText` :851, `parseCriteria` :857, `questionRow` :870, `readEditor` :890.
- Recordings: `libraryQuery`/`libraryTimer` :1002-1003, `when` :1005, `recordingRow` :1011.
- Split: `SPLIT_DEFAULT = 56.5` :1117, `SPLIT_KEY = 'pa.splitPct'` :1118, `setSplit` :1120.

**Pure (DOM-free).** These are the cheapest coverage.
- `segmentOf(st)` :426: exported, pure.
- `segmentMatches(g)` :432: exported. It reads only the exported mutable `filters`. **Verified under node.**
- `plural(n, word)` :330, `minus(n)` :376, `criteriaText(q)` :851, `parseCriteria(type, text)` :857 and `when(iso, id)` :1005 (locale-dependent): private, so export them.
- Inline formulas worth extracting (see the seams in §0):
  - the Start live cost at :181-182;
  - the ON AIR block choice at :281;
  - the features chip at :314;
  - the meter model at :401-413;
  - the claim sort at :670-671 and the tally at :678-683;
  - the recording meta at :1082-1083.

**DOM ids and selectors it queries** (all present in web/index.html unless noted).

Toasts and dialogs:
- `#toasts` (popover).
- `#dlg-ask`, `#ask-input`, `#h-ask`, `#ask-message`, `#ask-ok`.
- `#dlg-start`, `#start-go`, `#start-summary`, `#feat-factcheck`, `#feat-labels`, `#mic`, `#voices`.

Header:
- `#onair`, `#onair-label`, `#top`, `#session-name`, `#features-chip`, `#tl`.
- `#start-live`, `#start-replay`, `#stop`, `#pause`, `#replay-note`, `#replay-dir`, `#replay-speed button[data-speed]`.
- `#replay-btn`/`#replay-pop`, `#cog-btn`/`#cog-menu`, `[data-open]`, `dialog [data-close]`, `dialog [data-cancel]`.
- `#license-link`, `#app-version`.
- Menu summaries: `#m-recordings`, `#m-insights`, `#m-speakers`, `#m-labels`, `#cog-menu [data-open="dlg-speakers"|"dlg-labels"]`.
- `#clock`, `#health`, `#speaker-mode`, `#speaker-mode-device`, `#cost`, `#stale`.

Insights:
- `#dlg-insights .tab[data-section][aria-controls]`, `#insights-sub`, `#stats`, `#s1`, `#errors`, `#log-count`.
- `#rollback`, which it creates.

Transcript and fact-checks:
- `#filters`, `#transcript`.
- `#dlg-speaker`, `#h-speaker`, `#speaker-sub`, `#speaker-body`.
- `#claims`, `#claims-count`, `#tally`.

Settings windows:
- `#speakers`, `#suggest-voices` (created).
- `#labels`, `#h-lb` (its `nextElementSibling` is the `.sub` span), `#stories`/`#label-prefix`/`#label-questions` (created).
- `#dlg-recordings`, `#recordings` (`input.rec-search` and `.rec-list` are created).

Layout: `#stage`, `#split`.

**Browser APIs and environment support.**

| API | Where | Support |
| --- | --- | --- |
| Popover: `showPopover`, `hidePopover`, `:popover-open` | toast :18-22 | **stub** (see §0) |
| `dialog.showModal`, `close`, `returnValue`, `close` event | ask :57-60, :162-167, :195, :210, :527, :616, :1017-1058 | happy-dom OK. For `ask`, don't click `#ask-ok`; I am unsure whether happy-dom performs the `<form method=dialog>` submit that sets returnValue from the button's `value="ok"`. Call `dlg.close("ok")` or `dlg.close("cancel")` directly. |
| `localStorage` | `pa.mic` :77, :209; `pa.splitPct` :1124, :1133 | OK |
| `window.open` | :105 | **stub** |
| `scrollIntoView` | :617 | **stub** |
| `offsetWidth` reflow trick | :620 | OK (0) |
| `setPointerCapture`, `PointerEvent`, `getBoundingClientRect`, `getComputedStyle --split` | bindSplit :1138-1163 | stub capture and the rect |
| `setTimeout`/`clearTimeout` | toast 6 s :20; search debounce 250 ms :1097 | fake timers |
| `Date.now` | renderHealth :403; partial expiry :590-591 | fake timers / `vi.setSystemTime` |
| `toLocaleString`/`toLocaleTimeString` | :996, :1007 | TZ/locale caveat |
| `document.activeElement` | `editing()` :37 | OK: `.focus()` sets it in happy-dom |
| `history`/`location` through router `setRoute` | showInsights :365 | happy-dom OK; set the environment URL (`environmentOptions: { happyDOM: { url: "http://localhost/" } }`) |

**Side effects on import:** none. Verified by importing under node without a DOM. Note that the import pulls in transfer.ts, which has none either.

### Unit tests (happy-dom + `loadIndexHtml` + `installBrowserStubs` + `fakeApi` mocked)

**toast / run / ask**
- `it("toast with no #toasts is a no-op")`
- `it("toast('x') appends div.toast.error[role=alert] 'x' and calls showPopover")`
- `it("toast('x','ok') is .toast.ok[role=status]")`
- `it("an open popover is hidden then re-shown, so it restacks above a modal")`
- `it("after 6000 ms the toast is removed, and hidePopover runs when it was the last one; with another toast left it stays open")`
- `it("run success with an ok message → ok toast; without one → no toast")`
- `it("run failure → error toast with e.message; a thrown non-Error → String(e)")`: tested indirectly, e.g. through the #stop click.
- `it("ask sets #h-ask and #ask-message ('' by default), hides #ask-input unless opts.input, sets value and placeholder, #ask-ok text (default 'OK'), class 'btn primary' or 'btn danger', and returnValue ''")`
- `it("ask with input selects the input; without, it focuses #ask-ok")`
- `it("ask resolves input.value on close('ok'), '' on close('ok') without input, and null on close() or close('cancel')")`

**loadDevices**
- `it("no #mic → no-op")`
- `it("lists 'Built-in microphone' (value builtin) then each non-builtin device as '<name> (<transport>)' with value uid; clears title")`
- `it("preselects localStorage pa.mic when it is present in the options; otherwise keeps the current value")`
- `it("localStorage throwing is tolerated")`
- `it("api.devices failure → single option value '' 'Capture helper unavailable' and title = the error message")`

**bindControls** (with `onOpen = vi.fn()` and `viewGone = vi.fn()`)

About footer:
- `it("bindAbout: api.about → #app-version 'v0.8.0' and title 'Tattle 0.8.0'; about failing leaves it empty")`
- `it("#license-link without the desktop bridge → window.open('/licenses','_blank','noopener') and the pops close")`
- `it("#license-link with globalThis.desktop set before the import → desktop.run('open-licenses')")`

ON AIR entrance:
- `it("#onair animationend with animationName 'onair-sweep' clears entering and removes .enter; other animation names are ignored")`

Pause, replay and stop:
- `it("#pause with data-paused='1' → api.resume and toast 'Resumed'; with '0' → api.pause and toast 'Paused: nothing is heard or transcribed until you resume'")`
- `it("#start-replay → api.startReplay(trimmed #replay-dir, 1, Number(#voices.value)) and the pops close")`
- `it("#replay-speed [data-speed=max] click → aria-pressed true on it and false on the other; the next replay uses 'max'")`
- `it("#stop → api.stop, toast 'Stopping: in-flight work will finish'")`

Pops and dialogs:
- `it("#replay-btn click opens #replay-pop (hidden=false), aria-expanded=true, focuses the first input or button; a second click closes it")`
- `it("#cog-btn opens #cog-menu and closes #replay-pop")`
- `it("a document click outside a pop closes it; a click inside keeps it; Escape closes all")`
- `it("[data-open=dlg-insights] click → pops close, onOpen('dlg-insights'), dialog showModal")`
- `it("dialog [data-close] → close(); [data-cancel] → close('cancel') (returnValue 'cancel'); a click on the dialog element itself (backdrop) → close; a click on its child does not close it")`

Start live dialog:
- `it("#start-live opens #dlg-start: voices reset to '0', both switches aria-checked=true, summary 'Everything on' + 'About $1.62 an hour at most.', #start-go focused, loadDevices called")`
- `it("toggle factcheck off → 'No fact-checking' / 'About $1.27 an hour.'")`
- `it("labels off only → 'No labels' / 'About $1.62 an hour at most.'")`
- `it("both off → 'Transcript only: Jev and System 2 are not called' / 'About $1.23 an hour.'")`
- `it("#start-go: saves pa.mic when a mic is chosen, closes #dlg-start, api.startLive(mic || undefined, voices, {factcheck, labels})")`
- `it("#start-go with #mic value '' → startLive(undefined, …) and nothing saved")`

**bindSessionName**
- `it("click with no session, or with the button hidden, does nothing")`
- `it("click → button hidden; input.name-input[maxlength=120][aria-label=Name] after it, value = s.name ?? '', placeholder = s.id, focused and selected")`
- `it("Enter with a changed name → api.renameSession(id, name); the current state's session.name = r.name if still the same id; onRenamed(); toast 'Session renamed to X'")`
- `it("Enter with '' (from a name) → toast 'Session name cleared'")`
- `it("Enter with the same text → no API call and the button is refocused")`
- `it("Escape → cancels, no call; the input is removed and the button shown and focused")`
- `it("blur saves; finish runs only once (Enter then blur → one call)")`
- `it("keydown and click inside the input don't propagate (stopPropagation)")`
- `it("rename resolving after the session changed → name not written to the new session")`

**renderSession** (fresh module per test for `shownBlock`)
- `it("no session: #onair hidden; #top .no-onair and not .on-air; #session-name 'No session', disabled, title ''; #start-live and #start-replay enabled; #stop disabled and hidden; #pause hidden and disabled, data-paused '0', aria-pressed 'false', text 'Pause'; #replay-note ''; #features-chip hidden and ''; #tl not .labels-off")`
- `it("live running on the first render: class exactly 'onair' (no .enter on the first render); label 'On air'; .on-air; start buttons disabled; #stop enabled and shown; #pause shown and enabled; #replay-note 'Stop the current session first.'")`
- `it("off → on (a render with no session, then running) adds .enter; it stays on re-renders until the animationend")`
- `it("paused live: 'onair paused', 'Paused'; pause data-paused '1', aria-pressed true, text 'Resume', title 'Resume listening'")`
- `it("replay mode: 'onair replay', 'Replay'; #pause hidden")`
- `it("status ending: label 'Stopping'; #pause disabled but shown for live")`
- `it("archived: no block, not .on-air, stop hidden, start enabled")`
- `it("name uses s.name || s.id; title 'Click to rename · live session <id>'")`
- `it("features chip: {factcheck:false, labels:false} → 'Transcript only'; factcheck false → 'No fact-check'; labels false → 'No labels'; features undefined → hidden. Title is set only when shown")`
- `it("#tl .labels-off only with a session whose labels are off")`

**renderClock**
- `it("0 → '00:00'; 339_000 → '05:39'; 3_939_000 → '1:05:39'; -1 → '00:00'; 999 → '00:00'")`. Note the zero-padded minutes, which differ from `dom.clock`.

**renderMenu**
- `it("#m-recordings is 'Open, rename, replay'")`
- `it("nothing to say → #m-insights 'Stats, fact-checker, log'")`
- `it("stats.roganIndex 0.234 → 'Off-topic 23%'; roganIndex missing → 'Off-topic 0%'")`
- `it("session with factcheck on → '… · 1 flag' / '2 flags' (s1Counters.flags = claims.size); factcheck off → no flag part")`
- `it("errors → em.error-text '1 error' / '3 errors', separated by ' · ' only between parts (no leading separator when it is first)")`
- `it("no session → the Speakers and Labels menu items are disabled; #m-speakers and #m-labels read 'Start or open a recording'")`
- `it("session → #m-speakers counts unmerged speakers ('1 voice', '2 voices')")`
- `it("#m-labels shows labels.version, '–' when empty, 'Off for this session' when labels are off")`

**showInsights / bindInsights**
- `it("showInsights('log') → that tab aria-selected, #errors shown, #stats and #s1 hidden, #insights-sub = its data-sub")`
- `it("with the URL at ?panel=insights, history.replaceState gives ?panel=insights&section=log")`
- `it("an unknown section → the first tab (overview); the URL has no section")`
- `it("bindInsights: clicking the Fact-checker tab shows #s1")`

**renderHealth** (`vi.setSystemTime(1_000_000)`)
- `it("archived → #health emptied (but the speaker-mode chip is still updated)")`
- `it("no session → two meters (host, remote), class 'meter', meta 'waiting…', bar 0%, no alert")`
- `it("running live, no host health yet → host .alert and 'waiting…'")`
- `it("host rms -20, msSinceLastFrame 100, receivedAt now, lastSoundAt now → meta '−20 dBFS · 100 ms' (a U+2212 minus), bar width 66.66…%, no alert")`
- `it("age 1500 → '1.5 s'")`
- `it("age > 3000 while running → .alert")`
- `it("silent > 10 s while running → .alert and meta '−55 dBFS · silent 12 s'")`
- `it("stream absent from session.streams → .absent, meta 'absent', never alert")`
- `it("paused → .paused, meta 'paused', no alert")`
- `it("echoMutedMs ≥ 500 and age ≤ 3000 while running → .muted, meta 'muted · call playing'")`
- `it("echoMutedMs 400 → not muted")`
- `it("host device (detail.host.device) → span.dev and title 'Host · <dev> · last frame 100 ms'; remote uses detail.remote.outputDevice")`
- `it("rms -80 → 0%, +5 → 100% (clamped)")`
- `it("renderSpeakerMode: running + echoGate.active → #speaker-mode shown; #speaker-mode-device = device ?? \"the Mac's speakers\"; not running or inactive → hidden; the text is left alone when unchanged")`

**segmentOf / segmentMatches** (pure; node is fine; reset `filters` in beforeEach)
- `it("segmentOf maps every utterance id to its segment; an empty state → empty map")`
- `it("no filters → true")`
- `it("markers {hot_take}: labels.markers [hot_take, x] → true; [prediction] → false; labels null → false")`
- `it("subject 'ai': ai_models or ai_tools → true; tech → false; no labels → false")`
- `it("subject 'tech' matches exactly")`
- `it("any speaker filter → false (see latent bug)")`

**renderFilters**
- `it("labels on: 5 chips (MARKERS minus humour), each button.chip[aria-pressed] with glyph and label")`
- `it("a chip click toggles filters.markers and calls onChange")`
- `it("speaker select 'All speakers' plus unmerged speakers by displayName; the current filters.speaker option is selected; change → filters.speaker and onChange")`
- `it("subject select: 'All subjects', 'AI (all)', 8 subjects prettified; the selected one reflects filters.subject; change → onChange")`
- `it("labels off: no chips and no subject select, and filters.markers and filters.subject are cleared (the speaker filter is kept)")`
- `it("the 'Clear' linkbtn appears only when some filter is set; clicking it resets all three and calls onChange")`

**renderTranscript** (use `makeState`)

Empty states:
- `it("no session and no lines → div.empty 'Start a live session or a replay.'")`
- `it("a session with no lines → 'Waiting for speech…'")`

Row order and segment dividers:
- `it("rows are sorted by startMs whatever the Map order")`
- `it("a segment divider div.segdiv#seg-<id> comes before its first line: span.t clock(start), span.subj with the background colour (fallback #6a7d98) and .faded, span.mode, span.mk per known marker (unknown skipped), span.ment 'a, b'")`
- `it("a segment without labels gives a divider with only the time")`

Speaker name tags:
- `it("consecutive lines by the same (resolved) speaker: the first gets button.who-tab.<stream> with the name, the next an empty span")`
- `it("a new segment shows the name again")`
- `it("a merged speaker resolves to the survivor's name and counts as the same run")`
- `it("speakerInferred → button.who-cont '<name> *', and the next line shows the tag again")`
- `it("clicking who-tab or who-cont opens #dlg-speaker")`: see openSpeaker.

Row classes and times:
- `it("row div.utt#utt-<id> with data-seg (or '') and data-start = round(startMs); classes .filler, .flagged (a claim on it) and .missing")`
- `it("archived → the time is button.time.seek; clicking it calls the setTimeClick fn with startMs; live → span.time")`
- `it("tags → span.tag-loud; flagged → span.flag with the flag glyph")`

Missing lines:
- `it("a retrying line → .missing with the text 'Not transcribed yet: the connection dropped. Retrying…'")`
- `it("a failed line in a recording → 'Not transcribed. Play from here to hear it.'; live → 'Not transcribed.'")`
- `it("a missing entry whose id is also in utterances is not shown twice")`

Filters:
- `it("label filter: lines with no segment, or a non-matching segment, are skipped")`
- `it("speaker filter: other speakers' lines are skipped (merged speakers resolve)")`

Live partials:
- `it("partials: rows div.utt.live after the finals, sorted by receivedAt; empty text skipped; the name tag is the stream's only speaker, else 'Host' / 'Call'")`
- `it("partials are hidden while a label filter is set; with a speaker filter, only a partial whose stream's only speaker matches")`
- `it("a final partial older than 8 s is deleted from st.partials (state mutation); a non-final old one is kept")`

Scrolling:
- `it("scrolls to the bottom when it was near the bottom (stub scrollHeight 1000, clientHeight 500, scrollTop 450), and does not when scrolled up (scrollTop 0)")`

**openSpeaker** (through a transcript click)
- `it("#h-speaker = name; #speaker-sub '2 lines · 0:05 talking · on your mic and the call'")`
- `it("with no lines (the speaker only exists): '0 lines · 0:00 talking · on no lines yet'; 1 line → '1 line'")`
- `it("no other speakers → p.note 'No other speaker to merge with.'")`
- `it("rename: empty → toast 'Type a name first.'; the same name → dialog closed with no call; a new name → api.rename(id, name), close, toast 'Renamed A to B'; Enter in the input triggers it")`
- `it("'is really…' select change → the button is enabled and reads 'Merge A into B'; clearing it disables the button and it reads 'Merge'; click → api.merge(A, B) + close + toast")`
- `it("'…is really A' → api.merge(B, A)")`
- `it("the id of an unknown speaker → no dialog")`

**jumpToSegment**
- `it("an unknown id → toast 'That segment is hidden by the current filters'")`
- `it("a known id → every dialog[open] closed; scrollIntoView({behavior:'smooth', block:'start'}) on #seg-<id>; each [data-seg=id] row gets .flash (removed and re-added)")`

**renderClaims / card**

Empty and sorting:
- `it("no claims with factcheck on → div.empty 'Checkable claims appear here as they are said.'; off → 'Fact-checking is off for this session: …'; #claims-count ''; #tally empty")`
- `it("sort: activity descending (ISO strings), then the numeric part of the id descending (c_10 before c_9)")`

Verdict blocks:
- `it("verdict contradicted → article.fc.v-contradicted; .vw 'False'; .vm 'High confidence' (the first letter capitalised)")`
- `it("downgraded → an extra .vm 'No source found'; latencyMs 2300 → .vm '2.3 s'; latencyMs 0 or absent → no latency")`
- `it("an unknown verdict 'weird_one' → .vw 'weird one'")`
- `it("each VERDICT_LABEL maps: supported 'Supported', misleading 'Misleading', unverifiable 'Unverifiable', not_a_claim 'Not a claim'")`
- `it("researching (no verdict) → 'Checking' / 'Researching'; class v-researching")`
- `it("dropped → 'Dropped' / pretty(dropReason) ('' when missing); no ol.steps")`
- `it("queued → 'Queued' / 'Waiting for research'")`

Card body:
- `it("steps ol[aria-label='Status: researching']: li0 'done', li1 'done cur', li2 ''; status verdict → all done, the last cur")`
- `it("repeats + duplicates = 3 → span.badge.repeat 'Repeat ×3'")`
- `it("disputed → .disputed class, badge 'Host disputes', no dispute button")`
- `it("blockquote “text”; p.restated; p.correction only when set")`
- `it("sources: only http(s) URLs become a[target=_blank][rel='noopener noreferrer'] with the title or the url; javascript: and file: are dropped; .sources is still rendered when all were dropped (just the label)")`
- `it("who-tab uses the utterance's stream, 'remote' when the utterance is unknown, and speakerName (the id when unknown)")`

Disputing:
- `it("dispute: click → ask('Host disputes this verdict', {input:true, ok:'Dispute'}); close('ok') with '  why ' → api.override(id, 'why'); '' → override(id, undefined); cancel → no call")`

Count and tally:
- `it("#claims-count = the number of claims")`
- `it("#tally: spans only for non-zero counts, in order false, misleading, supported, checking; each has i[style='background:var(--bad)'] etc. and text '2 false'; checking counts queued + researching")`

**renderSpeakers / suggestions**

The speaker list:
- `it("editing guard: while an input inside #speakers is focused, nothing re-renders")`
- `it("0 active → div.empty 'Speakers appear as they talk.' and no suggestions")`
- `it("1 active → no suggestions panel")`
- `it(">1 active → section.suggest first")`
- `it("each row: span.id (title = id), input[aria-label='Rename <id>'] value = displayName, Rename, select 'Merge into…' + the others, Merge, span.talk '1:05 talk' from stats.speakers (or '')")`

Renaming and merging a row:
- `it("Rename: empty → toast 'Type a name first.'; unchanged → toast '<name> already has that name.'; changed → input blurred, api.rename, toast 'Renamed A to B'; Enter triggers it")`
- `it("Merge: nothing chosen → toast 'Choose who to merge A into first.'; chosen → ask('Merge A into B?', {message:'Their utterances will be relabelled as B.'}); confirm → api.merge(A, B) + toast; cancel → nothing")`

The suggestions panel:
- `it("the #suggest-voices select defaults to 2 when there is no result, shows result.voices.remote after a result, offers options 1-4 plus 0 'Any number on the call'")`
- `it("its change → suggest.voices and a re-analysis with api.suggestMerges(n)")`
- `it("the Find duplicates button: 'Find duplicates' → while loading, disabled with 'Analysing voices…' and the note → after a result, 'Analyse again'")`
- `it("api.suggestMerges rejects → p.error-text with the message; loading ends")`
- `it("no suggestions → p.suggest-none")`
- `it("suggestion rows .sugg.c-<confidence>: names 'from → into', the confidence word, 'voice match 87%' or 'no voiceprint' (similarity null), why 'Your mic: <reason>.' / 'The call: <reason>.'")`
- `it("a row's Merge → api.merge(fromId, intoId); the row is removed from the result; toast 'Merged X into Y'")`
- `it("applyMerges with 2 successes → toast 'Merged 2 speakers'")`
- `it("a failing merge → toast 'Could not merge X into Y: <msg>' and it stays listed; no success toast when none succeeded")`
- `it("'Merge N high & medium' only when 0 < sure < all; it asks 'Merge 1 high and medium confidence suggestion?' (singular) and applies only those")`
- `it("'Merge all N' asks with message '1 of them is low confidence: …' / '2 of them are …' / 'Every one is high or medium confidence.'")`
- `it("the suggestion state resets when the session id changes")`

**renderS1**
- `it("editing guard; factcheck off → div.empty 'Fact-checking is off for this session, so System 1 does not run.'")`
- `it("kv 'System 1 <strong>s1@3</strong> · 2 memory questions' ('1 memory question')")`
- `it("5 counters in order (Flags, Good flags, False alarms, Misses, Repeats) with classes '', good, bad, bad, '' and values from s1Counters (good/false alarms exclude disputed claims)")`
- `it("stats.factcheck → dl.fc-totals with Verdicts 'False 2 · Supported 1' (zeros dropped, an unknown key shown raw) or 'None yet'; System 2 '3 researched · 1 duplicates · 0 dropped' (missing → 0); Rewrites '1 promoted · 0 rejected'")`
- `it("no stats → no dl")`
- `it("last outcome → div.outcome.<outcome> with the stamp pretty(outcome) and small 'cand → active X' (or 'active X' without a candidate)")`
- `it("gate spans 'Good kept G2/G', 'False alarms left F2/F', 'Misses caught M2/M'")`
- `it("the rationale span, and errors joined '; ' in .error-text")`
- `it("no last → p.note 'No rewrite yet: …'")`
- `it("#rollback options: versions with id s1@1 or status promoted; none → just the active id; the active one selected")`
- `it("Roll back → api.rollback(value), toast 'Rolled back to X'")`

**renderLabels / label editor** (fresh module)

Guards and first render:
- `it("a session with labels off → div.empty 'Labels are off …' and the editor version reset, so it re-renders when labels come back")`
- `it("no label set → 'The label set loads with a session.'")`
- `it("first render → #h-lb's next sibling reads 'Version v1 · changes apply from the next segment'; textarea#stories holds the stories joined by \\n; input#label-prefix; #label-questions has a div.q per question")`
- `it("a re-render with the same version → no-op (the DOM node is kept); a new version → re-rendered; force=true → re-rendered")`

Question rows:
- `it("questionRow: input.q-id = id; select.q-type with the q.type option selected; textarea.q-instructions; textarea.q-criteria (rows 2 for noul, 4 otherwise) = criteriaText(q)")`
- `it("the hint follows the type: choice → 'One option per line: key: description (include none or other…)'; score → 'One level per line, lowest first (2–10)'; noul → 'Optional: true: … and false: … lines'")`
- `it("changing the type updates the hint")`
- `it("an input event in a row marks the editor touched, so a later renderLabels(st) with a new version is skipped")`
- `it("Remove → the row is removed and the editor touched")`
- `it("Add question → a row with id new_question, type noul, instructions 'A speaker in the current segment …'; touched")`

Saving:
- `it("Save stories → api.putStories(trimmed non-empty lines); st.labels.stories and version updated; toast 'Stories saved: …'")`
- `it("Apply → api.putLabels(readEditor(set)); st.labels.set = next; version = r.version; re-render forced; toast 'Label set applied from the next segment'")`
- `it("Relabel → api.relabel(); toast 'Relabelling N segments in the background' (ok)")`
- `it("readEditor: keeps base.boundary and base.story; prefix trimmed; a noul with empty criteria omits the criteria key; choice/score criteria parsed")`

`criteriaText` and `parseCriteria` (pure once exported):
- `it("criteriaText: choice {a:'x', b:'y'} → 'a: x\\nb: y'; choice without criteria → ''; score ['lo','hi'] → 'lo\\nhi'; noul {true:'t', false:'f'} → 'true: t\\nfalse: f'; noul without criteria → ''")`
- `it("parseCriteria('score', ' a \\n\\n b ') → ['a','b']")`
- `it("parseCriteria('choice', 'a: x\\n b:y:z\\nnocolon') → {a:'x', b:'y:z', nocolon:''}")`
- `it("parseCriteria('noul', '') → undefined; 'true: t' → {true:'t', false:''}; 'junk' → {true:'', false:''}")`

**renderCost**
- `it("cap = sessionCapUsd or 10 when 0; bar width = min(100, session/cap*100)%; b.warn over 80%")`
- `it("aria-label 'Session spend $1.23 of $10.00 cap'; data-tip removed")`
- `it("live: .k 'Spend', pop-h 'Session spend · cap $10.00'")`
- `it("archived: .k 'Cost', pop-h 'This recording cost', plus the note")`
- `it("small '/ $10' for an integer cap, '/ $2.50' otherwise")`
- `it("the dl has Transcription, Jev, System 2, Chat (Chat is $0.0000 when undefined)")`
- `it("chat > 0 → the chat-cap note")`
- `it("budgetExhausted → #cost.exhausted and p.error-text 'Budget exhausted: <msg>'; cleared → class removed")`

**renderStats**
- `it("no stats → div.empty 'Stats arrive every minute …'")`
- `it("roganIndex 0.42 → .big .n '42%'")`
- `it("table rows: speakerName, clock(talkMs), disagreements, hype '2.3 / 4' or '–' when null")`
- `it("three lists: h3 'predictions', 'recommendations', 'clips'; li > a with text || segmentId; a click → preventDefault + jumpToSegment; an empty list → 'None yet'")`

**renderErrors**
- `it("0 errors → 'No errors.'; #log-count '' and not .bad")`
- `it("n errors → #log-count 'n' and .bad; one div.err per error, each with span.c component, span.t locale time, and the message")`

**renderRecordings / recordingRow** (mock transfer.ts; fake timers)

Building the list and search:
- `it("no #recordings → no-op")`
- `it("the first render builds div.rec-tools (input.rec-search[type=search] + an Import button → openImport), .rec-list and p.note; later renders reuse the same input")`
- `it("rows from api.sessions(''); none → 'No recordings yet.'; with a query → 'No recording matches.'; api error → div.error-text")`
- `it("typing in search → debounced 250 ms (typing twice → one call) → api.sessions(trimmed query)")`

Row content:
- `it("row: div.rec[role=button][tabindex=0]; .current when it is the session on screen; .locked when another session is running")`
- `it("row title texts: viewing → 'You are viewing this recording'; running → 'Stop the current session first'; else 'Open this recording: …'")`
- `it("badges: 'Viewing' (current + archived) or 'Current' (current + running); 'Incomplete' when !ended && !current; 'Imported' with the title 'Imported from f.tattle, exported with v0.7.0'; 'No audio' when hasAudio false")`
- `it("the label is r.name or when(startedAt, id); startedAt null → the id")`
- `it("meta joins with ' · ': when (only if named), clock(duration), mode, 'N lines', speakers, 'N claims' (only when > 0), usd(cost), 'v<appVersion>'")`
- `it("matches → div.match with span.t clock(startMs), 'speaker: ', snippet")`

Opening a row:
- `it("a row click while viewing it → #dlg-recordings closed with no API call")`
- `it("a row click while something runs → toast 'Stop the current session before opening a recording.'")`
- `it("a row click otherwise → api.openSession(id) then the dialog closes")`
- `it("Enter or Space keydown on the row itself opens it; on a child button it does not")`

Title and buttons:
- `it("a title click → editInPlace (input.input.rec-title-input with a placeholder); Enter → api.renameSession + refresh + toast 'Renamed to X' / 'Name cleared'; it does not open the row")`
- `it("Export: disabled when it is current and running; click → openExport(id); no row open")`
- `it("Replay: disabled while running or with hasAudio false (each has its own title); click → ask 'Replay “label”?' with a message containing usd(costUsd || 0.02); confirm → api.replaySession(id, 1, voices) + close")`

Deleting:
- `it("Delete: disabled when current and running; aria-label 'Delete <label>'; cancel → nothing")`
- `it("confirm → api.deleteSession, then refresh and toast 'Deleted <label>'")`
- `it("deleting the one you are viewing: with a next row → api.openSession(next.id) (next = the row below, else above); with none → viewGone()")`

**bindSplit**
- `it("no #stage or #split → no-op")`
- `it("saved pa.splitPct '40' → #stage --split '40.00%', #split aria-valuenow '40'; '90' → 75; '10' → 25; 'x' or '0' → ignored")`
- `it("aria-valuemin 25, aria-valuemax 75")`
- `it("dblclick → 56.50% and localStorage '56.5'")`
- `it("ArrowLeft/Right ±2 from the current value (from the inline --split, falling back to 56.5); preventDefault")`
- `it("pointer drag: rect {left:0, width:1000}, clientX 300 → 30.00%; .dragging and body.resizing-x on, then off on pointerup or pointercancel")`
- `it("localStorage throwing is tolerated")`

**checkEngine**
- `it("stale true → #stale shown; false → hidden")`
- `it("ApiError(404) → shown; another error → unchanged")`

### Code smells / latent bugs (panels.ts)
1. **Label and speaker filters combined empty the transcript** (likely bug). panels.ts:439 `if (filters.speaker) return false;` makes `segmentMatches` false whenever a speaker filter is set.
   - renderTranscript :551 skips a line when `labelFilter && !segmentMatches(seg)`. So choosing a marker or subject filter **plus** a speaker filter hides every line, and the transcript shows "Waiting for speech…".
   - The timeline (app.ts:67 passes `segmentMatches`) also dims every segment when only a speaker filter is set. That contradicts the comment "segments dim only on label filters".
   - Verified: `segmentMatches` returns false with only `filters.speaker` set. Probable intent: ignore the speaker filter in `segmentMatches` (`return true`).
2. **Stale state in the recordings search.** panels.ts:1090-1098: the search input's `input` listener is bound once, on the first `renderRecordings(st)`, and its `refresh` closure captures *that* `st`.
   - app.ts replaces `st` with a new object on every reload (app.ts:89).
   - Searching later therefore renders rows against the old state: wrong "Current"/"Viewing"/"locked" badges, wrong disabled Export/Delete, and a delete-while-viewing branch using the old `viewing`.
   - Fix: keep a module-level `lastState`.
3. panels.ts:18-19: `toast` relies on the Popover API. In an engine without it, `showPopover` is undefined and throws. Since `toast` is called from `run`'s catch, the error becomes an unhandled rejection. Chromium and Electron support it, so this matters only for tests.
4. panels.ts:122 and :289-290: `entering` is reset only by `animationend` for `onair-sweep`. With `prefers-reduced-motion: reduce`, styles.css:960 sets `animation: none`, so no animationend fires and `.enter` stays on `#onair` for the page's life. It is harmless visually, since animations are off, but it is state that never clears.
5. panels.ts:591: `renderTranscript` mutates `st.partials` (deletes old final partials) during render. That is a side effect in a render function, and tests must account for it.
6. panels.ts:406: a present stream with no health yet shows red at once when a live session starts, before the first `health` event, which takes about a second. Possibly intended; hedged.
7. panels.ts:890-898: `readEditor` silently collapses duplicate question ids (the last one wins) and accepts an empty id `""`. There is no validation before `api.putLabels`; the server may reject it.
8. panels.ts:809: `renderS1` is `async` with no `await`. Callers `void` it. Harmless, but it makes tests `await` needlessly.
9. panels.ts:1005-1008 and :996: locale-dependent output, which makes E2E and unit expectations environment-specific.
10. panels.ts:1133-1134: `Number(localStorage.getItem(...))` is 0 for a missing key, which is falsy and skipped. That is intended. `#split` has no initial `aria-valuenow` until the first change (a small accessibility gap).
11. panels.ts:153-155: the document click handler calls `closePops(popSel)` for each pop on every click anywhere on the page, which is cheap. The pop button's own click uses `stopPropagation`, so the order is OK.
12. panels.ts:664 and :757/:765: `ask()` is used with `await` inside an onclick. If the ask dialog is already open, for example after a double click, `showModal()` on an open modal throws an InvalidStateError in Chromium. That rejects the async handler and the error is unhandled. Hedged: this is an edge case.
13. panels.ts:1056: `usd(r.costUsd || 0.02)` shows $0.02 for a free recording. That is intentional as a minimum estimate.

---

## 7. HTML/CSS reliance (web/index.html, web/licenses.html, styles.css)

- Every id queried by panels, timeline and player exists in index.html (checked one by one). `#rollback`, `#stories`, `#label-prefix`, `#label-questions`, `#suggest-voices` and `#playhead` are created at runtime.
- **Classes the tests should assert**, grepped in styles.css:
  - transcript rows: `.utt.playing` (572), `.utt.flash` (300), `.utt.flagged` (296), `.utt.missing` (166), `.utt.filler` (295);
  - timeline: `.blk.dim` (536), `.pin.dim` (552), `.playhead.edge` (568), `.tl-scroll.seekable` (569), `.tl-hover.edge-left/right` (586-587), `.tl.labels-off .legend{display:none}` and `.tl-off{display:inline}` (695-696);
  - header and layout: `.top.no-onair` (108), `.top.on-air #start-live{display:none}` (146), `.onair.enter` (111), `.cost.exhausted` (188), `.split.dragging`/`body.resizing-x` (238-241), `.tl-grip.dragging`/`body.resizing` (498-501);
  - recordings: `.rec.locked`/`.rec.current` (724, 734);
  - toasts: `.toasts[popover]:not(:popover-open){display:none}` (803).
- `--split: 56.5%` is defined on `.stage` (styles.css:230) and `--tl-chart: 100px` on `.tl` (491). In unit tests without the stylesheet, `getComputedStyle` returns "" and the code falls back to the same defaults.
- **Glyphs:** `<symbol id="g-*">` at index.html:16-32 (disagreement, humour, hot_take, prediction, recommendation, clip_worthy, flag, cog, replay, pause, play, chat, export, import, speaker, info, trash). E2E can assert `use[href="#g-pause"]` inside `#play`.
- `body.in-app .browser-only` hides `#replay-btn`, the API keys item and the menu footer in the Mac app (main.ts:7). E2E in a plain browser sees them.
- **CSP** (src/server/main.ts:554): `script-src 'self'; style-src 'self' 'unsafe-inline'`. Inline `style=` attributes are allowed, which the timeline relies on heavily. Playwright must not inject inline scripts via `addScriptTag({content})` unless it bypasses CSP (`bypassCSP: true` in the context).

---

## 8. E2E scenarios (Playwright), for this area

**Harness suggestion** (this is the harness scanner's call; noted here for context):
- Build with `npm run build:web`.
- Start `createApiServer(fakeEngine, { webRoot: "<repo>/web" })` from src/server/main.ts:675, as tests/server.test.ts:14-56 does with its `FakeEngine`.
  - Omit `setup`. `/api/setup` should then be unhandled; `setupStatus()` returns null on error (keys.ts:50-51), so main.ts loads the app. That depends on how an unknown `/api/*` path answers, which I believe is 404; verify.
  - Point the engine's `bus` at scripted events.
  - `sessionDir(id)` returns a temp folder with `fixtures/host.wav` and `remote.wav` copied in, for the real mixed audio at `/api/sessions/:id/audio`.
- Never point the server at the repository's real `sessions/` folder, which holds the user's recordings.
- Alternative: `page.route("**/api/**")` to mock JSON and serve SSE via `route.fulfill({ body: "event: …\ndata: …\n\n", contentType: "text/event-stream" })`. That is simpler, but it cannot stream events over time.
- Use `reducedMotion: "reduce"` for stable screenshots, knowing it leaves `.enter` stuck (smell 4).
- Set `locale: "en-US"` and `timezoneId: "UTC"` on the context.

**Scenarios** (`selector → expected`):

1. **Empty home.**
   - `#session-name` has text "No session" and is disabled.
   - `#onair` is hidden and `#top` has class `no-onair`.
   - `#transcript .empty` reads "Start a live session or a replay.".
   - `#claims .empty` reads "Checkable claims appear here as they are said.".
   - `#stop` is hidden. The cog menu (`#cog-btn` click) shows the Speakers and Labels items disabled, with `#m-speakers` reading "Start or open a recording".

2. **Live session through SSE** (the fake engine emits session.started with status running, speaker.created, utterance, segment.closed, segment.labels, claim.flagged, claim.researching, claim.verdict).
   - `#onair` is visible with class `onair enter`, and `#onair-label` reads "On air".
   - `#stop` is visible and enabled, and `#start-live` is hidden (`.top.on-air`).
   - `#transcript .segdiv` appears, and `.utt` rows carry `.who-tab` text.
   - The card moves Queued, then Checking, then the verdict: `#claims article.fc .vw` reads "Queued", "Checking", then "False". Its `ol.steps li.cur` advances.
   - `#tally` reads "1 false" and `#claims-count` reads "1".

3. **Fact-check card details and dispute.**
   - The sources show only http(s) links (the fixture includes a `javascript:` source, which must be absent).
   - `.badge.repeat` reads "Repeat ×2" after `claim.repeat` × 2.
   - Click `.fc-foot .linkbtn` ("Host disputes"). `#dlg-ask` opens with `#h-ask` "Host disputes this verdict". Fill `#ask-input`, click `#ask-ok`, and expect `POST /api/claims/c_1/override` with `{ note }`.
   - After `claim.disputed`, the card has `.disputed` and `.badge.dispute`.

4. **Verdict tally mix.** Seed contradicted ×2, misleading, supported, queued and researching. Expect `#tally span` texts `["2 false", "1 misleading", "1 supported", "2 checking"]`, in that order. After switching to the "Fast · slow thinking" tab, `#tally` is hidden (app.ts:141).

5. **Timeline markers and jump.**
   - A segment's labels have markers [hot_take, prediction]. Expect two `#timeline .lane.markers button.pin`, with `aria-label` "Hot take at 0:10" and "Prediction at 0:10".
   - Clicking one scrolls `#seg-<id>` into view, and the `.utt[data-seg=<id>]` rows get `.flash`.
   - `#legend` shows six `.mk` entries.
   - Heat and hype: `#timeline svg polyline.heat` exists.

6. **Timeline zoom.**
   - With a 10-minute session, `#zoom-level` reads "Whole show" and `#zoom-out` is disabled.
   - Clicking `#zoom-in` changes the text to "5:00 view" and makes the `#timeline` style width 200%.
   - Ctrl+wheel over `#tl-scroll` zooms; Fit returns to "Whole show".
   - Hovering `#tl-scroll` shows `#tl-hover` with a time.
   - Dragging `#tl-grip` up changes `#tl`'s `--tl-chart`. After a reload, the height is kept (`localStorage pa.timelineChartPx`).

7. **Filters.**
   - Click the `#filters button.chip` "Hot take". Only the lines in hot_take segments remain, and the non-matching timeline blocks get `.dim`.
   - Choose a speaker through the combobox "Speaker filter". **Expect the transcript to keep that speaker's lines within matching segments.** This currently FAILS (smell 1); mark it `test.fail` or fix the code first.
   - "Clear" restores everything.

8. **Speakers dialog.**
   - Click a transcript `.who-tab`. `#dlg-speaker` opens, with `#h-speaker` holding the name and `#speaker-sub` reading "N lines · m:ss talking · on …".
   - Renaming via the input + "Rename" posts `/api/speakers/<id>/rename`, then the `speaker.updated` event re-renders the names.
   - Merge via the "… is really…" combobox and button.
   - Cog → Speakers (`[data-open=dlg-speakers]`): the "Find duplicates" button calls `GET /api/speakers/suggestions`; the list `.sugg` renders; "Merge all N" goes through the ask dialog.

9. **Labels window.**
   - Cog → Labels. The `#label-questions .q` rows are rendered.
   - "Add question" adds a row. "Apply" sends `PUT /api/labels` with the parsed criteria; assert the request body.
   - "Save stories" sends `PUT /api/stories`.
   - For a session with `features.labels=false`: "Labels are off for this session…", `#m-labels` reads "Off for this session", and `#tl` has `.labels-off` (the legend is hidden and `.tl-off` is visible).

10. **Insights window.**
    - Cog → Insights. The URL gains `?panel=insights`.
    - Click the "Log" tab. The URL becomes `?panel=insights&section=log`, `#errors` is visible, and `#log-count` shows the count with `.bad`.
    - The Fact-checker tab `#s1` shows counters and rollback. "Roll back" posts `/api/s1/rollback`.
    - Overview: `#stats .big .n` shows the percentage. Clicking a prediction link closes the dialog and flashes the segment.
    - Deep link `/?panel=system-1` opens Insights on the Fact-checker tab.

11. **Recordings library.**
    - Cog → Recordings. The `#recordings .rec` rows appear with `.meta` text.
    - Typing in `input.rec-search` debounces a `GET /api/sessions?q=`.
    - Clicking a row name (`.rec-title`) edits it in place; Enter sends a PATCH.
    - Clicking a row sends `POST /api/sessions/<id>/open`. The dialog closes, the URL becomes `/recordings/<id>`, and `.rec` shows the "Viewing" badge when reopened.
    - Delete through `.rec-delete` asks with the danger button (`#ask-ok.btn.danger`), sends DELETE, and opens the next recording.
    - Replay is disabled for `hasAudio:false`.

12. **Playback** (a recording with real audio).
    - Open `/recordings/<id>`. `#player` is visible, `body.playback` is set, and the transcript times are `button.time.seek`.
    - Click `#play`: the `#play` icon becomes `use[href="#g-pause"]` and `#play-time` advances.
    - `#timeline #playhead` exists and its `left` increases.
    - An `.utt.playing` row exists.
    - Pressing Space toggles, but not while the focus is in `input.rec-search`, or with a dialog open.

13. **Playback at 4×.**
    - Choose "4×" through `getByRole('combobox', { name: /^Playback speed/ })`.
    - Assert `page.evaluate` sees the audio playing at `playbackRate === 4`. The element is not in the DOM; players are created with `new Audio`. So assert by the time advance instead: `#play-time` moves about 4 s per wall second.
    - Or expose it through `window.__audio` in a test build. That is not present today.
    - Reload: `#play-speed` restored to 4 (`localStorage pa.playSpeed`).
    - The boost at "Vol 200%" is kept (`pa.playBoost`) and makes no console error.

14. **The `?t=` deep link.**
    - `/recordings/<id>?t=0:07` shows the playhead at 7 s before play (`#play-time` reads "0:07") and the line starting at or before 7 s highlighted `.utt.playing` and scrolled into view.
    - Seeking by clicking `#tl-scroll` empty space updates the URL `?t=` (replaceState).
    - Clicking a transcript `.time.seek` sets `?t=` to that line's time.
    - While playing, the URL updates about every 5 s.
    - Pausing writes the exact time.

15. **Seek from the timeline.** Clicking a subject `.blk` both scrolls the transcript and moves the playhead to the segment start. Clicking `.pin` does the same. Clicking empty track seeks to that x.

16. **Header and session controls.**
    - `#start-live` opens `#dlg-start`. The switches `#feat-factcheck` and `#feat-labels` toggle `aria-checked`, and `#start-summary` changes text.
    - `#start-go` sends `POST /api/session/start` with `{ mode: "live", features, voices }`.
    - `#pause` sends `POST /api/session/pause`. After `session.paused` the label reads "Paused", the button reads "Resume", and the timeline shows `.pause-band`.
    - `#stop` sends POST stop.
    - `#session-name` click → an input; Enter sends a PATCH to `/api/sessions/<id>`.
    - The features chip reads "Transcript only" for a session with both features off.

17. **Health meters.**
    - Emit health events. `#health .meter` count is 2, and `.meta` matches `/dBFS/`.
    - Stop emitting for more than 3 s: `.meter.alert` appears.
    - With `echo.gate` `{ active: true, device: "MacBook Pro Speakers" }`, `#speaker-mode` is visible, `#speaker-mode-device` has the device text, and a host health with `echoMutedMs: 800` gives `.meter.muted` "muted · call playing".

18. **Cost chip.** Emit `cost` events. `#cost .v` shows "$0.45". Hovering reveals `.pop` with a breakdown. `budget.exhausted` gives `#cost.exhausted` and the error text.

19. **Split divider.** Dragging `#split` changes the `#stage` style `--split`, clamped to 25-75. Double-click resets it to 56.50%. It persists after a reload.

20. **Toasts.** A failing command (the fake engine throws a 409) shows `#toasts .toast.error` with the message, and it disappears after about 6 s.

21. **Stale banner.** The fake `/api/engine` returns `{ stale: true }`, and `#stale` is visible.

22. **Licenses page.**
    - `/licenses`: `#lic-list .lic-item` count is the number of components + 1, and the first is selected.
    - Typing "mit" in `#lic-search` filters the list. ArrowDown moves `aria-selected`.
    - Components with long texts have a closed `details.lic-file`.
    - Assert that no `a[href$=">"]` exists in `#lic-detail`. This currently fails for jQuery and bsdiff (the linkify bug).
    - The cog menu footer: `#app-version` reads "v0.8.0", and `#license-link` opens a popup to `/licenses` (`page.waitForEvent("popup")`).

23. **Missing lines and partials.**
    - Emit `utterance.failed` with status retrying. The row `.utt.missing` reads "Not transcribed yet: the connection dropped. Retrying…". A later `utterance` with the same id replaces it.
    - Emit `utterance.partial`. `.utt.live` appears with `.livedot`, and it is removed when the final utterance with the matching `utteranceId` arrives.

---

## 9. Summary of latent bugs found (priority order)

1. **panels.ts:439.** A speaker filter makes `segmentMatches` false. Combined with a marker or subject filter, the transcript empties; alone, it dims every timeline segment. Verified.
2. **licenses.ts:15.** `linkify` puts the `>` inside the link for `<https://…>`, which affects 7 real notices including jQuery and bsdiff. It also linkifies inside inline code and garbles `[https://x](https://x)`. Verified with a Node probe.
3. **panels.ts:1090-1098.** The recordings search refresh captures a stale `State` object after app reloads, giving wrong current/locked/viewing rows and delete behaviour.
4. **player.ts:130/144.** The old audio element's asynchronous `pause` event can report the new element's position 0 and clear `?t=`. Hedged race.
5. **licenses.ts:38/22.** A missing `texts[f]` throws in `fullText` and breaks selection.
6. **panels.ts:18-22.** `toast` depends on the Popover API. Tests must stub it, or a thrown error inside `run`'s catch becomes unhandled.
7. **panels.ts:122/289.** `.enter` never clears under reduced motion.
8. Minor:
   - markdown `2*3*4` is italicised, and mixed list markers merge (markdown.ts:15, :97);
   - `usd` of a negative number (dom.ts:60);
   - timeline `Math.max(...spread)` on very large arrays (timeline.ts:212);
   - `readEditor` accepts duplicate or empty question ids (panels.ts:897).
