package com.forsion.tangu

import android.graphics.BitmapFactory
import android.util.Base64
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.toSize
import androidx.core.graphics.Insets
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Room the top capsules take below the status-bar inset: 6dp + the 46dp capsules + 6dp. Floating (shell pages), the
 * page keeps that much clear at the top of what it scrolls; otherwise the plugin lays the WebView out under it.
 */
internal val NATIVE_CHROME_HEIGHT = 58.dp
private val CAPSULE_HEIGHT = 46.dp
private val CAPSULE_GAP = 6.dp
/** Distance of a capsule from the screen's side edge (plus any cutout inset). */
private val CAPSULE_SIDE = 12.dp
/** The two top capsules never touch: what is left between them shows the page (and passes touches to it). */
private val CAPSULE_BETWEEN = 8.dp
/** Fill of a capsule the page blurs behind (2026-10-09, the "medium" glass of the mock-up the user picked from). */
private const val FROSTED_FILL = 0.5f

/**
 * Where a capsule ended up, in window pixels (null = it is gone). The plugin passes these on to the page, which
 * draws the blur and the shadow there: a native view cannot blur the WebView behind it, the page can.
 */
internal typealias PlateSink = (id: String, bounds: Rect?) -> Unit

/** A capsule's own paint: the page's card colour (thin when the page blurs behind it) and the theme's hairline. */
private class CapsuleLook(theme: SheetTheme, frosted: Boolean) {
    val fill = Color(theme.surface).copy(alpha = if (frosted) FROSTED_FILL else 1f)
    val edge = Color(theme.border)
}

/**
 * Native top chrome: two capsules. Left = where you are (back / left drawer · title), right = what you can do
 * (search · right drawer · tab count · more · account avatar — the avatar only when JS sends one: first-level pages;
 * search only when the page says it has something to search). The title can carry a quieter second part (which
 * vault) and be a button (`titleTap`): it then ends in a small mark and reports `title`.
 * Page mode: back · title on the left, an optional close on the right. JS owns everything; buttons only report actions.
 * Floating (shell pages that asked for it) the view is see-through around the capsules and the WebView runs under
 * it; otherwise the strip is painted and the WebView starts below.
 * "More" carries a dot while something behind it wants a look (`moreDot`; danger red like the web `.rb-dot`).
 * [rail] = the Spaces stand in the rail at the left edge (wide windows, NativeSpaceRail): the capsules start after it, and
 * after the page's docked left column (`leftInset`); the avatar is at the rail's foot instead of in the right capsule.
 * `capLeftMax` caps the left capsule (the page lays something out in this row right of it); the title is cut with an ellipsis.
 * Test anchors: `nativeChrome.{bar,capLeft,capRight,left,right,tabs,more,moreDot,account,back,close,title,titleSub,titleButton,search}` (resource-ids).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeChromeBar(state: ChromeState, insets: Insets, onPlate: PlateSink, onAction: (String) -> Unit, rail: Boolean = false) {
    val theme = state.theme
    val fg = Color(theme.text)
    val density = LocalDensity.current
    val top: Dp = with(density) { insets.top.toDp() }
    val start: Dp = with(density) { insets.left.toDp() } + (if (rail) NATIVE_RAIL_WIDTH else 0.dp) + state.leftInset.dp
    val end: Dp = with(density) { insets.right.toDp() }
    val scheme = remember(theme) { theme.colorScheme() }
    val look = remember(theme, state.frosted) { CapsuleLook(theme, state.frosted) }
    MaterialTheme(colorScheme = scheme) { Box(
        Modifier.fillMaxSize()
            .then(if (state.floating) Modifier else Modifier.background(Color(theme.background)))
            .semantics { testTagsAsResourceId = true }
            .testTag("nativeChrome.bar"),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .padding(top = top + CAPSULE_GAP, start = start + CAPSULE_SIDE, end = end + CAPSULE_SIDE)
                .height(CAPSULE_HEIGHT),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (state.mode) {
                ChromeState.Mode.SHELL -> {
                    // A first-level page (Space list, Home) has no left button: the capsule is just the title.
                    // capLeftMax: the page has something in this row right of it (the board on a wide window) → the title is cut.
                    val capMax = if (state.capLeftMax > 0) Modifier.widthIn(max = state.capLeftMax.dp) else Modifier
                    if (state.left || state.title.isNotBlank()) Capsule("capLeft", look, onPlate, Modifier.weight(1f, fill = false).then(capMax)) {
                        if (state.left) CapsuleIconButton("left", state.labels.getValue("left"), state.icons.left, fg) { onAction("left") }
                        CapsuleTitle(
                            state.title, fg, lead = !state.left, sub = state.titleSub, subColor = Color(theme.muted),
                            more = state.icons.titleMore.takeIf { state.titleTap }, onTap = if (state.titleTap) ({ onAction("title") }) else null,
                        )
                    } else Spacer(Modifier.width(0.dp)) // keeps the other capsule at the trailing edge
                    Capsule("capRight", look, onPlate, Modifier.padding(start = CAPSULE_BETWEEN)) {
                        if (state.search.isNotBlank()) CapsuleIconButton("search", state.search, state.icons.search, fg) { onAction("search") }
                        if (state.right) CapsuleIconButton("right", state.labels.getValue("right"), state.icons.right, fg) { onAction("right") }
                        // One tab = nothing to switch between: the count would only take a slot ("New tab" is in ⋯).
                        if (state.tabCount > 1) TabCountButton(state.tabCount, state.labels.getValue("tabs"), fg) { onAction("tabs") }
                        CapsuleIconButton(
                            "more", state.labels.getValue("more"), state.icons.more, fg,
                            dot = state.moreDot, dotColor = Color(theme.danger), ring = Color(theme.surface),
                        ) { onAction("more") }
                        if (!rail) state.account?.let { AvatarButton(it, Color(theme.accent)) { onAction("account") } }
                    }
                }
                ChromeState.Mode.PAGE -> {
                    Capsule("capLeft", look, onPlate, Modifier.weight(1f, fill = false)) {
                        CapsuleIconButton("back", state.back, state.icons.back ?: BuiltinIcons.chevronLeft, fg) { onAction("back") }
                        CapsuleTitle(state.title, fg, lead = false)
                    }
                    if (state.close.isNotBlank()) Capsule("capRight", look, onPlate, Modifier.padding(start = CAPSULE_BETWEEN)) {
                        CapsuleIconButton("close", state.close, state.icons.close ?: BuiltinIcons.close, fg) { onAction("close") }
                    }
                }
                ChromeState.Mode.HIDDEN -> Unit
            }
        }
    } }
}

/** One capsule. [modifier] is laid out outside its paint (spacing, weight); its painted bounds go to [onPlate]. */
@Composable
private fun Capsule(id: String, look: CapsuleLook, onPlate: PlateSink, modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    DisposableEffect(id) { onDispose { onPlate(id, null) } }
    Row(
        modifier.height(CAPSULE_HEIGHT)
            .onGloballyPositioned { onPlate(id, Rect(it.positionInWindow(), it.size.toSize())) }
            .testTag("nativeChrome.$id")
            .pointerInput(Unit) {} // a touch on the capsule stays here; the strip around it is transparent and lets it through to the page
            .clip(CircleShape).background(look.fill).border(1.dp, look.edge, CircleShape)
            .padding(horizontal = 3.dp),
        verticalAlignment = Alignment.CenterVertically, content = content,
    )
}

/**
 * [lead] = nothing stands before the title in its capsule: it starts at the capsule's own text inset.
 * [sub] = a quieter second part behind a hairline ("Notes | Cloud vault"); [onTap] makes the whole title one button
 * (as tall as the capsule's other buttons) and [more] is the mark that says so.
 */
@Composable
private fun RowScope.CapsuleTitle(
    title: String, color: Color, lead: Boolean, sub: String = "", subColor: Color = color, more: NativeIconSpec? = null, onTap: (() -> Unit)? = null,
) {
    if (title.isBlank()) return
    Row(
        Modifier.weight(1f, fill = false).height(40.dp).clip(CircleShape)
            .then(if (onTap != null) Modifier.clickable(role = Role.Button, onClick = onTap).testTag("nativeChrome.titleButton") else Modifier)
            .padding(start = if (lead) 14.dp else 2.dp, end = if (more != null) 8.dp else 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title, Modifier.weight(1f, fill = false).testTag("nativeChrome.title"),
            color = color, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (sub.isNotBlank()) {
            Box(Modifier.padding(horizontal = 9.dp).width(1.dp).height(14.dp).background(subColor.copy(alpha = 0.35f)))
            Text(
                sub, Modifier.weight(1f, fill = false).testTag("nativeChrome.titleSub"),
                color = subColor, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (more != null) NativeIconView(more, subColor, 16.dp, Modifier.padding(start = 3.dp))
    }
}

/** [dot] non-null = a dot at the icon's top-right corner; its text (if any) is what a screen reader adds to [label]. */
@Composable
private fun CapsuleIconButton(
    id: String, label: String, icon: NativeIconSpec?, tint: Color,
    dot: String? = null, dotColor: Color = Color.Unspecified, ring: Color = Color.Unspecified, onClick: () -> Unit,
) {
    Box(
        Modifier.size(40.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                if (!dot.isNullOrBlank()) stateDescription = dot
            }
            .testTag("nativeChrome.$id"),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) NativeIconView(icon, tint, NATIVE_ICON_SIZE)
        // centre on the 22dp glyph's top-right corner, where the web capsule puts its `.rb-dot`
        if (dot != null) Dot(dotColor, ring, Modifier.align(Alignment.TopEnd).offset(x = (-7).dp, y = 7.dp).testTag("nativeChrome.${id}Dot"))
    }
}

/** A picture the state parser let through (ChromeState.usablePng) → bitmap; blank or undecodable → null. */
@Composable
private fun rememberPng(png: String): ImageBitmap? = remember(png) {
    if (png.isEmpty()) null else try {
        val bytes = Base64.decode(png, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    } catch (_: Exception) { null }
}

/** Account avatar: the picture when there is one, else the initial / person glyph on an accent-tinted disc. */
@Composable
private fun AvatarButton(account: ChromeAccount, accent: Color, onClick: () -> Unit) {
    val picture = rememberPng(account.png)
    Box(
        Modifier.size(40.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = account.label }
            .testTag("nativeChrome.account"),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(30.dp).clip(CircleShape).background(accent.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
            val icon = account.icon
            when {
                picture != null -> Image(picture, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                // The initial is laid out in the disc itself: inside an icon-sized box its line box does not fit and the letter sits low.
                icon is NativeIconSpec.Text -> Text(icon.text, color = accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                icon != null -> NativeIconView(icon, accent, 18.dp)
            }
        }
    }
}

/** Rounded square with the tab count (mobile-browser convention, same as the web capsule). */
@Composable
private fun TabCountButton(count: Int, label: String, tint: Color, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }
            .testTag("nativeChrome.tabs"),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(22.dp).border(1.8.dp, tint, RoundedCornerShape(6.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(if (count > 99) "99" else maxOf(count, 1).toString(), color = tint, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

/**
 * Room the dock takes above the system navigation inset: 6dp + the 68dp dock + 6dp. Floating, the page keeps that
 * much clear at the bottom of what it scrolls; otherwise the plugin ends the WebView above it.
 */
internal val NATIVE_SPACE_BAR_HEIGHT = 80.dp
private val DOCK_HEIGHT = 68.dp
private val DOCK_GAP = 6.dp
private val DOCK_CELL_HEIGHT = 56.dp
/** Between the capsule and a cell, all round: (68 − 56) / 2, so the selection's corners run parallel to the capsule's. */
private val DOCK_INSET = 6.dp
/** A cell is a fifth of the dock at most: with fewer Spaces the dock is as wide as they are, centred. */
private val DOCK_CELL_MAX = 84.dp
private val DOCK_ICON = 26.dp

/**
 * Bottom dock: one capsule of equal cells, each an icon over its name (2026-10-09, variant ③ of the second mock-up:
 * the user found the icon-only dock too small and wanted the names back under the icons). Every Space while they fit
 * (ChromeState.DOCK_CELLS), otherwise the pinned ones and a last cell for all of them — nothing scrolls, so every
 * cell is where it was the last time. The cell you are in is tinted; in a Space that is not in the dock that is "all".
 * Tap = switch (with a light tick when it really switches), long-press on a Space = pin to the launcher, a finger
 * going sideways along the dock = pick a cell by sliding to it, switching on release (ticks at every cell it crosses).
 * The selection is one droplet under the cells, fully round so it sits concentric in the capsule. It answers the finger
 * at once: the page's confirmation only corrects it (see rememberSelected).
 * A cell may carry a badge: a dot at its icon's top-right corner (see ChromeBadge); "all" shows the most pressing
 * one of the Spaces behind it.
 * Test anchors: `nativeChrome.spaces` (the strip), `nativeChrome.dock` (the capsule), `nativeChrome.space.<id>`,
 * `nativeChrome.spacesAll`.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeSpaceBar(
    state: ChromeState, insets: Insets, onPlate: PlateSink, onAll: () -> Unit,
    shown: () -> Float = { 1f }, interactive: Boolean = true, onSpace: (id: String, long: Boolean) -> Unit,
) {
    val theme = state.theme
    val density = LocalDensity.current
    val view = LocalView.current
    val scheme = remember(theme) { theme.colorScheme() }
    val look = remember(theme, state.frosted) { CapsuleLook(theme, state.frosted) }
    val cell = CellColors(Color(theme.accent), Color(theme.muted), Color(theme.warning), Color(theme.surface))
    val motion = motionOn()
    val keys = state.dock.map { cellKey(it) } + if (state.more.isNotEmpty()) listOf(ALL_CELL) else emptyList()
    // the gesture reads this one: restarting it for a page that changed underneath would drop a finger still on the dock
    val cells by rememberUpdatedState(keys)
    val active = activeKey(state.dock, state.more)
    val selected = rememberSelected(active)
    val scope = rememberCoroutineScope()
    val drop = remember { DockDrop() }
    val dp = density.density
    val hover = drop.hover.takeIf { it in keys.indices }?.let { keys[it] }
    val target = keys.indexOf(selected.key)
    val grown = animateFloatAsState(if (drop.scrubbing && motion) DOCK_GROWN else 1f, tween(DOCK_MOTION_MS, easing = DOCK_EASE), label = "dockGrown")
    LaunchedEffect(target, drop.width, keys.size, drop.scrubbing, drop.settling) { drop.follow(target, keys.size, dp, motion) }
    DisposableEffect(Unit) { onDispose { onPlate("dock", null) } }
    MaterialTheme(colorScheme = scheme) { Box(
        Modifier.fillMaxSize()
            .then(if (state.floating) Modifier else Modifier.background(Color(theme.background)))
            .then(if (interactive) Modifier.semantics { testTagsAsResourceId = true }.testTag("nativeChrome.spaces") else Modifier.clearAndSetSemantics {}),
        contentAlignment = Alignment.TopCenter,
    ) {
        Row(
            Modifier.padding(
                top = DOCK_GAP,
                start = with(density) { insets.left.toDp() } + CAPSULE_SIDE, end = with(density) { insets.right.toDp() } + CAPSULE_SIDE,
            )
                .height(DOCK_HEIGHT)
                // before the graphicsLayer: the page's plate stays where the dock rests, whatever the dock is doing on top of it
                .onGloballyPositioned { onPlate("dock", Rect(it.positionInWindow(), it.size.toSize())) }
                .then(if (interactive) Modifier.testTag("nativeChrome.dock") else Modifier)
                // as the top capsules: the dock keeps its touches, the strip beside it does not. Leaving, it takes none
                // at all: a ComposeView only takes what one of its pointer inputs was hit by, the rest falls through to the page
                .then(if (interactive) Modifier.pointerInput(Unit) {
                    val inset = DOCK_INSET.toPx()
                    val cross = { n: Int -> view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); drop.hover = n }
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        val slop = viewConfiguration.touchSlop
                        val longAt = down.uptimeMillis + viewConfiguration.longPressTimeoutMillis
                        var scrubbing = false
                        var done = false
                        // A cancelled gesture (the system took it) leaves the selection where it was; only a lift picks.
                        try {
                            while (true) {
                                val change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: break
                                val x = change.position.x - inset
                                val moved = change.position - down.position
                                if (!change.pressed) {
                                    // what Compose makes of a cancel: a lift that is already consumed. Only a real one picks
                                    if (scrubbing && !change.isConsumed) {
                                        change.consume()
                                        done = true
                                        val key = cells.getOrNull(cellAt(x, drop.width, cells.size))
                                        val moves = key != null && key != ALL_CELL && key != selected.key
                                        if (moves) { selected.pick(key!!); onSpace(key.removePrefix(SPACE_CELL), false) }
                                        // "all" only opens the sheet: the selection stays with what is selected
                                        drop.release(scope, cells.indexOf(selected.key), motion)
                                        if (key == ALL_CELL) onAll()
                                    }
                                    break
                                }
                                if (scrubbing) { change.consume(); drop.drag(x, cells.size, cross); continue }
                                // past that the cell's long-press has it. Going up or down: not a slide along the dock
                                if (change.uptimeMillis >= longAt) break
                                if (abs(moved.y) > slop && abs(moved.y) >= abs(moved.x)) break
                                if (abs(moved.x) > slop) {
                                    change.consume()
                                    scrubbing = true
                                    drop.begin(scope, x, cells.indexOf(selected.key), cells.size, dp, motion)
                                }
                            }
                        } finally {
                            if (scrubbing && !done) drop.release(scope, cells.indexOf(selected.key), motion)
                        }
                    }
                } else Modifier)
                .graphicsLayer {
                    val p = shown()
                    alpha = p
                    translationY = if (motion) (1f - p) * DOCK_SINK.toPx() else 0f
                    scaleX = grown.value; scaleY = grown.value
                    transformOrigin = TransformOrigin(drop.pivot, 0.5f)
                }
                .clip(CircleShape).background(look.fill).border(1.dp, look.edge, CircleShape)
                .padding(horizontal = DOCK_INSET)
                .onSizeChanged { drop.width = it.width.toFloat(); drop.height = it.height.toFloat() }
                .drawBehind { drop.draw(this, cell.accent.copy(alpha = SELECTED_ALPHA), keys.size, DOCK_CELL_HEIGHT.toPx()) },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SpaceCells(
                state, state.dock, state.more, cell, Modifier.weight(1f, fill = false).widthIn(max = DOCK_CELL_MAX).fillMaxWidth().height(DOCK_CELL_HEIGHT),
                hover ?: selected.key, pill = false, interactive = interactive, motion = motion, onPick = selected::pick, onAll = onAll, onSpace = onSpace,
            )
        }
    } }
}

/**
 * The dock on its way: it follows the page's wish ([state] says `spaceBar`), but stays on screen as long as it takes to
 * leave. It sinks and fades while the page slides, and comes back the same way (2026-10-31; before, it went away between
 * two frames with the page still moving). [animated] = this change is one to play (the plugin knows: not with the keyboard,
 * not without the frosted page behind it). [onSettled] = it has arrived or is gone.
 */
@Composable
internal fun NativeDockHost(
    state: ChromeState?, insets: Insets, onPlate: PlateSink, onAll: () -> Unit, onSpace: (id: String, long: Boolean) -> Unit,
    animated: () -> Boolean, onSettled: () -> Unit,
) {
    val wanted = state?.spaceBar == true
    var last by remember { mutableStateOf(state.takeIf { wanted }) }
    if (wanted) last = state
    var stays by remember { mutableStateOf(wanted) }
    val shown = remember { Animatable(if (wanted) 1f else 0f) }
    val motion = motionOn()
    LaunchedEffect(wanted) {
        if (wanted) stays = true
        val to = if (wanted) 1f else 0f
        if (shown.value != to) {
            if (animated()) shown.animateTo(to, tween(if (motion) DOCK_MOTION_MS else DOCK_QUIET_MS, easing = DOCK_EASE)) else shown.snapTo(to)
        }
        stays = wanted
        onSettled()
    }
    val held = last
    if (held != null && (wanted || stays)) NativeSpaceBar(
        held, insets, onPlate, onAll, interactive = wanted,
        // a dock that appears without playing is simply there, not at 0 for the frame before the effect below it runs
        shown = { if (wanted && !animated()) 1f else shown.value }, onSpace = onSpace,
    )
}

private const val SELECTED_ALPHA = 0.15f
private const val DOCK_GROWN = 1.019f
private const val DOCK_MOTION_MS = 380
private const val DOCK_QUIET_MS = 120
private val DOCK_SINK = 40.dp
private const val SPACE_CELL = "space."
private const val ALL_CELL = "spacesAll"
private fun cellKey(space: ChromeSpace) = SPACE_CELL + space.id
private fun activeKey(cells: List<ChromeSpace>, more: List<ChromeSpace>): String? =
    cells.firstOrNull { it.active }?.let(::cellKey) ?: ALL_CELL.takeIf { more.any { it.active } }

/** The system's "remove animations" (Android: accessibility → remove animations). */
@Composable
private fun motionOn(): Boolean {
    val resolver = LocalContext.current.contentResolver
    return remember(resolver) { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f }
}

/**
 * What the bar shows as selected: [pending] (the finger's last word) until the page says the same, or for
 * [DOCK_PENDING_MS] at most. A switch goes the long way round through JS, and the selection used to wait for it.
 */
private class Selected {
    var pending by mutableStateOf<String?>(null)
    var page: String? = null
    val key: String? get() = pending ?: page
    fun pick(key: String) { pending = key.takeIf { it != page } }
}

@Composable
private fun rememberSelected(active: String?): Selected {
    val selected = remember { Selected() }
    selected.page = active
    val pending = selected.pending
    if (pending != null && pending == active) SideEffect { selected.pending = null }
    // keyed on the tap alone: an answer to an earlier tap does not buy this one more time
    LaunchedEffect(pending) {
        if (pending == null) return@LaunchedEffect
        delay(DOCK_PENDING_MS) // the page refused or never answered: back to what it says
        selected.pending = null
    }
    return selected
}

/**
 * The droplet's moving parts. Reads of [shape], [width] and the rest happen in the draw phase (and in the layer's block),
 * so a frame of it redraws the dock and recomposes nothing; only crossing into another cell ([hover]) does.
 */
private class DockDrop {
    var width by mutableFloatStateOf(0f)
    var height by mutableFloatStateOf(0f)
    /** The cell the droplet rests on (-1 none); while [shape] is set that shape is what is drawn instead. */
    private var rest by mutableIntStateOf(-1)
    private var shape by mutableStateOf<DropShape?>(null)
    var scrubbing by mutableStateOf(false)
    var hover by mutableIntStateOf(-1)
    var pivot by mutableFloatStateOf(0.5f)
    /** Let go, on the way to where it lands. */
    var settling by mutableStateOf(false)
        private set
    private var flow: Job? = null
    private var finger = 0f
    private var tail = 0f
    private var head = 0f
    private var offset = 0f
    private var count = 0
    private var dp = 1f

    private fun cell() = if (count > 0) width / count else 0f
    private fun centre(i: Int) = (i + 0.5f) * cell()
    private fun cellH() = DOCK_CELL_HEIGHT.value * dp
    private fun clampX(x: Float) = x.coerceIn(centre(0), centre(count - 1))

    /** The selection moved: pour it over, unless a finger has it. */
    suspend fun follow(target: Int, cells: Int, density: Float, motion: Boolean) {
        count = cells; dp = density
        if (scrubbing || settling || width <= 0f) return
        if (target == rest && shape == null) return
        val from = shape
        if (rest < 0 || target < 0 || !motion) { rest = target; shape = null; return }
        val x0 = from?.headX ?: centre(rest)
        val w0 = from?.headW ?: cell()
        val h0 = from?.headH ?: cellH()
        val x1 = centre(target)
        rest = target
        val start = withFrameNanos { it }
        while (true) {
            val t = withFrameNanos { (it - start) / 1_000_000f } / DROP_FLOW_MS
            if (t >= 1f) break
            shape = flowShape(t, x0, x1, w0, h0, cell(), cellH(), dp)
        }
        shape = null
    }

    fun begin(scope: CoroutineScope, x: Float, from: Int, cells: Int, density: Float, motion: Boolean) {
        flow?.cancel()
        settling = false
        count = cells; dp = density
        finger = x
        val fromX = shape?.headX ?: centre(from.coerceAtLeast(0))
        rest = from
        scrubbing = true
        pivot = if (width > 0f) (x / width).coerceIn(0f, 1f) else 0.5f
        head = fromX; tail = fromX
        offset = fromX - clampX(x)
        hover = from
        flow = scope.launch {
            val start = withFrameNanos { it }
            var last = start
            while (scrubbing) {
                withFrameNanos { now ->
                    val dt = (now - last) / 1_000_000f
                    last = now
                    if (!motion) { head = clampX(finger); tail = head; shape = dragShape(head, head, cell(), cellH(), dp); return@withFrameNanos }
                    head = clampX(finger) + offset * (1f - settleAt((now - start) / 1_000_000f))
                    tail = tailAfter(tail, head, dt)
                    shape = dragShape(head, tail, cell(), cellH(), dp)
                }
            }
        }
    }

    fun drag(x: Float, cells: Int, onCross: (Int) -> Unit) {
        finger = x
        val n = cellAt(x, width, cells)
        if (n != hover) onCross(n)
    }

    /** The finger left: it settles on the cell [to], from wherever it was. */
    fun release(scope: CoroutineScope, to: Int, motion: Boolean) {
        flow?.cancel()
        scrubbing = false
        hover = -1
        if (!motion || to < 0) { rest = to; shape = null; return }
        settling = true
        val from = head
        val x = centre(to)
        flow = scope.launch {
            val start = withFrameNanos { it }
            var last = start
            var ms = 0f
            while (ms < DROP_SETTLE_MS) {
                withFrameNanos { now ->
                    ms = (now - start) / 1_000_000f
                    val dt = (now - last) / 1_000_000f
                    last = now
                    head = from + (x - from) * settleAt(ms)
                    tail = tailAfter(tail, head, dt)
                    shape = dragShape(head, tail, cell(), cellH(), dp)
                }
            }
            rest = to
            shape = null
            settling = false
        }
    }

    fun draw(scope: DrawScope, color: Color, cells: Int, cellHeight: Float) = with(scope) {
        val now = shape
        if (now != null) { drawPath(now.path(center.y), color); return@with }
        if (rest !in 0 until cells || cells <= 0) return@with
        val w = size.width / cells
        drawRoundRect(color, Offset(rest * w, center.y - cellHeight / 2), Size(w, cellHeight), CornerRadius(cellHeight / 2))
    }
}

private const val DROP_SETTLE_MS = 420f

/** Width of the Space rail at the left edge of a wide window (2026-10-20, mock-up A2), where it stands instead of the dock. */
internal val NATIVE_RAIL_WIDTH = 76.dp
private val RAIL_CELL_WIDTH = 62.dp
private val RAIL_CELL_HEIGHT = 58.dp
private val RAIL_CELL_GAP = 4.dp

/**
 * Space rail (wide windows: a tablet on its side, a phone too — the same line as the page's wide layout): the dock's
 * cells stood up along the left edge, like the desktop ribbon. Opaque, in the shell's own colour with a hairline on its
 * right; the WebView starts after it, so it needs no plate. As many Spaces as its height holds (all of them on a
 * tablet, as a rule); past that the pinned ones first and a last cell for all. The account avatar sits at its foot.
 * Taps and long-presses only, as the dock: the left edge is the system's back gesture.
 * Test anchors: `nativeChrome.rail`, the cells as in the dock (`nativeChrome.space.<id>`, `nativeChrome.spacesAll`), `nativeChrome.account`.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeSpaceRail(state: ChromeState, insets: Insets, onAll: () -> Unit, onAccount: () -> Unit, onSpace: (id: String, long: Boolean) -> Unit) {
    val theme = state.theme
    val density = LocalDensity.current
    val scheme = remember(theme) { theme.colorScheme() }
    val bg = Color(theme.background)
    val cell = CellColors(Color(theme.accent), Color(theme.muted), Color(theme.warning), bg)
    MaterialTheme(colorScheme = scheme) { Row(
        Modifier.fillMaxSize().background(bg).semantics { testTagsAsResourceId = true }.testTag("nativeChrome.rail"),
    ) {
        Column(
            Modifier.weight(1f).fillMaxHeight().padding(
                start = with(density) { insets.left.toDp() }, top = with(density) { insets.top.toDp() } + 8.dp,
                bottom = with(density) { insets.bottom.toDp() } + 10.dp,
            ),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                val fit = ((maxHeight + RAIL_CELL_GAP) / (RAIL_CELL_HEIGHT + RAIL_CELL_GAP)).toInt()
                val (cells, more) = state.railCells(fit)
                val selected = rememberSelected(activeKey(cells, more))
                val motion = motionOn()
                Column(verticalArrangement = Arrangement.spacedBy(RAIL_CELL_GAP)) {
                    SpaceCells(
                        state, cells, more, cell, Modifier.size(RAIL_CELL_WIDTH, RAIL_CELL_HEIGHT),
                        selected.key, pill = true, interactive = true, motion = motion, onPick = selected::pick, onAll = onAll, onSpace = onSpace,
                    )
                }
            }
            state.account?.let { AvatarButton(it, Color(theme.accent), onAccount) }
        }
        Box(Modifier.width(1.dp).fillMaxHeight().background(Color(theme.border)))
    } }
}

/**
 * The Space cells of the dock and of the rail: [cells], then "all" while [more] is not empty. [cellModifier] sizes one cell,
 * [selected] is the key of the one to show as selected, [pill] = it wears its own pill (the dock has one droplet under all
 * of them instead), [interactive] = false while the dock is leaving: it takes no touches any more. A tap says [onPick]
 * first: the selection answers it before the page has heard of it.
 */
@Composable
private fun SpaceCells(
    state: ChromeState, cells: List<ChromeSpace>, more: List<ChromeSpace>, colors: CellColors, cellModifier: Modifier,
    selected: String?, pill: Boolean, interactive: Boolean, motion: Boolean, onPick: (String) -> Unit,
    onAll: () -> Unit, onSpace: (id: String, long: Boolean) -> Unit,
) {
    val view = LocalView.current
    for (space in cells) SpaceCell(
        cellModifier, cellKey(space), space.label, selected == cellKey(space), colors, space.badge, pill, interactive, motion,
        onClick = {
            // A light tick when the tap really switches Space. The system's own effect: the user's touch-feedback
            // setting applies and no VIBRATE permission is involved. (The long-press ticks by itself.)
            if (selected != cellKey(space)) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
            onPick(cellKey(space))
            onSpace(space.id, false)
        },
        onLongClick = { onSpace(space.id, true) },
    ) { tint ->
        // A Space with a picture of its own (a plugin's icon) shows it, in its own colours like the desktop ribbon:
        // the tint and the name carry the selection. Otherwise — or while the picture is not there — its line icon.
        val picture = rememberPng(space.png)
        if (picture != null) {
            Image(
                picture, contentDescription = null, contentScale = ContentScale.Crop,
                modifier = Modifier.size(DOCK_ICON).clip(RoundedCornerShape(7.dp)).testTag("nativeChrome.spacePicture"),
            )
        } else if (space.icon != null) NativeIconView(space.icon, tint, DOCK_ICON)
    }
    if (more.isNotEmpty()) SpaceCell(
        cellModifier, ALL_CELL, state.allLabel, selected == ALL_CELL, colors, ChromeState.pressing(more), pill, interactive, motion, onClick = onAll, onLongClick = null,
    ) { tint -> state.icons.all?.let { NativeIconView(it, tint, DOCK_ICON) } }
}

/** `bar` = what the dock is filled with (the ring around a badge dot is that colour). */
private class CellColors(val accent: Color, val muted: Color, val warning: Color, val bar: Color)

/** One cell of the dock / the rail: [icon] over [label]. The name is on screen for every cell, so it is also what a screen reader says. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SpaceCell(
    modifier: Modifier, tag: String, label: String, active: Boolean, colors: CellColors, badge: ChromeBadge?,
    ownPill: Boolean, interactive: Boolean, motion: Boolean,
    onClick: () -> Unit, onLongClick: (() -> Unit)?, icon: @Composable (tint: Color) -> Unit,
) {
    // The colour moves over to the new cell (spring, Compose's default) instead of jumping there: the switch a tap
    // makes reads as one motion (2026-10-14, "no linear / sudden animation, native liveliness").
    val tint by animateColorAsState(if (active) colors.accent else colors.muted, label = "cellTint")
    val pill by animateColorAsState(if (active && ownPill) colors.accent.copy(alpha = SELECTED_ALPHA) else colors.accent.copy(alpha = 0f), label = "cellPill")
    // The icon of the cell that just got selected gives a little (it has no filled form to turn into).
    val iconScale = remember { Animatable(1f) }
    var wasActive by remember { mutableStateOf(active) }
    LaunchedEffect(active) {
        val selectedNow = active && !wasActive && motion
        wasActive = active
        if (selectedNow) {
            iconScale.snapTo(0.84f)
            iconScale.animateTo(1f, spring(dampingRatio = 0.55f, stiffness = ICON_STIFFNESS))
        } else iconScale.snapTo(1f) // a finger passing over: the spring it was cut off in must not stay behind
    }
    val badgeLabel = badge?.label.orEmpty()
    Column(
        modifier.clip(if (ownPill) RoundedCornerShape(18.dp) else RoundedCornerShape(DOCK_CELL_HEIGHT / 2)).background(pill)
            .then(if (interactive) Modifier.combinedClickable(role = Role.Tab, onClick = onClick, onLongClick = onLongClick) else Modifier)
            .semantics {
                selected = active
                if (badgeLabel.isNotBlank()) stateDescription = badgeLabel
            }
            .testTag("nativeChrome.$tag"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(30.dp).graphicsLayer { scaleX = iconScale.value; scaleY = iconScale.value }, contentAlignment = Alignment.Center) {
            icon(tint)
            // The 26dp icon sits at 2..28 of this box and its strokes fill about 23dp of that: the dot's centre goes on the
            // glyph's top-right corner. The ring is the colour under it, so the dot reads as cut out of the icon.
            badge?.let { BadgeDot(it.kind, colors, pill.compositeOver(colors.bar), Modifier.align(Alignment.TopStart).offset(x = 21.dp, y = (-1).dp)) }
        }
        Text(
            label, color = tint, fontSize = 11.5.sp, lineHeight = 14.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 1.dp, start = 3.dp, end = 3.dp).testTag("nativeChrome.cellName"),
        )
    }
}

/**
 * The session list's three dots (sidebar2.css `.t2s-dot`): running = accent, pulsing; waiting for the user =
 * warning; unread = accent at 60%.
 */
@Composable
private fun BadgeDot(kind: ChromeBadge.Kind, colors: CellColors, ring: Color, modifier: Modifier) {
    val alpha = when (kind) {
        ChromeBadge.Kind.RUNNING -> {
            val pulse by rememberInfiniteTransition(label = "badge").animateFloat(
                1f, 0.4f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "badge",
            )
            pulse
        }
        ChromeBadge.Kind.UNREAD -> 0.6f
        ChromeBadge.Kind.ATTENTION -> 1f
    }
    val color = if (kind == ChromeBadge.Kind.ATTENTION) colors.warning else colors.accent
    Dot(color.copy(alpha = alpha), ring, modifier.testTag("nativeChrome.badge"))
}

/** A 7dp dot in a [ring] of the colour under it, so it reads as cut out of the icon it sits on. */
@Composable
private fun Dot(color: Color, ring: Color, modifier: Modifier) {
    Box(modifier.size(10.dp).clip(CircleShape).background(ring), contentAlignment = Alignment.Center) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color.compositeOver(ring)))
    }
}
