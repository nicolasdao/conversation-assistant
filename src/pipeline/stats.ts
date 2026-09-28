import type { AppConfig } from "../config.ts";
import type { CostTotals } from "../budget.ts";
import type { FactcheckStats } from "../factcheck/s1.ts";
import type { Segment } from "./segmenter.ts";
import type { SegmentLabels } from "./timeline.ts";

export interface SpeakerStat { speakerId: string; displayName: string; talkMs: number; disagreements: number; hype: number | null }

export interface SessionStats {
  /** The Off-topic index: the share of labelled time on personal_life and other_topics. Stored events keep this field name, so recordings made before the rename still show it. */
  roganIndex: number;
  labelledMs: number;
  speakers: SpeakerStat[];
  predictions: { segmentId: string; text: string }[];
  recommendations: { segmentId: string; text: string }[];
  clips: { segmentId: string; clipWorthy: number; text: string }[];
  factcheck: FactcheckStats;
  cost: CostTotals;
}

export interface StatsInput {
  segments: Segment[];
  labels: Map<string, SegmentLabels>;
  resolveSpeaker(id: string): string;
  speakerName(id: string): string;
  factcheck: FactcheckStats;
  cost: CostTotals;
  timeline: AppConfig["timeline"];
}

const OFF_TOPIC = new Set(["personal_life", "other_topics"]);

function segmentText(s: Segment): string {
  return s.utterances.filter((u) => !u.failed).map((u) => u.text).join(" ").trim();
}

/** End-of-show and periodic stats (§4.12). Everything is counted in code. */
export function computeStats(input: StatsInput): SessionStats {
  let labelledMs = 0;
  let offTopicMs = 0;
  const talk = new Map<string, number>();
  const disagreements = new Map<string, number>();
  const hypeSum = new Map<string, { w: number; sum: number }>();
  const predictions: SessionStats["predictions"] = [];
  const recommendations: SessionStats["recommendations"] = [];
  const clips: SessionStats["clips"] = [];

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
    const subject = l.choices.subject?.choice;
    if (subject) {
      labelledMs += dur;
      if (OFF_TOPIC.has(subject)) offTopicMs += dur;
    }
    if (l.markers.includes("disagreement")) for (const id of perSpeaker.keys()) disagreements.set(id, (disagreements.get(id) ?? 0) + 1);
    const hype = l.scores.hype;
    if (typeof hype === "number") {
      for (const [id, ms] of perSpeaker) {
        const h = hypeSum.get(id) ?? { w: 0, sum: 0 };
        h.w += ms;
        h.sum += hype * ms;
        hypeSum.set(id, h);
      }
    }
    const text = segmentText(seg);
    if (l.markers.includes("prediction")) predictions.push({ segmentId: seg.id, text: text.slice(0, 120) });
    if (l.markers.includes("recommendation")) recommendations.push({ segmentId: seg.id, text: text.slice(0, 120) });
    const cw = l.scores.clip_worthy;
    if (typeof cw === "number" && cw >= input.timeline.clipWorthyMin) clips.push({ segmentId: seg.id, clipWorthy: cw, text: text.slice(0, 120) });
  }

  const speakers = [...talk.keys()].map((id) => {
    const h = hypeSum.get(id);
    return {
      speakerId: id, displayName: input.speakerName(id), talkMs: talk.get(id)!, disagreements: disagreements.get(id) ?? 0,
      hype: h && h.w > 0 ? h.sum / h.w : null,
    };
  }).sort((a, b) => b.talkMs - a.talkMs);

  return {
    roganIndex: labelledMs > 0 ? offTopicMs / labelledMs : 0,
    labelledMs, speakers, predictions, recommendations, clips, factcheck: input.factcheck, cost: input.cost,
  };
}
