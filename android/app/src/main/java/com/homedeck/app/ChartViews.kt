package com.homedeck.app

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private fun View.dp(value: Float): Float = value * resources.displayMetrics.density

/**
 * Interactive 24h Pi-hole chart: queries (filled) + blocked (line).
 * Drag horizontally to inspect a point: crosshair, exact time, query/blocked
 * counts and block rate. The first data set animates in; each series can be
 * toggled off by the caller. Haptic ticks while scrubbing.
 */
class AreaChartView(context: Context) : View(context) {
    private val queriesPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(2f)
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val blockedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1.7f)
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
    }
    private val crossPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = dp(9f)
    }
    private val bubblePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val bubbleStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
    }
    private val bubbleTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = dp(9.5f)
        typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
    }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var dragging = false
    private var selectedIndex = -1
    private var reveal = 1f
    private var animator: ValueAnimator? = null
    private val clearSelection = Runnable {
        selectedIndex = -1
        invalidate()
    }

    var points: List<ChartPoint> = emptyList()
        set(value) {
            val first = field.isEmpty()
            field = value
            selectedIndex = -1
            removeCallbacks(clearSelection)
            animator?.cancel()
            if (animate && first && value.size >= 2) startReveal() else reveal = 1f
            invalidate()
        }

    /** Animate only the first fill (dashboard re-renders on every poll). */
    var animate: Boolean = true

    var showQueries = true
        set(value) { field = value; invalidate() }
    var showBlocked = true
        set(value) { field = value; invalidate() }

    var accent: Int = Color.parseColor("#c9963f")
    var blockedColor: Int = Color.parseColor("#e06060")
    var gridColor: Int = Color.parseColor("#2a3236")
    var textColor: Int = Color.parseColor("#9aa6ab")
    var bubbleColor: Int = Color.parseColor("#1e2427")
    var bubbleTextColor: Int = Color.parseColor("#e8ecec")

    init {
        isClickable = true
        isFocusable = true
        contentDescription = "Pi-hole 24 hour query graph. Drag to inspect values."
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        removeCallbacks(clearSelection)
        super.onDetachedFromWindow()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (points.size < 2) return super.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                dragging = false
                removeCallbacks(clearSelection)
                selectAt(event.x)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging) {
                    val dx = abs(event.x - downX)
                    val dy = abs(event.y - downY)
                    if (dx > touchSlop && dx > dy) {
                        dragging = true
                        parent?.requestDisallowInterceptTouchEvent(true)
                    }
                }
                if (dragging) selectAt(event.x)
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (!dragging) {
                    performClick()
                    selectAt(event.x)
                }
                parent?.requestDisallowInterceptTouchEvent(false)
                postDelayed(clearSelection, 2600)
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun selectAt(x: Float) {
        val n = points.size
        if (n < 2) return
        val pad = dp(4f)
        val chartW = max(1f, width - pad * 2)
        val fraction = ((x - pad) / chartW).coerceIn(0f, 1f)
        val index = (fraction * (n - 1)).roundToInt().coerceIn(0, n - 1)
        if (index == selectedIndex) return
        selectedIndex = index
        val point = points[index]
        performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        contentDescription = "Pi-hole graph, ${timeLabel(point.t)}: " +
            "${formatCount(point.queries)} queries, ${formatCount(point.blocked)} blocked"
        invalidate()
    }

    private fun startReveal() {
        reveal = 0f
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 620L
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                reveal = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return
        val pad = dp(4f)
        val labelH = dp(14f)
        val top = pad
        val chartH = max(1f, h - pad - labelH - top)
        val bottom = top + chartH
        val chartW = max(1f, w - pad * 2)

        queriesPaint.color = accent
        blockedPaint.color = blockedColor
        gridPaint.color = gridColor
        labelPaint.color = textColor

        for (i in 0..2) {
            val y = top + chartH * i / 2f
            canvas.drawLine(pad, y, w - pad, y, gridPaint)
        }

        if (points.size < 2) {
            labelPaint.textAlign = Paint.Align.CENTER
            canvas.drawText("No history yet", w / 2f, top + chartH / 2f, labelPaint)
            labelPaint.textAlign = Paint.Align.LEFT
            return
        }

        val n = points.size
        val maxValue = max(
            1,
            points.maxOfOrNull {
                max(if (showQueries) it.queries else 0, if (showBlocked) it.blocked else 0)
            } ?: 1,
        )
        val xs = FloatArray(n) { pad + chartW * it / (n - 1f) }
        val qYs = FloatArray(n) { top + chartH - (points[it].queries.toFloat() / maxValue) * chartH }
        val bYs = FloatArray(n) { top + chartH - (points[it].blocked.toFloat() / maxValue) * chartH }

        canvas.save()
        canvas.clipRect(0f, 0f, pad + chartW * reveal + dp(6f), h)

        if (showQueries) {
            val line = smoothPath(xs, qYs)
            val area = Path(line)
            area.lineTo(xs[n - 1], bottom)
            area.lineTo(xs[0], bottom)
            area.close()
            fillPaint.shader = LinearGradient(
                0f, top, 0f, bottom,
                intArrayOf(Ui.withAlpha(accent, 95), Ui.withAlpha(accent, 0)),
                null,
                Shader.TileMode.CLAMP,
            )
            canvas.drawPath(area, fillPaint)
            canvas.drawPath(line, queriesPaint)
        }
        if (showBlocked) {
            canvas.drawPath(smoothPath(xs, bYs), blockedPaint)
        }
        canvas.restore()

        if (selectedIndex in 0 until n) {
            val point = points[selectedIndex]
            val x = xs[selectedIndex]
            crossPaint.color = Ui.withAlpha(textColor, 120)
            crossPaint.pathEffect = DashPathEffect(floatArrayOf(dp(3f), dp(3f)), 0f)
            canvas.drawLine(x, top, x, bottom, crossPaint)
            crossPaint.pathEffect = null
            if (showQueries) drawDot(canvas, x, qYs[selectedIndex], accent)
            if (showBlocked) drawDot(canvas, x, bYs[selectedIndex], blockedColor)
            val anchor = when {
                showQueries -> qYs[selectedIndex]
                showBlocked -> bYs[selectedIndex]
                else -> top + chartH / 2f
            }
            drawBubble(canvas, point, x, anchor, w, h)
        }

        labelPaint.textAlign = Paint.Align.LEFT
        canvas.drawText(timeLabel(points.first().t), pad, h - dp(2f), labelPaint)
        labelPaint.textAlign = Paint.Align.RIGHT
        canvas.drawText(timeLabel(points.last().t), w - pad, h - dp(2f), labelPaint)
        labelPaint.textAlign = Paint.Align.LEFT
    }

    private fun smoothPath(xs: FloatArray, ys: FloatArray): Path {
        val path = Path()
        path.moveTo(xs[0], ys[0])
        for (i in 1 until xs.size) {
            val midX = (xs[i - 1] + xs[i]) / 2f
            path.cubicTo(midX, ys[i - 1], midX, ys[i], xs[i], ys[i])
        }
        return path
    }

    private fun drawDot(canvas: Canvas, x: Float, y: Float, color: Int) {
        ringPaint.color = Ui.withAlpha(color, 55)
        canvas.drawCircle(x, y, dp(6.5f), ringPaint)
        dotPaint.color = color
        canvas.drawCircle(x, y, dp(2.9f), dotPaint)
    }

    private fun drawBubble(canvas: Canvas, point: ChartPoint, x: Float, anchorY: Float, w: Float, h: Float) {
        val rate = if (point.queries > 0) point.blocked * 100f / point.queries else 0f
        val lines = ArrayList<String>(4)
        val time = timeLabel(point.t)
        if (time.isNotEmpty()) lines.add(time)
        if (showQueries) lines.add("${formatCount(point.queries)} queries")
        if (showBlocked) lines.add("${formatCount(point.blocked)} blocked")
        lines.add(String.format(Locale.US, "%.1f%% blocked", rate))
        if (lines.isEmpty()) return

        val lineH = dp(12f)
        val padX = dp(8f)
        val padY = dp(6f)
        bubbleTextPaint.textSize = dp(9.5f)
        val textW = lines.maxOf { bubbleTextPaint.measureText(it) }
        val bubbleW = min(w - dp(4f), textW + padX * 2)
        val bubbleH = lines.size * lineH + padY * 2

        var bx = x + dp(12f)
        if (bx + bubbleW > w - dp(2f)) bx = x - bubbleW - dp(12f)
        bx = bx.coerceIn(dp(2f), max(dp(2f), w - bubbleW - dp(2f)))
        var by = anchorY - bubbleH - dp(8f)
        if (by < dp(2f)) by = (anchorY + dp(10f)).coerceAtMost(max(dp(2f), h - bubbleH - dp(2f)))

        val rect = RectF(bx, by, bx + bubbleW, by + bubbleH)
        bubblePaint.color = bubbleColor
        bubblePaint.alpha = 250
        bubbleStroke.color = Ui.withAlpha(bubbleTextColor, 45)
        val radius = dp(7f)
        canvas.drawRoundRect(rect, radius, radius, bubblePaint)
        canvas.drawRoundRect(rect, radius, radius, bubbleStroke)

        bubbleTextPaint.color = bubbleTextColor
        var ty = by + padY + dp(9.5f)
        for (line in lines) {
            canvas.drawText(line, bx + padX, ty, bubbleTextPaint)
            ty += lineH
        }
    }

    private fun timeLabel(seconds: Long): String {
        if (seconds <= 0) return ""
        val ms = if (seconds > 10_000_000_000L) seconds else seconds * 1000
        return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
    }
}

/** Small single-series sparkline (e.g. download speed samples). */
class SparklineView(context: Context) : View(context) {
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(2f)
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
    }

    var values: List<Float> = emptyList()
        set(value) { field = value; invalidate() }
    var accent: Int = Color.parseColor("#c9963f")
    var gridColor: Int = Color.parseColor("#2a3236")

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return
        val pad = dp(3f)
        val chartW = max(1f, w - pad * 2)
        val chartH = max(1f, h - pad * 2)
        gridPaint.color = gridColor
        canvas.drawLine(pad, pad + chartH, w - pad, pad + chartH, gridPaint)
        if (values.size < 2) return
        linePaint.color = accent
        val maxValue = max(1f, values.maxOrNull() ?: 0f)
        val path = Path()
        for ((i, value) in values.withIndex()) {
            val x = pad + chartW * i / (values.size - 1f)
            val y = pad + chartH - (value / maxValue) * chartH
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        val fillPath = Path(path)
        fillPath.lineTo(w - pad, pad + chartH)
        fillPath.lineTo(pad, pad + chartH)
        fillPath.close()
        fillPaint.shader = LinearGradient(
            0f, pad, 0f, pad + chartH,
            intArrayOf(Ui.withAlpha(accent, 80), Ui.withAlpha(accent, 0)),
            null,
            Shader.TileMode.CLAMP,
        )
        canvas.drawPath(fillPath, fillPaint)
        canvas.drawPath(path, linePaint)
    }
}

/** Ring chart with a centred label, used for Docker / storage. */
class DonutView(context: Context) : View(context) {
    data class Segment(val value: Float, val color: Int)

    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.BUTT
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.BOLD)
    }
    private val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
    }

    var segments: List<Segment> = emptyList()
        set(value) { field = value; invalidate() }
    var label: String = ""
        set(value) { field = value; invalidate() }
    var sub: String = ""
        set(value) { field = value; invalidate() }
    var trackColor: Int = Color.parseColor("#2a3236")
    var textColor: Int = Color.WHITE
    var mutedColor: Int = Color.parseColor("#9aa6ab")

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val size = min(width, height).toFloat()
        if (size <= 0) return
        val stroke = size * 0.13f
        val pad = stroke / 2f + dp(1f)
        val rect = RectF(pad, pad, size - pad, size - pad)
        arcPaint.strokeWidth = stroke
        arcPaint.color = trackColor
        canvas.drawArc(rect, 0f, 360f, false, arcPaint)
        val total = segments.sumOf { it.value.toDouble() }.toFloat()
        if (total > 0.001f) {
            var start = -90f
            for (segment in segments) {
                if (segment.value <= 0f) continue
                val sweep = segment.value / total * 360f
                arcPaint.color = segment.color
                canvas.drawArc(rect, start, sweep, false, arcPaint)
                start += sweep
            }
        }
        labelPaint.color = textColor
        labelPaint.textSize = size * 0.20f
        subPaint.color = mutedColor
        subPaint.textSize = size * 0.105f
        val cx = size / 2f
        val cy = size / 2f
        canvas.drawText(label, cx, cy + size * 0.02f, labelPaint)
        canvas.drawText(sub, cx, cy + size * 0.16f, subPaint)
    }
}

fun formatCount(value: Number): String = java.text.NumberFormat.getIntegerInstance().format(value)

fun formatGB(gb: Double): String = when {
    gb >= 1000 -> String.format(java.util.Locale.US, "%.1f TB", gb / 1000.0)
    gb >= 100 -> "${Math.round(gb)} GB"
    else -> String.format(java.util.Locale.US, "%.1f GB", gb)
}

fun formatSpeed(bps: Long): String = when {
    bps >= 1_000_000_000 -> String.format(java.util.Locale.US, "%.2f GB/s", bps / 1_000_000_000.0)
    bps >= 1_000_000 -> String.format(java.util.Locale.US, "%.1f MB/s", bps / 1_000_000.0)
    bps >= 1_000 -> String.format(java.util.Locale.US, "%.0f kB/s", bps / 1_000.0)
    else -> "$bps B/s"
}

fun formatDuration(seconds: Int): String {
    val total = seconds.coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}" else "$m:${s.toString().padStart(2, '0')}"
}
