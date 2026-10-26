package com.homedeck.app

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

object Ui {
    fun dp(context: Context, value: Int): Int =
        (value * context.resources.displayMetrics.density).toInt()

    fun text(context: Context, value: String, sizeSp: Float, color: Int, bold: Boolean = false): TextView =
        TextView(context).apply {
            text = value
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            typeface = Typeface.create("sans-serif", if (bold) Typeface.BOLD else Typeface.NORMAL)
            includeFontPadding = false
        }

    fun label(context: Context, value: String, color: Int): TextView =
        text(context, value.uppercase(), 10.5f, color, true).apply {
            letterSpacing = 0.12f
        }

    fun icon(context: Context, @DrawableRes resource: Int, tint: Int, sizeDp: Int = 24): ImageView =
        ImageView(context).apply {
            setImageResource(resource)
            imageTintList = ColorStateList.valueOf(tint)
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = LinearLayout.LayoutParams(dp(context, sizeDp), dp(context, sizeDp))
        }

    fun iconButton(context: Context, @DrawableRes resource: Int, tint: Int, onClick: () -> Unit): FrameLayout {
        val frame = FrameLayout(context)
        frame.background = RippleDrawable(
            ColorStateList.valueOf(withAlpha(tint, 38)),
            rounded(context, Color.TRANSPARENT, 20),
            null,
        )
        frame.addView(icon(context, resource, tint, 22), FrameLayout.LayoutParams(dp(context, 22), dp(context, 22), Gravity.CENTER))
        frame.layoutParams = LinearLayout.LayoutParams(dp(context, 40), dp(context, 40))
        frame.isClickable = true
        frame.isFocusable = true
        frame.setOnClickListener { onClick() }
        return frame
    }

    fun button(context: Context, value: String, background: Int, foreground: Int, bold: Boolean = true): TextView {
        val button = text(context, value, 14f, foreground, bold)
        button.gravity = Gravity.CENTER
        button.setPadding(dp(context, 14), dp(context, 10), dp(context, 14), dp(context, 10))
        button.background = RippleDrawable(
            ColorStateList.valueOf(withAlpha(foreground, 40)),
            rounded(context, background, 12),
            null,
        )
        button.isClickable = true
        button.isFocusable = true
        return button
    }

    fun rounded(context: Context, color: Int, radiusDp: Int, strokeColor: Int? = null, strokeWidthDp: Int = 1): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(color)
            cornerRadius = dp(context, radiusDp).toFloat()
            if (strokeColor != null) setStroke(dp(context, strokeWidthDp), strokeColor)
        }

    fun circle(context: Context, color: Int, radiusDp: Int, strokeColor: Int? = null, strokeWidthDp: Int = 1): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
            setSize(dp(context, radiusDp * 2), dp(context, radiusDp * 2))
            if (strokeColor != null) setStroke(dp(context, strokeWidthDp), strokeColor)
        }

    /** Rounded card background with a ripple so every card feels tappable. */
    fun ripple(
        context: Context,
        fill: Int,
        radiusDp: Int,
        strokeColor: Int? = null,
        rippleColor: Int = Color.WHITE,
        rippleAlpha: Int = 28,
    ): RippleDrawable = RippleDrawable(
        ColorStateList.valueOf(withAlpha(rippleColor, rippleAlpha)),
        rounded(context, fill, radiusDp, strokeColor),
        null,
    )

    /** Small pill used to toggle chart series on/off. */
    fun toggleChip(
        context: Context,
        palette: Palette,
        label: String,
        color: Int,
        active: Boolean,
        onChange: (Boolean) -> Unit,
    ): LinearLayout {
        var on = active
        val chip = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(context, 9), dp(context, 5), dp(context, 10), dp(context, 5))
            isClickable = true
            isFocusable = true
        }
        val dot = View(context).apply { background = circle(context, color, 3) }
        val text = text(context, label, 10.5f, palette.text, true)
        chip.addView(dot, LinearLayout.LayoutParams(dp(context, 6), dp(context, 6)))
        chip.addView(text, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { leftMargin = dp(context, 5) })
        fun paint() {
            chip.background = ripple(
                context,
                if (on) withAlpha(color, 34) else palette.card2,
                20,
                palette.line,
                palette.text,
                if (palette.isDark) 30 else 18,
            )
            text.setTextColor(if (on) palette.text else palette.muted)
            chip.alpha = if (on) 1f else 0.72f
        }
        paint()
        chip.setOnClickListener {
            on = !on
            paint()
            onChange(on)
        }
        return chip
    }

    fun spacer(context: Context, heightDp: Int): View =
        View(context).apply { layoutParams = LinearLayout.LayoutParams(1, dp(context, heightDp)) }

    fun divider(context: Context, color: Int): View =
        View(context).apply {
            setBackgroundColor(color)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(context, 1))
        }

    fun lp(width: Int, height: Int, weight: Float = 0f): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(width, height, weight)

    fun margins(context: Context, params: LinearLayout.LayoutParams, left: Int = 0, top: Int = 0, right: Int = 0, bottom: Int = 0): LinearLayout.LayoutParams {
        params.setMargins(dp(context, left), dp(context, top), dp(context, right), dp(context, bottom))
        return params
    }

    fun edgeToEdge(activity: Activity, root: View, palette: Palette, basePaddingDp: Int = 16) {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        activity.window.statusBarColor = Color.TRANSPARENT
        activity.window.navigationBarColor = Color.TRANSPARENT
        val controller = WindowInsetsControllerCompat(activity.window, activity.window.decorView)
        controller.isAppearanceLightStatusBars = !palette.isDark
        controller.isAppearanceLightNavigationBars = !palette.isDark
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(
                dp(activity, basePaddingDp),
                dp(activity, basePaddingDp) + bars.top,
                dp(activity, basePaddingDp),
                dp(activity, basePaddingDp) + bars.bottom,
            )
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }

    fun withAlpha(color: Int, alpha: Int): Int =
        Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
}
