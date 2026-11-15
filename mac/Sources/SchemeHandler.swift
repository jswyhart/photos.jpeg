// photos.jpeg for macOS — serves the UI and binary data over the pj:// scheme.
//   pj://app/<file>                              bundled web app (Resources/web)
//   pj://app/__pj/file?path=…[&start=&length=]   original media bytes (whole file or a byte range)
//   pj://app/__pj/media?path=…                   video for <video>, with HTTP Range / 206 support
//   pj://app/__pj/thumb/<id>.jpg                 cached thumbnails
//   pj://app/__pj/raw?path=…                     RAW file rendered by Core Image (JPEG)
//   pj://app/__pj/image?path=…                   any ImageIO format (HEIC, JPEG 2000, JPEG XL, EXR, PSD…) as JPEG
import Foundation
import WebKit
import UniformTypeIdentifiers

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let webRoot: URL = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true).standardizedFileURL
    private var active = Set<ObjectIdentifier>()
    private let queue = DispatchQueue(label: "pj.scheme", qos: .userInitiated, attributes: .concurrent)
    /// Largest body sent for an open-ended media range; the player asks for more as it needs it.
    private let mediaChunk = 8 << 20

    private struct Reply {
        var status: Int
        var data: Data
        var mime: String
        var headers: [String: String] = [:]
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        active.insert(key)
        guard let url = task.request.url else { finish(task, Reply(status: 400, data: Data(), mime: "text/plain")); return }
        let range = task.request.value(forHTTPHeaderField: "Range")
        queue.async { [weak self] in
            guard let self = self else { return }
            let r = self.respond(to: url, range: range)
            DispatchQueue.main.async { self.finish(task, r) }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task))
    }

    private func finish(_ task: WKURLSchemeTask, _ r: Reply) {
        let key = ObjectIdentifier(task)
        guard active.contains(key), let url = task.request.url else { return }
        active.remove(key)
        var headers = ["Content-Type": r.mime, "Content-Length": String(r.data.count), "Access-Control-Allow-Origin": "*"]
        // Thumbnails are versioned (?v=) so they can be cached; everything else — including the
        // app's own HTML/JS/CSS — must never be cached, or a rebuilt app keeps running old code.
        headers["Cache-Control"] = url.path.hasPrefix("/__pj/thumb/") ? "max-age=31536000" : "no-store, no-cache, must-revalidate"
        if !url.path.hasPrefix("/__pj/thumb/") { headers["Pragma"] = "no-cache" }
        // Cross-origin isolation enables SharedArrayBuffer, so render workers share decoded pixels.
        headers["Cross-Origin-Opener-Policy"] = "same-origin"
        headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        for (k, v) in r.headers { headers[k] = v }
        let response = HTTPURLResponse(url: url, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(r.data)
        task.didFinish()
    }

    private func query(_ url: URL, _ name: String) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == name })?.value
    }

    /// Paths the page may read: catalog media, and optimized media made by this app.
    private func readable(_ p: String) -> Bool {
        Storage.isMedia(p) || p.hasPrefix(Storage.shared.optimizedMediaDir.path)
    }

    private func readRange(_ path: String, _ offset: UInt64, _ length: Int) throws -> Data {
        let fh = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        defer { try? fh.close() }
        try fh.seek(toOffset: offset)
        return try fh.read(upToCount: length) ?? Data()
    }

    private func fileSize(_ path: String) -> UInt64 {
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    private func respond(to url: URL, range: String?) -> Reply {
        let path = url.path
        do {
            if path == "/__pj/file" {
                guard let p = query(url, "path"), readable(p) else { return Reply(status: 403, data: Data(), mime: "text/plain") }
                if let s = query(url, "start"), let l = query(url, "length"), let start = UInt64(s), let len = Int(l) {
                    return Reply(status: 200, data: try readRange(p, start, len), mime: "application/octet-stream")
                }
                let data = try Data(contentsOf: URL(fileURLWithPath: p), options: .mappedIfSafe)
                return Reply(status: 200, data: data, mime: mimeType(for: p))
            }
            if path == "/__pj/media" {
                guard let p = query(url, "path"), readable(p) else { return Reply(status: 403, data: Data(), mime: "text/plain") }
                let size = fileSize(p)
                guard size > 0 else { return Reply(status: 404, data: Data(), mime: "text/plain") }
                var start: UInt64 = 0, end: UInt64 = size - 1
                if let range = range, range.hasPrefix("bytes=") {
                    let parts = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
                    if parts.count == 2 {
                        if parts[0].isEmpty, let suffix = UInt64(parts[1]) { start = size - min(size, suffix) }   // bytes=-N
                        else {
                            start = UInt64(parts[0]) ?? 0
                            if let e = UInt64(parts[1]) { end = min(e, size - 1) }
                            else { end = min(size - 1, start + UInt64(mediaChunk) - 1) }
                        }
                    }
                    guard start < size else {
                        return Reply(status: 416, data: Data(), mime: "text/plain", headers: ["Content-Range": "bytes */\(size)"])
                    }
                } else if size > UInt64(mediaChunk) {
                    // No Range header: still answer with a partial response so the player learns it can seek.
                    end = UInt64(mediaChunk) - 1
                }
                let data = try readRange(p, start, Int(end - start + 1))
                return Reply(status: 206, data: data, mime: mimeType(for: p),
                             headers: ["Accept-Ranges": "bytes", "Content-Range": "bytes \(start)-\(start + UInt64(data.count) - 1)/\(size)"])
            }
            if path.hasPrefix("/__pj/thumb/") {
                let id = (String(path.dropFirst("/__pj/thumb/".count)) as NSString).deletingPathExtension
                let file = Storage.shared.thumbURL(id.removingPercentEncoding ?? id)
                guard let data = try? Data(contentsOf: file) else { return Reply(status: 404, data: Data(), mime: "text/plain") }
                return Reply(status: 200, data: data, mime: "image/jpeg")
            }
            if path == "/__pj/image" {
                guard let p = query(url, "path"), Storage.isImage(p) else { return Reply(status: 404, data: Data(), mime: "text/plain") }
                let data = try RawDecoder.renderImageJPEG(URL(fileURLWithPath: p))
                return Reply(status: 200, data: data, mime: "image/jpeg")
            }
                        if path == "/__pj/raw" {
                guard let p = query(url, "path"), Storage.isRaw(p) else { return Reply(status: 404, data: Data(), mime: "text/plain") }
                let data = try RawDecoder.renderJPEG(URL(fileURLWithPath: p))
                return Reply(status: 200, data: data, mime: "image/jpeg")
            }
            // Static web app
            var rel = path.removingPercentEncoding ?? path
            if rel.isEmpty || rel == "/" { rel = "/index.html" }
            let file = webRoot.appendingPathComponent(String(rel.dropFirst())).standardizedFileURL
            guard file.path.hasPrefix(webRoot.path) else { return Reply(status: 403, data: Data(), mime: "text/plain") }
            var data = try Data(contentsOf: file)
            // Give every script/stylesheet URL a fresh version token so WebKit's in-memory
            // cache can never hand back code from an earlier build or reload.
            if file.pathExtension.lowercased() == "html", var html = String(data: data, encoding: .utf8) {
                let token = String(Int(Date().timeIntervalSince1970 * 1000))
                for ext in [".js\"", ".css\""] {
                    html = html.replacingOccurrences(of: ext, with: String(ext.dropLast()) + "?v=\(token)\"")
                }
                data = html.data(using: .utf8) ?? data
            }
            return Reply(status: 200, data: data, mime: mimeType(for: file.path))
        } catch {
            return Reply(status: 404, data: Data(), mime: "text/plain")
        }
    }

    private func mimeType(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "woff2": return "font/woff2"
        case "svg": return "image/svg+xml"
        case "mp4", "m4v", "lrv": return "video/mp4"
        case "mov": return "video/quicktime"
        default:
            return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
