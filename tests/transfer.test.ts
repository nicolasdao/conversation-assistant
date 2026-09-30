import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readZipEntries, readZipEntry, writeZip, type ZipInput } from "../src/store/zip.ts";
import { discard, EXTENSION, exportEstimate, exportFileName, exportRecording, importRecording, MAX_UPLOAD_BYTES, saveUpload, TransferError } from "../src/store/transfer.ts";
import { wavHeader } from "../src/audio/wav.ts";
import { SessionLibrary } from "../src/store/library.ts";
import { createReadStream } from "node:fs";
import { Engine } from "../src/server/main.ts";
import { cleanTmpDirs, recording, tmpDir, withEnv } from "./fakes/index.ts";

const hasAfconvert = (() => { try { execFileSync("which", ["afconvert"]); return true; } catch { return false; } })();

describe("zip", () => {
  test("round trip: deflated data and stored files, with UTF-8 names and checksums", async () => {
    const d = mkdtempSync(join(tmpdir(), "zip-"));
    writeFileSync(join(d, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
    const out = join(d, "a.zip");
    await writeZip(out, [{ name: "manifest.json", data: Buffer.from('{"a":"é"}') }, { name: "audio/big.bin", path: join(d, "big.bin") }]);
    const entries = await readZipEntries(out);
    expect(entries.map((e) => [e.name, e.method])).toEqual([["manifest.json", 8], ["audio/big.bin", 0]]);
    expect((await readZipEntry(out, entries[0], 100)).toString()).toBe('{"a":"é"}');
    await expect(readZipEntry(out, entries[1], 10)).rejects.toThrow(/larger than expected/);
    // the system's own unzip reads it too
    expect(execFileSync("unzip", ["-l", out]).toString()).toContain("audio/big.bin");
  });
});

describe("export and import", () => {
  test("a file name that is safe everywhere", () => {
    expect(exportFileName("Episode 12: a/b", "x")).toBe(`Episode 12 a b${EXTENSION}`);
    expect(exportFileName(null, "20260925-120000")).toBe(`Recording 20260925-120000${EXTENSION}`);
  });

  test.skipIf(!hasAfconvert)("compressed audio: exports small, imports with the same length, and carries the versions", async () => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dir = recording(src);
    const est = exportEstimate(dir);
    expect(est.chats).toBe(1);
    expect(est.bytes.compressed).toBeLessThan(est.bytes.original);
    const out = await exportRecording(dir, "20260925-120000", { audio: "compressed", chats: false, app: { name: "tattle", version: "0.3.0" } });
    expect(out.fileName).toBe(`Episode 12 a b${EXTENSION}`);
    const names = (await readZipEntries(out.path)).map((e) => e.name);
    expect(names[0]).toBe("manifest.json");
    expect(names).toContain("audio/host.m4a");
    expect(names).not.toContain("data/chats.jsonl"); // chats stay private unless asked for
    expect(names.some((n) => n.endsWith(".wav"))).toBe(false);

    const dest = mkdtempSync(join(tmpdir(), "dest-"));
    const { id, manifest } = await importRecording(out.path, dest, "Episode 12.tattle");
    expect(id).toBe("20260925-120000");
    expect(manifest).toMatchObject({ app: { version: "0.3.0" }, recording: { recordedWith: "0.2.0", name: "Episode 12: a/b" }, audio: { format: "aac" } });
    for (const s of ["host", "remote"]) {
      const wav = readFileSync(join(dest, id, `${s}.wav`));
      expect(wav.length).toBe(44 + 3 * 16_000 * 2); // the app's own header, and exactly the original length
      expect(wav.toString("ascii", 36, 40)).toBe("data");
    }
    const lib = new SessionLibrary(dest);
    const summary = lib.get(id);
    expect(summary).toMatchObject({ name: "Episode 12: a/b", hasAudio: true, appVersion: "0.2.0", imported: { exportedWith: "0.3.0" } });
    expect(summary.durationMs).toBe(3000);
    expect(summary.costUsd).toBeCloseTo(0.25);

    // the same recording again is not added twice
    await expect(importRecording(out.path, dest, null)).rejects.toMatchObject({ status: 409, id: "20260925-120000" });
  });

  test("original audio is byte-exact; no audio still imports, without playback; chats come only when included", async () => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dir = recording(src);
    const dest = mkdtempSync(join(tmpdir(), "dest-"));
    const orig = await exportRecording(dir, "20260925-120000", { audio: "original", chats: true, app: { name: "p", version: "0.3.0" } });
    const a = await importRecording(orig.path, dest, null);
    expect(readFileSync(join(dest, a.id, "host.wav")).equals(readFileSync(join(dir, "host.wav")))).toBe(true);
    expect(existsSync(join(dest, a.id, "chats.jsonl"))).toBe(true);

    // a different recording with the same id gets a new one
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: "20260925-120000", mode: "live", startedAt: "2026-09-26T08:00:00Z" }));
    const none = await exportRecording(dir, "20260925-120000", { audio: "none", chats: false, app: { name: "p", version: "0.3.0" } });
    expect(statSync(none.path).size).toBeLessThan(5000);
    const b = await importRecording(none.path, dest, null);
    expect(b.id).toBe("20260925-120000-2");
    expect(existsSync(join(dest, b.id, "host.wav"))).toBe(false);
    const s = new SessionLibrary(dest).get(b.id);
    expect(s).toMatchObject({ hasAudio: false, appVersion: null });
    expect(s.durationMs).toBe(3000); // from the manifest
  });

  test("the same recording again can be imported as a named copy, from the same upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "lib-"));
    const dir = recording(root);
    const file = await exportRecording(dir, "20260925-120000", { audio: "none", chats: false, app: { name: "p", version: "0.3.0" } });
    const engine = new Engine({ sessionsDir: root });
    const first: any = await engine.transfer.importFile(createReadStream(file.path), "x.tattle");
    expect(first).toMatchObject({ already: true, summary: { id: "20260925-120000" } });
    expect(first.copyToken).toMatch(/^[0-9a-f-]{36}$/);
    await expect(engine.transfer.importCopy(first.copyToken, "  ")).rejects.toThrow(/name is required/);
    const copy: any = await engine.transfer.importCopy(first.copyToken, "Episode 12 (test import)");
    expect(copy.summary).toMatchObject({ id: "20260925-120000-2", name: "Episode 12 (test import)", imported: { exportedWith: "0.3.0" } });
    // the copy names itself by its own id, so a page showing the original switches to it when it opens
    const copyDir = join(root, "20260925-120000-2");
    expect(JSON.parse(readFileSync(join(copyDir, "session.json"), "utf8")).id).toBe("20260925-120000-2");
    const started = readFileSync(join(copyDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "session.started");
    expect(started.data.sessionId).toBe("20260925-120000-2");
    // the kept upload is used once
    await expect(engine.transfer.importCopy(first.copyToken, "Again")).rejects.toThrow(/expired/);
    expect(engine.library.list().map((r) => r.id).sort()).toEqual(["20260925-120000", "20260925-120000-2"]);
  });

  test("a copy imported before its ids were rewritten still opens as itself", () => {
    const root = mkdtempSync(join(tmpdir(), "lib-"));
    recording(root, "20260925-120000");
    const copy = recording(root, "20260925-120000-2");
    // what an earlier import left: the original's id in the copy's events
    writeFileSync(join(copy, "events.jsonl"), readFileSync(join(copy, "events.jsonl"), "utf8").split('"20260925-120000-2"').join('"20260925-120000"'));
    const events = new SessionLibrary(root).events("20260925-120000-2");
    expect(events.filter((e) => e.type.startsWith("session.")).map((e) => (e.data as any).sessionId)).toEqual(["20260925-120000-2", "20260925-120000-2"]);
  });

  test.each(["podcast-assistant-recording", "conversation-assistant-recording"])("imports a recording exported under an earlier name (%s)", async (format) => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const good = await exportRecording(recording(src), "20260925-120000", { audio: "none", chats: false, app: { name: "conversation-assistant", version: "0.3.0" } });
    const old = join(mkdtempSync(join(tmpdir(), "old-")), "old.zip");
    await writeZip(old, await Promise.all((await readZipEntries(good.path)).map(async (e) => {
      const data = await readZipEntry(good.path, e, 1 << 20);
      return { name: e.name, data: e.name === "manifest.json" ? Buffer.from(data.toString("utf8").replace("tattle-recording", format)) : data };
    })));
    const { id } = await importRecording(old, mkdtempSync(join(tmpdir(), "dest-")), null);
    expect(id).toBe("20260925-120000");
  });

  test("refuses what is not a recording, or is from a newer format; ignores unknown entries", async () => {
    const d = mkdtempSync(join(tmpdir(), "bad-"));
    const dest = mkdtempSync(join(tmpdir(), "dest-"));
    writeFileSync(join(d, "x.txt"), "hello");
    await expect(importRecording(join(d, "x.txt"), dest, null)).rejects.toThrow(/not a recording file/);
    const newer = join(d, "newer.zip");
    await writeZip(newer, [{ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "tattle-recording", formatVersion: 2, app: { version: "9.0.0" } })) }]);
    await expect(importRecording(newer, dest, null)).rejects.toThrow(/newer Tattle \(v9\.0\.0\)/);

    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dir = recording(src);
    const good = await exportRecording(dir, "20260925-120000", { audio: "none", chats: false, app: { name: "p", version: "0.3.0" } });
    const entries = await readZipEntries(good.path);
    const sneaky = join(d, "sneaky.zip");
    await writeZip(sneaky, [
      ...(await Promise.all(entries.map(async (e) => ({ name: e.name, data: await readZipEntry(good.path, e, 1 << 20) })))),
      { name: "data/../../evil.sh", data: Buffer.from("rm -rf /") },
      { name: "data/notes.txt", data: Buffer.from("x") },
    ]);
    const { id } = await importRecording(sneaky, dest, null);
    expect(existsSync(join(dest, "evil.sh"))).toBe(false);
    expect(existsSync(join(dest, id, "notes.txt"))).toBe(false);
    expect(TransferError).toBeTruthy();
  });

  test("a crafted manifest cannot make an import write gigabytes of silence", async () => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dest = mkdtempSync(join(tmpdir(), "dest-"));
    const good = await exportRecording(recording(src), "20260925-120000", { audio: "original", chats: false, app: { name: "p", version: "0.6.0" } });
    const work = mkdtempSync(join(tmpdir(), "craft-"));
    const inputs = await Promise.all((await readZipEntries(good.path)).map(async (e) => {
      const data = await readZipEntry(good.path, e, 1 << 26);
      if (e.name === "manifest.json") {
        const m = JSON.parse(data.toString("utf8"));
        for (const s of m.audio.streams) s.samples = 2_000_000_000; // about 4 GB of padding per stream, if believed
        return { name: e.name, data: Buffer.from(JSON.stringify(m)) };
      }
      if (e.name.startsWith("audio/")) { // audio is stored, not deflated, as the app writes it
        const p = join(work, e.name.replace("/", "-"));
        writeFileSync(p, data);
        return { name: e.name, path: p };
      }
      return { name: e.name, data };
    }));
    const crafted = join(work, "crafted.zip");
    await writeZip(crafted, inputs);
    const { id } = await importRecording(crafted, dest, null);
    const size = statSync(join(dest, id, "host.wav")).size;
    expect(size).toBeLessThanOrEqual(44 + 3 * 32_000 + 32_000); // the real 3 s, plus at most 1 s of padding
  });
});

describe("export and import, case by case", () => {
  afterAll(() => cleanTmpDirs());
  const APP = { name: "tattle", version: "1.0.1" };
  const E = (seq: number, type: string, data: Record<string, unknown>) => JSON.stringify({ seq, type, at: "x", data });

  /** An `afconvert` that always fails, first on the PATH. */
  function failingAfconvert(): string {
    const bin = tmpDir("bin-");
    writeFileSync(join(bin, "afconvert"), "#!/bin/sh\necho 'afconvert: cannot open file' >&2\nexit 3\n");
    chmodSync(join(bin, "afconvert"), 0o755);
    return `${bin}:${process.env.PATH ?? ""}`;
  }

  /** A .tattle built by hand: a manifest (merged over a valid one) and the entries given. */
  async function tattle(manifest: Record<string, unknown> | string | null, entries: ZipInput[] = []): Promise<string> {
    const file = join(tmpDir("craft-"), "x.tattle");
    const base = { format: "tattle-recording", formatVersion: 1, app: APP, exportedAt: "x", recording: { id: "20260925-120000", name: null, startedAt: "2026-09-25T12:00:00Z", durationMs: 0, mode: "live", recordedWith: null }, audio: { choice: "none", format: null, bitrate: null, streams: [] }, chats: false, files: [] };
    const m = manifest === null ? [] : [{ name: "manifest.json", data: Buffer.from(typeof manifest === "string" ? manifest : JSON.stringify({ ...base, ...manifest })) }];
    await writeZip(file, [...m, ...entries]);
    return file;
  }
  const data = (session: unknown = { id: "20260925-120000", startedAt: "2026-09-25T12:00:00Z" }, events = E(1, "session.started", { sessionId: "20260925-120000" })): ZipInput[] => [
    { name: "data/session.json", data: Buffer.from(typeof session === "string" ? session : JSON.stringify(session)) },
    { name: "data/events.jsonl", data: Buffer.from(events + "\n") },
  ];
  /** A stored WAV entry: a canonical header (rate and channels as given) and `samples` of PCM, or custom bytes. */
  function wavEntry(dir: string, name: string, o: { rate?: number; channels?: number; samples?: number; bytes?: Buffer }): ZipInput {
    const p = join(dir, name.replace("/", "-"));
    let b = o.bytes;
    if (!b) {
      const pcm = Buffer.alloc((o.samples ?? 160) * 2, 1);
      b = Buffer.concat([wavHeader(pcm.length, o.rate ?? 16_000), pcm]);
      if (o.channels) b.writeUInt16LE(o.channels, 22);
    }
    writeFileSync(p, b);
    return { name, path: p };
  }

  test("file names: control characters and reserved ones become spaces, 80 characters at most, never empty", () => {
    expect(exportFileName("a\u0000b\u001fc<d>e|f", "x")).toBe("a b c d e f.tattle");
    expect(exportFileName("n".repeat(100), "x")).toBe(`${"n".repeat(80)}.tattle`);
    expect(exportFileName("  ??  ", "20260925-120000")).toBe("Recording 20260925-120000.tattle");
  });

  test("the estimate: no audio, and chats counted once each, ignoring torn lines", () => {
    const dir = join(tmpDir("est-"), "r");
    mkdirSync(dir);
    writeFileSync(join(dir, "session.json"), "{}");
    expect(exportEstimate(dir)).toMatchObject({ chats: 0, hasAudio: false });
    const est0 = exportEstimate(dir);
    expect(est0.bytes.compressed).toBe(est0.bytes.none);
    expect(est0.bytes.original).toBe(est0.bytes.none);
    writeFileSync(join(dir, "chats.jsonl"), [
      JSON.stringify({ kind: "chat", op: "create", chat_id: "chat_1" }), JSON.stringify({ kind: "chat", op: "create", chat_id: "chat_1" }),
      JSON.stringify({ kind: "chat", op: "create", chat_id: "chat_2" }), JSON.stringify({ kind: "chat", op: "rename", chat_id: "chat_3" }),
      JSON.stringify({ kind: "chat_message", chat_id: "chat_4" }), "{ torn",
    ].join("\n"));
    expect(exportEstimate(dir).chats).toBe(2);
  });

  test("export: an unknown recording is a 404; the file goes to outDir; nothing is left behind", async () => {
    const root = tmpDir("src-");
    await expect(exportRecording(join(root, "nope"), "nope", { audio: "none", chats: false, app: APP })).rejects.toMatchObject({ status: 404, message: "unknown session nope" });
    const dir = recording(root);
    const out = tmpDir("out-");
    const r = await exportRecording(dir, "20260925-120000", { audio: "none", chats: true, app: APP, outDir: out });
    expect(r.path.startsWith(join(out, "pa-20260925-120000-"))).toBe(true);
    expect(readdirSync(out)).toEqual([basename(r.path)]); // the work folder is gone
    const entries = await readZipEntries(r.path);
    expect(entries.map((e) => e.name)).toContain("data/chats.jsonl");
    const m = JSON.parse((await readZipEntry(r.path, entries[0], 1 << 20)).toString());
    expect(m.audio).toEqual({ choice: "none", format: null, bitrate: null, streams: [] });
    expect(m.recording.durationMs).toBe(3000); // from the WAVs, even without them in the file
  });

  test("export without audio files: the duration from the last line's end, else 0; bare session files give nulls", async () => {
    const root = tmpDir("src-");
    const dir = join(root, "20260925-120000");
    mkdirSync(dir);
    writeFileSync(join(dir, "session.json"), "{}");
    writeFileSync(join(dir, "events.jsonl"), [E(1, "utterance", { endMs: 1500 }), E(2, "utterance", { endMs: 2750.5 })].join("\n") + "\n");
    const read = async (r: { path: string }) => JSON.parse((await readZipEntry(r.path, (await readZipEntries(r.path))[0], 1 << 20)).toString());
    const out = tmpDir("out-");
    const m = await read(await exportRecording(dir, "20260925-120000", { audio: "original", chats: false, app: APP, outDir: out }));
    expect(m.recording).toEqual({ id: "20260925-120000", name: null, startedAt: null, durationMs: 2751, mode: "unknown", recordedWith: null });
    expect(m.audio).toEqual({ choice: "original", format: null, bitrate: null, streams: [] });
    writeFileSync(join(dir, "events.jsonl"), "");
    expect((await read(await exportRecording(dir, "20260925-120000", { audio: "none", chats: false, app: APP, outDir: out }))).recording.durationMs).toBe(0);
  });

  test.fails("BUG §11.6: a recording without events.jsonl (the library lists it) still exports", async () => {
    const dir = join(tmpDir("src-"), "20260925-120000");
    mkdirSync(dir);
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: "20260925-120000", startedAt: "x" }));
    const r = await exportRecording(dir, "20260925-120000", { audio: "none", chats: false, app: APP, outDir: tmpDir("out-") });
    expect(r.bytes).toBeGreaterThan(0);
  });

  test("a failing afconvert: export and import answer 500, and leave nothing behind", async () => {
    const root = tmpDir("src-");
    const dir = recording(root);
    const out = tmpDir("out-");
    await withEnv({ PATH: failingAfconvert() }, async () => {
      const e = exportRecording(dir, "20260925-120000", { audio: "compressed", chats: false, app: APP, outDir: out });
      await expect(e).rejects.toMatchObject({ status: 500 });
      await expect(e).rejects.toThrow(/could not compress the audio \(afconvert\)/);
      expect(readdirSync(out)).toEqual([]);
      const work = tmpDir("craft-");
      const file = await tattle({ audio: { choice: "compressed", format: "aac", bitrate: 32000, streams: [{ stream: "host", samples: 160 }] } },
        [...data(), wavEntry(work, "audio/host.m4a", { bytes: Buffer.from("not really aac") })]);
      const dest = tmpDir("dest-");
      const i = importRecording(file, dest, null);
      await expect(i).rejects.toMatchObject({ status: 500 });
      await expect(i).rejects.toThrow(/could not decode the audio \(afconvert\)/);
      expect(readdirSync(dest)).toEqual([]); // the hidden work folder is removed
    });
  });

  test("import refuses: no manifest, a damaged one, another format, a version it cannot read, missing files, a missing file", async () => {
    const dest = tmpDir("dest-");
    const refused = async (file: string, message: string | RegExp) => {
      const p = importRecording(file, dest, null);
      await expect(p).rejects.toMatchObject({ status: 400 });
      await expect(p).rejects.toThrow(message);
    };
    await refused(await tattle(null, data()), "not a Tattle recording (no manifest.json). Is it a .tattle file?");
    await refused(await tattle("{ damaged"), "the recording's manifest is damaged");
    await refused(await tattle({ format: "other-app" }, data()), /^not a Tattle recording$/);
    await refused(await tattle({ formatVersion: 0, app: undefined }, data()), "this recording was exported by a newer Tattle (v?): update the app to import it");
    await refused(await tattle({ formatVersion: undefined }, data()), /newer Tattle/);
    await refused(await tattle({}, [data()[0]]), "the recording is incomplete (no session.json or events.jsonl)");
    await refused(await tattle({}, [data()[1]]), "the recording is incomplete");
    await refused(join(dest, "no-such-file.tattle"), /ENOENT/); // not a ZIP error: said as it is
    expect(readdirSync(dest)).toEqual([]);
  });

  test("import: an unsafe id gets a new one; a third recording with the same id gets -3; missing files are created", async () => {
    const dest = tmpDir("dest-");
    const unsafe = await importRecording(await tattle({ recording: { id: "../x", startedAt: "a" } }, data({ startedAt: "a" })), dest, "x.tattle");
    expect(unsafe.id).toMatch(/^\d{8}-\d{6}$/);
    const ids = [];
    for (const at of ["b", "c", "d"]) ids.push((await importRecording(await tattle({}, data({ id: "20260925-120000", startedAt: at })), dest, null)).id);
    expect(ids).toEqual(["20260925-120000", "20260925-120000-2", "20260925-120000-3"]);
    for (const f of ["utterances", "claims", "audits"]) expect(readFileSync(join(dest, ids[0], `${f}.jsonl`), "utf8")).toBe("");
    const imported = JSON.parse(readFileSync(join(dest, ids[1], "imported.json"), "utf8"));
    expect(imported).toMatchObject({ fileName: null, originalId: "20260925-120000", manifest: { format: "tattle-recording" } });
    expect(new Date(imported.importedAt).toISOString()).toBe(imported.importedAt);
    // renamed to its new id, in session.json and its session events
    expect(JSON.parse(readFileSync(join(dest, ids[2], "session.json"), "utf8")).id).toBe("20260925-120000-3");
    expect(readFileSync(join(dest, ids[2], "events.jsonl"), "utf8")).toContain('"sessionId":"20260925-120000-3"');
  });

  test("import as a copy, and a session.json without its own id", async () => {
    const dest = tmpDir("dest-");
    const file = await tattle({}, data({ startedAt: "2026-09-25T12:00:00Z" }));
    expect((await importRecording(file, dest, null)).id).toBe("20260925-120000");
    await expect(importRecording(file, dest, null)).rejects.toMatchObject({ status: 409, id: "20260925-120000" });
    expect((await importRecording(file, dest, null, { copy: true })).id).toBe("20260925-120000-2");
    // no id in session.json: the manifest's is the one its events carry
    const noId = await importRecording(file, dest, null, { copy: true });
    expect(JSON.parse(readFileSync(join(dest, noId.id, "session.json"), "utf8")).id).toBe("20260925-120000-3");
  });

  test("import: data larger than the limits is refused before it is read, and nothing is kept", async () => {
    const file = await tattle({}, [...data(), { name: "data/audits.jsonl", data: Buffer.from("[]\n") }]);
    // the directory claims the entry inflates to 600 MB
    const b = readFileSync(file);
    const cd = b.readUInt32LE(b.length - 22 + 16);
    let p = cd;
    for (let i = 0; i < 4; i++) {
      const nameLen = b.readUInt16LE(p + 28);
      if (b.toString("utf8", p + 46, p + 46 + nameLen) === "data/audits.jsonl") b.writeUInt32LE(600 * 1024 * 1024, p + 24);
      p += 46 + nameLen;
    }
    writeFileSync(file, b);
    const dest = tmpDir("dest-");
    await expect(importRecording(file, dest, null)).rejects.toMatchObject({ status: 400, message: "the recording's data is too large" });
    expect(readdirSync(dest)).toEqual([]);
  });

  test("import: a session.json that is not JSON fails as it is, before anything is written", async () => {
    const dest = tmpDir("dest-");
    await expect(importRecording(await tattle({}, data("{ not json")), dest, null)).rejects.toThrow(SyntaxError);
    expect(readdirSync(dest)).toEqual([]);
  });

  test("import of WAVs: the format must be the app's; there must be audio; the declared length trims or pads, by 1 s at most", async () => {
    const work = tmpDir("craft-");
    const dest = tmpDir("dest-");
    const streams = (n: number | null) => ({ audio: { choice: "original", format: "wav", bitrate: null, streams: n === null ? [] : [{ stream: "host", samples: n }] } });
    const importWav = async (wav: ZipInput, n: number | null, at: string) => importRecording(await tattle({ ...streams(n), recording: { id: "20260925-120000", startedAt: at } }, [...data({ startedAt: at }), wav]), dest, null);
    await expect(importWav(wavEntry(work, "audio/host.wav", { rate: 8000 }), 160, "a")).rejects.toMatchObject({ status: 400, message: "unexpected audio format after decoding" });
    await expect(importWav(wavEntry(work, "audio/host.wav", { channels: 2 }), 160, "a")).rejects.toMatchObject({ status: 400 });
    const noData = Buffer.concat([wavHeader(0, 16_000).subarray(0, 36), Buffer.from("LIST"), Buffer.alloc(4)]);
    await expect(importWav(wavEntry(work, "audio/host.wav", { bytes: noData }), 160, "a")).rejects.toMatchObject({ status: 400, message: "no audio data after decoding" });
    expect(readdirSync(dest)).toEqual([]);
    const size = async (n: number | null, samples: number, at: string) => statSync(join(dest, (await importWav(wavEntry(work, "audio/host.wav", { samples }), n, at)).id, "host.wav")).size;
    expect(await size(null, 160, "b")).toBe(44 + 320); // no declared length: as it is
    expect(await size(100, 160, "c")).toBe(44 + 200); // trimmed
    expect(await size(200, 160, "d")).toBe(44 + 400); // padded
    // a long stream padded past its data, in several chunks: the padding is silence
    const big = 524_288; // exactly 1 MiB of PCM
    const id = (await importWav(wavEntry(work, "audio/host.wav", { samples: big }), big + 16_000, "e")).id;
    const wav = readFileSync(join(dest, id, "host.wav"));
    expect(wav.length).toBe(44 + (big + 16_000) * 2);
    expect(wav.subarray(44 + big * 2).every((x) => x === 0)).toBe(true);
    expect(wav.readUInt8(44)).toBe(1);
  });

  test("uploads: saved to a private temporary file; too large is a 413 and nothing is kept; discard removes it", async () => {
    const tmp = tmpDir("os-tmp-");
    await withEnv({ TMPDIR: tmp }, async () => {
      async function* chunks() { yield Buffer.alloc(600); yield Buffer.alloc(600); }
      await expect(saveUpload(chunks(), 1000)).rejects.toMatchObject({ status: 413, message: "the file is too large (4 GB at most)" });
      expect(readdirSync(tmp)).toEqual([]);
      const p = await saveUpload(chunks(), 2000);
      expect(statSync(p).size).toBe(1200);
      expect(basename(p)).toBe("upload.tattle");
      await discard(p);
      expect(readdirSync(tmp)).toEqual([]);
      await discard(p); // gone already: no error
      async function* broken() { yield Buffer.alloc(10); throw new Error("the connection dropped"); }
      await expect(saveUpload(broken(), 2000)).rejects.toThrow("the connection dropped");
      expect(readdirSync(tmp)).toEqual([]);
    });
    expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 ** 3);
  });

  test.fails("BUG §11.18: a manifest without its recording is refused as a damaged file (400), not a raw TypeError", async () => {
    const dest = tmpDir("dest-");
    const p = importRecording(await tattle({ recording: undefined }, data()), dest, null);
    await expect(p).rejects.toMatchObject({ status: 400 });
  });

  test("a manifest without its recording fails, and leaves nothing behind", async () => {
    const dest = tmpDir("dest-");
    await expect(importRecording(await tattle({ recording: undefined }, data()), dest, null)).rejects.toThrow(TypeError);
    expect(readdirSync(dest)).toEqual([]);
  });

  test.fails("BUG §11.7: two different recordings with the same id and no start time are not taken for the same one", async () => {
    const dest = tmpDir("dest-");
    await importRecording(await tattle({ recording: { id: "20260925-120000" } }, data({ id: "20260925-120000", note: "first" })), dest, null);
    const second = await importRecording(await tattle({ recording: { id: "20260925-120000" } }, data({ id: "20260925-120000", note: "second" })), dest, null);
    expect(second.id).toBe("20260925-120000-2");
  });

  // the session.started event names the folder it was recorded in, which in the Mac app is under the home folder (§11.5)
  test("an exported recording does not carry the exporter's home folder", async () => {
    const root = tmpDir("src-");
    const dir = recording(root);
    const home = "/Users/private-person/Library/Application Support/Tattle/sessions/20260925-120000";
    writeFileSync(join(dir, "events.jsonl"), E(1, "session.started", { sessionId: "20260925-120000", mode: "live", s1Version: "s1@1", labelSetVersion: "a", dir: home }) + "\n");
    const r = await exportRecording(dir, "20260925-120000", { audio: "none", chats: false, app: APP, outDir: tmpDir("out-") });
    const entries = await readZipEntries(r.path);
    const events = (await readZipEntry(r.path, entries.find((e) => e.name === "data/events.jsonl")!, 1 << 20)).toString();
    expect(events).not.toContain("/Users/private-person");
  });

  test.fails("BUG §11.8: an original WAV whose header was never finalised imports whole, not cut to 1 s", async () => {
    const root = tmpDir("src-");
    const dir = recording(root); // 3 s streams
    for (const s of ["host", "remote"]) {
      const b = readFileSync(join(dir, `${s}.wav`));
      b.writeUInt32LE(0, 40); // the data size a crash leaves: never written
      writeFileSync(join(dir, `${s}.wav`), b);
    }
    const r = await exportRecording(dir, "20260925-120000", { audio: "original", chats: false, app: APP, outDir: tmpDir("out-") });
    const dest = tmpDir("dest-");
    const { id } = await importRecording(r.path, dest, null);
    expect(statSync(join(dest, id, "host.wav")).size).toBe(44 + 3 * 32_000);
  });
});
