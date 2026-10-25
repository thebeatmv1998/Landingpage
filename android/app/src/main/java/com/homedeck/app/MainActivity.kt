package com.homedeck.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var secure: SecureStore
    private lateinit var palette: Palette
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val loading = AtomicBoolean(false)

    private lateinit var root: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var servicesBox: LinearLayout
    private lateinit var subtitle: TextView
    private lateinit var heroOnline: TextView
    private lateinit var heroOf: TextView
    private lateinit var heroDetail: TextView
    private lateinit var heroWeather: TextView
    private lateinit var heroProgress: ProgressBar
    private lateinit var updated: TextView

    private var lastSummary: Summary? = null
    private var offlineMode = false
    private var built = false
    private var pairingLaunched = false

    private val autoRefresh = object : Runnable {
        override fun run() {
            load(true)
            handler.postDelayed(this, prefs.refreshSeconds * 1000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        prefs = Prefs(this)
        secure = SecureStore(this)
        UiTheme.applyMode(this, prefs)
        super.onCreate(savedInstanceState)
        if (handlePairLink(intent)) return
        if (!isPaired()) {
            goPairing()
            return
        }
        palette = UiTheme.palette(this, prefs)
        buildUi()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handlePairLink(intent)
    }

    override fun onResume() {
        super.onResume()
        if (!::prefs.isInitialized) return
        if (!isPaired()) {
            goPairing()
            return
        }
        if (!built) return
        val currentAccent = UiTheme.parseColor(prefs.accent, "#c9963f")
        if (palette.accent != currentAccent) {
            recreate()
            return
        }
        handler.removeCallbacks(autoRefresh)
        handler.postDelayed(autoRefresh, prefs.refreshSeconds * 1000L)
        load(true)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(autoRefresh)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun isPaired(): Boolean = !secure.token().isNullOrEmpty() && prefs.serverUrl.isNotEmpty()

    private fun goPairing() {
        if (pairingLaunched) return
        pairingLaunched = true
        startActivity(Intent(this, PairingActivity::class.java))
        finish()
    }

    private fun handlePairLink(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (data.scheme != "homedeck" || data.host != "pair") return false
        startActivity(Intent(this, PairingActivity::class.java).setData(data))
        finish()
        return true
    }

    private fun buildUi() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(palette.bg)
        }
        setContentView(root)
        Ui.edgeToEdge(this, root, palette)

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val titleBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        titleBox.addView(Ui.text(this, prefs.serverTitle.ifEmpty { "HomeDeck" }, 22f, palette.text, true))
        subtitle = Ui.text(this, serverSubtitle(), 11.5f, palette.muted)
        subtitle.setPadding(0, Ui.dp(this, 2), 0, 0)
        titleBox.addView(subtitle)
        top.addView(titleBox, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        top.addView(Ui.iconButton(this, R.drawable.ic_refresh, palette.muted) { load(false) })
        top.addView(Ui.iconButton(this, R.drawable.ic_settings, palette.muted) {
            startActivity(Intent(this, SettingsActivity::class.java))
        })
        root.addView(top, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val hero = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@MainActivity, palette.card, 18, palette.line)
            setPadding(Ui.dp(this@MainActivity, 16), Ui.dp(this@MainActivity, 14), Ui.dp(this@MainActivity, 16), Ui.dp(this@MainActivity, 14))
        }
        root.addView(hero, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 14, 0, 0))

        val heroTop = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        heroOnline = Ui.text(this, "–", 30f, palette.text, true)
        heroOf = Ui.text(this, " / – online", 13f, palette.muted)
        val onlineLine = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.BOTTOM
        }
        onlineLine.addView(heroOnline)
        onlineLine.addView(heroOf, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 4, 0, 0, 3))
        heroTop.addView(onlineLine, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        heroWeather = Ui.text(this, "", 12f, palette.accent, true)
        heroTop.addView(heroWeather)
        hero.addView(heroTop)

        heroProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            progressTintList = ColorStateList.valueOf(palette.accent)
            progressBackgroundTintList = ColorStateList.valueOf(palette.line)
        }
        hero.addView(heroProgress, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 7)), 0, 12, 0, 0))
        heroDetail = Ui.text(this, "", 11.5f, palette.muted)
        hero.addView(heroDetail, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))

        scroll = ScrollView(this).apply {
            isFillViewport = false
            clipToPadding = false
        }
        servicesBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(servicesBox, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        root.addView(scroll, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f), 0, 14, 0, 0))

        updated = Ui.text(this, "", 10.5f, palette.faint)
        updated.gravity = Gravity.END
        root.addView(updated, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 10, 0, 0))

        servicesBox.addView(emptyCard("Connecting…", "Loading services from ${ServerResolver.active(prefs)}"))
        built = true
    }

    private fun load(silent: Boolean) {
        if (!built) return
        val token = secure.token()
        if (token.isNullOrEmpty()) {
            goPairing()
            return
        }
        if (!loading.compareAndSet(false, true)) return
        if (!silent) {
            updated.text = "Refreshing…"
            updated.setTextColor(palette.muted)
        }
        executor.execute {
            try {
                val fetched = SummaryRepository.fetch(prefs, token)
                val summary = fetched.summary
                appendDownloadHistory(summary)
                prefs.cachedSummary = fetched.raw
                prefs.cachedAt = System.currentTimeMillis()
                handler.post {
                    loading.set(false)
                    if (isFinishing || isDestroyed) return@post
                    offlineMode = false
                    lastSummary = summary
                    render(summary)
                    Reachability.probe(summary.services) {
                        if (!isFinishing && !isDestroyed) {
                            lastSummary?.let { render(it) }
                        }
                    }
                }
            } catch (error: ApiException) {
                handler.post {
                    loading.set(false)
                    if (isFinishing || isDestroyed) return@post
                    if (error.code == 401) {
                        sessionExpired()
                    } else {
                        showOffline(error.message ?: "Network error")
                    }
                }
            } catch (error: Exception) {
                handler.post {
                    loading.set(false)
                    if (isFinishing || isDestroyed) return@post
                    showOffline(error.message ?: "Network error")
                }
            }
        }
    }

    private fun sessionExpired() {
        secure.clear()
        Toast.makeText(this, "This device was unpaired — pair it again", Toast.LENGTH_LONG).show()
        goPairing()
    }

    private fun showOffline(message: String) {
        offlineMode = true
        val cached = prefs.cachedSummary
        if (cached.isNotEmpty()) {
            try {
                val summary = Api.parseSummary(cached)
                lastSummary = summary
                render(summary)
                return
            } catch (_: Exception) {
                // fall through to the error card
            }
        }
        renderError(message)
    }

    private fun render(summary: Summary) {
        if (!built) return
        val all = summary.services
        val online = all.count { it.online }
        heroOnline.text = online.toString()
        heroOf.text = " / ${all.size} online"
        heroProgress.max = maxOf(1, all.size)
        heroProgress.progress = online
        heroWeather.text = summary.weather
        heroWeather.visibility = if (summary.weather.isEmpty()) View.GONE else View.VISIBLE
        subtitle.text = serverSubtitle()

        if (offlineMode) {
            heroDetail.text = "Offline — showing cached data"
            heroDetail.setTextColor(palette.warn)
            updated.text = if (prefs.cachedAt > 0) "Cached ${time(prefs.cachedAt)}" else "Offline"
            updated.setTextColor(palette.warn)
        } else {
            heroDetail.text = when {
                all.isEmpty() -> "No services configured"
                online == all.size -> "All services online"
                else -> "${all.size - online} offline"
            }
            heroDetail.setTextColor(if (all.isNotEmpty() && online < all.size) palette.warn else palette.muted)
            updated.text = if (summary.generatedAt > 0) "Updated ${time(summary.generatedAt)}" else ""
            updated.setTextColor(palette.faint)
        }

        var shown = all
        if (!prefs.showOffline) shown = shown.filter { it.online }
        val previousScroll = scroll.scrollY
        servicesBox.removeAllViews()
        if (all.isEmpty()) {
            servicesBox.addView(emptyCard("No services yet", "Add services in the HomeDeck web UI."))
            return
        }
        if (shown.isEmpty()) {
            servicesBox.addView(emptyCard("Everything is offline", "HomeDeck cannot reach any service right now."))
            return
        }
        insightsRow(all)?.let { insights ->
            servicesBox.addView(Ui.label(this, "Insights", palette.faint), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 2, 2, 2, 6))
            servicesBox.addView(insights, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 4))
        }
        if (prefs.groupByCategory) {
            val groups = LinkedHashMap<String, MutableList<Service>>()
            for (service in shown) {
                groups.getOrPut(service.category.ifEmpty { "Other" }) { mutableListOf() }.add(service)
            }
            for ((category, list) in groups) {
                servicesBox.addView(Ui.label(this, category, palette.faint), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 2, 12, 2, 6))
                for (service in list) {
                    servicesBox.addView(serviceCard(service), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 8))
                }
            }
        } else {
            servicesBox.addView(Ui.label(this, "Services", palette.faint), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 2, 2, 2, 6))
            for (service in shown) {
                servicesBox.addView(serviceCard(service), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 8))
            }
        }
        scroll.post { scroll.scrollTo(0, previousScroll) }
    }

    private fun appendDownloadHistory(summary: Summary) {
        for (service in summary.services) {
            val downloads = service.charts.downloads ?: continue
            HistoryStore.addDownload(service.id, downloads.speedBps)
        }
    }

    private fun insightsRow(all: List<Service>): View? {
        val cards = mutableListOf<View>()

        all.firstOrNull { it.type == "pihole" && it.charts.pihole.size >= 2 }?.let { service ->
            val queries = service.stats.firstOrNull { it.label.contains("Queries", true) }?.value
                ?: formatCount(service.charts.pihole.sumOf { it.queries })
            val card = insightCard("Pi-hole · 24h", queries, "queries") { openDetail(service) }
            val chart = AreaChartView(this).apply {
                points = service.charts.pihole
                accent = palette.accent
                blockedColor = palette.bad
                gridColor = palette.line
                textColor = palette.faint
            }
            card.addView(chart, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 72)), 0, 8, 0, 0))
            val legend = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            legend.addView(dot(palette.accent), Ui.lp(Ui.dp(this, 7), Ui.dp(this, 7)))
            legend.addView(Ui.text(this, "Queries", 10f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 4, 0, 10, 0))
            legend.addView(dot(palette.bad), Ui.lp(Ui.dp(this, 7), Ui.dp(this, 7)))
            legend.addView(Ui.text(this, "Blocked", 10f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 4, 0, 0, 0))
            card.addView(legend, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 5, 0, 0))
            cards.add(card)
        }

        all.firstOrNull { it.type == "sabnzbd" && it.charts.downloads != null }?.let { service ->
            val downloads = service.charts.downloads ?: return@let
            val card = insightCard(
                "Downloads",
                formatSpeed(downloads.speedBps),
                if (downloads.paused) "paused" else "${downloads.overall}% complete",
            ) { openDetail(service) }
            val spark = SparklineView(this).apply {
                values = (HistoryStore.downloads[service.id] ?: emptyList()).toList()
                accent = palette.accent
                gridColor = palette.line
            }
            card.addView(spark, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 62)), 0, 8, 0, 0))
            cards.add(card)
        }

        all.firstOrNull { service -> service.charts.disks.any { it.totalGB > 0 } }?.let { service ->
            val disk = service.charts.disks.first { it.totalGB > 0 }
            val card = cardShell("Storage") { openDetail(service) }
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val donut = DonutView(this).apply {
                segments = listOf(
                    DonutView.Segment(disk.usedGB.toFloat(), palette.accent),
                    DonutView.Segment(disk.freeGB.toFloat(), palette.line),
                )
                label = "${disk.percent}%"
                sub = "used"
                trackColor = palette.card2
                textColor = palette.text
                mutedColor = palette.muted
            }
            row.addView(donut, Ui.lp(Ui.dp(this, 82), Ui.dp(this, 82)))
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(Ui.text(this, service.name, 14f, palette.text, true))
            col.addView(Ui.text(this, "${formatGB(disk.usedGB)} / ${formatGB(disk.totalGB)}", 10.5f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0))
            col.addView(Ui.text(this, "${formatGB(disk.freeGB)} free", 10f, palette.faint), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0))
            row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 8, 0, 0, 0))
            card.addView(row, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))
            cards.add(card)
        }

        all.firstOrNull { it.charts.docker != null }?.let { service ->
            val docker = service.charts.docker ?: return@let
            val total = docker.running + docker.stopped
            val card = cardShell("Docker") { openDetail(service) }
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
            row.addView(donut, Ui.lp(Ui.dp(this, 82), Ui.dp(this, 82)))
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(Ui.text(this, "$total containers", 14f, palette.text, true))
            col.addView(Ui.text(this, "${docker.stopped} stopped", 10.5f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0))
            if (docker.unhealthy > 0) {
                col.addView(Ui.text(this, "${docker.unhealthy} unhealthy", 10f, palette.warn), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0))
            }
            row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 8, 0, 0, 0))
            card.addView(row, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))
            cards.add(card)
        }

        if (cards.isEmpty()) return null
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
        }
        for (card in cards) {
            row.addView(card, Ui.margins(this, Ui.lp(Ui.dp(this, 258), LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 10, 0))
        }
        return HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            clipToPadding = false
            addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun cardShell(title: String, onClick: () -> Unit): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@MainActivity, palette.card, 14, palette.line)
            setPadding(Ui.dp(this@MainActivity, 12), Ui.dp(this@MainActivity, 12), Ui.dp(this@MainActivity, 12), Ui.dp(this@MainActivity, 12))
            isClickable = true
            isFocusable = true
        }
        card.addView(Ui.label(this, title, palette.faint))
        card.setOnClickListener { onClick() }
        return card
    }

    private fun insightCard(title: String, value: String, subtitle: String, onClick: () -> Unit): LinearLayout {
        val card = cardShell(title, onClick)
        card.addView(Ui.text(this, value, 19f, palette.text, true), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 5, 0, 0))
        if (subtitle.isNotEmpty()) {
            card.addView(Ui.text(this, subtitle, 10.5f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 1, 0, 0))
        }
        return card
    }

    private fun dot(color: Int): View =
        View(this).apply { background = Ui.circle(this@MainActivity, color, 4) }

    private fun openDetail(service: Service) {
        startActivity(
            Intent(this, ServiceDetailActivity::class.java)
                .putExtra("serviceId", service.id)
                .putExtra("serviceName", service.name),
        )
    }

    private fun renderError(message: String) {
        if (!built) return
        heroOnline.text = "–"
        heroOf.text = " / – online"
        heroProgress.progress = 0
        heroWeather.visibility = View.GONE
        heroDetail.text = message
        heroDetail.setTextColor(palette.bad)
        updated.text = "Offline"
        updated.setTextColor(palette.bad)
        servicesBox.removeAllViews()
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@MainActivity, palette.card, 14, palette.bad)
            setPadding(Ui.dp(this@MainActivity, 16), Ui.dp(this@MainActivity, 16), Ui.dp(this@MainActivity, 16), Ui.dp(this@MainActivity, 16))
        }
        card.addView(Ui.text(this, "Can't reach HomeDeck", 16f, palette.text, true))
        card.addView(Ui.text(this, message, 12f, palette.muted), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 6, 0, 0))
        val retry = Ui.button(this, "Try again", palette.accent, palette.onAccent)
        retry.setOnClickListener { load(false) }
        card.addView(retry, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 14, 0, 0))
        servicesBox.addView(card)
    }

    private fun emptyCard(title: String, message: String): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@MainActivity, palette.card, 14, palette.line)
            setPadding(Ui.dp(this@MainActivity, 16), Ui.dp(this@MainActivity, 18), Ui.dp(this@MainActivity, 16), Ui.dp(this@MainActivity, 18))
        }
        card.addView(Ui.text(this, title, 15f, palette.text, true))
        card.addView(Ui.text(this, message, 12f, palette.muted).apply { setPadding(0, Ui.dp(this@MainActivity, 5), 0, 0) })
        return card
    }

    private fun serviceCard(service: Service): View {
        val verticalPadding = if (prefs.compact) 9 else 12
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = Ui.rounded(this@MainActivity, palette.card, 14, palette.line)
            setPadding(Ui.dp(this@MainActivity, 10), Ui.dp(this@MainActivity, verticalPadding), Ui.dp(this@MainActivity, 12), Ui.dp(this@MainActivity, verticalPadding))
            isClickable = true
            isFocusable = true
            alpha = if (service.online) 1f else 0.72f
        }
        val stripeColor = when {
            !service.online -> palette.bad
            service.stale -> palette.warn
            else -> palette.ok
        }
        val stripe = View(this).apply {
            background = Ui.rounded(this@MainActivity, stripeColor, 2)
        }
        card.addView(stripe, LinearLayout.LayoutParams(Ui.dp(this, 4), Ui.dp(this, if (prefs.compact) 30 else 38)))

        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.setPadding(Ui.dp(this, 12), 0, 0, 0)

        val nameRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        nameRow.addView(Ui.text(this, service.name, if (prefs.compact) 13.5f else 15f, palette.text, true))
        if (Reachability.isExternal(service)) {
            nameRow.addView(
                Ui.icon(this, R.drawable.ic_globe, palette.accent, 13),
                Ui.margins(this, Ui.lp(Ui.dp(this, 13), Ui.dp(this, 13)), 5, 0, 0, 0),
            )
        }
        content.addView(nameRow)

        val meta = mutableListOf<String>()
        if (!prefs.compact) meta.add(service.category)
        meta.add(if (service.online) (if (service.stale) "stale" else "online") else "offline")
        content.addView(
            Ui.text(this, meta.joinToString(" · "), 11f, if (service.online) palette.muted else palette.bad),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
        )

        val stats = service.stats.take(if (prefs.compact) 1 else 2).joinToString(" · ") { "${it.label}: ${it.value}" }
        if (stats.isNotEmpty()) {
            content.addView(
                Ui.text(this, stats, 12f, palette.muted).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
                Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0),
            )
        }
        if (!service.online && service.error.isNotEmpty() && !prefs.compact) {
            content.addView(
                Ui.text(this, service.error, 10.5f, palette.bad).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
                Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0),
            )
        }
        card.addView(content, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val url = Reachability.effectiveUrl(service)
        if (url.isNotEmpty()) {
            card.addView(
                Ui.icon(this, R.drawable.ic_chevron, palette.faint, 15),
                Ui.margins(this, Ui.lp(Ui.dp(this, 15), Ui.dp(this, 15)), 8, 0, 0, 0),
            )
        }
        card.setOnClickListener { openDetail(service) }
        card.setOnLongClickListener {
            if (url.isEmpty()) {
                false
            } else {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("HomeDeck URL", url))
                Toast.makeText(this, "URL copied", Toast.LENGTH_SHORT).show()
                true
            }
        }
        return card
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

    private fun serverSubtitle(): String {
        val active = ServerResolver.active(prefs)
        val host = try {
            Uri.parse(active).host ?: active
        } catch (_: Exception) {
            active
        }
        val user = prefs.userName.ifEmpty { "paired device" }
        val scheme = if (active.startsWith("https://")) "HTTPS" else "HTTP"
        val route = if (ServerResolver.isExternalActive(prefs)) "external" else "primary"
        return "$host · $user · $scheme · $route"
    }

    private fun time(timestamp: Long): String =
        if (timestamp <= 0) "" else DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(timestamp))
}
