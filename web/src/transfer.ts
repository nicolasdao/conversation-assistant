// Export and import of recordings: one `.conversation-recording` file to send over WhatsApp or email, and back.
// The engine builds and reads the file (see docs/recordings.md § Export and import); this module is the two windows,
// the header buttons, and dropping a file on the page.
import { api, type ExportInfo, type ImportResult } from "./api.js";
import { $, clock, h, replace } from "./dom.js";
import { toast } from "./panels.js";
import type { State } from "./state.js";

const EXTENSION = ".conversation-recording";
/** Exports made before the app was renamed from Podcast Assistant (27 September 2026) still import. */
const IMPORTABLE = [EXTENSION, ".podcast-recording"];
type Audio = "compressed" | "original" | "none";

let getState: () => State = () => { throw new Error("bindTransfer first"); };

/** 950 KB, 31 MB, 1.2 GB */
export function size(bytes: number): string {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  if (bytes < 1e9) return `${bytes < 1e7 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Where a file of this size can go. */
function fits(bytes: number): string {
  if (bytes <= 24e6) return "fits email and WhatsApp";
  if (bytes <= 2e9) return "fits WhatsApp (2 GB); too big for most email";
  return "too big for WhatsApp; share it through a cloud drive";
}

const onAir = () => { const s = getState().session?.status; return s === "running" || s === "ending"; };

// ---------- export ----------

export async function openExport(id: string) {
  const d = $<HTMLDialogElement>("#dlg-export")!;
  const body = $("#export-body")!;
  replace(body, h("p", { class: "note" }, "Reading the recording…"));
  replace($("#export-sub"), "");
  if (!d.open) { document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((x) => x.close()); d.showModal(); }
  let info: ExportInfo;
  try {
    info = await api.exportInfo(id);
  } catch (e) {
    return replace(body, h("p", { class: "error-text" }, e instanceof Error ? e.message : String(e)));
  }
  replace($("#export-sub"), info.name ?? id);
  let audio: Audio = info.hasAudio ? "compressed" : "none";
  let chats = false;
  const choices: [Audio, string, string][] = [
    ["compressed", "Compressed audio", "Sounds the same for speech; the best way to share it."],
    ["original", "Original audio", "Exactly as recorded, lossless; about eight times bigger."],
    ["none", "No audio", "Transcript, timeline, fact-checks, and speakers; no playback or replay."],
  ];
  const opts = h("div", { class: "choice-list", role: "radiogroup", "aria-label": "Audio" });
  const chatSwitch = h("button", { class: "feat compact", role: "switch", "aria-checked": "false", disabled: info.chats === 0 },
    h("span", { class: "feat-text" }, h("b", {}, "Include my chats"),
      h("span", {}, info.chats ? `${info.chats} chat${info.chats === 1 ? "" : "s"} about this recording. Off by default: they are your own questions.` : "No chats about this recording.")),
    h("span", { class: "toggle", "aria-hidden": "true" }, h("i", {})));
  chatSwitch.addEventListener("click", () => { chats = !chats; chatSwitch.setAttribute("aria-checked", String(chats)); });
  const drawChoices = () => replace(opts, choices.map(([k, title, text]) => {
    const disabled = k !== "none" && !info.hasAudio;
    return h("button", {
      class: "choice", role: "radio", "aria-checked": String(audio === k), disabled,
      onclick: () => { audio = k; drawChoices(); drawFoot(); },
    },
      h("span", { class: "radio", "aria-hidden": "true" }),
      h("span", { class: "feat-text" }, h("b", {}, title), h("span", {}, disabled ? "This recording has no audio." : text)),
      h("span", { class: "choice-size" }, disabled ? "" : `≈ ${size(info.bytes[k])}`));
  }));
  const foot = h("p", { class: "start-summary" });
  const drawFoot = () => replace(foot,
    h("b", {}, info.fileName), h("br", {}),
    `About ${size(info.bytes[audio])}: ${fits(info.bytes[audio])}.`, h("br", {}),
    `${info.recordedWith ? `Recorded with v${info.recordedWith}` : "Recorded before the app noted its version"} · exported with v${info.app.version}.`);
  const go = h("button", { class: "btn primary" }, "Export");
  const status = h("p", { class: "note", "aria-live": "polite" });
  go.addEventListener("click", async () => {
    go.disabled = true;
    replace(go, "Preparing…");
    replace(status, audio === "compressed" ? "Compressing the audio: a few seconds per hour of show." : "");
    try {
      const r = await api.exportPrepare(id, audio, chats);
      // the browser saves it, usually to Downloads
      const a = h("a", { href: `/api/exports/${r.token}`, download: r.fileName, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      d.close();
      toast(`Exported ${r.fileName} (${size(r.bytes)}): check your Downloads folder, then send it as a document.`, "ok");
    } catch (e) {
      replace(status, h("span", { class: "error-text" }, e instanceof Error ? e.message : String(e)));
      go.disabled = false;
      replace(go, "Export");
    }
  });
  drawChoices();
  drawFoot();
  replace(body, opts, chatSwitch, foot,
    h("p", { class: "note" }, `Whoever you send it to imports it with Conversation Assistant: Import in the header, or drop the file on the page.`),
    status,
    h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => d.close() }, "Cancel"), go));
  go.focus();
}

// ---------- import ----------

export function openImport(file?: File) {
  const d = $<HTMLDialogElement>("#dlg-import")!;
  if (!d.open) { document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((x) => x.close()); d.showModal(); }
  const picker = h("input", { type: "file", accept: IMPORTABLE.join(","), hidden: true });
  picker.addEventListener("change", () => { const f = picker.files?.[0]; if (f) void upload(f); });
  const zone = h("div", { class: "drop-zone", tabindex: 0, role: "button", "aria-label": "Choose a recording file to import" },
    h("b", {}, "Drop a recording here"),
    h("span", {}, `A ${EXTENSION} file someone shared with you, from WhatsApp, email, or your Downloads folder.`),
    h("span", { class: "btn" }, "Choose a file"));
  const open = () => picker.click();
  zone.addEventListener("click", open);
  zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) void upload(f);
  });
  replace($("#import-body"), zone, picker,
    h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => d.close() }, "Close")));
  if (file) void upload(file);
}

async function upload(file: File) {
  const body = $("#import-body")!;
  const d = $<HTMLDialogElement>("#dlg-import")!;
  if (!IMPORTABLE.some((x) => file.name.toLowerCase().endsWith(x))) {
    toast(`That is not a recording file: it should end in ${EXTENSION}.`);
    return openImport();
  }
  const bar = h("b", { style: "width:0%" });
  const label = h("span", {}, `Uploading ${file.name}…`);
  replace(body, h("div", { class: "import-progress" }, label, h("span", { class: "bar" }, bar)));
  let r: ImportResult;
  try {
    r = await api.importRecording(file, (done) => {
      bar.style.width = `${Math.round(done * 100)}%`;
      if (done >= 1) replace(label, "Unpacking the recording…");
    });
  } catch (e) {
    replace(body, h("p", { class: "error-text" }, e instanceof Error ? e.message : String(e)),
      h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => openImport() }, "Try another file"), h("button", { class: "btn", onclick: () => d.close() }, "Close")));
    return;
  }
  showResult(r);
}

/**
 * The import's outcome. Imported: the name can be changed right here. Already in the library: open that one, or import
 * this file again as a copy under another name (the upload was kept, so nothing is sent twice).
 */
function showResult(r: ImportResult) {
  const body = $("#import-body")!;
  const d = $<HTMLDialogElement>("#dlg-import")!;
  const s = r.summary;
  const current = s.name ?? s.id;
  const name = h("input", {
    class: "input", maxlength: 120, "aria-label": r.already ? "Name of the copy" : "Name",
    value: r.already ? `${current} (copy)` : current,
  });
  const note = h("p", { class: "note", "aria-live": "polite" });
  const openIt = (id: string, label: string, primary: boolean) => {
    const b = h("button", { class: `btn${primary ? " primary" : ""}`, disabled: onAir(), title: onAir() ? "Stop the current session to open it" : "" }, label);
    b.addEventListener("click", async () => {
      try { await api.openSession(id); d.close(); } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
    });
    return b;
  };
  const when = s.startedAt ? new Date(s.startedAt).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const card = h("div", { class: "import-done" },
    h("b", {}, r.already ? "You already have this recording" : "Imported"),
    h("span", { class: "import-name" }, current),
    h("span", {}, [when, clock(s.durationMs), `${s.utterances} lines`, s.speakers.join(", ") || null].filter(Boolean).join(" · ")),
    h("span", {}, [s.appVersion ? `Recorded with v${s.appVersion}` : null, s.imported?.exportedWith ? `exported with v${s.imported.exportedWith}` : null,
      s.hasAudio === false ? "no audio: no playback or replay" : null].filter(Boolean).join(" · ")));

  if (r.already && r.copyToken) {
    const token = r.copyToken;
    const copy = h("button", { class: "btn primary" }, "Import as a copy");
    const go = async () => {
      if (!name.value.trim()) { replace(note, h("span", { class: "error-text" }, "Give the copy a name.")); return name.focus(); }
      copy.disabled = true;
      replace(copy, "Importing…");
      try {
        showResult(await api.importCopy(token, name.value.trim()));
      } catch (e) {
        replace(note, h("span", { class: "error-text" }, e instanceof Error ? e.message : String(e)));
        copy.disabled = false;
        replace(copy, "Import as a copy");
      }
    };
    copy.addEventListener("click", () => void go());
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } });
    replace(body, card,
      h("label", { class: "fieldlabel" }, "Or import it again, as a copy named", name),
      h("p", { class: "note" }, "Handy to test an export: the copy is a separate recording, and deleting it leaves yours untouched."),
      note,
      h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => openImport() }, "Import another"), openIt(s.id, "Open the one I have", false), copy));
    name.focus();
    name.select();
    return;
  }

  // imported: rename it here, before or after opening it
  const save = h("button", { class: "btn", disabled: true }, "Rename");
  name.addEventListener("input", () => { save.disabled = !name.value.trim() || name.value.trim() === current; });
  const rename = async () => {
    if (save.disabled) return;
    try {
      const updated = await api.renameSession(s.id, name.value.trim());
      showResult({ ...r, summary: { ...s, ...updated } });
      toast(`Renamed to ${updated.name}`, "ok");
    } catch (e) {
      replace(note, h("span", { class: "error-text" }, e instanceof Error ? e.message : String(e)));
    }
  };
  save.addEventListener("click", () => void rename());
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void rename(); } });
  const open = openIt(s.id, "Open it", true);
  replace(body, card,
    h("label", { class: "fieldlabel" }, "Name", h("div", { class: "row" }, name, save)),
    note,
    h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => openImport() }, "Import another"), open));
  open.focus();
}

// ---------- header buttons, and dropping a file anywhere ----------

export function bindTransfer(state: () => State) {
  getState = state;
  $("#export-btn")?.addEventListener("click", () => { const id = getState().session?.id; if (id) void openExport(id); });
  $("#import-btn")?.addEventListener("click", () => openImport());
  const overlay = $("#drop")!;
  let depth = 0;
  const hasFile = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragenter", (e) => { if (!hasFile(e)) return; depth++; overlay.hidden = false; });
  document.addEventListener("dragleave", (e) => { if (!hasFile(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  document.addEventListener("dragover", (e) => { if (hasFile(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) openImport(f);
  });
}

/** The header's Export (a recording on screen) and Import (anything but a session on air). */
export function renderTransferButtons(st: State) {
  const s = st.session;
  const running = s?.status === "running" || s?.status === "ending";
  $("#export-btn")!.hidden = s?.status !== "archived";
  $("#import-btn")!.hidden = running;
}
