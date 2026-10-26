package com.homedeck.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ApiException(message: String, val code: Int = 0) : Exception(message)

object Api {
    fun pair(serverUrl: String, code: String, deviceName: String): PairResult {
        val body = JSONObject()
            .put("code", code)
            .put("deviceName", deviceName)
            .toString()
        val raw = request("POST", serverUrl.trimEnd('/') + "/api/pair/claim", null, body)
        val o = JSONObject(raw)
        val user = o.optJSONObject("user") ?: JSONObject()
        val server = o.optJSONObject("server") ?: JSONObject()
        val token = o.optString("token", "")
        if (token.isEmpty()) throw ApiException("The server did not return a device token")
        return PairResult(
            token = token,
            serverUrl = o.optString("serverUrl", "").ifEmpty { serverUrl }.trimEnd('/'),
            username = user.optString("username", ""),
            displayName = user.optString("displayName", user.optString("username", "")),
            serverTitle = server.optString("title", "HomeDeck").ifEmpty { "HomeDeck" },
        )
    }

    fun summaryRaw(serverUrl: String, token: String): String =
        request("GET", serverUrl.trimEnd('/') + "/api/summary", token, null)

    fun revokeCurrent(serverUrl: String, token: String) {
        request("DELETE", serverUrl.trimEnd('/') + "/api/pair/current", token, null)
    }

    fun parseSummary(raw: String): Summary {
        val root = JSONObject(raw)
        val services = mutableListOf<Service>()
        val array = root.optJSONArray("services") ?: JSONArray()
        for (i in 0 until array.length()) {
            val j = array.optJSONObject(i) ?: continue
            val stats = mutableListOf<Stat>()
            val statArray = j.optJSONArray("stats") ?: JSONArray()
            for (k in 0 until statArray.length()) {
                val st = statArray.optJSONObject(k) ?: continue
                val label = st.optString("label", "")
                val value = valueToString(st.opt("value"))
                if (label.isNotEmpty() && value.isNotEmpty()) stats.add(Stat(label, value))
            }
            services.add(
                Service(
                    id = j.optInt("id", 0),
                    type = j.optString("type", ""),
                    name = j.optString("name", "Service"),
                    category = j.optString("category", "Other").ifEmpty { "Other" },
                    url = j.optString("url", ""),
                    fallbackUrl = j.optString("fallbackUrl", ""),
                    autoSwitch = j.optBoolean("autoSwitch", true),
                    online = j.optBoolean("online", false),
                    stale = j.optBoolean("stale", false),
                    error = j.optString("error", ""),
                    stats = stats,
                    version = str(j, "version"),
                    serverName = str(j, "serverName"),
                    activity = parseActivity(j.optJSONArray("activity")),
                    nowPlaying = parseNowPlaying(j.optJSONArray("nowPlaying")),
                    containers = parseContainers(j.optJSONArray("containers")),
                    history = parseHistory(j.optJSONArray("history")),
                    calendar = parseCalendar(j.optJSONArray("calendar")),
                    disks = parseDisks(j.optJSONArray("disks")),
                    charts = parseCharts(j.optJSONObject("charts")),
                    fetchedAt = j.optLong("fetchedAt", 0L),
                ),
            )
        }
        val weather = root.optJSONObject("weather")?.let { w ->
            val temp = w.optDouble("temp", Double.NaN)
            if (temp.isNaN()) "" else {
                val unit = w.optString("unit", "c").lowercase()
                val suffix = if (unit == "f") "°F" else "°C"
                val label = w.optString("label", "")
                "${Math.round(temp)}$suffix" + if (label.isNotEmpty()) " · $label" else ""
            }
        } ?: ""
        return Summary(services = services, generatedAt = root.optLong("generatedAt", 0L), weather = weather)
    }

    private fun valueToString(value: Any?): String = when (value) {
        null, JSONObject.NULL -> ""
        is Double -> if (!value.isInfinite() && !value.isNaN() && value == Math.floor(value)) value.toLong().toString() else value.toString()
        is Float -> if (!value.isInfinite() && !value.isNaN() && value == Math.floor(value.toDouble())) value.toLong().toString() else value.toString()
        else -> value.toString()
    }

    private fun str(j: JSONObject, key: String): String =
        if (!j.has(key) || j.isNull(key)) "" else j.optString(key, "")

    private fun parseActivity(array: JSONArray?): List<ActivityItem> {
        if (array == null) return emptyList()
        val out = mutableListOf<ActivityItem>()
        for (i in 0 until array.length()) {
            val j = array.optJSONObject(i) ?: continue
            out.add(
                ActivityItem(
                    id = str(j, "id"),
                    title = str(j, "title"),
                    subtitle = str(j, "subtitle"),
                    progress = j.optInt("progress", 0),
                    state = str(j, "state"),
                    paused = j.optBoolean("paused", false),
                    meta = str(j, "meta"),
                ),
            )
        }
        return out
    }

    private fun parseNowPlaying(array: JSONArray?): List<NowPlayingItem> {
        if (array == null) return emptyList()
        val out = mutableListOf<NowPlayingItem>()
        for (i in 0 until array.length()) {
            val j = array.optJSONObject(i) ?: continue
            val tr = j.optJSONObject("transcoding")
            out.add(
                NowPlayingItem(
                    id = str(j, "id"),
                    title = str(j, "title"),
                    subtitle = str(j, "subtitle"),
                    user = str(j, "user"),
                    progress = j.optInt("progress", 0),
                    position = j.optInt("position", 0),
                    duration = j.optInt("duration", 0),
                    positionMs = if (j.has("positionMs") && !j.isNull("positionMs")) {
                        j.optLong("positionMs", 0L)
                    } else {
                        j.optInt("position", 0) * 1000L
                    },
                    positionAt = j.optLong("positionAt", 0L),
                    playbackRate = j.optDouble("playbackRate", 1.0).takeIf { it > 0 } ?: 1.0,
                    art = str(j, "art"),
                    paused = j.optBoolean("paused", false),
                    device = str(j, "device"),
                    video = tr?.let { str(it, "video") } ?: "",
                    audio = tr?.let { str(it, "audio") } ?: "",
                    bitrate = tr?.optLong("bitrate", 0L) ?: 0L,
                ),
            )
        }
        return out
    }

    private fun parseContainers(array: JSONArray?): List<ContainerItem> {
        if (array == null) return emptyList()
        val out = mutableListOf<ContainerItem>()
        for (i in 0 until array.length()) {
            val j = array.optJSONObject(i) ?: continue
            out.add(
                ContainerItem(
                    name = str(j, "name"),
                    state = str(j, "state"),
                    status = str(j, "status"),
                    image = str(j, "image"),
                    url = str(j, "url"),
                    update = j.optBoolean("update", false),
                ),
            )
        }
        return out
    }

    private fun parseHistory(array: JSONArray?): List<HistoryItem> {
        if (array == null) return emptyList()
        val out = mutableListOf<HistoryItem>()
        for (i in 0 until array.length()) {
            val j = array.optJSONObject(i) ?: continue
            out.add(
                HistoryItem(
                    title = str(j, "title"),
                    subtitle = str(j, "subtitle"),
                    state = str(j, "state"),
                ),
            )
        }
        return out
    }

    private fun parseCalendar(array: JSONArray?): List<CalendarItem> {        if (array == null) return emptyList()
        val out = mutableListOf<CalendarItem>()
        for (i in 0 until array.length()) {
            val j = array.optJSONObject(i) ?: continue
            out.add(
                CalendarItem(
                    date = str(j, "date"),
                    title = str(j, "title"),
                    subtitle = str(j, "subtitle"),
                    image = str(j, "image"),
                    hasFile = j.optBoolean("hasFile", false),
                    grabbed = j.optBoolean("grabbed", false),
                ),
            )
        }
        return out
    }

    private fun parseDisks(array: JSONArray?): List<UnraidDisk> {
        if (array == null) return emptyList()
        val out = mutableListOf<UnraidDisk>()
        for (i in 0 until array.length()) {
            val j = array.optJSONObject(i) ?: continue
            out.add(
                UnraidDisk(
                    label = str(j, "label"),
                    size = str(j, "size"),
                    free = str(j, "free"),
                    used = str(j, "used"),
                    percent = if (j.isNull("pct")) null else j.optInt("pct"),
                    temp = if (j.isNull("temp")) null else j.optInt("temp"),
                    status = str(j, "status"),
                ),
            )
        }
        return out
    }

    private fun parseCharts(j: JSONObject?): Charts {
        if (j == null) return Charts()
        val pihole = mutableListOf<ChartPoint>()
        val series = j.optJSONObject("pihole")?.optJSONArray("series")
        if (series != null) {
            for (i in 0 until series.length()) {
                val p = series.optJSONObject(i) ?: continue
                pihole.add(
                    ChartPoint(
                        t = p.optLong("t", 0L),
                        queries = p.optInt("queries", 0),
                        blocked = p.optInt("blocked", 0),
                    ),
                )
            }
        }
        val disks = mutableListOf<DiskUsage>()
        val diskArr = j.optJSONArray("disks")
        if (diskArr != null) {
            for (i in 0 until diskArr.length()) {
                val d = diskArr.optJSONObject(i) ?: continue
                disks.add(
                    DiskUsage(
                        label = str(d, "label"),
                        usedGB = d.optDouble("usedGB", 0.0),
                        freeGB = d.optDouble("freeGB", 0.0),
                        totalGB = d.optDouble("totalGB", 0.0),
                    ),
                )
            }
        }
        val bars = mutableListOf<BarItem>()
        val barArr = j.optJSONArray("bars")
        if (barArr != null) {
            for (i in 0 until barArr.length()) {
                val b = barArr.optJSONObject(i) ?: continue
                bars.add(BarItem(label = str(b, "label"), value = b.optDouble("value", 0.0), sub = str(b, "sub")))
            }
        }
        val docker = j.optJSONObject("docker")?.let {
            DockerChart(
                running = it.optInt("running", 0),
                stopped = it.optInt("stopped", 0),
                unhealthy = it.optInt("unhealthy", 0),
            )
        }
        val downloads = j.optJSONObject("downloads")?.let {
            DownloadsChart(
                overall = it.optInt("overall", 0),
                speedBps = it.optLong("speedBps", 0L),
                paused = it.optBoolean("paused", false),
            )
        }
        return Charts(pihole = pihole, disks = disks, bars = bars, docker = docker, downloads = downloads)
    }

    private fun request(method: String, url: String, token: String?, body: String?): String {
        var connection: HttpURLConnection? = null
        try {
            val target = URL(url)
            if (target.protocol == "http" && !PairLinks.isLocalHost(target.host)) {
                throw ApiException("HTTPS is required for non-local servers", 0)
            }
            val conn = (target.openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 20_000
                // Never forward the bearer token through an automatic redirect.
                instanceFollowRedirects = false
                useCaches = false
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "HomeDeck-Android/1.0")
                if (token != null) setRequestProperty("Authorization", "Bearer $token")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
            }
            connection = conn
            if (body != null) {
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            if (status in 300..399) throw ApiException("Unexpected server redirect — check the server URL", status)
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (status !in 200..299) {
                val message = try {
                    JSONObject(text).optString("error", "")
                } catch (_: Exception) {
                    ""
                }.ifEmpty { "HTTP $status" }
                throw ApiException(message, status)
            }
            return text
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException(e.message ?: "Network error", 0)
        } finally {
            connection?.disconnect()
        }
    }
}
