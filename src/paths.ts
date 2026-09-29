import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the engine finds its files. Run from the project folder (`npm run serve`, the CLI tools, the tests), every
 * default is the project's own; the Mac app sets absolute paths into its bundle and Application Support before the
 * engine starts (see docs/desktop.md). Read at each use, never captured at import, so `setAppPaths` always applies.
 */
export interface AppPaths {
  /** Holds package.json (the version) and LICENSE. */
  root: string;
  /** The web page: index.html, styles.css, dist/, fonts/. */
  web: string;
  config: string;
  models: string;
  /** One folder per recording (see docs/recordings.md). */
  sessions: string;
  /** The tattle-capture helper. */
  helper: string;
  /** The tattle-transcribe helper: on-device transcription with Apple Speech (macOS 26+). */
  transcriber: string;
  /** The third-party notices, THIRD_PARTY_NOTICES.md (in the Mac app, a .txt copy next to the full texts). */
  notices: string;
  /** The full license texts the notices point to: licenses/. */
  licenses: string;
  /** The engine's TypeScript sources, watched for the restart banner; null where there are none (the Mac app). */
  src: string | null;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS: AppPaths = {
  root: ROOT,
  web: "web",
  config: "config",
  models: "models",
  sessions: "sessions",
  helper: "native/capture/.build/release/tattle-capture",
  transcriber: "native/transcribe/.build/release/tattle-transcribe",
  notices: join(ROOT, "THIRD_PARTY_NOTICES.md"),
  licenses: join(ROOT, "licenses"),
  src: join(ROOT, "src"),
};

let current: AppPaths = { ...DEFAULTS };

export function appPaths(): AppPaths {
  return current;
}

/** Replaces some paths, keeping the rest; `setAppPaths()` with nothing restores the defaults. */
export function setAppPaths(p: Partial<AppPaths> = {}): AppPaths {
  current = Object.keys(p).length ? { ...current, ...p } : { ...DEFAULTS };
  return current;
}

/** ~/Library/Application Support/Tattle: the saved keys, and the Mac app's recordings. */
export function appSupportDir(base = join(homedir(), "Library", "Application Support")): string {
  return join(base, "Tattle");
}

/** The folder's name before the app was renamed Tattle (28 September 2026). */
const LEGACY_APP_SUPPORT = "Conversation Assistant";

/**
 * Moves the folder from before the rename into place, once, so the keys, the recordings, and the window's storage come
 * along. Does nothing when the new folder exists already. Returns the folder it moved, or null.
 */
export function migrateAppSupportDir(base = join(homedir(), "Library", "Application Support")): string | null {
  const from = join(base, LEGACY_APP_SUPPORT);
  const to = appSupportDir(base);
  if (existsSync(to) || !existsSync(from)) return null;
  try {
    renameSync(from, to);
    return from;
  } catch (err) {
    console.warn(`Could not move ${from} to ${to}: ${(err as Error).message}`);
    return null;
  }
}

export const vadModelPath = () => join(current.models, "silero_vad.onnx");
export const speakerModelPath = () => join(current.models, "wespeaker_en_voxceleb_resnet34_LM.onnx");
