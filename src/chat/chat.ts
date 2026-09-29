import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import type { Budget } from "../budget.ts";
import { backoffMs, classifyError, effectiveStatus, HttpError, parseRetryAfter } from "../jev/client.ts";
import { CHAT_URL } from "../factcheck/s2.ts";
import { processSecrets } from "../store/events.ts";

export const MODELS_URL = "https://openrouter.ai/api/v1/models";
export const GENERATION_URL = "https://openrouter.ai/api/v1/generation";

/**
 * The chat window: the host's own questions about the transcript, to any model in `chat.models`. It is a tool for the
 * host, beside the demonstration, not part of System 1 or System 2 (see docs/chat.md).
 *
 * A chat only ever appends to what it has sent. Each question carries the transcript lines that arrived since that
 * chat's previous question, so a question asked on air sees everything said up to that moment, and every request
 * starts with the byte-identical prefix of the one before it, which the provider's prompt cache can serve.
 */
export const CHAT_SYSTEM = [
  "You answer the host's questions about a podcast recording, using its transcript.",
  "The transcript arrives inside the user messages: the first holds everything said so far, and each later message adds the lines said since the previous question, because the recording may still be live.",
  "Each line reads [time] Speaker: text, where time is the time into the recording. Speaker names come from voice recognition and can be generic (\"Speaker 2\") or occasionally wrong, and the transcription can mishear words.",
  "Answer from the transcript. When it does not say, say so, and mark anything you add from general knowledge as such.",
  "When you refer to a moment, cite its time in square brackets, like [12:34].",
  "Use Markdown, and keep answers short unless asked for detail.",
].join("\n");

export interface TranscriptLine { id: string; startMs: number; speakerId: string; speaker: string; text: string }

/** What a chat is about: the session on screen, running or recorded. */
export interface ChatSource {
  sessionId: string;
  dir: string;
  /** True while the session is still recording. */
  live: boolean;
  /** Final lines in arrival order, fillers left out, with current speaker names. */
  lines(): TranscriptLine[];
  /** The running session's ledger (a recording has none): chat spend goes into its `chat` bucket. */
  budget?: Budget;
}

export interface ModelInfo {
  id: string; name: string; contextLength: number | null; maxOutput: number | null;
  inputUsdPerM: number | null; outputUsdPerM: number | null; cacheReadUsdPerM: number | null;
  /** False when OpenRouter's catalogue no longer lists it; null when the catalogue could not be read. */
  available: boolean | null;
}

export interface SentLines {
  /** Lines [from, to) of the transcript, in arrival order, were attached to this question. */
  from: number; to: number;
  /** The time of the latest line the chat has seen. */
  upToMs: number | null;
  live: boolean;
  /** Speaker names as the model knows them, by speaker id, so a later rename can be announced. */
  names: Record<string, string>;
}

export interface ChatMessage {
  id: string; role: "user" | "assistant"; content: string; at: string; model?: string;
  /** User: exactly what the model received, the transcript included. */
  sent?: string;
  lines?: SentLines;
  stopped?: boolean;
  error?: string;
}

export interface ChatCallRow {
  kind: "chat_call"; chat_id: string; message_id: string; model: string; ok: boolean; latency_ms: number; attempts: number;
  id: string | null; model_returned: string | null; provider_returned: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number; cached_tokens: number } | null;
  cost_usd: number;
  /** The cost was estimated from the price list because the reply was stopped and OpenRouter had no record of it yet. */
  estimated?: boolean;
  stopped?: boolean;
  error?: string;
  at: string;
}

type Row =
  | { kind: "chat"; op: "create"; chat_id: string; title: string; model: string; at: string }
  | { kind: "chat"; op: "rename"; chat_id: string; title: string; auto?: boolean; at: string }
  | { kind: "chat"; op: "model"; chat_id: string; model: string; at: string }
  | { kind: "chat"; op: "rewind"; chat_id: string; keep: number; at: string }
  | { kind: "chat"; op: "delete"; chat_id: string; at: string }
  | ({ kind: "chat_message"; chat_id: string } & ChatMessage)
  | ChatCallRow;

interface ChatRecord {
  id: string; title: string; model: string; createdAt: string; updatedAt: string; deleted: boolean;
  messages: ChatMessage[]; calls: ChatCallRow[]; messageRows: number;
}

export interface ChatMeter {
  model: string; contextLength: number | null;
  /** The conversation's size at its latest reply: what the next question is added to. */
  contextTokens: number;
  leftTokens: number | null;
  /** Everything billed so far, across every reply (a question re-sends the conversation, so this grows faster). */
  inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number;
  costUsd: number;
  estimated: boolean;
  /** Transcript lines said since this chat's last question: the next question brings them along. */
  pendingLines: number; pendingTokens: number;
}

export type ChatEvent =
  | { type: "start"; user: ChatMessage | null; assistantId: string; model: string }
  | { type: "thinking" }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage; call: ChatCallRow; chat: unknown }
  | { type: "error"; message: string; chat: unknown };

export class ChatError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ChatDeps {
  fetch: typeof fetch;
  apiKey: string;
  source: () => ChatSource | null;
  /** After spend was recorded: the engine refreshes the header's cost. */
  onSpend?: (source: ChatSource) => void;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

/** "4:07", or "1:04:07" past an hour. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export const formatLine = (l: TranscriptLine) => `[${clock(l.startMs)}] ${l.speaker}: ${l.text}`;

/** A rough token count (about 4 characters each), for what has not been sent yet. */
const approxTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * What one question sends: the transcript lines since the chat's previous question (all of them on the first), notes
 * on renamed speakers and on the recording ending, then the question.
 */
export function composeQuestion(prev: SentLines | undefined, lines: TranscriptLine[], live: boolean, question: string): { sent: string; lines: SentLines } {
  const from = Math.min(prev?.to ?? 0, lines.length);
  const added = lines.slice(from);
  const current = new Map(lines.map((l) => [l.speakerId, l.speaker]));
  const names = { ...(prev?.names ?? {}) };
  const renames: string[] = [];
  for (const [id, old] of Object.entries(names)) {
    const now = current.get(id);
    if (now && now !== old) {
      renames.push(`"${old}" in earlier lines is now called "${now}"`);
      names[id] = now;
    }
  }
  for (const l of added) names[l.speakerId] = l.speaker;
  const upToMs = [...(prev?.upToMs !== null && prev?.upToMs !== undefined ? [prev.upToMs] : []), ...added.map((l) => l.startMs)]
    .reduce<number | null>((m, t) => (m === null ? t : Math.max(m, t)), null);
  const body = added.map(formatLine).join("\n");
  const parts: string[] = [];
  if (!prev) {
    const status = live ? "live, still being recorded" : "finished";
    parts.push(added.length
      ? `<transcript status="${status}" lines="${added.length}" up_to="${clock(upToMs ?? 0)}">\n${body}\n</transcript>`
      : `<transcript status="${status}">No one has spoken yet.</transcript>`);
  } else {
    if (renames.length) parts.push(`<speaker_names>${renames.join("; ")}.</speaker_names>`);
    if (prev.live && !live) parts.push("<recording_status>The recording has ended.</recording_status>");
    parts.push(added.length
      ? `<transcript_update lines="${from + 1}–${from + added.length}" up_to="${clock(upToMs ?? 0)}">\n${body}\n</transcript_update>`
      : "<transcript_update>No new lines since the previous question.</transcript_update>");
  }
  parts.push(`<question>\n${question}\n</question>`);
  return { sent: parts.join("\n\n"), lines: { from, to: from + added.length, upToMs, live, names } };
}

function readRows(path: string): Row[] {
  if (!existsSync(path)) return [];
  const out: Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line after a crash */ }
  }
  return out;
}

/** Folds chats.jsonl (append-only) into chats: renames, model changes, rewinds, and deletes are rows like any other. */
export function foldChats(rows: Row[]): Map<string, ChatRecord> {
  const chats = new Map<string, ChatRecord>();
  for (const r of rows) {
    const c = chats.get(r.chat_id);
    if (r.kind === "chat" && r.op === "create") {
      chats.set(r.chat_id, { id: r.chat_id, title: r.title, model: r.model, createdAt: r.at, updatedAt: r.at, deleted: false, messages: [], calls: [], messageRows: 0 });
      continue;
    }
    if (!c) continue;
    if (r.kind === "chat") {
      if (r.op === "rename") c.title = r.title;
      else if (r.op === "model") c.model = r.model;
      else if (r.op === "rewind") c.messages = c.messages.slice(0, r.keep);
      else if (r.op === "delete") c.deleted = true;
      c.updatedAt = r.at;
    } else if (r.kind === "chat_message") {
      const { kind: _k, chat_id: _c, ...m } = r;
      c.messages.push(m);
      c.messageRows++;
      c.updatedAt = r.at;
    } else if (r.kind === "chat_call") {
      c.calls.push(r);
    }
  }
  return chats;
}

/** A recording's total chat spend, deleted chats included. */
export const chatSpend = (rows: Row[]) => rows.reduce((t, r) => t + (r.kind === "chat_call" && typeof r.cost_usd === "number" ? r.cost_usd : 0), 0);

export class ChatService {
  private catalogue: { at: number; ok: boolean; byId: Map<string, any> } | null = null;
  /** Replies being written, by `<session>/<chat>`. */
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly cfg: AppConfig["chat"], private readonly deps: ChatDeps) {}

  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  // ---------- models ----------

  /** The configured models with their context window and prices, from OpenRouter's catalogue (kept for an hour). */
  async models(): Promise<{ default: string; models: ModelInfo[] }> {
    const fresh = this.catalogue && Date.now() - this.catalogue.at < (this.catalogue.ok ? 3_600_000 : 60_000);
    if (!fresh) {
      try {
        const res = await this.deps.fetch(MODELS_URL, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: any = await res.json();
        this.catalogue = { at: Date.now(), ok: true, byId: new Map((json?.data ?? []).map((m: any) => [m.id, m])) };
      } catch {
        this.catalogue = { at: Date.now(), ok: false, byId: this.catalogue?.byId ?? new Map() };
      }
    }
    const cat = this.catalogue!;
    const perM = (v: unknown) => {
      const n = Number(v);
      return v === undefined || v === null || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 1e6 * 1e4) / 1e4;
    };
    const models = this.cfg.models.map((id): ModelInfo => {
      const m = cat.byId.get(id);
      return {
        id, name: m?.name ?? id, contextLength: m?.context_length ?? m?.top_provider?.context_length ?? null,
        maxOutput: m?.top_provider?.max_completion_tokens ?? null,
        inputUsdPerM: perM(m?.pricing?.prompt), outputUsdPerM: perM(m?.pricing?.completion), cacheReadUsdPerM: perM(m?.pricing?.input_cache_read),
        available: m ? true : cat.byId.size ? false : null,
      };
    });
    return { default: this.cfg.defaultModel, models };
  }

  private async model(id: string): Promise<ModelInfo | undefined> {
    return (await this.models()).models.find((m) => m.id === id);
  }

  // ---------- chats ----------

  private need(): ChatSource {
    const s = this.deps.source();
    if (!s) throw new ChatError(409, "no session on screen: start one or open a recording to chat about it");
    return s;
  }

  private path(s: ChatSource) {
    return join(s.dir, "chats.jsonl");
  }

  private append(s: ChatSource, row: Row) {
    appendFileSync(this.path(s), processSecrets()(JSON.stringify(row)) + "\n"); // like every session file: never a key
  }

  private rows(s: ChatSource) {
    return readRows(this.path(s));
  }

  private get(s: ChatSource, id: string): ChatRecord {
    const c = foldChats(this.rows(s)).get(id);
    if (!c || c.deleted) throw new ChatError(404, `unknown chat ${id}`);
    return c;
  }

  private busy(s: ChatSource, id: string) {
    return this.inflight.has(`${s.sessionId}/${id}`);
  }

  private meter(s: ChatSource, c: ChatRecord, info: ModelInfo | undefined): ChatMeter {
    const kept = new Set(c.messages.map((m) => m.id));
    const withUsage = c.calls.filter((k) => k.usage);
    const last = [...withUsage].reverse().find((k) => kept.has(k.message_id));
    const contextTokens = last?.usage ? last.usage.prompt_tokens + last.usage.completion_tokens : 0;
    const sum = (f: (u: NonNullable<ChatCallRow["usage"]>) => number) => withUsage.reduce((t, k) => t + f(k.usage!), 0);
    const cursor = [...c.messages].reverse().find((m) => m.lines)?.lines?.to ?? 0;
    const pending = s.lines().slice(cursor);
    return {
      model: c.model, contextLength: info?.contextLength ?? null, contextTokens,
      leftTokens: info?.contextLength ? Math.max(0, info.contextLength - contextTokens) : null,
      inputTokens: sum((u) => u.prompt_tokens), cachedTokens: sum((u) => u.cached_tokens),
      outputTokens: sum((u) => u.completion_tokens), reasoningTokens: sum((u) => u.reasoning_tokens),
      costUsd: c.calls.reduce((t, k) => t + k.cost_usd, 0), estimated: c.calls.some((k) => k.estimated),
      pendingLines: pending.length, pendingTokens: pending.reduce((t, l) => t + approxTokens(formatLine(l)) + 1, 0),
    };
  }

  private async view(s: ChatSource, c: ChatRecord) {
    return {
      id: c.id, title: c.title, model: c.model, createdAt: c.createdAt, updatedAt: c.updatedAt, busy: this.busy(s, c.id),
      messages: c.messages.map(({ sent: _sent, ...m }) => m),
      meter: this.meter(s, c, await this.model(c.model)),
    };
  }

  /** The chats of the session on screen, newest first, and its chat spend against the cap. */
  list() {
    const s = this.deps.source();
    if (!s) return { sessionId: null, chats: [], spentUsd: 0 };
    const rows = this.rows(s);
    const chats = [...foldChats(rows).values()].filter((c) => !c.deleted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({
        id: c.id, title: c.title, model: c.model, createdAt: c.createdAt, updatedAt: c.updatedAt, busy: this.busy(s, c.id),
        messages: c.messages.length, costUsd: c.calls.reduce((t, k) => t + k.cost_usd, 0),
      }));
    return { sessionId: s.sessionId, chats, spentUsd: chatSpend(rows) };
  }

  async chat(id: string) {
    const s = this.need();
    return this.view(s, this.get(s, id));
  }

  /** A new, empty chat: nothing is sent, so nothing is spent, until its first question. */
  async create(model?: string) {
    const s = this.need();
    const m = model ?? this.cfg.defaultModel;
    if (!this.cfg.models.includes(m)) throw new ChatError(400, `unknown model ${m}`);
    const rows = this.rows(s);
    const n = rows.filter((r) => r.kind === "chat" && r.op === "create").length + 1;
    const row: Row = { kind: "chat", op: "create", chat_id: `chat_${n}`, title: "New chat", model: m, at: new Date().toISOString() };
    this.append(s, row);
    return this.view(s, this.get(s, row.chat_id));
  }

  async update(id: string, patch: { title?: unknown; model?: unknown }) {
    const s = this.need();
    const c = this.get(s, id);
    const at = new Date().toISOString();
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string" || !patch.title.trim()) throw new ChatError(400, "title must be a non-empty string");
      if (patch.title.trim().length > 120) throw new ChatError(400, "title is too long");
      this.append(s, { kind: "chat", op: "rename", chat_id: c.id, title: patch.title.trim(), at });
    }
    if (patch.model !== undefined) {
      if (typeof patch.model !== "string" || !this.cfg.models.includes(patch.model)) throw new ChatError(400, `unknown model ${String(patch.model)}`);
      if (patch.model !== c.model) this.append(s, { kind: "chat", op: "model", chat_id: c.id, model: patch.model, at });
    }
    return this.view(s, this.get(s, id));
  }

  /** Deletes a chat from the list; its spend stays in the recording's total. */
  remove(id: string) {
    const s = this.need();
    const c = this.get(s, id);
    this.inflight.get(`${s.sessionId}/${c.id}`)?.abort();
    this.append(s, { kind: "chat", op: "delete", chat_id: c.id, at: new Date().toISOString() });
    return { deleted: c.id };
  }

  /** Stops the reply being written: what was written so far is kept. */
  stop(id: string) {
    const s = this.need();
    const ctl = this.inflight.get(`${s.sessionId}/${id}`);
    ctl?.abort();
    return { stopped: !!ctl };
  }

  /**
   * Validates a question (or an edit of the last one, or a regeneration of the last reply) and returns the run that
   * streams the reply. Validation errors throw here, before any stream starts.
   *
   * - `send`: a new question, carrying the lines since the chat's previous question.
   * - `edit`: replaces the last question (and its reply); the new one carries every line since the question before it.
   * - `regenerate`: asks the last question again exactly as it was sent.
   */
  prepare(id: string, body: { content?: unknown; mode?: unknown }): (sink: (e: ChatEvent) => void) => Promise<void> {
    const s = this.need();
    const c = this.get(s, id);
    const mode = body.mode === "edit" || body.mode === "regenerate" ? body.mode : "send";
    if (this.busy(s, c.id)) throw new ChatError(409, "this chat is already writing a reply");
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const lastUser = c.messages.map((m) => m.role).lastIndexOf("user");
    let keep = c.messages.length;
    if (mode === "regenerate") {
      if (lastUser < 0) throw new ChatError(400, "nothing to regenerate");
      keep = lastUser + 1;
    } else {
      if (!content) throw new ChatError(400, "content is required");
      if (content.length > 20_000) throw new ChatError(400, "the question is too long");
      if (mode === "edit") {
        if (lastUser < 0) throw new ChatError(400, "nothing to edit");
        keep = lastUser;
      }
    }
    const key = `${s.sessionId}/${c.id}`;
    const ctl = new AbortController();
    this.inflight.set(key, ctl);
    return async (sink) => {
      try {
        await this.run(s, c, { mode, content, keep }, ctl, sink);
      } finally {
        this.inflight.delete(key);
      }
    };
  }

  private async run(
    s: ChatSource, c: ChatRecord, req: { mode: "send" | "edit" | "regenerate"; content: string; keep: number },
    ctl: AbortController, sink: (e: ChatEvent) => void,
  ) {
    const at = () => new Date().toISOString();
    if (req.keep < c.messages.length) {
      this.append(s, { kind: "chat", op: "rewind", chat_id: c.id, keep: req.keep, at: at() });
      c.messages = c.messages.slice(0, req.keep);
    }
    let rows = c.messageRows;
    const nextId = () => `m_${++rows}`;
    let user: ChatMessage | null = null;
    if (req.mode !== "regenerate") {
      const prev = [...c.messages].reverse().find((m) => m.lines)?.lines;
      const q = composeQuestion(prev, s.lines(), s.live, req.content);
      user = { id: nextId(), role: "user", content: req.content, at: at(), model: c.model, sent: q.sent, lines: q.lines };
      this.append(s, { kind: "chat_message", chat_id: c.id, ...user });
      c.messages.push(user);
      if (c.title === "New chat" && !c.messages.some((m) => m.role === "user" && m !== user)) {
        const title = req.content.replace(/\s+/g, " ").slice(0, 60) + (req.content.length > 60 ? "…" : "");
        this.append(s, { kind: "chat", op: "rename", chat_id: c.id, title, auto: true, at: at() });
      }
    }
    const assistantId = nextId();
    const { sent: _s, ...userView } = user ?? ({} as ChatMessage);
    sink({ type: "start", user: user ? userView : null, assistantId, model: c.model });

    const info = await this.model(c.model);
    const messages = this.history(c);
    const bodyText = JSON.stringify({
      model: c.model, messages, stream: true, usage: { include: true },
      provider: this.cfg.provider, reasoning: { effort: this.cfg.effort },
    });
    const started = Date.now();
    let content = "";
    let attempt = 0;
    const out: { genId: string | null; modelReturned: string | null; provider: string | null; usage: any } = { genId: null, modelReturned: null, provider: null, usage: null };
    let error: string | undefined;
    let stopped = false;
    for (;;) {
      attempt++;
      try {
        await this.stream(bodyText, ctl.signal, out, (ev) => {
          if (ev.type === "delta") content += ev.text;
          sink(ev);
        });
        break;
      } catch (e) {
        if (ctl.signal.aborted) { stopped = true; break; }
        const cls = classifyError(e);
        // a reply already streaming is kept as it is; only a failure before the first word is retried
        if (content || cls === "fail" || attempt >= this.cfg.maxAttempts) {
          error = describe(e, c.model);
          if (e instanceof HttpError && effectiveStatus(e) === 402 && cls === "fail") {
            try { s.budget?.exhaust("provider", "chat", "OpenRouter credits or key limit exhausted (402)"); } catch { /* reported by the event */ }
          }
          break;
        }
        await this.sleep(backoffMs(attempt, e instanceof HttpError ? e.retryAfterMs : null, this.deps.rand));
      }
    }

    // What it cost: the stream's final usage, else OpenRouter's record of the generation, else an estimate.
    let usage = out.usage;
    let cost: number | null = typeof usage?.cost === "number" ? usage.cost : null;
    let estimated = false;
    if (cost === null && out.genId) {
      const g = await this.generation(out.genId);
      if (g) {
        cost = g.cost;
        usage = { prompt_tokens: g.prompt, completion_tokens: g.completion, cost };
      }
    }
    if (cost === null && out.genId) {
      const promptTok = approxTokens(bodyText);
      const outTok = approxTokens(content);
      cost = (promptTok * (info?.inputUsdPerM ?? 0) + outTok * (info?.outputUsdPerM ?? 0)) / 1e6;
      usage = { prompt_tokens: promptTok, completion_tokens: outTok, cost };
      estimated = true;
    }
    const call: ChatCallRow = {
      kind: "chat_call", chat_id: c.id, message_id: assistantId, model: c.model, ok: !error, latency_ms: Date.now() - started, attempts: attempt,
      id: out.genId, model_returned: out.modelReturned, provider_returned: out.provider,
      usage: usage ? {
        prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0, cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      } : null,
      cost_usd: cost ?? 0,
      ...(estimated ? { estimated: true } : {}), ...(stopped ? { stopped: true } : {}), ...(error ? { error } : {}),
      at: at(),
    };
    const message: ChatMessage = {
      id: assistantId, role: "assistant", content, at: at(), model: c.model,
      ...(stopped ? { stopped: true } : {}), ...(error ? { error } : {}),
    };
    this.append(s, { kind: "chat_message", chat_id: c.id, ...message });
    this.append(s, call);
    if (call.cost_usd > 0) {
      s.budget?.record("chat", call.cost_usd);
      this.deps.onSpend?.(s);
    }
    const view = await this.view(s, this.get(s, c.id));
    if (error) sink({ type: "error", message: error, chat: view });
    sink({ type: "done", message, call, chat: view });
  }

  /** The conversation as the model sees it: every question as sent, every reply, errors left out. */
  private history(c: ChatRecord) {
    const msgs: { role: string; content: unknown }[] = [{ role: "system", content: CHAT_SYSTEM }];
    for (const m of c.messages) {
      if (m.role === "user") msgs.push({ role: "user", content: m.sent ?? m.content });
      else if (m.content) msgs.push({ role: "assistant", content: m.content });
    }
    // Anthropic models cache only up to a marked point: mark the latest question, so the whole conversation before
    // the next one is served from the cache. OpenAI and others cache a repeated prefix on their own.
    if (c.model.startsWith("anthropic/")) {
      const last = msgs.at(-1)!;
      last.content = [{ type: "text", text: String(last.content), cache_control: { type: "ephemeral" } }];
    }
    return msgs;
  }

  /** One streamed chat completion: server-sent events, each a chunk with a delta, usage in the last one. */
  private async stream(body: string, stop: AbortSignal, out: { genId: string | null; modelReturned: string | null; provider: string | null; usage: any }, emit: (e: ChatEvent) => void) {
    let res: Response;
    try {
      res = await this.deps.fetch(CHAT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.deps.apiKey}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Tattle" },
        body,
        signal: AbortSignal.any([stop, AbortSignal.timeout(this.cfg.timeoutMs)]),
      });
    } catch (e) {
      throw new HttpError(null, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, text, parseRetryAfter(res.headers.get("retry-after")));
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let thinking = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue; // ": OPENROUTER PROCESSING" keep-alives
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let j: any;
          try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new HttpError(typeof j.error.code === "number" ? j.error.code : 200, data);
          out.genId ??= j.id ?? null;
          if (j.model) out.modelReturned = j.model;
          if (j.provider) out.provider = j.provider;
          if (j.usage) out.usage = j.usage;
          const d = j.choices?.[0]?.delta;
          if (typeof d?.content === "string" && d.content) emit({ type: "delta", text: d.content });
          else if (!thinking && (d?.reasoning || d?.reasoning_details?.length)) {
            thinking = true;
            emit({ type: "thinking" });
          }
        }
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(null, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  /** OpenRouter's record of a generation (for a stopped reply, whose stream never reached its usage). */
  private async generation(id: string): Promise<{ cost: number; prompt: number; completion: number } | null> {
    for (let i = 0; i < 3; i++) {
      await this.sleep(1000 * (i + 1));
      try {
        const res = await this.deps.fetch(`${GENERATION_URL}?id=${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${this.deps.apiKey}` }, signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) continue;
        const d: any = (await res.json())?.data;
        if (typeof d?.total_cost === "number") {
          return { cost: d.total_cost, prompt: d.native_tokens_prompt ?? d.tokens_prompt ?? 0, completion: d.native_tokens_completion ?? d.tokens_completion ?? 0 };
        }
      } catch { /* try again */ }
    }
    return null;
  }
}

/** A failed reply in words the host can act on. */
function describe(e: unknown, model: string): string {
  if (e instanceof HttpError) {
    const s = effectiveStatus(e);
    let msg = "";
    try { msg = JSON.parse(e.body.slice(e.body.indexOf("{")))?.error?.message ?? ""; } catch { /* not JSON */ }
    if (s === 401) return "OpenRouter rejected the API key (401): check OPENROUTER_API_KEY.";
    if (s === 402) return "OpenRouter credits or the key's limit are exhausted (402).";
    if (s === 404 && /data policy|endpoints/i.test(msg)) {
      return `No provider of ${model} accepts this project's privacy setting (data_collection: deny). Pick another model.`;
    }
    if (s === 429) return `${model} is rate-limited right now (429). Try again in a moment, or pick another model.`;
    return msg ? `${model}: ${msg}` : e.message.slice(0, 300);
  }
  return e instanceof Error ? e.message : String(e);
}
