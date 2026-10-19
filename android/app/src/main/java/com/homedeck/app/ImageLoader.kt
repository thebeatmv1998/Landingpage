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

    fun load(view: ImageView, url: String, token: String, homeBase: String) {
        if (url.isEmpty()) {
            view.setImageDrawable(null)
            return
        }
        val cached = cache.get(url)
        if (cached != null) {
            view.setImageBitmap(cached)
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
                    instanceFollowRedirects = true
                    useCaches = false
                    // Never leak the bearer token to third-party image hosts.
                    if (homeBase.isNotEmpty() && url.startsWith(homeBase.trimEnd('/'))) {
                        setRequestProperty("Authorization", "Bearer $token")
                    }
                }
                val status = connection.responseCode
                if (status !in 200..299) return@execute
                val bitmap = connection.inputStream.use { BitmapFactory.decodeStream(it) } ?: return@execute
                cache.put(url, bitmap)
                main.post {
                    if (view.tag == url) view.setImageBitmap(bitmap)
                }
            } catch (_: Exception) {
                // keep the placeholder
            } finally {
                connection?.disconnect()
            }
        }
    }
}
