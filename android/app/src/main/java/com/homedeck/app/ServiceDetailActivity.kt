package com.homedeck.app

import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class ServiceDetailActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var secure: SecureStore
    private lateinit var palette: Palette
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var content: LinearLayout
    private lateinit var titleView: TextView
    private lateinit var subtitleView: TextView
    private var serviceId: Int = 0
    private var initialName: String = "Service"
    private var token: String = ""
    private var activeBase: String = ""
    private var loading = false

    private data class LiveRow(
        val time: TextView,
        val bar: ProgressBar,
        val positionMs: Long,
        val durationMs: Long,
        val positionAt: Long,
        val paused: Boolean,
        val rate: Double,
    )

    private val liveRows = mutableListOf<LiveRow>()
    private val ticker = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            for (row in liveRows) paintLiveRow(row, now)
            handler.postDelayed(this, 1000)
        }
    }

    override fun onResume() {
        super.onResume()
        handler.post(ticker)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(ticker)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        prefs = Prefs(this)
        secure = SecureStore(this)
        UiTheme.applyMode(this, prefs)
        super.onCreate(savedInstanceState)
        palette = UiTheme.palette(this, prefs)
        serviceId = intent.getIntExtra("serviceId", 0)
        initialName = intent.getStringExtra("serviceName") ?: "Service"
        token = secure.token() ?: run {
            finish()
            return
        }
        buildUi()
        load()
    }

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(palette.bg)
        }
        setContentView(root)
        Ui.edgeToEdge(this, root, palette)

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(Ui.iconButton(this, R.drawable.ic_back, palette.muted) { finish() })
        val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        titleView = Ui.text(this, initialName, 19f, palette.text, true)
        subtitleView = Ui.text(this, "Loading…", 11f, palette.muted)
        subtitleView.setPadding(0, Ui.dp(this, 2), 0, 0)
        titles.addView(titleView)
        titles.addView(subtitleView)
        top.addView(titles, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 6, 0, 0, 0))
        top.addView(Ui.iconButton(this, R.drawable.ic_refresh, palette.muted) { load() })
        root.addView(top, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val scroll = ScrollView(this).apply { clipToPadding = false }
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        root.addView(scroll, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f), 0, 14, 0, 0))
        content.addView(loadingCard())
    }

    private fun load() {
        if (loading) return
        loading = true
        liveRows.clear()
        content.removeAllViews()
        content.addView(loadingCard())
        executor.execute {
            try {
                val fetched = SummaryRepository.fetch(prefs, token)
                activeBase = fetched.base
                val service = fetched.summary.services.firstOrNull { it.id == serviceId }
                handler.post {
                    loading = false
                    if (isFinishing || isDestroyed) return@post
                    if (service == null) {
                        renderError("This service is not available for your account.")
                    } else {
                        titleView.text = service.name
                        subtitleView.text = "${service.category} · ${if (service.online) "online" else "offline"} · ${if (ServerResolver.isExternalActive(prefs)) "external" else "primary"}"
                        render(service)
                    }
                }
            } catch (error: ApiException) {
                handler.post {
                    loading = false
                    if (isFinishing || isDestroyed) return@post
                    if (error.code == 401) {
                        secure.clear()
                        startActivity(
                            Intent(this, PairingActivity::class.java)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                        )
                        finish()
                    } else {
                        renderError(error.message ?: "Network error")
                    }
                }
            } catch (error: Exception) {
                handler.post {
                    loading = false
                    if (isFinishing || isDestroyed) return@post
                    renderError(error.message ?: "Network error")
                }
            }
        }
    }

    private fun render(service: Service) {
        liveRows.clear()
        content.removeAllViews()

        val header = card()
        val nameRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        nameRow.addView(dot(statusColor(service)), Ui.margins(this, Ui.lp(Ui.dp(this, 9), Ui.dp(this, 9)), 0, 0, 8, 0))
        nameRow.addView(Ui.text(this, service.name, 22f, palette.text, true), Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (Reachability.isExternal(service)) {
            nameRow.addView(Ui.icon(this, R.drawable.ic_globe, palette.accent, 16))
        }
        header.addView(nameRow)

        val meta = mutableListOf(service.category)
        if (service.version.isNotEmpty()) meta.add("v${service.version}")
        if (service.serverName.isNotEmpty()) meta.add(service.serverName)
        header.addView(
            Ui.text(this, meta.filter { it.isNotEmpty() }.joinToString(" · "), 11.5f, palette.muted),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 4, 0, 0),
        )

        if (service.stats.isNotEmpty()) {
            header.addView(statsGrid(service.stats), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 12, 0, 0))
        }

        val url = Reachability.effectiveUrl(service)
        if (url.isNotEmpty()) {
            val open = Ui.button(this, "Open WebUI", palette.accent, palette.onAccent)
            open.setOnClickListener { openUrl(url) }
            header.addView(open, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 14, 0, 0))
            if (Reachability.isExternal(service)) {
                header.addView(
                    Ui.text(this, "Using the public address because the local address is unreachable.", 10.5f, palette.accent),
                    Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 7, 0, 0),
                )
            }
        }
        content.addView(header, sectionMargins())

        when (service.type) {
            "pihole" -> addPihole(service)
            "sabnzbd" -> addSAB(service)
            "unraid" -> addUnraid(service)
            "docker" -> addDocker(service)
            "sonarr", "radarr", "lidarr" -> addArr(service)
            "jellyfin", "audiobookshelf", "navidrome" -> addNowPlaying(service)
            "seerr", "overseerr", "jellyseerr" -> addRequests(service)
            "prowlarr", "nzbhydra" -> addIndexers(service)
        }

        if (service.activity.isNotEmpty()) addActivity(service)
        if (service.history.isNotEmpty()) addHistory(service)
        if (service.calendar.isNotEmpty()) addCalendar(service)
        addInfo(service)
    }

    private fun addPihole(service: Service) {
        if (service.charts.pihole.size < 2) return
        val body = section("Queries · 24h")

        fun stat(label: String): String {
            val raw = service.stats.firstOrNull { it.label.equals(label, true) }?.value?.trim() ?: ""
            return if (raw.isNotEmpty() && raw.all { it.isDigit() }) formatCount(raw.toLong()) else raw
        }
        val queries = stat("Queries today").ifEmpty { formatCount(service.charts.pihole.sumOf { it.queries }) }
        val blocked = stat("Blocked").ifEmpty { formatCount(service.charts.pihole.sumOf { it.blocked }) }
        val rate = stat("Blocked %").ifEmpty {
            val total = service.charts.pihole.sumOf { it.queries }
            val blockedTotal = service.charts.pihole.sumOf { it.blocked }
            if (total > 0) String.format(Locale.US, "%.1f%%", blockedTotal * 100.0 / total) else "0%"
        }

        val statsRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        statsRow.addView(statCell("Queries", queries, palette.text), Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        statsRow.addView(
            statCell("Blocked", blocked, palette.bad),
            Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 6, 0, 0, 0),
        )
        statsRow.addView(
            statCell("Blocked %", rate, palette.accent),
            Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 6, 0, 0, 0),
        )
        body.addView(statsRow)

        val chart = AreaChartView(this).apply {
            points = service.charts.pihole
            accent = palette.accent
            blockedColor = palette.bad
            gridColor = palette.line
            textColor = palette.faint
            bubbleColor = palette.card2
            bubbleTextColor = palette.text
        }
        body.addView(chart, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 190)), 0, 10, 0, 0))

        val legend = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        legend.addView(Ui.toggleChip(this, palette, "Queries", palette.accent, true) { on -> chart.showQueries = on })
        legend.addView(
            Ui.toggleChip(this, palette, "Blocked", palette.bad, true) { on -> chart.showBlocked = on },
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 6, 0, 0, 0),
        )
        legend.addView(
            Ui.text(this, "drag to inspect", 9.5f, palette.faint).apply { gravity = Gravity.END },
            Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        body.addView(legend, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))
    }

    private fun statCell(label: String, value: String, color: Int): LinearLayout {
        val cell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@ServiceDetailActivity, palette.card2, 10, palette.line)
            setPadding(Ui.dp(this@ServiceDetailActivity, 9), Ui.dp(this@ServiceDetailActivity, 7), Ui.dp(this@ServiceDetailActivity, 9), Ui.dp(this@ServiceDetailActivity, 7))
        }
        cell.addView(Ui.text(this, label, 9.5f, palette.muted))
        cell.addView(
            Ui.text(this, value, 15f, color, true).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            },
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
        )
        return cell
    }

    private fun addSAB(service: Service) {
        val downloads = service.charts.downloads
        if (downloads != null) {
            val body = section("Download speed")
            val top = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.BOTTOM
            }
            top.addView(Ui.text(this, formatSpeed(downloads.speedBps), 24f, palette.text, true), Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            if (downloads.paused) {
                top.addView(Ui.text(this, "paused", 11f, palette.warn, true))
            }
            body.addView(top)
            val spark = SparklineView(this).apply {
                values = (HistoryStore.downloads[service.id] ?: emptyList()).toList()
                accent = palette.accent
                gridColor = palette.line
            }
            body.addView(spark, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 100)), 0, 8, 0, 0))
            body.addView(progressRow("Queue", "${downloads.overall}%", downloads.overall, palette.accent), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))
            val toggle = Ui.actionButton(
                this,
                palette,
                if (downloads.paused) "Resume queue" else "Pause queue",
                if (downloads.paused) R.drawable.ic_play else R.drawable.ic_pause,
                if (downloads.paused) palette.ok else palette.accent,
            ) { runAction(service, if (downloads.paused) "resume" else "pause") }
            body.addView(toggle, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))
        }
    }

    private fun addArr(service: Service) {
        if (service.charts.disks.isNotEmpty()) {
            val body = section("Storage")
            for (disk in service.charts.disks) {
                body.addView(
                    progressRow(
                        disk.label.ifEmpty { "Disk" },
                        "${formatGB(disk.usedGB)} / ${formatGB(disk.totalGB)} · ${formatGB(disk.freeGB)} free",
                        disk.percent,
                        if (disk.percent > 90) palette.bad else palette.accent,
                    ),
                    rowMargins(),
                )
            }
        }
    }

    private fun addUnraid(service: Service) {
        if (service.charts.disks.isNotEmpty()) {
            val body = section("Array capacity")
            for (disk in service.charts.disks) {
                body.addView(
                    progressRow(
                        disk.label.ifEmpty { "Array" },
                        "${formatGB(disk.usedGB)} / ${formatGB(disk.totalGB)} · ${formatGB(disk.freeGB)} free",
                        disk.percent,
                        if (disk.percent > 90) palette.bad else palette.accent,
                    ),
                    rowMargins(),
                )
            }
        }
        if (service.disks.isNotEmpty()) {
            val body = section("Disks")
            for (disk in service.disks) {
                val sub = listOf(disk.used, "${disk.free} free", disk.temp?.let { "$it °C" } ?: "", disk.status)
                    .filter { it.isNotBlank() }
                    .joinToString(" · ")
                body.addView(progressRow(disk.label, sub, disk.percent ?: 0, if ((disk.percent ?: 0) > 90) palette.bad else palette.accent), rowMargins())
            }
        }
        if (service.containers.isNotEmpty()) addContainers(service)
    }

    private fun addDocker(service: Service) {
        val docker = service.charts.docker
        if (docker != null) {
            val body = section("Containers")
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val donut = DonutView(this).apply {
                segments = listOf(
                    DonutView.Segment(docker.running.toFloat(), palette.ok),
                    DonutView.Segment(docker.unhealthy.toFloat(), palette.warn),
                    DonutView.Segment((docker.stopped - docker.unhealthy).coerceAtLeast(0).toFloat(), palette.faint),
                )
                label = docker.running.toString()
                sub = "running"
                trackColor = palette.card2
                textColor = palette.text
                mutedColor = palette.muted
            }
            row.addView(donut, Ui.lp(Ui.dp(this, 100), Ui.dp(this, 100)))
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(Ui.text(this, "${docker.running + docker.stopped} containers", 15f, palette.text, true))
            col.addView(Ui.text(this, "${docker.stopped} stopped", 11f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0))
            if (docker.unhealthy > 0) {
                col.addView(Ui.text(this, "${docker.unhealthy} unhealthy", 11f, palette.warn), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0))
            }
            row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 12, 0, 0, 0))
            body.addView(row)
        }
        if (service.containers.isNotEmpty()) addContainers(service)
    }

    private fun addContainers(service: Service) {
        val body = section("Container details")
        if (service.type == "unraid" && isAdmin()) {
            body.addView(
                Ui.actionButton(this, palette, "Update all", R.drawable.ic_update, palette.accent) {
                    runAction(service, "update-all", confirm = "Update all containers? This can take a while.")
                },
                Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 8),
            )
        }
        for (container in service.containers.take(60)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, Ui.dp(this@ServiceDetailActivity, 7), 0, Ui.dp(this@ServiceDetailActivity, 7))
            }
            val running = container.state == "running"
            row.addView(dot(if (running) palette.ok else palette.bad), Ui.margins(this, Ui.lp(Ui.dp(this, 8), Ui.dp(this, 8)), 0, 0, 9, 0))
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            val nameRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            nameRow.addView(Ui.text(this, container.name, 13f, palette.text, true))
            if (container.update) {
                val badge = Ui.text(this, "UPDATE", 8.5f, palette.onAccent, true).apply {
                    gravity = Gravity.CENTER
                    background = Ui.rounded(this@ServiceDetailActivity, palette.accent, 4)
                    setPadding(Ui.dp(this@ServiceDetailActivity, 4), Ui.dp(this@ServiceDetailActivity, 1), Ui.dp(this@ServiceDetailActivity, 4), Ui.dp(this@ServiceDetailActivity, 1))
                }
                nameRow.addView(badge, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 6, 0, 0, 0))
            }
            col.addView(nameRow)
            val detail = listOf(container.image, container.status.ifEmpty { container.state }).filter { it.isNotBlank() }.joinToString(" · ")
            col.addView(Ui.text(this, detail, 10f, palette.muted).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            }, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0))
            if (isAdmin() && container.id.isNotEmpty() && (service.type == "docker" || service.type == "unraid")) {
                val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                if (container.update) {
                    actions.addView(
                        Ui.actionButton(this, palette, "Update", R.drawable.ic_update, palette.accent) {
                            runAction(service, "update", container.id)
                        },
                    )
                }
                if (running) {
                    actions.addView(
                        Ui.actionButton(this, palette, "Restart", R.drawable.ic_refresh, palette.muted) {
                            runAction(service, "restart", container.id, confirm = "Restart ${container.name}?")
                        },
                        Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 6, 0, 0, 0),
                    )
                    actions.addView(
                        Ui.actionButton(this, palette, "Stop", R.drawable.ic_stop, palette.bad) {
                            runAction(service, "stop", container.id, confirm = "Stop ${container.name}?")
                        },
                        Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 6, 0, 0, 0),
                    )
                } else {
                    actions.addView(
                        Ui.actionButton(this, palette, "Start", R.drawable.ic_play, palette.ok) {
                            runAction(service, "start", container.id)
                        },
                    )
                }
                col.addView(actions, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 5, 0, 0))
            }
            row.addView(col, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            if (container.url.isNotEmpty()) {
                row.addView(Ui.icon(this, R.drawable.ic_chevron, palette.faint, 14))
                row.setOnClickListener { openUrl(container.url) }
            }
            body.addView(row)
        }
    }

    private fun addNowPlaying(service: Service) {
        if (service.nowPlaying.isEmpty()) return
        val body = section("Now playing")
        for (item in service.nowPlaying) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, Ui.dp(this@ServiceDetailActivity, 7), 0, Ui.dp(this@ServiceDetailActivity, 7))
            }
            val art = ImageView(this).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                background = Ui.rounded(this@ServiceDetailActivity, palette.card2, 8)
                clipToOutline = true
            }
            row.addView(art, Ui.lp(Ui.dp(this, 54), Ui.dp(this, 54)))
            val artUrl = ImageLoader.artUrl(activeBase, service, item.art)
            if (artUrl.isNotEmpty()) ImageLoader.load(art, artUrl, token, activeBase)
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(Ui.text(this, item.title, 13.5f, palette.text, true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
            val sub = listOf(item.subtitle, item.user, item.device).filter { it.isNotBlank() }.joinToString(" · ")
            col.addView(Ui.text(this, sub, 10.5f, palette.muted).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
            val bar = progressBar(item.progress, if (item.paused) palette.warn else palette.accent)
            col.addView(bar, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 5)), 0, 6, 0, 0))
            val timeView = Ui.text(this, "", 10f, palette.faint)
            col.addView(timeView, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0))
            val extra = listOf(if (item.paused) "paused" else "", item.video, item.audio, if (item.bitrate > 0) formatSpeed(item.bitrate) else "")
                .filter { it.isNotBlank() }
                .joinToString(" · ")
            if (extra.isNotEmpty()) {
                col.addView(Ui.text(this, extra, 9.5f, palette.faint), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0))
            }
            val positionMs = if (item.positionMs > 0) item.positionMs else item.position * 1000L
            val durationMs = item.duration * 1000L
            val positionAt = if (item.positionAt > 0) item.positionAt else (service.fetchedAt.takeIf { it > 0 } ?: System.currentTimeMillis())
            val live = LiveRow(timeView, bar, positionMs, durationMs, positionAt, item.paused, item.playbackRate)
            liveRows.add(live)
            paintLiveRow(live, System.currentTimeMillis())
            val controls = when {
                item.controls.isNotEmpty() -> item.controls
                service.type == "jellyfin" -> listOf("pause", "resume", "stop")
                else -> emptyList()
            }
            if (controls.isNotEmpty()) {
                val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                val pauseAction = if (item.paused) "resume" else "pause"
                if (controls.contains(pauseAction)) {
                    actions.addView(
                        Ui.actionButton(
                            this,
                            palette,
                            if (item.paused) "Resume" else "Pause",
                            if (item.paused) R.drawable.ic_play else R.drawable.ic_pause,
                            if (item.paused) palette.ok else palette.accent,
                        ) { runAction(service, pauseAction, item.id) },
                    )
                }
                if (controls.contains("stop")) {
                    actions.addView(
                        Ui.actionButton(this, palette, "Stop", R.drawable.ic_stop, palette.bad) {
                            runAction(service, "stop", item.id, confirm = "Stop playback of \"${item.title}\"?")
                        },
                        Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 6, 0, 0, 0),
                    )
                }
                col.addView(actions, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 7, 0, 0))
            }
            row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 10, 0, 0, 0))
            body.addView(row, rowMargins())
        }
    }

    private fun paintLiveRow(row: LiveRow, now: Long) {
        val elapsed = if (row.paused) {
            row.positionMs
        } else {
            row.positionMs + ((now - row.positionAt).coerceAtLeast(0) * row.rate).toLong()
        }
        val shown = if (row.durationMs > 0) elapsed.coerceAtMost(row.durationMs) else elapsed
        row.time.text = if (row.durationMs > 0) {
            "${formatDuration((shown / 1000).toInt())} / ${formatDuration((row.durationMs / 1000).toInt())}"
        } else {
            formatDuration((shown / 1000).toInt())
        }
        if (row.durationMs > 0) {
            row.bar.progress = ((shown.toDouble() / row.durationMs) * 100).toInt().coerceIn(0, 100)
        }
    }

    private fun addIndexers(service: Service) {
        if (service.charts.bars.isEmpty()) return
        val body = section("Indexers")
        val max = service.charts.bars.maxOfOrNull { it.value }?.coerceAtLeast(1.0) ?: 1.0
        for (bar in service.charts.bars) {
            val pct = ((bar.value / max) * 100).toInt().coerceIn(0, 100)
            val value = if (bar.sub.isNotEmpty()) bar.sub else formatCount(bar.value)
            body.addView(progressRow(bar.label, value, pct, palette.accent), rowMargins())
        }
    }

    private fun addActivity(service: Service) {
        val body = section("Queue")
        for (item in service.activity.take(20)) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            val top = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            top.addView(Ui.text(this, item.title, 12.5f, palette.text, true).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            }, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            if (item.meta.isNotEmpty()) top.addView(Ui.text(this, item.meta, 10f, palette.muted))
            row.addView(top)
            if (item.subtitle.isNotEmpty()) {
                row.addView(Ui.text(this, item.subtitle, 10f, palette.muted).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                })
            }
            row.addView(progressBar(item.progress, if (item.paused) palette.warn else palette.accent), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 5)), 0, 5, 0, 0))
            if (service.type == "sabnzbd" && item.id.isNotEmpty()) {
                val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                controls.addView(
                    Ui.smallIconButton(
                        this,
                        if (item.paused) R.drawable.ic_play else R.drawable.ic_pause,
                        if (item.paused) palette.ok else palette.accent,
                        28,
                        14,
                    ) {
                        runAction(service, if (item.paused) "slot_resume" else "slot_pause", item.id)
                    },
                )
                row.addView(controls, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 4, 0, 0))
            }
            body.addView(row, rowMargins())
        }
    }

    private fun addHistory(service: Service) {
        val body = section("Recent history")
        for (item in service.history.take(8)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, Ui.dp(this@ServiceDetailActivity, 5), 0, Ui.dp(this@ServiceDetailActivity, 5))
            }
            row.addView(dot(if (item.state == "failed") palette.bad else palette.ok), Ui.margins(this, Ui.lp(Ui.dp(this, 7), Ui.dp(this, 7)), 0, 0, 8, 0))
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(Ui.text(this, item.title, 12f, palette.text).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
            col.addView(Ui.text(this, item.subtitle, 9.5f, palette.muted).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
            row.addView(col, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            body.addView(row)
        }
    }

    private fun addCalendar(service: Service) {
        val body = section("Upcoming")
        for (event in service.calendar.take(10)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, Ui.dp(this@ServiceDetailActivity, 6), 0, Ui.dp(this@ServiceDetailActivity, 6))
            }
            val art = ImageView(this).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                background = Ui.rounded(this@ServiceDetailActivity, palette.card2, 7)
                clipToOutline = true
            }
            row.addView(art, Ui.lp(Ui.dp(this, 40), Ui.dp(this, 40)))
            val artUrl = ImageLoader.artUrl(activeBase, service, event.image)
            if (artUrl.isNotEmpty()) ImageLoader.load(art, artUrl, token, activeBase)
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(Ui.text(this, event.title, 12.5f, palette.text, true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
            if (event.subtitle.isNotEmpty()) {
                col.addView(Ui.text(this, event.subtitle, 10f, palette.muted).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
            }
            if (event.date.isNotEmpty()) {
                col.addView(Ui.text(this, formatDate(event.date), 9.5f, palette.faint), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0))
            }
            row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 9, 0, 0, 0))
            body.addView(row)
        }
    }

    private fun addRequests(service: Service) {
        val counts = service.requestCounts
        if (service.requests.isEmpty() && counts.open + counts.approved + counts.available == 0) return
        val body = section("Requests")
        val chips = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        chips.addView(requestChip("${counts.open}", "open", palette.warn))
        chips.addView(
            requestChip("${counts.approved}", "approved", palette.ok),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 6, 0, 0, 0),
        )
        chips.addView(
            requestChip("${counts.available}", "available", palette.accent),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 6, 0, 0, 0),
        )
        body.addView(chips, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 8))

        for (request in service.requests.take(12)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, Ui.dp(this@ServiceDetailActivity, 5), 0, Ui.dp(this@ServiceDetailActivity, 5))
            }
            val art = ImageView(this).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                background = Ui.rounded(this@ServiceDetailActivity, palette.card2, 7)
                clipToOutline = true
            }
            row.addView(art, Ui.lp(Ui.dp(this, 44), Ui.dp(this, 60)))
            val artUrl = ImageLoader.artUrl(activeBase, service, request.poster)
            if (artUrl.isNotEmpty()) ImageLoader.load(art, artUrl, token, activeBase)
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(
                Ui.text(this, request.title, 12.5f, palette.text, true).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
            )
            val sub = listOf(request.subtitle, request.user).filter { it.isNotBlank() }.joinToString(" · ")
            if (sub.isNotEmpty()) {
                col.addView(
                    Ui.text(this, sub, 10f, palette.muted).apply {
                        maxLines = 1
                        ellipsize = TextUtils.TruncateAt.END
                    },
                )
            }
            if (request.statusLabel.isNotEmpty()) {
                col.addView(
                    Ui.text(this, request.statusLabel, 9.5f, if (request.status == "pending") palette.warn else palette.faint),
                    Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
                )
            }
            row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 9, 0, 4, 0))
            if (isAdmin() && request.status == "pending") {
                row.addView(
                    Ui.smallIconButton(this, R.drawable.ic_check, palette.ok, 30, 15) {
                        runAction(service, "approve_request", request.id)
                    },
                )
                row.addView(
                    Ui.smallIconButton(this, R.drawable.ic_close, palette.bad, 30, 15) {
                        runAction(service, "decline_request", request.id, confirm = "Decline \"${request.title}\"?")
                    },
                    Ui.margins(this, Ui.lp(Ui.dp(this, 30), Ui.dp(this, 30)), 5, 0, 0, 0),
                )
            }
            body.addView(row, rowMargins())
        }
    }

    private fun requestChip(value: String, label: String, color: Int): LinearLayout {
        val chip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = Ui.rounded(this@ServiceDetailActivity, Ui.withAlpha(color, 20), 11, Ui.withAlpha(color, 55))
            setPadding(Ui.dp(this@ServiceDetailActivity, 8), Ui.dp(this@ServiceDetailActivity, 4), Ui.dp(this@ServiceDetailActivity, 9), Ui.dp(this@ServiceDetailActivity, 4))
        }
        chip.addView(Ui.text(this, value, 11.5f, color, true))
        chip.addView(
            Ui.text(this, label, 9f, palette.muted),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 3, 0, 0, 0),
        )
        return chip
    }

    private fun addInfo(service: Service) {
        val body = section("Info")
        infoRow(body, "Category", service.category)
        infoRow(body, "Version", service.version)
        infoRow(body, "Server", service.serverName)
        infoRow(body, "Updated", if (service.fetchedAt > 0) DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(service.fetchedAt)) else "")
        infoRow(body, "Local URL", service.url)
        infoRow(body, "External URL", service.fallbackUrl)
        infoRow(body, "Auto-switch", if (service.fallbackUrl.isNotEmpty()) (if (service.autoSwitch) "on" else "off") else "")
        if (!service.online && service.error.isNotEmpty()) infoRow(body, "Error", service.error)
    }

    private fun infoRow(body: LinearLayout, label: String, value: String) {
        if (value.isBlank()) return
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, Ui.dp(this@ServiceDetailActivity, 5), 0, Ui.dp(this@ServiceDetailActivity, 5))
        }
        row.addView(Ui.text(this, label, 11.5f, palette.muted), Ui.lp(Ui.dp(this, 100), LinearLayout.LayoutParams.WRAP_CONTENT))
        row.addView(Ui.text(this, value, 11f, palette.text).apply {
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
        }, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        body.addView(row)
    }

    private fun statsGrid(stats: List<Stat>): LinearLayout {
        val grid = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        var index = 0
        while (index < stats.size) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            for (column in 0..1) {
                val stat = stats.getOrNull(index + column)
                if (stat == null) {
                    row.addView(View(this), Ui.lp(0, 1, 1f))
                } else {
                    val cell = LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        background = Ui.rounded(this@ServiceDetailActivity, palette.card2, 10, palette.line)
                        setPadding(Ui.dp(this@ServiceDetailActivity, 10), Ui.dp(this@ServiceDetailActivity, 8), Ui.dp(this@ServiceDetailActivity, 10), Ui.dp(this@ServiceDetailActivity, 8))
                    }
                    cell.addView(Ui.text(this, stat.label, 9.5f, palette.muted))
                    cell.addView(
                        Ui.text(this, stat.value, 15f, palette.text, true).apply {
                            maxLines = 1
                            ellipsize = TextUtils.TruncateAt.END
                        },
                        Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
                    )
                    row.addView(cell, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 0, 0, if (column == 0) 6 else 0, 6))
                }
            }
            grid.addView(row)
            index += 2
        }
        return grid
    }

    private fun progressRow(label: String, value: String, percent: Int, color: Int): LinearLayout {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(Ui.text(this, label, 12.5f, palette.text).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        top.addView(Ui.text(this, value.ifBlank { "$percent%" }, 10.5f, palette.muted))
        box.addView(top)
        box.addView(progressBar(percent, color), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 5)), 0, 5, 0, 0))
        return box
    }

    private fun progressBar(percent: Int, color: Int): ProgressBar =
        ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = percent.coerceIn(0, 100)
            progressTintList = ColorStateList.valueOf(color)
            progressBackgroundTintList = ColorStateList.valueOf(palette.line)
        }

    private fun section(title: String): LinearLayout {
        val box = card()
        box.addView(Ui.label(this, title, palette.faint))
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        box.addView(body, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))
        content.addView(box, sectionMargins())
        return body
    }

    private fun card(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@ServiceDetailActivity, palette.card, 16, palette.line)
            setPadding(Ui.dp(this@ServiceDetailActivity, 15), Ui.dp(this@ServiceDetailActivity, 14), Ui.dp(this@ServiceDetailActivity, 15), Ui.dp(this@ServiceDetailActivity, 15))
        }

    private fun sectionMargins(): LinearLayout.LayoutParams =
        Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 10)

    private fun rowMargins(): LinearLayout.LayoutParams =
        Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 10)

    private fun loadingCard(): View =
        emptyCard("Loading…", "Fetching the latest data from HomeDeck.")

    private fun renderError(message: String) {
        liveRows.clear()
        content.removeAllViews()
        val card = card()
        card.addView(Ui.text(this, "Could not load this service", 17f, palette.text, true))
        card.addView(Ui.text(this, message, 12f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 7, 0, 0))
        val retry = Ui.button(this, "Try again", palette.accent, palette.onAccent)
        retry.setOnClickListener { load() }
        card.addView(retry, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 14, 0, 0))
        content.addView(card, sectionMargins())
    }

    private fun emptyCard(title: String, message: String): View {
        val card = card()
        card.addView(Ui.text(this, title, 16f, palette.text, true))
        card.addView(Ui.text(this, message, 12f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0))
        return card
    }

    private fun statusColor(service: Service): Int = when {
        !service.online -> palette.bad
        service.stale -> palette.warn
        else -> palette.ok
    }

    private fun dot(color: Int): View =
        View(this).apply { background = Ui.circle(this@ServiceDetailActivity, color, 4) }

    private fun isAdmin(): Boolean = prefs.role == "admin"

    private fun runAction(service: Service, action: String, value: Any? = null, confirm: String? = null) {
        val perform = {
            executor.execute {
                try {
                    val result = Api.action(
                        activeBase.ifEmpty { ServerResolver.active(prefs) },
                        token,
                        service.id,
                        action,
                        value,
                    )
                    handler.post {
                        if (isFinishing || isDestroyed) return@post
                        Toast.makeText(this, result.message, Toast.LENGTH_SHORT).show()
                        if (result.ok) handler.postDelayed({ load() }, 700)
                    }
                } catch (error: Exception) {
                    handler.post {
                        if (!isFinishing && !isDestroyed) {
                            Toast.makeText(this, error.message ?: "Action failed", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }
        if (confirm != null) {
            AlertDialog.Builder(this)
                .setMessage(confirm)
                .setPositiveButton("Continue") { _, _ -> perform() }
                .setNegativeButton("Cancel", null)
                .show()
        } else {
            perform()
        }
    }

    private fun openUrl(url: String) {
        if (url.isEmpty() || (!url.startsWith("http://") && !url.startsWith("https://"))) {
            Toast.makeText(this, "No WebUI URL configured", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
            Toast.makeText(this, "Could not open the URL", Toast.LENGTH_SHORT).show()
        }
    }

    private fun formatDate(raw: String): String {
        if (raw.isBlank()) return ""
        return try {
            val iso = raw.replace(" ", "T")
            val parsed = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).parse(iso.substringBefore('.').substringBefore('Z'))
                ?: SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(raw)
            parsed?.let { SimpleDateFormat("EEE d MMM · HH:mm", Locale.getDefault()).format(it) } ?: raw
        } catch (_: Exception) {
            raw
        }
    }
}
