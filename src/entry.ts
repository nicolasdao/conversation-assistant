import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether the module at `url` (its `import.meta.url`) is the program Node was started with. Node runs a module under
 * its real path, so the path it was started from is resolved first (a symlinked folder, spaces encoded in the URL).
 * A packaged Mac app started from Finder has no script path, and src/server/main.ts is bundled into it: false there.
 */
export function isMain(url: string, started = process.argv[1]): boolean {
  if (!started) return false;
  try {
    return url === pathToFileURL(realpathSync(started)).href;
  } catch {
    return false; // a path that does not exist is not this module
  }
}
