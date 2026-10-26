package com.homedeck.app

import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat

class SettingsActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var secure: SecureStore
    private lateinit var palette: Palette

    override fun onCreate(savedInstanceState: Bundle?) {
        prefs = Prefs(this)
        secure = SecureStore(this)
        UiTheme.applyMode(this, prefs)
        super.onCreate(savedInstanceState)
        palette = UiTheme.palette(this, prefs)
        buildUi()
    }

    private fun buildUi() {
        val scroll = ScrollView(this).apply { setBackgroundColor(palette.bg) }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(root, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        setContentView(scroll)
        Ui.edgeToEdge(this, scroll, palette)

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(Ui.iconButton(this, R.drawable.ic_back, palette.muted) { finish() })
        top.addView(Ui.text(this, "Settings", 20f, palette.text, true), Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 6, 0, 0, 0))
        root.addView(top, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val connection = card()
        connection.addView(Ui.label(this, "Connection", palette.faint))
        connection.addView(
            Ui.text(this, "Paired as ${prefs.userName.ifEmpty { "device" }}", 10.5f, palette.muted),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 7, 0, 0),
        )

        var mode = prefs.serverMode
        val localInput = addressField(prefs.serverUrl, "http://192.168.1.10:8080")
        val externalInput = addressField(prefs.externalUrl, "https://deck.example.com")
        connection.addView(Ui.text(this, "Local / primary address", 11.5f, palette.text), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 12, 0, 5))
        connection.addView(localInput, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        connection.addView(Ui.text(this, "External address (optional)", 11.5f, palette.text), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 10, 0, 5))
        connection.addView(externalInput, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        connection.addView(
            Ui.text(this, "Used automatically when the local address is unreachable.", 10f, palette.faint),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 5, 0, 0),
        )

        val modeRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val modeButtons = mutableMapOf<String, TextView>()
        fun paintModes() {
            for ((id, button) in modeButtons) {
                val selected = id == mode
                button.background = Ui.rounded(this, if (selected) palette.accent else palette.card2, 10, palette.line)
                button.setTextColor(if (selected) palette.onAccent else palette.text)
            }
        }
        listOf("auto" to "Auto", "local" to "Local", "external" to "External").forEachIndexed { index, (id, label) ->
            val button = Ui.button(
                this,
                label,
                if (mode == id) palette.accent else palette.card2,
                if (mode == id) palette.onAccent else palette.text,
                false,
            )
            button.setOnClickListener { mode = id; paintModes() }
            modeButtons[id] = button
            modeRow.addView(button, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 0, 0, if (index == 2) 0 else 6, 0))
        }
        paintModes()
        connection.addView(modeRow, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 12, 0, 0))

        val activeStatus = Ui.text(this, "", 10.5f, palette.muted)
        val httpsIcon = Ui.icon(this, R.drawable.ic_lock, palette.ok, 14)
        val httpsText = Ui.text(this, "", 10.5f, palette.ok)

        fun refreshActiveStatus() {
            val active = ServerResolver.active(prefs)
            val host = try { android.net.Uri.parse(active).host ?: active } catch (_: Exception) { active }
            val route = if (ServerResolver.isExternalActive(prefs)) "external" else "primary"
            activeStatus.text = "Active: $host · $route"
            activeStatus.setTextColor(palette.muted)
            val https = active.startsWith("https://")
            httpsIcon.imageTintList = ColorStateList.valueOf(if (https) palette.ok else palette.warn)
            httpsText.text = if (https) "Encrypted with HTTPS" else "HTTP — unencrypted. Use HTTPS outside your LAN."
            httpsText.setTextColor(if (https) palette.ok else palette.warn)
        }

        val addressActions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val saveAddresses = Ui.button(this, "Save addresses", palette.accent, palette.onAccent)
        val recheck = Ui.button(this, "Recheck", palette.card2, palette.accent)
        saveAddresses.setOnClickListener {
            val local = ServerResolver.normalize(localInput.text?.toString().orEmpty())
            val externalRaw = externalInput.text?.toString()?.trim().orEmpty()
            val external = if (externalRaw.isEmpty()) "" else ServerResolver.normalize(externalRaw)
            if (local == null) {
                Toast.makeText(this, "Local address must be a valid http(s) URL", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (externalRaw.isNotEmpty() && external == null) {
                Toast.makeText(this, "External address must be a valid http(s) URL", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (mode == "external" && external.isNullOrEmpty()) {
                Toast.makeText(this, "Add an external address first", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            prefs.serverUrl = local
            prefs.externalUrl = external ?: ""
            prefs.serverMode = mode
            prefs.lastGoodBase = ""
            ServerResolver.reset()
            localInput.setText(local)
            externalInput.setText(external ?: "")
            refreshActiveStatus()
            Toast.makeText(this, "Server addresses saved", Toast.LENGTH_SHORT).show()
        }
        recheck.setOnClickListener {
            val local = ServerResolver.normalize(localInput.text?.toString().orEmpty())
            val externalRaw = externalInput.text?.toString()?.trim().orEmpty()
            val external = if (externalRaw.isEmpty()) "" else ServerResolver.normalize(externalRaw)
            if (local == null) {
                Toast.makeText(this, "Local address must be a valid http(s) URL", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            recheck.isEnabled = false
            activeStatus.text = "Checking…"
            activeStatus.setTextColor(palette.muted)
            Thread {
                val localOk = ServerResolver.probe(local)
                val externalOk = if (external.isNullOrEmpty()) false else ServerResolver.probe(external)
                runOnUiThread {
                    activeStatus.text = buildString {
                        append("Local: ")
                        append(if (localOk) "reachable" else "unreachable")
                        if (!external.isNullOrEmpty()) {
                            append(" · External: ")
                            append(if (externalOk) "reachable" else "unreachable")
                        }
                    }
                    activeStatus.setTextColor(if (localOk || externalOk) palette.muted else palette.bad)
                    recheck.isEnabled = true
                }
            }.start()
        }
        addressActions.addView(saveAddresses, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 0, 12, 4, 0))
        addressActions.addView(recheck, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 4, 12, 0, 0))
        connection.addView(addressActions)
        connection.addView(activeStatus, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 6, 0, 0))

        val securityRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        securityRow.addView(httpsIcon)
        httpsText.setPadding(Ui.dp(this, 6), 0, 0, 0)
        securityRow.addView(httpsText, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        connection.addView(securityRow, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 10, 0, 0))
        refreshActiveStatus()

        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val repair = Ui.button(this, "Re-pair", palette.card2, palette.accent)
        repair.setOnClickListener { startActivity(Intent(this, PairingActivity::class.java)) }
        actions.addView(repair, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 0, 16, 4, 0))
        val disconnect = Ui.button(this, "Disconnect", palette.bad, Color.WHITE)
        disconnect.setOnClickListener { confirmDisconnect() }
        actions.addView(disconnect, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 4, 16, 0, 0))
        connection.addView(actions)
        root.addView(connection, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 20, 0, 12))

        val appearance = card()
        appearance.addView(Ui.label(this, "Appearance", palette.faint))
        appearance.addView(Ui.text(this, "Theme", 13f, palette.text), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 12, 0, 8))
        val themeRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        listOf("system" to "System", "dark" to "Dark", "light" to "Light").forEachIndexed { index, (id, label) ->
            val selected = prefs.theme == id
            val button = Ui.button(
                this,
                label,
                if (selected) palette.accent else palette.card2,
                if (selected) palette.onAccent else palette.text,
                false,
            )
            button.setOnClickListener {
                prefs.theme = id
                UiTheme.applyMode(this, prefs)
                recreate()
            }
            themeRow.addView(button, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 0, 0, if (index == 2) 0 else 6, 0))
        }
        appearance.addView(themeRow)

        appearance.addView(Ui.text(this, "Accent", 13f, palette.text), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 16, 0, 8))
        val accentRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for (hex in UiTheme.accents) {
            val color = UiTheme.parseColor(hex, "#c9963f")
            val selected = prefs.accent.equals(hex, ignoreCase = true)
            val swatch = Ui.text(this, if (selected) "✓" else "", 14f, UiTheme.onColor(color), true).apply {
                gravity = Gravity.CENTER
                background = Ui.circle(this@SettingsActivity, color, 18, if (selected) palette.text else null, 2)
            }
            swatch.setOnClickListener {
                prefs.accent = hex
                recreate()
            }
            accentRow.addView(swatch, Ui.margins(this, Ui.lp(Ui.dp(this, 36), Ui.dp(this, 36)), 0, 0, 10, 0))
        }
        appearance.addView(accentRow)

        appearance.addView(dividerLine(), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 1)), 0, 14, 0, 4))
        appearance.addView(switchRow("Compact cards", prefs.compact) { prefs.compact = it })
        appearance.addView(switchRow("Group by category", prefs.groupByCategory) { prefs.groupByCategory = it })
        appearance.addView(switchRow("Show offline services", prefs.showOffline) { prefs.showOffline = it })
        root.addView(appearance, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 12))

        val refresh = card()
        refresh.addView(Ui.label(this, "Refresh", palette.faint))
        refresh.addView(Ui.text(this, "Auto-refresh interval", 13f, palette.text), Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 10, 0, 8))
        val intervalRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        listOf(15, 30, 60).forEachIndexed { index, seconds ->
            val selected = prefs.refreshSeconds == seconds
            val button = Ui.button(
                this,
                "$seconds s",
                if (selected) palette.accent else palette.card2,
                if (selected) palette.onAccent else palette.text,
                false,
            )
            button.setOnClickListener {
                prefs.refreshSeconds = seconds
                recreate()
            }
            intervalRow.addView(button, Ui.margins(this, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f), 0, 0, if (index == 2) 0 else 6, 0))
        }
        refresh.addView(intervalRow)
        root.addView(refresh, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 0, 0, 12))

        val about = card()
        about.addView(Ui.label(this, "About", palette.faint))
        val version = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
        } catch (_: Exception) {
            "1.0.0"
        }
        about.addView(
            Ui.text(this, "HomeDeck for Android v$version", 13f, palette.text, true),
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 10, 0, 0),
        )
        about.addView(
            Ui.text(this, "The device token is stored encrypted with the Android Keystore and can be revoked from the web UI at any time.", 11f, palette.muted).apply {
                setLineSpacing(Ui.dp(this@SettingsActivity, 2).toFloat(), 1f)
            },
            Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 6, 0, 0),
        )
        root.addView(about)

        root.addView(Ui.spacer(this, 18))
    }

    private fun card(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@SettingsActivity, palette.card, 16, palette.line)
            setPadding(Ui.dp(this@SettingsActivity, 16), Ui.dp(this@SettingsActivity, 14), Ui.dp(this@SettingsActivity, 16), Ui.dp(this@SettingsActivity, 16))
        }

    private fun addressField(value: String, hintText: String): EditText =
        EditText(this).apply {
            setText(value)
            hint = hintText
            setTextColor(palette.text)
            setHintTextColor(palette.faint)
            setTextSize(12.5f)
            typeface = Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            background = Ui.rounded(this@SettingsActivity, palette.card2, 10, palette.line)
            setPadding(
                Ui.dp(this@SettingsActivity, 11),
                Ui.dp(this@SettingsActivity, 9),
                Ui.dp(this@SettingsActivity, 11),
                Ui.dp(this@SettingsActivity, 9),
            )
        }

    private fun dividerLine(): View =
        View(this).apply { setBackgroundColor(palette.line) }

    private fun switchRow(title: String, checked: Boolean, onChange: (Boolean) -> Unit): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, Ui.dp(this@SettingsActivity, 7), 0, Ui.dp(this@SettingsActivity, 7))
        }
        row.addView(Ui.text(this, title, 13f, palette.text), Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val switch = SwitchCompat(this).apply {
            isChecked = checked
            thumbTintList = ColorStateList.valueOf(palette.accent)
            trackTintList = ColorStateList.valueOf(Ui.withAlpha(palette.accent, 110))
        }
        switch.setOnCheckedChangeListener { _, value -> onChange(value) }
        row.addView(switch)
        return row
    }

    private fun confirmDisconnect() {
        AlertDialog.Builder(this)
            .setTitle("Disconnect this phone?")
            .setMessage("The app token will be revoked on the server. You will need the web UI to generate a new QR code.")
            .setPositiveButton("Disconnect") { _, _ -> disconnect() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun disconnect() {
        val token = secure.token()
        val server = ServerResolver.active(prefs).ifEmpty { prefs.serverUrl }
        secure.clear()
        prefs.serverUrl = ""
        prefs.externalUrl = ""
        prefs.userName = ""
        prefs.role = ""
        prefs.lastGoodBase = ""
        ServerResolver.reset()
        if (!token.isNullOrEmpty() && server.isNotEmpty()) {
            Thread {
                try { Api.revokeCurrent(server, token) } catch (_: Exception) { }
            }.start()
        }
        startActivity(
            Intent(this, PairingActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        finish()
    }
}
