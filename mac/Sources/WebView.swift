// photos.jpeg for macOS — WKWebView subclass that accepts Finder drops as real file paths.
import AppKit
import WebKit

final class PJWebView: WKWebView {
    var onDropPaths: (([String]) -> Void)?

    private func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        return (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: opts) as? [URL]) ?? []
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if !fileURLs(sender).isEmpty { return true }
        return super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(sender)
        if !urls.isEmpty {
            onDropPaths?(urls.map { $0.path })
            return true
        }
        return super.performDragOperation(sender)
    }
}
