// The capture helper's Swift tests with coverage, and the gate on it (see docs/testing.md § Swift tests): runs
// `swift test --enable-code-coverage` in native/capture, prints line coverage per source file, and exits 1 when
// ClockLock.swift (the clock that keeps both streams on session time) is below 90 %. SystemTap.swift, Mic.swift and
// main.swift need the real hardware and macOS permissions, so they are printed but not gated.
//   node scripts/swift-coverage.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const PKG = "native/capture";
const GATES = { "ClockLock.swift": 90 };

execFileSync("swift", ["test", "--package-path", PKG, "--enable-code-coverage"], { stdio: "inherit" });
const path = execFileSync("swift", ["test", "--package-path", PKG, "--show-codecov-path"], { encoding: "utf8" }).trim();
const files = JSON.parse(readFileSync(path, "utf8")).data[0].files.filter((f) => f.filename.includes(`/${PKG}/Sources/`));

console.log("\n| File | Lines | Covered |\n|---|---|---|");
for (const f of files) console.log(`| ${basename(f.filename)} | ${f.summary.lines.percent.toFixed(1)} % | ${f.summary.lines.covered}/${f.summary.lines.count} |`);

let failed = false;
for (const [name, min] of Object.entries(GATES)) {
  const f = files.find((x) => basename(x.filename) === name);
  const pct = f?.summary.lines.percent ?? 0;
  if (pct < min) {
    console.error(`error: ${name} line coverage ${pct.toFixed(1)} % is below ${min} %`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`\nok: ${Object.keys(GATES).join(", ")} at or above the gate`);
