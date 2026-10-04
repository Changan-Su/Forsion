package com.forsion.tangu

import org.json.JSONObject

/**
 * State pushed by `mobile/src/nativeChrome.ts` (effective state of `lcl/engine/nativeChrome.ts` + live theme +
 * serialized icons). JSON only, size-capped, strictly validated; labels are translated by JS.
 */
internal data class ChromeIcons(
    val left: NativeIconSpec?, val right: NativeIconSpec?, val more: NativeIconSpec?, val back: NativeIconSpec?,
    val close: NativeIconSpec? = null,
)

/** One destination of the bottom navigation bar (a Space). Label translated by JS; icon serialized by JS. */
internal data class ChromeSpace(val id: String, val label: String, val active: Boolean, val icon: NativeIconSpec?)

/**
 * Account avatar at the trailing end of the bar (first-level pages only; JS decides). `png` = the picture as
 * base64, already cropped square and downscaled by JS; blank or undecodable = draw `icon` (initial / person glyph).
 */
internal data class ChromeAccount(val label: String, val icon: NativeIconSpec?, val png: String)

internal data class ChromeState(
    val mode: Mode,
    val title: String,
    val left: Boolean,
    val right: Boolean,
    val tabCount: Int,
    val labels: Map<String, String>,
    val back: String,
    val theme: SheetTheme,
    val icons: ChromeIcons,
    /** Page mode: label of the optional trailing close (×) action; blank = no close button. */
    val close: String = "",
    /** Shell mode: Spaces for the bottom navigation bar; fewer than two = no bar. */
    val spaces: List<ChromeSpace> = emptyList(),
    val account: ChromeAccount? = null,
) {
    enum class Mode { SHELL, PAGE, HIDDEN }

    val visible get() = mode != Mode.HIDDEN
    /** The bottom bar belongs to the shell only: pages (settings, market) and covering overlays have none. */
    val spaceBar get() = mode == Mode.SHELL && spaces.size > 1

    companion object {
        val ACTIONS = setOf("left", "right", "tabs", "more", "back", "close", "account")
        const val MAX_SPACES = 64 // = MAX_SPACES in mobile/src/nativeChrome.ts, which trims the list before sending
        const val MAX_AVATAR_CHARS = 131_072 // = MAX_AVATAR_CHARS in mobile/src/nativeChrome.ts (a 96px PNG stays far below)
        private val BASE64 = Regex("^[A-Za-z0-9+/]+={0,2}$")

        private fun account(json: JSONObject): ChromeAccount? {
            val o = json.optJSONObject("account") ?: return null
            val png = NativeJson.optStr(o, "png", MAX_AVATAR_CHARS)
            require(png.isEmpty() || BASE64.matches(png)) { "Invalid avatar" }
            return ChromeAccount(NativeJson.str(o, "label", 128), o.optJSONObject("icon")?.let(NativeJson::icon), png)
        }

        private fun spaces(json: JSONObject): List<ChromeSpace> {
            val array = json.optJSONArray("spaces") ?: return emptyList()
            require(array.length() <= MAX_SPACES) { "Too many spaces" }
            return (0 until array.length()).map { i ->
                val o = array.getJSONObject(i)
                ChromeSpace(
                    NativeJson.str(o, "id", 128), NativeJson.str(o, "label", 128), NativeJson.optBool(o, "active"),
                    o.optJSONObject("icon")?.let(NativeJson::icon),
                )
            }.also { list -> require(list.map { it.id }.toSet().size == list.size) { "Duplicate space id" } }
        }

        fun parse(json: JSONObject): ChromeState {
            require(json.toString().length <= 512_000) { "Chrome state too large" } // up to MAX_SPACES serialized icons
            val mode = when (NativeJson.str(json, "mode", 16)) {
                "shell" -> Mode.SHELL
                "page" -> Mode.PAGE
                "hidden" -> Mode.HIDDEN
                else -> throw IllegalArgumentException("Unknown chrome mode")
            }
            val theme = NativeJson.theme(json.getJSONObject("theme"))
            val iconsJson = json.optJSONObject("icons")
            fun icon(key: String) = iconsJson?.optJSONObject(key)?.let(NativeJson::icon)
            val icons = ChromeIcons(icon("left"), icon("right"), icon("more"), icon("back"), icon("close"))
            return when (mode) {
                Mode.SHELL -> {
                    val labels = json.getJSONObject("labels")
                    val count = json.get("tabCount")
                    require(count is Number && count.toInt() in 0..9999) { "Invalid tabCount" }
                    ChromeState(
                        mode, NativeJson.str(json, "title", 512),
                        left = NativeJson.optBool(json, "left"), right = NativeJson.optBool(json, "right"),
                        tabCount = count.toInt(),
                        labels = listOf("left", "right", "tabs", "more").associateWith { NativeJson.str(labels, it, 128) },
                        back = "", theme = theme, icons = icons, spaces = spaces(json), account = account(json),
                    )
                }
                Mode.PAGE -> ChromeState(
                    mode, NativeJson.str(json, "title", 512), left = false, right = false, tabCount = 0,
                    labels = emptyMap(), back = NativeJson.str(json, "back", 128), theme = theme, icons = icons,
                    close = NativeJson.optStr(json, "close", 128),
                )
                Mode.HIDDEN -> ChromeState(mode, "", false, false, 0, emptyMap(), "", theme, icons)
            }
        }
    }
}
