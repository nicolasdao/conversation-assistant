// Label sets on the page: the Labels library (cog → Labels), the editor, and export and import of `.tattle-labels`
// files. Sets are plain files on this Mac: none of this needs an API key or calls a model. See docs/jev.md § label sets.
import { api, ApiError, type LabelSetCheck, type LabelSetEntry, type LabelSetList, type LabelTry, type SessionSummary } from "./api.js";
import { $, clock, h, icon, replace } from "./dom.js";
import { ICONS } from "./icons.js";
import { keyPrompt, keySet, setupStatus } from "./keys.js";
import { ask, toast } from "./panels.js";
import { renderPreview } from "./timeline.js";
import type { Labels, LabelSet } from "./state.js";

export const LIMITS = { categories: 2, scores: 2, markers: 8, options: 255 } as const;
/** The 12 colours offered for options (the built-in set's own, so a clone stays in the app's look). */
export const PALETTE = [
  "#3f7df0", "#6fa0ff", "#2a58c9", "#1fa89a", "#2fb39c", "#d0892a", "#d99a2b", "#d9588a", "#d9679a", "#8b6fd6", "#9a7fe0", "#6f7a8c",
];
const LEVEL_HINTS = ["Lowest (0)", "1", "2", "3", "Highest (4)"];

const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const counts = (c: LabelSetEntry["counts"]) =>
  [`${c.categories} categor${c.categories === 1 ? "y" : "ies"}`, `${c.scores} score${c.scores === 1 ? "" : "s"}`, `${c.markers} marker${c.markers === 1 ? "" : "s"}`].join(" · ");

/** An id from a name, as Jev wants them (snake_case): "Hot take" → hot_take, "Clip-worthy" → clip_worthy. */
export function toId(name: string, fallback = "label"): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return fallback;
  return /^[a-z]/.test(s) ? s : `n_${s}`;
}

// ---------- the library: cog → Labels ----------

let library: LabelSetList | null = null;

/** The cog menu's summary for Labels. */
function summarize() {
  const n = library?.sets.length;
  replace($("#m-labels"), n === undefined ? "Label sets" : `${n} set${n === 1 ? "" : "s"}`);
}

/** Reads the library (also for Start live's picker); keeps the last answer. */
export async function loadLabelSets(): Promise<LabelSetList | null> {
  try {
    library = await api.labelSets();
  } catch { /* an older server: the picker shows the built-in set only */ }
  summarize();
  return library;
}

export function labelSetsKnown(): LabelSetEntry[] {
  return library?.sets ?? [];
}

/** Downloads a set as `<name>.tattle-labels` (the Mac app saves it to Downloads, like a recording's export). */
function exportSet(id: string) {
  const a = h("a", { href: api.labelSetExportUrl(id), download: "" });
  document.body.append(a);
  a.click();
  a.remove();
}

/** Imports a shared `.tattle-labels` file: a new set, renamed if its name is taken. Also called when one is dropped on the page. */
export async function importLabelFile(file: File) {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return toast("That file is not a label set: it should be a .tattle-labels file.");
  }
  try {
    const set = await api.importLabelSet<LabelSet>(json);
    toast(`Imported the label set ${set.name}`, "ok");
    await renderLabelLibrary();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok, "ok");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

function setRow(s: LabelSetEntry, refresh: () => Promise<void>): HTMLElement {
  const open = () => void openLabelSet(s.id);
  const rename = async (e: Event) => {
    e.stopPropagation();
    const name = await ask("Rename the label set", { input: true, value: s.name, ok: "Rename" });
    if (name === null || !name.trim() || name.trim() === s.name) return;
    await run(async () => {
      const set = await api.labelSet<LabelSet>(s.id);
      await api.updateLabelSet(s.id, { ...set, name: name.trim() });
      await refresh();
    }, `Renamed to ${name.trim()}`);
  };
  return h("div", {
    class: `rec lset${s.broken ? " broken" : ""}`, role: "button", tabindex: 0,
    title: s.broken ? "This file cannot be used" : s.builtIn ? "Open it: the built-in set is read-only; clone it to edit a copy" : "Open it to edit",
    onclick: s.broken ? null : open,
    onkeydown: (e: Event) => { const k = (e as KeyboardEvent).key; if (!s.broken && (k === "Enter" || k === " ") && e.target === e.currentTarget) { e.preventDefault(); open(); } },
  },
    h("div", { class: "rec-head" },
      s.builtIn || s.broken ? h("span", { class: "rec-title" }, s.name)
        : h("button", { class: "rec-title", title: "Click to rename", onclick: rename }, s.name),
      s.builtIn ? h("span", { class: "badge cur" }, "Built-in") : null,
      s.broken ? h("span", { class: "badge inc", title: s.broken }, "Broken") : null,
      s.builtIn
        ? h("button", { class: "btn sm lset-first", title: "Copy it as your own set, to edit", onclick: (e: Event) => { e.stopPropagation(); void cloneAndEdit(s.id); } }, "Clone")
        : h("button", { class: "btn sm lset-first", disabled: !!s.broken, onclick: (e: Event) => { e.stopPropagation(); open(); } }, "Edit"),
      h("button", {
        class: "btn sm", disabled: !!s.broken, title: "Save it as one .tattle-labels file to share",
        onclick: (e: Event) => { e.stopPropagation(); exportSet(s.id); },
      }, icon("link", "g"), "Export"),
      s.builtIn ? null : h("button", {
        class: "btn icon sm rec-delete", "aria-label": `Delete ${s.name}`, title: "Delete this label set",
        onclick: async (e: Event) => {
          e.stopPropagation();
          const ok = await ask(`Delete “${s.name}”?`, {
            message: "Recordings made with it keep their own copy, so they are not affected. This can't be undone.", ok: "Delete", danger: true,
          });
          if (ok !== null) await run(async () => { await api.deleteLabelSet(s.id); await refresh(); }, `Deleted ${s.name}`);
        },
      }, h("span", { "aria-hidden": "true" }, "×"))),
    h("div", { class: "meta" }, s.broken ? `Cannot be used: ${s.broken}` : [
      s.description || null, counts(s.counts), s.perHourUsd !== undefined ? `about ${money(s.perHourUsd)} an hour of Jev` : null,
    ].filter(Boolean).join(" · ")));
}

async function cloneAndEdit(id: string) {
  try {
    const copy = await api.cloneLabelSet<LabelSet>(id);
    await renderLabelLibrary();
    toast(`Cloned as ${copy.name}: edit it here`, "ok");
    await openLabelSet(copy.id);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

/** Cog → Labels: every set, the built-in one first, with New, Import, and (with a key) Create with AI. */
export async function renderLabelLibrary() {
  const box = $("#labels");
  if (!box) return;
  const refresh = () => renderLabelLibrary();
  if (!box.querySelector(".lset-list")) {
    const picker = h("input", { type: "file", accept: ".tattle-labels,.json", hidden: true });
    picker.addEventListener("change", () => { const f = picker.files?.[0]; if (f) void importLabelFile(f); picker.value = ""; });
    replace(box,
      h("div", { class: "rec-tools lset-tools" },
        h("button", { class: "btn primary", onclick: () => openEditor(blankSet(), { readOnly: false }) }, "New"),
        h("button", { class: "btn", title: "Add a .tattle-labels file someone shared with you", onclick: () => picker.click() }, "Import"),
        h("button", { class: "btn", title: "Describe your show and let GPT-6 Luna draft a set for you to review (needs the OpenRouter key)", onclick: () => openCreateWithAi() }, icon("sparkle"), "Create with AI"),
        picker),
      h("div", { class: "rec-list lset-list" }),
      h("p", { class: "note" }, "A label set is what the timeline asks Jev about each stretch of a show: up to 2 categories, 2 scores, and 8 markers. Pick one in Start live. Sets are files on this Mac; making or editing one sends nothing anywhere."));
  }
  const list = box.querySelector(".lset-list")!;
  const l = await loadLabelSets();
  if (!l) return replace(list, h("div", { class: "error-text" }, "The label sets could not be read: restart the app, or npm run serve."));
  replace(list, l.sets.map((s) => setRow(s, refresh)));
}

// ---------- the editor ----------

interface EOption { key: number; name: string; description: string; color: string; group: string }
interface ECategory { key: number; name: string; instructions: string; options: EOption[]; index: { name: string; description: string; keys: Set<number> } | null }
interface EScore { key: number; name: string; instructions: string; levels: string[] }
interface EMarker {
  key: number; name: string; short: string; icon: string; instructions: string; yes: string; no: string;
  threshold: number; perSpeaker: boolean; list: boolean;
}
/** The set being edited, in a form the inputs change in place; ids are derived from names when it is read back. */
export interface EditModel {
  id: string | null; builtIn: boolean; name: string; description: string; prefix: string; faded: number; companies: string;
  categories: ECategory[]; scores: EScore[]; markers: EMarker[];
}

let nextKey = 1;

export function blankSet(): LabelSet {
  return {
    format: "tattle-labels", version: 1, id: "", name: "", description: "", prefix: "Judge only segment; previous_segment is context only.",
    fadedBelowConfidence: 0.5, companies: [], categories: [], scores: [], markers: [],
  };
}

export function toModel(set: LabelSet): EditModel {
  return {
    id: set.id || null, builtIn: !!set.builtIn, name: set.name, description: set.description, prefix: set.prefix,
    faded: set.fadedBelowConfidence, companies: set.companies.join("\n"),
    categories: set.categories.map((c) => {
      const options = c.options.map((o) => ({ key: nextKey++, name: o.name, description: o.description, color: o.color, group: o.group ?? "" }));
      const byId = new Map(c.options.map((o, i) => [o.id, options[i].key]));
      return {
        key: nextKey++, name: c.name, instructions: c.instructions, options,
        index: c.index ? { name: c.index.name, description: c.index.description, keys: new Set(c.index.options.map((o) => byId.get(o)).filter((k): k is number => k !== undefined)) } : null,
      };
    }),
    scores: set.scores.map((x) => ({ key: nextKey++, name: x.name, instructions: x.instructions, levels: [...x.levels] })),
    markers: set.markers.map((m) => ({
      key: nextKey++, name: m.name, short: m.short, icon: m.icon, instructions: m.instructions, yes: m.criteria?.true ?? "", no: m.criteria?.false ?? "",
      threshold: m.threshold, perSpeaker: m.perSpeaker, list: m.list,
    })),
  };
}

/** The model as a set, as the engine validates it: ids from names, trimmed text, criteria only when both are written. */
export function fromModel(m: EditModel): LabelSet {
  const t = (s: string) => s.trim();
  return {
    format: "tattle-labels", version: 1, id: m.id ?? "", name: t(m.name), description: t(m.description), prefix: t(m.prefix),
    fadedBelowConfidence: m.faded, companies: m.companies.split("\n").map(t).filter(Boolean),
    categories: m.categories.map((c) => {
      const ids = new Map(c.options.map((o) => [o.key, toId(o.name, "option")]));
      return {
        id: toId(c.name, "category"), name: t(c.name), instructions: t(c.instructions),
        options: c.options.map((o) => ({ id: ids.get(o.key)!, name: t(o.name), description: t(o.description), color: o.color, ...(t(o.group) ? { group: t(o.group) } : {}) })),
        ...(c.index ? { index: { name: t(c.index.name), description: t(c.index.description), options: c.options.filter((o) => c.index!.keys.has(o.key)).map((o) => ids.get(o.key)!) } } : {}),
      };
    }),
    scores: m.scores.map((x) => ({ id: toId(x.name, "score"), name: t(x.name), instructions: t(x.instructions), levels: x.levels.map(t) })),
    markers: m.markers.map((k) => ({
      id: toId(k.name, "marker"), name: t(k.name), short: t(k.short) || t(k.name).slice(0, 20), icon: k.icon, instructions: t(k.instructions),
      ...(t(k.yes) && t(k.no) ? { criteria: { true: t(k.yes), false: t(k.no) } } : {}),
      threshold: k.threshold, perSpeaker: k.perSpeaker, list: k.list,
    })),
  };
}

/** Opens a set from the library in the editor: the built-in one read-only. */
export async function openLabelSet(id: string) {
  try {
    const set = await api.labelSet<LabelSet>(id);
    openEditor(set, { readOnly: !!set.builtIn });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

/** What the editor can host beyond its form: Tier 3's Try on a recording adds a button to its footer. */
export interface EditorHost {
  /** The model on screen. */
  model(): EditModel;
  /** Replaces the whole model (Create with AI's drafts), keeping the host's place. */
  load(set: LabelSet): void;
  /** The element that holds the form. */
  el: HTMLElement;
}
let footerExtras: ((host: EditorHost, footer: HTMLElement) => void) | null = null;
export function setEditorExtras(fn: (host: EditorHost, footer: HTMLElement) => void) {
  footerExtras = fn;
}

/**
 * The editor as a component: the form, the live check (validation and the cost estimate from the engine, 500 ms after
 * the last change), and a footer. `#dlg-labelset` hosts it; Create with AI hosts it beside its chat.
 */
export function labelEditor(start: LabelSet, opts: { readOnly: boolean; onChange?: () => void }): EditorHost & { footer: HTMLElement; check(): Promise<LabelSetCheck | null>; lastCheck(): LabelSetCheck | null } {
  let model = toModel(start);
  let readOnly = opts.readOnly;
  const form = h("div", { class: "lset-form" });
  const status = h("div", { class: "lset-status", "aria-live": "polite" });
  const footer = h("div", { class: "lset-foot" }, status);
  const el = h("div", { class: "lset-editor" }, form, footer);
  let timer: number | undefined;
  let checked: LabelSetCheck | null = null;
  let seq = 0;

  const check = async () => {
    const mine = ++seq;
    try {
      const r = await api.checkLabelSet(fromModel(model));
      if (mine !== seq) return checked;
      checked = r;
      showStatus();
      return r;
    } catch (e) {
      replace(status, h("span", { class: "error-text" }, e instanceof Error ? e.message : String(e)));
      return null;
    }
  };
  const changed = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void check(), 500);
    opts.onChange?.();
  };
  const showStatus = () => {
    if (!checked) return replace(status);
    const cost = h("span", { class: `lset-cost${checked.overLimit ? " over" : ""}` },
      `About ${money(checked.perHourUsd)} per hour · ${checked.tokens.toLocaleString()} tokens per call of 32,000`,
      checked.overLimit ? " · too long: Jev refuses calls over its limit" : "");
    replace(status,
      checked.ok ? null : h("ul", { class: "lset-errors" }, checked.errors.slice(0, 8).map((e) => h("li", {}, e)), checked.errors.length > 8 ? h("li", {}, `and ${checked.errors.length - 8} more`) : null),
      cost);
    el.dispatchEvent(new CustomEvent("lset-check", { detail: checked }));
  };

  // inputs change the model in place; adding or removing a part redraws the form
  const text = (get: () => string, set: (v: string) => void, attrs: Record<string, string | number | boolean> = {}) => {
    const input = h("input", { class: "input", value: get(), disabled: readOnly, ...attrs });
    input.addEventListener("input", () => { set(input.value); changed(); });
    return input;
  };
  const area = (get: () => string, set: (v: string) => void, rows = 2, attrs: Record<string, string | number | boolean> = {}) => {
    const t = h("textarea", { class: "input", rows, disabled: readOnly, ...attrs }, get());
    t.addEventListener("input", () => { set(t.value); changed(); });
    return t;
  };
  const check_ = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = h("input", { type: "checkbox", disabled: readOnly });
    box.checked = get();
    box.addEventListener("change", () => { set(box.checked); changed(); });
    return h("label", { class: "lset-check" }, box, label);
  };
  const field = (label: string, control: Node, hint?: string) => h("label", { class: "fieldlabel" }, label, control, hint ? h("span", { class: "hint" }, hint) : null);
  const remove = (label: string, fn: () => void) => readOnly ? null : h("button", { class: "linkbtn danger", type: "button", onclick: () => { fn(); draw(); changed(); } }, label);
  const add = (label: string, n: number, max: number, fn: () => void) => readOnly ? null :
    h("button", { class: "btn sm", type: "button", disabled: n >= max, onclick: () => { fn(); draw(); changed(); } }, `${label} (${n} of ${max})`);

  /** A swatch that opens the palette in place, inside the dialog (a popover on <body> would be inert: docs/gotchas.md § Web page). */
  const colorPicker = (o: EOption) => {
    const swatch = h("button", { class: "lset-swatch", type: "button", style: `background:${o.color}`, disabled: readOnly, "aria-label": `Colour ${o.color}`, title: "Colour" });
    const hex = h("input", { class: "input lset-hex", value: o.color, maxlength: 7, "aria-label": "Colour as #rrggbb" });
    const pal = h("div", { class: "lset-palette", hidden: true },
      PALETTE.map((c) => h("button", {
        class: "lset-swatch", type: "button", style: `background:${c}`, "aria-label": c, title: c,
        onclick: () => { o.color = c; swatch.style.background = c; hex.value = c; pal.hidden = true; changed(); },
      })), hex);
    hex.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) { o.color = hex.value; swatch.style.background = hex.value; } else o.color = hex.value; changed(); });
    swatch.addEventListener("click", () => { pal.hidden = !pal.hidden; });
    return { swatch, pal };
  };

  /** The icon grid, in place, like the palette. */
  const iconPicker = (m: EMarker) => {
    const btn = h("button", { class: "btn icon sm lset-icon", type: "button", disabled: readOnly, title: "Icon", "aria-label": `Icon: ${m.icon}` }, icon(m.icon));
    const grid = h("div", { class: "lset-icons", hidden: true, role: "listbox", "aria-label": "Icons" },
      ICONS.map((name) => h("button", {
        class: `lset-icon-choice${name === m.icon ? " on" : ""}`, type: "button", title: name, "aria-label": name, role: "option", "aria-selected": String(name === m.icon),
        onclick: () => { m.icon = name; grid.hidden = true; draw(); changed(); },
      }, icon(name))));
    btn.addEventListener("click", () => { grid.hidden = !grid.hidden; });
    return { btn, grid };
  };

  const categoryCard = (c: ECategory, i: number) => {
    const options = h("div", { class: "lset-options" }, c.options.map((o) => {
      const { swatch, pal } = colorPicker(o);
      return h("div", { class: "lset-option" },
        h("div", { class: "lset-option-row" },
          swatch,
          text(() => o.name, (v) => { o.name = v; }, { placeholder: "Option name", "aria-label": "Option name" }),
          text(() => o.description, (v) => { o.description = v; }, { placeholder: "What Jev reads: when this option fits", "aria-label": "Option description", class: "input lset-desc" }),
          text(() => o.group, (v) => { o.group = v; }, { placeholder: "Group", "aria-label": "Group (optional)", class: "input lset-group", title: "Options with the same group are offered together in the filter, like AI (all)" }),
          readOnly ? null : h("button", { class: "linkbtn danger", type: "button", "aria-label": `Remove ${o.name || "option"}`, onclick: () => { c.options = c.options.filter((x) => x !== o); c.index?.keys.delete(o.key); draw(); changed(); } }, "×")),
        pal);
    }));
    const index = c.index;
    return h("section", { class: "lset-card" },
      h("div", { class: "lset-card-head" }, h("b", {}, `Category ${i + 1}`), i === 0 ? h("span", { class: "hint" }, "draws the section brackets") : null, remove("Remove", () => { model.categories = model.categories.filter((x) => x !== c); })),
      h("div", { class: "lset-grid2" },
        field("Name", text(() => c.name, (v) => { c.name = v; }, { placeholder: "Subject" })),
        field("Question", area(() => c.instructions, (v) => { c.instructions = v; }, 1, { placeholder: "What is the current segment mainly about?" }))),
      h("div", { class: "fieldlabel" }, "Options", h("span", { class: "hint" }, "One must be named Other or None: Jev always picks an option, so one has to fit anything else."), options),
      readOnly ? null : h("button", {
        class: "btn sm", type: "button", disabled: c.options.length >= LIMITS.options,
        onclick: () => {
          const used = new Set(c.options.map((o) => o.color));
          c.options.push({ key: nextKey++, name: "", description: "", color: PALETTE.find((p) => !used.has(p)) ?? PALETTE[c.options.length % PALETTE.length], group: "" });
          draw(); changed();
        },
      }, "Add option"),
      check_("Show a share of its time as an index in Insights", () => !!c.index, (v) => {
        c.index = v ? { name: "", description: "", keys: new Set() } : null;
        if (v && model.categories.some((x) => x !== c && x.index)) for (const x of model.categories) if (x !== c) x.index = null; // one index per set
        draw();
      }),
      index ? h("div", { class: "lset-index" },
        h("div", { class: "lset-grid2" },
          field("Index name", text(() => index.name, (v) => { index.name = v; }, { placeholder: "Off-topic" })),
          field("What it measures", text(() => index.description, (v) => { index.description = v; }, { placeholder: "time spent on personal life and other topics" }))),
        h("div", { class: "lset-index-options" }, c.options.map((o) => check_(o.name || "(unnamed)", () => index.keys.has(o.key), (v) => { if (v) index.keys.add(o.key); else index.keys.delete(o.key); })))) : null);
  };

  const scoreCard = (x: EScore, i: number) => h("section", { class: "lset-card" },
    h("div", { class: "lset-card-head" }, h("b", {}, `Score ${i + 1}`), h("span", { class: `lset-slot score-${i + 1}` }), h("span", { class: "hint" }, i === 0 ? "drawn in the heat colour" : "drawn in the hype colour"),
      remove("Remove", () => { model.scores = model.scores.filter((s) => s !== x); })),
    h("div", { class: "lset-grid2" },
      field("Name", text(() => x.name, (v) => { x.name = v; }, { placeholder: "Heat" })),
      field("Question", area(() => x.instructions, (v) => { x.instructions = v; }, 1, { placeholder: "How heated is the exchange in the current segment?" }))),
    h("div", { class: "fieldlabel" }, "The 5 levels, lowest first",
      h("div", { class: "lset-levels" }, x.levels.map((_, k) => text(() => x.levels[k], (v) => { x.levels[k] = v; }, { placeholder: LEVEL_HINTS[k], "aria-label": `Level ${k}` })))));

  const markerCard = (m: EMarker, i: number) => {
    const { btn, grid } = iconPicker(m);
    const value = h("output", { class: "lset-threshold-v" }, m.threshold.toFixed(2));
    const slider = h("input", { type: "range", min: 0.5, max: 0.95, step: 0.05, value: m.threshold, disabled: readOnly, "aria-label": "Threshold" });
    slider.addEventListener("input", () => { m.threshold = Number(slider.value); value.textContent = m.threshold.toFixed(2); changed(); });
    return h("section", { class: "lset-card" },
      h("div", { class: "lset-card-head" }, btn, h("b", {}, `Marker ${i + 1}`), remove("Remove", () => { model.markers = model.markers.filter((x) => x !== m); })),
      grid,
      h("div", { class: "lset-grid3" },
        field("Name", text(() => m.name, (v) => { m.name = v; }, { placeholder: "Hot take" })),
        field("Short name", text(() => m.short, (v) => { m.short = v; }, { placeholder: "For the legend", maxlength: 20 })),
        field("Shows at", h("div", { class: "lset-threshold" }, slider, value), "Jev's yes probability")),
      field("Question", area(() => m.instructions, (v) => { m.instructions = v; }, 1, { placeholder: "A speaker in the current segment states a bold, surprising or contrarian opinion." })),
      h("div", { class: "lset-grid2" },
        field("Counts as yes when (optional)", area(() => m.yes, (v) => { m.yes = v; }, 2, { placeholder: "Concrete: what the segment contains" })),
        field("Counts as no when (optional)", area(() => m.no, (v) => { m.no = v; }, 2, { placeholder: "Concrete: what looks close but is not it" }))),
      h("div", { class: "row" },
        check_("Count it per speaker in Insights", () => m.perSpeaker, (v) => { m.perSpeaker = v; }),
        check_("List it in Insights", () => m.list, (v) => { m.list = v; })));
  };

  const draw = () => {
    const boundary = library?.boundary;
    replace(form,
      readOnly && model.builtIn ? h("p", { class: "lset-note" }, "The built-in set is read-only. Clone it to edit a copy.") : null,
      h("section", { class: "lset-card" },
        h("div", { class: "lset-grid2" },
          field("Name", text(() => model.name, (v) => { model.name = v; }, { placeholder: "Sales calls", maxlength: 80 })),
          field("Description", text(() => model.description, (v) => { model.description = v; }, { placeholder: "What it is for", maxlength: 500 }))),
        h("div", { class: "lset-grid2" },
          field("Prefix, before every question", text(() => model.prefix, (v) => { model.prefix = v; })),
          field("Companies to spot, one per line", area(() => model.companies, (v) => { model.companies = v; }, 2), "Found by code in each segment, whole words")),
        field("Fade choices less sure than", (() => {
          const v = h("output", { class: "lset-threshold-v" }, model.faded.toFixed(2));
          const r = h("input", { type: "range", min: 0, max: 0.9, step: 0.05, value: model.faded, disabled: readOnly, "aria-label": "Fade below" });
          r.addEventListener("input", () => { model.faded = Number(r.value); v.textContent = model.faded.toFixed(2); changed(); });
          return h("div", { class: "lset-threshold" }, r, v);
        })())),
      h("h3", { class: "lset-h" }, "Categories", h("span", { class: "hint" }, "a lane each; Jev picks one option")),
      model.categories.map(categoryCard),
      add("Add category", model.categories.length, LIMITS.categories, () => model.categories.push({
        key: nextKey++, name: "", instructions: "", index: null,
        options: [{ key: nextKey++, name: "", description: "", color: PALETTE[0], group: "" }, { key: nextKey++, name: "Other", description: "Anything else", color: PALETTE[11], group: "" }],
      })),
      h("h3", { class: "lset-h" }, "Scores", h("span", { class: "hint" }, "a line on the chart, 0 to 4")),
      model.scores.map(scoreCard),
      add("Add score", model.scores.length, LIMITS.scores, () => model.scores.push({ key: nextKey++, name: "", instructions: "", levels: ["", "", "", "", ""] })),
      h("h3", { class: "lset-h" }, "Markers", h("span", { class: "hint" }, "a pin on the timeline when Jev says yes")),
      model.markers.map(markerCard),
      add("Add marker", model.markers.length, LIMITS.markers, () => model.markers.push({
        key: nextKey++, name: "", short: "", icon: ICONS.find((n) => !model.markers.some((x) => x.icon === n)) ?? "pin", instructions: "", yes: "", no: "",
        threshold: 0.7, perSpeaker: false, list: false,
      })),
      h("section", { class: "lset-card lset-locked" },
        h("div", { class: "lset-card-head" }, h("b", {}, "Where segments end"), h("span", { class: "badge dropped" }, "Locked")),
        boundary ? h("p", { class: "lset-quote" }, `“${boundary.instructions}”`) : null,
        h("p", { class: "note" }, "Decides where one segment ends and the next begins. It is calibrated (npm run calibrate:boundary), so it is the same for every label set.")),
      h("details", { class: "lset-guide" },
        h("summary", {}, "How to write good labels"),
        h("ul", {},
          h("li", {}, "Ask about the segment only: every question starts with the prefix, and the previous segment is context."),
          h("li", {}, "One narrow judgment per question. Jev answers each on its own and cannot see its other answers."),
          h("li", {}, "Give markers concrete yes and no wording. A question without it scored a verbatim repeat 0.55; with it, about 0.86."),
          h("li", {}, "Make options that do not overlap, and keep an Other or None for everything else."),
          h("li", {}, "Put thresholds away from where answers cluster: an answer that hovers at the threshold shows only some of the time. 0.7 is a good start."),
          h("li", {}, "Try a draft on a recording before a show."))));
  };

  draw();
  if (!readOnly) void check();
  return {
    el, footer,
    model: () => model,
    load: (set: LabelSet) => { const id = model.id; model = toModel(set); model.id = id; model.builtIn = false; readOnly = false; draw(); void check(); },
    check, lastCheck: () => checked,
  };
}

/** `#dlg-labelset`: one set in the editor, with Save (Clone to edit for the built-in set). */
export function openEditor(set: LabelSet, opts: { readOnly: boolean }) {
  const dlg = $<HTMLDialogElement>("#dlg-labelset");
  if (!dlg) return;
  const editor = labelEditor(set, { readOnly: opts.readOnly });
  const save = h("button", { class: "btn primary", type: "button" }, "Save");
  const close = () => dlg.close();
  editor.el.addEventListener("lset-check", (e) => { save.disabled = !(e as CustomEvent<LabelSetCheck>).detail.ok; });
  save.addEventListener("click", async () => {
    const draft = fromModel(editor.model());
    save.disabled = true;
    try {
      const saved = draft.id ? await api.updateLabelSet<LabelSet>(draft.id, draft) : await api.createLabelSet<LabelSet>(draft);
      toast(`Saved ${saved.name}`, "ok");
      close();
      await renderLabelLibrary();
    } catch (e) {
      save.disabled = false;
      toast(e instanceof ApiError ? e.message : String(e));
    }
  });
  const actions = h("div", { class: "row end lset-actions" }, tryButton(editor));
  footerExtras?.(editor, actions);
  if (opts.readOnly && set.builtIn) {
    actions.append(h("button", { class: "btn", type: "button", onclick: close }, "Close"),
      h("button", { class: "btn primary", type: "button", onclick: () => { close(); void cloneAndEdit(set.id); } }, "Clone to edit"));
  } else {
    actions.append(h("button", { class: "btn", type: "button", onclick: close }, "Cancel"), save);
  }
  editor.footer.append(actions);
  replace($("#h-lset-sub"), set.name || "New label set");
  replace($("#labelset-body"), editor.el);
  dlg.showModal();
}

// ---------- Try on a recording ----------

/** The editor's "Try on a recording" button: the draft as it stands, on a recording's first 10 minutes. */
export function tryButton(host: EditorHost & { lastCheck(): LabelSetCheck | null; check(): Promise<LabelSetCheck | null> }): HTMLElement {
  const btn = h("button", {
    class: "btn lset-try", type: "button", title: "See what this draft would draw on the first 10 minutes of a recording, before a show",
    onclick: () => void openTry(host),
  }, "Try on a recording");
  host.el.addEventListener("lset-check", (e) => { btn.disabled = !(e as CustomEvent<LabelSetCheck>).detail.ok; });
  return btn;
}

const recordingLabel = (r: SessionSummary) =>
  `${r.name ?? (r.startedAt ? new Date(r.startedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : r.id)} · ${clock(r.durationMs)}`;

async function openTry(host: EditorHost & { lastCheck(): LabelSetCheck | null; check(): Promise<LabelSetCheck | null> }) {
  const dlg = $<HTMLDialogElement>("#dlg-labeltry");
  const body = $("#labeltry-body");
  if (!dlg || !body) return;
  const draft = fromModel(host.model());
  const checked = host.lastCheck() ?? await host.check();
  if (!checked?.ok) return toast("Fix the draft first: the editor lists what is missing.");
  let recordings: SessionSummary[] = [];
  try {
    recordings = (await api.sessions()).filter((r) => r.segments > 0 || r.utterances > 0);
  } catch (e) {
    return toast(e instanceof Error ? e.message : String(e));
  }
  replace($("#ltry-sub"), draft.name || "This draft");
  // 40 segments at most: about a cent's worth of Jev, usually much less
  const upTo = (checked.perHourUsd / 120) * 40;
  const pick = h("select", { class: "select", "aria-label": "Recording" }, recordings.map((r) => h("option", { value: r.id }, recordingLabel(r))));
  const go = h("button", { class: "btn primary", type: "button", disabled: !recordings.length }, `Try it · about ${money(upTo)} at most`);
  const keyBox = h("div", { hidden: true });
  const result = h("div", { class: "ltry-result" });
  const tryIt = async () => {
    if (!keySet("openrouter")) {
      // the key is asked for here, inside this window: Try calls Jev, through OpenRouter
      keyBox.hidden = false;
      replace(keyBox, keyPrompt("openrouter", "Please provide your OpenRouter API key to try a label set on a recording.", {
        onSaved: () => { keyBox.hidden = true; replace(keyBox); void tryIt(); },
        onCancel: () => { keyBox.hidden = true; replace(keyBox); },
      }));
      return;
    }
    const id = pick.value;
    const rec = recordings.find((r) => r.id === id);
    go.disabled = true;
    replace(result, h("p", { class: "note" }, "Asking Jev about each segment of the first 10 minutes…"));
    try {
      const r = await api.tryLabelSet(draft, id, 10);
      showTry(result, draft, r, rec);
    } catch (e) {
      if (e instanceof ApiError && e.body?.needsKey === "openrouter") { await setupStatus(); go.disabled = false; return void tryIt(); }
      replace(result, h("p", { class: "error-text" }, e instanceof Error ? e.message : String(e)));
    } finally {
      go.disabled = false;
    }
  };
  go.addEventListener("click", () => void tryIt());
  replace(body,
    recordings.length
      ? h("div", { class: "ltry-pick" }, h("label", { class: "fieldlabel" }, "Recording", pick), go)
      : h("p", { class: "empty" }, "No recording to try it on yet: record or import one first."),
    h("p", { class: "note" }, "Jev is asked the draft's questions about each segment that starts in the first 10 minutes (40 at most). Nothing is saved into the recording."),
    keyBox, result);
  dlg.showModal();
}

function showTry(box: HTMLElement, draft: LabelSet, r: LabelTry, rec: SessionSummary | undefined) {
  if (!r.window || !r.segments.length) return replace(box, h("p", { class: "empty" }, "This recording has no segments to label."));
  const byId = (list: any[]) => new Map<string, Labels>(list.map((l) => [l.segmentId, l]));
  const own = r.recording.features.labels && r.recording.set;
  const stretch = `${clock(r.window.startMs)}–${clock(r.window.endMs)}`;
  replace(box,
    h("p", { class: "ltry-meta" }, `${rec ? recordingLabel(rec).split(" · ")[0] : ""} · ${stretch} · ${r.segments.length} segment${r.segments.length === 1 ? "" : "s"} · cost ${money(r.costUsd)}`,
      r.failed ? h("span", { class: "error-text" }, ` · ${r.failed} without an answer`) : null),
    own
      ? h("div", { class: "ltry-block" }, h("h3", {}, `Its own labels · ${r.recording.set.name}`), renderPreview(r.recording.set, r.segments, byId(r.recording.labels), r.window))
      : h("p", { class: "lset-note" }, r.recording.features.factcheck
        ? "This recording ran with labels off, so it has no labels of its own to compare with."
        : "This recording ran with labels off: its segments were cut at pauses, so a live show's segments will differ."),
    h("div", { class: "ltry-block" }, h("h3", {}, `This draft · ${draft.name || "untitled"}`), renderPreview(draft, r.segments, byId(r.labels), r.window)));
}

// ---------- Create with AI ----------

/**
 * A chat with the one assistant model (GPT-6 Luna, fixed in config) on the left, the draft in the editor on the right.
 * A reply that carries a set replaces the draft; the host can edit the draft at any time, and the next message sends it
 * as edited. Nothing is saved until the host presses Save. Each conversation has its own spending cap ($1).
 */
export function openCreateWithAi() {
  const dlg = $<HTMLDialogElement>("#dlg-labels-ai");
  const body = $("#labels-ai-body");
  if (!dlg || !body) return;
  const conversation = `lai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  const editor = labelEditor(blankSet(), { readOnly: false });
  const log = h("div", { class: "lai-log", "aria-live": "polite" },
    h("p", { class: "chat-empty" }, "Describe the show: what it is about, who is on it, and what you want to see on the timeline. For example: “A weekly sales call review: the stage of the call, objections, next steps, and when a competitor comes up.”"));
  const input = h("textarea", { class: "chat-input", rows: 3, placeholder: "Describe your show, or ask for a change…", "aria-label": "Message" });
  const send = h("button", { class: "btn primary", type: "button" }, "Send");
  const spend = h("span", { class: "lai-spend" });
  const keyBox = h("div", { class: "lai-key", hidden: true });
  const chat = h("div", { class: "lai-chat-inner" }, log, h("div", { class: "composer" }, input, h("div", { class: "composer-row" }, spend, send)));
  const bubble = (role: "user" | "assistant", text: string, note?: string, failed = false) => {
    log.querySelector(".chat-empty")?.remove();
    log.append(h("div", { class: `msg ${role}${failed ? " failed" : ""}` },
      h("div", { class: "msg-meta" }, h("span", { class: "who" }, role === "user" ? "You" : "GPT-6 Luna"), note ? h("span", {}, note) : null),
      role === "user" ? h("div", { class: "bubble" }, text) : h("div", { class: "lai-reply" }, text)));
    log.scrollTop = log.scrollHeight;
  };
  const needKey = () => {
    const missing = !keySet("openrouter");
    keyBox.hidden = !missing;
    chat.hidden = missing;
    if (missing) {
      replace(keyBox, keyPrompt("openrouter", "Please provide your OpenRouter API key to create labels with AI.", {
        onSaved: () => { replace(keyBox); needKey(); input.focus(); },
      }));
    }
    return missing;
  };
  const hasLabels = () => { const m = editor.model(); return m.categories.length + m.scores.length + m.markers.length > 0; };
  const submit = async () => {
    const text = input.value.trim();
    if (!text || send.disabled || needKey()) return;
    messages.push({ role: "user", content: text });
    bubble("user", text);
    input.value = "";
    send.disabled = true;
    const typing = h("div", { class: "typing" }, h("i", {}), h("i", {}), h("i", {}), "Drafting…");
    log.append(typing);
    try {
      const r = await api.assistLabels(conversation, messages, hasLabels() ? fromModel(editor.model()) : null);
      messages.push({ role: "assistant", content: r.reply });
      if (r.set) editor.load(r.set);
      bubble("assistant", r.reply || (r.set ? "Here is a draft." : "…"), r.set ? "Draft updated on the right" : r.error ? "No draft this time" : undefined, !!r.error);
      if (r.error) bubble("assistant", r.error, undefined, true);
      replace(spend, `Spent ${money(r.spentUsd)} of ${money(r.capUsd)}`);
    } catch (e) {
      messages.pop();
      if (e instanceof ApiError && e.body?.needsKey === "openrouter") { await setupStatus(); input.value = text; log.lastElementChild?.remove(); typing.remove(); needKey(); return; }
      bubble("assistant", e instanceof Error ? e.message : String(e), undefined, true);
    } finally {
      typing.remove();
      send.disabled = false;
    }
  };
  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } });

  const save = h("button", { class: "btn primary", type: "button", disabled: true }, "Save");
  editor.el.addEventListener("lset-check", (e) => { save.disabled = !(e as CustomEvent<LabelSetCheck>).detail.ok; });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const saved = await api.createLabelSet<LabelSet>(fromModel(editor.model()));
      toast(`Saved ${saved.name}: pick it in Start live`, "ok");
      dlg.close();
      await renderLabelLibrary();
    } catch (e) {
      save.disabled = false;
      toast(e instanceof Error ? e.message : String(e));
    }
  });
  editor.footer.append(h("div", { class: "row end lset-actions" }, tryButton(editor), h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "Cancel"), save));
  replace(body, h("div", { class: "lai-chat" }, keyBox, chat), h("div", { class: "lai-draft" }, editor.el));
  needKey();
  dlg.showModal();
  input.focus();
}
