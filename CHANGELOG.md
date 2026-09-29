# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-09-29

### Added
- Label sets: the timeline's labels are now a set you pick in Start live, with up to 2 categories (lanes), 2 scores (chart lines), and 8 markers (pins with an icon). The built-in AI podcast set asks the same questions as before
- Cog → Labels, a library of label sets: create, clone the built-in one, edit, rename, delete, and share them as `.tattle-labels` files (Export, Import, or drop one on the window). Sets are files on your Mac and need no key
- Try on a recording: see what a draft set would draw on the first 10 minutes of a recording, next to what that recording showed
- Create with AI: GPT-6 Luna interviews you, one question at a time with answers to click, until the set is complete; it proposes what you leave out and explains any rule. You review, edit, and save
- Start live: a Labels picker (your sets, or Off) and a Tonight's stories box
- Insights shows each category's share of time, and every score's average per speaker

### Changed
- The timeline, transcript filters, and Insights follow the session's label set; marker chips (Humour included) scroll on one line, with the speaker and category dropdowns always visible
- Clip-worthy is a yes/no marker, like the others
- Each recording keeps a copy of the set it was made with; recordings made before label sets open as before
- The header shows what a session spends, with no cap

### Removed
- Every spending limit the app set itself: $10 per session, Chat's $2 per recording, and the $3 development cap (with `--allow-over-dev-cap`). The credit limit on your OpenRouter key is the only one
- The Labels window's live question editor, Save stories, and Relabel closed segments: a session's labels are fixed when it starts, and stories are typed in Start live

## [0.9.0] - 2026-09-29

### Added
- Transcription on your Mac with Apple Speech (macOS 26 or later): free, and the audio never leaves the Mac. It is the default for new users on macOS 26; the speech model downloads in the background at first launch, with its progress in the Start live window
- Settings → Transcription (cog menu): choose On this Mac (Apple Speech) or OpenAI, for the next session
- The website, hey-tattle.com: the download, what the app does, and how Jev and the two systems work

### Changed
- API keys are optional: on macOS 26 or later a first run asks for none; on older macOS it asks only for an OpenAI key, for transcription
- The OpenRouter key is asked for when it is needed: turning on fact-checking or labels in Start live, or opening Chat, shows its form in that window. Without it, sessions and replays are transcript-only
- Already using Tattle with an OpenAI key? You keep OpenAI transcription until you switch in Settings → Transcription
- Start live shows the transcript as free with Apple Speech, and starts with fact-checking and labels off when no OpenRouter key is set

## [0.8.0] - 2026-09-28

The first published release since 0.6.2: it also ships everything listed under 0.7.0, which was tagged but never published.

### Changed
- The app is now called **Tattle**: the app, its menus and dialogs, the DMG (`Tattle-<version>-arm64.dmg`), the permission prompts, and the GitHub repository (`nicolasdao/tattle`; the old address redirects)
- Your keys, recordings, and saved preferences move to `~/Library/Application Support/Tattle/` the first time Tattle opens, and macOS keeps its Microphone and System Audio Recording permissions
- Recordings export as `.tattle` files; `.conversation-recording` and `.podcast-recording` files still import
- The capture helper is now `tattle-capture`

## [0.7.0] - 2026-09-28

### Added
- A native Mac app menu: Conversation Assistant → Check for Updates… shows your version and whether a newer one exists, with Download and Install and Release Notes; the download's progress shows on the Dock icon, and nothing is checked or downloaded while a session is on air
- Conversation Assistant → Settings… (⌘,) opens the API keys
- Help → Licenses and Acknowledgements: every license in the app in one searchable window, with each component's notice and full license text (it replaces License, Third-Party Notices, and Chromium Licenses, which opened other apps)

### Changed
- Stats, System 1, and Log are now one Insights window with three tabs: Overview, Fact-checker, and Log (with the error count); the fact-check totals appear once instead of in two windows, and old links to the three windows open the matching tab
- The settings cog is shorter in the Mac app: API keys, the version and license footer, and the Replay-a-folder button (a developer tool) leave it, since the menu bar has them; in a browser the cog keeps them all
- Speakers and Labels are greyed out in the cog when nothing is on air and no recording is open, since there is nothing for them to act on

## [0.6.2] - 2026-09-28

The first published release since 0.6.0: it ships everything listed under 0.6.1, which was tagged but never published because the release checks caught the error fixed below.

### Fixed
- The third-party notices named the Chromium inside the app as "undefined"; they now point to Electron's release notes, which name it exactly
- A release built right after a clean install could miss Electron's own license files; they are now fetched first

## [0.6.1] - 2026-09-28

### Security
- When running `npm run serve`, websites open in your browser can no longer reach the app: every request must come from the app's own page, which stops cross-site requests and DNS rebinding (before, a website could have started a recording). The page also gets a strict content security policy
- A recording file shared with you can no longer fill your disk, break your recordings list, or take over a link: sizes in imported files are checked before use, padding is capped, fact-check source links are web pages only, and imports wait until the show ends
- The Mac app's window refuses browser permissions it never needs (microphone, camera, location), and has no developer tools, so no one can run code with the app's microphone permission
- The capture helper and audio converter no longer receive your API keys, and the chat log is filtered for keys like every other recording file

### Fixed
- The Mac app now includes the licenses of everything it contains, under Help → License, Third-Party Notices, and Chromium Licenses, including the GPL-3.0 notice for eSpeak NG, which is inside the speech library; its exact source is attached to each release
- The About panel says where the third-party notices are

### Changed
- The stats' "Rogan index" is now the Off-topic index (the same measure: the share of the show spent on personal life and other topics)
- The project's repository was recreated without private details in its history; installed copies keep updating from it. Releases now come with SHA-256 checksums, a software bill of materials, and are built only from locked, signature-verified dependencies with no known high-severity vulnerabilities
- New: SECURITY.md (reporting a vulnerability, checking a download is genuine), and README sections on what leaves your Mac, responsible use, and trademarks

## [0.6.0] - 2026-09-27

### Added
- Conversation Assistant is now a Mac app: download the DMG from the latest GitHub Release, drag the app into Applications, and open it. No terminal, Node, or server is needed; the app is signed with a Developer ID and notarized by Apple
- On its first launch the app asks for Microphone and System Audio Recording in its own name, so the questions never interrupt a show; if the microphone was refused, it offers to open System Settings
- The app updates itself from GitHub Releases, and only while nothing is on air; a downloaded update installs when you quit, or at once with Restart Now
- Quitting during a show asks first, then stops the session and keeps the recording; the Mac stays awake while a session runs, and closing the window keeps a show on air
- File → Show Recordings in Finder: the app keeps recordings in ~/Library/Application Support/Conversation Assistant/sessions, next to the saved keys, and saves exports to Downloads

### Changed
- The project now lives in the public repository github.com/nicolasdao/conversation-assistant
- A recording's audio is complete as soon as the session's input ends, instead of after its fact-checks finish (up to 3 minutes later)
- In the Mac app, the import progress bar moves back and forth until the recording is unpacked, since the upload there reports no progress
- For developers: `npm run app` opens the app from the project folder, and `npm run dist:mac` builds the DMG; `npm run serve` is unchanged and keeps its recordings in the project's sessions/

### Security
- The signed app cannot be relaunched as plain Node, with NODE_OPTIONS or --inspect, or with a remote debugging port, so no other program can use its Microphone and System Audio Recording permissions; its window loads only the app's own content

## [0.5.0] - 2026-09-27

### Added
- Add speaker mode: when the call plays through the Mac's speakers, the microphone is muted while the call plays, so guests are no longer transcribed a second time as you. A Speakers chip next to the meters explains it and recommends earbuds; with earbuds nothing changes
- Keep lines that fail to transcribe (a network drop) in the transcript as "Not transcribed yet" and retry them every 15 s; recovered text joins the transcript and the chat, and lines still missing at the end play from their timestamp in the recording

### Changed
- Start live lists microphones connected after the page loaded, preselects the one you used last, and starts People on the call at Any number for each show

### Fixed
- Fix other apps freezing or reporting the microphone as busy when they started recording during a session
- Fix the microphone going silent for the rest of a session after a call app changed the audio setup (a WhatsApp call on Bluetooth earbuds); it now restarts within 1.5 s
- Fix the Start live microphone and People on the call pickers ignoring mouse clicks, which made every session run on the built-in microphone with 2 on the call

## [0.4.0] - 2026-09-27

### Added
- A setup screen on first run that asks for the OpenAI and OpenRouter API keys: two required fields, a short guide for each key (account, prepaid credit, creating the key), a check with each service before saving, and a clear note that keys stay on this Mac. Nothing else loads until both are set
- An API keys window in the settings menu to replace a key; the next call uses it without a restart

### Changed
- The app is now called Conversation Assistant, and its capture helper conversation-capture; macOS may ask again for the Microphone and System Audio Recording permissions
- Recordings export as .conversation-recording files; .podcast-recording files shared earlier still import
- Keys are saved in ~/Library/Application Support/Conversation Assistant/credentials.json, readable only by you; a .env file is now optional, and still wins when present

## [0.3.0] - 2026-09-26

### Added
- A Start live window to choose the microphone, the people on the call, and whether to turn off fact-checking and labels for that session; with both off, a session is a plain recording with a transcript (about $1.23 an hour) that never calls Jev or System 2
- Export a recording as one .podcast-recording file to share over WhatsApp or email, with compressed audio (about 30 MB an hour), the original audio, or none, and your chats only if you choose
- Import a shared recording from the header, the Recordings window, or by dropping the file on the page; rename it on the spot, or import one you already have again as a named copy
- The app version that recorded, and that exported, each recording, shown in the Recordings window

### Changed
- The header shows only what applies to the screen: Export and Import on a recording, Stop only on air, and the microphone and people pickers in Start live

### Fixed
- Header buttons ran off the right edge while recording
- Opening an imported copy while viewing the original kept showing the original
- Starting a session with a name left it stuck and never running

## [0.2.0] - 2026-09-26

### Added
- A Chat window, opened from the header's Chat button or ⌘K, to ask about the transcript of the show on air or any recording, like ChatGPT with the transcript as its only attachment: several saved chats per recording, streaming replies with Stop, edit and regenerate, copy, and cited times that jump to that moment
- On air, each chat question brings every line said since the previous one, so answers cover the show up to the moment you ask
- 14 OpenRouter models to chat with (GPT-6 Luna by default), switchable mid-chat, with a picker that searches and sorts by price or context window
- A token and cost meter in the chat, and chat spend in the header's cost breakdown, with its own $2 cap per recording so it never stops fact-checking

### Changed
- Replace the browser's own dropdowns, tooltips, and autofill with controls styled like the rest of the app

## [0.1.0] - 2026-09-26

### Added
- Live capture of the host's microphone and the Mac's system audio (the call) through a native Swift helper, with both streams recorded for every session
- Speaker identification from local voiceprints, with voices tied to their stream, a "people on the call" limit per session, rename and merge from the transcript, and suggested merges with a confidence score
- Transcription with gpt-transcribe, sent with the conversation's context, plus live streaming text with gpt-live-transcribe
- A timeline labelled by Jev: subjects, modes, heat and hype, and moments such as hot takes, predictions, and clip-worthy segments, from a host-editable label set
- Fact-checking with System 1 (Jev flags checkable public claims on every line) and System 2 (GPT-6 Luna researches them with sources), including repeat recognition, audits for missed claims, and tested rewrites that improve System 1
- The On Air web app: transcript, fact-check cards, a zoomable and resizable timeline, the Fast · slow thinking and Jev log tabs, and settings windows for recordings, speakers, labels, stats, System 1, and the log
- Live session controls to start, pause, resume, and stop, with stream meters and spend against a per-session cap of $10
- A recordings library to open, name, search, replay, play back at up to 4×, and delete past sessions, each with its own URL
- Plain-file session storage, development and session budgets, pre-show checks (`npm run preflight`), live smoke tests, and a rehearsal kit
- The version and the BSD 3-Clause license in the settings menu
