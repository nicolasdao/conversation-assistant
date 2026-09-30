// Helpers for web DOM tests (happy-dom). See docs/testing.md § Web DOM tests.
import { readFileSync } from "node:fs";
import { vi } from "vitest";

/** Puts web/index.html's body (without its scripts) into the document, so every id the page code queries exists. */
export function loadIndexHtml(file = "web/index.html"): void {
  const html = readFileSync(file, "utf8");
  const body = /<body([^>]*)>([\s\S]*)<\/body>/i.exec(html);
  if (!body) throw new Error(`${file} has no <body>`);
  document.body.innerHTML = body[2].replace(/<script\b[\s\S]*?<\/script>/gi, "");
  document.body.className = "";
}

export const loadLicensesHtml = (): void => loadIndexHtml("web/licenses.html");

/** Lets pending promise callbacks and zero-delay timers run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 2; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Sets layout properties that are always 0 in happy-dom. */
export function layout(el: Element, m: { clientWidth?: number; clientHeight?: number; scrollWidth?: number; scrollHeight?: number; offsetHeight?: number; rect?: Partial<DOMRect> }): void {
  for (const k of ["clientWidth", "clientHeight", "scrollWidth", "scrollHeight", "offsetHeight"] as const) {
    if (m[k] !== undefined) Object.defineProperty(el, k, { value: m[k], configurable: true });
  }
  if (m.rect) {
    const r = { x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, ...m.rect };
    el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect;
  }
}

/** An `EventSource` the test drives: `open()`, `emit(type, data)`, `fail()`. */
export class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  open(): void {
    this.readyState = 1;
    const e = new Event("open");
    this.onopen?.(e);
    this.dispatchEvent(e);
  }
  /** A named event (as the engine sends them), or a plain message when `type` is "message". */
  emit(type: string, data: unknown): void {
    const e = new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) });
    if (type === "message") this.onmessage?.(e);
    this.dispatchEvent(e);
  }
  fail(closed = false): void {
    this.readyState = closed ? 2 : 0;
    const e = new Event("error");
    this.onerror?.(e);
    this.dispatchEvent(e);
  }
  close(): void { this.readyState = 2; }
}

/** An `<audio>` stand-in with the media behaviour the player needs. */
export class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  src = "";
  preload = "";
  preservesPitch = true;
  playbackRate = 1;
  currentTime = 0;
  duration = NaN;
  volume = 1;
  paused = true;
  readyState = 0;
  failPlay: Error | null = null;
  constructor(src?: string) {
    super();
    if (src) this.src = src;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    if (this.failPlay) return Promise.reject(this.failPlay);
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  load(): void {}
  removeAttribute(name: string): void { if (name === "src") this.src = ""; }
  loadMetadata(duration = 60): void {
    this.readyState = 1;
    this.duration = duration;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  end(): void {
    this.paused = true;
    this.dispatchEvent(new Event("ended"));
  }
}

/** Web Audio's `AudioContext`, as far as the volume boost uses it. */
export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static throwOnNew: Error | null = null;
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor() {
    if (FakeAudioContext.throwOnNew) throw FakeAudioContext.throwOnNew;
    FakeAudioContext.instances.push(this);
  }
  createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n, disconnect: () => {}, context: this }; }
  createMediaElementSource(_a: unknown) { return { connect: (n: unknown) => n, disconnect: () => {} }; }
}

const popoverOpen = new WeakSet<Element>();
let nativeMatches: ((this: Element, sel: string) => boolean) | null = null;

/**
 * Adds what happy-dom 20 lacks (probed in tests/web/probe.test.ts): the Popover API with `:popover-open`,
 * `EventSource`, `AudioContext`, and a recording `window.open`; replaces `Audio` with `FakeAudio`, and makes
 * `scrollIntoView` a spy. Call it before importing a page module.
 */
export function installBrowserStubs(): { open: ReturnType<typeof vi.fn> } {
  const proto = HTMLElement.prototype as HTMLElement & { showPopover(): void; hidePopover(): void; togglePopover(force?: boolean): boolean };
  proto.showPopover = function (this: HTMLElement) { popoverOpen.add(this); };
  proto.hidePopover = function (this: HTMLElement) { popoverOpen.delete(this); };
  proto.togglePopover = function (this: HTMLElement, force?: boolean) {
    const on = force ?? !popoverOpen.has(this);
    if (on) popoverOpen.add(this); else popoverOpen.delete(this);
    return on;
  };
  if (!nativeMatches) {
    nativeMatches = Element.prototype.matches;
    Element.prototype.matches = function (this: Element, sel: string) {
      if (sel.trim() === ":popover-open") return popoverOpen.has(this);
      return nativeMatches!.call(this, sel);
    } as typeof Element.prototype.matches;
  }
  Element.prototype.scrollIntoView = vi.fn();
  const open = vi.fn(() => null);
  FakeEventSource.instances = [];
  FakeAudio.instances = [];
  FakeAudioContext.instances = [];
  FakeAudioContext.throwOnNew = null;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("open", open);
  return { open };
}

/**
 * A stand-in for `api` in web/src/api.ts: a `vi.fn` per member of the real object, resolving to `undefined` unless
 * overridden (`labelSetExportUrl`, which is synchronous, keeps its real behaviour). Use with `vi.mock`, keeping
 * `ApiError` real:
 *
 *   const fake = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
 *   vi.mock("../../web/src/api.ts", async (orig) => ({ ...(await orig()), api: fake }));
 *   beforeEach(async () => Object.assign(fake, makeFakeApi((await vi.importActual<typeof import("../../web/src/api.ts")>("../../web/src/api.ts")).api)));
 */
export function makeFakeApi<T extends Record<string, unknown>>(real: T, overrides: Partial<Record<keyof T, (...a: any[]) => unknown>> = {}): Record<keyof T, ReturnType<typeof vi.fn>> {
  const f = {} as Record<keyof T, ReturnType<typeof vi.fn>>;
  for (const k of Object.keys(real) as (keyof T)[]) f[k] = vi.fn(async () => undefined);
  if (typeof real.labelSetExportUrl === "function") f["labelSetExportUrl" as keyof T] = vi.fn(real.labelSetExportUrl as (...a: any[]) => unknown);
  for (const [k, fn] of Object.entries(overrides)) f[k as keyof T] = vi.fn(fn as (...a: any[]) => unknown);
  return f;
}

type StateModule = typeof import("../../web/src/state.ts");

/**
 * Builds a page state the way the page does: a snapshot (`fromSnapshot`) then events through the real reducer
 * (`applyEvent`), so fixtures look like the engine's SSE stream. Each event is `[type, data]` or `[type, data, at]`.
 */
export function feed(state: StateModule, events: ([string, any] | [string, any, string])[], snapshot?: any): ReturnType<StateModule["emptyState"]> {
  const s = snapshot ? state.fromSnapshot(snapshot) : state.emptyState();
  const dirty: Parameters<StateModule["applyEvent"]>[4] = new Set();
  for (const [type, data, at] of events) state.applyEvent(s, type, data, at ?? "2026-09-30T10:00:00.000Z", dirty);
  return s;
}
