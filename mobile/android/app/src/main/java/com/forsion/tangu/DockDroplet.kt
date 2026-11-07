package com.forsion.tangu

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * The dock's selection as a droplet (2026-10-31, the user picked it from
 * docs/ToBeImproved/手机Telegram手感方案_2026-10-31; the rules are DESIGN §3 "液滴展开"): a tap pours the selection over to
 * the new cell, a drag along the dock pulls it after the finger with a tail. No bounce.
 *
 * The page's droplet is an SVG filter (blur + threshold); that is not available here on every Android version
 * (RenderEffect needs 12), so the same outline is built as a path: a head, a tail and the neck between them.
 * Everything in here is in pixels and pure; NativeChromeBar owns the state and the frames.
 */
internal val DROP_SURFACE = CubicBezierEasing(0.22f, 1f, 0.36f, 1f) // --ease-surface
private val DROP_CALM = CubicBezierEasing(0.33f, 1f, 0.68f, 1f) // --ease-calm
private val DROP_EXIT = CubicBezierEasing(0.4f, 0f, 1f, 1f) // --ease-exit
/** Android's EASE_OUT_QUINT: how the dock leaves and comes back, and how much it grows under a finger. */
internal val DOCK_EASE = CubicBezierEasing(0.23f, 1f, 0.32f, 1f)

internal const val DROP_FLOW_MS = 420f // --droplet-duration
/** How much of a flow it takes to snap the neck (DESIGN: 0.6D). */
private const val DROP_NECK_ENDS = 0.6f
private const val DROP_SIZE_DP = 18f
/** The tail's lag behind a finger, ms. */
private const val DROP_TAIL_MS = 90f
/** The pixels (dp) of tail after which a stretched droplet is as thin as it gets. */
private const val DROP_FAR_DP = 90f

private fun lerp(a: Float, b: Float, t: Float) = a + (b - a) * t

/** One frame of the droplet. [tailW] 0 = no tail, the head alone; [neck] 0 = nothing joins them. */
internal data class DropShape(
    val headX: Float, val headW: Float, val headH: Float,
    val tailX: Float = headX, val tailW: Float = 0f, val tailH: Float = 0f,
    val neck: Float = 0f,
)

/** A tap: [t] 0..1 of the flow from a cell at [x0] (w0 × h0) to one at [x1] (w × h); [dp] = pixels per dp. */
internal fun flowShape(t: Float, x0: Float, x1: Float, w0: Float, h0: Float, w: Float, h: Float, dp: Float): DropShape {
    val s = DROP_SURFACE.transform(t.coerceIn(0f, 1f))
    val drop = DROP_SIZE_DP * dp
    // the source swells first, then runs dry behind the drop; it starts at its own size: the selection must not jump
    val swell = when {
        t < 0.14f -> lerp(1f, 1.08f, DROP_CALM.transform(t / 0.14f))
        t < 0.3f -> lerp(1.08f, 1f, DROP_CALM.transform((t - 0.14f) / 0.16f))
        t < DROP_NECK_ENDS -> 1f - DROP_EXIT.transform((t - 0.3f) / (DROP_NECK_ENDS - 0.3f))
        else -> 0f
    }
    return DropShape(
        lerp(x0, x1, s), lerp(min(w0, drop), w, s), lerp(min(h0, drop), h, s),
        x0, w0 * swell, h0 * swell,
        if (t < DROP_NECK_ENDS) lerp(14f, 3f, t / DROP_NECK_ENDS) * dp else 0f,
    )
}

/** A drag: the head at [x], the tail at [tail]; the further apart, the narrower the head and the thinner the neck. */
internal fun dragShape(x: Float, tail: Float, w: Float, h: Float, dp: Float): DropShape {
    val gap = kotlin.math.abs(x - tail)
    val far = (gap / (DROP_FAR_DP * dp)).coerceIn(0f, 1f)
    val k = if (far > 0.08f) lerp(0.92f, 0.5f, far) else 0f
    return DropShape(x, lerp(w, w * 0.78f, far), lerp(h, h * 0.8f, far), tail, w * k, h * k, if (gap > 6f * dp) lerp(18f, 8f, far) * dp else 0f)
}

/** The tail [dtMs] later: it closes in on the head, however far that is. */
internal fun tailAfter(tail: Float, head: Float, dtMs: Float): Float = tail + (head - tail) * (1f - exp(-dtMs / DROP_TAIL_MS))

/** Critically damped: from 0 to 1 at rest, never past 1. Where a released droplet is [ms] later (Compose's default spring). */
internal fun settleAt(ms: Float): Float {
    val w = sqrt(1500f)
    val t = ms / 1000f
    return 1f - exp(-w * t) * (1f + w * t)
}

/** The cell a position on the dock belongs to, [count] equal cells across [width]. */
internal fun cellAt(x: Float, width: Float, count: Int): Int =
    if (count <= 0 || width <= 0f) -1 else (x / (width / count)).toInt().coerceIn(0, count - 1)

/** The outline, centred on the height [cy]. */
internal fun DropShape.path(cy: Float): Path {
    fun pill(x: Float, w: Float, h: Float) = Path().apply {
        addRoundRect(RoundRect(x - w / 2, cy - h / 2, x + w / 2, cy + h / 2, CornerRadius(h / 2)))
    }
    val head = pill(headX, headW, headH)
    if (tailW <= 0f) return head
    val body = Path.combine(PathOperation.Union, head, pill(tailX, tailW, tailH))
    if (neck <= 0f) return body
    val leftIsTail = tailX < headX
    val (lx, lw, lh) = if (leftIsTail) Triple(tailX, tailW, tailH) else Triple(headX, headW, headH)
    val (rx, rw, rh) = if (leftIsTail) Triple(headX, headW, headH) else Triple(tailX, tailW, tailH)
    val ra = min(lh, lw) / 2
    val rb = min(rh, rw) / 2
    // off each end's rounded cap at 45°, in towards the middle: a neck that leaves the blobs smoothly
    val diag = sqrt(0.5f)
    val ax = lx + lw / 2 - ra + ra * diag
    val bx = rx - rw / 2 + rb - rb * diag
    if (bx <= ax) return body
    val mid = (ax + bx) / 2
    val half = neck / 2
    val neckPath = Path().apply {
        moveTo(ax, cy - ra * diag)
        cubicTo(lerp(ax, mid, 0.7f), cy - half, lerp(bx, mid, 0.7f), cy - half, bx, cy - rb * diag)
        lineTo(bx, cy + rb * diag)
        cubicTo(lerp(bx, mid, 0.7f), cy + half, lerp(ax, mid, 0.7f), cy + half, ax, cy + ra * diag)
        close()
    }
    return Path.combine(PathOperation.Union, body, neckPath)
}

/**
 * The motion theme (2026-11-06, docs/ToBeImproved/动效开放给主题方案_2026-11-06 round 2, A2): how the selection gets to
 * another cell. Genesis and Droplet pour it as above. Stretch moves its two ends apart in time: the leading end first,
 * the trailing one [STRETCH_LAG_MS] later, each over [STRETCH_EDGE_MS] — it stretches out and pulls back in, no
 * overshoot (the page's segmented capsules do the same, base.css). Glide slides it across as it is.
 * A finger dragging along the dock: Droplet / Genesis pull a tail (dragShape); Stretch spans from where the tail would be
 * to the head; Glide is the head alone. Stretch and Glide draw one capsule, cheaper than the droplet's three joined paths.
 */
internal enum class DockMotion {
    POUR, STRETCH, GLIDE;
    companion object {
        fun of(theme: String) = when (theme) { "stretch" -> STRETCH; "glide" -> GLIDE; else -> POUR }
    }
}

internal const val STRETCH_EDGE_MS = 320f
internal const val STRETCH_LAG_MS = 90f
internal const val GLIDE_MS = 300f

/** How long a tap's move takes in this theme. */
internal fun DockMotion.flowMs(): Float = when (this) {
    DockMotion.POUR -> DROP_FLOW_MS
    DockMotion.STRETCH -> STRETCH_EDGE_MS + STRETCH_LAG_MS
    DockMotion.GLIDE -> GLIDE_MS
}

/** Stretch, [t] 0..1 of the whole move, from a cell at [x0] (w0 × h0) to one at [x1] (w × h). */
internal fun stretchShape(t: Float, x0: Float, x1: Float, w0: Float, h0: Float, w: Float, h: Float): DropShape {
    val ms = t.coerceIn(0f, 1f) * (STRETCH_EDGE_MS + STRETCH_LAG_MS)
    val lead = DROP_SURFACE.transform((ms / STRETCH_EDGE_MS).coerceIn(0f, 1f))
    val trail = DROP_SURFACE.transform(((ms - STRETCH_LAG_MS) / STRETCH_EDGE_MS).coerceIn(0f, 1f))
    val toRight = x1 >= x0
    val l = lerp(x0 - w0 / 2, x1 - w / 2, if (toRight) trail else lead)
    val r = lerp(x0 + w0 / 2, x1 + w / 2, if (toRight) lead else trail)
    return DropShape((l + r) / 2, r - l, lerp(h0, h, lead))
}

/** Glide, [t] 0..1: the selection slides across as it is. */
internal fun glideShape(t: Float, x0: Float, x1: Float, w0: Float, h0: Float, w: Float, h: Float): DropShape {
    val s = DROP_SURFACE.transform(t.coerceIn(0f, 1f))
    return DropShape(lerp(x0, x1, s), lerp(w0, w, s), lerp(h0, h, s))
}

/** A drag in Stretch / Glide: one capsule from [tail] to [head] (Glide passes the head twice). */
internal fun spanShape(head: Float, tail: Float, w: Float, h: Float): DropShape {
    val l = min(head, tail) - w / 2
    val r = max(head, tail) + w / 2
    return DropShape((l + r) / 2, r - l, h)
}

/** Longest a dock waits for the page to confirm a tap; past that the page refused and the selection goes back. */
internal const val DOCK_PENDING_MS = 1500L

/** Stiffness of the small spring an icon does when it gets selected (a 0.3 s swing, as on the demo page). */
internal val ICON_STIFFNESS = (2f * PI.toFloat() / 0.3f).let { it * it }

