package com.homedeck.app

import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.util.concurrent.Executors

class PairingActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var secure: SecureStore
    private lateinit var palette: Palette
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var linkInput: EditText
    private lateinit var status: TextView
    private lateinit var scanButton: TextView
    private lateinit var pairButton: TextView

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { payload ->
            linkInput.setText(payload)
            pair()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        prefs = Prefs(this)
        secure = SecureStore(this)
        UiTheme.applyMode(this, prefs)
        super.onCreate(savedInstanceState)
        palette = UiTheme.palette(this, prefs)
        buildUi()

        intent?.data?.let { data ->
            linkInput.setText(data.toString())
        }
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun buildUi() {
        val scroll = ScrollView(this).apply { setBackgroundColor(palette.bg) }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Ui.dp(this@PairingActivity, 4), Ui.dp(this@PairingActivity, 4), Ui.dp(this@PairingActivity, 4), Ui.dp(this@PairingActivity, 24))
        }
        scroll.addView(root, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        setContentView(scroll)
        Ui.edgeToEdge(this, scroll, palette)

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(Ui.iconButton(this, R.drawable.ic_back, palette.muted) { finish() })
        top.addView(Ui.spacer(this, 1), Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(top, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val logo = Ui.text(this, "HD", 24f, palette.onAccent, true).apply {
            gravity = Gravity.CENTER
            background = Ui.circle(this@PairingActivity, palette.accent, 32)
        }
        root.addView(logo, Ui.margins(this, Ui.lp(Ui.dp(this, 64), Ui.dp(this, 64)), 0, 34, 0, 0))

        val title = Ui.text(this, "Pair with HomeDeck", 25f, palette.text, true).apply { gravity = Gravity.CENTER }
        root.addView(title, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 18, 0, 0))
        val explain = Ui.text(
            this,
            "Scan the one-time QR code from HomeDeck → My settings → Mobile app. The app gets its own revocable token; your password is never stored on this phone.",
            13f,
            palette.muted,
        ).apply {
            gravity = Gravity.CENTER
            setLineSpacing(Ui.dp(this@PairingActivity, 3).toFloat(), 1f)
        }
        root.addView(explain, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 8, 10, 8, 0))

        scanButton = Ui.button(this, "Scan QR code", palette.accent, palette.onAccent)
        scanButton.setOnClickListener { scan() }
        root.addView(scanButton, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 24, 0, 0))

        val or = Ui.text(this, "or paste the pairing link", 11f, palette.faint).apply { gravity = Gravity.CENTER }
        root.addView(or, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 22, 0, 10))

        linkInput = EditText(this).apply {
            hint = "homedeck://pair?url=…&code=…"
            setTextColor(palette.text)
            setHintTextColor(palette.faint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
            typeface = Typeface.MONOSPACE
            background = Ui.rounded(this@PairingActivity, palette.card2, 12, palette.line)
            setPadding(Ui.dp(this@PairingActivity, 12), Ui.dp(this@PairingActivity, 10), Ui.dp(this@PairingActivity, 12), Ui.dp(this@PairingActivity, 10))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            minLines = 2
            gravity = Gravity.TOP or Gravity.START
        }
        root.addView(linkInput, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        pairButton = Ui.button(this, "Pair this phone", palette.card2, palette.accent)
        pairButton.background = Ui.rounded(this, palette.card2, 12, palette.line)
        pairButton.setOnClickListener { pair() }
        root.addView(pairButton, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 12, 0, 0))

        status = Ui.text(this, "", 12f, palette.muted).apply { gravity = Gravity.CENTER }
        root.addView(status, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 0, 16, 0, 0))

        val noteRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        noteRow.addView(Ui.icon(this, R.drawable.ic_lock, palette.faint, 14))
        val note = Ui.text(
            this,
            "The code expires after 5 minutes and can be used once. Use HTTPS outside your LAN.",
            10.5f,
            palette.faint,
        )
        note.setPadding(Ui.dp(this, 6), 0, 0, 0)
        noteRow.addView(note, Ui.lp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(noteRow, Ui.margins(this, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT), 6, 26, 6, 0))
    }

    private fun scan() {
        val options = ScanOptions()
            .setDesiredBarcodeFormats("QR_CODE")
            .setPrompt("Scan the HomeDeck pairing QR")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
        scanLauncher.launch(options)
    }

    private fun pair() {
        val link = PairLinks.parse(linkInput.text?.toString().orEmpty())
        if (link == null) {
            setStatus("That doesn't look like a valid HomeDeck pairing link.", palette.bad)
            return
        }
        val proceed = { doPair(link) }
        if (link.serverUrl.startsWith("http://")) {
            AlertDialog.Builder(this)
                .setTitle("Insecure HTTP connection")
                .setMessage("The device token will be sent over plain HTTP. Anyone on the network can capture it. Use HTTPS outside your LAN. Continue?")
                .setPositiveButton("Continue") { _, _ -> confirmReplace(link, proceed) }
                .setNegativeButton("Cancel", null)
                .show()
        } else {
            confirmReplace(link, proceed)
        }
    }

    private fun confirmReplace(link: PairLink, proceed: () -> Unit) {
        if (prefs.serverUrl.isNotEmpty() && prefs.serverUrl != link.serverUrl) {
            AlertDialog.Builder(this)
                .setTitle("Replace pairing?")
                .setMessage("This phone is already paired with ${prefs.serverUrl}. Replace it with ${link.serverUrl}?")
                .setPositiveButton("Replace") { _, _ -> proceed() }
                .setNegativeButton("Cancel", null)
                .show()
        } else {
            proceed()
        }
    }

    private fun doPair(link: PairLink) {
        scanButton.isEnabled = false
        pairButton.isEnabled = false
        setStatus("Pairing…", palette.muted)
        val deviceName = buildString {
            append(Build.MANUFACTURER.replaceFirstChar { it.uppercase() })
            append(' ')
            append(Build.MODEL)
            append(" (Android)")
        }.trim().take(60)
        executor.execute {
            try {
                val result = Api.pair(link.serverUrl, link.code, deviceName)
                secure.saveToken(result.token)
                prefs.serverUrl = result.serverUrl
                prefs.userName = result.displayName
                prefs.serverTitle = result.serverTitle
                prefs.lastGoodBase = result.serverUrl
                ServerResolver.reset()
                handler.post {
                    Toast.makeText(this, "Paired with ${result.serverTitle}", Toast.LENGTH_SHORT).show()
                    startActivity(
                        Intent(this, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                    )
                    finish()
                }
            } catch (error: Exception) {
                handler.post {
                    scanButton.isEnabled = true
                    pairButton.isEnabled = true
                    setStatus(error.message ?: "Pairing failed", palette.bad)
                }
            }
        }
    }

    private fun setStatus(message: String, color: Int) {
        status.text = message
        status.setTextColor(color)
    }
}
