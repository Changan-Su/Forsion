package com.forsion.tangu

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The droplet's rules (DESIGN §3): it starts where the selection is, never overshoots, and the neck is gone by 0.6D. */
class DockDropletTest {
    private val cell = 84f
    private val h = 56f
    private fun tap(t: Float) = flowShape(t, 42f, 294f, cell, h, cell, h, 1f)

    @Test fun aFlowStartsExactlyOnTheSelection() {
        val s = tap(0f)
        assertEquals(42f, s.tailX, 0f)
        assertEquals(cell, s.tailW, 0.01f)
        assertEquals(h, s.tailH, 0.01f)
    }

    @Test fun aFlowNeverRunsPastTheCell() {
        var last = 42f
        for (i in 0..200) {
            val x = tap(i / 200f).headX
            assertTrue("t=$i x=$x", x >= last - 0.01f && x <= 294.01f)
            last = x
        }
    }

    @Test fun theNeckSnapsAtPointSix() {
        assertTrue(tap(0.59f).neck > 0f)
        for (i in 60..100) assertEquals(0f, tap(i / 100f).neck, 0f)
        assertEquals(0f, tap(0.6f).tailW, 0f)
    }

    @Test fun aFlowEndsOnTheCell() {
        val s = tap(1f)
        assertEquals(294f, s.headX, 0.01f)
        assertEquals(cell, s.headW, 0.01f)
        assertEquals(h, s.headH, 0.01f)
    }

    @Test fun aDragCaughtUpIsAPlainCell() {
        val s = dragShape(100f, 100f, cell, h, 1f)
        assertEquals(cell, s.headW, 0f)
        assertEquals(h, s.headH, 0f)
        assertEquals(0f, s.tailW, 0f)
        assertEquals(0f, s.neck, 0f)
    }

    @Test fun aDragThinsWithDistance() {
        val near = dragShape(120f, 100f, cell, h, 1f)
        val far = dragShape(300f, 100f, cell, h, 1f)
        assertTrue(far.headW < near.headW && far.neck < near.neck)
        assertEquals(cell * 0.78f, far.headW, 0.01f)
    }

    @Test fun theTailCatchesUpAndNeverPasses() {
        var tail = 0f
        repeat(120) { tail = tailAfter(tail, 100f, 16f); assertTrue(tail <= 100f) }
        assertEquals(100f, tail, 0.01f)
    }

    @Test fun aReleaseSettlesWithoutBounce() {
        var last = 0f
        for (ms in 0..420 step 4) {
            val v = settleAt(ms.toFloat())
            assertTrue(v >= last && v <= 1f)
            last = v
        }
        assertEquals(1f, settleAt(420f), 0.001f)
    }

    @Test fun positionsMapToCells() {
        assertEquals(0, cellAt(-10f, 400f, 4))
        assertEquals(1, cellAt(100f, 400f, 4))
        assertEquals(3, cellAt(500f, 400f, 4))
        assertEquals(-1, cellAt(10f, 0f, 4))
    }
}
