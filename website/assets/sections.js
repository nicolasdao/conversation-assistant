// The Jev and System 1 / System 2 sections: one Jev call, answered live, and the two systems running on a stream of lines.
// Every answer here is an example. The questions, thresholds, speeds and costs are Tattle's (docs/jev.md, docs/system1-system2.md).
(function () {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Runs `step` every `ms` while `el` is on screen and the tab is visible.
  function whileVisible(el, ms, step) {
    let timer = 0, onScreen = false;
    const sync = () => {
      clearInterval(timer);
      if (onScreen && !document.hidden) timer = setInterval(step, ms);
    };
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); }, { threshold: 0.2 }).observe(el);
    document.addEventListener("visibilitychange", sync);
    return { restart: sync };
  }

  // ---------- one Jev call ----------
  const Q = {
    boundary: { type: "noul", q: "Does it move on to a new point?" },
    claim: { type: "noul", q: "Is it a specific, checkable statement of fact?" },
    claim_type: { type: "choice", q: "What kind of claim is it?" },
    public: { type: "noul", q: "Is it about the public world?" },
    hedged: { type: "noul", q: "Does the speaker sound unsure?" },
    worth: { type: "score", q: "How much would listeners care if it's wrong?" },
    known_c_1: { type: "noul", q: "Is it a repeat of claim c_1?" },
  };

  // Five lines in a row. The first flag adds a memory question (known_c_1) to every call after it.
  const LINES = [
    { prev: ["Host", "So what changed phones for good?"], now: ["Guest", "The first iPhone came out in 2007."], ms: 412,
      a: { boundary: 0.18, claim: 0.95, claim_type: ["date_or_release", 0.97], public: 0.96, hedged: 0.03, worth: 2.6 },
      out: ["flag", "Flagged", "System 2 researches it, and a memory question, known_c_1, joins every call from now on."] },
    { prev: ["Guest", "The first iPhone came out in 2007."], now: ["Guest", "Honestly, that phone changed my life."], ms: 388,
      a: { boundary: 0.1, claim: 0.08, claim_type: ["none", 0.9], public: 0.12, hedged: 0.05, worth: 0.3, known_c_1: 0.04 },
      out: ["none", "Not a claim", "It's an opinion. Nothing to check, and nothing is spent on System 2."] },
    { prev: ["Guest", "Honestly, that phone changed my life."], now: ["Host", "Like I said, the iPhone launched in 2007."], ms: 405,
      a: { boundary: 0.07, claim: 0.9, claim_type: ["date_or_release", 0.95], public: 0.94, hedged: 0.04, worth: 2.2, known_c_1: 0.86 },
      out: ["repeat", "A repeat of c_1", "The earlier verdict comes back instantly, with no second research."] },
    { prev: ["Host", "Like I said, the iPhone launched in 2007."], now: ["Host", "I think Mount Everest grows a few millimetres a year."], ms: 431,
      a: { boundary: 0.74, claim: 0.88, claim_type: ["number_or_price", 0.81], public: 0.93, hedged: 0.91, worth: 2.2, known_c_1: 0.02 },
      out: ["flag", "Flagged, and hedged", "The speaker sounds unsure, so it moves up System 2's research queue."] },
    { prev: ["Host", "I think Mount Everest grows a few millimetres a year."], now: ["Guest", "Anyway, how was surfing in Sydney this weekend?"], ms: 379,
      a: { boundary: 0.93, claim: 0.03, claim_type: ["none", 0.96], public: 0.05, hedged: 0.02, worth: 0.1, known_c_1: 0.01 },
      out: ["topic", "A new topic", "The segment closes, Jev labels it, and the timeline gets a new block."] },
  ];

  const call = $("jevcall");
  if (call) {
    const rows = $("jc-rows"), json = $("jc-json"), out = $("jc-out"), msEl = $("jc-ms"), nEl = $("jc-n");
    let i = -1, raf = 0, landTimer = 0;

    const answerHtml = (id, v) => {
      const t = Q[id].type;
      if (t === "noul") return `<span class="bar"><i style="--p:${v}"></i></span><span class="num tab">${v.toFixed(2)}</span>`;
      if (t === "choice") return `<span class="choice">${esc(v[0])}</span><span class="num tab">${v[1].toFixed(2)}</span>`;
      const pips = [0, 1, 2, 3, 4].map((n) => `<b class="${v >= n + 0.5 ? "on" : ""}"></b>`).join("");
      return `<span class="pips">${pips}</span><span class="num tab">${v.toFixed(1)}<small>/4</small></span>`;
    };

    function show(n) {
      i = n % LINES.length;
      const L = LINES[i], ids = Object.keys(L.a);
      cancelAnimationFrame(raf); clearTimeout(landTimer);
      nEl.textContent = ids.length;
      json.innerHTML = [
        "{",
        `  <span class="k">"current_segment"</span>: [`,
        `    { <span class="k">"speaker"</span>: <span class="s">"${esc(L.prev[0])}"</span>, <span class="k">"text"</span>: <span class="s">"${esc(L.prev[1])}"</span> }`,
        "  ],",
        `  <span class="k">"new_utterance"</span>: {`,
        `    <span class="k">"speaker"</span>: <span class="s">"${esc(L.now[0])}"</span>,`,
        `    <span class="k">"text"</span>: <span class="s hl">"${esc(L.now[1])}"</span>`,
        "  }",
        "}",
      ].join("\n");
      rows.innerHTML = ids.map((id) => `<li class="jc-row${id.startsWith("known") ? " mem" : ""}"><code>${id}</code><span class="qt ${Q[id].type}">${Q[id].type}</span><span class="q">${esc(Q[id].q)}</span><span class="ans">${answerHtml(id, L.a[id])}</span></li>`).join("");
      out.className = "jc-out";
      out.innerHTML = "";
      // Every question is answered in the same call, so the answers land together when the call returns.
      const land = () => {
        call.classList.add("landed");
        msEl.textContent = `${(L.ms / 1000).toFixed(2)} s`;
        out.className = `jc-out ${L.out[0]}`;
        out.innerHTML = `<b>${esc(L.out[1])}</b><span>${esc(L.out[2])}</span>`;
      };
      call.classList.remove("landed");
      if (reduced) { land(); return; }
      const t0 = performance.now();
      const tick = (t) => {
        const el = t - t0;
        if (el >= L.ms) { land(); return; }
        msEl.textContent = `${(el / 1000).toFixed(2)} s`;
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    show(0);
    const auto = whileVisible(call, 7000, () => show(i + 1));
    $("jc-next").addEventListener("click", () => { show(i + 1); auto.restart(); });
  }

  // ---------- System 1 and System 2 on a stream of lines ----------
  const STREAM = [
    ["host", "We're live. Say hi to everyone on the call."],
    ["remote", "Lightning never strikes the same place twice.", "contradicted", "The Empire State Building is hit about 20–25 times a year."],
    ["host", "Ha, okay, bold start."],
    ["remote", "I don't buy that at all, cheap is not the same as good."],
    ["host", "Octopuses have three hearts.", "supported", "Two pump blood to the gills, one to the body."],
    ["remote", "Wait, really? That's wild."],
    ["host", "Anyway, how was surfing in Sydney this weekend?"],
    ["remote", "Freezing. I paddled out at sunrise anyway."],
    ["remote", "Coffee dehydrates you, so I skipped it.", "misleading", "Its water outweighs the mild diuretic effect."],
    ["host", "That sounds miserable."],
    ["host", "The Great Wall of China is visible from space with the naked eye.", "contradicted", "Astronauts report it isn't."],
    ["remote", "Let's park that one for the end."],
  ];
  const S1_COST = 0.00004, S2_COST = 0.008;

  const flow = $("flow");
  if (flow) {
    const feed = $("flow-feed"), checks = $("flow-checks");
    let k = 0, lines = 0, flags = 0;
    const tally = () => {
      $("ft-lines").textContent = lines;
      $("ft-flags").textContent = flags;
      $("ft-s1").textContent = `$${(lines * S1_COST).toFixed(4)}`;
      $("ft-s2").textContent = `$${(flags * S2_COST).toFixed(3)}`;
    };
    const cap = (list, n) => { while (list.children.length > n) list.lastElementChild.remove(); };

    function step(instant) {
      const [who, text, verdict, note] = STREAM[k % STREAM.length];
      k++; lines++;
      const li = document.createElement("li");
      li.className = `fl ${who}${verdict ? " flagged" : ""}${instant ? "" : " enter"}`;
      li.innerHTML = `<span class="fl-who">${who === "host" ? "Host" : "Guest"}</span><span class="fl-text">${esc(text)}</span><span class="fl-res">${verdict ? "Flagged" : "Heard"}<small class="tab">${(0.35 + Math.random() * 0.3).toFixed(2)} s</small></span>`;
      feed.prepend(li); cap(feed, 5);
      if (verdict) {
        flags++;
        const c = document.createElement("li");
        c.className = `fc v-researching${instant ? "" : " enter"}`;
        c.innerHTML = `<div class="fc-verdict"><span class="vw">Checking</span><span class="vm">System 2</span></div><div class="fc-body"><p class="restated">"${esc(text)}"</p><p class="correction">Researching the web…</p></div>`;
        checks.prepend(c); cap(checks, 3);
        const resolve = () => {
          c.className = `fc v-${verdict}`;
          c.querySelector(".vw").textContent = verdict;
          c.querySelector(".vm").textContent = "Sourced";
          c.querySelector(".correction").textContent = note;
        };
        if (instant) resolve(); else setTimeout(resolve, 5200);
      }
      tally();
    }

    // Open with a few lines already judged, so the section reads at rest.
    for (let n = 0; n < 5; n++) step(true);
    if (!reduced) whileVisible(flow, 1700, () => step(false));
  }
})();
