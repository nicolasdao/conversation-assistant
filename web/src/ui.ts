// Bespoke replacements for the browser's own widgets, so every control has the page's look:
//
// - Dropdowns: every <select> on the page is upgraded in place into a styled button and listbox. The native select
//   stays in the DOM, hidden, as the source of truth: code keeps reading and setting `.value`, replacing <option>s, and
//   listening for `change`, and the bespoke control follows it.
// - Tooltips: `title` attributes show as styled tooltips instead of the browser's own.
// - Text fields: the browser's autofill dropdown is turned off.
//
// Lists and tooltips are top-layer popovers, so they show above modal dialogs too.
import { h } from "./dom.js";

const valueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!;
const indexProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex")!;

let listSeq = 0;
/** The one dropdown list open at a time. */
let openList: { close: () => void } | null = null;

function upgradeSelect(sel: HTMLSelectElement) {
  if (sel.dataset.bespoke) return;
  sel.dataset.bespoke = "1";
  const wrap = h("span", { class: `sel ${sel.className}` });
  const label = h("span", { class: "sel-label" });
  const btn = h("button", { type: "button", class: "sel-btn", role: "combobox", "aria-haspopup": "listbox", "aria-expanded": "false" }, label);
  const title = sel.getAttribute("title");
  if (title) { wrap.setAttribute("title", title); sel.removeAttribute("title"); }
  sel.replaceWith(wrap);
  wrap.append(sel, btn);
  sel.hidden = true;
  sel.tabIndex = -1;
  const name = () => sel.getAttribute("aria-label") ?? sel.labels?.[0]?.textContent?.trim() ?? "";
  for (const l of sel.labels ?? []) l.addEventListener("click", (e) => { e.preventDefault(); btn.focus(); });

  const refresh = () => {
    const o = sel.options[sel.selectedIndex];
    label.textContent = o?.textContent ?? "";
    btn.disabled = sel.disabled;
    btn.setAttribute("aria-label", `${name()}${o ? `: ${o.textContent}` : ""}`);
  };
  // code that sets .value or .selectedIndex, or edits the options, shows at once
  Object.defineProperty(sel, "value", { configurable: true, get: () => valueProp.get!.call(sel), set: (v) => { valueProp.set!.call(sel, v); refresh(); } });
  Object.defineProperty(sel, "selectedIndex", { configurable: true, get: () => indexProp.get!.call(sel), set: (v) => { indexProp.set!.call(sel, v); refresh(); } });
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "selected", "label"] });
  refresh();

  let list: HTMLElement | null = null;
  let active = -1;
  const choices = () => [...sel.options].filter((o) => !o.hidden);

  const choose = (o: HTMLOptionElement) => {
    const changed = o.value !== sel.value;
    valueProp.set!.call(sel, o.value);
    refresh();
    close();
    btn.focus();
    if (changed) {
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const highlight = (i: number) => {
    const opts = choices();
    if (!list || !opts.length) return;
    active = Math.max(0, Math.min(opts.length - 1, i));
    list.querySelectorAll(".sel-opt").forEach((el, k) => el.classList.toggle("active", k === active));
    const el = list.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
    if (el) btn.setAttribute("aria-activedescendant", el.id);
  };

  function close() {
    if (!list) return;
    list.remove();
    list = null;
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-activedescendant");
    wrap.classList.remove("open");
    if (openList?.close === close) openList = null;
  }

  const open = () => {
    if (list || sel.disabled) return;
    openList?.close();
    const id = `sel-list-${++listSeq}`;
    const opts = choices();
    list = h("div", { id, class: "sel-list", role: "listbox", popover: "manual", "aria-label": name() },
      opts.map((o, k) => h("div", {
        id: `${id}-${k}`, class: `sel-opt${o.selected ? " selected" : ""}${o.disabled ? " disabled" : ""}`, role: "option",
        "aria-selected": String(o.selected), "aria-disabled": o.disabled ? "true" : null,
        onpointerdown: (e: Event) => e.preventDefault(), // keep focus on the button
        onclick: () => { if (!o.disabled) choose(o); },
        onpointermove: () => highlight(k),
      }, o.textContent ?? "")));
    // Inside an open modal dialog the list must live in the dialog: a modal makes everything outside it inert, so a list
    // appended to <body> shows on top but ignores every click (27 September 2026: the microphone could not be chosen).
    (wrap.closest("dialog[open]") ?? document.body).append(list);
    list.showPopover();
    place(list, wrap);
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", id);
    wrap.classList.add("open");
    openList = { close };
    highlight(Math.max(0, opts.findIndex((o) => o.selected)));
  };

  let typed = "";
  let typedAt = 0;
  btn.addEventListener("click", () => (list ? close() : open()));
  btn.addEventListener("keydown", (e) => {
    const opts = choices();
    if (!list) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); e.stopPropagation(); open(); }
      return;
    }
    e.stopPropagation(); // Space and Escape mean "this list", not play/pause or closing the dialog
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); }
    else if (e.key === "Home" || e.key === "PageUp") { e.preventDefault(); highlight(0); }
    else if (e.key === "End" || e.key === "PageDown") { e.preventDefault(); highlight(opts.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const o = opts[active]; if (o && !o.disabled) choose(o); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") close();
    else if (e.key.length === 1) {
      // type to jump to an option
      typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = Date.now();
      const k = opts.findIndex((o) => (o.textContent ?? "").toLowerCase().startsWith(typed));
      if (k >= 0) highlight(k);
    }
  });
  btn.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== btn) close(); }, 0));
}

/** Places a popover under `anchor` (or above it when there is no room below), within the window. */
export function place(pop: HTMLElement, anchor: Element, gap = 4) {
  const r = anchor.getBoundingClientRect();
  pop.style.minWidth = `${Math.round(r.width)}px`;
  const room = window.innerHeight - r.bottom - 12;
  const ph = Math.min(pop.scrollHeight, 320);
  const above = room < ph && r.top > room;
  pop.style.maxHeight = `${Math.max(120, Math.min(320, above ? r.top - 12 : room))}px`;
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  pop.style.top = above ? `${Math.max(8, r.top - gap - Math.min(ph, r.top - 12))}px` : `${r.bottom + gap}px`;
}

function bindTooltips() {
  const tip = h("div", { class: "tip", role: "tooltip", popover: "manual" });
  document.body.append(tip);
  let target: Element | null = null;
  let timer = 0;
  /** Moves `title` to `data-tip`, so the browser's own tooltip never shows; code may set `title` again later. */
  const take = (el: Element): string => {
    const t = el.getAttribute("title");
    if (t !== null) {
      el.removeAttribute("title");
      if (t) { el.setAttribute("data-tip", t); el.setAttribute("aria-description", t); }
      else el.removeAttribute("data-tip");
    }
    return el.getAttribute("data-tip") ?? "";
  };
  const hide = () => {
    clearTimeout(timer);
    target = null;
    if (tip.matches(":popover-open")) tip.hidePopover();
  };
  const show = (el: Element, delay: number) => {
    const text = take(el);
    if (!text) return;
    clearTimeout(timer);
    target = el;
    timer = window.setTimeout(() => {
      if (target !== el || !el.isConnected) return;
      tip.textContent = text;
      if (tip.matches(":popover-open")) tip.hidePopover();
      tip.showPopover(); // again, so it stacks above a dialog opened since
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth, ht = tip.offsetHeight;
      const below = r.top - ht - 8 < 4;
      tip.style.left = `${Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6))}px`;
      tip.style.top = `${below ? r.bottom + 8 : r.top - ht - 8}px`;
      tip.classList.toggle("below", below);
    }, delay);
  };
  document.addEventListener("pointerover", (e) => {
    const el = (e.target as Element).closest?.("[title], [data-tip]");
    if (el === target) return;
    hide();
    if (el) show(el, 450);
  });
  document.addEventListener("pointerout", (e) => {
    if (target && !target.contains(e.relatedTarget as Node)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target as Element;
    if (el.matches?.(":focus-visible")) {
      const t = el.closest("[title], [data-tip]");
      if (t) show(t, 250);
    }
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("scroll", hide, true);
}

function upgradeTree(n: Node) {
  if (!(n instanceof Element)) return;
  const each = <T extends Element>(sel: string, fn: (el: T) => void) => {
    if (n.matches(sel)) fn(n as T);
    n.querySelectorAll<T>(sel).forEach(fn);
  };
  each<HTMLSelectElement>("select", upgradeSelect);
  each<HTMLInputElement>("input:not([autocomplete]), textarea:not([autocomplete])", (el) => el.setAttribute("autocomplete", "off"));
}

export function bindBespoke() {
  upgradeTree(document.body);
  new MutationObserver((muts) => { for (const m of muts) m.addedNodes.forEach(upgradeTree); }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element;
    if (openList && !t.closest?.(".sel-list, .sel")) openList.close();
  });
  const closeList = (e: Event) => { if (openList && !(e.target as Element).closest?.(".sel-list")) openList.close(); };
  window.addEventListener("resize", () => openList?.close());
  document.addEventListener("scroll", closeList, true);
  bindTooltips();
}
