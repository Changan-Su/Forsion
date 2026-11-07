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
    // ── motion themes (2026-11-06): Stretch leads with one end and pulls the other in late; Glide slides as it is ──
    private fun stretch(t: Float, x0: Float = 42f, x1: Float = 294f) = stretchShape(t, x0, x1, cell, h, cell, h)
    private fun left(s: DropShape) = s.headX - s.headW / 2
    private fun right(s: DropShape) = s.headX + s.headW / 2

    @Test fun aStretchStartsAndEndsExactlyOnTheCells() {
        assertEquals(42f, stretch(0f).headX, 0.01f); assertEquals(cell, stretch(0f).headW, 0.01f)
        assertEquals(294f, stretch(1f).headX, 0.01f); assertEquals(cell, stretch(1f).headW, 0.01f)
        assertEquals(h, stretch(1f).headH, 0.01f)
    }

    @Test fun aStretchLeadsWithTheFarEndAndNeverOvershoots() {
        var lastL = left(stretch(0f)); var lastR = right(stretch(0f))
        var widest = 0f
        for (i in 0..400) {
            val s = stretch(i / 400f)
            assertTrue("t=$i right end runs ahead", right(s) - lastR >= -0.01f && right(s) <= 294f + cell / 2 + 0.01f)
            assertTrue("t=$i left end never goes back", left(s) - lastL >= -0.01f && left(s) <= 294f - cell / 2 + 0.01f)
            lastL = left(s); lastR = right(s)
            widest = maxOf(widest, s.headW)
        }
        // the trailing end waits STRETCH_LAG_MS: before that only the leading one moved
        val early = stretch(STRETCH_LAG_MS / (STRETCH_EDGE_MS + STRETCH_LAG_MS) * 0.99f)
        assertEquals(42f - cell / 2, left(early), 0.01f)
        assertTrue("it stretches out on the way", widest > cell * 1.5f)
    }

    @Test fun aStretchToTheLeftLeadsWithTheLeftEnd() {
        val s = stretch(0.2f, 294f, 42f)
        assertTrue(left(s) < 294f - cell / 2 - 1f)
        assertEquals(294f + cell / 2, right(s), 0.01f)
    }

    @Test fun aGlideKeepsItsSizeAndNeverOvershoots() {
        var last = 42f
        for (i in 0..200) {
            val s = glideShape(i / 200f, 42f, 294f, cell, h, cell, h)
            assertEquals(cell, s.headW, 0.01f)
            assertTrue("t=$i", s.headX >= last - 0.01f && s.headX <= 294.01f)
            last = s.headX
        }
        assertEquals(294f, glideShape(1f, 42f, 294f, cell, h, cell, h).headX, 0.01f)
    }

    @Test fun eachThemeHasItsDuration() {
        assertEquals(DROP_FLOW_MS, DockMotion.of("droplet").flowMs(), 0f)
        assertEquals(DROP_FLOW_MS, DockMotion.of("genesis").flowMs(), 0f)
        assertEquals(410f, DockMotion.of("stretch").flowMs(), 0f)
        assertEquals(300f, DockMotion.of("glide").flowMs(), 0f)
        assertEquals(DockMotion.POUR, DockMotion.of("anything else"))
    }

    @Test fun aSpanCoversTailToHead() {
        val s = spanShape(200f, 100f, cell, h)
        assertEquals(100f - cell / 2, left(s), 0.01f)
        assertEquals(200f + cell / 2, right(s), 0.01f)
        assertEquals(cell, spanShape(150f, 150f, cell, h).headW, 0.01f)
    }
}
