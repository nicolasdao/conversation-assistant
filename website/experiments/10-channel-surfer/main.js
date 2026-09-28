// 10 · Channel Surfer. The screen is a 1024×768 2D canvas (the "broadcast"), run through a WebGL CRT shader:
// barrel curve, scanlines, bloom, aperture mask, static, vertical roll, and a magnet under the cursor.
// The Download button lives outside the set, in the DOM, never under the shader.
(() => {
  "use strict";

  const W = 1024, H = 768;
  const $ = (s) => document.querySelector(s);
  const css = getComputedStyle(document.documentElement);
  const K = new Proxy({}, { get: (o, n) => o[n] || (o[n] = css.getPropertyValue("--" + n).trim()) });
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const ease = (p) => 1 - Math.pow(1 - clamp(p), 3);
  const CA = window.CA || { isMac: /Macintosh/.test(navigator.userAgent), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, release: null };
  const RM = CA.reducedMotion;
  const COND = '"Barlow Condensed", "Arial Narrow", sans-serif';
  const BODY = 'Barlow, "Helvetica Neue", Arial, sans-serif';

  const scene = document.createElement("canvas");
  scene.width = W; scene.height = H;
  const ctx = scene.getContext("2d");
  const hasLS = "letterSpacing" in ctx;

  // ---------- canvas helpers ----------
  function font(w, s, fam = "cond", italic = false, ls = 0) {
    ctx.font = `${italic ? "italic " : ""}${w} ${s}px ${fam === "cond" ? COND : BODY}`;
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    if (hasLS) ctx.letterSpacing = ls + "px";
  }
  function text(str, x, y, o = {}) {
    font(o.w || 800, o.s || 24, o.fam || "cond", o.italic, o.ls || 0);
    ctx.textAlign = o.align || "left";
    ctx.fillStyle = o.color || K.ink;
    ctx.fillText(str, x, y);
    if (hasLS) ctx.letterSpacing = "0px";
  }
  function measure(str, w, s, fam = "cond", ls = 0) {
    font(w, s, fam, false, ls);
    const m = ctx.measureText(str).width;
    if (hasLS) ctx.letterSpacing = "0px";
    return m;
  }
  // a broadcast strap: right edge cut by s; optionally the left edge too (cut from the top)
  function slant(x, y, w, h, s = 14, left = 0) {
    ctx.beginPath(); ctx.moveTo(x + left, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - s, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  }
  function appIcon(x, y, s) {
    const g = ctx.createLinearGradient(0, y, 0, y + s);
    g.addColorStop(0, K["icon-top"]); g.addColorStop(1, K["icon-bottom"]);
    ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(x, y, s, s, s * 0.225); ctx.fill();
    ctx.fillStyle = K.paper; ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.232, 0, 7); ctx.fill();
    ctx.strokeStyle = rgba(K.paper, 0.35); ctx.lineWidth = s * 0.034; ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.303, 0, 7); ctx.stroke();
  }
  function stripes(x, y, w, h, off) {
    ctx.save(); slant(x, y, w, h, 12); ctx.clip();
    ctx.fillStyle = K["deck-2"]; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = K["deck-3"];
    for (let i = -h - 24 + (off % 24); i < w + h; i += 24) {
      ctx.beginPath(); ctx.moveTo(x + i, y); ctx.lineTo(x + i + 12, y); ctx.lineTo(x + i + 12 + h, y + h); ctx.lineTo(x + i + h, y + h); ctx.fill();
    }
    ctx.restore();
  }
  function wrap(words, maxW) {
    const lines = []; let line = [], w = 0; const sp = ctx.measureText(" ").width;
    words.forEach((word, i) => {
      const ww = ctx.measureText(word).width;
      if (line.length && w + sp + ww > maxW) { lines.push(line); line = []; w = 0; }
      w += (line.length ? sp : 0) + ww; line.push(i);
    });
    if (line.length) lines.push(line);
    return lines;
  }

  // ---------- the OSD: a 5×7 pixel font, like the set's own on-screen display ----------
  const G = {
    A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110", C: "01110100011000010000100001000101110",
    D: "11110100011000110001100011000111110", E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
    G: "01110100011000010111100011000101111", H: "10001100011000111111100011000110001", I: "01110001000010000100001000010001110",
    K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111", M: "10001110111010110101100011000110001",
    N: "10001100011100110101100111000110001", O: "01110100011000110001100011000101110", P: "11110100011000111110100001000010000",
    R: "11110100011000111110101001001010001", S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100",
    U: "10001100011000110001100011000101110", V: "10001100011000110001100010101000100", W: "10001100011000110101101011010101010",
    Y: "10001100010101000100001000010000100", "-": "00000000000000011111000000000000000", " ": "00000000000000000000000000000000000",
    0: "01110100011001110101110011000101110", 1: "00100011000010000100001000010001110", 2: "01110100010000100010001000100011111",
    3: "11111000100010000010000011000101110", 4: "00010001100101010010111110001000010", 5: "11111100001111000001000011000101110",
    6: "00110010001000011110100011000101110", 7: "11111000010001000100010000100001000", 8: "01110100011000101110100011000101110",
    9: "01110100011000101111000010001001100",
  };
  function pix(str, x, y, px, align = "left", color = K.good) {
    const cw = 6 * px, w = str.length * cw - px;
    if (align === "right") x -= w; else if (align === "center") x -= w / 2;
    for (let pass = 0; pass < 2; pass++) {
      const o = pass ? 0 : Math.max(2, px * 0.5);
      ctx.fillStyle = pass ? color : rgba(K.ground, 0.9);
      for (let i = 0; i < str.length; i++) {
        const g = G[str[i]]; if (!g) continue;
        for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r * 5 + c] === "1") ctx.fillRect(x + i * cw + c * px + o, y + r * px + o, px, px);
      }
    }
    return w;
  }

  // ---------- shared on-screen furniture ----------
  function bug(label, now, o = {}) {
    const x = 60, y = 50, h = 54;
    const block = o.block || K.live, ink = o.ink || K.paper, word = o.word || "ON AIR", dot = o.dot !== false;
    const bw = measure(word, 800, 28, "cond", 2) + (dot ? 64 : 42);
    ctx.fillStyle = block; slant(x, y, bw, h); ctx.fill();
    if (dot) {
      const a = RM ? 1 : 0.3 + 0.7 * (0.5 + 0.5 * Math.cos((now / 1400) * Math.PI * 2));
      ctx.fillStyle = rgba(ink, a); ctx.beginPath(); ctx.arc(x + 25, y + h / 2, 7, 0, 7); ctx.fill();
    }
    text(word, x + (dot ? 42 : 18), y + 38, { color: ink, s: 28, ls: 2 });
    const sx = x + bw - 14;
    const sw = Math.max(measure(label, 800, 28, "cond", 1.5), measure("TATTLE", 700, 13, "cond", 2.5)) + 64;
    ctx.fillStyle = K.paper; slant(sx, y, sw, h, 14, 14); ctx.fill();
    text("TATTLE", sx + 30, y + 20, { color: K["strap-eyebrow"], w: 700, s: 13, ls: 2.5 });
    text(label, sx + 30, y + 46, { color: K["paper-ink"], s: 28, ls: 1.5 });
  }
  const CRAWL = "TRANSCRIBES LIVE CONVERSATIONS   /   MAPS THEM ON A TIMELINE   /   FACT-CHECKS CLAIMS AS THEY'RE SAID   /   WORKS WITH ANY CALL APP   /   NO SERVER, NO ACCOUNT, NO ANALYTICS   /   SIGNED AND NOTARIZED BY APPLE   /   BSD 3-CLAUSE   /   ";
  function ticker(now) {
    const y = H - 104, h = 44, x0 = 60, x1 = W - 60, lab = 124;
    ctx.fillStyle = K.paper; ctx.fillRect(x0, y, x1 - x0, h);
    ctx.save(); ctx.beginPath(); ctx.rect(x0 + lab - 14, y, x1 - x0 - lab + 14, h); ctx.clip();
    const tw = measure(CRAWL, 700, 22, "cond", 1.5);
    const off = RM ? 0 : (now * 0.085) % tw;
    for (let x = x0 + lab - off; x < x1; x += tw) text(CRAWL, x, y + 30, { color: K["paper-ink"], w: 700, s: 22, ls: 1.5 });
    ctx.restore();
    ctx.fillStyle = K.accent; slant(x0, y, lab, h); ctx.fill();
    text("THE APP", x0 + 16, y + 31, { color: K["paper-ink"], s: 22, ls: 2 });
  }

  // ---------- CH 0: the test card, redrawn in the app's palette ----------
  const BARS = ["accent", "good", "warn", "live", "host", "remote", "hype", "heat"];
  const GREYS = ["ground", "deck", "deck-2", "deck-3", "rule", "neutral", "mute", "ink-2", "ink"];
  function drawTest(t, now) {
    ctx.fillStyle = K.ground; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = rgba(K["ink-2"], 0.42); ctx.lineWidth = 2;
    for (let x = 32; x < W; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // castellations along the edges
    for (let x = 0, i = 0; x < W; x += 64, i++) {
      ctx.fillStyle = i % 2 ? K.ink : K["deck-3"]; ctx.fillRect(x - 32, 20, 64, 20); ctx.fillRect(x - 32, H - 40, 64, 20);
    }
    for (let y = 64, i = 0; y < H - 64; y += 64, i++) {
      ctx.fillStyle = i % 2 ? K.ink : K["deck-3"]; ctx.fillRect(34, y, 20, 64); ctx.fillRect(W - 54, y, 20, 64);
    }
    // side colour patches, like a real card's
    [["hype", 140], ["remote", 560]].forEach(([c, y]) => { ctx.fillStyle = K[c]; ctx.fillRect(88, y, 72, 64); ctx.fillRect(W - 160, y, 72, 64); });

    const cx = 512, cy = 384, R = 330;
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
    ctx.fillStyle = K.deck; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    // top band: the tone
    const hh = (n) => String(n).padStart(2, "0");
    text(sound ? "TONE 1 kHz  ·  ON" : "TONE 1 kHz  ·  OFF", cx, 118, { align: "center", color: sound ? K.hype : K.mute, w: 700, s: 22, ls: 3 });
    // bars
    const bw = (2 * R) / BARS.length;
    BARS.forEach((c, i) => { ctx.fillStyle = K[c]; ctx.fillRect(cx - R + i * bw, 140, bw + 1, 172); });
    // ident strap
    ctx.fillStyle = K.ground; ctx.fillRect(cx - R, 312, 2 * R, 92);
    ctx.fillStyle = K.paper; slant(cx - 300, 322, 600, 72, 18, 18); ctx.fill();
    ctx.fillStyle = K.live; slant(cx - 318, 322, 58, 72, 18); ctx.fill();
    text("TATTLE", cx + 12, 378, { align: "center", color: K["paper-ink"], s: 50, ls: 3 });
    // greyscale
    const gw = (2 * R) / GREYS.length;
    GREYS.forEach((c, i) => { ctx.fillStyle = K[c]; ctx.fillRect(cx - R + i * gw, 404, gw + 1, 64); });
    // frequency gratings
    const per = [14, 10, 7, 5, 4, 3];
    const fw = (2 * R) / per.length;
    per.forEach((p, i) => {
      const x0 = cx - R + i * fw;
      ctx.fillStyle = K.ground; ctx.fillRect(x0, 468, fw, 80);
      ctx.fillStyle = K.ink; for (let x = x0; x < x0 + fw; x += p * 2) ctx.fillRect(x, 468, p, 80);
    });
    // lower: the mark and a clock
    ctx.fillStyle = K.ground; ctx.fillRect(cx - R, 548, 2 * R, 200);
    appIcon(cx - 38, 566, 76);
    const d = new Date();
    text(`${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())}`, cx, 690, { align: "center", color: K.ink, w: 700, s: 34, ls: 4 });
    ctx.restore();
    ctx.strokeStyle = K.ink; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();
    // centre cross
    ctx.strokeStyle = rgba(K.ink, 0.5); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, 404); ctx.lineTo(cx, 468); ctx.stroke();
  }

  // ---------- CH 1: live transcript ----------
  const SPEAK = 0.2;
  const SCRIPT = [
    { who: 0, text: "Okay, enough about models, how was surfing in Sydney this weekend?" },
    { who: 1, text: "Freezing, but worth it. A diver told me octopuses have three hearts.", claim: [8, 11], v: "supported" },
    { who: 0, text: "Three hearts. That explains a lot." },
    { who: 1, text: "And lightning never strikes the same place twice, so I stayed out in the storm.", claim: [1, 7], v: "contradicted" },
    { who: 0, text: "I don't buy that at all." },
  ];
  let acc = 0.5;
  for (const u of SCRIPT) { u.words = u.text.split(" "); u.start = acc; u.end = acc + u.words.length * SPEAK; acc = u.end + 1.1; }
  const RENAME_AT = SCRIPT[1].end + 0.7;
  const SCRIPT_LEN = acc + 5;
  const VCOL = { supported: "good", contradicted: "bad", misleading: "warn", unverifiable: "neutral" };
  let tScroll = 0;
  const lv = [0, 0];

  function guestName(tt) {
    if (tt < RENAME_AT) return "SPEAKER 2";
    const p = (tt - RENAME_AT) / 1.0;
    if (p >= 1) return "MAYA";
    if (p < 0.5) return "SPEAKER 2".slice(0, Math.ceil(9 * (1 - p * 2)));
    return "MAYA".slice(0, Math.ceil(4 * (p - 0.5) * 2));
  }
  function speakerChip(who, x, y, tt) {
    const label = who === 0 ? "HOST · MIC" : `${guestName(tt)} · CALL`;
    const col = who === 0 ? K.host : K.remote;
    const w = measure(label, 800, 18, "cond", 1.5) + 38;
    ctx.fillStyle = col; slant(x, y, w, 30, 10); ctx.fill();
    text(label, x + 12, y + 22, { color: K["paper-ink"], s: 18, ls: 1.5 });
    if (who === 1 && tt > RENAME_AT - 0.2 && tt < RENAME_AT + 2.6) {
      ctx.strokeStyle = K.accent; ctx.lineWidth = 3; slant(x - 5, y - 5, w + 12, 40, 12); ctx.stroke();
      text("YOU NAMED THIS VOICE", x + w + 20, y + 22, { color: K.accent, w: 700, s: 18, ls: 2 });
    }
  }
  function drawTranscript(t, now) {
    ctx.fillStyle = K.ground; ctx.fillRect(0, 0, W, H);
    bug("LIVE TRANSCRIPT", now);
    const tt = RM ? SCRIPT_LEN - 5 : t % SCRIPT_LEN;
    const fade = RM ? 1 : clamp((SCRIPT_LEN - tt) / 0.6) * clamp(tt / 0.4);
    const top = 136, bottom = 566, x = 64, maxW = W - 150;
    const blocks = []; let y = 0;
    font(500, 30, "body");
    for (const u of SCRIPT) {
      if (tt < u.start) break;
      const shown = Math.min(u.words.length, Math.floor((tt - u.start) / SPEAK) + 1);
      const lines = wrap(u.words, maxW);
      const chip = !!u.claim && tt > u.end + 0.15;
      blocks.push({ u, shown, lines, y, chip });
      y += 40 + lines.length * 40 + (chip ? 46 : 0) + 18;
    }
    const target = Math.max(0, y - (bottom - top));
    tScroll = target < tScroll - 40 || RM ? target : tScroll + (target - tScroll) * 0.12;

    ctx.save(); ctx.globalAlpha = fade;
    ctx.beginPath(); ctx.rect(0, top, W, bottom - top); ctx.clip();
    for (const b of blocks) {
      const by = top + b.y - tScroll;
      if (by > bottom || by + 320 < top) continue;
      const u = b.u, col = u.who === 0 ? K.host : K.remote;
      speakerChip(u.who, x, by, tt);
      font(500, 30, "body");
      const sp = ctx.measureText(" ").width;
      let ly = by + 40 + 30, cx = x, cy = ly;
      for (const line of b.lines) {
        let lx = x;
        for (const wi of line) {
          if (wi >= b.shown) break;
          const word = u.words[wi], ww = ctx.measureText(word).width;
          if (u.claim && wi >= u.claim[0] && wi <= u.claim[1]) {
            const ext = wi < u.claim[1] && line.includes(wi + 1) ? sp : 0;
            ctx.fillStyle = rgba(K.accent, 0.14); ctx.fillRect(lx - 2, ly - 27, ww + ext + 4, 36);
            ctx.fillStyle = K.accent; for (let dx = 0; dx < ww + ext; dx += 10) ctx.fillRect(lx + dx, ly + 7, 6, 3);
          }
          ctx.fillStyle = K.ink; ctx.fillText(word, lx, ly);
          lx += ww + sp; cx = lx; cy = ly;
        }
        ly += 40;
      }
      if (tt < u.end + 0.3 && (RM || Math.floor(now / 380) % 2)) { ctx.fillStyle = col; ctx.fillRect(cx, cy - 25, 13, 30); }
      if (b.chip) {
        const cyy = by + 40 + b.lines.length * 40 + 6, p = tt - u.end;
        if (p < 1.3) {
          stripes(x, cyy, 190, 32, now * 0.05);
          text("RESEARCHING", x + 14, cyy + 24, { color: K.accent, s: 20, ls: 2 });
        } else {
          const vw = measure(u.v.toUpperCase(), 800, 20, "cond", 2) + 38;
          ctx.fillStyle = K[VCOL[u.v]]; slant(x, cyy, vw, 32, 10); ctx.fill();
          text(u.v.toUpperCase(), x + 12, cyy + 24, { color: u.v === "misleading" ? K["paper-ink"] : K.paper, s: 20, ls: 2 });
        }
        text("FACT-CHECK  ·  MORE ON CH 3", x + (p < 1.3 ? 206 : measure(u.v.toUpperCase(), 800, 20, "cond", 2) + 54), cyy + 24, { color: K.mute, w: 700, s: 18, ls: 2 });
      }
    }
    ctx.restore();
    // top fade under the bug
    const g = ctx.createLinearGradient(0, top, 0, top + 30); g.addColorStop(0, K.ground); g.addColorStop(1, rgba(K.ground, 0));
    ctx.fillStyle = g; ctx.fillRect(0, top, W, 30);

    // level meters: green to yellow to red
    const speaking = SCRIPT.find((u) => tt >= u.start && tt < u.end);
    [["MIC", K.host], ["CALL", K.remote]].forEach(([label, col], i) => {
      const yy = 590 + i * 30;
      let target = 0.05 + (RM ? 0 : 0.05 * Math.random());
      if (speaking && speaking.who === i) target = RM ? 0.6 : 0.42 + 0.4 * (0.5 + 0.5 * Math.sin(now / 95 + i)) * (0.65 + 0.35 * Math.random());
      lv[i] += (target - lv[i]) * 0.35;
      text(label, 64, yy + 17, { color: col, s: 18, ls: 2 });
      for (let s = 0; s < 32; s++) {
        const f = s / 32;
        ctx.fillStyle = f < lv[i] ? (f < 0.6 ? K.good : f < 0.85 ? K.hype : K.live) : K["deck-2"];
        ctx.fillRect(126 + s * 15, yy + 2, 11, 18);
      }
    });
    ticker(now);
  }

  // ---------- CH 2: timeline ----------
  const TL = {
    topic: [[0, 7, "THE SHOW", "s-the-show"], [7, 21, "AI MODELS", "s-ai-models"], [21, 30, "AI TOOLS", "s-ai-tools"], [30, 39, "PERSONAL LIFE", "s-personal-life"], [39, 51, "AI INDUSTRY", "s-ai-industry"], [51, 60, "TECH", "s-tech"]],
    mode: [[0, 4, "BANTER", "m-banter"], [4, 12, "NEWS", "m-news"], [12, 21, "ANALYSIS", "m-analysis"], [21, 27, "EXPLAINER", "m-explainer"], [27, 31, "BANTER", "m-banter"], [31, 39, "PERSONAL STORY", "m-personal-story"], [39, 48, "ANALYSIS", "m-analysis"], [48, 55, "NEWS", "m-news"], [55, 60, "BANTER", "m-banter"]],
    marks: [["DISAGREEMENTS", "live", [17, 43, 45.5]], ["HOT TAKES", "heat", [11, 28, 49]], ["PREDICTIONS", "accent", [19, 46, 57]], ["RECOMMENDATIONS", "good", [24, 35, 53]]],
    clips: [[15, 17.5], [32, 35], [44, 46.5]],
  };
  const heat = (m) => clamp(0.28 + 0.2 * Math.sin(m * 0.31) + 0.12 * Math.sin(m * 1.3 + 1) + 0.4 * Math.exp(-((m - 44.5) ** 2) / 6) + 0.3 * Math.exp(-((m - 17) ** 2) / 4), 0.04, 0.96);
  const hype = (m) => clamp(0.34 + 0.18 * Math.sin(m * 0.45 + 2) + 0.1 * Math.sin(m * 1.9) + 0.34 * Math.exp(-((m - 33) ** 2) / 5), 0.04, 0.96);

  function drawTimeline(t, now) {
    ctx.fillStyle = K.ground; ctx.fillRect(0, 0, W, H);
    bug("TIMELINE", now);
    const x0 = 256, x1 = 962, X = (m) => x0 + ((x1 - x0) * m) / 60;
    const cyc = RM ? 99 : t % 21;
    const reveal = Math.min(60, (cyc / 15) * 60);
    const rows = [["TOPIC", 40], ["MODE", 40], ["HEAT · HYPE", 104], ["DISAGREEMENTS", 30], ["HOT TAKES", 30], ["PREDICTIONS", 30], ["RECOMMENDATIONS", 30], ["CLIP-WORTHY", 30]];
    let y = 146; const ys = [];
    rows.forEach(([label, h]) => {
      ys.push([y, h]);
      text(label, x0 - 16, y + h / 2 + 7, { align: "right", color: label === "HEAT · HYPE" ? K.ink : K.mute, w: 700, s: 17, ls: 1.5 });
      ctx.fillStyle = K.deck; ctx.fillRect(x0, y, x1 - x0, h);
      y += h + 8;
    });
    // heat/hype legend
    text("HEAT", x0 - 16, ys[2][0] + 76, { align: "right", color: K.heat, w: 700, s: 14, ls: 1.5 });
    text("HYPE", x0 - 60, ys[2][0] + 76, { align: "right", color: K.hype, w: 700, s: 14, ls: 1.5 });
    // gridlines + axis
    for (let m = 0; m <= 60; m += 10) {
      ctx.fillStyle = rgba(K.rule, 0.9); ctx.fillRect(X(m), 146, 1, y - 154);
      text(`${String(m).padStart(2, "0")}:00`, X(m), y + 14, { align: m === 60 ? "right" : m === 0 ? "left" : "center", color: K.mute, w: 600, s: 15, ls: 1 });
    }
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 130, X(reveal) - x0, y); ctx.clip();
    const seg = (list, [yy, h]) => list.forEach(([a, b, label, c]) => {
      ctx.fillStyle = K[c]; ctx.fillRect(X(a) + 1, yy + 3, X(b) - X(a) - 2, h - 6);
      if (measure(label, 700, 15, "cond", 1) + 16 < X(Math.min(b, reveal)) - X(a)) text(label, X(a) + 9, yy + h / 2 + 6, { color: K.ink, w: 700, s: 15, ls: 1 });
    });
    seg(TL.topic, ys[0]); seg(TL.mode, ys[1]);
    // heat & hype
    const [hy, hh] = ys[2];
    for (const [fn, c, fill] of [[heat, K.heat, true], [hype, K.hype, false]]) {
      ctx.beginPath();
      for (let m = 0; m <= 60; m += 0.5) { const px = X(m), py = hy + hh - 6 - fn(m) * (hh - 12); m ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      if (fill) { ctx.save(); ctx.lineTo(X(60), hy + hh); ctx.lineTo(X(0), hy + hh); ctx.closePath(); ctx.fillStyle = rgba(c, 0.22); ctx.fill(); ctx.restore(); ctx.beginPath(); for (let m = 0; m <= 60; m += 0.5) { const px = X(m), py = hy + hh - 6 - fn(m) * (hh - 12); m ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } }
      ctx.strokeStyle = c; ctx.lineWidth = 3; ctx.stroke();
    }
    TL.marks.forEach(([, c, ms], i) => {
      const [yy, h] = ys[3 + i];
      ms.forEach((m) => { const px = X(m), py = yy + h / 2; ctx.fillStyle = K[c]; ctx.beginPath(); ctx.moveTo(px, py - 10); ctx.lineTo(px + 10, py); ctx.lineTo(px, py + 10); ctx.lineTo(px - 10, py); ctx.fill(); });
    });
    const [cyy, ch_] = ys[7];
    TL.clips.forEach(([a, b]) => {
      ctx.fillStyle = K.hype; ctx.beginPath(); ctx.roundRect(X(a), cyy + 5, X(b) - X(a), ch_ - 10, 3); ctx.fill();
      text("CLIP", X(a) + 7, cyy + ch_ / 2 + 5, { color: K["paper-ink"], s: 14, ls: 1.5 });
    });
    ctx.restore();
    // the live playhead
    const px = X(reveal);
    ctx.fillStyle = K.live; ctx.fillRect(px - 1.5, 138, 3, y - 146);
    const lw = 76, lx = Math.min(px - 12, x1 - lw + 6);
    ctx.fillStyle = K.live; slant(lx, 118, lw, 26, 8); ctx.fill();
    ctx.fillStyle = rgba(K.paper, RM ? 1 : 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(now / 220))); ctx.beginPath(); ctx.arc(lx + 14, 131, 5, 0, 7); ctx.fill();
    text("LIVE", lx + 25, 139, { color: K.paper, s: 18, ls: 2 });
    ticker(now);
  }

  // ---------- CH 3: fact-check lower thirds ----------
  const CLAIMS = [
    { who: 1, q: "The Great Wall of China is visible from space with the naked eye.", v: "contradicted", note: "Astronauts report it isn't." },
    { who: 0, q: "Bananas are berries.", v: "supported", note: "Botanically, yes." },
    { who: 1, q: "Coffee dehydrates you.", v: "misleading", note: "Its water outweighs the mild diuretic effect." },
    { who: 0, q: "Goldfish only have a three-second memory.", v: "contradicted", note: "They remember for months." },
    { who: 1, q: "Mount Everest gets a little taller every year.", v: "supported", note: "A few millimetres a year." },
    { who: 0, q: "Lightning never strikes the same place twice.", v: "contradicted", note: "The Empire State Building is hit about 20–25 times a year." },
  ];
  const PER = 7.2, RES = 1.9, VERD = 3.5;
  function drawFactcheck(t, now) {
    ctx.fillStyle = K.ground; ctx.fillRect(0, 0, W, H);
    bug("FACT-CHECK", now);
    const k = Math.floor(t / PER), c = CLAIMS[k % CLAIMS.length];
    const p = RM ? 5 : t - k * PER;
    const out = RM ? 1 : clamp((PER - p) / 0.45);
    // tally so far this visit
    const done = k + (p > VERD ? 1 : 0);
    const tally = { supported: 0, contradicted: 0, misleading: 0, unverifiable: 0 };
    for (let i = 0; i < done; i++) tally[CLAIMS[i % CLAIMS.length].v]++;
    let tx = W - 64;
    ["unverifiable", "misleading", "contradicted", "supported"].forEach((v) => {
      const label = `${v.toUpperCase()} ${tally[v]}`;
      const w = measure(label, 700, 16, "cond", 1.5);
      text(label, tx, 172, { align: "right", color: K.ink, w: 700, s: 16, ls: 1.5 });
      ctx.fillStyle = K[VCOL[v]]; ctx.fillRect(tx - w - 18, 160, 11, 11);
      tx -= w + 36;
    });

    ctx.save(); ctx.globalAlpha = out;
    // said on air
    const chip = c.who === 0 ? ["HOST · MIC", K.host] : ["MAYA · CALL", K.remote];
    const cw = measure(chip[0], 800, 18, "cond", 1.5) + 38;
    ctx.fillStyle = chip[1]; slant(64, 204, cw, 30, 10); ctx.fill();
    text(chip[0], 76, 226, { color: K["paper-ink"], s: 18, ls: 1.5 });
    font(500, 38, "body", true);
    const words = `“${c.q}”`.split(" ");
    const lines = wrap(words, W - 150);
    const shown = RM ? words.length : Math.floor(p / 0.16) + 1;
    let ly = 290;
    lines.forEach((line) => {
      let lx = 64;
      font(500, 38, "body", true);
      line.forEach((wi) => { if (wi >= shown) return; ctx.fillStyle = K["ink-2"]; ctx.fillText(words[wi], lx, ly); lx += ctx.measureText(words[wi] + " ").width; });
      ly += 48;
    });
    if (p > 1.25) {
      const a = RM ? 1 : clamp((p - 1.25) / 0.25);
      ctx.globalAlpha = out * a;
      ctx.strokeStyle = K.accent; ctx.lineWidth = 2; ctx.strokeRect(64, ly - 18, 402, 34);
      text("SYSTEM 1  ·  CHECKABLE CLAIM  ·  0.4 S", 78, ly + 6, { color: K.accent, w: 700, s: 18, ls: 1.5 });
      ctx.globalAlpha = out;
    }
    // the lower third
    if (p > RES) {
      const y = 470, h = 168, vx = 64, vw = 262, bx = vx + vw - 14, bw = W - 60 - bx;
      const wipe = RM ? 1 : ease((p - RES) / 0.45);
      ctx.save(); ctx.beginPath(); ctx.rect(vx, y - 4, (W - 120) * wipe + 4, h + 8); ctx.clip();
      ctx.fillStyle = K.deck; ctx.fillRect(bx, y, bw, h);
      ctx.fillStyle = K.rule; ctx.fillRect(bx, y + h - 3, bw, 3);
      const verdict = p > VERD;
      if (!verdict) {
        stripes(vx, y, vw, h, now * 0.05);
        text("RESEARCHING", vx + 18, y + 72, { color: K.accent, s: 34, ls: 1 });
        text("SYSTEM 2  ·  THE WEB", vx + 18, y + 102, { color: K["ink-2"], w: 600, s: 17, ls: 1.2 });
      } else {
        ctx.fillStyle = K[VCOL[c.v]]; slant(vx, y, vw, h, 14); ctx.fill();
        const ink = c.v === "misleading" ? K["paper-ink"] : K.paper;
        text(c.v.toUpperCase(), vx + 18, y + 74, { color: ink, s: c.v === "contradicted" ? 34 : 38, ls: 0.5 });
        text("SYSTEM 2  ·  SOURCED", vx + 18, y + 104, { color: ink, w: 600, s: 17, ls: 1.2 });
      }
      // body: the claim restated, then the correction
      font(700, 26, "body");
      const bl = wrap(c.q.split(" "), bw - 60);
      let by = y + 44;
      bl.slice(0, 2).forEach((l) => { font(700, 26, "body"); ctx.fillStyle = K.ink; ctx.fillText(l.map((i) => c.q.split(" ")[i]).join(" "), bx + 36, by); by += 33; });
      if (verdict) {
        const a = RM ? 1 : clamp((p - VERD) / 0.3);
        ctx.globalAlpha = out * a;
        font(400, 22, "body"); ctx.fillStyle = K["ink-2"];
        const nl = wrap(c.note.split(" "), bw - 60);
        nl.slice(0, 2).forEach((l) => { ctx.fillText(l.map((i) => c.note.split(" ")[i]).join(" "), bx + 36, by + 4); by += 29; });
        ctx.globalAlpha = out;
      }
      // light sweep as it lands
      const sw = RM ? -1 : (p - (verdict ? VERD : RES)) / 0.9;
      if (sw > 0 && sw < 1) {
        const sx = vx - 200 + sw * (W + 200);
        const g = ctx.createLinearGradient(sx - 120, 0, sx + 120, 0);
        g.addColorStop(0, rgba(K.paper, 0)); g.addColorStop(0.5, rgba(K.paper, 0.4)); g.addColorStop(1, rgba(K.paper, 0));
        ctx.fillStyle = g; ctx.fillRect(vx, y, W - 120, h);
      }
      ctx.restore();
    }
    ctx.restore();
    ticker(now);
  }

  // ---------- CH 4: your Mac only ----------
  const BOX = { x: 560, y: 186, w: 400, h: 404 };
  let parts = null, hits = [];
  function initParts() {
    parts = [];
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * 6.283, s = 120 + Math.random() * 110;
      parts.push({ x: BOX.x + 40 + Math.random() * (BOX.w - 80), y: BOX.y + 50 + Math.random() * (BOX.h - 100), vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 6 + Math.random() * 6, c: i % 2 ? "host" : "remote" });
    }
    parts.push({ x: BOX.x + 90, y: BOX.y + 100, vx: 140, vy: 90, label: "REC", c: "live", w: 60, h: 28 });
    parts.push({ x: BOX.x + 260, y: BOX.y + 330, vx: -120, vy: -130, label: "KEYS", c: "hype", w: 66, h: 28 });
    hits = [];
  }
  let lastT = 0;
  function drawPrivacy(t, now) {
    ctx.fillStyle = K.ground; ctx.fillRect(0, 0, W, H);
    bug("YOUR MAC ONLY", now);
    ["SERVER", "ACCOUNT", "ANALYTICS"].forEach((w, i) => {
      const e = RM ? 1 : ease((t - 0.15 - i * 0.22) / 0.5);
      if (e <= 0) return;
      ctx.save(); ctx.globalAlpha = e; ctx.translate((1 - e) * -50, 0);
      const y = 168 + i * 86;
      ctx.fillStyle = K.live; slant(64, y, 84, 66, 14); ctx.fill();
      text("NO", 78, y + 52, { color: K.paper, s: 50, ls: 1 });
      text(w, 164, y + 54, { color: K.ink, s: 60, ls: 1.5 });
      ctx.restore();
    });
    const e2 = RM ? 1 : ease((t - 0.9) / 0.6);
    ctx.save(); ctx.globalAlpha = e2;
    text("Recordings and keys", 64, 474, { fam: "body", w: 600, s: 34, color: K["ink-2"] });
    text("stay on your Mac.", 64, 516, { fam: "body", w: 600, s: 34, color: K.ink });
    ctx.restore();

    // the boundary: nothing leaves it
    ctx.setLineDash([14, 10]); ctx.strokeStyle = K.accent; ctx.lineWidth = 3;
    ctx.strokeRect(BOX.x, BOX.y, BOX.w, BOX.h); ctx.setLineDash([]);
    const tag = "YOUR MAC", tw = measure(tag, 800, 18, "cond", 2) + 28;
    ctx.fillStyle = K.accent; ctx.fillRect(BOX.x, BOX.y - 30, tw, 30);
    text(tag, BOX.x + 14, BOX.y - 8, { color: K["paper-ink"], s: 18, ls: 2 });
    // a laptop
    const lx = BOX.x + BOX.w / 2 - 110, ly = BOX.y + 120;
    ctx.fillStyle = K.deck; ctx.strokeStyle = K["ink-2"]; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.roundRect(lx, ly, 220, 140, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = K["deck-3"]; ctx.beginPath(); ctx.moveTo(lx - 26, ly + 148); ctx.lineTo(lx + 246, ly + 148); ctx.lineTo(lx + 232, ly + 164); ctx.lineTo(lx - 12, ly + 164); ctx.closePath(); ctx.fill(); ctx.stroke();
    appIcon(lx + 80, ly + 40, 60);

    if (!parts) initParts();
    const dt = clamp((now - lastT) / 1000, 0, 0.05); lastT = now;
    const L = BOX.x + 6, R = BOX.x + BOX.w - 6, T = BOX.y + 6, B = BOX.y + BOX.h - 6;
    for (const q of parts) {
      if (!RM) { q.x += q.vx * dt; q.y += q.vy * dt; }
      const hw = q.label ? q.w / 2 : q.r, hh = q.label ? q.h / 2 : q.r;
      if (q.x - hw < L) { q.x = L + hw; q.vx = Math.abs(q.vx); hits.push({ x: L, y: q.y, t: now }); }
      if (q.x + hw > R) { q.x = R - hw; q.vx = -Math.abs(q.vx); hits.push({ x: R, y: q.y, t: now }); }
      if (q.y - hh < T) { q.y = T + hh; q.vy = Math.abs(q.vy); hits.push({ x: q.x, y: T, t: now }); }
      if (q.y + hh > B) { q.y = B - hh; q.vy = -Math.abs(q.vy); hits.push({ x: q.x, y: B, t: now }); }
      ctx.fillStyle = K[q.c];
      if (q.label) {
        ctx.fillRect(q.x - hw, q.y - hh, q.w, q.h);
        text(q.label, q.x, q.y + 7, { align: "center", color: q.c === "hype" ? K["paper-ink"] : K.paper, s: 18, ls: 2 });
      } else { ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.fill(); }
    }
    hits = hits.filter((h) => now - h.t < 500);
    for (const h of hits) {
      const a = 1 - (now - h.t) / 500;
      ctx.strokeStyle = rgba(K.accent, a); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(h.x, h.y, 8 + (1 - a) * 22, 0, 7); ctx.stroke();
    }
    ticker(now);
  }

  // ---------- CH 5: download ----------
  let downloaded = false;
  function drawDownload(t, now) {
    ctx.fillStyle = K.ground; ctx.fillRect(0, 0, W, H);
    bug("DOWNLOAD", now, { block: K.accent, ink: K["paper-ink"], word: "FREE", dot: false });
    // chevrons pointing up at the button on top of the set
    for (let i = 0; i < 3; i++) {
      const ph = RM ? 1 : (0.5 + 0.5 * Math.sin(now / 260 - i * 0.9));
      const y = 250 - i * 38 - (RM ? 0 : ph * 6);
      ctx.strokeStyle = rgba(K.accent, 0.35 + 0.65 * ph); ctx.lineWidth = 12; ctx.lineCap = "square";
      ctx.beginPath(); ctx.moveTo(512 - 46, y + 30); ctx.lineTo(512, y - 12); ctx.lineTo(512 + 46, y + 30); ctx.stroke();
    }
    ctx.lineCap = "butt";
    const mac = CA.isMac;
    const head = downloaded ? "DOWNLOAD STARTED" : "DOWNLOAD FOR MAC";
    text(head, 512, 382, { align: "center", color: K.ink, s: 104, ls: 2 });
    const sub = downloaded ? "See you on air." : mac ? "Press the big button on top of the set." : "It's a Mac app. Open this page on your Mac to download it.";
    text(sub, 512, 440, { align: "center", color: K.accent, fam: "body", w: 600, s: mac || downloaded ? 32 : 26 });
    text("APPLE SILICON  ·  MACOS 14.2 OR LATER  ·  FREE AND OPEN SOURCE", 512, 500, { align: "center", color: K.mute, w: 700, s: 22, ls: 2 });
    const r = CA.release;
    if (r) text(`${r.version}  ·  ${r.size}`, 512, 534, { align: "center", color: K["ink-2"], w: 700, s: 22, ls: 2 });
    text("Bring two API keys, from OpenAI and OpenRouter. About $1.60 per hour of show.", 512, 612, { align: "center", color: K["ink-2"], fam: "body", w: 500, s: 22 });
    // a pulsing frame
    const a = RM ? 0.6 : 0.35 + 0.35 * Math.sin(now / 300);
    ctx.strokeStyle = rgba(K.accent, a); ctx.lineWidth = 4; ctx.strokeRect(60, 128, W - 120, 530);
  }

  const CH = [
    { osd: "TEST CARD", draw: drawTest, glow: "accent", sr: "Test card: colour bars in the app's palette and the station ident, Tattle." },
    { osd: "LIVE TRANSCRIPT", draw: drawTranscript, glow: "host", sr: "Channel 1, live transcript: captions stream as the host and a guest speak. Each voice is a speaker you can name, and claims get flagged for fact-checking." },
    { osd: "TIMELINE", draw: drawTimeline, glow: "hype", sr: "Channel 2, timeline: lanes for topic, mode, heat and hype, disagreements, hot takes, predictions, recommendations, and clip-worthy moments fill in as the show runs." },
    { osd: "FACT-CHECK", draw: drawFactcheck, glow: "good", sr: "Channel 3, fact-check: claims appear as lower thirds with sourced verdicts: supported, contradicted, misleading, or unverifiable." },
    { osd: "YOUR MAC ONLY", draw: drawPrivacy, glow: "remote", sr: "Channel 4, your Mac only: no server, no account, no analytics. Recordings and keys stay on your Mac." },
    { osd: "DOWNLOAD", draw: drawDownload, glow: "accent", sr: "Channel 5, download: the Download for Mac button is on top of the set." },
  ];

  // ---------- the CRT ----------
  const VS = "attribute vec2 a;varying vec2 v;void main(){v=a*0.5+0.5;gl_Position=vec4(a,0.,1.);}";
  const FS = `
precision mediump float;
varying vec2 v;
uniform sampler2D u_tex;
uniform vec2 u_res, u_mouse;
uniform float u_time, u_static, u_roll, u_rollOn, u_power, u_magnet, u_wobble, u_motion;
const vec3 GROUND = vec3(0.0392, 0.0863, 0.1569);
float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 curve(vec2 uv){ uv = uv * 2.0 - 1.0; vec2 o = abs(uv.yx) / vec2(5.2, 4.2); uv += uv * o * o; return uv * 0.5 + 0.5; }
vec3 tx(vec2 p){ return texture2D(u_tex, p).rgb; }
void main(){
  vec2 p = vec2(v.x, 1.0 - v.y);
  vec2 c = curve(p);
  float edge = min(min(c.x, 1.0 - c.x), min(c.y, 1.0 - c.y));
  if (edge < 0.0) { gl_FragColor = vec4(GROUND * 0.55, 1.0); return; }
  float sx = smoothstep(0.0, 0.3, u_power);
  float sy = mix(0.006, 1.0, smoothstep(0.3, 1.0, u_power));
  vec2 q = c;
  q.y = 0.5 + (q.y - 0.5) / sy;
  q.x = 0.5 + (q.x - 0.5) / max(sx, 0.001);
  float lit = step(abs(q.y - 0.5), 0.5) * step(abs(q.x - 0.5), 0.5);
  q.y = fract(q.y + u_roll);
  float band = mix(1.0, smoothstep(0.0, 0.04, q.y) * smoothstep(1.0, 0.96, q.y), u_rollOn);
  float ln = floor(q.y * 260.0);
  q.x += (hash(vec2(ln, floor(u_time * 24.0))) - 0.5) * 0.05 * u_static;
  q.x += sin(q.y * 9.0 + u_time * 1.7) * 0.0006 * u_motion;
  q.x += sin(q.y * 36.0 + u_time * 28.0) * 0.014 * u_wobble;
  vec2 d = (c - u_mouse) * vec2(1.333, 1.0);
  float m = u_magnet * exp(-dot(d, d) / 0.02);
  q += (c - u_mouse) * m * 0.07;
  float ca = 0.0011 + 0.006 * u_static + 0.01 * m + 0.006 * u_wobble;
  vec3 col = vec3(tx(q + vec2(ca, 0.0)).r, tx(q).g, tx(q - vec2(ca, 0.0)).b);
  vec3 b = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854 + 0.39;
    vec2 o = vec2(cos(a), sin(a));
    b += tx(q + o * vec2(0.008, 0.0105));
  }
  b /= 8.0;
  col += max(b - 0.22, 0.0) * 0.6;
  col = mix(col, col.brg, m * 0.55 + u_wobble * 0.45);
  float n = hash(gl_FragCoord.xy + fract(u_time * 7.13) * vec2(311.0, 173.0));
  col = mix(col, mix(GROUND, vec3(0.953, 0.965, 0.98), n), clamp(u_static, 0.0, 1.0));
  col += (n - 0.5) * 0.04 * u_motion;
  float lines = max(u_res.y / 3.0, 140.0);
  float s = 0.5 + 0.5 * sin(p.y * lines * 6.2832);
  col *= mix(0.66, 1.14, s);
  float mx = mod(gl_FragCoord.x, 3.0);
  vec3 mask = vec3(0.93);
  if (mx < 1.0) mask.r = 1.07; else if (mx < 2.0) mask.g = 1.07; else mask.b = 1.07;
  col *= mask;
  col *= 1.0 - 0.02 * u_motion * (0.5 + 0.5 * sin(u_time * 110.0));
  col *= lit * (1.0 + (1.0 - sy) * 2.2) * band;
  float vig = pow(clamp(16.0 * c.x * c.y * (1.0 - c.x) * (1.0 - c.y), 0.0, 1.0), 0.28);
  col = mix(GROUND * 0.55, col, vig);
  col += vec3(0.85, 0.92, 1.0) * 0.06 * smoothstep(0.36, 0.0, length((p - vec2(0.27, 0.14)) * vec2(1.0, 1.7)));
  col = mix(GROUND * 0.55, col, smoothstep(0.0, 0.005, edge));
  gl_FragColor = vec4(col, 1.0);
}`;

  function initGL(canvas) {
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    try { gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); } catch (e) { console.warn(e); return null; }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const U = {};
    ["u_res", "u_mouse", "u_time", "u_static", "u_roll", "u_rollOn", "u_power", "u_magnet", "u_wobble", "u_motion"].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    return {
      render(u) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);
        gl.uniform2f(U.u_res, canvas.width, canvas.height);
        gl.uniform2f(U.u_mouse, u.mx, u.my);
        for (const k of ["time", "static", "roll", "rollOn", "power", "magnet", "wobble", "motion"]) gl.uniform1f(U["u_" + k], u[k]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
    };
  }

  // ---------- state, tuning, and the loop ----------
  const screen = $("#screen"), crt = $("#crt"), knob = $("#knob"), sr = $("#sr"), screenDl = $("#screen-dl"), soundBtn = $("#sound");
  let gl = null;
  try { gl = initGL(crt); } catch (e) { gl = null; }
  if (!gl) { // no WebGL: show the flat picture with CSS scanlines
    scene.className = crt.className; scene.setAttribute("role", "img"); scene.setAttribute("aria-label", crt.getAttribute("aria-label"));
    crt.replaceWith(scene); screen.classList.add("flat");
  }
  const picture = gl ? crt : scene;

  let ch = 0, target = 0, chStart = performance.now(), osdUntil = 0, soundOsdUntil = 0, trans = null, powerStart = null;
  let autosurf = !RM, nextSurf = Infinity, running = false, onScreen = true, booted = false;
  let mouse = { x: -5, y: -5 }, hovering = false, magnet = 0, degaussAt = -1e9;

  const DET = [-125, -75, -25, 25, 75, 125];
  const knobWrap = $("#knob-wrap");
  const ticks = DET.map((a, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tick"; b.style.setProperty("--a", a + "deg");
    b.textContent = i ? String(i) : "T"; b.tabIndex = -1; b.setAttribute("aria-hidden", "true");
    b.addEventListener("click", () => tune(i, true));
    knobWrap.appendChild(b); return b;
  });
  const listBtns = [...document.querySelectorAll("#chlist button")];
  let drag = null;

  function syncUI(n) {
    if (!drag) knob.style.setProperty("--rot", DET[n] + "deg");
    knob.setAttribute("aria-valuenow", n);
    knob.setAttribute("aria-valuetext", n ? `Channel ${n}, ${CH[n].osd.toLowerCase()}` : "Test card");
    ticks.forEach((b, i) => b.classList.toggle("on", i === n));
    listBtns.forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.ch === n)));
    document.documentElement.style.setProperty("--glow", K[CH[n].glow]);
  }
  function swapTo(n, now) {
    ch = n; chStart = now; tScroll = 0; parts = null; lastT = now;
    sr.textContent = CH[n].sr;
    picture.setAttribute("aria-label", CH[n].sr);
    screenDl.hidden = !(n === 5 && CA.isMac);
    updateTone();
  }
  function tune(n, user) {
    n = clamp(Math.round(n), 0, 5);
    if (user) autosurf = false;
    if (n === target) return;
    target = n;
    const now = performance.now();
    osdUntil = now + 3200;
    syncUI(n);
    if (RM) { swapTo(n, now); trans = null; }
    else trans = { t0: now, dur: 760, swapAt: 170, to: n, swapped: false };
    playStatic();
    if (!running) frame(now, true);
  }

  function render(now) {
    let stat = RM ? 0 : 0.035, roll = 0, rollOn = 0;
    if (trans) {
      const p = (now - trans.t0) / trans.dur;
      if (!trans.swapped && now - trans.t0 >= trans.swapAt) { swapTo(trans.to, now); trans.swapped = true; }
      if (p >= 1) trans = null;
      else {
        stat = p < 0.22 ? 0.92 : 0.92 * Math.pow(1 - (p - 0.22) / 0.78, 2);
        roll = 1.5 * (1 - ease(p));
        rollOn = clamp((1 - p) * 4);
      }
    }
    if (autosurf && booted && now > nextSurf) { nextSurf = now + (target === 3 ? 10500 : 8200); tune(target >= 5 ? 1 : target + 1, false); }
    const t = (now - chStart) / 1000;
    ctx.save(); CH[ch].draw(t, now); ctx.restore();
    if (hasLS) ctx.letterSpacing = "0px";
    if (now < osdUntil) {
      pix("CH " + String(ch).padStart(2, "0"), W - 64, 52, 7, "right");
      pix(CH[ch].osd, W - 64, 52 + 49 + 12, 4, "right");
    }
    if (now < soundOsdUntil) {
      const x = pix(sound ? "SOUND" : "MUTE", 64, H - 170, 5);
      for (let i = 0; i < 12; i++) { ctx.fillStyle = sound ? K.good : K["deck-3"]; ctx.fillRect(64 + x + 24 + i * 16, H - 170 + (i < 12 ? 0 : 0), 10, 35); }
    }
    const power = powerStart == null ? 0 : RM ? 1 : clamp((now - powerStart) / 1100);
    if (gl) {
      magnet += ((hovering && !RM ? 1 : 0) - magnet) * 0.08;
      const wob = RM ? 0 : Math.pow(clamp(1 - (now - degaussAt) / 1100), 2);
      gl.render({ time: (now / 1000) % 1000, static: stat, roll, rollOn, power, magnet, wobble: wob, motion: RM ? 0 : 1, mx: mouse.x, my: mouse.y });
    }
  }
  function frame(now, once) {
    if (!once) { if (!running) return; requestAnimationFrame(frame); }
    render(now);
  }
  function setRunning() {
    const want = booted && onScreen && !document.hidden;
    if (want && !running) { running = true; requestAnimationFrame(frame); }
    else if (!want) running = false;
    updateTone();
  }
  document.addEventListener("visibilitychange", setRunning);
  new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; setRunning(); }).observe(screen);

  function resize() {
    if (!gl) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), r = screen.getBoundingClientRect();
    crt.width = Math.max(2, Math.round(r.width * dpr)); crt.height = Math.max(2, Math.round(r.height * dpr));
    if (!running && booted) frame(performance.now(), true);
  }
  new ResizeObserver(resize).observe(screen);
  resize();

  // ---------- the knob: drag, scroll wheel, arrow keys, tap ----------
  const nearest = (rot) => DET.reduce((best, a, i) => (Math.abs(a - rot) < Math.abs(DET[best] - rot) ? i : best), 0);
  const angle = (e) => { const r = knob.getBoundingClientRect(); return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI; };
  knob.addEventListener("pointerdown", (e) => {
    e.preventDefault(); knob.focus({ preventScroll: true });
    knob.setPointerCapture(e.pointerId);
    drag = { a: angle(e), rot: DET[target], moved: 0 };
    knob.classList.add("dragging");
  });
  knob.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const a = angle(e); let d = a - drag.a;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    drag.a = a; drag.moved += Math.abs(d);
    drag.rot = clamp(drag.rot + d, -140, 140);
    knob.style.setProperty("--rot", drag.rot + "deg");
    const n = nearest(drag.rot);
    if (n !== target) tune(n, true);
  });
  const endDrag = () => {
    if (!drag) return;
    const tap = drag.moved < 3;
    drag = null; knob.classList.remove("dragging");
    if (tap) tune(target >= 5 ? 0 : target + 1, true);
    knob.style.setProperty("--rot", DET[target] + "deg");
  };
  knob.addEventListener("pointerup", endDrag);
  knob.addEventListener("pointercancel", endDrag);
  let wheelAcc = 0, wheelAt = 0;
  knob.addEventListener("wheel", (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt > 250) wheelAcc = 0;
    wheelAt = now; wheelAcc += e.deltaY || e.deltaX;
    if (Math.abs(wheelAcc) > 40) { tune(target + Math.sign(wheelAcc), true); wheelAcc = 0; }
  }, { passive: false });
  knob.addEventListener("keydown", (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, PageUp: 1, ArrowDown: -1, ArrowLeft: -1, PageDown: -1 }[e.key];
    if (step) { e.preventDefault(); tune(target + step, true); }
    else if (e.key === "Home") { e.preventDefault(); tune(0, true); }
    else if (e.key === "End") { e.preventDefault(); tune(5, true); }
  });
  // the number keys work like a remote
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (/^[0-5]$/.test(e.key)) tune(+e.key, true);
  });
  listBtns.forEach((b) => b.addEventListener("click", () => tune(+b.dataset.ch, true)));
  document.querySelectorAll("[data-tune]").forEach((b) => b.addEventListener("click", () => {
    tune(+b.dataset.tune, true);
    $("#tv").scrollIntoView({ behavior: RM ? "auto" : "smooth", block: "center" });
  }));

  // the glass: a magnet under the cursor, and a click degausses
  screen.addEventListener("pointermove", (e) => {
    const r = screen.getBoundingClientRect();
    mouse = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; hovering = e.pointerType === "mouse";
  });
  screen.addEventListener("pointerleave", () => { hovering = false; });
  screen.addEventListener("click", (e) => { if (!e.target.closest("[data-download]")) { degaussAt = performance.now(); playThunk(); } });

  // ---------- sound: off until pressed; a 1 kHz tone on the test card, static between channels ----------
  let sound = false, actx = null, toneGain = null, noiseBuf = null;
  soundBtn.addEventListener("click", () => {
    sound = !sound;
    soundBtn.setAttribute("aria-pressed", String(sound));
    if (sound && !actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        actx = new AC();
        toneGain = actx.createGain(); toneGain.gain.value = 0; toneGain.connect(actx.destination);
        const osc = actx.createOscillator(); osc.frequency.value = 1000; osc.connect(toneGain); osc.start();
        noiseBuf = actx.createBuffer(1, actx.sampleRate * 0.5, actx.sampleRate);
        const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
    }
    if (actx) actx.resume();
    soundOsdUntil = performance.now() + 2200;
    updateTone();
  });
  function updateTone() {
    if (!actx || !toneGain) return;
    const on = sound && ch === 0 && running;
    toneGain.gain.setTargetAtTime(on ? 0.035 : 0, actx.currentTime, 0.04);
  }
  function burst(len, vol) {
    if (!sound || !actx || !noiseBuf) return;
    const src = actx.createBufferSource(); src.buffer = noiseBuf;
    const g = actx.createGain(), t0 = actx.currentTime;
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0008, t0 + len);
    src.connect(g); g.connect(actx.destination); src.start(); src.stop(t0 + len);
  }
  const playStatic = () => burst(0.45, 0.06);
  const playThunk = () => burst(0.25, 0.1);

  // a download press lands the set on channel 5
  window.addEventListener("ca:download", (e) => {
    downloaded = true; tune(5, false); autosurf = false;
    const k = e.detail && e.detail.el; if (k && k.classList.contains("key")) { k.classList.add("pressed"); setTimeout(() => k.classList.remove("pressed"), 160); }
  });

  // ---------- power on ----------
  syncUI(0);
  sr.textContent = CH[0].sr;
  const fontsReady = Promise.race([
    Promise.all(['800 20px "Barlow Condensed"', '700 20px "Barlow Condensed"', '600 20px "Barlow Condensed"', "500 20px Barlow", "600 20px Barlow", "700 20px Barlow", "italic 500 20px Barlow", "400 20px Barlow"].map((f) => document.fonts.load(f))),
    new Promise((r) => setTimeout(r, 1200)),
  ]).catch(() => {});
  fontsReady.then(() => {
    const now = performance.now();
    booted = true; powerStart = now; chStart = now; osdUntil = now + 4200;
    nextSurf = now + 6500;
    const deep = /^#ch([0-5])$/.exec(location.hash);
    if (deep) { autosurf = false; syncUI(+deep[1]); target = +deep[1]; swapTo(target, now); osdUntil = now + 4200; }
    setRunning();
    if (!running) frame(now, true);
  });
})();
