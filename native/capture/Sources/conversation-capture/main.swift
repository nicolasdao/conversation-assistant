// conversation-capture: captures the built-in microphone (host) and a global Core Audio tap of all system output (remote),
// and writes framed 16 kHz PCM16 to stdout. Status goes to stderr as JSON lines.
//
//   conversation-capture --list-devices
//   conversation-capture [--mic builtin|<uid>] [--no-mic] [--no-system] [--tap apps|global]
//   conversation-capture --probe <seconds>
import Darwin
import Foundation

signal(SIGPIPE, SIG_IGN)

func status(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    FileHandle.standardError.write(data + Data("\n".utf8))
}

func fail(_ message: String, code: Int32) -> Never {
    status(["type": "error", "message": message])
    exit(code)
}

// ---------- arguments ----------

var listDevices = false
var micSpec = "builtin"
var useMic = true
var useSystem = true
var probeSeconds: Double?
// `apps` (default): the tap follows the apps playing sound. `global`: the old global tap, which can make other apps hang
// when they start a microphone. CONVERSATION_CAPTURE_TAP=global sets it through the engine, which passes no flag.
var tapMode = ProcessInfo.processInfo.environment["CONVERSATION_CAPTURE_TAP"] ?? "apps"
var args = CommandLine.arguments.dropFirst()
while let a = args.popFirst() {
    switch a {
    case "--list-devices": listDevices = true
    case "--mic":
        guard let v = args.popFirst() else { fail("--mic needs a value", code: 64) }
        micSpec = v
    case "--no-mic": useMic = false
    case "--no-system": useSystem = false
    case "--tap":
        guard let v = args.popFirst() else { fail("--tap needs apps or global", code: 64) }
        tapMode = v
    case "--probe":
        guard let v = args.popFirst().flatMap(Double.init), v > 0 else { fail("--probe needs a number of seconds", code: 64) }
        probeSeconds = v
    case "-h", "--help":
        print("usage: conversation-capture --list-devices | [--mic builtin|<uid>] [--no-mic] [--no-system] [--tap apps|global] | --probe <seconds>")
        exit(0)
    default: fail("unknown argument \(a)", code: 64)
    }
}

if listDevices {
    for d in Devices.inputs() {
        let obj: [String: Any] = ["uid": d.uid, "name": d.name, "transport": d.transport, "isDefault": d.isDefault]
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }
    }
    exit(0)
}

if tapMode != "apps" && tapMode != "global" { fail("--tap must be apps or global", code: 64) }
if !useMic && !useSystem { fail("nothing to capture: both --no-mic and --no-system", code: 64) }

// ---------- sinks ----------

/// Binary frames on stdout: "PCAP", stream (0 host, 1 remote), 3 reserved bytes, float64 sessionMs, uint32 n, n × int16.
final class StdoutSink: FrameSink {
    func frame(stream: UInt8, sessionMs: Double, samples: [Int16]) {
        var out = Data(capacity: 20 + samples.count * 2)
        out.append(contentsOf: Array("PCAP".utf8))
        out.append(contentsOf: [stream, 0, 0, 0])
        var ms = sessionMs.bitPattern.littleEndian
        withUnsafeBytes(of: &ms) { out.append(contentsOf: $0) }
        var n = UInt32(samples.count).littleEndian
        withUnsafeBytes(of: &n) { out.append(contentsOf: $0) }
        samples.withUnsafeBufferPointer { buf in
            for s in buf {
                var le = s.littleEndian
                withUnsafeBytes(of: &le) { out.append(contentsOf: $0) }
            }
        }
        out.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let w = Darwin.write(1, raw.baseAddress! + off, raw.count - off)
                if w < 0 {
                    if errno == EINTR { continue }
                    exit(0) // the engine closed the pipe
                }
                off += w
            }
        }
    }
}

final class NullSink: FrameSink {
    func frame(stream: UInt8, sessionMs: Double, samples: [Int16]) {}
}

// ---------- capture ----------

guard #available(macOS 14.2, *) else { fail("macOS 14.2 or later is required for Core Audio taps", code: 69) }

var streams: [UInt8] = []
if useMic { streams.append(0) }
if useSystem { streams.append(1) }
let sink: FrameSink = probeSeconds == nil ? StdoutSink() : NullSink()
let clock = ClockLock(streams: streams, sink: sink)

var mic: Mic?
var stopTap: (() -> Void)?

// Starting a device can block on a permission prompt. Say so, and give up rather than hang.
let startupDone = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
    if startupDone.wait(timeout: .now() + 5) == .timedOut {
        status(["type": "warning", "message": "capture has not started after 5 s: macOS may be waiting for the Microphone or System Audio Recording permission for your terminal (System Settings → Privacy & Security)"])
        if startupDone.wait(timeout: .now() + 25) == .timedOut { fail("capture did not start within 30 s (permission prompt pending?)", code: 5) }
    }
}
var started: [String: Any] = ["type": "started", "epochMs": clock.epochMs]

if useMic {
    guard let device = Devices.resolveMic(micSpec) else { fail("microphone \(micSpec) not found", code: 2) }
    let m = Mic(device: device)
    do { try m.start(clock: clock, stream: 0) } catch { fail("microphone: \(error)", code: 3) }
    mic = m
    started["host"] = ["device": device.name, "uid": device.uid]
}
if useSystem, #available(macOS 14.2, *) {
    let t = SystemTap(status: status, global: tapMode == "global")
    do { try t.start(clock: clock, stream: 1) } catch { fail("system audio: \(error)", code: 4) }
    stopTap = { t.stop() }
    started["remote"] = ["outputDevice": t.outputName, "outputKind": t.outputKind, "sampleRate": t.sampleRate, "tap": tapMode]
}
startupDone.signal()
clock.startWatchdog()
status(started)

let stopLock = NSLock()
var stopping = false
func shutdown(code: Int32 = 0) -> Never {
    stopLock.lock()
    if stopping { stopLock.unlock(); Thread.sleep(forTimeInterval: 10); exit(code) }
    stopping = true
    stopLock.unlock()
    mic?.stop()
    stopTap?()
    if let secs = probeSeconds {
        _ = secs
        var out: [String: Any] = [:]
        clock.queue.sync {
            if useMic { out["host"] = clock.levels[0]!.json }
            if useSystem { out["remote"] = clock.levels[1]!.json }
        }
        if let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }
    } else {
        clock.flush()
    }
    exit(code)
}

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { shutdown() }
    src.resume()
    signalSources.append(src)
}

if let secs = probeSeconds {
    DispatchQueue.main.asyncAfter(deadline: .now() + secs) { shutdown() }
} else {
    // Capture until stdin closes: the engine closes it to stop the helper.
    Thread.detachNewThread {
        while true {
            let d = FileHandle.standardInput.availableData
            if d.isEmpty { break }
        }
        DispatchQueue.main.async { shutdown() }
    }
}

dispatchMain()
