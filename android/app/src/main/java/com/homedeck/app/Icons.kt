package com.homedeck.app

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.roundToInt

/**
 * Service and container icons. Uses HomeDeck's bundled `/icons` WebP files (or
 * the Unraid template URL) and falls back to a coloured monogram while loading
 * or when no icon exists. A status dot is drawn in the corner.
 */
object Icons {
    fun service(
        context: Context,
        palette: Palette,
        baseUrl: String,
        service: Service,
        token: String,
        sizeDp: Int = 36,
    ): View {
        val color = colorOf(service.color, palette.accent)
        val status = when {
            !service.online -> palette.bad
            service.stale -> palette.warn
            else -> palette.ok
        }
        return tile(context, palette, baseUrl, service, token, service.iconUrl, service.name, color, sizeDp, status, true)
    }

    fun container(
        context: Context,
        palette: Palette,
        baseUrl: String,
        service: Service,
        container: ContainerItem,
        token: String,
        sizeDp: Int = 30,
        showDot: Boolean = true,
    ): View {
        val status = if (container.state == "running") palette.ok else palette.bad
        val icon = container.icon.ifEmpty { container.iconFallback }
        return tile(
            context, palette, baseUrl, service, token, icon, container.name, palette.faint,
            sizeDp, status, showDot, container.iconFallback,
        )
    }

    private fun tile(
        context: Context,
        palette: Palette,
        baseUrl: String,
        service: Service?,
        token: String,
        icon: String,
        label: String,
        fallbackColor: Int,
        sizeDp: Int,
        statusColor: Int,
        showDot: Boolean,
        fallbackIcon: String = "",
    ): View {
        val frame = FrameLayout(context)
        frame.layoutParams = LinearLayout.LayoutParams(dp(context, sizeDp), dp(context, sizeDp))
        val radius = (sizeDp * 0.28f).roundToInt()

        val letter = TextView(context).apply {
            text = label.trim().take(1).uppercase().ifEmpty { "?" }
            setTextColor(fallbackColor)
            textSize = sizeDp * 0.4f
            gravity = Gravity.CENTER
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
            background = Ui.rounded(
                context,
                Ui.withAlpha(fallbackColor, if (palette.isDark) 34 else 26),
                radius,
                Ui.withAlpha(fallbackColor, 70),
            )
        }
        frame.addView(letter, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))

        val candidates = listOf(icon, fallbackIcon).filter { it.isNotEmpty() }.distinct()
        if (candidates.isNotEmpty()) {
            val image = ImageView(context).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                visibility = View.INVISIBLE
                background = Ui.rounded(context, palette.card2, radius)
                clipToOutline = true
            }
            frame.addView(image, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ))
            var index = 0
            fun tryNext() {
                val candidate = candidates.getOrNull(index++) ?: return
                val url = ImageLoader.iconUrl(baseUrl, service, candidate)
                if (url.isEmpty()) {
                    tryNext()
                    return
                }
                ImageLoader.load(image, url, token, baseUrl) { ok ->
                    if (ok) {
                        image.visibility = View.VISIBLE
                        letter.visibility = View.GONE
                    } else {
                        tryNext()
                    }
                }
            }
            tryNext()
        }

        if (showDot) {
            val dot = View(context).apply {
                background = Ui.circle(context, statusColor, 3, palette.card, 1)
            }
            frame.addView(dot, FrameLayout.LayoutParams(
                dp(context, 9),
                dp(context, 9),
                Gravity.END or Gravity.BOTTOM,
            ))
        }
        return frame
    }

    private fun colorOf(value: String, fallback: Int): Int = try {
        if (value.isBlank()) fallback else Color.parseColor(value)
    } catch (_: Exception) {
        fallback
    }

    private fun dp(context: Context, value: Int): Int =
        (value * context.resources.displayMetrics.density).roundToInt()
}
