// @vitest-environment happy-dom
// The page's header and shell in web/src/panels.ts: toasts, the in-page ask dialog, the microphone list, the About
// footer, the controls and pops, the Start live window, the session name, the ON AIR block, the clock, the settings
// menu, Insights' tabs, the stream meters, the cost chip, the split divider, and the stale-engine banner.
// docs/architecture.md § Web front end.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { feed, flush, installBrowserStubs, layout, loadIndexHtml, makeFakeApi } from "./helpers.ts";
import { setEntry, setupWith, snapshot, trackDocumentListeners, transcriptionWith } from "./helpers-panels.ts";

const fake = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<object>()), api: fake }));
vi.mock("../../web/src/transfer.ts", () => ({ openExport: vi.fn(), openImport: vi.fn() }));

type Panels = typeof import("../../web/src/panels.ts");
let P: Panels;
let K: typeof import("../../web/src/keys.ts");
let S: typeof import("../../web/src/state.ts");
let A: typeof import("../../web/src/api.ts");
let open: ReturnType<typeof vi.fn>;
let untrack: () => void;

async function load() {
  P = await import("../../web/src/panels.ts");
  K = await import("../../web/src/keys.ts");
  S = await import("../../web/src/state.ts");
  A = await import("../../web/src/api.ts");
}

beforeEach(async () => {
  vi.resetModules();
  loadIndexHtml();
  ({ open } = installBrowserStubs());
  localStorage.clear();
  history.replaceState(null, "", "/");
  Object.assign(fake, makeFakeApi((await vi.importActual<typeof import("../../web/src/api.ts")>("../../web/src/api.ts")).api));
  untrack = trackDocumentListeners();
  await load();
});

afterEach(() => {
  untrack();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { desktop?: unknown }).desktop;
});

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const text = (sel: string) => $(sel).textContent;
const toasts = () => [...document.querySelectorAll("#toasts .toast")].map((t) => `${t.className}|${t.textContent}`);
const live = (session: Record<string, unknown> = {}) => feed(S, [], snapshot(session));

describe("toast", () => {
  test("without #toasts it does nothing", () => {
    document.body.innerHTML = "";
    expect(() => P.toast("x")).not.toThrow();
  });

  test("an error toast is role=alert, an ok toast role=status, and the popover opens", () => {
    P.toast("broke");
    P.toast("fine", "ok");
    expect(toasts()).toEqual(["toast error|broke", "toast ok|fine"]);
    expect([...document.querySelectorAll("#toasts .toast")].map((t) => t.getAttribute("role"))).toEqual(["alert", "status"]);
    expect($("#toasts").matches(":popover-open")).toBe(true);
  });

  test("an open popover is hidden then shown again, so it stacks above a modal opened since", () => {
    const box = $("#toasts") as HTMLElement & { hidePopover(): void; showPopover(): void };
    P.toast("one");
    const hide = vi.spyOn(box, "hidePopover");
    const show = vi.spyOn(box, "showPopover");
    P.toast("two");
    expect([hide.mock.calls.length, show.mock.calls.length]).toEqual([1, 1]);
  });

  test("after 6 s a toast goes; the popover closes with the last one", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    P.toast("one");
    vi.advanceTimersByTime(3000);
    P.toast("two");
    vi.advanceTimersByTime(3000);
    expect(toasts()).toEqual(["toast error|two"]);
    expect($("#toasts").matches(":popover-open")).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(toasts()).toEqual([]);
    expect($("#toasts").matches(":popover-open")).toBe(false);
  });
});

describe("ask", () => {
  test("fills the dialog: title, message, input, OK label and style", () => {
    void P.ask("Rename?", { message: "Pick one", input: true, value: "Ann", placeholder: "Name", ok: "Save", danger: true });
    expect([text("#h-ask"), text("#ask-message"), text("#ask-ok")]).toEqual(["Rename?", "Pick one", "Save"]);
    const input = $<HTMLInputElement>("#ask-input");
    expect([input.hidden, input.value, input.placeholder, $("#ask-ok").className]).toEqual([false, "Ann", "Name", "btn danger"]);
    expect($<HTMLDialogElement>("#dlg-ask").open).toBe(true);
    $<HTMLDialogElement>("#dlg-ask").close();
  });

  test("defaults: no message, no input, OK, primary, focused", () => {
    void P.ask("Sure?");
    expect([text("#ask-message"), $<HTMLInputElement>("#ask-input").hidden, text("#ask-ok"), $("#ask-ok").className]).toEqual(["", true, "OK", "btn primary"]);
    expect(document.activeElement).toBe($("#ask-ok"));
    $<HTMLDialogElement>("#dlg-ask").close();
  });

  test("resolves the typed text on OK, '' on OK without input, and null when cancelled", async () => {
    const dlg = $<HTMLDialogElement>("#dlg-ask");
    const typed = P.ask("Name?", { input: true, value: "x" });
    $<HTMLInputElement>("#ask-input").value = "Bob";
    dlg.close("ok");
    await expect(typed).resolves.toBe("Bob");
    const confirm = P.ask("Sure?");
    dlg.close("ok");
    await expect(confirm).resolves.toBe("");
    const cancelled = P.ask("Sure?");
    dlg.close("cancel");
    await expect(cancelled).resolves.toBeNull();
    const dismissed = P.ask("Sure?");
    dlg.close();
    await expect(dismissed).resolves.toBeNull();
  });
});

describe("loadDevices", () => {
  const devices = [
    { uid: "bi", name: "MacBook Pro Microphone", transport: "builtin", isDefault: true },
    { uid: "air", name: "AirPods", transport: "bluetooth", isDefault: false },
  ];

  test("without #mic it does nothing", async () => {
    $("#mic").remove();
    await P.loadDevices();
    expect(fake.devices).not.toHaveBeenCalled();
  });

  test("lists the built-in microphone, then every other device with its transport", async () => {
    $("#mic").title = "old";
    fake.devices!.mockResolvedValue(devices);
    await P.loadDevices();
    const sel = $<HTMLSelectElement>("#mic");
    expect([...sel.options].map((o) => `${o.value}=${o.textContent}`)).toEqual(["builtin=Built-in microphone", "air=AirPods (bluetooth)"]);
    expect(sel.title).toBe("");
  });

  test("picks the microphone used last time when it is still there, else keeps the current one", async () => {
    fake.devices!.mockResolvedValue(devices);
    localStorage.setItem("pa.mic", "air");
    await P.loadDevices();
    expect($<HTMLSelectElement>("#mic").value).toBe("air");
    localStorage.setItem("pa.mic", "gone");
    await P.loadDevices();
    expect($<HTMLSelectElement>("#mic").value).not.toBe("gone");
  });

  test("storage that throws is tolerated", async () => {
    fake.devices!.mockResolvedValue(devices);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    await P.loadDevices();
    expect($<HTMLSelectElement>("#mic").options.length).toBe(2);
  });

  test("a helper that fails leaves one empty option saying so, with the error as its title", async () => {
    fake.devices!.mockRejectedValue(new Error("no helper"));
    await P.loadDevices();
    const sel = $<HTMLSelectElement>("#mic");
    expect([...sel.options].map((o) => `${o.value}=${o.textContent}`)).toEqual(["=Capture helper unavailable"]);
    expect(sel.title).toBe("no helper");
    fake.devices!.mockRejectedValue("plain");
    await P.loadDevices();
    expect(sel.title).toBe("plain");
  });
});

describe("the menu footer (bindAbout)", () => {
  test("shows the version, with the name in its title", async () => {
    fake.about!.mockResolvedValue({ name: "Tattle", version: "1.0.1" });
    P.bindControls(vi.fn(), vi.fn());
    await flush();
    expect([text("#app-version"), $("#app-version").title]).toEqual(["v1.0.1", "Tattle 1.0.1"]);
  });

  test("an older server without /api/about leaves it empty", async () => {
    fake.about!.mockRejectedValue(new Error("404"));
    P.bindControls(vi.fn(), vi.fn());
    await flush();
    expect(text("#app-version")).toBe("");
  });

  test("in a browser, Licenses opens /licenses in a new tab and closes the menu", () => {
    P.bindControls(vi.fn(), vi.fn());
    $("#cog-btn").click();
    $("#license-link").click();
    expect(open).toHaveBeenCalledWith("/licenses", "_blank", "noopener");
    expect($("#cog-menu").hidden).toBe(true);
  });

  test("in the Mac app, Licenses asks the app for its window", async () => {
    const run = vi.fn();
    (globalThis as { desktop?: unknown }).desktop = { run, onCommand: vi.fn() };
    vi.resetModules();
    await load();
    P.bindControls(vi.fn(), vi.fn());
    $("#license-link").click();
    expect(run).toHaveBeenCalledWith("open-licenses");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("bindControls", () => {
  test("Pause pauses, and Resume resumes, each with a toast", async () => {
    P.bindControls(vi.fn(), vi.fn());
    const pause = $<HTMLButtonElement>("#pause");
    pause.dataset.paused = "0";
    pause.click();
    await flush();
    pause.dataset.paused = "1";
    pause.click();
    await flush();
    expect([fake.pause!.mock.calls.length, fake.resume!.mock.calls.length]).toEqual([1, 1]);
    expect(toasts()).toEqual(["toast ok|Paused: nothing is heard or transcribed until you resume", "toast ok|Resumed"]);
  });

  test("Stop stops with a toast; a failure shows its message (or the thrown value) instead", async () => {
    P.bindControls(vi.fn(), vi.fn());
    const stop = $<HTMLButtonElement>("#stop");
    stop.disabled = false;
    stop.click();
    await flush();
    fake.stop!.mockRejectedValueOnce(new Error("409 nothing to stop"));
    stop.click();
    await flush();
    fake.stop!.mockRejectedValueOnce("plain");
    stop.click();
    await flush();
    expect(toasts()).toEqual(["toast ok|Stopping: in-flight work will finish", "toast error|409 nothing to stop", "toast error|plain"]);
  });

  test("Replay without the OpenRouter key replays the folder transcript-only, at the chosen speed and voices", async () => {
    P.bindControls(vi.fn(), vi.fn());
    $<HTMLInputElement>("#replay-dir").value = "  fixtures/x  ";
    $<HTMLSelectElement>("#voices").value = "2";
    $("#replay-btn").click();
    $("#start-replay").click();
    await flush();
    expect(fake.startReplay).toHaveBeenCalledWith("fixtures/x", 1, 2, { factcheck: false, labels: false }, { labelSet: null });
    expect($("#replay-pop").hidden).toBe(true);
    const max = $<HTMLButtonElement>('#replay-speed [data-speed="max"]');
    max.click();
    expect([...document.querySelectorAll("#replay-speed button")].map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    $("#start-replay").click();
    await flush();
    expect(fake.startReplay!.mock.calls[1]![1]).toBe("max");
    $<HTMLButtonElement>('#replay-speed [data-speed="1"]').click();
    $("#start-replay").click();
    await flush();
    expect(fake.startReplay!.mock.calls[2]![1]).toBe(1);
  });

  describe("replayChoices", () => {
    test("without the key: transcript only", async () => {
      await expect(P.replayChoices()).resolves.toEqual({ features: { factcheck: false, labels: false }, labelling: { labelSet: null } });
    });

    test("with the key: everything on, with the set picked last time", async () => {
      fake.setup!.mockResolvedValue(setupWith(true));
      await K.setupStatus();
      fake.labelSets!.mockResolvedValue({ sets: [setEntry("ai-podcast", { builtIn: true }), setEntry("mine")] });
      localStorage.setItem("pa.labelSet", "mine");
      await expect(P.replayChoices()).resolves.toEqual({ features: { factcheck: true, labels: true }, labelling: { labelSet: "mine" } });
    });

    test("a remembered set that is gone or broken falls back to the built-in one, else to ai-podcast", async () => {
      fake.setup!.mockResolvedValue(setupWith(true));
      await K.setupStatus();
      localStorage.setItem("pa.labelSet", "mine");
      fake.labelSets!.mockResolvedValue({ sets: [setEntry("builtin", { builtIn: true }), setEntry("mine", { broken: "bad json" })] });
      expect((await P.replayChoices()).labelling).toEqual({ labelSet: "builtin" });
      fake.labelSets!.mockResolvedValue({ sets: [setEntry("other")] });
      expect((await P.replayChoices()).labelling).toEqual({ labelSet: "ai-podcast" });
      localStorage.removeItem("pa.labelSet");
      fake.labelSets!.mockResolvedValue({ sets: [setEntry("ai-podcast")] });
      expect((await P.replayChoices()).labelling).toEqual({ labelSet: "ai-podcast" });
    });

    test("no sets (or the library failing) sends no label set, and the engine picks", async () => {
      fake.setup!.mockResolvedValue(setupWith(true));
      await K.setupStatus();
      fake.labelSets!.mockRejectedValue(new Error("down"));
      expect((await P.replayChoices()).labelling).toEqual({});
      fake.labelSets!.mockResolvedValue({ sets: [] });
      expect((await P.replayChoices()).labelling).toEqual({});
    });

    test("storage that throws reads as nothing remembered", async () => {
      fake.setup!.mockResolvedValue(setupWith(true));
      await K.setupStatus();
      fake.labelSets!.mockResolvedValue({ sets: [setEntry("ai-podcast", { builtIn: true }), setEntry("mine")] });
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
      expect((await P.replayChoices()).labelling).toEqual({ labelSet: "ai-podcast" });
    });
  });

  test("the replay button opens its popover and focuses its first field; a second click closes it", () => {
    P.bindControls(vi.fn(), vi.fn());
    $("#replay-btn").click();
    expect([$("#replay-pop").hidden, $("#replay-btn").getAttribute("aria-expanded")]).toEqual([false, "true"]);
    expect(document.activeElement).toBe($("#replay-dir"));
    $("#replay-btn").click();
    expect([$("#replay-pop").hidden, $("#replay-btn").getAttribute("aria-expanded")]).toEqual([true, "false"]);
  });

  test("the cog opens the menu and closes the replay popover", () => {
    P.bindControls(vi.fn(), vi.fn());
    $("#replay-btn").click();
    $("#cog-btn").click();
    expect([$("#cog-menu").hidden, $("#replay-pop").hidden, $("#replay-btn").getAttribute("aria-expanded")]).toEqual([false, true, "false"]);
  });

  test("a click outside a pop closes it, a click inside keeps it, and Escape closes every pop", () => {
    P.bindControls(vi.fn(), vi.fn());
    $("#replay-btn").click();
    $("#replay-dir").click();
    expect($("#replay-pop").hidden).toBe(false);
    $("#transcript").click();
    expect($("#replay-pop").hidden).toBe(true);
    $("#cog-btn").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect($("#cog-menu").hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect($("#cog-menu").hidden).toBe(true);
  });

  test("a [data-open] item closes the menu, lets the caller render the window, and opens it", () => {
    const onOpen = vi.fn();
    P.bindControls(onOpen, vi.fn());
    $("#cog-btn").click();
    $('[data-open="dlg-insights"]').click();
    expect(onOpen).toHaveBeenCalledWith("dlg-insights");
    expect([$("#cog-menu").hidden, $<HTMLDialogElement>("#dlg-insights").open]).toEqual([true, true]);
  });

  test("[data-close] closes its dialog, [data-cancel] closes it as cancelled, and a click on the backdrop closes it", () => {
    P.bindControls(vi.fn(), vi.fn());
    const dlg = $<HTMLDialogElement>("#dlg-start");
    dlg.showModal();
    dlg.querySelector<HTMLElement>("[data-close]")!.click();
    expect(dlg.open).toBe(false);
    dlg.showModal();
    dlg.querySelector<HTMLElement>("[data-cancel]")!.click();
    expect([dlg.open, dlg.returnValue]).toEqual([false, "cancel"]);
    dlg.showModal();
    dlg.querySelector<HTMLElement>(".dlg-body")!.click();
    expect(dlg.open).toBe(true);
    dlg.click();
    expect(dlg.open).toBe(false);
  });

  test("the ON AIR block's entrance ends with its sweep animation, not another one", () => {
    P.bindControls(vi.fn(), vi.fn());
    P.renderSession(S.emptyState());
    P.renderSession(live());
    expect($("#onair").className).toBe("onair enter");
    const ended = (name: string) => $("#onair").dispatchEvent(Object.assign(new Event("animationend"), { animationName: name }));
    ended("pulse");
    expect($("#onair").classList.contains("enter")).toBe(true);
    ended("onair-sweep");
    expect($("#onair").classList.contains("enter")).toBe(false);
    P.renderSession(live());
    expect($("#onair").className).toBe("onair");
  });
});

describe("the Start live window", () => {
  const sets = { sets: [setEntry("ai-podcast", { name: "AI podcast", builtIn: true, perHourUsd: 0.012 }), setEntry("mine", { name: "Mine", perHourUsd: 0.05 }), setEntry("bad", { broken: "x" })] };
  const summary = () => ({ what: $("#start-summary b").textContent, all: text("#start-summary") });
  const factcheck = () => $("#feat-factcheck").getAttribute("aria-checked");
  const pick = () => $<HTMLSelectElement>("#start-labelset");

  async function openWith(o: { key?: boolean; transcription?: ReturnType<typeof transcriptionWith> } = {}) {
    fake.setup!.mockResolvedValue(setupWith(!!o.key));
    await K.setupStatus();
    fake.labelSets!.mockResolvedValue(sets);
    fake.transcription!.mockResolvedValue(o.transcription ?? transcriptionWith("openai"));
    fake.devices!.mockResolvedValue([{ uid: "air", name: "AirPods", transport: "bluetooth", isDefault: false }]);
    P.bindControls(vi.fn(), vi.fn());
    $("#start-live").click();
    await flush();
    await flush();
  }

  test("with the OpenRouter key: everything on, the remembered set picked, the cost at most, the dialog open and Start focused", async () => {
    $<HTMLSelectElement>("#voices").value = "3";
    await openWith({ key: true });
    expect([factcheck(), pick().value, $<HTMLSelectElement>("#voices").value]).toEqual(["true", "ai-podcast", "0"]);
    expect([...pick().options].map((o) => o.value)).toEqual(["ai-podcast", "mine", "off"]);
    expect(summary()).toEqual({ what: "Everything on · labels: AI podcast", all: "Everything on · labels: AI podcastAbout $1.62 an hour at most." });
    expect($<HTMLDialogElement>("#dlg-start").open).toBe(true);
    expect(document.activeElement).toBe($("#start-go"));
    expect($("#start-stories-box").hidden).toBe(false);
    expect($("#start-key").hidden).toBe(true);
  });

  test("the set's own estimate counts: a set at $0.05 an hour", async () => {
    localStorage.setItem("pa.labelSet", "mine");
    await openWith({ key: true });
    expect(summary().all).toBe("Everything on · labels: MineAbout $1.66 an hour at most.");
  });

  test("fact-checking off: 'No fact-checking', no longer 'at most'", async () => {
    await openWith({ key: true });
    $("#feat-factcheck").click();
    expect(factcheck()).toBe("false");
    expect(summary().all).toBe("No fact-checking · labels: AI podcastAbout $1.27 an hour.");
  });

  test("labels off: 'No labels', and the stories field hides", async () => {
    await openWith({ key: true });
    pick().value = "off";
    pick().dispatchEvent(new Event("change"));
    expect(summary().all).toBe("No labelsAbout $1.61 an hour at most.");
    expect($("#start-stories-box").hidden).toBe(true);
  });

  test("without the key both start off: transcript only", async () => {
    await openWith({ key: false });
    expect([factcheck(), pick().value]).toEqual(["false", "off"]);
    expect(summary().all).toBe("Transcript only: Jev and System 2 are not calledAbout $1.23 an hour.");
  });

  test("with Apple Speech the transcript is free, and a transcript-only show costs nothing", async () => {
    await openWith({ key: false, transcription: transcriptionWith("apple") });
    expect(summary().all).toBe("Transcript only: Jev and System 2 are not calledTranscript: free, on this Mac. Free: nothing leaves this Mac.");
    expect($<HTMLButtonElement>("#start-go").disabled).toBe(false);
  });

  test("with Apple's model still downloading, Start waits and says how far along it is", async () => {
    await openWith({ key: false, transcription: transcriptionWith("apple", "installing", { fraction: 0.42 }) });
    expect(summary().all).toBe("Getting on-device speech recognition ready… 42 %Start is available as soon as it is.");
    expect($<HTMLButtonElement>("#start-go").disabled).toBe(true);
    $<HTMLButtonElement>("#start-go").click();
    await flush();
    expect(fake.startLive).not.toHaveBeenCalled();
    // the model's progress re-renders the open window
    K.setTranscription(transcriptionWith("apple", "installed"));
    expect($<HTMLButtonElement>("#start-go").disabled).toBe(false);
  });

  test("a missing model with no progress yet reads 0 %", async () => {
    await openWith({ key: false, transcription: transcriptionWith("apple", "missing") });
    expect(summary().what).toBe("Getting on-device speech recognition ready… 0 %");
  });

  test("a model that failed: its error, Try again (installs again), and a link to Settings → Transcription", async () => {
    const opener = vi.fn();
    P.setPanelOpener(opener);
    await openWith({ key: false, transcription: transcriptionWith("apple", "error", { error: "No space left" }) });
    expect(summary().all).toBe("On-device speech recognition is not readyNo space left Try again · Settings → Transcription");
    fake.installModel!.mockResolvedValue(transcriptionWith("apple", "installed"));
    [...document.querySelectorAll<HTMLButtonElement>("#start-summary .linkbtn")][0]!.click();
    await flush();
    expect(fake.installModel).toHaveBeenCalledOnce();
    expect(K.transcriptionState()?.apple.model).toBe("installed");
    expect(summary().what).toBe("Transcript only: Jev and System 2 are not called");
  });

  test("Try again that fails shows the error; Settings closes Start live and opens the Transcription window", async () => {
    const opener = vi.fn();
    P.setPanelOpener(opener);
    await openWith({ key: false, transcription: transcriptionWith("apple", "error") });
    expect(summary().all).toContain("It could not be prepared.");
    fake.installModel!.mockRejectedValue(new Error("still no space"));
    [...document.querySelectorAll<HTMLButtonElement>("#start-summary .linkbtn")][0]!.click();
    await flush();
    expect(toasts()).toEqual(["toast error|still no space"]);
    fake.installModel!.mockRejectedValue("plain");
    [...document.querySelectorAll<HTMLButtonElement>("#start-summary .linkbtn")][0]!.click();
    await flush();
    expect(toasts()[1]).toBe("toast error|plain");
    [...document.querySelectorAll<HTMLButtonElement>("#start-summary .linkbtn")][1]!.click();
    expect($<HTMLDialogElement>("#dlg-start").open).toBe(false);
    expect(opener).toHaveBeenCalledWith("dlg-transcription");
  });

  test("a key saved elsewhere while the window opens switches fact-checking and labels on", async () => {
    fake.setup!.mockResolvedValue(setupWith(false));
    await K.setupStatus();
    fake.setup!.mockResolvedValue(setupWith(true));
    fake.labelSets!.mockResolvedValue(sets);
    P.bindControls(vi.fn(), vi.fn());
    $("#start-live").click();
    expect(factcheck()).toBe("false");
    await flush();
    await flush();
    expect([factcheck(), pick().value]).toEqual(["true", "ai-podcast"]);
  });

  test("turning fact-checking on without the key asks for it in the window; Not now turns everything back off", async () => {
    await openWith({ key: false });
    $("#feat-factcheck").click();
    expect(factcheck()).toBe("true");
    expect($("#start-key").hidden).toBe(false);
    expect($("#start-key .key-prompt-h").textContent).toBe("Please provide your OpenRouter API key to configure fact-checking or labeling.");
    const notNow = [...document.querySelectorAll<HTMLButtonElement>("#start-key button")].find((b) => b.textContent === "Not now")!;
    notNow.click();
    expect([factcheck(), pick().value, $("#start-key").hidden, $("#start-key").children.length]).toEqual(["false", "off", true, 0]);
  });

  test("picking a set without the key asks for it; a set picked by the window itself does not", async () => {
    await openWith({ key: false });
    expect($("#start-key").hidden).toBe(true);
    pick().value = "mine";
    pick().dispatchEvent(new Event("change"));
    expect($("#start-key").hidden).toBe(false);
  });

  test("turning fact-checking off, or on with the key, asks for nothing", async () => {
    await openWith({ key: true });
    $("#feat-factcheck").click();
    $("#feat-factcheck").click();
    expect($("#start-key").hidden).toBe(true);
  });

  test("Start sends the microphone, the voices, the features, the set, and the stories, remembers the mic and the set, and closes", async () => {
    await openWith({ key: true });
    $<HTMLSelectElement>("#mic").value = "air";
    $<HTMLSelectElement>("#voices").value = "2";
    $<HTMLTextAreaElement>("#start-stories").value = " Story one \n\n Story two ";
    $("#start-go").click();
    await flush();
    expect(fake.startLive).toHaveBeenCalledWith("air", 2, { factcheck: true, labels: true }, { labelSet: "ai-podcast", stories: ["Story one", "Story two"] });
    expect([localStorage.getItem("pa.mic"), localStorage.getItem("pa.labelSet")]).toEqual(["air", "ai-podcast"]);
    expect($<HTMLDialogElement>("#dlg-start").open).toBe(false);
  });

  test("with no microphone to choose and labels off, Start sends no mic, no set and no stories, and saves nothing", async () => {
    await openWith({ key: false });
    fake.devices!.mockRejectedValue(new Error("no helper"));
    await P.loadDevices();
    $<HTMLTextAreaElement>("#start-stories").value = "ignored";
    $("#start-go").click();
    await flush();
    expect(fake.startLive).toHaveBeenCalledWith(undefined, 0, { factcheck: false, labels: false }, { labelSet: null, stories: [] });
    expect([localStorage.getItem("pa.mic"), localStorage.getItem("pa.labelSet")]).toEqual([null, null]);
  });

  test("storage that throws does not stop a start", async () => {
    await openWith({ key: true });
    $<HTMLSelectElement>("#mic").value = "air";
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    $("#start-go").click();
    await flush();
    expect(fake.startLive).toHaveBeenCalledOnce();
  });

  test("Start with a feature on but no key asks for the key; once saved, the session starts", async () => {
    await openWith({ key: false });
    $("#feat-factcheck").setAttribute("aria-checked", "true");
    $("#start-go").click();
    expect($("#start-key").hidden).toBe(false);
    expect(fake.startLive).not.toHaveBeenCalled();
    fake.saveKeys!.mockResolvedValue({ ...setupWith(true), saved: true, checks: { openrouter: { ok: true, message: "Works" } } });
    $<HTMLInputElement>("#start-key input").value = "sk-or-v1-0123456789abcdef0123";
    [...document.querySelectorAll<HTMLButtonElement>("#start-key button")].find((b) => b.textContent === "Save")!.click();
    await flush();
    await flush();
    expect($("#start-key").hidden).toBe(true);
    expect(fake.startLive).toHaveBeenCalledWith("builtin", 0, { factcheck: true, labels: false }, { labelSet: null, stories: [] });
  });

  test("the engine saying the key is missing asks for it in the window", async () => {
    await openWith({ key: true });
    fake.startLive!.mockRejectedValue(new A.ApiError(400, "OpenRouter key missing", { needsKey: "openrouter" }));
    fake.setup!.mockResolvedValue(setupWith(false));
    $("#start-go").click();
    await flush();
    await flush();
    expect($("#start-key").hidden).toBe(false);
    expect($<HTMLDialogElement>("#dlg-start").open).toBe(true);
    expect(fake.setup).toHaveBeenCalledTimes(3);
  });

  test("the engine saying Apple's model is getting ready keeps the window open and asks for its progress", async () => {
    await openWith({ key: true });
    fake.startLive!.mockRejectedValue(new A.ApiError(409, "preparing", { preparing: true }));
    const before = fake.transcription!.mock.calls.length;
    $("#start-go").click();
    await flush();
    expect($<HTMLDialogElement>("#dlg-start").open).toBe(true);
    expect(fake.transcription!.mock.calls.length).toBe(before + 1);
    expect(toasts()).toEqual([]);
  });

  test("any other failure closes the window and shows the error", async () => {
    await openWith({ key: true });
    fake.startLive!.mockRejectedValueOnce(new A.ApiError(409, "a session is running"));
    $("#start-go").click();
    await flush();
    expect($<HTMLDialogElement>("#dlg-start").open).toBe(false);
    fake.startLive!.mockRejectedValueOnce("plain");
    $<HTMLDialogElement>("#dlg-start").showModal();
    $("#start-go").click();
    await flush();
    expect(toasts()).toEqual(["toast error|a session is running", "toast error|plain"]);
  });

  test("a library that fails leaves only Off", async () => {
    fake.setup!.mockResolvedValue(setupWith(true));
    await K.setupStatus();
    fake.labelSets!.mockRejectedValue(new Error("down"));
    P.bindControls(vi.fn(), vi.fn());
    $("#start-live").click();
    await flush();
    await flush();
    expect([...pick().options].map((o) => o.value)).toEqual(["off"]);
    expect(summary().what).toBe("No labels");
  });
});

describe("bindSessionName", () => {
  function bound(st = live({ name: "Show 1" })) {
    let state = st;
    const onRenamed = vi.fn();
    P.renderSession(state);
    P.bindSessionName(() => state, onRenamed);
    return { onRenamed, set: (s: typeof st) => { state = s; }, get: () => state };
  }
  const input = () => document.querySelector<HTMLInputElement>("#top input.name-input");

  test("a click with no session, or while the button is hidden, does nothing", () => {
    bound(S.emptyState());
    $("#session-name").click();
    expect(input()).toBeNull();
    const b = bound();
    b.set(live());
    $("#session-name").hidden = true;
    $("#session-name").click();
    expect(input()).toBeNull();
  });

  test("a click swaps the name for a focused input with the name, the id as placeholder, and a 120-character limit", () => {
    bound();
    $("#session-name").click();
    const i = input()!;
    expect([$("#session-name").hidden, i.value, i.placeholder, i.getAttribute("maxlength"), i.getAttribute("aria-label")]).toEqual([true, "Show 1", "s1", "120", "Name"]);
    expect(document.activeElement).toBe(i);
    expect(i.previousElementSibling).toBe($("#session-name"));
  });

  test("Enter with a new name renames the session, updates the state, and says so", async () => {
    fake.renameSession!.mockResolvedValue({ name: "Show 2" });
    const b = bound();
    $("#session-name").click();
    input()!.value = " Show 2 ";
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await flush();
    expect(fake.renameSession).toHaveBeenCalledWith("s1", "Show 2");
    expect([b.get().session!.name, b.onRenamed.mock.calls.length, input(), $("#session-name").hidden]).toEqual(["Show 2", 1, null, false]);
    expect(toasts()).toEqual(["toast ok|Session renamed to Show 2"]);
  });

  test("an emptied name clears it", async () => {
    fake.renameSession!.mockResolvedValue({ name: null });
    bound();
    $("#session-name").click();
    input()!.value = "  ";
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(fake.renameSession).toHaveBeenCalledWith("s1", "");
    expect(toasts()).toEqual(["toast ok|Session name cleared"]);
  });

  test("the same name saves nothing and focuses the name again; Escape cancels", () => {
    bound();
    $("#session-name").click();
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(fake.renameSession).not.toHaveBeenCalled();
    expect(document.activeElement).toBe($("#session-name"));
    $("#session-name").click();
    input()!.value = "Other";
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect([fake.renameSession!.mock.calls.length, input()]).toEqual([0, null]);
  });

  test("leaving the field saves, once (Enter then blur is one call)", async () => {
    fake.renameSession!.mockResolvedValue({ name: "B" });
    bound();
    $("#session-name").click();
    const i = input()!;
    i.value = "B";
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    i.dispatchEvent(new Event("blur"));
    await flush();
    expect(fake.renameSession).toHaveBeenCalledOnce();
    $("#session-name").click();
    input()!.value = "C";
    input()!.dispatchEvent(new Event("blur"));
    await flush();
    expect(fake.renameSession).toHaveBeenCalledTimes(2);
  });

  test("keys and clicks inside the field stay in it", () => {
    bound();
    $("#session-name").click();
    const onKey = vi.fn();
    const onClick = vi.fn();
    document.body.addEventListener("keydown", onKey);
    document.body.addEventListener("click", onClick);
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    input()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect([onKey.mock.calls.length, onClick.mock.calls.length]).toEqual([0, 0]);
    document.body.removeEventListener("keydown", onKey);
    document.body.removeEventListener("click", onClick);
  });

  test("a rename that lands after another session opened does not rename the new one", async () => {
    let resolve!: (v: { name: string }) => void;
    fake.renameSession!.mockReturnValue(new Promise((r) => { resolve = r; }));
    const b = bound();
    $("#session-name").click();
    input()!.value = "New";
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    const other = live({ id: "s2", name: "Other" });
    b.set(other);
    resolve({ name: "New" });
    await flush();
    expect(other.session!.name).toBe("Other");
  });
});

describe("renderSession", () => {
  const pause = () => $<HTMLButtonElement>("#pause");

  test("no session: no ON AIR block, 'No session' disabled, start buttons on, Stop and Pause hidden, no chip", () => {
    P.renderSession(S.emptyState());
    expect([$("#onair").hidden, $("#top").classList.contains("no-onair"), $("#top").classList.contains("on-air")]).toEqual([true, true, false]);
    const name = $<HTMLButtonElement>("#session-name");
    expect([name.textContent, name.disabled, name.title]).toEqual(["No session", true, ""]);
    expect([$<HTMLButtonElement>("#start-live").disabled, $<HTMLButtonElement>("#start-replay").disabled]).toEqual([false, false]);
    expect([$<HTMLButtonElement>("#stop").disabled, $("#stop").hidden]).toEqual([true, true]);
    expect([pause().hidden, pause().disabled, pause().dataset.paused, pause().getAttribute("aria-pressed"), pause().textContent]).toEqual([true, true, "0", "false", "Pause"]);
    expect([text("#replay-note"), $("#features-chip").hidden, text("#features-chip"), $("#tl").classList.contains("labels-off")]).toEqual(["", true, "", false]);
  });

  test("a live session on the first render: 'On air' without the entrance, the controls that work now", () => {
    P.renderSession(live());
    expect([$("#onair").hidden, $("#onair").className, text("#onair-label")]).toEqual([false, "onair", "On air"]);
    expect([$("#top").classList.contains("on-air"), $("#top").classList.contains("no-onair")]).toEqual([true, false]);
    expect([$<HTMLButtonElement>("#start-live").disabled, $<HTMLButtonElement>("#stop").disabled, $("#stop").hidden]).toEqual([true, false, false]);
    expect([pause().hidden, pause().disabled, pause().title]).toEqual([false, false, "Pause: audio becomes silence until you resume; Stop still works"]);
    expect(pause().querySelector("use")!.getAttribute("href")).toBe("#g-pause");
    expect(text("#replay-note")).toBe("Stop the current session first.");
    expect([text("#session-name"), $("#session-name").title]).toEqual(["s1", "Click to rename · live session s1"]);
  });

  test("off, then on: the entrance plays", () => {
    P.renderSession(S.emptyState());
    P.renderSession(live());
    expect($("#onair").className).toBe("onair enter");
  });

  test("paused: 'Paused', and Pause becomes Resume", () => {
    P.renderSession(live({ paused: true }));
    expect([$("#onair").className, text("#onair-label")]).toEqual(["onair paused", "Paused"]);
    expect([pause().dataset.paused, pause().getAttribute("aria-pressed"), pause().textContent, pause().title]).toEqual(["1", "true", "Resume", "Resume listening"]);
    expect(pause().querySelector("use")!.getAttribute("href")).toBe("#g-play");
  });

  test("a replay: 'Replay', and no Pause", () => {
    P.renderSession(live({ mode: "replay", name: "Named" }));
    expect([$("#onair").className, text("#onair-label"), pause().hidden, text("#session-name")]).toEqual(["onair replay", "Replay", true, "Named"]);
  });

  test("stopping: 'Stopping', and Pause shown but off", () => {
    P.renderSession(live({ status: "ending" }));
    expect([text("#onair-label"), pause().hidden, pause().disabled]).toEqual(["Stopping", false, true]);
  });

  test("a recording: no block, start buttons on, Stop hidden, the name enabled", () => {
    P.renderSession(live({ status: "archived" }));
    expect([$("#onair").hidden, $("#top").classList.contains("on-air"), $("#stop").hidden, $<HTMLButtonElement>("#start-live").disabled, $<HTMLButtonElement>("#session-name").disabled]).toEqual([true, false, true, false, false]);
  });

  test("the features chip names what is off, with a title only when shown; labels off marks the timeline", () => {
    const chip = () => [$("#features-chip").hidden, text("#features-chip"), $("#features-chip").title];
    const shown = "Chosen when the session started; it stays this way for the whole session";
    P.renderSession(live({ features: { factcheck: false, labels: false } }));
    expect(chip()).toEqual([false, "Transcript only", shown]);
    expect($("#tl").classList.contains("labels-off")).toBe(true);
    P.renderSession(live({ features: { factcheck: false, labels: true } }));
    expect(chip()).toEqual([false, "No fact-check", shown]);
    expect($("#tl").classList.contains("labels-off")).toBe(false);
    P.renderSession(live({ features: { factcheck: true, labels: false } }));
    expect(chip()).toEqual([false, "No labels", shown]);
    P.renderSession(live());
    expect(chip()).toEqual([true, "", ""]);
  });
});

describe("renderClock", () => {
  test("mm:ss with zero-padded minutes, h:mm:ss past an hour, never negative", () => {
    const at = (ms: number) => { P.renderClock(ms); return text("#clock"); };
    expect([at(0), at(999), at(339_000), at(3_939_000), at(-1)]).toEqual(["00:00", "00:00", "05:39", "1:05:39", "00:00"]);
  });
});

describe("renderMenu", () => {
  test("with nothing to say: the default summaries, and the session windows greyed out", () => {
    P.renderMenu(S.emptyState());
    expect([text("#m-recordings"), text("#m-insights"), text("#m-speakers"), text("#m-transcription")]).toEqual(["Open, rename, replay", "Stats, fact-checker, log", "Start or open a recording", ""]);
    expect($<HTMLButtonElement>('#cog-menu [data-open="dlg-speakers"]').disabled).toBe(true);
    expect([...P.SESSION_WINDOWS]).toEqual(["dlg-speakers"]);
  });

  test("Insights says the index, the flags, and the errors in red, separated by dots", () => {
    const st = live();
    st.stats = { index: { name: "Off-topic", description: "", share: 0.234 } } as never;
    st.claims.set("c_1", { id: "c_1", repeats: [], duplicates: [] } as never);
    st.errors.push({ component: "jev", message: "x", at: "" });
    P.renderMenu(st);
    expect(text("#m-insights")).toBe("Off-topic 23% · 1 flag · 1 error");
    expect($("#m-insights em.error-text").textContent).toBe("1 error");
    st.claims.set("c_2", { id: "c_2", repeats: [], duplicates: [] } as never);
    st.errors.push(st.errors[0]!, st.errors[0]!);
    P.renderMenu(st);
    expect(text("#m-insights")).toBe("Off-topic 23% · 2 flags · 3 errors");
  });

  test("fact-checking off leaves out the flags; errors alone have no leading dot", () => {
    const st = live({ features: { factcheck: false, labels: true } });
    st.errors.push({ component: "jev", message: "x", at: "" });
    P.renderMenu(st);
    expect(text("#m-insights")).toBe("1 error");
  });

  test("with a session, Speakers counts the unmerged voices and is enabled; Transcription names the engine", () => {
    const st = feed(S, [
      ["speaker.created", { id: "A", displayName: "Ann" }],
      ["speaker.created", { id: "B", displayName: "Bob" }],
      ["speaker.merged", { fromId: "B", intoId: "A" }],
    ], snapshot());
    K.setTranscription(transcriptionWith("apple"));
    P.renderMenu(st);
    expect([text("#m-speakers"), text("#m-insights"), text("#m-transcription")]).toEqual(["1 voice", "0 flags", "On this Mac"]);
    expect($<HTMLButtonElement>('#cog-menu [data-open="dlg-speakers"]').disabled).toBe(false);
    st.speakers.get("B")!.mergedInto = undefined;
    P.renderMenu(st);
    expect(text("#m-speakers")).toBe("2 voices");
  });
});

describe("Insights tabs", () => {
  const selected = () => [...document.querySelectorAll("#dlg-insights .tab")].map((t) => t.getAttribute("aria-selected"));
  const panes = () => ["#stats", "#s1", "#errors"].map((s) => $(s).hidden);

  test("showInsights shows the tab's pane, its subtitle, and puts the section in the URL", () => {
    history.replaceState(null, "", "/?panel=insights");
    P.showInsights("log");
    expect([selected(), panes(), text("#insights-sub")]).toEqual([["false", "false", "true"], [true, true, false], "The last 30 errors"]);
    expect(location.search).toBe("?panel=insights&section=log");
  });

  test("an unknown section shows the first tab, which the URL leaves out", () => {
    history.replaceState(null, "", "/?panel=insights&section=log");
    P.showInsights("nope");
    expect([selected(), panes()]).toEqual([["true", "false", "false"], [false, true, true]]);
    expect(location.search).toBe("?panel=insights");
  });

  test("bindInsights: clicking the Fact-checker tab shows #s1", () => {
    P.bindInsights();
    $('#dlg-insights .tab[data-section="fact-checker"]').click();
    expect(panes()).toEqual([true, false, true]);
  });
});

describe("renderHealth", () => {
  const NOW = 1_000_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  const meters = () => [...document.querySelectorAll<HTMLElement>("#health .meter")];
  const meta = (i: number) => meters()[i]!.querySelector(".meta")!.textContent;
  const bar = (i: number) => meters()[i]!.querySelector<HTMLElement>(".bar b")!.style.width;
  const health = (o: Record<string, unknown> = {}) => ({ rmsDbfs: -20, msSinceLastFrame: 100, utterancesLastMinute: 0, receivedAt: NOW, lastSoundAt: NOW, ...o });

  test("no session: two meters, waiting, empty bars, no alert", () => {
    P.renderHealth(S.emptyState());
    expect(meters().map((m) => m.className)).toEqual(["meter", "meter"]);
    expect([meta(0), meta(1), bar(0)]).toEqual(["waiting…", "waiting…", "0%"]);
    expect(meters()[0]!.title).toBe("Host · last frame –");
    expect(meters().map((m) => m.querySelector(".who")!.textContent)).toEqual(["Host", "Remote"]);
  });

  test("a live session with no health yet shows red", () => {
    P.renderHealth(live());
    expect(meters()[0]!.classList.contains("alert")).toBe(true);
    expect(meta(0)).toBe("waiting…");
  });

  test("a healthy stream: its level with a real minus sign, the frame age, and the bar", () => {
    const st = live();
    st.health.host = health();
    P.renderHealth(st);
    expect([meta(0), meters()[0]!.className]).toEqual(["−20 dBFS · 100 ms", "meter"]);
    expect(parseFloat(bar(0))).toBeCloseTo(66.667, 2);
    st.health.host = health({ msSinceLastFrame: 500, receivedAt: NOW - 1000 });
    P.renderHealth(st);
    expect(meta(0)).toBe("−20 dBFS · 1.5 s");
  });

  test("no frame for more than 3 s turns it red", () => {
    const st = live();
    st.health.host = health({ receivedAt: NOW - 3500 });
    P.renderHealth(st);
    expect(meters()[0]!.classList.contains("alert")).toBe(true);
    expect(meta(0)).toBe("−20 dBFS · 3.6 s");
  });

  test("silence for more than 10 s turns it red and says how long", () => {
    const st = live();
    st.health.host = health({ rmsDbfs: -55, lastSoundAt: NOW - 12_000 });
    P.renderHealth(st);
    expect([meters()[0]!.classList.contains("alert"), meta(0)]).toEqual([true, "−55 dBFS · silent 12 s"]);
  });

  test("a stream the session does not have is absent, never red", () => {
    P.renderHealth(live({ streams: ["host"] }));
    expect([meters()[1]!.className, meta(1)]).toEqual(["meter absent", "absent"]);
  });

  test("paused: 'paused', never red", () => {
    P.renderHealth(live({ paused: true }));
    expect([meters()[0]!.className, meta(0)]).toEqual(["meter paused", "paused"]);
  });

  test("speaker mode muting the microphone most of the last second: 'muted · call playing', not red", () => {
    const st = live();
    st.health.host = health({ rmsDbfs: -90, lastSoundAt: NOW - 20_000, echoMutedMs: 800 });
    P.renderHealth(st);
    expect(meters()[0]!.classList.contains("muted")).toBe(true);
    expect(meta(0)).toBe("muted · call playing");
    st.health.host = health({ echoMutedMs: 400 });
    P.renderHealth(st);
    expect([meters()[0]!.classList.contains("muted"), meta(0)]).toEqual([false, "−20 dBFS · 100 ms"]);
  });

  test("the device: the host's microphone and the call's output, in the meter and its title", () => {
    const st = live();
    st.health.host = health({ detail: { host: { device: "MacBook Mic" } } });
    st.health.remote = health({ detail: { remote: { outputDevice: "AirPods" } } });
    P.renderHealth(st);
    expect(meters().map((m) => m.querySelector(".dev")?.textContent)).toEqual(["MacBook Mic", "AirPods"]);
    expect(meters()[0]!.title).toBe("Host · MacBook Mic · last frame 100 ms");
  });

  test("the bar is clamped to 0–100 %", () => {
    const st = live();
    st.health.host = health({ rmsDbfs: -80 });
    st.health.remote = health({ rmsDbfs: 5 });
    P.renderHealth(st);
    expect([bar(0), bar(1)]).toEqual(["0%", "100%"]);
  });

  test("an opened recording has no meters", () => {
    P.renderHealth(live());
    P.renderHealth(live({ status: "archived" }));
    expect($("#health").children.length).toBe(0);
  });

  test("the Speakers chip shows only while a live session is in speaker mode, with the device", () => {
    P.renderHealth(live({ echoGate: { active: true, device: "MacBook Pro Speakers" } }));
    expect([$("#speaker-mode").hidden, text("#speaker-mode-device")]).toEqual([false, "MacBook Pro Speakers"]);
    P.renderHealth(live({ echoGate: { active: true, device: null } }));
    expect(text("#speaker-mode-device")).toBe("the Mac's speakers");
    P.renderHealth(live({ echoGate: { active: false, device: null } }));
    expect($("#speaker-mode").hidden).toBe(true);
    P.renderHealth(live({ status: "archived", echoGate: { active: true, device: "X" } }));
    expect([$("#speaker-mode").hidden, text("#speaker-mode-device")]).toEqual([true, "the Mac's speakers"]);
  });
});

describe("renderCost", () => {
  test("on air: 'Spend', the session's spend and its breakdown, chat $0 when there is none", () => {
    const st = live();
    st.cost = { transcription: 1, jev: 0.2, s2: 0.03, session: 1.23 };
    $("#cost").dataset.tip = "old";
    P.renderCost(st);
    expect([text("#cost .k"), text("#cost .v"), text("#cost .pop-h"), $("#cost").getAttribute("aria-label"), $("#cost").hasAttribute("data-tip")])
      .toEqual(["Spend", "$1.23", "Session spend", "Session spend $1.23", false]);
    expect([...document.querySelectorAll("#cost dd")].map((d) => d.textContent)).toEqual(["$1.00", "$0.20", "$0.03", "$0.0000"]);
    expect([...document.querySelectorAll("#cost dt")].map((d) => d.textContent)).toEqual(["Transcription", "Jev", "System 2", "Chat"]);
    expect(document.querySelectorAll("#cost .note").length).toBe(1);
    expect($("#cost").classList.contains("exhausted")).toBe(false);
  });

  test("a recording: 'Cost', what it cost, and the note", () => {
    const st = live({ status: "archived" });
    st.cost = { transcription: 0, jev: 0, s2: 0, chat: 0.5, session: 0.5 };
    P.renderCost(st);
    expect([text("#cost .k"), text("#cost .pop-h")]).toEqual(["Cost", "This recording cost"]);
    expect(document.querySelectorAll("#cost .note").length).toBe(2);
    expect([...document.querySelectorAll("#cost dd")].at(-1)!.textContent).toBe("$0.50");
  });

  test("OpenRouter refusing: the chip turns exhausted and says why; it clears again", () => {
    const st = live();
    st.budgetExhausted = "key limit reached";
    P.renderCost(st);
    expect([$("#cost").classList.contains("exhausted"), text("#cost .error-text")]).toEqual([true, "OpenRouter stopped: key limit reached"]);
    st.budgetExhausted = null;
    P.renderCost(st);
    expect($("#cost").classList.contains("exhausted")).toBe(false);
  });
});

describe("bindSplit", () => {
  const split = () => $("#split");
  const value = () => $("#stage").style.getPropertyValue("--split");

  test("without #stage or #split it does nothing", () => {
    $("#split").remove();
    expect(() => P.bindSplit()).not.toThrow();
  });

  test("restores the saved split, clamped to 25–75; 0 or junk is ignored", () => {
    for (const [saved, want] of [["40", "40.00%"], ["90", "75.00%"], ["10", "25.00%"]] as const) {
      loadIndexHtml();
      localStorage.setItem("pa.splitPct", saved);
      P.bindSplit();
      expect(value()).toBe(want);
    }
    expect(split().getAttribute("aria-valuenow")).toBe("25");
    for (const saved of ["x", "0"]) {
      loadIndexHtml();
      localStorage.setItem("pa.splitPct", saved);
      P.bindSplit();
      expect(value()).toBe("");
    }
    expect([split().getAttribute("aria-valuemin"), split().getAttribute("aria-valuemax")]).toEqual(["25", "75"]);
  });

  test("double-click resets to 56.5 % and saves it", () => {
    P.bindSplit();
    split().dispatchEvent(new MouseEvent("dblclick"));
    expect([value(), localStorage.getItem("pa.splitPct"), split().getAttribute("aria-valuenow")]).toEqual(["56.50%", "56.5", "57"]);
  });

  test("the arrow keys move it by 2 from the current split (56.5 when none is set)", () => {
    P.bindSplit();
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    split().dispatchEvent(right);
    expect([value(), right.defaultPrevented]).toEqual(["58.50%", true]);
    loadIndexHtml();
    localStorage.clear();
    P.bindSplit();
    split().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(value()).toBe("54.50%");
    const other = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    split().dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  test("dragging sets the split from the pointer, marks the drag, and stops on pointerup or pointercancel", () => {
    P.bindSplit();
    layout($("#stage"), { rect: { left: 0, width: 1000 } });
    split().setPointerCapture = vi.fn();
    for (const end of ["pointerup", "pointercancel"]) {
      split().dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, cancelable: true }));
      expect([split().classList.contains("dragging"), document.body.classList.contains("resizing-x")]).toEqual([true, true]);
      split().dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
      expect(value()).toBe("30.00%");
      split().dispatchEvent(new PointerEvent(end));
      expect([split().classList.contains("dragging"), document.body.classList.contains("resizing-x")]).toEqual([false, false]);
      split().dispatchEvent(new PointerEvent("pointermove", { clientX: 600 }));
      expect(value()).toBe("30.00%");
    }
  });

  test("storage that throws is tolerated", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    P.bindSplit();
    split().dispatchEvent(new MouseEvent("dblclick"));
    expect(value()).toBe("56.50%");
  });
});

describe("checkEngine", () => {
  test("a stale engine shows the banner; a fresh one hides it", async () => {
    fake.engine!.mockResolvedValue({ stale: true });
    await P.checkEngine();
    expect($("#stale").hidden).toBe(false);
    fake.engine!.mockResolvedValue({ stale: false });
    await P.checkEngine();
    expect($("#stale").hidden).toBe(true);
  });

  test("a server without /api/engine (404) is out of date too; another error changes nothing", async () => {
    fake.engine!.mockRejectedValue(new A.ApiError(500, "boom"));
    await P.checkEngine();
    expect($("#stale").hidden).toBe(true);
    fake.engine!.mockRejectedValue(new A.ApiError(404, "not found"));
    await P.checkEngine();
    expect($("#stale").hidden).toBe(false);
  });
});
