package app.photosjpeg.android

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.LruCache
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream

/**
 * Files for the editor: originals (content:// URIs or copies in app storage), the catalog,
 * thumbnails, RAW rendering and export writing (MediaStore or a user-chosen folder).
 */
class Storage(private val context: Context) {

    companion object {
        val RAW = setOf("nef", "nrw", "gpr", "crw", "cr2", "cr3", "arw", "srf", "sr2", "dng", "orf", "rw2", "raf", "pef", "srw",
            "raw", "rwl", "erf", "3fr", "kdc", "dcr", "mrw", "mef", "mos", "iiq", "x3f")
        val STANDARD = setOf("jpg", "jpeg", "jpe", "jfif", "png", "webp", "avif", "gif", "bmp", "tif", "tiff", "heic", "heif",
            "hif", "jxl", "jp2", "j2k", "jpf", "jpx", "ico", "cur", "dib", "apng", "psd", "psb", "exr", "hdr", "pic", "pfm", "pbm", "pgm", "ppm", "pnm", "pam", "tga", "icb", "vda", "qoi")
        val VIDEO = setOf("mp4", "mov", "m4v", "mkv", "webm", "mts", "m2ts", "mxf", "avi", "lrv", "360", "insv", "3gp", "mpg", "mpeg", "m2v", "vob", "wmv", "flv", "3g2", "mod", "tod", "dv", "ogv",
            "braw", "r3d", "ari", "arx", "crm", "nev")
        /** name → (size in bytes, SHA-256); the same table as windows/Models.cs */
        val MODELS = mapOf(
            "u2netp.onnx" to (4574861L to "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"),
            "efficientvit-seg-b1-ade20k.onnx" to (19312501L to "d6013483203730a1b12c700013bd440231d6778064ffdb63b0582785e40e89a5"),
            "face_detection_yunet_2023mar.onnx" to (232589L to "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
            "face_recognition_sface_2021dec.onnx" to (38696353L to "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79")
        )
        const val MODEL_BASE = "https://raw.githubusercontent.com/jswyhart/photos.jpeg/main/src/vendor/ml/"
        val WRITABLE = setOf("jpg", "jpeg", "png", "webp", "tif", "tiff", "jxl", "dng", "json", "mp4", "mov", "cube", "xmp", "txt")
        val TEXT_EXT = setOf("json", "cube", "xmp", "txt")
        const val CHUNK = 8L shl 20
        const val MEDIASTORE = "mediastore:"
        const val DEFAULT_EXPORT = "mediastore:Pictures/photos.jpeg"
        fun ext(name: String) = name.substringAfterLast('.', "").lowercase()
        fun isImage(name: String) = ext(name) in RAW || ext(name) in STANDARD
        fun isVideo(name: String) = ext(name) in VIDEO
        /** Anything the catalog can hold */
        fun isMedia(name: String) = isImage(name) || isVideo(name)
    }

    private val resolver = context.contentResolver
    private val root: File = context.filesDir
    private val catalogFile = File(root, "catalog.json")
    private val thumbsDir = File(root, "thumbs").apply { mkdirs() }
    private val importsDir = File(root, "imports").apply { mkdirs() }
    private val rawCache = LruCache<String, ByteArray>(2)

    // ---------------- catalog & thumbnails ----------------

    fun loadCatalog(): String? {
        for (f in listOf(catalogFile, File(root, "catalog.json.bak"))) {
            if (f.exists()) runCatching { return f.readText() }
        }
        return null
    }

    @Synchronized
    fun saveCatalog(json: String) {
        if (catalogFile.exists() && System.currentTimeMillis() - catalogFile.lastModified() > 10 * 60_000) {
            catalogFile.copyTo(File(root, "catalog.json.bak"), overwrite = true)
        }
        val tmp = File(root, "catalog.json.tmp")
        tmp.writeText(json)
        if (!tmp.renameTo(catalogFile)) { catalogFile.writeText(json); tmp.delete() }
    }

    private fun safeId(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "_").take(80)
    fun thumbFile(id: String) = File(thumbsDir, safeId(id) + ".jpg")
    fun saveThumb(id: String, bytes: ByteArray) = thumbFile(id).writeBytes(bytes)
    fun deleteThumb(id: String) { thumbFile(id).delete() }

    // ---------------- models (a "lite" build leaves them out of the app and fetches each on first use) ----------------

    private val modelsDir = File(root, "models")
    /** The downloaded copy of a model, or null when there is none (or the name is not one of ours). */
    fun modelFile(name: String): File? = if (MODELS.containsKey(name)) File(modelsDir, name).takeIf { it.isFile } else null
    private fun inApp(name: String) = runCatching { context.assets.open("web/vendor/ml/$name").close(); true }.getOrDefault(false)
    fun modelStatus(): JSONArray {
        val out = JSONArray()
        for ((name, v) in MODELS) out.put(JSONObject().put("name", name).put("size", v.first).put("have", inApp(name) || modelFile(name) != null))
        return out
    }
    fun serveModel(name: String): WebResourceResponse? = modelFile(name)?.let { response("application/octet-stream", it.inputStream()) }
    /** Download one model from the app's repository, check its size and SHA-256, and keep it. progress: 0…1. */
    fun modelFetch(name: String, progress: (Double) -> Unit): JSONObject {
        val want = MODELS[name] ?: throw IllegalArgumentException("That is not a model of this app")
        synchronized(MODELS) {
            if (modelFile(name) != null) return JSONObject().put("name", name).put("ok", true)
            modelsDir.mkdirs()
            val tmp = File(modelsDir, "$name.part")
            try {
                val conn = java.net.URL(MODEL_BASE + name).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 20000; conn.readTimeout = 60000
                conn.setRequestProperty("User-Agent", "photos.jpeg")
                if (conn.responseCode != 200) throw java.io.IOException("The download failed (${conn.responseCode}) — is this device online?")
                val sha = java.security.MessageDigest.getInstance("SHA-256")
                var got = 0L; var last = 0.0
                conn.inputStream.use { src -> tmp.outputStream().use { dst ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = src.read(buf); if (n <= 0) break
                        got += n
                        if (got > want.first) throw java.io.IOException("The downloaded file is larger than it should be")
                        dst.write(buf, 0, n); sha.update(buf, 0, n)
                        val f = got.toDouble() / want.first
                        if (f - last >= 0.02) { last = f; progress(f) }
                    }
                } }
                val hex = sha.digest().joinToString("") { "%02x".format(it) }
                if (got != want.first || hex != want.second) throw java.io.IOException("The downloaded file is not the one this app expects, so it was not kept")
                if (!tmp.renameTo(File(modelsDir, name))) throw java.io.IOException("The model could not be saved")
                return JSONObject().put("name", name).put("ok", true)
            } finally { tmp.delete() }
        }
    }

    /**
     * Catalog clean-up: counts (and, when asked, removes) the files in the thumbnail store that no photo,
     * mask, fill or face of the catalog refers to any more. Files written in the last ten minutes are left
     * alone: something may be about to refer to them.
     */
    fun cleanStore(keepIds: List<String>, remove: Boolean): JSONObject {
        val keep = keepIds.map { safeId(it).lowercase() + ".jpg" }.toHashSet()
        var thumbs = 0; var thumbBytes = 0L; var orphans = 0; var orphanBytes = 0L; var removed = 0
        val cutoff = System.currentTimeMillis() - 600_000
        for (f in thumbsDir.listFiles() ?: emptyArray()) {
            if (!f.isFile) continue
            thumbs++; thumbBytes += f.length()
            if (f.name.lowercase() in keep || f.lastModified() > cutoff) continue
            orphans++; orphanBytes += f.length()
            if (remove && f.delete()) removed++
        }
        return JSONObject().put("thumbs", thumbs).put("thumbBytes", thumbBytes).put("orphans", orphans).put("orphanBytes", orphanBytes)
            .put("removed", removed).put("rawFiles", 0).put("rawBytes", 0).put("rawRemoved", 0)
    }

    // ---------------- reading originals ----------------

    /** Opens a catalog path: a content:// URI, or a file copied into app storage. */
    fun open(path: String): InputStream? = when {
        path.startsWith("content://") -> resolver.openInputStream(Uri.parse(path))
        else -> File(path).takeIf { it.canonicalPath.startsWith(root.canonicalPath) && it.exists() }?.inputStream()
    }

    private fun response(mime: String, data: InputStream?, status: Int = 200, cache: Boolean = false): WebResourceResponse {
        val headers = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Cache-Control" to if (cache) "max-age=31536000" else "no-store"
        )
        return if (data == null || status != 200)
            WebResourceResponse("text/plain", "utf-8", if (status == 200) 404 else status, if (status == 403) "Forbidden" else "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        else WebResourceResponse(mime, null, 200, "OK", headers, data)
    }

    /** Random-access handle on a catalog path (content:// URI or app-storage file). */
    private fun openFd(path: String): android.os.ParcelFileDescriptor? = when {
        path.startsWith("content://") -> resolver.openFileDescriptor(Uri.parse(path), "r")
        else -> File(path).takeIf { it.canonicalPath.startsWith(root.canonicalPath) && it.exists() }
            ?.let { android.os.ParcelFileDescriptor.open(it, android.os.ParcelFileDescriptor.MODE_READ_ONLY) }
    }

    fun fileSize(path: String): Long = runCatching { openFd(path)?.use { it.statSize } ?: 0L }.getOrDefault(0L)

    private fun readRange(path: String, offset: Long, length: Int): ByteArray {
        val pfd = openFd(path) ?: error("Cannot open file")
        pfd.use {
            java.io.FileInputStream(it.fileDescriptor).channel.use { ch ->
                val buf = java.nio.ByteBuffer.allocate(maxOf(0, minOf(length.toLong(), it.statSize - offset).toInt()))
                var pos = offset
                while (buf.hasRemaining()) { val n = ch.read(buf, pos); if (n <= 0) break; pos += n }
                return buf.array().copyOf(buf.position())
            }
        }
    }

    private fun partial(mime: String, data: ByteArray, start: Long, total: Long): WebResourceResponse {
        val headers = mapOf(
            "Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store", "Accept-Ranges" to "bytes",
            "Content-Range" to "bytes $start-${start + data.size - 1}/$total", "Content-Length" to data.size.toString()
        )
        return WebResourceResponse(mime, null, 206, "Partial Content", headers, ByteArrayInputStream(data))
    }

    /** Handles https://appassets.androidplatform.net/__pj/… requests from the editor. */
    fun serve(url: Uri, requestHeaders: Map<String, String> = emptyMap()): WebResourceResponse {
        val path = url.path ?: return response("text/plain", null)
        return try {
            when {
                path == "/__pj/file" -> {
                    val p = url.getQueryParameter("path") ?: return response("text/plain", null)
                    val start = url.getQueryParameter("start")?.toLongOrNull()
                    val len = url.getQueryParameter("length")?.toIntOrNull()
                    if (start != null && len != null) response("application/octet-stream", ByteArrayInputStream(readRange(p, start, len)))
                    else response(mimeFor(nameOf(p)), open(p))
                }
                path == "/__pj/media" -> {
                    val p = url.getQueryParameter("path") ?: return response("text/plain", null)
                    val total = fileSize(p)
                    if (total <= 0) return response("text/plain", null)
                    val range = (requestHeaders["Range"] ?: requestHeaders["range"]).orEmpty()
                    val m = Regex("bytes=(\\d*)-(\\d*)").find(range)
                    var start = 0L; var end = minOf(total - 1, CHUNK - 1)
                    if (m != null) {
                        val (a, b) = m.destructured
                        if (a.isEmpty() && b.isNotEmpty()) { start = maxOf(0, total - b.toLong()); end = total - 1 }
                        else {
                            start = a.toLongOrNull() ?: 0L
                            end = b.toLongOrNull()?.let { minOf(it, total - 1) } ?: minOf(total - 1, start + CHUNK - 1)
                        }
                    }
                    if (start >= total) return response("text/plain", null, 416)
                    partial(mimeFor(nameOf(p)), readRange(p, start, (end - start + 1).toInt()), start, total)
                }
                path.startsWith("/__pj/thumb/") -> {
                    val id = path.removePrefix("/__pj/thumb/").removeSuffix(".jpg")
                    val f = thumbFile(Uri.decode(id))
                    response("image/jpeg", if (f.exists()) f.inputStream() else null, cache = true)
                }
                path == "/__pj/image" -> {
                    val p = url.getQueryParameter("path") ?: return response("text/plain", null)
                    response("image/jpeg", renderImage(p)?.let { ByteArrayInputStream(it) })
                }
                path == "/__pj/raw" -> {
                    val p = url.getQueryParameter("path") ?: return response("text/plain", null)
                    val jpeg = renderRaw(p)
                    response("image/jpeg", jpeg?.let { ByteArrayInputStream(it) })
                }
                else -> response("text/plain", null)
            }
        } catch (e: Exception) {
            response("text/plain", null)
        }
    }

    /**
     * Android's platform decoder demosaics DNG files; other RAW formats fall back to the
     * camera's embedded preview, which the editor extracts itself.
     */
    private fun renderRaw(path: String): ByteArray? {
        if (ext(nameOf(path)) != "dng") return null
        return renderImage(path)
    }

    /** Platform decoder (HEIF/HEIC, AVIF, DNG, …) → JPEG. */
    private fun renderImage(path: String): ByteArray? {
        rawCache.get(path)?.let { return it }
        val source = if (path.startsWith("content://")) ImageDecoder.createSource(resolver, Uri.parse(path))
        else ImageDecoder.createSource(File(path))
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val px = info.size.width.toLong() * info.size.height
            if (px > 24_000_000L) { // keep within mobile memory limits
                val s = Math.sqrt(24_000_000.0 / px)
                decoder.setTargetSize((info.size.width * s).toInt(), (info.size.height * s).toInt())
            }
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 95, out)
        bitmap.recycle()
        return out.toByteArray().also { rawCache.put(path, it) }
    }

    // ---------------- importing ----------------

    private fun nameOf(path: String): String {
        if (!path.startsWith("content://")) return File(path).name
        return runCatching {
            resolver.query(Uri.parse(path), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull() ?: Uri.parse(path).lastPathSegment?.substringAfterLast('/') ?: "image"
    }

    private fun describe(doc: DocumentFile, folder: String): JSONObject? {
        val name = doc.name ?: return null
        if (!isMedia(name)) return null
        return JSONObject()
            .put("path", doc.uri.toString())
            .put("name", name)
            .put("size", doc.length())
            .put("mtime", doc.lastModified())
            .put("folder", folder)
    }

    private fun describeFile(f: File, folder: String): JSONObject = JSONObject()
        .put("path", f.absolutePath).put("name", f.name.substringAfter('_'))
        .put("size", f.length()).put("mtime", f.lastModified()).put("folder", folder)

    /** Individually picked documents: keep read access across restarts. */
    fun importDocuments(uris: List<Uri>): JSONArray {
        val out = JSONArray()
        for (u in uris) {
            runCatching { resolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            val doc = DocumentFile.fromSingleUri(context, u) ?: continue
            describe(doc, "Picked photos")?.let { out.put(it) }
        }
        return out
    }

    /** A whole folder tree (recursive). */
    fun importTree(tree: Uri, limit: Int = 50_000): JSONObject {
        runCatching { resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        val rootDoc = DocumentFile.fromTreeUri(context, tree)
        val files = JSONArray()
        fun walk(dir: DocumentFile, label: String, depth: Int) {
            if (depth > 12 || files.length() >= limit) return
            val children = dir.listFiles().sortedBy { it.name?.lowercase() ?: "" }
            // XMP sidecars by lower-case stem ("img_1" for IMG_1.xmp, "img_1.jpg" for IMG_1.jpg.xmp)
            val xmps = children.filter { it.isFile && (it.name ?: "").lowercase().endsWith(".xmp") }
                .associateBy { (it.name ?: "").dropLast(4).lowercase() }
            for (c in children) {
                if (files.length() >= limit) return
                val n = c.name ?: continue
                if (n.startsWith(".")) continue
                if (c.isDirectory) walk(c, "$label/$n", depth + 1)
                else describe(c, label)?.let { d ->
                    val sc = xmps[n.lowercase()] ?: xmps[n.substringBeforeLast('.').lowercase()]
                    if (sc != null) d.put("sidecar", sc.uri.toString())
                    files.put(d)
                }
            }
        }
        val label = rootDoc?.name ?: "Folder"
        if (rootDoc != null) walk(rootDoc, label, 0)
        return JSONObject().put("folder", label).put("files", files)
    }

    /** Shared/opened files arrive with temporary grants, so copy them into app storage. */
    fun copyIncoming(uris: List<Uri>): List<String> {
        val out = mutableListOf<String>()
        for (u in uris) {
            runCatching {
                val name = nameOf(u.toString()).replace(Regex("[\\\\/:*?\"<>|]"), "_")
                if (!isMedia(name)) return@runCatching
                val dest = File(importsDir, "${System.currentTimeMillis()}_$name")
                resolver.openInputStream(u)?.use { input -> dest.outputStream().use { input.copyTo(it) } }
                if (dest.exists()) out += dest.absolutePath
            }
        }
        return out
    }

    fun describePaths(paths: List<String>): JSONArray {
        val out = JSONArray()
        for (p in paths) {
            if (p.startsWith("content://")) DocumentFile.fromSingleUri(context, Uri.parse(p))?.let { d -> describe(d, "Picked photos")?.let { out.put(it) } }
            else File(p).takeIf { it.exists() && isMedia(it.name) }?.let { out.put(describeFile(it, "Shared to photos.jpeg")) }
        }
        return out
    }

    // ---------------- XMP sidecars ----------------

    /**
     * Reads or writes the .xmp next to a photo. Folder imports carry the sidecar's document URI
     * (hint); files copied into app storage look next to themselves. Writing needs write access
     * to the sidecar's document, which read-only folder grants don't give — the caller then
     * falls back to exporting the .xmp.
     */
    fun sidecar(op: String, media: String, variant: String, text: String, hint: String): Any? {
        val hintUri = hint.takeIf { it.startsWith("content://") }?.let { Uri.parse(it) }
        val local = if (!media.startsWith("content://")) File(media).let { f ->
            val stem = if (variant == "full") f.name else f.name.substringBeforeLast('.')
            listOf("$stem.xmp", "$stem.XMP").map { File(f.parentFile, it) }.firstOrNull { it.exists() } ?: File(f.parentFile, "$stem.xmp")
        } else null
        return when (op) {
            "read" -> when {
                hintUri != null -> resolver.openInputStream(hintUri)?.use { it.readBytes().toString(Charsets.UTF_8) }
                local != null && local.exists() -> local.readText()
                else -> null
            }
            "write" -> {
                require(text.length < 8 shl 20) { "Sidecar too large" }
                when {
                    hintUri != null -> { resolver.openOutputStream(hintUri, "wt")?.use { it.write(text.toByteArray()) } ?: error("No write access"); hint }
                    local != null -> { local.writeText(text); local.absolutePath }
                    else -> error("No write access to the photo's folder")
                }
            }
            else -> error("Unknown sidecar op")
        }
    }

    // ---------------- export ----------------

    private fun mimeFor(name: String): String = when (ext(name)) {
        "jpg", "jpeg", "jpe", "jfif" -> "image/jpeg"
        "tif", "tiff" -> "image/tiff"
        "json" -> "application/json"
        "cube", "txt" -> "text/plain"
        "xmp" -> "application/rdf+xml"
        "mp4", "m4v", "lrv" -> "video/mp4"
        "mov" -> "video/quicktime"
        else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext(name)) ?: "application/octet-stream"
    }

    /**
     * path is either "mediastore:<RelativeDir>/<sub>/<name>" or "<persisted tree uri>/<sub>/<name>".
     * mode: "unique" (new name), "overwrite" or "skip". Returns the written URI, or null when skipped.
     */
    fun write(path: String, bytes: ByteArray, mode: String): String? {
        val name = path.substringAfterLast('/')
        require(ext(name) in WRITABLE) { "Refusing to write this file type" }
        return if (path.startsWith(MEDIASTORE)) writeMediaStore(path.removePrefix(MEDIASTORE).substringBeforeLast('/', ""), name, bytes, mode)
        else writeTree(path, name, bytes, mode)
    }

    private fun collectionFor(name: String) = when {
        isVideo(name) -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        ext(name) !in TEXT_EXT -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        else -> MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    }
    private fun mediaDir(relDir: String, name: String): String {
        // MediaStore only accepts video under Movies/DCIM, images under Pictures/DCIM
        var d = relDir.trim('/').ifEmpty { if (isVideo(name)) Environment.DIRECTORY_MOVIES else if (ext(name) !in TEXT_EXT) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS }
        if (isVideo(name) && d.startsWith(Environment.DIRECTORY_PICTURES)) d = Environment.DIRECTORY_MOVIES + d.removePrefix(Environment.DIRECTORY_PICTURES)
        return "$d/"
    }

    private fun writeMediaStore(relDir: String, name: String, bytes: ByteArray, mode: String): String? {
        val collection = collectionFor(name)
        val dir = mediaDir(relDir, name)
        // Look for an existing file of ours with the same name
        val existing = resolver.query(collection, arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?", arrayOf(dir, name), null)?.use { c ->
            if (c.moveToFirst()) ContentUris.withAppendedId(collection, c.getLong(0)) else null
        }
        if (existing != null) {
            when (mode) {
                "skip" -> return null
                "overwrite" -> {
                    resolver.openOutputStream(existing, "wt")?.use { it.write(bytes) } ?: error("Cannot overwrite $name")
                    return existing.toString()
                }
            }
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeFor(name))
            put(MediaStore.MediaColumns.RELATIVE_PATH, dir)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: error("Could not create $name")
        try {
            resolver.openOutputStream(uri, "w")?.use { it.write(bytes) } ?: error("Could not open $name")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        return uri.toString()
    }

    private fun writeTree(path: String, name: String, bytes: ByteArray, mode: String): String? {
        val tree = resolver.persistedUriPermissions.filter { it.isWritePermission }
            .map { it.uri.toString() }.filter { path.startsWith(it) }.maxByOrNull { it.length }
            ?: error("No write access to the export folder — choose it again")
        val rel = path.removePrefix(tree).trim('/').split('/').filter { it.isNotEmpty() }
        var dir = DocumentFile.fromTreeUri(context, Uri.parse(tree)) ?: error("Export folder unavailable")
        for (seg in rel.dropLast(1)) {
            val d = Uri.decode(seg)
            dir = dir.findFile(d)?.takeIf { it.isDirectory } ?: dir.createDirectory(d) ?: error("Cannot create folder $d")
        }
        var target = dir.findFile(name)
        if (target != null) {
            when (mode) {
                "skip" -> return null
                "overwrite" -> {}
                else -> {
                    val base = name.substringBeforeLast('.'); val e = ext(name)
                    var i = 2
                    while (dir.findFile("$base-$i.$e") != null) i++
                    target = dir.createFile(mimeFor(name), "$base-$i.$e")
                }
            }
        } else target = dir.createFile(mimeFor(name), name)
        target ?: error("Cannot create $name")
        resolver.openOutputStream(target.uri, "wt")?.use { it.write(bytes) } ?: error("Cannot write $name")
        return target.uri.toString()
    }

    // ---------------- streaming writes (video export) ----------------

    private class OpenWrite(val pfd: android.os.ParcelFileDescriptor, val channel: java.nio.channels.FileChannel, val uri: Uri, val pending: Boolean)
    private val writers = java.util.concurrent.ConcurrentHashMap<Int, OpenWrite>()
    private val writeSeq = java.util.concurrent.atomic.AtomicInteger()

    /** Opens a file for chunked writing. Returns a handle, or null when mode is "skip" and it exists. */
    fun openWrite(path: String, mode: String): Int? {
        val name = path.substringAfterLast('/')
        require(ext(name) in WRITABLE) { "Refusing to write this file type" }
        var pending = false
        val uri: Uri = if (path.startsWith(MEDIASTORE)) {
            val collection = collectionFor(name)
            val dir = mediaDir(path.removePrefix(MEDIASTORE).substringBeforeLast('/', ""), name)
            val existing = resolver.query(collection, arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?", arrayOf(dir, name), null)?.use { c ->
                if (c.moveToFirst()) ContentUris.withAppendedId(collection, c.getLong(0)) else null
            }
            if (existing != null && mode == "skip") return null
            if (existing != null && mode == "overwrite") existing
            else {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mimeFor(name))
                    put(MediaStore.MediaColumns.RELATIVE_PATH, dir)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                pending = true
                resolver.insert(collection, values) ?: error("Could not create $name")
            }
        } else {
            val written = writeTree(path, name, ByteArray(0), mode) ?: return null
            Uri.parse(written)
        }
        val pfd = resolver.openFileDescriptor(uri, "rw") ?: error("Could not open $name")
        val ch = java.io.FileOutputStream(pfd.fileDescriptor).channel
        ch.truncate(0)
        val h = writeSeq.incrementAndGet()
        writers[h] = OpenWrite(pfd, ch, uri, pending)
        return h
    }

    fun writeChunk(h: Int, bytes: ByteArray, offset: Long?) {
        val w = writers[h] ?: error("File is not open")
        synchronized(w) {
            val buf = java.nio.ByteBuffer.wrap(bytes)
            if (offset != null) { var p = offset; while (buf.hasRemaining()) p += w.channel.write(buf, p) }
            else while (buf.hasRemaining()) w.channel.write(buf)
        }
    }

    fun closeWrite(h: Int): String? {
        val w = writers.remove(h) ?: return null
        synchronized(w) { w.channel.force(true); w.channel.close(); w.pfd.close() }
        if (w.pending) resolver.update(w.uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        return w.uri.toString()
    }

    fun takeTree(tree: Uri): String {
        resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        return tree.toString()
    }

    /** Picked text files with their names, keeping only the allowed extensions. */
    fun readNamedTexts(uris: List<Uri>, exts: List<String>): JSONArray {
        val out = JSONArray()
        for (u in uris) runCatching {
            val name = nameOf(u.toString())
            if (exts.isNotEmpty() && ext(name) !in exts) return@runCatching
            resolver.openInputStream(u)?.use { out.put(JSONObject().put("name", name).put("text", it.bufferedReader().readText())) }
        }
        return out
    }

    fun readTexts(uris: List<Uri>): JSONArray {
        val out = JSONArray()
        for (u in uris) runCatching { resolver.openInputStream(u)?.use { out.put(it.bufferedReader().readText()) } }
        return out
    }

    fun viewIntent(path: String, share: Boolean): Intent? {
        if (!path.startsWith("content://")) return null
        val uri = Uri.parse(path)
        val mime = mimeFor(nameOf(path))
        val intent = if (share) Intent(Intent.ACTION_SEND).apply { type = mime; putExtra(Intent.EXTRA_STREAM, uri) }
        else Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, mime) }
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return if (share) Intent.createChooser(intent, "Share photo") else intent
    }
}
