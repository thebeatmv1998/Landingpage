package com.homedeck.app

/** Small in-memory series store shared between the dashboard and detail screens. */
object HistoryStore {
    const val MAX_POINTS = 40

    val downloads: MutableMap<Int, MutableList<Float>> = mutableMapOf()

    fun addDownload(serviceId: Int, speedBps: Long) {
        val list = downloads.getOrPut(serviceId) { mutableListOf() }
        list.add(speedBps / 1_000_000f)
        while (list.size > MAX_POINTS) list.removeAt(0)
    }
}
