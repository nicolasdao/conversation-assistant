# Conversation Assistant

## Table of Contents

<!-- BEGIN toc -->
- [Install](#install)
- [Privacy: what leaves your Mac](#privacy-what-leaves-your-mac)
- [Responsible use](#responsible-use)
- [Develop](#develop)
- [Scripts](#scripts)
- [Using it](#using-it)
- [Documentation](#documentation)
- [Design decisions](#design-decisions)
- [Built with Claude Code](#built-with-claude-code)
- [Releasing](#releasing)
- [Security](#security)
- [License](#license)
- [Versioning](#versioning)
<!-- END toc -->


A Mac app that listens to a remote podcast recording (the host's microphone plus the Mac's system audio), transcribes it live, labels the conversation on a timeline with Jev, and fact-checks claims with a System 1 / System 2 loop.

It exists to demonstrate, live on air, that software should call a decision model like Jev for bounded judgments, with a slower LLM as System 2 that improves it. Start with the [Mission](docs/mission.md), then [Architecture](docs/architecture.md), [Jev](docs/jev.md), and [System 1 and System 2](docs/system1-system2.md).

## Install

For anyone, no terminal needed. It needs a Mac with Apple Silicon and macOS 14.2 or later, and two API accounts with prepaid credit (OpenAI and OpenRouter; the app walks through both).

1. Download `Conversation-Assistant-<version>-arm64.dmg` from the project's [latest GitHub Release](https://github.com/nicolasdao/conversation-assistant/releases/latest). (The first downloadable release is the first one signed with the project's Apple Developer ID; until then, build it with `npm run dist:mac`, below.)
2. Open it and drag **Conversation Assistant** into Applications.
3. Open it from Applications. macOS asks once whether to open an app downloaded from the internet.
4. Paste the two API keys: the app explains how to get each one (create the account, add prepaid credit, create the key) and checks each key before saving it.
5. Click Allow when macOS asks for **Microphone** and **System Audio Recording**. The app asks for both on its first launch, so they never interrupt a show.

It updates itself from GitHub Releases, never during a show. Recordings are kept in `~/Library/Application Support/Conversation Assistant/sessions` (**File → Show Recordings in Finder**), next to the saved keys. See [The Mac app](docs/desktop.md).

## Privacy: what leaves your Mac

Conversation Assistant has no server of its own and collects nothing: no account, no analytics, no telemetry. What leaves your Mac, and where it goes:

| What | Sent to | When |
| --- | --- | --- |
| The conversation's audio, in short clips and a live stream | OpenAI, with your key, for transcription | During a session (never while paused), and again for a replay |
| Transcript lines and the conversation so far | OpenRouter, with your key, for Jev (labels, fact-check flags) and GPT-6 Luna (fact-check research, audits) | During a session with those features on |
| Your chat questions with the transcript | OpenRouter, with your key, to the model you pick | When you ask |
| A check for a new version | GitHub | At launch and every 4 hours, never during a show |

OpenRouter calls ask providers not to keep or train on the data (`data_collection: "deny"`); what OpenAI and OpenRouter do with it is governed by your agreements with them. Recordings, transcripts, and keys stay on your Mac (`~/Library/Application Support/Conversation Assistant/`), and nothing reaches the project's authors. An exported recording goes wherever you send it.

## Responsible use

Conversation Assistant records and transcribes everyone on a call, including the people you are talking to. Many places require the consent of everyone recorded, and some require it to be explicit: tell the people on the call, and get their consent, before you record. You are responsible for how you use the app and its recordings. The fact-checker's verdicts are produced by AI models and can be wrong; treat them as leads to check, not as facts.

## Develop

Requires Node 24, macOS on Apple Silicon, and the Xcode command-line tools (for the Swift capture helper).

```bash
npm install
npm run models                           # Silero VAD + WeSpeaker speaker-embedding models into models/
npm run fixtures                         # a scripted ~78 s test conversation into fixtures/conversation/
npm run build:capture                    # the conversation-capture Swift helper
npm run serve                            # then open http://127.0.0.1:4317
npm run app                              # or: the same, in the Mac app's window
```

The first time, the page asks for two API keys, one from OpenAI and one from OpenRouter, and walks through getting each: create the account, add prepaid credit, create the key, paste it. Each key is checked before it is saved. Keys are saved in `~/Library/Application Support/Conversation Assistant/credentials.json`, readable only by your macOS user and outside the project folder, and shared with the Mac app; the cog menu's **API keys** replaces them later. Developers can set `OPENAI_API_KEY` and `OPENROUTER_API_KEY` in `.env` (see `.env.example`) instead, which wins over the saved file. See [Setup and API keys](docs/setup.md).

## Scripts

| Script | Does |
| --- | --- |
| `npm test` / `npm run typecheck` | Offline tests (no network) and type checks |
| `npm run models` | Downloads the local models |
| `npm run fixtures` | Builds `fixtures/conversation/{host,remote}.wav` and `script.json` with macOS `say` |
| `npm run smoke` | Live checks of transcription, Jev, and System 2 (measured at about $0.05); streaming text is not checked |
| `npm run replay -- --host <wav> --remote <wav> --speed max\|1 [--export <file>]` | Runs WAV files through the pipeline into `sessions/<id>/` |
| `npm run serve [-- --replay <dir> --speed 1\|max]` | The web page and HTTP + SSE API on http://127.0.0.1:4317 |
| `npm run app` | The Mac app from the project folder, in development (see [The Mac app](docs/desktop.md)) |
| `npm run dist:mac` | Builds the Mac app into `out/`: the DMG, and the files updates download (signed with the Developer ID in the keychain, else ad hoc for this Mac only) |
| `npm run build:capture` | Builds the `conversation-capture` Swift helper (microphone + system audio) |
| `npm run capture:test` | Checks the helper and the macOS permissions on this Mac (interactive) |
| `npm run build:web` | Compiles the web page (`npm run serve` and `npm run app` do it first) |
| `npm run build:desktop` | Bundles the Mac app's main process and the engine into `dist/desktop/main.mjs` |
| `npm run preflight` | Pre-show checks (see `docs/rehearsal.md`) |
| `npm run calibrate:boundary -- <labelled.jsonl>` | Precision / recall / F1 of the boundary threshold (offline) |
| `npm run calibrate:speakers -- --host <wav> --remote <wav>` | Speaker count per similarity threshold |

Development runs stop at a $3 total spend (summed from `sessions/**/*.jsonl`); `--allow-over-dev-cap` lifts that cap. The packaged Mac app never applies it.

macOS asks once for **Microphone** and once for **System Audio Recording**. With `npm run serve` or `npm run app`, both are granted to the terminal app that starts it; the packaged Mac app gets its own (System Settings → Privacy & Security). A denied permission delivers silence, which `capture:test` and `preflight` detect.

## Using it

Open Conversation Assistant (or, developing, `npm run serve` and http://127.0.0.1:4317) and press **Start live** (earbuds in), which first asks for the microphone, how many people are on the call, and whether to turn off fact-checking and labels for that show. With both off it is a plain recording with a transcript, about $1.23 an hour, and Jev is never called. The window shows both stream meters, a transcript that streams as people speak, the timeline, fact-check cards, and the verdict tally; the header's **Chat** button (or ⌘K) opens a large chat window that answers questions about the transcript with any of 14 OpenRouter models (GPT-6 Luna by default), live on air or on a recording; the cog at the top right opens Recordings, System 1, Speakers, Labels, Stats, and Log. Every session is saved as a folder (both audio streams included: in the app's Application Support folder, or `sessions/` in development); **Recordings** lists, names, searches, opens, and deletes them; **Export** saves the recording on screen as one `.conversation-recording` file (about 30 MB an hour, into Downloads) to send over WhatsApp or email, and **Import** (or dropping the file on the window) adds one someone shared; and an opened recording can be played back from the timeline at up to 4×. Each recording has its own URL (`/recordings/<id>`, with `?t=` for the playback position), so a reload, or a bookmark in a browser, lands on the same view. Choose how many people are on the call next to the microphone; the Speakers window can suggest merges for duplicate speakers.

Expect about $1.60 per hour of show: roughly $1.00 streaming text, $0.23 final transcripts, $0.04 Jev, and up to $0.35 fact-checking. The per-session cap is `budget.sessionCapUsd` ($10) in `config/app.json`. Chat is extra, pay-as-you-ask (a question about a two-hour episode is about $0.004 on GPT-6 Luna, more on larger models), with its own cap of $2 per recording (`chat.capUsd`). OpenRouter calls send `provider: { data_collection: "deny" }`.

## Documentation

<!-- BEGIN doc-index -->
- [Architecture](docs/architecture.md) — The end-to-end architecture — native capture, the Node engine's pipeline from audio to utterances, transcripts, segments, labels, and fact-checks, the event bus and HTTP/SSE API, the web front end, storage, and budgets.
- [Chat](docs/chat.md) — The chat window — questions about the transcript of the session on screen, live or recorded, to any curated OpenRouter model — how a live chat keeps up with the transcript, storage, cost and its cap, the API, and the page.
- [The Mac app](docs/desktop.md) — The Mac app — Electron running the engine in-process with no server port, the window on the app:// scheme, where the app keeps its files, macOS permissions, quitting and updating around a show, and how the app is built, signed, notarized, and published.
- [Gotchas](docs/gotchas.md) — Verified traps in this project — macOS capture permissions, sherpa-onnx, OpenAI and OpenRouter behaviour, the Electron Mac app, Jev question wording, and test-fixture voices — each with its fix.
- [Jev](docs/jev.md) — What Jev is, how its Decisions API works (question types, answers, confidence, limits, price), and every place this project asks it a question — per utterance, per segment, in the replay gate — with the client's retry and budget rules.
- [Mission](docs/mission.md) — Why Conversation Assistant exists — a live, on-air demonstration that software should call a decision model like Jev for bounded judgments, with a slower LLM as System 2 — and the principles and non-goals that follow from it.
- [Recordings](docs/recordings.md) — Where every session is stored, what each file holds, and how the recordings library lists, names, searches, reopens, plays back, replays, exports, imports, and deletes past sessions.
- [Rehearsal kit](docs/rehearsal.md) — The pre-show checklist, the planted lines to say on air, how to keep a fallback recording, and how to calibrate thresholds on an old episode.
- [Setup and API keys](docs/setup.md) — The two API keys (OpenAI and OpenRouter) — the first-run setup screen that replaces the app until both are set, where keys are stored on the Mac, how each key is checked before it is saved, the setup routes and their gate, and how the command-line tools find the keys.
- [Speakers](docs/speakers.md) — How each utterance gets a speaker from local voice embeddings, voices tied to a stream with a per-stream limit, the 0.65 threshold, merge suggestions with confidence, and how to rename, merge, and calibrate.
- [System 1 and System 2](docs/system1-system2.md) — The fact-checker's System 1 / System 2 architecture — Jev flags claims on every utterance, GPT-6 Luna researches them and audits for misses, and verdicts drive memory questions and gated rewrites that improve System 1 — with every rule, threshold, prompt, and schema.
- [Transcription](docs/transcription.md) — How speech becomes text, in two layers — final per-utterance transcripts from gpt-transcribe, and streaming display text from gpt-live-transcribe — with their triggers, costs, and configuration.
<!-- END doc-index -->

## Design decisions

**The Mac app — decided 27 September 2026.** For people who never open a terminal, the project ships as a Mac app: a DMG downloaded from GitHub Releases, signed with a Developer ID and notarized, which updates itself. It is **Electron**, with the engine running in Electron's main process and the window loading the same web page from a private `app://` scheme, answered in-process: no server and no port (see [The Mac app](docs/desktop.md)).

**Why:**
- A server on a fixed port can find the port taken (4317 is also OpenTelemetry's default), and any program or website on the Mac can reach it. In-process there is nothing to collide with or reach.
- The engine is written for Node, and Electron is the only shell where it runs in-process unchanged. A Swift or Tauri shell would keep Node as a separate process behind a bridge; a Swift rewrite of the engine (about 7,900 lines) was not worth it.
- Chromium is the browser the page was built and tested in. A system web view (WebKit) would have needed a compatibility pass on the page's dialogs, popovers, and downloads.
- A real app gets macOS's Microphone and System Audio Recording permissions under its own name, instead of the terminal's.
- Not the Mac App Store: its sandbox would constrain the system-audio tap, the capture helper, and `afconvert`, for little gain over a notarized download.
- The cost: an app of about 300 MB (a 144 MB DMG), mostly Electron's Chromium, and an Electron upgrade a few times a year.

**Tier 2 capture and front end — decided 24 September 2026.**

**Architecture.** The engine owns everything smart: capture, VAD, speakers, transcription, System 1 and System 2, storage, and the HTTP and SSE API. It is the Node server plus a native capture helper that the server starts as a child process. The front end is a thin client: it only reads `GET /api/state` and `GET /api/events` and posts commands. It could be replaced later, for example by a SwiftUI app, without touching the engine.

**Capture: a native Swift helper, `conversation-capture`.**
- `host`: the MacBook's built-in microphone, chosen explicitly whatever the system default input is.
- `remote`: a Core Audio tap (macOS 14.2+) of everything the Mac plays, on any output device (speakers, wired earbuds, AirPods), including a device switch mid-session. Since 27 September 2026 the tap lists the apps playing sound and follows them, instead of being one global tap: a global tap made other apps hang when they started a microphone (see [Gotchas](docs/gotchas.md#capture-macos)).
- It works whether Riverside runs in Chrome or as the Mac app.

**Front end: a local web page served by the engine**, in plain TypeScript compiled with `tsc` to browser ES modules. No bundler, no UI framework, no new dependencies.

**Show setup assumption.** The host wears earbuds, so the microphone never hears the call. Echo cancellation is out of scope. Riverside's own microphone is also set to the MacBook's built-in mic. Since 27 September 2026, when the call plays through the Mac's speakers anyway, **speaker mode** mutes the microphone while the call plays, so the guests are not transcribed twice (see [Architecture](docs/architecture.md#speaker-mode-the-echo-gate)).

**Why:**
- Browser capture tied the engine to a Chrome tab that had to be re-picked every session and could be closed or throttled.
- AudioTee captures system audio only, not the microphone. One helper that captures both streams gives them a single clock.
- A tap of every app playing sound, rather than one app's output, is independent of the output device and of which Riverside client is used. Notification sounds are handled by the show checklist (Focus mode).
- Chrome's system audio and BlackHole had other risks (see the spec's background notes).
- A local web page needs nothing installed, runs in any browser, and can be shared as a window in Riverside. (Since 27 September 2026 the Mac app shows the same page in its own window, which Riverside shares the same way.)

## Built with Claude Code

This project was designed and built with [Claude Code](https://claude.com/claude-code), and it is meant to be maintained the same way. Everything an agent needs to work on it safely is under source control:

- **`docs/`** holds the project's memory: the [Mission](docs/mission.md) (the compass for every decision), one doc per subsystem, and [Gotchas](docs/gotchas.md), the traps found in production, each with its fix. Every doc declares the source files it covers, and `doc-manifest.json` indexes them, so an agent can find the docs for any file it is about to change.
- **`.claude/skills/`** holds the skills below. In Claude Code, type `/<skill-name>` (for example `/init-context`) or just describe the task; the matching skill loads itself.

A good session starts with `/init-context <what you want to do>`: it loads the mission, the gotchas, and the docs that matter for the task, and nothing else.

| Area | Skills | What they do |
| --- | --- | --- |
| Project memory | `init-context`, `update-doc`, `init-doc`, `refactor-doc`, `init-mission`, `project-memory` | Load the right docs before work; keep them in step with the code after it (`update-doc` after every feature or fix); bootstrap or restructure them; maintain the mission |
| Committing and releasing | `git-commit`, `release-conversation-assistant`, `create-release-skill` | Conventional commits of a session's work; cut a release (see [Releasing](#releasing)); generate a release skill for another project |
| Planning | `init-spec` | Write a `SPEC.md` for a feature, and archive it when done |
| Session control | `open-items`, `session-status`, `go-with-recommendations` | What is still open and what waits on you; a done / left / waiting ledger; carry out the recommendations in dependency order |
| Checking work | `scrutinize`, `second-opinion` | Review and fix the session's own changes with evidence; audit an analysis and fix plan before it is implemented |
| Explaining | `decision-brief`, `unconfuse` | Recast the last answer as a brief to act on, or re-explain it plainly |
| Skill authoring | `happyskills-design` | Design, audit, and update skills like these |

Personal settings (`.claude/settings.local.json`) are git-ignored; nothing in `.claude/` holds a secret.

## Releasing

A release bumps the version in `package.json` (the only place it lives; see [Versioning](#versioning)), adds an entry to [CHANGELOG.md](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com) format, [Semantic Versioning](https://semver.org/)), commits, tags `v<version>`, pushes, and publishes the Mac app as the GitHub Release `v<version>` (the DMG people download, and the files installed copies update from). Nothing is published to npm or deployed to a server.

**With Claude Code**, run:

```
/release-conversation-assistant            # decides the bump from what changed
/release-conversation-assistant minor      # or force patch, minor, or major
/release-conversation-assistant unreleased # record work under [Unreleased] without releasing
```

It does, in order:

1. Brings the docs up to date (`update-doc`) and commits every pending change (`git-commit`), so the tag contains everything.
2. Refuses to continue if anything is still uncommitted.
3. Runs the gates, all offline and free: `npm run typecheck`, `npm test`, `npm run build:web`, `npm run build:desktop`. A failure stops the release.
4. Reads the commits since the last tag (and the session, when it did the work), writes the changelog entry, and picks the bump: new features → minor, fixes only → patch, anything breaking → major.
5. Shows you the version, the bump, and the entry, and waits for your go.
6. Stamps `CHANGELOG.md`, runs `npm version`, commits `chore(release): conversation-assistant v<version>` (only `package.json`, `package-lock.json`, and `CHANGELOG.md`), and creates the annotated tag.
7. Asks again before pushing `master` and that one tag.
8. Asks a third time before publishing the Mac app: it builds it from the tag, checks that it is signed with the Developer ID and notarized, and creates the GitHub Release. It refuses an ad-hoc or unnotarized build, and skips this step while the Developer ID and notary credentials are missing (see [The Mac app](docs/desktop.md#signing-and-notarization)).

**Without Claude Code**, the same steps are plain shell scripts, run from the project root:

```bash
S=.claude/skills/release-conversation-assistant/scripts
sh $S/preflight.sh release          # the working tree must be clean
sh $S/checks.sh                     # typecheck, tests, web build, Mac app bundle
sh $S/release-info.sh               # current version, last tag, commits since it
# edit CHANGELOG.md: move [Unreleased] into "## [x.y.z] - YYYY-MM-DD", leave [Unreleased] empty
sh $S/apply-release.sh x.y.z        # npm version, release commit, tag vx.y.z
sh $S/push.sh x.y.z                 # push master and the tag
sh $S/publish-app.sh x.y.z notes.md # the Mac app, as the GitHub Release (needs the Developer ID, notary credentials, and gh)
```

After a release, installed apps offer the new version within a few hours, or at their next launch; the settings menu (the cog) shows the version. In development, reload the page.

## Security

Report a vulnerability privately (the repository's Security tab, or email), never in a public issue: see [SECURITY.md](SECURITY.md), which also explains how to check that a download is genuine. The only official downloads are this repository's [Releases](https://github.com/nicolasdao/conversation-assistant/releases), signed by **Developer ID Application: Nicolas Dao (UX774V7BK2)** and notarized by Apple, with their SHA-256 checksums in the release notes.

## License

BSD 3-Clause, © 2026 Cloudless Consulting Pty Ltd (nic@cloudlesslabs.com). See [LICENSE](LICENSE); the app shows it, with the version, at the bottom of the settings menu (the cog), and under **Help → License**.

**Third-party software.** The Mac app includes components under their own licenses, listed with their notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (in the app: **Help → Third-Party Notices**), with the full texts in [licenses/](licenses/). One of them is under the GPL-3.0: the prebuilt speech library from sherpa-onnx compiles in eSpeak NG (text-to-speech, which this app does not use); its source is linked there and attached to every release. The speaker-recognition model is the WeSpeaker ResNet34-LM, CC BY 4.0.

**The Claude Code skills** in `.agents/skills/` (and `.claude/skills/`, which links to them) are by their authors named in each `skill.json`, under the license declared there; they help maintain the project and are not part of the app.

**Trademarks.** Conversation Assistant is an independent project. It is not affiliated with, sponsored, or endorsed by Apple, OpenAI, OpenRouter, TypeSafe AI, Riverside, or Meta (WhatsApp). Their names, and names such as macOS, GPT-6 Luna, and Jev (TypeSafe AI's), are trademarks of their owners, used here only to say what the app works with.

## Versioning

The project's version lives in one place: `version` in the root `package.json`. The engine reads it from there (`GET /api/about`; in the Mac app, from the copy inside the app), and the page shows it at the bottom of the settings menu; nothing else in the repository holds a copy (the Mac app build derives its own from it: the copy inside the app, the app's `Info.plist`, and the file names in `out/`). It changes only through a release (see [Releasing](#releasing)).
