// The Licenses and Acknowledgements window's content (see docs/desktop.md#licenses): the project's own license, then
// every third-party component in THIRD_PARTY_NOTICES.md, with the full texts the notices point to in licenses/.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appPaths } from "./paths.ts";

export interface LicenseComponent {
  /** The notices' heading, e.g. "Electron 44.4.5". */
  title: string;
  /** The license named on its first line, e.g. "MIT" or "GPL-3.0-or-later". */
  license: string;
  /** The component's notice, in Markdown. */
  body: string;
  /** The full texts it points to (`licenses/Apache-2.0.txt`, `web/fonts/OFL.txt`), keys of `Licenses.texts`. */
  files: string[];
}

export interface LicenseGroup { title: string; components: LicenseComponent[] }

export interface Licenses {
  app: { name: string; version: string; license: string | null; holder: string | null; text: string };
  groups: LicenseGroup[];
  /** Each full text once, by the path the notices name. */
  texts: Record<string, string>;
}

const FILE_REF = /`((?:licenses\/[A-Za-z0-9._-]+|web\/fonts\/OFL)\.txt)`/g;

function component(title: string, lines: string[]): LicenseComponent {
  const body = lines.join("\n").trim();
  const first = body.split("\n", 1)[0] ?? "";
  const license = first.split(" · ", 1)[0]!.replace(/\*\*/g, "").trim();
  const files = [...new Set([...body.matchAll(FILE_REF)].map((m) => m[1]!))];
  return { title, license, body, files };
}

/** Groups (`## `) of components (`### `), as THIRD_PARTY_NOTICES.md lays them out; headings inside code fences are text. */
export function parseNotices(md: string): LicenseGroup[] {
  const groups: LicenseGroup[] = [];
  let open: { title: string; lines: string[] } | null = null;
  let fenced = false;
  const close = () => {
    if (open && groups.length) groups.at(-1)!.components.push(component(open.title, open.lines));
    open = null;
  };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const g = /^## (.+)$/.exec(line);
      if (g) { close(); groups.push({ title: g[1]!.trim(), components: [] }); continue; }
      const c = /^### (.+)$/.exec(line);
      if (c) { close(); open = { title: c[1]!.trim(), lines: [] }; continue; }
    }
    open?.lines.push(line);
  }
  close();
  return groups.filter((g) => g.components.length);
}

/** Where a path the notices name is on this Mac: the licenses folder, or the page's fonts. */
function resolveRef(ref: string): string {
  const p = appPaths();
  return ref.startsWith("licenses/") ? join(p.licenses, ref.slice("licenses/".length)) : join(p.web, "fonts", "OFL.txt");
}

/** Read on each request, like `about()`, so what the window shows is always what ships. */
export function licenses(): Licenses {
  const p = appPaths();
  const pkg = JSON.parse(readFileSync(join(p.root, "package.json"), "utf8"));
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const groups = parseNotices(read(p.notices));
  const texts: Record<string, string> = {};
  for (const ref of new Set(groups.flatMap((g) => g.components.flatMap((c) => c.files)))) {
    const text = read(resolveRef(ref));
    if (text) texts[ref] = text;
  }
  for (const g of groups) for (const c of g.components) c.files = c.files.filter((f) => f in texts);
  return {
    app: {
      name: pkg.productName ?? pkg.name, version: pkg.version, license: pkg.license ?? null,
      holder: pkg.author ?? null, text: read(join(p.root, "LICENSE")),
    },
    groups,
    texts,
  };
}
