#!/bin/sh
# Checks the tattle-transcribe helper on this Mac (§4.1): the fixture's first 30 s of host audio with live text, plus one
# clip of its first line (with 300 ms either side, as the engine cuts it). Needs macOS 26, npm run build:transcribe, and npm run fixtures.
BIN=native/transcribe/.build/release/tattle-transcribe
WAV=fixtures/conversation/host.wav
FAILS=0
TMP=$(mktemp)
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }

if [ ! -x "$BIN" ]; then echo "FAIL  the helper is not built: run npm run build:transcribe"; exit 1; fi
if [ ! -f "$WAV" ]; then echo "FAIL  no fixture: run npm run fixtures"; exit 1; fi

# 1. On-device speech recognition is available and its model is installed.
STATUS=$("$BIN" --status)
if echo "$STATUS" | grep -q '"available":true'; then pass "1. available: $STATUS"
else fail "1. not available: $STATUS"; fi
if ! echo "$STATUS" | grep -q '"installed":true'; then
  echo "      installing the model..."
  "$BIN" --install | tail -1
fi

# 2. Frames in, JSON lines out: 30 s of audio in 100 ms frames, then a clip of line 1 (script.json).
OUT=$(node --input-type=module -e '
import fs from "node:fs";
const wav = fs.readFileSync(process.argv[1]);
const line = JSON.parse(fs.readFileSync("fixtures/conversation/script.json", "utf8")).lines.find((l) => l.stream === "host");
const header = (kind) => { const b = Buffer.alloc(8); b.write("PTRX", 0); b[4] = kind; b[5] = 0; return b; };
const frames = [];
for (let i = 0; i < 300; i++) {
  const pcm = wav.subarray(44 + i * 3200, 44 + (i + 1) * 3200);
  const h = Buffer.alloc(12); h.writeDoubleLE(i * 100, 0); h.writeUInt32LE(pcm.length / 2, 8);
  frames.push(header(0), h, pcm);
}
const id = Buffer.from("u_1");
const clip = wav.subarray(44 + Math.round((line.startMs - 300) * 16) * 2, 44 + Math.round((line.endMs + 300) * 16) * 2);
const a = Buffer.alloc(4); a.writeUInt32LE(id.length, 0);
const n = Buffer.alloc(4); n.writeUInt32LE(clip.length / 2, 0);
frames.push(header(2), a, id, n, clip);
process.stdout.write(Buffer.concat(frames));
console.error(JSON.stringify({ line }));
' "$WAV" 2>/dev/null | "$BIN" --live 2>/dev/null)
echo "$OUT" | node -e '
const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const kinds = lines.map((l) => l.type);
const firstLive = kinds.findIndex((k) => k === "volatile" || k === "final");
const clip = lines.find((l) => l.type === "clip");
// Word times come only with final results: a volatile result is one run over the whole unsettled range.
const runs = lines.filter((l) => l.stream === "host" && l.type === "final").flatMap((l) => l.runs);
const welcome = runs.find((r) => /welcome/i.test(r.text));
const out = { ready: kinds[0] === "ready", live: firstLive > 0, clip: clip ?? null, welcomeEndMs: welcome?.endMs ?? null };
console.log(JSON.stringify(out));
' > "$TMP"
R=$(cat "$TMP")
if echo "$R" | grep -q '"ready":true'; then pass "2. ready first"; else fail "2. no ready line: $R"; fi
if echo "$R" | grep -q '"live":true'; then pass "3. live text (volatile/final lines)"; else fail "3. no live text: $R"; fi
if echo "$R" | grep -qi '"text":"[^"]*welcome'; then pass "4. clip: $(echo "$R" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).clip.text)')"
else fail "4. clip text missing or wrong: $R"; fi
# 5. Times line up with the audio: "Welcome" is said just after 1.0 s in the fixture, so it ends between 1.0 and 2.0 s.
if node -e "const r=$R; process.exit(r.welcomeEndMs > 1000 && r.welcomeEndMs < 2000 ? 0 : 1)"; then pass "5. word times line up (\"Welcome\" ends at $(node -e "console.log($R.welcomeEndMs)") ms)"
else fail "5. word times do not line up with the audio: $R"; fi
rm -f "$TMP"

[ "$FAILS" -eq 0 ] && echo "\nALL PASS" || echo "\n$FAILS FAILED"
exit "$FAILS"
