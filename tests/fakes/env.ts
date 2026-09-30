import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAppPaths, type AppPaths } from "../../src/paths.ts";

const made: string[] = [];

/** A fresh temporary folder; `cleanTmpDirs()` (in an afterEach/afterAll) removes every one made so far. */
export function tmpDir(prefix = "tattle-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

export function cleanTmpDirs(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Runs `fn` with some environment variables set (undefined deletes one), then restores them, even on a throw. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** The environment variables that carry keys, as they are now; call the result to put them back. */
export function snapshotKeyEnv(): () => void {
  const keys = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "TATTLE_CREDENTIALS"];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

/** Points the app's folders at tmp paths (sessions by default); pair with `afterEach(() => setAppPaths())`. */
export function withAppPaths(p: Partial<AppPaths> = {}): AppPaths {
  return setAppPaths({ sessions: tmpDir("sessions-"), ...p });
}
