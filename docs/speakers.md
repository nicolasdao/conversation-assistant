---
description: How each utterance gets a speaker from local voice embeddings, why the threshold is 0.65, how short utterances are handled, and how to rename, merge, and calibrate.
tags: [speakers, diarization, embeddings, calibration]
source:
  - src/speakers/registry.ts
  - src/cli/calibrateSpeakers.ts
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

`npm run calibrate:speakers -- --host <wav> --remote <wav>` runs the VAD and embeddings once and prints the speaker count for thresholds 0.35–0.75; pick the one that yields the real number of people and write it to `config/app.json`.

## Rename and merge

- `POST /api/speakers/:id/rename { displayName }` changes the name; later events carry the new name. In the page, click a name in the transcript or use **Speakers** in the settings menu (the cog).
- `POST /api/speakers/merge { fromId, intoId }` moves `fromId`'s voiceprint into `intoId` and records `mergedInto`, so every later lookup of `fromId` resolves to `intoId`. The page asks for confirmation first.

Both work on the current session while it runs and after it ends, and on a reopened recording. After the end, the event is still appended to `events.jsonl` and `speakers.json` is rewritten. On a reopened recording, the engine appends the `speaker.updated` or `speaker.merged` event to that recording's `events.jsonl` and applies it to its `speakers.json`, so reopening shows the new names; a recording keeps no voiceprints, so a merge there relabels lines only (see [Recordings](recordings.md)).

Related: [Transcription](transcription.md), [Gotchas](gotchas.md).
