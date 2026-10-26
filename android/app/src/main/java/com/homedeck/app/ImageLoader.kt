package com.homedeck.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Tiny artwork loader for proxied service images (no third-party image library). */
object ImageLoader {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val executor = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())

    /**
     * Build a URL for an artwork path. Relative paths are routed through HomeDeck's
     * authenticated image proxy; absolute external URLs are loaded directly.
     */
    fun artUrl(baseUrl: String, service: Service, art: String): String {
        if (art.isEmpty()) return ""
        if (art.startsWith("data:")) return ""
        if (art.startsWith("http://") || art.startsWith("https://")) {
            val serviceHost = try { URL(service.url).host } catch (_: Exception) { "" }
            val artHost = try { URL(art).host } catch (_: Exception) { "" }
            return if (serviceHost.isNotEmpty() && serviceHost == artHost) {
                val u = URL(art)
                "${baseUrl.trimEnd('/')}/api/proxy/${service.id}${u.path}${if (u.query != null) "?" + u.query else ""}"
            } else {
                art
            }
        }
        val path = if (art.startsWith("/")) art else "/$art"
        return "${baseUrl.trimEnd('/')}/api/proxy/${service.id}$path"
    }

    /**
     * Resolve service/container icons. Bundled HomeDeck icons (`/icons/...`) are
     * served by the dashboard itself; absolute URLs and data URIs load directly.
     */
    fun iconUrl(baseUrl: String, service: Service?, icon: String): String {
        val value = icon.trim()
        if (value.isEmpty()) return ""
        if (value.startsWith("data:image")) return value
        if (value.startsWith("http://") || value.startsWith("https://")) return value
        if (value.startsWith("/")) return baseUrl.trimEnd('/') + value
        return if (service != null) artUrl(baseUrl, service, value) else ""
    }

    private fun sameOrigin(a: String, b: String): Boolean {
        if (a.isEmpty() || b.isEmpty()) return false
        return try {
            val ua = URL(a)
            val ub = URL(b)
            val pa = if (ua.port != -1) ua.port else if (ua.protocol == "https") 443 else 80
            val pb = if (ub.port != -1) ub.port else if (ub.protocol == "https") 443 else 80
            ua.protocol.equals(ub.protocol, true) &&
                ua.host.equals(ub.host, true) &&
                pa == pb
        } catch (_: Exception) {
            false
        }
    }

    fun load(view: ImageView, url: String, token: String, homeBase: String, onResult: ((Boolean) -> Unit)? = null) {
        if (url.isEmpty()) {
            view.setImageDrawable(null)
            onResult?.invoke(false)
            return
        }
        if (url.startsWith("data:image")) {
            try {
                val comma = url.indexOf(',')
                if (comma < 0) {
                    onResult?.invoke(false)
                    return
                }
                val bytes = android.util.Base64.decode(url.substring(comma + 1), android.util.Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bitmap != null) {
                    view.setImageBitmap(bitmap)
                    onResult?.invoke(true)
                } else {
                    onResult?.invoke(false)
                }
            } catch (_: Exception) {
                onResult?.invoke(false)
            }
            return
        }
        val cached = cache.get(url)
        if (cached != null) {
            view.setImageBitmap(cached)
            onResult?.invoke(true)
            return
        }
        view.tag = url
        view.setImageDrawable(null)
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 8_000
                    readTimeout = 15_000
                    // Do not follow redirects: the Authorization header must never
                    // be forwarded to a target that was not checked up front.
                    instanceFollowRedirects = false
                    useCaches = false
                    // Never leak the bearer token to third-party image hosts. Exact
                    // origin comparison avoids "home.example.com.evil.tld" bypasses.
                    if (sameOrigin(url, homeBase)) {
                        setRequestProperty("Authorization", "Bearer $token")
                    }
                }
                val status = connection.responseCode
                if (status !in 200..299) {
                    main.post { onResult?.invoke(false) }
                    return@execute
                }
                val bitmap = connection.inputStream.use { BitmapFactory.decodeStream(it) }
                if (bitmap == null) {
                    main.post { onResult?.invoke(false) }
                    return@execute
                }
                cache.put(url, bitmap)
                main.post {
                    if (view.tag == url) view.setImageBitmap(bitmap)
                    onResult?.invoke(true)
                }
            } catch (_: Exception) {
                main.post { onResult?.invoke(false) }
            } finally {
                connection?.disconnect()
            }
        }
    }
}
