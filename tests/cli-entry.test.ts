import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

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

describe("the command-line tools run through a symlinked path", () => {
  // Node runs a module under its real path, so a guard comparing it with the symlinked path it was started from never
  // matched, and the tool silently did nothing (the rest of bug B3)
  test("calibrate:boundary started through a symlink prints its usage and exits 1", () => {
    const link = join(tmp, "linked tattle");
    if (!existsSync(link)) symlinkSync(base, link);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp };
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;
    const r = spawnSync(process.execPath, ["--import", "tsx", join(link, "src/cli/calibrateBoundary.ts")], { cwd: ROOT, env, encoding: "utf8", timeout: 110_000 });
    expect(r.stderr).toContain("usage: npm run calibrate:boundary");
    expect(r.status).toBe(1);
  });
});

describe("npm run serve, as a child process with an isolated home and no keys", () => {
  test("says what is missing, refuses a replay without the keys, stays up, and exits 0 on SIGTERM", async () => {
    // its own working folder: the config it reads, and a recordings folder that is not the repository's
    const cwd = join(tmp, "serve-cwd");
    mkdirSync(cwd);
    symlinkSync(join(ROOT, "config"), join(cwd, "config"));
    symlinkSync(join(ROOT, "node_modules"), join(cwd, "node_modules"));
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: tmp, TATTLE_CREDENTIALS: join(tmp, "credentials.json"), TATTLE_SETTINGS: join(tmp, "settings.json"),
      TATTLE_FORCE_NO_APPLE_SPEECH: "1", TATTLE_LABEL_SETS: join(tmp, "labels"),
    };
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/server/main.ts"), "--port", "0", "--replay", "fixtures/conversation"], { cwd, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    for (let i = 0; i < 900 && !(out.includes("API key missing") && err.includes("--replay needs")); i++) await new Promise((r) => setTimeout(r, 100));
    expect(out).toContain("Tattle on http://127.0.0.1:0 (transcription: OpenAI)");
    expect(out).toContain("API key missing (openai): open the page above to add it");
    expect(err).toContain("--replay needs openai and openrouter (fact-checking and labels run)");
    expect(child.exitCode).toBeNull(); // still serving
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(existsSync(join(cwd, "sessions"))).toBe(false); // nothing was recorded
  });
});

// A packaged Mac app started from Finder has no process.argv[1]. src/server/main.ts is bundled into the app's main
// process, so its entry guard must not throw then: pathToFileURL(undefined) does, and the app would not start.
describe("the entry guards with no script path (the packaged Mac app)", () => {
  for (const file of ["../src/server/main.ts", "../src/cli/replay.ts", "../src/cli/calibrateBoundary.ts", "../src/cli/calibrateSpeakers.ts"]) {
    test(`${file.slice(3)} loads, and does not run`, async () => {
      const argv = process.argv;
      process.argv = [process.execPath];
      vi.resetModules();
      try {
        await expect(import(file)).resolves.toBeDefined();
      } finally {
        process.argv = argv;
      }
    });
  }
});

describe("isMain", () => {
  test("is false with no script path, and for a path that does not exist", async () => {
    const { isMain } = await import("../src/entry.ts");
    expect(isMain(import.meta.url, undefined)).toBe(false);
    expect(isMain(import.meta.url, join(tmp, "no such file.ts"))).toBe(false);
    expect(isMain(pathToFileURL(realpathSync(join(ROOT, "tests", "cli-entry.test.ts"))).href, join(ROOT, "tests", "cli-entry.test.ts"))).toBe(true);
  });
});
