---
description: How each utterance gets a speaker from local voice embeddings, voices tied to a stream with a per-stream limit, the 0.65 threshold, merge suggestions with confidence, and how to rename, merge, and calibrate.
tags: [speakers, diarization, embeddings, calibration, merge-suggestions]
source:
  - src/speakers/registry.ts
  - src/cli/calibrateSpeakers.ts
  - src/speakers/suggest.ts
---

# Speakers

Speakers are identified locally, with no API: `src/speakers/registry.ts` embeds each utterance with WeSpeaker ResNet34-LM (`models/wespeaker_en_voxceleb_resnet34_LM.onnx`, through sherpa-onnx) and compares it with the voiceprints seen so far. There is no pre-registration: an unknown voice becomes `spk_<n>` / "Speaker <n>", and the host renames it.

One `SpeakerRegistry` serves both streams. The host's earbuds keep the `host` stream to one voice in practice, but the registry assumes nothing; the real work is telling co-hosts and guests apart on `remote`.

## Assignment rules

For each utterance, in arrival order:

1. **Long enough to embed** (≥ `speakers.minEmbedSeconds`, 1.5 s): search the known voiceprints at `speakers.threshold`.
   - **Match** → that speaker; the embedding is added to their voiceprint (the last `maxEmbeddingsPerSpeaker`, 20, are kept).
   - **No match, and the stream's current speaker is a placeholder with no voiceprint yet** → the placeholder adopts this embedding.
   - **No match otherwise** → a new speaker.
2. **Too short to embed** → the stream's last speaker, marked `speakerInferred: true`. If the stream has no speaker yet, a **placeholder** speaker is created with no voiceprint.

The placeholder rule fixes a real failure: in a ChatGPT voice-mode test, the first remote reply was "Loud and clear." (0.7 s), which created Speaker 2 without a voiceprint; the same voice's first long reply then matched nothing and became Speaker 3. With adoption, that session yields 2 speakers.

## Voices belong to a stream, and each stream has a limit

- **A voice is matched only within its own stream.** Each speaker belongs to the stream it was first heard on (a merge joins the streams of both), so a line on the host's mic is never matched to a voice from the call: the host wears earbuds, so the mic never hears the call (and on speakers, speaker mode mutes the mic while the call plays; see [Architecture](architecture.md#speaker-mode-the-echo-gate)).
- **Each stream has a voice limit**, `speakers.voicesPerStream` in `config/app.json` (`host` 1, `remote` 2; 0 means no limit). The page's "on call" picker next to the microphone sets the `remote` limit for the session (1–4, or Any), and `session.json` records it as `voices`. Once a stream has that many speakers, a line that matches no one at the threshold goes to the **closest** speaker on that stream, without adding to their voiceprint, instead of creating a new speaker.
- **Matching** is cosine similarity between the line's embedding and each speaker's centroid (the normalised mean of their last 20 unit embeddings).

Why the limit: a threshold alone cannot hold a voice together through a call codec. In a one-hour personal call between two people over a messaging app, the old registry found **13 speakers**: the remote voice flipped between two speakers in runs of 10–15 lines all hour, and laughter and asides on the host's mic made 10 more. `calibrate:speakers` on that recording found 4 speakers even at 0.35, and 52 at 0.75. With the limit (`--voices 1`) it finds **2 at every threshold from 0.35 to 0.75**; with 2 voices allowed on the call it finds 3, because the one remote voice still splits, so set the picker to the real number of people.

## Threshold

`speakers.threshold` is **0.65** (cosine similarity). Measured values:

| Pair | Cosine |
| --- | --- |
| Same real voice (host mic) | 0.76 – 0.90 |
| Same AI voice through system audio (ChatGPT) | 0.83 – 0.95 |
| Host vs ChatGPT | 0.19 – 0.34 |
| Fixture: Samantha vs Daniel (macOS `say`) | 0.63 |
| Fixture: Samantha vs Karen | 0.86 — why the fixture uses Sandy instead of Karen |

0.65 leaves margin under the lowest same-voice score and is the lowest value that still separates the fixture's three voices (`npm run calibrate:speakers` on the fixture gives 3 speakers at 0.65–0.75). Real co-hosts through Riverside's codec may score differently: calibrate on an old episode before the show (see [Rehearsal kit](rehearsal.md)).

`npm run calibrate:speakers -- --host <wav> --remote <wav> [--voices <n>]` runs the VAD and embeddings once and prints the speaker count for thresholds 0.35–0.75: with no `--voices`, what the threshold alone does; with `--voices <n>`, the app's live behaviour (1 voice on the host's mic, `n` on the call). Pick a threshold and write it to `config/app.json`.

## Merge suggestions — `src/speakers/suggest.ts`

The Speakers modal's **Duplicate speakers** panel (`GET /api/speakers/suggestions?voices=<people on the call>`) proposes which speakers are the same person. Nothing merges until the host clicks **Merge** on a row, **Merge high & medium**, or **Merge all** (the last two ask first).

- **Voiceprints.** While a session runs, each speaker's live voiceprint (the centroid the registry matches with). For a recording, recomputed from its audio: up to 30 of each speaker's lines of at least 2 s, not inferred, spread over the session, read clip by clip from the WAVs (about 25 s for a two-hour recording). A speaker belongs to the stream most of their lines are on, since recordings from before voices were tied to a stream can have a few lines matched across streams.
- **Two signals besides the voices.** A name the host gave marks a speaker as acknowledged: it is always kept and preferred as the destination, so nobody has to rename again. And talk time: the real people talk the most, while the duplicates a drifting voice creates talk little.
- **When a stream has more speakers than its expected voices** (1 on the host's mic; the picker's number on the call, by default what the session ran with), the kept speakers are the renamed ones, then the biggest talkers, up to that number. Every other speaker goes to the kept speaker whose voice it matches best — never to another duplicate, and kept speakers are never merged with each other.
- **Otherwise**, pairs within a stream are merged by voice alone, most similar first (re-merging the voiceprints after each), while a pair reaches 0.65; the survivor is the renamed one, else the bigger talker, and chains point at the final survivor ("8 → 9" and "9 → 1" read as "8 → 1" and "9 → 1").
- **Confidence** from the voice match (cosine similarity of the voiceprints): **high** ≥ 0.85, **medium** ≥ 0.75, **low** below; one level higher for a duplicate under 5 % of its stream's talk time. Measured: one voice split by a call codec scored 0.90–0.92 (a podcast recording: a named co-host vs "Speaker 3"); different people 0.55–0.61; one speaker's two halves 0.98–1.00. A speaker with only short lines has no voiceprint and goes to the stream's biggest kept talker.
- Each suggestion's reason names the voice match and the speaker's talk time and share, e.g. "voices match 80 %; Speaker 5 talked 0:36, 1 % of this stream, and it was set for 1 voice".

On a podcast recording it proposes exactly one merge, Speaker 3 → the co-host the host had named (high, 90 %), although Speaker 3 talked 83 % of the call, because the name is what the host gave. On the personal call recorded before voices were tied to streams (13 speakers), with 1 person on the call, it proposes 11 merges that leave exactly the two real people: one high, nine medium (duplicates with 0–1 % of the talk), and one low (a 2:17 speaker whose voice matched only 24 %).

## Rename and merge

- `POST /api/speakers/:id/rename { displayName }` changes the name; later events carry the new name. In the page, click a name in the transcript or use **Speakers** in the settings menu (the cog). Clicking a name in the transcript opens a speaker panel (their lines, talk time, and stream) to rename them, merge them into another speaker ("… is really"), or merge another speaker into them ("… is really <name>"); the merge button names exactly what will happen, so it does not ask again.
- `POST /api/speakers/merge { fromId, intoId }` moves `fromId`'s voiceprint into `intoId` and records `mergedInto`, so every later lookup of `fromId` resolves to `intoId`. The page asks for confirmation first.

Both work on the current session while it runs and after it ends, and on a reopened recording. After the end, the event is still appended to `events.jsonl` and `speakers.json` is rewritten. On a reopened recording, the engine appends the `speaker.updated` or `speaker.merged` event to that recording's `events.jsonl` and applies it to its `speakers.json`, so reopening shows the new names; a recording keeps no voiceprints, so a merge there relabels lines only (see [Recordings](recordings.md)).

Related: [Transcription](transcription.md), [Gotchas](gotchas.md).
