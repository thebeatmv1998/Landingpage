package com.homedeck.app

data class FetchedSummary(val summary: Summary, val raw: String, val base: String)

object SummaryRepository {
    /** Fetch /api/summary from the first reachable configured server address. */
    fun fetch(prefs: Prefs, token: String): FetchedSummary {
        val bases = ServerResolver.candidates(prefs)
        if (bases.isEmpty()) throw ApiException("No server address configured")
        var lastError: ApiException? = null
        for (base in bases) {
            try {
                val raw = Api.summaryRaw(base, token)
                val summary = Api.parseSummary(raw)
                ServerResolver.recordGood(base)
                prefs.lastGoodBase = base
                return FetchedSummary(summary, raw, base)
            } catch (error: ApiException) {
                if (error.code == 401) throw error // token invalid on every address
                ServerResolver.markDown(base)
                lastError = error
            }
        }
        throw lastError ?: ApiException("Could not reach HomeDeck")
    }
}
