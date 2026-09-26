// The thinking tabs beside the fact-checks, written for an audience watching the demo:
//   - "Fast · slow thinking": System 1 (Jev) and System 2 side by side, a funnel from every line heard to the few
//     verdicts, and one row per claim showing the handoff: Jev flagged it fast and cheap, System 2 researched it.
//   - "Jev log": every call to Jev in plain words (what it was asked, what it answered, what the app did next), with
//     the exact HTTP request and response a click away.
import { $, clock, h, pretty, replace } from "./dom.js";
import { featuresOf, type CallRow, type Claim, type State, type SystemId } from "./state.js";

const JEV_URL = "https://openrouter.ai/api/alpha/decisions";
const S2_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Dollars at the precision a single call needs: $0.000036, $0.0077, $1.24. */
export function money(n: number): string {
  if (!n) return "$0";
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 0.1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Session time of a call, from its wall-clock timestamp. */
function when(st: State, row: CallRow): string {
  const start = st.session?.startedAt ? Date.parse(st.session.startedAt) : 0;
  const t = Date.parse(row.at);
  return start && t >= start ? clock(t - start) : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Rows the reader expanded, by key, so a live re-render keeps them open. */
const expanded = new Set<string>();
const keyOf = (r: CallRow) => `${r.kind}|${r.at}|${r.id ?? ""}|${r.purpose}`;
let rerender: () => void = () => {};
function toggle(key: string) {
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  rerender();
}

/** What each kind of Jev call is for, in words the audience knows. */
const PURPOSE: Record<string, { label: string; about: string }> = {
  utterance: { label: "Line check", about: "Every line said is checked: is it a new topic, and is it a public fact worth fact-checking?" },
  segment: { label: "Topic labels", about: "Each closed stretch of conversation is labelled for the timeline: subject, mode, heat, hype, and moments." },
  gate: { label: "Rewrite test", about: "System 2 proposed new questions; Jev re-answers earlier lines with them to test the rewrite before it is used." },
  relabel: { label: "Relabel", about: "A closed stretch is labelled again with the host's edited questions." },
  research: { label: "Research", about: "System 2 searches the web and writes a verdict with sources." },
  audit: { label: "Audit", about: "System 2 looks over lines System 1 did not flag, for claims it missed." },
  rewrite: { label: "Rewrite", about: "System 2 rewrites System 1's questions to fix false alarms and misses." },
};
const purposeOf = (p: string) => PURPOSE[p] ?? { label: pretty(p), about: "" };

/** Plain-language names for the questions the audience sees most. */
const QUESTION: Record<string, string> = {
  boundary: "New topic?", claim: "Checkable claim?", public: "About the public world?", claim_type: "Kind of claim",
  hedged: "Speaker unsure?", worth: "Worth checking?", subject: "Subject", mode: "Mode", heat: "Heat", hype: "Hype",
  disagreement: "Disagreement?", humour: "Humour?", hot_take: "Hot take?", prediction: "Prediction?", recommendation: "Recommendation?",
  clip_worthy: "Clip-worthy?",
};
const questionName = (id: string) => QUESTION[id] ?? (id.startsWith("known_") ? `Repeat of claim ${id.slice(6)}?` : `${pretty(id)}?`);

/** One answer as words: "No (2% yes)", "event (39%)", "0.6 of 4". */
function answerText(a: any): string {
  if (!a) return "–";
  if (a.type === "noul") return a.noul >= 0.5 ? `Yes (${pct(a.noul)})` : `No (${pct(a.noul)} yes)`;
  if (a.type === "choice") return `${pretty(a.choice)} (${pct(a.confidence ?? a.probabilities?.[a.choice] ?? 0)} sure)`;
  if (a.type === "score") {
    const max = Math.max(1, Object.keys(a.probabilities ?? a.legend ?? {}).length - 1);
    return `${a.score.toFixed(1)} of ${max}`;
  }
  return JSON.stringify(a);
}

function answer(id: string, a: any, strong = false): HTMLElement {
  const yes = a?.type === "noul" && a.noul >= 0.5;
  return h("span", { class: `qa${yes ? " yes" : ""}${strong ? " key" : ""}` }, h("span", { class: "qa-q" }, questionName(id)), h("b", {}, answerText(a)));
}

/** The claim a line produced, if any. */
function claimFor(st: State, utteranceId: string | undefined): Claim | undefined {
  if (!utteranceId) return undefined;
  for (const c of st.claims.values()) if (c.utteranceId === utteranceId) return c;
  return undefined;
}

const VERDICT_WORD: Record<string, string> = {
  supported: "Supported", contradicted: "False", misleading: "Misleading", unverifiable: "Unverifiable", not_a_claim: "Not a claim",
};

/** Memory questions ("is this a repeat of claim c_7?"), one per claim already flagged, folded into one line. */
function memory(r: CallRow): HTMLElement | null {
  const known = Object.entries(r.answers ?? {}).filter(([id]) => id.startsWith("known_")) as [string, any][];
  if (known.length === 0) return null;
  const hits = known.filter(([, a]) => a?.noul >= 0.6);
  return h("p", { class: "note" }, `Plus ${known.length} memory question${known.length === 1 ? "" : "s"}, one per claim already flagged ("is this a repeat of it?"): `,
    hits.length ? h("b", {}, `a repeat of ${hits.map(([id]) => id.slice(6)).join(", ")}`) : "no repeat found.");
}

/** What the app did with a line check, in words: the part that makes the call meaningful. */
function outcome(st: State, r: CallRow): HTMLElement | null {
  if (r.purpose !== "utterance") return null;
  if (!r.ok) return h("span", { class: "next bad" }, "→ No answer in time: this line is not fact-checked");
  const c = claimFor(st, r.utterance_id);
  if (c) {
    const v = c.verdict ? ` · verdict: ${VERDICT_WORD[c.verdict.verdict] ?? c.verdict.verdict}` : c.status === "dropped" ? " · dropped" : " · researching";
    return h("span", { class: "next go" }, `→ Flagged: sent to System 2${v}`);
  }
  const known = Object.entries(r.answers ?? {}).find(([id, a]: [string, any]) => id.startsWith("known_") && a?.noul >= 0.6);
  if (known) return h("span", { class: "next" }, `→ Already checked: a repeat of claim ${known[0].slice(6)}`);
  return h("span", { class: "next" }, "→ Not flagged: nothing sent to System 2");
}

/** What Jev was shown, as one line. */
function shown(r: CallRow): string {
  const s = r.state;
  if (s?.new_utterance) return `${s.new_utterance.speaker}: “${s.new_utterance.text}”`;
  if (Array.isArray(s?.segment)) {
    const first = s.segment[0];
    return `${s.segment.length} line${s.segment.length === 1 ? "" : "s"} of conversation${first ? `, from ${first.speaker}: “${first.text}”` : ""}`;
  }
  return "";
}

/** The answers worth showing collapsed: the decisive ones for a line check, the labels for a topic. */
function keyAnswers(r: CallRow): [string, any][] {
  const a = Object.entries(r.answers ?? {});
  if (r.purpose === "utterance" || r.purpose === "gate") {
    const order = ["claim", "public", "worth", "boundary"];
    return order.filter((id) => r.answers?.[id]).map((id) => [id, r.answers![id]]);
  }
  return a.filter(([id]) => ["subject", "mode", "heat", "hype"].includes(id))
    .concat(a.filter(([, v]: [string, any]) => v?.type === "noul" && v.noul >= 0.5));
}

/** An HTTP exchange, as the app sent and received it. */
function http(method: string, url: string, request: unknown, status: string, response: unknown, note?: string): HTMLElement {
  return h("div", { class: "http" },
    h("div", { class: "http-line" }, h("b", {}, method), " ", url),
    h("pre", { class: "json" }, typeof request === "string" ? request : JSON.stringify(request, null, 2)),
    h("div", { class: "http-line resp" }, h("b", {}, status)),
    h("pre", { class: "json" }, typeof response === "string" ? response : JSON.stringify(response, null, 2)),
    note ? h("p", { class: "note" }, note) : null);
}

function jevRow(st: State, r: CallRow): HTMLElement {
  const key = keyOf(r);
  const open = expanded.has(key);
  const p = purposeOf(r.purpose);
  const questions = r.questions
    ? Object.fromEntries(Object.entries(r.questions))
    : Object.fromEntries((r.question_ids ?? []).map((id) => [id, st.calls.questions[id] ?? "(wording not recorded for this call)"]));
  return h("article", { class: `call s1${r.ok ? "" : " failed"}${open ? " open" : ""}` },
    h("button", { class: "call-head", "aria-expanded": String(open), onclick: () => toggle(key), title: p.about },
      h("span", { class: "t" }, when(st, r)),
      h("span", { class: "purpose" }, p.label),
      h("span", { class: "subject" }, shown(r)),
      h("span", { class: "lat" }, seconds(r.latency_ms)),
      h("span", { class: "cost" }, money(r.cost_usd))),
    h("div", { class: "qa-row" }, r.ok ? keyAnswers(r).map(([id, a]) => answer(id, a, true)) : h("span", { class: "error-text" }, r.error ?? "The call failed.")),
    outcome(st, r),
    open ? h("div", { class: "call-detail" },
      h("p", { class: "note" }, p.about),
      h("h4", {}, `Every answer · ${Object.keys(r.answers ?? {}).length} questions asked at once`),
      h("div", { class: "qa-row all" }, Object.entries(r.answers ?? {}).filter(([id]) => !id.startsWith("known_")).map(([id, a]) => answer(id, a))),
      memory(r),
      h("h4", {}, "The HTTP request and response"),
      http("POST", JEV_URL, { model: r.model_returned ?? "typesafe/jev-1.13", state: r.state, questions },
        r.ok ? `200 OK · ${seconds(r.latency_ms)} · ${money(r.cost_usd)}` : `Failed · ${r.error ?? ""}`,
        r.ok ? { answers: r.answers, usage: r.usage } : { error: r.error },
        r.questions ? undefined : "The question wording is shown in full only for calls made while this page was open.")) : null);
}

function s2Row(st: State, r: CallRow): HTMLElement {
  const key = keyOf(r);
  const open = expanded.has(key);
  const p = purposeOf(r.purpose);
  let reply: any = null;
  try { reply = r.response ? JSON.parse(r.response) : null; } catch { reply = r.response ?? null; }
  const claim = r.claim_id ? st.claims.get(r.claim_id) : undefined;
  const verdict = reply && typeof reply === "object" && reply.verdict ? VERDICT_WORD[reply.verdict] ?? reply.verdict : null;
  const u = r.usage;
  return h("article", { class: `call s2${r.ok ? "" : " failed"}${open ? " open" : ""}` },
    h("button", { class: "call-head", "aria-expanded": String(open), onclick: () => toggle(key), title: p.about },
      h("span", { class: "t" }, when(st, r)),
      h("span", { class: "purpose" }, p.label),
      h("span", { class: "subject" }, claim ? `“${claim.text}”` : p.about),
      h("span", { class: "lat" }, seconds(r.latency_ms)),
      h("span", { class: "cost" }, money(r.cost_usd))),
    verdict ? h("span", { class: "next go" }, `→ Verdict: ${verdict}`) : null,
    open ? h("div", { class: "call-detail" },
      h("p", { class: "note" }, `${p.about}${u ? ` It read ${u.prompt_tokens.toLocaleString()} tokens and wrote ${u.completion_tokens.toLocaleString()}${u.reasoning_tokens ? `, ${u.reasoning_tokens.toLocaleString()} of them reasoning` : ""}.` : ""}`),
      h("h4", {}, "The HTTP request and response"),
      r.request
        ? http("POST", S2_URL,
          { model: r.model_returned ?? "", messages: [{ role: "system", content: `(${r.request.system.length.toLocaleString()} characters, below)` }, { role: "user", content: r.request.user }], ...(r.web_engine ? { plugins: [{ id: "web", engine: r.web_engine }] } : {}) },
          r.ok ? `200 OK · ${seconds(r.latency_ms)} · ${money(r.cost_usd)}` : `Failed · ${r.error ?? ""}`, reply ?? r.error ?? "")
        : h("p", { class: "note" }, "This call was recorded before prompts were saved with each call."),
      r.request ? h("details", {}, h("summary", {}, "System prompt"), h("pre", { class: "json" }, r.request.system)) : null) : null);
}

/** Newest first, capped; keeps the reader's place when new calls arrive above it. */
function feed(box: HTMLElement | null, st: State, rows: CallRow[], render: (st: State, r: CallRow) => HTMLElement, empty: string) {
  if (!box) return;
  const list = rows.slice(-200).reverse();
  const before = box.scrollHeight;
  const top = box.scrollTop;
  replace(box, list.length ? list.map((r) => render(st, r)) : h("div", { class: "empty" }, empty));
  if (top > 0 && box.classList.contains("scroll")) box.scrollTop = top + (box.scrollHeight - before);
}

// ---------- the Fast · slow thinking tab ----------

function totals(rows: CallRow[]) {
  const ok = rows.filter((r) => r.ok);
  const cost = rows.reduce((n, r) => n + (r.cost_usd || 0), 0);
  return { n: rows.length, cost, avgCost: ok.length ? cost / ok.length : 0, avgMs: ok.length ? ok.reduce((n, r) => n + r.latency_ms, 0) / ok.length : 0 };
}

const modelName = (model: string) => (model.split("/").pop() ?? "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Gpt (\d+)/, "GPT-$1");

function node(st: State, sys: SystemId): HTMLElement {
  const t = totals(sys === "s1" ? st.calls.s1 : st.calls.s2);
  const busy = st.calls.active[sys] > 0;
  const model = st.calls.models[sys] ?? (sys === "s1" ? st.calls.s1.at(-1)?.model_returned : st.calls.s2.at(-1)?.model_returned) ?? "";
  return h("div", { class: `sys ${sys}${busy ? " busy" : ""}` },
    h("span", { class: "sys-k" }, sys === "s1" ? "System 1 · fast" : "System 2 · slow"),
    h("span", { class: "sys-name" }, sys === "s1" ? "Jev" : modelName(model) || "System 2"),
    h("span", { class: "sys-model" }, model),
    h("span", { class: "sys-role" }, sys === "s1" ? "Judges every line in under a second" : "Researches only what System 1 flags"),
    h("span", { class: "sys-state" }, h("i", {}), busy ? "Thinking" : "Idle"),
    h("span", { class: "sys-stats" },
      h("span", {}, h("b", {}, String(t.n)), "calls"),
      h("span", {}, h("b", {}, t.n ? seconds(t.avgMs) : "–"), "each, on average"),
      h("span", {}, h("b", {}, t.n ? money(t.avgCost) : "–"), "per call"),
      h("span", {}, h("b", {}, money(t.cost)), "in total")));
}

/** From every line heard to the few verdicts: where each system does its work. */
function funnel(st: State): HTMLElement {
  const lines = st.utterances.size;
  const judged = st.calls.s1.filter((r) => r.purpose === "utterance").length;
  const claims = [...st.claims.values()];
  const research = st.calls.s2.filter((r) => r.purpose === "research");
  const verdicts = claims.filter((c) => c.verdict);
  const counts = (k: string) => verdicts.filter((c) => c.verdict!.verdict === k).length;
  const real = [["False", counts("contradicted")], ["Misleading", counts("misleading")], ["Supported", counts("supported")]].filter(([, n]) => n) as [string, number][];
  const s1 = totals(st.calls.s1.filter((r) => r.purpose === "utterance"));
  const s2 = totals(research);
  const step = (sys: string, n: number | string, label: string, sub: string) =>
    h("div", { class: `step ${sys}` }, h("b", {}, String(n)), h("span", { class: "label" }, label), h("span", { class: "sub" }, sub));
  return h("div", { class: "funnel" },
    step("", lines, "lines heard", "transcribed"),
    step("s1", judged, "checked by Jev", judged ? `${money(s1.cost)} · ${seconds(s1.avgMs)} each` : "System 1"),
    step("s1", claims.length, "flagged", "public facts worth checking"),
    step("s2", research.length, "researched", research.length ? `${money(s2.cost)} · ${seconds(s2.avgMs)} each` : "System 2"),
    step("s2", verdicts.length, "verdicts", real.length ? real.map(([k, n]) => `${n} ${k.toLowerCase()}`).join(" · ") : "none yet"));
}

/** One claim's journey: Jev flagged it, System 2 researched it, the verdict. */
function handoff(st: State, c: Claim): HTMLElement {
  const jev = [...st.calls.s1].reverse().find((r) => r.purpose === "utterance" && r.utterance_id === c.utteranceId);
  const s2 = [...st.calls.s2].reverse().find((r) => r.purpose === "research" && r.claim_id === c.id);
  const key = `handoff|${c.id}`;
  const open = expanded.has(key);
  const v = c.verdict ? VERDICT_WORD[c.verdict.verdict] ?? c.verdict.verdict : c.status === "dropped" ? "Dropped" : c.status === "researching" ? "Researching…" : "Queued";
  return h("article", { class: `handoff${open ? " open" : ""}` },
    h("button", { class: "handoff-head", "aria-expanded": String(open), onclick: () => toggle(key) },
      h("span", { class: "claim" }, `“${c.text}”`),
      h("span", { class: "hops" },
        h("span", { class: "hop s1" }, "Jev", h("small", {}, jev ? `${seconds(jev.latency_ms)} · ${money(jev.cost_usd)}` : "flagged")),
        h("span", { class: "arrow" }, "→"),
        h("span", { class: "hop s2" }, modelName(st.calls.models.s2 ?? "") || "System 2", h("small", {}, s2 ? `${seconds(s2.latency_ms)} · ${money(s2.cost_usd)}` : c.status === "dropped" ? "not researched" : "…")),
        h("span", { class: "arrow" }, "→"),
        h("span", { class: `hop verdict v-${c.verdict?.verdict ?? c.status}` }, v))),
    open ? h("div", { class: "call-detail" },
      jev ? [h("h4", {}, "System 1 · Jev flagged it"), jevRow(st, jev)] : null,
      s2 ? [h("h4", {}, "System 2 · researched it"), s2Row(st, s2)] : null) : null);
}

function thinking(st: State): HTMLElement {
  const a = totals(st.calls.s1);
  const b = totals(st.calls.s2);
  const times = Math.round((a.n * b.avgCost) / Math.max(a.cost, 1e-9));
  const busy2 = st.calls.active.s2 > 0;
  const claims = [...st.claims.values()].sort((x, y) => (y.activity ?? "").localeCompare(x.activity ?? ""));
  return h("div", { class: "think-diagram" },
    h("div", { class: "sys-row" },
      node(st, "s1"),
      h("div", { class: `links${busy2 ? " flowing" : ""}` },
        h("span", { class: "link fwd" }, h("span", {}, "flags claims"), h("i", {})),
        h("span", { class: "link back" }, h("i", {}), h("span", {}, "rewrites its questions"))),
      node(st, "s2")),
    a.n && b.n && b.avgCost > 0
      ? h("div", { class: "value" },
        h("div", { class: "value-n" }, h("b", {}, `${times.toLocaleString()}×`), h("span", {}, "cheaper with System 1")),
        h("p", {}, "Jev made ", h("b", {}, `${a.n} judgments`), " for ", h("b", {}, money(a.cost)), ". Asking System 2 for each would have cost about ",
          h("b", {}, money(a.n * b.avgCost)), ` and taken ${clock(a.n * b.avgMs)} of model time.`))
      : null,
    h("div", { class: "feed-h" }, "From every line to a verdict"),
    funnel(st),
    h("div", { class: "feed-h" }, `Claims handed from System 1 to System 2${claims.length ? ` · ${claims.length}` : ""}`),
    claims.length
      ? h("div", { class: "handoffs" }, claims.slice(0, 60).map((c) => handoff(st, c)))
      : h("p", { class: "empty" }, "When Jev flags a public fact worth checking, it appears here with its trip to System 2 and back."));
}

/** Renders whichever thinking tab is showing. */
export function renderThinking(st: State) {
  rerender = () => renderThinking(st);
  const f = featuresOf(st);
  if (st.session && !f.factcheck && !f.labels) {
    const off = "Jev is off for this session: fact-checking and labels were turned off when it started, so nothing is asked.";
    replace($("#jev-log"), h("div", { class: "empty" }, off));
    replace($("#think"), h("div", { class: "empty" }, off));
    replace($("#jev-count"), "");
    return;
  }
  if (!$("#pane-jev")?.hidden) {
    feed($("#jev-log"), st, st.calls.s1, jevRow,
      "Every call to Jev appears here as it happens: what it was asked, what it answered, and what the app did next.");
  }
  if (!$("#pane-think")?.hidden) {
    replace($("#think"), f.factcheck ? thinking(st)
      : h("div", { class: "empty" }, "Fact-checking is off for this session, so System 1 and System 2 do not run. Jev still labels the timeline (see the Jev log)."));
  }
  replace($("#jev-count"), st.calls.s1.length ? String(st.calls.s1.length) : "");
}
