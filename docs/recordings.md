---
description: Where every session is stored, what each file holds, and how the recordings library lists, names, searches, reopens, plays back, replays, and deletes past sessions.
tags: [sessions, storage, library, replay, playback, api]
source:
  - src/store/sessionStore.ts
  - src/store/library.ts
  - src/store/events.ts
  - src/server/main.ts
  - src/server/audio.ts
---

# Recordings

Every session — live or replay — is kept as one folder of plain files. There is no database. The recordings library reads those folders to list, search, name, and reopen them.

## Session folders

`src/store/sessionStore.ts` creates `sessions/<YYYYMMDD-HHMMSS>/` at session start. `npm run smoke` and `npm run preflight` write only their call logs, to `smoke-…` and `preflight-…` folders; those have no `session.json`, so the library never lists them. Every JSONL file is append-only and flushed on every write, so a crash loses at most the last line.

| File | Holds |
| --- | --- |
| `host.wav`, `remote.wav` | The streams as received, 16 kHz mono PCM16 — enough to replay the session exactly |
| `session.json` | Mode, start time, streams, config snapshot, label set, System 1 set |
| `events.jsonl` | Every event the page received (except transient live text) |
| `utterances.jsonl` | VAD utterances with times, speaker id, and the `loud` tag (`overlap` is computed later and appears only in Jev states) |
| `transcriptions.jsonl` | One row per final (`transcription`) and live (`live_transcription`) transcription call, with cost |
| `jev_calls.jsonl`, `s2_calls.jsonl` | One row per Jev and GPT-6 Luna call, with state, answers, and cost |
| `segments.jsonl`, `labels.jsonl`, `claims.jsonl`, `verdicts.jsonl`, `s1_versions.jsonl`, `audits.jsonl` | Pipeline results |
| `speakers.json` | Final speaker list, written at session end |
| `meta.json` | Library metadata: `name`, `notes` (only if set) |

The development budget (`src/budget.ts` `sumDevSpend`) sums `cost_usd` over the call rows in all of these folders, plus `sessions/deleted-spend.jsonl`: deleting a recording first appends its total there (`kind: "deleted_session"`), so deleting cannot lower the development total. Keys are redacted from every file and event.

## The library — `src/store/library.ts`

`SessionLibrary` scans `sessions/` for folders with a `session.json`. Folders prefixed `smoke-`, `preflight-`, or `dev-` are hidden unless `includeTools` (`?all=1`) is set. Each recording is summarised from its files: name, notes, mode, start time, duration (from WAV size), whether `session.ended` was recorded, utterance count, speakers (from `speakers.json`, else from speaker events), segments, claims, and total cost. Summaries are cached per folder and recomputed when `events.jsonl`, `meta.json`, or `speakers.json` changes.

- **Search** (`list({ q })`) is case-insensitive. A recording matches when every word appears in its metadata (name, notes, id, speaker names), or every word appears in one single utterance; a word in the name plus another in a transcript line does not match. up to 5 matching lines are returned per recording as `{ utteranceId, startMs, speaker, snippet }`.
- **Names and notes** are written to `meta.json`, never to the append-only files. An empty string clears the field. Names are limited to 120 characters and notes to 4,000.
- **Ids** must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, so a request cannot reach outside `sessions/`.

## Open vs Replay

| | Open | Replay |
| --- | --- | --- |
| What happens | The recorded `events.jsonl` is loaded into the event bus (`EventBus.load`) and the page rebuilds the session from it | The session's WAVs run through the whole pipeline again as a new session |
| API calls | None — free | All of them: transcription, Jev, System 2, and live text at speed 1 — about the original session's cost again (more than a `--speed max` replay, which skips live text) |
| Editable | Speakers only: rename and merge are saved into the recording (below); every other command returns 409 | Yes, like any session |
| Result | Exactly what was seen at the time | A new session folder; answers can differ (Jev and GPT-6 Luna are not deterministic) |

Renaming or merging a speaker on an open recording appends the `speaker.updated` or `speaker.merged` event to its `events.jsonl` (append-only, like every other event) and applies it to `speakers.json`, so the page updates at once, the library lists the new names, and reopening replays the edit. Search snippets show each line's speaker by their current name.

While a recording is open, `GET /api/state` returns an archived snapshot (`session.status: "archived"`), and the page shows Archive in the header's ON AIR block, with no stream meters. Starting a live session or a replay leaves the archived view. A session that ends (Stop, or the end of a replay's input) becomes one too: the engine switches to serving it as an opened recording, and the page shows it as Archive.

**Playback.** An open recording can be listened to: `GET /api/sessions/:id/audio` mixes `host.wav` and `remote.wav` on the fly into one 16 kHz mono WAV (the shorter stream padded). Each stream is raised to a common speech level first: its loud speech (the 95th percentile of 100 ms blocks, sampled every 2 s, cached per file) is brought to −12 dBFS (on laptop speakers, −14 was slightly too quiet and −10 sounded saturated), with at most +20 dB of gain, because recorded speech sat around −24 to −28 dBFS, well under a typical podcast; this also balances the host's mic against the call. The sum then goes through a soft limiter (linear up to 0.85 of full scale, bent smoothly towards it above, so only the loudest peaks are touched) instead of clipping. The page adds a volume boost on top (100–300 %, a Web Audio gain node), with HTTP Range support so the page can seek, and without loading the files (`src/server/audio.ts`). Both files share the session clock (sample index ÷ 16 = session ms), so the audio's time is the timeline's time. The page plays it in an `<audio>` element at 1×–4× with `preservesPitch`, so sped-up voices keep their pitch (see [Architecture](architecture.md)). Playback exists only for recordings, never on air.

**Delete** removes a recording's folder for good, after an in-page confirmation (`DELETE /api/sessions/:id`). The running session cannot be deleted (409). Deleting the recording on screen opens the one listed below it (or above, if it was the last), or clears the view if none is left.

## API

| Method | Route | Does |
| --- | --- | --- |
| GET | `/api/sessions?q=&all=1` | List recordings, newest first; with `q`, only matches, each with `matches` |
| GET | `/api/sessions/:id` | One summary |
| PATCH | `/api/sessions/:id` | `{ name?, notes? }` → updated summary |
| GET | `/api/sessions/:id/audio` | The recording's two streams mixed into one WAV, with Range support (`206` / `416`) |
| POST | `/api/sessions/close` | Leaves the opened recording's view; the page's `/` |
| DELETE | `/api/sessions/:id` | Deletes the recording's folder → `{ deleted }`; 409 for the running session |
| POST | `/api/sessions/:id/open` | Reopen read-only → `{ sessionId, events }` (`events` is the number of events loaded); 409 while a session runs |
| POST | `/api/session/start` | `{ mode: "replay", sessionId, speed }` replays a recording; `name` names the new session |

The web page exposes this as **Recordings** in the settings menu (the cog, top right): a modal with search and match snippets. Click a recording to open it (the modal closes and the recording loads); click its name to rename it in place (Enter or leaving the field saves, Escape cancels); each row has a Replay button and a Delete button (with an "Are you sure?" confirmation).

Related: [Transcription](transcription.md) for live-text cost, [Rehearsal kit](rehearsal.md) for using a recording as the on-air fallback.
