// photos.jpeg for macOS — JS ⇄ native bridge (window.webkit.messageHandlers.pj).
// Every call is { method, args } and is answered with a reply value or an error string.
import AppKit
import WebKit
import UniformTypeIdentifiers

final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var app: AppDelegate?
    private let io = DispatchQueue(label: "pj.bridge.io", qos: .userInitiated)

    init(app: AppDelegate) { self.app = app }

    /// The watched folder, when one is set (Preferences → Watched folder).
    private var watch: FolderWatch?

    /// Open streaming writes (video export): handle -> (file, final path). Only touched on the io queue.
    private var writers: [Int: (FileHandle, String)] = [:]
    private var writeSeq = 0

    typealias Reply = (Any?, String?) -> Void

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping Reply) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "Malformed bridge message"); return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        // Always answer on the main thread.
        let reply: Reply = { value, error in
            DispatchQueue.main.async {
                if let error = error { replyHandler(nil, error) } else { replyHandler(value ?? NSNull(), nil) }
            }
        }
        handle(method, args, reply)
    }

    private func background(_ reply: @escaping Reply, _ work: @escaping () throws -> Any?) {
        io.async {
            do { reply(try work(), nil) } catch { reply(nil, error.localizedDescription) }
        }
    }

    private var window: NSWindow? { app?.window }

    private func handle(_ method: String, _ a: [String: Any], _ reply: @escaping Reply) {
        let store = Storage.shared
        switch method {
        case "openFiles":
            let panel = NSOpenPanel()
            panel.title = "Import Photos"
            panel.prompt = "Import"
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = true
            panel.allowedContentTypes = [.image, .rawImage, .movie, .video] +
                ["braw", "r3d", "ari", "arx", "crm", "nev", "mxf", "insv", "lrv"].compactMap { UTType(filenameExtension: $0) }
            present(panel) { urls in
                self.background(reply) { store.scan(paths: urls.map { $0.path }) }
            } cancelled: { reply([], nil) }

        case "openFolder":
            let panel = NSOpenPanel()
            panel.title = "Import Folder"
            panel.prompt = "Import"
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            present(panel) { urls in
                self.background(reply) {
                    let result: [String: Any] = ["folder": urls.first?.path ?? "", "files": store.scan(paths: urls.map { $0.path })]
                    return result
                }
            } cancelled: {
                let empty: [String: Any] = ["folder": "", "files": [Any]()]
                reply(empty, nil)
            }

        case "scanPaths":
            let paths = a["paths"] as? [String] ?? []
            background(reply) { store.scan(paths: paths) }

        case "stat":
            let p = a["path"] as? String ?? ""
            background(reply) {
                guard let attrs = try? FileManager.default.attributesOfItem(atPath: p) else { return NSNull() }
                let result: [String: Any] = ["size": (attrs[.size] as? NSNumber)?.intValue ?? 0,
                                             "mtime": ((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000]
                return result
            }

        case "loadCatalog":
            background(reply) {
                if let json = store.loadCatalog() { return json }
                return NSNull()
            }

        case "saveCatalog":
            let json = a["json"] as? String ?? ""
            background(reply) {
                try store.saveCatalog(json)
                return true
            }

        case "saveThumb":
            let id = a["id"] as? String ?? "", b64 = a["data"] as? String ?? ""
            background(reply) {
                guard let data = Data(base64Encoded: b64) else { throw PJError.message("Bad thumbnail data") }
                try data.write(to: store.thumbURL(id), options: .atomic)
                return true
            }

        case "modelStatus":
            background(reply) { store.modelStatus() }

        case "modelFetch":
            let name = a["name"] as? String ?? ""
            background(reply) { try store.modelFetch(name) }

        case "cleanStore":
            let keep = a["keep"] as? [String] ?? [], remove = a["remove"] as? Bool ?? false
            background(reply) { store.cleanStore(keep: keep, remove: remove) }

        case "listBackups":
            background(reply) { store.listBackups() }

        case "backupNow":
            background(reply) { try store.backupNow() }

        case "restoreBackup":
            let name = a["name"] as? String ?? ""
            background(reply) { try store.restoreBackup(name) }

        case "moveFile":
            let source = a["path"] as? String ?? "", dest = a["dest"] as? String ?? "", name = a["name"] as? String ?? ""
            background(reply) { try store.moveFile(source: source, destDir: dest, newName: name) }

        case "watchFolder":
            let folder = a["path"] as? String ?? ""
            watch?.stop()
            watch = nil
            if folder.isEmpty { reply(["watching": ""], nil); return }
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: folder, isDirectory: &isDir), isDir.boolValue else { reply(nil, "That folder is not there"); return }
            watch = FolderWatch(folder: folder) { [weak self] paths in self?.app?.sendEvent("watchFiles", ["paths": paths]) }
            reply(["watching": folder], nil)

        case "deleteThumb":
            let id = a["id"] as? String ?? ""
            background(reply) {
                try? FileManager.default.removeItem(at: store.thumbURL(id))
                return true
            }

        case "chooseDirectory":
            let panel = NSOpenPanel()
            panel.title = "Choose Export Folder"
            panel.prompt = "Choose"
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            if let p = a["path"] as? String, !p.isEmpty { panel.directoryURL = URL(fileURLWithPath: p) }
            present(panel) { urls in reply(urls.first?.path, nil) } cancelled: { reply(nil, nil) }

        case "writeFile":
            let path = a["path"] as? String ?? "", b64 = a["data"] as? String ?? "", mode = a["mode"] as? String ?? "unique"
            background(reply) {
                guard let data = Data(base64Encoded: b64) else { throw PJError.message("Bad file data") }
                if let written = try store.write(path: path, data: data, mode: mode) { return written }
                return NSNull()
            }

        // MARK: XMP sidecars (only <name>.xmp / <file>.xmp next to a catalog media file)
        case "sidecar":
            let op = a["op"] as? String ?? "", media = a["path"] as? String ?? ""
            let variant = a["variant"] as? String ?? "base", text = a["text"] as? String ?? ""
            background(reply) {
                guard media.hasPrefix("/"), Storage.isMedia(media) else { throw PJError.message("Not a media file") }
                let url = URL(fileURLWithPath: media)
                let dir = url.deletingLastPathComponent()
                let stem = variant == "full" ? url.lastPathComponent : url.deletingPathExtension().lastPathComponent
                let spellings = [stem + ".xmp", stem + ".XMP", stem + ".Xmp"].map { dir.appendingPathComponent($0) }
                let found = spellings.first { FileManager.default.fileExists(atPath: $0.path) }
                if op == "read" {
                    guard let f = found, let t = try? String(contentsOf: f, encoding: .utf8) else { return NSNull() }
                    return t
                }
                guard op == "write", text.utf8.count < 8 << 20 else { throw PJError.message("Bad sidecar request") }
                let target = found ?? spellings[0]
                try text.write(to: target, atomically: true, encoding: .utf8)
                return target.path
            }

        // MARK: large files & video
        case "fileSize":
            let p = a["path"] as? String ?? ""
            background(reply) { ((try? FileManager.default.attributesOfItem(atPath: p))?[.size] as? NSNumber)?.intValue ?? 0 }

        case "openWrite":
            let path = a["path"] as? String ?? "", mode = a["mode"] as? String ?? "unique"
            background(reply) {
                guard let url = try store.resolveTarget(path: path, mode: mode) else { return NSNull() }
                FileManager.default.createFile(atPath: url.path, contents: nil)
                let fh = try FileHandle(forWritingTo: url)
                try fh.truncate(atOffset: 0)
                self.writeSeq += 1
                self.writers[self.writeSeq] = (fh, url.path)
                return self.writeSeq
            }

        case "writeChunk", "writeAt":
            let h = a["handle"] as? Int ?? 0, b64 = a["data"] as? String ?? ""
            let offset = (a["offset"] as? NSNumber)?.uint64Value
            background(reply) {
                guard let w = self.writers[h] else { throw PJError.message("File is not open") }
                guard let data = Data(base64Encoded: b64) else { throw PJError.message("Bad data") }
                if method == "writeAt", let off = offset {
                    let end = try w.0.offset()
                    try w.0.seek(toOffset: off); try w.0.write(contentsOf: data); try w.0.seek(toOffset: end)
                } else { try w.0.write(contentsOf: data) }
                return true
            }

        case "closeWrite":
            let h = a["handle"] as? Int ?? 0
            background(reply) {
                guard let w = self.writers.removeValue(forKey: h) else { return NSNull() }
                try w.0.close()
                return w.1
            }

        case "videoTool":
            let op = a["op"] as? String ?? ""
            let tool = VideoTool.shared
            switch op {
            case "capabilities": reply(tool.capabilities(), nil)
            case "cancel": tool.cancel(a["jobId"] as? String ?? ""); reply(true, nil)
            case "proxy":
                let path = a["path"] as? String ?? "", job = a["jobId"] as? String ?? UUID().uuidString
                DispatchQueue.global(qos: .userInitiated).async {
                    var last = Date.distantPast
                    do {
                        let out = try tool.proxy(path: path, jobId: job) { frac, text in
                            guard Date().timeIntervalSince(last) > 0.25 else { return }
                            last = Date()
                            DispatchQueue.main.async { self.app?.sendEvent("videoProgress", ["jobId": job, "frac": frac, "text": text]) }
                        }
                        reply(["path": out], nil)
                    } catch { reply(nil, error.localizedDescription) }
                }
            default: reply(nil, "Unknown video op \(op)")
            }

        case "defaultExportDir":
            reply(store.defaultExportDir, nil)

        case "showInFolder":
            if let p = a["path"] as? String { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)]) }
            reply(true, nil)

        case "savePresetFile":
            let panel = NSSavePanel()
            panel.title = "Export Preset"
            panel.nameFieldStringValue = a["name"] as? String ?? "preset.json"
            panel.allowedContentTypes = [.json]
            let json = a["json"] as? String ?? ""
            presentSave(panel) { url in
                self.background(reply) {
                    try json.write(to: url, atomically: true, encoding: .utf8)
                    return true
                }
            } cancelled: { reply(false, nil) }

        case "openPresetFiles":
            let panel = NSOpenPanel()
            panel.title = "Import Presets"
            panel.allowsMultipleSelection = true
            panel.canChooseDirectories = false
            panel.allowedContentTypes = [.json]
            present(panel) { urls in
                self.background(reply) { urls.compactMap { try? String(contentsOf: $0, encoding: .utf8) } }
            } cancelled: { reply([], nil) }

        case "openTextFiles":
            let exts = (a["exts"] as? [String] ?? []).filter { ["cube", "xmp", "json", "pjpreset", "txt"].contains($0) }
            let panel = NSOpenPanel()
            panel.title = a["title"] as? String ?? "Open"
            panel.allowsMultipleSelection = true
            panel.canChooseDirectories = false
            panel.allowedContentTypes = exts.compactMap { UTType(filenameExtension: $0) }
            present(panel) { urls in
                self.background(reply) {
                    urls.filter { exts.contains($0.pathExtension.lowercased()) }.compactMap { url -> [String: Any]? in
                        guard let t = try? String(contentsOf: url, encoding: .utf8) else { return nil }
                        return ["name": url.lastPathComponent, "text": t]
                    }
                }
            } cancelled: { reply([Any](), nil) }

        case "saveTextFile":
            let ext = a["ext"] as? String ?? ""
            guard ["cube", "xmp", "json", "txt"].contains(ext) else { reply(nil, "Refusing to write this file type"); return }
            let panel = NSSavePanel()
            panel.title = "Save"
            panel.nameFieldStringValue = a["name"] as? String ?? "untitled.\(ext)"
            if let t = UTType(filenameExtension: ext) { panel.allowedContentTypes = [t] }
            let text = a["text"] as? String ?? ""
            presentSave(panel) { url in
                self.background(reply) {
                    let out = url.pathExtension.lowercased() == ext ? url : url.appendingPathExtension(ext)
                    try text.write(to: out, atomically: true, encoding: .utf8)
                    return out.path
                }
            } cancelled: { reply(nil, nil) }

        case "ready":
            app?.rendererDidBecomeReady()
            reply(true, nil)

        case "representedFile":
            app?.setRepresentedFile(a["path"] as? String)
            reply(true, nil)

        case "flushed", "backResult":
            reply(true, nil)

        default:
            reply(nil, "Unknown method \(method)")
        }
    }

    // MARK: Panels (sheets on the main window)

    private func present(_ panel: NSOpenPanel, done: @escaping ([URL]) -> Void, cancelled: @escaping () -> Void) {
        let handler: (NSApplication.ModalResponse) -> Void = { r in
            if r == .OK, !panel.urls.isEmpty { done(panel.urls) } else { cancelled() }
        }
        if let w = window { panel.beginSheetModal(for: w, completionHandler: handler) } else { handler(panel.runModal()) }
    }

    private func presentSave(_ panel: NSSavePanel, done: @escaping (URL) -> Void, cancelled: @escaping () -> Void) {
        let handler: (NSApplication.ModalResponse) -> Void = { r in
            if r == .OK, let url = panel.url { done(url) } else { cancelled() }
        }
        if let w = window { panel.beginSheetModal(for: w, completionHandler: handler) } else { handler(panel.runModal()) }
    }
}
