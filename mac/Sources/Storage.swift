// photos.jpeg for macOS — catalog, thumbnails, file scanning and export writing.
import Foundation
import CryptoKit

enum PJError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let m) = self { return m }; return nil }
}

final class Storage {
    static let shared = Storage()

    static let rawExtensions: Set<String> = ["nef", "nrw", "gpr", "crw", "cr2", "cr3", "arw", "srf", "sr2", "dng", "orf", "rw2",
                                             "raf", "pef", "srw", "raw", "rwl", "erf", "3fr", "kdc", "dcr", "mrw", "mef", "mos", "iiq", "x3f"]
    static let standardExtensions: Set<String> = ["jpg", "jpeg", "jpe", "jfif", "png", "webp", "avif", "gif", "bmp", "tif", "tiff", "heic", "heif",
                                                  "hif", "jxl", "jp2", "j2k", "jpf", "jpx", "ico", "cur", "dib", "apng", "psd", "psb", "exr", "hdr", "pic", "pfm", "pbm", "pgm", "ppm", "pnm", "pam", "tga", "icb", "vda", "qoi"]
    static let videoExtensions: Set<String> = ["mp4", "mov", "m4v", "mkv", "webm", "mts", "m2ts", "mxf", "avi", "lrv", "360", "insv", "mpg", "mpeg", "m2v", "vob", "wmv", "flv", "3gp", "3g2", "mod", "tod", "dv", "ogv",
                                               "braw", "r3d", "ari", "arx", "crm", "nev"]
    static let imageExtensions = rawExtensions.union(standardExtensions)
    /// Everything the catalog can hold (photos + video)
    static let mediaExtensions = imageExtensions.union(videoExtensions)
    static let writableExtensions: Set<String> = ["jpg", "jpeg", "png", "webp", "tif", "tiff", "jxl", "dng", "json", "mp4", "mov"]

    let fm = FileManager.default
    let root: URL
    var catalogURL: URL { root.appendingPathComponent("catalog.json") }
    var thumbsURL: URL { root.appendingPathComponent("thumbs", isDirectory: true) }
    private var lastBackup = Date.distantPast
    private var dailyBackupDone = false

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        root = support.appendingPathComponent("photos.jpeg", isDirectory: true)
    }

    func prepare() {
        try? fm.createDirectory(at: thumbsURL, withIntermediateDirectories: true)
    }

    static func isImage(_ path: String) -> Bool {
        imageExtensions.contains((path as NSString).pathExtension.lowercased())
    }
    static func isMedia(_ path: String) -> Bool {
        mediaExtensions.contains((path as NSString).pathExtension.lowercased())
    }
    static func isVideo(_ path: String) -> Bool {
        videoExtensions.contains((path as NSString).pathExtension.lowercased())
    }
    static func isRaw(_ path: String) -> Bool {
        rawExtensions.contains((path as NSString).pathExtension.lowercased())
    }

    // MARK: Catalog

    func loadCatalog() -> String? {
        for url in [catalogURL, catalogURL.appendingPathExtension("bak")] {
            if let s = try? String(contentsOf: url, encoding: .utf8), !s.isEmpty { return s }
        }
        return nil
    }

    func saveCatalog(_ json: String) throws {
        if !dailyBackupDone { dailyBackupDone = true; dailyBackup() }      // see Housekeeping.swift
        if Date().timeIntervalSince(lastBackup) > 600, fm.fileExists(atPath: catalogURL.path) {
            lastBackup = Date()
            let bak = catalogURL.appendingPathExtension("bak")
            try? fm.removeItem(at: bak)
            try? fm.copyItem(at: catalogURL, to: bak)
        }
        try json.data(using: .utf8)!.write(to: catalogURL, options: .atomic)
    }

    // MARK: Thumbnails

    static func safeId(_ id: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        var out = ""
        for u in id.unicodeScalars.prefix(80) { out.unicodeScalars.append(allowed.contains(u) ? u : "_") }
        return out
    }
    func thumbURL(_ id: String) -> URL { thumbsURL.appendingPathComponent(Storage.safeId(id) + ".jpg") }

    // MARK: Models (a "lite" build leaves them out of the app and fetches each on first use)

    /// name → (size in bytes, SHA-256); the same table as windows/Models.cs
    static let models: [String: (size: Int, sha: String)] = [
        "u2netp.onnx": (4574861, "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"),
        "efficientvit-seg-b1-ade20k.onnx": (19312501, "d6013483203730a1b12c700013bd440231d6778064ffdb63b0582785e40e89a5"),
        "face_detection_yunet_2023mar.onnx": (232589, "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
        "face_recognition_sface_2021dec.onnx": (38696353, "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79")
    ]
    static let modelBase = "https://raw.githubusercontent.com/jswyhart/photos.jpeg/main/src/vendor/ml/"
    var modelsURL: URL { root.appendingPathComponent("models", isDirectory: true) }

    /// The downloaded copy of a model, or nil when there is none (or the name is not one of ours).
    func modelURL(_ name: String) -> URL? {
        guard Storage.models[name] != nil else { return nil }
        let u = modelsURL.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
    func modelStatus() -> [[String: Any]] {
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("web/vendor/ml", isDirectory: true)
        return Storage.models.map { name, v in
            let have = FileManager.default.fileExists(atPath: bundled.appendingPathComponent(name).path) || modelURL(name) != nil
            return ["name": name, "size": v.size, "have": have]
        }
    }
    /// Download one model from the app's repository, check its size and SHA-256, and keep it.
    func modelFetch(_ name: String) throws -> [String: Any] {
        guard let want = Storage.models[name], let url = URL(string: Storage.modelBase + name) else { throw PJError.message("That is not a model of this app") }
        if modelURL(name) != nil { return ["name": name, "ok": true] }
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw PJError.message("The download failed — is this Mac online?") }
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard data.count == want.size, sha == want.sha else { throw PJError.message("The downloaded file is not the one this app expects, so it was not kept") }
        try FileManager.default.createDirectory(at: modelsURL, withIntermediateDirectories: true)
        try data.write(to: modelsURL.appendingPathComponent(name), options: .atomic)
        return ["name": name, "ok": true]
    }

    /// Catalog clean-up: counts (and, when asked, removes) the files in the thumbnail store that no photo,
    /// mask, fill or face of the catalog refers to any more. Files written in the last ten minutes are left
    /// alone: something may be about to refer to them. (There is no RAW cache on the Mac: Core Image develops.)
    func cleanStore(keep ids: [String], remove: Bool) -> [String: Any] {
        let keep = Set(ids.map { Storage.safeId($0).lowercased() + ".jpg" })
        var thumbs = 0, thumbBytes = 0, orphans = 0, orphanBytes = 0, removed = 0
        let cutoff = Date().addingTimeInterval(-600)
        let files = (try? FileManager.default.contentsOfDirectory(at: thumbsURL, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])) ?? []
        for f in files {
            let v = try? f.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let size = v?.fileSize ?? 0
            thumbs += 1; thumbBytes += size
            if keep.contains(f.lastPathComponent.lowercased()) || (v?.contentModificationDate ?? Date()) > cutoff { continue }
            orphans += 1; orphanBytes += size
            if remove, (try? FileManager.default.removeItem(at: f)) != nil { removed += 1 }
        }
        return ["thumbs": thumbs, "thumbBytes": thumbBytes, "orphans": orphans, "orphanBytes": orphanBytes, "removed": removed,
                "rawFiles": 0, "rawBytes": 0, "rawRemoved": 0]
    }

    // MARK: Scanning

    func describe(_ url: URL) -> [String: Any]? {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]),
              values.isRegularFile == true else { return nil }
        return [
            "path": url.path,
            "name": url.lastPathComponent,
            "size": values.fileSize ?? 0,
            "mtime": (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
            "folder": url.deletingLastPathComponent().path
        ]
    }

    func scan(paths: [String], limit: Int = 50_000) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for p in paths {
            let url = URL(fileURLWithPath: p)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: p, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                guard let en = fm.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey],
                                             options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
                var found: [URL] = []
                for case let f as URL in en where Storage.isMedia(f.path) {
                    found.append(f)
                    if found.count + out.count >= limit { break }
                }
                found.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
                out.append(contentsOf: found.compactMap(describe))
            } else if Storage.isMedia(p), let d = describe(url) {
                out.append(d)
            }
            if out.count >= limit { break }
        }
        return out
    }

    // MARK: Export

    /// Writes data; mode is "unique" (pick a new name), "overwrite" or "skip". Returns the final path, or nil when skipped.
    func write(path: String, data: Data, mode: String) throws -> String? {
        guard path.hasPrefix("/") else { throw PJError.message("Invalid export path") }
        let url = URL(fileURLWithPath: path)
        guard Storage.writableExtensions.contains(url.pathExtension.lowercased()) else {
            throw PJError.message("Refusing to write this file type")
        }
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var target = url
        if fm.fileExists(atPath: target.path) {
            switch mode {
            case "skip": return nil
            case "overwrite": break
            default:
                let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
                var i = 2
                repeat {
                    target = url.deletingLastPathComponent().appendingPathComponent("\(base)-\(i).\(ext)")
                    i += 1
                } while fm.fileExists(atPath: target.path)
            }
        }
        try data.write(to: target, options: .atomic)
        return target.path
    }

    /// Unique / overwrite / skip resolution for streaming writes. Returns nil when skipped.
    func resolveTarget(path: String, mode: String) throws -> URL? {
        guard path.hasPrefix("/") else { throw PJError.message("Invalid export path") }
        let url = URL(fileURLWithPath: path)
        guard Storage.writableExtensions.contains(url.pathExtension.lowercased()) else { throw PJError.message("Refusing to write this file type") }
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard fm.fileExists(atPath: url.path) else { return url }
        switch mode {
        case "skip": return nil
        case "overwrite": return url
        default:
            let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
            var i = 2, target = url
            repeat { target = url.deletingLastPathComponent().appendingPathComponent("\(base)-\(i).\(ext)"); i += 1 } while fm.fileExists(atPath: target.path)
            return target
        }
    }

    var optimizedMediaDir: URL { root.appendingPathComponent("optimized-media", isDirectory: true) }

    var defaultExportDir: String {
        let pictures = fm.urls(for: .picturesDirectory, in: .userDomainMask).first ?? fm.homeDirectoryForCurrentUser
        return pictures.appendingPathComponent("photos.jpeg Exports").path
    }
}
