// 08 Kinetic Poster. Plain scroll maths, no scroll-jacking.
// - Every slab's word is fitted edge to edge: font size first, then the variable width axis, then tracking.
// - The cursor is a blade: over a slab, it cuts along the slant and the halves slide apart along the cut.
// - Scrolling slides slabs sideways, thins their weight, and slices them with the scroll's speed.
// - One word is always live: the slab nearest the middle of the screen turns ON AIR red.
// - Verdicts: CONTRADICTED stamps onto a claim, the poster peels, SUPPORTED stamps onto the next one.
(function () {
  const root = document.documentElement;
  const calm = (window.CA && CA.reducedMotion) || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (calm) root.classList.add("calm");

  const $$ = (sel, r = document) => Array.from(r.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ramp = (v, a, b) => clamp((v - a) / (b - a), 0, 1);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeIn = (t) => t * t;

  // ---------- fitting ----------
  function fit(host, face, line, side, maxF, wg) {
    const set = (fs, wd, ls) => {
      host.style.setProperty("--fs", fs.toFixed(2) + "px");
      host.style.setProperty("--wd", wd.toFixed(2));
      host.style.setProperty("--ls", ls.toFixed(4) + "em");
    };
    host.style.setProperty("--wg", wg);
    const avail = () => {
      const cs = getComputedStyle(face);
      const gap = side ? side.offsetWidth + parseFloat(cs.columnGap || 0) : 0;
      return face.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - gap;
    };
    set(100, 25, 0);
    const w100 = line.offsetWidth || 1;
    let fs = 100;
    for (let i = 0; i < 3; i++) { fs = Math.max(20, (avail() / w100) * 100); set(fs, 25, 0); }
    if (fs > maxF) {
      fs = maxF;
      set(fs, 151, 0);
      const A = avail();
      const wMax = line.offsetWidth;
      if (wMax <= A) {
        // a short word: grow it (up to 1.7x the cap), then track out whatever is left
        fs = Math.min(maxF * 1.7, (fs * A) / wMax);
        set(fs, 151, 0);
        const n = line.textContent.length + line.querySelectorAll(".dot").length;
        set(fs, 151, Math.max(0, (avail() - line.offsetWidth) / n / fs));
      } else {
        let lo = 25, hi = 151;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2; set(fs, mid, 0);
          if (line.offsetWidth > A) hi = mid; else lo = mid;
        }
        set(fs, lo, 0);
      }
    }
    host.style.setProperty("--wg", host.dataset.wg || wg);
    return fs;
  }

  // ---------- slabs ----------
  const slabs = $$(".slab").map((el, i) => {
    const ha = el.querySelector(".half");
    ha.classList.add("ha");
    const hb = ha.cloneNode(true);
    hb.classList.replace("ha", "hb");
    hb.setAttribute("aria-hidden", "true");
    el.appendChild(hb);
    const blade = document.createElement("span");
    blade.className = "blade";
    blade.setAttribute("aria-hidden", "true");
    el.appendChild(blade);
    return {
      el, ha, hb, blade, word: el.classList.contains("word"),
      face: ha.querySelector(".face"), line: ha.querySelector(".line"), side: ha.querySelector(".side"),
      dir: i % 2 ? -1 : 1, rest: parseFloat(el.dataset.rest || 0.6),
      cut: 0, d: 0, v: 0, tgt: 0, hover: false, lastX: null, W: 0, H: 0, S: 0, top: 0, inView: false, shown: false,
    };
  });
  const words = slabs.filter((s) => s.word);

  function fitSlab(s) {
    if (!s.el.offsetParent) return; // hidden (the other platform's block)
    s.el.style.transform = "";
    const vh = innerHeight, vw = innerWidth;
    const maxF = s.word
      ? Math.min(vh * (vw < 600 ? 0.2 : 0.34), vw * 0.3, 380)
      : Math.min(vh * parseFloat(s.el.dataset.max || 0.14), parseFloat(s.el.dataset.maxpx || 150), vw * 0.16);
    const fs = fit(s.el, s.face, s.line, s.side, maxF, 900);
    // the clone copies the same custom properties from the slab, so only layout needs measuring
    s.W = s.el.offsetWidth; s.H = s.ha.offsetHeight; s.S = fs * 0.2;
    s.top = s.el.getBoundingClientRect().top + scrollY;
    s.theta = Math.atan2(s.S, s.H);
    const len = Math.hypot(s.S, s.H);
    s.ux = s.S / len; s.uy = -s.H / len;
    if (!s.hover) s.cut = s.W * s.rest;
    render(s);
  }

  function render(s) {
    const d = s.d;
    if (Math.abs(d) < 0.15 && !s.hover) {
      if (s.shown) {
        s.el.classList.remove("cut");
        s.ha.style.clipPath = ""; s.ha.style.transform = ""; s.hb.style.transform = "";
        s.blade.style.opacity = "0";
        s.shown = false;
      }
      return;
    }
    s.shown = true;
    s.el.classList.add("cut");
    const c = s.cut, S = s.S;
    s.ha.style.clipPath = `polygon(-2px -2px, ${c + S}px -2px, ${c}px calc(100% + 2px), -2px calc(100% + 2px))`;
    s.hb.style.clipPath = `polygon(${c + S}px -2px, calc(100% + 2px) -2px, calc(100% + 2px) calc(100% + 2px), ${c}px calc(100% + 2px))`;
    s.ha.style.transform = `translate3d(${(-s.ux * d).toFixed(2)}px, ${(-s.uy * d).toFixed(2)}px, 0)`;
    s.hb.style.transform = `translate3d(${(s.ux * d).toFixed(2)}px, ${(s.uy * d).toFixed(2)}px, 0)`;
    s.blade.style.transform = `translate3d(${(c + S / 2).toFixed(1)}px, 0, 0) rotate(${s.theta}rad)`;
    s.blade.style.opacity = s.hover ? "1" : String(clamp(Math.abs(d) / 16, 0, 1));
  }

  function stepSlice(s) {
    s.tgt = s.hover ? Math.max(s.tgt * 0.9, 7) : s.tgt * 0.9;
    if (s.tgt < 0.1) s.tgt = 0;
    s.v += (s.tgt - s.d) * 0.2;
    s.v *= 0.7;
    s.d += s.v;
    const moving = s.tgt > 0 || Math.abs(s.v) > 0.02 || Math.abs(s.d) > 0.15;
    if (!moving) { s.d = 0; s.v = 0; }
    render(s);
    return moving;
  }

  let lastPointer = 0;
  slabs.forEach((s) => {
    const el = s.el;
    const cutAt = (e) => {
      const r = el.getBoundingClientRect();
      const ly = clamp(e.clientY - r.top, 0, s.H);
      s.cut = e.clientX - r.left - s.S * (1 - ly / (s.H || 1));
    };
    el.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { s.hover = true; s.lastX = e.clientX; cutAt(e); kick(); } });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      s.hover = true;
      cutAt(e);
      const dx = s.lastX == null ? 0 : e.clientX - s.lastX;
      s.lastX = e.clientX;
      s.tgt = Math.max(s.tgt, Math.min(calm ? 14 : 90, 8 + Math.abs(dx) * 1.7));
      lastPointer = performance.now();
      kick();
    });
    el.addEventListener("pointerleave", () => { s.hover = false; s.lastX = null; kick(); });
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      cutAt(e);
      s.tgt = calm ? 14 : 58;
      lastPointer = performance.now();
      kick();
    });
  });

  // ---------- live ----------
  let live = null;
  function setLive(s) {
    if (s === live) return;
    if (live) live.el.classList.remove("live", "live-enter");
    live = s;
    if (!s) return;
    s.el.classList.add("live");
    if (!calm) {
      s.el.classList.add("live-enter");
      clearTimeout(s.enterT);
      s.enterT = setTimeout(() => s.el.classList.remove("live-enter"), 1500);
    }
  }

  // ---------- verdicts ----------
  const track = document.querySelector(".track");
  const panel = document.querySelector(".panel");
  const sheet1 = document.querySelector(".sheet-1");
  const flap = document.querySelector(".flap");
  const research = document.querySelector(".research");
  const stamps = $$(".stamp").map((el) => ({ el, face: el.querySelector(".face"), line: el.querySelector(".line") }));
  let P = -1, PW = 0, PH = 0, M = 0, trackInView = false;

  function fitStamps() {
    stamps.forEach((st) => {
      const t = st.el.style.transform; st.el.style.setProperty("--sc", 1);
      fit(st.el, st.face, st.line, null, Math.min(innerHeight * 0.26, innerWidth * 0.2, 300), 1000);
      st.el.style.transform = t;
    });
    PW = panel.clientWidth; PH = panel.clientHeight; M = Math.max(PW, PH);
    Object.assign(flap.style, { width: PW + M + "px", height: PH + M + "px" });
    P = -1;
  }

  function clipPoly(pts, g) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ga = g(a), gb = g(b);
      if (ga >= 0) out.push(a);
      if ((ga >= 0) !== (gb >= 0)) { const k = ga / (ga - gb); out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]); }
    }
    return out;
  }
  const poly = (pts, off = 0) => `polygon(${pts.map(([x, y]) => `${(x + off).toFixed(1)}px ${(y + off).toFixed(1)}px`).join(",")})`;

  // Peel from the bottom-right corner: the fold is the line (W - x) + (H - y) = t.
  function peel(t) {
    const W = PW, H = PH;
    if (t <= 0.5) { sheet1.style.clipPath = ""; sheet1.style.visibility = ""; flap.style.display = "none"; return; }
    if (t >= W + H) { sheet1.style.visibility = "hidden"; flap.style.display = "none"; return; }
    sheet1.style.visibility = "";
    const box = [[0, 0], [W, 0], [W, H], [0, H]];
    const f = ([x, y]) => (W - x) + (H - y) - t;
    const keep = clipPoly(box, f);
    const gone = clipPoly(box, (p) => -f(p));
    sheet1.style.clipPath = keep.length > 2 ? poly(keep) : "polygon(0 0, 0 0, 0 0)";
    // the flap is the peeled part, mirrored across the fold: its paper back
    const mirrored = gone.map(([x, y]) => [W + H - t - y, W + H - t - x]);
    flap.style.display = "block";
    flap.style.clipPath = poly(mirrored, M);
    const sf = 0.7071 * (W + H - t + 2 * M);
    flap.style.background = `linear-gradient(135deg, var(--paper) ${(sf - 420).toFixed(0)}px, var(--ink-2) ${(sf - 60).toFixed(0)}px, var(--mute) ${sf.toFixed(0)}px)`;
  }

  function stampAt(st, e, rot0, rot1) {
    const k = easeIn(1 - e);
    st.el.style.setProperty("--sc", (1 + 1.9 * k).toFixed(3));
    st.el.style.setProperty("--op", ramp(e, 0, 0.3).toFixed(3));
    st.el.style.setProperty("--rot", (rot1 + (rot0 - rot1) * k).toFixed(2) + "deg");
    st.el.style.setProperty("--wg", Math.round(150 + 850 * e));
  }

  function updateVerdicts(vh) {
    const r = track.getBoundingClientRect();
    const p = clamp(-r.top / (r.height - vh), 0, 1);
    if (p === P) return;
    P = p;
    research.style.opacity = String(1 - ramp(p, 0.04, 0.12));
    stampAt(stamps[1], ramp(p, 0.04, 0.18), -24, -7); // CONTRADICTED on the first sheet
    peel(easeInOut(ramp(p, 0.3, 0.72)) * (PW + PH) * 1.01);
    stampAt(stamps[0], ramp(p, 0.74, 0.88), 14, -5); // SUPPORTED on the second
  }

  // ---------- the loop: runs only while something moves ----------
  let lastY = scrollY, running = false;
  function kick() { if (!running) { running = true; requestAnimationFrame(frame); } }
  function frame() {
    const vh = innerHeight, vw = innerWidth, y = scrollY, dy = y - lastY;
    lastY = y;
    let active = false;
    let best = null, bd = Infinity;
    for (const s of slabs) {
      if (!s.inView || !s.W) continue;
      const c = s.top + s.H / 2 - y;
      if (s.word) {
        if (!calm) {
          const p = (c - vh / 2) / vh;
          const q = Math.sign(p) * Math.max(0, Math.abs(p) - 0.2);
          const x = s.dir * q * vw * 0.55;
          const rot = -s.dir * q * 5;
          s.el.style.transform = `translate3d(${x.toFixed(1)}px,0,0) rotate(${rot.toFixed(2)}deg)`;
          s.el.style.setProperty("--wg", Math.round(900 - 620 * clamp(Math.abs(q) * 2.4, 0, 1)));
        }
        const dist = Math.abs(c - vh / 2);
        if (dist < bd) { bd = dist; best = s; }
      }
      if (!calm && Math.abs(dy) > 0.5 && !s.hover) {
        s.cut = s.W * s.rest;
        s.tgt = Math.max(s.tgt, Math.min(60, Math.abs(dy) * 0.8));
      }
      if (stepSlice(s)) active = true;
    }
    if (best) setLive(best);
    if (trackInView && !calm) updateVerdicts(vh);
    if (active) requestAnimationFrame(frame); else running = false;
  }

  // ---------- visibility ----------
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      const s = slabs.find((x) => x.el === en.target);
      if (s) { s.inView = en.isIntersecting; s.el.classList.toggle("off", !en.isIntersecting); }
      if (en.target === track) { trackInView = en.isIntersecting; panel.classList.toggle("off", !en.isIntersecting); }
    });
    kick();
  }, { rootMargin: "25% 0px" });
  slabs.forEach((s) => io.observe(s.el));
  io.observe(track);

  function fitAll() {
    slabs.forEach(fitSlab);
    fitStamps();
    if (calm) stamps.forEach((st) => stampAt(st, 1, -7, -7));
    lastY = scrollY;
    kick();
  }

  addEventListener("scroll", kick, { passive: true });
  let rz;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(fitAll, 80); });
  fitAll();
  setLive(words[0]);
  if (document.fonts) {
    document.fonts.load('900 100px "Roboto Flex"').then(fitAll, () => {});
    document.fonts.ready.then(fitAll);
  }
  if (window.CA) CA.ready(() => fitAll());

  // ---------- idle: the blade strikes the live word now and then ----------
  if (!calm) {
    const strike = () => {
      if (document.hidden || performance.now() - lastPointer < 4000) return;
      const s = live;
      if (!s || !s.inView || s.hover) return;
      s.cut = s.W * (0.28 + Math.random() * 0.44);
      s.tgt = 48;
      kick();
    };
    setTimeout(strike, 700);
    setInterval(strike, 3400);
  }

  // a download slices every slab on screen
  addEventListener("ca:download", () => {
    slabs.forEach((s) => { if (s.inView) { s.cut = s.W * (0.2 + Math.random() * 0.6); s.tgt = calm ? 14 : 110; } });
    kick();
  });
})();
