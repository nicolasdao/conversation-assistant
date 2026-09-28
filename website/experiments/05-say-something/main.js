// 05 Say Something: the visitor's voice drives the app's level meter, a waveform ribbon, live captions, and
// (for a few well-known claims) a fact-check lower third. Before the mic is allowed, a simulated voice plays.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const reduced = (window.CA && CA.reducedMotion) || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = getComputedStyle(document.documentElement);
  const tok = (n) => root.getPropertyValue(n).trim();

  const stage = $("stage"), segsEl = $("segs"), ribbon = $("ribbon"), caps = $("captions"), third = $("third");
  const micBtn = $("mic"), micLabel = $("mic-label"), micEyebrow = $("mic-eyebrow");
  const whereTag = $("where-tag"), whereText = $("where-text"), devEl = $("dev"), dbEl = $("db");

  // ---------- the claims the page knows (from the brief), with a loose match ----------
  const CLAIMS = [
    { id: "bats", chip: "Bats are blind", t: (s) => /\bbats?\b|\bbat's\b/.test(s) && /blind/.test(s),
      claim: "Bats are blind.", v: "contradicted", note: "All bats can see." },
    { id: "wall", chip: "The Great Wall is visible from space", t: (s) => /great wall/.test(s) || (/wall/.test(s) && /china/.test(s)),
      claim: "The Great Wall of China is visible from space with the naked eye.", v: "contradicted", note: "Astronauts report it isn't." },
    { id: "banana", chip: "Bananas are berries", t: (s) => /banana/.test(s) && /berr/.test(s),
      claim: "Bananas are berries.", v: "supported", note: "Botanically, yes." },
    { id: "coffee", chip: "Coffee dehydrates you", t: (s) => /coffee/.test(s) && /dehydrat/.test(s),
      claim: "Coffee dehydrates you.", v: "misleading", note: "Its water outweighs the mild diuretic effect." },
    { id: "octopus", chip: "Octopuses have three hearts", t: (s) => /octop/.test(s) && /heart/.test(s),
      claim: "Octopuses have three hearts.", v: "supported", note: "Three, yes." },
    { id: "goldfish", chip: "Goldfish have a three-second memory", t: (s) => /gold ?fish/.test(s),
      claim: "Goldfish only have a three-second memory.", v: "contradicted", note: "They remember for months." },
    { id: "lightning", t: (s) => /lightn?ing/.test(s) && /(twice|same place|same spot)/.test(s),
      claim: "Lightning never strikes the same place twice.", v: "contradicted", note: "The Empire State Building is hit about 20–25 times a year." },
    { id: "everest", t: (s) => /everest/.test(s),
      claim: "Mount Everest gets a little taller every year.", v: "supported", note: "A few millimetres a year." },
    { id: "honey", t: (s) => /honey/.test(s) && /(egypt|tomb|pyramid)/.test(s),
      claim: "Honey found in Egyptian tombs was still edible.", v: "supported", note: "It was." },
    { id: "spiders", t: (s) => /spider/.test(s) && /(swallow|sleep|eat)/.test(s),
      claim: "The average person swallows eight spiders a year in their sleep.", v: "contradicted", note: "A myth." },
  ];
  const VCOLOR = { supported: "--good", contradicted: "--bad", misleading: "--warn" };
  const find = (text) => { const s = text.toLowerCase(); return CLAIMS.find((c) => c.t(s)); };

  // ---------- suggestion chips ----------
  const chipsEl = $("chips");
  chipsEl.innerHTML = '<span class="lbl">Try</span>';
  CLAIMS.filter((c) => c.chip).forEach((c) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.dataset.id = c.id;
    b.style.setProperty("--c", `var(${VCOLOR[c.v]})`);
    b.innerHTML = "<b>Say</b>";
    b.append(`“${c.chip}”`);
    b.addEventListener("click", () => onChip(c, b));
    chipsEl.append(b);
  });

  // ---------- the meter's segments ----------
  let segs = [], segCount = 0;
  function mix(a, b, t) { return `color-mix(in srgb, var(${b}) ${Math.round(t * 100)}%, var(${a}))`; }
  function segColor(p) { // green to yellow to red, blended at the joins
    if (p < 0.6) return "var(--good)";
    if (p < 0.74) return mix("--good", "--hype", (p - 0.6) / 0.14);
    if (p < 0.84) return "var(--hype)";
    if (p < 0.9) return mix("--hype", "--live", (p - 0.84) / 0.06);
    return "var(--live)";
  }
  function buildSegs() {
    const n = Math.max(20, Math.min(64, Math.floor(segsEl.clientWidth / 22)));
    if (n === segCount) return;
    segCount = n; segsEl.textContent = ""; segs = [];
    for (let i = 0; i < n; i++) {
      const s = document.createElement("i");
      s.style.setProperty("--c", segColor((i + 0.5) / n));
      segsEl.append(s); segs.push(s);
    }
  }

  // ---------- the ribbon canvas ----------
  const g = ribbon.getContext("2d");
  let rw = 0, rh = 0, dpr = 1;
  const HIST = 220; const hist = new Float32Array(HIST); let histHead = 0, histAcc = 0;
  let scope = null; // live time-domain samples
  function sizeRibbon() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    rw = ribbon.clientWidth; rh = ribbon.clientHeight;
    ribbon.width = Math.round(rw * dpr); ribbon.height = Math.round(rh * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const HOST = tok("--host"), RULE = tok("--rule"), ACC = tok("--accent");
  function drawRibbon(level) {
    g.clearRect(0, 0, rw, rh);
    const mid = rh / 2, n = HIST, step = rw / (n - 1);
    g.fillStyle = RULE; g.fillRect(0, mid - 0.5, rw, 1);
    // the level history, mirrored, newest on the right
    const grad = g.createLinearGradient(0, 0, rw, 0);
    grad.addColorStop(0, HOST + "00"); grad.addColorStop(0.35, HOST + "55"); grad.addColorStop(1, HOST + "dd");
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i < n; i++) { const v = hist[(histHead + i) % n]; g.lineTo(i * step, mid - v * mid * 0.94); }
    for (let i = n - 1; i >= 0; i--) { const v = hist[(histHead + i) % n]; g.lineTo(i * step, mid + v * mid * 0.94); }
    g.closePath(); g.fill();
    // the live oscillation at the head of the ribbon
    const w = Math.min(rw * 0.3, 360), x0 = rw - w;
    g.strokeStyle = HOST; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i <= 120; i++) {
      let y;
      if (scope) y = scope[Math.floor((i / 120) * (scope.length - 1))] * 2.6;
      else { const k = i / 120; y = level * (Math.sin(k * 31 + clock * 21) * 0.6 + Math.sin(k * 73 - clock * 37) * 0.3 + Math.sin(k * 11 + clock * 5) * 0.25); }
      y = Math.max(-1, Math.min(1, y));
      const x = x0 + (i / 120) * w;
      if (i) g.lineTo(x, mid - y * mid * 0.9); else g.moveTo(x, mid - y * mid * 0.9);
    }
    g.stroke();
    // the "now" playhead
    g.fillStyle = ACC; g.fillRect(rw - 3, 0, 3, rh);
  }

  // ---------- captions ----------
  const lines = []; // finished lines, oldest first
  let cur = { fin: "", int: "", hit: null };
  let ghost = "";
  function renderCaps() {
    caps.textContent = "";
    lines.slice(-2).forEach((t) => { const p = document.createElement("p"); p.className = "cap old"; p.textContent = t; caps.append(p); });
    const p = document.createElement("p"); p.className = "cap";
    if (!cur.fin && !cur.int && ghost) { p.classList.add("ghost"); p.textContent = ghost; }
    else {
      if (cur.fin) { const f = document.createElement("span"); f.className = "fin"; f.textContent = cur.fin; p.append(f); }
      if (cur.int) { const s = document.createElement("span"); s.className = "int"; s.textContent = cur.int; p.append(s); }
    }
    const c = document.createElement("i"); c.className = "caret"; p.append(c);
    caps.append(p);
    if (capNote) { const n = document.createElement("p"); n.className = "cap-note"; n.textContent = capNote; caps.append(n); }
  }
  function commitLine(text) {
    text = text.trim(); if (!text) return;
    lines.push(text); if (lines.length > 6) lines.shift();
    cur = { fin: "", int: "" };
  }
  let capNote = "";

  // ---------- the lower third ----------
  let lastClaim = { id: "", at: -1e9 }, thirdTimer = 0, researchTimer = 0;
  const announce = $("announce");
  function setThird(state, vw, vm, meta, claim, note) {
    third.className = "third " + state;
    $("vw").textContent = vw; $("vm").textContent = vm;
    $("third-meta").textContent = meta; $("third-claim").textContent = claim; $("third-note").textContent = note;
  }
  function idleThird() {
    setThird("idle", "Listening", "for a claim", "Fact-check", "Say something checkable.", "Some claims hide an easter egg.");
  }
  function slam(state, vw, vm, meta, claim, note) {
    setThird(state, vw, vm, meta, claim, note);
    void third.offsetWidth; third.classList.add("slam");
    if (!reduced) { stage.classList.remove("jolt"); void stage.offsetWidth; stage.classList.add("jolt"); }
  }
  let instant = false; // true while the demo pre-rolls: that verdict is already on screen when the page appears
  function onClaim(c) {
    const now = performance.now();
    if (c.id === lastClaim.id && now - lastClaim.at < 9000) return;
    lastClaim = { id: c.id, at: now };
    clearTimeout(thirdTimer); clearTimeout(researchTimer);
    document.querySelectorAll(".chip.hit").forEach((b) => b.classList.remove("hit"));
    const chip = chipsEl.querySelector(`[data-id="${c.id}"]`); if (chip) chip.classList.add("hit");
    const land = () => {
      const word = c.v[0].toUpperCase() + c.v.slice(1);
      (instant ? setThird : slam)("v-" + c.v, word, "Fact-check", "Easter egg · verdict written for this page", c.claim, c.note);
      announce.textContent = `${word}: ${c.claim} ${c.note}`;
      thirdTimer = setTimeout(() => { idleThird(); if (chip) chip.classList.remove("hit"); }, 8000);
    };
    if (instant) { land(); return; }
    setThird("researching", "Checking", "System 2", "Claim flagged", c.claim, "Researching…");
    researchTimer = setTimeout(land, reduced ? 250 : 750);
  }
  window.addEventListener("ca:download", () => {
    clearTimeout(thirdTimer); clearTimeout(researchTimer);
    slam("v-supported", "Supported", "Good call", "Download started", "Conversation Assistant is on its way to your Mac.", "Open the DMG and drag it to Applications.");
    thirdTimer = setTimeout(idleThird, 9000);
  });

  // ---------- the simulated voice (demo mode) ----------
  const SCRIPT = [
    "Bats are blind, everyone knows that.",
    "Okay, enough about models, how was surfing in Sydney this weekend?",
    "Octopuses have three hearts, by the way.",
    "I don't buy that at all, cheap is not the same as good.",
    "Coffee dehydrates you, so I switched to tea.",
    "The Great Wall of China is visible from space with the naked eye.",
    "Bananas are berries. I looked it up.",
  ];
  let scriptIdx = 0;
  const sim = { line: null, t: 0, wait: 0.35 };
  function rnd(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function simStart(text) {
    const words = text.split(/\s+/); let t = 0; const plan = [];
    words.forEach((w, i) => {
      const letters = w.replace(/[^a-z']/gi, "").length || 1;
      const dur = 0.12 + letters * 0.052, syl = Math.max(1, Math.round(letters / 3));
      plan.push({ w, start: t, dur, syl, seed: i * 7 + text.length });
      t += dur + (/[,.?]$/.test(w) ? 0.22 : 0.06);
    });
    sim.line = { text, plan, end: t }; sim.t = 0; sim.flagged = false;
    cur = { fin: "", int: "" };
  }
  function simStep(dt) {
    if (!sim.line) {
      sim.wait -= dt;
      if (sim.wait <= 0) { simStart(SCRIPT[scriptIdx % SCRIPT.length]); scriptIdx++; }
      return 0.02 + Math.random() * 0.02;
    }
    sim.t += dt;
    const L = sim.line; let level = 0.03, said = 0;
    for (const p of L.plan) {
      if (sim.t >= p.start) said++;
      if (sim.t >= p.start && sim.t < p.start + p.dur) {
        const u = (sim.t - p.start) / p.dur, k = Math.min(p.syl - 1, Math.floor(u * p.syl));
        const amp = 0.62 + rnd(p.seed + k) * 0.36;
        level = amp * Math.pow(Math.sin(Math.PI * ((u * p.syl) % 1)), 0.55) + Math.random() * 0.05;
      }
    }
    // stream the words: the last few stay interim, older ones firm up
    const words = L.plan.slice(0, said).map((p) => p.w);
    const firm = Math.max(0, said - 3);
    cur.fin = words.slice(0, firm).join(" ");
    cur.int = words.slice(firm).join(" ");
    if (!sim.flagged) { const c = find(words.join(" ")); if (c) { sim.flagged = true; onClaim(c); } }
    if (sim.t > L.end + 0.35) { commitLine(L.text); sim.line = null; sim.wait = 1.0; }
    return level;
  }
  function onChip(c, b) {
    if (mode === "live" && recOK) {
      b.classList.remove("nudge"); void b.offsetWidth; b.classList.add("nudge");
      ghost = `Say it out loud: “${c.chip}.”`;
      if (!cur.fin && !cur.int) renderCaps();
      return;
    }
    if (mode === "live") { onClaim(c); return; } // live meter but no captions in this browser
    if (sim.line && sim.t > 0.2) commitLine(cur.fin + " " + cur.int);
    simStart(c.claim);
  }

  // ---------- live mode: the visitor's mic ----------
  let mode = "demo", stream = null, actx = null, analyser = null, buf = null, rec = null, recOK = false;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function setMode(m, msg) {
    mode = m; stage.dataset.mode = m;
    if (m === "demo") {
      micEyebrow.textContent = msg ? "Uses your microphone" : "Uses your microphone";
      micLabel.textContent = msg ? "Try again" : "Say something";
      whereTag.textContent = "Demo";
      whereText.textContent = msg || "This demo runs in your browser. The app itself runs on your Mac.";
      devEl.textContent = "Simulated voice";
    } else if (m === "starting") {
      micEyebrow.textContent = "One moment"; micLabel.textContent = "Asking for your mic";
    } else {
      micEyebrow.textContent = "Listening · press to stop"; micLabel.textContent = "Say something";
      whereTag.textContent = "In your browser";
      whereText.textContent = SR
        ? "Captions come from your browser's own speech recognition, which may send audio to its maker. This page saves nothing. The app runs on your Mac."
        : "Nothing leaves this page. The app itself runs on your Mac.";
    }
  }
  async function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMode("demo", "This browser can't share a microphone with a page, so the demo keeps playing."); return;
    }
    setMode("starting");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      stream = null;
      setMode("demo", "The microphone was blocked, so the demo keeps playing. Allow it in the address bar to try again.");
      return;
    }
    if (document.hidden) { stopLive(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC(); try { await actx.resume(); } catch { /* resumes on the next gesture */ }
    analyser = actx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.2;
    actx.createMediaStreamSource(stream).connect(analyser);
    buf = new Float32Array(analyser.fftSize); scope = buf;
    const track = stream.getAudioTracks()[0];
    devEl.textContent = (track && track.label) || "Your microphone";
    sim.line = null; cur = { fin: "", int: "" }; lines.length = 0; capNote = "";
    ghost = "Go on, say something. Try “Bats are blind.”";
    setMode("live");
    startRec();
    renderCaps();
  }
  function startRec() {
    recOK = false;
    if (!SR) { capNote = "This browser has no live captions. Chrome, Edge and Safari do. The meter still hears you."; return; }
    rec = new SR();
    rec.continuous = true; rec.interimResults = true;
    rec.lang = /^en\b/i.test(navigator.language || "") ? navigator.language : "en-US";
    recOK = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], text = r[0].transcript;
        if (r.isFinal) { const c = find(text); if (c) onClaim(c); cur.int = ""; commitLine(text); }
        else interim += text;
      }
      cur.int = interim.trim();
      if (cur.int) { const c = find(cur.int); if (c) onClaim(c); }
      ghost = ""; renderCaps();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "language-not-supported") {
        recOK = false; capNote = "Live captions are switched off in this browser. The meter still hears you."; renderCaps();
      }
    };
    rec.onend = () => { if (mode === "live" && recOK && rec) { try { rec.start(); } catch { /* already started */ } } };
    try { rec.start(); } catch { recOK = false; }
  }
  function stopLive(msg) {
    if (rec) { const r = rec; rec = null; r.onend = null; try { r.abort(); } catch { /* ignore */ } }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (actx) actx.close().catch(() => {});
    stream = null; actx = null; analyser = null; scope = null; recOK = false; capNote = ""; ghost = "";
    if (cur.fin || cur.int) commitLine(cur.fin + " " + cur.int);
    sim.wait = 0.8;
    setMode("demo", msg);
    renderCaps();
  }
  micBtn.addEventListener("click", () => {
    if (mode === "live") stopLive();
    else if (mode === "demo") startLive();
  });

  // ---------- the loop ----------
  let level = 0, shown = 0, peak = 0, peakAt = 0, clock = 0, last = 0, raf = 0, onscreen = true, lastCapsAt = 0;
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now; clock += dt;
    let target;
    if (mode === "live" && analyser) {
      analyser.getFloatTimeDomainData(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-6);
      target = Math.max(0, Math.min(1, (db + 60) / 60));
    } else {
      target = simStep(dt);
      if (now - lastCapsAt > 60) { renderCaps(); lastCapsAt = now; }
    }
    advance(dt, target, now);
    paintMeter();
    drawRibbon(shown);
    schedule();
  }
  function advance(dt, target, now) {
    // meter ballistics: fast attack, slower release (calmer still with reduced motion)
    const att = reduced ? 0.12 : 0.6, rel = reduced ? 0.04 : 0.14;
    level += (target - level) * (target > level ? att : rel);
    shown = level;
    if (shown >= peak || now - peakAt > 1200) { peak = shown; peakAt = now; }
    histAcc += dt;
    const every = reduced ? 1 / 12 : 1 / 45;
    while (histAcc >= every) { histAcc -= every; hist[histHead] = shown; histHead = (histHead + 1) % HIST; }
  }
  function paintMeter() {
    const lit = Math.round(shown * segCount), pk = Math.min(segCount - 1, Math.round(peak * segCount) - 1);
    for (let i = 0; i < segCount; i++) {
      const on = i < lit;
      if (segs[i]._on !== on) { segs[i]._on = on; segs[i].classList.toggle("on", on); }
      const isPk = i === pk && !on;
      if (segs[i]._pk !== isPk) { segs[i]._pk = isPk; segs[i].classList.toggle("peak", isPk); }
    }
    dbEl.textContent = `${shown < 0.01 ? "−∞" : "−" + Math.round((1 - shown) * 60)} dB`;
  }
  function schedule() { if (!raf && onscreen && !document.hidden) raf = requestAnimationFrame(frame); }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (mode !== "demo") stopLive("The mic stopped when you left the tab. Press to use it again."); }
    else { last = 0; schedule(); }
  });
  new IntersectionObserver((es) => { onscreen = es[0].isIntersecting; if (onscreen) { last = 0; schedule(); } }).observe(stage);
  addEventListener("resize", () => { buildSegs(); sizeRibbon(); });

  buildSegs(); sizeRibbon(); idleThird();
  // start mid-sentence, so the very first frame (and a still screenshot) is already talking
  const t0 = performance.now();
  lines.push("I don't buy that at all, cheap is not the same as good.");
  instant = true;
  for (let t = 0; t < 2.5; t += 1 / 60) { clock += 1 / 60; advance(1 / 60, simStep(1 / 60), t0 - (2.5 - t) * 1000); }
  instant = false;
  paintMeter(); drawRibbon(shown); renderCaps(); schedule();
})();
