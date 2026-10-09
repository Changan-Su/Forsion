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

/**
 * Dot on a Space's icon: something in that Space wants a look. Same three kinds as the dots of the session list
 * (running / waiting for the user / unread); JS decides which one applies. `label` (translated by JS) is what a
 * screen reader announces — the dot itself says nothing.
 */
internal data class ChromeBadge(val kind: Kind, val label: String) { enum class Kind { RUNNING, ATTENTION, UNREAD } }

/**
 * One destination of the bottom navigation bar (a Space). Label translated by JS; icon serialized by JS.
 * `png` = the Space's own picture (a plugin Space's `iconFile`) as base64, downscaled by JS; blank = draw `icon`.
 * Vetted like the avatar's (see usablePng): an unusable one is dropped and the line icon is drawn instead.
 */
internal data class ChromeSpace(
    val id: String, val label: String, val active: Boolean, val icon: NativeIconSpec?, val badge: ChromeBadge? = null,
    val png: String = "",
)

/**
 * Account avatar at the trailing end of the bar (first-level pages only; JS decides). `png` = the picture as
 * base64, already cropped square and downscaled by JS; blank = draw `icon` (initial / person glyph). An unusable
 * picture (not base64, not a PNG, oversized, a canvas larger than MAX_AVATAR_PX) is dropped by the parser: the
 * avatar is cosmetic, never a reason to refuse the bar — and never something to decode blindly.
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
        /** Largest picture side the bar decodes (JS sends 96px). A few KB of PNG can declare a canvas of gigabytes. */
        const val MAX_AVATAR_PX = 512
        private val BASE64 = Regex("^[A-Za-z0-9+/]+={0,2}$")
        private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

        /** [raw] when it is a base64 PNG whose declared size is 1..MAX_AVATAR_PX on both sides, else "". */
        internal fun usablePng(raw: String): String {
            if (raw.length < 32 || raw.length > MAX_AVATAR_CHARS || !BASE64.matches(raw)) return ""
            // Width and height live in the IHDR chunk, which is always first: bytes 16..23 = inside the first 32 characters.
            val head = try { java.util.Base64.getDecoder().decode(raw.substring(0, 32)) } catch (_: IllegalArgumentException) { return "" }
            if (head.size < 24 || !head.copyOfRange(0, 8).contentEquals(PNG_SIGNATURE)) return ""
            if (String(head, 12, 4, Charsets.US_ASCII) != "IHDR") return ""
            fun int(at: Int) = (0 until 4).fold(0L) { acc, i -> (acc shl 8) or (head[at + i].toLong() and 0xFF) }
            return if (int(16) in 1..MAX_AVATAR_PX && int(20) in 1..MAX_AVATAR_PX) raw else ""
        }

        private fun account(json: JSONObject): ChromeAccount? {
            val o = json.optJSONObject("account") ?: return null
            return ChromeAccount(
                NativeJson.str(o, "label", 128), o.optJSONObject("icon")?.let(NativeJson::icon),
                usablePng(o.opt("png") as? String ?: ""),
            )
        }

        /** Cosmetic, like the avatar: an unknown kind (a newer page) draws no dot instead of refusing the whole bar. */
        private fun badge(space: JSONObject): ChromeBadge? {
            val o = space.optJSONObject("badge") ?: return null
            val kind = when (o.opt("kind")) {
                "running" -> ChromeBadge.Kind.RUNNING
                "attention" -> ChromeBadge.Kind.ATTENTION
                "unread" -> ChromeBadge.Kind.UNREAD
                else -> return null
            }
            return ChromeBadge(kind, NativeJson.optStr(o, "label", 128))
        }

        private fun spaces(json: JSONObject): List<ChromeSpace> {
            val array = json.optJSONArray("spaces") ?: return emptyList()
            require(array.length() <= MAX_SPACES) { "Too many spaces" }
            return (0 until array.length()).map { i ->
                val o = array.getJSONObject(i)
                ChromeSpace(
                    NativeJson.str(o, "id", 128), NativeJson.str(o, "label", 128), NativeJson.optBool(o, "active"),
                    o.optJSONObject("icon")?.let(NativeJson::icon), badge(o), usablePng(o.opt("png") as? String ?: ""),
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
