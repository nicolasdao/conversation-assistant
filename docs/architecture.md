---
description: The end-to-end architecture — native capture, the Node engine's pipeline from audio to utterances, transcripts, segments, labels, and fact-checks, the event bus and HTTP/SSE API, the web front end, storage, and budgets.
tags: [architecture, pipeline, capture, api, events, web, budget]
source:
  - src/pipeline/session.ts
  - src/pipeline/stats.ts
  - src/server/main.ts
  - src/audio/**
  - src/budget.ts
  - src/config.ts
  - native/capture/**
  - web/**
---

# Architecture

Conversation Assistant has two parts. The **engine** — the Node engine plus a native capture helper — owns everything that captures, thinks, and stores. The **front end** is a thin web page that only reads the engine's state and events and posts commands; it could be replaced (for example by a SwiftUI app) without touching the engine.

The engine runs in one of two hosts, with the same start-up (`bootEngine()` in `src/server/main.ts`) and the same router: **`npm run serve`**, a server on http://127.0.0.1:4317 for development and the command-line tools, or **the Mac app**, where it runs inside Electron's main process and the app's window reaches the router in-process, with no port (see [The Mac app](desktop.md)). Where the engine finds its files — the page, config, models, recordings, the helper — comes from `src/paths.ts`: the project folder by default, the app bundle and Application Support in the Mac app.

```mermaid
flowchart TB
  subgraph Mac
    MIC[Built-in microphone] --> HELPER
    OUT[Everything the Mac plays<br/>Riverside call, any output device] --> HELPER
    HELPER["conversation-capture (Swift)<br/>16 kHz PCM16 frames on stdout"]
  end
  HELPER --> SRC[Audio sources: host, remote]
  FILES[WAV files] --> SRC
  SRC --> VAD[Silero VAD per stream] --> TAGS[Tags: loud, overlap] --> SPK[Speaker registry<br/>WeSpeaker embeddings]
  VAD -.speech.-> LIVE[Live text<br/>gpt-live-transcribe]
  SPK --> TR[Final transcript<br/>gpt-transcribe]
  TR --> SEG[Segmenter<br/>reorder buffer + Jev per utterance]
  SEG --> TL[Timeline<br/>Jev per segment]
  SEG --> FC[Fact-checker<br/>System 1 flags → System 2 research]
  TL & FC & SEG & LIVE --> BUS[Event bus]
  BUS --> STORE[(Session folder files)]
  BUS --> SSE[HTTP + SSE API<br/>npm run serve: 127.0.0.1:4317<br/>Mac app: app:// in-process, no port]
  SSE --> WEB[Web page]
```

## Capture — `native/capture/` and `src/audio/nativeSource.ts`

`conversation-capture` is a Swift command-line helper (swift-tools 6.0, Swift 5 language mode) that uses Apple frameworks only:

- **`host`** — the MacBook's built-in microphone, chosen explicitly whatever the default input is, captured with `AVAudioEngine` (voice processing off, channel 0).
- **`remote`** — a private Core Audio tap (macOS 14.2+) of everything the Mac plays, read through a private aggregate device whose main sub-device is the current default output. When the default output changes (AirPods connect), the aggregate is rebuilt.
  - **The tap follows the apps playing sound** (`CATapDescription(monoMixdownOfProcesses:)`): every other process whose `kAudioProcessPropertyIsRunningOutput` is set. The list is updated in place (`kAudioTapPropertyDescription`), so the aggregate keeps running. Updates come from listeners on the process list and on each process's flag, plus a check every second, because a process can start playing before its listener is attached. An app that starts playing mid-session can lose up to about a second at its start; a call plays throughout, so this only touches the moment it begins. A failed update is a `warning` status line and is retried.
  - **Why not a global tap:** a global tap (`monoGlobalTapButExcludeProcesses: []`) captures the same sound, but on macOS 26.2 it made other apps hang when they started a microphone (see [Gotchas](gotchas.md#capture-macos)). `--tap global`, or `CONVERSATION_CAPTURE_TAP=global` in the environment of `npm run serve`, brings it back as a fallback. `started` reports the mode as `remote.tap`.
- **Output kind** — `started` and `device_changed` carry `remote.outputKind`: `speakers`, `headphones`, or `virtual` (`Devices.outputKind`). Bluetooth counts as headphones. A built-in output is headphones when its data source is `hdpn` or its name says "Headphones" (Apple silicon lists the jack as its own device, "External Headphones"), speakers when it is `ispk`. Anything else (USB, HDMI, AirPlay, aggregate) counts as speakers. A data-source listener reports a jack plugged in on Macs that switch the source rather than the device.
- **The mic watchdog** (`Mic.swift`) restarts the microphone's engine whenever no buffer has arrived for 1.5 s, and checks 0.5 s after every `AVAudioEngineConfigurationChange`, whatever `isRunning` says. It restarts at most 5 times a minute, then every 10 s until audio flows again; it never gives up. Each restart is a `warning` status line (see [Gotchas](gotchas.md#capture-macos)).
- **ClockLock** timestamps each buffer from its host time and keeps each stream's sample count within 20 ms of the session clock, inserting silence when a stream falls behind and dropping samples when it runs ahead, so sample index ÷ 16 = session milliseconds on both streams.
- **Stdout** carries binary frames only: `PCAP`, a stream byte (0 host, 1 remote), 3 reserved bytes, `sessionMs` (float64 LE), a sample count (uint32 LE), and that many PCM16 LE samples at 16 kHz (1,600 per frame, about every 100 ms). **Stderr** carries JSON status lines (`started` with `epochMs`, `device_changed`, `warning`, `error`).
- `--list-devices` prints input devices; `--probe <s>` prints peak and RMS levels (used by `capture:test` and `preflight`).

The Info.plist is embedded in the binary (`-sectcreate __TEXT __info_plist`), without which macOS refuses the permissions. macOS attributes both permissions to the app that launched the helper — the terminal app for `npm run serve`, Conversation Assistant itself for the Mac app, which declares the same two usage descriptions in its own `Info.plist` (see [The Mac app](desktop.md#macos-permissions)); a denied permission delivers silence, not an error (see [Gotchas](gotchas.md)).

The Node adapter spawns the helper, parses frames across partial reads, maps helper time onto the session clock (`started.epochMs − session start`), and re-chunks into 512-sample Float32 frames, filling gaps with silence. A malformed frame kills the helper; an unexpected exit is restarted up to 3 times per session, 1 s apart, with an `error` event each time, then the live sources end cleanly. Stopping closes stdin, then sends SIGTERM after 2 s and SIGKILL after 5 s.

`FileSource` plays WAV files as the same 512-sample frames — at real-time pace (`speed: 1`) or as fast as possible (`"max"`). Nothing downstream knows which kind of source it reads.

## The session pipeline — `src/pipeline/session.ts`

A `Session` wires everything together and runs until input ends or it is stopped:

1. **Merge.** Frames from both sources are merged in `sessionMs` order, so file streams stay aligned at any speed. Each frame is written to `host.wav` / `remote.wav` as received, after Pause and [speaker mode](#speaker-mode-the-echo-gate) have replaced muted audio with silence.
2. **VAD.** One Silero VAD per stream (threshold 0.5, 0.25 s minimum speech, 0.5 s minimum silence, 30 s maximum) cuts utterances at pauses, never at fixed intervals. Utterance ids (`u_<n>`) come from one session-wide counter.
3. **Tags.** `loud` — the utterance's RMS is at least 6 dB above the median of that stream's last 50 utterances. `overlap` — it overlaps an utterance on the other stream by at least 1 s (computed when the segmenter releases it).
4. **Speakers.** Local voice embeddings assign or create a speaker (see [Speakers](speakers.md)).
5. **Transcription.** Each utterance is uploaded for its final text; while it is still being spoken, live text streams to the page (see [Transcription](transcription.md)).
6. **Segmenter.** A reorder buffer releases utterances in `startMs` order across both streams — when everything earlier has finished transcribing and the other stream has passed that time and is not mid-speech, or 8 s after transcription. Each non-filler utterance gets one Jev request carrying the `boundary` question and the System 1 fact-check questions; code closes segments (see [Jev](jev.md)).
7. **Timeline.** Each closed segment gets one Jev request with the host-editable label set (see [Jev](jev.md)).
8. **Fact-checker.** System 1 answers from step 6 flag claims; System 2 researches, audits, and rewrites (see [System 1 and System 2](system1-system2.md)).
9. **Stats** every 60 s and at the end (`src/pipeline/stats.ts`): the Off-topic index (`roganIndex` in stored stats; the share of labelled time on `personal_life` and `other_topics`), talk time, disagreements and duration-weighted hype per speaker, predictions, recommendations, clip-worthy segments, fact-check totals, and cost.

At end of input, in order: close the WAVs (their final headers are written at once, so the audio is complete however long the rest takes, or if the Mac app quits during it); flush every VAD; wait for transcriptions and the segmenter; close the open segment (`final: true`) and label it; drain research, audits, and rewrites for at most 180 s; emit `stats`; write `speakers.json`; emit `session.ended`.

## Event bus and API — `src/store/events.ts`, `src/server/main.ts`

Every result is an event with a payload checked against a zod schema (a failed check is logged, the event still goes out), a sequence number, and a timestamp. The bus keeps the session's history (replayed to every new SSE connection), and the session appends each event to `events.jsonl`. Three types are transient, streamed but never stored: `utterance.partial`, and `call.started` / `call`, the live view of every Jev and System 2 call (the call logs on disk are their record).

| Group | Events |
| --- | --- |
| Session | `session.started`, `session.ended`, `session.paused` / `session.resumed` (with the session time `atMs`), `echo.gate` (speaker mode on or off: `active`, `device`, `atMs`), `health` (per stream, every second: RMS dBFS, ms since last frame, utterances in the last minute, capture device; on the host in speaker mode, `echoMutedMs`) |
| Speech | `utterance.partial`, `utterance`, `utterance.failed` (a line not transcribed: `retrying`, `failed`, or `empty`; see [Transcription](transcription.md)), `speaker.created`, `speaker.updated`, `speaker.merged` |
| Timeline | `segment.closed`, `segment.labels`, `section.updated` |
| Fact-check | `claim.flagged`, `claim.duplicate`, `claim.repeat`, `claim.researching`, `claim.verdict`, `claim.dropped`, `claim.disputed`, `audit`, `s1.version`, `s1.memory` |
| Accounting | `cost`, `budget.exhausted`, `stats`, `error` |
| Calls (transient) | `call.started` (`system`: `s1` or `s2`, `purpose`) when a Jev or System 2 call is sent; `call` with the logged row when it completes (a Jev row also carries the question definitions, for display) |

The router (`createApiServer`) uses Node's `http` module and serves one session at a time (an `Engine` owns it). `npm run serve` listens on 127.0.0.1 only; the Mac app never listens: each request from its window reaches the same router over an in-memory stream pair (`src/server/inProcess.ts`, see [The Mac app](desktop.md#the-in-process-connection--srcserverinprocessts)).

| Method | Route | Does |
| --- | --- | --- |
| GET, POST | `/api/setup`, `/api/setup/keys` | The API keys: what is set, and saving checked keys. Until both are set, every other route but `/api/about` and `/api/engine` answers 503 and the page shows only the setup screen (see [Setup](setup.md)) |
| GET | `/api/events` | SSE: the session's events so far, then live |
| GET | `/api/state` | Full current state (or a recorded session's snapshot) |
| POST | `/api/session/start` | `{ mode: "live", mic?, name?, features? }` or `{ mode: "replay", dir \| sessionId, speed, name?, features? }`; `features: { factcheck?, labels? }` (booleans, both on by default; see [Features](#features-transcript-only-sessions)) |
| POST | `/api/session/stop` | Stop reading input; in-flight work completes. When the session ends, the engine serves it as an opened recording (see [Recordings](recordings.md)) |
| POST | `/api/session/pause`, `/api/session/resume` | Live sessions only: while paused, incoming audio is replaced by silence, so nothing is heard, transcribed, or spent, and the WAVs and session times stay aligned; Stop still works |
| GET | `/api/devices` | The helper's input devices |
| POST | `/api/speakers/:id/rename`, `/api/speakers/merge` | Speaker edits (see [Speakers](speakers.md)) |
| GET | `/api/speakers/suggestions?voices=` | Merge suggestions for the session on screen: which speakers are the same person, with a voice match and a confidence (see [Speakers](speakers.md)) |
| PUT | `/api/labels`, `/api/stories`; POST `/api/labels/relabel` | Timeline label set, tonight's stories, relabelling (see [Jev](jev.md)) |
| POST | `/api/claims/:id/override`, `/api/s1/rollback` | Host dispute, System 1 rollback (see [System 1 and System 2](system1-system2.md)) |
| GET | `/api/stats` | Current stats |
| GET | `/api/calls?system=s1\|s2&limit=` | The session on screen's most recent Jev (`s1`) or System 2 (`s2`) call rows, oldest first, and the models its config named |
| POST | `/api/sessions/close` | Leaves an opened recording's view (back to no session); a session on air is not affected |
| GET | `/api/about` | The project's name, version (the root `package.json`'s `version`, the only place it lives), and license (`id`, `holder`, and the `LICENSE` text); the page shows them in the settings menu's footer, the license opening in a window |
| GET | `/api/engine` | `{ startedAt, stale }`: `stale` is true when a `src/**/*.ts` file changed after the engine started; the page then shows a banner asking for a restart. Never in the packaged Mac app, which has no sources |
| GET, PATCH, POST, DELETE | `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/open` | The recordings library (see [Recordings](recordings.md)) |
| GET, POST | `/api/sessions/:id/export`, `/api/exports/:token`, `/api/sessions/import` | Export and import a recording as one `.conversation-recording` file (see [Recordings](recordings.md#export-and-import)) |
| GET, POST, PATCH, DELETE | `/api/chat/models`, `/api/chats`, `/api/chats/:id`, `/api/chats/:id/messages` (a server-sent event stream), `/api/chats/:id/stop` | The chat window, for the session on screen (see [Chat](chat.md)) |

**Every request must come from the page itself** (`fromThisPage`): the `Host` must be `127.0.0.1` or `localhost`, which defeats DNS rebinding, and any `Origin` must match it, so another website open in the browser can neither read anything nor act, not even with the "simple" cross-site requests that skip CORS (a text/plain POST that would start a recording). Anything else gets 403 (added 27 September 2026, after a review found only the setup routes guarded). The page itself is served with a Content-Security-Policy (`PAGE_CSP`): scripts, fonts, media, and connections from its own origin only, inline styles allowed because the page sets them from code.

It also serves `web/index.html` at `/` and at `/recordings/<id>` (the page's own URLs), and `web/styles.css`, `web/dist/**` and `web/fonts/**` as static files, confined to `web/` (inside the app bundle in the Mac app).

## Web front end — `web/`

Plain TypeScript compiled by `tsc` to browser ES modules (`npm run build:web`, run by `npm run serve`, `npm run app`, and `npm run dist:mac`) — no bundler, no framework, no chart library. `main.ts` first asks `GET /api/setup`: with a key missing it shows only the setup screen ([Setup](setup.md)); otherwise it imports `app.ts`, which loads `GET /api/state`, then applies `GET /api/events`; every update is idempotent (by id, and audits by timestamp) because the stream replays history on connect.

The look is "On Air", modelled on TV broadcast graphics: one dark navy theme, Barlow Condensed for labels and Barlow for text (both self-hosted in `web/fonts/`, SIL Open Font License), drawn SVG glyphs for markers (no emoji), and angled straps instead of rounded cards. The layout is three rows:

- **Header (one row):** an ON AIR block, only while a session is capturing (On air, Paused, Replay, or Stopping; it wipes in like a breaking-news strap when a session starts, and with a recording open or no session the header starts at the strap), the session name (click it to rename the session in place: Enter or leaving the field saves, Escape cancels; the name goes to the session's `meta.json`), with a chip — Transcript only, No fact-check, or No labels — when the session runs without some [features](#features-transcript-only-sessions), the elapsed clock, a **Speakers** chip in speaker mode (see [Speaker mode](#speaker-mode-the-echo-gate)), stream meters with device and last-frame age (red when a stream's level stays at or below −50 dBFS for more than 10 s, or no frame arrives for more than 3 s; the host meter reads "muted · call playing" instead while speaker mode mutes it), the spend against the session cap (breakdown on hover, chat included; for an opened recording, labelled Cost: what that recording cost when it ran, plus any chats about it), and the controls: **Export** (a recording on screen) and **Import** (anything but a session on air; see [Recordings](recordings.md#export-and-import)), Start live (which first opens a window with the microphone, how many people are on the call — Any (each time the window opens) or 1–4, also used by replays; see [Speakers](speakers.md) — and the session's [features](#features-transcript-only-sessions)), Pause / Resume (live sessions), Stop (only while a session is on air), then **Chat** (an accent-outlined icon button, ⌘K; see [Chat](chat.md)), a replay popover (folder and 1× / max speed), and a settings cog. The header shows only what applies to the screen: with no session, Import, Start live, Chat, Replay, and the cog; on a recording, Export and Import join them; on air, Start live, Replay, Export, and Import give way to Pause and Stop, so Pause, Stop, Chat, and the cog always fit. Short of room, the stream meters narrow and the session name ends in an ellipsis; the controls never shrink. Below 1100 px wide, the on-air header puts the meters and controls on a second row rather than let them run off the right edge.
- **Transcript and fact-checks (two columns)**, split by a divider you can drag (25–75 %, arrow keys too; double-click resets; the split is remembered in the browser):
  - the transcript, caption style, with segment dividers, live text, filters (markers, speaker, subject), and click-to-rename; a speaker's name tag appears once per run of consecutive lines, and inferred speakers show as a muted "name *";
  - the right column has three tabs. **Fact-check**: a solid verdict block (False, Supported, Misleading…, or Queued / Checking / Dropped), queued → researching → verdict steps, the restated claim, correction, sources, research latency, a repeat badge, and a "Host disputes" button; a tally of verdicts sits in the column header, and the most recently active card is on top.
  - **Fast · slow thinking**, written for an audience: System 1 (Jev) and System 2 (the configured model, GPT-6 Luna) side by side with their models, roles ("judges every line in under a second" / "researches only what System 1 flags"), calls, average time, cost per call, and total, joined by "flags claims" and "rewrites its questions". A system glows and reads Thinking while one of its calls is in flight, and the "flags claims" link animates while System 2 works. Then the cost of System 1's judgments against System 2's average ("N× cheaper with System 1"); a funnel from every line heard, to lines checked by Jev, flagged, researched by System 2, and verdicts, with each system's cost and time; and one row per claim showing its handoff (Jev's time and cost → System 2's time and cost → the verdict), which opens to both calls.
  - **Jev log**: every Jev call, newest first, in plain words: its session time, what it was for ("Line check", "Topic labels", "Rewrite test"), what Jev was shown, the decisive answers as sentences ("Checkable claim? No (8% yes)", "Worth checking? 0.0 of 4"), latency, cost, and what the app did next ("→ Flagged: sent to System 2", "→ Not flagged", "→ Already checked"). Clicking a call shows every answer (memory questions folded into one line) and the exact HTTP request and response (`POST …/alpha/decisions` with the model, state, and questions; `200 OK` with the answers and usage). A System 2 call shows the same way (`POST …/chat/completions`, with the system prompt folded).
- **URLs** (`web/src/router.ts`), so a refresh, a bookmark, or Back lands on the same view:

  | URL | Opens |
  | --- | --- |
  | `/` | Home: the session on air (live or replay), or none |
  | `/recordings/<id>` | That recording, opened read-only |
  | `?t=1:23:45` | The playback position in a recording (kept current on seeks, on pause, and every 5 s while playing) |
  | `?tab=thinking` · `?tab=jev-log` | The right column's tab (Fact-check is the default) |
  | `?panel=recordings` · `speakers` · `system-1` · `labels` · `stats` · `log` · `chat` · `keys` | The window that is open |
  | `?panel=chat&chat=chat_2` | A chat of the session on screen ([Chat](chat.md)) |

  The URL follows the screen: opening or leaving a recording, or a session ending as one, adds a history entry; tabs, windows, and the position update it silently. Opening a URL makes the screen match: on load it opens the recording it names (unless a session is on air, which is shown instead, with a message), and Back to `/` leaves the recording (`POST /api/sessions/close`). Loading `/` while the engine shows a recording puts that recording in the URL rather than closing it. Transcript filters, timeline zoom, and column and timeline sizes are browser preferences, not part of the URL.
- **Playback (recordings only, never on air):** a play/pause button, a speed picker (1×, 1.25×, 1.5×, 2×, 3×, 4×; voices keep their pitch), a volume boost (100–300 %, remembered in the browser), and the position, in the timeline's header (`web/src/player.ts`). The timeline is the progress bar: a yellow playhead moves with the audio and stays in view when zoomed; clicking the timeline outside segments and markers seeks there, and clicking a segment or marker seeks to its start. Every transcript timestamp becomes a button that plays from that line. Every jump, from either side, moves both at once, playing or paused: the transcript scrolls to the line at that time and the timeline brings the playhead into view. While playing, the line being heard is highlighted and kept centred, unless the reader scrolled in the last 4 s. Space plays and pauses. The audio is the recording's two streams mixed by the server (see [Recordings](recordings.md)).
- **Timeline (bottom, full width):** HTML lanes positioned in percent of the session length, with an inline-SVG heat and hype chart: section brackets, the `subject` lane (AI subjects as shades of one colour), the `mode` lane, heat and hype lines on 0–4, marker pins (disagreement, hot take, prediction, recommendation, clip-worthy, humour), a dashed "in progress" block for the open segment, hatched paused stretches, the axis, and a now line. Faded labels are dimmed; clicking a segment or marker jumps to the transcript. A dotted line follows the pointer with the exact time. Zoom with − / + / Fit or ⌘/Ctrl + scroll (a trackpad pinch), from the whole session down to about 30 s across; zoomed in, the strip scrolls sideways (the wheel scrolls through time), segment labels stay in view, axis ticks adapt to the zoom, and a live session stays pinned to the newest moment while scrolled to the end. Dragging the strip's top edge (or its arrow keys) makes the heat · hype chart taller or shorter; double-click resets it, and the height is remembered in the browser.
- **Settings (the cog menu), each in a modal:** Recordings, System 1 (active version, counters, last promotion or rejection with its gate, rollback), Speakers (rename, merge), Labels (question editor, stories, relabel), Stats, Log, API keys (replace a key; see [Setup](setup.md)).
- **Chat**, a large modal from the header: questions about the transcript to any curated OpenRouter model, like ChatGPT with the transcript as its only attachment (see [Chat](chat.md)).

**Every control is bespoke; none is the browser's own.**

- Renames, merges, disputes, deletes, and replay confirmations use an in-page dialog rather than the browser's `prompt()` and `confirm()`, so they read well on a shared screen.
- `web/src/ui.ts` upgrades every `<select>` on the page, including ones rendered later (a `MutationObserver` watches the page), into a styled button and listbox.
  - Keyboard: ↑ ↓, Home, End, Enter, Space, Esc, and type-to-jump.
  - The native select stays in the DOM, hidden, as the source of truth. Page code keeps using a plain `<select>`: it reads and sets `.value`, replaces `<option>`s, and listens for `change`.
- `title` attributes show as styled tooltips instead of the browser's own. The text moves to `data-tip` and `aria-description` on first hover or keyboard focus.
- Text fields get `autocomplete="off"`, so no browser autofill dropdown appears.
- The Jev log's folded prompt draws its own caret.
- Lists and tooltips are top-layer popovers, so they show above modals. A list opened from a control inside an open modal is appended to that dialog, not to `<body>`: a modal makes everything outside it inert, so a list outside the dialog shows but ignores clicks (before 27 September 2026 the Start live window's microphone could not be chosen with the mouse). The Start live window reloads the microphone list each time it opens, so earbuds or a USB mic connected after the page loaded appear, and it preselects the microphone used last time (remembered in the browser) when it is still connected. The page is laid out to be legible when shared as a window in Riverside at 1280 × 720.

## Features: transcript-only sessions

A session runs two features beyond its transcript, **fact-checking** (System 1 and System 2) and **labels** (Jev labels each closed segment). Both are on unless the start request turns them off (`features` in `POST /api/session/start`; `Features` in `src/pipeline/session.ts`). A session's features are fixed for its whole run: no command turns a feature back on. They are recorded in `session.json`, `session.started`, and `GET /api/state` (`session.features`); a recording from before features existed ran with both on.

| Features | What runs | Jev per line (`utterance`) | Jev per segment | System 2 |
| --- | --- | --- | --- | --- |
| Both on (default) | Everything | `boundary` + System 1 + memory | Timeline labels | Research, audits, rewrites |
| Fact-check off | Transcript, timeline labels | `boundary` only (version `off`) | Timeline labels | Never |
| Labels off | Transcript, fact-checks | `boundary` + System 1 + memory | Never; segments are kept, unlabelled | As usual |
| Both off ("transcript only") | Transcript, segments, chat | **Never** | Never | Never |

- **Segments without Jev.** With both features off, Jev is never asked. The segmenter closes a segment at a pause of at least `segmentation.pauseBoundaryMs` (2 s), once the segment is at least `minSegmentMs` (12 s) long, and before it would pass `maxSegmentMs` (75 s, marked `forced`). So the timeline still divides the show into stretches to jump between.
- **What still works:** capture, transcription and live text, speakers, the timeline's segments and playhead, Pause, Resume, Stop, recordings and playback, and [Chat](chat.md).
- **Refused commands:** for a feature that is off, the engine answers 409 ("labels are off for this session", "fact-checking is off for this session"). This covers `PUT /api/labels`, `PUT /api/stories`, `POST /api/labels/relabel`, `POST /api/claims/:id/override`, and `POST /api/s1/rollback`.
- **The page:**
  - **Start live** opens a window with the microphone and people-on-the-call pickers and two switches, both on each time. It shows an estimated cost per hour: about $1.23 for the transcript alone, $0.04 more for Jev, and up to $0.35 more for fact-checking.
  - The header chip names what is off.
  - The Fact-check tab, Fast · slow thinking, the Jev log, System 1, and Labels say why they are empty.
  - With labels off, the transcript's marker and subject filters and the timeline's legend give way to "Labels off for this session".
- **Replays** run with both features on unless their start request says otherwise.

## Speaker mode: the echo gate

With earbuds, the microphone never hears the call. When the call plays through the Mac's speakers, the microphone picks it up too, and each guest line used to be transcribed a second time, on the host's stream, as the host's (the host stream is limited to 1 voice). It was also sent to Jev and fact-checked twice.

**Speaker mode** mutes the microphone while the call plays. It never subtracts the echo: Apple's voice processing only cancels audio its own process plays (not Riverside's) and turns every other app down by about 15 dB, and a hand-built echo canceller leaves an echo tail on laptop speakers.

- **When it is on.** Live sessions follow the helper's `remote.outputKind` (see [Capture](#capture--nativecapture-and-srcaudionativesourcets)). It is on for `speakers` and off for anything else, and switches mid-session when the output changes. The engine passes it to `Session.setOutput`, which emits `echo.gate` on each change. Replays never turn it on by themselves.
- **What it does** (`src/audio/echoGate.ts`). A remote frame at or above `echoGate.thresholdDbfs` (−45) marks the call as playing. Every host frame is replaced by silence while the call plays and for `echoGate.holdMs` (250 ms) after, which covers room echo and the speakers' delay. The call reaches the tap before its echo reaches the microphone, and frames are merged in session-time order, so the gate is closed before the echo arrives.
- **It cannot stay stuck on.** It keeps no "muted" flag: each host frame is judged against the time of the last loud call frame, so the microphone is back within `holdMs` whenever the call goes quiet, fails, or its stream ends. It also stays open when a call frame is stamped more than 1 s ahead of the host frame (clocks disagreeing), and it opens at once when the output becomes anything but speakers. The helper reports the new output even when rebuilding the tap for it fails, so a failed rebuild cannot leave speaker mode on after earbuds connect. A device the helper cannot classify counts as not speakers: the microphone stays open.
- **Inactive, it changes nothing.** Every host frame goes through untouched: with earbuds the pipeline, the recorded audio, and every result are what they were before speaker mode existed (tested).
- **What is stored is what was heard.** The muted stretches are silence in `host.wav`, as for Pause, so playback matches the transcript.
- **The cost.** It is half duplex: anything the host says while a guest is talking, and the first quarter-second after a guest stops, is not heard. A guest's "mm-hmm" while the host talks cuts a hole in the host's line, which may split it in two. Earbuds are still the recommended setup, and the page says so.
- **Configuration** (`config/app.json` → `echoGate`). `mode` is `auto` (the default), `always` (every session, replays included, for trying it on a recording made on speakers), or `never`. `thresholdDbfs` and `holdMs` are described above.
- **The page.** A **Speakers** chip next to the stream meters, only while a live session is in speaker mode (just the glyphs below 1180 px). Its info box, on hover or keyboard focus, explains why the microphone is muted and recommends earbuds. The host meter reads "muted · call playing" instead of its level, in orange, and does not turn red for silence while it is muted. The chip is static markup, only shown and hidden, because the meters are rebuilt every second and would close the info box under the pointer.

## Budgets — `src/budget.ts`

One ledger per session, plus the development total read from the recordings folder's `**/*.jsonl` (`sessions/` in development) when the session starts. Every external call runs `assertCanSpend` before and `record` after — live text checks when it opens a connection and at every committed turn — in four buckets (`transcription` — final and live, `jev`, `s2`, `chat`), which drive the `cost` event. `chat` is in the session's total but not in the session cap's count: it has its own cap per recording, `chat.capUsd` ($2), so a chat never stops the pipeline (see [Chat](chat.md)).

- **Session cap** (`budget.sessionCapUsd`, $10) — always enforced. It was $5 until 25 September 2026; raised so a long or busy show never stops mid-air.
- **Development cap** (`budget.devCapUsd`, $3) — the total of `cost_usd` over call rows in `sessions/**/*.jsonl` (including `sessions/deleted-spend.jsonl`, which keeps the spend of deleted recordings), enforced by replays (including `serve --replay`) and `smoke`, not by live sessions or `preflight`. `--allow-over-dev-cap` lifts it. The packaged Mac app never enforces it: it guards a developer's replays, and the app's users have the session cap.
- When a cap is reached, or OpenRouter returns a non-transient 402, `budget.exhausted` is emitted and further calls are refused.

## Configuration — `config/`

`src/config.ts` validates all three files with zod at startup; code never writes to them at runtime. The Mac app ships them inside the app, read-only: changing them means building the app again (see [The Mac app](desktop.md)).

| File | Holds |
| --- | --- |
| `config/app.json` | Server port (`npm run serve` only), budgets, VAD, echo gate (speaker mode), speakers, transcription (final and live), Jev client, segmentation (including `pauseBoundaryMs`, used only without Jev), timeline, System 2, fact-check loop, chat |
| `config/labels.default.json` | The `boundary` question and the host-editable timeline label set |
| `config/factcheck.s1.default.json` | System 1's default question set and thresholds (`s1@1`) |

The API keys are not in `config/`: they come from the environment (`.env`, in development) or `~/Library/Application Support/Conversation Assistant/credentials.json` (see [Setup](setup.md)).

Validation rejects, among others, `minSegmentMs > maxSegmentMs`, a `choice` without criteria or without a `none` / `other…` option, a `score` with fewer than 2 levels, non-snake_case ids, and a System 1 set whose `claim_type` does not have exactly its 7 keys.

## Tests

`npm test` runs offline: `tests/setup.ts` replaces `fetch` with a function that throws, and every client takes its `fetch` (or WebSocket) through its constructor so tests pass fakes. The suite covers audio and VAD on the fixture, speakers, transcription, live text, the Jev client's retry rules, the segmenter, the fact-checker loop and gate, the timeline, stats, the capture adapter (with a fake helper process), the HTTP API, the library, and an end-to-end session with fake services that also checks no API key reaches any file or event. `npm run smoke` and `npm run preflight` are the live checks.

Related: [Setup](setup.md), [Mission](mission.md), [Jev](jev.md), [System 1 and System 2](system1-system2.md), [Transcription](transcription.md), [Speakers](speakers.md), [Recordings](recordings.md), [Chat](chat.md).
