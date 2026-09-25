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

export const api = {
  state: () => call<any>("GET", "/api/state"),
  calls: (system: "s1" | "s2", limit = 300) =>
    call<{ rows: unknown[]; models: { s1: string | null; s2: string | null } }>("GET", `/api/calls?system=${system}&limit=${limit}`),
  engine: () => call<{ startedAt: string; stale: boolean }>("GET", "/api/engine"),
  stats: () => call<any>("GET", "/api/stats"),
  devices: () => call<{ uid: string; name: string; transport: string; isDefault: boolean }[]>("GET", "/api/devices"),
  startReplay: (dir: string, speed: 1 | "max") => call<{ sessionId: string }>("POST", "/api/session/start", { mode: "replay", dir, speed }),
  startLive: (mic?: string) => call<{ sessionId: string }>("POST", "/api/session/start", { mode: "live", ...(mic ? { mic } : {}) }),
  stop: () => call<{ sessionId: string }>("POST", "/api/session/stop"),
  rename: (id: string, displayName: string) => call("POST", `/api/speakers/${encodeURIComponent(id)}/rename`, { displayName }),
  merge: (fromId: string, intoId: string) => call("POST", "/api/speakers/merge", { fromId, intoId }),
  putLabels: (set: unknown) => call<{ version: string }>("PUT", "/api/labels", set),
  relabel: () => call<{ segments: number }>("POST", "/api/labels/relabel"),
  putStories: (headlines: string[]) => call<{ version: string }>("PUT", "/api/stories", { headlines }),
  override: (claimId: string, note?: string) => call("POST", `/api/claims/${encodeURIComponent(claimId)}/override`, note ? { note } : {}),
  sessions: (q = "") => call<SessionSummary[]>("GET", `/api/sessions${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  renameSession: (id: string, name: string) => call<SessionSummary>("PATCH", `/api/sessions/${encodeURIComponent(id)}`, { name }),
  openSession: (id: string) => call<{ sessionId: string; events: number }>("POST", `/api/sessions/${encodeURIComponent(id)}/open`),
  replaySession: (sessionId: string, speed: 1 | "max") => call<{ sessionId: string }>("POST", "/api/session/start", { mode: "replay", sessionId, speed }),
  pause: () => call<{ paused: boolean }>("POST", "/api/session/pause"),
  resume: () => call<{ paused: boolean }>("POST", "/api/session/resume"),
  deleteSession: (id: string) => call<{ deleted: string }>("DELETE", `/api/sessions/${encodeURIComponent(id)}`),
  rollback: (version: string) => call<{ active: string }>("POST", "/api/s1/rollback", { version }),
};
