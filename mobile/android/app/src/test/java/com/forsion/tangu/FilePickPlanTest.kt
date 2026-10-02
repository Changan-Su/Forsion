package com.forsion.tangu

import org.junit.Assert.assertEquals
import org.junit.Test

class FilePickPlanTest {
    private val mb = 1024L * 1024

    @Test fun refusesOversizedFilesAndKeepsTheRest() {
        assertEquals(listOf(true, false, true), FilePickPlan.plan(listOf(mb, FilePickPlan.MAX_FILE_BYTES + 1, FilePickPlan.MAX_FILE_BYTES)))
    }

    @Test fun capsTheAggregateInPickOrder() {
        // 25 + 25 = 50; a third 25 would pass 60 → refused; a later small one still fits.
        assertEquals(listOf(true, true, false, true), FilePickPlan.plan(listOf(25 * mb, 25 * mb, 25 * mb, 10 * mb)))
    }

    @Test fun capsTheCount() {
        val plan = FilePickPlan.plan(List(FilePickPlan.MAX_FILES + 3) { 1L })
        assertEquals(FilePickPlan.MAX_FILES, plan.count { it })
        assertEquals(List(3) { false }, plan.takeLast(3))
    }

    @Test fun undescribedDocumentsAreRefusedAndUnknownSizesAreLeftToJs() {
        // null = the provider threw while describing the document; -1 = no size column.
        assertEquals(listOf(false, true, true), FilePickPlan.plan(listOf(null, -1L, 0L)))
        // An unknown size does not consume the native aggregate (JS counts the real bytes).
        assertEquals(listOf(true, true, true, false), FilePickPlan.plan(listOf(-1L, 25 * mb, 25 * mb, 20 * mb)))
    }
}
