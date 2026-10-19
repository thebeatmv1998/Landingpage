package com.homedeck.app

import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Resolves the HomeDeck server base URL from the configured local and external
 * addresses. In auto mode the local /api/ping is probed first (cached for two
 * minutes); when it fails the public external address is used.
 */
object ServerResolver {
    private data class Probe(val ok: Boolean, val at: Long)

    private const val TTL_MS = 2 * 60 * 1000L
    private const val TIMEOUT_MS = 1500

    private val cache = ConcurrentHashMap<String, Probe>()

    fun local(prefs: Prefs): String = prefs.serverUrl.trimEnd('/')
    fun external(prefs: Prefs): String = prefs.externalUrl.trimEnd('/')

    /** Base URL to show in the UI. Never performs network I/O. */
    fun active(prefs: Prefs): String {
        val local = local(prefs)
        val external = external(prefs)
        return when (prefs.serverMode) {
            "local" -> local
            "external" -> external.ifEmpty { local }
            else -> prefs.lastGoodBase.ifEmpty {
                if (local.isNotEmpty()) local else external
            }
        }
    }

    fun isExternalActive(prefs: Prefs): Boolean =
        active(prefs).isNotEmpty() && active(prefs) == external(prefs) && prefs.serverMode != "local"

    /** Ordered candidates. Performs a local probe in auto mode — call off the main thread. */
    fun candidates(prefs: Prefs): List<String> {
        val local = local(prefs)
        val external = external(prefs)
        val ordered = when (prefs.serverMode) {
            "local" -> listOf(local)
            "external" -> listOf(external, local)
            else -> when {
                local.isEmpty() -> listOf(external)
                external.isEmpty() -> listOf(local)
                probe(local) -> listOf(local, external)
                else -> listOf(external, local)
            }
        }
        return ordered.filter { it.isNotEmpty() }.distinct()
    }

    /** True when the HomeDeck /api/ping endpoint answers. Cached for two minutes. */
    fun probe(base: String): Boolean {
        val url = base.trimEnd('/')
        if (url.isEmpty()) return false
        val now = System.currentTimeMillis()
        cache[url]?.let { if (now - it.at < TTL_MS) return it.ok }
        val ok = ping(url)
        cache[url] = Probe(ok, now)
        return ok
    }

    fun recordGood(base: String) {
        if (base.isNotEmpty()) cache[base.trimEnd('/')] = Probe(true, System.currentTimeMillis())
    }

    fun markDown(base: String) {
        if (base.isNotEmpty()) cache[base.trimEnd('/')] = Probe(false, System.currentTimeMillis())
    }

    fun reset() {
        cache.clear()
    }

    fun normalize(raw: String): String? {
        val value = raw.trim()
        if (value.isEmpty()) return null
        return try {
            val url = URL(value)
            if (url.protocol != "http" && url.protocol != "https") return null
            if (url.host.isNullOrEmpty()) return null
            url.toString().trimEnd('/')
        } catch (_: Exception) {
            null
        }
    }

    private fun ping(base: String): Boolean {
        var connection: HttpURLConnection? = null
        return try {
            val url = URL(base.trimEnd('/') + "/api/ping")
            if (url.protocol != "http" && url.protocol != "https") return false
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                instanceFollowRedirects = true
                useCaches = false
            }
            connection.responseCode in 200..299
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
        }
    }
}
