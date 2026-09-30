import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Bug B3: each command-line tool runs its main only when started as the program, which it tells by comparing its own
// URL with the path it was started from. Compared as `file://${path}`, a path with a space (percent-encoded in the URL)
// never matched, so the tool silently did nothing. These run a copy of the sources from a folder with spaces in its
// name, as a child process, and stop before anything reaches a service or the user's files.

const ROOT = resolve(".");
let tmp = "";
let base = "";

beforeAll(() => {
  // the real path: macOS's tmpdir is itself behind a symlink, which a module's own URL resolves
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "tattle-cli-")));
  base = join(tmp, "a folder with spaces");
  mkdirSync(base);
  cpSync(join(ROOT, "src"), join(base, "src"), { recursive: true });
  cpSync(join(ROOT, "web", "src"), join(base, "web", "src"), { recursive: true }); // the label model imports the icon list
  copyFileSync(join(ROOT, "package.json"), join(base, "package.json")); // "type": "module"
  symlinkSync(join(ROOT, "node_modules"), join(base, "node_modules"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Runs a copied tool with an isolated home and no keys. */
function run(file: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, TATTLE_CREDENTIALS: join(tmp, "credentials.json"), TATTLE_SETTINGS: join(tmp, "settings.json") };
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  return spawnSync(process.execPath, ["--import", "tsx", join(base, file), ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 110_000 });
}

describe("the command-line tools run from a path with spaces", () => {
  test("calibrate:boundary with no file prints its usage and exits 1", () => {
    const r = run("src/cli/calibrateBoundary.ts", []);
    expect(r.stderr).toContain("usage: npm run calibrate:boundary");
    expect(r.status).toBe(1);
  });

  test("calibrate:speakers with no WAV prints its usage and exits 1", () => {
    const r = run("src/cli/calibrateSpeakers.ts", []);
    expect(r.stderr).toContain("usage: npm run calibrate:speakers");
    expect(r.status).toBe(1);
  });

  test("serve refuses an unknown flag and exits 1, before booting anything", () => {
    const r = run("src/server/main.ts", ["--bogus"]);
    expect(r.stderr).toMatch(/Unknown option '--bogus'/);
    expect(r.status).toBe(1);
  });
});
