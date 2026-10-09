package com.forsion.tangu

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSheetPayloadTest {
    private val theme = """{"dark":false,"background":"#FFF8F7F6","surface":"#FFFFFFFF","text":"#FF202124","muted":"#FF6E7076","border":"#1A000000","accent":"#FF4D8794","onAccent":"#FFFFFFFF","danger":"#FFD04040"}"""
    private val icon = """{"kind":"vector","viewBox":[0,0,24,24],"strokeWidth":2,"paths":[{"d":"M18 6 6 18","fill":false,"stroke":true}]}"""
    private fun menu() = JSONObject("""{
      "requestId":"r1","kind":"menu","title":"Tabs","back":"Back","theme":$theme,
      "search":{"placeholder":"Search","empty":"Nothing"},
      "sections":[{"items":[
        {"id":"tab:a","label":"A","checked":true,"icon":$icon,"trailing":{"id":"close","label":"Close","icon":$icon}},
        {"id":"off","label":"Off","disabled":true},
        {"id":"group","label":"Group","children":[{"items":[{"id":"nested","label":"Nested","icon":{"kind":"text","text":"📝"}}]}]}
      ]},{"title":"More","items":[{"id":"new","label":"New tab","danger":true}]}]
    }""")

    @Test fun parsesMenuThemeAndIcons() {
        val p = SheetPayload.parse(menu()) as SheetPayload.Menu
        assertEquals("Tabs", p.title)
        assertEquals(0xFFF8F7F6.toInt(), p.theme.background)
        assertEquals(0x1A000000, p.theme.border)
        val first = p.sections[0].items[0]
        assertTrue(first.checked)
        assertTrue(first.icon is NativeIconSpec.Vector)
        assertEquals("close", first.trailing?.id)
        assertEquals(NativeIconSpec.Text("📝"), p.find("nested")?.icon)
        assertEquals("Nothing", p.search?.empty)
    }

    @Test fun acceptsOnlyLegalAnswers() {
        val p = SheetPayload.parse(menu())
        assertTrue(p.accepts(SheetAnswer.Pick("tab:a", false)))
        assertTrue(p.accepts(SheetAnswer.Pick("tab:a", true)))
        assertTrue(p.accepts(SheetAnswer.Pick("nested", false)))
        assertFalse(p.accepts(SheetAnswer.Pick("off", false))) // disabled
        assertFalse(p.accepts(SheetAnswer.Pick("group", false))) // only opens a page
        assertFalse(p.accepts(SheetAnswer.Pick("new", true))) // no trailing action declared
        assertFalse(p.accepts(SheetAnswer.Pick("injected", false)))
        assertFalse(p.accepts(SheetAnswer.Text("x")))
    }

    @Test fun rejectsDuplicateIdsAcrossPages() {
        val json = menu()
        json.getJSONArray("sections").getJSONObject(1).getJSONArray("items").put(JSONObject("""{"id":"nested","label":"Dup"}"""))
        assertThrows(IllegalArgumentException::class.java) { SheetPayload.parse(json) }
    }

    @Test fun rejectsMalformedValues() {
        for (mutate in listOf<(JSONObject) -> Unit>(
            { it.put("requestId", JSONObject()) },
            { it.put("kind", "html") },
            { it.getJSONObject("theme").put("accent", "red") },
            { it.getJSONObject("theme").put("accent", "#4d8794") }, // CSS order is not accepted: must be #AARRGGBB
            { it.put("title", "a".repeat(513_000)) },
            { it.put("sections", JSONArray()) },
            { it.getJSONArray("sections").getJSONObject(0).getJSONArray("items").getJSONObject(0).put("checked", "yes") },
            { it.getJSONArray("sections").getJSONObject(0).getJSONArray("items").getJSONObject(0).put("icon", JSONObject("""{"kind":"vector","viewBox":[0,0,24,24],"strokeWidth":2,"paths":[{"d":"javascript:alert(1)"}]}""")) },
            { it.getJSONArray("sections").getJSONObject(0).getJSONArray("items").getJSONObject(0).put("icon", JSONObject("""{"kind":"text","text":"${"x".repeat(40)}"}""")) },
        )) {
            val json = menu()
            mutate(json)
            assertThrows(IllegalArgumentException::class.java) { SheetPayload.parse(json) }
        }
    }

    @Test fun capsItemCountAndDepth() {
        val many = JSONArray()
        repeat(SheetPayload.MAX_ITEMS + 1) { many.put(JSONObject().put("id", "i$it").put("label", "x")) }
        val big = menu().put("sections", JSONArray().put(JSONObject().put("items", many)))
        assertThrows(IllegalArgumentException::class.java) { SheetPayload.parse(big) }
        var nested = JSONObject().put("id", "leaf").put("label", "leaf")
        repeat(SheetPayload.MAX_DEPTH + 1) { d ->
            nested = JSONObject().put("id", "n$d").put("label", "n").put("children", JSONArray().put(JSONObject().put("items", JSONArray().put(nested))))
        }
        val deep = menu().put("sections", JSONArray().put(JSONObject().put("items", JSONArray().put(nested))))
        assertThrows(IllegalArgumentException::class.java) { SheetPayload.parse(deep) }
    }

    @Test fun promptAndConfirm() {
        val prompt = SheetPayload.parse(JSONObject("""{"requestId":"p","kind":"prompt","title":"New folder","initial":"Folder","confirm":"OK","cancel":"Cancel","theme":$theme}""")) as SheetPayload.Prompt
        assertEquals("Folder", prompt.initial)
        assertEquals("", prompt.label)
        assertTrue(prompt.accepts(SheetAnswer.Text("x")))
        assertFalse(prompt.accepts(SheetAnswer.Ok))
        val confirm = SheetPayload.parse(JSONObject("""{"requestId":"c","kind":"confirm","title":"Delete?","confirm":"Delete","cancel":"Cancel","danger":true,"theme":$theme}""")) as SheetPayload.Confirm
        assertTrue(confirm.danger)
        assertTrue(confirm.accepts(SheetAnswer.Ok))
        assertFalse(confirm.accepts(SheetAnswer.Pick("x", false)))
        assertThrows(IllegalArgumentException::class.java) {
            SheetPayload.parse(JSONObject("""{"requestId":"p","kind":"prompt","title":"t","confirm":"OK","theme":$theme}""").put("cancel", 3))
        }
    }

    @Test fun sectionMayBeAGridOfTiles() {
        val json = menu()
        json.getJSONArray("sections").getJSONObject(0).put("grid", true)
        val p = SheetPayload.parse(json) as SheetPayload.Menu
        assertTrue(p.sections[0].grid)
        assertFalse(p.sections[1].grid)
        json.getJSONArray("sections").getJSONObject(0).put("grid", "yes")
        assertThrows(IllegalArgumentException::class.java) { SheetPayload.parse(json) }
    }

    @Test fun nestedPageSearchOnlyWithChildren() {
        val json = menu()
        val items = json.getJSONArray("sections").getJSONObject(0).getJSONArray("items")
        items.getJSONObject(2).put("search", JSONObject("""{"placeholder":"Find","empty":"None"}"""))
        items.getJSONObject(1).put("search", JSONObject("""{"placeholder":"Ignored","empty":"Ignored"}""")) // leaf: no page to search
        json.getJSONArray("sections").getJSONObject(1).put("footer", "Files created later are kept.")
        val p = SheetPayload.parse(json) as SheetPayload.Menu
        assertEquals("Find", p.find("group")?.search?.placeholder)
        assertNull(p.find("off")?.search)
        assertEquals("Files created later are kept.", p.sections[1].footer)
        assertEquals("", p.sections[0].footer)
        items.getJSONObject(2).put("search", JSONObject("""{"placeholder":3,"empty":"None"}"""))
        assertThrows(IllegalArgumentException::class.java) { SheetPayload.parse(json) }
    }

    @Test fun chromePageClose() {
        val page = ChromeState.parse(JSONObject("""{"mode":"page","title":"Models","back":"Settings","close":"Back to app","theme":$theme,"icons":{"close":$icon}}"""))
        assertEquals("Back to app", page.close)
        assertTrue(page.icons.close is NativeIconSpec.Vector)
        assertTrue("close" in ChromeState.ACTIONS)
        assertEquals("", ChromeState.parse(JSONObject("""{"mode":"page","title":"Settings","back":"Back","theme":$theme}""")).close)
        assertThrows(Exception::class.java) { ChromeState.parse(JSONObject("""{"mode":"page","title":"x","back":"b","close":7,"theme":$theme}""")) }
    }

    @Test fun chromeStateModes() {
        val shell = ChromeState.parse(JSONObject("""{"mode":"shell","title":"Home","left":true,"right":false,"tabCount":3,
            "labels":{"left":"Left panel","right":"Right panel","tabs":"Tabs","more":"More"},"theme":$theme,"icons":{"left":$icon}}"""))
        assertEquals(ChromeState.Mode.SHELL, shell.mode)
        assertTrue(shell.left)
        assertEquals(3, shell.tabCount)
        assertTrue(shell.icons.left is NativeIconSpec.Vector)
        assertNull(shell.icons.more)
        val page = ChromeState.parse(JSONObject("""{"mode":"page","title":"Settings","back":"Back","theme":$theme}"""))
        assertEquals("Back", page.back)
        assertFalse(ChromeState.parse(JSONObject("""{"mode":"hidden","theme":$theme}""")).visible)
        assertThrows(Exception::class.java) { ChromeState.parse(JSONObject("""{"mode":"shell","title":"x","theme":$theme,"tabCount":1,"labels":{"left":"a"}}""")) }
        assertThrows(Exception::class.java) { ChromeState.parse(JSONObject("""{"mode":"overlay","theme":$theme}""")) }
    }

    @Test fun promptInputIsClampedToWhatConfirmAccepts() {
        val max = SheetPayload.MAX_PROMPT_TEXT
        val prompt = SheetPayload.parse(JSONObject("""{"requestId":"p1","kind":"prompt","title":"Name","confirm":"OK","cancel":"Cancel","theme":$theme}"""))
        assertEquals("short", SheetPayload.clampPromptText("short"))
        val exact = "a".repeat(max)
        assertEquals(exact, SheetPayload.clampPromptText(exact))
        val clamped = SheetPayload.clampPromptText("a".repeat(max + 5_000))
        assertEquals(max, clamped.length)
        assertTrue(prompt.accepts(SheetAnswer.Text(clamped)))
        assertFalse(prompt.accepts(SheetAnswer.Text("a".repeat(max + 1)))) // why the field must clamp
        // Never cut a surrogate pair in half: the emoji straddling the limit is dropped whole.
        val straddling = SheetPayload.clampPromptText("a".repeat(max - 1) + "😀" + "tail")
        assertEquals(max - 1, straddling.length)
        assertFalse(Character.isHighSurrogate(straddling.last()))
        assertTrue(prompt.accepts(SheetAnswer.Text(straddling)))
    }
}
