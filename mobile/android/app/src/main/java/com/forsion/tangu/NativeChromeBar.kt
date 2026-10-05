package com.forsion.tangu

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.Insets

/** Height of the bar's own row (below the status-bar inset). The plugin lays the WebView out under it. */
internal val NATIVE_CHROME_HEIGHT = 56.dp

/**
 * Native top app bar. Shell mode: left drawer · title · right drawer · tab count · more · account avatar
 * (the avatar only when JS sends one: first-level pages). Page mode: back · title · optional close.
 * JS owns everything; buttons only report actions.
 * Test anchors: `nativeChrome.{bar,left,right,tabs,more,account,back,close,title}` (Compose testTags as resource-ids).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeChromeBar(state: ChromeState, insets: Insets, onAction: (String) -> Unit) {
    val theme = state.theme
    val bg = Color(theme.background)
    val fg = Color(theme.text)
    val density = LocalDensity.current
    val top: Dp = with(density) { insets.top.toDp() }
    val start: Dp = with(density) { insets.left.toDp() }
    val end: Dp = with(density) { insets.right.toDp() }
    val scheme = remember(theme) { theme.colorScheme() }
    MaterialTheme(colorScheme = scheme) { Column(
        Modifier.fillMaxSize().background(bg)
            .semantics { testTagsAsResourceId = true }
            .testTag("nativeChrome.bar"),
    ) {
        Spacer(Modifier.height(top))
        Box(Modifier.fillMaxWidth().height(NATIVE_CHROME_HEIGHT)) {
            Row(
                Modifier.fillMaxSize().padding(start = start + 4.dp, end = end + 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                when (state.mode) {
                    ChromeState.Mode.SHELL -> {
                        if (state.left) BarIconButton("left", state.labels.getValue("left"), state.icons.left, fg) { onAction("left") }
                        else Spacer(Modifier.width(10.dp)) // a first-level page (Space list, Home): the title starts at the edge
                        BarTitle(state.title, fg, Modifier.weight(1f).padding(horizontal = 6.dp))
                        if (state.right) BarIconButton("right", state.labels.getValue("right"), state.icons.right, fg) { onAction("right") }
                        TabCountButton(state.tabCount, state.labels.getValue("tabs"), fg) { onAction("tabs") }
                        BarIconButton("more", state.labels.getValue("more"), state.icons.more, fg) { onAction("more") }
                        state.account?.let { AvatarButton(it, Color(theme.accent)) { onAction("account") } }
                    }
                    ChromeState.Mode.PAGE -> {
                        BarIconButton("back", state.back, state.icons.back ?: BuiltinIcons.chevronLeft, fg) { onAction("back") }
                        BarTitle(state.title, fg, Modifier.weight(1f).padding(start = 6.dp, end = if (state.close.isNotBlank()) 6.dp else 12.dp))
                        if (state.close.isNotBlank()) {
                            BarIconButton("close", state.close, state.icons.close ?: BuiltinIcons.close, fg) { onAction("close") }
                        }
                    }
                    ChromeState.Mode.HIDDEN -> Unit
                }
            }
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(1.dp).background(Color(theme.border)))
        }
    } }
}

@Composable
private fun BarTitle(title: String, color: Color, modifier: Modifier) {
    Text(
        title, modifier.testTag("nativeChrome.title"), color = color, fontSize = 17.sp,
        fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun BarIconButton(id: String, label: String, icon: NativeIconSpec?, tint: Color, onClick: () -> Unit) {
    Box(
        Modifier.size(48.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }
            .testTag("nativeChrome.$id"),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) NativeIconView(icon, tint, NATIVE_ICON_SIZE)
    }
}

/** Account avatar: the picture when there is one, else the initial / person glyph on an accent-tinted disc. */
@Composable
private fun AvatarButton(account: ChromeAccount, accent: Color, onClick: () -> Unit) {
    val picture = remember(account.png) {
        if (account.png.isEmpty()) null else try {
            val bytes = Base64.decode(account.png, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        } catch (_: Exception) { null }
    }
    Box(
        Modifier.padding(end = 3.dp).size(48.dp).clip(CircleShape) // 3dp: the disc ends where a 24dp bar icon would (16dp from the edge)
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
        Modifier.size(48.dp).clip(CircleShape)
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

/** Height of the bottom navigation row (above the system navigation inset). */
internal val NATIVE_SPACE_BAR_HEIGHT = 64.dp

/**
 * Bottom navigation bar: one destination per Space (icon in a pill + label). Up to five share the width. With more,
 * the first one (Home) stays put and the rest scroll beside it, the next one peeking in (1 fixed + 4.5 scrolling per
 * screen). Tap = switch, long-press = pin to the launcher.
 * Test anchors: `nativeChrome.spaces`, `nativeChrome.space.<id>`.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun NativeSpaceBar(state: ChromeState, insets: Insets, onSpace: (id: String, long: Boolean) -> Unit) {
    val theme = state.theme
    val density = LocalDensity.current
    val scheme = remember(theme) { theme.colorScheme() }
    val accent = Color(theme.accent)
    val muted = Color(theme.muted)
    MaterialTheme(colorScheme = scheme) { Column(
        Modifier.fillMaxSize().background(Color(theme.background))
            .semantics { testTagsAsResourceId = true }
            .testTag("nativeChrome.spaces"),
    ) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Color(theme.border)))
        BoxWithConstraints(
            Modifier.fillMaxWidth().height(NATIVE_SPACE_BAR_HEIGHT - 1.dp)
                .padding(start = with(density) { insets.left.toDp() }, end = with(density) { insets.right.toDp() }),
        ) {
            val scroll = state.spaces.size > 5
            val itemWidth = if (scroll) maxWidth / 5.5f else maxWidth / state.spaces.size
            // More than five: the first destination never scrolls. On the sixth Space or later it used to slide off the
            // left edge — "the Home page is gone" (2026-10-04); the user asked for Home to be pinned (2026-10-05).
            // ponytail: pinned by position, not by id — Home is whatever JS lists first (a Space re-enabled at runtime
            // is appended). Send a flag from JS if "first" ever stops meaning Home.
            val pinned = if (scroll) state.spaces.take(1) else emptyList()
            val rest = if (scroll) state.spaces.drop(1) else state.spaces
            val scrollState = rememberScrollState()
            // The bar leaves composition (page mode, a Space's detail level) and comes back at offset 0: bring the
            // active Space back into view, otherwise "nothing looks selected" when it sits past the last visible slot.
            // As little as possible from the start, not centred (the first scrolling Spaces stay where they were), plus
            // half a cell while another one follows: the next Space keeps peeking in at the end, and the 4.5-cell
            // viewport then starts on a cell boundary instead of cutting one in half beside the pinned cell.
            val activeIndex = rest.indexOfFirst { it.active }
            val itemPx = with(density) { itemWidth.toPx() }
            val viewportPx = with(density) { (maxWidth - itemWidth * pinned.size).toPx() }
            LaunchedEffect(activeIndex, scroll, itemPx, viewportPx, rest.size) {
                if (scroll && activeIndex >= 0) {
                    val peek = if (activeIndex < rest.lastIndex) itemPx / 2 else 0f
                    // floor, not ceil: with the half-cell peek the target sits on a cell boundary, and a pixel past it
                    // would leave a sliver of the previous cell's far edge out of view instead of the cell itself
                    scrollState.scrollTo(((activeIndex + 1) * itemPx + peek - viewportPx).toInt().coerceAtLeast(0))
                }
            }
            Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                for (space in pinned) SpaceCell(space, itemWidth, accent, muted, onSpace)
                // While the rest is scrolled, a hairline marks the edge the cells slide under (at rest the bar looks like a
                // plain five-slot bar). Drawn over the viewport, not laid out: the scroll maths above stays exact.
                val edge = Color(theme.border)
                Row(
                    if (scroll) Modifier.weight(1f).drawWithContent {
                        drawContent()
                        if (scrollState.value > 0) {
                            val inset = 14.dp.toPx()
                            drawLine(edge, Offset(0f, inset), Offset(0f, size.height - inset), strokeWidth = 1.dp.toPx())
                        }
                    }.horizontalScroll(scrollState) else Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    for (space in rest) SpaceCell(space, itemWidth, accent, muted, onSpace)
                }
            }
        }
    } }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SpaceCell(space: ChromeSpace, width: Dp, accent: Color, muted: Color, onSpace: (id: String, long: Boolean) -> Unit) {
    val tint = if (space.active) accent else muted
    Column(
        Modifier.width(width).height(NATIVE_SPACE_BAR_HEIGHT - 1.dp)
            .combinedClickable(
                role = Role.Tab,
                onClick = { onSpace(space.id, false) },
                onLongClick = { onSpace(space.id, true) },
            )
            .semantics { selected = space.active }
            .testTag("nativeChrome.space.${space.id}"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier.width(56.dp).height(30.dp).clip(RoundedCornerShape(15.dp))
                .background(if (space.active) accent.copy(alpha = 0.16f) else Color.Transparent),
            contentAlignment = Alignment.Center,
        ) {
            if (space.icon != null) NativeIconView(space.icon, tint, NATIVE_ICON_SIZE)
        }
        Spacer(Modifier.height(3.dp))
        Text(
            space.label, color = tint, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            fontWeight = if (space.active) FontWeight.SemiBold else FontWeight.Normal,
            modifier = Modifier.padding(horizontal = 2.dp),
        )
    }
}
