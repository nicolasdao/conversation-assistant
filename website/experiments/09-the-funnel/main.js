// 09 · The Funnel — everything said in a show pours in; System 1 sieves out the claims;
// System 2 researches them; verdicts drop into bins. Matter.js does the physics, a 2D canvas draws it.
(function () {
  "use strict";
  const M = window.Matter;
  const CA = window.CA || { reducedMotion: false };
  const RM = !!CA.reducedMotion;
  const $ = (id) => document.getElementById(id);
  const machine = $("machine"), stage = $("stage"), canvas = $("world"), ov = $("ov");
  if (!M || !canvas) return;
  const { Engine, Bodies, Body, Composite, Constraint, Query, Events } = M;
  const ctx = canvas.getContext("2d");

  // ---------- the theme's colours, read from the tokens ----------
  const css = getComputedStyle(document.documentElement);
  const C = {};
  ["ground", "deck", "deck-2", "deck-3", "rule", "ink", "ink-2", "mute", "paper-ink", "accent", "live", "good", "bad", "warn", "neutral", "host", "remote", "hype", "heat"]
    .forEach((k) => { C[k] = css.getPropertyValue("--" + k).trim(); });
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  // ---------- what gets said ----------
  const VERDICTS = [
    { key: "supported", label: "Supported", color: C.good },
    { key: "misleading", label: "Misleading", color: C.warn },
    { key: "contradicted", label: "Contradicted", color: C.bad },
  ];
  const CLAIMS = [
    { short: "Great Wall, seen from space", full: "The Great Wall of China is visible from space with the naked eye.", v: 2, note: "Astronauts report it isn't." },
    { short: "Bananas are berries", full: "Bananas are berries.", v: 0, note: "Botanically, yes." },
    { short: "Goldfish: 3-second memory", full: "Goldfish only have a three-second memory.", v: 2, note: "They remember for months." },
    { short: "Lightning never strikes twice", full: "Lightning never strikes the same place twice.", v: 2, note: "The Empire State Building is hit about 20–25 times a year." },
    { short: "Coffee dehydrates you", full: "Coffee dehydrates you.", v: 1, note: "Its water outweighs the mild diuretic effect." },
    { short: "Everest grows every year", full: "Mount Everest gets a little taller every year.", v: 0, note: "A few millimetres a year." },
    { short: "Bats are blind", full: "Bats are blind.", v: 2, note: "All bats can see." },
    { short: "Tomb honey, still edible", full: "Honey found in Egyptian tombs was still edible.", v: 0, note: "" },
    { short: "8 spiders a year, asleep", full: "The average person swallows eight spiders a year in their sleep.", v: 2, note: "" },
    { short: "Octopuses: three hearts", full: "Octopuses have three hearts.", v: 0, note: "" },
  ];
  const CHATTER = ["Right.", "Ha, fair.", "Go on.", "Wait, really?", "Totally.", "Mm-hm.", "So anyway", "Good point", "Hold on", "Exactly.",
    "That's wild", "Let me push back", "We'll get to that", "Welcome back", "Okay, enough about models", "Surfing in Sydney?",
    "I don't buy that at all", "Cheap is not the same as good", "Yeah, yeah", "Hmm."];
  let claimDeck = [];
  const nextClaim = () => { if (!claimDeck.length) claimDeck = CLAIMS.slice().sort(() => Math.random() - 0.5); return claimDeck.pop(); };
  let lastVoice = "host";

  // ---------- geometry: a world in its own units, scaled to the canvas ----------
  const CAT_WALL = 1, CAT_DOOR = 2, CAT_PILL = 4;
  let G = null;       // layout
  let engine, world;
  let scale = 1, dpr = 1;
  let statics = [], pegs = [];

  function layout(phone) {
    const WW = phone ? 440 : 720, HH = phone ? 780 : 820, m = 16;
    const tL = Math.round(WW * (phone ? 0.3 : 0.31)), tR = Math.round(WW * (phone ? 0.7 : 0.69));
    const bw = phone ? 80 : 96;
    const xB0 = WW - m - 3 * bw;
    const g = {
      phone, WW, HH, m, tL, tR, bw, xB0,
      topY: 250, doorY: 392, apexY: 434,
      plateEnd: { x: phone ? 118 : 176, y: phone ? 552 : 566 },
      gateL: Math.max(WW - m - 2 * bw - (phone ? 6 : 10), tR + 6),
      gateTop: 468, gateFloor: phone ? 574 : 584,
      floor: HH - 44,
      pegR: phone ? 4.5 : 5, pegRows: [292, 330, 368], pegSx: phone ? 56 : 64,
      pillH: 26, pillMax: phone ? 108 : 126, ballR: phone ? 12 : 13,
      heardCap: phone ? 18 : 34, binCap: phone ? 6 : 6, maxBodies: phone ? 64 : 90,
      nozA: Math.round(WW * 0.3), nozB: Math.round(WW * 0.7),
    };
    g.chuteEnd = { x: g.gateL + (phone ? 42 : 60), y: g.apexY + (phone ? 40 : 48) };
    g.railY = g.gateFloor + 22;
    g.binTop = g.gateFloor + 58;
    return g;
  }
  const chuteY = (x) => G.apexY + (x - G.tR) / (G.chuteEnd.x - G.tR) * (G.chuteEnd.y - G.apexY);

  function seg(x1, y1, x2, y2, t, extra) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    const b = Bodies.rectangle((x1 + x2) / 2, (y1 + y2) / 2, len + t * 0.5, t,
      Object.assign({ isStatic: true, angle: Math.atan2(dy, dx), friction: 0.01, frictionStatic: 0.05, restitution: 0.1, collisionFilter: { category: CAT_WALL, mask: 0xffff } }, extra || {}));
    b.plugin = { kind: "wall" };
    return b;
  }

  function buildWorld() {
    engine = Engine.create({ gravity: { x: 0, y: 1, scale: 0.001 }, positionIterations: 8, velocityIterations: 6 });
    world = engine.world;
    const g = G, t = 14;
    statics = [
      seg(g.m + 10, 64, g.tL, g.topY, t), seg(g.WW - g.m - 10, 64, g.tR, g.topY, t),                 // hopper
      seg(g.tL, g.topY, g.tL, 420, t),                                                                    // throat, left
      seg(g.tR, g.topY, g.tR, g.apexY, t, { collisionFilter: { category: CAT_DOOR, mask: 0xffff } }),     // throat, right: the door
      seg(g.tR, g.apexY, g.plateEnd.x, g.plateEnd.y, t),                                                  // plate to the heard pile
      seg(g.tR, g.apexY, g.chuteEnd.x, g.chuteEnd.y, t),                                                  // chute to System 2
      seg(g.gateL, chuteY(g.gateL) + 10, g.gateL, g.gateFloor, t),                                        // System 2, left
      seg(g.gateL, g.gateFloor, g.WW - g.m, g.gateFloor, t),                                              // System 2, floor
      seg(g.xB0, g.apexY + (g.tR - g.xB0) / (g.tR - g.plateEnd.x) * (g.plateEnd.y - g.apexY) + 4, g.xB0, g.floor, t), // heard | bins
      seg(g.xB0 + g.bw, g.binTop, g.xB0 + g.bw, g.floor, 8), seg(g.xB0 + 2 * g.bw, g.binTop, g.xB0 + 2 * g.bw, g.floor, 8),
      seg(g.m, -300, g.m, g.floor, t), seg(g.WW - g.m, -300, g.WW - g.m, g.floor, t),                     // sides
      seg(g.m - 6, g.floor, g.WW - g.m + 6, g.floor, 20),                                                 // floor
    ];
    statics[3].plugin.door = true;
    pegs = [];
    g.pegRows.forEach((y, r) => {
      const off = r % 2 ? g.pegSx : g.pegSx / 2;
      for (let x = g.tL + off; x < g.tR - 12; x += g.pegSx) {
        const p = Bodies.circle(x, y, g.pegR + 3, { isStatic: true, isSensor: true, collisionFilter: { category: CAT_WALL, mask: 0xffff } });
        p.plugin = { kind: "peg", flash: 0 };
        pegs.push(p);
      }
    });
    Composite.add(world, statics.concat(pegs));
    Events.on(engine, "collisionStart", (e) => {
      for (const pr of e.pairs) {
        const a = pr.bodyA.plugin, b = pr.bodyB.plugin;
        if (a && a.kind === "peg") a.flash = 1;
        if (b && b.kind === "peg") b.flash = 1;
      }
    });
    placeOverlays();
  }

  // ---------- the moving parts ----------
  const measure = document.createElement("canvas").getContext("2d");
  const PILL_FONT = "600 13.5px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  function fitText(txt, max) {
    measure.font = PILL_FONT;
    if (measure.measureText(txt).width <= max) return txt;
    let s = txt;
    while (s.length > 3 && measure.measureText(s + "…").width > max) s = s.slice(0, -1);
    return s.trimEnd() + "…";
  }

  function dynamics() { return Composite.allBodies(world).filter((b) => !b.isStatic); }

  function spawnPill(kindHint) {
    if (dynamics().length >= G.maxBodies) return false;
    const r = Math.random();
    const voice = Math.random() < 0.62 ? lastVoice : (lastVoice === "host" ? "remote" : "host");
    lastVoice = voice;
    let claim = null, text = "";
    if (kindHint === "claim" || (!kindHint && r < 0.2)) claim = nextClaim();
    else if (r < 0.62) text = CHATTER[(Math.random() * CHATTER.length) | 0];
    let w, h = G.pillH;
    if (claim || text) {
      const raw = claim ? claim.short : text;
      text = fitText(raw, G.pillMax - 18);
      measure.font = PILL_FONT;
      w = Math.min(G.pillMax, Math.ceil(measure.measureText(text).width) + 20);
    } else { w = 26 + Math.random() * 26; h = 17; }
    const nx = voice === "host" ? G.nozA : G.nozB;
    const b = Bodies.rectangle(nx + (Math.random() - 0.5) * 16, 26, w, h, {
      chamfer: { radius: h / 2 - 0.5 }, restitution: 0.18, friction: 0.02, frictionStatic: 0.08, frictionAir: 0.012, density: 0.0018,
      angle: (Math.random() - 0.5) * 0.5, collisionFilter: { category: CAT_PILL, mask: CAT_WALL | CAT_DOOR | CAT_PILL },
    });
    Body.setVelocity(b, { x: (voice === "host" ? 1 : -1) * (0.6 + Math.random() * 1.4), y: 1 + Math.random() });
    Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.04);
    b.plugin = { kind: "pill", voice, claim, text, w, h, stuck: 0, alpha: 1, born: simT };
    Composite.add(world, b);
    level[voice] = 0.55 + Math.random() * 0.45;
    return true;
  }

  function spawnBall(claim, voice) {
    const v = claim.v;
    const x = G.xB0 + G.bw * (v + 0.5) + (Math.random() - 0.5) * 10;
    const b = Bodies.circle(x, G.railY + 14, G.ballR, {
      restitution: 0.42, friction: 0.05, frictionAir: 0.01, density: 0.003,
      collisionFilter: { category: CAT_PILL, mask: CAT_WALL | CAT_DOOR | CAT_PILL },
    });
    Body.setVelocity(b, { x: (Math.random() - 0.5) * 0.6, y: 2 });
    b.plugin = { kind: "ball", v, claim, voice, alpha: 1 };
    Composite.add(world, b);
  }

  // ---------- the state the counters show ----------
  const S = { heard: 0, flagged: 0, verdicts: 0, bins: [0, 0, 0] };
  let simT = 0;                       // show time, in seconds
  const heardList = [], binLists = [[], [], []];
  const jobs = [];                    // System 2 at work
  const drops = [];                   // verdicts waiting for the dispenser
  const fx = [];                      // floating labels and rings
  const level = { host: 0, remote: 0 };
  let carriage = null, dropCool = 0, spawnAcc = 0, burst = 0, sensorFlash = 0, doorFlash = 0;
  let speed = 1, speedHold = 0;

  function countLine(b) { if (!b.plugin.counted) { b.plugin.counted = true; S.heard++; } }

  function judge(b) {
    const p = b.plugin;
    p.judged = true;
    countLine(b);
    sensorFlash = 1;
    if (p.claim) {
      p.flagged = true;
      S.flagged++;
      doorFlash = 1;
      b.collisionFilter.mask = CAT_WALL;                            // Jev carries it out through the door
      p.ferry = true;
      p.flagT = simT;
      fx.push({ x: b.position.x, y: b.position.y, ring: true, col: C.accent, t: 0, life: 0.5 });
      fx.push({ x: G.tR + 26, y: G.doorY - 30, txt: "Claim", col: C.accent, t: 0, life: 1.1 });
    } else {
      fx.push({ x: b.position.x, y: b.position.y, ring: true, col: rgba(C.accent, 0.35), t: 0, life: 0.35 });
    }
  }

  function fade(b) { if (b.plugin.fading) return; b.plugin.fading = true; }

  function step(dt) {
    simT += dt;
    const g = G;
    // the show keeps talking
    spawnAcc += dt;
    const every = RM ? 1.5 : 0.62;
    if (burst > 0) { if (spawnAcc > 0.09) { spawnAcc = 0; if (spawnPill(burst % 3 === 0 ? "claim" : null)) burst--; } }
    else if (spawnAcc > every) { spawnAcc = 0; spawnPill(); }

    Engine.update(engine, 1000 / 60);

    const bodies = dynamics();
    for (const b of bodies) {
      const p = b.plugin, x = b.position.x, y = b.position.y;
      if (p.fading) {
        p.alpha -= dt * 2.4;
        if (p.alpha <= 0) Composite.remove(world, b);
        continue;
      }
      if (y > g.HH + 60 || y < -500 || x < -120 || x > g.WW + 120) { Composite.remove(world, b); continue; }
      if (b.speed > 20) Body.setVelocity(b, { x: b.velocity.x * 20 / b.speed, y: b.velocity.y * 20 / b.speed });

      if (p.kind === "pill") {
        // System 1: the pegs judge; a line slows while it's weighed, and wobbles past them
        if (!p.judged && y > g.topY + 10 && y < g.doorY && x > g.tL && x < g.tR && !p.held) {
          if (b.velocity.y > 3.2) Body.setVelocity(b, { x: b.velocity.x * 0.96, y: b.velocity.y * 0.9 });
          if (Math.random() < 0.04) Body.setAngularVelocity(b, b.angularVelocity + (Math.random() - 0.5) * 0.05);
        }
        // System 1: the sensor under the pegs
        if (!p.judged && y > g.doorY && y < g.apexY + 34 && x > g.tL && x < g.tR && !p.held && !p.inHeard) judge(b);
        // a flagged claim rides out through the door, then the door closes behind it
        if (p.ferry) {
          const tx = g.tR + p.w / 2 + 16, ty = g.doorY - 10, dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy);
          if (d < 4 || simT - p.flagT > 1.6 || p.held) {
            p.ferry = false; b.collisionFilter.mask = CAT_WALL | CAT_DOOR | CAT_PILL;
            if (!p.held) Body.setVelocity(b, { x: 2.5, y: 0 });
          } else {
            const sp = Math.min(7, d * 0.35);
            Body.setVelocity(b, { x: dx / d * sp, y: dy / d * sp });
            Body.setAngle(b, b.angle * 0.8); Body.setAngularVelocity(b, 0);
            if (Math.random() < 0.5) fx.push({ x: x - p.w / 2, y, dot: true, col: C.accent, t: 0, life: 0.35 });
          }
        }
        // Jev keeps the queue moving: anything stuck above the plate gets a nudge
        if (y < g.apexY + 30 && y > 40 && !p.held) {
          if (b.speed < 0.45) p.stuck += dt; else p.stuck = 0;
          if (p.stuck > 0.4) { p.stuck = 0; Body.setVelocity(b, { x: (Math.random() - 0.5) * 4, y: -1.5 }); Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.12); }
        }
        // the heard pile
        if (!p.inHeard && x < g.xB0 && y > g.plateEnd.y - 30 && !p.held) {
          p.inHeard = true; countLine(b); heardList.push(b);
        }
        // anything that lands in a verdict bin without a verdict dissolves
        if (x > g.xB0 && y > g.binTop && !p.held) { countLine(b); fade(b); }
      } else if (p.kind === "ball") {
        if (!p.landed && y > g.binTop + 8 && x > g.xB0) {
          p.landed = true;
          const i = Math.max(0, Math.min(2, Math.floor((x - g.xB0) / g.bw)));
          S.verdicts++; S.bins[i]++; binLists[i].push(b);
          bump("n-verdicts"); bump("b" + i);
          const live = binLists[i].filter((q) => !q.plugin.fading);
          if (live.length > g.binCap) fade(live[0]);
        }
      }
    }
    // the heard pile keeps only its newest lines on screen
    for (let i = heardList.length - 1; i >= 0; i--) if (!heardList[i].plugin || heardList[i].plugin.alpha <= 0) heardList.splice(i, 1);
    const liveHeard = heardList.filter((b) => !b.plugin.fading);
    for (let i = 0; i < liveHeard.length - g.heardCap; i++) fade(liveHeard[i]);
    for (const l of binLists) for (let i = l.length - 1; i >= 0; i--) if (l[i].plugin.alpha <= 0) l.splice(i, 1);

    // System 2: research what lands in the gate
    const busy = jobs.length;
    const waiting = bodies.filter((b) => b.plugin.kind === "pill" && !b.plugin.fading && !b.plugin.researching && !b.plugin.held &&
      b.position.x > g.gateL && b.position.y > g.gateTop && b.position.y < g.gateFloor && b.speed < 1.2);
    const lanes = waiting.length > 5 ? 3 : waiting.length > 2 ? 2 : 1;
    if (busy < lanes && waiting.length) {
      waiting.sort((a, b) => b.position.y - a.position.y);
      const b = waiting[0];
      b.plugin.researching = true;
      jobs.push({ b, t: 0, dur: 1.5 + Math.random() * 0.9 });
    }
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i];
      j.t += dt;
      if (j.b.plugin.held) { j.b.plugin.researching = false; jobs.splice(i, 1); continue; }
      if (j.t >= j.dur) {
        jobs.splice(i, 1);
        const p = j.b.plugin;
        countLine(j.b);
        Composite.remove(world, j.b);
        if (p.claim) {
          drops.push({ claim: p.claim, voice: p.voice });
          showVerdict(p.claim, p.voice);
          const vd = VERDICTS[p.claim.v];
          fx.push({ x: j.b.position.x, y: g.gateTop - 6, txt: vd.label, col: vd.color, t: 0, life: 1.3 });
        } else {
          fx.push({ x: j.b.position.x, y: g.gateTop - 6, txt: "Not a claim", col: C.mute, t: 0, life: 1.1 });
        }
      }
    }
    // the dispenser rides the rail to the right bin
    if (!carriage) carriage = { x: g.xB0 + g.bw * 1.5 };
    dropCool -= dt;
    if (drops.length) {
      const tx = g.xB0 + g.bw * (drops[0].claim.v + 0.5);
      carriage.x += (tx - carriage.x) * Math.min(1, dt * 9);
      if (Math.abs(tx - carriage.x) < 2 && dropCool <= 0) { const d = drops.shift(); spawnBall(d.claim, d.voice); dropCool = 0.25; }
    }
    for (let i = fx.length - 1; i >= 0; i--) { fx[i].t += dt; if (fx[i].t > fx[i].life) fx.splice(i, 1); }
    for (const p of pegs) p.plugin.flash = Math.max(0, p.plugin.flash - dt * 3);
    sensorFlash = Math.max(0, sensorFlash - dt * 4);
    doorFlash = Math.max(0, doorFlash - dt * 2.2);
    level.host = Math.max(0.06, level.host - dt * 1.6);
    level.remote = Math.max(0.06, level.remote - dt * 1.6);
  }

  // ---------- drawing ----------
  let stripe = null;
  function makeStripe() {
    const c = document.createElement("canvas"); c.width = c.height = 16;
    const x = c.getContext("2d");
    x.fillStyle = C["deck-2"]; x.fillRect(0, 0, 16, 16);
    x.strokeStyle = C["deck-3"]; x.lineWidth = 5.6;
    for (let k = -16; k <= 32; k += 16) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k - 16, 16); x.stroke(); }
    stripe = ctx.createPattern(c, "repeat");
  }
  const hypeStripe = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 12;
    const x = c.getContext("2d");
    x.strokeStyle = rgba(C.hype, 0.55); x.lineWidth = 3;
    for (let k = -12; k <= 24; k += 12) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k - 12, 12); x.stroke(); }
    return c;
  })();
  let hypePat = null;

  function poly(vs) { ctx.beginPath(); ctx.moveTo(vs[0].x, vs[0].y); for (let i = 1; i < vs.length; i++) ctx.lineTo(vs[i].x, vs[i].y); ctx.closePath(); }

  function draw(realT) {
    const g = G;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.fillStyle = C.deck; ctx.fillRect(0, 0, g.WW, g.HH);

    // wells: the hopper, the throat, the pile, the bins
    ctx.fillStyle = rgba(C.ground, 0.6);
    poly([{ x: g.m + 10, y: 64 }, { x: g.WW - g.m - 10, y: 64 }, { x: g.tR, y: g.topY }, { x: g.tL, y: g.topY }]); ctx.fill();
    ctx.fillRect(g.m, g.plateEnd.y - 40, g.xB0 - g.m, g.floor - g.plateEnd.y + 40);
    ctx.fillRect(g.xB0, g.binTop, g.WW - g.m - g.xB0, g.floor - g.binTop);
    ctx.fillStyle = rgba(C.accent, 0.05 + sensorFlash * 0.05);
    ctx.fillRect(g.tL, g.topY, g.tR - g.tL, g.apexY - g.topY);
    // the heard pile's big number, behind the pile
    ctx.fillStyle = rgba(C.ink, 0.05);
    ctx.font = `800 ${g.phone ? 92 : 128}px 'Barlow Condensed', sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(String(S.heard), g.m + 10, g.floor - 20);

    // System 2: the researching gate, in the app's diagonal stripes
    const gw = g.WW - g.m - g.gateL, gh = g.gateFloor - g.gateTop;
    ctx.save();
    ctx.beginPath(); ctx.rect(g.gateL, g.gateTop, gw, gh); ctx.clip();
    if (stripe.setTransform) stripe.setTransform(new DOMMatrix().translateSelf(RM ? 0 : (realT * 22) % 16, 0));
    ctx.fillStyle = stripe; ctx.fillRect(g.gateL, g.gateTop, gw, gh);
    ctx.restore();
    ctx.fillStyle = C.hype; ctx.fillRect(g.gateL, g.gateTop - 3, gw, 3);

    // the sensor line: every line gets a judgment
    ctx.strokeStyle = rgba(C.accent, 0.35 + sensorFlash * 0.65); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(g.tL + 7, g.doorY); ctx.lineTo(g.tR - 7, g.doorY); ctx.stroke(); ctx.setLineDash([]);

    // nozzles
    for (const [nx, col] of [[g.nozA, C.host], [g.nozB, C.remote]]) {
      ctx.fillStyle = C["deck-3"]; poly([{ x: nx - 24, y: 0 }, { x: nx + 24, y: 0 }, { x: nx + 12, y: 22 }, { x: nx - 12, y: 22 }]); ctx.fill();
      ctx.fillStyle = col; ctx.fillRect(nx - 12, 20, 24, 3);
    }

    // walls
    for (const b of statics) {
      poly(b.vertices);
      ctx.fillStyle = C["deck-3"]; ctx.fill();
      ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.stroke();
    }
    // the door in System 1's wall: it lights when a claim goes through
    ctx.fillStyle = doorFlash > 0 ? rgba(C.accent, 0.35 + doorFlash * 0.65) : rgba(C.accent, 0.3);
    ctx.fillRect(g.tR - 3, g.doorY - 24, 6, g.apexY - g.doorY + 18);
    // pegs
    for (const p of pegs) {
      const f = p.plugin.flash;
      if (f > 0) { ctx.fillStyle = rgba(C.accent, 0.25 * f); ctx.beginPath(); ctx.arc(p.position.x, p.position.y, g.pegR + 7 * f, 0, 7); ctx.fill(); }
      ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(p.position.x, p.position.y, g.pegR, 0, 7); ctx.fill();
    }
    // the dispenser rail and carriage
    ctx.fillStyle = C.rule; ctx.fillRect(g.xB0 + 6, g.railY - 1, g.WW - g.m - g.xB0 - 12, 2);
    if (carriage) {
      ctx.fillStyle = C.hype; ctx.fillRect(carriage.x - 16, g.railY - 5, 32, 10);
      ctx.fillStyle = C["deck-3"]; ctx.fillRect(carriage.x - 5, g.railY + 5, 10, 5);
    }

    // research progress, one bar per claim being checked
    jobs.forEach((j, i) => {
      const y = g.gateFloor - 12 - i * 6;
      ctx.fillStyle = rgba(C.ground, 0.8); ctx.fillRect(g.gateL + 10, y, gw - 20, 3);
      ctx.fillStyle = C.hype; ctx.fillRect(g.gateL + 10, y, (gw - 20) * Math.min(1, j.t / j.dur), 3);
    });

    // bodies
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const b of Composite.allBodies(world)) {
      if (b.isStatic) continue;
      const p = b.plugin;
      ctx.globalAlpha = Math.max(0, p.alpha);
      if (p.kind === "pill") {
        ctx.save();
        ctx.translate(b.position.x, b.position.y); ctx.rotate(b.angle);
        const w = p.w, h = p.h;
        ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
        ctx.fillStyle = p.voice === "host" ? C.host : C.remote;
        if (!p.text) ctx.globalAlpha *= 0.75;
        ctx.fill();
        if (p.researching) {
          if (!hypePat) hypePat = ctx.createPattern(hypeStripe, "repeat");
          ctx.fillStyle = hypePat; ctx.fill();
          ctx.lineWidth = 2.5; ctx.strokeStyle = C.hype; ctx.stroke();
        } else if (p.flagged) {
          ctx.lineWidth = 2.5; ctx.strokeStyle = C.accent; ctx.stroke();
        }
        if (p.text) {
          ctx.fillStyle = C["paper-ink"]; ctx.font = PILL_FONT;
          ctx.fillText(p.text, 0, 1);
        }
        ctx.restore();
      } else if (p.kind === "ball") {
        const vd = VERDICTS[p.v], r = G.ballR;
        ctx.fillStyle = vd.color; ctx.beginPath(); ctx.arc(b.position.x, b.position.y, r, 0, 7); ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(b.position.x, b.position.y, r * 0.68, 0, 7); ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(b.position.x, b.position.y, r * 0.42, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // drag line
    if (drag && drag.c) {
      const a = drag.c.pointA, bp = drag.b.position;
      const off = M.Vector.rotate(drag.c.pointB, 0);
      ctx.strokeStyle = rgba(C.ink, 0.5); ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bp.x + off.x, bp.y + off.y); ctx.stroke(); ctx.setLineDash([]);
    }
    // effects
    for (const f of fx) {
      const k = f.t / f.life;
      if (f.dot) {
        ctx.fillStyle = f.col; ctx.globalAlpha = 0.6 * (1 - k);
        ctx.beginPath(); ctx.arc(f.x, f.y, 3, 0, 7); ctx.fill();
      } else if (f.ring) {
        ctx.strokeStyle = f.col; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, 10 + k * 34, 0, 7); ctx.stroke();
      } else {
        ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
        ctx.font = "800 15px 'Barlow Condensed', sans-serif";
        const txt = f.txt.toUpperCase(), tw = ctx.measureText(txt).width + 16, y = f.y - k * 22;
        const x = Math.min(G.WW - G.m - tw / 2 - 4, Math.max(G.m + tw / 2 + 4, f.x));
        ctx.fillStyle = f.col;
        poly([{ x: x - tw / 2, y: y - 10 }, { x: x + tw / 2 + 5, y: y - 10 }, { x: x + tw / 2 - 2, y: y + 10 }, { x: x - tw / 2, y: y + 10 }]); ctx.fill();
        ctx.fillStyle = f.col === C.good || f.col === C.bad ? "#fff" : C["paper-ink"];
        ctx.fillText(txt, x + 1, y + 1);
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---------- the DOM: overlays, counters, the lower third ----------
  const at = {};
  function placeOverlays() {
    const g = G;
    Object.assign(at, {
      nozzleA: [g.nozA, 30], nozzleB: [g.nozB, 30],
      sys1: [g.tL - 8, (g.pegRows[0] + g.pegRows[2]) / 2],
      sys2: [g.WW - g.m, g.gateTop + 4],
      heard: [g.m, g.floor + 12],
      bin0: [g.xB0 + 2, g.floor + 12], bin1: [g.xB0 + g.bw + 2, g.floor + 12], bin2: [g.xB0 + 2 * g.bw + 2, g.floor + 12],
    });
    ov.querySelectorAll("[data-at]").forEach((el) => {
      const p = at[el.dataset.at]; if (!p) return;
      el.style.left = (p[0] / g.WW * 100) + "%";
      el.style.top = (p[1] / g.HH * 100) + "%";
      if (el.classList.contains("bin") && !el.classList.contains("heard")) el.style.width = ((g.bw - 4) / g.WW * 100) + "%";
    });
  }

  const shown = {};
  function setText(id, v) { if (shown[id] !== v) { shown[id] = v; const el = $(id); if (el) el.textContent = v; } }
  function bump(id) { const el = $(id); if (!el || RM) return; el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick"); }
  const lvA = ov.querySelector(".src.host .lvl b"), lvB = ov.querySelector(".src.remote .lvl b");
  const clockStr = (s) => { s = Math.floor(s); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
  let prev = { heard: -1, flagged: -1 };
  function syncDom() {
    if (S.heard !== prev.heard && prev.heard >= 0 && S.heard % 5 === 0) bump("n-heard");
    if (S.flagged !== prev.flagged && prev.flagged >= 0) bump("n-flagged");
    prev = { heard: S.heard, flagged: S.flagged };
    setText("n-heard", S.heard.toLocaleString("en-US"));
    setText("n-flagged", String(S.flagged));
    setText("n-verdicts", String(S.verdicts));
    setText("n-cost", "$" + (simT * 1.6 / 3600).toFixed(3));
    setText("clock", clockStr(simT));
    setText("bh", S.heard.toLocaleString("en-US"));
    S.bins.forEach((n, i) => setText("b" + i, String(n)));
    setText("s2-state", jobs.length ? `researching ${jobs.length > 1 ? jobs.length + " claims" : "the web"}` : "waiting for a claim");
    if (lvA) lvA.style.width = (level.host * 100).toFixed(0) + "%";
    if (lvB) lvB.style.width = (level.remote * 100).toFixed(0) + "%";
    setText("speed", speed + "×");
    $("pour").classList.toggle("fast", speed > 1);
  }

  function showVerdict(claim, voice) {
    const fc = $("fc"), vd = VERDICTS[claim.v];
    fc.className = "fc v-" + vd.key;
    fc.querySelector(".vw").textContent = vd.label;
    fc.querySelector(".vm").textContent = "System 2";
    const who = $("fc-who");
    who.textContent = voice === "host" ? "Host" : "Guest";
    who.className = "who-tab " + voice;
    $("fc-time").textContent = "at " + clockStr(simT);
    $("fc-claim").textContent = "“" + claim.full + "”";
    $("fc-note").textContent = claim.note;
    if (!warming && !RM) { void fc.offsetWidth; fc.classList.add("enter"); }
  }

  // ---------- sizing ----------
  function size() {
    const vw = document.documentElement.clientWidth;
    const phone = vw <= 640, narrow = vw <= 980;
    const g = layout(phone);
    let mw;
    if (narrow) mw = Math.min(vw - (phone ? 32 : 40), 560);
    else {
      const top = document.querySelector(".top").offsetHeight;
      const avail = innerHeight - top - 26 - 36 - 36;
      mw = Math.max(460, Math.min(660, avail * g.WW / g.HH + 2));
    }
    machine.style.setProperty("--mw", mw + "px");
    const cw = mw - 2, ch = cw * g.HH / g.WW;
    stage.style.height = ch + "px";
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    scale = cw / g.WW;
    if (!G || G.phone !== g.phone) {
      G = g;
      if (engine) { Composite.clear(world, false); Engine.clear(engine); }
      heardList.length = 0; binLists.forEach((l) => (l.length = 0)); jobs.length = 0; drops.length = 0; carriage = null;
      buildWorld();
    }
    makeStripe();
  }

  // ---------- interaction: drag a line, or drag the machine to shake it ----------
  let drag = null, shakeDrag = null;
  const dev = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  let autoShake = 0, prevDevV = { x: 0, y: 0 };

  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }
  function pick(pt) {
    const hits = Query.point(dynamics().filter((b) => !b.plugin.fading), pt);
    if (hits.length) return hits[0];
    // a little grace around small pills
    let best = null, bd = 18;
    for (const b of dynamics()) { if (b.plugin.fading) continue; const d = Math.hypot(b.position.x - pt.x, b.position.y - pt.y); if (d < bd) { bd = d; best = b; } }
    return best;
  }

  canvas.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; if (!t) return;
    if (pick(toWorld(t))) e.preventDefault();          // grabbing a line: don't scroll the page
  }, { passive: false });

  canvas.addEventListener("pointerdown", (e) => {
    const pt = toWorld(e), b = pick(pt);
    if (b) {
      const c = Constraint.create({ pointA: pt, bodyB: b, pointB: { x: pt.x - b.position.x, y: pt.y - b.position.y }, stiffness: 0.12, damping: 0.08, length: 0 });
      Composite.add(world, c);
      b.plugin.held = true;
      if (b.plugin.researching) { b.plugin.researching = false; }
      drag = { b, c };
      canvas.setPointerCapture(e.pointerId);
      stage.classList.add("dragging");
      wake();
    } else if (e.pointerType !== "touch") {
      shakeDrag = { x0: e.clientX, y0: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      stage.classList.add("dragging");
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      const pt = toWorld(e);
      drag.c.pointA = { x: Math.max(-20, Math.min(G.WW + 20, pt.x)), y: Math.max(-200, Math.min(G.HH, pt.y)) };
    } else if (shakeDrag) {
      const lim = 46;
      dev.tx = Math.max(-lim, Math.min(lim, (e.clientX - shakeDrag.x0) * 0.55));
      dev.ty = Math.max(-lim * 0.6, Math.min(lim * 0.6, (e.clientY - shakeDrag.y0) * 0.55));
    } else if (e.pointerType === "mouse") {
      stage.classList.toggle("over-pill", !!pick(toWorld(e)));
    }
  });
  function release() {
    if (drag) { Composite.remove(world, drag.c); drag.b.plugin.held = false; drag = null; }
    if (shakeDrag) { shakeDrag = null; dev.tx = 0; dev.ty = 0; }
    stage.classList.remove("dragging");
  }
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("lostpointercapture", release);

  function shake() {
    if (RM) {  // calm version: a nudge from inside, no moving frame
      for (const b of dynamics()) Body.setVelocity(b, { x: b.velocity.x + (Math.random() - 0.5) * 6, y: b.velocity.y - 3 - Math.random() * 3 });
      return;
    }
    autoShake = 0.75;
    wake();
  }
  function pour() {
    burst += 16;
    speed = Math.min(4, speed + 1);
    speedHold = 5;
    wake();
  }
  $("pour").addEventListener("click", pour);
  $("shake").addEventListener("click", shake);
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === "s" || e.key === "S") { e.preventDefault(); shake(); }
  });
  window.addEventListener("ca:download", () => { burst += 10; shake(); });

  // the frame follows the drag on a spring; the contents lag behind it (inertia)
  function updateDevice(dt) {
    let tx = dev.tx, ty = dev.ty;
    if (autoShake > 0) {
      autoShake -= dt;
      const k = Math.max(0, autoShake / 0.75), ph = (0.75 - autoShake) * Math.PI * 2 * 7;
      tx = Math.sin(ph) * 28 * k; ty = Math.cos(ph * 0.9) * 12 * k;
    }
    dev.vx = (dev.vx + (tx - dev.x) * 0.3) * 0.72;
    dev.vy = (dev.vy + (ty - dev.y) * 0.3) * 0.72;
    dev.x += dev.vx; dev.y += dev.vy;
    if (Math.abs(dev.x) < 0.05 && Math.abs(dev.vx) < 0.05) { dev.x = 0; dev.vx = 0; }
    if (Math.abs(dev.y) < 0.05 && Math.abs(dev.vy) < 0.05) { dev.y = 0; dev.vy = 0; }
    machine.style.transform = dev.x || dev.y ? `translate(${dev.x.toFixed(2)}px, ${dev.y.toFixed(2)}px)` : "";
    // change of the frame's velocity, in world units per step
    const v = { x: dev.vx / scale, y: dev.vy / scale };
    let ax = v.x - prevDevV.x, ay = v.y - prevDevV.y;
    prevDevV = v;
    const mag = Math.hypot(ax, ay), cap = 9;
    if (mag > cap) { ax *= cap / mag; ay *= cap / mag; }
    if (mag > 0.05) for (const b of dynamics()) if (!b.plugin.held) Body.setVelocity(b, { x: b.velocity.x - ax * 1.2, y: b.velocity.y - ay * 1.2 });
  }

  // ---------- the loop ----------
  let running = false, onScreen = true, last = 0, acc = 0, warming = false;
  function frame(now) {
    if (!running) return;
    const realDt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    speedHold -= realDt;
    if (speedHold <= 0 && speed > 1) { speed--; speedHold = 1.6; }
    acc += realDt;
    let n = 0;
    while (acc >= 1 / 60 && n < 3) { for (let s = 0; s < speed; s++) step(1 / 60); acc -= 1 / 60; n++; }
    if (n === 3) acc = 0;
    updateDevice(realDt);
    draw(now / 1000);
    syncDom();
    requestAnimationFrame(frame);
  }
  function wake() { if (!running && onScreen && !document.hidden) { running = true; last = performance.now(); requestAnimationFrame(frame); } }
  function sleep() { running = false; }
  function sync() { if (onScreen && !document.hidden) wake(); else sleep(); }
  document.addEventListener("visibilitychange", sync);
  if ("IntersectionObserver" in window) new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; sync(); }).observe(machine);

  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { size(); placeOverlays(); if (!running) draw(performance.now() / 1000); }, 120); });

  // ---------- start: fonts first (the pills measure their text), then a warm-up so the first frame is already busy ----------
  const fontsReady = document.fonts && document.fonts.load
    ? Promise.race([Promise.all([document.fonts.load(PILL_FONT), document.fonts.load("800 15px 'Barlow Condensed'")]), new Promise((r) => setTimeout(r, 900))])
    : Promise.resolve();
  CA.ready && CA.ready(() => document.querySelectorAll(".ver").forEach((el) => (el.hidden = false)));
  fontsReady.then(() => {
    size();
    warming = true;
    const warm = RM ? 30 : 22;
    for (let i = 0; i < warm * 60; i++) step(1 / 60);
    fx.length = 0;
    warming = false;
    draw(0); syncDom();
    wake();
  });
})();
