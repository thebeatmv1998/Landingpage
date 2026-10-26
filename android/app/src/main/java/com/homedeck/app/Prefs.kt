package com.homedeck.app

import android.content.Context

/** Non-secret preferences. The bearer token lives in [SecureStore]. */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("hd_prefs", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("serverUrl", "") ?: ""
        set(value) {
            sp.edit().putString("serverUrl", value.trim().trimEnd('/')).apply()
        }

    /** Optional public/domain address for the HomeDeck server itself. */
    var externalUrl: String
        get() = sp.getString("externalUrl", "") ?: ""
        set(value) {
            sp.edit().putString("externalUrl", value.trim().trimEnd('/')).apply()
        }

    /** auto | local | external */
    var serverMode: String
        get() = sp.getString("serverMode", "auto") ?: "auto"
        set(value) {
            sp.edit().putString("serverMode", value).apply()
        }

    /** Last working server base URL (used for the header / active indicator). */
    var lastGoodBase: String
        get() = sp.getString("lastGoodBase", "") ?: ""
        set(value) {
            sp.edit().putString("lastGoodBase", value.trim().trimEnd('/')).apply()
        }

    var userName: String
        get() = sp.getString("userName", "") ?: ""
        set(value) {
            sp.edit().putString("userName", value).apply()
        }

    /** admin | user — unlocks container and request controls. */
    var role: String
        get() = sp.getString("role", "") ?: ""
        set(value) {
            sp.edit().putString("role", value).apply()
        }

    var serverTitle: String
        get() = sp.getString("serverTitle", "HomeDeck") ?: "HomeDeck"
        set(value) {
            sp.edit().putString("serverTitle", value.ifEmpty { "HomeDeck" }).apply()
        }

    /** system | dark | light */
    var theme: String
        get() = sp.getString("theme", "system") ?: "system"
        set(value) {
            sp.edit().putString("theme", value).apply()
        }

    var accent: String
        get() = sp.getString("accent", UiTheme.accents[0]) ?: UiTheme.accents[0]
        set(value) {
            sp.edit().putString("accent", value).apply()
        }

    var compact: Boolean
        get() = sp.getBoolean("compact", false)
        set(value) {
            sp.edit().putBoolean("compact", value).apply()
        }

    var groupByCategory: Boolean
        get() = sp.getBoolean("groupByCategory", true)
        set(value) {
            sp.edit().putBoolean("groupByCategory", value).apply()
        }

    var showOffline: Boolean
        get() = sp.getBoolean("showOffline", true)
        set(value) {
            sp.edit().putBoolean("showOffline", value).apply()
        }

    var refreshSeconds: Int
        get() = sp.getInt("refreshSeconds", 20).coerceIn(10, 300)
        set(value) {
            sp.edit().putInt("refreshSeconds", value.coerceIn(10, 300)).apply()
        }

    var cachedSummary: String
        get() = sp.getString("cachedSummary", "") ?: ""
        set(value) {
            sp.edit().putString("cachedSummary", value).apply()
        }

    var cachedAt: Long
        get() = sp.getLong("cachedAt", 0L)
        set(value) {
            sp.edit().putLong("cachedAt", value).apply()
        }
}
