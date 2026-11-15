// photos.jpeg for macOS — application delegate: window, web view, lifecycle, events to JS.
import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private(set) var window: NSWindow!
    private(set) var web: PJWebView!
    private var bridge: Bridge!
    private var rendererReady = false
    private var pendingOpen: [String] = []
    private var terminating = false

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        Storage.shared.prepare()

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler(), forURLScheme: "pj")
        let content = WKUserContentController()
        bridge = Bridge(app: self)
        content.addScriptMessageHandler(bridge, contentWorld: .page, name: "pj")
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        content.addUserScript(WKUserScript(
            source: "window.__pjInfo = { version: \(jsString(version)), platform: 'macos' };",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = content
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Video: play graded clips (with sound) without an extra click, and let the page decode via WebCodecs
        config.mediaTypesRequiringUserActionForPlayback = []

        web = PJWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: config)
        web.onDropPaths = { [weak self] paths in self?.openPaths(paths) }
        if #available(macOS 13.3, *) { web.isInspectable = true }
        web.underPageBackgroundColor = NSColor(calibratedRed: 0.067, green: 0.071, blue: 0.078, alpha: 1)

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "photos.jpeg"
        window.minSize = NSSize(width: 980, height: 640)
        window.backgroundColor = NSColor(calibratedRed: 0.067, green: 0.071, blue: 0.078, alpha: 1)
        window.contentView = web
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("photos.jpeg.main")
        window.tabbingMode = .disallowed

        MenuBuilder.install(target: self)
        // Drop any cached copy of the interface from a previous build before loading.
        let cacheTypes: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
        WKWebsiteDataStore.default().removeData(ofTypes: cacheTypes, modifiedSince: .distantPast) { [weak self] in
            self?.web.load(URLRequest(url: URL(string: "pj://app/index.html")!, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    /// Files opened from Finder ("Open With", drag onto the Dock icon).
    func application(_ application: NSApplication, open urls: [URL]) {
        openPaths(urls.filter { $0.isFileURL }.map { $0.path })
    }

    // MARK: Quit — let the catalog flush first

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard rendererReady, !terminating else { return .terminateNow }
        terminating = true
        var replied = false
        let finish = {
            if replied { return }
            replied = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        web.callAsyncJavaScript("await PJ.Catalog.save(); return true;", arguments: [:], in: nil, in: .page) { _ in finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish() }
        return .terminateLater
    }

    // MARK: Bridge callbacks

    func rendererDidBecomeReady() {
        rendererReady = true
        if !pendingOpen.isEmpty {
            sendEvent("openPaths", pendingOpen)
            pendingOpen.removeAll()
        }
    }

    func openPaths(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        if rendererReady { sendEvent("openPaths", paths) } else { pendingOpen.append(contentsOf: paths) }
        hideDropOverlay()
    }

    func setRepresentedFile(_ path: String?) {
        window.representedURL = path.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
    }

    // MARK: Events to JS

    /// Calls window.__pjEvent(type, payload) in the page.
    func sendEvent(_ type: String, _ payload: Any? = nil) {
        var payloadJS = "null"
        if let payload = payload,
           let data = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed]),
           let s = String(data: data, encoding: .utf8) {
            payloadJS = s
        }
        web.evaluateJavaScript("window.__pjEvent && window.__pjEvent(\(jsString(type)), \(payloadJS));", completionHandler: nil)
    }

    private func hideDropOverlay() {
        web.evaluateJavaScript("(function(){var d=document.getElementById('drop');if(d)d.classList.add('hidden');})();", completionHandler: nil)
    }

    /// Menu items carry the JS command name in representedObject.
    @objc func menuCommand(_ sender: NSMenuItem) {
        guard let cmd = sender.representedObject as? String else { return }
        sendEvent("menu", cmd)
    }

    @objc func openCatalogFolder(_ sender: Any?) {
        NSWorkspace.shared.open(Storage.shared.root)
    }

    @objc func reloadUI(_ sender: Any?) {
        let cacheTypes: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
        WKWebsiteDataStore.default().removeData(ofTypes: cacheTypes, modifiedSince: .distantPast) { [weak self] in
            self?.web.reloadFromOrigin()
        }
    }
}

/// JSON-encodes a Swift string as a JavaScript string literal.
func jsString(_ s: String) -> String {
    if let data = try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed]),
       let out = String(data: data, encoding: .utf8) { return out }
    return "\"\""
}
