#!/bin/sh
# Checks the conversation-capture helper on this Mac (§4.14a). Steps 3 and 4 need you: speak, then stay silent with earbuds in.
BIN=native/capture/.build/release/conversation-capture
FAILS=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }
level() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8").trim().split("\n").pop()); console.log(j[process.argv[1]]?.[process.argv[2]] ?? -120)' "$1" "$2"; }

if [ ! -x "$BIN" ]; then echo "FAIL  the helper is not built: run npm run build:capture"; exit 1; fi

# 1. A built-in input device is listed.
if "$BIN" --list-devices | grep -q '"transport":"builtin"'; then pass "1. --list-devices lists a built-in input device"
else fail "1. --list-devices lists no built-in input device"; fi

# 2. System audio: a ping played twice reaches the tap.
(sleep 0.8; afplay /System/Library/Sounds/Ping.aiff; afplay /System/Library/Sounds/Ping.aiff) &
OUT=$("$BIN" --probe 3 --no-mic 2>/dev/null)
wait
PEAK=$(echo "$OUT" | level remote peakDbfs)
if node -e "process.exit($PEAK > -40 ? 0 : 1)"; then pass "2. system audio peak ${PEAK} dBFS"
else fail "2. system audio peak ${PEAK} dBFS: grant System Audio Recording to your terminal in System Settings → Privacy & Security"; fi

# 3. Microphone: say a sentence.
printf "\n3. Say a sentence out loud after pressing Enter (3 s)... "; read _
OUT=$("$BIN" --probe 3 --no-system 2>/dev/null)
PEAK=$(echo "$OUT" | level host peakDbfs)
if node -e "process.exit($PEAK > -40 ? 0 : 1)"; then pass "3. microphone peak ${PEAK} dBFS"
else fail "3. microphone peak ${PEAK} dBFS: grant Microphone to your terminal in System Settings → Privacy & Security"; fi

# 4. Isolation: earbuds in, a video playing, the host silent.
printf "\n4. Put your earbuds in, start a video with sound, stay silent, then press Enter (5 s)... "; read _
OUT=$("$BIN" --probe 5 2>/dev/null)
RMS=$(echo "$OUT" | level host rmsDbfs)
RPEAK=$(echo "$OUT" | level remote peakDbfs)
if node -e "process.exit($RMS < -55 ? 0 : 1)"; then pass "4. microphone rms ${RMS} dBFS while the video played (remote peak ${RPEAK} dBFS)"
else fail "4. microphone rms ${RMS} dBFS: the mic hears the system audio or the room; use earbuds and stay silent"; fi

[ "$FAILS" -eq 0 ] && echo "\nALL PASS" || echo "\n$FAILS FAILED"
exit "$FAILS"
