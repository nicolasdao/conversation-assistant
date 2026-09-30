// @vitest-environment happy-dom
// The chat and license renderer (web/src/markdown.ts; docs/chat.md § The page): Markdown to DOM nodes, never innerHTML,
// with cited [m:ss] times as buttons.
import { describe, expect, test, vi } from "vitest";
import { renderMarkdown } from "../../web/src/markdown.ts";

const html = (src: string, o = {}) => renderMarkdown(src, o).innerHTML;

describe("paragraphs and headings", () => {
  test("returns div.md; blank lines alone give an empty div", () => {
    const el = renderMarkdown("\n  \n\n");
    expect([el.tagName, el.className, el.childNodes.length]).toEqual(["DIV", "md", 0]);
  });

  test("consecutive lines join with <br>, trimmed; a blank line splits paragraphs; \\r\\n is normalised", () => {
    expect(html("para\r\n  line2 \r\n\r\nnext")).toBe("<p>para<br>line2</p><p>next</p>");
  });

  test("# → h3, ## → h4, ### → h5, and deeper headings stay h6", () => {
    expect(html("# a\n## b\n### c\n#### d\n##### e\n###### f")).toBe("<h3>a</h3><h4>b</h4><h5>c</h5><h6>d</h6><h6>e</h6><h6>f</h6>");
  });

  test("'# ' gives an empty h3; '#######' is a paragraph", () => {
    expect(html("# ")).toBe("<h3></h3>");
    expect(html("#######")).toBe("<p>#######</p>");
  });

  test("a heading line ends a paragraph, and inline formatting works inside it", () => {
    expect(html("para\nline2\n# h **b**")).toBe("<p>para<br>line2</p><h3>h <strong>b</strong></h3>");
  });

  test("a block-looking line that no block takes (a line separator ends it early) still renders as a paragraph", () => {
    expect(html("# a b")).toBe("<p># a b</p>");
  });
});

describe("rules and fences", () => {
  test("---, ***, ___, '- - -' and '* * *' give <hr>", () => {
    expect(html("---\n***\n___\n- - -\n* * *")).toBe("<hr><hr><hr><hr><hr>");
  });

  test("a fence gives pre > code[data-lang] with its body verbatim, not inline-parsed", () => {
    const el = renderMarkdown("```js\nconst a = **b**;\n  x\n```\nafter");
    const code = el.querySelector("pre > code")!;
    expect(code.getAttribute("data-lang")).toBe("js");
    expect(code.textContent).toBe("const a = **b**;\n  x");
    expect(code.querySelector("strong")).toBeNull();
    expect(el.querySelector("p")!.textContent).toBe("after");
  });

  test("a fence without a language has no data-lang", () => {
    expect(renderMarkdown("```\nx\n```").querySelector("code")!.hasAttribute("data-lang")).toBe(false);
  });

  test("an unclosed fence runs to the end (mid-stream replies)", () => {
    expect(renderMarkdown("```js\nx\n").querySelector("code")!.textContent).toBe("x\n");
  });
});

describe("quotes and tables", () => {
  test("> lines join into one blockquote holding a nested div.md, with inline formatting and times", () => {
    const onTime = vi.fn();
    const el = renderMarkdown("> q\n> **b** [1:02]\nafter", { onTime });
    const quote = el.querySelector("blockquote")!;
    expect(quote.firstElementChild!.className).toBe("md");
    expect(quote.innerHTML).toBe('<div class="md"><p>q<br><strong>b</strong> <button class="md-time" title="Jump to this moment">1:02</button></p></div>');
    expect(el.querySelector(":scope > p")!.textContent).toBe("after");
  });

  test("a table needs a header row and a separator; rows run while lines are |…|; cells are inline-parsed", () => {
    const el = renderMarkdown("| A | **B** |\n|:--|---:|\n| 1 | `2` |\n|3|4|\nafter");
    const table = el.querySelector("div.md-table > table")!;
    expect([...table.querySelectorAll("thead th")].map((c) => c.innerHTML)).toEqual(["A", "<strong>B</strong>"]);
    expect([...table.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.innerHTML))).toEqual([["1", "<code>2</code>"], ["3", "4"]]);
    expect(el.lastElementChild!.outerHTML).toBe("<p>after</p>");
  });

  test("a separator without leading pipe works too", () => {
    expect(renderMarkdown("|a|b|\n--|--\n|1|2|").querySelectorAll("tbody td").length).toBe(2);
  });

  test("a |row| without a separator is a paragraph", () => {
    expect(html("| a | b |\nplain")).toBe("<p>| a | b |<br>plain</p>");
  });
});

describe("lists", () => {
  test("- / * / + items give ul; 1. and 1) give ol", () => {
    expect(html("- a\n* b\n+ c")).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    expect(html("1. a\n2) b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  test("a deeper item nests a list inside the previous li; a deeper plain line continues the li", () => {
    expect(html("- a\n\n- b\n  - c\n  cont")).toBe("<ul><li>a</li><li>b<ul><li>c</li></ul> cont</li></ul>");
  });

  test("a shallower item ends the nested list and continues the outer one", () => {
    expect(html("- a\n  - a1\n- b")).toBe("<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>");
  });

  test("a blank line then a paragraph ends the list; a paragraph line right after an item ends it too", () => {
    expect(html("- a\n\npara")).toBe("<ul><li>a</li></ul><p>para</p>");
    expect(html("- a\npara")).toBe("<ul><li>a</li></ul><p>para</p>");
  });

  test("a deeper line with no item before it ends the list", () => {
    expect(html("  - a\n- b")).toBe("<ul><li>a</li></ul><ul><li>b</li></ul>");
  });

  test("the first item fixes the list's kind: '1. a\\n- b' is a single ol (documents current behaviour)", () => {
    expect(html("1. a\n- b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  test("items are inline-parsed", () => {
    expect(html("- **x** and `y`")).toBe("<ul><li><strong>x</strong> and <code>y</code></li></ul>");
  });
});

describe("inline spans", () => {
  test("`code` has no parsing inside", () => {
    expect(html("`**x**`")).toBe("<p><code>**x**</code></p>");
  });

  test("**x** and __x__ are strong, parsed recursively; *x* is em", () => {
    expect(html("**a `b` [x](https://x.y)**")).toBe('<p><strong>a <code>b</code> <a href="https://x.y" target="_blank" rel="noopener noreferrer">x</a></strong></p>');
    expect(html("__a__ *b `c`*")).toBe("<p><strong>a</strong> <em>b <code>c</code></em></p>");
  });

  test("__u__, `c` and *i* in one line", () => {
    expect(html("__u__ `c` *i*")).toBe("<p><strong>u</strong> <code>c</code> <em>i</em></p>");
  });

  test("'* x *' (a space after the star) is not em", () => {
    expect(html("a * b * c")).toBe("<p>a * b * c</p>");
  });

  test("[t](https://u) and [t](http://u) are links opening in a new tab without the opener", () => {
    const el = renderMarkdown("[one](https://a.b/c) [two](http://x.y)");
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])).toEqual([
      ["one", "https://a.b/c", "_blank", "noopener noreferrer"], ["two", "http://x.y", "_blank", "noopener noreferrer"],
    ]);
  });

  test("[t](javascript:…) and [t](/rel) stay literal text", () => {
    expect(html("[y](javascript:alert(1)) [z](/rel)")).toBe("<p>[y](javascript:alert(1)) [z](/rel)</p>");
  });

  test("a time [1:02] with onTime is a button; a click calls onTime(62 000); [10:00:00] is 36 000 000 ms", () => {
    const onTime = vi.fn();
    const el = renderMarkdown("at [1:02] and [10:00:00]", { onTime });
    const [a, b] = [...el.querySelectorAll<HTMLButtonElement>("button.md-time")];
    expect([a!.textContent, a!.title]).toEqual(["1:02", "Jump to this moment"]);
    a!.click();
    b!.click();
    expect(onTime.mock.calls).toEqual([[62_000], [36_000_000]]);
  });

  test("[1:2] and [123:45] are not times", () => {
    expect(renderMarkdown("[1:2] [123:45]", { onTime: () => {} }).querySelector("button")).toBeNull();
  });

  test("without onTime a time stays the literal text", () => {
    expect(html("see [1:02]")).toBe("<p>see [1:02]</p>");
  });

  test("text around spans is kept in order", () => {
    expect(html("a `b` c **d** e")).toBe("<p>a <code>b</code> c <strong>d</strong> e</p>");
  });

  test("markup is text: '<script>' creates no element", () => {
    const el = renderMarkdown("<script>alert(1)</script> <b>x</b>");
    expect(el.querySelector("script, b")).toBeNull();
    expect(el.textContent).toBe("<script>alert(1)</script> <b>x</b>");
  });

  test("'2*3*4' is italicised (documents the quirk)", () => {
    expect(html("2*3*4")).toBe("<p>2<em>3</em>4</p>");
  });
});
