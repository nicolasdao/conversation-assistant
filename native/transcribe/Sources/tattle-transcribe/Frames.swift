import Foundation

/// A frame from the engine on stdin (little-endian). Header: "PTRX", kind u8, stream u8 (0 host, 1 remote), 2 reserved bytes.
///   0 audio (live text only):  startMs f64, count u32, count × PCM16 at 16 kHz mono
///   2 clip:                    idLen u32, id (UTF-8), count u32, samples (stream ignored)
///   3 clip in a file:          idLen u32, id, pathLen u32, path (UTF-8) of PCM16 samples, which the helper deletes
/// Kind 1 is retired: it cut a clip from audio streamed to the helper, which a --speed max replay sent faster than the
/// helper could read, so every clip waited behind it. The engine sends clips as files (kind 3): a clip is larger than
/// the pipe holds, so on stdin a busy engine delivered it over several turns of its event loop.
enum Frame {
    case audio(stream: Int, startMs: Double, samples: [Int16])
    case clip(id: String, samples: [Int16])
    case clipFile(id: String, path: String)
}

struct FrameError: Error, CustomStringConvertible {
    let description: String
}

/// Parses frames across partial reads.
final class FrameReader {
    private var buf = Data()
    private static let magic = Data("PTRX".utf8)
    private static let maxSamples = 16_000 * 120

    func push(_ data: Data, _ onFrame: (Frame) -> Void) throws {
        buf.append(data)
        var at = buf.startIndex
        while let (frame, next) = try parse(at) {
            onFrame(frame)
            at = next
        }
        buf.removeSubrange(buf.startIndex..<at)
    }

    private func parse(_ start: Data.Index) throws -> (Frame, Data.Index)? {
        var p = start
        guard buf.endIndex - p >= 8 else { return nil }
        guard buf[p..<p + 4] == Self.magic else { throw FrameError(description: "bad magic") }
        let kind = buf[p + 4]
        let stream = Int(buf[p + 5])
        guard stream <= 1 else { throw FrameError(description: "bad stream \(stream)") }
        p += 8
        func need(_ n: Int) -> Bool { buf.endIndex - p >= n }
        func f64() -> Double {
            var v: UInt64 = 0
            for i in 0..<8 { v |= UInt64(buf[p + i]) << (8 * UInt64(i)) }
            p += 8
            return Double(bitPattern: v)
        }
        func u32() -> Int {
            var v: UInt32 = 0
            for i in 0..<4 { v |= UInt32(buf[p + i]) << (8 * UInt32(i)) }
            p += 4
            return Int(v)
        }
        func samples(_ n: Int) -> [Int16] {
            var out = [Int16](repeating: 0, count: n)
            out.withUnsafeMutableBytes { dst in
                buf.withUnsafeBytes { src in
                    let off = p - buf.startIndex
                    dst.copyMemory(from: UnsafeRawBufferPointer(rebasing: src[off..<off + n * 2]))
                }
            }
            p += n * 2
            return out.map { Int16(littleEndian: $0) }
        }
        func string(_ n: Int) -> String {
            let s = String(decoding: buf[p..<p + n], as: UTF8.self)
            p += n
            return s
        }
        switch kind {
        case 0:
            guard need(12) else { return nil }
            let startMs = f64()
            let n = u32()
            guard n <= Self.maxSamples else { throw FrameError(description: "audio frame too large") }
            guard need(n * 2) else { return nil }
            return (.audio(stream: stream, startMs: startMs, samples: samples(n)), p)
        case 2:
            guard need(4) else { return nil }
            let idLen = u32()
            guard idLen <= 256 else { throw FrameError(description: "id too long") }
            guard need(idLen + 4) else { return nil }
            let id = string(idLen)
            let n = u32()
            guard n <= Self.maxSamples else { throw FrameError(description: "clip too large") }
            guard need(n * 2) else { return nil }
            return (.clip(id: id, samples: samples(n)), p)
        case 3:
            guard need(4) else { return nil }
            let idLen = u32()
            guard idLen <= 256 else { throw FrameError(description: "id too long") }
            guard need(idLen + 4) else { return nil }
            let id = string(idLen)
            let n = u32()
            guard n <= 4096 else { throw FrameError(description: "path too long") }
            guard need(n) else { return nil }
            return (.clipFile(id: id, path: string(n)), p)
        default:
            throw FrameError(description: "bad kind \(kind)")
        }
    }
}
