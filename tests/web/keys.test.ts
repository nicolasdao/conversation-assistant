// @vitest-environment happy-dom
// The API keys and the transcription engine (web/src/keys.ts): the first-run screen, a key asked for where it is
// needed, the API keys window, and the Transcription window. See docs/setup.md.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { KeyStatus, SaveKeysResult, SetupStatus, TranscriptionStatus } from "../../web/src/api.ts";
import { flush } from "./helpers.ts";
import { all, button, freshPage, key, later, resetApi, stubReload, text, type, type FakeApi } from "./helpers-core.ts";

const fake = vi.hoisted(() => ({}) as FakeApi);
vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig<typeof import("../../web/src/api.ts")>()), api: fake }));

type Keys = typeof import("../../web/src/keys.ts");
const load = async (desktop?: unknown): Promise<Keys> => {
  freshPage({ desktop });
  return import("../../web/src/keys.ts");
};

const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwx";
const OPENROUTER = "sk-or-v1-abcdefghijklmnopqrstuvwx";
const keyStatus = (name: "openai" | "openrouter", o: Partial<KeyStatus> = {}): KeyStatus =>
  ({ name, env: name === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY", set: false, source: null, hint: null, ...o });
const status = (o: Partial<SetupStatus> = {}): SetupStatus =>
  ({ configured: false, required: ["openai"], keys: [keyStatus("openai"), keyStatus("openrouter")], path: "~/Library/Application Support/Tattle/credentials.json", ...o });
const saved = (o: Partial<SaveKeysResult> = {}): SaveKeysResult => ({
  ...status({ configured: true, keys: [keyStatus("openai", { set: true, source: "file", hint: "wxyz" }), keyStatus("openrouter", { set: true, source: "file", hint: "abcd" })] }),
  saved: true, checks: {}, ...o,
});
const trans = (o: Partial<TranscriptionStatus> = {}, apple: Partial<TranscriptionStatus["apple"]> = {}): TranscriptionStatus => ({
  engine: "apple", saved: null, openai: { keySet: false }, ...o,
  apple: { available: true, reason: null, model: "installed", fraction: null, error: null, ...apple },
});

beforeEach(async () => { await resetApi(fake); });
afterEach(() => { vi.useRealTimers(); document.body.className = ""; });

const inputs = () => all("#setup input") as HTMLInputElement[];
const fields = () => all("#setup .setup-field");

describe("the api mock (U10)", () => {
  test("a page module importing ./api.js gets the fake, and ApiError stays real", async () => {
    const k = await load();
    fake.setup!.mockResolvedValue(status());
    expect(await k.setupStatus()).toEqual(status());
    expect(fake.setup).toHaveBeenCalledTimes(1);
    const { ApiError } = await import("../../web/src/api.ts");
    expect(new ApiError(400, "x").status).toBe(400);
  });
});

describe("setupStatus, keySet, and the transcription state", () => {
  test("setupStatus returns the status and remembers it for keySet; a failure gives null", async () => {
    const k = await load();
    expect(k.keySet("openrouter")).toBe(false);
    fake.setup!.mockResolvedValue(status({ keys: [keyStatus("openai"), keyStatus("openrouter", { set: true })] }));
    await k.setupStatus();
    expect([k.keySet("openai"), k.keySet("openrouter")]).toEqual([false, true]);
    fake.setup!.mockRejectedValue(new Error("503"));
    expect(await k.setupStatus()).toBeNull();
  });

  test("setTranscription stores it and tells every listener; refreshTranscription asks the server and keeps the last on failure", async () => {
    const k = await load();
    expect(k.transcriptionState()).toBeNull();
    const heard = vi.fn();
    k.onTranscription(heard);
    fake.transcription!.mockResolvedValue(trans({ engine: "openai" }));
    expect(await k.refreshTranscription()).toEqual(trans({ engine: "openai" }));
    expect(heard).toHaveBeenCalledTimes(1);
    fake.transcription!.mockRejectedValue(new Error("404"));
    expect((await k.refreshTranscription())?.engine).toBe("openai");
    k.setTranscription(null);
    expect([k.transcriptionState(), heard.mock.calls.length]).toEqual([null, 2]);
  });

  test("transcriptionSummary names the engine, or nothing", async () => {
    const k = await load();
    expect([k.transcriptionSummary(null), k.transcriptionSummary(trans()), k.transcriptionSummary(trans({ engine: "openai" }))]).toEqual(["", "On this Mac", "OpenAI"]);
  });
});

describe("the first-run screen", () => {
  test("with both keys missing: two numbered fields, 'Save keys and start', '0 of 2 keys added', the first field focused", async () => {
    const k = await load();
    k.showSetup(status({ required: undefined as unknown as [] }));
    expect(document.body.classList.contains("setup-mode")).toBe(true);
    expect(text("#setup h1")).toBe("Add your two API keys to start");
    expect(fields()).toHaveLength(2);
    expect(all("#setup .key-step").map((s) => s.textContent)).toEqual(["1", "2"]);
    expect(text("#setup .setup-go")).toBe("Save keys and start");
    expect(text("#setup .setup-progress")).toBe("0 of 2 keys added");
    expect(document.activeElement).toBe(inputs()[0]);
    expect(all("#setup .setup-badge").map((b) => b.textContent)).toEqual(["Required", "Required"]);
    expect(inputs().map((i) => i.getAttribute("aria-label"))).toEqual(["OpenAI API key", "OpenRouter API key"]);
  });

  test("with OpenAI's key alone missing: one field, no step numbers, 'Save key and start', '0 of 1 key added'", async () => {
    const k = await load();
    k.showSetup(status());
    expect(text("#setup h1")).toBe("Add your OpenAI API key to start");
    expect([fields().length, all("#setup .key-step").length]).toEqual([1, 0]);
    expect([text("#setup .setup-go"), text("#setup .setup-progress")]).toEqual(["Save key and start", "0 of 1 key added"]);
    expect(inputs()[0]!.placeholder).toBe("Paste your OpenAI key here (sk-…)");
    expect(text("#setup .key-how summary")).toBe("How do I get an OpenAI key? About 5 minutes");
    expect(all("#setup .key-steps li")).toHaveLength(4);
  });

  test("a key already set or not required gets no field", async () => {
    const k = await load();
    k.showSetup(status({ required: ["openai", "openrouter"], keys: [keyStatus("openai"), keyStatus("openrouter", { set: true })] }));
    expect(fields()).toHaveLength(1);
  });

  test("the lede says why: an older Mac, or OpenAI chosen", async () => {
    let k = await load();
    k.showSetup(status(), trans({ engine: "openai" }, { available: false, reason: "needs macOS 26" }));
    expect(text("#setup .setup-lede")).toMatch(/^On-device transcription needs macOS 26 or later/);
    k = await load();
    k.showSetup(status(), trans({ engine: "openai" }));
    expect(text("#setup .setup-lede")).toMatch(/^You chose OpenAI for transcription/);
    k = await load();
    k.showSetup(status());
    expect(text("#setup .setup-lede")).toMatch(/^You chose OpenAI/);
  });

  test("the footer names the file, and where to change keys: the cog menu in a browser, Settings in the Mac app", async () => {
    let k = await load();
    k.showSetup(status());
    expect(text("#setup .setup-privacy")).toContain("Keys are saved in ~/Library/Application Support/Tattle/credentials.json");
    expect(text("#setup .setup-privacy")).toContain("Change them later: cog menu → API keys.");
    k = await load({ onCommand() {}, run() {} });
    k.showSetup(status());
    expect(text("#setup .setup-privacy")).toContain("Change them later: Tattle → Settings… (⌘,).");
  });

  test("typing a key that looks right marks the field ok and counts it", async () => {
    const k = await load();
    k.showSetup(status({ required: ["openai", "openrouter"] }));
    type(inputs()[0]!, `  ${OPENAI} `);
    expect(fields()[0]!.className).toBe("setup-field ok");
    expect(text("#setup .setup-badge")).toBe("✓ Looks right");
    expect(text("#setup .setup-progress")).toBe("1 of 2 keys added");
    expect(all("#setup .setup-progress.done")).toHaveLength(0);
    type(inputs()[1]!, OPENROUTER);
    expect(text("#setup .setup-progress")).toBe("Both keys added: press Save keys and start");
    expect(all("#setup .setup-progress.done, #setup .setup-go.armed")).toHaveLength(2);
  });

  test("one field ready says 'Key added: press Save key and start'", async () => {
    const k = await load();
    k.showSetup(status());
    type(inputs()[0]!, OPENAI);
    expect(text("#setup .setup-progress")).toBe("Key added: press Save key and start");
  });

  test.each([
    ["openai", "sk-proj abc defghijklmnopqrstu", "A key has no spaces or line breaks: copy it again."],
    ["openai", OPENROUTER, "This is an OpenRouter key: paste it in the OpenRouter field."],
    ["openrouter", OPENAI, "This looks like an OpenAI key: OpenRouter keys start with sk-or-."],
    ["openai", "sk-short", "This looks too short to be a whole key."],
    ["openrouter", "sk-or-short", "This looks too short to be a whole key."],
  ])("a %s field with %j says: %s", async (name, value, message) => {
    const k = await load();
    k.showSetup(status({ required: ["openai", "openrouter"] }));
    const i = name === "openai" ? 0 : 1;
    type(inputs()[i]!, value);
    expect(fields()[i]!.classList.contains("bad")).toBe(true);
    expect(all("#setup .setup-badge")[i]!.textContent).toBe("Check this key");
    expect(all("#setup .setup-field .key-msg")[i]!.className).toBe("key-msg bad");
    expect(all("#setup .setup-field .key-msg")[i]!.textContent).toBe(message);
  });

  test("an OpenRouter key of 20+ characters is accepted in its field", async () => {
    const k = await load();
    k.showSetup(status({ required: ["openrouter"] }));
    type(inputs()[0]!, OPENROUTER);
    expect(fields()[0]!.className).toBe("setup-field ok");
  });

  test("clearing a field puts it back to Required with no message", async () => {
    const k = await load();
    k.showSetup(status());
    type(inputs()[0]!, "sk-x");
    type(inputs()[0]!, "  ");
    expect([fields()[0]!.className, text("#setup .setup-badge"), text("#setup .setup-field .key-msg")]).toEqual(["setup-field", "Required", ""]);
  });

  test("Save with an empty field asks for it, focuses it, and sends nothing", async () => {
    const k = await load();
    k.showSetup(status({ required: ["openai", "openrouter"] }));
    type(inputs()[0]!, OPENAI);
    button("Save keys and start")!.click();
    await flush();
    expect(fields()[1]!.classList.contains("bad")).toBe(true);
    expect(all("#setup .setup-field .key-msg")[1]!.textContent).toBe("Paste this key to continue.");
    expect(document.activeElement).toBe(inputs()[1]);
    expect(fake.saveKeys).not.toHaveBeenCalled();
  });

  test("Show reveals the key and Hide hides it again", async () => {
    const k = await load();
    k.showSetup(status());
    const show = button("Show")!;
    show.click();
    expect([inputs()[0]!.type, show.textContent, show.getAttribute("aria-pressed")]).toEqual(["text", "Hide", "true"]);
    show.click();
    expect([inputs()[0]!.type, show.textContent, show.getAttribute("aria-pressed")]).toEqual(["password", "Show", "false"]);
  });

  test("Enter in a field saves; Save sends the trimmed keys once while it checks, with the button busy", async () => {
    const k = await load();
    const answer = later<SaveKeysResult>();
    fake.saveKeys!.mockReturnValue(answer.promise);
    k.showSetup(status({ required: ["openai", "openrouter"] }));
    type(inputs()[0]!, ` ${OPENAI} `);
    type(inputs()[1]!, OPENROUTER);
    const other = key(inputs()[1]!, "a");
    expect(other.defaultPrevented).toBe(false);
    expect(key(inputs()[1]!, "Enter").defaultPrevented).toBe(true);
    const save = document.querySelector<HTMLButtonElement>("#setup .setup-go")!;
    expect([save.disabled, save.textContent]).toEqual([true, "Checking your keys…"]);
    expect(all("#setup .setup-field .key-msg").map((m) => m.textContent)).toEqual(["Checking with OpenAI…", "Checking with OpenRouter…"]);
    save.click();
    key(inputs()[0]!, "Enter");
    expect(fake.saveKeys).toHaveBeenCalledTimes(1);
    expect(fake.saveKeys).toHaveBeenCalledWith({ openai: OPENAI, openrouter: OPENROUTER });
    answer.resolve(saved({ saved: false, checks: { openai: { ok: true, message: "Key works" } } }));
    await flush();
    expect([save.disabled, save.textContent]).toEqual([false, "Save keys and start"]);
  });

  test("a refused key shows the server's reason; the other says it waits for it; the button comes back", async () => {
    const k = await load();
    fake.saveKeys!.mockResolvedValue(saved({
      saved: false, keys: status().keys,
      checks: { openai: { ok: false, message: "OpenAI refused this key (401)" }, openrouter: { ok: true, message: "Key works" } },
    }));
    k.showSetup(status({ required: ["openai", "openrouter"] }));
    type(inputs()[0]!, OPENAI);
    type(inputs()[1]!, OPENROUTER);
    button("Save keys and start")!.click();
    await flush();
    const msgs = all("#setup .setup-field .key-msg");
    expect([msgs[0]!.className, msgs[0]!.textContent]).toEqual(["key-msg bad", "OpenAI refused this key (401)"]);
    expect([msgs[1]!.className, msgs[1]!.textContent]).toEqual(["key-msg good", "Key works, not saved until the other key works"]);
    expect(inputs()[0]!.value).toBe(OPENAI); // nothing was saved, so nothing is cleared
    expect(button("Save keys and start")!.disabled).toBe(false);
  });

  test("saved without warnings: ✓ messages, the saved chip, then Open Tattle, and the page reloads after 1.2 s", async () => {
    const k = await load();
    const reload = stubReload();
    fake.saveKeys!.mockResolvedValue(saved({ checks: { openai: { ok: true, message: "Key works" } } }));
    k.showSetup(status());
    type(inputs()[0]!, OPENAI);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    button("Save key and start")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(text("#setup .setup-field .key-msg")).toBe("✓ Key works");
    expect(text("#setup .setup-badge")).toBe("Saved · …wxyz");
    expect([inputs()[0]!.value, inputs()[0]!.placeholder]).toEqual(["", "Paste a new key to replace …wxyz"]);
    expect(text("#setup .setup-actions .setup-go")).toBe("Open Tattle");
    expect(text("#setup .setup-actions .setup-progress")).toBe("All set. Opening Tattle…");
    expect(document.activeElement?.textContent).toBe("Open Tattle");
    await vi.advanceTimersByTimeAsync(1199);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("saved with a warning: the warning shows, nothing reloads by itself, and Open Tattle reloads", async () => {
    const k = await load();
    const reload = stubReload();
    fake.saveKeys!.mockResolvedValue(saved({ checks: { openai: { ok: true, message: "Key works", warning: "It cannot use gpt-4o-transcribe." } } }));
    k.showSetup(status());
    type(inputs()[0]!, OPENAI);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    button("Save key and start")!.click();
    await vi.advanceTimersByTimeAsync(5000);
    const msg = document.querySelector("#setup .setup-field .key-msg")!;
    expect([msg.className, msg.textContent]).toEqual(["key-msg warn", "✓ Key works It cannot use gpt-4o-transcribe."]);
    expect(text("#setup .setup-actions .setup-progress")).toBe("Saved. Read the note above, then open the app.");
    expect(reload).not.toHaveBeenCalled();
    button("Open Tattle")!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a saved key without a hint keeps its chip and placeholder", async () => {
    const k = await load();
    stubReload();
    fake.saveKeys!.mockResolvedValue(saved({ keys: [keyStatus("openai", { set: true })], checks: { openai: { ok: true, message: "Key works" } } }));
    k.showSetup(status());
    type(inputs()[0]!, OPENAI);
    button("Save key and start")!.click();
    await flush();
    expect(text("#setup .setup-badge")).toBe("✓ Looks right");
  });

  test("a network or server error shows under the button", async () => {
    const k = await load();
    fake.saveKeys!.mockRejectedValue(new Error("boom"));
    k.showSetup(status());
    type(inputs()[0]!, OPENAI);
    button("Save key and start")!.click();
    await flush();
    const general = document.querySelector("#setup .setup-actions > .key-msg")!;
    expect([general.className, general.textContent]).toEqual(["key-msg bad", "boom"]);
    fake.saveKeys!.mockRejectedValue("plain");
    button("Save key and start")!.click();
    await flush();
    expect(general.textContent).toBe("plain");
  });

  test("a check missing for a field leaves its message as it was", async () => {
    const k = await load();
    fake.saveKeys!.mockResolvedValue(saved({ saved: false, checks: {} }));
    k.showSetup(status());
    type(inputs()[0]!, OPENAI);
    button("Save key and start")!.click();
    await flush();
    expect(text("#setup .setup-field .key-msg")).toBe("Checking with OpenAI…");
  });

  // keys.ts: `GUIDES[names[0]].title` when no key is missing. The server sends configured:false only with a required
  // key missing, so this is an edge; the screen should still render (a generic title) rather than throw.
  test.fails("BUG §14.5: an unconfigured status with no missing key still shows the screen", async () => {
    const k = await load();
    expect(() => k.showSetup(status({ keys: [keyStatus("openai", { set: true }), keyStatus("openrouter")] }))).not.toThrow();
  });
});

describe("keyPrompt: a key asked for where it is needed", () => {
  test("shows the heading, the card with its guide open, Save, and Not now; focuses the field next frame", async () => {
    const k = await load();
    const onCancel = vi.fn();
    const el = k.keyPrompt("openrouter", "Please provide your OpenRouter API key to use Chat.", { onSaved: vi.fn(), onCancel });
    document.body.append(el);
    expect([el.getAttribute("role"), el.getAttribute("aria-label")]).toEqual(["group", "Please provide your OpenRouter API key to use Chat."]);
    expect(text(".key-prompt-h", el)).toBe("Please provide your OpenRouter API key to use Chat.");
    expect(el.querySelector("details.key-how")!.hasAttribute("open")).toBe(true);
    expect(text(".key-needed", el)).toBe(" Needed for fact-checking, labels, and Chat.");
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.activeElement).toBe(el.querySelector("input"));
    button("Not now", el)!.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("Save with nothing typed asks for the key; with a key, it saves, remembers the status, and calls onSaved", async () => {
    const k = await load();
    const onSaved = vi.fn();
    const el = k.keyPrompt("openrouter", "h", { onSaved });
    document.body.append(el);
    expect(button("Not now", el)).toBeUndefined();
    button("Save", el)!.click();
    await flush();
    expect(text(".key-actions .key-msg", el)).toBe("Paste the key to save it.");
    fake.saveKeys!.mockResolvedValue(saved({ checks: { openrouter: { ok: true, message: "Key works" } } }));
    type(el.querySelector("input")!, OPENROUTER);
    key(el.querySelector("input")!, "Enter");
    await flush();
    expect(fake.saveKeys).toHaveBeenCalledWith({ openrouter: OPENROUTER });
    expect([onSaved.mock.calls.length, k.keySet("openrouter"), text(".key-actions .key-msg", el)]).toEqual([1, true, ""]);
    expect(text(".key-card .key-chip", el)).toBe("Saved · …abcd");
  });

  test("a key not saved does not call onSaved; a failure shows its message; Save is re-enabled", async () => {
    const k = await load();
    const onSaved = vi.fn();
    const el = k.keyPrompt("openai", "h", { onSaved });
    document.body.append(el);
    type(el.querySelector("input")!, OPENAI);
    fake.saveKeys!.mockResolvedValue(saved({ saved: false, checks: { openai: { ok: false, message: "refused" } } }));
    button("Save", el)!.click();
    await flush();
    expect(onSaved).not.toHaveBeenCalled();
    fake.saveKeys!.mockRejectedValue(new Error("offline"));
    button("Save", el)!.click();
    await flush();
    expect(text(".key-actions .key-msg", el)).toBe("offline");
    expect(button("Save", el)!.disabled).toBe(false);
    fake.saveKeys!.mockRejectedValue("odd");
    button("Save", el)!.click();
    await flush();
    expect(text(".key-actions .key-msg", el)).toBe("odd");
  });

  test("a second Save while the first is checking is ignored", async () => {
    const k = await load();
    const answer = later<SaveKeysResult>();
    fake.saveKeys!.mockReturnValue(answer.promise);
    const el = k.keyPrompt("openai", "h", { onSaved: vi.fn() });
    document.body.append(el);
    type(el.querySelector("input")!, OPENAI);
    button("Save", el)!.click();
    button("Save", el)!.click();
    expect(fake.saveKeys).toHaveBeenCalledTimes(1);
    answer.resolve(saved({ saved: false }));
    await flush();
  });

  test("a key set in the environment shows no field and no Save", async () => {
    const k = await load();
    fake.setup!.mockResolvedValue(status({ keys: [keyStatus("openai"), keyStatus("openrouter", { set: true, source: "environment", hint: "9999" })] }));
    await k.setupStatus();
    const el = k.keyPrompt("openrouter", "h", { onSaved: vi.fn() });
    expect(el.querySelector("input")).toBeNull();
    expect(button("Save", el)).toBeUndefined();
    expect(text(".key-chip", el)).toBe(".env · …9999");
    expect(text(".key-card .note", el)).toBe("Set by OPENROUTER_API_KEY in .env or your shell, which wins over this page: change it there.");
  });

  // keys.ts: the guides' links are single <a> nodes made once at import, and each render of the steps appends the same
  // nodes, so a second card showing at the same time takes them from the first (inventory 4 §14.4).
  test.fails("BUG §14.4: two cards shown at once each keep their guide's links", async () => {
    const k = await load();
    const a = k.keyPrompt("openrouter", "a", { onSaved: vi.fn() });
    const b = k.keyPrompt("openrouter", "b", { onSaved: vi.fn() });
    expect([a.querySelectorAll(".key-steps a").length, b.querySelectorAll(".key-steps a").length]).toEqual([3, 3]);
  });
});

describe("the API keys window", () => {
  test("without #keys nothing happens", async () => {
    const k = await load();
    document.getElementById("keys")!.remove();
    await k.renderKeys(vi.fn());
    expect(fake.setup).not.toHaveBeenCalled();
  });

  test("a server that cannot manage keys says so", async () => {
    const k = await load();
    fake.setup!.mockRejectedValue(new Error("404"));
    await k.renderKeys(vi.fn());
    expect(text("#keys")).toBe("This server cannot manage keys: restart it with npm run serve.");
  });

  test("shows both cards, each with its chip or placeholder, when it is needed, and the file", async () => {
    const k = await load();
    fake.setup!.mockResolvedValue(status({ configured: true, keys: [keyStatus("openai", { set: true, source: "file", hint: "1234" }), keyStatus("openrouter")] }));
    await k.renderKeys(vi.fn());
    expect(all("#keys .key-card h2").map((h) => h.textContent)).toEqual(["OpenAI", "OpenRouter"]);
    expect(all("#keys .key-chip").map((c) => c.textContent)).toEqual(["Saved · …1234", ""]);
    expect((all("#keys input") as HTMLInputElement[]).map((i) => i.placeholder)).toEqual(["Paste a new key to replace …1234", "sk-or-v1-…"]);
    expect(all("#keys .key-needed").map((n) => n.textContent)).toEqual([" Needed only for OpenAI transcription.", " Needed for fact-checking, labels, and Chat."]);
    expect(all("#keys details.key-how").map((d) => d.hasAttribute("open"))).toEqual([false, false]);
    expect(text("#keys > .note")).toBe("Neither key is needed to open the app. Saved keys are in ~/Library/Application Support/Tattle/credentials.json, readable only by your macOS user.");
  });

  test("a key from the environment has no field; with both from it, there is nothing to save", async () => {
    const k = await load();
    const env = (n: "openai" | "openrouter") => keyStatus(n, { set: true, source: "environment", hint: "1234" });
    fake.setup!.mockResolvedValue(status({ keys: [env("openai"), keyStatus("openrouter")] }));
    await k.renderKeys(vi.fn());
    expect(all("#keys .key-chip")[0]!.textContent).toBe(".env · …1234");
    expect(all("#keys input")).toHaveLength(1);
    expect(document.querySelector<HTMLElement>("#keys .key-actions")!.hidden).toBe(false);
    fake.setup!.mockResolvedValue(status({ keys: [env("openai"), env("openrouter")] }));
    await k.renderKeys(vi.fn());
    expect(document.querySelector<HTMLElement>("#keys .key-actions")!.hidden).toBe(true);
  });

  test("Save with nothing typed asks for a key; it sends only the keys typed, and says the next call uses it", async () => {
    const k = await load();
    const onSaved = vi.fn();
    fake.setup!.mockResolvedValue(status({ configured: true }));
    await k.renderKeys(onSaved);
    button("Save", document.getElementById("keys")!)!.click();
    await flush();
    expect(text("#keys .key-actions .key-msg")).toBe("Paste a key to save.");
    expect(fake.saveKeys).not.toHaveBeenCalled();
    fake.saveKeys!.mockResolvedValue(saved({ checks: { openrouter: { ok: true, message: "Key works" } } }));
    type(all("#keys input")[1] as HTMLInputElement, OPENROUTER);
    button("Save", document.getElementById("keys")!)!.click();
    await flush();
    expect(fake.saveKeys).toHaveBeenCalledWith({ openrouter: OPENROUTER });
    expect(onSaved).toHaveBeenCalledWith("API key saved: the next call uses it");
  });

  test("a refused key does not say saved; a failure shows its message; Save comes back; a second Save meanwhile is ignored", async () => {
    const k = await load();
    const onSaved = vi.fn();
    fake.setup!.mockResolvedValue(status({ configured: true }));
    await k.renderKeys(onSaved);
    type(all("#keys input")[0] as HTMLInputElement, OPENAI);
    fake.saveKeys!.mockResolvedValue(saved({ saved: false, checks: { openai: { ok: false, message: "OpenAI refused this key (401)" } } }));
    button("Save", document.getElementById("keys")!)!.click();
    await flush();
    expect(onSaved).not.toHaveBeenCalled();
    expect(text("#keys .key-card .key-msg")).toBe("OpenAI refused this key (401)");
    const answer = later<SaveKeysResult>();
    fake.saveKeys!.mockReturnValue(answer.promise);
    const save = button("Save", document.getElementById("keys")!)!;
    save.click();
    save.click();
    expect(fake.saveKeys).toHaveBeenCalledTimes(2);
    answer.reject(new Error("offline"));
    await flush();
    expect([text("#keys .key-actions .key-msg"), save.disabled]).toEqual(["offline", false]);
    fake.saveKeys!.mockRejectedValue("odd");
    save.click();
    await flush();
    expect(text("#keys .key-actions .key-msg")).toBe("odd");
  });
});

describe("the Transcription window", () => {
  const radios = () => all("#transcription .engine-choice") as HTMLButtonElement[];

  test("without #transcription nothing happens; a server with no engine setting says so", async () => {
    const k = await load();
    const box = document.getElementById("transcription")!;
    box.remove();
    await k.renderTranscription(vi.fn());
    expect(fake.transcription).not.toHaveBeenCalled();
    document.body.append(box);
    fake.transcription!.mockRejectedValue(new Error("404"));
    await k.renderTranscription(vi.fn());
    expect(text("#transcription")).toBe("This server has no transcription setting: restart it with npm run serve.");
  });

  test("shows both engines, the chosen one checked, and Apple's model state under it", async () => {
    const k = await load();
    fake.transcription!.mockResolvedValue(trans());
    fake.setup!.mockResolvedValue(status({ configured: true }));
    await k.renderTranscription(vi.fn());
    expect(radios().map((r) => [r.getAttribute("aria-checked"), r.disabled])).toEqual([["true", false], ["false", false]]);
    expect(text("#transcription .engine-state")).toBe("Ready");
    expect(text("#transcription > .note:last-child")).toBe("The engine is chosen for the next session; a session keeps the one it started with.");
    expect(all("#transcription .engine-onair")).toHaveLength(0);
  });

  test.each([
    [{ model: "missing" }, "Getting ready…"],
    [{ model: "installing", fraction: 0.456 }, "Getting on-device speech recognition ready… 46 %"],
    [{ model: "installing", fraction: null }, "Getting on-device speech recognition ready… 0 %"],
    [{ model: "error", error: "no disk space" }, "no disk space Try again"],
    [{ model: "error", error: null }, "Could not get ready Try again"],
  ] as const)("Apple's model %j reads %j", async (apple, line) => {
    const k = await load();
    fake.transcription!.mockResolvedValue(trans({}, apple as never));
    await k.renderTranscription(vi.fn());
    expect(text("#transcription .engine-state")).toBe(line);
  });

  test("Try again installs the model and redraws; a failed install is quiet", async () => {
    const k = await load();
    fake.transcription!.mockResolvedValue(trans({}, { model: "error", error: "x" }));
    fake.installModel!.mockResolvedValue(trans({}, { model: "installing", fraction: 0.1 }));
    await k.renderTranscription(vi.fn());
    fake.transcription!.mockResolvedValue(trans({}, { model: "installing", fraction: 0.1 }));
    button("Try again")!.click();
    await flush();
    expect(fake.installModel).toHaveBeenCalledTimes(1);
    expect(text("#transcription .engine-state")).toBe("Getting on-device speech recognition ready… 10 %");
    fake.transcription!.mockResolvedValue(trans({}, { model: "error", error: "x" }));
    await k.renderTranscription(vi.fn());
    fake.installModel!.mockRejectedValue(new Error("no"));
    button("Try again")!.click();
    await flush();
    expect(text("#transcription .engine-state")).toBe("x Try again");
  });

  test("Apple unavailable is disabled with the reason, or a default one", async () => {
    let k = await load();
    fake.transcription!.mockResolvedValue(trans({ engine: "openai" }, { available: false, reason: "Needs macOS 26 or later." }));
    await k.renderTranscription(vi.fn());
    expect(radios()[0]!.disabled).toBe(true);
    expect(text("#transcription .engine-why")).toBe("Needs macOS 26 or later.");
    expect(all("#transcription .engine-state")).toHaveLength(0);
    k = await load();
    fake.transcription!.mockResolvedValue(trans({ engine: "openai" }, { available: false, reason: null }));
    await k.renderTranscription(vi.fn());
    expect(text("#transcription .engine-why")).toBe("Not available on this Mac");
  });

  test("choosing the other engine saves it, says so, and redraws; choosing the current one does nothing", async () => {
    const k = await load();
    const onSaved = vi.fn();
    fake.transcription!.mockResolvedValue(trans({ engine: "openai" }));
    fake.setup!.mockResolvedValue(status({ configured: true, keys: [keyStatus("openai", { set: true }), keyStatus("openrouter")] }));
    fake.setTranscription!.mockResolvedValue(trans({ engine: "apple" }));
    await k.renderTranscription(onSaved);
    radios()[1]!.click();
    await flush();
    expect(fake.setTranscription).not.toHaveBeenCalled();
    fake.transcription!.mockResolvedValue(trans({ engine: "apple" }));
    radios()[0]!.click();
    await flush();
    expect(fake.setTranscription).toHaveBeenCalledWith("apple");
    expect(onSaved).toHaveBeenCalledWith("Transcription: on this Mac");
    expect(k.transcriptionState()?.engine).toBe("apple");
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
    fake.setTranscription!.mockResolvedValue(trans({ engine: "openai" }));
    radios()[1]!.click();
    await flush();
    expect(onSaved).toHaveBeenLastCalledWith("Transcription: OpenAI");
  });

  test("choosing OpenAI without its key asks for the key first: Not now clears it, a saved key chooses OpenAI", async () => {
    const k = await load();
    const onSaved = vi.fn();
    fake.transcription!.mockResolvedValue(trans());
    fake.setup!.mockResolvedValue(status({ configured: true }));
    await k.renderTranscription(onSaved);
    radios()[1]!.click();
    await flush();
    expect(fake.setTranscription).not.toHaveBeenCalled();
    expect(text("#transcription .key-prompt-h")).toBe("Transcribing with OpenAI needs your OpenAI API key.");
    button("Not now")!.click();
    expect(all("#transcription .key-prompt")).toHaveLength(0);
    radios()[1]!.click();
    await flush();
    fake.saveKeys!.mockResolvedValue(saved({ checks: { openai: { ok: true, message: "Key works" } } }));
    fake.setTranscription!.mockResolvedValue(trans({ engine: "openai" }));
    type(document.querySelector<HTMLInputElement>("#transcription .key-prompt input")!, OPENAI);
    button("Save", document.querySelector("#transcription .key-prompt")!)!.click();
    await flush();
    expect(fake.setTranscription).toHaveBeenCalledWith("openai");
    expect(onSaved).toHaveBeenCalledWith("Transcription: OpenAI");
  });

  test("a failed change shows its message", async () => {
    const k = await load();
    fake.transcription!.mockResolvedValue(trans({ engine: "openai" }));
    fake.setTranscription!.mockRejectedValue(new Error("the model is not installed"));
    await k.renderTranscription(vi.fn());
    radios()[0]!.click();
    await flush();
    const msg = document.querySelector("#transcription > .key-msg")!;
    expect([msg.className, msg.textContent]).toEqual(["key-msg bad", "the model is not installed"]);
    fake.setTranscription!.mockRejectedValue("odd");
    radios()[0]!.click();
    await flush();
    expect(msg.textContent).toBe("odd");
  });

  test("on air the window is read-only, and it redraws when the session starts or ends while open", async () => {
    const k = await load();
    fake.transcription!.mockResolvedValue(trans({ engine: "openai" }));
    k.setOnAir(true);
    expect(fake.transcription).not.toHaveBeenCalled(); // the window is closed
    await k.renderTranscription(vi.fn());
    expect(text("#transcription .engine-onair")).toBe("A session is on air: the engine can be changed when it ends.");
    expect(radios().every((r) => r.disabled)).toBe(true);
    radios()[0]!.dispatchEvent(new MouseEvent("click")); // a disabled button still gets a synthetic click here
    await flush();
    expect(fake.setTranscription).not.toHaveBeenCalled();
    k.setOnAir(true); // unchanged: nothing redrawn
    document.querySelector<HTMLDialogElement>("#dlg-transcription")!.showModal();
    const calls = fake.transcription!.mock.calls.length;
    k.setOnAir(false);
    await flush();
    expect(fake.transcription!.mock.calls.length).toBe(calls + 1);
    expect(all("#transcription .engine-onair")).toHaveLength(0);
  });
});
