package com.homedeck.app

import android.net.Uri

data class Stat(val label: String, val value: String)

data class ChartPoint(val t: Long, val queries: Int, val blocked: Int)

data class DiskUsage(val label: String, val usedGB: Double, val freeGB: Double, val totalGB: Double) {
    val percent: Int
        get() = if (totalGB > 0) ((usedGB / totalGB) * 100).toInt().coerceIn(0, 100) else 0
}

data class BarItem(val label: String, val value: Double, val sub: String)

data class DockerChart(val running: Int, val stopped: Int, val unhealthy: Int)

data class DownloadsChart(val overall: Int, val speedBps: Long, val paused: Boolean)

data class Charts(
    val pihole: List<ChartPoint> = emptyList(),
    val disks: List<DiskUsage> = emptyList(),
    val bars: List<BarItem> = emptyList(),
    val docker: DockerChart? = null,
    val downloads: DownloadsChart? = null,
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
)

data class ContainerItem(
    val name: String,
    val state: String,
    val status: String,
    val image: String,
    val url: String,
    val update: Boolean,
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
    val activity: List<ActivityItem> = emptyList(),
    val nowPlaying: List<NowPlayingItem> = emptyList(),
    val containers: List<ContainerItem> = emptyList(),
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
)

data class PairLink(val serverUrl: String, val code: String)

object PairLinks {
    fun parse(raw: String): PairLink? {
        val uri = try { Uri.parse(raw.trim()) } catch (_: Exception) { return null }
        if (uri.scheme != "homedeck" || uri.host != "pair") return null
        val server = uri.getQueryParameter("url")?.trim()?.trimEnd('/') ?: return null
        val code = uri.getQueryParameter("code")?.trim() ?: return null
        if (!server.startsWith("http://") && !server.startsWith("https://")) return null
        if (code.length < 20) return null
        return PairLink(server, code)
    }
}
