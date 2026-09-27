import { z } from "zod";
import type { AppConfig } from "../config.ts";
import type { Budget } from "../budget.ts";
import { backoffMs, classifyError, effectiveStatus, HttpError, parseRetryAfter } from "../jev/client.ts";

export const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export type S2Purpose = "research" | "audit" | "rewrite";

// ---------- prompts (byte-identical across calls, so cached input is cheap) ----------

export function researchSystemPrompt(today: string): string {
  return [
    `You fact-check one spoken claim from a live English-language AI podcast. Today is ${today}. Your own knowledge ends in May 2026, so rely on the web results for anything after that, and never call something false only because you have not heard of it. Judge the claim as a listener would understand it. Verdicts:`,
    "- supported: accurate.",
    "- contradicted: false.",
    "- misleading: technically true but missing context that changes its meaning, or a vendor's own claim presented as fact.",
    "- unverifiable: no reliable source found.",
    "- not_a_claim: an opinion, joke, exaggeration, or too vague to check.",
    "",
    "A claim about the speakers' own private lives (their family, friends, feelings, plans, or personal experiences) cannot be checked against public sources: use not_a_claim with false_alarm_reason private.",
    "",
    "restated_claim is one precise sentence. correction is at most 25 words saying what is true. Cite only sources you used.",
  ].join("\n");
}

export const AUDIT_SYSTEM =
  "You audit a live AI podcast's fact-checker. For each utterance, say whether it contains a specific factual claim that could be checked against public sources, and how much listeners would care whether it is accurate. A checkable claim is about the public world: companies, products, AI models, public figures, prices, statistics, science, laws, or news. Opinions, jokes, exaggerations, and vague statements are not checkable claims, and neither is anything about the speakers' own private lives (their family, friends, feelings, plans, or personal experiences), however concrete.";

export const REWRITE_SYSTEM =
  "You improve the questions a fast classifier uses to flag checkable factual claims in a live AI podcast. You get the active questions and thresholds, false alarms (flagged but not checkable) with reasons, correctly flagged examples, and missed claims. Propose at most 3 changes that remove false alarms or catch misses without losing correct flags. A checkable claim is always about the public world; the speakers' private lives never count, so never widen the questions to include them. Follow these question rules: one narrow judgment per question, concrete true and false descriptions for yes/no questions, never ask for counting or arithmetic.";

// ---------- schemas: strict JSON schemas for the API, zod for validation ----------

export const VERDICTS = ["supported", "contradicted", "misleading", "unverifiable", "not_a_claim"] as const;
export const FALSE_ALARM_REASONS = ["none", "hyperbole", "joke", "opinion", "too_vague", "trivial", "not_factual", "private"] as const;
export type VerdictKind = (typeof VERDICTS)[number];

// Length and count limits stay out of the strict schema (strict mode has rejected maxLength / maxItems); code enforces them.
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["restated_claim", "verdict", "correction", "confidence", "false_alarm_reason", "sources"],
  properties: {
    restated_claim: { type: "string" },
    verdict: { type: "string", enum: [...VERDICTS] },
    correction: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    false_alarm_reason: { type: "string", enum: [...FALSE_ALARM_REASONS] },
    sources: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["url", "title"], properties: { url: { type: "string" }, title: { type: "string" } } },
    },
  },
} as const;

export const VerdictSchema = z.object({
  restated_claim: z.string(),
  verdict: z.enum(VERDICTS),
  correction: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  false_alarm_reason: z.enum(FALSE_ALARM_REASONS),
  sources: z.array(z.object({ url: z.string(), title: z.string() })),
});
export type RawVerdict = z.infer<typeof VerdictSchema>;

export interface Verdict extends RawVerdict {
  downgraded: boolean;
}

export const AUDIT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["utterance_id", "has_checkable_claim", "worth"],
        properties: {
          utterance_id: { type: "string" }, has_checkable_claim: { type: "boolean" }, worth: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
} as const;

export const AuditSchema = z.object({
  items: z.array(z.object({ utterance_id: z.string(), has_checkable_claim: z.boolean(), worth: z.enum(["low", "medium", "high"]) })),
});
export type AuditResult = z.infer<typeof AuditSchema>;

export const REWRITE_OPS = ["set_instructions", "set_criteria", "add_attention", "remove_attention", "set_threshold"] as const;
const nullable = (t: string | object) => (typeof t === "string" ? { type: [t, "null"] } : t);

export const REWRITE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["changes", "rationale"],
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "target", "text", "true_text", "false_text", "options", "levels", "number"],
        properties: {
          op: { type: "string", enum: [...REWRITE_OPS] },
          target: { type: "string" },
          text: nullable("string"),
          true_text: nullable("string"),
          false_text: nullable("string"),
          options: {
            type: ["array", "null"],
            items: { type: "object", additionalProperties: false, required: ["key", "description"], properties: { key: { type: "string" }, description: { type: "string" } } },
          },
          levels: { type: ["array", "null"], items: { type: "string" } },
          number: nullable("number"),
        },
      },
    },
    rationale: { type: "string" },
  },
} as const;

export const RewriteChangeSchema = z.object({
  op: z.enum(REWRITE_OPS),
  target: z.string(),
  text: z.string().nullable(),
  true_text: z.string().nullable(),
  false_text: z.string().nullable(),
  options: z.array(z.object({ key: z.string(), description: z.string() })).nullable(),
  levels: z.array(z.string()).nullable(),
  number: z.number().nullable(),
});
export const RewriteSchema = z.object({ changes: z.array(RewriteChangeSchema), rationale: z.string() });
export type RewriteProposal = z.infer<typeof RewriteSchema>;
export type RewriteChange = z.infer<typeof RewriteChangeSchema>;

// ---------- verdict post-processing (§4.8b) ----------

export interface Citation { url: string; title: string }

export function citationsOf(annotations: unknown): Citation[] {
  if (!Array.isArray(annotations)) return [];
  const out: Citation[] = [];
  for (const a of annotations) {
    if (a?.type === "url_citation" && typeof a.url_citation?.url === "string") {
      out.push({ url: a.url_citation.url, title: typeof a.url_citation.title === "string" ? a.url_citation.title : a.url_citation.url });
    }
  }
  return out;
}

export function truncateWords(s: string, n: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.length <= n ? s.trim() : words.slice(0, n).join(" ");
}

/** Removes inline markdown citations the web plugin adds: "([site](url))" goes, "[text](url)" becomes "text". */
export function stripCitations(s: string): string {
  return s
    .replace(/\s*\(\s*\[[^\]]*\]\([^)]*\)(?:\s*[,;]\s*\[[^\]]*\]\([^)]*\))*\s*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

function cleanTitle(title: string, url: string): string {
  const t = stripCitations(title || "").trim();
  if (t && !/^https?:\/\//.test(t)) return t;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Enforces limits in code, merges citations (deduplicated by URL) before the 3-source limit, and downgrades sourceless verdicts. */
export function finalizeVerdict(raw: RawVerdict, annotations: unknown): Verdict {
  const seen = new Set<string>();
  const sources: Citation[] = [];
  for (const s of [...raw.sources, ...citationsOf(annotations)]) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    sources.push({ url: s.url, title: cleanTitle(s.title, s.url) });
  }
  const v: Verdict = {
    ...raw,
    restated_claim: stripCitations(raw.restated_claim).slice(0, 200),
    correction: truncateWords(stripCitations(raw.correction), 25),
    sources: sources.slice(0, 3),
    downgraded: false,
  };
  if ((v.verdict === "supported" || v.verdict === "contradicted" || v.verdict === "misleading") && v.sources.length === 0) {
    v.verdict = "unverifiable";
    v.downgraded = true;
  }
  return v;
}

export function gradeOf(v: Pick<RawVerdict, "verdict" | "false_alarm_reason">): "good_flag" | "false_alarm" {
  return v.verdict === "not_a_claim" || v.false_alarm_reason !== "none" ? "false_alarm" : "good_flag";
}

// ---------- the client ----------

export interface S2CallRow {
  kind: "s2_call";
  purpose: S2Purpose;
  claim_id?: string;
  ok: boolean;
  latency_ms: number;
  attempts: number;
  id: string | null;
  model_returned: string | null;
  provider_returned: string | null;
  usage: {
    prompt_tokens: number; completion_tokens: number; reasoning_tokens: number; cached_tokens: number; cost: number;
  } | null;
  cost_usd: number;
  response_format: "json_schema" | "json_object";
  web_engine: string | null;
  /** The prompt as sent and the model's reply, so the page can show System 2 at work. */
  request?: { system: string; user: string };
  response?: string;
  error?: string;
  at: string;
}

export interface S2Deps {
  fetch: typeof fetch;
  apiKey: string;
  budget: Budget;
  log: (row: S2CallRow) => void;
  /** Called when a call is about to be sent (after the budget check), so a page can show System 2 working. */
  onStart?: (purpose: S2Purpose) => void;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  today?: () => string;
}

interface ChatRequest {
  purpose: S2Purpose;
  claim_id?: string;
  system: string;
  user: string;
  effort: string;
  schemaName: string;
  jsonSchema: object;
  web: { engine: string; max_results: number } | null;
}

interface ChatResult { content: string; annotations: unknown; }

/** GPT-6 Luna through OpenRouter chat completions (§2.5). The only path to System 2. */
export class S2Client {
  /** §6 row 5: sticky fallback to json_object when strict output fails together with the web plugin. */
  private jsonObjectWithWeb = false;

  constructor(private readonly cfg: AppConfig["s2"], private readonly deps: S2Deps) {}

  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  private today(): string {
    return this.deps.today ? this.deps.today() : new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  }

  async research(input: { claim_id?: string; speaker: string; utterance: string; segment: string }, web = this.cfg.web): Promise<Verdict> {
    const user = [
      `Speaker: ${input.speaker}`,
      `Utterance: ${input.utterance}`,
      `Current segment (context only): ${input.segment.slice(-1500)}`,
    ].join("\n");
    const req: ChatRequest = {
      purpose: "research", claim_id: input.claim_id, system: researchSystemPrompt(this.today()), user,
      effort: this.cfg.effort.research, schemaName: "verdict", jsonSchema: VERDICT_JSON_SCHEMA, web,
    };
    const { value, annotations } = await this.structured(req, VerdictSchema);
    return finalizeVerdict(value, annotations);
  }

  async audit(items: { utterance_id: string; speaker: string; text: string }[]): Promise<AuditResult> {
    const req: ChatRequest = {
      purpose: "audit", system: AUDIT_SYSTEM, user: JSON.stringify(items, null, 1), effort: this.cfg.effort.audit,
      schemaName: "audit", jsonSchema: AUDIT_JSON_SCHEMA, web: null,
    };
    return (await this.structured(req, AuditSchema)).value;
  }

  async rewrite(user: string): Promise<RewriteProposal> {
    const req: ChatRequest = {
      purpose: "rewrite", system: REWRITE_SYSTEM, user, effort: this.cfg.effort.rewrite,
      schemaName: "rewrite", jsonSchema: REWRITE_JSON_SCHEMA, web: null,
    };
    return (await this.structured(req, RewriteSchema)).value;
  }

  private async structured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<{ value: T; annotations: unknown }> {
    const useObject = req.web !== null && this.jsonObjectWithWeb;
    try {
      const r = await this.chat(req, useObject ? "json_object" : "json_schema");
      return { value: parseContent(r.content, schema), annotations: r.annotations };
    } catch (e) {
      // Strict output failing together with the web plugin: retry once with json_object and a zod parse (§6 row 5).
      const strictRejected = e instanceof HttpError ? effectiveStatus(e) === 400 : e instanceof ContentError;
      if (req.web === null || useObject || !strictRejected) throw e;
      const r = await this.chat(req, "json_object");
      const value = parseContent(r.content, schema);
      this.jsonObjectWithWeb = true;
      return { value, annotations: r.annotations };
    }
  }

  private body(req: ChatRequest, format: "json_schema" | "json_object") {
    const user = format === "json_object"
      ? `${req.user}\n\nReply with one JSON object only, matching this JSON schema:\n${JSON.stringify(req.jsonSchema)}`
      : req.user;
    return {
      model: this.cfg.model,
      messages: [{ role: "system", content: req.system }, { role: "user", content: user }],
      reasoning: { effort: req.effort },
      provider: format === "json_schema" ? this.cfg.provider : { ...this.cfg.provider, require_parameters: false },
      ...(req.web ? { plugins: [{ id: "web", engine: req.web.engine, max_results: req.web.max_results }] } : {}),
      response_format: format === "json_schema"
        ? { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.jsonSchema } }
        : { type: "json_object" },
    };
  }

  private async chat(req: ChatRequest, format: "json_schema" | "json_object"): Promise<ChatResult> {
    this.deps.budget.assertCanSpend(`s2:${req.purpose}`);
    this.deps.onStart?.(req.purpose);
    const started = Date.now();
    const body = JSON.stringify(this.body(req, format));
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const raw = await this.send(body);
        const cost = raw.usage.cost;
        this.deps.budget.record("s2", cost);
        const msg = raw.choices?.[0]?.message;
        const content = typeof msg?.content === "string" ? msg.content
          : Array.isArray(msg?.content) ? msg.content.map((c: any) => c?.text ?? "").join("") : "";
        this.log(req, format, { ok: true, raw, attempts: attempt, started, content });
        return { content, annotations: msg?.annotations };
      } catch (e) {
        const cls = classifyError(e);
        if (cls === "fail" || attempt >= this.cfg.maxAttempts) {
          this.log(req, format, { ok: false, attempts: attempt, started, error: e instanceof Error ? e.message : String(e) });
          if (e instanceof HttpError && effectiveStatus(e) === 402 && cls === "fail") {
            this.deps.budget.exhaust("provider", `s2:${req.purpose}`, "OpenRouter credits or key limit exhausted (402)");
          }
          if (e instanceof HttpError && effectiveStatus(e) === 401) {
            throw new HttpError(401, e.body, null, "OpenRouter rejected the API key (401): check OPENROUTER_API_KEY");
          }
          throw e;
        }
        await this.sleep(backoffMs(attempt, e instanceof HttpError ? e.retryAfterMs : null, this.deps.rand));
      }
    }
  }

  private async send(body: string): Promise<any> {
    let res: Response;
    let text: string;
    try {
      res = await this.deps.fetch(CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.apiKey}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Conversation Assistant",
        },
        body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new HttpError(null, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if (!res.ok) throw new HttpError(res.status, text, retryAfterMs);
    const start = text.indexOf("{");
    if (start < 0) throw new HttpError(res.status, text, retryAfterMs);
    let json: any;
    try {
      json = JSON.parse(text.slice(start));
    } catch {
      throw new HttpError(res.status, text, retryAfterMs);
    }
    if (json.error) throw new HttpError(res.status, text, retryAfterMs);
    if (typeof json.usage?.cost !== "number") throw new HttpError(-1, text, null, "response without usage.cost rejected");
    return json;
  }

  private log(
    req: ChatRequest, format: "json_schema" | "json_object",
    r: { ok: boolean; raw?: any; attempts: number; started: number; error?: string; content?: string },
  ) {
    const u = r.raw?.usage;
    this.deps.log({
      kind: "s2_call",
      purpose: req.purpose,
      ...(req.claim_id ? { claim_id: req.claim_id } : {}),
      ok: r.ok,
      latency_ms: Date.now() - r.started,
      attempts: r.attempts,
      id: r.raw?.id ?? null,
      model_returned: r.raw?.model ?? null,
      provider_returned: r.raw?.provider ?? null,
      usage: u ? {
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
        cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        cost: u.cost,
      } : null,
      cost_usd: u?.cost ?? 0,
      response_format: format,
      web_engine: req.web?.engine ?? null,
      request: { system: req.system, user: req.user },
      ...(r.content !== undefined ? { response: r.content } : {}),
      ...(r.error ? { error: r.error } : {}),
      at: new Date().toISOString(),
    });
  }
}

export class ContentError extends Error {}

export function parseContent<T>(content: string, schema: z.ZodType<T>): T {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) throw new ContentError(`no JSON object in the reply: ${content.slice(0, 200)}`);
  let json: unknown;
  try {
    json = JSON.parse(content.slice(start, end + 1));
  } catch (e) {
    throw new ContentError(`invalid JSON in the reply: ${(e as Error).message}`);
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new ContentError(`reply does not match the schema: ${z.prettifyError(r.error)}`);
  return r.data;
}
