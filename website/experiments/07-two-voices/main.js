// 07 Two Voices.
// Two particle clouds (the host and the guest) talk. Each spoken word leaves the speaker as a stream of light and
// resolves into a crisp transcript word. The cursor is System 1: a cyan lens. Pass it over a claim's particles
// (or its words) and a lattice net catches the claim and carries it to the System 2 orb, which answers with a
// verdict lower third. Scrolling moves through three beats: listen, map (particles settle into timeline lanes), check.
// Rendering: raw WebGL points with additive blending; a 2D-canvas renderer when WebGL is missing; CSS glows with no canvas.
(() => {
  "use strict";
  const stage = document.querySelector(".stage");
  if (!stage) return;
  const story = document.getElementById("story");
  const glCanvas = stage.querySelector("canvas.gl");
  const fxCanvas = stage.querySelector("canvas.fx");
  const linesEl = stage.querySelector(".lines");
  const ltsEl = stage.querySelector(".lts");
  const lensEl = stage.querySelector(".lens");
  const lanesEl = stage.querySelector(".lanes");
  const nowEl = stage.querySelector(".nowline");
  const clockEl = stage.querySelector(".clock");
  const chyron = stage.querySelector(".chyron");
  const RM = window.CA ? window.CA.reducedMotion : matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- colours, straight from the theme tokens ----------
  const rootStyle = getComputedStyle(document.documentElement);
  const col = (name) => {
    const h = rootStyle.getPropertyValue("--" + name).trim() || "#ffffff";
    const v = parseInt(h.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  };
  const HOST = col("host"), REMOTE = col("remote"), ACC = col("accent"), INK = col("ink"), HEAT = col("heat"), HYPE = col("hype");
  const VCOL = { supported: col("good"), contradicted: col("bad"), misleading: col("warn"), unverifiable: col("neutral") };
  const VLABEL = { supported: "Supported", contradicted: "Contradicted", misleading: "Misleading", unverifiable: "Unverifiable" };
  const mix = (a, b, t, o) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const rand = Math.random;

  // ---------- renderers ----------
  const VS = `attribute vec2 p; attribute float s; attribute vec4 c; uniform vec2 res; uniform float dpr; varying vec4 vc;
    void main(){ vec2 q = p / res * 2.0 - 1.0; gl_Position = vec4(q.x, -q.y, 0.0, 1.0); gl_PointSize = s * 3.0 * dpr; vc = c; }`;
  const FS = `precision mediump float; varying vec4 vc;
    void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
      float core = smoothstep(0.36, 0.18, r); float halo = pow(1.0 - r, 3.0) * 0.42;
      gl_FragColor = vec4(vc.rgb * vc.a * (core + halo), 1.0); }`;

  function webglRenderer(canvas) {
    let gl = null;
    try { gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: "low-power" }); } catch { gl = null; }
    if (!gl) return null;
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = shader(gl.VERTEX_SHADER, VS), fs = shader(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const attr = (n, size, off) => { const l = gl.getAttribLocation(prog, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 28, off); };
    attr("p", 2, 0); attr("s", 1, 8); attr("c", 4, 12);
    const uRes = gl.getUniformLocation(prog, "res"), uDpr = gl.getUniformLocation(prog, "dpr");
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    const bg = col("ground");
    const MAX = 14000, data = new Float32Array(MAX * 7);
    let n = 0, W = 1, H = 1, D = 1;
    return {
      kind: "webgl",
      resize(w, h, dpr) { W = w; H = h; D = dpr; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); gl.viewport(0, 0, canvas.width, canvas.height); },
      begin() { n = 0; },
      pt(x, y, s, c, a) {
        if (n >= MAX || a < 0.004 || x < -40 || y < -40 || x > W + 40 || y > H + 40) return;
        const o = n * 7; data[o] = x; data[o + 1] = y; data[o + 2] = s; data[o + 3] = c[0]; data[o + 4] = c[1]; data[o + 5] = c[2]; data[o + 6] = a; n++;
      },
      end() {
        gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(uRes, W, H); gl.uniform1f(uDpr, D);
        gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 7), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.POINTS, 0, n);
      },
    };
  }

  function canvasRenderer(canvas) {
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return null;
    const bg = rootStyle.getPropertyValue("--ground").trim();
    const sprites = new Map();
    let W = 1, H = 1;
    const sprite = (c) => {
      const k = (Math.round(c[0] * 15) << 8) | (Math.round(c[1] * 15) << 4) | Math.round(c[2] * 15);
      let s = sprites.get(k);
      if (s) return s;
      s = document.createElement("canvas"); s.width = s.height = 48;
      const g = s.getContext("2d"), rgb = `${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0}`;
      const gr = g.createRadialGradient(24, 24, 0, 24, 24, 24);
      gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.2, `rgba(${rgb},0.95)`); gr.addColorStop(0.34, `rgba(${rgb},0.3)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, 48, 48); sprites.set(k, s); return s;
    };
    return {
      kind: "2d",
      resize(w, h, dpr) { W = w; H = h; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); },
      begin() { ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = "lighter"; },
      pt(x, y, s, c, a) { if (a < 0.004) return; const d = s * 3; ctx.globalAlpha = a > 1 ? 1 : a; ctx.drawImage(sprite(c), x - d / 2, y - d / 2, d, d); },
      end() { ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; },
    };
  }

  const force2d = /renderer=2d/.test(location.search);
  const R = (!force2d && webglRenderer(glCanvas)) || canvasRenderer(glCanvas);
  if (!R) return; // no canvas at all: the CSS glows and the static transcript stay
  const fx = fxCanvas.getContext("2d");
  stage.classList.add("live");
  stage.dataset.renderer = R.kind;

  // ---------- the conversation ----------
  // [brackets] mark the claim. It loops; the page opens on its last two lines, already in the transcript.
  const SCRIPT = [
    { who: "host", text: "Ha. My kid swears that [bats are blind], too.", v: "contradicted", say: "Bats are blind.", note: "All bats can see." },
    { who: "remote", text: "Okay, but [octopuses have three hearts]. That one is real.", v: "supported", say: "Octopuses have three hearts.", note: "" },
    { who: "host", text: "I read that [coffee dehydrates you], so this is water.", v: "misleading", say: "Coffee dehydrates you.", note: "Its water outweighs the mild diuretic effect." },
    { who: "remote", text: "And apparently [goldfish only have a three-second memory].", v: "contradicted", say: "Goldfish only have a three-second memory.", note: "They remember for months." },
    { who: "host", text: "One for the show notes: [bananas are berries].", v: "supported", say: "Bananas are berries.", note: "Botanically, yes." },
    { who: "remote", text: "Also, [Mount Everest gets a little taller every year].", v: "supported", say: "Mount Everest gets a little taller every year.", note: "A few millimetres a year." },
    { who: "host", text: "Last one: [the Great Wall of China is visible from space with the naked eye].", v: "contradicted", say: "The Great Wall of China is visible from space with the naked eye.", note: "Astronauts report it isn't." },
    { who: "remote", text: "Before we go, [honey found in Egyptian tombs was still edible].", v: "supported", say: "Honey found in Egyptian tombs was still edible.", note: "" },
    { who: "host", text: "Okay, enough about models, how was surfing in Sydney this weekend?" },
    { who: "remote", text: "Freezing. A storm rolled in, and [lightning never strikes the same place twice], right?", v: "contradicted", say: "Lightning never strikes the same place twice.", note: "The Empire State Building is hit about 20 to 25 times a year." },
  ];
  const CLOCK0 = 12; // the show clock when the page opens
  const stamp = (s) => { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  // ---------- state ----------
  let W = 1, H = 1, SL = 0, ST = 0, small = false, T = 0, beat = 0, beatT = 0;
  const cloud = (c, dir) => ({ c, dir, ps: [], x: 0, y: 0, R: 100, env: 0, speaking: false, wordT: -9, wordD: 0.3, lit: 0, burst: 0 });
  const clouds = { host: cloud(HOST, 1), remote: cloud(REMOTE, -1) };
  const meters = { host: [...stage.querySelectorAll("#v-host .meter i")], remote: [...stage.querySelectorAll("#v-remote .meter i")] };
  const orb = { x: 0, y: 0, R: 22, ps: [], busy: 0, spin: 0, flash: 0 };
  const anchors = { host: document.getElementById("v-host"), remote: document.getElementById("v-remote"), orb: document.getElementById("orb") };
  const streams = []; // word particles in flight
  const activeWords = new Set();
  const claims = []; // open and in-progress claims
  const rings = [];
  const lens = { x: 0, y: 0, R: 48, init: false };
  const ptr = { x: 0, y: 0, t: -99, ui: false };
  const eng = { i: 0, line: null, next: 0.7 };

  function buildCloud(cl, n) {
    cl.ps = [];
    for (let i = 0; i < n; i++) {
      const z = 2 * rand() - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      const shell = rand() < 0.7;
      const haze = rand() < 0.08;
      cl.ps.push({
        ux: s * Math.cos(a), uy: z, uz: s * Math.sin(a),
        r: shell ? 0.6 + 0.4 * Math.pow(rand(), 0.7) : 0.6 * Math.pow(rand(), 0.75),
        sz: haze ? 6 + rand() * 6 : 1.1 + rand() * 1.6 + (rand() < 0.05 ? 1.8 : 0),
        haze, c: rand() < 0.12 ? INK : cl.c, ph: rand() * Math.PI * 2, sp: 0.75 + rand() * 0.5,
        sx: 0, sy: 0, slot: null, b: 0,
      });
    }
  }
  function buildOrb(n) {
    orb.ps = [];
    for (let i = 0; i < n; i++) {
      const z = 2 * rand() - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      orb.ps.push({ ux: s * Math.cos(a), uy: z, uz: s * Math.sin(a), r: 0.45 + 0.55 * Math.pow(rand(), 0.5), sz: 0.9 + rand() * 1.3, c: rand() < 0.3 ? INK : ACC, ph: rand() * 6.3 });
    }
  }

  // ---------- layout ----------
  const rel = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - SL, y: r.top - ST, w: r.width, h: r.height }; };
  function readStage() { const r = stage.getBoundingClientRect(); SL = r.left; ST = r.top; }
  function readAnchors() {
    for (const k of ["host", "remote"]) { const r = rel(anchors[k]); clouds[k].x = r.x; clouds[k].y = r.y; }
    const o = rel(anchors.orb); orb.x = o.x + o.w / 2; orb.y = o.y + o.h / 2; orb.R = o.w * 0.3;
  }
  let built = -1;
  function resize() {
    W = stage.clientWidth; H = stage.clientHeight;
    const wasSmall = small; small = W < 720;
    R.resize(W, H, Math.min(2, window.devicePixelRatio || 1));
    const d = Math.min(2, window.devicePixelRatio || 1);
    fxCanvas.width = Math.round(W * d); fxCanvas.height = Math.round(H * d); fx.setTransform(d, 0, 0, d, 0, 0);
    const cr = small ? clamp(W * 0.12, 34, 50) : clamp(Math.min(W * 0.085, H * 0.15), 60, 130);
    clouds.host.R = clouds.remote.R = cr;
    stage.style.setProperty("--R", cr + "px");
    stage.style.setProperty("--chy-h", chyron.offsetHeight + parseFloat(getComputedStyle(chyron).marginBottom) + "px");
    stage.style.setProperty("--lanes-h", lanesEl.offsetHeight + "px");
    lens.R = small ? 40 : 48;
    const n = small ? 520 : 1100;
    if (built !== n || wasSmall !== small) { buildCloud(clouds.host, n); buildCloud(clouds.remote, n); buildOrb(small ? 150 : 240); built = n; }
    readStage(); readAnchors();
    if (!lens.init) { lens.x = W / 2; lens.y = H * 0.62; lens.init = true; }
    computeSlots();
  }

  // ---------- beat 2: particles settle into the timeline lanes ----------
  const curveHeat = (u) => 0.18 + 0.62 * (0.5 + 0.5 * Math.sin(u * 8.2 + 0.6)) * (0.35 + 0.65 * u) + 0.12 * Math.exp(-Math.pow((u - 0.52) / 0.05, 2));
  const curveHype = (u) => 0.14 + 0.32 * (0.5 + 0.5 * Math.sin(u * 5.1 + 2.4)) + 0.4 * Math.exp(-Math.pow((u - 0.86) / 0.07, 2));
  let lanesBox = { x: 0, w: 1 };
  function computeSlots() {
    for (const k of ["host", "remote"]) for (const p of clouds[k].ps) p.slot = null;
    const tracks = lanesEl.querySelectorAll("[data-track]");
    if (!tracks.length) return;
    const pool = [];
    const hp = clouds.host.ps.filter((p) => !p.haze), rp = clouds.remote.ps.filter((p) => !p.haze);
    for (let i = 0; i < Math.max(hp.length, rp.length); i++) { if (hp[i]) pool.push(hp[i]); if (rp[i]) pool.push(rp[i]); }
    const limit = Math.floor(pool.length * 0.72);
    let sp = small ? 5 : 6, slots = [];
    for (let tries = 0; tries < 4; tries++) {
      slots = [];
      for (const tr of tracks) {
        const r = rel(tr), kind = tr.dataset.track;
        if (kind === "chart") {
          const step = sp * 0.7;
          for (let x = r.x; x <= r.x + r.w; x += step) {
            const u = (x - r.x) / r.w;
            slots.push({ x, y: r.y + r.h * (1 - curveHeat(u)), c: HEAT, sz: 1.9 });
            slots.push({ x: x + step / 2, y: r.y + r.h * (1 - curveHype(u)), c: HYPE, sz: 1.9 });
          }
        } else {
          for (const seg of tr.querySelectorAll(".seg")) {
            const s = rel(seg), c = col(seg.dataset.c);
            const cols = Math.max(1, Math.floor(s.w / sp)), rows = Math.max(1, Math.floor(r.h / sp));
            const gx = s.w / cols, gy = r.h / rows;
            for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) slots.push({ x: s.x + (i + 0.5) * gx, y: r.y + (j + 0.5) * gy, c, sz: 1.5 });
          }
        }
      }
      if (slots.length <= limit) break;
      sp *= Math.sqrt(slots.length / limit) * 1.02;
    }
    const lr = rel(tracks[0]); lanesBox = { x: lr.x, w: lr.w, y: lr.y };
    for (let i = pool.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
    slots.forEach((s, i) => { const p = pool[i]; if (!p) return; s.delay = 0.05 + 0.9 * clamp((s.x - lr.x) / lr.w, 0, 1) + rand() * 0.15; p.slot = s; if (beat === 1 && RM) p.b = 1; });
  }

  // ---------- transcript lines ----------
  function parse(text) {
    const out = []; let inClaim = false;
    for (const tok of text.split(" ")) {
      let t = tok, start = false, end = false, tail = "";
      if (t.startsWith("[")) { start = true; inClaim = true; t = t.slice(1); }
      const claim = inClaim;
      const k = t.indexOf("]");
      if (k >= 0) { tail = t.slice(k + 1); t = t.slice(0, k); end = true; }
      out.push({ text: t, tail, claim, start, end });
      if (end) inClaim = false;
    }
    return out;
  }
  function startLine(item) {
    const who = item.who;
    const el = document.createElement("div");
    el.className = `ln ${who}`;
    el.innerHTML = `<div class="ln-in"><span class="who">${who === "host" ? "Host" : "Guest"}<small>${stamp(CLOCK0 + T)}</small></span><p></p></div>`;
    const p = el.querySelector("p");
    const toks = parse(item.text);
    let claim = null, claimEl = null;
    const words = toks.map((tk, i) => {
      if (tk.start) {
        claimEl = document.createElement("span"); claimEl.className = "claim"; p.appendChild(claimEl);
        claim = { data: item, who, el: claimEl, words: [], state: "idle", stamp: stamp(CLOCK0 + T), born: 0 };
        claims.push(claim);
      }
      const span = document.createElement("span"); span.className = "w"; span.textContent = tk.text;
      (tk.claim ? claimEl : p).appendChild(span);
      const w = { text: tk.text, els: [span], el: span, claim: tk.claim ? claim : null, in: false, rect: null, pending: 0, arrive: 0 };
      if (tk.tail) { const ts = document.createElement("span"); ts.className = "w"; ts.textContent = tk.tail; p.appendChild(ts); w.els.push(ts); }
      if (w.claim) claim.words.push(w);
      if (i < toks.length - 1) (tk.claim && !tk.end ? claimEl : p).appendChild(document.createTextNode(" "));
      return w;
    });
    linesEl.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));
    // keep the transcript short
    const all = linesEl.querySelectorAll(".ln");
    for (let i = 0; i < all.length - 7; i++) all[i].remove();
    return { who, el, words, wi: 0, item };
  }
  function reveal(w) { if (w.in) return; w.in = true; for (const e of w.els) e.classList.add("in"); }

  function emitWord(line, w) {
    const cl = clouds[line.who];
    const dur = 0.2 + w.text.length * 0.045;
    cl.wordT = T; cl.wordD = dur;
    if (w.claim && w.claim.state === "idle") { w.claim.state = "open"; w.claim.born = T; }
    if (RM) { reveal(w); return; }
    w.rect = rel(w.el);
    const n = Math.round(clamp(7 + w.text.length * 1.7, 9, 24) * (small ? 0.75 : 1));
    let first = 99;
    for (let i = 0; i < n; i++) {
      const src = cl.ps[(rand() * cl.ps.length) | 0];
      const fromCloud = src.b < 0.5 && src.sx;
      const t0 = T + i * 0.016 + rand() * 0.12, d = 0.85 + rand() * 0.4;
      first = Math.min(first, t0 + d);
      streams.push({
        x0: fromCloud ? src.sx : cl.x + (rand() - 0.5) * cl.R, y0: fromCloud ? src.sy : cl.y + (rand() - 0.5) * cl.R,
        t0, d, fx: 0.08 + rand() * 0.84, fy: 0.25 + rand() * 0.5, lift: 40 + rand() * 90, swing: (rand() - 0.5) * 80,
        sz: (w.claim ? 1.8 : 1.4) + rand() * 1.3, c: cl.c, w, claim: w.claim, x: 0, y: 0, dead: false, net: null, ph: rand() * 6.3,
      });
    }
    w.pending = n; w.arrive = first;
    activeWords.add(w);
  }

  function stepEngine() {
    if (T < eng.next) return;
    if (!eng.line) {
      const item = SCRIPT[eng.i % SCRIPT.length]; eng.i++;
      eng.line = startLine(item);
      clouds[item.who].speaking = true;
      if (RM) { // the calm version: the line appears whole, the voice breathes, the claim is checked without the flight
        eng.line.words.forEach((w) => emitWord(eng.line, w));
        const c = eng.line.words.find((w) => w.claim);
        if (c) { const cl = c.claim; cl.state = "checking"; setTimeout(() => { cl.el.classList.add("netted"); addLowerThird(cl); cl.verdictAt = T + 1.4; }, 900); }
        const line = eng.line; setTimeout(() => { clouds[line.who].speaking = false; }, 2200);
        eng.line = null; eng.next = T + 5.2;
        return;
      }
      eng.next = T + 0.3;
      return;
    }
    const L = eng.line;
    if (L.wi < L.words.length) {
      const w = L.words[L.wi++];
      emitWord(L, w);
      eng.next = T + 0.2 + w.text.length * 0.045 + (/[,.?:]$/.test(w.text + (w.els[1] ? w.els[1].textContent : "")) ? 0.26 : 0.02);
    } else {
      clouds[L.who].speaking = false;
      eng.line = null; eng.next = T + 1.05;
    }
  }

  // ---------- System 1: the lens and its net ----------
  function catchClaim(cl, lx, ly, fromWords) {
    cl.state = "net";
    lensEl.classList.remove("hit"); void lensEl.offsetWidth; lensEl.classList.add("hit");
    cl.el.classList.add("netted");
    // what the net holds: the claim's particles near the lens, or the claim's words
    const caught = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
    for (const p of streams) {
      if (p.claim !== cl || p.dead || T < p.t0) continue;
      if (!fromWords && Math.hypot(p.x - lx, p.y - ly) > 150) continue;
      caught.push(p); grow(p.x, p.y);
    }
    if (fromWords || !caught.length) {
      for (const w of cl.words) if (w.in) { const r = rel(w.el); grow(r.x, r.y); grow(r.x + r.w, r.y + r.h); }
    }
    if (!isFinite(x0)) { x0 = lx - 60; x1 = lx + 60; y0 = ly - 30; y1 = ly + 30; }
    const pad = 14;
    let bw = Math.max(x1 - x0 + pad * 2, 120), bh = Math.max(y1 - y0 + pad * 2, 64);
    bw = Math.min(bw, small ? W - 30 : 520); bh = Math.min(bh, 180);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const cols = clamp(Math.round(bw / 26), 4, 18), rows = clamp(Math.round(bh / 22), 3, 7);
    const nodes = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const bx = cx - bw / 2 + (bw * (i + (j % 2 ? 0.5 : 0))) / (cols - 0.5) + (rand() - 0.5) * 4;
      const by = cy - bh / 2 + (bh * j) / (rows - 1) + (rand() - 0.5) * 4;
      nodes.push({ bx, by, x: bx, y: by, d: Math.hypot(bx - lx, by - ly) });
    }
    const links = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (i < cols - 1) links.push([k, k + 1]);
      if (j < rows - 1) { links.push([k, k + cols]); const dk = j % 2 ? k + cols + 1 : k + cols - 1; if (dk >= (j + 1) * cols && dk < (j + 2) * cols) links.push([k, dk]); }
    }
    for (const p of caught) {
      let best = 0, bd = Infinity;
      nodes.forEach((n, i) => { const d = (n.bx - p.x) ** 2 + (n.by - p.y) ** 2; if (d < bd) { bd = d; best = i; } });
      p.net = { node: best, ox: p.x - nodes[best].bx, oy: p.y - nodes[best].by };
      reveal(p.w);
    }
    const reach = Math.max(...nodes.map((n) => n.d)) || 1;
    cl.net = { nodes, links, cx, cy, t0: T, reach, x: cx, y: cy, scale: 1, alpha: 1 };
  }

  function updateNet(cl) {
    const n = cl.net, s = T - n.t0;
    const CAST = 0.55, CINCH = 0.5, FLY = 1.05;
    let cx = n.cx, cy = n.cy, scale = 1;
    if (s < CAST + CINCH) {
      scale = 1 - 0.62 * ease(clamp((s - CAST) / CINCH, 0, 1));
    } else {
      const f = ease(clamp((s - CAST - CINCH) / FLY, 0, 1));
      const qx = n.cx + (orb.x - n.cx) * 0.2, qy = orb.y + (n.cy - orb.y) * 0.15 - 40;
      const a = 1 - f;
      cx = a * a * n.cx + 2 * a * f * qx + f * f * orb.x;
      cy = a * a * n.cy + 2 * a * f * qy + f * f * orb.y;
      scale = 0.38 * (1 - f) + 0.04 * f;
      n.alpha = 1 - clamp((f - 0.8) / 0.2, 0, 1);
    }
    n.x = cx; n.y = cy; n.scale = scale;
    n.nodes.forEach((nd, i) => {
      nd.x = cx + (nd.bx - n.cx) * scale + Math.sin(T * 4 + i) * 1.1 * scale;
      nd.y = cy + (nd.by - n.cy) * scale + Math.cos(T * 3.3 + i * 1.7) * 1.1 * scale;
      nd.on = clamp((s * n.reach * 2.2 - nd.d) / 60, 0, 1);
    });
    if (s >= CAST + CINCH + FLY) {
      cl.state = "checking"; cl.net = null;
      for (const p of streams) if (p.net && p.claim === cl && !p.dead) { p.dead = true; p.w.pending--; }
      orb.flash = 1; orb.busy++;
      addLowerThird(cl);
      cl.verdictAt = T + 1.5;
    }
  }

  function addLowerThird(cl) {
    const li = document.createElement("li");
    li.className = "lt v-researching";
    li.innerHTML = `<div class="lt-v"><b>Checking</b><small>System 2</small></div><div class="lt-b"><span class="lt-who ${cl.who}"></span><p class="lt-c"></p><p class="lt-n"></p></div>`;
    li.querySelector(".lt-who").textContent = `${cl.who === "host" ? "Host" : "Guest"} · ${cl.stamp}`;
    li.querySelector(".lt-c").textContent = cl.data.say;
    ltsEl.prepend(li);
    const items = [...ltsEl.querySelectorAll(".lt:not(.out)")];
    items.slice(2).forEach((el) => { el.classList.add("out"); setTimeout(() => el.remove(), 450); });
    cl.lt = li;
  }
  function giveVerdict(cl) {
    const v = cl.data.v;
    cl.state = "done"; orb.busy = Math.max(0, orb.busy - 1);
    if (cl.lt) {
      cl.lt.className = `lt v-${v} flip`;
      cl.lt.querySelector(".lt-v b").textContent = VLABEL[v];
      cl.lt.querySelector(".lt-n").textContent = cl.data.note || "";
    }
    cl.el.classList.remove("netted");
    cl.el.classList.add("v-" + v);
    cl.el.dataset.v = VLABEL[v];
    rings.push({ t0: T, c: VCOL[v] });
    const i = claims.indexOf(cl); if (i >= 0) claims.splice(i, 1);
  }

  function updateLens(dt) {
    const user = !RM && T - ptr.t < 2.6 && !ptr.ui;
    let tx, ty, k;
    if (user) { tx = ptr.x; ty = ptr.y; k = 24; }
    else {
      k = 2.6;
      const target = claims.find((c) => c.state === "open");
      let fx = 0, fy = 0, n = 0;
      if (target && T - target.born > 0.5) {
        for (const p of streams) if (p.claim === target && !p.dead && !p.net && T > p.t0 + p.d * 0.25 && T < p.t0 + p.d) { fx += p.x; fy += p.y; n++; }
        if (!n) for (const w of target.words) if (w.in) { const r = rel(w.el); fx += r.x + r.w / 2; fy += r.y + r.h / 2; n++; }
      }
      if (n) { tx = fx / n; ty = fy / n; k = 3.4; }
      else {
        const tr = rel(linesEl);
        tx = W / 2 + Math.sin(T * 0.23) * Math.min(W * 0.2, 260);
        ty = clamp(tr.y + tr.h - 60 + Math.sin(T * 0.37) * 50, H * 0.3, H * 0.8);
      }
    }
    if (!user) ty = clamp(ty, ltsEl.offsetTop + ltsEl.offsetHeight + lens.R * 0.6, chyron.offsetTop - lens.R - 26);
    const a = 1 - Math.exp(-dt * k);
    lens.x += (tx - lens.x) * a; lens.y += (ty - lens.y) * a;
    lensEl.style.transform = `translate(${lens.x.toFixed(1)}px, ${lens.y.toFixed(1)}px)`;
    if (RM) return;
    // does the lens touch an open claim?
    const R2 = lens.R * lens.R;
    for (const cl of claims) {
      if (cl.state !== "open") continue;
      let hit = false;
      for (const p of streams) if (p.claim === cl && !p.dead && !p.net && T > p.t0 && (p.x - lens.x) ** 2 + (p.y - lens.y) ** 2 < R2) { hit = true; break; }
      if (hit) { catchClaim(cl, lens.x, lens.y, false); break; }
      for (const w of cl.words) {
        if (!w.in) continue;
        const r = rel(w.el), nx = clamp(lens.x, r.x, r.x + r.w), ny = clamp(lens.y, r.y, r.y + r.h);
        if ((nx - lens.x) ** 2 + (ny - lens.y) ** 2 < R2) { hit = true; break; }
      }
      if (hit) { catchClaim(cl, lens.x, lens.y, true); break; }
      // System 1 flags every claim anyway; the lens is just faster
      if (T - cl.born > 9 && cl.words.every((w) => w.in)) { const r = rel(cl.el); catchClaim(cl, r.x + r.w / 2, r.y + r.h / 2, true); break; }
    }
  }

  // ---------- drawing ----------
  const tmp = [0, 0, 0];
  function voiceEnv(cl) {
    if (!cl.speaking) return 0.03;
    const x = (T - cl.wordT) / cl.wordD;
    if (x > 1.2) return 0.22;
    return 0.3 + 0.7 * Math.sin(Math.PI * clamp(x, 0, 1)) * (0.78 + 0.22 * Math.sin(T * 37 + cl.dir));
  }
  function drawCloud(cl, dt) {
    const target = RM ? (cl.speaking ? 0.28 : 0.04) : voiceEnv(cl);
    cl.env += (target - cl.env) * (1 - Math.exp(-dt * (target > cl.env ? 20 : 6)));
    cl.burst *= Math.exp(-dt * 2.2);
    const env = cl.env + cl.burst;
    const lit = Math.round(clamp(env, 0, 1) * 12);
    if (lit !== cl.lit) { cl.lit = lit; const m = meters[cl === clouds.host ? "host" : "remote"]; m.forEach((el, i) => el.classList.toggle("on", i < lit)); }
    const spin = RM ? 0.03 : 0.16;
    const A = T * spin * cl.dir, tilt = 0.38, ct = Math.cos(tilt), st = Math.sin(tilt);
    const Rr = cl.R * (1 + 0.1 * env);
    const inLanes = beat === 1, since = T - beatT;
    const nowX = lanesBox.x + ((T * 0.075) % 1.2) * lanesBox.w;
    for (const p of cl.ps) {
      const ang = A * p.sp + p.ph * 0.02;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const wob = 1 + env * (0.16 + 0.24 * Math.sin(p.uy * 6.5 + T * 7.3 + p.ph)) * (p.r > 0.6 ? 1 : 0.4) + 0.025 * Math.sin(T * 0.9 + p.ph);
      const rr = p.r * Rr * wob;
      const x = p.ux * rr, y = p.uy * rr, z = p.uz * rr;
      const x2 = x * ca + z * sa, z2 = -x * sa + z * ca;
      const y2 = y * ct - z2 * st, z3 = y * st + z2 * ct;
      const persp = 1 / (1 - z3 / (cl.R * 5));
      const sx = cl.x + x2 * persp, sy = cl.y + y2 * persp;
      p.sx = sx; p.sy = sy;
      const depth = clamp((z3 / Rr + 1) / 2, 0, 1);
      let a = p.haze ? 0.1 + 0.08 * env : (0.34 + 0.5 * depth) * (0.72 + 0.6 * env);
      let size = p.sz * (0.78 + 0.45 * depth) * (1 + env * 0.3);
      // lanes
      if (p.slot) {
        const want = inLanes ? 1 : 0;
        if (RM) p.b = want;
        else if (want && since > p.slot.delay) p.b = Math.min(1, p.b + dt / 1.1);
        else if (!want) p.b = Math.max(0, p.b - dt / (0.8 + p.slot.delay * 0.4));
      }
      if (p.slot && p.b > 0) {
        const e = ease(p.b), s = p.slot;
        const lx = sx + (s.x - sx) * e, ly = sy + (s.y - sy) * e - Math.sin(Math.PI * e) * 70;
        const boost = Math.exp(-Math.pow((s.x - nowX) / 40, 2));
        R.pt(lx, ly, size + (s.sz * (1 + boost * 0.8) - size) * e, mix(p.c, s.c, e, tmp), a + ((0.62 + boost * 0.4) - a) * e);
      } else R.pt(sx, sy, size, p.c, a);
    }
  }
  function drawOrb(dt) {
    orb.spin += dt * (RM ? 0.05 : 0.35 + Math.min(orb.busy, 2) * 1.3);
    orb.flash *= Math.exp(-dt * 2.4);
    const ca = Math.cos(orb.spin), sa = Math.sin(orb.spin), Rr = orb.R * (1 + 0.35 * orb.flash + 0.04 * Math.sin(T * 1.7));
    for (const p of orb.ps) {
      const rr = p.r * Rr * (1 + (orb.busy ? 0.08 * Math.sin(T * 9 + p.ph) : 0));
      const x = p.ux * rr, y = p.uy * rr, z = p.uz * rr;
      const x2 = x * ca + z * sa, z2 = -x * sa + z * ca;
      const y2 = y * 0.93 - z2 * 0.36;
      const depth = clamp((z2 / Rr + 1) / 2, 0, 1);
      R.pt(orb.x + x2, orb.y + y2, p.sz * (0.8 + 0.4 * depth), p.c, (0.28 + 0.45 * depth) * (0.8 + orb.flash));
    }
  }
  function drawStreams() {
    const dimOthers = beat === 2 ? 0.35 : 1;
    for (let i = streams.length - 1; i >= 0; i--) {
      const p = streams[i];
      if (p.dead) { streams.splice(i, 1); continue; }
      if (T < p.t0) continue;
      if (p.net) continue; // drawn with the net
      const k = (T - p.t0) / p.d;
      if (k > 1.35) {
        p.dead = true; p.w.pending--;
        continue;
      }
      const r = p.w.rect;
      const tx = r.x + p.fx * r.w, ty = r.y + p.fy * r.h;
      const qx = (p.x0 + tx) / 2 + p.swing, qy = Math.min(p.y0, ty) - p.lift;
      const pos = (kk) => { const e = ease(clamp(kk, 0, 1)), a = 1 - e; return [a * a * p.x0 + 2 * a * e * qx + e * e * tx, a * a * p.y0 + 2 * a * e * qy + e * e * ty, e]; };
      const [x, y, e] = pos(k);
      p.x = x; p.y = y;
      const fade = k < 1 ? 1 : 1 - (k - 1) / 0.35;
      const tw = p.claim ? 0.85 + 0.35 * Math.sin(T * 18 + p.ph) : 1;
      const base = (p.claim ? 1 : 0.8 * dimOthers) * fade * tw;
      const c = mix(p.c, INK, p.claim ? Math.min(1, e * 1.6) : e * e, tmp);
      R.pt(x, y, p.sz, c, base);
      if (k < 1) {
        const [x1, y1] = pos(k - 0.035), [x2, y2] = pos(k - 0.07);
        R.pt(x1, y1, p.sz * 0.8, c, base * 0.42);
        R.pt(x2, y2, p.sz * 0.6, c, base * 0.18);
      }
    }
  }
  function drawNets() {
    fx.lineWidth = 1;
    for (const cl of claims) {
      const n = cl.net; if (!n) continue;
      for (const [a, b] of n.links) {
        const A = n.nodes[a], B = n.nodes[b], al = Math.min(A.on, B.on) * 0.7 * n.alpha;
        if (al < 0.02) continue;
        fx.strokeStyle = `rgba(43,212,240,${al.toFixed(3)})`;
        fx.beginPath(); fx.moveTo(A.x, A.y); fx.lineTo(B.x, B.y); fx.stroke();
      }
      for (const nd of n.nodes) R.pt(nd.x, nd.y, 1.9, ACC, nd.on * 0.95 * n.alpha);
    }
    for (const p of streams) {
      if (!p.net) continue;
      const cl = p.claim, n = cl && cl.net; if (!n) continue;
      const nd = n.nodes[p.net.node];
      R.pt(nd.x + p.net.ox * n.scale, nd.y + p.net.oy * n.scale, p.sz, mix(p.c, INK, 0.6, tmp), 0.95 * n.alpha);
    }
  }
  function drawRings() {
    // System 2 at work: a slow scanning arc; a verdict: a ring in the verdict's colour
    if (orb.busy) {
      const a0 = T * 3.2;
      fx.strokeStyle = "rgba(43,212,240,0.75)"; fx.lineWidth = 1.5;
      fx.beginPath(); fx.arc(orb.x, orb.y, orb.R * 1.9, a0, a0 + 1.4); fx.stroke();
      fx.beginPath(); fx.arc(orb.x, orb.y, orb.R * 1.9, a0 + Math.PI, a0 + Math.PI + 1.4); fx.stroke();
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i], s = (T - r.t0) / 1.3;
      if (s >= 1) { rings.splice(i, 1); continue; }
      const c = r.c;
      fx.strokeStyle = `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${(0.9 * (1 - s)).toFixed(3)})`;
      fx.lineWidth = 2.5 * (1 - s) + 0.5;
      fx.beginPath(); fx.arc(r.x != null ? r.x : orb.x, r.y != null ? r.y : orb.y, orb.R * 1.4 + ease(s) * (r.big || 120), 0, Math.PI * 2); fx.stroke();
    }
  }

  // ---------- the loop ----------
  let running = false, raf = 0, last = 0, onScreen = true, lastClock = -1;
  let wall = 0;
  function frame(now) {
    raf = 0; now = wall = performance.now();
    if (!running) return;
    const dt = clamp(last ? (now - last) / 1000 : 0.016, 0, 0.05); last = now;
    T += dt;
    readStage(); readAnchors();
    stepEngine();
    for (const w of activeWords) {
      if (!w.el.isConnected) { activeWords.delete(w); continue; }
      w.rect = rel(w.el);
      if (!w.in && T >= w.arrive - 0.04) reveal(w);
      if (w.pending <= 0) activeWords.delete(w);
    }
    for (let i = claims.length - 1; i >= 0; i--) if (claims[i].state === "open" && !claims[i].el.isConnected) claims.splice(i, 1);
    for (const cl of claims) {
      if (cl.net) updateNet(cl);
      if (cl.state === "checking" && cl.verdictAt && T >= cl.verdictAt) giveVerdict(cl);
    }
    updateLens(dt);
    if (beat === 1 && nowEl) nowEl.style.left = (lanesBox.x - rel(lanesEl).x + ((T * 0.075) % 1.2) * lanesBox.w).toFixed(1) + "px";
    R.begin(); fx.clearRect(0, 0, W, H);
    drawCloud(clouds.host, dt); drawCloud(clouds.remote, dt);
    drawOrb(dt);
    drawStreams();
    drawNets();
    drawRings();
    R.end();
    const sec = Math.floor(CLOCK0 + T);
    if (sec !== lastClock) { lastClock = sec; clockEl.textContent = `00:${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`; }
    raf = requestAnimationFrame(frame);
  }
  function setRunning() {
    const want = onScreen && !document.hidden;
    if (want === running) return;
    running = want;
    if (running) { last = 0; raf = requestAnimationFrame(frame); } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  // Some environments (headless capture, throttled iframes) starve requestAnimationFrame; a slow timer keeps the story moving.
  setInterval(() => {
    if (!running || performance.now() - wall < 150) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    frame(performance.now());
  }, 60);
  document.addEventListener("visibilitychange", setRunning);
  new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; setRunning(); }).observe(stage);

  // ---------- scroll beats ----------
  const beatBtns = [...stage.querySelectorAll("[data-go]")];
  const copies = [...stage.querySelectorAll("[data-copy]")];
  function setBeat(b) {
    if (b === beat) return;
    beat = b; beatT = T;
    stage.dataset.beat = String(b);
    beatBtns.forEach((el) => { if (+el.dataset.go === b) el.setAttribute("aria-current", "step"); else el.removeAttribute("aria-current"); });
    copies.forEach((el) => el.classList.toggle("on", +el.dataset.copy === b));
  }
  const progress = () => { const total = story.offsetHeight - window.innerHeight; return total > 0 ? clamp(-story.getBoundingClientRect().top / total, 0, 1) : 0; };
  function onScroll() { const p = progress(); setBeat(p < 0.3 ? 0 : p < 0.64 ? 1 : 2); }
  window.addEventListener("scroll", onScroll, { passive: true });
  beatBtns.forEach((el) => el.addEventListener("click", () => {
    const total = story.offsetHeight - window.innerHeight;
    window.scrollTo({ top: story.offsetTop + total * [0, 0.47, 0.84][+el.dataset.go], behavior: RM ? "auto" : "smooth" });
  }));

  // ---------- pointer: the lens is yours while you move ----------
  stage.addEventListener("pointermove", (e) => {
    ptr.x = e.clientX - SL; ptr.y = e.clientY - ST; ptr.t = T;
    ptr.ui = !!e.target.closest(".top, .chyron, .lts, a, button");
  });
  stage.addEventListener("pointerdown", (e) => { ptr.x = e.clientX - SL; ptr.y = e.clientY - ST; ptr.t = T; ptr.ui = !!e.target.closest(".top, .chyron, .lts, a, button"); });
  stage.addEventListener("pointerleave", () => { ptr.t = -99; });

  // a download is worth a cheer from both voices
  window.addEventListener("ca:download", () => {
    clouds.host.burst = clouds.remote.burst = 1;
    rings.push({ t0: T, c: HOST, x: clouds.host.x, y: clouds.host.y, big: 220 }, { t0: T, c: REMOTE, x: clouds.remote.x, y: clouds.remote.y, big: 220 });
  });
  if (window.CA) window.CA.ready(() => document.querySelectorAll(".rel").forEach((el) => { el.hidden = false; }));

  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 120); });
  resize();
  // #listen, #map and #check open the page on that beat
  const deep = ["#listen", "#map", "#check"].indexOf(location.hash);
  if (deep > 0) window.scrollTo(0, story.offsetTop + (story.offsetHeight - window.innerHeight) * [0, 0.47, 0.84][deep]);
  onScroll();
  setRunning();
})();
