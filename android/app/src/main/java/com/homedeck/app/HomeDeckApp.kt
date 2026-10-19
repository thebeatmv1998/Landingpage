package com.homedeck.app

import android.app.Application

class HomeDeckApp : Application() {
    override fun onCreate() {
        super.onCreate()
        UiTheme.applyMode(this, Prefs(this))
    }
}
