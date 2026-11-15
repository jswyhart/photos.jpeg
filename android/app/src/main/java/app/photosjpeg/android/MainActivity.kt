package app.photosjpeg.android

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader

/**
 * photos.jpeg for Android: hosts the shared editor (assets/web) in a WebView and gives it
 * native file access (Storage Access Framework, MediaStore), share/open intents and Back.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$HOST/assets/web/index.html"
    }

    lateinit var web: WebView
        private set
    lateinit var storage: Storage
        private set
    private lateinit var bridge: Bridge
    private lateinit var assetLoader: WebViewAssetLoader

    // Pending picker callbacks (only one picker can be open at a time)
    private var onDocuments: ((List<Uri>) -> Unit)? = null
    private var onTree: ((Uri?) -> Unit)? = null

    private val pickDocuments = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        onDocuments?.invoke(uris ?: emptyList()); onDocuments = null
    }
    private val pickTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        onTree?.invoke(uri); onTree = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        storage = Storage(this)

        // Edge-to-edge is enforced on Android 15; keep the editor clear of system bars and the keyboard.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        web = WebView(this)
        web.setBackgroundColor(0xFF111214.toInt())
        setContentView(web)
        ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        WindowInsetsControllerCompat(window, web).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            textZoom = 100
            mediaPlaybackRequiresUserGesture = true
        }

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        bridge = Bridge(this, storage)
        web.addJavascriptInterface(bridge, "PJAndroid")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.host == HOST && url.path?.startsWith("/__pj/") == true) return storage.serve(url, request.requestHeaders ?: emptyMap())
                return assetLoader.shouldInterceptRequest(url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }

        onBackPressedDispatcher.addCallback(this) {
            if (bridge.isReady) bridge.sendEvent("back", "null") else finish()
        }

        handleIntent(intent)
        if (savedInstanceState == null) web.loadUrl(START_URL) else web.restoreState(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        if (::bridge.isInitialized && bridge.isReady) bridge.sendEvent("flush", "null")
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** Photos shared to the app or opened with it. Grants are temporary, so files are copied in. */
    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val uris = mutableListOf<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> intentStream(intent)?.let { uris += it }
            Intent.ACTION_SEND_MULTIPLE -> uris += intentStreams(intent)
            Intent.ACTION_VIEW, Intent.ACTION_EDIT -> intent.data?.let { uris += it }
        }
        if (uris.isEmpty()) return
        intent.action = Intent.ACTION_MAIN // don't re-import on configuration changes
        Thread {
            val paths = storage.copyIncoming(uris)
            if (paths.isNotEmpty()) bridge.openPaths(paths)
        }.start()
    }

    @Suppress("DEPRECATION")
    private fun intentStream(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun intentStreams(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()

    // ---- pickers used by the bridge (must run on the main thread) ----

    fun openDocuments(mimeTypes: Array<String>, callback: (List<Uri>) -> Unit) {
        onDocuments = callback
        pickDocuments.launch(mimeTypes)
    }

    fun openTree(callback: (Uri?) -> Unit) {
        onTree = callback
        pickTree.launch(null)
    }

    /** Called when the editor didn't consume Back (e.g. already at the Library). */
    fun backUnhandled() {
        moveTaskToBack(true)
    }
}
