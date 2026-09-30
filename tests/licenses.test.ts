import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { licenses, parseNotices } from "../src/licenses.ts";
import { setAppPaths } from "../src/paths.ts";
import { cleanTmpDirs, tmpDir } from "./fakes/env.ts";

afterEach(() => {
  setAppPaths();
  cleanTmpDirs();
});

describe("parseNotices", () => {
  it("drops components before the first ## group, and groups with no components", () => {
    const md = [
      "# Third-party notices", "intro", "### Orphan", "MIT", "",
      "## Empty group", "text only",
      "## Runtime", "### Electron 44", "**MIT** · Copyright GitHub", "body",
    ].join("\n");
    const g = parseNotices(md);
    expect(g.map((x) => x.title)).toEqual(["Runtime"]);
    expect(g[0]!.components).toEqual([{ title: "Electron 44", license: "MIT", body: "**MIT** · Copyright GitHub\nbody", files: [] }]);
  });

  it("handles CRLF; '#### ' is body text; repeated file refs are deduplicated; refs outside backticks are ignored", () => {
    const md = [
      "## Group", "### Lib 1.0", "Apache-2.0 · Some Org", "#### Details",
      "See `licenses/Apache-2.0.txt` and again `licenses/Apache-2.0.txt`.",
      "Also licenses/MIT.txt (bare) and `web/fonts/OFL.txt` and `licenses/../x.txt`.",
    ].join("\r\n");
    const [group] = parseNotices(md);
    const c = group!.components[0]!;
    expect(c.license).toBe("Apache-2.0");
    expect(c.body).toContain("#### Details");
    expect(c.body).not.toContain("\r");
    expect(c.files).toEqual(["licenses/Apache-2.0.txt", "web/fonts/OFL.txt"]);
  });

  it("an unterminated fence swallows later headings (documents behaviour)", () => {
    const md = ["## G", "### A", "MIT", "```", "## Not a group", "### Not a component"].join("\n");
    const g = parseNotices(md);
    expect(g).toHaveLength(1);
    expect(g[0]!.components.map((c) => c.title)).toEqual(["A"]);
    expect(g[0]!.components[0]!.body).toContain("### Not a component");
  });

  it("an empty component has an empty license and body", () => {
    const [g] = parseNotices("## G\n### Nothing\n");
    expect(g!.components[0]).toEqual({ title: "Nothing", license: "", body: "", files: [] });
  });
});

/** A tmp tree laid out like the Mac app's resources. */
function tree(o: { pkg?: object | null; notices?: string | null; license?: string | null; texts?: Record<string, string>; ofl?: string } = {}) {
  const root = tmpDir("licenses-");
  const lic = join(root, "licenses");
  const web = join(root, "web");
  mkdirSync(lic);
  mkdirSync(join(web, "fonts"), { recursive: true });
  if (o.pkg !== null) writeFileSync(join(root, "package.json"), JSON.stringify(o.pkg ?? { name: "tattle", productName: "Tattle", version: "1.2.3", license: "BSD-3-Clause", author: "Cloudless" }));
  if (o.notices !== null) writeFileSync(join(root, "NOTICES.md"), o.notices ?? "");
  if (o.license !== null) writeFileSync(join(root, "LICENSE"), o.license ?? "BSD license text");
  for (const [n, t] of Object.entries(o.texts ?? {})) writeFileSync(join(lic, n), t);
  if (o.ofl !== undefined) writeFileSync(join(web, "fonts", "OFL.txt"), o.ofl);
  setAppPaths({ root, notices: join(root, "NOTICES.md"), licenses: lic, web });
  return root;
}

describe("licenses()", () => {
  it("reads the app's own license from package.json and LICENSE; productName wins over name", () => {
    tree();
    expect(licenses().app).toEqual({ name: "Tattle", version: "1.2.3", license: "BSD-3-Clause", holder: "Cloudless", text: "BSD license text" });
  });

  it("falls back to name; license and author are null when absent", () => {
    tree({ pkg: { name: "tattle", version: "0.1.0" } });
    expect(licenses().app).toMatchObject({ name: "tattle", license: null, holder: null });
  });

  it("missing notices → no groups; missing LICENSE → empty text", () => {
    tree({ notices: null, license: null });
    const l = licenses();
    expect(l.groups).toEqual([]);
    expect(l.texts).toEqual({});
    expect(l.app.text).toBe("");
  });

  it("keeps each full text once, drops a referenced text that is missing or empty, and resolves the font's OFL under web", () => {
    tree({
      notices: [
        "## Libraries", "### A", "MIT · x", "`licenses/MIT.txt`", "### B", "MIT · y", "`licenses/MIT.txt` `licenses/Gone.txt` `licenses/Empty.txt`",
        "## Fonts", "### Inter", "OFL-1.1", "`web/fonts/OFL.txt`",
      ].join("\n"),
      texts: { "MIT.txt": "MIT text", "Empty.txt": "" },
      ofl: "OFL text",
    });
    const l = licenses();
    expect(l.texts).toEqual({ "licenses/MIT.txt": "MIT text", "web/fonts/OFL.txt": "OFL text" });
    expect(l.groups.map((g) => g.components.map((c) => [c.title, c.files]))).toEqual([
      [["A", ["licenses/MIT.txt"]], ["B", ["licenses/MIT.txt"]]],
      [["Inter", ["web/fonts/OFL.txt"]]],
    ]);
  });

  it("throws when package.json is missing", () => {
    tree({ pkg: null });
    expect(() => licenses()).toThrow(/ENOENT/);
  });
});
