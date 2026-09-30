// Playwright fixtures for the web end-to-end tests (docs/testing.md § E2E web): each test file gets its own harness
// (e2e/harness/server.ts) in a fresh tmp folder, because the engine's state is global to its process.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

export interface Harness {
  url: string;
  tmp: string;
  /** Sends a control command (E2E_CONTROL=1) and waits until the harness applied it. */
  control(cmd: Record<string, unknown>): Promise<void>;
  /** Everything the harness printed. */
  log(): string;
}

export async function startHarness(env: Record<string, string> = {}): Promise<Harness & { stop(): Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), "tattle-e2e-"));
  for (const d of ["home", "tmp", "labels"]) mkdirSync(join(tmp, d));
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: process.env.LANG ?? "en_US.UTF-8", TZ: process.env.TZ,
    HOME: join(tmp, "home"), TMPDIR: join(tmp, "tmp"),
    TATTLE_CREDENTIALS: join(tmp, "home", "credentials.json"), TATTLE_SETTINGS: join(tmp, "home", "settings.json"),
    TATTLE_LABEL_SETS: join(tmp, "labels"),
    E2E_TMP: tmp, E2E_PORT: "0", ...env,
  };
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "e2e/harness/server.ts"], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const waiters: { re: RegExp; resolve: (m: RegExpMatchArray) => void }[] = [];
  const onData = (b: Buffer) => {
    out += b.toString();
    for (const w of [...waiters]) {
      const m = out.match(w.re);
      if (m) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    }
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  const wait = (re: RegExp, ms = 30_000) => new Promise<RegExpMatchArray>((resolve, reject) => {
    const m = out.match(re);
    if (m) return resolve(m);
    const t = setTimeout(() => reject(new Error(`harness: no ${re} within ${ms} ms\n${out}`)), ms);
    waiters.push({ re, resolve: (x) => { clearTimeout(t); resolve(x); } });
    child.once("exit", (code) => { clearTimeout(t); reject(new Error(`harness exited (${code})\n${out}`)); });
  });
  const url = (await wait(/E2E_READY (http:\/\/127\.0\.0\.1:\d+)/))[1]!;
  let n = 0;
  return {
    url, tmp,
    log: () => out,
    async control(cmd) {
      const id = `c${++n}`;
      child.stdin!.write(JSON.stringify({ ...cmd, id }) + "\n");
      await wait(new RegExp(`E2E_DONE ${id}\\b`), 10_000);
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Fails the test on any request that leaves the harness (the page's CSP already allows only 'self'). */
export async function guardNetwork(page: Page, baseURL: string, escaped: string[]): Promise<void> {
  await page.route("**/*", (r) => {
    const u = r.request().url();
    if (u.startsWith(baseURL) || u.startsWith("data:") || u.startsWith("blob:")) return r.continue();
    escaped.push(u);
    return r.abort();
  });
}

/**
 * Opens a path and waits until the page has booted (never `networkidle`: /api/events stays open). The shell shows
 * before app.js has bound its controls (web/src/main.ts), so with the app loading, wait until it has drawn the header.
 */
export async function open(page: Page, path = "/"): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).not.toHaveClass(/booting/);
  if (await page.locator("main#setup").count()) return;
  await expect(page.locator("#cost")).not.toBeEmpty(); // empty in the markup; the app draws it on its first render
}

type Fixtures = { harnessEnv: Record<string, string>; harness: Harness; escaped: string[] };

export const test = base.extend<Fixtures>({
  harnessEnv: [{}, { option: true }],
  harness: async ({ harnessEnv }, use) => {
    const h = await startHarness(harnessEnv);
    try {
      await use(h);
    } finally {
      await h.stop();
    }
  },
  baseURL: async ({ harness }, use) => { await use(harness.url); },
  escaped: async ({}, use) => { await use([]); },
  page: async ({ page, harness, escaped }, use) => {
    await guardNetwork(page, harness.url, escaped);
    await use(page);
    expect(escaped, "requests that left 127.0.0.1").toEqual([]);
  },
});

export { expect };
