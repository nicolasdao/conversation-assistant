// The user's settings that are not keys: today, which engine transcribes. Saved next to credentials.json, in
// ~/Library/Application Support/Tattle/settings.json, shared by the Mac app and npm run serve. See docs/transcription.md.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appSupportDir } from "./paths.ts";
import type { TranscriptionEngine } from "./pipeline/session.ts";
import { appleSpeechStatus, installAppleModel, type AppleStatus } from "./transcribe/apple.ts";

export interface Settings {
  transcriptionEngine?: TranscriptionEngine;
}

/** tests override it */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TATTLE_SETTINGS || join(appSupportDir(), "settings.json");
}

export class SettingsStore {
  constructor(readonly path = settingsPath()) {}

  read(): Settings {
    if (!existsSync(this.path)) return {};
    try {
      const json = JSON.parse(readFileSync(this.path, "utf8"));
      const e = json?.transcriptionEngine;
      return e === "apple" || e === "openai" ? { transcriptionEngine: e } : {};
    } catch {
      console.error(`${this.path} is not valid JSON: ignored`);
      return {};
    }
  }

  /** Written aside, then renamed, like credentials.json: a crash never leaves half a file. */
  save(patch: Settings): Settings {
    const next = { ...this.read(), ...patch };
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    return next;
  }
}

/**
 * Which engine runs, from what is saved, whether an OpenAI key is set, and whether Apple Speech can run here.
 * `persist` is what to save, or null when nothing should be: a saved choice is never overwritten, and neither a
 * failed availability check nor a Mac that lost Apple Speech changes what the user chose.
 */
export function resolveEngine(r: { saved?: TranscriptionEngine; openaiKeySet: boolean; apple: AppleStatus }): { engine: TranscriptionEngine; persist: TranscriptionEngine | null } {
  const checkFailed = !!r.apple.error;
  if (r.saved) {
    if (r.saved === "apple" && !r.apple.available && !checkFailed) return { engine: "openai", persist: null };
    return { engine: r.saved, persist: null };
  }
  // the upgrade path: someone already transcribing with OpenAI keeps it until they change it
  if (r.openaiKeySet) return { engine: "openai", persist: "openai" };
  // never send a macOS 26 user to the OpenAI screen because a check failed once: Apple, with its model in error
  if (checkFailed) return { engine: "apple", persist: null };
  return r.apple.available ? { engine: "apple", persist: "apple" } : { engine: "openai", persist: "openai" };
}

export type ModelState = "missing" | "installing" | "installed" | "error";

export interface TranscriptionStatus {
  engine: TranscriptionEngine;
  saved: TranscriptionEngine | null;
  apple: { available: boolean; reason: string | null; model: ModelState; fraction: number | null; error: string | null };
  openai: { keySet: boolean };
}

export interface TranscriptionSettingsDeps {
  store?: SettingsStore;
  openaiKeySet(): boolean;
  status?: (refresh: boolean) => Promise<AppleStatus>;
  install?: (onProgress: (f: number) => void) => Promise<void>;
  /** Each change of the status (engine, model state, install progress), for the page. */
  onChange?(s: TranscriptionStatus): void;
}

/** The engine setting as the server sees it: resolved at boot, changed from Settings, with Apple's model prepared in the background. */
export class TranscriptionSettings {
  private readonly store: SettingsStore;
  private saved: TranscriptionEngine | null = null;
  private effective: TranscriptionEngine = "openai";
  private apple: AppleStatus = { available: false, reason: null, locale: null, installed: false };
  private model: ModelState = "missing";
  private fraction: number | null = null;
  private error: string | null = null;
  private installing: Promise<void> | null = null;

  constructor(private readonly deps: TranscriptionSettingsDeps) {
    this.store = deps.store ?? new SettingsStore();
  }

  private statusOf(refresh: boolean) {
    return (this.deps.status ?? ((r) => appleSpeechStatus({ refresh: r })))(refresh);
  }

  /** Resolves the engine (saving the first choice) and starts preparing Apple's model when it is the engine. */
  async init(): Promise<TranscriptionStatus> {
    this.saved = this.store.read().transcriptionEngine ?? null;
    this.apple = await this.statusOf(false);
    const r = resolveEngine({ saved: this.saved ?? undefined, openaiKeySet: this.deps.openaiKeySet(), apple: this.apple });
    this.effective = r.engine;
    if (r.persist) this.saved = this.store.save({ transcriptionEngine: r.persist }).transcriptionEngine ?? null;
    this.model = this.apple.error ? "error" : this.apple.installed ? "installed" : "missing";
    this.error = this.apple.error ? `Could not check on-device speech recognition: ${this.apple.error}` : null;
    if (this.effective === "apple" && this.model === "missing") void this.install();
    return this.status();
  }

  get engine(): TranscriptionEngine {
    return this.effective;
  }

  /** Apple's model is ready (true for OpenAI, which has none). */
  get ready(): boolean {
    return this.effective === "openai" || this.model === "installed";
  }

  status(): TranscriptionStatus {
    return {
      engine: this.effective, saved: this.saved,
      apple: { available: this.apple.available, reason: this.apple.reason, model: this.model, fraction: this.fraction, error: this.error },
      openai: { keySet: this.deps.openaiKeySet() },
    };
  }

  private changed() {
    this.deps.onChange?.(this.status());
  }

  /** Saves the choice. The caller checks what may refuse it (on air, no key, unavailable). */
  async set(engine: TranscriptionEngine): Promise<TranscriptionStatus> {
    this.saved = this.store.save({ transcriptionEngine: engine }).transcriptionEngine ?? null;
    this.effective = engine;
    if (engine === "apple" && this.model !== "installed" && this.model !== "installing") void this.install();
    this.changed();
    return this.status();
  }

  /** Downloads and installs the model (once at a time), then checks it again. */
  install(): Promise<void> {
    if (this.installing) return this.installing;
    this.model = "installing";
    this.fraction = 0;
    this.error = null;
    this.changed();
    const run = (this.deps.install ?? ((p) => installAppleModel(p)))((f) => { this.fraction = f; this.changed(); })
      .then(async () => {
        this.apple = await this.statusOf(true);
        this.model = this.apple.installed ? "installed" : "error";
        if (!this.apple.installed) this.error = this.apple.error ?? "the model did not install";
      })
      .catch((e) => {
        this.model = "error";
        this.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.installing = null;
        this.fraction = null;
        this.changed();
      });
    this.installing = run;
    return run;
  }

  /** Whether Apple Speech can be chosen here (it cannot on macOS < 26 or without the helper). */
  get appleAvailable(): boolean {
    return this.apple.available || !!this.apple.error;
  }

  get appleReason(): string | null {
    return this.apple.reason;
  }
}
