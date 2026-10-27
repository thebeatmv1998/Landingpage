package com.homedeck.app

import android.net.Uri
import java.net.URL

data class Stat(val label: String, val value: String)

data class ChartPoint(val t: Long, val queries: Int, val blocked: Int)

data class DiskUsage(val label: String, val usedGB: Double, val freeGB: Double, val totalGB: Double) {
    val percent: Int
        get() = if (totalGB > 0) ((usedGB / totalGB) * 100).toInt().coerceIn(0, 100) else 0
}

data class BarItem(val label: String, val value: Double, val sub: String)

data class DockerChart(val running: Int, val stopped: Int, val unhealthy: Int)

data class DownloadsChart(val overall: Int, val speedBps: Long, val paused: Boolean)

data class HostChart(
    val cpu: List<Float> = emptyList(),
    val mem: List<Float> = emptyList(),
    val netRx: List<Float> = emptyList(),
    val netTx: List<Float> = emptyList(),
)

data class Charts(
    val pihole: List<ChartPoint> = emptyList(),
    val disks: List<DiskUsage> = emptyList(),
    val bars: List<BarItem> = emptyList(),
    val docker: DockerChart? = null,
    val downloads: DownloadsChart? = null,
    val host: HostChart? = null,
)

data class ActivityItem(
    val id: String,
    val title: String,
    val subtitle: String,
    val progress: Int,
    val state: String,
    val paused: Boolean,
    val meta: String,
)

data class NowPlayingItem(
    val id: String,
    val title: String,
    val subtitle: String,
    val user: String,
    val progress: Int,
    val position: Int,
    val duration: Int,
    val positionMs: Long,
    val positionAt: Long,
    val playbackRate: Double,
    val art: String,
    val paused: Boolean,
    val device: String,
    val video: String,
    val audio: String,
    val bitrate: Long,
    val controls: List<String> = emptyList(),
)

data class ContainerItem(
    val name: String,
    val state: String,
    val status: String,
    val image: String,
    val url: String,
    val update: Boolean,
    val id: String = "",
    val icon: String = "",
    val iconFallback: String = "",
)

data class RequestCounts(
    val open: Int = 0,
    val approved: Int = 0,
    val available: Int = 0,
)

data class RequestItem(
    val id: Int,
    val title: String,
    val subtitle: String,
    val user: String,
    val poster: String,
    val status: String,
    val statusLabel: String,
    val type: String,
)

data class HistoryItem(
    val title: String,
    val subtitle: String,
    val state: String,
)

data class CalendarItem(
    val date: String,
    val title: String,
    val subtitle: String,
    val image: String,
    val hasFile: Boolean,
    val grabbed: Boolean,
)

data class UnraidDisk(
    val label: String,
    val size: String,
    val free: String,
    val used: String,
    val percent: Int?,
    val temp: Int?,
    val status: String,
)

data class Service(
    val id: Int,
    val type: String,
    val name: String,
    val category: String,
    val url: String,
    val fallbackUrl: String,
    val autoSwitch: Boolean,
    val online: Boolean,
    val stale: Boolean,
    val error: String,
    val stats: List<Stat>,
    val version: String = "",
    val serverName: String = "",
    val iconUrl: String = "",
    val color: String = "",
    val hints: List<String> = emptyList(),
    val activity: List<ActivityItem> = emptyList(),
    val nowPlaying: List<NowPlayingItem> = emptyList(),
    val containers: List<ContainerItem> = emptyList(),
    val requests: List<RequestItem> = emptyList(),
    val requestCounts: RequestCounts = RequestCounts(),
    val history: List<HistoryItem> = emptyList(),
    val calendar: List<CalendarItem> = emptyList(),
    val disks: List<UnraidDisk> = emptyList(),
    val charts: Charts = Charts(),
    val fetchedAt: Long = 0L,
)

data class Summary(
    val services: List<Service>,
    val generatedAt: Long,
    val weather: String,
)

data class PairResult(
    val token: String,
    val serverUrl: String,
    val username: String,
    val displayName: String,
    val serverTitle: String,
    val role: String = "",
)

data class PairLink(val serverUrl: String, val code: String)

object PairLinks {
    /** Local/private hosts may use HTTP for LAN deployments; everything else requires HTTPS. */
    fun isLocalHost(host: String): Boolean {
        val h = host.trim().lowercase().removePrefix("[").removeSuffix("]")
        if (h == "localhost" || h == "::1") return true
        if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true
        if (!h.contains(".") && !h.contains(":")) return true // single-label LAN host, e.g. "tower"
        if (h.contains(":") && (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd"))) return true
        val parts = h.split('.')
        if (parts.size != 4) return false
        val nums = parts.mapNotNull { it.toIntOrNull() }
        if (nums.size != 4 || nums.any { it !in 0..255 }) return false
        return nums[0] == 10 ||
            (nums[0] == 172 && nums[1] in 16..31) ||
            (nums[0] == 192 && nums[1] == 168) ||
            nums[0] == 127 ||
            (nums[0] == 169 && nums[1] == 254)
    }

    fun isAllowedHttp(url: String): Boolean {
        return try {
            val u = URL(url)
            u.protocol == "http" && isLocalHost(u.host)
        } catch (_: Exception) {
            false
        }
    }

    fun parse(raw: String): PairLink? {
        val uri = try { Uri.parse(raw.trim()) } catch (_: Exception) { return null }
        if (uri.scheme != "homedeck" || uri.host != "pair") return null
        val server = uri.getQueryParameter("url")?.trim()?.trimEnd('/') ?: return null
        val code = uri.getQueryParameter("code")?.trim() ?: return null
        if (!server.startsWith("http://") && !server.startsWith("https://")) return null
        if (server.startsWith("http://") && !isAllowedHttp(server)) return null
        if (code.length < 20) return null
        return PairLink(server, code)
    }
}
