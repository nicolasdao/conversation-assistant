// Playwright fixtures for the Mac app in development (docs/testing.md § E2E Mac app): Electron runs dist/desktop/main.mjs
// (npm run build:web && npm run build:desktop first; npm run test:e2e does it) with an isolated HOME, so it shares
// nothing with an installed Tattle (Application Support, the window's storage, the single-instance lock), and from a
// tmp working folder, because in development `web`, `config`, `models` and `sessions` are relative to it: the app sees
// the project's page, config and models through symlinks, and an empty `sessions/`, never the real recordings.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, test as base, expect, type ElectronApplication, type Page } from "@playwright/test";

export const ROOT = resolve(".");

export interface MacApp {
  app: ElectronApplication;
  window: Page;
  home: string;
  /** What the main process recorded from the stubbed dialog and shell calls. */
  recorded(): Promise<{ sheets: { message?: string; detail?: string; buttons?: string[] }[]; external: string[]; paths: string[] }>;
  /** Clicks a menu item by its path, e.g. ["Tattle", "Settings…"]. */
  menu(path: string[]): Promise<void>;
}

export function isolatedFolders(opts: { keys?: boolean } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "tattle-electron-"));
  const home = join(tmp, "home");
  const cwd = join(tmp, "cwd");
  mkdirSync(home);
  mkdirSync(join(cwd, "sessions"), { recursive: true });
  for (const d of ["web", "config", "models"]) symlinkSync(join(ROOT, d), join(cwd, d));
  const credentials = join(home, "credentials.json");
  if (opts.keys) {
    writeFileSync(credentials, JSON.stringify({ OPENAI_API_KEY: "sk-proj-e2e-000000000000000000000000abcd", OPENROUTER_API_KEY: "sk-or-v1-e2e-00000000000000000000000000001234" }), { mode: 0o600 });
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(OPENAI_API_KEY|OPENROUTER_API_KEY|NODE_OPTIONS|TATTLE_.*)$/.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: home, TMPDIR: join(tmp, "tmp"),
    TATTLE_CREDENTIALS: credentials, TATTLE_SETTINGS: join(home, "settings.json"), TATTLE_LABEL_SETS: join(home, "labels"),
    // never start the on-device transcription helper (or install its model): the engine transcribes with OpenAI
    TATTLE_FORCE_NO_APPLE_SPEECH: "1",
  });
  mkdirSync(env.TMPDIR!);
  return { tmp, home, cwd, env };
}

export async function launch(f: ReturnType<typeof isolatedFolders>): Promise<ElectronApplication> {
  const app = await _electron.launch({ args: [ROOT], cwd: f.cwd, env: f.env });
  // the main process: no network, and the native sheets and the shell recorded instead of shown or opened
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as Record<string, unknown>;
    g.__sheets = [];
    g.__external = [];
    g.__paths = [];
    globalThis.fetch = (() => { throw new Error("network disabled in E2E"); }) as typeof fetch;
    dialog.showMessageBox = (async (...a: unknown[]) => {
      const o = (a.length > 1 ? a[1] : a[0]) as { message?: string; detail?: string; buttons?: string[] };
      (g.__sheets as unknown[]).push({ message: o.message, detail: o.detail, buttons: o.buttons });
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    shell.openExternal = (async (url: string) => { (g.__external as string[]).push(url); }) as typeof shell.openExternal;
    shell.openPath = (async (p: string) => { (g.__paths as string[]).push(p); return ""; }) as typeof shell.openPath;
  });
  return app;
}

export async function macApp(f: ReturnType<typeof isolatedFolders>): Promise<MacApp & { close(): Promise<void> }> {
  const app = await launch(f);
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return {
    app, window, home: f.home,
    recorded: () => app.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      return { sheets: g.__sheets, external: g.__external, paths: g.__paths } as never;
    }),
    menu: (path) => app.evaluate(({ Menu }, p) => {
      let items = Menu.getApplicationMenu()!.items;
      let item: Electron.MenuItem | undefined;
      for (const label of p) {
        item = items.find((i) => i.label === label);
        if (!item) throw new Error(`no menu item ${label} (have ${items.map((i) => i.label).join(", ")})`);
        items = item.submenu?.items ?? [];
      }
      item!.click();
    }, path),
    close: async () => { await app.close().catch(() => {}); },
  };
}

type Fixtures = { keys: boolean; mac: MacApp };

export const test = base.extend<Fixtures>({
  keys: [true, { option: true }],
  mac: async ({ keys }, use) => {
    const f = isolatedFolders({ keys });
    const m = await macApp(f);
    try {
      await use(m);
    } finally {
      await m.close();
      rmSync(f.tmp, { recursive: true, force: true });
    }
  },
});

export { expect };
