# SPEC — Fix the right column's tabs (stale "Jev is off" panes, and a page that never starts)

## §0 How to use this spec (read first)

**What this is:** the fix for a bug shipped in 0.8.0. The page's right-column tab code also picks up the Insights dialog's tabs. So tab clicks throw before they ask for a redraw, and a URL with `?tab=` stops the page from starting. The spec also covers the regression test, the gotcha, and releasing 0.8.1.

**Who you are:** a fresh session with no memory of the investigation. The root cause is proven and reproduced (§2). Do not investigate it again.

**DO**
- Read this file end to end before editing anything.
- Run `/init-context right column tabs in the web page` first: it loads `docs/mission.md`, `docs/gotchas.md`, and the relevant docs. Before your first edit to any file, run `python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects <path>` and read what it names.
- Treat `file:line` as anchors, not gospel: grep the symbol to confirm.
- Do §4.1 → §4.2 → §4.3 → §4.4 in order. Each ends with its own "Done when".
- Run `npm run typecheck && npm test` after each of §4.1–§4.3.
- Reproduce the bug with §8 **before** editing, and check the fix with the same script afterwards.

**DO NOT**
- Do not re-explore the engine, the recordings, or the state reducer. They were checked and are correct (§2).
- Do not refactor `bindTabs` or `bindInsights` beyond §4.1, and do not rename any CSS class or id in `web/index.html`.
- Do not commit, push, or release without the user's explicit go. §4.4 (the release) needs its **own** go, separate from the go for the fix.
- Do not edit anything under `specs/`, including this file. Report gaps to the user instead.
- Do not touch the user's recordings in `~/Library/Application Support/Tattle/sessions/`. They are real shows. §8 uses the project's `sessions/` folder instead.

**Suggested first 30 minutes**
1. `git status` must be clean. If it is not, stop and ask the user.
2. Read `bindTabs` in `web/src/app.ts:131-152`, `TABS` in `web/src/router.ts:21`, and `web/index.html:110-123` (right-column tabs) and `:187-191` (Insights tabs).
3. Run §8's reproduction and see the `TypeError` and the stale panes for yourself.

Glossary (the only project terms this spec relies on):

| Term | Meaning |
| --- | --- |
| Right column | The page's column beside the transcript, with three tabs: Fact-check (`pane-fc`), Fast · slow thinking (`pane-think`), Jev log (`pane-jev`). |
| Transcript-only session | A session started with fact-checking and labels both off (`features: { factcheck: false, labels: false }` in its `session.json`). Its Jev log and thinking panes say "Jev is off for this session…". |
| Insights | A dialog (`#dlg-insights`) added in 0.8.0 with its own tabs: Overview, Fact-checker, Log. |

## §1 Goal

1. Clicking a right-column tab always shows **and redraws** that pane for the recording on screen.
2. The page starts normally whatever `?tab=` is in the URL and whatever tab `localStorage` remembers.
3. A test fails if a right-column tab ever again points at a pane that does not exist, or if the tab lookup stops being limited to tabs that have a pane.
4. The trap is written down in `docs/gotchas.md`.
5. Tattle 0.8.1 ships the fix (only after the user's go).

## §2 Context (brief)

**What the user saw.** They opened the recording `madkook-podcast` (`20260925-202620`, recorded 25 September 2026, 1,634 Jev calls, 132 claims, 40 verdicts). The **Jev log** tab showed the count **1634**. But both the Jev log and **Fast · slow thinking** said *"Jev is off for this session: fact-checking and labels were turned off when it started, so nothing is asked."* That text belongs to a transcript-only recording. The library has 15 of them, and one was open just before.

**Ruled out (do not recheck):**
- **The recording's files.** They are complete.
- **The feature flags.** `session.json` and `session.started` have no `features` field, which means both were on. The engine's snapshot (`snapshot` in `src/store/library.ts:317-331`) returns `{ factcheck: true, labels: true }`. The page's reducer (`fromSnapshot` / `applyEvent` in `web/src/state.ts`, `featuresOf` at `:130`) ends with both on after all 20,993 events.
- **Version drift.** `git diff v0.8.0 HEAD -- src web` is empty.

**Root cause (proven in headless Chrome):**
- `bindTabs` (`web/src/app.ts:133`) collects tabs with `document.querySelectorAll(".tabs .tab")`.
- Commit `d838f4f` (28 September 2026, in 0.8.0) added the Insights dialog, whose tab bar is `<div class="dlg-tabs tabs">` holding `.tab` buttons with no `data-pane` (`web/index.html:187-190`). So the lookup matches 6 tabs, not 3.
- `show()` loops over all 6 and runs `` $(`#${t.dataset.pane}`)!.hidden = … ``. At the first Insights tab that is `$("#undefined")` → `null` → `TypeError: Cannot set properties of null (setting 'hidden')`.
- The three real panes were already shown or hidden by then. Everything after the loop never runs: `#tally`, saving `pa.rightTab`, `dirty.add("calls")`, `schedule()`.

**Why that produces the symptom:** `renderThinking` (`web/src/calls.ts:306-325`) writes the "Jev is off" text into **both** panes when a transcript-only session is on screen. For a normal session it fills only the **visible** pane, but it always updates the count. Here is the sequence:
1. A transcript-only recording is on screen.
2. Madkook opens while Fact-check is showing: count → 1634, hidden panes keep the old text.
3. The Jev log tab is clicked: the pane is shown, the click throws, and no redraw is ever asked for.

**Second symptom:** `show()` calls `setRoute({ tab })` **before** it throws, so the URL gains `?tab=jev-log`. On a page load with a tab in the URL (or a remembered one), `bindTabs()` runs `show(saved)` at the top level of `app.ts` (`:266`). The throw ends the module, so `reload()` and `connect()` (`:272-274`) never run. Reproduced: the page shows "No session", with no transcript, although the engine has a recording open. The Insights tabs also get `bindTabs`'s click listener, so clicking Overview, Fact-checker, or Log in Insights throws the same way.

## §3 Acceptance criteria

- [ ] `grep -n 'querySelectorAll<HTMLButtonElement>(".tabs .tab")' web/src/app.ts` returns nothing.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, including the new `tests/tabs.test.ts`.
- [ ] Temporarily remove `id="pane-jev"` from `web/index.html` (do not commit this). `npx vitest run tests/tabs.test.ts` then **fails**. Restore the id.
- [ ] §8 check A: a transcript-only recording, then `20260925-202620`, then click Jev log. The script prints Jev log text that is **not** "Jev is off…" (it starts with a call row's time), the Fast · slow thinking text contains "System 1", and it reports **no** `TypeError`.
- [ ] §8 check B: loading `/?tab=jev-log` with a recording open shows that recording's name and a non-empty transcript, and reports no exception.
- [ ] §8 check C: clicking the Insights tabs reports no exception, the right column's selected tab is unchanged, and the URL has no `tab=`.
- [ ] `docs/gotchas.md` § Web page has the new entry (§4.3).
- [ ] After §4.4: `CHANGELOG.md` has `## [0.8.1]` with a Fixed entry, the tag `v0.8.1` exists, and the GitHub Release is published (per the release skill's own checks).

## §4 The work

### §4.1 Limit `bindTabs` to right-column tabs, and never throw on a missing pane

**Symptom:** §2.

**Where it lives:**
- `bindTabs` in `web/src/app.ts:131-152`. The lookup is at `:133` and the throwing line at `:139` (`` $(`#${t.dataset.pane}`)!.hidden = t !== tab; ``).
- The Insights tabs that it wrongly matches: `web/index.html:187-190` (`<div class="dlg-tabs tabs" …>`). They are bound correctly elsewhere, by `bindInsights` using `#dlg-insights .tab` (`web/src/panels.ts:358`, `:369`).

**How to fix (minimum diff, `web/src/app.ts` only):**
1. Change the lookup at `:133` to take only tabs that own a pane: `document.querySelectorAll<HTMLButtonElement>(".tabs .tab[data-pane]")`.
2. In `show()`, replace the non-null assertion so a missing pane is skipped rather than thrown on:
   ```ts
   const pane = $(`#${t.dataset.pane}`);
   if (pane) pane.hidden = t !== tab;
   ```
3. Leave everything else in `bindTabs` as it is: `setRoute` order, `#tally`, `localStorage`, `dirty.add("calls")`, the `saved` logic.

**Do not** move the tab list into `router.ts`, add a new module, or touch `bindInsights`.

**Done when:** the first §3 criterion passes, and §8 checks A and B pass.

**Stop and ask if:** after the change, §8 check A still shows "Jev is off…" or still reports an exception. The cause would then be something the investigation did not find.

### §4.2 Regression test: `tests/tabs.test.ts` (new file, allowed)

**Why an HTML-level test:** the tests run in Node with no DOM library (`vitest run`; there is no jsdom or happy-dom in `node_modules`), and the user chose **not** to add one. The test checks the invariants the bug broke, by reading files as text.

**Pattern to follow:** `tests/router.test.ts` imports `web/src/router.ts` directly. Read files with `readFileSync` relative to the repository root, the way the other tests do.

**Assertions:**
1. **Every pane tab has a pane.** Find each `<button …>` in `web/index.html` whose `class` contains `tab` and that has a `data-pane="X"`. Assert the file contains `id="X"`. There must be at least 3 such tabs, so a broken regex cannot pass on zero matches.
2. **Every routed tab has a tab and a pane.** For each value of `TABS` (imported from `web/src/router.ts`), assert a button with `data-pane="<value>"` exists and `id="<value>"` exists.
3. **The lookup is limited.** Read `web/src/app.ts` and assert the `bindTabs` lookup string contains `[data-pane]`: match `querySelectorAll<HTMLButtonElement>("<sel>")` inside `function bindTabs` and check `<sel>` ends with `[data-pane]`. Add a comment saying why: the Insights dialog also uses `.tabs .tab`, and matching it broke every tab click in 0.8.0.

Keep it to about 30–50 lines, in the style of the other tests (plain `describe` / `test` / `expect`, a sentence as each test name).

**Done when:** `npx vitest run tests/tabs.test.ts` passes. It must also fail both ways: with `id="pane-jev"` removed from `web/index.html`, and separately with the §4.1 lookup reverted to `".tabs .tab"`. Restore both.

**Stop and ask if:** assertion 3 cannot be written without a fragile regex (for example, `bindTabs` was already restructured). Ask whether to export the selector as a constant instead.

### §4.3 Gotcha entry

Add one bullet to `docs/gotchas.md` under `## Web page`, after the existing bullet and in its style (a bold lead sentence, then what happened and the fix):

> **A document-wide tab lookup catches every tab bar.** `bindTabs` looked up `.tabs .tab`, and the Insights dialog added in 0.8.0 uses `class="dlg-tabs tabs"` too. Its tabs have no pane, so switching a tab threw after showing the pane but before redrawing it: an opened recording kept the Jev log and Fast · slow thinking text of the recording before it ("Jev is off for this session…"), and a page loaded with `?tab=` in the URL never started. The lookup takes only `.tab[data-pane]`, a missing pane is skipped, and `tests/tabs.test.ts` checks both.

Run `python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects docs/gotchas.md` first, per §0. If the project's doc tooling (`update-doc`) is how docs change here, use it. Otherwise make the one-bullet edit by hand. No other doc changes: the behaviour described in `docs/architecture.md` has not changed.

**Done when:** `grep -n "document-wide tab lookup" docs/gotchas.md` returns the line.

### §4.4 Commit, then release 0.8.1 (each step needs the user's go)

1. Show the user the diff and the §3 results. **Wait for go.** Then commit as one conventional commit, e.g. `fix(web): limit the right column's tabs to those with a pane, so tab switches redraw and a ?tab= URL no longer stops the page`, ending with the attribution lines the session gives you.
2. **Ask separately** for go to release. Then run `/release-tattle patch Fix the right column's tabs: an opened recording showed the previous recording's "Jev is off" text in Jev log and Fast · slow thinking, and a page opened on a tab never loaded`. The skill owns the changelog, the version bump, the tag, signing, notarization, publishing, and the website's download link. Follow it exactly and do not do its steps by hand.
3. Remind the user that an installed 0.8.0 picks up 0.8.1 through Tattle → Check for Updates… (not while a session is on air).

**Done when:** the last §3 criterion passes.

**Stop and ask if:** the release skill reports missing credentials (notary profile, GitHub token) or any failed check. Never work around the skill's checks.

## §5 Non-goals

- No new dependency (no jsdom, happy-dom, Playwright, or Puppeteer). `package.json` changes only through the release skill's version bump.
- No change to `renderThinking`, `feed`, or the "draw only visible panes" rule in `web/src/calls.ts`. Once tab clicks redraw again, that rule is correct.
- No change to `bindInsights` in `web/src/panels.ts`, or to the Insights markup or its `dlg-tabs tabs` classes.
- No change to the engine (`src/**`), the recordings, the export format, or `featuresOf`. They were verified correct.
- No clearing of the panes when a session changes. Once clicks redraw, it is unnecessary; do not add it.
- No changes to `docs/architecture.md`, `docs/recordings.md`, or other docs beyond §4.3.
- No edits to the user's recordings or to `~/Library/Application Support/Tattle/**`.

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
| --- | --- | --- |
| 1 | The browser check ran against a dev engine (`src/server/main.ts`) and `web/dist` built on 28 September. The packaged 0.8.0 app was not driven directly: a packaged build exits when started with `--remote-debugging-port` (see `docs/gotchas.md` § Mac app). `git diff v0.8.0 HEAD -- src web` is empty, so the code is the same. | Verify with §8 against the dev engine, then open the rebuilt app with `npm run app` and repeat check A by hand. Do not try to drive the packaged build. |
| 2 | Since 0.8.0 a remembered tab (`pa.rightTab` in `localStorage`) should also stop the page at startup, but the user's packaged app starts. Probably nothing was remembered: saving happens after the throw, so 0.8.0 never saves it. | Nothing to do: §4.1 fixes both paths. Do not clear the user's storage. |
| 3 | `tabName(undefined)` (from `router.ts`) is currently called when an Insights tab is clicked. What it writes to the URL was not checked. | After §4.1 it is no longer called for Insights tabs. Confirm with §8 check C. Do not change `tabName`. |

If you find anything else during implementation, stop and tell the user before working around it.

## §7 Anti-hallucination guardrails

1. Files you may edit: `web/src/app.ts` (§4.1) and `docs/gotchas.md` (§4.3). The only file you may create is `tests/tabs.test.ts` (§4.2). The release skill edits its own files (§4.4).
2. The §8 script goes in your scratchpad directory, never in the repository.
3. `package.json` and `package-lock.json` are read-only, except for the release skill's bump.
4. No "while I'm here" changes: do not remove other `!` assertions, rename helpers, or restyle `bindTabs`.
5. Do not start a live session or a replay while testing. Opening a recording is free and writes nothing; a replay calls paid APIs.
6. Do not run `npm run dist:mac`, `electron-builder`, `git push`, `git tag`, or `gh release` yourself. Only the release skill does, after the user's go.
7. Do not delete or move anything in `sessions/` or in the app's recordings folder.
8. Do not edit `specs/**`.
9. Kill the dev engine and headless Chrome you start in §8 when done (see the cleanup line).

## §8 Verification commands

**Recordings used** are in the project's `sessions/` folder, which the dev engine serves:
- `20260925-202620`: `madkook-podcast`, both features on, 1,634 Jev calls.
- `20260927-153948`: a transcript-only recording.

If either folder is missing, stop and ask the user which recordings to use.

**1. Start a dev engine and headless Chrome** (ports 4799 and 9333; check they are free with `lsof -iTCP:4799 -iTCP:9333 -sTCP:LISTEN`):

```bash
S=<your scratchpad dir>
npm run build:web
node --env-file-if-exists=.env --import tsx src/server/main.ts --port 4799 > $S/server.log 2>&1 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 \
  --user-data-dir=$S/chrome --no-first-run about:blank > $S/chrome.log 2>&1 &
sleep 3; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4799/api/state   # expect 200
```

`.env not found. Continuing without it.` in the log is fine. Opening recordings needs no keys.

**2. Save this as `$S/tabs-check.mjs`** (Node 24 has `fetch` and `WebSocket` built in):

```js
// usage: node tabs-check.mjs A | B | C
const B = "http://127.0.0.1:4799", mode = process.argv[2];
const url = mode === "B" ? `${B}/?tab=jev-log` : `${B}/`;
const t = await (await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map(); const errs = [];
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errs.push((d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).split("\n")[0]); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const look = async (label) => console.log(label, JSON.stringify(await ev(`({ session: document.querySelector('#session-name')?.textContent,
  lines: document.querySelectorAll('#transcript > *').length, count: document.querySelector('#jev-count')?.textContent,
  jev: document.querySelector('#jev-log')?.textContent.slice(0, 100), think: document.querySelector('#think')?.textContent.slice(0, 100) })`)), "exceptions:", errs.splice(0));
const open = (sid) => ev(`fetch('/api/sessions/${sid}/open', { method: 'POST' }).then((r) => r.status)`);
const tab = (p) => ev(`document.querySelector('.tabs .tab[data-pane=${p}]').click(), true`);
await send("Runtime.enable");
if (mode === "C") {
  await send("Page.reload"); await wait(3000);
  await ev(`[...document.querySelectorAll('#dlg-insights .tab')].forEach((b) => b.click()), true`); await wait(500);
  console.log("C:", JSON.stringify(await ev(`({ selected: document.querySelector('.tabs .tab[data-pane][aria-selected=true]')?.dataset.pane, search: location.search })`)), "exceptions:", errs.splice(0));
} else if (mode === "B") { await open("20260925-202620"); await send("Page.reload"); await wait(5000); await look("B, loaded with ?tab=jev-log:"); }
else {
  await send("Page.reload"); await wait(4000);
  await open("20260927-153948"); await wait(4000);
  await tab("pane-jev"); await wait(800); await tab("pane-think"); await wait(800); await tab("pane-fc");
  await look("A, transcript-only:");
  await open("20260925-202620"); await wait(6000);
  await tab("pane-jev"); await wait(1500); await look("A, madkook on Jev log:");
  await tab("pane-think"); await wait(1500); await look("A, madkook on thinking:");
}
ws.close();
```

**3. Run it:** `cd $S && node tabs-check.mjs A && node tabs-check.mjs B && node tabs-check.mjs C`

**Before the fix (expected, already observed):**
- A, the madkook lines: `count "1634"`, `jev` and `think` = "Jev is off for this session: …", and exceptions `TypeError: Cannot set properties of null (setting 'hidden')`.
- B: `session "No session"`, `lines 0`, and the same `TypeError`.

**After the fix:**
- A, madkook on Jev log: `jev` is a call row, not "Jev is off…". Madkook on thinking: `think` contains "System 1". `exceptions: []` throughout.
- B: `session "madkook-podcast"`, `lines` > 0, `exceptions: []`.
- C: `search` has no `tab=`, `selected` is the tab that was selected before (normally `pane-fc`), `exceptions: []`.

**4. In the app, by hand:** `npm run app` (it uses the same project `sessions/`). Open the transcript-only recording, then `madkook-podcast`, then click Jev log and Fast · slow thinking. Both show madkook's calls. Quit it afterwards.

**Cleanup:**

```bash
pkill -f "remote-debugging-port=9333"; pkill -f "src/server/main.ts --port 4799"
```

## §9 Glossary

In §0 (three terms), to keep it next to the reading order.

## §10 References

- Investigation: this spec (the session that found the bug is not needed). The fault came in with `d838f4f` ("merge Stats, System 1, and Log into Insights", 28 September 2026).
- Docs: `docs/architecture.md` § Features: transcript-only sessions (what the "off" panes should say, and when). `docs/recordings.md` § Open vs Replay (opening is free and read-only). `docs/gotchas.md` § Web page and § Mac app (a packaged build cannot be driven through DevTools). `docs/desktop.md` (updates).
- Release: `.claude/skills/release-tattle/SKILL.md`, `CHANGELOG.md` (Keep a Changelog, `## [Unreleased]` at the top).
- Related specs: none.

**Code anchors**

```
bindTabs / show            web/src/app.ts:131-152   (lookup :133, throw :139)
top-level startup          web/src/app.ts:266-274   (bindTabs() → reload() → connect())
applyRoute → showPane      web/src/app.ts:190-191
renderThinking             web/src/calls.ts:306-325 (the "Jev is off" text at :310)
featuresOf                 web/src/state.ts:130
TABS                       web/src/router.ts:21
right-column tabs + panes  web/index.html:110-123
Insights tabs              web/index.html:187-190   (class="dlg-tabs tabs")
bindInsights tab lookup    web/src/panels.ts:358, :369
SessionLibrary.snapshot    src/store/library.ts:317-331
```
