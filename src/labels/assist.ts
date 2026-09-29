// Create with AI: the host describes a show, and GPT-6 Luna (one fixed model, `labelsAssist` in config/app.json)
// drafts a label set the host reviews, edits, and saves. The model never saves or changes a set, and never runs on the
// timeline (docs/mission.md). Each reply is strict JSON { reply, set }, and the set passes the same validation as a
// hand-made one: an invalid set is sent back once with its errors, then dropped with the reply kept.
import type { AppConfig } from "../config.ts";
import type { Budget } from "../budget.ts";
import { backoffMs, classifyError, effectiveStatus, HttpError, parseRetryAfter } from "../jev/client.ts";
import { CHAT_URL } from "../factcheck/s2.ts";
import { ICONS } from "../../web/src/icons.ts";
import { checkLabelSet, LABEL_FORMAT, LIMITS, type LabelSet } from "./model.ts";

export interface AssistMessage { role: "user" | "assistant"; content: string }
export interface AssistResult { reply: string; set: LabelSet | null; costUsd: number; error?: string }

const nullable = (schema: object) => ({ anyOf: [{ type: "null" }, schema] });
const obj = (properties: Record<string, object>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: "string" };

/** The reply's strict schema. Optional fields are nullable (strict mode wants every field); limits are checked by code. */
export const ASSIST_JSON_SCHEMA = obj({
  reply: str,
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

/** What the model knows: a label set, its limits, the icons, the wording rules learned from Jev, and the built-in set. */
export function assistSystemPrompt(example: LabelSet): string {
  const { builtIn: _b, id: _i, format: _f, version: _v, ...shown } = example;
  return [
    "You help the host of a live show design a label set for Tattle, an app that labels each stretch (segment, 12 to 75 seconds) of a conversation on a timeline, live, by asking Jev, a fast decision model, typed questions about it. You draft; the host reviews, edits, and saves. Never claim to have saved anything.",
    "",
    "A label set has three kinds of labels:",
    `- categories (at most ${LIMITS.categories}): a choice question; Jev picks exactly one option. Each option has a snake_case id, a short name, a description Jev reads as its criterion, a #rrggbb colour, and an optional group (options sharing a group are filtered together). 2 to ${LIMITS.options} options that do not overlap, and one fallback option whose id is none or starts with other. The first category draws the section brackets. One category may have an index: some of its options whose share of time is shown as one big percentage.`,
    `- scores (at most ${LIMITS.scores}): exactly ${LIMITS.levels} levels, lowest first, shown as a line on a 0–4 chart.`,
    `- markers (at most ${LIMITS.markers}): a yes/no question shown as an icon when Jev's yes probability reaches the marker's threshold (0.5–0.95; 0.7 is a good default). A marker can be counted per speaker (perSpeaker) and listed in the stats (list). Icons: ${ICONS.join(", ")}.`,
    "At least one label. Ids are snake_case, unique across the whole set; story and boundary are reserved. The prefix is put before every question; keep \"Judge only segment; previous_segment is context only.\" unless the host asks otherwise.",
    "",
    "How to word questions for Jev:",
    "- Jev sees only the current segment (and the one before, as context): judge only the segment.",
    "- One narrow judgment per question; Jev answers each on its own and cannot see its other answers.",
    "- Jev reads literally. Give markers concrete true and false criteria: what the segment contains, and what looks close but is not it.",
    "- Never ask Jev to count, compare numbers, or do arithmetic, and never ask about timestamps or who is speaking: code does that.",
    "- Keep wording short: every question is asked about every segment.",
    "",
    "Reply with JSON: reply is what you say to the host (short, plain, no markdown tables), and set is the whole draft label set, or null when you are only asking or answering a question. When a current draft is given, start from it: the host may have edited it by hand, and those edits win.",
    "",
    "The built-in set, as an example of the format and the wording:",
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
   * One turn: the conversation so far, and the draft on screen (the host's edits included). Returns the reply and, when
   * the model drafted one that validates, the set.
   */
  async turn(system: string, messages: AssistMessage[], draft: unknown | null): Promise<AssistResult> {
    const last = messages.at(-1);
    if (!last || last.role !== "user" || !last.content.trim()) throw new Error("the last message must be the host's");
    const current = draft ? `Current draft (the host may have edited it):\n${JSON.stringify(draft)}` : "There is no draft yet.";
    const convo = [...messages.slice(0, -1), { role: "user" as const, content: `${last.content.trim()}\n\n${current}` }];
    let cost = 0;
    const first = await this.call(system, convo);
    cost += first.cost;
    let parsed = parse(first.content);
    if (parsed.set === null) return { reply: parsed.reply, set: null, costUsd: cost };
    let check = checkLabelSet(normalizeDraft(parsed.set));
    if (check.ok) return { reply: parsed.reply, set: check.set, costUsd: cost };
    // once more, with what was wrong
    const again = await this.call(system, [
      ...convo, { role: "assistant", content: first.content },
      { role: "user", content: `That set does not pass validation:\n${check.errors.join("\n")}\nReply again with a corrected whole set.` },
    ]);
    cost += again.cost;
    parsed = parse(again.content);
    if (parsed.set === null) return { reply: parsed.reply, set: null, costUsd: cost };
    check = checkLabelSet(normalizeDraft(parsed.set));
    if (check.ok) return { reply: parsed.reply, set: check.set, costUsd: cost };
    return { reply: parsed.reply, set: null, costUsd: cost, error: `The drafted set did not pass validation: ${check.errors.slice(0, 5).join("; ")}` };
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

function parse(content: string): { reply: string; set: unknown | null } {
  try {
    const j = JSON.parse(content);
    return { reply: typeof j?.reply === "string" ? j.reply : "", set: j?.set ?? null };
  } catch {
    return { reply: content.trim() || "The reply could not be read.", set: null };
  }
}
