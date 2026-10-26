package com.homedeck.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import java.io.ByteArrayOutputStream
import java.io.InputStream
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

    /**
     * Load an image. [maxPx] downsamples icons to roughly the displayed size,
     * which keeps dozens of Unraid/Docker icons from exhausting the heap.
     */
    fun load(
        view: ImageView,
        url: String,
        token: String,
        homeBase: String,
        onResult: ((Boolean) -> Unit)? = null,
        maxPx: Int = 0,
    ) {
        if (url.isEmpty()) {
            view.setImageDrawable(null)
            onResult?.invoke(false)
            return
        }
        val key = when {
            url.startsWith("data:image") -> "data:${url.hashCode()}:${url.length}@$maxPx"
            maxPx > 0 -> "$url@$maxPx"
            else -> url
        }
        val cached = cache.get(key)
        if (cached != null) {
            view.setImageBitmap(cached)
            onResult?.invoke(true)
            return
        }
        view.tag = key
        view.setImageDrawable(null)
        executor.execute {
            try {
                val bitmap = if (url.startsWith("data:image")) {
                    decodeDataUri(url, maxPx)
                } else {
                    download(url, token, homeBase, maxPx)
                }
                if (bitmap == null) {
                    main.post { onResult?.invoke(false) }
                    return@execute
                }
                cache.put(key, bitmap)
                main.post {
                    if (view.tag == key) view.setImageBitmap(bitmap)
                    onResult?.invoke(true)
                }
            } catch (_: OutOfMemoryError) {
                main.post { onResult?.invoke(false) }
            } catch (_: Exception) {
                main.post { onResult?.invoke(false) }
            }
        }
    }

    private fun download(url: String, token: String, homeBase: String, maxPx: Int): Bitmap? {
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
            if (status !in 200..299) return null
            return connection.inputStream.use { stream ->
                if (maxPx <= 0) {
                    BitmapFactory.decodeStream(stream)
                } else {
                    decodeScaled(readLimited(stream, 6_000_000), maxPx)
                }
            }
        } finally {
            connection?.disconnect()
        }
    }

    private fun decodeDataUri(url: String, maxPx: Int): Bitmap? {
        val comma = url.indexOf(',')
        if (comma < 0) return null
        val header = url.substring(0, comma)
        val payload = url.substring(comma + 1)
        val bytes = if (header.contains(";base64", ignoreCase = true)) {
            android.util.Base64.decode(payload, android.util.Base64.DEFAULT)
        } else {
            java.net.URLDecoder.decode(payload, "UTF-8").toByteArray()
        }
        return decodeScaled(bytes, maxPx)
    }

    private fun decodeScaled(bytes: ByteArray, maxPx: Int): Bitmap? {
        if (bytes.isEmpty()) return null
        if (maxPx <= 0) return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        val largest = maxOf(bounds.outWidth, bounds.outHeight)
        while (largest / (sample * 2) >= maxPx) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }

    private fun readLimited(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > limit) break
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }
}
