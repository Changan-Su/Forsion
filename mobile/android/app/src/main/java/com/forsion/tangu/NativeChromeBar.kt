package com.forsion.tangu

import android.graphics.BitmapFactory
import android.util.Base64
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.zIndex
import androidx.core.graphics.Insets

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
 * (right drawer · tab count · more · account avatar — the avatar only when JS sends one: first-level pages).
 * Page mode: back · title on the left, an optional close on the right. JS owns everything; buttons only report actions.
 * Floating (shell pages that asked for it) the view is see-through around the capsules and the WebView runs under
 * it; otherwise the strip is painted and the WebView starts below.
 * Test anchors: `nativeChrome.{bar,capLeft,capRight,left,right,tabs,more,account,back,close,title}` (resource-ids).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeChromeBar(state: ChromeState, insets: Insets, onPlate: PlateSink, onAction: (String) -> Unit) {
    val theme = state.theme
    val fg = Color(theme.text)
    val density = LocalDensity.current
    val top: Dp = with(density) { insets.top.toDp() }
    val start: Dp = with(density) { insets.left.toDp() }
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
                    if (state.left || state.title.isNotBlank()) Capsule("capLeft", look, onPlate, Modifier.weight(1f, fill = false)) {
                        if (state.left) CapsuleIconButton("left", state.labels.getValue("left"), state.icons.left, fg) { onAction("left") }
                        CapsuleTitle(state.title, fg, lead = !state.left)
                    } else Spacer(Modifier.width(0.dp)) // keeps the other capsule at the trailing edge
                    Capsule("capRight", look, onPlate, Modifier.padding(start = CAPSULE_BETWEEN)) {
                        if (state.right) CapsuleIconButton("right", state.labels.getValue("right"), state.icons.right, fg) { onAction("right") }
                        // One tab = nothing to switch between: the count would only take a slot ("New tab" is in ⋯).
                        if (state.tabCount > 1) TabCountButton(state.tabCount, state.labels.getValue("tabs"), fg) { onAction("tabs") }
                        CapsuleIconButton("more", state.labels.getValue("more"), state.icons.more, fg) { onAction("more") }
                        state.account?.let { AvatarButton(it, Color(theme.accent)) { onAction("account") } }
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

/** [lead] = nothing stands before the title in its capsule: it starts at the capsule's own text inset. */
@Composable
private fun RowScope.CapsuleTitle(title: String, color: Color, lead: Boolean) {
    if (title.isBlank()) return
    Text(
        title, Modifier.weight(1f, fill = false).padding(start = if (lead) 14.dp else 2.dp, end = 14.dp).testTag("nativeChrome.title"),
        color = color, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun CapsuleIconButton(id: String, label: String, icon: NativeIconSpec?, tint: Color, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }
            .testTag("nativeChrome.$id"),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) NativeIconView(icon, tint, NATIVE_ICON_SIZE)
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
 * Room the dock takes above the system navigation inset: 6dp + the 56dp dock + 6dp. Floating, the page keeps that
 * much clear at the bottom of what it scrolls; otherwise the plugin ends the WebView above it.
 */
internal val NATIVE_SPACE_BAR_HEIGHT = 68.dp
private val DOCK_HEIGHT = 56.dp
private val DOCK_GAP = 6.dp
private val DOCK_CELL_HEIGHT = 42.dp
private val DOCK_CELL_WIDTH = 48.dp
/** How much of a neighbour stays visible beside the active Space when the dock scrolls (also the width of its fading edges). */
private val DOCK_PEEK = 24.dp

/**
 * Bottom dock: one capsule, centred, as wide as its Spaces (the screen's width at most). A Space is its icon; the one
 * you are in also carries its name, on an accent-tinted pill (2026-10-09, variant B of the mock-up). The first one
 * (Home) never scrolls; the rest scroll beside it when they do not fit, fading at the edge that has more.
 * Tap = switch (with a light tick when it really switches), long-press = pin to the launcher.
 * A Space may carry a badge: a dot at its icon's top-right corner (see ChromeBadge).
 * Test anchors: `nativeChrome.spaces` (the strip), `nativeChrome.dock` (the capsule), `nativeChrome.space.<id>`.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeSpaceBar(state: ChromeState, insets: Insets, onPlate: PlateSink, onSpace: (id: String, long: Boolean) -> Unit) {
    val theme = state.theme
    val density = LocalDensity.current
    val scheme = remember(theme) { theme.colorScheme() }
    val look = remember(theme, state.frosted) { CapsuleLook(theme, state.frosted) }
    val cell = CellColors(Color(theme.accent), Color(theme.muted), Color(theme.warning), Color(theme.surface))
    DisposableEffect(Unit) { onDispose { onPlate("dock", null) } }
    MaterialTheme(colorScheme = scheme) { Box(
        Modifier.fillMaxSize()
            .then(if (state.floating) Modifier else Modifier.background(Color(theme.background)))
            .semantics { testTagsAsResourceId = true }
            .testTag("nativeChrome.spaces"),
        contentAlignment = Alignment.TopCenter,
    ) {
        val scrollState = rememberScrollState()
        var lane by remember { mutableStateOf(0) } // the scrolling part's width, see SpaceCell
        Row(
            Modifier.padding(
                top = DOCK_GAP,
                start = with(density) { insets.left.toDp() } + CAPSULE_SIDE, end = with(density) { insets.right.toDp() } + CAPSULE_SIDE,
            )
                .height(DOCK_HEIGHT)
                .onGloballyPositioned { onPlate("dock", Rect(it.positionInWindow(), it.size.toSize())) }
                .testTag("nativeChrome.dock")
                .pointerInput(Unit) {} // as the top capsules: the dock keeps its touches, the strip beside it does not
                .clip(CircleShape).background(look.fill).border(1.dp, look.edge, CircleShape)
                .padding(horizontal = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The first destination never scrolls: on a later Space it used to slide off the left edge — "the Home page
            // is gone" (2026-10-04); the user asked for Home to be pinned (2026-10-05).
            // ponytail: pinned by position, not by id — Home is whatever JS lists first (a Space re-enabled at runtime
            // is appended). Send a flag from JS if "first" ever stops meaning Home.
            // … and it is the upper layer: a neighbour that slid under it still reports part of its touch target
            // there (a scroll container's clip is relaxed for small targets), so to a screen reader the right half of
            // Home was "Tangu" and Home itself a sliver. On top, Home keeps its whole cell — as it does for a finger.
            for (space in state.spaces.take(1)) SpaceCell(space, cell, onSpace, Modifier.zIndex(1f))
            Row(
                Modifier.weight(1f, fill = false).onSizeChanged { lane = it.width }
                    .fadingEdges(scrollState, with(density) { DOCK_PEEK.toPx() }).horizontalScroll(scrollState),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for (space in state.spaces.drop(1)) SpaceCell(space, cell, onSpace, lane = lane)
            }
        }
    } }
}

/** Content fades out towards an edge it can still scroll past (nothing is drawn over it: the dock's fill is see-through). */
private fun Modifier.fadingEdges(state: ScrollState, width: Float): Modifier = this
    .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
    .drawWithContent {
        drawContent()
        if (state.canScrollBackward) drawRect(Brush.horizontalGradient(listOf(Color.Transparent, Color.Black), 0f, width), blendMode = BlendMode.DstIn)
        if (state.canScrollForward) drawRect(Brush.horizontalGradient(listOf(Color.Black, Color.Transparent), size.width - width, size.width), blendMode = BlendMode.DstIn)
    }

/** `bar` = what the dock is filled with (the ring around a badge dot is that colour). */
private class CellColors(val accent: Color, val muted: Color, val warning: Color, val bar: Color)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SpaceCell(space: ChromeSpace, colors: CellColors, onSpace: (id: String, long: Boolean) -> Unit, modifier: Modifier = Modifier, lane: Int = 0) {
    val accent = colors.accent
    val tint = if (space.active) accent else colors.muted
    val pill = if (space.active) accent.copy(alpha = 0.16f) else Color.Transparent
    val view = LocalView.current
    val badgeLabel = space.badge?.label.orEmpty()
    // The dock leaves composition (page mode, a Space's detail level) and comes back unscrolled, and a Space can be
    // switched to from elsewhere: the active one is brought back into view with a bit of its neighbours, otherwise
    // "nothing looks selected" when it sits past the last visible slot. Again when the lane it scrolls in changes
    // width: after a rotation the cell is the size it was, in a lane that no longer shows it.
    val requester = remember { BringIntoViewRequester() }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val peek = with(LocalDensity.current) { DOCK_PEEK.toPx() }
    LaunchedEffect(space.active, size, lane) {
        if (space.active && size != IntSize.Zero) requester.bringIntoView(Rect(-peek, 0f, size.width + peek, size.height.toFloat()))
    }
    Row(
        modifier.height(DOCK_CELL_HEIGHT)
            .then(if (space.active) Modifier else Modifier.width(DOCK_CELL_WIDTH))
            .bringIntoViewRequester(requester).onSizeChanged { size = it }
            .clip(RoundedCornerShape(21.dp)).background(pill)
            .combinedClickable(
                role = Role.Tab,
                onClick = {
                    // A light tick when the tap really switches Space. The system's own effect: the user's touch-feedback
                    // setting applies and no VIBRATE permission is involved. (The long-press ticks by itself.)
                    if (!space.active) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                    onSpace(space.id, false)
                },
                onLongClick = { onSpace(space.id, true) },
            )
            .semantics {
                selected = space.active
                if (!space.active) contentDescription = space.label // only the active Space shows its name
                if (badgeLabel.isNotBlank()) stateDescription = badgeLabel
            }
            .testTag("nativeChrome.space.${space.id}")
            .padding(start = if (space.active) 11.dp else 0.dp, end = if (space.active) 15.dp else 0.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
            // A Space with a picture of its own (a plugin's icon) shows it, in its own colours like the desktop ribbon:
            // the pill and the name carry the selection. Otherwise — or while the picture is not there — its line icon.
            val picture = rememberPng(space.png)
            if (picture != null) {
                Image(
                    picture, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.size(NATIVE_ICON_SIZE).clip(RoundedCornerShape(6.dp)).testTag("nativeChrome.spacePicture"),
                )
            } else if (space.icon != null) NativeIconView(space.icon, tint, NATIVE_ICON_SIZE)
            // The 22dp icon sits at 3..25 of this box and its strokes fill about 20dp of that: the dot's centre goes on the
            // glyph's top-right corner. The ring is the colour under it, so the dot reads as cut out of the icon.
            space.badge?.let { BadgeDot(it.kind, colors, pill.compositeOver(colors.bar), Modifier.align(Alignment.TopStart).offset(x = 19.dp, y = 0.dp)) }
        }
        if (space.active) {
            Spacer(Modifier.width(6.dp))
            Text(
                space.label, color = accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 132.dp),
            )
        }
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
    Box(modifier.size(10.dp).clip(CircleShape).background(ring).testTag("nativeChrome.badge"), contentAlignment = Alignment.Center) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color.copy(alpha = alpha).compositeOver(ring)))
    }
}
