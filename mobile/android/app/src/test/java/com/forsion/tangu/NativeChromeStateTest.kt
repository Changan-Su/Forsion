package com.forsion.tangu

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    /** Minimal PNG head (signature + IHDR declaring [w]×[h]) padded with [extra] bytes, as base64. */
    private fun png(w: Int, h: Int, extra: Int = 40): String {
        val b = java.io.ByteArrayOutputStream()
        b.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13))
        b.write("IHDR".toByteArray())
        for (v in listOf(w, h)) b.write(byteArrayOf((v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte()))
        b.write(ByteArray(extra))
        return java.util.Base64.getEncoder().encodeToString(b.toByteArray())
    }

    @Test fun accountAvatarIsOptionalAndItsPictureIsCheckedBeforeAnyDecode() {
        assertEquals(null, ChromeState.parse(shell(null)).account)
        fun withAccount(account: String) = shell(null).put("account", JSONObject(account))
        val letter = ChromeState.parse(withAccount("""{"label":"Ada","icon":{"kind":"text","text":"A"}}""")).account!!
        assertEquals("Ada", letter.label)
        assertTrue(letter.icon is NativeIconSpec.Text)
        assertEquals("", letter.png)
        assertTrue("account" in ChromeState.ACTIONS)
        // a real PNG (the emulator harness fixture: 8×8) and the size JS sends (96×96) are kept as they are
        val real = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4z/AfK2IYWhIA0ad/gQofP30AAAAASUVORK5CYII="
        assertEquals(real, ChromeState.parse(withAccount("""{"label":"Ada","png":"$real"}""")).account!!.png)
        assertEquals(png(96, 96), ChromeState.usablePng(png(96, 96)))
        assertEquals(png(512, 512), ChromeState.usablePng(png(512, 512)))
        // unusable pictures are dropped — the bar still renders (with the initial): the avatar is cosmetic
        val dropped = listOf(
            png(513, 96), png(96, 16384), png(16384, 16384), // a few KB can declare gigabytes of pixels
            png(0, 96), png(-1, 96),
            "data:image/png;base64,AAAA", "iVBORw0KGgo=", // not base64 / too short to hold a header
            java.util.Base64.getEncoder().encodeToString(ByteArray(64) { 0x41 }), // base64, not a PNG
            "A".repeat(ChromeState.MAX_AVATAR_CHARS + 4),
        )
        for (bad in dropped) assertEquals("kept: ${bad.take(40)}", "", ChromeState.usablePng(bad))
        val state = ChromeState.parse(withAccount("""{"label":"Ada","icon":{"kind":"text","text":"A"},"png":"${png(16384, 16384)}"}"""))
        assertEquals("", state.account!!.png)
        assertTrue(state.account!!.icon is NativeIconSpec.Text)
        assertEquals("", ChromeState.parse(withAccount("""{"label":"Ada","png":42}""")).account!!.png)
        // the label stays strict, like every other string of the bar
        assertThrows(IllegalArgumentException::class.java) { ChromeState.parse(withAccount("""{"label":"${"x".repeat(129)}"}""")) }
        // the avatar belongs to the shell: a page has none
        val page = JSONObject("""{"mode":"page","title":"Settings","back":"Back","theme":$theme}""").put("account", JSONObject("""{"label":"Ada"}"""))
        assertEquals(null, ChromeState.parse(page).account)
    }

    @Test fun spaceBadgeIsOptionalAndAnUnknownKindDrawsNothing() {
        val s = ChromeState.parse(shell("""[
          {"id":"home","label":"Home"},
          {"id":"tangu","label":"Tangu","active":true,"badge":{"kind":"attention","label":"Waiting for you"}},
          {"id":"inbox","label":"Inbox","badge":{"kind":"unread","label":"Unread"}},
          {"id":"run","label":"Run","badge":{"kind":"running"}},
          {"id":"later","label":"Later","badge":{"kind":"sparkles","label":"New"}},
          {"id":"odd","label":"Odd","badge":"unread"}
        ]"""))
        assertNull(s.spaces[0].badge)
        assertEquals(ChromeBadge(ChromeBadge.Kind.ATTENTION, "Waiting for you"), s.spaces[1].badge)
        assertEquals(ChromeBadge.Kind.UNREAD, s.spaces[2].badge?.kind)
        assertEquals(ChromeBadge(ChromeBadge.Kind.RUNNING, ""), s.spaces[3].badge) // no label = a silent dot, still drawn
        assertNull(s.spaces[4].badge) // a kind this build does not know: no dot, the bar itself still renders
        assertNull(s.spaces[5].badge) // not an object
        assertEquals(6, s.spaces.size)
    }

    @Test fun warningColourFallsBackToDangerWhenThePageDoesNotSendOne() {
        val plain = ChromeState.parse(shell(null))
        assertEquals(plain.theme.danger, plain.theme.warning)
        val themed = ChromeState.parse(shell(null).put("theme", JSONObject(theme).put("warning", "#FF806000")))
        assertEquals(0xFF806000.toInt(), themed.theme.warning)
    }

    @Test fun rejectsDuplicateAndOversizedSpaceLists() {
        assertThrows(IllegalArgumentException::class.java) {
            ChromeState.parse(shell("""[{"id":"a","label":"A"},{"id":"a","label":"B"}]"""))
        }
        val many = (0..ChromeState.MAX_SPACES).joinToString(",", "[", "]") { """{"id":"s$it","label":"S"}""" }
        assertThrows(IllegalArgumentException::class.java) { ChromeState.parse(shell(many)) }
    }
}
