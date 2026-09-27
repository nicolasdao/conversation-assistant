import { api, ApiError, type MergeSuggestion, type SessionSummary } from "./api.js";
import { openExport, openImport } from "./transfer.js";
import { $, clock, glyph, h, pretty, replace, usd } from "./dom.js";
import { MARKERS, SUBJECT_COLORS } from "./timeline.js";
import { featuresOf, resolveSpeaker, s1Counters, speakerName, type MissingLine, type Utterance, type Claim, type LabelQuestion, type LabelSet, type Segment, type State, type Stream } from "./state.js";

export interface Filters { markers: Set<string>; speaker: string; subject: string }
export const filters: Filters = { markers: new Set(), speaker: "", subject: "" };

export function toast(message: string, kind: "error" | "ok" = "error") {
  const box = $("#toasts");
  if (!box) return;
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  box.append(t);
  // Re-open the popover so it stacks above any modal opened since.
  if (box.matches(":popover-open")) box.hidePopover();
  box.showPopover();
  setTimeout(() => {
    t.remove();
    if (!box.children.length && box.matches(":popover-open")) box.hidePopover();
  }, 6000);
}

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok, "ok");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

/** True while the user is typing inside `box`, so a re-render would throw away their input. */
function editing(box: Element | null): boolean {
  const a = document.activeElement;
  return !!box && !!a && box.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

// ---------- in-page prompt and confirm ----------

/**
 * Asks in the page's own dialog. With `input`, resolves to the typed text (or null when cancelled);
 * without, resolves to "" when confirmed (or null).
 */
export function ask(title: string, opts: { message?: string; input?: boolean; value?: string; placeholder?: string; ok?: string; danger?: boolean } = {}): Promise<string | null> {
  const dlg = $<HTMLDialogElement>("#dlg-ask")!;
  const input = $<HTMLInputElement>("#ask-input")!;
  replace($("#h-ask"), title);
  replace($("#ask-message"), opts.message ?? "");
  input.hidden = !opts.input;
  input.value = opts.value ?? "";
  input.placeholder = opts.placeholder ?? "";
  replace($("#ask-ok"), opts.ok ?? "OK");
  $("#ask-ok")!.className = `btn ${opts.danger ? "danger" : "primary"}`;
  dlg.returnValue = "";
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? (opts.input ? input.value : "") : null), { once: true });
    dlg.showModal();
    if (opts.input) input.select(); else $<HTMLButtonElement>("#ask-ok")?.focus();
  });
}

// ---------- header: session, controls, menu ----------

const MIC_KEY = "pa.mic";

/**
 * Lists the Mac's microphones. Called each time Start live opens, because earbuds or a USB mic connected after the page
 * loaded must show up. Keeps the current choice, else the one used last time, if that microphone is still there.
 */
export async function loadDevices() {
  const sel = $<HTMLSelectElement>("#mic");
  if (!sel) return;
  let want = sel.value;
  try { want = localStorage.getItem(MIC_KEY) ?? want; } catch { /* storage may be unavailable */ }
  try {
    const devices = await api.devices();
    replace(sel, h("option", { value: "builtin" }, "Built-in microphone"),
      devices.filter((d) => d.transport !== "builtin").map((d) => h("option", { value: d.uid }, `${d.name} (${d.transport})`)));
    sel.title = "";
    if ([...sel.options].some((o) => o.value === want)) sel.value = want;
  } catch (e) {
    replace(sel, h("option", { value: "" }, "Capture helper unavailable"));
    sel.title = e instanceof Error ? e.message : String(e);
  }
}

let replaySpeed: 1 | "max" = 1;

let onViewGone: () => void = () => {};

/** How many people are on the call, from the header picker (0 = any number). */
const voicesOnCall = () => Number($<HTMLSelectElement>("#voices")?.value ?? 0);

/** The menu footer: the version from package.json, and the license, which opens in full in a window. */
async function bindAbout() {
  $("#license-link")?.addEventListener("click", () => {
    closePops();
    $<HTMLDialogElement>("#dlg-license")?.showModal();
  });
  try {
    const a = await api.about();
    replace($("#app-version"), `v${a.version}`);
    $("#app-version")!.title = `${a.name} ${a.version}`;
    replace($("#license-sub"), `${a.license.id ?? ""} · ${a.license.holder ?? ""}`);
    replace($("#license-text"), a.license.text || "No LICENSE file.");
  } catch { /* an older server has no /api/about */ }
}

/**
 * Opens and closes the replay popover and the settings menu; `onOpen` renders a settings dialog before it shows, and
 * `viewGone` reloads the page's state after the recording on screen was deleted.
 */
export function bindControls(onOpen: (dialogId: string) => void, viewGone: () => void) {
  onViewGone = viewGone;
  void bindAbout();
  $("#onair")?.addEventListener("animationend", (e) => {
    if (e.animationName === "onair-sweep") { entering = false; $("#onair")!.classList.remove("enter"); }
  });
  $("#pause")?.addEventListener("click", () => {
    const paused = $("#pause")!.dataset.paused === "1";
    void run(() => (paused ? api.resume() : api.pause()), paused ? "Resumed" : "Paused: nothing is heard or transcribed until you resume");
  });
  $("#start-live")?.addEventListener("click", () => openStartLive());
  bindStartLive();
  $("#start-replay")?.addEventListener("click", () => {
    const dir = $<HTMLInputElement>("#replay-dir")!.value.trim();
    closePops();
    void run(() => api.startReplay(dir, replaySpeed, voicesOnCall()));
  });
  $("#stop")?.addEventListener("click", () => run(() => api.stop(), "Stopping: in-flight work will finish"));
  document.querySelectorAll<HTMLButtonElement>("#replay-speed button").forEach((b) => b.addEventListener("click", () => {
    replaySpeed = b.dataset.speed === "max" ? "max" : 1;
    document.querySelectorAll("#replay-speed button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));

  const pops: [string, string][] = [["#replay-btn", "#replay-pop"], ["#cog-btn", "#cog-menu"]];
  for (const [btnSel, popSel] of pops) {
    $(btnSel)?.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = $(popSel)!;
      const opening = pop.hidden;
      closePops();
      pop.hidden = !opening;
      $(btnSel)!.setAttribute("aria-expanded", String(opening));
      if (opening) pop.querySelector<HTMLElement>("input, button")?.focus();
    });
  }
  document.addEventListener("click", (e) => {
    for (const [, popSel] of pops) if (!$(popSel)?.contains(e.target as Node)) closePops(popSel);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePops(); });

  document.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => b.addEventListener("click", () => {
    closePops();
    const id = b.dataset.open!;
    onOpen(id);
    $<HTMLDialogElement>(`#${id}`)?.showModal();
  }));
  document.querySelectorAll<HTMLDialogElement>("dialog").forEach((d) => {
    d.querySelectorAll("[data-close]").forEach((x) => x.addEventListener("click", () => d.close()));
    d.querySelectorAll("[data-cancel]").forEach((x) => x.addEventListener("click", () => d.close("cancel")));
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); // a click on the backdrop
  });
}

// ---------- Start live: choose the features ----------

/** Rough cost per hour of show (README): transcription always, Jev for labels or fact-checking, System 2 for fact-checking. */
const PER_HOUR = { transcript: 1.23, jev: 0.04, factcheck: 0.35 };

const feature = (id: "factcheck" | "labels") => $<HTMLButtonElement>(`#feat-${id}`)!;
const isOn = (id: "factcheck" | "labels") => feature(id).getAttribute("aria-checked") === "true";

function renderStartSummary() {
  const fc = isOn("factcheck"), lb = isOn("labels");
  const perHour = PER_HOUR.transcript + (fc || lb ? PER_HOUR.jev : 0) + (fc ? PER_HOUR.factcheck : 0);
  const what = fc && lb ? "Everything on" : !fc && !lb ? "Transcript only: Jev and System 2 are not called" : fc ? "No labels" : "No fact-checking";
  replace($("#start-summary"), h("b", {}, what), h("br", {}), `About $${perHour.toFixed(2)} an hour${fc ? " at most" : ""}.`);
}

/** Start live asks first: every feature is on unless the host turns it off, for this session only. */
function openStartLive() {
  void loadDevices();
  // each show starts at "Any number": who is on the call changes from show to show
  const voices = $<HTMLSelectElement>("#voices");
  if (voices) voices.value = "0";
  for (const id of ["factcheck", "labels"] as const) feature(id).setAttribute("aria-checked", "true");
  renderStartSummary();
  const d = $<HTMLDialogElement>("#dlg-start")!;
  d.showModal();
  $<HTMLButtonElement>("#start-go")?.focus();
}

function bindStartLive() {
  for (const id of ["factcheck", "labels"] as const) {
    feature(id).addEventListener("click", () => {
      feature(id).setAttribute("aria-checked", String(!isOn(id)));
      renderStartSummary();
    });
  }
  $("#start-go")?.addEventListener("click", () => {
    const features = { factcheck: isOn("factcheck"), labels: isOn("labels") };
    const mic = $<HTMLSelectElement>("#mic")?.value;
    if (mic) try { localStorage.setItem(MIC_KEY, mic); } catch { /* storage may be unavailable */ }
    $<HTMLDialogElement>("#dlg-start")!.close();
    void run(() => api.startLive($<HTMLSelectElement>("#mic")?.value || undefined, voicesOnCall(), features));
  });
}

function closePops(only?: string) {
  for (const [btnSel, popSel] of [["#replay-btn", "#replay-pop"], ["#cog-btn", "#cog-menu"]]) {
    if (only && only !== popSel) continue;
    const pop = $(popSel);
    if (pop && !pop.hidden) { pop.hidden = true; $(btnSel)?.setAttribute("aria-expanded", "false"); }
  }
}

/**
 * Edits a name in place: `target` is hidden and an input takes its spot. Enter or leaving the field saves,
 * Escape cancels; `save` gets the trimmed text and runs only when it changed.
 */
function editInPlace(target: HTMLElement, opts: { value: string; placeholder: string; cls: string; save: (name: string) => Promise<void> }) {
  const input = h("input", { class: opts.cls, value: opts.value, placeholder: opts.placeholder, maxlength: 120, "aria-label": "Name" });
  target.hidden = true;
  target.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.remove();
    target.hidden = false;
    if (save && name !== opts.value) void opts.save(name);
    else target.focus();
  };
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

/** Click the session name in the header to rename it in place. */
export function bindSessionName(getState: () => State, onRenamed: () => void) {
  const btn = $<HTMLButtonElement>("#session-name");
  btn?.addEventListener("click", () => {
    const s = getState().session;
    if (!s || btn.hidden) return;
    editInPlace(btn, {
      value: s.name ?? "", placeholder: s.id, cls: "name-input",
      save: (name) => run(async () => {
        const r = await api.renameSession(s.id, name);
        const cur = getState().session;
        if (cur?.id === s.id) cur.name = r.name;
        onRenamed();
      }, name ? `Session renamed to ${name}` : "Session name cleared"),
    });
  });
}

/** The block at the header's left, only while a session is capturing: [class, label]. */
const ONAIR: Record<string, [string, string]> = {
  live: ["", "On air"], paused: ["paused", "Paused"], replay: ["replay", "Replay"],
};
/** The block shown on the previous render; undefined before the first, so a page opened mid-show does not animate. */
let shownBlock: string | null | undefined;
let entering = false;

export function renderSession(st: State) {
  const s = st.session;
  const running = s?.status === "running" || s?.status === "ending";
  const block = !running ? null : s!.mode === "replay" ? "replay" : s!.paused ? "paused" : "live";
  const onair = $("#onair")!;
  $("#top")!.classList.toggle("no-onair", !block);
  // on air, the controls that only apply to starting a session make way for the ones that work now
  $("#top")!.classList.toggle("on-air", running);
  onair.hidden = !block;
  if (block) {
    const [cls, label] = ONAIR[block]!;
    if (shownBlock === null) entering = true; // off → on: the breaking-news entrance
    onair.className = `onair${cls ? ` ${cls}` : ""}${entering ? " enter" : ""}`;
    replace($("#onair-label"), s?.status === "ending" ? "Stopping" : label);
  }
  shownBlock = block;
  const name = s ? s.name || s.id : "No session";
  const nameBtn = $<HTMLButtonElement>("#session-name")!;
  replace(nameBtn, name);
  nameBtn.disabled = !s;
  nameBtn.title = s ? `Click to rename · ${s.mode} session ${s.id}` : "";
  for (const id of ["#start-live", "#start-replay"]) $<HTMLButtonElement>(id)!.disabled = running;
  $<HTMLButtonElement>("#stop")!.disabled = !running;
  // Stop only exists while something is on air
  $<HTMLButtonElement>("#stop")!.hidden = !running;
  const pause = $<HTMLButtonElement>("#pause")!;
  pause.hidden = !(running && s?.mode === "live");
  pause.disabled = s?.status !== "running";
  pause.dataset.paused = s?.paused ? "1" : "0";
  pause.setAttribute("aria-pressed", String(!!s?.paused));
  replace(pause, glyph(s?.paused ? "play" : "pause"), s?.paused ? "Resume" : "Pause");
  pause.title = s?.paused ? "Resume listening" : "Pause: audio becomes silence until you resume; Stop still works";
  replace($("#replay-note"), running ? "Stop the current session first." : "");
  // a session that runs without some features says so, next to its name
  const f = featuresOf(st);
  const chip = $("#features-chip")!;
  const off = !s ? "" : !f.factcheck && !f.labels ? "Transcript only" : !f.factcheck ? "No fact-check" : !f.labels ? "No labels" : "";
  chip.hidden = !off;
  replace(chip, off);
  chip.title = off ? "Chosen when the session started; it stays this way for the whole session" : "";
  $("#tl")!.classList.toggle("labels-off", !!s && !f.labels);
}

/** The elapsed clock: 05:39, or 1:05:39 past an hour. */
export function renderClock(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  replace($("#clock"), hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`);
}

/** One-line summaries under each settings menu item. */
export function renderMenu(st: State) {
  const c = s1Counters(st);
  const voices = [...st.speakers.values()].filter((s) => !s.mergedInto).length;
  replace($("#m-recordings"), "Open, rename, replay");
  replace($("#m-s1"), `${st.s1.active} · ${c.flags} flag${c.flags === 1 ? "" : "s"}`);
  replace($("#m-speakers"), `${voices} voice${voices === 1 ? "" : "s"}`);
  replace($("#m-labels"), st.labels.version || "–");
  replace($("#m-stats"), st.stats ? `Rogan index ${Math.round((st.stats.roganIndex ?? 0) * 100)}%` : "Every minute");
  replace($("#m-log"), st.errors.length ? `${st.errors.length} error${st.errors.length === 1 ? "" : "s"}` : "No errors");
}

// ---------- stream health ----------

const minus = (n: number) => n.toFixed(0).replace("-", "−");

/**
 * Speaker mode's chip next to the meters. It is static markup, only shown, hidden, and given the device name here, because
 * the meters are rebuilt every second and would close its info box under the pointer.
 */
function renderSpeakerMode(st: State) {
  const gate = st.session?.echoGate;
  const on = st.session?.status === "running" && !!gate?.active;
  const box = $("#speaker-mode")!;
  box.hidden = !on;
  const device = gate?.device ?? "the Mac's speakers";
  const el = $("#speaker-mode-device")!;
  if (on && el.textContent !== device) el.textContent = device;
}

export function renderHealth(st: State) {
  renderSpeakerMode(st);
  if (st.session?.status === "archived") {
    return replace($("#health")); // an opened recording has no live streams
  }
  const paused = !!st.session?.paused;
  const running = st.session?.status === "running" && !paused;
  const streams: Stream[] = st.session?.streams ?? ["host", "remote"];
  replace($("#health"), (["host", "remote"] as Stream[]).map((stream) => {
    const hl = st.health[stream];
    const present = streams.includes(stream);
    const now = Date.now();
    const age = hl ? hl.msSinceLastFrame + (now - hl.receivedAt) : -1;
    const silentFor = hl ? now - hl.lastSoundAt : 0;
    const red = running && present && (!hl || silentFor > 10_000 || age > 3000);
    const pct = hl ? Math.max(0, Math.min(100, ((hl.rmsDbfs + 60) / 60) * 100)) : 0;
    const device: string | undefined = stream === "host" ? hl?.detail?.host?.device : hl?.detail?.remote?.outputDevice;
    const ageText = age < 0 ? "–" : age < 1000 ? `${age} ms` : `${(age / 1000).toFixed(1)} s`;
    // speaker mode: the microphone is muted while the call plays (most of the last second)
    const muted = running && present && (hl?.echoMutedMs ?? 0) >= 500 && age <= 3000;
    const meta = !present ? "absent" : paused ? "paused" : !hl ? "waiting…" : muted ? "muted · call playing"
      : `${minus(hl.rmsDbfs)} dBFS · ${red && silentFor > 10_000 ? `silent ${(silentFor / 1000).toFixed(0)} s` : ageText}`;
    return h("div", {
      class: `meter${red ? " alert" : ""}${present ? "" : " absent"}${paused ? " paused" : ""}${muted ? " muted" : ""}`,
      title: `${stream === "host" ? "Host" : "Remote"}${device ? ` · ${device}` : ""} · last frame ${ageText}`,
    },
      h("div", { class: "row1" }, h("span", { class: `who ${stream}` }, stream === "host" ? "Host" : "Remote"), device ? h("span", { class: "dev" }, device) : null),
      h("div", { class: "bar" }, h("b", { style: `width:${pct}%` })),
      h("div", { class: "meta" }, meta));
  }));
}

// ---------- filters ----------

export function segmentOf(st: State): Map<string, Segment> {
  const m = new Map<string, Segment>();
  for (const g of st.segments.values()) for (const id of g.utteranceIds) m.set(id, g);
  return m;
}

export function segmentMatches(g: Segment): boolean {
  const l = g.labels;
  if (filters.markers.size > 0 && !(l?.markers ?? []).some((m) => filters.markers.has(m))) return false;
  if (filters.subject) {
    const subj = l?.choices.subject?.choice;
    if (filters.subject === "ai" ? !subj?.startsWith("ai_") : subj !== filters.subject) return false;
  }
  if (filters.speaker) return false; // speaker filtering is per utterance; segments dim only on label filters
  return true;
}

export function renderFilters(st: State, onChange: () => void) {
  // without labels there are no markers or subjects to filter by; a filter left from another session would hide every line
  const labels = featuresOf(st).labels;
  if (!labels) { filters.markers.clear(); filters.subject = ""; }
  const chips = !labels ? [] : Object.entries(MARKERS).filter(([k]) => k !== "humour").map(([k, m]) =>
    h("button", {
      class: "chip", "aria-pressed": String(filters.markers.has(k)),
      onclick: () => { filters.markers.has(k) ? filters.markers.delete(k) : filters.markers.add(k); onChange(); },
    }, glyph(k), m.label));
  const speakers = [...st.speakers.values()].filter((s) => !s.mergedInto);
  replace($("#filters"),
    chips,
    h("select", { class: "select", "aria-label": "Speaker filter", onchange: (e: Event) => { filters.speaker = (e.target as HTMLSelectElement).value; onChange(); } },
      h("option", { value: "" }, "All speakers"),
      speakers.map((s) => h("option", { value: s.id, selected: filters.speaker === s.id }, s.displayName))),
    !labels ? null : h("select", { class: "select", "aria-label": "Subject filter", onchange: (e: Event) => { filters.subject = (e.target as HTMLSelectElement).value; onChange(); } },
      h("option", { value: "" }, "All subjects"),
      h("option", { value: "ai", selected: filters.subject === "ai" }, "AI (all)"),
      Object.keys(SUBJECT_COLORS).map((k) => h("option", { value: k, selected: filters.subject === k }, pretty(k)))),
    filters.markers.size || filters.speaker || filters.subject
      ? h("button", { class: "linkbtn", onclick: () => { filters.markers.clear(); filters.speaker = ""; filters.subject = ""; onChange(); } }, "Clear")
      : null);
}

// ---------- transcript ----------

/**
 * The speaker panel a click on a name in the transcript opens: rename them, merge them into someone else, or merge
 * someone else into them. Merges are made here without a second question; the button says exactly what will happen.
 */
function openSpeaker(st: State, clickedId: string) {
  const dlg = $<HTMLDialogElement>("#dlg-speaker");
  const sp = resolveSpeaker(st, clickedId);
  if (!dlg || !sp) return;
  const others = [...st.speakers.values()].filter((s) => !s.mergedInto && s.id !== sp.id);
  const lines = [...st.utterances.values()].filter((u) => resolveSpeaker(st, u.speakerId)?.id === sp.id);
  const talkMs = lines.reduce((n, u) => n + (u.endMs - u.startMs), 0);
  const streams = [...new Set(lines.map((u) => (u.stream === "host" ? "your mic" : "the call")))].join(" and ") || "no lines yet";
  const close = () => dlg.close();

  const input = h("input", { class: "input", value: sp.displayName, "aria-label": "Name" });
  const rename = () => {
    const name = input.value.trim();
    if (!name) return toast("Type a name first.");
    if (name === sp.displayName) return close();
    void run(async () => { await api.rename(sp.id, name); close(); }, `Renamed ${sp.displayName} to ${name}`);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); rename(); } });

  const option = (o: { id: string; displayName: string }) => h("option", { value: o.id }, o.displayName);
  const intoSel = h("select", { class: "select", "aria-label": `Merge ${sp.displayName} into` }, h("option", { value: "" }, "Choose a speaker…"), others.map(option));
  const fromSel = h("select", { class: "select", "aria-label": `Merge into ${sp.displayName}` }, h("option", { value: "" }, "Choose a speaker…"), others.map(option));
  const nameOf = (id: string) => st.speakers.get(id)?.displayName ?? id;
  const intoBtn = h("button", { class: "btn", disabled: true }, "Merge");
  const fromBtn = h("button", { class: "btn", disabled: true }, "Merge");
  intoSel.addEventListener("change", () => {
    intoBtn.disabled = !intoSel.value;
    replace(intoBtn, intoSel.value ? `Merge ${sp.displayName} into ${nameOf(intoSel.value)}` : "Merge");
  });
  fromSel.addEventListener("change", () => {
    fromBtn.disabled = !fromSel.value;
    replace(fromBtn, fromSel.value ? `Merge ${nameOf(fromSel.value)} into ${sp.displayName}` : "Merge");
  });
  intoBtn.addEventListener("click", () => {
    const to = intoSel.value;
    if (to) void run(async () => { await api.merge(sp.id, to); close(); }, `Merged ${sp.displayName} into ${nameOf(to)}`);
  });
  fromBtn.addEventListener("click", () => {
    const from = fromSel.value;
    if (from) void run(async () => { await api.merge(from, sp.id); close(); }, `Merged ${nameOf(from)} into ${sp.displayName}`);
  });

  replace($("#h-speaker"), sp.displayName);
  replace($("#speaker-sub"), `${lines.length} line${lines.length === 1 ? "" : "s"} · ${clock(talkMs)} talking · on ${streams}`);
  replace($("#speaker-body"),
    h("label", { class: "fieldlabel" }, "Name", h("div", { class: "row" }, input, h("button", { class: "btn primary", onclick: rename }, "Rename"))),
    others.length
      ? [
        h("div", { class: "fieldlabel" }, `${sp.displayName} is really…`, h("div", { class: "row" }, intoSel, intoBtn),
          h("span", { class: "note" }, `${sp.displayName}'s lines move to them, and ${sp.displayName} disappears.`)),
        h("div", { class: "fieldlabel" }, `…is really ${sp.displayName}`, h("div", { class: "row" }, fromSel, fromBtn),
          h("span", { class: "note" }, `Their lines move to ${sp.displayName}, who keeps this name.`)),
      ]
      : h("p", { class: "note" }, "No other speaker to merge with."));
  dlg.showModal();
  input.select();
}

let onTimeClick: ((ms: number) => void) | null = null;
/** What a click on a transcript timestamp does (recordings: seek playback there). */
export function setTimeClick(fn: (ms: number) => void) { onTimeClick = fn; }

export function renderTranscript(st: State) {
  const box = $("#transcript")!;
  const recording = st.session?.status === "archived";
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const bySeg = segmentOf(st);
  const labelFilter = filters.markers.size > 0 || !!filters.subject;
  // lines not transcribed (yet) keep their place, so a network drop does not look like a dead microphone
  const missing = [...st.missing.values()].filter((m) => !st.utterances.has(m.id))
    .map((m): Utterance & { missing?: MissingLine["status"] } => ({ ...m, text: "", tags: [], missing: m.status }));
  const utts: (Utterance & { missing?: MissingLine["status"] })[] = [...st.utterances.values(), ...missing].sort((a, b) => a.startMs - b.startMs);
  const rows: HTMLElement[] = [];
  let lastSeg: string | undefined;
  let lastSpeaker: string | undefined;
  const flagged = new Set([...st.claims.values()].map((c) => c.utteranceId));
  for (const u of utts) {
    const seg = bySeg.get(u.id);
    if (labelFilter && (!seg || !segmentMatches(seg))) continue;
    const sp = resolveSpeaker(st, u.speakerId);
    if (filters.speaker && sp?.id !== filters.speaker) continue;
    if (seg && seg.id !== lastSeg) {
      const l = seg.labels;
      const subj = l?.choices.subject;
      const md = l?.choices.mode;
      rows.push(h("div", { class: "segdiv", id: `seg-${seg.id}` },
        h("span", { class: "t" }, clock(seg.startMs)),
        subj ? h("span", { class: `subj${subj.faded ? " faded" : ""}`, style: `background:${SUBJECT_COLORS[subj.choice] ?? "#6a7d98"}` }, pretty(subj.choice)) : null,
        md ? h("span", { class: `mode${md.faded ? " faded" : ""}` }, pretty(md.choice)) : null,
        (l?.markers ?? []).map((m) => MARKERS[m] ? h("span", { class: "mk", title: MARKERS[m].label }, glyph(m)) : null),
        l?.mentions.length ? h("span", { class: "ment" }, l.mentions.join(", ")) : null));
      lastSeg = seg.id;
      lastSpeaker = undefined;
    }
    const name = speakerName(st, u.speakerId);
    // Consecutive lines by the same speaker read like captions: the name tag appears once.
    const who = u.speakerInferred
      ? h("button", { class: "who-cont", title: "Speaker inferred from a short utterance. Click to rename or merge", onclick: () => openSpeaker(st, u.speakerId) }, `${name} *`)
      : sp?.id === lastSpeaker
        ? h("span", {})
        : h("button", { class: `who-tab ${u.stream}`, title: "Click to rename or merge", onclick: () => openSpeaker(st, u.speakerId) }, name);
    lastSpeaker = u.speakerInferred ? undefined : sp?.id;
    rows.push(h("div", { class: `utt${u.filler ? " filler" : ""}${flagged.has(u.id) ? " flagged" : ""}${u.missing ? " missing" : ""}`, id: `utt-${u.id}`, "data-seg": seg?.id ?? "", "data-start": Math.round(u.startMs) },
      // in a recording, a timestamp plays from that line
      recording
        ? h("button", { class: "time seek", title: "Play from here", onclick: () => onTimeClick?.(u.startMs) }, clock(u.startMs))
        : h("span", { class: "time" }, clock(u.startMs)),
      who,
      u.missing
        ? h("span", { class: "text", title: "The transcription request failed. The audio is kept in the recording." },
          u.missing === "retrying" ? "Not transcribed yet: the connection dropped. Retrying…"
            : recording ? "Not transcribed. Play from here to hear it." : "Not transcribed.")
        : h("span", { class: "text" }, u.text,
        u.tags.map((t) => h("span", { class: "tag-loud" }, t)),
        flagged.has(u.id) ? h("span", { class: "flag", title: "Flagged for fact-checking" }, glyph("flag")) : null)));
  }
  // Streaming text: shown until its final line arrives (a finished partial whose utterance was dropped fades after 8 s).
  const now = Date.now();
  for (const [k, p] of st.partials) if (p.final && now - p.receivedAt > 8000) st.partials.delete(k);
  if (!labelFilter) {
    // Who is speaking is only known when the final line lands; name them only if the stream has had one speaker.
    const soleSpeaker = (stream: string) => {
      const ids = new Set(utts.filter((u) => u.stream === stream).map((u) => resolveSpeaker(st, u.speakerId)?.id));
      return ids.size === 1 ? resolveSpeaker(st, [...ids][0]!) : undefined;
    };
    for (const p of [...st.partials.values()].sort((a, b) => a.receivedAt - b.receivedAt)) {
      if (!p.text) continue;
      const sp = soleSpeaker(p.stream);
      if (filters.speaker && sp?.id !== filters.speaker) continue;
      rows.push(h("div", { class: "utt live" },
        h("span", { class: "time" }, h("span", { class: "livedot", title: "Live text: the final line replaces it" })),
        h("span", { class: `who-tab ${p.stream}` }, sp?.displayName ?? (p.stream === "host" ? "Host" : "Call")),
        h("span", { class: "text" }, p.text)));
    }
  }
  if (rows.length === 0) rows.push(h("div", { class: "empty" }, st.session ? "Waiting for speech…" : "Start a live session or a replay."));
  replace(box, rows);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

export function jumpToSegment(segmentId: string) {
  const el = document.getElementById(`seg-${segmentId}`);
  if (!el) return toast("That segment is hidden by the current filters");
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((d) => d.close());
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelectorAll(`[data-seg="${segmentId}"]`).forEach((u) => {
    u.classList.remove("flash");
    void (u as HTMLElement).offsetWidth;
    u.classList.add("flash");
  });
}

// ---------- fact-check cards ----------

const VERDICT_LABEL: Record<string, string> = {
  supported: "Supported", contradicted: "False", misleading: "Misleading", unverifiable: "Unverifiable", not_a_claim: "Not a claim",
};

function card(st: State, c: Claim): HTMLElement {
  const v = c.verdict;
  const steps = ["queued", "researching", "verdict"];
  const idx = steps.indexOf(c.status);
  const reps = c.repeats.length + c.duplicates.length;
  const stream = st.utterances.get(c.utteranceId)?.stream ?? "remote";
  const block = v
    ? [h("span", { class: "vw" }, VERDICT_LABEL[v.verdict] ?? pretty(v.verdict)),
      h("span", { class: "vm" }, `${v.confidence[0]?.toUpperCase() ?? ""}${v.confidence.slice(1)} confidence`),
      v.downgraded ? h("span", { class: "vm" }, "No source found") : null,
      c.latencyMs ? h("span", { class: "vm" }, `${(c.latencyMs / 1000).toFixed(1)} s`) : null]
    : c.status === "researching" ? [h("span", { class: "vw" }, "Checking"), h("span", { class: "vm" }, "Researching")]
      : c.status === "dropped" ? [h("span", { class: "vw" }, "Dropped"), h("span", { class: "vm" }, pretty(c.dropReason ?? ""))]
        : [h("span", { class: "vw" }, "Queued"), h("span", { class: "vm" }, "Waiting for research")];
  return h("article", { class: `fc v-${v?.verdict ?? c.status}${c.disputed ? " disputed" : ""}` },
    h("div", { class: "fc-verdict" }, block),
    h("div", { class: "fc-body" },
      h("div", { class: "fc-meta" },
        h("span", { class: `who-tab ${stream}` }, speakerName(st, c.speakerId)),
        c.status === "dropped" ? null
          : h("ol", { class: "steps", "aria-label": `Status: ${c.status}` },
            steps.map((s, i) => h("li", { class: `${i <= idx ? "done" : ""}${i === idx ? " cur" : ""}` }, pretty(s)))),
        reps ? h("span", { class: "badge repeat", title: "Said again: linked to this claim, not researched twice" }, `Repeat ×${reps}`) : null,
        c.disputed ? h("span", { class: "badge dispute" }, "Host disputes") : null),
      h("blockquote", {}, `“${c.text}”`),
      v ? h("p", { class: "restated" }, v.restated_claim) : null,
      v?.correction ? h("p", { class: "correction" }, v.correction) : null,
      v?.sources.length ? h("div", { class: "sources" }, h("span", { class: "lbl" }, "Sources"),
        v.sources.map((s) => h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.title || s.url))) : null,
      v && !c.disputed ? h("div", { class: "fc-foot" }, h("button", {
        class: "linkbtn", onclick: async () => {
          const note = await ask("Host disputes this verdict", { message: "Why? (optional)", input: true, placeholder: "A note for System 2", ok: "Dispute" });
          if (note !== null) void run(() => api.override(c.id, note.trim() || undefined));
        },
      }, "Host disputes")) : null));
}

export function renderClaims(st: State) {
  const claims = [...st.claims.values()].sort((a, b) =>
    (b.activity ?? "").localeCompare(a.activity ?? "") || Number(b.id.slice(2)) - Number(a.id.slice(2)));
  const empty = featuresOf(st).factcheck
    ? "Checkable claims appear here as they are said."
    : "Fact-checking is off for this session: it was turned off when the session started.";
  replace($("#claims"), claims.length ? claims.map((c) => card(st, c)) : h("div", { class: "empty" }, empty));
  replace($("#claims-count"), claims.length ? String(claims.length) : "");
  const count = (f: (c: Claim) => boolean) => claims.filter(f).length;
  const tally: [string, number, string][] = [
    ["false", count((c) => c.verdict?.verdict === "contradicted"), "var(--bad)"],
    ["misleading", count((c) => c.verdict?.verdict === "misleading"), "var(--warn)"],
    ["supported", count((c) => c.verdict?.verdict === "supported"), "var(--good)"],
    ["checking", count((c) => c.status === "queued" || c.status === "researching"), "var(--accent)"],
  ];
  replace($("#tally"), tally.filter(([, n]) => n > 0).map(([k, n, color]) => h("span", {}, h("i", { style: `background:${color}` }), `${n} ${k}`)));
}

// ---------- speakers ----------

/** The duplicate-speaker analysis of the session on screen: kept while the modal re-renders. */
const suggest: {
  sessionId: string | null; loading: boolean; error: string | null; voices: number | null;
  result: { suggestions: MergeSuggestion[]; voices: { host: number; remote: number } } | null;
} = { sessionId: null, loading: false, error: null, voices: null, result: null };

async function findDuplicates(st: State) {
  suggest.loading = true;
  suggest.error = null;
  renderSpeakers(st);
  try {
    suggest.result = await api.suggestMerges(suggest.voices ?? undefined);
    suggest.voices = suggest.result.voices.remote;
  } catch (e) {
    suggest.error = e instanceof Error ? e.message : String(e);
  }
  suggest.loading = false;
  renderSpeakers(st);
}

async function applyMerges(st: State, list: MergeSuggestion[]) {
  let done = 0;
  for (const m of list) {
    try {
      await api.merge(m.fromId, m.intoId);
      done++;
      if (suggest.result) suggest.result.suggestions = suggest.result.suggestions.filter((x) => x !== m);
    } catch (e) {
      toast(`Could not merge ${m.fromName} into ${m.intoName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (done) toast(done === 1 ? `Merged ${list[0]!.fromName} into ${list[0]!.intoName}` : `Merged ${done} speakers`, "ok");
  renderSpeakers(st);
}

const CONFIDENCE_WORD = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

/** "Find duplicate speakers": voiceprints compared within each stream, merges proposed with a score and a confidence. */
function suggestionsPanel(st: State): HTMLElement {
  if (suggest.sessionId !== (st.session?.id ?? null)) Object.assign(suggest, { sessionId: st.session?.id ?? null, result: null, error: null, voices: null });
  const r = suggest.result;
  const voices = h("select", { class: "select", id: "suggest-voices", "aria-label": "People on the call", disabled: suggest.loading },
    [1, 2, 3, 4].map((n) => h("option", { value: n, selected: (suggest.voices ?? r?.voices.remote ?? 2) === n }, `${n} on the call`)),
    h("option", { value: 0, selected: suggest.voices === 0 }, "Any number on the call"));
  voices.addEventListener("change", () => { suggest.voices = Number(voices.value); voices.blur(); void findDuplicates(st); });
  const list = r?.suggestions ?? [];
  const sure = list.filter((m) => m.confidence !== "low");
  return h("section", { class: "suggest" },
    h("div", { class: "suggest-head" },
      h("div", {}, h("h3", {}, "Duplicate speakers"),
        h("p", { class: "note" }, "Compares every speaker's voice with the others heard on the same stream and proposes which are the same person, with a voice-match score. Nothing merges until you click.")),
      h("div", { class: "row" }, h("span", { class: "note" }, "1 on your mic,"), voices,
        h("button", { class: "btn primary", disabled: suggest.loading, onclick: () => void findDuplicates(st) }, suggest.loading ? "Analysing voices…" : r ? "Analyse again" : "Find duplicates"))),
    suggest.loading ? h("p", { class: "note" }, "Listening to each speaker's lines. A two-hour recording takes about half a minute.") : null,
    suggest.error ? h("p", { class: "error-text" }, suggest.error) : null,
    r && !suggest.loading
      ? list.length === 0
        ? h("p", { class: "suggest-none" }, "No duplicates: every speaker sounds distinct, and each stream has no more voices than expected.")
        : [
          h("div", { class: "suggest-list" }, list.map((m) => h("div", { class: `sugg c-${m.confidence}` },
            h("span", { class: "sugg-names" }, h("b", {}, m.fromName), h("span", { class: "arrow" }, "→"), h("b", {}, m.intoName)),
            h("span", { class: "sugg-conf" }, CONFIDENCE_WORD[m.confidence]),
            h("span", { class: "sugg-score" }, m.similarity === null ? "no voiceprint" : `voice match ${Math.round(m.similarity * 100)}%`),
            h("span", { class: "sugg-why" }, `${m.stream === "host" ? "Your mic" : "The call"}: ${m.reason}.`),
            h("button", { class: "btn sm", onclick: () => void applyMerges(st, [m]) }, "Merge")))),
          h("div", { class: "row end" },
            sure.length && sure.length < list.length
              ? h("button", { class: "btn", onclick: async () => {
                if ((await ask(`Merge ${sure.length} high and medium confidence suggestion${sure.length === 1 ? "" : "s"}?`, { ok: "Merge" })) !== null) void applyMerges(st, sure);
              } }, `Merge ${sure.length} high & medium`)
              : null,
            h("button", { class: "btn primary", onclick: async () => {
              const low = list.length - sure.length;
              const ok = await ask(`Merge all ${list.length} suggestion${list.length === 1 ? "" : "s"}?`, {
                message: low ? `${low} of them ${low === 1 ? "is" : "are"} low confidence: check the transcript afterwards.` : "Every one is high or medium confidence.", ok: "Merge all",
              });
              if (ok !== null) void applyMerges(st, list);
            } }, `Merge all ${list.length}`)),
        ]
      : null);
}

export function renderSpeakers(st: State) {
  const box = $("#speakers");
  if (editing(box)) return;
  const active = [...st.speakers.values()].filter((s) => !s.mergedInto);
  replace(box, active.length > 1 || suggest.result ? suggestionsPanel(st) : null,
    active.length === 0 ? h("div", { class: "empty" }, "Speakers appear as they talk.") : h("div", {}, active.map((sp) => {
    const input = h("input", { class: "input", value: sp.displayName, "aria-label": `Rename ${sp.id}` });
    const into = h("select", { class: "select", "aria-label": "Merge into" }, h("option", { value: "" }, "Merge into…"),
      active.filter((o) => o.id !== sp.id).map((o) => h("option", { value: o.id }, o.displayName)));
    const save = () => {
      const name = input.value.trim();
      if (!name) return toast("Type a name first.");
      if (name === sp.displayName) return toast(`${sp.displayName} already has that name.`);
      input.blur(); // lets the list re-render with the new name
      void run(() => api.rename(sp.id, name), `Renamed ${sp.displayName} to ${name}`);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    const talk = st.stats?.speakers?.find((x: any) => x.speakerId === sp.id);
    return h("div", { class: "sp-row" },
      h("span", { class: "id", title: sp.id }, sp.id),
      input,
      h("button", { class: "btn", onclick: save }, "Rename"),
      into,
      h("button", {
        class: "btn",
        onclick: async () => {
          if (!into.value) return toast(`Choose who to merge ${sp.displayName} into first.`);
          const target = st.speakers.get(into.value)?.displayName ?? into.value;
          const ok = await ask(`Merge ${sp.displayName} into ${target}?`, { message: `Their utterances will be relabelled as ${target}.`, ok: "Merge" });
          if (ok !== null) void run(() => api.merge(sp.id, into.value), `Merged ${sp.displayName} into ${target}`);
        },
      }, "Merge"),
      h("span", { class: "talk" }, talk ? `${clock(talk.talkMs)} talk` : ""));
  })));
}

// ---------- System 1 ----------

export async function renderS1(st: State) {
  const box = $("#s1");
  if (editing(box)) return;
  if (!featuresOf(st).factcheck) return replace(box, h("div", { class: "empty" }, "Fact-checking is off for this session, so System 1 does not run."));
  const c = s1Counters(st);
  const last = st.s1.last;
  const restorable = st.s1.versions.filter((v) => v.id === "s1@1" || v.status === "promoted");
  const sel = h("select", { id: "rollback", class: "select" }, (restorable.length ? restorable : [{ id: st.s1.active }]).map((v) =>
    h("option", { value: v.id, selected: v.id === st.s1.active }, v.id)));
  const counters: [string, number, string][] = [
    ["Flags", c.flags, ""], ["Good flags", c.goodFlags, "good"], ["False alarms", c.falseAlarms, "bad"], ["Misses", c.misses, "bad"], ["Repeats", c.repeats, ""],
  ];
  replace(box,
    h("div", { class: "kv" }, "Active version ", h("strong", {}, st.s1.active), ` · ${st.s1.memorySize} memory question${st.s1.memorySize === 1 ? "" : "s"}`),
    h("div", { class: "counters" }, counters.map(([k, n, cls]) =>
      h("div", { class: `counter ${cls}` }, h("div", { class: "n" }, String(n)), h("div", { class: "k" }, k)))),
    last ? h("div", { class: `outcome ${last.outcome}` },
      h("div", { class: "stamp" }, pretty(last.outcome), h("small", {}, `${last.candidate ? `${last.candidate} → ` : ""}active ${last.active}`)),
      h("div", { class: "txt" },
        last.gate ? h("div", { class: "gate" },
          h("span", {}, "Good kept ", h("b", {}, `${last.gate.G2}/${last.gate.G}`)),
          h("span", {}, "False alarms left ", h("b", {}, `${last.gate.F2}/${last.gate.F}`)),
          h("span", {}, "Misses caught ", h("b", {}, `${last.gate.M2}/${last.gate.M}`))) : null,
        last.rationale ? h("span", {}, last.rationale) : null,
        last.errors?.length ? h("span", { class: "error-text" }, last.errors.join("; ")) : null))
      : h("p", { class: "note" }, "No rewrite yet: System 2 rewrites System 1 after enough false alarms or misses."),
    h("div", { class: "row" }, h("label", { class: "kv", for: "rollback" }, "Roll back to"), sel,
      h("button", { class: "btn", onclick: () => run(() => api.rollback(sel.value), `Rolled back to ${sel.value}`) }, "Roll back")));
}

// ---------- label editor ----------

let editorVersion = "";
let editorTouched = false;

function criteriaText(q: LabelQuestion): string {
  if (q.type === "choice") return Object.entries(q.criteria ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
  if (q.type === "score") return (q.criteria ?? []).join("\n");
  return q.criteria ? `true: ${q.criteria.true}\nfalse: ${q.criteria.false}` : "";
}

function parseCriteria(type: string, text: string): unknown {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (type === "score") return lines;
  const pairs = lines.map((l) => {
    const i = l.indexOf(":");
    return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  });
  if (type === "choice") return Object.fromEntries(pairs);
  if (lines.length === 0) return undefined;
  const o = Object.fromEntries(pairs);
  return { true: o.true ?? "", false: o.false ?? "" };
}

function questionRow(id: string, q: LabelQuestion): HTMLElement {
  const type = h("select", { class: "select q-type", "aria-label": "Question type" }, ["noul", "choice", "score"].map((t) => h("option", { value: t, selected: q.type === t }, t)));
  const hint = h("span", { class: "hint" });
  const setHint = () => {
    hint.textContent = type.value === "choice" ? "One option per line: key: description (include none or other…)"
      : type.value === "score" ? "One level per line, lowest first (2–10)" : "Optional: true: … and false: … lines";
  };
  setHint();
  type.addEventListener("change", setHint);
  const row = h("div", { class: "q" },
    h("div", { class: "row" },
      h("input", { class: "input q-id", value: id, "aria-label": "Question id (snake_case)" }), type,
      h("button", { class: "linkbtn danger", onclick: () => { row.remove(); editorTouched = true; } }, "Remove")),
    h("textarea", { class: "input q-instructions", rows: 2, "aria-label": "Instructions" }, q.instructions),
    h("textarea", { class: "input q-criteria", rows: q.type === "noul" ? 2 : 4, "aria-label": "Criteria" }, criteriaText(q)),
    hint);
  row.addEventListener("input", () => { editorTouched = true; });
  return row;
}

function readEditor(base: LabelSet): LabelSet {
  const questions: Record<string, LabelQuestion> = {};
  document.querySelectorAll<HTMLElement>("#label-questions .q").forEach((row) => {
    const id = (row.querySelector(".q-id") as HTMLInputElement).value.trim();
    const type = (row.querySelector(".q-type") as HTMLSelectElement).value as LabelQuestion["type"];
    const instructions = (row.querySelector(".q-instructions") as HTMLTextAreaElement).value.trim();
    const criteria = parseCriteria(type, (row.querySelector(".q-criteria") as HTMLTextAreaElement).value);
    questions[id] = criteria === undefined ? { type, instructions } : { type, instructions, criteria };
  });
  const prefix = ($<HTMLInputElement>("#label-prefix")?.value ?? base.prefix).trim();
  return { ...base, prefix, questions };
}

export function renderLabels(st: State, force = false) {
  if (st.session && !featuresOf(st).labels) {
    editorVersion = "";
    return replace($("#labels"), h("div", { class: "empty" }, "Labels are off for this session: its timeline shows segments and time only."));
  }
  const set = st.labels.set;
  if (!set) return replace($("#labels"), h("div", { class: "empty" }, "The label set loads with a session."));
  if (!force && (editorTouched || editorVersion === st.labels.version)) return;
  editorVersion = st.labels.version;
  editorTouched = false;
  replace($("#h-lb")?.nextElementSibling ?? null, `Version ${st.labels.version} · changes apply from the next segment`);
  const stories = h("textarea", { id: "stories", class: "input", rows: 3, placeholder: "Tonight's stories, one headline per line" }, st.labels.stories.join("\n"));
  replace($("#labels"),
    h("label", { class: "fieldlabel" }, "Tonight's stories, one headline per line", stories),
    h("div", { class: "row" }, h("button", {
      class: "btn",
      onclick: () => run(async () => {
        const headlines = stories.value.split("\n").map((x) => x.trim()).filter(Boolean);
        const r = await api.putStories(headlines);
        st.labels.stories = headlines;
        st.labels.version = r.version;
      }, "Stories saved: they apply from the next segment"),
    }, "Save stories")),
    h("label", { class: "fieldlabel" }, "Prefix", h("input", { id: "label-prefix", class: "input", value: set.prefix })),
    h("div", { id: "label-questions", style: "display:grid;gap:12px" }, Object.entries(set.questions).map(([id, q]) => questionRow(id, q))),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: () => { $("#label-questions")!.append(questionRow("new_question", { type: "noul", instructions: "A speaker in the current segment …" })); editorTouched = true; } }, "Add question"),
      h("button", {
        class: "btn primary", onclick: () => run(async () => {
          const next = readEditor(set);
          const r = await api.putLabels(next);
          st.labels.set = next;
          st.labels.version = r.version;
          editorTouched = false;
          editorVersion = "";
          renderLabels(st, true);
        }, "Label set applied from the next segment"),
      }, "Apply"),
      h("button", { class: "btn", onclick: () => run(async () => { const r = await api.relabel(); toast(`Relabelling ${r.segments} segments in the background`, "ok"); }) }, "Relabel closed segments")),
    h("p", { class: "note" }, "The boundary question is calibrated and cannot change live."));
}

// ---------- accounting and stats ----------

export function renderCost(st: State) {
  const c = st.cost;
  const cap = c.sessionCapUsd || 10;
  const pct = Math.min(100, (c.session / cap) * 100);
  const box = $("#cost")!;
  box.classList.toggle("exhausted", !!st.budgetExhausted);
  box.setAttribute("aria-label", `Session spend ${usd(c.session)} of ${usd(cap)} cap`);
  const archived = st.session?.status === "archived";
  box.removeAttribute("data-tip"); // its hover breakdown explains it; a tooltip would sit on top of it
  replace(box,
    h("span", { class: "k" }, archived ? "Cost" : "Spend"),
    h("span", { class: "v" }, usd(c.session), " ", h("small", {}, `/ $${Number.isInteger(cap) ? cap : cap.toFixed(2)}`)),
    h("span", { class: "bar" }, h("b", { class: pct > 80 ? "warn" : "", style: `width:${pct}%` })),
    h("div", { class: "pop", role: "tooltip" },
      h("div", { class: "pop-h" }, archived ? "This recording cost" : `Session spend · cap ${usd(cap)}`),
      h("dl", {},
        h("dt", {}, "Transcription"), h("dd", {}, usd(c.transcription)),
        h("dt", {}, "Jev"), h("dd", {}, usd(c.jev)),
        h("dt", {}, "System 2"), h("dd", {}, usd(c.s2)),
        h("dt", {}, "Chat"), h("dd", {}, usd(c.chat ?? 0))),
      archived ? h("p", { class: "note" }, "What this recording cost when it ran, plus any chats about it. Opening it costs nothing.") : null,
      c.chat ? h("p", { class: "note" }, "Chat has its own cap per recording, so it never stops the pipeline.") : null,
      st.budgetExhausted ? h("p", { class: "error-text" }, `Budget exhausted: ${st.budgetExhausted}`) : null));
}

export function renderStats(st: State) {
  const s = st.stats;
  if (!s) return replace($("#stats"), h("div", { class: "empty" }, "Stats arrive every minute and at the end of the show."));
  const fc = s.factcheck ?? {};
  const verdicts = Object.entries(fc.verdicts ?? {}).filter(([, n]) => (n as number) > 0).map(([k, n]) => `${VERDICT_LABEL[k] ?? k} ${n}`).join(" · ");
  const list = (k: "predictions" | "recommendations" | "clips") => h("div", {},
    h("h3", {}, pretty(k)),
    (s[k] ?? []).length
      ? h("ul", {}, s[k].map((x: any) => h("li", {}, h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); jumpToSegment(x.segmentId); } }, x.text || x.segmentId))))
      : h("p", { class: "note" }, "None yet"));
  replace($("#stats"),
    h("div", { class: "big" }, h("span", { class: "n" }, `${Math.round((s.roganIndex ?? 0) * 100)}%`), h("span", { class: "k" }, "Rogan index: time spent on personal life and other topics")),
    h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "Speaker"), h("th", {}, "Talk"), h("th", {}, "Disagreements"), h("th", {}, "Hype"))),
      h("tbody", {}, (s.speakers ?? []).map((sp: any) => h("tr", {},
        h("td", {}, speakerName(st, sp.speakerId)), h("td", {}, clock(sp.talkMs)), h("td", {}, String(sp.disagreements)),
        h("td", {}, sp.hype === null ? "–" : `${sp.hype.toFixed(1)} / 4`))))),
    h("div", { class: "lists" }, list("predictions"), list("recommendations"), list("clips")),
    h("p", { class: "note" }, `Fact-check: ${fc.flagged ?? 0} flagged · ${fc.researched ?? 0} researched · ${verdicts || "no verdicts"} · ${fc.repeats ?? 0} repeats · ${fc.duplicates ?? 0} duplicates · ${fc.dropped ?? 0} dropped · ${fc.falseAlarms ?? 0} false alarms · ${fc.misses ?? 0} misses · System 1 versions ${fc.promoted ?? 0} promoted, ${fc.rejected ?? 0} rejected`));
}

export function renderErrors(st: State) {
  if (st.errors.length === 0) return replace($("#errors"), h("div", { class: "empty" }, "No errors."));
  replace($("#errors"), st.errors.map((e) => h("div", { class: "err" },
    h("span", { class: "c" }, e.component),
    h("span", { class: "t" }, new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })),
    h("span", {}, e.message))));
}

// ---------- recordings library ----------

let libraryQuery = "";
let libraryTimer: number | undefined;

function when(iso: string | null, id: string): string {
  if (!iso) return id;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** `next` is the recording to show if this one is deleted while on screen: the one below it, else the one above. */
function recordingRow(st: State, r: SessionSummary, next: SessionSummary | undefined, refresh: () => void): HTMLElement {
  const current = st.session?.id === r.id;
  const running = st.session?.status === "running" || st.session?.status === "ending";
  const viewing = current && st.session?.status === "archived";
  const label = r.name ?? when(r.startedAt, r.id);
  const open = () => {
    if (viewing) return $<HTMLDialogElement>("#dlg-recordings")?.close();
    if (running) return toast("Stop the current session before opening a recording.");
    void run(async () => {
      await api.openSession(r.id);
      $<HTMLDialogElement>("#dlg-recordings")?.close();
    });
  };
  const title: HTMLButtonElement = h("button", {
    class: "rec-title", title: "Click to rename",
    onclick: (e: Event) => {
      e.stopPropagation();
      editInPlace(title, {
        value: r.name ?? "", placeholder: when(r.startedAt, r.id), cls: "input rec-title-input",
        save: (name) => run(async () => { await api.renameSession(r.id, name); refresh(); }, name ? `Renamed to ${name}` : "Name cleared"),
      });
    },
  }, label);
  return h("div", {
    class: `rec${current ? " current" : ""}${running && !current ? " locked" : ""}`, role: "button", tabindex: 0,
    title: viewing ? "You are viewing this recording" : running ? "Stop the current session first" : "Open this recording: nothing is re-processed or spent",
    onclick: open, onkeydown: (e: Event) => { const k = (e as KeyboardEvent).key; if ((k === "Enter" || k === " ") && e.target === e.currentTarget) { e.preventDefault(); open(); } },
  },
    h("div", { class: "rec-head" },
      title,
      current ? h("span", { class: "badge cur" }, viewing ? "Viewing" : "Current") : null,
      !r.ended && !current ? h("span", { class: "badge inc", title: "No session.ended: the recording stopped abruptly" }, "Incomplete") : null,
      r.imported ? h("span", { class: "badge imp", title: `Imported${r.imported.fileName ? ` from ${r.imported.fileName}` : ""}${r.imported.exportedWith ? `, exported with v${r.imported.exportedWith}` : ""}` }, "Imported") : null,
      r.hasAudio === false ? h("span", { class: "badge inc", title: "Imported without its audio: no playback or replay" }, "No audio") : null,
      h("button", {
        class: "btn sm rec-export", disabled: current && running,
        title: current && running ? "Stop the session before exporting it" : "Save it as one file to share (WhatsApp, email)",
        onclick: (e: Event) => { e.stopPropagation(); void openExport(r.id); },
      }, glyph("export"), "Export"),
      h("button", {
        class: "btn sm rec-replay", disabled: running || r.hasAudio === false,
        title: running ? "Stop the current session first" : r.hasAudio === false ? "No audio to replay" : "Run the audio through the pipeline again (costs money: transcription, Jev, System 2)",
        onclick: async (e: Event) => {
          e.stopPropagation();
          const ok = await ask(`Replay “${label}”?`, {
            message: `This runs the audio through the pipeline again at real-time speed and calls the APIs again (about ${usd(r.costUsd || 0.02)}).`, ok: "Replay",
          });
          if (ok !== null) void run(async () => { await api.replaySession(r.id, 1, voicesOnCall()); $<HTMLDialogElement>("#dlg-recordings")?.close(); });
        },
      }, glyph("replay"), "Replay"),
      h("button", {
        class: "btn icon sm rec-delete", disabled: current && running, "aria-label": `Delete ${label}`,
        title: current && running ? "Stop the session before deleting it" : "Delete this recording",
        onclick: async (e: Event) => {
          e.stopPropagation();
          const ok = await ask(`Delete “${label}”?`, {
            message: "Are you sure? This permanently removes its audio, transcript, fact-checks, and every other file. It can't be undone.",
            ok: "Delete", danger: true,
          });
          if (ok === null) return;
          void run(async () => {
            await api.deleteSession(r.id);
            if (viewing) {
              if (next) await api.openSession(next.id); // show the recording that was below it
              else onViewGone();
            }
            refresh();
          }, `Deleted ${label}`);
        },
      }, glyph("trash"))),
    h("div", { class: "meta" },
      [r.name ? when(r.startedAt, r.id) : null, clock(r.durationMs), r.mode, `${r.utterances} lines`, r.speakers.join(", ") || null,
        r.claims ? `${r.claims} claims` : null, usd(r.costUsd), r.appVersion ? `v${r.appVersion}` : null].filter(Boolean).join(" · ")),
    (r.matches ?? []).map((m) => h("div", { class: "match" }, h("span", { class: "t" }, clock(m.startMs)), `${m.speaker}: `, m.snippet)));
}

export async function renderRecordings(st: State) {
  const box = $("#recordings");
  if (!box) return;
  const refresh = () => void renderRecordings(st);
  let search = box.querySelector<HTMLInputElement>("input.rec-search");
  if (!search) {
    search = h("input", { class: "input rec-search", type: "search", placeholder: "Search names and transcripts…", "aria-label": "Search names and transcripts", value: libraryQuery });
    search.addEventListener("input", () => {
      libraryQuery = search!.value;
      clearTimeout(libraryTimer);
      libraryTimer = window.setTimeout(refresh, 250);
    });
    replace(box,
      h("div", { class: "rec-tools" }, search,
        h("button", { class: "btn", title: "Add a recording someone shared with you", onclick: () => openImport() }, glyph("import"), "Import")),
      h("div", { class: "rec-list" }),
      h("p", { class: "note" }, "Click a recording to open it exactly as it was, for free. Click its name to rename it. Export saves it as one file to share; Replay runs its audio through the pipeline again and costs about what it cost the first time."));
  }
  const list = box.querySelector(".rec-list")!;
  try {
    const rows = await api.sessions(libraryQuery.trim());
    replace(list, rows.length ? rows.map((r, i) => recordingRow(st, r, rows[i + 1] ?? rows[i - 1], refresh))
      : h("div", { class: "empty" }, libraryQuery ? "No recording matches." : "No recordings yet."));
  } catch (e) {
    replace(list, h("div", { class: "error-text" }, e instanceof Error ? e.message : String(e)));
  }
}

// ---------- layout: the transcript / fact-check divider ----------

const SPLIT_DEFAULT = 56.5; // % of the width for the transcript
const SPLIT_KEY = "pa.splitPct";

function setSplit(pct: number) {
  const next = Math.min(75, Math.max(25, pct));
  $("#stage")?.style.setProperty("--split", `${next.toFixed(2)}%`);
  $("#split")?.setAttribute("aria-valuenow", String(Math.round(next)));
  try { localStorage.setItem(SPLIT_KEY, String(next)); } catch { /* storage may be unavailable */ }
}

/** Drag the divider between the transcript and the fact-checks (or use its arrow keys); double-click resets it. */
export function bindSplit() {
  const stage = $("#stage");
  const split = $("#split");
  if (!stage || !split) return;
  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    if (saved) setSplit(saved);
  } catch { /* storage may be unavailable */ }
  split.setAttribute("aria-valuemin", "25");
  split.setAttribute("aria-valuemax", "75");
  split.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add("dragging");
    document.body.classList.add("resizing-x");
    const move = (ev: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      setSplit(((ev.clientX - r.left) / r.width) * 100);
    };
    const up = () => {
      split.classList.remove("dragging");
      document.body.classList.remove("resizing-x");
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
      split.removeEventListener("pointercancel", up);
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
    split.addEventListener("pointercancel", up);
  });
  split.addEventListener("dblclick", () => setSplit(SPLIT_DEFAULT));
  split.addEventListener("keydown", (e) => {
    const cur = parseFloat(getComputedStyle(stage).getPropertyValue("--split")) || SPLIT_DEFAULT;
    if (e.key === "ArrowLeft") { e.preventDefault(); setSplit(cur - 2); }
    if (e.key === "ArrowRight") { e.preventDefault(); setSplit(cur + 2); }
  });
}

// ---------- an out-of-date server ----------

/** Shows a banner when the engine code changed after the server started, so a missing restart is never silent. */
export async function checkEngine() {
  try {
    $("#stale")!.hidden = !(await api.engine()).stale;
  } catch (e) {
    // a server older than this check has no /api/engine: it is out of date too
    if (e instanceof ApiError && e.status === 404) $("#stale")!.hidden = false;
  }
}
