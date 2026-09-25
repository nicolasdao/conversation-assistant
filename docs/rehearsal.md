---
description: The pre-show checklist, the planted lines to say on air, how to keep a fallback recording, and how to calibrate thresholds on an old episode.
tags: [show, checklist, rehearsal, calibration, preflight]
source:
  - src/cli/preflight.ts
  - scripts/capture-test.sh
---

# Rehearsal kit

Everything to check before going on air with Podcast Assistant, the lines to plant, and how to calibrate on an old episode.

## The day before

1. `npm run preflight` passes. It checks the models, the capture helper and both macOS permissions, the keys, the config, the OpenRouter credit, one live call per service (about $0.02), and 2 GB of free disk.
2. Record a fallback: run a live rehearsal session (below), stop it, and name it in the **Recordings** tab (for example "Fallback — Ep 12").
3. Check that it works as a fallback: in the Recordings tab, **Open** shows it instantly for free; **Replay** re-runs it through the pipeline at real-time pace (about twice its original cost, because live text streams again). If anything fails on air, stop the live session and use one of the two. See [Recordings](recordings.md).

## Pre-show checklist

- [ ] Everyone wears headphones, and the host wears **earbuds**. The app assumes it: there is no echo handling, so speakers would put the call on the host's microphone as well.
- [ ] Riverside's microphone is set to the **MacBook's built-in mic**, like the capture helper's. If any app opens the AirPods microphone, macOS switches the AirPods to the low-quality call profile.
- [ ] A **Focus mode** is on and other apps are quiet: the system tap captures every sound the Mac plays, notifications included.
- [ ] The **spend cap** is set: `budget.sessionCapUsd` in `config/app.json` (default $5), and a credit limit on the OpenRouter key.
- [ ] **Tonight's stories** are typed in (Labels tab → Stories → Save stories).
- [ ] **Speakers are renamed** as they first speak (click a name in the transcript, or use the Speakers tab). Merge duplicates there (see [Speakers](speakers.md)).
- [ ] The **app window is shared** in Riverside (the page is laid out for 1280 × 720).
- [ ] A **fallback session** was recorded the day before and is named in the Recordings tab.
- [ ] Privacy: OpenRouter calls already send `provider: { data_collection: "deny" }` (`config/app.json`). Podcast audio still goes to OpenAI for transcription.

## Starting the show

```bash
npm run serve        # builds the page, then serves http://127.0.0.1:4317
```

Pick the microphone (default: built-in), press **Start live**, and check that both meters move. A meter turns red when its stream has been silent for more than 10 s. Live text appears about 1.2 s after someone starts speaking; the final line replaces it about 2.5 s after they stop (see [Transcription](transcription.md)). Budget about $1.60 per hour of show.

## Planted lines to say on air

Say each one naturally, in its own sentence, and pause after it.

1. "Honestly, Jev is four hundred and forty-five times cheaper than GPT." → flagged; the verdict should question a vendor figure.
2. "OpenRouter listed Jev on September eighteenth." → a date claim.
3. "Jev is a million times better at this than any chatbot." → hyperbole: System 2 should call it `not_a_claim` (a false alarm that teaches System 1).
4. "According to the launch post, Jev can never hallucinate." → flagged; misleading without context.
5. "GPT-6 Luna costs ten cents per million input tokens." → a price claim.

Later in the show, repeat line 1 word for word. It should produce an instant **repeat** card, linked to the first claim, with no second research.

## Calibration on an old episode

1. Convert each track to 16 kHz mono WAV:
   `afconvert -f WAVE -d LEI16@16000 -c 1 <in> <out>.wav`
   Riverside exports one track per participant: pass the host's track as `--host` and a co-host's track (or a mix of the others) as `--remote`.
2. Speaker threshold (local, free):
   `npm run calibrate:speakers -- --host host.wav --remote remote.wav`
   Pick the threshold that yields the real number of people.
3. Boundary threshold:
   `npm run replay -- --host host.wav --remote remote.wav --speed max --export boundary.jsonl`
   Set `human_boundary` to `true` or `false` on each row (true where a new point or topic starts), then
   `npm run calibrate:boundary -- boundary.jsonl`.
4. Write the chosen values to `config/app.json` (`speakers.threshold`, `segmentation.boundaryThreshold`) and restart the server.

Replays of old episodes count toward the $3 development cap; add `--allow-over-dev-cap` only when you mean to.
