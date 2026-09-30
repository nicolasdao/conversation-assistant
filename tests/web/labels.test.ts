// @vitest-environment happy-dom
// The label-set windows (web/src/labels.ts): the library (cog → Labels), the editor (#dlg-labelset), Try on a recording
// (#dlg-labeltry), and Create with AI (#dlg-labels-ai). docs/architecture.md § Web front end (Labels) and docs/jev.md
// § label sets. The API is a fake; keys.ts is real and reads the key state through it.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AssistTurn, LabelSetCheck, LabelSetEntry, LabelTry, SessionSummary } from "../../web/src/api.ts";
import type { LabelSet } from "../../web/src/state.ts";
import { installBrowserStubs, loadIndexHtml, makeFakeApi } from "./helpers.ts";
import { aiSet, labels, tinySet } from "./helpers-panels.ts";

const fake = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<object>()), api: fake }));
vi.mock("../../web/src/transfer.ts", () => ({ openExport: vi.fn(), openImport: vi.fn() }));

type Labels = typeof import("../../web/src/labels.ts");
type ApiMod = typeof import("../../web/src/api.ts");
let L: Labels;
let A: ApiMod;
/** assistLabels' arguments as they were when sent (the page keeps pushing to the same messages array). */
let sent: any[][] = [];
const assistAnswers = (...answers: (AssistTurn | Error | "hang")[]) => {
  let i = 0;
  fake.assistLabels!.mockImplementation((...args: unknown[]) => {
    sent.push(structuredClone(args));
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return a === "hang" ? new Promise(() => {}) : a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  });
};

// ---------- builders ----------

function check(over: Partial<LabelSetCheck> = {}): LabelSetCheck {
  return { ok: true, errors: [], tokens: 2369, perHourUsd: 0.012, overLimit: false, ...over };
}

function entry(id: string, over: Partial<LabelSetEntry> = {}): LabelSetEntry {
  return { id, name: id, description: "", builtIn: false, counts: { categories: 1, scores: 1, markers: 1 }, ...over };
}

const builtInEntry = () => entry("ai-podcast", {
  name: "AI podcast", builtIn: true, description: "The built-in set", perHourUsd: 0.012, counts: { categories: 2, scores: 2, markers: 6 },
});

function setup(openrouter: boolean) {
  return {
    configured: true, required: [], path: "/tmp/credentials.json",
    keys: [
      { name: "openai", env: "OPENAI_API_KEY", set: false, source: null, hint: null },
      { name: "openrouter", env: "OPENROUTER_API_KEY", set: openrouter, source: openrouter ? "file" : null, hint: openrouter ? "abcd" : null },
    ],
  };
}

function rec(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, name: null, notes: null, mode: "live", startedAt: null, durationMs: 65_000, ended: true,
    utterances: 12, speakers: ["Ann"], segments: 3, claims: 0, costUsd: 0.5, ...over,
  };
}

function turn(over: Partial<AssistTurn> = {}): AssistTurn {
  return {
    reply: "Got it.", question: "What should the categories be?", choices: ["Topics", "Moods"], set: null, skipped: [],
    checklist: { items: [
      { id: "conversation", label: "What the conversation is", status: "done" },
      { id: "categories", label: "Categories", status: "todo", detail: "at least one" },
      { id: "categories.0.fallback", label: "A fallback option", status: "done" },
      { id: "markers", label: "Markers", status: "recommended" },
      { id: "scores", label: "Scores", status: "skipped" },
    ], complete: false, errors: [] },
    costUsd: 0.004, spentUsd: 0.004, ...over,
  };
}

function tryResult(over: Partial<LabelTry> = {}): LabelTry {
  return {
    segments: [{ id: "g1", startMs: 0, endMs: 30_000 }, { id: "g2", startMs: 30_000, endMs: 60_000 }],
    labels: [labels("g1", { choices: { topic: ["alpha", 0.9] } }), labels("g2", { choices: { topic: ["beta", 0.4, true] } })],
    recording: { features: { factcheck: true, labels: true }, set: aiSet(), labels: [labels("g1", { choices: { subject: ["tech", 0.8] } })] },
    costUsd: 0.002, failed: 0, window: { startMs: 0, endMs: 600_000 }, ...over,
  };
}

// ---------- page helpers ----------

/** Lets pending promises run (timers are fake here; nothing waits on a timer but the 500 ms check, and toasts). */
const flush = async () => {
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
};
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const buttonNamed = (text: string, root: ParentNode = document) =>
  $$<HTMLButtonElement>("button", root).find((b) => b.textContent === text)!;
const buttonStarting = (text: string, root: ParentNode = document) =>
  $$<HTMLButtonElement>("button", root).find((b) => b.textContent?.startsWith(text))!;
const toasts = () => $$("#toasts .toast").map((t) => `${t.classList.contains("ok") ? "ok" : "error"}: ${t.textContent}`);
const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => { el.value = v; el.dispatchEvent(new Event("input")); };
const tick = (box: HTMLInputElement, on: boolean) => { box.checked = on; box.dispatchEvent(new Event("change")); };
const dlg = (id: string) => document.getElementById(id) as HTMLDialogElement;
/** Answers the in-page ask dialog. */
const answer = (value: string | null, text?: string) => {
  if (text !== undefined) ($("#ask-input") as HTMLInputElement).value = text;
  dlg("dlg-ask").close(value ?? undefined);
};
async function keysKnown(openrouter: boolean) {
  fake.setup!.mockResolvedValue(setup(openrouter));
  await (await import("../../web/src/keys.ts")).setupStatus();
}

beforeEach(async () => {
  vi.resetModules();
  loadIndexHtml();
  installBrowserStubs();
  // Timers are fake in every test and cleared after it, so an editor's debounced check (500 ms) left pending by one
  // test never calls the next test's fake.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Object.assign(fake, makeFakeApi((await vi.importActual<ApiMod>("../../web/src/api.ts")).api, { checkLabelSet: async () => check() }));
  // ApiError from the mocked module: the class labels.ts checks with instanceof
  A = await import("../../web/src/api.ts");
  sent = [];
  L = await import("../../web/src/labels.ts");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------- pure parts ----------

describe("toId", () => {
  test("snake_case from a name; a name starting with a digit gets n_; an empty one the fallback", () => {
    expect(L.toId("Hot take")).toBe("hot_take");
    expect(L.toId("Clip-worthy")).toBe("clip_worthy");
    expect(L.toId("  AI  / Models! ")).toBe("ai_models");
    expect(L.toId("2nd opinion")).toBe("n_2nd_opinion");
    expect(L.toId("!!!")).toBe("label");
    expect(L.toId("", "option")).toBe("option");
  });

  // The NFKD normalization splits "é" into "e" + a combining accent, and the accent then becomes an underscore.
  test.fails("BUG LBW-L1: accented letters lose their accent instead of splitting the id (Résumé → resume)", () => {
    expect(L.toId("Résumé")).toBe("resume");
  });
});

describe("blankSet, toModel, fromModel", () => {
  test("a blank set has the default prefix, fade 0.5, and nothing else", () => {
    expect(L.blankSet()).toEqual({
      format: "tattle-labels", version: 1, id: "", name: "", description: "", prefix: "Judge only segment; previous_segment is context only.",
      fadedBelowConfidence: 0.5, companies: [], categories: [], scores: [], markers: [],
    });
  });

  test("the built-in set survives a trip through the editor's model (ids come back from the names)", () => {
    const set = aiSet();
    const m = L.toModel(set);
    expect([m.id, m.builtIn, m.companies.split("\n").length]).toEqual(["ai-podcast", true, set.companies.length]);
    const { builtIn: _b, ...rest } = set;
    expect(L.fromModel(m)).toEqual(rest);
  });

  test("fromModel trims text, splits companies, keeps criteria only when both are written, and fills a short name", () => {
    const m = L.toModel(tinySet());
    m.id = null;
    m.name = "  Tiny  ";
    m.companies = " Acme \n\n Globex ";
    m.categories[0]!.options[0]!.group = "  G ";
    m.categories[0]!.index = { name: " Idx ", description: " d ", keys: new Set([m.categories[0]!.options[1]!.key]) };
    m.markers[0]!.short = "  ";
    m.markers[0]!.name = "A very long marker name indeed";
    m.markers[0]!.yes = "yes words";
    const one = L.fromModel(m);
    expect([one.id, one.name, one.companies]).toEqual(["", "Tiny", ["Acme", "Globex"]]);
    expect(one.categories[0]!.options.map((o) => o.group)).toEqual(["G", undefined, undefined]);
    expect(one.categories[0]!.index).toEqual({ name: "Idx", description: "d", options: ["beta"] });
    expect(one.markers[0]).toMatchObject({ id: "a_very_long_marker_name_indeed", short: "A very long marker n" });
    expect(one.markers[0]!.criteria).toBeUndefined();
    m.markers[0]!.no = "no words";
    expect(L.fromModel(m).markers[0]!.criteria).toEqual({ true: "yes words", false: "no words" });
  });

  test("a category without an index has no index key", () => {
    expect("index" in L.fromModel(L.toModel(tinySet())).categories[0]!).toBe(false);
  });
});

// ---------- the library ----------

describe("loadLabelSets and the menu summary", () => {
  test("counts the sets in #m-labels, keeps the list for Start live, and says 'Label sets' before any answer", async () => {
    expect(L.labelSetsKnown()).toEqual([]);
    fake.labelSets!.mockRejectedValueOnce(new Error("404"));
    expect(await L.loadLabelSets()).toBeNull();
    expect($("#m-labels").textContent).toBe("Label sets");
    fake.labelSets!.mockResolvedValueOnce({ sets: [builtInEntry()] });
    await L.loadLabelSets();
    expect($("#m-labels").textContent).toBe("1 set");
    fake.labelSets!.mockResolvedValueOnce({ sets: [builtInEntry(), entry("mine")] });
    await L.loadLabelSets();
    expect($("#m-labels").textContent).toBe("2 sets");
    expect(L.labelSetsKnown().map((s) => s.id)).toEqual(["ai-podcast", "mine"]);
    // a later failure keeps the last answer
    fake.labelSets!.mockRejectedValueOnce(new Error("down"));
    expect((await L.loadLabelSets())?.sets.length).toBe(2);
  });
});

describe("renderLabelLibrary", () => {
  const library = () => ({
    sets: [
      builtInEntry(),
      entry("mine", { name: "Sales calls", description: "", perHourUsd: 0.25, counts: { categories: 1, scores: 0, markers: 2 } }),
      entry("bad", { name: "bad.tattle-labels", broken: "not valid JSON" }),
    ],
    boundary: { instructions: "Does the current segment end here?" },
  });
  const row = (i: number) => $$(".lset-list .lset")[i]!;

  test("without #labels it does nothing", async () => {
    $("#labels").remove();
    await L.renderLabelLibrary();
    expect(fake.labelSets).not.toHaveBeenCalled();
  });

  test("the tools (New, Import, Create with AI), the list, and the note; a later render keeps the tools", async () => {
    fake.labelSets!.mockResolvedValue(library());
    await L.renderLabelLibrary();
    const tools = $(".lset-tools");
    expect($$("button", tools).map((b) => b.textContent)).toEqual(["New", "Import", "Create with AI"]);
    expect($<HTMLInputElement>('input[type="file"]', tools).accept).toBe(".tattle-labels,.json");
    expect($("#labels .note").textContent).toMatch(/^A label set is what the timeline asks Jev/);
    await L.renderLabelLibrary();
    expect($(".lset-tools")).toBe(tools);
  });

  test("the built-in set: its name, a Built-in badge, Clone and Export, no delete; meta with description, counts, and cost", async () => {
    fake.labelSets!.mockResolvedValue(library());
    await L.renderLabelLibrary();
    const r = row(0);
    expect($(".rec-title", r).tagName).toBe("SPAN");
    expect($(".badge", r).textContent).toBe("Built-in");
    expect($$("button", r).map((b) => b.textContent)).toEqual(["Clone", "Export"]);
    expect(r.title).toMatch(/built-in set is read-only/);
    expect($(".meta", r).textContent).toBe("The built-in set · 2 categories · 2 scores · 6 markers · about $0.01 an hour of Jev");
  });

  test("a set of your own: a name to click to rename, Edit, Export, and Delete; singular counts; no description", async () => {
    fake.labelSets!.mockResolvedValue(library());
    await L.renderLabelLibrary();
    const r = row(1);
    expect($(".rec-title", r).tagName).toBe("BUTTON");
    expect($$("button", r).map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Sales calls", "Edit", "Export", "Delete Sales calls"]);
    expect($(".meta", r).textContent).toBe("1 category · 0 scores · 2 markers · about $0.25 an hour of Jev");
    expect(r.title).toBe("Open it to edit");
  });

  test("a broken file: listed with its reason, a Broken badge, Edit and Export off, and a click opens nothing", async () => {
    fake.labelSets!.mockResolvedValue(library());
    await L.renderLabelLibrary();
    const r = row(2);
    expect(r.classList.contains("broken")).toBe(true);
    expect($(".badge.inc", r).title).toBe("not valid JSON");
    expect($(".meta", r).textContent).toBe("Cannot be used: not valid JSON");
    expect([buttonNamed("Edit", r).disabled, buttonStarting("Export", r).disabled]).toEqual([true, true]);
    r.click();
    r.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(fake.labelSet).not.toHaveBeenCalled();
  });

  test("the library cannot be read: an error in the list", async () => {
    fake.labelSets!.mockRejectedValue(new Error("down"));
    await L.renderLabelLibrary();
    expect($(".lset-list .error-text").textContent).toMatch(/^The label sets could not be read/);
  });

  test("clicking a row, Edit, or Enter on the row opens that set in the editor; Enter on a button inside does not", async () => {
    fake.labelSets!.mockResolvedValue(library());
    fake.labelSet!.mockResolvedValue({ ...tinySet(), id: "mine", name: "Sales calls" });
    await L.renderLabelLibrary();
    row(1).click();
    await flush();
    expect(fake.labelSet).toHaveBeenCalledWith("mine");
    expect(dlg("dlg-labelset").open).toBe(true);
    expect($("#h-lset-sub").textContent).toBe("Sales calls");
    dlg("dlg-labelset").close();
    buttonNamed("Edit", row(1)).click();
    await flush();
    row(1).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(fake.labelSet).toHaveBeenCalledTimes(3);
    const ev = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    buttonNamed("Edit", row(1)).dispatchEvent(ev);
    row(1).dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await flush();
    expect(fake.labelSet).toHaveBeenCalledTimes(3);
  });

  test("a set that cannot be opened: a toast with the reason", async () => {
    fake.labelSet!.mockRejectedValue(new Error("no such set"));
    await L.openLabelSet("gone");
    expect(toasts()).toEqual(["error: no such set"]);
    expect(dlg("dlg-labelset").open).toBe(false);
  });

  test("Clone copies the built-in set, refreshes the list, says so, and opens the copy to edit", async () => {
    fake.labelSets!.mockResolvedValue(library());
    fake.cloneLabelSet!.mockResolvedValue({ ...aiSet(), id: "ai-podcast-copy", name: "AI podcast (copy)", builtIn: false });
    fake.labelSet!.mockResolvedValue({ ...aiSet(), id: "ai-podcast-copy", name: "AI podcast (copy)", builtIn: false });
    await L.renderLabelLibrary();
    buttonNamed("Clone", row(0)).click();
    await flush();
    expect(fake.cloneLabelSet).toHaveBeenCalledWith("ai-podcast");
    expect(fake.labelSets).toHaveBeenCalledTimes(2);
    expect(toasts()).toEqual(["ok: Cloned as AI podcast (copy): edit it here"]);
    expect(fake.labelSet).toHaveBeenCalledWith("ai-podcast-copy");
    expect($("#h-lset-sub").textContent).toBe("AI podcast (copy)");
    expect($<HTMLInputElement>("#labelset-body input").disabled).toBe(false);
  });

  test("a failed clone says why", async () => {
    fake.labelSets!.mockResolvedValue(library());
    fake.cloneLabelSet!.mockRejectedValue(new A.ApiError(500, "disk full"));
    await L.renderLabelLibrary();
    buttonNamed("Clone", row(0)).click();
    await flush();
    expect(toasts()).toEqual(["error: disk full"]);
  });

  test("Export downloads the set's file without opening it", async () => {
    fake.labelSets!.mockResolvedValue(library());
    await L.renderLabelLibrary();
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(`${this.getAttribute("href")}|${this.hasAttribute("download")}|${this.isConnected}`); });
    buttonStarting("Export", row(1)).click();
    expect(clicks).toEqual(["/api/label-sets/mine/export|true|true"]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(fake.labelSet).not.toHaveBeenCalled();
  });

  test("Rename asks for the new name, saves the set with it, refreshes, and says so; cancel, blank, or the same name do nothing", async () => {
    fake.labelSets!.mockResolvedValue(library());
    fake.labelSet!.mockResolvedValue({ ...tinySet(), id: "mine", name: "Sales calls" });
    await L.renderLabelLibrary();
    const title = () => $<HTMLButtonElement>(".rec-title", row(1));
    title().click();
    expect([dlg("dlg-ask").open, $("#h-ask").textContent, $<HTMLInputElement>("#ask-input").value, $("#ask-ok").textContent]).toEqual([true, "Rename the label set", "Sales calls", "Rename"]);
    answer("ok", "  Discovery calls ");
    await flush();
    expect(fake.updateLabelSet).toHaveBeenCalledWith("mine", expect.objectContaining({ id: "mine", name: "Discovery calls" }));
    expect(toasts()).toEqual(["ok: Renamed to Discovery calls"]);
    expect(fake.labelSet).toHaveBeenCalledWith("mine");
    expect(dlg("dlg-labelset").open).toBe(false); // renaming does not open the editor
    for (const [v, text] of [[null, "x"], ["ok", "   "], ["ok", "Sales calls"]] as const) {
      title().click();
      answer(v, text);
      await flush();
    }
    expect(fake.updateLabelSet).toHaveBeenCalledOnce();
  });

  test("a failed rename says why", async () => {
    fake.labelSets!.mockResolvedValue(library());
    fake.labelSet!.mockResolvedValue({ ...tinySet(), id: "mine" });
    fake.updateLabelSet!.mockRejectedValue(new Error("name taken"));
    await L.renderLabelLibrary();
    $<HTMLButtonElement>(".rec-title", row(1)).click();
    answer("ok", "Other");
    await flush();
    expect(toasts()).toEqual(["error: name taken"]);
  });

  test("Delete asks with a danger button; confirming deletes, refreshes, and says so; cancelling does nothing", async () => {
    fake.labelSets!.mockResolvedValue(library());
    await L.renderLabelLibrary();
    $<HTMLButtonElement>(".rec-delete", row(1)).click();
    expect([$("#h-ask").textContent, $("#ask-ok").className, $("#ask-ok").textContent]).toEqual(["Delete “Sales calls”?", "btn danger", "Delete"]);
    expect($("#ask-message").textContent).toMatch(/keep their own copy/);
    answer(null);
    await flush();
    expect(fake.deleteLabelSet).not.toHaveBeenCalled();
    $<HTMLButtonElement>(".rec-delete", row(1)).click();
    answer("ok");
    await flush();
    expect(fake.deleteLabelSet).toHaveBeenCalledWith("mine");
    expect(fake.labelSets).toHaveBeenCalledTimes(2);
    expect(toasts()).toEqual(["ok: Deleted Sales calls"]);
  });

  test("New opens the editor on an empty set; Create with AI opens its window", async () => {
    fake.labelSets!.mockResolvedValue(library());
    await L.renderLabelLibrary();
    buttonNamed("New").click();
    expect(dlg("dlg-labelset").open).toBe(true);
    expect($("#h-lset-sub").textContent).toBe("New label set");
    expect($<HTMLInputElement>("#labelset-body input").value).toBe("");
    dlg("dlg-labelset").close();
    buttonNamed("Create with AI").click();
    expect(dlg("dlg-labels-ai").open).toBe(true);
  });
});

describe("importing a .tattle-labels file", () => {
  const file = (text: string, name = "set.tattle-labels") => new File([text], name, { type: "application/json" });

  test("Import opens the file picker; a chosen file is imported, the list refreshed, and a toast says so", async () => {
    fake.labelSets!.mockResolvedValue({ sets: [] });
    fake.importLabelSet!.mockResolvedValue({ ...tinySet(), name: "Shared set" });
    await L.renderLabelLibrary();
    const picker = $<HTMLInputElement>('.lset-tools input[type="file"]');
    const clicked = vi.spyOn(picker, "click").mockImplementation(() => {});
    buttonNamed("Import", $(".lset-tools")).click();
    expect(clicked).toHaveBeenCalledOnce();
    Object.defineProperty(picker, "files", { value: [file(JSON.stringify(tinySet()))], configurable: true });
    picker.dispatchEvent(new Event("change"));
    await flush();
    expect(fake.importLabelSet).toHaveBeenCalledWith(tinySet());
    expect(toasts()).toEqual(["ok: Imported the label set Shared set"]);
    expect(fake.labelSets).toHaveBeenCalledTimes(2);
  });

  test("the picker with no file does nothing", async () => {
    fake.labelSets!.mockResolvedValue({ sets: [] });
    await L.renderLabelLibrary();
    const picker = $<HTMLInputElement>('.lset-tools input[type="file"]');
    Object.defineProperty(picker, "files", { value: [], configurable: true });
    picker.dispatchEvent(new Event("change"));
    await flush();
    expect(fake.importLabelSet).not.toHaveBeenCalled();
  });

  test("a file that is not JSON is refused before any request", async () => {
    await L.importLabelFile(file("not json {"));
    expect(fake.importLabelSet).not.toHaveBeenCalled();
    expect(toasts()).toEqual(["error: That file is not a label set: it should be a .tattle-labels file."]);
  });

  test("a set the engine refuses: its reason as a toast", async () => {
    fake.importLabelSet!.mockRejectedValue(new A.ApiError(400, "categories: at most 2"));
    await L.importLabelFile(file("{}"));
    expect(toasts()).toEqual(["error: categories: at most 2"]);
  });
});

// ---------- the editor ----------

describe("the editor: fields and the live check", () => {
  const open = async (set: LabelSet = { ...tinySet(), id: "tiny" }, readOnly = false) => {
    L.openEditor(set, { readOnly });
    await flush();
  };
  const form = () => $("#labelset-body .lset-form");
  const save = () => buttonNamed("Save", $("#labelset-body"));

  test("without #dlg-labelset nothing opens", () => {
    dlg("dlg-labelset").remove();
    L.openEditor(tinySet(), { readOnly: false });
    expect(fake.checkLabelSet).not.toHaveBeenCalled();
  });

  test("opening checks the draft at once and shows the cost line; Save follows the check", async () => {
    await open();
    expect(fake.checkLabelSet).toHaveBeenCalledWith(L.fromModel(L.toModel({ ...tinySet(), id: "tiny" })));
    expect($(".lset-status").textContent).toBe(`About $0.01 per hour · ${(2369).toLocaleString()} tokens per call of 32,000`);
    expect(save().disabled).toBe(false);
    expect($(".lset-cost").classList.contains("over")).toBe(false);
  });

  test("errors are listed (8 at most, then 'and N more'), too long a set says so, and Save waits", async () => {
    fake.checkLabelSet!.mockResolvedValue(check({ ok: false, overLimit: true, errors: Array.from({ length: 10 }, (_, i) => `error ${i}`) }));
    await open();
    expect($$(".lset-errors li").map((li) => li.textContent)).toEqual([...Array.from({ length: 8 }, (_, i) => `error ${i}`), "and 2 more"]);
    expect($(".lset-cost").classList.contains("over")).toBe(true);
    expect($(".lset-cost").textContent).toMatch(/ · too long: Jev refuses calls over its limit$/);
    expect(save().disabled).toBe(true);
  });

  test("a check that fails shows its message", async () => {
    fake.checkLabelSet!.mockRejectedValue(new Error("engine gone"));
    await open();
    expect($(".lset-status .error-text").textContent).toBe("engine gone");
  });

  test("an older check answering last is ignored", async () => {
    const slow: ((c: LabelSetCheck) => void)[] = [];
    fake.checkLabelSet!.mockImplementation(() => new Promise((r) => slow.push(r)));
    const host = L.labelEditor(tinySet(), { readOnly: false });
    const second = host.check();
    slow[1]!(check({ perHourUsd: 0.5 }));
    await second;
    slow[0]!(check({ perHourUsd: 0.1 }));
    await flush();
    expect(host.lastCheck()?.perHourUsd).toBe(0.5);
  });

  test("typing checks again 500 ms after the last change, and calls onChange for each", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onChange = vi.fn();
    const host = L.labelEditor(tinySet(), { readOnly: false, onChange });
    document.body.append(host.el);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.checkLabelSet).toHaveBeenCalledTimes(1);
    const name = $<HTMLInputElement>('input[placeholder="Sales calls"]', host.el);
    type(name, "A");
    await vi.advanceTimersByTimeAsync(300);
    type(name, "AB");
    await vi.advanceTimersByTimeAsync(499);
    expect(fake.checkLabelSet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.checkLabelSet).toHaveBeenCalledTimes(2);
    expect(fake.checkLabelSet!.mock.calls[1]![0].name).toBe("AB");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("the set's own fields change the draft: name, description, prefix, companies, and the fade slider", async () => {
    await open();
    const f = form();
    type($<HTMLInputElement>('input[placeholder="Sales calls"]', f), "Calls");
    type($<HTMLInputElement>('input[placeholder="What it is for"]', f), "For calls");
    const prefix = $$<HTMLInputElement>(".lset-card:first-child input.input", f)[2]!;
    type(prefix, "Judge the segment.");
    type($<HTMLTextAreaElement>("textarea", f), "Acme\nGlobex");
    const fade = $<HTMLInputElement>('input[aria-label="Fade below"]', f);
    type(fade, "0.65");
    expect(fade.nextElementSibling!.textContent).toBe("0.65");
    buttonNamed("Save", $("#labelset-body")).click();
    await flush();
    expect(fake.updateLabelSet).toHaveBeenCalledWith("tiny", expect.objectContaining({
      name: "Calls", description: "For calls", prefix: "Judge the segment.", companies: ["Acme", "Globex"], fadedBelowConfidence: 0.65,
    }));
  });

  test("categories: added with a blank option and Other, up to 2 ('n of 2'); removed; the first draws the section brackets", async () => {
    await open(L.blankSet());
    const add = () => buttonStarting("Add category", form());
    expect(add().textContent).toBe("Add category (0 of 2)");
    add().click();
    expect(add().textContent).toBe("Add category (1 of 2)");
    const card = $$(".lset-card", form()).find((c) => c.textContent?.startsWith("Category 1"))!;
    expect($(".hint", card).textContent).toBe("draws the section brackets");
    expect($$<HTMLInputElement>('input[aria-label="Option name"]', card).map((i) => i.value)).toEqual(["", "Other"]);
    add().click();
    expect([add().disabled, add().textContent]).toEqual([true, "Add category (2 of 2)"]);
    const second = $$(".lset-card", form()).find((c) => c.textContent?.startsWith("Category 2"))!;
    buttonNamed("Remove", second).click();
    expect(add().textContent).toBe("Add category (1 of 2)");
  });

  test("options: name, description, and group change the draft; Add option takes an unused colour; × removes one", async () => {
    await open();
    const card = () => $$(".lset-card", form()).find((c) => c.textContent?.startsWith("Category 1"))!;
    type($$<HTMLInputElement>('input[aria-label="Option name"]', card())[0]!, "Apples");
    type($$<HTMLInputElement>('input[aria-label="Option description"]', card())[0]!, "about apples");
    type($$<HTMLInputElement>('input[aria-label="Group (optional)"]', card())[0]!, "Fruit");
    buttonNamed("Add option", card()).click();
    const swatches = $$<HTMLButtonElement>(".lset-option-row > .lset-swatch", card());
    expect(swatches.length).toBe(4);
    expect(swatches[3]!.getAttribute("aria-label")).toBe(`Colour ${L.PALETTE[0]}`);
    buttonNamed("×", $$(".lset-option", card())[1]!).click();
    buttonNamed("Save", $("#labelset-body")).click();
    await flush();
    const saved = fake.updateLabelSet!.mock.calls[0]![1] as LabelSet;
    expect(saved.categories[0]!.options.map((o) => [o.id, o.description, o.group, o.color])).toEqual([
      ["apples", "about apples", "Fruit", "#111111"], ["none", "none", undefined, "#333333"], ["option", "", undefined, L.PALETTE[0]],
    ]);
  });

  test("colours: the swatch opens the palette in place; a palette colour or a valid hex sets it; an invalid hex is kept for the check to refuse", async () => {
    await open();
    const opt = () => $$(".lset-option", form())[0]!;
    const swatch = $<HTMLButtonElement>(".lset-option-row > .lset-swatch", opt());
    const pal = $<HTMLElement>(".lset-palette", opt());
    expect(pal.hidden).toBe(true);
    swatch.click();
    expect(pal.hidden).toBe(false);
    expect($$(".lset-swatch", pal).length).toBe(12);
    $<HTMLButtonElement>(`.lset-palette .lset-swatch[aria-label="${L.PALETTE[5]}"]`, opt()).click();
    expect([pal.hidden, $<HTMLInputElement>(".lset-hex", opt()).value]).toEqual([true, L.PALETTE[5]]);
    const hex = $<HTMLInputElement>(".lset-hex", opt());
    type(hex, "#abcdef");
    expect(swatch.style.background).toMatch(/#abcdef|rgb\(171, 205, 239\)/);
    type(hex, "#zz");
    buttonNamed("Save", $("#labelset-body")).click();
    await flush();
    expect((fake.updateLabelSet!.mock.calls[0]![1] as LabelSet).categories[0]!.options[0]!.color).toBe("#zz");
  });

  test("the index: a checkbox adds its name, description, and options to count; one category at a time has one", async () => {
    await open({ ...tinySet(), id: "tiny", categories: [...tinySet().categories, { ...tinySet().categories[0]!, id: "mood", name: "Mood" }] });
    const card = (n: number) => $$(".lset-card", form()).find((c) => c.textContent?.startsWith(`Category ${n}`))!;
    const indexBox = (n: number) => $$<HTMLInputElement>(".lset-check input", card(n))[0]!;
    tick(indexBox(1), true);
    const idx = $(".lset-index", card(1));
    type($<HTMLInputElement>('input[placeholder="Off-topic"]', idx), "Off");
    type($<HTMLInputElement>('input[placeholder^="time spent"]', idx), "time off");
    const optionBoxes = $$<HTMLInputElement>(".lset-index-options input", card(1));
    expect($$(".lset-index-options label", card(1)).map((l) => l.textContent)).toEqual(["Alpha", "Beta", "None"]);
    tick(optionBoxes[0]!, true);
    tick(optionBoxes[2]!, true);
    tick(optionBoxes[2]!, false);
    buttonNamed("Save", $("#labelset-body")).click();
    await flush();
    expect((fake.updateLabelSet!.mock.calls[0]![1] as LabelSet).categories[0]!.index).toEqual({ name: "Off", description: "time off", options: ["alpha"] });
    tick(indexBox(2), true);
    expect([card(1).querySelector(".lset-index"), card(2).querySelector(".lset-index") !== null]).toEqual([null, true]);
    tick(indexBox(2), false);
    expect(card(2).querySelector(".lset-index")).toBeNull();
  });

  test("removing an option also removes it from the index", async () => {
    const set = tinySet();
    set.categories[0]!.index = { name: "I", description: "d", options: ["b"] };
    await open({ ...set, id: "tiny" });
    const card = $$(".lset-card", form()).find((c) => c.textContent?.startsWith("Category 1"))!;
    buttonNamed("×", $$(".lset-option", card)[1]!).click();
    buttonNamed("Save", $("#labelset-body")).click();
    await flush();
    expect((fake.updateLabelSet!.mock.calls[0]![1] as LabelSet).categories[0]!.index!.options).toEqual([]);
  });

  test("scores: 5 levels, lowest first; the first in the heat colour, the second in hype; up to 2", async () => {
    await open(L.blankSet());
    const add = () => buttonStarting("Add score", form());
    add().click();
    add().click();
    expect([add().disabled, add().textContent]).toEqual([true, "Add score (2 of 2)"]);
    const cards = $$(".lset-card", form()).filter((c) => c.textContent?.startsWith("Score"));
    expect(cards.map((c) => $(".hint", c).textContent)).toEqual(["drawn in the heat colour", "drawn in the hype colour"]);
    expect($$<HTMLInputElement>(".lset-levels input", cards[0]!).map((i) => i.placeholder)).toEqual(["Lowest (0)", "1", "2", "3", "Highest (4)"]);
    type($<HTMLInputElement>('input[placeholder="Heat"]', cards[0]!), "Energy");
    type($<HTMLTextAreaElement>("textarea", cards[0]!), "How lively?");
    $$<HTMLInputElement>(".lset-levels input", cards[0]!).forEach((i, k) => type(i, ` L${k} `));
    buttonNamed("Remove", cards[1]!).click();
    expect(add().textContent).toBe("Add score (1 of 2)");
    buttonNamed("Save", $("#labelset-body")).click();
    await flush();
    expect((fake.createLabelSet!.mock.calls[0]![0] as LabelSet).scores).toEqual([
      { id: "energy", name: "Energy", instructions: "How lively?", levels: ["L0", "L1", "L2", "L3", "L4"] },
    ]);
  });

  test("markers: each new one takes an unused icon, at 0.70; up to 8; the icon grid, threshold, wording, and Insights boxes change it", async () => {
    await open(L.blankSet());
    const add = () => buttonStarting("Add marker", form());
    for (let i = 0; i < 8; i++) add().click();
    expect([add().disabled, add().textContent]).toEqual([true, "Add marker (8 of 8)"]);
    const cards = () => $$(".lset-card", form()).filter((c) => c.textContent?.startsWith("Marker") || $(".lset-icon", c));
    expect(cards().map((c) => $<HTMLButtonElement>(".lset-icon", c).getAttribute("aria-label"))).toEqual(
      ["bolt", "smile", "flame", "trend", "star", "scissors", "question", "lightbulb"].map((n) => `Icon: ${n}`));
    for (let i = 7; i > 0; i--) buttonNamed("Remove", cards()[i]!).click();
    const c = cards()[0]!;
    const grid = $<HTMLElement>(".lset-icons", c);
    expect([grid.hidden, $$(".lset-icon-choice", grid).length]).toEqual([true, 30]);
    expect($(".lset-icon-choice.on", grid).getAttribute("aria-label")).toBe("bolt");
    $<HTMLButtonElement>(".lset-icon", c).click();
    expect(grid.hidden).toBe(false);
    $<HTMLButtonElement>('.lset-icon-choice[aria-label="heart"]', grid).click();
    const m = cards()[0]!;
    expect($<HTMLButtonElement>(".lset-icon", m).getAttribute("aria-label")).toBe("Icon: heart");
    type($<HTMLInputElement>('input[placeholder="Hot take"]', m), "Big claim");
    type($<HTMLInputElement>('input[placeholder="For the legend"]', m), "Claim");
    const slider = $<HTMLInputElement>('input[aria-label="Threshold"]', m);
    type(slider, "0.85");
    expect(slider.nextElementSibling!.textContent).toBe("0.85");
    const areas = $$<HTMLTextAreaElement>("textarea", m);
    type(areas[0]!, "Is there a big claim?");
    type(areas[1]!, "A claim");
    type(areas[2]!, "Not a claim");
    const boxes = $$<HTMLInputElement>(".row .lset-check input", m);
    tick(boxes[0]!, true);
    tick(boxes[1]!, true);
    buttonNamed("Save", $("#labelset-body")).click();
    await flush();
    expect((fake.createLabelSet!.mock.calls[0]![0] as LabelSet).markers).toEqual([{
      id: "big_claim", name: "Big claim", short: "Claim", icon: "heart", instructions: "Is there a big claim?",
      criteria: { true: "A claim", false: "Not a claim" }, threshold: 0.85, perSpeaker: true, list: true,
    }]);
  });

  test("the locked boundary question is shown read-only, with its wording once the library is known", async () => {
    fake.labelSets!.mockResolvedValue({ sets: [], boundary: { instructions: "Does the segment end here?" } });
    await open();
    expect($(".lset-locked .lset-quote", form())).toBeNull();
    dlg("dlg-labelset").close();
    await L.loadLabelSets();
    await open();
    const locked = $(".lset-locked", form());
    expect([$(".badge", locked).textContent, $(".lset-quote", locked).textContent]).toEqual(["Locked", "“Does the segment end here?”"]);
    expect(locked.querySelector("input, textarea")).toBeNull();
    expect($(".lset-guide summary", form()).textContent).toBe("How to write good labels");
  });

  test("the built-in set opens read-only: a note, nothing editable, no add or remove, no check, and Close / Clone to edit", async () => {
    fake.cloneLabelSet!.mockResolvedValue({ ...aiSet(), id: "copy", name: "Copy", builtIn: false });
    fake.labelSet!.mockResolvedValue({ ...aiSet(), id: "copy", name: "Copy", builtIn: false });
    await open(aiSet(), true);
    expect($(".lset-note", form()).textContent).toBe("The built-in set is read-only. Clone it to edit a copy.");
    expect($$<HTMLInputElement>("input.input:not(.lset-hex), textarea, input[type=range], input[type=checkbox]", form()).every((i) => i.disabled)).toBe(true);
    expect($$("button", form()).filter((b) => /^(Add|Remove|×)/.test(b.textContent ?? ""))).toEqual([]);
    expect(fake.checkLabelSet).not.toHaveBeenCalled();
    const actions = $("#labelset-body .lset-actions");
    expect($$("button", actions).map((b) => b.textContent)).toEqual(["Try on a recording", "Close", "Clone to edit"]);
    buttonNamed("Clone to edit", actions).click();
    await flush();
    expect(fake.cloneLabelSet).toHaveBeenCalledWith("ai-podcast");
    expect($("#h-lset-sub").textContent).toBe("Copy");
    buttonNamed("Cancel", $("#labelset-body")).click();
    expect(dlg("dlg-labelset").open).toBe(false);
    await open(aiSet(), true);
    buttonNamed("Close", $("#labelset-body")).click();
    expect(dlg("dlg-labelset").open).toBe(false);
  });

  test("Save of a new set creates it, says so, closes, and refreshes the library", async () => {
    fake.createLabelSet!.mockResolvedValue({ ...tinySet(), id: "tiny-2", name: "Tiny" });
    fake.labelSets!.mockResolvedValue({ sets: [] });
    await open({ ...tinySet(), id: "" });
    save().click();
    await flush();
    expect(fake.createLabelSet).toHaveBeenCalledWith(L.fromModel(L.toModel({ ...tinySet(), id: "" })));
    expect(fake.updateLabelSet).not.toHaveBeenCalled();
    expect(toasts()).toEqual(["ok: Saved Tiny"]);
    expect(dlg("dlg-labelset").open).toBe(false);
    expect(fake.labelSets).toHaveBeenCalled();
  });

  test("a refused save keeps the editor open, turns Save back on, and shows the engine's message", async () => {
    fake.updateLabelSet!.mockRejectedValue(new A.ApiError(400, "markers: ids must be unique"));
    await open();
    save().click();
    expect(save().disabled).toBe(true);
    await flush();
    expect([save().disabled, dlg("dlg-labelset").open]).toEqual([false, true]);
    expect(toasts()).toEqual(["error: markers: ids must be unique"]);
  });

  // Every other failure path in labels.ts shows e.message; this one shows String(e), so a network failure reads
  // "TypeError: Failed to fetch".
  test.fails("BUG LBW-L2: a save that fails with a plain Error shows its message, not 'Error: …'", async () => {
    fake.updateLabelSet!.mockRejectedValue(new TypeError("Failed to fetch"));
    await open();
    save().click();
    await flush();
    expect(toasts()).toEqual(["error: Failed to fetch"]);
  });

  // docs/architecture.md: "its errors are listed, Save waits until there are none". The editor's Save starts enabled
  // and stays enabled until the first check answers (Create with AI's starts disabled).
  test.fails("BUG LBW-L3: the editor's Save waits for the first check before it can be pressed", async () => {
    fake.checkLabelSet!.mockImplementation(() => new Promise(() => {}));
    L.openEditor(L.blankSet(), { readOnly: false });
    expect(save().disabled).toBe(true);
  });

  test("setEditorExtras adds to the footer of every editor opened after it", async () => {
    L.setEditorExtras((host, footer) => footer.append(`extra for ${host.model().name}`));
    await open();
    expect($("#labelset-body .lset-actions").textContent).toMatch(/extra for Tiny/);
  });

  test("load replaces the draft (Create with AI), keeps the set's id, makes it editable, and checks it", async () => {
    const host = L.labelEditor({ ...aiSet() }, { readOnly: true });
    expect(fake.checkLabelSet).not.toHaveBeenCalled();
    host.load({ ...tinySet(), id: "other", builtIn: true });
    await flush();
    expect([host.model().id, host.model().builtIn, host.model().name]).toEqual(["ai-podcast", false, "Tiny"]);
    expect($<HTMLInputElement>("input", host.el).disabled).toBe(false);
    expect(fake.checkLabelSet).toHaveBeenCalledOnce();
  });
});

// ---------- Try on a recording ----------

describe("Try on a recording", () => {
  const openTry = async (over: { set?: LabelSet; recordings?: SessionSummary[] } = {}) => {
    fake.sessions!.mockResolvedValue(over.recordings ?? [rec("r1", { name: "Episode 12" }), rec("r2", { segments: 0, utterances: 0 })]);
    L.openEditor(over.set ?? { ...tinySet(), id: "tiny" }, { readOnly: false });
    await flush();
    buttonNamed("Try on a recording", $("#labelset-body")).click();
    await flush();
  };
  const body = () => $("#labeltry-body");

  test("without the window nothing happens", async () => {
    dlg("dlg-labeltry").remove();
    await openTry();
    expect(fake.sessions).not.toHaveBeenCalled();
  });

  test("a draft with errors: the button is off, and pressing Try anyway asks to fix it first", async () => {
    fake.checkLabelSet!.mockResolvedValue(check({ ok: false, errors: ["name: required"] }));
    L.openEditor(tinySet(), { readOnly: false });
    await flush();
    const btn = buttonNamed("Try on a recording", $("#labelset-body"));
    expect(btn.disabled).toBe(true);
    btn.disabled = false;
    btn.click();
    await flush();
    expect(toasts()).toEqual(["error: Fix the draft first: the editor lists what is missing."]);
    expect(dlg("dlg-labeltry").open).toBe(false);
  });

  test("the built-in set (never checked while read-only) is checked when Try opens", async () => {
    await openTry({ set: aiSet() });
    expect(fake.checkLabelSet).toHaveBeenCalledOnce();
    expect(dlg("dlg-labeltry").open).toBe(true);
  });

  test("lists the recordings with something in them, by name or date and length; the button says what it costs at most", async () => {
    const at = "2026-09-29T20:05:00.000Z";
    await openTry({ recordings: [rec("r1", { name: "Episode 12" }), rec("r2", { segments: 0, utterances: 0 }), rec("r3", { startedAt: at, durationMs: 3_725_000 }), rec("r4", { utterances: 1, segments: 0 })] });
    expect(dlg("dlg-labeltry").open).toBe(true);
    expect($("#ltry-sub").textContent).toBe("Tiny");
    const date = new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    expect($$("select option", body()).map((o) => o.textContent)).toEqual(["Episode 12 · 1:05", `${date} · 1:02:05`, "r4 · 1:05"]);
    expect(buttonStarting("Try it", body()).textContent).toBe("Try it · about $0.0040 at most");
    expect($(".note", body()).textContent).toMatch(/40 at most\)\. Nothing is saved into the recording\.$/);
  });

  test("no recording to try: says so", async () => {
    await openTry({ recordings: [rec("r2", { segments: 0, utterances: 0 })] });
    expect($(".empty", body()).textContent).toBe("No recording to try it on yet: record or import one first.");
    expect(buttonStarting("Try it", body())).toBeUndefined();
  });

  test("the recordings cannot be listed: a toast, and no window", async () => {
    fake.sessions!.mockRejectedValue(new Error("library unavailable"));
    L.openEditor({ ...tinySet(), id: "tiny" }, { readOnly: false });
    await flush();
    buttonNamed("Try on a recording", $("#labelset-body")).click();
    await flush();
    expect(toasts()).toEqual(["error: library unavailable"]);
    expect(dlg("dlg-labeltry").open).toBe(false);
  });

  test("with the key: asks Jev and shows the recording's own labels above the draft's, with the stretch, count, and cost", async () => {
    await keysKnown(true);
    fake.tryLabelSet!.mockResolvedValue(tryResult());
    await openTry();
    buttonStarting("Try it", body()).click();
    expect($(".ltry-result .note", body()).textContent).toBe("Asking Jev about each segment of the first 10 minutes…");
    await flush();
    expect(fake.tryLabelSet).toHaveBeenCalledWith(L.fromModel(L.toModel({ ...tinySet(), id: "tiny" })), "r1", 10);
    expect($(".ltry-meta", body()).textContent).toBe("Episode 12 · 0:00–10:00 · 2 segments · cost $0.0020");
    expect($$(".ltry-block h3", body()).map((h) => h.textContent)).toEqual(["Its own labels · AI podcast", "This draft · Tiny"]);
    const [own, draft] = $$(".ltry-block", body());
    expect($$(".tl-labels .tl-lbl", own!).map((l) => l.textContent)).toContain("Subject");
    expect($$(".lane.cat-1 .blk", draft!).map((b) => b.textContent)).toEqual(["Alpha", "Beta"]);
    expect(buttonStarting("Try it", body()).disabled).toBe(false);
  });

  test("some segments without an answer, one segment, and a draft without a name", async () => {
    await keysKnown(true);
    fake.tryLabelSet!.mockResolvedValue(tryResult({ failed: 1, segments: [{ id: "g1", startMs: 0, endMs: 30_000 }] }));
    await openTry({ set: { ...tinySet(), id: "tiny", name: "" } });
    expect($("#ltry-sub").textContent).toBe("This draft");
    buttonStarting("Try it", body()).click();
    await flush();
    expect($(".ltry-meta", body()).textContent).toBe("Episode 12 · 0:00–10:00 · 1 segment · cost $0.0020 · 1 without an answer");
    expect($$(".ltry-block h3", body()).at(-1)!.textContent).toBe("This draft · untitled");
  });

  test("a recording made with labels off: a note instead of its own labels (transcript-only ones say their segments were cut at pauses)", async () => {
    await keysKnown(true);
    fake.tryLabelSet!.mockResolvedValue(tryResult({ recording: { features: { factcheck: true, labels: false }, set: null, labels: [] } }));
    await openTry();
    buttonStarting("Try it", body()).click();
    await flush();
    expect($(".lset-note", body()).textContent).toBe("This recording ran with labels off, so it has no labels of its own to compare with.");
    expect($$(".ltry-block", body()).length).toBe(1);
    fake.tryLabelSet!.mockResolvedValue(tryResult({ recording: { features: { factcheck: false, labels: false }, set: null, labels: [] } }));
    buttonStarting("Try it", body()).click();
    await flush();
    expect($(".lset-note", body()).textContent).toMatch(/segments were cut at pauses/);
  });

  test("a recording with no segments in the window says so", async () => {
    await keysKnown(true);
    fake.tryLabelSet!.mockResolvedValue(tryResult({ window: null, segments: [] }));
    await openTry();
    buttonStarting("Try it", body()).click();
    await flush();
    expect($(".ltry-result .empty", body()).textContent).toBe("This recording has no segments to label.");
  });

  test("a failed try shows the error in the window", async () => {
    await keysKnown(true);
    fake.tryLabelSet!.mockRejectedValue(new A.ApiError(409, "not while a session is on air"));
    await openTry();
    buttonStarting("Try it", body()).click();
    await flush();
    expect($(".ltry-result .error-text", body()).textContent).toBe("not while a session is on air");
  });

  test("without the OpenRouter key: the key is asked for in the window; Not now puts it away; saving it runs the try", async () => {
    await keysKnown(false);
    fake.tryLabelSet!.mockResolvedValue(tryResult());
    await openTry();
    buttonStarting("Try it", body()).click();
    await flush();
    expect(fake.tryLabelSet).not.toHaveBeenCalled();
    const prompt = () => body().querySelector<HTMLElement>(".key-prompt");
    expect(prompt()!.getAttribute("aria-label")).toBe("Please provide your OpenRouter API key to try a label set on a recording.");
    buttonNamed("Not now", prompt()!).click();
    expect(prompt()).toBeNull();
    buttonStarting("Try it", body()).click();
    await flush();
    fake.saveKeys!.mockResolvedValue({ ...setup(true), saved: true, checks: {} });
    $<HTMLInputElement>(".key-prompt input", body()).value = "sk-or-v1-test";
    buttonNamed("Save", prompt()!).click();
    await flush();
    expect(fake.saveKeys).toHaveBeenCalledWith({ openrouter: "sk-or-v1-test" });
    expect(prompt()).toBeNull();
    expect(fake.tryLabelSet).toHaveBeenCalledOnce();
  });

  test("the engine says the key is missing: the page asks the engine again and then asks for the key", async () => {
    await keysKnown(true);
    fake.tryLabelSet!.mockRejectedValue(new A.ApiError(400, "needs the OpenRouter key", { needsKey: "openrouter" }));
    await openTry();
    fake.setup!.mockResolvedValue(setup(false));
    buttonStarting("Try it", body()).click();
    await flush();
    expect(fake.setup).toHaveBeenCalledTimes(2);
    expect(body().querySelector(".key-prompt")).not.toBeNull();
    expect(fake.tryLabelSet).toHaveBeenCalledOnce();
  });

  // After a needsKey refusal the page re-reads GET /api/setup and tries again. When that read fails, the page's stale
  // "key set" stands, so it retries at once, again and again, for as long as the engine refuses.
  test.fails("BUG LBW-L4: a needsKey refusal with GET /api/setup failing does not retry the try in a loop", async () => {
    await keysKnown(true);
    let n = 0;
    fake.tryLabelSet!.mockImplementation(async () => {
      if (++n < 5) throw new A.ApiError(400, "needs the OpenRouter key", { needsKey: "openrouter" });
      return tryResult();
    });
    await openTry();
    fake.setup!.mockRejectedValue(new Error("setup unavailable"));
    buttonStarting("Try it", body()).click();
    await flush();
    expect(fake.tryLabelSet!.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ---------- Create with AI ----------

describe("Create with AI", () => {
  const open = async (keyOn = true) => {
    await keysKnown(keyOn);
    L.openCreateWithAi();
    await flush();
  };
  const body = () => $("#labels-ai-body");
  const input = () => $<HTMLTextAreaElement>(".chat-input", body());
  const sendBtn = () => buttonNamed("Send", body());
  const bubbles = () => $$(".lai-log .msg", body()).map((m) => `${m.classList.contains("user") ? "you" : m.classList.contains("failed") ? "failed" : "ai"}: ${m.querySelector(".bubble, .lai-reply")?.textContent ?? ""}`);

  test("without the window nothing opens", () => {
    dlg("dlg-labels-ai").remove();
    L.openCreateWithAi();
    expect(fake.checkLabelSet).not.toHaveBeenCalled();
  });

  test("opens with the app's own first question, its answers to click, and an empty draft beside it; nothing is sent", async () => {
    await open();
    expect(dlg("dlg-labels-ai").open).toBe(true);
    expect($(".lai-question", body()).textContent).toBe("What kind of conversation will you label, and what would you like to find in it afterwards?");
    expect($(".lai-reply", body()).textContent).toMatch(/^Let's build a label set together/);
    expect($(".msg-meta .who", body()).textContent).toBe("GPT-6 Luna");
    expect($$(".lai-choice", body()).map((b) => b.textContent)).toEqual(["A podcast about a topic", "A sales or customer call", "A team meeting", "A job interview"]);
    expect($(".lai-progress", body()).textContent).toMatch(/appears after your first answer/);
    expect($<HTMLInputElement>(".lai-draft input", body()).value).toBe("");
    expect([$(".lai-key", body()).hidden, $(".lai-chat-inner", body()).hidden]).toEqual([true, false]);
    expect(buttonNamed("Save", body()).disabled).toBe(false); // a blank draft checks ok with the fake
    expect(fake.assistLabels).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input());
  });

  test("clicking an answer sends it with the opener, no draft yet, and nothing declined; the reply, question, and checklist show", async () => {
    await open();
    assistAnswers(turn());
    buttonNamed("A team meeting", body()).click();
    expect($(".lai-log .typing", body())).not.toBeNull();
    expect(sendBtn().disabled).toBe(true);
    await flush();
    const [conversation, messages, draft, skipped] = sent[0]!;
    expect(conversation).toMatch(/^lai_[a-z0-9]+_[a-z0-9]{1,6}$/);
    expect(messages.map((m: { role: string }) => m.role)).toEqual(["assistant", "user"]);
    expect(messages[1].content).toBe("A team meeting");
    expect([draft, skipped]).toEqual([null, []]);
    expect(bubbles()).toEqual([expect.stringMatching(/^ai: Let's build/), "you: A team meeting", "ai: Got it."]);
    expect($(".lai-log .typing", body())).toBeNull();
    expect($$<HTMLButtonElement>(".lai-choice", body()).filter((b) => !b.disabled).map((b) => b.textContent)).toEqual(["Topics", "Moods"]);
    expect($(".lai-progress-h", body()).textContent).toBe("Still to settle: 1");
    expect($$(".lai-progress li", body()).map((li) => `${li.className} ${li.textContent}`)).toEqual([
      "st-done ✓What the conversation is", "st-todo •Categories", "st-recommended ○Markers", "st-skipped –Scores",
    ]);
    expect($(".lai-progress li.st-todo", body()).title).toBe("at least one");
    expect($(".lai-spend", body()).textContent).toBe("Spent $0.0040");
    expect([sendBtn().disabled, input().value]).toEqual([false, ""]);
  });

  test("a reply with a draft replaces the one on the right and says so; the next answer sends the draft as edited and what was declined", async () => {
    await open();
    assistAnswers(turn({ set: tinySet(), skipped: ["scores"], checklist: { items: [], complete: true, errors: [] }, spentUsd: 0.02 }), turn());
    type(input(), "Label my meetings");
    sendBtn().click();
    await flush();
    expect($$(".msg-meta", body()).at(-1)!.textContent).toBe("GPT-6 Luna" + "Draft updated on the right");
    expect($<HTMLInputElement>('.lai-draft input[placeholder="Sales calls"]', body()).value).toBe("Tiny");
    expect($(".lai-progress-h", body()).textContent).toBe("Ready: try it on a recording, then save");
    expect($(".lai-spend", body()).textContent).toBe("Spent $0.02");
    type($<HTMLInputElement>('.lai-draft input[placeholder="Sales calls"]', body()), "Meetings");
    type(input(), "Looks good");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    const [, messages, draft, skipped] = sent[1]!;
    expect(messages.map((m: { content: string }) => m.content).slice(1)).toEqual(["Label my meetings", "Got it.\n\nWhat should the categories be?", "Looks good"]);
    expect([draft.name, skipped]).toEqual(["Meetings", ["scores"]]);
  });

  test("Shift+Enter does not send, an empty answer is not sent, and a second answer waits for the first", async () => {
    await open();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    type(input(), "one");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(fake.assistLabels).not.toHaveBeenCalled();
    assistAnswers("hang");
    sendBtn().click();
    type(input(), "two");
    sendBtn().click();
    await flush();
    expect(fake.assistLabels).toHaveBeenCalledOnce();
  });

  test("a turn that carries an error adds it as a failed message", async () => {
    await open();
    assistAnswers(turn({ error: "The draft broke a rule twice, so it was not changed." }));
    type(input(), "Add 3 categories");
    sendBtn().click();
    await flush();
    expect(bubbles().at(-1)).toBe("failed: The draft broke a rule twice, so it was not changed.");
  });

  test("a failed request shows its message as a failed message, and is not sent again with the next answer", async () => {
    await open();
    assistAnswers(new A.ApiError(502, "GPT-6 Luna did not answer"), turn());
    type(input(), "first");
    sendBtn().click();
    await flush();
    expect(bubbles().slice(-2)).toEqual(["you: first", "failed: GPT-6 Luna did not answer"]);
    expect(sendBtn().disabled).toBe(false);
    type(input(), "second");
    sendBtn().click();
    await flush();
    expect(sent[1]![1].map((m: { content: string }) => m.content).slice(1)).toEqual(["second"]);
  });

  test("without the OpenRouter key: the key's card instead of the chat; saving the key shows the chat", async () => {
    await open(false);
    const keyBox = $(".lai-key", body());
    expect([keyBox.hidden, $(".lai-chat-inner", body()).hidden]).toEqual([false, true]);
    expect($(".key-prompt", keyBox).getAttribute("aria-label")).toBe("Please provide your OpenRouter API key to create labels with AI.");
    fake.saveKeys!.mockResolvedValue({ ...setup(true), saved: true, checks: {} });
    $<HTMLInputElement>(".key-prompt input", keyBox).value = "sk-or-v1-test";
    buttonNamed("Save", keyBox).click();
    await flush();
    expect([keyBox.hidden, $(".lai-chat-inner", body()).hidden, keyBox.children.length]).toEqual([true, false, 0]);
    expect(document.activeElement).toBe(input());
  });

  test("the engine says the key is missing: the answer goes back in the input, its bubble goes, and the key is asked for", async () => {
    await open();
    fake.assistLabels!.mockRejectedValue(new A.ApiError(400, "needs the OpenRouter key", { needsKey: "openrouter" }));
    fake.setup!.mockResolvedValue(setup(false));
    type(input(), "My podcast");
    sendBtn().click();
    await flush();
    expect(input().value).toBe("My podcast");
    expect(bubbles()).toEqual([expect.stringMatching(/^ai: Let's build/)]);
    expect($(".lai-key", body()).hidden).toBe(false);
    // with the key still missing, sending asks for it again rather than calling
    sendBtn().click();
    await flush();
    expect(fake.assistLabels).toHaveBeenCalledOnce();
  });

  test("Save creates the set, says where to pick it, closes, and refreshes the library; a refusal says why and keeps it open", async () => {
    await open();
    fake.labelSets!.mockResolvedValue({ sets: [] });
    fake.createLabelSet!.mockRejectedValueOnce(new A.ApiError(400, "name: required"));
    const save = buttonNamed("Save", body());
    save.click();
    await flush();
    expect([toasts(), save.disabled, dlg("dlg-labels-ai").open]).toEqual([["error: name: required"], false, true]);
    fake.createLabelSet!.mockResolvedValueOnce({ ...tinySet(), name: "Meetings" });
    save.click();
    await flush();
    expect(toasts().at(-1)).toBe("ok: Saved Meetings: pick it in Start live");
    expect(dlg("dlg-labels-ai").open).toBe(false);
    expect(fake.labelSets).toHaveBeenCalled();
  });

  test("Save follows the draft's check, and Cancel closes the window", async () => {
    fake.checkLabelSet!.mockResolvedValue(check({ ok: false, errors: ["at least one label"] }));
    await open();
    expect(buttonNamed("Save", body()).disabled).toBe(true);
    buttonNamed("Cancel", body()).click();
    expect(dlg("dlg-labels-ai").open).toBe(false);
  });
});
