// photos.jpeg for Windows — formats the web engine can't open (HEIC without an HEVC decoder,
// JPEG XL, camera RAW the built-in engine doesn't cover …) are decoded by the Windows Imaging
// Component, which picks up every codec installed on the PC (HEIF Image Extensions, Raw Image
// Extension, JPEG XL Image Extension …). Returns an upright JPEG.
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace PhotosJpeg;

public static class SystemImage
{
    public static byte[] RenderJpeg(string path)
    {
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var decoder = BitmapDecoder.Create(input, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
        BitmapSource frame = decoder.Frames[0];

        // HEIF decoders already apply the file's rotation; for the others honour EXIF orientation.
        var ext = Storage.Ext(path);
        if (ext is not ("heic" or "heif" or "hif" or "avif"))
        {
            var transform = OrientationTransform(frame);
            if (transform != null) frame = new TransformedBitmap(frame, transform);
        }
        if (frame.Format != PixelFormats.Bgr24 && frame.Format != PixelFormats.Bgr32)
            frame = new FormatConvertedBitmap(frame, PixelFormats.Bgr24, null, 0);

        var encoder = new JpegBitmapEncoder { QualityLevel = 95 };
        encoder.Frames.Add(BitmapFrame.Create(frame));
        using var output = new MemoryStream();
        encoder.Save(output);
        return output.ToArray();
    }

    static Transform? OrientationTransform(BitmapSource frame)
    {
        try
        {
            if ((frame as BitmapFrame)?.Metadata is not BitmapMetadata meta) return null;
            var value = meta.GetQuery("System.Photo.Orientation");
            if (value == null) return null;
            var group = new TransformGroup();
            switch (Convert.ToInt32(value))
            {
                case 2: group.Children.Add(new ScaleTransform(-1, 1)); break;
                case 3: group.Children.Add(new RotateTransform(180)); break;
                case 4: group.Children.Add(new ScaleTransform(1, -1)); break;
                case 5: group.Children.Add(new RotateTransform(90)); group.Children.Add(new ScaleTransform(-1, 1)); break;
                case 6: group.Children.Add(new RotateTransform(90)); break;
                case 7: group.Children.Add(new RotateTransform(270)); group.Children.Add(new ScaleTransform(-1, 1)); break;
                case 8: group.Children.Add(new RotateTransform(270)); break;
                default: return null;
            }
            return group;
        }
        catch { return null; }
    }
}
