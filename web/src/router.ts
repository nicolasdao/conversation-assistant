// The page's URLs, so a refresh, a bookmark, or Back lands on the same view:
//
//   /                          home: the session on air (live or replay), or none
//   /recordings/<id>           that recording, opened read-only
//   ?t=1:23:45                 the playback position in a recording
//   ?tab=thinking | jev-log    the right column's tab (fact-check is the default)
//   ?panel=recordings | speakers | system-1 | labels | stats | log     the settings window that is open
//
// The URL follows what is on screen (history entries for a change of recording, silent updates for the rest), and
// opening a URL — on load, or with Back and Forward — makes the screen match it.

export interface Route { recording: string | null; t: number | null; tab: string | null; panel: string | null }

export const TABS: Record<string, string> = { "fact-check": "pane-fc", thinking: "pane-think", "jev-log": "pane-jev" };
export const PANELS: Record<string, string> = {
  recordings: "dlg-recordings", "system-1": "dlg-s1", speakers: "dlg-speakers", labels: "dlg-labels", stats: "dlg-stats", log: "dlg-log",
};
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
  const panel = q.get("panel");
  return {
    recording: m ? decodeURIComponent(m[1]!) : null,
    t: m ? parseTime(q.get("t")) : null,
    tab: tab && TABS[tab] ? tab : null,
    panel: panel && PANELS[panel] ? panel : null,
  };
}

export function buildUrl(r: Route): string {
  const q = new URLSearchParams();
  if (r.recording && r.t !== null && r.t > 0) q.set("t", formatTime(r.t));
  if (r.tab && r.tab !== "fact-check") q.set("tab", r.tab);
  if (r.panel) q.set("panel", r.panel);
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
