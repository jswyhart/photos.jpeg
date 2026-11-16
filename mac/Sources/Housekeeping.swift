// photos.jpeg for macOS — catalog backups, renaming / moving originals, and the watched folder.
// The same behaviour as the Windows app (windows/Storage.cs, windows/FolderWatch.cs).
import Foundation

extension Storage {
    var backupsURL: URL { root.appendingPathComponent("backups", isDirectory: true) }

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = format
        return f
    }

    private func isJSON(_ url: URL) -> Bool {
        guard let d = try? Data(contentsOf: url) else { return false }
        return (try? JSONSerialization.jsonObject(with: d)) != nil
    }

    /// Before the first save of a session, the catalog as it was is copied to
    /// backups/catalog-YYYY-MM-DD.json (one per day, the newest 14 kept).
    func dailyBackup() {
        guard fm.fileExists(atPath: catalogURL.path), isJSON(catalogURL) else { return }   // never keep a damaged file as a backup
        let day = Storage.formatter("yyyy-MM-dd").string(from: Date())
        let target = backupsURL.appendingPathComponent("catalog-\(day).json")
        if fm.fileExists(atPath: target.path) { return }
        try? fm.createDirectory(at: backupsURL, withIntermediateDirectories: true)
        try? fm.copyItem(at: catalogURL, to: target)
        let names = (try? fm.contentsOfDirectory(atPath: backupsURL.path)) ?? []
        let daily = names.filter { $0.range(of: "^catalog-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.json$", options: .regularExpression) != nil }.sorted(by: >)
        for old in daily.dropFirst(14) { try? fm.removeItem(at: backupsURL.appendingPathComponent(old)) }
    }

    /// The catalog backups there are, newest first.
    func listBackups() -> [[String: Any]] {
        let names = ((try? fm.contentsOfDirectory(atPath: backupsURL.path)) ?? []).filter { $0.hasPrefix("catalog-") && $0.hasSuffix(".json") }
        var out: [(Double, [String: Any])] = []
        for name in names {
            let attrs = try? fm.attributesOfItem(atPath: backupsURL.appendingPathComponent(name).path)
            let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
            let time = ((attrs?[.modificationDate] as? Date) ?? Date.distantPast).timeIntervalSince1970 * 1000
            out.append((time, ["name": name, "size": size, "time": time]))
        }
        return out.sorted { $0.0 > $1.0 }.map { $0.1 }
    }

    /// A backup of the catalog as it is on disk right now (catalog-manual-<time>.json).
    func backupNow(kind: String = "manual") throws -> [String: Any] {
        guard fm.fileExists(atPath: catalogURL.path) else { throw PJError.message("There is no catalog to back up yet") }
        guard isJSON(catalogURL) else { throw PJError.message("The catalog on disk cannot be read, so it was not copied") }
        try fm.createDirectory(at: backupsURL, withIntermediateDirectories: true)
        let name = "catalog-\(kind)-\(Storage.formatter("yyyy-MM-dd-HHmmss").string(from: Date())).json"
        let target = backupsURL.appendingPathComponent(name)
        try? fm.removeItem(at: target)
        try fm.copyItem(at: catalogURL, to: target)
        return ["name": name]
    }

    /// Put a backup in the catalog's place. What is there now is kept first, so a restore can itself be undone.
    func restoreBackup(_ name: String) throws -> [String: Any] {
        guard name == (name as NSString).lastPathComponent, name.hasPrefix("catalog-"), name.hasSuffix(".json") else { throw PJError.message("That is not a catalog backup") }
        let src = backupsURL.appendingPathComponent(name)
        guard fm.fileExists(atPath: src.path) else { throw PJError.message("That backup is no longer there") }
        guard isJSON(src) else { throw PJError.message("That backup cannot be read, so the catalog was left as it is") }   // a damaged backup must not replace a working catalog
        var kept: Any = NSNull()
        if fm.fileExists(atPath: catalogURL.path) { kept = (try backupNow(kind: "before-restore"))["name"] ?? NSNull() }
        let data = try Data(contentsOf: src)
        try data.write(to: catalogURL, options: .atomic)
        return ["restored": name, "kept": kept]
    }

    /// Rename a photo or clip and/or move it to another folder, with its sidecar files (name.xmp, name.ext.xmp).
    /// Never overwrites: fails when something of that name is already there. The extension cannot be changed.
    func moveFile(source: String, destDir: String, newName: String) throws -> [String: Any] {
        guard fm.fileExists(atPath: source) else { throw PJError.message("The file is no longer where the catalog has it") }
        let trimmed = newName.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, newName == (newName as NSString).lastPathComponent, !newName.contains("/"), !newName.contains(":"), !newName.hasPrefix(".") else {
            throw PJError.message("“\(newName)” is not a usable file name")
        }
        let src = URL(fileURLWithPath: source).standardizedFileURL
        guard (newName as NSString).pathExtension.lowercased() == src.pathExtension.lowercased() else { throw PJError.message("The file's extension cannot be changed") }
        let fromDir = src.deletingLastPathComponent()
        let toDir = destDir.trimmingCharacters(in: .whitespaces).isEmpty ? fromDir : URL(fileURLWithPath: destDir, isDirectory: true).standardizedFileURL
        let target = toDir.appendingPathComponent(newName)
        // the usual Mac disk does not tell upper from lower case: a change of case alone is the same file
        let same = src.path.lowercased() == target.path.lowercased()
        if same && src.lastPathComponent == newName { return ["path": target.path, "name": newName, "folder": toDir.path, "moved": false] }
        if !same && fm.fileExists(atPath: target.path) { throw PJError.message("“\(newName)” already exists in that folder") }
        try fm.createDirectory(at: toDir, withIntermediateDirectories: true)
        // sidecars first found, then moved after the file itself went through
        let stem = fromDir.appendingPathComponent(src.deletingPathExtension().lastPathComponent).path
        let newStem = toDir.appendingPathComponent((newName as NSString).deletingPathExtension).path
        var side: [(String, String)] = []
        for (f, t) in [(stem + ".xmp", newStem + ".xmp"), (src.path + ".xmp", target.path + ".xmp")] where fm.fileExists(atPath: f) && !fm.fileExists(atPath: t) {
            side.append((f, t))
        }
        try fm.moveItem(at: src, to: target)
        for (f, t) in side { try? fm.moveItem(atPath: f, toPath: t) }
        return ["path": target.path, "name": newName, "folder": toDir.path, "moved": true]
    }
}

/// Watches one folder (and the folders inside it) for new photos and clips, so they can be added to the
/// catalog as a camera, a phone sync or a tethering program drops them there. The folder is looked through
/// every few seconds; a file is reported once its size has stopped changing — not while it is still being
/// written. What was already there when watching began is not reported.
final class FolderWatch {
    let folder: String
    private let report: ([String]) -> Void
    private let queue = DispatchQueue(label: "pj.folderwatch", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var known: Set<String> = []
    private var growing: [String: Int] = [:]          // path → size at the last look
    private var first = true

    init(folder: String, report: @escaping ([String]) -> Void) {
        self.folder = folder
        self.report = report
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .seconds(4), leeway: .seconds(1))
        t.setEventHandler { [weak self] in self?.look() }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    deinit { timer?.cancel() }

    private func look() {
        let fm = FileManager.default
        guard let walker = fm.enumerator(at: URL(fileURLWithPath: folder, isDirectory: true), includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return }
        var ready: [String] = []
        var seen = 0
        for case let url as URL in walker {
            seen += 1
            if seen > 200_000 { break }
            let path = url.path
            guard Storage.isMedia(path) else { continue }
            if known.contains(path) { continue }
            if first { known.insert(path); continue }
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values?.isRegularFile == true else { continue }
            let size = values?.fileSize ?? 0
            if size > 0, growing[path] == size {
                growing.removeValue(forKey: path)
                known.insert(path)
                ready.append(path)
            } else {
                growing[path] = size
            }
        }
        first = false
        if !ready.isEmpty {
            let paths = ready
            DispatchQueue.main.async { [report] in report(paths) }
        }
    }
}
