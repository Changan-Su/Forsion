package com.forsion.tangu

import androidx.compose.foundation.background
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
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
 * Native top app bar. Shell mode: left drawer · title · right drawer · tab count · more.
 * Page mode: back · title · optional close. JS owns everything; buttons only report actions.
 * Test anchors: `nativeChrome.{bar,left,right,tabs,more,back,close,title}` (Compose testTags as resource-ids).
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
                        else Spacer(Modifier.width(48.dp))
                        BarTitle(state.title, fg, Modifier.weight(1f).padding(horizontal = 6.dp))
                        if (state.right) BarIconButton("right", state.labels.getValue("right"), state.icons.right, fg) { onAction("right") }
                        TabCountButton(state.tabCount, state.labels.getValue("tabs"), fg) { onAction("tabs") }
                        BarIconButton("more", state.labels.getValue("more"), state.icons.more, fg) { onAction("more") }
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
