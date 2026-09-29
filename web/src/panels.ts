import { api, ApiError, type Features, type Labelling, type LabelSetEntry, type MergeSuggestion, type SessionSummary } from "./api.js";
import { openExport, openImport } from "./transfer.js";
import { keyPrompt, keySet, onTranscription, refreshTranscription, setTranscription, setupStatus, transcriptionState, transcriptionSummary } from "./keys.js";
import { desktop } from "./desktop.js";
import { setRoute } from "./router.js";
import { $, clock, glyph, h, icon, pluralOf, pretty, replace, usd } from "./dom.js";
import { optionColor, optionName } from "./timeline.js";
import { featuresOf, labelSetOf, resolveSpeaker, s1Counters, speakerName, type MissingLine, type Utterance, type Claim, type LabelSet, type Segment, type State, type Stats, type Stream } from "./state.js";

/**
 * The transcript's filters. `categories`: per category id, an option id or `group:<name>` (every option of that group,
 * like the built-in set's "AI").
 */
export interface Filters { markers: Set<string>; speaker: string; categories: Record<string, string> }
export const filters: Filters = { markers: new Set(), speaker: "", categories: {} };
const categoryFiltered = () => Object.values(filters.categories).some(Boolean);

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

/**
 * The menu footer: the version from package.json, and Licenses, the Licenses and Acknowledgements window (licenses.html):
 * the app's own in the Mac app (the same as Help → Licenses and Acknowledgements), a new tab in a browser.
 */
async function bindAbout() {
  $("#license-link")?.addEventListener("click", () => {
    closePops();
    if (desktop) desktop.run("open-licenses");
    else window.open("/licenses", "_blank", "noopener");
  });
  try {
    const a = await api.about();
    replace($("#app-version"), `v${a.version}`);
    $("#app-version")!.title = `${a.name} ${a.version}`;
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
    // without an OpenRouter key a replay is transcript-only, as the Start live window's switches would be
    void run(async () => { const c = await replayChoices(); await api.startReplay(dir, replaySpeed, voicesOnCall(), c.features, c.labelling); });
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

// ---------- Start live: choose the features and the label set ----------

/**
 * Rough cost per hour of show (README): the transcript (free on this Mac, $1.23 with OpenAI), Jev's line checks
 * (whenever fact-checking or labels are on), the label set's own estimate, and System 2 for fact-checking.
 */
const PER_HOUR = { transcript: 1.23, lines: 0.028, labels: 0.012, factcheck: 0.35 };

const factcheckSwitch = () => $<HTMLButtonElement>("#feat-factcheck")!;
const factcheckOn = () => factcheckSwitch().getAttribute("aria-checked") === "true";
const labelPick = () => $<HTMLSelectElement>("#start-labelset");
const labelsOn = () => (labelPick()?.value ?? "off") !== "off";
const OPENROUTER_HEADING = "Please provide your OpenRouter API key to configure fact-checking or labeling.";
/** The label set picked last time, remembered in the browser like the microphone. */
const LABELS_KEY = "pa.labelSet";
const DEFAULT_SET = "ai-podcast";
let startSets: LabelSetEntry[] = [];
/** True while code, not the host, sets the picker (its change event must not ask for a key). */
let settingPick = false;
function setPick(value: string) {
  const pick = labelPick();
  if (!pick) return;
  settingPick = true;
  pick.value = value;
  pick.dispatchEvent(new Event("change")); // the bespoke select shows the new value
  settingPick = false;
}

function rememberedSet(sets: LabelSetEntry[]): string {
  let want = DEFAULT_SET;
  try { want = localStorage.getItem(LABELS_KEY) ?? want; } catch { /* storage may be unavailable */ }
  // a set deleted since falls back to the built-in one
  return sets.some((x) => x.id === want && !x.broken) ? want : sets.find((x) => x.builtIn)?.id ?? DEFAULT_SET;
}

/**
 * What a replay started without the Start live window runs: what the keys allow. Without OpenRouter, transcript only;
 * with it, fact-checking and the label set picked last time.
 */
export async function replayChoices(): Promise<{ features: Features; labelling: Labelling }> {
  if (!keySet("openrouter")) return { features: { factcheck: false, labels: false }, labelling: { labelSet: null } };
  const sets = (await api.labelSets().catch(() => null))?.sets ?? [];
  return { features: { factcheck: true, labels: true }, labelling: sets.length ? { labelSet: rememberedSet(sets) } : {} };
}

/** Apple's model must be installed before a session can start; the window says how far along it is. */
function preparing(): boolean {
  const t = transcriptionState();
  return t?.engine === "apple" && t.apple.model !== "installed";
}

function renderStartSummary() {
  const fc = factcheckOn(), lb = labelsOn();
  const box = $("#start-stories-box");
  if (box) box.hidden = !lb; // stories only feed the labels' story question
  const t = transcriptionState();
  const apple = t?.engine === "apple";
  const go = $<HTMLButtonElement>("#start-go");
  if (go) go.disabled = preparing();
  if (t && apple && t.apple.model !== "installed") {
    const failed = t.apple.model === "error";
    const retry = h("button", { class: "linkbtn", type: "button", onclick: () => void api.installModel().then(setTranscription).catch((e) => toast(e instanceof Error ? e.message : String(e))) }, "Try again");
    const settings = h("button", { class: "linkbtn", type: "button", onclick: () => { $<HTMLDialogElement>("#dlg-start")!.close(); openSettingsPanel("dlg-transcription"); } }, "Settings → Transcription");
    replace($("#start-summary"),
      h("b", {}, failed ? "On-device speech recognition is not ready" : `Getting on-device speech recognition ready… ${Math.round((t.apple.fraction ?? 0) * 100)} %`),
      h("br", {}), failed ? h("span", {}, t.apple.error ?? "It could not be prepared.", " ", retry, " · ", settings) : "Start is available as soon as it is.");
    return;
  }
  const set = startSets.find((x) => x.id === labelPick()?.value);
  const perHour = (apple ? 0 : PER_HOUR.transcript) + (fc || lb ? PER_HOUR.lines : 0) + (lb ? set?.perHourUsd ?? PER_HOUR.labels : 0) + (fc ? PER_HOUR.factcheck : 0);
  const named = lb && set ? ` · labels: ${set.name}` : "";
  const what = fc && lb ? `Everything on${named}` : !fc && !lb ? "Transcript only: Jev and System 2 are not called" : fc ? "No labels" : `No fact-checking${named}`;
  const cost = apple && !fc && !lb ? "Free: nothing leaves this Mac." : `About $${perHour.toFixed(2)} an hour${fc ? " at most" : ""}.`;
  replace($("#start-summary"), h("b", {}, what), h("br", {}), apple ? "Transcript: free, on this Mac. " : "", cost);
}

/** Asks for the OpenRouter key inside the Start live window; Not now turns off everything that needs it. */
function askOpenRouter(then?: () => void) {
  const box = $("#start-key");
  if (!box) return;
  box.hidden = false;
  replace(box, keyPrompt("openrouter", OPENROUTER_HEADING, {
    onSaved: () => { box.hidden = true; replace(box); renderStartSummary(); then?.(); },
    onCancel: () => {
      factcheckSwitch().setAttribute("aria-checked", "false");
      setPick("off");
      box.hidden = true;
      replace(box);
      renderStartSummary();
    },
  }));
}

/** The Labels picker: every usable set by name, then Off; the remembered set when the key is set, Off when it is not. */
async function fillLabelPicker(on: boolean) {
  const pick = labelPick();
  if (!pick) return;
  startSets = (await api.labelSets().catch(() => null))?.sets.filter((x) => !x.broken) ?? [];
  replace(pick, startSets.map((x) => h("option", { value: x.id }, x.name)), h("option", { value: "off" }, "Off"));
  setPick(on && startSets.length ? rememberedSet(startSets) : "off");
}

/**
 * Start live asks first. Fact-checking and the label set start on when the OpenRouter key is set, off when it is not:
 * turning one on then asks for the key, in this window.
 */
function openStartLive() {
  void loadDevices();
  // each show starts at "Any number": who is on the call changes from show to show
  const voices = $<HTMLSelectElement>("#voices");
  if (voices) voices.value = "0";
  const box = $("#start-key");
  if (box) { box.hidden = true; replace(box); }
  const on = keySet("openrouter");
  factcheckSwitch().setAttribute("aria-checked", String(on));
  const d = $<HTMLDialogElement>("#dlg-start")!;
  void fillLabelPicker(on).then(renderStartSummary);
  renderStartSummary();
  d.showModal();
  $<HTMLButtonElement>("#start-go")?.focus();
  // what the server says now (a key saved elsewhere, the model's progress), unless the host already asked for a key
  void Promise.all([setupStatus(), refreshTranscription()]).then(async () => {
    if (d.open && box?.hidden && keySet("openrouter") !== on) {
      factcheckSwitch().setAttribute("aria-checked", String(keySet("openrouter")));
      await fillLabelPicker(keySet("openrouter"));
    }
    renderStartSummary();
  });
}

function bindStartLive() {
  onTranscription(() => { if ($<HTMLDialogElement>("#dlg-start")?.open) renderStartSummary(); });
  factcheckSwitch().addEventListener("click", () => {
    const on = !factcheckOn();
    factcheckSwitch().setAttribute("aria-checked", String(on));
    renderStartSummary();
    if (on && !keySet("openrouter")) askOpenRouter();
  });
  labelPick()?.addEventListener("change", () => {
    renderStartSummary();
    // a set picked by the host asks for the key when it is missing
    if (!settingPick && labelsOn() && !keySet("openrouter") && $("#start-key")?.hidden) askOpenRouter();
  });
  const start = () => {
    const lb = labelsOn();
    const features = { factcheck: factcheckOn(), labels: lb };
    if ((features.factcheck || lb) && !keySet("openrouter")) return askOpenRouter(start);
    if (preparing()) return;
    const mic = $<HTMLSelectElement>("#mic")?.value;
    const labelSet = lb ? labelPick()!.value : null;
    const stories = lb ? ($<HTMLTextAreaElement>("#start-stories")?.value ?? "").split("\n").map((x) => x.trim()).filter(Boolean) : [];
    try {
      if (mic) localStorage.setItem(MIC_KEY, mic);
      if (labelSet) localStorage.setItem(LABELS_KEY, labelSet);
    } catch { /* storage may be unavailable */ }
    void (async () => {
      try {
        await api.startLive(mic || undefined, voicesOnCall(), features, { labelSet, stories });
        $<HTMLDialogElement>("#dlg-start")!.close();
      } catch (e) {
        // the server knows best which key is missing (one removed from .env, say): ask for it here
        if (e instanceof ApiError && e.body?.needsKey === "openrouter") { await setupStatus(); return askOpenRouter(start); }
        if (e instanceof ApiError && e.body?.preparing) { void refreshTranscription(); return; }
        $<HTMLDialogElement>("#dlg-start")!.close();
        toast(e instanceof Error ? e.message : String(e));
      }
    })();
  };
  $("#start-go")?.addEventListener("click", start);
}

/** Opens a settings window from inside the page (the Transcription window, from Start live). */
let openSettingsPanel: (dialogId: string) => void = () => {};
export function setPanelOpener(fn: (dialogId: string) => void) {
  openSettingsPanel = fn;
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Windows that act on the session on screen (live or a recording), so they are greyed out while there is none. */
export const SESSION_WINDOWS = new Set(["dlg-speakers"]);

/**
 * One-line summaries under each settings menu item. Insights' says what it would be opened for: how off-topic the
 * show is, how busy the fact-checker has been, and, in red, whether anything went wrong.
 */
export function renderMenu(st: State) {
  const voices = [...st.speakers.values()].filter((s) => !s.mergedInto).length;
  replace($("#m-recordings"), "Open, rename, replay");
  const parts: Node[] = [];
  const sep = () => (parts.length ? [document.createTextNode(" · ")] : []);
  if (st.stats?.index) parts.push(document.createTextNode(`${st.stats.index.name} ${Math.round(st.stats.index.share * 100)}%`));
  if (st.session && featuresOf(st).factcheck) parts.push(...sep(), document.createTextNode(plural(s1Counters(st).flags, "flag")));
  if (st.errors.length) parts.push(...sep(), h("em", { class: "error-text" }, plural(st.errors.length, "error")));
  replace($("#m-insights"), ...(parts.length ? parts : ["Stats, fact-checker, log"]));
  for (const id of SESSION_WINDOWS) $<HTMLButtonElement>(`#cog-menu [data-open="${id}"]`)!.disabled = !st.session;
  const none = "Start or open a recording";
  replace($("#m-speakers"), st.session ? plural(voices, "voice") : none);
  replace($("#m-transcription"), transcriptionSummary(transcriptionState()));
}

// ---------- Insights: Overview (stats), Fact-checker (System 1), Log ----------

/** Shows an Insights tab, and puts it in the URL. */
export function showInsights(section: string) {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("#dlg-insights .tab")];
  const tab = tabs.find((t) => t.dataset.section === section) ?? tabs[0]!;
  for (const t of tabs) {
    t.setAttribute("aria-selected", String(t === tab));
    $(`#${t.getAttribute("aria-controls")}`)!.hidden = t !== tab;
  }
  replace($("#insights-sub"), tab.dataset.sub ?? "");
  setRoute({ section: tab.dataset.section! });
}

export function bindInsights() {
  for (const t of document.querySelectorAll<HTMLButtonElement>("#dlg-insights .tab")) {
    t.addEventListener("click", () => showInsights(t.dataset.section!));
  }
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

/** Every option a category filter's value stands for: one option, or all of a group's. */
function filterOptions(set: LabelSet, catId: string, value: string): Set<string> {
  const cat = set.categories.find((c) => c.id === catId);
  if (!cat) return new Set();
  if (value.startsWith("group:")) return new Set(cat.options.filter((o) => o.group === value.slice(6)).map((o) => o.id));
  return new Set([value]);
}

let filterSet: LabelSet | null = null;

export function segmentMatches(g: Segment): boolean {
  const l = g.labels;
  if (filters.markers.size > 0 && !(l?.markers ?? []).some((m) => filters.markers.has(m))) return false;
  for (const [catId, value] of Object.entries(filters.categories)) {
    if (!value || !filterSet) continue;
    const picked = l?.choices[catId]?.choice;
    if (!picked || !filterOptions(filterSet, catId, value).has(picked)) return false;
  }
  if (filters.speaker) return false; // speaker filtering is per utterance; segments dim only on label filters
  return true;
}

/**
 * The filters under the transcript: a chip for every marker of the set, in a row that scrolls sideways on one line,
 * then, pinned on the right and always visible, the speaker and one dropdown per category.
 */
export function renderFilters(st: State, onChange: () => void) {
  // without labels there are no markers or categories to filter by; a filter left from another session or set would hide every line
  const set = labelSetOf(st);
  if (set?.id !== filterSet?.id || !set) {
    filters.markers.clear();
    filters.categories = {};
  }
  filterSet = set;
  const chips = (set?.markers ?? []).map((m) =>
    h("button", {
      class: "chip", "aria-pressed": String(filters.markers.has(m.id)), title: m.name,
      onclick: () => { filters.markers.has(m.id) ? filters.markers.delete(m.id) : filters.markers.add(m.id); onChange(); },
    }, icon(m.icon), m.name));
  const speakers = [...st.speakers.values()].filter((s) => !s.mergedInto);
  const categorySelect = (cat: LabelSet["categories"][number]) => {
    const value = filters.categories[cat.id] ?? "";
    const groups = [...new Set(cat.options.map((o) => o.group).filter((g): g is string => !!g))];
    return h("select", {
      class: "select", "aria-label": `${cat.name} filter`,
      onchange: (e: Event) => { filters.categories[cat.id] = (e.target as HTMLSelectElement).value; onChange(); },
    },
      h("option", { value: "" }, `All ${pluralOf(cat.name.toLowerCase())}`),
      groups.map((g) => h("option", { value: `group:${g}`, selected: value === `group:${g}` }, `${g} (all)`)),
      cat.options.map((o) => h("option", { value: o.id, selected: value === o.id }, o.name)));
  };
  const any = filters.markers.size || filters.speaker || categoryFiltered();
  // the row is redrawn as speakers and stats arrive: keep where it was scrolled to
  const scrolled = $("#filters .chip-row")?.scrollLeft ?? 0;
  const row = h("div", {
    class: "chip-row", role: "group", "aria-label": "Markers",
    // a mouse wheel scrolls the row sideways
    onwheel: ((e: WheelEvent) => {
      const el = e.currentTarget as HTMLElement;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { e.preventDefault(); el.scrollLeft += e.deltaY; }
    }) as EventListener,
  }, chips);
  replace($("#filters"),
    row,
    h("div", { class: "chip-pins" },
      h("select", { class: "select", "aria-label": "Speaker filter", onchange: (e: Event) => { filters.speaker = (e.target as HTMLSelectElement).value; onChange(); } },
        h("option", { value: "" }, "All speakers"),
        speakers.map((s) => h("option", { value: s.id, selected: filters.speaker === s.id }, s.displayName))),
      (set?.categories ?? []).map(categorySelect),
      any ? h("button", { class: "linkbtn", onclick: () => { filters.markers.clear(); filters.speaker = ""; filters.categories = {}; onChange(); } }, "Clear") : null));
  row.scrollLeft = scrolled;
  row.classList.toggle("overflows", row.scrollWidth > row.clientWidth + 1); // the fading edge says there is more
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
  const labelFilter = filters.markers.size > 0 || categoryFiltered();
  const set = labelSetOf(st);
  const markerDefs = new Map((set?.markers ?? []).map((m) => [m.id, m]));
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
      // a tag per category (the first in its option's colour, the others grey), then the markers' icons
      rows.push(h("div", { class: "segdiv", id: `seg-${seg.id}` },
        h("span", { class: "t" }, clock(seg.startMs)),
        (set?.categories ?? []).map((cat, i) => {
          const c = l?.choices[cat.id];
          if (!c) return null;
          return i === 0
            ? h("span", { class: `subj${c.faded ? " faded" : ""}`, style: `background:${optionColor(cat, c.choice)}` }, optionName(cat, c.choice))
            : h("span", { class: `mode${c.faded ? " faded" : ""}` }, optionName(cat, c.choice));
        }),
        (l?.markers ?? []).map((m) => { const d = markerDefs.get(m); return d ? h("span", { class: "mk", title: d.name }, icon(d.icon)) : null; }),
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
        // web pages only: a recording's events are data from wherever it came from
        v.sources.filter((s) => /^https?:\/\//i.test(s.url)).map((s) => h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.title || s.url))) : null,
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
  // the totals the stats add every minute (they were the Stats window's last line)
  const fc = st.stats?.factcheck;
  const verdicts = fc ? Object.entries(fc.verdicts ?? {}).filter(([, n]) => (n as number) > 0).map(([k, n]) => `${VERDICT_LABEL[k] ?? k} ${n}`).join(" · ") : "";
  replace(box,
    h("div", { class: "kv" }, "System 1 ", h("strong", {}, st.s1.active), ` · ${plural(st.s1.memorySize, "memory question")}`),
    h("div", { class: "counters" }, counters.map(([k, n, cls]) =>
      h("div", { class: `counter ${cls}` }, h("div", { class: "n" }, String(n)), h("div", { class: "k" }, k)))),
    fc ? h("dl", { class: "fc-totals" },
      h("dt", {}, "Verdicts"), h("dd", {}, verdicts || "None yet"),
      h("dt", {}, "System 2"), h("dd", {}, `${fc.researched ?? 0} researched · ${fc.duplicates ?? 0} duplicates · ${fc.dropped ?? 0} dropped`),
      h("dt", {}, "Rewrites"), h("dd", {}, `${fc.promoted ?? 0} promoted · ${fc.rejected ?? 0} rejected`)) : null,
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

// ---------- accounting and stats ----------

export function renderCost(st: State) {
  const c = st.cost;
  const box = $("#cost")!;
  box.classList.toggle("exhausted", !!st.budgetExhausted);
  box.setAttribute("aria-label", `Session spend ${usd(c.session)}`);
  const archived = st.session?.status === "archived";
  box.removeAttribute("data-tip"); // its hover breakdown explains it; a tooltip would sit on top of it
  replace(box,
    h("span", { class: "k" }, archived ? "Cost" : "Spend"),
    h("span", { class: "v" }, usd(c.session)),
    h("div", { class: "pop", role: "tooltip" },
      h("div", { class: "pop-h" }, archived ? "This recording cost" : "Session spend"),
      h("dl", {},
        h("dt", {}, "Transcription"), h("dd", {}, usd(c.transcription)),
        h("dt", {}, "Jev"), h("dd", {}, usd(c.jev)),
        h("dt", {}, "System 2"), h("dd", {}, usd(c.s2)),
        h("dt", {}, "Chat"), h("dd", {}, usd(c.chat ?? 0))),
      archived ? h("p", { class: "note" }, "What this recording cost when it ran, plus any chats about it. Opening it costs nothing.") : null,
      h("p", { class: "note" }, "The app sets no spending limit: the OpenRouter key's own credit limit is the only one."),
      st.budgetExhausted ? h("p", { class: "error-text" }, `OpenRouter stopped: ${st.budgetExhausted}`) : null));
}

/**
 * Insights → Overview, in the shape of the session's set: its index as the big number, each category's split, talk time
 * with each per-speaker marker's count and each score's average, and one list per listed marker (each entry jumps).
 */
export function renderStats(st: State) {
  const s = st.stats;
  if (!s) return replace($("#stats"), h("div", { class: "empty" }, "Stats arrive every minute and at the end of the show."));
  const set = labelSetOf(st);
  const markerDefs = new Map((set?.markers ?? []).map((m) => [m.id, m]));
  const scoreDefs = new Map((set?.scores ?? []).map((x) => [x.id, x]));
  const perSpeaker = Object.keys(s.speakers[0]?.markers ?? {}).filter((id) => markerDefs.has(id));
  const scoreIds = Object.keys(s.speakers[0]?.scores ?? {}).filter((id) => scoreDefs.has(id));
  const split = (c: Stats["categories"][number]) => {
    const cat = set?.categories.find((x) => x.id === c.id);
    if (!cat || !c.split.length) return null;
    const parts = [...c.split].sort((a, b) => b.share - a.share);
    return h("div", { class: "split-stat" },
      h("h3", {}, c.name),
      h("div", { class: "split-bar", role: "img", "aria-label": parts.map((p) => `${optionName(cat, p.option)} ${Math.round(p.share * 100)}%`).join(", ") },
        parts.map((p) => h("span", { style: `width:${(p.share * 100).toFixed(2)}%;background:${optionColor(cat, p.option)}`, title: `${optionName(cat, p.option)}: ${Math.round(p.share * 100)}% · ${clock(p.ms)}` }))),
      h("div", { class: "split-keys" }, parts.map((p) => h("span", {}, h("i", { style: `background:${optionColor(cat, p.option)}` }), `${optionName(cat, p.option)} ${Math.round(p.share * 100)}%`))));
  };
  const list = (l: Stats["lists"][number]) => {
    const def = markerDefs.get(l.markerId);
    if (!def) return null;
    return h("div", {},
      h("h3", {}, def.name),
      l.items.length
        ? h("ul", {}, l.items.map((x) => h("li", {}, h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); jumpToSegment(x.segmentId); } }, x.text || x.segmentId))))
        : h("p", { class: "note" }, "None yet"));
  };
  replace($("#stats"),
    s.index ? h("div", { class: "big" }, h("span", { class: "n" }, `${Math.round(s.index.share * 100)}%`), h("span", { class: "k" }, `${s.index.name} index: ${s.index.description}`)) : null,
    s.categories.map(split),
    h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "Speaker"), h("th", {}, "Talk"),
        perSpeaker.map((id) => h("th", {}, pluralOf(markerDefs.get(id)!.name))), scoreIds.map((id) => h("th", {}, scoreDefs.get(id)!.name)))),
      h("tbody", {}, s.speakers.map((sp) => h("tr", {},
        h("td", {}, speakerName(st, sp.speakerId)), h("td", {}, clock(sp.talkMs)),
        perSpeaker.map((id) => h("td", {}, String(sp.markers[id] ?? 0))),
        scoreIds.map((id) => h("td", {}, sp.scores[id] == null ? "–" : `${sp.scores[id]!.toFixed(1)} / 4`)))))),
    s.lists.length ? h("div", { class: "lists" }, s.lists.map(list)) : null);
}

export function renderErrors(st: State) {
  replace($("#log-count"), st.errors.length ? String(st.errors.length) : "");
  $("#log-count")?.classList.toggle("bad", st.errors.length > 0);
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
          if (ok !== null) void run(async () => {
            const c = await replayChoices();
            await api.replaySession(r.id, 1, voicesOnCall(), c.features, c.labelling);
            $<HTMLDialogElement>("#dlg-recordings")?.close();
          });
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
