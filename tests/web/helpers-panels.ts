// Builders for the DOM tests of panels, timeline, player, and the label-set windows (Phase 8). The generic helpers
// (loadIndexHtml, installBrowserStubs, makeFakeApi, feed…) are in helpers.ts.
import { readFileSync } from "node:fs";
import type { Labels, LabelSet } from "../../web/src/state.ts";

/** The built-in label set (config/labels/ai-podcast.json): subject + mode, heat + hype, six markers. A fresh copy. */
export function aiSet(): LabelSet {
  return JSON.parse(readFileSync("config/labels/ai-podcast.json", "utf8")) as LabelSet;
}

/** A small set with one category, one score, and one marker, for tests that need something other than the built-in. */
export function tinySet(over: Partial<LabelSet> = {}): LabelSet {
  return {
    format: "tattle-labels", version: 1, id: "tiny", name: "Tiny", description: "A tiny set", prefix: "", fadedBelowConfidence: 0.5, companies: [],
    categories: [{ id: "topic", name: "Topic", instructions: "What about?", options: [
      { id: "a", name: "Alpha", description: "a", color: "#111111" },
      { id: "b", name: "Beta", description: "b", color: "#222222" },
      { id: "none", name: "None", description: "none", color: "#333333" },
    ] }],
    scores: [{ id: "energy", name: "Energy", instructions: "How lively?", levels: ["0", "1", "2", "3", "4"] }],
    markers: [{ id: "joke", name: "Joke", short: "Joke", icon: "smile", instructions: "A joke?", threshold: 0.7, perSpeaker: false, list: false }],
    ...over,
  };
}

/** A segment's labels: choices given as `{ subject: ["ai_models", 0.8] }` (faded when the third item is true). */
export function labels(segmentId: string, o: {
  choices?: Record<string, [string, number, boolean?]>; scores?: Record<string, number>; markers?: string[]; mentions?: string[];
  unlabeled?: boolean; story?: string | null; lane?: string | null;
} = {}): Labels {
  const choices: Labels["choices"] = {};
  for (const [k, [choice, confidence, faded]] of Object.entries(o.choices ?? {})) choices[k] = { choice, confidence, faded: !!faded };
  return {
    segmentId, labelSetVersion: "v1", unlabeled: !!o.unlabeled, choices, nouls: {}, scores: o.scores ?? {}, markers: o.markers ?? [],
    mentions: o.mentions ?? [], lane: o.lane ?? null, story: o.story ?? null,
  };
}

/** An `utterance` event's data. */
export function utt(id: string, startMs: number, endMs: number, speakerId: string, o: { stream?: "host" | "remote"; text?: string; tags?: string[]; filler?: boolean; speakerInferred?: boolean } = {}) {
  return { id, stream: o.stream ?? "host", startMs, endMs, speakerId, text: o.text ?? `line ${id}`, tags: o.tags ?? [], filler: o.filler, speakerInferred: o.speakerInferred };
}

/** A `segment.closed` event's data. */
export function seg(id: string, startMs: number, endMs: number, utteranceIds: string[]) {
  return { id, startMs, endMs, forced: false, final: true, utteranceIds };
}

/** A GET /api/state snapshot with a session (live and running unless overridden) and a label set. */
export function snapshot(session: Record<string, unknown> = {}, set: LabelSet | null = aiSet()) {
  return {
    session: { id: "s1", mode: "live", status: "running", streams: ["host", "remote"], ...session },
    labels: { set, stories: [], version: "v1" },
  };
}
