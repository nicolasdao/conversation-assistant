import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Label sets live in the user's Application Support; tests never touch it (read by src/paths.ts when it loads).
process.env.TATTLE_LABEL_SETS = mkdtempSync(join(tmpdir(), "tattle-labels-"));

// Tests never call the network (§7): every client takes its fetch through its constructor, and tests pass fakes.
globalThis.fetch = (() => {
  throw new Error("network disabled in tests");
}) as typeof fetch;

// Nor a WebSocket: live text takes its socket factory through its options too (docs/testing.md).
globalThis.WebSocket = class {
  constructor() {
    throw new Error("network disabled in tests");
  }
} as unknown as typeof WebSocket;
