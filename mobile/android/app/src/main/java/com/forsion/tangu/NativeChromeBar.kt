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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.toSize
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
 * (search · right drawer · tab count · more · account avatar — the avatar only when JS sends one: first-level pages;
 * search only when the page says it has something to search). The title can carry a quieter second part (which
 * vault) and be a button (`titleTap`): it then ends in a small mark and reports `title`.
 * Page mode: back · title on the left, an optional close on the right. JS owns everything; buttons only report actions.
 * Floating (shell pages that asked for it) the view is see-through around the capsules and the WebView runs under
 * it; otherwise the strip is painted and the WebView starts below.
 * Test anchors: `nativeChrome.{bar,capLeft,capRight,left,right,tabs,more,account,back,close,title,titleSub,titleButton,search}` (resource-ids).
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
 * Room the dock takes above the system navigation inset: 6dp + the 68dp dock + 6dp. Floating, the page keeps that
 * much clear at the bottom of what it scrolls; otherwise the plugin ends the WebView above it.
 */
internal val NATIVE_SPACE_BAR_HEIGHT = 80.dp
private val DOCK_HEIGHT = 68.dp
private val DOCK_GAP = 6.dp
private val DOCK_CELL_HEIGHT = 56.dp
/** A cell is a fifth of the dock at most: with fewer Spaces the dock is as wide as they are, centred. */
private val DOCK_CELL_MAX = 84.dp
private val DOCK_ICON = 26.dp

/**
 * Bottom dock: one capsule of equal cells, each an icon over its name (2026-10-09, variant ③ of the second mock-up:
 * the user found the icon-only dock too small and wanted the names back under the icons). Every Space while they fit
 * (ChromeState.DOCK_CELLS), otherwise the pinned ones and a last cell for all of them — nothing scrolls, so every
 * cell is where it was the last time. The cell you are in is tinted; in a Space that is not in the dock that is "all".
 * Tap = switch (with a light tick when it really switches), long-press on a Space = pin to the launcher.
 * A cell may carry a badge: a dot at its icon's top-right corner (see ChromeBadge); "all" shows the most pressing
 * one of the Spaces behind it.
 * Test anchors: `nativeChrome.spaces` (the strip), `nativeChrome.dock` (the capsule), `nativeChrome.space.<id>`,
 * `nativeChrome.spacesAll`.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeSpaceBar(state: ChromeState, insets: Insets, onPlate: PlateSink, onAll: () -> Unit, onSpace: (id: String, long: Boolean) -> Unit) {
    val theme = state.theme
    val density = LocalDensity.current
    val scheme = remember(theme) { theme.colorScheme() }
    val look = remember(theme, state.frosted) { CapsuleLook(theme, state.frosted) }
    val cell = CellColors(Color(theme.accent), Color(theme.muted), Color(theme.warning), Color(theme.surface))
    val view = LocalView.current
    DisposableEffect(Unit) { onDispose { onPlate("dock", null) } }
    MaterialTheme(colorScheme = scheme) { Box(
        Modifier.fillMaxSize()
            .then(if (state.floating) Modifier else Modifier.background(Color(theme.background)))
            .semantics { testTagsAsResourceId = true }
            .testTag("nativeChrome.spaces"),
        contentAlignment = Alignment.TopCenter,
    ) {
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
                .padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            for (space in state.dock) DockCell(
                "space.${space.id}", space.label, space.active, cell, space.badge,
                onClick = {
                    // A light tick when the tap really switches Space. The system's own effect: the user's touch-feedback
                    // setting applies and no VIBRATE permission is involved. (The long-press ticks by itself.)
                    if (!space.active) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
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
            if (state.more.isNotEmpty()) DockCell(
                "spacesAll", state.allLabel, state.more.any { it.active }, cell, state.moreBadge, onClick = onAll, onLongClick = null,
            ) { tint -> state.icons.all?.let { NativeIconView(it, tint, DOCK_ICON) } }
        }
    } }
}

/** `bar` = what the dock is filled with (the ring around a badge dot is that colour). */
private class CellColors(val accent: Color, val muted: Color, val warning: Color, val bar: Color)

/** One cell of the dock: [icon] over [label]. The name is on screen for every cell, so it is also what a screen reader says. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RowScope.DockCell(
    tag: String, label: String, active: Boolean, colors: CellColors, badge: ChromeBadge?,
    onClick: () -> Unit, onLongClick: (() -> Unit)?, icon: @Composable (tint: Color) -> Unit,
) {
    val tint = if (active) colors.accent else colors.muted
    val pill = if (active) colors.accent.copy(alpha = 0.15f) else Color.Transparent
    val badgeLabel = badge?.label.orEmpty()
    Column(
        Modifier.weight(1f, fill = false).widthIn(max = DOCK_CELL_MAX).fillMaxWidth().height(DOCK_CELL_HEIGHT)
            .clip(RoundedCornerShape(18.dp)).background(pill)
            .combinedClickable(role = Role.Tab, onClick = onClick, onLongClick = onLongClick)
            .semantics {
                selected = active
                if (badgeLabel.isNotBlank()) stateDescription = badgeLabel
            }
            .testTag("nativeChrome.$tag"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) {
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
    Box(modifier.size(10.dp).clip(CircleShape).background(ring).testTag("nativeChrome.badge"), contentAlignment = Alignment.Center) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color.copy(alpha = alpha).compositeOver(ring)))
    }
}
