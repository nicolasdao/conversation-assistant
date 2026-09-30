// The engine's HTTP API. The front end only reads /api/state and /api/events and posts commands.

export class ApiError extends Error {
  /** `body`: the error's JSON, which may say which key is missing (`needsKey`) or that Apple's model is getting ready (`preparing`). */
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> | null = null) {
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
  // an empty body must still say something: the message is what the toast shows
  if (!res.ok) throw new ApiError(res.status, json?.error ?? (text || `${res.status} ${res.statusText}`.trim()), json && typeof json === "object" ? json : null);
  return json as T;
}

export interface SessionSummary {
  id: string; name: string | null; notes: string | null; mode: string; startedAt: string | null; durationMs: number; ended: boolean;
  utterances: number; speakers: string[]; segments: number; claims: number; costUsd: number;
  hasAudio?: boolean; appVersion?: string | null; imported?: { at: string; exportedWith: string | null; fileName: string | null } | null;
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
  sessionId: string | null; spentUsd: number;
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

export type KeyName = "openai" | "openrouter";
export interface KeyStatus { name: KeyName; env: string; set: boolean; source: "environment" | "file" | null; hint: string | null }
/** `required`: the keys the app cannot open without, which follow the transcription engine (OpenAI's, or none). */
export interface SetupStatus { configured: boolean; required: KeyName[]; keys: KeyStatus[]; path: string }

export type TranscriptionEngine = "apple" | "openai";
export type ModelState = "missing" | "installing" | "installed" | "error";
export interface TranscriptionStatus {
  engine: TranscriptionEngine;
  saved: TranscriptionEngine | null;
  apple: { available: boolean; reason: string | null; model: ModelState; fraction: number | null; error: string | null };
  openai: { keySet: boolean };
}
export type Features = { factcheck: boolean; labels: boolean };
/** What Start live and replays send beyond the features: the label set (null: labels off) and tonight's stories. */
export interface Labelling { labelSet?: string | null; stories?: string[] }

/** One set in the library (GET /api/label-sets). `broken`: a file that cannot be used, and why. */
export interface LabelSetEntry {
  id: string; name: string; description: string; builtIn: boolean; perHourUsd?: number;
  counts: { categories: number; scores: number; markers: number }; broken?: string;
}
/** The library, and the locked boundary question every set shares (shown read-only in the editor). */
export interface LabelSetList { sets: LabelSetEntry[]; boundary?: { instructions: string; criteria?: { true: string; false: string } } }
export interface LabelSetCheck { ok: boolean; errors: string[]; tokens: number; perHourUsd: number; overLimit: boolean }
/** One turn of Create with AI's interview (src/labels/assist.ts). */
export interface AssistTurn {
  reply: string; question: string; choices: string[]; set: any | null; skipped: string[];
  checklist: { items: { id: string; label: string; status: "todo" | "recommended" | "done" | "skipped"; detail?: string }[]; complete: boolean; errors: string[] };
  costUsd: number; spentUsd: number; error?: string;
}
/** Try on a recording: the draft's labels for the segments of its first minutes, and the recording's own. */
export interface LabelTry {
  segments: { id: string; startMs: number; endMs: number }[];
  labels: any[];
  recording: { features: Features; set: any | null; labels: any[] };
  costUsd: number; failed: number; window: { startMs: number; endMs: number } | null;
}
export interface KeyCheck { ok: boolean; message: string; warning?: string }
export interface SaveKeysResult extends SetupStatus { saved: boolean; checks: Partial<Record<KeyName, KeyCheck>> }

export interface ExportInfo {
  id: string; name: string | null; fileName: string; recordedWith: string | null; app: { name: string; version: string };
  bytes: Record<"compressed" | "original" | "none", number>; chats: number; hasAudio: boolean;
}
/** `copyToken`: when the library already had it, the upload is kept for 15 minutes so it can be imported again as a copy. */
export interface LicenseComponent { title: string; license: string; body: string; files: string[] }
export interface Licenses {
  app: { name: string; version: string; license: string | null; holder: string | null; text: string };
  groups: { title: string; components: LicenseComponent[] }[];
  texts: Record<string, string>;
}
export interface ImportResult { summary: SessionSummary; already: boolean; copyToken?: string }

/** Uploads a recording file with progress (fetch cannot report upload progress). */
function importRecording(file: File, onProgress: (done: number) => void): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/sessions/import");
    x.setRequestHeader("Content-Type", "application/octet-stream");
    x.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let json: any = null;
      try { json = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(json);
      else reject(new ApiError(x.status, json?.error ?? x.statusText));
    };
    x.onerror = () => reject(new ApiError(0, "the upload failed: is the server running?"));
    x.send(file);
  });
}

export const api = {
  state: () => call<any>("GET", "/api/state"),
  setup: () => call<SetupStatus>("GET", "/api/setup"),
  saveKeys: (keys: Partial<Record<KeyName, string>>) => call<SaveKeysResult>("POST", "/api/setup/keys", keys),
  transcription: () => call<TranscriptionStatus>("GET", "/api/transcription"),
  setTranscription: (engine: TranscriptionEngine) => call<TranscriptionStatus>("PUT", "/api/transcription", { engine }),
  installModel: () => call<TranscriptionStatus>("POST", "/api/transcription/install"),
  about: () => call<{ name: string; version: string; license: { id: string | null; holder: string | null; text: string } }>("GET", "/api/about"),
  licenses: () => call<Licenses>("GET", "/api/licenses"),
  closeView: () => call<{ closed: string | null }>("POST", "/api/sessions/close"),
  calls: (system: "s1" | "s2", limit = 300) =>
    call<{ rows: unknown[]; models: { s1: string | null; s2: string | null } }>("GET", `/api/calls?system=${system}&limit=${limit}`),
  engine: () => call<{ startedAt: string; stale: boolean }>("GET", "/api/engine"),
  stats: () => call<any>("GET", "/api/stats"),
  devices: () => call<{ uid: string; name: string; transport: string; isDefault: boolean }[]>("GET", "/api/devices"),
  startReplay: (dir: string, speed: 1 | "max", voices?: number, features?: Features, labelling: Labelling = {}) =>
    call<{ sessionId: string }>("POST", "/api/session/start", { mode: "replay", dir, speed, voices, features, ...labelling }),
  startLive: (mic?: string, voices?: number, features?: Features, labelling: Labelling = {}) =>
    call<{ sessionId: string }>("POST", "/api/session/start", { mode: "live", ...(mic ? { mic } : {}), voices, features, ...labelling }),
  stop: () => call<{ sessionId: string }>("POST", "/api/session/stop"),
  rename: (id: string, displayName: string) => call("POST", `/api/speakers/${encodeURIComponent(id)}/rename`, { displayName }),
  suggestMerges: (voices?: number) => call<{ suggestions: MergeSuggestion[]; voices: { host: number; remote: number } }>(
    "GET", `/api/speakers/suggestions${voices === undefined ? "" : `?voices=${voices}`}`),
  merge: (fromId: string, intoId: string) => call("POST", "/api/speakers/merge", { fromId, intoId }),
  relabel: () => call<{ segments: number }>("POST", "/api/labels/relabel"),
  putStories: (headlines: string[]) => call<{ version: string }>("PUT", "/api/stories", { headlines }),
  override: (claimId: string, note?: string) => call("POST", `/api/claims/${encodeURIComponent(claimId)}/override`, note ? { note } : {}),
  sessions: (q = "") => call<SessionSummary[]>("GET", `/api/sessions${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  renameSession: (id: string, name: string) => call<SessionSummary>("PATCH", `/api/sessions/${encodeURIComponent(id)}`, { name }),
  openSession: (id: string) => call<{ sessionId: string; events: number }>("POST", `/api/sessions/${encodeURIComponent(id)}/open`),
  replaySession: (sessionId: string, speed: 1 | "max", voices?: number, features?: Features, labelling: Labelling = {}) =>
    call<{ sessionId: string }>("POST", "/api/session/start", { mode: "replay", sessionId, speed, voices, features, ...labelling }),
  pause: () => call<{ paused: boolean }>("POST", "/api/session/pause"),
  resume: () => call<{ paused: boolean }>("POST", "/api/session/resume"),
  deleteSession: (id: string) => call<{ deleted: string }>("DELETE", `/api/sessions/${encodeURIComponent(id)}`),
  chatModels: () => call<{ default: string; models: ChatModel[] }>("GET", "/api/chat/models"),
  chats: () => call<ChatList>("GET", "/api/chats"),
  chat: (id: string) => call<Chat>("GET", `/api/chats/${encodeURIComponent(id)}`),
  createChat: (model: string) => call<Chat>("POST", "/api/chats", { model }),
  updateChat: (id: string, patch: { title?: string; model?: string }) => call<Chat>("PATCH", `/api/chats/${encodeURIComponent(id)}`, patch),
  deleteChat: (id: string) => call<{ deleted: string }>("DELETE", `/api/chats/${encodeURIComponent(id)}`),
  stopChat: (id: string) => call<{ stopped: boolean }>("POST", `/api/chats/${encodeURIComponent(id)}/stop`),
  sendChat: streamChat,
  exportInfo: (id: string) => call<ExportInfo>("GET", `/api/sessions/${encodeURIComponent(id)}/export`),
  exportPrepare: (id: string, audio: string, chats: boolean) =>
    call<{ token: string; fileName: string; bytes: number }>("POST", `/api/sessions/${encodeURIComponent(id)}/export`, { audio, chats }),
  importRecording,
  importCopy: (token: string, name: string) => call<ImportResult>("POST", `/api/sessions/import/${encodeURIComponent(token)}`, { name }),
  rollback: (version: string) => call<{ active: string }>("POST", "/api/s1/rollback", { version }),
  labelSets: () => call<LabelSetList>("GET", "/api/label-sets"),
  labelSet: <T = unknown>(id: string) => call<T>("GET", `/api/label-sets/${encodeURIComponent(id)}`),
  createLabelSet: <T = unknown>(set: unknown) => call<T>("POST", "/api/label-sets", set),
  updateLabelSet: <T = unknown>(id: string, set: unknown) => call<T>("PUT", `/api/label-sets/${encodeURIComponent(id)}`, set),
  deleteLabelSet: (id: string) => call<{ deleted: string }>("DELETE", `/api/label-sets/${encodeURIComponent(id)}`),
  cloneLabelSet: <T = unknown>(id: string) => call<T>("POST", `/api/label-sets/${encodeURIComponent(id)}/clone`),
  importLabelSet: <T = unknown>(file: unknown) => call<T>("POST", "/api/label-sets/import", file),
  checkLabelSet: (draft: unknown) => call<LabelSetCheck>("POST", "/api/label-sets/estimate", draft),
  labelSetExportUrl: (id: string) => `/api/label-sets/${encodeURIComponent(id)}/export`,
  tryLabelSet: (set: unknown, sessionId: string, minutes = 10) => call<LabelTry>("POST", "/api/label-sets/try", { set, sessionId, minutes }),
  assistLabels: (conversationId: string, messages: { role: "user" | "assistant"; content: string }[], draft: unknown | null, skipped: string[]) =>
    call<AssistTurn>("POST", "/api/label-sets/assist", { conversationId, messages, draft, skipped }),
};
