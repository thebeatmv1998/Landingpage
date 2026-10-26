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
    private var activeBase = ""
    private var chartsAnimated = false

    private data class LiveCardRow(
        val bar: ProgressBar,
        val time: TextView,
        val positionMs: Long,
        val durationMs: Long,
        val positionAt: Long,
        val paused: Boolean,
        val rate: Double,
    )

    private val liveCards = mutableListOf<LiveCardRow>()

    private val cardTicker = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            for (row in liveCards) paintLiveCard(row, now)
            handler.postDelayed(this, 1000)
        }
    }

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
        handler.removeCallbacks(cardTicker)
        handler.post(cardTicker)
        load(true)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(autoRefresh)
        handler.removeCallbacks(cardTicker)
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
                activeBase = fetched.base
                if (prefs.role.isEmpty()) {
                    try {
                        prefs.role = Api.me(fetched.base, token)
                    } catch (_: Exception) {
                        // keep the controls hidden until the role is known
                    }
                }
                appendDownloadHistory(summary)
                prefs.cachedSummary = fetched.raw
                prefs.cachedAt = System.currentTimeMillis()
                handler.post {
                    loading.set(false)
                    if (isFinishing || isDestroyed) return@post
                    offlineMode = false
                    lastSummary = summary
                    safeRender(summary)
                    Reachability.probe(summary.services) {
                        if (!isFinishing && !isDestroyed) {
                            lastSummary?.let { safeRender(it) }
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
                safeRender(summary)
                return
            } catch (_: Exception) {
                // fall through to the error card
            }
        }
        renderError(message)
    }

    private fun safeRender(summary: Summary) {
        try {
            render(summary)
        } catch (t: Throwable) {
            android.util.Log.e("HomeDeck", "Dashboard render failed", t)
            renderError("Could not draw the dashboard: ${t.message ?: "unknown error"}")
        }
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
        liveCards.clear()
        servicesBox.removeAllViews()
        if (all.isEmpty()) {
            servicesBox.addView(emptyCard("No services yet", "Add services in the HomeDeck web UI."))
            return
        }
        if (shown.isEmpty()) {
            servicesBox.addView(emptyCard("Everything is offline", "HomeDeck cannot reach any service right now."))
            return
        }
        val insights = buildInsights(all)
        if (insights.isNotEmpty()) {
            servicesBox.addView(Ui.label(this, "Insights", palette.faint), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 2, 2, 2, 8))
            for (view in insights) {
                servicesBox.addView(view, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 8))
            }
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
        chartsAnimated = true
    }

    private fun appendDownloadHistory(summary: Summary) {
        for (service in summary.services) {
            val downloads = service.charts.downloads ?: continue
            HistoryStore.addDownload(service.id, downloads.speedBps)
        }
    }

    private fun buildInsights(all: List<Service>): List<View> {
        val blocks = mutableListOf<View>()
        piholeCard(all)?.let { blocks.add(it) }
        widgetRow(all)?.let { blocks.add(it) }
        healthCard(all)?.let { blocks.add(it) }
        return blocks
    }

    /** Full-width Pi-hole card with a scrubbable 24h graph. */
    private fun piholeCard(all: List<Service>): View? {
        val service = all.firstOrNull { it.type == "pihole" && it.charts.pihole.size >= 2 } ?: return null
        fun stat(label: String): String = prettyStat(
            service.stats.firstOrNull { it.label.equals(label, true) }?.value ?: "",
        )
        val queries = stat("Queries today").ifEmpty { formatCount(service.charts.pihole.sumOf { it.queries }) }
        val blocked = stat("Blocked").ifEmpty { formatCount(service.charts.pihole.sumOf { it.blocked }) }
        val rateText = stat("Blocked %").ifEmpty {
            val q = service.charts.pihole.sumOf { it.queries }
            val b = service.charts.pihole.sumOf { it.blocked }
            if (q > 0) String.format(Locale.US, "%.1f%%", b * 100.0 / q) else "0%"
        }
        val rate = (rateText.removeSuffix("%").toFloatOrNull() ?: 0f).coerceIn(0f, 100f)
        val clients = stat("Clients")
        val domains = stat("Blocklist")

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.ripple(
                this@MainActivity, palette.card, 18, palette.line, palette.text,
                if (palette.isDark) 26 else 16,
            )
            setPadding(Ui.dp(this@MainActivity, 14), Ui.dp(this@MainActivity, 13), Ui.dp(this@MainActivity, 14), Ui.dp(this@MainActivity, 13))
            isClickable = true
            isFocusable = true
        }
        card.setOnClickListener { openDetail(service) }

        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(Ui.label(this, "Pi-hole", palette.faint), Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(dot(if (service.online) palette.ok else palette.bad), Ui.lp(Ui.dp(this, 7), Ui.dp(this, 7)))
        head.addView(
            Ui.text(this, "LIVE · 24H", 9f, palette.faint, true),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 5, 0, 0, 0),
        )
        card.addView(head)

        val summary = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val numbers = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        numbers.addView(Ui.text(this, queries, 26f, palette.text, true))
        numbers.addView(
            Ui.text(this, "$blocked blocked · $rateText", 11f, palette.muted),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
        )
        val extra = listOf(
            if (clients.isNotEmpty()) "$clients clients" else "",
            if (domains.isNotEmpty()) "$domains domains" else "",
        ).filter { it.isNotEmpty() }.joinToString(" · ")
        if (extra.isNotEmpty()) {
            numbers.addView(
                Ui.text(this, extra, 10f, palette.faint),
                Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
            )
        }
        summary.addView(numbers, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val donut = DonutView(this).apply {
            segments = listOf(
                DonutView.Segment(rate.coerceAtLeast(0.1f), palette.bad),
                DonutView.Segment((100f - rate).coerceAtLeast(0.1f), palette.line),
            )
            label = rateText
            sub = "blocked"
            trackColor = palette.card2
            textColor = palette.text
            mutedColor = palette.muted
        }
        summary.addView(donut, Ui.lp(Ui.dp(this, 66), Ui.dp(this, 66)))
        card.addView(summary, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 6, 0, 0))

        val chart = AreaChartView(this).apply {
            animate = !chartsAnimated
            points = service.charts.pihole
            accent = palette.accent
            blockedColor = palette.bad
            gridColor = palette.line
            textColor = palette.faint
            bubbleColor = palette.card2
            bubbleTextColor = palette.text
        }
        card.addView(chart, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 116)), 0, 8, 0, 0))

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
        card.addView(legend, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 7, 0, 0))
        return card
    }

    /** Horizontal strip of secondary insight cards. */
    private fun widgetRow(all: List<Service>): View? {
        val cards = mutableListOf<View>()
        all.filter { it.nowPlaying.isNotEmpty() }.take(2).forEach { cards.add(nowPlayingCard(it)) }
        requestsCard(all)?.let { cards.add(it) }
        all.firstOrNull { it.type == "sabnzbd" && it.charts.downloads != null }?.let { cards.add(downloadsCard(it)) }
        upcomingCard(all)?.let { cards.add(it) }
        all.firstOrNull { service -> service.charts.disks.any { it.totalGB > 0 } }?.let { storageCard(it)?.let(cards::add) }
        all.firstOrNull { it.charts.docker != null }?.let { dockerCard(it)?.let(cards::add) }
        if (cards.isEmpty()) return null
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
        }
        for (card in cards) {
            row.addView(card, Ui.margins(this, Ui.lp(Ui.dp(this, 264), LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 10, 0))
        }
        return HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            clipToPadding = false
            addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun nowPlayingCard(service: Service): View {
        val item = service.nowPlaying.first()
        val card = cardShell("Now playing · ${service.name}", { openDetail(service) })
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
        }
        val art = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = Ui.rounded(this@MainActivity, palette.card2, 8)
            clipToOutline = true
        }
        row.addView(art, Ui.lp(Ui.dp(this, 56), Ui.dp(this, 56)))
        val artUrl = ImageLoader.artUrl(activeBase, service, item.art)
        if (artUrl.isNotEmpty()) ImageLoader.load(art, artUrl, secure.token() ?: "", activeBase)

        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(
            Ui.text(this, item.title, 13f, palette.text, true).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            },
        )
        val sub = listOf(item.user, item.device, if (item.paused) "paused" else "")
            .filter { it.isNotBlank() }
            .joinToString(" · ")
        if (sub.isNotEmpty()) {
            col.addView(
                Ui.text(this, sub, 10f, if (item.paused) palette.warn else palette.muted).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
                Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
            )
        }
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = item.progress.coerceIn(0, 100)
            progressTintList = ColorStateList.valueOf(if (item.paused) palette.warn else palette.accent)
            progressBackgroundTintList = ColorStateList.valueOf(palette.line)
        }
        col.addView(bar, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 4)), 0, 7, 0, 0))
        val timeView = Ui.text(this, "", 9.5f, palette.faint)
        col.addView(timeView, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0))
        row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 9, 0, 0, 0))
        card.addView(row, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 9, 0, 0))

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
                    Ui.smallIconButton(
                        this,
                        if (item.paused) R.drawable.ic_play else R.drawable.ic_pause,
                        if (item.paused) palette.ok else palette.accent,
                        30,
                        15,
                    ) { runAction(service, pauseAction, item.id) },
                )
            }
            if (controls.contains("stop")) {
                actions.addView(
                    Ui.smallIconButton(this, R.drawable.ic_stop, palette.bad, 30, 15) {
                        runAction(service, "stop", item.id, confirm = "Stop playback of \"${item.title}\"?")
                    },
                    Ui.margins(this, Ui.lp(Ui.dp(this, 30), Ui.dp(this, 30)), 6, 0, 0, 0),
                )
            }
            card.addView(actions, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 7, 0, 0))
        }

        val positionMs = if (item.positionMs > 0) item.positionMs else item.position * 1000L
        val durationMs = item.duration * 1000L
        val positionAt = if (item.positionAt > 0) item.positionAt else (service.fetchedAt.takeIf { it > 0 } ?: System.currentTimeMillis())
        val live = LiveCardRow(bar, timeView, positionMs, durationMs, positionAt, item.paused, item.playbackRate)
        liveCards.add(live)
        paintLiveCard(live, System.currentTimeMillis())
        return card
    }

    private fun paintLiveCard(row: LiveCardRow, now: Long) {
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

    private fun downloadsCard(service: Service): View {
        val downloads = service.charts.downloads ?: return cardShell(service.name) {}
        val card = cardShell("Downloads", { openDetail(service) })
        card.addView(
            Ui.text(this, formatSpeed(downloads.speedBps), 20f, palette.text, true),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 4, 0, 0),
        )
        card.addView(
            Ui.text(
                this,
                if (downloads.paused) "paused" else "${downloads.overall}% complete",
                10.5f,
                if (downloads.paused) palette.warn else palette.muted,
            ),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 1, 0, 0),
        )
        val spark = SparklineView(this).apply {
            values = (HistoryStore.downloads[service.id] ?: emptyList()).toList()
            accent = palette.accent
            gridColor = palette.line
        }
        card.addView(spark, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 46)), 0, 7, 0, 0))
        val queueBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = downloads.overall.coerceIn(0, 100)
            progressTintList = ColorStateList.valueOf(palette.accent)
            progressBackgroundTintList = ColorStateList.valueOf(palette.line)
        }
        card.addView(queueBar, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 4)), 0, 6, 0, 0))
        val queueToggle = Ui.actionButton(
            this,
            palette,
            if (downloads.paused) "Resume queue" else "Pause queue",
            if (downloads.paused) R.drawable.ic_play else R.drawable.ic_pause,
            if (downloads.paused) palette.ok else palette.accent,
        ) { runAction(service, if (downloads.paused) "resume" else "pause") }
        card.addView(queueToggle, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 6, 0, 0))
        for (item in service.activity.take(2)) {
            val line = listOf(item.title, item.meta.ifEmpty { "${item.progress}%" }).joinToString(" · ")
            card.addView(
                Ui.text(this, line, 9.5f, palette.muted).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
                Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 4, 0, 0),
            )
        }
        return card
    }

    private fun requestsCard(all: List<Service>): View? {
        val service = all.firstOrNull { it.type == "seerr" || it.type == "overseerr" || it.type == "jellyseerr" } ?: return null
        val counts = service.requestCounts
        if (service.requests.isEmpty() && counts.open + counts.approved + counts.available == 0) return null
        val card = cardShell("Requests · ${service.name}", { openDetail(service) })
        val chips = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        chips.addView(countChip("${counts.open}", "open", palette.warn))
        chips.addView(
            countChip("${counts.approved}", "approved", palette.ok),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 5, 0, 0, 0),
        )
        chips.addView(
            countChip("${counts.available}", "available", palette.accent),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 5, 0, 0, 0),
        )
        card.addView(chips, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 7, 0, 0))

        val items = service.requests.sortedBy { if (it.status == "pending") 0 else 1 }.take(2)
        for (request in items) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, Ui.dp(this@MainActivity, 4), 0, Ui.dp(this@MainActivity, 4))
            }
            val art = ImageView(this).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                background = Ui.rounded(this@MainActivity, palette.card2, 6)
                clipToOutline = true
            }
            row.addView(art, Ui.lp(Ui.dp(this, 32), Ui.dp(this, 44)))
            val artUrl = ImageLoader.artUrl(activeBase, service, request.poster)
            if (artUrl.isNotEmpty()) ImageLoader.load(art, artUrl, secure.token() ?: "", activeBase)
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(
                Ui.text(this, request.title, 11.5f, palette.text, true).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
            )
            val sub = listOf(request.user, request.statusLabel).filter { it.isNotBlank() }.joinToString(" · ")
            col.addView(
                Ui.text(this, sub, 9.5f, if (request.status == "pending") palette.warn else palette.muted).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
            )
            row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 8, 0, 4, 0))
            if (isAdmin() && request.status == "pending") {
                row.addView(
                    Ui.smallIconButton(this, R.drawable.ic_check, palette.ok, 28, 14) {
                        runAction(service, "approve_request", request.id)
                    },
                )
                row.addView(
                    Ui.smallIconButton(this, R.drawable.ic_close, palette.bad, 28, 14) {
                        runAction(service, "decline_request", request.id, confirm = "Decline \"${request.title}\"?")
                    },
                    Ui.margins(this, Ui.lp(Ui.dp(this, 28), Ui.dp(this, 28)), 4, 0, 0, 0),
                )
            }
            card.addView(row)
        }
        return card
    }

    private fun countChip(value: String, label: String, color: Int): LinearLayout {
        val chip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = Ui.rounded(this@MainActivity, Ui.withAlpha(color, 20), 11, Ui.withAlpha(color, 55))
            setPadding(Ui.dp(this@MainActivity, 7), Ui.dp(this@MainActivity, 3), Ui.dp(this@MainActivity, 8), Ui.dp(this@MainActivity, 3))
        }
        chip.addView(Ui.text(this, value, 11f, color, true))
        chip.addView(
            Ui.text(this, label, 8.5f, palette.muted),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 3, 0, 0, 0),
        )
        return chip
    }

    private fun upcomingCard(all: List<Service>): View? {
        val events = all.flatMap { service -> service.calendar.map { service to it } }
            .sortedBy { it.second.date }
            .take(3)
        if (events.isEmpty()) return null
        val card = cardShell("Upcoming", { openDetail(events.first().first) })
        for ((service, event) in events) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, Ui.dp(this@MainActivity, 5), 0, Ui.dp(this@MainActivity, 5))
                isClickable = true
                isFocusable = true
            }
            row.setOnClickListener { openDetail(service) }
            val (day, month) = eventBadge(event.date)
            val badge = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                background = Ui.rounded(this@MainActivity, palette.card2, 8, palette.line)
            }
            badge.addView(Ui.text(this, day, 14f, palette.text, true))
            if (month.isNotEmpty()) badge.addView(Ui.text(this, month, 7.5f, palette.faint, true))
            row.addView(badge, Ui.lp(Ui.dp(this, 36), Ui.dp(this, 38)))
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(
                Ui.text(this, event.title, 11.5f, palette.text, true).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
            )
            val sub = listOf(event.subtitle, service.name).filter { it.isNotBlank() }.joinToString(" · ")
            if (sub.isNotEmpty()) {
                col.addView(
                    Ui.text(this, sub, 9.5f, palette.muted).apply {
                        maxLines = 1
                        ellipsize = TextUtils.TruncateAt.END
                    },
                )
            }
            row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 8, 0, 0, 0))
            card.addView(row, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 4, 0, 0))
        }
        return card
    }

    private fun storageCard(service: Service): View? {
        val disk = service.charts.disks.firstOrNull { it.totalGB > 0 } ?: return null
        val card = cardShell("Storage", { openDetail(service) })
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
        row.addView(donut, Ui.lp(Ui.dp(this, 78), Ui.dp(this, 78)))
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(Ui.text(this, service.name, 14f, palette.text, true))
        col.addView(
            Ui.text(this, "${formatGB(disk.usedGB)} / ${formatGB(disk.totalGB)}", 10.5f, palette.muted),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0),
        )
        col.addView(
            Ui.text(this, "${formatGB(disk.freeGB)} free", 10f, palette.faint),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
        )
        row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 8, 0, 0, 0))
        card.addView(row, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))
        return card
    }

    private fun dockerCard(service: Service): View? {
        val docker = service.charts.docker ?: return null
        val total = docker.running + docker.stopped
        val card = cardShell("Docker", { openDetail(service) })
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
        row.addView(donut, Ui.lp(Ui.dp(this, 78), Ui.dp(this, 78)))
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(Ui.text(this, "$total containers", 14f, palette.text, true))
        col.addView(
            Ui.text(this, "${docker.stopped} stopped", 10.5f, palette.muted),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 3, 0, 0),
        )
        if (docker.unhealthy > 0) {
            col.addView(
                Ui.text(this, "${docker.unhealthy} unhealthy", 10f, palette.warn),
                Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 2, 0, 0),
            )
        }
        row.addView(col, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 8, 0, 0, 0))
        card.addView(row, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0))
        if (service.containers.isNotEmpty()) {
            val strip = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            for (container in service.containers.take(7)) {
                strip.addView(
                    Icons.container(
                        this,
                        palette,
                        activeBase.ifEmpty { ServerResolver.active(prefs) },
                        service,
                        container,
                        secure.token() ?: "",
                        22,
                        false,
                    ),
                    Ui.margins(this, Ui.lp(Ui.dp(this, 22), Ui.dp(this, 22)), 0, 0, 4, 0),
                )
            }
            card.addView(strip, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 7, 0, 0))
        }
        return card
    }

    /** Compact, tappable status strip for every service. */
    private fun healthCard(all: List<Service>): View? {
        if (all.isEmpty()) return null
        val online = all.count { it.online }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@MainActivity, palette.card, 14, palette.line)
            setPadding(Ui.dp(this@MainActivity, 12), Ui.dp(this@MainActivity, 10), Ui.dp(this@MainActivity, 12), Ui.dp(this@MainActivity, 10))
        }
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(Ui.label(this, "Service health", palette.faint), Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(
            Ui.text(
                this,
                "$online/${all.size} online",
                10f,
                if (online == all.size) palette.ok else palette.warn,
                true,
            ),
        )
        card.addView(head)

        val strip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        for (service in all) {
            val color = when {
                !service.online -> palette.bad
                service.stale -> palette.warn
                else -> palette.ok
            }
            val pill = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(Ui.dp(this@MainActivity, 9), Ui.dp(this@MainActivity, 5), Ui.dp(this@MainActivity, 10), Ui.dp(this@MainActivity, 5))
                background = Ui.ripple(
                    this@MainActivity, palette.card2, 20, palette.line, palette.text,
                    if (palette.isDark) 24 else 14,
                )
                isClickable = true
                isFocusable = true
                alpha = if (service.online) 1f else 0.66f
            }
            pill.addView(View(this).apply { background = Ui.circle(this@MainActivity, color, 3) }, Ui.lp(Ui.dp(this, 6), Ui.dp(this, 6)))
            pill.addView(
                Ui.text(this, service.name, 10.5f, if (service.online) palette.text else palette.muted, true),
                Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 5, 0, 0, 0),
            )
            pill.setOnClickListener { openDetail(service) }
            strip.addView(pill, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 6, 0))
        }
        card.addView(
            HorizontalScrollView(this).apply {
                isHorizontalScrollBarEnabled = false
                clipToPadding = false
                addView(strip)
            },
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 8, 0, 0),
        )
        return card
    }

    private fun prettyStat(raw: String): String {
        val value = raw.trim()
        if (value.isEmpty()) return value
        return if (value.all { it.isDigit() }) formatCount(value.toLong()) else value
    }

    private fun eventBadge(raw: String): Pair<String, String> {
        val date = try {
            SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(raw.take(10))
        } catch (_: Exception) {
            null
        } ?: return "?" to ""
        return SimpleDateFormat("dd", Locale.getDefault()).format(date) to
            SimpleDateFormat("MMM", Locale.getDefault()).format(date).uppercase(Locale.getDefault())
    }

    private fun isAdmin(): Boolean = prefs.role == "admin"

    private fun runAction(service: Service, action: String, value: Any? = null, confirm: String? = null) {
        val perform = {
            executor.execute {
                try {
                    val result = Api.action(
                        activeBase.ifEmpty { ServerResolver.active(prefs) },
                        secure.token() ?: "",
                        service.id,
                        action,
                        value,
                    )
                    handler.post {
                        if (isFinishing || isDestroyed) return@post
                        Toast.makeText(this, result.message, Toast.LENGTH_SHORT).show()
                        if (result.ok) handler.postDelayed({ load(true) }, 600)
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

    private fun cardShell(title: String, onClick: () -> Unit): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.ripple(
                this@MainActivity, palette.card, 14, palette.line, palette.text,
                if (palette.isDark) 26 else 16,
            )
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
            background = Ui.ripple(
                this@MainActivity, palette.card, 14, palette.line, palette.text,
                if (palette.isDark) 22 else 14,
            )
            setPadding(Ui.dp(this@MainActivity, 10), Ui.dp(this@MainActivity, verticalPadding), Ui.dp(this@MainActivity, 12), Ui.dp(this@MainActivity, verticalPadding))
            isClickable = true
            isFocusable = true
            alpha = if (service.online) 1f else 0.72f
        }
        val icon = Icons.service(
            this,
            palette,
            activeBase.ifEmpty { ServerResolver.active(prefs) },
            service,
            secure.token() ?: "",
            if (prefs.compact) 32 else 38,
        )
        card.addView(
            icon,
            Ui.margins(
                this,
                Ui.lp(Ui.dp(this, if (prefs.compact) 32 else 38), Ui.dp(this, if (prefs.compact) 32 else 38)),
                0, 0, 0, 0,
            ),
        )

        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.setPadding(Ui.dp(this, 11), 0, 0, 0)

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
