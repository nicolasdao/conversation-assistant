import type { CostTotals } from "../budget.ts";
import type { FactcheckStats } from "../factcheck/s1.ts";
import type { LabelSet } from "../labels/model.ts";
import type { Segment } from "./segmenter.ts";
import type { SegmentLabels } from "./timeline.ts";

export interface SpeakerStat {
  speakerId: string;
  displayName: string;
  talkMs: number;
  /** Segments with each `perSpeaker` marker that this speaker spoke in. */
  markers: Record<string, number>;
  /** Each score's average over the segments this speaker spoke in, weighted by how long they spoke (null: none). */
  scores: Record<string, number | null>;
}

/** Stats in the shape of the session's label set (version 2; older recordings are converted, see src/labels/legacy.ts). */
export interface SessionStats {
  version: 2;
  /** The set's index (the built-in set's Off-topic): the share of the category's labelled time on its options. */
  index: { name: string; description: string; share: number } | null;
  /** Kept for older pages and the event schema: the index's share, or 0. */
  roganIndex: number;
  /** Time labelled with the first category. */
  labelledMs: number;
  /** Each category's time per option, as a share of that category's labelled time. */
  categories: { id: string; name: string; split: { option: string; ms: number; share: number }[] }[];
  speakers: SpeakerStat[];
  /** One list per marker with `list: true`, in the set's order. */
  lists: { markerId: string; items: { segmentId: string; text: string }[] }[];
  factcheck: FactcheckStats;
  cost: CostTotals;
}

export interface StatsInput {
  segments: Segment[];
  labels: Map<string, SegmentLabels>;
  /** The session's set; null when labels are off. */
  set: LabelSet | null;
  resolveSpeaker(id: string): string;
  speakerName(id: string): string;
  factcheck: FactcheckStats;
  cost: CostTotals;
}

function segmentText(s: Segment): string {
  return s.utterances.filter((u) => !u.failed).map((u) => u.text).join(" ").trim();
}

/** End-of-show and periodic stats. Everything is counted in code. */
export function computeStats(input: StatsInput): SessionStats {
  const set = input.set;
  const categories = set?.categories ?? [];
  const markers = set?.markers ?? [];
  const scores = set?.scores ?? [];
  const perSpeakerMarkers = markers.filter((m) => m.perSpeaker);
  const listed = markers.filter((m) => m.list);

  const talk = new Map<string, number>();
  const catMs = categories.map(() => new Map<string, number>());
  const markerCounts = new Map<string, Record<string, number>>();
  const scoreSums = new Map<string, Record<string, { w: number; sum: number }>>();
  const lists = listed.map((m) => ({ markerId: m.id, items: [] as { segmentId: string; text: string }[] }));

  for (const seg of input.segments) {
    const perSpeaker = new Map<string, number>();
    for (const u of seg.utterances) {
      if (u.failed) continue;
      const id = input.resolveSpeaker(u.speakerId);
      const ms = u.endMs - u.startMs;
      perSpeaker.set(id, (perSpeaker.get(id) ?? 0) + ms);
      talk.set(id, (talk.get(id) ?? 0) + ms);
    }
    const l = input.labels.get(seg.id);
    if (!l || l.unlabeled) continue;
    const dur = seg.endMs - seg.startMs;
    categories.forEach((c, i) => {
      const option = l.choices[c.id]?.choice;
      if (option) catMs[i].set(option, (catMs[i].get(option) ?? 0) + dur);
    });
    for (const m of perSpeakerMarkers) {
      if (!l.markers.includes(m.id)) continue;
      for (const id of perSpeaker.keys()) {
        const counts = markerCounts.get(id) ?? {};
        counts[m.id] = (counts[m.id] ?? 0) + 1;
        markerCounts.set(id, counts);
      }
    }
    for (const s of scores) {
      const v = l.scores[s.id];
      if (typeof v !== "number") continue;
      for (const [id, ms] of perSpeaker) {
        const sums = scoreSums.get(id) ?? {};
        const acc = sums[s.id] ?? { w: 0, sum: 0 };
        acc.w += ms;
        acc.sum += v * ms;
        sums[s.id] = acc;
        scoreSums.set(id, sums);
      }
    }
    const text = segmentText(seg);
    listed.forEach((m, i) => { if (l.markers.includes(m.id)) lists[i].items.push({ segmentId: seg.id, text: text.slice(0, 120) }); });
  }

  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const split = categories.map((c, i) => {
    const t = total(catMs[i]);
    return {
      id: c.id, name: c.name,
      split: c.options.filter((o) => catMs[i].has(o.id)).map((o) => ({ option: o.id, ms: catMs[i].get(o.id)!, share: t > 0 ? catMs[i].get(o.id)! / t : 0 })),
    };
  });

  let index: SessionStats["index"] = null;
  const ci = categories.findIndex((c) => c.index);
  if (ci >= 0) {
    const c = categories[ci];
    const t = total(catMs[ci]);
    const on = c.index!.options.reduce((n, o) => n + (catMs[ci].get(o) ?? 0), 0);
    index = { name: c.index!.name, description: c.index!.description, share: t > 0 ? on / t : 0 };
  }

  const speakers = [...talk.keys()].map((id): SpeakerStat => {
    const counts = markerCounts.get(id) ?? {};
    const sums = scoreSums.get(id) ?? {};
    return {
      speakerId: id, displayName: input.speakerName(id), talkMs: talk.get(id)!,
      markers: Object.fromEntries(perSpeakerMarkers.map((m) => [m.id, counts[m.id] ?? 0])),
      scores: Object.fromEntries(scores.map((s) => [s.id, sums[s.id] && sums[s.id].w > 0 ? sums[s.id].sum / sums[s.id].w : null])),
    };
  }).sort((a, b) => b.talkMs - a.talkMs);

  return {
    version: 2, index, roganIndex: index?.share ?? 0, labelledMs: categories.length ? total(catMs[0]) : 0,
    categories: split, speakers, lists, factcheck: input.factcheck, cost: input.cost,
  };
}
