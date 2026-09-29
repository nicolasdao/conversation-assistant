// Recordings made before label sets (before 29 September 2026) stored the old single label set in session.json: a
// `questions` map with the boundary and story inside, and the thresholds, companies, and stories in `config.timeline`.
// Their stats events have the old fixed shape, and their `section.updated` events name the subject. This converts all
// three at the one place recordings are read (src/store/library.ts), so the page only ever sees the new format.
import type { AppEvent } from "../store/events.ts";
import type { SessionStats } from "../pipeline/stats.ts";
import { LABEL_FORMAT, LIMITS, type Category, type LabelSet, type Marker, type Score } from "./model.ts";
import type { IconName } from "../../web/src/icons.ts";

/** How the app showed the old set's labels: names, colours, icons (web/src/timeline.ts before label sets). */
const OPTION: Record<string, [name: string, color: string, group?: string]> = {
  ai_models: ["AI models", "#3f7df0", "AI"], ai_tools: ["AI tools", "#6fa0ff", "AI"], ai_industry: ["AI industry", "#2a58c9", "AI"],
  tech: ["Tech", "#1fa89a"], marketing: ["Marketing", "#d0892a"], personal_life: ["Personal life", "#d9588a"],
  other_topics: ["Other topics", "#8b6fd6"], the_show: ["The show", "#6f7a8c"],
  news: ["News", "#3e8ee0"], analysis: ["Analysis", "#9a7fe0"], personal_story: ["Personal story", "#d9679a"], explainer: ["Explainer", "#2fb39c"],
  banter: ["Banter", "#d99a2b"], transition: ["Transition", "#6a7d98"], other: ["Other", "#4e5b6c"],
};
const LABEL: Record<string, [name: string, short?: string, icon?: IconName]> = {
  subject: ["Subject"], mode: ["Mode"], heat: ["Heat"], hype: ["Hype"],
  disagreement: ["Disagreement", "Disagree", "bolt"], hot_take: ["Hot take", "Hot take", "flame"],
  prediction: ["Prediction", "Prediction", "trend"], recommendation: ["Recommendation", "Recommend", "star"],
  clip_worthy: ["Clip-worthy", "Clip", "scissors"], humour: ["Humour", "Humour", "smile"],
};
/** The old display order of the markers. */
const MARKER_ORDER = ["disagreement", "hot_take", "prediction", "recommendation", "clip_worthy", "humour"];
/** Colours for options the old app had no colour for (a host-edited set). */
const SPARE = ["#3f7df0", "#1fa89a", "#d0892a", "#d9588a", "#8b6fd6", "#6f7a8c", "#2fb39c", "#d99a2b"];

const pretty = (id: string) => {
  const s = id.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** An old-format label set: no `format`, a `questions` map. */
export function isLegacySet(v: unknown): v is { prefix?: string; questions: Record<string, any> } {
  return !!v && typeof v === "object" && !("format" in v) && typeof (v as any).questions === "object" && (v as any).questions !== null;
}

/** The old `config.timeline` block of a recording's session.json. */
export interface LegacyTimeline { noulMarkerThreshold?: number; clipWorthyMin?: number; fadedBelowConfidence?: number; companies?: string[]; stories?: string[] }

/**
 * The new-format set a legacy recording is shown with. Jev's wording comes from the recording itself; names, colours,
 * and icons from how the app showed them. `clip_worthy` (a score then) becomes a marker: the old label rows already
 * list it in `markers` when it scored 3 or more, so it only needs its definition.
 */
export function fromLegacy(old: { prefix?: string; questions: Record<string, any> }, timeline: LegacyTimeline = {}): LabelSet {
  const threshold = timeline.noulMarkerThreshold ?? 0.7;
  const categories: Category[] = [];
  const scores: Score[] = [];
  const markers: Marker[] = [];
  let spare = 0;
  for (const [id, q] of Object.entries(old.questions ?? {})) {
    const [name, short, icon] = LABEL[id] ?? [pretty(id)];
    if (q?.type === "choice" && categories.length < LIMITS.categories) {
      categories.push({
        id, name, instructions: q.instructions,
        options: Object.entries(q.criteria ?? {}).map(([o, description]) => {
          const [oname, color, group] = OPTION[o] ?? [pretty(o), SPARE[spare++ % SPARE.length]];
          return { id: o, name: oname, description: String(description), color, ...(group ? { group } : {}) };
        }),
        ...(id === "subject" ? { index: { name: "Off-topic", description: "time spent on personal life and other topics", options: ["personal_life", "other_topics"] } } : {}),
      });
    } else if (q?.type === "score" && id !== "clip_worthy" && scores.length < LIMITS.scores) {
      const levels = Array.isArray(q.criteria) ? q.criteria.map(String) : [];
      scores.push({ id, name, instructions: q.instructions, levels });
    } else if ((q?.type === "noul" || id === "clip_worthy") && markers.length < LIMITS.markers) {
      markers.push({
        id, name, short: short ?? name.slice(0, 20), icon: icon ?? "pin", instructions: q.instructions,
        ...(q.type === "noul" && q.criteria ? { criteria: q.criteria } : {}),
        threshold, perSpeaker: id === "disagreement", list: ["prediction", "recommendation", "clip_worthy"].includes(id),
      });
    }
  }
  const rank = (id: string) => (MARKER_ORDER.includes(id) ? MARKER_ORDER.indexOf(id) : MARKER_ORDER.length);
  markers.sort((a, b) => rank(a.id) - rank(b.id));
  // the old Off-topic index only exists when its options do
  const subject = categories.find((c) => c.id === "subject");
  if (subject?.index && !subject.index.options.every((o) => subject.options.some((x) => x.id === o))) delete subject.index;
  return {
    format: LABEL_FORMAT, version: 1, id: "recorded", name: "AI podcast", description: "The label set this recording was made with.",
    prefix: old.prefix ?? "", fadedBelowConfidence: timeline.fadedBelowConfidence ?? 0.5, companies: timeline.companies ?? [],
    categories, scores, markers,
  };
}

/** A stats event stored by a legacy recording, in the version 2 shape. */
export function fromLegacyStats(old: any, set: LabelSet): SessionStats {
  if (old?.version === 2) return old;
  const has = (id: string) => set.markers.some((m) => m.id === id);
  const index = set.categories.find((c) => c.index)?.index;
  const listOf = (id: string, items: any[] | undefined) => ({ markerId: id, items: (items ?? []).map((x) => ({ segmentId: x.segmentId, text: x.text ?? "" })) });
  return {
    version: 2,
    index: index ? { name: index.name, description: index.description, share: old?.roganIndex ?? 0 } : null,
    roganIndex: old?.roganIndex ?? 0,
    labelledMs: old?.labelledMs ?? 0,
    categories: [],
    speakers: (old?.speakers ?? []).map((s: any) => ({
      speakerId: s.speakerId, displayName: s.displayName, talkMs: s.talkMs ?? 0,
      markers: has("disagreement") ? { disagreement: s.disagreements ?? 0 } : {},
      scores: set.scores.some((x) => x.id === "hype") ? { hype: s.hype ?? null } : {},
    })),
    lists: [
      ...(has("prediction") ? [listOf("prediction", old?.predictions)] : []),
      ...(has("recommendation") ? [listOf("recommendation", old?.recommendations)] : []),
      ...(has("clip_worthy") ? [listOf("clip_worthy", old?.clips)] : []),
    ],
    factcheck: old?.factcheck,
    cost: old?.cost,
  };
}

/** A legacy recording's stored event, as a new one would read: stats in version 2, sections naming their option. */
export function fromLegacyEvent(e: AppEvent, set: LabelSet): AppEvent {
  if (e.type === "stats") return { ...e, data: fromLegacyStats(e.data, set) as unknown as Record<string, unknown> };
  if (e.type === "section.updated") {
    const sections = ((e.data as any).sections ?? []).map((s: any) =>
      (s.option ? s : { id: s.id, category: "subject", option: s.subject, lane: s.lane, segmentIds: s.segmentIds, startMs: s.startMs, endMs: s.endMs }));
    return { ...e, data: { ...e.data, sections } };
  }
  return e;
}
