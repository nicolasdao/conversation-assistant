// The thinking tabs beside the fact-checks: a live log of every Jev (System 1) call, and "Fast · slow thinking", a
// diagram of System 1 and System 2 that lights up while each one is working, with each system's own call feed.
import { $, clock, h, pretty, replace } from "./dom.js";
import type { CallRow, State, SystemId } from "./state.js";

/** Dollars at the precision a single call needs: $0.000036, $0.0077, $1.24. */
export function money(n: number): string {
  if (!n) return "$0";
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 0.1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Session time of a call, from its wall-clock timestamp. */
function when(st: State, row: CallRow): string {
  const start = st.session?.startedAt ? Date.parse(st.session.startedAt) : 0;
  const t = Date.parse(row.at);
  return start && t >= start ? clock(t - start) : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Rows the reader expanded, by key, so a live re-render keeps them open. */
const expanded = new Set<string>();
const keyOf = (r: CallRow) => `${r.kind}|${r.at}|${r.id ?? ""}|${r.purpose}`;

function json(value: unknown): HTMLElement {
  return h("pre", { class: "json" }, JSON.stringify(value, null, 2));
}

// ---------- System 1: Jev ----------

/** One answer as a compact chip: noul as a %, choice as its label and confidence, score as level / max. */
function answerChip(id: string, a: any): HTMLElement {
  if (!a) return h("span", { class: "ans" }, id, h("b", {}, "–"));
  if (a.type === "noul") {
    const p = Math.round(a.noul * 100);
    return h("span", { class: `ans noul${a.noul >= 0.5 ? " yes" : ""}`, title: `${id}: probability of yes ${p}%` },
      id, h("i", { class: "meter" }, h("i", { style: `width:${p}%` })), h("b", {}, `${p}%`));
  }
  if (a.type === "choice") {
    const conf = Math.round((a.confidence ?? a.probabilities?.[a.choice] ?? 0) * 100);
    return h("span", { class: "ans choice", title: `${id}: ${a.choice}, confidence ${conf}%` }, id, h("b", {}, `${pretty(a.choice)} · ${conf}%`));
  }
  if (a.type === "score") {
    const max = Math.max(1, Object.keys(a.probabilities ?? a.legend ?? {}).length - 1);
    return h("span", { class: "ans score", title: `${id}: level ${a.score.toFixed(2)} of 0–${max}` }, id, h("b", {}, `${a.score.toFixed(1)} / ${max}`));
  }
  return h("span", { class: "ans" }, id, h("b", {}, JSON.stringify(a)));
}

/** A one-line summary of what Jev was shown. */
function stateSummary(state: any): string {
  if (state?.new_utterance) return `${state.new_utterance.speaker}: “${state.new_utterance.text}”`;
  if (Array.isArray(state?.segment)) {
    const first = state.segment[0];
    return `Segment of ${state.segment.length} line${state.segment.length === 1 ? "" : "s"}${first ? `, from ${first.speaker}: “${first.text}”` : ""}`;
  }
  return typeof state === "string" ? state : JSON.stringify(state ?? "").slice(0, 160);
}

function lines(title: string, rows: any[]): HTMLElement | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return h("div", { class: "ctx" }, h("div", { class: "ctx-h" }, `${title} · ${rows.length} line${rows.length === 1 ? "" : "s"}`),
    rows.map((l) => h("div", { class: "ctx-l" }, h("b", {}, `${l.speaker}: `), l.text)));
}

/** The request, readable: the new line and its context, then each question with its wording when known. */
function jevRequest(st: State, r: CallRow): HTMLElement {
  const s = r.state;
  const known = { ...st.calls.questions, ...(r.questions ?? {}) };
  return h("div", { class: "req" },
    s?.new_utterance ? h("div", { class: "ctx now" }, h("div", { class: "ctx-h" }, "New utterance"),
      h("div", { class: "ctx-l" }, h("b", {}, `${s.new_utterance.speaker}: `), s.new_utterance.text,
        (s.new_utterance.tags ?? []).map((t: string) => h("span", { class: "tag-loud" }, t)))) : null,
    lines("Current segment", s?.current_segment),
    lines("Segment", s?.segment),
    lines("Previous segment", s?.previous_segment),
    !s?.new_utterance && !Array.isArray(s?.segment) ? json(s) : null,
    h("div", { class: "qs" }, (r.question_ids ?? []).map((id) =>
      h("div", { class: "q-line" }, h("code", {}, id), known[id] ? h("span", { class: "q-type" }, known[id]!.type) : null,
        h("span", { class: "q-text" }, known[id]?.instructions ?? (id.startsWith("known_") ? "Memory question: is this a claim already checked?" : ""))))));
}

/** The response, detailed: each answer with its probabilities. */
function jevResponse(r: CallRow): HTMLElement {
  if (!r.answers) return h("p", { class: "error-text" }, r.error ?? "No answers.");
  return h("div", { class: "resp" }, Object.entries(r.answers).map(([id, a]: [string, any]) => {
    const probs = a?.probabilities ? Object.entries<number>(a.probabilities).sort((x, y) => y[1] - x[1]).filter(([, p]) => p > 0) : [];
    return h("div", { class: "resp-row" }, answerChip(id, a),
      probs.length ? h("span", { class: "probs" }, probs.slice(0, 4).map(([k, p]) =>
        h("span", {}, `${a.legend?.[k] ? `${k} ${a.legend[k]}` : pretty(k)} ${Math.round(p * 100)}%`))) : null);
  }));
}

function jevCall(st: State, r: CallRow): HTMLElement {
  const key = keyOf(r);
  const open = expanded.has(key);
  const u = r.usage;
  return h("article", { class: `call s1${r.ok ? "" : " failed"}${open ? " open" : ""}` },
    h("button", { class: "call-head", "aria-expanded": String(open), onclick: () => toggle(key) },
      h("span", { class: "t" }, when(st, r)),
      h("span", { class: "purpose" }, pretty(r.purpose)),
      h("span", { class: "subject" }, stateSummary(r.state)),
      h("span", { class: "lat" }, seconds(r.latency_ms)),
      h("span", { class: "cost" }, money(r.cost_usd))),
    r.ok ? h("div", { class: "ans-row" }, Object.entries(r.answers ?? {}).map(([id, a]) => answerChip(id, a)))
      : h("p", { class: "error-text" }, r.error ?? "The call failed."),
    open ? h("div", { class: "call-detail" },
      h("h4", {}, "Request"), jevRequest(st, r),
      h("h4", {}, "Response"), jevResponse(r),
      h("div", { class: "call-meta" },
        [r.model_returned, u ? `${u.input_tokens} tokens in · ${u.output_tokens} out` : null, `${r.attempts} attempt${r.attempts === 1 ? "" : "s"}`,
          r.question_set_version, r.request_hash ? `request ${r.request_hash}` : null].filter(Boolean).join(" · ")),
      h("details", {}, h("summary", {}, "Raw JSON"), json({ state: r.state, question_ids: r.question_ids, answers: r.answers, usage: r.usage }))) : null);
}

// ---------- System 2 ----------

function parsed(text: string | undefined): any {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function s2Call(st: State, r: CallRow): HTMLElement {
  const key = keyOf(r);
  const open = expanded.has(key);
  const u = r.usage;
  const reply = parsed(r.response);
  const claim = r.claim_id ? st.claims.get(r.claim_id) : undefined;
  const subject = r.purpose === "research" ? (claim ? `“${claim.text}”` : r.claim_id ?? "")
    : r.purpose === "audit" ? "Looking for claims System 1 missed" : r.purpose === "rewrite" ? "Rewriting System 1's questions" : "";
  const verdict = reply && typeof reply === "object" && reply.verdict ? String(reply.verdict) : null;
  return h("article", { class: `call s2${r.ok ? "" : " failed"}${open ? " open" : ""}` },
    h("button", { class: "call-head", "aria-expanded": String(open), onclick: () => toggle(key) },
      h("span", { class: "t" }, when(st, r)),
      h("span", { class: "purpose" }, pretty(r.purpose)),
      h("span", { class: "subject" }, subject),
      h("span", { class: "lat" }, seconds(r.latency_ms)),
      h("span", { class: "cost" }, money(r.cost_usd))),
    h("div", { class: "ans-row" },
      verdict ? h("span", { class: `ans verdict v-${verdict}` }, "verdict", h("b", {}, verdict === "contradicted" ? "false" : pretty(verdict))) : null,
      u ? h("span", { class: "ans" }, "tokens", h("b", {}, `${u.prompt_tokens} in · ${u.completion_tokens} out${u.reasoning_tokens ? ` (${u.reasoning_tokens} reasoning)` : ""}`)) : null,
      r.web_engine ? h("span", { class: "ans" }, "web search", h("b", {}, r.web_engine)) : null,
      !r.ok ? h("span", { class: "error-text" }, r.error ?? "The call failed.") : null),
    open ? h("div", { class: "call-detail" },
      h("h4", {}, "Request"),
      r.request ? [
        h("details", {}, h("summary", {}, `System prompt · ${r.request.system.length.toLocaleString()} characters`), h("pre", { class: "json" }, r.request.system)),
        h("pre", { class: "json" }, r.request.user)]
        : h("p", { class: "note" }, "This call was recorded before prompts were saved with each call."),
      h("h4", {}, "Response"),
      reply === null ? h("p", { class: "note" }, r.ok ? "No reply text recorded." : r.error ?? "The call failed.") : typeof reply === "string" ? h("pre", { class: "json" }, reply) : json(reply),
      h("div", { class: "call-meta" }, [r.model_returned, `${r.attempts} attempt${r.attempts === 1 ? "" : "s"}`, r.id].filter(Boolean).join(" · "))) : null);
}

// ---------- feeds ----------

let rerender: () => void = () => {};
function toggle(key: string) {
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  rerender();
}

/** Newest first, capped; keeps the reader's place when new calls arrive above it. */
function feed(box: HTMLElement | null, st: State, system: SystemId) {
  if (!box) return;
  const rows = (system === "s1" ? st.calls.s1 : st.calls.s2).slice(-200).reverse();
  const scroller = box.classList.contains("scroll") ? box : box.closest<HTMLElement>(".scroll") ?? box;
  const before = scroller.scrollHeight;
  const top = scroller.scrollTop;
  replace(box, rows.length
    ? rows.map((r) => (system === "s1" ? jevCall(st, r) : s2Call(st, r)))
    : h("div", { class: "empty" }, system === "s1"
      ? "Every Jev call appears here as it happens: what it was shown, what it was asked, and what it answered."
      : "System 2 is called only when System 1 flags a claim, for a periodic audit, or to rewrite System 1."));
  if (top > 0 && scroller === box) box.scrollTop = top + (box.scrollHeight - before);
}

// ---------- the Fast · slow thinking diagram ----------

let selected: SystemId = "s1";

function totals(rows: CallRow[]) {
  const ok = rows.filter((r) => r.ok);
  const cost = rows.reduce((n, r) => n + (r.cost_usd || 0), 0);
  return { n: rows.length, cost, avgCost: ok.length ? cost / ok.length : 0, avgMs: ok.length ? ok.reduce((n, r) => n + r.latency_ms, 0) / ok.length : 0 };
}

function node(st: State, sys: SystemId): HTMLElement {
  const t = totals(sys === "s1" ? st.calls.s1 : st.calls.s2);
  const busy = st.calls.active[sys] > 0;
  const model = st.calls.models[sys] ?? (sys === "s1" ? st.calls.s1.at(-1)?.model_returned : st.calls.s2.at(-1)?.model_returned) ?? "";
  // "openai/gpt-6-luna" reads as "GPT-6 Luna"
  const name = sys === "s1" ? "Jev"
    : (model.split("/").pop() ?? "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Gpt (\d+)/, "GPT-$1");
  return h("button", {
    class: `sys ${sys}${busy ? " busy" : ""}${selected === sys ? " on" : ""}`, "aria-pressed": String(selected === sys),
    title: `Show System ${sys === "s1" ? 1 : 2}'s calls`, onclick: () => { selected = sys; rerender(); },
  },
    h("span", { class: "sys-k" }, sys === "s1" ? "System 1 · fast" : "System 2 · slow"),
    h("span", { class: "sys-name" }, name || (sys === "s1" ? "Jev" : "System 2")),
    h("span", { class: "sys-model" }, model),
    h("span", { class: "sys-state" }, h("i", {}), busy ? "Thinking" : "Idle"),
    h("span", { class: "sys-stats" },
      h("span", {}, h("b", {}, String(t.n)), "calls"),
      h("span", {}, h("b", {}, money(t.cost)), "spent"),
      h("span", {}, h("b", {}, t.n ? seconds(t.avgMs) : "–"), "avg time"),
      h("span", {}, h("b", {}, t.n ? money(t.avgCost) : "–"), "per call")));
}

function diagram(st: State): HTMLElement {
  const a = totals(st.calls.s1);
  const b = totals(st.calls.s2);
  const busy2 = st.calls.active.s2 > 0;
  // what System 2 would have cost had it made System 1's judgments, at its own average price and speed
  const times = Math.round((a.n * b.avgCost) / Math.max(a.cost, 1e-9));
  const value = a.n && b.n && b.avgCost > 0
    ? h("div", { class: "value" },
      h("div", { class: "value-n" }, h("b", {}, `${times.toLocaleString()}×`), h("span", {}, "cheaper with System 1")),
      h("p", {}, "System 1 made ", h("b", {}, `${a.n} judgment${a.n === 1 ? "" : "s"}`), " for ", h("b", {}, money(a.cost)), ". At System 2's average of ",
        h("b", {}, `${money(b.avgCost)} and ${seconds(b.avgMs)}`), " a call, the same work would have cost about ", h("b", {}, money(a.n * b.avgCost)),
        ` and taken ${clock(a.n * b.avgMs)} of model time.`))
    : h("p", { class: "value muted" }, "System 1 (Jev) judges every utterance in well under a second for a fraction of a cent. System 2 is called only when System 1 finds something worth checking, and it improves System 1 by rewriting its questions.");
  return h("div", { class: "think-diagram" },
    h("div", { class: "sys-row" },
      node(st, "s1"),
      h("div", { class: `links${busy2 ? " flowing" : ""}` },
        h("span", { class: "link fwd" }, h("span", {}, "flags claims"), h("i", {})),
        h("span", { class: "link back" }, h("i", {}), h("span", {}, "rewrites its questions"))),
      node(st, "s2")),
    value);
}

/** Renders whichever thinking tab is showing. */
export function renderThinking(st: State) {
  rerender = () => renderThinking(st);
  if (!$("#pane-jev")?.hidden) feed($("#jev-log"), st, "s1");
  if (!$("#pane-think")?.hidden) {
    replace($("#think"), diagram(st));
    replace($("#think-log-h"), selected === "s1" ? "System 1 calls · Jev" : "System 2 calls");
    feed($("#think-log"), st, selected);
  }
  replace($("#jev-count"), st.calls.s1.length ? String(st.calls.s1.length) : "");
}
