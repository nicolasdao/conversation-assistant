import { existsSync, readFileSync } from "node:fs";

export const FIXTURE_DIR = "fixtures/conversation";

/** Tests that need models/ or fixtures/ fail with one actionable message. */
export function requireAssets(): void {
  const needed = [
    "models/silero_vad.onnx",
    "models/wespeaker_en_voxceleb_resnet34_LM.onnx",
    `${FIXTURE_DIR}/host.wav`,
    `${FIXTURE_DIR}/remote.wav`,
    `${FIXTURE_DIR}/script.json`,
  ];
  if (needed.some((p) => !existsSync(p))) throw new Error("run npm run models && npm run fixtures");
}

export interface ScriptLine {
  line: number; voice: string; stream: "host" | "remote"; text: string; startMs: number; endMs: number;
  expected: { claim: boolean; repeatOf?: number; hyperbole?: boolean; topicChange?: boolean };
}

export function loadScript(): { durationMs: number; lines: ScriptLine[] } {
  requireAssets();
  return JSON.parse(readFileSync(`${FIXTURE_DIR}/script.json`, "utf8"));
}
