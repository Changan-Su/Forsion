package com.forsion.tangu

import org.json.JSONArray
import org.json.JSONObject

/**
 * JSON-only boundary for the generic native sheet (`lcl/engine/nativeSheet.ts`).
 * No callbacks, URLs or credentials cross it: labels are already translated by JS, icons are path data,
 * colours are `#AARRGGBB`. Everything is size-capped and validated; one bad field rejects the whole request
 * (JS then falls back to its web UI). Answers are validated again here and once more in TS.
 */
internal data class VectorPathSpec(val d: String, val fill: Boolean, val stroke: Boolean)

internal sealed interface NativeIconSpec {
    data class Text(val text: String) : NativeIconSpec
    data class Vector(
        val minX: Float, val minY: Float, val width: Float, val height: Float,
        val strokeWidth: Float, val paths: List<VectorPathSpec>,
    ) : NativeIconSpec
}

/** Colours as ARGB ints (parsed without android.graphics so JVM unit tests run). */
internal data class SheetTheme(
    val dark: Boolean, val background: Int, val surface: Int, val text: Int, val muted: Int,
    val border: Int, val accent: Int, val onAccent: Int, val danger: Int,
)

internal data class MenuTrailingSpec(val id: String, val label: String, val icon: NativeIconSpec?)
internal data class MenuItemSpec(
    val id: String, val label: String, val detail: String, val icon: NativeIconSpec?,
    val checked: Boolean, val danger: Boolean, val disabled: Boolean,
    val children: List<MenuSectionSpec>, val trailing: MenuTrailingSpec?,
    /** Search field on the nested page this item opens (only with children). */
    val search: SearchSpec? = null,
)
/** `footer`: muted note rendered under the section's rows. */
internal data class MenuSectionSpec(val title: String, val items: List<MenuItemSpec>, val footer: String = "")
internal data class SearchSpec(val placeholder: String, val empty: String)

/** What the user chose; the plugin converts it to the JS result shape. */
internal sealed interface SheetAnswer {
    data class Pick(val id: String, val trailing: Boolean) : SheetAnswer
    data class Text(val text: String) : SheetAnswer
    data object Ok : SheetAnswer
}

internal sealed interface SheetPayload {
    val requestId: String
    val theme: SheetTheme

    /** Whether [answer] is a legal response to THIS request (unknown / disabled ids are not). */
    fun accepts(answer: SheetAnswer): Boolean

    data class Menu(
        override val requestId: String, override val theme: SheetTheme,
        val title: String, val sections: List<MenuSectionSpec>, val search: SearchSpec?, val back: String,
    ) : SheetPayload {
        fun find(id: String, list: List<MenuSectionSpec> = sections): MenuItemSpec? {
            for (s in list) for (it in s.items) {
                if (it.id == id) return it
                find(id, it.children)?.let { found -> return found }
            }
            return null
        }
        override fun accepts(answer: SheetAnswer): Boolean {
            if (answer !is SheetAnswer.Pick) return false
            val item = find(answer.id) ?: return false
            if (item.disabled) return false
            return if (answer.trailing) item.trailing != null else item.children.isEmpty()
        }
    }

    data class Prompt(
        override val requestId: String, override val theme: SheetTheme,
        val title: String, val label: String, val initial: String, val placeholder: String,
        val confirm: String, val cancel: String,
    ) : SheetPayload {
        override fun accepts(answer: SheetAnswer) = answer is SheetAnswer.Text && answer.text.length <= MAX_PROMPT_TEXT
    }

    data class Confirm(
        override val requestId: String, override val theme: SheetTheme,
        val title: String, val message: String, val confirm: String, val cancel: String, val danger: Boolean,
    ) : SheetPayload {
        override fun accepts(answer: SheetAnswer) = answer == SheetAnswer.Ok
    }

    companion object {
        const val MAX_PAYLOAD = 512_000
        const val MAX_ITEMS = 600
        const val MAX_DEPTH = 3
        const val MAX_PROMPT_TEXT = 100_000

        fun parse(json: JSONObject): SheetPayload {
            require(json.toString().length <= MAX_PAYLOAD) { "Sheet payload too large" }
            val requestId = NativeJson.str(json, "requestId", 80)
            require(requestId.isNotBlank()) { "Missing request identity" }
            val theme = NativeJson.theme(json.getJSONObject("theme"))
            return when (NativeJson.str(json, "kind", 16)) {
                "menu" -> MenuParser().parse(json, requestId, theme)
                "prompt" -> Prompt(
                    requestId, theme,
                    title = NativeJson.str(json, "title"),
                    label = NativeJson.optStr(json, "label", 1024),
                    initial = NativeJson.optStr(json, "initial", 4096),
                    placeholder = NativeJson.optStr(json, "placeholder"),
                    confirm = NativeJson.str(json, "confirm", 64),
                    cancel = NativeJson.str(json, "cancel", 64),
                )
                "confirm" -> Confirm(
                    requestId, theme,
                    title = NativeJson.str(json, "title"),
                    message = NativeJson.optStr(json, "message", 4096),
                    confirm = NativeJson.str(json, "confirm", 64),
                    cancel = NativeJson.str(json, "cancel", 64),
                    danger = NativeJson.optBool(json, "danger"),
                )
                else -> throw IllegalArgumentException("Unknown sheet kind")
            }
        }
    }
}

private class MenuParser {
    private var total = 0
    private val ids = HashSet<String>()

    fun parse(json: JSONObject, requestId: String, theme: SheetTheme): SheetPayload.Menu {
        val sections = sections(json.getJSONArray("sections"), 1)
        require(sections.any { it.items.isNotEmpty() }) { "Empty menu" }
        val search = json.optJSONObject("search")?.let(::search)
        return SheetPayload.Menu(
            requestId, theme, NativeJson.optStr(json, "title"), sections, search, NativeJson.optStr(json, "back", 64),
        )
    }

    private fun search(o: JSONObject) = SearchSpec(NativeJson.str(o, "placeholder"), NativeJson.str(o, "empty"))

    private fun sections(array: JSONArray, depth: Int): List<MenuSectionSpec> {
        require(depth <= SheetPayload.MAX_DEPTH) { "Menu too deep" }
        require(array.length() <= 50) { "Too many sections" }
        return (0 until array.length()).map { i ->
            val s = array.getJSONObject(i)
            val items = s.getJSONArray("items")
            MenuSectionSpec(
                NativeJson.optStr(s, "title"), (0 until items.length()).map { j -> item(items.getJSONObject(j), depth) },
                NativeJson.optStr(s, "footer", 1024),
            )
        }
    }

    private fun item(o: JSONObject, depth: Int): MenuItemSpec {
        total += 1
        require(total <= SheetPayload.MAX_ITEMS) { "Too many items" }
        val id = NativeJson.str(o, "id", 160)
        require(id.isNotEmpty() && ids.add(id)) { "Duplicate or empty item id" }
        val trailing = o.optJSONObject("trailing")?.let { t ->
            MenuTrailingSpec(NativeJson.str(t, "id", 160), NativeJson.str(t, "label"), t.optJSONObject("icon")?.let(NativeJson::icon))
        }
        val children = o.optJSONArray("children")?.let { sections(it, depth + 1) } ?: emptyList()
        return MenuItemSpec(
            id = id,
            label = NativeJson.str(o, "label"),
            detail = NativeJson.optStr(o, "detail", 1024),
            icon = o.optJSONObject("icon")?.let(NativeJson::icon),
            checked = NativeJson.optBool(o, "checked"),
            danger = NativeJson.optBool(o, "danger"),
            disabled = NativeJson.optBool(o, "disabled"),
            children = children,
            trailing = trailing,
            search = if (children.isNotEmpty()) o.optJSONObject("search")?.let(::search) else null,
        )
    }
}

/** Shared strict readers for the native sheet / chrome payloads. */
internal object NativeJson {
    private val HEX = Regex("^#[0-9A-Fa-f]{8}$")
    private val PATH = Regex("^[MmLlHhVvCcSsQqTtAaZz0-9eE+\\-., ]+$")

    fun str(obj: JSONObject, key: String, limit: Int = 256): String {
        val value = obj.get(key)
        require(value is String && value.length <= limit) { "Invalid $key" }
        return value
    }

    fun optStr(obj: JSONObject, key: String, limit: Int = 256): String =
        if (obj.has(key) && !obj.isNull(key)) str(obj, key, limit) else ""

    fun optBool(obj: JSONObject, key: String): Boolean {
        if (!obj.has(key) || obj.isNull(key)) return false
        val value = obj.get(key)
        require(value is Boolean) { "Invalid $key" }
        return value
    }

    fun color(obj: JSONObject, key: String): Int {
        val value = str(obj, key, 9)
        require(HEX.matches(value)) { "Invalid colour $key" }
        return java.lang.Long.parseLong(value.substring(1), 16).toInt()
    }

    fun theme(obj: JSONObject) = SheetTheme(
        dark = obj.getBoolean("dark"),
        background = color(obj, "background"), surface = color(obj, "surface"), text = color(obj, "text"),
        muted = color(obj, "muted"), border = color(obj, "border"), accent = color(obj, "accent"),
        onAccent = color(obj, "onAccent"), danger = color(obj, "danger"),
    )

    fun number(array: JSONArray, index: Int): Float {
        val value = array.get(index)
        require(value is Number) { "Invalid number" }
        val f = value.toFloat()
        require(f.isFinite()) { "Invalid number" }
        return f
    }

    fun icon(obj: JSONObject): NativeIconSpec = when (str(obj, "kind", 16)) {
        "text" -> {
            val text = str(obj, "text", 64)
            require(text.isNotBlank() && text.codePointCount(0, text.length) <= 16) { "Invalid icon text" }
            NativeIconSpec.Text(text)
        }
        "vector" -> {
            val vb = obj.getJSONArray("viewBox")
            require(vb.length() == 4) { "Invalid viewBox" }
            val box = (0 until 4).map { number(vb, it) }
            require(box[2] > 0f && box[3] > 0f) { "Invalid viewBox" }
            val strokeValue = obj.get("strokeWidth")
            require(strokeValue is Number) { "Invalid strokeWidth" }
            val stroke = strokeValue.toFloat()
            require(stroke.isFinite() && stroke >= 0f && stroke <= 16f) { "Invalid strokeWidth" }
            val paths = obj.getJSONArray("paths")
            require(paths.length() in 1..32) { "Invalid path count" }
            NativeIconSpec.Vector(box[0], box[1], box[2], box[3], stroke, (0 until paths.length()).map { i ->
                val p = paths.getJSONObject(i)
                val d = str(p, "d", 8192)
                require(PATH.matches(d)) { "Invalid path data" }
                VectorPathSpec(d, optBool(p, "fill"), optBool(p, "stroke"))
            })
        }
        else -> throw IllegalArgumentException("Unknown icon kind")
    }
}
