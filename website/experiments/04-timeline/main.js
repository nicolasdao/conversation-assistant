// 04 · The Timeline. Scrolling scrubs a playhead across one made-up 60-minute episode: the lanes paint in as it
// passes, the heat and hype lines draw themselves, and the caption for that moment rides above the playhead.
// Times are in minutes. On a phone the track zooms to a 15-minute window that slides under a fixed playhead.
(function () {
  const $ = (id) => document.getElementById(id);
  const TOTAL = 60;
  const INTRO = 4; // the cold open plays itself on load; scrolling covers 04:00 → 60:00
  const reduced = (window.CA && CA.reducedMotion) || matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Preview hook: ?platform=other shows the non-Mac download state.
  if (/[?&]platform=other\b/.test(location.search)) document.documentElement.dataset.platform = "other";

  // ---------- the episode ----------
  const TOPICS = [
    { a: 0, b: 5, label: "Cold open", c: "--s-the-show", tip: "The show opens" },
    { a: 5, b: 21, label: "What it is", c: "--s-ai-tools", tip: "Segment 1: live transcripts, speakers, the timeline, ⌘K chat" },
    { a: 21, b: 42, label: "Fact-checks", c: "--s-other-topics", tip: "Segment 2: claims flagged by System 1, checked by System 2" },
    { a: 42, b: 56, label: "Your Mac, your data", c: "--s-tech", tip: "Segment 3: no server, no account, no analytics" },
    { a: 56, b: 60, label: "Outro", c: "--s-the-show", tip: "Where to get it" },
  ];
  const MODES = [
    [0, 5, "Banter", "--m-banter"], [5, 10, "Explainer", "--m-explainer"], [10, 15, "Analysis", "--m-analysis"],
    [15, 19, "Personal story", "--m-personal-story"], [19, 21, "Transition", "--m-transition"], [21, 30, "News", "--m-news"],
    [30, 36, "Analysis", "--m-analysis"], [36, 41, "Banter", "--m-banter"], [41, 42, "Transition", "--m-transition"],
    [42, 50, "Explainer", "--m-explainer"], [50, 56, "Analysis", "--m-analysis"], [56, 60, "Banter", "--m-banter"],
  ];
  const LINES = [
    [0, "host", "We're live. Welcome back to the show."],
    [1.3, "guest", "Okay, enough about models, how was surfing in Sydney this weekend?"],
    [2.6, "host", "Cold. Anyway. Today: the app drawing this timeline."],
    [5, "host", "Conversation Assistant. An open-source Mac app."],
    [6.2, "guest", "So what does it actually do?"],
    [7, "host", "It transcribes us live. My mic, and the call my Mac plays."],
    [9, "guest", "Which call app?"],
    [9.5, "host", "Any of them. It listens to the Mac's own audio."],
    [11, "host", "Each voice becomes a speaker, and you can name them."],
    [13, "guest", "And these lanes under us?"],
    [13.6, "host", "Topic, mode, heat and hype, hot takes, predictions, clip-worthy moments."],
    [15.5, "host", "It was built for this show: my mic plus the guests on the call."],
    [17.4, "guest", "I lost the thread five minutes ago."],
    [18, "host", "Press ⌘K and ask the transcript. Live, or afterwards."],
    [19.6, "guest", "Prediction: half of this episode ends up as clips."],
    [21, "host", "Right. The fun part: fact-checks."],
    [23.2, "guest", "The Great Wall of China is visible from space with the naked eye."],
    [24, "host", "Contradicted, already. On screen, with sources."],
    [25.5, "host", "System 1 flags what's checkable. About 0.4 seconds a judgment."],
    [27, "host", "About 2,000 judgments an hour, for cents."],
    [27.6, "guest", "I don't buy that at all, cheap is not the same as good."],
    [28.4, "host", "Fair. So System 2, a slower model, researches the web and checks them."],
    [29.5, "guest", "Bananas are berries."],
    [31, "host", "And every check makes System 1 better."],
    [33.5, "guest", "Coffee dehydrates you."],
    [34.5, "host", "Four verdicts: supported, contradicted, misleading, unverifiable."],
    [36.5, "guest", "Goldfish only have a three-second memory."],
    [38, "guest", "Okay, I'll stop making things up."],
    [39, "host", "Octopuses have three hearts."],
    [40, "guest", "Supported. Finally."],
    [42, "guest", "So where does all of this go? Some server?"],
    [43, "host", "No server. No account. No analytics."],
    [45, "host", "Recordings and keys stay on your Mac."],
    [47, "guest", "Keys?"],
    [47.5, "host", "Two: OpenAI and OpenRouter, with prepaid credit. The app walks you through both."],
    [50, "host", "About $1.60 an hour of show. About $1.23 for a transcript only."],
    [52, "guest", "And afterwards?"],
    [52.5, "host", "The library. Play back at up to 4×, or export a recording as one file."],
    [54.5, "host", "Signed and notarized by Apple. It updates itself. BSD 3-Clause."],
    [56, "guest", "Where do I get it?"],
    [56.8, "host", "Download for Mac, top of the page. Apple Silicon, macOS 14.2 or later."],
    [58.8, "host", "That's the show. Thanks for listening."],
  ];
  const MARKERS = [
    [7, "clip_worthy", "Clip-worthy"], [18, "recommendation", "Recommendation"], [19.6, "prediction", "Prediction"],
    [27.6, "disagreement", "Disagreement"], [31, "hot_take", "Hot take"], [40, "clip_worthy", "Clip-worthy"],
    [43, "hot_take", "Hot take"], [47.5, "recommendation", "Recommendation"],
  ];
  // said: the claim is heard and flagged; at: the verdict lands (seconds later)
  const CHECKS = [
    { said: 23.2, at: 23.45, v: "contradicted", claim: "The Great Wall of China is visible from space with the naked eye.", note: "Astronauts report it isn't." },
    { said: 29.5, at: 29.75, v: "supported", claim: "Bananas are berries.", note: "Botanically, yes." },
    { said: 33.5, at: 33.75, v: "misleading", claim: "Coffee dehydrates you.", note: "Its water outweighs the mild diuretic effect." },
    { said: 36.5, at: 36.75, v: "contradicted", claim: "Goldfish only have a three-second memory.", note: "They remember for months." },
    { said: 39, at: 39.25, v: "supported", claim: "Octopuses have three hearts.", note: "Checked against sources." },
  ];
  const HEAT = [0.8, 1, 0.6, 1.2, 1.4, 1, 1.6, 1.2, 2.2, 1.4, 1.2, 2.4, 2.8, 3.7, 2.6, 2, 3.1, 2.4, 2.8, 2, 1.6, 2.2, 1.8, 2.6, 1.6, 2, 1.4, 1.2, 1, 0.8];
  const HYPE = [1.8, 2, 2.4, 3.2, 2.6, 2.4, 3, 2.2, 3.4, 2.4, 2.8, 2.6, 2.4, 2, 3, 2.6, 2.2, 2.8, 2.6, 3.6, 3, 2.4, 2.6, 3.2, 2.2, 2.4, 2.8, 3, 3.6, 3.2];
  const ptsOf = (vals) => [[0, vals[0]], ...vals.map((v, i) => [i * 2 + 1, v]), [60, vals[vals.length - 1]]];
  const heatPts = ptsOf(HEAT);
  const hypePts = ptsOf(HYPE);
  const VERDICT = { contradicted: "Contradicted", supported: "Supported", misleading: "Misleading" };

  const fmt = (m) => { const s = Math.max(0, Math.round(m * 60)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const pct = (m) => `${(m / TOTAL) * 100}%`;
  const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (html) e.innerHTML = html; return e; };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const lineAt = (m) => { let cur = LINES[0]; for (const l of LINES) { if (l[0] <= m + 1e-6) cur = l; else break; } return cur; };
  const glyph = (k) => `<svg aria-hidden="true"><use href="#g-${k}"/></svg>`;

  // ---------- build the lanes ----------
  const blocks = [];
  const laneSections = $("lane-sections"), laneSubject = $("lane-subject"), laneMode = $("lane-mode");
  for (const t of TOPICS) {
    const sect = el("span", { style: `left:${pct(t.a)};width:${pct(t.b - t.a)};--c:var(${t.c})` });
    laneSections.append(sect);
    const b = el("button", { type: "button", class: "blk", style: `left:${pct(t.a)};width:calc(${pct(t.b - t.a)} - 2px);--c:var(${t.c})`,
      "data-tip": `<b>${esc(t.label)}</b><span class="tt">${fmt(t.a)}–${fmt(t.b)}</span><br>${esc(t.tip)}`, "data-seek": t.a, "aria-label": `${t.label}, ${fmt(t.a)}` },
    `<span class="fill"></span><span class="blk-t">${esc(t.label)}</span>`);
    laneSubject.append(b);
    blocks.push({ a: t.a, b: t.b, el: b, sect });
  }
  for (const [a, b, label, c] of MODES) {
    const m = el("button", { type: "button", tabindex: "-1", class: "blk", style: `left:${pct(a)};width:calc(${pct(b - a)} - 2px);--c:var(${c})`,
      "data-tip": `<b>${esc(label)}</b><span class="tt">${fmt(a)}–${fmt(b)} · mode</span>`, "data-seek": a },
    `<span class="fill"></span><span class="blk-t">${esc(label)}</span>`);
    laneMode.append(m);
    blocks.push({ a, b, el: m });
  }

  const pins = MARKERS.map(([t, k, label]) => {
    const quote = lineAt(t)[2];
    const p = el("button", { type: "button", class: `pin k-${k}`, style: `left:${pct(t)}`, "data-seek": t, "aria-label": `${label} at ${fmt(t)}`,
      "data-tip": `<b>${label}</b><span class="tt">${fmt(t)}</span><br>“${esc(quote)}”` }, glyph(k));
    $("lane-markers").append(p);
    return { t, el: p };
  });

  const flags = CHECKS.map((c) => {
    const f = el("button", { type: "button", class: "flag", style: `left:${pct(c.said)}`, "data-seek": c.at, "aria-label": `${VERDICT[c.v]}: ${c.claim}` });
    $("lane-checks").append(f);
    return { c, el: f, state: "" };
  });

  for (let m = 0; m <= 60; m += 5) {
    $("lane-axis").append(el("span", { class: `tick${m === 0 ? " first" : m === 60 ? " last" : ""}`, style: `left:${pct(m)}` }, fmt(m)));
  }

  // the heat and hype lines, on a 0–4 scale, in a 600 × 100 box
  const y = (v) => (1 - v / 4) * 100;
  const pts = (arr) => arr.map(([m, v]) => `${m * 10},${y(v).toFixed(1)}`).join(" ");
  $("heat-line").setAttribute("points", pts(heatPts));
  $("hype-line").setAttribute("points", pts(hypePts));
  $("heat-area").setAttribute("points", `0,100 ${pts(heatPts)} 600,100`);
  const valueAt = (arr, m) => {
    for (let i = 1; i < arr.length; i++) if (arr[i][0] >= m) { const [m0, v0] = arr[i - 1], [m1, v1] = arr[i]; return v0 + ((v1 - v0) * (m - m0)) / (m1 - m0 || 1); }
    return arr[arr.length - 1][1];
  };

  // ---------- geometry ----------
  const view = $("tl-view"), track = $("track"), cap = $("cap"), playhead = $("playhead");
  let viewW = 1, trackW = 1, windowMin = TOTAL;
  function measure() {
    const hh = $("top").offsetHeight;
    document.documentElement.style.setProperty("--hh", `${hh}px`);
    viewW = view.clientWidth;
    windowMin = innerWidth < 761 ? 15 : TOTAL;
    trackW = (viewW * TOTAL) / windowMin;
    track.style.width = `${trackW}px`;
  }

  // ---------- time from scroll ----------
  const scrub = $("scrub");
  const maxScroll = () => Math.max(1, scrub.offsetHeight - innerHeight);
  const scrollTime = () => INTRO + Math.min(1, Math.max(0, scrollY / maxScroll())) * (TOTAL - INTRO);
  let auto = reduced || scrollY > 4 ? null : 0; // the cold open's own time while it plays itself
  let lastT = -1;

  function currentTime() {
    const s = scrollTime();
    return auto === null ? s : scrollY > 4 ? Math.max(auto, s) : auto;
  }

  // ---------- render ----------
  const tc = $("tc"), tcSeg = $("tc-seg"), phTag = $("ph-tag"), hint = $("hint");
  const cards = [...document.querySelectorAll(".card")];
  const drawn = $("drawn-rect"), penHeat = $("pen-heat"), penHype = $("pen-hype");
  const capWho = $("cap-who"), capText = $("cap-text");
  let lastLine = null, lastCheckKey = "";

  function render(t) {
    lastT = t;
    // the tape: on a phone the track slides so the playhead sits 40% across
    let offset = 0;
    if (windowMin < TOTAL) offset = Math.min(trackW - viewW, Math.max(0, (t / TOTAL) * trackW - viewW * 0.4));
    track.style.transform = `translateX(${-offset}px)`;
    const px = (t / TOTAL) * trackW - offset;
    playhead.style.transform = `translateX(${px}px)`;
    phTag.textContent = fmt(t);
    phTag.style.transform = px > viewW - 30 ? "translateX(-100%)" : px < 30 ? "none" : "";
    tc.textContent = fmt(t);

    for (const b of blocks) {
      const p = Math.min(1, Math.max(0, (t - b.a) / (b.b - b.a)));
      b.el.style.setProperty("--p", p.toFixed(4));
      b.el.classList.toggle("lit", p > 0);
      if (b.sect) b.sect.classList.toggle("on", p > 0);
    }
    const topic = TOPICS.find((x) => t >= x.a && t < x.b) || TOPICS[TOPICS.length - 1];
    tcSeg.textContent = topic.label;

    drawn.setAttribute("width", (t * 10).toFixed(2));
    const chartH = $("lane-chart").clientHeight;
    const penX = `${(t / TOTAL) * 100}%`;
    penHeat.style.left = penX; penHeat.style.top = `${(y(valueAt(heatPts, t)) / 100) * chartH}px`;
    penHype.style.left = penX; penHype.style.top = `${(y(valueAt(hypePts, t)) / 100) * chartH}px`;

    for (const p of pins) p.el.classList.toggle("on", t >= p.t);
    for (const f of flags) {
      const st = t < f.c.said ? "" : t < f.c.at ? "researching" : "done";
      if (st === f.state) continue;
      f.state = st;
      f.el.className = `flag${st ? " on" : ""}${st === "researching" ? " researching" : st === "done" ? ` v-${f.c.v}` : ""}`;
      f.el.innerHTML = st === "researching" ? `${glyph("flag")}Checking` : `${glyph("flag")}${VERDICT[f.c.v]}`;
      f.el.dataset.tip = st === "researching"
        ? `<b>Researching</b><span class="tt">${fmt(f.c.said)}</span><br>“${esc(f.c.claim)}”`
        : `<b>${VERDICT[f.c.v]}</b><span class="tt">${fmt(f.c.said)} · fact-check</span><br>“${esc(f.c.claim)}” ${esc(f.c.note)}`;
    }

    // the caption above the playhead
    const line = lineAt(t);
    if (line !== lastLine) {
      lastLine = line;
      capWho.textContent = line[1] === "host" ? "Host" : "Guest";
      capWho.className = `who-tab ${line[1]}`;
      capText.textContent = line[2];
      cap.classList.toggle("guest", line[1] === "guest");
      if (!reduced) { cap.classList.remove("swap"); void cap.offsetWidth; cap.classList.add("swap"); }
    }
    const cw = cap.offsetWidth;
    const left = Math.min(viewW - cw, Math.max(0, px - cw * 0.22));
    cap.style.transform = `translateX(${left}px)`;
    cap.style.setProperty("--stem", `${Math.min(cw - 12, Math.max(12, px - left))}px`);

    // the rundown card for this segment
    for (const c of cards) c.classList.toggle("is-on", t >= +c.dataset.from && t < +c.dataset.to);
    renderLowerThird(t);
    hint.classList.toggle("gone", t > INTRO + 0.4);
  }

  function renderLowerThird(t) {
    let c = null;
    for (const x of CHECKS) if (t >= x.said) c = x;
    const slot = $("lt-slot");
    const state = !c ? "" : t < c.at ? "researching" : "done";
    const key = c ? `${c.said}:${state}` : "";
    if (key === lastCheckKey) return;
    const sameClaim = lastCheckKey.split(":")[0] === key.split(":")[0];
    lastCheckKey = key;
    if (!c) { slot.innerHTML = `<div class="fc v-researching" style="animation:none;opacity:.55"><div class="fc-verdict"><span class="vw">Listening</span><span class="vm">System 1</span></div><div class="fc-body"><p class="correction">Waiting for a checkable claim…</p></div></div>`; return; }
    const researching = state === "researching";
    const steps = `<ol class="steps"><li class="done">Flagged</li><li class="${researching ? "cur" : "done"}">Researching</li><li class="${researching ? "" : "cur"}">Verdict</li></ol>`;
    slot.innerHTML = `<div class="fc ${researching ? "v-researching" : `v-${c.v}`}"${sameClaim ? ' style="animation:none"' : ""}>
      <div class="fc-verdict${!researching && sameClaim && !reduced ? " flip" : ""}"><span class="vw">${researching ? "Checking" : VERDICT[c.v]}</span><span class="vm">${researching ? "System 2 on it" : "Sourced verdict"}</span></div>
      <div class="fc-body"><div class="fc-meta"><span class="who-tab guest">Guest</span><span class="t">${fmt(c.said)}</span>${steps}</div>
      <p class="restated">“${esc(c.claim)}”</p>${researching ? "" : `<p class="correction">${esc(c.note)}</p>`}</div></div>`;
  }

  // ---------- scheduling: render on scroll, resize and the cold open ----------
  let queued = false;
  const frame = () => { queued = false; const t = currentTime(); if (Math.abs(t - lastT) > 1e-5) render(t); };
  const request = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };
  addEventListener("scroll", request, { passive: true });
  addEventListener("resize", () => { measure(); lastT = -1; request(); });

  function coldOpen() {
    if (auto === null) return;
    const start = performance.now() + 500, dur = 3600;
    const step = (now) => {
      if (auto === null) return;
      const k = Math.min(1, Math.max(0, (now - start) / dur));
      auto = INTRO * (1 - Math.pow(1 - k, 2.2));
      render(currentTime());
      if (k < 1) requestAnimationFrame(step); else { auto = null; lastT = -1; request(); }
    };
    requestAnimationFrame(step);
  }

  // ---------- scrubbing by hand: click or drag the timeline, or press a block or marker ----------
  function seekTo(m, smooth) {
    auto = null;
    const k = Math.min(1, Math.max(0, (m - INTRO) / (TOTAL - INTRO)));
    scrollTo({ top: scrub.offsetTop + k * maxScroll(), behavior: smooth && !reduced ? "smooth" : "auto" });
  }
  const timeAtX = (clientX) => {
    const rect = view.getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(track).transform);
    return ((clientX - rect.left - m.m41) / trackW) * TOTAL;
  };
  let drag = null;
  view.addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-seek]")) return;
    drag = { id: e.pointerId, x: e.clientX, moved: false };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
    if (drag.moved) seekTo(timeAtX(e.clientX), false);
  });
  const endDrag = (e) => { if (!drag) return; if (!drag.moved && e.type === "pointerup") seekTo(timeAtX(e.clientX), true); drag = null; };
  view.addEventListener("pointerup", endDrag);
  view.addEventListener("pointercancel", () => { drag = null; });
  view.addEventListener("click", (e) => { const s = e.target.closest("[data-seek]"); if (s) seekTo(+s.dataset.seek + 0.05, true); });

  // ---------- tooltips in the app's style ----------
  const tip = $("tip");
  let tipFor = null;
  function showTip(target, x, yPos) {
    tipFor = target;
    tip.innerHTML = target.dataset.tip;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
    tip.style.top = `${Math.max(8, yPos - h - 14)}px`;
  }
  const hideTip = () => { tipFor = null; tip.hidden = true; };
  document.addEventListener("pointerover", (e) => { const t = e.target.closest && e.target.closest("[data-tip]"); if (!t) hideTip(); });
  document.addEventListener("pointermove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (t && e.pointerType === "mouse") showTip(t, e.clientX, t.getBoundingClientRect().top);
  });
  document.addEventListener("focusin", (e) => { const t = e.target.closest("[data-tip]"); if (t) { const r = t.getBoundingClientRect(); showTip(t, r.left + r.width / 2, r.top); } });
  document.addEventListener("focusout", hideTip);
  addEventListener("scroll", () => { if (tipFor) hideTip(); }, { passive: true });

  // ---------- a download: the ON AIR block turns into a thank-you ----------
  addEventListener("ca:download", () => {
    const onair = $("onair"), label = $("onair-label");
    onair.classList.remove("enter", "sweep"); void onair.offsetWidth;
    onair.classList.add("got", "sweep");
    label.textContent = "Downloading";
    setTimeout(() => { onair.classList.remove("got", "sweep"); label.textContent = "On air"; }, 4000);
  });

  // ---------- go ----------
  measure();
  render(currentTime());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); lastT = -1; request(); });
  coldOpen();
})();
