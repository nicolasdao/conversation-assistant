// Create with AI, as an interview: GPT-6 Luna (one fixed model, `labelsAssist` in config/app.json) asks the host one
// question at a time until a label set is fully configured, proposing options, levels, wording, and thresholds where the
// host gives none, and explaining anything asked. Code, not the model, decides what is still missing (interview.ts):
// each message carries the checklist computed from the draft on screen. The model drafts; the host reviews, edits, and
// saves; it never saves or changes a set, and never runs on the timeline (docs/mission.md).
import type { AppConfig } from "../config.ts";
import type { Budget } from "../budget.ts";
import { backoffMs, classifyError, effectiveStatus, HttpError, parseRetryAfter } from "../jev/client.ts";
import { CHAT_URL } from "../factcheck/s2.ts";
import { ICONS } from "../../web/src/icons.ts";
import { checkLabelSet, LABEL_FORMAT, LIMITS, type LabelSet } from "./model.ts";
import { checklistText, interviewChecklist, type Checklist } from "./interview.ts";

export interface AssistMessage { role: "user" | "assistant"; content: string }
export interface AssistResult {
  /** What the model says: an acknowledgement, an explanation, what is missing. */
  reply: string;
  /** The one next question ("" when the set is complete). */
  question: string;
  /** Up to 4 short answers the host can click. */
  choices: string[];
  /** The draft so far, possibly incomplete; null before anything is known. */
  set: LabelSet | null;
  /** What the host has declined so far (this turn's included). */
  skipped: string[];
  checklist: Checklist;
  costUsd: number;
  error?: string;
}

/** The 12 colours the editor offers (web/src/labels.ts PALETTE). */
const PALETTE = ["#3f7df0", "#6fa0ff", "#2a58c9", "#1fa89a", "#2fb39c", "#d0892a", "#d99a2b", "#d9588a", "#d9679a", "#8b6fd6", "#9a7fe0", "#6f7a8c"];
const SKIPPABLE = ["categories", "scores", "markers", "index"];

const nullable = (schema: object) => ({ anyOf: [{ type: "null" }, schema] });
const obj = (properties: Record<string, object>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: "string" };

/** The reply's strict schema. Optional fields are nullable (strict mode wants every field); limits are checked by code. */
export const ASSIST_JSON_SCHEMA = obj({
  reply: str,
  question: str,
  choices: { type: "array", items: str },
  skip: { type: "array", items: { type: "string", enum: SKIPPABLE } },
  set: nullable(obj({
    name: str, description: str, prefix: str, fadedBelowConfidence: { type: "number" }, companies: { type: "array", items: str },
    categories: {
      type: "array", items: obj({
        id: str, name: str, instructions: str,
        options: { type: "array", items: obj({ id: str, name: str, description: str, color: str, group: { type: ["string", "null"] } }) },
        index: nullable(obj({ name: str, description: str, options: { type: "array", items: str } })),
      }),
    },
    scores: { type: "array", items: obj({ id: str, name: str, instructions: str, levels: { type: "array", items: str } }) },
    markers: {
      type: "array", items: obj({
        id: str, name: str, short: str, icon: { type: "string", enum: [...ICONS] }, instructions: str,
        criteria: nullable(obj({ true: str, false: str })), threshold: { type: "number" }, perSpeaker: { type: "boolean" }, list: { type: "boolean" },
      }),
    },
  })),
});

/**
 * Everything the interviewer knows: what a label set is and how each part shows in the app, every limit and default and
 * why it exists, how Jev reads questions, how to run the interview, and the built-in set as a worked example.
 */
export function assistSystemPrompt(example: LabelSet): string {
  const { builtIn: _b, id: _i, format: _f, version: _v, ...shown } = example;
  return [
    "You are the label-set interviewer in Tattle, a Mac app that records a live conversation (a podcast, a call, a meeting), transcribes it, and cuts it into segments of 12 to 75 seconds. For each closed segment the app asks Jev, TypeSafe's fast decision model, a fixed set of typed questions and draws the answers on a timeline. The questions come from a label set. You interview the host, one question at a time, until their label set is fully configured. You draft; the host reviews, edits, and saves in the editor beside this chat. Never claim to have saved anything, and never ask the host to write JSON.",
    "",
    "## What a label set is",
    "A label set has a name, a description, and up to three kinds of label. Words: the whole thing is a label set; each category, score, or marker is a label.",
    `- A category (at most ${LIMITS.categories}) is a choice: Jev picks exactly one option for each segment. It draws a lane on the timeline, coloured by option, and a dropdown filter under the transcript. The first category also draws the section brackets (runs of segments with the same option). Each option has an id, a short name, a description (the criterion Jev reads: say when this option fits), a colour, and an optional group (options in the same group are offered together in the filter, like “AI (all)”). A category has 2 to ${LIMITS.options} options that do not overlap, one of them a fallback that catches everything else (id none, or starting with other), because Jev always picks one. Options: 3 to 8 is usually right.`,
    "- One category may have an index: some of its options whose share of time is shown as one big percentage in Insights (the built-in set's Off-topic: personal life and other topics). Optional.",
    `- A score (at most ${LIMITS.scores}) is graded on exactly ${LIMITS.levels} levels, lowest first, each a few words (Calm, Lively, Animated, Heated, Very heated). Jev returns a value from 0 to 4; the app draws it as a line on the chart (the first score in orange, the second in yellow) and averages it per speaker in Insights. Always 5 levels, so every score shares the chart's 0–4 axis.`,
    `- A marker (at most ${LIMITS.markers}) is a yes/no question. Jev returns the probability of yes; when it reaches the marker's threshold, the segment gets a pin with the marker's icon on the timeline, a chip under the transcript, and its icon in the transcript. Options: perSpeaker counts it for each speaker who spoke in that segment (in Insights); list lists each such segment in Insights, each entry jumping to it. A marker has a name, a short name for the legend (up to 20 characters), an icon, a question, optional yes and no wording (criteria), and a threshold.`,
    "- Also: a prefix put before every question (keep “Judge only segment; previous_segment is context only.”), fadedBelowConfidence (choices Jev is less sure of are drawn faded; 0.5), and companies (names the app spots in each segment by itself, as whole words; optional).",
    "At least one label is required; everything else can be empty. Ids are snake_case, unique across the whole set; story and boundary are reserved (the app adds a story question from tonight's headlines, and a locked question decides where segments end: neither is part of a set).",
    "",
    "## Why the rules are what they are (explain these when asked)",
    "- Jev answers each question on its own, against the segment only, and cannot see its other answers: so one narrow judgment per question.",
    "- Jev reads literally. Concrete yes and no wording makes markers far more reliable: a question worded only vaguely scored an exact repeat 0.55, and with concrete wording about 0.86.",
    "- The threshold is the yes probability at which a marker shows. 0.7 is a good start; higher (0.8–0.9) shows fewer, surer pins; lower (0.5–0.6) catches more but with more false ones. An answer that hovers around the threshold makes the pin come and go, so keep it away from where answers usually land. The editor's slider goes from 0.50 to 0.95.",
    "- Jev is weak at counting, numbers, dates, and who is speaking: the app does those in code, so never ask Jev about them (“was it said three times?”, “did the host speak?”).",
    "- Every question is asked about every segment, about 120 times an hour; a set costs about a cent an hour of Jev. Shorter wording is cheaper and just as good.",
    "- The set is copied into each recording when a session starts, so editing it later never changes a past recording. Try on a recording shows what a draft would draw on the first 10 minutes of a real recording before a show.",
    "",
    "## How to interview",
    "1. Every message from the host ends with a checklist the app computed from the draft (it is always right about what is missing; trust it over your memory). Settle the item marked Next unless the host asked something else.",
    "2. Ask exactly one question per turn, in question. Keep it short and concrete, and give up to 4 choices the host can click (short answers, or “Use your suggestion”, “None”). Put acknowledgements, explanations, and examples in reply, in plain words, no markdown tables, a few sentences.",
    "3. When an answer is incomplete, say what is missing, show a short example, and propose values for it (options with descriptions, 5 levels, yes and no wording, a threshold, an icon) in the draft right away, then ask the host to confirm or change them. Do not wait for the host to write everything.",
    "4. When the host asks what something means or why, answer from the knowledge above with a small example, then ask the pending question again.",
    "5. When the host does not want a kind of label (no scores, no index), add it to skip and move on. Respect the limits: if they want more than allowed, say so and help them merge or choose.",
    "6. Use the host's own words for names. Write option descriptions and questions yourself, well: they are what Jev reads.",
    "7. When the checklist says everything is settled, summarise the set in two or three sentences, suggest Try on a recording and then Save, and leave question empty.",
    "",
    "## The draft",
    `set is always the whole draft so far, including everything unchanged, or null only before anything is known. The host may have edited it by hand: those edits win. Fill what you know and propose the rest. Colours: pick distinct ones from ${PALETTE.join(", ")}. Icons: ${ICONS.join(", ")}. Every score always has exactly 5 levels (use an empty string for a level not settled yet). New markers get threshold 0.7 unless there is a reason. Ids are the names in snake_case.`,
    "",
    "## The built-in set, as an example of the format and the wording",
    JSON.stringify(shown),
  ].join("\n");
}

/** A model's set as the schema wants it: nulls removed, format and version added, a draft id. */
export function normalizeDraft(raw: any): unknown {
  if (!raw || typeof raw !== "object") return raw;
  return {
    format: LABEL_FORMAT, version: 1, id: "draft", ...raw,
    categories: (raw.categories ?? []).map((c: any) => {
      const { index, ...rest } = c ?? {};
      return {
        ...rest, ...(index ? { index } : {}),
        options: (c?.options ?? []).map((o: any) => { const { group, ...r } = o ?? {}; return group ? { ...r, group } : r; }),
      };
    }),
    markers: (raw.markers ?? []).map((m: any) => { const { criteria, ...r } = m ?? {}; return criteria ? { ...r, criteria } : r; }),
  };
}

/** Errors a partial draft is expected to have mid-interview: the checklist asks about them. Anything else is the model's mistake. */
const INCOMPLETE = /must not be empty|at least 2 options|needs a fallback option|at least one label/;

export interface AssistDeps {
  fetch: typeof fetch;
  apiKey: string;
  budget: Budget;
  /** One row per call, as System 2's (kind s2_call, purpose labels_assist), so the development total counts it. */
  log: (row: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class LabelsAssistant {
  constructor(private readonly cfg: AppConfig["labelsAssist"], private readonly deps: AssistDeps) {}

  /**
   * One turn of the interview: the conversation so far, the draft on screen (the host's edits included), and what the
   * host declined. The last message gets the checklist computed from the draft. A draft that breaks a rule (not merely
   * incomplete) is sent back once with the errors; an incomplete one is kept, and the checklist says what is left.
   */
  async turn(system: string, messages: AssistMessage[], draft: unknown | null, skipped: string[] = []): Promise<AssistResult> {
    const last = messages.at(-1);
    if (!last || last.role !== "user" || !last.content.trim()) throw new Error("the last message must be the host's");
    const skip = new Set(skipped.filter((k) => SKIPPABLE.includes(k)));
    const before = interviewChecklist(draft, skip);
    const current = draft ? `Current draft (the host may have edited it):\n${JSON.stringify(draft)}` : "There is no draft yet.";
    const convo = [...messages.slice(0, -1), { role: "user" as const, content: `${last.content.trim()}\n\n${current}\n\n${checklistText(before)}` }];
    let cost = 0;
    const first = await this.call(system, convo);
    cost += first.cost;
    let parsed = parse(first.content);
    let set = parsed.set === null ? null : normalizeDraft(parsed.set);
    let broken = set ? ruleErrors(set) : [];
    if (broken.length) {
      const again = await this.call(system, [
        ...convo, { role: "assistant", content: first.content },
        { role: "user", content: `That draft breaks these rules (an incomplete draft is fine, these are not):\n${broken.join("\n")}\nReply again with the whole draft corrected, and the same question.` },
      ]);
      cost += again.cost;
      parsed = parse(again.content);
      set = parsed.set === null ? null : normalizeDraft(parsed.set);
      broken = set ? ruleErrors(set) : [];
    }
    for (const k of parsed.skip) if (SKIPPABLE.includes(k)) skip.add(k);
    const kept = broken.length ? null : (set as LabelSet | null);
    const checklist = interviewChecklist(kept ?? draft, skip);
    return {
      reply: parsed.reply, question: checklist.complete ? "" : parsed.question, choices: parsed.choices.slice(0, 4),
      set: kept, skipped: [...skip], checklist, costUsd: cost,
      ...(broken.length ? { error: `The drafted changes broke the set's rules, so the draft was not changed: ${broken.slice(0, 5).join("; ")}` } : {}),
    };
  }

  private async call(system: string, messages: AssistMessage[]): Promise<{ content: string; cost: number }> {
    this.deps.budget.assertCanSpend("labels_assist");
    const body = JSON.stringify({
      model: this.cfg.model,
      messages: [{ role: "system", content: system }, ...messages],
      reasoning: { effort: this.cfg.effort },
      provider: this.cfg.provider,
      response_format: { type: "json_schema", json_schema: { name: "label_set_draft", strict: true, schema: ASSIST_JSON_SCHEMA } },
    });
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const raw = await this.send(body);
        const cost = raw.usage.cost as number;
        this.deps.budget.record("s2", cost);
        const msg = raw.choices?.[0]?.message;
        const content = typeof msg?.content === "string" ? msg.content : Array.isArray(msg?.content) ? msg.content.map((c: any) => c?.text ?? "").join("") : "";
        this.log({ ok: true, raw, attempt, started });
        return { content, cost };
      } catch (e) {
        const cls = classifyError(e);
        if (cls === "fail" || attempt >= this.cfg.maxAttempts) {
          this.log({ ok: false, attempt, started, error: e instanceof Error ? e.message : String(e) });
          const status = e instanceof HttpError ? effectiveStatus(e) : null;
          if (status === 401) throw new AssistError(401, "OpenRouter rejected the API key (401): replace it in API keys.");
          if (status === 402) throw new AssistError(402, "OpenRouter says the credit or the key's limit is used up (402): add credit at openrouter.ai.");
          throw new AssistError(502, `GPT-6 Luna did not answer: ${e instanceof Error ? e.message : String(e)}`);
        }
        const wait = backoffMs(attempt, e instanceof HttpError ? e.retryAfterMs : null);
        await (this.deps.sleep ? this.deps.sleep(wait) : new Promise((r) => setTimeout(r, wait)));
      }
    }
  }

  private async send(body: string): Promise<any> {
    let res: Response;
    let text: string;
    try {
      res = await this.deps.fetch(CHAT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.deps.apiKey}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Tattle" },
        body, signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new HttpError(null, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if (!res.ok) throw new HttpError(res.status, text, retryAfterMs);
    let json: any;
    try {
      json = JSON.parse(text.slice(Math.max(0, text.indexOf("{"))));
    } catch {
      throw new HttpError(res.status, text, retryAfterMs);
    }
    if (json.error) throw new HttpError(res.status, text, retryAfterMs);
    if (typeof json.usage?.cost !== "number") throw new HttpError(-1, text, null, "response without usage.cost rejected");
    return json;
  }

  private log(r: { ok: boolean; raw?: any; attempt: number; started: number; error?: string }) {
    const u = r.raw?.usage;
    this.deps.log({
      kind: "s2_call", purpose: "labels_assist", ok: r.ok, latency_ms: Date.now() - r.started, attempts: r.attempt,
      id: r.raw?.id ?? null, model_returned: r.raw?.model ?? null, cost_usd: u?.cost ?? 0,
      usage: u ? { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, cost: u.cost } : null,
      ...(r.error ? { error: r.error } : {}), at: new Date().toISOString(),
    });
  }
}

export class AssistError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The draft's errors that are mistakes rather than parts still to settle. */
function ruleErrors(set: unknown): string[] {
  const r = checkLabelSet(set);
  return r.ok ? [] : r.errors.filter((e) => !INCOMPLETE.test(e));
}

function parse(content: string): { reply: string; question: string; choices: string[]; skip: string[]; set: unknown | null } {
  try {
    const j = JSON.parse(content);
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
    return {
      reply: typeof j?.reply === "string" ? j.reply : "", question: typeof j?.question === "string" ? j.question : "",
      choices: strings(j?.choices), skip: strings(j?.skip), set: j?.set ?? null,
    };
  } catch {
    return { reply: content.trim() || "The reply could not be read.", question: "", choices: [], skip: [], set: null };
  }
}
