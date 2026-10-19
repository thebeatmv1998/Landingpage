package com.homedeck.app

import android.os.Handler
import android.os.Looper
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Mirrors the web dashboard's local/public failover: the phone probes the local
 * URL and links to the public fallback when the LAN address is unreachable.
 */
object Reachability {
    private const val FRESH_MS = 2 * 60 * 1000L
    private const val TIMEOUT_MS = 1500

    private data class Entry(val local: Boolean, val at: Long, val url: String, val fallback: String)

    private val cache = ConcurrentHashMap<Int, Entry>()
    private val executor = Executors.newFixedThreadPool(4)

    fun effectiveUrl(service: Service): String {
        if (service.fallbackUrl.isEmpty()) return service.url
        if (!service.autoSwitch) return service.url.ifEmpty { service.fallbackUrl }
        val entry = cache[service.id]
        val external = entry != null &&
            entry.url == service.url &&
            entry.fallback == service.fallbackUrl &&
            !entry.local
        return if (external) service.fallbackUrl else service.url.ifEmpty { service.fallbackUrl }
    }

    fun isExternal(service: Service): Boolean {
        if (service.fallbackUrl.isEmpty() || !service.autoSwitch) return false
        val entry = cache[service.id] ?: return false
        if (entry.url != service.url || entry.fallback != service.fallbackUrl) return false
        return !entry.local
    }

    fun probe(services: List<Service>, onChanged: () -> Unit) {
        val now = System.currentTimeMillis()
        val todo = services.filter {
            it.url.isNotEmpty() && it.fallbackUrl.isNotEmpty() && it.autoSwitch
        }.filter {
            val entry = cache[it.id]
            entry == null || entry.url != it.url || entry.fallback != it.fallbackUrl || now - entry.at > FRESH_MS
        }
        if (todo.isEmpty()) return
        val changed = AtomicBoolean(false)
        val latch = CountDownLatch(todo.size)
        for (service in todo) {
            executor.execute {
                val local = reachable(service.url)
                val previous = cache.put(service.id, Entry(local, System.currentTimeMillis(), service.url, service.fallbackUrl))
                if (previous == null || previous.local != local) changed.set(true)
                latch.countDown()
            }
        }
        Thread {
            try { latch.await(TIMEOUT_MS * 4L, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { }
            if (changed.get()) Handler(Looper.getMainLooper()).post(onChanged)
        }.start()
    }

    private fun reachable(raw: String): Boolean {
        var connection: HttpURLConnection? = null
        return try {
            val url = URL(raw)
            if (url.protocol != "http" && url.protocol != "https") return false
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "HEAD"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                instanceFollowRedirects = true
                useCaches = false
            }
            connection.responseCode
            true
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
        }
    }
}
