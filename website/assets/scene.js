// The record key, as a physical object in a dark studio (Three.js).
// createScene() returns the same small API as the CSS fallback in main.js:
//   down()  press and hold          release(live)  let go; latch if live
//   setLive(live)  lights, beams, rings        speaker(who)  colour of the next rings
//   keyRect()  the key's screen box in stage pixels       emitPoint()  a point on the floor rings
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const T = {
  ground: "#0a1628", deck: "#0f2038", deck2: "#152b4a", deck3: "#1b365b", rule: "#213a5e",
  top: "#f0384c", bottom: "#c9142a", host: "#8cb4ff", remote: "#ff93c0", accent: "#2bd4f0", live: "#e8263b",
};

// A rounded rectangle as explicit points, counter-clockwise, with no duplicate at the seam
// (Shape.absarc leaves overlapping points that make ExtrudeGeometry's bevel spike).
function rr(w, h, r, path = new THREE.Shape(), n = 14) {
  const pts = [], cx = w / 2 - r, cy = h / 2 - r;
  for (const [ox, oy, a0] of [[cx, -cy, -Math.PI / 2], [cx, cy, 0], [-cx, cy, Math.PI / 2], [-cx, -cy, Math.PI]]) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push(new THREE.Vector2(ox + Math.cos(a) * r, oy + Math.sin(a) * r));
    }
  }
  path.setFromPoints(pts);
  return path;
}

function gradientTexture(draw, w = 256, h = 256) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function createScene({ canvas, stage, reduced }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(T.ground, 1);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(T.ground, 13, 30);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const LOOK = new THREE.Vector3(0, -0.35, 0);
  const DIR = new THREE.Vector3(0.12, 0.44, 1).normalize(); // a little above and to the right: a product shot

  // ---------- the key ----------
  const unit = new THREE.Group();
  scene.add(unit);
  const BASE_TILT = -0.12, BASE_YAW = -0.2;
  unit.position.set(0, 0.2, 0);
  unit.rotation.x = BASE_TILT;

  const KEY = 2, BEV = 0.12, DEP = 0.34, BTH = 0.14;
  const FACE = DEP + BTH;
  const extruded = new THREE.ExtrudeGeometry(rr(KEY - 2 * BEV, KEY - 2 * BEV, KEY * 0.225 - BEV), {
    depth: DEP, bevelEnabled: true, bevelThickness: BTH, bevelSize: BEV, bevelSegments: 10, curveSegments: 1,
  });
  // The flat faces keep flat normals; the sides and bevel are welded into one smooth, molded surface.
  const part = (g) => {
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(extruded.attributes.position.array.slice(g.start * 3, (g.start + g.count) * 3), 3));
    return out;
  };
  const faces = part(extruded.groups[0]);
  faces.computeVertexNormals();
  const sides = mergeVertices(part(extruded.groups[1]), 1e-4);
  sides.computeVertexNormals();
  const paint = (geo) => {
    const pos = geo.attributes.position, cols = new Float32Array(pos.count * 3);
    const top = new THREE.Color(T.top), bot = new THREE.Color(T.bottom), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp((pos.getY(i) + KEY / 2) / KEY, 0, 1);
      c.copy(bot).lerp(top, t);
      if (pos.getZ(i) < DEP) c.multiplyScalar(0.72); // the key's sides sit in shade
      c.toArray(cols, i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  };
  paint(faces);
  paint(sides);
  const cap = new THREE.Group();
  unit.add(cap);
  const capMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.14, envMapIntensity: 0.45 });
  cap.add(new THREE.Mesh(faces, capMat), new THREE.Mesh(sides, capMat));

  const dotMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.05 });
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.461, 72, 18, 0, Math.PI * 2, 0, Math.PI / 2), dotMat);
  dot.rotation.x = Math.PI / 2;
  dot.scale.set(1, 0.14, 1);
  dot.position.z = FACE - 0.002;
  cap.add(dot);

  const ringGeoFace = new THREE.RingGeometry(0.573, 0.641, 128);
  const faceRingMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false });
  const faceRing = new THREE.Mesh(ringGeoFace, faceRingMat);
  faceRing.position.z = FACE + 0.004;
  cap.add(faceRing);

  // rings that pulse off the key's face while live
  const facePulses = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(ringGeoFace, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    m.position.z = FACE + 0.006;
    m.visible = false;
    cap.add(m);
    facePulses.push({ m, t: 1 });
  }

  // the switch housing and the well the key sits in
  const housingShape = rr(2.62, 2.62, 0.64);
  housingShape.holes.push(rr(2.16, 2.16, 0.5, new THREE.Path()));
  const housing = new THREE.Mesh(
    new THREE.ExtrudeGeometry(housingShape, { depth: 0.42, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 4, curveSegments: 1 }),
    new THREE.MeshPhysicalMaterial({ color: T.deck2, roughness: 0.5, metalness: 0.2, clearcoat: 0.3, clearcoatRoughness: 0.35, envMapIntensity: 0.4 }),
  );
  housing.position.z = -0.36;
  unit.add(housing);
  const wellMat = new THREE.MeshStandardMaterial({ color: T.ground, roughness: 0.8, emissive: T.live, emissiveIntensity: 0 });
  const well = new THREE.Mesh(new THREE.ShapeGeometry(rr(2.2, 2.2, 0.5), 1), wellMat);
  well.position.z = -0.3;
  unit.add(well);

  // ---------- the studio ----------
  const FLOOR_Y = -2.15;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: T.deck, roughness: 0.9, metalness: 0, envMapIntensity: 0.15 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  scene.add(floor);
  const grid = new THREE.GridHelper(60, 60, T.rule, T.rule);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.position.y = FLOOR_Y + 0.002;
  scene.add(grid);

  const shadowTex = gradientTexture((g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, "rgba(0,0,0,0.75)"); r.addColorStop(0.5, "rgba(0,0,0,0.35)"); r.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, FLOOR_Y + 0.004, 0.2);
  shadow.scale.set(4.6, 3.2, 1);
  scene.add(shadow);

  const poolTex = gradientTexture((g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.4, "rgba(255,255,255,0.35)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
  const glowMat = new THREE.MeshBasicMaterial({ map: poolTex, color: T.live, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, FLOOR_Y + 0.006, 0.3);
  glow.scale.set(9, 7, 1);
  scene.add(glow);
  const idlePoolMat = new THREE.MeshBasicMaterial({ map: poolTex, color: T.accent, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const idlePool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), idlePoolMat);
  idlePool.rotation.x = -Math.PI / 2;
  idlePool.position.set(0, FLOOR_Y + 0.005, 0.2);
  idlePool.scale.set(11, 8, 1);
  scene.add(idlePool);

  // lights: a product-shot key and rim, then the studio spots that sweep on when live
  scene.add(new THREE.HemisphereLight(T.host, T.ground, 0.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
  keyLight.position.set(-5, 8, 3);
  scene.add(keyLight);
  const rim = new THREE.DirectionalLight(T.accent, 1.6);
  rim.position.set(6, 3, -5);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(T.remote, 0.5);
  fill.position.set(5, -1, 4);
  scene.add(fill);

  const beamTex = gradientTexture((g, w, h) => {
    const l = g.createLinearGradient(0, 0, 0, h);
    l.addColorStop(0, "#fff"); l.addColorStop(0.6, "#555"); l.addColorStop(1, "#000");
    g.fillStyle = l; g.fillRect(0, 0, w, h);
  }, 4, 128);
  const spots = [-1, 1].map((side) => {
    const light = new THREE.SpotLight(0xffffff, 0, 0, 0.36, 0.7, 0);
    light.position.set(side * 6.5, 7.5, 3.5);
    scene.add(light);
    scene.add(light.target);
    const H = 12;
    const geo = new THREE.ConeGeometry(2.1, H, 48, 1, true);
    geo.translate(0, -H / 2, 0);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: beamTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    const beam = new THREE.Mesh(geo, mat);
    beam.position.copy(light.position);
    scene.add(beam);
    return { side, light, beam, mat };
  });
  const redLight = new THREE.PointLight(T.live, 0, 7, 0);
  redLight.position.set(0, -1.4, 1.6);
  scene.add(redLight);

  // sound rings on the floor, in host blue and remote pink
  const RING_Y = FLOOR_Y + 0.01, RING_Z = 0.25;
  const ringGeo = new THREE.RingGeometry(0.975, 1, 160);
  ringGeo.rotateX(-Math.PI / 2);
  const rings = [];
  for (let i = 0; i < 14; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: T.host, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
    const m = new THREE.Mesh(ringGeo, mat);
    m.position.set(0, RING_Y, RING_Z);
    m.visible = false;
    scene.add(m);
    rings.push({ m, mat, t: 1, strength: 1 });
  }
  const COLORS = { host: new THREE.Color(T.host), remote: new THREE.Color(T.remote), accent: new THREE.Color(T.accent) };

  // ---------- state ----------
  let live = false, liveT = 0, held = false;
  let pz = 0, vz = 0;                       // the key's travel, on a spring
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  let who = "host", ringClock = 0, pulseClock = 0, idleRingClock = 0;
  let visible = true, raf = 0, last = 0, lastInput = performance.now();
  let t0 = performance.now();
  let viewShift = { x: 0, y: 0 };

  function spawnRing(color, strength = 1) {
    const r = rings.find((x) => x.t >= 1) || rings.reduce((a, b) => (a.t > b.t ? a : b));
    r.t = 0; r.strength = strength; r.mat.color.copy(color); r.m.visible = true;
  }
  function spawnPulse() {
    const p = facePulses.find((x) => x.t >= 1);
    if (p) { p.t = 0; p.m.visible = true; }
  }

  // Reduced motion: three still rings stand in for the ripple.
  function staticRings(on) {
    rings.forEach((r, i) => {
      if (i < 3 && on) {
        r.t = 0.5; r.m.visible = true;
        r.mat.color.copy(i === 1 ? COLORS.remote : COLORS.host);
        r.mat.opacity = [0.7, 0.5, 0.3][i];
        const s = [2.4, 3.8, 5.4][i];
        r.m.scale.set(s, 1, s);
      } else { r.t = 1; r.m.visible = false; }
    });
  }

  function layout() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const wide = w >= 900;
    // visible height, so the housing (2.62 units) fills about half the height, or 64% of a narrow width
    const V = wide ? Math.max(5.6, 2.62 / 0.5) * (h < 760 ? 1.08 : 1) : Math.max(4.9, 2.62 / 0.64 / camera.aspect);
    const dist = V / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.copy(LOOK).addScaledVector(DIR, dist);
    camera.lookAt(LOOK);
    if (wide) { viewShift = { x: -0.2 * w, y: -0.02 * h }; camera.setViewOffset(w, h, viewShift.x, viewShift.y, w, h); }
    else { viewShift = { x: 0, y: 0.07 * h }; camera.setViewOffset(w, h, 0, viewShift.y, w, h); } // up a little, to leave room for the lower third
    camera.updateProjectionMatrix();
    render();
  }

  const v = new THREE.Vector3();
  function toScreen(p) {
    v.copy(p).project(camera);
    return { x: (v.x + 1) / 2 * stage.clientWidth, y: (1 - v.y) / 2 * stage.clientHeight };
  }

  function keyRect() {
    // the housing's corners, at rest, projected to the stage
    const saved = [unit.rotation.x, unit.rotation.y, unit.position.y];
    unit.rotation.set(BASE_TILT, BASE_YAW, 0); unit.position.y = 0.2; unit.updateMatrixWorld(true);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sx of [-1.31, 1.31]) for (const sy of [-1.31, 1.31]) for (const sz of [-0.36, FACE]) {
      const p = toScreen(new THREE.Vector3(sx, sy, sz).applyMatrix4(unit.matrixWorld));
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    unit.rotation.x = saved[0]; unit.rotation.y = saved[1]; unit.position.y = saved[2]; unit.updateMatrixWorld(true);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function emitPoint() {
    // a point on a ring to one side of the key, in front of it
    // the host's voice rises on the left of the key, the guest's on the right
    const side = who === "remote" ? 1 : -1;
    const a = side * (0.9 + Math.random() * 0.5);
    const r = 1.7 + Math.random() * 0.5;
    const p = toScreen(new THREE.Vector3(Math.sin(a) * r * 1.3, RING_Y, RING_Z + Math.cos(a) * r * 0.5));
    p.y = Math.min(p.y, stage.clientHeight - 110);
    return p;
  }

  // ---------- the loop ----------
  function update(dt, now) {
    const t = (now - t0) / 1000;
    // tilt toward the pointer, and breathe
    if (!reduced) {
      const k = 1 - Math.exp(-dt * 5);
      tilt.x += (tilt.tx - tilt.x) * k;
      tilt.y += (tilt.ty - tilt.y) * k;
    }
    const breath = reduced ? 0 : Math.sin(t * 1.3);
    unit.rotation.y = BASE_YAW + tilt.x * 0.38 + (reduced ? 0 : Math.sin(t * 0.45) * 0.03);
    unit.rotation.x = BASE_TILT + tilt.y * 0.24 + breath * 0.012;
    unit.position.y = 0.2 + breath * 0.045 + pz * 0.25;

    // the key's travel: pressed, latched while live, or at rest
    const target = held ? -0.27 : live ? -0.11 : 0;
    if (reduced) { pz = target; vz = 0; }
    else {
      const steps = 4, h = Math.min(dt, 0.05) / steps;
      for (let i = 0; i < steps; i++) { const a = -900 * (pz - target) - 21 * vz; vz += a * h; pz += vz * h; }
    }
    cap.position.z = pz;
    shadow.scale.set(4.6 - breath * 0.12, 3.2 - breath * 0.08, 1);

    // going live: lights sweep on, the well glows red
    const goal = live ? 1 : 0;
    liveT = reduced ? goal : THREE.MathUtils.clamp(liveT + (goal - liveT) * (1 - Math.exp(-dt * (live ? 2.4 : 3.5))), 0, 1);
    if (Math.abs(goal - liveT) < 0.002) liveT = goal;
    const L = liveT;
    const sweep = 1 - Math.pow(1 - L, 3);
    for (const s of spots) {
      s.light.intensity = 7 * L;
      s.light.target.position.set(s.side * (9 - 8.3 * sweep) + (reduced ? 0 : Math.sin(t * 0.7 + s.side) * 0.35 * L), FLOOR_Y, 0.4 - 3 * (1 - sweep));
      s.light.target.updateMatrixWorld();
      s.beam.lookAt(s.light.target.position);
      s.mat.opacity = 0.085 * L;
    }
    wellMat.emissiveIntensity = 1.4 * L;
    dotMat.emissiveIntensity = 0.05 + 0.35 * L;
    redLight.intensity = 3.2 * L;
    glowMat.opacity = 0.2 * L;
    idlePoolMat.opacity = 0.1 * (1 - L);
    keyLight.intensity = 1.5 + 0.5 * L;

    // the rings
    if (!reduced) {
      if (live) {
        ringClock -= dt;
        if (ringClock <= 0) { spawnRing(COLORS[who], 0.95); ringClock = 0.55 + Math.random() * 0.5; }
        pulseClock -= dt;
        if (pulseClock <= 0) { spawnPulse(); pulseClock = 1.1; }
      } else if (L === 0) {
        idleRingClock -= dt;
        if (idleRingClock <= 0) { spawnRing(COLORS.accent, 0.35); idleRingClock = 2.8; }
      }
      for (const r of rings) {
        if (r.t >= 1) continue;
        r.t = Math.min(1, r.t + dt / 3.6);
        const e = 1 - Math.pow(1 - r.t, 2.2);
        const s = 1.6 + e * 10.5;
        r.m.scale.set(s, 1, s);
        r.mat.opacity = Math.pow(1 - r.t, 1.4) * r.strength;
        if (r.t >= 1) r.m.visible = false;
      }
      for (const p of facePulses) {
        if (p.t >= 1) continue;
        p.t = Math.min(1, p.t + dt / 1.3);
        const s = 1 + (1 - Math.pow(1 - p.t, 2)) * 1.25;
        p.m.scale.set(s, s, 1);
        p.m.material.opacity = 0.5 * (1 - p.t);
        if (p.t >= 1) p.m.visible = false;
      }
    }
  }

  function busy(now) {
    if (!visible) return false;
    if (reduced) return false;
    if (live || (liveT > 0 && liveT < 1)) return true;
    if (Math.abs(vz) > 1e-3 || held) return true;
    if (Math.abs(tilt.tx - tilt.x) > 1e-3 || Math.abs(tilt.ty - tilt.y) > 1e-3) return true;
    if (rings.some((r) => r.t < 1)) return true;
    return now - lastInput < 9000; // breathe while someone is around; then rest
  }

  function render() { renderer.render(scene, camera); }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000 || 0.016);
    last = now;
    update(dt, now);
    render();
    if (busy(now)) raf = requestAnimationFrame(frame);
  }

  function wake() {
    lastInput = performance.now();
    if (reduced) { update(0, performance.now()); render(); return; }
    if (!raf && visible) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  // ---------- inputs ----------
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const r = stage.getBoundingClientRect(), k = keyRect();
    const cx = r.left + k.x + k.w / 2, cy = r.top + k.y + k.h / 2;
    tilt.tx = THREE.MathUtils.clamp((e.clientX - cx) / (window.innerWidth * 0.45), -1, 1);
    tilt.ty = THREE.MathUtils.clamp((e.clientY - cy) / (window.innerHeight * 0.55), -1, 1);
    wake();
  }, { passive: true });
  window.addEventListener("deviceorientation", (e) => {
    if (e.gamma == null) return;
    tilt.tx = THREE.MathUtils.clamp(e.gamma / 30, -1, 1);
    tilt.ty = THREE.MathUtils.clamp(((e.beta ?? 45) - 45) / 30, -1, 1);
    wake();
  });

  new IntersectionObserver(([en]) => { visible = en.isIntersecting && !document.hidden; if (visible) wake(); }).observe(stage);
  document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (visible) wake(); });
  new ResizeObserver(() => layout()).observe(stage);
  layout();
  wake();

  return {
    down() { held = true; if (!reduced) vz -= 1.5; wake(); },
    release() { held = false; if (!reduced) vz += 0.4; wake(); },
    tap() { held = false; if (!reduced) vz -= 5; wake(); },
    setLive(on) {
      live = on;
      if (on) { ringClock = 0; pulseClock = 0.15; }
      if (reduced) staticRings(on);
      wake();
    },
    speaker(w) { who = w; if (live && !reduced) { spawnRing(COLORS[w], 1.2); } wake(); },
    keyRect, emitPoint,
    wake,
  };
}
