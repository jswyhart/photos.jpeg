package app.photosjpeg.android

import android.util.Base64
import android.widget.Toast
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * window.PJAndroid — called from the editor's api.js:
 *   PJAndroid.call(id, method, argsJson)  →  later window.__pjResolve(id, resultJson, error)
 *   PJAndroid.info()                      →  {"version": …}
 * Native → JS events go through window.__pjEvent(type, payload).
 */
class Bridge(private val activity: MainActivity, private val storage: Storage) {

    private val io = Executors.newFixedThreadPool(3)
    @Volatile var isReady = false
        private set
    private val pendingOpen = mutableListOf<String>()

    @JavascriptInterface
    fun info(): String = JSONObject()
        .put("version", runCatching { activity.packageManager.getPackageInfo(activity.packageName, 0).versionName }.getOrNull() ?: "")
        .put("platform", "android")
        .toString()

    @JavascriptInterface
    fun call(id: Int, method: String, argsJson: String) {
        val a = runCatching { JSONObject(argsJson) }.getOrElse { JSONObject() }
        fun bg(work: () -> Any?) = io.execute {
            try { resolve(id, work()) } catch (e: Throwable) { reject(id, e.message ?: e.toString()) }
        }
        when (method) {
            "openFiles" -> activity.runOnUiThread {
                activity.openDocuments(arrayOf("image/*", "video/*", "application/octet-stream")) { uris -> bg { storage.importDocuments(uris) } }
            }
            "openFolder" -> activity.runOnUiThread {
                activity.openTree { tree ->
                    if (tree == null) resolve(id, JSONObject().put("folder", "").put("files", JSONArray()))
                    else bg { storage.importTree(tree) }
                }
            }
            "scanPaths" -> bg { storage.describePaths(a.optJSONArray("paths").toStringList()) }
            "stat" -> resolve(id, null)
            "loadCatalog" -> bg { storage.loadCatalog() }
            "saveCatalog" -> bg { storage.saveCatalog(a.optString("json")); true }
            "saveThumb" -> bg { storage.saveThumb(a.optString("id"), Base64.decode(a.optString("data"), Base64.DEFAULT)); true }
            "listBackups" -> bg { storage.listBackups() }
            "backupNow" -> bg { storage.backupNow() }
            "restoreBackup" -> bg { storage.restoreBackup(a.optString("name")) }
            "deleteThumb" -> bg { storage.deleteThumb(a.optString("id")); true }
            "modelStatus" -> bg { storage.modelStatus() }
            "modelFetch" -> bg {
                val name = a.optString("name")
                storage.modelFetch(name) { f -> sendEvent("modelProgress", JSONObject().put("name", name).put("frac", f).toString()) }
            }
            "cleanStore" -> bg { storage.cleanStore(a.optJSONArray("keep").toStringList(), a.optBoolean("remove")) }
            "chooseDirectory" -> activity.runOnUiThread {
                activity.openTree { tree -> if (tree == null) resolve(id, null) else bg { storage.takeTree(tree) } }
            }
            "writeFile" -> bg {
                storage.write(a.optString("path"), Base64.decode(a.optString("data"), Base64.DEFAULT), a.optString("mode", "unique"))
            }
            "defaultExportDir" -> resolve(id, Storage.DEFAULT_EXPORT)
            "sidecar" -> bg { storage.sidecar(a.optString("op"), a.optString("path"), a.optString("variant", "base"), a.optString("text"), a.optString("hint")) }
            // large files & video
            "fileSize" -> bg { storage.fileSize(a.optString("path")) }
            "openWrite" -> bg { storage.openWrite(a.optString("path"), a.optString("mode", "unique")) }
            "writeChunk" -> bg { storage.writeChunk(a.optInt("handle"), Base64.decode(a.optString("data"), Base64.DEFAULT), null); true }
            "writeAt" -> bg { storage.writeChunk(a.optInt("handle"), Base64.decode(a.optString("data"), Base64.DEFAULT), a.optLong("offset")); true }
            "closeWrite" -> bg { storage.closeWrite(a.optInt("handle")) }
            "videoTool" -> when (a.optString("op")) {
                "capabilities" -> resolve(id, JSONObject().put("ffmpeg", false).put("braw", false).put("converters", JSONObject()))
                "cancel" -> resolve(id, true)
                else -> reject(id, "This format needs optimized media, which the Android app can't create. Convert the clip on a computer (photos.jpeg desktop or Mac app) first.")
            }
            "showInFolder", "share" -> {
                val intent = storage.viewIntent(a.optString("path"), share = method == "share")
                if (intent != null) activity.runOnUiThread { runCatching { activity.startActivity(intent) } }
                resolve(id, intent != null)
            }
            "savePresetFile" -> bg {
                val name = a.optString("name", "preset.json").replace(Regex("[\\\\/:*?\"<>|]"), "_")
                storage.write("mediastore:Download/photos.jpeg/$name", a.optString("json").toByteArray(), "unique")
                activity.runOnUiThread { Toast.makeText(activity, "Saved to Downloads/photos.jpeg", Toast.LENGTH_SHORT).show() }
                true
            }
            "openTextFiles" -> activity.runOnUiThread {
                activity.openDocuments(arrayOf("*/*")) { uris -> bg { storage.readNamedTexts(uris, a.optJSONArray("exts").toStringList()) } }
            }
            "saveTextFile" -> bg {
                val ext = a.optString("ext")
                require(ext in setOf("cube", "xmp", "json", "txt")) { "Refusing to write this file type" }
                var name = a.optString("name", "untitled.$ext").replace(Regex("[\\\\/:*?\"<>|]"), "_")
                if (!name.lowercase().endsWith(".$ext")) name += ".$ext"
                val out = storage.write("mediastore:Download/photos.jpeg/$name", a.optString("text").toByteArray(), "unique")
                activity.runOnUiThread { Toast.makeText(activity, "Saved to Downloads/photos.jpeg", Toast.LENGTH_SHORT).show() }
                out
            }
            "openPresetFiles" -> activity.runOnUiThread {
                activity.openDocuments(arrayOf("application/json", "text/plain", "application/octet-stream")) { uris -> bg { storage.readTexts(uris) } }
            }
            "ready" -> {
                isReady = true
                val paths = synchronized(pendingOpen) { pendingOpen.toList().also { pendingOpen.clear() } }
                if (paths.isNotEmpty()) sendEvent("openPaths", JSONArray(paths).toString())
                resolve(id, true)
            }
            "backResult" -> {
                if (!a.optBoolean("handled", true)) activity.runOnUiThread { activity.backUnhandled() }
                resolve(id, true)
            }
            "flushed", "representedFile" -> resolve(id, true)
            else -> reject(id, "Unknown method $method")
        }
    }

    /** Photos shared/opened while the editor may still be loading. */
    fun openPaths(paths: List<String>) {
        if (isReady) sendEvent("openPaths", JSONArray(paths).toString())
        else synchronized(pendingOpen) { pendingOpen += paths }
    }

    fun sendEvent(type: String, payloadJson: String) {
        val js = "window.__pjEvent && window.__pjEvent(${JSONObject.quote(type)}, $payloadJson);"
        activity.runOnUiThread { activity.web.evaluateJavascript(js, null) }
    }

    private fun resolve(id: Int, value: Any?) {
        val json = when (value) {
            null, Unit -> "null"
            is JSONObject, is JSONArray -> value.toString()
            is String -> JSONObject.quote(value)
            is Boolean, is Number -> value.toString()
            else -> JSONObject.quote(value.toString())
        }
        val js = "window.__pjResolve && window.__pjResolve($id, ${JSONObject.quote(json)}, null);"      // (the page may have been reloaded since it asked)
        activity.runOnUiThread { activity.web.evaluateJavascript(js, null) }
    }

    private fun reject(id: Int, message: String) {
        val js = "window.__pjResolve && window.__pjResolve($id, null, ${JSONObject.quote(message)});"
        activity.runOnUiThread { activity.web.evaluateJavascript(js, null) }
    }

    private fun JSONArray?.toStringList(): List<String> =
        if (this == null) emptyList() else (0 until length()).map { getString(it) }
}
