// @vitest-environment happy-dom
// Playback of a recording (web/src/player.ts; docs/architecture.md § Web front end, Playback): the audio element, speed and
// volume boost, the playhead and click-to-seek on the timeline, the transcript following, Space, and position reports.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeAudio, FakeAudioContext, installBrowserStubs, layout, loadIndexHtml } from "./helpers.ts";
import { trackDocumentListeners } from "./helpers-panels.ts";

type Player = typeof import("../../web/src/player.ts");
type State = import("../../web/src/state.ts").State;
let P: Player;
let untrack: () => void;

beforeEach(async () => {
  vi.resetModules();
  loadIndexHtml();
  installBrowserStubs();
  localStorage.clear();
  untrack = trackDocumentListeners();
  P = await import("../../web/src/player.ts");
});

afterEach(() => {
  untrack();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function state(session: Partial<NonNullable<State["session"]>> | null): State {
  return { session: session ? { id: "rec 1", mode: "live", status: "archived", ...session } : null } as State;
}

const audio = () => FakeAudio.instances.at(-1)!;
/** The scrollIntoView calls made on `el` (installBrowserStubs puts one spy on the prototype). */
const scrolls = (el: Element) => {
  const spy = vi.mocked(Element.prototype.scrollIntoView);
  return spy.mock.calls.filter((_, i) => spy.mock.contexts[i] === el);
};
const player = () => document.getElementById("player")!;
const playhead = () => document.getElementById("playhead");

/** Transcript rows with data-start, as renderTranscript draws them, plus a live partial without one. */
function rows(starts: number[]) {
  document.getElementById("transcript")!.innerHTML =
    starts.map((s, i) => `<div class="utt" id="utt-${i}" data-start="${s}"></div>`).join("") + `<div class="utt live"></div>`;
  return [...document.querySelectorAll<HTMLElement>("#transcript .utt[data-start]")];
}

describe("syncPlayer", () => {
  test("no session: the player is hidden, no audio, no body.playback, and the timeline has no playhead or seek", () => {
    document.getElementById("tl-scroll")!.classList.add("seekable");
    P.syncPlayer(state(null));
    expect([player().hidden, FakeAudio.instances.length, document.body.classList.contains("playback")]).toEqual([true, 0, false]);
  });

  test("a live or running session hides the player", () => {
    P.syncPlayer(state({ status: "running" }));
    expect([player().hidden, FakeAudio.instances.length]).toEqual([true, 0]);
  });

  test("a recording without audio (imported without it) hides the player", () => {
    P.syncPlayer(state({ hasAudio: false }));
    expect([player().hidden, FakeAudio.instances.length]).toEqual([true, 0]);
  });

  test("a recording shows the player and loads its mixed audio at the chosen speed, keeping the pitch", () => {
    (document.getElementById("play-speed") as HTMLSelectElement).value = "2";
    P.syncPlayer(state({ hasAudio: true }));
    expect([player().hidden, document.body.classList.contains("playback")]).toEqual([false, true]);
    const a = audio();
    expect([a.src, a.preload, a.preservesPitch, a.playbackRate]).toEqual(["/api/sessions/rec%201/audio", "metadata", true, 2]);
  });

  test("then the time reads 0:00, the button offers Play, and the timeline is seekable", () => {
    P.syncPlayer(state({}));
    const btn = document.getElementById("play")!;
    expect(document.getElementById("play-time")!.textContent).toBe("0:00");
    expect(btn.querySelector("use")!.getAttribute("href")).toBe("#g-play");
    expect([btn.getAttribute("aria-label"), btn.title]).toEqual(["Play", "Play the recording (space)"]);
    expect(document.getElementById("tl-scroll")!.classList.contains("seekable")).toBe(true);
  });

  test("the same recording again creates no new audio", () => {
    P.syncPlayer(state({}));
    P.syncPlayer(state({}));
    expect(FakeAudio.instances.length).toBe(1);
  });

  test("another recording: the old audio pauses, the boost context closes, the highlight and the playhead go, and a new audio loads", async () => {
    (document.getElementById("play-boost") as HTMLSelectElement).value = "2";
    P.syncPlayer(state({}));
    const old = audio();
    old.loadMetadata(60);
    rows([0, 5000]);
    P.toggle();
    P.seek(6000);
    expect(document.querySelector(".utt.playing")).not.toBeNull();
    expect(playhead()).not.toBeNull();
    const ctx = FakeAudioContext.instances[0]!;
    P.syncPlayer(state({ id: "rec 2" }));
    expect([old.paused, ctx.close.mock.calls.length, FakeAudio.instances.length]).toEqual([true, 1, 2]);
    expect(document.querySelector(".utt.playing")).toBeNull();
    expect(playhead()).toBeNull();
    expect(audio().src).toBe("/api/sessions/rec%202/audio");
  });

  test("back on air: no audio, the player hidden, body.playback removed, and no seek on the timeline", () => {
    P.syncPlayer(state({}));
    P.syncPlayer(state({ status: "running" }));
    expect([player().hidden, document.body.classList.contains("playback"), document.getElementById("tl-scroll")!.classList.contains("seekable")]).toEqual([true, false, false]);
    P.toggle();
    expect(audio().paused).toBe(true);
  });

  // In a browser media events are asynchronous: the old element's "pause" (from `audio?.pause()` when switching) can
  // arrive after `audio` already points at the new one, and its handler reports the new audio's position, 0, which
  // app.ts turns into setRoute({ t: 0 }) and drops ?t= from a deep link.
  test.fails("BUG PLY-L1: an event from the previous recording's audio reports nothing about the new one", () => {
    const fn = vi.fn();
    P.setPositionListener(fn);
    P.syncPlayer(state({}));
    const old = audio();
    old.loadMetadata(60);
    old.currentTime = 30;
    P.syncPlayer(state({ id: "rec 2" }));
    fn.mockClear();
    old.dispatchEvent(new Event("pause")); // arriving late, as a browser delivers it
    expect(fn).not.toHaveBeenCalled();
  });

  test("without the player's markup nothing breaks", () => {
    document.body.innerHTML = "";
    expect(() => P.syncPlayer(state({}))).not.toThrow();
    expect(() => audio().dispatchEvent(new Event("play"))).not.toThrow();
  });
});

describe("toggle and the volume boost", () => {
  test("does nothing without audio", () => {
    expect(() => P.toggle()).not.toThrow();
  });

  test("paused → plays; playing → pauses; the button follows", async () => {
    P.syncPlayer(state({}));
    P.toggle();
    expect(audio().paused).toBe(false);
    const btn = document.getElementById("play")!;
    expect(btn.querySelector("use")!.getAttribute("href")).toBe("#g-pause");
    expect([btn.getAttribute("aria-label"), btn.title]).toEqual(["Pause", "Pause (space)"]);
    P.toggle();
    expect(audio().paused).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Play");
  });

  test("a refused play() is swallowed", async () => {
    P.syncPlayer(state({}));
    audio().failPlay = new Error("NotAllowedError");
    P.toggle();
    await Promise.resolve();
    expect(audio().paused).toBe(true);
  });

  test("at 100 % no audio context is created", () => {
    P.syncPlayer(state({}));
    P.toggle();
    expect(FakeAudioContext.instances.length).toBe(0);
  });

  test("above 100 %: one context, the audio through a gain node set to the level, resumed; the next toggle reuses it", () => {
    const connect = vi.fn((n: unknown) => n);
    vi.spyOn(FakeAudioContext.prototype, "createMediaElementSource").mockImplementation(() => ({ connect, disconnect: () => {} }));
    const boost = document.getElementById("play-boost") as HTMLSelectElement;
    boost.value = "2";
    P.syncPlayer(state({}));
    P.toggle();
    const ctx = FakeAudioContext.instances[0]!;
    expect(FakeAudioContext.instances.length).toBe(1);
    expect(connect).toHaveBeenCalledOnce();
    const gain = connect.mock.calls[0]![0] as { gain: { value: number } };
    expect(gain.gain.value).toBe(2);
    expect(ctx.resume).toHaveBeenCalledOnce();
    boost.value = "3";
    P.toggle();
    expect([FakeAudioContext.instances.length, gain.gain.value]).toEqual([1, 3]);
  });

  test("an audio context that cannot be created leaves the volume alone, and the audio still plays", () => {
    FakeAudioContext.throwOnNew = new Error("no audio");
    (document.getElementById("play-boost") as HTMLSelectElement).value = "2";
    P.syncPlayer(state({}));
    P.toggle();
    expect([audio().paused, FakeAudioContext.instances.length]).toEqual([false, 0]);
  });
});

describe("seek", () => {
  test("does nothing without audio", () => {
    expect(() => P.seek(1000)).not.toThrow();
    expect(playhead()).toBeNull();
  });

  test("with the length known: moves the audio (never below 0), draws at once, and tells the listener", () => {
    const fn = vi.fn();
    P.setPositionListener(fn);
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    P.seek(7000);
    expect(audio().currentTime).toBe(7);
    expect(document.getElementById("play-time")!.textContent).toBe("0:07");
    expect(playhead()!.style.left).toBe(`${(7000 / 60_000) * 100}%`);
    expect(fn).toHaveBeenLastCalledWith(7000);
    P.seek(-500);
    expect(audio().currentTime).toBe(0);
  });

  test("before the length is known: the playhead moves at once, and the audio follows on loadedmetadata", () => {
    const fn = vi.fn();
    P.setPositionListener(fn);
    P.syncPlayer(state({}));
    P.seek(7000);
    expect(playhead()!.querySelector("span")!.textContent).toBe("0:07");
    expect([audio().currentTime, fn.mock.calls.length]).toEqual([0, 0]);
    audio().loadMetadata(60);
    expect(audio().currentTime).toBe(7);
    expect(fn).toHaveBeenCalledWith(7000);
  });

  test("two seeks before the length is known apply in order, so the last one wins", () => {
    const fn = vi.fn();
    P.setPositionListener(fn);
    P.syncPlayer(state({}));
    P.seek(3000);
    P.seek(9000);
    audio().loadMetadata(60);
    expect(audio().currentTime).toBe(9);
    expect(fn.mock.calls).toEqual([[3000], [9000]]);
  });

  test("the tick after a seek scrolls to the line at once, even when it is already the current one", () => {
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    const r = rows([0, 5000, 10_000]);
    P.seek(7000);
    expect(scrolls(r[1]!)).toEqual([[{ block: "center", behavior: "auto" }]]);
    P.seek(8000);
    expect(scrolls(r[1]!).length).toBe(2);
  });

  test("the timeline's click-to-seek is this seek", () => {
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    const sc = document.getElementById("tl-scroll")!;
    layout(sc, { clientWidth: 1000, rect: { left: 0, width: 1000 } });
    return import("../../web/src/timeline.ts").then((T) => {
      T.bindTimeline(() => {});
      sc.dispatchEvent(new MouseEvent("click", { clientX: 500, bubbles: true }));
      expect(audio().currentTime).toBe(30);
    });
  });
});

describe("while playing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000_000);
  });

  test("each frame moves the playhead and the time, and stops when paused", () => {
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    P.toggle();
    audio().currentTime = 2;
    vi.advanceTimersToNextFrame();
    expect(document.getElementById("play-time")!.textContent).toBe("0:02");
    audio().currentTime = 3;
    vi.advanceTimersToNextFrame();
    expect(document.getElementById("play-time")!.textContent).toBe("0:03");
    audio().currentTime = 9;
    audio().pause();
    vi.advanceTimersToNextFrame(); // the frame already scheduled draws where it stopped, and schedules no other
    expect(document.getElementById("play-time")!.textContent).toBe("0:09");
    audio().currentTime = 12;
    vi.advanceTimersToNextFrame();
    expect(document.getElementById("play-time")!.textContent).toBe("0:09");
  });

  test("the listener hears at most every 5 s while playing, and at once on pause and end, not on play", () => {
    const fn = vi.fn();
    P.setPositionListener(fn);
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    P.toggle(); // play: the first frame reports (none before)
    expect(fn.mock.calls).toEqual([[0]]);
    audio().currentTime = 1;
    vi.advanceTimersByTime(1000);
    vi.advanceTimersToNextFrame();
    expect(fn).toHaveBeenCalledTimes(1);
    audio().currentTime = 5;
    vi.advanceTimersByTime(4100);
    vi.advanceTimersToNextFrame();
    expect(fn).toHaveBeenLastCalledWith(5000);
    audio().currentTime = 5.5;
    audio().pause();
    expect(fn).toHaveBeenLastCalledWith(5500);
    audio().currentTime = 6;
    audio().end();
    expect(fn).toHaveBeenLastCalledWith(6000);
  });

  test("the line being heard is highlighted: the last one started at or before the position", () => {
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    let r = rows([0, 5000, 10_000]);
    audio().currentTime = 7;
    P.refreshFollow();
    expect(r.map((x) => x.classList.contains("playing"))).toEqual([false, true, false]);
    audio().currentTime = 20;
    r = rows([0, 5000, 10_000]);
    P.refreshFollow();
    expect(r.map((x) => x.classList.contains("playing"))).toEqual([false, false, true]);
  });

  test("before the first line starts, no line is highlighted", () => {
    P.syncPlayer(state({}));
    const r = rows([1000, 5000]);
    P.refreshFollow();
    expect(r.some((x) => x.classList.contains("playing"))).toBe(false);
  });

  test("while playing, a new line scrolls smoothly into view, unless the reader scrolled the transcript in the last 4 s", () => {
    P.bindPlayer();
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    const r = rows([0, 5000, 10_000]);
    P.toggle();
    audio().currentTime = 6;
    vi.advanceTimersToNextFrame();
    expect(scrolls(r[1]!)).toEqual([[{ block: "center", behavior: "smooth" }]]);
    document.getElementById("transcript")!.dispatchEvent(new Event("wheel"));
    audio().currentTime = 11;
    vi.advanceTimersToNextFrame();
    expect(r[2]!.classList.contains("playing")).toBe(true);
    expect(scrolls(r[2]!)).toEqual([]);
    vi.advanceTimersByTime(4100);
    document.getElementById("transcript")!.dispatchEvent(new Event("touchmove"));
    vi.advanceTimersByTime(4100);
    const more = rows([0, 5000, 10_000, 12_000]);
    audio().currentTime = 13;
    vi.advanceTimersToNextFrame();
    expect(scrolls(more[3]!).length).toBe(1);
  });

  test("a seeked event draws a frame when none is scheduled", () => {
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    audio().currentTime = 4;
    audio().dispatchEvent(new Event("seeked"));
    expect(document.getElementById("play-time")!.textContent).toBe("0:04");
  });

  test("the playhead is kept in view when zoomed while playing", async () => {
    const T = await import("../../web/src/timeline.ts");
    const sc = document.getElementById("tl-scroll")!;
    layout(sc, { clientWidth: 1000 });
    T.bindTimeline(() => {});
    T.renderTimeline(document.getElementById("timeline")!, { ...(await import("../../web/src/state.ts")).emptyState(), session: { id: "rec 1", mode: "live", status: "archived" } }, { matches: () => true, onJump: () => {}, nowMs: 120_000 });
    document.getElementById("zoom-in")!.click();
    P.syncPlayer(state({}));
    audio().loadMetadata(120);
    P.toggle();
    audio().currentTime = 100;
    sc.scrollLeft = 0;
    vi.advanceTimersToNextFrame();
    expect(sc.scrollLeft).toBeGreaterThan(0);
  });
});

describe("refreshFollow", () => {
  test("without audio it does nothing", () => {
    const r = rows([0]);
    P.refreshFollow();
    expect(r[0]!.classList.contains("playing")).toBe(false);
  });

  test("after the transcript is redrawn, the line is highlighted again", () => {
    P.syncPlayer(state({}));
    audio().loadMetadata(60);
    audio().currentTime = 6;
    rows([0, 5000]);
    P.refreshFollow();
    const again = rows([0, 5000]);
    P.refreshFollow();
    expect(again[1]!.classList.contains("playing")).toBe(true);
  });
});

describe("bindPlayer", () => {
  test("restores the saved speed and boost", () => {
    localStorage.setItem("pa.playSpeed", "2");
    localStorage.setItem("pa.playBoost", "1.5");
    P.bindPlayer();
    expect((document.getElementById("play-speed") as HTMLSelectElement).value).toBe("2");
    expect((document.getElementById("play-boost") as HTMLSelectElement).value).toBe("1.5");
  });

  test("storage that throws is tolerated, on reading and on saving", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => P.bindPlayer()).not.toThrow();
    const speed = document.getElementById("play-speed") as HTMLSelectElement;
    speed.value = "3";
    expect(() => speed.dispatchEvent(new Event("change"))).not.toThrow();
    const boost = document.getElementById("play-boost") as HTMLSelectElement;
    expect(() => boost.dispatchEvent(new Event("change"))).not.toThrow();
  });

  test("a speed change sets the audio's rate and is remembered; with no audio it is only remembered", () => {
    P.bindPlayer();
    const speed = document.getElementById("play-speed") as HTMLSelectElement;
    speed.value = "1.5";
    speed.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("pa.playSpeed")).toBe("1.5");
    P.syncPlayer(state({}));
    speed.value = "4";
    speed.dispatchEvent(new Event("change"));
    expect([audio().playbackRate, localStorage.getItem("pa.playSpeed")]).toEqual([4, "4"]);
  });

  test("a boost change applies it and is remembered", () => {
    P.bindPlayer();
    P.syncPlayer(state({}));
    const boost = document.getElementById("play-boost") as HTMLSelectElement;
    boost.value = "2";
    boost.dispatchEvent(new Event("change"));
    expect([FakeAudioContext.instances.length, localStorage.getItem("pa.playBoost")]).toEqual([1, "2"]);
  });

  test("the play button toggles", () => {
    P.bindPlayer();
    P.syncPlayer(state({}));
    document.getElementById("play")!.click();
    expect(audio().paused).toBe(false);
  });
});

describe("the space key", () => {
  const space = (target: EventTarget = document.body, key = " ") => {
    const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
    target.dispatchEvent(e);
    return e;
  };

  test("space on the page plays and pauses", () => {
    P.bindPlayer();
    P.syncPlayer(state({}));
    expect(space().defaultPrevented).toBe(true);
    expect(audio().paused).toBe(false);
    space();
    expect(audio().paused).toBe(true);
  });

  test("ignored with no audio, with a dialog open, in a field or on a control, and for other keys", () => {
    P.bindPlayer();
    expect(space().defaultPrevented).toBe(false);
    P.syncPlayer(state({}));
    const dlg = document.querySelector<HTMLDialogElement>("dialog")!;
    dlg.showModal();
    expect(space().defaultPrevented).toBe(false);
    dlg.close();
    for (const tag of ["input", "textarea", "select", "button"]) {
      const el = document.createElement(tag);
      document.body.append(el);
      expect(space(el).defaultPrevented).toBe(false);
    }
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "");
    const inner = document.createElement("span");
    editable.append(inner);
    document.body.append(editable);
    expect(space(inner).defaultPrevented).toBe(false);
    expect(space(document.body, "k").defaultPrevented).toBe(false);
    expect(audio().paused).toBe(true);
  });
});
