// photos.jpeg for macOS — true RAW decoding with Apple's Core Image RAW engine.
// Demosaics the sensor data (NEF, CR2, CR3, ARW, DNG, RAF, ORF, RW2, …) at full resolution
// with Apple's default rendering, then hands the editor a high-quality JPEG to work from.
import Foundation
import CoreImage
import ImageIO

enum RawDecoder {
    private static let context = CIContext(options: [
        .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
        .cacheIntermediates: false
    ])
    private static let cache: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        c.countLimit = 3
        return c
    }()
    private static let lock = NSLock()

    static func renderJPEG(_ url: URL) throws -> Data {
        let key = url.path as NSString
        if let hit = cache.object(forKey: key) { return hit as Data }
        // One decode at a time keeps memory bounded for 45–100 MP files.
        lock.lock()
        defer { lock.unlock() }
        if let hit = cache.object(forKey: key) { return hit as Data }

        guard let filter = CIRAWFilter(imageURL: url) else {
            throw PJError.message("Core Image does not support this RAW format")
        }
        // Gentle, neutral defaults; the editor applies the creative look.
        filter.isGamutMappingEnabled = true
        if filter.isLensCorrectionSupported { filter.isLensCorrectionEnabled = true }
        guard let image = filter.outputImage else {
            throw PJError.message("Core Image could not render this RAW file")
        }
        let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
        let options: [CIImageRepresentationOption: Any] = [
            CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.96
        ]
        guard let data = context.jpegRepresentation(of: image, colorSpace: sRGB, options: options) else {
            throw PJError.message("Could not encode the rendered RAW image")
        }
        cache.setObject(data as NSData, forKey: key)
        return data
    }

    /// Any image format ImageIO reads (HEIC, JPEG 2000, JPEG XL, PSD, EXR, TGA, …) → JPEG, upright.
    static func renderImageJPEG(_ url: URL) throws -> Data {
        let key = ("img:" + url.path) as NSString
        if let hit = cache.object(forKey: key) { return hit as Data }
        lock.lock()
        defer { lock.unlock() }
        guard let image = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else {
            throw PJError.message("macOS can't decode this image")
        }
        let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
        let options: [CIImageRepresentationOption: Any] = [
            CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.96
        ]
        guard let data = context.jpegRepresentation(of: image, colorSpace: sRGB, options: options) else {
            throw PJError.message("Could not encode the decoded image")
        }
        cache.setObject(data as NSData, forKey: key)
        return data
    }
}
