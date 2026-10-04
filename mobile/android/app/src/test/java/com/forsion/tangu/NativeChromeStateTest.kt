package com.forsion.tangu

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeChromeStateTest {
    private val theme = """{"dark":false,"background":"#FFF8F7F6","surface":"#FFFFFFFF","text":"#FF202124","muted":"#FF6E7076","border":"#1A000000","accent":"#FF4D8794","onAccent":"#FFFFFFFF","danger":"#FFD04040"}"""
    private val icon = """{"kind":"vector","viewBox":[0,0,24,24],"strokeWidth":2,"paths":[{"d":"M18 6 6 18","fill":false,"stroke":true}]}"""
    private fun shell(spaces: String?) = JSONObject("""{
      "mode":"shell","title":"Chat","left":true,"right":false,"tabCount":2,
      "labels":{"left":"Left","right":"Right","tabs":"Tabs","more":"More"},"theme":$theme
      ${if (spaces != null) ""","spaces":$spaces""" else ""}
    }""")

    @Test fun shellCarriesSpacesForTheBottomBar() {
        val s = ChromeState.parse(shell("""[{"id":"home","label":"Home","active":false,"icon":$icon},{"id":"tangu","label":"Tangu","active":true}]"""))
        assertTrue(s.spaceBar)
        assertEquals(listOf("home", "tangu"), s.spaces.map { it.id })
        assertTrue(s.spaces[1].active)
        assertTrue(s.spaces[0].icon is NativeIconSpec.Vector)
    }

    @Test fun noBarWithoutAChoiceOrOutsideTheShell() {
        assertFalse(ChromeState.parse(shell(null)).spaceBar)
        assertFalse(ChromeState.parse(shell("""[{"id":"only","label":"Only","active":true}]""")).spaceBar)
        val page = ChromeState.parse(JSONObject("""{"mode":"page","title":"Settings","back":"Back","theme":$theme,"spaces":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}"""))
        assertFalse(page.spaceBar)
    }

    @Test fun accountAvatarIsOptionalAndValidated() {
        assertEquals(null, ChromeState.parse(shell(null)).account)
        fun withAccount(account: String) = shell(null).put("account", JSONObject(account))
        val letter = ChromeState.parse(withAccount("""{"label":"Ada","icon":{"kind":"text","text":"A"}}""")).account!!
        assertEquals("Ada", letter.label)
        assertTrue(letter.icon is NativeIconSpec.Text)
        assertEquals("", letter.png)
        assertEquals("iVBORw0KGgo=", ChromeState.parse(withAccount("""{"label":"Ada","png":"iVBORw0KGgo="}""")).account!!.png)
        assertTrue("account" in ChromeState.ACTIONS)
        // not base64 / oversized: the whole state is refused (JS then falls back to its web bar)
        assertThrows(IllegalArgumentException::class.java) { ChromeState.parse(withAccount("""{"label":"Ada","png":"data:image/png;base64,AAAA"}""")) }
        assertThrows(IllegalArgumentException::class.java) {
            ChromeState.parse(withAccount("""{"label":"Ada","png":"${"A".repeat(ChromeState.MAX_AVATAR_CHARS + 4)}"}"""))
        }
        // the avatar belongs to the shell: a page has none
        val page = JSONObject("""{"mode":"page","title":"Settings","back":"Back","theme":$theme}""").put("account", JSONObject("""{"label":"Ada"}"""))
        assertEquals(null, ChromeState.parse(page).account)
    }

    @Test fun rejectsDuplicateAndOversizedSpaceLists() {
        assertThrows(IllegalArgumentException::class.java) {
            ChromeState.parse(shell("""[{"id":"a","label":"A"},{"id":"a","label":"B"}]"""))
        }
        val many = (0..ChromeState.MAX_SPACES).joinToString(",", "[", "]") { """{"id":"s$it","label":"S"}""" }
        assertThrows(IllegalArgumentException::class.java) { ChromeState.parse(shell(many)) }
    }
}
