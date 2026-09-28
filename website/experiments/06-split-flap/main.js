// 06 · Split-flap board. Every letter on the page that moves is a flap: a top card that falls over a bottom card.
(() => {
  const RM = !!(window.CA && window.CA.reducedMotion);
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const rand = (a, b) => a + Math.random() * (b - a);

  /* ---------- the character drum: a flap can only show these, in this order ---------- */
  const CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:·-'?!&/+$%#()";
  const N = CHARS.length;
  const IDX = new Map([...CHARS].map((c, i) => [c, i]));
  function clean(s) {
    const t = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
      .replace(/[’‘`"“”]/g, "'").replace(/[–—]/g, "-");
    let out = "";
    for (const c of t) out += IDX.has(c) ? c : " ";
    return out;
  }
  function wrap(s, cols) {
    const lines = []; let cur = "";
    for (let w of s.split(" ").filter(Boolean)) {
      while (w.length > cols) { if (cur) { lines.push(cur); cur = ""; } lines.push(w.slice(0, cols)); w = w.slice(cols); }
      if (!w) continue;
      if (!cur) cur = w; else if (cur.length + 1 + w.length <= cols) cur += " " + w; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function layout(text, cols, rows, o = {}) {
    let lines;
    if (Array.isArray(text)) lines = text.map(clean);
    else if (o.raw) { const s = clean(text); lines = []; for (let i = 0; i < rows; i++) lines.push(s.slice(i * cols, (i + 1) * cols)); }
    else lines = wrap(clean(text), cols);
    let out = "";
    for (let r = 0; r < rows; r++) {
      let l = (lines[r] || "").slice(0, cols);
      if (o.align === "center") { const pad = Math.floor((cols - l.length) / 2); l = " ".repeat(pad) + l; }
      out += l.padEnd(cols, " ");
    }
    return out;
  }

  /* ---------- sound: synthesised clacks, off until the visitor turns them on ---------- */
  const sfx = {
    ctx: null, on: false, last: 0, buf: null, out: null,
    init() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const ctx = (this.ctx = new AC());
      const sr = ctx.sampleRate, len = Math.floor(sr * 0.045);
      this.buf = ctx.createBuffer(1, len, sr);
      const d = this.buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.0032));
      const comp = ctx.createDynamicsCompressor();
      this.out = ctx.createGain(); this.out.gain.value = 0.55;
      this.out.connect(comp).connect(ctx.destination);
      return true;
    },
    flip(final) {
      if (!this.on || !this.ctx || this.ctx.state !== "running") return;
      const t = this.ctx.currentTime;
      if (t - this.last < (final ? 0.011 : 0.02)) return;
      this.last = t;
      const src = this.ctx.createBufferSource();
      src.buffer = this.buf; src.playbackRate.value = rand(0.75, 1.35);
      const f = this.ctx.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = final ? rand(900, 1500) : rand(2300, 4000); f.Q.value = final ? 2.2 : 5;
      const g = this.ctx.createGain(); g.gain.value = final ? 1 : 0.32;
      src.connect(f).connect(g).connect(this.out);
      src.start(t);
    },
  };

  /* ---------- the flap engine ---------- */
  function half(cls) {
    const s = document.createElement("span"); s.className = cls; s._base = cls; s._c = " ";
    const b = document.createElement("b"); b.textContent = " "; s.appendChild(b);
    return s;
  }
  function put(h, ch, tone) {
    if (h._c !== ch) { h.firstChild.textContent = ch; h._c = ch; }
    const cn = tone ? h._base + " t-" + tone : h._base;
    if (h.className !== cn) h.className = cn;
  }
  class Cell {
    constructor() {
      const el = (this.el = document.createElement("span")); el.className = "f";
      this.u = half("h u"); this.l = half("h l"); this.fu = half("h u fl"); this.fd = half("h l fl");
      el.append(this.u, this.l, this.fu, this.fd);
      this.ch = " "; this.tone = ""; this.q = []; this.a = null; this.wait = 0;
    }
    snap(ch, tone) {
      this.q.length = 0;
      if (this.a) this.end();
      this.ch = ch; this.tone = tone;
      put(this.u, ch, tone); put(this.l, ch, tone);
    }
    begin(n, now) {
      this.a = n; n.t0 = now;
      put(this.u, n.ch, n.tone); put(this.fu, this.ch, this.tone); put(this.fd, n.ch, n.tone);
      this.fu.style.transform = "rotateX(0deg)"; this.fd.style.transform = "rotateX(90deg)";
      this.el.classList.add("go");
      sfx.flip(n.last);
    }
    draw(p) {
      const a = this.a;
      if (p < 0.5) {
        const k = Math.pow(p * 2, 1.7); // gravity: the top card accelerates as it falls
        this.fu.style.transform = `rotateX(${(-90 * k).toFixed(2)}deg)`;
        this.fu.style.setProperty("--sh", (k * 0.55).toFixed(3));
        this.u.style.setProperty("--sh", ((1 - k) * 0.5).toFixed(3));
        this.l.style.setProperty("--sh", (k * 0.35).toFixed(3));
      } else {
        const t = (p - 0.5) * 2;
        let ang;
        if (!a.last || t < 0.68) ang = 90 * (1 - Math.pow(Math.min(1, t / (a.last ? 0.68 : 1)), 1.6));
        else ang = 16 * Math.sin((Math.PI * (t - 0.68)) / 0.32) * (1 - (t - 0.68)); // the settle: a small bounce off the stop
        this.fu.style.transform = "rotateX(-90deg)";
        this.fd.style.transform = `rotateX(${ang.toFixed(2)}deg)`;
        this.fd.style.setProperty("--sh", ((ang / 90) * 0.55).toFixed(3));
        this.u.style.setProperty("--sh", "0");
        this.l.style.setProperty("--sh", ((ang / 90) * 0.35).toFixed(3));
      }
    }
    end() {
      const a = this.a; this.a = null;
      this.ch = a.ch; this.tone = a.tone;
      put(this.l, a.ch, a.tone); put(this.u, a.ch, a.tone);
      this.el.classList.remove("go");
      this.u.style.setProperty("--sh", "0"); this.l.style.setProperty("--sh", "0");
    }
    plan(ch, tone, o, now) {
      const fromCh = this.a ? this.a.ch : this.ch;
      const fromTone = this.a ? this.a.tone : this.tone;
      this.q.length = 0;
      if (RM || o.instant) { this.snap(ch, tone); return; }
      if (fromCh === ch && fromTone === tone) return;
      const i1 = IDX.get(ch), i0 = IDX.get(fromCh);
      const dist = (i1 - i0 + N) % N;
      const steps = Math.max(1, Math.min(dist, o.steps == null ? 10 : o.steps));
      for (let s = steps - 1; s >= 0; s--) {
        this.q.push({ ch: CHARS[(i1 - s + N) % N], tone: s === 0 ? tone : fromTone, d: s === 0 ? (o.dLast || 150) : (o.d || 56), last: s === 0 });
      }
      this.wait = now + (o.delay || 0);
      engine.add(this);
    }
    stir(n, now, delay) {
      if (RM || this.a || this.q.length) return;
      const ch = this.ch, tone = this.tone;
      for (let i = 0; i < n; i++) this.q.push({ ch: CHARS[1 + Math.floor(Math.random() * 26)], tone, d: 52, last: false });
      this.q.push({ ch, tone, d: 150, last: true });
      this.wait = now + delay;
      engine.add(this);
    }
  }

  const engine = {
    active: new Set(), raf: 0,
    add(c) { this.active.add(c); this.kick(); },
    kick() { if (!this.raf) this.raf = requestAnimationFrame((t) => this.tick(t)); },
    tick(now) {
      this.raf = 0;
      for (const c of this.active) {
        if (!c.a) {
          if (!c.q.length) { this.active.delete(c); continue; }
          if (now < c.wait) continue;
          c.begin(c.q.shift(), Math.max(c.wait, now - 16));
        }
        // Keep time, not frames: on a slow frame, skip the steps that should already have landed.
        while (c.a && now >= c.a.t0 + c.a.d) {
          const t = c.a.t0 + c.a.d;
          c.end();
          if (c.q.length) c.begin(c.q.shift(), t);
        }
        if (c.a) c.draw(Math.min(1, (now - c.a.t0) / c.a.d));
      }
      if (this.active.size) this.kick();
    },
  };
  // A hidden tab stops requestAnimationFrame; on return, restart the loop where it left off.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && engine.active.size) engine.kick(); });

  class Display {
    constructor(el, o) {
      this.el = el; this.cols = o.cols; this.rows = o.rows || 1; this.align = o.align || "left";
      this.ratio = o.ratio || 1.42; this.min = o.min || 8; this.max = o.max || 60; this.gx = o.gx ?? 2; this.gy = o.gy ?? 3;
      this.build();
    }
    build() {
      this.el.textContent = ""; this.el.classList.add("flaps"); this.cells = [];
      for (let r = 0; r < this.rows; r++) {
        const line = document.createElement("span"); line.className = "fl-line";
        for (let c = 0; c < this.cols; c++) { const cell = new Cell(); this.cells.push(cell); line.appendChild(cell.el); }
        this.el.appendChild(line);
      }
    }
    fit(W) {
      const cw = Math.max(this.min, Math.min(this.max, Math.floor((W - (this.cols - 1) * this.gx) / this.cols)));
      const s = this.el.style;
      s.setProperty("--cw", cw + "px"); s.setProperty("--ch", Math.round(cw * this.ratio) + "px");
      s.setProperty("--gx", this.gx + "px"); s.setProperty("--gy", this.gy + "px");
      return cw;
    }
    set(text, o = {}) {
      const chars = layout(text, this.cols, this.rows, { raw: o.raw, align: o.align || this.align });
      const now = performance.now();
      this.cells.forEach((cell, i) => {
        const tone = typeof o.tone === "function" ? o.tone(i, chars[i]) : o.tone || "";
        const delay = (o.delay || 0) + (o.stagger ? i * o.stagger : 0) + (o.jitter ? Math.random() * o.jitter : 0);
        cell.plan(chars[i], tone, { ...o, delay }, now);
      });
    }
    stir(n = 3, spread = 160) { const now = performance.now(); this.cells.forEach((c) => c.stir(n, now, Math.random() * spread)); }
  }

  /* ---------- when things are on screen ---------- */
  const vis = new WeakMap();
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    vis.set(e.target, e.isIntersecting);
    if (e.isIntersecting && e.target._onSeen) { const f = e.target._onSeen; e.target._onSeen = null; f(); }
  }), { rootMargin: "60px" });
  const watch = (el, onSeen) => { el._onSeen = onSeen || null; io.observe(el); };
  const seen = (el) => !!vis.get(el) && !document.hidden;

  /* ---------- the headline ---------- */
  const hlEl = $("#hl"), titleEl = $(".title");
  const HL = {
    wide: { cols: 18, rows: 2, msgs: [["TATTLE", "FOR YOUR MAC"], ["TRANSCRIBE · MAP ·", "FACT-CHECK"]], bye: ["ENJOY THE SHOW", ""] },
    narrow: { cols: 12, rows: 3, msgs: [["TATTLE", "FOR YOUR MAC", ""], ["TRANSCRIBE ·", "MAP ·", "FACT-CHECK"]], bye: ["ENJOY", "THE SHOW", ""] },
  };
  let hlMode = null, hl = null, hlIdx = 0, hlHoldUntil = 0;
  function buildHeadline(first) {
    const mode = titleEl.clientWidth < 640 ? "narrow" : "wide";
    if (mode === hlMode) { hl.fit(titleEl.clientWidth); return; }
    hlMode = mode; const m = HL[mode];
    hl = new Display(hlEl, { cols: m.cols, rows: m.rows, ratio: 1.4, max: 60, gx: 3, gy: 4 });
    hl.fit(titleEl.clientWidth);
    hl.set(m.msgs[hlIdx], first ? { steps: 22, stagger: 26, jitter: 120 } : { instant: true });
  }
  function cycleHeadline() {
    if (!seen(titleEl) || performance.now() < hlHoldUntil) return;
    hlIdx = (hlIdx + 1) % 2;
    hl.set(HL[hlMode].msgs[hlIdx], { steps: 14, stagger: 22, jitter: 80 });
  }

  /* ---------- the boarding gate: the download ---------- */
  const gateLabel = new Display($("#gateLabel"), { cols: 12, rows: 1, max: 18, min: 10, ratio: 1.45 });
  const dlWrap = $(".dl-flaps"), dlEl = $("#dlFlaps"), dlA = $(".dl");
  const dl = new Display(dlEl, { cols: 8, rows: 2, max: 50, min: 16, ratio: 1.36, gx: 3, gy: 4 });
  function fitGate() {
    gateLabel.fit(Math.min(210, $(".gate-top").clientWidth - 110));
    if (dlWrap.clientWidth) { const cw = dl.fit(dlWrap.clientWidth); dlA.style.setProperty("--dl-cw", cw + "px"); }
  }
  let hoverAt = 0;
  dlA.addEventListener("mouseenter", () => { const t = performance.now(); if (t - hoverAt > 900) { hoverAt = t; dl.stir(3, 220); } });
  window.addEventListener("ca:download", () => {
    gateLabel.set("DOWNLOADING", { tone: "you", steps: 8, stagger: 30 });
    $("#gateLamp").className = "lamp good";
    hlHoldUntil = performance.now() + 7000;
    if (hl) hl.set(HL[hlMode].bye, { steps: 12, stagger: 20 });
    setTimeout(() => { gateLabel.set("NOW BOARDING", { tone: "you", steps: 8, stagger: 30 }); $("#gateLamp").className = "lamp chk"; }, 7000);
  });
  if (window.CA) window.CA.ready(() => { $("#rel").hidden = false; });

  /* ---------- the board ---------- */
  const DATA = [
    { short: "GREAT WALL SEEN FROM SPACE", quote: "The Great Wall of China is visible from space with the naked eye.", v: "bad", note: "Astronauts report it isn't.", test: [/great wall/i, /space/i] },
    { short: "BANANAS ARE BERRIES", quote: "Bananas are berries.", v: "good", note: "Botanically, yes.", test: [/banana/i, /berr(y|ies)/i] },
    { short: "GOLDFISH: 3-SECOND MEMORY", quote: "Goldfish only have a three-second memory.", v: "bad", note: "They remember for months.", test: [/goldfish/i, /(three|3)[\s-]*sec/i] },
    { short: "LIGHTNING NEVER STRIKES TWICE", quote: "Lightning never strikes the same place twice.", v: "bad", note: "The Empire State Building is hit about 20–25 times a year.", test: [/lightning/i, /(twice|same place)/i], neg: true },
    { short: "EVEREST GROWS EVERY YEAR", quote: "Mount Everest gets a little taller every year.", v: "good", note: "A few millimetres a year.", test: [/everest/i, /(taller|grow|higher|ris)/i] },
    { short: "COFFEE DEHYDRATES YOU", quote: "Coffee dehydrates you.", v: "warn", note: "Its water outweighs the mild diuretic effect.", test: [/coffee/i, /dehydrat/i] },
    { short: "BATS ARE BLIND", quote: "Bats are blind.", v: "bad", note: "All bats can see.", test: [/\bbats?\b/i, /blind/i] },
    { short: "TOMB HONEY STILL EDIBLE", quote: "Honey found in Egyptian tombs was still edible.", v: "good", note: "", test: [/honey/i, /(tomb|egypt)/i, /(edible|eat)/i] },
    { short: "8 SPIDERS A YEAR IN SLEEP", quote: "The average person swallows eight spiders a year in their sleep.", v: "bad", note: "", test: [/spiders?/i, /(swallow|eat)/i] },
    { short: "OCTOPUSES HAVE 3 HEARTS", quote: "Octopuses have three hearts.", v: "good", note: "", test: [/octop/i, /(three|3)\s*hearts/i] },
  ];
  const VERD = { chk: ["CHECKING", "chk"], good: ["SUPPORTED", "good"], warn: ["MISLEADING", "warn"], bad: ["CONTRADICTED", "bad"], neu: ["NOT CHECKED", "neu"] };
  const NEG = /\b(not|no|never|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|can'?t|cannot|won'?t|false|myth)\b/i;
  const NOTE_NC = "This board only knows its ten demo claims, and yours isn't one of them. The app checks what's said on your show and puts a sourced verdict on screen within seconds.";
  function matchDemo(s) { const neg = NEG.test(s); return DATA.find((d) => d.test.every((r) => r.test(s)) && neg === !!d.neg); }

  const boardEl = $("#board"), bodyEl = $("#boardBody"), rowsEl = $("#rows"), youEl = $("#you"), input = $("#youInput");
  let clock = 12 * 60 + 4; // show time, in seconds
  const fmt = (s) => `${String(Math.floor(s / 60) % 100).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const showClock = new Display($("#showClock"), { cols: 5, rows: 1, max: 15, min: 12, ratio: 1.4, gx: 2 });
  showClock.fit(5 * 15 + 8);

  let deck = [3, 5, 1, 6, 9, 0, 4, 2, 8, 7], deckAt = 0, spkFlip = 0;
  function nextClaim() {
    const d = DATA[deck[deckAt++ % deck.length]];
    return { ...d, spk: (spkFlip++ % 3 === 1) ? "HOST" : "GUEST", t: clock, state: "chk" };
  }
  const items = [];
  for (let i = 0; i < 6; i++) { const it = nextClaim(); it.state = it.v; it.t = clock - 40 - i * 53; items.push(it); }

  let cfg = null, slots = [], you = null, openSlot = null;
  function boardCfg() { return bodyEl.clientWidth - 36 < 640 ? { phone: true, cc: 17, cr: 2, n: 4 } : { phone: false, cc: 30, cr: 1, n: 6 }; }
  function fitBoard() {
    const W = rowsEl.clientWidth || bodyEl.clientWidth - 36;
    const gx = 2, G = cfg.phone ? 8 : 14;
    let cw;
    if (cfg.phone) cw = Math.floor((W - (cfg.cc - 1) * gx) / cfg.cc);
    else { const cells = 5 + 5 + cfg.cc + 12; cw = Math.floor((W - 12 - 4 * G - (cells - 4) * gx) / cells); }
    cw = Math.max(9, Math.min(cfg.phone ? 24 : 27, cw));
    const s = boardEl.style;
    s.setProperty("--cw", cw + "px"); s.setProperty("--ch", Math.round(cw * 1.42) + "px"); s.setProperty("--gx", gx + "px"); s.setProperty("--gy", "3px");
  }
  function groups(root) {
    const g = (name) => root.querySelector(`[data-g="${name}"]`);
    return {
      time: new Display(g("time"), { cols: 5 }), spk: new Display(g("spk"), { cols: 5 }),
      claim: new Display(g("claim"), { cols: cfg.cc, rows: cfg.cr }), stat: new Display(g("stat"), { cols: 12 }),
    };
  }
  function buildBoard() {
    const next = boardCfg();
    if (cfg && next.phone === cfg.phone) { fitBoard(); return false; }
    cfg = next; closeCard();
    rowsEl.textContent = ""; slots = [];
    for (let i = 0; i < cfg.n; i++) {
      const el = document.createElement("div");
      el.className = "row"; el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-expanded", "false");
      el.innerHTML = `<div class="spin"><div class="face front row-grid"><span class="grp g-time" data-g="time"></span><span class="grp g-spk" data-g="spk"></span><span class="grp g-claim" data-g="claim"></span><span class="grp g-stat" data-g="stat"></span><i class="lamp"></i></div><div class="face back"></div></div>`;
      const slot = { el, lamp: el.querySelector(".lamp"), back: el.querySelector(".back"), item: null, ...groups(el) };
      el.addEventListener("click", () => toggleCard(slot));
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCard(slot); } });
      rowsEl.appendChild(el); slots.push(slot);
    }
    you = groups(youEl);
    input.maxLength = cfg.cc * cfg.cr;
    fitBoard();
    return true;
  }
  function paintSlot(slot, it, o) {
    slot.item = it || null;
    slot.el.classList.toggle("empty", !it);
    if (!it) { ["time", "spk", "claim", "stat"].forEach((k) => slot[k].set("", o)); slot.lamp.className = "lamp"; slot.el.setAttribute("aria-label", "Empty row"); return; }
    const [word, tone] = VERD[it.state];
    slot.time.set(fmt(it.t), o);
    slot.spk.set(it.spk, { ...o, tone: it.spk === "HOST" ? "host" : it.spk === "GUEST" ? "remote" : "you" });
    slot.claim.set(it.short, o);
    slot.stat.set(word, { ...o, tone });
    slot.lamp.className = "lamp " + tone;
    slot.el.setAttribute("aria-label", `${it.spk} at ${fmt(it.t)}: ${it.quote} ${word.toLowerCase()}. Show the verdict.`);
  }
  function paintBoard(o) { slots.forEach((s, i) => paintSlot(s, items[i], { ...o, delay: (o.delay || 0) + i * (o.rowGap || 0) })); }

  function paintYou(o = { steps: 3, d: 40, dLast: 90 }) {
    const focused = document.activeElement === input, v = input.value;
    you.time.set("NOW", { ...o, tone: "you", align: "center" });
    you.spk.set("YOU", { ...o, tone: "you" });
    if (!v && !focused) you.claim.set("TYPE A CLAIM AND PRESS ENTER", { ...o, tone: "mute" });
    else you.claim.set(v, { ...o, raw: true });
    you.stat.set(v ? "BOARD IT" : "YOUR LINE", { ...o, tone: v ? "acc" : "mute", align: "center" });
    you.claim.cells.forEach((c, i) => c.el.classList.toggle("caret", focused && i === Math.min(v.length, you.claim.cells.length - 1)));
  }
  input.addEventListener("input", () => paintYou());
  input.addEventListener("focus", () => paintYou({ steps: 2, d: 40, dLast: 90 }));
  input.addEventListener("blur", () => paintYou({ steps: 2, d: 40, dLast: 90 }));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  $("#boardIt").addEventListener("click", () => { if (input.value.trim()) submit(); else input.focus(); });

  /* arrivals: a new claim boards at the top and the whole board re-flips, like a Solari shifting a row */
  let nextArrival = performance.now() + (RM ? 4000 : 1700);
  function arrive(it) {
    closeCard();
    items.unshift(it); items.length = Math.min(items.length, 8);
    it.resolveAt = performance.now() + (RM ? 3500 : rand(2400, 3600));
    paintBoard({ steps: 7, jitter: 260, rowGap: 55 });
    nextArrival = performance.now() + (RM ? 11000 : rand(6800, 8200));
  }
  function submit() {
    const raw = input.value.trim(); if (!raw) return;
    const m = matchDemo(raw);
    const it = { short: clean(raw).replace(/\s+/g, " ").trim(), quote: raw, spk: "YOU", t: clock, state: "chk", v: m ? m.v : "neu",
      note: m ? `Matched to the demo claim "${m.quote}"${m.note ? " " + m.note : ""}` : NOTE_NC, user: true };
    input.value = "";
    paintYou();
    arrive(it);
  }
  function boardTick() {
    if (document.hidden) return;
    const now = performance.now();
    items.forEach((it, i) => {
      if (it.state === "chk" && it.resolveAt && now >= it.resolveAt) {
        it.state = it.v;
        if (slots[i]) { paintSlot(slots[i], it, { steps: 12, stagger: 34 }); if (openSlot === slots[i]) fillBack(slots[i]); }
      }
    });
    if (seen(boardEl) && !openSlot && now >= nextArrival && !items.some((it) => it.state === "chk")) arrive(nextClaim());
  }
  setInterval(() => {
    if (document.hidden) return;
    if (seen(boardEl)) { clock++; showClock.set(fmt(clock), { steps: 3, d: 45, dLast: 110 }); }
  }, 1000);
  setInterval(boardTick, 250);

  /* click a row: the whole row turns over to its fact-check lower third */
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
  function fillBack(slot) {
    const it = slot.item; if (!it) return;
    const word = it.state === "chk" ? "Checking" : VERD[it.state][0].toLowerCase().replace(/^./, (c) => c.toUpperCase());
    const note = it.state === "chk" ? "System 2 is researching this claim." : it.note;
    slot.back.innerHTML = `<div class="fc v-${it.state}"><div class="fc-verdict"><span class="vw">${word}</span><span class="vm">${esc(it.spk)} · ${fmt(it.t)}</span></div><div class="fc-body"><blockquote>“${esc(it.quote)}”</blockquote>${note ? `<p class="note">${esc(note)}</p>` : ""}</div><span class="flipback">Flip back</span></div>`;
  }
  let backTimer = 0;
  function toggleCard(slot) {
    if (!slot.item) return;
    if (openSlot === slot) { closeCard(); return; }
    closeCard();
    fillBack(slot);
    clearTimeout(slot._t);
    slot.el.classList.add("has-back");
    sfx.flip(true);
    requestAnimationFrame(() => requestAnimationFrame(() => slot.el.classList.add("open")));
    slot.el.setAttribute("aria-expanded", "true");
    openSlot = slot;
  }
  function closeCard() {
    const slot = openSlot; if (!slot) return;
    openSlot = null;
    slot.el.classList.remove("open"); slot.el.setAttribute("aria-expanded", "false");
    sfx.flip(true);
    slot._t = setTimeout(() => slot.el.classList.remove("has-back"), RM ? 0 : 720);
    nextArrival = Math.max(nextArrival, performance.now() + 2500);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });

  /* ---------- sections: titles riffle in on arrival, platform displays cycle ---------- */
  const titles = $$("[data-flap]").map((el) => {
    const text = el.dataset.flap, d = new Display(el, { cols: text.length, rows: 1, max: 40, min: 12, ratio: 1.42, gx: 3 });
    watch(el.parentElement, () => d.set(text, { steps: 18, stagger: 35, jitter: 100 }));
    return { d, host: el.parentElement };
  });
  const cycles = $$("[data-cycle]").map((el) => {
    const msgs = el.dataset.cycle.split("|"), tones = (el.dataset.tones || "").split("|");
    const d = new Display(el, { cols: +el.dataset.cols || 16, rows: 1, max: 24, min: 12, ratio: 1.42 });
    const c = { d, host: el.parentElement, msgs, tones, i: 0 };
    watch(c.host, () => d.set(msgs[0], { tone: tones[0] || "", steps: 12, stagger: 25 }));
    return c;
  });
  let cycleTurn = 0;
  setInterval(() => {
    const c = cycles[cycleTurn++ % cycles.length];
    if (!c || !seen(c.host)) return;
    c.i = (c.i + 1) % c.msgs.length;
    c.d.set(c.msgs[c.i], { tone: c.tones[c.i] || "", steps: 9, stagger: 22 });
  }, RM ? 3000 : 1400);

  /* ---------- sound toggle ---------- */
  const snd = $("#snd");
  snd.addEventListener("click", () => {
    if (!sfx.ctx && !sfx.init()) return;
    sfx.on = !sfx.on;
    if (sfx.on) sfx.ctx.resume(); else sfx.ctx.suspend();
    snd.setAttribute("aria-pressed", String(sfx.on));
    $("#sndLabel").textContent = sfx.on ? "Sound on" : "Sound off";
    if (sfx.on) { dl.stir(4, 300); gateLabel.stir(3, 200); }
  });

  /* ---------- layout ---------- */
  function fitAll(first) {
    buildHeadline(first);
    fitGate();
    const rebuilt = buildBoard();
    if (rebuilt && !first) { paintBoard({ instant: true }); paintYou({ instant: true }); }
    titles.forEach((t) => t.d.fit(t.host.clientWidth));
    cycles.forEach((c) => c.d.fit(c.host.clientWidth));
  }
  let rsT = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = document.documentElement.clientWidth; if (w === lastW) return; lastW = w;
    clearTimeout(rsT); rsT = setTimeout(() => fitAll(false), 60);
  }).observe(document.documentElement);

  /* ---------- first frame ---------- */
  fitAll(true);
  lastW = document.documentElement.clientWidth;
  gateLabel.set(window.CA && !window.CA.isMac ? "MAC ONLY" : "NOW BOARDING", { tone: "you", steps: 10, stagger: 40, delay: 150 });
  dl.set(["DOWNLOAD", "FOR MAC"], { tone: "acc", steps: 16, stagger: 45, jitter: 60, delay: 100 });
  showClock.set(fmt(clock), { instant: true });
  paintBoard({ steps: 18, jitter: 700, rowGap: 90, delay: 250 });
  paintYou({ steps: 10, jitter: 300, delay: 900 });
  watch(titleEl); watch(boardEl, () => {
    const oa = $("#onair"); if (!RM) oa.classList.add("enter");
  });
  setInterval(cycleHeadline, RM ? 6000 : 4600);
})();
