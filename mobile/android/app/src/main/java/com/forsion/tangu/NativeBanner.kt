package com.forsion.tangu

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The phone's notification banner (2026-11-15): one line under the status bar, over the capsule row / the detail level's
 * solid top bar — the page cannot draw over either, they are native. JS owns everything else (which card, how long, the
 * queue and the throttle: notificationStore's banner mode); this draws the one it is handed and reports gestures:
 * a tap on the card = its action, swipe up past [BANNER_SWIPE_DP] or a flick / ×  = dismissed by the user.
 * `id` names the card: a new id is a new card (the old one leaves, this one comes in), the same id with other words is
 * the same card updated in place.
 */
internal data class BannerSpec(
    val id: String, val source: String, val text: String, val action: String,
    val level: Level, val dismiss: String, val hint: String, val theme: SheetTheme,
) {
    enum class Level { INFO, SUCCESS, WARNING, ERROR }

    /** What a screen reader says when it shows up: "source · title: text". */
    val spoken: String get() = if (source.isBlank()) text else "$source: $text"

    companion object {
        const val MAX_ID = 64
        const val MAX_SOURCE = 200
        const val MAX_TEXT = 500
        const val MAX_ACTION = 60
        const val MAX_LABEL = 80

        /**
         * `{ banner: {...} | null }` → the card, or null = none. Words that are too long are cut, not refused (losing a
         * notification over its length is worse than an ellipsis); an id or theme that is not usable rejects the call —
         * JS then draws the banner in the page.
         */
        fun parse(data: JSONObject): BannerSpec? {
            if (!data.has("banner") || data.isNull("banner")) return null
            val o = data.getJSONObject("banner")
            val id = NativeJson.str(o, "id", MAX_ID)
            require(id.isNotBlank()) { "Invalid banner id" }
            fun words(key: String, max: Int) = ((o.opt(key) as? String) ?: "").take(max)
            val level = when (o.opt("level")) {
                "success" -> Level.SUCCESS
                "warning" -> Level.WARNING
                "error" -> Level.ERROR
                else -> Level.INFO
            }
            return BannerSpec(
                id, words("source", MAX_SOURCE), words("text", MAX_TEXT), words("action", MAX_ACTION), level,
                words("dismiss", MAX_LABEL).ifBlank { "Dismiss" }, words("hint", MAX_LABEL), NativeJson.theme(o.getJSONObject("theme")),
            )
        }
    }
}

/** 4dp under the status bar, 10dp from each side, 54dp high (the capsule row's height) — at least: with the system's
 *  font size turned up the two lines need more, and the card grows downwards rather than cutting the second one off. */
internal val BANNER_TOP_GAP = 4.dp
internal val BANNER_SIDE = 10.dp
internal val BANNER_HEIGHT = 54.dp
private val BANNER_PAD_V = 6.dp
private val BANNER_BUTTON_HEIGHT = 30.dp
/** Transparent room under the card for its shadow (takes no touches). */
private val BANNER_SHADOW_ROOM = 12.dp
/** Swipe up this far (dp) or flick up this fast (dp/s) and the banner goes; less and it springs back. Same numbers as the page's banner (notificationBanner.ts). */
internal const val BANNER_SWIPE_DP = 24f
internal const val BANNER_FLING_DP_S = 600f
/** Enter 180ms sliding 6dp down from the top edge and fading in; leave 160ms upwards (the desktop cards' pair). */
private const val ENTER_MS = 180
private const val EXIT_MS = 160
private const val ENTER_SHIFT_DP = 6f
private const val EXIT_SHIFT_DP = 16f
private val ENTER_EASE = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
private val EXIT_EASE = CubicBezierEasing(0.4f, 0f, 1f, 1f)
private val SUCCESS_GREEN = Color(0xFF34A262)

/** A release at [dragDp] (negative = up) moving at [velocityDpS] (negative = up): does the banner go? */
internal fun bannerFlungAway(dragDp: Float, velocityDpS: Float): Boolean =
    dragDp <= -BANNER_SWIPE_DP || (dragDp < 0f && velocityDpS <= -BANNER_FLING_DP_S)

private object BannerIcons {
    private fun lucide(vararg d: String) = NativeIconSpec.Vector(0f, 0f, 24f, 24f, 2f, d.map { VectorPathSpec(it, fill = false, stroke = true) })
    private const val CIRCLE = "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0"
    val info = lucide(CIRCLE, "M12 16v-4", "M12 8h.01")
    val warning = lucide("m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01")
    val error = lucide(CIRCLE, "M12 8v4", "M12 16h.01")
}

/**
 * [spec] = the card JS wants on screen (null = none). [topInsetPx] = the status bar's height in the view's own pixels
 * (0 where the window does not run under it). Test anchors: `nativeBanner.{card,source,text,action,close}`.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeBanner(spec: BannerSpec?, topInsetPx: Int, onAction: (String) -> Unit, onDismiss: (String) -> Unit) {
    var drawn by remember { mutableStateOf<BannerSpec?>(null) } // the card on screen, kept through its exit
    val shift = remember { Animatable(0f) } // dp, up is negative
    val alpha = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var leaving by remember { mutableStateOf<Job?>(null) } // the user sent it away: its exit, still running
    val motion = rememberUpdatedState(motionOn(spec?.theme ?: drawn?.theme))
    val act = rememberUpdatedState(onAction)
    val gone = rememberUpdatedState(onDismiss)

    suspend fun leave() = coroutineScope {
        launch { alpha.animateTo(0f, tween(EXIT_MS, easing = EXIT_EASE)) }
        if (motion.value) launch { shift.animateTo(shift.value - EXIT_SHIFT_DP, tween(EXIT_MS, easing = EXIT_EASE)) }
    }

    LaunchedEffect(spec?.id) {
        val before = drawn
        if (before != null && before.id != spec?.id) {
            val running = leaving
            if (running != null) running.join() else leave()
            leaving = null
            drawn = null
        }
        if (spec != null && drawn == null) {
            drawn = spec
            shift.snapTo(if (motion.value) -ENTER_SHIFT_DP else 0f)
            alpha.snapTo(0f)
            coroutineScope {
                launch { alpha.animateTo(1f, tween(ENTER_MS, easing = ENTER_EASE)) }
                launch { shift.animateTo(0f, tween(ENTER_MS, easing = ENTER_EASE)) }
            }
        }
    }

    // the same card with new words (a later notification with the same key) is drawn in place
    val card = (if (spec != null && spec.id == drawn?.id) spec else drawn) ?: return
    val id = card.id
    val dismissNow = {
        if (leaving == null) {
            gone.value(id)
            leaving = scope.launch { leave(); drawn = null; leaving = null }
        }
    }
    // On its way out — JS took it off (time is up: `spec` is null or another card) or the user sent it away — it takes no
    // more taps, swipes or accessibility actions: JS has already let it go, and a tap reported now would find nothing to
    // run (2026-11-15: a tap 50ms either side of the 5s mark was reported and did nothing). Taps already on their way
    // back get a short grace on the page (notificationStore PHONE.lateTap).
    val exiting = spec?.id != id || leaving != null
    val live = rememberUpdatedState(!exiting)
    val theme = card.theme
    val text = Color(theme.text)
    val muted = Color(theme.muted)
    val edge = Color(theme.border)
    val tint = when (card.level) {
        BannerSpec.Level.SUCCESS -> SUCCESS_GREEN
        BannerSpec.Level.WARNING -> Color(theme.warning)
        BannerSpec.Level.ERROR -> Color(theme.danger)
        BannerSpec.Level.INFO -> muted
    }
    val glyph = when (card.level) {
        BannerSpec.Level.SUCCESS -> BuiltinIcons.check
        BannerSpec.Level.WARNING -> BannerIcons.warning
        BannerSpec.Level.ERROR -> BannerIcons.error
        BannerSpec.Level.INFO -> BannerIcons.info
    }
    val shape = RoundedCornerShape(14.dp)
    val topInset = with(LocalDensity.current) { topInsetPx.toDp() }
    val hasAction = card.action.isNotBlank()

    Box(
        Modifier.fillMaxWidth()
            .padding(top = topInset + BANNER_TOP_GAP, start = BANNER_SIDE, end = BANNER_SIDE, bottom = BANNER_SHADOW_ROOM)
            .semantics { testTagsAsResourceId = true },
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = BANNER_HEIGHT)
                // the finger's frame: outside the moving layer, so the card following it does not change what it measures
                .pointerInput(id) {
                    val tracker = VelocityTracker()
                    fun back() { scope.launch { shift.animateTo(0f, tween(ENTER_MS, easing = ENTER_EASE)) } }
                    detectVerticalDragGestures(
                        onDragStart = { tracker.resetTracking() },
                        onDragEnd = {
                            val v = tracker.calculateVelocity().y / density // px/s → dp/s
                            if (live.value && bannerFlungAway(shift.value, v)) dismissNow() else if (live.value) back()
                        },
                        onDragCancel = { if (live.value) back() },
                    ) { change, dy ->
                        if (!live.value) return@detectVerticalDragGestures // leaving: its exit owns the motion
                        tracker.addPosition(change.uptimeMillis, change.position)
                        change.consume()
                        // up only: nothing pulls down (no expanding)
                        scope.launch { shift.snapTo(minOf(0f, shift.value + dy / density)) }
                    }
                }
                .graphicsLayer { translationY = shift.value * density; this.alpha = alpha.value }
                // light: a soft shadow; dark: the surface's own step from the page, no heavier shadow (DESIGN §3)
                .then(if (theme.dark) Modifier else Modifier.shadow(8.dp, shape, ambientColor = Color.Black.copy(alpha = 0.10f), spotColor = Color.Black.copy(alpha = 0.16f)))
                .clip(shape).background(Color(theme.float)).border(1.dp, edge, shape)
                .clickable(enabled = hasAction && !exiting, role = Role.Button, onClickLabel = card.action.ifBlank { null }) { act.value(id) }
                .semantics(mergeDescendants = true) {
                    liveRegion = LiveRegionMode.Polite
                    contentDescription = card.spoken
                    customActions = if (exiting) emptyList() else buildList {
                        if (hasAction) add(CustomAccessibilityAction(card.action) { act.value(id); true })
                        add(CustomAccessibilityAction(card.dismiss) { dismissNow(); true })
                    }
                }
                .testTag("nativeBanner.card")
                .padding(start = 12.dp, end = 2.dp, top = BANNER_PAD_V, bottom = BANNER_PAD_V),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.clearAndSetSemantics {}) { NativeIconView(glyph, tint, 16.dp) }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f).clearAndSetSemantics {}, verticalArrangement = Arrangement.Center) {
                if (card.source.isNotBlank()) Text(
                    card.source, Modifier.testTag("nativeBanner.source"), color = muted, fontSize = 11.sp, lineHeight = 14.sp,
                    maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    card.text, Modifier.testTag("nativeBanner.text"), color = text, fontSize = 12.sp, lineHeight = 17.sp,
                    maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis,
                )
            }
            if (hasAction) {
                Spacer(Modifier.width(8.dp))
                // never squeezed by the words (they are cut first); a runaway label is capped
                Box(
                    Modifier.widthIn(max = 160.dp).heightIn(min = BANNER_BUTTON_HEIGHT).clip(RoundedCornerShape(8.dp)).border(1.dp, edge, RoundedCornerShape(8.dp))
                        .clickable(enabled = !exiting, role = Role.Button) { act.value(id) }.testTag("nativeBanner.action").padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(card.action, color = Color(theme.accentInk), fontSize = 12.sp, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
                }
            }
            Box(
                Modifier.size(40.dp).clip(CircleShape).clickable(enabled = !exiting, role = Role.Button) { dismissNow() }
                    .semantics { contentDescription = card.dismiss }.testTag("nativeBanner.close"),
                contentAlignment = Alignment.Center,
            ) { NativeIconView(BuiltinIcons.close, muted, 14.dp) }
        }
    }
}
