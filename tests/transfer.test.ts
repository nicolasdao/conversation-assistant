import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readZipEntries, readZipEntry, writeZip } from "../src/store/zip.ts";
import { EXTENSION, exportEstimate, exportFileName, exportRecording, importRecording, TransferError } from "../src/store/transfer.ts";
import { SessionLibrary } from "../src/store/library.ts";
import { sumDevSpend } from "../src/budget.ts";
import { wavHeader } from "../src/audio/wav.ts";
import { createReadStream } from "node:fs";
import { Engine } from "../src/server/main.ts";

const hasAfconvert = (() => { try { execFileSync("which", ["afconvert"]); return true; } catch { return false; } })();

/** 3 s of a tone at 16 kHz, as the app writes its WAVs. */
function tone(seconds: number, hz: number): Buffer {
  const n = seconds * 16_000;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 16_000) * 8000), i * 2);
  return Buffer.concat([wavHeader(pcm.length, 16_000), pcm]);
}

function recording(root: string, id = "20260925-120000") {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id, app: { name: "conversation-assistant", version: "0.2.0" }, mode: "live", startedAt: "2026-09-25T12:00:00Z", streams: ["host", "remote"] }));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ name: "Episode 12: a/b" }));
  writeFileSync(join(dir, "events.jsonl"), [
    { seq: 1, type: "session.started", at: "x", data: { sessionId: id, mode: "live", s1Version: "s1@1", labelSetVersion: "a" } },
    { seq: 2, type: "utterance", at: "x", data: { id: "u_1", stream: "host", startMs: 0, endMs: 2500, speakerId: "spk_1", speakerName: "Nic", text: "Hello", tags: [] } },
    { seq: 3, type: "session.ended", at: "x", data: { sessionId: id, reason: "stopped" } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "jev_calls.jsonl"), JSON.stringify({ kind: "jev_call", cost_usd: 0.25 }) + "\n");
  writeFileSync(join(dir, "chats.jsonl"), JSON.stringify({ kind: "chat", op: "create", chat_id: "chat_1", title: "Private", model: "m", at: "x" }) + "\n");
  writeFileSync(join(dir, "host.wav"), tone(3, 440));
  writeFileSync(join(dir, "remote.wav"), tone(3, 660));
  return dir;
}

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
    // someone else's spend never counts toward this machine's development total
    expect(sumDevSpend(dest)).toBe(0);
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
