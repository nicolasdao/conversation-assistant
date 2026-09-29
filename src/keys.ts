// The two API keys, both optional (OpenAI's is required only when OpenAI transcribes; OpenRouter's only for fact-checking,
// labels, and Chat): where they are stored, how they are loaded, and how a key is checked before it is saved.
// Keys live in the environment (a shell variable or .env) or in a credentials file in the user's Library, outside
// the project folder, so they can never be committed. The environment wins. See docs/setup.md.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appSupportDir } from "./paths.ts";

export const KEY_ENV = { openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
export type KeyName = keyof typeof KEY_ENV;
export const KEY_NAMES = Object.keys(KEY_ENV) as KeyName[];

/** The environment for a child process (the capture helper, afconvert): everything but the API keys, which none needs. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of Object.values(KEY_ENV)) delete out[name];
  return out;
}

/** Where the page saves the keys: ~/Library/Application Support/Tattle/credentials.json (tests override it). */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TATTLE_CREDENTIALS || join(appSupportDir(), "credentials.json");
}

export interface KeyStatus {
  name: KeyName;
  env: string;
  set: boolean;
  /** `environment`: a shell variable or .env, which the page cannot change; `file`: saved from the page. */
  source: "environment" | "file" | null;
  /** The key's last 4 characters, never the key. */
  hint: string | null;
}

export class KeyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The keys of this process: the environment first, then the credentials file, copied into the environment. */
export class KeyStore {
  readonly path: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fromEnv = new Set<KeyName>();

  constructor(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.env = opts.env ?? process.env;
    this.path = opts.path ?? credentialsPath(this.env);
  }

  /** Call once at startup, before anything reads a key. */
  load(): this {
    const saved = this.read();
    for (const name of KEY_NAMES) {
      const v = this.env[KEY_ENV[name]]?.trim();
      if (v) this.fromEnv.add(name);
      else if (saved[name]) this.env[KEY_ENV[name]] = saved[name];
    }
    return this;
  }

  status(): KeyStatus[] {
    return KEY_NAMES.map((name) => {
      const v = this.env[KEY_ENV[name]]?.trim() ?? "";
      return {
        name, env: KEY_ENV[name], set: !!v,
        source: !v ? null : this.fromEnv.has(name) ? "environment" : "file",
        hint: v ? v.slice(-4) : null,
      };
    });
  }

  missing(): KeyName[] {
    return this.status().filter((s) => !s.set).map((s) => s.name);
  }

  /** Writes the file (only this macOS user can read it) and uses the keys at once, without a restart. */
  save(keys: Partial<Record<KeyName, string>>) {
    for (const name of Object.keys(keys) as KeyName[]) {
      if (this.fromEnv.has(name)) throw new KeyError(409, `${KEY_ENV[name]} is set in .env or your shell, which wins over the page: change it there`);
    }
    const next = { ...this.read(), ...keys };
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const body: Record<string, string> = {};
    for (const name of KEY_NAMES) if (next[name]) body[KEY_ENV[name]] = next[name]!;
    // written aside, then renamed: a crash never leaves half a file
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    for (const name of Object.keys(keys) as KeyName[]) this.env[KEY_ENV[name]] = keys[name];
  }

  private read(): Partial<Record<KeyName, string>> {
    if (!existsSync(this.path)) return {};
    // only this user may read it: a copy restored with wider permissions is tightened
    if ((statSync(this.path).mode & 0o077) !== 0) {
      try { chmodSync(this.path, 0o600); } catch { /* not ours to change */ }
    }
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      console.error(`${this.path} is not valid JSON: ignored, so the page asks for the keys again`);
      return {};
    }
    const out: Partial<Record<KeyName, string>> = {};
    for (const name of KEY_NAMES) {
      const v = (json as Record<string, unknown>)?.[KEY_ENV[name]];
      if (typeof v === "string" && v.trim()) out[name] = v.trim();
    }
    return out;
  }
}

/** For the command-line tools: fills the environment from the credentials file. */
export function loadKeys(): KeyStore {
  return new KeyStore().load();
}

// ---------- checking a key before it is saved ----------

export interface KeyCheck {
  /** False: the key is refused and nothing is saved. */
  ok: boolean;
  message: string;
  /** Saved, with something worth knowing (no credit limit, no credit yet, could not be checked). */
  warning?: string;
}

/** Catches the usual paste mistakes before any network call. */
export function keyFormatProblem(name: KeyName, key: string): string | null {
  if (!key) return "Paste the key.";
  if (/\s/.test(key)) return "A key has no spaces or line breaks: copy it again.";
  if (key.length < 20 || key.length > 400) return "This does not look like a whole key: copy it again.";
  if (name === "openai" && key.startsWith("sk-or-")) return "This is an OpenRouter key: paste it in the OpenRouter field.";
  if (name === "openrouter" && key.startsWith("sk-") && !key.startsWith("sk-or-")) return "This looks like an OpenAI key: OpenRouter keys start with sk-or-.";
  return null;
}

/**
 * Asks the service whether the key works, for free. OpenRouter also reports the key's credit limit; OpenAI lists the
 * models the key can use. A key with no credit is not detectable here: OpenAI then answers 429 insufficient_quota on
 * the first real call (docs/gotchas.md).
 */
export async function checkKey(name: KeyName, key: string, opts: { fetch: typeof fetch; models?: string[] }): Promise<KeyCheck> {
  const format = keyFormatProblem(name, key);
  if (format) return { ok: false, message: format };
  const headers = { Authorization: `Bearer ${key}` };
  let res: Response;
  try {
    res = await opts.fetch(name === "openai" ? "https://api.openai.com/v1/models" : "https://openrouter.ai/api/v1/key", {
      headers, signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: true, message: "Saved", warning: "Could not reach the service to check it (are you online?). It was saved anyway." };
  }
  if (res.status === 401) {
    return { ok: false, message: name === "openai" ? "OpenAI does not accept this key. Check it was copied whole, and not revoked." : "OpenRouter does not accept this key. Check it was copied whole, and not deleted or disabled." };
  }
  if (!res.ok) return { ok: true, message: "Saved", warning: `The service answered HTTP ${res.status} when checking it. It was saved anyway.` };
  const body = await res.json().catch(() => null);
  if (name === "openrouter") {
    const d = body?.data ?? {};
    if (d.is_free_tier === true) {
      return { ok: true, message: "Key works", warning: "This account has no credit yet: add some at openrouter.ai/settings/credits, or Jev, fact-checking, and chat will fail." };
    }
    if (d.limit === null || d.limit === undefined) {
      return { ok: true, message: "Key works", warning: "This key has no credit limit. Setting one (for example $10) at openrouter.ai/settings/keys caps what a mistake can cost." };
    }
    const left = typeof d.limit_remaining === "number" ? `, $${d.limit_remaining.toFixed(2)} left` : "";
    return { ok: true, message: `Key works: limit $${d.limit}${left}` };
  }
  const ids = new Set<string>(Array.isArray(body?.data) ? body.data.map((m: { id?: unknown }) => String(m.id)) : []);
  const lacking = (opts.models ?? []).filter((m) => ids.size > 0 && !ids.has(m));
  if (lacking.length) return { ok: true, message: "Key works", warning: `This key cannot use ${lacking.join(" and ")}, which transcription needs. Check the project's model permissions at platform.openai.com.` };
  return { ok: true, message: "Key works" };
}

/** The setup routes' logic: what is missing, and saving keys that passed their check. */
export class KeySetup {
  /** `required`: the keys the app cannot run without, which follow the transcription engine (OpenAI's, or none). */
  constructor(private readonly store: KeyStore, private readonly opts: { fetch: typeof fetch; models: string[]; required?: () => KeyName[] }) {}

  status() {
    const keys = this.store.status();
    const required = this.opts.required?.() ?? ["openai"];
    return { configured: required.every((r) => keys.some((k) => k.name === r && k.set)), required, keys, path: this.store.path.replace(homedir(), "~") };
  }

  /** Checks every key given; saves them only if none is refused. */
  async save(body: unknown) {
    if (!body || typeof body !== "object") throw new KeyError(400, "expected { openai?, openrouter? }");
    const given: Partial<Record<KeyName, string>> = {};
    for (const name of KEY_NAMES) {
      const v = (body as Record<string, unknown>)[name];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string") throw new KeyError(400, `${name} must be a string`);
      given[name] = v.trim();
    }
    if (Object.keys(given).length === 0) throw new KeyError(400, "no key given");
    for (const s of this.store.status()) {
      if (given[s.name] !== undefined && s.source === "environment") {
        throw new KeyError(409, `${s.env} is set in .env or your shell, which wins over the page: change it there`);
      }
    }
    const checks: Partial<Record<KeyName, KeyCheck>> = {};
    await Promise.all((Object.keys(given) as KeyName[]).map(async (name) => {
      checks[name] = await checkKey(name, given[name]!, { fetch: this.opts.fetch, models: name === "openai" ? this.opts.models : [] });
    }));
    const saved = Object.values(checks).every((c) => c!.ok);
    if (saved) this.store.save(given);
    return { saved, checks, ...this.status() };
  }
}
