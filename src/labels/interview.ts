// Create with AI's interview checklist: what a label set still needs, computed by code from the draft on screen, never
// by the model. Each turn the model is told what is settled and what to ask next, so a long conversation cannot skip a
// required part; the page shows the same list as progress. See docs/jev.md § label sets.
import { checkLabelSet, LIMITS } from "./model.ts";
import { isFallbackOption } from "../jev/types.ts";

/** The kinds of label the host can decline outright ("no scores"). */
export const KINDS = ["categories", "scores", "markers"] as const;
export type Kind = (typeof KINDS)[number];

export interface ChecklistItem {
  id: string;
  label: string;
  /** todo: required and missing; recommended: optional but worth settling; done; skipped (the host declined it). */
  status: "todo" | "recommended" | "done" | "skipped";
  /** What is missing, in words the model can act on. */
  detail?: string;
}

export interface Checklist {
  items: ChecklistItem[];
  /** The first item still to settle: what the interview should ask about next. */
  next: ChecklistItem | null;
  /** Every required item settled and the draft passes validation: ready to try and save. */
  complete: boolean;
  /** Validation errors of the draft as it stands (a partial draft has some; they are not failures mid-interview). */
  errors: string[];
}

const blank = (v: unknown) => typeof v !== "string" || !v.trim();
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const nameOf = (x: any, fallback: string) => (blank(x?.name) ? fallback : String(x.name).trim());

/** What the draft still needs. `skipped`: the kinds the host said they do not want. */
export function interviewChecklist(draft: unknown, skipped: Iterable<string> = []): Checklist {
  const d = (draft && typeof draft === "object" ? draft : {}) as Record<string, unknown>;
  const skip = new Set(skipped);
  const items: ChecklistItem[] = [];
  const add = (id: string, label: string, status: ChecklistItem["status"], detail?: string) => items.push({ id, label, status, ...(detail ? { detail } : {}) });

  add("show", "What the conversation is", blank(d.description) ? "todo" : "done",
    blank(d.description) ? "Ask what kind of conversation it is and what the host wants to find in it afterwards; sum it up as the description." : undefined);

  const categories = arr(d.categories), scores = arr(d.scores), markers = arr(d.markers);
  const kind = (k: Kind, label: string, list: any[], what: string) => {
    if (list.length) add(k, label, "done");
    else if (skip.has(k)) add(k, label, "skipped");
    else add(k, label, "todo", what);
  };

  kind("categories", `Categories (up to ${LIMITS.categories})`, categories,
    "Ask whether a lane that sorts each stretch into one of a few kinds would help (a topic, a stage, a mode), or if they want none.");
  categories.forEach((c, i) => {
    const n = nameOf(c, `Category ${i + 1}`);
    const opts = arr(c?.options);
    const named = opts.filter((o) => !blank(o?.name) && !blank(o?.description));
    add(`cat${i}.question`, `${n}: its question`, blank(c?.name) || blank(c?.instructions) ? "todo" : "done",
      "It needs a name and one question Jev answers about the segment, like \"What is the current segment mainly about?\".");
    add(`cat${i}.options`, `${n}: its options`, named.length >= 2 ? "done" : "todo",
      named.length >= 2 ? undefined : `It has ${named.length} usable option${named.length === 1 ? "" : "s"}: it needs at least 2, each with a name and a description Jev reads. If the host gave none, propose a list.`);
    const fallback = opts.some((o) => typeof o?.id === "string" && isFallbackOption(o.id));
    add(`cat${i}.fallback`, `${n}: an Other or None option`, fallback ? "done" : "todo",
      fallback ? undefined : "Jev always picks an option, so one must catch everything else: id none, or starting with other.");
  });
  const hasIndex = categories.some((c) => c?.index);
  if (categories.length) add("index", "An index in Insights (optional)", hasIndex ? "done" : skip.has("index") ? "skipped" : "recommended",
    hasIndex ? undefined : "Offer once: some options' share of time shown as one big number (the built-in set's Off-topic). Fine to skip.");

  kind("scores", `Scores (up to ${LIMITS.scores})`, scores, "Ask whether something graded 0 to 4 would help (heat, energy, sentiment), or if they want none.");
  scores.forEach((s, i) => {
    const n = nameOf(s, `Score ${i + 1}`);
    const levels = arr(s?.levels).filter((l) => !blank(l));
    add(`score${i}.question`, `${n}: its question`, blank(s?.name) || blank(s?.instructions) ? "todo" : "done", "It needs a name and one question.");
    add(`score${i}.levels`, `${n}: 5 levels`, levels.length === LIMITS.levels ? "done" : "todo",
      levels.length === LIMITS.levels ? undefined : `It has ${levels.length} of the 5 levels, lowest first. Propose them if the host did not give them.`);
  });

  kind("markers", `Markers (up to ${LIMITS.markers})`, markers, "Ask which moments should get a pin on the timeline (a disagreement, a decision, a question), or if they want none.");
  markers.forEach((m, i) => {
    const n = nameOf(m, `Marker ${i + 1}`);
    add(`marker${i}.question`, `${n}: its question`, blank(m?.name) || blank(m?.instructions) ? "todo" : "done", "It needs a name and a yes/no question.");
    const worded = !blank(m?.criteria?.true) && !blank(m?.criteria?.false);
    add(`marker${i}.wording`, `${n}: yes and no wording`, worded ? "done" : "recommended",
      worded ? undefined : "Propose concrete wording for yes and for no: it makes Jev far more reliable.");
  });

  if (categories.length + scores.length + markers.length === 0 && KINDS.every((k) => skip.has(k))) {
    add("some-label", "At least one label", "todo", "Every kind was declined, but a set needs at least one label: suggest the single most useful one.");
  }
  add("name", "A name for the set", blank(d.name) ? "todo" : "done", blank(d.name) ? "Suggest a short name and ask the host to confirm or change it." : undefined);

  const check = checkLabelSet(draft);
  const errors = check.ok ? [] : check.errors;
  const next = items.find((x) => x.status === "todo") ?? items.find((x) => x.status === "recommended") ?? null;
  return { items, next, complete: check.ok && !items.some((x) => x.status === "todo"), errors };
}

/** The checklist as the model reads it at the end of each message. */
export function checklistText(c: Checklist): string {
  const mark = { done: "[x]", todo: "[ ]", recommended: "[~]", skipped: "[-]" } as const;
  return [
    "Checklist (computed by the app from the current draft; [x] done, [ ] required, [~] recommended, [-] declined):",
    ...c.items.map((x) => `${mark[x.status]} ${x.label}${x.detail && x.status !== "done" ? ` — ${x.detail}` : ""}`),
    c.errors.length ? `The draft does not validate yet: ${c.errors.slice(0, 8).join("; ")}` : "The draft validates.",
    c.next ? `Next to settle: ${c.next.label}.` : c.complete ? "Everything is settled: summarise the set and suggest trying it on a recording, then saving." : "",
  ].filter(Boolean).join("\n");
}
