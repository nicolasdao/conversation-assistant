import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appPaths } from "./paths.ts";

/** This app's name and version, from the root package.json (the only place the version lives; see README § Versioning), read on each call so a release shows without a restart. */
export function appInfo(root = appPaths().root): { name: string; version: string } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return { name: String(pkg.name), version: String(pkg.version) };
}
