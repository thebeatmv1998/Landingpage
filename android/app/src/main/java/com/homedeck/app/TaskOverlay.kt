package com.homedeck.app

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import java.util.Locale

/**
 * Non-blocking task card for long-running actions (container updates). Shows an
 * indeterminate spinner plus elapsed time, then a clear success/failure state.
 * Docker/Unraid do not expose pull percentages, so no fake progress is shown.
 * The rest of the app stays usable while the action runs.
 */
class TaskOverlay private constructor(
    private val activity: Activity,
    private val palette: Palette,
    title: String,
    detail: String,
    private val doneTitle: String,
    private val failTitle: String,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val titleView: TextView
    private val detailView: TextView
    private val elapsedView: TextView
    private val progressBar: ProgressBar
    private val ring: ProgressBar
    private val stateIcon: ImageView
    private val root: FrameLayout
    private val startedAt = System.currentTimeMillis()
    private var ticker: Runnable? = null
    private var finished = false
    private var attached = false

    init {
        val context = activity

        val card = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = Ui.rounded(context, palette.card2, 18, palette.line)
            setPadding(Ui.dp(context, 18), Ui.dp(context, 15), Ui.dp(context, 20), Ui.dp(context, 15))
            isClickable = true
            elevation = Ui.dp(context, 12).toFloat()
        }

        ring = ProgressBar(context).apply {
            indeterminateTintList = ColorStateList.valueOf(palette.accent)
        }
        stateIcon = ImageView(context).apply {
            visibility = View.GONE
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        val iconBox = FrameLayout(context)
        iconBox.addView(
            ring,
            FrameLayout.LayoutParams(Ui.dp(context, 32), Ui.dp(context, 32), Gravity.CENTER),
        )
        iconBox.addView(
            stateIcon,
            FrameLayout.LayoutParams(Ui.dp(context, 28), Ui.dp(context, 28), Gravity.CENTER),
        )
        card.addView(iconBox, LinearLayout.LayoutParams(Ui.dp(context, 38), Ui.dp(context, 38)))

        val text = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        titleView = Ui.text(context, title, 15f, palette.text, true)
        detailView = Ui.text(context, detail, 11f, palette.muted).apply { maxLines = 4 }
        elapsedView = Ui.text(context, "0:00", 10f, palette.faint)
        progressBar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(palette.accent)
            progressBackgroundTintList = ColorStateList.valueOf(palette.line)
        }
        text.addView(titleView)
        text.addView(detailView, Ui.margins(context, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ), 0, 3, 0, 0))
        text.addView(progressBar, Ui.margins(context, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            Ui.dp(context, 4),
        ), 0, 7, 0, 0))
        text.addView(elapsedView, Ui.margins(context, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ), 0, 5, 0, 0))
        card.addView(text, Ui.margins(context, LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f,
        ), 14, 0, 0, 0))

        root = FrameLayout(context).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setPadding(Ui.dp(context, 16), Ui.dp(context, 16), Ui.dp(context, 16), Ui.dp(context, 16))
            isClickable = false
            isFocusable = false
        }
        root.addView(card, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        ))
    }

    fun show() {
        if (activity.isFinishing || activity.isDestroyed) return
        val decor = activity.window?.decorView as? ViewGroup ?: return
        decor.addView(root)
        root.bringToFront()
        attached = true
        startTicker()
    }

    fun done(message: String) = finish(true, message)

    fun fail(message: String) = finish(false, message)

    private fun finish(ok: Boolean, message: String) {
        if (finished) return
        finished = true
        ticker?.let { handler.removeCallbacks(it) }
        ring.visibility = View.GONE
        progressBar.isIndeterminate = false
        progressBar.progress = 100
        progressBar.progressTintList = ColorStateList.valueOf(if (ok) palette.ok else palette.bad)
        stateIcon.visibility = View.VISIBLE
        stateIcon.setImageResource(if (ok) R.drawable.ic_check else R.drawable.ic_close)
        stateIcon.imageTintList = ColorStateList.valueOf(if (ok) palette.ok else palette.bad)
        stateIcon.scaleX = 0.4f
        stateIcon.scaleY = 0.4f
        stateIcon.animate().scaleX(1f).scaleY(1f).setDuration(220).start()
        titleView.text = if (ok) doneTitle else failTitle
        detailView.text = message.ifBlank {
            if (ok) "The container is ready." else "The server returned an error."
        }
        paintElapsed()
        haptic(if (ok) android.view.HapticFeedbackConstants.CONFIRM else android.view.HapticFeedbackConstants.REJECT)
        handler.postDelayed({ dismiss() }, if (ok) 2200L else 6000L)
    }

    private fun haptic(kind: Int) {
        try {
            val view = activity.window?.decorView ?: return
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                view.performHapticFeedback(kind)
            } else {
                view.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
            }
        } catch (_: Exception) {
            // haptics are optional
        }
    }

    private fun startTicker() {
        paintElapsed()
        ticker = object : Runnable {
            override fun run() {
                if (finished || !attached) return
                paintElapsed()
                handler.postDelayed(this, 500)
            }
        }.also { handler.post(it) }
    }

    private fun paintElapsed() {
        val seconds = ((System.currentTimeMillis() - startedAt) / 1000).toInt().coerceAtLeast(0)
        elapsedView.text = String.format(Locale.US, "%d:%02d", seconds / 60, seconds % 60)
    }

    fun dismiss() {
        handler.removeCallbacksAndMessages(null)
        if (attached) {
            (root.parent as? ViewGroup)?.removeView(root)
            attached = false
        }
    }

    companion object {
        fun show(
            activity: Activity,
            palette: Palette,
            title: String,
            detail: String,
            doneTitle: String = "Done",
            failTitle: String = "Failed",
        ): TaskOverlay = TaskOverlay(activity, palette, title, detail, doneTitle, failTitle).also { it.show() }
    }
}
