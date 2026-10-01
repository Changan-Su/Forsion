package com.forsion.tangu

import org.json.JSONObject

/** JSON-only boundary: no executable callbacks, credentials or URLs cross the picker bridge. */
internal data class PickerChoice(val value: String, val label: String, val detail: String, val badge: String)
internal data class PickerSection(val label: String, val options: List<PickerChoice>)
internal data class PickerField(val id: String, val label: String, val value: String, val groups: List<PickerSection>) {
    fun labelFor(value: String): String = groups.flatMap { it.options }.find { it.value == value }?.label ?: value
}
internal data class ModelPickerPayload(
    val requestId: String, val title: String, val fields: List<PickerField>,
    val labels: Map<String, String>, val dark: Boolean, val accent: String, val footnote: String,
) {
    fun initialValues() = fields.associate { it.id to it.value }
    fun validValues(values: Map<String, String>): Boolean = values.keys == fields.map { it.id }.toSet() && fields.all { f ->
        values[f.id] == f.value || f.groups.any { g -> g.options.any { it.value == values[f.id] } }
    }
    companion object {
        fun parse(json: JSONObject): ModelPickerPayload {
            require(json.toString().length <= 512_000) { "Picker payload too large" }
            fun str(obj: JSONObject, key: String, limit: Int = 256): String {
                val value = obj.get(key)
                require(value is String && value.length <= limit) { "Invalid $key" }
                return value
            }
            val id = str(json, "requestId", 80)
            require(id.isNotBlank()) { "Missing request identity" }
            val array = json.getJSONArray("fields")
            require(array.length() in 1..8) { "Invalid field count" }
            var total = 0
            val fields = (0 until array.length()).map { i ->
                val f = array.getJSONObject(i)
                val groups = f.getJSONArray("groups")
                require(groups.length() <= 100)
                PickerField(str(f, "id"), str(f, "label"), str(f, "value"), (0 until groups.length()).map { j ->
                    val g = groups.getJSONObject(j)
                    val options = g.getJSONArray("options")
                    total += options.length()
                    require(total <= 2000) { "Too many choices" }
                    PickerSection(str(g, "label"), (0 until options.length()).map { k ->
                        val o = options.getJSONObject(k)
                        PickerChoice(str(o, "value"), str(o, "label"), if (o.has("detail")) str(o, "detail", 2048) else "", if (o.has("badge")) str(o, "badge") else "")
                    })
                }).also { field ->
                    val values = field.groups.flatMap { it.options }.map { it.value }
                    require(values.distinct().size == values.size) { "Duplicate option" }
                }
            }
            require(fields.first().id == "model" && fields.map { it.id }.distinct().size == fields.size) { "Invalid field identities" }
            val labels = json.getJSONObject("labels")
            val theme = json.getJSONObject("theme")
            return ModelPickerPayload(id, str(json, "title"), fields,
                listOf("done", "search", "empty", "back", "advanced").associateWith { str(labels, it) },
                theme.getBoolean("dark"), str(theme, "accent"), if (json.has("footnote")) str(json, "footnote", 4096) else "")
        }
    }
}
