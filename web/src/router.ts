// The page's URLs, so a refresh, a bookmark, or Back lands on the same view:
//
//   /                          home: the session on air (live or replay), or none
//   /recordings/<id>           that recording, opened read-only
//   ?t=1:23:45                 the playback position in a recording
//   ?tab=thinking | jev-log    the right column's tab (fact-check is the default)
//   ?panel=recordings | insights | speakers | labels | transcription | chat | keys     the window that is open
//   ?panel=insights&section=fact-checker | log     the Insights tab (Overview is the default)
//   ?panel=chat&chat=chat_2    a chat of the session on screen
//
// Before Insights (28 September 2026), Stats, System 1, and Log were windows of their own: ?panel=stats, system-1, and
// log still open their tab of it.
//
// The URL follows what is on screen (history entries for a change of recording, silent updates for the rest), and
// opening a URL — on load, or with Back and Forward — makes the screen match it.

export interface Route {
  recording: string | null; t: number | null; tab: string | null; panel: string | null; chat?: string | null; section?: string | null;
}

export const TABS: Record<string, string> = { "fact-check": "pane-fc", thinking: "pane-think", "jev-log": "pane-jev" };
export const PANELS: Record<string, string> = {
  recordings: "dlg-recordings", insights: "dlg-insights", speakers: "dlg-speakers", labels: "dlg-labels",
  transcription: "dlg-transcription", chat: "dlg-chat", keys: "dlg-keys",
};
/** The Insights window's tabs, Overview first (the default). */
export const SECTIONS = ["overview", "fact-checker", "log"] as const;
/** The windows Insights replaced, and the tab each one is now. */
const FORMER: Record<string, string> = { stats: "overview", "system-1": "fact-checker", log: "log" };
const nameOf = (map: Record<string, string>, value: string) => Object.keys(map).find((k) => map[k] === value) ?? null;
export const tabName = (paneId: string) => nameOf(TABS, paneId);
export const panelName = (dialogId: string) => nameOf(PANELS, dialogId);

/** "1:23:45", "58:27", or "83" (seconds) → ms. */
export function parseTime(s: string | null): number | null {
  if (!s) return null;
  const parts = s.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

export function formatTime(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function readRoute(loc: { pathname: string; search: string } = location): Route {
  const m = /^\/recordings\/([A-Za-z0-9][A-Za-z0-9_-]*)\/?$/.exec(loc.pathname);
  const q = new URLSearchParams(loc.search);
  const tab = q.get("tab");
  const former = FORMER[q.get("panel") ?? ""];
  const panel = former ? "insights" : q.get("panel");
  const section = former ?? q.get("section");
  const chat = q.get("chat");
  return {
    recording: m ? decodeURIComponent(m[1]!) : null,
    t: m ? parseTime(q.get("t")) : null,
    tab: tab && TABS[tab] ? tab : null,
    panel: panel && PANELS[panel] ? panel : null,
    chat: panel === "chat" && chat && /^chat_\d+$/.test(chat) ? chat : null,
    section: panel === "insights" && (SECTIONS as readonly (string | null)[]).includes(section) ? section : null,
  };
}

export function buildUrl(r: Route): string {
  const q = new URLSearchParams();
  if (r.recording && r.t !== null && r.t > 0) q.set("t", formatTime(r.t));
  if (r.tab && r.tab !== "fact-check") q.set("tab", r.tab);

  if (r.panel) q.set("panel", r.panel);
  if (r.panel === "chat" && r.chat) q.set("chat", r.chat);
  if (r.panel === "insights" && r.section && r.section !== "overview") q.set("section", r.section);
  const qs = q.toString().replace(/%3A/g, ":");
  return `${r.recording ? `/recordings/${encodeURIComponent(r.recording)}` : "/"}${qs ? `?${qs}` : ""}`;
}

/** Updates part of the URL: a new history entry when `push` (a change of recording), else a silent replace. */
export function setRoute(patch: Partial<Route>, push = false) {
  const next = { ...readRoute(), ...patch };
  if (patch.recording !== undefined && patch.recording !== readRoute().recording) next.t = patch.t ?? null;
  const url = buildUrl(next);
  if (url === `${location.pathname}${location.search}`) return;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}
