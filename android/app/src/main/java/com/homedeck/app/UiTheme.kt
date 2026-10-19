package com.homedeck.app

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import androidx.appcompat.app.AppCompatDelegate

data class Palette(
    val bg: Int,
    val card: Int,
    val card2: Int,
    val line: Int,
    val text: Int,
    val muted: Int,
    val faint: Int,
    val accent: Int,
    val onAccent: Int,
    val ok: Int,
    val warn: Int,
    val bad: Int,
    val isDark: Boolean,
)

object UiTheme {
    val accents = listOf("#c9963f", "#3f8fd6", "#3fa76f", "#8b6fd6", "#d65f5f", "#3fb8b0")

    fun applyMode(context: Context, prefs: Prefs) {
        AppCompatDelegate.setDefaultNightMode(
            when (prefs.theme) {
                "light" -> AppCompatDelegate.MODE_NIGHT_NO
                "dark" -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            },
        )
    }

    fun palette(context: Context, prefs: Prefs): Palette {
        val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val accent = parseColor(prefs.accent, if (night) "#c9963f" else "#b57a22")
        val onAccent = onColor(accent)
        return if (night) {
            Palette(
                bg = Color.parseColor("#0e1113"),
                card = Color.parseColor("#171b1e"),
                card2 = Color.parseColor("#1e2427"),
                line = Color.parseColor("#2a3236"),
                text = Color.parseColor("#e8ecec"),
                muted = Color.parseColor("#9aa6ab"),
                faint = Color.parseColor("#6f7a7e"),
                accent = accent,
                onAccent = onAccent,
                ok = Color.parseColor("#4cc38a"),
                warn = Color.parseColor("#e0a83c"),
                bad = Color.parseColor("#e06060"),
                isDark = true,
            )
        } else {
            Palette(
                bg = Color.parseColor("#f4f2ec"),
                card = Color.parseColor("#ffffff"),
                card2 = Color.parseColor("#f0eee7"),
                line = Color.parseColor("#dcd8cd"),
                text = Color.parseColor("#1c2224"),
                muted = Color.parseColor("#667174"),
                faint = Color.parseColor("#8a9497"),
                accent = accent,
                onAccent = onAccent,
                ok = Color.parseColor("#1f9d66"),
                warn = Color.parseColor("#b7791f"),
                bad = Color.parseColor("#c0392b"),
                isDark = false,
            )
        }
    }

    fun parseColor(value: String, fallback: String): Int = try {
        Color.parseColor(value)
    } catch (_: Exception) {
        Color.parseColor(fallback)
    }

    fun onColor(color: Int): Int =
        if (luminance(color) > 0.55) Color.parseColor("#191b1c") else Color.WHITE

    private fun luminance(color: Int): Double {
        fun channel(value: Int): Double {
            val s = value / 255.0
            return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(Color.red(color)) + 0.7152 * channel(Color.green(color)) + 0.0722 * channel(Color.blue(color))
    }
}
