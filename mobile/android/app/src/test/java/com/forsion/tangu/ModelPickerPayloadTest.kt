package com.forsion.tangu

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ModelPickerPayloadTest {
    private fun fixture() = JSONObject("""{
      "requestId":"test-1","title":"Models","labels":{"done":"Done","search":"Search","empty":"Empty","back":"Back","advanced":"Advanced"},
      "theme":{"dark":false,"accent":"#4d8794"},
      "fields":[{"id":"model","label":"Model","value":"a","groups":[{"label":"Provider","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}]}]
    }""")
    @Test fun validatesSelectionsAgainstCallerCatalog() {
        val p = ModelPickerPayload.parse(fixture())
        assertEquals(mapOf("model" to "a"), p.initialValues())
        assertTrue(p.validValues(mapOf("model" to "b")))
        assertFalse(p.validValues(mapOf("model" to "c")))
        assertFalse(p.validValues(mapOf("model" to "b", "injected" to "x")))
        assertFalse(p.validValues(emptyMap()))
    }
    @Test fun preservesUnavailableCurrentModel() {
        val json = fixture()
        json.getJSONArray("fields").getJSONObject(0).put("value", "retired")
        val p = ModelPickerPayload.parse(json)
        assertTrue(p.validValues(mapOf("model" to "retired")))
    }
    @Test fun rejectsDuplicateFieldAndOptionIds() {
        val fields = fixture()
        val array = fields.getJSONArray("fields")
        array.put(array.getJSONObject(0))
        assertThrows(IllegalArgumentException::class.java) { ModelPickerPayload.parse(fields) }
        val options = fixture()
        val choices = options.getJSONArray("fields").getJSONObject(0).getJSONArray("groups").getJSONObject(0).getJSONArray("options")
        choices.put(choices.getJSONObject(0))
        assertThrows(IllegalArgumentException::class.java) { ModelPickerPayload.parse(options) }
    }
    @Test fun rejectsExecutableOrOversizedValues() {
        val invalid = fixture().put("requestId", JSONObject())
        assertThrows(IllegalArgumentException::class.java) { ModelPickerPayload.parse(invalid) }
        assertThrows(IllegalArgumentException::class.java) { ModelPickerPayload.parse(fixture().put("title", "a".repeat(513000))) }
    }
}
