// Renders hey-tattle.com's images with Playwright's Chromium (the one the end-to-end tests use), from HTML and SVG in
// this repository, so they keep the site's own tokens and fonts. Run from the project root:
//   node scripts/make-site-images.mjs                  every link-preview card in website/experiments/og/ to its png/ folder
//   node scripts/make-site-images.mjs --ship <card>    also writes that card (e.g. 02-record-key) to website/og.jpg, the page's og:image
//   node scripts/make-site-images.mjs --icons          website/favicon.svg, favicon.ico and apple-touch-icon.png, from desktop/icon.svg
//   node scripts/make-site-images.mjs --capture-key    captures the 3D record key again from https://hey-tattle.com (network)
//                                                      into website/experiments/og/assets/key.jpg, which the cards use
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OG = "website/experiments/og";
const SHIP = "website/og.jpg";
const SHIP_MAX = 300_000; // bytes: WhatsApp is reported to skip larger preview images
const args = process.argv.slice(2);
const ship = args.includes("--ship") ? args[args.indexOf("--ship") + 1] : undefined;

// The key's WebGL scene needs software GL in headless Chromium; the cards must not have it (their screenshots hang).
const gl = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args: args.includes("--capture-key") ? gl : [] });
try {
  if (args.includes("--capture-key")) await captureKey();
  else if (args.includes("--icons")) await icons();
  else await cards();
} finally {
  await browser.close();
}

async function cards() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  mkdirSync(join(OG, "png"), { recursive: true });
  const names = readdirSync(OG).filter((f) => /^\d\d-.+\.html$/.test(f)).map((f) => f.replace(/\.html$/, ""));
  if (ship && !names.includes(ship)) throw new Error(`no card ${ship}; cards: ${names.join(", ")}`);
  for (const name of names) {
    await page.goto(pathToFileURL(resolve(OG, `${name}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    const shot = (opts) => page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 }, animations: "disabled", ...opts });
    await shot({ path: join(OG, "png", `${name}.png`) });
    console.log(`wrote ${OG}/png/${name}.png`);
    if (name === ship) {
      await shot({ path: SHIP, type: "jpeg", quality: 90 });
      const size = statSync(SHIP).size;
      if (size > SHIP_MAX) throw new Error(`${SHIP} is ${size} bytes, over ${SHIP_MAX}: simplify the card or lower the quality`);
      console.log(`wrote ${SHIP} (${Math.round(size / 1000)} KB)`);
    }
  }
}

async function icons() {
  // The app icon without its drop shadow, cropped to its rounded square, as the page's old data: favicon drew it.
  const svg = readFileSync("desktop/icon.svg", "utf8")
    .replace(/<!--[\s\S]*?-->\s*/g, "").replace(/\s*<filter[\s\S]*?<\/filter>/, "").replace(/ filter="url\(#s\)"/, "")
    .replace(/viewBox="[^"]*"/, 'viewBox="100 100 824 824"');
  writeFileSync("website/favicon.svg", svg);
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (source, size, transparent) => {
    await page.setViewportSize({ width: size, height: size });
    const src = `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;
    await page.setContent(`<body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`);
    return page.screenshot({ omitBackground: transparent });
  };
  const pngs = [];
  for (const size of [16, 32, 48]) pngs.push({ size, buf: await render(svg, size, true) });
  writeFileSync("website/favicon.ico", ico(pngs));
  // iOS rounds the corners itself and turns transparency black, so the touch icon is the full square.
  writeFileSync("website/apple-touch-icon.png", await render(svg.replace(/ rx="\d+"/, ""), 180, false));
  console.log("wrote website/favicon.svg, website/favicon.ico (16, 32, 48) and website/apple-touch-icon.png (180)");
}

/** An .ico file holding PNG images, which every current browser reads. */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const at = 6 + i * 16;
    head[at] = size; head[at + 1] = size;
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(buf.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

async function captureKey() {
  // The hero's key with everything around it hidden, tilted toward a pointer up and to its left.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3 });
  await page.goto("https://hey-tattle.com/", { waitUntil: "load" });
  await page.addStyleTag({ content: ".hero-copy, .bar, .hint, #caps, #lower, .cue { visibility: hidden !important; }" });
  const box = await page.locator("#rec").boundingBox();
  await page.mouse.move(box.x + box.width / 2 - 500, box.y + box.height / 2 - 150, { steps: 5 });
  await page.waitForTimeout(2500);
  const dir = mkdtempSync(join(tmpdir(), "key-"));
  try {
    const png = join(dir, "key.png");
    await page.screenshot({ path: png, clip: { x: box.x - 32, y: box.y - 52, width: 560, height: 580 } });
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", "-Z", "1000", png, "--out", join(OG, "assets", "key.jpg")], { stdio: "ignore" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`wrote ${OG}/assets/key.jpg`);
}
