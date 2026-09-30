// Helpers for the DOM tests of the page's core modules (keys, chat, calls, transfer, ui, app, main). The shared ones are
// in helpers.ts; see docs/testing.md § Web DOM tests.
import { vi } from "vitest";
import { installBrowserStubs, loadIndexHtml, makeFakeApi } from "./helpers.ts";

export type Fn = ReturnType<typeof vi.fn>;
export type FakeApi = Record<string, Fn>;

type RealApi = typeof import("../../web/src/api.ts")["api"];

/** Refills the hoisted fake api (see makeFakeApi) with fresh `vi.fn`s, each overridable. */
export async function resetApi(fake: FakeApi, overrides: Partial<Record<keyof RealApi, (...a: any[]) => unknown>> = {}): Promise<FakeApi> {
  const real = (await vi.importActual<typeof import("../../web/src/api.ts")>("../../web/src/api.ts")).api;
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, makeFakeApi(real, overrides));
  return fake;
}

// The page modules add listeners to document and window, and observers on the body, that outlive a test (the document
// is shared by a file's tests). They are recorded here and removed by the next freshPage, so an earlier test's module
// instance never reacts to a later test's events.
const listeners: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
const observers: MutationObserver[] = [];
let tracking = false;
function track() {
  if (tracking) return;
  tracking = true;
  for (const target of [document, window] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      listeners.push([target, type, fn, opts]);
      add(type, fn, opts as AddEventListenerOptions);
    }) as typeof target.addEventListener;
  }
}
function untrack() {
  for (const [target, type, fn, opts] of listeners.splice(0)) {
    target.removeEventListener(type, fn, typeof opts === "boolean" ? opts : (opts as AddEventListenerOptions | undefined)?.capture);
  }
  for (const o of observers.splice(0)) o.disconnect();
}
const Native = globalThis.MutationObserver;
class TrackedObserver extends Native {
  constructor(cb: MutationCallback) { super(cb); observers.push(this); }
}

/**
 * A fresh page: new module instances (module-level state starts over), the page's markup, the browser shims, a clean URL
 * and storage, and `window.desktop` set (the Mac app) or not (a browser) before any page module is imported.
 */
export function freshPage(opts: { desktop?: unknown; url?: string } = {}) {
  vi.resetModules();
  vi.unstubAllGlobals();
  track();
  untrack();
  vi.stubGlobal("MutationObserver", TrackedObserver);
  document.body.innerHTML = "";
  document.body.className = "";
  loadIndexHtml();
  const stubs = installBrowserStubs();
  history.replaceState(null, "", opts.url ?? "/");
  try { localStorage.clear(); } catch { /* none */ }
  if (opts.desktop) (globalThis as { desktop?: unknown }).desktop = opts.desktop;
  else delete (globalThis as { desktop?: unknown }).desktop;
  return stubs;
}

/** Dispatches a keydown (bubbling, cancelable) on `el`; returns the event. */
export function key(el: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

/** Types `value` into an input or textarea, as the user would (an input event after it). */
export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export const text = (sel: string, root: ParentNode = document): string => root.querySelector(sel)?.textContent ?? "";
export const all = (sel: string, root: ParentNode = document): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(sel)];
/** The texts of the toasts shown so far. */
export const toasts = (): string[] => all("#toasts .toast").map((t) => t.textContent ?? "");
/** The first button whose text is `label`. */
export const button = (label: string | RegExp, root: ParentNode = document): HTMLButtonElement | undefined =>
  all("button", root).find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;

/** A promise the test resolves or rejects later. */
export function later<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/** Replaces `location.reload` with a spy (happy-dom would navigate). */
export function stubReload(): Fn {
  const reload = vi.fn();
  Object.defineProperty(window.location, "reload", { configurable: true, value: reload });
  return reload;
}
