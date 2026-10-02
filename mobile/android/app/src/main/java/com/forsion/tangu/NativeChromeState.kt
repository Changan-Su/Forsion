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
) {
    enum class Mode { SHELL, PAGE, HIDDEN }

    val visible get() = mode != Mode.HIDDEN

    companion object {
        val ACTIONS = setOf("left", "right", "tabs", "more", "back", "close")

        fun parse(json: JSONObject): ChromeState {
            require(json.toString().length <= 64_000) { "Chrome state too large" }
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
                        back = "", theme = theme, icons = icons,
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
