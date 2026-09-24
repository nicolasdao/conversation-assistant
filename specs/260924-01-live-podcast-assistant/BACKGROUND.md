# Background for SPEC.md: why the design looks like this

Read this only if you want the history behind a decision. You do not need it to do the work in SPEC.md. Skip it on first pass.

## Why the demo exists

The host co-presents an AI podcast with two friends, who join remotely through Riverside.

The segment is about Jev, TypeSafe AI's "System One" decision model. The host's angle:

- Jev does not compete with chat LLMs, and ordinary users gain nothing from it directly.
- Jev is a developer primitive. It turns text into typed judgments that software composes.
- Its value reaches people when developers embed it in products.

The demo shows this on the show itself:

- Before Jev, the choice was hand-built classifiers (slow to build, brittle) or an LLM call per sentence (slow, and dollars an hour).
- With Jev, about two thousand typed judgments an hour cost cents, at roughly 0.4 s each.
- A slower LLM, System 2, is called only when System 1 finds something worth checking, and it improves System 1 by rewriting its questions.

## Rejected alternatives

| Alternative | Why it was rejected |
| --- | --- |
| Asking "when did we talk about X?" over the finished transcript | A single LLM call over a 12,000-token transcript answers well in seconds for cents. It would make Jev look pointless and undercut the segment's thesis. |
| Chunking every 10 s | Cuts ideas and words in half. Pauses fix the word problem; a Jev boundary question fixes the idea problem. |
| Asking Jev "is this a complete idea?" | Too vague. Jev reads questions literally, so a comparison ("does the new utterance move to a new point?") is concrete. |
| An LLM writing the labels before each show | The user preferred fixed, host-editable labels: stable across episodes and one less live dependency. |
| Fact-checking at segment close | Cards would arrive up to 90 s later than necessary. Claims are sentence-level, and their questions share the per-utterance request anyway. |
| Browser VAD (`@ricky0123/vad-web`) | Ties the pipeline to a browser. Capture is undecided, so VAD runs on the server with the same Silero model. |
| OpenAI `gpt-4o-transcribe-diarize` with known-speaker clips | Files only, at most 4 reference speakers, clips of 2–10 s re-sent with every request (bandwidth next to Riverside's upload), and no vocabulary hints. The user wanted automatic "Speaker N" enrolment with live renaming, which local embeddings do. |
| OpenAI realtime transcription (`gpt-live-transcribe`) | It supports no server VAD or semantic VAD and requires manual commits. It returns no timestamps, speaker labels, or confidence. Per-utterance files are simpler and testable. |
| TypeSafe's direct Jev API | Needs a separate key. OpenRouter's Decisions API measured 0 failures in 10,120 calls from this Mac. The direct API stays the fallback if smoke check 4 fails. |
| The flex endpoint for System 2 | jev-xp measured a median of 39 s and up to about 400 s. Live cards need the standard endpoint. |

## How the feedback loop makes System 1 improve

Jev's weights never change. System 1 is Jev plus its questions and thresholds, and System 2 improves it by rewriting them:

- **Memory:** a checked claim becomes a `known_` question, so a repeat is caught instantly.
- **Criteria:** false alarms, such as hyperbole flagged as a claim, and misses found by audits lead to rewritten instructions.
- **Attention:** questions that prioritise kinds of claims that turned out to matter.

Each research verdict also grades the flag that triggered it. That grade is the outcome signal. The live-timeline feature has no such signal, which is why the host, not an LLM, is System 2 for the timeline.

## Measured numbers behind the defaults (24 September 2026)

| Measurement | Value | Source |
| --- | --- | --- |
| Jev through OpenRouter from this Mac | 10,120 calls, 0 failures, 1 retry; p50 415 ms, p90 599 ms, p95 838 ms, p99 2.1 s, max 19.8 s | jev-xp `runs/**/ledger.jsonl`, `kind: "jev_call"` |
| Jev price | $0.042 per million input tokens, output free | OpenRouter endpoint listing |
| Jev calibration (Banking77) | 96.3% accuracy at confidence ≥ 0.99 (58% of inputs); 85% of errors had confidence below 0.90 | OpenRouter's Jev versus Opus 5 post |
| GPT-6 Luna, 31 calls, medium effort, flex endpoint, 35,000-token prompts | median 39 s, max 407 s | jev-xp ledgers, `kind: "s2_call"` |
| GPT-6 Luna price | $0.10 / $0.50 per million input / output tokens, standard endpoint | OpenRouter endpoint listing |
| gpt-transcribe price | $0.0045 per audio minute | OpenAI model page |
| One-hour show, estimated | about 900 utterance requests plus 80 segment requests to Jev (about $0.15), 20–40 research calls, about $0.27 of transcription | Design session arithmetic |

## Capture research

- Chrome shares a tab's audio through `getDisplayMedia`. Chrome 141 and later can also share full system audio on macOS 14.2+ when sharing a window or screen.
- Core Audio process taps (macOS 14.2+) capture one app's output without a driver. AudioTee wraps them as a command-line tool that writes mono PCM to stdout, with process filters and a configurable sample rate. It needs the System Audio Recording permission.
- Riverside supports Chrome and Edge, and offers a Mac app. Its Mac-app recordings differ slightly from browser recordings (raw tracks only).
- OpenAI's diarization model runs only on uploaded files.

Sources: see SPEC.md §10.
