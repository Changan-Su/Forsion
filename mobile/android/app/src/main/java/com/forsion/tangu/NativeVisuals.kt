package com.forsion.tangu

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.min

/** Shared look for native surfaces: colours come from the live web theme (see readNativeTheme in JS). */
internal fun SheetTheme.colorScheme(): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val surfaceColor = Color(surface)
    return base.copy(
        primary = Color(accent), onPrimary = Color(onAccent),
        background = Color(background), onBackground = Color(text),
        surface = surfaceColor, onSurface = Color(text), onSurfaceVariant = Color(muted),
        surfaceContainerLowest = surfaceColor, surfaceContainerLow = surfaceColor, surfaceContainer = surfaceColor,
        surfaceContainerHigh = surfaceColor, surfaceContainerHighest = surfaceColor,
        outline = Color(border), outlineVariant = Color(border), error = Color(danger),
    )
}

/** Built-in glyphs (lucide geometry, 24 viewBox) for chrome that JS does not send: check / chevrons. */
internal object BuiltinIcons {
    private fun lucide(vararg d: String) = NativeIconSpec.Vector(0f, 0f, 24f, 24f, 2f, d.map { VectorPathSpec(it, fill = false, stroke = true) })
    val check = lucide("M20 6 9 17l-5-5")
    val chevronLeft = lucide("m15 18-6-6 6-6")
    val chevronRight = lucide("m9 18 6-6-6-6")
    val close = lucide("M18 6 6 18", "m6 6 12 12")
}

/** Draws a JS-serialized icon: vector paths scaled from their viewBox, or an emoji / short text. */
@Composable
internal fun NativeIconView(icon: NativeIconSpec, tint: Color, size: Dp, modifier: Modifier = Modifier) {
    when (icon) {
        is NativeIconSpec.Text -> Box(modifier.size(size), contentAlignment = Alignment.Center) {
            val px = with(LocalDensity.current) { (size * 0.86f).toSp() }
            Text(icon.text, fontSize = if (px.value > 0f) px else 16.sp, color = tint, maxLines = 1)
        }
        is NativeIconSpec.Vector -> {
            val parsed: List<Pair<Path, VectorPathSpec>> = remember(icon) {
                icon.paths.mapNotNull { spec ->
                    try { PathParser().parsePathString(spec.d).toPath() to spec } catch (_: Exception) { null }
                }
            }
            Canvas(modifier.size(size)) {
                val s = min(this.size.width / icon.width, this.size.height / icon.height)
                val dx = (this.size.width - icon.width * s) / 2f
                val dy = (this.size.height - icon.height * s) / 2f
                translate(dx - icon.minX * s, dy - icon.minY * s) {
                    scale(s, s, pivot = Offset.Zero) {
                        for ((path, spec) in parsed) {
                            if (spec.fill) drawPath(path, tint)
                            if (spec.stroke && icon.strokeWidth > 0f) {
                                drawPath(path, tint, style = Stroke(width = icon.strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round))
                            }
                        }
                    }
                }
            }
        }
    }
}

internal val NATIVE_ICON_SIZE = 22.dp
