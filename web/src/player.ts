// Playback of a recording: the mixed audio of both streams (GET /api/sessions/:id/audio) in an <audio> element, which
// keeps voices natural when sped up (preservesPitch). The timeline is the progress bar: the playhead moves with the
// audio, and a click on the timeline or on a transcript timestamp seeks there. The transcript follows, highlighting the
// line being heard. Only for recordings: nothing here runs while a session is on air.
import { $, clock, glyph, replace } from "./dom.js";
import { setPlayhead, setSeekHandler } from "./timeline.js";
import type { State } from "./state.js";

let audio: HTMLAudioElement | null = null;
let sessionId: string | null = null;
let frame = 0;
let current: HTMLElement | null = null;
let userScrolledAt = 0;
/** Set by a seek: the next tick scrolls the transcript and the timeline to the new place, playing or not. */
let jumped = false;
let boost: GainNode | null = null;
const SPEED_KEY = "pa.playSpeed";

const isRecording = (st: State) => st.session?.status === "archived";

/** Session ms of the playback position. */
const positionMs = () => (audio ? audio.currentTime * 1000 : 0);

function showButton() {
  const playing = !!audio && !audio.paused;
  const btn = $<HTMLButtonElement>("#play");
  if (!btn) return;
  replace(btn, glyph(playing ? "pause" : "play"));
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  btn.title = playing ? "Pause (space)" : "Play the recording (space)";
}

/**
 * The transcript line being heard: highlighted, and kept in view while playing unless the reader scrolled away.
 * `force` (after a seek) scrolls to it whatever the reader did, even when it is already the current line.
 */
function follow(ms: number, scroll: boolean, force = false) {
  const rows = document.querySelectorAll<HTMLElement>("#transcript .utt[data-start]");
  let lo = 0, hi = rows.length - 1, found = -1;
  while (lo <= hi) { // the last line that started at or before ms
    const mid = (lo + hi) >> 1;
    if (Number(rows[mid]!.dataset.start) <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const row = found >= 0 ? rows[found]! : null;
  if (row === current && !force) return;
  current?.classList.remove("playing");
  current = row;
  if (!row) return;
  row.classList.add("playing");
  if (force || (scroll && Date.now() - userScrolledAt > 4000)) row.scrollIntoView({ block: "center", behavior: force ? "auto" : "smooth" });
}

function tick() {
  frame = 0;
  if (!audio) return;
  const ms = positionMs();
  const force = jumped;
  jumped = false;
  setPlayhead(ms, !audio.paused || force);
  replace($("#play-time"), clock(ms));
  follow(ms, !audio.paused, force);
  if (!audio.paused) { report(ms); frame = requestAnimationFrame(tick); }
}

let onPosition: ((ms: number) => void) | null = null;
let reportedAt = 0;
/** Told where playback is after a seek, on pause, and every 5 s while playing (the URL keeps `?t=`). */
export function setPositionListener(fn: (ms: number) => void) { onPosition = fn; }
function report(ms: number, always = false) {
  if (!onPosition || (!always && Date.now() - reportedAt < 5000)) return;
  reportedAt = Date.now();
  onPosition(ms);
}

/** Moves playback to a session time; keeps playing if it was. Waits for the audio's length before a first seek. */
export function seek(ms: number) {
  const a = audio;
  if (!a) return;
  const apply = () => {
    a.currentTime = Math.max(0, ms / 1000);
    jumped = true;
    userScrolledAt = 0;
    if (!frame) tick();
    report(ms, true);
  };
  if (a.readyState >= 1) apply();
  else {
    // show the place at once; the audio catches up when it knows its length
    setPlayhead(ms, true);
    a.addEventListener("loadedmetadata", apply, { once: true });
  }
}

/**
 * Volume beyond the <audio> element's 100 %: its output runs through a Web Audio gain node, created on the first play
 * (browsers only start audio contexts from a click).
 */
function applyBoost() {
  if (!audio) return;
  const level = Number($<HTMLSelectElement>("#play-boost")?.value ?? 1);
  if (!boost && level !== 1) {
    try {
      const ctx = new AudioContext();
      boost = ctx.createGain();
      ctx.createMediaElementSource(audio).connect(boost).connect(ctx.destination);
    } catch { return; }
  }
  if (boost) {
    boost.gain.value = level;
    void (boost.context as AudioContext).resume?.();
  }
}

export function toggle() {
  if (!audio) return;
  applyBoost();
  if (audio.paused) void audio.play().catch(() => {});
  else audio.pause();
}

/** Shows the player for a recording, and loads its audio when the recording on screen changes. */
export function syncPlayer(st: State) {
  const box = $("#player");
  const show = isRecording(st);
  if (box) box.hidden = !show;
  const id = show ? st.session!.id : null;
  if (id === sessionId) return;
  // another recording, or back on air: stop and forget the old one
  audio?.pause();
  audio = null;
  if (boost) { void (boost.context as AudioContext).close?.(); boost = null; }
  current?.classList.remove("playing");
  current = null;
  sessionId = id;
  setPlayhead(null);
  setSeekHandler(null);
  document.body.classList.toggle("playback", show);
  if (!id) return;
  audio = new Audio(`/api/sessions/${encodeURIComponent(id)}/audio`);
  audio.preload = "metadata";
  audio.preservesPitch = true;
  audio.playbackRate = Number($<HTMLSelectElement>("#play-speed")?.value ?? 1);
  for (const ev of ["play", "pause", "ended"]) audio.addEventListener(ev, () => { showButton(); if (!frame) tick(); if (ev !== "play") report(positionMs(), true); });
  audio.addEventListener("seeked", () => { if (!frame) tick(); });
  setSeekHandler(seek);
  replace($("#play-time"), "0:00");
  showButton();
}

export function bindPlayer() {
  $("#play")?.addEventListener("click", toggle);
  const speed = $<HTMLSelectElement>("#play-speed");
  try { const saved = localStorage.getItem(SPEED_KEY); if (speed && saved) speed.value = saved; } catch { /* storage may be unavailable */ }
  const level = $<HTMLSelectElement>("#play-boost");
  try { const saved = localStorage.getItem("pa.playBoost"); if (level && saved) level.value = saved; } catch { /* storage may be unavailable */ }
  level?.addEventListener("change", () => {
    applyBoost();
    try { localStorage.setItem("pa.playBoost", level.value); } catch { /* storage may be unavailable */ }
  });
  speed?.addEventListener("change", () => {
    if (audio) audio.playbackRate = Number(speed.value);
    try { localStorage.setItem(SPEED_KEY, speed.value); } catch { /* storage may be unavailable */ }
  });
  // space plays and pauses, unless typing or on a control
  document.addEventListener("keydown", (e) => {
    if (e.key !== " " || !audio || document.querySelector("dialog[open]")) return;
    if ((e.target as Element).closest("input, textarea, select, button, [contenteditable]")) return;
    e.preventDefault();
    toggle();
  });
  // a reader scrolling the transcript pauses the follow for a few seconds
  for (const ev of ["wheel", "touchmove"]) $("#transcript")?.addEventListener(ev, () => { userScrolledAt = Date.now(); }, { passive: true });
}

/** After the transcript re-renders, re-apply the highlight. */
export function refreshFollow() {
  current = null;
  if (audio) follow(positionMs(), false);
}
