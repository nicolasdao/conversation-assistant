// 01 — Breaking News. The page is a live channel: an opening sequence, captions with fact-check lower thirds,
// a crawling ticker whose items open into full lower thirds, and segments that arrive as you scroll.
(() => {
  const root = document.documentElement;
  root.classList.add("js");
  const RM = window.CA ? window.CA.reducedMotion : matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  document.addEventListener("visibilitychange", () => root.classList.toggle("is-hidden", document.hidden));

  const CLAIMS = [
    { v: "contradicted", c: "The Great Wall of China is visible from space with the naked eye.", n: "Astronauts report it isn't." },
    { v: "supported", c: "Bananas are berries.", n: "Botanically, yes." },
    { v: "contradicted", c: "Goldfish only have a three-second memory.", n: "They remember for months." },
    { v: "misleading", c: "Coffee dehydrates you.", n: "Its water outweighs the mild diuretic effect." },
    { v: "contradicted", c: "Lightning never strikes the same place twice.", n: "The Empire State Building is hit about 20–25 times a year." },
    { v: "supported", c: "Mount Everest gets a little taller every year.", n: "A few millimetres a year." },
    { v: "contradicted", c: "Bats are blind.", n: "All bats can see." },
    { v: "supported", c: "Honey found in Egyptian tombs was still edible.", n: "" },
    { v: "contradicted", c: "The average person swallows eight spiders a year in their sleep.", n: "" },
    { v: "supported", c: "Octopuses have three hearts.", n: "" },
  ];
  const NEWS = [
    ["Also", "Chat about the transcript with ⌘K, live or afterwards"],
    ["Privacy", "No server, no account, no analytics"],
    ["Release", "Signed and notarized by Apple. It updates itself"],
  ];
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  function ltHTML(x, state) {
    const v = state || x.v;
    const word = v === "researching" ? "Checking" : cap(v);
    const meta = v === "researching" ? "System 2" : "Fact check";
    const note = v === "researching" ? "Researching the web…" : x.n;
    return `<div class="lt v-${v}"><div class="lt-v"><span class="vw">${word}</span><span class="vm">${meta}</span></div>` +
      `<div class="lt-b"><p class="lt-c">“${esc(x.c)}”</p>${note ? `<p class="lt-n">${esc(note)}</p>` : ""}</div></div>`;
  }

  /* ---------------------------------------------------------------- clocks */
  const tc = $("tc"), elapsed = $("elapsed"), tkClock = $("tkClock"), identTime = $("identTime"), sweep = $("sweep");
  let onAirAt = performance.now();
  function frame(now) {
    const ms = Math.max(0, now - onAirAt), s = Math.floor(ms / 1000);
    const f = RM ? 0 : Math.floor(ms / (1000 / 30)) % 30;
    tc.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
    elapsed.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    if (!RM) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  if (RM) setInterval(() => { if (!document.hidden) frame(performance.now()); }, 1000);

  // the studio clock: sixty dots light up with the seconds, a red sweep follows them
  const dotsG = $("dots"), barsG = $("bars"), NS = "http://www.w3.org/2000/svg";
  const dots = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", (200 + Math.cos(a) * 172).toFixed(2));
    c.setAttribute("cy", (200 + Math.sin(a) * 172).toFixed(2));
    c.setAttribute("r", i % 5 === 0 ? 6 : 4.2);
    dotsG.appendChild(c); dots.push(c);
    if (i % 5 === 0) {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", 198); r.setAttribute("y", 44); r.setAttribute("width", 4); r.setAttribute("height", i % 15 === 0 ? 18 : 10);
      r.setAttribute("transform", `rotate(${i * 6} 200 200)`);
      barsG.appendChild(r);
    }
  }
  let turns = 0, lastSec = -1;
  function clockTick() {
    if (document.hidden) return;
    const d = new Date(), sec = d.getSeconds();
    identTime.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(sec)}`;
    tkClock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    dots.forEach((c, i) => { c.classList.toggle("on", i < sec); c.classList.toggle("now", i === sec); });
    if (sec < lastSec) turns++;
    lastSec = sec;
    sweep.style.setProperty("--a", `${turns * 360 + sec * 6}deg`);
  }
  clockTick();
  setInterval(clockTick, 250);

  /* ---------------------------------------------------------------- captions and the on-screen lower third */
  const SCRIPT = [
    { who: "remote", name: "Guest", text: CLAIMS[0].c, claim: CLAIMS[0] },
    { who: "host", name: "Host", text: "Okay, enough about models, how was surfing in Sydney this weekend?" },
    { who: "remote", name: "Guest", text: CLAIMS[4].c, claim: CLAIMS[4] },
    { who: "host", name: "Host", text: "I don't buy that at all, cheap is not the same as good." },
    { who: "remote", name: "Guest", text: CLAIMS[3].c, claim: CLAIMS[3] },
    { who: "host", name: "Host", text: CLAIMS[1].c, claim: CLAIMS[1] },
  ];
  const hero = $("top"), capEl = $("cap"), capWho = $("capWho"), capWords = $("capWords"), slot = $("ltSlot");
  let heroVisible = true, token = 0, lineIdx = 0;
  new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; }).observe(hero);
  capEl.classList.add("idle");

  function showLT(claim, state, stamp) {
    slot.innerHTML = ltHTML(claim, state);
    const lt = slot.firstChild;
    lt.classList.add(stamp ? "stamp" : "enter");
  }
  async function hideLT() {
    const lt = slot.firstChild;
    if (!lt) return;
    if (RM) { slot.innerHTML = ""; return; }
    lt.classList.add("out");
    await wait(280);
    if (slot.firstChild === lt) slot.innerHTML = "";
  }
  async function runCaptions(startDelay) {
    const my = ++token;
    const alive = () => my === token;
    await wait(startDelay);
    while (alive()) {
      while ((document.hidden || !heroVisible) && alive()) await wait(400);
      if (!alive()) return;
      const line = SCRIPT[lineIdx++ % SCRIPT.length];
      capEl.style.setProperty("--c", `var(--${line.who})`);
      capWho.textContent = line.name;
      capWords.textContent = "";
      capEl.classList.remove("idle");
      if (line.claim) hideLT();
      if (RM) capWords.textContent = line.text;
      else {
        for (const w of line.text.split(" ")) {
          if (!alive()) return;
          const s = document.createElement("span");
          s.textContent = w;
          capWords.append(s, " ");
          await wait(/[.,?!]$/.test(w) ? 300 : 135);
        }
      }
      if (!alive()) return;
      if (line.claim) {
        if (!RM) { showLT(line.claim, "researching"); await wait(1300); if (!alive()) return; }
        showLT(line.claim, null, !RM);
        await wait(RM ? 8000 : 3800);
      } else await wait(RM ? 6000 : 2300);
    }
  }

  /* ---------------------------------------------------------------- the opening sequence, and taking it live again */
  const stinger = document.querySelector(".stinger");
  let settleT = 0;
  function goLive(first) {
    clearTimeout(settleT);
    hero.classList.remove("is-live", "settled");
    void hero.offsetWidth;
    hero.classList.add("is-live");
    settleT = setTimeout(() => hero.classList.add("settled"), 2400);
    onAirAt = performance.now();
    if (RM) frame(onAirAt);
    slot.innerHTML = "";
    capEl.classList.add("idle");
    lineIdx = 0;
    runCaptions(first ? 1200 : 1500);
  }
  $("golive").addEventListener("click", () => {
    if (!RM) {
      stinger.classList.remove("run"); void stinger.offsetWidth; stinger.classList.add("run");
      setTimeout(() => goLive(false), 260);
    } else goLive(false);
    if (scrollY > 40) scrollTo({ top: 0, behavior: RM ? "auto" : "smooth" });
  });
  goLive(true);

  /* ---------------------------------------------------------------- the ticker */
  const ticker = $("ticker"), track = $("tkTrack"), card = $("tkCard");
  function tickerRun(copy) {
    let h = "";
    CLAIMS.forEach((x, i) => {
      h += `<button type="button" class="tk-item v-${x.v}" data-i="${i}"${copy ? ' tabindex="-1" aria-hidden="true"' : ""}><span class="v">${cap(x.v)}</span>${esc(x.c)}</button><span class="tk-sep"></span>`;
      if (i % 3 === 2) { const n = NEWS[(i / 3) | 0]; h += `<span class="tk-news"${copy ? ' aria-hidden="true"' : ""}><b>${n[0]}</b>${esc(n[1])}</span><span class="tk-sep"></span>`; }
    });
    return h;
  }
  track.innerHTML = tickerRun(false) + (RM ? "" : tickerRun(true));
  function setSpeed() { track.style.setProperty("--dur", `${Math.round(track.scrollWidth / 2 / 85)}s`); }
  setSpeed();
  document.fonts && document.fonts.ready.then(setSpeed);

  let pinned = null, openFor = null, hideT = 0;
  function openCard(btn) {
    clearTimeout(hideT);
    if (openFor === btn) return;
    track.querySelectorAll(".tk-item.on").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    openFor = btn;
    const x = CLAIMS[+btn.dataset.i];
    card.innerHTML = ltHTML(x);
    card.className = `tk-card v-${x.v}`;
    card.hidden = false;
    card.firstChild.classList.add(RM ? "shown" : "stamp");
    const r = btn.getBoundingClientRect(), w = card.offsetWidth;
    const left = Math.max(12, Math.min(innerWidth - w - 12, r.left));
    card.style.setProperty("--x", `${left}px`);
    card.style.setProperty("--ax", `${Math.max(12, Math.min(w - 28, r.left + 20 - left))}px`);
    ticker.classList.add("hold");
  }
  function closeCard() {
    clearTimeout(hideT);
    card.hidden = true; openFor = null; pinned = null;
    track.querySelectorAll(".tk-item.on").forEach((b) => b.classList.remove("on"));
    ticker.classList.remove("hold");
  }
  const laterClose = () => { if (!pinned) { clearTimeout(hideT); hideT = setTimeout(closeCard, 180); } };
  track.addEventListener("pointerover", (e) => {
    const b = e.target.closest(".tk-item");
    if (b && e.pointerType === "mouse" && !pinned) openCard(b);
  });
  track.addEventListener("pointerout", (e) => {
    const b = e.target.closest(".tk-item");
    if (b && e.pointerType === "mouse" && !b.contains(e.relatedTarget)) laterClose();
  });
  track.addEventListener("click", (e) => {
    const b = e.target.closest(".tk-item");
    if (!b) return;
    if (pinned === b) { closeCard(); return; }
    openFor = null; pinned = null; openCard(b); pinned = b;
  });
  track.addEventListener("focusin", (e) => { const b = e.target.closest(".tk-item"); if (b && b.matches(":focus-visible")) openCard(b); });
  track.addEventListener("focusout", () => { if (!pinned) laterClose(); });
  card.addEventListener("pointerenter", () => clearTimeout(hideT));
  card.addEventListener("pointerleave", laterClose);
  document.addEventListener("click", (e) => { if (pinned && !e.target.closest(".tk-item, .tk-card")) closeCard(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });
  addEventListener("resize", () => { closeCard(); setSpeed(); });

  /* ---------------------------------------------------------------- segments arrive as you scroll */
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      io.unobserve(e.target);
      e.target.querySelectorAll(".count").forEach(countUp);
    });
  }, { threshold: 0.2, rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  function countUp(el) {
    const to = parseFloat(el.dataset.to), dec = +el.dataset.dec;
    if (RM || to === 0) { el.textContent = to.toFixed(dec); return; }
    const t0 = performance.now(), dur = 1100;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = (to * e).toFixed(dec);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // the fact-check desk: verdicts stamp in one after another, the last one resolves from "checking"
  const desk = $("desk");
  new IntersectionObserver(([e], obs) => {
    if (!e.isIntersecting) return;
    obs.disconnect();
    const cards = [...desk.querySelectorAll(".stampable")];
    if (RM) {
      cards.forEach((c) => c.classList.add("shown"));
      resolvePending();
      return;
    }
    cards.forEach((c, i) => setTimeout(() => c.classList.add("stamp"), i * 320));
    setTimeout(resolvePending, cards.length * 320 + 1800);
  }, { threshold: 0.3 }).observe(desk);
  function resolvePending() {
    const p = $("pending");
    const x = CLAIMS[5];
    p.className = `lt v-${x.v} shown resolved`;
    p.querySelector(".vw").textContent = cap(x.v);
    p.querySelector(".vm").textContent = "Fact check";
    p.querySelector(".lt-n").textContent = x.n;
  }

  // the transcript streams word by word while the timeline fills in behind the now line
  const UTTS = [
    { who: "host", name: "Host", t: "12:04", text: "Okay, enough about models, how was surfing in Sydney this weekend?" },
    { who: "remote", name: "Guest", t: "12:09", text: "Flat, mostly. But the guide swore bats are blind.", flag: "contradicted" },
    { who: "host", name: "Host", t: "12:15", text: "Octopuses have three hearts. That one I know.", flag: "supported" },
    { who: "remote", name: "Guest", t: "12:21", text: "And bananas are berries, apparently.", flag: "supported" },
  ];
  const utts = $("utts"), tl = $("tl"), mon = $("mon");
  let monStarted = false, monVisible = false;
  new IntersectionObserver(([e]) => {
    monVisible = e.isIntersecting;
    if (monVisible && !monStarted) { monStarted = true; streamTranscript(); }
  }, { threshold: 0.35 }).observe(mon);

  async function streamTranscript() {
    const words = UTTS.reduce((n, u) => n + u.text.split(" ").length, 0);
    let done = 0;
    const setP = () => tl.style.setProperty("--pn", (done / words).toFixed(4));
    for (const u of UTTS) {
      const li = document.createElement("li");
      li.className = `utt ${u.who}`;
      li.innerHTML = `<span class="time">${u.t}</span><span class="who">${u.name}</span><span class="text"></span>`;
      utts.append(li);
      const text = li.querySelector(".text");
      if (RM) { text.textContent = u.text; done += u.text.split(" ").length; }
      else {
        for (const w of u.text.split(" ")) {
          while (document.hidden || !monVisible) await wait(300);
          const s = document.createElement("span");
          s.textContent = w;
          text.append(s, " ");
          done++; setP();
          await wait(/[.,?!]$/.test(w) ? 280 : 120);
        }
      }
      if (u.flag) {
        const f = document.createElement("span");
        f.className = `flag v-${u.flag}`;
        f.textContent = cap(u.flag);
        text.append(f);
      }
      if (!RM) await wait(450);
    }
    done = words; setP();
    tl.classList.add("done");
  }

  /* ---------------------------------------------------------------- the download celebration */
  const flash = $("flash");
  let flashT = 0;
  addEventListener("ca:download", () => {
    flash.classList.remove("show"); void flash.offsetWidth; flash.classList.add("show");
    clearTimeout(flashT);
    flashT = setTimeout(() => flash.classList.remove("show"), 4200);
  });
})();
