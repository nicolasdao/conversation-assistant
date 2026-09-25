---
description: Why Podcast Assistant exists — a live, on-air demonstration that software should call a decision model like Jev for bounded judgments, with a slower LLM as System 2 — and the principles and non-goals that follow from it.
tags: [mission, purpose, principles, non-goals]
---

# Mission

## Why this exists

The host co-presents an AI podcast with two friends, who join remotely through Riverside. Podcast Assistant listens to a live recording — the host's microphone and the Mac's system audio, which carries the call — and, while the show is on air:

- transcribes it, with every voice identified as a speaker the host can name;
- lays the conversation out on a timeline of topics, modes, heat, hype, disagreements, hot takes, predictions, recommendations, and clip-worthy moments;
- fact-checks claims as they are said, with sourced verdicts on screen within seconds.

The host demonstrates it live, on the show, during a segment about **Jev**, TypeSafe AI's decision model.

## The thesis it demonstrates

Jev does not compete with chat LLMs, and ordinary users gain nothing from it directly. It is a **developer primitive**: it turns text into typed judgments that software composes. Its value reaches people when developers build it into products — as this app does.

Before Jev, a live app like this had two options: hand-built classifiers (slow to build, brittle) or an LLM call per sentence (slow, and dollars an hour). With Jev, the app makes about two thousand typed judgments an hour for cents, at roughly 0.4 s each. An LLM — **System 2** — is called only when **System 1** (Jev plus its questions) finds something worth checking, and System 2 makes System 1 better by rewriting its questions. See [Jev](jev.md) and [System 1 and System 2](system1-system2.md).

The project will be open-sourced (MIT) as a reference for that pattern.

## Principles

- **Software calls the model for bounded judgments; the model does not behave like a program.** Every Jev question is one narrow, typed judgment. Code turns the answers into segments, flags, markers, and sections.
- **Code does what code does exactly.** Timestamps, counting, arithmetic, company mentions, and speaker identity are computed, never asked of a model. Jev's state holds display names, text, and tags only.
- **Improve with an outcome signal, or leave it to the host.** Fact-check verdicts grade System 1's flags, so System 2 may rewrite System 1 — only through a fixed set of operations, and only after a replay gate shows the rewrite fixes errors while keeping at least 90% of the good flags. The timeline has no such signal, so its labels are a host-editable config that no LLM writes or changes.
- **The engine owns capture and intelligence; the front end is only an interface.** Capture must not depend on a browser tab.
- **Reliability matters as much as features on air.** Short timeouts with fallbacks on every live call, spend caps, every session recorded so it can be reopened exactly as it was (or its audio replayed), and a rehearsal kit with a recorded fallback (see [Rehearsal kit](rehearsal.md)).
- **Plain files, no database.** One folder per session, append-only and readable (see [Recordings](recordings.md)).
- **Keys never leave `.env`.** They never appear in logs, session files, or events; OpenRouter calls deny provider data collection.

## Non-goals

- Answering questions about the transcript after the fact: an LLM already does that well, and it would undercut the thesis. "When did we talk about X?" is a filter over existing labels.
- An LLM writing or changing timeline labels, or a live System 2 on the timeline.
- Fixed-interval chunking of audio.
- Using Jev for anything code does exactly.
- OpenAI diarization: its speaker labels are scoped to one request.
- Multi-language support, video, clip export, social posting, cloud deployment, or authentication (the server binds to 127.0.0.1).
- Integration with Riverside beyond reading exported tracks for calibration.
- Echo cancellation: the host wears earbuds.
- Per-app audio filtering: the tap captures all system output.
- Model training, beyond speaker enrolment.

Related: [Architecture](architecture.md).
