package com.forsion.tangu

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import kotlinx.coroutines.launch

/** Native Material sheet; Web keeps the document, plugin runtime and all domain state. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NativeModelSheet(payload: ModelPickerPayload, onCancel: () -> Unit, onDone: (Map<String, String>) -> Unit) {
    val accent = remember(payload.accent) { parseAccent(payload.accent, payload.dark) }
    val scheme = if (payload.dark) darkColorScheme(primary = accent, surface = Color(0xff202423), background = Color(0xff171b1a), onSurface = Color(0xffecf1ee), surfaceContainerHighest = Color(0xff2c3330))
    else lightColorScheme(primary = accent, surface = Color(0xfffcfdfb), background = Color(0xfff5f7f4), onSurface = Color(0xff202b26), surfaceContainerHighest = Color(0xffeef2ee))
    MaterialTheme(colorScheme = scheme) {
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = false)
        val scope = rememberCoroutineScope()
        var page by remember { mutableStateOf("model") }
        var query by remember { mutableStateOf("") }
        var values by remember { mutableStateOf(payload.initialValues()) }
        val field = payload.fields.find { it.id == page }
        // Context limits describe the model when opened. Do not apply them to another selection.
        val secondary = payload.fields.filter { it.id != "model" && it.id != "thinking" &&
            (it.id != "context" || values["model"] == payload.initialValues()["model"]) }
        LaunchedEffect(page) { query = "" }
        ModalBottomSheet(onDismissRequest = onCancel, sheetState = sheet, containerColor = scheme.surface,
            dragHandle = { BottomSheetDefaults.DragHandle(color = scheme.onSurface.copy(alpha = .18f)) },
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)) {
            // The dialog owns another Window; the Activity's icon appearance is not inherited.
            val view = LocalView.current
            SideEffect {
                (view.parent as? DialogWindowProvider)?.window?.let { window ->
                    WindowCompat.getInsetsController(window, view).apply {
                        isAppearanceLightStatusBars = !payload.dark
                        isAppearanceLightNavigationBars = !payload.dark
                    }
                }
            }
            Column(Modifier.fillMaxHeight(.91f).padding(horizontal = 22.dp)) {
                Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (page != "model") TextButton(onClick = { page = "model" }, contentPadding = PaddingValues(end = 12.dp)) { Text("‹ ${payload.labels.getValue("back")}") }
                    Text(if (page == "model") payload.title else field?.label ?: payload.labels.getValue("advanced"),
                        Modifier.weight(1f), fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                    TextButton(onClick = { onDone(values) }) { Text(payload.labels.getValue("done"), fontWeight = FontWeight.SemiBold) }
                }
                if (page == "advanced") {
                    secondary.forEach { f -> FieldLink(f.label, f.labelFor(values[f.id] ?: "")) { page = f.id } }
                } else if (field != null) {
                    if (page == "model") {
                        OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
                            placeholder = { Text(payload.labels.getValue("search"), fontSize = 15.sp) }, shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.fillMaxWidth().onFocusChanged { if (it.isFocused) scope.launch { sheet.expand() } },
                            colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = scheme.onSurface.copy(alpha = .09f), focusedBorderColor = accent))
                        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            payload.fields.find { it.id == "thinking" }?.let { f ->
                                TextButton(onClick = { page = f.id }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                                    Text("${f.label}  ·  ${f.labelFor(values[f.id] ?: "")}  ›", color = scheme.onSurfaceVariant, fontSize = 13.sp)
                                }
                            }
                            Spacer(Modifier.weight(1f))
                            if (secondary.isNotEmpty()) TextButton(onClick = { page = "advanced" }) { Text("${payload.labels.getValue("advanced")}  ›", fontSize = 13.sp) }
                        }
                    }
                    val sections = field.groups.map { g -> g.copy(options = g.options.filter {
                        query.isBlank() || "${g.label} ${it.label} ${it.value} ${it.detail}".contains(query.trim(), ignoreCase = true)
                    }) }.filter { it.options.isNotEmpty() }
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 28.dp)) {
                        if (sections.isEmpty()) item { Text(payload.labels.getValue("empty"), Modifier.padding(vertical = 28.dp), color = scheme.onSurfaceVariant) }
                        sections.forEachIndexed { sectionIndex, group ->
                            if (group.label.isNotBlank()) item(key = "heading-$sectionIndex") {
                                Text(group.label, Modifier.padding(top = 18.dp, bottom = 8.dp, start = 4.dp), color = scheme.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                            }
                            items(group.options, key = { "choice-$sectionIndex-${it.value}" }) { option ->
                                ChoiceRow(option, values[field.id] == option.value, accent) {
                                    values = values + (field.id to option.value)
                                    if (field.id == "model" && values.containsKey("context")) {
                                        values = values + ("context" to payload.initialValues().getValue("context"))
                                    }
                                    if (page != "model") page = "model"
                                }
                            }
                        }
                        if (page == "model" && payload.footnote.isNotBlank()) item {
                            Text(payload.footnote, Modifier.padding(top = 20.dp, start = 4.dp, end = 4.dp), fontSize = 12.sp, color = scheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChoiceRow(option: PickerChoice, selected: Boolean, accent: Color, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp).clip(RoundedCornerShape(14.dp))
        .background(if (selected) accent.copy(alpha = .10f) else Color.Transparent)
        .selectable(selected = selected, role = Role.RadioButton, onClick = onClick).padding(horizontal = 13.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(option.label, fontSize = 16.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal, color = colors.onSurface)
            if (option.detail.isNotBlank()) Text(option.detail, Modifier.padding(top = 4.dp), fontSize = 12.sp, color = colors.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (option.badge.isNotBlank()) Text(option.badge, Modifier.padding(start = 8.dp, end = 12.dp), fontSize = 12.sp, color = colors.onSurfaceVariant)
        Box(Modifier.size(22.dp).clip(CircleShape).background(if (selected) accent else colors.onSurface.copy(alpha = .05f)), contentAlignment = Alignment.Center) {
            if (selected) Text("✓", color = if (accent.luminanceApprox() > .5f) Color.Black else Color.White, fontSize = 13.sp)
        }
    }
}

@Composable
private fun FieldLink(label: String, value: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 18.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), fontSize = 15.sp)
        Text("$value  ›", Modifier.widthIn(max = 180.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

private fun Color.luminanceApprox() = red * .2126f + green * .7152f + blue * .0722f
private fun parseAccent(value: String, dark: Boolean): Color = try {
    val rgb = Regex("rgba?\\(\\s*(\\d+)[, ]+\\s*(\\d+)[, ]+\\s*(\\d+).*").matchEntire(value)
    if (rgb != null) Color(rgb.groupValues[1].toInt().coerceIn(0, 255), rgb.groupValues[2].toInt().coerceIn(0, 255), rgb.groupValues[3].toInt().coerceIn(0, 255))
    else Color(android.graphics.Color.parseColor(value))
} catch (_: Exception) { if (dark) Color(0xff5fa3b2) else Color(0xff4d8794) }
