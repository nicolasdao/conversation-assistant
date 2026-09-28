// 02 · The Record Button: the page's state (off air / on air), the captions, the lower thirds, and the key's renderer.
// The key is drawn by scene.js (Three.js) when WebGL works, otherwise by a CSS key with the same API.

const root = document.documentElement;
const params = new URLSearchParams(location.search);
const reduced = (window.CA && window.CA.reducedMotion) || matchMedia("(prefers-reduced-motion: reduce)").matches;
if (reduced) root.classList.add("reduced");

const $ = (id) => document.getElementById(id);
const stage = $("stage"), rec = $("rec"), caps = $("caps"), lower = $("lower");

// What the demo "hears": lines from the brief, alternating host (mic) and guest (call).
const SCRIPT = [
  { who: "host", text: "Okay, enough about models, how was surfing in Sydney this weekend?" },
  { who: "remote", text: "Lightning never strikes the same place twice.", verdict: "contradicted", note: "The Empire State Building is hit about 20–25 times a year." },
  { who: "host", text: "I don't buy that at all, cheap is not the same as good." },
  { who: "remote", text: "Octopuses have three hearts.", verdict: "supported" },
  { who: "host", text: "Coffee dehydrates you.", verdict: "misleading", note: "Its water outweighs the mild diuretic effect." },
  { who: "remote", text: "The Great Wall of China is visible from space with the naked eye.", verdict: "contradicted", note: "Astronauts report it isn't." },
  { who: "host", text: "Bananas are berries.", verdict: "supported", note: "Botanically, yes." },
  { who: "remote", text: "Goldfish only have a three-second memory.", verdict: "contradicted", note: "They remember for months." },
];
const LABEL = { host: "Host · mic", remote: "Guest · call" };

let api = null;
let live = false, line = 0, startedAt = 0, clockTimer = 0, capTimer = 0, checkTimers = [];

// ---------- the key's renderer ----------
function hasWebGL() {
  if (params.has("nogl")) return false;
  try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); }
  catch { return false; }
}

function cssKey() {
  const el = $("csskey"), floor = $("ck-floor");
  el.hidden = false;
  root.classList.add("nogl");
  let who = "host", ringTimer = 0;
  const ring = (c) => {
    if (reduced) return;
    const r = document.createElement("span");
    r.className = "ck-ring";
    r.style.setProperty("--c", `var(--${c})`);
    floor.append(r);
    r.addEventListener("animationend", () => r.remove());
  };
  const tick = () => { ring(live ? who : "accent"); ringTimer = setTimeout(tick, live ? 700 : 2800); };
  tick();
  if (!reduced) window.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--tx", Math.max(-1, Math.min(1, (e.clientX - r.left - r.width / 2) / (innerWidth * 0.45))).toFixed(3));
    el.style.setProperty("--ty", Math.max(-1, Math.min(1, (e.clientY - r.top - r.height / 2) / (innerHeight * 0.55))).toFixed(3));
  }, { passive: true });
  document.addEventListener("visibilitychange", () => { clearTimeout(ringTimer); if (!document.hidden) tick(); });
  const sr = () => stage.getBoundingClientRect();
  return {
    down() { el.classList.add("down"); },
    release() { el.classList.remove("down"); },
    tap() { el.classList.add("down"); setTimeout(() => el.classList.remove("down"), 140); },
    setLive() { clearTimeout(ringTimer); tick(); },
    speaker(w) { who = w; ring(w); },
    keyRect() {
      const r = el.getBoundingClientRect(), s = sr();
      return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
    },
    emitPoint() {
      const k = this.keyRect(), side = Math.random() < 0.5 ? -1 : 1;
      return { x: k.x + k.w / 2 + side * (k.w * (0.5 + Math.random() * 0.5)), y: k.y + k.h * 1.05 };
    },
    wake() {},
  };
}

async function initKey() {
  if (hasWebGL()) {
    try {
      const { createScene } = await import("./scene.js");
      api = createScene({ canvas: $("gl"), stage, reduced });
    } catch (err) { console.warn("WebGL key unavailable, using the CSS key.", err); api = null; }
  }
  if (!api) api = cssKey();
  placeHit();
  new ResizeObserver(placeHit).observe(stage);
  if (params.has("live")) setTimeout(() => { api.tap(); toggle(); }, 500);
}

// the transparent button sits exactly on the key
function placeHit() {
  if (!api) return;
  const k = api.keyRect();
  Object.assign(rec.style, { left: `${k.x}px`, top: `${k.y}px`, width: `${k.w}px`, height: `${k.h}px` });
}

// ---------- on air / off air ----------
function setOnAir(on) {
  const block = $("onair");
  $("onair-label").textContent = on ? "On air" : "Off air";
  block.classList.remove("enter");
  clearTimeout(setOnAir.t);
  if (on) {
    void block.offsetWidth;
    block.classList.add("enter");
    setOnAir.t = setTimeout(() => block.classList.remove("enter"), 1600); // the wipe and sweep are done by then
  }
}

function toggle() {
  live = !live;
  root.classList.toggle("is-live", live);
  rec.setAttribute("aria-pressed", String(live));
  rec.setAttribute("aria-label", live ? "Record key, a demo: press to stop." : "Record key, a demo: press to go live. Nothing is recorded.");
  $("hint-main").textContent = live ? "Press to stop" : "Press to record again";
  $("cue-a").textContent = live ? "You're" : "That's";
  $("cue-b").textContent = live ? "on air." : "a wrap.";
  setOnAir(live);
  api.setLive(live);
  clearInterval(clockTimer);
  clearTimeout(capTimer);
  checkTimers.forEach(clearTimeout);
  checkTimers = [];
  if (live) {
    startedAt = Date.now();
    clockTimer = setInterval(tickClock, 250);
    tickClock();
    capTimer = setTimeout(speak, 450);
  } else {
    dismissThird();
  }
}

function tickClock() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $("clock").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- captions rising out of the rings ----------
function speak() {
  if (!live) return;
  if (!document.hidden) {
    const l = SCRIPT[line++ % SCRIPT.length];
    api.speaker(l.who);
    caption(l);
    if (l.verdict) factCheck(l);
  }
  capTimer = setTimeout(speak, reduced ? 3800 : 2600);
}

function caption(l) {
  const wide = stage.clientWidth >= 900;
  const k = api.keyRect();
  const el = document.createElement("div");
  el.className = `cap ${l.who}${l.verdict ? " claim" : ""}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = LABEL[l.who];
  if (l.verdict) { const f = document.createElement("span"); f.className = "flag"; f.textContent = "Claim"; who.append(f); }
  const said = document.createElement("span");
  said.className = "said";
  said.textContent = l.text;
  el.append(who, said);
  // The host's voice rises on the key's left, the guest's on its right, from the rings at its foot.
  const W = stage.clientWidth, half = (wide ? 300 : 230) / 2 + 12, left = l.who === "host";
  let x = wide ? (left ? k.x - half + 30 : k.x + k.w + half - 30) : (left ? half : W - half);
  x = Math.max(half, Math.min(W - half, x));
  const y = wide ? k.y + k.h * 0.92 : k.y + k.h * 0.7;
  el.style.setProperty("--x", `${x}px`);
  el.style.setProperty("--y", `${y}px`);
  el.style.setProperty("--rise", `${Math.round(wide ? k.h * 0.62 : k.h * 0.75)}px`);
  if (reduced) {
    caps.querySelectorAll(".cap").forEach((c) => c.remove());
    el.style.setProperty("--y", `${k.y + k.h + 40}px`);
    el.style.setProperty("--x", `${k.x + k.w / 2}px`);
    caps.append(el);
    return;
  }
  caps.append(el);
  el.addEventListener("animationend", () => el.remove());
  while (caps.children.length > 6) caps.firstElementChild.remove();
}

// ---------- the fact-check lower third ----------
function third(l, state) {
  const fc = document.createElement("div");
  fc.className = `fc v-${state}`;
  const v = document.createElement("div");
  v.className = "fc-verdict";
  v.innerHTML = `<span class="vw"></span><span class="vm"></span>`;
  v.querySelector(".vw").textContent = state === "researching" ? "Checking" : state;
  v.querySelector(".vm").textContent = state === "researching" ? "System 2" : "Fact-check";
  const b = document.createElement("div");
  b.className = "fc-body";
  const q = document.createElement("p");
  q.className = "restated";
  q.textContent = `"${l.text}"`;
  b.append(q);
  if (state === "researching") {
    const s = document.createElement("span"); s.className = "src"; s.textContent = "Flagged by System 1 · researching the web"; b.append(s);
  } else if (l.note) {
    const n = document.createElement("p"); n.className = "correction"; n.textContent = l.note; b.append(n);
  }
  fc.append(v, b);
  return fc;
}

function showThird(fc) {
  const old = lower.firstElementChild;
  if (old) old.remove();
  lower.append(fc);
}

function dismissThird() {
  const fc = lower.firstElementChild;
  if (!fc) return;
  fc.classList.add("out");
  setTimeout(() => fc.remove(), 420);
}

function factCheck(l) {
  checkTimers.push(setTimeout(() => { if (live) showThird(third(l, "researching")); }, 700));
  checkTimers.push(setTimeout(() => {
    if (!live) return;
    const cur = lower.firstElementChild;
    const next = third(l, l.verdict);
    if (cur && cur.classList.contains("v-researching")) { next.style.animation = "none"; }
    showThird(next);
  }, 1900));
}

// ---------- pressing the key: click, tap, or Space ----------
let pointerHeld = false;
rec.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pointerHeld = true;
  api && api.down();
  // phones: ask once to tilt the key with the device (iOS needs a gesture)
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function" && !rec.dataset.asked) {
    rec.dataset.asked = "1";
    DeviceOrientationEvent.requestPermission().catch(() => {});
  }
});
["pointerleave", "pointercancel"].forEach((t) => rec.addEventListener(t, () => { if (pointerHeld) { pointerHeld = false; api && api.release(); } }));
rec.addEventListener("click", () => {
  if (!api) return;
  if (pointerHeld) { pointerHeld = false; api.release(); } else api.tap();
  toggle();
});

let spaceDown = false;
const typing = (el) => el && (el.closest("a, button, input, textarea, select, [contenteditable]"));
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const r = stage.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return; // only while the key is on screen
  e.preventDefault();
  if (e.repeat || spaceDown || !api) return;
  spaceDown = true;
  api.down();
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !spaceDown) return;
  e.preventDefault();
  spaceDown = false;
  api.release();
  toggle();
});

// a download is worth going on air for
window.addEventListener("ca:download", () => { if (!live && api) { api.tap(); toggle(); } });

// ---------- the rundown: the segment in view is the one on air ----------
const segs = [...document.querySelectorAll(".seg")];
const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => { if (en.isIntersecting) { segs.forEach((s) => s.classList.toggle("cur", s === en.target)); } });
}, { rootMargin: "-45% 0px -45% 0px" });
segs.forEach((s) => io.observe(s));

// the release's version and size, once GitHub names them
if (window.CA) window.CA.ready(() => document.querySelectorAll(".ver").forEach((el) => { el.hidden = false; }));

initKey();
