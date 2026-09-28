// The Licenses and Acknowledgements window (web/licenses.html, see docs/desktop.md#licenses): the app's own license,
// then every third-party component from GET /api/licenses, each with its notice and the full texts it points to.
import { api, type Licenses } from "./api.js";
import { $, h, replace } from "./dom.js";
import { desktop } from "./desktop.js";
import { renderMarkdown } from "./markdown.js";

interface Item { group: string; title: string; license: string; text: string; render: () => Node[] }

/** Full texts longer than this start folded: ONNX Runtime's own third-party notices are 338 KB. */
const FOLD_OVER = 60_000;

/** Bare URLs become links (the renderer links only [text](url)); code blocks and trailing punctuation are left alone. */
function linkify(md: string): string {
  return md.split(/(```[\s\S]*?```)/).map((part, i) => (i % 2 ? part : part.replace(/(?<!\]\()\bhttps?:\/\/[^\s)`]+/g, (u) => {
    const url = u.replace(/[.,;:]+$/, "");
    return `[${url}](${url})${u.slice(url.length)}`;
  }))).join("");
}

function fullText(name: string, text: string): HTMLElement {
  return h("details", { class: "lic-file", open: text.length <= FOLD_OVER },
    h("summary", {}, `Full text · ${name.split("/").pop()}`),
    h("pre", { class: "license-text" }, text));
}

function items(l: Licenses): Item[] {
  const own: Item = {
    group: "Conversation Assistant", title: "This app", license: l.app.license ?? "", text: l.app.text,
    render: () => [
      h("p", { class: "lic-meta" }, `${l.app.name} ${l.app.version}${l.app.holder ? ` · ${l.app.holder.replace(/\s*<[^>]*>/, "")}` : ""}`),
      h("pre", { class: "license-text" }, l.app.text || "No LICENSE file."),
    ],
  };
  return [own, ...l.groups.flatMap((g) => g.components.map((c): Item => ({
    group: g.title.replace(/^Components built into the app$/, "Built into the app").replace(/^npm packages in the app$/, "npm packages"),
    title: c.title.replace(/`/g, ""), license: c.license, text: c.body,
    render: () => [renderMarkdown(linkify(c.body)), ...c.files.map((f) => fullText(f, l.texts[f]!))],
  })))];
}

let all: Item[] = [];
let shown: Item[] = [];
let current: Item | null = null;

function select(item: Item, focus = false) {
  current = item;
  replace($("#lic-detail"),
    h("header", { class: "lic-head" }, h("h1", {}, item.title), item.license ? h("span", { class: "lic-chip" }, item.license) : ""),
    ...item.render());
  $("#lic-detail")!.scrollTop = 0;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#lic-list .lic-item")) {
    const on = b.dataset.index === String(all.indexOf(item));
    b.setAttribute("aria-selected", String(on));
    if (on && focus) { b.focus(); b.scrollIntoView({ block: "nearest" }); }
  }
}

function renderList() {
  const q = $<HTMLInputElement>("#lic-search")!.value.trim().toLowerCase();
  shown = q ? all.filter((i) => `${i.title}\n${i.license}\n${i.text}`.toLowerCase().includes(q)) : all;
  const rows: Node[] = [];
  let group = "";
  for (const item of shown) {
    if (item.group !== group) { group = item.group; rows.push(h("div", { class: "lic-group" }, group)); }
    rows.push(h("button", {
      class: "lic-item", role: "option", "data-index": String(all.indexOf(item)), "aria-selected": String(item === current),
      onclick: () => select(item),
    }, h("span", { class: "lic-title" }, item.title), h("span", { class: "lic-lic" }, item.license)));
  }
  replace($("#lic-list"), ...(rows.length ? rows : [h("p", { class: "empty" }, "Nothing matches.")]));
  if (shown.length && (!current || !shown.includes(current))) select(shown[0]!);
}

// ↑ and ↓ move through the list, from the search field too
document.addEventListener("keydown", (e) => {
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || !current || !shown.length) return;
  const i = shown.indexOf(current);
  const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]!;
  e.preventDefault();
  if (next !== current) select(next, true);
});

$("#lic-search")!.addEventListener("input", renderList);
if (desktop) {
  $("#lic-desktop")!.hidden = false;
  $("#lic-chromium")!.addEventListener("click", () => desktop!.run("open-chromium-licenses"));
  $("#lic-finder")!.addEventListener("click", () => desktop!.run("show-license-files"));
}

try {
  all = items(await api.licenses());
  renderList();
} catch (e) {
  replace($("#lic-detail"), h("p", { class: "error-text" }, `The licenses could not be loaded: ${e instanceof Error ? e.message : String(e)}`));
}
