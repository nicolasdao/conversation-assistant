// A small Markdown renderer for chat replies: paragraphs, headings, lists, quotes, code, tables, bold, italic, inline
// code, and links. It builds DOM nodes (never innerHTML), so a reply cannot inject markup. Times cited like [12:34]
// become buttons that jump to that moment.
import { h } from "./dom.js";

export interface MdOptions { onTime?: (ms: number) => void }

function timeMs(s: string): number {
  return s.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

/** Inline spans: `code`, **bold**, *italic*, [text](https://…), and [m:ss] times. */
function inline(text: string, o: MdOptions): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(h("code", {}, m[1]));
    else if (m[2] !== undefined || m[3] !== undefined) out.push(h("strong", {}, ...inline(m[2] ?? m[3]!, o)));
    else if (m[4] !== undefined) out.push(h("em", {}, ...inline(m[4], o)));
    else if (m[5] !== undefined) out.push(h("a", { href: m[6]!, target: "_blank", rel: "noopener noreferrer" }, m[5]));
    else if (m[7] !== undefined) {
      const t = m[7];
      out.push(o.onTime
        ? h("button", { class: "md-time", title: "Jump to this moment", onclick: () => o.onTime!(timeMs(t)) }, t)
        : `[${t}]`);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function renderMarkdown(src: string, o: MdOptions = {}): HTMLElement {
  const root = h("div", { class: "md" });
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    // fenced code (an unclosed fence, mid-stream, runs to the end)
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      root.append(h("pre", {}, h("code", fence[1] ? { "data-lang": fence[1] } : {}, body.join("\n"))));
      continue;
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const level = Math.min(6, head[1]!.length + 2) as 3 | 4 | 5 | 6; // replies sit inside a small column
      root.append(h(`h${level}` as "h3", {}, ...inline(head[2]!, o)));
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { root.append(h("hr", {})); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ""));
      root.append(h("blockquote", {}, renderMarkdown(body.join("\n"), o)));
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const header = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]!); i++) rows.push(cells(lines[i]!));
      root.append(h("div", { class: "md-table" }, h("table", {},
        h("thead", {}, h("tr", {}, header.map((c) => h("th", {}, ...inline(c, o))))),
        h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, ...inline(c, o)))))))));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      root.append(list(lines, i, o, (n) => { i = n; }));
      continue;
    }
    // a paragraph runs to a blank line or the start of another block
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]!); i++) para.push(lines[i]!.trim());
    if (!para.length) { para.push(line.trim()); i++; }
    const p = h("p", {});
    para.forEach((l, k) => { if (k) p.append(h("br", {})); p.append(...inline(l, o)); });
    root.append(p);
  }
  return root;
}

/** A list starting at line `start`, with nested lists for deeper-indented items. */
function list(lines: string[], start: number, o: MdOptions, done: (next: number) => void): HTMLElement {
  const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const el = h(ordered ? "ol" : "ul", {});
  let i = start;
  let li: HTMLElement | null = null;
  while (i < lines.length) {
    const l = lines[i]!;
    if (!l.trim()) {
      // a blank line ends the list unless another item of it follows
      const next = lines[i + 1];
      if (next !== undefined && /^(\s*)([-*+]|\d+[.)])\s+/.test(next) && /^(\s*)/.exec(next)![1]!.length >= indent) { i++; continue; }
      break;
    }
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    const ind = /^(\s*)/.exec(l)![1]!.length;
    if (m && ind === indent) {
      li = h("li", {}, ...inline(m[3]!, o));
      el.append(li);
      i++;
    } else if (m && ind > indent && li) {
      li.append(list(lines, i, o, (n) => { i = n; }));
    } else if (!m && ind > indent && li) {
      li.append(" ", ...inline(l.trim(), o));
      i++;
    } else break;
  }
  done(i);
  return el;
}
