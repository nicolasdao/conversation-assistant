import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { crc32, deflateRawSync, inflateRaw } from "node:zlib";

// A minimal ZIP writer and reader for recording exports: stored (audio) and deflated (JSON) entries, UTF-8 names, no
// ZIP64 (every entry and the whole file stay under 4 GB). Large files are copied in chunks, never held in memory.

const CHUNK = 1 << 20;
const inflate = promisify(inflateRaw);
const MAX32 = 0xffffffff;

export interface ZipInput {
  name: string;
  /** A file on disk (stored as is), or bytes (deflated). */
  path?: string;
  data?: Buffer;
}

export interface ZipEntry { name: string; method: number; crc: number; compressedSize: number; size: number; localOffset: number }

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Writes `entries` to a new ZIP file at `out`; returns its size in bytes. */
export async function writeZip(out: string, entries: ZipInput[], now = new Date()): Promise<number> {
  const fh = await open(out, "w");
  const { time, date } = dosTime(now);
  const central: Buffer[] = [];
  let offset = 0;
  const write = async (b: Buffer) => { await fh.write(b); offset += b.length; };
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, "utf8");
      let crc = 0, size = 0, compressed: Buffer | null = null, method = 0;
      if (e.data) {
        crc = crc32(e.data);
        size = e.data.length;
        compressed = deflateRawSync(e.data, { level: 6 });
        method = 8;
      } else {
        // stored: a first pass for the checksum, so the header can carry it and the file is copied only once
        size = (await stat(e.path!)).size;
        const src = await open(e.path!, "r");
        try {
          const buf = Buffer.alloc(CHUNK);
          for (let pos = 0; pos < size;) {
            const { bytesRead } = await src.read(buf, 0, CHUNK, pos);
            if (!bytesRead) break;
            crc = crc32(buf.subarray(0, bytesRead), crc);
            pos += bytesRead;
          }
        } finally { await src.close(); }
      }
      const csize = compressed ? compressed.length : size;
      if (size > MAX32 || csize > MAX32 || offset > MAX32) throw new Error(`${e.name} is too large to export (4 GB at most)`);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(csize, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const at = offset;
      await write(local);
      await write(name);
      if (compressed) await write(compressed);
      else {
        const src = await open(e.path!, "r");
        try {
          const buf = Buffer.alloc(CHUNK);
          for (let pos = 0; pos < size;) {
            const { bytesRead } = await src.read(buf, 0, Math.min(CHUNK, size - pos), pos);
            if (!bytesRead) break;
            await write(buf.subarray(0, bytesRead));
            pos += bytesRead;
          }
        } finally { await src.close(); }
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(method, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(csize, 20);
      c.writeUInt32LE(size, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE(at, 42);
      central.push(c, name);
    }
    const cdStart = offset;
    for (const b of central) await write(b);
    if (offset > MAX32 || entries.length > 0xffff) throw new Error("the export is too large (4 GB at most)");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await write(end);
    return offset;
  } finally {
    await fh.close();
  }
}

export class ZipError extends Error {}

/** Lists a ZIP file's entries from its central directory. */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new ZipError("not a recording file (no ZIP directory)");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size) throw new ZipError("the file is truncated");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    for (let i = 0, p = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError("the ZIP directory is damaged");
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      out.push({
        method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16), compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24), localOffset: cd.readUInt32LE(p + 42), name: cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

async function dataStart(fh: import("node:fs/promises").FileHandle, e: ZipEntry): Promise<number> {
  const h = Buffer.alloc(30);
  await fh.read(h, 0, 30, e.localOffset);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`${e.name}: damaged entry`);
  return e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

/** Reads a deflated or stored entry into memory (for the small data files), checking its size and checksum. */
export async function readZipEntry(path: string, e: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (e.size > maxBytes) throw new ZipError(`${e.name} is larger than expected`);
  const fh = await open(path, "r");
  try {
    const start = await dataStart(fh, e);
    // the sizes come from the file, which may be crafted: check them before allocating anything
    if (e.compressedSize > maxBytes || start + e.compressedSize > (await fh.stat()).size) throw new ZipError(`${e.name}: damaged entry`);
    const raw = Buffer.alloc(e.compressedSize);
    await fh.read(raw, 0, e.compressedSize, start);
    let data: Buffer;
    if (e.method === 0) data = raw;
    // inflated off the main thread, so a large import never stalls a show on air
    else if (e.method === 8) data = await inflate(raw, { maxOutputLength: Math.max(1, e.size) });
    else throw new ZipError(`${e.name}: unsupported compression`);
    if (data.length !== e.size || (crc32(data) >>> 0) !== e.crc) throw new ZipError(`${e.name} is damaged (checksum)`);
    return data;
  } finally {
    await fh.close();
  }
}

/** Copies a stored entry (audio) to a file in chunks, checking its checksum. */
export async function extractStoredEntry(path: string, e: ZipEntry, dest: string): Promise<void> {
  if (e.method !== 0) throw new ZipError(`${e.name}: expected an uncompressed entry`);
  const fh = await open(path, "r");
  const out = await open(dest, "w");
  try {
    const start = await dataStart(fh, e);
    const buf = Buffer.alloc(CHUNK);
    let crc = 0;
    for (let done = 0; done < e.size;) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, e.size - done), start + done);
      if (!bytesRead) throw new ZipError(`${e.name} is truncated`);
      crc = crc32(buf.subarray(0, bytesRead), crc);
      await out.write(buf.subarray(0, bytesRead));
      done += bytesRead;
    }
    if ((crc >>> 0) !== e.crc) throw new ZipError(`${e.name} is damaged (checksum)`);
  } finally {
    await fh.close();
    await out.close();
  }
}
