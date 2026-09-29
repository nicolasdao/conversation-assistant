// Try on a recording: asks Jev a draft label set's questions about the first minutes of a recording, so the host can
// see what the set would draw before using it on air. It reads the recording and writes nothing into its folder.
// See docs/jev.md § label sets.
import type { JevCallMeta } from "../jev/client.ts";
import type { JevResponse, QuestionSet } from "../jev/types.ts";
import type { AppEvent } from "../store/events.ts";
import type { PipelineUtterance, Segment } from "../pipeline/segmenter.ts";
import { deriveLabels, segmentState, type SegmentLabels } from "../pipeline/timeline.ts";
import { labelSetVersion, setQuestions, type LabelSet, type StoryWording } from "./model.ts";

/** At most this many segments per try: about 10 minutes of show, at a cent or less. */
export const TRY_MAX_SEGMENTS = 40;

export interface RecordedSegments {
  /** The recording's segments that start within the first `minutes`, with their lines, oldest first. */
  segments: Segment[];
  /** The recording's own labels for those segments, by segment id (none for a recording made with labels off). */
  own: Map<string, SegmentLabels>;
}

/**
 * A recording's first minutes as the timeline saw them: its closed segments, each with its lines (speakers by their
 * current names), rebuilt from its events. `name` resolves a speaker id to the name the recording shows now.
 */
export function recordedSegments(events: AppEvent[], name: (utteranceId: string, speakerId: string) => string, minutes: number): RecordedSegments {
  const utterances = new Map<string, any>();
  const closed = new Map<string, any>();
  const own = new Map<string, SegmentLabels>();
  for (const e of events) {
    const d = e.data as any;
    if (e.type === "utterance") utterances.set(d.id, d);
    else if (e.type === "segment.closed") closed.set(d.id, d);
    else if (e.type === "segment.labels") own.set(d.segmentId, d);
  }
  const until = minutes * 60_000;
  const segments = [...closed.values()]
    .filter((s) => s.startMs < until)
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, TRY_MAX_SEGMENTS)
    .map((s): Segment => ({
      id: s.id, startMs: s.startMs, endMs: s.endMs, forced: !!s.forced, final: !!s.final,
      utterances: (s.utteranceIds ?? []).map((id: string) => utterances.get(id)).filter(Boolean).map((u: any): PipelineUtterance => ({
        id: u.id, stream: u.stream, startMs: u.startMs, endMs: u.endMs, speakerId: name(u.id, u.speakerId), speakerInferred: false,
        text: u.text ?? "", filler: false, failed: !u.text, tags: u.tags ?? [],
      })),
    }));
  const kept = new Map([...own].filter(([id]) => segments.some((s) => s.id === id)));
  return { segments, own: kept };
}

export interface TryDeps {
  ask(state: unknown, questions: QuestionSet, meta: JevCallMeta): Promise<JevResponse>;
  /** How many segments are asked at once (`jev.segmentConcurrency`). */
  concurrency: number;
  story: StoryWording;
}

/** Asks the set about each segment, a few at a time; a failed call leaves its segment unlabeled. */
export async function tryLabelSet(set: LabelSet, segments: Segment[], deps: TryDeps): Promise<{ labels: SegmentLabels[]; costUsd: number; failed: number }> {
  const questions = setQuestions(set, [], deps.story);
  const version = labelSetVersion(set, [], deps.story);
  const labels: SegmentLabels[] = new Array(segments.length);
  let costUsd = 0;
  let failed = 0;
  let next = 0;
  // the segment's speakers are already names: the state shows them as they are
  const worker = async () => {
    while (next < segments.length) {
      const i = next++;
      const seg = segments[i];
      const state = segmentState(i > 0 ? segments[i - 1] : null, seg, (id) => id);
      try {
        const res = await deps.ask(state, questions, { purpose: "try", segment_id: seg.id, question_set_version: version });
        costUsd += res.usage?.cost ?? 0;
        labels[i] = deriveLabels(seg, res.answers, set, version, []);
      } catch {
        failed++;
        labels[i] = deriveLabels(seg, null, set, version, []);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency, segments.length)) }, worker));
  return { labels, costUsd, failed };
}
