// photos.jpeg for macOS — catalog, thumbnails, file scanning and export writing.
import Foundation

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
    static let writableExtensions: Set<String> = ["jpg", "jpeg", "png", "webp", "tif", "tiff", "json", "mp4", "mov"]

    let fm = FileManager.default
    let root: URL
    var catalogURL: URL { root.appendingPathComponent("catalog.json") }
    var thumbsURL: URL { root.appendingPathComponent("thumbs", isDirectory: true) }
    private var lastBackup = Date.distantPast

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
