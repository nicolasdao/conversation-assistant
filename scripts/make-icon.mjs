// Renders desktop/icon.svg into desktop/icon.icns, the Mac app's icon. Run it after changing the SVG:
//   npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

app.whenReady().then(async () => {
  const svg = readFileSync("desktop/icon.svg", "utf8");
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg", '<svg width="1024" height="1024"')}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024 }).toPNG();
  const dir = mkdtempSync(join(tmpdir(), "icon-"));
  const set = join(dir, "icon.iconset");
  execFileSync("mkdir", [set]);
  writeFileSync(join(dir, "1024.png"), png);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync("sips", ["-z", String(s), String(s), join(dir, "1024.png"), "--out", join(set, `icon_${s}x${s}.png`)], { stdio: "ignore" });
    execFileSync("sips", ["-z", String(s * 2), String(s * 2), join(dir, "1024.png"), "--out", join(set, `icon_${s}x${s}@2x.png`)], { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", "desktop/icon.icns"]);
  rmSync(dir, { recursive: true, force: true });
  console.log("wrote desktop/icon.icns");
  app.quit();
});
