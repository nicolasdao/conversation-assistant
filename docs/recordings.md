---
description: Where every session is stored, what each file holds, and how the recordings library lists, names, searches, reopens, and replays past sessions.
tags: [sessions, storage, library, replay, api]
source:
  - src/store/sessionStore.ts
  - src/store/library.ts
  - src/store/events.ts
  - src/server/main.ts
---

# Recordings

Every session — live or replay — is kept as one folder of plain files. There is no database. The recordings library reads those folders to list, search, name, and reopen them.

## Session folders

`src/store/sessionStore.ts` creates `sessions/<YYYYMMDD-HHMMSS>/` at session start (tool runs use a prefix: `smoke-`, `preflight-`, `dev-`). Every JSONL file is append-only and flushed on every write, so a crash loses at most the last line.

| File | Holds |
| --- | --- |
| `host.wav`, `remote.wav` | The streams as received, 16 kHz mono PCM16 — enough to replay the session exactly |
| `session.json` | Mode, start time, streams, config snapshot, label set, System 1 set |
| `events.jsonl` | Every event the page received (except transient live text) |
| `utterances.jsonl` | VAD utterances with times, speaker id, and tags |
| `transcriptions.jsonl` | One row per final (`transcription`) and live (`live_transcription`) transcription call, with cost |
| `jev_calls.jsonl`, `s2_calls.jsonl` | One row per Jev and GPT-6 Luna call, with state, answers, and cost |
| `segments.jsonl`, `labels.jsonl`, `claims.jsonl`, `verdicts.jsonl`, `s1_versions.jsonl`, `audits.jsonl` | Pipeline results |
| `speakers.json` | Final speaker list, written at session end |
| `meta.json` | Library metadata: `name`, `notes` (only if set) |

The development budget (`src/budget.ts` `sumDevSpend`) sums `cost_usd` over the call rows in all of these folders. Keys are redacted from every file and event.

## The library — `src/store/library.ts`

`SessionLibrary` scans `sessions/` for folders with a `session.json`. Tool runs are hidden unless `includeTools` (`?all=1`) is set. Each recording is summarised from its files: name, notes, mode, start time, duration (from WAV size), whether `session.ended` was recorded, utterance count, speakers (from `speakers.json`, else from speaker events), segments, claims, and total cost. Summaries are cached per folder and recomputed when `events.jsonl`, `meta.json`, or `speakers.json` changes.

- **Search** (`list({ q })`) is case-insensitive and needs every word to match. It checks name, notes, id, and speaker names, and the text of every `utterance` event; up to 5 matching lines are returned per recording as `{ utteranceId, startMs, speaker, snippet }`.
- **Names and notes** are written to `meta.json`, never to the append-only files. An empty string clears the field. Names are limited to 120 characters and notes to 4,000.
- **Ids** must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, so a request cannot reach outside `sessions/`.

## Open vs Replay

| | Open | Replay |
| --- | --- | --- |
| What happens | The recorded `events.jsonl` is loaded into the event bus (`EventBus.load`) and the page rebuilds the session from it | The session's WAVs run through the whole pipeline again as a new session |
| API calls | None — free | All of them: transcription, Jev, System 2, and live text at speed 1 (about 2× the original) |
| Editable | No: commands such as rename speaker return 409 | Yes, like any session |
| Result | Exactly what was seen at the time | A new session folder; answers can differ (Jev and GPT-6 Luna are not deterministic) |

While a recording is open, `GET /api/state` returns an archived snapshot (`session.status: "archived"`), and the page replaces the stream meters with a "Recorded session" note. Starting a live session or a replay leaves the archived view.

## API

| Method | Route | Does |
| --- | --- | --- |
| GET | `/api/sessions?q=&all=1` | List recordings, newest first; with `q`, only matches, each with `matches` |
| GET | `/api/sessions/:id` | One summary |
| PATCH | `/api/sessions/:id` | `{ name?, notes? }` → updated summary |
| POST | `/api/sessions/:id/open` | Reopen read-only → `{ sessionId, events }`; 409 while a session runs |
| POST | `/api/session/start` | `{ mode: "replay", sessionId, speed }` replays a recording; `name` names the new session |

The web page exposes this as the **Recordings** tab (search, Rename, Open, Replay). Its final look is still to be designed.

Related: [Transcription](transcription.md) for live-text cost, [Rehearsal kit](rehearsal.md) for using a recording as the on-air fallback.
