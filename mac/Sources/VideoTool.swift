// photos.jpeg for macOS — "optimized media" for clips WebKit can't decode directly.
//   • AVFoundation: ProRes, ProRes RAW (on Macs whose AVFoundation decodes it), HEVC, H.264, DV …
//   • ffmpeg (Homebrew or bundled): MXF, MKV, AVI, AVCHD …
//   • Blackmagic RAW: tools/braw helper (built against the free Blackmagic RAW SDK) piped into ffmpeg
//   • RED R3D / ARRIRAW: the vendor's free command-line converter (REDline / ARRI Reference Tool) + ffmpeg
// The result is a high-bitrate H.264 MP4 the editor plays, grades and exports from.
import Foundation
import AVFoundation
import CryptoKit

final class VideoTool {
    static let shared = VideoTool()
    private let fm = FileManager.default
    private var exports: [String: AVAssetExportSession] = [:]
    private var processes: [String: [Process]] = [:]
    private var cancelled = Set<String>()
    private let lock = NSLock()

    // MARK: Tool discovery

    private func firstExisting(_ candidates: [String]) -> String? {
        candidates.first { fm.isExecutableFile(atPath: $0) }
    }
    private var toolsDir: String { Bundle.main.resourceURL!.appendingPathComponent("tools").path }
    var ffmpeg: String? {
        firstExisting(["\(toolsDir)/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"])
    }
    var brawHelper: String? {
        firstExisting(["\(toolsDir)/pj-braw", "/usr/local/bin/pj-braw", "/opt/homebrew/bin/pj-braw"])
    }
    var redline: String? {
        firstExisting(["/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline", "/usr/local/bin/REDline", "/opt/homebrew/bin/REDline"])
    }
    var artCmd: String? {
        firstExisting(["/Applications/ARRI Reference Tool.app/Contents/MacOS/art-cmd", "/usr/local/bin/art-cmd", "/opt/homebrew/bin/art-cmd"])
    }

    func capabilities() -> [String: Any] {
        [
            "avfoundation": true,
            "ffmpeg": ffmpeg != nil,
            "braw": brawHelper != nil && ffmpeg != nil,
            "converters": [
                "r3d": ["label": "RED R3D (REDline)", "available": redline != nil && ffmpeg != nil],
                "ari": ["label": "ARRIRAW (ARRI Reference Tool)", "available": artCmd != nil && ffmpeg != nil],
                "crm": ["label": "Canon Cinema RAW Light", "available": false],
                "nev": ["label": "Nikon N-RAW", "available": false]
            ]
        ]
    }

    // MARK: Proxies

    func proxyURL(for src: URL) -> URL {
        let attrs = (try? fm.attributesOfItem(atPath: src.path)) ?? [:]
        let sig = "\(src.path)|\((attrs[.size] as? NSNumber)?.int64Value ?? 0)|\((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
        let hash = SHA256.hash(data: Data(sig.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        let safe = src.lastPathComponent.replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "_", options: .regularExpression)
        return Storage.shared.optimizedMediaDir.appendingPathComponent("\(safe)-\(hash).mp4")
    }

    /// Creates (or reuses) optimized media. progress(fraction, text) may be called from any thread.
    func proxy(path: String, jobId: String, progress: @escaping (Double, String) -> Void) throws -> String {
        let src = URL(fileURLWithPath: path)
        guard fm.fileExists(atPath: path) else { throw PJError.message("File not found") }
        try fm.createDirectory(at: Storage.shared.optimizedMediaDir, withIntermediateDirectories: true)
        let out = proxyURL(for: src)
        if fm.fileExists(atPath: out.path) { return out.path }
        let tmp = out.deletingPathExtension().appendingPathExtension("part.mp4")
        try? fm.removeItem(at: tmp)
        let ext = src.pathExtension.lowercased()
        defer { lock.lock(); cancelled.remove(jobId); exports[jobId] = nil; processes[jobId] = nil; lock.unlock() }

        switch ext {
        case "braw":
            guard let helper = brawHelper, let ff = ffmpeg else {
                throw PJError.message("Blackmagic RAW needs the free Blackmagic RAW SDK helper and ffmpeg. See tools/braw/README.md (brew install ffmpeg; tools/braw/build.sh).")
            }
            let infoJSON = try run(jobId, helper, [path, "--info"], capture: true)
            guard let info = try JSONSerialization.jsonObject(with: Data(infoJSON.utf8)) as? [String: Any],
                  let w = info["width"] as? Int, let h = info["height"] as? Int else { throw PJError.message("Could not read this BRAW clip") }
            let fps = (info["fps"] as? Double) ?? 24, frames = (info["frames"] as? Int) ?? 0
            try pipe(jobId, helper, [path, "--decode"], ff,
                     ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "\(w)x\(h)", "-r", String(fps), "-i", "pipe:0"] + encodeArgs + [tmp.path],
                     frames: frames, label: "Decoding Blackmagic RAW", progress: progress)
        case "r3d", "ari", "arx":
            guard let ff = ffmpeg else { throw PJError.message("Converting this format needs ffmpeg (brew install ffmpeg).") }
            let work = fm.temporaryDirectory.appendingPathComponent("pj-conv-\(UUID().uuidString)")
            try fm.createDirectory(at: work, withIntermediateDirectories: true)
            defer { try? fm.removeItem(at: work) }
            let name = src.deletingPathExtension().lastPathComponent
            if ext == "r3d" {
                guard let red = redline else { throw PJError.message("RED R3D needs REDCINE-X PRO (free from RED) for its REDline converter.") }
                progress(0.02, "Converting with REDline")
                _ = try run(jobId, red, ["--i", path, "--o", work.appendingPathComponent(name).path, "--format", "1"], capture: false)
            } else {
                guard let art = artCmd else { throw PJError.message("ARRIRAW needs the ARRI Reference Tool (free from ARRI).") }
                progress(0.02, "Converting with ARRI Reference Tool")
                _ = try run(jobId, art, ["--mode", "process", "--input", path, "--output", work.appendingPathComponent("\(name).%07d.tif").path], capture: false)
            }
            let frames = try fm.contentsOfDirectory(atPath: work.path).filter { $0.range(of: "\\.(tif|tiff|dpx|exr)$", options: [.regularExpression, .caseInsensitive]) != nil }.sorted()
            guard let first = frames.first, let m = first.range(of: "\\d+(?=\\.\\w+$)", options: .regularExpression) else { throw PJError.message("The converter produced no frames") }
            let digits = first[m].count, startNum = Int(first[m]) ?? 0
            let pattern = work.appendingPathComponent(first.replacingCharacters(in: m, with: "%0\(digits)d")).path
            try runFFmpeg(jobId, ff, ["-y", "-framerate", "24", "-start_number", String(startNum), "-i", pattern] + encodeArgs + [tmp.path], frames: frames.count, progress: progress)
        case "crm", "nev":
            throw PJError.message(ext == "crm"
                ? "Canon Cinema RAW Light: export the clip from Canon's Cinema RAW Development as ProRes or DPX, then import that."
                : "Nikon N-RAW: export the clip from NX Studio / DaVinci Resolve as ProRes, then import that.")
        case "mxf", "mkv", "avi", "webm", "mts", "m2ts", "mpg", "mpeg", "m2v", "vob", "wmv", "flv", "mod", "tod", "ogv":
            if let ff = ffmpeg {
                try runFFmpeg(jobId, ff, ["-y", "-i", path, "-map", "0:v:0", "-map", "0:a:0?"] + encodeArgs + ["-c:a", "aac", "-b:a", "256k", tmp.path], frames: 0, progress: progress)
            } else {
                try avExport(jobId, src, tmp, progress: progress)
            }
        default:
            try avExport(jobId, src, tmp, progress: progress)
        }
        if isCancelled(jobId) { try? fm.removeItem(at: tmp); throw PJError.message("Cancelled") }
        try fm.moveItem(at: tmp, to: out)
        return out.path
    }

    private let encodeArgs = ["-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart"]

    func cancel(_ jobId: String) {
        lock.lock(); cancelled.insert(jobId)
        exports[jobId]?.cancelExport()
        processes[jobId]?.forEach { if $0.isRunning { $0.terminate() } }
        lock.unlock()
    }
    private func isCancelled(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled.contains(id) }

    // MARK: AVFoundation

    private func avExport(_ jobId: String, _ src: URL, _ dst: URL, progress: @escaping (Double, String) -> Void) throws {
        let asset = AVURLAsset(url: src)
        let presets = AVAssetExportSession.exportPresets(compatibleWith: asset)
        let preferred = [AVAssetExportPresetHighestQuality, AVAssetExportPreset3840x2160, AVAssetExportPresetHEVCHighestQuality, AVAssetExportPreset1920x1080]
        guard let preset = preferred.first(where: { presets.contains($0) }),
              let session = AVAssetExportSession(asset: asset, presetName: preset) else {
            throw PJError.message("macOS can't decode this clip (\(src.pathExtension.uppercased())). Install ffmpeg (brew install ffmpeg) or the camera maker's software.")
        }
        session.outputURL = dst
        session.outputFileType = session.supportedFileTypes.contains(.mp4) ? .mp4 : .mov
        session.shouldOptimizeForNetworkUse = true
        lock.lock(); exports[jobId] = session; lock.unlock()
        let done = DispatchSemaphore(value: 0)
        session.exportAsynchronously { done.signal() }
        while done.wait(timeout: .now() + 0.4) == .timedOut {
            progress(Double(session.progress), "Creating optimized media")
        }
        if session.status != .completed {
            throw PJError.message(session.error?.localizedDescription ?? "Conversion failed")
        }
    }

    // MARK: Processes

    @discardableResult
    private func run(_ jobId: String, _ cmd: String, _ args: [String], capture: Bool) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cmd)
        p.arguments = args
        let out = Pipe(), err = Pipe()
        p.standardOutput = capture ? out : FileHandle.nullDevice
        p.standardError = err
        lock.lock(); processes[jobId, default: []].append(p); lock.unlock()
        try p.run()
        let data = capture ? out.fileHandleForReading.readDataToEndOfFile() : Data()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let tail = String(decoding: errData.suffix(600), as: UTF8.self)
            throw PJError.message("\((cmd as NSString).lastPathComponent) failed: \(tail)")
        }
        return String(decoding: data, as: UTF8.self)
    }

    private func runFFmpeg(_ jobId: String, _ ff: String, _ args: [String], frames: Int, progress: @escaping (Double, String) -> Void) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ff)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        let err = Pipe()
        p.standardError = err
        lock.lock(); processes[jobId, default: []].append(p); lock.unlock()
        try p.run()
        try watchFFmpeg(err.fileHandleForReading, frames: frames, label: "Creating optimized media", progress: progress)
        p.waitUntilExit()
        if p.terminationStatus != 0 && !isCancelled(jobId) { throw PJError.message("ffmpeg failed (\(p.terminationStatus))") }
    }

    private func pipe(_ jobId: String, _ a: String, _ aArgs: [String], _ b: String, _ bArgs: [String], frames: Int, label: String, progress: @escaping (Double, String) -> Void) throws {
        let pa = Process(), pb = Process(), link = Pipe(), err = Pipe()
        pa.executableURL = URL(fileURLWithPath: a); pa.arguments = aArgs
        pb.executableURL = URL(fileURLWithPath: b); pb.arguments = bArgs
        pa.standardOutput = link; pa.standardError = FileHandle.nullDevice
        pb.standardInput = link; pb.standardOutput = FileHandle.nullDevice; pb.standardError = err
        lock.lock(); processes[jobId, default: []].append(contentsOf: [pa, pb]); lock.unlock()
        try pb.run(); try pa.run()
        try watchFFmpeg(err.fileHandleForReading, frames: frames, label: label, progress: progress)
        pa.waitUntilExit(); pb.waitUntilExit()
        if pb.terminationStatus != 0 && !isCancelled(jobId) { throw PJError.message("Conversion failed (\(pb.terminationStatus))") }
    }

    /// Parses ffmpeg's stderr for "Duration:" / "time=" / "frame=" to report progress.
    private func watchFFmpeg(_ fh: FileHandle, frames: Int, label: String, progress: @escaping (Double, String) -> Void) throws {
        var duration = 0.0
        func secs(_ s: Substring) -> Double {
            let p = s.split(separator: ":").compactMap { Double($0) }
            return p.count == 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0
        }
        while true {
            let d = fh.availableData
            if d.isEmpty { break }
            let s = String(decoding: d, as: UTF8.self)
            if let r = s.range(of: "Duration: [0-9:.]+", options: .regularExpression) { duration = secs(s[r].dropFirst(10)) }
            if frames > 0, let r = s.range(of: "frame= *[0-9]+", options: .regularExpression) {
                let n = Double(s[r].split(separator: "=").last!.trimmingCharacters(in: .whitespaces)) ?? 0
                progress(min(1, n / Double(frames)), label)
            } else if duration > 0, let r = s.range(of: "time=[0-9:.]+", options: .regularExpression) {
                progress(min(1, secs(s[r].dropFirst(5)) / duration), label)
            }
        }
    }
}
