# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
