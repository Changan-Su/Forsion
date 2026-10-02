package com.forsion.tangu

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import kotlinx.coroutines.launch

/**
 * Material 3 bottom sheets for the generic native sheet request. Presentation only: answers go back to JS,
 * which owns all state. System back / scrim / swipe = cancel (back first pops a nested menu page).
 * Test anchors are Compose testTags exposed as resource-ids (`nativeSheet.*`), never visible copy.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
internal fun NativeSheetHost(payload: SheetPayload, onAnswer: (SheetAnswer?) -> Unit, onGone: () -> Unit) {
    val theme = payload.theme
    val scheme = remember(theme) { theme.colorScheme() }
    MaterialTheme(colorScheme = scheme) {
        // Menus open half-height (the user can drag up); prompts / confirmations are short and open fully.
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = payload !is SheetPayload.Menu)
        val scope = rememberCoroutineScope()
        var answered by remember { mutableStateOf(false) }
        // Report first, then animate out: the action runs while the sheet slides away.
        val answer: (SheetAnswer?) -> Unit = { value ->
            if (!answered) {
                answered = true
                onAnswer(value)
                scope.launch { sheet.hide() }.invokeOnCompletion { onGone() }
            }
        }
        ModalBottomSheet(
            onDismissRequest = { if (!answered) { answered = true; onAnswer(null) }; onGone() },
            sheetState = sheet,
            containerColor = scheme.surface,
            contentColor = scheme.onSurface,
            dragHandle = { BottomSheetDefaults.DragHandle(color = scheme.onSurfaceVariant.copy(alpha = .35f)) },
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        ) {
            // The sheet lives in its own dialog window: system-bar icon contrast is not inherited from the Activity.
            val view = LocalView.current
            SideEffect {
                (view.parent as? DialogWindowProvider)?.window?.let { window ->
                    WindowCompat.getInsetsController(window, view).apply {
                        isAppearanceLightStatusBars = !theme.dark
                        isAppearanceLightNavigationBars = !theme.dark
                    }
                }
            }
            Box(Modifier.semantics { testTagsAsResourceId = true }.testTag("nativeSheet.sheet")) {
                when (payload) {
                    is SheetPayload.Menu -> MenuContent(payload, sheet) { id, trailing -> answer(SheetAnswer.Pick(id, trailing)) }
                    is SheetPayload.Prompt -> PromptContent(payload, onCancel = { answer(null) }) { answer(SheetAnswer.Text(it)) }
                    is SheetPayload.Confirm -> ConfirmContent(payload, onCancel = { answer(null) }) { answer(SheetAnswer.Ok) }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MenuContent(p: SheetPayload.Menu, sheet: SheetState, onPick: (String, Boolean) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    var stack by remember { mutableStateOf(listOf<MenuItemSpec>()) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(stack.size) { query = "" }
    BackHandler(enabled = stack.isNotEmpty()) { stack = stack.dropLast(1) }
    val page = stack.lastOrNull()
    val title = page?.label ?: p.title
    val sections = page?.children ?: p.sections
    val q = query.trim()
    val shown = if (q.isEmpty()) sections else sections.map { s ->
        s.copy(items = s.items.filter { it.label.contains(q, ignoreCase = true) || it.detail.contains(q, ignoreCase = true) })
    }.filter { it.items.isNotEmpty() }
    val tall = p.search != null
    Column(Modifier.fillMaxWidth().then(if (tall) Modifier.fillMaxHeight(.92f) else Modifier)) {
        if (page != null || title.isNotBlank()) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = if (page != null) 8.dp else 24.dp, end = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                if (page != null) {
                    IconButton(onClick = { stack = stack.dropLast(1) }, modifier = Modifier.size(48.dp).testTag("nativeSheet.back").semantics { contentDescription = p.back }) {
                        NativeIconView(BuiltinIcons.chevronLeft, colors.onSurface, NATIVE_ICON_SIZE)
                    }
                }
                Text(title, Modifier.weight(1f).testTag("nativeSheet.title"), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (p.search != null) {
            OutlinedTextField(
                value = query, onValueChange = { query = it }, singleLine = true,
                placeholder = { Text(p.search.placeholder, fontSize = 15.sp) },
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = colors.outline, focusedBorderColor = colors.primary),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("nativeSheet.search")
                    .onFocusChanged { if (it.isFocused) scope.launch { sheet.expand() } },
            )
        }
        LazyColumn(
            Modifier.fillMaxWidth().then(if (tall) Modifier.weight(1f) else Modifier.weight(1f, fill = false)),
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 24.dp),
        ) {
            if (shown.isEmpty() && p.search != null) item(key = "empty") {
                Text(p.search.empty, Modifier.fillMaxWidth().padding(vertical = 28.dp, horizontal = 12.dp).testTag("nativeSheet.empty"), color = colors.onSurfaceVariant)
            }
            shown.forEachIndexed { index, section ->
                if (index > 0) item(key = "divider-$index") {
                    Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).heightIn(min = 1.dp).background(colors.outline))
                }
                if (section.title.isNotBlank()) item(key = "section-$index") {
                    Text(section.title, Modifier.padding(start = 12.dp, top = 10.dp, bottom = 6.dp), color = colors.onSurfaceVariant, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                }
                items(section.items, key = { "item-${it.id}" }) { item ->
                    MenuRow(item, onClick = {
                        if (item.children.isNotEmpty()) stack = stack + item else onPick(item.id, false)
                    }, onTrailing = { onPick(item.id, true) })
                }
            }
        }
    }
}

@Composable
private fun MenuRow(item: MenuItemSpec, onClick: () -> Unit, onTrailing: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val enabled = !item.disabled
    val base = if (item.danger) colors.error else colors.onSurface
    val tint = if (enabled) base else base.copy(alpha = .38f)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(vertical = 1.dp).clip(RoundedCornerShape(14.dp))
            .background(if (item.checked) colors.primary.copy(alpha = .12f) else Color.Transparent)
            .semantics { selected = item.checked }
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .testTag("nativeSheet.item.${item.id}")
            .padding(start = 14.dp, end = if (item.trailing != null) 2.dp else 14.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (item.icon != null) {
            NativeIconView(item.icon, tint, NATIVE_ICON_SIZE)
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(item.label, color = tint, fontSize = 16.sp, fontWeight = if (item.checked) FontWeight.SemiBold else FontWeight.Normal, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (item.detail.isNotBlank()) {
                Text(item.detail, Modifier.padding(top = 2.dp), color = colors.onSurfaceVariant.copy(alpha = if (enabled) 1f else .5f), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (item.checked) NativeIconView(BuiltinIcons.check, colors.primary, 20.dp, Modifier.padding(start = 8.dp))
        if (item.children.isNotEmpty()) NativeIconView(BuiltinIcons.chevronRight, colors.onSurfaceVariant, 20.dp, Modifier.padding(start = 8.dp))
        item.trailing?.let { t ->
            IconButton(
                onClick = onTrailing, enabled = enabled,
                modifier = Modifier.size(48.dp).testTag("nativeSheet.trailing.${item.id}").semantics { contentDescription = t.label },
            ) {
                NativeIconView(t.icon ?: BuiltinIcons.close, colors.onSurfaceVariant, 20.dp)
            }
        }
    }
}

@Composable
private fun PromptContent(p: SheetPayload.Prompt, onCancel: () -> Unit, onConfirm: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    var value by remember { mutableStateOf(TextFieldValue(p.initial, selection = TextRange(p.initial.length))) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { focus.requestFocus(); keyboard?.show() }
    Column(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 20.dp)) {
        Text(p.title, Modifier.testTag("nativeSheet.title"), fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        if (p.label.isNotBlank()) Text(p.label, Modifier.padding(top = 6.dp), color = colors.onSurfaceVariant, fontSize = 14.sp)
        OutlinedTextField(
            value = value, onValueChange = { value = it }, singleLine = true,
            placeholder = if (p.placeholder.isNotBlank()) ({ Text(p.placeholder) }) else null,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onConfirm(value.text) }),
            shape = RoundedCornerShape(14.dp),
            colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = colors.outline, focusedBorderColor = colors.primary),
            modifier = Modifier.fillMaxWidth().padding(top = 16.dp).focusRequester(focus).testTag("nativeSheet.prompt.field"),
        )
        SheetActions(cancel = p.cancel, confirm = p.confirm, danger = false, onCancel = onCancel, onConfirm = { onConfirm(value.text) }, tagPrefix = "nativeSheet.prompt")
    }
}

@Composable
private fun ConfirmContent(p: SheetPayload.Confirm, onCancel: () -> Unit, onConfirm: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 20.dp)) {
        Text(p.title, Modifier.testTag("nativeSheet.title"), fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        if (p.message.isNotBlank()) Text(p.message, Modifier.padding(top = 8.dp), color = colors.onSurfaceVariant, fontSize = 15.sp)
        SheetActions(cancel = p.cancel, confirm = p.confirm, danger = p.danger, onCancel = onCancel, onConfirm = onConfirm, tagPrefix = "nativeSheet.confirm")
    }
}

@Composable
private fun SheetActions(cancel: String, confirm: String, danger: Boolean, onCancel: () -> Unit, onConfirm: () -> Unit, tagPrefix: String) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = 48.dp).testTag("$tagPrefix.cancel")) {
            Text(cancel, fontSize = 15.sp, color = colors.onSurface)
        }
        Spacer(Modifier.width(8.dp))
        Button(
            onClick = onConfirm,
            modifier = Modifier.heightIn(min = 48.dp).testTag("$tagPrefix.ok"),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (danger) colors.error else colors.primary,
                contentColor = if (danger) Color.White else colors.onPrimary,
            ),
        ) { Text(confirm, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
    }
}
