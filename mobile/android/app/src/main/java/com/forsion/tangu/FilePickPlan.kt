package com.forsion.tangu

/**
 * Which picked documents are offered to JS, decided from provider-reported sizes only (no bytes are read on
 * the native side). JS re-checks the same caps against the bytes it actually receives
 * (mobile/src/pickedFiles.ts keeps the same three numbers): a provider may report no size, or a wrong one.
 */
internal object FilePickPlan {
    const val MAX_FILES = 20
    const val MAX_FILE_BYTES = 25L * 1024 * 1024 // = the composer's workspace-file cap (MAX_WS_BYTES)
    const val MAX_TOTAL_BYTES = 60L * 1024 * 1024

    /**
     * [sizes]: one entry per picked document in pick order. null = the document could not be described
     * (refused); a negative size = unknown (accepted here, capped by JS while streaming).
     * Returns, per document, whether it is handed to JS.
     */
    fun plan(sizes: List<Long?>): List<Boolean> {
        var total = 0L
        return sizes.mapIndexed { index, size ->
            if (size == null || index >= MAX_FILES) return@mapIndexed false
            if (size < 0) return@mapIndexed true
            if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) return@mapIndexed false
            total += size
            true
        }
    }
}
