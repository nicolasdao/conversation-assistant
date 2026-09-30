// @vitest-environment happy-dom
// Export and import of recordings (web/src/transfer.ts): the two windows, the header buttons, and dropping a file on the
// page. See docs/recordings.md § Export and import.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ExportInfo, ImportResult, SessionSummary } from "../../web/src/api.ts";
import { emptyState, type State } from "../../web/src/state.ts";
import { flush } from "./helpers.ts";
import { all, button, freshPage, key, later, resetApi, text, toasts, type, type FakeApi } from "./helpers-core.ts";

const fake = vi.hoisted(() => ({}) as FakeApi);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<typeof import("../../web/src/api.ts")>()), api: fake }));

type Transfer = typeof import("../../web/src/transfer.ts");
let t: Transfer;
let st: State;
let onLabels: ReturnType<typeof vi.fn<(file: File) => void>>;

const withStatus = (status: string | null) => {
  st = emptyState();
  if (status) st.session = { id: "20260925-120000", mode: "live", status };
};
const info = (o: Partial<ExportInfo> = {}): ExportInfo => ({
  id: "20260925-120000", name: "Pilot", fileName: "Pilot.tattle", recordedWith: "0.7.0", app: { name: "Tattle", version: "0.8.0" },
  bytes: { compressed: 56_700_000, original: 450_000_000, none: 3_000_000 }, chats: 2, hasAudio: true, ...o,
});
const summary = (o: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "20260925-120000", name: "Pilot", notes: null, mode: "live", startedAt: "2026-09-25T12:00:00.000Z", durationMs: 612_000, ended: true,
  utterances: 120, speakers: ["Alice", "Bob"], segments: 9, claims: 3, costUsd: 1.2, appVersion: "0.7.0",
  imported: { at: "2026-09-30T10:00:00.000Z", exportedWith: "0.8.0", fileName: "Pilot.tattle" }, ...o,
});
const file = (name: string) => new File(["x"], name);
const exportDlg = () => document.getElementById("dlg-export") as HTMLDialogElement;
const importDlg = () => document.getElementById("dlg-import") as HTMLDialogElement;
/** A drag event carrying files (or, with `files: null`, something else). */
const drag = (type: string, files: File[] | null) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: files ? ["Files"] : ["text/plain"], files } });
  return e;
};

beforeEach(async () => {
  await resetApi(fake);
  freshPage();
  t = await import("../../web/src/transfer.ts");
  withStatus("archived");
  onLabels = vi.fn<(file: File) => void>();
  t.bindTransfer(() => st, onLabels);
});

describe("size", () => {
  test("KB below a megabyte (at least 1), MB with a decimal below 10, whole MB, then GB", () => {
    expect([t.size(0), t.size(950_000), t.size(1_000_000), t.size(9_940_000), t.size(31_000_000), t.size(1.2e9), t.size(999_999)])
      .toEqual(["1 KB", "950 KB", "1.0 MB", "9.9 MB", "31 MB", "1.2 GB", "1000 KB"]);
  });
});

describe("the header buttons", () => {
  test("a recording shows Export and Import; a session on air hides both; nothing on screen shows Import only", () => {
    const shown = () => [document.getElementById("export-btn")!.hidden, document.getElementById("import-btn")!.hidden];
    t.renderTransferButtons(st);
    expect(shown()).toEqual([false, false]);
    for (const s of ["running", "ending"]) { withStatus(s); t.renderTransferButtons(st); expect(shown()).toEqual([true, true]); }
    withStatus(null);
    t.renderTransferButtons(st);
    expect(shown()).toEqual([true, false]);
  });

  test("Export opens the window for the session on screen; with none nothing happens; Import opens the import window", async () => {
    fake.exportInfo!.mockResolvedValue(info());
    document.getElementById("export-btn")!.click();
    await flush();
    expect(fake.exportInfo).toHaveBeenCalledWith("20260925-120000");
    exportDlg().close();
    withStatus(null);
    document.getElementById("export-btn")!.click();
    expect(fake.exportInfo).toHaveBeenCalledTimes(1);
    document.getElementById("import-btn")!.click();
    expect([importDlg().open, all("#import-body .drop-zone").length]).toEqual([true, 1]);
  });
});

describe("the Export window", () => {
  test("says it is reading, closes other windows, and shows a failure", async () => {
    const answer = later<ExportInfo>();
    fake.exportInfo!.mockReturnValue(answer.promise);
    const other = document.getElementById("dlg-recordings") as HTMLDialogElement;
    other.showModal();
    void t.openExport("x");
    expect([text("#export-body"), text("#export-sub"), other.open, exportDlg().open]).toEqual(["Reading the recording…", "", false, true]);
    answer.reject(new Error("unknown session"));
    await flush();
    expect(text("#export-body .error-text")).toBe("unknown session");
    fake.exportInfo!.mockRejectedValue("odd");
    await t.openExport("x"); // already open: stays open
    expect([exportDlg().open, text("#export-body .error-text")]).toEqual([true, "odd"]);
  });

  test("with audio: compressed is chosen, sizes show, and choosing another redraws the choice and the size", async () => {
    fake.exportInfo!.mockResolvedValue(info());
    await t.openExport("20260925-120000");
    expect(text("#export-sub")).toBe("Pilot");
    const radios = () => all("#export-body .choice");
    expect(radios().map((r) => [r.getAttribute("aria-checked"), text(".choice-size", r)])).toEqual([["true", "≈ 57 MB"], ["false", "≈ 450 MB"], ["false", "≈ 3.0 MB"]]);
    expect(text("#export-body .start-summary")).toBe("Pilot.tattleAbout 57 MB: fits WhatsApp (2 GB); too big for most email.Recorded with v0.7.0 · exported with v0.8.0.");
    radios()[2]!.click();
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(text("#export-body .start-summary")).toContain("About 3.0 MB: fits email and WhatsApp.");
    expect(document.activeElement?.textContent).toBe("Export");
  });

  test("without audio: compressed and original are disabled, No audio is chosen; a name falls back to the id", async () => {
    fake.exportInfo!.mockResolvedValue(info({ hasAudio: false, name: null, recordedWith: null, bytes: { compressed: 1, original: 1, none: 3e9 } }));
    await t.openExport("20260925-120000");
    const radios = all("#export-body .choice") as HTMLButtonElement[];
    expect(radios.map((r) => [r.disabled, r.getAttribute("aria-checked")])).toEqual([[true, "false"], [true, "false"], [false, "true"]]);
    expect(radios.slice(0, 2).map((r) => text(".feat-text span", r))).toEqual(["This recording has no audio.", "This recording has no audio."]);
    expect(radios.slice(0, 2).map((r) => text(".choice-size", r))).toEqual(["", ""]);
    expect(text("#export-sub")).toBe("20260925-120000");
    expect(text("#export-body .start-summary")).toContain("too big for WhatsApp; share it through a cloud drive.Recorded before the app noted its version");
  });

  test("the chats switch: off by default, toggled by a click; disabled with no chats", async () => {
    fake.exportInfo!.mockResolvedValue(info({ chats: 1 }));
    await t.openExport("x");
    const sw = document.querySelector<HTMLButtonElement>("#export-body [role=switch]")!;
    expect([sw.disabled, sw.getAttribute("aria-checked"), text(".feat-text span", sw)]).toEqual([false, "false", "1 chat about this recording. Off by default: they are your own questions."]);
    sw.click();
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fake.exportInfo!.mockResolvedValue(info({ chats: 0 }));
    await t.openExport("x");
    const off = document.querySelector<HTMLButtonElement>("#export-body [role=switch]")!;
    expect([off.disabled, text(".feat-text span", off)]).toEqual([true, "No chats about this recording."]);
    fake.exportInfo!.mockResolvedValue(info({ chats: 3 }));
    await t.openExport("x");
    expect(text("#export-body [role=switch] .feat-text span")).toMatch(/^3 chats about/);
  });

  test("Export prepares the file with the choices, downloads it, closes, and says where it went", async () => {
    fake.exportInfo!.mockResolvedValue(info());
    const answer = later<{ token: string; fileName: string; bytes: number }>();
    fake.exportPrepare!.mockReturnValue(answer.promise);
    await t.openExport("20260925-120000");
    document.querySelector<HTMLButtonElement>("#export-body [role=switch]")!.click();
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
    const go = button("Export", document.getElementById("export-body")!)!;
    go.click();
    expect([go.disabled, go.textContent, text("#export-body [aria-live]")]).toEqual([true, "Preparing…", "Compressing the audio: a few seconds per hour of show."]);
    expect(fake.exportPrepare).toHaveBeenCalledWith("20260925-120000", "compressed", true);
    answer.resolve({ token: "t1", fileName: "Pilot.tattle", bytes: 56_700_000 });
    await flush();
    expect(clicked.map((a) => [a.getAttribute("href"), a.getAttribute("download"), a.isConnected])).toEqual([["/api/exports/t1", "Pilot.tattle", false]]);
    expect(exportDlg().open).toBe(false);
    expect(toasts()).toEqual(["Exported Pilot.tattle (57 MB): check your Downloads folder, then send it as a document."]);
    expect(document.querySelector("#toasts .toast")!.className).toBe("toast ok");
  });

  test("an export without compression says nothing while preparing; a failure shows its error and gives Export back", async () => {
    fake.exportInfo!.mockResolvedValue(info());
    fake.exportPrepare!.mockRejectedValue(new Error("a session is on air"));
    await t.openExport("x");
    all("#export-body .choice")[1]!.click();
    const go = button("Export", document.getElementById("export-body")!)!;
    go.click();
    expect(text("#export-body [aria-live]")).toBe("");
    await flush();
    expect([text("#export-body .error-text"), go.disabled, go.textContent]).toEqual(["a session is on air", false, "Export"]);
    fake.exportPrepare!.mockRejectedValue("odd");
    go.click();
    await flush();
    expect(text("#export-body .error-text")).toBe("odd");
    button("Cancel", document.getElementById("export-body")!)!.click();
    expect(exportDlg().open).toBe(false);
  });
});

describe("the Import window", () => {
  test("a drop zone and a hidden picker for the recording extensions; Close closes", () => {
    const other = document.getElementById("dlg-recordings") as HTMLDialogElement;
    other.showModal();
    t.openImport();
    expect([importDlg().open, other.open]).toEqual([true, false]);
    const picker = document.querySelector<HTMLInputElement>("#import-body input[type=file]")!;
    expect([picker.accept, picker.hidden]).toEqual([".tattle,.conversation-recording,.podcast-recording", true]);
    expect(document.querySelector("#import-body .drop-zone")!.getAttribute("aria-label")).toBe("Choose a recording file to import");
    t.openImport(); // already open
    expect(importDlg().open).toBe(true);
    button("Close", document.getElementById("import-body")!)!.click();
    expect(importDlg().open).toBe(false);
  });

  test("a click, Enter or Space on the zone opens the picker; other keys do not", () => {
    t.openImport();
    const picker = document.querySelector<HTMLInputElement>("#import-body input[type=file]")!;
    const click = vi.spyOn(picker, "click").mockImplementation(() => {});
    const zone = document.querySelector<HTMLElement>("#import-body .drop-zone")!;
    zone.click();
    expect(key(zone, "Enter").defaultPrevented).toBe(true);
    key(zone, " ");
    expect(key(zone, "a").defaultPrevented).toBe(false);
    expect(click).toHaveBeenCalledTimes(3);
  });

  test("a file chosen in the picker is uploaded; none chosen does nothing", async () => {
    fake.importRecording!.mockReturnValue(new Promise(() => {}));
    t.openImport();
    const picker = document.querySelector<HTMLInputElement>("#import-body input[type=file]")!;
    Object.defineProperty(picker, "files", { configurable: true, value: [] });
    picker.dispatchEvent(new Event("change"));
    expect(fake.importRecording).not.toHaveBeenCalled();
    Object.defineProperty(picker, "files", { configurable: true, value: [file("Pilot.tattle")] });
    picker.dispatchEvent(new Event("change"));
    expect(fake.importRecording).toHaveBeenCalledTimes(1);
  });

  test("dragging over the zone marks it; leaving unmarks it; a drop uploads the first file, and the page's handler does not also", async () => {
    fake.importRecording!.mockReturnValue(new Promise(() => {}));
    t.openImport();
    const zone = document.querySelector<HTMLElement>("#import-body .drop-zone")!;
    const over = drag("dragover", [file("a.tattle")]);
    zone.dispatchEvent(over);
    expect([zone.classList.contains("over"), over.defaultPrevented]).toEqual([true, true]);
    zone.dispatchEvent(new Event("dragleave"));
    expect(zone.classList.contains("over")).toBe(false);
    zone.dispatchEvent(drag("drop", [file("a.tattle"), file("b.tattle")]));
    expect(fake.importRecording).toHaveBeenCalledTimes(1);
    expect(fake.importRecording!.mock.calls[0]![0].name).toBe("a.tattle");
    const empty = drag("drop", []);
    t.openImport();
    document.querySelector("#import-body .drop-zone")!.dispatchEvent(empty);
    expect(fake.importRecording).toHaveBeenCalledTimes(1);
  });

  test("a file that is not a recording is refused with a toast and the zone again", async () => {
    t.openImport(file("notes.txt"));
    await flush();
    expect(fake.importRecording).not.toHaveBeenCalled();
    expect(toasts()).toEqual(["That is not a recording file: it should end in .tattle."]);
    expect(all("#import-body .drop-zone")).toHaveLength(1);
  });

  test("the current extension in any case and the two earlier ones are accepted", async () => {
    fake.importRecording!.mockReturnValue(new Promise(() => {}));
    for (const name of ["PILOT.TATTLE", "x.conversation-recording", "x.podcast-recording"]) t.openImport(file(name));
    expect(fake.importRecording!.mock.calls.map((c) => c[0].name)).toEqual(["PILOT.TATTLE", "x.conversation-recording", "x.podcast-recording"]);
  });

  test("the upload's progress: waiting until progress arrives, then its width, then unpacking", async () => {
    let progress!: (d: number) => void;
    fake.importRecording!.mockImplementation((_f: File, on: (d: number) => void) => { progress = on; return new Promise(() => {}); });
    t.openImport(file("Pilot.tattle"));
    const bar = () => document.querySelector<HTMLElement>("#import-body .bar")!;
    expect([text("#import-body .import-progress > span"), bar().className]).toEqual(["Importing Pilot.tattle…", "bar waiting"]);
    progress(0.426);
    expect([bar().className, bar().querySelector("b")!.style.width, text("#import-body .import-progress > span")]).toEqual(["bar", "43%", "Importing Pilot.tattle…"]);
    progress(1);
    expect(text("#import-body .import-progress > span")).toBe("Unpacking the recording…");
  });

  test("a failed upload shows the error with Try another file and Close", async () => {
    fake.importRecording!.mockRejectedValue(new Error("a session is on air"));
    t.openImport(file("Pilot.tattle"));
    await flush();
    expect(text("#import-body .error-text")).toBe("a session is on air");
    button("Try another file")!.click();
    expect(all("#import-body .drop-zone")).toHaveLength(1);
    fake.importRecording!.mockRejectedValue("odd");
    t.openImport(file("Pilot.tattle"));
    await flush();
    expect(text("#import-body .error-text")).toBe("odd");
    button("Close", document.getElementById("import-body")!)!.click();
    expect(importDlg().open).toBe(false);
  });
});

describe("the import's result", () => {
  const imported = async (r: Partial<ImportResult> = {}) => {
    fake.importRecording!.mockResolvedValue({ summary: summary(), already: false, ...r });
    t.openImport(file("Pilot.tattle"));
    await flush();
  };
  const name = () => document.querySelector<HTMLInputElement>("#import-body input.input")!;

  test("imported: the name, what it holds, the versions, and whether it has audio", async () => {
    await imported({ summary: summary({ hasAudio: false }) });
    const when = new Date("2026-09-25T12:00:00.000Z").toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const spans = all("#import-body .import-done > span").map((s) => s.textContent);
    expect(text("#import-body .import-done b")).toBe("Imported");
    expect(spans).toEqual(["Pilot", `${when} · 10:12 · 120 lines · Alice, Bob`, "Recorded with v0.7.0 · exported with v0.8.0 · no audio: no playback or replay"]);
    expect([name().value, name().getAttribute("aria-label")]).toEqual(["Pilot", "Name"]);
    expect(document.activeElement?.textContent).toBe("Open it");
  });

  test("imported with little known: the id for a name, no date, no speakers, no versions", async () => {
    await imported({ summary: summary({ name: null, startedAt: null, speakers: [], appVersion: null, imported: null }) });
    expect(all("#import-body .import-done > span").map((s) => s.textContent)).toEqual(["20260925-120000", "10:12 · 120 lines", ""]);
  });

  test("Rename waits for a new name; Rename or Enter saves it, redraws, and says so; a failure shows under it", async () => {
    await imported();
    const save = () => button("Rename")!;
    expect(save().disabled).toBe(true);
    type(name(), "  Pilot ");
    expect(save().disabled).toBe(true);
    type(name(), "");
    expect(save().disabled).toBe(true);
    key(name(), "Enter");
    expect(fake.renameSession).not.toHaveBeenCalled();
    type(name(), "Episode 1");
    expect(save().disabled).toBe(false);
    fake.renameSession!.mockResolvedValue(summary({ name: "Episode 1" }));
    save().click();
    await flush();
    expect(fake.renameSession).toHaveBeenCalledWith("20260925-120000", "Episode 1");
    expect([text("#import-body .import-name"), toasts()]).toEqual(["Episode 1", ["Renamed to Episode 1"]]);
    fake.renameSession!.mockRejectedValue(new Error("name too long"));
    type(name(), "X");
    expect(key(name(), "Enter").defaultPrevented).toBe(true);
    key(name(), "a");
    await flush();
    expect(text("#import-body .note .error-text")).toBe("name too long");
    fake.renameSession!.mockRejectedValue("odd");
    save().click();
    await flush();
    expect(text("#import-body .note .error-text")).toBe("odd");
  });

  test("Open it opens the recording and closes; a failure is a toast", async () => {
    await imported();
    fake.openSession!.mockResolvedValue({ sessionId: "20260925-120000", events: 3 });
    button("Open it")!.click();
    await flush();
    expect([fake.openSession!.mock.calls[0]![0], importDlg().open]).toEqual(["20260925-120000", false]);
    await imported();
    fake.openSession!.mockRejectedValue(new Error("gone"));
    button("Open it")!.click();
    await flush();
    fake.openSession!.mockRejectedValue("odd");
    button("Open it")!.click();
    await flush();
    expect([toasts(), importDlg().open]).toEqual([["gone", "odd"], true]);
  });

  test("on air, the open buttons are disabled and say why", async () => {
    withStatus("running");
    await imported();
    expect([button("Open it")!.disabled, button("Open it")!.getAttribute("title")]).toEqual([true, "Stop the current session to open it"]);
    withStatus("archived");
    await imported();
    expect([button("Open it")!.disabled, button("Open it")!.getAttribute("title")]).toEqual([false, ""]);
  });

  test("Import another goes back to the zone", async () => {
    await imported();
    button("Import another")!.click();
    expect(all("#import-body .drop-zone")).toHaveLength(1);
  });

  test("already in the library: the copy's name selected, open the one I have, or import it as a copy", async () => {
    await imported({ already: true, copyToken: "c1" });
    expect(text("#import-body .import-done b")).toBe("You already have this recording");
    expect([name().value, name().getAttribute("aria-label"), document.activeElement]).toEqual(["Pilot (copy)", "Name of the copy", name()]);
    expect(all("#import-body .row.end button").map((b) => b.textContent)).toEqual(["Import another", "Open the one I have", "Import as a copy"]);
    type(name(), "  ");
    button("Import as a copy")!.click();
    await flush();
    expect(text("#import-body .note .error-text")).toBe("Give the copy a name.");
    expect(fake.importCopy).not.toHaveBeenCalled();
    const answer = later<ImportResult>();
    fake.importCopy!.mockReturnValue(answer.promise);
    type(name(), " Pilot (copy) ");
    key(name(), "Enter");
    key(name(), "a");
    const copy = button("Importing…")!;
    expect(copy.disabled).toBe(true);
    expect(fake.importCopy).toHaveBeenCalledWith("c1", "Pilot (copy)");
    answer.resolve({ summary: summary({ id: "20260925-120000-2", name: "Pilot (copy)" }), already: false });
    await flush();
    expect([text("#import-body .import-done b"), text("#import-body .import-name")]).toEqual(["Imported", "Pilot (copy)"]);
  });

  test("a failed copy shows why and gives the button back; Open the one I have opens the original", async () => {
    await imported({ already: true, copyToken: "c1" });
    fake.importCopy!.mockRejectedValue(new Error("the upload expired"));
    button("Import as a copy")!.click();
    await flush();
    expect([text("#import-body .note .error-text"), button("Import as a copy")!.disabled]).toEqual(["the upload expired", false]);
    fake.importCopy!.mockRejectedValue("odd");
    button("Import as a copy")!.click();
    await flush();
    expect(text("#import-body .note .error-text")).toBe("odd");
    button("Import another")!.click();
    await imported({ already: true, copyToken: "c1" });
    fake.openSession!.mockResolvedValue({});
    button("Open the one I have")!.click();
    await flush();
    expect(fake.openSession).toHaveBeenCalledWith("20260925-120000");
  });

  // transfer.ts: `already` without `copyToken` falls through to the just-imported layout (a Name field with Rename and
  // "Open it", as if this file had been added), under the heading "You already have this recording" (the server always
  // sends a token today, so this is an edge).
  test.fails("BUG §14.20: already in the library without a copy token offers the one I have, not the imported layout", async () => {
    await imported({ already: true });
    expect(text("#import-body .import-done b")).toBe("You already have this recording");
    expect(button("Open it")).toBeUndefined();
    expect(button("Open the one I have")).toBeDefined();
  });

  // §14.3 (api.ts resolves null for a 2xx whose body is not JSON, and showResult(null) throws) cannot be written even as
  // it.fails: the throw is an unhandled rejection from `void upload(file)`, which fails the test run. See the report.
});

describe("dropping a file anywhere on the page", () => {
  test("a drag with files shows the overlay until the last leave; drop hides it and imports the first file", () => {
    fake.importRecording!.mockReturnValue(new Promise(() => {}));
    const overlay = document.getElementById("drop")!;
    document.dispatchEvent(drag("dragenter", [file("a.tattle")]));
    document.body.dispatchEvent(drag("dragenter", [file("a.tattle")]));
    expect(overlay.hidden).toBe(false);
    document.dispatchEvent(drag("dragleave", [file("a.tattle")]));
    expect(overlay.hidden).toBe(false);
    document.dispatchEvent(drag("dragleave", [file("a.tattle")]));
    document.dispatchEvent(drag("dragleave", [file("a.tattle")]));
    expect(overlay.hidden).toBe(true);
    const over = drag("dragover", [file("a.tattle")]);
    document.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    document.dispatchEvent(drag("dragenter", [file("a.tattle")]));
    const drop = drag("drop", [file("Pilot.tattle")]);
    document.dispatchEvent(drop);
    expect([overlay.hidden, drop.defaultPrevented, importDlg().open]).toEqual([true, true, true]);
    expect(fake.importRecording!.mock.calls[0]![0].name).toBe("Pilot.tattle");
  });

  test("drags without files are ignored", () => {
    const overlay = document.getElementById("drop")!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const e = drag(type, null);
      document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    const noTransfer = new Event("dragenter", { bubbles: true });
    document.dispatchEvent(noTransfer);
    document.dispatchEvent(drag("dragleave", null));
    expect([overlay.hidden, importDlg().open]).toEqual([true, false]);
  });

  test("a label set file goes to the label library; a drop with no file opens nothing", () => {
    document.dispatchEvent(drag("drop", [file("Mine.TATTLE-LABELS")]));
    expect(onLabels).toHaveBeenCalledTimes(1);
    expect(importDlg().open).toBe(false);
    document.dispatchEvent(drag("drop", []));
    expect(importDlg().open).toBe(false);
  });

  test("without a label handler a label set file goes to the import window, which refuses it", async () => {
    freshPage();
    t = await import("../../web/src/transfer.ts");
    t.bindTransfer(() => st);
    document.dispatchEvent(drag("drop", [file("Mine.tattle-labels")]));
    await flush();
    expect(toasts()).toEqual(["That is not a recording file: it should end in .tattle."]);
  });
});
