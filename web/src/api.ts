// The engine's HTTP API. The front end only reads /api/state and /api/events and posts commands.

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? text ?? res.statusText);
  return json as T;
}

export interface SessionSummary {
  id: string; name: string | null; notes: string | null; mode: string; startedAt: string | null; durationMs: number; ended: boolean;
  utterances: number; speakers: string[]; segments: number; claims: number; costUsd: number;
  matches?: { utteranceId: string; startMs: number; speaker: string; snippet: string }[];
}

export interface MergeSuggestion {
  fromId: string; fromName: string; fromTalkMs: number; intoId: string; intoName: string; intoTalkMs: number; stream: "host" | "remote";
  similarity: number | null; confidence: "high" | "medium" | "low"; reason: string;
}

export interface ChatModel {
  id: string; name: string; contextLength: number | null; maxOutput: number | null;
  inputUsdPerM: number | null; outputUsdPerM: number | null; cacheReadUsdPerM: number | null; available: boolean | null;
}
export interface ChatMessage {
  id: string; role: "user" | "assistant"; content: string; at: string; model?: string; stopped?: boolean; error?: string;
  lines?: { from: number; to: number; upToMs: number | null; live: boolean };
}
export interface ChatMeter {
  model: string; contextLength: number | null; contextTokens: number; leftTokens: number | null;
  inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number; estimated: boolean;
  pendingLines: number; pendingTokens: number;
}
export interface Chat { id: string; title: string; model: string; createdAt: string; updatedAt: string; busy: boolean; messages: ChatMessage[]; meter: ChatMeter }
export interface ChatList {
  sessionId: string | null; spentUsd: number; capUsd: number;
  chats: { id: string; title: string; model: string; updatedAt: string; busy: boolean; messages: number; costUsd: number }[];
}
export type ChatStreamEvent =
  | { type: "start"; user: ChatMessage | null; assistantId: string; model: string }
  | { type: "thinking" }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage; chat: Chat }
  | { type: "error"; message: string; chat: Chat | null };

/** Posts a question and reads the streamed reply (server-sent events over the POST's response). */
async function streamChat(id: string, body: { content?: string; mode?: string }, on: (e: ChatStreamEvent) => void): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text)?.error ?? text; } catch { /* not JSON */ }
    throw new ApiError(res.status, msg || res.statusText);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) on(JSON.parse(data));
    }
  }
}

export const api = {
  state: () => call<any>("GET", "/api/state"),
  about: () => call<{ name: string; version: string; license: { id: string | null; holder: string | null; text: string } }>("GET", "/api/about"),
  closeView: () => call<{ closed: string | null }>("POST", "/api/sessions/close"),
  calls: (system: "s1" | "s2", limit = 300) =>
    call<{ rows: unknown[]; models: { s1: string | null; s2: string | null } }>("GET", `/api/calls?system=${system}&limit=${limit}`),
  engine: () => call<{ startedAt: string; stale: boolean }>("GET", "/api/engine"),
  stats: () => call<any>("GET", "/api/stats"),
  devices: () => call<{ uid: string; name: string; transport: string; isDefault: boolean }[]>("GET", "/api/devices"),
  startReplay: (dir: string, speed: 1 | "max", voices?: number) => call<{ sessionId: string }>("POST", "/api/session/start", { mode: "replay", dir, speed, voices }),
  startLive: (mic?: string, voices?: number) => call<{ sessionId: string }>("POST", "/api/session/start", { mode: "live", ...(mic ? { mic } : {}), voices }),
  stop: () => call<{ sessionId: string }>("POST", "/api/session/stop"),
  rename: (id: string, displayName: string) => call("POST", `/api/speakers/${encodeURIComponent(id)}/rename`, { displayName }),
  suggestMerges: (voices?: number) => call<{ suggestions: MergeSuggestion[]; voices: { host: number; remote: number } }>(
    "GET", `/api/speakers/suggestions${voices === undefined ? "" : `?voices=${voices}`}`),
  merge: (fromId: string, intoId: string) => call("POST", "/api/speakers/merge", { fromId, intoId }),
  putLabels: (set: unknown) => call<{ version: string }>("PUT", "/api/labels", set),
  relabel: () => call<{ segments: number }>("POST", "/api/labels/relabel"),
  putStories: (headlines: string[]) => call<{ version: string }>("PUT", "/api/stories", { headlines }),
  override: (claimId: string, note?: string) => call("POST", `/api/claims/${encodeURIComponent(claimId)}/override`, note ? { note } : {}),
  sessions: (q = "") => call<SessionSummary[]>("GET", `/api/sessions${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  renameSession: (id: string, name: string) => call<SessionSummary>("PATCH", `/api/sessions/${encodeURIComponent(id)}`, { name }),
  openSession: (id: string) => call<{ sessionId: string; events: number }>("POST", `/api/sessions/${encodeURIComponent(id)}/open`),
  replaySession: (sessionId: string, speed: 1 | "max", voices?: number) => call<{ sessionId: string }>("POST", "/api/session/start", { mode: "replay", sessionId, speed, voices }),
  pause: () => call<{ paused: boolean }>("POST", "/api/session/pause"),
  resume: () => call<{ paused: boolean }>("POST", "/api/session/resume"),
  deleteSession: (id: string) => call<{ deleted: string }>("DELETE", `/api/sessions/${encodeURIComponent(id)}`),
  chatModels: () => call<{ default: string; capUsd: number; models: ChatModel[] }>("GET", "/api/chat/models"),
  chats: () => call<ChatList>("GET", "/api/chats"),
  chat: (id: string) => call<Chat>("GET", `/api/chats/${encodeURIComponent(id)}`),
  createChat: (model: string) => call<Chat>("POST", "/api/chats", { model }),
  updateChat: (id: string, patch: { title?: string; model?: string }) => call<Chat>("PATCH", `/api/chats/${encodeURIComponent(id)}`, patch),
  deleteChat: (id: string) => call<{ deleted: string }>("DELETE", `/api/chats/${encodeURIComponent(id)}`),
  stopChat: (id: string) => call<{ stopped: boolean }>("POST", `/api/chats/${encodeURIComponent(id)}/stop`),
  sendChat: streamChat,
  rollback: (version: string) => call<{ active: string }>("POST", "/api/s1/rollback", { version }),
};
