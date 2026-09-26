import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The root package.json: the only place the version lives (see README § Versioning). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** This app's name and version, read on each call so a release shows without a restart. */
export function appInfo(root = ROOT): { name: string; version: string } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return { name: String(pkg.name), version: String(pkg.version) };
}
