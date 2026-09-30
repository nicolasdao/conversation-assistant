import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { extractStoredEntry, readZipEntries, readZipEntry, writeZip, type ZipEntry } from "../src/store/zip.ts";
import { cleanTmpDirs, tmpDir } from "./fakes/index.ts";

// The minimal ZIP writer and reader behind .tattle files (src/store/zip.ts). Files from other people may be damaged
// or crafted, so every size and signature the reader trusts is checked.

afterAll(() => cleanTmpDirs());

/** A zip with one deflated entry and one stored entry; returns its path and entries. */
async function sample(now?: Date): Promise<{ path: string; entries: ZipEntry[]; dir: string }> {
  const dir = tmpDir("zip-");
  writeFileSync(join(dir, "audio.bin"), Buffer.from("stored bytes, as audio is"));
  const path = join(dir, "a.zip");
  await writeZip(path, [{ name: "data/é.json", data: Buffer.from('{"hello":"world"}') }, { name: "audio/a.bin", path: join(dir, "audio.bin") }], now);
  return { path, entries: await readZipEntries(path), dir };
}

/** A copy of the file with some bytes changed. */
function patched(path: string, edit: (b: Buffer) => void): string {
  const b = readFileSync(path);
  edit(b);
  const out = `${path}.patched.zip`;
  writeFileSync(out, b);
  return out;
}

/** The end-of-central-directory record's offset (no comment: the last 22 bytes). */
const eocd = (b: Buffer) => b.length - 22;

describe("writeZip", () => {
  test("returns the file's size, and names are UTF-8", async () => {
    const { path, entries } = await sample();
    const dir = tmpDir("zip-");
    expect(await writeZip(join(dir, "b.zip"), [{ name: "x", data: Buffer.from("x") }])).toBe(statSync(join(dir, "b.zip")).size);
    expect(entries.map((e) => [e.name, e.method])).toEqual([["data/é.json", 8], ["audio/a.bin", 0]]);
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  test("DOS times: a date before 1980 is stored as 1980; others as they are", async () => {
    const dates = async (d: Date) => {
      const { path } = await sample(d);
      const b = readFileSync(path);
      const cd = b.readUInt32LE(eocd(b) + 16);
      return { time: b.readUInt16LE(cd + 12), date: b.readUInt16LE(cd + 14) };
    };
    const old = await dates(new Date(1970, 0, 1, 0, 0, 0));
    expect(old.date >> 9).toBe(0); // 1980
    const d = await dates(new Date(2026, 8, 30, 14, 21, 58));
    expect([d.date >> 9, (d.date >> 5) & 15, d.date & 31]).toEqual([46, 9, 30]);
    expect([d.time >> 11, (d.time >> 5) & 63, (d.time & 31) * 2]).toEqual([14, 21, 58]);
  });

  test("more than 65,535 entries do not fit a ZIP without ZIP64", async () => {
    const dir = tmpDir("zip-");
    const many = Array.from({ length: 0x10000 }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(0) }));
    await expect(writeZip(join(dir, "many.zip"), many)).rejects.toThrow("the export is too large (4 GB at most)");
  }, 110_000);
});

describe("readZipEntries", () => {
  test("finds the directory behind a trailing comment", async () => {
    const { path } = await sample();
    const withComment = patched(path, () => {});
    const b = readFileSync(withComment);
    const comment = Buffer.from("a comment");
    b.writeUInt16LE(comment.length, eocd(b) + 20);
    writeFileSync(withComment, Buffer.concat([b, comment]));
    expect((await readZipEntries(withComment)).map((e) => e.name)).toEqual(["data/é.json", "audio/a.bin"]);
  });

  test("a directory past the end of the file: truncated", async () => {
    const { path } = await sample();
    const bad = patched(path, (b) => b.writeUInt32LE(b.length, eocd(b) + 16));
    await expect(readZipEntries(bad)).rejects.toThrow("the file is truncated");
  });

  test("a damaged directory entry signature", async () => {
    const { path } = await sample();
    const bad = patched(path, (b) => b.writeUInt32LE(0xdeadbeef, b.readUInt32LE(eocd(b) + 16)));
    await expect(readZipEntries(bad)).rejects.toThrow("the ZIP directory is damaged");
  });

  test("not a ZIP at all, and an empty file", async () => {
    const dir = tmpDir("zip-");
    writeFileSync(join(dir, "x"), "hello");
    writeFileSync(join(dir, "empty"), "");
    await expect(readZipEntries(join(dir, "x"))).rejects.toThrow("not a recording file (no ZIP directory)");
    await expect(readZipEntries(join(dir, "empty"))).rejects.toThrow("not a recording file (no ZIP directory)");
  });
});

describe("readZipEntry", () => {
  test("reads a deflated and a stored entry", async () => {
    const { path, entries } = await sample();
    expect((await readZipEntry(path, entries[0], 1000)).toString()).toBe('{"hello":"world"}');
    expect((await readZipEntry(path, entries[1], 1000)).toString()).toBe("stored bytes, as audio is");
  });

  test("refuses sizes it was not told to expect, before allocating", async () => {
    const { path, entries } = await sample();
    await expect(readZipEntry(path, entries[0], 5)).rejects.toThrow("data/é.json is larger than expected");
    await expect(readZipEntry(path, { ...entries[0], compressedSize: 5000 }, 1000)).rejects.toThrow("data/é.json: damaged entry");
    await expect(readZipEntry(path, { ...entries[1], compressedSize: 900 }, 1000)).rejects.toThrow("audio/a.bin: damaged entry"); // past the end of the file
  });

  test("a damaged local header, an unknown method, and a wrong checksum", async () => {
    const { path, entries } = await sample();
    const bad = patched(path, (b) => b.writeUInt32LE(0, entries[1].localOffset));
    await expect(readZipEntry(bad, entries[1], 1000)).rejects.toThrow("audio/a.bin: damaged entry");
    await expect(readZipEntry(path, { ...entries[1], method: 12 }, 1000)).rejects.toThrow("audio/a.bin: unsupported compression");
    await expect(readZipEntry(path, { ...entries[0], crc: (entries[0].crc ^ 1) >>> 0 }, 1000)).rejects.toThrow("data/é.json is damaged (checksum)");
    await expect(readZipEntry(path, { ...entries[1], size: entries[1].size - 1 }, 1000)).rejects.toThrow("audio/a.bin is damaged (checksum)");
  });
});

describe("extractStoredEntry", () => {
  test("copies a stored entry, checking its checksum", async () => {
    const { path, entries, dir } = await sample();
    await extractStoredEntry(path, entries[1], join(dir, "out.bin"));
    expect(readFileSync(join(dir, "out.bin"), "utf8")).toBe("stored bytes, as audio is");
  });

  test("refuses a deflated entry, a wrong checksum, and an entry that runs past the end", async () => {
    const { path, entries, dir } = await sample();
    await expect(extractStoredEntry(path, entries[0], join(dir, "o1"))).rejects.toThrow("data/é.json: expected an uncompressed entry");
    await expect(extractStoredEntry(path, { ...entries[1], crc: (entries[1].crc ^ 1) >>> 0 }, join(dir, "o2"))).rejects.toThrow("audio/a.bin is damaged (checksum)");
    await expect(extractStoredEntry(path, { ...entries[1], size: statSync(path).size + 10 }, join(dir, "o3"))).rejects.toThrow("audio/a.bin is truncated");
  });
});
