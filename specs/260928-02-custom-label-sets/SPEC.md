# SPEC — Custom timeline label sets

## §0 How to use this spec (read first)

**What this is:** the plan to replace the app's single hard-coded set of timeline labels with **label sets** the user can create, clone, edit, share, preview, and draft with AI, and pick at Start live.

**Who you are:** a fresh session with no memory of the conversation that produced this. Everything decided is here. Where something was not decided, §6 says what to do.

**DO**
- Read this file end to end before editing anything.
- Run `/init-context custom timeline label sets` first: it loads `docs/mission.md`, `docs/gotchas.md`, and the docs below. Before your first edit to any file, run `python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects <path>` and read what it names.
- Treat `file:line` as anchors, not gospel: grep the symbol to confirm.
- Build in tier order (Tier 1 → 4). Each tier must leave the app working, tested, and documented before the next starts.
- Verify each task with §8. Run `npm run typecheck && npm test` after every task.
- Keep the look: "On Air" broadcast style, drawn SVG glyphs (no emoji), bespoke controls (see `docs/architecture.md` § Web front end).

**DO NOT**
- Do not re-explore or re-audit the codebase beyond what a task needs; the anchors are in §4 and §10.
- Do not commit, push, release, or run `npm run dist:mac` / the release skill without the user's explicit go.
- Do not make paid API calls (Jev, OpenRouter) outside the automated tests' fakes without asking the user first. Tiers 3 and 4 need one live check each; ask before it.
- Do not edit anything under `specs/`, including this file. Report gaps to the user instead.

**Suggested first 30 minutes**
1. `git status` must be clean. If it is not, stop and ask the user (earlier work may be uncommitted).
2. Read `docs/jev.md` § The timeline questions, `config/labels.default.json`, `deriveLabels` and `sectionsOf` in `src/pipeline/timeline.ts`, `computeStats` in `src/pipeline/stats.ts`, `renderTimeline` in `web/src/timeline.ts`, `renderFilters` and `renderStats` in `web/src/panels.ts`.
3. Open an existing recording in the dev app (§8) and screenshot its timeline, filters, and Insights → Overview. Tier 1 must reproduce these exactly.

## §1 Goal

1. **Label sets as data.** The timeline's labels (today: `subject`, `mode`, `heat`, `hype`, five yes/no markers, `clip_worthy`) come from a **label set**: up to **2 categories**, **2 scores**, **8 markers**. Every screen that shows labels (timeline, transcript, filters, legend, Insights, Jev log) is driven by the set, not by hard-coded names.
2. **A library.** The cog's **Labels** item opens a library of label sets: a read-only built-in set, and the user's own sets (new, clone, edit, rename, delete, export, import). Stored as plain files on the Mac.
3. **Picked at Start live**, with **tonight's stories**. Each recording keeps a frozen copy of the set it used.
4. **Try on a recording:** preview a draft set on the first 10 minutes of a recording before using it live.
5. **Create with AI:** draft a set by chatting with GPT-6 Luna (fixed model), reviewed and saved by the user.

## §2 Context (brief)

Today one label set lives in `config/labels.default.json` (built into the Mac app, read-only). The cog's Labels window can edit it only during a session, only for that session, and the edits are lost afterwards. Worse, the screens are written for today's exact ids: only six markers have icons (`MARKERS` in `web/src/timeline.ts:17`), the off-topic index looks for `personal_life` and `other_topics` (`OFF_TOPIC` in `src/pipeline/stats.ts:31`), the AI shading looks for `ai_*` (`AI_SUBJECTS`, `src/pipeline/timeline.ts:41`). A new question is asked, paid for, stored, and never shown.

What each label drives today (reproduce all of it from the set):

| Label | Shown in |
| --- | --- |
| `subject` (choice) | SUBJECT lane (fixed colours `SUBJECT_COLORS`), section brackets, subject tag on transcript dividers, "All subjects" filter (with an "AI" group), off-topic index |
| `mode` (choice) | MODE lane (`MODE_COLORS`), mode tag on transcript dividers |
| `heat`, `hype` (score 0–4) | The two chart lines; hype also averaged per speaker in Insights |
| `disagreement`, `hot_take`, `prediction`, `recommendation`, `humour` (yes/no) | Marker pins, icons on transcript dividers, filter chips (not humour), legend; disagreement counted per speaker; predictions and recommendations listed in Insights |
| `clip_worthy` (score, marker at ≥ 3) | Marker, filter chip, Clips list in Insights |
| `story` (generated from tonight's stories) | Segment tooltip only; also fed to transcription as "Topics tonight" |

Decisions the user made (do not revisit): the word is **labels** (a saved collection is a **label set**); three types (category, score, marker); limits 2 / 2 / 8; icons from a built-in drawn library, chosen by the user or by the AI; the marker filter chips scroll sideways while the dropdowns stay pinned; the boundary question stays **locked** (shown read-only); sets stored in Application Support, shared between development and the Mac app; all four tiers in this spec; the mission's non-goal is reworded to allow AI drafting (§4.T4.1).

## §3 Acceptance criteria

Tier 1
- [ ] `npm run typecheck && npm test` pass; new tests from §4 exist and pass.
- [ ] Recording `20260925-202620` (in `sessions/`) opened in the dev app shows the same timeline lanes, colours, markers, filters, transcript tags, and Insights numbers as the screenshots taken before Tier 1 (§0 step 3), except: humour now has a filter chip; clip markers come from the converted legacy set.
- [ ] `grep -rn "personal_life\|other_topics\|ai_models\|\"subject\"\|\"mode\"\|\"heat\"\|\"hype\"\|clip_worthy\|hot_take" src web/src --include=*.ts` finds these ids only in the legacy converter and its test data (§4.T1.3), never in rendering, stats, or pipeline code.
- [ ] A replay of `fixtures/conversation` (Start live is not needed: `npm run replay -- --host fixtures/conversation/host.wav --remote fixtures/conversation/remote.wav --speed max`) writes `session.json` with `labelSet.format === "tattle-labels"` and a `stories` array. Ask the user before running it: it calls Jev and OpenAI (about $0.05).
- [ ] With the window narrowed to 1024 px, the marker chips under the transcript scroll sideways on one line and every dropdown stays visible.

Tier 2
- [ ] Cog → **Labels** opens the library at any time (no session needed) and lists the built-in set.
- [ ] Clone, edit, save, rename, delete, export, import all work; the built-in set cannot be edited or deleted (the API answers 409).
- [ ] `curl`-style tests in `tests/server.test.ts` cover every `/api/label-sets` route, including a rejected invalid set (400 with the reason).
- [ ] Start live shows a **Labels** picker (every set, plus **Off**) and a **Tonight's stories** box; the session uses the picked set.
- [ ] Exported file `<name>.conversation-labels` re-imports as an identical set (new id, same content).

Tier 3
- [ ] **Try on a recording** shows the draft's timeline for the first 10 minutes of a chosen recording next to that recording's own, and the cost; nothing is written into the recording's folder (`git status sessions/` unchanged, and file mtimes unchanged).

Tier 4
- [ ] **Create with AI** produces a set that passes the same validation as a hand-made one; `openai/gpt-6-luna` is the only model used (fixed in config, no picker); `docs/mission.md` carries the reworded non-goal.

## §4 The work

### Target data model (all tiers use it)

A new file per set, `format` and `version` first so files are self-describing:

```jsonc
{
  "format": "tattle-labels", "version": 1,
  "id": "ai-podcast",               // built-in: fixed; user sets: generated, [a-z0-9-]+
  "name": "AI podcast", "description": "…",
  "builtIn": true,                  // only the shipped set; stripped on import and clone
  "prefix": "Judge only segment; previous_segment is context only.",
  "fadedBelowConfidence": 0.5,
  "companies": ["OpenAI", "…"],     // mention spotting (today timeline.companies in config/app.json)
  "categories": [                   // 0–2. The first draws the section brackets.
    { "id": "subject", "name": "Subject", "instructions": "What is the current segment mainly about?",
      "options": [ { "id": "ai_models", "name": "AI models", "description": "New AI models, labs…", "color": "#…", "group": "AI" } ],
      "index": { "name": "Off-topic", "description": "time spent on personal life and other topics", "options": ["personal_life", "other_topics"] } }
  ],
  "scores": [                       // 0–2, always 5 levels (0–4), so both share the chart's axis
    { "id": "heat", "name": "Heat", "instructions": "…", "levels": ["Calm", "…", "Very heated"] }
  ],
  "markers": [                      // 0–8
    { "id": "disagreement", "name": "Disagreement", "short": "Disagree", "icon": "bolt",
      "instructions": "…", "criteria": { "true": "…", "false": "…" }, "threshold": 0.7,
      "perSpeaker": true, "list": false }
  ]
}
```

Rules (enforce in one zod schema, `LabelSetSchema` replaced in `src/config.ts:96`):
- At least one label overall. Ids snake_case (`QuestionId`, `src/jev/types.ts:35`), unique across the whole set; `story` and `boundary` reserved. Option ids snake_case, unique within their category; 2–255 options per category (Jev's limit, `ChoiceQuestion` in `src/jev/types.ts:10`).
- `color`: `#rrggbb`. `icon`: one of the icon library ids (§4.T1.5). `threshold`: 0–1. `levels`: exactly 5 non-empty strings.
- `index` optional, at most one per set, on a category; its `options` must exist in that category.
- `group` optional: options sharing a group are offered together in the category's filter dropdown (today's "AI").
- Score colours are fixed by slot (first = `--heat`, second = `--hype`); no per-score colour.
- Not in the set: the **boundary** question and the **story** question's wording. They move to `config/timeline.json` (§4.T1.1) and stay locked.

Jev questions built from a set (replaces `timelineQuestions`, `src/pipeline/timeline.ts:23`): each category → `choice` with `criteria` = option id → description; each score → `score` with `criteria` = the 5 levels; each marker → `noul` with its `criteria`; plus `story` when stories exist, as today. The prefix is prepended to every instruction, as today.

Derived labels (replaces `deriveLabels`, `src/pipeline/timeline.ts:66`): a marker is on when its noul answer ≥ its own `threshold`; choices below `fadedBelowConfidence` are faded; mentions from the set's `companies`; `lane` becomes the option's `group` or its id. The labels rows written to `labels.jsonl` keep their current shape (keyed by question id).

---

### Tier 1 — Label sets as data, screens driven by the set (app looks the same)

#### §4.T1.1 The built-in set and the locked questions

**Where:** `config/labels.default.json`; `LabelSetSchema` `src/config.ts:96-103`; `loadConfig` `src/config.ts:163`; `timeline` block of `AppConfigSchema` `src/config.ts:61-64`; `config/app.json` `timeline`.

**How:**
1. Create `config/timeline.json`: `{ "boundary": <the boundary question, verbatim>, "story": <the story block, verbatim> }` with its own strict schema. `Timeline` reads the boundary from here (`session.ts:195`).
2. Create `config/labels/ai-podcast.json`: today's set converted to the §4 model **with identical Jev wording** (instructions, criteria, option descriptions, prefix), so Jev's answers do not change. Carry today's colours from `SUBJECT_COLORS` / `MODE_COLORS` (`web/src/timeline.ts:9,13`), `group: "AI"` on the three `ai_*` options, `index` Off-topic on `subject` with `personal_life` + `other_topics`, `companies` from `config/app.json`, marker thresholds 0.7. `disagreement` gets `perSpeaker: true`; `prediction` and `recommendation` get `list: true`.
3. **`clip_worthy` becomes a yes/no marker** (user decision): instructions "The segment contains a moment worth clipping for social media: a strong quote, a funny exchange, a surprising claim, or a memorable story.", criteria true/false written in the same concrete style as the other markers, `list: true`. This is the only intended change in labelling behaviour.
4. Delete `config/labels.default.json` after the converter (§4.T1.3) embeds what legacy recordings need. Remove `noulMarkerThreshold`, `clipWorthyMin`, `fadedBelowConfidence`, `companies`, `stories` from `timeline` in `AppConfigSchema` and `config/app.json`; if the `timeline` block ends up empty, remove it.
5. `electron-builder.yml` already ships `config/` whole: check that `config/labels/` and `config/timeline.json` land in `Contents/Resources/config` (no change expected).

**Done when:** `tests/config.test.ts` loads both files; a test asserts the Jev question set built from `ai-podcast.json` (without `clip_worthy`) equals the one built from the old file for the other ten questions (keep the old file's JSON inline in the test as fixture data).

**Stop and ask if:** any wording would have to change to fit the model.

#### §4.T1.2 Where sets live, and the store

**Where:** `appSupportDir` `src/paths.ts:55-58`; add `labelSets` to `AppPaths` (pattern: `notices`/`licenses` added in `src/paths.ts`).

**How:** new `src/labels/store.ts` (`LabelSetStore`): built-in sets from `config/labels/*.json` (read-only), user sets from `join(appSupportDir(), "labels")` (created on first write; one `<id>.json` each, written atomically: temp file then rename). Same folder in development and in the Mac app (user decision). Methods: `list()`, `get(id)`, `create(set)`, `update(id, set)`, `remove(id)`, `clone(id)`. Built-in ids are never written or deleted (throw a typed error the router maps to 409). Validation on every read and write; an invalid user file is listed as broken (name + error), never crashes the app.

**Done when:** `tests/labels.test.ts` covers list/get/create/update/remove/clone, the built-in being read-only, and a corrupt file in a temp folder (use `setAppPaths`, as `tests/desktop.test.ts` does).

#### §4.T1.3 Sessions use a set; recordings keep a frozen copy; legacy recordings still open

**Where:** `Session` constructor `src/pipeline/session.ts:174-197` (`new Timeline(cfg.app, cfg.labels, …)`); `session.json` write `session.ts:270-275`; state `session.ts:593`; `Timeline` class `src/pipeline/timeline.ts:123-175` (`replaceLabels`, `setStories`, `relabel`); `SessionLibrary.snapshot` `src/store/library.ts:317-330`; `StartRequest` and `parseFeatures` `src/server/main.ts:57-70`, start at `main.ts:396-427`.

**How:**
1. `StartRequest` gains `labelSet?: string | null` (id; `null` = labels off) and `stories?: string[]`. `features.labels: false` keeps meaning off (older pages). Default when absent: `ai-podcast`.
2. The engine resolves the id through `LabelSetStore` and passes the **full set** to the session. `session.json` stores `labelSet` (the full set, new format) and `stories`. The session never re-reads the store: editing a set later changes nothing in a running or past session.
3. Remove live editing: delete `Timeline.replaceLabels`, `PUT /api/labels`, and the Labels editor (`renderLabels`, `questionRow`, `readEditor` in `web/src/panels.ts:870-930` and `#dlg-labels` in `web/index.html:180`). **Keep** `PUT /api/stories` and `POST /api/labels/relabel` in the engine (see §6 #3).
4. **Legacy converter** `src/labels/legacy.ts`: `fromLegacy(labelSet, appTimeline)` turns an old `session.json` (old-format `labelSet` + `config.timeline`) into a new-format set: `subject`/`mode` → categories with today's colours and the AI group, `heat`/`hype` → scores, nouls → markers with today's icons and thresholds, `clip_worthy` → marker (legacy label rows already list `clip_worthy` in `markers`, so display needs only its definition). `SessionLibrary.snapshot` returns a new-format set for every recording.
5. Stats: see §4.T1.4; legacy stored stats events are converted the same way.

**Done when:** opening `sessions/20260925-202620` gives a new-format set in `GET /api/state` → `labels.set`; a test converts a legacy `session.json` fixture and snapshots the result.

#### §4.T1.4 Generic stats

**Where:** `computeStats` `src/pipeline/stats.ts:38-95`; `SessionStats` `stats.ts:9-20`; the `stats` event schema `src/store/events.ts:38` (`obj({ roganIndex: num })`).

**How:** new shape (keep the fact-check block as it is):
```ts
interface SessionStats {
  version: 2;
  index: { name: string; description: string; share: number } | null;           // from the set's index
  categories: { id: string; name: string; split: { option: string; ms: number; share: number }[] }[];
  speakers: { speakerId: string; displayName: string; talkMs: number;
              markers: Record<string, number>;   // only markers with perSpeaker
              scores: Record<string, number | null> }[];  // duration-weighted average, as hype today
  lists: { markerId: string; items: { segmentId: string; text: string }[] }[];  // markers with list: true
  factcheck: …unchanged…; cost: …unchanged…;
}
```
Keep writing `roganIndex` (= `index.share`, or 0) so the event schema and older pages still read it. Add `fromLegacyStats` next to the converter for stats events stored by old recordings.

**Done when:** `tests/stats.test.ts` is rewritten against the built-in set and a second, invented set (e.g. a sales-call set with one category, no scores, three markers), and the legacy conversion is tested.

#### §4.T1.5 Icon library

**Where:** glyph symbols in `web/index.html` (`<symbol id="g-disagreement">`, `g-humour`, `g-hot_take`, `g-prediction`, `g-recommendation`, `g-clip_worthy`); `glyph` `web/src/dom.ts:22`; callers `glyph(m)` in `web/src/panels.ts` (transcript dividers, ~line 562, and filter chips) and `web/src/timeline.ts:30`.

**How:** a library of **30 drawn icons** as `<symbol id="i-<name>">` in `web/index.html`, 16×16, `currentColor`, the same weight as today's. Rename today's six to `i-bolt` (disagreement), `i-smile` (humour), `i-flame` (hot take), `i-trend` (prediction), `i-star` (recommendation), `i-scissors` (clip). Add 24 more covering common conversation moments, for example: question, lightbulb (idea), check, cross, warning, money, clock, calendar, target, flag, quote, heart, thumbs-up, thumbs-down, shield, lock, link, chart, people, handshake, book, megaphone, pin, sparkle. Export the id list as `ICONS` from a new `web/src/icons.ts`; the schema's `icon` enum and the AI prompt (Tier 4) use it. Tests import `ICONS` from the web source, as `tests/router.test.ts` imports `web/src/router.ts`.

**Done when:** a test checks every `ICONS` id has a `<symbol id="i-…">` in `web/index.html`, and the built-in set's icons are all in `ICONS`.

#### §4.T1.6 Screens driven by the set

**Where:** `web/src/timeline.ts`: `SUBJECT_COLORS`, `MODE_COLORS`, `MARKERS` (9-24), `renderLegend` (26), `renderTimeline` (207-322: section brackets 232, subject lane 247-258, heat/hype 239-268, markers 270-275, lane labels). `web/src/panels.ts`: `segmentMatches` (432), `renderFilters` (443), transcript dividers (`segdiv`, ~556-562), `renderStats` (972), `renderMenu` Insights summary (~344). `web/src/calls.ts:42,54,129` (Jev log: segment summary hard-codes subject, mode, heat, hype). `web/src/state.ts:93` (`labels` state) and `Filters` (`web/src/panels.ts:7`).

**How:**
1. The page reads the set from `st.labels.set` (new format) everywhere. Delete `SUBJECT_COLORS`, `MODE_COLORS`, `MARKERS`, `AI_SUBJECTS`.
2. Timeline: one lane per category (named by the category; hidden when the set has none); section brackets from the first category, merged by option; one chart line per score (slot colours), chart hidden with no scores; marker pins with each marker's icon; lane labels from the set's names; the tooltip names each category's option, the story, and mentions.
3. Transcript dividers: a tag per category (first coloured, second grey, as today), then marker icons.
4. Filters: `Filters.subject: string` becomes `categories: Record<categoryId, string>` (option id or `group:<name>`). Under the transcript: marker chips for **every** marker (humour included) in a row that scrolls sideways on one line; pinned on the right, always visible: **All speakers**, then one dropdown per category ("All subjects", "All modes", named by the category). The timeline's legend row scrolls sideways the same way.
5. Insights → Overview (`renderStats`): the index as the big number when the set has one; per category a split bar (option colours, share %); a per-speaker table with talk time, each `perSpeaker` marker's count, each score's average; one list per `list: true` marker (clicking jumps, as today). Cog summary: `<index name> <share>%` when there is an index.
6. Jev log (`web/src/calls.ts`): summarise a segment call by the set's categories and scores, not hard-coded ids; the "Topic labels" description names no specific label.

**Done when:** §3 Tier 1 criteria pass, and a second invented set (loaded in a test session through `labelSet`) renders its own lanes, chips, and Insights without errors (check in the dev app, §8).

**Stop and ask if:** reproducing today's screens exactly (§3) conflicts with the generic design anywhere.

#### §4.T1.7 Docs for Tier 1

Update `docs/jev.md` (§ The timeline questions: the set model, where sets live, boundary/story in `config/timeline.json`), `docs/architecture.md` (web front end, filters, Insights, `session.json`), `docs/recordings.md` (`session.json` fields: `labelSet` new format, `stories`; legacy conversion), and rebuild `doc-manifest.json` (`python3 .claude/skills/init-doc/scripts/build-doc-manifest.py --root .`). Add the new files to the relevant docs' `source` lists.

---

### Tier 2 — The library, the editor, Start live, export and import

#### §4.T2.1 API

**Where:** router in `createApiServer` `src/server/main.ts` (~line 670-790); follow the style of the `/api/sessions` routes and `ApiError`.

| Method | Route | Does |
| --- | --- | --- |
| GET | `/api/label-sets` | `{ sets: [{ id, name, description, builtIn, counts: {categories, scores, markers}, broken?: string }] }` |
| GET | `/api/label-sets/:id` | The full set |
| POST | `/api/label-sets` | Create from a body set (id generated, `builtIn` dropped) → 201 + set |
| PUT | `/api/label-sets/:id` | Replace a user set; 409 for built-in |
| DELETE | `/api/label-sets/:id` | Delete a user set; 409 for built-in |
| POST | `/api/label-sets/:id/clone` | Copy named "<name> copy" → 201 + set |
| GET | `/api/label-sets/:id/export` | Download `<name>.conversation-labels` (JSON, `application/octet-stream`, `Content-Disposition: attachment`) |
| POST | `/api/label-sets/import` | Body: the file's JSON. Validated; new id; name clash → "<name> (2)" → 201 + set |
| POST | `/api/label-sets/estimate` | Body: a draft set → `{ ok, errors, tokens, perHourUsd, overLimit }` (validation plus the §4.T2.3 estimate) |

Invalid sets → 400 with the zod message. These routes are not in `OPEN_ROUTES` (keys required, like the rest).

**Done when:** `tests/server.test.ts` covers each route (FakeEngine or a real `LabelSetStore` on a temp folder).

#### §4.T2.2 The Labels library window

**Where:** cog item `data-open="dlg-labels"` in `web/index.html:84`; `SESSION_WINDOWS` in `web/src/panels.ts` (remove `dlg-labels` from it: the library needs no session); `PANELS` in `web/src/router.ts` (`labels` stays `dlg-labels`); `renderMenu` summary for `#m-labels`.

**How:** `#dlg-labels` becomes a library, laid out like Recordings: a list of sets (name, description, counts "2 categories · 2 scores · 6 markers", **Built-in** badge), each with Edit (Clone for built-in), Export, Delete (with the in-page `ask()` confirmation). Header buttons: **New**, **Import**, and (Tier 4) **Create with AI**. New opens the editor with an empty set; Clone opens the copy. Cog summary: "<n> sets".

#### §4.T2.3 The editor

**How:** a large dialog (like Chat's size) editing one set, every field of the §4 model:
- Name, description; prefix; faded-below confidence; companies (one per line).
- **Categories** (max 2): name, instructions, options (name → id derived snake_case, description, colour picker from a 12-colour palette plus hex, group), optional index (name, description, which options).
- **Scores** (max 2): name, instructions, the 5 level descriptions.
- **Markers** (max 8): name, short name, icon (grid picker from `ICONS`), instructions, true/false criteria, threshold (0.50–0.95 slider), "count per speaker", "list in Insights".
- The **boundary question**, read-only, with: "Decides where one segment ends and the next begins. It is calibrated (`npm run calibrate:boundary`), so it is the same for every label set."
- Add buttons disabled at each limit, with the limit shown ("2 of 2").
- Live validation (the same zod schema compiled for the page is not available: validate on the server with `POST /api/label-sets/estimate` debounced 500 ms, which also returns the zod errors) and a footer: "About $0.00x per hour · N tokens per call of 32,000".
- Estimate: tokens ≈ characters of all instructions and criteria / 4, plus 1,500 for the segment text; per hour = 120 segments × tokens × $0.042 / 1,000,000 (Jev's price, `docs/jev.md` § Limits and price). `overLimit` when tokens > 30,000.
- A collapsible **How to write good labels** guide: judge only the segment; concrete true/false criteria (the memory-question lesson in `docs/gotchas.md` § Jev questions); options that do not overlap; thresholds away from where answers cluster (the `worthMin` lesson).
- Save / Cancel; a built-in set opens read-only with **Clone to edit**.

**Done when:** creating a set with 1 category, 0 scores, 3 markers, saving, and starting a replay with it renders its lanes, chips, and Insights (§8).

#### §4.T2.4 Start live

**Where:** `#dlg-start` `web/index.html:208-235` (the `#feat-labels` switch at 227); `openStartLive` / `bindStartLive` `web/src/panels.ts:187-212`; `api.startLive` in `web/src/api.ts`; `PER_HOUR` / `renderStartSummary` in `panels.ts`.

**How:** replace the labels switch with a **Labels** select (every set by name, then **Off**), remembered in `localStorage` like the microphone (`MIC_KEY`), falling back to the built-in set when the remembered one is gone. Below it, **Tonight's stories (optional)**, a textarea, one headline per line (hidden when Labels is Off). Send `labelSet` and `stories`. The summary's cost line uses the chosen set's estimate. Replay (Recordings → Replay) uses the remembered set.

#### §4.T2.5 Docs for Tier 2

`docs/architecture.md` (API table, Labels window, Start live), `docs/rehearsal.md` (stories are typed in Start live; remove "cog → Labels → Save stories"), `README.md` § Using it, `docs/desktop.md` if downloads/imports differ in the app. Rebuild the manifest.

---

### Tier 3 — Try on a recording

#### §4.T3.1 Preview a draft on a recording

**Where:** `SessionLibrary.snapshot` / `dirOf` `src/store/library.ts`; the Jev client `src/jev/client.ts` (purpose names, retry rules: `docs/jev.md` § The client); `renderTimeline` `web/src/timeline.ts:207` (render into any container).

**How:** `POST /api/label-sets/try` `{ set, sessionId, minutes: 10 }`: validates the set; loads the recording's segments and their utterance text read-only; asks Jev the draft's questions for the segments starting within the first `minutes` (at most 40 segments), 4 in parallel (`jev.segmentConcurrency`), purpose `"try"` with the background retry rules; returns `{ labels: SegmentLabels[], costUsd, segments }`. Nothing is written into the recording's folder. Refuse while a session is on air (409), like other background Jev work. In the editor, **Try on a recording**: pick a recording (from `/api/sessions`), confirm the estimated cost ("about $0.00x"), then show two timelines stacked for that stretch: the recording's own labels and the draft's.

**Done when:** a server test with a fake Jev client covers the route and checks the recording folder is untouched; one live check on a real recording, after asking the user.

**Stop and ask if:** the recording has no segments (a transcript-only session): show "This recording has no segments to label" and do not call Jev.

---

### Tier 4 — Create with AI

#### §4.T4.1 Reword the mission first

**Where:** `docs/mission.md` § Principles ("Improve with an outcome signal, or leave it to the host … its labels are a host-editable config that no LLM writes or changes.") and § Non-goals ("An LLM writing or changing timeline labels, or a live System 2 on the timeline.").

**How:** reword to: the host owns the timeline's labels; an LLM may **draft** a label set that the host reviews, edits, and saves, but no LLM changes a label set or the labels on its own, and none runs on the timeline live. Show the user the two new sentences before saving.

#### §4.T4.2 The assistant

**Where:** pattern to follow: `S2Client.rewrite` `src/factcheck/s2.ts:294` (strict `json_schema`, OpenRouter `CHAT_URL` `s2.ts:6`, provider settings from config); keys via `src/keys.ts`; chat cost cap pattern in `src/chat/chat.ts`.

**How:**
1. `config/app.json` gains `labelsAssist: { model: "openai/gpt-6-luna", effort: "medium", provider: <same as s2.provider>, timeoutMs: 90000, maxAttempts: 2, capUsd: 1 }` (schema in `AppConfigSchema`). No model picker anywhere (user decision).
2. `POST /api/label-sets/assist` `{ messages: [{role, content}], draft: set | null }` → `{ reply: string, set: set | null, costUsd }`. System prompt: what a label set is, the three types and limits (2/2/8, 5 levels, ≤255 options), the `ICONS` list, the wording guide from §4.T2.3, and the built-in set as an example. Response format: strict JSON schema `{ reply, set }`. Validate `set` with the zod schema; on failure retry once with the error appended; then return the reply with `set: null` and the error.
3. Per-conversation spend capped at `capUsd`; the running cost shows in the dialog.
4. UI: Labels library → **Create with AI** opens a dialog: chat on the left (styled like the Chat window), the draft in the editor on the right, updated when a reply carries a set. The user can edit the draft directly; the next message sends the edited draft. **Try on a recording** and **Save** as in the editor.
5. Requires the OpenRouter key, which the app always has after setup; on a 401/402 show the OpenRouter error, as Chat does.

**Done when:** tests with a fake OpenRouter response cover a valid set, an invalid set (retry, then error), and the cap; one live check after asking the user; `docs/jev.md` and `docs/architecture.md` describe it.

## §5 Non-goals

- Do not make the boundary question editable, per set or globally.
- Do not let a session's set change while it runs (no live label editing; `PUT /api/labels` is removed).
- Do not add a model picker to Create with AI; do not use a model other than `labelsAssist.model`.
- Do not let an LLM change a set without the user saving it, and never run one on the live timeline.
- Do not change the System 1 fact-check questions or `config/factcheck.s1.default.json`.
- Do not add a database, a sync service, or cloud storage: sets are plain files in Application Support.
- Do not add emoji icons or a third-party icon package; draw the icons as SVG symbols.
- Do not add dependencies (`package.json` dependencies are read-only).
- Do not change how recordings are exported/imported (`src/store/transfer.ts`) beyond what `session.json`'s new fields need (they already travel inside the recording).
- Do not bump the version or edit `CHANGELOG.md` (the release skill does both).

## §6 Known uncertainties

| # | Uncertainty | Safe behaviour |
| --- | --- | --- |
| 1 | Whether the new `clip_worthy` yes/no wording marks about as many segments as the old score ≥ 3. | After Tier 1, compare on recording `20260925-202620` with Try on a recording (Tier 3) or a relabel, and report the counts to the user before tuning. |
| 2 | `SessionLibrary.snapshot`'s exact shape for labels and stats of old recordings (anchored at `src/store/library.ts:317-330`, not fully read). | Read it before §4.T1.3; convert at that single point so the page only ever sees the new format. |
| 3 | The live **Save stories** and **Relabel closed segments** buttons disappear with the old Labels window; their engine routes stay. | Do not build new UI for them. Tell the user at the end of Tier 1 and ask whether they want them back (e.g. in the timeline header). |
| 4 | Stored `stats` events of old recordings have the old shape; the page may receive either. | Convert in one place (`fromLegacyStats`), used by both the snapshot and the page's event handler. |
| 5 | The token estimate (characters / 4) is approximate. | Label it "about"; block saving only when the server's validation fails, never on the estimate alone. |
| 6 | GPT-6 Luna's quality at drafting sets has not been measured. | Build as specified; after the live check, show the user the drafted set and ask whether the quality is acceptable before documenting the feature as done. |

## §7 Anti-hallucination guardrails

1. New files allowed: `config/timeline.json`, `config/labels/ai-podcast.json`, `src/labels/store.ts`, `src/labels/legacy.ts`, `web/src/icons.ts`, `tests/labels.test.ts`, test fixtures under `tests/fixtures/` if needed. Anything else: ask.
2. `config/labels.default.json` is deleted only after its content is embedded in the converter and the equality test (§4.T1.1) passes.
3. Keep Jev's wording of the ten existing questions byte-identical in the built-in set.
4. Every dialog in the Mac app's main process goes through `ask()` in `desktop/main.ts` (`docs/gotchas.md` § Mac app); the page's own dialogs use the in-page `ask()` in `web/src/panels.ts`, never `confirm()` or `prompt()`.
5. A list inside an open modal dialog must be appended to that dialog (the bespoke select handles it; `docs/gotchas.md` § Web page). The icon grid and colour palette are in-dialog elements, not popovers on `<body>`.
6. No emoji anywhere in the UI.
7. One task per commit, conventional commits (`feat(labels): …`, `refactor(timeline): …`, `docs: …`), each ending with the attribution line the session provides. Do not commit until the user says so.
8. Do not run `npm run dist:mac`, the release skill, or anything that pushes.
9. Paid calls (replay, Try, Create with AI live checks): ask first, every time.
10. No edits under `specs/`.

## §8 Verification commands

```bash
npm install                      # once
npm run typecheck && npm test    # after every task
npm run build:web && npm run build:desktop
```

**Driving the dev app** (the packaged app refuses debugging on purpose):
```bash
npx electron . --remote-debugging-port=9333 &
curl -s localhost:9333/json/list        # the page's webSocketDebuggerUrl
```
Use a small Node script over the DevTools protocol (`Runtime.evaluate`, `Page.captureScreenshot`) to navigate (`location.href = "/recordings/20260925-202620"`), read the DOM, and screenshot. If the user's own dev app is open, a second instance only focuses theirs: ask them to quit it, or test in a headless Chrome against `npm run serve` (`--headless=new --remote-debugging-port=9334`; the page never finishes "loading" because of the event stream, so do not wait for load: poll the DOM). Quit the dev app with the app menu's Quit, or `pkill -f "remote-debugging-port=9333"`.

**Menus in the dev app:** `osascript -e 'tell application "System Events" to tell process "Electron" to click menu item "…" of menu 1 of menu bar item 2 of menu bar 1'`.

**Recordings for checks:** `sessions/20260925-202620` (2 h, labels, 46 flags, 4 errors), `sessions/20260925-180856`. Opening one is read-only; close the view afterwards with `POST /api/sessions/close`.

**Where sets land:** `ls ~/Library/Application\ Support/Conversation\ Assistant/labels/`. Before testing, note what is there; remove only the sets your tests created.

## §9 Domain glossary

| Term | Meaning |
| --- | --- |
| Jev | TypeSafe AI's decision model: answers typed questions (choice, noul = yes/no probability, score) about a text state. `docs/jev.md` |
| Segment | A stretch of conversation (about 12–75 s) closed by the boundary question; labels are asked per segment |
| Label | One question asked about each segment: a **category** (choice), a **score** (0–4), or a **marker** (yes/no, shown as an icon when ≥ its threshold) |
| Label set | A named collection of up to 2 categories, 2 scores, 8 markers, plus prefix, faded confidence, companies, optional index |
| Boundary question | The yes/no question asked per sentence that decides where segments end; calibrated; locked |
| Stories | Tonight's headlines; add the `story` question and a "Topics tonight" hint to transcription |
| Index | A category's options whose share of time is shown as one big percentage (today: Off-topic) |
| System 1 / System 2 | The fact-checker's Jev questions / the LLM that researches and rewrites them. Not part of this work |
| Recording, session | A session is what runs (live or replay); a recording is a finished one, reopened read-only |

## §10 References

- `docs/mission.md` (principles, non-goals), `docs/jev.md` (timeline questions, limits, client), `docs/architecture.md` (web front end, API, Insights), `docs/recordings.md` (session folder), `docs/gotchas.md` (§ Jev questions, § Web page, § Mac app), `docs/desktop.md` (downloads, dialogs).
- Other specs: `specs/260928-01-apple-speech-transcription/` (unrelated).

**Code anchors**
```
LabelSetSchema, parseLabelSet        src/config.ts:96-103, :169
timeline block of AppConfigSchema    src/config.ts:61-64
NoulQuestion, ChoiceQuestion, ScoreQuestion, QuestionId   src/jev/types.ts:4-35
timelineQuestions, deriveLabels      src/pipeline/timeline.ts:23, :66
AI_SUBJECTS, sectionsOf, Timeline    src/pipeline/timeline.ts:41, :93, :123
computeStats, OFF_TOPIC              src/pipeline/stats.ts:38, :31
new Timeline / session.json write    src/pipeline/session.ts:174, :270
StartRequest, parseFeatures          src/server/main.ts:57-70
putLabels, relabel, putStories       src/server/main.ts:510-527, routes :730-732
SessionLibrary.snapshot              src/store/library.ts:317-330
stats event schema                   src/store/events.ts:38
S2Client.rewrite, CHAT_URL           src/factcheck/s2.ts:294, :6
appSupportDir, AppPaths              src/paths.ts
SUBJECT_COLORS, MODE_COLORS, MARKERS, renderLegend, renderTimeline   web/src/timeline.ts:9-30, :207
segmentMatches, renderFilters, segdiv, renderStats, renderMenu       web/src/panels.ts:432, :443, ~558, :972, ~340
openStartLive, bindStartLive         web/src/panels.ts:187, :199
renderLabels, questionRow, readEditor (to remove)                    web/src/panels.ts:870-930
SESSION_WINDOWS                      web/src/panels.ts (above renderMenu)
Jev log segment summary              web/src/calls.ts:42, :54, :129
glyph                                web/src/dom.ts:22
#dlg-labels, #dlg-start, #feat-labels, #filters, #legend             web/index.html:180, :208, :227, :102, :146
```
