import { api, type SessionSummary } from "./api.js";
import { $, clock, h, pretty, replace, usd } from "./dom.js";
import { MARKERS, SUBJECT_COLORS } from "./timeline.js";
import { resolveSpeaker, s1Counters, speakerName, type Claim, type LabelQuestion, type LabelSet, type Segment, type State, type Stream } from "./state.js";

export interface Filters { markers: Set<string>; speaker: string; subject: string }
export const filters: Filters = { markers: new Set(), speaker: "", subject: "" };

export function toast(message: string, kind: "error" | "ok" = "error") {
  const t = h("div", { class: `toast ${kind}` }, message);
  $("#toasts")?.append(t);
  setTimeout(() => t.remove(), 6000);
}

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok, "ok");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

// ---------- session controls ----------

let devicesLoaded = false;
export async function loadDevices() {
  if (devicesLoaded) return;
  devicesLoaded = true;
  const sel = $<HTMLSelectElement>("#mic");
  if (!sel) return;
  try {
    const devices = await api.devices();
    replace(sel, h("option", { value: "builtin" }, "Built-in microphone"),
      devices.filter((d) => d.transport !== "builtin").map((d) => h("option", { value: d.uid }, `${d.name} (${d.transport})`)));
  } catch (e) {
    replace(sel, h("option", { value: "" }, "capture helper unavailable"));
    sel.title = e instanceof Error ? e.message : String(e);
  }
}

export function bindControls() {
  $("#start-live")?.addEventListener("click", () => run(() => api.startLive($<HTMLSelectElement>("#mic")?.value || undefined)));
  $("#start-replay")?.addEventListener("click", () => {
    const dir = $<HTMLInputElement>("#replay-dir")!.value.trim();
    const speed = $<HTMLSelectElement>("#replay-speed")!.value === "max" ? "max" : 1;
    void run(() => api.startReplay(dir, speed));
  });
  $("#stop")?.addEventListener("click", () => run(() => api.stop(), "Stopping: in-flight work will finish"));
}

export function renderSession(st: State) {
  const s = st.session;
  const running = s?.status === "running" || s?.status === "ending";
  replace($("#session-status"), s
    ? h("span", { class: `pill ${s.status}` }, s.status === "archived" ? "recording" : `${s.mode} · ${s.status}`,
      h("span", { class: "muted" }, ` ${s.name || s.id}`))
    : h("span", { class: "pill" }, "no session"));
  for (const id of ["#start-live", "#start-replay"]) $<HTMLButtonElement>(id)!.disabled = running;
  $<HTMLButtonElement>("#stop")!.disabled = !running;
}

// ---------- stream health ----------

export function renderHealth(st: State) {
  if (st.session?.status === "archived") {
    return replace($("#health"), h("div", { class: "muted" }, "Recorded session: showing what was captured. Start live or replay to capture again."));
  }
  const running = st.session?.status === "running";
  const streams: Stream[] = st.session?.streams ?? ["host", "remote"];
  replace($("#health"), (["host", "remote"] as Stream[]).map((stream) => {
    const hl = st.health[stream];
    const present = streams.includes(stream);
    const now = Date.now();
    const age = hl ? hl.msSinceLastFrame + (now - hl.receivedAt) : -1;
    const silentFor = hl ? now - hl.lastSoundAt : 0;
    const red = running && present && (!hl || silentFor > 10_000 || age > 3000);
    const pct = hl ? Math.max(0, Math.min(100, ((hl.rmsDbfs + 60) / 60) * 100)) : 0;
    const device = stream === "host" ? hl?.detail?.host?.device : hl?.detail?.remote?.outputDevice;
    return h("div", { class: `meter${red ? " alert" : ""}${present ? "" : " absent"}` },
      h("div", { class: "meter-name" }, stream, device ? h("span", { class: "muted small" }, ` ${device}`) : null),
      h("div", { class: "meter-bar" }, h("div", { class: "meter-fill", style: `width:${pct}%` })),
      h("div", { class: "meter-meta small" },
        !present ? "absent" : hl ? `${hl.rmsDbfs.toFixed(0)} dBFS · last frame ${age < 0 ? "–" : age < 1000 ? `${age} ms` : `${(age / 1000).toFixed(1)} s`}${red && silentFor > 10_000 ? ` · silent ${(silentFor / 1000).toFixed(0)} s` : ""}` : "waiting…"));
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
  const chips = Object.entries(MARKERS).filter(([k]) => k !== "humour").map(([k, m]) =>
    h("button", {
      class: `chip${filters.markers.has(k) ? " on" : ""}`,
      onclick: () => { filters.markers.has(k) ? filters.markers.delete(k) : filters.markers.add(k); onChange(); },
    }, `${m.icon} ${m.label}`));
  const speakers = [...st.speakers.values()].filter((s) => !s.mergedInto);
  replace($("#filters"),
    chips,
    h("select", { class: "chip-select", onchange: (e: Event) => { filters.speaker = (e.target as HTMLSelectElement).value; onChange(); } },
      h("option", { value: "" }, "All speakers"),
      speakers.map((s) => h("option", { value: s.id, selected: filters.speaker === s.id }, s.displayName))),
    h("select", { class: "chip-select", onchange: (e: Event) => { filters.subject = (e.target as HTMLSelectElement).value; onChange(); } },
      h("option", { value: "" }, "All subjects"),
      h("option", { value: "ai", selected: filters.subject === "ai" }, "AI (all)"),
      Object.keys(SUBJECT_COLORS).map((k) => h("option", { value: k, selected: filters.subject === k }, pretty(k)))),
    filters.markers.size || filters.speaker || filters.subject
      ? h("button", { class: "chip clear", onclick: () => { filters.markers.clear(); filters.speaker = ""; filters.subject = ""; onChange(); } }, "Clear")
      : null);
}

// ---------- transcript ----------

async function promptRename(st: State, id: string) {
  const current = speakerName(st, id);
  const name = prompt(`Rename ${current} to:`, current);
  if (name && name.trim() && name.trim() !== current) await run(() => api.rename(resolveSpeaker(st, id)?.id ?? id, name.trim()));
}

export function renderTranscript(st: State) {
  const box = $("#transcript")!;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const bySeg = segmentOf(st);
  const labelFilter = filters.markers.size > 0 || !!filters.subject;
  const utts = [...st.utterances.values()].sort((a, b) => a.startMs - b.startMs);
  const rows: HTMLElement[] = [];
  let lastSeg: string | undefined;
  const flagged = new Set([...st.claims.values()].map((c) => c.utteranceId));
  for (const u of utts) {
    const seg = bySeg.get(u.id);
    if (labelFilter && (!seg || !segmentMatches(seg))) continue;
    const sp = resolveSpeaker(st, u.speakerId);
    if (filters.speaker && sp?.id !== filters.speaker) continue;
    if (seg && seg.id !== lastSeg) {
      const l = seg.labels;
      rows.push(h("div", { class: "seg-divider", id: `seg-${seg.id}` },
        h("span", {}, `${clock(seg.startMs)}`),
        l?.choices.subject ? h("span", { class: "tag", style: `background:${SUBJECT_COLORS[l.choices.subject.choice] ?? "#555"}` }, pretty(l.choices.subject.choice)) : null,
        l?.choices.mode ? h("span", { class: "tag ghost" }, pretty(l.choices.mode.choice)) : null,
        (l?.markers ?? []).map((m) => MARKERS[m] ? h("span", { title: MARKERS[m].label }, MARKERS[m].icon) : null),
        l?.mentions.length ? h("span", { class: "muted small" }, l.mentions.join(", ")) : null));
      lastSeg = seg.id;
    }
    rows.push(h("div", { class: `utt${u.filler ? " filler" : ""}${flagged.has(u.id) ? " flagged" : ""}`, id: `utt-${u.id}`, "data-seg": seg?.id ?? "" },
      h("span", { class: "utt-time" }, clock(u.startMs)),
      h("button", { class: `utt-speaker s-${u.stream}`, title: "Click to rename", onclick: () => promptRename(st, u.speakerId) },
        speakerName(st, u.speakerId), u.speakerInferred ? "*" : ""),
      h("span", { class: "utt-text" }, u.text),
      u.tags.map((t) => h("span", { class: "tag ghost small" }, t)),
      flagged.has(u.id) ? h("span", { class: "flag", title: "Flagged for fact-checking" }, "⚑") : null));
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
        h("span", { class: "utt-time" }, h("span", { class: "live-dot", title: "Live text: the final line replaces it" })),
        h("span", { class: `utt-speaker s-${p.stream}` }, sp?.displayName ?? (p.stream === "host" ? "Host" : "Call")),
        h("span", { class: "utt-text" }, p.text)));
    }
  }
  if (rows.length === 0) rows.push(h("div", { class: "empty" }, st.session ? "Waiting for speech…" : "Start a live session or a replay."));
  replace(box, rows);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

export function jumpToSegment(segmentId: string) {
  const el = document.getElementById(`seg-${segmentId}`);
  if (!el) return toast("That segment is hidden by the current filters");
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
  const idx = c.status === "dropped" ? -1 : steps.indexOf(c.status);
  const reps = c.repeats.length + c.duplicates.length;
  return h("article", { class: `card v-${v?.verdict ?? c.status}${c.disputed ? " disputed" : ""}` },
    h("header", {},
      h("span", { class: "card-speaker" }, speakerName(st, c.speakerId)),
      c.status === "dropped"
        ? h("span", { class: "pill dropped" }, `dropped · ${pretty(c.dropReason ?? "")}`)
        : h("span", { class: "steps" }, steps.map((s, i) => h("span", { class: `step${i <= idx ? " done" : ""}${i === idx ? " current" : ""}` }, s))),
      reps ? h("span", { class: "badge repeat", title: "Said again: linked to this claim, not researched twice" }, `repeat ×${reps}`) : null,
      c.disputed ? h("span", { class: "badge disputed" }, "host disputes") : null),
    h("p", { class: "card-quote" }, `“${c.text}”`),
    v ? h("div", { class: "card-verdict" },
      h("span", { class: `verdict ${v.verdict}` }, VERDICT_LABEL[v.verdict] ?? v.verdict),
      h("span", { class: "muted small" }, ` ${v.confidence} confidence${v.downgraded ? " · no source found" : ""}${c.latencyMs ? ` · ${(c.latencyMs / 1000).toFixed(1)} s` : ""}`),
      h("p", { class: "card-restated" }, v.restated_claim),
      v.correction ? h("p", { class: "card-correction" }, v.correction) : null,
      v.sources.length ? h("ul", { class: "sources" }, v.sources.map((s) => h("li", {}, h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.title || s.url)))) : null,
      !c.disputed ? h("button", {
        class: "link-button", onclick: () => {
          const note = prompt("Why does the host dispute this verdict? (optional)") ?? undefined;
          void run(() => api.override(c.id, note || undefined));
        },
      }, "Host disputes") : null) : null);
}

export function renderClaims(st: State) {
  const claims = [...st.claims.values()].sort((a, b) =>
    (b.activity ?? "").localeCompare(a.activity ?? "") || Number(b.id.slice(2)) - Number(a.id.slice(2)));
  replace($("#claims"), claims.length ? claims.map((c) => card(st, c)) : h("div", { class: "empty" }, "Checkable claims appear here as they are said."));
  replace($("#claims-count"), claims.length ? String(claims.length) : "");
}

// ---------- speakers ----------

export function renderSpeakers(st: State) {
  const active = [...st.speakers.values()].filter((s) => !s.mergedInto);
  replace($("#speakers"), active.length === 0 ? h("div", { class: "empty" }, "Speakers appear as they talk.") : active.map((sp) => {
    const input = h("input", { value: sp.displayName, "aria-label": `Rename ${sp.id}` });
    const into = h("select", {}, h("option", { value: "" }, "Merge into…"), active.filter((o) => o.id !== sp.id).map((o) => h("option", { value: o.id }, o.displayName)));
    const talk = st.stats?.speakers?.find((x: any) => x.speakerId === sp.id);
    return h("div", { class: "speaker-row" },
      h("span", { class: "muted small mono" }, sp.id),
      input,
      h("button", { onclick: () => run(() => api.rename(sp.id, input.value.trim()), "Renamed") }, "Rename"),
      into,
      h("button", {
        onclick: () => {
          if (!into.value) return;
          const target = st.speakers.get(into.value)?.displayName ?? into.value;
          if (confirm(`Merge ${sp.displayName} into ${target}? Their utterances will be relabelled as ${target}.`)) void run(() => api.merge(sp.id, into.value));
        },
      }, "Merge"),
      talk ? h("span", { class: "muted small" }, `${clock(talk.talkMs)} talk`) : null);
  }));
}

// ---------- System 1 ----------

export async function renderS1(st: State) {
  const c = s1Counters(st);
  const last = st.s1.last;
  const restorable = st.s1.versions.filter((v) => v.id === "s1@1" || v.status === "promoted");
  const sel = h("select", {}, restorable.map((v) => h("option", { value: v.id, selected: v.id === st.s1.active }, v.id)));
  replace($("#s1"),
    h("div", { class: "s1-head" }, h("span", { class: "muted" }, "Active version "), h("strong", { class: "mono" }, st.s1.active),
      h("span", { class: "muted small" }, ` · ${st.s1.memorySize} memory questions`)),
    h("div", { class: "counters" },
      [["flags", c.flags], ["good flags", c.goodFlags], ["false alarms", c.falseAlarms], ["misses", c.misses], ["repeats", c.repeats]].map(([k, n]) =>
        h("div", { class: "counter" }, h("div", { class: "counter-n" }, String(n)), h("div", { class: "counter-k" }, String(k))))),
    last ? h("div", { class: `s1-last ${last.outcome}` },
      h("div", {}, h("strong", {}, pretty(last.outcome)), last.candidate ? ` ${last.candidate}` : "", ` → active ${last.active}`),
      last.gate ? h("div", { class: "small mono" }, `gate: G ${last.gate.G2}/${last.gate.G} · F ${last.gate.F2}/${last.gate.F} · M ${last.gate.M2}/${last.gate.M}`) : null,
      last.rationale ? h("p", { class: "small" }, last.rationale) : null,
      last.errors?.length ? h("p", { class: "small error-text" }, last.errors.join("; ")) : null)
      : h("div", { class: "muted small" }, "No rewrite yet: System 2 rewrites System 1 after enough false alarms or misses."),
    h("div", { class: "row" }, h("span", { class: "muted small" }, "Roll back to "), sel,
      h("button", { onclick: () => run(() => api.rollback(sel.value), `Rolled back to ${sel.value}`) }, "Roll back")));
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
  const type = h("select", { class: "q-type" }, ["noul", "choice", "score"].map((t) => h("option", { value: t, selected: q.type === t }, t)));
  const hint = h("div", { class: "muted small q-hint" });
  const setHint = () => {
    hint.textContent = type.value === "choice" ? "one option per line: key: description (include none or other…)"
      : type.value === "score" ? "one level per line, lowest first (2–10)" : "optional: true: … and false: … lines";
  };
  setHint();
  type.addEventListener("change", setHint);
  const row = h("div", { class: "q-row" },
    h("div", { class: "row" },
      h("input", { class: "q-id mono", value: id, "aria-label": "Question id (snake_case)" }), type,
      h("button", { class: "link-button danger", onclick: () => { row.remove(); editorTouched = true; } }, "Remove")),
    h("textarea", { class: "q-instructions", rows: 2, "aria-label": "Instructions" }, q.instructions),
    h("textarea", { class: "q-criteria mono", rows: q.type === "noul" ? 2 : 4, "aria-label": "Criteria" }, criteriaText(q)),
    hint);
  row.addEventListener("input", () => { editorTouched = true; });
  return row;
}

function readEditor(base: LabelSet): LabelSet {
  const questions: Record<string, LabelQuestion> = {};
  document.querySelectorAll<HTMLElement>("#label-questions .q-row").forEach((row) => {
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
  const set = st.labels.set;
  if (!set) return;
  if (!force && (editorTouched || editorVersion === st.labels.version)) return;
  editorVersion = st.labels.version;
  editorTouched = false;
  const stories = h("textarea", { id: "stories", rows: 3, placeholder: "Tonight's stories, one headline per line" }, st.labels.stories.join("\n"));
  replace($("#labels"),
    h("div", { class: "row" }, h("span", { class: "muted small" }, "Version "), h("span", { class: "mono small" }, st.labels.version)),
    h("label", { class: "small muted" }, "Stories", stories),
    h("div", { class: "row" }, h("button", {
      onclick: () => run(async () => {
        const r = await api.putStories(stories.value.split("\n").map((x) => x.trim()).filter(Boolean));
        st.labels.stories = stories.value.split("\n").map((x) => x.trim()).filter(Boolean);
        st.labels.version = r.version;
      }, "Stories saved: they apply from the next segment"),
    }, "Save stories")),
    h("label", { class: "small muted" }, "Prefix", h("input", { id: "label-prefix", value: set.prefix })),
    h("div", { id: "label-questions" }, Object.entries(set.questions).map(([id, q]) => questionRow(id, q))),
    h("div", { class: "row" },
      h("button", { onclick: () => { $("#label-questions")!.append(questionRow("new_question", { type: "noul", instructions: "A speaker in the current segment …" })); editorTouched = true; } }, "Add question"),
      h("button", {
        class: "primary", onclick: () => run(async () => {
          const next = readEditor(set);
          const r = await api.putLabels(next);
          st.labels.set = next;
          st.labels.version = r.version;
          editorTouched = false;
          editorVersion = "";
          renderLabels(st, true);
        }, "Label set applied from the next segment"),
      }, "Apply"),
      h("button", { onclick: () => run(async () => { const r = await api.relabel(); toast(`Relabelling ${r.segments} segments in the background`, "ok"); }) }, "Relabel closed segments")),
    h("p", { class: "muted small" }, "The boundary question is calibrated and cannot change live."));
}

// ---------- accounting and stats ----------

export function renderCost(st: State) {
  const c = st.cost;
  const pct = Math.min(100, (c.session / (c.sessionCapUsd || 5)) * 100);
  replace($("#cost"),
    h("div", { class: "cost-line" }, h("strong", {}, usd(c.session)), h("span", { class: "muted" }, ` of ${usd(c.sessionCapUsd || 5)} cap`)),
    h("div", { class: "meter-bar small" }, h("div", { class: `meter-fill${pct > 80 ? " warn" : ""}`, style: `width:${pct}%` })),
    h("div", { class: "muted small" }, `transcription ${usd(c.transcription)} · Jev ${usd(c.jev)} · System 2 ${usd(c.s2)}`),
    st.budgetExhausted ? h("div", { class: "error-text small" }, `Budget exhausted: ${st.budgetExhausted}`) : null);
}

export function renderStats(st: State) {
  const s = st.stats;
  if (!s) return replace($("#stats"), h("div", { class: "empty" }, "Stats arrive every minute and at the end of the show."));
  const fc = s.factcheck ?? {};
  const verdicts = Object.entries(fc.verdicts ?? {}).filter(([, n]) => (n as number) > 0).map(([k, n]) => `${VERDICT_LABEL[k] ?? k} ${n}`).join(" · ");
  replace($("#stats"),
    h("div", { class: "rogan" }, h("span", { class: "rogan-n" }, `${Math.round((s.roganIndex ?? 0) * 100)}%`), h("span", { class: "muted" }, " Rogan index (personal life + other topics)")),
    h("table", { class: "stats-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Speaker"), h("th", {}, "Talk"), h("th", {}, "Disagreements"), h("th", {}, "Hype"))),
      h("tbody", {}, (s.speakers ?? []).map((sp: any) => h("tr", {},
        h("td", {}, speakerName(st, sp.speakerId)), h("td", {}, clock(sp.talkMs)), h("td", {}, String(sp.disagreements)),
        h("td", {}, sp.hype === null ? "–" : `${sp.hype.toFixed(1)} / 4`))))),
    (["predictions", "recommendations", "clips"] as const).map((k) => (s[k] ?? []).length
      ? h("div", {}, h("div", { class: "small muted" }, pretty(k)), h("ul", { class: "small" }, s[k].map((x: any) => h("li", {}, h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); jumpToSegment(x.segmentId); } }, x.text || x.segmentId)))))
      : null),
    h("div", { class: "small" }, `Fact-check: ${fc.flagged ?? 0} flagged · ${fc.researched ?? 0} researched · ${verdicts || "no verdicts"} · ${fc.repeats ?? 0} repeats · ${fc.duplicates ?? 0} duplicates · ${fc.dropped ?? 0} dropped · ${fc.falseAlarms ?? 0} false alarms · ${fc.misses ?? 0} misses · System 1 versions ${fc.promoted ?? 0} promoted, ${fc.rejected ?? 0} rejected`));
}

export function renderErrors(st: State) {
  if (st.errors.length === 0) return replace($("#errors"), h("div", { class: "empty" }, "No errors."));
  replace($("#errors"), st.errors.slice(0, 8).map((e) => h("div", { class: "err small" }, h("span", { class: "mono" }, e.component), ` ${e.message}`)));
}

// ---------- recordings library ----------

let libraryQuery = "";
let libraryTimer: number | undefined;

function when(iso: string | null, id: string): string {
  if (!iso) return id;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function recordingRow(st: State, r: SessionSummary, refresh: () => void): HTMLElement {
  const current = st.session?.id === r.id;
  const running = st.session?.status === "running" || st.session?.status === "ending";
  return h("div", { class: `rec${current ? " current" : ""}` },
    h("div", { class: "rec-head" },
      h("strong", {}, r.name ?? when(r.startedAt, r.id)),
      current ? h("span", { class: "badge repeat" }, st.session?.status === "archived" ? "viewing" : "current") : null,
      !r.ended && !current ? h("span", { class: "badge disputed", title: "No session.ended: the recording stopped abruptly" }, "incomplete") : null),
    h("div", { class: "muted small" },
      [r.name ? when(r.startedAt, r.id) : null, clock(r.durationMs), r.mode, `${r.utterances} lines`, r.speakers.join(", ") || null,
        r.claims ? `${r.claims} claims` : null, usd(r.costUsd)].filter(Boolean).join(" · ")),
    (r.matches ?? []).map((m) => h("div", { class: "rec-match small" }, h("span", { class: "mono" }, clock(m.startMs)), ` ${m.speaker}: `, m.snippet)),
    h("div", { class: "row" },
      h("button", {
        onclick: () => {
          const name = prompt("Name this recording:", r.name ?? "");
          if (name !== null) void run(async () => { await api.renameSession(r.id, name); refresh(); });
        },
      }, "Rename"),
      h("button", { disabled: running, title: "Show it exactly as recorded; nothing is re-processed or spent", onclick: () => run(() => api.openSession(r.id)) }, "Open"),
      h("button", {
        disabled: running, title: "Run the audio through the pipeline again (costs money: transcription, Jev, System 2)",
        onclick: () => { if (confirm(`Replay "${r.name ?? r.id}" through the pipeline at real-time speed? This calls the APIs again (about ${usd(r.costUsd || 0.02)}).`)) void run(() => api.replaySession(r.id, 1)); },
      }, "Replay")));
}

export async function renderRecordings(st: State) {
  const box = $("#recordings");
  if (!box) return;
  const refresh = () => void renderRecordings(st);
  let search = box.querySelector<HTMLInputElement>("input.rec-search");
  if (!search) {
    search = h("input", { class: "rec-search", type: "search", placeholder: "Search names and transcripts…", value: libraryQuery });
    search.addEventListener("input", () => {
      libraryQuery = search!.value;
      clearTimeout(libraryTimer);
      libraryTimer = window.setTimeout(refresh, 250);
    });
    replace(box, search, h("div", { class: "rec-list" }));
  }
  const list = box.querySelector(".rec-list")!;
  try {
    const rows = await api.sessions(libraryQuery.trim());
    replace(list, rows.length ? rows.map((r) => recordingRow(st, r, refresh))
      : h("div", { class: "empty" }, libraryQuery ? "No recording matches." : "No recordings yet."));
  } catch (e) {
    replace(list, h("div", { class: "error-text small" }, e instanceof Error ? e.message : String(e)));
  }
}
