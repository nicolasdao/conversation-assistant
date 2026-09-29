// The API keys and the transcription engine: the first-run setup screen, shown instead of the app until the keys the
// engine needs are set (only OpenAI's, and only when transcribing with OpenAI); the prompt for a key when a feature
// needs it (OpenRouter, for fact-checking, labels, and chat); the API keys window (cog menu) to replace one later; and
// the Transcription window. The server checks each key before saving it; it never sends a key back, only its last 4
// characters (see docs/setup.md).
import { api, type KeyName, type KeyStatus, type SaveKeysResult, type SetupStatus, type TranscriptionEngine, type TranscriptionStatus } from "./api.js";
import { $, h, replace, s } from "./dom.js";
import { desktop } from "./desktop.js";

interface Guide {
  title: string;
  role: string;
  /** One line under the field on the first-run screen. */
  short: string;
  what: string;
  steps: (string | Node)[][];
  placeholder: string;
}

const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);

const GUIDES: Record<KeyName, Guide> = {
  openai: {
    title: "OpenAI",
    role: "Transcription with OpenAI",
    short: "Turns what is said into text.",
    what: "Turns what is said into text, live as people speak and again when they finish, when OpenAI transcribes instead of this Mac. It is most of the cost of a show: about $1.23 an hour.",
    steps: [
      ["Sign in, or create an account, at ", link("https://platform.openai.com/signup", "platform.openai.com"), ". This is OpenAI's developer site, separate from a ChatGPT subscription."],
      ["Add credit: ", link("https://platform.openai.com/settings/organization/billing/overview", "Settings → Billing"), " → Add to credit balance. $10 is plenty to start. Leave automatic recharge off, so you are never charged more than you added."],
      ["Create a key: ", link("https://platform.openai.com/api-keys", "API keys"), " → Create new secret key. Name it Tattle and keep the default project and All permissions. Copy it: OpenAI shows it only once."],
      ["Paste it below. OpenAI keys start with sk-."],
    ],
    placeholder: "sk-…",
  },
  openrouter: {
    title: "OpenRouter",
    role: "Jev, fact-checking, and chat",
    short: "Runs Jev, fact-checking, and chat.",
    what: "One account for many AI models. The app uses it for Jev, which labels the show and spots claims on every line; for GPT-6 Luna, which researches those claims; and for the chat window. Up to about $0.40 an hour, plus any chat.",
    steps: [
      ["Sign in, or create an account, at ", link("https://openrouter.ai", "openrouter.ai"), "."],
      ["Add credit: ", link("https://openrouter.ai/settings/credits", "Settings → Credits"), " → Add credits. $10 is plenty to start. Leave auto top-up off."],
      ["Create a key: ", link("https://openrouter.ai/settings/keys", "Settings → API keys"), " → Create API key. Name it Tattle and give it a credit limit, for example $10: the key stops at that amount, whatever happens."],
      ["Paste it below. OpenRouter keys start with sk-or-."],
    ],
    placeholder: "sk-or-v1-…",
  },
};

let known: SetupStatus | null = null;

/** The page's first question: are the keys the engine needs set? Null when the server predates the setup routes. */
export async function setupStatus(): Promise<SetupStatus | null> {
  try { return (known = await api.setup()); } catch { return null; }
}

/** Whether a key is set, as last heard from the server (the prompts ask again before they show). */
export function keySet(name: KeyName): boolean {
  return !!known?.keys.find((k) => k.name === name)?.set;
}

// ---------- the transcription engine, as the page knows it ----------

let transcription: TranscriptionStatus | null = null;
const listeners = new Set<() => void>();

export function transcriptionState(): TranscriptionStatus | null {
  return transcription;
}

/** Called on every change (the engine, Apple's model, its install progress). */
export function onTranscription(fn: () => void) {
  listeners.add(fn);
}

export function setTranscription(t: TranscriptionStatus | null) {
  transcription = t;
  for (const fn of listeners) fn();
}

export async function refreshTranscription(): Promise<TranscriptionStatus | null> {
  try { setTranscription(await api.transcription()); } catch { /* an older server has no engine setting */ }
  return transcription;
}

interface Field { name: KeyName; input: HTMLInputElement; msg: HTMLElement; chip: HTMLElement }

/** The usual paste mistakes, caught as the key is typed (the server checks the same and more before saving). */
function formatProblem(name: KeyName, key: string): string | null {
  if (/\s/.test(key)) return "A key has no spaces or line breaks: copy it again.";
  if (name === "openai" && key.startsWith("sk-or-")) return "This is an OpenRouter key: paste it in the OpenRouter field.";
  if (name === "openrouter" && key.startsWith("sk-") && !key.startsWith("sk-or-")) return "This looks like an OpenAI key: OpenRouter keys start with sk-or-.";
  if (key.length < 20) return "This looks too short to be a whole key.";
  return null;
}

/** A key field with Show / Hide; Enter submits. */
function keyInput(name: KeyName, placeholder: string, submit: () => void, cls = "input key-input"): { row: HTMLElement; input: HTMLInputElement } {
  const input = h("input", {
    class: cls, type: "password", autocomplete: "off", spellcheck: "false", autocapitalize: "off",
    placeholder, "aria-label": `${GUIDES[name].title} API key`,
    onkeydown: ((e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }) as EventListener,
  });
  const show = h("button", { class: "btn", type: "button", "aria-pressed": "false" }, "Show");
  show.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    show.textContent = showing ? "Show" : "Hide";
    show.setAttribute("aria-pressed", String(!showing));
  });
  return { row: h("div", { class: "row key-row" }, input, show), input };
}

const steps = (name: KeyName) => h("ol", { class: "key-steps" }, GUIDES[name].steps.map((s) => h("li", {}, s)));

/** Checks and saves the keys typed into `fields`, showing each result under its field. */
async function saveFields(fields: Field[]): Promise<SaveKeysResult> {
  for (const f of fields) { f.msg.className = "key-msg"; f.msg.textContent = `Checking with ${GUIDES[f.name].title}…`; }
  const r = await api.saveKeys(Object.fromEntries(fields.map((f) => [f.name, f.input.value.trim()])));
  for (const f of fields) {
    const c = r.checks[f.name];
    if (!c) continue;
    f.msg.className = `key-msg ${!c.ok ? "bad" : c.warning ? "warn" : "good"}`;
    replace(f.msg, c.ok ? (r.saved ? `✓ ${c.message}` : `${c.message}, not saved until the other key works`) : c.message, c.warning ? h("span", {}, ` ${c.warning}`) : null);
    if (r.saved) {
      f.input.value = "";
      const s = r.keys.find((k) => k.name === f.name);
      if (s?.hint) { f.chip.textContent = `Saved · …${s.hint}`; f.input.placeholder = `Paste a new key to replace …${s.hint}`; }
    }
  }
  return r;
}

// ---------- the first-run screen ----------

/** A drawn padlock, inline: the page's symbol sheet is hidden while the setup screen shows. */
const padlock = () => s("svg", { class: "setup-lock", viewBox: "0 0 24 24", "aria-hidden": "true" },
  s("rect", { x: "4.5", y: "10.5", width: "15", height: "11", rx: "1.5", fill: "currentColor" }),
  s("path", { d: "M8 10.5V7.5a4 4 0 0 1 8 0v3", fill: "none", stroke: "currentColor", "stroke-width": "2.2" }),
  s("circle", { cx: "12", cy: "15.5", r: "1.7", style: "fill: var(--deck)" }));

/** Where the keys go, said plainly where the eye lands before pressing Save. */
const trust = () => h("div", { class: "setup-trust" }, padlock(),
  h("div", {},
    h("b", {}, "Your keys stay on this Mac"),
    h("span", {}, "Tattle has no server of its own. Your keys are saved on this computer and each is sent only to its own service, to use your account with it. Never to us, never anywhere else.")));

/**
 * The first-run screen, instead of the app: nothing else loads until the required keys are saved, which is OpenAI's
 * alone and only when OpenAI transcribes (a Mac that cannot run Apple Speech, or someone who chose OpenAI). What stands
 * out is the field and one button; how to get the key folds away under it, for whoever needs it.
 */
export function showSetup(status: SetupStatus, t: TranscriptionStatus | null = null) {
  document.body.classList.add("setup-mode");
  const required = status.required ?? status.keys.map((k) => k.name);
  const names = status.keys.filter((k) => !k.set && required.includes(k.name)).map((k) => k.name);
  const fields: Field[] = [];
  const save = h("button", { class: "btn primary setup-go", type: "button" });
  const progress = h("p", { class: "setup-progress", "aria-live": "polite" });
  const general = h("p", { class: "key-msg", "aria-live": "polite" });
  const label = () => (names.length > 1 ? "Save keys and start" : "Save key and start");
  let busy = false;

  /** A field is ready once it holds something that looks like a key of its kind. */
  const ready = (f: Field) => !!f.input.value.trim() && !formatProblem(f.name, f.input.value.trim());
  const refresh = () => {
    const n = fields.filter(ready).length;
    progress.textContent = n === fields.length ? `${fields.length > 1 ? "Both keys" : "Key"} added: press ${label()}` : `${n} of ${fields.length} key${fields.length > 1 ? "s" : ""} added`;
    progress.classList.toggle("done", n === fields.length);
    save.classList.toggle("armed", n === fields.length);
  };

  const submit = async () => {
    if (busy) return;
    replace(general);
    const missing = fields.filter((f) => !ready(f));
    for (const f of missing) mark(f, true);
    if (missing.length) { missing[0].input.focus(); return; }
    busy = true;
    save.disabled = true;
    save.textContent = "Checking your keys…";
    try {
      const r = await saveFields(fields);
      if (r.saved) return done(r);
    } catch (e) {
      general.className = "key-msg bad";
      general.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      save.disabled = false;
      save.textContent = label();
    }
  };

  /** The field's state, on its border and badge: required (empty), looks right, or a problem to fix. */
  const mark = (f: Field, strict: boolean) => {
    const v = f.input.value.trim();
    const problem = v ? formatProblem(f.name, v) : strict ? "Paste this key to continue." : null;
    const box = f.input.closest(".setup-field")!;
    box.classList.toggle("ok", !!v && !problem);
    box.classList.toggle("bad", !!problem);
    f.chip.textContent = problem ? "Check this key" : v ? "✓ Looks right" : "Required";
    f.msg.className = problem ? "key-msg bad" : "key-msg";
    f.msg.textContent = problem ?? "";
  };

  const cards = names.map((name, i) => {
    const g = GUIDES[name];
    const { row, input } = keyInput(name, `Paste your ${g.title} key here (${g.placeholder})`, () => void submit(), "input key-input setup-input");
    const chip = h("span", { class: "setup-badge" }, "Required");
    const msg = h("p", { class: "key-msg", "aria-live": "polite" });
    const f: Field = { name, input, msg, chip };
    fields.push(f);
    input.addEventListener("input", () => { mark(f, false); refresh(); });
    return h("div", { class: "setup-field" },
      h("label", { class: "setup-label" },
        names.length > 1 ? h("span", { class: "key-step" }, String(i + 1)) : null,
        h("span", {}, `${g.title} API key`), chip),
      row,
      h("p", { class: "setup-for" }, g.short),
      msg,
      h("details", { class: "key-how" },
        h("summary", {}, `How do I get an ${g.title} key? About 5 minutes`),
        h("p", { class: "key-what" }, g.what),
        steps(name)));
  });

  const root = h("main", { id: "setup", class: "setup" });
  const actions = h("div", { class: "setup-actions" }, save, progress, general);
  const done = (r: SaveKeysResult) => {
    const warned = Object.values(r.checks).some((c) => c?.warning);
    const go = h("button", { class: "btn primary setup-go armed", type: "button", onclick: () => location.reload() }, "Open Tattle");
    // a warning is worth reading before moving on; otherwise the app opens by itself
    replace(actions, go, h("p", { class: "setup-progress done" }, warned ? "Saved. Read the note above, then open the app." : "All set. Opening Tattle…"));
    if (!warned) setTimeout(() => location.reload(), 1200);
    go.focus();
  };
  save.textContent = label();
  save.addEventListener("click", () => void submit());
  refresh();

  replace(root, h("div", { class: "setup-inner" },
    h("div", { class: "setup-brand" }, h("i"), "Tattle"),
    h("h1", {}, names.length > 1 ? "Add your two API keys to start" : `Add your ${GUIDES[names[0]].title} API key to start`),
    h("p", { class: "setup-lede" },
      // why a key at all, when a newer Mac needs none
      t && !t.apple.available
        ? "On-device transcription needs macOS 26 or later. On this Mac, Tattle transcribes with OpenAI, which you pay directly, only for what you use. No key yet? Open the guide under the field."
        : "You chose OpenAI for transcription. OpenAI is paid directly, only for what you use. No key yet? Open the guide under the field."),
    h("section", { class: "setup-panel" }, cards, actions, trust()),
    h("p", { class: "note setup-privacy" },
      "A transcript costs about $1.23 an hour, from prepaid credit. Fact-checking and labels add up to $0.40 an hour and need an OpenRouter key, which the app asks for when you turn them on. ",
      `Keys are saved in ${status.path}, readable only by your macOS user. Change them later: ${desktop ? "Tattle → Settings… (⌘,)" : "cog menu → API keys"}.`)));
  document.body.append(root);
  fields[0]?.input.focus();
}

// ---------- the API keys window ----------

/** When each key is needed: neither is required to open the app, except OpenAI's when OpenAI transcribes. */
const NEEDED: Record<KeyName, string> = {
  openai: "Needed only for OpenAI transcription.",
  openrouter: "Needed for fact-checking, labels, and Chat.",
};

/** One card per key: the key in use, a field to replace it, and the guide folded away (open when `guide` says so). */
function keyCard(name: KeyName, status: KeyStatus | undefined, submit: () => void, guide = false): { el: HTMLElement; field: Field | null } {
  const g = GUIDES[name];
  const fromEnv = status?.source === "environment";
  const chip = h("span", { class: "key-chip" });
  if (status?.set) chip.append(fromEnv ? `.env · …${status.hint}` : `Saved · …${status.hint}`);
  const msg = h("p", { class: "key-msg", "aria-live": "polite" });
  let field: Field | null = null;
  let control: HTMLElement;
  if (fromEnv) {
    control = h("p", { class: "note" }, `Set by ${status!.env} in .env or your shell, which wins over this page: change it there.`);
  } else {
    const k = keyInput(name, status?.set ? `Paste a new key to replace …${status.hint}` : g.placeholder, submit);
    control = k.row;
    field = { name, input: k.input, msg, chip };
  }
  const el = h("section", { class: "key-card" },
    h("div", { class: "key-head" }, h("h2", {}, g.title), h("span", { class: "key-role" }, g.role), chip),
    h("p", { class: "key-what" }, g.what, h("b", { class: "key-needed" }, ` ${NEEDED[name]}`)),
    h("details", { class: "key-how", open: guide }, h("summary", {}, "How to get this key"), steps(name)),
    control, msg);
  return { el, field };
}

/**
 * A key asked for where it is needed, inside the open window (a popover outside a modal dialog cannot be clicked:
 * docs/gotchas.md): the heading says why, then the key's card with its guide, Save, and Not now. `onSaved` runs once
 * the key is checked and saved; `onCancel` on Not now.
 */
export function keyPrompt(name: KeyName, heading: string, done: { onSaved: () => void; onCancel?: () => void }): HTMLElement {
  const status = known?.keys.find((k) => k.name === name);
  const general = h("p", { class: "key-msg", "aria-live": "polite" });
  const save = h("button", { class: "btn primary", type: "button" }, "Save");
  let field: Field | null = null;
  const submit = async () => {
    if (!field || save.disabled) return;
    if (!field.input.value.trim()) { general.className = "key-msg bad"; general.textContent = "Paste the key to save it."; return; }
    replace(general);
    save.disabled = true;
    try {
      const r = await saveFields([field]);
      known = r;
      if (r.saved) done.onSaved();
    } catch (e) {
      general.className = "key-msg bad";
      general.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      save.disabled = false;
    }
  };
  const card = keyCard(name, status, () => void submit(), true);
  field = card.field;
  save.addEventListener("click", () => void submit());
  const cancel = done.onCancel ? h("button", { class: "btn", type: "button", onclick: done.onCancel }, "Not now") : null;
  const el = h("div", { class: "key-prompt", role: "group", "aria-label": heading },
    h("p", { class: "key-prompt-h" }, heading), card.el,
    h("div", { class: "row end key-actions" }, general, cancel, field ? save : null));
  requestAnimationFrame(() => field?.input.focus());
  return el;
}

/** The API keys window (cog menu; Settings… in the Mac app): replaces a key; the next call uses it, without a restart. */
export async function renderKeys(onSaved: (message: string) => void) {
  const box = $("#keys");
  if (!box) return;
  const status = await setupStatus();
  if (!status) { replace(box, h("p", { class: "empty" }, "This server cannot manage keys: restart it with npm run serve.")); return; }
  const fields: Field[] = [];
  const general = h("p", { class: "key-msg", "aria-live": "polite" });
  const save = h("button", { class: "btn primary", type: "button" }, "Save");
  const submit = async () => {
    if (save.disabled) return;
    const given = fields.filter((f) => f.input.value.trim());
    if (!given.length) { general.className = "key-msg bad"; general.textContent = "Paste a key to save."; return; }
    replace(general);
    save.disabled = true;
    try {
      if ((await saveFields(given)).saved) onSaved("API key saved: the next call uses it");
    } catch (e) {
      general.className = "key-msg bad";
      general.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      save.disabled = false;
    }
  };
  save.addEventListener("click", () => void submit());
  known = status;
  const cards = (["openai", "openrouter"] as KeyName[]).map((n) => {
    const c = keyCard(n, status.keys.find((k) => k.name === n), () => void submit());
    if (c.field) fields.push(c.field);
    return c.el;
  });
  // keys set in .env cannot be changed here: nothing to save
  replace(box, cards, h("div", { class: "row end key-actions", hidden: fields.length === 0 }, general, save),
    h("p", { class: "note" }, `Neither key is needed to open the app. Saved keys are in ${status.path}, readable only by your macOS user.`));
}

// ---------- the Transcription window ----------

const MODEL_LINE: Record<string, (t: TranscriptionStatus) => string> = {
  missing: () => "Getting ready…",
  installing: (t) => `Getting on-device speech recognition ready… ${Math.round((t.apple.fraction ?? 0) * 100)} %`,
  installed: () => "Ready",
  error: (t) => t.apple.error ?? "Could not get ready",
};

/** One line for the settings menu. */
export function transcriptionSummary(t: TranscriptionStatus | null): string {
  if (!t) return "";
  return t.engine === "apple" ? "On this Mac" : "OpenAI";
}

let onAir = false;

/** Whether a session is on air: the engine cannot change then. */
export function setOnAir(v: boolean) {
  if (v === onAir) return;
  onAir = v;
  if ($<HTMLDialogElement>("#dlg-transcription")?.open) void renderTranscription(() => {});
}

/**
 * The Transcription window (cog menu): Apple Speech on this Mac, or OpenAI. Choosing OpenAI without its key shows the
 * key's card first. Read-only while a session is on air.
 */
export async function renderTranscription(onSaved: (message: string) => void) {
  const box = $("#transcription");
  if (!box) return;
  const t = await refreshTranscription();
  if (!t) { replace(box, h("p", { class: "empty" }, "This server has no transcription setting: restart it with npm run serve.")); return; }
  await setupStatus();
  const msg = h("p", { class: "key-msg", "aria-live": "polite" });
  const extra = h("div", {});
  const choose = async (engine: TranscriptionEngine) => {
    if (onAir || engine === t.engine) return;
    replace(msg);
    if (engine === "openai" && !keySet("openai")) {
      replace(extra, keyPrompt("openai", "Transcribing with OpenAI needs your OpenAI API key.", {
        onSaved: () => void choose("openai"),
        onCancel: () => replace(extra),
      }));
      return;
    }
    try {
      setTranscription(await api.setTranscription(engine));
      onSaved(engine === "apple" ? "Transcription: on this Mac" : "Transcription: OpenAI");
      void renderTranscription(onSaved);
    } catch (e) {
      msg.className = "key-msg bad";
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  // the model's state sits under its option, not inside it: a button cannot hold another (Try again)
  const option = (engine: TranscriptionEngine, title: string, text: string, disabled: string | null, status: Node | null) =>
    h("div", { class: "engine-opt" },
      h("button", {
        class: "feat engine-choice", role: "radio", type: "button", "aria-checked": String(t.engine === engine),
        disabled: onAir || !!disabled, onclick: () => void choose(engine),
      },
      h("span", { class: "feat-text" }, h("b", {}, title), h("span", {}, text), disabled ? h("span", { class: "engine-why" }, disabled) : null),
      h("span", { class: "radio", "aria-hidden": "true" }, h("i"))),
      status ? h("p", { class: "engine-state" }, status) : null);
  const model = t.apple.model;
  const retry = h("button", { class: "linkbtn", type: "button", onclick: () => void api.installModel().then(setTranscription).then(() => renderTranscription(onSaved)).catch(() => {}) }, "Try again");
  const appleState = t.apple.available ? h("span", {}, MODEL_LINE[model](t), model === "error" ? " " : null, model === "error" ? retry : null) : null;
  replace(box,
    onAir ? h("p", { class: "note engine-onair" }, "A session is on air: the engine can be changed when it ends.") : null,
    h("div", { class: "engine-list", role: "radiogroup", "aria-label": "Transcription" },
      option("apple", "On this Mac (Apple Speech)", "Free. Audio never leaves your Mac. Less accurate on names and jargon.",
        t.apple.available ? null : (t.apple.reason ?? "Not available on this Mac"), appleState),
      option("openai", "OpenAI", "More accurate on names and jargon. About $1.23 an hour of show. Needs an OpenAI key.", null, null)),
    extra, msg,
    h("p", { class: "note" }, "The engine is chosen for the next session; a session keeps the one it started with."));
}
