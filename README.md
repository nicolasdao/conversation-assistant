# Tattle

**Website: [hey-tattle.com](https://hey-tattle.com)**

**An open-source Mac app** that transcribes live conversations (your microphone and the call your Mac plays), maps them on a timeline, and fact-checks claims as they're said. On macOS 26 or later it transcribes on the Mac itself, for free, and a transcript-only show sends nothing anywhere.

**[Download for Mac](https://github.com/nicolasdao/tattle/releases/latest)** · Apple Silicon, macOS 14.2 or later · signed and notarized by Apple · updates itself · free and open source ([BSD 3-Clause](LICENSE))

It was built for a podcast recorded over Riverside: the host's microphone plus the Mac's system audio, transcribed live, labelled on a timeline with Jev, and fact-checked with a System 1 / System 2 loop. It exists to demonstrate, live on air, that software should call a decision model like Jev for bounded judgments, with a slower LLM as System 2 that improves it. Start with the [Mission](docs/mission.md), then [Architecture](docs/architecture.md), [Jev](docs/jev.md), and [System 1 and System 2](docs/system1-system2.md).

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
- [Website](#website)
- [Releasing](#releasing)
- [Security](#security)
- [License](#license)
- [Versioning](#versioning)
<!-- END toc -->

## Install

For anyone, no terminal needed. It needs a Mac with Apple Silicon and macOS 14.2 or later.

- **macOS 26 or later:** no API account. Transcription runs on the Mac with Apple Speech, free.
- **macOS 14.2 to 25:** an OpenAI account with prepaid credit, for transcription (the app walks through it).
- **Optional, any macOS:** an OpenRouter account, for fact-checking, labels, and Chat. The app asks for its key when you first turn one of them on.

1. Download `Tattle-<version>-arm64.dmg` from the project's [latest GitHub Release](https://github.com/nicolasdao/tattle/releases/latest).
2. Open it and drag **Tattle** into Applications.
3. Open it from Applications. macOS asks once whether to open an app downloaded from the internet.
4. On macOS 26 or later, the app opens straight away and prepares on-device speech recognition in the background. On older macOS, paste an OpenAI API key: the app explains how to get it (create the account, add prepaid credit, create the key) and checks it before saving it.
5. Click Allow when macOS asks for **Microphone** and **System Audio Recording**. The app asks for both on its first launch, so they never interrupt a show.

**Coming from Conversation Assistant?** It is the same app, renamed, and it updates itself to Tattle: after **Restart Now**, open **Tattle** from Applications (that one update does not reopen the app by itself). Your keys and recordings carry over. If you install the DMG instead, delete `Conversation Assistant.app`.

It updates itself from GitHub Releases, never during a show. Recordings are kept in `~/Library/Application Support/Tattle/sessions` (**File → Show Recordings in Finder**), next to the saved keys. See [The Mac app](docs/desktop.md).

## Privacy: what leaves your Mac

Tattle has no server of its own and collects nothing: no account, no analytics, no telemetry. What leaves your Mac, and where it goes:

| What | Sent to | When |
| --- | --- | --- |
| The conversation's audio, in short clips and a live stream | OpenAI, with your key, for transcription, **only with the OpenAI engine** (Settings → Transcription). With Apple Speech, the default on macOS 26+, audio is transcribed on the Mac and never leaves it | During a session (never while paused), and again for a replay |
| Transcript lines and the conversation so far | OpenRouter, with your key, for Jev (labels, fact-check flags) and GPT-6 Luna (fact-check research, audits) | During a session with those features on |
| Your chat questions with the transcript | OpenRouter, with your key, to the model you pick | When you ask |
| The first 10 minutes of a recording's transcript | OpenRouter, with your key, for Jev | When you **Try on a recording** a label set |
| Your description of the show and the draft label set | OpenRouter, with your key, for GPT-6 Luna | When you use **Create with AI** (Labels) |
| A check for a new version | GitHub | At launch and every 4 hours, never during a show |

OpenRouter calls ask providers not to keep or train on the data (`data_collection: "deny"`); what OpenAI and OpenRouter do with it is governed by your agreements with them. Recordings, transcripts, and keys stay on your Mac (`~/Library/Application Support/Tattle/`), and nothing reaches the project's authors. An exported recording goes wherever you send it.

## Responsible use

Tattle records and transcribes everyone on a call, including the people you are talking to. Many places require the consent of everyone recorded, and some require it to be explicit: tell the people on the call, and get their consent, before you record. You are responsible for how you use the app and its recordings. The fact-checker's verdicts are produced by AI models and can be wrong; treat them as leads to check, not as facts.

## Develop

Requires Node 24, macOS on Apple Silicon, and the Xcode command-line tools (for the Swift helpers; `tattle-transcribe` needs the macOS 26 SDK).

```bash
npm install
npm run models                           # Silero VAD + WeSpeaker speaker-embedding models into models/
npm run fixtures                         # a scripted ~78 s test conversation into fixtures/conversation/
npm run build:capture                    # the tattle-capture Swift helper
npm run build:transcribe                 # the tattle-transcribe Swift helper (on-device transcription, macOS 26+)
npm run serve                            # then open http://127.0.0.1:4317
npm run app                              # or: the same, in the Mac app's window
```

On macOS 26+ with `tattle-transcribe` built, the page asks for no key: it transcribes with Apple Speech. Otherwise the first page asks for an OpenAI key and walks through getting it: create the account, add prepaid credit, create the key, paste it. The OpenRouter key is asked for when fact-checking, labels, or Chat first need it. Each key is checked before it is saved. Keys are saved in `~/Library/Application Support/Tattle/credentials.json`, readable only by your macOS user and outside the project folder, and shared with the Mac app; the cog menu's **API keys** (in the Mac app also **Tattle → Settings…**, ⌘,) replaces them later. Developers can set `OPENAI_API_KEY` and `OPENROUTER_API_KEY` in `.env` (see `.env.example`) instead, which wins over the saved file. See [Setup and API keys](docs/setup.md).

## Scripts

| Script | Does |
| --- | --- |
| `npm test` / `npm run typecheck` | Offline tests (no network) and type checks |
| `npm run test:coverage` | The same tests with coverage; fails below the thresholds in `vitest.config.ts` (see [Testing](docs/testing.md)) |
| `npm run test:e2e` | End-to-end tests of the web page and the Mac app with Playwright (offline) |
| `npm run test:swift` | The capture helper's Swift tests, with a coverage gate on its clock |
| `npm run test:all` | Everything: type checks, coverage, the Swift tests, and the end-to-end tests |
| `npm run models` | Downloads the local models |
| `npm run fixtures` | Builds `fixtures/conversation/{host,remote}.wav` and `script.json` with macOS `say` |
| `npm run smoke` | Live checks of transcription, Jev, and System 2 (measured at about $0.05); streaming text is not checked |
| `npm run replay -- --host <wav> --remote <wav> --speed max\|1 [--engine apple\|openai] [--no-factcheck] [--no-labels] [--export <file>]` | Runs WAV files through the pipeline into `sessions/<id>/` (the saved engine unless `--engine`; free with `--engine apple --no-factcheck --no-labels`) |
| `npm run serve [-- --replay <dir> --speed 1\|max]` | The web page and HTTP + SSE API on http://127.0.0.1:4317 |
| `npm run app` | The Mac app from the project folder, in development (see [The Mac app](docs/desktop.md)) |
| `npm run dist:mac` | Builds the Mac app into `out/`: the DMG, and the files updates download (signed with the Developer ID in the keychain, else ad hoc for this Mac only) |
| `npm run build:capture` | Builds the `tattle-capture` Swift helper (microphone + system audio) |
| `npm run capture:test` | Checks the helper and the macOS permissions on this Mac (interactive) |
| `npm run build:transcribe` | Builds the `tattle-transcribe` Swift helper (on-device transcription with Apple Speech, macOS 26+) |
| `npm run transcribe:test` | Checks it on this Mac: availability, live text, a clip, and word times (needs `npm run fixtures`) |
| `npm run build:web` | Compiles the web page (`npm run serve` and `npm run app` do it first) |
| `npm run build:desktop` | Bundles the Mac app's main process and the engine into `dist/desktop/main.mjs` |
| `npm run preflight` | Pre-show checks (see `docs/rehearsal.md`) |
| `npm run calibrate:boundary -- <labelled.jsonl>` | Precision / recall / F1 of the boundary threshold (offline) |
| `npm run calibrate:speakers -- --host <wav> --remote <wav>` | Speaker count per similarity threshold |

macOS asks once for **Microphone** and once for **System Audio Recording**. With `npm run serve` or `npm run app`, both are granted to the terminal app that starts it; the packaged Mac app gets its own (System Settings → Privacy & Security). A denied permission delivers silence, which `capture:test` and `preflight` detect.

## Using it

Open Tattle (or, developing, `npm run serve` and http://127.0.0.1:4317) and press **Start live** (earbuds in), which first asks for the microphone, how many people are on the call, whether to fact-check, which **label set** the timeline uses (or Off), and tonight's stories. With both off it is a plain recording with a transcript, and Jev is never called: free with Apple Speech (Settings → Transcription → On this Mac, the default on macOS 26+), about $1.23 an hour with OpenAI. The switches start off until an OpenRouter key is set; turning one on asks for it. The window shows both stream meters, a transcript that streams as people speak, the timeline, fact-check cards, and the verdict tally; the header's **Chat** button (or ⌘K) opens a large chat window that answers questions about the transcript with any of 14 OpenRouter models (GPT-6 Luna by default), live on air or on a recording; the cog at the top right opens Recordings, Insights (the show's stats, how the fact-checker did, and the error log), Speakers, Labels (your label sets: what the timeline asks Jev about each stretch of the show, up to 2 categories, 2 scores, and 8 markers; clone the built-in one, edit, share as a `.tattle-labels` file, import, try a draft on a recording, or let GPT-6 Luna draft one with **Create with AI**), and Transcription (Apple Speech on this Mac, or OpenAI). Every session is saved as a folder (both audio streams included: in the app's Application Support folder, or `sessions/` in development); **Recordings** lists, names, searches, opens, and deletes them; **Export** saves the recording on screen as one `.tattle` file (about 30 MB an hour, into Downloads) to send over WhatsApp or email, and **Import** (or dropping the file on the window) adds one someone shared; and an opened recording can be played back from the timeline at up to 4×. Each recording has its own URL (`/recordings/<id>`, with `?t=` for the playback position), so a reload, or a bookmark in a browser, lands on the same view. Choose how many people are on the call next to the microphone; the Speakers window can suggest merges for duplicate speakers.

Expect about $1.60 per hour of show with OpenAI transcription: roughly $1.00 streaming text, $0.23 final transcripts, $0.04 Jev, and up to $0.35 fact-checking. With Apple Speech the transcript is free, so a show costs up to about $0.40, or nothing with fact-checking and labels off. The app sets no spending limit of its own: the header shows what a session spends as it goes, and the credit limit you give your OpenRouter key (the setup screen suggests one) is what stops it. Chat is extra, pay-as-you-ask (a question about a two-hour episode is about $0.004 on GPT-6 Luna, more on larger models). OpenRouter calls send `provider: { data_collection: "deny" }`.

## Documentation

<!-- BEGIN doc-index -->
- [Architecture](docs/architecture.md) — The end-to-end architecture — native capture and the on-device transcription helper, the Node engine's pipeline from audio to utterances, transcripts, segments, labels, and fact-checks, the event bus and HTTP/SSE API, the web front end, storage, and budgets.
- [Chat](docs/chat.md) — The chat window — questions about the transcript of the session on screen, live or recorded, to any curated OpenRouter model — how a live chat keeps up with the transcript, storage, cost, the API, and the page.
- [The Mac app](docs/desktop.md) — The Mac app — Electron running the engine in-process with no server port, the window on the app:// scheme, the menu bar (Settings, Check for Updates, Licenses and Acknowledgements) and its bridge to the page, where the app keeps its files, macOS permissions, quitting and updating around a show, and how the app is built, signed, notarized, and published.
- [Gotchas](docs/gotchas.md) — Verified traps in this project — macOS capture permissions, Apple Speech (SpeechAnalyzer) on-device transcription, sherpa-onnx, OpenAI and OpenRouter behaviour, the Electron Mac app, the website on Cloudflare, Jev question wording, testing (fake timers, real user data, happy-dom, end-to-end isolation), and test-fixture voices — each with its fix.
- [Jev](docs/jev.md) — What Jev is, how its Decisions API works (question types, answers, confidence, limits, price), and every place this project asks it a question — per utterance, per segment, in the replay gate — with the client's retry and budget rules.
- [Mission](docs/mission.md) — Why Tattle exists — a live, on-air demonstration that software should call a decision model like Jev for bounded judgments, with a slower LLM as System 2 — and the principles and non-goals that follow from it.
- [Recordings](docs/recordings.md) — Where every session is stored, what each file holds, and how the recordings library lists, names, searches, reopens, plays back, replays, exports, imports, and deletes past sessions.
- [Rehearsal kit](docs/rehearsal.md) — The pre-show checklist, the planted lines to say on air, how to keep a fallback recording, and how to calibrate thresholds on an old episode.
- [Setup and API keys](docs/setup.md) — The two API keys (OpenAI and OpenRouter), both optional — which one the transcription engine requires, the first-run setup screen (OpenAI only, on Macs that transcribe with OpenAI), the prompts that ask for the OpenRouter key when fact-checking, labels, or Chat need it, where keys are stored on the Mac, how each key is checked before it is saved, the setup routes and their gate, and how the command-line tools find the keys.
- [Speakers](docs/speakers.md) — How each utterance gets a speaker from local voice embeddings, voices tied to a stream with a per-stream limit, the 0.65 threshold, merge suggestions with confidence, and how to rename, merge, and calibrate.
- [System 1 and System 2](docs/system1-system2.md) — The fact-checker's System 1 / System 2 architecture — Jev flags claims on every utterance, GPT-6 Luna researches them and audits for misses, and verdicts drive memory questions and gated rewrites that improve System 1 — with every rule, threshold, prompt, and schema.
- [Testing](docs/testing.md) — How Tattle is tested, test-first — the TDD loop, the test layers and where each test goes, the commands, the shared fakes, DOM tests under happy-dom, the coverage thresholds and their exclusions, and the rules every test follows (offline, no real user data, no spend).
- [Transcription](docs/transcription.md) — How speech becomes text, with two engines — Apple Speech on this Mac (the default on macOS 26+, free, nothing leaves the Mac), with one clip per utterance and live text from stream analyzers, or OpenAI's gpt-transcribe and gpt-live-transcribe — how the engine is chosen and saved, the tattle-transcribe helper, costs, and configuration.
- [Website](docs/website.md) — Tattle's website, hey-tattle.com — what the page contains, its search and link-preview metadata (Open Graph image, icons, robots.txt, sitemap, JSON-LD), how it is hosted on Cloudflare as a static Worker, how pushes to master redeploy it, the domain and redirect, the security headers, and how to preview, deploy, and change it safely.
<!-- END doc-index -->

## Design decisions

**The Mac app — decided 27 September 2026.** For people who never open a terminal, the project ships as a Mac app: a DMG downloaded from GitHub Releases, signed with a Developer ID and notarized, which updates itself. It is **Electron**, with the engine running in Electron's main process and the window loading the same web page from a private `app://` scheme, answered in-process: no server and no port (see [The Mac app](docs/desktop.md)).

**Why:**
- A server on a fixed port can find the port taken (4317 is also OpenTelemetry's default), and any program or website on the Mac can reach it. In-process there is nothing to collide with or reach.
- The engine is written for Node, and Electron is the only shell where it runs in-process unchanged. A Swift or Tauri shell would keep Node as a separate process behind a bridge; a Swift rewrite of the engine (about 7,900 lines) was not worth it.
- Chromium is the browser the page was built and tested in. A system web view (WebKit) would have needed a compatibility pass on the page's dialogs, popovers, and downloads.
- A real app gets macOS's Microphone and System Audio Recording permissions under its own name, instead of the terminal's.
- Not the Mac App Store: its sandbox would constrain the system-audio tap, the capture helper, and `afconvert`, for little gain over a notarized download.
- The cost: an app of about 345 MB (a 146 MB DMG, at 0.6.2), mostly Electron's Chromium, and an Electron upgrade a few times a year.

**Tier 2 capture and front end — decided 24 September 2026.**

**Architecture.** The engine owns everything smart: capture, VAD, speakers, transcription, System 1 and System 2, storage, and the HTTP and SSE API. It is the Node server plus a native capture helper that the server starts as a child process. The front end is a thin client: it only reads `GET /api/state` and `GET /api/events` and posts commands. It could be replaced later, for example by a SwiftUI app, without touching the engine.

**Capture: a native Swift helper, `tattle-capture`.**
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
| Committing and releasing | `git-commit`, `release-tattle`, `create-release-skill` | Conventional commits of a session's work; cut a release (see [Releasing](#releasing)); generate a release skill for another project |
| Planning | `init-spec` | Write a `SPEC.md` for a feature, and archive it when done |
| Session control | `open-items`, `session-status`, `go-with-recommendations` | What is still open and what waits on you; a done / left / waiting ledger; carry out the recommendations in dependency order |
| Checking work | `scrutinize`, `second-opinion` | Review and fix the session's own changes with evidence; audit an analysis and fix plan before it is implemented |
| Explaining | `decision-brief`, `unconfuse` | Recast the last answer as a brief to act on, or re-explain it plainly |
| Skill authoring | `happyskills-design` | Design, audit, and update skills like these |
| Website hosting | `cloudflare`, `cloudflare-config`, `cloudflare-deploy` | Audit the Cloudflare account, change DNS and zone settings, and deploy the website (see [Website](docs/website.md)) |

Personal settings (`.claude/settings.local.json`) are git-ignored; nothing in `.claude/` holds a secret. The Cloudflare skills' API token lives in `secrets/cloudflare.env`, and the whole `secrets/` folder is git-ignored.

## Website

The official website is **[hey-tattle.com](https://hey-tattle.com)** (`www.hey-tattle.com` redirects to it). It is the static page in `website/`, hosted on Cloudflare as the Worker `tattle-website`, and it redeploys by itself about three minutes after any push to `master` that changes `website/`; pushes that only touch the app do not deploy it. Its Download for Mac button links the latest release's DMG: each release writes it into the page (the last step of [Releasing](#releasing)), and the page also reads the newest release from GitHub when it loads. How it is hosted, deployed, secured, and changed: [Website](docs/website.md).

## Releasing

A release bumps the version in `package.json` (the only place it lives; see [Versioning](#versioning)), adds an entry to [CHANGELOG.md](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com) format, [Semantic Versioning](https://semver.org/)), commits and tags `v<version>`, and **deploys it to production**. For this app, production is the GitHub Release: the DMG new users download, and the update every installed copy offers within about 4 hours or at its next launch. There is no server, and nothing goes to npm.

A deployed version is final: GitHub keeps release tags and published releases from ever being moved, replaced, or deleted. A problem found afterwards is fixed with a new version. So the app is built and verified on the Mac **before** anything is pushed.

**With Claude Code**, run:

```
/release-tattle            # decides the bump from what changed
/release-tattle minor      # or force patch, minor, or major
/release-tattle unreleased # record work under [Unreleased] without releasing
```

It does, in order (a summary of the skill's own steps):

1. Runs the whole test suite: type checks, unit tests with coverage thresholds, the capture helper's Swift tests, and the end-to-end tests of the web page and the Mac app (development build, offline); stops if any fails.
2. Brings the docs up to date (`update-doc`) and commits every pending change (`git-commit`), so the tag contains everything.
3. Refuses to continue if anything is still uncommitted; runs the gates (`npm run typecheck`, `npm test`, `npm run build:web`, `npm run build:desktop`, the third-party notices check); and checks that this Mac can deploy: the Developer ID certificate (warning when it nears expiry), the notary credentials, GitHub access.
4. Reads the commits since the last tag (and the session, when it did the work), writes the changelog entry, and picks the bump: new features → minor, fixes only → patch, anything breaking → major.
5. Shows you the version, the bump, and the entry, and waits for your go.
6. Stamps `CHANGELOG.md`, runs `npm version`, commits `chore(release): tattle v<version>` (only `package.json`, `package-lock.json`, and `CHANGELOG.md`), and tags it, **on this Mac only**.
7. Builds and verifies the app, still on this Mac: the locked dependencies (`npm ci`), their registry signatures, no high-severity advisory in what ships, the notices, the build, Apple's notarization, and Gatekeeper. If anything fails, it undoes the local tag and commit, so the same version can be released after the fix.
8. Asks once before **deploying**: it pushes `master` and the tag, and publishes the GitHub Release with the DMG, the update files, an SBOM, the GPL sources, and SHA-256 checksums.
9. Verifies production from the outside: the update feed names the new version, the published DMG is the one that was built, and a downloaded copy passes Gatekeeper.
10. Points the website at the new release: writes its version and DMG link into `website/index.html`, commits that file alone, pushes `master`, and waits until [hey-tattle.com](https://hey-tattle.com) links the new DMG (Cloudflare redeploys the site on the push).

**Without Claude Code**, the same steps are plain shell scripts, run from the project root:

```bash
S=.claude/skills/release-tattle/scripts
sh $S/test-suite.sh                     # unit + coverage, Swift, end-to-end
sh $S/preflight.sh release              # the working tree must be clean
sh $S/checks.sh                         # typecheck, tests, web build, Mac app bundle, notices
sh $S/credentials.sh                    # can this Mac deploy? (certificate, notary credentials, GitHub)
sh $S/release-info.sh                   # current version, last tag, commits since it
# edit CHANGELOG.md: move [Unreleased] into "## [x.y.z] - YYYY-MM-DD", leave [Unreleased] empty
sh $S/apply-release.sh x.y.z            # npm version, release commit, tag vx.y.z (local)
sh $S/build-app.sh x.y.z                # build, notarize, verify (local); if it fails: sh $S/undo-local-release.sh x.y.z
sh $S/deploy.sh x.y.z notes.md          # push, and publish the GitHub Release (final)
sh $S/verify-release.sh x.y.z           # check production from the outside
sh $S/update-website.sh x.y.z           # write the published release into website/index.html
sh $S/deploy-website.sh x.y.z           # commit it, push master, wait until hey-tattle.com links it
```

After a release, installed apps offer the new version within about 4 hours, or at their next launch, and **Tattle → Check for Updates…** finds it at once; **About Tattle** shows the version (in a browser, the settings menu does). In development, reload the page.

## Security

Report a vulnerability privately (the repository's Security tab, or email), never in a public issue: see [SECURITY.md](SECURITY.md), which also explains how to check that a download is genuine. The only official downloads are this repository's [Releases](https://github.com/nicolasdao/tattle/releases), signed by **Developer ID Application: Nicolas Dao (UX774V7BK2)** and notarized by Apple, with their SHA-256 checksums in the release notes.

## License

BSD 3-Clause, © 2026 Cloudless Consulting Pty Ltd (nic@cloudlesslabs.com). See [LICENSE](LICENSE); the app shows it under **Help → Licenses and Acknowledgements** (in a browser, the **Licenses** link at the bottom of the settings menu, the cog), and names it in **About Tattle**.

**Third-party software.** The Mac app includes components under their own licenses, listed with their notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (in the app: **Help → Licenses and Acknowledgements**, with each component's full license text), with the full texts in [licenses/](licenses/). One of them is under the GPL-3.0: the prebuilt speech library from sherpa-onnx compiles in eSpeak NG (text-to-speech, which this app does not use); its source is linked there and attached to every release. The speaker-recognition model is the WeSpeaker ResNet34-LM, CC BY 4.0.

**The Claude Code skills** in `.agents/skills/` (and `.claude/skills/`, which links to them) are by their authors named in each `skill.json`, under the license declared there; they help maintain the project and are not part of the app.

**Trademarks.** Tattle is an independent project. It is not affiliated with, sponsored, or endorsed by Apple, OpenAI, OpenRouter, TypeSafe AI, Riverside, or Meta (WhatsApp). Their names, and names such as macOS, GPT-6 Luna, and Jev (TypeSafe AI's), are trademarks of their owners, used here only to say what the app works with.

## Versioning

The project's version lives in one place: `version` in the root `package.json`. The engine reads it from there (`GET /api/about`; in the Mac app, from the copy inside the app), and the Mac app shows it in **About Tattle** (a browser, at the bottom of the settings menu); nothing else in the repository holds a copy (the Mac app build derives its own from it: the copy inside the app, the app's `Info.plist`, and the file names in `out/`). It changes only through a release (see [Releasing](#releasing)).
