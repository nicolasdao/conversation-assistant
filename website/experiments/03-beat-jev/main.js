// 03 Beat Jev: a live show streams up the screen; flag the checkable claims before Jev (System 1) does.
// Everything runs on a game clock that only advances while the arena is on screen and the tab is visible.
(() => {
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);

  // The only claims we may use (from the brief), each said the way a host might say it.
  const CLAIMS = [
    { say: "And the Great Wall of China is visible from space with the naked eye.", claim: "The Great Wall of China is visible from space with the naked eye.", v: "contradicted", why: "Astronauts report it isn't." },
    { say: "Fun fact: bananas are berries.", claim: "Bananas are berries.", v: "supported", why: "Botanically, yes." },
    { say: "Goldfish only have a three-second memory, apparently.", claim: "Goldfish only have a three-second memory.", v: "contradicted", why: "They remember for months." },
    { say: "Well, lightning never strikes the same place twice.", claim: "Lightning never strikes the same place twice.", v: "contradicted", why: "The Empire State Building is hit about 20–25 times a year." },
    { say: "Mount Everest gets a little taller every year, you know.", claim: "Mount Everest gets a little taller every year.", v: "supported", why: "A few millimetres a year." },
    { say: "I skip it before a long run. Coffee dehydrates you.", claim: "Coffee dehydrates you.", v: "misleading", why: "Its water outweighs the mild diuretic effect." },
    { say: "Everyone knows bats are blind.", claim: "Bats are blind.", v: "contradicted", why: "All bats can see." },
    { say: "Honey found in Egyptian tombs was still edible.", claim: "Honey found in Egyptian tombs was still edible.", v: "supported", why: "It was still edible." },
    { say: "The average person swallows eight spiders a year in their sleep.", claim: "The average person swallows eight spiders a year in their sleep.", v: "contradicted", why: "A myth." },
    { say: "Octopuses have three hearts, by the way.", claim: "Octopuses have three hearts.", v: "supported", why: "Three, yes." },
  ];
  const BANTER = [
    "Okay, enough about models, how was surfing in Sydney this weekend?",
    "I don't buy that at all, cheap is not the same as good.",
    "Wait, is my mic on? You sound like you're in a tunnel.",
    "Ha, that's going straight in the trailer.",
    "Hang on, my cat just walked across the keyboard.",
    "We said we'd keep this one under an hour. We won't.",
    "Honestly, I'd watch a whole show about that.",
    "Let's park that for the end, I have thoughts.",
    "You always say that, and then you order the same thing.",
    "Sorry, the neighbours picked right now to start drilling.",
    "Can we do that bit again? I laughed all over it.",
    "Right, back to the actual topic.",
    "My coffee went cold ten minutes ago and I don't care.",
    "No, no, you go first, you were mid-thought.",
    "Hot take incoming, brace yourself.",
    "I feel like I've told this story on the show before.",
    "Okay, I'm writing that down.",
    "Stop, you're going to make me laugh on air.",
  ];

  const WORD = 0.1; // seconds per word as the caption streams in (with reduced motion the line shows whole, the timing stays)
  const LEAD = 0.15; // the speaker tab shows before the first word
  const JEV = 0.4; // Jev flags a claim this long after it's said
  const RESEARCH = 1.5; // System 2's answer arrives this long after the flag
  const ROUND = 45;
  const GAP = 12; // px between lines, matches .track gap

  const stage = $("stage"), track = $("track"), toasts = $("toasts");
  const els = {
    onair: $("onair"), onairLabel: $("onair-label"), eyebrow: $("eyebrow"), you: $("s-you"), jev: $("s-jev"),
    clockK: $("clock-k"), clockT: $("clock-t"), clock: document.querySelector(".clock"), streak: $("streak"), react: $("react"),
    play: $("play"), meter: $("meter"), result: $("result"),
    tally: { supported: $("t-supported"), contradicted: $("t-contradicted"), misleading: $("t-misleading") },
  };

  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const FLAG_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1v14" stroke="currentColor" stroke-width="2"/><path d="M4 2h9l-2.5 3.5L13 9H4z" fill="currentColor"/></svg>';

  // ---------- what gets said next ----------
  let claimBag = [], banterBag = [], lastKinds = [], speaker = "host";
  function nextItem() {
    const [a, b] = lastKinds.slice(-2);
    let claim;
    if (a === "banter" && b === "banter") claim = true;
    else if (a === "claim" && b === "claim") claim = false;
    else claim = Math.random() < (b === "claim" ? 0.3 : 0.55);
    lastKinds.push(claim ? "claim" : "banter");
    if (Math.random() < 0.72) speaker = speaker === "host" ? "remote" : "host";
    if (claim) { if (!claimBag.length) claimBag = shuffle(CLAIMS); return { kind: "claim", ...claimBag.pop(), speaker }; }
    if (!banterBag.length) banterBag = shuffle(BANTER);
    return { kind: "banter", say: banterBag.pop(), speaker };
  }

  // ---------- state ----------
  let mode = "attract"; // attract | play | over
  let t = 0, showClock = 12 * 60 + 4, left = ROUND;
  let score = fresh();
  let offset = 0, target = 0, instant = false;
  const lines = [], byEl = new Map();
  const tally = { supported: 0, contradicted: 0, misleading: 0 };

  function fresh() { return { you: 0, jev: 0, streak: 0, best: 0, fastest: null, wins: 0 }; }

  function spawn() {
    const it = nextItem();
    const el = document.createElement("div");
    el.className = `ln ${it.speaker}`;
    el.setAttribute("role", "listitem");
    el.innerHTML = `<span class="who ${it.speaker}">${it.speaker === "host" ? "Host" : "Guest"}</span><span class="tx"></span><span class="tag"></span>`;
    track.appendChild(el);
    const words = it.say.split(" ");
    const start = t + LEAD;
    const ln = { el, it, words, tx: el.querySelector(".tx"), tag: el.querySelector(".tag"), who: el.querySelector(".who"),
      start, end: start + words.length * WORD, shown: -1, by: null, flagT: 0, card: false, hitOnce: false };
    lines.push(ln);
    byEl.set(el, ln);
    return ln;
  }

  function flag(ln, by, text, cls) {
    const f = document.createElement("span");
    f.className = `flag ${cls || by}`;
    f.innerHTML = (by === "jev" || by === "you" ? FLAG_SVG : "") + text;
    ln.tag.appendChild(f);
  }

  function jevFlags(ln) {
    ln.by = "jev"; ln.flagT = t;
    ln.el.classList.add("flagged", "researching");
    ln.who.textContent = "System 2";
    flag(ln, "jev", `<span class="lbl">Jev&nbsp;</span>0.40 s`);
    if (mode === "play") {
      score.jev++; score.streak = 0;
      bump(els.jev); paintScore();
    }
  }

  function youFlag(ln) {
    ln.by = "you"; ln.flagT = t;
    const ms = Math.round((t - ln.end) * 1000);
    ln.ms = ms;
    score.you++; score.wins++; score.streak++;
    score.best = Math.max(score.best, score.streak);
    score.fastest = score.fastest === null ? ms : Math.min(score.fastest, ms);
    ln.el.classList.add("flagged", "researching", "won");
    ln.who.textContent = "System 2";
    flag(ln, "you", `<span class="lbl">You&nbsp;</span>${fmtMs(ms)}`);
    els.react.textContent = ms < 0 ? `−${-ms}` : `${ms}`;
    els.react.parentElement.className = "t fast";
    bump(els.you); paintScore();
    pop(ln, score.streak > 2 ? `Streak ×${score.streak}` : "Beat Jev", `+1 · ${fmtMs(ms)}${ms < 0 ? " early" : ""}`);
  }

  function fmtMs(ms) { return ms < 0 ? `−${-ms} ms` : `${ms} ms`; }

  function toCard(ln) {
    ln.card = true;
    tally[ln.it.v]++;
    els.tally[ln.it.v].textContent = tally[ln.it.v];
    const who = ln.by === "you"
      ? `<p class="by you-won">Flagged by you in ${fmtMs(ln.ms)} · beat Jev</p>`
      : `<p class="by">Flagged by <span class="c">Jev</span> in 0.40 s</p>`;
    const word = ln.it.v[0].toUpperCase() + ln.it.v.slice(1);
    const swap = () => {
      ln.el.className = `ln card v-${ln.it.v} ${ln.it.speaker}`;
      ln.el.innerHTML = `<div class="fc-verdict"><span class="vw">${word}</span><span class="vm">System 2</span></div>
        <div class="fc-body"><blockquote>“${esc(ln.it.claim)}”</blockquote><p class="why">${esc(ln.it.why)}</p>${who}</div>`;
    };
    if (instant || RM) { swap(); return; }
    ln.el.classList.add("flip");
    setTimeout(() => { swap(); ln.el.classList.add("flip"); ln.el.style.animationDelay = "-0.28s"; }, 250);
  }

  // ---------- the player ----------
  function hit(ln) {
    if (!ln || ln.card || mode === "over") return;
    if (mode === "attract") startRound();
    if (ln.it.kind === "banter") {
      if (ln.hitOnce) return;
      ln.hitOnce = true;
      score.you--; score.streak = 0;
      ln.el.classList.remove("bust"); void ln.el.offsetWidth; ln.el.classList.add("bust");
      flag(ln, "pen", "Banter −1", "pen");
      bump(els.you); paintScore();
      pop(ln, "−1", "That's banter", "neg");
      return;
    }
    if (ln.by === "you") return;
    if (ln.by === "jev") {
      if (ln.hitOnce) return;
      ln.hitOnce = true;
      score.streak = 0; paintScore();
      const late = Math.round((t - ln.end) * 1000);
      els.react.textContent = `${late}`;
      els.react.parentElement.className = "t slow";
      pop(ln, "Jev had it", `You: ${late} ms · Jev: 400 ms`, "meh");
      return;
    }
    youFlag(ln);
  }

  function newest() {
    for (let i = lines.length - 1; i >= 0; i--) if (t >= lines[i].start - LEAD) return lines[i];
    return null;
  }

  stage.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || e.target.closest(".result")) return;
    const el = e.target.closest(".ln");
    if (el) hit(byEl.get(el));
  });
  addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.key !== " ") return;
    if (e.target.closest && e.target.closest("input, textarea, button, a, [contenteditable]")) return;
    if (!visible || mode === "over") return;
    e.preventDefault();
    if (!e.repeat) hit(newest());
  });

  // ---------- feedback ----------
  function bump(el) { if (RM) return; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  function pop(ln, big, small, cls = "") {
    if (instant) return;
    const s = stage.getBoundingClientRect(), r = ln.el.getBoundingClientRect();
    const p = document.createElement("div");
    p.className = `pop ${cls}`;
    p.innerHTML = `${esc(big)}<small>${esc(small)}</small>`;
    p.style.left = `${Math.min(s.width - 110, Math.max(110, r.right - s.left - 120))}px`;
    p.style.top = `${Math.max(40, r.top - s.top + r.height / 2)}px`;
    toasts.appendChild(p);
    setTimeout(() => p.remove(), 1000);
  }

  function paintScore() {
    els.you.textContent = score.you;
    els.jev.textContent = score.jev;
    els.streak.textContent = `×${score.streak}`;
    els.streak.classList.toggle("hot", score.streak >= 3);
  }

  // The round timer as a segmented meter, red at the left, green at the right, draining from the right.
  const SEGS = [];
  for (let i = 0; i < ROUND; i++) {
    const s = document.createElement("span"), f = i / (ROUND - 1);
    s.style.setProperty("--c", f < 0.5
      ? `color-mix(in srgb, var(--hype) ${Math.round(f * 200)}%, var(--live))`
      : `color-mix(in srgb, var(--good) ${Math.round((f - 0.5) * 200)}%, var(--hype))`);
    els.meter.appendChild(s); SEGS.push(s);
  }
  function paintMeter() { const on = mode === "play" ? Math.ceil(left) : ROUND; SEGS.forEach((s, i) => s.classList.toggle("off", i >= on)); }

  function setOnAir(cls, label) {
    els.onair.className = `onair ${cls}`;
    els.onairLabel.textContent = label;
    if (!RM) { void els.onair.offsetWidth; els.onair.classList.add("enter"); }
  }

  const pad = (n) => String(n).padStart(2, "0");
  function paintClock() {
    if (mode === "play") {
      const s = Math.max(0, Math.ceil(left));
      els.clockT.textContent = `0:${pad(s)}`;
      els.clock.classList.toggle("hurry", s <= 10);
    } else {
      const s = Math.floor(showClock);
      els.clockT.textContent = `${pad((s / 3600) | 0)}:${pad(((s / 60) | 0) % 60)}:${pad(s % 60)}`;
      els.clock.classList.remove("hurry");
    }
  }

  // ---------- rounds ----------
  function startRound() {
    mode = "play"; left = ROUND; score = fresh();
    paintScore();
    els.react.textContent = "—"; els.react.parentElement.className = "t";
    els.result.hidden = true;
    stage.classList.add("playing");
    setOnAir("live", "On air");
    els.eyebrow.textContent = "Beat Jev · tap the claims";
    els.clockK.textContent = "Time left";
    els.play.disabled = true; els.play.textContent = "Live";
    paintClock(); paintMeter();
  }

  function endRound() {
    mode = "over";
    setOnAir("final", "Final");
    els.eyebrow.textContent = "Beat Jev · final score";
    els.clockK.textContent = "On the clock";
    $("r-you").textContent = score.you;
    $("r-jev").textContent = score.jev;
    $("r-line").textContent = score.you > score.jev ? "You beat Jev." : score.you === score.jev ? "Dead heat." : "Jev wins.";
    $("r-stats").textContent = score.wins
      ? `You caught ${score.wins} claim${score.wins === 1 ? "" : "s"} first. Best streak ×${score.best}. Fastest ${fmtMs(score.fastest)} after the sentence ended. Jev: 400 ms, every time.`
      : "You didn't get to a claim before Jev. It answers about 0.4 s after the sentence ends, every time.";
    els.result.hidden = false;
    els.play.disabled = false; els.play.textContent = "Play again";
    paintClock(); paintMeter();
    const btn = els.result.querySelector("[data-download], [data-copy-link]");
    if (btn && btn.offsetParent) btn.focus({ preventScroll: true });
  }

  els.play.addEventListener("click", () => startRound());
  $("again").addEventListener("click", () => startRound());

  // ---------- the loop ----------
  function step(dt) {
    t += dt;
    if (mode === "play") { left -= dt; if (left <= 0) endRound(); }
    else showClock += dt;

    const last = lines[lines.length - 1];
    if (!last || t >= last.end + (last.it.kind === "claim" ? 0.9 : 0.6)) spawn();

    for (const ln of lines) {
      if (ln.card) continue;
      const n = Math.max(0, Math.min(ln.words.length, RM ? ln.words.length : Math.floor((t - ln.start) / WORD) + 1));
      if (n !== ln.shown && t >= ln.start - 0.001) {
        ln.shown = n;
        ln.tx.innerHTML = esc(ln.words.slice(0, n).join(" ")) + (n < ln.words.length ? '<span class="caret"></span>' : "");
      }
      if (ln.it.kind !== "claim") continue;
      if (!ln.by && t >= ln.end + JEV) jevFlags(ln);
      if (ln.by && t >= ln.flagT + RESEARCH) toCard(ln);
    }

    // The stream rises: the newest line settles at the bottom, older ones scroll away.
    target = track.scrollHeight - stage.clientHeight + (mode === "play" ? 24 : 64); // negative while the track is short: it hugs the bottom
    offset = instant || RM ? target : offset + (target - offset) * (1 - Math.exp(-dt * 7));
    while (lines.length > 2) {
      const el = lines[0].el;
      if (el.offsetTop + el.offsetHeight > offset - 60) break;
      const h = el.offsetHeight + GAP;
      el.remove(); byEl.delete(el); lines.shift();
      offset -= h; target -= h;
    }
    track.style.transform = `translateY(${-offset}px)`;
    paintClock();
    if (mode === "play") paintMeter();
  }

  let visible = true, running = false, lastNow = 0;
  const active = () => visible && !document.hidden;
  function frame(now) {
    if (!active()) { running = false; return; }
    const dt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    step(dt);
    requestAnimationFrame(frame);
  }
  function resume() {
    if (running || !active()) return;
    running = true; lastNow = performance.now();
    requestAnimationFrame(frame);
  }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; resume(); }, { threshold: 0.15 }).observe(stage);
  document.addEventListener("visibilitychange", resume);
  addEventListener("resize", () => { if (!running) { instant = true; step(0); instant = false; } });

  // The first frame is already mid-show: fast-forward a few lines of Jev playing alone.
  instant = true;
  track.classList.add("nofx");
  for (let i = 0; i < 400; i++) step(0.05);
  instant = false;
  requestAnimationFrame(() => track.classList.remove("nofx"));
  paintMeter(); paintScore();
  resume();

  // ---------- download celebration: verdict-coloured straps burst from the button ----------
  addEventListener("ca:download", (e) => {
    if (RM || !e.detail || !e.detail.el) return;
    const r = e.detail.el.getBoundingClientRect();
    const cols = ["--accent", "--good", "--warn", "--live", "--paper", "--host", "--remote"];
    for (let i = 0; i < 28; i++) {
      const c = document.createElement("i");
      c.className = "confetti";
      c.style.left = `${r.left + r.width / 2}px`;
      c.style.top = `${r.top + r.height / 2}px`;
      c.style.background = `var(${cols[i % cols.length]})`;
      const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 200;
      c.style.setProperty("--dx", `${Math.cos(a) * d}px`);
      c.style.setProperty("--dy", `${Math.sin(a) * d + 60}px`);
      c.style.setProperty("--r", `${(Math.random() * 720 - 360) | 0}deg`);
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 1200);
    }
  });
})();
