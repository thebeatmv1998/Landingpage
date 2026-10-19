package com.homedeck.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.view.View
import kotlin.math.max
import kotlin.math.min

private fun View.dp(value: Float): Float = value * resources.displayMetrics.density

/** 24h Pi-hole queries (filled) + blocked (line) chart. */
class AreaChartView(context: Context) : View(context) {
    private val queriesPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(2f)
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val blockedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1.6f)
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = dp(9f)
    }

    var points: List<ChartPoint> = emptyList()
        set(value) { field = value; invalidate() }

    var accent: Int = Color.parseColor("#c9963f")
    var blockedColor: Int = Color.parseColor("#e06060")
    var gridColor: Int = Color.parseColor("#2a3236")
    var textColor: Int = Color.parseColor("#9aa6ab")

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return
        val pad = dp(3f)
        val labelH = dp(12f)
        val chartH = max(1f, h - pad * 2 - labelH)
        val chartW = max(1f, w - pad * 2)

        queriesPaint.color = accent
        blockedPaint.color = blockedColor
        gridPaint.color = gridColor
        labelPaint.color = textColor

        val maxValue = max(1, points.maxOfOrNull { max(it.queries, it.blocked) } ?: 1)
        for (i in 0..2) {
            val y = pad + chartH * i / 2f
            canvas.drawLine(pad, y, w - pad, y, gridPaint)
        }

        if (points.size >= 2) {
            val n = points.size
            val queryPath = Path()
            val blockedPath = Path()
            for ((i, point) in points.withIndex()) {
                val x = pad + chartW * i / (n - 1f)
                val qy = pad + chartH - (point.queries.toFloat() / maxValue) * chartH
                val by = pad + chartH - (point.blocked.toFloat() / maxValue) * chartH
                if (i == 0) {
                    queryPath.moveTo(x, qy)
                    blockedPath.moveTo(x, by)
                } else {
                    queryPath.lineTo(x, qy)
                    blockedPath.lineTo(x, by)
                }
            }
            val fillPath = Path(queryPath)
            fillPath.lineTo(w - pad, pad + chartH)
            fillPath.lineTo(pad, pad + chartH)
            fillPath.close()
            fillPaint.shader = LinearGradient(
                0f, pad, 0f, pad + chartH,
                intArrayOf(Ui.withAlpha(accent, 90), Ui.withAlpha(accent, 0)),
                null,
                Shader.TileMode.CLAMP,
            )
            canvas.drawPath(fillPath, fillPaint)
            canvas.drawPath(queryPath, queriesPaint)
            canvas.drawPath(blockedPath, blockedPaint)
        } else {
            labelPaint.textAlign = Paint.Align.CENTER
            canvas.drawText("No history yet", w / 2f, pad + chartH / 2f, labelPaint)
        }

        labelPaint.textAlign = Paint.Align.LEFT
        canvas.drawText(formatCount(maxValue), pad, h - dp(1f), labelPaint)
        labelPaint.textAlign = Paint.Align.RIGHT
        canvas.drawText("24h", w - pad, h - dp(1f), labelPaint)
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
