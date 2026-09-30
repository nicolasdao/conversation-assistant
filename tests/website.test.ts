import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// hey-tattle.com (website/): what search engines and link previews read, and the two things a change to the page can
// silently break: the release's rewrite of the download fields, and the 3D key's import map under the CSP.
const SITE = "https://hey-tattle.com";
const path = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p: string) => readFileSync(path(p), "utf8");
const page = read("website/index.html");
const head = page.slice(0, page.indexOf("</head>"));

function meta(attr: "name" | "property", key: string): string | undefined {
  return head.match(new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)"`))?.[1];
}
function links(rel: string): { href: string; tag: string }[] {
  return [...head.matchAll(/<link [^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`rel="${rel}"`))
    .map((tag) => ({ href: tag.match(/href="([^"]*)"/)?.[1] ?? "", tag }));
}
/** The file in website/ that an address on the site serves. */
function served(url: string): string {
  const { pathname } = new URL(url, `${SITE}/`);
  return `website${pathname}`;
}
function imageSize(buf: Buffer): { type: string; width: number; height: number } {
  if (buf.subarray(1, 4).toString("latin1") === "PNG") return { type: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length; ) {
      const marker = buf[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xc3) return { type: "image/jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error("not a PNG or JPEG");
}
/** Whether website/.assetsignore keeps a file off the site. */
function ignored(file: string): boolean {
  const rel = file.replace(/^website\//, "");
  return read("website/.assetsignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).some((p) =>
    p.endsWith("/") ? rel.startsWith(p) : p.startsWith("*.") ? rel.endsWith(p.slice(1)) : rel === p);
}
function jsonLd(): Record<string, any>[] {
  const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
  return blocks.flatMap((b) => b["@graph"] ?? [b]);
}

describe("the page's head", () => {
  it("names one canonical address, with a title and description short enough to show whole in search results", () => {
    expect(links("canonical").map((l) => l.href)).toEqual([`${SITE}/`]);
    const title = head.match(/<title>([^<]*)<\/title>/)![1]!;
    expect(title).toMatch(/^Tattle\b/);
    expect(title.length).toBeLessThanOrEqual(60);
    const description = meta("name", "description")!;
    expect(description.length).toBeGreaterThanOrEqual(110);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("gives link previews a title, description, address, site name, and an image with its size and alt text", () => {
    expect(meta("property", "og:type")).toBe("website");
    expect(meta("property", "og:url")).toBe(`${SITE}/`);
    expect(meta("property", "og:site_name")).toBe("Tattle");
    expect(meta("property", "og:title")).toMatch(/^Tattle\b/);
    expect(meta("property", "og:description")!.length).toBeGreaterThan(50);
    const image = meta("property", "og:image")!;
    expect(image.startsWith(`${SITE}/`)).toBe(true);
    expect(meta("property", "og:image:width")).toBe("1200");
    expect(meta("property", "og:image:height")).toBe("630");
    expect(meta("property", "og:image:alt")!.length).toBeGreaterThan(20);
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
    expect(meta("name", "twitter:image")).toBe(image);
    expect(meta("name", "twitter:image:alt")).toBe(meta("property", "og:image:alt"));
  });

  it("serves the preview image at 1200×630, in the type it declares, under 300 KB so chat apps still show it", () => {
    const file = served(meta("property", "og:image")!);
    expect(existsSync(path(file))).toBe(true);
    expect(ignored(file)).toBe(false);
    const size = imageSize(readFileSync(path(file)));
    expect(size).toEqual({ type: meta("property", "og:image:type"), width: 1200, height: 630 });
    expect(statSync(path(file)).size).toBeLessThan(300_000);
  });

  it("links its icons as files a search engine can fetch, not data: addresses", () => {
    const icons = [...links("icon"), ...links("apple-touch-icon")];
    expect(icons.map((i) => i.href).sort()).toEqual(["/apple-touch-icon.png", "/favicon.ico", "/favicon.svg"]);
    for (const { href } of icons) {
      expect(existsSync(path(served(href))), href).toBe(true);
      expect(ignored(served(href)), href).toBe(false);
    }
    expect(imageSize(readFileSync(path("website/apple-touch-icon.png")))).toEqual({ type: "image/png", width: 180, height: 180 });
    const ico = readFileSync(path("website/favicon.ico"));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]); // an icon resource
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48]));
  });

  it("has one h1, and it says what the app does rather than only its name", () => {
    const h1s = [...page.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toMatch(/transcribes/);
    expect(h1s[0]).toMatch(/fact-checks/);
  });
});

describe("crawling", () => {
  it("robots.txt lets every crawler in and names the sitemap, which lists the canonical page", () => {
    const robots = read("website/robots.txt");
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).not.toMatch(/^Disallow: \/\s*$/m);
    expect(robots).toMatch(new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, "m"));
    const locs = [...read("website/sitemap.xml").matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([links("canonical")[0]!.href]);
    expect(ignored("website/robots.txt") || ignored("website/sitemap.xml")).toBe(false);
  });
});

describe("structured data", () => {
  it("describes the site, the app, and its publisher, with the preview image and no invalid properties", () => {
    const nodes = jsonLd();
    const site = nodes.find((n) => n["@type"] === "WebSite")!;
    expect(site).toMatchObject({ name: "Tattle", url: `${SITE}/` });
    const app = nodes.find((n) => n["@type"] === "SoftwareApplication")!;
    expect(app).toMatchObject({ name: "Tattle", url: `${SITE}/`, image: meta("property", "og:image"), isAccessibleForFree: true });
    expect(app.offers).toMatchObject({ price: "0" });
    expect(app.featureList.length).toBeGreaterThan(3);
    expect(app).not.toHaveProperty("codeRepository"); // a SoftwareSourceCode property; the repository goes in sameAs
    expect(app.sameAs).toContain("https://github.com/nicolasdao/tattle");
    const publisher = nodes.find((n) => n["@type"] === "Organization")!;
    expect(publisher).toMatchObject({ name: "Cloudless Labs", url: "https://cloudlesslabs.com" });
    expect(app.publisher).toEqual({ "@id": publisher["@id"] });
  });
});

describe("who made it", () => {
  const YOUTUBE = "https://www.youtube.com/@nicolasdao";
  const X = "https://x.com/realnicdao";
  const PODCAST = "https://www.youtube.com/@theMadKoo";
  const section = (id: string) => page.match(new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`))![0];
  const anchors = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>/g)].map((m) => ({ href: m[1]!, tag: m[0] }));

  it("the credits link Nicolas's YouTube channel and X, and the podcast Tattle was first demoed on, each in a new tab", () => {
    const links = anchors(section("credits"));
    for (const url of [YOUTUBE, X, PODCAST]) {
      const link = links.find((l) => l.href === url);
      expect(link, url).toBeDefined();
      expect(link!.tag).toContain('target="_blank"');
      expect(link!.tag).toMatch(/rel="[^"]*\bnoopener\b/);
    }
    expect(section("credits")).toMatch(/first demoed/i);
    // his own profiles say they are his (rel="me"); the podcast is a show, not a profile of his
    for (const url of [YOUTUBE, X]) expect(links.find((l) => l.href === url)!.tag).toMatch(/rel="[^"]*\bme\b/);
  });

  it("the footer names them too", () => {
    const footer = page.match(/<footer[\s\S]*?<\/footer>/)![0];
    const hrefs = anchors(footer).map((l) => l.href);
    expect(hrefs).toEqual(expect.arrayContaining([YOUTUBE, X, PODCAST]));
  });

  it("X cards credit @realnicdao, and the structured data ties both profiles to the author", () => {
    expect(meta("name", "twitter:site")).toBe("@realnicdao");
    expect(meta("name", "twitter:creator")).toBe("@realnicdao");
    const app = jsonLd().find((n) => n["@type"] === "SoftwareApplication")!;
    expect(app.author.sameAs).toEqual(expect.arrayContaining([YOUTUBE, X]));
  });
});

describe("what a change to the page must not break", () => {
  it("the release's update-website.sh still finds each field it rewrites, as many times as it expects", () => {
    const script = read(".agents/skills/release-tattle/scripts/update-website.sh");
    const edits = [...script.matchAll(/^\s*\[\/(.+)\/g, .+, (\d+)\],?$/gm)].map((m) => ({ re: new RegExp(m[1]!, "g"), want: Number(m[2]) }));
    expect(edits.length).toBeGreaterThanOrEqual(10);
    for (const { re, want } of edits) expect((page.match(re) ?? []).length, String(re)).toBe(want);
  });

  it("the Content Security Policy allows the page's import map by its hash, so the 3D key loads", () => {
    const map = page.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]!;
    const hash = `'sha256-${createHash("sha256").update(map).digest("base64")}'`;
    const csp = read("website/_headers").match(/Content-Security-Policy: (.*)/)![1]!;
    expect(csp).toContain(hash);
  });
});
