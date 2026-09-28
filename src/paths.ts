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
  /** The conversation-capture helper. */
  helper: string;
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
  helper: "native/capture/.build/release/conversation-capture",
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

/** ~/Library/Application Support/Conversation Assistant: the saved keys, and the Mac app's recordings. */
export function appSupportDir(): string {
  return join(homedir(), "Library", "Application Support", "Conversation Assistant");
}

export const vadModelPath = () => join(current.models, "silero_vad.onnx");
export const speakerModelPath = () => join(current.models, "wespeaker_en_voxceleb_resnet34_LM.onnx");
