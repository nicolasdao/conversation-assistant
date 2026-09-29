// The label-set library: the built-in sets shipped in config/labels/ (read-only) and the user's own, one `<id>.json`
// each in Application Support/Tattle/labels (src/paths.ts), shared by development and the Mac app. Plain files, no
// database. Every read and write is validated; a user file that fails is listed as broken, never crashes the app.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appPaths } from "../paths.ts";
import { checkLabelSet, countsOf, estimate, LABEL_FORMAT, type LabelSet } from "./model.ts";

/** A refused request: 400 invalid, 404 unknown, 409 built-in. The router maps `status` to the HTTP status. */
export class LabelSetError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

export interface LabelSetEntry {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  counts: { categories: number; scores: number; markers: number };
  /** About what Jev costs an hour to ask the set (src/labels/model.ts `estimate`); absent for a broken file. */
  perHourUsd?: number;
  /** Why a user file cannot be used; the rest of the entry is what could be read. */
  broken?: string;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** A set id from a name: "Sales calls" → "sales-calls". */
export function slug(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "labels";
}

export class LabelSetStore {
  constructor(private readonly opts: { builtInDir?: string; userDir?: string } = {}) {}

  get builtInDir(): string {
    return this.opts.builtInDir ?? join(appPaths().config, "labels");
  }

  get userDir(): string {
    return this.opts.userDir ?? appPaths().labelSets;
  }

  private files(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json") && ID.test(f.slice(0, -5))).sort();
  }

  private read(path: string): { set: LabelSet | null; raw: any; error?: string } {
    let raw: any;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      return { set: null, raw: null, error: `not readable JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    const r = checkLabelSet(raw);
    return r.ok ? { set: r.set, raw } : { set: null, raw, error: r.errors.join("; ") };
  }

  private builtIns(): LabelSet[] {
    // a broken built-in is a bug in the app itself: it is left out rather than offered
    return this.files(this.builtInDir).map((f) => this.read(join(this.builtInDir, f)).set).filter((s): s is LabelSet => !!s)
      .map((s) => ({ ...s, builtIn: true }));
  }

  private isBuiltIn(id: string): boolean {
    return existsSync(join(this.builtInDir, `${id}.json`));
  }

  /** Every set: the built-in ones first, then the user's by name; broken files too, marked. */
  list(): LabelSetEntry[] {
    const entry = (s: LabelSet): LabelSetEntry => ({
      id: s.id, name: s.name, description: s.description, builtIn: !!s.builtIn, counts: countsOf(s), perHourUsd: estimate(s).perHourUsd,
    });
    const user: LabelSetEntry[] = this.files(this.userDir).filter((f) => !this.isBuiltIn(f.slice(0, -5))).map((f) => {
      const id = f.slice(0, -5);
      const r = this.read(join(this.userDir, f));
      if (r.set) return entry({ ...r.set, id, builtIn: false });
      return {
        id, name: typeof r.raw?.name === "string" && r.raw.name.trim() ? r.raw.name : id,
        description: typeof r.raw?.description === "string" ? r.raw.description : "", builtIn: false,
        counts: { categories: arr(r.raw?.categories), scores: arr(r.raw?.scores), markers: arr(r.raw?.markers) }, broken: r.error,
      };
    });
    user.sort((a, b) => a.name.localeCompare(b.name));
    return [...this.builtIns().map(entry), ...user];
  }

  get(id: string): LabelSet {
    if (!ID.test(id)) throw new LabelSetError(404, `no label set ${id}`);
    const builtIn = join(this.builtInDir, `${id}.json`);
    if (existsSync(builtIn)) {
      const r = this.read(builtIn);
      if (!r.set) throw new LabelSetError(400, `the built-in label set ${id} is broken: ${r.error}`);
      return { ...r.set, builtIn: true };
    }
    const path = join(this.userDir, `${id}.json`);
    if (!existsSync(path)) throw new LabelSetError(404, `no label set ${id}`);
    const r = this.read(path);
    if (!r.set) throw new LabelSetError(400, `the label set ${id} cannot be used: ${r.error}`);
    return { ...r.set, id, builtIn: false };
  }

  /** Checks a set as the user would save it: their own, whatever id and `builtIn` it came with. */
  private validate(body: unknown, id: string): LabelSet {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new LabelSetError(400, "a label set is a JSON object");
    const { builtIn: _drop, ...rest } = body as Record<string, unknown>;
    const r = checkLabelSet({ format: LABEL_FORMAT, version: 1, ...rest, id });
    if (!r.ok) throw new LabelSetError(400, r.errors.join("\n"));
    return r.set;
  }

  private write(set: LabelSet): LabelSet {
    mkdirSync(this.userDir, { recursive: true });
    const path = join(this.userDir, `${set.id}.json`);
    const tmp = join(this.userDir, `.${set.id}.${process.pid}.${Date.now()}.tmp`);
    const { builtIn: _drop, ...out } = set;
    writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
    renameSync(tmp, path); // atomic: a crash never leaves half a file
    return { ...out, builtIn: false };
  }

  private freeId(name: string): string {
    const base = slug(name);
    const taken = (id: string) => this.isBuiltIn(id) || existsSync(join(this.userDir, `${id}.json`));
    let id = base;
    for (let n = 2; taken(id); n++) id = `${base}-${n}`;
    return id;
  }

  /** A name no other set has: "Sales", then "Sales (2)", "Sales (3)"… */
  private freeName(name: string): string {
    const names = new Set(this.list().map((s) => s.name.toLowerCase()));
    let out = name;
    for (let n = 2; names.has(out.toLowerCase()); n++) out = `${name} (${n})`;
    return out;
  }

  create(body: unknown): LabelSet {
    const name = typeof (body as any)?.name === "string" ? (body as any).name : "";
    return this.write(this.validate(body, this.freeId(name)));
  }

  update(id: string, body: unknown): LabelSet {
    if (this.isBuiltIn(id)) throw new LabelSetError(409, "the built-in label set cannot be changed: clone it to edit a copy");
    if (!ID.test(id) || !existsSync(join(this.userDir, `${id}.json`))) throw new LabelSetError(404, `no label set ${id}`);
    return this.write(this.validate(body, id));
  }

  remove(id: string): { deleted: string } {
    if (this.isBuiltIn(id)) throw new LabelSetError(409, "the built-in label set cannot be deleted");
    const path = join(this.userDir, `${id}.json`);
    if (!ID.test(id) || !existsSync(path)) throw new LabelSetError(404, `no label set ${id}`);
    rmSync(path);
    return { deleted: id };
  }

  clone(id: string): LabelSet {
    const src = this.get(id);
    const name = this.freeName(`${src.name} copy`);
    return this.write(this.validate({ ...src, name }, this.freeId(name)));
  }

  /** A shared `.tattle-labels` file: validated, given a new id, and renamed if its name is taken. */
  import(body: unknown): LabelSet {
    if (!body || typeof body !== "object" || (body as any).format !== LABEL_FORMAT) {
      throw new LabelSetError(400, "this is not a Tattle label set file");
    }
    const name = typeof (body as any).name === "string" ? (body as any).name.trim() : "";
    const set = this.validate({ ...(body as object), name: name ? this.freeName(name) : name }, "import");
    return this.write({ ...set, id: this.freeId(set.name) });
  }
}

const arr = (v: unknown) => (Array.isArray(v) ? v.length : 0);
